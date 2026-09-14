/** Actual bridge process, encrypted storage, HTTP authentication and restart.
 * Uses no simulated model/provider or production account data. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptJsonFile } from '../src/at-rest.js'
import { hashSessionToken } from '../src/store.js'
import { createWorkspaceCoordinatorMonitorHandler } from '../../../apps/desktop/electron/modules-sync/workspace-coordinator-monitor-ipc.js'

const directory = mkdtempSync(join(tmpdir(), 'coordinator-monitor-http-real-')), key = { key: randomBytes(32) }
let child: ReturnType<typeof spawn> | undefined
const reservation = createServer().listen(0, '127.0.0.1')
await once(reservation, 'listening')
const port = (reservation.address() as { port: number }).port
await new Promise<void>(resolve => reservation.close(() => resolve()))
const base = `http://127.0.0.1:${port}`
async function start() {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEAMSPACE_DATA_DIR: directory, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_AT_REST_KEY: key.key.toString('hex') }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    let logs = ''
    const timer = setTimeout(() => reject(new Error(`Bridge startup timeout: ${logs.slice(-1000)}`)), 20000)
    child!.stderr!.on('data', chunk => { logs += String(chunk) })
    child!.stdout!.on('data', chunk => { if (String(chunk).includes('bridge listening')) { clearTimeout(timer); resolve() } })
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${logs.slice(-1000)}`)) })
  })
}
async function stop() { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited } }
async function request(path: string, member: string | null = 'manager', body?: unknown) {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(member ? { authorization: `Bearer ${member}-token` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
  return { status: response.status, body: await response.json() as any }
}
try {
  writeFileSync(join(directory, 'team.json'), encryptJsonFile(key, { teamId: 'monitor_team', name: 'Monitor test', createdAt: 1 }))
  writeFileSync(join(directory, 'members.json'), encryptJsonFile(key, ['manager', 'worker', 'reviewer', 'viewer', 'outsider'].map(memberId => ({ memberId, email: `${memberId}@example.test`, displayName: memberId, role: ['manager', 'outsider'].includes(memberId) ? 'admin' : memberId === 'viewer' ? 'viewer' : 'member', sessions: { [`${memberId}-device`]: hashSessionToken(`${memberId}-token`) }, createdAt: 1 }))))
  initializeCurrentAuthority(directory,directory+'.authority')
  await start()
  let revision = 0
  async function command(action: string, payload: unknown) {
    const result = await request('/workspace-work', 'manager', { workspaceId: 'ws', commandId: randomUUID(), expectedRevision: revision, action, payload })
    assert.equal(result.status, 200, JSON.stringify(result.body)); revision = result.body.data.revision
  }
  await command('registerWorkspace', { name: 'Monitoring workspace', memberIds: ['manager', 'worker', 'reviewer', 'viewer'], managerIds: ['manager'] })
  await command('createTask', { id: 'late', title: 'Review deployment package', description: 'Only shared work', assigneeId: 'worker', departmentId: null, dueAt: Date.now() - 1000, reviewPolicy: { mode: 'human', humanReviewerIds: ['reviewer'], aiReviewerIds: [], independent: true } })
  const path = '/workspace-work/coordinator?workspaceId=ws'
  assert.equal((await request(path, null)).status, 401)
  assert.equal((await request(`${path}&token=manager-token`, null)).status, 401)
  assert.equal((await request(path, 'outsider')).status, 403, 'technical administrator has no implicit workspace access')
  assert.equal((await request('/workspace-work/coordinator', 'viewer', { workspaceId: 'ws', enabled: true })).status, 403)
  assert.equal((await request('/workspace-work/coordinator', 'worker', { workspaceId: 'ws', memberId: 'manager', enabled: true })).status, 400, 'renderer cannot choose another monitoring principal')
  assert.equal((await request(path, 'worker')).body.data.enabled, false)
  const enabled = await request('/workspace-work/coordinator', 'worker', { workspaceId: 'ws', enabled: true })
  assert.equal(enabled.status, 200)
  assert.equal(enabled.body.data.status, 'running')
  assert.equal(enabled.body.data.memberId, 'worker')
  assert.equal(enabled.body.data.attention[0].kind, 'overdue')
  assert.equal((await request(path, 'manager')).body.data.enabled, false, 'private opt-in never enables another member')
  assert.equal(readFileSync(join(directory+'.authority', 'workspace-coordinator-monitor.json'), 'utf8').includes('worker'), false)

  // Production IPC handler against actual authenticated HTTP I/O; the transport
  // facade contains no canned replies or replacement implementation.
  const transport = {
    isSessionReady: () => true,
    negotiatedIdentity: () => ({ sessionToken: 'worker-token', memberId: 'worker' }),
    bridgeFetchJson: async (path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
      const result = await request(path, 'worker', init?.body)
      return { ok: result.status >= 200 && result.status < 300, status: result.status, data: result.body }
    },
  }
  const binding = { teamId: 'monitor_team', bindingId: 'isolated-real-http-project', transport }
  const handler = createWorkspaceCoordinatorMonitorHandler({ authorize: () => true, getBinding: () => binding })
  const ipc = await handler({}, { teamId: 'monitor_team', workspaceId: 'ws' })
  assert.ok(ipc.ok)
  if (!ipc.ok) throw new Error(ipc.error)
  assert.equal(ipc.data.attention[0].taskId, 'late')
  const malformed = await handler({}, { teamId: 'monitor_team', workspaceId: 'ws', bridgeUrl: 'https://untrusted.invalid' })
  assert.equal(malformed.ok, false)
  // Exercise upgrade messaging against this bridge's real generic 404 response,
  // without a fabricated response or claiming an old-version compatibility run.
  const unsupportedTransport = { ...transport, bridgeFetchJson: async () => {
    const result = await request('/no-such-coordinator-route', 'worker')
    assert.equal(result.status, 404)
    return { ok: false, status: result.status, data: result.body }
  } }
  const unsupportedHandler = createWorkspaceCoordinatorMonitorHandler({ authorize: () => true, getBinding: () => ({ ...binding, transport: unsupportedTransport }) })
  const unsupported = await unsupportedHandler({}, { teamId: 'monitor_team', workspaceId: 'ws' })
  assert.equal(unsupported.ok, false)
  if (unsupported.ok) throw new Error('Expected missing route')
  assert.equal(unsupported.code, 'unsupported')
  assert.match(unsupported.error, /Update the private team server/)
  await stop(); await start()
  const restarted = await request(path, 'worker')
  assert.equal(restarted.body.data.enabled, true)
  assert.equal(restarted.body.data.status, 'running')
  assert.deepEqual(restarted.body.data.attention, enabled.body.data.attention)
  await command('setWorkspaceMembers', { memberIds: ['manager', 'reviewer', 'viewer'], managerIds: ['manager'] })
  assert.equal((await request(path, 'worker')).status, 403, 'persisted opt-in cannot retain revoked workspace access')
  await command('setWorkspaceMembers', { memberIds: ['manager', 'worker', 'reviewer', 'viewer'], managerIds: ['manager'] })
  assert.equal((await request(path, 'worker')).body.data.enabled, false)
  assert.equal((await request('/workspace-work/coordinator', 'worker', { workspaceId: 'ws', enabled: true })).status, 200)
  await command('setWorkspaceMembers', { memberIds: ['manager', 'reviewer', 'viewer'], managerIds: ['manager'] })
  // Intentionally no intervening monitor read or timer wait before restoring.
  await command('setWorkspaceMembers', { memberIds: ['manager', 'worker', 'reviewer', 'viewer'], managerIds: ['manager'] })
  assert.equal((await request(path, 'worker')).body.data.enabled, false, 'fast revoke/regrant cannot silently reactivate earlier consent')
  assert.equal((await request('/workspace-work/coordinator', 'worker', { workspaceId: 'ws', enabled: true })).status, 200)
  const disabled = await handler({}, { teamId: 'monitor_team', workspaceId: 'ws', enabled: false })
  assert.ok(disabled.ok && !disabled.data.enabled)
  await stop(); await start()
  assert.equal((await request(path, 'worker')).body.data.enabled, false, 'disable is durable across process restart')
  console.log('PASS: real bridge HTTP/IPC monitor authentication, viewer/outsider denial, private consent, encrypted process restart recovery, revoke/regrant and durable disable')
} finally { await stop(); rmSync(directory, { recursive: true, force: true });rmSync(directory+'.authority', { recursive: true, force: true }) }
