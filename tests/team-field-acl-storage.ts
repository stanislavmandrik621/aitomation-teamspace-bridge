/** Real authority checkpoint/WAL persistence; only disposable fixture data. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import { TeamFieldAclStore, hashTeamFieldAclBag, normalizeBridgeFieldAclBag } from '../src/team-field-acl.js'
import type { ModulesSyncOp } from '../src/index.js'
import { resolveAtRestKeyFromEnv, decryptOpsLine } from '../src/at-rest.js'

let serial = 0
const old = Date.now() - 400 * 86_400_000
const bag = (fieldSlug: string, version = 1) => ({ version, entities: [], fields: [{ entityId: 'entity', fieldSlug, role: 'member', read: false, write: false, hidden: true }] })
const proposal = (fieldSlug: string, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `acl-storage-${++serial}`, kind: 'module.update', targetKind: 'module', targetId: 'module', moduleId: 'module',
  originMemberId: 'admin', originRole: 'admin', originDevice: 'device',
  hlc: `${old}:0:device`, protocolVersion: 2, hopCount: 0,
  patch: { config: { teamSpaceAclGrantBag: bag(fieldSlug) } }, ...extra,
})
const fixture = (name: string) => mkdtempSync(join(tmpdir(), `field-acl-${name}-`))
function commit(store: BridgeStore, fieldSlug: string, extra: Partial<ModulesSyncOp> = {}) {
  const base = store.fieldAcl.snapshot()!
  const stamped = store.fieldAcl.stamp(proposal(fieldSlug, { fieldAclBaseHash: base.hash, ...extra }), 'admin')
  const accepted = store.appendOps([stamped])
  assert.equal(accepted.accepted.length, 1)
  return stamped
}

test('ACL checkpoint survives actual retention and restart; preview is not authority', async () => {
  const root = fixture('retention')
  try {
    writeFileSync(join(root, 'members.json'), JSON.stringify([{ memberId: 'admin', email: 'admin@example.test', displayName: 'Admin', role: 'admin', createdAt: old,
      sessions: { device: hashSessionToken('fixture-token') }, sessionLastSeen: { device: old } }]))
    const store = new BridgeStore(root, 21, null, null)
    const initial = store.fieldAcl.snapshot()!
    const preview = store.fieldAcl.stamp(proposal('secret', { fieldAclBaseHash: initial.hash, fieldAclRevision: 99 }), 'admin')
    assert.equal(preview.fieldAclRevision, 1, 'client cannot choose its authority revision')
    assert.deepEqual(store.fieldAcl.snapshot(), initial, 'stamp must not activate a grant before its WAL row')
    store.appendOps([preview])
    const snapshot = store.fieldAcl.snapshot()!
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.hash, hashTeamFieldAclBag(bag('secret')))
    assert.equal(await store.pruneOps(), 1, 'the real retention path removes its old acknowledged/stale-device WAL row')
    assert.equal(readFileSync(join(root, 'ops.jsonl'), 'utf8'), '')
    const restarted = new BridgeStore(root, 21, null, null)
    assert.deepEqual(restarted.fieldAcl.snapshot(), snapshot)
    assert.equal(restarted.contentAccess.healthy(), true)
    ;(snapshot.bag as any).fields[0].hidden = false
    assert.equal((restarted.fieldAcl.snapshot()!.bag as any).fields[0].hidden, true, 'returned snapshots cannot mutate authority')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint lag replays complete WAL rows around a torn tail and accepts a later CAS', () => {
  const root = fixture('torn')
  try {
    let store = new BridgeStore(root, 21, null, null)
    commit(store, 'first')
    const checkpoint = readFileSync(join(root, 'team-field-acl.json'))
    commit(store, 'second')
    writeFileSync(join(root, 'team-field-acl.json'), checkpoint)
    appendFileSync(join(root, 'ops.jsonl'), '{"opId":"torn')
    store = new BridgeStore(root, 21, null, null)
    assert.equal(store.fieldAcl.healthy(), true)
    assert.equal(store.fieldAcl.snapshot()!.revision, 2)
    assert.equal(store.fieldAcl.snapshot()!.hash, hashTeamFieldAclBag(bag('second')))
    commit(store, 'third')
    assert.equal(new BridgeStore(root, 21, null, null).fieldAcl.snapshot()!.revision, 3)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('initialized checkpoint missing, corrupt or wrong-key freezes grants/content and preserves WAL', async () => {
  for (const mode of ['missing', 'corrupt', 'wrong-key', 'missing-key'] as const) {
    const root = fixture(mode)
    const encrypted = mode.endsWith('key')
    const key = encrypted ? resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: '1'.repeat(64) }) : null
    try {
      let store = new BridgeStore(root, 21, key, null)
      commit(store, 'PRIVATE_HIDDEN_FIELD')
      const before = readFileSync(join(root, 'ops.jsonl'))
      if (encrypted) assert.equal(readFileSync(join(root, 'team-field-acl.json'), 'utf8').includes('PRIVATE_HIDDEN_FIELD'), false)
      if (mode === 'missing') unlinkSync(join(root, 'team-field-acl.json'))
      if (mode === 'corrupt') writeFileSync(join(root, 'team-field-acl.json'), '{broken')
      const readKey = mode === 'wrong-key' ? resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: '2'.repeat(64) }) : mode === 'missing-key' ? null : key
      store = new BridgeStore(root, 21, readKey, null)
      assert.equal(store.fieldAcl.healthy(), false, mode)
      assert.equal(store.fieldAcl.snapshot(), undefined, mode)
      assert.equal(store.contentAccess.healthy(), false, mode)
      assert.throws(() => store.fieldAcl.stamp(proposal('loosened'), 'admin'), /unavailable/)
      assert.equal(await store.pruneOps(), 0)
      assert.deepEqual(readFileSync(join(root, 'ops.jsonl')), before)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('partial checkpoint write failure fails closed but preserves complete WAL for restart repair', async () => {
  const root = fixture('partial-write')
  const key = resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: '3'.repeat(64) })!
  const originalOpen = fs.openSync, originalWrite = fs.writeFileSync
  try {
    let store = new BridgeStore(root, 21, key, null)
    commit(store, 'first')
    const before = readFileSync(join(root, 'team-field-acl.json'))
    const failedFds = new Set<number>()
    let injected = false
    fs.openSync = ((path: fs.PathLike, ...args: any[]) => {
      const fd = (originalOpen as any)(path, ...args)
      if (String(path).startsWith(join(root, 'team-field-acl.json.')) && String(path).endsWith('.tmp')) failedFds.add(fd)
      return fd
    }) as typeof fs.openSync
    fs.writeFileSync = ((file: any, data: any, ...args: any[]) => {
      if (typeof file === 'number' && failedFds.delete(file)) {
        injected = true
        originalWrite(file, String(data).slice(0, 15), 'utf8')
        throw Object.assign(new Error('Injected checkpoint EIO after partial temporary write'), { code: 'EIO' })
      }
      return (originalWrite as any)(file, data, ...args)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    try { assert.throws(() => commit(store, 'second'), /Injected checkpoint EIO/) }
    finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; syncBuiltinESMExports() }
    assert.equal(injected, true)
    assert.equal(store.fieldAcl.healthy(), false)
    assert.equal(store.contentAccess.healthy(), false)
    assert.deepEqual(readFileSync(join(root, 'team-field-acl.json')), before, 'old complete checkpoint was not replaced by a partial temp file')
    const wal = readFileSync(join(root, 'ops.jsonl'), 'utf8')
    assert.equal(wal.trim().split('\n').map(line => JSON.parse(decryptOpsLine(key, line))).at(-1)?.fieldAclRevision, 2)
    assert.equal(await store.pruneOps(), 0)
    assert.equal(readFileSync(join(root, 'ops.jsonl'), 'utf8'), wal)
    assert.equal(readdirSync(root).some(name => name.startsWith('team-field-acl.json.') && name.endsWith('.tmp')), false)
    store = new BridgeStore(root, 21, key, null)
    assert.equal(store.fieldAcl.healthy(), true)
    assert.equal(store.fieldAcl.snapshot()!.revision, 2)
    assert.equal(store.fieldAcl.snapshot()!.hash, hashTeamFieldAclBag(bag('second')))
  } finally { fs.openSync = originalOpen; fs.writeFileSync = originalWrite; syncBuiltinESMExports(); rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint lag plus unreadable WAL cannot serve an older authority as current', async () => {
  const root = fixture('unreadable-wal')
  try {
    let store = new BridgeStore(root, 21, null, null)
    commit(store, 'old-grant')
    const olderCheckpoint = readFileSync(join(root, 'team-field-acl.json'))
    commit(store, 'current-grant')
    writeFileSync(join(root, 'team-field-acl.json'), olderCheckpoint)
    renameSync(join(root, 'ops.jsonl'), join(root, 'ops.jsonl.saved'))
    mkdirSync(join(root, 'ops.jsonl')) // deterministic unreadable-as-a-file, including privileged test runners
    store = new BridgeStore(root, 21, null, null)
    assert.equal(store.fieldAcl.healthy(), false, 'the unreadable committed log may contain newer field grants than the checkpoint')
    assert.equal(store.contentAccess.healthy(), false)
    assert.equal(await store.pruneOps(), 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint lag plus a corrupted complete encrypted WAL row fails closed', async () => {
  const root = fixture('encrypted-wal')
  const key = resolveAtRestKeyFromEnv({ TEAMSPACE_AT_REST_KEY: '4'.repeat(64) })!
  try {
    let store = new BridgeStore(root, 21, key, null)
    commit(store, 'old-grant')
    const olderCheckpoint = readFileSync(join(root, 'team-field-acl.json'))
    commit(store, 'current-grant')
    writeFileSync(join(root, 'team-field-acl.json'), olderCheckpoint)
    const lines = readFileSync(join(root, 'ops.jsonl'), 'utf8').trimEnd().split('\n')
    const packet = Buffer.from(lines[1]!.slice('e1.'.length), 'base64url')
    packet[25] = packet[25]! ^ 1 // full, well-framed ciphertext with an invalid authentication tag
    lines[1] = `e1.${packet.toString('base64url')}`
    const damaged = lines.join('\n') + '\n'
    writeFileSync(join(root, 'ops.jsonl'), damaged)
    store = new BridgeStore(root, 21, key, null)
    assert.equal(store.fieldAcl.healthy(), false, 'a complete unauthenticated WAL row may contain a newer restriction')
    assert.equal(store.contentAccess.healthy(), false)
    assert.equal(await store.pruneOps(), 0)
    assert.equal(readFileSync(join(root, 'ops.jsonl'), 'utf8'), damaged, 'corrupt authority evidence is preserved for operator recovery')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('checkpoint/marker links and directories fail closed without touching another file', () => {
  for (const mode of ['checkpoint-link', 'checkpoint-dangling', 'checkpoint-dir', 'marker-dir', 'marker-link'] as const) {
    const root = fixture(mode), live = join(root, 'live'), other = join(root, 'other-owner-file')
    try {
      const store = new BridgeStore(live, 21, null, null)
      commit(store, 'PRIVATE_CURRENT_GRANT')
      const original = readFileSync(join(live, 'team-field-acl.json'))
      writeFileSync(other, original)
      const target = join(live, mode.startsWith('checkpoint') ? 'team-field-acl.json' : 'team-field-acl.initialized')
      unlinkSync(target)
      if (mode.endsWith('-dir')) mkdirSync(target)
      else symlinkSync(mode === 'checkpoint-dangling' ? join(root, 'absent') : other, target)
      const reopened = new BridgeStore(live, 21, null, null)
      assert.equal(reopened.fieldAcl.healthy(), false, mode)
      assert.equal(reopened.contentAccess.healthy(), false, mode)
      assert.deepEqual(readFileSync(other), original, 'another owner file is never read into authority or overwritten')
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('legacy migration uses the highest valid Admin HLC; later typed revision beats optimistic HLC', () => {
  const root = fixture('legacy')
  try {
    const rows = [proposal('old', { hlc: '10:0:admin' }), proposal('newest', { hlc: '900000000000000:0:admin' }),
      proposal('older-late-row', { hlc: '20:0:admin' }), proposal('member-injection', { hlc: '900000000000001:0:member', originRole: 'member' })]
    writeFileSync(join(root, 'ops.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    let store = new BridgeStore(root, 21, null, null)
    assert.equal(store.fieldAcl.snapshot()!.hash, hashTeamFieldAclBag(bag('newest')))
    const base = store.fieldAcl.snapshot()!
    commit(store, 'typed-current', { hlc: '1:0:typed' })
    assert.equal(store.fieldAcl.snapshot()!.revision, base.revision + 1)
    store = new BridgeStore(root, 21, null, null)
    assert.equal(store.fieldAcl.snapshot()!.hash, hashTeamFieldAclBag(bag('typed-current')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('strict ACL identities and roles reject lossy aliases; CAS revisions survive stale fanout', () => {
  const root = fixture('validation')
  try {
    const store = new TeamFieldAclStore(root, null)
    const first = store.stamp(proposal('first'), 'admin')
    store.validateCommit([first]); store.observe(first)
    const snapshot = store.snapshot()!
    assert.throws(() => store.stamp(proposal('second', { fieldAclBaseHash: hashTeamFieldAclBag(null) }), 'admin'), /another device/)
    const pending = store.stamp(proposal('second', { fieldAclBaseHash: snapshot.hash }), 'admin')
    const sibling = store.stamp(proposal('second', { fieldAclBaseHash: snapshot.hash, targetId: 'sibling' }), 'admin', [pending])
    assert.equal(sibling.fieldAclRevision, pending.fieldAclRevision)
    store.validateCommit([pending, sibling]); store.observe(pending); store.observe(sibling)
    assert.equal(store.snapshot()!.revision, 2)
    for (const entityId of [' entity', 'entity\0other', 'entity '.repeat(30)]) {
      const bad = bag('field'); bad.fields[0]!.entityId = entityId
      assert.throws(() => normalizeBridgeFieldAclBag(bad), /identity/)
    }
    const malformedRole = bag('field') as any; malformedRole.fields[0].role = ['member']
    assert.throws(() => normalizeBridgeFieldAclBag(malformedRole), /role/, 'a JSON array role must not alias the role string')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
