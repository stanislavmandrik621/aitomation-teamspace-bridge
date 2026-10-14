import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import { shareOwnedComposeBoard, composeBoardManagement } from '../src/compose-board-sharing.js'
import { configureComposeAclStore, hasComposeDocShare, isComposeDocSharedWithMember, removeComposeAclMembers, reconcileComposeAclMembers } from '../src/compose-acl-store.js'

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'compose-member-sharing-'))
  try {
    let store = new BridgeStore(dir, 21, null, null)
    configureComposeAclStore(dir)
    const connectCheck = () => store.contentAccess.setComposeAccessCheck((id, member, role) => role === 'admin' ? hasComposeDocShare(id) : isComposeDocSharedWithMember(id, member))
    connectCheck()
    const admin = store.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', displayName: 'Admin' })
    assert(admin.ok)
    const people: Record<string, string> = { admin: admin.member.memberId }
    for (const [name, role] of [['bob', 'member'], ['vera', 'viewer'], ['other', 'member']] as const) {
      const invite = store.createInvite(people.admin, `${name}@fixture.invalid`, role); assert(invite.ok)
      const joined = await store.redeemInvite({ token: invite.invite.token, deviceId: name, displayName: name }); assert(joined.ok)
      people[name] = joined.member.memberId
    }
    const request = (documentId: string, memberIds: string[] | null) => ({ documentId, memberIds,
      snapshot: { id: documentId, title: 'Editable campaign', tipRev: 1, schemaVersion: 1, graphJson: JSON.stringify({ schemaVersion: 1, blocks: { headline: { kind: 'text', props: { text: 'Hello' } } } }) } })
    const blob = 'a'.repeat(64)
    store.contentAccess.noteUpload(blob, people.bob)
    const media = request('media-board', [people.vera])
    media.snapshot.graphJson = JSON.stringify({ blocks: { photo: { props: { src: { __teamspaceBlob: blob, name: 'test.png' } } } } })
    assert(shareOwnedComposeBoard(store, people.bob, 'member', media).ok)
    assert(store.contentAccess.mayReadBlob(blob, people.vera, 'viewer'), 'structured scene media follows the board grant')
    assert(!store.contentAccess.mayReadBlob(blob, people.other, 'member'))
    assert(shareOwnedComposeBoard(store, people.bob, 'member', { documentId: 'media-board', remove: true }).ok)
    assert(!store.contentAccess.mayReadBlob(blob, people.vera, 'viewer'), 'revoking a board also revokes its attachment grant')
    assert(!shareOwnedComposeBoard(store, people.bob, 'member', media).ok, 'an old digest alone cannot restore revoked attachment access')
    store.contentAccess.noteUpload(blob, people.bob)
    assert(!store.contentAccess.mayReadBlob(blob, people.vera, 'viewer'), 'fresh owner upload does not reopen a revoked viewer download')
    assert(!store.contentAccess.mayAttachBlob(blob, people.other, 'member'), 'another member cannot use the owner staging grant')
    assert(shareOwnedComposeBoard(store, people.bob, 'member', media).ok, 'the owner can re-share the same saved image after fresh upload')
    assert(store.contentAccess.mayReadBlob(blob, people.vera, 'viewer'))
    assert(shareOwnedComposeBoard(store, people.bob, 'member', { documentId: 'media-board', remove: true }).ok)
    assert(!store.contentAccess.mayAttachBlob(blob, people.bob, 'member'), 'the consumed upload grant must not survive another revoke')
    const result = shareOwnedComposeBoard(store, people.bob, 'member', request('bob-board', [people.vera]))
    assert(result.ok, JSON.stringify(result))
    const snapshot = result.ops.find(op => op.kind === 'compose.doc.create')!
    assert(snapshot)
    assert(store.contentAccess.mayRead(snapshot, people.bob, 'member'), 'author remains in the exact audience')
    assert(store.contentAccess.mayRead(snapshot, people.vera, 'viewer'))
    assert(store.contentAccess.mayRead(snapshot, people.admin, 'admin'), 'Admin sees every shared board')
    assert(!store.contentAccess.mayRead(snapshot, people.other, 'member'))
    assert(!composeBoardManagement(store, 'bob-board', people.vera, 'viewer').canManage, 'a recipient cannot take over another board')
    assert(!shareOwnedComposeBoard(store, people.other, 'member', request('bob-board', null)).ok)
    assert(shareOwnedComposeBoard(store, people.vera, 'viewer', request('vera-board', [people.bob])).ok, 'a Viewer may publish their own existing board without being promoted')
    assert.match(store.contentAccess.authorize({ ...snapshot, opId: 'viewer-forgery' }, people.vera, 'viewer')!, /revoked|granted/, 'ordinary viewer writes remain forbidden')
    assert(!shareOwnedComposeBoard(store, people.bob, 'member', request('bad-audience', ['missing-member'])).ok)
    assert(!hasComposeDocShare('bad-audience'))
    assert(!shareOwnedComposeBoard(store, people.bob, 'member', { ...request('bad-scene', null), snapshot: { id: 'bad-scene', graphJson: '{bad' } }).ok)
    assert(!hasComposeDocShare('bad-scene'))
    assert(shareOwnedComposeBoard(store, people.bob, 'member', { documentId: 'bob-board', remove: true }).ok)
    assert(!hasComposeDocShare('bob-board'))
    assert(store.contentAccess.cleanupNotices().some(op => op.targetId === 'bob-board' && op.visibleToMemberIds?.includes(people.admin)), 'unshare cleans Admin recipient copies too')
    assert(!composeBoardManagement(store, 'bob-board', people.admin, 'admin').canManage, 'Admin cannot reopen the author’s now-private board')
    assert(!store.contentAccess.mayRead(snapshot, people.admin, 'admin'), 'unshared historical content is not replayed to Admin')
    assert(!shareOwnedComposeBoard(store, people.other, 'member', request('bob-board', null)).ok, 'a revoke tombstone retains ownership')
    store = new BridgeStore(dir, 21, null, null); configureComposeAclStore(dir); connectCheck()
    assert(composeBoardManagement(store, 'bob-board', people.bob, 'member').canManage, 'ownership survives a server restart')
    assert(!composeBoardManagement(store, 'bob-board', people.other, 'member').canManage)
    assert(shareOwnedComposeBoard(store, people.bob, 'member', request('bob-board', [people.vera])).ok)
    const beforeRemoval = store.createInvite(people.admin, 'bob@fixture.invalid', 'member'); assert(beforeRemoval.ok)
    assert(store.kickMember(people.admin, people.bob).ok)
    assert(!(await store.redeemInvite({ token: beforeRemoval.invite.token, deviceId: 'another-bob-device' })).ok, 'removal also cancels outstanding invitations for that person')
    // Simulate a process crash after roster commit but before ACL handover.
    store = new BridgeStore(dir, 21, null, null); configureComposeAclStore(dir); connectCheck()
    assert(reconcileComposeAclMembers(store.listMembers()).ok)
    assert(composeBoardManagement(store, 'bob-board', people.admin, 'admin').canManage)
    assert.equal(composeBoardManagement(store, 'bob-board', people.bob, 'member').ownerMemberId, people.admin, 'departing owner hands shared boards to remaining Admin')
    assert(hasComposeDocShare('bob-board'), 'team keeps the board after owner departure')
    assert(!isComposeDocSharedWithMember('bob-board', people.bob))
    assert(!hasComposeDocShare('bob-private'), 'private boards are never uploaded or transferred')
    store = new BridgeStore(dir, 21, null, null); configureComposeAclStore(dir); connectCheck()
    assert.equal(composeBoardManagement(store, 'bob-board', people.admin, 'admin').ownerMemberId, people.admin)
    assert(!composeBoardManagement(store, 'bob-board', people.bob, 'member').canManage)

    const cancelled = store.createInvite(people.admin, 'bob@fixture.invalid', 'member'); assert(cancelled.ok)
    assert(store.cancelInvite(cancelled.invite.id).ok)
    assert(!(await store.redeemInvite({ token: cancelled.invite.token, deviceId: 'bob', memberEmail: 'bob@fixture.invalid' })).ok, 'a revoked invitation cannot be reused')
    const fresh = store.createInvite(people.admin, 'bob@fixture.invalid', 'viewer'); assert(fresh.ok)
    const returned = await store.redeemInvite({ token: fresh.invite.token, deviceId: 'bob', memberEmail: 'bob@fixture.invalid' }); assert(returned.ok)
    assert.notEqual(returned.member.memberId, people.bob, 'returning person receives a new membership, even on the same device/email')
    assert.equal(returned.member.role, 'viewer')
    assert(!isComposeDocSharedWithMember('bob-board', returned.member.memberId), 'old exact audience does not restore itself')
    assert(!composeBoardManagement(store, 'bob-board', returned.member.memberId, 'viewer').canManage, 'transferred ownership is not restored by rejoining')
    assert(shareOwnedComposeBoard(store, people.admin, 'admin', request('everyone-board', null)).ok)
    assert(isComposeDocSharedWithMember('everyone-board', returned.member.memberId), 'current whole-team shares include returning members')
    assert(!shareOwnedComposeBoard(store, returned.member.memberId, 'viewer', { documentId: 'unknown-delete', remove: true }).ok)
    assert(!composeBoardManagement(store, 'unknown-delete', people.other, 'member').known, 'unknown revoke cannot reserve another board ID')
    console.log('PASS: member/viewer publishing, exact recipients, Admin visibility, foreign-owner denial, revoke, restart, departure transfer')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
