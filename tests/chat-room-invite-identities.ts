/** Room authority selectors are exact; failed batches never partially grant/revoke. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRoomsStore } from '../src/chat-rooms-store.js'

const root = mkdtempSync(join(tmpdir(), 'chat-invite-identities-'))
try {
  const rooms = new ChatRoomsStore(root, null), path = join(root, 'chat', 'rooms.json')
  const long = 'm'.repeat(128)
  const created = rooms.createGroup({ kind: 'private', title: 'Exact identities', createdBy: 'owner', memberIds: ['alice', 'bob', long] })
  assert.ok(!('error' in created))
  const room = created.id
  assert.ok(!('error' in rooms.promoteOwner(room, 'alice')))
  assert.ok(!('error' in rooms.banMember(room, 'banned', 'owner')))
  let cases = 0
  function refusesWithoutMutation(run: () => unknown) {
    const before = readFileSync(path), snapshot = structuredClone(rooms.get(room))
    assert.ok('error' in (run() as object))
    assert.deepEqual(readFileSync(path), before)
    assert.deepEqual(rooms.get(room), snapshot)
    cases++
  }
  for (const invalid of ['alice\0', ' alice', 'alice ', `${long}x`, ['alice'], { toString: () => 'alice' }, '\ud800'] as any[]) {
    refusesWithoutMutation(() => rooms.addMembers(room, ['new', invalid]))
    refusesWithoutMutation(() => rooms.removeMembers(room, ['bob', invalid], 'owner'))
    refusesWithoutMutation(() => rooms.promoteOwner(room, invalid))
    refusesWithoutMutation(() => rooms.demoteOwner(room, invalid))
    refusesWithoutMutation(() => rooms.banMember(room, invalid, 'owner'))
    refusesWithoutMutation(() => rooms.unbanMember(room, invalid))
    refusesWithoutMutation(() => rooms.admitMember(room, invalid))
    refusesWithoutMutation(() => rooms.leave(room, invalid))
    refusesWithoutMutation(() => rooms.getOrCreateDm('owner', invalid))
    refusesWithoutMutation(() => rooms.createGroup({ kind: 'group', title: 'Invalid', createdBy: 'owner', memberIds: [invalid] }))
  }
  for (const alias of [`${room}\0`, ` ${room}`, `${room} `]) {
    assert.equal(rooms.get(alias), null)
    refusesWithoutMutation(() => rooms.addMembers(alias, ['new']))
    refusesWithoutMutation(() => rooms.removeMembers(alias, ['bob'], 'owner'))
    refusesWithoutMutation(() => rooms.promoteOwner(alias, 'bob'))
    refusesWithoutMutation(() => rooms.banMember(alias, 'bob', 'owner'))
  }
  refusesWithoutMutation(() => rooms.removeMembers(room, ['bob'], 'owner\0'))
  refusesWithoutMutation(() => rooms.banMember(room, 'not-yet-member', 'owner\0'))
  const tooMany = Array.from({ length: 51 }, (_, n) => `new-${n}`)
  refusesWithoutMutation(() => rooms.addMembers(room, tooMany))
  refusesWithoutMutation(() => rooms.removeMembers(room, ['bob', ...tooMany], 'owner'))
  const token = rooms.mintInviteToken(room)
  assert.ok(!('error' in token))
  refusesWithoutMutation(() => rooms.redeemInvite(token.token, 'banned', room))
  refusesWithoutMutation(() => rooms.redeemInvite(token.token, 'new\0', room))
  assert.ok(!('error' in rooms.unbanMember(room, 'banned')))
  assert.ok(!('error' in rooms.redeemInvite(token.token, 'banned', room)), 'ban refusal did not consume invitation')
  assert.ok(!('error' in rooms.getOrCreateDm('owner', long)), 'full 128-character opaque ID preserved')
  assert.ok(!('error' in rooms.removeMembers(room, [long], 'owner')))
  assert.ok(!('error' in rooms.addMembers(room, [long])))
  assert.ok(rooms.get(room)!.memberIds.includes(long))
  const large = rooms.createGroup({ kind: 'group', title: 'Large trim', createdBy: 'owner', memberIds: [...Array.from({ length: 120 }, (_, n) => `member-${n}`), '__limits__'] })
  assert.ok(!('error' in large))
  const trimmed = rooms.trimMembersToCap(large.id, 2)
  assert.ok(!('error' in trimmed))
  assert.equal(trimmed.removed.length, 120)
  assert.deepEqual(trimmed.memberIds, ['owner', 'member-0'])
  assert.deepEqual(new ChatRoomsStore(root, null).get(large.id)!.memberIds, trimmed.memberIds)
  assert.ok(!('error' in rooms.closeRoom(room)))
  assert.ok('error' in rooms.mintInviteToken(room))
  assert.equal(rooms.verifyPassword(room, ''), false)
  console.log(`chat room exact identities: ${cases} no-mutation refusals; long-ID positives, unban retry, complete >50 limit trim and restart passed`)
} finally { rmSync(root, { recursive: true, force: true }) }
