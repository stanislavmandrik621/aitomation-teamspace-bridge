import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { TeamBackupStore, isSafeBackupMemberId } from '../src/backup-store.js'

const root = mkdtempSync(join(tmpdir(), 'backup-device-member-'))
try {
  const store = new TeamBackupStore(root)
  store.setMeta({ minIntervalMs: 0 })
  const legacy = 'device:82651652-0fb5-43df-ad6a-9a340e6a8725'
  const ordinary = 'device_82651652-0fb5-43df-ad6a-9a340e6a8725'
  for (const memberId of [legacy, ordinary]) {
    assert.equal(isSafeBackupMemberId(memberId), true)
    const payload = Buffer.from(memberId)
    const result = await store.putSnapshotFromStream({memberId, stream: Readable.from([payload]), contentLength: payload.length, includesBrowserSessions: false})
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  for (const bad of ['device:../x', 'device:..', 'device:x.', encodeURIComponent(legacy), 'member:other', 'device:x\\y']) assert.equal(isSafeBackupMemberId(bad), false, bad)
  const reopened = new TeamBackupStore(root)
  assert.deepEqual(reopened.listMemberFolderIds().sort(), [legacy, ordinary].sort())
  assert.equal(reopened.listAll().length, 2)
  assert.equal(reopened.listForMember(legacy).length, 1)
  const exported = reopened.pickExportEntries({mode:'newestPerMember'})
  assert.equal(exported.ok, true)
  if (!exported.ok) throw Error(exported.error)
  assert.equal(new Set(exported.entries.map(e=>e.name)).size, 2)
  assert.ok(exported.entries.every(e=>!e.name.includes(':')&&!e.absolutePath.includes('device:')))
  for (const entry of exported.entries) {
    const handle = await reopened.openSnapshotRead(entry.row.memberId, entry.row.id)
    assert.ok(handle)
    const chunks: Buffer[] = []
    for await (const chunk of handle!.stream) chunks.push(Buffer.from(chunk))
    assert.equal(Buffer.concat(chunks).toString(), entry.row.memberId)
  }
  const entry = exported.entries.find(e=>e.row.memberId===legacy)!
  writeFileSync(join(entry.absolutePath, '..', 'orphan.part'), 'partial')
  assert.equal(reopened.cleanupPartials(), 1)
  assert.equal((await reopened.deleteAllForMember(legacy)).ok, true)
  assert.equal(reopened.listForMember(ordinary).length, 1)
  assert.equal(reopened.listForMember(legacy).length, 0)
  console.log('backup device members: encoded folders, restart, own reads, export, partial cleanup and isolated deletion passed')
} finally { rmSync(root, {recursive:true,force:true}) }
