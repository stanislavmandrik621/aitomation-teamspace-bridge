import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

function op(id: string, body = ''): ModulesSyncOp {
  return {
    opId: id, targetId: id, kind: 'entity.create', targetKind: 'entity',
    hlc: `0/${id}`, originDevice: 'writer', hopCount: 0, protocolVersion: 2,
    patch: { body },
  }
}
async function collect(store: BridgeStore): Promise<string[]> {
  const ids: string[] = []
  for await (const row of store.scanOpsFromStart()) ids.push(row.opId)
  return ids
}

const dir = mkdtempSync(join(tmpdir(), 'bridge-catchup-concurrency-'))
try {
  const store = new BridgeStore(dir, 21, null)
  store.appendOp(op('initial'))
  assert.deepEqual((await store.readRecentOps()).map(row => row.opId), ['initial'])
  store.appendOp(op('after-cache'))
  assert.deepEqual((await store.readRecentOps()).map(row => row.opId), ['initial', 'after-cache'],
    'a reconnect after append must not reuse the pre-append recent-op snapshot')

  const rows = Array.from({ length: 5_000 }, (_, i) => op(`bulk-${i}`, 'x'.repeat(4_096)))
  store.appendOps(rows)
  console.log('catchup: 5,002 operations appended')
  const expected = ['initial', 'after-cache', ...rows.map(row => row.opId)]
  const stalled = store.scanOpsFromStart()
  assert.equal((await stalled.next()).value?.opId, 'initial')
  assert.deepEqual(await collect(store), expected,
    'healthy consumer completes while another reader is paused for the entire scan')
  await assert.rejects(stalled.next(), /backlog limit/,
    'paused consumer must be shed with an explicit retryable failure, never buffer the whole log')
  assert.deepEqual(await collect(store), expected,
    'a late reconnect still receives the full ordered log beyond the bounded sharing prefix')

  const pruning = store.pruneOps()
  console.log('catchup: paused-reader eviction and full replay passed')
  store.appendOp(op('during-prune'))
  const scanning = collect(store)
  const recent = store.readRecentOps(10_000)
  const [during, tail] = await Promise.all([scanning, recent, pruning])
  assert.deepEqual(during, [...expected, 'during-prune'],
    'concurrent scan includes committed prune-sidecar operations exactly once across atomic rename')
  assert.deepEqual(tail.map(row => row.opId), [...expected, 'during-prune'])

  // Hold the real disk producer before its first read while appends repeatedly
  // invalidate sharing. Verify the serialized producer queue itself is bounded.
  const queuedStore = new BridgeStore(join(dir, 'queued'), 21, null)
  console.log('catchup: prune/append race passed; checking producer queue')
  const rawScan = (queuedStore as any).scanOpsFromStartUnshared.bind(queuedStore)
  let unblock!: () => void
  const blocked = new Promise<void>(resolve => { unblock = resolve })
  ;(queuedStore as any).scanOpsFromStartUnshared = async function* () {
    await blocked
    yield* rawScan()
  }
  const readers: AsyncGenerator<ModulesSyncOp>[] = []
  const started: Promise<IteratorResult<ModulesSyncOp>>[] = []
  for (let i = 0; i < 32; i++) {
    queuedStore.appendOp(op(`queued-${i}`))
    const reader = queuedStore.scanOpsFromStart()
    readers.push(reader)
    started.push(reader.next())
  }
  queuedStore.appendOp(op('queue-overflow'))
  await assert.rejects(queuedStore.scanOpsFromStart().next(), /queue is full/)
  unblock()
  await Promise.all(started)
  await Promise.all(readers.map(reader => reader.return(undefined)))
  assert.equal((await collect(queuedStore)).length, 33, 'queue admission recovers after producers finish/cancel')
  console.log('catchup-concurrency-runtime: stale-cache reconnect, bounded paused consumer + scan admission, healthy reader, full replay, prune-sidecar race passed (5,003 operations)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
