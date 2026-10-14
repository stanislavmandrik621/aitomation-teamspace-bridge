/** Native Office saves must travel through the real bounded blob store. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { BridgeStore, MAX_BLOB_BYTES_EXPORT } from '../src/store.js'
import { CHAT_ATTACH_MAX_BYTES_CEILING } from '../src/chat-room.js'
import { TEAMSPACE_FILE_BLOB_MAX_BYTES, MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER,
  MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER } from '../src/throughput.js'

const root = mkdtempSync(join(tmpdir(), 'office-file-blob-limit-'))
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function* chunks(bytes: Buffer) {
  for (let offset = 0; offset < bytes.length; offset += 512 * 1024)
    yield bytes.subarray(offset, offset + 512 * 1024)
}
try {
  assert.equal(TEAMSPACE_FILE_BLOB_MAX_BYTES, 32 * 1024 * 1024)
  assert.equal(MAX_BLOB_BYTES_EXPORT, TEAMSPACE_FILE_BLOB_MAX_BYTES)
  assert.equal(CHAT_ATTACH_MAX_BYTES_CEILING, 25 * 1024 * 1024)
  assert(MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER >= TEAMSPACE_FILE_BLOB_MAX_BYTES)
  assert(MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER >= TEAMSPACE_FILE_BLOB_MAX_BYTES)
  const store = new BridgeStore(root, 21, null, null)
  for (const size of [26_565_521, TEAMSPACE_FILE_BLOB_MAX_BYTES]) {
    const bytes = Buffer.alloc(size, 0x6f), sha = digest(bytes)
    const result = await store.putBlobFromStream(sha, Readable.from(chunks(bytes)), size)
    assert.deepEqual(result, { ok: true, sha256: sha, bytes: size })
    assert.deepEqual(readFileSync(join(root, 'blobs', sha)), bytes)
    assert.deepEqual(await store.verifyExistingBlobSha(sha), { ok: true, bytes: size })
  }
  let consumed = false
  const oversized = Readable.from((function* () { consumed = true; yield Buffer.from('never consumed') })())
  const refused = await store.putBlobFromStream('0'.repeat(64), oversized, TEAMSPACE_FILE_BLOB_MAX_BYTES + 1)
  assert.equal(refused.ok, false)
  assert.equal(consumed, false, 'oversized declaration refuses before reading the body')
  oversized.destroy()
  const bytes = Buffer.from('declared-short')
  assert.equal((await store.putBlobFromStream(digest(bytes), Readable.from([bytes]), bytes.length - 1)).ok, false)
  assert.equal(store.hasBlob(digest(bytes)), false)
  assert.equal(readdirSync(join(root, 'blobs')).some(name => name.endsWith('.part')), false)
  console.log('Office file blobs: large-save and exact 32 MiB round trips, over-limit and short-declaration refusal, temporary cleanup and separate chat ceiling passed')
} finally { rmSync(root, { recursive: true, force: true }) }
