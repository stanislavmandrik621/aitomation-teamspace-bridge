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
import type { AtRestKey } from './at-rest.js'
import { encryptJsonFile, decryptJsonFile, encryptBlobBody, decryptBlobBody } from './at-rest.js'
import { resolveChatDiskQuotas, chatQuotaRefusal } from './chat-disk-quota.js'
import { bumpChatMetric } from './chat-metrics.js'
import {
  evaluateChatAttachment,
  sanitizeChatAttachmentName,
  runChatAttachmentScan,
} from './chat-dangerous-type.js'
import { CHAT_ATTACH_MAX_BYTES_CEILING } from './chat-room.js'

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
  /** Optional thumb sha under chat/blobs/thumbs/ */
  thumbSha?: string | null
}

/** Rooms that may read this blob (primary + granted). */
export function chatBlobRoomIds(row: ChatBlobRow): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (r: string) => {
    const id = String(r || '').trim().slice(0, 160)
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
        const roomId = typeof row.roomId === 'string' ? row.roomId.slice(0, 160) : ''
        const roomIds = Array.isArray(row.roomIds)
          ? row.roomIds
              .filter((r): r is string => typeof r === 'string')
              .map((r) => r.slice(0, 160))
              .filter((r) => r && r !== roomId)
              .slice(0, 64)
          : undefined
        this.bySha.set(row.sha256.toLowerCase(), {
          sha256: row.sha256.toLowerCase(),
          roomId,
          ...(roomIds && roomIds.length > 0 ? { roomIds } : {}),
          name: typeof row.name === 'string' ? row.name.slice(0, 180) : 'file',
          bytes: typeof row.bytes === 'number' ? row.bytes : 0,
          mime: typeof row.mime === 'string' ? row.mime.slice(0, 120) : 'application/octet-stream',
          uploadedBy: typeof row.uploadedBy === 'string' ? row.uploadedBy.slice(0, 128) : '',
          createdAt: typeof row.createdAt === 'number' ? row.createdAt : Date.now(),
          thumbSha: typeof row.thumbSha === 'string' ? row.thumbSha : null,
        })
      }
    } catch {
      this.bySha.clear()
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
    let n = 0
    for (const row of this.bySha.values()) n += Math.max(0, row.bytes || 0)
    return n
  }

  get(sha: string): ChatBlobRow | null {
    const id = String(sha || '').toLowerCase().trim()
    if (!/^[a-f0-9]{64}$/.test(id)) return null
    return this.bySha.get(id) ?? null
  }

  memberCanRead(sha: string, _memberId: string, canAccessRoom: (roomId: string) => boolean): boolean {
    const row = this.get(sha)
    if (!row) return false
    return chatBlobRoomIds(row).some((r) => canAccessRoom(r))
  }

  blobPath(sha: string): string {
    return join(this.blobsDir, String(sha).toLowerCase())
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
    return join(this.thumbsDir, String(sha).toLowerCase())
  }

  async registerUpload(input: {
    roomId: string
    uploadedBy: string
    filename: string
    bytes: Uint8Array
    maxBytes?: number
  }): Promise<ChatBlobRow | { error: string }> {
    const roomId = String(input.roomId || '').trim().slice(0, 160)
    const uploadedBy = String(input.uploadedBy || '').trim().slice(0, 128)
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
            thumbSha: null,
          }
          this.bySha.set(sha, row)
          try {
            // TCC-R1132-BLOB-001: must not ACK until registry row is durable.
            await this.queuePersist()
          } catch {
            this.bySha.delete(sha)
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
    for (const [sha] of [...this.bySha.entries()]) {
      if (!existsSync(this.blobPath(sha))) {
        this.bySha.delete(sha)
        removedRows += 1
      }
    }
    // TCC-R1144-MEDIA-002: age-delete registered blobs not referenced by any
    // kept message line. Young unreferenced rows stay (mid-upload / not-yet
    // appended) - same age gate as avatar orphan GC.
    if (keepShas) {
      const keep = new Set<string>()
      for (const raw of keepShas) {
        const id = String(raw || '').toLowerCase().trim()
        if (/^[a-f0-9]{64}$/.test(id)) keep.add(id)
      }
      for (const [sha, row] of [...this.bySha.entries()]) {
        if (keep.has(sha)) continue
        const created = typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
          ? row.createdAt
          : 0
        if (now - created < ageMs) continue
        this.bySha.delete(sha)
        removedRows += 1
        try {
          unlinkSync(this.blobPath(sha))
          removedFiles += 1
        } catch { /* */ }
        const thumb =
          typeof row.thumbSha === 'string' && /^[a-f0-9]{64}$/i.test(row.thumbSha)
            ? row.thumbSha.toLowerCase()
            : null
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
      if (typeof row.thumbSha === 'string' && /^[a-f0-9]{64}$/.test(row.thumbSha)) {
        keepThumbs.add(row.thumbSha.toLowerCase())
      }
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
