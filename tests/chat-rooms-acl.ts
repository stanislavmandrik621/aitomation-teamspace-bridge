/**
 * Chat room registry ACL helpers.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  CHAT_ROOM_INVITE_TTL_MS,
  ChatRoomsStore,
  canAddRoomMembers,
  canEditRoomInfo,
  canPinRoomMessages,
} from '../src/chat-rooms-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-rooms-acl-'))
try {
  const rooms = new ChatRoomsStore(dir, null)

  assert.equal(rooms.memberCanAccess(CHAT_ROOM_TEAM, 'any-member'), true)
  assert.equal(rooms.memberCanAccess('chat:nope', 'x'), false)

  const dm = rooms.getOrCreateDm('alice', 'bob')
  assert.ok(!('error' in dm))
  if ('error' in dm) throw new Error(dm.error)
  assert.equal(rooms.memberCanAccess(dm.id, 'alice'), true)
  assert.equal(rooms.memberCanAccess(dm.id, 'carol'), false)

  const group = rooms.createGroup({
    kind: 'group',
    title: 'Design',
    createdBy: 'alice',
    memberIds: ['bob'],
  })
  assert.ok(!('error' in group))
  if ('error' in group) throw new Error(group.error)
  assert.equal(rooms.memberCanAccess(group.id, 'bob'), true)
  assert.equal(rooms.memberCanAccess(group.id, 'carol'), false)

  const listed = rooms.listForMember('alice')
  assert.ok(listed.some((r) => r.id === CHAT_ROOM_TEAM))
  assert.ok(listed.some((r) => r.id === dm.id))

  rooms.leave(dm.id, 'alice')
  assert.equal(rooms.memberCanAccess(dm.id, 'alice'), false)

  const priv = rooms.createGroup({
    kind: 'private',
    title: 'Secret',
    createdBy: 'alice',
    memberIds: ['bob'],
    password: 'correct-horse',
  })
  assert.ok(!('error' in priv))
  if ('error' in priv) throw new Error(priv.error)
  const minted = rooms.mintInviteToken(priv.id)
  assert.ok(!('error' in minted))
  if ('error' in minted) throw new Error(minted.error)
  assert.ok(minted.token.length >= 16)
  const redeemed = rooms.redeemInvite(minted.token, 'carol')
  assert.ok(!('error' in redeemed))
  if ('error' in redeemed) throw new Error(redeemed.error)
  assert.equal(redeemed.id, priv.id)
  assert.equal(rooms.memberCanAccess(priv.id, 'carol'), true)
  const rotated = rooms.mintInviteToken(priv.id)
  assert.ok(!('error' in rotated))
  if ('error' in rotated) throw new Error(rotated.error)
  const stale = rooms.redeemInvite(minted.token, 'dave')
  assert.ok('error' in stale)

  const leaveOk = rooms.leave(priv.id, 'carol')
  assert.ok(!('error' in leaveOk))
  assert.equal(rooms.memberCanAccess(priv.id, 'carol'), false)
  const leaveTeam = rooms.leave(CHAT_ROOM_TEAM, 'alice')
  assert.ok('error' in leaveTeam)

  assert.equal(rooms.verifyPassword(priv.id, 'correct-horse'), true)
  const pwReset = rooms.setPassword(priv.id, 'new-secret-pass')
  assert.ok(!('error' in pwReset))
  assert.equal(rooms.verifyPassword(priv.id, 'correct-horse'), false)
  assert.equal(rooms.verifyPassword(priv.id, 'new-secret-pass'), true)
  const pwEmpty = rooms.setPassword(priv.id, '   ')
  assert.ok('error' in pwEmpty)
  const pwGroup = rooms.setPassword(group.id, 'nope')
  assert.ok('error' in pwGroup)

  const addOk = rooms.addMembers(group.id, ['carol', 'bob'])
  assert.ok(!('error' in addOk))
  if ('error' in addOk) throw new Error(addOk.error)
  assert.deepEqual(addOk.added, ['carol'])
  assert.equal(rooms.memberCanAccess(group.id, 'carol'), true)
  const addEmpty = rooms.addMembers(group.id, [])
  assert.ok('error' in addEmpty)
  const addDm = rooms.addMembers(dm.id, ['carol'])
  assert.ok('error' in addDm)
  const addTeam = rooms.addMembers(CHAT_ROOM_TEAM, ['carol'])
  assert.ok('error' in addTeam)
  const addPriv = rooms.addMembers(priv.id, ['dave'])
  assert.ok(!('error' in addPriv))
  if ('error' in addPriv) throw new Error(addPriv.error)
  assert.deepEqual(addPriv.added, ['dave'])
  assert.equal(rooms.memberCanAccess(priv.id, 'dave'), true)

  const remSelf = rooms.removeMembers(group.id, ['alice'], 'alice')
  assert.ok('error' in remSelf)
  const remOk = rooms.removeMembers(group.id, ['carol'], 'alice')
  assert.ok(!('error' in remOk))
  if ('error' in remOk) throw new Error(remOk.error)
  assert.deepEqual(remOk.removed, ['carol'])
  assert.equal(rooms.memberCanAccess(group.id, 'carol'), false)
  const remEmpty = rooms.removeMembers(group.id, [], 'alice')
  assert.ok('error' in remEmpty)
  const remDm = rooms.removeMembers(dm.id, ['bob'], 'alice')
  assert.ok('error' in remDm)
  const remTeam = rooms.removeMembers(CHAT_ROOM_TEAM, ['bob'], 'alice')
  assert.ok('error' in remTeam)
  const remPriv = rooms.removeMembers(priv.id, ['dave'], 'alice')
  assert.ok(!('error' in remPriv))
  if ('error' in remPriv) throw new Error(remPriv.error)
  assert.deepEqual(remPriv.removed, ['dave'])
  assert.equal(rooms.memberCanAccess(priv.id, 'dave'), false)

  const renameOk = rooms.setTitle(group.id, 'Design v2')
  assert.ok(!('error' in renameOk))
  if ('error' in renameOk) throw new Error(renameOk.error)
  assert.equal(renameOk.title, 'Design v2')
  assert.equal(rooms.get(group.id)?.title, 'Design v2')
  const renameEmpty = rooms.setTitle(group.id, '   ')
  assert.ok('error' in renameEmpty)
  const renameDm = rooms.setTitle(dm.id, 'Nope')
  assert.ok('error' in renameDm)
  const renameTeam = rooms.setTitle(CHAT_ROOM_TEAM, 'Nope')
  assert.ok('error' in renameTeam)
  const renamePriv = rooms.setTitle(priv.id, 'Secret 2')
  assert.ok(!('error' in renamePriv))
  if ('error' in renamePriv) throw new Error(renamePriv.error)
  assert.equal(rooms.get(priv.id)?.title, 'Secret 2')

  // TS-CHAT-011: closeRoom stamps closedAt + clears members; getOrCreateDm recreates.
  const dmClose = rooms.getOrCreateDm('eve', 'frank')
  assert.ok(!('error' in dmClose))
  if ('error' in dmClose) throw new Error(dmClose.error)
  const closed = rooms.closeRoom(dmClose.id)
  assert.ok(!('error' in closed))
  if ('error' in closed) throw new Error(closed.error)
  assert.ok(closed.closedAt > 0)
  assert.deepEqual(closed.peerIds.sort(), ['eve', 'frank'].sort())
  assert.equal(rooms.memberCanAccess(dmClose.id, 'eve'), false)
  assert.equal(rooms.memberCanAccess(dmClose.id, 'frank'), false)
  assert.ok(typeof rooms.get(dmClose.id)?.closedAt === 'number')
  assert.equal(rooms.listForMember('eve').some((r) => r.id === dmClose.id), false)
  const reopened = rooms.getOrCreateDm('eve', 'frank')
  assert.ok(!('error' in reopened))
  if ('error' in reopened) throw new Error(reopened.error)
  assert.equal(reopened.id, dmClose.id)
  assert.equal(rooms.memberCanAccess(reopened.id, 'eve'), true)
  assert.ok(!rooms.get(reopened.id)?.closedAt)
  const closeTeam = rooms.closeRoom(CHAT_ROOM_TEAM)
  assert.ok('error' in closeTeam)

  // TCC-R1145-CHAT-009: strangers cannot admit into an existing DM.
  const dmGate = rooms.getOrCreateDm('gina', 'hank')
  assert.ok(!('error' in dmGate))
  if ('error' in dmGate) throw new Error(dmGate.error)
  const strangerAdmit = rooms.admitMember(dmGate.id, 'intruder')
  assert.ok('error' in strangerAdmit, 'DM admit must refuse non-participants')
  assert.equal(rooms.memberCanAccess(dmGate.id, 'intruder'), false)

  // TCC-R1146-CHAT-002: open one-sided DM (leave without close) re-admits on create.
  const dmOneSided = rooms.getOrCreateDm('ivy', 'jade')
  assert.ok(!('error' in dmOneSided))
  if ('error' in dmOneSided) throw new Error(dmOneSided.error)
  const leftOnly = rooms.leave(dmOneSided.id, 'ivy')
  assert.ok(!('error' in leftOnly))
  assert.equal(rooms.memberCanAccess(dmOneSided.id, 'ivy'), false)
  const repaired = rooms.getOrCreateDm('ivy', 'jade')
  assert.ok(!('error' in repaired))
  if ('error' in repaired) throw new Error(repaired.error)
  assert.equal(rooms.memberCanAccess(repaired.id, 'ivy'), true)
  assert.equal(rooms.memberCanAccess(repaired.id, 'jade'), true)

  // TCC-R1146-CHAT-009 store face: closeRoom after voluntary leave path.
  const dmVol = rooms.getOrCreateDm('kate', 'liam')
  assert.ok(!('error' in dmVol))
  if ('error' in dmVol) throw new Error(dmVol.error)
  const volPeers = dmVol.memberIds.filter((id) => id !== 'kate')
  const volClosed = rooms.closeRoom(dmVol.id)
  assert.ok(!('error' in volClosed))
  if ('error' in volClosed) throw new Error(volClosed.error)
  assert.deepEqual(volClosed.peerIds.filter((id) => id !== 'kate').sort(), volPeers.sort())
  assert.equal(rooms.memberCanAccess(dmVol.id, 'liam'), false)

  // TCC-R1134-CHAT-022: room mutations must persist to disk SYNCHRONOUSLY,
  // in the same tick the mutator returns - a bridge crash right after the
  // caller's reply must never roll the room registry back to its
  // pre-mutation state on next boot. Read the on-disk file immediately,
  // with no `await`/tick in between the mutation and the read.
  const freshGroup = rooms.createGroup({
    kind: 'group',
    title: 'Sync Check',
    createdBy: 'alice',
    memberIds: ['bob'],
  })
  assert.ok(!('error' in freshGroup))
  if ('error' in freshGroup) throw new Error(freshGroup.error)
  const roomsPath = join(dir, 'chat', 'rooms.json')
  assert.equal(existsSync(roomsPath), true, 'rooms.json must exist immediately after createGroup() returns')
  const onDisk = JSON.parse(readFileSync(roomsPath, 'utf8')) as { rooms: Array<{ id: string; title: string }> }
  assert.ok(
    onDisk.rooms.some((r) => r.id === freshGroup.id && r.title === 'Sync Check'),
    'on-disk rooms.json must already contain the new room synchronously, before any microtask tick',
  )

  // TCC-R1146-CHAT-013: redeem is single-use (inviteHash cleared).
{
  const minted2 = rooms.mintInviteToken(priv.id)
  assert.ok(!('error' in minted2))
  if ('error' in minted2) throw new Error(minted2.error)
  const r1 = rooms.redeemInvite(minted2.token, 'erin')
  assert.ok(!('error' in r1))
  const r2 = rooms.redeemInvite(minted2.token, 'frank')
  assert.ok('error' in r2, 'second redeem must refuse after single-use clear')
}
// TCC-R1148-CHAT-009: password rotate clears inviteHash.
{
  const minted3 = rooms.mintInviteToken(priv.id)
  assert.ok(!('error' in minted3))
  if ('error' in minted3) throw new Error(minted3.error)
  const pw = rooms.setPassword(priv.id, 'rotate-again-pass')
  assert.ok(!('error' in pw))
  const afterPw = rooms.redeemInvite(minted3.token, 'gina')
  assert.ok('error' in afterPw, 'invite must die after password rotate')
}
// TCC-R1150-CHAT-009: leave closed / non-member refuse.
{
  const closedLeave = rooms.leave(priv.id, 'nobody')
  // priv may still be open with members - close via empty remove path separately
  const notMember = rooms.leave(group.id, 'not-a-member')
  assert.ok('error' in notMember)
}
// TCC-R1151-CHAT-009: identical title unchanged.
{
  const once = rooms.setTitle(group.id, rooms.get(group.id)?.title || 'Design v2')
  assert.ok(!('error' in once))
  if (!('error' in once)) assert.equal(once.unchanged, true)
}

// P2 group management panel: description + icon + permissions.
{
  const g = rooms.createGroup({
    kind: 'group',
    title: 'P2 Group',
    createdBy: 'owner1',
    memberIds: ['member1'],
  })
  assert.ok(!('error' in g))
  if ('error' in g) throw new Error(g.error)

  // Default permissions are wide-open ('anyone') for both axes, but
  // pinMessages defaults 'admin_only' - preserves the pre-existing hardcoded
  // chat_pin behavior instead of silently loosening it (TS-CHAT-043).
  assert.equal(g.permissions.addMembers, 'anyone')
  assert.equal(g.permissions.editInfo, 'anyone')
  assert.equal(g.permissions.pinMessages, 'admin_only')
  assert.equal(canAddRoomMembers(g, 'member1', 'member'), true)
  assert.equal(canEditRoomInfo(g, 'member1', 'member'), true)
  assert.equal(canPinRoomMessages(g, 'member1', 'member'), false, 'admin_only default refuses plain member')
  assert.equal(canPinRoomMessages(g, 'owner1', 'member'), false, 'pinMessages is role-based, not owner-based')
  assert.equal(canPinRoomMessages(g, 'member1', 'admin'), true, 'team Admin always allowed')
  assert.equal(canPinRoomMessages(g, 'member1', 'viewer'), false, 'viewers can never pin')

  // setDescription: set, unchanged on identical value, clears via '', DM/team refuse.
  const descSet = rooms.setDescription(g.id, '  Planning the launch  ')
  assert.ok(!('error' in descSet))
  if ('error' in descSet) throw new Error(descSet.error)
  assert.equal(descSet.description, 'Planning the launch')
  const descUnchanged = rooms.setDescription(g.id, 'Planning the launch')
  assert.ok(!('error' in descUnchanged))
  if (!('error' in descUnchanged)) assert.equal(descUnchanged.unchanged, true)
  const descCleared = rooms.setDescription(g.id, '')
  assert.ok(!('error' in descCleared))
  if ('error' in descCleared) throw new Error(descCleared.error)
  assert.equal(descCleared.description, '')
  const descTeamRefuse = rooms.setDescription(CHAT_ROOM_TEAM, 'nope')
  assert.ok('error' in descTeamRefuse)
  const descDmRefuse = rooms.setDescription(dm.id, 'nope')
  assert.ok('error' in descDmRefuse)

  // setIcon: preset accepted, unknown preset refused, custom sha validated,
  // unchanged short-circuit, iconRev bumps on real changes only.
  const iconPreset = rooms.setIcon(g.id, 'preset', 'blue')
  assert.ok(!('error' in iconPreset))
  if ('error' in iconPreset) throw new Error(iconPreset.error)
  assert.equal(iconPreset.iconKind, 'preset')
  assert.equal(iconPreset.iconRef, 'blue')
  assert.equal(iconPreset.iconRev, 1)
  const iconBadPreset = rooms.setIcon(g.id, 'preset', 'not-a-real-color')
  assert.ok('error' in iconBadPreset)
  const iconUnchanged = rooms.setIcon(g.id, 'preset', 'blue')
  assert.ok(!('error' in iconUnchanged))
  if (!('error' in iconUnchanged)) {
    assert.equal(iconUnchanged.unchanged, true)
    assert.equal(iconUnchanged.iconRev, 1, 'unchanged set must not bump iconRev')
  }
  const iconBadCustom = rooms.setIcon(g.id, 'custom', 'not-a-sha256')
  assert.ok('error' in iconBadCustom)
  const validSha = 'a'.repeat(64)
  const iconCustom = rooms.setIcon(g.id, 'custom', validSha)
  assert.ok(!('error' in iconCustom))
  if ('error' in iconCustom) throw new Error(iconCustom.error)
  assert.equal(iconCustom.iconKind, 'custom')
  assert.equal(iconCustom.iconRef, validSha)
  assert.equal(iconCustom.iconRev, 2, 'a real change must bump iconRev')
  const iconHex = rooms.setIcon(g.id, 'preset', '#aabbcc')
  assert.ok(!('error' in iconHex))
  if ('error' in iconHex) throw new Error(iconHex.error)
  assert.equal(iconHex.iconKind, 'preset')
  assert.equal(iconHex.iconRef, '#aabbcc')
  assert.equal(iconHex.iconRev, 3, 'hex preset is a real change')
  const iconTeamRefuse = rooms.setIcon(CHAT_ROOM_TEAM, 'preset', 'blue')
  assert.ok('error' in iconTeamRefuse)

  // setPermissions: patch one axis at a time, validate closed enum, team/dm refuse.
  const permPatch = rooms.setPermissions(g.id, { addMembers: 'owner_admin' })
  assert.ok(!('error' in permPatch))
  if ('error' in permPatch) throw new Error(permPatch.error)
  assert.equal(permPatch.permissions.addMembers, 'owner_admin')
  assert.equal(permPatch.permissions.editInfo, 'anyone', 'untouched axis must be preserved')
  assert.equal(permPatch.permissions.pinMessages, 'admin_only', 'untouched third axis must be preserved')
  const permBad = rooms.setPermissions(g.id, { editInfo: 'nonsense' as unknown as 'anyone' })
  assert.ok('error' in permBad)
  const pinPermBad = rooms.setPermissions(g.id, { pinMessages: 'nonsense' as unknown as 'anyone' })
  assert.ok('error' in pinPermBad)
  const pinPermPatch = rooms.setPermissions(g.id, { pinMessages: 'anyone' })
  assert.ok(!('error' in pinPermPatch))
  if ('error' in pinPermPatch) throw new Error(pinPermPatch.error)
  assert.equal(pinPermPatch.permissions.pinMessages, 'anyone')
  assert.equal(pinPermPatch.permissions.addMembers, 'owner_admin', 'other axes must be preserved')
  const permTeamRefuse = rooms.setPermissions(CHAT_ROOM_TEAM, { addMembers: 'anyone' })
  assert.ok('error' in permTeamRefuse)

  // canAddRoomMembers/canEditRoomInfo now gate on the tightened policy:
  // owner/admin always allowed; a plain member is refused once policy is 'owner_admin'.
  const gAfter = rooms.get(g.id)
  assert.ok(gAfter)
  if (gAfter) {
    assert.equal(canAddRoomMembers(gAfter, 'member1', 'member'), false, 'non-owner refused once addMembers=owner_admin')
    assert.equal(canAddRoomMembers(gAfter, 'owner1', 'member'), true, 'owner always allowed regardless of policy')
    assert.equal(canAddRoomMembers(gAfter, 'member1', 'admin'), true, 'team Admin always allowed regardless of policy')
    assert.equal(canEditRoomInfo(gAfter, 'member1', 'member'), true, 'editInfo policy still anyone')
    assert.equal(canPinRoomMessages(gAfter, 'member1', 'member'), true, 'pinMessages=anyone now admits a plain member')
    assert.equal(canPinRoomMessages(gAfter, 'member1', 'viewer'), false, 'viewers still refused even under anyone')
  }
}

// TS-CHAT-031: private-room invite tokens expire (24h), fail closed when the
// deadline passes, and self-heal the dead hash off the row. Legacy rows minted
// before the field existed (no `inviteExpiresAt`) count as already expired.
{
  const expRoom = rooms.createGroup({
    kind: 'private',
    title: 'Expiry',
    createdBy: 'alice',
    memberIds: [],
    password: 'expiry-room-pass',
  })
  assert.ok(!('error' in expRoom))
  if ('error' in expRoom) throw new Error(expRoom.error)

  const fresh = rooms.mintInviteToken(expRoom.id)
  assert.ok(!('error' in fresh))
  if ('error' in fresh) throw new Error(fresh.error)
  assert.equal(typeof fresh.expiresAt, 'number', 'mint must report the deadline it stamped')
  const ttl = fresh.expiresAt - Date.now()
  assert.ok(
    ttl > CHAT_ROOM_INVITE_TTL_MS - 60_000 && ttl <= CHAT_ROOM_INVITE_TTL_MS,
    `minted invite must expire in ~CHAT_ROOM_INVITE_TTL_MS, got ${ttl}ms`,
  )
  // Copy shown to the user says "24 hours" - keep the constant honest.
  assert.equal(CHAT_ROOM_INVITE_TTL_MS, 24 * 60 * 60 * 1000)

  // Backdate the deadline: redeem must refuse AND drop the stored hash.
  const liveRow = rooms.get(expRoom.id)
  assert.ok(liveRow)
  if (liveRow) liveRow.inviteExpiresAt = Date.now() - 1
  const afterExpiry = rooms.redeemInvite(fresh.token, 'mallory')
  assert.ok('error' in afterExpiry, 'expired invite must refuse')
  assert.equal(rooms.memberCanAccess(expRoom.id, 'mallory'), false)
  assert.equal(
    rooms.get(expRoom.id)?.inviteHash ?? null,
    null,
    'expired redeem must clear the dead hash off the row (self-healing GC)',
  )

  // Legacy row shape: hash present, no deadline -> treated as expired, never
  // as "never expires".
  const legacy = rooms.mintInviteToken(expRoom.id)
  assert.ok(!('error' in legacy))
  if ('error' in legacy) throw new Error(legacy.error)
  const legacyRow = rooms.get(expRoom.id)
  assert.ok(legacyRow)
  if (legacyRow) legacyRow.inviteExpiresAt = null
  const legacyRedeem = rooms.redeemInvite(legacy.token, 'mallory')
  assert.ok('error' in legacyRedeem, 'pre-TTL invite row must fail closed, not open')
  assert.equal(rooms.memberCanAccess(expRoom.id, 'mallory'), false)

  // A freshly minted token still works end-to-end.
  const good = rooms.mintInviteToken(expRoom.id)
  assert.ok(!('error' in good))
  if ('error' in good) throw new Error(good.error)
  const goodRedeem = rooms.redeemInvite(good.token, 'nadia')
  assert.ok(!('error' in goodRedeem), 'unexpired invite must still admit')
  assert.equal(rooms.memberCanAccess(expRoom.id, 'nadia'), true)
  assert.equal(
    rooms.get(expRoom.id)?.inviteExpiresAt ?? null,
    null,
    'single-use redeem must clear the deadline alongside the hash',
  )
}

console.log('chat-rooms-acl: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
