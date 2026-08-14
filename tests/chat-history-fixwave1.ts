/**
 * Fix Wave 1 bucket 07 (chat-b) pins:
 * - TCC-R1133-CHAT-002: statSync offsets, cached history-only quota walk,
 *   debounced search-index flush (no full rewrite per write).
 * - TCC-R1132-CHAT-001: react()/setPinned() refuse on a tombstoned message.
 * - TCC-R1130-CHAT-001: searchRoom()/jumpToMessage() never resurrect a
 *   soft-deleted message via stale search-index terms.
 * - TCC-R1132-CHAT-002: history quota measurement excludes chat/blobs.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'
import { toChatMessagePayload } from '../src/chat-message-payload.js'
import {
  invalidateChatFilesBytesCache,
  measureChatFilesBytes,
} from '../src/chat-disk-quota.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-fixwave1-'))
try {
  const store = new ChatStore(dir, 90, 365, null)

  // --- statSync offsets stay sequential and correct across appends ---
  // NOTE (TCC-R1133-CHAT-001, chat-a fixwave1): append/edit/react/setPinned/
  // softDelete are now serialized through the per-room queueRoomWrite
  // mutex and return Promises - every call below is awaited.
  const a = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'first',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok(!('error' in a))
  if ('error' in a) throw new Error(a.error)
  const b = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'second message is longer than the first',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok(!('error' in b))
  if ('error' in b) throw new Error(b.error)
  const jumpA = await store.jumpToMessage(CHAT_ROOM_TEAM, a.id)
  const jumpB = await store.jumpToMessage(CHAT_ROOM_TEAM, b.id)
  assert.equal(jumpA.offset, 0)
  assert.ok(typeof jumpB.offset === 'number' && jumpB.offset! > 0)

  // --- toChatMessagePayload now carries deletedAt (TCC-R1130-CHAT-001 wire fix) ---
  const live = toChatMessagePayload(a)
  assert.equal(live.deletedAt, undefined)

  // --- TCC-R1132-CHAT-001: react() refuses a tombstoned message ---
  const del = await store.softDelete(a.id, 'admin1')
  assert.ok(!('error' in del))
  const tombPayload = toChatMessagePayload(del as import('../src/chat-room-history-store.js').ChatMessageRow)
  assert.equal(tombPayload.deletedAt, (del as { deletedAt?: number }).deletedAt)

  const reactRefuse = await store.react(a.id, 'm2', '\ud83d\udc4d', false)
  assert.ok('error' in reactRefuse, 'react on tombstoned message must refuse')

  const pinRefuse = await store.setPinned(CHAT_ROOM_TEAM, a.id, true)
  assert.ok('error' in pinRefuse, 'pinning a tombstoned message must refuse')

  // react/pin on a live message still works
  const reactOk = await store.react(b.id, 'm2', '\ud83d\udc4d', false)
  assert.ok(!('error' in reactOk))
  const pinOk = await store.setPinned(CHAT_ROOM_TEAM, b.id, true)
  assert.ok(!('error' in pinOk))

  // --- TCC-R1130-CHAT-001: search/jump never resurrect a tombstoned message ---
  const searchHitsBeforeDelete = await store.searchRoom(CHAT_ROOM_TEAM, 'first', 30)
  assert.ok(
    !searchHitsBeforeDelete.messageIds.includes(a.id),
    'search must not return the id of a soft-deleted message',
  )
  const jumpAfterDelete = await store.jumpToMessage(CHAT_ROOM_TEAM, a.id)
  assert.equal(jumpAfterDelete.message, null, 'jump to a tombstoned message must resolve to null')

  const searchHitsLive = await store.searchRoom(CHAT_ROOM_TEAM, 'longer', 30)
  assert.ok(searchHitsLive.messageIds.includes(b.id), 'search must still find live messages')
  const jumpLive = await store.jumpToMessage(CHAT_ROOM_TEAM, b.id)
  assert.equal(jumpLive.message?.id, b.id)

  // --- TCC-R1133-CHAT-002: debounced index flush eventually persists to disk ---
  const roomDir = join(dir, 'chat', 'rooms', 'team')
  const indexFile = join(roomDir, 'search-index.json')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const onDisk = JSON.parse(readFileSync(indexFile, 'utf8')) as { offsets: unknown[] }
  assert.ok(Array.isArray(onDisk.offsets) && onDisk.offsets.length >= 2)

  // flushAllPendingChatIndexes is a synchronous no-wait alternative
  await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'third',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  store.flushAllPendingChatIndexes()
  const onDisk2 = JSON.parse(readFileSync(indexFile, 'utf8')) as { offsets: unknown[] }
  assert.ok(onDisk2.offsets.length >= 3)

  console.log('chat-history-fixwave1: ok (statSync offsets, debounced index, soft-delete refuse, search/jump tomb filter)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// --- TCC-R1132-CHAT-002: history quota measurement excludes chat/blobs + chat/avatars ---
const quotaDir = mkdtempSync(join(tmpdir(), 'ts-chat-quota-'))
try {
  const store = new ChatStore(quotaDir, 90, 365, null)
  const posted = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'quota probe',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok(!('error' in posted))
  invalidateChatFilesBytesCache(quotaDir)
  const historyOnly = measureChatFilesBytes(quotaDir)
  assert.ok(historyOnly > 0)

  // Simulate a large attachment blob living under chat/blobs - must NOT count
  // toward the history-only quota measurement (TCC-R1132-CHAT-002).
  const blobsDir = join(quotaDir, 'chat', 'blobs')
  mkdirSync(blobsDir, { recursive: true })
  writeFileSync(join(blobsDir, 'fake-blob.bin'), Buffer.alloc(5 * 1024 * 1024, 1))
  invalidateChatFilesBytesCache(quotaDir)
  const historyAfterBlob = measureChatFilesBytes(quotaDir)
  assert.equal(
    historyAfterBlob,
    historyOnly,
    'a 5 MiB blob under chat/blobs must not inflate the history-only quota measurement',
  )

  // Cache TTL: a second call within the window returns the cached value even
  // if a room file changes underneath it (proves we are not walking every call).
  const secondPost = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'grows the room file without invalidating the cache',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
  })
  assert.ok(!('error' in secondPost))
  const cachedAgain = measureChatFilesBytes(quotaDir)
  assert.equal(cachedAgain, historyAfterBlob, 'measurement within the TTL window must be cached')

  console.log('chat-history-fixwave1: ok (history-only quota measurement + cache)')
} finally {
  rmSync(quotaDir, { recursive: true, force: true })
  invalidateChatFilesBytesCache(quotaDir)
}
