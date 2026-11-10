import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { BridgeStore } from '../src/store.js'
import { TeamBackupStore } from '../src/backup-store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { const result = read(); if (result !== undefined) return result; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw Error('Timed out waiting for actual backup server boundary')
}
test('actual server range identity and live grant revocation stop resumed snapshot delivery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aiq-wave98-server-'))
  console.log(JSON.stringify({ preservedFixture: root, preservedAuthority: root + '.authority', reason: 'Preserve all source/database/proof evidence' }))
  const roster = new BridgeStore(root, 21, null), admin = roster.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', displayName: 'Admin' }); assert.ok(admin.ok)
  const invitation = roster.createInvite(admin.member.memberId, 'resuming@example.test', 'admin'); assert.ok(invitation.ok)
  const member = await roster.redeemInvite({ token: invitation.invite.token, deviceId: 'resuming-device', displayName: 'Resuming', memberEmail: 'resuming@example.test' }); assert.ok(member.ok)
  const backups = new TeamBackupStore(root), body = Buffer.alloc(128 * 1024 + 1, 7)
  const stored = await backups.putSnapshotFromStream({ memberId: member.member.memberId, contentLength: body.length, stream: Readable.from([body]) }); assert.ok(stored.ok)
  initializeCurrentAuthority(root, root + '.authority')
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening'); const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`, url = `${base}/v1/backups/${stored.snapshot.id}`, token = member.sessionToken, etag = `"${stored.snapshot.sha256}"`
  let logs = '', socket: WebSocket | undefined
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/wave98-backup-server-fixture.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEAMSPACE_DATA_DIR: root, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_BACKUP_TOKENS: '100' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout!.on('data', data => { logs += String(data) }); child.stderr!.on('data', data => { logs += String(data) })
  try {
    await until(() => logs.includes('bridge listening') ? true : undefined)
    const full = await fetch(url, { headers: { authorization: `Bearer ${token}` } }); assert.equal(full.status, 200); assert.equal(full.headers.get('etag'), etag); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.deepEqual(Buffer.from(await full.arrayBuffer()), body)
    for (const match of [undefined, `W/${etag}`, '"changed"']) {
      const rejected = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=1-', ...(match ? { 'if-match': match } : {}) } }); assert.equal(rejected.status, 412); await rejected.arrayBuffer()
    }
    const invalid = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: `bytes=${body.length}-`, 'if-match': etag } }); assert.equal(invalid.status, 416); await invalid.arrayBuffer()
    socket = new WebSocket(`ws://127.0.0.1:${port}`); const frames: any[] = []; socket.on('message', bytes => frames.push(JSON.parse(String(bytes)))); await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', memberId: admin.member.memberId, deviceId: 'admin-device', sessionToken: admin.sessionToken, protocolVersion: BRIDGE_PROTOCOL_VERSION })); await until(() => frames.find(f => f.type === 'hello_ok'))
    let seen = 0
    const transfer = new Promise<{ complete: boolean }>((resolve, reject) => {
      const req = request(url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=1-', 'if-match': etag } }, res => {
        assert.equal(res.statusCode, 206); assert.equal(res.headers['content-range'], `bytes 1-${body.length - 1}/${body.length}`)
        res.on('data', bytes => { seen += bytes.length }); res.once('end', () => resolve({ complete: res.complete })); res.once('error', () => resolve({ complete: false })); res.once('aborted', () => resolve({ complete: false }))
      }); req.once('error', reject); req.end()
    })
    await until(() => logs.includes('WAVE98_RANGE_PAUSED') && seen > 0 ? true : undefined)
    socket.send(JSON.stringify({ type: 'set_role', frameId: 'revoke-resume', memberId: member.member.memberId, role: 'member' }))
    assert.equal((await until(() => frames.find(f => f.frameId === 'revoke-resume'))).type, 'set_role_ok')
    child.send('resume-source')
    assert.equal((await transfer).complete, false); assert.ok(seen > 0 && seen < body.length - 1)
    const denied = await fetch(url, { headers: { authorization: `Bearer ${token}`, range: 'bytes=1-', 'if-match': etag } }); assert.equal(denied.status, 403); await denied.arrayBuffer()
  } catch (error) { console.error(logs); throw error }
  finally { socket?.terminate(); if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended } }
})
