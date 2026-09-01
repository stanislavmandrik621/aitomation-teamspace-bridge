/**
 * G16 unused-capacity flip after G1/G2. Cite BRG-066 BRG-067 BRG-069.
 * The bridge is one process, one event loop, one team, a file store.
 * G1 serializes a fan-out once (BRG-066). G2 appends a batch once
 * (BRG-067). BRG-069 group: no workers, no cluster. This pin only
 * forbids those. Do not mint a twin Deep ID.
 *
 * Walk every .ts file under src/ (not tests, not node_modules).
 * After `sourceWithoutComments` (TOOL-G31-066), a live import of
 * worker_threads / node:worker_threads, a live `new Worker(`,
 * or a live import of cluster / node:cluster fails naming
 * file:line. A `// import { Worker }` comment stays green.
 *
 * Pin-break (do not leave this in the tree): add
 * `import { Worker } from 'node:worker_threads'` to
 * `src/ws-frame-send.ts`. Then this file EXIT 1. Restore SHA.
 * Expect green.
 *
 * Parent registers this file on the bridge `test` script.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  serializeBridgeFrame,
  sendSerializedFrame,
  sendBridgeFrame,
  utf8FrameByteLength,
} from '../src/ws-frame-send.js'
import { mapWithConcurrency, AsyncSemaphore, TrySemaphore } from '../src/concurrency-pool.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(root, 'src')

const SKIP_DIRS = new Set(['node_modules', 'dist', 'tests', '.git'])
const SRC_TS_FLOOR = 40
const MUST_WALK = [
  'src/ws-frame-send.ts',
  'src/store.ts',
  'src/server.ts',
  'src/concurrency-pool.ts',
] as const

const WORKER_IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"](?:node:)?worker_threads['"]/
const CLUSTER_IMPORT_RE = /(?:from|import|require)\s*\(?\s*['"](?:node:)?cluster['"]/
const NEW_WORKER_RE = /\bnew\s+Worker\s*\(/
const NEW_WORKER_MEMBER_RE = /\bnew\s+[A-Za-z_$][\w$]*\.Worker\s*\(/
const CLUSTER_FORK_RE = /\bcluster\.fork\s*\(/

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function isForbiddenLive(src: string): boolean {
  return (
    WORKER_IMPORT_RE.test(src)
    || CLUSTER_IMPORT_RE.test(src)
    || NEW_WORKER_RE.test(src)
    || NEW_WORKER_MEMBER_RE.test(src)
    || CLUSTER_FORK_RE.test(src)
  )
}

function relPosix(abs: string): string {
  return relative(root, abs).split(sep).join('/')
}

function walkSrcTs(dir: string, acc: string[] = []): string[] {
  const ents = readdirSync(dir, { withFileTypes: true })
  for (const ent of ents) {
    if (SKIP_DIRS.has(ent.name)) continue
    const p = join(dir, ent.name)
    if (ent.isDirectory()) {
      walkSrcTs(p, acc)
      continue
    }
    if (ent.isFile() && ent.name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

function liveHitsInFile(rel: string, text: string): string[] {
  const stripped = sourceWithoutComments(text)
  if (!isForbiddenLive(stripped)) return []
  const lines = text.split('\n')
  const hits: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (isForbiddenLive(sourceWithoutComments(lines[i] ?? ''))) {
      hits.push(`${rel}:${i + 1}`)
    }
  }
  if (hits.length === 0) hits.push(`${rel}:1`)
  return hits
}

function collectOffenders(files: string[]): string[] {
  const hits: string[] = []
  for (const abs of files) {
    hits.push(...liveHitsInFile(relPosix(abs), readFileSync(abs, 'utf8')))
  }
  return hits
}

let passed = 0
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

await (async () => {
try {

await t('walk covers src ts (floor + G1/G2 leaves, no tests)', () => {
  const files = walkSrcTs(srcRoot)
  const rels = files.map(relPosix)
  assert.ok(
    rels.length >= SRC_TS_FLOOR,
    `walk found ${rels.length} src ts files, floor is ${SRC_TS_FLOOR}`,
  )
  for (const rel of MUST_WALK) {
    assert.ok(rels.includes(rel), `walk missed ${rel}`)
  }
  for (const rel of rels) {
    assert.equal(rel.startsWith('src/'), true, `walk left src: ${rel}`)
    assert.equal(rel.includes('/tests/'), false, `walk hit tests: ${rel}`)
    assert.equal(rel.includes('node_modules/'), false, `walk hit node_modules: ${rel}`)
  }
})

await t('commented Worker import stays green (TOOL-G31-066)', () => {
  const commented = [
    "  // import { Worker }",
    "  // import { Worker } from 'node:worker_threads'",
    "  const x = 1 // import { Worker } from 'node:worker_threads'",
    "  /* import { Worker } from 'node:worker_threads' */",
    "  // import cluster from 'node:cluster'",
    '  // new Worker(url)',
  ].join('\n')
  assert.equal(
    isForbiddenLive(sourceWithoutComments(commented)),
    false,
    'a // import { Worker } comment must stay green',
  )
  assert.match(commented, /import \{ Worker \}/)
  assert.deepEqual(liveHitsInFile('src/ws-frame-send.ts', commented), [])
})

await t('live Worker / cluster / new Worker are detected', () => {
  const workerImport = "import { Worker } from 'node:worker_threads'\n"
  const workerBare = "import { Worker } from 'worker_threads'\n"
  const workerRequire = "const { Worker } = require('node:worker_threads')\n"
  const workerDynamic = "const wt = await import('node:worker_threads')\n"
  const clusterImport = "import cluster from 'node:cluster'\n"
  const clusterBare = "import cluster from 'cluster'\n"
  const constructed = 'const w = new Worker(url)\n'
  const constructedMember = 'const w = new wt.Worker(url)\n'
  const clusterFork = 'cluster.fork()\n'
  assert.equal(isForbiddenLive(sourceWithoutComments(workerImport)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(workerBare)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(workerRequire)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(workerDynamic)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(clusterImport)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(clusterBare)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(constructed)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(constructedMember)), true)
  assert.equal(isForbiddenLive(sourceWithoutComments(clusterFork)), true)
  assert.deepEqual(liveHitsInFile('src/ws-frame-send.ts', workerImport), [
    'src/ws-frame-send.ts:1',
  ])
})

await t('concurrency-pool worker() is not new Worker(', () => {
  const text = readFileSync(join(srcRoot, 'concurrency-pool.ts'), 'utf8')
  assert.match(sourceWithoutComments(text), /async function worker\s*\(/)
  assert.equal(
    isForbiddenLive(sourceWithoutComments(text)),
    false,
    'in-process pool worker() must not trip this pin',
  )
  assert.deepEqual(liveHitsInFile('src/concurrency-pool.ts', text), [])
})

await t('src has no live workers or cluster', () => {
  const offenders = collectOffenders(walkSrcTs(srcRoot))
  assert.equal(
    offenders.length,
    0,
    'workers/cluster in bridge src:\n' + offenders.map((o) => `  - ${o}`).join('\n'),
  )
})

await t('pin-break fixture: live Worker import on ws-frame-send names file:line', () => {
  const helper = readFileSync(join(srcRoot, 'ws-frame-send.ts'), 'utf8')
  const injected = "import { Worker } from 'node:worker_threads'\n" + helper
  const hits = liveHitsInFile('src/ws-frame-send.ts', injected)
  assert.ok(
    hits.includes('src/ws-frame-send.ts:1'),
    `expected src/ws-frame-send.ts:1, got ${hits.join(', ') || '(none)'}`,
  )
  const commented = "// import { Worker } from 'node:worker_threads'\n" + helper
  assert.deepEqual(
    liveHitsInFile('src/ws-frame-send.ts', commented),
    [],
    'commenting the pin-break import must stay green',
  )
})

await t('serializeBridgeFrame fail-closes a non-string stringify (undefined/function)', () => {
  assert.equal(serializeBridgeFrame({ type: 'pong' }), '{"type":"pong"}')
  assert.throws(() => serializeBridgeFrame(undefined), /not JSON-serializable/)
  assert.throws(() => serializeBridgeFrame(() => 1), /not JSON-serializable/)
  assert.throws(() => serializeBridgeFrame(Symbol('frame')), /not JSON-serializable/)
  assert.throws(() => serializeBridgeFrame(1n), /not JSON-serializable/)
  const circular: { self?: unknown } = {}
  circular.self = circular
  assert.throws(() => serializeBridgeFrame(circular), /not JSON-serializable/)
  assert.throws(() => serializeBridgeFrame({ type: 'pong', hop: Number.NaN }), /not JSON-serializable/)
  assert.throws(
    () => serializeBridgeFrame({ type: 'pong', remaining: Number.POSITIVE_INFINITY }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({ nested: { n: Number.NEGATIVE_INFINITY } }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({ boxed: Object(Number.NaN) }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({ constructor: Number.NaN }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({
      toJSON() {
        return { hop: Number.NaN }
      },
    }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({ when: new Date(Number.NaN) }),
    /not JSON-serializable/,
  )
  assert.throws(
    () => serializeBridgeFrame({
      toJSON() {
        return new Date(Number.NaN)
      },
    }),
    /not JSON-serializable/,
  )
  const protoGet: Record<string, unknown> = {}
  Object.defineProperty(protoGet, '__proto__', {
    get() {
      return { hop: Number.NaN }
    },
    enumerable: true,
    configurable: true,
  })
  assert.throws(() => serializeBridgeFrame(protoGet), /not JSON-serializable/)
  assert.equal(serializeBridgeFrame({ type: 'pong', hop: 0 }), '{"type":"pong","hop":0}')
  assert.equal(
    serializeBridgeFrame({ when: new Date('2026-08-19T00:00:00.000Z') }),
    '{"when":"2026-08-19T00:00:00.000Z"}',
  )
  const deep: unknown[] = []
  let cur: unknown[] = deep
  for (let d = 0; d < 80; d++) {
    const next: unknown[] = []
    cur.push(next)
    cur = next
  }
  assert.throws(() => serializeBridgeFrame(deep), /not JSON-serializable/)
  const orig = JSON.stringify
  JSON.stringify = (() => 42) as unknown as typeof JSON.stringify
  try {
    assert.throws(() => serializeBridgeFrame({ type: 'pong' }), /not JSON-serializable/)
  } finally {
    JSON.stringify = orig
  }
})

await t('sendSerializedFrame refuses non-string text and non-finite backpressure', () => {
  const sent: string[] = []
  const ws = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: 0,
    send: (data: string) => {
      sent.push(data)
    },
  }
  assert.equal(sendSerializedFrame(ws, '{"ok":true}', 1024), true)
  assert.equal(sent.length, 1)
  assert.equal(
    sendSerializedFrame(ws, undefined as unknown as string, 1024),
    false,
  )
  assert.equal(sendSerializedFrame(ws, '{"ok":true}', Number.NaN), false)
  assert.equal(sendSerializedFrame(ws, '{"ok":true}', Number.POSITIVE_INFINITY), false)
  assert.equal(sendSerializedFrame(ws, '{"ok":true}', -1), false)
  assert.equal(sent.length, 1, 'refuse paths must not send')

  // Twin of NaN ceiling: NaN / Infinity / negative bufferedAmount must
  // not disable the check (`NaN > ceiling` is always false).
  const poisoned = {
    readyState: 1,
    OPEN: 1,
    bufferedAmount: Number.NaN,
    send: (data: string) => {
      sent.push(data)
    },
  }
  assert.equal(sendSerializedFrame(poisoned, '{"ok":true}', 1024), false)
  assert.equal(
    sendSerializedFrame({ ...poisoned, bufferedAmount: Number.POSITIVE_INFINITY }, '{"ok":true}', 1024),
    false,
  )
  assert.equal(
    sendSerializedFrame({ ...poisoned, bufferedAmount: -1 }, '{"ok":true}', 1024),
    false,
  )
  assert.equal(
    sendSerializedFrame({ ...poisoned, OPEN: Number.NaN, bufferedAmount: 0 }, '{"ok":true}', 1024),
    false,
  )
  assert.equal(
    sendSerializedFrame(
      { ...poisoned, bufferedAmount: '999' as unknown as number },
      '{"ok":true}',
      1024,
    ),
    false,
  )
  assert.equal(
    sendSerializedFrame(null as unknown as typeof poisoned, '{"ok":true}', 1024),
    false,
  )
  assert.equal(sent.length, 1, 'invalid bufferedAmount / OPEN / socket must not send')

  // High-concurrency fan-out / BRG-061: UTF-8 ceiling, never text.length.
  // 20 CJK chars = 20 UTF-16 units, 60 UTF-8 bytes.
  const cjk = '中'.repeat(20)
  assert.equal(cjk.length, 20)
  assert.equal(utf8FrameByteLength(cjk), 60)
  assert.ok(cjk.length < 40)
  assert.ok(utf8FrameByteLength(cjk) > 40)
  assert.equal(sendSerializedFrame(ws, cjk, 1024, 40), false)
  assert.equal(sendSerializedFrame(ws, '{"ok":true}', 1024, Number.NaN), false)
  assert.equal(sendSerializedFrame(ws, 'ascii-ok', 1024, 40), true)
  assert.equal(sent[sent.length - 1], 'ascii-ok')
  const origByteLen = Buffer.byteLength
  let walks = 0
  Buffer.byteLength = ((value: string | NodeJS.ArrayBufferView, enc?: BufferEncoding) => {
    walks += 1
    return origByteLen.call(Buffer, value, enc)
  }) as typeof Buffer.byteLength
  try {
    const same = '{"fan":true}'
    for (let i = 0; i < 50; i++) {
      assert.equal(sendSerializedFrame(ws, same, 1024), true)
    }
    assert.equal(walks, 1, 'same-string fan-out must walk UTF-8 once, not once per peer')
  } finally {
    Buffer.byteLength = origByteLen
  }
  const helper = readFileSync(join(srcRoot, 'ws-frame-send.ts'), 'utf8')
  assert.match(helper, /Buffer\.byteLength\(\s*text\s*,\s*['"]utf8['"]/)
  assert.doesNotMatch(
    helper,
    /utf8FrameByteLength[\s\S]{0,80}text\.length/,
    'frame ceiling must not use UTF-16 text.length',
  )
})

await t('sendBridgeFrame is the one-socket path: stringify once, no JSON.stringify in its body', () => {
  const helper = readFileSync(join(srcRoot, 'ws-frame-send.ts'), 'utf8')
  assert.match(helper, /export function sendBridgeFrame\s*\(/)
  const start = helper.indexOf('export function sendBridgeFrame')
  const next = helper.indexOf('\nexport ', start + 1)
  const body = next >= 0 ? helper.slice(start, next) : helper.slice(start)
  assert.doesNotMatch(body, /JSON\.stringify/)
  assert.match(body, /serializeBridgeFrame/)
  assert.match(body, /sendSerializedFrame/)

  const orig = JSON.stringify
  let count = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    count += 1
    return orig.apply(JSON, args)
  }) as typeof JSON.stringify
  try {
    const sent: string[] = []
    const ws = {
      readyState: 1,
      OPEN: 1,
      bufferedAmount: 0,
      send: (data: string) => {
        sent.push(data)
      },
    }
    assert.equal(
      sendBridgeFrame(ws, { type: 'error', message: 'Bridge is at capacity - try again later' }, 1024),
      true,
    )
    assert.equal(count, 1, 'one-socket send must stringify exactly once')
    assert.equal(sent.length, 1)
    assert.equal(sendBridgeFrame(ws, undefined, 1024), false)
    assert.equal(
      sendBridgeFrame(ws, { type: 'error', hop: Number.NaN }, 1024),
      false,
      'NaN in a one-socket frame must not send',
    )
    assert.equal(
      sendBridgeFrame(ws, { type: 'error', when: new Date(Number.NaN) }, 1024),
      false,
      'Invalid Date in a one-socket frame must not send',
    )
    assert.equal(sent.length, 1, 'NaN frame must not send')
  } finally {
    JSON.stringify = orig
  }
})

await t('mapWithConcurrency Infinity/NaN stays bounded (not unbounded Promise.all)', async () => {
  const items = Array.from({ length: 8 }, (_, i) => i)
  let active = 0
  let maxActive = 0
  await mapWithConcurrency(items, Number.POSITIVE_INFINITY, async (i) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 5))
    active -= 1
    return i
  })
  assert.equal(maxActive, 1, `Infinity concurrency must fail-closed to 1, got ${maxActive}`)

  maxActive = 0
  active = 0
  await mapWithConcurrency(items, Number.NaN, async (i) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 1))
    active -= 1
    return i
  })
  assert.equal(maxActive, 1, `NaN concurrency must fail-closed to 1, got ${maxActive}`)

  maxActive = 0
  active = 0
  await mapWithConcurrency(items, Number.NEGATIVE_INFINITY, async (i) => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((r) => setTimeout(r, 1))
    active -= 1
    return i
  })
  assert.equal(maxActive, 1, `-Infinity concurrency must fail-closed to 1, got ${maxActive}`)
})

await t('AsyncSemaphore extra release does not raise the cap; Infinity permits clamp to 1', async () => {
  const sem = new AsyncSemaphore(1)
  sem.release()
  sem.release()
  let inflight = 0
  let peak = 0
  await Promise.all(
    Array.from({ length: 4 }, () =>
      sem.run(async () => {
        inflight += 1
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 8))
        inflight -= 1
      }),
    ),
  )
  assert.equal(peak, 1, `extra release must not raise cap, peak=${peak}`)

  const inf = new AsyncSemaphore(Number.POSITIVE_INFINITY)
  let infPeak = 0
  let infIn = 0
  await Promise.all(
    Array.from({ length: 4 }, () =>
      inf.run(async () => {
        infIn += 1
        infPeak = Math.max(infPeak, infIn)
        await new Promise((r) => setTimeout(r, 5))
        infIn -= 1
      }),
    ),
  )
  assert.equal(infPeak, 1, `Infinity permits must clamp to 1, peak=${infPeak}`)
})

await t('TrySemaphore Infinity/NaN ceiling is 1 (capacity refuse still works)', () => {
  const inf = new TrySemaphore(Number.POSITIVE_INFINITY)
  assert.equal(inf.tryAcquire(), true)
  assert.equal(inf.tryAcquire(), false, 'Infinity max must not disable refuse')
  inf.release()
  const nan = new TrySemaphore(Number.NaN)
  assert.equal(nan.tryAcquire(), true)
  assert.equal(nan.tryAcquire(), false)

  const extra = new TrySemaphore(1)
  extra.release()
  extra.release()
  assert.equal(extra.tryAcquire(), true)
  assert.equal(extra.tryAcquire(), false, 'extra release must not raise cap')
})

await t('mapWithConcurrency yields between items so leftover decrypt cannot starve a timer', async () => {
  const items = Array.from({ length: 8 }, (_, i) => i)
  let mid = 0
  let sawImmediateDuring = false
  setImmediate(() => {
    sawImmediateDuring = mid > 0 && mid < items.length
  })
  await mapWithConcurrency(items, 1, async (i) => {
    mid += 1
    return i
  })
  await new Promise<void>((resolve) => {
    setImmediate(resolve)
  })
  assert.equal(
    sawImmediateDuring,
    true,
    'a queued setImmediate must run between leftover items (heartbeat is the same class)',
  )
})

await t('mapWithConcurrency stops leftover claims after a mapper throw', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i)
  const started: number[] = []
  await assert.rejects(
    mapWithConcurrency(items, 2, async (i) => {
      started.push(i)
      if (i === 1) throw new Error('boom')
      await new Promise((r) => setTimeout(r, 15))
      return i
    }),
    /boom/,
  )
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(
    started.length <= 4,
    `leftover workers must stop claiming after throw, started=${started.join(',')}`,
  )
  assert.ok(started.includes(1), 'the throwing item must have started')
})

await t('mapWithConcurrency two throws do not leave an unhandled rejection', async () => {
  const items = [0, 1, 2, 3]
  let unhandled = 0
  const onUnhandled = (): void => {
    unhandled += 1
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(
      mapWithConcurrency(items, 2, async (i) => {
        if (i < 2) throw new Error(`boom-${i}`)
        return i
      }),
      /boom-/,
    )
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    assert.equal(unhandled, 0, 'a sibling mapper throw must not be unhandled')
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

if (passed !== 15) {
    console.error(`g16-no-workers: expected 15, got ${passed}`)
    process.exit(1)
  }
  console.log(`g16-no-workers: ${passed}/15 ok`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
})()
