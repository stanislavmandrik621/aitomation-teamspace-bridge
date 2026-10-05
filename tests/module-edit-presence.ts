import assert from 'node:assert/strict'
import { liveModuleEditLeases, parseModuleEditTarget, updateModuleEditLeases } from '../src/module-edit-presence.js'
import { buildPresenceSnapshot } from '../src/presence.js'

const now = Date.now()
const target = { leaseId: 'window-1-editor-1', entityId: 'entity-1', viewId: 'view-1', recordId: 'record-1', fieldSlug: 'title' }
assert.deepEqual(parseModuleEditTarget({ ...target, value: 'private cell', memberId: 'forged', expiresAt: Infinity }), target)
for (const bad of [null, [], { ...target, entityId: 'a\0b' }, { ...target, fieldSlug: '__proto__' }, { ...target, viewId: 'x'.repeat(129) }]) assert.equal(parseModuleEditTarget(bad), null)
let leases = updateModuleEditLeases([], target, true, now)
leases = updateModuleEditLeases(leases, { ...target, leaseId: 'window-2-editor-1' }, true, now)
assert.equal(leases.length, 2, 'concurrent windows retain independent leases')
leases = updateModuleEditLeases(leases, target, false, now)
assert.equal(leases.length, 1, 'one editor closing cannot clear another')
assert.equal(liveModuleEditLeases(leases, now + 30_001).length, 0, 'crashed editors expire')
assert.equal(liveModuleEditLeases([{ ...target, expiresAt: now + 99_000 }], now).length, 0, 'future expiry cannot pin a ghost editor')
const snapshot = buildPresenceSnapshot([{ memberId: 'm1', deviceId: 'd1', displayName: 'Alice', role: 'member' as const, lastSeen: now, editing: leases, avatarRef: 'a'.repeat(64) }])
assert.equal(snapshot[0].editing?.length, 1)
assert.equal(snapshot[0].avatarRef, 'a'.repeat(64))
console.log('module edit presence: lease isolation, privacy projection, expiry, and roster metadata passed')
