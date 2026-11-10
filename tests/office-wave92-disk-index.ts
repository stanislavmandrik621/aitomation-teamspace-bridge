import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readdir, readFile, rm, writeFile, open, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { OfficeListDiskIndexWave92 } from '../src/util/office-wave92-list-index.js'
import { OfficeObjectStore, type SharedOfficeObject } from '../src/office-objects.js'
import { createOfficeObjectsHttpHandler } from '../src/office-objects-http.js'

const actor = { memberId: 'alice', role: 'admin' }
function row(id: string, teamId = 'team', name = id): SharedOfficeObject {
  return { teamId, kind: 'department', sourceId: id, version: 1, deleted: false, shape: { kind: 'department', id, name }, parents: [],
    responsibilitiesText: 'Complete résumé\u0000🌏 ' + name, leads: [], backups: [], members: [], updatedAt: 1, updatedBy: 'alice' }
}
const compare = (a: SharedOfficeObject, b: SharedOfficeObject) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`)
async function parent() { return mkdtemp(join(tmpdir(), 'office-wave92-test-')) }
async function fixture(objects: SharedOfficeObject[]) {
  const directory = await parent(), file = join(directory, 'office-objects.json')
  await writeFile(file, JSON.stringify({ schema: 1, revision: 17, objects, history: [], receipts: [] }))
  const access = { team: 'team', present: true, role: 'admin' }
  const store = new OfficeObjectStore(directory, null, () => access.team,
    id => access.present && id === actor.memberId ? { memberId: id, displayName: 'Alice', role: access.role } : null)
  return { directory, file, access, store, async dispose() { await store.close(); await rm(directory, { recursive: true, force: true }) } }
}

test('bounded initial runs and disk merge preserve exact localeCompare ties, all pages and source payloads', async t => {
  const directory = await parent(), cache = new OfficeListDiskIndexWave92<SharedOfficeObject>(directory)
  const own = Array.from({ length: 5003 }, (_, i) => row(`id_${5002 - i}`))
  own.splice(5, 0, row('same', 'team', 'first tie'), row('A'), row('a'), row('_a'), row('-a'))
  own.push(row('same', 'team', 'last tie'))
  const source = own.flatMap(value => [row(value.sourceId, 'foreign'), value]), expected = own.slice().sort(compare)
  const original = Uint32Array.prototype.sort, lengths: number[] = []
  const spy = t.mock.method(Uint32Array.prototype, 'sort', function (this: Uint32Array, comparator?: (a: number, b: number) => number) {
    lengths.push(this.length); assert(this.length <= 2048); return original.call(this, comparator)
  })
  try {
    const all: SharedOfficeObject[] = []
    for (let offset = 0; offset < expected.length; offset += 173) {
      const page = await cache.page(source, 'team', 17, offset, 173, () => {})
      assert.equal(page.total, expected.length); assert(page.positions.length <= 173)
      all.push(...page.positions.map(position => source[position]!))
    }
    assert.deepEqual(all, expected); assert(lengths.length > 1)
    assert((cache as any).ready.source instanceof WeakRef, 'idle cache identity must not retain obsolete full payload arrays')
    assert.equal((cache as any).ready.source.deref(), source)
    const sortedRuns = lengths.length
    assert.deepEqual((await cache.page(source, 'team', 17, Number.MAX_SAFE_INTEGER, 200, () => {})).positions, [])
    assert.equal(lengths.length, sortedRuns, 'warm pages must not sort again')
    const directories = await readdir(directory); assert.equal(directories.length, 1)
    for (const file of await readdir(join(directory, directories[0]!))) {
      const bytes = await readFile(join(directory, directories[0]!, file))
      assert.equal(bytes.length, expected.length * 4); assert(!bytes.includes(Buffer.from('Complete résumé')))
    }
  } finally { spy.mock.restore(); await cache.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) }
})

test('short async reads/writes are completed and warm high-offset pages read only bounded source rows', async () => {
  const directory = await parent(); let reads = 0
  const source = new Proxy(Array.from({ length: 2109 }, (_, i) => row(`id_${2108-i}`)), { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++
    return Reflect.get(target, key, receiver)
  } })
  const cache = new OfficeListDiskIndexWave92<SharedOfficeObject>(directory, { mkdtemp, chmod, rm,
    open: async (...args: Parameters<typeof open>) => {
      const file = await open(...args)
      return new Proxy(file, { get(target, key) {
        if (key === 'read') return (buffer: Buffer, offset: number, length: number, position: number) => target.read(buffer, offset, Math.min(length, 31), position)
        if (key === 'write') return (buffer: Buffer, offset: number, length: number, position: number) => target.write(buffer, offset, Math.min(length, 29), position)
        const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
      } })
    },
  })
  try {
    await cache.page(source, 'team', 1, 0, 1, () => {})
    reads = 0; const page = await cache.page(source, 'team', 1, 2000, 20, () => {})
    assert.equal(page.positions.length, 20); assert.equal(reads, 0, 'utility reads positions only on a warm page')
    assert.deepEqual(page.positions.map(i => source[i]), source.slice().sort(compare).slice(2000, 2020))
  } finally { await cache.close(); await rm(directory, { recursive: true, force: true }) }
})

test('cancelled initial build cleans its files and does not cancel another queued reader', async () => {
  const directory = await parent(), cache = new OfficeListDiskIndexWave92<SharedOfficeObject>(directory), stop = new AbortController()
  const source = Array.from({ length: 5003 }, (_, i) => row(`id_${i}`))
  try {
    const first = cache.page(source, 'team', 1, 0, 100, () => stop.signal.throwIfAborted())
    const rejected = assert.rejects(first, /cancel indexing/)
    const second = cache.page(source, 'team', 1, 100, 100, () => {})
    setImmediate(() => stop.abort(Error('cancel indexing')))
    await rejected; assert.equal((await second).positions.length, 100)
    assert.equal((await readdir(directory)).length, 1)
  } finally { await cache.close(); assert.deepEqual(await readdir(directory), []); await rm(directory, { recursive: true, force: true }) }
})

test('failed close and removal keep cleanup ownership until a later close succeeds', async () => {
  for (const mode of ['close', 'remove'] as const) {
    const directory = await parent(); let blocked = mode === 'close', attempts = 0
    const cache = new OfficeListDiskIndexWave92<SharedOfficeObject>(directory, { mkdtemp, chmod,
      rm: async (...args: Parameters<typeof rm>) => { if (mode === 'remove' && blocked) { attempts++; throw Error('remove busy') }; return rm(...args) },
      open: async (...args: Parameters<typeof open>) => {
        const file = await open(...args)
        return new Proxy(file, { get(target, key) {
          if (key === 'close') return async () => { if (mode === 'close' && blocked) { attempts++; throw Error('close busy') }; await target.close() }
          const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value
        } })
      },
    })
    try {
      if (mode === 'close') await assert.rejects(cache.page([row('a')], 'team', 1, 0, 1, () => {}))
      else { await cache.page([row('a')], 'team', 1, 0, 1, () => {}); blocked = true }
      await assert.rejects(cache.close()); assert(attempts > 0)
      blocked = false; await cache.close(); assert.deepEqual(await readdir(directory), [])
    } finally { blocked = false; await cache.close(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('async store pages match sync payloads, isolate teams and rebuild on same-revision recovered state', async () => {
  const objects = [row('z'), row('same', 'foreign'), row('same', 'team', 'first'), row('same', 'team', 'second'), { ...row('deleted'), deleted: true }]
  const f = await fixture(objects)
  try {
    assert.deepEqual(await f.store.listAsync(actor, 'team'), f.store.list(actor, 'team'))
    const copy = await f.store.listAsync(actor, 'team'); copy.objects[0]!.shape.name = 'caller mutation'
    assert.deepEqual(await f.store.listAsync(actor, 'team'), f.store.list(actor, 'team'))
    f.access.team = 'foreign'; assert.deepEqual((await f.store.listAsync(actor, 'foreign')).objects.map(o => o.teamId), ['foreign'])
    f.access.team = 'team'; (f.store as any).state = { ...(f.store as any).state, objects: [row('recovered')] }
    assert.deepEqual((await f.store.listAsync(actor, 'team', 0, 100, 17)).objects.map(o => o.sourceId), ['recovered'])
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).objects, objects, 'indexing never rewrites authoritative state')
  } finally { await f.dispose() }
})

test('source revision, membership and team changes during async build fail without publishing a page', async () => {
  for (const mode of ['revision', 'state', 'membership', 'team'] as const) {
    const f = await fixture(Array.from({ length: 5003 }, (_, i) => row(`id_${i}`)))
    try {
      const pending = f.store.listAsync(actor, 'team', 0, 100, mode === 'revision' ? undefined : 17), rejected = assert.rejects(pending)
      setImmediate(() => {
        if (mode === 'revision') (f.store as any).state.revision++
        else if (mode === 'state') (f.store as any).state = { ...(f.store as any).state, objects: [row('new')] }
        else if (mode === 'membership') f.access.present = false
        else f.access.team = 'foreign'
      })
      await rejected
    } finally { await f.dispose() }
  }
})

test('HTTP uses async index, rejects changed device sessions and stops disconnected work', async () => {
  for (const mode of ['success', 'device', 'disconnect'] as const) {
    const f = await fixture(Array.from({ length: 2501 }, (_, i) => row(`id_${i}`)))
    let device = 'original', syncCalls = 0
    const replies: { status: number; body: any }[] = [], req = Object.assign(new EventEmitter(), { method: 'GET', aborted: false }), res = Object.assign(new EventEmitter(), { destroyed: false, setHeader() {} })
    ;(f.store as any).list = () => { syncCalls++; throw Error('HTTP must not invoke legacy index') }
    const handler = createOfficeObjectsHttpHandler({ store: f.store, authenticate: () => ({ member: actor, deviceId: device }),
      readBody: async () => { throw Error('GET has no body') }, releaseBody() {}, drain() {}, json: (_res, status, body) => { replies.push({ status, body }) } })
    try {
      const pending = handler(req as any, res as any, new URL('https://bridge.test/office-objects?teamId=team&offset=2000&limit=100&revision=17'))
      if (mode !== 'success') setImmediate(() => { if (mode === 'device') device = 'replacement'; else { req.aborted = true; req.emit('aborted') } })
      assert.equal(await pending, true); assert.equal(syncCalls, 0)
      if (mode === 'success') { assert.equal(replies[0]?.status, 200); assert.equal(replies[0]?.body.data.objects.length, 100); assert.equal(replies[0]?.body.data.total, 2501) }
      else if (mode === 'device') assert.equal(replies[0]?.status, 401)
      else assert.deepEqual(replies, [])
      assert.equal(req.listenerCount('aborted'), 0); assert.equal(res.listenerCount('close'), 0)
    } finally { await f.dispose() }
  }
})
