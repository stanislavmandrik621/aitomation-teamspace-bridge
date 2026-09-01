/**
 * TS-CHAT-014 - orphan chat blob / avatar GC + hourly wire pin.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChatBlobRegistry } from '../src/chat-blob-registry.js'
import { ChatAvatarStore } from '../src/chat-avatar-store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

function ageFile(path: string, ageMs: number): void {
  const past = (Date.now() - ageMs) / 1000
  utimesSync(path, past, past)
}

describe('chat blob/avatar GC TS-CHAT-014', () => {
  it('drops orphan blob + thumb files past age; keeps registered', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-gc-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const keepSha = 'a'.repeat(64)
      const orphanSha = 'b'.repeat(64)
      const orphanThumb = 'c'.repeat(64)
      writeFileSync(reg.blobPath(keepSha), Buffer.from('keep'))
      ;(reg as unknown as { bySha: Map<string, unknown> }).bySha.set(keepSha, {
        sha256: keepSha,
        roomId: 'r1',
        name: 'keep.bin',
        bytes: 4,
        mime: 'application/octet-stream',
        uploadedBy: 'm1',
        createdAt: Date.now(),
        thumbSha: null,
      })
      writeFileSync(reg.blobPath(orphanSha), Buffer.from('orphan'))
      writeFileSync(reg.thumbPath(orphanThumb), Buffer.from('thumb'))
      ageFile(reg.blobPath(orphanSha), 8 * 24 * 60 * 60 * 1000)
      ageFile(reg.thumbPath(orphanThumb), 8 * 24 * 60 * 60 * 1000)
      const out = reg.gc(7 * 24 * 60 * 60 * 1000)
      assert.ok(out.removedFiles >= 2)
      assert.equal(existsSync(reg.blobPath(keepSha)), true)
      assert.equal(existsSync(reg.blobPath(orphanSha)), false)
      assert.equal(existsSync(reg.thumbPath(orphanThumb)), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('avatar gc keeps live refs and drops aged orphans', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-av-gc-'))
    try {
      const store = new ChatAvatarStore(dir)
      const keep = 'd'.repeat(64)
      const orphan = 'e'.repeat(64)
      writeFileSync(store.pathFor(keep), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      writeFileSync(store.pathFor(orphan), Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
      ageFile(store.pathFor(orphan), 8 * 24 * 60 * 60 * 1000)
      const out = store.gc(new Set([keep]), 7 * 24 * 60 * 60 * 1000)
      assert.equal(out.removedFiles, 1)
      assert.equal(existsSync(store.pathFor(keep)), true)
      assert.equal(existsSync(store.pathFor(orphan)), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('hourly prune interval calls chatBlobs.gc and chatAvatars.gc', () => {
    const server = read('src/server.ts')
    assert.match(server, /chatBlobs\.gc\(/)
    assert.match(server, /chatAvatars\.gc\(/)
    assert.match(server, /TS-CHAT-014/)
    // Same hourly interval as ops/chat prune (not a dead export-only helper).
    // Bound the region STRUCTURALLY (the maintenance interval's own
    // declaration through the next top-level const) - a fixed +/-N character
    // window goes red on any unrelated edit inside the same block, and
    // widening the constant is the same bug with a bigger number.
    const start = server.indexOf('const maintenanceInterval = setInterval(')
    assert.ok(start > 0, 'the hourly maintenance interval still exists')
    const after = server.indexOf('\nconst ', start + 1)
    const region = server.slice(start, after > start ? after : server.length)
    assert.match(region, /chatStore\.prune/)
    assert.match(region, /chatBlobs\.gc\(/)
    // TCC-R1144-MEDIA-002: keep-set from live message attachments.
    assert.match(server, /collectLiveBlobShas/)
    assert.match(region, /collectLiveBlobShas/)
    // BRG-074: an incomplete scan must not hand gc() an authoritative-looking
    // empty keep-set - that deletes every live attachment.
    assert.match(region, /keepBlobs\.complete \? chatBlobs\.gc\(keepBlobs\.shas\) : chatBlobs\.gc\(\)/)
    // TCC-R1147-MEDIA-005: hourly tmp sweep (not boot-only).
    assert.match(region, /cleanupChatTmpFiles/)
  })

  it('TCC-R1144-MEDIA-002 age-deletes unreferenced registered blobs via keep-set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-keep-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const liveSha = 'a'.repeat(64)
      const deadSha = 'b'.repeat(64)
      writeFileSync(reg.blobPath(liveSha), Buffer.from('live'))
      writeFileSync(reg.blobPath(deadSha), Buffer.from('dead'))
      const bySha = (reg as unknown as { bySha: Map<string, unknown> }).bySha
      bySha.set(liveSha, {
        sha256: liveSha,
        roomId: 'r1',
        name: 'live.bin',
        bytes: 4,
        mime: 'application/octet-stream',
        uploadedBy: 'm1',
        createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        thumbSha: null,
      })
      bySha.set(deadSha, {
        sha256: deadSha,
        roomId: 'r1',
        name: 'dead.bin',
        bytes: 4,
        mime: 'application/octet-stream',
        uploadedBy: 'm1',
        createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000,
        thumbSha: null,
      })
      const out = reg.gc(new Set([liveSha]), 7 * 24 * 60 * 60 * 1000)
      assert.ok(out.removedRows >= 1)
      assert.equal(existsSync(reg.blobPath(liveSha)), true)
      assert.equal(existsSync(reg.blobPath(deadSha)), false)
      assert.equal(bySha.has(liveSha), true)
      assert.equal(bySha.has(deadSha), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TS-CHAT-143 re-uploading an old file protects it from the sweep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-reup-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const bytes = Buffer.from('an old company handout')
      // First share, long ago. Its only message was since removed, so the
      // live-reference scan no longer names it.
      const first = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'm1',
        filename: 'handout.txt',
        bytes,
      })
      assert.ok(!('error' in first), 'first upload registered')
      const sha = (first as { sha256: string }).sha256
      const bySha = (reg as unknown as { bySha: Map<string, { createdAt: number; lastRefAt?: number }> }).bySha
      const old = Date.now() - 400 * 24 * 60 * 60 * 1000
      const row = bySha.get(sha)
      assert.ok(row, 'row present')
      row.createdAt = old
      row.lastRefAt = old

      // Somebody shares the same file again today. Same content, so the
      // registry answers from the row that is already here.
      const again = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'm2',
        filename: 'handout.txt',
        bytes,
      })
      assert.ok(!('error' in again), 'second upload deduped')

      // The sweep runs before the new message is written, so the keep set
      // cannot name this file yet. It must survive anyway.
      const out = reg.gc(new Set<string>(), 7 * 24 * 60 * 60 * 1000)
      assert.equal(out.removedRows, 0, 'a file just re-shared is not swept')
      assert.equal(existsSync(reg.blobPath(sha)), true, 'bytes still on disk')
      assert.equal(bySha.has(sha), true, 'registry row still here')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TS-CHAT-143 sending a message protects the file it carries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-touch-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const sha = 'f'.repeat(64)
      writeFileSync(reg.blobPath(sha), Buffer.from('carried'))
      const bySha = (reg as unknown as { bySha: Map<string, unknown> }).bySha
      bySha.set(sha, {
        sha256: sha,
        roomId: 'chat:team',
        name: 'carried.bin',
        bytes: 7,
        mime: 'application/octet-stream',
        uploadedBy: 'm1',
        createdAt: Date.now() - 400 * 24 * 60 * 60 * 1000,
        thumbSha: null,
      })
      assert.equal(reg.touchReference(sha), true, 'a known file can be stamped')
      assert.equal(reg.touchReference('0'.repeat(64)), false, 'an unknown one cannot')
      const out = reg.gc(new Set<string>(), 7 * 24 * 60 * 60 * 1000)
      assert.equal(out.removedRows, 0, 'the stamped file survives the sweep')
      assert.equal(existsSync(reg.blobPath(sha)), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('TS-CHAT-143 the send path stamps the file before writing the message', () => {
    const server = read('src/server.ts')
    const start = server.indexOf("if (!/^[a-f0-9]{64}$/.test(blobId)) continue")
    assert.ok(start > 0, 'the attachment check still exists')
    const after = server.indexOf('attachFallback', start)
    const region = server.slice(start, after > start ? after : server.length)
    assert.match(region, /chatBlobs\.touchReference\(blobId\)/)
  })

  it('TCC-R1144-MEDIA-002 keeps young unreferenced blobs (mid-upload race)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-young-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const youngSha = 'c'.repeat(64)
      writeFileSync(reg.blobPath(youngSha), Buffer.from('young'))
      const bySha = (reg as unknown as { bySha: Map<string, unknown> }).bySha
      bySha.set(youngSha, {
        sha256: youngSha,
        roomId: 'r1',
        name: 'young.bin',
        bytes: 5,
        mime: 'application/octet-stream',
        uploadedBy: 'm1',
        createdAt: Date.now(),
        thumbSha: null,
      })
      const out = reg.gc(new Set(), 7 * 24 * 60 * 60 * 1000)
      assert.equal(out.removedRows, 0)
      assert.equal(existsSync(reg.blobPath(youngSha)), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
