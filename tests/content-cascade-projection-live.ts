/** Real bridge fanout, full/tail replay, and retry identity for projected cascades. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'cascade-projection-live-'))
const sockets: WebSocket[] = []
let child: ReturnType<typeof spawn> | undefined, logs = '', serial = 0
const op = (kind: string, targetId: string, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `cascade-live-${++serial}`, kind, targetId, targetKind: kind.split('.')[0],
  originRole: 'admin', originMemberId: 'admin', originDevice: 'admin', hlc: `${serial}:0:admin`, protocolVersion: 2, hopCount: 0,
  moduleId: 'm', ...extra,
})
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}\n${logs}`)
}
try {
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'cascade-team', name: 'Cascade test', createdAt: 1 }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify(['admin', 'alice', 'bob'].map(memberId => ({
    memberId, displayName: memberId, email: `${memberId}@example.test`, createdAt: 1,
    role: memberId === 'admin' ? 'admin' : 'member', sessions: { [memberId]: hashSessionToken(`${memberId}-token`) },
  }))))
  const store = new BridgeStore(dir, 21, null, null)
  const root = op('module.create', 'm', { visibleToMemberIds: ['alice'] })
  const seeds = [root, op('entity.create', 'e', { entityId: 'e' }),
    ...['a', 'b', 'c', 'd'].map(targetId => op('record.create', targetId, { entityId: 'e', patch: { sort_order: 0 } }))]
  const historical = op('cascade.patch', 'a', { targetKind: 'record', entityId: 'e',
    patch: { reorderKind: 'record', entityId: 'e', order: [{ id: 'a', sort_order: 10, prev_sort_order: 0 }, { id: 'b', sort_order: 11, prev_sort_order: 0 }] } })
  store.appendOps([...seeds, historical, op('record.delete', 'b', { entityId: 'e' })])
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
  initializeCurrentAuthority(dir,dir+'.authority')
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
  })
  let listening = false
  child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) listening = true })
  child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, 'test recovery key redacted')).slice(-6000) })
  await until(() => listening || undefined, 'startup')
  async function connect(memberId: string) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`), frames: any[] = []
    sockets.push(socket)
    socket.on('message', data => frames.push(JSON.parse(String(data))))
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId, deviceId: memberId, sessionToken: `${memberId}-token` }))
    await until(() => frames.find(frame => frame.type === 'hello_ok'), 'hello')
    await until(() => frames.find(frame => frame.type === 'catchup_status' && frame.done), 'catchup complete')
    const delivered = () => frames.flatMap(frame => frame.type === 'ops' ? frame.ops : []) as ModulesSyncOp[]
    const request = async (frame: Record<string, unknown>) => {
      socket.send(JSON.stringify(frame))
      return until(() => frames.find(row => row.frameId === frame.frameId), 'request response')
    }
    return { socket, frames, delivered, request }
  }
  const admin = await connect('admin'), alice = await connect('alice'), bob = await connect('bob')
  const replay = alice.delivered().find(row => row.opId === historical.opId)!
  assert.ok(replay, 'full replay must retain a surviving row from the historical reorder')
  assert.deepEqual(replay.patch!.order, [historical.patch!.order[0]])
  assert.equal(bob.delivered().length, 0, 'projection never opens another member module')
  const liveReorder = op('cascade.patch', 'c', { targetKind: 'record', entityId: 'e',
    patch: { reorderKind: 'record', entityId: 'e', order: [{ id: 'c', sort_order: 20, prev_sort_order: 0 }, { id: 'd', sort_order: 21, prev_sort_order: 0 }] } })
  const deleted = op('record.delete', 'c', { entityId: 'e' })
  const result = await admin.request({ type: 'ops', frameId: 'later-delete-live', ops: [liveReorder, deleted] })
  assert.equal(result.type, 'ops_result', JSON.stringify(result))
  assert.deepEqual(result.results.map((row: any) => row.status), ['applied', 'applied'])
  const live = await until(() => alice.delivered().find(row => row.opId === liveReorder.opId), 'surviving live projection')
  assert.equal(live.targetId, 'd', 'later primary deletion reanchors the live frame')
  assert.deepEqual(live.patch!.order, [liveReorder.patch!.order[1]])
  assert.equal(bob.delivered().length, 0)
  const before = alice.delivered().filter(row => row.opId === liveReorder.opId).length
  const retry = await admin.request({ type: 'ops', frameId: 'original-retry', ops: [liveReorder] })
  assert.equal(retry.results[0]?.status, 'applied', 'projection never replaces the original retry body')
  const conflict = await admin.request({ type: 'ops', frameId: 'changed-retry', ops: [{ ...liveReorder, patch: { ...liveReorder.patch, order: [{ id: 'd', sort_order: 99 }] } }] })
  assert.equal(conflict.results[0]?.status, 'refused', 'retargeted copy is not an exact authored retry')
  assert.equal(alice.delivered().filter(row => row.opId === liveReorder.opId).length, before)
  // Mark one seed receipt so reconnect takes the recent-tail branch, leaving
  // the projected reorder deliberately unacked to exercise redelivery.
  await alice.request({ type: 'ack_ops', frameId: 'ack-root', deviceId: 'alice', opIds: [root.opId] })
  alice.socket.terminate()
  const tail = await connect('alice')
  const tailRow = tail.delivered().find(row => row.opId === liveReorder.opId)!
  assert.ok(tailRow, 'tail replay delivers the safe surviving projection')
  assert.deepEqual(tailRow.patch!.order, live.patch!.order)
  assert.equal(tailRow.targetId, 'd')
  const revoke = op('module.share_revoked', 'm', { visibleToMemberIds: ['alice'] })
  const revoked = await admin.request({ type: 'ops', frameId: 'revoke', ops: [revoke] })
  assert.equal(revoked.results[0]?.status, 'applied')
  tail.socket.terminate()
  const removed = await connect('alice')
  assert.equal(removed.delivered().some(row => row.kind === 'cascade.patch'), false, 'reconnect projection respects current root revocation')
  console.log('cascade projection live: historical/full replay, later-delete fanout, tail replay, exact retry identity and revocation passed')
} finally {
  for (const socket of sockets) socket.terminate()
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
