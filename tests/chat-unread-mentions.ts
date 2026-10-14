import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'
import { safeChatRoomDirName } from '../src/chat-room-path.js'
import { chatBodyMentionsMember } from '../src/chat-mentions.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-unread-mentions-'))
const room = 'chat:team', stamp = 1_700_000_000_000, count = 50_020
const row = (i: number) => ({ id: `message-${i}`, room, body: i === 0 || i === 1 ? '@mem_bob hello' : i === 7 ? '@mem_bob_extra' : 'Ordinary message', createdAt: stamp + i, memberId: i === 5 ? 'mem_bob' : 'mem_alice', memberName: 'Alice', role: 'member', kind: i === 6 ? 'system' : 'user' })
try {
  for (const body of ['@mem_bob', 'Hello @mem_bob!', '你好 @mem_bob 👋']) assert.equal(chatBodyMentionsMember(body, 'mem_bob'), true)
  for (const body of ['@mem_bob_extra', 'email@mem_bob', '@@mem_bob', 'hello\0@mem_bob']) assert.equal(chatBodyMentionsMember(body, 'mem_bob'), false)
  const folder = join(dir, 'chat', 'rooms', safeChatRoomDirName(room)!)
  mkdirSync(folder, { recursive: true }); const file = join(folder, 'messages.jsonl')
  writeFileSync(file, Array.from({ length: count }, (_, i) => JSON.stringify(row(i))).join('\n') + '\n')
  appendFileSync(file, [
    { ...row(1), body: 'Mention removed by edit', editedAt: stamp + count },
    { ...row(2), body: '@mem_bob', deletedAt: stamp + count },
    { ...row(3), body: '@mem_bob added by edit', editedAt: stamp + count },
    { ...row(5), body: '@mem_bob own message' },
    { ...row(6), body: '@mem_bob system message' },
    { ...row(0), editedAt: stamp + count + 1 },
  ].map(r => JSON.stringify(r)).join('\n') + '\n')
  const store = new ChatStore(dir, 0)
  assert.deepEqual(await store.readUnreadSummary(room, 'mem_bob', 0), { unread: 50, unreadTruncated: true, unreadMentions: 2 }, 'old mentions survive page/window boundaries; edits and deletes are current; one count per message')
  assert.deepEqual(await new ChatStore(dir, 0).readUnreadSummary(room, 'mem_bob', stamp + 3), { unread: 50, unreadTruncated: true, unreadMentions: 0 }, 'read watermark clears mentions across restarts')
  assert.deepEqual(await store.readUnreadSummary(room, 'mem_bob', stamp + count), { unread: 0, unreadTruncated: false, unreadMentions: 0 })
  const rooms = ['chat:g:room-one', 'chat:g:room-two', 'chat:g:room-three', 'chat:g:room-four']
  for (const [i, id] of rooms.entries()) {
    const appended = await store.append({ room: id, body: i % 2 ? '@mem_carol hello' : '@mem_bob hello', memberId: 'mem_alice', memberName: 'Alice', role: 'member' })
    assert.ok(!('error' in appended), JSON.stringify(appended))
  }
  const results = await Promise.all(rooms.flatMap(id => ['mem_bob', 'mem_carol'].map(member => store.readUnreadSummary(id, member, 0))))
  assert.deepEqual(results.map(r => r.unreadMentions), [1, 0, 0, 1, 1, 0, 0, 1], 'four concurrent rooms and two recipients keep distinct mention counts')
  store.flushAllPendingChatIndexes()
  console.log('PASS unread mentions: full 50,020-message history, exact recipient boundaries, latest edits/deletes, no duplicate versions, watermark/restart, four concurrent rooms with two recipients')
} finally { rmSync(dir, { recursive: true, force: true }) }
