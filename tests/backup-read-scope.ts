import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContentAccessIndex } from '../src/content-access.js'
import { FieldAccessProjection } from '../src/field-access-projection.js'
import { backupReadScope, parseBackupReadTargets } from '../src/backup-read-scope.js'
import type { ModulesSyncOp, BridgeRole } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'backup-read-scope-'))
let serial = 0
function op(kind: string, targetId: string, patch: Record<string, unknown> = {}, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp {
  return { opId: `backup-scope-${++serial}`, kind, targetId, targetKind: kind.split('.')[0], patch,
    originRole: 'admin', originMemberId: 'admin', originDevice: 'admin', hlc: `${serial}:0:admin`, protocolVersion: 2, hopCount: 0, ...extra }
}
try {
  const authority = new ContentAccessIndex(dir, null)
  const hide = { entityId: 'table', fieldSlug: 'secret', role: 'member', read: false, write: false, hidden: true }
  let policy = new FieldAccessProjection({ entities: [], fields: [hide] })
  authority.setFieldAccessCheck((entity, field, role, action) => policy.allows(entity, role, field, action),
    (entity, role) => policy.hasPrivateFields(entity, role, authority))
  authority.observe(op('module.create', 'shared'))
  authority.observe(op('module.create', 'private', { visibleToMemberIds: ['admin'] }))
  authority.observe(op('entity.create', 'table', {}, { moduleId: 'shared' }))
  authority.observe(op('entity.create', 'hidden-table', {}, { moduleId: 'private' }))
  authority.observe(op('record.create', 'record', {}, { moduleId: 'shared', entityId: 'table' }))
  authority.observe(op('record.create', 'hidden-record', {}, { moduleId: 'private', entityId: 'hidden-table' }))
  authority.observe(op('field.create', 'public-id', { slug: 'public', field_type: 'text' }, { moduleId: 'shared', entityId: 'table' }))
  authority.observe(op('field.create', 'secret-id', { slug: 'secret', field_type: 'text' }, { moduleId: 'shared', entityId: 'table' }))
  authority.observe(op('compose.create', 'doc'))
  authority.setComposeAccessCheck((id, member) => id === 'doc' && member !== 'removed')
  const targets = parseBackupReadTargets({ version: 1, targets: [
    { kind: 'module', id: 'shared' }, { kind: 'record', id: 'record' }, { kind: 'record', id: 'hidden-record' },
    { kind: 'record', id: 'unknown' }, { kind: 'field', id: 'public-id' }, { kind: 'field', id: 'secret-id' }, { kind: 'compose', id: 'doc' },
  ] })
  const read = (role: BridgeRole = 'member', memberId = 'member', fieldAuthorityHash = 'current') => backupReadScope({ targets, authority, teamId: 'team-a', memberId, role, fieldAuthorityHash })
  const first = read()
  authority.observe(op('record.update','record',{data:{public:'another permitted edit'}}))
  assert.equal(read().authorityStamp,first.authorityStamp,'ordinary collaboration edits do not invalidate the permission revision')
  assert.equal(first.grants[0]?.root, 'module:shared')
  assert.equal(first.grants[1]?.entityId, 'table')
  assert.equal(first.grants[1]?.privateFields, true)
  assert.equal(first.grants[2], null)
  assert.equal(first.grants[3], null)
  assert.deepEqual(first.grants[4]?.field, { slug: 'public', type: 'text', multiple: false })
  assert.equal(first.grants[5], null)
  assert.ok(first.grants[6])
  assert.equal(read('member','removed').grants[6], null)
  assert.equal(read('admin','admin').grants[3], null, 'Admin cannot bless unknown cached rows')
  assert.ok(read('admin','admin').grants[5], 'Admin field authority is preserved')
  assert.equal(read().fingerprint, first.fingerprint, 'same current grants produce stable revalidation proof')
  assert.notEqual(read('member','member','next-policy').fingerprint, first.fingerprint)
  assert.notEqual(read('viewer').fingerprint, first.fingerprint, 'role downgrade invalidates proof')
  assert.notEqual(read('viewer').authorityStamp,first.authorityStamp)
  const publicBlob='a'.repeat(64),privateBlob='b'.repeat(64),unknownBlob='c'.repeat(64)
  authority.observe(op('record.update','record',{data:{public:{__teamspaceBlob:publicBlob},secret:{__teamspaceBlob:privateBlob}}}))
  const readBlobs=(role:BridgeRole='member')=>backupReadScope({targets:parseBackupReadTargets({version:1,targets:[publicBlob,privateBlob,unknownBlob].map(id=>({kind:'blob',id}))}),authority,teamId:'team-a',memberId:'member',role,fieldAuthorityHash:'current'})
  const blobs=readBlobs()
  assert.equal(blobs.grants[0]?.root,'module:shared','actual readable content can be backed up')
  assert.equal(blobs.grants[1],null,'private field attachments cannot borrow the record grant')
  assert.equal(blobs.grants[2],null,'a claimed hash is not server content ownership')
  assert.equal(readBlobs('admin').grants[2],null,'Admin cannot authorize arbitrary device files')
  authority.observe(op('record.update','record',{data:{public:null}}))
  assert.equal(readBlobs().grants[0],null,'a removed current reference blocks an old backup attachment')
  assert.notEqual(readBlobs().authorityStamp,blobs.authorityStamp,'later-page blob revocation invalidates the whole session')
  assert.throws(()=>parseBackupReadTargets({version:1,targets:[{kind:'blob',id:'not-a-sha'}]}))
  for (const forged of [
    { version: 1, targets: [{kind:'record',id:'hidden-record',moduleId:'shared'}] },
    { version: 1, role:'admin',targets:[{kind:'record',id:'record'}] },
    { version: 1, targets:[{kind:'record',id:'record'},{kind:'record',id:'record'}] },
    { version: 1, targets:[{kind:'record',id:'record\u0000'}] },
    { version: 1, targets: Array.from({length:501},(_,i)=>({kind:'record',id:String(i)})) },
  ]) assert.throws(() => parseBackupReadTargets(forged))
  authority.observe(op('field.update','secret-id',{slug:'renamed-secret'},{moduleId:'shared',entityId:'table'}))
  assert.equal(read().grants[5],null,'old slug deny continues through an ID alias after rename')
  policy = new FieldAccessProjection({ entities: [], fields: [] })
  assert.equal(read().grants[5]?.field?.slug,'renamed-secret','freshly permitted field is restored')
  authority.observe(op('entity.delete','table',{}, {moduleId:'shared'}))
  assert.notEqual(read().authorityStamp,first.authorityStamp,'a later-page deletion invalidates the whole read session')
  assert.equal(read().grants[1],null,'deleted parent cannot resurrect cached child')
  assert.equal(read('admin','admin').grants[1],null,'deleted ancestry is checked even for Admin')
  authority.observe(op('module.update','shared',{visibleToMemberIds:['admin']}))
  assert.equal(read().grants[0],null,'current module revocation wins over old backup')
  assert.notEqual(read().fingerprint, first.fingerprint)
  authority.failClosed()
  assert.throws(() => read(), /unavailable/)
  console.log('backup read scope: permitted/hidden fields, private module, Compose revocation, unknown/deleted lineage, forged identity, role/ACL revalidation, alias and unavailable authority passed')
} finally { rmSync(dir, {recursive:true,force:true}) }
