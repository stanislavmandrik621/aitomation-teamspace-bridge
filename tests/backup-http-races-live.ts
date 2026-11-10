import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { request } from 'node:http'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import { BridgeStore } from '../src/store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { TeamBackupStore } from '../src/backup-store.js'
import { BRIDGE_PROTOCOL_VERSION, type ModulesSyncOp } from '../src/index.js'
import { readCurrentBackupPermissions } from '../../../apps/desktop/electron/modules-sync/backup-permission-read.js'

async function until<T>(read: () => T | undefined, reason: string): Promise<T> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`Timeout: ${reason}`)
}
const dir = mkdtempSync(join(tmpdir(), 'backup-http-races-'))
let child: ReturnType<typeof spawn> | undefined
let socket: WebSocket | undefined
let output = ''
try {
  const roster = new BridgeStore(dir, 21, null)
  const admin = roster.helloOrBootstrap({ memberId: 'admin', deviceId: 'admin-device', displayName: 'Admin' })
  assert.ok(admin.ok)
  async function invite(email: string, role: 'admin' | 'member') {
    const invitation = roster.createInvite(admin.member.memberId, email, role)
    assert.ok(invitation.ok)
    const joined = await roster.redeemInvite({ token: invitation.invite.token, deviceId: `${role}-device`, displayName: role, memberEmail: email })
    assert.ok(joined.ok)
    return joined
  }
  // The raw archive format currently requires admin authority. Exercise loss
  // of that authority while upload/download I/O is pending, including OWN
  // historical archives that may contain fields hidden after demotion.
  const member = await invite('member@example.test', 'admin')
  const otherAdmin = await invite('other-admin@example.test', 'admin')
  let opSerial = 0
  const seed = (kind: string, targetId: string, patch: Record<string, unknown>, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
    opId: `backup-http-scope-${++opSerial}`, kind, targetKind: kind.split('.')[0], targetId, patch,
    originRole: 'admin', originMemberId: admin.member.memberId, originDevice: 'admin-device',
    hlc: `${Date.now()+opSerial}:0:admin-device`, protocolVersion: 2, hopCount: 0, ...extra,
  })
  roster.appendOps([
    seed('module.create','readable-module',{}),
    seed('module.create','private-module',{visibleToMemberIds:[admin.member.memberId]}),
    seed('entity.create','readable-table',{}, {moduleId:'readable-module'}),
    seed('record.create','readable-record',{}, {moduleId:'readable-module',entityId:'readable-table'}),
  ])
  const backups = new TeamBackupStore(dir)
  backups.setMeta({ minIntervalMs: 0, allowMemberDownloadOthers: true })
  const seeded = await backups.putSnapshotFromStream({ memberId: member.member.memberId, contentLength: 4, stream: Readable.from(['seed']) })
  assert.ok(seeded.ok)
  initializeCurrentAuthority(dir,dir+'.authority')
  const listener = createServer().listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const port = (listener.address() as { port: number }).port
  await new Promise<void>(resolve => listener.close(() => resolve()))
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/backup-http-observed-server.ts'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_BACKUP_TOKENS: '100' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.on('data', data => { output += String(data) })
  child.stderr!.on('data', data => { output += String(data) })
  await until(() => output.includes('bridge listening') ? true : undefined, 'server startup')
  socket = new WebSocket(`ws://127.0.0.1:${port}`)
  const frames: any[] = []
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'hello', memberId: admin.member.memberId, deviceId: 'admin-device', sessionToken: admin.sessionToken, protocolVersion: BRIDGE_PROTOCOL_VERSION }))
  await until(() => frames.find(f => f.type === 'hello_ok'), 'admin hello')
  async function role(memberId: string, next: 'admin' | 'member' | 'viewer') {
    const frameId = `role-${memberId}-${next}`
    socket!.send(JSON.stringify({ type: 'set_role', frameId, memberId, role: next }))
    assert.equal((await until(() => frames.find(f => f.frameId === frameId), 'live role change')).type, 'set_role_ok')
  }
  function partial(path: string, method: string, token: string, body: string) {
    let resolve!: (result: { status: number; body: any }) => void
    let reject!: (error: Error) => void
    const result = new Promise<{ status: number; body: any }>((yes, no) => { resolve = yes; reject = no })
    const req = request(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body), 'content-type': 'application/json' } }, res => {
      let text = ''
      res.on('data', data => { text += String(data) })
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.write(body.slice(0, 1))
    return { result, finish: () => req.end(body.slice(1)) }
  }
  const snapshots = join(dir, 'backups/members', member.member.memberId, 'snapshots')
  const scopeBody = { version: 1, targets: [{kind:'module',id:'readable-module'}, {kind:'module',id:'private-module'}, {kind:'record',id:'readable-record'}, {kind:'record',id:'unknown-record'}] }
  const readScope = (body: unknown, token = member.sessionToken) => fetch(`${base}/v1/backups/read-scope`, {
    method:'POST', headers:{authorization:`Bearer ${token}`,'content-type':'application/json'}, body:JSON.stringify(body),
  })
  const adminScopeResponse = await readScope(scopeBody)
  assert.equal(adminScopeResponse.status,200)
  const adminScope = await adminScopeResponse.json() as any
  assert.ok(adminScope.grants[1])
  const scopeDuringBody = partial('/v1/backups/read-scope','POST',member.sessionToken,JSON.stringify(scopeBody))
  await until(() => output.includes('BACKUP_SCOPE_BODY_READ') ? true : undefined, 'scope request awaiting body')
  const posting = partial('/v1/backups', 'POST', member.sessionToken, 'abcd')
  await until(() => readdirSync(snapshots).some(name => name.endsWith('.part')) ? true : undefined, 'upload is streaming')
  await role(member.member.memberId, 'member')
  scopeDuringBody.finish()
  const memberScope = await scopeDuringBody.result
  assert.equal(memberScope.status,200,'members can obtain filtered backup authority')
  assert.ok(memberScope.body.grants[0])
  assert.equal(memberScope.body.grants[1],null,'role revoked during body read cannot expose private module')
  assert.equal(memberScope.body.grants[2].entityId,'readable-table')
  assert.equal(memberScope.body.grants[3],null)
  assert.equal((await readScope({...scopeBody,fingerprint:adminScope.fingerprint})).status,409,'old role proof cannot be reused')
  assert.equal((await readScope({...scopeBody,fingerprint:memberScope.body.fingerprint})).status,200)
  assert.equal((await readScope({...scopeBody,role:'admin'})).status,400,'client supplied role is refused')
  posting.finish()
  assert.equal((await posting.result).status, 403, 'member demotion during upload blocks final commit')
  assert.equal(backups.listForMember(member.member.memberId).length, 1)
  const restrictedHeaders = { authorization: `Bearer ${member.sessionToken}` }
  const refusedOwn = await fetch(`${base}/v1/backups/${seeded.snapshot.id}`, { headers: restrictedHeaders })
  assert.equal(refusedOwn.status, 403, 'own archive ownership and allowMemberDownloadOthers do not authorize raw private fields')
  assert.equal((await refusedOwn.text()).includes('seed'), false, 'no archive bytes in the refusal')
  const refusedUpload = await fetch(`${base}/v1/backups`, { method: 'POST', headers: restrictedHeaders, body: 'unsafe-cache' })
  assert.equal(refusedUpload.status, 403)
  assert.equal(backups.listForMember(member.member.memberId).length, 1)
  const stillListed = await fetch(`${base}/v1/backups`, { headers: restrictedHeaders })
  assert.equal(stillListed.status, 200, 'own archive inventory remains available')
  let bindingCurrent = true
  const readSession = await readCurrentBackupPermissions({
    transport:{usedOrigin:base,sessionToken:member.sessionToken,teamId:roster.ensureTeam().teamId,memberId:member.member.memberId},
    targets:[...scopeBody.targets,...Array.from({length:500},(_,index)=>({kind:'record',id:`unknown-${index}`}))],
    assertCurrent:()=>{if(!bindingCurrent)throw new Error('Project binding changed')},
  })
  assert.equal(readSession.grants.length,504)
  assert.equal(readSession.grants[1],null)
  await readSession.revalidate()
  bindingCurrent=false
  await assert.rejects(readSession.revalidate(),/Project binding changed/)
  bindingCurrent=true
  await assert.rejects(readSession.revalidate(),/expired/,'a failed binding check cannot revive an old capability')
  const freshSession = await readCurrentBackupPermissions({
    transport:{usedOrigin:base,sessionToken:member.sessionToken,teamId:roster.ensureTeam().teamId,memberId:member.member.memberId},
    targets:scopeBody.targets,assertCurrent:()=>{},
  })
  await role(member.member.memberId, 'admin')
  await assert.rejects(freshSession.revalidate(),/permissions changed/,'capability expires when current server authority changes')

  const patching = partial('/v1/backups/meta', 'PATCH', otherAdmin.sessionToken, JSON.stringify({ maxKeepPerMember: 99 }))
  await until(() => output.includes('BACKUP_META_BODY_READ') ? true : undefined, 'PATCH is awaiting remaining body')
  await role(otherAdmin.member.memberId, 'member')
  patching.finish()
  assert.equal((await patching.result).status, 403, 'Admin demotion during body read blocks metadata mutation')
  assert.notEqual(backups.getMeta().maxKeepPerMember, 99)
  await role(otherAdmin.member.memberId, 'admin')

  const waitingUpload = partial('/v1/backups', 'POST', member.sessionToken, 'efgh')
  await until(() => readdirSync(snapshots).some(name => name.endsWith('.part')) ? true : undefined, 'second upload owns member lock')
  const pendingGet = fetch(`${base}/v1/backups/${seeded.snapshot.id}`, { headers: { authorization: `Bearer ${otherAdmin.sessionToken}` } })
  await until(() => output.includes('BACKUP_READ_ENTERED') ? true : undefined, 'cross-member GET queued behind upload')
  await role(otherAdmin.member.memberId, 'member')
  waitingUpload.finish()
  assert.equal((await waitingUpload.result).status, 200)
  assert.equal((await pendingGet).status, 403, 'admin authority revoked while GET waits prevents download even with allowMemberDownloadOthers enabled')
  const refusedOther = await fetch(`${base}/v1/backups/${seeded.snapshot.id}`, { headers: { authorization: `Bearer ${otherAdmin.sessionToken}` } })
  assert.equal(refusedOther.status, 403, 'cross-member archive remains refused')
  const allowed = await fetch(`${base}/v1/backups/${seeded.snapshot.id}`, { headers: { authorization: `Bearer ${admin.sessionToken}` } })
  assert.equal(allowed.status, 200)
  assert.equal(await allowed.text(), 'seed', 'retained admin authority still permits the archive')

  const spoof = Buffer.from(JSON.stringify({ memberId: 'someone-else', teamId: 'other-team', deviceId: 'other-device', displayName: 'Forged' })).toString('base64url')
  const stamped = await fetch(`${base}/v1/backups`, { method: 'POST', headers: { authorization: `Bearer ${member.sessionToken}`, 'x-backup-meta': spoof }, body: 'data' })
  assert.equal(stamped.status, 200)
  const stampedBody = await stamped.json() as any
  assert.equal(stampedBody.backup.owner.memberId, member.member.memberId)
  assert.equal(stampedBody.backup.owner.teamId, roster.ensureTeam().teamId)
  assert.equal(stampedBody.backup.owner.deviceId, 'admin-device')
  assert.notEqual(stampedBody.backup.owner.displayName, 'Forged')
  console.log('backup-http-races-live: raw member own/cross archive refusal; retained admin download; upload/metadata/queued-download admin revocation; authenticated attribution passed')
} catch (error) {
  console.error(output)
  throw error
} finally {
  socket?.terminate()
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
