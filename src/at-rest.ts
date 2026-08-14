/**
 * TS-BRG-014 / TS-SCL-002: optional AES-256-GCM at-rest for TEAMSPACE_DATA_DIR.
 *
 * Set TEAMSPACE_AT_REST_KEY to a 64-hex key OR any passphrase (>= 16 chars).
 * When unset, files stay plaintext (loopback / encrypted volume still OK) -
 * SELF-HOST documents the requirement for shared disks.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto'

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
