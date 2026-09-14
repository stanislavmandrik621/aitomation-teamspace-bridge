/**
 * Durable offline refusal receipts + atomic one/many member offboarding.
 */
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BridgeStore,
  TEAMSPACE_KICK_MEMBERS_MAX,
  hashSessionToken,
} from '../src/store.js'

type FixtureMember = {
  memberId: string
  role: 'admin' | 'member' | 'viewer'
  sessions: Record<string, string>
}

function writeFixture(dir: string, members: FixtureMember[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'team.json'),
    JSON.stringify({ teamId: 'team_revocation', name: 'Revocation', createdAt: 1 }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'members.json'),
    JSON.stringify(members.map((member, index) => ({
      ...member,
      email: `${member.memberId}@example.test`,
      displayName: member.memberId,
      createdAt: index + 1,
    }))),
    'utf8',
  )
}

function open(dir: string): BridgeStore {
  return new BridgeStore(dir, 21, null, null)
}

function requireRefuse(
  result: ReturnType<BridgeStore['helloOrBootstrap']>,
  code?: 'membership_revoked' | 'session_revoked',
): void {
  assert.equal(result.ok, false)
  if (result.ok) throw new Error('unreachable')
  assert.equal(result.code, code)
}

const root = mkdtempSync(join(tmpdir(), 'bridge-member-revocation-'))
try {
  {
    const dir = join(root, 'one-many')
    const tokens = {
      admin: 'token-admin',
      alice1: 'token-alice-1',
      alice2: 'token-alice-2',
      bob1: 'token-bob-1',
      bob2: 'token-bob-2',
      carol: 'token-carol',
    }
    writeFixture(dir, [
      { memberId: 'admin', role: 'admin', sessions: { 'admin-device': hashSessionToken(tokens.admin) } },
      {
        memberId: 'alice',
        role: 'member',
        sessions: {
          'alice-device-1': hashSessionToken(tokens.alice1),
          'alice-device-2': hashSessionToken(tokens.alice2),
        },
      },
      {
        memberId: 'bob',
        role: 'viewer',
        sessions: {
          'bob-device-1': hashSessionToken(tokens.bob1),
          'bob-device-2': hashSessionToken(tokens.bob2),
        },
      },
      { memberId: 'carol', role: 'member', sessions: { 'carol-device': hashSessionToken(tokens.carol) } },
    ])
    const store = open(dir)
    for (const deviceId of [
      'alice-device-1',
      'alice-device-2',
      'bob-device-1',
      'bob-device-2',
      'carol-device',
    ]) {
      store.markAcked(deviceId, ['op-before-kick'])
    }
    store.flushAcksPersist()

    const one = store.kickMember('admin', 'carol')
    assert.equal(one.ok, true)
    if (!one.ok) throw new Error(one.reason)
    assert.deepEqual(one.kickedDeviceIds, ['carol-device'])
    assert.equal(store.findMember('carol'), undefined)
    assert.equal(store.deviceAckCount('carol-device'), 0)

    const many = store.kickMembers('admin', ['alice', 'bob', 'alice'])
    assert.equal(many.ok, true)
    if (!many.ok) throw new Error(many.reason)
    assert.deepEqual(many.members.map((row) => row.memberId), ['alice', 'bob'])
    assert.deepEqual(many.members[0]?.kickedDeviceIds, ['alice-device-1', 'alice-device-2'])
    assert.deepEqual(many.members[1]?.kickedDeviceIds, ['bob-device-1', 'bob-device-2'])
    assert.deepEqual(store.listMembers().map((row) => row.memberId), ['admin'])
    for (const deviceId of [
      'alice-device-1',
      'alice-device-2',
      'bob-device-1',
      'bob-device-2',
    ]) {
      assert.equal(store.deviceAckCount(deviceId), 0, `${deviceId} ack bag removed`)
    }

    const restarted = open(dir)
    for (const [memberId, deviceId, token] of [
      ['alice', 'alice-device-1', tokens.alice1],
      ['alice', 'alice-device-2', tokens.alice2],
      ['bob', 'bob-device-1', tokens.bob1],
      ['bob', 'bob-device-2', tokens.bob2],
      ['carol', 'carol-device', tokens.carol],
    ] as const) {
      requireRefuse(restarted.helloOrBootstrap({ memberId, deviceId, sessionToken: token }), 'membership_revoked')
    }
    requireRefuse(restarted.helloOrBootstrap({
      memberId: 'alice',
      deviceId: 'alice-device-1',
      sessionToken: 'never-valid',
    }))
    requireRefuse(restarted.helloOrBootstrap({
      memberId: 'alice',
      deviceId: 'wrong-device',
      sessionToken: tokens.alice1,
    }))
    // A disk hash is not a bearer and must not reveal the receipt.
    requireRefuse(restarted.helloOrBootstrap({
      memberId: 'alice',
      deviceId: 'alice-device-1',
      sessionToken: hashSessionToken(tokens.alice1),
    }))
    const journal = readFileSync(join(dir, 'revoked-sessions.json'), 'utf8')
    assert.equal(journal.includes(tokens.alice1), false, 'plaintext bearer never enters journal')
    assert.equal(journal.includes(hashSessionToken(tokens.alice1)), true)
  }

  {
    const dir = join(root, 'session-only')
    writeFixture(dir, [
      { memberId: 'admin', role: 'admin', sessions: { ad: hashSessionToken('admin-token') } },
      {
        memberId: 'member',
        role: 'member',
        sessions: {
          d1: hashSessionToken('member-token-1'),
          d2: hashSessionToken('member-token-2'),
        },
      },
    ])
    const store = open(dir)
    const revoked = store.revokeSession({
      actorMemberId: 'admin',
      targetMemberId: 'member',
      deviceId: 'd1',
    })
    assert.equal(revoked.ok, true)
    requireRefuse(store.helloOrBootstrap({
      memberId: 'member',
      deviceId: 'd1',
      sessionToken: 'member-token-1',
    }), 'session_revoked')
    assert.equal(store.helloOrBootstrap({
      memberId: 'member',
      deviceId: 'd2',
      sessionToken: 'member-token-2',
    }).ok, true)
    const restarted = open(dir)
    requireRefuse(restarted.helloOrBootstrap({
      memberId: 'member',
      deviceId: 'd1',
      sessionToken: 'member-token-1',
    }), 'session_revoked')
  }

  {
    const dir = join(root, 'atomic-invalid')
    const maxLengthMemberId = 'm'.repeat(128)
    const maxLengthAdminId = 'a'.repeat(128)
    const maxLengthDeviceId = 'd'.repeat(128)
    writeFixture(dir, [
      { memberId: 'admin', role: 'admin', sessions: { ad: hashSessionToken('admin-token') } },
      { memberId: maxLengthAdminId, role: 'admin', sessions: { maxadmin: hashSessionToken('max-admin-token') } },
      { memberId: 'alice', role: 'member', sessions: { a1: hashSessionToken('alice-token') } },
      { memberId: 'bob', role: 'member', sessions: { b1: hashSessionToken('bob-token') } },
      {
        memberId: maxLengthMemberId,
        role: 'member',
        sessions: { [maxLengthDeviceId]: hashSessionToken('max-token') },
      },
    ])
    const store = open(dir)
    const missing = store.kickMembers('admin', ['alice', 'missing'])
    assert.equal(missing.ok, false)
    assert.ok(store.findMember('alice'), 'valid prefix target survives a mixed-invalid batch')
    assert.equal(store.helloOrBootstrap({
      memberId: 'alice',
      deviceId: 'a1',
      sessionToken: 'alice-token',
    }).ok, true)
    const self = store.kickMembers('admin', ['bob', 'admin'])
    assert.equal(self.ok, false)
    assert.ok(store.findMember('bob'), 'valid prefix target survives a self-containing batch')
    const oversized = store.kickMembers(
      'admin',
      Array.from({ length: TEAMSPACE_KICK_MEMBERS_MAX + 1 }, () => 'bob'),
    )
    assert.equal(oversized.ok, false)
    assert.ok(store.findMember('bob'), 'oversized batch is not silently truncated')
    const overlongTarget = store.kickMembers('admin', [`${maxLengthMemberId}x`])
    assert.equal(overlongTarget.ok, false)
    assert.ok(
      store.findMember(maxLengthMemberId),
      'an overlong selector must not be truncated into a different valid member id',
    )
    assert.equal(store.revokeSession({
      actorMemberId: 'admin',
      targetMemberId: `${maxLengthMemberId}x`,
    }).ok, false)
    assert.ok(store.findMember(maxLengthMemberId), 'session revoke must not truncate a target id either')
    assert.equal(store.kickMembers('admin', ['bob\0other']).ok, false)
    assert.ok(store.findMember('bob'), 'a malformed selector cannot alias a real member')
    assert.equal(store.kickMembers(`${maxLengthAdminId}x`, ['bob']).ok, false)
    assert.ok(store.findMember('bob'), 'an overlong actor selector cannot alias a real Admin')
    assert.equal(store.setMemberRole({
      actorMemberId: `${maxLengthAdminId}x`,
      targetMemberId: 'bob',
      role: 'viewer',
    }).ok, false)
    assert.equal(store.findMember('bob')?.role, 'member')
    requireRefuse(store.helloOrBootstrap({
      memberId: `${maxLengthMemberId}x`,
      deviceId: maxLengthDeviceId,
      sessionToken: 'max-token',
    }))
    requireRefuse(store.helloOrBootstrap({
      memberId: maxLengthMemberId,
      deviceId: `${maxLengthDeviceId}x`,
      sessionToken: 'max-token',
    }))
    assert.equal(store.helloOrBootstrap({
      memberId: maxLengthMemberId,
      deviceId: maxLengthDeviceId,
      sessionToken: 'max-token',
    }).ok, true, 'the exact maximum-length connection identity still authenticates')
  }

  {
    const dir = join(root, 'last-live-admin')
    writeFixture(dir, [
      { memberId: 'ghost-admin', role: 'admin', sessions: {} },
      { memberId: 'live-admin', role: 'admin', sessions: { live: hashSessionToken('live-token') } },
      { memberId: 'member', role: 'member', sessions: { mem: hashSessionToken('member-token') } },
    ])
    const store = open(dir)
    const refused = store.kickMembers('ghost-admin', ['member', 'live-admin'])
    assert.equal(refused.ok, false)
    if (refused.ok) throw new Error('unreachable')
    assert.match(refused.reason, /last admin/i)
    assert.ok(store.findMember('member'), 'mixed batch rolls back the non-Admin target')
    assert.ok(store.findMember('live-admin'), 'last live Admin remains')
  }

  {
    const dir = join(root, 'ack-persist-failure')
    writeFixture(dir, [
      { memberId: 'admin', role: 'admin', sessions: { ad: hashSessionToken('admin-token') } },
      { memberId: 'member', role: 'member', sessions: { device: hashSessionToken('member-token') } },
    ])
    const store = open(dir)
    store.markAcked('device', ['op-before-kick'], 'member')
    store.flushAcksPersist()
    const blocker = join(dir, `acks.json.${process.pid}.tmp`)
    mkdirSync(blocker)
    const kicked = store.kickMember('admin', 'member')
    assert.equal(kicked.ok, true, 'ack metadata failure must not abort committed access revocation')
    assert.equal(store.findBySession('member-token'), null, 'revoked authority is gone immediately')
    assert.equal(store.deviceAckCount('device', 'member'), 0, 'orphaned ack is removed in memory')
    rmSync(blocker, { recursive: true })
    store.flushAcksPersist()
    assert.equal(open(dir).deviceAckCount('device', 'member'), 0, 'deferred cleanup persists after recovery')
  }

  console.log('member revocation: atomic one/many, all devices/acks, restart receipts, generic invalid privacy, session revoke, caps and last-Admin passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
