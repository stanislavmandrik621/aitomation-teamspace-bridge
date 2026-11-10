import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, lstatSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { addBackupZip64BytesWave94 as add, measureBackupZip64Wave94 as measure } from '../src/backup-wave94-zip64.js'
import { planStoredBackupZip, streamPlannedBackupZip } from '../src/backup-zip.js'

const oldCap = 32 * 1024 ** 3
const entry = (size: number, name = 'x') => ({ size, nameBuf: Buffer.from(name) })
function diskBytes(path: string): number { const s = lstatSync(path); return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + diskBytes(join(path, f)), 0) : s.size }
async function fixture(run: (path: string) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'aiq-wave94-zip-'))
  try { await run(path) } catch (error) { console.error(JSON.stringify({ preservedFailedFixture: path, bytes: diskBytes(path) })); throw error }
  const bytes = diskBytes(path); rmSync(path, { recursive: true }); console.log(JSON.stringify({ cleanedPath: path, bytes }))
}
function sink(chunks: Buffer[]) { return new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback() } }) }

test('ZIP64 layout admits aggregate >32 GiB and computes exact offsets without payload allocation', () => {
  const sizes = [8 * 1024 ** 3, 8 * 1024 ** 3, 8 * 1024 ** 3, 8 * 1024 ** 3, 17]
  const layout = measure(sizes.map(size => entry(size)))
  assert.equal(layout.totalPayloadBytes, oldCap + 17)
  assert.equal(layout.centralOffset, oldCap + 17 + 5 * 75)
  assert.equal(layout.centralBytes, 5 * 75)
  assert.equal(layout.contentLength, oldCap + 17 + 5 * 150 + 98)
})

test('ZIP64 exact Number boundary includes all headers; invalid/overflow/u16 names refuse', () => {
  const max = Number.MAX_SAFE_INTEGER
  assert.equal(measure([entry(max - 248)]).contentLength, max)
  assert.throws(() => measure([entry(max - 247)]), /exact byte indexing/)
  assert.throws(() => measure([entry(max), entry(1)]), /exact byte indexing/)
  for (const size of [-1, 1.5, NaN, Infinity, max + 1]) assert.throws(() => measure([entry(size)]))
  for (const length of [0, 65536, 1.5]) assert.throws(() => measure([{ size: 0, nameBuf: { length } }]), /name length/)
  assert.equal(add(oldCap, 3), oldCap + 3)
  assert.throws(() => add(max, 1), /exact byte indexing/)
})

test('live writer preflights layout/declared length before emitting any bytes', async () => {
  const chunks: Buffer[] = [], out = sink(chunks)
  const invalid = { ...entry(Number.MAX_SAFE_INTEGER), absolutePath: '/not-opened', device: 0, inode: 0, crc: 0 }
  const failed = await streamPlannedBackupZip(out, [invalid])
  assert.equal(failed.ok, false); assert.equal(chunks.length, 0)
  const mismatch = await streamPlannedBackupZip(out, [{ ...invalid, size: 0 }], 1)
  assert.deepEqual(mismatch, { ok: false, error: 'Export size mismatch' }); assert.equal(chunks.length, 0)
  out.destroy()
})

test('live writer admits >32 GiB header then fails honestly on unavailable source; never fabricates payload success', async () => {
  const chunks: Buffer[] = [], out = sink(chunks), size = oldCap + 17
  const result = await streamPlannedBackupZip(out, [{ ...entry(size), absolutePath: '/wave94-no-source', device: 0, inode: 0, crc: 0 }])
  assert.equal(result.ok, false)
  assert.equal(chunks.length, 1, 'only local header emitted before real file open fails')
  const header = chunks[0]!
  assert.equal(header.readUInt32LE(0), 0x04034b50)
  assert.equal(header.readUInt32LE(18), 0xffffffff)
  assert.equal(header.readBigUInt64LE(35), BigInt(size))
  assert.equal(header.readBigUInt64LE(43), BigInt(size))
  out.destroy()
})

test('actual small-file ZIP64 roundtrip preserves Unicode/NUL and exact CRC, prefix boundary and length', async () => fixture(async path => {
  const source = join(path, 'input'), payload = Buffer.from('完整\0🙂EOF\n')
  writeFileSync(source, payload)
  const plan = await planStoredBackupZip([{ name: 'chat/历史.jsonl', size: payload.length, absolutePath: source }])
  assert.ok(plan.ok)
  writeFileSync(source, Buffer.concat([payload, Buffer.from('later appended')]))
  const chunks: Buffer[] = [], out = sink(chunks)
  const result = await streamPlannedBackupZip(out, plan.planned, plan.contentLength)
  assert.ok(result.ok); out.end()
  const bytes = Buffer.concat(chunks), archive = join(path, 'export.zip')
  assert.equal(bytes.length, plan.contentLength); assert.equal(result.totalBytes, payload.length)
  writeFileSync(archive, bytes)
  // Independent standard ZIP reader verifies central directory offsets, CRC and content.
  const check = spawnSync('python3', ['-c', "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert z.read('chat/历史.jsonl') == '完整\\0🙂EOF\\n'.encode(); assert z.infolist()[0].extract_version == 45", archive], { encoding: 'utf8' })
  assert.equal(check.status, 0, check.stderr)
  assert.equal(readFileSync(source).length, payload.length + 14)
}))

test('authority revocation, inode replacement and cancelled backpressure fail rather than complete', async () => fixture(async path => {
  const source = join(path, 'input'); writeFileSync(source, 'original')
  const plan = await planStoredBackupZip([{ name: 'x', size: 8, absolutePath: source }]); assert.ok(plan.ok)
  const chunks: Buffer[] = [], out = sink(chunks)
  const denied = await streamPlannedBackupZip(out, plan.planned, plan.contentLength, { authorize: () => false })
  assert.equal(denied.ok, false); assert.equal(chunks.length, 0); out.destroy()
  writeFileSync(join(path, 'replacement'), 'changed!'); renameSync(join(path, 'replacement'), source)
  const replaced = sink([])
  assert.equal((await streamPlannedBackupZip(replaced, plan.planned, plan.contentLength)).ok, false); replaced.destroy()
  const fresh = await planStoredBackupZip([{ name: 'x', size: 8, absolutePath: source }]); assert.ok(fresh.ok)
  const blocked = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { setImmediate(() => this.destroy()) } })
  const result = await streamPlannedBackupZip(blocked, fresh.planned, fresh.contentLength)
  assert.equal(result.ok, false)
}))
