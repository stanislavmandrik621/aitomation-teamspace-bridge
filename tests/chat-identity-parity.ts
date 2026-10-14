/** Cross-runtime wire identity invariants for ordinary and temporary chat. */
import assert from 'node:assert/strict'
import * as bridge from '../src/ephemeral-chat.js'
import * as desktop from '../../../apps/desktop/src/lib/teamspace-ephemeral-chat.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'

const members = ['a', 'b', 'a_b', 'a', 'b_c', 'mem_0123456789abcdef', 'mem_second', 'A', 'z'.repeat(128), 'x'.repeat(128)]
const pairs = new Map<string, string>()
for (const a of members) for (const b of members) {
  const room = bridge.ephemeralRoomId(a, b)
  assert.equal(room, desktop.ephemeralRoomId(a, b), 'bridge and desktop must mint the same wire identity')
  if (a === b) { assert.equal(room, null); continue }
  assert.ok(room)
  assert.deepEqual(bridge.parseEphemeralRoomId(room), { ok: true, room })
  assert.deepEqual(desktop.parseEphemeralRoomId(room), { ok: true, room })
  assert.equal(bridge.ephemeralPeerMemberId(room, a), b)
  assert.equal(desktop.ephemeralPeerMemberId(room, a), b)
  const identity = JSON.stringify([a, b].sort())
  assert.ok(!pairs.has(room) || pairs.get(room) === identity, 'different member pairs cannot collide')
  pairs.set(room, identity)
}
assert.notEqual(bridge.ephemeralRoomId('a_b', 'c'), bridge.ephemeralRoomId('a', 'b_c'))
for (const input of ['eph:b_a', ' eph:g:abcd1234\0 ', 'eph:mem_a.mem_b', 'eph:g:', 'eph:a_b_c', 'eph:a.a', null]) {
  assert.deepEqual(bridge.parseAnyEphemeralRoomId(input), desktop.parseAnyEphemeralRoomId(input))
  assert.equal(bridge.isEphemeralGroupRoomId(input), desktop.isEphemeralGroupRoomId(input))
}
assert.equal(bridge.validateEphemeralGroupTargetMemberIds('initiator', ['x'.repeat(129), 'second'], 12).ok, false,
  'an oversized member ID must be refused, not truncated onto another identity')
console.log('chat identity parity: underscore IDs, pair collisions, 128-character members, legacy pairs and group normalization passed')

const dir = mkdtempSync(join(tmpdir(), 'chat-exact-selectors-'))
const history = new ChatStore(dir, 90)
try {
  const id = 'm'.repeat(128), room = 'chat:team'
  const input = { id, room, body: 'retain me', memberId: 'author', memberName: 'Author', role: 'member' as const }
  assert.ok(!('error' in await history.append(input)))
  await history.pinMessage(room, id, true)
  for (const alias of [`${id}x`, `${id}\0suffix`]) {
    assert.ok('error' in await history.append({ ...input, id: alias }))
    assert.equal(await history.findById(alias, room), null)
    assert.ok('error' in await history.edit(alias, 'author', 'must not edit', false, room))
    assert.ok('error' in await history.react(alias, 'author', '👍', false, room))
    assert.ok('error' in await history.softDelete(alias, 'author', room))
    assert.ok('error' in await history.authorUnsend(alias, 'author', false, room))
    assert.ok('error' in await history.pinMessage(room, alias, true))
    assert.ok('error' in await history.unpinMessage(room, alias, true), 'invalid named unpin cannot become legacy unpin-newest')
  }
  assert.equal((await history.findById(id, room))?.body, 'retain me')
  assert.deepEqual(history.getPinnedMessageIds(room), [id])
  console.log('chat exact selectors: NUL/overlength append/edit/react/delete/unsend/pin/unpin aliases refused without mutating original message')
} finally { history.flushAllPendingChatIndexes(); rmSync(dir, { recursive: true, force: true }) }
