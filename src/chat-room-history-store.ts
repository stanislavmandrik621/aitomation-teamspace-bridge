/**
 * Per-room chat history: chat/rooms/<safeRoomId>/messages.jsonl + search index.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  appendFileSync,
  createReadStream,
  readFileSync,
  statSync,
  writeFileSync,
  renameSync,
  copyFileSync,
  readdirSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
} from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { BridgeRole } from './index.js'
import {
  type AtRestKey,
  decryptOpsLine,
  encryptOpsLine,
} from './at-rest.js'
import {
  CHAT_BODY_MAX,
  capChatText,
  CHAT_HISTORY_LIMIT_MAX,
  CHAT_MSG_ID_MAX,
  CHAT_ROOM_TEAM,
  CHAT_TOMBSTONE_DAYS_DEFAULT,
  CHAT_EDIT_MS,
  CHAT_UNSEND_MS,
  parseChatRoomId,
  scrubChatBody,
} from './chat-room.js'
import { chatRoomDir, safeChatRoomDirName } from './chat-room-path.js'
import {
  addChatRoomPin,
  buildChatRoomPinMeta,
  newestChatRoomPin,
  normalizeChatPinId,
  pruneChatRoomPins,
  readChatRoomPinIds,
  removeChatRoomPin,
} from './chat-room-pins.js'
import {
  chatQuotaRefusal,
  invalidateChatFilesBytesCache,
  measureChatFilesBytes,
  resolveChatDiskQuotas,
} from './chat-disk-quota.js'
import { bumpChatMetric } from './chat-metrics.js'

export type ChatReactionMap = Record<string, string[]>

/**
 * Result of a pin or unpin write.
 *
 * `pinnedIds` is the room's whole list after the write (pin order, oldest
 * first); `pinnedId` is its last entry, kept so callers that only show one
 * pinned message do not have to reach into the list themselves.
 */
export type ChatPinWriteResult =
  | { ok: true; pinnedId: string | null; pinnedIds: string[]; unchanged?: boolean }
  | { error: string }

export type ChatAttachmentMeta = {
  blobId: string
  name?: string
  bytes?: number
  mime?: string
  /**
   * TCC-R1143-MEDIA-007: optional client-stamped voice duration in seconds.
   * Bridge never decodes audio; peers show this until/unless the player
   * reports a real duration from the blob.
   */
  durationSec?: number
}

export type ChatMessageRow = {
  id: string
  room: string
  body: string
  memberId: string
  memberName: string
  role: BridgeRole
  createdAt: number
  deletedAt?: number | null
  deletedBy?: string | null
  kind?: 'user' | 'system'
  replyToId?: string | null
  editedAt?: number | null
  lastReactAt?: number | null
  reactions?: ChatReactionMap
  pinned?: boolean
  attachments?: ChatAttachmentMeta[]
  clientMsgId?: string | null
}

type OffsetEntry = { id: string; offset: number; createdAt: number }
type SearchIndex = {
  version: 1
  offsets: OffsetEntry[]
  /** lowercase term -> message ids (cap terms). */
  terms: Record<string, string[]>
}

const LEGACY_CHAT_FILE = 'chat.jsonl'
/**
 * TCC-R1126-CHAT-001: this is a TAIL window, not a head cap - `scanRoomFile`
 * streams the whole file (readline already handles multi-byte UTF-8 line
 * boundaries for us) but only keeps the LAST `MAX_TAIL_LINES_SCAN` raw lines
 * for id/dedup processing. Scanning from the head and stopping at the cap
 * used to silently drop the newest messages/edits/reactions in any room
 * whose jsonl exceeded the cap - keeping the tail instead guarantees recent
 * activity is always visible regardless of total file size.
 */
const MAX_TAIL_LINES_SCAN = 50_000
const MAX_SEARCH_TERMS = 20_000
const MAX_TERMS_PER_MESSAGE = 40
const INDEX_OFFSET_CAP = 100_000
/**
 * TCC-R1125-CHAT-001: bound for the cross-room disk fallback scan when
 * `findById` misses the in-memory cache and has no (or a wrong) room hint.
 * Team Space rooms are bounded by team size (DM/group/private rooms per
 * team), not by message volume, so this is generous in practice while still
 * protecting the bridge from an unbounded directory walk.
 */
const MAX_ROOMS_SCAN_FOR_FIND_BY_ID = 2_000
/** Hard ceiling on a single offset-based read chunk (protects against a corrupt/huge offset). */
const READ_OFFSET_CHUNK_BYTES_MAX = 1_048_576
/**
 * TCC-R1133-CHAT-002: `search-index.json` used to be a full load+rewrite on
 * every single message write (send/edit/react/pin/delete) - the hot path
 * for a private team server under concurrent senders. Keep a per-room
 * in-memory copy (loaded from disk once, mutated in memory) and coalesce
 * disk writes with a short debounce so a burst of writes to the same room
 * costs one disk write, not one per message. The index is a rebuildable
 * search accelerator, not the source of truth (messages.jsonl is written
 * synchronously as before) - losing the last few hundred ms of index
 * updates on a hard crash only means a few messages are unsearchable until
 * the next successful write to that room re-saves the whole index.
 */
const INDEX_FLUSH_DEBOUNCE_MS = 400
/** Bound the number of rooms held in the in-memory index cache. */
const INDEX_CACHE_MAX_ROOMS = 200

type IndexCacheEntry = {
  index: SearchIndex
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
}

function mintChatId(): string {
  return `c_${randomBytes(12).toString('base64url')}`
}

function tokenizeForSearch(body: string): string[] {
  const lower = body.toLowerCase()
  const parts = lower.split(/[^a-z0-9_]+/i).filter((w) => w.length >= 2)
  return [...new Set(parts)].slice(0, MAX_TERMS_PER_MESSAGE)
}

function messagesPath(roomDir: string): string {
  return join(roomDir, 'messages.jsonl')
}

function indexPath(roomDir: string): string {
  return join(roomDir, 'search-index.json')
}

function metaPath(roomDir: string): string {
  return join(roomDir, 'room-meta.json')
}

export class ChatRoomHistoryStore {
  private readonly chatRoot: string
  private readonly legacyPath: string
  private readonly legacyAltPath: string
  /** room safe dir -> write chain */
  private roomQueues = new Map<string, Promise<void>>()
  private recentById = new Map<string, ChatMessageRow>()
  private migrationDone = false
  /** room dir -> in-memory search index cache (TCC-R1133-CHAT-002 debounced flush). */
  private indexCache = new Map<string, IndexCacheEntry>()
  /**
   * TCC-R1134-CHAT-023: room dirs whose `messages.jsonl` tail has already
   * been checked/repaired for a torn-write boundary this process lifetime -
   * bounded so a very large number of distinct rooms cannot grow this
   * unboundedly (see `repairTornMessagesTail` for why the check is needed).
   */
  private tailCheckedRoomDirs = new Set<string>()
  private static readonly TAIL_CHECKED_CAP = 5000

  constructor(
    private dataDir: string,
    private retentionDays: number,
    private tombstoneDays: number,
    private atRest: AtRestKey | null,
  ) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    this.chatRoot = join(dataDir, 'chat')
    if (!existsSync(this.chatRoot)) mkdirSync(this.chatRoot, { recursive: true })
    this.legacyPath = join(dataDir, LEGACY_CHAT_FILE)
    this.legacyAltPath = join(this.chatRoot, LEGACY_CHAT_FILE)
    const days = Number(retentionDays)
    this.retentionDays =
      Number.isFinite(days) && days >= 0
        ? days === 0
          ? 0
          : Math.min(3650, Math.floor(days))
        : 90
    const tomb = Number(tombstoneDays)
    this.tombstoneDays =
      Number.isFinite(tomb) && tomb >= 0
        ? tomb === 0
          ? 0
          : Math.min(3650, Math.floor(tomb))
        : CHAT_TOMBSTONE_DAYS_DEFAULT
    this.runMigrationIfNeeded()
  }

  private remember(row: ChatMessageRow): void {
    this.recentById.set(row.id, row)
    if (this.recentById.size > 5000) {
      const first = this.recentById.keys().next().value
      if (typeof first === 'string') this.recentById.delete(first)
    }
  }

  /** Cache-only lookup (no disk fallback) - used only for soft/best-effort checks. */
  private findByIdCached(id: string): ChatMessageRow | null {
    const key = String(id || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    if (!key) return null
    return this.recentById.get(key) ?? null
  }

  /**
   * TCC-R1125-CHAT-001: `recentById` is a bounded 5000-entry LRU, so on a
   * busy/keep-forever room, edit/react/pin/unsend on any row that aged out
   * of the cache used to fail "Message not found" even though the line
   * still exists on disk. Fall back to a bounded disk lookup on cache miss:
   * try the caller-supplied `roomHint` first (desktop already sends the
   * owning room on edit/react/unsend frames), then a capped cross-room scan
   * as a last resort. Every row found this way is remembered so repeat
   * lookups for the same id are cache hits again.
   */
  async findById(id: string, roomHint?: string): Promise<ChatMessageRow | null> {
    const key = String(id || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    if (!key) return null
    const hint =
      typeof roomHint === 'string' ? roomHint.replace(/\0/g, '').trim().slice(0, 160) : ''
    const cached = this.recentById.get(key)
    // TCC-R1154-CHAT-008 / TCC-R1153-CHAT-008: when a room hint is supplied,
    // refuse a cache hit from a different room (global-id false positive).
    if (cached && (!hint || cached.room === hint)) return cached
    const found = await this.findByIdDiskFallback(key, hint || undefined)
    if (found) {
      bumpChatMetric('findByIdDiskHits')
      this.remember(found)
    }
    return found
  }

  /** Read a single JSONL line at a known byte offset without loading the whole file. */
  private readRowAtOffset(path: string, offset: number): ChatMessageRow | null {
    if (!Number.isFinite(offset) || offset < 0) return null
    let fd: number | null = null
    try {
      fd = openSync(path, 'r')
      const stat = fstatSync(fd)
      if (offset >= stat.size) return null
      const chunkSize = Math.min(READ_OFFSET_CHUNK_BYTES_MAX, stat.size - offset)
      const buf = Buffer.alloc(chunkSize)
      const bytesRead = readSync(fd, buf, 0, chunkSize, offset)
      const chunk = buf.subarray(0, bytesRead)
      const nl = chunk.indexOf(0x0a)
      if (nl < 0 && bytesRead >= READ_OFFSET_CHUNK_BYTES_MAX) {
        // Line longer than our chunk ceiling (or a corrupt/stale offset that
        // landed mid-line with no terminator in range) - refuse rather than
        // guess; caller falls back to a full scoped scan.
        return null
      }
      const lineBuf = nl >= 0 ? chunk.subarray(0, nl) : chunk
      const line = lineBuf.toString('utf8')
      if (!line.trim()) return null
      const plain = decryptOpsLine(this.atRest, line)
      const row = JSON.parse(plain) as ChatMessageRow
      if (!row || typeof row.id !== 'string') return null
      return row
    } catch {
      return null
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* fd already invalid/closed */
        }
      }
    }
  }

  /** Fast path: look up `id` via the room's search-index offsets (newest entry first). */
  private findByOffsetInDir(roomDir: string, id: string): ChatMessageRow | null {
    const path = messagesPath(roomDir)
    if (!existsSync(path)) return null
    const index = this.getIndexEntry(roomDir).index
    for (let i = index.offsets.length - 1; i >= 0; i--) {
      const off = index.offsets[i]
      if (!off || off.id !== id) continue
      const row = this.readRowAtOffset(path, off.offset)
      if (row && row.id === id) return row
      // Stale/mismatched offset (e.g. index not yet flushed past a prune
      // rewrite) - fall through to a full scoped scan below rather than
      // trusting a possibly-wrong byte position.
      break
    }
    return null
  }

  /** Scoped scan of one room's messages.jsonl for a specific id (tail-windowed, like scanRoomFile). */
  private async scanRoomFileForId(
    path: string,
    id: string,
    room?: string,
  ): Promise<ChatMessageRow | null> {
    const window: string[] = []
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
    for await (const line of rl) {
      if (!line.trim()) continue
      window.push(line)
      if (window.length > MAX_TAIL_LINES_SCAN) window.shift()
    }
    let found: ChatMessageRow | null = null
    for (const line of window) {
      try {
        const plain = decryptOpsLine(this.atRest, line)
        const row = JSON.parse(plain) as ChatMessageRow
        if (!row || typeof row.id !== 'string' || row.id !== id) continue
        if (room && row.room !== room) continue
        if (!found || (row.createdAt ?? 0) >= (found.createdAt ?? 0)) found = row
      } catch {
        /* skip corrupt line */
      }
    }
    return found
  }

  private async findInRoomDirById(
    roomDir: string,
    id: string,
    room?: string,
  ): Promise<ChatMessageRow | null> {
    const fast = this.findByOffsetInDir(roomDir, id)
    if (fast && (!room || fast.room === room)) return fast
    const path = messagesPath(roomDir)
    if (!existsSync(path)) return null
    return this.scanRoomFileForId(path, id, room)
  }

  private async findByIdDiskFallback(
    id: string,
    roomHint?: string,
  ): Promise<ChatMessageRow | null> {
    const roomsDir = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsDir)) return null
    if (typeof roomHint === 'string' && roomHint) {
      const parsedHint = parseChatRoomId(roomHint)
      if (parsedHint.ok) {
        const dir = chatRoomDir(this.dataDir, parsedHint.room)
        if (dir && existsSync(dir)) {
          const found = await this.findInRoomDirById(dir, id, parsedHint.room)
          if (found) return found
        }
      }
    }
    let names: string[]
    try {
      names = readdirSync(roomsDir)
    } catch {
      return null
    }
    let scannedRooms = 0
    for (const name of names) {
      if (scannedRooms >= MAX_ROOMS_SCAN_FOR_FIND_BY_ID) {
        bumpChatMetric('findByIdScanCapped')
        console.warn(
          `[bridge] chat findById disk fallback: room-scan cap (${MAX_ROOMS_SCAN_FOR_FIND_BY_ID}) reached looking up message id (room unknown)`,
        )
        break
      }
      scannedRooms++
      const dir = join(roomsDir, name)
      const found = await this.findInRoomDirById(dir, id)
      if (found) return found
    }
    return null
  }

  /**
   * TCC-R1134-CHAT-023: `appendLineSync` writes each message as `<json>\n`
   * via `appendFileSync`. A crash landing mid-write (killed process, power
   * loss before the write reached disk) can leave `messages.jsonl` ending in
   * a torn, newline-less partial line - readline-based readers already
   * treat an unparseable line as "skip" (safe), but the NEXT `appendFileSync`
   * after restart would land directly after that torn tail with NO
   * separator, silently MERGING the torn garbage with the brand-new message
   * into one unparseable line - not just losing the old torn write, but
   * losing the very next message written after the crash too. Repair the
   * boundary once per room, the first time this process touches it, by
   * ensuring the file ends with a newline before any new append can land.
   * This never rewrites or drops any complete line - it only ever appends a
   * single missing `\n` separator, so a healthy file (already ending in
   * `\n`, or empty) is untouched.
   */
  private repairTornMessagesTail(roomDir: string): void {
    if (this.tailCheckedRoomDirs.has(roomDir)) return
    if (this.tailCheckedRoomDirs.size >= ChatRoomHistoryStore.TAIL_CHECKED_CAP) {
      this.tailCheckedRoomDirs.clear()
    }
    this.tailCheckedRoomDirs.add(roomDir)
    const path = messagesPath(roomDir)
    let fd: number | null = null
    try {
      if (!existsSync(path)) return
      fd = openSync(path, 'r+')
      const stat = fstatSync(fd)
      if (stat.size === 0) return
      const buf = Buffer.alloc(1)
      const read = readSync(fd, buf, 0, 1, stat.size - 1)
      if (read === 1 && buf[0] !== 0x0a) {
        writeSync(fd, Buffer.from('\n', 'utf8'), 0, 1, stat.size)
        console.warn(
          `[bridge] repaired a torn chat history write (missing trailing newline) in ${path}`,
        )
      }
    } catch {
      /* best-effort - never block a write over a repair-probe failure */
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* fd already invalid/closed */
        }
      }
    }
  }

  private ensureRoomDir(roomId: string): string | { error: string } {
    const dir = chatRoomDir(this.dataDir, roomId)
    if (!dir) return { error: 'Invalid room id' }
    const roomsParent = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsParent)) mkdirSync(roomsParent, { recursive: true })
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.repairTornMessagesTail(dir)
    return dir
  }

  private checkQuotaBeforeWrite(extraBytes: number): { ok: true } | { error: string } {
    const quotas = resolveChatDiskQuotas()
    const used = measureChatFilesBytes(this.dataDir)
    if (used + extraBytes > quotas.chatFilesBytes) {
      bumpChatMetric('quotaRefusals')
      return { error: chatQuotaRefusal('files', used, quotas.chatFilesBytes) }
    }
    return { ok: true }
  }

  getRetentionDays(): number {
    return this.retentionDays
  }

  /** Admin live update from chat_config_set (0 = keep forever). */
  setRetentionDays(days: number): void {
    const n = Number(days)
    if (!Number.isFinite(n) || n < 0) return
    this.retentionDays =
      n === 0 ? 0 : Math.min(3650, Math.floor(n))
  }

  private loadIndexFromDisk(roomDir: string): SearchIndex {
    const path = indexPath(roomDir)
    if (!existsSync(path)) {
      return { version: 1, offsets: [], terms: {} }
    }
    try {
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw) as SearchIndex
      if (parsed?.version === 1 && Array.isArray(parsed.offsets)) {
        return {
          version: 1,
          offsets: parsed.offsets.slice(-INDEX_OFFSET_CAP),
          terms: parsed.terms && typeof parsed.terms === 'object' ? parsed.terms : {},
        }
      }
    } catch {
      /* rebuild lazily */
    }
    return { version: 1, offsets: [], terms: {} }
  }

  private saveIndex(roomDir: string, index: SearchIndex): void {
    const trimmed: SearchIndex = {
      version: 1,
      offsets: index.offsets.slice(-INDEX_OFFSET_CAP),
      terms: index.terms,
    }
    const tmp = `${indexPath(roomDir)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(trimmed), 'utf8')
    renameSync(tmp, indexPath(roomDir))
  }

  /** Get (loading from disk lazily) the in-memory index cache entry for a room. */
  private getIndexEntry(roomDir: string): IndexCacheEntry {
    const existing = this.indexCache.get(roomDir)
    if (existing) return existing
    const entry: IndexCacheEntry = {
      index: this.loadIndexFromDisk(roomDir),
      dirty: false,
      flushTimer: null,
    }
    this.indexCache.set(roomDir, entry)
    if (this.indexCache.size > INDEX_CACHE_MAX_ROOMS) {
      const oldestKey = this.indexCache.keys().next().value
      if (typeof oldestKey === 'string' && oldestKey !== roomDir) {
        this.flushIndexEntry(oldestKey)
        this.indexCache.delete(oldestKey)
      }
    }
    return entry
  }

  /** Synchronously persist a dirty in-memory index (eviction / prune / test hook). */
  private flushIndexEntry(roomDir: string): void {
    const entry = this.indexCache.get(roomDir)
    if (!entry) return
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.dirty) {
      try {
        this.saveIndex(roomDir, entry.index)
      } catch {
        /* best-effort; index rebuilds lazily from cache on next load */
      }
      entry.dirty = false
    }
  }

  /** Coalesce rapid writes to the same room into one debounced disk write. */
  private scheduleIndexFlush(roomDir: string, entry: IndexCacheEntry): void {
    entry.dirty = true
    if (entry.flushTimer) return
    const timer = setTimeout(() => {
      entry.flushTimer = null
      if (entry.dirty) {
        try {
          this.saveIndex(roomDir, entry.index)
        } catch {
          /* best-effort; index rebuilds lazily from cache on next load */
        }
        entry.dirty = false
      }
    }, INDEX_FLUSH_DEBOUNCE_MS)
    timer.unref?.()
    entry.flushTimer = timer
  }

  /** Flush every pending debounced index write now (shutdown / test hook). */
  flushAllPendingChatIndexes(): void {
    for (const roomDir of this.indexCache.keys()) {
      this.flushIndexEntry(roomDir)
    }
  }

  private updateIndexOnAppend(
    roomDir: string,
    row: ChatMessageRow,
    byteOffset: number,
  ): void {
    const entry = this.getIndexEntry(roomDir)
    const index = entry.index
    // Keep one offset per id (edit/react/tomb re-append updates tip offset).
    const existingOff = index.offsets.findIndex((e) => e.id === row.id)
    const offRow = { id: row.id, offset: byteOffset, createdAt: row.createdAt }
    if (existingOff >= 0) index.offsets[existingOff] = offRow
    else index.offsets.push(offRow)
    if (index.offsets.length > INDEX_OFFSET_CAP) {
      index.offsets = index.offsets.slice(-INDEX_OFFSET_CAP)
    }
    const isTomb = typeof row.deletedAt === 'number' && row.deletedAt > 0
    const nextTerms = isTomb ? new Set<string>() : new Set(tokenizeForSearch(row.body))
    // TCC-R1154-CHAT-011: scrub terms that left the body on edit / tomb.
    for (const term of Object.keys(index.terms)) {
      const list = index.terms[term]
      if (!list || !list.includes(row.id)) continue
      if (nextTerms.has(term)) continue
      const filtered = list.filter((id) => id !== row.id)
      if (filtered.length === 0) delete index.terms[term]
      else index.terms[term] = filtered
    }
    for (const term of nextTerms) {
      let list = index.terms[term]
      if (!list) {
        if (Object.keys(index.terms).length >= MAX_SEARCH_TERMS) continue
        list = []
        index.terms[term] = list
      }
      if (!list.includes(row.id)) list.push(row.id)
      if (list.length > 500) list.shift()
    }
    this.scheduleIndexFlush(roomDir, entry)
  }

  /** TCC-R1153-CHAT-011: rebuild search index after prune rewrites jsonl. */
  private rebuildIndexAfterPrune(
    roomDir: string,
    rows: Array<{ row: ChatMessageRow; offset: number }>,
  ): void {
    const entry = this.getIndexEntry(roomDir)
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    entry.index = { version: 1, offsets: [], terms: {} }
    entry.dirty = false
    for (const { row, offset } of rows) {
      this.updateIndexOnAppend(roomDir, row, offset)
    }
    this.flushIndexEntry(roomDir)
  }

  /**
   * TCC-R1133-CHAT-001: every synchronous room-file mutation (append/edit/
   * react/setPinned/softDelete write) AND the async hourly prune rewrite for
   * that same room MUST run through this one chokepoint. Node interleaves
   * unrelated I/O callbacks between `pruneRoomFile`'s `await` points, so a
   * sync `appendLineSync` that lands mid-prune would otherwise get silently
   * wiped by prune's final `renameSync`. Chaining here guarantees strict
   * FIFO ordering per room (other rooms proceed fully independently) with
   * zero lock files. `fn` always runs (even if the previous queued op
   * rejected) so one failed write can never permanently wedge every future
   * write to that room behind a rejected promise.
   */
  private queueRoomWriteBySafeName<T>(safe: string, fn: () => T | Promise<T>): Promise<T> {
    const prevChain = this.roomQueues.get(safe) ?? Promise.resolve()
    const resultPromise = prevChain.then(fn, fn)
    const settleChain: Promise<void> = resultPromise.then(
      () => undefined,
      () => undefined,
    )
    this.roomQueues.set(safe, settleChain)
    // Bounded map: drop the entry once this op settles, unless a newer op
    // has already replaced it in the map (avoids unbounded growth as rooms
    // go idle - the map only ever holds one entry per room WITH work in flight).
    void settleChain.finally(() => {
      if (this.roomQueues.get(safe) === settleChain) this.roomQueues.delete(safe)
    })
    return resultPromise
  }

  private queueRoomWrite<T>(roomId: string, fn: () => T | Promise<T>): Promise<T> {
    const safe = safeChatRoomDirName(roomId)
    if (!safe) return Promise.reject(new Error('Invalid room'))
    return this.queueRoomWriteBySafeName(safe, fn)
  }

  private appendLineSync(roomDir: string, row: ChatMessageRow): { error: string } | { ok: true; offset: number } {
    const quota = this.checkQuotaBeforeWrite(JSON.stringify(row).length + 64)
    if ('error' in quota) return quota
    const path = messagesPath(roomDir)
    let offset = 0
    try {
      // TCC-R1133-CHAT-002: statSync instead of readFileSync().length - we only
      // need the byte size, not the full file content, on every write.
      offset = statSync(path).size
    } catch {
      offset = 0
    }
    const plain = JSON.stringify(row)
    const line = `${this.atRest ? encryptOpsLine(this.atRest, plain) : plain}\n`
    appendFileSync(path, line, 'utf8')
    this.updateIndexOnAppend(roomDir, row, offset)
    bumpChatMetric('messagesAppended')
    return { ok: true, offset }
  }

  async append(input: {
    room: string
    body: string
    memberId: string
    memberName: string
    role: BridgeRole
    kind?: 'user' | 'system'
    id?: string
    replyToId?: string | null
    attachments?: ChatAttachmentMeta[]
  }): Promise<ChatMessageRow | { error: string }> {
    const parsed = parseChatRoomId(input.room)
    if (!parsed.ok) return { error: parsed.reason }
    const body = scrubChatBody(input.body)
    if (!body) return { error: 'Message is empty or too long' }
    const memberId = String(input.memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!memberId) return { error: 'memberId required' }
    const memberName = String(input.memberName || 'Member')
      .replace(/\0/g, '')
      .trim()
      .slice(0, 120) || 'Member'
    const role: BridgeRole =
      input.role === 'admin' || input.role === 'member' || input.role === 'viewer'
        ? input.role
        : 'member'
    const id =
      typeof input.id === 'string' && input.id.replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
        ? input.id.replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
        : mintChatId()
    const replyToId =
      typeof input.replyToId === 'string'
        ? input.replyToId.replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX) || null
        : null
    const attachments = Array.isArray(input.attachments) ? input.attachments.slice(0, 10) : undefined
    // TCC-R1133-CHAT-001: the idempotency check (findById) AND the write must
    // run inside the SAME queued turn for this room - otherwise two rapid
    // duplicate-id appends (or an append racing a prune rewrite) could both
    // pass the check before either writes, producing a duplicate jsonl line.
    return this.queueRoomWrite(parsed.room, async () => {
      const existing = await this.findById(id, parsed.room)
      if (existing) {
        // TCC-R1154-CHAT-008: idempotency is per-room - a live id in another
        // room must not satisfy this append (false chat_ok / wrong payload).
        if (existing.room !== parsed.room) {
          return { error: 'Message id already used in another room' }
        }
        const tomb =
          typeof existing.deletedAt === 'number' && existing.deletedAt > 0
        // TCC-R1145-CHAT-001: never reopen a soft-deleted id under a new body.
        if (tomb) {
          return { error: 'Message id was removed and cannot be reused' }
        }
        // TCC-R1144-CHAT-003: same-author retry returns existing; cross-author
        // reuse must refuse (content identity steal).
        if (existing.memberId !== memberId) {
          return { error: 'Message id already used by another member' }
        }
        return existing
      }
      const roomDir = this.ensureRoomDir(parsed.room)
      if (typeof roomDir !== 'string') return roomDir
      const row: ChatMessageRow = {
        id,
        room: parsed.room,
        body: capChatText(body, CHAT_BODY_MAX),
        memberId,
        memberName,
        role,
        createdAt: Date.now(),
        kind: input.kind === 'system' ? 'system' : 'user',
        replyToId,
        attachments,
      }
      const written = this.appendLineSync(roomDir, row)
      if ('error' in written) return written
      this.remember(row)
      return row
    })
  }

  async edit(
    messageId: string,
    editorMemberId: string,
    newBody: string,
    isAdmin: boolean,
    roomHint?: string,
    editWindowMs?: number,
  ): Promise<ChatMessageRow | { error: string }> {
    const id = String(messageId || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    if (!id) return { error: 'message id required' }
    const body = scrubChatBody(newBody)
    if (!body) return { error: 'Message is empty or too long' }
    // TCC-R1143-CHAT-016: edit clock is CHAT_EDIT_MS (or Admin Limits override),
    // never the shorter author-unsend window.
    const windowMs =
      typeof editWindowMs === 'number' && Number.isFinite(editWindowMs) && editWindowMs > 0
        ? Math.floor(editWindowMs)
        : CHAT_EDIT_MS
    // TCC-R1125-CHAT-001: resolve (with disk fallback) BEFORE queuing since
    // we need the row's room to pick which per-room queue to join.
    const prevPeek = await this.findById(id, roomHint)
    if (!prevPeek) return { error: 'Message not found' }
    return this.queueRoomWrite(prevPeek.room, () => {
      // TCC-R1133-CHAT-001: re-read from cache now that we're inside the
      // queue - another queued mutation for this id/room may have run
      // between the peek above and this turn actually executing.
      const prev = this.findByIdCached(id) ?? prevPeek
      if (typeof prev.deletedAt === 'number' && prev.deletedAt > 0) {
        return { error: 'Message was removed' }
      }
      if (!isAdmin && prev.memberId !== editorMemberId) {
        return { error: 'Only the author can edit this message' }
      }
      if (!isAdmin && Date.now() - (prev.createdAt ?? 0) > windowMs) {
        return { error: 'Edit window expired' }
      }
      const row: ChatMessageRow = {
        ...prev,
        body: capChatText(body, CHAT_BODY_MAX),
        editedAt: Date.now(),
      }
      const roomDir = this.ensureRoomDir(prev.room)
      if (typeof roomDir !== 'string') return roomDir
      const written = this.appendLineSync(roomDir, row)
      if ('error' in written) return written
      this.remember(row)
      bumpChatMetric('messagesEdited')
      return row
    })
  }

  async react(
    messageId: string,
    memberId: string,
    emoji: string,
    remove: boolean,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string }> {
    const id = String(messageId || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    const mid = String(memberId || '').trim().slice(0, 128)
    const e = String(emoji || '').replace(/\0/g, '').trim().slice(0, 32)
    if (!id || !mid || !e) return { error: 'message, member, and emoji required' }
    const prevPeek = await this.findById(id, roomHint)
    if (!prevPeek) return { error: 'Message not found' }
    return this.queueRoomWrite(prevPeek.room, () => {
      const prev = this.findByIdCached(id) ?? prevPeek
      // TCC-R1132-CHAT-001: tombstoned messages must stay immutable, same as edit()
      // and authorUnsend() already enforce - otherwise a react fanout can resurrect
      // an empty removed bubble on peers that already dropped it.
      if (typeof prev.deletedAt === 'number' && prev.deletedAt > 0) {
        return { error: 'Message was removed' }
      }
      // TCC-R1151-CHAT-007: system/task lines are not reactable.
      if (prev.kind === 'system') {
        return { error: 'Cannot react to system messages' }
      }
      const reactions: ChatReactionMap = { ...(prev.reactions || {}) }
      const cur = [...(reactions[e] || [])]
      const idx = cur.indexOf(mid)
      // TCC-R1150-CHAT-006: idempotent add/remove is a no-op (no history line / metric / fanout).
      if (remove) {
        if (idx < 0) return prev
        cur.splice(idx, 1)
      } else {
        if (idx >= 0) return prev
        // TCC-R1148-CHAT-007: cap distinct emoji keys per message (client parse twin).
        if (!(e in reactions) && Object.keys(reactions).length >= 32) {
          return { error: 'Too many different reactions on this message' }
        }
        // TCC-R1149-CHAT-007: refuse past 200 reactors (never silently drop newest).
        if (cur.length >= 200) {
          return { error: 'Too many reactions on this emoji' }
        }
        cur.push(mid)
      }
      if (cur.length === 0) delete reactions[e]
      else reactions[e] = cur
      const row: ChatMessageRow = { ...prev, reactions, lastReactAt: Date.now() }
      const roomDir = this.ensureRoomDir(prev.room)
      if (typeof roomDir !== 'string') return roomDir
      const written = this.appendLineSync(roomDir, row)
      if ('error' in written) return written
      this.remember(row)
      bumpChatMetric('reactions')
      return row
    })
  }

  /**
   * Pin one message. Independent of `unpinMessage` - pinning never disturbs
   * a message somebody else already pinned.
   *
   * Already pinned reports `unchanged: true`, not an error. A room that has
   * reached `CHAT_ROOM_PINS_MAX` refuses the new pin rather than quietly
   * evicting the oldest one.
   */
  async pinMessage(
    roomId: string,
    messageId: string,
    byAdmin: boolean,
  ): Promise<ChatPinWriteResult> {
    return this.writePins(roomId, messageId, byAdmin, 'pin')
  }

  /**
   * Unpin one message. Not pinned reports `unchanged: true`, not an error.
   *
   * `messageId` may be null only for callers that predate multi-pin and can
   * only say "unpin", never which one; those fall back to the most recently
   * pinned message, which is what a single-pin room had anyway.
   */
  async unpinMessage(
    roomId: string,
    messageId: string | null,
    byAdmin: boolean,
  ): Promise<ChatPinWriteResult> {
    return this.writePins(roomId, messageId, byAdmin, 'unpin')
  }

  /**
   * Back-compat entry point: a message id pins, `null` unpins the newest.
   * Prefer `pinMessage` / `unpinMessage`, which say which one they mean.
   */
  async setPinned(
    roomId: string,
    messageId: string | null,
    byAdmin: boolean,
  ): Promise<ChatPinWriteResult> {
    return typeof messageId === 'string' && messageId.trim()
      ? this.pinMessage(roomId, messageId, byAdmin)
      : this.unpinMessage(roomId, null, byAdmin)
  }

  private async writePins(
    roomId: string,
    messageId: string | null,
    byAdmin: boolean,
    mode: 'pin' | 'unpin',
  ): Promise<ChatPinWriteResult> {
    if (!byAdmin) return { error: 'Only Admin can pin messages' }
    const parsed = parseChatRoomId(roomId)
    if (!parsed.ok) return { error: parsed.reason }
    const targetId = normalizeChatPinId(messageId)
    if (mode === 'pin') {
      if (!targetId) return { error: 'message id required to pin' }
      // TCC-R1125-CHAT-001: disk fallback so pinning an older row that fell
      // out of the LRU cache doesn't spuriously fail "not found in this room".
      const prevCheck = await this.findById(targetId, parsed.room)
      if (!prevCheck || prevCheck.room !== parsed.room) {
        return { error: 'Message not found in this room' }
      }
      // TCC-R1132-CHAT-001: refuse pinning a tombstoned message (same soft-delete
      // gate edit()/react() enforce) - a removed message must stay unpinnable.
      if (typeof prevCheck.deletedAt === 'number' && prevCheck.deletedAt > 0) {
        return { error: 'Message was removed' }
      }
    }
    return this.queueRoomWrite(parsed.room, () => {
      const roomDir = this.ensureRoomDir(parsed.room)
      if (typeof roomDir !== 'string') return roomDir
      const current = this.getPinnedMessageIds(parsed.room)
      // A caller that can only say "unpin" means the newest pin.
      const effectiveId = mode === 'unpin' && !targetId ? newestChatRoomPin(current) : targetId
      if (mode === 'unpin' && !effectiveId) {
        // Nothing pinned and nothing named - already in the requested state.
        return { ok: true as const, pinnedId: null, pinnedIds: [], unchanged: true as const }
      }
      const applied =
        mode === 'pin'
          ? addChatRoomPin(current, effectiveId)
          : removeChatRoomPin(current, effectiveId)
      if ('error' in applied) return applied
      // TCC-R1151-CHAT-010: re-pinning an id already pinned, or unpinning one
      // that is not, writes nothing and raises no peer frame.
      if (!applied.changed) {
        return {
          ok: true as const,
          pinnedId: newestChatRoomPin(applied.ids),
          pinnedIds: applied.ids,
          unchanged: true as const,
        }
      }
      this.writePinMeta(roomDir, applied.ids)
      if (mode === 'pin' && effectiveId) {
        const prev = this.findByIdCached(effectiveId)
        if (prev && !(typeof prev.deletedAt === 'number' && prev.deletedAt > 0)) {
          const row: ChatMessageRow = { ...prev, pinned: true }
          this.appendLineSync(roomDir, row)
          this.remember(row)
        }
      }
      return {
        ok: true as const,
        pinnedId: newestChatRoomPin(applied.ids),
        pinnedIds: applied.ids,
      }
    })
  }

  /** Atomic pin-meta write. Also keeps the legacy single-pin key in step. */
  private writePinMeta(roomDir: string, ids: readonly string[]): void {
    const tmp = `${metaPath(roomDir)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(buildChatRoomPinMeta(ids)), 'utf8')
    renameSync(tmp, metaPath(roomDir))
  }

  /**
   * Every pinned message in the room, in pin order (oldest first).
   * A room whose meta still holds the legacy single `pinnedMessageId` reads
   * back as a one-entry list, so an existing pin is never lost.
   */
  getPinnedMessageIds(roomId: string): string[] {
    const dir = chatRoomDir(this.dataDir, roomId)
    if (!dir) return []
    const path = metaPath(dir)
    if (!existsSync(path)) return []
    try {
      return readChatRoomPinIds(JSON.parse(readFileSync(path, 'utf8')))
    } catch {
      return []
    }
  }

  /** The most recently pinned message - what a room banner shows. */
  getPinnedMessageId(roomId: string): string | null {
    return newestChatRoomPin(this.getPinnedMessageIds(roomId))
  }

  async softDelete(
    messageId: string,
    byMemberId: string,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string } | { unchanged: true; tomb: ChatMessageRow }> {
    const id = String(messageId || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    if (!id) return { error: 'message id required' }
    const prevPeek = await this.findById(id, roomHint)
    // TCC-R1151-CHAT-008: never invent a TEAM (or any) tombstone on miss -
    // Admin delete of an unknown id must refuse, not mint durable junk.
    if (!prevPeek) return { error: 'Message not found' }
    const room =
      typeof prevPeek.room === 'string' && prevPeek.room
        ? prevPeek.room
        : typeof roomHint === 'string' && roomHint.trim()
          ? roomHint.trim().slice(0, 160)
          : ''
    if (!room) return { error: 'Message not found' }
    return this.queueRoomWrite(room, () => {
      // TCC-R1133-CHAT-001: re-check inside the queue so this stays
      // idempotent - a concurrent authorUnsend + admin delete racing on the
      // same id must never produce two tombstone lines for one message.
      const prev = this.findByIdCached(id) ?? prevPeek
      if (!prev) return { error: 'Message not found' }
      if (typeof prev.deletedAt === 'number' && prev.deletedAt > 0) {
        // TCC-R1151-CHAT-011: idempotent tomb - ok to caller, no second fanout.
        return { unchanged: true as const, tomb: prev }
      }
      // Keep original author on the tomb (deletedBy tracks who removed it) so
      // chat_delete_peer unread honesty can reverse peer bumps correctly.
      const authorId =
        typeof prev.memberId === 'string' && prev.memberId.trim()
          ? String(prev.memberId).slice(0, 128)
          : String(byMemberId || '').slice(0, 128)
      const tomb: ChatMessageRow = {
        id,
        room,
        body: '',
        memberId: authorId,
        memberName: '',
        role: 'admin',
        createdAt: prev.createdAt ?? Date.now(),
        deletedAt: Date.now(),
        deletedBy: String(byMemberId || '').slice(0, 128),
        kind: 'system',
      }
      const roomDir = this.ensureRoomDir(room)
      if (typeof roomDir !== 'string') return roomDir
      const written = this.appendLineSync(roomDir, tomb)
      if ('error' in written) return written
      this.remember(tomb)
      bumpChatMetric('messagesDeleted')
      // TCC-R1152-CHAT-010: a removed message must not stay pinned. Drop only
      // its own entry - the room's other pins are untouched.
      try {
        const dropped = removeChatRoomPin(this.getPinnedMessageIds(room), id)
        if ('ok' in dropped && dropped.changed) this.writePinMeta(roomDir, dropped.ids)
      } catch { /* pin clear best-effort inside delete txn */ }
      return tomb
    })
  }

  async authorUnsend(
    messageId: string,
    memberId: string,
    isAdmin: boolean,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string } | { unchanged: true; tomb: ChatMessageRow }> {
    const id = String(messageId || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    const mid = String(memberId || '').trim().slice(0, 128)
    if (!id || !mid) return { error: 'message id required' }
    // TCC-R1125-CHAT-001: disk fallback so unsend on an older row that fell
    // out of the LRU cache doesn't spuriously fail "Message not found".
    const prev = await this.findById(id, roomHint)
    if (!prev) return { error: 'Message not found' }
    if (typeof prev.deletedAt === 'number' && prev.deletedAt > 0) {
      return { error: 'Message was already removed' }
    }
    if (!isAdmin && prev.memberId !== mid) {
      return { error: 'Only the author can unsend this message' }
    }
    if (!isAdmin && Date.now() - (prev.createdAt ?? 0) > CHAT_UNSEND_MS) {
      return { error: 'Unsend window expired (15 minutes)' }
    }
    return this.softDelete(id, mid, prev.room)
  }

  async exportRoom(
    room: string,
    format: 'json' | 'txt',
    opts?: { signal?: AbortSignal; maxBodyBytes?: number },
  ): Promise<{ body: string; truncated: boolean } | { error: string }> {
    const parsed = parseChatRoomId(room)
    if (!parsed.ok) return { error: parsed.reason }
    const maxBody = Math.max(
      64 * 1024,
      Math.min(8_000_000, opts?.maxBodyBytes ?? 8_000_000),
    )
    // Cap export scan - same hard ceiling as history inventory.
    const res = await this.readRecent(parsed.room, CHAT_HISTORY_LIMIT_MAX * 200, undefined)
    // readRecent only returns one page - walk with before for fuller export
    const all: ChatMessageRow[] = [...res.messages]
    let truncated = res.truncated
    let guard = 0
    // TCC-R1149-BRG-002: fewer pages + early abort when estimated wire body
    // already exceeds the 8 MiB reply slice (avoid 41 full-file scans).
    const MAX_EXPORT_PAGES = 8
    while (truncated && guard < MAX_EXPORT_PAGES && all.length > 0) {
      if (opts?.signal?.aborted) return { error: 'Export cancelled' }
      // Rough estimate: average ~200 bytes/msg JSON before stringify.
      if (all.length * 200 > maxBody) {
        truncated = true
        break
      }
      guard += 1
      const oldest = all[0]
      const more = await this.readRecent(parsed.room, CHAT_HISTORY_LIMIT_MAX, oldest.createdAt)
      if (more.messages.length === 0) {
        // TCC-R1154-CHAT-009: empty before-page must NOT clear truncated when
        // the underlying scan still hit the tail-window cap (scanTruncated).
        truncated = more.truncated === true
        break
      }
      const ids = new Set(all.map((m) => m.id))
      for (const m of more.messages) {
        if (!ids.has(m.id)) all.unshift(m)
      }
      truncated = more.truncated
    }
    if (guard >= MAX_EXPORT_PAGES && truncated) {
      // Honesty: more history exists past the page cap.
      truncated = true
    }
    // Scrub passwords / invite hashes never appear in message bodies by design.
    // SEC-CHAT-08/12: never include password material; attachments as sha only.
    const safe = all.map((m) => ({
      id: m.id,
      room: m.room,
      body: m.deletedAt ? '' : m.body,
      memberId: m.memberId,
      memberName: m.memberName,
      role: m.role,
      createdAt: m.createdAt,
      kind: m.kind,
      editedAt: m.editedAt ?? null,
      deletedAt: m.deletedAt ?? null,
      replyToId: m.replyToId ?? null,
      pinned: m.pinned === true,
      attachments: (m.attachments || []).map((a) => ({
        blobId: a.blobId,
        name: a.name,
        bytes: a.bytes,
        mime: a.mime,
        ...(typeof a.durationSec === 'number' && Number.isFinite(a.durationSec)
          ? { durationSec: Math.floor(a.durationSec) }
          : {}),
      })),
    }))
    if (format === 'txt') {
      const lines = safe.map((m) => {
        const when = new Date(m.createdAt).toISOString()
        if (m.deletedAt) return `[${when}] ${m.memberName}: [removed]`
        return `[${when}] ${m.memberName}: ${m.body}`
      })
      return { body: lines.join('\n'), truncated }
    }
    return {
      body: JSON.stringify({ room: parsed.room, truncated, messages: safe }, null, 2),
      truncated,
    }
  }

  async readRecent(
    room: string,
    limit = 50,
    before?: number,
    beforeId?: string,
  ): Promise<{ messages: ChatMessageRow[]; truncated: boolean }> {
    bumpChatMetric('historyReads')
    const parsed = parseChatRoomId(room)
    if (!parsed.ok) return { messages: [], truncated: false }
    const lim = Math.max(
      1,
      Math.min(CHAT_HISTORY_LIMIT_MAX, Number.isFinite(limit) ? Math.floor(limit) : 50),
    )
    const beforeAt =
      typeof before === 'number' && Number.isFinite(before) && before > 0 ? before : null
    const beforeMsgId =
      typeof beforeId === 'string' ? beforeId.replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX) : ''
    const dir = chatRoomDir(this.dataDir, parsed.room)
    if (!dir) return { messages: [], truncated: false }
    const path = messagesPath(dir)
    if (!existsSync(path)) return { messages: [], truncated: false }

    const { byId, seqById, scanTruncated } = await this.scanRoomFile(path, parsed.room)
    let list = [...byId.values()].filter((m) => !(typeof m.deletedAt === 'number' && m.deletedAt > 0))
    // TCC-FIX-CHAT-A9: stable order is createdAt then real append-order seq
    // (never id.localeCompare - ids are random and unrelated to send order,
    // so tie-breaking by id can put an older-sent message after a newer one
    // whenever two appends land in the same createdAt millisecond, which is
    // routine for fast/bursty writers). Fall back to id only if a row's seq
    // is somehow missing (defensive; every row here came from this same scan).
    list.sort((a, b) => {
      const dt = (a.createdAt ?? 0) - (b.createdAt ?? 0)
      if (dt !== 0) return dt
      const sa = seqById.get(a.id)
      const sb = seqById.get(b.id)
      if (sa != null && sb != null && sa !== sb) return sa - sb
      return String(a.id).localeCompare(String(b.id))
    })
    if (beforeAt != null) {
      // TCC-R1147-CHAT-005 / TCC-FIX-CHAT-A9: exclusive (createdAt, seq)
      // cursor - rows at the same timestamp as `before` but sent earlier
      // (lower seq) stay pageable, matching the sort tiebreak above so a
      // page boundary landing inside a same-millisecond burst never skips or
      // duplicates a row. Falls back to id comparison only when the cursor's
      // own id fell out of this scan's window (can't resolve its seq).
      const beforeSeq = beforeMsgId ? seqById.get(beforeMsgId) : undefined
      list = list.filter((m) => {
        const t = m.createdAt ?? 0
        if (t < beforeAt) return true
        if (t > beforeAt) return false
        if (!beforeMsgId) return false
        if (beforeSeq != null) {
          const ms = seqById.get(m.id)
          if (ms != null) return ms < beforeSeq
        }
        return String(m.id).localeCompare(beforeMsgId) < 0
      })
    }
    // TCC-R1126-CHAT-001: honor BOTH truncation sources - the caller's page
    // size cap (list.length > lim) and the tail-scan window cap
    // (scanTruncated) - either one means the caller is not seeing the full
    // room, so `truncated` must stay true even when the requested page
    // itself fit under `lim`.
    const truncated = list.length > lim || scanTruncated
    return { messages: list.slice(-lim), truncated }
  }

  async searchRoom(
    room: string,
    query: string,
    limit = 30,
  ): Promise<{ messageIds: string[]; truncated: boolean }> {
    bumpChatMetric('searchQueries')
    const parsed = parseChatRoomId(room)
    if (!parsed.ok) return { messageIds: [], truncated: false }
    const q = String(query || '').toLowerCase().trim()
    if (!q) return { messageIds: [], truncated: false }
    const dir = chatRoomDir(this.dataDir, parsed.room)
    if (!dir) return { messageIds: [], truncated: false }
    const index = this.getIndexEntry(dir).index
    const terms = q.split(/\s+/).filter((w) => w.length >= 2).slice(0, 8)
    const sets = terms.map((t) => new Set(index.terms[t] || []))
    if (sets.length === 0) {
      // Fallback: scan recent ids only (readRecent already filters soft-deleted).
      const recent = await this.readRecent(parsed.room, 100)
      const hits = recent.messages
        .filter((m) => m.body.toLowerCase().includes(q))
        .map((m) => m.id)
      return { messageIds: hits.slice(0, limit), truncated: hits.length > limit }
    }
    let ids: string[] = [...(sets[0] || [])]
    for (let i = 1; i < sets.length; i++) {
      ids = ids.filter((id) => sets[i]!.has(id))
    }
    // TCC-R1130-CHAT-001 / TCC-R1152-CHAT-011: refuse tombs via cache AND
    // disk resolve (tomb may have aged out of recentById while index lags).
    const lim = Math.min(100, Math.max(1, limit))
    const candidates = ids.slice(0, lim + 20)
    const live: string[] = []
    for (const id of candidates) {
      if (live.length >= lim) break
      const cached = this.findByIdCached(id)
      if (cached) {
        if (typeof cached.deletedAt === 'number' && cached.deletedAt > 0) continue
        if (cached.room !== parsed.room) continue
        live.push(id)
        continue
      }
      const found = await this.findById(id, parsed.room)
      if (!found || found.room !== parsed.room) continue
      if (typeof found.deletedAt === 'number' && found.deletedAt > 0) continue
      live.push(id)
    }
    return { messageIds: live, truncated: ids.length > lim || candidates.length > live.length && ids.length > lim }
  }

  async jumpToMessage(
    room: string,
    messageId: string,
  ): Promise<{ message: ChatMessageRow | null; offset: number | null }> {
    const parsed = parseChatRoomId(room)
    if (!parsed.ok) return { message: null, offset: null }
    const dir = chatRoomDir(this.dataDir, parsed.room)
    if (!dir) return { message: null, offset: null }
    const index = this.getIndexEntry(dir).index
    const offsetEntry = index.offsets.find((e) => e.id === messageId)
    const cached = this.findByIdCached(messageId)
    if (cached && cached.room === parsed.room) {
      // TCC-R1130-CHAT-001: a tombstoned message must jump as "not found",
      // never resurrect the removed bubble into the caller's transcript.
      if (typeof cached.deletedAt === 'number' && cached.deletedAt > 0) {
        return { message: null, offset: offsetEntry?.offset ?? null }
      }
      return { message: cached, offset: offsetEntry?.offset ?? null }
    }
    if (!existsSync(messagesPath(dir))) return { message: null, offset: null }
    // TCC-R1125-CHAT-001: the room is already known here (and required to
    // match), so resolve directly against this ONE room dir (offset fast
    // path, then tail-windowed scoped scan) rather than the general
    // `findById` cross-room fallback, which would otherwise waste an
    // unbounded-looking scan across every other room before falling
    // through to the exact same scoped scan anyway.
    const found = await this.findInRoomDirById(dir, messageId, parsed.room)
    if (found) this.remember(found)
    if (found && typeof found.deletedAt === 'number' && found.deletedAt > 0) {
      return { message: null, offset: offsetEntry?.offset ?? null }
    }
    return { message: found, offset: offsetEntry?.offset ?? null }
  }

  /**
   * TCC-R1126-CHAT-001: this used to break out of the read loop once
   * `MAX_LINES_SCAN` raw lines had been seen from the HEAD of the file -
   * in any room whose jsonl exceeds the cap, that silently hid every
   * message/edit/reaction appended after the cutoff (the newest activity,
   * since appends always go to the end of the file). Stream the whole file
   * (readline handles line/encoding boundaries) but keep only the LAST
   * `MAX_TAIL_LINES_SCAN` raw lines in a bounded sliding window, so the
   * dedup-by-id pass below always sees the most recent activity regardless
   * of total file size. `scanTruncated` tells callers whether older history
   * beyond the tail window was dropped (matches `truncated` semantics used
   * elsewhere: true = the caller is not seeing the complete room).
   */
  private async scanRoomFile(
    path: string,
    room: string,
  ): Promise<{ byId: Map<string, ChatMessageRow>; seqById: Map<string, number>; scanTruncated: boolean }> {
    const window: string[] = []
    let totalLines = 0
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
    for await (const line of rl) {
      if (!line.trim()) continue
      totalLines++
      window.push(line)
      if (window.length > MAX_TAIL_LINES_SCAN) window.shift()
    }
    const byId = new Map<string, ChatMessageRow>()
    // TCC-FIX-CHAT-A9: `window` is in physical append order (oldest first),
    // which is a true chronological proxy even when several appends land in
    // the SAME Date.now() millisecond (routine under fast/bursty writers).
    // `seqById` records each id's first-seen position so callers can break
    // createdAt ties by real send order - never by `id.localeCompare`, since
    // ids are random strings with no relation to when a message was sent.
    const seqById = new Map<string, number>()
    for (let i = 0; i < window.length; i++) {
      const line = window[i]!
      try {
        const plain = decryptOpsLine(this.atRest, line)
        const row = JSON.parse(plain) as ChatMessageRow
        if (!row || typeof row.id !== 'string') continue
        if (row.room !== room) continue
        if (!seqById.has(row.id)) seqById.set(row.id, i)
        const prev = byId.get(row.id)
        if (!prev || (row.createdAt ?? 0) >= (prev.createdAt ?? 0)) {
          byId.set(row.id, row)
          this.remember(row)
        }
      } catch {
        /* skip */
      }
    }
    return { byId, seqById, scanTruncated: totalLines > MAX_TAIL_LINES_SCAN }
  }

  async prune(): Promise<number> {
    let removed = 0
    const roomsDir = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsDir)) return 0
    const msgCutoff =
      this.retentionDays <= 0 ? 0 : Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
    const tombCutoff =
      this.tombstoneDays <= 0 ? 0 : Date.now() - this.tombstoneDays * 24 * 60 * 60 * 1000

    for (const name of readdirSync(roomsDir)) {
      const roomDir = join(roomsDir, name)
      const path = messagesPath(roomDir)
      if (!existsSync(path)) continue
      // TCC-R1133-CHAT-001: serialize the prune rewrite against every other
      // mutator for this SAME room (append/edit/react/setPinned/softDelete)
      // via the shared per-room write queue, keyed by the same safe dir
      // name those mutators resolve to. Without this, a sync append that
      // lands while this async read-loop is mid-stream gets silently wiped
      // by pruneRoomFile's `renameSync` at the end.
      removed += await this.queueRoomWriteBySafeName(name, () =>
        this.pruneRoomFile(path, msgCutoff, tombCutoff),
      )
    }
    // TCC-R1133-CHAT-002 / TCC-R1132-CHAT-002: prune can free a meaningful
    // amount of disk space - don't let the short quota cache window hide
    // that from the very next write/Admin metrics read.
    if (removed > 0) invalidateChatFilesBytesCache(this.dataDir)
    return removed
  }

  /**
   * TCC-R1144-MEDIA-002: live attachment blob digests still referenced by
   * kept (non-tomb) message lines across every room file. Soft-delete tombs
   * omit attachments, so unsend/delete frees those shas for age-gated GC.
   */
  async collectLiveBlobShas(): Promise<Set<string>> {
    const keep = new Set<string>()
    const roomsDir = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsDir)) return keep
    for (const name of readdirSync(roomsDir)) {
      const path = messagesPath(join(roomsDir, name))
      if (!existsSync(path)) continue
      try {
        const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
        for await (const line of rl) {
          if (!line.trim()) continue
          let row: ChatMessageRow
          try {
            const plain = decryptOpsLine(this.atRest, line)
            row = JSON.parse(plain) as ChatMessageRow
          } catch {
            continue
          }
          if (typeof row.deletedAt === 'number' && row.deletedAt > 0) continue
          if (!Array.isArray(row.attachments)) continue
          for (const a of row.attachments.slice(0, 10)) {
            const id =
              typeof a?.blobId === 'string'
                ? a.blobId.replace(/\0/g, '').trim().toLowerCase().slice(0, 64)
                : ''
            if (/^[a-f0-9]{64}$/.test(id)) keep.add(id)
          }
        }
      } catch {
        /* skip unreadable room file */
      }
    }
    return keep
  }

  private async pruneRoomFile(
    path: string,
    msgCutoff: number,
    tombCutoff: number,
  ): Promise<number> {
    let removed = 0
    const kept: string[] = []
    const keptRows: Array<{ row: ChatMessageRow; offset: number }> = []
    const keptIds = new Set<string>()
    let nextOffset = 0
    const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }) })
    for await (const line of rl) {
      if (!line.trim()) continue
      let row: ChatMessageRow
      try {
        const plain = decryptOpsLine(this.atRest, line)
        row = JSON.parse(plain) as ChatMessageRow
      } catch {
        removed++
        continue
      }
      const isTomb = typeof row.deletedAt === 'number' && row.deletedAt > 0
      const created = row.createdAt ?? 0
      // TCC-R1154-CHAT-010: live retention ages by last activity (editedAt / react), not create alone.
      let activityAt = created
      if (typeof row.editedAt === 'number' && Number.isFinite(row.editedAt) && row.editedAt > activityAt) {
        activityAt = row.editedAt
      }
      if (typeof row.lastReactAt === 'number' && Number.isFinite(row.lastReactAt) && row.lastReactAt > activityAt) {
        activityAt = row.lastReactAt
      }
      if (isTomb) {
        if (tombCutoff > 0 && created < tombCutoff) {
          removed++
          continue
        }
      } else if (msgCutoff > 0 && activityAt < msgCutoff) {
        removed++
        continue
      }
      if (typeof row.id === 'string' && row.id) keptIds.add(row.id)
      const keepLine = this.atRest
        ? encryptOpsLine(this.atRest, JSON.stringify(row))
        : JSON.stringify(row)
      keptRows.push({ row, offset: nextOffset })
      nextOffset += Buffer.byteLength(`${keepLine}\n`, 'utf8')
      kept.push(keepLine)
    }
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, path)
    // TCC-R1153-CHAT-011: prune rewrites jsonl - rebuild search index (terms + offsets).
    try {
      const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
      if (dir) this.rebuildIndexAfterPrune(dir, keptRows)
    } catch { /* index rebuild best-effort */ }
    // TCC-R1153-CHAT-008: scrub LRU cache entries that aged out of disk so
    // edit/react/pin/delete cannot resurrect pruned rows from memory.
    if (removed > 0) {
      let roomIdForPin: string | null = null
      for (const [id, row] of this.recentById) {
        if (keptIds.has(id)) continue
        if (typeof row.room !== 'string') continue
        const roomDir = chatRoomDir(this.dataDir, row.room)
        if (roomDir && messagesPath(roomDir) === path) {
          roomIdForPin = row.room
          this.recentById.delete(id)
        }
      }
      // TCC-R1153-CHAT-010: drop pins whose message was pruned off disk.
      // Each pin is checked on its own, so pruning one aged-out message
      // never takes the room's other pins down with it.
      if (roomIdForPin) {
        const dir = chatRoomDir(this.dataDir, roomIdForPin)
        if (dir) {
          try {
            const kept = pruneChatRoomPins(
              this.getPinnedMessageIds(roomIdForPin),
              (id) => keptIds.has(id),
            )
            if (kept.changed) this.writePinMeta(dir, kept.ids)
          } catch { /* best-effort */ }
        }
      } else {
        // Fallback: derive room from path parent when cache was already empty.
        try {
          const dir = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
          const meta = metaPath(dir)
          if (existsSync(meta)) {
            const kept = pruneChatRoomPins(
              readChatRoomPinIds(JSON.parse(readFileSync(meta, 'utf8'))),
              (id) => keptIds.has(id),
            )
            if (kept.changed) this.writePinMeta(dir, kept.ids)
          }
        } catch { /* best-effort */ }
      }
    }
    return removed
  }

  private runMigrationIfNeeded(): void {
    if (this.migrationDone) return
    this.migrationDone = true
    const legacyFile = existsSync(this.legacyAltPath)
      ? this.legacyAltPath
      : existsSync(this.legacyPath)
        ? this.legacyPath
        : null
    if (!legacyFile) return
    const roomsDir = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsDir)) mkdirSync(roomsDir, { recursive: true })
    const migDir = join(this.chatRoot, 'migrations')
    if (!existsSync(migDir)) mkdirSync(migDir, { recursive: true })
    const stamp = Date.now()
    const backup = join(migDir, `chat.jsonl.bak.${stamp}`)
    try {
      copyFileSync(legacyFile, backup)
    } catch {
      return
    }
    let legacyCount = 0
    let migratedCount = 0
    let raw: string
    try {
      const st = readFileSync(legacyFile)
      if (st.length > 50 * 1024 * 1024) {
        console.warn('[bridge] legacy chat.jsonl too large for sync migration - migrate manually')
        return
      }
      raw = st.toString('utf8')
    } catch {
      return
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      legacyCount++
      try {
        const plain = decryptOpsLine(this.atRest, line)
        const row = JSON.parse(plain) as ChatMessageRow
        if (!row?.id || !row.room) continue
        const roomDir = this.ensureRoomDir(row.room)
        if (typeof roomDir !== 'string') continue
        appendFileSync(
          messagesPath(roomDir),
          `${this.atRest ? encryptOpsLine(this.atRest, JSON.stringify(row)) : JSON.stringify(row)}\n`,
          'utf8',
        )
        migratedCount++
        this.remember(row)
      } catch {
        /* skip line */
      }
    }
    if (migratedCount !== legacyCount && legacyCount > 0) {
      console.warn(
        `[bridge] chat migration count mismatch: legacy=${legacyCount} migrated=${migratedCount}`,
      )
    }
    const quarantine = join(migDir, 'quarantine', `chat.jsonl.${stamp}`)
    mkdirSync(join(migDir, 'quarantine'), { recursive: true })
    try {
      renameSync(legacyFile, quarantine)
      bumpChatMetric('migrations')
      console.log(`[bridge] migrated ${migratedCount} chat lines to per-room storage`)
    } catch {
      /* keep legacy file if quarantine fails */
    }
  }
}
