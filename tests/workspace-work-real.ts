/** Actual durable store/crypto/filesystem; no provider/AI output is simulated. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceWorkStore, WorkspaceWorkError, type WorkActor } from '../src/workspace-work.js'

const dir = mkdtempSync(join(tmpdir(), 'workspace-work-real-'))
const members = new Set(['admin', 'worker', 'reviewer', 'other', 'viewer'])
const key = { key: randomBytes(32) }
const admin: WorkActor = { memberId: 'admin', role: 'admin' }, worker: WorkActor = { memberId: 'worker', role: 'member' }, reviewer: WorkActor = { memberId: 'reviewer', role: 'member' }
let store = new WorkspaceWorkStore(dir, key, v => members.has(v), v => members.has(v) && v !== 'viewer')
let revision = 0
function command(action: string, payload: unknown, actor = admin) { const result = store.command({ workspaceId: 'shared', commandId: randomUUID(), expectedRevision: revision, action, payload }, actor); revision = result.revision; return result }
function rejects(code: string, operation: () => unknown) { assert.throws(operation, e => e instanceof WorkspaceWorkError && e.code === code) }
function task(id: string, mode: 'human' | 'ai' | 'ai_then_human' | 'both' = 'human') {
  return command('createTask', { id, title: 'Inspect release evidence', description: 'Sensitive test evidence', departmentId: null, assigneeId: 'worker', dueAt: null, reviewPolicy: { mode, humanReviewerIds: mode === 'ai' ? [] : ['reviewer'], aiReviewerIds: mode === 'human' ? [] : ['ai-reviewer'], independent: true } })
}
try {
  command('registerWorkspace', { name: 'Explicit shared workspace', memberIds: ['admin', 'worker', 'reviewer', 'viewer'], managerIds: ['admin'] })
  rejects('forbidden', () => store.read('shared', { memberId: 'other', role: 'admin' }))
  rejects('forbidden', () => command('updateProfile', {}, { memberId: 'viewer', role: 'viewer' }))
  assert.deepEqual(store.directory({ memberId: 'other', role: 'admin' }), [])
  command('setDepartment', { id: 'safety', name: 'Safety', floorId: 'floor-safety', leadId: 'worker', backupId: null, memberIds: ['worker'], reviewerIds: ['reviewer'], responsibilities: 'Release safety' })
  rejects('invalid_member', () => command('setWorkspaceMembers', { memberIds: ['admin', 'worker', 'reviewer', 'viewer'], managerIds: ['viewer'] }))
  rejects('invalid_member', () => command('setDepartment', { id: 'bad', name: 'Bad', floorId: '', leadId: null, backupId: null, memberIds: ['worker'], reviewerIds: ['viewer'], responsibilities: '' }))
  rejects('invalid_member', () => command('createTask', { id: 'bad', title: 'Bad', description: '', departmentId: null, assigneeId: 'viewer', dueAt: null, reviewPolicy: { mode: 'human', humanReviewerIds: ['reviewer'], aiReviewerIds: [], independent: true } }))
  rejects('forbidden', () => command('setDepartment', {}, worker))
  command('updateProfile', { title: 'Inspector', responsibilities: 'Secret-profile-probe', skills: ['Inspection'], languages: ['English'], availability: 'Available', requestedDepartmentIds: ['safety'] }, worker)
  assert.equal(store.read('shared', worker).departments[0].leadId, 'worker')
  task('human-task')
  const claim = { workspaceId: 'shared', commandId: randomUUID(), expectedRevision: revision, action: 'claimTask', payload: { taskId: 'human-task' } }
  const first = store.command(claim, worker); revision = first.revision
  assert.equal(store.command(claim, worker).revision, revision, 'lost response retry is idempotent')
  rejects('idempotency_conflict', () => store.command({ ...claim, action: 'releaseTask' }, worker))
  rejects('revision_conflict', () => store.command({ ...claim, commandId: randomUUID() }, worker))
  command('startTask', { taskId: 'human-task' }, worker)
  command('submitTask', { taskId: 'human-task', evidence: 'Immutable submission v1' }, worker)
  rejects('ai_authority_unavailable', () => command('reviewTask', { taskId: 'human-task', reviewerKind: 'ai', submissionVersion: 1, outcome: 'approve', reasoning: 'Spoof' }, reviewer))
  command('reviewTask', { taskId: 'human-task', reviewerKind: 'human', submissionVersion: 1, outcome: 'changes_requested', reasoning: 'Add measurements' }, reviewer)
  command('submitTask', { taskId: 'human-task', evidence: 'Immutable submission v2 with measurements' }, worker)
  rejects('evidence_conflict', () => command('reviewTask', { taskId: 'human-task', reviewerKind: 'human', submissionVersion: 1, outcome: 'approve', reasoning: 'Stale' }, reviewer))
  command('reviewTask', { taskId: 'human-task', reviewerKind: 'human', submissionVersion: 2, outcome: 'approve', reasoning: 'Measurements verified' }, reviewer)
  assert.equal(store.read('shared', worker).tasks[0].status, 'completed')
  assert.equal(store.read('shared', worker).tasks[0].historyCounts?.submissions, 2)
  assert.equal(store.read('shared', worker).tasks[0].submissions.length, 1, 'summary explicitly exposes latest submission with history counts')

  rejects('invalid_ai_reviewer', () => task('unregistered-ai', 'ai'))
  const grant = store.provisionAi({ workspaceId: 'shared', agentId: 'ai-reviewer', commandId: randomUUID(), expectedRevision: revision, expiresAt: Date.now() + 60000 }, admin); revision = grant.revision
  assert.ok(grant.token)
  assert.deepEqual(store.read('shared', worker).aiReviewers, [{ agentId: 'ai-reviewer', expiresAt: grant.expiresAt, active: true }])
  task('both-task', 'ai_then_human')
  command('claimTask', { taskId: 'both-task' }, worker); command('startTask', { taskId: 'both-task' }, worker); command('submitTask', { taskId: 'both-task', evidence: 'Submitted inspection' }, worker)
  let ai = store.authenticateAi('shared', grant.token!)
  const pending = store.readAiTask('shared', 'both-task', ai)
  assert.equal(pending.task.submissionVersion, 1)
  rejects('forbidden', () => store.readAiTask('shared', 'human-task', ai))
  rejects('review_order', () => command('reviewTask', { taskId: 'both-task', reviewerKind: 'human', submissionVersion: 1, outcome: 'approve', reasoning: 'Too early' }, reviewer))
  // Tests authorization/state only: this is a service decision record, not a claimed AI inference.
  command('reviewTask', { taskId: 'both-task', reviewerKind: 'ai', submissionVersion: 1, outcome: 'approve', reasoning: 'Protocol authorization test receipt', execution: { runId: 'verification-run', model: 'test-protocol-only' } }, ai)
  command('reviewTask', { taskId: 'both-task', reviewerKind: 'human', submissionVersion: 1, outcome: 'approve', reasoning: 'Human approval' }, reviewer)
  assert.equal(store.read('shared', worker).tasks[1].status, 'completed')
  rejects('forbidden', () => command('createTask', {}, ai))
  assert.equal(readFileSync(join(dir, 'workspace-work.json'), 'utf8').includes(grant.token!), false)
  assert.equal(readFileSync(join(dir, 'workspace-work.json'), 'utf8').includes('Secret-profile-probe'), false)
  store = new WorkspaceWorkStore(dir, key, v => members.has(v))
  assert.equal(store.read('shared', worker).revision, revision, 'reload retains revision and evidence')
  ai = store.authenticateAi('shared', grant.token!)
  assert.equal(ai.agentId, 'ai-reviewer')

  task('race-a'); task('race-b')
  const sameRevision = revision
  const raced = await Promise.allSettled(['race-a', 'race-b'].map(taskId => Promise.resolve().then(() => store.command({ workspaceId: 'shared', commandId: randomUUID(), expectedRevision: sameRevision, action: 'claimTask', payload: { taskId } }, worker))))
  assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1, 'concurrent stale revisions have one winner')
  revision = store.read('shared', worker).revision
  const page = store.read('shared', worker, { collection: 'tasks', limit: 1 })
  assert.equal(page.tasks.length, 1); assert.equal(page.pages.tasks.hasMore, true)
  assert.equal(store.read('shared', worker, { collection: 'tasks', cursor: page.pages.tasks.nextCursor!, limit: 1 }).tasks[0].id, 'both-task')
  command('cancelTask', { taskId: 'race-b', reason: 'No longer needed' })
  rejects('revision_conflict', () => store.read('shared', worker, { collection: 'tasks', cursor: page.pages.tasks.nextCursor!, limit: 1 }))

  command('setWorkspaceMembers', { memberIds: ['worker', 'reviewer'], managerIds: ['reviewer'] })
  rejects('unauthorized', () => store.authenticateAi('shared', grant.token!))
  rejects('forbidden', () => store.command({ workspaceId: 'shared', commandId: randomUUID(), expectedRevision: revision, action: 'reviewTask', payload: { taskId: 'both-task', reviewerKind: 'ai' } }, ai))
  rejects('forbidden', () => store.read('shared', admin))
  members.delete('worker')
  rejects('forbidden', () => store.read('shared', worker))
  const moved = `${dir}-moved`
  renameSync(dir, moved)
  try {
    rejects('storage_failure', () => command('updateProfile', { title: '', responsibilities: '', skills: [], languages: [], availability: '', requestedDepartmentIds: [] }, reviewer))
    assert.equal(store.read('shared', reviewer).revision, revision, 'failed persistence never publishes mutation')
  } finally { renameSync(moved, dir) }
  const corrupted = mkdtempSync(join(tmpdir(), 'workspace-work-corrupt-'))
  try {
    writeFileSync(join(corrupted, 'workspace-work.json'), '{broken')
    const bad = new WorkspaceWorkStore(corrupted, null, () => true)
    rejects('unavailable', () => bad.directory(admin))
    assert.equal(readFileSync(join(corrupted, 'workspace-work.json'), 'utf8'), '{broken', 'corrupt data is not silently reset')
  } finally { rmSync(corrupted, { recursive: true, force: true }) }
  console.log('PASS workspace work real persistence, revisions, isolation, reviews, AI credential scope, revocation, pagination and failure recovery')
} finally { rmSync(dir, { recursive: true, force: true }) }
