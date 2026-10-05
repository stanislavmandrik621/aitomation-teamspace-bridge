/**
 * P6 - Team server per-member backups (dedicated tree, not CRM blobs/).
 * Layout under TEAMSPACE_DATA_DIR/backups/
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  createReadStream,
  createWriteStream,
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform, type Readable } from 'node:stream'
import {
  enumerateChatBackupFiles,
  listChatBackupZipEntries,
  CHAT_BACKUP_TOP_LEVEL,
  CHAT_BACKUP_MAX_FILES,
  chatBackupRoot,
} from './chat-backup-paths.js'
import { MAX_BACKUP_ZIP_AIMOVES, MAX_BACKUP_ZIP_AIMOVES_HARD_CAP } from './backup-zip.js'
import { capStr } from './text-cap.js'

export {
  enumerateChatBackupFiles,
  listChatBackupZipEntries,
  CHAT_BACKUP_TOP_LEVEL,
  CHAT_BACKUP_MAX_FILES,
  chatBackupRoot,
}

export const TEAMSPACE_BACKUP_EXT = 'aimove'
/** Soft ceiling for one snapshot (matches desktop device-import total). */
export const MAX_BACKUP_BYTES = 8 * 1024 * 1024 * 1024
export const DEFAULT_BACKUP_KEEP_PER_MEMBER = 10
export const DEFAULT_BACKUP_MAX_BYTES_PER_MEMBER = 50 * 1024 * 1024 * 1024
export const DEFAULT_BACKUP_MIN_INTERVAL_MS = 60 * 60 * 1000

export type TeamBackupMeta = {
  schemaVersion: number
  maxKeepPerMember: number
  maxBytesPerMember: number
  maxBytesTeam: number
  minIntervalMs: number
  allowMemberDownloadOthers: boolean
  /**
   * TCC-R1133-SET-005: admin-raisable cap on sealed member .aimove files in
   * one `GET /v1/backups/export.zip?mode=ids` request. Previously a bare
   * module constant (`MAX_BACKUP_ZIP_AIMOVES = 40`) with no way for an admin
   * to raise it for a large team - now persisted team-wide meta, clamped to
   * `MAX_BACKUP_ZIP_AIMOVES_HARD_CAP` regardless of what is requested.
   */
  maxZipAimoves: number
}

export type TeamBackupOwnerMeta = {
  memberId?: string
  memberEmail?: string
  displayName?: string
  teamId?: string
  teamName?: string
  deviceId?: string
  deviceName?: string
  appVersion?: string
  platform?: string
}

export type TeamBackupSnapshotRow = {
  id: string
  createdAt: number
  bytes: number
  sha256: string
  label: string
  includesBrowserSessions: boolean
  memberId: string
  owner?: TeamBackupOwnerMeta
}

const BACKUP_LABEL_MAX = 120
const BACKUP_META_FIELD_MAX = 200
const BACKUP_META_HEADER_MAX = 2048
const BACKUP_META_KEYS: (keyof TeamBackupOwnerMeta)[] = [
  'memberId', 'memberEmail', 'displayName', 'teamId', 'teamName',
  'deviceId', 'deviceName', 'appVersion', 'platform',
]

/** User-typed snapshot label: strip NUL, trim, then surrogate-safe cap. */
function capBackupLabel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return capStr(raw.replace(/\0/g, '').trim(), BACKUP_LABEL_MAX)
}

/** FS/error text: same 200-unit ceiling as owner-meta, never a raw slice (TS-CHAT-034). */
function capBackupError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback
  return capStr(err.message, BACKUP_META_FIELD_MAX) || fallback
}

export function parseBackupOwnerFields(raw: unknown): TeamBackupOwnerMeta | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const o = raw as Record<string, unknown>
  const out: TeamBackupOwnerMeta = {}
  for (const k of BACKUP_META_KEYS) {
    const v = o[k]
    if (typeof v !== 'string') continue
    const cleaned = capStr(v.replace(/[\u0000-\u001f\u007f]/g, '').trim(), BACKUP_META_FIELD_MAX)
    if (cleaned) out[k] = cleaned
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** Decode `x-backup-meta` (base64url JSON). Closed keys, 200/field, 2048 header. */
export function parseBackupMetaHeader(raw: unknown): TeamBackupOwnerMeta | undefined {
  const s = typeof raw === 'string' ? raw : Array.isArray(raw) && typeof raw[0] === 'string' ? raw[0] : ''
  if (!s || s.length > BACKUP_META_HEADER_MAX) return undefined
  try {
    const json = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as unknown
    return parseBackupOwnerFields(json)
  } catch {
    return undefined
  }
}

const META_DEFAULTS: TeamBackupMeta = {
  schemaVersion: 1,
  maxKeepPerMember: DEFAULT_BACKUP_KEEP_PER_MEMBER,
  maxBytesPerMember: DEFAULT_BACKUP_MAX_BYTES_PER_MEMBER,
  maxBytesTeam: 0, // 0 = uncapped team total (per-member still applies)
  minIntervalMs: DEFAULT_BACKUP_MIN_INTERVAL_MS,
  allowMemberDownloadOthers: false,
  maxZipAimoves: MAX_BACKUP_ZIP_AIMOVES,
}

/**
 * Single path segment under backups/members/. The charset allows `.`, so
 * `.` and `..` (and Windows trailing-dot collapse to those) must be refused
 * or Admin wipe / put writes the backups/ or members/ root and mixes every
 * member's snapshots.
 */
export function isSafeBackupMemberId(raw: string): boolean {
  if (typeof raw !== 'string') return false
  if (!/^(?:[a-zA-Z0-9._-]{1,128}|device:[a-zA-Z0-9._-]{1,121})$/.test(raw)) return false
  if (raw === '.' || raw === '..') return false
  // Windows strips trailing dots at the syscall; leftover must not be empty / . / ..
  if (/\.$/.test(raw)) return false
  return true
}

/** Keep existing folders stable; encode legacy device: identities for Windows. */
function backupMemberFolder(memberId: string): string { return encodeURIComponent(memberId) }
function backupMemberFromFolder(name: string): string | null {
  try {
    const id = decodeURIComponent(name)
    return isSafeBackupMemberId(id) && backupMemberFolder(id) === name ? id : null
  } catch { return null }
}

export function isSafeBackupSnapshotId(raw: string): boolean {
  if (typeof raw !== 'string') return false
  if (!/^[a-zA-Z0-9._-]{8,128}$/.test(raw)) return false
  if (raw === '.' || raw === '..') return false
  if (/\.$/.test(raw)) return false
  return true
}

/**
 * Team-quota mutex key. NUL is outside isSafeBackupMemberId, so a member
 * folder named `__team_quota__` cannot nest-lock and deadlock put.
 */
const TEAM_QUOTA_LOCK_KEY = '\0team_quota'

/** Member folder must be a child of members/, never members/ itself or its parent. */
function isStrictlyInsideMembersRoot(membersRoot: string, memberDir: string): boolean {
  const root = resolve(membersRoot)
  const target = resolve(memberDir)
  if (target === root) return false
  const prefix = root.endsWith(sep) ? root : root + sep
  if (process.platform === 'win32') {
    return target.toLowerCase().startsWith(prefix.toLowerCase())
  }
  return target.startsWith(prefix)
}

function mintSnapshotId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `snap_${stamp}_${randomBytes(4).toString('hex')}`
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd: number | undefined
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeFileSync(fd, JSON.stringify(data, null, 2), 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
    // Persist the renamed metadata link as well as its contents. An upload is
    // not acknowledged while its index still exists only in the OS page cache.
    syncBackupDirectory(dirname(path))
  } finally {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tmp) } catch { /* committed rename or failed create */ }
  }
}

function syncBackupDirectory(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY)
    fsyncSync(fd)
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    if (!lstatSync(path).isFile()) throw new Error('Not a regular metadata file')
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as T
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid metadata')
    return parsed
  } catch {
    throw new Error('Backup metadata is unreadable; repair it before changing backups')
  }
}

export class TeamBackupStore {
  /** TEAMSPACE_DATA_DIR (parent of backups/ and chat/). */
  readonly dataDir: string
  /** backups/ under dataDir. */
  readonly root: string
  private metaPath: string
  private membersRoot: string
  private uploadLocks = new Map<string, Promise<unknown>>()
  private pendingLocks = 0
  /**
   * TCC-R1133-BKP-002: `maxBytesTeam` in-flight reservations. Per-member
   * uploads each hold only their OWN `withMemberLock(memberId, ...)`, so
   * two different members uploading at once never contend on the same key
   * and can both pass the `teamBytes() + len > maxBytesTeam` check against
   * a stale pre-upload total before either has written a byte - jointly
   * overshooting the team ceiling. Keyed by a per-attempt reservation id
   * (not memberId) so concurrent uploads from the SAME member also each
   * get their own slot; summed with the on-disk total for every check.
   * The mutex key is TEAM_QUOTA_LOCK_KEY (NUL prefix), never a charset-legal
   * member folder name, so it cannot deadlock a member's own upload lock.
   */
  private teamQuotaReserved = new Map<string, number>()
  /**
   * TS-P6-021: absolute `.part` paths an in-flight `putSnapshotFromStream`
   * is still streaming into (or about to `renameSync` into place).
   *
   * `cleanupPartials()` runs OUTSIDE `withMemberLock` (it sweeps every
   * member folder) and has no age gate, and TCC-R1144-BKP-007 promoted it
   * from a boot-only crash sweep to a 60-minute maintenance tick - while a
   * single upload is allowed to run for a full 60 minutes
   * (`TEAMSPACE_BACKUP_HTTP_TIMEOUT_MS`) for up to `MAX_BACKUP_BYTES`. A
   * multi-GB upload that straddles one tick therefore had its own live
   * `.part` unlinked mid-`pipeline()`: on POSIX the write stream keeps the
   * unlinked inode so the transfer "succeeds", and the upload then dies at
   * `renameSync` with ENOENT after moving gigabytes. Registered here from
   * before the pipeline starts until the outcome is known, so the sweep can
   * skip exactly the bytes that are still owned by a live request.
   */
  private liveParts = new Set<string>()

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.dataDir = realpathSync(dataDir)
    this.root = join(this.dataDir, 'backups')
    this.metaPath = join(this.root, '_meta.json')
    this.membersRoot = join(this.root, 'members')
    this.assertSafePath(this.membersRoot)
    mkdirSync(this.membersRoot, { recursive: true })
    this.ensureMeta()
    syncBackupDirectory(this.membersRoot)
    syncBackupDirectory(this.root)
    syncBackupDirectory(this.dataDir)
  }

  private assertSafePath(path: string): void {
    const relative = path.slice(this.dataDir.length + 1)
    let current = this.dataDir
    for (const segment of relative.split(sep)) {
      current = join(current, segment)
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Backup paths must not contain symbolic links')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') break
        throw err
      }
    }
  }

  private ensureMeta(): TeamBackupMeta {
    this.assertSafePath(this.metaPath)
    const cur = readJson<Partial<TeamBackupMeta>>(this.metaPath, {})
    const next: TeamBackupMeta = {
      schemaVersion: 1,
      maxKeepPerMember:
        typeof cur.maxKeepPerMember === 'number' && Number.isFinite(cur.maxKeepPerMember) && cur.maxKeepPerMember > 0
          ? Math.min(100, Math.floor(cur.maxKeepPerMember))
          : META_DEFAULTS.maxKeepPerMember,
      maxBytesPerMember:
        typeof cur.maxBytesPerMember === 'number' && Number.isFinite(cur.maxBytesPerMember) && cur.maxBytesPerMember > 0
          ? Math.floor(cur.maxBytesPerMember)
          : META_DEFAULTS.maxBytesPerMember,
      maxBytesTeam:
        typeof cur.maxBytesTeam === 'number' && Number.isFinite(cur.maxBytesTeam) && cur.maxBytesTeam >= 0
          ? Math.floor(cur.maxBytesTeam)
          : META_DEFAULTS.maxBytesTeam,
      minIntervalMs:
        typeof cur.minIntervalMs === 'number' && Number.isFinite(cur.minIntervalMs) && cur.minIntervalMs >= 0
          ? Math.floor(cur.minIntervalMs)
          : META_DEFAULTS.minIntervalMs,
      allowMemberDownloadOthers: cur.allowMemberDownloadOthers === true,
      maxZipAimoves:
        typeof cur.maxZipAimoves === 'number' && Number.isFinite(cur.maxZipAimoves) && cur.maxZipAimoves > 0
          ? Math.min(MAX_BACKUP_ZIP_AIMOVES_HARD_CAP, Math.floor(cur.maxZipAimoves))
          : META_DEFAULTS.maxZipAimoves,
    }
    if (!existsSync(this.metaPath)) atomicWriteJson(this.metaPath, next)
    return next
  }

  getMeta(): TeamBackupMeta {
    return this.ensureMeta()
  }

  setMeta(patch: Partial<TeamBackupMeta>): TeamBackupMeta {
    const cur = this.getMeta()
    const next: TeamBackupMeta = {
      ...cur,
      ...(typeof patch.maxKeepPerMember === 'number' && Number.isFinite(patch.maxKeepPerMember) && patch.maxKeepPerMember > 0
        ? { maxKeepPerMember: Math.min(100, Math.floor(patch.maxKeepPerMember)) }
        : {}),
      ...(typeof patch.maxBytesPerMember === 'number' && Number.isFinite(patch.maxBytesPerMember) && patch.maxBytesPerMember > 0
        ? { maxBytesPerMember: Math.floor(patch.maxBytesPerMember) }
        : {}),
      ...(typeof patch.maxBytesTeam === 'number' && Number.isFinite(patch.maxBytesTeam) && patch.maxBytesTeam >= 0
        ? { maxBytesTeam: Math.floor(patch.maxBytesTeam) }
        : {}),
      ...(typeof patch.minIntervalMs === 'number' && Number.isFinite(patch.minIntervalMs) && patch.minIntervalMs >= 0
        ? { minIntervalMs: Math.floor(patch.minIntervalMs) }
        : {}),
      ...(patch.allowMemberDownloadOthers === true || patch.allowMemberDownloadOthers === false
        ? { allowMemberDownloadOthers: patch.allowMemberDownloadOthers }
        : {}),
      ...(typeof patch.maxZipAimoves === 'number' && Number.isFinite(patch.maxZipAimoves) && patch.maxZipAimoves > 0
        ? { maxZipAimoves: Math.min(MAX_BACKUP_ZIP_AIMOVES_HARD_CAP, Math.floor(patch.maxZipAimoves)) }
        : {}),
    }
    atomicWriteJson(this.metaPath, next)
    return next
  }

  private memberDir(memberId: string): string {
    if (!isSafeBackupMemberId(memberId)) throw new Error('Invalid member id')
    const dir = join(this.membersRoot, backupMemberFolder(memberId))
    if (!isStrictlyInsideMembersRoot(this.membersRoot, dir)) throw new Error('Invalid member id')
    this.assertSafePath(dir)
    return dir
  }

  private indexPath(memberId: string): string {
    return join(this.memberDir(memberId), 'index.json')
  }

  private snapshotsDir(memberId: string): string {
    const dir = join(this.memberDir(memberId), 'snapshots')
    this.assertSafePath(dir)
    return dir
  }

  private snapshotPath(memberId: string, id: string): string {
    if (!isSafeBackupSnapshotId(id)) throw new Error('Invalid snapshot id')
    return join(this.snapshotsDir(memberId), `${id}.${TEAMSPACE_BACKUP_EXT}`)
  }

  private readIndex(memberId: string): TeamBackupSnapshotRow[] {
    const rows = readJson<{ snapshots?: unknown }>(this.indexPath(memberId), {})
    if (!Array.isArray(rows.snapshots)) {
      if (!existsSync(this.indexPath(memberId))) {
        const dir = this.snapshotsDir(memberId)
        if (!existsSync(dir) || !readdirSync(dir).some(name => name.endsWith(`.${TEAMSPACE_BACKUP_EXT}`))) return []
      }
      throw new Error('Backup index is unreadable; repair it before changing backups')
    }
    const out: TeamBackupSnapshotRow[] = []
    const seen = new Set<string>()
    for (const raw of rows.snapshots) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Backup index contains an invalid snapshot')
      const r = raw as Record<string, unknown>
      const id = typeof r.id === 'string' ? r.id : ''
      if (!isSafeBackupSnapshotId(id) || seen.has(id)) throw new Error('Backup index contains an invalid snapshot identity')
      seen.add(id)
      const bytes = typeof r.bytes === 'number' && Number.isFinite(r.bytes) ? Math.max(0, Math.floor(r.bytes)) : 0
      const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
        ? Math.max(0, Math.floor(r.createdAt))
        : 0
      const sha256 = typeof r.sha256 === 'string' && /^[a-f0-9]{64}$/.test(r.sha256) ? r.sha256 : ''
      if (!sha256 || bytes <= 0 || createdAt <= 0) throw new Error('Backup index contains invalid snapshot integrity metadata')
      const owner = parseBackupOwnerFields(r.owner)
      out.push({
        id,
        createdAt,
        bytes,
        sha256,
        label: capBackupLabel(r.label),
        includesBrowserSessions: r.includesBrowserSessions === true,
        memberId,
        ...(owner ? { owner } : {}),
      })
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private writeIndex(memberId: string, rows: TeamBackupSnapshotRow[]): void {
    mkdirSync(this.memberDir(memberId), { recursive: true })
    atomicWriteJson(this.indexPath(memberId), { snapshots: rows.slice(0, 200) })
  }

  listForMember(memberId: string): TeamBackupSnapshotRow[] {
    if (!isSafeBackupMemberId(memberId)) return []
    return this.readIndex(memberId)
  }

  listAll(): TeamBackupSnapshotRow[] {
    const out: TeamBackupSnapshotRow[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.membersRoot)
    } catch {
      return []
    }
    for (const name of names) {
      const memberId = backupMemberFromFolder(name)
      if (!memberId) continue
      out.push(...this.readIndex(memberId))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  getSnapshot(memberId: string, id: string): TeamBackupSnapshotRow | null {
    if (!isSafeBackupMemberId(memberId) || !isSafeBackupSnapshotId(id)) return null
    return this.readIndex(memberId).find((r) => r.id === id) ?? null
  }

  /**
   * TCC-R1144-BKP-004: serialize snapshot reads against the same per-member
   * lock as upload/delete so GET cannot race wipe/rename mid-stream open.
   */
  async openSnapshotRead(memberId: string, id: string): Promise<{ stream: Readable; size: number; row: TeamBackupSnapshotRow } | null> {
    if (!isSafeBackupMemberId(memberId) || !isSafeBackupSnapshotId(id)) return null
    return this.withMemberLock(memberId, () => {
      const row = this.getSnapshot(memberId, id)
      if (!row) return null
      const path = this.snapshotPath(memberId, id)
      let fd: number | undefined
      try {
        // createReadStream(path) opens asynchronously, after this member lock
        // is released. Pin the actual inode before delete/prune can unlink it.
        fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size !== row.bytes) throw new Error('Backup size mismatch')
        return { stream: createReadStream(path, { fd, autoClose: true }), size: stat.size, row }
      } catch {
        if (fd !== undefined) closeSync(fd)
        return null
      }
    })
  }

  private memberBytes(memberId: string): number {
    const dir = this.snapshotsDir(memberId)
    if (!existsSync(dir)) return 0
    let total = 0
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(`.${TEAMSPACE_BACKUP_EXT}`)) continue
      const st = lstatSync(join(dir, name))
      if (!st.isFile()) throw new Error('Backup snapshots must be regular files')
      total += st.size
    }
    // Include unindexed files left by a failed unlink or a process interruption
    // between rename and index commit. They still consume real disk quota.
    return total
  }

  private teamBytes(): number {
    let total = 0
    for (const name of readdirSync(this.membersRoot)) {
      const memberId = backupMemberFromFolder(name)
      if (memberId) total += this.memberBytes(memberId)
    }
    return total
  }

  private reservedTeamBytes(): number {
    let n = 0
    for (const bytes of this.teamQuotaReserved.values()) n += bytes
    return n
  }

  /**
   * TCC-R1133-BKP-002: atomically check-and-reserve against the team byte
   * ceiling under a dedicated global lock key (TEAM_QUOTA_LOCK_KEY, never a
   * valid `isSafeBackupMemberId` value so it can never collide with a real
   * member's per-member lock). The critical section is only the cheap
   * check + counter bump - the actual (slow) disk write happens OUTSIDE
   * this lock so concurrent uploads for different members still stream in
   * parallel; only this short accounting step serializes. Caller MUST
   * release the returned reservation id via `releaseTeamQuotaReservation`
   * in a `finally` once the upload's outcome (success or failure) is known.
   */
  private async reserveTeamQuota(len: number, maxBytesTeam: number): Promise<
    { ok: true; reservationId: string } | { ok: false }
  > {
    return this.withMemberLock(TEAM_QUOTA_LOCK_KEY, () => {
      const current = this.teamBytes() + this.reservedTeamBytes()
      if (current + len > maxBytesTeam) {
        return { ok: false as const }
      }
      const reservationId = `${Date.now().toString(36)}:${randomBytes(6).toString('hex')}`
      this.teamQuotaReserved.set(reservationId, len)
      return { ok: true as const, reservationId }
    })
  }

  private releaseTeamQuotaReservation(reservationId: string | null): void {
    if (!reservationId) return
    this.teamQuotaReserved.delete(reservationId)
  }

  /**
   * TCC-R1133-BKP-001: single per-member mutex serializing EVERY mutation
   * against a member's snapshot index + on-disk snapshot files - not just
   * uploads. Without this, an Admin `deleteSnapshot`/`deleteAllForMember`
   * racing a concurrent `putSnapshotFromStream` for the same member could
   * either (a) overwrite the just-written index with a stale in-memory read
   * taken before the put finished (lost-update on `index.json`), or (b) call
   * `rmSync` on the member's whole directory while the put's `pipeline()` is
   * still writing its `.part` file / about to `renameSync` into it (ENOENT /
   * a resurrected file). Every method that reads-then-writes the index or
   * touches files under `memberDir(memberId)` MUST run inside this lock.
   */
  private async withMemberLock<T>(memberId: string, fn: () => Promise<T> | T): Promise<T> {
    if (this.pendingLocks >= 256) throw new Error('Backup operation queue is full; retry shortly')
    this.pendingLocks += 1
    const prev = this.uploadLocks.get(memberId)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    this.uploadLocks.set(memberId, gate)
    if (prev) {
      try { await prev } catch { /* */ }
    }
    try {
      return await fn()
    } finally {
      this.pendingLocks -= 1
      release()
      if (this.uploadLocks.get(memberId) === gate) this.uploadLocks.delete(memberId)
    }
  }

  /**
   * Single-flight upload per member. Streams body to disk; never buffers whole archive.
   */
  async putSnapshotFromStream(args: {
    memberId: string
    stream: NodeJS.ReadableStream
    contentLength: number
    label?: string
    includesBrowserSessions?: boolean
    sha256Expected?: string
    /** Member preference; never above team meta.maxKeepPerMember. */
    keepHint?: number
    /** Attribution from `x-backup-meta`. Does not change the storage folder. */
    owner?: TeamBackupOwnerMeta
    /** Rechecked under the member lock and after the final streamed byte. */
    authorize?: () => boolean
  }): Promise<
    | { ok: true; snapshot: TeamBackupSnapshotRow }
    | { ok: false; error: string; status?: number }
  > {
    const memberId = args.memberId
    if (!isSafeBackupMemberId(memberId)) {
      return { ok: false, error: 'Invalid member id', status: 400 }
    }
    const len = args.contentLength
    if (!Number.isSafeInteger(len) || len <= 0 || len > MAX_BACKUP_BYTES) {
      return { ok: false, error: 'Invalid Content-Length for backup', status: 400 }
    }
    if (args.sha256Expected !== undefined && !/^[a-fA-F0-9]{64}$/.test(args.sha256Expected)) {
      return { ok: false, error: 'Invalid backup checksum', status: 400 }
    }

    return this.withMemberLock(memberId, async (): Promise<
      { ok: true; snapshot: TeamBackupSnapshotRow } | { ok: false; error: string; status?: number }
    > => {
      if (args.authorize && !args.authorize()) return { ok: false as const, error: 'Session is no longer authorized', status: 403 }
      const meta = this.getMeta()
      const rows = this.readIndex(memberId)
      if (rows.length > 0 && meta.minIntervalMs > 0) {
        const newest = rows[0]!
        if (Date.now() - newest.createdAt < meta.minIntervalMs) {
          args.stream.resume()
          return {
            ok: false,
            error: 'Backup too soon after the last one. Wait and try again.',
            status: 429,
          }
        }
      }
      const used = this.memberBytes(memberId)
      if (used + len > meta.maxBytesPerMember) {
        args.stream.resume()
        return {
          ok: false,
          error: 'This member is over the team backup size limit.',
          status: 400,
        }
      }
      let teamReservationId: string | null = null
      if (meta.maxBytesTeam > 0) {
        const reserved = await this.reserveTeamQuota(len, meta.maxBytesTeam)
        if (!reserved.ok) {
          args.stream.resume()
          return {
            ok: false,
            error: 'The team backup storage is full.',
            status: 400,
          }
        }
        teamReservationId = reserved.reservationId
      }

      // TS-P6-021: hoisted so the outer `finally` can always un-register the
      // live `.part` - it must stay registered across the pipeline, the sha /
      // length checks AND the rename, because `cleanupPartials()` deleting it
      // in any of those windows breaks this upload.
      let livePart: string | null = null
      try {
        mkdirSync(this.snapshotsDir(memberId), { recursive: true })
        const id = mintSnapshotId()
        const dest = this.snapshotPath(memberId, id)
        const tmp = `${dest}.${process.pid}.part`
        livePart = resolve(tmp)
        this.liveParts.add(livePart)
        const hash = createHash('sha256')
        let bytes = 0
        const hasher = new Transform({
          transform(chunk, _enc, cb) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
            bytes += buf.length
            // Bound against the DECLARED length (`len`, already validated
            // `0 < len <= MAX_BACKUP_BYTES` above), never only the global
            // ceiling - a stream that keeps producing bytes past what it
            // declared must abort immediately (freeing the source stream
            // too, via pipeline()'s cleanup) instead of writing/hashing up
            // to the full 8 GiB before the post-hoc `bytes !== len` check
            // catches the mismatch (A20: fail-fast, not fail-eventually).
            if (bytes > len) {
              cb(new Error('Backup exceeded declared Content-Length'))
              return
            }
            hash.update(buf)
            cb(null, buf)
          },
        })

        try {
          await pipeline(args.stream, hasher, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }))
        } catch (err) {
          try { unlinkSync(tmp) } catch { /* */ }
          return { ok: false, error: capBackupError(err, 'Backup write failed'), status: 400 }
        }

        const sha256 = hash.digest('hex')
        if (args.sha256Expected) {
          const expected = args.sha256Expected.toLowerCase().replace(/[^a-f0-9]/g, '')
          if (expected.length === 64 && expected !== sha256) {
            try { unlinkSync(tmp) } catch { /* */ }
            return { ok: false, error: 'Checksum mismatch', status: 400 }
          }
        }
        if (bytes !== len) {
          // Allow small mismatch only if Content-Length was a declared estimate?
          // Fail closed: declared length must match bytes written.
          try { unlinkSync(tmp) } catch { /* */ }
          return { ok: false, error: 'Content-Length did not match uploaded bytes', status: 400 }
        }

        if (args.authorize && !args.authorize()) {
          try { unlinkSync(tmp) } catch { /* */ }
          return { ok: false, error: 'Session is no longer authorized', status: 403 }
        }
        const commitMeta = this.getMeta()
        const otherReserved = this.reservedTeamBytes() - (teamReservationId ? (this.teamQuotaReserved.get(teamReservationId) ?? 0) : 0)
        if (this.memberBytes(memberId) + bytes > commitMeta.maxBytesPerMember
          || (commitMeta.maxBytesTeam > 0 && this.teamBytes() + otherReserved + bytes > commitMeta.maxBytesTeam)) {
          try { unlinkSync(tmp) } catch { /* */ }
          return { ok: false, error: 'Backup storage limit changed during upload', status: 400 }
        }

        try {
          // The stream has closed. Sync archive bytes before publishing the
          // final filename/index, then sync both new directory links.
          const archiveFd = openSync(tmp, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          try { fsyncSync(archiveFd) } finally { closeSync(archiveFd) }
          renameSync(tmp, dest)
          syncBackupDirectory(this.snapshotsDir(memberId))
          syncBackupDirectory(this.memberDir(memberId))
          syncBackupDirectory(this.membersRoot)
        } catch (err) {
          try { unlinkSync(tmp) } catch { /* */ }
          return {
            ok: false,
            error: capBackupError(err, 'Could not finalize backup'),
            status: 500,
          }
        }

        const parsedOwner = parseBackupOwnerFields(args.owner)
        if (parsedOwner) parsedOwner.memberId = memberId
        const snapshot: TeamBackupSnapshotRow = {
          id,
          createdAt: Date.now(),
          bytes,
          sha256,
          label: capBackupLabel(args.label),
          includesBrowserSessions: args.includesBrowserSessions === true,
          memberId,
          ...(parsedOwner ? { owner: parsedOwner } : {}),
        }
        const keepHint =
          typeof args.keepHint === 'number' && Number.isFinite(args.keepHint) && args.keepHint > 0
            ? Math.min(100, Math.floor(args.keepHint))
            : commitMeta.maxKeepPerMember
        const next = [snapshot, ...rows].slice(0, Math.min(commitMeta.maxKeepPerMember, keepHint))
        try {
          // One index commit precedes retention deletion. A second index write
          // after deleting old backups could fail and then delete the NEW backup
          // too, losing both the successful previous snapshot and this upload.
          this.writeIndex(memberId, next)
        } catch (err) {
          // A20: the backup bytes already landed safely at `dest`, but if
          // the index can't be persisted (disk full, EACCES, ...) the
          // snapshot is invisible to quota accounting, listing, and
          // pruning forever - an orphan nobody can ever clean up. Fail
          // closed: remove the just-written file so a failed upload never
          // silently squats on disk, and surface a structured error
          // instead of letting the exception reject this promise uncaught.
          // A directory-fsync failure can occur AFTER the index rename. Never
          // delete bytes that the now-visible index references in that case.
          let indexed = false
          try { indexed = this.readIndex(memberId).some(row => row.id === id) } catch { /* unreadable/absent index */ }
          if (!indexed) { try { unlinkSync(dest) } catch { /* */ } }
          return {
            ok: false,
            error: capBackupError(err, 'Could not record backup'),
            status: 500,
          }
        }
        const retained = new Set(next.map(row => row.id))
        for (const row of rows) {
          if (!retained.has(row.id)) {
            try { unlinkSync(this.snapshotPath(memberId, row.id)) } catch { /* retry orphan cleanup separately */ }
          }
        }
        const saved = this.getSnapshot(memberId, id) ?? snapshot
        return { ok: true, snapshot: saved }
      } finally {
        // TCC-R1133-BKP-002: release the reservation on EVERY exit path
        // (success, checksum/length mismatch, write failure) so a failed
        // upload's bytes never permanently squat on the team ceiling.
        this.releaseTeamQuotaReservation(teamReservationId)
        // TS-P6-021: this request no longer owns those bytes. Every path
        // above either renamed the `.part` away or unlinked it, so a later
        // sweep finding it again is genuine crash residue.
        if (livePart) this.liveParts.delete(livePart)
      }
    }).catch((err) => ({ ok: false as const, error: capBackupError(err, 'Backup write failed'), status: 500 }))
  }

  async deleteSnapshot(memberId: string, id: string, authorize?: () => boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isSafeBackupMemberId(memberId) || !isSafeBackupSnapshotId(id)) {
      return { ok: false, error: 'Not found' }
    }
    return this.withMemberLock(memberId, () => {
      if (authorize && !authorize()) return { ok: false, error: 'Session is no longer authorized' }
      const rows = this.readIndex(memberId)
      const next = rows.filter((r) => r.id !== id)
      if (next.length === rows.length) return { ok: false, error: 'Not found' }
      try {
        this.writeIndex(memberId, next)
      } catch (err) {
        // A20: never let an index-persist failure reject this promise
        // uncaught - the file was already best-effort unlinked above, so
        // surface a structured error rather than an unhandled rejection.
        return { ok: false, error: capBackupError(err, 'Could not update the backup index') }
      }
      try { unlinkSync(this.snapshotPath(memberId, id)) } catch { /* indexed deletion has committed */ }
      return { ok: true }
    })
  }

  /** Member folder ids that have a backups/members/<id> tree (may be departed). */
  listMemberFolderIds(): string[] {
    let names: string[] = []
    try {
      names = readdirSync(this.membersRoot)
    } catch {
      return []
    }
    return names.map(backupMemberFromFolder).filter((id): id is string => id !== null).slice(0, 2000)
  }

  /**
   * TS-P6-006: wipe every snapshot for one member folder (admin offboarding).
   * Callers must refuse while the member is still on the live roster.
   */
  async deleteAllForMember(memberId: string, authorize?: () => boolean): Promise<
    | { ok: true; deletedCount: number; bytesFreed: number }
    | { ok: false; error: string }
  > {
    if (!isSafeBackupMemberId(memberId)) {
      return { ok: false, error: 'Invalid member id' }
    }
    return this.withMemberLock(memberId, () => {
      if (authorize && !authorize()) return { ok: false, error: 'Session is no longer authorized' }
      const dir = this.memberDir(memberId)
      if (!existsSync(dir)) {
        return { ok: false, error: 'No backups for this member' }
      }
      const rows = this.readIndex(memberId)
      const bytesFreed = rows.reduce((n, r) => n + (Number.isFinite(r.bytes) ? r.bytes : 0), 0)
      const deletedCount = rows.length
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        return {
          ok: false,
          error: capBackupError(err, 'Could not delete member backups'),
        }
      }
      return { ok: true, deletedCount, bytesFreed }
    })
  }

  /**
   * Admin zip selection: newest-1-per-member (default) or an explicit id list.
   * Returns absolute paths for STORED zip streaming (member .aimove only).
   * Empty aimove set is ok when the caller will still append chat/ entries.
   */
  pickExportEntries(args: {
    mode: 'newestPerMember' | 'ids'
    ids?: string[]
  }): {
    ok: true
    entries: Array<{ name: string; size: number; absolutePath: string; row: TeamBackupSnapshotRow }>
    missingOnDisk: number
    missingIds: number
    requestedIdCount: number
  } | { ok: false; error: string } {
    const all = this.listAll()
    let picked: TeamBackupSnapshotRow[] = []
    let requestedIdCount = 0
    let matchedIdCount = 0
    if (args.mode === 'ids') {
      const want = new Set(
        (Array.isArray(args.ids) ? args.ids : [])
          .filter((id): id is string => typeof id === 'string' && isSafeBackupSnapshotId(id)),
      )
      requestedIdCount = want.size
      if (want.size === 0) return { ok: false, error: 'No valid backup ids' }
      picked = all.filter((r) => want.has(r.id))
      matchedIdCount = picked.length
      if (picked.length === 0) return { ok: false, error: 'No matching backups' }
    } else {
      const seen = new Set<string>()
      for (const row of all) {
        if (seen.has(row.memberId)) continue
        seen.add(row.memberId)
        picked.push(row)
      }
    }
    const entries: Array<{ name: string; size: number; absolutePath: string; row: TeamBackupSnapshotRow }> = []
    let missingOnDisk = 0
    for (const row of picked) {
      const absolutePath = this.snapshotPath(row.memberId, row.id)
      if (!existsSync(absolutePath)) {
        // TCC-R1147-BKP-003: count silent skips for honesty headers.
        missingOnDisk += 1
        continue
      }
      entries.push({
        name: `${backupMemberFolder(row.memberId)}/${row.id}.${TEAMSPACE_BACKUP_EXT}`,
        size: row.bytes,
        absolutePath,
        row,
      })
    }
    // newestPerMember with zero on-disk files: still ok (chat-only export).
    if (args.mode === 'ids' && entries.length === 0) {
      return { ok: false, error: 'No backup files on disk' }
    }
    const missingIds = args.mode === 'ids' ? Math.max(0, requestedIdCount - matchedIdCount) : 0
    return {
      ok: true,
      entries,
      missingOnDisk,
      missingIds,
      requestedIdCount,
    }
  }

  /**
   * Live Team chat tree for admin export.zip (rooms, history, attachments, meta).
   * Uses enumerateChatBackupFiles / listChatBackupZipEntries - never a parallel walk.
   */
  pickChatExportEntries(maxFiles = CHAT_BACKUP_MAX_FILES, authorityDir = this.dataDir): {
    entries: Array<{ name: string; size: number; absolutePath: string }>
    truncated: boolean
  } {
    return listChatBackupZipEntries(this.dataDir, maxFiles, authorityDir)
  }

  /** Drop leftover .part files under all members (crash recovery). */
  cleanupPartials(): number {
    let n = 0
    let names: string[] = []
    try {
      names = readdirSync(this.membersRoot)
    } catch {
      return 0
    }
    for (const name of names) {
      const memberId = backupMemberFromFolder(name)
      if (!memberId) continue
      const dir = this.snapshotsDir(memberId)
      let files: string[] = []
      try {
        files = readdirSync(dir)
      } catch {
        continue
      }
      for (const f of files) {
        if (!f.endsWith('.part')) continue
        const abs = join(dir, f)
        // TS-P6-021: never unlink bytes a live upload in THIS process is
        // still streaming into or about to rename. Skipping is safe: the
        // owning request drops its registration on every exit path, so the
        // next sweep collects it if it really was abandoned.
        if (this.liveParts.has(resolve(abs))) continue
        try {
          unlinkSync(abs)
          n++
        } catch { /* */ }
      }
    }
    return n
  }
}
