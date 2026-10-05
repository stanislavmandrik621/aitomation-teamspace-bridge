import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, renameSync, symlinkSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BridgeStore } from '../src/store.js'
import { ContentAccessIndex } from '../src/content-access.js'
import { resolveAtRestKeyFromEnv } from '../src/at-rest.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'enterprise-content-regression-'))
let sequence = 0
const op = (kind: string, targetId: string, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `enterprise-unit-${++sequence}`, kind, targetId, targetKind: kind.split('.')[0],
  originRole: 'admin', originMemberId: 'admin', originDevice: 'admin-device', hlc: `${Date.now()}:0:admin`, protocolVersion: 2, hopCount: 0, ...extra,
})
try {
  for (const family of ['module', 'playbook', 'compose.doc']) {
    const dir = join(root, family)
    let store = new BridgeStore(dir, 21, null, null)
    const created = op(`${family}.create`, 'item')
    store.appendOp(created)
    const people = Array.from({ length: 1200 }, (_, i) => `member-${i}`)
    const kind = family === 'compose.doc' ? 'compose' : family
    const chunks = [0, 500, 1000].map(offset => op(`${kind}.share_revoked`, 'item', {
      visibleToMemberIds: people.slice(offset, offset + 500), patch: { authoritativeDelete: true, unsharedFromTeam: true },
    }))
    store.appendOps(chunks)
    for (const member of [...people, 'future']) assert.equal(store.contentAccess.mayRead(created, member, 'member'), false)
    store = new BridgeStore(dir, 21, null, null)
    assert.equal(store.contentAccess.mayRead(created, 'future', 'member'), false)
    assert.equal(store.contentAccess.cleanupNotices().length, 3)
    const restore = op(`${family}.create`, 'item', { contentAclRevision: store.contentAccess.revision(created) })
    assert.equal(store.contentAccess.authorize(restore, 'admin', 'admin'), null)
    store.appendOp(restore)
    assert.equal(store.contentAccess.mayRead(created, 'future', 'member'), true)
    assert.equal(store.contentAccess.cleanupNotices().length, 0, 'obsolete cleanup must not destroy a restored item')
  }
  const batch = new BridgeStore(join(root, 'batch'), 21, null, null)
  const created = op('module.create', 'm', { visibleToMemberIds: ['a', 'b'] })
  batch.appendOp(created)
  const revoke = op('module.share_revoked', 'm', { visibleToMemberIds: ['a'], patch: { authoritativeDelete: true } })
  const stale = op('module.update', 'm', { visibleToMemberIds: ['a', 'b'], contentAclRevision: 0 })
  assert.match(batch.contentAccess.authorize(stale, 'admin', 'admin', [revoke])!, /revision/)
  batch.appendOp(revoke)
  assert.match(batch.contentAccess.authorize(stale, 'admin', 'admin')!, /revision/)
  const current = { ...stale, contentAclRevision: batch.contentAccess.revision(created) }
  assert.equal(batch.contentAccess.authorize(current, 'admin', 'admin'), null)
  batch.appendOp(current)
  assert.equal(batch.isExactOpRetry(current), true)
  assert.equal(batch.isExactOpRetry({ ...current, patch: { unexpected: true } }), false)

  const refsDir = join(root, 'references')
  let refs = new BridgeStore(refsDir, 21, null, null)
  refs.appendOp(op('module.create', 'm', { visibleToMemberIds: ['a'] }))
  refs.appendOp(op('entity.create', 'e', { moduleId: 'm' }))
  const sha = 'b'.repeat(64), sha2 = 'c'.repeat(64)
  const ref = { __teamspaceBlob: sha }, ref2 = { __teamspaceBlob: sha2 }
  for (const replacement of [{ data: { image: null } }, { patch: { image: null } }, { image: null }, { removeKeys: ['image'] }, { remove_keys: ['image'] }]) {
    refs.appendOp(op('record.create', 'r', { moduleId: 'm', entityId: 'e', patch: { data: { image: ref, second: ref2 } } }))
    assert.equal(refs.contentAccess.mayReadBlob(sha, 'a', 'member'), true)
    refs.appendOp(op('record.update', 'r', { moduleId: 'm', entityId: 'e', patch: replacement }))
    assert.equal(refs.contentAccess.mayReadBlob(sha, 'a', 'member'), false, JSON.stringify(replacement))
    assert.equal(refs.contentAccess.mayReadBlob(sha2, 'a', 'member'), true, 'unmodified cells retain their references')
  }
  refs.appendOp(op('record.create', 'r2', { moduleId: 'm', entityId: 'e', patch: { data: { image: ref2 } } }))
  refs.appendOp(op('record.delete', 'r', { moduleId: 'm' }))
  assert.equal(refs.contentAccess.mayReadBlob(sha2, 'a', 'member'), true, 'another current record retains ownership')
  refs.appendOp(op('entity.delete', 'e', { moduleId: 'm' }))
  assert.equal(refs.contentAccess.mayReadBlob(sha2, 'a', 'member'), false)
  refs = new BridgeStore(refsDir, 21, null, null)
  assert.equal(refs.contentAccess.mayReadBlob(sha2, 'a', 'member'), false, 'restart cannot reconstruct deleted references from old ops')
  assert.equal(refs.contentAccess.mayReadRecord('r2', 'a', 'member'), false)

  const faultDir = join(root, 'fault')
  let fault = new BridgeStore(faultDir, 21, null, null)
  fault.appendOp(created)
  const sql = new DatabaseSync(join(faultDir, 'content-access.sqlite'))
  sql.exec("CREATE TRIGGER deny_authority BEFORE INSERT ON authority BEGIN SELECT RAISE(FAIL, 'injected disk failure'); END")
  assert.throws(() => fault.appendOp(revoke))
  assert.equal(fault.contentAccess.healthy(), false)
  sql.exec('DROP TRIGGER deny_authority'); sql.close()
  fault = new BridgeStore(faultDir, 21, null, null)
  assert.equal(fault.contentAccess.healthy(), true)
  assert.equal(fault.contentAccess.mayRead(created, 'a', 'member'), false, 'WAL repairs failed SQLite commit before serving')

  const legacyDir = join(root, 'legacy')
  mkdirSync(legacyDir)
  writeFileSync(join(legacyDir, 'content-access.json'), JSON.stringify({ version: 1,
    items: { 'module:m': { audience: ['a', 'b'], denied: ['a'], revision: 3, deleted: false } },
    targets: { 'module:m': 'module:m', 'record:r': 'module:m' }, blobs: { [sha]: ['module:m'] }, uploads: {}, controls: [] }))
  writeFileSync(join(legacyDir, 'content-access.initialized'), '1')
  const legacy = new BridgeStore(legacyDir, 21, null, null)
  assert.equal(legacy.contentAccess.mayRead(created, 'a', 'member'), false)
  assert.equal(legacy.contentAccess.mayRead(created, 'b', 'member'), true)
  assert.equal(legacy.contentAccess.mayReadBlob(sha, 'b', 'member'), false, 'unprovable historical lineage requires an authorized resnapshot')
  assert.equal(legacy.contentAccess.cleanupNotices().some(notice => legacy.contentAccess.mayRead(notice, 'a', 'member')), true, 'pruned v1 denials regain durable cleanup delivery')
  assert.equal(new BridgeStore(legacyDir, 21, null, null).contentAccess.healthy(), true)
  renameSync(join(legacyDir, 'content-access.sqlite'), join(legacyDir, 'content-access.saved'))
  assert.equal(new ContentAccessIndex(legacyDir, null).healthy(), false)

  const encryptedDir = join(root, 'encrypted')
  const encryption = resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: 'c'.repeat(64) })!
  const encrypted = new BridgeStore(encryptedDir, 21, encryption, null)
  encrypted.appendOp(op('module.create', 'secret-module', { visibleToMemberIds: ['secret-member'] }))
  const inspectSql = new DatabaseSync(join(encryptedDir, 'content-access.sqlite'))
  for (const row of inspectSql.prepare('SELECT body FROM authority').all()) assert.equal(String(row.body).includes('secret-member'), false)
  inspectSql.close()
  assert.equal(new BridgeStore(encryptedDir, 21, encryption, null).contentAccess.mayReadRecord('unknown', 'x', 'member'), false)
  assert.equal(new ContentAccessIndex(encryptedDir, null).healthy(), false)
  const unsafeDir = join(root, 'unsafe'), outside = join(root, 'untouched')
  mkdirSync(unsafeDir); writeFileSync(outside, 'must survive')
  symlinkSync(outside, join(unsafeDir, 'content-access.sqlite'))
  const unsafe = new ContentAccessIndex(unsafeDir, null)
  assert.throws(() => unsafe.flush())
  assert.equal(readFileSync(outside, 'utf8'), 'must survive')
  console.log('Enterprise authority: paged whole-unshare/regrant, in-frame CAS, retries, current references, crash repair, encrypted migration and unsafe-path refusal passed')
} finally { rmSync(root, { recursive: true, force: true }) }
