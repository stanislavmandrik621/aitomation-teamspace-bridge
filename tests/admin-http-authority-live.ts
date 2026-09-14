/** Held real HTTP bodies must not retain authority after demotion or revocation. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'
import { hashSessionToken } from '../src/store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'

const dir = mkdtempSync(join(tmpdir(), 'bridge-http-authority-'))
const sockets: WebSocket[] = []
const requests: ReturnType<typeof request>[] = []
let child: ReturnType<typeof spawn> | undefined
try {
  const roster = ['owner', 'demoted', 'revoked', 'kicked', 'alice', 'bob'].map((memberId, i) => ({
    memberId, email: `${memberId}@example.test`, displayName: memberId, role: 'admin',
    sessions: { [memberId === 'alice' || memberId === 'bob' ? 'workstation' : `${memberId}-device`]: hashSessionToken(`${memberId}-token`) }, createdAt: i + 1,
  }))
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'team_http_auth', name: 'Test', createdAt: 1 }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify(roster))
  writeFileSync(join(dir, 'ops.jsonl'), ['alice', 'owner'].map(memberId => JSON.stringify({ opId: `${memberId}-op`, kind: 'record.create', targetId: `${memberId}-record`, originDevice: memberId === 'alice' ? 'workstation' : 'owner-device', originMemberId: memberId, protocolVersion: BRIDGE_PROTOCOL_VERSION, hlc: `${Date.now()}-0-device`, patch: {} })).join('\n') + '\n')
  initializeCurrentAuthority(dir,dir+'.authority')
  const server = createServer().listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_AT_REST_KEY: '' },
  })
  let logs = ''
  child.stderr!.on('data', chunk => { logs += String(chunk) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Bridge startup timed out: ${logs}`)), 20_000)
    child!.stdout!.on('data', chunk => { if (String(chunk).includes('bridge listening')) { clearTimeout(timer); resolve() } })
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${logs}`)) })
  })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
  sockets.push(ws)
  await once(ws, 'open')
  let next = 0
  function send(frame: Record<string, unknown>, type: string, target = ws): Promise<Record<string, any>> {
    const frameId = `request-${++next}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { target.off('message', onMessage); reject(new Error(`Missing ${type}`)) }, 5000)
      const onMessage = (raw: WebSocket.RawData) => {
        const result = JSON.parse(String(raw))
        if (result.frameId !== frameId && !(type === 'hello_ok' && result.type === type)) return
        clearTimeout(timer); target.off('message', onMessage)
        if (result.type !== type) reject(new Error(JSON.stringify(result)))
        else resolve(result)
      }
      target.on('message', onMessage)
      target.send(JSON.stringify({ ...frame, frameId }))
    })
  }
  await send({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, memberId: 'owner', deviceId: 'owner-device', sessionToken: 'owner-token' }, 'hello_ok')
  async function catchup(memberId: 'alice' | 'bob') {
    const target = new WebSocket(`ws://127.0.0.1:${port}/`)
    sockets.push(target)
    const opIds: string[] = []
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Missing ${memberId} catchup`)), 5000)
      target.on('message', raw => {
        const frame = JSON.parse(String(raw))
        if (frame.type === 'ops') opIds.push(...frame.ops.map((op: any) => op.opId))
        if (frame.type === 'catchup_status' && frame.done) { clearTimeout(timer); resolve() }
      })
    })
    await once(target, 'open')
    await send({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, memberId, deviceId: 'workstation', sessionToken: `${memberId}-token` }, 'hello_ok', target)
    await done
    return { target, opIds: opIds.sort() }
  }
  const alice = await catchup('alice')
  assert.deepEqual(alice.opIds, ['owner-op'])
  await send({ type: 'ack_ops', opIds: ['owner-op', 'alice-op'] }, 'ack_ops_ok', alice.target)
  const bob = await catchup('bob')
  assert.deepEqual(bob.opIds, ['alice-op', 'owner-op'], 'another member on the same device receives both foreign-origin and independently unacked changes')
  await send({ type: 'ack_ops', opIds: ['owner-op'] }, 'ack_ops_ok', bob.target)
  const bobAgain = await catchup('bob')
  assert.deepEqual(bobAgain.opIds, ['alice-op'], 'reconnect keeps only this member’s own checkpoint')
  const base = `http://127.0.0.1:${port}`
  async function held(path: string, token: string, body: Buffer, method = 'POST') {
    let resolveResponse!: (value: { status: number; body: any }) => void
    let rejectResponse!: (error: Error) => void
    const response = new Promise<{ status: number; body: any }>((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject })
    const req = request(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-length': body.length, expect: '100-continue', 'content-type': 'application/json' } }, res => {
      let text = ''
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk })
      res.on('end', () => { try { resolveResponse({ status: res.statusCode!, body: JSON.parse(text) }) } catch (error) { rejectResponse(error as Error) } })
    })
    requests.push(req)
    req.on('error', rejectResponse)
    const admitted = once(req, 'continue')
    req.flushHeaders()
    // Node sends this from its default Expect handler immediately before
    // invoking the real route, which then reaches its body await in that turn.
    await admitted
    return { finish: () => req.end(body), response }
  }
  const routes = [
    '/v1/invite/create', '/v1/invite/cancel', '/v1/invite/revoke', '/v1/limits',
    '/v1/public-share/register', '/v1/public-share/payload', '/v1/public-share/revoke', '/v1/public-share/submissions',
    '/v1/portal/register', '/v1/portal/revoke', '/v1/portal/submissions', '/v1/portal/otp-ack',
    '/v1/compose-share/register', '/v1/compose-share/revoke', '/v1/teamspace/compose-acl',
  ]
  const body = Buffer.from(JSON.stringify({ email: 'new-admin@example.test', role: 'admin', chatSendPerMin: 100 }))
  const pending = []
  for (const path of routes) pending.push(await held(path, 'demoted-token', body, path === '/v1/limits' ? 'PATCH' : 'POST'))
  const blob = Buffer.from('a synthetic module attachment held until write access is withdrawn')
  const sha = createHash('sha256').update(blob).digest('hex')
  const upload = await held(`/v1/blobs/${sha}`, 'demoted-token', blob, 'PUT')
  const demotedChatBlob = Buffer.from('a held chat attachment from a writer who becomes a viewer')
  const demotedChatSha = createHash('sha256').update(demotedChatBlob).digest('hex')
  const demotedChatUpload = await held('/v1/chat/blobs', 'demoted-token', demotedChatBlob)
  await send({ type: 'set_role', memberId: 'demoted', role: 'viewer' }, 'set_role_ok')
  for (const entry of pending) entry.finish()
  upload.finish()
  demotedChatUpload.finish()
  const results = await Promise.all(pending.map(entry => entry.response))
  for (let i = 0; i < results.length; i++) {
    assert.equal(results[i].status, 401, `${routes[i]}: ${JSON.stringify(results[i])}`)
    assert.match(results[i].body.error, /no longer authorized/i)
  }
  assert.equal((await upload.response).status, 403)
  assert.equal(existsSync(join(dir, 'blobs', sha)), false, 'revoked upload cannot publish a blob')
  assert.equal((await demotedChatUpload.response).status, 403)
  assert.equal(
    existsSync(join(dir, 'chat', 'blobs', demotedChatSha)),
    false,
    'a held chat attachment cannot commit after its writer becomes a viewer',
  )
  for (const [memberId, frame, ack] of [
    ['revoked', { type: 'revoke_session', memberId: 'revoked', deviceId: 'revoked-device' }, 'revoke_ok'],
    ['kicked', { type: 'kick_member', memberId: 'kicked' }, 'kick_ok'],
  ] as const) {
    const entry = await held('/v1/invite/create', `${memberId}-token`, body)
    const kickedChatBlob = Buffer.from(`held chat attachment for ${memberId}`)
    const kickedChatSha = createHash('sha256').update(kickedChatBlob).digest('hex')
    const kickedChatUpload = memberId === 'kicked'
      ? await held('/v1/chat/blobs', `${memberId}-token`, kickedChatBlob)
      : null
    // Minimal PNG signature + IHDR-shaped bytes: enough for the avatar store's
    // format admission if the post-body authority guard ever regresses.
    const kickedAvatar = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ])
    const kickedAvatarSha = createHash('sha256').update(kickedAvatar).digest('hex')
    const kickedAvatarUpload = memberId === 'kicked'
      ? await held('/v1/chat/avatars', `${memberId}-token`, kickedAvatar)
      : null
    await send(frame, ack)
    entry.finish()
    kickedChatUpload?.finish()
    kickedAvatarUpload?.finish()
    assert.equal((await entry.response).status, 401, `${memberId} bearer must fail at commit`)
    if (kickedChatUpload && kickedAvatarUpload) {
      assert.equal((await kickedChatUpload.response).status, 403)
      assert.equal((await kickedAvatarUpload.response).status, 401)
      assert.equal(
        existsSync(join(dir, 'chat', 'blobs', kickedChatSha)),
        false,
        'a held chat attachment cannot commit after membership removal',
      )
      assert.equal(
        existsSync(join(dir, 'chat', 'avatars', kickedAvatarSha)),
        false,
        'a held avatar cannot commit after membership removal',
      )
    }
  }
  const invites = existsSync(join(dir, 'invites.json')) ? JSON.parse(readFileSync(join(dir, 'invites.json'), 'utf8')) : []
  assert.equal(invites.length, 0, 'no stale administrator request minted an invite')
  const good = await fetch(base + '/v1/invite/create', { method: 'POST', headers: { authorization: 'Bearer owner-token', 'content-type': 'application/json' }, body: JSON.stringify({ email: 'allowed@example.test', role: 'member' }) })
  assert.equal(good.status, 200, 'remaining administrator can still create an invite')
  const member = await fetch(base + '/v1/limits', { headers: { authorization: 'Bearer demoted-token' } })
  assert.equal(member.status, 200, 'a role downgrade preserves permitted member reads')
  console.log('HTTP authority: delayed admin routes, CRM/chat/avatar uploads, token revoke, role downgrade, member kick, permitted writes/reads and shared-device member catch-up passed')
} finally {
  for (const req of requests) req.destroy()
  for (const ws of sockets) ws.terminate()
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
