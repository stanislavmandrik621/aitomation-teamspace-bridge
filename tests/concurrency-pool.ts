/**
 * TCC-R1133-WS-001 (twin TCC-R1133-WIN-001) - bounded concurrency pool.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapWithConcurrency } from '../src/concurrency-pool.js'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('mapWithConcurrency', () => {
  it('preserves result order regardless of completion order', async () => {
    const items = [30, 10, 20, 5, 25]
    const out = await mapWithConcurrency(items, 3, async (ms) => {
      await delay(ms)
      return ms
    })
    assert.deepEqual(out, items)
  })

  it('never runs more than `concurrency` mappers at once', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i)
    let active = 0
    let maxActive = 0
    const CONCURRENCY = 4
    await mapWithConcurrency(items, CONCURRENCY, async (i) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await delay(5)
      active -= 1
      return i
    })
    assert.ok(maxActive <= CONCURRENCY, `maxActive=${maxActive} must be <= ${CONCURRENCY}`)
    assert.equal(maxActive, CONCURRENCY, 'should actually saturate the pool, not under-run it')
  })

  it('propagates a mapper rejection without hanging', async () => {
    const items = [1, 2, 3, 4]
    await assert.rejects(
      mapWithConcurrency(items, 2, async (i) => {
        if (i === 3) throw new Error('boom')
        await delay(1)
        return i
      }),
      /boom/,
    )
  })

  it('handles empty input', async () => {
    const out = await mapWithConcurrency([], 4, async (i) => i)
    assert.deepEqual(out, [])
  })

  it('clamps concurrency to at least 1', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 0, async (i) => i * 2)
    assert.deepEqual(out, [2, 4, 6])
  })
})
