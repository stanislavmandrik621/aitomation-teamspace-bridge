import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, hashSessionToken, memberDeviceAckKey } from '../src/store.js'
const dir = mkdtempSync(join(tmpdir(), 'shared-device-acks-'))
const day = 86_400_000
const now = Date.now()
const originalNow = Date.now
try {
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'team', createdAt: 1, name: 'Test' }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify(['alice', 'bob'].map((memberId, i) => ({
    memberId, email: `${memberId}@example.test`, displayName: memberId, role: i === 0 ? 'admin' : 'member',
    sessions: { workstation: hashSessionToken(`${memberId}-token`) }, sessionLastSeen: { workstation: now - day }, createdAt: i + 1,
  }))))
  // The old hardware-only receipt cannot prove which person received this op.
  writeFileSync(join(dir, 'acks.json'), JSON.stringify({ workstation: { legacy: now - 2 * day } }))
  const store = new BridgeStore(dir, 1, null, null)
  assert.equal(store.hasAcked('workstation', 'legacy', 'alice'), false)
  assert.equal(store.hasAcked('workstation', 'legacy', 'bob'), false)
  store.markAcked('workstation', ['ambiguous'])
  assert.equal(store.hasAcked('workstation', 'ambiguous', 'alice'), false)
  assert.equal(store.hasAcked('workstation', 'ambiguous', 'bob'), false)
  store.markAcked('workstation', ['op-one'], 'alice')
  assert.equal(store.hasAcked('workstation', 'op-one', 'alice'), true)
  assert.equal(store.hasAcked('workstation', 'op-one', 'bob'), false)
  assert.equal(store.findMember('bob')!.sessionLastSeen!.workstation, now - day, 'Alice cannot keep Bob’s session artificially active')
  store.markAcked('workstation', ['forged'], 'missing')
  assert.equal(store.hasAcked('workstation', 'forged', 'missing'), false)
  store.flushAcksPersist()
  const restarted = new BridgeStore(dir, 1, null, null)
  assert.equal(restarted.deviceAckCount('workstation', 'alice'), 1)
  assert.equal(restarted.deviceAckCount('workstation', 'bob'), 0)
  assert.notEqual(memberDeviceAckKey('a:b', 'c'), memberDeviceAckKey('a', 'b:c'))
  restarted.appendOp({ opId: 'op-one', kind: 'record.create', targetId: 'record', originDevice: 'source', originMemberId: 'source-member', hlc: `${now - 3 * day}-0-source`, patch: {}, protocolVersion: 1 } as any)
  Date.now = () => now + 2 * day
  assert.equal(await restarted.pruneOps(), 0, 'Alice’s receipt cannot satisfy Bob’s prune quorum')
  restarted.markAcked('workstation', ['op-one'], 'bob')
  restarted.flushAcksPersist()
  Date.now = () => now + 4 * day
  assert.equal(await restarted.pruneOps(), 1, 'both independent receipts permit retention pruning')
  restarted.appendOp({ opId: 'join-race', kind: 'record.create', targetId: 'record-join', originDevice: 'source', hlc: `${now}-0-source`, patch: {}, protocolVersion: 1 } as any)
  restarted.markAcked('workstation', ['join-race'], 'alice')
  restarted.markAcked('workstation', ['join-race'], 'bob')
  restarted.flushAcksPersist()
  Date.now = () => now + 6 * day
  const pruning = restarted.pruneOps()
  const invite = restarted.createInvite('alice', 'new-member@example.test', 'member')
  assert.equal(invite.ok, true)
  if (!invite.ok) throw new Error(invite.reason)
  assert.equal((await restarted.redeemInvite({ token: invite.invite.token, deviceId: 'new-device' })).ok, true)
  assert.equal(await pruning, 0, 'a concurrent join invalidates the old retention quorum')
  assert.equal((await restarted.readRecentOps()).some(op => op.opId === 'join-race'), true)
  restarted.markAcked('workstation', ['new'], 'alice')
  restarted.markAcked('workstation', ['new'], 'bob')
  restarted.flushAcksPersist()
  assert.equal(restarted.revokeSession({ actorMemberId: 'alice', targetMemberId: 'bob', deviceId: 'workstation' }).ok, true)
  assert.equal(restarted.hasAcked('workstation', 'new', 'alice'), true)
  assert.equal(restarted.hasAcked('workstation', 'new', 'bob'), false)
  const disk = JSON.parse(readFileSync(join(dir, 'acks.json'), 'utf8'))
  assert.equal(disk[memberDeviceAckKey('bob', 'workstation')], undefined)
  console.log('Shared device ACKs: legacy replay, independent receipt/count/last-seen, restart, member quorum, concurrent join and scoped revocation passed')
} finally { Date.now = originalNow; rmSync(dir, { recursive: true, force: true }) }
