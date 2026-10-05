import { retainIndependentCheckpoint } from './independent-authority.js'
/** Optional deterministic attention monitor. Never calls a model or sends messages.
 * Runs inside the bridge's exclusively locked data directory, not on each desktop. */
import { randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'
import { WorkspaceWorkError, type WorkActor, type WorkspaceTask, type WorkspaceWorkStore, type WorkSnapshot } from './workspace-work.js'

export type CoordinatorAttentionKind = 'blocked' | 'overdue' | 'review_needed' | 'changes_requested' | 'unassigned' | 'reviewer_unavailable'
export type CoordinatorAttention = { id: string; taskId: string; title: string; kind: CoordinatorAttentionKind; dueAt: number | null; submissionVersion: number }
export type CoordinatorMonitorState = {
  kind: 'coordinator_monitor'; workspaceId: string; memberId: string; enabled: boolean
  status: 'disabled' | 'running' | 'unavailable'; lastCheckedAt: number | null; intervalMs: number
  revision: number; total: number; truncated: boolean; attention: CoordinatorAttention[]
}
type Subscription = { workspaceId: string; memberId: string }
type Disk = { schemaVersion: 1; subscriptions: Subscription[] }
type Scan = { revision: number; authority: string; nextDueAt: number | null; checkedAt: number; attention: CoordinatorAttention[]; total: number }
const INTERVAL_MS = 30_000, MAX_SUBSCRIPTIONS = 100, MAX_ATTENTION = 100
const scope = (workspaceId: string, memberId: string) => JSON.stringify([workspaceId, memberId])
function fail(status: number, code: string, message: string): never { throw new WorkspaceWorkError(status, code, message) }
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, 'invalid', 'Invalid monitor identity')
  return value
}
function validateDisk(raw: unknown): Disk {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid monitor storage')
  const d = raw as Disk
  if (Object.keys(d).sort().join(',') !== 'schemaVersion,subscriptions' || d.schemaVersion !== 1 || !Array.isArray(d.subscriptions) || d.subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error('Invalid monitor storage')
  const seen = new Set<string>()
  for (const s of d.subscriptions) {
    if (!s || Object.keys(s).sort().join(',') !== 'memberId,workspaceId') throw new Error('Invalid monitor subscription')
    const key = scope(identifier(s.workspaceId), identifier(s.memberId))
    if (seen.has(key)) throw new Error('Duplicate monitor subscription')
    seen.add(key)
  }
  return d
}

export class WorkspaceCoordinatorMonitor {
  private disk: Disk = { schemaVersion: 1, subscriptions: [] }
  private unavailable = false
  private path: string
  private scans = new Map<string, Scan>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private nextSubscription = 0
  constructor(private dir: string, private key: AtRestKey | null, private work: WorkspaceWorkStore, private currentMember: (id: string) => WorkActor | null) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.path = join(dir, 'workspace-coordinator-monitor.json')
    try {
      if (statSync(this.path).size > 100_000) throw new Error('Oversized monitor storage')
      this.disk = validateDisk(decryptJsonFile<Disk | null>(key, readFileSync(this.path, 'utf8'), null))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable = true }
  }
  private ready() { if (this.unavailable) fail(503, 'unavailable', 'Coordinator monitoring storage is unavailable') }
  private current(workspaceId: string, memberId: string): { actor: WorkActor; snapshot: WorkSnapshot } {
    identifier(workspaceId); identifier(memberId)
    const actor = this.currentMember(memberId)
    if (!actor || actor.memberId !== memberId || actor.agentId) fail(403, 'forbidden', 'Active human workspace membership required')
    return { actor, snapshot: this.work.read(workspaceId, actor, { collection: 'tasks', limit: 1 }) }
  }
  private forget(workspaceId: string, memberId: string) {
    this.scans.delete(scope(workspaceId, memberId))
    const subscriptions = this.disk.subscriptions.filter(s => s.workspaceId !== workspaceId || s.memberId !== memberId)
    if (subscriptions.length !== this.disk.subscriptions.length) this.persist({ schemaVersion: 1, subscriptions })
  }
  /** Called immediately after membership commits, not only at the next timer.
   * A revoke/regrant cycle must require fresh consent even if no read happened
   * while the member was absent. One batch persistence avoids N fsyncs. */
  invalidateAccess(workspaceId?: string, memberId?: string): void {
    this.ready()
    const subscriptions = this.disk.subscriptions.filter(subscription => {
      if ((workspaceId && subscription.workspaceId !== workspaceId) || (memberId && subscription.memberId !== memberId)) return true
      this.scans.delete(scope(subscription.workspaceId, subscription.memberId))
      try { const { actor } = this.current(subscription.workspaceId, subscription.memberId); return ['admin', 'member'].includes(actor.role) }
      catch (error) { if (error instanceof WorkspaceWorkError && [403, 404].includes(error.status)) return false; throw error }
    })
    if (subscriptions.length !== this.disk.subscriptions.length) {
      try { this.persist({ schemaVersion: 1, subscriptions }) }
      catch (error) { this.unavailable = true; this.scans.clear(); throw error }
    }
  }
  /** A member opts in only for their own private view; no audience grants. */
  configure(workspaceId: string, memberId: string, enabled: boolean): CoordinatorMonitorState {
    this.ready()
    const { actor } = this.current(workspaceId, memberId)
    if (typeof enabled !== 'boolean') fail(400, 'invalid', 'Choose whether monitoring is enabled')
    if (enabled && !['admin', 'member'].includes(actor.role)) fail(403, 'forbidden', 'A writable workspace member is required to enable monitoring')
    const exists = this.disk.subscriptions.some(s => s.workspaceId === workspaceId && s.memberId === memberId)
    if (enabled && !exists) {
      if (this.disk.subscriptions.length >= MAX_SUBSCRIPTIONS) fail(409, 'capacity', 'Coordinator monitoring capacity reached')
      this.persist({ schemaVersion: 1, subscriptions: [...this.disk.subscriptions, { workspaceId, memberId }] })
    } else if (!enabled && exists) this.forget(workspaceId, memberId)
    return this.read(workspaceId, memberId)
  }
  read(workspaceId: string, memberId: string): CoordinatorMonitorState {
    this.ready()
    let current: ReturnType<WorkspaceCoordinatorMonitor['current']>
    try { current = this.current(workspaceId, memberId) }
    catch (error) {
      if (error instanceof WorkspaceWorkError && [403, 404].includes(error.status)) this.forget(workspaceId, memberId)
      throw error
    }
    const { actor, snapshot } = current
    if (!['admin', 'member'].includes(actor.role)) this.forget(workspaceId, memberId)
    const enabled = this.disk.subscriptions.some(s => s.workspaceId === workspaceId && s.memberId === memberId)
    const base: CoordinatorMonitorState = { kind: 'coordinator_monitor', workspaceId, memberId, enabled, status: enabled ? this.running ? 'running' : 'unavailable' : 'disabled', lastCheckedAt: null, intervalMs: INTERVAL_MS, revision: snapshot.revision, total: 0, truncated: false, attention: [] }
    if (!enabled) return base
    try {
      const scan = this.scan(workspaceId, actor, snapshot)
      return { ...base, lastCheckedAt: scan.checkedAt, total: scan.total, truncated: scan.total > scan.attention.length, attention: structuredClone(scan.attention) }
    } catch { this.scans.delete(scope(workspaceId, memberId)); return { ...base, status: 'unavailable' } }
  }
  private scan(workspaceId: string, actor: WorkActor, first: WorkSnapshot): Scan {
    const now = Date.now(), key = scope(workspaceId, actor.memberId), previous = this.scans.get(key)
    // Role/revocation and AI credential expiry can change without a work revision.
    const authority = JSON.stringify([actor.role, first.actor.canManage, first.workspace.memberIds.map(id => [id, this.currentMember(id)?.role ?? null]), first.aiReviewers])
    if (previous && previous.revision === first.revision && previous.authority === authority && (previous.nextDueAt === null || previous.nextDueAt > now)) {
      previous.checkedAt = now
      return previous
    }
    let page = first, limit = 50, cursor = first.pages.tasks.nextCursor, count = 0, nextDueAt: number | null = null
    const attention: CoordinatorAttention[] = []
    const append = (task: WorkspaceTask, kind: CoordinatorAttentionKind) => attention.push({ id: `${task.id}:${kind}:${task.assignmentVersion}:${task.submissionVersion}`, taskId: task.id, title: task.title, kind, dueAt: task.dueAt, submissionVersion: task.submissionVersion })
    const inspect = (task: WorkspaceTask) => {
      if (++count > 10_000) fail(409, 'capacity', 'Workspace monitor task capacity reached')
      if (['completed', 'cancelled'].includes(task.status)) return
      const manager = first.actor.canManage, owns = task.assigneeId === actor.memberId
      const approved = (kind: 'human' | 'ai', id: string) => task.decisions.some(d => d.submissionVersion === task.submissionVersion && d.reviewer.kind === kind && d.reviewer.id === id && d.outcome === 'approve')
      const reviews = task.reviewPolicy.mode !== 'ai' && task.reviewPolicy.humanReviewerIds.includes(actor.memberId)
      const relevant = manager || owns || reviews
      if (!relevant) return
      if (task.dueAt !== null) {
        if (task.dueAt <= now) append(task, 'overdue')
        else nextDueAt = nextDueAt === null ? task.dueAt : Math.min(nextDueAt, task.dueAt)
      }
      if (task.status === 'blocked') append(task, 'blocked')
      if (task.status === 'changes_requested' && (manager || owns)) append(task, 'changes_requested')
      if (!task.assigneeId && manager) append(task, 'unassigned')
      if (task.status === 'in_review') {
        const aiReady = task.reviewPolicy.mode !== 'ai_then_human' || task.reviewPolicy.aiReviewerIds.every(id => approved('ai', id))
        const independent = !task.reviewPolicy.independent || task.submissions.at(-1)?.submittedBy !== actor.memberId
        if (reviews && aiReady && independent && !approved('human', actor.memberId)) append(task, 'review_needed')
        if (manager) {
          const unavailableHuman = task.reviewPolicy.humanReviewerIds.some(id => { const m = this.currentMember(id); return !m || !['admin', 'member'].includes(m.role) || !first.workspace.memberIds.includes(id) })
          const unavailableAi = task.reviewPolicy.aiReviewerIds.some(id => !first.aiReviewers?.some(a => a.agentId === id && a.active))
          if (unavailableHuman || unavailableAi) append(task, 'reviewer_unavailable')
        }
      }
    }
    for (;;) {
      page.tasks.forEach(inspect)
      if (!cursor) break
      for (;;) {
        try { page = this.work.read(workspaceId, actor, { collection: 'tasks', cursor, limit }); break }
        catch (error) {
          if (error instanceof WorkspaceWorkError && error.code === 'page_too_large' && limit > 1) { limit = Math.max(1, Math.floor(limit / 2)); continue }
          throw error
        }
      }
      if (page.revision !== first.revision) fail(409, 'revision_conflict', 'Workspace changed during monitoring')
      cursor = page.pages.tasks.nextCursor
    }
    const rank: Record<CoordinatorAttentionKind, number> = { review_needed: 0, reviewer_unavailable: 1, blocked: 2, changes_requested: 3, overdue: 4, unassigned: 5 }
    attention.sort((a, b) => rank[a.kind] - rank[b.kind] || (a.dueAt ?? Number.MAX_SAFE_INTEGER) - (b.dueAt ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id))
    const scan: Scan = { revision: first.revision, authority, nextDueAt, checkedAt: now, total: attention.length, attention: attention.slice(0, MAX_ATTENTION) }
    this.scans.set(key, scan)
    return scan
  }
  /** One subscription per turn bounds event-loop work; persisted opt-ins recover on restart. */
  tick(): void {
    if (this.unavailable || !this.disk.subscriptions.length) return
    const subscription = this.disk.subscriptions[this.nextSubscription++ % this.disk.subscriptions.length]
    try { this.read(subscription.workspaceId, subscription.memberId) } catch { /* fail closed; other members still run */ }
  }
  start(): void {
    if (this.running) return
    this.running = true
    const run = () => {
      if (!this.running) return
      this.tick()
      this.timer = setTimeout(run, Math.max(100, Math.floor(INTERVAL_MS / Math.max(1, this.disk.subscriptions.length))))
      this.timer.unref?.()
    }
    this.timer = setTimeout(run, 0); this.timer.unref?.()
  }
  stop(): void { this.running = false; if (this.timer) clearTimeout(this.timer); this.timer = null; this.scans.clear() }
  private persist(next: Disk) {
    retainIndependentCheckpoint(this.dir,'workspace-coordinator-monitor.json')
    const serialized = this.key ? encryptJsonFile(this.key, next) : JSON.stringify(next)
    const temp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let fd: number | undefined, renamed = false
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temp, this.path); renamed = true
      fd = openSync(this.dir, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined
      this.disk = next
    } catch {
      if (renamed) { this.unavailable = true; this.scans.clear() }
      fail(503, 'storage_failure', 'Coordinator monitoring settings could not be durably saved')
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp) } catch { /* renamed or absent */ } }
  }
}
