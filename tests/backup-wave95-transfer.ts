import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { TeamBackupStore } from '../src/backup-store.js'
import { validBackupTransferSizeWave95 as valid, parseBackupTransferLengthWave95 as parse, advanceBackupTransferWave95 as advance, backupQuotaFitsWave95 as fits, addBackupStorageBytesWave95 as add } from '../src/backup-wave95-transfer.js'
const large = 8 * 1024 ** 3 + 17
function files(path: string): { path: string; bytes: number }[] { return readdirSync(path).flatMap(name => { const p = join(path, name), s = statSync(p); return s.isDirectory() ? files(p) : [{ path: p, bytes: s.size }] }) }
async function fixture(run: (store: TeamBackupStore, path: string) => Promise<void>) {
  const path = mkdtempSync(join(tmpdir(), 'aiq-wave95-transfer-')), store = new TeamBackupStore(path)
  store.setMeta({ minIntervalMs: 0, maxKeepPerMember: 10 })
  try { await run(store, path) } catch (error) { console.error(JSON.stringify({ preservedFailedFixture95: path, files: files(path) })); throw error }
  const owned = files(path); rmSync(path, { recursive: true }); console.log(JSON.stringify({ removedRoot: path, successfulFixtureCleanup95: owned }))
}

test('exact length and chunk accounting crosses8GiB without allocating payload; unsafe/fractional/overrun sizes refuse', () => {
  assert.equal(parse(String(large)), large); assert.equal(valid(large), true)
  assert.equal(advance(large - 5, 5, large), large)
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.equal(valid(value), false)
  for (const value of ['8e9', '1.5', '-1', '0', '9007199254740992', ['12'], undefined]) assert.equal(parse(value), undefined)
  assert.throws(() => advance(large - 5, 6, large), /Content-Length/)
  assert.throws(() => advance(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER), /Content-Length/)
})

test('quota arithmetic remains exact near Number limit and honors configured storage quota', () => {
  const max = Number.MAX_SAFE_INTEGER
  assert.equal(fits(max, max - 1, 1), true); assert.equal(fits(max, max, 1), false)
  assert.equal(fits(large - 1, large), false); assert.equal(fits(large, large), true)
  assert.equal(add(max - 1, 1), max); assert.throws(() => add(max, 1), /exact byte indexing/)
})

test('actual store admits >8GiB declared snapshot then tiny interrupted stream fails atomically with no published snapshot', async () => fixture(async (store, path) => {
  let consumed = false
  const stream = Readable.from((async function* () { consumed = true; yield Buffer.from('tiny prefix'); throw new Error('fixture interrupted, no huge transfer') })())
  const result = await store.putSnapshotFromStream({ memberId: 'mem_large', stream, contentLength: large })
  assert.equal(consumed, true, 'old8GiB guard would reject before consuming')
  assert.equal(result.ok, false); assert.match(!result.ok ? result.error : '', /fixture interrupted/)
  assert.equal(store.listForMember('mem_large').length, 0)
  assert.equal(files(path).some(f => /\.part$|\.aimove$/.test(f.path)), false)
}))

test('actual store enforces quota for >8GiB selection and releases failed team reservation', async () => fixture(async (store, path) => {
  store.setMeta({ maxBytesPerMember: large - 1, maxBytesTeam: large })
  const refused = await store.putSnapshotFromStream({ memberId: 'mem_a', stream: Readable.from([Buffer.from('x')]), contentLength: large })
  assert.equal(refused.ok, false); assert.match(!refused.ok ? refused.error : '', /size limit/)
  store.setMeta({ maxBytesPerMember: large + 10, maxBytesTeam: large })
  const failed = await store.putSnapshotFromStream({ memberId: 'mem_b', stream: Readable.from([Buffer.from('x')]), contentLength: large })
  assert.equal(failed.ok, false)
  store.setMeta({ maxBytesTeam: 2 })
  const next = await store.putSnapshotFromStream({ memberId: 'mem_c', stream: Readable.from([Buffer.from('ok')]), contentLength: 2 })
  assert.ok(next.ok, 'failed large upload releases team reservation'); assert.equal(next.snapshot.bytes, 2)
  assert.equal(files(path).filter(f => f.path.endsWith('.part')).length, 0)
}))

test('actual small snapshot roundtrip SHA is exact and invalid checksum/overrun/revoked authority never publish', async () => fixture(async (store, path) => {
  const body = Buffer.from('complete Unicode🙂\0TAIL'), sha = createHash('sha256').update(body).digest('hex')
  const saved = await store.putSnapshotFromStream({ memberId: 'mem_ok', stream: Readable.from([body.subarray(0, 4), body.subarray(4)]), contentLength: body.length, sha256Expected: sha })
  assert.ok(saved.ok); assert.equal(saved.snapshot.sha256, sha)
  const opened = await store.openSnapshotRead('mem_ok', saved.snapshot.id); assert.ok(opened)
  const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk)); assert.deepEqual(Buffer.concat(chunks), body)
  for (const mode of ['checksum', 'length', 'revoke'] as const) {
    let allowed = true
    const stream = Readable.from((async function* () { yield body; if (mode === 'revoke') allowed = false })())
    const result = await store.putSnapshotFromStream({ memberId: `mem_${mode}`, stream, contentLength: mode === 'length' ? body.length - 1 : body.length, sha256Expected: mode === 'checksum' ? '0'.repeat(64) : sha, authorize: () => allowed })
    assert.equal(result.ok, false); assert.equal(store.listForMember(`mem_${mode}`).length, 0)
  }
  assert.equal(files(path).filter(f => f.path.endsWith('.part')).length, 0)
}))

// A filesystem/accounting error can arise after the pipeline, before promotion.
test('post-stream quota accounting failure removes only owned partial and preserves prior snapshot', async () => fixture(async (store, path) => {
  const saved = await store.putSnapshotFromStream({ memberId: 'mem_a', stream: Readable.from([Buffer.from('prior')]), contentLength: 5 }); assert.ok(saved.ok)
  const internals = store as unknown as { memberBytes(id: string): number }
  const original = internals.memberBytes.bind(store); let checks = 0
  internals.memberBytes = id => { if (++checks === 2) throw new Error('fixture quota stat failed'); return original(id) }
  const failed = await store.putSnapshotFromStream({ memberId: 'mem_a', stream: Readable.from([Buffer.from('new')]), contentLength: 3 })
  internals.memberBytes = original
  assert.equal(failed.ok, false); assert.match(!failed.ok ? failed.error : '', /quota stat failed/)
  assert.deepEqual(store.listForMember('mem_a').map(r => r.id), [saved.snapshot.id])
  assert.equal(files(path).filter(f => f.path.endsWith('.part')).length, 0)
  const opened = await store.openSnapshotRead('mem_a', saved.snapshot.id); assert.ok(opened)
  const chunks: Buffer[] = []; for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk)); assert.equal(Buffer.concat(chunks).toString(), 'prior')
}))
