import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OfficeObjectError, OfficeObjectStore, type SharedOfficeObject } from '../src/office-objects.js'

const actor = { memberId: 'alice', role: 'admin' }
function object(id: string, teamId = 'team', marker = `${teamId}-${id}`): SharedOfficeObject {
  return { teamId, sourceId: id, kind: 'department', version: 1, deleted: false,
    shape: { kind: 'department', id, name: marker, parentId: null }, parents: [],
    responsibilitiesText: `private-${marker}`, leads: [], backups: [], members: [], updatedAt: 1, updatedBy: `${teamId}-creator` }
}
function fixture(objects: SharedOfficeObject[], history = objects, receipts: {memberId:string;commandId:string;digest:string;object:SharedOfficeObject}[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'office-wave87-team-index-'))
  const file = join(directory, 'office-objects.json')
  writeFileSync(file, JSON.stringify({ schema: 1, revision: 17, objects, history, receipts }))
  const access = { present: true, role: 'admin', team: 'team' }
  const reopen = () => new OfficeObjectStore(directory, null, () => access.team,
    id => access.present && id === 'alice' ? { memberId: id, displayName: 'Alice', role: access.role } : null)
  return { file, access, store: reopen(), reopen, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}
const status = (code: number) => (error: unknown) => error instanceof OfficeObjectError && error.status === code

test('mixed-team pages count and order only authorized rows, including ties and tombstones', () => {
  const own = Array.from({ length: 417 }, (_, i) => object(`id_${416 - i}`))
  own.splice(11, 0, object('same', 'team', 'first tie'), object('A'), object('_a'), object('a'), object('-a'), object('same', 'team', 'second tie'))
  own.push({ ...object('deleted'), deleted: true })
  const rows = own.flatMap(row => [object(row.sourceId, 'foreign'), row])
  const expected = own.slice().sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`))
  const f = fixture(rows)
  try {
    const all: SharedOfficeObject[] = []
    for (let offset = 0; offset < own.length; offset += 83) {
      const page = f.store.list(actor, 'team', offset, 83, 17)
      assert.equal(page.total, own.length)
      assert.equal(page.hasMore, offset + 83 < own.length)
      assert.deepEqual(page.objects.map(row => row.sourceId), expected.slice(offset, offset + 83).map(row => row.sourceId))
      assert.ok(page.objects.every(row => row.teamId === 'team'))
      all.push(...page.objects)
    }
    assert.deepEqual(all.filter(row => row.sourceId === 'same').map(row => row.shape.name), ['first tie', 'second tie'])
    const deleted = all.find(row => row.deleted)!
    assert.equal(deleted.shape.name, 'Unavailable')
    assert.equal(deleted.responsibilitiesText, '')
    assert.equal(f.store.list(actor, 'team', Number.MAX_SAFE_INTEGER, 200).hasMore, false)
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).objects, rows, 'indexing does not reorder or rewrite persisted state')
  } finally { f.dispose() }
})

test('a warmed index cannot cross a live team binding or bypass live membership and role', () => {
  const f = fixture([object('private'), object('other', 'other-team')])
  try {
    assert.deepEqual(f.store.list(actor, 'team').objects.map(row => row.sourceId), ['private'])
    f.access.team = 'other-team'
    assert.throws(() => f.store.list(actor, 'team'), status(403))
    assert.deepEqual(f.store.list(actor, 'other-team', 0, 100, 17).objects.map(row => row.sourceId), ['other'])
    f.access.team = 'empty-team'
    assert.equal(f.store.list(actor, 'empty-team').total, 0)
    f.access.team = 'team'
    assert.deepEqual(f.store.list(actor, 'team').objects.map(row => row.sourceId), ['private'])
    f.access.role = 'member'
    assert.equal(f.store.list(actor, 'team').actor.canEdit, false)
    f.access.present = false
    assert.throws(() => f.store.list(actor, 'team'), status(403))
    f.access.present = true
    assert.throws(() => f.store.list(actor, 'team', 0, 100, 16), status(409))
  } finally { f.dispose() }
})

test('history, backup ownership and receipts ignore colliding foreign object identities', () => {
  const foreign = object('same', 'foreign'), own = object('same')
  const f = fixture([foreign, own, object('foreign-only', 'foreign')], [foreign, own], [
    { memberId: 'alice', commandId: 'foreign-receipt', digest: 'foreign-digest', object: foreign },
    { memberId: 'alice', commandId: 'same-receipt', digest: 'foreign-digest', object: foreign },
    { memberId: 'alice', commandId: 'same-receipt', digest: 'own-digest', object: own },
  ])
  try {
    assert.deepEqual(f.store.history(actor, 'team', 'department', 'same').entries, [own])
    assert.throws(() => f.store.history(actor, 'team', 'department', 'foreign-only'), status(404))
    assert.deepEqual(f.store.backupObject(actor, 'department', 'same'), own)
    assert.equal(f.store.backupObject(actor, 'department', 'foreign-only'), null)
    assert.equal(f.store.backupCreator('department', 'same'), own.updatedBy)
    assert.equal(f.store.receipt(actor, 'team', 'foreign-receipt'), null)
    assert.deepEqual(f.store.receipt(actor, 'team', 'same-receipt'), own)
    const copy = f.store.receipt(actor, 'team', 'same-receipt')!
    copy.shape.name = 'client mutation'
    assert.equal(f.store.receipt(actor, 'team', 'same-receipt')!.shape.name, own.shape.name)
  } finally { f.dispose() }
})

test('foreign object and command ID collisions cannot block creation, overwrite rows or affect replay', () => {
  const foreign = object('same', 'foreign')
  const f = fixture([foreign], [foreign], [{ memberId: 'alice', commandId: 'shared-command', digest: 'foreign-digest', object: foreign }])
  try {
    f.store.list(actor, 'team')
    const command = { teamId: 'team', commandId: 'shared-command', expectedVersion: 0, object: object('same') }
    const created = f.store.command(command, actor)
    assert.equal(created.version, 1)
    assert.equal(created.teamId, 'team')
    assert.throws(() => f.store.list(actor, 'team', 0, 100, 17), status(409))
    assert.deepEqual(f.store.command(command, actor), created)
    assert.equal(f.store.backupRevision(), 18)
    assert.throws(() => f.store.command({ ...command, commandId: 'stale' }, actor), status(409))
    const updated = f.store.command({ ...command, commandId: 'update', expectedVersion: 1, object: { ...command.object, responsibilitiesText: 'updated' } }, actor)
    assert.equal(updated.version, 2)
    const disk = JSON.parse(readFileSync(f.file, 'utf8'))
    assert.deepEqual(disk.objects.filter((row: SharedOfficeObject) => row.teamId === 'foreign'), [foreign])
    assert.equal(disk.receipts.filter((row: {object: SharedOfficeObject}) => row.object.teamId === 'foreign').length, 1)
    assert.deepEqual(f.reopen().list(actor, 'team').objects, [updated])
  } finally { f.dispose() }
})

test('dependency checks exclude foreign rows but include another kind with the same source ID', () => {
  const parent = object('parent')
  const child: SharedOfficeObject = { ...object('parent'), kind: 'room',
    shape: { kind: 'room', id: 'parent', name: 'Room', floorId: 'floor', departmentId: 'parent', x: 0, y: 0, w: 300, h: 200, type: 'office' },
    parents: [parent.shape, { kind: 'floor', id: 'floor', name: 'Floor', order: 0 }] }
  const f = fixture([parent, child])
  try {
    assert.throws(() => f.store.command({ teamId: 'team', commandId: 'delete', expectedVersion: 1, object: { ...parent, deleted: true } }, actor), status(409))
  } finally { f.dispose() }
  const foreignChild = { ...child, teamId: 'foreign', sourceId: 'foreign-room', shape: { ...child.shape, id: 'foreign-room' } }
  const g = fixture([parent, foreignChild])
  try {
    assert.equal(g.store.command({ teamId: 'team', commandId: 'delete', expectedVersion: 1, object: { ...parent, deleted: true } }, actor).deleted, true)
    assert.deepEqual(JSON.parse(readFileSync(g.file, 'utf8')).objects.find((row: SharedOfficeObject) => row.teamId === 'foreign'), foreignChild)
  } finally { g.dispose() }
})

test('same-revision persist recovery replaces the index and retains team isolation', t => {
  const f = fixture([object('old'), object('foreign-old', 'foreign')])
  try {
    f.store.list(actor, 'team')
    const spy = t.mock.method(f.store as any, 'persist', () => {
      writeFileSync(f.file, JSON.stringify({ schema: 1, revision: 17, objects: [object('foreign-new', 'foreign'), object('new')], history: [], receipts: [] }))
      throw new Error('persist failure')
    })
    assert.throws(() => f.store.command({ teamId: 'team', commandId: 'failed', expectedVersion: 0, object: object('attempted') }, actor), /persist failure/)
    spy.mock.restore()
    assert.deepEqual(f.store.list(actor, 'team', 0, 100, 17).objects.map(row => row.sourceId), ['new'])
    assert.deepEqual(f.reopen().list(actor, 'team'), f.store.list(actor, 'team'))
  } finally { f.dispose() }
})

test('cached high-offset pages access only their rows and retain a four-byte position index', t => {
  const f = fixture(Array.from({ length: 2049 }, (_, i) => object(`id_${2048 - i}`)))
  try {
    // Observe actual source reads rather than elapsed time or GC-dependent heap estimates.
    const state = (f.store as any).state as { objects: SharedOfficeObject[] }
    let reads = 0
    state.objects = new Proxy(state.objects, { get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) reads++
      return Reflect.get(target, property, receiver)
    } })
    const original = String.prototype.localeCompare
    let comparisons = 0
    const spy = t.mock.method(String.prototype, 'localeCompare', function (this: string, ...args: Parameters<typeof original>) {
      comparisons++
      return original.apply(this, args)
    })
    f.store.list(actor, 'team', 0, 1)
    const initial = comparisons
    const index = (f.store as any).listIndexes.get(state.objects)
    assert.ok(index.positions instanceof Uint32Array)
    assert.equal(index.positions.byteLength, state.objects.length * 4)
    reads = 0
    const page = f.store.list(actor, 'team', 2020, 20)
    assert.equal(page.objects.length, 20)
    assert.equal(reads, 20, 'cached page work must not scan to its offset or filter the population again')
    assert.equal(comparisons, initial, 'cached page does not resort')
    const name = page.objects[0].shape.name
    page.objects[0].shape.name = 'client mutation'
    assert.equal(f.store.list(actor, 'team', 2020, 1).objects[0].shape.name, name)
    spy.mock.restore()
  } finally { f.dispose() }
})
