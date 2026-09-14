/** Real disk store -> JSON wire payload -> renderer merge, including delayed replay. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'
import { ChatRoomHistoryStore } from '../src/chat-room-history-store.js'
import { toChatMessagePayload } from '../src/chat-message-payload.js'
import { mergeChatByClientMsgId } from '../../../apps/desktop/src/lib/teamspace-chat-outbox.js'
import type { TeamSpaceChatMessage } from '../../../apps/desktop/src/lib/teamspace-chat-room.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-concurrent-transcript-'))
const now = Date.now
const store = new ChatStore(dir, 90)
const row = (value: any): any => { assert.ok(!('error' in value), JSON.stringify(value)); return value }
const wire = (value: any): TeamSpaceChatMessage => JSON.parse(JSON.stringify(toChatMessagePayload(row(value))))
try {
  // Freeze the clock to exercise genuine same-millisecond edit/reaction ordering.
  Date.now = () => 1_800_000_000_000
  const initial = row(await store.append({ room: 'chat:team', body: 'initial', memberId: 'alice', memberName: 'Alice', role: 'member', id: 'concurrent' }))
  const edits = await Promise.all(Array.from({ length: 64 }, (_, i) => store.edit(initial.id, 'alice', `edit-${i}`, false, 'chat:team')))
  edits.forEach(row)
  for (let i = 1; i < edits.length; i++) assert.ok(row(edits[i]).editedAt > row(edits[i - 1]).editedAt)
  const adds = await Promise.all(Array.from({ length: 100 }, (_, i) => store.react(initial.id, `member-${i}`, '👍', false, 'chat:team')))
  adds.forEach(row)
  assert.equal(row(adds.at(-1)).reactions['👍'].length, 100)
  const removals = await Promise.all(Array.from({ length: 100 }, (_, i) => store.react(initial.id, `member-${i}`, '👍', true, 'chat:team')))
  removals.forEach(row)
  const current = wire(row(removals.at(-1)))
  assert.deepEqual(current.reactions, {})
  assert.ok(current.lastReactAt! > wire(row(adds.at(-1))).lastReactAt!)
  let transcript = [wire(initial)]
  for (const update of [...edits, ...adds, ...removals]) transcript = mergeChatByClientMsgId(transcript, wire(update))
  assert.equal(transcript[0].body, 'edit-63')
  assert.deepEqual(transcript[0].reactions, {}, 'live reaction removals must clear all reactors')
  // Reconnect loads newest history first, then flushes buffered old frames.
  transcript = [wire((await store.readRecent('chat:team')).messages[0])]
  for (const update of [...removals, ...adds, ...edits, initial].reverse()) transcript = mergeChatByClientMsgId(transcript, wire(update))
  assert.equal(transcript[0].body, 'edit-63', 'delayed edit cannot rewind history')
  assert.deepEqual(transcript[0].reactions, {}, 'delayed reaction cannot resurrect a removed reactor')
  assert.equal(transcript[0].editedAt, current.editedAt)
  assert.equal(transcript[0].lastReactAt, current.lastReactAt)
  // A complete tombstone cannot be undone by a stale ack/history frame.
  const tomb = row(await store.softDelete(initial.id, 'alice', 'chat:team'))
  transcript = mergeChatByClientMsgId(transcript, wire(tomb))
  transcript = mergeChatByClientMsgId(transcript, current)
  assert.equal(transcript[0].body, '')
  assert.ok(transcript[0].deletedAt)
  store.flushAllPendingChatIndexes()
  const restarted = new ChatStore(dir, 90)
  const persisted = row(await restarted.findById(initial.id, 'chat:team'))
  assert.ok(persisted.deletedAt, 'tombstone survives process-store reopen')
  restarted.flushAllPendingChatIndexes()

  // Per-room FIFO alone does not serialize the globally shared ID namespace.
  const colliding = await Promise.all(['chat:team', 'chat:g:g1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'].map(room => store.append({ room, body: room, memberId: 'alice', memberName: 'Alice', role: 'member', id: 'cross-room-race' })))
  assert.equal(colliding.filter(x => !('error' in x)).length, 1, 'only one room may commit a global ID')
  assert.match((colliding.find(x => 'error' in x) as { error: string }).error, /another room/)
  const duplicate = await Promise.all(Array.from({ length: 30 }, () => store.append({ room: 'chat:team', body: 'retry', memberId: 'alice', memberName: 'Alice', role: 'member', id: 'same-room-retry' })))
  assert.equal(duplicate.filter(x => !('unchanged' in x)).length, 1)

  // A completed old disk snapshot can resume after a concurrent mutation.
  // Warming its page into the shared cache used to lose that reaction on
  // the NEXT edit (the stale cache became a new durable history record).
  const raced = new ChatRoomHistoryStore(join(dir, 'stale-read-case'), 90, 90, null)
  const readMessage = row(await raced.append({ room: 'chat:team', body: 'before', memberId: 'alice', memberName: 'Alice', role: 'member', id: 'stale-read' }))
  const readInternals = raced as any
  const scan = readInternals.scanRoomFile.bind(raced)
  let snapshotTaken!: () => void
  let finishRead!: () => void
  const snapshotGate = new Promise<void>(resolve => { snapshotTaken = resolve })
  const readGate = new Promise<void>(resolve => { finishRead = resolve })
  readInternals.scanRoomFile = async (...args: any[]) => { const snapshot = await scan(...args); snapshotTaken(); await readGate; return snapshot }
  const historyRead = raced.readRecent('chat:team')
  await snapshotGate
  row(await raced.react(readMessage.id, 'bob', '👍', false, 'chat:team'))
  finishRead()
  await historyRead
  const postReadEdit = row(await raced.edit(readMessage.id, 'alice', 'after', false, 'chat:team'))
  assert.deepEqual(postReadEdit.reactions, { '👍': ['bob'] }, 'stale history must not poison the mutation cache')
  raced.flushAllPendingChatIndexes()
  const readRestart = new ChatStore(join(dir, 'stale-read-case'), 90)
  assert.deepEqual(row(await readRestart.findById(readMessage.id, 'chat:team')).reactions, { '👍': ['bob'] })
  readRestart.flushAllPendingChatIndexes()

  // Tail wrap preserves physical append order and the honest truncation flag
  // after several rotations, including edits with the same creation clock.
  const tailPath = join(dir, 'tail-fixture.jsonl')
  const tailRows = Array.from({ length: 120_003 }, (_, i) => JSON.stringify({ ...initial, id: `tail-${i}`, body: `body-${i}` }))
  tailRows.push(JSON.stringify({ ...initial, id: 'tail-120002', body: 'newest edit' }))
  writeFileSync(tailPath, tailRows.join('\n') + '\n')
  const tailResult = await scan(tailPath, 'chat:team')
  assert.equal(tailResult.scanTruncated, true)
  assert.equal(tailResult.byId.size, 49_999)
  assert.equal(tailResult.byId.has('tail-70003'), false)
  assert.equal(tailResult.byId.get('tail-70004').body, 'body-70004')
  assert.equal(tailResult.byId.get('tail-120002').body, 'newest edit')
  assert.equal((await readInternals.scanRoomFileForId(tailPath, 'tail-120002', 'chat:team')).body, 'newest edit')

  // Hold a real room prune at its queue boundary so mutation peeks see the
  // pre-prune row, then let retention remove it before queued writes run.
  const prunedDir = join(dir, 'prune-case')
  const inner = new ChatRoomHistoryStore(prunedDir, 1, 90, null)
  const expired = row(await inner.append({ room: 'chat:team', body: 'expired', memberId: 'alice', memberName: 'Alice', role: 'member', id: 'expired' }))
  let entered!: () => void
  let release!: () => void
  const enteredGate = new Promise<void>(resolve => { entered = resolve })
  const releaseGate = new Promise<void>(resolve => { release = resolve })
  const internals = inner as any
  const pruneRoom = internals.pruneRoomFile.bind(inner)
  internals.pruneRoomFile = async (...args: any[]) => { entered(); await releaseGate; return pruneRoom(...args) }
  Date.now = () => 1_800_000_000_000 + 3 * 86_400_000
  const pruning = inner.prune()
  await enteredGate
  const mutations = [inner.edit(expired.id, 'alice', 'resurrect', true, 'chat:team'), inner.react(expired.id, 'bob', '👍', false, 'chat:team'), inner.softDelete(expired.id, 'alice', 'chat:team')]
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  assert.equal(await pruning, 1)
  for (const mutation of await Promise.all(mutations)) assert.ok('error' in mutation, 'a pre-prune peek must never recreate a removed row')
  assert.deepEqual((await inner.readRecent('chat:team')).messages, [])
  inner.flushAllPendingChatIndexes()
  console.log('chat concurrency: 64 edits, 200 reaction toggles, delayed replay, tombstones/reopen, global ID collision, 30 retries stale history cache, 120004-line tail wrap and prune/mutation race passed')
} finally {
  Date.now = now
  store.flushAllPendingChatIndexes()
  rmSync(dir, { recursive: true, force: true })
}
