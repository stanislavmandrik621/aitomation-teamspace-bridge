/**
 * Chat tree included in team-server backup walks + export.zip wiring.
 */
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createWriteStream, readFileSync } from 'node:fs'
import {
  enumerateChatBackupFiles,
  listChatBackupZipEntries,
  TeamBackupStore,
} from '../src/backup-store.js'
import { streamStoredBackupZip, MAX_BACKUP_ZIP_CHAT_ENTRIES } from '../src/backup-zip.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-chat-backup-'))
try {
  mkdirSync(join(dir, 'chat', 'rooms', 'team'), { recursive: true })
  writeFileSync(join(dir, 'chat', 'rooms.json'), '{}', 'utf8')
  writeFileSync(join(dir, 'chat', 'rooms', 'team', 'messages.jsonl'), 'x\n', 'utf8')

  const files = enumerateChatBackupFiles(dir)
  assert.ok(files.includes('chat/rooms.json'))
  assert.ok(files.some((f) => f.includes('chat/rooms/team/messages.jsonl')))

  const listed = listChatBackupZipEntries(dir)
  assert.equal(listed.truncated, false)
  assert.ok(listed.entries.some((e) => e.name === 'chat/rooms.json'))
  assert.ok(listed.entries.every((e) => existsSync(e.absolutePath)))

  // TCC-R1132-BKP-001: top-level metadata files must survive a saturated
  // cap even though attachment fan-out under chat/rooms/ can sort ahead of
  // them in readdirSync order. Also add unread.json / blob-registry.json so
  // all three CHAT_BACKUP_TOP_LEVEL entries are proven, not just rooms.json.
  const capDir = mkdtempSync(join(tmpdir(), 'ts-chat-backup-cap-'))
  try {
    mkdirSync(join(capDir, 'chat', 'rooms', 'team'), { recursive: true })
    writeFileSync(join(capDir, 'chat', 'rooms.json'), '{}', 'utf8')
    writeFileSync(join(capDir, 'chat', 'unread.json'), '{}', 'utf8')
    writeFileSync(join(capDir, 'chat', 'blob-registry.json'), '{}', 'utf8')
    // Fan out more attachment files than the cap so the walk saturates
    // before it would otherwise reach the root-level metadata files.
    for (let i = 0; i < 10; i++) {
      writeFileSync(join(capDir, 'chat', 'rooms', 'team', `msg-${i}.jsonl`), 'x\n', 'utf8')
    }
    const capped = listChatBackupZipEntries(capDir, 3)
    assert.equal(capped.truncated, true)
    assert.ok(
      capped.files.includes('chat/rooms.json'),
      'rooms.json must survive a saturated cap',
    )
    assert.ok(
      capped.files.includes('chat/unread.json'),
      'unread.json must survive a saturated cap',
    )
    assert.ok(
      capped.files.includes('chat/blob-registry.json'),
      'blob-registry.json must survive a saturated cap',
    )
  } finally {
    rmSync(capDir, { recursive: true, force: true })
  }

  const store = new TeamBackupStore(dir)
  store.setMeta({ minIntervalMs: 0, maxKeepPerMember: 5 })
  const chatOnly = store.pickChatExportEntries(MAX_BACKUP_ZIP_CHAT_ENTRIES)
  assert.ok(chatOnly.entries.length >= 2)

  // newestPerMember with no aimoves still ok (chat-only export path).
  const emptyAimove = store.pickExportEntries({ mode: 'newestPerMember' })
  assert.equal(emptyAimove.ok, true)
  if (emptyAimove.ok) assert.equal(emptyAimove.entries.length, 0)

  const aimove = Buffer.from('member-snap')
  const put = await store.putSnapshotFromStream({
    memberId: 'mem_x',
    stream: Readable.from([aimove]),
    contentLength: aimove.length,
    label: 'snap',
  })
  assert.equal(put.ok, true)

  const picked = store.pickExportEntries({ mode: 'newestPerMember' })
  assert.equal(picked.ok, true)
  if (!picked.ok) throw new Error('pick failed')
  const zipEntries = [
    ...picked.entries.map((e) => ({
      name: e.name,
      size: e.size,
      absolutePath: e.absolutePath,
    })),
    ...store.pickChatExportEntries().entries,
  ]
  assert.ok(zipEntries.some((e) => e.name.startsWith('chat/')))
  assert.ok(zipEntries.some((e) => e.name.endsWith('.aimove')))

  const outZip = join(dir, 'with-chat.zip')
  const out = createWriteStream(outZip)
  const zipped = await streamStoredBackupZip(out, zipEntries)
  out.end()
  await new Promise<void>((resolve, reject) => {
    out.on('finish', () => resolve())
    out.on('error', reject)
  })
  assert.equal(zipped.ok, true)
  if (!zipped.ok) throw new Error(zipped.error)
  assert.ok(zipped.entryCount >= 3)
  const zipBytes = readFileSync(outZip)
  assert.equal(zipBytes.readUInt32LE(0), 0x04034b50)
  // Entry names appear in local headers as UTF-8
  const asText = zipBytes.toString('binary')
  assert.ok(asText.includes('chat/rooms.json'))

  console.log('chat-backup-paths: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
