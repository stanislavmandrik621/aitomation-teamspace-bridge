/**
 * TCC-R1125-SHR-002 - a redeemed member is stamped with the stable invite id
 * they joined via (never the raw join token - TS-SCL-001), and that id
 * survives a members.json disk reload. This is what lets the host resolve an
 * access-template invite intent for token-only (no-email) invites.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-joined-via-invite-'))
  try {
    const dir = join(root, 'team')
    const store = new BridgeStore(dir, 21, null)
    store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'dev_admin',
      memberEmail: 'admin@example.com',
      displayName: 'Admin',
    })

    // --- Token-only invite (no email) still gets a stable id ---
    const created = store.createInvite('mem_admin', '', 'member')
    assert(created.ok === true, 'invite created')
    if (!created.ok) throw new Error('unreachable')
    const { id: inviteId, token } = created.invite
    assert(typeof inviteId === 'string' && inviteId.length > 0, 'invite has stable id')

    const redeemed = await store.redeemInvite({
      token,
      deviceId: 'dev_joiner',
      displayName: 'Joiner',
    })
    assert(redeemed.ok === true, 'redeem ok')
    if (!redeemed.ok) throw new Error('unreachable')
    assert(
      redeemed.member.joinedViaInviteId === inviteId,
      `member stamped with invite id (got ${String(redeemed.member.joinedViaInviteId)})`,
    )

    // --- Field survives a full disk reload (allowlist normalizer) ---
    const reloaded = new BridgeStore(dir, 21, null)
    const listed = reloaded.listMembers()
    const joiner = listed.find((m) => m.memberId === redeemed.member.memberId)
    assert(!!joiner, 'joiner present after reload')
    assert(
      joiner!.joinedViaInviteId === inviteId,
      `joinedViaInviteId survives reload (got ${String(joiner!.joinedViaInviteId)})`,
    )

    // --- Admin (pre-existing member, no invite redeem) has no stamp ---
    const admins = reloaded.listMembers().filter((m) => m.memberId === 'mem_admin')
    assert(admins.length === 1, 'admin present')
    assert(admins[0]!.joinedViaInviteId === undefined, 'bootstrap admin has no joinedViaInviteId')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  console.log('joined-via-invite-id: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
