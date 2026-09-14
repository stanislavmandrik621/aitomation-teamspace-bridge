import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import WebSocket from 'ws'
import { BridgeStore } from '../src/store.js'
import { TeamContentLockStore } from '../src/team-content-lock-store.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'

async function until<T>(read: () => T | undefined, reason: string): Promise<T> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timeout: ${reason}`)
}
const dir = mkdtempSync(join(tmpdir(), 'restore-validate-http-'))
let child: ReturnType<typeof spawn> | undefined
let socket: WebSocket | undefined
let output = ''
try {
  const roster = new BridgeStore(dir, 21, null)
  const owner = roster.helloOrBootstrap({ memberId: 'owner', deviceId: 'owner-device', displayName: 'Owner' })
  assert.ok(owner.ok)
  const secondDevice = roster.helloOrBootstrap({ memberId: owner.member.memberId, deviceId: 'second-device', adminRecoveryKey: roster.adminRecovery!.secret })
  assert.ok(secondDevice.ok)
  const invitation = roster.createInvite(owner.member.memberId, 'control@example.test', 'admin')
  assert.ok(invitation.ok)
  const control = await roster.redeemInvite({ token: invitation.invite.token, deviceId: 'control-device', displayName: 'Control', memberEmail: 'control@example.test' })
  assert.ok(control.ok)
  const locks = new TeamContentLockStore(dir)
  const begun = locks.beginRestorePermit({ teamId: roster.ensureTeam().teamId, actorMemberId: owner.member.memberId, actorDeviceId: 'owner-device', actorRole: 'admin', expectedRevision: 0, now: Date.now() - 60_000 })
  assert.ok(begun.ok)
  const permitToken = begun.permit.token
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`
  const events: any[] = []
  initializeCurrentAuthority(dir,dir+'.authority')
  child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/restore-validate-observed-server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_BACKUP_TOKENS: '100' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout!.on('data', data => { output += String(data) })
  child.stderr!.on('data', data => { output += String(data) })
  child.on('message', message => events.push(message))
  await until(() => output.includes('bridge listening') ? true : undefined, 'server startup')
  socket = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: any[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'hello', memberId: control.member.memberId, deviceId: 'control-device', sessionToken: control.sessionToken, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
  await until(() => frames.find(frame => frame.type === 'hello_ok'), 'control hello')
  const post = (token: string, permit = permitToken) => fetch(`${base}/v1/team-content-restore/validate`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ permitToken: permit }),
  })
  const renewed = await post(owner.sessionToken)
  assert.equal(renewed.status, 200)
  const renewedBody = await renewed.json() as any
  assert.ok(renewedBody.expiresAt > begun.permit.expiresAt + 50_000, 'HTTP validation renews the persisted lease')
  const leasePath = join(dir, 'team-content-restore-lease.json')
  assert.equal(JSON.parse(readFileSync(leasePath, 'utf8')).expiresAt, renewedBody.expiresAt)
  const beforeRefusals = readFileSync(leasePath, 'utf8')
  assert.equal((await post(secondDevice.sessionToken)).status, 409, 'same Admin on a different device cannot renew')
  assert.equal((await post(control.sessionToken)).status, 409, 'another Admin cannot renew')
  assert.equal((await post(owner.sessionToken, 'invalid-permit')).status, 409)
  assert.equal((await fetch(`${base}/v1/team-content-restore/validate?token=${owner.sessionToken}`, { method: 'POST', body: JSON.stringify({ permitToken }) })).status, 403, 'query bearer cannot authorize')
  assert.equal(readFileSync(leasePath, 'utf8'), beforeRefusals, 'refused renewals leave lease unchanged')
  const role = async (next: 'admin' | 'member') => {
    const frameId = `role-${next}`
    socket!.send(JSON.stringify({ type: 'set_role', frameId, memberId: owner.member.memberId, role: next }))
    const result = await until(() => frames.find(frame => frame.frameId === frameId || frame.requestId === frameId), 'role change')
    assert.equal(result.type, 'set_role_ok')
  }
  events.length = 0
  const body = JSON.stringify({ permitToken })
  const partialResult = new Promise<number>((resolve, reject) => {
    const req = request(`${base}/v1/team-content-restore/validate`, { method: 'POST', headers: { authorization: `Bearer ${owner.sessionToken}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
    req.on('error', reject)
    req.write(body.slice(0, 1))
    void (async () => {
      await until(() => events.find(event => event.type === 'validate-body-data'), 'body read is suspended')
      await role('member')
      req.end(body.slice(1))
    })().catch(reject)
  })
  assert.equal(await partialResult, 401, 'Admin revoked during HTTP body read cannot renew')
  assert.equal(readFileSync(leasePath, 'utf8'), beforeRefusals)
  await role('admin')
  child.send!({ type: 'advance-clock', ms: 11 * 60_000 })
  await until(() => events.find(event => event.type === 'clock-advanced'), 'lease clock expiration')
  assert.equal((await post(owner.sessionToken)).status, 409, 'expired permit cannot be resurrected')
  socket.send(JSON.stringify({ type: 'revoke_session', frameId: 'revoke-owner', memberId: owner.member.memberId, deviceId: 'owner-device' }))
  await until(() => frames.find(frame => frame.frameId === 'revoke-owner' || frame.requestId === 'revoke-owner'), 'session revocation')
  assert.equal((await post(owner.sessionToken)).status, 403, 'revoked bearer fails HTTP authentication')
  console.log('restore-validate-http-live: durable renewal, exact Admin/device identity, header-only auth, in-flight demotion, expired permit and revoked bearer passed')
} catch (error) {
  console.error(output)
  throw error
} finally {
  socket?.terminate()
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
