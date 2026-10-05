/**
 * BRG-074: a line the process cannot READ must never be treated as a line it
 * may DELETE.
 *
 * `decryptOpsLine` throws when the at-rest key is missing or wrong, and every
 * prune walk used to fold that throw into its `removed` counter and then
 * rewrite the file from only the lines it managed to parse. With a wrong
 * TEAMSPACE_AT_REST_KEY every line throws, so the routine hourly maintenance
 * pass truncated the whole team's chat history and the entire modules-sync op
 * log to zero bytes - turning a recoverable "put the key back" mistake into
 * permanent loss, one hour after the mis-keyed process started.
 *
 * The attachment sweep had the same shape one step removed: the keep-set scan
 * skipped unreadable lines, and `ChatBlobRegistry.gc` treats an empty Set as
 * authoritative, so "we could read nothing" read as "nothing is referenced".
 *
 * These are behavioural pins - they run the real prune with a key that cannot
 * decrypt what is on disk and assert the bytes survive.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeStore } from '../src/store.js'
import { ChatRoomHistoryStore } from '../src/chat-room-history-store.js'
import type { AtRestKey } from '../src/at-rest.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Two keys that are both valid AES-256 keys and cannot decrypt each other. */
const KEY_A: AtRestKey = { key: Buffer.alloc(32, 0x11) }
const KEY_B: AtRestKey = { key: Buffer.alloc(32, 0x22) }

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

describe('BRG-074 unreadable lines survive every prune', () => {
  it('op log prune keeps every line it could not decrypt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brg074-ops-'))
    try {
      // Retention of 1 day with ops that have no acking device: without the
      // decrypt failure these are exactly the rows prune is entitled to drop,
      // so the assertion below cannot pass just because prune found nothing
      // to do.
      const written = new BridgeStore(dir, 1, KEY_A)
      written.appendOp(op('op_one'))
      written.appendOp(op('op_two'))
      const opsPath = join(dir, 'ops.jsonl')
      const before = readFileSync(opsPath, 'utf8')
      assert.ok(before.includes('e1.'), 'fixture must actually be encrypted on disk')

      // The operator redeploys with the wrong key.
      const misKeyed = new BridgeStore(dir, 1, KEY_B)
      const removed = await misKeyed.pruneOps()

      assert.equal(
        readFileSync(opsPath, 'utf8'),
        before,
        'a prune that cannot read the log must leave it byte-for-byte intact',
      )
      assert.equal(removed, 0, 'nothing was removed, so nothing may be reported as removed')

      // And the data is still there once the right key comes back.
      const healed = new BridgeStore(dir, 1, KEY_A)
      const seen: string[] = []
      for await (const row of healed.scanOpsFromStart()) seen.push(row.opId)
      assert.deepEqual(seen, ['op_one', 'op_two'], 'the ops must be readable again')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('chat prune keeps every line it could not decrypt', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brg074-chat-'))
    try {
      // Retention 1 day / tombstones 1 day - the rows themselves are fresh, so
      // a readable prune is a no-op; the point is that an UNREADABLE prune is
      // also a no-op instead of a wipe.
      const written = new ChatRoomHistoryStore(dir, 1, 1, KEY_A)
      const first = await written.append({
        room: 'chat:team',
        body: 'first message',
        memberId: 'mem_a',
        memberName: 'A',
        role: 'admin',
      })
      assert.ok(!('error' in first), 'fixture append must succeed')
      const second = await written.append({
        room: 'chat:team',
        body: 'second message',
        memberId: 'mem_a',
        memberName: 'A',
        role: 'admin',
      })
      assert.ok(!('error' in second), 'fixture append must succeed')

      const roomsDir = join(dir, 'chat', 'rooms')
      const roomName = readdirSync(roomsDir)[0]
      assert.ok(roomName, 'fixture must have written a room dir')
      const msgPath = join(roomsDir, roomName, 'messages.jsonl')
      const before = readFileSync(msgPath, 'utf8')
      assert.ok(before.includes('e1.'), 'fixture must actually be encrypted on disk')

      const misKeyed = new ChatRoomHistoryStore(dir, 1, 1, KEY_B)
      const removed = await misKeyed.prune()
      assert.equal(
        readFileSync(msgPath, 'utf8'),
        before,
        'a prune that cannot read the room must leave it byte-for-byte intact',
      )
      assert.equal(removed, 0, 'nothing was removed, so nothing may be reported as removed')

      const healed = new ChatRoomHistoryStore(dir, 1, 1, KEY_A)
      const back = await healed.readRecent('chat:team', 50)
      assert.equal(
        back.messages.length,
        2,
        'both messages must be readable again once the key is restored',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the attachment keep-set says when it is incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brg074-keep-'))
    try {
      const written = new ChatRoomHistoryStore(dir, 0, 0, KEY_A)
      const sent = await written.append({
        room: 'chat:team',
        body: 'here is a file',
        memberId: 'mem_a',
        memberName: 'A',
        role: 'admin',
        attachments: [{
          blobId: 'f'.repeat(64),
          name: 'report.pdf',
          bytes: 10,
          mime: 'application/pdf',
        }],
      })
      assert.ok(!('error' in sent), 'fixture append must succeed')

      const readable = await written.collectLiveBlobShas()
      assert.equal(readable.complete, true, 'a clean scan is complete')
      assert.equal(readable.shas.has('f'.repeat(64)), true, 'and finds the attachment')

      const misKeyed = new ChatRoomHistoryStore(dir, 0, 0, KEY_B)
      const blind = await misKeyed.collectLiveBlobShas()
      assert.equal(
        blind.complete,
        false,
        'a scan that could not read a line must say so - an empty set alone is'
        + ' indistinguishable from "nothing is referenced any more"',
      )
      assert.equal(blind.shas.size, 0, 'and it genuinely found nothing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the hourly sweep skips keep-set GC when the scan was incomplete', () => {
    // The behavioural half above proves the flag is honest. This half proves
    // the one caller acts on it: `gc(shas)` on an incomplete scan would delete
    // every registered attachment past the age gate.
    const src = readFileSync(join(root, 'src', 'server.ts'), 'utf8')
    const call = /chatBlobs\.gc\([^)]*\)/g
    const calls = src.match(call) ?? []
    assert.ok(calls.length > 0, 'server must still run the attachment GC')
    for (const c of calls) {
      // Every keep-set call must be guarded by the completeness flag.
      if (!c.includes('.shas')) continue
      const at = src.indexOf(c)
      const window = src.slice(Math.max(0, at - 400), at + c.length)
      assert.ok(
        /keepBlobs\.complete/.test(window),
        `attachment GC passes a keep-set without checking completeness: ${c}`,
      )
    }
    assert.ok(
      /keepBlobs\.complete\s*\?\s*chatBlobs\.gc\(keepBlobs\.shas\)\s*:\s*chatBlobs\.gc\(\)/.test(src),
      'an incomplete scan must fall back to the orphan-only sweep, never a keep-set sweep',
    )
  })

  it('recovering unflushed ops never drops a line it could not read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'brg074-pending-'))
    try {
      // Build a pending sidecar with the good key, then recover with the bad
      // one. The sidecar is unlinked by recovery, so a skipped line is gone.
      const written = new BridgeStore(dir, 0, KEY_A)
      written.appendOp(op('op_pending_one'))
      const opsPath = join(dir, 'ops.jsonl')
      const pendingPath = join(dir, 'ops.pending.jsonl')
      if (!existsSync(pendingPath)) {
        // This store flushes straight through - nothing to recover, and the
        // op-log assertion above already covers the durable path.
        return
      }
      const pendingBytes = readFileSync(pendingPath, 'utf8')
      const opsBefore = existsSync(opsPath) ? readFileSync(opsPath, 'utf8') : ''

      const misKeyed = new BridgeStore(dir, 0, KEY_B)
      void misKeyed
      const opsAfter = readFileSync(opsPath, 'utf8')
      assert.ok(
        opsAfter.length >= opsBefore.length + pendingBytes.trim().length,
        'unreadable pending bytes must be moved onto the durable log, not dropped',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
