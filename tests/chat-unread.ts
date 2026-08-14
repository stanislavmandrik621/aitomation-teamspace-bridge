/**
 * Unread watermark advance-only semantics.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ChatUnreadStore } from '../src/chat-unread-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-unread-'))
try {
  const store = new ChatUnreadStore(dir, null)
  const t0 = 1_700_000_000_000
  const t1 = t0 + 60_000

  assert.equal(store.set('m1', CHAT_ROOM_TEAM, { lastReadAt: t0, lastReadMsgId: 'a' }).ok, true)
  assert.equal(store.get('m1', CHAT_ROOM_TEAM)?.lastReadAt, t0)

  assert.equal(store.set('m1', CHAT_ROOM_TEAM, { lastReadAt: t1, lastReadMsgId: 'b' }).ok, true)
  assert.equal(store.get('m1', CHAT_ROOM_TEAM)?.lastReadMsgId, 'b')

  // Rewind must no-op (advance-only) and report advanced:false.
  const rewind = store.set('m1', CHAT_ROOM_TEAM, { lastReadAt: t0 - 1 })
  assert.equal(rewind.ok, true)
  if (rewind.ok) assert.equal(rewind.advanced, false)
  assert.equal(store.get('m1', CHAT_ROOM_TEAM)?.lastReadAt, t1)

  // TCC-R1153-CHAT-005: future watermark clamped to now+60s ceiling.
  const farFuture = Date.now() + 24 * 60 * 60 * 1000
  const fut = store.set('m1', CHAT_ROOM_TEAM, { lastReadAt: farFuture, lastReadMsgId: 'fut' })
  assert.equal(fut.ok, true)
  const got = store.get('m1', CHAT_ROOM_TEAM)?.lastReadAt ?? 0
  assert.ok(got <= Date.now() + 60_000 + 5_000)

  store.wipeMember('m1')
  assert.equal(store.get('m1', CHAT_ROOM_TEAM), null)
  store.set('m3', CHAT_ROOM_TEAM, { lastReadAt: t1 })
  store.wipeMemberRoom('m3', CHAT_ROOM_TEAM)
  assert.equal(store.get('m3', CHAT_ROOM_TEAM), null)

  // TCC-R1134-CHAT-022: `set()` must persist to disk SYNCHRONOUSLY, in the
  // same tick it returns - a bridge crash right after the caller's reply
  // must never lose a watermark that the client already believes landed.
  // Read the on-disk file immediately, with no `await`/tick in between.
  store.set('m2', CHAT_ROOM_TEAM, { lastReadAt: t1, lastReadMsgId: 'sync-check' })
  const unreadPath = join(dir, 'chat', 'unread.json')
  assert.equal(existsSync(unreadPath), true, 'unread.json must exist immediately after set() returns')
  const onDisk = JSON.parse(readFileSync(unreadPath, 'utf8')) as { marks: Record<string, Record<string, { lastReadMsgId?: string | null }>> }
  assert.equal(
    onDisk.marks['m2']?.[CHAT_ROOM_TEAM]?.lastReadMsgId,
    'sync-check',
    'on-disk file must already reflect the watermark synchronously, before any microtask tick',
  )

  console.log('chat-unread: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
