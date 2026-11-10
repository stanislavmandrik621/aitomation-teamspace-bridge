/** Real files and production store; inject only disk flush failures.
 * These tests establish ACK ordering, not physical power-cut qualification.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = fs.mkdtempSync(join(tmpdir(), 'teamwork-ops-durability-'))
const originalSync = fs.fsyncSync, originalRename = fs.renameSync, originalUnlink = fs.unlinkSync
let observed: string[] = [], fail: 'file' | 'directory' | 'pending' | 'rewrite' | 'renamed-directory' | null = null
let current = '', flushFailed = false
const op = (id: string): ModulesSyncOp => ({ opId: id, kind: 'entity.create', targetKind: 'entity', targetId: id, hlc: `${Date.now()}:0:test`, originDevice: 'test-device', hopCount: 0, protocolVersion: 2 })
function identify(fd: number): string {
  const stat = fs.fstatSync(fd)
  for (const name of ['ops.jsonl', 'ops.jsonl.pending', 'ops.jsonl.rewrite', '']) {
    const path = join(current, name)
    if (fs.existsSync(path) && fs.statSync(path).ino === stat.ino) return name || 'directory'
  }
  return 'other'
}
fs.fsyncSync = fd => {
  const target = identify(fd)
  observed.push('sync:' + target)
  const shouldFail = fail === 'file' ? target === 'ops.jsonl'
    : fail === 'directory' ? target === 'directory'
    : fail === 'pending' ? target === 'ops.jsonl.pending'
    : fail === 'rewrite' ? target === 'ops.jsonl.rewrite'
    : fail === 'renamed-directory' ? target === 'directory' && observed.includes('rename:ops.jsonl.rewrite')
    : false
  if (!flushFailed && shouldFail) {
    flushFailed = true
    throw Object.assign(new Error('Injected disk flush EIO'), { code: 'EIO' })
  }
  originalSync(fd)
}
fs.renameSync = (from, to) => { observed.push(`rename:${String(from).split('/').at(-1)}`); originalRename(from, to) }
fs.unlinkSync = path => { observed.push(`unlink:${String(path).split('/').at(-1)}`); originalUnlink(path) }
syncBuiltinESMExports()

try {
  current = join(root, 'batch'); fs.mkdirSync(current)
  let store = new BridgeStore(current, 21, null)
  observed = []
  store.appendOps(Array.from({ length: 100 }, (_, i) => op('batch-' + i)))
  assert.equal(observed.filter(x => x === 'sync:ops.jsonl').length, 1, 'One data flush for the whole accepted batch')
  assert(observed.indexOf('sync:directory') > observed.indexOf('sync:ops.jsonl'), 'New log directory entry is durable before success')
  const raw = fs.readFileSync(join(current, 'ops.jsonl'), 'utf8')
  assert.equal(raw.trim().split('\n').length, 100)
  observed = []
  store.appendOp(op('batch-0')) // Different HLC may conflict; never a new ACKed row.
  assert.equal(fs.readFileSync(join(current, 'ops.jsonl'), 'utf8'), raw)

  for (const mode of ['file', 'directory'] as const) {
    current = join(root, mode); fs.mkdirSync(current)
    store = new BridgeStore(current, 21, null)
    const pending = op('uncertain-' + mode)
    observed = []; fail = mode; flushFailed = false
    assert.throws(() => store.appendOp(pending), /disk flush failed/)
    assert(flushFailed)
    assert.equal(store.hasSeenOpId(pending.opId), false, 'Failed flush cannot seed the acknowledged-ID cache')
    assert.equal(store.contentAccess.healthy(), false, 'Uncertain persistence fails closed')
    fail = null
    assert.throws(() => store.appendOp(pending), /disk flush failed/, 'Exact retry cannot bypass the failed flush in this process')
    assert.throws(() => store.appendOp(op('later')), /disk flush failed/)
    const before = fs.readFileSync(join(current, 'ops.jsonl'), 'utf8')
    observed = []
    store = new BridgeStore(current, 21, null)
    assert(observed.includes('sync:ops.jsonl'), 'Startup confirms recovered log before replay')
    assert.equal(store.hasSeenOpId(pending.opId), true)
    store.appendOp(pending)
    assert.equal(fs.readFileSync(join(current, 'ops.jsonl'), 'utf8'), before, 'Retry after storage recovery is exact and unique')
  }

  current = join(root, 'sidecar'); fs.mkdirSync(current)
  store = new BridgeStore(current, 21, null)
  store.appendOp(op('original'))
  ;(store as any).opsPruning = true
  observed = []
  store.appendOp(op('during-prune'))
  assert(observed.includes('sync:ops.jsonl.pending'), 'Sidecar flush precedes accepted concurrent write')
  ;(store as any).opsPruning = false
  observed = []
  ;(store as any).flushPendingOpsOntoLog()
  assert(observed.indexOf('sync:ops.jsonl') < observed.indexOf('unlink:ops.jsonl.pending'), 'Replacement durable before sidecar retirement')
  assert(observed.lastIndexOf('sync:directory') > observed.indexOf('unlink:ops.jsonl.pending'))
  observed = []
  await store.pruneOps()
  assert(observed.indexOf('sync:ops.jsonl.rewrite') >= 0)
  assert(observed.indexOf('sync:ops.jsonl.rewrite') < observed.indexOf('rename:ops.jsonl.rewrite'), 'Compaction flushes complete replacement before rename')
  assert(observed.lastIndexOf('sync:directory') > observed.indexOf('rename:ops.jsonl.rewrite'), 'Replacement name is durable before prune completes')
  // A failed sidecar flush must not become a same-process idempotent ACK.
  current = join(root, 'sidecar-eio'); fs.mkdirSync(current)
  store = new BridgeStore(current, 21, null)
  store.appendOp(op('sidecar-baseline'))
  ;(store as any).opsPruning = true
  const uncertainSidecar = op('sidecar-uncertain')
  observed = []; fail = 'pending'; flushFailed = false
  assert.throws(() => store.appendOp(uncertainSidecar), /disk flush failed/)
  assert(flushFailed)
  assert.equal(store.hasSeenOpId(uncertainSidecar.opId), false)
  fail = null
  assert.throws(() => store.appendOp(uncertainSidecar), /disk flush failed/)
  store = new BridgeStore(current, 21, null)
  assert.equal(store.hasSeenOpId(uncertainSidecar.opId), true)
  assert(!fs.existsSync(join(current, 'ops.jsonl.pending')))
  const recoveredSidecar = fs.readFileSync(join(current, 'ops.jsonl'), 'utf8')
  store.appendOp(uncertainSidecar)
  assert.equal(fs.readFileSync(join(current, 'ops.jsonl'), 'utf8'), recoveredSidecar)

  for (const point of ['rewrite', 'renamed-directory'] as const) {
    current = join(root, point); fs.mkdirSync(current)
    store = new BridgeStore(current, 21, null)
    const retained = op('compaction-' + point)
    store.appendOp(retained)
    observed = []; fail = point; flushFailed = false
    await assert.rejects(store.pruneOps(), /disk flush failed/)
    assert(flushFailed, 'Compaction reached the injected flush boundary')
    assert.equal(store.contentAccess.healthy(), false)
    fail = null
    assert.throws(() => store.appendOp(retained), /disk flush failed/)
    store = new BridgeStore(current, 21, null)
    assert.equal(store.hasSeenOpId(retained.opId), true, 'Original or replacement log retains the accepted operation')
    const durable = fs.readFileSync(join(current, 'ops.jsonl'), 'utf8')
    store.appendOp(retained)
    assert.equal(fs.readFileSync(join(current, 'ops.jsonl'), 'utf8'), durable)
  }

  console.log('PASS operation durability: one flush per 100-op batch, data/directory EIO refusals, no false retry ACK, durable startup recovery, sidecar merge/failure recovery, compaction ordering and pre/post-rename failure recovery')
} finally {
  fs.fsyncSync = originalSync; fs.renameSync = originalRename; fs.unlinkSync = originalUnlink
  syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
