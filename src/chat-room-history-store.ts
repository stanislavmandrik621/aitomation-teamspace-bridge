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
  unlinkSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
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
import { capTrim } from './text-cap.js'
import { safeChatRoomDirName } from './chat-room-path.js'
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
import { CHAT_ROOMS_LIST_MAX } from './chat-rooms-store.js'

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
 * TCC-R1125-CHAT-001 / G11 residual twin: bound for the cross-room disk
 * fallback scan when `findById` misses the in-memory cache and has no
 * (or a wrong) room hint. This used to be a hardcoded 2_000, so raising
 * TEAMSPACE_CHAT_ROOMS_TOTAL_MAX (env ceiling 20_000) minted rooms whose
 * history the no-hint walk then skipped. Stay at CHAT_ROOMS_LIST_MAX so
 * create cannot mint a room this fallback cannot see. Still a hard cap
 * against an unbounded directory walk (closed leftover dirs included).
 */
const MAX_ROOMS_SCAN_FOR_FIND_BY_ID = CHAT_ROOMS_LIST_MAX
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
/**
 * `recentById` is a SINGLE cache shared across every room on the server -
 * this bound protects total memory, not any one room's fair share of it.
 * Eviction is genuine LRU (see `touchRecent`/`remember`), not insertion
 * order, so a hot row stays cached as long as anything keeps reading or
 * writing it, regardless of how many other rooms are also active.
 */
export const CHAT_RECENT_CACHE_MAX = 5000

type IndexCacheEntry = {
  index: SearchIndex
  dirty: boolean
  flushTimer: ReturnType<typeof setTimeout> | null
}

function mintChatId(): string {
  return `c_${randomBytes(12).toString('base64url')}`
}

/**
 * Latin tokens stay length>=2. CJK / Hangul / Kana / fullwidth runs are
 * real words at 1 char, so they must not be treated as separators
 * (`[^a-z0-9_]+` used to drop them and search then either missed or only
 * scanned the newest 100 rows).
 */
const CJK_SEARCH_RUN = /[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]+/g

function tokenizeForSearch(body: string): string[] {
  const lower = body.toLowerCase()
  const parts = lower.split(/[^a-z0-9_]+/i).filter((w) => w.length >= 2)
  const cjk: string[] = []
  CJK_SEARCH_RUN.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CJK_SEARCH_RUN.exec(lower)) !== null) {
    const run = m[0]
    if (run.length === 1) {
      cjk.push(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      cjk.push(run.slice(i, i + 2))
    }
  }
  return [...new Set([...parts, ...cjk])].slice(0, MAX_TERMS_PER_MESSAGE)
}

/** TS-CHAT-028: createdAt then append-order seq. Never id.localeCompare. */
function compareByCreatedAtThenSeq(
  a: { id: string; createdAt?: number },
  b: { id: string; createdAt?: number },
  seqById: Map<string, number>,
): number {
  const dt = (a.createdAt ?? 0) - (b.createdAt ?? 0)
  if (dt !== 0) return dt
  const sa = seqById.get(a.id)
  const sb = seqById.get(b.id)
  if (sa != null && sb != null) return sa - sb
  if (sa != null) return 1
  if (sb != null) return -1
  return 0
}

/**
 * Exclusive (createdAt, seq) cursor. When the cursor's seq is unknown
 * (id aged out of the tail window), same-millisecond rows are excluded
 * rather than ordered by random ids.
 */
function isBeforeCreatedAtSeqCursor(
  createdAt: number,
  id: string,
  beforeAt: number,
  beforeMsgId: string,
  beforeSeq: number | undefined,
  seqById: Map<string, number>,
): boolean {
  if (createdAt < beforeAt) return true
  if (createdAt > beforeAt) return false
  if (!beforeMsgId) return false
  if (beforeSeq == null) return false
  const ms = seqById.get(id)
  if (ms == null) return false
  return ms < beforeSeq
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

/**
 * Index-cache key is the room folder name, never the raw path string.
 * `chatRoomDir` slash-concats (`dataDir/chat/rooms/team`) while prune
 * uses `join` (`dataDir\\chat\\rooms\\team` on Windows). Those two
 * strings are not equal, so a prune rebuild and a later append used
 * two cache slots for one room and the stale slash-concat flush could
 * overwrite the rebuilt search index. Basename matches both spellings.
 */
function roomDirIndexKey(roomDir: string): string {
  const raw = String(roomDir || '').replace(/\0/g, '')
  if (!raw) return ''
  const parts = raw.split(/[/\\]+/).filter((p) => p.length > 0)
  const last = parts[parts.length - 1] || ''
  if (!last || last === '.' || last === '..') return ''
  return last
}

function looksEncryptedJsonFile(parsed: unknown): boolean {
  return Boolean(
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as { v?: unknown }).v === 1
    && typeof (parsed as { ciphertext?: unknown }).ciphertext === 'string',
  )
}

const PIN_META_UNREADABLE =
  'Chat pins could not be loaded. Check the room file on the team server.'

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
  /** BRG-074: last time an unreadable-line warning was printed (throttle). */
  private unreadableWarnedAt = 0

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

  /**
   * True LRU touch for `recentById`, same fix as `getIndexEntry`'s
   * insert-order-vs-access-order gap: `Map.set()` on an EXISTING key does
   * NOT move it in iteration order, only a brand-new key is appended at
   * the end. Without deleting then re-inserting on every touch, a message
   * that is read/edited/reacted/pinned repeatedly (a genuinely hot row)
   * still sits at its ORIGINAL insert position and is evicted exactly as
   * if nothing ever touched it again the instant 5,000 other ids have
   * been seen since - the same "hot entry starved out by a flood of
   * merely-newer ones" fairness bug this file's `recentById` docstring
   * already claims is fixed, across every room sharing this one cache.
   */
  private touchRecent(id: string): ChatMessageRow | undefined {
    const row = this.recentById.get(id)
    if (row !== undefined) {
      this.recentById.delete(id)
      this.recentById.set(id, row)
    }
    return row
  }

  private remember(row: ChatMessageRow): void {
    if (this.recentById.has(row.id)) this.recentById.delete(row.id)
    this.recentById.set(row.id, row)
    if (this.recentById.size > CHAT_RECENT_CACHE_MAX) {
      const first = this.recentById.keys().next().value
      if (typeof first === 'string') this.recentById.delete(first)
    }
  }

  /** Cache-only lookup (no disk fallback) - used only for soft/best-effort checks. */
  private findByIdCached(id: string): ChatMessageRow | null {
    const key = String(id || '').replace(/\0/g, '').trim().slice(0, CHAT_MSG_ID_MAX)
    if (!key) return null
    return this.touchRecent(key) ?? null
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
    const cached = this.touchRecent(key)
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
        const dir = this.roomDirFor(parsedHint.room)
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

  /** Same spelling as prune (`join`), never slash-concat. */
  private roomsRoot(): string {
    return join(this.chatRoot, 'rooms')
  }

  private roomDirFor(roomId: string): string | null {
    const safe = safeChatRoomDirName(roomId)
    if (!safe) return null
    return join(this.roomsRoot(), safe)
  }

  private indexIoDir(key: string): string {
    return join(this.roomsRoot(), key)
  }

  private ensureRoomDir(roomId: string): string | { error: string } {
    const dir = this.roomDirFor(roomId)
    if (!dir) return { error: 'Invalid room id' }
    const roomsParent = this.roomsRoot()
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
        // `typeof x === 'object'` is also true for arrays in JS - a
        // corrupted/tampered index file with `"terms": [...]` would
        // otherwise be accepted as the terms map, and later string-keyed
        // writes (`index.terms[term] = list`) onto that array silently
        // produce a hybrid array/object whose `Object.keys().length` term
        // count (used for the MAX_SEARCH_TERMS ceiling) no longer agrees
        // with what search actually reads back. Reject arrays explicitly
        // and rebuild an empty (lazily re-populated) terms map instead.
        const terms =
          parsed.terms && typeof parsed.terms === 'object' && !Array.isArray(parsed.terms)
            ? parsed.terms
            : {}
        return {
          version: 1,
          offsets: parsed.offsets.slice(-INDEX_OFFSET_CAP),
          terms,
        }
      }
    } catch {
      /* rebuild lazily */
    }
    return { version: 1, offsets: [], terms: {} }
  }

  /**
   * Write `contents` to a pid-scoped temp file then atomically rename it
   * over `path`. On failure (disk full, permission, a room dir removed out
   * from under us) best-effort remove the orphaned temp file so a failed
   * write never leaves stray `.tmp` files on disk forever - re-throws so
   * every caller keeps its existing error handling / propagation.
   */
  private writeFileAtomic(path: string, contents: string): void {
    const tmp = `${path}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, contents, 'utf8')
      renameSync(tmp, path)
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* best-effort cleanup only */
      }
      throw err
    }
  }

  private saveIndex(roomDir: string, index: SearchIndex): void {
    const trimmed: SearchIndex = {
      version: 1,
      offsets: index.offsets.slice(-INDEX_OFFSET_CAP),
      terms: index.terms,
    }
    this.writeFileAtomic(indexPath(roomDir), JSON.stringify(trimmed))
  }

  /** Get (loading from disk lazily) the in-memory index cache entry for a room. */
  private getIndexEntry(roomDir: string): IndexCacheEntry {
    const key = roomDirIndexKey(roomDir)
    const ioDir = key ? this.indexIoDir(key) : roomDir
    const existing = key ? this.indexCache.get(key) : undefined
    if (existing) {
      // Enterprise-scale fairness: Map iteration order is INSERTION order,
      // not access order. Without this touch, eviction below is FIFO, not
      // LRU - a room that was appended to constantly (a genuinely hot room)
      // still sits at its original insert position and gets evicted the
      // instant a merely-newer room shows up, even though the newer room
      // may go idle immediately while the "evicted" room keeps being
      // touched. Re-inserting the key on every cache HIT (not just on
      // load) makes eviction target the room that has gone the longest
      // without any read/write, matching the `recentById` LRU intent this
      // file's docstrings already describe.
      this.indexCache.delete(key)
      this.indexCache.set(key, existing)
      return existing
    }
    const entry: IndexCacheEntry = {
      index: this.loadIndexFromDisk(ioDir),
      dirty: false,
      flushTimer: null,
    }
    if (key) {
      this.indexCache.set(key, entry)
      if (this.indexCache.size > INDEX_CACHE_MAX_ROOMS) {
        const oldestKey = this.indexCache.keys().next().value
        if (typeof oldestKey === 'string' && oldestKey !== key) {
          this.flushIndexEntry(oldestKey)
          this.indexCache.delete(oldestKey)
        }
      }
    }
    return entry
  }

  /** Synchronously persist a dirty in-memory index (eviction / prune / test hook). */
  private flushIndexEntry(roomDirOrKey: string): void {
    const key = roomDirIndexKey(roomDirOrKey)
    if (!key) return
    const entry = this.indexCache.get(key)
    if (!entry) return
    if (entry.flushTimer) {
      clearTimeout(entry.flushTimer)
      entry.flushTimer = null
    }
    if (entry.dirty) {
      try {
        this.saveIndex(this.indexIoDir(key), entry.index)
      } catch {
        /* best-effort; index rebuilds lazily from cache on next load */
      }
      entry.dirty = false
    }
  }

  /** Coalesce rapid writes to the same room into one debounced disk write. */
  private scheduleIndexFlush(roomDir: string, entry: IndexCacheEntry): void {
    const key = roomDirIndexKey(roomDir)
    if (!key) return
    const ioDir = this.indexIoDir(key)
    entry.dirty = true
    if (entry.flushTimer) return
    const timer = setTimeout(() => {
      entry.flushTimer = null
      if (entry.dirty) {
        try {
          this.saveIndex(ioDir, entry.index)
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
    // Fairness under flood: this id had NO prior offset entry (existingOff
    // < 0) exactly when this is the very first time it has ever been
    // indexed - a brand-new message can never have a stale term reference
    // anywhere in `index.terms`, since nothing has indexed it before. This
    // scrub used to run unconditionally on EVERY append, an O(distinct
    // terms in the room, up to MAX_SEARCH_TERMS=20,000) synchronous scan
    // on the single Node event loop for every new message any room sends -
    // one busy room's vocabulary size directly throttled every OTHER
    // room's traffic. Skipping it for genuinely-new ids is behaviorally
    // identical (there is nothing to scrub) and keeps the scan reserved
    // for the edit/react/pin/tomb re-append case it actually protects.
    if (existingOff >= 0) {
      for (const term of Object.keys(index.terms)) {
        const list = index.terms[term]
        if (!list || !list.includes(row.id)) continue
        if (nextTerms.has(term)) continue
        const filtered = list.filter((id) => id !== row.id)
        if (filtered.length === 0) delete index.terms[term]
        else index.terms[term] = filtered
      }
    }
    let termCount = Object.keys(index.terms).length
    for (const term of nextTerms) {
      let list = index.terms[term]
      if (!list) {
        if (termCount >= MAX_SEARCH_TERMS) continue
        list = []
        index.terms[term] = list
        termCount++
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
    this.repairTornMessagesTail(roomDir)
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
    // G11 / CJK: disk quota is UTF-8 bytes (statSync.size). JSON.stringify().length
    // is UTF-16 units and also misses at-rest ciphertext, so a CJK/emoji body
    // would pass the check then write ~3x more than claimed.
    const quota = this.checkQuotaBeforeWrite(Buffer.byteLength(line, 'utf8'))
    if ('error' in quota) return quota
    appendFileSync(path, line, 'utf8')
    try {
      this.updateIndexOnAppend(roomDir, row, offset)
    } catch (err) {
      // The search index is a rebuildable accelerator, never the source of
      // truth (see the INDEX_FLUSH_DEBOUNCE_MS comment above) - the line
      // above already durably persisted this message. A failure updating
      // the in-memory index must never make an already-saved message read
      // back to the caller as if it failed to send.
      console.warn(
        `[bridge] chat index update failed for ${roomDir} (message is saved): ${(err as Error)?.message || err}`,
      )
    }
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
    // TS-CHAT-135 (Wave 14 I3/box23 absorb): callers that mint their own
    // fanout side effects (chat_send's /task command trigger) need to know
    // whether this call actually wrote a new row or just replayed a
    // same-author retry, so they can skip re-firing those side effects too.
  }): Promise<(ChatMessageRow & { unchanged?: true }) | { error: string }> {
    const parsed = parseChatRoomId(input.room)
    if (!parsed.ok) return { error: parsed.reason }
    const body = scrubChatBody(input.body)
    if (!body) return { error: 'Message is empty or too long' }
    const memberId = String(input.memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!memberId) return { error: 'memberId required' }
    const memberName = capTrim(String(input.memberName || 'Member').replace(/\0/g, ''), 120) || 'Member'
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
        // TS-CHAT-135: same-author retry of a live id - the row already
        // exists on disk and was already fanned out to peers (and any
        // /task side effect already fired) the first time it was appended.
        // Stamp `unchanged` (same no-re-fanout contract as softDelete's
        // `{ unchanged: true, tomb }` and the pin/unpin/rename/ban idempotent
        // paths elsewhere in server.ts) so callers can skip re-broadcasting
        // and re-triggering side effects while still replying success with
        // the real row - never invent a duplicate write or a duplicate
        // network fanout for an id the client is only retrying because its
        // own prior ack was lost (crash/reconnect), not because anything new
        // happened.
        return { ...existing, unchanged: true as const }
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
    const e = capTrim(String(emoji || '').replace(/\0/g, ''), 32)
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
    return this.queueRoomWrite(parsed.room, async () => {
      // TS-CHAT-023 / TCC-R1133-CHAT-001: re-check inside the queue so a
      // softDelete that ran first cannot re-pin a tomb onto the banner.
      if (mode === 'pin' && targetId) {
        const live = this.findByIdCached(targetId) ?? (await this.findById(targetId, parsed.room))
        if (!live || live.room !== parsed.room) {
          return { error: 'Message not found in this room' }
        }
        if (typeof live.deletedAt === 'number' && live.deletedAt > 0) {
          return { error: 'Message was removed' }
        }
      }
      const roomDir = this.ensureRoomDir(parsed.room)
      if (typeof roomDir !== 'string') return roomDir
      const currentRead = this.readPinMeta(roomDir)
      if ('error' in currentRead) return currentRead
      const current = currentRead.ids
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
          // The pin LIST above (writePinMeta) is the source of truth for
          // getPinnedMessageIds - this row-level `pinned: true` stamp is a
          // denormalized display hint only. Only remember it in-memory if
          // the disk write actually succeeded (e.g. not refused by a quota
          // check) - unconditionally remembering on failure would leave
          // the shared cache showing `pinned: true` for a row that was
          // never durably written that way, diverging from disk until a
          // fresh scan (or eviction) corrects it.
          const written = this.appendLineSync(roomDir, row)
          if (!('error' in written)) this.remember(row)
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
    this.writeFileAtomic(metaPath(roomDir), JSON.stringify(buildChatRoomPinMeta(ids)))
  }

  /**
   * Pin list is the source of truth for the room banner. Corrupt JSON or an
   * encrypted envelope (no decrypt path on this file) must not read as
   * "nothing pinned" and then persist over the file.
   */
  private readPinMeta(roomDir: string): { ok: true; ids: string[] } | { error: string } {
    const path = metaPath(roomDir)
    if (!existsSync(path)) return { ok: true, ids: [] }
    try {
      const raw = readFileSync(path, 'utf8')
      if (!raw.trim()) return { error: PIN_META_UNREADABLE }
      const parsed: unknown = JSON.parse(raw)
      if (looksEncryptedJsonFile(parsed)) return { error: PIN_META_UNREADABLE }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { error: PIN_META_UNREADABLE }
      }
      return { ok: true, ids: readChatRoomPinIds(parsed) }
    } catch {
      return { error: PIN_META_UNREADABLE }
    }
  }

  /**
   * Every pinned message in the room, in pin order (oldest first).
   * A room whose meta still holds the legacy single `pinnedMessageId` reads
   * back as a one-entry list, so an existing pin is never lost.
   * Unreadable meta returns [] for display; writers must call `readPinMeta`.
   */
  getPinnedMessageIds(roomId: string): string[] {
    const dir = this.roomDirFor(roomId)
    if (!dir) return []
    const read = this.readPinMeta(dir)
    return 'ok' in read ? read.ids : []
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
    // Write dest is the row's own room only. A missing/invalid room plus a
    // caller hint used to plant a tomb in the hinted room (hint is lookup
    // only, never a write target).
    const parsedRoom = parseChatRoomId(typeof prevPeek.room === 'string' ? prevPeek.room : '')
    if (!parsedRoom.ok) return { error: 'Message not found' }
    const room = parsedRoom.room
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
      const pins = this.readPinMeta(roomDir)
      if (!('error' in pins)) {
        const dropped = removeChatRoomPin(pins.ids, id)
        if ('ok' in dropped && dropped.changed) this.writePinMeta(roomDir, dropped.ids)
      }
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
    // One history page is a page, never a total. Walk with beforeId until
    // the window is exhausted, the 8 MiB reply budget is hit, or the caller
    // cancels. A page-count guard (MAX_EXPORT_PAGES) silently hid older
    // messages behind truncated:true after ~900 rows (TS-SHR-026 class).
    const res = await this.readRecent(parsed.room, CHAT_HISTORY_LIMIT_MAX, undefined)
    const all: ChatMessageRow[] = [...res.messages]
    let truncated = res.truncated
    while (truncated && all.length > 0) {
      if (opts?.signal?.aborted) return { error: 'Export cancelled' }
      // Rough estimate: average ~200 bytes/msg JSON before stringify.
      if (all.length * 200 > maxBody) {
        truncated = true
        break
      }
      const oldest = all[0]
      const more = await this.readRecent(parsed.room, CHAT_HISTORY_LIMIT_MAX, oldest.createdAt, oldest.id)
      if (more.messages.length === 0) {
        // TCC-R1154-CHAT-009: empty before-page must NOT clear truncated when
        // the underlying scan still hit the tail-window cap (scanTruncated).
        truncated = more.truncated === true
        break
      }
      const ids = new Set(all.map((m) => m.id))
      let added = 0
      for (const m of more.messages) {
        if (!ids.has(m.id)) {
          all.unshift(m)
          added += 1
        }
      }
      if (added === 0) {
        truncated = more.truncated === true || truncated
        break
      }
      truncated = more.truncated
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
      let body = lines.join('\n')
      // WS reply cap is UTF-8 bytes. CJK/emoji is 3-4x `.length`, so a
      // 200-bytes/msg estimate can mint a frame past 8 MiB.
      while (lines.length > 1 && Buffer.byteLength(body, 'utf8') > maxBody) {
        lines.shift()
        truncated = true
        body = lines.join('\n')
      }
      if (Buffer.byteLength(body, 'utf8') > maxBody) {
        return { error: 'Export too large' }
      }
      return { body, truncated }
    }
    let payload = { room: parsed.room, truncated, messages: safe }
    let body = JSON.stringify(payload, null, 2)
    while (safe.length > 1 && Buffer.byteLength(body, 'utf8') > maxBody) {
      safe.shift()
      truncated = true
      payload = { room: parsed.room, truncated: true, messages: safe }
      body = JSON.stringify(payload, null, 2)
    }
    if (Buffer.byteLength(body, 'utf8') > maxBody) {
      return { error: 'Export too large' }
    }
    return { body, truncated }
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
    const dir = this.roomDirFor(parsed.room)
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
    list.sort((a, b) => compareByCreatedAtThenSeq(a, b, seqById))
    if (beforeAt != null) {
      // TCC-R1147-CHAT-005 / TCC-FIX-CHAT-A9: exclusive (createdAt, seq)
      // cursor - rows at the same timestamp as `before` but sent earlier
      // (lower seq) stay pageable, matching the sort tiebreak above so a
      // page boundary landing inside a same-millisecond burst never skips or
      // duplicates a row. Unknown cursor seq excludes same-ms rows (never
      // id.localeCompare).
      const beforeSeq = beforeMsgId ? seqById.get(beforeMsgId) : undefined
      list = list.filter((m) =>
        isBeforeCreatedAtSeqCursor(m.createdAt ?? 0, m.id, beforeAt, beforeMsgId, beforeSeq, seqById),
      )
    }
    // TCC-R1126-CHAT-001: honor BOTH truncation sources - the caller's page
    // size cap (list.length > lim) and the tail-scan window cap
    // (scanTruncated) - either one means the caller is not seeing the full
    // room, so `truncated` must stay true even when the requested page
    // itself fit under `lim`.
    const truncated = list.length > lim || scanTruncated
    const page = list.slice(-lim)
    // Warm the shared cache with only the bounded page actually returned
    // (<= CHAT_HISTORY_LIMIT_MAX), never the whole tail window scanned to
    // build it - see the comment in `scanRoomFile` for why.
    for (const row of page) this.remember(row)
    return { messages: page, truncated }
  }

  /**
   * CJK / index-miss fallback: one tail-window scan (same as history), not
   * a newest-100 page that silently hides older matches.
   */
  private async searchRoomByIncludes(
    room: string,
    q: string,
    limit: number,
  ): Promise<{ messageIds: string[]; truncated: boolean }> {
    const lim = Math.min(100, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 30))
    const dir = this.roomDirFor(room)
    if (!dir) return { messageIds: [], truncated: false }
    const path = messagesPath(dir)
    if (!existsSync(path)) return { messageIds: [], truncated: false }
    const { byId, seqById, scanTruncated } = await this.scanRoomFile(path, room)
    const rows = [...byId.values()]
      .filter((m) => !(typeof m.deletedAt === 'number' && m.deletedAt > 0))
      .filter((m) => String(m.body || '').toLowerCase().includes(q))
    rows.sort((a, b) => compareByCreatedAtThenSeq(a, b, seqById))
    const reversed = rows.slice().reverse()
    const page = reversed.slice(0, lim)
    // Same bounded-warm rule as readRecent: remember only the matches
    // actually returned (<= 100), never every row scanned in the tail
    // window while looking for them.
    for (const row of page) this.remember(row)
    return {
      messageIds: page.map((m) => m.id),
      truncated: reversed.length > lim || scanTruncated,
    }
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
    const dir = this.roomDirFor(parsed.room)
    if (!dir) return { messageIds: [], truncated: false }
    const index = this.getIndexEntry(dir).index
    const terms = tokenizeForSearch(q).slice(0, 8)
    const sets = terms.map((t) => new Set(index.terms[t] || []))
    // Empty index hit (CJK on a pre-fix index, or a term the Latin splitter
    // never stored) must scan the same tail window history uses - never
    // newest-100 only, and never return [] as "no matches".
    if (terms.length === 0 || sets.some((s) => s.size === 0)) {
      return this.searchRoomByIncludes(parsed.room, q, limit)
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
    const dir = this.roomDirFor(parsed.room)
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
          // Enterprise-scale isolation: this method builds a FULL tail
          // window (up to MAX_TAIL_LINES_SCAN = 50,000 rows) every time any
          // caller reads or searches ONE room's history. `recentById` is a
          // single 5,000-entry cache SHARED across every room on the
          // server - unconditionally remembering every scanned row here
          // used to let one read/search of one large or busy room evict
          // the entire shared cache in a single call (up to 10x its
          // capacity in one pass), wiping every OTHER room's warm
          // edit/react/pin/delete lookups and forcing them onto the slower
          // disk-fallback path. `remember()` is a pure optimization (every
          // caller already has full disk fallback via `findById`), so
          // callers now warm the cache with only the bounded page/result
          // set they actually return to their own caller, never the whole
          // tail window scanned to build it.
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

    // A self-hosted operator's `rooms/` dir can become briefly unreadable
    // (permission change, concurrent project delete, a transient network
    // filesystem hiccup) between the `existsSync` check above and this
    // read. An unguarded `readdirSync` throwing here becomes an unhandled
    // promise rejection at the `void chatStore.prune().then(...)` call
    // site (no `.catch()` there) - on modern Node that can crash the
    // whole bridge process for every room on the server, not just the
    // one that hit the race, on every scheduled prune tick. Degrade to
    // "nothing pruned this cycle" instead; the next scheduled prune will
    // retry once the transient condition clears.
    let names: string[]
    try {
      names = readdirSync(roomsDir)
    } catch (err) {
      console.warn(
        `[bridge] chat prune: could not list rooms dir (will retry next cycle): ${(err as Error)?.message || err}`,
      )
      return 0
    }
    for (const name of names) {
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
        this.pruneRoomFile(path, msgCutoff, tombCutoff, roomDir),
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
   *
   * BRG-074: `complete` is false when any line or room file could not be
   * read. The caller must NOT hand an incomplete set to the attachment GC -
   * an empty keep-set is truthy there, so a wrong TEAMSPACE_AT_REST_KEY
   * would have read as "nothing is referenced any more" and deleted every
   * registered attachment past the age gate.
   */
  async collectLiveBlobShas(): Promise<{ shas: Set<string>; complete: boolean }> {
    const keep = new Set<string>()
    let complete = true
    const roomsDir = join(this.chatRoot, 'rooms')
    if (!existsSync(roomsDir)) return { shas: keep, complete }
    // Same race as `prune()`: `rooms/` can vanish/become unreadable between
    // the `existsSync` check and this read. Fold into the existing
    // `complete: false` honesty contract (BRG-074) instead of throwing -
    // the caller already treats an incomplete set as "skip the GC this
    // cycle", which is exactly the safe degrade here too.
    let names: string[]
    try {
      names = readdirSync(roomsDir)
    } catch {
      return { shas: keep, complete: false }
    }
    for (const name of names) {
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
            complete = false
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
        // Unreadable room file - its attachments are unaccounted for.
        complete = false
      }
    }
    return { shas: keep, complete }
  }

  /**
   * BRG-074: say it out loud when history cannot be read. Every room hits
   * this in the same sweep when the key is wrong, so the message is throttled
   * to one per 10 minutes rather than one per room.
   */
  private warnUnreadableChatLines(path: string, count: number): void {
    const now = Date.now()
    if (now - this.unreadableWarnedAt < 10 * 60 * 1000) return
    this.unreadableWarnedAt = now
    console.warn(
      `[bridge] ${count} chat line(s) in ${basename(dirname(path))} could not be read`
      + ' - they were kept on disk untouched. Check TEAMSPACE_AT_REST_KEY.',
    )
  }

  private async pruneRoomFile(
    path: string,
    msgCutoff: number,
    tombCutoff: number,
    roomDir: string,
  ): Promise<number> {
    let removed = 0
    let unreadable = 0
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
        // BRG-074: a line this process cannot READ is not a line it may
        // DELETE. `decryptOpsLine` throws for every encrypted row when
        // TEAMSPACE_AT_REST_KEY is missing or wrong, so folding the failure
        // into `removed` and rewriting from `kept` truncated the whole room
        // to zero bytes on the first hourly prune after a bad redeploy -
        // turning a recoverable key mistake into permanent loss. Carry the
        // bytes through verbatim instead: retention still applies to every
        // line this process can read, and the unreadable ones stay on disk
        // until the right key comes back. Same polarity members.json and
        // invites.json already keep (they quarantine rather than wipe).
        unreadable++
        kept.push(line)
        nextOffset += Buffer.byteLength(`${line}\n`, 'utf8')
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
    if (unreadable > 0) this.warnUnreadableChatLines(path, unreadable)
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
    renameSync(tmp, path)
    // TCC-R1153-CHAT-011: prune rewrites jsonl - rebuild search index (terms + offsets).
    try {
      if (roomDir) this.rebuildIndexAfterPrune(roomDir, keptRows)
    } catch { /* index rebuild best-effort */ }
    // TCC-R1153-CHAT-008: scrub LRU cache entries that aged out of disk so
    // edit/react/pin/delete cannot resurrect pruned rows from memory.
    if (removed > 0) {
      let roomIdForPin: string | null = null
      for (const [id, row] of this.recentById) {
        if (keptIds.has(id)) continue
        if (typeof row.room !== 'string') continue
        const rowDir = this.roomDirFor(row.room)
        if (rowDir && messagesPath(rowDir) === path) {
          roomIdForPin = row.room
          this.recentById.delete(id)
        }
      }
      // TCC-R1153-CHAT-010: drop pins whose message was pruned off disk.
      // Each pin is checked on its own, so pruning one aged-out message
      // never takes the room's other pins down with it.
      const pinDir = (roomIdForPin && this.roomDirFor(roomIdForPin)) || roomDir
      if (pinDir) {
        const pins = this.readPinMeta(pinDir)
        if (!('error' in pins)) {
          const kept = pruneChatRoomPins(pins.ids, (id) => keptIds.has(id))
          if (kept.changed) this.writePinMeta(pinDir, kept.ids)
        }
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
        // BRG-070 sibling of G2: repair in the same turn as this append so a
        // prior torn migration line cannot merge with the next row.
        this.repairTornMessagesTail(roomDir)
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
