import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import WebSocket from 'ws'
import { BridgeStore } from '../src/store.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'

async function until<T>(read: () => T | undefined, detail: string): Promise<T> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out: ${detail}`)
}
const dir = mkdtempSync(join(tmpdir(), 'bridge-team-origin-'))
const sockets: WebSocket[] = []
let child: ReturnType<typeof spawn> | undefined
let output = ''
try {
  const store = new BridgeStore(dir, 21, null)
  const admin = store.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', displayName: 'Admin' })
  assert.ok(admin.ok)
  const invite = store.createInvite(admin.member.memberId, 'peer@example.test', 'admin')
  assert.ok(invite.ok)
  const peer = await store.redeemInvite({ token: invite.invite.token, deviceId: 'peer-device', displayName: 'Peer', memberEmail: 'peer@example.test' })
  assert.ok(peer.ok)
  const expectedTeam = JSON.parse(readFileSync(join(dir, 'team.json'), 'utf8')).teamId
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  initializeCurrentAuthority(dir,dir+'.authority')
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', chunk => { output += String(chunk) })
  child.stderr!.on('data', chunk => { output += String(chunk) })
  await until(() => output.includes('bridge listening') ? true : undefined, 'bridge startup')
  async function connect(memberId: string, deviceId: string, sessionToken: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`)
    sockets.push(ws)
    const frames: any[] = []
    ws.on('message', data => frames.push(JSON.parse(String(data))))
    await once(ws, 'open')
    ws.send(JSON.stringify({ type: 'hello', memberId, deviceId, sessionToken, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
    await until(() => frames.find(f => f.type === 'hello_ok'), 'authenticated hello')
    await until(() => frames.find(f => f.type === 'catchup_status' && f.done), 'initial catch-up')
    return { ws, frames }
  }
  const observer = await connect(peer.member.memberId, 'peer-device', peer.sessionToken)
  const sender = await connect(admin.member.memberId, 'admin-device', admin.sessionToken)
  const canonicalOp = {
    opId: 'spoof-team', kind: 'module.create', targetKind: 'module', targetId: 'shared-module',
    team_id: 'victim-team-b', teamId: 'victim-team-c',
    originDevice: 'fake-device', hopCount: 0, protocolVersion: BRIDGE_PROTOCOL_VERSION,
    hlc: '0/test', patch: { name: 'Shared' },
  }
  sender.ws.send(JSON.stringify({ type: 'ops', frameId: 'spoof-team', ops: [canonicalOp] }))
  await until(() => sender.frames.find(f => f.type === 'ops_result' && f.frameId === 'spoof-team'), 'writer durable result')
  const live = await until(() => observer.frames.flatMap(f => f.type === 'ops' ? f.ops : []).find(op => op.opId === 'spoof-team'), 'live peer delivery')
  assert.equal(live.team_id, expectedTeam)
  assert.equal(live.teamId, expectedTeam)
  const deliveredBeforeRetry = observer.frames
    .flatMap(f => f.type === 'ops' ? f.ops : [])
    .filter(op => op.opId === 'spoof-team').length

  sender.ws.send(JSON.stringify({ type: 'ops', frameId: 'exact-retry', ops: [canonicalOp] }))
  const exactRetry = await until(
    () => sender.frames.find(f => f.type === 'ops_result' && f.frameId === 'exact-retry'),
    'exact retry result',
  )
  assert.equal(exactRetry.results[0]?.status, 'applied', 'exact lost-ACK retry remains idempotently applied')

  sender.ws.send(JSON.stringify({
    type: 'ops',
    frameId: 'conflicting-retry',
    ops: [{ ...canonicalOp, patch: { name: 'Altered replay' } }],
  }))
  const conflictingRetry = await until(
    () => sender.frames.find(f => f.type === 'ops_result' && f.frameId === 'conflicting-retry'),
    'conflicting retry result',
  )
  assert.equal(conflictingRetry.results[0]?.status, 'refused')
  assert.equal(conflictingRetry.results[0]?.permanent, true)
  await new Promise(resolve => setTimeout(resolve, 150))
  const deliveredAfterRetries = observer.frames
    .flatMap(f => f.type === 'ops' ? f.ops : [])
    .filter(op => op.opId === 'spoof-team')
  assert.equal(deliveredAfterRetries.length, deliveredBeforeRetry, 'neither replay fans out')
  assert.equal(deliveredAfterRetries.some(op => op.patch?.name === 'Altered replay'), false)
  observer.ws.terminate()
  await until(() => observer.ws.readyState === WebSocket.CLOSED ? true : undefined, 'observer disconnect')
  const reconnect = await connect(peer.member.memberId, 'peer-device', peer.sessionToken)
  const replay = await until(() => reconnect.frames.flatMap(f => f.type === 'ops' ? f.ops : []).find(op => op.opId === 'spoof-team'), 'durable replay')
  assert.equal(replay.team_id, expectedTeam)
  assert.equal(replay.teamId, expectedTeam)
  assert.equal(replay.originDevice, 'admin-device')
  console.log('modules team origin live: authenticated team stamp plus exact/conflicting opId replay isolation passed')
} catch (error) {
  console.error(output)
  throw error
} finally {
  for (const ws of sockets) ws.terminate()
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
