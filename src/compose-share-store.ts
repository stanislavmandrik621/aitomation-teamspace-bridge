/**
 * Compose client share links on the Team Space bridge.
 * Password-gated short-lived pack download - never permanent CDN / Directus.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AtRestKey,
  decryptBlobBody,
  decryptJsonFile,
  encryptBlobBody,
  encryptJsonFile,
} from './at-rest.js'
import {
  isPublicSharePasswordHash,
  verifyPublicSharePassword,
} from './public-share-store.js'

const REGISTRY_FILE = 'compose-shares.json'
const PAYLOAD_DIR = 'compose-share-payloads'
/** Plain pack bytes on disk (after unlock). Cap matches desktop refuse. */
export const COMPOSE_SHARE_PACK_MAX_BYTES = 20 * 1024 * 1024
const MAX_SHARES = 500

export type ComposeShareRow = {
  tokenHash: string
  localShareId: string
  format: string
  watermark: string
  filename: string
  passwordHash: string | null
  expiresAt: number | null
  revokedAt: number | null
  payloadReady: boolean
  byteLength: number
  createdAt: number
  updatedAt: number
  ownerMemberId: string
}

type RegistryFile = { shares: ComposeShareRow[] }

function readJson<T>(path: string, fallback: T, atRest: AtRestKey | null): T {
  if (!existsSync(path)) return fallback
  try {
    const raw = readFileSync(path, 'utf8')
    return decryptJsonFile<T>(atRest, raw, fallback) ?? fallback
  } catch {
    return fallback
  }
}

function writeJson(path: string, value: unknown, atRest: AtRestKey | null): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const body = atRest
    ? encryptJsonFile(atRest, value)
    : JSON.stringify(value, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
}

export function hashComposeShareToken(tokenPlain: string): string {
  return createHash('sha256').update(String(tokenPlain), 'utf8').digest('hex')
}

export function mintComposeShareTokenPlain(): string {
  return randomBytes(32).toString('base64url')
}

function isShareActive(row: ComposeShareRow): boolean {
  if (typeof row.revokedAt === 'number' && row.revokedAt > 0) return false
  if (typeof row.expiresAt === 'number' && row.expiresAt > 0 && Date.now() >= row.expiresAt) {
    return false
  }
  return true
}

function payloadPath(dir: string, tokenHash: string): string {
  return join(dir, `${tokenHash}.bin`)
}

export class ComposeShareBridgeStore {
  private readonly registryPath: string
  private readonly payloadDir: string
  private readonly atRest: AtRestKey | null

  constructor(dataDir: string, atRest: AtRestKey | null) {
    this.atRest = atRest
    this.registryPath = join(dataDir, REGISTRY_FILE)
    this.payloadDir = join(dataDir, PAYLOAD_DIR)
    mkdirSync(this.payloadDir, { recursive: true })
  }

  private loadRegistry(): ComposeShareRow[] {
    const file = readJson<RegistryFile>(this.registryPath, { shares: [] }, this.atRest)
    return Array.isArray(file.shares) ? file.shares : []
  }

  private saveRegistry(shares: ComposeShareRow[]): void {
    const trimmed =
      shares.length > MAX_SHARES
        ? shares
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_SHARES)
        : shares
    writeJson(this.registryPath, { shares: trimmed }, this.atRest)
  }

  upsertShare(
    ownerMemberId: string,
    args: {
      tokenHash: string
      localShareId: string
      format: string
      watermark: string
      filename: string
      passwordHash: string | null
      expiresAt: number | null
      packBytes: Buffer
    },
  ): { ok: true; row: ComposeShareRow } | { ok: false; error: string } {
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'token_hash must be sha256 hex' }
    }
    const localShareId =
      typeof args.localShareId === 'string' ? args.localShareId.trim().slice(0, 128) : ''
    if (!localShareId) return { ok: false, error: 'local_share_id is required' }
    // TCC-R1132-CMPY-002: Compose client share LINKS are always password-gated
    // by product policy (desktop hard-refuses to create a link without a
    // password before it ever calls this endpoint - see
    // compose-client-share-tool-handlers.ts COMPOSE_CLIENT_SHARE_LINK_PASSWORD_REQUIRED).
    // Pack mode never reaches this bridge endpoint. The bridge is the actual
    // guest-facing authority that decides `unlocked: !row.passwordHash` /
    // verifies the password on the guest GET/POST paths below, so it must
    // enforce the same invariant server-side instead of trusting the caller -
    // otherwise any admin-session caller (not just the desktop app) could
    // register a "password protected" link with a null hash and let a guest
    // unlock it with no password at all.
    if (!isPublicSharePasswordHash(args.passwordHash)) {
      return { ok: false, error: 'password_hash is required and must be a valid hash' }
    }
    if (!Buffer.isBuffer(args.packBytes) || args.packBytes.length === 0) {
      return { ok: false, error: 'pack bytes are required' }
    }
    if (args.packBytes.length > COMPOSE_SHARE_PACK_MAX_BYTES) {
      return {
        ok: false,
        error: `Pack is too large for a share link (max ${COMPOSE_SHARE_PACK_MAX_BYTES} bytes)`,
      }
    }
    const format =
      typeof args.format === 'string' ? args.format.trim().toLowerCase().slice(0, 16) : 'pdf'
    const watermark =
      typeof args.watermark === 'string' ? args.watermark.trim().toLowerCase().slice(0, 32) : 'off'
    const filenameRaw =
      typeof args.filename === 'string' ? args.filename.replace(/[\\/]/g, '').trim() : ''
    const filename = (filenameRaw || `compose-share.${format}`).slice(0, 180)

    const now = Date.now()
    const shares = this.loadRegistry().filter(
      (s) => s.tokenHash !== tokenHash && s.localShareId !== localShareId,
    )
    const row: ComposeShareRow = {
      tokenHash,
      localShareId,
      format,
      watermark,
      filename,
      passwordHash: args.passwordHash,
      expiresAt: args.expiresAt,
      revokedAt: null,
      payloadReady: true,
      byteLength: args.packBytes.length,
      createdAt: now,
      updatedAt: now,
      ownerMemberId: String(ownerMemberId || '').slice(0, 128),
    }
    try {
      const p = payloadPath(this.payloadDir, tokenHash)
      const tmp = `${p}.${process.pid}.tmp`
      // TCC-R1126-BRG-002: encrypt pack bytes at rest (registry JSON already did).
      const onDisk = this.atRest ? encryptBlobBody(this.atRest, args.packBytes) : args.packBytes
      writeFileSync(tmp, onDisk)
      renameSync(tmp, p)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'Could not store pack',
      }
    }
    shares.push(row)
    this.saveRegistry(shares)
    return { ok: true, row }
  }

  revokeShare(args: {
    localShareId?: string
    tokenHash?: string
  }): { ok: true } | { ok: false; error: string } {
    const localId =
      typeof args.localShareId === 'string' ? args.localShareId.trim() : ''
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.trim().toLowerCase() : ''
    const shares = this.loadRegistry()
    const idx = shares.findIndex(
      (s) =>
        (localId && s.localShareId === localId) ||
        (tokenHash && s.tokenHash === tokenHash),
    )
    if (idx < 0) return { ok: false, error: 'Share not found' }
    const row = shares[idx]!
    row.revokedAt = Date.now()
    row.updatedAt = row.revokedAt
    shares[idx] = row
    this.saveRegistry(shares)
    try {
      const p = payloadPath(this.payloadDir, row.tokenHash)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
    row.payloadReady = false
    return { ok: true }
  }

  resolveGuest(tokenPlain: string): {
    row: ComposeShareRow | null
    active: boolean
    reason: 'not_found' | 'revoked' | 'expired' | 'ok'
  } {
    const plain = typeof tokenPlain === 'string' ? tokenPlain.trim() : ''
    if (!plain || plain.length < 8 || plain.length > 128) {
      return { row: null, active: false, reason: 'not_found' }
    }
    const tokenHash = hashComposeShareToken(plain)
    const row = this.loadRegistry().find((s) => s.tokenHash === tokenHash) ?? null
    if (!row) return { row: null, active: false, reason: 'not_found' }
    if (typeof row.revokedAt === 'number' && row.revokedAt > 0) {
      return { row, active: false, reason: 'revoked' }
    }
    if (typeof row.expiresAt === 'number' && row.expiresAt > 0 && Date.now() >= row.expiresAt) {
      return { row, active: false, reason: 'expired' }
    }
    if (!isShareActive(row)) {
      return { row, active: false, reason: 'expired' }
    }
    return { row, active: true, reason: 'ok' }
  }

  readPackBytes(tokenHash: string): Buffer | null {
    const hash = typeof tokenHash === 'string' ? tokenHash.trim().toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(hash)) return null
    const p = payloadPath(this.payloadDir, hash)
    if (!existsSync(p)) return null
    try {
      const onDisk = readFileSync(p)
      // TCC-R1126-BRG-002: decrypt before the size ceiling check so the cap
      // applies to the real pack size, not ciphertext-plus-overhead length.
      const buf = decryptBlobBody(this.atRest, onDisk)
      if (buf.length > COMPOSE_SHARE_PACK_MAX_BYTES) return null
      return buf
    } catch {
      return null
    }
  }
}

export function toComposeShareMeta(row: ComposeShareRow): Record<string, unknown> {
  return {
    format: row.format,
    watermark: row.watermark,
    filename: row.filename,
    has_password: Boolean(row.passwordHash),
    expires_at_ms: row.expiresAt,
    byte_length: row.byteLength,
    payload_ready: row.payloadReady === true,
  }
}

export { verifyPublicSharePassword, isPublicSharePasswordHash }
