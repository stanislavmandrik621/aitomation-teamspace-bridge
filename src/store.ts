/**
 * Durable Team Space bridge store (file-backed under TEAMSPACE_DATA_DIR).
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  createReadStream,
  readdirSync,
  unlinkSync,
  renameSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
import type { BridgeRole, ModulesSyncOp } from './index.js'
import {
  type AtRestKey,
  decryptBlobBody,
  decryptJsonFile,
  decryptOpsLine,
  encryptBlobBody,
  encryptJsonFile,
  encryptOpsLine,
  resolveAtRestKeyFromEnv,
} from './at-rest.js'
import {
  ACK_IDS_PER_CALL,
  CRM_BLOBS_DISK_MAX_BYTES,
  RECENT_OPS_CATCHUP_LIMIT,
  RECENT_OPS_SHARED_READ_WINDOW_MS,
} from './throughput.js'
import { pageMembersList } from './members-page.js'
import {
  ADMIN_RECOVERY_REFUSE_BAD_KEY,
  ADMIN_RECOVERY_REFUSE_NO_ADMIN,
  ADMIN_RECOVERY_REFUSE_UNAVAILABLE,
  type AdminRecoveryKey,
  adminRecoveryKeyMatches,
  hasPresentedAdminRecoveryKey,
  resolveAdminRecoveryKey,
} from './admin-recovery.js'

export type MemberRow = {
  memberId: string
  email: string
  displayName: string
  role: BridgeRole
  /** deviceId -> sessionToken */
  sessions: Record<string, string>
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
  for (const deviceId of evicted) delete member.sessions[deviceId]
  return evicted
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

function atomicWriteJson(path: string, data: unknown, atRest: AtRestKey | null): void {
  const tmp = `${path}.${process.pid}.tmp`
  const body = atRest
    ? encryptJsonFile(atRest, data)
    : JSON.stringify(data, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
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
      const memberId = typeof r.memberId === 'string' ? r.memberId.slice(0, 128) : ''
      if (!memberId) continue
      const sessionsRaw = r.sessions && typeof r.sessions === 'object' && !Array.isArray(r.sessions)
        ? r.sessions as Record<string, unknown>
        : {}
      const sessions: Record<string, string> = {}
      for (const [deviceId, tok] of Object.entries(sessionsRaw)) {
        if (typeof tok !== 'string' || !tok) continue
        const d = String(deviceId).slice(0, 128)
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
        email: typeof r.email === 'string' ? r.email.slice(0, 320) : '',
        displayName: typeof r.displayName === 'string' ? r.displayName.slice(0, 200) : '',
        role: r.role === 'admin' || r.role === 'viewer' || r.role === 'member' ? r.role : 'member',
        sessions,
        createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
        avatarRef: r.avatarRef === null
          ? null
          : typeof r.avatarRef === 'string'
            ? r.avatarRef.slice(0, 256)
            : undefined,
        avatarRev: typeof r.avatarRev === 'number' && Number.isFinite(r.avatarRev) && r.avatarRev > 0
          ? Math.floor(r.avatarRev)
          : undefined,
        joinedViaInviteId: typeof r.joinedViaInviteId === 'string' && r.joinedViaInviteId.trim()
          ? r.joinedViaInviteId.trim().slice(0, 80)
          : undefined,
      })
    }
    return { ok: true, members, migratedHashes }
  } catch (err) {
    quarantineMembersFile(path, 'io')
    return {
      ok: false,
      reason: err instanceof Error
        ? `members.json unreadable: ${err.message.slice(0, 120)}`
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
      const d = String(deviceId).slice(0, 128)
      if (!d || !bag || typeof bag !== 'object' || Array.isArray(bag)) continue
      const inner: Record<string, number> = {}
      for (const [opId, at] of Object.entries(bag as Record<string, unknown>)) {
        const id = String(opId).slice(0, 200)
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
        ? `invites.json unreadable: ${err.message.slice(0, 120)}`
        : 'invites.json unreadable - restore from backup before creating or cancelling invites',
    }
  }
}

/** Stable invite id for legacy rows that predate the id field (TS-SHR-019). */
function inviteIdFromRow(row: { id?: unknown; token?: unknown }): string {
  if (typeof row.id === 'string' && row.id.trim()) return row.id.trim().slice(0, 80)
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
      email: typeof r.email === 'string' ? r.email : '',
      role: r.role === 'viewer' || r.role === 'member' || r.role === 'admin' ? r.role : 'member',
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
      createdAt: typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
      // TCC-R1186-INV-001 (TS-CHAT-031 family): rows predating expiresAt count
      // as EXPIRED, never as fresh. The old `Date.now()` default re-minted the
      // deadline on every load (redeem re-reads disk, then compares
      // `expiresAt < Date.now()` in the same millisecond), so a legacy row was
      // effectively immortal and redeemable forever. 0 = always expired ->
      // pruned + cleared from disk on the next touchpoint.
      expiresAt: typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt) ? r.expiresAt : 0,
      usedAt: typeof r.usedAt === 'number' ? r.usedAt : null,
      usedBy: typeof r.usedBy === 'string' ? r.usedBy : null,
    })
  }
  return out
}

export function mintToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString('hex')}`
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
  private blobsDir: string

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
   * TS-SCL-001: while pruneOps rewrites ops.jsonl, buffer appends so concurrent
   * appendOp calls are not lost between read and rename.
   */
  private opsPruning = false
  private pendingOpAppends: string[] = []
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
   * TCC-R1150-BRG-002: in-process opId idempotency so a lost `ops_result`
   * retry cannot double-append the same line while this process is up.
   */
  private seenOpIds = new Set<string>()
  private static readonly SEEN_OP_IDS_MAX = 50_000
  /** TCC-R1148-BRG-002: coalesce ack persist under bursty ack_ops. */
  private acksPersistTimer: ReturnType<typeof setTimeout> | null = null
  private acksDirty = false

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
  ) {
    this.root = root
    this.retentionDays = Math.max(1, Math.min(365, Math.floor(retentionDays)))
    this.atRest = atRest
    mkdirSync(root, { recursive: true })
    this.adminRecovery =
      adminRecovery === undefined ? resolveAdminRecoveryKey(root) : adminRecovery
    this.membersPath = join(root, 'members.json')
    this.invitesPath = join(root, 'invites.json')
    this.metaPath = join(root, 'team.json')
    this.acksPath = join(root, 'acks.json')
    this.opsPath = join(root, 'ops.jsonl')
    this.blobsDir = join(root, 'blobs')
    mkdirSync(this.blobsDir, { recursive: true })
    this.reload()
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

  private persistMembers(): void {
    atomicWriteJson(this.membersPath, this.members, this.atRest)
  }
  private persistInvites(): void {
    atomicWriteJson(this.invitesPath, this.invites, this.atRest)
  }
  private persistMeta(): void {
    if (this.meta) atomicWriteJson(this.metaPath, this.meta, this.atRest)
  }
  private persistAcks(): void {
    atomicWriteJson(this.acksPath, this.acks, this.atRest)
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
    this.meta = { teamId: mintId('team'), createdAt: Date.now(), name: name.slice(0, 200) }
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
    const next = String(name || '').trim().slice(0, 200) || 'Team Space'
    if (team.name === next) return team
    this.meta = { ...team, name: next }
    this.persistMeta()
    return this.meta
  }

  listMembers(): MemberRow[] {
    return this.members.slice()
  }

  /**
   * TS-MEM-001: Admin roster page (limit/offset + total/has_more honesty).
   * Full `listMembers()` stays for internal live-set checks (kick/presence).
   */
  listMembersPage(args?: { limit?: unknown; offset?: unknown }): {
    members: MemberRow[]
    total: number
    limit: number
    offset: number
    has_more: boolean
    truncated: boolean
  } {
    return pageMembersList(this.members, args?.limit, args?.offset)
  }

  findMember(memberId: string): MemberRow | undefined {
    return this.members.find((m) => m.memberId === memberId)
  }

  findBySession(sessionToken: string): { member: MemberRow; deviceId: string } | null {
    if (!sessionToken || sessionToken.length > 500) return null
    const hashed = hashSessionToken(sessionToken)
    for (const m of this.members) {
      for (const [deviceId, tok] of Object.entries(m.sessions || {})) {
        // Compare hashed form; tolerate one-shot legacy plaintext match + migrate.
        if (tok === hashed) return { member: m, deviceId }
        // TCC-R1132-TLS-001: the legacy-plaintext migrate branch must NEVER fire
        // when the stored value already looks like a hash - otherwise presenting
        // the disk hash itself as the bearer token satisfies `tok === sessionToken`
        // (hash accepted as a credential), then rewrites the row to hash-of-hash
        // and locks the real token holder out. Once `tok` is a hash, only the
        // hashed-compare above may authenticate it.
        if (!looksHashedToken(tok) && tok === sessionToken) {
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
    const memberId = args.memberId.trim().slice(0, 128)
    const deviceId = args.deviceId.trim().slice(0, 128)
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
      const member: MemberRow = {
        memberId,
        email: (args.memberEmail || '').trim().slice(0, 320),
        displayName: (args.displayName || args.memberEmail || 'Admin').trim().slice(0, 200),
        role: 'admin',
        sessions: { [deviceId]: hashSessionToken(token) },
        createdAt: Date.now(),
      }
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
      const matches = stored === hashSessionToken(sessionToken)
        || (!looksHashedToken(stored) && stored === sessionToken)
      if (!matches) {
        return { ok: false, reason: 'Invalid session for this device' }
      }
    }
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
    this.persistMembers()
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
      email: email.trim().slice(0, 320),
      role: inviteRole,
      createdBy,
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
    const key = String(tokenOrId || '').trim()
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
    if (invite.token === presentedHash) return true
    return !looksHashedToken(invite.token) && invite.token === token
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
    const deviceId = args.deviceId.trim().slice(0, 128)
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
    const inviteEmailForLastAdminCheck = (invite.email || '').trim().slice(0, 320)
    if (inviteEmailForLastAdminCheck && (invite.role === 'member' || invite.role === 'viewer')) {
      const existingTarget = this.members.find(
        (m) => m.email && m.email.toLowerCase() === inviteEmailForLastAdminCheck.toLowerCase(),
      )
      if (existingTarget && existingTarget.role === 'admin') {
        const admins = this.members.filter((m) => m.role === 'admin')
        if (admins.length <= 1) {
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

    const inviteEmail = (invite.email || '').trim().slice(0, 320)
    const email = inviteEmail
    let member = inviteEmail
      ? this.members.find((m) => m.email && m.email.toLowerCase() === inviteEmail.toLowerCase())
      : undefined
    const sessionToken = mintToken()
    const sessionHash = hashSessionToken(sessionToken)
    if (!member) {
      member = {
        memberId: mintId('mem'),
        email,
        displayName: (args.displayName || email || 'Teammate').trim().slice(0, 200),
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
      this.members.push(member)
    } else {
      member.sessions = { [deviceId]: sessionHash }
      // TCC-R1143-INV-001: apply invite role including admin elevation.
      // TCC-R1127-BRG-001: last-admin demotion via this assignment is refused
      // above (before the claim) when `member` would be the sole Admin.
      if (invite.role === 'admin' || invite.role === 'member' || invite.role === 'viewer') {
        // TCC-R1144-ENT-004: re-check last-admin immediately before demote assign.
        if (member.role === 'admin' && invite.role !== 'admin') {
          const adminsNow = this.members.filter((m) => m.role === 'admin')
          if (adminsNow.length <= 1) {
            return { ok: false, reason: 'Cannot demote the last admin' }
          }
        }
        member.role = invite.role
      }
      // TCC-R1152-LIM-001: do not overwrite a real personal name on re-redeem
      // with a shared team label / empty paste from Settings.
      if (args.displayName && typeof args.displayName === 'string' && args.displayName.trim()) {
        const next = args.displayName.trim().slice(0, 200)
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
      const actor = this.members.find((m) => m.memberId === actorMemberId)
      if (!actor || actor.role !== 'admin') return { ok: false as const, reason: 'Admin only' }
      const targetId = targetMemberId.trim().slice(0, 128)
      if (!targetId) return { ok: false as const, reason: 'memberId required' }
      if (targetId === actorMemberId) return { ok: false as const, reason: 'Cannot kick yourself' }
      const idx = this.members.findIndex((m) => m.memberId === targetId)
      if (idx < 0) return { ok: false as const, reason: 'Member not found' }
      const target = this.members[idx]!
      const admins = this.members.filter((m) => m.role === 'admin')
      if (target.role === 'admin' && admins.length <= 1) {
        return { ok: false as const, reason: 'Cannot kick the last admin' }
      }
      const kickedDeviceIds = Object.keys(target.sessions)
      this.members.splice(idx, 1)
      this.persistMembers()
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
    if (this.membersLoadFailed) return { ok: false, reason: this.membersStoreError() }
    const actor = this.members.find((m) => m.memberId === args.actorMemberId)
    if (!actor || actor.role !== 'admin') return { ok: false, reason: 'Admin only' }
    const target = this.members.find((m) => m.memberId === args.targetMemberId.trim().slice(0, 128))
    if (!target) return { ok: false, reason: 'Member not found' }
    const deviceId = typeof args.deviceId === 'string' ? args.deviceId.trim().slice(0, 128) : ''
    // TCC-R1148-ENT-003: refuse revoke that would leave the sole Admin with
    // zero live device sessions (same class as leave/kick/setRole last-admin).
    // Without this any Admin WS can clear every device for the last Admin
    // (including self) and brick the team - roster stays admin with sessions={}.
    if (target.role === 'admin') {
      const admins = this.members.filter((m) => m.role === 'admin')
      if (admins.length <= 1) {
        const remainingAfter = deviceId
          ? Object.keys(target.sessions).filter((id) => id !== deviceId)
          : []
        if (remainingAfter.length === 0) {
          return {
            ok: false,
            reason: 'Cannot revoke the last Admin session - promote another Admin first',
          }
        }
      }
    }
    let revoked: string[] = []
    if (deviceId) {
      if (!target.sessions[deviceId]) return { ok: false, reason: 'Device session not found' }
      delete target.sessions[deviceId]
      revoked = [deviceId]
    } else {
      revoked = Object.keys(target.sessions)
      target.sessions = {}
    }
    this.persistMembers()
    return { ok: true, revokedDeviceIds: revoked }
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
      const actor = this.members.find((m) => m.memberId === args.actorMemberId)
      if (!actor || actor.role !== 'admin') return { ok: false as const, reason: 'Admin only' }
      const target = this.members.find((m) => m.memberId === args.targetMemberId.trim().slice(0, 128))
      if (!target) return { ok: false as const, reason: 'Member not found' }
      const role = args.role === 'viewer' || args.role === 'member' || args.role === 'admin'
        ? args.role
        : null
      if (!role) return { ok: false as const, reason: 'Invalid role' }
      if (target.role === 'admin' && role !== 'admin') {
        const admins = this.members.filter((m) => m.role === 'admin')
        if (admins.length <= 1) return { ok: false as const, reason: 'Cannot demote the last admin' }
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
      const id = memberId.trim().slice(0, 128)
      if (!id) return { ok: false as const, reason: 'memberId required' }
      const idx = this.members.findIndex((m) => m.memberId === id)
      if (idx < 0) return { ok: false as const, reason: 'Member not found' }
      const target = this.members[idx]!
      if (target.role === 'admin') {
        const admins = this.members.filter((m) => m.role === 'admin')
        if (admins.length <= 1) {
          return { ok: false as const, reason: 'Cannot leave as the last admin - promote another Admin first' }
        }
      }
      const leftDeviceIds = Object.keys(target.sessions)
      this.members.splice(idx, 1)
      this.persistMembers()
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
    const id = memberId.trim().slice(0, 128)
    if (!id) return { ok: false, reason: 'memberId required' }
    const m = this.members.find((x) => x.memberId === id)
    if (!m) return { ok: false, reason: 'Member not found' }
    if (typeof patch.displayName === 'string') {
      const d = patch.displayName.replace(/\0/g, '').trim().slice(0, 200)
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
          m.avatarRef = patch.avatarRef.replace(/\0/g, '').trim().slice(0, 256)
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
          m.avatarRef = patch.avatarRef.replace(/\0/g, '').trim().slice(0, 256)
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

  /** List invites for admin (TS-SHR-002 / TS-SHR-019). Hashed disk tokens are not re-exported. */
  listInvites(): InviteRow[] {
    // TCC-R1133-TLS-002: opportunistic GC touchpoint - every admin open of
    // the invite panel also sweeps dead rows, on top of the create/cancel/
    // redeem touchpoints above.
    this.pruneExpiredAndUsedInvites()
    return this.invites
      .filter((i) => !i.usedAt && i.expiresAt >= Date.now())
      .slice(0, 200)
      .map((i) => {
        const plain = this.invitePlainByHash.get(i.token)
        return {
          ...i,
          id: inviteIdFromRow(i),
          // Prefer process-local plaintext (same process as create); else empty
          // so a stolen invites.json cannot mint joiners (TS-SCL-001).
          token: plain || (looksHashedToken(i.token) ? '' : i.token),
        }
      })
  }

  appendOp(op: ModulesSyncOp): void {
    const opId = typeof op.opId === 'string' ? op.opId.slice(0, 200) : ''
    // TCC-R1150-BRG-002: idempotent by opId within this process.
    if (opId && this.seenOpIds.has(opId)) return
    const plain = JSON.stringify(op)
    const line = `${this.atRest ? encryptOpsLine(this.atRest, plain) : plain}\n`
    // TS-SCL-001: buffer while prune rewrites so concurrent appends survive rename.
    if (this.opsPruning) {
      this.pendingOpAppends.push(line)
      if (this.pendingOpAppends.length > 50_000) {
        throw new Error('Op log busy - retry shortly')
      }
      if (opId) this.rememberOpId(opId)
      return
    }
    appendFileSync(this.opsPath, line, 'utf8')
    if (opId) this.rememberOpId(opId)
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

  markAcked(deviceId: string, opIds: string[]): void {
    const d = String(deviceId).slice(0, 128)
    if (!this.acks[d]) this.acks[d] = {}
    const now = Date.now()
    for (const id of opIds.slice(0, ACK_IDS_PER_CALL)) {
      if (typeof id === 'string' && id) this.acks[d][id.slice(0, 200)] = now
    }
    // TCC-R1148-BRG-002: debounce full-file acks.json rewrite under burst.
    this.acksDirty = true
    if (this.acksPersistTimer) return
    this.acksPersistTimer = setTimeout(() => {
      this.acksPersistTimer = null
      if (!this.acksDirty) return
      this.acksDirty = false
      this.persistAcks()
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
      this.acksDirty = false
      this.persistAcks()
    }
  }

  /** True when this device already stamped the op (catch-up skip). */
  hasAcked(deviceId: string, opId: string): boolean {
    const d = String(deviceId).slice(0, 128)
    const id = String(opId).slice(0, 200)
    if (!d || !id) return false
    const bag = this.acks[d]
    return !!(bag && typeof bag[id] === 'number')
  }

  /** How many op ids this device has acked (0 = never caught up / new device). */
  deviceAckCount(deviceId: string): number {
    const d = String(deviceId).slice(0, 128)
    if (!d) return 0
    const bag = this.acks[d]
    if (!bag || typeof bag !== 'object') return 0
    return Object.keys(bag).length
  }

  /**
   * BRG-059: stream the durable op log from the start (oldest first).
   * Catch-up for a zero-ack device must not use `readRecentOps` (tail only).
   */
  async *scanOpsFromStart(): AsyncGenerator<ModulesSyncOp> {
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
    if (!existsSync(this.opsPath)) return 0
    if (this.opsPruning) return 0
    this.opsPruning = true
    this.pendingOpAppends = []
    try {
      const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000
      const devices = new Set<string>()
      for (const m of this.members) {
        for (const d of Object.keys(m.sessions || {})) devices.add(d)
      }
      const kept: string[] = []
      let removed = 0
      const rl = createInterface({ input: createReadStream(this.opsPath, { encoding: 'utf8' }) })
      for await (const line of rl) {
        if (!line.trim()) continue
        let op: ModulesSyncOp
        try {
          const plain = decryptOpsLine(this.atRest, line)
          op = JSON.parse(plain) as ModulesSyncOp
        } catch {
          removed++
          continue
        }
        const opId = typeof op.opId === 'string' ? op.opId.slice(0, 200) : ''
        if (!opId) {
          removed++
          continue
        }
        const keepLine = this.atRest
          ? encryptOpsLine(this.atRest, JSON.stringify(op))
          : JSON.stringify(op)
        // Never drop while ANY registered device has not acked this op.
        if (devices.size === 0) {
          kept.push(keepLine)
          continue
        }
        let ackedByAll = true
        const ackTimes: number[] = []
        for (const d of devices) {
          const at = this.acks[d]?.[opId]
          if (typeof at !== 'number') {
            ackedByAll = false
            break
          }
          ackTimes.push(at)
        }
        if (!ackedByAll) {
          kept.push(keepLine)
          continue
        }
        // Fully acked: prune only after the oldest ack is past retention.
        if (Math.min(...ackTimes) >= cutoff) {
          kept.push(keepLine)
          continue
        }
        removed++
      }
      const tmp = `${this.opsPath}.rewrite`
      writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
      renameSync(tmp, this.opsPath)
      // Flush appends that arrived during the rewrite window.
      if (this.pendingOpAppends.length > 0) {
        appendFileSync(this.opsPath, this.pendingOpAppends.join(''), 'utf8')
        this.pendingOpAppends = []
      }
      // TCC-R1148-BRG-002: drop ack keys for opIds no longer in the log so
      // acks.json cannot grow without bound after prune removes lines.
      const keptIds = new Set<string>()
      for (const line of kept) {
        try {
          const plain = decryptOpsLine(this.atRest, line)
          const op = JSON.parse(plain) as ModulesSyncOp
          if (typeof op.opId === 'string' && op.opId) keptIds.add(op.opId.slice(0, 200))
        } catch { /* */ }
      }
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
        this.acksDirty = false
        this.persistAcks()
      }
      return removed
    } finally {
      this.opsPruning = false
      // Race: appends after rename but before finally cleared flag - flush leftovers.
      if (this.pendingOpAppends.length > 0) {
        try {
          appendFileSync(this.opsPath, this.pendingOpAppends.join(''), 'utf8')
        } catch { /* */ }
        this.pendingOpAppends = []
      }
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
   * TCC-R1154-BRG-002: sum on-disk CRM blob bytes (encrypted size when at-rest).
   */
  blobDiskBytes(): number {
    try {
      let total = 0
      for (const f of readdirSync(this.blobsDir)) {
        if (!/^[a-f0-9]{64}$/.test(f) && !f.endsWith('.part')) continue
        if (f.endsWith('.part')) continue
        try {
          total += statSync(join(this.blobsDir, f)).size
        } catch { /* */ }
      }
      return total
    } catch {
      return 0
    }
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
   * loading the full file into a single Buffer when possible. Still decrypts
   * via decryptBlobBody (may buffer) - callers MUST reserve download heap first.
   */
  verifyExistingBlobSha(sha256Expected: string):
    | { ok: true; bytes: number }
    | { ok: false; error: string } {
    const expected = sha256Expected.toLowerCase().replace(/[^a-f0-9]/g, '')
    if (expected.length !== 64) return { ok: false, error: 'Invalid sha256' }
    try {
      const dest = this.blobPath(expected)
      if (!existsSync(dest)) return { ok: false, error: 'Not found' }
      const onDisk = readFileSync(dest)
      const plain = decryptBlobBody(this.atRest, onDisk)
      const actual = createHash('sha256').update(plain).digest('hex')
      if (actual !== expected) return { ok: false, error: 'Blob checksum mismatch on server' }
      return { ok: true, bytes: plain.length }
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
      const verified = this.verifyExistingBlobSha(expected)
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
    const tmp = `${dest}.${process.pid}.part`
    const hash = createHash('sha256')
    const chunks: Buffer[] = []
    let bytes = 0
    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer | string) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          bytes += buf.length
          // TCC-R1152-BRG-004: never accept more bytes than declared Content-Length.
          if (bytes > contentLength || bytes > MAX_BLOB_BYTES) {
            reject(new Error(
              bytes > contentLength
                ? 'Body larger than Content-Length'
                : 'Blob too large',
            ))
            return
          }
          hash.update(buf)
          chunks.push(buf)
        })
        stream.on('end', () => resolve())
        stream.on('error', reject)
      })
      if (bytes !== contentLength) {
        return { ok: false, error: 'Body length does not match Content-Length' }
      }
      const actual = hash.digest('hex')
      if (actual !== expected) {
        return { ok: false, error: 'Checksum mismatch' }
      }
      const plain = Buffer.concat(chunks)
      const toWrite = this.atRest ? encryptBlobBody(this.atRest, plain) : plain
      writeFileSync(tmp, toWrite)
      renameSync(tmp, dest)
      return { ok: true, sha256: actual, bytes }
    } catch (err) {
      try { unlinkSync(tmp) } catch { /* */ }
      try { (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.() } catch { /* */ }
      return { ok: false, error: err instanceof Error ? err.message : 'Blob write failed' }
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

  blobCount(): number {
    try {
      return readdirSync(this.blobsDir).filter((f) => /^[a-f0-9]{64}$/.test(f)).length
    } catch {
      return 0
    }
  }
}

export const MAX_BLOB_BYTES_EXPORT = MAX_BLOB_BYTES
