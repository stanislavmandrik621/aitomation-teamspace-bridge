/**
 * BRG-061: count-only 500-op frames can exceed the 8 MiB WS ceiling.
 */
import assert from 'node:assert/strict'
import { splitOpsForWsFrames } from '../src/ops-frame-budget.js'

function op(id: string, pad: number): Record<string, unknown> {
  return { opId: id, kind: 'record.create', blob: 'x'.repeat(pad) }
}

const small = [op('a', 10), op('b', 10), op('c', 10)]
const byCount = splitOpsForWsFrames(small, { maxCount: 2, maxBytes: 1_000_000 })
assert.equal(byCount.frames.length, 2, 'count split')
assert.equal(byCount.frames[0]?.length, 2)
assert.equal(byCount.frames[1]?.length, 1)
assert.equal(byCount.oversized.length, 0)

const fat = [op('d', 80), op('e', 80), op('f', 80)]
const byBytes = splitOpsForWsFrames(fat, { maxCount: 50, maxBytes: 200 })
assert.ok(byBytes.frames.length >= 2, 'byte split makes more than one frame')
assert.equal(byBytes.oversized.length, 0)
for (const frame of byBytes.frames) {
  const n = JSON.stringify(frame).length
  assert.ok(n <= 200, `frame ${n} must stay under 200`)
}

const huge = [op('g', 500)]
const over = splitOpsForWsFrames(huge, { maxCount: 50, maxBytes: 100 })
assert.equal(over.frames.length, 0, 'single over-budget op is not a frame')
assert.equal(over.oversized.length, 1)

console.log('ok: ops-frame-budget')
