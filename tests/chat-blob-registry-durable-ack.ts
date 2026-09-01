/**
 * TCC-R1132-BLOB-001 - chat blob registry ACKed uploads BEFORE the durable
 * `writeChain` persist finished (fire-and-forget `queuePersist()`, never
 * `await`ed). A crash between the in-memory `bySha.set` and the async
 * rename-complete write could leave a chat message referencing a blob whose
 * registry row never made it to `blob-registry.json` - a bridge restart
 * drops the row (404 on read) and the 7-day GC sweep then unlinks the
 * still-referenced blob file outright.
 *
 * Fix: `registerUpload` now `await`s the durable persist before resolving
 * (so the caller in `server.ts` only sends HTTP 200 after the row is on
 * disk), and fails closed (rolls back the in-memory row + written blob file,
 * returns `{error}`) if the persist itself throws.
 *
 * Note: the first test below is a same-process content check (persistSync
 * is itself synchronous, so a same-tick fire-and-forget write can coincidentally
 * land before a later `await` drains the microtask queue either way) - the
 * SECOND test (fail-closed rollback on a forced persist error) is the
 * authoritative regression pin: it only passes because `registerUpload`
 * actually `await`s `queuePersist()` and reacts to its rejection. Confirmed
 * by reverting the fix and re-running this file: test 2 fails
 * (`registerUpload must fail closed...`) against the pre-fix code, test 1
 * does not reliably distinguish pre/post fix on its own.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatBlobRegistry } from '../src/chat-blob-registry.js'

describe('TCC-R1132-BLOB-001 - chat blob registry ACKs only after durable persist', () => {
  it('registerUpload resolves only after blob-registry.json is durably written with the new row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-durable-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      const bytes = new TextEncoder().encode('hello durable world')
      const row = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'member1',
        filename: 'note.txt',
        bytes,
      })
      assert.ok(!('error' in row), 'registerUpload should succeed')
      if ('error' in row) return
      // The moment registerUpload's promise resolves (our `await` above), the
      // durable registry file on disk must already contain this row - no
      // separate wait/poll needed, proving persist is no longer fire-and-forget.
      const registryPath = join(dir, 'chat', 'blob-registry.json')
      assert.ok(existsSync(registryPath), 'registry file must exist immediately after ACK')
      const onDisk = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        blobs: Array<{ sha256: string; roomId: string }>
      }
      const found = onDisk.blobs.find((b) => b.sha256 === row.sha256)
      assert.ok(found, 'durable registry file must contain the just-registered row before ACK')
      assert.equal(found?.roomId, 'chat:team')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails closed (rolls back row + blob file) when the durable persist throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-chat-blob-fail-closed-'))
    try {
      const reg = new ChatBlobRegistry(dir, null)
      // Force persistSync() to throw by making the registry path unwritable:
      // point renameSync's target at a directory instead of a file so the
      // rename fails deterministically without relying on OS permissions.
      const registryPath = join(dir, 'chat', 'blob-registry.json')
      // Replace the target with a directory of the same name so writeFileSync's
      // rename-over-it fails with EISDIR/EPERM every time persistSync runs.
      rmSync(registryPath, { force: true })
      const { mkdirSync } = await import('node:fs')
      mkdirSync(registryPath)

      const bytes = new TextEncoder().encode('should not survive a failed persist')
      const result = await reg.registerUpload({
        roomId: 'chat:team',
        uploadedBy: 'member1',
        filename: 'bad.txt',
        bytes,
      })
      assert.ok('error' in result, 'registerUpload must fail closed when durable persist fails')
      // The blob body file must have been rolled back (unlinked), not left
      // orphaned with no registry row pointing at it.
      const sha = (await import('node:crypto'))
        .createHash('sha256')
        .update(bytes)
        .digest('hex')
      assert.equal(existsSync(reg.blobPath(sha)), false, 'orphaned blob body must be rolled back')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
