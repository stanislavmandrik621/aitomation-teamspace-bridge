import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRoomHistoryStore } from '../src/chat-room-history-store.js'
import { CHAT_UNSEND_MS } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-unsend-commit-'))
const originalNow = Date.now
let now = 1_800_000_000_000
const store = new ChatRoomHistoryStore(dir, 90, 90, null)
try {
  Date.now = () => now
  const message = await store.append({ room: 'chat:team', id: 'queued-unsend', body: 'Keep this history', memberId: 'alice', memberName: 'Alice', role: 'member' })
  if ('error' in message) throw new Error(message.error)
  now += CHAT_UNSEND_MS - 1
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  // Hold the actual room mutation queue after admission, before commit.
  const queued = (store as unknown as { queueRoomWrite: (room: string, work: () => Promise<void>) => Promise<void> }).queueRoomWrite('chat:team', () => gate)
  const unsend = store.authorUnsend(message.id, 'alice', false, 'chat:team')
  await new Promise<void>(resolve => setImmediate(resolve))
  now += 2
  release()
  await queued
  const refused = await unsend
  assert.ok('error' in refused)
  assert.match(refused.error, /Unsend window expired/)
  assert.equal((await store.findById(message.id, 'chat:team'))?.body, 'Keep this history')
  const admin = await store.authorUnsend(message.id, 'admin', true, 'chat:team')
  assert.ok(!('error' in admin), 'authorized admin deletion remains available after the author window')
  console.log('Team chat unsend: expiry is checked under the room commit lock; admin override preserved')
} finally {
  Date.now = originalNow
  store.flushAllPendingChatIndexes()
  rmSync(dir, { recursive: true, force: true })
}
