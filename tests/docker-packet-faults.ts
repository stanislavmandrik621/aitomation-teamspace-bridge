/** Real Docker + a controllable websocket proxy. Never uses the user's server. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { referenceClock, newerReferenceClock } from '../src/content-reference-data.js'

type Frame = Record<string, any>
const token = randomUUID().slice(0, 8), container = `aitomation-packet-audit-${token}`
const output = resolve('../../docs/docker-collaboration-audit-2026-09-09/docker-packet-faults')
mkdirSync(output, { recursive: true })
if (existsSync(resolve(output, 'results.json'))) {
  mkdirSync(resolve(output, 'attempts'), { recursive: true })
  writeFileSync(resolve(output, 'attempts', `${Date.now()}.json`), readFileSync(resolve(output, 'results.json')))
}
const report: Frame = { startedAt: new Date().toISOString(), status: 'running', boundary: 'Authenticated protocol clients through a real websocket fault proxy to a temporary Docker server. Durable replay uses production clock ordering. This does not verify native draft UI or native resume-cursor handling.', cases: [] }
const persist = () => writeFileSync(resolve(output, 'results.json'), JSON.stringify(report, null, 2))
const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms))
async function until(fn: () => boolean, label: string) {
  const deadline = Date.now() + 20000
  while (!fn()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await sleep(10) }
}
async function check(id: string, work: () => Promise<unknown>) {
  const row: Frame = { id, status: 'running' }; report.cases.push(row); persist()
  try { row.detail = await work(); row.status = 'passed' }
  catch (error) { row.status = 'failed'; row.error = String(error); throw error }
  finally { persist(); console.log(row.status, id) }
}
let serial = 0, port = 0, proxy: WebSocketServer | undefined
const sockets: WebSocket[] = []
let holdWrites = false, dropAck = false, dropPeer = false
const held: Array<() => void> = []
class Client {
  ws: WebSocket; frames: Frame[] = []; ops = new Map<string, Frame>(); deliveries: string[] = []; credential: Frame = {}
  constructor(address: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${address}`); sockets.push(this.ws)
    this.ws.on('error', () => {})
    this.ws.on('message', bytes => {
      const frame = JSON.parse(String(bytes)); this.frames.push(frame)
      if (frame.type === 'ops') for (const op of frame.ops) { this.ops.set(op.opId, op); this.deliveries.push(op.opId) }
    })
  }
  async wait(match: (frame: Frame) => boolean, label: string) {
    await until(() => this.frames.some(match), label)
    return this.frames.splice(this.frames.findIndex(match), 1)[0]
  }
  send(frame: Frame) { const frameId = `${token}-frame-${++serial}`; this.ws.send(JSON.stringify({ ...frame, frameId })); return frameId }
  async request(frame: Frame) {
    const id = this.send(frame)
    return this.wait(reply => reply.frameId === id || reply.requestId === id, frame.type)
  }
  async auth(credential: Frame) {
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open')
    this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, ...credential }))
    const reply = await this.wait(frame => ['hello_ok', 'hello_refuse'].includes(frame.type), 'hello')
    assert.equal(reply.type, 'hello_ok', JSON.stringify(reply))
    this.credential = { ...credential, sessionToken: reply.sessionToken || credential.sessionToken }
    await this.wait(frame => frame.type === 'catchup_status' && frame.done, 'catchup')
    return this
  }
}
const moduleId = `fault-module-${token}`, entityId = `fault-entity-${token}`, recordId = `fault-record-${token}`
const op = (kind: string, targetId: string, patch: Frame, hlc?: string): Frame => ({ opId: `${token}-op-${++serial}`, kind, targetKind: kind.split('.')[0], targetId, moduleId, entityId, patch, hlc: hlc || `${Date.now()}:${serial}:fault-audit`, protocolVersion: 2, hopCount: 0 })
const accepted = (reply: Frame) => { assert.equal(reply.type, 'ops_result', JSON.stringify(reply)); assert.ok(reply.results.every((item: Frame) => item.status === 'applied'), JSON.stringify(reply)) }
function values(client: Client) {
  const cells = new Map<string, { value: unknown; clock: NonNullable<ReturnType<typeof referenceClock>> }>()
  for (const operation of client.ops.values()) {
    if (operation.targetId !== recordId) continue
    for (const [key, value] of Object.entries(operation.patch?.data ?? {})) {
      const clock = referenceClock(operation.patch.cellHlcs?.[key] || operation.hlc)!
      if (!cells.has(key) || newerReferenceClock(clock, cells.get(key)!.clock)) cells.set(key, { value, clock })
    }
  }
  return Object.fromEntries([...cells].map(([key, cell]) => [key, cell.value]))
}
try {
  execFileSync('docker', ['run', '--rm', '-d', '--name', container, '-p', '127.0.0.1::8788', 'aitomation-collab-audit:20260909'], { stdio: 'pipe' })
  port = Number(execFileSync('docker', ['port', container, '8788'], { encoding: 'utf8' }).trim().split(':').at(-1))
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break } catch {}
    assert.ok(attempt < 100, 'Docker health'); await sleep(100)
  }
  proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(proxy, 'listening')
  proxy.on('connection', downstream => {
    const upstream = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(downstream, upstream)
    const waiting: string[] = []
    upstream.on('error', () => downstream.close()); downstream.on('error', () => upstream.close())
    upstream.on('open', () => waiting.splice(0).forEach(raw => upstream.send(raw)))
    downstream.on('message', bytes => {
      const raw = String(bytes), frame = JSON.parse(raw)
      const forward = () => { if (upstream.readyState === WebSocket.OPEN) upstream.send(raw); else waiting.push(raw) }
      if (holdWrites && frame.type === 'ops') held.push(forward); else forward()
    })
    upstream.on('message', bytes => {
      const frame = JSON.parse(String(bytes))
      if (dropAck && frame.type === 'ops_result') { dropAck = false; return }
      if (dropPeer && frame.type === 'ops') { dropPeer = false; return }
      if (downstream.readyState === WebSocket.OPEN) downstream.send(bytes)
    })
    downstream.on('close', () => upstream.terminate())
    upstream.on('close', () => downstream.close())
  })
  const proxyPort = (proxy.address() as { port: number }).port
  const admin = await new Client(port).auth({ memberId: `fault-admin-${token}`, deviceId: `fault-admin-${token}`, memberEmail: `${token}@example.test`, displayName: 'Packet fault audit' })
  const freshObserver = async () => {
    const id = ++serial, email = `${token}-observer-${id}@example.test`, deviceId = `observer-${id}`
    const invite = await admin.request({ type: 'invite_create', email, role: 'viewer' })
    assert.equal(invite.type, 'invite_ok')
    const observer = new Client(port); await once(observer.ws, 'open')
    const joined = await observer.request({ type: 'invite_redeem', token: invite.token, deviceId, memberEmail: email, displayName: 'Recovery observer' })
    assert.equal(joined.type, 'invite_redeem_ok')
    return observer.auth({ memberId: joined.memberId, deviceId, sessionToken: joined.sessionToken })
  }
  const invite = await admin.request({ type: 'invite_create', email: `${token}-member@example.test`, role: 'member' })
  assert.equal(invite.type, 'invite_ok')
  let member = new Client(proxyPort); await once(member.ws, 'open')
  const joined = await member.request({ type: 'invite_redeem', token: invite.token, deviceId: `fault-member-${token}`, memberEmail: `${token}-member@example.test`, displayName: 'Proxy member' })
  assert.equal(joined.type, 'invite_redeem_ok')
  await member.auth({ memberId: joined.memberId, deviceId: `fault-member-${token}`, sessionToken: joined.sessionToken })
  const seed = [op('module.create', moduleId, { id: moduleId, name: 'Packet audit' }), op('entity.create', entityId, { id: entityId, module_id: moduleId, name: 'Records' }), ...['name', 'other'].map(slug => op('field.create', `${token}-${slug}`, { entity_id: entityId, slug, name: slug, field_type: 'text' })), op('record.create', recordId, { id: recordId, entity_id: entityId, data: { name: 'baseline', other: 'baseline' } })]
  accepted(await admin.request({ type: 'ops', ops: seed })); await until(() => seed.every(item => member.ops.has(item.opId)), 'seed at member')
  await check('docker-proxy-lost-ack-exact-retry-after-reconnect', async () => {
    const change = op('record.update', recordId, { data: { name: 'saved without acknowledgement' } })
    dropAck = true; const frameId = member.send({ type: 'ops', ops: [change] })
    await until(() => admin.ops.has(change.opId) && !dropAck, 'accepted despite lost reply')
    assert.ok(!member.frames.some(frame => frame.frameId === frameId))
    const credential = member.credential; member.ws.terminate()
    member = await new Client(proxyPort).auth(credential)
    accepted(await member.request({ type: 'ops', ops: [change] }))
    // Same-device replay omits that device's own operations; native clients
    // retain those in their local journal. Verify durability independently.
    const observer = await freshObserver()
    assert.ok(observer.ops.has(change.opId)); assert.equal(admin.deliveries.filter(id => id === change.opId).length, 1)
    return { replyDroppedAfterAcceptance: true, exactRetryAcknowledged: true, freshObserverReplayed: true, retryDuplicateFanouts: 0 }
  })
  await check('docker-proxy-reversed-writes-retain-independent-fields-and-clock-winner', async () => {
    const wall = Date.now(), changes = [op('record.update', recordId, { data: { name: 'older delayed' } }, `${wall}:1:proxy`), op('record.update', recordId, { data: { other: 'independent retained' } }, `${wall}:2:proxy`), op('record.update', recordId, { data: { name: 'newer delivered first' } }, `${wall}:3:proxy`)]
    holdWrites = true; const ids = changes.map(change => member.send({ type: 'ops', ops: [change] }))
    await until(() => held.length === 3, 'three delayed frames')
    holdWrites = false; held.splice(0).reverse().forEach(forward => forward())
    for (const id of ids) accepted(await member.wait(frame => frame.frameId === id, 'reordered result'))
    await until(() => changes.every(change => admin.ops.has(change.opId)), 'all reversed operations')
    assert.deepEqual(values(admin), { name: 'newer delivered first', other: 'independent retained' })
    return { reversedApplicationFrames: 3, acceptedVersionsRetained: 3, productionClockWinner: 'newer delivered first' }
  })
  await check('docker-proxy-dropped-peer-frame-recovered-from-durable-history', async () => {
    const missed = op('record.update', recordId, { data: { other: 'recover dropped peer update' } })
    dropPeer = true; accepted(await admin.request({ type: 'ops', ops: [missed] }))
    // The writer keeps its accepted local operation; the server fans out to peers.
    admin.ops.set(missed.opId, missed)
    await until(() => !dropPeer, 'peer frame dropped'); assert.equal(member.ops.has(missed.opId), false)
    const credential = member.credential; member.ws.terminate(); member = await new Client(proxyPort).auth(credential)
    assert.ok(member.ops.has(missed.opId))
    assert.equal(values(member).other, 'recover dropped peer update')
    assert.deepEqual(values(await freshObserver()), values(admin))
    return { peerFrameDropped: true, fullCatchupRecovers: true, note: 'Full replay; native incremental cursor recovery is a separate pending check.' }
  })
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = String(error instanceof Error ? error.stack : error); console.error(report.error); process.exitCode = 1 }
finally {
  for (const socket of sockets) socket.terminate()
  proxy?.close()
  try { execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' }) } catch {}
  report.finishedAt = new Date().toISOString(); persist()
}
