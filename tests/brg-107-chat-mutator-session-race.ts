/**
 * Authorize at commit time, after queue waits and disk reads. Revocation must
 * prevent persistence; disconnect after persistence must not suppress peer
 * fanout (covered separately by the live postcommit server regression).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ChatStore } from '../src/chat-store.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-precommit-auth-'))
const store = new ChatStore(dir, 90)
const inner = (store as any).inner
const room = 'chat:team'
const input = (id: string) => ({ id, room, body: `body-${id}`, memberId: 'alice', memberName: 'Alice', role: 'member' as const })
const requireOk = (value: any) => { assert.ok(!('error' in value), JSON.stringify(value)); return value }
try {
  for (const id of ['edit', 'react', 'pin', 'unpin', 'delete', 'unsend', 'duplicate']) requireOk(await store.append(input(id)))
  requireOk(await store.pinMessage(room, 'unpin', true))
  store.flushAllPendingChatIndexes()
  const historyPath = join(dir, 'chat/rooms/team/messages.jsonl')
  const beforeHistory = readFileSync(historyPath, 'utf8')
  const beforePins = store.getPinnedMessageIds(room)
  let authorized = true
  let checks = 0
  const authorize = () => { checks++; return authorized }
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const blocker = inner.queueRoomWrite(room, async () => { entered(); await held })
  await started
  const pending = [
    store.append({ ...input('new'), authorize }),
    store.append({ ...input('duplicate'), authorize }),
    store.edit('edit', 'alice', 'changed', false, room, undefined, authorize),
    store.react('react', 'alice', '👍', false, room, authorize),
    store.pinMessage(room, 'pin', true, authorize),
    store.unpinMessage(room, 'unpin', true, authorize),
    store.softDelete('delete', 'admin', room, authorize),
    store.authorUnsend('unsend', 'alice', false, room, authorize),
    store.setPinned(room, 'pin', true, authorize),
  ]
  // Let all pre-queue lookups settle while authority still exists.
  await new Promise<void>(resolve => setImmediate(resolve))
  authorized = false
  release()
  await blocker
  for (const result of await Promise.all(pending)) {
    assert.ok('error' in result, 'queued revocation must fail before persistence')
    assert.equal((result as { error: string }).error, 'Session is no longer authorized')
  }
  assert.equal(checks, pending.length, 'every mutator checks the live authority inside its queue turn')
  assert.equal(readFileSync(historyPath, 'utf8'), beforeHistory, 'revocation leaves durable messages unchanged')
  assert.deepEqual(store.getPinnedMessageIds(room), beforePins, 'revocation leaves pin metadata unchanged')

  // A lookup inside a running queue turn can await disk too. Checking only
  // at queue entry is insufficient when revocation lands during that read.
  authorized = true
  let resumeLookup!: () => void
  let lookupEntered!: () => void
  const lookupGate = new Promise<void>(resolve => { resumeLookup = resolve })
  const lookupStarted = new Promise<void>(resolve => { lookupEntered = resolve })
  const originalFind = inner.findById.bind(inner)
  let lookups = 0
  inner.findById = async (...args: any[]) => {
    const found = await originalFind(...args)
    if (++lookups === 2) { lookupEntered(); await lookupGate }
    return found
  }
  const delayedEdit = store.edit('edit', 'alice', 'changed-after-read', false, room, undefined, authorize)
  await lookupStarted
  authorized = false
  resumeLookup()
  assert.deepEqual(await delayedEdit, { error: 'Session is no longer authorized' })
  assert.equal(readFileSync(historyPath, 'utf8'), beforeHistory)
  inner.findById = originalFind

  // Refusals never wedge future work; an authorized writer can still use it.
  authorized = true
  requireOk(await store.append({ ...input('allowed-after-refusal'), authorize }))
  requireOk(await store.edit('edit', 'alice', 'allowed edit', false, room, undefined, authorize))
  requireOk(await store.react('react', 'alice', '👍', false, room, authorize))
  requireOk(await store.pinMessage(room, 'pin', true, authorize))
  requireOk(await store.unpinMessage(room, 'unpin', true, authorize))
  requireOk(await store.softDelete('delete', 'admin', room, authorize))
  requireOk(await store.authorUnsend('unsend', 'alice', false, room, authorize))
  store.flushAllPendingChatIndexes()
  const restarted = new ChatStore(dir, 90)
  assert.equal((await restarted.findById('edit', room))?.body, 'allowed edit')
  assert.ok((await restarted.findById('delete', room))?.deletedAt)
  assert.deepEqual(restarted.getPinnedMessageIds(room), ['pin'])
  restarted.flushAllPendingChatIndexes()
  console.log('brg-107: nine queued revocations, in-queue disk-read revocation, unchanged disk/pins, queue recovery and persisted authorized mutations passed')
} finally {
  store.flushAllPendingChatIndexes()
  rmSync(dir, { recursive: true, force: true })
}
