/**
 * STORED (method 0) ZIP writer for P6 admin backup export.
 * Sealed .aimove archives are already compressed/encrypted - no deflate.
 * CRC32 is pure JS so Node 20 (bridge engines) stays supported - zlib.crc32 is Node 22+.
 */
import { createReadStream, constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { capStr } from './text-cap.js'
import { MAX_BACKUP_ZIP64_BYTES_WAVE94, addBackupZip64BytesWave94, measureBackupZip64Wave94 } from './backup-wave94-zip64.js'

/** Default sealed member .aimove files in one admin export.zip (Settings-raisable, see backup-store.ts TeamBackupMeta.maxZipAimoves). */
export const MAX_BACKUP_ZIP_AIMOVES = 40
/**
 * TCC-R1133-SET-005: defense-in-depth structural ceiling - `TeamBackupMeta.maxZipAimoves`
 * is admin-raisable via `PATCH /v1/backups/meta`, but must never exceed this
 * hard cap regardless of what an admin requests (bounds zip build time/memory
 * on the bridge process for one export request).
 */
export const MAX_BACKUP_ZIP_AIMOVES_HARD_CAP = 500
/**
 * Max live `chat/` files appended to the same zip (matches enumerateChatBackupFiles default).
 * Kept separate so the aimove cap cannot starve team chat (or the reverse).
 */
export const MAX_BACKUP_ZIP_CHAT_ENTRIES = 50_000
/** Combined ceiling for streamStoredBackupZip (aimoves + chat files) at the DEFAULT aimove cap. */
export const MAX_BACKUP_ZIP_ENTRIES = MAX_BACKUP_ZIP_AIMOVES + MAX_BACKUP_ZIP_CHAT_ENTRIES
/**
 * TCC-R1133-SET-005: combined ceiling using a live (possibly admin-raised)
 * aimove cap instead of the static default - callers that read
 * `TeamBackupMeta.maxZipAimoves` must use this instead of the module-load-time
 * `MAX_BACKUP_ZIP_ENTRIES` constant, or raising the admin setting would have
 * no effect on the combined check.
 */
export function combinedBackupZipEntryCeiling(maxAimoves: number): number {
  const aimoves = Number.isFinite(maxAimoves) && maxAimoves > 0
    ? Math.min(Math.floor(maxAimoves), MAX_BACKUP_ZIP_AIMOVES_HARD_CAP)
    : MAX_BACKUP_ZIP_AIMOVES
  return aimoves + MAX_BACKUP_ZIP_CHAT_ENTRIES
}
/** Exact Number indexing boundary; full ZIP64 wire layout must also fit. */
export const MAX_BACKUP_ZIP_BYTES = MAX_BACKUP_ZIP64_BYTES_WAVE94
/**
 * Zip local-header name is UTF-8 bytes. `sanitizeZipEntryName` caps at 180
 * UTF-16 units; 180 BMP CJK is 540 bytes, so a 200-byte refuse after a
 * successful capStr would abort the whole export for a legal name.
 * Reserve the basename extension before that cap so `memberId/label.aimove`
 * (128 + 1 + 120 + 7) does not become a different type (TS-CHAT-032).
 */
export const ZIP_ENTRY_NAME_MAX = 180
export const ZIP_ENTRY_NAME_UTF8_MAX = 720
/** Archive paths are restore identities, not capped display labels. */
export const ZIP_ENTRY_PATH_UTF8_MAX = 4096
/** @deprecated Prefer MAX_BACKUP_ZIP_AIMOVES for id-list slice. */
export const MAX_BACKUP_ZIP_MEMBER_ENTRIES = MAX_BACKUP_ZIP_AIMOVES

/** Exact layout with bounded CPU turns; works on repeatable disk inventories. */
export async function measureStoredBackupZipWave96(
  entries: Iterable<{ size: number; nameBuf: { length: number } }>,
  opts?: { signal?: AbortSignal; authorize?: () => boolean },
): Promise<ReturnType<typeof measureBackupZip64Wave94>> {
  let totalPayloadBytes = 0, centralOffset = 0, centralBytes = 0, count = 0
  for (const entry of entries) {
    opts?.signal?.throwIfAborted()
    if (opts?.authorize && !opts.authorize()) throw new Error('Backup access is no longer allowed')
    const row = measureBackupZip64Wave94([entry])
    totalPayloadBytes = addBackupZip64BytesWave94(totalPayloadBytes, row.totalPayloadBytes)
    centralOffset = addBackupZip64BytesWave94(centralOffset, row.centralOffset)
    centralBytes = addBackupZip64BytesWave94(centralBytes, row.centralBytes)
    if (++count % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  opts?.signal?.throwIfAborted()
  if (opts?.authorize && !opts.authorize()) throw new Error('Backup access is no longer allowed')
  const contentLength = addBackupZip64BytesWave94(addBackupZip64BytesWave94(centralOffset, centralBytes), 98)
  return { contentLength, totalPayloadBytes, centralOffset, centralBytes }
}

export type BackupZipEntry = {
  /** Zip entry path (forward slashes; no leading /). */
  name: string
  size: number
  absolutePath: string
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[i] = c >>> 0
  }
  return table
})()

/** IEEE CRC-32 (ZIP). */
export function crc32Of(buf: Buffer, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(n >>> 0, 0)
  return b
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}

function u64(n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid ZIP64 value')
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

export function sanitizeZipEntryName(raw: string): string {
  const cleaned = raw
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|$)/g, '_')
  const slash = cleaned.lastIndexOf('/')
  const just = slash >= 0 ? cleaned.slice(slash + 1) : cleaned
  const dot = just.lastIndexOf('.')
  let ext = ''
  let prefix = cleaned
  if (dot > 0 && dot < just.length - 1) {
    const extRaw = just.slice(dot + 1).replace(/[^a-zA-Z0-9]/g, '')
    if (extRaw && extRaw.length <= 16) {
      ext = `.${extRaw.toLowerCase()}`
      prefix = cleaned.slice(0, cleaned.length - just.length + dot)
    }
  }
  const budget = Math.max(1, ZIP_ENTRY_NAME_MAX - ext.length)
  const cappedPrefix = capStr(prefix, budget)
  return capStr(`${cappedPrefix}${ext}`, ZIP_ENTRY_NAME_MAX) || 'backup.aimove'
}

function validBackupZipPath(raw: unknown): raw is string {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > ZIP_ENTRY_PATH_UTF8_MAX
    || /[\u0000-\u001f\u007f\\:*?"<>|]/.test(raw)
    || Buffer.from(raw, 'utf8').toString('utf8') !== raw) return false
  // Never fix/truncate names: even a unique rewritten path stops matching the
  // chat registry or member snapshot identity after extraction. Refuse aliases
  // that collapse on a supported desktop filesystem instead.
  return raw.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
    && !/[. ]$/.test(segment)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))
}

async function writeChunk(out: Writable, chunk: Buffer): Promise<void> {
  if (out.destroyed || out.writableEnded) throw new Error('Backup export was cancelled')
  if (out.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      out.off('drain', onDrain)
      out.off('error', onErr)
      out.off('close', onClose)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onErr = (err: Error) => {
      cleanup()
      reject(err)
    }
    const onClose = () => onErr(new Error('Backup export was cancelled'))
    out.once('drain', onDrain)
    out.once('error', onErr)
    out.once('close', onClose)
    if (out.destroyed) onClose()
  })
}

async function streamFileTo(out: Writable, entry: PlannedBackupZipEntry, authorize?: () => boolean): Promise<{ size: number; crc: number }> {
  let size = 0
  let crc = 0
  const fd = openSync(entry.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.dev !== entry.device || stat.ino !== entry.inode || stat.size < entry.size) {
    closeSync(fd)
    throw new Error('Backup file changed during export')
  }
  if (entry.size === 0) { closeSync(fd); return { size, crc } }
  // Fixed byte boundary makes an append-only chat log a stable prefix while
  // other members keep chatting. Compute CRC over the bytes actually emitted,
  // not a separate earlier pass that can race a rewrite of the same length.
  const stream = createReadStream(entry.absolutePath, { fd, autoClose: true, end: entry.size - 1 })
  const onClose = () => stream.destroy(new Error('Backup export was cancelled'))
  out.once('close', onClose)
  try {
    for await (const chunk of stream) {
      if (authorize && !authorize()) throw new Error('Backup access is no longer allowed')
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      crc = crc32Of(buf, crc)
      await writeChunk(out, buf)
    }
    if (size !== entry.size) throw new Error('Backup file changed during export')
    return { size, crc }
  } finally {
    out.off('close', onClose)
    stream.destroy()
  }
}

export type PlannedBackupZipEntry = {
  absolutePath: string
  nameBuf: Buffer
  crc: number
  size: number
  device: number
  inode: number
}

/**
 * TCC-R1146-BKP-003: live (possibly admin-raised) aimove ceiling for the
 * combined aimove+chat entry count - never the static MAX_BACKUP_ZIP_ENTRIES.
 */
export function resolveBackupZipEntryCeiling(maxEntries?: number): number {
  if (typeof maxEntries === 'number' && Number.isFinite(maxEntries) && maxEntries > 0) {
    return Math.min(Math.floor(maxEntries), combinedBackupZipEntryCeiling(MAX_BACKUP_ZIP_AIMOVES_HARD_CAP))
  }
  return MAX_BACKUP_ZIP_ENTRIES
}

/**
 * TCC-R1145-BKP-002: Exact ZIP64 Content-Length before any bytes
 * hit the wire so desktop can verify length before rename.
 */
export async function planStoredBackupZip(
  entries: readonly BackupZipEntry[],
  opts?: { maxEntries?: number; signal?: AbortSignal },
): Promise<
  | { ok: true; planned: PlannedBackupZipEntry[]; contentLength: number; totalPayloadBytes: number }
  | { ok: false; error: string }
> {
  const maxEntries = resolveBackupZipEntryCeiling(opts?.maxEntries)
  if (entries.length === 0) return { ok: false, error: 'No backups to export' }
  if (entries.length > maxEntries) {
    return { ok: false, error: `Too many backups (max ${maxEntries})` }
  }
  const planned: PlannedBackupZipEntry[] = []
  const names = new Set<string>()
  for (const e of entries) {
    if (opts?.signal?.aborted) return { ok: false, error: 'Backup export was cancelled' }
    if (!Number.isSafeInteger(e.size) || e.size < 0) {
      return { ok: false, error: 'Invalid backup size' }
    }
    if (!validBackupZipPath(e.name)) return { ok: false, error: 'Invalid backup entry path' }
    const name = e.name
    const nameBuf = Buffer.from(name, 'utf8')
    if (nameBuf.length === 0 || nameBuf.length > ZIP_ENTRY_PATH_UTF8_MAX) {
      return { ok: false, error: 'Invalid backup entry name' }
    }
    // Sanitization/truncation must not merge two independent files into one
    // extraction destination, including case-insensitive desktop filesystems.
    const key = name.normalize('NFC').toLowerCase()
    if (names.has(key)) return { ok: false, error: 'Duplicate backup entry name' }
    names.add(key)
    let stat
    try { stat = lstatSync(e.absolutePath) } catch { return { ok: false, error: 'Backup file is unavailable' } }
    if (!stat.isFile()) return { ok: false, error: 'Backup entries must be regular files' }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) return { ok: false, error: 'Invalid backup size' }
    planned.push({ absolutePath: e.absolutePath, nameBuf, crc: 0, size: stat.size, device: stat.dev, inode: stat.ino })
    if (planned.length % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
  }
  try {
    const { contentLength, totalPayloadBytes } = measureBackupZip64Wave94(planned)
    return { ok: true, planned, contentLength, totalPayloadBytes }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Invalid ZIP64 layout' }
  }
}

/**
 * Stream a STORED zip of the given files onto `out`.
 * Fails closed if entry count or exact ZIP64 representation bounds are exceeded.
 * TCC-R1146-BKP-003: pass opts.maxEntries from combinedBackupZipEntryCeiling(live).
 */
export async function streamStoredBackupZip(
  out: Writable,
  entries: readonly BackupZipEntry[],
  opts?: { maxEntries?: number },
): Promise<{ ok: true; entryCount: number; totalBytes: number; contentLength: number } | { ok: false; error: string }> {
  const prepared = await planStoredBackupZip(entries, opts)
  if (!prepared.ok) return prepared
  return streamPlannedBackupZip(out, prepared.planned, prepared.contentLength)
}

export type BackupZipCentralRow = { nameBuf: Buffer; crc: number; size: number; localOffset: number }
export interface BackupZipCentralStore extends Iterable<BackupZipCentralRow> {
  readonly length: number
  push(row: BackupZipCentralRow): unknown
}

export async function streamPlannedBackupZip(
  out: Writable,
  planned: Iterable<PlannedBackupZipEntry>,
  expectedContentLength?: number,
  opts?: { authorize?: () => boolean; signal?: AbortSignal; central?: BackupZipCentralStore },
): Promise<{ ok: true; entryCount: number; totalBytes: number; contentLength: number } | { ok: false; error: string }> {
  type Cd = {
    nameBuf: Buffer
    crc: number
    size: number
    localOffset: number
  }
  const central: BackupZipCentralStore = opts?.central ?? ([] as Cd[])
  let offset = 0
  let totalBytes = 0

  try {
    const layout = await measureStoredBackupZipWave96(planned, opts)
    if (expectedContentLength !== undefined && expectedContentLength !== layout.contentLength) {
      return { ok: false, error: 'Export size mismatch' }
    }
    for (const entry of planned) {
      if (opts?.authorize && !opts.authorize()) return { ok: false, error: 'Backup access is no longer allowed' }
      const { nameBuf, size } = entry
      totalBytes = addBackupZip64BytesWave94(totalBytes, size)

      const localOffset = offset
      const localHeader = Buffer.concat([
        u32(0x04034b50),
        u16(45),
        u16(0x0808), // UTF-8 names + CRC/size in trailing data descriptor
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(0xffffffff),
        u32(0xffffffff),
        u16(nameBuf.length),
        u16(20),
        nameBuf,
        u16(1), u16(16), u64(size), u64(size),
      ])
      await writeChunk(out, localHeader)
      offset = addBackupZip64BytesWave94(offset, localHeader.length)

      const written = await streamFileTo(out, entry, opts?.authorize)
      if (written.size !== size) {
        return { ok: false, error: 'Backup file changed during export' }
      }
      offset = addBackupZip64BytesWave94(offset, written.size)
      const descriptor = Buffer.concat([u32(0x08074b50), u32(written.crc), u64(size), u64(size)])
      await writeChunk(out, descriptor)
      offset = addBackupZip64BytesWave94(offset, descriptor.length)
      central.push({ nameBuf, crc: written.crc, size, localOffset })
      if (central.length % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
      opts?.signal?.throwIfAborted()
    }

    const cdStart = offset
    let centralWritten = 0
    for (const c of central) {
      opts?.signal?.throwIfAborted()
      if (opts?.authorize && !opts.authorize()) return { ok: false, error: 'Backup access is no longer allowed' }
      const cd = Buffer.concat([
        u32(0x02014b50),
        u16(45),
        u16(45),
        u16(0x0808),
        u16(0),
        u16(0),
        u16(0),
        u32(c.crc),
        u32(0xffffffff),
        u32(0xffffffff),
        u16(c.nameBuf.length),
        u16(28),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(0xffffffff),
        c.nameBuf,
        u16(1), u16(24), u64(c.size), u64(c.size), u64(c.localOffset),
      ])
      await writeChunk(out, cd)
      offset = addBackupZip64BytesWave94(offset, cd.length)
      if (++centralWritten % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
    opts?.signal?.throwIfAborted()
    if (opts?.authorize && !opts.authorize()) return { ok: false, error: 'Backup access is no longer allowed' }
    const cdSize = offset - cdStart
    const zip64End = Buffer.concat([
      u32(0x06064b50), u64(44), u16(45), u16(45), u32(0), u32(0),
      u64(central.length), u64(central.length), u64(cdSize), u64(cdStart),
      u32(0x07064b50), u32(0), u64(offset), u32(1),
    ])
    await writeChunk(out, zip64End)
    offset = addBackupZip64BytesWave94(offset, zip64End.length)
    opts?.signal?.throwIfAborted()
    if (opts?.authorize && !opts.authorize()) return { ok: false, error: 'Backup access is no longer allowed' }
    const eocd = Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(0xffff),
      u16(0xffff),
      u32(0xffffffff),
      u32(0xffffffff),
      u16(0),
    ])
    await writeChunk(out, eocd)
    offset = addBackupZip64BytesWave94(offset, eocd.length)
    const contentLength = offset
    if (contentLength !== layout.contentLength) {
      return { ok: false, error: 'Export size mismatch' }
    }
    opts?.signal?.throwIfAborted()
    if (opts?.authorize && !opts.authorize()) return { ok: false, error: 'Backup access is no longer allowed' }
    return { ok: true, entryCount: central.length, totalBytes, contentLength }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? capStr(err.message, 200) || 'Zip export failed' : 'Zip export failed',
    }
  }
}
