/**
 * P3-D portal registry + Form intake queue on the Team Space bridge.
 * Extends the P1-C /share/ host family with /portal/<token> guests.
 * Never store this in Directus / v-aid cloud - TEAMSPACE_DATA_DIR only.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AtRestKey,
  decryptJsonFile,
  encryptJsonFile,
} from './at-rest.js'
import { capStr, capTrim, normalizeTeamIdSegment } from './text-cap.js'

const REGISTRY_FILE = 'portals.json'
const PAYLOAD_DIR = 'portal-payloads'
const SUBMISSIONS_DIR = 'portal-submissions'
const OTP_PENDING_DIR = 'portal-otp-pending'
const PAYLOAD_JSON_MAX = 1_500_000
const MAX_PORTALS = 500
const MAX_PENDING_SUBMISSIONS = 2_000
const MAX_PENDING_OTP_SENDS = 200
const ANON_RATE_PER_WINDOW = 10
const ANON_RATE_WINDOW_MS = 60 * 60 * 1000
const OTP_EXPIRE_MS = 10 * 60 * 1000
const OTP_UNLOCK_MS = 30 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_REQUEST_RATE_PER_WINDOW = 5
const OTP_REQUEST_WINDOW_MS = 15 * 60 * 1000

/** One NUL-free segment, same ceiling as desktop `GUEST_LINK_TEAM_ID_MAX`. */
export const GUEST_STORE_TEAM_ID_MAX = 128
/** Local portal / owner / compose-share scope ids (TS-HOP-003). */
export const GUEST_STORE_SCOPE_ID_MAX = 128
/** Public-share local id stays the historic 64-char wire ceiling. */
export const GUEST_STORE_LOCAL_SHARE_ID_MAX = 64
export const GUEST_STORE_PORTAL_TEAM_MISMATCH = 'This portal belongs to another team'
export const GUEST_STORE_SHARE_TEAM_MISMATCH = 'This link belongs to another team'

export function capGuestStoreTeamId(raw: unknown): string {
  return normalizeTeamIdSegment(raw, GUEST_STORE_TEAM_ID_MAX)
}

/** Scope / member ids: NUL-cut (never join leftover), then cap. */
export function capGuestStoreScopeId(
  raw: unknown,
  max = GUEST_STORE_SCOPE_ID_MAX,
): string {
  return normalizeTeamIdSegment(raw, max)
}

/** Present file whose list is not an array. Missing file is empty, not this. */
export const GUEST_REGISTRY_UNREADABLE =
  'Guest link list could not be read. Restore from backup before changing links.'

const GUEST_REGISTRY_LIST_KEYS = new Set(['shares', 'portals'])

/**
 * Guest registry list. Missing file → empty. Present but not an array →
 * unreadable (never fold to `[]`, which a later save would persist as a wipe).
 */
export function readGuestRegistryArray(
  path: string,
  atRest: AtRestKey | null,
  listKey: 'shares' | 'portals',
): { ok: true; rows: unknown[] } | { ok: false; reason: string } {
  if (!GUEST_REGISTRY_LIST_KEYS.has(listKey)) {
    return { ok: false, reason: GUEST_REGISTRY_UNREADABLE }
  }
  if (!existsSync(path)) return { ok: true, rows: [] }
  let parsed: unknown
  try {
    const raw = readFileSync(path, 'utf8')
    parsed = decryptJsonFile<unknown>(atRest, raw, null)
  } catch {
    return { ok: false, reason: GUEST_REGISTRY_UNREADABLE }
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: GUEST_REGISTRY_UNREADABLE }
  }
  const rec = parsed as Record<string, unknown>
  if (!Object.prototype.hasOwnProperty.call(rec, listKey)) {
    return { ok: false, reason: GUEST_REGISTRY_UNREADABLE }
  }
  const rows = rec[listKey]
  if (!Array.isArray(rows)) {
    return { ok: false, reason: GUEST_REGISTRY_UNREADABLE }
  }
  return { ok: true, rows }
}

export function stampGuestRowTeamId<T extends { teamId?: string }>(row: T): T {
  const teamId = capGuestStoreTeamId(row.teamId)
  if (!teamId) {
    if (row.teamId == null) return row
    const next = { ...row }
    delete next.teamId
    return next
  }
  return { ...row, teamId }
}

export function mapGuestRegistryRows<T extends { teamId?: string }>(rows: unknown[]): T[] {
  const out: T[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue
    out.push(stampGuestRowTeamId(row as T))
  }
  return out
}

/** Dual-key HTTP/IPC bag. L06 must pass this into upsert/revoke. */
export function guestHttpBodyTeamId(body: Record<string, unknown> | null | undefined): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ''
  const camel = capGuestStoreTeamId(body.teamId)
  if (camel) return camel
  return capGuestStoreTeamId(body.team_id)
}

export function guestStoreTeamConflict(stored: unknown, caller: unknown): boolean {
  const s = capGuestStoreTeamId(stored)
  const c = capGuestStoreTeamId(caller)
  return Boolean(s && c && s !== c)
}

export function resolveGuestStoreStamp(stored: unknown, caller: unknown): string | undefined {
  const s = capGuestStoreTeamId(stored)
  const c = capGuestStoreTeamId(caller)
  const next = c || s
  return next || undefined
}

export function findGuestRegistryIndex<T extends { tokenHash: string; teamId?: string | null }>(
  rows: T[],
  opts: {
    tokenHash: string
    localId: string
    localOf: (row: T) => string
    callerTeam: string
  },
): { idx: number; otherTeam: boolean } {
  let otherTeam = false
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const idMatch =
      (opts.tokenHash && row.tokenHash === opts.tokenHash) ||
      (opts.localId && opts.localOf(row) === opts.localId)
    if (!idMatch) continue
    if (guestStoreTeamConflict(row.teamId, opts.callerTeam)) {
      otherTeam = true
      continue
    }
    return { idx: i, otherTeam: false }
  }
  return { idx: -1, otherTeam }
}

export type PortalAuthMode = 'pin' | 'anonymous' | 'magic_link'

export type PortalRow = {
  tokenHash: string
  localPortalId: string
  name: string
  authMode: PortalAuthMode
  pinHash: string | null
  allowedActions: string[]
  expiresAt: number | null
  revokedAt: number | null
  payloadReady: boolean
  createdAt: number
  updatedAt: number
  ownerMemberId: string
  /**
   * Optional stamp from desktop `team_id`. Blank / omitted is leftover
   * (one-team process, pre-isolation rows). A named stamp must match the
   * caller or register/revoke refuse.
   */
  teamId?: string
}

export type PortalPayload = {
  version: 1
  portalId: string
  name: string
  entityId: string
  authMode: PortalAuthMode
  allowedActions: string[]
  design: Record<string, unknown>
  aclSnapshot: {
    hiddenSlugs?: string[]
    allowedFieldSlugs?: string[] | null
    accessTemplateId?: string | null
  }
  fields: Array<{
    slug: string
    name: string
    field_type: string
    required: boolean
    config: Record<string, unknown>
    default_value: string | null
  }>
  pushedAt: number
}

export type PortalSubmission = {
  id: string
  localPortalId: string
  entityId: string
  data: Record<string, unknown>
  contactLabel: string | null
  status: 'pending' | 'applied' | 'rejected'
  error: string | null
  createdAt: number
  updatedAt: number
  /** TCC-R1150-BKP-001: short lease so overlapping drains cannot dual-apply. */
  claimedAt?: number | null
}

type AnonBucket = { count: number; refillAt: number }

export type OtpPendingSend = {
  id: string
  tokenHash: string
  email: string
  portalName: string
  codePlain: string
  codeHash: string
  expiresAt: number
  createdAt: number
  /** TCC-R1145-BKP-001: short lease so overlapping drains cannot dual-email. */
  claimedAt?: number | null
  /**
   * Named stamp from the portal row. Omit / blank (`''`) is leftover
   * (pre-isolation). Admin list/count with a named team sees only that
   * team; omit sees leftover only (TCC-FIX-SHARE-013).
   */
  teamId?: string
}

const OTP_CLAIM_LEASE_MS = 2 * 60 * 1000
const SUBMISSION_CLAIM_LEASE_MS = 5 * 60 * 1000

type OtpChallenge = {
  codeHash: string
  expiresAt: number
  attempts: number
}

type OtpUnlock = {
  email: string
  expiresAt: number
}

function ensureDir(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
}

function atomicWriteJson(path: string, data: unknown, atRest: AtRestKey | null): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  const body = atRest
    ? encryptJsonFile(atRest, data)
    : JSON.stringify(data, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
}

function readJsonFile<T>(path: string, atRest: AtRestKey | null, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    const raw = readFileSync(path, 'utf8')
    return decryptJsonFile<T>(atRest, raw, fallback) ?? fallback
  } catch {
    return fallback
  }
}

export function hashPortalTokenPlain(tokenPlain: string): string {
  return createHash('sha256').update(tokenPlain, 'utf8').digest('hex')
}

/** Guest email: cap then lower (TS-CHAT-032/034/042 - never raw `.slice`). */
function normalizeOtpEmail(email: unknown): string {
  return capTrim(email, 320).toLowerCase()
}

/**
 * TCC-FIX-SHARE-013 drain/ack/count. Named caller sees that team only.
 * Omit / blank sees leftover '' only (never every team).
 */
function guestStoreTeamMatchesScope(stored: unknown, caller: unknown): boolean {
  const s = capGuestStoreTeamId(stored)
  const c = capGuestStoreTeamId(caller)
  if (c) return s === c
  return !s
}

/** Named scope = that team only. Blank / omit = leftover only. */
function otpPendingMatchesTeam(
  row: { teamId?: unknown } | null | undefined,
  callerTeam: unknown,
): boolean {
  return guestStoreTeamMatchesScope(row?.teamId, callerTeam)
}

function hashOtpCode(code: string, tokenHash: string, email: string): string {
  return createHash('sha256')
    .update(`${code}:${tokenHash}:${normalizeOtpEmail(email)}`, 'utf8')
    .digest('hex')
}

function mintOtpCode(): string {
  const n = randomBytes(4).readUInt32BE(0) % 1_000_000
  return String(n).padStart(6, '0')
}

/**
 * TCC-R1134-PRT-001: `ackOtpSend`/`ackSubmission` build a filesystem path
 * from a caller-supplied id (`${id}.json` under a fixed directory) with no
 * validation that `id` only contains the hex characters every real id is
 * minted with (`randomBytes(16).toString('hex')`) - an admin-authenticated
 * but crafted `id`/`submission_id` containing `../` segments could read or
 * (once TCC-R1133-PRT-003 below makes ack delete the file) DELETE an
 * arbitrary `.json` file elsewhere under the data directory. Mirrors the
 * hex-only sanitizer `public-share-store.ts`'s `ackSubmission` already
 * uses for the same class of id.
 */
function sanitizeHexId(raw: unknown, maxLen = 64): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/[^a-f0-9]/gi, '').slice(0, maxLen)
}

/**
 * TCC-R1133-PRT-002: soft cap + sweep shared by every in-memory session Map
 * on this store (`otpRequestBuckets`, `otpChallenges`, `otpUnlocks`, plus
 * the pre-existing `anonBuckets`). Without this, many concurrent guest
 * sessions that each request/verify an OTP once and never come back leave
 * their entry resident forever - only `isOtpUnlocked`'s own-key expiry
 * check and `verifyOtp`'s success/expiry paths ever delete an entry, and
 * only for the exact key being looked up right now, not proactively. Call
 * after every `.set()` on one of these maps: first drops already-expired
 * entries (up to one sweep batch), then - only if still over the soft cap
 * after that - evicts oldest-inserted entries (Map preserves insertion
 * order) as a last resort so the map can never grow unbounded even under
 * an adversarial flood of never-revisited sessions.
 */
export const OTP_SESSION_MAP_SOFT_CAP = 10_000
export const OTP_SESSION_MAP_SWEEP_BATCH = 1_000

export function pruneSessionMapOverCap<K, V>(
  map: Map<K, V>,
  now: number,
  getExpiresAt: (v: V) => number,
): void {
  if (map.size <= OTP_SESSION_MAP_SOFT_CAP) return
  let n = 0
  for (const [k, v] of map) {
    if (now >= getExpiresAt(v)) {
      map.delete(k)
      if (++n >= OTP_SESSION_MAP_SWEEP_BATCH) return
    }
  }
  if (map.size > OTP_SESSION_MAP_SOFT_CAP) {
    for (const k of map.keys()) {
      map.delete(k)
      if (++n >= OTP_SESSION_MAP_SWEEP_BATCH) return
    }
  }
}

function isPortalActive(row: PortalRow, now = Date.now()): boolean {
  if (typeof row.revokedAt === 'number' && row.revokedAt > 0) return false
  if (typeof row.expiresAt === 'number' && row.expiresAt > 0 && now >= row.expiresAt) {
    return false
  }
  return true
}

function portalDeadAt(row: PortalRow): number {
  const rev = typeof row.revokedAt === 'number' && row.revokedAt > 0 ? row.revokedAt : 0
  const exp = typeof row.expiresAt === 'number' && row.expiresAt > 0 ? row.expiresAt : 0
  const updated = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
  return Math.max(rev, exp, updated)
}

function isPortalRevoked(row: PortalRow): boolean {
  return typeof row.revokedAt === 'number' && row.revokedAt > 0
}

function isPortalPayload(raw: unknown): raw is PortalPayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  if (o.version !== 1) return false
  if (typeof o.portalId !== 'string' || typeof o.name !== 'string') return false
  if (typeof o.entityId !== 'string' || !o.entityId.trim()) return false
  if (o.authMode !== 'pin' && o.authMode !== 'anonymous' && o.authMode !== 'magic_link') {
    return false
  }
  if (!Array.isArray(o.allowedActions) || !Array.isArray(o.fields)) return false
  if (!o.design || typeof o.design !== 'object' || Array.isArray(o.design)) return false
  if (!o.aclSnapshot || typeof o.aclSnapshot !== 'object' || Array.isArray(o.aclSnapshot)) {
    return false
  }
  const acl = o.aclSnapshot as Record<string, unknown>
  if (acl.hiddenSlugs !== undefined && !Array.isArray(acl.hiddenSlugs)) return false
  if (
    acl.allowedFieldSlugs !== undefined
    && acl.allowedFieldSlugs !== null
    && !Array.isArray(acl.allowedFieldSlugs)
  ) {
    return false
  }
  return true
}

/** Form cells: capStr (TS-CHAT-032/034/042 - never raw `.slice`). */
function acceptGuestFieldValue(v: unknown): unknown {
  if (typeof v === 'string') return capStr(v, 10_000)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v
  if (v === null) return null
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (let i = 0; i < v.length && i < 100; i += 1) {
      const item = v[i]
      if (typeof item === 'string' && item.trim()) parts.push(capStr(item, 200))
      else if (typeof item === 'number' && Number.isFinite(item)) parts.push(String(item))
      else if (typeof item === 'boolean') parts.push(String(item))
    }
    return capStr(parts.join(', '), 10_000)
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['name', 'label', 'title', 'display', 'value', 'id'] as const) {
      const x = o[key]
      if (typeof x === 'string' && x.trim()) return capStr(x, 10_000)
      if (typeof x === 'number' && Number.isFinite(x)) return String(x)
    }
  }
  return undefined
}

export function verifyPortalPin(
  stored: string | null | undefined,
  attempt: string | null | undefined,
): boolean {
  // TCC-R1149-BKP-002: pin mode with missing hash must fail closed (never unlock).
  if (!stored) return false
  if (typeof attempt !== 'string' || !attempt) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 's') return false
  const saltHex = parts[1] ?? ''
  const hashHex = parts[2] ?? ''
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false
  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const got = scryptSync(attempt, salt, expected.length, { N: 16384, r: 8, p: 1 })
    if (got.length !== expected.length) return false
    return timingSafeEqual(got, expected)
  } catch {
    return false
  }
}

export function toPortalMeta(row: PortalRow): Record<string, unknown> {
  const teamId = capGuestStoreTeamId(row.teamId)
  return {
    local_portal_id: row.localPortalId,
    name: row.name,
    auth_mode: row.authMode,
    needs_pin: row.authMode === 'pin',
    allowed_actions: row.allowedActions,
    payload_ready: row.payloadReady,
    revoked: typeof row.revokedAt === 'number' && row.revokedAt > 0,
    ...(teamId ? { team_id: teamId } : {}),
  }
}

export class PortalBridgeStore {
  private readonly registryPath: string
  private readonly payloadDir: string
  private readonly submissionsDir: string
  private readonly otpPendingDir: string
  private readonly atRest: AtRestKey | null
  private readonly anonBuckets = new Map<string, AnonBucket>()
  private readonly otpRequestBuckets = new Map<string, AnonBucket>()
  private readonly otpChallenges = new Map<string, OtpChallenge>()
  private readonly otpUnlocks = new Map<string, OtpUnlock>()

  constructor(dataDir: string, atRest: AtRestKey | null = null) {
    this.registryPath = join(dataDir, REGISTRY_FILE)
    this.payloadDir = join(dataDir, PAYLOAD_DIR)
    this.submissionsDir = join(dataDir, SUBMISSIONS_DIR)
    this.otpPendingDir = join(dataDir, OTP_PENDING_DIR)
    this.atRest = atRest
    ensureDir(dataDir)
    ensureDir(this.payloadDir)
    ensureDir(this.submissionsDir)
    ensureDir(this.otpPendingDir)
  }

  private otpChallengeKey(tokenHash: string, email: string): string {
    return `${tokenHash}:${normalizeOtpEmail(email)}`
  }

  private otpUnlockKey(tokenHash: string, sessionId: string): string {
    return `${tokenHash}:${capTrim(sessionId, 128)}`
  }

  private takeOtpRequestRate(ipKey: string): boolean {
    const k = capStr(String(ipKey || 'unknown'), 128)
    const now = Date.now()
    let b = this.otpRequestBuckets.get(k)
    if (!b || now >= b.refillAt) {
      b = { count: 0, refillAt: now + OTP_REQUEST_WINDOW_MS }
      this.otpRequestBuckets.set(k, b)
    }
    if (b.count >= OTP_REQUEST_RATE_PER_WINDOW) return false
    b.count += 1
    pruneSessionMapOverCap(this.otpRequestBuckets, now, (v) => v.refillAt)
    return true
  }

  isOtpUnlocked(
    tokenHash: string,
    sessionId: string | null | undefined,
    email?: string | null,
  ): boolean {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!sid) return false
    const key = this.otpUnlockKey(tokenHash, sid)
    const row = this.otpUnlocks.get(key)
    if (!row) return false
    if (Date.now() >= row.expiresAt) {
      this.otpUnlocks.delete(key)
      return false
    }
    // TCC-R1148-BKP-002: unlock is bound to the verified email, not session alone.
    if (email != null && String(email).trim()) {
      const want = normalizeOtpEmail(email)
      if (!want || row.email !== want) return false
    }
    return true
  }

  getOtpUnlockEmail(tokenHash: string, sessionId: string | null | undefined): string | null {
    const sid = typeof sessionId === 'string' ? sessionId.trim() : ''
    if (!sid) return null
    const row = this.otpUnlocks.get(this.otpUnlockKey(tokenHash, sid))
    if (!row) return null
    if (Date.now() >= row.expiresAt) {
      this.otpUnlocks.delete(this.otpUnlockKey(tokenHash, sid))
      return null
    }
    return row.email
  }

  requestOtp(args: {
    row: PortalRow
    email: string
    clientIp?: string
  }):
    | { ok: true }
    | { ok: false; error: string; error_code: string; status: number } {
    if (!isPortalActive(args.row)) {
      const revoked = isPortalRevoked(args.row)
      return {
        ok: false,
        error: revoked ? 'This portal is no longer available' : 'This portal has expired',
        error_code: revoked ? 'portal.revoked' : 'portal.expired',
        status: 410,
      }
    }
    if (args.row.authMode !== 'magic_link') {
      return {
        ok: false,
        error: 'This portal does not use email sign-in',
        error_code: 'portal.otp_not_supported',
        status: 400,
      }
    }
    const email = normalizeOtpEmail(args.email)
    if (!email || !email.includes('@') || email.length < 5) {
      return {
        ok: false,
        error: 'Enter a valid email address',
        error_code: 'portal.invalid_email',
        status: 400,
      }
    }
    if (!this.takeOtpRequestRate(args.clientIp || 'unknown')) {
      return {
        ok: false,
        error: 'Too many code requests. Try again later.',
        error_code: 'portal.otp_rate_limited',
        status: 429,
      }
    }

    // TCC-R1132-BRG-001: listPendingOtpSends() hard-caps its return length at
    // 100 (Admin page size) regardless of the limit argument, so this probe
    // against MAX_PENDING_OTP_SENDS (200) could never actually reach the
    // real ceiling and otp_queue_full could never fire. Count uncapped by
    // the page-size ceiling instead; keep listPendingOtpSends() itself
    // capped at 100 for the Admin list UI.
    const pendingOtpCount = this.countPendingOtpSends(MAX_PENDING_OTP_SENDS, args.row.teamId)
    if (pendingOtpCount >= MAX_PENDING_OTP_SENDS) {
      return {
        ok: false,
        error: 'Too many pending codes. Try again later.',
        error_code: 'portal.otp_queue_full',
        status: 503,
      }
    }

    // TCC-R1147-BKP-001: challenge overwrite must also drop prior pending files
    // for the same (tokenHash, email) or the mail queue piles forever.
    this.scrubPendingOtpForEmail(args.row.tokenHash, email)
    const codePlain = mintOtpCode()
    const now = Date.now()
    const expiresAt = now + OTP_EXPIRE_MS
    const codeHash = hashOtpCode(codePlain, args.row.tokenHash, email)
    const id = randomBytes(16).toString('hex')
    const send: OtpPendingSend = {
      id,
      tokenHash: args.row.tokenHash,
      email,
      portalName: args.row.name,
      codePlain,
      codeHash,
      expiresAt,
      createdAt: now,
      teamId: capGuestStoreTeamId(args.row.teamId),
    }
    atomicWriteJson(join(this.otpPendingDir, `${id}.json`), send, this.atRest)
    this.otpChallenges.set(this.otpChallengeKey(args.row.tokenHash, email), {
      codeHash,
      expiresAt,
      attempts: 0,
    })
    pruneSessionMapOverCap(this.otpChallenges, now, (v) => v.expiresAt)
    return { ok: true }
  }

  verifyOtp(args: {
    tokenHash: string
    email: string
    code: string
    sessionId: string
  }):
    | { ok: true; unlocked: true }
    | { ok: false; error: string; error_code: string; status: number } {
    const email = normalizeOtpEmail(args.email)
    const code = capTrim(args.code, 12)
    const sessionId = capTrim(args.sessionId, 128)
    if (!email || !code || !sessionId) {
      return {
        ok: false,
        error: 'Email, code, and session are required',
        error_code: 'portal.otp_missing_fields',
        status: 400,
      }
    }
    const key = this.otpChallengeKey(args.tokenHash, email)
    const challenge = this.otpChallenges.get(key)
    if (!challenge) {
      return {
        ok: false,
        error: 'No code was requested for this email. Send a new code first.',
        error_code: 'portal.otp_not_requested',
        status: 400,
      }
    }
    if (Date.now() >= challenge.expiresAt) {
      this.otpChallenges.delete(key)
      return {
        ok: false,
        error: 'This code expired. Send a new code.',
        error_code: 'portal.otp_expired',
        status: 401,
      }
    }
    if (challenge.attempts >= OTP_MAX_ATTEMPTS) {
      return {
        ok: false,
        error: 'Too many wrong attempts. Send a new code.',
        error_code: 'portal.otp_attempts_exceeded',
        status: 429,
      }
    }
    challenge.attempts += 1
    const got = hashOtpCode(code, args.tokenHash, email)
    if (got !== challenge.codeHash) {
      return {
        ok: false,
        error: 'Wrong code. Try again.',
        error_code: 'portal.otp_wrong',
        status: 401,
      }
    }
    this.otpChallenges.delete(key)
    const unlockExpiresAt = Date.now() + OTP_UNLOCK_MS
    this.otpUnlocks.set(this.otpUnlockKey(args.tokenHash, sessionId), {
      email,
      expiresAt: unlockExpiresAt,
    })
    pruneSessionMapOverCap(this.otpUnlocks, Date.now(), (v) => v.expiresAt)
    return { ok: true, unlocked: true }
  }

  /**
   * Admin drain of pending OTP mail. Named `teamId` is that team only.
   * Omit / blank is leftover only - never every team's live codes.
   */
  listPendingOtpSends(limit = 50, teamId?: unknown): OtpPendingSend[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    ensureDir(this.otpPendingDir)
    const names = readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))
    const now = Date.now()
    const loaded = this.loadResult()
    if (!loaded.ok) return []
    const byHash = new Map(loaded.portals.map((p) => [p.tokenHash, p] as const))
    const all: Array<{ path: string; row: OtpPendingSend }> = []
    for (const name of names) {
      const path = join(this.otpPendingDir, name)
      const raw = readJsonFile<OtpPendingSend | null>(path, this.atRest, null)
      if (!raw || typeof raw.codePlain !== 'string' || !raw.codePlain) continue
      if (typeof raw.expiresAt === 'number' && raw.expiresAt > 0 && now >= raw.expiresAt) {
        try {
          unlinkSync(path)
        } catch {
          /* */
        }
        continue
      }
      const parent = typeof raw.tokenHash === 'string' ? byHash.get(raw.tokenHash) : undefined
      if (parent && !isPortalActive(parent, now)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      // Other-team live rows stay on disk (do not drop silently).
      if (!otpPendingMatchesTeam(raw, teamId)) continue
      // TCC-R1145-BKP-001: skip rows under an active lease from another drain.
      const claimedAt =
        typeof raw.claimedAt === 'number' && Number.isFinite(raw.claimedAt) ? raw.claimedAt : 0
      if (claimedAt > 0 && now - claimedAt < OTP_CLAIM_LEASE_MS) continue
      all.push({ path, row: raw })
    }
    // TCC-R1146-BKP-002: sort ALL live pending oldest-first, THEN page.
    all.sort((a, b) => a.row.createdAt - b.row.createdAt)
    const out: OtpPendingSend[] = []
    for (const item of all.slice(0, cap)) {
      const claimed: OtpPendingSend = { ...item.row, claimedAt: now }
      try {
        atomicWriteJson(item.path, claimed, this.atRest)
      } catch {
        continue
      }
      out.push(claimed)
    }
    return out
  }

  /**
   * TCC-R1132-BRG-001: uncapped-by-Admin-page-size count for the real
   * `otp_queue_full` ceiling probe (`requestOtp`). Also drops expired
   * entries as it scans (same as listPendingOtpSends) so a stale backlog of
   * expired codes cannot itself trip the ceiling. Stops scanning once it has
   * confirmed `ceiling + 1` live pending sends. Named `teamId` counts that
   * team only. Omit / blank counts leftover only (never every team).
   */
  private countPendingOtpSends(ceiling: number, teamId?: unknown): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    ensureDir(this.otpPendingDir)
    let names: string[] = []
    try {
      names = readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    const now = Date.now()
    const loaded = this.loadResult()
    if (!loaded.ok) return stopAt
    const byHash = new Map(loaded.portals.map((p) => [p.tokenHash, p] as const))
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const path = join(this.otpPendingDir, name)
      const raw = readJsonFile<OtpPendingSend | null>(path, this.atRest, null)
      if (!raw || typeof raw.codePlain !== 'string' || !raw.codePlain) continue
      if (typeof raw.expiresAt === 'number' && raw.expiresAt > 0 && now >= raw.expiresAt) {
        try {
          unlinkSync(path)
        } catch {
          /* */
        }
        continue
      }
      const parent = typeof raw.tokenHash === 'string' ? byHash.get(raw.tokenHash) : undefined
      // Only unlink when the parent exists and is dead. A missing parent is
      // still a real pending file (queue_full seeds, in-memory enqueue).
      if (parent && !isPortalActive(parent, now)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      if (!otpPendingMatchesTeam(raw, teamId)) continue
      count += 1
    }
    return count
  }

  /**
   * TCC-R1134-PRT-003: same class as `ackSubmission` (TCC-R1133-PRT-003) -
   * an acked OTP send used to be REWRITTEN with `codePlain: ''` instead of
   * removed, so `portal-otp-pending/` grew by one file per guest sign-in
   * attempt forever. Nothing ever reads a blanked row back
   * (`listPendingOtpSends`/`countPendingOtpSends` both skip any row whose
   * `codePlain` is falsy), so the acked file only added dead weight to
   * every future `readdirSync` + decrypt scan of that directory. Unlink
   * instead, mirroring the submissions fix.
   */
  ackOtpSend(args: {
    id: string
    teamId?: unknown
    team_id?: unknown
  }): { ok: true } | { ok: false; error: string } {
    const id = sanitizeHexId(args.id)
    if (!id) return { ok: false, error: 'id required' }
    const path = join(this.otpPendingDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Not found' }
    const raw = readJsonFile<OtpPendingSend | null>(path, this.atRest, null)
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    if (!otpPendingMatchesTeam(raw, callerTeam)) {
      return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
    }
    try {
      unlinkSync(path)
    } catch (err) {
      // TS-SEC2-008: log the throw; the page gets a sentence we own.
      console.error(
        `[bridge] Could not remove OTP send: ${
          err instanceof Error ? capStr(err.message, 200) : 'error'
        }`,
      )
      return { ok: false, error: 'Could not remove OTP send' }
    }
    return { ok: true }
  }

  private loadResult(): { ok: true; portals: PortalRow[] } | { ok: false; reason: string } {
    const loaded = readGuestRegistryArray(this.registryPath, this.atRest, 'portals')
    if (!loaded.ok) return loaded
    const portals = mapGuestRegistryRows<PortalRow>(loaded.rows).map((row) => ({
      ...row,
      localPortalId: capGuestStoreScopeId(row.localPortalId),
      ownerMemberId: capGuestStoreScopeId(row.ownerMemberId),
    }))
    return { ok: true, portals }
  }

  private unlinkPayloadFile(tokenHash: string): void {
    const h = typeof tokenHash === 'string' ? tokenHash.toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(h)) return
    try {
      const p = join(this.payloadDir, `${h}.json`)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
  }

  private scrubSubmissionsForLocalPortalId(localPortalId: string): void {
    const id = capGuestStoreScopeId(localPortalId)
    if (!id) return
    ensureDir(this.submissionsDir)
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    for (const name of names) {
      const path = join(this.submissionsDir, name)
      const raw = readJsonFile<PortalSubmission | null>(path, this.atRest, null)
      if (raw && typeof raw.localPortalId === 'string' && raw.localPortalId === id) {
        try {
          unlinkSync(path)
        } catch {
          /* best-effort */
        }
      }
    }
  }

  private sweepOrphanPayloads(keptHashes: Set<string>): void {
    let names: string[] = []
    try {
      names = readdirSync(this.payloadDir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        try {
          unlinkSync(join(this.payloadDir, name))
        } catch {
          /* best-effort */
        }
        continue
      }
      if (!name.endsWith('.json')) continue
      const hash = name.slice(0, -5).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(hash)) continue
      if (!keptHashes.has(hash)) this.unlinkPayloadFile(hash)
    }
  }

  private save(portals: PortalRow[]): void {
    // TCC-R1153-BKP-002: GC revoked AND expired tombstones before the silent
    // 500-cap so lifetime publish+unpublish (or expiry) cannot drop a
    // still-active row. Dropped rows unlink payload + leftover intake.
    const now = Date.now()
    const live: PortalRow[] = []
    const dead: PortalRow[] = []
    for (const p of portals) {
      if (isPortalActive(p, now)) live.push(p)
      else dead.push(p)
    }
    for (const row of dead) {
      if (row.payloadReady) row.payloadReady = false
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalPortalId(row.localPortalId)
      this.scrubOtpStateForToken(row.tokenHash)
    }
    dead.sort((a, b) => portalDeadAt(b) - portalDeadAt(a))
    const room = Math.max(0, MAX_PORTALS - live.length)
    const keptDead = dead.slice(0, room)
    const dropped = [
      ...live.slice(MAX_PORTALS),
      ...dead.slice(room),
    ]
    const capped = [...live.slice(0, MAX_PORTALS), ...keptDead].slice(0, MAX_PORTALS)
    atomicWriteJson(this.registryPath, { portals: capped }, this.atRest)
    const keptHashes = new Set(capped.map((p) => p.tokenHash))
    for (const row of dropped) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalPortalId(row.localPortalId)
    }
    this.sweepOrphanPayloads(keptHashes)
  }

  upsertPortal(
    ownerMemberId: string,
    args: {
      tokenHash: string
      localPortalId: string
      name: string
      authMode: PortalAuthMode
      pinHash: string | null
      allowedActions: string[]
      expiresAt?: number | null
      payload?: unknown
      teamId?: unknown
      team_id?: unknown
    },
  ): { ok: true; row: PortalRow } | { ok: false; error: string } {
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.trim().toLowerCase() : ''
    const localPortalId = capGuestStoreScopeId(args.localPortalId)
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'token_hash must be sha256 hex' }
    }
    if (!localPortalId) return { ok: false, error: 'local_portal_id required' }
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''

    const loaded = this.loadResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const portals = loaded.portals
    const now = Date.now()
    const found = findGuestRegistryIndex(portals, {
      tokenHash,
      localId: localPortalId,
      localOf: (p) => p.localPortalId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
    }
    const idx = found.idx
    const prev = idx >= 0 ? portals[idx] : null
    const stampedTeam = resolveGuestStoreStamp(prev?.teamId, callerTeam)
    const addingLive = !prev || !isPortalActive(prev, now)
    if (addingLive) {
      const liveCount = portals.filter((p) => isPortalActive(p, now)).length
      if (liveCount >= MAX_PORTALS) {
        return { ok: false, error: 'Too many portals on this server' }
      }
    }
    const row: PortalRow = {
      tokenHash,
      localPortalId,
      name: capTrim(args.name, 120) || 'Portal',
      authMode: args.authMode,
      pinHash: args.pinHash,
      allowedActions: Array.isArray(args.allowedActions)
        ? args.allowedActions.filter((a) => typeof a === 'string').slice(0, 8)
        : ['create'],
      expiresAt:
        typeof args.expiresAt === 'number' && Number.isFinite(args.expiresAt)
          ? args.expiresAt
          : null,
      revokedAt: null,
      payloadReady: false,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      ownerMemberId: capGuestStoreScopeId(ownerMemberId),
      ...(stampedTeam ? { teamId: stampedTeam } : {}),
    }

    if (args.payload != null) {
      const set = this.writePayloadFile(tokenHash, args.payload)
      if (!set.ok) return set
      row.payloadReady = true
    } else if (prev?.payloadReady) {
      // Re-publish without payload keeps prior payload file if hash unchanged.
      const sameHash = prev.tokenHash === tokenHash
      row.payloadReady = sameHash && existsSync(join(this.payloadDir, `${tokenHash}.json`))
    }

    if (idx >= 0) {
      // Drop old payload if token rotated.
      if (prev && prev.tokenHash !== tokenHash) {
        try {
          unlinkSync(join(this.payloadDir, `${prev.tokenHash}.json`))
        } catch {
          /* */
        }
        // TCC-R1148-BKP-001: rotate must scrub OTP state for the prior hash.
        this.scrubOtpStateForToken(prev.tokenHash)
      }
      portals[idx] = row
    } else {
      portals.unshift(row)
    }
    this.save(portals)
    return { ok: true, row }
  }

  private writePayloadFile(
    tokenHash: string,
    payload: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (!isPortalPayload(payload)) return { ok: false, error: 'Invalid payload' }
    let json: string
    try {
      json = JSON.stringify(payload)
    } catch {
      return { ok: false, error: 'Invalid payload' }
    }
    if (json.length > PAYLOAD_JSON_MAX) {
      return { ok: false, error: 'Payload too large' }
    }
    const h = tokenHash.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(h)) return { ok: false, error: 'token_hash must be sha256 hex' }
    atomicWriteJson(join(this.payloadDir, `${h}.json`), payload, this.atRest)
    return { ok: true }
  }

  writePayload(
    tokenHash: string,
    payload: unknown,
    team?: unknown,
  ): { ok: true } | { ok: false; error: string } {
    const h = typeof tokenHash === 'string' ? tokenHash.trim().toLowerCase() : ''
    const callerTeam = resolveGuestStoreStamp(undefined, team) ?? ''
    const loaded = this.loadResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const portals = loaded.portals
    const found = findGuestRegistryIndex(portals, {
      tokenHash: h,
      localId: '',
      localOf: (p) => p.localPortalId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
    }
    const existing = found.idx >= 0 ? portals[found.idx] : null
    if (!existing || !isPortalActive(existing)) {
      return { ok: false, error: existing ? 'Portal is not active' : 'Portal not found' }
    }
    const wrote = this.writePayloadFile(h, payload)
    if (!wrote.ok) return wrote
    const idx = found.idx
    if (idx >= 0) {
      portals[idx] = {
        ...portals[idx],
        payloadReady: true,
        updatedAt: Date.now(),
      }
      this.save(portals)
    }
    return { ok: true }
  }

  revokePortal(args: {
    localPortalId?: string
    tokenHash?: string
    teamId?: unknown
    team_id?: unknown
  }): { ok: true } | { ok: false; error: string } {
    const loaded = this.loadResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const portals = loaded.portals
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.trim().toLowerCase() : ''
    const localPortalId = capGuestStoreScopeId(args.localPortalId)
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const found = findGuestRegistryIndex(portals, {
      tokenHash,
      localId: localPortalId,
      localOf: (p) => p.localPortalId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
    }
    const idx = found.idx
    if (idx < 0) return { ok: false, error: 'Portal not found' }
    const row = portals[idx]
    const rowTokenHash = row.tokenHash
    portals[idx] = {
      ...row,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
      payloadReady: false,
    }
    this.save(portals)
    // TCC-R1150-BKP-003: unlink guest form payload on revoke.
    this.unlinkPayloadFile(rowTokenHash)
    // Revoke hid these from owner listPending (!revokedAt) but they still
    // counted toward queue_full until ack. Unlink so they cannot pin the cap.
    this.scrubSubmissionsForLocalPortalId(row.localPortalId)
    // TCC-R1147-BKP-002: scrub OTP challenge / unlock / pending mail for this portal.
    this.scrubOtpStateForToken(rowTokenHash)
    return { ok: true }
  }

  private scrubPendingOtpForEmail(tokenHash: string, email: string): void {
    const th = typeof tokenHash === 'string' ? tokenHash.toLowerCase() : ''
    const em = normalizeOtpEmail(email)
    if (!th || !em) return
    ensureDir(this.otpPendingDir)
    try {
      for (const name of readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))) {
        const path = join(this.otpPendingDir, name)
        const raw = readJsonFile<OtpPendingSend | null>(path, this.atRest, null)
        if (
          raw
          && typeof raw.tokenHash === 'string'
          && raw.tokenHash.toLowerCase() === th
          && normalizeOtpEmail(raw.email) === em
        ) {
          try { unlinkSync(path) } catch { /* */ }
        }
      }
    } catch { /* */ }
  }

  private scrubOtpStateForToken(tokenHash: string): void {
    const th = typeof tokenHash === 'string' ? tokenHash.toLowerCase() : ''
    if (!th) return
    const prefix = `${th}:`
    for (const key of [...this.otpChallenges.keys()]) {
      if (String(key).startsWith(prefix)) this.otpChallenges.delete(key)
    }
    for (const key of [...this.otpUnlocks.keys()]) {
      if (String(key).startsWith(prefix)) this.otpUnlocks.delete(key)
    }
    ensureDir(this.otpPendingDir)
    try {
      for (const name of readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))) {
        const path = join(this.otpPendingDir, name)
        const raw = readJsonFile<OtpPendingSend | null>(path, this.atRest, null)
        if (raw && typeof raw.tokenHash === 'string' && raw.tokenHash.toLowerCase() === th) {
          try {
            unlinkSync(path)
          } catch {
            /* */
          }
        }
      }
    } catch {
      /* */
    }
  }

  readPayload(tokenHash: string): PortalPayload | null {
    const path = join(this.payloadDir, `${tokenHash}.json`)
    if (!existsSync(path)) return null
    const raw = readJsonFile<unknown>(path, this.atRest, null)
    return isPortalPayload(raw) ? raw : null
  }

  resolveGuest(tokenPlain: string): {
    row: PortalRow | null
    active: boolean
    reason: 'ok' | 'not_found' | 'revoked' | 'expired' | 'unreadable'
  } {
    const tokenHash = hashPortalTokenPlain(tokenPlain)
    const loaded = this.loadResult()
    if (!loaded.ok) return { row: null, active: false, reason: 'unreadable' }
    const row = loaded.portals.find((p) => p.tokenHash === tokenHash) ?? null
    if (!row) return { row: null, active: false, reason: 'not_found' }
    if (typeof row.revokedAt === 'number' && row.revokedAt > 0) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalPortalId(row.localPortalId)
      this.scrubOtpStateForToken(row.tokenHash)
      return { row, active: false, reason: 'revoked' }
    }
    if (
      typeof row.expiresAt === 'number'
      && row.expiresAt > 0
      && Date.now() >= row.expiresAt
    ) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalPortalId(row.localPortalId)
      this.scrubOtpStateForToken(row.tokenHash)
      return { row, active: false, reason: 'expired' }
    }
    return { row, active: true, reason: 'ok' }
  }

  takeAnonRate(ipKey: string): boolean {
    const k = capStr(String(ipKey || 'unknown'), 128)
    const now = Date.now()
    let b = this.anonBuckets.get(k)
    if (!b || now >= b.refillAt) {
      b = { count: 0, refillAt: now + ANON_RATE_WINDOW_MS }
      this.anonBuckets.set(k, b)
    }
    if (b.count >= ANON_RATE_PER_WINDOW) return false
    b.count += 1
    pruneSessionMapOverCap(this.anonBuckets, now, (v) => v.refillAt)
    return true
  }

  enqueueSubmission(args: {
    row: PortalRow
    payload: PortalPayload
    rawData: unknown
    contactLabel?: string | null
    clientIp?: string
  }):
    | { ok: true; id: string }
    | { ok: false; error: string; error_code: string; status: number; fieldErrors?: string[] } {
    if (!isPortalActive(args.row)) {
      const revoked = isPortalRevoked(args.row)
      return {
        ok: false,
        error: revoked ? 'This portal is no longer available' : 'This portal has expired',
        error_code: revoked ? 'portal.revoked' : 'portal.expired',
        status: 410,
      }
    }
    if (!args.row.allowedActions.includes('create')) {
      return {
        ok: false,
        error: 'This portal does not accept new records',
        error_code: 'portal.create_denied',
        status: 403,
      }
    }
    if (!args.row.payloadReady) {
      return {
        ok: false,
        error: 'Portal form is not ready yet',
        error_code: 'portal.payload_not_ready',
        status: 503,
      }
    }

    // Anonymous write-once / abuse cap (PIN unlocks still count toward the same
    // per-IP window so a shared PIN cannot be used as an open flood pipe).
    if (!this.takeAnonRate(args.clientIp || 'unknown')) {
      return {
        ok: false,
        error: 'Too many submissions from this network. Try again later.',
        error_code: 'portal.rate_limited',
        status: 429,
      }
    }

    // TCC-R1132-BRG-001: listPendingSubmissions() hard-caps its return length
    // at 100 (Admin page size) regardless of the limit argument, so this
    // probe against MAX_PENDING_SUBMISSIONS (2000) could never actually
    // reach the real ceiling and queue_full could never fire. Count
    // uncapped by the page-size ceiling instead; keep listPendingSubmissions()
    // itself capped at 100 for the Admin list UI.
    const pendingCount = this.countPendingSubmissions(MAX_PENDING_SUBMISSIONS, args.row.teamId)
    if (pendingCount >= MAX_PENDING_SUBMISSIONS) {
      return {
        ok: false,
        error: 'Too many pending submissions. Try again later.',
        error_code: 'portal.queue_full',
        status: 503,
      }
    }

    const acl = args.payload.aclSnapshot || {}
    if (acl.hiddenSlugs !== undefined && !Array.isArray(acl.hiddenSlugs)) {
      return {
        ok: false,
        error: 'Form access list could not be read. Restore the shared form before accepting submissions.',
        error_code: 'portal.payload_unreadable',
        status: 503,
      }
    }
    if (
      acl.allowedFieldSlugs !== undefined
      && acl.allowedFieldSlugs !== null
      && !Array.isArray(acl.allowedFieldSlugs)
    ) {
      return {
        ok: false,
        error: 'Form access list could not be read. Restore the shared form before accepting submissions.',
        error_code: 'portal.payload_unreadable',
        status: 503,
      }
    }
    const hidden = new Set(
      Array.isArray(acl.hiddenSlugs)
        ? acl.hiddenSlugs.filter((s): s is string => typeof s === 'string')
        : [],
    )
    const allowList =
      Array.isArray(acl.allowedFieldSlugs) && acl.allowedFieldSlugs.length > 0
        ? new Set(acl.allowedFieldSlugs.filter((s): s is string => typeof s === 'string'))
        : null
    const fieldSlugs = new Set(
      args.payload.fields
        .filter((f) => typeof f.slug === 'string' && f.slug)
        .map((f) => f.slug),
    )
    const required = new Set(
      args.payload.fields.filter((f) => f.required).map((f) => f.slug),
    )
    const raw =
      args.rawData && typeof args.rawData === 'object' && !Array.isArray(args.rawData)
        ? (args.rawData as Record<string, unknown>)
        : {}
    const data: Record<string, unknown> = {}
    const fieldErrors: string[] = []
    for (const [k, v] of Object.entries(raw)) {
      if (!k || k.startsWith('_') || k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue
      }
      if (hidden.has(k)) continue
      if (allowList && !allowList.has(k)) continue
      if (!fieldSlugs.has(k)) continue
      const accepted = acceptGuestFieldValue(v)
      if (accepted !== undefined) data[k] = accepted
    }
    for (const slug of required) {
      const v = data[slug]
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
        fieldErrors.push(slug)
      }
    }
    if (fieldErrors.length > 0) {
      return {
        ok: false,
        error: 'Fill in the required fields',
        error_code: 'portal.validation',
        status: 400,
        fieldErrors,
      }
    }

    const id = randomBytes(16).toString('hex')
    const now = Date.now()
    const sub: PortalSubmission = {
      id,
      localPortalId: args.row.localPortalId,
      entityId: args.payload.entityId,
      data,
      contactLabel:
        typeof args.contactLabel === 'string' && args.contactLabel.trim()
          ? capStr(args.contactLabel.trim(), 120)
          : null,
      status: 'pending',
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    atomicWriteJson(join(this.submissionsDir, `${id}.json`), sub, this.atRest)
    return { ok: true, id }
  }

  /**
   * List pending Form intake. When `ownerMemberId` is set, only submissions
   * whose portal registry row is owned by that member are returned
   * (TCC-R1151-BKP-001 - multi-Admin must not see / destroy another Admin's
   * guest queue). Optional `teamId`: named = that team only; omit / blank =
   * leftover '' only (TCC-FIX-SHARE-013 drain twin). HTTP already passes the
   * third arg via `guestHttpDrainTeamIdFromUrl`.
   */
  listPendingSubmissions(limit = 50, ownerMemberId?: string, teamId?: unknown): PortalSubmission[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    const owner = capGuestStoreScopeId(ownerMemberId)
    const callerTeam = capGuestStoreTeamId(teamId)
    const now = Date.now()
    const loaded = this.loadResult()
    if (!loaded.ok) return []
    const registry = loaded.portals
    const byLocal = new Map(registry.map((p) => [p.localPortalId, p] as const))
    const scopedLocalIds = new Set(
      registry
        .filter((p) => {
          if (!isPortalActive(p, now)) return false
          if (owner && p.ownerMemberId !== owner) return false
          return guestStoreTeamMatchesScope(p.teamId, callerTeam)
        })
        .map((p) => p.localPortalId),
    )
    ensureDir(this.submissionsDir)
    const names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    const all: Array<{ path: string; row: PortalSubmission }> = []
    for (const name of names) {
      const path = join(this.submissionsDir, name)
      const raw = readJsonFile<PortalSubmission | null>(path, this.atRest, null)
      if (!raw || raw.status !== 'pending') continue
      const parent = byLocal.get(raw.localPortalId)
      if (parent && !isPortalActive(parent, now)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      if (parent) {
        if (!scopedLocalIds.has(raw.localPortalId)) continue
      } else if (owner || callerTeam) {
        continue
      }
      const claimedAt =
        typeof raw.claimedAt === 'number' && Number.isFinite(raw.claimedAt) ? raw.claimedAt : 0
      if (claimedAt > 0 && now - claimedAt < SUBMISSION_CLAIM_LEASE_MS) continue
      all.push({ path, row: raw })
    }
    // TCC-R1150-BKP-002: sort ALL matching pending oldest-first, THEN page.
    all.sort((a, b) => a.row.createdAt - b.row.createdAt)
    const out: PortalSubmission[] = []
    for (const item of all.slice(0, cap)) {
      // TCC-R1150-BKP-001: stamp lease before return so a peer drain skips.
      const claimed: PortalSubmission = { ...item.row, claimedAt: now, updatedAt: now }
      try {
        atomicWriteJson(item.path, claimed, this.atRest)
      } catch {
        continue
      }
      out.push(claimed)
    }
    return out
  }

  /**
   * TCC-R1132-BRG-001: uncapped-by-Admin-page-size count for the real
   * `queue_full` ceiling probe (`enqueueSubmission`). Stops scanning once it
   * has confirmed `ceiling + 1` pending rows. Optional `teamId` uses the same
   * named / leftover polarity as list/ack (TCC-FIX-SHARE-013) so T2 leftover
   * cannot trip T1 `queue_full`.
   */
  private countPendingSubmissions(ceiling: number, teamId?: unknown): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    const callerTeam = capGuestStoreTeamId(teamId)
    ensureDir(this.submissionsDir)
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    const loaded = this.loadResult()
    if (!loaded.ok) return stopAt
    const byLocal = new Map(loaded.portals.map((p) => [p.localPortalId, p] as const))
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const path = join(this.submissionsDir, name)
      const raw = readJsonFile<PortalSubmission | null>(path, this.atRest, null)
      if (!raw || raw.status !== 'pending') continue
      const parent = byLocal.get(raw.localPortalId)
      // Only unlink when the parent exists and is dead. A missing parent is
      // still a real pending file (queue_full seeds, in-memory enqueue).
      if (parent && !isPortalActive(parent)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      if (parent) {
        if (!guestStoreTeamMatchesScope(parent.teamId, callerTeam)) continue
      } else if (callerTeam) {
        continue
      }
      count += 1
    }
    return count
  }

  /**
   * TCC-R1133-PRT-003: acked submissions are UNLINKED, not rewritten with a
   * terminal status. Nothing on the bridge ever reads a non-pending
   * submission back (`listPendingSubmissions`/`countPendingSubmissions`
   * both filter to `status === 'pending'` only, and there is no "past
   * submissions" endpoint in `server.ts`) - the desktop main process has
   * already durably recorded the applied/rejected outcome locally
   * (`drainPortalSubmissions`) before it calls this. Leaving the acked row
   * on disk only grew `portal-submissions/` forever, forcing every future
   * `enqueueSubmission`'s `countPendingSubmissions` to `readdirSync` +
   * decrypt every historical row (pending or not) to find the still-live
   * ones - deleting on ack keeps that directory bounded by the pending
   * queue size, not by all-time submission volume.
   */
  ackSubmission(args: {
    submissionId: string
    status: 'applied' | 'rejected'
    error?: string | null
    teamId?: unknown
    team_id?: unknown
  }): { ok: true } | { ok: false; error: string } {
    const id = sanitizeHexId(args.submissionId)
    if (!id) return { ok: false, error: 'submission_id required' }
    const path = join(this.submissionsDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Not found' }
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const loaded = this.loadResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const sub = readJsonFile<PortalSubmission | null>(path, this.atRest, null)
    const localId = capGuestStoreScopeId(sub?.localPortalId)
    const parent = localId
      ? loaded.portals.find((p) => p.localPortalId === localId)
      : undefined
    if (parent) {
      if (!guestStoreTeamMatchesScope(parent.teamId, callerTeam)) {
        return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
      }
    } else if (callerTeam) {
      return { ok: false, error: GUEST_STORE_PORTAL_TEAM_MISMATCH }
    }
    try {
      unlinkSync(path)
    } catch (err) {
      // TS-SEC2-008: log the throw; the page gets a sentence we own.
      console.error(
        `[bridge] Could not remove submission: ${
          err instanceof Error ? capStr(err.message, 200) : 'error'
        }`,
      )
      return { ok: false, error: 'Could not remove submission' }
    }
    return { ok: true }
  }
}
