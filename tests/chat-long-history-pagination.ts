/** Cross the internal scan window using actual disk history and legacy rows. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, appendFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'
import { ChatMetaStore } from '../src/chat-meta-store.js'
import { CHAT_RETENTION_DAYS_DEFAULT } from '../src/chat-room.js'
import { safeChatRoomDirName } from '../src/chat-room-path.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-long-history-'))
const room = 'chat:team', count = 100_250, stamp = 1_600_000_000_000
const row = (n: number) => ({ id: `row-${String(n).padStart(6, '0')}`, room, body: `Message ${n} 中文 👋`, createdAt: stamp, memberId: 'alice', memberName: 'Alice', role: 'member' })
const started = performance.now()
try {
  assert.equal(CHAT_RETENTION_DAYS_DEFAULT, 0)
  const meta = new ChatMetaStore(join(dir, 'meta'), null)
  assert.equal(meta.get().retentionDays, 0, 'new teams keep history until deleted')
  assert.ok(!('error' in meta.set({ retentionDays: 90 })))
  assert.equal(new ChatMetaStore(join(dir, 'meta'), null).get().retentionDays, 90, 'saved administrator policy survives the new default')
  const folder = join(dir, 'chat', 'rooms', safeChatRoomDirName(room)!)
  mkdirSync(folder, { recursive: true }); const path = join(folder, 'messages.jsonl')
  writeFileSync(path, '')
  for (let i = 0; i < count; i += 1000) appendFileSync(path, Array.from({ length: Math.min(1000, count - i) }, (_, j) => JSON.stringify(row(i + j))).join('\n') + '\n')
  // Latest versions are far from the original rows, across the scan boundary.
  appendFileSync(path, JSON.stringify({ ...row(2), body: 'buriedneedle 中文 latest edit', editedAt: stamp + 1 }) + '\n')
  appendFileSync(path, JSON.stringify({ ...row(3), body: '', deletedAt: stamp + 2 }) + '\n')
  // More than one full scan window of edits to old messages must not hide
  // newer messages whose original rows are in an earlier physical window.
  for (let i = 0; i < 51_000; i += 1000) appendFileSync(path, Array.from({ length: 1000 }, (_, j) => JSON.stringify({ ...row(10 + (i + j) % 150), editedAt: stamp + 10 + i + j })).join('\n') + '\n')
  const store = new ChatStore(dir, 0)
  const newest = await store.readRecent(room, 100)
  assert.deepEqual(newest.messages.map(m => m.id), Array.from({ length: 100 }, (_, i) => row(count - 100 + i).id), 'late edits keep their original same-millisecond order')
  assert.equal(newest.truncated, true)
  const crossing = await store.readRecent(room, 100, stamp, row(300).id)
  assert.deepEqual(crossing.messages.map(m => m.id), Array.from({ length: 100 }, (_, i) => row(200 + i).id))
  const oldest = await store.readRecent(room, 100, stamp, row(100).id)
  assert.equal(oldest.messages.length, 99); assert.equal(oldest.truncated, false)
  assert.equal(oldest.messages.find(m => m.id === row(2).id)?.body, 'buriedneedle 中文 latest edit')
  assert.ok(!oldest.messages.some(m => m.id === row(3).id), 'later tombstone cannot be resurrected by older paging')
  const exhausted = await store.readRecent(room, 100, stamp, row(0).id)
  assert.deepEqual(exhausted, { messages: [], truncated: false }, 'no endless empty Load more loop')
  const reopened = new ChatStore(dir, 0)
  assert.equal((await reopened.findById(row(1).id, room))?.body, row(1).body, 'cold lookup reaches before all hot caches')
  assert.equal((await reopened.jumpToMessage(room, row(1).id)).message?.id, row(1).id)
  assert.deepEqual((await reopened.searchRoom(room, 'Message 1 中文', 1)).messageIds, [row(1).id], 'search finds an old unindexed exact phrase')
  assert.deepEqual((await reopened.searchRoom(room, 'buriedneedle', 5)).messageIds, [row(2).id])
  const noMatch = await reopened.searchRoom(room, 'not-present-anywhere', 5)
  assert.deepEqual(noMatch, { messageIds: [], truncated: false })
  assert.equal(await reopened.prune(), 0, 'keep-forever rooms avoid rewriting the entire history during hourly cleanup')
  assert.equal((await new ChatStore(dir, 0).jumpToMessage(room, row(3).id)).message, null, 'cleanup cannot expire a tombstone and resurrect its retained original')
  const retainedDir = join(dir, 'finite-retention')
  const retainedRoom = join(retainedDir, 'chat', 'rooms', safeChatRoomDirName(room)!)
  mkdirSync(retainedRoom, { recursive: true })
  const old = { ...row(0), createdAt: Date.now() - 500 * 86_400_000 }
  writeFileSync(join(retainedRoom, 'messages.jsonl'), [old, { ...old, body: '', deletedAt: Date.now() - 400 * 86_400_000 }].map(value => JSON.stringify(value)).join('\n') + '\n')
  const retained = new ChatStore(retainedDir, 3650, 365)
  await retained.prune()
  assert.equal((await new ChatStore(retainedDir, 3650, 365).jumpToMessage(room, old.id)).message, null, 'tombstones outlive every original row retained by a longer Admin policy')
  retained.flushAllPendingChatIndexes()
  // A server clock adjustment can append an earlier-created row after the
  // cursor's physical line. Paging follows creation order, not file position.
  const clockDir = join(dir, 'clock-adjustment')
  const clockRoom = join(clockDir, 'chat', 'rooms', safeChatRoomDirName(room)!)
  mkdirSync(clockRoom, { recursive: true })
  writeFileSync(join(clockRoom, 'messages.jsonl'), [row(0), { ...row(1), createdAt: stamp - 1 }].map(value => JSON.stringify(value)).join('\n') + '\n')
  const clockStore = new ChatStore(clockDir, 0)
  assert.deepEqual((await clockStore.readRecent(room, 100, stamp, row(0).id)).messages.map(value => value.id), [row(1).id])
  clockStore.flushAllPendingChatIndexes()
  store.flushAllPendingChatIndexes(); reopened.flushAllPendingChatIndexes()
  console.log(`PASS ${count} same-timestamp messages: newest page, cross-window older pages, latest edits/deletes, cold lookup/jump/search, end-of-history and retention (${Math.round(performance.now() - started)} ms)`)
} finally { rmSync(dir, { recursive: true, force: true }) }
