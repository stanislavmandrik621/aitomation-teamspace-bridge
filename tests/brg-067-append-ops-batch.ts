/**
 * BRG-067: a durable write inside a per-item loop over an accepted batch
 * is one syscall per batch. `appendOps` joins the lines and calls
 * `appendFileSync` once. `appendOp` is a thin wrap (`appendOps([op])`).
 * Seen opIds stay skipped per item (TCC-R1150-BRG-002). Empty input is
 * a no-op (no repair, no write). G9 torn-tail repair is left as-is and
 * is called before every real disk write (same-process torn tail too).
 * All-seal / stringify skip with nothing written throws
 * `OpsPersistSkippedError` so void handleOps cannot ACK a skip.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { BridgeStore, OpsPersistSkippedError } from '../src/store.js'
import { BLOB_ENC_MAGIC, resolveAtRestKeyFromEnv } from '../src/at-rest.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf8')

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

function jsonlRecords(path: string): string[] {
  const raw = readFileSync(path, 'utf8')
  assert.ok(raw.endsWith('\n'), `${path} must be newline-terminated`)
  return raw.split('\n').filter((line) => line.length > 0)
}

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

function sliceFunction(src: string, name: string): string {
  const re = new RegExp(`\\nfunction ${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing function ${name}(`)
  const start = m.index + 1
  let i = start
  while (i < src.length && src[i] !== '{') i += 1
  assert.equal(src[i], '{', `no body for ${name}`)
  let depth = 0
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

t('source-scan: prune recovers leftover pending only when not already pruning', () => {
  const body = sliceClassMethod(storeSrc, 'pruneOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  const guard = live.search(/if\s*\(\s*this\.opsPruning\s*\)\s*return\s+0/)
  const recover = live.search(/this\.recoverPendingOps\s*\(/)
  assert.ok(guard >= 0, 'pruneOps must refuse a nested prune')
  assert.ok(recover >= 0, 'pruneOps must recover leftover pending')
  assert.ok(guard < recover, 'recover must not run while another prune owns the sidecar')
})

t('source-scan: handleOps persists via one appendOps, not per-item appendOp', () => {
  const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')
  const body = sliceFunction(serverSrc, 'handleOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /store\.appendOps\s*\(/)
  assert.doesNotMatch(live, /store\.appendOp\s*\(/)
  assert.equal((live.match(/store\.appendOps\s*\(/g) ?? []).length, 1)
})

t('source-scan: appendOp is a thin wrap through appendOps', () => {
  const body = sliceClassMethod(storeSrc, 'appendOp')
  assert.match(body, /this\.appendOps\(\s*\[\s*op\s*\]\s*\)/)
  assert.doesNotMatch(body, /appendFileSync/)
  assert.doesNotMatch(body, /repairTornOpsTail/)
  assert.doesNotMatch(body, /rememberOpId/)
})

function forLoopBodies(src: string): string[] {
  const out: string[] = []
  const re = /\bfor\s*\(/g
  for (const m of src.matchAll(re)) {
    const openParen = (m.index ?? 0) + m[0].length - 1
    let depth = 0
    let closeParen = -1
    for (let i = openParen; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')') {
        depth--
        if (depth === 0) {
          closeParen = i
          break
        }
      }
    }
    if (closeParen < 0) continue
    let j = closeParen + 1
    while (j < src.length && /\s/.test(src[j]!)) j++
    if (src[j] === '{') {
      let brace = 0
      for (let i = j; i < src.length; i++) {
        if (src[i] === '{') brace++
        else if (src[i] === '}') {
          brace--
          if (brace === 0) {
            out.push(src.slice(j + 1, i))
            break
          }
        }
      }
      continue
    }
    const end = src.indexOf('\n', j)
    out.push(src.slice(j, end < 0 ? src.length : end))
  }
  return out
}

function appendOpsIsOneSyscall(body: string): boolean {
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  const writes = live.match(/appendFileSync\s*\(/g) ?? []
  if (writes.length !== 1) return false
  if (!/\.join\s*\(/.test(live)) return false
  return forLoopBodies(live).every((loop) => !/appendFileSync\s*\(/.test(loop))
}

t('source-scan: blobCount is O(1) hex count (no readdir)', () => {
  const body = sliceClassMethod(storeSrc, 'blobCount')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /this\.blobDisk\.count\s*\(/)
  assert.doesNotMatch(live, /readdirSync/)
  const walked = body.replace(
    'return this.blobDisk.count()',
    'return readdirSync(this.blobsDir).filter((f) => /^[a-f0-9]{64}$/.test(f)).length',
  )
  const walkedLive = walked
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(walkedLive, /readdirSync/, 'pin-break fixture must walk the folder')
})

t('source-scan: putBlobFromStream encrypts via encryptBlobFile (no full-file encrypt)', () => {
  const body = sliceClassMethod(storeSrc, 'putBlobFromStream')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /encryptBlobFile\s*\(/)
  assert.doesNotMatch(live, /encryptBlobBody\s*\(/)
  assert.doesNotMatch(live, /readFileSync\(\s*tmp\s*\)/)
  assert.match(live, /renameSync\(\s*tmp\s*,\s*dest\s*\)/)
  assert.match(live, /addAfterNewPut\(\s*toWrite\.length\s*\)/)
  assert.match(live, /randomBytes\(\s*8\s*\)/, 'same-sha overlap must not share dest.pid.part')
  assert.match(live, /\$\{dest\}\.\$\{process\.pid\}/)
  const pipelineIdx = live.search(/await\s+pipeline\s*\(/)
  assert.ok(pipelineIdx >= 0, 'putBlobFromStream must pipeline to tmp')
  const afterPipe = live.slice(pipelineIdx)
  const existsAfter = afterPipe.search(/existsSync\(\s*dest\s*\)/)
  const addAfter = afterPipe.search(/addAfterNewPut/)
  assert.ok(existsAfter >= 0, 'post-pipeline same-sha skip must existSync(dest)')
  assert.ok(addAfter >= 0 && existsAfter < addAfter, 'same-sha skip must run before increment')
})

t('source-scan: appendOps caps identity via capId and refuses a throwing stringify', () => {
  const body = sliceClassMethod(storeSrc, 'appendOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /capId\(\s*op\.opId/)
  assert.doesNotMatch(live, /op\.opId\.slice/)
  assert.match(live, /capStr\(\s*op\.originMemberName/)
  assert.match(live, /JSON\.stringify\(\s*toWrite\s*\)/)
  assert.match(live, /catch\s*\{/)
  assert.match(live, /skippedSeal\s*\+=\s*1/)
  const tryIdx = live.search(/try\s*\{/)
  const catchIdx = live.search(/catch\s*\{/)
  assert.ok(tryIdx >= 0 && catchIdx > tryIdx, 'appendOps must try/catch per op')
  const tryBlock = live.slice(tryIdx, catchIdx)
  assert.match(tryBlock, /JSON\.stringify\(\s*toWrite\s*\)/)
  assert.match(tryBlock, /encryptOpsLine/, 'at-rest seal must sit in the same try as stringify')
})

t('source-scan: all-seal skip throws OpsPersistSkippedError (BRG-067)', () => {
  const body = sliceClassMethod(storeSrc, 'appendOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  const emptyIdx = live.search(/accepted\.length\s*===\s*0/)
  assert.ok(emptyIdx >= 0, 'must check accepted.length === 0')
  const afterEmpty = live.slice(emptyIdx, emptyIdx + 320)
  assert.match(afterEmpty, /skippedSeal\s*>\s*0/)
  assert.match(afterEmpty, /throw new OpsPersistSkippedError\s*\(/)
  const silent = body.replace(
    'if (skippedSeal > 0) {\n        throw new OpsPersistSkippedError()\n      }',
    'if (skippedSeal > 0) {\n        return\n      }',
  )
  const silentLive = silent
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  const silentAfter = silentLive.slice(
    silentLive.search(/accepted\.length\s*===\s*0/),
    silentLive.search(/accepted\.length\s*===\s*0/) + 320,
  )
  assert.doesNotMatch(
    silentAfter,
    /throw new OpsPersistSkippedError\s*\(/,
    'pin-break: silent return after all-seal skip must fail this pin',
  )
})

t('source-scan: appendFileSync is outside the per-op try (disk throw propagates)', () => {
  const body = sliceClassMethod(storeSrc, 'appendOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.equal((live.match(/try\s*\{/g) ?? []).length, 1, 'only the per-op stringify/seal try')
  const catchIdx = live.search(/catch\s*\{/)
  const writeIdx = live.search(/appendFileSync\s*\(/)
  assert.ok(catchIdx >= 0 && writeIdx > catchIdx, 'appendFileSync must sit after the per-op catch')
})

t('source-scan: flushPendingOpsOntoLog merges via recoverPendingOps', () => {
  const body = sliceClassMethod(storeSrc, 'flushPendingOpsOntoLog')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /this\.recoverPendingOps\s*\(/)
  assert.doesNotMatch(
    live,
    /appendFileSync\(\s*this\.opsPath/,
    'flush must not raw-append the sidecar (unlink-fail would duplicate)',
  )
})

t('source-scan: repairTornOpsTail always probes before the next append', () => {
  const body = sliceClassMethod(storeSrc, 'repairTornOpsTail')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /this\.repairTornTailAt\(\s*this\.opsPath\s*\)/)
  assert.doesNotMatch(live, /opsTailChecked/)
  assert.doesNotMatch(live, /if\s*\(\s*this\.opsTailChecked/)
})

t('source-scan: prune stringify/encrypt fail keeps the original line', () => {
  const body = sliceClassMethod(storeSrc, 'pruneOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(live, /let keepLine = line/)
  const keepTry = live.search(/keepLine = this\.atRest/)
  assert.ok(keepTry >= 0, 'prune must re-seal kept lines')
  const after = live.slice(keepTry, keepTry + 400)
  assert.match(after, /catch\s*\{/)
  assert.match(after, /keepLine = line/)
  assert.doesNotMatch(after, /removed\+\+/)
})

t('source-scan: pruneOps does not decrypt kept lines a second time', () => {
  const body = sliceClassMethod(storeSrc, 'pruneOps')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.equal(
    (live.match(/decryptOpsLine\s*\(/g) ?? []).length,
    1,
    'pruneOps must decrypt each live line once (keepRow), not again after rewrite',
  )
  assert.match(live, /keepRow\s*\(/)
  assert.match(live, /keptIds\.add\(\s*row\.opId\s*\)/)
})

t('source-scan: appendOps has exactly one appendFileSync', () => {
  // PIN-BREAK: put appendFileSync back inside `for (const row of accepted)`.
  // Counting call sites is not one-syscall (BRG-067). The write must join
  // the batch and sit outside every per-item loop.
  const body = sliceClassMethod(storeSrc, 'appendOps')
  assert.equal(appendOpsIsOneSyscall(body), true, 'appendOps must join the batch into one write outside every for-loop')
  const live = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  const repairIdx = live.search(/this\.repairTornOpsTail\s*\(\s*\)/)
  const writeIdx = live.search(/appendFileSync\s*\(/)
  assert.ok(repairIdx >= 0, 'appendOps must call repairTornOpsTail')
  assert.ok(repairIdx < writeIdx, 'repairTornOpsTail must run before the write')
  const afterWrite = live.slice(writeIdx)
  assert.match(afterWrite, /this\.rememberOpId/, 'remember only after the write')
  assert.match(
    live,
    /opsPruning \? this\.opsPendingPath : this\.opsPath/,
    'mid-prune batches must write the sidecar, not only an in-memory buffer (G10)',
  )
  const looped = body.replace(
    'appendFileSync(dest, accepted.map((row) => row.line).join(\'\'), \'utf8\')',
    'for (const row of accepted) appendFileSync(dest, row.line, \'utf8\')',
  )
  assert.equal(
    appendOpsIsOneSyscall(looped),
    false,
    'a per-item appendFileSync loop must fail this pin (BRG-067)',
  )
})

function withStore(fn: (store: BridgeStore, opsPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'brg-067-'))
  try {
    mkdirSync(dir, { recursive: true })
    fn(new BridgeStore(dir, 21, null), join(dir, 'ops.jsonl'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

t('empty appendOps([]) does not write', () => {
  withStore((store, opsPath) => {
    assert.equal(existsSync(opsPath), false)
    store.appendOps([])
    assert.equal(existsSync(opsPath), false, 'empty batch must not create ops.jsonl')
  })
})

t('empty appendOps([]) does not repair a torn tail', () => {
  withStore((store, opsPath) => {
    const torn = '{"opId":"op_torn","kind":"entity.create","targetId":"cut off'
    writeFileSync(opsPath, torn, 'utf8')
    const before = readFileSync(opsPath, 'utf8')
    store.appendOps([])
    assert.equal(readFileSync(opsPath, 'utf8'), before)
  })
})

t('3-op batch is one write of three newline-terminated records', () => {
  withStore((store, opsPath) => {
    store.appendOps([op('op_a'), op('op_b'), op('op_c')])
    const records = jsonlRecords(opsPath)
    assert.equal(records.length, 3)
    assert.deepEqual(
      records.map((line) => (JSON.parse(line) as ModulesSyncOp).opId),
      ['op_a', 'op_b', 'op_c'],
    )
  })
})

t('appendOp routes through appendOps', () => {
  withStore((store, opsPath) => {
    let routed = 0
    const orig = store.appendOps.bind(store)
    store.appendOps = (ops: ModulesSyncOp[]) => {
      routed += 1
      orig(ops)
    }
    store.appendOp(op('op_via_wrap'))
    assert.equal(routed, 1)
    const records = jsonlRecords(opsPath)
    assert.equal(records.length, 1)
    assert.equal((JSON.parse(records[0]!) as ModulesSyncOp).opId, 'op_via_wrap')
  })
})

t('seen opId skip does not write a duplicate', () => {
  withStore((store, opsPath) => {
    store.appendOps([op('op_a'), op('op_b'), op('op_c')])
    store.appendOps([op('op_a'), op('op_dup'), op('op_dup')])
    store.appendOp(op('op_a'))
    const records = jsonlRecords(opsPath)
    assert.deepEqual(
      records.map((line) => (JSON.parse(line) as ModulesSyncOp).opId),
      ['op_a', 'op_b', 'op_c', 'op_dup'],
    )
  })
})

t('boot recovers leftover ops.jsonl.pending onto the live log', () => {
  withStore((store, opsPath) => {
    store.appendOps([op('op_disk')])
    const dir = dirname(opsPath)
    writeFileSync(join(dir, 'ops.jsonl.pending'), `${JSON.stringify(op('op_pending'))}\n`, 'utf8')
    const reopened = new BridgeStore(dir, 21, null)
    const records = jsonlRecords(opsPath)
    assert.deepEqual(
      records.map((line) => (JSON.parse(line) as ModulesSyncOp).opId),
      ['op_disk', 'op_pending'],
    )
    assert.equal(existsSync(join(dir, 'ops.jsonl.pending')), false)
    void reopened
  })
})

t('boot recover skips a pending opId already in the live log', () => {
  withStore((store, opsPath) => {
    store.appendOps([op('op_a'), op('op_b')])
    const dir = dirname(opsPath)
    writeFileSync(
      join(dir, 'ops.jsonl.pending'),
      `${JSON.stringify(op('op_b'))}\n${JSON.stringify(op('op_c'))}\n`,
      'utf8',
    )
    const reopened = new BridgeStore(dir, 21, null)
    const records = jsonlRecords(opsPath)
    assert.deepEqual(
      records.map((line) => (JSON.parse(line) as ModulesSyncOp).opId),
      ['op_a', 'op_b', 'op_c'],
    )
    void reopened
  })
})

t('same-process torn tail is repaired before the next append', () => {
  withStore((store, opsPath) => {
    store.appendOps([op('op_a')])
    const torn = `${readFileSync(opsPath, 'utf8').replace(/\n$/, '')}\n{"opId":"op_cut","kind":"entity.create","targetId":"cut`
    writeFileSync(opsPath, torn, 'utf8')
    store.appendOps([op('op_b')])
    const records = jsonlRecords(opsPath)
    const ids = records.flatMap((line) => {
      try {
        return [(JSON.parse(line) as ModulesSyncOp).opId]
      } catch {
        return []
      }
    })
    assert.deepEqual(ids, ['op_a', 'op_b'])
    assert.equal(records.some((line) => line.includes('op_b') && line.includes('op_cut')), false)
  })
})

{
  const dir = mkdtempSync(join(tmpdir(), 'brg-067-prune-'))
  try {
    mkdirSync(dir, { recursive: true })
    const store = new BridgeStore(dir, 21, null)
    store.appendOps([op('op_a'), op('op_b'), op('op_c')])
    const pendingPath = join(dir, 'ops.jsonl.pending')
    const prunePromise = store.pruneOps()
    store.appendOp(op('op_during_prune'))
    assert.equal(existsSync(pendingPath), true, 'mid-prune ACK must have bytes on disk')
    await prunePromise
    assert.equal(existsSync(pendingPath), false, 'sidecar must unlink after flush')
    const recent = await store.readRecentOps(100)
    assert.equal(recent.some((row) => row.opId === 'op_during_prune'), true)
    passed += 1
    console.log(`ok ${passed} append during prune writes the sidecar then survives rewrite`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'brg-067-blob-'))
  try {
    mkdirSync(dir, { recursive: true })
    const store = new BridgeStore(dir, 21, null)
    const plain = Buffer.from('crm-count-bytes')
    const sha = createHash('sha256').update(plain).digest('hex')
    const put = await store.putBlobFromStream(sha, Readable.from([plain]), plain.length)
    assert.equal(put.ok, true)
    assert.equal(store.blobCount(), 1, 'blobCount must follow the O(1) hex register')
    passed += 1
    console.log(`ok ${passed} blobCount follows put without a folder walk`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'brg-067-enc-'))
  try {
    mkdirSync(dir, { recursive: true })
    const key = resolveAtRestKeyFromEnv({
      TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
    } as NodeJS.ProcessEnv)
    assert.ok(key, 'at-rest key')
    const store = new BridgeStore(dir, 21, key)
    const plain = Buffer.from('stream-tsb1-encrypt')
    const sha = createHash('sha256').update(plain).digest('hex')
    const put = await store.putBlobFromStream(sha, Readable.from([plain]), plain.length)
    assert.equal(put.ok, true)
    const dest = join(dir, 'blobs', sha)
    const onDisk = readFileSync(dest)
    assert.ok(onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC), 'streaming encrypt must write TSB1 magic')
    assert.equal(onDisk.includes(plain), false)
    assert.equal(store.blobCount(), 1)
    const opened = store.openBlobRead(sha)
    assert.ok(opened)
    const chunks: Buffer[] = []
    for await (const c of opened!.stream) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    }
    assert.equal(Buffer.concat(chunks).equals(plain), true)
    passed += 1
    console.log(`ok ${passed} putBlobFromStream streaming TSB1 encrypt round-trips`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

t('CJK / emoji identity and name caps stay well-formed', () => {
  withStore((store, opsPath) => {
    const emoji = '\u{1F600}'
    const longId = `${'x'.repeat(199)}${emoji}`
    const longName = `${'名'.repeat(199)}${emoji}`
    store.appendOps([
      op(longId, { originMemberName: longName, originMemberId: `${'m'.repeat(127)}${emoji}` }),
    ])
    const records = jsonlRecords(opsPath)
    assert.equal(records.length, 1)
    const stored = JSON.parse(records[0]!) as ModulesSyncOp
    assert.equal(stored.opId, 'x'.repeat(199))
    assert.equal(stored.originMemberName, '名'.repeat(199))
    assert.equal(stored.originMemberId, 'm'.repeat(127))
    assert.equal(stored.opId.isWellFormed(), true)
    assert.equal(stored.originMemberName!.isWellFormed(), true)
    assert.equal(stored.originMemberName!.includes('\uFFFD'), false)
  })
})

t('one stringify-throwing op does not drop the rest of the batch', () => {
  withStore((store, opsPath) => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const bad = op('op_cycle', { patch: cycle })
    store.appendOps([op('op_keep_a'), bad, op('op_keep_b')])
    const records = jsonlRecords(opsPath)
    assert.deepEqual(
      records.map((line) => (JSON.parse(line) as ModulesSyncOp).opId),
      ['op_keep_a', 'op_keep_b'],
    )
  })
})

t('every stringify-throwing op throws and writes nothing', () => {
  withStore((store, opsPath) => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    const badA = op('op_cycle_all_a', { patch: cycle })
    const badB = op('op_cycle_all_b', { patch: cycle })
    assert.throws(
      () => store.appendOps([badA, badB]),
      (err: unknown) => err instanceof OpsPersistSkippedError,
    )
    assert.equal(existsSync(opsPath), false, 'all-seal skip must not create ops.jsonl')
  })
})

t('two data dirs do not share the op log or blob count', () => {
  const dirA = mkdtempSync(join(tmpdir(), 'brg-067-iso-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'brg-067-iso-b-'))
  try {
    const a = new BridgeStore(dirA, 21, null)
    const b = new BridgeStore(dirB, 21, null)
    a.appendOps([op('op_only_a')])
    assert.equal(existsSync(join(dirB, 'ops.jsonl')), false)
    assert.equal(b.blobCount(), 0)
    assert.equal(a.blobCount(), 0)
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

{
  const dir = mkdtempSync(join(tmpdir(), 'brg-067-samesha-'))
  try {
    mkdirSync(dir, { recursive: true })
    const store = new BridgeStore(dir, 21, null)
    const plain = Buffer.from('same-sha-overlap-bytes')
    const sha = createHash('sha256').update(plain).digest('hex')
    const [one, two] = await Promise.all([
      store.putBlobFromStream(sha, Readable.from([Buffer.from(plain)]), plain.length),
      store.putBlobFromStream(sha, Readable.from([Buffer.from(plain)]), plain.length),
    ])
    assert.equal(one.ok, true)
    assert.equal(two.ok, true)
    assert.equal(store.blobCount(), 1, 'same-sha overlap must increment once')
    assert.equal(store.blobDiskBytes(), plain.length)
    passed += 1
    console.log(`ok ${passed} overlapping same-sha puts increment blobCount once`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`brg-067-append-ops-batch: ${passed}/29 ok`)
