import { retainIndependentCheckpoint } from './independent-authority.js'
/** Self-hosted, server-authoritative human work. No desktop project contents are imported implicitly. */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'

export type WorkActor = { memberId: string; role: string; /** Set only by the server's service-credential authentication. */ agentId?: string }
export type ReviewPolicy = { mode: 'human' | 'ai' | 'ai_then_human' | 'both'; humanReviewerIds: string[]; aiReviewerIds: string[]; independent: boolean }
export type WorkProfile = { memberId: string; title: string; responsibilities: string; skills: string[]; languages: string[]; availability: string; timezone: string; workHours: string; requestedDepartmentIds: string[] }
export type WorkDepartment = { id: string; name: string; floorId: string; leadId: string | null; backupId: string | null; memberIds: string[]; responsibilities: string; reviewerIds: string[] }
export type WorkSubmission = { version: number; submittedBy: string; submittedAt: number; evidence: string }
export type WorkDecision = { id: string; submissionVersion: number; reviewer: { kind: 'human' | 'ai'; id: string }; outcome: 'approve' | 'changes_requested'; reasoning: string; decidedAt: number; execution?: { runId: string; model: string } }
export type WorkspaceTask = { id: string; title: string; description: string; departmentId: string | null; assigneeId: string | null; assignmentVersion: number; createdBy: string; status: 'open' | 'claimed' | 'in_progress' | 'blocked' | 'in_review' | 'changes_requested' | 'completed' | 'cancelled'; reviewPolicy: ReviewPolicy; dueAt: number | null; submissionVersion: number; submissions: WorkSubmission[]; decisions: WorkDecision[]; helpRequest: string | null; createdAt: number; updatedAt: number; historyCounts?: { submissions: number; decisions: number } }
export type WorkEvent = { id: string; revision: number; actorId: string; action: string; entityId: string | null; at: number }
export type WorkCollection = 'profiles' | 'departments' | 'tasks' | 'events'
export type WorkPage = { total: number; nextCursor: string | null; hasMore: boolean }
export type WorkSnapshot = { kind: 'snapshot'; actor: { memberId: string; canManage: boolean }; workspaceId: string; revision: number; workspace: { name: string; memberIds: string[]; managerIds: string[] }; profiles: WorkProfile[]; departments: WorkDepartment[]; tasks: WorkspaceTask[]; events: WorkEvent[]; pages: Record<WorkCollection, WorkPage>; aiReviewers?: { agentId: string; expiresAt: number; active: boolean }[]; capabilities: { version: 1; aiReviewSubmission: true; aiReviewExecution: false; durableWorkflowResume: false } }
type StoredWorkspace = Omit<WorkSnapshot, 'capabilities' | 'kind' | 'actor' | 'pages' | 'aiReviewers'> & { receipts: { actorId: string; commandId: string; fingerprint: string }[]; aiCredentials?: { agentId: string; issuedBy: string; tokenHash: string; expiresAt: number }[] }
type Disk = { schemaVersion: 1; workspaces: StoredWorkspace[] }
export class WorkspaceWorkError extends Error { constructor(public status: number, public code: string, message: string) { super(message) } }
function fail(status: number, code: string, message: string): never { throw new WorkspaceWorkError(status, code, message) }
function bag(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid', 'Expected an object'); return value as Record<string, unknown> }
function id(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail(400, 'invalid', 'Invalid identifier'); return value }
function memberId(value: unknown): string { if (typeof value === 'string' && value.length <= 128 && /^device:[A-Za-z0-9_-]+$/.test(value)) return value; return id(value) }
function text(value: unknown, max: number, required = false): string { if (typeof value !== 'string' || value.length > max || value.includes('\0') || (required && !value.trim())) fail(400, 'invalid', 'Invalid text'); return value.trim() }
function strings(value: unknown, max = 100, itemMax = 128): string[] { if (!Array.isArray(value) || value.length > max) fail(400, 'invalid', 'Invalid list'); const list = value.map(v => text(v, itemMax, true)); if (new Set(list).size !== list.length) fail(400, 'invalid', 'Duplicate list entries'); return list }
function memberIds(value: unknown): string[] { return strings(value, 2000).map(memberId) }
function clone<T>(value: T): T { return structuredClone(value) }
function closed(raw: unknown, allowed: string[]) { const v = bag(raw); if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error('Unexpected stored field'); return v }
function count(value: unknown, max = Number.MAX_SAFE_INTEGER) { if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) throw new Error('Invalid stored number') }
function rows(value: unknown, max: number): any[] { if (!Array.isArray(value) || value.length > max) throw new Error('Invalid stored list'); return value }
function unique(values: string[]) { if (new Set(values).size !== values.length) throw new Error('Duplicate stored identity') }
function storedPolicy(raw: unknown) {
  const p = closed(raw, ['mode', 'humanReviewerIds', 'aiReviewerIds', 'independent'])
  if (!['human', 'ai', 'ai_then_human', 'both'].includes(String(p.mode)) || typeof p.independent !== 'boolean') throw new Error('Invalid stored policy')
  const human = strings(p.humanReviewerIds, 100).map(memberId), ai = strings(p.aiReviewerIds, 100).map(id)
  if ((p.mode !== 'ai' && !human.length) || (p.mode !== 'human' && !ai.length) || (p.mode === 'ai' && human.length) || (p.mode === 'human' && ai.length)) throw new Error('Invalid stored reviewer lists')
}
/** Validate all nested evidence and authority on load, not just the root envelope. */
function validateDisk(raw: unknown): Disk {
  const disk = closed(raw, ['schemaVersion', 'workspaces'])
  if (disk.schemaVersion !== 1) throw new Error('Unsupported store')
  const workspaces = rows(disk.workspaces, 1000)
  unique(workspaces.map(w => id(bag(w).workspaceId)))
  for (const rawWorkspace of workspaces) {
    const w = closed(rawWorkspace, ['workspaceId', 'revision', 'workspace', 'profiles', 'departments', 'tasks', 'events', 'receipts', 'aiCredentials'])
    const workspace = closed(w.workspace, ['name', 'memberIds', 'managerIds'])
    text(workspace.name, 200, true)
    const members = memberIds(workspace.memberIds), managers = strings(workspace.managerIds, 100).map(memberId)
    if (!managers.length || managers.some(m => !members.includes(m))) throw new Error('Invalid stored managers')
    count(w.revision, 100_000)
    const profiles = rows(w.profiles, 2000)
    unique(profiles.map(p => memberId(bag(p).memberId)))
    for (const value of profiles) {
      const p = closed(value, ['memberId', 'title', 'responsibilities', 'skills', 'languages', 'availability', 'timezone', 'workHours', 'requestedDepartmentIds'])
      if (!members.includes(String(p.memberId))) throw new Error('Profile outside workspace audience')
      text(p.title, 200); text(p.responsibilities, 4000); strings(p.skills, 50); strings(p.languages, 30); text(p.availability, 500); text(p.timezone ?? '', 100); text(p.workHours ?? '', 1000); strings(p.requestedDepartmentIds, 100).map(id)
    }
    const departments = rows(w.departments, 1000)
    unique(departments.map(d => id(bag(d).id)))
    for (const value of departments) {
      const d = closed(value, ['id', 'name', 'floorId', 'leadId', 'backupId', 'memberIds', 'responsibilities', 'reviewerIds'])
      text(d.name, 200, true); text(d.floorId, 128); text(d.responsibilities, 4000)
      const assigned = strings(d.memberIds, 500).map(memberId), reviewers = strings(d.reviewerIds, 500).map(memberId)
      if ([...assigned, ...reviewers].some(m => !members.includes(m))) throw new Error('Department assignment outside workspace audience')
      for (const lead of [d.leadId, d.backupId]) if (lead !== null && !assigned.includes(memberId(lead))) throw new Error('Invalid department lead')
    }
    const tasks = rows(w.tasks, 10_000)
    unique(tasks.map(t => id(bag(t).id)))
    for (const value of tasks) {
      const t = closed(value, ['id', 'title', 'description', 'departmentId', 'assigneeId', 'assignmentVersion', 'createdBy', 'status', 'reviewPolicy', 'dueAt', 'submissionVersion', 'submissions', 'decisions', 'helpRequest', 'createdAt', 'updatedAt'])
      if (t.assignmentVersion === undefined) t.assignmentVersion = 0
      count(t.assignmentVersion)
      text(t.title, 300, true); text(t.description, 12000); memberId(t.createdBy); if (t.departmentId !== null) id(t.departmentId); if (t.assigneeId !== null) memberId(t.assigneeId)
      if (!['open', 'claimed', 'in_progress', 'blocked', 'in_review', 'changes_requested', 'completed', 'cancelled'].includes(String(t.status))) throw new Error('Invalid task state')
      storedPolicy(t.reviewPolicy); if (t.dueAt !== null) count(t.dueAt); count(t.createdAt); count(t.updatedAt); count(t.submissionVersion, 1000); if (t.helpRequest !== null) text(t.helpRequest, 4000, true)
      const submissions = rows(t.submissions, 1000)
      if (submissions.length !== t.submissionVersion) throw new Error('Invalid evidence version')
      submissions.forEach((value, index) => { const s = closed(value, ['version', 'submittedBy', 'submittedAt', 'evidence']); if (s.version !== index + 1) throw new Error('Noncontiguous evidence'); memberId(s.submittedBy); count(s.submittedAt); text(s.evidence, 16000, true) })
      const decisions = rows(t.decisions, 200_000)
      unique(decisions.map(d => `${bag(d).submissionVersion}:${bag(bag(d).reviewer).kind}:${bag(bag(d).reviewer).id}`))
      for (const value of decisions) {
        const d = closed(value, ['id', 'submissionVersion', 'reviewer', 'outcome', 'reasoning', 'decidedAt', 'execution']), r = closed(d.reviewer, ['kind', 'id'])
        id(d.id); r.kind === 'human' ? memberId(r.id) : id(r.id); count(d.submissionVersion, submissions.length); if (!d.submissionVersion || !['human', 'ai'].includes(String(r.kind)) || !['approve', 'changes_requested'].includes(String(d.outcome))) throw new Error('Invalid decision')
        text(d.reasoning, 4000, true); count(d.decidedAt)
        if (r.kind === 'ai') { const execution = closed(d.execution, ['runId', 'model']); id(execution.runId); text(execution.model, 200, true) }
        else if (d.execution !== undefined) throw new Error('Human decision cannot contain AI execution')
      }
      if (['in_review', 'changes_requested', 'completed'].includes(String(t.status)) && !submissions.length) throw new Error('Missing evidence for reviewed task')
      if (t.status === 'completed') {
        const policy = bag(t.reviewPolicy), current = decisions.filter(d => d.submissionVersion === t.submissionVersion)
        const approved = (kind: string, reviewer: string) => current.some(d => d.reviewer.kind === kind && d.reviewer.id === reviewer && d.outcome === 'approve')
        if (current.some(d => d.outcome === 'changes_requested') || (policy.mode !== 'ai' && (policy.humanReviewerIds as string[]).some(r => !approved('human', r))) || (policy.mode !== 'human' && (policy.aiReviewerIds as string[]).some(r => !approved('ai', r)))) throw new Error('Completed task lacks required approvals')
        if (policy.independent && current.some(d => d.reviewer.kind === 'human' && d.reviewer.id === submissions.at(-1).submittedBy)) throw new Error('Invalid independent approval')
      }
    }
    const credentials = rows(w.aiCredentials ?? [], 1000)
    unique(credentials.map(c => id(bag(c).agentId)))
    for (const value of credentials) { const c = closed(value, ['agentId', 'issuedBy', 'tokenHash', 'expiresAt']); memberId(c.issuedBy); count(c.expiresAt); if (typeof c.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(c.tokenHash)) throw new Error('Invalid credential hash') }
    const events = rows(w.events, 100_000), receipts = rows(w.receipts, 100_000)
    if (events.length !== w.revision || receipts.length !== events.length || !events.length) throw new Error('Incomplete audit transaction')
    const actorId = (value: unknown) => { if (typeof value !== 'string') throw new Error('Invalid actor'); if (value.startsWith('ai:')) id(value.slice(3)); else memberId(value) }
    events.forEach((value, index) => { const e = closed(value, ['id', 'revision', 'actorId', 'action', 'entityId', 'at']); id(e.id); if (e.revision !== index + 1) throw new Error('Audit revision gap'); actorId(e.actorId); text(e.action, 64, true); if (e.entityId !== null) memberId(e.entityId); count(e.at) })
    unique(receipts.map(r => `${bag(r).actorId}:${bag(r).commandId}`))
    receipts.forEach((value, index) => { const r = closed(value, ['actorId', 'commandId', 'fingerprint']); actorId(r.actorId); id(r.commandId); if (r.fingerprint !== 'ai-credential' && (typeof r.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(r.fingerprint))) throw new Error('Invalid command receipt'); if (r.actorId !== events[index].actorId || r.commandId !== events[index].id) throw new Error('Audit receipt mismatch') })
  }
  return raw as Disk
}

/** Mutations are synchronous and commit by fsync + atomic rename before publication.
 * The containing bridge already holds an exclusive data-directory process lock. */
export class WorkspaceWorkStore {
  private disk: Disk = { schemaVersion: 1, workspaces: [] }
  private path: string
  private unavailable = false
  private aiActors = new WeakMap<WorkActor, { workspaceId: string; hash: string }>()
  constructor(private dir: string, private key: AtRestKey | null, private memberExists: (id: string) => boolean, private memberCanWrite: (id: string) => boolean = memberExists, private changed?: (workspaceId: string, memberIds: string[], action?: string) => void) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.path = join(dir, 'workspace-work.json')
    try {
      if (statSync(this.path).size > 32_000_000) throw new Error('Oversized store')
      const raw = readFileSync(this.path, 'utf8')
      this.disk = validateDisk(decryptJsonFile<Disk | null>(key, raw, null))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.unavailable = true }
  }
  private ready() { if (this.unavailable) fail(503, 'unavailable', 'Workspace work storage is unavailable') }
  private authorized(w: StoredWorkspace, actor: WorkActor) { if (!this.memberExists(actor.memberId) || !w.workspace.memberIds.includes(actor.memberId)) fail(403, 'forbidden', 'Workspace membership required') }
  private manager(w: StoredWorkspace, actor: WorkActor) { this.authorized(w, actor); if (!this.memberCanWrite(actor.memberId) || !['admin', 'member'].includes(actor.role) || !w.workspace.managerIds.includes(actor.memberId)) fail(403, 'forbidden', 'Workspace manager required') }
  private members(w: StoredWorkspace, value: unknown) { const ids = memberIds(value); if (ids.some(v => !this.memberCanWrite(v) || !w.workspace.memberIds.includes(v))) fail(400, 'invalid_member', 'Choose active non-viewer workspace members for work assignments'); return ids }
  private activeAi(w: StoredWorkspace, agentId: string, hash?: string) { return w.aiCredentials?.find(c => c.agentId === agentId && (!hash || c.tokenHash === hash) && c.expiresAt > Date.now() && this.memberCanWrite(c.issuedBy) && w.workspace.memberIds.includes(c.issuedBy) && w.workspace.managerIds.includes(c.issuedBy)) }
  private assertAi(w: StoredWorkspace, actor: WorkActor) {
    if (!actor.agentId) return
    const admitted = this.aiActors.get(actor)
    if (!admitted || admitted.workspaceId !== w.workspaceId || !this.activeAi(w, actor.agentId, admitted.hash)) fail(401, 'unauthorized', 'AI reviewer credential expired, changed, or revoked')
  }
  private snapshot(w: StoredWorkspace, actor: WorkActor, options: { collection?: WorkCollection; cursor?: string; limit?: number; taskId?: string } = {}): WorkSnapshot {
    // Slice before cloning: reading one task must not clone the entire audit/evidence store.
    const data = { workspaceId: w.workspaceId, revision: w.revision, workspace: clone(w.workspace), profiles: [] as WorkProfile[], departments: [] as WorkDepartment[], tasks: [] as WorkspaceTask[], events: [] as WorkEvent[] }
    // Revoked bridge identities are not returned as eligible actors.
    data.workspace.memberIds = data.workspace.memberIds.filter(this.memberExists)
    data.workspace.managerIds = data.workspace.managerIds.filter(this.memberExists)
    const limit = options.limit ?? 10
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid', 'Page limit must be 1–50')
    let offset = 0
    if (options.cursor) {
      const match = /^(\d+):(\d+)$/.exec(options.cursor)
      if (!match || !options.collection) fail(400, 'invalid', 'Invalid page cursor')
      if (Number(match[1]) !== w.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh pages')
      offset = Number(match[2]); if (!Number.isSafeInteger(offset)) fail(400, 'invalid', 'Invalid page cursor')
    }
    const pages = {} as Record<WorkCollection, WorkPage>
    if (options.taskId && (options.collection || options.cursor)) fail(400, 'invalid', 'Targeted task reads cannot include collection cursors')
    for (const collection of ['profiles', 'departments', 'tasks', 'events'] as const) {
      const start = collection === options.collection ? offset : 0, total = w[collection].length
      const rows = (options.taskId || (options.collection && options.collection !== collection)) ? [] : w[collection].slice(start, start + limit)
      ;(data[collection] as unknown[]) = rows
      const end = start + rows.length
      pages[collection] = { total, hasMore: end < total, nextCursor: end < total ? `${w.revision}:${end}` : null }
    }
    if (options.taskId) {
      const task = w.tasks.find(t => t.id === id(options.taskId))
      if (!task) fail(404, 'not_found', 'Task not found')
      data.tasks = [task]; pages.tasks = { total: 1, hasMore: false, nextCursor: null }
    }
    data.tasks = data.tasks.map(t => ({ ...t, historyCounts: { submissions: t.submissions.length, decisions: t.decisions.length }, submissions: t.submissions.slice(-1), decisions: t.decisions.filter(d => d.submissionVersion === t.submissionVersion) }))
    const result: WorkSnapshot = { ...clone(data), kind: 'snapshot', actor: { memberId: actor.memberId, canManage: actor.role !== 'viewer' && w.workspace.managerIds.includes(actor.memberId) }, pages, aiReviewers: (w.aiCredentials ?? []).map(c => ({ agentId: c.agentId, expiresAt: c.expiresAt, active: !!this.activeAi(w, c.agentId) })), capabilities: { version: 1, aiReviewSubmission: true, aiReviewExecution: false, durableWorkflowResume: false } }
    if (Buffer.byteLength(JSON.stringify(result)) > 1_800_000) fail(413, 'page_too_large', 'Use a smaller page limit')
    return result
  }
  read(workspaceId: string, actor: WorkActor, options: { collection?: WorkCollection; cursor?: string; limit?: number; taskId?: string } = {}): WorkSnapshot {
    this.ready(); id(workspaceId)
    const w = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    if (!w) fail(404, 'not_registered', 'Workspace work is not registered')
    this.authorized(w, actor)
    return this.snapshot(w, actor, options)
  }
  directory(actor: WorkActor) {
    this.ready()
    if (!this.memberExists(actor.memberId)) fail(403, 'forbidden', 'Active membership required')
    return this.disk.workspaces.filter(w => w.workspace.memberIds.includes(actor.memberId)).map(w => ({ id: w.workspaceId, name: w.workspace.name, revision: w.revision, canManage: actor.role !== 'viewer' && w.workspace.managerIds.includes(actor.memberId) }))
  }
  history(workspaceId: string, taskId: string, actor: WorkActor, collection: 'submissions' | 'decisions', cursor?: string, limit = 25) {
    this.ready(); id(workspaceId); id(taskId)
    const w = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    if (!w) fail(404, 'not_registered', 'Workspace not registered')
    this.authorized(w, actor)
    const t = w.tasks.find(t => t.id === taskId)
    if (!t) fail(404, 'not_found', 'Task not found')
    if (!['submissions', 'decisions'].includes(collection) || !Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid', 'Invalid history page')
    let offset = 0
    if (cursor) { const match = /^(\d+):(\d+)$/.exec(cursor); if (!match || !Number.isSafeInteger(Number(match[2]))) fail(400, 'invalid', 'Invalid history cursor'); if (Number(match[1]) !== w.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh history'); offset = Number(match[2]) }
    const rows = clone(t[collection].slice(offset, offset + limit)), total = t[collection].length, hasMore = offset + rows.length < total
    return { kind: 'task_history', workspaceId, taskId, revision: w.revision, collection, rows, page: { total, hasMore, nextCursor: hasMore ? `${w.revision}:${offset + rows.length}` : null } }
  }
  /** A trusted self-hosted runner receives only its designated task/evidence. */
  authenticateAi(workspaceId: string, token: string): WorkActor {
    this.ready(); id(workspaceId)
    if (!/^wwai_[a-f0-9]{64}$/.test(token)) fail(401, 'unauthorized', 'AI reviewer credential required')
    const w = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    const hash = createHash('sha256').update(token).digest('hex')
    const grant = w?.aiCredentials?.find(c => c.tokenHash === hash && c.expiresAt > Date.now())
    if (!w || !grant || !this.memberCanWrite(grant.issuedBy) || !w.workspace.memberIds.includes(grant.issuedBy) || !w.workspace.managerIds.includes(grant.issuedBy)) fail(401, 'unauthorized', 'AI reviewer credential expired or revoked')
    const actor: WorkActor = { memberId: grant.issuedBy, role: 'member', agentId: grant.agentId }
    this.aiActors.set(actor, { workspaceId, hash })
    return actor
  }
  readAiTask(workspaceId: string, taskId: string, actor: WorkActor) {
    this.ready(); id(taskId)
    const w = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    if (!w) fail(404, 'not_found', 'Review task not found')
    this.assertAi(w, actor)
    this.authorized(w, actor)
    const t = w.tasks.find(t => t.id === taskId)
    if (!t || !actor.agentId || !t.reviewPolicy.aiReviewerIds.includes(actor.agentId) || t.reviewPolicy.mode === 'human' || t.status !== 'in_review') fail(403, 'forbidden', 'No pending review assigned to this AI')
    return { kind: 'ai_review_task', workspaceId, revision: w.revision, task: clone({ ...t, submissions: t.submissions.slice(-1), decisions: t.decisions.filter(d => d.submissionVersion === t.submissionVersion) }) }
  }
  provisionAi(raw: unknown, actor: WorkActor) {
    this.ready()
    const p = bag(raw), workspaceId = id(p.workspaceId), agentId = id(p.agentId), commandId = id(p.commandId)
    if (Object.keys(p).some(k => !['workspaceId', 'agentId', 'commandId', 'expectedRevision', 'expiresAt', 'revoke'].includes(k)) || (p.revoke !== undefined && typeof p.revoke !== 'boolean')) fail(400, 'invalid', 'Invalid AI reviewer credential request')
    const current = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    if (!current) fail(404, 'not_registered', 'Workspace not registered')
    this.manager(current, actor)
    // The original secret is deliberately unrecoverable; make lost-response
    // replay explicit before the older revision produces a generic conflict.
    if (current.receipts.some(r => r.actorId === actor.memberId && r.commandId === commandId)) fail(409, 'credential_already_issued', 'Credential command already committed; rotate with a new command identifier if the response was lost')
    if (p.expectedRevision !== current.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh before provisioning')
    const next = { ...this.disk, workspaces: this.disk.workspaces.map(w => w === current ? clone(w) : w) }, w = next.workspaces.find(w => w.workspaceId === workspaceId)
    if (!w) fail(404, 'not_registered', 'Workspace not registered')
    this.manager(w, actor)
    if (w.receipts.some(r => r.actorId === actor.memberId && r.commandId === commandId)) fail(409, 'credential_already_issued', 'Credential command already committed; rotate with a new command identifier if the response was lost')
    if (p.expectedRevision !== w.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh before provisioning')
    const expiresAt = p.revoke === true ? Date.now() : p.expiresAt
    if (p.revoke !== true && (!Number.isSafeInteger(expiresAt) || Number(expiresAt) <= Date.now() || Number(expiresAt) > Date.now() + 30 * 86400000)) fail(400, 'invalid', 'Credential expiry must be within 30 days')
    const token = `wwai_${randomBytes(32).toString('hex')}`
    w.aiCredentials = (w.aiCredentials ?? []).filter(c => c.agentId !== agentId && c.expiresAt > Date.now())
    if (p.revoke !== true) w.aiCredentials.push({ agentId, issuedBy: actor.memberId, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: Number(expiresAt) })
    if (w.aiCredentials.length > 1000) fail(409, 'capacity', 'AI reviewer credential capacity reached')
    w.revision++; w.events.push({ id: commandId, revision: w.revision, actorId: actor.memberId, action: p.revoke === true ? 'revokeAiReviewer' : 'provisionAiReviewer', entityId: agentId, at: Date.now() }); w.receipts.push({ actorId: actor.memberId, commandId, fingerprint: 'ai-credential' })
    if (w.events.length > 100_000) fail(409, 'capacity', 'Audit capacity reached; existing evidence was retained')
    this.persist(next); this.disk = next
    try { this.changed?.(workspaceId, [...w.workspace.memberIds]) } catch { /* committed state remains authoritative; reconnect rereads */ }
    return { kind: 'ai_reviewer_credential', workspaceId, revision: w.revision, agentId, expiresAt, token: p.revoke === true ? null : token }
  }
  command(raw: unknown, actor: WorkActor): WorkSnapshot {
    this.ready()
    if (!this.memberCanWrite(actor.memberId) || !['admin', 'member'].includes(actor.role)) fail(403, 'forbidden', 'Active writer membership required')
    const request = bag(raw), workspaceId = id(request.workspaceId), commandId = id(request.commandId), action = text(request.action, 64, true), p = bag(request.payload)
    if (!['registerWorkspace', 'setWorkspaceMembers', 'updateProfile', 'setDepartment', 'createTask', 'claimTask', 'startTask', 'releaseTask', 'requestHelp', 'submitTask', 'reviewTask', 'reassignTask', 'cancelTask', 'setTaskReviewPolicy'].includes(action)) fail(400, 'invalid_action', 'Unknown workspace work action')
    if (actor.agentId && action !== 'reviewTask') fail(403, 'forbidden', 'AI reviewer credentials permit review decisions only')
    const receiptActor = actor.agentId ? `ai:${actor.agentId}` : actor.memberId
    const fingerprint = createHash('sha256').update(JSON.stringify({ action, payload: p })).digest('hex')
    const current = this.disk.workspaces.find(w => w.workspaceId === workspaceId)
    if (current) {
      this.authorized(current, actor); this.assertAi(current, actor)
      const receipt = current.receipts.find(r => r.actorId === receiptActor && r.commandId === commandId)
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'Command identifier was already used'); return this.snapshot(current, actor, { limit: 1 }) }
      if (request.expectedRevision !== current.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh before trying again')
    }
    // Do not clone unrelated private workspaces, and refuse stale/unauthorized
    // requests before allocating a potentially large evidence copy.
    const next = { ...this.disk, workspaces: this.disk.workspaces.map(w => w === current ? clone(w) : w) }
    let w = next.workspaces.find(v => v.workspaceId === workspaceId)
    const oldMemberIds = [...(w?.workspace.memberIds ?? [])]
    if (w) {
      this.authorized(w, actor)
      this.assertAi(w, actor)
      const receipt = w.receipts.find(r => r.actorId === receiptActor && r.commandId === commandId)
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'Command identifier was already used'); return this.snapshot(w, actor, { limit: 1 }) }
      if (request.expectedRevision !== w.revision) fail(409, 'revision_conflict', 'Workspace changed; refresh before trying again')
    } else {
      if (action !== 'registerWorkspace') fail(404, 'not_registered', 'Workspace work is not registered')
      if (actor.role !== 'admin') fail(403, 'forbidden', 'Bridge administrator must register an explicit shared workspace')
      if (request.expectedRevision !== undefined && request.expectedRevision !== 0) fail(409, 'revision_conflict', 'Registration expects revision zero')
      if (next.workspaces.length >= 1000) fail(409, 'capacity', 'Workspace capacity reached')
      const members = memberIds(p.memberIds), managers = memberIds(p.managerIds)
      if (managers.length > 100) fail(400, 'invalid', 'At most 100 managers per workspace')
      if (!members.includes(actor.memberId) || !managers.includes(actor.memberId) || managers.some(v => !members.includes(v) || !this.memberCanWrite(v)) || members.some(v => !this.memberExists(v))) fail(400, 'invalid_member', 'Explicit active members and non-viewer registering manager required')
      w = { workspaceId, revision: 0, workspace: { name: text(p.name, 200, true), memberIds: members, managerIds: managers }, profiles: [], departments: [], tasks: [], events: [], receipts: [] }
      next.workspaces.push(w)
    }
    let entityId: string | null = null
    if (action === 'registerWorkspace') { if (w.revision !== 0) fail(409, 'exists', 'Workspace already registered') }
    else if (action === 'setWorkspaceMembers') {
      this.manager(w, actor)
      const members = memberIds(p.memberIds), managers = memberIds(p.managerIds)
      if (managers.length > 100) fail(400, 'invalid', 'At most 100 managers per workspace')
      if (!managers.length || managers.some(v => !members.includes(v) || !this.memberCanWrite(v)) || members.some(v => !this.memberExists(v))) fail(400, 'invalid_member', 'Active members and at least one non-viewer manager required')
      w.workspace.memberIds = members; w.workspace.managerIds = managers
      // Grants are removed immediately. Historic task/evidence authorship is retained.
      w.departments.forEach(d => { d.memberIds = d.memberIds.filter(v => members.includes(v)); d.reviewerIds = d.reviewerIds.filter(v => members.includes(v)); if (d.leadId && !members.includes(d.leadId)) d.leadId = null; if (d.backupId && !members.includes(d.backupId)) d.backupId = null })
      w.profiles = w.profiles.filter(v => members.includes(v.memberId))
    } else if (action === 'updateProfile') {
      entityId = actor.memberId
      const profile: WorkProfile = { memberId: actor.memberId, title: text(p.title, 200), responsibilities: text(p.responsibilities, 4000), skills: strings(p.skills, 50), languages: strings(p.languages, 30), availability: text(p.availability, 500), timezone: text(p.timezone ?? '', 100), workHours: text(p.workHours ?? '', 1000), requestedDepartmentIds: strings(p.requestedDepartmentIds, 100).map(id) }
      if (profile.requestedDepartmentIds.some(v => !w!.departments.some(d => d.id === v))) fail(400, 'invalid', 'Unknown department')
      w.profiles = [...w.profiles.filter(v => v.memberId !== actor.memberId), profile]
    } else if (action === 'setDepartment') {
      this.manager(w, actor); entityId = id(p.id)
      const members = this.members(w, p.memberIds), reviewers = this.members(w, p.reviewerIds)
      if (members.length > 500 || reviewers.length > 500) fail(400, 'invalid', 'At most 500 members or reviewers per department')
      const leadId = p.leadId === null ? null : memberId(p.leadId), backupId = p.backupId === null ? null : memberId(p.backupId)
      if ((leadId && !members.includes(leadId)) || (backupId && !members.includes(backupId))) fail(400, 'invalid', 'Department leads must be assigned members')
      const department: WorkDepartment = { id: entityId, name: text(p.name, 200, true), floorId: text(p.floorId, 128), leadId, backupId, memberIds: members, reviewerIds: reviewers, responsibilities: text(p.responsibilities, 4000) }
      w.departments = [...w.departments.filter(d => d.id !== entityId), department]
      if (w.departments.length > 1000) fail(409, 'capacity', 'Department capacity reached')
    } else if (action === 'createTask') {
      this.manager(w, actor); entityId = id(p.id)
      if (w.tasks.some(t => t.id === entityId)) fail(409, 'exists', 'Task already exists')
      if (w.tasks.length >= 10_000) fail(409, 'capacity', 'Task capacity reached; no history was removed')
      const policy = bag(p.reviewPolicy), modes = ['human', 'ai', 'ai_then_human', 'both']
      if (!modes.includes(String(policy.mode)) || typeof policy.independent !== 'boolean') fail(400, 'invalid', 'Invalid review policy')
      const reviewPolicy: ReviewPolicy = { mode: policy.mode as ReviewPolicy['mode'], independent: policy.independent, humanReviewerIds: this.members(w, policy.humanReviewerIds), aiReviewerIds: strings(policy.aiReviewerIds, 100).map(id) }
      if (reviewPolicy.humanReviewerIds.length > 100) fail(400, 'invalid', 'At most 100 human reviewers per task')
      if ((reviewPolicy.mode === 'human' && reviewPolicy.aiReviewerIds.length) || (reviewPolicy.mode === 'ai' && reviewPolicy.humanReviewerIds.length)) fail(400, 'invalid', 'Reviewer lists must match the chosen review mode')
      if (reviewPolicy.mode !== 'ai' && !reviewPolicy.humanReviewerIds.length) fail(400, 'invalid', 'Human reviewer required')
      if (reviewPolicy.mode !== 'human' && !reviewPolicy.aiReviewerIds.length) fail(400, 'invalid', 'AI reviewer required')
      if (reviewPolicy.aiReviewerIds.some(agentId => !this.activeAi(w!, agentId))) fail(400, 'invalid_ai_reviewer', 'Choose an active registered AI reviewer for this workspace')
      const assigneeId = p.assigneeId === null ? null : this.members(w, [p.assigneeId])[0]
      if (reviewPolicy.independent && assigneeId && reviewPolicy.humanReviewerIds.includes(assigneeId)) fail(400, 'invalid', 'Independent reviewer cannot be the assignee')
      const departmentId = p.departmentId === null ? null : id(p.departmentId)
      if (departmentId && !w.departments.some(d => d.id === departmentId)) fail(400, 'invalid', 'Unknown department')
      if (p.dueAt !== null && (!Number.isSafeInteger(p.dueAt) || Number(p.dueAt) < 0)) fail(400, 'invalid', 'Invalid due date')
      const now = Date.now()
      w.tasks.push({ id: entityId, title: text(p.title, 300, true), description: text(p.description, 12000), departmentId, assigneeId, assignmentVersion: 0, createdBy: actor.memberId, status: 'open', reviewPolicy, dueAt: p.dueAt as number | null, submissionVersion: 0, submissions: [], decisions: [], helpRequest: null, createdAt: now, updatedAt: now })
    } else {
      entityId = id(p.taskId)
      const task = w.tasks.find(t => t.id === entityId)
      if (!task) fail(404, 'not_found', 'Task not found')
      const own = () => { if (task.assigneeId !== actor.memberId) fail(403, 'forbidden', 'Task assignee required') }
      if (action === 'setTaskReviewPolicy') {
        this.manager(w, actor)
        if (['completed', 'cancelled'].includes(task.status)) fail(409, 'state_conflict', 'Final task review policy cannot change')
        try { storedPolicy(p.reviewPolicy) } catch { fail(400, 'invalid', 'Invalid replacement review policy') }
        const incoming = bag(p.reviewPolicy)
        const humanReviewerIds = this.members(w, incoming.humanReviewerIds), aiReviewerIds = strings(incoming.aiReviewerIds, 100).map(id)
        if (aiReviewerIds.some(agentId => !this.activeAi(w!, agentId))) fail(400, 'invalid_ai_reviewer', 'Choose an active registered AI reviewer for this workspace')
        if (incoming.independent && task.assigneeId && humanReviewerIds.includes(task.assigneeId)) fail(400, 'invalid', 'Independent reviewer cannot be assignee')
        task.reviewPolicy = { mode: incoming.mode as ReviewPolicy['mode'], humanReviewerIds, aiReviewerIds, independent: incoming.independent as boolean }
        // Never reinterpret already-submitted approvals under replacement reviewers.
        if (task.status === 'in_review') { task.status = 'changes_requested'; task.helpRequest = 'Review policy changed. Submit a new evidence revision for the updated reviewers.' }
      } else if (action === 'reassignTask' || action === 'cancelTask') {
        this.manager(w, actor)
        if (['completed', 'cancelled'].includes(task.status)) fail(409, 'state_conflict', 'Final task cannot be changed')
        if (action === 'cancelTask') { task.status = 'cancelled'; task.helpRequest = text(p.reason, 4000, true) }
        else { const assignee = p.assigneeId === null ? null : this.members(w, [p.assigneeId])[0]; if (assignee && task.reviewPolicy.independent && task.reviewPolicy.humanReviewerIds.includes(assignee)) fail(400, 'invalid', 'Independent reviewer cannot own task'); task.assignmentVersion++; task.assigneeId = assignee; task.status = 'open'; task.helpRequest = null }
      } else if (action === 'claimTask') {
        if (task.status !== 'open' || (task.assigneeId && task.assigneeId !== actor.memberId)) fail(409, 'state_conflict', 'Task is not available to claim')
        if (task.reviewPolicy.independent && task.reviewPolicy.humanReviewerIds.includes(actor.memberId)) fail(403, 'forbidden', 'Independent reviewer cannot claim this task')
        if (task.assigneeId !== actor.memberId) task.assignmentVersion++
        task.assigneeId = actor.memberId; task.status = 'claimed'
      } else if (action === 'startTask') {
        own(); if (!['claimed', 'blocked', 'changes_requested'].includes(task.status)) fail(409, 'state_conflict', 'Task must be claimed before starting'); task.status = 'in_progress'; task.helpRequest = null
      } else if (action === 'releaseTask') {
        own(); if (!['claimed', 'in_progress', 'blocked', 'changes_requested'].includes(task.status)) fail(409, 'state_conflict', 'Task cannot be released in this state'); task.assignmentVersion++; task.assigneeId = null; task.status = 'open'; task.helpRequest = null
      } else if (action === 'requestHelp') {
        own(); if (!['claimed', 'in_progress', 'blocked', 'changes_requested'].includes(task.status)) fail(409, 'state_conflict', 'Task cannot request help in this state'); task.helpRequest = text(p.reason, 4000, true); task.status = 'blocked'
      } else if (action === 'submitTask') {
        own(); if (!['in_progress', 'changes_requested'].includes(task.status)) fail(409, 'state_conflict', 'Task must be started before submission')
        if (task.submissions.length >= 1000) fail(409, 'capacity', 'Submission history limit reached')
        task.submissionVersion++; task.submissions.push({ version: task.submissionVersion, submittedBy: actor.memberId, submittedAt: Date.now(), evidence: text(p.evidence, 16000, true) }); task.status = 'in_review'; task.helpRequest = null
      } else if (action === 'reviewTask') {
        const reviewerKind = actor.agentId ? 'ai' : 'human', reviewerId = actor.agentId ?? actor.memberId
        if (p.reviewerKind !== reviewerKind) fail(403, 'ai_authority_unavailable', 'AI decisions require an authenticated execution authority; user sessions cannot impersonate AI')
        if (task.status !== 'in_review' || p.submissionVersion !== task.submissionVersion) fail(409, 'evidence_conflict', 'Review must target the current submitted evidence')
        const rp = task.reviewPolicy
        if (reviewerKind === 'human' && (!rp.humanReviewerIds.includes(reviewerId) || rp.mode === 'ai' || (rp.independent && task.submissions.at(-1)?.submittedBy === reviewerId))) fail(403, 'forbidden', 'Designated independent reviewer required')
        if (reviewerKind === 'ai' && (!rp.aiReviewerIds.includes(reviewerId) || rp.mode === 'human')) fail(403, 'forbidden', 'Designated AI reviewer required')
        if (reviewerKind === 'human' && rp.mode === 'ai_then_human' && !rp.aiReviewerIds.every(v => task.decisions.some(d => d.submissionVersion === task.submissionVersion && d.reviewer.kind === 'ai' && d.reviewer.id === v && d.outcome === 'approve'))) fail(409, 'review_order', 'AI review must complete first')
        if (p.outcome !== 'approve' && p.outcome !== 'changes_requested') fail(400, 'invalid', 'Invalid review outcome')
        if (task.decisions.some(d => d.submissionVersion === task.submissionVersion && d.reviewer.kind === reviewerKind && d.reviewer.id === reviewerId)) fail(409, 'already_reviewed', 'Reviewer already decided on this submission')
        const execution = reviewerKind === 'ai' ? { runId: id(bag(p.execution).runId), model: text(bag(p.execution).model, 200, true) } : undefined
        task.decisions.push({ id: commandId, submissionVersion: task.submissionVersion, reviewer: { kind: reviewerKind, id: reviewerId }, outcome: p.outcome, reasoning: text(p.reasoning, 4000, true), decidedAt: Date.now(), ...(execution ? { execution } : {}) })
        if (p.outcome === 'changes_requested') task.status = 'changes_requested'
        else {
          const decisions = task.decisions.filter(d => d.submissionVersion === task.submissionVersion && d.outcome === 'approve')
          const humanDone = rp.humanReviewerIds.every(v => decisions.some(d => d.reviewer.kind === 'human' && d.reviewer.id === v))
          const aiDone = rp.aiReviewerIds.every(v => decisions.some(d => d.reviewer.kind === 'ai' && d.reviewer.id === v))
          if ((rp.mode === 'ai' || humanDone) && (rp.mode === 'human' || aiDone)) task.status = 'completed'
        }
      } else fail(400, 'invalid_action', 'Unknown workspace work action')
      task.updatedAt = Date.now()
    }
    w.revision++
    w.events.push({ id: commandId, revision: w.revision, actorId: receiptActor, action, entityId, at: Date.now() })
    w.receipts.push({ actorId: receiptActor, commandId, fingerprint })
    if (w.events.length > 100_000) fail(409, 'capacity', 'Audit capacity reached; existing evidence was retained')
    this.persist(next)
    this.disk = next
    try { this.changed?.(workspaceId, [...new Set([...oldMemberIds, ...w.workspace.memberIds])], action) } catch { /* committed state remains authoritative; reconnect rereads */ }
    // Removing one's own grant must not return the now-inaccessible snapshot.
    if (!w.workspace.memberIds.includes(actor.memberId)) return { workspaceId, revision: w.revision, kind: 'snapshot', actor: { memberId: actor.memberId, canManage: false }, workspace: { name: '', memberIds: [], managerIds: [] }, profiles: [], departments: [], tasks: [], events: [], pages: { profiles: {total:0,hasMore:false,nextCursor:null}, departments:{total:0,hasMore:false,nextCursor:null},tasks:{total:0,hasMore:false,nextCursor:null},events:{total:0,hasMore:false,nextCursor:null} }, capabilities: { version: 1, aiReviewSubmission: true, aiReviewExecution: false, durableWorkflowResume: false } }
    return this.snapshot(w, actor, { limit: 1 })
  }
  private persist(next: Disk) {
    retainIndependentCheckpoint(this.dir,'workspace-work.json')
    const serialized = this.key ? encryptJsonFile(this.key, next) : JSON.stringify(next)
    if (Buffer.byteLength(serialized) > 32_000_000) fail(409, 'capacity', 'Workspace work storage capacity reached')
    const temp = `${this.path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let fd: number | undefined
    let committed = false
    try {
      fd = openSync(temp, 'wx', 0o600); writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temp, this.path); committed = true
      fd = openSync(this.dir, 'r'); fsyncSync(fd); closeSync(fd); fd = undefined
    } catch {
      // An uncertain rename/fsync outcome cannot safely accept a later command.
      if (committed) this.unavailable = true
      fail(503, 'storage_failure', 'Workspace work could not be durably saved; retry after checking storage')
    } finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp) } catch { /* already renamed / absent */ } }
  }
}
