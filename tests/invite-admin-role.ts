/**
 * TCC-R1143-INV-001: Admin-minted invites persist + redeem as admin|viewer|member.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-invite-admin-'))
try {
  const store = new BridgeStore(dir, 21)
  const boot = store.helloOrBootstrap({
    memberId: 'mem_host',
    deviceId: 'dev_host',
    memberEmail: 'host@example.com',
    displayName: 'Host Admin',
  })
  assert.equal(boot.ok, true, 'host bootstrap')

  const created = store.createInvite('mem_host', 'newadmin@example.com', 'admin')
  assert.equal(created.ok, true, 'admin invite mint')
  if (!created.ok) throw new Error('unreachable')
  assert.equal(created.invite.role, 'admin', 'createInvite must persist admin (not coerce to member)')

  const redeemed = await store.redeemInvite({
    token: created.invite.token,
    deviceId: 'dev_new',
    memberEmail: 'newadmin@example.com',
    displayName: 'New Admin',
  })
  assert.equal(redeemed.ok, true, 'admin invite redeem')
  if (!redeemed.ok) throw new Error('unreachable')
  assert.equal(redeemed.member.role, 'admin', 'redeem must grant admin')

  const viewerInv = store.createInvite('mem_host', 'viewer@example.com', 'viewer')
  assert.equal(viewerInv.ok, true)
  if (!viewerInv.ok) throw new Error('unreachable')
  assert.equal(viewerInv.invite.role, 'viewer')
  const viewerRedeem = await store.redeemInvite({
    token: viewerInv.invite.token,
    deviceId: 'dev_v',
    memberEmail: 'viewer@example.com',
  })
  assert.equal(viewerRedeem.ok, true)
  if (!viewerRedeem.ok) throw new Error('unreachable')
  assert.equal(viewerRedeem.member.role, 'viewer')

  console.log('invite-admin-role: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
