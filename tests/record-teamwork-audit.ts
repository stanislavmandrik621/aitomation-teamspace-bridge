import assert from 'node:assert/strict'
import { applyRecordTeamworkCommand, emptyRecordTeamwork, recordTeamworkAfterWrite, recordTeamworkChanges } from '../src/record-teamwork-state.js'
import type { RecordTeamworkAuthority } from '../src/record-teamwork-state.js'
import type { RecordTeamworkCommand, RecordTeamworkEvent } from '../src/record-teamwork-types.js'
const authority: RecordTeamworkAuthority = { actor: { id: 'alice', name: 'Alice', kind: 'member' }, teamId: 'team', canWrite: true, canConfigure: true, validateMember: () => {}, validateConfig: () => {}, validateHandoff: () => {} }
let state = emptyRecordTeamwork(), serial = 0
const events: RecordTeamworkEvent[] = []
function act(command: RecordTeamworkCommand) {
 const before = structuredClone(state)
 const next = applyRecordTeamworkCommand(state, state.revision, command, authority, { id: String(++serial), at: new Date().toISOString() })
 assert.deepEqual(state, before, 'Preparing history cannot mutate the prior state')
 assert.equal(next.event.recordRevision, state.recordRevision)
 assert.equal(next.event.revision, state.revision + 1)
 state = next.state; events.push(next.event); return next.event
}
const configured = act({ action: 'configure', config: { assigneeFieldId: 'owner', statusFieldId: 'status', completedStatusValues: ['done'], reviewRequired: true, reviewerMemberIds: ['alice'] } })
assert.deepEqual(configured.changes?.map(c => c.field), ['config'])
assert.equal(configured.changes?.[0].before, null)
act({ action: 'handoff', to: { id: 'bob', label: 'Bob', kind: 'member', teamId: 'team' }, note: 'Please implement' })
const handed = act({ action: 'handoff', to: { id: 'alice', label: 'Alice', kind: 'member', teamId: 'team' }, note: 'Returning for review' })
const handoff = handed.changes?.find(c => c.field === 'handoff')
assert.equal(handoff?.before?.to.label, 'Bob'); assert.equal(handoff?.after?.to.label, 'Alice')
act({ action: 'request_help', note: 'Need test data' })
const resolved = act({ action: 'resolve_help' }).changes?.find(c => c.field === 'help')
assert.equal(resolved?.before?.state, 'open'); assert.equal(resolved?.after?.state, 'resolved')
assert.equal(resolved?.after?.note, 'Need test data')
act({ action: 'submit_result', note: 'First submission' })
const longNote = 'Result 🧪 '.repeat(1500)
const result = act({ action: 'submit_result', note: longNote }).changes?.find(c => c.field === 'result')
assert.equal(result?.before?.note, 'First submission'); assert.equal(result?.after?.note, longNote.trim())
assert.equal(result?.after?.submittedBy.name, 'Alice')
act({ action: 'request_review', note: 'Ready for review' })
const approval = act({ action: 'approve', note: 'Tests verified' })
assert.equal(approval.changes?.find(c => c.field === 'review')?.before?.state, 'pending')
assert.equal(approval.changes?.find(c => c.field === 'review')?.after?.state, 'approved')
const invalidated = recordTeamworkAfterWrite(state, false)
const delta = recordTeamworkChanges(state, invalidated)
assert.deepEqual(delta.map(c => c.field), ['review'])
assert.equal(delta[0].before && (delta[0].before as any).state, 'approved')
assert.equal(delta[0].after && (delta[0].after as any).state, 'none')
const persisted = JSON.stringify(events)
state.result!.note = 'Later content'; state.config!.reviewerMemberIds.push('later'); authority.actor.name = 'Renamed later'
assert.equal(JSON.stringify(events), persisted, 'Stored before/after values are immutable copies')
assert(!persisted.includes('Later content')); assert(!persisted.includes('Renamed later'))
console.log('PASS teamwork audit: configuration, previous/new assignees, help resolution, full Unicode submissions, review decisions, invalidation, content version and immutable history')
