/**
 * BRG-059: a new device (zero acks) must see ops that sit before the
 * `readRecentOps` tail. A large module share is thousands of older creates;
 * the 5k newest-only window delivered chrome without tables.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function op(id: string): ModulesSyncOp {
  return {
    opId: id,
    kind: 'entity.create',
    targetKind: 'entity',
    targetId: id,
    hlc: `0/${id}`,
    originDevice: 'host-dev',
    hopCount: 0,
    protocolVersion: 2,
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-catchup-'))
  try {
    const store = new BridgeStore(join(root, 'data'), 21)
    for (let i = 0; i < 12; i++) {
      store.appendOp(op(`op_${String(i).padStart(3, '0')}`))
    }

    const tail = await store.readRecentOps(5)
    assert(tail.length === 5, 'tail is newest 5')
    assert(tail[0]?.opId === 'op_007', 'tail starts at op_007')
    assert(!tail.some((o) => o.opId === 'op_000'), 'tail drops the oldest share snapshot')

    const fromStart: string[] = []
    for await (const row of store.scanOpsFromStart()) {
      fromStart.push(row.opId)
    }
    assert(fromStart.length === 12, 'full scan yields every durable op')
    assert(fromStart[0] === 'op_000', 'full scan is oldest-first')
    assert(fromStart.includes('op_000') && fromStart.includes('op_011'), 'full scan keeps both ends')

    assert(store.deviceAckCount('new-device') === 0, 'new originDevice has zero acks')
    store.markAcked('old-device', ['op_011'])
    store.flushAcksPersist()
    assert(store.deviceAckCount('old-device') === 1, 'acked device counts its bag')
    assert(store.deviceAckCount('new-device') === 0, 'other devices stay at zero')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

main().then(
  () => { console.log('ok: catchup-full-log') },
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
