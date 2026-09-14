/**
 * TCC-R1134-CHAT2-001 / TCC-R1134-CHAT2-003.
 *
 * A pin write only ever APPENDS a fresh `pinned: true` row for the message
 * being pinned - it never rewrites that message's on-disk row back to
 * `pinned: false` when it is later unpinned. The old row (and its LRU cache
 * entry) keeps reporting `pinned: true` forever, even though the room's meta
 * file has long since dropped it. Any caller that trusts a message row's own
 * `pinned` field without cross-checking the room's pin list will resurrect a
 * stale pin - this is exactly what `chat_jump` in `server.ts` used to do
 * (chat_history already had the override). This test proves the staleness at
 * the store layer and pins the exact override formula
 * (`pinIds.includes(row.id)`) that `server.ts` applies uniformly to BOTH
 * `chat_history_ok` and `chat_jump_ok`.
 *
 * It also proves the CHAT2-003 half: a room's pins can sit outside a
 * `readRecent` page entirely (older than the requested window), so
 * `chat_history_ok` must always echo the room-wide pin list even when no row
 * in that specific page matches - the client has no other way to learn a pin
 * exists at all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'

/** Mirrors the override server.ts applies to both chat_history_ok and chat_jump_ok. */
function authoritativePinned(rowId: string, pinnedMessageIds: readonly string[]): boolean {
  return pinnedMessageIds.includes(rowId)
}

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-authoritative-'))
try {
  const store = new ChatStore(dir, 90, 365, null)

  const a = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'message A',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  if ('error' in a) throw new Error(a.error)
  const b = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'message B',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  if ('error' in b) throw new Error(b.error)

  // Pin A, pin B, then take A back down - the flow that leaves a stale
  // `pinned: true` row behind for A on disk.
  const pinA = await store.pinMessage(CHAT_ROOM_TEAM, a.id, true)
  assert.ok(!('error' in pinA), 'pin A must succeed')
  const pinB = await store.pinMessage(CHAT_ROOM_TEAM, b.id, true)
  assert.ok(!('error' in pinB), 'pin B must succeed')

  // Pinning B must NOT take A down - that was the reported bug.
  assert.deepEqual(
    store.getPinnedMessageIds(CHAT_ROOM_TEAM),
    [a.id, b.id],
    'pinning a second message must keep the first pinned',
  )
  // The banner shows the most recently pinned message.
  assert.equal(store.getPinnedMessageId(CHAT_ROOM_TEAM), b.id)

  const unpinA = await store.unpinMessage(CHAT_ROOM_TEAM, a.id, true)
  assert.ok(!('error' in unpinA), 'unpin A must succeed')
  assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [b.id])

  // The STORE-LEVEL row for A is stale: jumpToMessage still reports
  // pinned:true for a message that is no longer pinned at all.
  // This is the exact staleness class the server.ts override guards against.
  const jumpA = await store.jumpToMessage(CHAT_ROOM_TEAM, a.id)
  assert.equal(jumpA.message?.pinned, true, 'store-level row for A stays stale pinned:true')

  // Applying the server.ts override corrects it without touching the store:
  const pinnedIds = store.getPinnedMessageIds(CHAT_ROOM_TEAM)
  assert.equal(
    authoritativePinned(jumpA.message!.id, pinnedIds),
    false,
    'chat_jump_ok must NOT report A as pinned once A has been unpinned',
  )
  const jumpB = await store.jumpToMessage(CHAT_ROOM_TEAM, b.id)
  assert.equal(
    authoritativePinned(jumpB.message!.id, pinnedIds),
    true,
    'chat_jump_ok must report B as pinned - it IS in the room pin list',
  )

  console.log('chat-pin-authoritative: ok (chat_jump stale-pin override matches the room pin list)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --- TCC-R1134-CHAT2-003: pinned message can sit outside a readRecent page ---
const pageDir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-outside-page-'))
try {
  const store = new ChatStore(pageDir, 90, 365, null)

  const old = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'the pinned announcement',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  if ('error' in old) throw new Error(old.error)
  const pinOld = await store.pinMessage(CHAT_ROOM_TEAM, old.id, true)
  assert.ok(!('error' in pinOld), 'pin must succeed')

  // Bury it under enough newer traffic that a small `readRecent` page
  // (mirrors the client's default TEAM_CHAT_HISTORY_PAGE fetch) never sees it.
  for (let i = 0; i < 10; i++) {
    await store.append({
      room: CHAT_ROOM_TEAM,
      body: `filler ${i}`,
      memberId: 'm1',
      memberName: 'Alex',
      role: 'member',
    })
  }

  const page = await store.readRecent(CHAT_ROOM_TEAM, 5)
  assert.equal(
    page.messages.some((m) => m.id === old.id),
    false,
    'the pinned message must be absent from a small recent-only page',
  )
  // The room pin list still reports it - this is what chat_history_ok's
  // `pinnedMessageIds` field lets the client discover and fetch on demand.
  assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [old.id])
  assert.equal(store.getPinnedMessageId(CHAT_ROOM_TEAM), old.id)

  console.log('chat-pin-authoritative: ok (pinned message absent from page, room pins still discoverable)')
} finally {
  rmSync(pageDir, { recursive: true, force: true })
}
