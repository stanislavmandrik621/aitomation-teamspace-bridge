/**
 * STORED (method 0) ZIP writer for P6 admin backup export.
 * Sealed .aimove archives are already compressed/encrypted - no deflate.
 * CRC32 is pure JS so Node 20 (bridge engines) stays supported - zlib.crc32 is Node 22+.
 */
import { createReadStream } from 'node:fs'
import type { Writable } from 'node:stream'

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
/** Soft ceiling on total uncompressed payload in one admin zip. */
export const MAX_BACKUP_ZIP_BYTES = 32 * 1024 * 1024 * 1024
/** @deprecated Prefer MAX_BACKUP_ZIP_AIMOVES for id-list slice. */
export const MAX_BACKUP_ZIP_MEMBER_ENTRIES = MAX_BACKUP_ZIP_AIMOVES

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

export function sanitizeZipEntryName(raw: string): string {
  const cleaned = raw
    .replace(/\0/g, '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\.\.(\/|$)/g, '_')
    .slice(0, 180)
  return cleaned || 'backup.aimove'
}

async function writeChunk(out: Writable, chunk: Buffer): Promise<void> {
  if (out.write(chunk)) return
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      out.off('error', onErr)
      resolve()
    }
    const onErr = (err: Error) => {
      out.off('drain', onDrain)
      reject(err)
    }
    out.once('drain', onDrain)
    out.once('error', onErr)
  })
}

async function crcAndSizeOfFile(absolutePath: string, expectedSize: number): Promise<{ crc: number; size: number }> {
  let crc = 0
  let size = 0
  const stream = createReadStream(absolutePath)
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    if (size > MAX_BACKUP_ZIP_BYTES) {
      stream.destroy()
      throw new Error('Backup file too large for export')
    }
    crc = crc32Of(buf, crc)
  }
  if (expectedSize > 0 && size !== expectedSize) {
    // Prefer live size when the index drifted; still export.
  }
  return { crc, size }
}

async function streamFileTo(out: Writable, absolutePath: string): Promise<number> {
  let size = 0
  const stream = createReadStream(absolutePath)
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buf.length
    await writeChunk(out, buf)
  }
  return size
}

export type PlannedBackupZipEntry = {
  absolutePath: string
  nameBuf: Buffer
  crc: number
  size: number
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
 * TCC-R1145-BKP-002: CRC + exact STORED zip Content-Length before any bytes
 * hit the wire so desktop can verify length before rename.
 */
export async function planStoredBackupZip(
  entries: readonly BackupZipEntry[],
  opts?: { maxEntries?: number },
): Promise<
  | { ok: true; planned: PlannedBackupZipEntry[]; contentLength: number; totalPayloadBytes: number }
  | { ok: false; error: string }
> {
  const maxEntries = resolveBackupZipEntryCeiling(opts?.maxEntries)
  if (entries.length === 0) return { ok: false, error: 'No backups to export' }
  if (entries.length > maxEntries) {
    return { ok: false, error: `Too many backups (max ${maxEntries})` }
  }
  let plannedBytes = 0
  const planned: PlannedBackupZipEntry[] = []
  for (const e of entries) {
    if (!Number.isFinite(e.size) || e.size < 0) {
      return { ok: false, error: 'Invalid backup size' }
    }
    plannedBytes += e.size
    if (plannedBytes > MAX_BACKUP_ZIP_BYTES) {
      return { ok: false, error: 'Export too large - select fewer backups' }
    }
    const name = sanitizeZipEntryName(e.name)
    const nameBuf = Buffer.from(name, 'utf8')
    if (nameBuf.length === 0 || nameBuf.length > 200) {
      return { ok: false, error: 'Invalid backup entry name' }
    }
    const { crc, size } = await crcAndSizeOfFile(e.absolutePath, e.size)
    planned.push({ absolutePath: e.absolutePath, nameBuf, crc, size })
  }
  let contentLength = 22 // end of central directory
  let totalPayloadBytes = 0
  for (const p of planned) {
    totalPayloadBytes += p.size
    contentLength += 30 + p.nameBuf.length + p.size // local header + data
    contentLength += 46 + p.nameBuf.length // central directory header
  }
  if (contentLength > MAX_BACKUP_ZIP_BYTES + 16_000_000) {
    return { ok: false, error: 'Export too large - select fewer backups' }
  }
  return { ok: true, planned, contentLength, totalPayloadBytes }
}

/**
 * Stream a STORED zip of the given files onto `out`.
 * Fails closed if entry count / total bytes exceed caps.
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

export async function streamPlannedBackupZip(
  out: Writable,
  planned: readonly PlannedBackupZipEntry[],
  expectedContentLength?: number,
): Promise<{ ok: true; entryCount: number; totalBytes: number; contentLength: number } | { ok: false; error: string }> {
  type Cd = {
    nameBuf: Buffer
    crc: number
    size: number
    localOffset: number
  }
  const central: Cd[] = []
  let offset = 0
  let totalBytes = 0

  try {
    for (const entry of planned) {
      const { nameBuf, crc, size, absolutePath } = entry
      totalBytes += size
      if (totalBytes > MAX_BACKUP_ZIP_BYTES) {
        return { ok: false, error: 'Export too large - select fewer backups' }
      }

      const localOffset = offset
      const localHeader = Buffer.concat([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(size),
        u32(size),
        u16(nameBuf.length),
        u16(0),
        nameBuf,
      ])
      await writeChunk(out, localHeader)
      offset += localHeader.length

      const written = await streamFileTo(out, absolutePath)
      if (written !== size) {
        return { ok: false, error: 'Backup file changed during export' }
      }
      offset += written

      central.push({ nameBuf, crc, size, localOffset })
    }

    const cdStart = offset
    for (const c of central) {
      const cd = Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(c.crc),
        u32(c.size),
        u32(c.size),
        u16(c.nameBuf.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(c.localOffset),
        c.nameBuf,
      ])
      await writeChunk(out, cd)
      offset += cd.length
    }
    const cdSize = offset - cdStart
    const eocd = Buffer.concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(central.length),
      u16(central.length),
      u32(cdSize),
      u32(cdStart),
      u16(0),
    ])
    await writeChunk(out, eocd)
    offset += eocd.length
    const contentLength = offset
    if (typeof expectedContentLength === 'number' && expectedContentLength > 0 && contentLength !== expectedContentLength) {
      return { ok: false, error: 'Export size mismatch' }
    }
    return { ok: true, entryCount: central.length, totalBytes, contentLength }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 200) : 'Zip export failed',
    }
  }
}
