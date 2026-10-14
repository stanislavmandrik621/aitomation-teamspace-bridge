/** File and directory fsync bound room ACKs; an uncertain rename never serves stale grants. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRoomsStore } from '../src/chat-rooms-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'

const root = fs.mkdtempSync(join(tmpdir(), 'chat-rooms-fsync-'))
const originalSync = fs.fsyncSync
const originalRename = fs.renameSync
let count = 0
try {
  for (const action of ['admit', 'redeem', 'remove', 'ban', 'close', 'invite'] as const) {
    for (const failure of ['file', 'directory', 'rename-completed'] as const) {
      const dir = join(root, `${action}-${failure}`)
      fs.mkdirSync(dir)
      const store = new ChatRoomsStore(dir, null)
      const created = store.createGroup({ kind: 'private', title: action, createdBy: 'owner', memberIds: ['member'] })
      assert.ok(!('error' in created))
      const invite = store.mintInviteToken(created.id)
      assert.ok(!('error' in invite))
      const path = join(dir, 'chat', 'rooms.json'), before = fs.readFileSync(path)
      const held = store.get(created.id)!, heldBefore = structuredClone(held)
      let failOnce = true
      fs.fsyncSync = ((fd: number) => {
        if (failure !== 'rename-completed' && failOnce && fs.fstatSync(fd).isDirectory() === (failure === 'directory')) {
          failOnce = false
          throw Object.assign(new Error(`injected ${failure} fsync EIO`), { code: 'EIO' })
        }
        return originalSync(fd)
      }) as typeof fs.fsyncSync
      fs.renameSync = ((from, to) => {
        originalRename(from, to)
        if (failure === 'rename-completed' && failOnce && String(to) === path) {
          failOnce = false
          throw Object.assign(new Error('injected completed rename EIO'), { code: 'EIO' })
        }
      }) as typeof fs.renameSync
      syncBuiltinESMExports()
      const mutate = (target: ChatRoomsStore) => {
        if (action === 'admit') return target.admitMember(created.id, 'joining')
        if (action === 'redeem') return target.redeemInvite(invite.token, 'joining', created.id)
        if (action === 'remove') return target.removeMembers(created.id, ['member'], 'owner')
        if (action === 'ban') return target.banMember(created.id, 'member', 'owner')
        if (action === 'close') return target.closeRoom(created.id)
        return target.mintInviteToken(created.id)
      }
      const result = mutate(store)
      assert.ok('error' in result, `${action}/${failure} cannot ACK`)
      assert.equal(failOnce, false, 'the requested fsync boundary was reached')
      fs.fsyncSync = originalSync; fs.renameSync = originalRename; syncBuiltinESMExports()
      assert.equal(fs.existsSync(`${path}.${process.pid}.tmp`), false, 'owned failed temporary file is cleaned')
      if (failure === 'file') {
        assert.deepEqual(fs.readFileSync(path), before, 'pre-rename failure preserves known durable state')
        assert.deepEqual(held, heldBefore, 'pre-rename failure restores retained views')
        assert.equal(store.memberCanAccess(created.id, 'member'), true)
        assert.ok(!('error' in mutate(store)), 'healthy pre-rename retry is available')
      } else {
        const installed = fs.readFileSync(path)
        assert.notDeepEqual(installed, before, 'new complete registry is visible despite uncertain rename durability')
        assert.match(result.error, /uncertain.*restart/i)
        assert.equal(store.memberCanAccess(created.id, 'member'), false)
        assert.equal(store.memberCanAccess(created.id, 'joining'), false)
        assert.equal(store.memberCanAccess(CHAT_ROOM_TEAM, 'owner'), false, 'team-room fast path must also fail closed')
        assert.equal(store.get(created.id), null)
        assert.deepEqual(store.listAllOpenRooms(), [])
        assert.ok(store.listForMemberWithHonesty('owner').error)
        assert.deepEqual(held.memberIds, [])
        assert.deepEqual(held.ownerIds, [])
        assert.ok(held.closedAt)
        assert.equal(held.inviteHash, null)
        assert.equal(store.verifyPassword(created.id, ''), false)
        assert.ok('error' in mutate(store), 'automatic retry cannot overwrite an uncertain registry')
        assert.deepEqual(fs.readFileSync(path), installed)
      }
      const restarted = new ChatRoomsStore(dir, null)
      assert.equal(restarted.memberCanAccess(CHAT_ROOM_TEAM, 'owner'), true)
      const restored = restarted.get(created.id)!
      assert.ok(restored)
      if (action === 'admit' || action === 'redeem') assert.ok(restored.memberIds.includes('joining'))
      if (action === 'remove' || action === 'ban') assert.equal(restored.memberIds.includes('member'), false)
      if (action === 'ban') assert.ok(restored.bannedMemberIds.includes('member'))
      if (action === 'close') assert.ok(restored.closedAt)
      if (action === 'redeem' || action === 'invite') assert.ok('error' in restarted.redeemInvite(invite.token, 'other', created.id))
      count++
    }
  }
  // A healthy ACK observes both syncs, in the required order, including invitation consumption.
  const positive = new ChatRoomsStore(join(root, 'positive'), null), syncs: string[] = []
  fs.fsyncSync = ((fd: number) => { syncs.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return originalSync(fd) }) as typeof fs.fsyncSync
  syncBuiltinESMExports()
  const room = positive.createGroup({ kind: 'private', title: 'Positive', createdBy: 'owner', memberIds: [] })
  assert.ok(!('error' in room))
  assert.deepEqual(syncs.splice(0), ['file', 'directory'])
  const invitation = positive.mintInviteToken(room.id)
  assert.ok(!('error' in invitation))
  assert.deepEqual(syncs.splice(0), ['file', 'directory'])
  assert.ok(!('error' in positive.redeemInvite(invitation.token, 'joining', room.id)))
  assert.deepEqual(syncs.splice(0), ['file', 'directory'], 'nested consume/admit has one complete durable checkpoint')
  console.log(`chat room fsync durability: ${count} pre/post-rename failures, retained-view denial, restart and ordered healthy ACK cases passed`)
} finally {
  fs.fsyncSync = originalSync; fs.renameSync = originalRename; syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
