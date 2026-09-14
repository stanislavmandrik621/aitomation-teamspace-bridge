/** Real roster/session revocation + encrypted authorization records. No mailbox
 * provider, email credential, OAuth token or provider response is fabricated. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import { MailStore } from '../src/mail-store.js'
import { MailOAuthError, MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-owner-lifecycle-')))
const key = { key: randomBytes(32) }
const roster = new BridgeStore(directory, 21, key)
const admin = roster.helloOrBootstrap({ memberId: randomUUID(), deviceId: randomUUID(), displayName: 'Local authorization verification' })
assert.ok(admin.ok)
const invitation = roster.createInvite(admin.member.memberId, 'owner@authorization.example', 'member')
assert.ok(invitation.ok)
const ownerMember = await roster.redeemInvite({ token: invitation.invite.token, deviceId: randomUUID(), displayName: 'Original owner policy principal', memberEmail: 'owner@authorization.example' })
assert.ok(ownerMember.ok)
const teamId = randomUUID()
const owner: MailIdentity = { teamId, memberId: ownerMember.member.memberId, deviceId: Object.keys(ownerMember.member.sessions)[0]!, projectId: randomUUID() }
const grantee: MailIdentity = { teamId, memberId: admin.member.memberId, deviceId: Object.keys(admin.member.sessions)[0]!, projectId: randomUUID() }
const active = (identity: MailIdentity) => {
  const member = roster.findMember(identity.memberId)
  return identity.teamId === teamId && !!member && member.role !== 'viewer' && Object.hasOwn(member.sessions, identity.deviceId)
}
const identityKey = (identity: MailIdentity) => JSON.stringify({ teamId: identity.teamId, memberId: identity.memberId, projectId: identity.projectId, deviceId: identity.deviceId })
const connectionId = randomUUID()
const accessId = createHash('sha256').update(`${identityKey(grantee)}\n${connectionId}`).digest('hex')
let storage: MailStore | undefined
let service: MailOAuthService | undefined
try {
  storage = new MailStore({ dataDir: directory, key })
  await storage.ready()
  // Authorization-only metadata deliberately has no provider/address/token.
  await storage.batch([
    { collection: 'connections', id: connectionId, owner: identityKey(owner), value: { id: connectionId, identity: owner, readInbox: true, enabled: true } },
    { collection: 'access', id: accessId, owner: identityKey(grantee), account: connectionId,
      value: { connectionId, identity: grantee, send: true, read: true, manage: false } },
  ])
  await storage.close()
  service = new MailOAuthService({ dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' })
  await service.ready()
  service.startWorkers(active)
  assert.equal((await service.list(grantee)).connections.length, 1, 'explicit share is visible while its original owner is active')
  const unsendable = { to: [], subject: '', text: '', idempotencyKey: randomUUID() }
  await assert.rejects(service.send(grantee, connectionId, unsendable, () => active(grantee)), error => error instanceof MailOAuthError && error.code === 'message', 'active owner permits the grant through to validation without any provider request')
  assert.ok(roster.setMemberRole({ actorMemberId: admin.member.memberId, targetMemberId: owner.memberId, role: 'viewer' }).ok)
  assert.deepEqual((await service.list(grantee)).connections, [], 'owner downgrade hides shares')
  assert.ok(roster.setMemberRole({ actorMemberId: admin.member.memberId, targetMemberId: owner.memberId, role: 'member' }).ok)
  assert.equal((await service.list(grantee)).connections.length, 1, 'restoring active owner authority preserves the explicit grant')
  // Exercise the actual production gate after its asynchronous SQLite snapshot;
  // never override its implementation or invoke the provider request function.
  const gateService = service as unknown as { requestGate(owner: MailIdentity, id: string, check: () => boolean, permission: 'send' | 'read'): { before(): Promise<void>; authorized(): boolean } }
  const gates = ['send', 'read'].map(permission => gateService.requestGate(grantee, connectionId, () => active(grantee), permission as 'send' | 'read'))
  for (const gate of gates) { await gate.before(); assert.equal(gate.authorized(), true) }
  assert.ok(roster.revokeSession({ actorMemberId: admin.member.memberId, targetMemberId: owner.memberId, deviceId: owner.deviceId }).ok)
  assert.equal(active(grantee), true, 'grantee remains independently authenticated')
  for (const gate of gates) assert.equal(gate.authorized(), false, 'owner device revocation invalidates already-read send/read gates synchronously')
  assert.deepEqual((await service.list(grantee)).connections, [])
  const denied = (error: unknown) => error instanceof MailOAuthError && error.code === 'not_found'
  await assert.rejects(service.send(grantee, connectionId, unsendable, () => active(grantee)), denied)
  await assert.rejects(service.inbox(grantee, connectionId, () => active(grantee)), denied)
  assert.ok(roster.leaveTeam(owner.memberId).ok)
  assert.deepEqual((await service.list(grantee)).connections, [], 'removing the original member cannot leave an accessible orphaned credential')
  await service.close()
  console.log('PASS: real roster downgrade/restoration, owning-device revocation, member removal, explicit grants, final send/read gates and private list filtering; no provider requests')
} finally {
  await service?.close().catch(() => undefined)
  await storage?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
}
