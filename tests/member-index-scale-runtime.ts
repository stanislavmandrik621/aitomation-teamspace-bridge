import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { BridgeStore, hashSessionToken, type MemberRow } from '../src/store.js'
const dir = mkdtempSync(join(tmpdir(), 'bridge-members-50k-'))
const tokens = Array.from({ length: 50_000 }, (_, i) => `member-session-${i}-secret`)
const rows: MemberRow[] = tokens.map((token, i) => ({ memberId: `member-${i}`, email: `member-${i}@example.test`, displayName: `Member ${i}`, role: i === 0 ? 'admin' : 'member', sessions: { [`device-${i}`]: hashSessionToken(token) }, createdAt: Date.now() }))
rows[1]!.sessions['shared-device'] = hashSessionToken('shared-session-1')
rows[2]!.sessions['shared-device'] = hashSessionToken('shared-session-2')
try {
  writeFileSync(join(dir, 'members.json'), JSON.stringify(rows))
  const started = performance.now()
  const store = new BridgeStore(dir, 21, null)
  assert.equal(store.listMembersPage({ limit: 500, offset: 49_500 }).members.length, 500)
  assert.equal(store.listMembersPage().total, 50_000)
  assert.equal(store.findBySession(tokens[49_999]!)?.member.memberId, 'member-49999')
  const loadAndIndexMs = performance.now() - started
  const sample = (fn: (i: number) => void) => { const start = performance.now(); for (let i = 0; i < 20_000; i++) fn(i); return performance.now() - start }
  const memberLookupMs = sample(i => assert.equal(store.findMember(`member-${i}`)?.memberId, `member-${i}`))
  const sessionLookupMs = sample(i => assert.equal(store.findBySession(tokens[(i * 7919) % 50_000]!)?.member.memberId, `member-${(i * 7919) % 50_000}`))
  const invalidLookupMs = sample(i => assert.equal(store.findBySession(`wrong-${i}`), null))
  assert.equal(store.findBySession(hashSessionToken(tokens[49999]!)), null)
  const late = Promise.resolve().then(() => store.findBySession(tokens[49999]!))
  assert.equal(store.revokeSession({ actorMemberId: 'member-0', targetMemberId: 'member-49999', deviceId: 'device-49999' }).ok, true)
  assert.equal(await late, null, 'later request observes revocation')
  assert.equal(store.setMemberRole({ actorMemberId: 'member-0', targetMemberId: 'member-49998', role: 'viewer' }).ok, true)
  assert.equal(store.findBySession(tokens[49998]!)?.member.role, 'viewer')
  assert.equal(store.kickMember('member-0', 'member-49997').ok, true)
  assert.equal(store.findMember('member-49997'), undefined)
  assert.equal(store.findBySession(tokens[49997]!), null)
  assert.equal(store.leaveTeam('member-49996').ok, true)
  assert.equal(store.findBySession(tokens[49996]!), null)
  const blocker = join(dir, `members.json.${process.pid}.tmp`)
  mkdirSync(blocker)
  assert.throws(() => store.setMemberRole({ actorMemberId: 'member-0', targetMemberId: 'member-49998', role: 'admin' }))
  assert.equal(store.findBySession(tokens[49998]!)?.member.role, 'viewer', 'failed write restores durable role')
  assert.throws(() => store.revokeSession({ actorMemberId: 'member-0', targetMemberId: 'member-49995' }))
  assert.equal(store.findBySession(tokens[49995]!)?.member.memberId, 'member-49995', 'failed revoke preserves durable session')
  rmSync(blocker, { recursive: true })
  // A physical device id can be shared by multiple member identities. Pin
  // the ack to the still-authorized owner so revoking the other member's
  // session cannot erase or ambiguously attribute it.
  store.markAcked('shared-device', ['shared-ack'], 'member-2'); store.flushAcksPersist()
  assert.equal(store.revokeSession({ actorMemberId: 'member-0', targetMemberId: 'member-1', deviceId: 'shared-device' }).ok, true)
  assert.equal(store.findBySession('shared-session-1'), null)
  assert.equal(store.findBySession('shared-session-2')?.member.memberId, 'member-2')
  assert.equal(store.hasAcked('shared-device', 'shared-ack', 'member-2'), true)
  store.markAcked('device-49999', ['late-revoked-ack'])
  assert.equal(store.hasAcked('device-49999', 'late-revoked-ack'), false)
  const invite = store.createInvite('member-0', 'new@example.test', 'member')
  assert.ok(invite.ok)
  const redeemed = await store.redeemInvite({ token: invite.invite.token, deviceId: 'new-device', displayName: 'New' })
  assert.ok(redeemed.ok)
  assert.equal(store.findBySession(redeemed.sessionToken)?.deviceId, 'new-device')
  const replacementInvite = store.createInvite('member-0', 'new@example.test', 'viewer')
  assert.ok(replacementInvite.ok)
  const replaced = await store.redeemInvite({ token: replacementInvite.invite.token, deviceId: 'replacement-device', displayName: 'New' })
  assert.ok(replaced.ok)
  assert.equal(store.findBySession(redeemed.sessionToken), null)
  assert.equal(store.findBySession(replaced.sessionToken)?.member.role, 'viewer')
  const reopened = new BridgeStore(dir, 21, null)
  assert.equal(reopened.findBySession(tokens[49999]!), null)
  assert.equal(reopened.findBySession(tokens[49998]!)?.member.role, 'viewer')
  assert.equal(reopened.findBySession(replaced.sessionToken)?.deviceId, 'replacement-device')
  console.log(JSON.stringify({ registeredMembers: 50_000, iterationsPerBenchmark: 20_000, loadAndIndexMs, memberLookupMs, sessionLookupMs, invalidLookupMs }))
  console.log('member index scale runtime: 50k roster, wrong/digest/revoked tokens, late request, roles, kick, leave, real disk failure rollback, redeem/replacement, shared-device acks and reopen passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
