/** Isolated real bridge, three WebSocket clients, and authenticated roster identity. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { BridgeStore } from '../src/store.js'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'module-presence-live-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  try {
    const store = new BridgeStore(dir, 21)
    const admin = store.helloOrBootstrap({ memberId: 'mem_admin', deviceId: 'host', displayName: 'Alice', memberEmail: 'alice@example.test' })
    assert.ok(admin.ok)
    assert.ok(store.updateMemberChatProfile(admin.member.memberId, { avatarRef: 'a'.repeat(64), avatarRev: 1 }).ok)
    const invite = store.createInvite('mem_admin', 'bob@example.test', 'member'); assert.ok(invite.ok)
    const bob = await store.redeemInvite({ token: invite.invite.token, deviceId: 'bob-device', memberEmail: 'bob@example.test', displayName: 'Bob' }); assert.ok(bob.ok)
    const viewInvite = store.createInvite('mem_admin', 'viewer@example.test', 'viewer'); assert.ok(viewInvite.ok)
    const viewer = await store.redeemInvite({ token: viewInvite.invite.token, deviceId: 'viewer-device', memberEmail: 'viewer@example.test', displayName: 'Viewer' }); assert.ok(viewer.ok)
    store.appendOps([['module.create', 'm1'], ['entity.create', 'e1'], ['view.create', 'board'], ['record.create', 'r1']].map(([kind, targetId], i) => ({
      opId: `presence-fixture-${i}`, kind, targetId, targetKind: kind.split('.')[0], moduleId: 'm1',
      ...(kind.startsWith('module.') ? {} : { entityId: 'e1' }), patch: { id: targetId },
      originMemberId: admin.member.memberId, originRole: 'admin', originDevice: 'host', hlc: `${Date.now()}:0:host`, hopCount: 0, protocolVersion: 2,
    })))
    const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
    initializeCurrentAuthority(dir,dir+'.authority')
    const port = (reserve.address() as { port: number }).port
    await new Promise<void>((resolve) => reserve.close(() => resolve()))
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr='';child.stderr!.on('data',bytes=>{stderr=(stderr+String(bytes)).slice(-3000)})
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge startup timeout')), 20_000)
      child!.stdout!.on('data', (data) => { if (String(data).includes('bridge listening')) { clearTimeout(timer); resolve() } })
      child!.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}`)) })
    })
    async function client(memberId: string, deviceId: string, sessionToken: string) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(socket)
      const inbox: any[] = []
      socket.on('message', (data) => { inbox.push(JSON.parse(String(data))) })
      await once(socket, 'open')
      const wait = async (predicate: (frame: any) => boolean) => {
        const until = Date.now() + 10_000
        while (Date.now() < until) {
          const idx = inbox.findIndex(predicate)
          if (idx >= 0) return inbox.splice(idx, 1)[0]
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Expected bridge frame did not arrive')
      }
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, memberId, deviceId, sessionToken }))
      await wait((f) => f.type === 'hello_ok')
      return { socket, wait }
    }
    const a = await client(admin.member.memberId, 'host', admin.sessionToken)
    const b = await client(bob.member.memberId, 'bob-device', bob.sessionToken)
    const v = await client(viewer.member.memberId, 'viewer-device', viewer.sessionToken)
    // The relay preserves collaborative save metadata while replacing claimed
    // author identity. Desktop tests separately validate and apply checkpoints.
    const document=new Y.Doc(),metadata=document.getMap('_modules_checkpoint')
    metadata.set('binding',JSON.stringify(['r1','body','text']));metadata.set('genesis','a'.repeat(64));document.getText('content')
    const checkpoint=Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');document.destroy()
    const patch = { data: { body: '' }, yjsCheckpoint: { fieldSlug: 'body', kind: 'text', stateB64: checkpoint }, yjsCheckpointSave: true, yjsCheckpointSaveId: 'd'.repeat(64) }
    const makeSave = (opId: string, savePatch: typeof patch) => ({ opId, kind: 'record.update', targetKind: 'record', targetId: 'r1', entityId: 'e1', patch: savePatch,
      hlc: `${Date.now()}:0001:fixture`, originDevice: 'fixture', hopCount: 0, protocolVersion: BRIDGE_PROTOCOL_VERSION, originMemberId: 'forged', originMemberName: 'Mallory', originRole: 'admin' })
    a.socket.send(JSON.stringify({ type: 'ops', frameId: 'alice-save', ops: [makeSave('alice-save-op', patch)] }))
    const accepted=await a.wait(f=>f.frameId==='alice-save'||f.requestId==='alice-save')
    assert.equal(accepted.results?.[0]?.status,'applied',JSON.stringify(accepted)+' '+stderr)
    const aliceSave = (await b.wait((f) => f.type === 'ops' && f.ops.some((op: any) => op.opId === 'alice-save-op'))).ops.find((op: any) => op.opId === 'alice-save-op')
    assert.deepEqual(aliceSave.patch, patch)
    assert.equal(aliceSave.originMemberId, admin.member.memberId); assert.equal(aliceSave.originMemberName, 'Alice')
    assert.equal(aliceSave.originDevice, 'host')
    const bobPatch = { ...patch, yjsCheckpointSaveId: 'e'.repeat(64) }
    b.socket.send(JSON.stringify({ type: 'ops', frameId: 'bob-save', ops: [makeSave('bob-save-op', bobPatch)] }))
    const bobSave = (await a.wait((f) => f.type === 'ops' && f.ops.some((op: any) => op.opId === 'bob-save-op'))).ops.find((op: any) => op.opId === 'bob-save-op')
    assert.deepEqual(bobSave.patch, bobPatch)
    assert.equal(bobSave.originMemberId, bob.member.memberId); assert.equal(bobSave.originMemberName, 'Bob'); assert.equal(bobSave.originRole, 'member')
    assert.equal(bobSave.originDevice, 'bob-device')
    v.socket.send(JSON.stringify({ type: 'ops', frameId: 'viewer-save', ops: [makeSave('viewer-save-op', patch)] }))
    assert.equal((await v.wait((f) => f.requestId === 'viewer-save')).type, 'error')
    const target = { leaseId: 'alice-window-editor', entityId: 'e1', viewId: 'board', recordId: 'r1' }
    a.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'edit-start', target: { ...target, memberId: 'forged', value: 'private' }, active: true, displayName: 'Mallory' }))
    const received = await b.wait((f) => f.type === 'presence_snapshot' && f.peers.some((p: any) => p.editing?.some((e: any) => e.leaseId === target.leaseId)))
    const peer = received.peers.find((p: any) => p.memberId === 'mem_admin')
    assert.equal(peer.avatarRef, 'a'.repeat(64)); assert.equal(peer.displayName, 'Alice'); assert.equal(peer.editing[0].recordId, 'r1')
    assert.equal(peer.editing[0].value, undefined); assert.equal(peer.editing[0].memberId, undefined)
    assert.equal(typeof received.teamId, 'string')
    v.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'viewer-edit', target, active: true }))
    assert.equal((await v.wait((f) => f.requestId === 'viewer-edit')).type, 'error')
    const bobTarget = { ...target, leaseId: 'bob-editor' }
    b.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'bob-start', target: bobTarget, active: true }))
    await b.wait((f) => f.frameId === 'bob-start' && f.type === 'presence_snapshot')
    a.socket.send(JSON.stringify({ type: 'set_role', frameId: 'demote-bob', memberId: bob.member.memberId, role: 'viewer' }))
    await a.wait((f) => f.frameId === 'demote-bob' && f.type === 'set_role_ok')
    b.socket.send(JSON.stringify({ type: 'presence_get', frameId: 'after-demote' }))
    const demoted = (await b.wait((f) => f.frameId === 'after-demote')).peers.find((p: any) => p.memberId === bob.member.memberId)
    assert.equal(demoted.role, 'viewer'); assert.equal(demoted.editing.length, 0)
    b.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'revoked-edit', target: bobTarget, active: true }))
    assert.equal((await b.wait((f) => f.requestId === 'revoked-edit')).type, 'error')
    a.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'edit-stop', target, active: false }))
    await a.wait((f) => f.frameId === 'edit-stop' && f.type === 'presence_snapshot')
    b.socket.send(JSON.stringify({ type: 'presence_get', frameId: 'after-stop' }))
    const stopped = await b.wait((f) => f.frameId === 'after-stop')
    assert.equal(stopped.peers.find((p: any) => p.memberId === 'mem_admin').editing.length, 0)
    a.socket.send(JSON.stringify({ type: 'presence_edit', frameId: 'restart', target, active: true }))
    await a.wait((f) => f.frameId === 'restart')
    a.socket.close(); await once(a.socket, 'close')
    await b.wait((f) => f.type === 'presence_snapshot' && !f.peers.some((p: any) => p.memberId === 'mem_admin'))
    console.log('real bridge three-client presence and save receipts: metadata fanout, authenticated authors/name/avatar, privacy, viewer refusal, live role revocation, stop and disconnect passed')
  } finally {
    for (const socket of sockets) socket.terminate()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}
void main().catch((err) => { console.error(err); process.exitCode = 1 })
