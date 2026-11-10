import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, hashSessionToken, memberDeviceAckKey } from '../src/store.js'
import { TEAMSPACE_DEVICE_STALE_DAYS } from '../src/throughput.js'

for (const reactivate of [false, true]) {
  const dir = mkdtempSync(join(tmpdir(), 'prune-device-cost-'))
  let store: BridgeStore | undefined
  try {
    const now = Date.now(), old = now - (TEAMSPACE_DEVICE_STALE_DAYS + 40) * 86400000
    const ops = Array.from({ length: 4000 }, (_, n) => ({ opId: `op_${n}`, kind: 'entity.create', targetKind: 'entity', targetId: `entity_${n}`, hlc: `${old}/${n}`, originDevice: 'device', hopCount: 0, protocolVersion: 2 }))
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'team_cost', name: 'Audit', createdAt: 1 }))
    writeFileSync(join(dir, 'members.json'), JSON.stringify([{ memberId: 'member', email: 'audit@synthetic.invalid', displayName: 'Audit', role: 'admin', sessions: { device: hashSessionToken('synthetic-token') }, sessionLastSeen: { device: reactivate ? old : now }, createdAt: 1 }]))
    writeFileSync(join(dir, 'acks.json'), JSON.stringify({ [memberDeviceAckKey('member', 'device')]: Object.fromEntries(ops.map(op => [op.opId, old])) }))
    writeFileSync(join(dir, 'ops.jsonl'), ops.map(op => JSON.stringify(op)).join('\n') + '\n')
    store = new BridgeStore(dir, 21, null, null)
    const instrumented = store as unknown as { deviceEffectiveLastSeenMs: (...args: string[]) => number | null }
    const original = instrumented.deviceEffectiveLastSeenMs.bind(store)
    let scans = 0
    instrumented.deviceEffectiveLastSeenMs = (...args) => {
      scans++
      const result = original(...args)
      if (reactivate && scans === 1) setImmediate(() => store!.markAcked('device', ['op_0'], 'member'))
      return result
    }
    const started = performance.now()
    const removed = await store.pruneOps()
    assert.ok(scans <= 2, `Activity rescanned ${scans} times for one device and 4000 operations`)
    if (reactivate) {
      assert.equal(removed, 0, 'Reconnected device must invalidate the stale-device quorum')
      assert.equal(readFileSync(join(dir, 'ops.jsonl'), 'utf8').trim().split('\n').length, 4000)
    } else assert.equal(removed, 4000)
    console.log('PASS', { reactivateDuringScan: reactivate, operations: 4000, activityScans: scans, elapsedMs: Math.round(performance.now() - started) })
  } finally {
    store?.flushAcksPersist()
    rmSync(dir, { recursive: true, force: true })
  }
}
