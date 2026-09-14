/**
 * P6 admin zip: CRC + STORED zip + newest-per-member pick.
 */
import assert from 'node:assert/strict'
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { TeamBackupStore } from '../src/backup-store.js'
import {
  crc32Of,
  sanitizeZipEntryName,
  streamStoredBackupZip,
  MAX_BACKUP_ZIP_ENTRIES,
} from '../src/backup-zip.js'

assert.equal(sanitizeZipEntryName('../evil/../x.aimove'), '_evil/_x.aimove')
assert.equal(sanitizeZipEntryName('/abs/path.aimove'), 'abs/path.aimove')
assert.ok(MAX_BACKUP_ZIP_ENTRIES >= 1)

// CRC of empty + known vector (IEEE)
assert.equal(crc32Of(Buffer.alloc(0)), 0)
assert.equal(crc32Of(Buffer.from('123456789')), 0xcbf43926)

const root = mkdtempSync(join(tmpdir(), 'ts-backup-zip-'))
const store = new TeamBackupStore(root)
store.setMeta({ minIntervalMs: 0, maxKeepPerMember: 5 })

const a1 = Buffer.from('member-a-newest')
const a0 = Buffer.from('member-a-older')
const b1 = Buffer.from('member-b-only')

await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([a0]),
  contentLength: a0.length,
  label: 'older',
})
// Tiny delay so createdAt differs for newest pick
await new Promise((r) => setTimeout(r, 5))
const putA = await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([a1]),
  contentLength: a1.length,
  label: 'newest-a',
})
assert.equal(putA.ok, true)
const putB = await store.putSnapshotFromStream({
  memberId: 'mem_b',
  stream: Readable.from([b1]),
  contentLength: b1.length,
  label: 'newest-b',
})
assert.equal(putB.ok, true)

const newest = store.pickExportEntries({ mode: 'newestPerMember' })
assert.equal(newest.ok, true)
if (!newest.ok) throw new Error('newest pick failed')
assert.equal(newest.entries.length, 2)
assert.ok(newest.entries.every((e) => e.absolutePath.length > 0))

const outZip = join(root, 'export.zip')
const out = createWriteStream(outZip)
const zipped = await streamStoredBackupZip(out, newest.entries)
out.end()
await new Promise<void>((resolve, reject) => {
  out.on('finish', () => resolve())
  out.on('error', reject)
})
if (!zipped.ok) throw new Error(zipped.error)
assert.equal(zipped.entryCount, 2)
const zipBytes = readFileSync(outZip)
assert.ok(zipBytes.length > 40)
// Local file header signature
assert.equal(zipBytes.readUInt32LE(0), 0x04034b50)

const byIds = store.pickExportEntries({
  mode: 'ids',
  ids: putB.ok ? [putB.snapshot.id] : [],
})
assert.equal(byIds.ok, true)
if (byIds.ok) assert.equal(byIds.entries.length, 1)

const emptyIds = store.pickExportEntries({ mode: 'ids', ids: ['not-a-real-id-xx'] })
assert.equal(emptyIds.ok, false)

rmSync(root, { recursive: true, force: true })
console.log('backup-zip: ok')
