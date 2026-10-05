/** Real encrypted member/work/monitor storage and real durable task transitions.
 * No fake model, network, IPC, clock, filesystem, or task implementation. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import { encryptJsonFile } from '../src/at-rest.js'
import { WorkspaceWorkError, WorkspaceWorkStore } from '../src/workspace-work.js'
import { WorkspaceCoordinatorMonitor } from '../src/workspace-coordinator-monitor.js'
import { sanitizeCoordinatorMonitorState } from '../../../apps/desktop/electron/modules-sync/workspace-coordinator-monitor-ipc.js'

const dir = mkdtempSync(join(tmpdir(), 'coordinator-monitor-real-')), key = { key: randomBytes(32) }
writeFileSync(join(dir, 'members.json'), encryptJsonFile(key, ['manager', 'worker', 'reviewer', 'other', 'viewer'].map(memberId => ({ memberId, email: `${memberId}@example.test`, displayName: memberId, role: memberId === 'manager' ? 'admin' : memberId === 'viewer' ? 'viewer' : 'member', createdAt: 1, sessions: { [`${memberId}-device`]: hashSessionToken(`${memberId}-test-token`) } }))))
const members = new BridgeStore(dir, 30, key)
const currentMember = (id: string) => { const member = members.findMember(id); return member ? { memberId: member.memberId, role: member.role } : null }
let work = new WorkspaceWorkStore(dir, key, id => !!currentMember(id), id => ['admin', 'member'].includes(currentMember(id)?.role ?? ''))
let monitor = new WorkspaceCoordinatorMonitor(dir, key, work, currentMember), revision = 0
function command(action: string, payload: unknown, memberId = 'manager') {
  const result = work.command({ workspaceId: 'ws', action, payload, commandId: randomUUID(), expectedRevision: revision }, currentMember(memberId)!)
  revision = result.revision
  return result
}
function create(id: string, assigneeId: string | null = 'worker', dueAt: number | null = null) {
  command('createTask', { id, title: `Confidential work ${id}`, description: 'Private objective', departmentId: null, assigneeId, dueAt, reviewPolicy: { mode: 'human', humanReviewerIds: ['reviewer'], aiReviewerIds: [], independent: true } })
}
function rejects(code: string, fn: () => unknown) { assert.throws(fn, e => e instanceof WorkspaceWorkError && e.code === code) }
try {
  command('registerWorkspace', { name: 'Private work', memberIds: ['manager', 'worker', 'reviewer', 'viewer'], managerIds: ['manager'] })
  assert.equal(monitor.read('ws', 'worker').enabled, false, 'opt-in is required')
  rejects('forbidden', () => monitor.configure('ws', 'other', true))
  rejects('forbidden', () => monitor.configure('ws', 'viewer', true))
  create('blocked', 'worker', Date.now() - 1000)
  command('claimTask', { taskId: 'blocked' }, 'worker'); command('startTask', { taskId: 'blocked' }, 'worker'); command('requestHelp', { taskId: 'blocked', reason: 'Needs decision' }, 'worker')
  const enabled = monitor.configure('ws', 'worker', true)
  assert.equal(enabled.enabled, true)
  assert.deepEqual(enabled.attention.map(a => a.kind), ['blocked', 'overdue'])
  assert.equal(monitor.read('ws', 'reviewer').enabled, false, 'one member cannot opt in another')
  assert.equal(readFileSync(join(dir, 'workspace-coordinator-monitor.json'), 'utf8').includes('worker'), false, 'existing at-rest encryption applies to opt-in identity')
  assert.equal(readFileSync(join(dir, 'workspace-coordinator-monitor.json'), 'utf8').includes('Confidential'), false, 'task content is not copied to the preference ledger')
  monitor.stop()
  work = new WorkspaceWorkStore(dir, key, id => !!currentMember(id), id => ['admin', 'member'].includes(currentMember(id)?.role ?? ''))
  monitor = new WorkspaceCoordinatorMonitor(dir, key, work, currentMember)
  const restored = monitor.read('ws', 'worker')
  assert.deepEqual(restored.attention, enabled.attention, 'restart restores opt-in and rebuilds stable attention from durable tasks')
  assert.equal(restored.enabled, true)
  monitor.start(); monitor.start(); await delay(20)
  monitor.stop()
  assert.deepEqual(monitor.read('ws', 'worker').attention, restored.attention, 'repeated passes do not duplicate attention')

  create('ready')
  command('claimTask', { taskId: 'ready' }, 'worker'); command('startTask', { taskId: 'ready' }, 'worker'); command('submitTask', { taskId: 'ready', evidence: 'Actual test submission' }, 'worker')
  const reviewer = monitor.configure('ws', 'reviewer', true)
  assert.ok(reviewer.attention.some(a => a.taskId === 'ready' && a.kind === 'review_needed'))
  command('reviewTask', { taskId: 'ready', reviewerKind: 'human', submissionVersion: 1, outcome: 'changes_requested', reasoning: 'Need more evidence' }, 'reviewer')
  assert.ok(monitor.read('ws', 'worker').attention.some(a => a.taskId === 'ready' && a.kind === 'changes_requested'))
  assert.equal(monitor.read('ws', 'reviewer').attention.some(a => a.kind === 'review_needed'), false)
  command('submitTask', { taskId: 'ready', evidence: 'Added measurements' }, 'worker')
  command('reviewTask', { taskId: 'ready', reviewerKind: 'human', submissionVersion: 2, outcome: 'approve', reasoning: 'Measurements verified' }, 'reviewer')
  assert.equal(monitor.read('ws', 'worker').attention.some(a => a.taskId === 'ready'), false, 'completed work leaves active attention')

  const dueAt = Date.now() + 80
  create('upcoming', 'worker', dueAt)
  assert.equal(monitor.read('ws', 'worker').attention.some(a => a.taskId === 'upcoming'), false)
  await delay(Math.max(1, dueAt - Date.now() + 10))
  assert.ok(monitor.read('ws', 'worker').attention.some(a => a.taskId === 'upcoming' && a.kind === 'overdue'), 'time alone activates overdue work without a work revision')

  create('reviewer-lost')
  command('claimTask', { taskId: 'reviewer-lost' }, 'worker'); command('startTask', { taskId: 'reviewer-lost' }, 'worker'); command('submitTask', { taskId: 'reviewer-lost', evidence: 'Review pending' }, 'worker')
  monitor.configure('ws', 'manager', true)
  assert.equal(monitor.read('ws', 'manager').attention.some(a => a.kind === 'reviewer_unavailable'), false)
  assert.equal(members.setMemberRole({ actorMemberId: 'manager', targetMemberId: 'reviewer', role: 'viewer' }).ok, true)
  assert.ok(monitor.read('ws', 'manager').attention.some(a => a.kind === 'reviewer_unavailable'), 'role downgrade invalidates a cached briefing without work revision')
  assert.equal(monitor.read('ws', 'reviewer').enabled, false, 'downgrade removes persisted opt-in')
  assert.equal(members.setMemberRole({ actorMemberId: 'manager', targetMemberId: 'reviewer', role: 'member' }).ok, true)
  assert.equal(monitor.read('ws', 'reviewer').enabled, false, 're-upgrade requires opt-in again')

  for (let i = 0; i < 53; i++) create(`unassigned-${i}`, null, Date.now() - 1)
  const briefing = monitor.read('ws', 'manager')
  assert.ok(briefing.total > 100)
  assert.equal(briefing.attention.length, 100)
  assert.equal(briefing.truncated, true)
  assert.equal(new Set(briefing.attention.map(a => a.id)).size, briefing.attention.length)
  const wire = sanitizeCoordinatorMonitorState({ ...briefing, secret: 'must-not-cross' }, { workspaceId: 'ws', memberId: 'manager' })
  assert.equal(Object.hasOwn(wire, 'secret'), false)
  assert.throws(() => sanitizeCoordinatorMonitorState(briefing, { workspaceId: 'other', memberId: 'manager' }))
  assert.throws(() => sanitizeCoordinatorMonitorState(briefing, { workspaceId: 'ws', memberId: 'worker' }))
  assert.throws(() => sanitizeCoordinatorMonitorState({ ...briefing, truncated: false }, { workspaceId: 'ws', memberId: 'manager' }))
  assert.equal(monitor.read('ws', 'worker').attention.some(a => a.kind === 'unassigned'), false, 'manager-wide planning does not become an unrelated member alert')

  const moved = `${dir}-moved`
  renameSync(dir, moved)
  try { rejects('storage_failure', () => monitor.configure('ws', 'worker', false)) }
  finally { renameSync(moved, dir) }
  assert.equal(monitor.read('ws', 'worker').enabled, true, 'failed durable disable does not report success')
  command('setWorkspaceMembers', { memberIds: ['manager', 'reviewer', 'viewer'], managerIds: ['manager'] })
  rejects('forbidden', () => monitor.read('ws', 'worker'))
  command('setWorkspaceMembers', { memberIds: ['manager', 'worker', 'reviewer', 'viewer'], managerIds: ['manager'] })
  assert.equal(monitor.read('ws', 'worker').enabled, false, 'revoked workspace opt-in does not silently reactivate')
  monitor.configure('ws', 'worker', true)
  assert.equal(members.kickMember('manager', 'worker').ok, true)
  rejects('forbidden', () => monitor.read('ws', 'worker'))
  monitor.stop()
  const corrupt = '{invalid-storage'
  writeFileSync(join(dir, 'workspace-coordinator-monitor.json'), corrupt)
  const broken = new WorkspaceCoordinatorMonitor(dir, key, work, currentMember)
  rejects('unavailable', () => broken.configure('ws', 'manager', false))
  assert.equal(readFileSync(join(dir, 'workspace-coordinator-monitor.json'), 'utf8'), corrupt, 'corruption fails closed without resetting opt-ins')
  console.log('PASS: encrypted monitor opt-in/restart, real task lifecycle and due timer, current review/role gates, full pagination/truncation, desktop projection, persistence failure, revocation and corrupt-store refusal')
} finally { monitor.stop(); rmSync(dir, { recursive: true, force: true }) }
