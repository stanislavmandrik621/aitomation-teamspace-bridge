import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatUnreadStore } from '../src/chat-unread-store.js'
import { dmRoomId } from '../src/chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-unread-isolation-'))
try {
  const store = new ChatUnreadStore(dir, null)
  const member = 'a'.repeat(128), sharedPrefix = 'b'.repeat(100)
  const first = dmRoomId(member, `${sharedPrefix}1`)!, second = dmRoomId(member, `${sharedPrefix}2`)!
  assert.notEqual(first, second); assert.equal(first.slice(0, 160), second.slice(0, 160))
  assert.deepEqual(store.set(member, first, { lastReadAt: 100, lastReadMsgId: 'private-first' }), { ok: true, advanced: true })
  assert.equal(store.get(member, second), null, 'another DM must not inherit private read message IDs')
  assert.deepEqual(store.getAllForRoom(second, [member]), [])
  store.set(member, second, { lastReadAt: 200, lastReadMsgId: 'private-second' })
  store.wipeMemberRoom(member, first)
  assert.equal(store.get(member, second)?.lastReadMsgId, 'private-second', 'one DM cleanup cannot wipe another DM')
  const restarted = new ChatUnreadStore(dir, null)
  assert.equal(restarted.get(member, first), null)
  assert.equal(restarted.get(member, second)?.lastReadMsgId, 'private-second')
  const exposed = restarted.getAllForMember(member); exposed[second].lastReadMsgId = 'caller-tamper'
  assert.equal(restarted.get(member, second)?.lastReadMsgId, 'private-second', 'read results cannot mutate authority cache')
  const path = join(dir, 'chat', 'unread.json'), saved = join(dir, 'chat', 'saved-unread.json')
  renameSync(path, saved); mkdirSync(path)
  const failed = restarted.set(member, second, { lastReadAt: 300, lastReadMsgId: 'retry-after-disk-failure' })
  assert.ok('error' in failed, 'failed persistence cannot acknowledge success')
  assert.equal(restarted.get(member, second)?.lastReadMsgId, 'private-second', 'failed write rolls back in-memory tip')
  assert.throws(() => restarted.wipeMemberRoom(member, second))
  assert.equal(restarted.get(member, second)?.lastReadMsgId, 'private-second', 'failed wipe also rolls back')
  rmSync(path, { recursive: true }); renameSync(saved, path)
  assert.deepEqual(restarted.set(member, second, { lastReadAt: 300, lastReadMsgId: 'retry-after-disk-failure' }), { ok: true, advanced: true })
  assert.equal(new ChatUnreadStore(dir, null).get(member, second)?.lastReadMsgId, 'retry-after-disk-failure')
  assert.deepEqual(restarted.set('__proto__', 'chat:team', { lastReadAt: 400 }), { ok: true, advanced: true })
  assert.equal(({} as any)['chat:team'], undefined, 'opaque member IDs cannot pollute Object.prototype')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).marks['__proto__']['chat:team'].lastReadAt, 400)
  assert.equal(new ChatUnreadStore(dir, null).get('__proto__', 'chat:team')?.lastReadAt, 400)
  console.log('chat unread: full-length DM isolation, scoped cleanup/restart, disk-write and wipe rollback/retry, detached read results, and opaque prototype member IDs passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
