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

type RegistryFile = { portals: PortalRow[] }

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

function normalizeOtpEmail(email: string): string {
  return email.trim().toLowerCase().slice(0, 320)
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
  return {
    local_portal_id: row.localPortalId,
    name: row.name,
    auth_mode: row.authMode,
    needs_pin: row.authMode === 'pin',
    allowed_actions: row.allowedActions,
    payload_ready: row.payloadReady,
    revoked: typeof row.revokedAt === 'number' && row.revokedAt > 0,
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
    return `${tokenHash}:${sessionId.trim().slice(0, 128)}`
  }

  private takeOtpRequestRate(ipKey: string): boolean {
    const k = String(ipKey || 'unknown').slice(0, 128)
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
    const pendingOtpCount = this.countPendingOtpSends(MAX_PENDING_OTP_SENDS)
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
    const code = typeof args.code === 'string' ? args.code.trim().slice(0, 12) : ''
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim().slice(0, 128) : ''
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

  listPendingOtpSends(limit = 50): OtpPendingSend[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    ensureDir(this.otpPendingDir)
    const names = readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))
    const now = Date.now()
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
   * confirmed `ceiling + 1` live pending sends.
   */
  private countPendingOtpSends(ceiling: number): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    ensureDir(this.otpPendingDir)
    let names: string[] = []
    try {
      names = readdirSync(this.otpPendingDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    const now = Date.now()
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const raw = readJsonFile<OtpPendingSend | null>(
        join(this.otpPendingDir, name),
        this.atRest,
        null,
      )
      if (!raw || typeof raw.codePlain !== 'string' || !raw.codePlain) continue
      if (typeof raw.expiresAt === 'number' && raw.expiresAt > 0 && now >= raw.expiresAt) {
        try {
          unlinkSync(join(this.otpPendingDir, name))
        } catch {
          /* */
        }
        continue
      }
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
  ackOtpSend(args: { id: string }): { ok: true } | { ok: false; error: string } {
    const id = sanitizeHexId(args.id)
    if (!id) return { ok: false, error: 'id required' }
    const path = join(this.otpPendingDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Not found' }
    try {
      unlinkSync(path)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'Could not remove OTP send',
      }
    }
    return { ok: true }
  }

  private load(): PortalRow[] {
    const file = readJsonFile<RegistryFile>(this.registryPath, this.atRest, { portals: [] })
    return Array.isArray(file.portals) ? file.portals : []
  }

  private save(portals: PortalRow[]): void {
    // TCC-R1153-BKP-002: GC revoked tombstones before the silent 500-cap so
    // lifetime publish+unpublish cycles cannot drop a still-active row.
    const live: PortalRow[] = []
    const revoked: PortalRow[] = []
    for (const p of portals) {
      if (typeof p.revokedAt === 'number' && p.revokedAt > 0) revoked.push(p)
      else live.push(p)
    }
    const room = Math.max(0, MAX_PORTALS - live.length)
    revoked.sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0))
    const keptRevoked = revoked.slice(0, room)
    const capped = [...live, ...keptRevoked].slice(0, MAX_PORTALS)
    atomicWriteJson(this.registryPath, { portals: capped }, this.atRest)
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
    },
  ): { ok: true; row: PortalRow } | { ok: false; error: string } {
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.trim().toLowerCase() : ''
    const localPortalId =
      typeof args.localPortalId === 'string' ? args.localPortalId.trim().slice(0, 128) : ''
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'token_hash must be sha256 hex' }
    }
    if (!localPortalId) return { ok: false, error: 'local_portal_id required' }

    const portals = this.load()
    const now = Date.now()
    const idx = portals.findIndex(
      (p) => p.tokenHash === tokenHash || p.localPortalId === localPortalId,
    )
    const prev = idx >= 0 ? portals[idx] : null
    const row: PortalRow = {
      tokenHash,
      localPortalId,
      name: (args.name || 'Portal').slice(0, 120),
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
      ownerMemberId,
    }

    if (args.payload != null) {
      const set = this.writePayload(tokenHash, args.payload)
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

  writePayload(
    tokenHash: string,
    payload: unknown,
  ): { ok: true } | { ok: false; error: string } {
    let json: string
    try {
      json = JSON.stringify(payload)
    } catch {
      return { ok: false, error: 'Invalid payload' }
    }
    if (json.length > PAYLOAD_JSON_MAX) {
      return { ok: false, error: 'Payload too large' }
    }
    atomicWriteJson(join(this.payloadDir, `${tokenHash}.json`), payload, this.atRest)
    const portals = this.load()
    const idx = portals.findIndex((p) => p.tokenHash === tokenHash)
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
  }): { ok: true } | { ok: false; error: string } {
    const portals = this.load()
    const idx = portals.findIndex(
      (p) =>
        (args.tokenHash && p.tokenHash === args.tokenHash.toLowerCase())
        || (args.localPortalId && p.localPortalId === args.localPortalId),
    )
    if (idx < 0) return { ok: false, error: 'Portal not found' }
    const row = portals[idx]
    const tokenHash = row.tokenHash
    portals[idx] = {
      ...row,
      revokedAt: Date.now(),
      updatedAt: Date.now(),
      payloadReady: false,
    }
    this.save(portals)
    // TCC-R1150-BKP-003: unlink guest form payload on revoke.
    try {
      unlinkSync(join(this.payloadDir, `${tokenHash}.json`))
    } catch {
      /* */
    }
    // TCC-R1147-BKP-002: scrub OTP challenge / unlock / pending mail for this portal.
    this.scrubOtpStateForToken(tokenHash)
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
    if (!raw || typeof raw !== 'object') return null
    return raw as PortalPayload
  }

  resolveGuest(tokenPlain: string): {
    row: PortalRow | null
    active: boolean
    reason: 'ok' | 'not_found' | 'revoked' | 'expired'
  } {
    const tokenHash = hashPortalTokenPlain(tokenPlain)
    const portals = this.load()
    const row = portals.find((p) => p.tokenHash === tokenHash) ?? null
    if (!row) return { row: null, active: false, reason: 'not_found' }
    if (typeof row.revokedAt === 'number' && row.revokedAt > 0) {
      return { row, active: false, reason: 'revoked' }
    }
    if (
      typeof row.expiresAt === 'number'
      && row.expiresAt > 0
      && Date.now() >= row.expiresAt
    ) {
      return { row, active: false, reason: 'expired' }
    }
    return { row, active: true, reason: 'ok' }
  }

  takeAnonRate(ipKey: string): boolean {
    const k = String(ipKey || 'unknown').slice(0, 128)
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
    const pendingCount = this.countPendingSubmissions(MAX_PENDING_SUBMISSIONS)
    if (pendingCount >= MAX_PENDING_SUBMISSIONS) {
      return {
        ok: false,
        error: 'Too many pending submissions. Try again later.',
        error_code: 'portal.queue_full',
        status: 503,
      }
    }

    const acl = args.payload.aclSnapshot || {}
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
      if (typeof v === 'string') data[k] = v.slice(0, 10_000)
      else if (typeof v === 'number' || typeof v === 'boolean') data[k] = v
      else if (v === null) data[k] = null
      else data[k] = String(v).slice(0, 10_000)
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
          ? args.contactLabel.trim().slice(0, 120)
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
   * guest queue).
   */
  listPendingSubmissions(limit = 50, ownerMemberId?: string): PortalSubmission[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    const owner =
      typeof ownerMemberId === 'string' && ownerMemberId.trim()
        ? ownerMemberId.trim().slice(0, 128)
        : ''
    const ownedLocalIds = owner
      ? new Set(
          this.load()
            .filter((p) => p.ownerMemberId === owner && !p.revokedAt)
            .map((p) => p.localPortalId),
        )
      : null
    ensureDir(this.submissionsDir)
    const names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    const now = Date.now()
    const all: Array<{ path: string; row: PortalSubmission }> = []
    for (const name of names) {
      const path = join(this.submissionsDir, name)
      const raw = readJsonFile<PortalSubmission | null>(path, this.atRest, null)
      if (!raw || raw.status !== 'pending') continue
      if (ownedLocalIds && !ownedLocalIds.has(raw.localPortalId)) continue
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
   * has confirmed `ceiling + 1` pending rows.
   */
  private countPendingSubmissions(ceiling: number): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    ensureDir(this.submissionsDir)
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const raw = readJsonFile<PortalSubmission | null>(
        join(this.submissionsDir, name),
        this.atRest,
        null,
      )
      if (!raw || raw.status !== 'pending') continue
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
  }): { ok: true } | { ok: false; error: string } {
    const id = sanitizeHexId(args.submissionId)
    if (!id) return { ok: false, error: 'submission_id required' }
    const path = join(this.submissionsDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Not found' }
    try {
      unlinkSync(path)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'Could not remove submission',
      }
    }
    return { ok: true }
  }
}
