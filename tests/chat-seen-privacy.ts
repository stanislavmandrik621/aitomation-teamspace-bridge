/**
 * TCC-R1143-RCPT-001: chat_seen_get must not leak departed members' watermarks.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatUnreadStore } from '../src/chat-unread-store.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-seen-privacy-'))
try {
  const store = new ChatUnreadStore(dir, null)
  const room = 'chat:g:testroom'
  assert.ok(!('error' in store.set('alice', room, { lastReadAt: 1000 })))
  assert.ok(!('error' in store.set('bob', room, { lastReadAt: 2000 })))
  assert.ok(!('error' in store.set('carol-left', room, { lastReadAt: 3000 })))

  const all = store.getAllForRoom(room)
  assert.equal(all.length, 3, 'unfiltered returns every watermark')

  const current = store.getAllForRoom(room, ['alice', 'bob'])
  assert.equal(current.length, 2)
  assert.deepEqual(
    current.map((m) => m.memberId).sort(),
    ['alice', 'bob'],
  )
  assert.ok(!current.some((m) => m.memberId === 'carol-left'))

  // Empty allowlist = unrestricted (team-room convention).
  const teamLike = store.getAllForRoom(room, [])
  assert.equal(teamLike.length, 3)

  console.log('chat-seen-privacy: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
