/**
 * Plan L Presence - pure roster helpers.
 */
import assert from 'node:assert/strict'
import {
  PRESENCE_SNAPSHOT_MAX,
  buildPresenceSnapshot,
  memberHasOtherLiveSocket,
  normalizePresencePeer,
  uniqueOnlineMemberIds,
} from '../src/presence.js'

assert.equal(normalizePresencePeer({
  memberId: 'm1',
  displayName: '  Alex  ',
  role: 'member',
  deviceId: 'd1',
  lastSeen: 100,
})?.displayName, 'Alex')

assert.equal(normalizePresencePeer({
  memberId: '',
  displayName: 'x',
  role: 'member',
  deviceId: 'd1',
}), null)

const snap = buildPresenceSnapshot([
  { memberId: 'm2', displayName: 'Bob', role: 'admin', deviceId: 'd2', lastSeen: 2 },
  { memberId: 'm1', displayName: 'Alex', role: 'member', deviceId: 'd1', lastSeen: 1 },
  { memberId: 'm1', displayName: 'Alex', role: 'member', deviceId: 'd1b', lastSeen: 3 },
])
assert.equal(snap.length, 3)
assert.equal(snap[0]?.displayName, 'Alex')
assert.deepEqual(uniqueOnlineMemberIds(snap).sort(), ['m1', 'm2'])

assert.equal(memberHasOtherLiveSocket([{ memberId: 'm1' }], 'm1'), true)
assert.equal(memberHasOtherLiveSocket([{ memberId: 'm2' }], 'm1'), false)

const many = Array.from({ length: PRESENCE_SNAPSHOT_MAX + 10 }, (_, i) => ({
  memberId: `m${i}`,
  displayName: `U${i}`,
  role: 'member' as const,
  deviceId: `d${i}`,
  lastSeen: i,
}))
assert.equal(buildPresenceSnapshot(many).length, PRESENCE_SNAPSHOT_MAX)

console.log('presence: ok')
