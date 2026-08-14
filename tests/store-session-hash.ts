/**
 * TS-BRG-012 / TS-BRG-013 / TS-SCL-001 - bridge store session hash + torn members + prune race.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, hashSessionToken, mintToken } from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-'))
  try {
    // --- BRG-012: minted sessions stored hashed ---
    {
      const store = new BridgeStore(join(root, 'a'), 21)
      const hello = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'dev1',
        memberEmail: 'a@example.com',
        displayName: 'Admin',
      })
      assert(hello.ok === true, 'first hello mints')
      if (!hello.ok) throw new Error('unreachable')
      const plain = hello.sessionToken
      const membersPath = join(root, 'a', 'members.json')
      const raw = readFileSync(membersPath, 'utf8')
      assert(!raw.includes(plain), 'plaintext token must not appear in members.json')
      assert(raw.includes(hashSessionToken(plain)), 'hashed token must be stored')
      const hit = store.findBySession(plain)
      assert(!!hit && hit.member.memberId === 'mem_admin', 'findBySession accepts plaintext bearer')
    }

    // --- BRG-012: legacy plaintext migrates on load ---
    {
      const dir = join(root, 'legacy')
      mkdirSync(dir, { recursive: true })
      const storePath = join(dir, 'members.json')
      const legacyTok = mintToken()
      writeFileSync(join(dir, 'team.json'), JSON.stringify({
        teamId: 'team_x', createdAt: Date.now(), name: 'T',
      }), 'utf8')
      writeFileSync(storePath, JSON.stringify([{
        memberId: 'mem_leg',
        email: 'l@example.com',
        displayName: 'Leg',
        role: 'admin',
        sessions: { d1: legacyTok },
        createdAt: Date.now(),
      }]), 'utf8')
      const store = new BridgeStore(dir, 21)
      const hit = store.findBySession(legacyTok)
      assert(!!hit, 'legacy plaintext still authenticates once')
      const after = readFileSync(storePath, 'utf8')
      assert(after.includes(hashSessionToken(legacyTok)), 'legacy migrated to hash')
      assert(!after.includes(`"${legacyTok}"`), 'legacy plaintext value gone from JSON')
    }

    // --- BRG-013: torn members refuse first-admin ---
    {
      const dir = join(root, 'torn')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'members.json'), '{not-json', 'utf8')
      const store = new BridgeStore(dir, 21)
      assert(store.isMembersStoreUnusable() === true, 'torn members flagged')
      const hello = store.helloOrBootstrap({
        memberId: 'attacker',
        deviceId: 'devX',
        memberEmail: 'evil@example.com',
      })
      assert(hello.ok === false, 'must refuse bootstrap after torn members')
    }

    // --- BRG-007 / DOC-010: session token must not silently bind a second device ---
    {
      const store = new BridgeStore(join(root, 'brg007'), 21)
      const minted = store.helloOrBootstrap({
        memberId: 'mem_d',
        deviceId: 'device-a',
        memberEmail: 'd@example.com',
        displayName: 'Dev',
      })
      assert(minted.ok === true, 'mint on device-a')
      if (!minted.ok) throw new Error('unreachable')
      const second = store.helloOrBootstrap({
        memberId: 'mem_d',
        deviceId: 'device-b',
        memberEmail: 'd@example.com',
        sessionToken: minted.sessionToken,
      })
      assert(second.ok === false, 'second device must not reuse session')
      if (second.ok) throw new Error('unreachable')
      assert(
        /another device|redeem/i.test(second.reason),
        `refuse reason names other device (got: ${second.reason})`,
      )
      const same = store.helloOrBootstrap({
        memberId: 'mem_d',
        deviceId: 'device-a',
        memberEmail: 'd@example.com',
        sessionToken: minted.sessionToken,
      })
      assert(same.ok === true, 'original device still authenticates')
    }

    // --- SCL-001: append during prune is not lost ---
    {
      const store = new BridgeStore(join(root, 'prune'), 21)
      store.helloOrBootstrap({
        memberId: 'm1', deviceId: 'd1', memberEmail: 'p@example.com',
      })
      for (let i = 0; i < 20; i++) {
        store.appendOp({
          opId: `op_${i}`,
          kind: 'record.update',
          protocolVersion: 1,
          hopCount: 0,
          originDevice: 'd1',
        } as never)
      }
      const prunePromise = store.pruneOps()
      store.appendOp({
        opId: 'op_during_prune',
        kind: 'record.update',
        protocolVersion: 1,
        hopCount: 0,
        originDevice: 'd1',
      } as never)
      await prunePromise
      const recent = await store.readRecentOps(100)
      assert(
        recent.some((o) => o.opId === 'op_during_prune'),
        'append during prune must survive rewrite',
      )
    }

    // --- TS-ROLE-001 / E17: last-admin demotion refuse + promote twin ---
    {
      const store = new BridgeStore(join(root, 'role'), 21)
      const a = store.helloOrBootstrap({
        memberId: 'mem_a',
        deviceId: 'da',
        memberEmail: 'a@example.com',
        displayName: 'Admin A',
      })
      assert(a.ok === true, 'admin hello')
      const created = store.createInvite('mem_a', 'b@example.com', 'member')
      assert(created.ok === true, 'invite minted')
      if (!created.ok) throw new Error('unreachable')
      const invite = created.invite
      assert(!!invite?.token, 'invite minted')
      const redeemed = await store.redeemInvite({
        token: invite.token,
        deviceId: 'db',
        memberEmail: 'b@example.com',
        displayName: 'Member B',
      })
      assert(redeemed.ok === true, 'member redeem')
      if (!redeemed.ok) throw new Error('unreachable')
      const memberB = redeemed.member.memberId
      const demoteLast = store.setMemberRole({
        actorMemberId: 'mem_a',
        targetMemberId: 'mem_a',
        role: 'member',
      })
      assert(demoteLast.ok === false, 'cannot demote sole admin')
      if (demoteLast.ok) throw new Error('unreachable')
      assert(/last admin/i.test(demoteLast.reason), 'last-admin reason')
      const promote = store.setMemberRole({
        actorMemberId: 'mem_a',
        targetMemberId: memberB,
        role: 'admin',
      })
      assert(promote.ok === true && promote.role === 'admin', 'promote second admin')
      const demoteSelf = store.setMemberRole({
        actorMemberId: 'mem_a',
        targetMemberId: 'mem_a',
        role: 'member',
      })
      assert(demoteSelf.ok === true && demoteSelf.role === 'member', 'transfer: demote after promote')
      // Re-promote A so leave last-admin can be tested with B as sole admin later.
      const promoteA = store.setMemberRole({
        actorMemberId: memberB,
        targetMemberId: 'mem_a',
        role: 'admin',
      })
      assert(promoteA.ok === true, 're-promote A')
      const leaveWhileTwo = store.leaveTeam(memberB)
      assert(leaveWhileTwo.ok === true, 'non-last admin may leave')
      const leaveLast = store.leaveTeam('mem_a')
      assert(leaveLast.ok === false, 'cannot leave as last admin')
      if (leaveLast.ok) throw new Error('unreachable')
      assert(/last admin/i.test(leaveLast.reason), 'leave last-admin reason')
    }

    // --- TCC-R1148-ENT-003: revokeSession refuses last Admin last live session ---
    {
      const store = new BridgeStore(join(root, 'revoke-last-admin'), 21)
      const a = store.helloOrBootstrap({
        memberId: 'mem_rev',
        deviceId: 'dev_only',
        memberEmail: 'rev@example.com',
        displayName: 'Revoke Admin',
      })
      assert(a.ok === true, 'revoke fixture hello')
      const refusedAll = store.revokeSession({
        actorMemberId: 'mem_rev',
        targetMemberId: 'mem_rev',
      })
      assert(refusedAll.ok === false, 'cannot revoke every last-Admin session')
      if (refusedAll.ok) throw new Error('unreachable')
      assert(
        /last Admin session/i.test(refusedAll.reason),
        `revoke reason names last Admin session (got: ${refusedAll.reason})`,
      )
      const refusedOne = store.revokeSession({
        actorMemberId: 'mem_rev',
        targetMemberId: 'mem_rev',
        deviceId: 'dev_only',
      })
      assert(refusedOne.ok === false, 'cannot revoke sole device of last Admin')
    }

    // --- TCC-R1127-BRG-001: existing-member redeem must refuse to demote the last Admin ---
    {
      const store = new BridgeStore(join(root, 'redeem-last-admin'), 21)
      const a = store.helloOrBootstrap({
        memberId: 'mem_sole',
        deviceId: 'dev1',
        memberEmail: 'sole@example.com',
        displayName: 'Sole Admin',
      })
      assert(a.ok === true, 'sole admin hello')

      // Sole Admin re-invites their own email for a second device, as a plain member.
      const selfInvite = store.createInvite('mem_sole', 'sole@example.com', 'member')
      assert(selfInvite.ok === true, 'self-invite minted')
      if (!selfInvite.ok) throw new Error('unreachable')

      const refused = await store.redeemInvite({
        token: selfInvite.invite.token,
        deviceId: 'dev2',
        memberEmail: 'sole@example.com',
      })
      assert(refused.ok === false, 'redeem must refuse - would leave zero Admins')
      if (refused.ok) throw new Error('unreachable')
      assert(/last admin/i.test(refused.reason), `refuse reason names last admin (got: ${refused.reason})`)
      const stillAdmin = store.findMember('mem_sole')
      assert(!!stillAdmin && stillAdmin.role === 'admin', 'role unchanged after refused redeem')

      // Token must not be burned by the refusal - a retry hits the same guard
      // (not "Invite already used"), proving the claim never landed on disk.
      const retried = await store.redeemInvite({
        token: selfInvite.invite.token,
        deviceId: 'dev3',
        memberEmail: 'sole@example.com',
      })
      assert(retried.ok === false, 'retry still refused')
      if (retried.ok) throw new Error('unreachable')
      assert(/last admin/i.test(retried.reason), 'retry hits the same last-admin guard (token not burned)')

      // Once a second Admin exists, the SAME invite may still be redeemed and
      // correctly demotes the (no-longer-sole) admin to member.
      const otherInvite = store.createInvite('mem_sole', 'other@example.com', 'member')
      assert(otherInvite.ok === true, 'second invite minted')
      if (!otherInvite.ok) throw new Error('unreachable')
      const otherRedeemed = await store.redeemInvite({
        token: otherInvite.invite.token,
        deviceId: 'dev-other',
        memberEmail: 'other@example.com',
      })
      assert(otherRedeemed.ok === true, 'second member redeem ok')
      if (!otherRedeemed.ok) throw new Error('unreachable')
      const promoted = store.setMemberRole({
        actorMemberId: 'mem_sole',
        targetMemberId: otherRedeemed.member.memberId,
        role: 'admin',
      })
      assert(promoted.ok === true, 'promote second admin')

      const nowAllowed = await store.redeemInvite({
        token: selfInvite.invite.token,
        deviceId: 'dev2',
        memberEmail: 'sole@example.com',
      })
      assert(nowAllowed.ok === true, 'redeem now succeeds with a second Admin present')
      if (!nowAllowed.ok) throw new Error('unreachable')
      const demoted = store.findMember('mem_sole')
      assert(!!demoted && demoted.role === 'member', 'sole admin demoted now that another Admin exists')
    }

    // --- TS-CHAT-012: chat profile avatar clear + rev ---
    {
      const store = new BridgeStore(join(root, 'chat012'), 21)
      const hello = store.helloOrBootstrap({
        memberId: 'mem_p',
        deviceId: 'dev_p',
        memberEmail: 'p@example.com',
        displayName: 'Pat',
      })
      assert(hello.ok === true, 'profile hello')
      if (!hello.ok) throw new Error('unreachable')
      const up = store.updateMemberChatProfile('mem_p', {
        avatarRef: 'local:avatar:v1',
        avatarRev: 1,
      })
      assert(up.ok === true, 'set avatar')
      if (!up.ok) throw new Error('unreachable')
      assert(up.member.avatarRef === 'local:avatar:v1', 'avatar ref set')
      assert(up.member.avatarRev === 1, 'avatar rev set')
      const cleared = store.updateMemberChatProfile('mem_p', {
        avatarRef: null,
        avatarRev: 2,
      })
      assert(cleared.ok === true, 'clear avatar')
      if (!cleared.ok) throw new Error('unreachable')
      assert(cleared.member.avatarRef === null, 'avatar cleared')
      assert(cleared.member.avatarRev === 2, 'rev bumped on clear')
      const again = store.findMember('mem_p')
      assert(!!again && again.avatarRef === null && again.avatarRev === 2, 'profile persisted in memory')
      // Reload from disk (at-rest encrypt may apply).
      const reloaded = new BridgeStore(join(root, 'chat012'), 21)
      const fromDisk = reloaded.findMember('mem_p')
      assert(!!fromDisk && fromDisk.avatarRef === null && fromDisk.avatarRev === 2, 'profile reloaded')
    }

    console.log('store-session-hash: ok')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
