/**
 * P5-CHAT: chat-room parse + chat-store append/history/prune.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import {
  CHAT_ROOM_TEAM,
  dmRoomId,
  parseChatRoomId,
  parseChatTaskCommand,
  scrubChatBody,
} from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'

assert.equal(parseChatRoomId(CHAT_ROOM_TEAM).ok, true)
assert.equal(parseChatRoomId('chat:other').ok, false)
assert.equal(parseChatRoomId('yjs:x:y').ok, false)
{
  const legacy = parseChatRoomId('chat:dm:bob_alice')
  assert.equal(legacy.ok, true)
  if (legacy.ok) assert.equal(legacy.room, 'chat:dm:alice_bob')
  const mem = parseChatRoomId('chat:dm:mem_44b80f71.mem_aabbccdd')
  assert.equal(mem.ok, true)
  if (mem.ok) assert.equal(mem.room, 'chat:dm:mem_44b80f71.mem_aabbccdd')
  assert.equal(parseChatRoomId('chat:dm:mem_44b80f71_mem_aabbccdd').ok, false)
  assert.equal(dmRoomId('mem_44b80f71', 'mem_aabbccdd'), 'chat:dm:mem_44b80f71.mem_aabbccdd')
}
assert.equal(scrubChatBody('  hello  '), 'hello')
assert.equal(scrubChatBody(''), null)
assert.deepEqual(parseChatTaskCommand('/task Fix copy'), { title: 'Fix copy' })
assert.deepEqual(parseChatTaskCommand('/task'), { title: '' })
assert.equal(parseChatTaskCommand('hello'), null)

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-'))
try {
  const store = new ChatStore(dir, 21, 365, null)
  // TCC-R1133-CHAT-001 (chat-a fixwave1): append/softDelete are now
  // serialized through the per-room queueRoomWrite mutex and return
  // Promises - every call below is awaited.
  const a = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'Hello team',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok(!('error' in a))
  if ('error' in a) throw new Error(a.error)

  const viewerRefuse = await store.append({
    room: 'chat:nope',
    body: 'x',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok('error' in viewerRefuse)

  const hist = await store.readRecent(CHAT_ROOM_TEAM, 10)
  assert.equal(hist.messages.length, 1)
  assert.equal(hist.messages[0]?.body, 'Hello team')

  await store.softDelete(a.id, 'admin1')
  const hist2 = await store.readRecent(CHAT_ROOM_TEAM, 10)
  assert.equal(hist2.messages.length, 0)

  console.log('chat-store: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
