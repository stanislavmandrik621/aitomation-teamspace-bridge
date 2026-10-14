/**
 * TS-CHAT-075 - a room keeps every pinned message, not just the last one.
 *
 * Covers the reported bug ("one pinned message erased another") plus the
 * contracts around the fix:
 *   - several messages stay pinned at once, in pin order, oldest first
 *   - pin and unpin are independent: unpinning one leaves the rest alone
 *   - both are idempotent and report `unchanged` rather than failing
 *   - a full room refuses the new pin instead of dropping the oldest
 *   - a room saved by an older build keeps its one pin when read back
 *   - pins survive a restart, and removing or ageing out a pinned message
 *     drops only that pin
 *   - the "only Admin can pin" store gate still refuses a non-admin caller
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { chatRoomDir } from '../src/chat-room-path.js'
import { ChatStore } from '../src/chat-store.js'
import {
  CHAT_PINS_FULL_ERROR,
  CHAT_ROOM_PINS_MAX,
  addChatRoomPin,
  buildChatRoomPinMeta,
  newestChatRoomPin,
  readChatRoomPinIds,
  removeChatRoomPin,
} from '../src/chat-room-pins.js'

type Appended = { id: string }

async function say(store: ChatStore, body: string): Promise<Appended> {
  const row = await store.append({
    room: CHAT_ROOM_TEAM,
    body,
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  if ('error' in row) throw new Error(row.error)
  return row
}

// --- leaf: list maths, migration, ceiling ---
{
  assert.deepEqual(readChatRoomPinIds({ pinnedMessageId: 'old-one' }), ['old-one'])
  assert.deepEqual(readChatRoomPinIds({ pinnedMessageId: null }), [])
  assert.deepEqual(readChatRoomPinIds({}), [])
  assert.deepEqual(readChatRoomPinIds(null), [])
  // A file already in the new shape wins over the legacy key it carries for
  // older servers, so a round trip through this build is stable.
  assert.deepEqual(
    readChatRoomPinIds({ pinnedMessageIds: ['a', 'b'], pinnedMessageId: 'b' }),
    ['a', 'b'],
  )
  // Explicit empty list means nothing is pinned, even with a legacy key beside it.
  assert.deepEqual(readChatRoomPinIds({ pinnedMessageIds: [], pinnedMessageId: 'b' }), [])
  // Hand-edited junk cannot produce a bad list.
  assert.deepEqual(readChatRoomPinIds({ pinnedMessageIds: ['a', 'a', '', 42, null, 'b'] }), ['a', 'b'])

  assert.equal(newestChatRoomPin([]), null)
  assert.equal(newestChatRoomPin(['a', 'b']), 'b')

  const added = addChatRoomPin(['a'], 'b')
  assert.ok('ok' in added && added.changed)
  assert.deepEqual('ok' in added ? added.ids : [], ['a', 'b'])
  const again = addChatRoomPin(['a', 'b'], 'b')
  assert.ok('ok' in again && again.changed === false, 'already pinned is unchanged, not an error')

  const removed = removeChatRoomPin(['a', 'b', 'c'], 'b')
  assert.deepEqual('ok' in removed ? removed.ids : [], ['a', 'c'], 'unpin keeps the rest in order')
  const removeMissing = removeChatRoomPin(['a'], 'zzz')
  assert.ok('ok' in removeMissing && removeMissing.changed === false, 'unpinning a loose id is a no-op')

  const full = Array.from({ length: CHAT_ROOM_PINS_MAX }, (_, i) => `m${i}`)
  const overflow = addChatRoomPin(full, 'one-too-many')
  assert.ok('error' in overflow, 'a full room refuses the new pin')
  assert.equal('error' in overflow ? overflow.error : '', CHAT_PINS_FULL_ERROR)
  // Refusing must not have quietly evicted anything.
  assert.equal(full.length, CHAT_ROOM_PINS_MAX)
  assert.equal(full[0], 'm0')

  const meta = buildChatRoomPinMeta(['a', 'b'])
  assert.deepEqual(meta.pinnedMessageIds, ['a', 'b'])
  assert.equal(meta.pinnedMessageId, 'b', 'legacy key carries the newest pin for older servers')

  console.log('chat-pin-multi: ok (pin list maths, legacy migration, ceiling refusal)')
}

// --- store: several pins retained, independent, idempotent ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-multi-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    const a = await say(store, 'rules of the room')
    const b = await say(store, 'this sprint goal')
    const c = await say(store, 'link to the handbook')

    const pinA = await store.pinMessage(CHAT_ROOM_TEAM, a.id, true)
    assert.ok('ok' in pinA && pinA.pinnedIds.length === 1)
    const pinB = await store.pinMessage(CHAT_ROOM_TEAM, b.id, true)
    assert.ok('ok' in pinB)
    const pinC = await store.pinMessage(CHAT_ROOM_TEAM, c.id, true)
    assert.ok('ok' in pinC)

    // The reported bug: pinning B used to erase A.
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id, b.id, c.id])
    assert.equal(store.getPinnedMessageId(CHAT_ROOM_TEAM), c.id, 'banner shows the newest pin')

    // Idempotent pin.
    const rePinB = await store.pinMessage(CHAT_ROOM_TEAM, b.id, true)
    assert.ok('ok' in rePinB && rePinB.unchanged === true, 'pinning again is unchanged, not an error')
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id, b.id, c.id])

    // Unpin the middle one - the others stay put, in order.
    const unpinB = await store.unpinMessage(CHAT_ROOM_TEAM, b.id, true)
    assert.ok('ok' in unpinB && unpinB.unchanged !== true)
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id, c.id])

    // Idempotent unpin.
    const unpinBAgain = await store.unpinMessage(CHAT_ROOM_TEAM, b.id, true)
    assert.ok('ok' in unpinBAgain && unpinBAgain.unchanged === true)
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id, c.id])

    // A client built before multi-pin can only say "unpin" - that means the newest.
    const unpinNewest = await store.unpinMessage(CHAT_ROOM_TEAM, null, true)
    assert.ok('ok' in unpinNewest)
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id])

    // Unpinning with nothing left named is a no-op, never an error.
    await store.unpinMessage(CHAT_ROOM_TEAM, a.id, true)
    const unpinEmpty = await store.unpinMessage(CHAT_ROOM_TEAM, null, true)
    assert.ok('ok' in unpinEmpty && unpinEmpty.unchanged === true)
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [])

    // Store gate: a caller without permission is refused on both paths.
    const refusedPin = await store.pinMessage(CHAT_ROOM_TEAM, a.id, false)
    assert.ok('error' in refusedPin, 'pin must refuse a caller the server did not clear')
    const refusedUnpin = await store.unpinMessage(CHAT_ROOM_TEAM, a.id, false)
    assert.ok('error' in refusedUnpin, 'unpin must refuse a caller the server did not clear')

    // A message that is not in the room cannot be pinned.
    const bogus = await store.pinMessage(CHAT_ROOM_TEAM, 'no-such-message', true)
    assert.ok('error' in bogus)

    console.log('chat-pin-multi: ok (several pins retained, independent and idempotent)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- store: pins survive a restart, deleting a pinned message drops one pin ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-multi-restart-'))
  try {
    const first = new ChatStore(dir, 90, 365, null)
    const a = await say(first, 'first')
    const b = await say(first, 'second')
    await first.pinMessage(CHAT_ROOM_TEAM, a.id, true)
    await first.pinMessage(CHAT_ROOM_TEAM, b.id, true)

    // Same data dir, fresh store - what a bridge restart looks like.
    const restarted = new ChatStore(dir, 90, 365, null)
    assert.deepEqual(
      restarted.getPinnedMessageIds(CHAT_ROOM_TEAM),
      [a.id, b.id],
      'pins must survive a restart',
    )

    const del = await restarted.softDelete(a.id, 'm1', CHAT_ROOM_TEAM)
    assert.ok(!('error' in del))
    assert.deepEqual(
      restarted.getPinnedMessageIds(CHAT_ROOM_TEAM),
      [b.id],
      'removing a pinned message drops only its own pin',
    )

    // A removed message must stay unpinnable.
    const rePinDeleted = await restarted.pinMessage(CHAT_ROOM_TEAM, a.id, true)
    assert.ok('error' in rePinDeleted)

    console.log('chat-pin-multi: ok (pins survive a restart, delete drops only that pin)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- migration: a room written by an older single-pin build keeps its pin ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-multi-migrate-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    const a = await say(store, 'pinned by the old build')
    const b = await say(store, 'pinned after the upgrade')

    // Rewrite the room meta in the exact shape the previous build wrote.
    const roomDir = chatRoomDir(dir, CHAT_ROOM_TEAM)
    assert.ok(roomDir, 'room dir must resolve')
    mkdirSync(roomDir, { recursive: true })
    const metaFile = join(roomDir, 'room-meta.json')
    writeFileSync(metaFile, JSON.stringify({ pinnedMessageId: a.id, updatedAt: Date.now() }), 'utf8')

    // Read-side migration: the old pin comes back as a one-entry list, and
    // reading alone must not rewrite the file.
    const beforeBytes = readFileSync(metaFile, 'utf8')
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id])
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id], 'reading twice is stable')
    assert.equal(readFileSync(metaFile, 'utf8'), beforeBytes, 'a read must not rewrite the file')

    // The next pin keeps the migrated one rather than replacing it.
    const pinB = await store.pinMessage(CHAT_ROOM_TEAM, b.id, true)
    assert.ok('ok' in pinB)
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [a.id, b.id])

    // And the file now carries both shapes, so a rolled-back server still
    // finds the most recent pin instead of nothing.
    const written = JSON.parse(readFileSync(metaFile, 'utf8')) as Record<string, unknown>
    assert.deepEqual(written.pinnedMessageIds, [a.id, b.id])
    assert.equal(written.pinnedMessageId, b.id)

    console.log('chat-pin-multi: ok (legacy single pin migrates without a destructive rewrite)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- ceiling, end to end through the store ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-multi-cap-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    const ids: string[] = []
    for (let i = 0; i < CHAT_ROOM_PINS_MAX + 1; i++) {
      ids.push((await say(store, `notice ${i}`)).id)
    }
    for (let i = 0; i < CHAT_ROOM_PINS_MAX; i++) {
      const res = await store.pinMessage(CHAT_ROOM_TEAM, ids[i], true)
      assert.ok('ok' in res, `pin ${i} must succeed`)
    }
    const overflow = await store.pinMessage(CHAT_ROOM_TEAM, ids[CHAT_ROOM_PINS_MAX], true)
    assert.ok('error' in overflow, 'a full room refuses rather than evicting')
    assert.equal('error' in overflow ? overflow.error : '', CHAT_PINS_FULL_ERROR)
    const after = store.getPinnedMessageIds(CHAT_ROOM_TEAM)
    assert.equal(after.length, CHAT_ROOM_PINS_MAX)
    assert.equal(after[0], ids[0], 'the oldest pin must still be there after a refusal')

    // Making room lets the next pin through.
    await store.unpinMessage(CHAT_ROOM_TEAM, ids[0], true)
    const nowFits = await store.pinMessage(CHAT_ROOM_TEAM, ids[CHAT_ROOM_PINS_MAX], true)
    assert.ok('ok' in nowFits)
    assert.equal(store.getPinnedMessageId(CHAT_ROOM_TEAM), ids[CHAT_ROOM_PINS_MAX])

    console.log('chat-pin-multi: ok (room ceiling refuses instead of evicting the oldest)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- TS-CHAT-142: removing a pinned message must reach the other members ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-pin-unsend-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    const notice = await say(store, 'read this before Friday')
    const other = await say(store, 'and this one too')
    assert.ok('ok' in (await store.pinMessage(CHAT_ROOM_TEAM, notice.id, true)))
    assert.ok('ok' in (await store.pinMessage(CHAT_ROOM_TEAM, other.id, true)))
    assert.deepEqual(store.getPinnedMessageIds(CHAT_ROOM_TEAM), [notice.id, other.id])

    // The author takes their own pinned message back. The store drops that
    // one pin in the same write - which is exactly why the team server has
    // to tell everyone else, or they keep a pin nobody can open.
    const unsent = await store.authorUnsend(notice.id, 'm1', false, CHAT_ROOM_TEAM)
    assert.ok(!('error' in unsent), 'the author may take back their own message')
    assert.deepEqual(
      store.getPinnedMessageIds(CHAT_ROOM_TEAM),
      [other.id],
      'only the removed message loses its pin',
    )

    console.log('chat-pin-multi: ok (taking a message back drops just its own pin)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- TS-CHAT-142: the team server re-sends the room's pins on a removal ---
{
  const serverSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/server.ts'),
    'utf8',
  )
  const live = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')

  const sliceCase = (name: string, next: string): string => {
    const start = serverSrc.indexOf(`case '${name}': {`)
    assert.ok(start > 0, `the ${name} handler still exists`)
    const end = serverSrc.indexOf(`case '${next}': {`, start + 1)
    assert.ok(end > start, `the handler after ${name} still exists`)
    return serverSrc.slice(start, end)
  }

  for (const [name, next] of [
    ['chat_unsend', 'chat_export'],
    ['chat_delete', 'chat_rooms_list'],
  ] as const) {
    const region = live(sliceCase(name, next))
    assert.match(
      region,
      /fanoutChatPinPeer\(/,
      `${name} must re-send the room's pins so a removed message stops being pinned for everyone else`,
    )
    // A commented-out call must not satisfy this pin (TOOL-G31-066).
    const broken = sliceCase(name, next).replace(
      /fanoutChatPinPeer\(/g,
      '// fanoutChatPinPeer(',
    )
    assert.doesNotMatch(
      live(broken),
      /fanoutChatPinPeer\(/,
      `commenting the ${name} pin fan-out must fail this pin`,
    )
  }

  console.log('chat-pin-multi: ok (both removal paths re-send the room pins)')
}
