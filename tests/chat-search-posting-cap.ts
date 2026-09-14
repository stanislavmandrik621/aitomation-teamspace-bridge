import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-search-postings-'))
try {
  const store = new ChatStore(dir, 90, 365, null)
  let first = ''
  for (let n = 0; n < 2401; n++) {
    const row = await store.append({ room: CHAT_ROOM_TEAM, body: `CAPACITY fixture Bob ${String(n).padStart(4, '0')}`, memberId: 'bob', memberName: 'Bob', role: 'member' })
    if ('error' in row) throw Error(row.error)
    if (n === 0) first = row.id
  }
  for (const query of ['CAPACITY fixture Bob 0000', '0000 Bob CAPACITY']) {
    const found = await store.searchRoom(CHAT_ROOM_TEAM, query, 30)
    assert.deepEqual(found.messageIds, [first], 'common capped terms cannot hide a unique old match')
    assert.equal(found.truncated, false)
  }
  const broad = await store.searchRoom(CHAT_ROOM_TEAM, 'CAPACITY fixture', 30)
  assert.equal(broad.messageIds.length, 30); assert.equal(broad.truncated, true)
  const jump = await store.jumpToMessage(CHAT_ROOM_TEAM, first)
  assert.equal(jump.message?.id, first)
  await store.softDelete(first, 'admin')
  assert.deepEqual((await store.searchRoom(CHAT_ROOM_TEAM, 'CAPACITY fixture Bob 0000', 30)).messageIds, [])
  const reopened = new ChatStore(dir, 90, 365, null)
  assert.deepEqual((await reopened.searchRoom(CHAT_ROOM_TEAM, 'CAPACITY fixture Bob 0000', 30)).messageIds, [])
  assert.equal((await reopened.searchRoom(CHAT_ROOM_TEAM, 'CAPACITY fixture Bob 0001', 30)).messageIds.length, 1)
  console.log('PASS 2401-message search: posting eviction, reordered terms, pagination honesty, old-message jump, deletion and reopen')
} finally { rmSync(dir, { recursive: true, force: true }) }
