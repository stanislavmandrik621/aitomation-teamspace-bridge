/** Real HTTP + WS claims share one durable single-use boundary. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BridgeStore, hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
const root = mkdtempSync(join(tmpdir(), 'invite-concurrency-live-'))
const token = 'fixture-admin-bearer'
let child: ReturnType<typeof spawn> | undefined, port = 0, logs = ''
const sockets: WebSocket[] = []
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const end = Date.now() + 15000
  while (Date.now() < end) {
    const result = read()
    if (result !== undefined) return result
    if (child?.exitCode != null) throw new Error(`Bridge exited: ${logs}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timeout ${label}: ${logs}`)
}
async function stop() {
  for (const socket of sockets.splice(0)) socket.terminate()
  if (child && child.exitCode === null) {
    const running = child, done = once(running, 'exit')
    const timer = setTimeout(() => running.kill('SIGKILL'), 5000)
    running.kill('SIGTERM')
    try { await done } finally { clearTimeout(timer) }
  }
  child = undefined
}
async function start() {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
  let ready = false
  logs = ''
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TEAMSPACE_DATA_DIR: root, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port),
      TEAMSPACE_INVITE_TOKENS: '200', TEAMSPACE_HTTP_TOKENS: '1000', TEAMSPACE_ADMIN_HTTP_MUTATE_TOKENS: '100' },
  })
  child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) ready = true })
  child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, '[fixture key redacted]')).slice(-5000) })
  await until(() => ready || undefined, 'startup')
}
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`), frames: Frame[] = []
  sockets.push(socket)
  socket.on('message', bytes => frames.push(JSON.parse(String(bytes))))
  await once(socket, 'open')
  return { socket, frames }
}
async function post(path: string, body: Frame, admin = false) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', ...(admin ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() as Frame }
}
async function hello(credential: Frame, deviceId: string) {
  const peer = await connect()
  peer.socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, deviceId, memberId: credential.memberId, sessionToken: credential.sessionToken }))
  return until(() => peer.frames.find(frame => frame.type === 'hello_ok' || frame.type === 'hello_refuse'), 'hello')
}
async function pausedClaim(plain: string) {
  const body = JSON.stringify({ token: plain, deviceId: 'held-device' })
  let finish!: () => void
  const result = new Promise<{ status: number; body: Frame }>((resolve, reject) => {
    const req = httpRequest(`http://127.0.0.1:${port}/v1/invite/redeem`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), expect: '100-continue' },
    }, res => {
      let response = ''
      res.on('data', part => { response += part })
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(response) }))
    })
    req.on('error', reject)
    req.on('continue', () => { req.write(body.slice(0, -1)); finish = () => req.end(body.slice(-1)) })
    req.setTimeout(15000, () => req.destroy(new Error('held claim timeout')))
    req.flushHeaders()
  })
  await until(() => finish || undefined, 'request body paused')
  return { finish, result }
}

try {
  writeFileSync(join(root, 'team.json'), JSON.stringify({ teamId: 'invite-team-a', name: 'A', createdAt: 1 }))
  writeFileSync(join(root, 'members.json'), JSON.stringify([{ memberId: 'admin', email: 'admin@example.test', displayName: 'Admin', role: 'admin', sessions: { admin: hashSessionToken(token) }, createdAt: 1 }]))
  const store = new BridgeStore(root, 21, null, null)
  const mint = (email = '') => { const reply = store.createInvite('admin', email, 'member'); assert.equal(reply.ok, true); if (!reply.ok) throw new Error(reply.reason); return reply.invite }
  const simultaneous = mint(), canceled = mint(), resumable = mint(), independent = Array.from({ length: 12 }, (_, i) => mint(`member-${i}@example.test`))
  const otherRoot = mkdtempSync(join(tmpdir(), 'invite-other-team-'))
  let foreignToken: string
  try {
    const other = new BridgeStore(otherRoot, 21, null, null)
    const invite = other.createInvite('other-admin', '', 'member')
    assert.equal(invite.ok, true)
    if (!invite.ok) throw new Error(invite.reason)
    foreignToken = invite.invite.token
  } finally { rmSync(otherRoot, { recursive: true, force: true }) }
  initializeCurrentAuthority(root,root+'.authority')
  await start()
  const peers = await Promise.all(Array.from({ length: 12 }, connect))
  const wsClaims = peers.map((peer, i) => {
    peer.socket.send(JSON.stringify({ type: 'invite_redeem', frameId: `ws-${i}`, token: simultaneous.token, deviceId: `ws-${i}` }))
    return until(() => peer.frames.find(frame => frame.frameId === `ws-${i}` || frame.requestId === `ws-${i}`), 'WS claim')
      .then(body => ({ deviceId: `ws-${i}`, body }))
  })
  const httpClaims = Array.from({ length: 12 }, (_, i) => post('/v1/invite/redeem', { token: simultaneous.token, deviceId: `http-${i}` })
    .then(reply => ({ deviceId: `http-${i}`, body: reply.body })))
  const claims = await Promise.all([...wsClaims, ...httpClaims])
  const winners = claims.filter(({ body }) => body.ok === true || body.type === 'invite_redeem_ok')
  assert.equal(winners.length, 1, '24 HTTP and WS redeemers must mint exactly one member/session')
  const winner = winners[0]!
  assert.equal((await hello(winner.body, winner.deviceId)).type, 'hello_ok')
  assert.equal((await hello(winner.body, 'wrong-device')).type, 'hello_refuse')
  const foreign = await post('/v1/invite/redeem', { token: foreignToken, deviceId: 'foreign' })
  assert.equal(foreign.body.ok, false, 'another team token cannot mint this team membership')
  const held = await pausedClaim(canceled.token)
  const cancel = await post('/v1/invite/revoke', { id: canceled.id }, true)
  assert.equal(cancel.body.ok, true, JSON.stringify(cancel))
  held.finish()
  assert.equal((await held.result).body.ok, false, 'cancel completed during body await must win over later claim')
  const independentReplies = await Promise.all(independent.map((invite, i) => post('/v1/invite/redeem', { token: invite.token, deviceId: `independent-${i}` })))
  assert.ok(independentReplies.every(reply => reply.body.ok === true), 'different invite claims must all complete without roster overwrite')
  assert.equal(new Set(independentReplies.map(reply => reply.body.memberId)).size, 12)
  const nonce = 'a'.repeat(64), resumeBody = { token: resumable.token, deviceId: 'resumable-device', redemptionNonce: nonce }
  const resumableReplies = await Promise.all(Array.from({ length: 8 }, () => post('/v1/invite/redeem', resumeBody)))
  assert.ok(resumableReplies.every(reply => reply.body.ok === true), 'same strong attempt retries all recover one committed grant')
  assert.equal(new Set(resumableReplies.map(reply => reply.body.sessionToken)).size, 1)
  assert.equal(new Set(resumableReplies.map(reply => reply.body.memberId)).size, 1)
  const recovered = resumableReplies[0]!.body
  const liveRecovered = await connect()
  liveRecovered.socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, deviceId: resumeBody.deviceId, memberId: recovered.memberId, sessionToken: recovered.sessionToken }))
  await until(() => liveRecovered.frames.find(frame => frame.type === 'hello_ok'), 'recovered live session')
  for (const forged of [{ redemptionNonce: 'b'.repeat(64) }, { redemptionNonce: 'A'.repeat(64) }, { redemptionNonce: ['a'.repeat(64)] }, { deviceId: 'other-device' }]) {
    assert.equal((await post('/v1/invite/redeem', { ...resumeBody, ...forged })).body.ok, false)
  }
  const replayPeer = await connect()
  replayPeer.socket.send(JSON.stringify({ type: 'invite_redeem', frameId: 'strong-replay', ...resumeBody }))
  const replay = await until(() => replayPeer.frames.find(frame => frame.frameId === 'strong-replay' || frame.requestId === 'strong-replay'), 'WS replay')
  assert.equal(replay.type, 'invite_redeem_ok')
  assert.equal(replay.sessionToken, recovered.sessionToken)
  assert.equal((await post('/v1/invite/redeem', resumeBody)).body.sessionToken, recovered.sessionToken)
  assert.equal(liveRecovered.socket.readyState, WebSocket.OPEN, 'idempotent retries must not log out healthy existing peers')
  await stop()
  const roster = JSON.parse(readFileSync(join(root+'.authority', 'members.json'), 'utf8')) as Frame[]
  assert.equal(roster.length, 15, 'admin + one single-use winner + 12 independent members + one resumable member persisted')
  assert.equal(roster.some(row => Object.hasOwn(row.sessions, 'held-device')), false)
  await start()
  assert.equal((await hello(winner.body, winner.deviceId)).type, 'hello_ok', 'winner survives restart')
  assert.equal((await post('/v1/invite/redeem', { token: simultaneous.token, deviceId: winner.deviceId })).body.ok, false, 'completed single-use claim cannot replay after restart')
  assert.equal((await post('/v1/invite/redeem', resumeBody)).body.sessionToken, recovered.sessionToken, 'same strong attempt recovers identical credential after restart')
  const mintLive = async (role = 'member') => {
    const created = await post('/v1/invite/create', { email: 'multi-project@example.test', role }, true)
    assert.equal(created.body.ok, true)
    return created.body.token as string
  }
  const joinHttp = async (deviceId: string, role = 'member') => {
    const joined = await post('/v1/invite/redeem', { token: await mintLive(role), deviceId })
    assert.equal(joined.body.ok, true)
    const peer = await connect()
    peer.socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, deviceId, memberId: joined.body.memberId, sessionToken: joined.body.sessionToken }))
    assert.equal((await until(() => peer.frames.find(f => f.type === 'hello_ok' || f.type === 'hello_refuse'), 'additional project hello')).type, 'hello_ok')
    return { ...peer, credential: joined.body }
  }
  let pingNumber = 0
  const checkLive = async (peer: Awaited<ReturnType<typeof connect>>) => {
    const t = ++pingNumber
    assert.equal(peer.socket.readyState, WebSocket.OPEN)
    peer.socket.send(JSON.stringify({ type: 'ping', t }))
    await until(() => peer.frames.find(f => f.type === 'pong' && f.t === t), 'preserved project response')
  }
  const projectA = await joinHttp('project-a'), projectB = await joinHttp('project-b')
  assert.equal(projectA.credential.memberId, projectB.credential.memberId)
  await checkLive(projectA)
  const projectC = await connect()
  projectC.socket.send(JSON.stringify({ type: 'invite_redeem', frameId: 'additional-c', token: await mintLive(), deviceId: 'project-c' }))
  const credentialC = await until(() => projectC.frames.find(f => f.frameId === 'additional-c' || f.requestId === 'additional-c'), 'additional WS project')
  assert.equal(credentialC.type, 'invite_redeem_ok')
  await checkLive(projectA)
  await checkLive(projectB)
  const replacement = await joinHttp('project-a')
  await until(() => projectA.socket.readyState === WebSocket.CLOSED || undefined, 'replaced bearer closes')
  await checkLive(projectB)
  assert.equal((await hello(credentialC, 'project-c')).type, 'hello_ok')
  const viewer = await joinHttp('project-viewer', 'viewer')
  await until(() => projectB.socket.readyState === WebSocket.CLOSED && replacement.socket.readyState === WebSocket.CLOSED || undefined, 'role change closes old bearers')
  assert.equal((await hello(credentialC, 'project-c')).type, 'hello_refuse')
  await checkLive(viewer)
  console.log('additional projects live: HTTP/WS joins preserve sibling sessions; replacing a device closes only its old bearer; role change revokes every old bearer')
  console.log('invite concurrency live: 24 mixed HTTP/WS single-use claims, 12 independent concurrent claims, strong attempt replay across protocols/restart without logout, exact device binding, foreign-team refusal and paused-body cancellation passed')
} finally {
  await stop()
  rmSync(root, { recursive: true, force: true })
  rmSync(root+'.authority', { recursive: true, force: true })
}
