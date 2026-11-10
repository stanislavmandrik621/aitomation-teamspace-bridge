import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, lstatSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Writable } from 'node:stream'
import { BackupInventoryWave96, walkChatWave96 } from '../src/wave96-backup-inventory.js'
import { streamPlannedBackupZip, crc32Of } from '../src/backup-zip.js'
import { TeamBackupStore } from '../src/backup-store.js'

function bytes(path: string): number { const s = lstatSync(path); return s.isDirectory() ? readdirSync(path).reduce((n, f) => n + bytes(join(path, f)), 0) : s.size }
async function fixture(run: (path: string) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'aiq-wave96-backup-'))
  try { await run(path) } catch (error) { console.error(JSON.stringify({ preservedFailedFixture: path, bytes: bytes(path) })); throw error }
  console.log(JSON.stringify({ preservedFixture: path, bytes: bytes(path), reason: "Preserve all database/test evidence" }))
}
function inventory(path: string) { const stage = join(path, 'stage'); mkdirSync(stage); return new BackupInventoryWave96(stage) }

test('real ZIP path emits 50,001 chat entries + 501 snapshots from a controlled lazy inventory', async () => fixture(async path => {
  const source = join(path, 'payload'); writeFileSync(source, 'x')
  const spool = inventory(path)
  try {
    async function* entries() {
      for (let n = 0; n < 501; n++) yield { name: `member/snapshot-${n}.aimove`, size: 1, absolutePath: source }
      for (let n = 0; n < 50_001; n++) yield { name: `chat/room/file-${n}.bin`, size: 1, absolutePath: source }
    }
    await spool.collect(entries())
    assert.equal(spool.chatCount, 50_001); assert.equal(spool.snapshotCount, 501)
    let local = 0, central = 0, wireBytes = 0, lastName = '', descriptors = 0
    const crc = crc32Of(Buffer.from('x'))
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
      wireBytes += chunk.length
      if (chunk.length >= 4) {
        const magic = chunk.readUInt32LE(0)
        if (magic === 0x04034b50) local++
        if (magic === 0x08074b50) { descriptors++; assert.equal(chunk.readUInt32LE(4), crc) }
        if (magic === 0x02014b50) { central++; lastName = chunk.subarray(46, 46 + chunk.readUInt16LE(28)).toString(); assert.equal(chunk.readUInt32LE(16), crc) }
      }
      callback()
    } })
    const layout = await spool.measure()
    const result = await streamPlannedBackupZip(sink, spool, layout.contentLength, { central: spool.centralStore() })
    assert.equal(result.ok, true); assert.equal(local, 50_502); assert.equal(central, local); assert.equal(descriptors, local)
    assert.equal(lastName, 'chat/room/file-50000.bin'); assert.equal(wireBytes, layout.contentLength)
    sink.destroy()
  } finally { spool.close() }
}))

test('full store iterator crosses 500 snapshots without listAll or a large ID query', async () => fixture(async path => {
  const store = new TeamBackupStore(path)
  for (let member = 0; member < 3; member++) {
    const memberId = `member_${member}`, dir = join(path, 'backups', 'members', memberId)
    mkdirSync(join(dir, 'snapshots'), { recursive: true })
    const snapshots = Array.from({ length: 167 }, (_, n) => {
      const id = `snapshot_${member}_${n}`
      writeFileSync(join(dir, 'snapshots', `${id}.aimove`), 'x')
      return { id, bytes: 1, createdAt: n + 1, sha256: createHash('sha256').update('x').digest('hex'), label: '', includesBrowserSessions: false }
    })
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ snapshots }))
  }
  store.listAll = () => { throw Error('Must not materialize all snapshots') }
  let count = 0
  for await (const entry of store.iterateFullExportEntries()) { assert.equal(entry.size, 1); count++ }
  assert.equal(count, 501)
}))

test('walker preserves authority metadata, avoids symlinks and reports depth errors', async () => fixture(async path => {
  const authority = join(path, 'authority'); mkdirSync(join(authority, 'chat'), { recursive: true })
  mkdirSync(join(path, 'chat')); writeFileSync(join(path, 'chat', 'rooms.json'), 'old')
  writeFileSync(join(authority, 'chat', 'rooms.json'), 'new')
  writeFileSync(join(path, 'chat', 'history.jsonl'), 'x')
  symlinkSync(join(path, 'chat', 'history.jsonl'), join(path, 'chat', 'link'))
  const entries = []
  for await (const entry of walkChatWave96(path, authority)) entries.push(entry)
  assert.equal(entries.length, 2); assert.equal(entries[0]!.absolutePath, join(authority, 'chat', 'rooms.json'))
  mkdirSync(join(path, 'chat', ...Array(16).fill('deep')), { recursive: true })
  await assert.rejects(async () => { for await (const _ of walkChatWave96(path)) {} }, /depth/)
}))

test('disk identity index rejects aliases; metadata snapshots stay distinct across singleton collection', async () => fixture(async path => {
  const a = join(path, 'a'); const b = join(path, 'b'); writeFileSync(a, '{"a":1}'); writeFileSync(b, '{"b":2}')
  const spool = inventory(path)
  try {
    await spool.collect([{ name: 'chat/a.json', absolutePath: a, size: 7 }, { name: 'chat/b.json', absolutePath: b, size: 7 }])
    const planned = [...spool]; assert.notEqual(planned[0]!.absolutePath, planned[1]!.absolutePath)
    await assert.rejects(spool.collect([{ name: 'CHAT/A.JSON', absolutePath: a, size: 7 }]), /UNIQUE/)
  } finally { spool.close() }
}))

test('cancellation and authorization loss fail inventory and ZIP streaming', async () => fixture(async path => {
  const source = join(path, 'payload'); writeFileSync(source, 'x')
  const spool = inventory(path); const entry = { name: 'x', absolutePath: source, size: 1 }
  try {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(spool.collect([entry], { signal: controller.signal }), /abort/i)
    await assert.rejects(spool.collect([entry], { authorize: () => false }), /allowed/)
    await spool.collect([entry])
    const out = new Writable({ write(_chunk, _encoding, cb) { cb() } })
    const result = await streamPlannedBackupZip(out, spool, (await spool.measure()).contentLength, { central: spool.centralStore(), authorize: () => false })
    assert.equal(result.ok, false); out.destroy()
  } finally { spool.close() }
}))

test('collection and layout measurement yield for mid-operation cancellation', async () => fixture(async path => {
  const source = join(path, 'payload'); writeFileSync(source, '')
  const spool = inventory(path); const collecting = new AbortController()
  try {
    async function* entries() {
      for (let n = 0; n < 1000; n++) {
        if (n === 63) setImmediate(() => collecting.abort())
        yield { name: `file-${n}`, absolutePath: source, size: 0 }
      }
    }
    await assert.rejects(spool.collect(entries(), { signal: collecting.signal }), /abort/i)
    assert.ok(spool.count >= 64 && spool.count < 1000)
    const measuring = new AbortController()
    setImmediate(() => measuring.abort())
    await assert.rejects(spool.measure({ signal: measuring.signal }), /abort/i)
  } finally { spool.close() }
}))

test('central directory yields and rechecks authorization during long zero-byte exports', async () => fixture(async path => {
  const source = join(path, 'payload'); writeFileSync(source, '')
  const spool = inventory(path)
  try {
    function* entries() { for (let n = 0; n < 192; n++) yield { name: `file-${n}`, absolutePath: source, size: 0 } }
    await spool.collect(entries())
    let allowed = true, central = 0
    const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
      if (chunk.length >= 4 && chunk.readUInt32LE(0) === 0x02014b50) {
        if (++central === 1) setImmediate(() => { allowed = false })
      }
      callback()
    } })
    const result = await streamPlannedBackupZip(sink, spool, (await spool.measure()).contentLength, { central: spool.centralStore(), authorize: () => allowed })
    assert.equal(result.ok, false); assert.ok(central > 0 && central < 192); sink.destroy()
  } finally { spool.close() }
}))

test('final central-directory yield cannot turn revocation or abort into complete ZIP success', async () => fixture(async path => {
  const source = join(path, 'payload'); writeFileSync(source, '')
  const spool = inventory(path)
  try {
    function* entries() { for (let n = 0; n < 64; n++) yield { name: `file-${n}`, absolutePath: source, size: 0 } }
    await spool.collect(entries())
    const layout = await spool.measure()
    for (const cause of ['revoke', 'abort']) {
      let allowed = true, central = 0, footers = 0
      const controller = new AbortController()
      const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
        if (chunk.length >= 4) {
          const signature = chunk.readUInt32LE(0)
          if (signature === 0x02014b50 && ++central === 64) {
            setImmediate(() => { if (cause === 'revoke') allowed = false; else controller.abort() })
          }
          if (signature === 0x06064b50 || signature === 0x06054b50) footers++
        }
        callback()
      } })
      const result = await streamPlannedBackupZip(sink, spool, layout.contentLength, { central: spool.centralStore(), authorize: () => allowed, signal: controller.signal })
      assert.equal(result.ok, false); assert.equal(central, 64); assert.equal(footers, 0); sink.destroy()
    }
  } finally { spool.close() }
}))

// Real desktop HTTP boundary: old servers must never promote a smaller archive.
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { teamSpaceBackupExportZip } from '../../../apps/desktop/electron/modules-sync/teamspace-backup-http.js'

test('desktop full mode refuses absent/mismatched acknowledgement and accepts explicit all', async () => fixture(async path => {
  for (const mode of [undefined, 'newestPerMember', 'all']) {
    const server = createServer((req, res) => {
      assert.equal(new URL(req.url!, 'http://localhost').searchParams.get('mode'), 'all')
      res.writeHead(200, { 'content-length': '2', ...(mode ? { 'x-backup-export-mode': mode } : {}) }); res.end('PK')
    })
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address(); assert.ok(address && typeof address !== 'string')
      const destination = join(path, `result-${String(mode)}.zip`)
      writeFileSync(destination, 'existing')
      const result = await teamSpaceBackupExportZip({ usedOrigin: `http://127.0.0.1:${address.port}`, sessionToken: 'wave96-fixture', caller: 'wave96-backup', outFilePath: destination, mode: 'all', signal: AbortSignal.timeout(5000) })
      assert.equal(result.ok, mode === 'all')
      assert.equal(readFileSync(destination, 'utf8'), mode === 'all' ? 'PK' : 'existing')
      assert.equal(existsSync(`${destination}.part`), false)
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    }
  }
}))
