/**
 * TS-BRG-014 / TS-SCL-002: optional AES-256-GCM at-rest for TEAMSPACE_DATA_DIR.
 *
 * Set TEAMSPACE_AT_REST_KEY to a 64-hex key OR any passphrase (>= 16 chars).
 * When unset, files stay plaintext (loopback / encrypted volume still OK) -
 * SELF-HOST documents the requirement for shared disks.
 */

import type { DecipherGCM } from 'node:crypto'
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'
import {
  closeSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { Transform } from 'node:stream'

const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16
const KEY_LEN = 32
const SCRYPT_SALT = Buffer.from('aitomation-teamspace-at-rest-v1', 'utf8')

/** Text line prefix for encrypted ops.jsonl rows. */
export const OPS_ENC_PREFIX = 'e1.'

/** Binary magic for encrypted blob files (ASCII "TSB1"). */
export const BLOB_ENC_MAGIC = Buffer.from([0x54, 0x53, 0x42, 0x31])

export type AtRestKey = {
  key: Buffer
}

export function resolveAtRestKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AtRestKey | null {
  const raw = String(env.TEAMSPACE_AT_REST_KEY || '').trim()
  if (!raw) return null
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return { key: Buffer.from(raw, 'hex') }
  }
  if (raw.length < 16) {
    throw new Error(
      'TEAMSPACE_AT_REST_KEY must be 64 hex chars or a passphrase of at least 16 characters',
    )
  }
  return { key: scryptSync(raw, SCRYPT_SALT, KEY_LEN) }
}

function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plain), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct])
}

function open(key: Buffer, packed: Buffer): Buffer {
  if (packed.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('Ciphertext too short')
  }
  const iv = packed.subarray(0, IV_LEN)
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const ct = packed.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()])
}

/** Encrypt a UTF-8 ops line (no trailing newline). Returns `e1.<base64url>`. */
export function encryptOpsLine(key: AtRestKey, plainLine: string): string {
  const packed = seal(key.key, Buffer.from(plainLine, 'utf8'))
  return `${OPS_ENC_PREFIX}${packed.toString('base64url')}`
}

/** Decrypt an ops line; plaintext JSON lines pass through unchanged. */
export function decryptOpsLine(key: AtRestKey | null, line: string): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith(OPS_ENC_PREFIX)) return trimmed
  if (!key) {
    throw new Error('Encrypted op log requires TEAMSPACE_AT_REST_KEY')
  }
  const b64 = trimmed.slice(OPS_ENC_PREFIX.length)
  const packed = Buffer.from(b64, 'base64url')
  return open(key.key, packed).toString('utf8')
}

export function encryptBlobBody(key: AtRestKey, plain: Buffer): Buffer {
  const packed = seal(key.key, plain)
  return Buffer.concat([BLOB_ENC_MAGIC, packed])
}

export function decryptBlobBody(key: AtRestKey | null, onDisk: Buffer): Buffer {
  if (onDisk.length >= 4 && onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC)) {
    if (!key) {
      throw new Error('Encrypted blob requires TEAMSPACE_AT_REST_KEY')
    }
    return open(key.key, onDisk.subarray(4))
  }
  return onDisk
}

export function isEncryptedBlob(onDisk: Buffer): boolean {
  return onDisk.length >= 4 && onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC)
}

/**
 * G5-pipe / BRG-069: stream TSB1 GCM without holding the whole file.
 * Layout stays BLOB_ENC_MAGIC + iv + tag + ct (tag slot written after final).
 * In-memory encryptBlobBody / decryptBlobBody stay for small callers.
 */
export const BLOB_GCM_STREAM_CHUNK = 64 * 1024

const BLOB_HEADER_LEN = 4 + IV_LEN + TAG_LEN

function isFsMissing(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code: unknown }).code === 'ENOENT',
  )
}

function requireBlobPaths(srcPath: string, destPath: string, label: string): { src: string; dest: string } {
  const src = String(srcPath || '')
  const dest = String(destPath || '')
  if (!src || !dest) {
    throw new Error(`${label} requires src and dest`)
  }
  if (src === dest) {
    throw new Error(`${label} refuses in-place overwrite`)
  }
  return { src, dest }
}

function requireReadableFile(path: string, label: string): void {
  try {
    const st = statSync(path)
    if (!st.isFile()) {
      throw new Error(`${label} src missing`)
    }
  } catch (err) {
    if (isFsMissing(err)) {
      throw new Error(`${label} src missing`)
    }
    throw err
  }
}

/**
 * Work file beside dest. Pid + nonce so two same-dest encrypts cannot share
 * one `.encpart` / `.decpart` (BRG-073 / PROJ-085). Ends in `.part` so the
 * hourly tmp sweep can reclaim a crash leftover. Sweep skips `*.${pid}.*`.
 */
function blobTransformTmp(dest: string, kind: 'enc' | 'dec'): string {
  return `${dest}.${process.pid}.${randomBytes(8).toString('hex')}.${kind}part`
}

export function encryptBlobFile(key: AtRestKey, srcPath: string, destPath: string): number {
  const { src, dest } = requireBlobPaths(srcPath, destPath, 'encryptBlobFile')
  requireReadableFile(src, 'encryptBlobFile')
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGO, key.key, iv)
  const tmp = blobTransformTmp(dest, 'enc')
  let srcFd = -1
  let destFd = -1
  let written = 0
  try {
    srcFd = openSync(src, 'r')
    destFd = openSync(tmp, 'w')
    writeSync(destFd, BLOB_ENC_MAGIC)
    writeSync(destFd, iv)
    writeSync(destFd, Buffer.alloc(TAG_LEN))
    written = BLOB_HEADER_LEN
    const buf = Buffer.allocUnsafe(BLOB_GCM_STREAM_CHUNK)
    let srcPos = 0
    let n = 0
    while ((n = readSync(srcFd, buf, 0, buf.length, srcPos)) > 0) {
      srcPos += n
      const out = cipher.update(buf.subarray(0, n))
      if (out.length > 0) {
        writeSync(destFd, out)
        written += out.length
      }
    }
    const last = cipher.final()
    if (last.length > 0) {
      writeSync(destFd, last)
      written += last.length
    }
    const tag = cipher.getAuthTag()
    writeSync(destFd, tag, 0, TAG_LEN, 4 + IV_LEN)
    closeSync(destFd)
    destFd = -1
    closeSync(srcFd)
    srcFd = -1
    renameSync(tmp, dest)
    return written
  } catch (err) {
    if (destFd >= 0) {
      try { closeSync(destFd) } catch { /* */ }
    }
    if (srcFd >= 0) {
      try { closeSync(srcFd) } catch { /* */ }
    }
    try { unlinkSync(tmp) } catch { /* */ }
    throw err
  }
}

export function decryptBlobFile(key: AtRestKey | null, srcPath: string, destPath: string): number {
  const { src, dest } = requireBlobPaths(srcPath, destPath, 'decryptBlobFile')
  requireReadableFile(src, 'decryptBlobFile')
  const tmp = blobTransformTmp(dest, 'dec')
  let srcFd = -1
  let destFd = -1
  try {
    srcFd = openSync(src, 'r')
    const magic = Buffer.alloc(4)
    const gotMagic = readSync(srcFd, magic, 0, 4, 0)
    destFd = openSync(tmp, 'w')
    let written = 0
    if (gotMagic === 4 && magic.equals(BLOB_ENC_MAGIC)) {
      if (!key) {
        throw new Error('Encrypted blob requires TEAMSPACE_AT_REST_KEY')
      }
      const iv = Buffer.alloc(IV_LEN)
      const tag = Buffer.alloc(TAG_LEN)
      if (readSync(srcFd, iv, 0, IV_LEN, 4) !== IV_LEN) {
        throw new Error('Ciphertext too short')
      }
      if (readSync(srcFd, tag, 0, TAG_LEN, 4 + IV_LEN) !== TAG_LEN) {
        throw new Error('Ciphertext too short')
      }
      const decipher = createDecipheriv(ALGO, key.key, iv)
      decipher.setAuthTag(tag)
      const buf = Buffer.allocUnsafe(BLOB_GCM_STREAM_CHUNK)
      let pos = BLOB_HEADER_LEN
      let n = 0
      while ((n = readSync(srcFd, buf, 0, buf.length, pos)) > 0) {
        pos += n
        const out = decipher.update(buf.subarray(0, n))
        if (out.length > 0) {
          writeSync(destFd, out)
          written += out.length
        }
      }
      const last = decipher.final()
      if (last.length > 0) {
        writeSync(destFd, last)
        written += last.length
      }
    } else {
      const buf = Buffer.allocUnsafe(BLOB_GCM_STREAM_CHUNK)
      let pos = 0
      let n = 0
      if (gotMagic > 0) {
        writeSync(destFd, magic.subarray(0, gotMagic))
        written += gotMagic
        pos = gotMagic
      }
      while ((n = readSync(srcFd, buf, 0, buf.length, pos)) > 0) {
        pos += n
        writeSync(destFd, buf.subarray(0, n))
        written += n
      }
    }
    closeSync(destFd)
    destFd = -1
    closeSync(srcFd)
    srcFd = -1
    renameSync(tmp, dest)
    return written
  } catch (err) {
    if (destFd >= 0) {
      try { closeSync(destFd) } catch { /* */ }
    }
    if (srcFd >= 0) {
      try { closeSync(srcFd) } catch { /* */ }
    }
    try { unlinkSync(tmp) } catch { /* */ }
    throw err
  }
}

/**
 * Stream decrypt for a TSB1 body (or plaintext passthrough). Buffers only
 * the 32-byte header, never the whole file.
 */
export function createBlobDecryptTransform(key: AtRestKey | null): Transform {
  const headerNeed = BLOB_HEADER_LEN
  let header = Buffer.alloc(0)
  let mode: 'header' | 'plain' | 'gcm' | 'failed' = 'header'
  // `ReturnType<typeof createDecipheriv>` picks the widest overload (`Decipher`),
  // which has no `setAuthTag` - name the GCM shape the call actually returns.
  let decipher: DecipherGCM | null = null
  const fail = (cb: (err?: Error | null, data?: Buffer) => void, err: unknown): void => {
    mode = 'failed'
    decipher = null
    header = Buffer.alloc(0)
    cb(err instanceof Error ? err : new Error('Blob decrypt failed'))
  }
  return new Transform({
    transform(chunk, _enc, cb) {
      if (mode === 'failed') {
        cb()
        return
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (mode === 'header') {
        const need = headerNeed - header.length
        if (buf.length < need) {
          header = Buffer.concat([header, buf])
          cb()
          return
        }
        const complete = Buffer.concat([header, buf.subarray(0, need)])
        const rest = buf.subarray(need)
        header = Buffer.alloc(0)
        if (complete.subarray(0, 4).equals(BLOB_ENC_MAGIC)) {
          if (!key) {
            fail(cb, new Error('Encrypted blob requires TEAMSPACE_AT_REST_KEY'))
            return
          }
          const iv = complete.subarray(4, 4 + IV_LEN)
          const tag = complete.subarray(4 + IV_LEN, 4 + IV_LEN + TAG_LEN)
          decipher = createDecipheriv(ALGO, key.key, iv)
          decipher.setAuthTag(tag)
          mode = 'gcm'
          try {
            cb(null, rest.length > 0 ? decipher.update(rest) : undefined)
          } catch (err) {
            fail(cb, err)
          }
          return
        }
        mode = 'plain'
        cb(null, rest.length > 0 ? Buffer.concat([complete, rest]) : complete)
        return
      }
      if (mode === 'plain') {
        cb(null, buf)
        return
      }
      if (!decipher) {
        fail(cb, new Error('Blob decrypt failed'))
        return
      }
      try {
        cb(null, decipher.update(buf))
      } catch (err) {
        fail(cb, err)
      }
    },
    flush(cb) {
      if (mode === 'failed') {
        cb()
        return
      }
      if (mode === 'header') {
        if (header.length >= 4 && header.subarray(0, 4).equals(BLOB_ENC_MAGIC)) {
          fail(cb, new Error('Ciphertext too short'))
          return
        }
        cb(null, header.length > 0 ? header : undefined)
        return
      }
      if (mode === 'gcm' && decipher) {
        try {
          cb(null, decipher.final())
        } catch (err) {
          fail(cb, err)
        }
        return
      }
      cb()
    },
    destroy(err, cb) {
      mode = 'failed'
      decipher = null
      header = Buffer.alloc(0)
      cb(err)
    },
  })
}

/** Encrypt a JSON document for members/invites/acks/team files. */
export function encryptJsonFile(key: AtRestKey, value: unknown): string {
  const plain = Buffer.from(JSON.stringify(value, null, 2), 'utf8')
  const packed = seal(key.key, plain)
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    ciphertext: packed.toString('base64'),
  })
}

export function decryptJsonFile<T>(key: AtRestKey | null, raw: string, fallback: T): T {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return fallback
  }
  if (
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as { v?: unknown }).v === 1
    && typeof (parsed as { ciphertext?: unknown }).ciphertext === 'string'
  ) {
    if (!key) {
      throw new Error('Encrypted store file requires TEAMSPACE_AT_REST_KEY')
    }
    const packed = Buffer.from((parsed as { ciphertext: string }).ciphertext, 'base64')
    const plain = open(key.key, packed).toString('utf8')
    return JSON.parse(plain) as T
  }
  return parsed as T
}

/** Fingerprint for logs (never the key). */
export function atRestKeyFingerprint(key: AtRestKey): string {
  return createHash('sha256').update(key.key).digest('hex').slice(0, 12)
}
