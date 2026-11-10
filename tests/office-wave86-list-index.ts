import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OfficeObjectError, OfficeObjectStore, type SharedOfficeObject } from '../src/office-objects.js'

const actor = { memberId: 'alice', role: 'admin' }
function object(id: string, marker = id): SharedOfficeObject {
  return { teamId: 'team', sourceId: id, kind: 'department', version: 1, deleted: false,
    shape: { kind: 'department', id, name: marker, parentId: null }, parents: [],
    responsibilitiesText: `private-${marker}`, leads: [], backups: [], members: [], updatedAt: 1, updatedBy: 'alice' }
}
function fixture(objects: SharedOfficeObject[], revision = 17) {
  const directory = mkdtempSync(join(tmpdir(), 'office-wave86-index-'))
  const file = join(directory, 'office-objects.json')
  writeFileSync(file, JSON.stringify({ schema: 1, revision, objects, history: [], receipts: [] }))
  const access = { present: true, role: 'admin', team: 'team' }
  const reopen = () => new OfficeObjectStore(directory, null, () => access.team,
    id => access.present && id === 'alice' ? { memberId: id, displayName: 'Alice', role: access.role } : null)
  return { directory, file, access, store: reopen(), reopen, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}
function expectStatus(status: number) {
  return (error: unknown) => error instanceof OfficeObjectError && error.status === status
}

test('every page matches original localeCompare/stable ordering, including ties and more than 200 objects', () => {
  const input = Array.from({ length: 417 }, (_, i) => object(`id_${416 - i}`))
  input.splice(11, 0, object('same', 'first tie'), object('A'), object('_a'), object('a'), object('-a'), object('same', 'second tie'))
  input.push({ ...object('floor'), kind: 'floor', shape: { kind: 'floor', id: 'floor', name: 'Floor', order: 1 } })
  const expected = input.slice().sort((a, b) => `${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`))
  const f = fixture(input)
  try {
    const all: SharedOfficeObject[] = []
    for (let offset = 0; offset < expected.length; offset += 83) {
      const page = f.store.list(actor, 'team', offset, 83, 17)
      assert.deepEqual(page.objects, expected.slice(offset, offset + 83))
      assert.equal(page.total, expected.length)
      assert.equal(page.hasMore, offset + 83 < expected.length)
      all.push(...page.objects)
    }
    assert.deepEqual(all, expected)
    assert.deepEqual(all.filter(row => row.sourceId === 'same').map(row => row.shape.name), ['first tie', 'second tie'])
    assert.deepEqual(f.store.list(actor, 'team', 1000, 200, 17).objects, [])
    assert.equal(f.store.list(actor, 'team', 1000, 200, 17).total, input.length)
    assert.equal(f.store.list(actor, 'team', 1000, 200, 17).hasMore, false)
    assert.deepEqual(JSON.parse(readFileSync(f.file, 'utf8')).objects, input, 'sorting must not change persisted insertion order')
  } finally { f.dispose() }
})

test('unchanged pages do no repeated comparison work and return isolated full object copies', t => {
  const f = fixture(Array.from({ length: 405 }, (_, i) => object(`id_${404 - i}`)))
  const original = String.prototype.localeCompare
  let comparisons = 0
  const spy = t.mock.method(String.prototype, 'localeCompare', function (this: string, ...args: Parameters<typeof original>) {
    comparisons++
    return original.apply(this, args)
  })
  try {
    const first = f.store.list(actor, 'team', 0, 200)
    assert.ok(comparisons > 0)
    const initial = comparisons
    const savedName = first.objects[0].shape.name
    first.objects[0].shape.name = 'client mutation'
    first.objects[0].members.push({ id: 'forged', kind: 'member', teamId: 'team', label: 'forged' })
    const again = f.store.list(actor, 'team', 0, 200)
    assert.equal(again.objects[0].shape.name, savedName)
    assert.deepEqual(again.objects[0].members, [])
    assert.equal(f.store.list(actor, 'team', 200, 200).objects.length, 200)
    assert.equal(f.store.list(actor, 'team', 400, 200).objects.length, 5)
    assert.equal(comparisons, initial, 'cached pages must not sort the full population again')
  } finally { spy.mock.restore(); f.dispose() }
})

test('cached ordering cannot bypass current membership, team, role or revision checks', () => {
  const f = fixture([object('a'), object('b')])
  try {
    assert.equal(f.store.list(actor, 'team').actor.canEdit, true)
    f.access.role = 'member'
    assert.equal(f.store.list(actor, 'team').actor.canEdit, false)
    assert.throws(() => f.store.list(actor, 'team', 0, 100, 16), expectStatus(409))
    assert.throws(() => f.store.list(actor, 'team', -1, 100), expectStatus(400))
    assert.throws(() => f.store.list(actor, 'team', 0, 201), expectStatus(400))
    f.access.present = false
    assert.throws(() => f.store.list(actor, 'team'), expectStatus(403))
    f.access.present = true
    f.access.team = 'another-team'
    assert.throws(() => f.store.list(actor, 'team'), expectStatus(403))
  } finally { f.dispose() }
})

test('committed creation, update, tombstone, replay and reopen expose current objects without stale index entries', () => {
  const f = fixture([object('z'), object('a')])
  try {
    f.store.list(actor, 'team')
    const command = { teamId: 'team', commandId: 'create', expectedVersion: 0, object: object('m') }
    f.store.command(command, actor)
    assert.throws(() => f.store.list(actor, 'team', 0, 100, 17), expectStatus(409))
    assert.deepEqual(f.store.list(actor, 'team').objects.map(row => row.sourceId), ['a', 'm', 'z'])
    f.store.command({ teamId: 'team', commandId: 'update', expectedVersion: 1, object: { ...object('a'), shape: { ...object('a').shape, name: 'Updated' } } }, actor)
    assert.equal(f.store.list(actor, 'team').objects[0].shape.name, 'Updated')
    f.store.command({ teamId: 'team', commandId: 'delete', expectedVersion: 1, object: { ...object('z'), deleted: true } }, actor)
    const page = f.store.list(actor, 'team')
    const deleted = page.objects.find(row => row.sourceId === 'z')!
    assert.equal(deleted.deleted, true)
    assert.equal(deleted.shape.name, 'Unavailable')
    assert.equal(deleted.responsibilitiesText, '')
    assert.equal(page.total, 3, 'tombstones remain in complete snapshots')
    f.store.command(command, actor)
    assert.deepEqual(f.store.list(actor, 'team'), page, 'receipt replay does not change current list state')
    assert.deepEqual(f.reopen().list(actor, 'team'), page)
  } finally { f.dispose() }
})

test('persist-error reload replaces a warmed index even when recovered revision is identical', t => {
  for (const replaceDisk of [false, true]) {
    const f = fixture([object('old')])
    try {
      f.store.list(actor, 'team')
      const spy = t.mock.method(f.store as any, 'persist', () => {
        if (replaceDisk) writeFileSync(f.file, JSON.stringify({ schema: 1, revision: 17, objects: [object('recovered')], history: [], receipts: [] }))
        throw new Error('persist failure')
      })
      assert.throws(() => f.store.command({ teamId: 'team', commandId: 'failed', expectedVersion: 0, object: object('new') }, actor), /persist failure/)
      spy.mock.restore()
      const page = f.store.list(actor, 'team', 0, 100, 17)
      assert.deepEqual(page.objects.map(row => row.sourceId), [replaceDisk ? 'recovered' : 'old'])
      assert.deepEqual(f.reopen().list(actor, 'team'), page)
    } finally { f.dispose() }
  }
})

test('restored same-revision stores and empty states do not inherit another store index', () => {
  const f = fixture([object('before')])
  try {
    f.store.list(actor, 'team')
    writeFileSync(f.file, JSON.stringify({ schema: 1, revision: 17, objects: [object('after')], history: [], receipts: [] }))
    assert.deepEqual(f.reopen().list(actor, 'team', 0, 100, 17).objects.map(row => row.sourceId), ['after'])
    writeFileSync(f.file, JSON.stringify({ schema: 1, revision: 17, objects: [], history: [], receipts: [] }))
    assert.deepEqual(f.reopen().list(actor, 'team'), { teamId: 'team', actor: { memberId: 'alice', canEdit: true }, revision: 17, objects: [], total: 0, hasMore: false })
  } finally { f.dispose() }
})
