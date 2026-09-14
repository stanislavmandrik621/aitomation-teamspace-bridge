import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContentAccessIndex } from '../src/content-access.js'
import { FieldAccessProjection } from '../src/field-access-projection.js'
import type { ModulesSyncOp } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'field-projection-'))
let serial = 0
const op = (kind: string, targetId: string, patch: Record<string, unknown> = {}, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `field-projection-${++serial}`, kind, targetId, targetKind: kind.split('.')[0], moduleId: 'm', entityId: 'e', patch,
  originRole: 'admin', originMemberId: 'admin', originDevice: 'admin', hlc: `${serial}:0:admin`, protocolVersion: 2, hopCount: 0, ...extra,
})
const grant = (fieldSlug: string, role = 'member', extra: Record<string, unknown> = {}) => ({ entityId: 'e', fieldSlug, role, read: false, write: false, hidden: true, ...extra })
try {
  const lineage = new ContentAccessIndex(dir, null)
  lineage.observe(op('module.create', 'm', {}, { entityId: undefined }))
  lineage.observe(op('entity.create', 'e'))
  for (const [id, slug] of [['secret-id', 'secret'], ['public-id', 'public']]) lineage.observe(op('field.create', id!, { slug }))
  lineage.observe(op('view.create', 'view'))
  lineage.observe(op('record.create', 'r'))
  const policy = new FieldAccessProjection({ version: 1, entities: [], fields: [grant('secret'), grant('secret', 'viewer')] })
  const metadata = { layout: 'table', icon: 'blue', label: 'hello', columns: ['public'] }
  for (const family of ['view', 'entity']) assert.equal(policy.project(op(`${family}.update`, family === 'view' ? 'view' : 'e', { config: metadata }), 'member', lineage)?.patch?.config, metadata, 'ordinary view/layout metadata remains intact')
  assert.equal(policy.project(op('view.update', 'view', { config: { columns: ['secret'] } }), 'member', lineage), null)
  assert.equal(policy.project(op('view.update', 'view', { config: { columnWidths: { secret: 120 } } }), 'member', lineage), null)
  assert.equal(policy.project(op('field.update', 'secret-id', { slug: 'secret' }), 'member', lineage), null)
  assert.equal(policy.project(op('field.update', 'public-id', { slug: 'public', config: { targetField: 'secret' } }), 'member', lineage), null)
  const body = op('record.update', 'r', { data: { secret: 'PRIVATE', public: 'VISIBLE' }, patch: { secret: 'ALTERNATE_PRIVATE' },
    ignoredEncodedPayload: 'PRIVATE_METADATA', cellHlcs: { secret: '1:0:a', public: '2:0:a' }, baseCellHlcs: { secret: '1:0:a', public: '1:0:b' }, removeKeys: ['secret', 'public'],
    yjsCheckpoint: { fieldSlug: 'secret', kind: 'text', stateB64: 'PRIVATE_ENCODED' }, yjsCheckpointSave: true, yjsCheckpointSaveId: 'secret-save',
    yjsCheckpoints: [{ fieldSlug: 'secret', kind: 'text', stateB64: 'PRIVATE_ENCODED' }, { fieldSlug: 'public', kind: 'text', stateB64: 'PUBLIC_ENCODED' }],
    yjsResets: [{ fieldSlug: 'secret', resetId: 'PRIVATE_RESET' }, { fieldSlug: 'public', resetId: 'public-reset' }],
  }, { removeKeys: ['secret', 'public'] })
  for (const role of ['member', 'viewer'] as const) {
    const projected = policy.project(body, role, lineage)!
    assert.deepEqual(projected.patch!.data, { public: 'VISIBLE' })
    assert.deepEqual(projected.patch!.cellHlcs, { public: '2:0:a' })
    assert.deepEqual(projected.patch!.baseCellHlcs, { public: '1:0:b' })
    assert.deepEqual(projected.patch!.removeKeys, ['public'])
    assert.deepEqual(projected.removeKeys, ['public'])
    assert.equal(JSON.stringify(projected).includes('PRIVATE'), false)
    assert.equal(JSON.stringify(projected).includes('secret'), false)
    assert.deepEqual(projected.patch!.yjsCheckpoints, [{ fieldSlug: 'public', kind: 'text', stateB64: 'PUBLIC_ENCODED' }])
  }
  assert.equal(policy.project(body, 'admin', lineage), body, 'Admin retains original content and checkpoints')
  assert.ok(policy.writeRefusal(body, 'member', lineage))
  assert.ok(policy.writeRefusal(op('field.update', 'secret-id', { slug: 'new_public_slug' }), 'member', lineage), 'renaming cannot borrow the permissions of a new public slug')
  assert.ok(policy.writeRefusal(op('record.update', 'r', { data: { public: 'ok' }, yjsCheckpoint: { fieldSlug: 'secret', kind: 'text', stateB64: 'hidden' } }), 'member', lineage))
  assert.equal(policy.writeRefusal(op('record.create', 'fresh', { data: { public: 'new record' } }), 'member', lineage), null)
  assert.equal(policy.writeRefusal(op('field.create', 'new-field', { slug: 'new_slug', name: 'New field', config: { color: 'blue' } }), 'member', lineage), null, 'new field definition need not preexist')
  assert.ok(policy.writeRefusal(op('record.update', 'r', { data: { public: 'blocked viewer write' } }), 'viewer', lineage))
  const readOnly = new FieldAccessProjection({ entities: [], fields: [grant('public', 'member', { hidden: false, read: true, write: false })] })
  assert.ok(readOnly.writeRefusal(op('field.update', 'public-id', { name: 'Cannot mutate read-only definition' }), 'member', lineage))
  assert.ok(readOnly.writeRefusal(op('comment.create', 'field-comment', { recordId: 'r', fieldSlug: 'public', body: 'Cannot mutate read-only field comments' }), 'member', lineage))
  assert.equal(readOnly.allows('e', 'member', 'public'), true)
  assert.equal(readOnly.allows('e', 'member', 'public', 'write'), false)
  const wildcard = new FieldAccessProjection({ version: 2, entities: [], fields: [grant('*'), grant('public', 'member', { read: true, write: true, hidden: false })] })
  assert.equal(wildcard.allows('e', 'member', 'public'), true, 'exact override retains documented wildcard semantics')
  assert.equal(wildcard.allows('e', 'member', 'unknown'), false)
  assert.ok(wildcard.project(op('view.update', 'view', { config: metadata }), 'member', lineage), 'wildcard cannot mistake ordinary blue/table strings for field selectors')
  const duplicate = new FieldAccessProjection({ entities: [], fields: [grant('secret'), grant('secret', 'member', { hidden: false, read: true, write: true })] })
  assert.equal(duplicate.allows('e', 'member', 'secret'), false, 'duplicate allow cannot erase denial')
  const table = new FieldAccessProjection({ entities: [{ entityId: 'e', role: 'member', read: false, create: false, update: false, delete: false }], fields: [] })
  assert.equal(table.project(body, 'member', lineage), null)
  assert.equal(new FieldAccessProjection({ bad: true }).project(body, 'admin', lineage), null, 'malformed authority fails closed even for Admin')
  const empty = new FieldAccessProjection(null)
  const kindField = op('field.create', 'kind-id', { slug: 'kind', name: 'Program kind' })
  lineage.observe(kindField)
  const kindRecord = op('record.update', 'r', { data: { kind: 'Grant funded', public: 'Visible' }, cellHlcs: { kind: '1000:1:admin' } })
  for (const role of ['member', 'viewer'] as const) {
    assert.ok(empty.project(kindField, role, lineage), 'business kind schema reaches each replica')
    assert.deepEqual(empty.project(kindRecord, role, lineage)?.patch?.data, { kind: 'Grant funded', public: 'Visible' })
    assert.deepEqual(empty.project(kindRecord, role, lineage)?.patch?.cellHlcs, { kind: '1000:1:admin' })
    const hiddenKind = new FieldAccessProjection({ entities: [], fields: [grant('kind', role)] })
    assert.equal(hiddenKind.project(kindField, role, lineage), null)
    assert.deepEqual(hiddenKind.project(kindRecord, role, lineage)?.patch?.data, { public: 'Visible' })
    assert.ok(hiddenKind.writeRefusal(kindRecord, role, lineage))
  }
  assert.equal(empty.writeRefusal(kindRecord, 'member', lineage), null)

  assert.equal(empty.writeRefusal(op('record.create', 'new-entity-row', { data: { fresh: 'yes' } }, { entityId: 'just-created-entity' }), 'member', lineage), null, 'same-frame new entity keeps defaults')
  assert.ok(empty.project(op('record.create', 'legacy', { data: { description: 'legacy' } }, { entityId: undefined }), 'member', lineage), 'default ACL supports legacy root-only records')
  assert.equal(policy.project(op('record.create', 'legacy', { data: { secret: 'unknown table' } }, { entityId: undefined }), 'member', lineage), null, 'unknown lineage cannot bypass nonempty grants')
  lineage.observe(op('field.create', 'renamed-field', { slug: 'first_name' }))
  const historicalRename = op('record.create', 'rename-row', { data: { first_name: 'PUBLIC_RENAME' } })
  lineage.observe(historicalRename)
  lineage.observe(op('field.update', 'renamed-field', { slug: 'second_name' }))
  lineage.observe(op('field.update', 'renamed-field', { slug: 'third_name' }))
  assert.deepEqual(empty.project(historicalRename, 'member', lineage)?.patch?.data, { first_name: 'PUBLIC_RENAME' }, 'multiple public renames preserve source cells for historical rename replay')
  const hiddenRename = new FieldAccessProjection({ entities: [], fields: [grant('third_name')] })
  assert.deepEqual(hiddenRename.project(historicalRename, 'member', lineage)?.patch?.data, {}, 'hiding current field also hides all historical aliases')
  lineage.flush()
  const reopened = new ContentAccessIndex(dir, null)
  assert.equal(reopened.resolveFieldSlug('e', 'kind-id'), 'kind', 'business kind identity survives restart')
  assert.equal(reopened.resolveFieldSlug('e', 'first_name'), 'third_name', 'multi-step identity proof survives restart')

  const secretSha = 'a'.repeat(64), sharedSha = 'b'.repeat(64)
  lineage.observe(op('record.update', 'r', { data: { secret: [{ __teamspaceBlob: secretSha }, { __teamspaceBlob: sharedSha }], public: { __teamspaceBlob: sharedSha } } }))
  lineage.setFieldAccessCheck((entity, slug, role, action) => policy.allows(entity, role, slug, action))
  assert.equal(lineage.mayReadBlob(secretSha, 'member', 'member'), false)
  const unboundSha = 'c'.repeat(64)
  lineage.observe(op('comment.create', 'comment', { recordId: 'r', body: { __teamspaceBlob: unboundSha } }))
  const missingSchema = new FieldAccessProjection({ entities: [], fields: [grant('not-yet-synced-secret')] })
  lineage.setFieldAccessCheck((entity, slug, role, action) => missingSchema.allows(entity, role, slug, action),
    (entity, role) => missingSchema.hasPrivateFields(entity, role, lineage))
  assert.equal(missingSchema.project(op('comment.create', 'comment', { recordId: 'r', body: { __teamspaceBlob: unboundSha } }), 'member', lineage), null)
  assert.equal(lineage.mayReadBlob(unboundSha, 'member', 'member'), false, 'missing schema does not let a hidden unbound comment attachment through')
  lineage.setFieldAccessCheck((entity, slug, role, action) => empty.allows(entity, role, slug, action),
    (entity, role) => empty.hasPrivateFields(entity, role, lineage))
  assert.equal(lineage.mayReadBlob(unboundSha, 'member', 'member'), true, 'whole-policy proof retains healthy unrestricted comment attachments')
  lineage.setFieldAccessCheck((entity, slug, role, action) => policy.allows(entity, role, slug, action),
    (entity, role) => policy.hasPrivateFields(entity, role, lineage))
  assert.equal(lineage.mayReadBlob(secretSha, 'admin', 'admin'), true)
  assert.equal(lineage.mayReadBlob(sharedSha, 'member', 'member'), true, 'independent public reference preserves download')
  lineage.observe(op('record.update', 'r', { data: { public: null } }))
  assert.equal(lineage.mayReadBlob(sharedSha, 'member', 'member'), false, 'remaining hidden reference is not a download grant')
  assert.equal(lineage.mayAccessRecordField('r', 'secret', 'member', 'member'), false)
  assert.equal(lineage.mayAccessRecordField('r', 'secret-id', 'member', 'member'), false, 'field ID cannot alias a hidden slug')
  assert.equal(lineage.mayAccessRecordField('r', 'public', 'member', 'member', 'write'), true)
  assert.equal(lineage.mayAccessRecordField('r', 'public', 'viewer', 'viewer', 'write'), false)
  lineage.setFieldAccessCheck((entity, slug, role, action) => table.allows(entity, role, slug, action))
  assert.equal(lineage.mayReadRecord('r', 'member', 'member'), false)
  assert.equal(lineage.mayReadBlob(secretSha, 'member', 'member'), false)
  console.log('field access projection: values/metadata/checkpoints, role/wildcard/table gates, normal configs/new creates, blob lineage and Yjs field bindings passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
