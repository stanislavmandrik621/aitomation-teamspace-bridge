import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContentAccessIndex } from '../src/content-access.js'
import { ContentAccessStorage } from '../src/content-access-storage.js'
import type { ModulesSyncOp } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'cascade-authority-'))
let count = 0
const op = (kind: string, targetId: string, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `cascade-audit-${++count}`, kind, targetId, targetKind: kind.split('.')[0],
  originRole: 'admin', originMemberId: 'admin', originDevice: 'host', hlc: `${count}:0:host`, ...extra,
})
try {
  let access = new ContentAccessIndex(dir, null)
  access.observe(op('module.create', 'shared', { visibleToMemberIds: ['alice'] }))
  access.observe(op('module.create', 'private', { visibleToMemberIds: ['bob'] }))
  for (const [entity, moduleId] of [['table', 'shared'], ['other-table', 'shared'], ['secret-table', 'private']]) {
    // This is the actual desktop producer shape: entityId names itself.
    access.observe(op('entity.create', entity!, { entityId: entity, moduleId }))
  }
  for (const [record, entityId, moduleId] of [['row', 'table', 'shared'], ['sibling', 'table', 'shared'], ['other-row', 'other-table', 'shared'], ['secret-row', 'secret-table', 'private']]) {
    access.observe(op('record.create', record!, { entityId, moduleId }))
  }
  const reorder = op('cascade.patch', 'row', { targetKind: 'record', entityId: 'table', moduleId: 'shared',
    patch: { reorderKind: 'record', entityId: 'table', order: [{ id: 'row', sort_order: 1 }, { id: 'sibling', sort_order: 0 }] } })
  assert.equal(access.authorize(reorder, 'alice', 'member'), null, 'legitimate first reorder resolves its real target family')
  access.observe(op('field.create', 'field-a', { moduleId: 'shared', entityId: 'table', patch: { slug: 'alpha' } }))
  access.observe(op('field.create', 'field-b', { moduleId: 'shared', entityId: 'table', patch: { slug: 'beta' } }))
  const rename = op('cascade.patch', 'field-a', { targetKind: 'field', moduleId: 'shared', entityId: 'table', patch: { action: 'rename_field_slug', entityId: 'table', oldSlug: 'alpha', newSlug: 'renamed' } })
  assert.ok(access.authorize({ ...rename, patch: { ...rename.patch, oldSlug: 'beta' } }, 'alice', 'member'), 'field target cannot borrow another column oldSlug')
  const fieldUpdate = op('field.update', 'field-a', { moduleId: 'shared', entityId: 'table', patch: { slug: 'renamed', oldSlug: 'alpha' } })
  assert.equal(access.authorize(rename, 'alice', 'member', [fieldUpdate]), null, 'same-frame update establishes exact rename transition')
  access.observe(fieldUpdate)
  assert.equal(access.authorize(rename, 'alice', 'member'), null)
  assert.equal(access.projectForRead(rename, 'alice', 'member'), rename, 'current exact rename has an unchanged fast path')
  access.observe(op('field.create', 'reused-slug', { moduleId: 'shared', entityId: 'table', patch: { slug: 'alpha' } }))
  assert.ok(access.authorize(rename, 'alice', 'member'), 'delayed old transition cannot mutate a newly reused column slug')
  assert.equal(access.projectForRead(rename, 'alice', 'member'), null, 'obsolete cascade cannot rename a reused slug; field.update supplies historical rename')
  assert.equal(access.mayReadRecord('row', 'alice', 'member'), true, 'entity self identity is not a cyclic ownership parent')
  const mixed = { ...reorder, patch: { ...reorder.patch, order: [{ id: 'row' }, { id: 'secret-row' }] } }
  assert.ok(access.authorize(mixed, 'alice', 'member'), 'all reordered IDs must belong to the admitted root')
  assert.equal(access.mayRead(mixed, 'alice', 'member'), false, 'historical malformed composite rows cannot leak hidden IDs')
  assert.ok(access.authorize({ ...reorder, patch: { ...reorder.patch, order: ['row', 'other-row'] } }, 'alice', 'member'), 'same-module reorder cannot cross table ownership')
  assert.ok(access.authorize({ ...reorder, patch: { ...reorder.patch, moduleIds: ['private'] } }, 'alice', 'member'), 'moduleIds cannot override the validated record action')
  assert.ok(access.authorize({ ...reorder, targetKind: 'field' }, 'alice', 'member'), 'semantic family must agree with wire target kind')
  assert.ok(access.authorize({ ...reorder, patch: { ...reorder.patch, order: ['sibling'] } }, 'alice', 'member'), 'primary authority must actually occur in the batch')
  assert.ok(access.authorize({ ...reorder, patch: { ...reorder.patch, order: [{ id: 'row', parent_id: 'secret-row' }] } }, 'alice', 'member'), 'tree parent is also an authority reference')
  assert.ok(access.authorize(reorder, 'alice', 'member', [op('record.delete', 'sibling', { moduleId: 'shared', entityId: 'table' })]), 'earlier deletion of a secondary batch row is already binding authority')
  const pending = [op('entity.create', 'new-table', { entityId: 'new-table', moduleId: 'private' })]
  assert.ok(access.authorize(op('record.create', 'new-row', { moduleId: 'shared', entityId: 'new-table' }), 'admin', 'admin', pending), 'same-frame parent ownership must not accept a conflicting root')
  const pendingRow = op('record.create', 'new-row', { moduleId: 'shared', entityId: 'table' })
  assert.equal(access.authorize(op('record.update', 'new-row', { moduleId: 'shared', entityId: 'table' }), 'alice', 'member', [pendingRow]), null, 'valid same-frame create then update works')
  assert.ok(access.authorize(op('record.create', 'new-row', { moduleId: 'shared', entityId: 'other-table' }), 'admin', 'admin', [pendingRow]), 'same-frame ID collision cannot reparent a created row')
  const moduleReorder = op('cascade.patch', 'shared', { targetKind: 'module', moduleId: 'shared', patch: { reorderKind: 'module', moduleIds: ['shared'], order: [{ id: 'shared' }] } })
  assert.equal(access.authorize(moduleReorder, 'alice', 'member'), null)
  assert.ok(access.authorize({ ...moduleReorder, patch: { ...moduleReorder.patch, moduleIds: ['shared', 'private'], order: ['shared', 'private'] } }, 'admin', 'admin'), 'multi-module writes need separate author-time epochs')
  access.observe(reorder)
  access.flush()
  access = new ContentAccessIndex(dir, null)
  assert.equal(access.mayReadRecord('row', 'alice', 'member'), true)
  assert.equal(access.authorize(reorder, 'alice', 'member'), null)
  access.observe(op('entity.delete', 'table', { entityId: 'table', moduleId: 'shared' }))
  assert.equal(access.mayReadRecord('row', 'alice', 'member'), false)
  assert.ok(access.authorize(reorder, 'alice', 'member'))

  const projectionDir = join(dir, 'projection')
  let projection = new ContentAccessIndex(projectionDir, null)
  projection.observe(op('module.create', 'm', { visibleToMemberIds: ['alice'] }))
  projection.observe(op('module.create', 'secret', { visibleToMemberIds: ['bob'] }))
  for (const entity of ['e', 'e2']) projection.observe(op('entity.create', entity, { moduleId: 'm', entityId: entity }))
  projection.observe(op('entity.create', 'hidden-e', { moduleId: 'secret', entityId: 'hidden-e' }))
  for (const row of ['a', 'b', 'c']) projection.observe(op('record.create', row, { moduleId: 'm', entityId: 'e' }))
  projection.observe(op('record.create', 'hidden', { moduleId: 'secret', entityId: 'hidden-e' }))
  const ordered = op('cascade.patch', 'a', { targetKind: 'record', moduleId: 'm', entityId: 'e',
    patch: { id: 'a', reorderKind: 'record', entityId: 'e', order: [
      { id: 'a', sort_order: 10, prev_sort_order: 0 },
      { id: 'b', sort_order: 11, prev_sort_order: 1 },
      { id: 'c', sort_order: 12, prev_sort_order: 2 },
    ] } })
  const positions = { ...ordered, patch: { ...ordered.patch, order: ['a', 'b', 'c'] } }
  assert.equal(projection.authorize(ordered, 'alice', 'member'), null)
  assert.equal(projection.projectForRead(ordered, 'alice', 'member'), ordered)
  projection.observe(ordered)
  const deleteB = op('record.delete', 'b', { moduleId: 'm', entityId: 'e' })
  assert.equal(projection.authorize(deleteB, 'alice', 'member', [ordered]), null, 'later deletion is legitimate in the same WAL frame')
  projection.observe(deleteB)
  const surviving = projection.projectForRead(ordered, 'alice', 'member')!
  assert.deepEqual(surviving.patch!.order, [ordered.patch!.order[0], ordered.patch!.order[2]], 'later secondary delete preserves independent deltas and CAS baselines')
  assert.equal(projection.mayRead(ordered, 'alice', 'member'), true)
  assert.deepEqual(projection.projectForRead(positions, 'alice', 'member')!.patch!.order, [
    { id: 'a', sort_order: 0 }, { id: 'c', sort_order: 2 },
  ], 'filtering does not renumber bare-ID sort positions')
  const parentLost = { ...ordered, patch: { ...ordered.patch, order: [
    { id: 'a', sort_order: 10, parent_id: 'b', prev_parent_id: null, prev_sort_order: 0 },
    { id: 'c', sort_order: 12, prev_sort_order: 2 },
  ] } }
  assert.deepEqual(projection.projectForRead(parentLost, 'alice', 'member')!.patch!.order, [parentLost.patch.order[1]], 'inaccessible parent rows are not rewritten with invented parents or bypassed CAS')
  const baselineLost = { ...parentLost, patch: { ...parentLost.patch, order: [
    { id: 'a', sort_order: 10, parent_id: null, prev_parent_id: 'b', prev_sort_order: 0 }, parentLost.patch.order[1],
  ] } }
  assert.equal(JSON.stringify(projection.projectForRead(baselineLost, 'alice', 'member')).includes('"b"'), false, 'no deleted parent identity remains in projected target, body, or CAS')
  assert.equal(projection.projectForRead({ ...ordered, patch: { ...ordered.patch, order: ['a', 'hidden'] } }, 'alice', 'member'), null, 'projection cannot launder an originally cross-root reorder')
  projection.observe(op('record.create', 'other-table-row', { moduleId: 'm', entityId: 'e2' }))
  assert.equal(projection.projectForRead({ ...ordered, entityId: undefined, patch: { reorderKind: 'record', order: ['a', 'other-table-row'] } }, 'alice', 'member'), null, 'missing parent claim cannot hide actual cross-entity ownership')
  projection.observe(op('record.delete', 'a', { moduleId: 'm', entityId: 'e' }))
  const reanchored = projection.projectForRead(ordered, 'alice', 'member')!
  assert.equal(reanchored.targetId, 'c')
  assert.equal(reanchored.patch!.id, 'c')
  assert.deepEqual(reanchored.patch!.order, [ordered.patch!.order[2]], 'deleted primary does not hide surviving secondary')
  assert.equal(ordered.targetId, 'a', 'stored original is never mutated')
  assert.equal((ordered.patch!.order as unknown[]).length, 3)
  const tables = op('cascade.patch', 'e', { targetKind: 'entity', moduleId: 'm', entityId: 'e',
    patch: { reorderKind: 'entity', moduleId: 'm', order: ['e', 'e2'] } })
  projection.observe(op('entity.delete', 'e', { moduleId: 'm', entityId: 'e' }))
  assert.equal(projection.projectForRead(ordered, 'alice', 'member'), null, 'deleted ancestor removes every child')
  const survivingTable = projection.projectForRead(tables, 'alice', 'member')!
  assert.equal(survivingTable.targetId, 'e2')
  assert.equal(survivingTable.entityId, 'e2', 'actual table producer self-entity selector follows new primary')
  assert.deepEqual(survivingTable.patch!.order, [{ id: 'e2', sort_order: 1 }])
  projection.flush()
  projection = new ContentAccessIndex(projectionDir, null)
  assert.deepEqual(projection.projectForRead(tables, 'alice', 'member'), survivingTable, 'safe projection survives checkpoint restart')
  assert.equal(projection.projectForRead(tables, 'bob', 'member'), null, 'projection does not relax root grants')

  const realSha = 'c'.repeat(64), phantomSha = 'd'.repeat(64)
  projection.observe(op('record.create', 'live', { moduleId: 'm', entityId: 'e2', patch: { data: { attachment: { __teamspaceBlob: realSha } } } }))
  projection.flush()
  const legacyStorage = new ContentAccessStorage(projectionDir, null, true)
  legacyStorage.write([
    { kind: 'targets', key: 'cascade:legacy', value: 'module:m' },
    { kind: 'parents', key: 'cascade:legacy', value: 'entity:e2' },
    { kind: 'references', key: 'cascade:legacy', value: { metadata: [realSha, phantomSha] } },
    { kind: 'blobs', key: realSha, value: ['record:live', 'cascade:legacy'] },
    { kind: 'blobs', key: phantomSha, value: ['cascade:legacy'] },
  ])
  projection = new ContentAccessIndex(projectionDir, null)
  assert.equal(projection.healthy(), true)
  assert.equal(projection.mayReadBlob(phantomSha, 'alice', 'member'), false, 'legacy command metadata is not an attachment grant')
  assert.equal(projection.mayReadBlob(realSha, 'alice', 'member'), true, 'retiring phantom metadata retains ordinary current cells')
  projection.flush()
  const migratedRows = [...new ContentAccessStorage(projectionDir, null, true).load()]
  assert.equal(migratedRows.some(entry => entry.key.startsWith('cascade:')), false, 'legacy command relationships are durably retired')
  assert.equal(migratedRows.some(entry => entry.kind === 'blobs' && JSON.stringify(entry.value).includes('cascade:')), false)
  assert.equal(new ContentAccessIndex(projectionDir, null).mayReadBlob(realSha, 'alice', 'member'), true)
  console.log('cascade authority: semantic IDs, every-target/parent isolation, same-frame bindings and restart passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
