import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
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
const dir = mkdtempSync(join(tmpdir(), 'bridge-fanout-disconnect-'))
const sockets: WebSocket[] = []
let child: ReturnType<typeof spawn> | undefined
let output = ''
try {
  const store = new BridgeStore(dir, 21, null)
  const admin = store.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', displayName: 'Admin' })
  assert.ok(admin.ok)
  const invite = store.createInvite(admin.member.memberId, 'writer@example.test', 'admin')
  assert.ok(invite.ok)
  const writer = await store.redeemInvite({ token: invite.invite.token, deviceId: 'writer-device', displayName: 'Writer', memberEmail: 'writer@example.test' })
  assert.ok(writer.ok)
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  initializeCurrentAuthority(dir,dir+'.authority')
  child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/fanout-fault-server.ts'], {
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
  const observer = await connect(admin.member.memberId, 'admin-device', admin.sessionToken)
  const sender = await connect(writer.member.memberId, 'writer-device', writer.sessionToken)
  sender.ws.send(JSON.stringify({ type: 'ops', frameId: 'fault-ack', ops: [{
    // A root create is independently authorizable; an entity without a
    // module owner is now correctly refused before this ACK fault is reached.
    opId: 'committed-op', kind: 'module.create', targetKind: 'module', targetId: 'record',
    originDevice: 'writer-device', hopCount: 0, protocolVersion: BRIDGE_PROTOCOL_VERSION, hlc: '0/test', patch: { name: 'committed' },
  }] }))
  await until(() => observer.frames.find(f => f.type === 'ops' && f.ops?.some((op: any) => op.opId === 'committed-op')), 'healthy observer receives op despite failed writer ACK')
  await until(() => sender.ws.readyState === WebSocket.CLOSED ? true : undefined, 'failed writer disconnected')
  assert.equal(observer.ws.readyState, WebSocket.OPEN)

  const chatSender = await connect(writer.member.memberId, 'writer-device', writer.sessionToken)
  chatSender.ws.send(JSON.stringify({ type: 'chat_send', frameId: 'disconnect-chat', room: 'chat:team', clientMsgId: 'committed-chat', body: 'committed sender disconnect' }))
  await until(() => {
    const refused = chatSender.frames.find(f => f.type === 'chat_refuse')
    if (refused) throw new Error(`Chat refused: ${refused.reason}`)
    return output.includes('FAULT_CHAT_COMMITTED') ? true : undefined
  }, 'real chat append committed')
  chatSender.ws.terminate()
  await until(() => observer.frames.find(f => f.type === 'chat_peer' && f.message?.id === 'committed-chat'), 'healthy observer receives chat after sender disconnected')
  assert.equal(observer.ws.readyState, WebSocket.OPEN)
  for (const [type, method, peerType, extra] of [
    ['chat_edit', 'edit', 'chat_edit_peer', { body: 'edited after commit' }],
    ['chat_react', 'react', 'chat_react_peer', { emoji: '👍' }],
    ['chat_pin', 'pinMessage', 'chat_pin_peer', { pinned: true }],
    ['chat_delete', 'softDelete', 'chat_delete_peer', {}],
  ] as const) {
    const mutator = await connect(writer.member.memberId, 'writer-device', writer.sessionToken)
    mutator.ws.send(JSON.stringify({ type, frameId: type, room: 'chat:team', messageId: 'committed-chat', ...extra }))
    await until(() => {
      const refused = mutator.frames.find(f => f.type === 'chat_refuse')
      if (refused) throw new Error(`${type} refused: ${refused.reason}`)
      return output.includes(`FAULT_${method}_COMMITTED`) ? true : undefined
    }, `${type} committed`)
    mutator.ws.terminate()
    await until(() => observer.frames.find(f => f.type === peerType), `${type} fans out after disconnect`)
  }
  const slow = await connect(writer.member.memberId, 'writer-device', writer.sessionToken)
  slow.ws.send(JSON.stringify({ type: 'presence_get', frameId: 'fault-backpressure' }))
  await until(() => output.includes('FAULT_SLOW_PEER_READY') ? true : undefined, 'slow socket backpressure active')
  observer.ws.send(JSON.stringify({ type: 'chat_send', frameId: 'healthy-chat', room: 'chat:team', clientMsgId: 'healthy-chat', body: 'healthy writer continues' }))
  await until(() => observer.frames.find(f => f.type === 'chat_ok' && f.frameId === 'healthy-chat'), 'healthy writer chat ack')
  await until(() => slow.ws.readyState === WebSocket.CLOSED ? true : undefined, 'slow peer must reconnect after failed durable fanout')
  assert.equal(observer.ws.readyState, WebSocket.OPEN)
  console.log('fanout-disconnect-live: Modules ACK failure, chat/edit/react/pin/delete sender disconnect after commit, slow chat consumer reconnect all passed')
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
