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
  encryptBlobBody,
  encryptJsonFile,
} from './at-rest.js'
import { capStr } from './text-cap.js'
import {
  isPublicSharePasswordHash,
  verifyPublicSharePassword,
} from './public-share-store.js'
import {
  capGuestStoreTeamId,
  capGuestStoreScopeId,
  findGuestRegistryIndex,
  GUEST_STORE_SHARE_TEAM_MISMATCH,
  mapGuestRegistryRows,
  readGuestRegistryArray,
  resolveGuestStoreStamp,
} from './portal-store.js'

const REGISTRY_FILE = 'compose-shares.json'
const PAYLOAD_DIR = 'compose-share-payloads'
/** Plain pack bytes on disk (after unlock). Cap matches desktop refuse. */
export const COMPOSE_SHARE_PACK_MAX_BYTES = 20 * 1024 * 1024
const MAX_SHARES = 500
const COMPOSE_SHARE_FILENAME_MAX = 180
/** Handler-owned. Catch must not return err.message (TS-SEC2-008). */
export const COMPOSE_SHARE_PACK_STORE_ERROR = 'Could not store pack'
/** Handler-owned. Registry write throw must not reach the page (TS-SEC2-008). */
export const COMPOSE_SHARE_REGISTRY_STORE_ERROR = 'Could not save the share list'
const COMPOSE_SHARE_REGISTRY_LOAD_ERROR = 'Share registry unreadable'

/** Log the throw, answer callers with the owned sentence (TS-SEC2-008). */
function composeSharePageError(err: unknown, owned: string): string {
  const detail = err instanceof Error ? capStr(err.message, 200) : ''
  if (detail) {
    console.error(`[compose-share] ${owned}: ${detail}`)
  } else {
    console.error(`[compose-share] ${owned}`)
  }
  return owned
}

/** User-typed pack filename: strip NUL/slashes, keep format ext, then capStr. */
function capComposeShareFilename(raw: unknown, format: string): string {
  const ext = capComposeShareEnum(format, 16, 'pdf')
  const suffix = `.${ext}`
  const cleaned =
    typeof raw === 'string' ? raw.replace(/[\\/]/g, '').replace(/\0/g, '').trim() : ''
  const stem = cleaned.toLowerCase().endsWith(suffix)
    ? cleaned.slice(0, cleaned.length - suffix.length)
    : cleaned
  const budget = Math.max(1, COMPOSE_SHARE_FILENAME_MAX - suffix.length)
  const cappedStem = capStr(stem || 'compose-share', budget)
  return capStr(`${cappedStem}${suffix}`, COMPOSE_SHARE_FILENAME_MAX)
}

/** Scope / member ids: shared NUL-cut leaf (TS-HOP-003). */
function capComposeShareScopeId(raw: unknown, max: number): string {
  return capGuestStoreScopeId(raw, max)
}

/** Closed-ish format / watermark tokens: lower, then capStr. */
function capComposeShareEnum(raw: unknown, max: number, fallback: string): string {
  const t = typeof raw === 'string' ? raw.replace(/\0/g, '').trim().toLowerCase() : ''
  return capStr(t, max) || fallback
}

/** Content-addressed share token: full 64-hex only (same class as TS-CHAT-103). */
function composeShareTokenHash(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const t = raw.replace(/\0/g, '').trim().toLowerCase()
  return /^[0-9a-f]{64}$/.test(t) ? t : ''
}

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
  /** Optional stamp. Blank leftover admits (TCC-FIX-SHARE-013). */
  teamId?: string
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

function payloadPath(dir: string, tokenHash: string): string | null {
  const hash = composeShareTokenHash(tokenHash)
  if (!hash) return null
  return join(dir, `${hash}.bin`)
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

  private loadRegistryResult():
    | { ok: true; shares: ComposeShareRow[] }
    | { ok: false; reason: string } {
    const loaded = readGuestRegistryArray(this.registryPath, this.atRest, 'shares')
    if (!loaded.ok) return { ok: false, reason: COMPOSE_SHARE_REGISTRY_LOAD_ERROR }
    const shares = mapGuestRegistryRows<ComposeShareRow>(loaded.rows)
      .map((row) => {
        const tokenHash = composeShareTokenHash(row.tokenHash)
        if (!tokenHash) return null
        const format = capComposeShareEnum(row.format, 16, 'pdf')
        const teamId = capGuestStoreTeamId(row.teamId)
        return {
          ...row,
          tokenHash,
          localShareId: capComposeShareScopeId(row.localShareId, 128),
          format,
          watermark: capComposeShareEnum(row.watermark, 32, 'off'),
          filename: capComposeShareFilename(row.filename, format),
          ownerMemberId: capComposeShareScopeId(row.ownerMemberId, 128),
          ...(teamId ? { teamId } : {}),
        }
      })
      .filter((row): row is ComposeShareRow => row !== null)
    return { ok: true, shares }
  }

  private saveRegistry(
    shares: ComposeShareRow[],
  ): { ok: true } | { ok: false; error: string } {
    const trimmed =
      shares.length > MAX_SHARES
        ? shares
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, MAX_SHARES)
        : shares
    try {
      writeJson(this.registryPath, { shares: trimmed }, this.atRest)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: composeSharePageError(err, COMPOSE_SHARE_REGISTRY_STORE_ERROR) }
    }
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
      teamId?: unknown
      team_id?: unknown
    },
  ): { ok: true; row: ComposeShareRow } | { ok: false; error: string } {
    const tokenHash = composeShareTokenHash(args.tokenHash)
    if (!tokenHash) {
      return { ok: false, error: 'token_hash must be sha256 hex' }
    }
    const localShareId = capComposeShareScopeId(args.localShareId, 128)
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
    const format = capComposeShareEnum(args.format, 16, 'pdf')
    const watermark = capComposeShareEnum(args.watermark, 32, 'off')
    const filename = capComposeShareFilename(args.filename, format)

    const now = Date.now()
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: COMPOSE_SHARE_REGISTRY_LOAD_ERROR }
    let shares = loaded.shares
    const found = findGuestRegistryIndex(shares, {
      tokenHash,
      localId: localShareId,
      localOf: (s) => s.localShareId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    const prev = found.idx >= 0 ? shares[found.idx] : undefined
    const stampedTeam = resolveGuestStoreStamp(prev?.teamId, callerTeam)
    if (found.idx >= 0) {
      shares = shares.filter((_, i) => i !== found.idx)
    }
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
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      ownerMemberId: capComposeShareScopeId(ownerMemberId, 128),
      ...(stampedTeam ? { teamId: stampedTeam } : {}),
    }
    try {
      const p = payloadPath(this.payloadDir, tokenHash)
      if (!p) return { ok: false, error: 'token_hash must be sha256 hex' }
      const tmp = `${p}.${process.pid}.tmp`
      // TCC-R1126-BRG-002: encrypt pack bytes at rest (registry JSON already did).
      const onDisk = this.atRest ? encryptBlobBody(this.atRest, args.packBytes) : args.packBytes
      writeFileSync(tmp, onDisk)
      renameSync(tmp, p)
    } catch (err) {
      return { ok: false, error: composeSharePageError(err, COMPOSE_SHARE_PACK_STORE_ERROR) }
    }
    shares.push(row)
    const saved = this.saveRegistry(shares)
    if (!saved.ok) return saved
    return { ok: true, row }
  }

  revokeShare(args: {
    localShareId?: string
    tokenHash?: string
    teamId?: unknown
    team_id?: unknown
  }): { ok: true } | { ok: false; error: string } {
    const localId = capComposeShareScopeId(args.localShareId, 128)
    const tokenHash = composeShareTokenHash(args.tokenHash)
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: COMPOSE_SHARE_REGISTRY_LOAD_ERROR }
    const shares = loaded.shares
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const found = findGuestRegistryIndex(shares, {
      tokenHash,
      localId,
      localOf: (s) => s.localShareId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    const idx = found.idx
    if (idx < 0) return { ok: false, error: 'Share not found' }
    const row = shares[idx]!
    row.revokedAt = Date.now()
    row.updatedAt = row.revokedAt
    shares[idx] = row
    const saved = this.saveRegistry(shares)
    if (!saved.ok) return saved
    try {
      const p = payloadPath(this.payloadDir, row.tokenHash)
      if (p && existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
    row.payloadReady = false
    return { ok: true }
  }

  resolveGuest(tokenPlain: string): {
    row: ComposeShareRow | null
    active: boolean
    reason: 'not_found' | 'revoked' | 'expired' | 'ok' | 'unreadable'
  } {
    const plain = typeof tokenPlain === 'string' ? tokenPlain.trim() : ''
    if (!plain || plain.length < 8 || plain.length > 128) {
      return { row: null, active: false, reason: 'not_found' }
    }
    const tokenHash = hashComposeShareToken(plain)
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { row: null, active: false, reason: 'unreadable' }
    const row = loaded.shares.find((s) => s.tokenHash === tokenHash) ?? null
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
    const p = payloadPath(this.payloadDir, tokenHash)
    if (!p || !existsSync(p)) return null
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
  const format = capComposeShareEnum(row.format, 16, 'pdf')
  return {
    format,
    watermark: capComposeShareEnum(row.watermark, 32, 'off'),
    filename: capComposeShareFilename(row.filename, format),
    has_password: Boolean(row.passwordHash),
    expires_at_ms: row.expiresAt,
    byte_length: row.byteLength,
    payload_ready: row.payloadReady === true,
  }
}

export { verifyPublicSharePassword, isPublicSharePasswordHash }
