/**
 * TCC-R1134-CHAT-021: boot-time crash-recovery sweep for leftover
 * `.tmp`/`.part` files under `chat/` from an interrupted write-then-rename.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { cleanupChatTmpFiles } from '../src/chat-tmp-sweep.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-tmp-sweep-'))
try {
  // No `chat/` dir yet at all - must no-op, never throw.
  assert.equal(cleanupChatTmpFiles(dir), 0)

  const chatDir = join(dir, 'chat')
  const roomsDir = join(chatDir, 'rooms')
  const blobsDir = join(chatDir, 'blobs')
  mkdirSync(roomsDir, { recursive: true })
  mkdirSync(blobsDir, { recursive: true })

  // Orphaned tmp files left by an interrupted `writeFileSync(tmp)` +
  // `renameSync(tmp, dest)` at various nesting depths, plus real files that
  // must be left untouched.
  const orphanRoomTmp = join(roomsDir, 'unread.json.12345.tmp')
  const orphanBlobPart = join(blobsDir, 'abcd1234.part')
  const realRoomsFile = join(chatDir, 'rooms.json')
  const realJsonlFile = join(roomsDir, 'chat-team.jsonl')
  writeFileSync(orphanRoomTmp, '{"version":1,"marks":{}}', 'utf8')
  writeFileSync(orphanBlobPart, 'partial-bytes', 'utf8')
  writeFileSync(realRoomsFile, '{"version":1,"rooms":[]}', 'utf8')
  writeFileSync(realJsonlFile, '{"id":"m1"}\n', 'utf8')

  const removed = cleanupChatTmpFiles(dir)
  assert.equal(removed, 2, 'must remove exactly the 2 orphaned tmp/part files')
  assert.equal(existsSync(orphanRoomTmp), false, 'orphaned .tmp file must be removed')
  assert.equal(existsSync(orphanBlobPart), false, 'orphaned .part file must be removed')
  assert.equal(existsSync(realRoomsFile), true, 'real rooms.json must survive the sweep')
  assert.equal(existsSync(realJsonlFile), true, 'real .jsonl room history must survive the sweep')

  // Idempotent: running again after the first sweep finds nothing left.
  assert.equal(cleanupChatTmpFiles(dir), 0)

  console.log('chat-tmp-sweep: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
