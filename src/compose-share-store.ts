import { reviewAccess, reviewAccessMeta, type ReviewAccess, type ReviewAuthor } from './compose-review-identities.js'
import { retainIndependentCheckpoint } from './independent-authority.js'
/**
 * Compose client share links on the Team Space bridge.
 * Password-gated short-lived pack download - never permanent CDN / Directus.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  type AtRestKey,
  decryptBlobBody,
  encryptBlobBody,
  encryptJsonFile,
} from './at-rest.js'
import { capStr } from './text-cap.js'
import { GuestTokenRetirementStore, GUEST_TOKEN_RETIREMENT_UNAVAILABLE } from './guest-token-retirement.js'
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
  documentId?: string
  sourceRevision?: number
  allowComments?: boolean
  reviewAccess?: ReviewAccess
}

/** Flush bytes before commit and the containing directory before acknowledging. */
function syncParent(path: string): void {
  const fd = openSync(dirname(path), 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function writePrivateFile(path: string, body: string | Buffer): void {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, body); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
    syncParent(path)
  } finally { if (existsSync(tmp)) unlinkSync(tmp) }
}
function confirmPrivateFile(path: string): void {
  const fd = openSync(path, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
  syncParent(path)
}
function writeJson(path: string, value: unknown, atRest: AtRestKey | null): void {
  writePrivateFile(path, atRest ? encryptJsonFile(atRest, value) : JSON.stringify(value, null, 2))
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
  private readonly retiredTokens: GuestTokenRetirementStore

  constructor(dataDir: string, atRest: AtRestKey | null) {
    this.atRest = atRest
    this.retiredTokens = new GuestTokenRetirementStore(join(dataDir, 'compose-share-retired-tokens'), atRest)
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
    try { for (const row of shares) reviewAccess(row.reviewAccess) } catch { return { ok: false, reason: COMPOSE_SHARE_REGISTRY_LOAD_ERROR } }
    return { ok: true, shares }
  }

  private saveRegistry(
    shares: ComposeShareRow[],
  ): { ok: true } | { ok: false; error: string } {
    const active = shares.filter(row => isShareActive(row))
    if (active.length > MAX_SHARES) return { ok: false, error: 'Too many Compose share links on this server' }
    const inactive = shares.filter(row => !isShareActive(row)).sort((a, b) => b.createdAt - a.createdAt)
    const trimmed = shares.length > MAX_SHARES ? [...active, ...inactive.slice(0, MAX_SHARES - active.length)] : shares
    const kept = new Set(trimmed.map(row => row.tokenHash))
    try {
      retainIndependentCheckpoint(dirname(this.registryPath),'compose-shares.json')
      for (const row of shares) if (!kept.has(row.tokenHash)) this.retiredTokens.retire(row.tokenHash)
      writeJson(this.registryPath, { shares: trimmed }, this.atRest)
      for (const row of shares) if (!kept.has(row.tokenHash)) this.unlinkPack(row.tokenHash)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: composeSharePageError(err, COMPOSE_SHARE_REGISTRY_STORE_ERROR) }
    }
  }

  /** Server callers must bind this capability to their current authenticated member. */
  management(localShareId: string, tokenHash: string, memberId: string, admin: boolean): { ok: boolean; exists: boolean } {
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, exists: true }
    const matches = loaded.shares.filter(row => row.localShareId === localShareId || (!!tokenHash && row.tokenHash === tokenHash))
    return { ok: matches.every(row => admin || row.ownerMemberId === memberId), exists: matches.length > 0 }
  }

  reviewById(localShareId: string): ComposeShareRow | null {
    const row = this.publication(localShareId)
    return row && isShareActive(row) && !this.retiredTokens.isRetired(row.tokenHash) ? row : null
  }

  commentVersion(row: ComposeShareRow): string {
    try { const s = statSync(join(this.payloadDir, row.tokenHash + '.comments.json')); return s.mtimeMs + ':' + s.size }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '0'; throw new Error('Comments are unavailable.') }
  }

  publication(localShareId: string): ComposeShareRow | null {
    const loaded = this.loadRegistryResult(); if (!loaded.ok) throw new Error(loaded.reason)
    return loaded.shares.find(row => row.localShareId === localShareId) ?? null
  }

  publications(documentId: string): ComposeShareRow[] {
    const loaded = this.loadRegistryResult(); if (!loaded.ok) throw new Error(loaded.reason)
    return loaded.shares.filter(row => row.documentId === documentId)
  }

  configureReview(row: ComposeShareRow, mutation: Record<string, unknown>) {
    const loaded = this.loadRegistryResult(); if (!loaded.ok) throw new Error(loaded.reason)
    const current = loaded.shares.find(r => r.tokenHash === row.tokenHash)
    if (!current || !isShareActive(current)) throw new Error('This review link is no longer active.')
    const access = structuredClone(reviewAccess(current.reviewAccess))
    if (mutation.expectedRevision !== access.revision) throw new Error('Review access changed. Refresh before saving.')
    if (mutation.mode !== undefined) { if (mutation.mode !== 'shared' && mutation.mode !== 'named') throw new Error('Choose a valid access mode.'); access.mode = mutation.mode }
    if (mutation.grant) {
      const input = mutation.grant as Record<string, unknown>, name = typeof input.name === 'string' ? input.name.trim() : '', id = typeof input.id === 'string' ? input.id : randomUUID()
      if (!name || name.length > 100 || !isPublicSharePasswordHash(input.passwordHash)) throw new Error('A reviewer name and a valid password are required.')
      const existing = access.grants.find(g => g.id === id)
      if (access.grants.some(g => !g.revoked && g.id !== id && g.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'))) throw new Error('This reviewer name is already in use. Change its password or choose another name.')
      if (input.id && !existing) throw new Error('Reviewer no longer exists. Refresh and try again.')
      if (existing) { existing.name = name; existing.passwordHash = input.passwordHash as string; existing.revoked = false }
      else access.grants.push({ id, name, passwordHash: input.passwordHash as string, revoked: false })
    }
    if (typeof mutation.revokeId === 'string') { const grant = access.grants.find(g => g.id === mutation.revokeId); if (!grant) throw new Error('Reviewer not found.'); grant.revoked = true }
    access.revision++; reviewAccess(access); current.reviewAccess = access; current.updatedAt = Date.now()
    const saved = this.saveRegistry(loaded.shares); if (!saved.ok) throw new Error(saved.error)
    return reviewAccessMeta(access)
  }

  /** A departed author cannot recover a published link by rejoining with a new ID. */
  reconcileOwners(memberIds: Set<string>, successorAdminId: string | undefined): { ok: boolean } {
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false }
    let changed = false
    for (const row of loaded.shares) {
      if (!isShareActive(row) || memberIds.has(row.ownerMemberId)) continue
      if (!successorAdminId) return { ok: false }
      row.ownerMemberId = successorAdminId
      row.updatedAt = Date.now()
      changed = true
    }
    return !changed ? { ok: true } : this.saveRegistry(loaded.shares)
  }

  /** Comments are scoped to a publication token, not editable source-board data. */
  comments(row: ComposeShareRow, after = 0): { comments: ComposeGuestComment[]; next: number | null } {
    const file = join(this.payloadDir, row.tokenHash + '.comments.json')
    const loaded = readGuestRegistryArray(file, this.atRest, 'comments')
    if (!loaded.ok) throw new Error('Comments are unavailable. Try again later.')
    const all = loaded.rows as ComposeGuestComment[]
    validateComments(all)
    const start = Math.max(0, Math.floor(after))
    return { comments: all.slice(start, start + 50), next: start + 50 < all.length ? start + 50 : null }
  }

  addComment(row: ComposeShareRow, input: { name: unknown; text: unknown; requestId: unknown; anchor?: unknown; author?: ReviewAuthor; parentId?: unknown }): ComposeGuestComment {
    if (!row.allowComments) throw new Error('Comments are disabled for this link.')
    const name = input.author?.name || (typeof input.name === 'string' ? input.name.trim() : '')
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    const key = typeof input.requestId === 'string' ? input.requestId : ''
    const anchor = commentAnchor(input.anchor)
    if (anchor && row.format !== 'pdf' && anchor.page !== 1) throw new Error('This image has only one page.')
    if (!name || name.length > 100 || !text || text.length > 5000 || !/^[a-zA-Z0-9_-]{16,80}$/.test(key)) throw new Error('Enter a name and a comment of up to 5000 characters.')
    const file = join(this.payloadDir, row.tokenHash + '.comments.json')
    const loaded = readGuestRegistryArray(file, this.atRest, 'comments')
    if (!loaded.ok) throw new Error('Comments are unavailable. Try again later.')
    const all = loaded.rows as ComposeGuestComment[]
    validateComments(all)
    const parentId = typeof input.parentId === 'string' && input.parentId ? input.parentId : null
    const parent = parentId ? all.find(c => c.id === parentId) : null
    if (parentId && !parent) throw new Error('The comment you are replying to is unavailable.')
    if (parent && anchor) throw new Error('Replies use the original comment’s pin.')
    const previous = all.find(c => c.requestId === key)
    if (previous) {
      if (previous.name !== name || previous.text !== text || (previous.parentId || null) !== parentId || previous.author?.id !== input.author?.id || JSON.stringify(previous.anchor || null) !== JSON.stringify(anchor)) throw new Error('This submission was already used. Refresh and try again.')
      // A retry may follow a failed directory flush after an atomic rename.
      try { confirmPrivateFile(file) } catch { throw new Error('Could not save the comment. Try again later.') }
      return previous
    }
    if (all.length >= 5000) throw new Error('This review is full. Ask the sender to start a new review link.')
    const id = randomUUID(), rootId = parent ? parent.rootId || parent.id : id
    const root = parent ? all.find(c => c.id === rootId) : null
    if (root?.resolvedAt) throw new Error('This thread is resolved. Reopen it before replying.')
    const comment: ComposeGuestComment = { id, rootId, name, text, createdAt: Date.now(), requestId: key, ...(anchor ? { anchor } : {}), ...(parentId ? { parentId } : {}), ...(input.author ? { author: input.author } : {}) }
    try { writeJson(file, { comments: [...all, comment] }, this.atRest) } catch { throw new Error('Could not save the comment. Try again later.') }
    return comment
  }

  resolveComment(row: ComposeShareRow, id: string, resolved: boolean, author: ReviewAuthor, moderate: boolean) {
    const file = join(this.payloadDir, row.tokenHash + '.comments.json'), loaded = readGuestRegistryArray(file, this.atRest, 'comments')
    if (!loaded.ok) throw new Error('Comments are unavailable. Try again later.')
    const all = loaded.rows as ComposeGuestComment[]; validateComments(all)
    const comment = all.find(c => c.id === id)
    if (!comment || comment.parentId) throw new Error('Choose an existing discussion thread.')
    if (!moderate && comment.author?.id !== author.id) throw new Error('Only the thread author or a board editor can resolve this thread.')
    comment.resolvedAt = resolved ? Date.now() : null; comment.resolvedBy = resolved ? author : null
    try { writeJson(file, { comments: all }, this.atRest) } catch { throw new Error('Could not update the thread. Try again later.') }
    return comment
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
      documentId?: string
      sourceRevision?: number
      allowComments?: boolean
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
    if (!['png', 'jpeg', 'svg', 'pdf'].includes(format)) return { ok: false, error: 'Unsupported share format' }
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
    try {
      if (prev && typeof prev.revokedAt === 'number' && prev.revokedAt > 0) this.retiredTokens.retire(prev.tokenHash)
      if (this.retiredTokens.isRetired(tokenHash)) return { ok: false, error: 'Compose share token was revoked; create a new link' }
    } catch { return { ok: false, error: GUEST_TOKEN_RETIREMENT_UNAVAILABLE } }
    if ((!prev || !isShareActive(prev)) && shares.filter(row => isShareActive(row)).length >= MAX_SHARES) {
      return { ok: false, error: 'Too many Compose share links on this server' }
    }
    if (prev && prev.tokenHash === tokenHash && isShareActive(prev)) {
      const previousBytes = this.readPackBytes(tokenHash)
      if (!previousBytes || !previousBytes.equals(args.packBytes) || prev.format !== format || prev.passwordHash !== args.passwordHash || prev.expiresAt !== args.expiresAt || (prev.sourceRevision !== undefined && args.sourceRevision !== undefined && prev.sourceRevision !== args.sourceRevision) || (args.documentId && prev.documentId && args.documentId !== prev.documentId) || (args.allowComments !== undefined && args.allowComments !== (prev.allowComments === true))) {
        return { ok: false, error: 'A published review is a fixed snapshot. Create a new link to change its content or access settings.' }
      }
    }
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
      ownerMemberId: prev?.ownerMemberId || capComposeShareScopeId(ownerMemberId, 128),
      documentId: args.documentId || prev?.documentId,
      sourceRevision: prev?.sourceRevision ?? args.sourceRevision,
      allowComments: args.allowComments ?? prev?.allowComments ?? false,
      ...(prev?.reviewAccess ? { reviewAccess: prev.reviewAccess } : {}),
      ...(stampedTeam ? { teamId: stampedTeam } : {}),
    }
    try {
      const p = payloadPath(this.payloadDir, tokenHash)
      if (!p) return { ok: false, error: 'token_hash must be sha256 hex' }
      // TCC-R1126-BRG-002: encrypt pack bytes at rest (registry JSON already did).
      const onDisk = this.atRest ? encryptBlobBody(this.atRest, args.packBytes) : args.packBytes
      writePrivateFile(p, onDisk)
    } catch (err) {
      return { ok: false, error: composeSharePageError(err, COMPOSE_SHARE_PACK_STORE_ERROR) }
    }
    try {
      if (prev && prev.tokenHash !== tokenHash) this.retiredTokens.retire(prev.tokenHash)
    } catch {
      if (prev?.tokenHash !== tokenHash) this.unlinkPack(tokenHash)
      return { ok: false, error: GUEST_TOKEN_RETIREMENT_UNAVAILABLE }
    }
    shares.push(row)
    const saved = this.saveRegistry(shares)
    if (!saved.ok) {
      if (prev?.tokenHash !== tokenHash) this.unlinkPack(tokenHash)
      return saved
    }
    if (prev && prev.tokenHash !== tokenHash) this.unlinkPack(prev.tokenHash)
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
    const row = idx >= 0 ? shares[idx]! : null
    try {
      const alreadyRetired = tokenHash ? this.retiredTokens.isRetired(tokenHash) : false
      if (tokenHash) this.retiredTokens.retire(tokenHash)
      // A delayed revoke of retired A must never close its replacement B.
      if (row && tokenHash && row.tokenHash !== tokenHash && alreadyRetired) return { ok: true }
      if (!row) return localId && tokenHash ? { ok: true } : { ok: false, error: 'Share not found' }
      this.retiredTokens.retire(row.tokenHash)
    } catch { return { ok: false, error: GUEST_TOKEN_RETIREMENT_UNAVAILABLE } }
    row.revokedAt = Date.now()
    row.updatedAt = row.revokedAt
    row.payloadReady = false
    shares[idx] = row
    const saved = this.saveRegistry(shares)
    if (!saved.ok) return saved
    this.unlinkPack(row.tokenHash)
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
    try {
      if (this.retiredTokens.isRetired(tokenHash)) return { row, active: false, reason: 'revoked' }
    } catch { return { row, active: false, reason: 'unreadable' } }
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

  private unlinkPack(tokenHash: string): void {
    try { const path = payloadPath(this.payloadDir, tokenHash); if (path) unlinkSync(path) } catch { /* best effort */ }
  }

  readPackBytes(tokenHash: string): Buffer | null {
    const p = payloadPath(this.payloadDir, tokenHash)
    if (!p || !existsSync(p)) return null
    try {
      if (this.retiredTokens.isRetired(tokenHash)) return null
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
    allow_comments: row.allowComments === true,
  }
}

export { verifyPublicSharePassword, isPublicSharePasswordHash }

export type ComposeCommentAnchor = { page: number; x: number; y: number; width: number; height: number }
export type ComposeGuestComment = { id: string; name: string; text: string; createdAt: number; requestId: string; anchor?: ComposeCommentAnchor; author?: ReviewAuthor; parentId?: string; rootId?: string; resolvedAt?: number | null; resolvedBy?: ReviewAuthor | null }

/** Normalized page coordinates remain stable across viewport size, zoom and pan. */
function commentAnchor(value: unknown): ComposeCommentAnchor | null {
  if (value === undefined || value === null) return null
  const a = value as ComposeCommentAnchor
  if (typeof a !== 'object' || Array.isArray(a) || !Number.isSafeInteger(a.page) || a.page < 1 ||
    ![a.x, a.y, a.width, a.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) ||
    a.x + a.width > 1 + 1e-10 || a.y + a.height > 1 + 1e-10) throw new Error('Choose an area inside the page.')
  return { page: a.page, x: a.x, y: a.y, width: a.width, height: a.height }
}

function validateComments(all: ComposeGuestComment[]): void {
  if (!all.every(c => c && typeof c.id === 'string' && typeof c.name === 'string' && typeof c.text === 'string' && Number.isFinite(c.createdAt))) throw new Error('Comments are unavailable. Try again later.')
  try { for (const c of all) commentAnchor(c.anchor) } catch { throw new Error('Comments are unavailable. Try again later.') }
}
