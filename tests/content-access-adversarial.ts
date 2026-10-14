import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import { ContentAccessIndex } from '../src/content-access.js'
import { DatabaseSync } from 'node:sqlite'
import type { ModulesSyncOp } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'content-access-adversarial-'))
let serial = 0
const op = (kind: string, targetId: string, patch: Record<string, unknown> = {}, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `adversarial-${++serial}`, kind, targetId, targetKind: kind.split('.')[0], moduleId: 'm',
  patch, originMemberId: 'admin', originRole: 'admin', originDevice: 'd', hlc: `${serial}:0:d`, protocolVersion: 2, hopCount: 0, ...extra,
})
const sha = 'a'.repeat(64), ref = { __teamspaceBlob: sha }
function setup(name: string) {
  const dir = join(root, name), store = new BridgeStore(dir, 21, null, null)
  store.appendOp(op('module.create', 'm', {}, { visibleToMemberIds: ['a', 'b'] }))
  store.appendOp(op('entity.create', 'e'))
  return { dir, store }
}
const cases: Array<[string, () => void | Promise<void>]> = [
  ['ignored record metadata cannot grant attachment access', () => {
    const { store } = setup('metadata')
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), true)
    store.appendOp(op('record.update', 'r', { data: { image: null, cellHlcs: ref, constructor: ref, _hidden: ref } }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
  }],
  ['delayed cell updates and snapshots cannot resurrect cleared references', () => {
    const { store, dir } = setup('ordering')
    store.appendOp(op('record.create', 'r', { data: { image: ref, other: 'keep' }, cellHlcs: { image: '100:0:d' } }, { entityId: 'e', hlc: '100:0:d' }))
    store.appendOp(op('record.update', 'r', { data: { image: null }, cellHlcs: { image: '300:0:d' } }, { hlc: '300:0:d' }))
    store.appendOp(op('record.update', 'r', { data: { image: ref }, cellHlcs: { image: '200:0:d' } }, { hlc: '400:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    const reopened = new BridgeStore(dir, 21, null, null)
    reopened.appendOp(op('record.create', 'r', { data: { image: ref }, cellHlcs: { image: '200:0:d' } }, { entityId: 'e', hlc: '500:0:d' }))
    assert.equal(reopened.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    reopened.appendOp(op('record.update', 'r', { data: { image: ref }, cellHlcs: { image: '600:0:d' } }, { hlc: '600:0:d' }))
    assert.equal(reopened.contentAccess.mayReadBlob(sha, 'a', 'member'), true, 'a genuinely newer reference remains supported')
    reopened.appendOp(op('record.create', 'r', { data: { other: 'newer' } }, { entityId: 'e', hlc: '700:0:d' }))
    assert.equal(reopened.contentAccess.mayReadBlob(sha, 'a', 'member'), true, 'partial existing-row snapshots merge; omitted cells are retained')
  }],
  ['record purge retires downloads and collaboration access', () => {
    const { store } = setup('purge')
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e' }))
    store.appendOp(op('record.purge', 'r'))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    assert.equal(store.contentAccess.mayReadRecord('r', 'a', 'member'), false)
    assert.notEqual(store.contentAccess.authorize(op('record.create', 'r', {}, { entityId: 'e' }), 'a', 'member'), null)
    assert.ok(store.contentAccess.cleanupNotices().some(notice => notice.kind === 'record.purge' && notice.targetId === 'r'))
    assert.equal(store.contentAccess.mayRead(op('record.create', 'r'), 'a', 'member'), false, 'purged historical content is not a fresh readable snapshot')
  }],
  ['deleted entities cannot acquire newly created children', () => {
    const { store } = setup('parent')
    store.appendOp(op('entity.delete', 'e'))
    assert.notEqual(store.contentAccess.authorize(op('record.create', 'fresh', { data: { image: ref } }, { entityId: 'e' }), 'a', 'member'), null)
    assert.notEqual(store.contentAccess.authorize(op('record.create', 'fresh', {}, { entityId: 'e' }), 'admin', 'admin'), null)
    const other = setup('batch-parent').store
    assert.notEqual(other.contentAccess.authorize(op('record.create', 'fresh', {}, { entityId: 'e' }), 'admin', 'admin', [op('entity.delete', 'e')]), null)
  }],
  ['field deletion requires administrator authority', () => {
    const { store } = setup('field-role')
    store.appendOp(op('field.create', 'f', { slug: 'image', type: 'file' }, { entityId: 'e' }))
    assert.notEqual(store.contentAccess.authorize(op('field.delete', 'f'), 'a', 'member'), null)
  }],
  ['field deletion retires only that table column references', () => {
    const { store } = setup('field-refs')
    store.appendOp(op('field.create', 'f', { slug: 'image', type: 'file' }, { entityId: 'e' }))
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e' }))
    store.appendOp(op('field.delete', 'f'))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    store.appendOp(op('record.update', 'r', { data: { image: ref, f: ref } }, { entityId: 'e' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false, 'deleted slug and legacy field-id cells cannot grant')
    store.appendOp(op('field.create', 'replacement', { slug: 'image', fieldType: 'file' }, { entityId: 'e' }))
    store.appendOp(op('record.update', 'r', { data: { image: ref } }, { entityId: 'e' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), true, 'a new field may legitimately reuse the slug')
  }],
  ['grant narrowing itself durably generates local cleanup', () => {
    const { store, dir } = setup('narrow')
    store.appendOp(op('module.update', 'm', {}, { visibleToMemberIds: ['b'], contentAclRevision: 0 }))
    assert.equal(store.contentAccess.mayRead(op('record.update', 'r'), 'a', 'member'), false)
    const notices = new BridgeStore(dir, 21, null, null).contentAccess.cleanupNotices()
    assert.ok(notices.some(notice => notice.kind === 'module.share_revoked' && notice.visibleToMemberIds?.includes('a')))
  }],
  ['renamed and type-changed fields do not leave historical blob grants', () => {
    const { store } = setup('field-rename')
    store.appendOp(op('field.create', 'f', { slug: 'image', fieldType: 'file' }, { entityId: 'e' }))
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e', hlc: '100:0:d' }))
    store.appendOp(op('field.update', 'f', { slug: 'renamed' }, { entityId: 'e', hlc: '200:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), true)
    store.appendOp(op('record.update', 'r', { data: { renamed: null } }, { hlc: '300:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    store.appendOp(op('record.update', 'r', { data: { image: ref } }, { hlc: '400:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false, 'retired old slug cannot keep authority')
    store.appendOp(op('record.update', 'r', { data: { renamed: ref } }, { hlc: '500:0:d' }))
    store.appendOp(op('field.update', 'f', { fieldType: 'number' }, { hlc: '600:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false)
    store.appendOp(op('record.update', 'r', { data: { renamed: ref } }, { hlc: '550:0:d' }))
    assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), false, 'pre-migration cells cannot undo reference retirement')
  }],
  ['whole-team narrowing pages cleanup and preserves current re-grants', () => {
    const { store, dir } = setup('paged-narrow')
    const people = Array.from({ length: 1200 }, (_, i) => `person-${i}`)
    writeFileSync(join(dir, 'members.json'), JSON.stringify(people.map(memberId => ({ memberId, displayName: memberId, email: `${memberId}@example.test`, role: 'member', createdAt: 1, sessions: {} }))))
    store.reload()
    store.appendOp(op('module.create', 'whole', {}, { moduleId: 'whole' }))
    store.appendOp(op('module.update', 'whole', {}, { moduleId: 'whole', visibleToMemberIds: [people[0]] }))
    const notices = store.contentAccess.cleanupNotices().filter(notice => notice.targetId === 'whole')
    assert.equal(notices.length, 3)
    assert.equal(new Set(notices.flatMap(notice => notice.visibleToMemberIds ?? [])).size, 1199)
    assert.equal(notices.some(notice => notice.visibleToMemberIds?.includes(people[0])), false)
    store.appendOp(op('module.update', 'whole', {}, { moduleId: 'whole', visibleToMemberIds: [people[0], people[1]] }))
    assert.equal(notices.some(notice => store.contentAccess.mayRead(notice, people[1], 'member')), false)
  }],
  ['older incremental checkpoints rebuild references without losing denials', () => {
    const { store, dir } = setup('incremental-migration')
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e', hlc: '100:0:d' }))
    store.appendOp(op('record.update', 'r', { data: { image: null } }, { hlc: '200:0:d' }))
    store.appendOp(op('module.share_revoked', 'm', {}, { visibleToMemberIds: ['a'] }))
    const manifest = JSON.parse(readFileSync(join(dir, 'content-access.json'), 'utf8'))
    delete manifest.referenceVersion
    writeFileSync(join(dir, 'content-access.json'), JSON.stringify(manifest))
    const reopened = new BridgeStore(dir, 21, null, null)
    assert.equal(reopened.contentAccess.healthy(), true)
    assert.equal(reopened.contentAccess.mayReadBlob(sha, 'b', 'member'), false)
    assert.equal(reopened.contentAccess.mayRead(op('module.update', 'm'), 'a', 'member'), false)
    assert.equal(reopened.contentAccess.revision(op('module.update', 'm')), 1, 'migration cannot replay a past grant transition')
    assert.equal(JSON.parse(readFileSync(join(dir, 'content-access.json'), 'utf8')).referenceVersion, 2)
  }],
  ['row and schema cleanup survives operation pruning and restart', async () => {
    const { store, dir } = setup('child-retention')
    const stale = Date.now() - 400 * 86_400_000
    writeFileSync(join(dir, 'members.json'), JSON.stringify([{ memberId: 'a', displayName: 'a', email: 'a@example.test', role: 'member',
      createdAt: stale, sessions: { offline: hashSessionToken('offline-token') }, sessionLastSeen: { offline: stale } }]))
    store.reload()
    store.appendOp(op('field.create', 'f', { slug: 'image', fieldType: 'file' }, { entityId: 'e' }))
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e' }))
    store.appendOp(op('field.delete', 'f'))
    store.appendOp(op('record.purge', 'r', { ignoredPrivate: 'never relay this' }))
    assert.ok(await store.pruneOps() > 0, '400-day-offline devices no longer block ordinary retention')
    const reopened = new BridgeStore(dir, 21, null, null), rows: ModulesSyncOp[] = []
    for await (const row of reopened.scanOpsFromStart()) rows.push(row)
    for (const kind of ['field.delete', 'record.purge']) {
      const notice = rows.find(row => row.kind === kind)
      assert.ok(notice, kind)
      assert.equal(reopened.contentAccess.mayRead(notice, 'a', 'member'), true)
      assert.equal(notice.moduleId, 'm')
      assert.equal(notice.entityId, 'e')
      assert.equal(JSON.stringify(notice).includes('never relay this'), false)
    }
  }],
  ['corrupt reference metadata and unknown future formats fail closed', () => {
    const { store, dir } = setup('bad-clocks')
    store.appendOp(op('record.create', 'r', { data: { image: ref } }, { entityId: 'e' }))
    const db = new DatabaseSync(join(dir, 'content-access.sqlite'))
    const rows = db.prepare('SELECT slot, body FROM authority').all()
    const row = rows.find(row => JSON.parse(String(row.body)).kind === 'cellClocks')!
    const entry = JSON.parse(String(row.body)); entry.value.image = 'unreadable'
    db.prepare('UPDATE authority SET body = ? WHERE slot = ?').run(JSON.stringify(entry), row.slot as string)
    db.close()
    assert.equal(new ContentAccessIndex(dir, null).healthy(), false)
    const future = setup('future-version').dir
    writeFileSync(join(future, 'content-access.json'), JSON.stringify({ version: 2, storage: 'sqlite', referenceVersion: 999 }))
    assert.equal(new ContentAccessIndex(future, null).healthy(), false)
  }],
  ['seeded replay model agrees across 300 reordered edits, grants and restarts', () => {
    const initial = setup('model'), dir = initial.dir
    let store = initial.store, seed = 173, allowed = true
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
    const hashes = Array.from({ length: 4 }, (_, i) => String(i + 1).repeat(64))
    const model = new Map<string, { at: number; hash: string | null }>()
    for (let i = 0; i < 8; i++) store.appendOp(op('record.create', `r${i}`, {}, { entityId: 'e', hlc: '0:0:d' }))
    for (let i = 0; i < 300; i++) {
      const record = `r${random() % 8}`, slug = `cell${random() % 3}`, at = random() % 1000 + 1
      const hash = random() % 3 === 0 ? null : hashes[random() % hashes.length]
      const key = `${record}:${slug}`, previous = model.get(key)
      store.appendOp(op(i % 7 === 0 ? 'record.create' : 'record.update', record,
        { data: { [slug]: hash ? { __teamspaceBlob: hash } : null }, cellHlcs: { [slug]: `${at}:0:d` } },
        { entityId: 'e', hlc: `${2000 + i}:0:d` }))
      if (!previous || at > previous.at) model.set(key, { at, hash })
      if (i % 37 === 0) {
        allowed = !allowed
        const control = op('module.update', 'm', {}, { visibleToMemberIds: allowed ? ['a', 'b'] : ['b'] })
        control.contentAclRevision = store.contentAccess.revision(control)
        assert.equal(store.contentAccess.authorize(control, 'admin', 'admin'), null)
        store.appendOp(control)
      }
      if (i % 50 === 0) store = new BridgeStore(dir, 21, null, null)
      for (const sha of hashes) {
        const referenced = [...model.values()].some(value => value.hash === sha)
        assert.equal(store.contentAccess.mayReadBlob(sha, 'b', 'member'), referenced, `retained read at step ${i}`)
        assert.equal(store.contentAccess.mayReadBlob(sha, 'a', 'member'), allowed && referenced, `revocation read at step ${i}`)
      }
    }
  }],
]
let failed = 0
try {
  for (const [name, test] of cases) {
    try { await test(); console.log('PASS', name) }
    catch (error) { failed++; console.error('FAIL', name, (error as Error).stack) }
  }
  assert.equal(failed, 0, `${failed} unresolved adversarial findings`)
} finally { rmSync(root, { recursive: true, force: true }) }
