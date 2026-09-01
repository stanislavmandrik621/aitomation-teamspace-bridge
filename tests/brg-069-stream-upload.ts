/**
 * BRG-069 write half: CRM putBlobFromStream ports the backup pipeline.
 * Stream plaintext to tmp (hash in a Transform), then encrypt as a
 * second pass. No chunks.push / Buffer.concat of the upload body.
 *
 * Pin-break (do not leave this in the tree): restore chunks.push +
 * Buffer.concat + writeFileSync of the collected body. This file EXIT 1.
 * Restore the pipeline. Expect green. SHA of store.ts must match.
 *
 * Does not take chat readBodyBytes, G6 blobDiskBytes, or G7 heap budget.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { resolveAtRestKeyFromEnv, BLOB_ENC_MAGIC } from '../src/at-rest.js'
import { BridgeStore } from '../src/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf8')

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

function streamsUploadToDisk(body: string): boolean {
  const live = sourceWithoutComments(body)
  if (!/\bpipeline\s*\(/.test(live)) return false
  if (!/\bcreateWriteStream\s*\(\s*tmp/.test(live)) return false
  if (/\bchunks\.push\s*\(/.test(live)) return false
  if (/Buffer\.concat\s*\(\s*chunks\s*\)/.test(live)) return false
  return true
}

function shaOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

let passed = 0
async function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  await fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

await t('source-scan: putBlobFromStream pipelines to tmp (BRG-069)', () => {
  const body = sliceClassMethod(storeSrc, 'putBlobFromStream')
  assert.equal(streamsUploadToDisk(body), true, 'putBlobFromStream must pipeline to createWriteStream(tmp)')
  const live = sourceWithoutComments(body)
  assert.match(live, /this\.blobDiskBytes\s*\(/)
  assert.match(live, /renameSync\(\s*tmp\s*,\s*dest\s*\)/)
  assert.match(live, /addAfterNewPut\(\s*toWrite\.length\s*\)/)
  const existsIdx = live.search(/existsSync\(\s*dest\s*\)/)
  const consultIdx = live.search(/this\.blobDiskBytes\s*\(/)
  assert.ok(existsIdx >= 0, 'same-sha exists-skip must remain')
  assert.ok(consultIdx > existsIdx, 'quota consult stays after exists-skip')
  const existsBlock = live.slice(existsIdx, consultIdx)
  assert.doesNotMatch(existsBlock, /addAfterNewPut/, 'exists-skip must not increment')
  assert.doesNotMatch(existsBlock, /pipeline\s*\(/, 'exists-skip must not write')
})

await t('source-scan: commenting pipeline fails this pin (TOOL-G31-066)', () => {
  const body = sliceClassMethod(storeSrc, 'putBlobFromStream')
  const commented = body.replace(
    'await pipeline(stream, hasher, createWriteStream(tmp))',
    '// await pipeline(stream, hasher, createWriteStream(tmp))',
  )
  assert.notEqual(commented, body, 'fixture must comment the live pipeline call')
  assert.equal(
    streamsUploadToDisk(commented),
    false,
    'a commented pipeline( is not a stream write (TOOL-G31-066)',
  )
})

await t('source-scan: restore chunks.push + Buffer.concat fails this pin', () => {
  const collectThenWrite = `
  async putBlobFromStream(sha256Expected, stream, contentLength) {
    const chunks = []
    const hash = createHash('sha256')
    stream.on('data', (chunk) => {
      chunks.push(chunk)
      hash.update(chunk)
    })
    const plain = Buffer.concat(chunks)
    const toWrite = this.atRest ? encryptBlobBody(this.atRest, plain) : plain
    writeFileSync(tmp, toWrite)
    renameSync(tmp, dest)
    this.blobDisk.addAfterNewPut(toWrite.length)
  }
`
  assert.equal(
    streamsUploadToDisk(collectThenWrite),
    false,
    'chunks.push + Buffer.concat + writeFileSync must fail this pin',
  )
})

await t('store: multi-chunk stream writes plaintext and leaves no .part', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-069-chunks-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const a = Buffer.from('hello-')
    const b = Buffer.from('crm-blob-stream')
    const plain = Buffer.concat([a, b])
    const sha = shaOf(plain)
    const put = await store.putBlobFromStream(sha, Readable.from([a, b]), plain.length)
    assert.equal(put.ok, true)
    if (!put.ok) throw new Error('unreachable')
    assert.equal(put.bytes, plain.length)
    const dest = join(dir, 'blobs', sha)
    assert.equal(readFileSync(dest).equals(plain), true)
    const leftovers = readdirSync(join(dir, 'blobs')).filter((f) => f.endsWith('.part'))
    assert.deepEqual(leftovers, [])
    assert.equal(store.blobDiskBytes(), plain.length)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: body larger than Content-Length refuses and unlinks tmp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-069-over-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const plain = Buffer.from('hello-blob-body')
    const sha = shaOf(plain)
    const over = await store.putBlobFromStream(sha, Readable.from([plain]), 1)
    assert.equal(over.ok, false)
    if (over.ok) throw new Error('unreachable')
    assert.match(over.error, /Content-Length|larger/i)
    assert.equal(existsSync(join(dir, 'blobs', sha)), false)
    const leftovers = readdirSync(join(dir, 'blobs')).filter((f) => f.endsWith('.part'))
    assert.deepEqual(leftovers, [])
    assert.equal(store.blobDiskBytes(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: checksum mismatch refuses and unlinks tmp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-069-sha-'))
  try {
    const store = new BridgeStore(dir, 21, null)
    const plain = Buffer.from('not-the-sha-you-want')
    const other = shaOf(Buffer.from('different-bytes'))
    const miss = await store.putBlobFromStream(other, Readable.from([plain]), plain.length)
    assert.equal(miss.ok, false)
    if (miss.ok) throw new Error('unreachable')
    assert.match(miss.error, /Checksum mismatch/)
    assert.equal(existsSync(join(dir, 'blobs', other)), false)
    const leftovers = readdirSync(join(dir, 'blobs')).filter((f) => f.endsWith('.part'))
    assert.deepEqual(leftovers, [])
    assert.equal(store.blobDiskBytes(), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

await t('store: at-rest encrypts after the plaintext stream (no streaming GCM)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-069-enc-'))
  try {
    const key = resolveAtRestKeyFromEnv({
      TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
    } as NodeJS.ProcessEnv)
    assert.ok(key, 'at-rest key')
    const store = new BridgeStore(dir, 21, key)
    const a = Buffer.from('secret-')
    const b = Buffer.from('crm-bytes')
    const plain = Buffer.concat([a, b])
    const sha = shaOf(plain)
    const put = await store.putBlobFromStream(sha, Readable.from([a, b]), plain.length)
    assert.equal(put.ok, true)
    const dest = join(dir, 'blobs', sha)
    const onDisk = readFileSync(dest)
    assert.ok(onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC), 'encrypted magic after second pass')
    assert.equal(onDisk.includes(plain), false, 'plaintext must not remain on disk')
    assert.ok(onDisk.length > plain.length)
    assert.equal(store.blobDiskBytes(), onDisk.length)
    assert.equal(statSync(dest).size, onDisk.length)
    const opened = store.openBlobRead(sha)
    assert.ok(opened)
    const chunks: Buffer[] = []
    for await (const c of opened!.stream) {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
    }
    assert.equal(Buffer.concat(chunks).equals(plain), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

console.log(`brg-069-stream-upload: ${passed}/7 ok`)
