/**
 * BRG-070: a crash landing mid-`appendFileSync` can leave `ops.jsonl`
 * ending in a torn, newline-less partial line. Readers already skip an
 * unparseable line safely, but without a repair step the NEXT append
 * after restart would land directly after that torn tail with no
 * separator, merging the garbage with the brand-new op into one
 * unparseable line - silently losing the very first op written after
 * the crash, not just the torn one. `BridgeStore` must repair the
 * boundary (append exactly one missing `\n`) the first time this
 * process touches the log, before any new append can land.
 * Sibling: TCC-R1134-CHAT-023 (`chat-history-torn-write.ts`).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { BridgeStore } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

function op(id: string, extra?: Partial<ModulesSyncOp>): ModulesSyncOp {
  return {
    opId: id,
    kind: 'entity.create',
    targetKind: 'entity',
    targetId: extra?.targetId ?? id,
    hlc: extra?.hlc ?? `0/${id}`,
    originDevice: 'host-dev',
    hopCount: 0,
    protocolVersion: 2,
    ...extra,
  }
}

const dir = mkdtempSync(join(tmpdir(), 'ts-ops-torn-'))
try {
  mkdirSync(dir, { recursive: true })
  const opsPath = join(dir, 'ops.jsonl')

  // Simulate a crash mid-appendFileSync: a complete first line, then a
  // torn/truncated second line with NO trailing newline.
  const good = op('op_good1', { targetId: 'first-op-target' })
  const goodLine = JSON.stringify(good)
  const tornLine = '{"opId":"op_torn1","kind":"entity.create","targetId":"cut off mid-wri'
  writeFileSync(opsPath, `${goodLine}\n${tornLine}`, 'utf8')
  assert.equal(
    readFileSync(opsPath, 'utf8').endsWith('\n'),
    false,
    'fixture must start life without a trailing newline, simulating the crash',
  )

  // A fresh store instance (simulating the bridge restarting after the
  // crash) appends a new op to this log.
  const store = new BridgeStore(dir, 21, null)
  const afterCrash = op('op_after_crash', {
    targetId: 'op written right after the crash',
    hlc: '1/after-crash',
  })
  store.appendOp(afterCrash)

  // The repair must have inserted exactly one `\n` before the new append -
  // verify by reading the raw file and checking every line parses on its
  // own boundary (the torn line stays garbage/unparseable but ISOLATED,
  // and the new op is on its own clean line, not merged with it).
  const raw = readFileSync(opsPath, 'utf8')
  const lines = raw.split('\n').filter((l) => l.length > 0)
  assert.equal(lines.length, 3, 'must be exactly 3 lines: good, torn (now isolated), new')
  assert.deepEqual(JSON.parse(lines[0]!).opId, 'op_good1')
  // The second (torn) line must remain isolated garbage - NOT merged with
  // the third line's JSON.
  assert.ok(!lines[1]!.includes('op written right after the crash'))
  assert.ok(!lines[1]!.includes('op_after_crash'))
  const thirdParsed = JSON.parse(lines[2]!) as ModulesSyncOp
  assert.equal(thirdParsed.opId, 'op_after_crash')
  assert.equal(thirdParsed.targetId, 'op written right after the crash')

  // And the store's own read path must see good + new (proving the torn
  // bytes were skipped, not merged into the new op).
  const seen: string[] = []
  for await (const row of store.scanOpsFromStart()) {
    seen.push(row.opId)
  }
  assert.deepEqual(seen, ['op_good1', 'op_after_crash'])
  assert.ok(!seen.includes('op_torn1'), 'readers must not surface the torn bytes')

  // Second run: the file now properly ends with a newline, so appending
  // again must NOT need (or cause) any further repair - just a normal append.
  store.appendOp(op('op_healthy_second', { targetId: 'second op, file already healthy' }))
  const raw2 = readFileSync(opsPath, 'utf8')
  assert.equal(raw2.split('\n').filter((l) => l.length > 0).length, 4)

  // A brand-new store instance touching an ALREADY-HEALTHY ops file (ends
  // in `\n`) must be a complete no-op repair - no stray extra newline
  // inserted just because the process restarted again.
  const store2 = new BridgeStore(dir, 21, null)
  const before = readFileSync(opsPath, 'utf8')
  assert.ok(before.endsWith('\n'), 'healthy file must already be newline-terminated')
  store2.appendOp(op('op_fresh_process', { targetId: 'third op, fresh process instance' }))
  const after = readFileSync(opsPath, 'utf8')
  assert.ok(
    after.startsWith(before),
    'repair must be a strict no-op on an already-healthy (newline-terminated) file',
  )
  assert.ok(existsSync(opsPath))

  console.log('ops-log-torn-write: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
