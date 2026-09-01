/**
 * TCC-R1143-CHAT-016: author edit window is CHAT_EDIT_MS (30m) / editWindowMs,
 * separate from CHAT_UNSEND_MS (15m) used only by authorUnsend.
 *
 * Behavioral: short editWindowMs expires for non-admin; default window allows
 * fresh edits; Admin bypasses; unsend still uses CHAT_UNSEND_MS.
 * Source-scan: edit() must not compare against CHAT_UNSEND_MS.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHAT_EDIT_MS,
  CHAT_ROOM_TEAM,
  CHAT_UNSEND_MS,
} from '../src/chat-room.js'
import { ChatStore } from '../src/chat-store.js'

assert.equal(CHAT_EDIT_MS, 30 * 60 * 1000)
assert.equal(CHAT_UNSEND_MS, 15 * 60 * 1000)
assert.ok(CHAT_EDIT_MS > CHAT_UNSEND_MS)

const historySrc = readFileSync(
  fileURLToPath(new URL('../src/chat-room-history-store.ts', import.meta.url)),
  'utf8',
)
const editStart = historySrc.indexOf('async edit(')
assert.ok(editStart >= 0, 'edit() must exist')
const reactStart = historySrc.indexOf('async react(', editStart + 1)
assert.ok(reactStart > editStart, 'react() must follow edit()')
const editSlice = historySrc.slice(editStart, reactStart)
assert.match(editSlice, /CHAT_EDIT_MS/)
assert.match(editSlice, /editWindowMs/)
assert.doesNotMatch(
  editSlice,
  />\s*CHAT_UNSEND_MS/,
  'edit() must not compare age against CHAT_UNSEND_MS',
)
assert.match(editSlice, />\s*windowMs/)
const unsendStart = historySrc.indexOf('async authorUnsend(')
assert.ok(unsendStart > 0, 'authorUnsend() must exist')
const unsendSlice = historySrc.slice(unsendStart, unsendStart + 2500)
assert.match(unsendSlice, />\s*CHAT_UNSEND_MS/)

const roomSrc = readFileSync(
  fileURLToPath(new URL('../src/chat-room.ts', import.meta.url)),
  'utf8',
)
assert.match(roomSrc, /export const CHAT_EDIT_MS = 30 \* 60 \* 1000/)
assert.match(roomSrc, /export const CHAT_UNSEND_MS = 15 \* 60 \* 1000/)

const serverSrc = readFileSync(
  fileURLToPath(new URL('../src/server.ts', import.meta.url)),
  'utf8',
)
assert.match(serverSrc, /chatEditWindowSec/)
assert.match(serverSrc, /editWindowMs/)

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-edit-window-'))
try {
  const store = new ChatStore(dir, 90, 365, null)

  const row = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'original body',
    memberId: 'author-1',
    memberName: 'Author',
    role: 'member',
  })
  if ('error' in row) throw new Error(row.error)

  // Default / generous editWindowMs allows a brand-new message.
  const okEdit = await store.edit(
    row.id,
    'author-1',
    'edited within default window',
    false,
    CHAT_ROOM_TEAM,
  )
  assert.ok(!('error' in okEdit), `default edit must succeed: ${JSON.stringify(okEdit)}`)
  if (!('error' in okEdit)) {
    assert.equal(okEdit.body, 'edited within default window')
    assert.ok(typeof okEdit.editedAt === 'number' && okEdit.editedAt > 0)
  }

  // Custom short window: after a tiny wait, edit must expire for non-admin.
  const fresh = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'fresh for short window',
    memberId: 'author-1',
    memberName: 'Author',
    role: 'member',
  })
  if ('error' in fresh) throw new Error(fresh.error)
  await new Promise((r) => setTimeout(r, 5))
  const expiredShort = await store.edit(
    fresh.id,
    'author-1',
    'should fail',
    false,
    CHAT_ROOM_TEAM,
    1,
  )
  assert.ok('error' in expiredShort)
  assert.match(String((expiredShort as { error: string }).error), /Edit window expired/i)

  // Unsend still uses CHAT_UNSEND_MS - fresh message unsends OK.
  const forUnsend = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'unsend me',
    memberId: 'author-1',
    memberName: 'Author',
    role: 'member',
  })
  if ('error' in forUnsend) throw new Error(forUnsend.error)
  const unsent = await store.authorUnsend(forUnsend.id, 'author-1', false, CHAT_ROOM_TEAM)
  assert.ok(!('error' in unsent), `fresh unsend must succeed: ${JSON.stringify(unsent)}`)

  // Admin bypasses edit window even with editWindowMs: 1.
  const adminTarget = await store.append({
    room: CHAT_ROOM_TEAM,
    body: 'admin can edit later',
    memberId: 'author-2',
    memberName: 'Other',
    role: 'member',
  })
  if ('error' in adminTarget) throw new Error(adminTarget.error)
  await new Promise((r) => setTimeout(r, 5))
  const adminEdit = await store.edit(
    adminTarget.id,
    'admin-1',
    'admin override',
    true,
    CHAT_ROOM_TEAM,
    1,
  )
  assert.ok(!('error' in adminEdit), `admin edit must bypass window: ${JSON.stringify(adminEdit)}`)

  console.log('chat-edit-window: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
