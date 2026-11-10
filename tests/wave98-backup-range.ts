import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { planBackupRangeWave98 } from '../src/wave98-backup-range.js'
import { TeamBackupStore } from '../src/backup-store.js'
const sha = 'a'.repeat(64), tag = `"${sha}"`
test('single exact range requires strong matching validator; malformed and unsafe offsets refuse', () => {
  assert.deepEqual(planBackupRangeWave98(undefined, undefined, sha, 100), { ok: true, status: 200, start: 0, length: 100, etag: tag })
  assert.deepEqual(planBackupRangeWave98('bytes=99-', tag, sha, 100), { ok: true, status: 206, start: 99, length: 1, etag: tag, contentRange: 'bytes 99-99/100' })
  for (const match of [undefined, '*', `W/${tag}`, '"changed"', [tag]]) assert.equal(planBackupRangeWave98('bytes=1-', match, sha, 100).ok, false)
  for (const range of ['bytes=-5', 'bytes=0-1,2-3', 'bytes=01-', 'bytes=100-', 'bytes=9007199254740992-', ['bytes=1-']]) assert.equal(planBackupRangeWave98(range, tag, sha, 100).ok, false)
  const big = planBackupRangeWave98('bytes=34359738368-', tag, sha, 34359738369)
  assert.equal(big.ok && big.length, 1) // Numeric framing only; no large physical file.
})
test('actual store range pins current identity, bounds suffix and survives unlink of opened inode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiq-wave98-range-'))
  console.log(JSON.stringify({ preservedFixture: root, reason: 'Preserve all database/source/test evidence' }))
  const store = new TeamBackupStore(root), body = Buffer.from('complete immutable sealed snapshot')
  const added = await store.putSnapshotFromStream({ memberId: 'member_one', stream: Readable.from([body]), contentLength: body.length, label: 'test', includesBrowserSessions: false })
  assert.equal(added.ok, true); if (!added.ok) return
  const row = added.snapshot
  assert.equal(await store.openSnapshotRead(row.memberId, row.id, { start: 1, sha256: sha }), null)
  const opened = await store.openSnapshotRead(row.memberId, row.id, { start: 7, sha256: row.sha256 }); assert.ok(opened)
  await store.deleteSnapshot(row.memberId, row.id)
  const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk))
  assert.equal(opened.size, body.length); assert.deepEqual(Buffer.concat(chunks), body.subarray(7))
})
