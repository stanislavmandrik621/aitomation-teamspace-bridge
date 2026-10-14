/** Publication and duplicate acknowledgement recheck membership after streaming. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { BridgeStore } from '../src/store.js'
const dir = mkdtempSync(join(tmpdir(), 'blob-upload-authority-'))
try {
  const store = new BridgeStore(dir, 21, null, null)
  const bytes = Buffer.from('synthetic shared module attachment')
  const sha = createHash('sha256').update(bytes).digest('hex')
  let authorized = true
  const body = new PassThrough()
  const pending = store.putBlobFromStream(sha, body, bytes.length, { authorize: () => authorized })
  body.write(bytes.subarray(0, 5)); authorized = false; body.end(bytes.subarray(5))
  assert.deepEqual(await pending, { ok: false, error: 'Session is no longer authorized', status: 403 })
  assert.equal(store.hasBlob(sha), false)
  assert.equal(store.blobCount(), 0)
  assert.deepEqual(readdirSync(join(dir, 'blobs')), [], 'refusal removes its temporary upload')
  authorized = true
  assert.equal((await store.putBlobFromStream(sha, Readable.from([bytes]), bytes.length, { authorize: () => authorized })).ok, true)
  const duplicateBody = new PassThrough()
  const duplicate = store.putBlobFromStream(sha, duplicateBody, bytes.length, { authorize: () => authorized })
  authorized = false; duplicateBody.end(bytes)
  assert.deepEqual(await duplicate, { ok: false, error: 'Session is no longer authorized', status: 403 })
  assert.equal(store.hasBlob(sha), true, 'rejected duplicate preserves another writer’s committed blob')
  authorized = true
  const verify = store.verifyExistingBlobSha.bind(store)
  let release!: () => void
  let started!: () => void
  const reached = new Promise<void>(resolve => { started = resolve })
  const hold = new Promise<void>(resolve => { release = resolve })
  store.verifyExistingBlobSha = async (...args) => { const result = await verify(...args); started(); await hold; return result }
  const checking = store.putBlobFromStream(sha, Readable.from([bytes]), bytes.length, { authorize: () => authorized })
  await reached; authorized = false; release()
  assert.deepEqual(await checking, { ok: false, error: 'Session is no longer authorized', status: 403 })
  assert.equal(store.blobCount(), 1)
  console.log('Blob authority: mid-stream revocation, temporary cleanup, authorized publication, duplicate drain and verification races passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
