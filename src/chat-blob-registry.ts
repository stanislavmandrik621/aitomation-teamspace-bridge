/**
 * Chat-registered blob digests with room ACL + quota accounting (SEC-CHAT-05).
 * Bytes live under chat/blobs/<sha>; metadata in chat/blob-registry.json.
 */

import {
  createHash,
  randomBytes,
} from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { capStr } from './text-cap.js'
import type { AtRestKey } from './at-rest.js'
import { encryptJsonFile, decryptJsonFile, encryptBlobBody, decryptBlobBody } from './at-rest.js'
import { resolveChatDiskQuotas, chatQuotaRefusal } from './chat-disk-quota.js'
import { bumpChatMetric } from './chat-metrics.js'
import {
  evaluateChatAttachment,
  sanitizeChatAttachmentName,
  runChatAttachmentScan,
} from './chat-dangerous-type.js'
import { CHAT_ATTACH_MAX_BYTES_CEILING, CHAT_ROOM_MAX_LEN, parseChatRoomId } from './chat-room.js'
import { parseAnyEphemeralRoomId } from './ephemeral-chat.js'

const CHAT_BLOB_UPLOADER_MAX = 128
const CHAT_BLOB_MIME_MAX = 120
const CHAT_BLOB_SHA_RE = /^[a-f0-9]{64}$/

/**
 * TS-CHAT-143: how stale the saved "last referenced" stamp may get before a
 * fresh reference rewrites the registry file.
 *
 * The stamp only exists to keep the cleanup sweep from deleting a file
 * somebody just used, and that sweep works in days, so an hour of slack
 * costs nothing. Writing the whole registry on every duplicate upload
 * would rewrite up to 100,000 rows on a hot path, which is the kind of
 * cost BRG-069 warns about. The in-memory stamp is always current, so the
 * running sweep is exact either way - this only bounds how much freshness
 * a restart can lose.
 */
const CHAT_BLOB_LAST_REF_PERSIST_MS = 60 * 60 * 1000

/** Uploader / member ids: NUL-strip, trim, then surrogate-safe cap (TS-CHAT-032). */
function capChatBlobScopeId(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return capStr(raw.replace(/\0/g, '').trim(), max)
}

/**
 * Room ACL key. A 160-unit cut (legacy leftover of the raw slice) truncated a
 * legal `chat:dm:` pair (`CHAT_ROOM_MAX_LEN` = 280) into a different room id
 * so upload ACL and later GET disagreed. Prove after the cap; refuse junk.
 */
export function capChatBlobRoomId(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = capStr(raw.replace(/\0/g, '').trim(), CHAT_ROOM_MAX_LEN)
  if (!cleaned) return ''
  const chat = parseChatRoomId(cleaned)
  if (chat.ok) return chat.room
  const eph = parseAnyEphemeralRoomId(cleaned)
  return eph.ok ? eph.room : ''
}

/** Content-addressed blob id: full 64-hex only (TS-CHAT-103). Never a path segment. */
function chatBlobSha(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const id = raw.replace(/\0/g, '').trim().toLowerCase()
  return CHAT_BLOB_SHA_RE.test(id) ? id : ''
}

export type ChatBlobRow = {
  sha256: string
  /** First room that registered this content-addressed blob. */
  roomId: string
  /**
   * TCC-R1146-MEDIA-003: additional rooms granted access to the same sha
   * (forward / re-upload) without duplicating bytes on disk.
   */
  roomIds?: string[]
  name: string
  bytes: number
  mime: string
  uploadedBy: string
  createdAt: number
  /**
   * TS-CHAT-143: when this content was last attached to something new.
   *
   * `createdAt` is stamped once, by the very first upload of these bytes,
   * and never moves again - a later upload of the same file is answered
   * from the row that is already here. So a file first shared a year ago,
   * whose only message was since removed, is re-shared today with a stamp
   * that still reads a year old, and the cleanup sweep's "old and unused"
   * test deletes the bytes out from under the message being written. This
   * records the newest reference so that test asks the right question.
   */
  lastRefAt?: number
  /** Optional thumb sha under chat/blobs/thumbs/ */
  thumbSha?: string | null
}

/** Newest of first-upload / last-reference. Used by the cleanup age gate. */
export function chatBlobLastRefAt(row: ChatBlobRow): number {
  const created =
    typeof row.createdAt === 'number' && Number.isFinite(row.createdAt) ? row.createdAt : 0
  const refreshed =
    typeof row.lastRefAt === 'number' && Number.isFinite(row.lastRefAt) ? row.lastRefAt : 0
  return Math.max(created, refreshed)
}

/** Rooms that may read this blob (primary + granted). */
export function chatBlobRoomIds(row: ChatBlobRow): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (r: string) => {
    const id = capChatBlobRoomId(r)
    if (!id || seen.has(id)) return
    seen.add(id)
    out.push(id)
  }
  push(row.roomId)
  if (Array.isArray(row.roomIds)) {
    for (const r of row.roomIds.slice(0, 64)) push(r)
  }
  return out
}

type RegistryFile = { version: 1; blobs: ChatBlobRow[] }

export class ChatBlobRegistry {
  private readonly dir: string
  private readonly blobsDir: string
  private readonly thumbsDir: string
  private readonly path: string
  private bySha = new Map<string, ChatBlobRow>()
  private writeChain: Promise<void> = Promise.resolve()
  /** TCC-R1148-MEDIA-002: serialize registerUpload check-then-act (not persist). */
  private uploadChain: Promise<void> = Promise.resolve()
  /**
   * BRG-069: O(1) running total of registered blob bytes - the chat
   * attachment twin of CrmBlobDiskTotal (crm-blob-disk.ts), which already
   * fixed the same class of bug for CRM blobs. `totalBlobBytes()` used to
   * sum every row in `bySha` on EVERY call - a full Map scan on every
   * single attachment upload's quota check (registerUpload, hot path) AND
   * on every Admin chat_metrics poll (chat_metrics / chat_config_get,
   * server.ts), and `bySha` grows with every distinct attachment ever
   * uploaded for the team's lifetime (soft-capped at load() to 100_000
   * rows) - exactly the "in-memory collection that could itself grow
   * unbounded" BRG-069 warns about. Kept in lockstep with every
   * insert/delete of a bySha row: load() sums while it populates the map,
   * registerUpload adds only for a genuinely NEW row (the dedup/raced
   * paths reuse existing bytes, so they must not double-count), and gc()'s
   * two deletion loops (file-gone rows, aged-unreferenced rows) subtract
   * before deleting.
   */
  private totalBytesTracked = 0

  constructor(
    dataDir: string,
    private atRest: AtRestKey | null,
  ) {
    this.dir = join(dataDir, 'chat')
    this.blobsDir = join(this.dir, 'blobs')
    this.thumbsDir = join(this.blobsDir, 'thumbs')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    if (!existsSync(this.blobsDir)) mkdirSync(this.blobsDir, { recursive: true })
    if (!existsSync(this.thumbsDir)) mkdirSync(this.thumbsDir, { recursive: true })
    this.path = join(this.dir, 'blob-registry.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = this.atRest
        ? decryptJsonFile(this.atRest, raw, { version: 1, blobs: [] } as RegistryFile)
        : (JSON.parse(raw) as RegistryFile)
      if (!parsed || !Array.isArray(parsed.blobs)) return
      for (const row of parsed.blobs.slice(0, 100_000)) {
        if (!row || typeof row.sha256 !== 'string') continue
        const sha256 = chatBlobSha(row.sha256)
        if (!sha256) continue
        const roomId = capChatBlobRoomId(row.roomId)
        if (!roomId) continue
        const roomIds = Array.isArray(row.roomIds)
          ? row.roomIds
              .map((r) => capChatBlobRoomId(r))
              .filter((r) => r && r !== roomId)
              .slice(0, 64)
          : undefined
        const thumbSha = chatBlobSha(row.thumbSha)
        const bytes = typeof row.bytes === 'number' && Number.isFinite(row.bytes) ? Math.max(0, row.bytes) : 0
        this.bySha.set(sha256, {
          sha256,
          roomId,
          ...(roomIds && roomIds.length > 0 ? { roomIds } : {}),
          name: typeof row.name === 'string' ? sanitizeChatAttachmentName(row.name) : 'file',
          bytes,
          mime: typeof row.mime === 'string'
            ? capStr(row.mime.replace(/\0/g, ''), CHAT_BLOB_MIME_MAX) || 'application/octet-stream'
            : 'application/octet-stream',
          uploadedBy: capChatBlobScopeId(row.uploadedBy, CHAT_BLOB_UPLOADER_MAX),
          createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
          // TS-CHAT-143: rows written before this field existed simply have
          // no newer reference than their first upload.
          ...(typeof row.lastRefAt === 'number' && Number.isFinite(row.lastRefAt)
            ? { lastRefAt: row.lastRefAt }
            : {}),
          thumbSha: thumbSha || null,
        })
        this.totalBytesTracked += bytes
      }
    } catch {
      this.bySha.clear()
      this.totalBytesTracked = 0
    }
  }

  private persistSync(): void {
    const payload: RegistryFile = { version: 1, blobs: [...this.bySha.values()] }
    const body = this.atRest ? encryptJsonFile(this.atRest, payload) : JSON.stringify(payload)
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, this.path)
  }

  /**
   * TCC-R1132-BLOB-001: returns the awaitable persist attempt so callers that
   * must ACK only after durable write (registerUpload) can fail closed on a
   * disk error instead of resolving before the row is actually on disk. The
   * chain itself (`this.writeChain`) always swallows the failure so later
   * persists still run in order even after one attempt fails; only the
   * PER-CALL promise returned here propagates the rejection to its caller.
   */
  private queuePersist(): Promise<void> {
    const attempt = this.writeChain.then(() => this.persistSync())
    this.writeChain = attempt.catch(() => {})
    return attempt
  }

  totalBlobBytes(): number {
    // BRG-069: O(1) running total (see `totalBytesTracked` field doc) - never
    // re-sum `bySha` here, that is the exact regression this fixes.
    return Math.max(0, this.totalBytesTracked)
  }

  get(sha: string): ChatBlobRow | null {
    const id = chatBlobSha(sha)
    if (!id) return null
    return this.bySha.get(id) ?? null
  }

  /**
   * TS-CHAT-143: record that this content was just referenced by something
   * new, so the cleanup sweep does not treat it as unused.
   *
   * Called when a message is about to carry the attachment, which is the
   * window the sweep cannot see: the message is not on disk yet, so the
   * live-reference scan that feeds the sweep does not know about it. The
   * stamp is always updated in memory; the registry file is only rewritten
   * when the saved stamp has gone stale, so this stays cheap on a hot path.
   *
   * Returns false when there is no row for this content.
   */
  touchReference(sha: string, at?: number): boolean {
    const row = this.get(sha)
    if (!row) return false
    const now = typeof at === 'number' && Number.isFinite(at) ? at : Date.now()
    const prev = chatBlobLastRefAt(row)
    if (now <= prev) return true
    row.lastRefAt = now
    if (now - prev >= CHAT_BLOB_LAST_REF_PERSIST_MS) {
      this.queuePersist().catch(() => {})
    }
    return true
  }

  memberCanRead(sha: string, _memberId: string, canAccessRoom: (roomId: string) => boolean): boolean {
    const row = this.get(sha)
    if (!row) return false
    return chatBlobRoomIds(row).some((r) => canAccessRoom(r))
  }

  blobPath(sha: string): string {
    const id = chatBlobSha(sha)
    // Stay inside blobsDir even if a caller passes a leftover path-shaped id.
    return join(this.blobsDir, id || '_invalid-blob-sha')
  }

  /**
   * TCC-R1125-BRG-002: read + decrypt attachment bytes when at-rest is set.
   * Plaintext files (written before a key was configured, or with no key set)
   * pass through unchanged via `decryptBlobBody`'s magic-prefix sniff.
   */
  /**
   * TCC-R1148-MEDIA-004: missing file → null; decrypt/read failure throws so
   * HTTP GET can return unreadable vs not-found (no existence oracle collapse).
   */
  readBlobBytes(sha: string): Buffer | null {
    const path = this.blobPath(sha)
    if (!existsSync(path)) return null
    try {
      const onDisk = readFileSync(path)
      return decryptBlobBody(this.atRest, onDisk)
    } catch (err) {
      throw err instanceof Error ? err : new Error('Attachment unreadable')
    }
  }

  thumbPath(sha: string): string {
    const id = chatBlobSha(sha)
    return join(this.thumbsDir, id || '_invalid-blob-sha')
  }

  async registerUpload(input: {
    roomId: string
    uploadedBy: string
    filename: string
    bytes: Uint8Array
    maxBytes?: number
  }): Promise<ChatBlobRow | { error: string }> {
    const roomId = capChatBlobRoomId(input.roomId)
    const uploadedBy = capChatBlobScopeId(input.uploadedBy, CHAT_BLOB_UPLOADER_MAX)
    if (!roomId || !uploadedBy) return { error: 'room and uploader required' }
    const name = sanitizeChatAttachmentName(input.filename)
    const max = Math.min(
      typeof input.maxBytes === 'number' && input.maxBytes > 0
        ? input.maxBytes
        : CHAT_ATTACH_MAX_BYTES_CEILING,
      CHAT_ATTACH_MAX_BYTES_CEILING,
    )
    if (!input.bytes || input.bytes.length === 0) return { error: 'Empty file' }
    if (input.bytes.length > max) {
      return { error: `File is too large (max ${Math.floor(max / (1024 * 1024))} MB)` }
    }
    const verdict = evaluateChatAttachment(name, input.bytes)
    if (!verdict.ok) return { error: verdict.reason }
    // TCC-R1152-MEDIA-001 / TCC-R1153-MEDIA-004: hash BEFORE scan/quota so a
    // same-sha re-upload short-circuits without paying scan or counting quota.
    const sha = createHash('sha256').update(input.bytes).digest('hex')

    // TCC-R1148-MEDIA-002: serialize check-then-act on uploadChain (separate
    // from persist writeChain) so two concurrent first-uploads cannot both
    // pass the miss and double-write / race bySha.set.
    let result: ChatBlobRow | { error: string } = { error: 'Could not store attachment' }
    const gate = new Promise<void>((resolveGate) => {
      this.uploadChain = this.uploadChain.then(async () => {
        try {
          const existing = this.bySha.get(sha)
          if (existing) {
            let dirty = false
            // TS-CHAT-143: this upload is a brand new reference to bytes that
            // may be very old. Without this the cleanup sweep still reads the
            // first-ever upload time and can delete the file before the
            // message carrying it is written.
            const nowRef = Date.now()
            if (nowRef - chatBlobLastRefAt(existing) >= CHAT_BLOB_LAST_REF_PERSIST_MS) dirty = true
            existing.lastRefAt = nowRef
            // TCC-R1146-MEDIA-003: grant this room instead of refusing cross-room.
            if (!chatBlobRoomIds(existing).includes(roomId)) {
              const rooms = chatBlobRoomIds(existing)
              rooms.push(roomId)
              existing.roomIds = rooms.filter((r) => r !== existing.roomId).slice(0, 64)
              dirty = true
            }
            // TCC-R1150-MEDIA-003: refresh display name/mime from this upload.
            if (name && name !== existing.name) {
              existing.name = name
              dirty = true
            }
            if (verdict.mimeHint && verdict.mimeHint !== existing.mime) {
              existing.mime = verdict.mimeHint
              dirty = true
            }
            if (dirty) {
              try {
                await this.queuePersist()
              } catch {
                result = { error: 'Could not store attachment' }
                return
              }
            }
            result = existing
            return
          }

          const scan = await runChatAttachmentScan(input.bytes, name)
          if (!scan.ok) {
            result = { error: scan.reason }
            return
          }

          const quotas = resolveChatDiskQuotas()
          const nextBlobTotal = this.totalBlobBytes() + input.bytes.length
          if (nextBlobTotal > quotas.chatBlobsBytes) {
            bumpChatMetric('quotaRefusals')
            result = {
              error: chatQuotaRefusal('blobs', nextBlobTotal, quotas.chatBlobsBytes),
            }
            return
          }

          // Re-check after await scan (another waiter may have inserted).
          const raced = this.bySha.get(sha)
          if (raced) {
            // TS-CHAT-143: same fresh-reference stamp as the dedup path above.
            raced.lastRefAt = Date.now()
            if (!chatBlobRoomIds(raced).includes(roomId)) {
              const rooms = chatBlobRoomIds(raced)
              rooms.push(roomId)
              raced.roomIds = rooms.filter((r) => r !== raced.roomId).slice(0, 64)
              try { await this.queuePersist() } catch { /* keep returning raced */ }
            }
            result = raced
            return
          }

          const dest = this.blobPath(sha)
          const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.part`
          try {
            // TCC-R1125-BRG-002: encrypt attachment bytes at rest.
            const onDisk = this.atRest
              ? encryptBlobBody(this.atRest, Buffer.from(input.bytes))
              : input.bytes
            writeFileSync(tmp, onDisk)
            renameSync(tmp, dest)
          } catch {
            try { unlinkSync(tmp) } catch { /* */ }
            result = { error: 'Could not store attachment' }
            return
          }

          const row: ChatBlobRow = {
            sha256: sha,
            roomId,
            name,
            bytes: input.bytes.length,
            mime: verdict.mimeHint,
            uploadedBy,
            createdAt: Date.now(),
            lastRefAt: Date.now(),
            thumbSha: null,
          }
          this.bySha.set(sha, row)
          this.totalBytesTracked += row.bytes
          try {
            // TCC-R1132-BLOB-001: must not ACK until registry row is durable.
            await this.queuePersist()
          } catch {
            this.bySha.delete(sha)
            this.totalBytesTracked -= row.bytes
            try { unlinkSync(dest) } catch { /* */ }
            result = { error: 'Could not store attachment' }
            return
          }
          result = row
        } finally {
          resolveGate()
        }
      }).catch(() => { resolveGate() })
    })
    await gate
    return result
  }

  /**
   * Drop orphan blob/thumb files older than maxAgeMs with no registry row,
   * prune registry rows whose file is gone (TS-CHAT-014), and when `keepShas`
   * is provided delete aged registered blobs with zero live message refs
   * (TCC-R1144-MEDIA-002 - same keep-set pattern as chat avatar GC).
   */
  gc(
    keepShasOrMaxAge?: ReadonlySet<string> | null | number,
    maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  ): { removedFiles: number; removedRows: number } {
    let removedFiles = 0
    let removedRows = 0
    const now = Date.now()
    // Compat: legacy `gc(maxAgeMs)` callers pass a number as the first arg.
    let keepShas: ReadonlySet<string> | null | undefined
    let ageArg = maxAgeMs
    if (typeof keepShasOrMaxAge === 'number') {
      ageArg = keepShasOrMaxAge
      keepShas = undefined
    } else {
      keepShas = keepShasOrMaxAge
    }
    const ageMs = Number.isFinite(ageArg) && ageArg >= 0 ? ageArg : 7 * 24 * 60 * 60 * 1000
    // Drop registry rows whose file is gone
    for (const [sha, row] of [...this.bySha.entries()]) {
      if (!existsSync(this.blobPath(sha))) {
        this.bySha.delete(sha)
        this.totalBytesTracked -= row.bytes
        removedRows += 1
      }
    }
    // TCC-R1144-MEDIA-002: age-delete registered blobs not referenced by any
    // kept message line. Young unreferenced rows stay (mid-upload / not-yet
    // appended) - same age gate as avatar orphan GC.
    if (keepShas) {
      const keep = new Set<string>()
      for (const raw of keepShas) {
        const id = chatBlobSha(raw)
        if (id) keep.add(id)
      }
      for (const [sha, row] of [...this.bySha.entries()]) {
        if (keep.has(sha)) continue
        // TS-CHAT-143: age from the newest reference, not the first upload.
        // The keep set is built by scanning what is already saved, so a file
        // attached to a message still being written is not in it - and a
        // re-share of an old file carries an old first-upload time. Reading
        // only that time deleted the bytes out from under the new message.
        const created = chatBlobLastRefAt(row)
        if (now - created < ageMs) continue
        this.bySha.delete(sha)
        this.totalBytesTracked -= row.bytes
        removedRows += 1
        try {
          unlinkSync(this.blobPath(sha))
          removedFiles += 1
        } catch { /* */ }
        const thumb = chatBlobSha(row.thumbSha)
        if (thumb) {
          try {
            unlinkSync(this.thumbPath(thumb))
            removedFiles += 1
          } catch { /* */ }
        }
      }
    }
    // Orphan files in blobs/ (not thumbs/)
    try {
      for (const name of readdirSync(this.blobsDir)) {
        if (name === 'thumbs' || !/^[a-f0-9]{64}$/.test(name)) continue
        if (this.bySha.has(name)) continue
        const p = join(this.blobsDir, name)
        try {
          const st = statSync(p)
          if (now - st.mtimeMs > ageMs) {
            unlinkSync(p)
            removedFiles += 1
          }
        } catch { /* */ }
      }
    } catch { /* */ }
    // Orphan thumbs: keep only files named for a live blob sha (or its thumbSha)
    const keepThumbs = new Set<string>()
    for (const row of this.bySha.values()) {
      keepThumbs.add(row.sha256)
      const liveThumb = chatBlobSha(row.thumbSha)
      if (liveThumb) keepThumbs.add(liveThumb)
    }
    try {
      for (const name of readdirSync(this.thumbsDir)) {
        if (!/^[a-f0-9]{64}$/.test(name)) continue
        if (keepThumbs.has(name)) continue
        const p = join(this.thumbsDir, name)
        try {
          const st = statSync(p)
          if (now - st.mtimeMs > ageMs) {
            unlinkSync(p)
            removedFiles += 1
          }
        } catch { /* */ }
      }
    } catch { /* */ }
    // gc() is a fire-and-forget maintenance sweep (no client is waiting on an
    // ACK here), so we don't await the persist - but we must still catch it
    // to avoid an unhandled promise rejection if the write fails.
    if (removedRows > 0) this.queuePersist().catch(() => {})
    return { removedFiles, removedRows }
  }
}
