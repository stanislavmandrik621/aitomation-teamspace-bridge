/**
 * Durable, compare-and-swap Team Space content safety lock.
 *
 * The file and its bounded audit trail are committed in one atomic rename.
 * Missing means the backwards-compatible unlocked revision 0 state. Existing
 * unreadable data fails closed and can only be repaired by the server operator.
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'
import { type BridgeRole, type TeamContentLockSnapshot } from './index.js'
import { capStr, capTrim } from './text-cap.js'

const SCHEMA_VERSION = 1
const FILE_NAME = 'team-content-lock.json'
const INITIALIZED_FILE_NAME = 'team-content-lock.initialized'
const RESTORE_LEASE_FILE_NAME = 'team-content-restore-lease.json'
const RESTORE_LEASE_MS = 10 * 60 * 1000
const MEMBER_ID_MAX = 128
const NAME_MAX = 200
const TEAM_ID_MAX = 128
const REASON_MAX = 500
const MUTATION_ID_MAX = 128
const AUDIT_MAX = 500
const MUTATIONS_MAX = 256

export type TeamContentLockAuditEntry = {
  id: string
  action: 'lock' | 'unlock'
  actorMemberId: string
  actorName: string
  at: number
  fromRevision: number
  toRevision: number
  reason?: string
}

type MutationReceipt = {
  mutationId: string
  actorMemberId: string
  locked: boolean
  snapshot: TeamContentLockSnapshot
}

type LockDocument = {
  schemaVersion: 1
  state: TeamContentLockSnapshot
  audit: TeamContentLockAuditEntry[]
  mutations: MutationReceipt[]
}

export type TeamContentLockSetResult =
  | { ok: true; state: TeamContentLockSnapshot; changed: boolean; idempotent: boolean }
  | { ok: false; reason: string; state: TeamContentLockSnapshot; conflict?: boolean }

export type TeamContentRestorePermit = {
  token: string
  teamId: string
  lockRevision: number
  expiresAt: number
}

type StoredRestoreLease = {
  schemaVersion: 1
  teamId: string
  tokenHash: string
  memberId: string
  deviceId: string
  lockRevision: number
  createdAt: number
  expiresAt: number
}

export type TeamContentLockScope =
  | 'modules_ops'
  | 'module_yjs'
  | 'public_intake'
  | 'portal_intake'
  | 'backup_restore'
  | 'catchup'
  | 'backup_upload'
  | 'chat'
  | 'roster'
  | 'governance'

const LOCKED_WRITE_SCOPES = new Set<TeamContentLockScope>([
  'modules_ops',
  'module_yjs',
  'public_intake',
  'portal_intake',
  'backup_restore',
])

/** Read/recovery/governance and unrelated Team Space domains remain usable. */
export function teamContentLockBlocks(
  state: TeamContentLockSnapshot,
  scope: TeamContentLockScope,
): boolean {
  return Boolean(state.locked || state.unavailable) && LOCKED_WRITE_SCOPES.has(scope)
}

/** Permanent author-epoch check shared by ops and Module Yjs ingress. */
export function teamContentLockRevisionRefusal(
  state: TeamContentLockSnapshot,
  rawRevision: unknown,
): 'missing' | 'stale' | null {
  if (state.revision === 0) return null
  if (typeof rawRevision !== 'number' || !Number.isSafeInteger(rawRevision) || rawRevision < 0) return 'missing'
  return rawRevision === state.revision ? null : 'stale'
}

function unavailableState(teamId: string): TeamContentLockSnapshot {
  return {
    teamId,
    locked: true,
    revision: 0,
    changedAt: 0,
    changedByMemberId: '',
    reason: 'The server could not verify the durable team content lock.',
    unavailable: true,
  }
}

function unlockedState(teamId: string): TeamContentLockSnapshot {
  return {
    teamId,
    locked: false,
    revision: 0,
    changedAt: 0,
    changedByMemberId: '',
  }
}

function safeInt(raw: unknown): number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : -1
}

function parseSnapshot(raw: unknown, teamId: string): TeamContentLockSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  const storedTeamId = capTrim(row.teamId, TEAM_ID_MAX)
  const revision = safeInt(row.revision)
  const changedAt = safeInt(row.changedAt)
  const changedByMemberId = capTrim(row.changedByMemberId, MEMBER_ID_MAX)
  if (storedTeamId !== teamId || typeof row.locked !== 'boolean' || revision < 0 || changedAt < 0) return null
  const reason = capTrim(row.reason, REASON_MAX)
  const changedByName = capTrim(row.changedByName, NAME_MAX)
  return {
    teamId,
    locked: row.locked,
    revision,
    changedAt,
    changedByMemberId,
    ...(changedByName ? { changedByName } : {}),
    ...(reason ? { reason } : {}),
  }
}

function parseDocument(raw: unknown, teamId: string): LockDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  if (doc.schemaVersion !== SCHEMA_VERSION) return null
  const state = parseSnapshot(doc.state, teamId)
  if (!state || !Array.isArray(doc.audit) || !Array.isArray(doc.mutations)) return null
  const audit: TeamContentLockAuditEntry[] = []
  for (const rawEntry of doc.audit.slice(-AUDIT_MAX)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return null
    const entry = rawEntry as Record<string, unknown>
    const action = entry.action === 'lock' || entry.action === 'unlock' ? entry.action : null
    const id = capTrim(entry.id, MUTATION_ID_MAX)
    const actorMemberId = capTrim(entry.actorMemberId, MEMBER_ID_MAX)
    const actorName = capTrim(entry.actorName, NAME_MAX)
    const at = safeInt(entry.at)
    const fromRevision = safeInt(entry.fromRevision)
    const toRevision = safeInt(entry.toRevision)
    if (!action || !id || !actorMemberId || at < 0 || fromRevision < 0 || toRevision < 0) return null
    const reason = capTrim(entry.reason, REASON_MAX)
    audit.push({ id, action, actorMemberId, actorName, at, fromRevision, toRevision, ...(reason ? { reason } : {}) })
  }
  const mutations: MutationReceipt[] = []
  for (const rawReceipt of doc.mutations.slice(-MUTATIONS_MAX)) {
    if (!rawReceipt || typeof rawReceipt !== 'object' || Array.isArray(rawReceipt)) return null
    const receipt = rawReceipt as Record<string, unknown>
    const mutationId = capTrim(receipt.mutationId, MUTATION_ID_MAX)
    const actorMemberId = capTrim(receipt.actorMemberId, MEMBER_ID_MAX)
    const snapshot = parseSnapshot(receipt.snapshot, teamId)
    if (!mutationId || !actorMemberId || typeof receipt.locked !== 'boolean' || !snapshot) return null
    mutations.push({ mutationId, actorMemberId, locked: receipt.locked, snapshot })
  }
  return { schemaVersion: SCHEMA_VERSION, state, audit, mutations }
}

function cloneState(state: TeamContentLockSnapshot): TeamContentLockSnapshot {
  return { ...state }
}

export class TeamContentLockStore {
  private readonly path: string
  private readonly initializedPath: string
  private readonly restoreLeasePath: string
  private doc: LockDocument | null = null
  private unusable = false

  constructor(
    private readonly dataDir: string,
    private readonly atRest: AtRestKey | null = null,
    /** Deterministic fault injection used by the power-cut regression test. */
    private readonly testHooks?: { afterRename?: () => void },
  ) {
    mkdirSync(dataDir, { recursive: true })
    this.path = join(dataDir, FILE_NAME)
    this.initializedPath = join(dataDir, INITIALIZED_FILE_NAME)
    this.restoreLeasePath = join(dataDir, RESTORE_LEASE_FILE_NAME)
  }

  private fileState(path: string): 'present' | 'missing' | 'unreadable' {
    try {
      return statSync(path).isFile() ? 'present' : 'unreadable'
    } catch (err) {
      return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'
    }
  }

  /** Atomic file + parent-directory durability, shared by bootstrap metadata. */
  private atomicWrite(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let fd = -1
    let dirFd = -1
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeSync(fd, text, undefined, 'utf8')
      fsyncSync(fd)
      closeSync(fd)
      fd = -1
      renameSync(tmp, path)
      dirFd = openSync(this.dataDir, 'r')
      fsyncSync(dirFd)
      closeSync(dirFd)
      dirFd = -1
    } finally {
      if (fd >= 0) try { closeSync(fd) } catch { /* */ }
      if (dirFd >= 0) try { closeSync(dirFd) } catch { /* */ }
      try { unlinkSync(tmp) } catch { /* */ }
    }
  }

  private ensureInitializedMarker(): boolean {
    const state = this.fileState(this.initializedPath)
    if (state === 'present') return true
    if (state === 'unreadable') return false
    try {
      this.atomicWrite(this.initializedPath, `${SCHEMA_VERSION}\n`)
      return true
    } catch {
      return false
    }
  }

  private tokenHash(token: string): string {
    return createHash('sha256').update(token).digest('hex')
  }

  private readRestoreLease(now = Date.now()): StoredRestoreLease | null | 'unavailable' {
    const file = this.fileState(this.restoreLeasePath)
    if (file === 'missing') return null
    if (file !== 'present') return 'unavailable'
    try {
      const raw = JSON.parse(readFileSync(this.restoreLeasePath, 'utf8')) as Record<string, unknown>
      const lease: StoredRestoreLease = {
        schemaVersion: 1,
        teamId: capTrim(raw.teamId, TEAM_ID_MAX),
        tokenHash: capTrim(raw.tokenHash, 64),
        memberId: capTrim(raw.memberId, MEMBER_ID_MAX),
        deviceId: capTrim(raw.deviceId, MEMBER_ID_MAX),
        lockRevision: safeInt(raw.lockRevision),
        createdAt: safeInt(raw.createdAt),
        expiresAt: safeInt(raw.expiresAt),
      }
      if (
        raw.schemaVersion !== 1 || !lease.teamId || !/^[a-f0-9]{64}$/.test(lease.tokenHash)
        || !lease.memberId || !lease.deviceId || lease.lockRevision < 0
        || lease.createdAt <= 0 || lease.expiresAt <= lease.createdAt
      ) return 'unavailable'
      if (lease.expiresAt <= now) {
        try {
          unlinkSync(this.restoreLeasePath)
          const dirFd = openSync(this.dataDir, 'r')
          try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
          return null
        } catch {
          return 'unavailable'
        }
      }
      return lease
    } catch {
      return 'unavailable'
    }
  }

  beginRestorePermit(args: {
    teamId: string
    actorMemberId: string
    actorDeviceId: string
    actorRole: BridgeRole
    expectedRevision: number
    now?: number
  }): { ok: true; permit: TeamContentRestorePermit } | { ok: false; reason: string; state: TeamContentLockSnapshot } {
    const teamId = capTrim(args.teamId, TEAM_ID_MAX)
    const memberId = capTrim(args.actorMemberId, MEMBER_ID_MAX)
    const deviceId = capTrim(args.actorDeviceId, MEMBER_ID_MAX)
    const now = typeof args.now === 'number' && Number.isSafeInteger(args.now) && args.now > 0 ? args.now : Date.now()
    const state = this.get(teamId)
    if (args.actorRole !== 'admin') return { ok: false, reason: 'Admin only', state }
    if (!teamId || !memberId || !deviceId || !Number.isSafeInteger(args.expectedRevision) || args.expectedRevision < 0) {
      return { ok: false, reason: 'Invalid restore permit request', state }
    }
    if (state.unavailable || state.locked) return { ok: false, reason: 'Team content is locked or unavailable', state }
    if (state.revision !== args.expectedRevision) return { ok: false, reason: 'Team content lock changed', state }
    const active = this.readRestoreLease(now)
    if (active === 'unavailable') return { ok: false, reason: 'Restore authority is unavailable', state }
    if (active) return { ok: false, reason: 'Another shared-content restore is already in progress', state }
    const token = randomBytes(32).toString('base64url')
    const lease: StoredRestoreLease = {
      schemaVersion: 1,
      teamId,
      tokenHash: this.tokenHash(token),
      memberId,
      deviceId,
      lockRevision: state.revision,
      createdAt: now,
      expiresAt: now + RESTORE_LEASE_MS,
    }
    try {
      this.atomicWrite(this.restoreLeasePath, JSON.stringify(lease))
      return { ok: true, permit: { token, teamId, lockRevision: state.revision, expiresAt: lease.expiresAt } }
    } catch {
      return { ok: false, reason: 'Could not persist restore authority', state }
    }
  }

  validateRestorePermit(args: {
    teamId: string
    actorMemberId: string
    actorDeviceId: string
    token: string
    now?: number
  }): { ok: true; lockRevision: number; expiresAt: number } | { ok: false; reason: string; state: TeamContentLockSnapshot } {
    const teamId = capTrim(args.teamId, TEAM_ID_MAX)
    const memberId = capTrim(args.actorMemberId, MEMBER_ID_MAX)
    const deviceId = capTrim(args.actorDeviceId, MEMBER_ID_MAX)
    const token = capTrim(args.token, 128)
    const now = typeof args.now === 'number' && Number.isSafeInteger(args.now) && args.now > 0 ? args.now : Date.now()
    const state = this.get(teamId)
    const lease = this.readRestoreLease(now)
    if (!teamId || !memberId || !deviceId || !token || lease === 'unavailable') {
      return { ok: false, reason: 'Restore authority is unavailable', state }
    }
    if (
      !lease || lease.teamId !== teamId || lease.memberId !== memberId || lease.deviceId !== deviceId
      || lease.tokenHash !== this.tokenHash(token) || state.unavailable || state.locked
      || state.revision !== lease.lockRevision
    ) return { ok: false, reason: 'Restore authority is no longer valid', state }
    // Renew at the final pre-commit proof. The caller performs a synchronous
    // local merge immediately afterward; this keeps Admin lock acquisition
    // excluded for the full commit window even if the download used most of
    // the original lease.
    const renewed: StoredRestoreLease = { ...lease, expiresAt: now + RESTORE_LEASE_MS }
    try {
      this.atomicWrite(this.restoreLeasePath, JSON.stringify(renewed))
    } catch {
      return { ok: false, reason: 'Could not renew restore authority', state }
    }
    return { ok: true, lockRevision: renewed.lockRevision, expiresAt: renewed.expiresAt }
  }

  finishRestorePermit(args: {
    teamId: string
    actorMemberId: string
    actorDeviceId: string
    token: string
  }): { ok: true } | { ok: false; reason: string } {
    const teamId = capTrim(args.teamId, TEAM_ID_MAX)
    const memberId = capTrim(args.actorMemberId, MEMBER_ID_MAX)
    const deviceId = capTrim(args.actorDeviceId, MEMBER_ID_MAX)
    const token = capTrim(args.token, 128)
    const lease = this.readRestoreLease()
    if (
      !teamId || !memberId || !deviceId || !token || lease === 'unavailable' || !lease
      || lease.teamId !== teamId || lease.memberId !== memberId || lease.deviceId !== deviceId
      || lease.tokenHash !== this.tokenHash(token)
    ) return { ok: false, reason: 'Restore authority is no longer valid' }
    try {
      unlinkSync(this.restoreLeasePath)
      const dirFd = openSync(this.dataDir, 'r')
      try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
      return { ok: true }
    } catch {
      return { ok: false, reason: 'Could not release restore authority' }
    }
  }

  private load(teamId: string): LockDocument | null {
    if (this.unusable) return null
    if (this.doc) return this.doc.state.teamId === teamId ? this.doc : null
    const authorityFile = this.fileState(this.path)
    if (authorityFile === 'missing') {
      // One safe bootstrap is allowed only before the durable initialized
      // marker exists. Once initialized, disappearance of the authority file
      // is corruption/deletion and must lock every retained write path.
      if (this.fileState(this.initializedPath) !== 'missing') {
        this.unusable = true
        return null
      }
      const initial: LockDocument = {
        schemaVersion: SCHEMA_VERSION,
        state: unlockedState(teamId),
        audit: [],
        mutations: [],
      }
      try {
        const encoded = this.atRest ? encryptJsonFile(this.atRest, initial) : JSON.stringify(initial, null, 2)
        this.atomicWrite(this.path, encoded)
        if (!this.ensureInitializedMarker()) throw new Error('failed to initialize lock marker')
        this.doc = initial
        return initial
      } catch {
        this.unusable = true
        this.doc = null
        return null
      }
    }
    if (authorityFile === 'unreadable') {
      this.unusable = true
      return null
    }
    try {
      const raw = decryptJsonFile<unknown>(this.atRest, readFileSync(this.path, 'utf8'), null)
      const parsed = parseDocument(raw, teamId)
      if (!parsed) throw new Error('invalid team content lock document')
      // Existing installations safely migrate once by adding the marker only
      // after a valid authority document has been proven.
      if (!this.ensureInitializedMarker()) throw new Error('could not persist lock initialization marker')
      this.doc = parsed
      return parsed
    } catch {
      this.unusable = true
      this.doc = null
      return null
    }
  }

  get(teamIdRaw: string): TeamContentLockSnapshot {
    const teamId = capTrim(teamIdRaw, TEAM_ID_MAX)
    if (!teamId) return unavailableState('')
    const doc = this.load(teamId)
    return doc ? cloneState(doc.state) : unavailableState(teamId)
  }

  listAudit(teamIdRaw: string): TeamContentLockAuditEntry[] {
    const teamId = capTrim(teamIdRaw, TEAM_ID_MAX)
    const doc = teamId ? this.load(teamId) : null
    return doc ? doc.audit.map((entry) => ({ ...entry })) : []
  }

  set(args: {
    teamId: string
    actorMemberId: string
    actorName?: string
    actorRole: BridgeRole
    locked: boolean
    expectedRevision: number
    mutationId: string
    reason?: string
    now?: number
  }): TeamContentLockSetResult {
    const teamId = capTrim(args.teamId, TEAM_ID_MAX)
    const actorMemberId = capTrim(args.actorMemberId, MEMBER_ID_MAX)
    const actorName = capTrim(args.actorName, NAME_MAX)
    const mutationId = capTrim(args.mutationId, MUTATION_ID_MAX)
    const reason = capTrim(args.reason, REASON_MAX)
    const expectedRevision = safeInt(args.expectedRevision)
    const current = this.get(teamId)
    if (args.actorRole !== 'admin') return { ok: false, reason: 'Admin only', state: current }
    if (!teamId || !actorMemberId || !mutationId || typeof args.locked !== 'boolean' || expectedRevision < 0) {
      return { ok: false, reason: 'Invalid team content lock request', state: current }
    }
    if (current.unavailable) return { ok: false, reason: 'Team content lock storage is unavailable', state: current }
    if (args.locked) {
      const activeRestore = this.readRestoreLease()
      if (activeRestore === 'unavailable') {
        return { ok: false, reason: 'Restore authority is unavailable', state: current }
      }
      if (activeRestore) {
        return { ok: false, reason: 'A shared-content restore is in progress', state: current }
      }
    }
    const doc = this.load(teamId)
    if (!doc) return { ok: false, reason: 'Team content lock storage is unavailable', state: current }
    const prior = doc.mutations.find((entry) => entry.mutationId === mutationId)
    if (prior) {
      if (prior.actorMemberId !== actorMemberId || prior.locked !== args.locked) {
        return { ok: false, reason: 'Mutation id was already used for another request', state: cloneState(doc.state) }
      }
      // A delayed retry may arrive after another successful transition. Echo
      // the current authority so a requester can never regress its revision.
      return { ok: true, state: cloneState(doc.state), changed: false, idempotent: true }
    }
    if (expectedRevision !== doc.state.revision) {
      return { ok: false, reason: 'Team content lock changed on another device', state: cloneState(doc.state), conflict: true }
    }
    const changed = doc.state.locked !== args.locked
    const now = typeof args.now === 'number' && Number.isSafeInteger(args.now) && args.now > 0 ? args.now : Date.now()
    const nextState: TeamContentLockSnapshot = changed
      ? {
          teamId,
          locked: args.locked,
          revision: doc.state.revision + 1,
          changedAt: now,
          changedByMemberId: actorMemberId,
          ...(actorName ? { changedByName: actorName } : {}),
          ...(reason ? { reason } : {}),
        }
      : cloneState(doc.state)
    const next: LockDocument = {
      schemaVersion: SCHEMA_VERSION,
      state: nextState,
      audit: changed
        ? [...doc.audit, {
            id: mutationId,
            action: (args.locked ? 'lock' : 'unlock') as 'lock' | 'unlock',
            actorMemberId,
            actorName,
            at: now,
            fromRevision: doc.state.revision,
            toRevision: nextState.revision,
            ...(reason ? { reason } : {}),
          }].slice(-AUDIT_MAX)
        : doc.audit,
      mutations: [...doc.mutations, { mutationId, actorMemberId, locked: args.locked, snapshot: nextState }].slice(-MUTATIONS_MAX),
    }
    const tmp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let tmpFd = -1
    let dirFd = -1
    let renamed = false
    try {
      const encoded = this.atRest ? encryptJsonFile(this.atRest, next) : JSON.stringify(next, null, 2)
      tmpFd = openSync(tmp, 'wx', 0o600)
      writeSync(tmpFd, encoded, undefined, 'utf8')
      fsyncSync(tmpFd)
      closeSync(tmpFd)
      tmpFd = -1
      renameSync(tmp, this.path)
      renamed = true
      this.testHooks?.afterRename?.()
      // Persist the directory entry too. Without this, the rename can vanish
      // after a power loss even though the temporary file itself was synced.
      dirFd = openSync(this.dataDir, 'r')
      fsyncSync(dirFd)
      closeSync(dirFd)
      dirFd = -1
      this.doc = next
      return { ok: true, state: cloneState(nextState), changed, idempotent: false }
    } catch {
      if (tmpFd >= 0) try { closeSync(tmpFd) } catch { /* */ }
      if (dirFd >= 0) try { closeSync(dirFd) } catch { /* */ }
      try { unlinkSync(tmp) } catch { /* */ }
      if (renamed) {
        // rename() is the commit point. A following directory-open/fsync
        // error must never leave the old revision cached or invite a retry
        // against stale authority. Re-read the committed file; if even that
        // cannot be proved, make this process fail closed until restart.
        this.doc = null
        this.unusable = false
        const reloaded = this.load(teamId)
        if (reloaded && reloaded.state.revision >= nextState.revision) {
          return {
            ok: true,
            state: cloneState(reloaded.state),
            changed,
            idempotent: false,
          }
        }
        this.doc = null
        this.unusable = true
        return {
          ok: false,
          reason: 'The committed team content lock could not be verified',
          state: unavailableState(teamId),
        }
      }
      return { ok: false, reason: 'Failed to persist the team content lock', state: cloneState(doc.state) }
    }
  }
}

export const TEAM_CONTENT_LOCK_REASON_MAX = REASON_MAX
