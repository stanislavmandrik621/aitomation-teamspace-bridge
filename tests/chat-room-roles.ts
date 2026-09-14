/**
 * Bridge unit tests: chat room owners / ban / reaction allowlist / refuse-over-cap.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatRoomsStore,
  isReactionEmojiAllowed,
  setChatRoomMembersCap,
  getChatRoomMembersCap,
  CHAT_ROOM_MEMBERS_DEFAULT_CAP,
} from '../src/chat-rooms-store.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-room-roles-'))
try {
  setChatRoomMembersCap(CHAT_ROOM_MEMBERS_DEFAULT_CAP)
  const store = new ChatRoomsStore(dir, null)

  const created = store.createGroup({
    kind: 'group',
    title: 'Ops',
    createdBy: 'alice',
    memberIds: ['bob'],
  })
  assert.ok(!('error' in created), 'createGroup should succeed')
  assert.deepEqual(created.ownerIds, ['alice'])
  assert.deepEqual(created.bannedMemberIds, [])
  assert.deepEqual(created.allowedReactionEmojis, [])
  assert.ok(isReactionEmojiAllowed(created, '👍'))

  const capped = setChatRoomMembersCap(2)
  assert.equal(capped, 2)
  assert.equal(getChatRoomMembersCap(), 2)
  const over = store.addMembers(created.id, ['carol'])
  assert.ok('error' in over, 'add past cap must refuse')
  assert.match(String(over.error), /limit/i)
  setChatRoomMembersCap(CHAT_ROOM_MEMBERS_DEFAULT_CAP)

  const prom = store.promoteOwner(created.id, 'bob')
  assert.ok(!('error' in prom))
  assert.ok(prom.ownerIds.includes('bob'))

  // TCC-R1143-ROLE-003: co-owner cannot ban another owner without team Admin.
  const banOwnerRefuse = store.banMember(created.id, 'bob', 'alice')
  assert.ok('error' in banOwnerRefuse)
  assert.match(String(banOwnerRefuse.error), /team Admin/i)

  const banOwnerAdmin = store.banMember(created.id, 'bob', 'alice', {
    actorIsTeamAdmin: true,
  })
  assert.ok(!('error' in banOwnerAdmin))
  assert.ok(banOwnerAdmin.bannedMemberIds.includes('bob'))
  assert.ok(!banOwnerAdmin.memberIds.includes('bob'))

  const rejoin = store.admitMember(created.id, 'bob')
  assert.ok('error' in rejoin)
  assert.match(String(rejoin.error), /ban/i)

  const unban = store.unbanMember(created.id, 'bob')
  assert.ok(!('error' in unban))
  assert.ok(!unban.bannedMemberIds.includes('bob'))

  // Non-owner ban by room owner still works.
  const addCarol = store.addMembers(created.id, ['carol'])
  assert.ok(!('error' in addCarol))
  const banCarol = store.banMember(created.id, 'carol', 'alice')
  assert.ok(!('error' in banCarol))
  assert.ok(banCarol.bannedMemberIds.includes('carol'))

  const setReact = store.setAllowedReactionEmojis(created.id, ['👍', '❤️', '👍'])
  assert.ok(!('error' in setReact))
  assert.deepEqual(setReact.allowedReactionEmojis, ['👍', '❤️'])
  const row = store.get(created.id)!
  assert.equal(isReactionEmojiAllowed(row, '👍'), true)
  assert.equal(isReactionEmojiAllowed(row, '😂'), false)

  // TCC-R1148-CHAT-011: sole owner demote refuses (no empty ownerIds).
  const sole = store.demoteOwner(created.id, 'alice', { allowLastOwner: false })
  assert.ok('error' in sole)
  assert.match(String(sole.error), /last room owner/i)

  // Backfill ownerIds on load
  const store2 = new ChatRoomsStore(dir, null)
  const again = store2.get(created.id)
  assert.ok(again)
  assert.ok(again!.ownerIds.length >= 1)

  // TCC-R1150-CHAT-011: closed room refuses unban (after other open-room checks).
  store.closeRoom(created.id)
  const unbanClosed = store.unbanMember(created.id, 'carol')
  assert.ok('error' in unbanClosed)
  assert.match(String(unbanClosed.error), /closed/i)

  // ── Owner/admin succession (additive pass): sole-owner leave is blocked
  // while other members remain, forced bypass still succeeds with
  // succession, and dissolve is the explicit "end for everyone" escape.
  {
    const succ = new ChatRoomsStore(mkdtempSync(join(tmpdir(), 'ts-room-succ-')), null)
    const g = succ.createGroup({ kind: 'group', title: 'Succession', createdBy: 'owner1', memberIds: ['m2', 'm3'] })
    assert.ok(!('error' in g))
    assert.deepEqual(g.ownerIds, ['owner1'])

    // Sole owner voluntarily leaving while 2 other members remain: BLOCKED,
    // and the room must be untouched (no member removed, no ownership change).
    const blocked = succ.leave(g.id, 'owner1')
    assert.ok('error' in blocked, 'sole owner leave with others remaining must be refused')
    assert.equal(blocked.requiresOwnerAction, true, 'refusal must carry requiresOwnerAction so the client can offer transfer/dissolve')
    const afterBlocked = succ.get(g.id)!
    assert.deepEqual(afterBlocked.ownerIds, ['owner1'], 'blocked leave must not change ownerIds')
    assert.ok(afterBlocked.memberIds.includes('owner1'), 'blocked leave must not remove the member')

    // Promote a co-owner first (the "transfer" escape) - now leave succeeds
    // because the room is no longer down to a single owner.
    const promoted = succ.promoteOwner(g.id, 'm2')
    assert.ok(!('error' in promoted))
    const leftAfterTransfer = succ.leave(g.id, 'owner1')
    assert.ok(!('error' in leftAfterTransfer), 'leave succeeds once ownership was transferred first')
    const afterTransfer = succ.get(g.id)!
    assert.deepEqual(afterTransfer.ownerIds, ['m2'], 'remaining owner is the promoted co-owner, not an arbitrary member')
    assert.ok(!afterTransfer.memberIds.includes('owner1'))

    // Forced bypass (team-departure path): sole owner leaving via `forced`
    // must succeed AND auto-succeed ownership to the earliest-joined
    // remaining member, never leaving the room ownerless.
    const g2 = succ.createGroup({ kind: 'group', title: 'ForcedLeave', createdBy: 'sole', memberIds: ['next', 'last'] })
    assert.ok(!('error' in g2))
    const forced = succ.leave(g2.id, 'sole', { forced: true })
    assert.ok(!('error' in forced), 'forced leave (team departure) must never be blocked by the sole-owner guard')
    const afterForced = succ.get(g2.id)!
    assert.deepEqual(afterForced.ownerIds, ['next'], 'earliest-joined remaining member auto-succeeds as owner')
    assert.ok(!afterForced.memberIds.includes('sole'))

    // Dissolve: closeRoom reused as the explicit "end for everyone" action -
    // clears membership and stamps closedAt (server.ts gates this on
    // canManageRoom before calling it; the store method itself is generic).
    const g3 = succ.createGroup({ kind: 'group', title: 'Dissolve', createdBy: 'owner3', memberIds: ['m4'] })
    assert.ok(!('error' in g3))
    const dissolved = succ.closeRoom(g3.id)
    assert.ok(!('error' in dissolved))
    assert.deepEqual(dissolved.peerIds.sort(), ['m4', 'owner3'].sort(), 'dissolve reports every member who must be notified')
    const afterDissolve = succ.get(g3.id)!
    assert.ok(typeof afterDissolve.closedAt === 'number' && afterDissolve.closedAt > 0)
    assert.deepEqual(afterDissolve.memberIds, [])

    // Last member (not sole-owner-with-others case) leaving still closes the room.
    const g4 = succ.createGroup({ kind: 'group', title: 'SoloLeave', createdBy: 'lonely', memberIds: [] })
    assert.ok(!('error' in g4))
    const soloLeave = succ.leave(g4.id, 'lonely')
    assert.ok(!('error' in soloLeave), 'sole owner leaving with NO other members remaining is not blocked (room just closes)')
    assert.ok(typeof succ.get(g4.id)!.closedAt === 'number')

    // TS-CHAT-033: banning an owner who is NOT a current member (the load
    // back-fill seeds `ownerIds:[createdBy]` for pre-ownerIds rooms even when
    // the creator already left) must still leave a real owner behind -
    // `removeMembers`' succession never runs on that path because there is no
    // membership to remove.
    const g5 = succ.createGroup({ kind: 'group', title: 'GhostOwner', createdBy: 'ghost', memberIds: ['stayer'] })
    assert.ok(!('error' in g5))
    const ghostRow = succ.get(g5.id)!
    // Simulate a legacy row: creator left in an older release that did not
    // keep ownerIds in sync with memberIds.
    ghostRow.memberIds = ['stayer']
    assert.deepEqual(ghostRow.ownerIds, ['ghost'], 'precondition: owner is not a member')
    const banGhost = succ.banMember(g5.id, 'ghost', 'stayer', { actorIsTeamAdmin: true })
    assert.ok(!('error' in banGhost))
    const afterGhostBan = succ.get(g5.id)!
    assert.ok(afterGhostBan.memberIds.length > 0, 'members remain')
    assert.deepEqual(
      afterGhostBan.ownerIds,
      ['stayer'],
      'banning a non-member owner must succeed ownership to the earliest-joined remaining member, never empty ownerIds',
    )

    // Load heals a persisted ghost owner (createdBy back-fill after they left)
    // so the room is not orphaned until someone happens to ban that ghost.
    const healDir = mkdtempSync(join(tmpdir(), 'ts-room-heal-'))
    const healer = new ChatRoomsStore(healDir, null)
    const gHeal = healer.createGroup({
      kind: 'group',
      title: 'HealLoad',
      createdBy: 'ghost',
      memberIds: ['stayer'],
    })
    assert.ok(!('error' in gHeal))
    const roomsPath = join(healDir, 'chat', 'rooms.json')
    const disk = JSON.parse(readFileSync(roomsPath, 'utf8')) as {
      rooms: Array<{ id: string; memberIds: string[]; ownerIds: string[] }>
    }
    const healRow = disk.rooms.find((r) => r.id === gHeal.id)
    assert.ok(healRow)
    healRow.memberIds = ['stayer']
    healRow.ownerIds = ['ghost']
    writeFileSync(roomsPath, JSON.stringify(disk), 'utf8')
    const reloaded = new ChatRoomsStore(healDir, null)
    assert.deepEqual(
      reloaded.get(gHeal.id)?.ownerIds,
      ['stayer'],
      'load must re-seed a real in-room owner when ownerIds is a leftover non-member',
    )
    rmSync(healDir, { recursive: true, force: true })

    // Last-owner demote with allowLastOwner must succeed ownership, never empty.
    const g6 = succ.createGroup({
      kind: 'group',
      title: 'DemoteLast',
      createdBy: 'sole',
      memberIds: ['next'],
    })
    assert.ok(!('error' in g6))
    const demoted = succ.demoteOwner(g6.id, 'sole', { allowLastOwner: true })
    assert.ok(!('error' in demoted))
    assert.deepEqual(
      demoted.ownerIds,
      ['next'],
      'allowLastOwner demote must succeed to another member, never empty ownerIds',
    )

    // Unreadable rooms.json must not be overwritten by the team-room seed.
    const badDir = mkdtempSync(join(tmpdir(), 'ts-room-bad-'))
    mkdirSync(join(badDir, 'chat'), { recursive: true })
    const badPath = join(badDir, 'chat', 'rooms.json')
    const badBody = '{"rooms":"nope"}'
    writeFileSync(badPath, badBody, 'utf8')
    const badStore = new ChatRoomsStore(badDir, null)
    const refused = badStore.createGroup({
      kind: 'group',
      title: 'MustNotLand',
      createdBy: 'alice',
      memberIds: [],
    })
    assert.ok('error' in refused, 'create must refuse when rooms.json is unreadable')
    assert.equal(readFileSync(badPath, 'utf8'), badBody, 'unreadable rooms.json must not be overwritten')
    rmSync(badDir, { recursive: true, force: true })
  }

  console.log('chat-room-roles: ok')
} finally {
  setChatRoomMembersCap(CHAT_ROOM_MEMBERS_DEFAULT_CAP)
  rmSync(dir, { recursive: true, force: true })
}
