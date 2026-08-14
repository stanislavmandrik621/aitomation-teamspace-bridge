/**
 * Fix Wave 1 bucket 06 (chat-a) pins:
 * - TCC-R1125-CHAT-001: findById falls back to disk (via search-index offset
 *   lookup, or a bounded tail scan / cross-room scan) instead of failing
 *   "Message not found" once a row falls out of the bounded in-memory cache.
 * - TCC-R1126-CHAT-001: scanRoomFile keeps the TAIL of the file (a rolling
 *   window of the most recent MAX_TAIL_LINES_SCAN lines) instead of the head,
 *   so the newest messages/edits are never dropped once a room file grows
 *   past the scan cap.
 * - TCC-R1133-CHAT-001: every chat-room mutator (append/edit/react/setPinned/
 *   softDelete/authorUnsend) AND the hourly pruneRoomFile rewrite are wired
 *   through the same per-room queueRoomWrite serializer, so a prune rewrite
 *   racing concurrent appends on the same room can never silently drop a
 *   message.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'

// --- TCC-R1133-CHAT-001: concurrent appends racing a prune must never lose a message ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-prune-race-'))
  try {
    // Retention is generous (90 days) so prune's cutoff keeps every seeded
    // message - this isolates the test to the RACE (does the rewrite ever
    // silently drop a concurrently-appended line), not real pruning logic.
    const store = new ChatStore(dir, 90, 365, null)

    // Seed enough lines that pruneRoomFile's `for await (const line of rl)`
    // read loop spans multiple event-loop turns (real files large enough to
    // not fit in one internal stream chunk), giving a genuine window for a
    // concurrent sync appendLineSync to interleave with the async read if
    // the two were NOT serialized through the same room queue.
    const seedCount = 400
    for (let i = 0; i < seedCount; i++) {
      const seeded = await store.append({
        room: CHAT_ROOM_TEAM,
        body: `seed message number ${i} padded with extra filler text so each JSONL line is a realistic size on disk`,
        memberId: 'seed-member',
        memberName: 'Seed',
        role: 'member',
      })
      assert.ok(!('error' in seeded), `seed append ${i} must succeed`)
    }

    // Fire prune() and a burst of racing appends in the SAME turn (no await
    // between them) so they all contend for the per-room queue at once.
    const raceAppendCount = 25
    const raceIds: string[] = []
    const prunePromise = store.prune()
    const appendPromises: Promise<{ id: string } | { error: string }>[] = []
    for (let i = 0; i < raceAppendCount; i++) {
      appendPromises.push(
        store.append({
          room: CHAT_ROOM_TEAM,
          body: `race message ${i}`,
          memberId: 'race-member',
          memberName: 'Racer',
          role: 'member',
        }),
      )
    }

    const [pruneRemoved, ...appended] = await Promise.all([prunePromise, ...appendPromises])
    assert.equal(pruneRemoved, 0, 'nothing should be pruned - retention window keeps every seeded message')

    for (let i = 0; i < appended.length; i++) {
      const row = appended[i]
      assert.ok(!('error' in row), `race append ${i} must not error: ${JSON.stringify(row)}`)
      if (!('error' in row)) raceIds.push(row.id)
    }
    assert.equal(raceIds.length, raceAppendCount)

    // The core regression check: every message appended DURING the prune
    // must still be readable afterward - both via the bounded in-memory
    // cache path and via findById's disk fallback (TCC-R1125-CHAT-001),
    // proving the write actually landed in the rewritten file, not just in
    // memory.
    for (const id of raceIds) {
      const found = await store.findById(id, CHAT_ROOM_TEAM)
      assert.ok(found, `message ${id} appended during a concurrent prune must not be lost`)
      assert.equal(found?.room, CHAT_ROOM_TEAM)
    }

    // readRecent is capped at CHAT_HISTORY_LIMIT_MAX (100) regardless of how
    // large the requested limit is - request the max and confirm every
    // race-appended message (the 25 newest of the whole set) is present in
    // that tail window, proving the prune rewrite did not drop them.
    const all = await store.readRecent(CHAT_ROOM_TEAM, seedCount + raceAppendCount + 10)
    assert.equal(all.messages.length, 100, 'readRecent is capped at CHAT_HISTORY_LIMIT_MAX')
    const allIds = new Set(all.messages.map((m) => m.id))
    for (const id of raceIds) {
      assert.ok(allIds.has(id), `readRecent must include race-appended message ${id} after the prune settled`)
    }

    // The on-disk file itself must contain exactly this many JSONL lines -
    // the strongest proof prune's renameSync did not clobber a concurrent
    // append (a lost message would show as OK in the in-memory cache from
    // the append's own `remember()` call but MISSING from disk).
    const roomFile = join(dir, 'chat', 'rooms', 'team', 'messages.jsonl')
    const onDiskLines = readFileSync(roomFile, 'utf8').split('\n').filter((l) => l.trim().length > 0)
    assert.equal(onDiskLines.length, seedCount + raceAppendCount, 'on-disk messages.jsonl must contain every message with none dropped by the race')

    console.log('chat-a-fixwave1: ok (TCC-R1133-CHAT-001 prune/append race - 0 messages lost across 400 seed + 25 concurrent race appends)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- TCC-R1126-CHAT-001: scanRoomFile keeps the TAIL, not the head, so the
// newest messages past the scan cap are never missed ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-tail-scan-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    // Post more messages than the internal small readRecent limit so this
    // only returns the tail; the assertion is that the MOST RECENT message
    // (posted last) is always present, never evicted in favor of older ones.
    const total = 60
    let lastId = ''
    for (let i = 0; i < total; i++) {
      const posted = await store.append({
        room: CHAT_ROOM_TEAM,
        body: `msg ${i}`,
        memberId: 'm1',
        memberName: 'Alex',
        role: 'member',
      })
      assert.ok(!('error' in posted))
      if (!('error' in posted)) lastId = posted.id
    }
    const recent = await store.readRecent(CHAT_ROOM_TEAM, 10)
    assert.equal(recent.messages.length, 10)
    assert.equal(
      recent.messages[recent.messages.length - 1]?.id,
      lastId,
      'the most recently posted message must be present in a tail read, never dropped for an older one',
    )
    assert.equal(recent.messages[recent.messages.length - 1]?.body, `msg ${total - 1}`)

    console.log('chat-a-fixwave1: ok (TCC-R1126-CHAT-001 tail scan keeps the newest message)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- TCC-FIX-CHAT-A9: readRecent must order same-millisecond messages by
// real append/send order, never by id.localeCompare (ids are random strings
// unrelated to send order, so a burst of messages sharing one Date.now()
// millisecond - routine for fast/bursty writers - would otherwise scramble
// which one reads as "most recent"). Write rows directly with an identical
// createdAt and ids chosen so their lexicographic order is the EXACT REVERSE
// of send order, isolating the ordering logic from real clock timing. ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-tie-order-'))
  try {
    const roomDir = join(dir, 'chat', 'rooms', 'team')
    mkdirSync(roomDir, { recursive: true })
    const tiedAt = 1_700_000_000_000
    // Sent in this physical order: z_first, m_second, a_third (a_third is the
    // MOST RECENT). Lexicographically 'a' < 'm' < 'z' - the exact opposite -
    // so a buggy id-tiebreak would sort a_third FIRST instead of last.
    const rows = [
      { id: 'z_first', body: 'sent first' },
      { id: 'm_second', body: 'sent second' },
      { id: 'a_third', body: 'sent third (most recent)' },
    ]
    const lines = rows.map((r) =>
      JSON.stringify({
        id: r.id,
        room: CHAT_ROOM_TEAM,
        body: r.body,
        memberId: 'm1',
        memberName: 'Alex',
        role: 'member',
        createdAt: tiedAt,
        kind: 'user',
      }),
    )
    writeFileSync(join(roomDir, 'messages.jsonl'), lines.join('\n') + '\n', 'utf8')

    const store = new ChatStore(dir, 90, 365, null)
    const recent = await store.readRecent(CHAT_ROOM_TEAM, 10)
    assert.equal(recent.messages.length, 3)
    assert.deepEqual(
      recent.messages.map((m) => m.id),
      ['z_first', 'm_second', 'a_third'],
      'same-millisecond ties must resolve by real append order, never by id.localeCompare',
    )
    assert.equal(recent.messages[recent.messages.length - 1]?.id, 'a_third')

    console.log('chat-a-fixwave1: ok (TCC-FIX-CHAT-A9 same-millisecond tiebreak uses append order, not id)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// --- TCC-R1125-CHAT-001: findById falls back to disk once a row falls out
// of the bounded in-memory recentById cache ---
{
  const dir = mkdtempSync(join(tmpdir(), 'ts-chat-findbyid-disk-'))
  try {
    const store = new ChatStore(dir, 90, 365, null)
    const first = await store.append({
      room: CHAT_ROOM_TEAM,
      body: 'old message that will fall out of cache',
      memberId: 'm1',
      memberName: 'Alex',
      role: 'member',
    })
    assert.ok(!('error' in first))
    if ('error' in first) throw new Error(first.error)

    // Post enough NEW messages to evict `first` from the bounded in-memory
    // recentById LRU cache (CHAT_RECENT_CACHE_MAX in the store), then prove
    // edit/react/findById still resolve it via the disk fallback instead of
    // failing "Message not found".
    for (let i = 0; i < 5010; i++) {
      await store.append({
        room: CHAT_ROOM_TEAM,
        body: `filler ${i}`,
        memberId: 'm2',
        memberName: 'Bo',
        role: 'member',
      })
    }

    const foundNoHint = await store.findById(first.id)
    assert.ok(foundNoHint, 'findById must fall back to disk for a message evicted from the in-memory cache, even with no room hint')
    assert.equal(foundNoHint?.id, first.id)

    const edited = await store.edit(first.id, 'm1', 'edited after falling out of cache', false, CHAT_ROOM_TEAM)
    assert.ok(!('error' in edited), `edit on a cache-evicted row must succeed via disk fallback: ${JSON.stringify(edited)}`)

    console.log('chat-a-fixwave1: ok (TCC-R1125-CHAT-001 findById/edit disk fallback past cache eviction)')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
