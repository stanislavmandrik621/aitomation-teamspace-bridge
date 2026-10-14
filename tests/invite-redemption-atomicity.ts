import assert from 'node:assert/strict'
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BridgeStore, TEAMSPACE_INVITE_REDEEM_PENDING_MAX, TEAMSPACE_INVITE_RETRY_RECEIPTS_MAX, hashSessionToken } from '../src/store.js'
import { resolveAtRestKeyFromEnv } from '../src/at-rest.js'

if (process.argv[2] === '--crash-after-member-checkpoint') {
  const root = process.argv[3]!
  const store = new BridgeStore(root, 21, null, null)
  const original = fs.renameSync
  fs.renameSync = ((from, to) => {
    original(from, to)
    if (String(to) === join(root, 'members.json')) process.exit(73)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  await store.redeemInvite({ token: process.argv[4]!, deviceId: 'crash-device', ...(process.argv[5] ? { redemptionNonce: process.argv[5] } : {}) })
  process.exit(74)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bridge-invite-atomicity-'))
  const store = new BridgeStore(root, 21, null, null)
  const admin = store.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', memberEmail: 'admin@example.test' })
  assert.ok(admin.ok)
  const mint = (email = 'joiner@example.test', role: 'admin' | 'member' | 'viewer' = 'member') => {
    const made = store.createInvite('admin', email, role)
    assert.ok(made.ok)
    return made.invite
  }
  return { root, store, admin, mint, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function renameFailure(predicate: (from: string, to: string) => boolean) {
  const original = fs.renameSync
  fs.renameSync = ((from, to) => {
    if (predicate(String(from), String(to))) throw Object.assign(new Error('injected EIO'), { code: 'EIO' })
    return original(from, to)
  }) as typeof fs.renameSync
  syncBuiltinESMExports()
  return () => { fs.renameSync = original; syncBuiltinESMExports() }
}

test('legacy interrupted invite claim binds the complete colon-containing device identity', async () => {
  const f = fixture()
  try {
    const invite = f.mint()
    const path = join(f.root, 'invites.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    rows[0].usedAt = Date.now()
    rows[0].usedBy = 'claim:workstation:profile:abc123:nonce'
    writeFileSync(path, JSON.stringify(rows))
    const stolen = await f.store.redeemInvite({ token: invite.token, deviceId: 'workstation' })
    assert.equal(stolen.ok, false, 'a device prefix cannot finish another identity\'s claim')
    const own = await f.store.redeemInvite({ token: invite.token, deviceId: 'workstation:profile' })
    assert.ok(own.ok)
    assert.equal(Object.keys(own.member.sessions)[0], 'workstation:profile')
  } finally { f.cleanup() }
})

test('failure after members checkpoint does not turn a committed invite into an unacknowledged live bearer', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const invite = f.mint()
    restore = renameFailure((from, to) => to === join(f.root, 'invites.json')
      && JSON.parse(readFileSync(from, 'utf8')).some((row: { usedBy?: string }) => row.usedBy && !row.usedBy.startsWith('claim:')))
    const outcome = await f.store.redeemInvite({ token: invite.token, deviceId: 'join-device' })
    assert.ok(outcome.ok, 'durably committed redemption must return its bearer even if invite checkpoint fails')
    assert.equal(f.store.findBySession(outcome.sessionToken)?.member.memberId, outcome.member.memberId)
    restore()
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal(restarted.findBySession(outcome.sessionToken)?.member.memberId, outcome.member.memberId)
    assert.equal((await restarted.redeemInvite({ token: invite.token, deviceId: 'join-device' })).ok, false)
  } finally { restore(); f.cleanup() }
})

test('precommit EIO rolls back roster/session rotation and keeps only the exact-owner claim retryable', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const first = await f.store.redeemInvite({ token: f.mint().token, deviceId: 'old-device' })
    assert.ok(first.ok)
    const replacement = f.mint('joiner@example.test', 'viewer')
    restore = renameFailure((_from, to) => to === join(f.root, 'invite-redemption.pending.json'))
    await assert.rejects(f.store.redeemInvite({ token: replacement.token, deviceId: 'new:profile' }), /injected EIO/)
    assert.equal(f.store.findBySession(first.sessionToken)?.member.role, 'member')
    assert.deepEqual(Object.keys(f.store.findMember(first.member.memberId)!.sessions), ['old-device'])
    assert.equal(fs.existsSync(join(f.root, 'invite-redemption.pending.json')), false)
    const claim = JSON.parse(readFileSync(join(f.root, 'invites.json'), 'utf8')).find((row: { id: string }) => row.id === replacement.id)
    assert.match(claim.usedBy, /^claim:v2:[a-f0-9]{64}:[a-f0-9]{24}$/)
    assert.ok(!claim.usedBy.includes('new:profile'), 'claim does not embed an ambiguous delimiter-separated identity')
    restore()
    assert.equal((await f.store.redeemInvite({ token: replacement.token, deviceId: 'new' })).ok, false)
    const retry = await f.store.redeemInvite({ token: replacement.token, deviceId: 'new:profile' })
    assert.ok(retry.ok)
    assert.equal(retry.member.memberId, first.member.memberId)
    assert.equal(retry.member.role, 'viewer')
    assert.equal(f.store.findBySession(first.sessionToken), null)
  } finally { restore(); f.cleanup() }
})

test('a process exit between roster and invite checkpoints replays one committed result before authentication', () => {
  const f = fixture()
  try {
    const invite = f.mint()
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--crash-after-member-checkpoint', f.root, invite.token], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(child.status, 73, child.stderr)
    assert.ok(fs.existsSync(join(f.root, 'invite-redemption.pending.json')))
    const journal = JSON.parse(readFileSync(join(f.root, 'invite-redemption.pending.json'), 'utf8'))
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal(fs.existsSync(join(f.root, 'invite-redemption.pending.json')), false)
    assert.equal(restarted.listMembers().filter(member => member.email === 'joiner@example.test').length, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'members.json'), 'utf8')), journal.members)
    assert.deepEqual(JSON.parse(readFileSync(join(f.root, 'invites.json'), 'utf8')), journal.invites)
    assert.equal(restarted.listInvites().some(row => row.id === invite.id), false)
  } finally { f.cleanup() }
})

test('checkpoint failure cannot be followed by a kick/role mutation that an older redo restores', async () => {
  for (const mutation of ['role', 'revoke', 'kick'] as const) {
    const f = fixture()
    let restore = () => {}
    try {
      const invite = f.mint()
      restore = renameFailure((_from, to) => to === join(f.root, 'members.json'))
      const joined = await f.store.redeemInvite({ token: invite.token, deviceId: 'new-device' })
      assert.ok(joined.ok)
      assert.equal(f.store.findBySession(joined.sessionToken)?.member.memberId, joined.member.memberId)
      const mutate = () => mutation === 'role'
        ? f.store.setMemberRole({ actorMemberId: 'admin', targetMemberId: joined.member.memberId, role: 'viewer' })
        : mutation === 'revoke'
          ? f.store.revokeSession({ actorMemberId: 'admin', targetMemberId: joined.member.memberId })
          : f.store.kickMember('admin', joined.member.memberId)
      assert.throws(mutate, /injected EIO/)
      assert.equal(f.store.findBySession(joined.sessionToken)?.member.role, 'member', 'failed follow-on mutation leaves the committed state intact')
      restore()
      assert.ok(mutate().ok)
      const restarted = new BridgeStore(f.root, 21, null, null)
      if (mutation === 'role') assert.equal(restarted.findBySession(joined.sessionToken)?.member.role, 'viewer')
      else assert.equal(restarted.findBySession(joined.sessionToken), null)
      assert.equal((await restarted.redeemInvite({ token: invite.token, deviceId: 'new-device' })).ok, false)
    } finally { restore(); f.cleanup() }
  }
})

test('same-token races are single use; different invites for one email rotate one member deterministically', async () => {
  const f = fixture()
  try {
    for (const sameDevice of [false, true]) {
      const invite = f.mint(`race-${sameDevice}@example.test`)
      const outcomes = await Promise.all(Array.from({ length: 16 }, (_v, index) => f.store.redeemInvite({ token: invite.token, deviceId: sameDevice ? 'same-device' : `device-${index}` })))
      assert.equal(outcomes.filter(result => result.ok).length, 1)
    }
    const first = f.mint('SAME@example.test', 'member')
    const second = f.mint('same@example.test', 'viewer')
    const [a, b] = await Promise.all([
      f.store.redeemInvite({ token: first.token, deviceId: 'first-device' }),
      f.store.redeemInvite({ token: second.token, deviceId: 'second-device' }),
    ])
    assert.ok(a.ok && b.ok)
    assert.equal(a.member.memberId, b.member.memberId)
    assert.equal(f.store.listMembers().filter(member => member.email.toLowerCase() === 'same@example.test').length, 1)
    assert.equal(f.store.findBySession(a.sessionToken), null)
    assert.equal(f.store.findBySession(b.sessionToken)?.member.role, 'viewer')
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal(restarted.findBySession(a.sessionToken), null)
    assert.equal(restarted.findBySession(b.sessionToken)?.member.role, 'viewer')
  } finally { f.cleanup() }
})

test('admission snapshots identity before suspension and bounds same-token and distinct-token pending queues', async () => {
  const f = fixture()
  try {
    const invite = f.mint()
    const args = { token: invite.token, deviceId: 'original-device', displayName: 'Original' }
    const queued = f.store.redeemInvite(args)
    args.deviceId = 'replacement-device'
    args.token = 'invalid-token'
    const joined = await queued
    assert.ok(joined.ok)
    assert.deepEqual(Object.keys(joined.member.sessions), ['original-device'])
    for (const sameToken of [true, false]) {
      const requests = Array.from({ length: TEAMSPACE_INVITE_REDEEM_PENDING_MAX * 2 }, (_v, index) => f.store.redeemInvite({ token: sameToken ? 'missing-token' : `missing-${index}`, deviceId: 'device' }))
      const results = await Promise.all(requests)
      assert.equal(results.filter(result => !result.ok && /Too many pending/.test(result.reason)).length, TEAMSPACE_INVITE_REDEEM_PENDING_MAX)
      assert.equal((f.store as unknown as { redeemChains: Map<string, unknown> }).redeemChains.size, 0)
    }
  } finally { f.cleanup() }
})

test('prototype-named device IDs and legacy v2 device IDs survive exact claim recovery and restart', async () => {
  const f = fixture()
  try {
    const joined = await f.store.redeemInvite({ token: f.mint().token, deviceId: '__proto__' })
    assert.ok(joined.ok)
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal(restarted.findBySession(joined.sessionToken)?.deviceId, '__proto__')
    assert.equal(restarted.findMember(joined.member.memberId)!.sessions.__proto__, hashSessionToken(joined.sessionToken))
    const invite = f.mint('v2@example.test')
    const path = join(f.root, 'invites.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    const row = rows.find((entry: { id: string }) => entry.id === invite.id)
    row.usedAt = Date.now(); row.usedBy = 'claim:v2:abc123:nonce'
    writeFileSync(path, JSON.stringify(rows))
    assert.equal((await f.store.redeemInvite({ token: invite.token, deviceId: 'v2' })).ok, true)
  } finally { f.cleanup() }
})

test('encrypted pending transaction contains no plaintext invite/session and unreadable replay fails closed on repeated boots', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const key = resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: 'synthetic-invite-test-key-123456' } as NodeJS.ProcessEnv)!
    const encrypted = new BridgeStore(f.root, 21, key, null)
    const invite = encrypted.createInvite('admin', 'encrypted@example.test', 'member')
    assert.ok(invite.ok)
    restore = renameFailure((_from, to) => to === join(f.root, 'members.json'))
    const joined = await encrypted.redeemInvite({ token: invite.invite.token, deviceId: 'encrypted-device' })
    assert.ok(joined.ok)
    const path = join(f.root, 'invite-redemption.pending.json')
    const raw = readFileSync(path, 'utf8')
    assert.match(raw, /ciphertext/)
    assert.ok(!raw.includes(invite.invite.token) && !raw.includes(joined.sessionToken) && !raw.includes('encrypted@example.test'))
    restore()
    for (let i = 0; i < 2; i++) {
      const wrongKey = new BridgeStore(f.root, 21, null, null)
      assert.ok(wrongKey.isMembersStoreUnusable() && wrongKey.isInvitesStoreUnusable())
      assert.equal(wrongKey.findBySession(f.admin.sessionToken), null)
      assert.equal(wrongKey.helloOrBootstrap({ memberId: 'new-admin', deviceId: 'new-device' }).ok, false)
      assert.ok(fs.existsSync(path), 'unreadable journal must not be quarantined into a fail-open second boot')
    }
    const recovered = new BridgeStore(f.root, 21, key, null)
    assert.equal(recovered.findBySession(joined.sessionToken)?.member.memberId, joined.member.memberId)
  } finally { restore(); f.cleanup() }
})

test('bulk kick atomically removes matching outstanding invite bearers while preserving unrelated and anonymous invites', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const a = await f.store.redeemInvite({ token: f.mint('a@example.test').token, deviceId: 'a-device' })
    const b = await f.store.redeemInvite({ token: f.mint('b@example.test').token, deviceId: 'b-device' })
    assert.ok(a.ok && b.ok)
    const aOld = f.mint('A@example.test')
    const bOld = f.mint('b@example.test')
    const unrelated = f.mint('unrelated@example.test')
    const anonymous = f.mint('')
    restore = renameFailure((_from, to) => to === join(f.root, 'invites.json'))
    const kicked = f.store.kickMembers('admin', [a.member.memberId, b.member.memberId])
    assert.ok(kicked.ok, 'kick commits its membership/invite transaction despite checkpoint failure')
    assert.equal(f.store.findBySession(a.sessionToken), null)
    restore()
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal(restarted.findBySession(a.sessionToken), null)
    assert.equal(restarted.findBySession(b.sessionToken), null)
    assert.equal((await restarted.redeemInvite({ token: aOld.token, deviceId: 'a-return' })).ok, false)
    assert.equal((await restarted.redeemInvite({ token: bOld.token, deviceId: 'b-return' })).ok, false)
    assert.equal((await restarted.redeemInvite({ token: unrelated.token, deviceId: 'unrelated-device' })).ok, true)
    assert.equal((await restarted.redeemInvite({ token: anonymous.token, deviceId: 'anonymous-device' })).ok, true)
    const fresh = restarted.createInvite('admin', 'a@example.test', 'member')
    assert.ok(fresh.ok)
    assert.equal((await restarted.redeemInvite({ token: fresh.invite.token, deviceId: 'approved-return' })).ok, true)
  } finally { restore(); f.cleanup() }
})

test('same strong attempt replays the exact bearer after lost response/restart, while other proofs cannot reuse it', async () => {
  const f = fixture()
  try {
    const invite = f.mint()
    const args = { token: invite.token, deviceId: 'recover-device', redemptionNonce: 'a'.repeat(64) }
    const first = await f.store.redeemInvite(args)
    assert.ok(first.ok && !first.replayed)
    for (const store of [f.store, new BridgeStore(f.root, 21, null, null)]) {
      const replay = await store.redeemInvite(args)
      assert.ok(replay.ok && replay.replayed)
      assert.equal(replay.sessionToken, first.sessionToken)
      assert.equal(replay.member.memberId, first.member.memberId)
      assert.equal((await store.redeemInvite({ ...args, redemptionNonce: 'b'.repeat(64) })).ok, false)
      assert.equal((await store.redeemInvite({ ...args, deviceId: 'different-device' })).ok, false)
      assert.equal((await store.redeemInvite({ token: args.token, deviceId: args.deviceId })).ok, false)
    }
    const raw = readFileSync(join(f.root, 'invites.json'), 'utf8')
    assert.ok(!raw.includes(args.redemptionNonce) && !raw.includes(first.sessionToken) && !raw.includes(invite.token))
  } finally { f.cleanup() }
})

test('strong-attempt same-token concurrency has one commit and idempotent replays without session churn', async () => {
  const f = fixture()
  try {
    const args = { token: f.mint().token, deviceId: 'one-device', redemptionNonce: 'c'.repeat(64) }
    const results = await Promise.all(Array.from({ length: 24 }, () => f.store.redeemInvite(args)))
    assert.ok(results.every(result => result.ok))
    assert.equal(results.filter(result => result.ok && !result.replayed).length, 1)
    assert.equal(new Set(results.map(result => result.ok && result.sessionToken)).size, 1)
    assert.equal(new Set(results.map(result => result.ok && result.member.memberId)).size, 1)
  } finally { f.cleanup() }
})

test('process crash after commit is recoverable with the original strong attempt, not just the same device', async () => {
  const f = fixture()
  try {
    const invite = f.mint()
    const nonce = 'd'.repeat(64)
    const child = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(import.meta.url), '--crash-after-member-checkpoint', f.root, invite.token, nonce], { encoding: 'utf8', timeout: 15_000 })
    assert.equal(child.status, 73, child.stderr)
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal((await restarted.redeemInvite({ token: invite.token, deviceId: 'crash-device' })).ok, false)
    const recovered = await restarted.redeemInvite({ token: invite.token, deviceId: 'crash-device', redemptionNonce: nonce })
    assert.ok(recovered.ok && recovered.replayed)
    assert.equal(restarted.findBySession(recovered.sessionToken)?.member.memberId, recovered.member.memberId)
  } finally { f.cleanup() }
})

test('retry returns current role, but never recreates kicked/revoked/replaced sessions', async () => {
  for (const mutation of ['revoke', 'kick', 'replace'] as const) {
    const f = fixture()
    try {
      const args = { token: f.mint().token, deviceId: 'old-device', redemptionNonce: 'e'.repeat(64) }
      const first = await f.store.redeemInvite(args)
      assert.ok(first.ok)
      assert.ok(f.store.setMemberRole({ actorMemberId: 'admin', targetMemberId: first.member.memberId, role: 'viewer' }).ok)
      const updated = await f.store.redeemInvite(args)
      assert.ok(updated.ok && updated.replayed)
      assert.equal(updated.member.role, 'viewer')
      if (mutation === 'revoke') assert.ok(f.store.revokeSession({ actorMemberId: 'admin', targetMemberId: first.member.memberId }).ok)
      else if (mutation === 'kick') assert.ok(f.store.kickMember('admin', first.member.memberId).ok)
      else assert.ok((await f.store.redeemInvite({ token: f.mint().token, deviceId: 'new-device' })).ok)
      assert.equal((await f.store.redeemInvite(args)).ok, false)
      assert.equal((await new BridgeStore(f.root, 21, null, null).redeemInvite(args)).ok, false)
      assert.equal(f.store.findBySession(first.sessionToken), null)
    } finally { f.cleanup() }
  }
})

test('precommit interrupted strong claim cannot be taken over with a different nonce on the same device', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const args = { token: f.mint().token, deviceId: 'same-device', redemptionNonce: 'f'.repeat(64) }
    restore = renameFailure((_from, to) => to === join(f.root, 'invite-redemption.pending.json'))
    await assert.rejects(f.store.redeemInvite(args), /injected EIO/)
    restore()
    assert.equal((await f.store.redeemInvite({ ...args, redemptionNonce: '0'.repeat(64) })).ok, false)
    assert.equal((await f.store.redeemInvite({ token: args.token, deviceId: args.deviceId })).ok, false)
    assert.ok((await f.store.redeemInvite(args)).ok)
  } finally { restore(); f.cleanup() }
})

test('unsafe journal links/directories/oversized files never become a missing-journal bootstrap', () => {
  for (const kind of ['dangling', 'symlink', 'directory', 'fifo', 'oversized', 'corrupt'] as const) {
    const f = fixture()
    try {
      const path = join(f.root, 'invite-redemption.pending.json')
      if (kind === 'dangling') fs.symlinkSync(join(f.root, 'does-not-exist'), path)
      else if (kind === 'symlink') fs.symlinkSync(join(f.root, 'members.json'), path)
      else if (kind === 'directory') fs.mkdirSync(path)
      else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [path]).status, 0)
      else if (kind === 'oversized') { const fd = fs.openSync(path, 'w'); fs.ftruncateSync(fd, 512 * 1024 * 1024 + 1); fs.closeSync(fd) }
      else writeFileSync(path, '{"version":1,"members":[],"invites":[]}')
      for (let boot = 0; boot < 2; boot++) {
        const restarted = new BridgeStore(f.root, 21, null, null)
        assert.ok(restarted.isMembersStoreUnusable() && restarted.isInvitesStoreUnusable(), kind)
        assert.equal(restarted.findBySession(f.admin.sessionToken), null, kind)
        assert.equal(restarted.helloOrBootstrap({ memberId: 'new-admin', deviceId: 'new-device' }).ok, false, kind)
      }
    } finally { f.cleanup() }
  }
})

test('journal fsync failures before and after rename never return credentials or activate an unconfirmed session', async () => {
  for (const failAt of [1, 2]) {
    const f = fixture()
    const original = fs.fsyncSync
    try {
      const invite = f.mint()
      let syncs = 0
      fs.fsyncSync = ((fd: number) => {
        if (++syncs === failAt) throw Object.assign(new Error('injected fsync EIO'), { code: 'EIO' })
        original(fd)
      }) as typeof fs.fsyncSync
      syncBuiltinESMExports()
      await assert.rejects(f.store.redeemInvite({ token: invite.token, deviceId: 'failed-sync-device', redemptionNonce: '3'.repeat(64) }), /fsync EIO/)
      assert.equal(f.store.listMembers().length, 1)
      assert.equal(fs.existsSync(join(f.root, 'invite-redemption.pending.json')), false)
      assert.equal(f.store.findBySession(f.admin.sessionToken)?.member.memberId, 'admin')
      fs.fsyncSync = original; syncBuiltinESMExports()
      const restarted = new BridgeStore(f.root, 21, null, null)
      assert.equal(restarted.listMembers().length, 1)
      assert.ok((await restarted.redeemInvite({ token: invite.token, deviceId: 'failed-sync-device', redemptionNonce: '3'.repeat(64) })).ok)
    } finally { fs.fsyncSync = original; syncBuiltinESMExports(); f.cleanup() }
  }
})

test('failed mint/cancel cannot leak plaintext token cache entries or forget a still-durable invite', () => {
  const f = fixture()
  let restore = () => {}
  try {
    const pending = f.mint()
    const cache = (f.store as unknown as { invitePlainByHash: Map<string, string> }).invitePlainByHash
    const before = [...cache]
    restore = renameFailure((_from, to) => to === join(f.root, 'invites.json'))
    for (let attempt = 0; attempt < 12; attempt++) assert.throws(() => f.store.createInvite('admin', `failed-${attempt}@example.test`, 'member'), /injected EIO/)
    assert.deepEqual([...cache], before)
    assert.throws(() => f.store.cancelInvite(pending.id), /injected EIO/)
    assert.deepEqual([...cache], before)
    restore()
    assert.equal(f.store.listInvites().find(row => row.id === pending.id)?.token, pending.token)
  } finally { restore(); f.cleanup() }
})

test('kick wins over an already queued old-email invite and never treats an empty email as a wildcard', async () => {
  const f = fixture()
  try {
    const member = await f.store.redeemInvite({ token: f.mint().token, deviceId: 'member-device' })
    assert.ok(member.ok)
    const invitation = f.mint()
    const queued = f.store.redeemInvite({ token: invitation.token, deviceId: 'queued-device' })
    assert.ok(f.store.kickMember('admin', member.member.memberId).ok)
    assert.equal((await queued).ok, false)
    const anonymousMember = await f.store.redeemInvite({ token: f.mint('').token, deviceId: 'anonymous-member' })
    assert.ok(anonymousMember.ok)
    const anonymousInvite = f.mint('')
    assert.ok(f.store.kickMember('admin', anonymousMember.member.memberId).ok)
    assert.equal((await f.store.redeemInvite({ token: anonymousInvite.token, deviceId: 'unrelated-anonymous' })).ok, true)
  } finally { f.cleanup() }
})

test('malformed nonce never consumes an invite, and an expired retry receipt cannot mint a second session', async () => {
  const f = fixture()
  try {
    const invite = f.mint()
    for (const redemptionNonce of ['', 'A'.repeat(64), '4'.repeat(63), '4'.repeat(65), ` ${'4'.repeat(64)}`]) {
      assert.equal((await f.store.redeemInvite({ token: invite.token, deviceId: 'nonce-device', redemptionNonce })).ok, false)
    }
    const args = { token: invite.token, deviceId: 'nonce-device', redemptionNonce: '4'.repeat(64) }
    const joined = await f.store.redeemInvite(args)
    assert.ok(joined.ok)
    const path = join(f.root, 'invites.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    rows.find((row: { id: string }) => row.id === invite.id).redemptionReceipt.expiresAt = Date.now() - 1
    writeFileSync(path, JSON.stringify(rows))
    assert.equal((await f.store.redeemInvite(args)).ok, false)
    assert.equal(f.store.findBySession(joined.sessionToken)?.member.memberId, joined.member.memberId, 'receipt expiry does not revoke the original authorized session')
  } finally { f.cleanup() }
})

test('role downgrade atomically retires higher-grant pending claims but retains safe invites and current-role replay', async () => {
  const f = fixture()
  let restore = () => {}
  try {
    const initial = f.mint('role@example.test', 'admin')
    const args = { token: initial.token, deviceId: 'role-device', redemptionNonce: '5'.repeat(64) }
    const member = await f.store.redeemInvite(args)
    assert.ok(member.ok)
    const oldAdmin = f.mint('ROLE@example.test', 'admin')
    const oldMember = f.mint('role@example.test', 'member')
    const safeViewer = f.mint('role@example.test', 'viewer')
    const unrelatedAdmin = f.mint('other@example.test', 'admin')
    const rowsPath = join(f.root, 'invites.json')
    const rows = JSON.parse(readFileSync(rowsPath, 'utf8'))
    const interrupted = rows.find((row: { id: string }) => row.id === oldMember.id)
    interrupted.usedAt = Date.now(); interrupted.usedBy = 'claim:interrupted-device:abc123:nonce'
    writeFileSync(rowsPath, JSON.stringify(rows))
    restore = renameFailure((_from, to) => to === rowsPath)
    assert.ok(f.store.setMemberRole({ actorMemberId: 'admin', targetMemberId: member.member.memberId, role: 'viewer' }).ok)
    assert.equal(f.store.findBySession(member.sessionToken)?.member.role, 'viewer')
    restore()
    const restarted = new BridgeStore(f.root, 21, null, null)
    const replay = await restarted.redeemInvite(args)
    assert.ok(replay.ok && replay.replayed)
    assert.equal(replay.member.role, 'viewer')
    assert.equal((await restarted.redeemInvite({ token: oldAdmin.token, deviceId: 'old-admin-device' })).ok, false)
    assert.equal((await restarted.redeemInvite({ token: oldMember.token, deviceId: 'interrupted-device' })).ok, false)
    assert.ok(restarted.listInvites().some(row => row.id === safeViewer.id))
    assert.ok(restarted.listInvites().some(row => row.id === unrelatedAdmin.id))
    const approved = restarted.createInvite('admin', 'role@example.test', 'admin')
    assert.ok(approved.ok)
    const elevated = await restarted.redeemInvite({ token: approved.invite.token, deviceId: 'approved-elevation' })
    assert.ok(elevated.ok)
    assert.equal(elevated.member.role, 'admin')
  } finally { restore(); f.cleanup() }
})

test('role downgrade wins over an already queued higher-grant old invitation', async () => {
  const f = fixture()
  try {
    const member = await f.store.redeemInvite({ token: f.mint('race-role@example.test', 'member').token, deviceId: 'race-member' })
    assert.ok(member.ok)
    const invite = f.mint('race-role@example.test', 'admin')
    const queued = f.store.redeemInvite({ token: invite.token, deviceId: 'racing-admin' })
    assert.ok(f.store.setMemberRole({ actorMemberId: 'admin', targetMemberId: member.member.memberId, role: 'viewer' }).ok)
    assert.equal((await queued).ok, false)
    assert.equal(f.store.findBySession(member.sessionToken)?.member.role, 'viewer')
  } finally { f.cleanup() }
})

test('authorized recovery binds a prototype-named new device rather than returning an unusable session', () => {
  const f = fixture()
  try {
    const secret = 'synthetic-recovery-key-for-prototype-device'
    const store = new BridgeStore(f.root, 21, null, { secret, source: 'env', path: null, warnings: [] })
    const recovered = store.helloOrBootstrap({ memberId: 'admin', deviceId: '__proto__', adminRecoveryKey: secret })
    assert.ok(recovered.ok)
    assert.equal(store.findBySession(recovered.sessionToken)?.deviceId, '__proto__')
    assert.equal(new BridgeStore(f.root, 21, null, null).findBySession(recovered.sessionToken)?.deviceId, '__proto__')
  } finally { f.cleanup() }
})

test('lower-role re-invite also invalidates older higher-role invitations atomically', async () => {
  const f = fixture()
  try {
    const joined = await f.store.redeemInvite({ token: f.mint('demote@example.test', 'admin').token, deviceId: 'admin-join' })
    assert.ok(joined.ok)
    const stale = f.mint('demote@example.test', 'admin')
    const lower = f.mint('demote@example.test', 'viewer')
    const demoted = await f.store.redeemInvite({ token: lower.token, deviceId: 'viewer-join' })
    assert.ok(demoted.ok)
    assert.equal(demoted.member.role, 'viewer')
    const restarted = new BridgeStore(f.root, 21, null, null)
    assert.equal((await restarted.redeemInvite({ token: stale.token, deviceId: 'stale-elevation' })).ok, false)
    assert.equal(restarted.findBySession(demoted.sessionToken)?.member.role, 'viewer')
  } finally { f.cleanup() }
})

test('retry receipt capacity refuses a new strong claim before burning it; retained receipts do not consume pending-invite slots', async () => {
  const f = fixture()
  try {
    const existing = await f.store.redeemInvite({ token: f.mint().token, deviceId: 'existing', redemptionNonce: '1'.repeat(64) })
    assert.ok(existing.ok)
    const pending = f.mint('pending@example.test')
    const path = join(f.root, 'invites.json')
    const rows = JSON.parse(readFileSync(path, 'utf8'))
    const receipt = rows.find((row: { redemptionReceipt?: unknown }) => row.redemptionReceipt)
    const receipts = Array.from({ length: TEAMSPACE_INVITE_RETRY_RECEIPTS_MAX }, (_v, index) => ({ ...receipt, id: `receipt-${index}`, token: hashSessionToken(`synthetic-receipt-${index}`) }))
    writeFileSync(path, JSON.stringify([...receipts, rows.find((row: { id: string }) => row.id === pending.id)]))
    f.store.reload()
    const refused = await f.store.redeemInvite({ token: pending.token, deviceId: 'pending-device', redemptionNonce: '2'.repeat(64) })
    assert.ok(!refused.ok && /retry receipts/.test(refused.reason))
    const pendingRow = JSON.parse(readFileSync(path, 'utf8')).find((row: { id: string }) => row.id === pending.id)
    assert.equal(pendingRow.usedAt, null)
    assert.equal(pendingRow.usedBy, null)
    assert.ok(f.store.createInvite('admin', 'still-available@example.test', 'member').ok)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).filter((row: { redemptionReceipt?: unknown }) => row.redemptionReceipt).length, TEAMSPACE_INVITE_RETRY_RECEIPTS_MAX)
  } finally { f.cleanup() }
})
