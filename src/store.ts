/**
 * Durable Team Space bridge store (file-backed under TEAMSPACE_DATA_DIR).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  createReadStream,
  createWriteStream,
  readdirSync,
  unlinkSync,
  renameSync,
  statSync,
  openSync,
  fstatSync,
  readSync,
  writeSync,
  closeSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { type BridgeRole, type ModulesSyncOp, mintToken } from './index.js'
export { mintToken } from './index.js'
import {
  type AtRestKey,
  createBlobDecryptTransform,
  decryptBlobBody,
  decryptJsonFile,
  decryptOpsLine,
  encryptBlobFile,
  encryptJsonFile,
  encryptOpsLine,
  resolveAtRestKeyFromEnv,
} from './at-rest.js'
import {
  ACK_IDS_PER_CALL,
  CRM_BLOBS_DISK_MAX_BYTES,
  RECENT_OPS_CATCHUP_LIMIT,
  RECENT_OPS_SHARED_READ_WINDOW_MS,
  TEAMSPACE_DEVICE_STALE_DAYS,
} from './throughput.js'
import { pageMembersList } from './members-page.js'
import { capStr, capTrim } from './text-cap.js'
import {
  ADMIN_RECOVERY_REFUSE_BAD_KEY,
  ADMIN_RECOVERY_REFUSE_NO_ADMIN,
  ADMIN_RECOVERY_REFUSE_UNAVAILABLE,
  type AdminRecoveryKey,
  adminRecoveryKeyMatches,
  hasPresentedAdminRecoveryKey,
  resolveAdminRecoveryKey,
} from './admin-recovery.js'
import { createCrmBlobDiskTotal, type CrmBlobDiskTotal } from './crm-blob-disk.js'
import { AsyncSemaphore } from './concurrency-pool.js'

export type MemberRow = {
  memberId: string
  email: string
  displayName: string
  role: BridgeRole
  /** deviceId -> sessionToken */
  sessions: Record<string, string>
  /**
   * BRG-068: deviceId -> last-seen ms. Additive. Missing on load stays
   * missing (never `Date.now()`). Prune infers from `max(acks[d])` when
   * this stamp is absent.
   */
  sessionLastSeen?: Record<string, number>
  createdAt: number
  /** TS-CHAT-012: optional chat avatar wire ref (`local:avatar:vN` or cleared). */
  avatarRef?: string | null
  avatarRev?: number
  /**
   * TCC-R1125-SHR-002: stable invite id (never the join token itself -
   * TS-SCL-001) the member redeemed to join. Lets the host resolve an
   * access-template invite intent for token-only (no-email) invites, since
   * the raw token is never presented back to the host after redeem.
   */
  joinedViaInviteId?: string
}

export type InviteRow = {
  /** Stable id for list/cancel (TS-SHR-019). Never the join token. */
  id: string
  token: string
  email: string
  role: BridgeRole
  createdBy: string
  createdAt: number
  expiresAt: number
  usedAt: number | null
  usedBy: string | null
}

/** Admin invite list page. Honesty is `total` / `has_more` (TS-UI-013). */
export const TEAMSPACE_INVITE_LIST_PAGE = 200

export type TeamMeta = {
  teamId: string
  createdAt: number
  name: string
}

type AckMap = Record<string, Record<string, number>> // deviceId -> opId -> at

/**
 * Result of `helloOrBootstrap`. `recoveredAdmin` / `evictedDeviceIds` are only
 * present on the Admin recovery path, so every pre-existing caller keeps reading
 * exactly the fields it already read.
 */
export type HelloOrBootstrapResult =
  | {
      ok: true
      member: MemberRow
      sessionToken: string
      minted: boolean
      /** True when the session was minted by the Admin recovery key branch. */
      recoveredAdmin?: boolean
      /** Oldest device bindings dropped to stay under the per-member cap. */
      evictedDeviceIds?: string[]
    }
  | { ok: false; reason: string }

const MAX_BLOB_BYTES = 25 * 1024 * 1024
const INVITE_TTL_MS = 24 * 60 * 60 * 1000 // TS-SCL-003: short-lived invite (24h)
/**
 * TCC-R1186-INV-002: ceiling on PENDING (unused, unexpired) invites. The
 * per-connection rate limit (INVITE_TOKENS_PER_WINDOW) bounds burst speed but
 * not lifetime accumulation - at 20 mints / 10s an Admin script could grow
 * invites.json without bound inside one 24h TTL window. Prune runs first, so
 * this counts only live pending rows; hitting it refuses loudly instead of
 * silently dropping.
 */
const MAX_PENDING_INVITES = 500

/**
 * Ceiling on device sessions kept for one member row. Only the Admin recovery
 * path enforces it: every other writer of `sessions` is either admin-gated or
 * one-per-invite, while recovery can be replayed from rotating device ids by
 * anyone holding the recovery key, so it is the only unbounded writer.
 */
const MAX_SESSIONS_PER_MEMBER = 64

/**
 * BRG-068: hard ceiling on `ops.jsonl` so a never-acked / all-stale log
 * cannot grow without bound. Override via `TEAMSPACE_OPS_LOG_MAX_BYTES`
 * (64 KiB .. 8 GiB). Constructor 5th arg is tests-only.
 */
function envIntLocal(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

const OPS_LOG_MAX_BYTES_DEFAULT = 512 * 1024 * 1024
const OPS_PENDING_APPEND_MAX = envIntLocal('TEAMSPACE_OPS_PENDING_APPEND_MAX', 50_000, 100, 500_000)
/**
 * A single accepted op can be as large as `OPS_FRAME_MAX_BYTES` (server.ts
 * enforces that per-op AND per-frame ceiling before calling `appendOps`), so
 * the count cap above bounds line COUNT but not total bytes: enough
 * max-sized frames arriving while a prune rewrite holds `opsPruning` open
 * could otherwise accumulate many GiB in the in-memory `pendingOpAppends`
 * mirror before the count cap is ever reached. Bound the sidecar mirror's
 * total size too. Override via `TEAMSPACE_OPS_PENDING_APPEND_MAX_BYTES`
 * (1 MiB .. 2 GiB).
 */
const OPS_PENDING_APPEND_MAX_BYTES = envIntLocal(
  'TEAMSPACE_OPS_PENDING_APPEND_MAX_BYTES',
  128 * 1024 * 1024,
  1024 * 1024,
  2 * 1024 * 1024 * 1024,
)
const MEMBER_DEVICE_ID_CAP = 128
const OP_ID_CAP = 200
const INVITE_ID_CAP = 80

/**
 * Identity / key cap. Surrogate-safe (TS-CHAT-032/042). Never a bare
 * `.slice` on memberId / deviceId / opId / invite id.
 */
function capId(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  return capStr(raw, max)
}

function resolveOpsLogMaxBytes(explicit?: number): number {
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit > 0) {
    return Math.max(1024, Math.floor(explicit))
  }
  return envIntLocal(
    'TEAMSPACE_OPS_LOG_MAX_BYTES',
    OPS_LOG_MAX_BYTES_DEFAULT,
    64 * 1024,
    8 * 1024 * 1024 * 1024,
  )
}

/**
 * Desktop HLC is `wallMs:counter:deviceId`. Fixture / legacy `0/id` stamps
 * are unparseable and must not invent an age (keep until the byte ceiling).
 */
function opWallMsFromHlc(hlc: unknown): number | null {
  if (typeof hlc !== 'string' || !hlc || hlc.length > 200) return null
  const parts = hlc.split(':')
  if (parts.length < 3) return null
  const wallMs = Number(parts[0])
  if (!Number.isFinite(wallMs) || wallMs <= 0) return null
  return Math.floor(wallMs)
}

/**
 * Keep one member's device-session map bounded. Object key order is the order
 * devices were bound, so the oldest binding is dropped first. Evicting is the
 * right call over refusing here: a refusal would re-create exactly the dead end
 * Admin recovery exists to fix, and an evicted device can bind again (recover or
 * redeem) while an evicted-but-still-wanted device is a recoverable annoyance
 * rather than a permanent lockout. Returns the device ids that were dropped so
 * the caller can log them for the operator.
 */
function evictOldestSessionsForCap(member: MemberRow, incomingDeviceId: string): string[] {
  const existing = Object.keys(member.sessions || {})
  // Re-keying a device that is already bound does not grow the map.
  if (existing.includes(incomingDeviceId)) return []
  const overflow = existing.length + 1 - MAX_SESSIONS_PER_MEMBER
  if (overflow <= 0) return []
  const evicted = existing.slice(0, overflow)
  for (const deviceId of evicted) {
    delete member.sessions[deviceId]
    dropSessionLastSeen(member, deviceId)
  }
  return evicted
}

/**
 * Device ids only (never session hashes). L06 `list_members_ok` reads
 * these keys from store roster rows. Do not strip `sessions` on list reads.
 */
export function memberSessionDeviceIds(member: {
  sessions?: Record<string, string> | null
}): string[] {
  const sessions = member.sessions
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) return []
  const out: string[] = []
  for (const raw of Object.keys(sessions)) {
    const d = capId(raw, MEMBER_DEVICE_ID_CAP)
    if (d) out.push(d)
  }
  return out
}

/** Roster read snapshot. Keeps session keys (L06 device ids). Never shares the live map. */
function cloneMemberRowForRead(member: MemberRow): MemberRow {
  return {
    ...member,
    sessions: { ...member.sessions },
    ...(member.sessionLastSeen ? { sessionLastSeen: { ...member.sessionLastSeen } } : {}),
  }
}

function memberHasDeviceSession(member: MemberRow, deviceId: string): boolean {
  const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
  if (!d) return false
  return typeof member.sessions?.[d] === 'string' && member.sessions[d] !== ''
}

function isRegisteredDevice(members: readonly MemberRow[], deviceId: string): boolean {
  const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
  if (!d) return false
  return members.some((m) => memberHasDeviceSession(m, d))
}

/**
 * TCC-R1148-ENT-003: last Admin is last LIVE session, not last Admin role.
 * A ghost Admin (`sessions={}`) must not let revoke / kick / leave / demote
 * empty the only device that can still run the team.
 */
function remainingAdminLiveSessions(
  members: readonly MemberRow[],
  drop: {
    memberId: string
    dropDeviceId?: string
    dropAllSessions?: boolean
    dropAdminRole?: boolean
  },
): number {
  const memberId = capId(drop.memberId, MEMBER_DEVICE_ID_CAP)
  const dropDeviceId = drop.dropDeviceId ? capId(drop.dropDeviceId, MEMBER_DEVICE_ID_CAP) : ''
  let n = 0
  for (const m of members) {
    if (m.role !== 'admin') continue
    if (drop.dropAdminRole && m.memberId === memberId) continue
    for (const id of memberSessionDeviceIds(m)) {
      if (m.memberId === memberId) {
        if (drop.dropAllSessions) continue
        if (dropDeviceId && id === dropDeviceId) continue
      }
      n += 1
    }
  }
  return n
}

function stampSessionLastSeen(member: MemberRow, deviceId: string, at: number): void {
  const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
  if (!d) return
  if (!Number.isFinite(at) || at <= 0) return
  if (!member.sessionLastSeen) member.sessionLastSeen = {}
  member.sessionLastSeen[d] = Math.floor(at)
}

function dropSessionLastSeen(member: MemberRow, deviceId: string): void {
  if (!member.sessionLastSeen) return
  const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
  if (!d) return
  delete member.sessionLastSeen[d]
  if (Object.keys(member.sessionLastSeen).length === 0) delete member.sessionLastSeen
}

/**
 * BRG-068: load last-seen only when the value is a real finite stamp.
 * Never invent `Date.now()` for a missing key (that refreshes every
 * retired device and pins the log forever).
 */
function parseSessionLastSeen(
  raw: unknown,
  sessions: Record<string, string>,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const out: Record<string, number> = {}
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    const d = capId(id, MEMBER_DEVICE_ID_CAP)
    if (!d || !sessions[d]) continue
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue
    out[d] = Math.floor(at)
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** TS-BRG-012: session tokens at rest are sha256 hex (never plaintext). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(String(token), 'utf8').digest('hex')
}

/** TS-SCL-001: invite tokens at rest are sha256 hex (domain-separated from sessions). */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(`invite:${String(token)}`, 'utf8').digest('hex')
}

function looksHashedToken(tok: string): boolean {
  return /^[a-f0-9]{64}$/.test(tok)
}

/**
 * Constant-time compare for a presented bearer secret (session/invite token)
 * against a stored value. Both sides are hashed to a fixed 32-byte digest
 * BEFORE the compare - same technique as `adminRecoveryKeyMatches` in
 * admin-recovery.ts (and `timingSafeEqual` in portal-store.ts /
 * public-share-store.ts / chat-rooms-store.ts) - so an unequal input length
 * cannot take a different code path and `timingSafeEqual` always sees two
 * equal-length buffers. `findBySession` / `authenticateHelloSession` /
 * `matchesInviteCredential` are reachable by an unauthenticated remote caller
 * (hello, invite redeem) presenting an arbitrary candidate token; a plain
 * `===` here would let response-time variance narrow down a valid session or
 * invite token byte by byte across many requests.
 */
function timingSafeTokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a), 'utf8').digest()
  const hb = createHash('sha256').update(String(b), 'utf8').digest()
  return timingSafeEqual(ha, hb)
}

function atomicWriteJson(path: string, data: unknown, atRest: AtRestKey | null): void {
  const tmp = `${path}.${process.pid}.tmp`
  const body = atRest
    ? encryptJsonFile(atRest, data)
    : JSON.stringify(data, null, 2)
  try {
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    // A write/rename failure (disk full, EIO, permission change mid-run,
    // cross-device rename) must not leave an orphaned `<path>.<pid>.tmp`
    // file sitting next to the real store forever - every failed persist
    // attempt would otherwise accumulate one more of these on disk,
    // unbounded, for as long as the underlying fault persists. Best-effort
    // cleanup; the real `path` file is untouched either way (rename never
    // completed), so removing the temp file cannot lose data.
    try { unlinkSync(tmp) } catch { /* best-effort; ok if already gone */ }
    throw err
  }
}

function readJson<T>(path: string, fallback: T, atRest: AtRestKey | null): T {
  try {
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, 'utf8')
    return decryptJsonFile<T>(atRest, raw, fallback) ?? fallback
  } catch {
    return fallback
  }
}

/**
 * TS-BRG-013: members.json must fail closed on tear/corrupt parse.
 * Missing file → empty (first-admin bootstrap). Present but unreadable →
 * quarantine + refuse bootstrap (never wipe into empty-admin).
 */
type MembersLoad =
  | { ok: true; members: MemberRow[]; migratedHashes: boolean }
  | { ok: false; reason: string }

function loadMembersStrict(path: string, atRest: AtRestKey | null): MembersLoad {
  try {
    if (!existsSync(path)) return { ok: true, members: [], migratedHashes: false }
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) {
      // Empty file after crash mid-write - treat as corrupt, not first-admin.
      quarantineMembersFile(path, 'empty')
      return { ok: false, reason: 'members.json is empty or torn - restore from backup before reconnecting' }
    }
    let parsed: unknown
    try {
      parsed = decryptJsonFile<unknown>(atRest, raw, null)
    } catch (err) {
      quarantineMembersFile(path, 'parse')
      const msg = err instanceof Error ? err.message : ''
      return {
        ok: false,
        reason: /TEAMSPACE_AT_REST_KEY/.test(msg)
          ? 'members.json is encrypted - set TEAMSPACE_AT_REST_KEY'
          : 'members.json could not be read - restore from backup before reconnecting',
      }
    }
    if (parsed === null) {
      quarantineMembersFile(path, 'parse')
      return { ok: false, reason: 'members.json could not be read - restore from backup before reconnecting' }
    }
    if (!Array.isArray(parsed)) {
      quarantineMembersFile(path, 'shape')
      return { ok: false, reason: 'members.json is not a member list - restore from backup before reconnecting' }
    }
    const members: MemberRow[] = []
    let migratedHashes = false
    for (const row of parsed) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const r = row as Record<string, unknown>
      const memberId = capId(r.memberId, MEMBER_DEVICE_ID_CAP)
      if (!memberId) continue
      const sessionsRaw = r.sessions && typeof r.sessions === 'object' && !Array.isArray(r.sessions)
        ? r.sessions as Record<string, unknown>
        : {}
      const sessions: Record<string, string> = {}
      for (const [deviceId, tok] of Object.entries(sessionsRaw)) {
        if (typeof tok !== 'string' || !tok) continue
        const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
        if (!d) continue
        if (looksHashedToken(tok)) {
          sessions[d] = tok
        } else {
          // Legacy plaintext → hash at load (TS-BRG-012 migrate).
          sessions[d] = hashSessionToken(tok)
          migratedHashes = true
        }
      }
      members.push({
        memberId,
        email: typeof r.email === 'string' ? capStr(r.email, 320) : '',
        displayName: typeof r.displayName === 'string' ? capStr(r.displayName, 200) : '',
        role: r.role === 'admin' || r.role === 'viewer' || r.role === 'member' ? r.role : 'member',
        sessions,
        sessionLastSeen: parseSessionLastSeen(r.sessionLastSeen, sessions),
        createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
        avatarRef: r.avatarRef === null
          ? null
          : typeof r.avatarRef === 'string'
            ? capStr(r.avatarRef, 256)
            : undefined,
        avatarRev: typeof r.avatarRev === 'number' && Number.isFinite(r.avatarRev) && r.avatarRev > 0
          ? Math.floor(r.avatarRev)
          : undefined,
        joinedViaInviteId: typeof r.joinedViaInviteId === 'string' && r.joinedViaInviteId.trim()
          ? capTrim(r.joinedViaInviteId, INVITE_ID_CAP) || undefined
          : undefined,
      })
    }
    return { ok: true, members, migratedHashes }
  } catch (err) {
    quarantineMembersFile(path, 'io')
    return {
      ok: false,
      reason: err instanceof Error
        ? `members.json unreadable: ${capStr(err.message, 120)}`
        : 'members.json unreadable - restore from backup before reconnecting',
    }
  }
}

function quarantineMembersFile(path: string, tag: string): void {
  try {
    if (!existsSync(path)) return
    const dest = `${path}.corrupt.${tag}.${Date.now()}`
    renameSync(path, dest)
  } catch { /* best-effort */ }
}

/**
 * TS-BRG-043: acks.json must be a plain object (deviceId -> opId -> at).
 * Non-object shape (array / number / string) would TypeError markAcked or
 * wipe acks on the next persist - quarantine and start empty like members.
 */
function loadAcksStrict(path: string, atRest: AtRestKey | null): AckMap {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) {
      quarantineMembersFile(path, 'acks-empty')
      return {}
    }
    let parsed: unknown
    try {
      parsed = decryptJsonFile<unknown>(atRest, raw, null)
    } catch {
      quarantineMembersFile(path, 'acks-parse')
      return {}
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      quarantineMembersFile(path, 'acks-shape')
      return {}
    }
    const out: AckMap = {}
    for (const [deviceId, bag] of Object.entries(parsed as Record<string, unknown>)) {
      const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
      if (!d || !bag || typeof bag !== 'object' || Array.isArray(bag)) continue
      const inner: Record<string, number> = {}
      for (const [opId, at] of Object.entries(bag as Record<string, unknown>)) {
        const id = capId(opId, OP_ID_CAP)
        if (!id || typeof at !== 'number' || !Number.isFinite(at)) continue
        inner[id] = Math.floor(at)
      }
      out[d] = inner
    }
    return out
  } catch {
    quarantineMembersFile(path, 'acks-io')
    return {}
  }
}

/**
 * TCC-R1132-TLS-003: invites.json must fail closed on tear/corrupt/decrypt-fail
 * parse, exactly like `loadMembersStrict` for members.json. Missing file →
 * empty (fresh team, no invites yet). Present but unreadable (torn write,
 * wrong/missing TEAMSPACE_AT_REST_KEY) → quarantine + refuse mutation, never
 * silently fall back to `[]` - an empty in-memory list would otherwise become
 * the "truth" the next `createInvite` persists over, permanently destroying
 * every prior unused invite that merely failed to decrypt this boot.
 */
type InvitesLoad =
  | { ok: true; invites: InviteRow[]; migratedHashes: boolean }
  | { ok: false; reason: string }

function loadInvitesStrict(path: string, atRest: AtRestKey | null): InvitesLoad {
  try {
    if (!existsSync(path)) return { ok: true, invites: [], migratedHashes: false }
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) {
      // Empty file after crash mid-write - treat as corrupt, not "no invites".
      quarantineMembersFile(path, 'invites-empty')
      return { ok: false, reason: 'invites.json is empty or torn - restore from backup before creating or cancelling invites' }
    }
    let parsed: unknown
    try {
      parsed = decryptJsonFile<unknown>(atRest, raw, null)
    } catch (err) {
      quarantineMembersFile(path, 'invites-parse')
      const msg = err instanceof Error ? err.message : ''
      return {
        ok: false,
        reason: /TEAMSPACE_AT_REST_KEY/.test(msg)
          ? 'invites.json is encrypted - set TEAMSPACE_AT_REST_KEY'
          : 'invites.json could not be read - restore from backup before creating or cancelling invites',
      }
    }
    if (parsed === null) {
      quarantineMembersFile(path, 'invites-parse')
      return { ok: false, reason: 'invites.json could not be read - restore from backup before creating or cancelling invites' }
    }
    if (!Array.isArray(parsed)) {
      quarantineMembersFile(path, 'invites-shape')
      return { ok: false, reason: 'invites.json is not an invite list - restore from backup before creating or cancelling invites' }
    }
    let migratedHashes = false
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const r = item as { id?: unknown; token?: unknown }
      const token = typeof r.token === 'string' ? r.token : ''
      if (!token) continue
      if (typeof r.id !== 'string' || !String(r.id).trim()) migratedHashes = true
      if (!looksHashedToken(token)) migratedHashes = true
    }
    const invites = normalizeInviteRows(parsed).map((row) => {
      if (looksHashedToken(row.token)) return row
      migratedHashes = true
      return { ...row, token: hashInviteToken(row.token) }
    })
    return { ok: true, invites, migratedHashes }
  } catch (err) {
    quarantineMembersFile(path, 'invites-io')
    return {
      ok: false,
      reason: err instanceof Error
        ? `invites.json unreadable: ${capStr(err.message, 120)}`
        : 'invites.json unreadable - restore from backup before creating or cancelling invites',
    }
  }
}

/** Stable invite id for legacy rows that predate the id field (TS-SHR-019). */
function inviteIdFromRow(row: { id?: unknown; token?: unknown }): string {
  if (typeof row.id === 'string' && row.id.trim()) return capTrim(row.id, INVITE_ID_CAP)
  const tok = typeof row.token === 'string' ? row.token : ''
  if (looksHashedToken(tok)) return `inv_${tok.slice(0, 24)}`
  if (tok) return `inv_${hashInviteToken(tok).slice(0, 24)}`
  return mintId('inv')
}

/** Ensure every invite row has a stable id (TS-SHR-019). */
function normalizeInviteRows(rows: unknown): InviteRow[] {
  if (!Array.isArray(rows)) return []
  const out: InviteRow[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as InviteRow
    const token = typeof r.token === 'string' ? r.token : ''
    if (!token) continue
    out.push({
      ...r,
      id: inviteIdFromRow(r),
      token,
      email: typeof r.email === 'string' ? capStr(r.email, 320) : '',
      role: r.role === 'viewer' || r.role === 'member' || r.role === 'admin' ? r.role : 'member',
      createdBy: typeof r.createdBy === 'string' ? capId(r.createdBy, MEMBER_DEVICE_ID_CAP) : '',
      createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
      // TCC-R1186-INV-001 (TS-CHAT-031 family): rows predating expiresAt count
      // as EXPIRED, never as fresh. The old `Date.now()` default re-minted the
      // deadline on every load (redeem re-reads disk, then compares
      // `expiresAt < Date.now()` in the same millisecond), so a legacy row was
      // effectively immortal and redeemable forever. 0 = always expired ->
      // pruned + cleared from disk on the next touchpoint.
      expiresAt: typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt) ? r.expiresAt : 0,
      usedAt: typeof r.usedAt === 'number' ? r.usedAt : null,
      usedBy: typeof r.usedBy === 'string'
        ? (r.usedBy.startsWith('claim:') ? r.usedBy : capId(r.usedBy, MEMBER_DEVICE_ID_CAP) || null)
        : null,
    })
  }
  return out
}

export function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
}

/**
 * BRG-059: one consumer on a shared oldest-first ops scan. The same
 * decrypted object is pushed to every waiter (one decrypt pass).
 */
type FullScanWaiter = {
  q: ModulesSyncOp[]
  wake: (() => void) | null
  done: boolean
  err: unknown
}

/**
 * BRG-059 / BRG-069: join while the generation is live. Prefix already
 * pushed sits on `emitted` so a joiner after the first yield replays it
 * (same decrypt pass) instead of starting a second file scan.
 */
type FullScanGeneration = {
  yielded: boolean
  finished: boolean
  emitted: ModulesSyncOp[]
  waiters: Set<FullScanWaiter>
}

export class BridgeStore {
  readonly root: string
  readonly retentionDays: number
  /** TS-BRG-014: optional AES key for data-dir files (null = plaintext on disk). */
  readonly atRest: AtRestKey | null
  /**
   * Operator-proof Admin recovery secret (`admin-recovery.ts`). Resolved from
   * this store's own data dir unless the caller passes one in - `null` disables
   * recovery entirely, which is only useful in tests.
   */
  readonly adminRecovery: AdminRecoveryKey | null
  private membersPath: string
  private invitesPath: string
  private metaPath: string
  private acksPath: string
  private opsPath: string
  /**
   * G10 residual: while `pruneOps` rewrites `ops.jsonl`, accepted batches
   * land here (one `appendFileSync`) so a process-kill after `ops_result`
   * still has bytes on disk. Boot / next prune merges then unlinks.
   */
  private opsPendingPath: string
  /** BRG-068: absolute ops.jsonl byte ceiling for this process. */
  private readonly opsLogMaxBytes: number
  private blobsDir: string
  /** BRG-069: O(1) CRM blob disk total. Walk only at seed. */
  private readonly blobDisk: CrmBlobDiskTotal

  private members: MemberRow[] = []
  private invites: InviteRow[] = []
  private meta: TeamMeta | null = null
  private acks: AckMap = {}
  /** TS-BRG-013: set when members.json was present but unreadable. */
  private membersLoadFailed = false
  private membersLoadReason = ''
  /** TCC-R1144-ENT-004: serialize last-admin check-then-mutate on members roster. */
  private membersMutationDepth = 0
  /** TCC-R1132-TLS-003: set when invites.json was present but unreadable. */
  private invitesLoadFailed = false
  private invitesLoadReason = ''
  /**
   * TS-SCL-001: while pruneOps rewrites ops.jsonl, concurrent appends go to
   * `ops.jsonl.pending` (and this in-memory mirror) so they survive rename.
   */
  private opsPruning = false
  private pendingOpAppends: string[] = []
  /** Running byte total of `pendingOpAppends` - see `OPS_PENDING_APPEND_MAX_BYTES`. */
  private pendingOpAppendBytes = 0
  /** Process-local plaintext invite tokens (hashed on disk). */
  private invitePlainByHash = new Map<string, string>()
  /**
   * TCC-R1133-WS-002: single-flight + short-TTL cache for `readRecentOps()`
   * so a reconnect storm shares one full-file scan instead of firing one
   * per `hello`. `settledAt === null` means the scan is still in flight
   * (any concurrent caller for the same `limit` always shares it, no matter
   * how long it takes - a true concurrency-of-1 gate); once settled, it is
   * reused only inside `RECENT_OPS_SHARED_READ_WINDOW_MS`.
   */
  private recentOpsCache: {
    limit: number
    settledAt: number | null
    promise: Promise<ModulesSyncOp[]>
  } | null = null
  private recentOpsRealScans = 0
  private recentOpsSharedHits = 0
  /**
   * BRG-059 / TCC-R1133-WS-002 analog: concurrent `scanOpsFromStart()`
   * callers share one decrypt pass for the life of the generation.
   * A joiner after the first yield replays `emitted` then attaches, so
   * it does not skip prefix ops and does not decrypt the file again.
   */
  private fullScanShare: FullScanGeneration | null = null
  private fullScanRealScans = 0
  private fullScanSharedJoins = 0
  private readonly fullScanProducerLock = new AsyncSemaphore(1)
  /**
   * TCC-R1150-BRG-002: in-process opId idempotency so a lost `ops_result`
   * retry cannot double-append the same line while this process is up.
   */
  private seenOpIds = new Set<string>()
  private static readonly SEEN_OP_IDS_MAX = 50_000
  /** TCC-R1148-BRG-002: coalesce ack persist under bursty ack_ops. */
  private acksPersistTimer: ReturnType<typeof setTimeout> | null = null
  private acksDirty = false
  /** BRG-068: last-seen stamps dirtied by markAcked (same debounce as acks). */
  private membersLastSeenDirty = false
  /** BRG-068: live devices that held past-retention lines on the last prune. */
  private pruneBlockingDeviceIds: string[] = []
  /** BRG-068: last prune dropped oldest lines to stay under the byte ceiling. */
  private pruneForcedResync = false
  /** BRG-068: how many lines the last prune evicted for the byte ceiling. */
  private pruneByteCeilingEvicted = 0

  constructor(
    root: string,
    retentionDays = 21,
    atRest: AtRestKey | null = resolveAtRestKeyFromEnv(),
    /**
     * Pass `undefined` (the default) to resolve from `root` + environment - that
     * generates and persists a key on first boot. Pass `null` only to prove the
     * no-recovery-key path.
     */
    adminRecovery?: AdminRecoveryKey | null,
    /**
     * Tests-only ops.jsonl byte ceiling. Production reads
     * `TEAMSPACE_OPS_LOG_MAX_BYTES` (default 512 MiB).
     */
    opsLogMaxBytes?: number,
  ) {
    this.root = root
    this.retentionDays = Math.max(1, Math.min(365, Math.floor(retentionDays)))
    this.atRest = atRest
    this.opsLogMaxBytes = resolveOpsLogMaxBytes(opsLogMaxBytes)
    mkdirSync(root, { recursive: true })
    this.adminRecovery =
      adminRecovery === undefined ? resolveAdminRecoveryKey(root) : adminRecovery
    this.membersPath = join(root, 'members.json')
    this.invitesPath = join(root, 'invites.json')
    this.metaPath = join(root, 'team.json')
    this.acksPath = join(root, 'acks.json')
    this.opsPath = join(root, 'ops.jsonl')
    this.opsPendingPath = join(root, 'ops.jsonl.pending')
    this.blobsDir = join(root, 'blobs')
    mkdirSync(this.blobsDir, { recursive: true })
    this.blobDisk = createCrmBlobDiskTotal(this.blobsDir)
    this.reload()
    this.recoverPendingOps()
  }

  reload(): void {
    const loaded = loadMembersStrict(this.membersPath, this.atRest)
    if (loaded.ok) {
      this.members = loaded.members
      this.membersLoadFailed = false
      this.membersLoadReason = ''
      if (loaded.migratedHashes) this.persistMembers()
    } else {
      this.members = []
      this.membersLoadFailed = true
      this.membersLoadReason = loaded.reason
    }
    const loadedInvites = loadInvitesStrict(this.invitesPath, this.atRest)
    if (loadedInvites.ok) {
      this.invites = loadedInvites.invites
      this.invitesLoadFailed = false
      this.invitesLoadReason = ''
      if (loadedInvites.migratedHashes) this.persistInvites()
    } else {
      // TCC-R1132-TLS-003: never let a decrypt/parse failure collapse the
      // in-memory list to "no invites" - that empty state would otherwise be
      // exactly what the next createInvite/cancelInvite persists over the
      // real (still-encrypted-but-fine) file. Refuse mutation instead
      // (see invitesLoadFailed gates below); keep whatever was in memory.
      this.invitesLoadFailed = true
      this.invitesLoadReason = loadedInvites.reason
    }
    this.meta = readJson<TeamMeta | null>(this.metaPath, null, this.atRest)
    this.acks = loadAcksStrict(this.acksPath, this.atRest)
  }

  /** True when members store is corrupt - hello/bootstrap must refuse. */
  isMembersStoreUnusable(): boolean {
    return this.membersLoadFailed
  }

  membersStoreError(): string {
    return this.membersLoadReason || 'members store unreadable'
  }

  /** TCC-R1132-TLS-003: true when invites.json is corrupt/undecryptable - refuse invite mutation. */
  isInvitesStoreUnusable(): boolean {
    return this.invitesLoadFailed
  }

  invitesStoreError(): string {
    return this.invitesLoadReason || 'invites store unreadable'
  }

  /**
   * A failed write (disk full, EIO, permission change mid-run) must not leave
   * `this.members` / `this.invites` / `this.acks` / `this.meta` permanently
   * diverged from disk: every mutating caller already applied its change to
   * the in-memory field before calling persist, so without a revert every
   * later read in this process (other members' hellos, invite redeems, ack
   * lookups) would keep silently serving state nothing has actually
   * persisted - and if the process then restarts before a later persist
   * succeeds, that state is lost with no record it was ever only half-real.
   * Reload the real on-disk value using the SAME loaders `reload()` already
   * uses at boot (same fail-open-to-empty contract for acks/meta the file
   * documents at TS-BRG-043 / boot `reload()`, same fail-closed-on-corrupt
   * contract for members/invites - reload only replaces the in-memory copy
   * when the strict loader reports success, never on a corrupt/unreadable
   * disk read, since discarding good in-memory data on an uncertain read
   * would be worse than a stale-but-real divergence). The original error is
   * always rethrown so the caller still sees the failure.
   */
  private persistMembers(): void {
    try {
      atomicWriteJson(this.membersPath, this.members, this.atRest)
    } catch (err) {
      const reloaded = loadMembersStrict(this.membersPath, this.atRest)
      if (reloaded.ok) this.members = reloaded.members
      throw err
    }
  }
  private persistInvites(): void {
    try {
      atomicWriteJson(this.invitesPath, this.invites, this.atRest)
    } catch (err) {
      const reloaded = loadInvitesStrict(this.invitesPath, this.atRest)
      if (reloaded.ok) this.invites = reloaded.invites
      throw err
    }
  }
  private persistMeta(): void {
    if (!this.meta) return
    try {
      atomicWriteJson(this.metaPath, this.meta, this.atRest)
    } catch (err) {
      this.meta = readJson<TeamMeta | null>(this.metaPath, null, this.atRest)
      throw err
    }
  }
  private persistAcks(): void {
    try {
      atomicWriteJson(this.acksPath, this.acks, this.atRest)
    } catch (err) {
      this.acks = loadAcksStrict(this.acksPath, this.atRest)
      throw err
    }
  }

  /**
   * BRG-068: forget-device / kick / leave / recovery-evict must drop that
   * device's ack bag. Session removal already takes it out of prune quorum;
   * leaving acks.json entries pins unbounded bags for a device that can
   * never ack again.
   *
   * BRG-104 (Wave 14 box 18, G8): a deviceId is bound to the physical
   * machine, not to a member identity - two different people redeeming
   * their own invite on one shared/kiosk workstation legitimately register
   * the SAME deviceId under two separate member rows. Every call site here
   * already removes/evicts the CALLING member's own session entry from
   * `this.members` before calling dropDeviceAcks, so `isRegisteredDevice`
   * evaluated here correctly reflects only whether some OTHER member row
   * still holds this device - never wipe an ack bag a different member is
   * still actively using.
   */
  private dropDeviceAcks(deviceIds: string[]): void {
    let changed = false
    for (const raw of deviceIds) {
      if (isRegisteredDevice(this.members, raw)) continue
      const d = capId(raw, MEMBER_DEVICE_ID_CAP)
      if (d && this.acks[d]) {
        delete this.acks[d]
        changed = true
      }
      // Legacy bag keyed before capId must not pin prune after forget.
      if (typeof raw === 'string' && raw && raw !== d && this.acks[raw]) {
        delete this.acks[raw]
        changed = true
      }
    }
    if (!changed) return
    // Persist first. Clearing dirty before a throw would skip flush retry
    // and leave the forgotten bag on disk (BRG-068).
    this.acksDirty = true
    this.persistAcks()
    this.acksDirty = false
  }

  getTeam(): TeamMeta | null {
    return this.meta
  }

  /**
   * BRGTEAM-001: minting a team is the single most consequential silent event
   * this store has. It happens on the first hello against a data dir with no
   * `team.json`, which is exactly what a server pointed at the WRONG (or a
   * freshly emptied) folder does - and the operator's only symptom is a second
   * team appearing at the same address, hours later, in someone's roster.
   *
   * The observer lets `server.ts` own every operator-facing line (this file has
   * no `console.*` by design, and 50+ unit suites construct stores) while still
   * making the event impossible to miss in the log. Set at construction, called
   * exactly once per mint.
   */
  onTeamCreated: ((team: TeamMeta) => void) | null = null

  ensureTeam(name = 'Team Space'): TeamMeta {
    if (this.meta) return this.meta
    this.meta = { teamId: mintId('team'), createdAt: Date.now(), name: capStr(name, 200) }
    this.persistMeta()
    // After persist, so an observer that throws cannot leave a minted team
    // unwritten - and its failure must never fail the hello that minted it.
    try {
      this.onTeamCreated?.(this.meta)
    } catch {
      /* operator logging is best effort, never load-bearing */
    }
    return this.meta
  }

  /** M-P2-1: Admin renames the canonical private-server name (peers see on next hello). */
  setTeamName(name: string): TeamMeta {
    const team = this.ensureTeam()
    const next = capTrim(name, 200) || 'Team Space'
    if (team.name === next) return team
    this.meta = { ...team, name: next }
    this.persistMeta()
    return this.meta
  }

  /**
   * Full roster including `sessions` keys (device ids). L06 Admin
   * `deviceIds` is `Object.keys(sessions)`. Never strip sessions here.
   * Snapshot copy so a wire mapper cannot mutate the live roster.
   */
  listMembers(): MemberRow[] {
    return this.members.map(cloneMemberRowForRead)
  }

  /**
   * TS-MEM-001: Admin roster page (limit/offset + total/has_more honesty).
   * Full `listMembers()` stays for internal live-set checks (kick/presence).
   * Page rows keep `sessions` so L06 can read device ids (never hashes).
   */
  listMembersPage(args?: { limit?: unknown; offset?: unknown }): {
    members: MemberRow[]
    total: number
    limit: number
    offset: number
    has_more: boolean
    truncated: boolean
    unreadable: boolean
  } {
    if (this.membersLoadFailed) {
      const page = pageMembersList([], args?.limit, args?.offset)
      return { ...page, members: [], unreadable: true }
    }
    const page = pageMembersList(this.members, args?.limit, args?.offset)
    return { ...page, members: page.members.map(cloneMemberRowForRead) }
  }

  findMember(memberId: string): MemberRow | undefined {
    return this.members.find((m) => m.memberId === memberId)
  }

  findBySession(sessionToken: string): { member: MemberRow; deviceId: string } | null {
    if (!sessionToken || sessionToken.length > 500) return null
    const hashed = hashSessionToken(sessionToken)
    for (const m of this.members) {
      for (const [deviceId, tok] of Object.entries(m.sessions || {})) {
        // Compare hashed form (constant-time - see `timingSafeTokenEquals`);
        // tolerate one-shot legacy plaintext match + migrate.
        if (timingSafeTokenEquals(tok, hashed)) return { member: m, deviceId }
        // TCC-R1132-TLS-001: the legacy-plaintext migrate branch must NEVER fire
        // when the stored value already looks like a hash - otherwise presenting
        // the disk hash itself as the bearer token satisfies `tok === sessionToken`
        // (hash accepted as a credential), then rewrites the row to hash-of-hash
        // and locks the real token holder out. Once `tok` is a hash, only the
        // hashed-compare above may authenticate it.
        if (!looksHashedToken(tok) && timingSafeTokenEquals(tok, sessionToken)) {
          m.sessions[deviceId] = hashed
          this.persistMembers()
          return { member: m, deviceId }
        }
      }
    }
    return null
  }

  /**
   * First member becomes admin. Later hellos need a valid session.
   * Second device for same member adds a new session row (never overwrite).
   *
   * When the roster is already populated and the presented session cannot
   * authenticate, an optional `adminRecoveryKey` is the operator's escape hatch
   * back into their own server - see `recoverAdminWithKey`.
   */
  helloOrBootstrap(args: {
    memberId: string
    deviceId: string
    sessionToken?: string
    memberEmail?: string
    displayName?: string
    /**
     * Frozen wire field (`hello.adminRecoveryKey`). Absent / blank behaves
     * exactly as before this field existed.
     */
    adminRecoveryKey?: string
  }): HelloOrBootstrapResult {
    const memberId = capTrim(args.memberId, MEMBER_DEVICE_ID_CAP)
    const deviceId = capTrim(args.deviceId, MEMBER_DEVICE_ID_CAP)
    if (!memberId || !deviceId) return { ok: false, reason: 'memberId and deviceId required' }

    // TS-BRG-013: never first-admin wipe after a torn members.json. Admin
    // recovery is held behind the SAME guard on purpose: a torn roster means we
    // cannot prove which member rows really exist, so binding a session onto a
    // "the only admin we can see" row could bind onto a roster that is about to
    // be restored from backup. Restore the file first, then recover.
    if (this.membersLoadFailed) {
      return { ok: false, reason: this.membersStoreError() }
    }

    this.ensureTeam()

    if (this.members.length === 0) {
      const token = mintToken()
      const now = Date.now()
      const member: MemberRow = {
        memberId,
        email: capTrim(args.memberEmail || '', 320),
        displayName: capTrim(args.displayName || args.memberEmail || 'Admin', 200),
        role: 'admin',
        sessions: { [deviceId]: hashSessionToken(token) },
        createdAt: now,
      }
      stampSessionLastSeen(member, deviceId, now)
      this.members.push(member)
      this.persistMembers()
      return { ok: true, member, sessionToken: token, minted: true }
    }

    const recoveryPresented = hasPresentedAdminRecoveryKey(args.adminRecoveryKey)

    if (args.sessionToken) {
      const authed = this.authenticateHelloSession(memberId, deviceId, args.sessionToken)
      if (authed.ok) return authed
      // A dead token must not shadow an explicit recovery attempt - the app can
      // still be holding a stale session from before the keychain was reset.
      // With no recovery key presented the refusal string is byte-identical to
      // what this method has always returned.
      if (!recoveryPresented) return authed
    }

    if (recoveryPresented) {
      return this.recoverAdminWithKey(memberId, deviceId, String(args.adminRecoveryKey))
    }

    return { ok: false, reason: 'Session token required' }
  }

  /**
   * The long-standing session-token hello path, extracted verbatim (same checks,
   * same refusal strings) so the Admin recovery branch can ask "did this session
   * authenticate?" without a second copy of the matching rules drifting apart.
   */
  private authenticateHelloSession(
    memberId: string,
    deviceId: string,
    sessionToken: string,
  ): HelloOrBootstrapResult {
    const hit = this.findBySession(sessionToken)
    if (!hit) return { ok: false, reason: 'Invalid session' }
    if (hit.member.memberId !== memberId) {
      return { ok: false, reason: 'Session does not match member' }
    }
    // Bind this device: add session if new device, keep old devices.
    // TS-BRG-007: never silently attach an existing session token to a NEW
    // deviceId (that would let one redeem span two machines). Second device
    // must redeem its own invite / mint its own session.
    if (!hit.member.sessions[deviceId]) {
      return {
        ok: false,
        reason: 'Session is bound to another device - redeem an invite on this computer',
      }
    } else {
      // TCC-R1132-TLS-001 twin: same rule as findBySession - a stored hash may
      // only match via the hashed compare. The raw-equality fallback exists
      // solely for legacy plaintext-at-rest rows and must not fire once the
      // stored value already looks hashed (never accept a disk hash itself
      // as a bearer credential).
      const stored = hit.member.sessions[deviceId]
      const matches = timingSafeTokenEquals(stored, hashSessionToken(sessionToken))
        || (!looksHashedToken(stored) && timingSafeTokenEquals(stored, sessionToken))
      if (!matches) {
        return { ok: false, reason: 'Invalid session for this device' }
      }
    }
    stampSessionLastSeen(hit.member, deviceId, Date.now())
    this.persistMembers()
    return { ok: true, member: hit.member, sessionToken, minted: false }
  }

  /**
   * Rebind Admin access onto a NEW device using this server's recovery key.
   *
   * Deliberate limits, all of them load-bearing:
   * - **Never promotes.** The presenting `memberId` is used only when that member
   *   is ALREADY an admin. Anyone else (viewer, member, or an id with no row at
   *   all) falls back to the earliest-created admin, so presenting the recovery
   *   key can never silently escalate a viewer into an Admin - the most it can do
   *   is take over the Admin account that the key already proves ownership of.
   * - **Never destroys.** No rooms, messages, blobs, invites, ops, or other
   *   member rows are read for writing, let alone rewritten. The only mutation
   *   is one added session on one existing admin member row.
   * - **Keeps other devices.** The admin's other device sessions stay valid, so
   *   recovering from a new computer does not sign out a working one.
   */
  private recoverAdminWithKey(
    memberId: string,
    deviceId: string,
    presentedKey: string,
  ): HelloOrBootstrapResult {
    if (!this.adminRecovery) return { ok: false, reason: ADMIN_RECOVERY_REFUSE_UNAVAILABLE }
    if (!adminRecoveryKeyMatches(this.adminRecovery, presentedKey)) {
      return { ok: false, reason: ADMIN_RECOVERY_REFUSE_BAD_KEY }
    }

    const admins = this.members.filter((m) => m.role === 'admin')
    if (admins.length === 0) return { ok: false, reason: ADMIN_RECOVERY_REFUSE_NO_ADMIN }

    let target = admins.find((m) => m.memberId === memberId)
    if (!target) {
      target = admins[0]
      for (const candidate of admins) {
        if (candidate.createdAt < target.createdAt) target = candidate
      }
    }

    const token = mintToken()
    const evictedDeviceIds = evictOldestSessionsForCap(target, deviceId)
    target.sessions[deviceId] = hashSessionToken(token)
    stampSessionLastSeen(target, deviceId, Date.now())
    this.persistMembers()
    this.dropDeviceAcks(evictedDeviceIds)
    return {
      ok: true,
      member: target,
      sessionToken: token,
      minted: true,
      recoveredAdmin: true,
      ...(evictedDeviceIds.length > 0 ? { evictedDeviceIds } : {}),
    }
  }

  /**
   * TCC-R1133-TLS-002: sweep invite rows + their in-memory plaintext token
   * (`invitePlainByHash`) so a self-hosted bridge does not grow both
   * without bound over its lifetime. Removes any row that is either (a)
   * past its 24h TTL, or (b) fully redeemed (`usedBy` is a real member id,
   * not a `claim:<deviceId>:...` in-flight nonce). An in-flight incomplete
   * claim (TS-RACE-004 same-device crash-retry) is preserved even past its
   * `usedAt` stamp so the retry path in `redeemInviteInner` can still find
   * and finish it - only a claim that is either expired or truly completed
   * is safe to drop. Persists immediately when it actually removed
   * anything so `invites.json` never carries dead rows between calls.
   */
  private pruneExpiredAndUsedInvites(): void {
    if (this.invites.length === 0) return
    const now = Date.now()
    let removed = 0
    const keep: InviteRow[] = []
    for (const row of this.invites) {
      const usedByRaw = typeof row.usedBy === 'string' ? row.usedBy : ''
      const isIncompleteClaim = usedByRaw.startsWith('claim:')
      const expired = row.expiresAt < now
      const completedUse = typeof row.usedAt === 'number' && row.usedAt > 0 && !isIncompleteClaim
      if (expired || completedUse) {
        this.invitePlainByHash.delete(row.token)
        removed += 1
        continue
      }
      keep.push(row)
    }
    if (removed > 0) {
      this.invites = keep
      this.persistInvites()
    }
  }

  createInvite(createdBy: string, email: string, role: BridgeRole):
    | { ok: true; invite: InviteRow }
    | { ok: false; reason: string } {
    // TCC-R1132-TLS-003: never mint+persist against an in-memory list that
    // may be missing real invites because the on-disk file failed to decrypt.
    if (this.invitesLoadFailed) return { ok: false, reason: this.invitesStoreError() }
    this.pruneExpiredAndUsedInvites()
    // TCC-R1186-INV-002: bound the pending set after the prune so expired /
    // redeemed rows never count against the ceiling.
    if (this.invites.length >= MAX_PENDING_INVITES) {
      return {
        ok: false,
        reason: 'Too many pending invites. Cancel unused invites or wait for them to expire.',
      }
    }
    const plain = mintToken(24)
    const hashed = hashInviteToken(plain)
    // TCC-R1143-INV-001: Admin may mint admin|member|viewer invites (UI + WS).
    // Never coerce admin→member - that made "Invite as Admin" silently lie.
    const inviteRole: BridgeRole =
      role === 'admin' || role === 'viewer' || role === 'member' ? role : 'member'
    const row: InviteRow = {
      id: mintId('inv'),
      token: hashed,
      email: capTrim(email, 320),
      role: inviteRole,
      createdBy: capTrim(createdBy, MEMBER_DEVICE_ID_CAP),
      createdAt: Date.now(),
      expiresAt: Date.now() + INVITE_TTL_MS,
      usedAt: null,
      usedBy: null,
    }
    this.invites.push(row)
    this.invitePlainByHash.set(hashed, plain)
    this.persistInvites()
    // Return plaintext once so the admin can share the link (disk holds hash only).
    return { ok: true, invite: { ...row, token: plain } }
  }

  /**
   * TS-BRG-038: cancel an unused invite (Admin). Matches by id or plaintext /
   * hashed token. Used invites are refused (already redeemed).
   */
  cancelInvite(tokenOrId: string): { ok: true; id: string } | { ok: false; reason: string } {
    // TCC-R1132-TLS-003 twin: same fail-closed rule as createInvite - a splice
    // + persist over a decrypt-failure-emptied list would drop every other
    // pending invite the same way a create would.
    if (this.invitesLoadFailed) return { ok: false, reason: this.invitesStoreError() }
    this.pruneExpiredAndUsedInvites()
    const key = capTrim(tokenOrId, 200)
    if (!key) return { ok: false, reason: 'token or id required' }
    const presentedHash = hashInviteToken(key)
    const idx = this.invites.findIndex((i) =>
      i.id === key
      || i.token === key
      || i.token === presentedHash
      || this.invitePlainByHash.get(i.token) === key,
    )
    if (idx < 0) return { ok: false, reason: 'Invite not found' }
    const invite = this.invites[idx]!
    if (invite.usedAt || invite.usedBy) {
      return { ok: false, reason: 'Invite already used' }
    }
    const id = invite.id
    this.invites.splice(idx, 1)
    this.invitePlainByHash.delete(invite.token)
    this.persistInvites()
    return { ok: true, id }
  }

  /**
   * TCC-R1132-TLS-002: a redeem credential must be the invite's PLAINTEXT
   * token, never the stored hash. `createInvite` writes only the hash to
   * disk (`:token`), so presenting that disk hash as `token` here must NOT
   * match - only `presentedHash === i.token` (hash the caller's plaintext,
   * compare hashes) or the one-shot legacy-plaintext-at-rest fallback (only
   * while the stored row has not yet been migrated to a hash) may authorize
   * a claim. Shared by the initial lookup, the post-persist CAS verify, and
   * the post-claim `usedBy` stamp so all three stay consistent.
   */
  private matchesInviteCredential(invite: InviteRow, token: string, presentedHash: string): boolean {
    if (timingSafeTokenEquals(invite.token, presentedHash)) return true
    return !looksHashedToken(invite.token) && timingSafeTokenEquals(invite.token, token)
  }

  /**
   * TCC-R1132-TLS-003: redeem must re-read invites.json fresh (concurrent
   * redeemers race on usedAt/usedBy), but a decrypt/parse failure here must
   * be reported as a store failure - never silently treated as "no invites
   * on disk" (which would misreport as the honest-sounding but wrong
   * "Invite not found" and mask a real at-rest-key misconfiguration).
   */
  private reloadInvitesStrict(): { ok: true } | { ok: false; reason: string } {
    const loaded = loadInvitesStrict(this.invitesPath, this.atRest)
    if (!loaded.ok) {
      this.invitesLoadFailed = true
      this.invitesLoadReason = loaded.reason
      return { ok: false, reason: loaded.reason }
    }
    this.invites = loaded.invites
    this.invitesLoadFailed = false
    this.invitesLoadReason = ''
    return { ok: true }
  }

  /** TS-SHR-009: one redeem at a time per token (HTTP + WS double-click race). */
  private redeemChains = new Map<string, Promise<unknown>>()

  redeemInvite(args: {
    token: string
    deviceId: string
    memberEmail?: string
    displayName?: string
  }): Promise<
    | { ok: true; member: MemberRow; sessionToken: string }
    | { ok: false; reason: string }
  > {
    const token = args.token.trim()
    if (!token) return Promise.resolve({ ok: false, reason: 'token and deviceId required' })
    const prev = this.redeemChains.get(token) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const chained = prev.then(() => gate)
    this.redeemChains.set(token, chained)
    return prev.catch(() => undefined).then(() => this.withMembersMutation(() => this.redeemInviteInner(args))).finally(() => {
      release()
      if (this.redeemChains.get(token) === chained) this.redeemChains.delete(token)
    })
  }

  private redeemInviteInner(args: {
    token: string
    deviceId: string
    memberEmail?: string
    displayName?: string
  }):
    | { ok: true; member: MemberRow; sessionToken: string }
    | { ok: false; reason: string } {
    const token = args.token.trim()
    const deviceId = capTrim(args.deviceId, MEMBER_DEVICE_ID_CAP)
    if (!token || !deviceId) return { ok: false, reason: 'token and deviceId required' }
    // Re-read invites so concurrent redeemers see the latest usedAt/usedBy stamp.
    const freshLoad = this.reloadInvitesStrict()
    if (!freshLoad.ok) return { ok: false, reason: freshLoad.reason }
    this.pruneExpiredAndUsedInvites()
    const presentedHash = hashInviteToken(token)
    const idx = this.invites.findIndex((i) => this.matchesInviteCredential(i, token, presentedHash))
    if (idx < 0) return { ok: false, reason: 'Invite not found' }
    const invite = this.invites[idx]!
    if (invite.expiresAt < Date.now()) return { ok: false, reason: 'Invite expired' }
    // TCC-R1143-INV-001: admin invites are first-class (Admin-minted only at
    // create). Refuse unknown role strings before claim so the token is not burned.
    if (invite.role !== 'admin' && invite.role !== 'member' && invite.role !== 'viewer') {
      return { ok: false, reason: 'Invite role is invalid' }
    }
    // TCC-R1127-BRG-001: an existing-member redeem below applies `invite.role`
    // to the matched member (session rotation / re-invite). If that member is
    // the sole Admin and the invite would demote them to member/viewer, refuse
    // BEFORE the claim (so the token is not burned) - same reason class as
    // `setMemberRole` / `kickMember` / `leaveTeam`. `this.members` is the live
    // in-memory roster (this function is fully synchronous, so it cannot be
    // mutated by a concurrent admin-count change mid-check).
    const inviteEmailForLastAdminCheck = capTrim(invite.email || '', 320)
    if (inviteEmailForLastAdminCheck && (invite.role === 'member' || invite.role === 'viewer')) {
      const existingTarget = this.members.find(
        (m) => m.email && m.email.toLowerCase() === inviteEmailForLastAdminCheck.toLowerCase(),
      )
      if (existingTarget && existingTarget.role === 'admin') {
        if (
          remainingAdminLiveSessions(this.members, {
            memberId: existingTarget.memberId,
            dropAdminRole: true,
          }) === 0
        ) {
          return { ok: false, reason: 'Cannot demote the last admin' }
        }
      }
    }
    // TS-RACE-004: incomplete claim (`claim:<deviceId>:...`) after crash may leave
    // usedAt/usedBy set with no member session. Same-device retry must continue;
    // other devices and finished member claims still refuse.
    const ownClaimPrefix = `claim:${deviceId}:`
    const usedBy = typeof invite.usedBy === 'string' ? invite.usedBy : ''
    const isOwnIncompleteClaim = usedBy.startsWith(ownClaimPrefix)
    if ((invite.usedAt || invite.usedBy) && !isOwnIncompleteClaim) {
      return { ok: false, reason: 'Invite already used' }
    }

    this.ensureTeam()
    if (this.membersLoadFailed) {
      return { ok: false, reason: this.membersStoreError() }
    }
    // TS-SHR-009: CAS claim via usedBy nonce before minting session.
    // Second writer that loses the disk race sees a different usedBy and refuses.
    // Reuse the persisted nonce on same-device crash-retry so a concurrent peer
    // that already lost the race cannot steal mid-retry.
    const claimNonce = isOwnIncompleteClaim
      ? usedBy
      : `claim:${deviceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
    invite.usedAt = invite.usedAt || Date.now()
    invite.usedBy = claimNonce
    // Ensure disk row stores hash (legacy plaintext migrate on claim).
    if (!looksHashedToken(invite.token)) {
      invite.token = presentedHash
    }
    this.persistInvites()
    const verifyLoad = this.reloadInvitesStrict()
    if (!verifyLoad.ok) return { ok: false, reason: verifyLoad.reason }
    const verify = this.invites.find((i) => this.matchesInviteCredential(i, token, presentedHash))
    if (!verify?.usedAt || verify.usedBy !== claimNonce) {
      return { ok: false, reason: 'Invite already used' }
    }

    const inviteEmail = capTrim(invite.email || '', 320)
    const email = inviteEmail
    let member = inviteEmail
      ? this.members.find((m) => m.email && m.email.toLowerCase() === inviteEmail.toLowerCase())
      : undefined
    const sessionToken = mintToken()
    const sessionHash = hashSessionToken(sessionToken)
    let droppedDeviceIds: string[] = []
    if (!member) {
      member = {
        memberId: mintId('mem'),
        email,
        displayName: capTrim(args.displayName || email || 'Teammate', 200),
        // TCC-R1143-INV-001: honor admin|member|viewer from Admin-minted invite.
        role:
          invite.role === 'admin' || invite.role === 'viewer' || invite.role === 'member'
            ? invite.role
            : 'member',
        sessions: { [deviceId]: sessionHash },
        createdAt: Date.now(),
        // TCC-R1125-SHR-002: record which invite minted this member so the
        // host can resolve a token-only (no-email) access-template intent.
        joinedViaInviteId: invite.id,
      }
      stampSessionLastSeen(member, deviceId, Date.now())
      this.members.push(member)
    } else {
      // TCC-R1143-INV-001: apply invite role including admin elevation.
      // TCC-R1127-BRG-001: last-admin demotion is refused BEFORE session
      // replace so a refuse cannot wipe live devices in memory.
      if (invite.role === 'admin' || invite.role === 'member' || invite.role === 'viewer') {
        // TCC-R1144-ENT-004: re-check last-admin immediately before demote assign.
        if (member.role === 'admin' && invite.role !== 'admin') {
          if (
            remainingAdminLiveSessions(this.members, {
              memberId: member.memberId,
              dropAdminRole: true,
            }) === 0
          ) {
            return { ok: false, reason: 'Cannot demote the last admin' }
          }
        }
        member.role = invite.role
      }
      // BRG-068: re-redeem forgets every other device. Drop those ack bags
      // or they grow forever for a device that can never ack again.
      droppedDeviceIds = Object.keys(member.sessions || {}).filter((id) => id !== deviceId)
      member.sessions = { [deviceId]: sessionHash }
      member.sessionLastSeen = undefined
      stampSessionLastSeen(member, deviceId, Date.now())
      // TCC-R1152-LIM-001: do not overwrite a real personal name on re-redeem
      // with a shared team label / empty paste from Settings.
      if (args.displayName && typeof args.displayName === 'string' && args.displayName.trim()) {
        const next = capTrim(args.displayName, 200)
        const cur = typeof member.displayName === 'string' ? member.displayName.trim() : ''
        if (!cur || cur === 'Teammate' || cur === 'Admin' || cur === 'Member') {
          member.displayName = next
        }
      }
      // TCC-R1147-ACL-003: refresh joinedViaInviteId on every redeem (existing
      // email-matched members previously kept a stale prior invite id, so
      // host template consume by invite-id never fired for re-invites).
      member.joinedViaInviteId = invite.id
    }
    invite.usedBy = member.memberId
    const liveIdx = this.invites.findIndex((i) => this.matchesInviteCredential(i, token, presentedHash))
    if (liveIdx >= 0) {
      this.invites[liveIdx]!.usedBy = member.memberId
    }
    this.invitePlainByHash.delete(presentedHash)
    this.persistMembers()
    this.persistInvites()
    this.dropDeviceAcks(droppedDeviceIds)
    return { ok: true, member, sessionToken }
  }


  /**
   * TCC-R1144-ENT-004: exclusive members mutation - reload from disk, then
   * check-then-act leave/kick/setRole/redeem demote without interleaving.
   */
  private withMembersMutation<T>(fn: () => T): T {
    if (this.membersMutationDepth === 0) {
      const loaded = loadMembersStrict(this.membersPath, this.atRest)
      if (!loaded.ok) {
        this.membersLoadFailed = true
        this.membersLoadReason = loaded.reason
      } else {
        this.members = loaded.members
        this.membersLoadFailed = false
        this.membersLoadReason = ''
      }
    }
    this.membersMutationDepth += 1
    try {
      return fn()
    } finally {
      this.membersMutationDepth -= 1
    }
  }

  /** TS-BRG-035: admin removes a member + all their sessions. */
  kickMember(actorMemberId: string, targetMemberId: string):
    | { ok: true; kickedDeviceIds: string[] }
    | { ok: false; reason: string } {
    return this.withMembersMutation(() => {
      if (this.membersLoadFailed) return { ok: false as const, reason: this.membersStoreError() }
      const actor = this.members.find((m) => m.memberId === capTrim(actorMemberId, MEMBER_DEVICE_ID_CAP))
      if (!actor || actor.role !== 'admin') return { ok: false as const, reason: 'Admin only' }
      const targetId = capTrim(targetMemberId, MEMBER_DEVICE_ID_CAP)
      if (!targetId) return { ok: false as const, reason: 'memberId required' }
      if (targetId === actor.memberId) return { ok: false as const, reason: 'Cannot kick yourself' }
      const idx = this.members.findIndex((m) => m.memberId === targetId)
      if (idx < 0) return { ok: false as const, reason: 'Member not found' }
      const target = this.members[idx]!
      if (
        target.role === 'admin' &&
        remainingAdminLiveSessions(this.members, {
          memberId: target.memberId,
          dropAdminRole: true,
        }) === 0
      ) {
        return { ok: false as const, reason: 'Cannot kick the last admin' }
      }
      const kickedDeviceIds = memberSessionDeviceIds(target)
      this.members.splice(idx, 1)
      this.persistMembers()
      this.dropDeviceAcks(kickedDeviceIds)
      return { ok: true as const, kickedDeviceIds }
    })
  }

  /** TS-BRG-036: revoke one device session (or all for member if deviceId omitted). */
  revokeSession(args: {
    actorMemberId: string
    targetMemberId: string
    deviceId?: string
  }):
    | { ok: true; revokedDeviceIds: string[] }
    | { ok: false; reason: string } {
    return this.withMembersMutation(() => {
      if (this.membersLoadFailed) return { ok: false as const, reason: this.membersStoreError() }
      const actor = this.members.find((m) => m.memberId === capTrim(args.actorMemberId, MEMBER_DEVICE_ID_CAP))
      if (!actor || actor.role !== 'admin') return { ok: false as const, reason: 'Admin only' }
      const target = this.members.find((m) => m.memberId === capTrim(args.targetMemberId, MEMBER_DEVICE_ID_CAP))
      if (!target) return { ok: false as const, reason: 'Member not found' }
      const deviceId = typeof args.deviceId === 'string' ? capTrim(args.deviceId, MEMBER_DEVICE_ID_CAP) : ''
      // TCC-R1148-ENT-003: refuse emptying the last LIVE Admin session.
      // Role-count alone is not enough: a ghost Admin (sessions={}) must not
      // let this call brick the team.
      if (target.role === 'admin') {
        const remainingAfter = remainingAdminLiveSessions(
          this.members,
          deviceId
            ? { memberId: target.memberId, dropDeviceId: deviceId }
            : { memberId: target.memberId, dropAllSessions: true },
        )
        if (remainingAfter === 0) {
          return {
            ok: false as const,
            reason: 'Cannot revoke the last Admin session - promote another Admin first',
          }
        }
      }
      let revoked: string[] = []
      if (deviceId) {
        if (!memberHasDeviceSession(target, deviceId)) {
          return { ok: false as const, reason: 'Device session not found' }
        }
        delete target.sessions[deviceId]
        dropSessionLastSeen(target, deviceId)
        revoked = [deviceId]
      } else {
        revoked = memberSessionDeviceIds(target)
        target.sessions = {}
        delete target.sessionLastSeen
      }
      this.persistMembers()
      this.dropDeviceAcks(revoked)
      return { ok: true as const, revokedDeviceIds: revoked }
    })
  }

  /** TS-BRG-037 twin: admin sets role (viewer/member; never last-admin demotion). */
  setMemberRole(args: {
    actorMemberId: string
    targetMemberId: string
    role: BridgeRole
  }):
    | { ok: true; role: BridgeRole }
    | { ok: false; reason: string } {
    return this.withMembersMutation(() => {
      if (this.membersLoadFailed) return { ok: false as const, reason: this.membersStoreError() }
      const actor = this.members.find((m) => m.memberId === capTrim(args.actorMemberId, MEMBER_DEVICE_ID_CAP))
      if (!actor || actor.role !== 'admin') return { ok: false as const, reason: 'Admin only' }
      const target = this.members.find((m) => m.memberId === capTrim(args.targetMemberId, MEMBER_DEVICE_ID_CAP))
      if (!target) return { ok: false as const, reason: 'Member not found' }
      const role = args.role === 'viewer' || args.role === 'member' || args.role === 'admin'
        ? args.role
        : null
      if (!role) return { ok: false as const, reason: 'Invalid role' }
      if (target.role === 'admin' && role !== 'admin') {
        if (
          remainingAdminLiveSessions(this.members, {
            memberId: target.memberId,
            dropAdminRole: true,
          }) === 0
        ) {
          return { ok: false as const, reason: 'Cannot demote the last admin' }
        }
      }
      target.role = role
      this.persistMembers()
      return { ok: true as const, role }
    })
  }

  /**
   * TS-ROLE-002 / E17: member removes themselves from the team roster.
   * Last Admin cannot leave until another Admin is promoted (same class as demote/kick).
   */
  leaveTeam(memberId: string):
    | { ok: true; leftDeviceIds: string[] }
    | { ok: false; reason: string } {
    return this.withMembersMutation(() => {
      if (this.membersLoadFailed) return { ok: false as const, reason: this.membersStoreError() }
      const id = capTrim(memberId, MEMBER_DEVICE_ID_CAP)
      if (!id) return { ok: false as const, reason: 'memberId required' }
      const idx = this.members.findIndex((m) => m.memberId === id)
      if (idx < 0) return { ok: false as const, reason: 'Member not found' }
      const target = this.members[idx]!
      if (
        target.role === 'admin' &&
        remainingAdminLiveSessions(this.members, {
          memberId: target.memberId,
          dropAdminRole: true,
        }) === 0
      ) {
        return { ok: false as const, reason: 'Cannot leave as the last admin - promote another Admin first' }
      }
      const leftDeviceIds = memberSessionDeviceIds(target)
      this.members.splice(idx, 1)
      this.persistMembers()
      this.dropDeviceAcks(leftDeviceIds)
      return { ok: true as const, leftDeviceIds }
    })
  }

  /**
   * TS-CHAT-012 / E20: persist chat display name + avatar wire ref/rev.
   * `avatarRef: null` clears; omit leaves prior ref. Rev bumps let peers drop ghost caches.
   * TCC-R1153-BRG-002: avatar apply is monotonic CAS - only `incomingRev > storedRev`
   * (equal = no-op keep; lower = refuse) so a stale device cannot roll back a newer stamp.
   */
  updateMemberChatProfile(
    memberId: string,
    patch: {
      displayName?: string
      avatarRef?: string | null
      avatarRev?: number
    },
  ):
    | { ok: true; member: MemberRow; avatarApplied: boolean }
    | { ok: false; reason: string } {
    if (this.membersLoadFailed) return { ok: false, reason: this.membersStoreError() }
    const id = capTrim(memberId, MEMBER_DEVICE_ID_CAP)
    if (!id) return { ok: false, reason: 'memberId required' }
    const m = this.members.find((x) => x.memberId === id)
    if (!m) return { ok: false, reason: 'Member not found' }
    if (typeof patch.displayName === 'string') {
      const d = capTrim(patch.displayName.replace(/\0/g, ''), 200)
      if (d) m.displayName = d
    }
    let avatarApplied = false
    const wantsAvatar = Object.prototype.hasOwnProperty.call(patch, 'avatarRef')
    if (wantsAvatar) {
      const incomingRev =
        typeof patch.avatarRev === 'number' && Number.isFinite(patch.avatarRev) && patch.avatarRev > 0
          ? Math.floor(patch.avatarRev)
          : null
      const storedRev =
        typeof m.avatarRev === 'number' && Number.isFinite(m.avatarRev) && m.avatarRev > 0
          ? Math.floor(m.avatarRev)
          : 0
      if (incomingRev === null) {
        // Clear path (null/empty ref) still requires a rev bump when a prior rev exists.
        if (patch.avatarRef === null || patch.avatarRef === '') {
          if (storedRev > 0) {
            return { ok: false, reason: 'avatarRev required to clear avatar' }
          }
          m.avatarRef = null
          avatarApplied = true
        } else if (typeof patch.avatarRef === 'string') {
          if (storedRev > 0) {
            return { ok: false, reason: 'avatarRev required (stale or missing)' }
          }
          m.avatarRef = capTrim(patch.avatarRef.replace(/\0/g, ''), 256)
          avatarApplied = true
        }
      } else if (incomingRev < storedRev) {
        return { ok: false, reason: 'Stale avatar revision' }
      } else if (incomingRev === storedRev) {
        // Equal rev: no-op on avatar bytes (keep stored); still ok for displayName.
        avatarApplied = false
      } else {
        if (patch.avatarRef === null || patch.avatarRef === '') {
          m.avatarRef = null
        } else if (typeof patch.avatarRef === 'string') {
          m.avatarRef = capTrim(patch.avatarRef.replace(/\0/g, ''), 256)
        }
        m.avatarRev = incomingRev
        avatarApplied = true
      }
    } else if (typeof patch.avatarRev === 'number' && Number.isFinite(patch.avatarRev) && patch.avatarRev > 0) {
      // Rev-only bump without ref is refused (cannot invent a new ref).
      return { ok: false, reason: 'avatarRef required with avatarRev' }
    }
    this.persistMembers()
    return {
      ok: true,
      avatarApplied,
      member: {
        ...m,
        sessions: { ...m.sessions },
      },
    }
  }

  /**
   * List invites for admin (TS-SHR-002 / TS-SHR-019). Hashed disk tokens are
   * not re-exported. Page is `TEAMSPACE_INVITE_LIST_PAGE`; `total` / `has_more`
   * disclose a silent drop (TS-UI-013).
   */
  listInvitesPage(): { invites: InviteRow[]; total: number; has_more: boolean } {
    // TCC-R1133-TLS-002: opportunistic GC touchpoint - every admin open of
    // the invite panel also sweeps dead rows, on top of the create/cancel/
    // redeem touchpoints above.
    this.pruneExpiredAndUsedInvites()
    const live = this.invites.filter((i) => !i.usedAt && i.expiresAt >= Date.now())
    const total = live.length
    const invites = live.slice(0, TEAMSPACE_INVITE_LIST_PAGE).map((i) => {
      const plain = this.invitePlainByHash.get(i.token)
      return {
        ...i,
        id: inviteIdFromRow(i),
        // Prefer process-local plaintext (same process as create); else empty
        // so a stolen invites.json cannot mint joiners (TS-SCL-001).
        token: plain || (looksHashedToken(i.token) ? '' : i.token),
      }
    })
    return { invites, total, has_more: total > TEAMSPACE_INVITE_LIST_PAGE }
  }

  /** Page only. Prefer `listInvitesPage` when the caller must disclose a cap. */
  listInvites(): InviteRow[] {
    return this.listInvitesPage().invites
  }

  /** BRG-067: thin wrap so existing callers stay on the one-syscall batch path. */
  appendOp(op: ModulesSyncOp): void {
    this.appendOps([op])
  }

  /**
   * BRG-067: persist accepted ops as ONE `appendFileSync` (join the lines).
   * Seen `opId`s are skipped per item (TCC-R1150-BRG-002) before lines are
   * built. `repairTornOpsTail` runs before the real disk write so a
   * same-process partial append cannot merge the next batch. A throw from
   * `appendFileSync` remembers none of the ids from that write and
   * propagates so handleOps can refuse (not ACK). Empty input is a no-op
   * (no repair, no write). A non-empty batch where every remaining op
   * fails stringify or at-rest seal writes nothing and throws
   * `OpsPersistSkippedError` so a void caller cannot ACK a skip. Partial
   * stringify success still writes those lines once and does not throw.
   */
  appendOps(ops: ModulesSyncOp[]): void {
    if (ops.length === 0) return

    const accepted: { opId: string; line: string }[] = []
    const batchSeen = new Set<string>()
    let skippedSeal = 0
    for (const op of ops) {
      const opId = typeof op.opId === 'string' ? capId(op.opId, OP_ID_CAP) : ''
      // TCC-R1150-BRG-002: idempotent by opId within this process.
      if (opId && (this.seenOpIds.has(opId) || batchSeen.has(opId))) continue
      // BRG-103: every identity field is unconditionally re-derived here
      // (never a type-check-then-fall-through-to-the-raw-`...op`-value), so
      // a malformed non-string opId/originDevice/targetId/originMemberId/
      // originMemberName can never bypass sanitization and land on disk
      // verbatim. `capId`/`capStr` are the only writers of these keys.
      const toWrite: ModulesSyncOp = {
        ...op,
        opId,
        originDevice: capId(op.originDevice, MEMBER_DEVICE_ID_CAP),
        targetId: capId(op.targetId, OP_ID_CAP),
        originMemberId: typeof op.originMemberId === 'string'
          ? capId(op.originMemberId, MEMBER_DEVICE_ID_CAP)
          : undefined,
        originMemberName: typeof op.originMemberName === 'string'
          ? capStr(op.originMemberName, 200)
          : undefined,
      }
      if (Array.isArray(op.visibleToMemberIds)) {
        toWrite.visibleToMemberIds = op.visibleToMemberIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => capId(id, MEMBER_DEVICE_ID_CAP))
          .filter((id) => id.length > 0)
      }
      let line = ''
      try {
        // One bad op (stringify or at-rest seal) must not abort the rest.
        const plain = JSON.stringify(toWrite)
        line = `${this.atRest ? encryptOpsLine(this.atRest, plain) : plain}\n`
      } catch {
        skippedSeal += 1
        continue
      }
      accepted.push({ opId, line })
      if (opId) batchSeen.add(opId)
    }
    if (accepted.length === 0) {
      if (skippedSeal > 0) {
        throw new OpsPersistSkippedError()
      }
      return
    }

    // TS-SCL-001 + G10: while prune rewrites, write the batch to the
    // sidecar (one syscall) so a process-kill after ops_result still has
    // bytes on disk. Memory mirror lets the in-flight flush skip a re-read.
    //
    // A single accepted op can be as large as the server's per-op/per-frame
    // byte ceiling, so the count cap alone does not bound total memory - a
    // burst of max-sized frames arriving during one prune rewrite could
    // otherwise accumulate far more than the count cap implies before it is
    // ever reached. Refuse (never partially write) when either cap would be
    // exceeded, atomically, before any disk write for this batch happens.
    if (this.opsPruning) {
      let acceptedBytes = 0
      for (const row of accepted) acceptedBytes += Buffer.byteLength(row.line, 'utf8')
      if (
        this.pendingOpAppends.length + accepted.length > OPS_PENDING_APPEND_MAX
        || this.pendingOpAppendBytes + acceptedBytes > OPS_PENDING_APPEND_MAX_BYTES
      ) {
        throw new Error('Op log busy - retry shortly')
      }
    }
    const dest = this.opsPruning ? this.opsPendingPath : this.opsPath
    if (this.opsPruning) this.repairTornTailAt(this.opsPendingPath)
    else this.repairTornOpsTail()
    // BRG-070 (G10, stated decision, not an omission): no `fsync`/
    // `fdatasync` after this write. `appendFileSync` only guarantees the
    // bytes reach the OS page cache, not the physical disk - a sudden
    // power loss between this line and the next fsync-by-something-else
    // can still lose whatever the OS had not flushed. We accept that
    // window rather than pay an fsync-per-batch latency cost on every op
    // (chat/records/whiteboard fan through this same path), because the
    // failure mode this DOES defend against - a crash mid-`write()` producing
    // a torn last line - is fully covered by `repairTornOpsTail`/
    // `repairTornTailAt` above: the next append always detects and repairs
    // a missing trailing newline before writing, so a torn tail can never
    // silently merge with (and corrupt) the next op. What is NOT covered,
    // and is the accepted risk, is losing the last few seconds of
    // already-ACKed ops that never reached the physical disk before power
    // loss. See `docs/SELF-HOST.md` ("Sudden power loss") for the
    // operator-facing statement of this trade-off. Pin:
    // `tests/self-host-power-cut-docs.ts`.
    appendFileSync(dest, accepted.map((row) => row.line).join(''), 'utf8')
    if (this.opsPruning) {
      for (const row of accepted) {
        this.pendingOpAppends.push(row.line)
        this.pendingOpAppendBytes += Buffer.byteLength(row.line, 'utf8')
      }
    }
    for (const row of accepted) {
      if (row.opId) this.rememberOpId(row.opId)
    }
  }

  /**
   * BRG-070: `appendOp` writes each op as `<json>\n` via `appendFileSync`.
   * A crash landing mid-write (killed process, power loss before the write
   * reached disk) can leave `ops.jsonl` ending in a torn, newline-less
   * partial line. Readline-based readers already treat an unparseable line
   * as "skip" (safe), but the NEXT `appendFileSync` after restart would
   * land directly after that torn tail with NO separator, silently MERGING
   * the torn garbage with the brand-new op into one unparseable line - not
   * just losing the old torn write, but losing the very next op written
   * after the crash too. Repair the boundary before every append. A
   * same-process ENOSPC / EIO after a partial write must repair again - a
   * one-shot-per-process flag would merge the next batch into the torn
   * tail. This never rewrites or drops any complete line - it only ever
   * appends a single missing `\n` separator, so a healthy file (already
   * ending in `\n`, or empty) is a one-byte no-op.
   * Sibling: TCC-R1134-CHAT-023 (`repairTornMessagesTail`).
   * Copied in place; do not import the chat store or extract a shared leaf.
   */
  private repairTornOpsTail(): void {
    this.repairTornTailAt(this.opsPath)
  }

  /** BRG-070: ensure `path` ends with `\\n` before the next append can merge. */
  private repairTornTailAt(path: string): void {
    let fd: number | null = null
    try {
      if (!existsSync(path)) return
      fd = openSync(path, 'r+')
      const stat = fstatSync(fd)
      if (stat.size === 0) return
      const buf = Buffer.alloc(1)
      const read = readSync(fd, buf, 0, 1, stat.size - 1)
      if (read === 1 && buf[0] !== 0x0a) {
        writeSync(fd, Buffer.from('\n', 'utf8'), 0, 1, stat.size)
        console.warn(
          `[bridge] repaired a torn ops log write (missing trailing newline) in ${path}`,
        )
      }
    } catch {
      /* best-effort - never block a write over a repair-probe failure */
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd)
        } catch {
          /* fd already invalid/closed */
        }
      }
    }
  }

  private collectOpIdsFromJsonl(raw: string, into: Set<string>): void {
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const plain = decryptOpsLine(this.atRest, line)
        const parsed = JSON.parse(plain) as ModulesSyncOp
        if (typeof parsed.opId === 'string' && parsed.opId) {
          into.add(capId(parsed.opId, OP_ID_CAP))
        }
      } catch { /* skip torn / unparseable */ }
    }
  }

  /**
   * G10: merge a leftover `ops.jsonl.pending` into `ops.jsonl` (boot or
   * prune start). Skip opIds already in the live log so a crash after
   * flush-and-before-unlink cannot duplicate.
   */
  private recoverPendingOps(): void {
    if (!existsSync(this.opsPendingPath)) return
    this.repairTornTailAt(this.opsPendingPath)
    let raw = ''
    try {
      raw = readFileSync(this.opsPendingPath, 'utf8')
    } catch {
      return
    }
    if (!raw.trim()) {
      try { unlinkSync(this.opsPendingPath) } catch { /* */ }
      return
    }
    this.repairTornOpsTail()
    const existing = new Set<string>()
    if (existsSync(this.opsPath)) {
      try {
        this.collectOpIdsFromJsonl(readFileSync(this.opsPath, 'utf8'), existing)
      } catch { /* treat as empty existing set */ }
    }
    const toAppend: string[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const plain = decryptOpsLine(this.atRest, line)
        const parsed = JSON.parse(plain) as ModulesSyncOp
        const id = typeof parsed.opId === 'string' ? capId(parsed.opId, OP_ID_CAP) : ''
        if (id && existing.has(id)) continue
        if (id) existing.add(id)
      } catch {
        // BRG-074: the sidecar is unlinked below, so skipping an unreadable
        // line deletes it. Move it onto the main log verbatim instead - a
        // wrong TEAMSPACE_AT_REST_KEY makes every line unreadable, and these
        // are ops that were never flushed anywhere else. Dedupe is by opId,
        // which cannot be read here, but the sidecar is consumed exactly once
        // per recovery so this cannot append the same bytes twice.
      }
      toAppend.push(line.endsWith('\n') ? line : `${line}\n`)
    }
    if (toAppend.length > 0) {
      appendFileSync(this.opsPath, toAppend.join(''), 'utf8')
    }
    try { unlinkSync(this.opsPendingPath) } catch { /* */ }
    this.pendingOpAppends = []
    this.pendingOpAppendBytes = 0
  }

  /**
   * After rewrite, merge the sidecar (and a memory-only leftover) through
   * `recoverPendingOps` so a failed unlink cannot append the same opId twice.
   */
  private flushPendingOpsOntoLog(): void {
    if (!existsSync(this.opsPendingPath) && this.pendingOpAppends.length > 0) {
      this.repairTornTailAt(this.opsPendingPath)
      appendFileSync(this.opsPendingPath, this.pendingOpAppends.join(''), 'utf8')
    }
    if (existsSync(this.opsPendingPath)) {
      this.recoverPendingOps()
    }
    this.pendingOpAppends = []
    this.pendingOpAppendBytes = 0
  }

  private rememberOpId(opId: string): void {
    this.seenOpIds.add(opId)
    if (this.seenOpIds.size > BridgeStore.SEEN_OP_IDS_MAX) {
      // Drop oldest insertion order (Set iterates insertion order).
      const drop = Math.floor(BridgeStore.SEEN_OP_IDS_MAX / 5)
      let i = 0
      for (const id of this.seenOpIds) {
        this.seenOpIds.delete(id)
        i += 1
        if (i >= drop) break
      }
    }
  }

  /**
   * TCC-R1133-WS-002: shared-read gate. Concurrent (or near-concurrent,
   * within `RECENT_OPS_SHARED_READ_WINDOW_MS`) callers for the same `limit`
   * reuse one real scan instead of each streaming+decrypting the whole ops
   * log. See `recentOpsCache` field doc for the exact sharing contract.
   */
  async readRecentOps(limit = RECENT_OPS_CATCHUP_LIMIT): Promise<ModulesSyncOp[]> {
    const now = Date.now()
    const cached = this.recentOpsCache
    if (
      cached
      && cached.limit === limit
      && (cached.settledAt === null || now - cached.settledAt < RECENT_OPS_SHARED_READ_WINDOW_MS)
    ) {
      this.recentOpsSharedHits += 1
      return cached.promise
    }
    const entry: {
      limit: number
      settledAt: number | null
      promise: Promise<ModulesSyncOp[]>
    } = { limit, settledAt: null, promise: Promise.resolve([]) }
    entry.promise = this.scanRecentOpsFile(limit).then(
      (result) => {
        entry.settledAt = Date.now()
        return result
      },
      (err) => {
        entry.settledAt = Date.now()
        throw err
      },
    )
    this.recentOpsCache = entry
    this.recentOpsRealScans += 1
    return entry.promise
  }

  private async scanRecentOpsFile(limit: number): Promise<ModulesSyncOp[]> {
    if (!existsSync(this.opsPath)) return []
    const out: ModulesSyncOp[] = []
    const rl = createInterface({ input: createReadStream(this.opsPath, { encoding: 'utf8' }) })
    for await (const line of rl) {
      if (!line.trim()) continue
      try {
        const plain = decryptOpsLine(this.atRest, line)
        out.push(JSON.parse(plain) as ModulesSyncOp)
      } catch { /* skip */ }
      if (out.length > limit * 4) out.splice(0, out.length - limit * 2)
    }
    return out.slice(-limit)
  }

  /** Metrics/test helper: how many real file scans vs shared-cache hits since process start. */
  recentOpsCacheStats(): { realScans: number; sharedHits: number } {
    return { realScans: this.recentOpsRealScans, sharedHits: this.recentOpsSharedHits }
  }

  /**
   * BRG-059: how many real full-log decrypt passes vs shared-generation
   * attachments (including late joiners that replay `emitted`) since start.
   */
  fullScanShareStats(): { realScans: number; sharedJoins: number } {
    return { realScans: this.fullScanRealScans, sharedJoins: this.fullScanSharedJoins }
  }

  markAcked(deviceId: string, opIds: string[]): void {
    const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
    if (!d) return
    // BRG-068: a forgotten device must not grow a new ack bag after
    // dropDeviceAcks (late WS ack / debounce). Only registered sessions count.
    if (!isRegisteredDevice(this.members, d)) return
    if (!this.acks[d]) this.acks[d] = {}
    const now = Date.now()
    for (const id of opIds.slice(0, ACK_IDS_PER_CALL)) {
      const capped = capId(id, OP_ID_CAP)
      if (capped) this.acks[d][capped] = now
    }
    for (const m of this.members) {
      if (!memberHasDeviceSession(m, d)) continue
      stampSessionLastSeen(m, d, now)
      this.membersLastSeenDirty = true
    }
    // TCC-R1148-BRG-002: debounce full-file acks.json rewrite under burst.
    this.acksDirty = true
    if (this.acksPersistTimer) return
    this.acksPersistTimer = setTimeout(() => {
      this.acksPersistTimer = null
      if (this.acksDirty) {
        this.persistAcks()
        this.acksDirty = false
      }
      if (this.membersLastSeenDirty) {
        this.persistMembers()
        this.membersLastSeenDirty = false
      }
    }, 50)
    this.acksPersistTimer.unref?.()
  }

  /** Flush any debounced ack persist (tests / shutdown). */
  flushAcksPersist(): void {
    if (this.acksPersistTimer) {
      clearTimeout(this.acksPersistTimer)
      this.acksPersistTimer = null
    }
    if (this.acksDirty) {
      this.persistAcks()
      this.acksDirty = false
    }
    if (this.membersLastSeenDirty) {
      this.persistMembers()
      this.membersLastSeenDirty = false
    }
  }

  /** BRG-068: live devices that held past-retention lines on the last prune. */
  lastPruneBlockingDeviceIds(): string[] {
    return this.pruneBlockingDeviceIds.slice()
  }

  /** BRG-068: last prune dropped oldest lines to stay under the byte ceiling. */
  lastPruneForcedResync(): boolean {
    return this.pruneForcedResync
  }

  /** BRG-068: lines evicted by the byte ceiling on the last prune (0 if none). */
  lastPruneByteCeilingEvicted(): number {
    return this.pruneByteCeilingEvicted
  }

  /**
   * BRG-068: explicit last-seen stamp, else max(acks[d]). Missing both
   * is null (new device still counts in quorum).
   */
  private deviceEffectiveLastSeenMs(deviceId: string): number | null {
    let fromStamp = 0
    for (const m of this.members) {
      const at = m.sessionLastSeen?.[deviceId]
      if (typeof at === 'number' && Number.isFinite(at) && at > 0 && at > fromStamp) {
        fromStamp = at
      }
    }
    let fromAcks = 0
    const bag = this.acks[deviceId]
    if (bag && typeof bag === 'object') {
      for (const at of Object.values(bag)) {
        if (typeof at === 'number' && Number.isFinite(at) && at > fromAcks) fromAcks = at
      }
    }
    const max = Math.max(fromStamp, fromAcks)
    return max > 0 ? max : null
  }

  /** BRG-068: last-seen (or inferred ack max) older than the stale ceiling. */
  private deviceIsStaleForPrune(deviceId: string, staleBefore: number): boolean {
    const seen = this.deviceEffectiveLastSeenMs(deviceId)
    if (seen === null) return false
    return seen < staleBefore
  }

  /** True when this device already stamped the op (catch-up skip). */
  hasAcked(deviceId: string, opId: string): boolean {
    const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
    const id = capId(opId, OP_ID_CAP)
    if (!d || !id) return false
    const bag = this.acks[d]
    return !!(bag && typeof bag[id] === 'number')
  }

  /** How many op ids this device has acked (0 = never caught up / new device). */
  deviceAckCount(deviceId: string): number {
    const d = capId(deviceId, MEMBER_DEVICE_ID_CAP)
    if (!d) return 0
    const bag = this.acks[d]
    if (!bag || typeof bag !== 'object') return 0
    return Object.keys(bag).length
  }

  /**
   * BRG-059: stream the durable op log from the start (oldest first).
   * Catch-up for a zero-ack device must not use `readRecentOps` (tail only).
   *
   * Concurrent callers share one scan/decrypt pass (TCC-R1133-WS-002 analog).
   * Add the waiter first, then replay `emitted` (same tick, no await between
   * those two steps) so a joiner after the first yield still sees prefix ops
   * without a second decrypt.
   */
  async *scanOpsFromStart(): AsyncGenerator<ModulesSyncOp> {
    const waiter: FullScanWaiter = { q: [], wake: null, done: false, err: undefined }
    const existing = this.fullScanShare
    if (existing) {
      this.fullScanSharedJoins += 1
      existing.waiters.add(waiter)
      const replay = existing.emitted.slice()
      try {
        for (const op of replay) yield op
        if (existing.finished && waiter.q.length === 0) return
        yield* this.consumeFullScanWaiter(waiter)
      } finally {
        existing.waiters.delete(waiter)
      }
      return
    }

    const gen: FullScanGeneration = {
      yielded: false,
      finished: false,
      emitted: [],
      waiters: new Set([waiter]),
    }
    this.fullScanShare = gen
    this.fullScanRealScans += 1
    void this.fullScanProducerLock.run(async () => {
      await this.runSharedFullScan(gen)
    })
    try {
      yield* this.consumeFullScanWaiter(waiter)
    } finally {
      gen.waiters.delete(waiter)
    }
  }

  private async *consumeFullScanWaiter(w: FullScanWaiter): AsyncGenerator<ModulesSyncOp> {
    for (;;) {
      if (w.q.length > 0) {
        const op = w.q.shift()
        if (op) yield op
        continue
      }
      if (w.err !== undefined) throw w.err
      if (w.done) return
      await new Promise<void>((resolve) => {
        w.wake = resolve
        if (w.q.length > 0 || w.done || w.err !== undefined) {
          w.wake = null
          resolve()
        }
      })
    }
  }

  private async runSharedFullScan(gen: FullScanGeneration): Promise<void> {
    try {
      for await (const op of this.scanOpsFromStartUnshared()) {
        if (!gen.yielded) gen.yielded = true
        gen.emitted.push(op)
        const waiters = [...gen.waiters]
        for (const w of waiters) {
          w.q.push(op)
          const wake = w.wake
          w.wake = null
          if (wake) wake()
        }
      }
      gen.finished = true
      const finished = [...gen.waiters]
      for (const w of finished) {
        w.done = true
        const wake = w.wake
        w.wake = null
        if (wake) wake()
      }
    } catch (err) {
      gen.finished = true
      const failed = [...gen.waiters]
      for (const w of failed) {
        w.err = err
        w.done = true
        const wake = w.wake
        w.wake = null
        if (wake) wake()
      }
    } finally {
      if (this.fullScanShare === gen) this.fullScanShare = null
    }
  }

  /**
   * Private unshared file scan. `sendFullCatchUpOps` must call the
   * public shared `scanOpsFromStart`, never this method (BRG-059).
   */
  private async *scanOpsFromStartUnshared(): AsyncGenerator<ModulesSyncOp> {
    if (!existsSync(this.opsPath)) return
    const input = createReadStream(this.opsPath, { encoding: 'utf8' })
    const rl = createInterface({ input })
    try {
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const plain = decryptOpsLine(this.atRest, line)
          yield JSON.parse(plain) as ModulesSyncOp
        } catch { /* skip */ }
      }
    } finally {
      rl.close()
      input.destroy()
    }
  }

  /** TS-BRG-010: prune ONLY ops fully acked by every known device AND past retention. */
  async pruneOps(): Promise<number> {
    if (this.opsPruning) return 0
    this.recoverPendingOps()
    if (!existsSync(this.opsPath)) return 0
    this.opsPruning = true
    this.pendingOpAppends = []
    this.pendingOpAppendBytes = 0
    try {
      const now = Date.now()
      const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000
      const staleBefore = now - TEAMSPACE_DEVICE_STALE_DAYS * 24 * 60 * 60 * 1000
      const devices = new Set<string>()
      for (const m of this.members) {
        for (const d of Object.keys(m.sessions || {})) devices.add(d)
      }
      const kept: { line: string; opId: string }[] = []
      const keepRow = (line: string, opId: string): void => {
        kept.push({ line, opId })
      }
      const blocking = new Set<string>()
      let removed = 0
      let unreadable = 0
      const rl = createInterface({ input: createReadStream(this.opsPath, { encoding: 'utf8' }) })
      for await (const line of rl) {
        if (!line.trim()) continue
        let op: ModulesSyncOp
        try {
          const plain = decryptOpsLine(this.atRest, line)
          op = JSON.parse(plain) as ModulesSyncOp
        } catch {
          // BRG-074: a line this process cannot READ is not a line it may
          // DELETE. `decryptOpsLine` throws for every encrypted row when
          // TEAMSPACE_AT_REST_KEY is missing or wrong, so folding the failure
          // into `removed` and rewriting from `kept` truncated the entire ops
          // log to zero bytes on the first hourly prune after a bad redeploy,
          // turning a recoverable key mistake into permanent loss. Carry the
          // bytes through verbatim with no opId: retention and the ack rules
          // still apply to every line this process can read, and the byte
          // ceiling below stays the only path that may ever evict one of
          // these (loud warn + forced resync). Same polarity members.json /
          // invites.json already keep, and the same reasoning as the
          // encrypt-failure branch below ("dropping it would lose an op").
          unreadable++
          keepRow(line, '')
          continue
        }
        const opId = typeof op.opId === 'string' ? capId(op.opId, OP_ID_CAP) : ''
        if (!opId) {
          removed++
          continue
        }
        op.opId = opId
        // BRG-103: unconditional re-derive (never leave a non-string
        // originDevice/targetId untouched) - same sanitization-bypass class
        // fixed in `appendOps` above, reached here for any malformed line
        // that already made it onto disk (legacy write path, direct
        // members.json-style hand edit, or a torn-tail repair that only
        // restores the newline, never the content).
        op.originDevice = capId(op.originDevice, MEMBER_DEVICE_ID_CAP)
        op.targetId = capId(op.targetId, OP_ID_CAP)
        if (typeof op.originMemberId === 'string') {
          op.originMemberId = capId(op.originMemberId, MEMBER_DEVICE_ID_CAP)
        } else {
          delete op.originMemberId
        }
        if (typeof op.originMemberName === 'string') {
          op.originMemberName = capStr(op.originMemberName, 200)
        } else {
          delete op.originMemberName
        }
        let keepLine = line
        try {
          keepLine = this.atRest
            ? encryptOpsLine(this.atRest, JSON.stringify(op))
            : JSON.stringify(op)
        } catch {
          // Already-durable line stays. Dropping it would lose a parsed op.
          keepLine = line
        }
        // Never drop while ANY registered device has not acked this op.
        if (devices.size === 0) {
          keepRow(keepLine, opId)
          continue
        }
        let ackedByAll = true
        const ackTimes: number[] = []
        const liveUnacked: string[] = []
        for (const d of devices) {
          // BRG-068: skip a stale device so retention can drop lines it never acked.
          if (this.deviceIsStaleForPrune(d, staleBefore)) continue
          const at = this.acks[d]?.[opId]
          if (typeof at !== 'number') {
            ackedByAll = false
            liveUnacked.push(d)
            continue
          }
          ackTimes.push(at)
        }
        if (!ackedByAll) {
          keepRow(keepLine, opId)
          if (ackTimes.length === 0 || Math.min(...ackTimes) < cutoff) {
            for (const d of liveUnacked) blocking.add(d)
          }
          continue
        }
        // Fully acked by every live device: prune after the oldest live ack
        // is past retention. Empty ackTimes = every registered device was
        // stale-skipped (BRG-068 residual) - apply retention against stale
        // acks or a parseable HLC wall, never keep forever.
        if (ackTimes.length === 0) {
          let ageMs: number | null = null
          for (const d of devices) {
            const at = this.acks[d]?.[opId]
            if (typeof at === 'number' && Number.isFinite(at)) {
              ageMs = ageMs === null ? at : Math.min(ageMs, at)
            }
          }
          if (ageMs === null) ageMs = opWallMsFromHlc(op.hlc)
          if (ageMs !== null && ageMs < cutoff) {
            removed++
            continue
          }
          keepRow(keepLine, opId)
          continue
        }
        if (Math.min(...ackTimes) >= cutoff) {
          keepRow(keepLine, opId)
          continue
        }
        removed++
      }
      if (unreadable > 0) {
        console.warn(
          `[bridge] ${unreadable} op log line(s) could not be read - they were kept on disk`
          + ' untouched, so no op was pruned from them. Check TEAMSPACE_AT_REST_KEY.',
        )
      }
      let keptBytes = 0
      for (const row of kept) keptBytes += Buffer.byteLength(row.line, 'utf8') + 1
      this.pruneForcedResync = false
      this.pruneByteCeilingEvicted = 0
      if (keptBytes > this.opsLogMaxBytes && kept.length > 0) {
        let drop = 0
        while (drop < kept.length && keptBytes > this.opsLogMaxBytes) {
          keptBytes -= Buffer.byteLength(kept[drop]!.line, 'utf8') + 1
          drop += 1
        }
        if (drop > 0) {
          kept.splice(0, drop)
          removed += drop
          this.pruneForcedResync = true
          this.pruneByteCeilingEvicted = drop
          console.warn(
            `[bridge] op log hit the byte ceiling (${this.opsLogMaxBytes} bytes); some devices may need a full resync`,
          )
        }
      }
      const tmp = `${this.opsPath}.rewrite`
      writeFileSync(tmp, kept.length ? `${kept.map((row) => row.line).join('\n')}\n` : '', 'utf8')
      renameSync(tmp, this.opsPath)
      const pendingIds = new Set<string>()
      if (existsSync(this.opsPendingPath)) {
        try {
          this.collectOpIdsFromJsonl(readFileSync(this.opsPendingPath, 'utf8'), pendingIds)
        } catch { /* */ }
      }
      for (const line of this.pendingOpAppends) {
        this.collectOpIdsFromJsonl(line, pendingIds)
      }
      this.flushPendingOpsOntoLog()
      // TCC-R1148-BRG-002: drop ack keys for opIds no longer in the log so
      // acks.json cannot grow without bound after prune removes lines.
      // Ids come from the first decrypt pass (keepRow), never a second walk.
      const keptIds = new Set<string>()
      // BRG-074: an unreadable line is kept with no opId - never seed '' here,
      // or an ack bag keyed by an empty string would survive every prune.
      for (const row of kept) {
        if (row.opId) keptIds.add(row.opId)
      }
      for (const id of pendingIds) keptIds.add(id)
      let acksChanged = false
      for (const d of Object.keys(this.acks)) {
        const bag = this.acks[d]
        if (!bag || typeof bag !== 'object') continue
        for (const id of Object.keys(bag)) {
          if (!keptIds.has(id)) {
            delete bag[id]
            acksChanged = true
          }
        }
        if (Object.keys(bag).length === 0) {
          delete this.acks[d]
          acksChanged = true
        }
      }
      if (acksChanged) {
        this.persistAcks()
        this.acksDirty = false
      }
      this.pruneBlockingDeviceIds = [...blocking].sort()
      if (this.pruneBlockingDeviceIds.length > 0) {
        console.warn(
          `[bridge] op log prune held by device(s): ${this.pruneBlockingDeviceIds.join(', ')}`,
        )
      }
      return removed
    } finally {
      this.opsPruning = false
      // Race: appends after rename but before this flag cleared - flush leftovers.
      try {
        this.flushPendingOpsOntoLog()
      } catch { /* */ }
    }
  }

  blobPath(sha256: string): string {
    const hex = sha256.toLowerCase().replace(/[^a-f0-9]/g, '')
    if (hex.length !== 64) throw new Error('Invalid blob id')
    return join(this.blobsDir, hex)
  }

  hasBlob(sha256: string): boolean {
    try {
      return existsSync(this.blobPath(sha256))
    } catch {
      return false
    }
  }

  /**
   * TCC-R1154-BRG-002 / BRG-069: O(1) on-disk CRM blob bytes (encrypted size
   * when at-rest). Walk lives in crm-blob-disk seed, not on this read.
   */
  blobDiskBytes(): number {
    return this.blobDisk.bytes()
  }

  /**
   * TCC-R1154-BRG-003: sweep leftover `blobs/*.part` older than graceMs.
   * Skips files newer than grace so a live upload is not unlinked mid-write.
   */
  cleanupBlobPartials(graceMs = 60 * 60_000): number {
    const cutoff = Date.now() - Math.max(60_000, graceMs)
    let removed = 0
    try {
      for (const f of readdirSync(this.blobsDir)) {
        if (!f.endsWith('.part')) continue
        const p = join(this.blobsDir, f)
        try {
          const st = statSync(p)
          if (st.mtimeMs > cutoff) continue
          unlinkSync(p)
          removed += 1
        } catch { /* */ }
      }
    } catch { /* */ }
    return removed
  }

  /**
   * TCC-R1146-BRG-002: stream-hash an existing at-rest/plain blob without
   * loading the full file into a single Buffer. Callers MUST reserve
   * download heap first (plain size is not known until the stream ends).
   */
  async verifyExistingBlobSha(sha256Expected: string): Promise<
    | { ok: true; bytes: number }
    | { ok: false; error: string }
  > {
    const expected = sha256Expected.toLowerCase().replace(/[^a-f0-9]/g, '')
    if (expected.length !== 64) return { ok: false, error: 'Invalid sha256' }
    try {
      const dest = this.blobPath(expected)
      if (!existsSync(dest)) return { ok: false, error: 'Not found' }
      const hash = createHash('sha256')
      let bytes = 0
      const hasher = new Transform({
        transform(chunk, _enc, cb) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buf.length
          hash.update(buf)
          cb()
        },
      })
      await pipeline(createReadStream(dest), createBlobDecryptTransform(this.atRest), hasher)
      const actual = hash.digest('hex')
      if (actual !== expected) return { ok: false, error: 'Blob checksum mismatch on server' }
      return { ok: true, bytes }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error && /TEAMSPACE_AT_REST_KEY/.test(err.message)
          ? 'Encrypted blob requires TEAMSPACE_AT_REST_KEY'
          : 'Could not verify existing blob',
      }
    }
  }

  async putBlobFromStream(
    sha256Expected: string,
    stream: NodeJS.ReadableStream,
    contentLength: number,
    opts?: { diskMaxBytes?: number; skipDiskQuota?: boolean },
  ): Promise<{ ok: true; sha256: string; bytes: number } | { ok: false; error: string; status?: number }> {
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > MAX_BLOB_BYTES) {
      return { ok: false, error: 'Invalid Content-Length' }
    }
    const expected = sha256Expected.toLowerCase().replace(/[^a-f0-9]/g, '')
    if (expected.length !== 64) return { ok: false, error: 'Invalid sha256' }
    const dest = this.blobPath(expected)
    if (existsSync(dest)) {
      // TS-DAE-011 + TCC-R1146-BRG-002: drain upload body, verify via helper
      // (caller reserves download heap around verifyExistingBlobSha).
      await new Promise<void>((resolve) => {
        stream.resume()
        stream.on('end', () => resolve())
        stream.on('error', () => resolve())
      })
      const verified = await this.verifyExistingBlobSha(expected)
      if (!verified.ok) return verified
      return { ok: true, sha256: expected, bytes: verified.bytes }
    }
    const diskMax = opts?.diskMaxBytes ?? CRM_BLOBS_DISK_MAX_BYTES
    if (!opts?.skipDiskQuota) {
      const used = this.blobDiskBytes()
      if (used + contentLength > diskMax) {
        return {
          ok: false,
          error: 'Team media storage is full. Ask an Admin to free space or raise the limit.',
          status: 413,
        }
      }
    }
    const tmp = `${dest}.${process.pid}.${randomBytes(8).toString('hex')}.part`
    const hash = createHash('sha256')
    let bytes = 0
    // BRG-069: same write as backup putSnapshotFromStream. Stream
    // plaintext to tmp while hashing. At-rest encrypt is a second
    // streaming TSB1 pass (`encryptBlobFile`), never readFileSync(tmp).
    const hasher = new Transform({
      transform(chunk, _enc, cb) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buf.length
        // TCC-R1152-BRG-004: never accept more bytes than declared Content-Length.
        if (bytes > contentLength || bytes > MAX_BLOB_BYTES) {
          cb(new Error(
            bytes > contentLength
              ? 'Body larger than Content-Length'
              : 'Blob too large',
          ))
          return
        }
        hash.update(buf)
        cb(null, buf)
      },
    })
    try {
      await pipeline(stream, hasher, createWriteStream(tmp))
      if (bytes !== contentLength) {
        try { unlinkSync(tmp) } catch { /* */ }
        return { ok: false, error: 'Body length does not match Content-Length' }
      }
      const actual = hash.digest('hex')
      if (actual !== expected) {
        try { unlinkSync(tmp) } catch { /* */ }
        return { ok: false, error: 'Checksum mismatch' }
      }
      let toWrite: { length: number } = { length: bytes }
      if (this.atRest) {
        const encTmp = `${tmp}.tsb1`
        try {
          const onDiskBytes = encryptBlobFile(this.atRest, tmp, encTmp)
          try { unlinkSync(tmp) } catch { /* */ }
          renameSync(encTmp, tmp)
          toWrite = { length: onDiskBytes }
        } catch (encErr) {
          try { unlinkSync(encTmp) } catch { /* */ }
          throw encErr
        }
      }
      // BRG-069: quota + rename + increment stay in one sync stretch (no
      // await) so two finishes cannot both pass the pre-stream check.
      // Increment uses on-disk toWrite.length, not Content-Length.
      // Same-sha overlap: both puts can pass the pre-stream existsSync, then
      // await pipeline. The first rename wins; the second must not increment.
      if (existsSync(dest)) {
        try { unlinkSync(tmp) } catch { /* */ }
        return { ok: true, sha256: actual, bytes }
      }
      if (!opts?.skipDiskQuota) {
        const used = this.blobDiskBytes()
        if (used + toWrite.length > diskMax) {
          try { unlinkSync(tmp) } catch { /* */ }
          return {
            ok: false,
            error: 'Team media storage is full. Ask an Admin to free space or raise the limit.',
            status: 413,
          }
        }
      }
      renameSync(tmp, dest)
      this.blobDisk.addAfterNewPut(toWrite.length)
      return { ok: true, sha256: actual, bytes }
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* */ }
      try { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.() } catch { /* */ }
      return { ok: false, error: err instanceof Error ? capStr(err.message, 120) : 'Blob write failed' }
    }
  }

  openBlobRead(sha256: string): { stream: NodeJS.ReadableStream; size: number; releasePlain?: () => void } | null {
    try {
      const p = this.blobPath(sha256)
      if (!existsSync(p)) return null
      const onDisk = readFileSync(p)
      const plain = decryptBlobBody(this.atRest, onDisk)
      return { stream: Readable.from(plain), size: plain.length }
    } catch {
      return null
    }
  }

  /** Plain size for download-budget reserve before openBlobRead. */
  blobOnDiskSize(sha256: string): number | null {
    try {
      const p = this.blobPath(sha256)
      if (!existsSync(p)) return null
      return statSync(p).size
    } catch {
      return null
    }
  }

  /** BRG-069: O(1) hex count after seed. Must not readdir on this path. */
  blobCount(): number {
    return this.blobDisk.count()
  }
}

/**
 * BRG-067: a non-empty `appendOps` batch that produced zero durable lines
 * (every remaining op failed stringify or at-rest seal) must throw so
 * `handleOps` cannot ACK a skip. Seen-id skips are not this error.
 *
 * Declared after `BridgeStore` (not before) so source-scan test helpers that
 * grep the file for the first `constructor(` occurrence land on the store's
 * own constructor, never this error's. Test-fixture ordering hazard, not a
 * runtime one - class declaration order carries no hoisting semantics for a
 * `throw new OpsPersistSkippedError()` reached only inside a later method call.
 */
export class OpsPersistSkippedError extends Error {
  constructor() {
    super('Op log persist skipped - no durable lines')
    this.name = 'OpsPersistSkippedError'
  }
}

export const MAX_BLOB_BYTES_EXPORT = MAX_BLOB_BYTES
