import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, createWriteStream, rmSync, openSync, closeSync, ftruncateSync, renameSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { planStoredBackupZip, streamPlannedBackupZip, streamStoredBackupZip } from '../src/backup-zip.js'

const root = mkdtempSync(join(tmpdir(), 'backup-zip-runtime-'))
try {
  const source = join(root, 'history.jsonl')
  writeFileSync(source, 'old row\n')
  const plan = await planStoredBackupZip([{ name: 'chat/历史.jsonl', size: 8, absolutePath: source }])
  assert.ok(plan.ok)
  // Same-length rewrite used to produce success with the CRC from the old pass.
  writeFileSync(source, 'new row\n')
  const zipPath = join(root, 'export.zip')
  const out = createWriteStream(zipPath)
  const result = await streamPlannedBackupZip(out, plan.planned, plan.contentLength)
  assert.ok(result.ok, JSON.stringify(result))
  out.end()
  await once(out, 'finish')
  const verified = spawnSync('python3', ['-c', "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('chat/历史.jsonl') == b'new row\\n'; assert z.infolist()[0].extract_version == 45", zipPath], { encoding: 'utf8' })
  assert.equal(verified.status, 0, verified.stderr)

  const large = join(root, 'large.aimove')
  const fd = openSync(large, 'w')
  ftruncateSync(fd, 4 * 1024 * 1024 * 1024 + 17)
  closeSync(fd)
  const largePlan = await planStoredBackupZip([{ name: 'large.aimove', size: 1, absolutePath: large }])
  assert.ok(largePlan.ok)
  assert.equal(largePlan.totalPayloadBytes, 4 * 1024 * 1024 * 1024 + 17, 'ZIP64 planning uses actual 64-bit file sizes rather than untrusted index sizes')
  assert.equal(largePlan.contentLength, largePlan.totalPayloadBytes + 30 + 12 + 20 + 24 + 46 + 12 + 28 + 98)

  const collision = await planStoredBackupZip([
    { name: 'A.aimove', size: 8, absolutePath: source },
    { name: 'a.aimove', size: 8, absolutePath: source },
  ])
  assert.equal(collision.ok, false)
  symlinkSync(source, join(root, 'linked'))
  assert.equal((await planStoredBackupZip([{ name: 'linked', size: 8, absolutePath: join(root, 'linked') }])).ok, false)

  const replacePlan = await planStoredBackupZip([{ name: 'history.jsonl', size: 8, absolutePath: source }])
  assert.ok(replacePlan.ok)
  writeFileSync(join(root, 'replacement'), 'another\n')
  renameSync(join(root, 'replacement'), source)
  const sink = new Writable({ write(_chunk, _encoding, callback) { callback() } })
  assert.equal((await streamPlannedBackupZip(sink, replacePlan.planned)).ok, false, 'atomic file replacement fails explicitly instead of mixing file versions')

  const blocked = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { setImmediate(() => this.destroy()) } })
  const closed = await Promise.race([
    streamStoredBackupZip(blocked, [{ name: 'history.jsonl', size: 8, absolutePath: source }]),
    new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('cancelled export remained stuck waiting for drain')), 2_000); timer.unref() }),
  ])
  assert.equal(closed.ok, false)
  console.log('backup-zip-runtime: independent Python ZIP64/CRC verification; same-size rewrite; >4GiB sparse planning; duplicate/symlink refusal; inode replacement and cancelled drain passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
