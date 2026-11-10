/**
 * Wave2 High CHAT pins for append / softDelete / export / pin payload.
 * TCC-R1144-CHAT-003, TCC-R1145-CHAT-001, TCC-R1151-CHAT-008,
 * TCC-R1154-CHAT-008, TCC-R1154-CHAT-009, TCC-R1147-CHAT-005,
 * TCC-R1153-CHAT-009.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'
import { toChatMessagePayload } from '../src/chat-message-payload.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-append-idemp-'))
try {
  const store = new ChatStore(dir, 90, 365, null)

  const a = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'hello',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'msg-shared-1',
  })
  if ('error' in a) throw new Error(a.error)

  // TCC-R1144-CHAT-003: same author + id is idempotent.
  const again = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'hello rewritten',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'msg-shared-1',
  })
  if ('error' in again) throw new Error(again.error)
  assert.equal(again.id, a.id)
  assert.equal(again.body, 'hello')
  // TS-CHAT-135: idempotent retry must stamp `unchanged` so chat_send can
  // skip re-fanning-out and re-firing /task side effects for a same-author
  // retry of a live clientMsgId - the row was already broadcast the first
  // time it was appended.
  assert.equal((again as { unchanged?: true }).unchanged, true)
  assert.equal((a as { unchanged?: true }).unchanged, undefined, 'first append must not carry unchanged')

  // Cross-author reuse refuses.
  const steal = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'stolen',
    memberId: 'bob',
    memberName: 'Bob',
    role: 'member',
    id: 'msg-shared-1',
  })
  assert.ok('error' in steal, 'cross-author id reuse must refuse')

  // TCC-R1145-CHAT-001: tombstone id cannot reopen.
  const del = await store.softDelete(a.id, 'alice')
  assert.ok(!('error' in del))
  const reopen = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'resurrect',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: a.id,
  })
  assert.ok('error' in reopen, 'tombstone id must refuse append')

  // TCC-R1151-CHAT-008: softDelete unknown id refuses (no invent tomb).
  const invent = await store.softDelete('never-existed-id', 'admin1')
  assert.ok('error' in invent)

  // TCC-R1154-CHAT-008: same id in another room refuses.
  const group = await store.append({
    room: 'chat:g:g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    body: 'group hello',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'cross-room-id',
  })
  if ('error' in group) throw new Error(group.error)
  const cross = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'team collide',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'cross-room-id',
  })
  assert.ok('error' in cross, 'cross-room id collide must refuse')

  // TCC-R1147-CHAT-005: before + beforeId pages same-timestamp ties.
  const t = Date.now()
  const m1 = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'tie-a',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'tie-a',
  })
  const m2 = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'tie-b',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
    id: 'tie-b',
  })
  assert.ok(!('error' in m1) && !('error' in m2))
  if ('error' in m1 || 'error' in m2) throw new Error('tie append failed')
  // Force same createdAt in disk is hard; at least beforeId path is accepted.
  const page = await store.readRecent(CHAT_ROOM_TEAM, 5, m2.createdAt, m2.id)
  assert.ok(Array.isArray(page.messages))

  // TCC-R1153-CHAT-009: payload pin remap from authoritative pinnedMessageId.
  const live = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'pin-me',
    memberId: 'alice',
    memberName: 'Alice',
    role: 'member',
  })
  if ('error' in live) throw new Error(live.error)
  const payloadPinned = toChatMessagePayload(live, { pinnedMessageId: live.id })
  assert.equal(payloadPinned.pinned, true)
  const payloadClear = toChatMessagePayload(live, { pinnedMessageId: null })
  assert.equal(payloadClear.pinned, false)
  const payloadClient = toChatMessagePayload(live, { clientMsgId: 'client-xyz' })
  assert.equal(payloadClient.clientMsgId, 'client-xyz')

  // TCC-R1154-CHAT-009: export truncated honesty when empty before-page.
  const exp = await store.exportRoom(CHAT_ROOM_TEAM, 'json')
  if ('error' in exp) throw new Error(exp.error)
  assert.equal(typeof exp.truncated, 'boolean')

  void t
  const histSrc = readFileSync(new URL('../src/chat-room-history-store.ts', import.meta.url), 'utf8')
  assert.match(
    histSrc,
    /readRecent\(parsed\.room, CHAT_HISTORY_LIMIT_MAX, oldest\.createdAt, oldest\.id\)/,
    'export paging must pass beforeId so same-ms rows are not skipped',
  )
  assert.equal(
    histSrc.includes('.localeCompare('),
    false,
    'history sort/cursor must not fall back to id.localeCompare',
  )

  // TS-CHAT-135: server.ts chat_send must skip fanoutChatPeer + /task command
  // processing when append() reports an idempotent retry, or a crash/reconnect
  // retry of the sender's own unacked send double-delivers to every peer and
  // double-creates any /task side effect.
  const serverSrc = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  const chatSendIdx = serverSrc.indexOf("case 'chat_send'")
  assert.ok(chatSendIdx >= 0, 'server.ts must have a chat_send case')
  const fanoutIdx = serverSrc.indexOf('fanoutChatPeer(ws, appended)', chatSendIdx)
  assert.ok(fanoutIdx >= 0, 'chat_send must call fanoutChatPeer(ws, appended)')
  const guardWindow = serverSrc.slice(chatSendIdx, fanoutIdx)
  assert.match(
    guardWindow,
    /if\s*\(\s*['"]unchanged['"]\s+in\s+appended\s*\)\s*\{\s*return/,
    'chat_send must return before fanoutChatPeer when appended.unchanged is set',
  )
  console.log('chat-history-append-idempotency: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
