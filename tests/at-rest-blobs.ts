/**
 * TCC-R1125-BRG-002 / TCC-R1126-BRG-002 - chat attachment/avatar bytes and
 * Compose share pack bytes must be encrypted at rest when TEAMSPACE_AT_REST_KEY
 * is set (registry/metadata JSON already encrypted; the binary bodies did not).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { resolveAtRestKeyFromEnv, BLOB_ENC_MAGIC } from '../src/at-rest.js'
import { ChatBlobRegistry } from '../src/chat-blob-registry.js'
import { ChatAvatarStore } from '../src/chat-avatar-store.js'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'

function key() {
  const k = resolveAtRestKeyFromEnv({
    TEAMSPACE_AT_REST_KEY: 'test-passphrase-16+chars',
  } as NodeJS.ProcessEnv)
  if (!k) throw new Error('unreachable')
  return k
}

/**
 * Compose client share links are always password-gated by product policy
 * (TCC-R1132-CMPY-002) - build a syntactically-valid `s$salt$hash` stand-in
 * so this at-rest-encryption test can exercise upsertShare without also
 * testing password verification (covered by compose-share-password.ts).
 */
function fakePasswordHash(): string {
  return `s$${randomBytes(16).toString('hex')}$${randomBytes(32).toString('hex')}`
}

function tinyJpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4])
}

describe('at-rest blob/avatar/compose-pack bytes (TCC-R1125-BRG-002 / TCC-R1126-BRG-002)', () => {
  it('chat attachment bytes are encrypted on disk and decrypt round-trip via readBlobBytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chatblob-enc-'))
    try {
      const k = key()
      const reg = new ChatBlobRegistry(dir, k)
      const plain = Buffer.from('super secret attachment contents')
      const registered = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'mem_a',
        filename: 'secret.txt',
        bytes: plain,
      })
      if ('error' in registered) throw new Error(registered.error)
      const onDisk = readFileSync(reg.blobPath(registered.sha256))
      assert.ok(onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC), 'blob magic present on disk')
      assert.equal(onDisk.includes(plain), false, 'plaintext body must not appear on disk')
      const decrypted = reg.readBlobBytes(registered.sha256)
      assert.ok(decrypted, 'readBlobBytes returns bytes')
      assert.ok(decrypted!.equals(plain), 'decrypted bytes round-trip')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('chat attachment bytes stay plaintext with no at-rest key (back-compat)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chatblob-plain-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const plain = Buffer.from('not secret')
      const registered = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'mem_a',
        filename: 'plain.txt',
        bytes: plain,
      })
      if ('error' in registered) throw new Error(registered.error)
      const onDisk = readFileSync(reg.blobPath(registered.sha256))
      assert.ok(onDisk.equals(plain), 'no key set => bytes stay plaintext on disk')
      const read = reg.readBlobBytes(registered.sha256)
      assert.ok(read!.equals(plain), 'readBlobBytes passes plaintext through unchanged')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('avatar bytes are encrypted on disk and decrypt round-trip via get()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-avatar-enc-'))
    try {
      const k = key()
      const store = new ChatAvatarStore(dir, k)
      const bytes = tinyJpeg()
      const put = store.put(bytes)
      if ('error' in put) throw new Error(put.error)
      const onDisk = readFileSync(store.pathFor(put.sha256))
      assert.ok(onDisk.subarray(0, 4).equals(BLOB_ENC_MAGIC), 'avatar magic present on disk')
      const got = store.get(put.sha256)
      assert.ok(got, 'get returns bytes')
      assert.equal(Buffer.from(got!.bytes).equals(Buffer.from(bytes)), true, 'avatar bytes round-trip')
      assert.equal(got!.mime, 'image/jpeg', 'mime re-sniffed from decrypted bytes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('avatar content-address dedupes even though ciphertext differs per write (random IV)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-avatar-dedupe-'))
    try {
      const k = key()
      const store = new ChatAvatarStore(dir, k)
      const bytes = tinyJpeg()
      const first = store.put(bytes)
      const second = store.put(bytes)
      assert.ok(!('error' in first) && !('error' in second))
      if ('error' in first || 'error' in second) throw new Error('unreachable')
      assert.equal(first.sha256, second.sha256, 'same plaintext => same content address')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compose share pack bytes are encrypted on disk and decrypt round-trip via readPackBytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-compose-pack-enc-'))
    try {
      const k = key()
      const store = new ComposeShareBridgeStore(dir, k)
      const packBytes = Buffer.from('a'.repeat(5000))
      const tokenPlain = 'plain-token-1234567890'
      const tokenHash = hashComposeShareToken(tokenPlain)
      const up = store.upsertShare('mem_a', {
        tokenHash,
        localShareId: 'share_1',
        format: 'pdf',
        watermark: 'off',
        filename: 'export.pdf',
        passwordHash: fakePasswordHash(),
        expiresAt: null,
        packBytes,
      })
      assert.ok(up.ok, 'upsert ok')
      const read = store.readPackBytes(tokenHash)
      assert.ok(read, 'readPackBytes returns bytes')
      assert.ok(read!.equals(packBytes), 'pack bytes round-trip through encrypt/decrypt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('compose share pack bytes stay plaintext with no at-rest key (back-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-compose-pack-plain-'))
    try {
      const store = new ComposeShareBridgeStore(dir, null)
      const packBytes = Buffer.from('plain pack bytes')
      const tokenHash = hashComposeShareToken('plain-token-abcdefghij')
      const up = store.upsertShare('mem_a', {
        tokenHash,
        localShareId: 'share_2',
        format: 'pdf',
        watermark: 'off',
        filename: 'export.pdf',
        passwordHash: fakePasswordHash(),
        expiresAt: null,
        packBytes,
      })
      assert.ok(up.ok, 'upsert ok')
      const read = store.readPackBytes(tokenHash)
      assert.ok(read!.equals(packBytes), 'no key set => bytes round-trip as plaintext')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
