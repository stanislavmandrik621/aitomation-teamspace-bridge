/**
 * Legacy chat.jsonl migration into per-room messages.jsonl.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { ChatStore } from '../src/chat-store.js'
import { CHAT_ROOM_TEAM } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-migrate-'))
try {
  const legacyRow = {
    id: 'msg_legacy_1',
    room: CHAT_ROOM_TEAM,
    body: 'From legacy file',
    memberId: 'm1',
    memberName: 'Alex',
    role: 'member',
    kind: 'user',
    createdAt: Date.now(),
  }
  writeFileSync(join(dir, 'chat.jsonl'), `${JSON.stringify(legacyRow)}\n`, 'utf8')

  const store = new ChatStore(dir, 90, 365, null)
  const hist = await store.readRecent(CHAT_ROOM_TEAM, 10)
  assert.equal(hist.messages.length, 1)
  assert.equal(hist.messages[0]?.body, 'From legacy file')
  assert.equal(existsSync(join(dir, 'chat.jsonl')), false)

  const roomMsg = join(dir, 'chat', 'rooms', 'team', 'messages.jsonl')
  assert.equal(existsSync(roomMsg), true)
  const raw = readFileSync(roomMsg, 'utf8')
  assert.ok(raw.includes('From legacy file'))

  // chat/chat.jsonl alt path
  const dir2 = mkdtempSync(join(tmpdir(), 'ts-chat-migrate2-'))
  try {
    mkdirSync(join(dir2, 'chat'), { recursive: true })
    writeFileSync(join(dir2, 'chat', 'chat.jsonl'), `${JSON.stringify(legacyRow)}\n`, 'utf8')
    const store2 = new ChatStore(dir2, 90, 365, null)
    const hist2 = await store2.readRecent(CHAT_ROOM_TEAM, 10)
    assert.equal(hist2.messages.length, 1)
    assert.equal(existsSync(join(dir2, 'chat', 'chat.jsonl')), false)
  } finally {
    rmSync(dir2, { recursive: true, force: true })
  }

  console.log('chat-migrate: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
