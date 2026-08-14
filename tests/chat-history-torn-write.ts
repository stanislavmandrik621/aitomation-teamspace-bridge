/**
 * TCC-R1134-CHAT-023: a crash landing mid-`appendFileSync` can leave
 * `messages.jsonl` ending in a torn, newline-less partial line. Readers
 * already skip an unparseable line safely, but without a repair step the
 * NEXT append after restart would land directly after that torn tail with
 * no separator, merging the garbage with the brand-new message into one
 * unparseable line - silently losing the very first message written after
 * the crash, not just the torn one. `ChatRoomHistoryStore` must repair the
 * boundary (append exactly one missing `\n`) the first time a room is
 * touched after a fresh process start, before any new append can land.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ChatStore } from '../src/chat-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'
import { safeChatRoomDirName } from '../src/chat-room-path.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-torn-'))
try {
  const roomDirName = safeChatRoomDirName(CHAT_ROOM_TEAM)
  assert.ok(roomDirName)
  const roomDir = join(dir, 'chat', 'rooms', roomDirName)
  mkdirSync(roomDir, { recursive: true })
  const messagesPath = join(roomDir, 'messages.jsonl')

  // Simulate a crash mid-appendFileSync: a complete first line, then a
  // torn/truncated second line with NO trailing newline.
  const goodLine = JSON.stringify({
    id: 'c_good1',
    room: CHAT_ROOM_TEAM,
    body: 'first message',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
    createdAt: 1_700_000_000_000,
    kind: 'user',
  })
  const tornLine = '{"id":"c_torn1","room":"chat:team","body":"cut off mid-wri' // no closing brace, no \n
  writeFileSync(messagesPath, `${goodLine}\n${tornLine}`, 'utf8')
  assert.equal(
    readFileSync(messagesPath, 'utf8').endsWith('\n'),
    false,
    'fixture must start life without a trailing newline, simulating the crash',
  )

  // A fresh store instance (simulating the bridge restarting after the
  // crash) appends a new message to this room.
  const store = new ChatStore(dir, 90, 365, null)
  const appended = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'message written right after the crash',
    memberId: 'm2',
    memberName: 'Blair',
    role: 'member',
  })
  assert.ok(!('error' in appended), 'append right after a simulated crash must succeed')
  if ('error' in appended) throw new Error(appended.error)

  // The repair must have inserted exactly one `\n` before the new append -
  // verify by reading the raw file and checking every line parses on its
  // own boundary (the torn line stays garbage/unparseable but ISOLATED,
  // and the new message is on its own clean line, not merged with it).
  const raw = readFileSync(messagesPath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 3, 'must be exactly 3 lines: good, torn (now isolated), new')
  assert.deepEqual(JSON.parse(lines[0]!).id, 'c_good1')
  // The second (torn) line must remain isolated garbage - NOT merged with
  // the third line's JSON.
  assert.ok(!lines[1]!.includes('message written right after the crash'))
  const thirdParsed = JSON.parse(lines[2]!) as { id: string; body: string }
  assert.equal(thirdParsed.body, 'message written right after the crash')

  // And the store's own read path must see the new message (proving it
  // wasn't corrupted/merged from the store's perspective either).
  const history = await store.readRecent(CHAT_ROOM_TEAM, 50)
  const found = history.messages.find((m) => m.body === 'message written right after the crash')
  assert.ok(found, 'the new message appended right after a simulated crash must be readable back')
  const goodStillThere = history.messages.find((m) => m.id === 'c_good1')
  assert.ok(goodStillThere, 'the message written before the crash must still be readable')

  // Second run: the file now properly ends with a newline, so appending
  // again must NOT need (or cause) any further repair - just a normal append.
  const appended2 = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'second message, file already healthy',
    memberId: 'm2',
    memberName: 'Blair',
    role: 'member',
  })
  assert.ok(!('error' in appended2))
  const raw2 = readFileSync(messagesPath, 'utf8')
  assert.equal(raw2.split('\n').filter((l) => l.length > 0).length, 4)

  // A brand-new store instance touching an ALREADY-HEALTHY room file (ends
  // in `\n`) must be a complete no-op repair - no stray extra newline
  // inserted just because the process restarted again.
  const store2 = new ChatStore(dir, 90, 365, null)
  const before = readFileSync(messagesPath, 'utf8')
  await store2.append({
    room: CHAT_ROOM_TEAM,
    body: 'third message, fresh process instance',
    memberId: 'm3',
    memberName: 'Casey',
    role: 'member',
  })
  const after = readFileSync(messagesPath, 'utf8')
  assert.ok(
    after.startsWith(before),
    'repair must be a strict no-op on an already-healthy (newline-terminated) file',
  )

  console.log('chat-history-torn-write: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
