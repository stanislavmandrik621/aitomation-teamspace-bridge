/** Real bridge process, disk store, sessions and HTTP. No mocked dependencies or providers. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { BridgeStore } from '../src/store.js'
import { randomBytes } from 'node:crypto'

const dir = mkdtempSync(join(tmpdir(), 'selfhost-mail-live-'))
const key = { key: randomBytes(32) }
const roster = new BridgeStore(dir, 21, key)
const admin = roster.helloOrBootstrap({ memberId: 'mail-owner', deviceId: 'mail-device', displayName: 'Mail verification' })
assert.ok(admin.ok)
const invitation = roster.createInvite(admin.member.memberId, 'viewer@example.test', 'viewer')
assert.ok(invitation.ok)
const viewer = await roster.redeemInvite({ token: invitation.invite.token, deviceId: 'viewer-device', displayName: 'Viewer', memberEmail: 'viewer@example.test' })
assert.ok(viewer.ok)
initializeCurrentAuthority(dir,dir+'.authority')
const listener = createServer().listen(0, '127.0.0.1')
await once(listener, 'listening')
const port = (listener.address() as { port: number }).port
await new Promise<void>(resolve => listener.close(() => resolve()))
const env = { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_AT_REST_KEY: key.key.toString('hex'),
  TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) }
// This check intentionally has no provider registrations; it must not contact a provider.
for (const name of Object.keys(env)) if (name.startsWith('TEAMSPACE_MAIL_')) delete (env as NodeJS.ProcessEnv)[name]
const child = spawn(process.execPath, ['dist/server.js'], { cwd: new URL('..', import.meta.url), env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout!.on('data', data => { output += String(data) })
child.stderr!.on('data', data => { output += String(data) })
try {
  const deadline = Date.now() + 20_000
  while (!output.includes('bridge listening')) {
    if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Bridge did not start (exit ${child.exitCode ?? 'pending'}); startup output withheld because it can contain administrative secrets.`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const base = `http://127.0.0.1:${port}`
  const post = (action: string, token?: string, body: unknown = { projectId: 'project-a' }) => fetch(`${base}/v1/mail/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  })
  assert.equal((await fetch(`${base}/health`)).status, 200)
  assert.equal((await post('capabilities')).status, 403)
  assert.equal((await post('capabilities', viewer.sessionToken)).status, 403)
  const capabilities = await post('capabilities', admin.sessionToken)
  assert.equal(capabilities.status, 200)
  assert.equal(capabilities.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await capabilities.json(), { ok: true, projectId: 'project-a', memberId: admin.member.memberId, deviceId: 'mail-device',
    enabled: false, google: { configured: false }, microsoft: { configured: false }, inboxSummariesOnly: true })
  assert.equal((await post('start', admin.sessionToken, { projectId: 'project-a', provider: 'google' })).status, 503)
  const expectedMailboxes = Array.from({ length: 1000 }, (_, index) => ({
    id: `mailbox-${index}`.padEnd(64, 'x'), email: `${index}`.padEnd(300, '界') + '@example.test',
  }))
  const approval = { projectId: 'project-a', acknowledge: true, expectedMailboxes,
    config: { enabled: true, profileIds: expectedMailboxes.map(mailbox => mailbox.id), startDailyLimit: 2,
      dailyIncrement: 1, maxDailyLimit: 20, minIntervalMinutes: 30, replyDelayMinutes: 30, maxExchanges: 3 } }
  assert.ok(Buffer.byteLength(JSON.stringify(approval)) > 96_000)
  assert.equal((await post('warmup-save', admin.sessionToken, approval)).status, 503,
    'bounded 1,000-mailbox UTF-8 approval reaches the unconfigured service, not the smaller default body ceiling')
  const refusedBody = async (action: string, body: unknown) => {
    // The bounded production reader may close the socket when it rejects bytes.
    const status = await post(action, admin.sessionToken, body).then(response => response.status, () => 0)
    assert.ok(status === 0 || status === 400, `${action} oversized request was not refused (${status})`)
  }
  await refusedBody('list', approval)
  await refusedBody('warmup-save', { projectId: 'project-a', padding: 'x'.repeat(2 * 1024 * 1024) })
  assert.equal((await post('capabilities', admin.sessionToken)).status, 200, 'body reservations are released after both accepted and oversized requests')
  for (const action of ['folders', 'message', 'update-message', 'create-folder', 'retention-get', 'retention-save', 'warmup-history']) {
    const body = { projectId: 'project-a', connectionId: 'no-connected-mailbox', messageId: 'no-message', name: 'Not created', isRead: true }
    assert.equal((await post(action, undefined, body)).status, 403)
    assert.equal((await post(action, viewer.sessionToken, body)).status, 403)
    assert.equal((await post(action, admin.sessionToken, body)).status, 503, 'new mailbox routes cannot fall back to a vendor service')
  }
  assert.equal((await post('list', admin.sessionToken, { projectId: '../another-project' })).status, 400)
  assert.equal((await post('list', admin.sessionToken, { projectId: 'project-a', query: 'unsupported' })).status, 400)
  assert.equal((await post('capabilities?token=not-a-session')).status, 404)
  const callback = await fetch(`${base}/v1/mail/oauth/google/callback?state=invalid&code=private`)
  assert.equal(callback.status, 400)
  assert.equal(callback.headers.get('referrer-policy'), 'no-referrer')
  assert.ok(!(await callback.text()).includes('private'))
  // More than the general HTTP 60-request window from one real client IP must
  // reach mail authentication. No service/provider is configured or substituted.
  for (let index = 0; index < 70; index++) assert.equal((await post('capabilities')).status, 403)
  assert.equal((await fetch(`${base}/health`)).status, 200)
  console.log('Real bridge HTTP checks passed: encrypted session store, identity-bound capabilities, authentication, viewer refusal, unsupported-query refusal, separate mail IP budget, private responses, unconfigured-provider refusal and callback sanitization.')
  console.log('No provider login, token exchange, mail send or inbox access was attempted. Live provider verification is still required.')
  console.log(`Isolated server data retained at ${dir}`)
} finally {
  if (child.exitCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM')
    const [code, signal] = await exit
    assert.equal(code, 0)
    assert.equal(signal, null)
    assert.ok(output.includes('shutdown complete'))
  }
}
