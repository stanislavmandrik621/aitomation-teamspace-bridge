/**
 * BRG-069: CRM blob disk usage is an O(1) running total after one seed walk.
 * blobDiskBytes / leaf bytes() / leaf count() must not readdir on the hot path.
 * putBlobFromStream still consults the total before the stream write,
 * increments toWrite.length after renameSync, and a same-sha exists-skip
 * must not add. G5 streams via createWriteStream(tmp) (BRG-069).
 * G6 residual: count() is O(1); unlinkHexBlob / removeAfterUnlink decrement.
 * G5-pipe: encryptBlobFile / decryptBlobFile stream TSB1 GCM.
 * Wave 8: 0-byte add matches seed/unlink; hourly sweep skips this-pid temps;
 * history-bytes cache is capped; rooms-as-file quota is fail-closed.
 * Hunt-again: persist-miss add must not double-count (BRG-073); encrypt tmp
 * is pid+nonce; sweep reclaim `.tsb1`; chat blob usage sums `blobs[]`.
 * Wave 9: frame split counts `[]` wrapper bytes; seed fail-closes non-ENOENT
 * hex stat; decrypt transform latches failed so later chunks stay silent.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  BLOB_ENC_MAGIC,
  BLOB_GCM_STREAM_CHUNK,
  createBlobDecryptTransform,
  decryptBlobBody,
  decryptBlobFile,
  encryptBlobBody,
  encryptBlobFile,
  resolveAtRestKeyFromEnv,
} from '../src/at-rest.js'
import {
  CHAT_FILES_BYTES_UNREADABLE,
  CHAT_HISTORY_BYTES_CACHE_MAX,
  chatQuotaRefusal,
  measureChatFilesBytes,
  readChatBlobUsageBytes,
} from '../src/chat-disk-quota.js'
import { cleanupChatTmpFiles, isThisProcessTempName } from '../src/chat-tmp-sweep.js'
import {
  CRM_BLOB_DISK_UNREADABLE,
  CrmBlobDiskTotal,
  createCrmBlobDiskTotal,
} from '../src/crm-blob-disk.js'
import {
  encodedOpByteLength,
  OPS_FRAME_JSON_WRAPPER_BYTES,
  splitOpsForWsFrames,
} from '../src/ops-frame-budget.js'
import { BridgeStore } from '../src/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf8')
const leafSrc = readFileSync(join(root, 'src/crm-blob-disk.ts'), 'utf8')
const atRestSrc = readFileSync(join(root, 'src/at-rest.ts'), 'utf8')
const sweepSrc = readFileSync(join(root, 'src/chat-tmp-sweep.ts'), 'utf8')
const quotaSrc = readFileSync(join(root, 'src/chat-disk-quota.ts'), 'utf8')
const budgetSrc = readFileSync(join(root, 'src/ops-frame-budget.ts'), 'utf8')

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function sliceClassMethod(src: string, name: string): string {
  const re = new RegExp(`\\n  (?:async\\s+)?${name}\\(`)
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

function noReaddirOnHotRead(body: string): boolean {
  const live = sourceWithoutComments(body)
  return !/\breaddirSync\s*\(/.test(live)
}

function sliceNamedFunction(src: string, name: string): string {
  const needles = [
    `export function ${name}(`,
    `function ${name}(`,
    `export function ${name}<`,
    `function ${name}<`,
  ]
  let needle = ''
  let start = -1
  for (const n of needles) {
    const i = src.indexOf(n)
    if (i >= 0) {
      needle = n
      start = i
      break
    }
  }
  assert.ok(start >= 0, `missing function ${name}(`)
  let i = start + needle.length - 1
  if (needle.endsWith('<')) {
    let angle = 1
    i += 1
    for (; i < src.length && angle > 0; i++) {
      if (src[i] === '<') angle += 1
      else if (src[i] === '>') angle -= 1
    }
    while (i < src.length && src[i] !== '(') i += 1
  }
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
  while (i < src.length && /\s/.test(src[i])) i += 1
  if (src[i] === ':') {
    i += 1
    while (i < src.length && /\s/.test(src[i])) i += 1
    if (src[i] === '{') {
      let typeDepth = 0
      for (; i < src.length; i++) {
        if (src[i] === '{') typeDepth += 1
        else if (src[i] === '}') {
          typeDepth -= 1
          if (typeDepth === 0) {
            i += 1
            break
          }
        }
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

function streamsGcmFile(body: string): boolean {
  const live = sourceWithoutComments(body)
  if (/\breadFileSync\s*\(/.test(live)) return false
  if (/\bwriteFileSync\s*\(/.test(live)) return false
  if (!/\breadSync\s*\(/.test(live)) return false
  if (!/\bwriteSync\s*\(/.test(live)) return false
  return true
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function hexName(n: number): string {
  return n.toString(16).padStart(64, '0')
}

let passed = 0
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

await t('source-scan: blobDiskBytes must not readdir on each call', () => {
  const body = sliceClassMethod(storeSrc, 'blobDiskBytes')
  assert.equal(noReaddirOnHotRead(body), true, 'blobDiskBytes must not call readdirSync')
  assert.match(sourceWithoutComments(body), /this\.blobDisk\.bytes\s*\(/)
  const broken = body.replace(
    'return this.blobDisk.bytes()',
    'return readdirSync(this.blobsDir).reduce((n, f) => n + statSync(join(this.blobsDir, f)).size, 0)',
  )
  assert.equal(
    noReaddirOnHotRead(broken),
    false,
    'putting readdirSync back on blobDiskBytes must fail this pin',
  )
})

await t('source-scan: leaf bytes() / count() must not readdir (walk only in seed)', () => {
  const bytesBody = sliceClassMethod(leafSrc, 'bytes')
  const countBody = sliceClassMethod(leafSrc, 'count')
  const seedBody = sliceClassMethod(leafSrc, 'seed')
  const addBody = sliceClassMethod(leafSrc, 'addAfterNewPut')
  const removeBody = sliceClassMethod(leafSrc, 'removeAfterUnlink')
  assert.equal(noReaddirOnHotRead(bytesBody), true, 'bytes() must not readdirSync')
  assert.equal(noReaddirOnHotRead(countBody), true, 'count() must not readdirSync')
  assert.equal(noReaddirOnHotRead(addBody), true, 'addAfterNewPut must not readdirSync')
  assert.equal(noReaddirOnHotRead(removeBody), true, 'removeAfterUnlink must not readdirSync')
  assert.match(sourceWithoutComments(seedBody), /\breaddirSync\s*\(/)
  assert.match(sourceWithoutComments(seedBody), /isFsMissing/)
  assert.match(sourceWithoutComments(seedBody), /throw err/)
  const seedCommented = seedBody.replace(
    'if (isFsMissing(err)) continue\n          throw err',
    'if (isFsMissing(err)) continue\n          // throw err',
  )
  assert.notEqual(seedCommented, seedBody, 'fixture must comment the non-ENOENT throw')
  assert.equal(
    /throw err/.test(sourceWithoutComments(seedCommented)),
    false,
    'a commented throw is not fail-closed seed (TOOL-G31-066)',
  )
  assert.match(sourceWithoutComments(addBody), /this\.hexCount\s*\+=\s*1/)
  assert.match(sourceWithoutComments(addBody), /onDiskBytes\s*<\s*0/)
  assert.doesNotMatch(sourceWithoutComments(addBody), /onDiskBytes\s*<=\s*0/)
  const addLive = sourceWithoutComments(addBody)
  const addMissIdx = addLive.search(/if\s*\(\s*!this\.seeded\s*\)/)
  assert.ok(addMissIdx >= 0, 'addAfterNewPut must persist-miss seed')
  const addMiss = addLive.slice(addMissIdx, addLive.search(/if\s*\(\s*this\.unreadable\s*\)/))
  assert.match(addMiss, /this\.seed\s*\(/)
  assert.match(addMiss, /return/)
  assert.doesNotMatch(addMiss, /this\.hexCount/, 'persist-miss seed must not increment (BRG-073)')
  const addCommented = addBody.replace(
    'this.seed()\n      return',
    'this.seed()\n      // return',
  )
  assert.notEqual(addCommented, addBody, 'fixture must comment the persist-miss return')
  const addMissBroken = sourceWithoutComments(addCommented).slice(
    sourceWithoutComments(addCommented).search(/if\s*\(\s*!this\.seeded\s*\)/),
    sourceWithoutComments(addCommented).search(/if\s*\(\s*this\.unreadable\s*\)/),
  )
  assert.doesNotMatch(
    addMissBroken,
    /return/,
    'a commented persist-miss return is not a double-count guard (TOOL-G31-066)',
  )
  assert.match(sourceWithoutComments(removeBody), /this\.hexCount\s*=/)
  const commented = bytesBody.replace(
    'if (!this.seeded) this.seed()',
    'if (!this.seeded) this.seed() // readdirSync(this.blobsDir)',
  )
  assert.equal(
    noReaddirOnHotRead(commented),
    true,
    'a commented readdirSync in bytes() is not a hot-path walk',
  )
})

await t('source-scan: constructor seeds after mkdirSync(blobsDir)', () => {
  const ctor = sliceClassMethod(storeSrc, 'constructor')
  const live = sourceWithoutComments(ctor)
  const mkdirIdx = live.search(/mkdirSync\(\s*this\.blobsDir/)
  const seedIdx = live.search(/createCrmBlobDiskTotal\(\s*this\.blobsDir/)
  assert.ok(mkdirIdx >= 0, 'constructor must mkdirSync(this.blobsDir)')
  assert.ok(seedIdx >= 0, 'constructor must createCrmBlobDiskTotal(this.blobsDir)')
  assert.ok(seedIdx > mkdirIdx, 'seed must run after mkdirSync(this.blobsDir)')
})

await t('source-scan: putBlobFromStream consults total before write and increments after rename', () => {
  const body = sliceClassMethod(storeSrc, 'putBlobFromStream')
  const live = sourceWithoutComments(body)
  const consultIdx = live.search(/this\.blobDiskBytes\s*\(/)
  const writeIdx = live.search(/createWriteStream\(\s*tmp/)
  const renameIdx = live.search(/renameSync\(\s*tmp\s*,\s*dest\s*\)/)
  const addIdx = live.search(/this\.blobDisk\.addAfterNewPut\s*\(/)
  assert.ok(consultIdx >= 0, 'putBlobFromStream must consult blobDiskBytes')
  assert.ok(writeIdx >= 0, 'putBlobFromStream must createWriteStream(tmp)')
  assert.ok(renameIdx >= 0, 'putBlobFromStream must renameSync(tmp, dest)')
  assert.ok(addIdx >= 0, 'putBlobFromStream must addAfterNewPut after a NEW put')
  assert.ok(consultIdx < writeIdx, 'quota consult must run before write')
  assert.ok(renameIdx < addIdx, 'addAfterNewPut must run after renameSync')
  assert.match(live, /addAfterNewPut\(\s*toWrite\.length\s*\)/)

  const existsIdx = live.search(/existsSync\(\s*dest\s*\)/)
  assert.ok(existsIdx >= 0, 'same-sha exists-skip must remain')
  const existsBlock = live.slice(existsIdx, consultIdx)
  assert.doesNotMatch(
    existsBlock,
    /addAfterNewPut/,
    'same-sha exists-skip must not increment',
  )
})

await t('leaf: empty dir seeds 0; addAfterNewPut is O(1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-empty-'))
  try {
    mkdirSync(join(dir, 'blobs'), { recursive: true })
    const disk = createCrmBlobDiskTotal(join(dir, 'blobs'))
    assert.equal(disk.bytes(), 0)
    assert.equal(disk.isUnreadable(), false)
    disk.addAfterNewPut(40)
    disk.addAfterNewPut(15)
    disk.addAfterNewPut(0)
    assert.equal(disk.bytes(), 55)
    assert.equal(disk.count(), 3, '0-byte new put must still increment hexCount')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('leaf: boot walk counts hex blobs only, skips .part and other names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-walk-'))
  try {
    const blobs = join(dir, 'blobs')
    mkdirSync(blobs, { recursive: true })
    writeFileSync(join(blobs, hexName(1)), Buffer.alloc(100))
    writeFileSync(join(blobs, hexName(2)), Buffer.alloc(50))
    writeFileSync(join(blobs, `${hexName(3)}.part`), Buffer.alloc(80))
    writeFileSync(join(blobs, 'not-a-blob'), Buffer.alloc(999))
    const disk = createCrmBlobDiskTotal(blobs)
    assert.equal(disk.bytes(), 150)
    assert.equal(disk.count(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('leaf: persist miss (bytes before seed) walks once then stays O(1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-miss-'))
  try {
    const blobs = join(dir, 'blobs')
    mkdirSync(blobs, { recursive: true })
    writeFileSync(join(blobs, hexName(1)), Buffer.alloc(20))
    const disk = new CrmBlobDiskTotal(blobs)
    assert.equal(disk.bytes(), 20)
    writeFileSync(join(blobs, hexName(2)), Buffer.alloc(30))
    assert.equal(disk.bytes(), 20, 'hot read must not re-walk after seed')
    disk.addAfterNewPut(30)
    assert.equal(disk.bytes(), 50)
    assert.equal(disk.count(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('leaf: seed fail is fail-closed (unreadable folder)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-unreadable-'))
  try {
    const notADir = join(dir, 'not-a-dir')
    writeFileSync(notADir, 'x')
    const disk = createCrmBlobDiskTotal(notADir)
    assert.equal(disk.isUnreadable(), true)
    assert.equal(disk.bytes(), CRM_BLOB_DISK_UNREADABLE)
    assert.equal(disk.count(), 0)
    disk.addAfterNewPut(99)
    assert.equal(disk.bytes(), CRM_BLOB_DISK_UNREADABLE, 'add must not clear fail-closed')
    assert.equal(disk.count(), 0, 'add must not bump count while unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: seed after mkdir matches existing on-disk hex blobs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-store-seed-'))
  try {
    const blobs = join(dir, 'blobs')
    mkdirSync(blobs, { recursive: true })
    writeFileSync(join(blobs, hexName(1)), Buffer.alloc(64))
    writeFileSync(join(blobs, hexName(2)), Buffer.alloc(16))
    const store = new BridgeStore(dir, 21, null)
    assert.equal(store.blobDiskBytes(), 80)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: new put increments on-disk size; same-sha skip does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-put-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    assert.equal(store.blobDiskBytes(), 0)
    const plain = Buffer.from('hello-crm-blob')
    const sha = shaOf(plain)
    const first = await store.putBlobFromStream(sha, Readable.from([plain]), plain.length)
    assert.equal(first.ok, true)
    const onDisk = statSync(join(dir, 'blobs', sha)).size
    assert.equal(onDisk, plain.length)
    assert.equal(store.blobDiskBytes(), onDisk)

    const again = await store.putBlobFromStream(
      sha,
      Readable.from([plain]),
      plain.length,
      { diskMaxBytes: 1 },
    )
    assert.equal(again.ok, true, 'second put of same sha with tiny diskMax must still succeed')
    assert.equal(store.blobDiskBytes(), onDisk, 'exists-skip must not increment')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: still consults total before write (tiny diskMax refuses a new sha)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-quota-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const first = Buffer.from('keep-me')
    const sha1 = shaOf(first)
    const ok = await store.putBlobFromStream(sha1, Readable.from([first]), first.length)
    assert.equal(ok.ok, true)
    const used = store.blobDiskBytes()
    assert.ok(used > 0)

    const other = Buffer.from('other-sha')
    const sha2 = shaOf(other)
    const full = await store.putBlobFromStream(
      sha2,
      Readable.from([other]),
      other.length,
      { diskMaxBytes: 1 },
    )
    assert.equal(full.ok, false)
    if (full.ok) throw new Error('unreachable')
    assert.equal(full.status, 413)
    assert.equal(existsSync(join(dir, 'blobs', sha2)), false)
    assert.equal(store.blobDiskBytes(), used)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: increment uses encrypted on-disk size, not Content-Length', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-enc-'))
  try {
    const key = resolveAtRestKeyFromEnv({
      TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
    } as NodeJS.ProcessEnv)
    assert.ok(key, 'at-rest key')
    const store = new BridgeStore(dir, 21, key)
    const plain = Buffer.from('secret-crm-bytes')
    const sha = shaOf(plain)
    const put = await store.putBlobFromStream(sha, Readable.from([plain]), plain.length)
    assert.equal(put.ok, true)
    const onDisk = statSync(join(dir, 'blobs', sha)).size
    assert.ok(onDisk > plain.length, 'encrypted body must be larger than plaintext')
    assert.equal(store.blobDiskBytes(), onDisk)
    assert.notEqual(store.blobDiskBytes(), plain.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: two overlapping new puts serialize quota + increment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-race-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const a = Buffer.alloc(100, 1)
    const b = Buffer.alloc(100, 2)
    const shaA = shaOf(a)
    const shaB = shaOf(b)
    const [one, two] = await Promise.all([
      store.putBlobFromStream(shaA, Readable.from([a]), a.length, { diskMaxBytes: 150 }),
      store.putBlobFromStream(shaB, Readable.from([b]), b.length, { diskMaxBytes: 150 }),
    ])
    const oks = [one, two].filter((r) => r.ok)
    const refuses = [one, two].filter((r) => !r.ok)
    assert.equal(oks.length, 1, 'exactly one of two 100-byte puts fits in 150')
    assert.equal(refuses.length, 1)
    if (!refuses[0] || refuses[0].ok) throw new Error('unreachable')
    assert.equal(refuses[0].status, 413)
    assert.equal(store.blobDiskBytes(), 100)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('source-scan: unlinkHexBlob decrements via removeAfterUnlink', () => {
  const unlinkBody = sliceClassMethod(leafSrc, 'unlinkHexBlob')
  const live = sourceWithoutComments(unlinkBody)
  assert.match(live, /this\.removeAfterUnlink\s*\(/)
  assert.match(live, /unlinkSync\s*\(/)
  const commented = unlinkBody.replace(
    'this.removeAfterUnlink(size)',
    '// this.removeAfterUnlink(size)',
  )
  assert.notEqual(commented, unlinkBody, 'fixture must comment the decrement')
  assert.equal(
    /\bthis\.removeAfterUnlink\s*\(/.test(sourceWithoutComments(commented)),
    false,
    'a commented removeAfterUnlink is not a decrement (TOOL-G31-066)',
  )
})

await t('leaf: unlinkHexBlob decrements bytes and count; out-of-band unlink does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-unlink-'))
  try {
    const blobs = join(dir, 'blobs')
    mkdirSync(blobs, { recursive: true })
    const a = hexName(1)
    const b = hexName(2)
    writeFileSync(join(blobs, a), Buffer.alloc(80))
    writeFileSync(join(blobs, b), Buffer.alloc(40))
    const disk = createCrmBlobDiskTotal(blobs)
    assert.equal(disk.bytes(), 120)
    assert.equal(disk.count(), 2)

    unlinkSync(join(blobs, b))
    assert.equal(disk.bytes(), 120, 'raw unlinkSync must not decrement')
    assert.equal(disk.count(), 2, 'raw unlinkSync must not drop count')
    disk.removeAfterUnlink(40)
    assert.equal(disk.bytes(), 80)
    assert.equal(disk.count(), 1)

    assert.equal(disk.unlinkHexBlob(join(blobs, a)), true)
    assert.equal(existsSync(join(blobs, a)), false)
    assert.equal(disk.bytes(), 0)
    assert.equal(disk.count(), 0)
    assert.equal(disk.unlinkHexBlob(join(blobs, a)), false, 'missing hex is a no-op')
    assert.equal(disk.bytes(), 0)
    assert.equal(disk.count(), 0)

    writeFileSync(join(dir, 'outside'), Buffer.alloc(10))
    assert.equal(disk.unlinkHexBlob(join(dir, 'outside')), false, 'non-hex / outside blobsDir refused')
    assert.equal(existsSync(join(dir, 'outside')), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('source-scan: encryptBlobFile / decryptBlobFile stream (no whole-file read)', () => {
  const enc = sliceNamedFunction(atRestSrc, 'encryptBlobFile')
  const dec = sliceNamedFunction(atRestSrc, 'decryptBlobFile')
  assert.equal(streamsGcmFile(enc), true, 'encryptBlobFile must readSync/writeSync')
  assert.equal(streamsGcmFile(dec), true, 'decryptBlobFile must readSync/writeSync')
  assert.match(sourceWithoutComments(enc), /createCipheriv/)
  assert.match(sourceWithoutComments(dec), /createDecipheriv/)
  const tmpFn = sliceNamedFunction(atRestSrc, 'blobTransformTmp')
  const tmpLive = sourceWithoutComments(tmpFn)
  assert.match(tmpLive, /randomBytes/)
  assert.match(tmpLive, /process\.pid/)
  assert.match(sourceWithoutComments(enc), /blobTransformTmp\s*\(\s*dest\s*,\s*['"]enc['"]/)
  assert.match(sourceWithoutComments(dec), /blobTransformTmp\s*\(\s*dest\s*,\s*['"]dec['"]/)
  assert.doesNotMatch(
    sourceWithoutComments(enc),
    /`\$\{dest\}\.\$\{process\.pid\}\.encpart`/,
    'encrypt work tmp must not be pid-only (same-sha race)',
  )
  const commented = enc.replace(
    'while ((n = readSync(srcFd, buf, 0, buf.length, srcPos)) > 0)',
    '// while ((n = readSync(srcFd, buf, 0, buf.length, srcPos)) > 0)',
  )
  assert.notEqual(commented, enc, 'fixture must comment the readSync loop')
  assert.equal(
    streamsGcmFile(commented),
    false,
    'a commented readSync loop is not a stream encrypt (TOOL-G31-066)',
  )
})

await t('at-rest: encryptBlobFile / decryptBlobFile round-trip past one chunk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-gcm-'))
  try {
    const key = resolveAtRestKeyFromEnv({
      TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
    } as NodeJS.ProcessEnv)
    assert.ok(key, 'at-rest key')
    const plain = Buffer.alloc(BLOB_GCM_STREAM_CHUNK + 1200, 7)
    const src = join(dir, 'plain.bin')
    const enc = join(dir, 'enc.bin')
    const out = join(dir, 'out.bin')
    writeFileSync(src, plain)
    const onDisk = encryptBlobFile(key, src, enc)
    const encBuf = readFileSync(enc)
    assert.ok(encBuf.subarray(0, 4).equals(BLOB_ENC_MAGIC))
    assert.equal(encBuf.includes(plain.subarray(0, 32)), false)
    assert.equal(onDisk, encBuf.length)
    assert.equal(decryptBlobBody(key, encBuf).equals(plain), true, 'TSB1 stays decryptBlobBody-compatible')

    const bodyEnc = join(dir, 'body-enc.bin')
    writeFileSync(bodyEnc, encryptBlobBody(key, plain.subarray(0, 200)))
    const bodyOut = join(dir, 'body-out.bin')
    decryptBlobFile(key, bodyEnc, bodyOut)
    assert.equal(readFileSync(bodyOut).equals(plain.subarray(0, 200)), true)

    const copied = decryptBlobFile(key, src, out)
    assert.equal(copied, plain.length)
    assert.equal(readFileSync(out).equals(plain), true)
    const dec = join(dir, 'dec.bin')
    assert.equal(decryptBlobFile(key, enc, dec), plain.length)
    assert.equal(readFileSync(dec).equals(plain), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('at-rest: createBlobDecryptTransform TSB1 without key fails closed and stays silent', async () => {
  const key = resolveAtRestKeyFromEnv({
    TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
  } as NodeJS.ProcessEnv)
  assert.ok(key, 'at-rest key')
  const plain = Buffer.alloc(4000, 5)
  const enc = encryptBlobBody(key, plain)
  const chunks: Buffer[] = []
  let errMsg = ''
  const transform = createBlobDecryptTransform(null)
  transform.on('data', (chunk: Buffer) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  await new Promise<void>((resolve, reject) => {
    transform.on('error', (err: Error) => {
      errMsg = err.message
      resolve()
    })
    transform.on('end', () => reject(new Error('TSB1 without key must not end clean')))
    transform.write(enc.subarray(0, 20))
    transform.write(enc.subarray(20))
    transform.end()
  })
  assert.match(errMsg, /TEAMSPACE_AT_REST_KEY/)
  assert.equal(Buffer.concat(chunks).length, 0, 'failed decrypt must not emit ciphertext as plaintext')
  try {
    transform.write(Buffer.from('after-fail'))
  } catch {
    /* destroyed stream may throw; latch still must not emit */
  }
  assert.equal(Buffer.concat(chunks).length, 0, 'later writes after fail must stay silent')
})

await t('source-scan: createBlobDecryptTransform latches failed (no later plaintext)', () => {
  const body = sliceNamedFunction(atRestSrc, 'createBlobDecryptTransform')
  const live = sourceWithoutComments(body)
  assert.match(live, /mode\s*=\s*['"]failed['"]/)
  assert.match(live, /if\s*\(\s*mode\s*===\s*['"]failed['"]\s*\)/)
  const commented = body.replaceAll(
    "mode = 'failed'",
    "// mode = 'failed'",
  )
  assert.notEqual(commented, body, 'fixture must comment the failed latch')
  assert.equal(
    /mode\s*=\s*['"]failed['"]/.test(sourceWithoutComments(commented)),
    false,
    'a commented failed latch is not fail-closed (TOOL-G31-066)',
  )
})

await t('at-rest: createBlobDecryptTransform streams TSB1 without buffering the file in header', async () => {
  const key = resolveAtRestKeyFromEnv({
    TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
  } as NodeJS.ProcessEnv)
  assert.ok(key, 'at-rest key')
  const a = Buffer.alloc(80_000, 3)
  const b = Buffer.alloc(20_000, 9)
  const plain = Buffer.concat([a, b])
  const enc = encryptBlobBody(key, plain)
  const chunks: Buffer[] = []
  await pipeline(
    Readable.from([enc.subarray(0, 10), enc.subarray(10, 40), enc.subarray(40)]),
    createBlobDecryptTransform(key),
    new Writable({
      write(chunk, _enc, cb) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        cb()
      },
    }),
  )
  assert.equal(Buffer.concat(chunks).equals(plain), true)
})

await t('source-scan: chat-tmp-sweep invalidates history-bytes cache after a real remove', () => {
  const live = sourceWithoutComments(sweepSrc)
  assert.match(live, /invalidateChatFilesBytesCache\s*\(\s*dataDir/)
  const commented = sweepSrc.replace(
    'if (chatRemoved > 0) invalidateChatFilesBytesCache(dataDir)',
    'if (chatRemoved > 0) /* invalidateChatFilesBytesCache(dataDir) */',
  )
  assert.notEqual(commented, sweepSrc)
  assert.equal(
    /invalidateChatFilesBytesCache\s*\(\s*dataDir/.test(sourceWithoutComments(commented)),
    false,
    'a commented invalidate is not a cache drop (TOOL-G31-066)',
  )
})

await t('chat-tmp-sweep: removing rooms tmp drops the 2s history-bytes cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-sweep-cache-'))
  try {
    const rooms = join(dir, 'chat', 'rooms')
    mkdirSync(rooms, { recursive: true })
    writeFileSync(join(rooms, 'keep.jsonl'), 'a'.repeat(100))
    writeFileSync(join(rooms, 'orphan.tmp'), 'b'.repeat(400))
    assert.equal(measureChatFilesBytes(dir), 500)
    assert.equal(cleanupChatTmpFiles(dir), 1)
    assert.equal(
      measureChatFilesBytes(dir),
      100,
      'history-bytes cache must not keep the swept tmp',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('source-scan: hourly sweep skips this-process pid temps', () => {
  const live = sourceWithoutComments(sweepSrc)
  assert.match(live, /isThisProcessTempName/)
  assert.match(live, /process\.pid/)
  assert.match(live, /join\(\s*dataDir\s*,\s*['"]blobs['"]/)
  assert.match(live, /\.tsb1/)
  const cleanup = sliceNamedFunction(sweepSrc, 'cleanupChatTmpFiles')
  assert.equal(
    (sourceWithoutComments(cleanup).match(/visited:\s*0/g) || []).length,
    2,
    'chat and CRM sweeps must not share one visit budget',
  )
  const commented = sweepSrc.replace(
    'if (isThisProcessTempName(name)) continue',
    '// if (isThisProcessTempName(name)) continue',
  )
  assert.notEqual(commented, sweepSrc, 'fixture must comment the pid skip')
  assert.equal(
    /if\s*\(\s*isThisProcessTempName\s*\(\s*name\s*\)\s*\)\s*continue/.test(sourceWithoutComments(commented)),
    false,
    'a commented pid skip is not a live-write guard (TOOL-G31-066)',
  )
})

await t('chat-tmp-sweep: keeps this-pid temps; sweeps CRM blobs leftovers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-sweep-pid-'))
  try {
    const rooms = join(dir, 'chat', 'rooms')
    const crm = join(dir, 'blobs')
    mkdirSync(rooms, { recursive: true })
    mkdirSync(crm, { recursive: true })
    const liveName = `rooms.json.${process.pid}.tmp`
    const livePath = join(rooms, liveName)
    const orphanChat = join(rooms, 'orphan.tmp')
    const orphanCrm = join(crm, `${hexName(1)}.part`)
    const liveCrm = join(crm, `${hexName(2)}.${process.pid}.part`)
    const hexKeep = join(crm, hexName(3))
    const orphanTsb1 = join(crm, `${hexName(4)}.part.tsb1`)
    const liveTsb1 = join(crm, `${hexName(5)}.${process.pid}.part.tsb1`)
    writeFileSync(livePath, 'live-write')
    writeFileSync(orphanChat, 'old')
    writeFileSync(orphanCrm, 'crm-old')
    writeFileSync(liveCrm, 'crm-live')
    writeFileSync(hexKeep, Buffer.alloc(8))
    writeFileSync(orphanTsb1, 'enc-crash')
    writeFileSync(liveTsb1, 'enc-live')
    assert.equal(isThisProcessTempName(liveName), true)
    assert.equal(isThisProcessTempName('orphan.tmp'), false)
    const removed = cleanupChatTmpFiles(dir)
    assert.equal(removed, 3, 'orphan chat tmp + CRM leftover part + leftover tsb1')
    assert.equal(existsSync(livePath), true, 'this-pid chat tmp must survive hourly sweep')
    assert.equal(existsSync(orphanChat), false)
    assert.equal(existsSync(orphanCrm), false)
    assert.equal(existsSync(liveCrm), true, 'this-pid CRM part must survive')
    assert.equal(existsSync(hexKeep), true, 'hex blob must not be swept')
    assert.equal(existsSync(orphanTsb1), false, 'G5-pipe leftover tsb1 must be swept')
    assert.equal(existsSync(liveTsb1), true, 'this-pid tsb1 must survive hourly sweep')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('source-scan: encryptBlobFile / decryptBlobFile probe with statSync not existsSync', () => {
  const enc = sliceNamedFunction(atRestSrc, 'encryptBlobFile')
  const dec = sliceNamedFunction(atRestSrc, 'decryptBlobFile')
  const requireFn = sliceNamedFunction(atRestSrc, 'requireReadableFile')
  const missingFn = sliceNamedFunction(atRestSrc, 'isFsMissing')
  assert.doesNotMatch(sourceWithoutComments(enc), /\bexistsSync\s*\(/)
  assert.doesNotMatch(sourceWithoutComments(dec), /\bexistsSync\s*\(/)
  assert.match(sourceWithoutComments(requireFn), /\bstatSync\s*\(/)
  assert.match(sourceWithoutComments(requireFn), /isFsMissing/)
  assert.match(sourceWithoutComments(missingFn), /ENOENT/)
})

await t('source-scan: history-bytes cache is capped; rooms listing fail is closed', () => {
  assert.match(quotaSrc, /CHAT_HISTORY_BYTES_CACHE_MAX/)
  assert.match(quotaSrc, /CHAT_FILES_BYTES_UNREADABLE/)
  const remember = sliceNamedFunction(quotaSrc, 'rememberHistoryBytes')
  assert.match(sourceWithoutComments(remember), /CHAT_HISTORY_BYTES_CACHE_MAX/)
  assert.match(sourceWithoutComments(remember), /historyBytesCache\.delete/)
  const measure = sliceNamedFunction(quotaSrc, 'measureTreeBytes')
  assert.match(sourceWithoutComments(measure), /CHAT_FILES_BYTES_UNREADABLE/)
  assert.match(
    sourceWithoutComments(measure),
    /if\s*\(\s*depth\s*>\s*12\s*\)\s*return\s*CHAT_FILES_BYTES_UNREADABLE/,
  )
  assert.doesNotMatch(
    sourceWithoutComments(measure),
    /if\s*\(\s*depth\s*>\s*12\s*\)\s*return\s*0/,
    'depth cap must refuse, not under-count',
  )
  assert.doesNotMatch(sourceWithoutComments(measure), /\bexistsSync\s*\(/)
  const perFileClosed = /if\s*\(\s*isFsMissing\(err\)\s*\)\s*continue\s+return\s+CHAT_FILES_BYTES_UNREADABLE/
  assert.match(
    sourceWithoutComments(measure),
    perFileClosed,
    'a non-ENOENT file stat must fail-closed, not skip-and-under-count',
  )
  const measureCommented = measure.replace(
    'if (isFsMissing(err)) continue\n      return CHAT_FILES_BYTES_UNREADABLE',
    'if (isFsMissing(err)) continue\n      // return CHAT_FILES_BYTES_UNREADABLE',
  )
  assert.notEqual(measureCommented, measure, 'fixture must comment the per-file fail-closed return')
  assert.equal(
    perFileClosed.test(sourceWithoutComments(measureCommented)),
    false,
    'a commented per-file return is not fail-closed (TOOL-G31-066)',
  )
  const usage = sliceNamedFunction(quotaSrc, 'readChatBlobUsageBytes')
  const usageLive = sourceWithoutComments(usage)
  assert.match(usageLive, /parsed\.blobs/)
  assert.match(usageLive, /CHAT_FILES_BYTES_UNREADABLE/)
  assert.doesNotMatch(
    usageLive,
    /return 0\s*\n\s*\}\s*catch/,
    'unreadable registry must not fail-open to 0',
  )
  assert.equal(CHAT_HISTORY_BYTES_CACHE_MAX, 16)
})

await t('chat-disk-quota: rooms-as-file is fail-closed; refusal copy is plain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-quota-closed-'))
  try {
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeFileSync(join(dir, 'chat', 'rooms'), 'not-a-directory')
    assert.equal(measureChatFilesBytes(dir), CHAT_FILES_BYTES_UNREADABLE)
    const msg = chatQuotaRefusal('files', CHAT_FILES_BYTES_UNREADABLE, 100)
    assert.match(msg, /cannot be checked/)
    assert.doesNotMatch(msg, /GiB/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('source-scan: encodedOpByteLength is UTF-8 bytes, not JS string length', () => {
  const body = sliceNamedFunction(budgetSrc, 'encodedOpByteLength')
  const split = sliceNamedFunction(budgetSrc, 'splitOpsForWsFrames')
  const live = sourceWithoutComments(body)
  const splitLive = sourceWithoutComments(split)
  assert.match(live, /Buffer\.byteLength/)
  assert.match(live, /['"]utf8['"]/)
  assert.match(splitLive, /OPS_FRAME_JSON_WRAPPER_BYTES/)
  assert.match(splitLive, /encoded\s*\+\s*OPS_FRAME_JSON_WRAPPER_BYTES\s*>\s*maxBytes/)
  assert.doesNotMatch(
    splitLive,
    /encoded\s*>\s*maxBytes/,
    'BRG-061: a lone op of maxBytes is already over once [] is counted',
  )
  assert.doesNotMatch(
    live,
    /return JSON\.stringify\(op\)\.length/,
    'BRG-061: must not use JS string length for WS byte pages',
  )
  const commented = body.replace(
    "return Buffer.byteLength(JSON.stringify(op), 'utf8')",
    'return JSON.stringify(op).length',
  )
  assert.notEqual(commented, body, 'fixture must restore JS string length')
  assert.equal(
    /return JSON\.stringify\(op\)\.length/.test(sourceWithoutComments(commented)),
    true,
    'putting JS string length back must fail this pin',
  )
  assert.equal(
    /Buffer\.byteLength/.test(sourceWithoutComments(commented)),
    false,
    'a JS-length return is not a UTF-8 byte page (TOOL-G31-066)',
  )
})

await t('ops-frame-budget: lone op that fits bare stringify is oversized once [] is counted', () => {
  assert.equal(OPS_FRAME_JSON_WRAPPER_BYTES, 2)
  const op = { blob: 'x'.repeat(80) }
  const encoded = encodedOpByteLength(op)
  const maxBytes = encoded + 1
  assert.ok(encoded <= maxBytes, 'bare stringify must fit the tight ceiling')
  assert.ok(
    encoded + OPS_FRAME_JSON_WRAPPER_BYTES > maxBytes,
    'wrapper must push the frame over',
  )
  const split = splitOpsForWsFrames([op], { maxCount: 50, maxBytes })
  assert.equal(split.frames.length, 0, 'a frame of [op] must not exceed maxBytes')
  assert.equal(split.oversized.length, 1)
})

await t('ops-frame-budget: CJK page that fits JS length is oversized in UTF-8', () => {
  const cjk = { blob: '测'.repeat(40) }
  const jsLen = JSON.stringify(cjk).length
  const utf8Len = Buffer.byteLength(JSON.stringify(cjk), 'utf8')
  assert.ok(utf8Len > jsLen, 'CJK JSON is larger in UTF-8 than JS length')
  assert.equal(encodedOpByteLength(cjk), utf8Len)
  const over = splitOpsForWsFrames([cjk], { maxCount: 50, maxBytes: jsLen })
  assert.equal(over.frames.length, 0, 'a CJK op that fits JS length must still be oversized in UTF-8')
  assert.equal(over.oversized.length, 1)
  const ascii = { blob: 'x'.repeat(10) }
  const asciiFit = splitOpsForWsFrames([ascii], { maxCount: 50, maxBytes: 200 })
  assert.equal(asciiFit.frames.length, 1)
  assert.equal(asciiFit.oversized.length, 0)
})

await t('ops-frame-budget: concurrent CJK pages stay under the UTF-8 ceiling', () => {
  const page = Array.from({ length: 12 }, (_, i) => ({
    opId: `cjk-${i}`,
    blob: '页'.repeat(20),
  }))
  const maxBytes = 180
  const { frames, oversized } = splitOpsForWsFrames(page, { maxCount: 50, maxBytes })
  assert.equal(oversized.length, 0)
  assert.ok(frames.length >= 2, 'byte page must split concurrent CJK ops')
  for (const frame of frames) {
    const n = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    assert.ok(n <= maxBytes, `frame ${n} must stay under ${maxBytes} UTF-8 bytes`)
  }
})

await t('leaf: persist-miss addAfterNewPut does not double-count a file already on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-add-miss-'))
  try {
    const blobs = join(dir, 'blobs')
    mkdirSync(blobs, { recursive: true })
    writeFileSync(join(blobs, hexName(1)), Buffer.alloc(40))
    const disk = new CrmBlobDiskTotal(blobs)
    disk.addAfterNewPut(40)
    assert.equal(disk.bytes(), 40, 'seed walk already counted the renamed file')
    assert.equal(disk.count(), 1, 'persist-miss add must not increment hexCount again')
    disk.addAfterNewPut(12)
    assert.equal(disk.bytes(), 52)
    assert.equal(disk.count(), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('chat-disk-quota: blob usage sums registry rows; encrypted or bad shape is fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-usage-'))
  try {
    assert.equal(readChatBlobUsageBytes(dir), 0, 'missing registry is empty, not unreadable')
    mkdirSync(join(dir, 'chat'), { recursive: true })
    writeFileSync(
      join(dir, 'chat', 'blob-registry.json'),
      JSON.stringify({
        version: 1,
        blobs: [
          { sha256: hexName(1), bytes: 10 },
          { sha256: hexName(2), bytes: 25 },
          { sha256: hexName(3), bytes: 0 },
        ],
      }),
    )
    assert.equal(readChatBlobUsageBytes(dir), 35)
    writeFileSync(
      join(dir, 'chat', 'blob-registry.json'),
      JSON.stringify({
        version: 1,
        totalBytes: 0,
        blobs: [{ sha256: hexName(1), bytes: 10 }],
      }),
    )
    assert.equal(readChatBlobUsageBytes(dir), 10, 'blobs[] wins over a stale totalBytes')
    writeFileSync(
      join(dir, 'chat', 'blob-registry.json'),
      JSON.stringify({ totalBytes: 99 }),
    )
    assert.equal(readChatBlobUsageBytes(dir), 99)
    writeFileSync(
      join(dir, 'chat', 'blob-registry.json'),
      JSON.stringify({ v: 1, alg: 'aes-256-gcm', ciphertext: 'abc' }),
    )
    assert.equal(readChatBlobUsageBytes(dir), CHAT_FILES_BYTES_UNREADABLE)
    writeFileSync(join(dir, 'chat', 'blob-registry.json'), '{not-json')
    assert.equal(readChatBlobUsageBytes(dir), CHAT_FILES_BYTES_UNREADABLE)
    writeFileSync(join(dir, 'chat', 'blob-registry.json'), JSON.stringify({ version: 1 }))
    assert.equal(readChatBlobUsageBytes(dir), CHAT_FILES_BYTES_UNREADABLE)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('chat-disk-quota: rooms tree past the depth cap is fail-closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crm-blob-depth-'))
  try {
    let p = join(dir, 'chat', 'rooms')
    mkdirSync(p, { recursive: true })
    for (let i = 0; i < 13; i++) {
      p = join(p, `d${i}`)
      mkdirSync(p)
    }
    writeFileSync(join(p, 'nested.jsonl'), 'x')
    assert.equal(measureChatFilesBytes(dir), CHAT_FILES_BYTES_UNREADABLE)
    const msg = chatQuotaRefusal('files', CHAT_FILES_BYTES_UNREADABLE, 100)
    assert.match(msg, /cannot be checked/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`crm-blob-disk-total: ${passed}/34 ok`)
