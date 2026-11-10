import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createConfiguredWorkspaceConnections, type WorkspaceConnections } from '../src/workspace-connections/config.js'
import { initializeWorkspaceConnections } from '../src/workspace-connections/startup.js'
import { createWorkspaceConnectionsHttpHandler, type WorkspaceConnectionsHttpDeps } from '../src/workspace-connections/http.js'
import { resolveBridgeClientIp } from '../src/client-ip.js'

function response() {
  const state = { statusCode: 0, body: '', headers: new Map<string, string>() }
  return { state, res: {
    setHeader: (name: string, value: string) => state.headers.set(name.toLowerCase(), value),
    get statusCode() { return state.statusCode },
    set statusCode(value: number) { state.statusCode = value },
    end: (body: string) => { state.body = body },
  } as unknown as ServerResponse }
}
function fixture(callback: () => Promise<unknown> = async () => undefined, overrides: Partial<WorkspaceConnectionsHttpDeps> = {}) {
  let calls = 0
  const handler = createWorkspaceConnectionsHttpHandler({
    connections: { service: { callback: async () => { calls++; return callback() } } } as unknown as WorkspaceConnections,
    authenticate: () => ({ member: { memberId: 'member', role: 'member' }, deviceId: 'device' }), teamId: () => 'team',
    readBody: async () => ({ projectId: 'project' }), releaseBody() {}, drain() {},
    json: (res, status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) },
    ...overrides,
  })
  const call = async (source: string | undefined, forwarded?: string, path = '/v1/connections/oauth/google/callback') => {
    const { res, state } = response()
    const req = { method: 'GET', socket: { remoteAddress: source }, headers: { 'x-forwarded-for': forwarded } } as unknown as IncomingMessage
    assert.equal(await handler(req, res, new URL(`https://private.example${path}`)), true)
    assert.equal(state.headers.get('cache-control'), 'no-store')
    return state
  }
  return { handler, call, calls: () => calls }
}

test('invalid optional OAuth setup is isolated and never logs its exception', () => {
  const key = { key: Buffer.alloc(32, 1) }, reports: string[] = []
  const configs: Array<{ key: typeof key | null; env: NodeJS.ProcessEnv }> = [
    { key: null, env: { TEAMSPACE_CONNECTIONS_PUBLIC_URL: 'https://private.example' } },
    { key, env: { TEAMSPACE_CONNECTIONS_PUBLIC_URL: 'https://private.example/path' } },
    { key, env: { TEAMSPACE_CONNECTIONS_PUBLIC_URL: 'https://private.example', TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_ID: 'private-client-secret' } },
    { key, env: { TEAMSPACE_MAIL_PUBLIC_URL: 'https://private.example', TEAMSPACE_MAIL_GOOGLE_CLIENT_ID: 'legacy-private-client-secret' } },
  ]
  for (const config of configs) {
    assert.equal(initializeWorkspaceConnections(() => createConfiguredWorkspaceConnections('/unused', config.key, () => true, config.env), text => reports.push(text)), null)
  }
  assert.equal(initializeWorkspaceConnections(() => { throw new Error('Bearer private-token https://secret.example/private-path') }, text => reports.push(text)), null)
  assert.equal(reports.length, 5)
  assert.equal(new Set(reports).size, 1)
  assert.match(reports[0]!, /Self-hosted Connections disabled/)
  assert.doesNotMatch(reports.join('\n'), /private-client|private-token|secret\.example|private-path/)
})

test('absent configuration is quiet and healthy configured services retain their identity', () => {
  const report = () => assert.fail('Healthy or absent setup must not report a configuration failure')
  assert.equal(initializeWorkspaceConnections(() => createConfiguredWorkspaceConnections('/unused', null, () => true, {}), report), null)
  const healthy = { service: {} } as WorkspaceConnections
  assert.equal(initializeWorkspaceConnections(() => healthy, report), healthy)
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(server, /const workspaceConnections = initializeWorkspaceConnections\(\(\) => createConfiguredWorkspaceConnections\(/)
  assert.match(server, /handleWorkspaceConnectionsHttp=createWorkspaceConnectionsHttpHandler\(\{[\s\S]*?clientIp,/)
})

test('disabled Connections returns the existing unavailable contract without starting OAuth', async () => {
  const h = fixture(undefined, { connections: null })
  const callback = await h.call('192.0.2.1')
  assert.equal(callback.statusCode, 503); assert.equal(h.calls(), 0)
  const { res, state } = response()
  const req = { method: 'POST', socket: { remoteAddress: '192.0.2.1' }, headers: { authorization: 'Bearer member-session' } } as unknown as IncomingMessage
  assert.equal(await h.handler(req, res, new URL('https://private.example/v1/connections/capabilities')), true)
  assert.equal(state.statusCode, 503)
  assert.equal(JSON.parse(state.body).error_code, 'connections.unconfigured')
})

test('one source cannot exhaust another callback budget or reset its own using forwarded headers', async () => {
  const h = fixture()
  for (let index = 0; index < 60; index++) assert.equal((await h.call('192.0.2.1', `203.0.113.${index}`)).statusCode, 200)
  assert.equal((await h.call('192.0.2.1', '198.51.100.2')).statusCode, 429)
  assert.equal((await h.call('::ffff:192.0.2.1')).statusCode, 429, 'IPv4-mapped aliases keep one budget')
  assert.equal((await h.call('192.0.2.1', undefined, '/v1/connections/oauth/microsoft/callback')).statusCode, 429, 'Changing provider cannot reset the source budget')
  assert.equal((await h.call('192.0.2.2')).statusCode, 200)
  assert.equal(h.calls(), 61)
})

test('trusted proxy admission uses the host resolver and ignores a forged prefix', async () => {
  const h = fixture(undefined, { clientIp: req => resolveBridgeClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], new Set(['10.0.0.2']), 1) })
  for (let index = 0; index < 60; index++) assert.equal((await h.call('10.0.0.2', `203.0.113.${index}, 192.0.2.1`)).statusCode, 200)
  assert.equal((await h.call('10.0.0.2', '203.0.113.250, 192.0.2.1')).statusCode, 429)
  assert.equal((await h.call('10.0.0.2', '203.0.113.250, 192.0.2.2')).statusCode, 200)
  const direct = fixture(undefined, { clientIp: req => resolveBridgeClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], new Set(['10.0.0.2']), 1) })
  for (let index = 0; index < 60; index++) await direct.call('192.0.2.10', `203.0.113.${index}`)
  assert.equal((await direct.call('192.0.2.10', '203.0.113.250')).statusCode, 429)
})

test('global callback concurrency remains bounded and releases slots on rejection', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const h = fixture(async () => { await gate; throw new Error('private-provider-diagnostic') })
  const requests = Array.from({ length: 16 }, (_, index) => h.call(`192.0.2.${index + 1}`))
  assert.equal(h.calls(), 16)
  assert.equal((await h.call('192.0.2.100')).statusCode, 429)
  assert.equal(h.calls(), 16)
  release()
  const results = await Promise.all(requests)
  assert(results.every(result => result.statusCode === 503 && !result.body.includes('private-provider-diagnostic')))
  assert.equal((await h.call('192.0.2.100')).statusCode, 503, 'A released slot reaches the service again')
  assert.equal(h.calls(), 17)
})
