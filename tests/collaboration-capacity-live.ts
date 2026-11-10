/** Real TCP/WS, durable files, default connection/admission caps, and crash recovery.
 * Run explicitly: node --import tsx tests/collaboration-capacity-live.ts
 * The default 200 sessions join in paced batches to respect the per-IP hello budget.
 * This is a bounded local integration workload, not a production throughput SLA.
 */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import WebSocket from 'ws'
import { BridgeStore } from '../src/store.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'

type Frame = Record<string, any>
type Credential = { memberId: string; deviceId: string; sessionToken: string }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function until(predicate: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await sleep(10)
  }
}
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] * 100) / 100
}

async function main() {
  const count = Number(process.env.CAPACITY_CLIENTS || 200)
  assert.ok(Number.isInteger(count) && count >= 2 && count <= 200)
  const dir = mkdtempSync(join(tmpdir(), 'bridge-capacity-live-'))
  const sockets: WebSocket[] = []
  let child: ChildProcess | undefined
  let logs = ''
  const credentials: Credential[] = []
  const reserve = createServer().listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const port = (reserve.address() as { port: number }).port
  await new Promise<void>((resolve) => reserve.close(() => resolve()))
  async function start() {
    const env = { ...process.env }
    // Reproducible defaults, independent of operator secrets/settings in the shell.
    for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let ready = false
    child.stdout!.on('data', (data) => { logs = (logs + String(data)).slice(-12_000); if (String(data).includes('bridge listening')) ready = true })
    child.stderr!.on('data', (data) => { logs = (logs + String(data)).slice(-12_000) })
    await until(() => { assert.equal(child!.exitCode, null, logs); return ready }, 'server startup')
  }
  async function connect(credential: Credential) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const responses = new Map<string, Frame>()
    const ops = new Set<string>()
    const chats = new Set<string>()
    let hello = false, caughtUp = false, errors = 0
    ws.on('error', () => { errors++ })
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Frame
      if (frame.type === 'hello_ok') hello = true
      if (frame.type === 'catchup_status' && frame.done) caughtUp = true
      if (frame.type === 'ops') for (const op of frame.ops) ops.add(op.opId)
      if (frame.type === 'chat_peer') chats.add(frame.message.id)
      if (frame.type === 'hello_refuse') throw new Error(`hello refused: ${frame.reason}`)
      const id = frame.frameId || frame.requestId
      if (id && !String(id).startsWith('fan-') && !String(id).startsWith('catchup')) responses.set(id, frame)
    })
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, ...credential }))
    await until(() => hello && caughtUp, 'authenticated catch-up')
    const request = async (frame: Frame) => {
      ws.send(JSON.stringify(frame))
      await until(() => responses.has(frame.frameId), `response ${frame.frameId}`)
      const result = responses.get(frame.frameId)!
      responses.delete(frame.frameId)
      return result
    }
    return { ws, ops, chats, request, get errors() { return errors } }
  }
  try {
    const store = new BridgeStore(dir, 21)
    const admin = store.helloOrBootstrap({ memberId: 'capacity-admin', deviceId: 'device-0', memberEmail: 'admin@example.test', displayName: 'Capacity Admin' })
    assert.ok(admin.ok)
    credentials.push({ memberId: admin.member.memberId, deviceId: 'device-0', sessionToken: admin.sessionToken })
    for (let i = 1; i < count; i++) {
      const email = `capacity-${i}@example.test`
      const invite = store.createInvite(admin.member.memberId, email, 'member')
      assert.ok(invite.ok)
      const member = await store.redeemInvite({ token: invite.invite.token, deviceId: `device-${i}`, memberEmail: email, displayName: `Capacity ${i}` })
      assert.ok(member.ok)
      credentials.push({ memberId: member.member.memberId, deviceId: `device-${i}`, sessionToken: member.sessionToken })
    }
    initializeCurrentAuthority(dir,dir+'.authority')
    await start()
    const clients: Awaited<ReturnType<typeof connect>>[] = []
    for (let i = 0; i < count; i += 25) {
      if (i) await sleep(10_100)
      clients.push(...await Promise.all(credentials.slice(i, i + 25).map(connect)))
      console.log(`capacity: ${clients.length}/${count} authenticated sockets`)
    }
    if (count === 200) {
      const excess = new WebSocket(`ws://127.0.0.1:${port}`)
      excess.on('error', () => {})
      const [code] = await once(excess, 'close')
      assert.equal(code, 1013, 'connection 201 must be refused explicitly')
    }
    const opLatency: number[] = [], chatLatency: number[] = []
    const started = performance.now()
    const operationsPerClient = 10
    await Promise.all(clients.map(async (client, i) => {
      const begin = performance.now()
      const result = await client.request({ type: 'ops', frameId: `load-ops-${i}`, ops: Array.from({ length: operationsPerClient }, (_, j) => ({
        opId: `capacity-op-${i}-${j}`, kind: 'record.update', targetKind: 'record', targetId: `record-${j}`, entityId: 'capacity-entity', moduleId: 'capacity-module',
        patch: { data: { [`field_${i}`]: `value-${j}` } }, hlc: `${Date.now()}:${String(j).padStart(4, '0')}:capacity-${i}`, originDevice: 'forged', hopCount: 0, protocolVersion: BRIDGE_PROTOCOL_VERSION,
      })) })
      assert.equal(result.type, 'ops_result', JSON.stringify(result))
      assert.equal(result.results.length, operationsPerClient)
      assert.ok(result.results.every((row: Frame) => row.status === 'applied'), JSON.stringify(result.results))
      opLatency.push(performance.now() - begin)
    }))
    await until(() => clients.every((client) => client.ops.size === (count - 1) * operationsPerClient), 'all operations delivered to every other session')
    await Promise.all(clients.map(async (client, i) => {
      const begin = performance.now()
      const reply = await client.request({ type: 'chat_send', frameId: `load-chat-${i}`, room: 'chat:team', clientMsgId: `capacity-chat-${i}`, body: `Message ${i}` })
      assert.equal(reply.type, 'chat_ok', JSON.stringify(reply))
      chatLatency.push(performance.now() - begin)
    }))
    await until(() => clients.every((client) => client.chats.size === count - 1), 'all chat messages delivered to every other session')
    const workloadMs = Math.round(performance.now() - started)
    const presence = await clients[0].request({ type: 'presence_get', frameId: 'load-presence' })
    assert.equal(presence.peers.length, count)
    assert.ok(clients.every((client) => client.ws.readyState === WebSocket.OPEN && client.errors === 0))
    // Crash after durable acknowledgement, without graceful drain.
    const exited = once(child!, 'exit')
    child!.kill('SIGKILL')
    await exited
    for (const client of clients) client.ws.terminate()
    await start()
    const recovered = await connect(credentials[0])
    assert.equal(recovered.ops.size, (count - 1) * operationsPerClient, 'unacked remote operations survive abrupt restart')
    const historyIds = new Set<string>()
    let before: number | undefined, beforeId: string | undefined
    for (let page = 0; page < count + 1; page++) {
      const history = await recovered.request({ type: 'chat_history', frameId: `recovery-history-${page}`, room: 'chat:team', limit: 100, before, beforeId })
      assert.equal(history.type, 'chat_history_ok', JSON.stringify(history))
      for (const message of history.messages) historyIds.add(message.id)
      if (historyIds.size >= count || !history.messages.length) break
      const oldest = [...history.messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))[0]
      assert.ok(Number.isFinite(oldest.createdAt), 'history cursor has a timestamp')
      before = oldest.createdAt; beforeId = oldest.id
    }
    assert.equal(historyIds.size, count, 'all acknowledged chat messages survive abrupt restart')
    const retry = await recovered.request({ type: 'chat_send', frameId: 'retry-after-crash', room: 'chat:team', clientMsgId: 'capacity-chat-0', body: 'must not overwrite original' })
    assert.equal(retry.type, 'chat_ok')
    assert.equal(retry.message.body, 'Message 0', 'retry uses original durable message')
    const report = { measuredAt: new Date().toISOString(), scope: 'local real-server integration; default caps, paced same-IP joins; no WAN/TLS/storage SLA', clients: count, operations: count * operationsPerClient,
      operationPeerDeliveries: count * (count - 1) * operationsPerClient, chatMessages: count, chatPeerDeliveries: count * (count - 1), workloadMs,
      opsAckMs: { p50: percentile(opLatency, .5), p95: percentile(opLatency, .95), max: percentile(opLatency, 1) }, chatAckMs: { p50: percentile(chatLatency, .5), p95: percentile(chatLatency, .95), max: percentile(chatLatency, 1) },
      abruptRestartRecovery: true, retryIdempotency: true, presenceComplete: true, capacityRefusal: count === 200 }
    if (process.env.CAPACITY_REPORT) writeFileSync(process.env.CAPACITY_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    console.error(logs)
    throw error
  } finally {
    for (const socket of sockets) socket.terminate()
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}
void main().catch((error) => { console.error(error); process.exitCode = 1 })
