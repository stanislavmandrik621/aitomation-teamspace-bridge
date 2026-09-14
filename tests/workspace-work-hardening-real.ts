/** Real on-disk corruption/scale/revocation regression. No patched fs or fake provider. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { WorkspaceWorkStore, WorkspaceWorkError, type WorkActor } from '../src/workspace-work.js'
const dir = mkdtempSync(join(tmpdir(), 'workspace-work-hardening-'))
const roles = new Map([['admin', 'admin'], ['worker', 'member'], ['reviewer', 'member']])
const admin: WorkActor = { memberId: 'admin', role: 'admin' }, worker: WorkActor = { memberId: 'worker', role: 'member' }
const exists = (v: string) => roles.has(v), writer = (v: string) => ['admin', 'member'].includes(roles.get(v) ?? '')
const store = new WorkspaceWorkStore(dir, null, exists, writer)
let revision = 0
const command = (action: string, payload: unknown, actor = admin) => { const result = store.command({ workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, action, payload }, actor); revision = result.revision; return result }
const rejects = (code: string, action: () => unknown) => assert.throws(action, e => e instanceof WorkspaceWorkError && e.code === code)
try {
  command('registerWorkspace', { name: 'Hardening', memberIds: ['admin', 'worker', 'reviewer'], managerIds: ['admin'] })
  const issuance = { workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, agentId: 'ai', expiresAt: Date.now() + 60000 }
  const grant = store.provisionAi(issuance, admin); revision = grant.revision
  rejects('credential_already_issued', () => store.provisionAi(issuance, admin))
  rejects('invalid', () => store.provisionAi({ workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, agentId: 'ai', expiresAt: Date.now() + 60000, revoke: 'true' }, admin))
  assert.equal(store.authenticateAi('w', grant.token!).agentId, 'ai', 'malformed revocation must not rotate the credential')
  command('createTask', { id: 't', title: 'Task', description: '', assigneeId: 'worker', departmentId: null, dueAt: null, reviewPolicy: { mode: 'ai', humanReviewerIds: [], aiReviewerIds: ['ai'], independent: true } })
  command('claimTask', { taskId: 't' }, worker); command('startTask', { taskId: 't' }, worker); command('submitTask', { taskId: 't', evidence: 'Evidence' }, worker)
  const ai = store.authenticateAi('w', grant.token!)
  const decision = { workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, action: 'reviewTask', payload: { taskId: 't', reviewerKind: 'ai', submissionVersion: 1, outcome: 'approve', reasoning: 'Protocol authorization only', execution: { runId: 'r', model: 'no-inference-test' } } }
  revision = store.command(decision, ai).revision
  const rotate = store.provisionAi({ workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, agentId: 'ai', expiresAt: Date.now() + 60000 }, admin); revision = rotate.revision
  rejects('unauthorized', () => store.command(decision, ai))
  rejects('unauthorized', () => store.authenticateAi('w', grant.token!))
  const fresh = store.authenticateAi('w', rotate.token!)
  roles.set('admin', 'viewer')
  rejects('forbidden', () => store.command(decision, fresh))
  assert.equal(store.read('w', worker).aiReviewers?.[0].active, false)
  roles.set('admin', 'admin')
  roles.set('worker', 'viewer')
  rejects('forbidden', () => command('updateProfile', {}, worker))
  roles.set('worker', 'member')
  const revokeOnly = store.provisionAi({ workspaceId: 'w', commandId: randomUUID(), expectedRevision: revision, agentId: 'unused-agent', revoke: true }, admin)
  revision = revokeOnly.revision
  assert.equal(revokeOnly.token, null, 'revocation does not require or produce a fresh credential')

  command('createTask', { id: 'reassign', title: 'Task', description: '', assigneeId: 'worker', departmentId: null, dueAt: null, reviewPolicy: { mode: 'human', humanReviewerIds: ['reviewer'], aiReviewerIds: [], independent: true } })
  const before = store.read('w', worker, { taskId: 'reassign' }).tasks[0]
  assert.equal(before.assignmentVersion, 0)
  command('reassignTask', { taskId: 'reassign', assigneeId: null }); command('reassignTask', { taskId: 'reassign', assigneeId: 'worker' })
  const after = store.read('w', worker, { taskId: 'reassign' }).tasks[0]
  assert.equal(after.assignmentVersion, 2, 'ABA assignment changes are durably distinguishable')
  command('claimTask', { taskId: 'reassign' }, worker); command('startTask', { taskId: 'reassign' }, worker); command('submitTask', { taskId: 'reassign', evidence: 'Policy revision evidence' }, worker)
  roles.set('reviewer', 'viewer')
  rejects('invalid_member', () => command('setTaskReviewPolicy', { taskId: 'reassign', reviewPolicy: { mode: 'human', humanReviewerIds: ['reviewer'], aiReviewerIds: [], independent: true } }))
  command('setTaskReviewPolicy', { taskId: 'reassign', reviewPolicy: { mode: 'human', humanReviewerIds: ['admin'], aiReviewerIds: [], independent: true } })
  assert.equal(store.read('w', worker, { taskId: 'reassign' }).tasks[0].status, 'changes_requested', 'replacement policy requires fresh evidence; old decisions cannot transfer')
  roles.set('reviewer', 'member')
  const reopened = new WorkspaceWorkStore(dir, null, exists, writer)
  assert.equal(reopened.read('w', worker, { taskId: 'reassign' }).tasks[0].assignmentVersion, 2)
  const pristine = JSON.parse(readFileSync(join(dir, 'workspace-work.json'), 'utf8'))
  const mutations: Array<(w: any) => void> = [
    w => { w.tasks[0].submissions[0].version = 0 },
    w => { w.tasks[0].decisions[0].reviewer.kind = 'administrator' },
    w => { w.tasks[0].decisions[0].submissionVersion = 99 },
    w => { w.tasks[0].secretToken = 'unknown-field-must-not-leak' },
    w => { w.events[1].revision = 88 },
    w => { w.receipts.pop() },
    w => { w.aiCredentials[0].tokenHash = 'plaintext-token' },
    w => { w.workspace.managerIds = ['outside'] },
    w => { w.tasks[0].status = 'completed-and-ignore-validation' },
    w => { w.tasks[1].status = 'completed' },
  ]
  for (const mutate of mutations) {
    const corruption = mkdtempSync(join(tmpdir(), 'workspace-work-deep-corruption-'))
    try { const data = structuredClone(pristine); mutate(data.workspaces[0]); const raw = JSON.stringify(data); writeFileSync(join(corruption, 'workspace-work.json'), raw); const damaged = new WorkspaceWorkStore(corruption, null, exists, writer); rejects('unavailable', () => damaged.read('w', admin)); assert.equal(readFileSync(join(corruption, 'workspace-work.json'), 'utf8'), raw) }
    finally { rmSync(corruption, { recursive: true, force: true }) }
  }

  // Construct a valid near-capacity file with retained evidence, then measure actual
  // page work and exercise refusal without deleting or truncating the evidence.
  const bigDir = mkdtempSync(join(tmpdir(), 'workspace-work-capacity-'))
  try {
    const big = structuredClone(pristine), w = big.workspaces[0]
    w.tasks = [0, 1].map(index => ({ ...structuredClone(w.tasks[1]), id: `large-${index}`, status: 'in_review', submissionVersion: 990, submissions: Array.from({ length: 990 }, (_, i) => ({ version: i + 1, submittedBy: 'worker', submittedAt: 1, evidence: 'x'.repeat(15900) })), decisions: [] }))
    let raw = JSON.stringify(big)
    // Add valid bounded profiles to approach the real 32MB ceiling.
    while (Buffer.byteLength(raw) < 31_995_000) {
      const i = w.profiles.length
      w.profiles.push({ memberId: `profile-${i}`, title: '', responsibilities: 'x'.repeat(4000), skills: [], languages: [], availability: '', timezone: '', workHours: '', requestedDepartmentIds: [] })
      w.workspace.memberIds.push(`profile-${i}`)
      raw = JSON.stringify(big)
    }
    assert.ok(Buffer.byteLength(raw) < 32_000_000)
    writeFileSync(join(bigDir, 'workspace-work.json'), raw)
    const openStart = performance.now(), large = new WorkspaceWorkStore(bigDir, null, exists, writer), openMs = performance.now() - openStart
    const pageStart = performance.now(), page = large.read('w', admin, { taskId: 'large-1', limit: 1 }), pageMs = performance.now() - pageStart
    assert.equal(page.tasks[0].historyCounts?.submissions, 990); assert.equal(page.tasks[0].submissions.length, 1)
    rejects('capacity', () => large.command({ workspaceId: 'w', commandId: randomUUID(), expectedRevision: w.revision, action: 'updateProfile', payload: { title: 'x'.repeat(200), responsibilities: 'x'.repeat(4000), skills: Array.from({ length: 50 }, (_, i) => `${i}${'x'.repeat(100)}`), languages: [], availability: '', timezone: '', workHours: '', requestedDepartmentIds: [] } }, admin))
    assert.equal(readFileSync(join(bigDir, 'workspace-work.json'), 'utf8'), raw, 'capacity refusal preserves exact evidence file')
    console.log(`Near-capacity real file ${Buffer.byteLength(raw)} bytes: load ${openMs.toFixed(1)}ms; targeted page ${pageMs.toFixed(1)}ms. Synchronous persistence remains a documented scaling limit.`)
  } finally { rmSync(bigDir, { recursive: true, force: true }) }
  console.log('PASS deep corruption fail-closed, revoked/rotated AI replay, assignment ABA, metadata secrecy and real storage-capacity preservation')
} finally { rmSync(dir, { recursive: true, force: true }) }
