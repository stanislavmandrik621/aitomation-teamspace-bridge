/** Real Admin WS + guest HTTP: old cached/schema/default bytes stop at ACL CAS. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

type Frame = Record<string, any>
type Authority = { revision: number; hash: string; bag: unknown }
type Reply = { status: number; body: Frame; text: string }
const dir = mkdtempSync(join(tmpdir(), 'guest-field-acl-live-'))
const team = 'guest-acl-team', token = 'guest-acl-admin-token'
const marker = '__teamspaceFieldAclBaseHash'
const hidden = ['PRIVATE_ROW_GUEST_ACL', 'PRIVATE_SCHEMA_GUEST_ACL', 'PRIVATE_DEFAULT_GUEST_ACL']
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const publicToken = 'guest-acl-public-token', portalToken = 'guest-acl-portal-token', legacyToken = 'guest-acl-legacy-token'
const payloadPath = (kind: 'public' | 'portal', plain: string) => join(dir+'.authority', kind === 'public' ? 'public-share-payloads' : 'portal-payloads', `${digest(plain)}.json`)
let child: ReturnType<typeof spawn> | undefined, logs = '', port = 0, serial = 0
const sockets: WebSocket[] = []
const heldRequests = new Set<ReturnType<typeof httpRequest>>()
const op = (kind: string, id: string, extra: Record<string, unknown> = {}): ModulesSyncOp => ({
  opId: `guest-acl-${++serial}`, kind, targetKind: kind.split('.')[0], targetId: id, moduleId: 'module',
  originMemberId: 'admin', originDevice: 'admin', originRole: 'admin', protocolVersion: 2, hopCount: 0,
  hlc: `${serial}:0:admin`, ...extra,
})
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const end = Date.now() + 15_000
  while (Date.now() < end) {
    const value = read()
    if (value !== undefined) return value
    if (child?.exitCode != null) throw new Error(`Bridge exited during ${label}: ${logs}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}\n${logs}`)
}
async function stop(): Promise<void> {
  for (const req of heldRequests) req.destroy()
  heldRequests.clear()
  for (const socket of sockets.splice(0)) socket.terminate()
  if (child && child.exitCode === null) {
    const owned = child, exited = once(owned, 'exit')
    const timeout = setTimeout(() => owned.kill('SIGKILL'), 5000)
    owned.kill('SIGTERM')
    try { await exited } finally { clearTimeout(timeout) }
  }
  child = undefined
}
async function start(): Promise<void> {
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
  logs = ''
  let listening = false
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port),
      TEAMSPACE_ADMIN_HTTP_MUTATE_TOKENS: '100' },
  })
  child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) listening = true })
  child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, 'test recovery key redacted')).slice(-5000) })
  await until(() => listening || undefined, 'bridge startup')
}
async function connect() {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`), frames: Frame[] = []
  sockets.push(socket)
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId: 'admin', deviceId: 'admin', sessionToken: token }))
  const hello = await until(() => frames.find(frame => frame.type === 'hello_ok'), 'Admin hello')
  assert.ok(hello.fieldAclAuthority)
  return {
    authority: hello.fieldAclAuthority as Authority,
    async tighten(current: Authority): Promise<Authority> {
      const frameId = `tighten-${++serial}`
      const bag = { version: current.revision + 1, entities: [], fields: [
        { entityId: 'entity', fieldSlug: `private_${current.revision}`, role: 'member', read: false, write: false, hidden: true },
      ] }
      socket.send(JSON.stringify({ type: 'ops', frameId, ops: [op('module.update', 'module', {
        fieldAclBaseHash: current.hash, patch: { config: { teamSpaceAclGrantBag: bag } },
      })] }))
      const reply = await until(() => frames.find(frame => frame.type === 'ops_result' && frame.frameId === frameId), frameId)
      assert.equal(reply.results[0]?.status, 'applied', JSON.stringify(reply))
      assert.equal(reply.fieldAclAuthority.revision, current.revision + 1)
      return reply.fieldAclAuthority as Authority
    },
  }
}
async function request(path: string, body?: unknown, admin = false): Promise<Reply> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(admin ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return { status: response.status, body: JSON.parse(text), text }
}
function payload(kind: 'public' | 'portal', secret: boolean): Frame {
  const fields = [{ slug: secret ? 'private_0' : 'public', name: secret ? hidden[1] : 'Public field', field_type: 'text', required: false,
    config: {}, default_value: secret ? hidden[2] : null }]
  return kind === 'public'
    ? { version: 2, mode: 'read', viewType: 'table', label: 'Public fixture', entityId: 'entity', fields,
      rows: [{ id: 'record', data: secret ? { private_0: hidden[0] } : { public: 'FRESH_PUBLIC_CONTENT' } }], total: 1, truncated: false, includeCsv: true, pushedAt: 1 }
    : { version: 1, portalId: 'portal', name: 'Portal fixture', entityId: 'entity', authMode: 'anonymous', allowedActions: ['create'],
      design: {}, aclSnapshot: { hiddenSlugs: [] }, fields, pushedAt: 1 }
}
function publishBody(kind: 'public' | 'portal', hash: unknown, secret: boolean): Frame {
  return { teamId: team, fieldAclBaseHash: hash, payload: payload(kind, secret),
    ...(kind === 'public'
      ? { token_hash: digest(publicToken), local_share_id: 'public', mode: 'read', view_type: 'table', include_csv: true }
      : { token_hash: digest(portalToken), local_portal_id: 'portal', name: 'Portal', auth_mode: 'anonymous', allowed_actions: ['create'] }),
  }
}
async function pausedRequest(path: string, body: Frame) {
  const bytes = Buffer.from(JSON.stringify(body)), split = Math.floor(bytes.length / 2)
  let receive!: (reply: Reply) => void, fail!: (error: Error) => void
  const result = new Promise<Reply>((resolve, reject) => { receive = resolve; fail = reject })
  // Attach a rejection handler immediately; a failed test still closes owned sockets.
  void result.catch(() => {})
  const req = httpRequest(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: {
    Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`,
    'Content-Length': bytes.length, Expect: '100-continue',
  } }, res => {
    const chunks: Buffer[] = []
    res.on('data', chunk => chunks.push(Buffer.from(chunk)))
    res.on('end', () => {
      heldRequests.delete(req)
      try { const text = Buffer.concat(chunks).toString(); receive({ status: res.statusCode!, body: JSON.parse(text), text }) }
      catch (error) { fail(error as Error) }
    })
  })
  heldRequests.add(req)
  req.on('error', fail)
  req.setTimeout(10_000, () => req.destroy(new Error('Paused publication timed out')))
  const continued = once(req, 'continue')
  req.flushHeaders()
  await continued // Server admitted headers and entered its asynchronous body reader.
  req.write(bytes.subarray(0, split))
  return { finish: () => { req.end(bytes.subarray(split)); return result } }
}
async function assertUnavailable(): Promise<void> {
  for (const [kind, plain] of [['share', publicToken], ['portal', portalToken], ['share', legacyToken]]) {
    const read = await request(`/${kind}/${plain}`)
    assert.equal(read.status, 200)
    assert.equal(read.body.content, null, 'registered metadata may remain, but stale content must not')
    for (const value of [...hidden, marker]) assert.equal(read.text.includes(value), false)
    const intake = await request(`/${kind}/${plain}`, { action: 'create', data: { private_0: 'obsolete input' } })
    assert.equal(intake.status, 503, intake.text)
    for (const value of hidden) assert.equal(intake.text.includes(value), false)
  }
}
try {
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: team, name: 'Guest ACL test', createdAt: 1 }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify([{ memberId: 'admin', role: 'admin', displayName: 'Admin',
    email: 'admin@example.test', createdAt: 1, sessions: { admin: hashSessionToken(token) } }]))
  const fixture = new BridgeStore(dir, 21, null, null)
  fixture.appendOps([op('module.create', 'module'), op('entity.create', 'entity', { entityId: 'entity' })])
  initializeCurrentAuthority(dir,dir+'.authority')
  await start()
  let admin = await connect(), current = admin.authority
  assert.equal(current.revision, 0)
  const routes = [
    { path: '/v1/public-share/register', kind: 'public' as const },
    { path: '/v1/public-share/payload', kind: 'public' as const },
    { path: '/v1/portal/register', kind: 'portal' as const },
  ]
  for (const route of routes) {
    const body = publishBody(route.kind, current.hash, true)
    body.payload[marker] = 'f'.repeat(64)
    assert.equal((await request(route.path, body, true)).status, 200)
  }
  const legacy = { ...publishBody('public', undefined, true), token_hash: digest(legacyToken), local_share_id: 'legacy' }
  assert.equal((await request('/v1/public-share/register', legacy, true)).status, 200, 'missing hash is admitted only at initial revision zero')
  // Simulate a pre-upgrade payload on this disposable fixture; old files have no provenance.
  const legacyPath = payloadPath('public', legacyToken), legacyBytes = JSON.parse(readFileSync(legacyPath, 'utf8'))
  delete legacyBytes[marker]
  writeFileSync(legacyPath, JSON.stringify(legacyBytes))
  for (const [kind, plain] of [['share', publicToken], ['portal', portalToken], ['share', legacyToken]]) {
    const read = await request(`/${kind}/${plain}`)
    assert.equal(read.status, 200)
    assert.ok(read.body.content)
    assert.ok(read.text.includes(hidden[1]!))
    assert.equal(read.text.includes(marker), false, 'internal provenance is not a guest-visible field')
  }
  const initial = current
  current = await admin.tighten(current)
  await assertUnavailable()
  for (const route of routes) {
    const file = payloadPath(route.kind, route.kind === 'public' ? publicToken : portalToken), before = readFileSync(file)
    for (const hash of [initial.hash, undefined, null, ['bad'], 'bad', current.hash.toUpperCase()]) {
      const body = publishBody(route.kind, hash, true)
      body.payload[marker] = current.hash // A forged nested marker cannot rescue an invalid top-level baseline.
      const refused = await request(route.path, body, true)
      assert.equal(refused.status, 409, refused.text)
      assert.deepEqual(readFileSync(file), before)
    }
    const wrongTeam = await request(route.path, { ...publishBody(route.kind, current.hash, true), teamId: 'another-team' }, true)
    assert.equal(wrongTeam.status, 403)
    assert.deepEqual(readFileSync(file), before)
  }
  await stop()
  await start()
  admin = await connect()
  assert.deepEqual(admin.authority, current)
  await assertUnavailable()
  for (const route of routes) {
    const rebuilt = publishBody(route.kind, current.hash, false)
    rebuilt.payload[marker] = initial.hash
    const accepted = await request(route.path, rebuilt, true)
    assert.equal(accepted.status, 200, accepted.text)
    const stored = JSON.parse(readFileSync(payloadPath(route.kind, route.kind === 'public' ? publicToken : portalToken), 'utf8'))
    assert.equal(stored[marker], current.hash, 'only server-validated current authority is stamped atomically')
  }
  for (const [kind, plain] of [['share', publicToken], ['portal', portalToken]]) {
    const read = await request(`/${kind}/${plain}`)
    assert.equal(read.status, 200)
    assert.ok(read.body.content)
    for (const value of [...hidden, marker]) assert.equal(read.text.includes(value), false)
  }
  const beforePaused = routes.map(route => readFileSync(payloadPath(route.kind, route.kind === 'public' ? publicToken : portalToken)))
  const paused = await Promise.all(routes.map(route => pausedRequest(route.path, publishBody(route.kind, current.hash, true))))
  current = await admin.tighten(current)
  const completed = await Promise.all(paused.map(request => request.finish()))
  for (const [index, reply] of completed.entries()) {
    assert.equal(reply.status, 409, 'authority must be re-read after the HTTP body finishes')
    const route = routes[index]!
    assert.deepEqual(readFileSync(payloadPath(route.kind, route.kind === 'public' ? publicToken : portalToken)), beforePaused[index])
  }
  await assertUnavailable()
  for (const [kind, localKey, localId, plain] of [['public-share', 'local_share_id', 'public', publicToken], ['portal', 'local_portal_id', 'portal', portalToken]]) {
    const revoked = await request(`/v1/${kind}/revoke`, { teamId: team, [localKey!]: localId, fieldAclBaseHash: initial.hash }, true)
    assert.equal(revoked.status, 200, revoked.text)
    const guest = await request(`/${kind === 'portal' ? 'portal' : 'share'}/${plain}`)
    assert.equal(guest.status, 410)
  }
  console.log('guest field ACL live: stale cached rows/schema/defaults, legacy files, missing/forged hashes, wrong team, rebuilt payload, restart, three paused HTTP bodies and ungated revoke passed')
} finally {
  await stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
