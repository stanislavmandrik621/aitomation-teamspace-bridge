/**
 * BRG-059: concurrent full-log catch-ups share one scan/decrypt pass
 * (TCC-R1133-WS-002 analog). A joiner after the first yield replays
 * `emitted` then attaches so it does not skip prefix ops and does not
 * decrypt the file again (BRG-069 late-joiner residual).
 *
 * Pin-break (do not leave this in the tree): make `sendFullCatchUpOps`
 * call a private unshared `scanOpsFromStart` again
 * (`store.scanOpsFromStartUnshared()`). Then this file EXIT 1. Restore
 * SHA. Expect green.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeStore } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf8')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function sliceNamedFunction(src: string, name: string): string {
  const needle = `function ${name}(`
  const start = src.indexOf(needle)
  assert.ok(start >= 0, `missing function ${name}(`)
  let i = start + needle.length - 1
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }
  while (i < src.length && src[i] !== '{') i += 1
  assert.equal(src[i], '{', `no body for ${name}`)
  depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed function ${name}`)
}

function sliceClassMethod(src: string, name: string): string {
  const re = new RegExp(`\\n  (?:private\\s+)?(?:async\\s+\\*?\\s*)?${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing method ${name}(`)
  const start = m.index + 1
  let i = m.index + m[0].length - 1
  assert.equal(src[i], '(')
  let paren = 0
  let angle = 0
  let bodyOpen = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') paren += 1
    else if (c === ')') paren -= 1
    else if (c === '<') angle += 1
    else if (c === '>' && angle > 0) angle -= 1
    else if (c === '{' && paren === 0 && angle === 0) {
      bodyOpen = i
      break
    }
  }
  assert.ok(bodyOpen >= 0, `no body for ${name}`)
  let depth = 0
  for (i = bodyOpen; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed method ${name}`)
}

function sendFullCatchUpUsesSharedScan(body: string): boolean {
  const live = sourceWithoutComments(body)
  if (!/\bstore\.scanOpsFromStart\s*\(/.test(live)) return false
  if (/\bscanOpsFromStartUnshared\s*\(/.test(live)) return false
  if (!/encoded\s*>\s*OPS_FRAME_MAX_BYTES/.test(live)) return false
  if (/\bsent\s*>=\s*FULL_OPS_CATCHUP_LIMIT/.test(live)) return false
  if (!/never stop because the log is large/.test(body)) return false
  return true
}

function scanOpsFromStartJoinsWhileLive(body: string): boolean {
  const live = sourceWithoutComments(body)
  if (!/\bif\s*\(\s*existing\s*\)/.test(live)) return false
  if (!/\bexisting\.emitted\.slice\s*\(/.test(live)) return false
  if (!/\bfullScanSharedJoins\s*\+=\s*1/.test(live)) return false
  if (/\bscanOpsFromStartUnshared\s*\(/.test(live)) return false
  if (/\bexisting\s*&&\s*!existing\.yielded/.test(live)) return false
  return true
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

function seedOps(store: BridgeStore, count: number): string[] {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `op_${String(i).padStart(3, '0')}`
    store.appendOp(op(id))
    ids.push(id)
  }
  return ids
}

async function consumeAll(store: BridgeStore): Promise<string[]> {
  const ids: string[] = []
  for await (const row of store.scanOpsFromStart()) {
    ids.push(row.opId)
  }
  return ids
}

let passed = 0
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

await t('source-scan: sendFullCatchUpOps uses shared scanOpsFromStart (BRG-059)', () => {
  const body = sliceNamedFunction(serverSrc, 'sendFullCatchUpOps')
  assert.equal(
    sendFullCatchUpUsesSharedScan(body),
    true,
    'sendFullCatchUpOps must iterate store.scanOpsFromStart(), not an unshared private scan',
  )
})

await t('source-scan: commenting the shared call fails this pin (TOOL-G31-066)', () => {
  const body = sliceNamedFunction(serverSrc, 'sendFullCatchUpOps')
  const commented = body.replace(
    'for await (const op of store.scanOpsFromStart())',
    '// for await (const op of store.scanOpsFromStart())',
  )
  assert.notEqual(commented, body, 'fixture must comment the live shared scan')
  assert.equal(
    sendFullCatchUpUsesSharedScan(commented),
    false,
    'a commented store.scanOpsFromStart() is not a live shared scan (TOOL-G31-066)',
  )
})

await t('source-scan: calling the private unshared scan fails this pin', () => {
  const body = sliceNamedFunction(serverSrc, 'sendFullCatchUpOps')
  const unshared = body.replace(
    'store.scanOpsFromStart()',
    'store.scanOpsFromStartUnshared()',
  )
  assert.notEqual(unshared, body, 'fixture must retarget sendFullCatchUpOps onto the unshared scan')
  assert.equal(
    sendFullCatchUpUsesSharedScan(unshared),
    false,
    'sendFullCatchUpOps calling scanOpsFromStartUnshared must fail this pin',
  )
})

await t('source-scan: scanOpsFromStart joins while the generation is live', () => {
  const body = sliceClassMethod(storeSrc, 'scanOpsFromStart')
  assert.equal(
    scanOpsFromStartJoinsWhileLive(body),
    true,
    'scanOpsFromStart must replay emitted and attach while a generation is live',
  )
  const commented = body.replace(
    'if (existing) {',
    '// if (existing) {',
  )
  assert.notEqual(commented, body, 'fixture must comment the live-generation join gate')
  assert.equal(
    scanOpsFromStartJoinsWhileLive(commented),
    false,
    'a commented join-while-live gate is not load-bearing (TOOL-G31-066)',
  )
})

await t('two concurrent consumers before first yield share one decrypt pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-059-share-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const expected = seedOps(store, 24)
    const before = store.fullScanShareStats()
    const [a, b] = await Promise.all([consumeAll(store), consumeAll(store)])
    const after = store.fullScanShareStats()
    assert.deepEqual(a, expected, 'first consumer is oldest-first full log')
    assert.deepEqual(b, expected, 'second consumer is oldest-first full log')
    assert.equal(
      after.realScans - before.realScans,
      1,
      `two consumers before first yield share ONE real scan (got ${after.realScans - before.realScans})`,
    )
    assert.ok(
      after.sharedJoins - before.sharedJoins >= 1,
      `the second consumer must attach (got ${after.sharedJoins - before.sharedJoins} shared joins)`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('a joiner after first yield replays prefix and does not decrypt again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-059-late-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const expected = seedOps(store, 20)
    const genA = store.scanOpsFromStart()
    const first = await genA.next()
    assert.equal(first.done, false, 'first yield must produce an op')
    assert.equal(first.value?.opId, expected[0], 'first yield is the oldest op')
    const mid = store.fullScanShareStats()
    const late = await consumeAll(store)
    const after = store.fullScanShareStats()
    assert.deepEqual(late, expected, 'late joiner must replay the full oldest-first log (not a suffix)')
    assert.equal(
      after.realScans - mid.realScans,
      0,
      `late joiner after first yield must not start a new decrypt (got ${after.realScans - mid.realScans})`,
    )
    assert.ok(
      after.sharedJoins - mid.sharedJoins >= 1,
      `late joiner must attach (got ${after.sharedJoins - mid.sharedJoins} shared joins)`,
    )
    const restA: string[] = []
    for await (const row of genA) restA.push(row.opId)
    assert.deepEqual([first.value?.opId, ...restA], expected, 'first consumer still sees every op')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`brg-059-shared-full-scan: ${passed}/6 ok`)
