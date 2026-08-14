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
    const idx = server.indexOf('chatBlobs.gc(')
    assert.ok(idx > 0)
    const window = server.slice(Math.max(0, idx - 1200), idx + 400)
    assert.match(window, /setInterval/)
    assert.match(window, /chatStore\.prune/)
    // TCC-R1144-MEDIA-002: keep-set from live message attachments.
    assert.match(server, /collectLiveBlobShas/)
    assert.match(window, /collectLiveBlobShas/)
    // TCC-R1147-MEDIA-005: hourly tmp sweep (not boot-only).
    assert.match(window, /cleanupChatTmpFiles/)
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
