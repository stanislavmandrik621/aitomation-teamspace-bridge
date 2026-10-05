/** Real bridge regression: per-item revocation gates history, files and writes. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'revocation-deep-audit-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  try {
    const identities = [
      { id: 'admin', role: 'admin', devices: ['admin-device'] },
      { id: 'removed', role: 'member', devices: ['removed-live', 'removed-offline'] },
      { id: 'retained', role: 'member', devices: ['retained-device', 'retained-offline'] },
    ]
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'audit-team', name: 'Audit', createdAt: 1 }))
    writeFileSync(join(dir, 'members.json'), JSON.stringify(identities.map(({ id, role, devices }) => ({
      memberId: id, displayName: id, email: `${id}@example.test`, role, createdAt: 1,
      sessions: Object.fromEntries(devices.map(device => [device, hashSessionToken(`${device}-token`)])),
    }))))
    const reservation = createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    initializeCurrentAuthority(dir,dir+'.authority')
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_AT_REST_KEY: '', TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED: 'true', TEAMSPACE_YJS_COMPOSE_ENABLED: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Startup timeout')), 20_000)
      child!.stdout!.on('data', data => { if (String(data).includes('bridge listening')) { clearTimeout(timer); resolve() } })
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}`)) })
    })
    async function connect(id: string, device: string) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(socket)
      const inbox: Frame[] = []
      const all: Frame[] = []
      socket.on('message', data => { const frame = JSON.parse(String(data)); inbox.push(frame); all.push(frame) })
      await once(socket, 'open')
      const wait = async (predicate: (frame: Frame) => boolean) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate)
          if (index >= 0) return inbox.splice(index, 1)[0]!
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error('Expected frame missing')
      }
      socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId: id, deviceId: device, sessionToken: `${device}-token` }))
      await wait(frame => frame.type === 'hello_ok')
      await wait(frame => frame.type === 'catchup_status' && frame.done)
      return { socket, wait, all }
    }
    const admin = await connect('admin', 'admin-device')
    const removed = await connect('removed', 'removed-live')
    const retained = await connect('retained', 'retained-device')
    let counter = 0
    const epochs = new Map<string, number>()
    async function send(client: typeof admin, kind: string, targetId: string, patch: Frame, visibleToMemberIds?: string[], extra: Frame = {}) {
      const opId = `audit-${++counter}`
      client.socket.send(JSON.stringify({ type: 'ops', frameId: opId, ops: [{
        opId, kind, targetKind: kind.startsWith('record.') ? 'record' : 'module', targetId,
        moduleId: 'private-module', originDevice: 'claimed-device', hlc: `${Date.now()}:0:audit`,
        protocolVersion: 2, hopCount: 0, patch,
        contentAclRevision: epochs.get(kind.startsWith('compose.') ? `compose:${targetId}` : `module:${extra.moduleId ?? 'private-module'}`) ?? 0,
        ...(visibleToMemberIds ? { visibleToMemberIds } : {}),
        ...extra,
      }] }))
      const frame = await client.wait(f => f.type === 'ops_result' && f.frameId === opId)
      const row = frame.results[0]
      if (typeof row.contentAclItem === 'string' && typeof row.contentAclRevision === 'number') epochs.set(row.contentAclItem, row.contentAclRevision)
      return { opId, result: frame.results[0] }
    }
    const blob = Buffer.from('audit-private-attachment')
    const sha = createHash('sha256').update(blob).digest('hex')
    const blobUrl = `http://127.0.0.1:${port}/v1/blobs/${sha}`
    const uploaded = await fetch(blobUrl, { method: 'PUT', headers: { authorization: 'Bearer admin-device-token' }, body: blob })
    assert.equal(uploaded.status, 200)
    const prior = await send(admin, 'module.create', 'private-module', { id: 'private-module', name: 'Private history', attachment: { __teamspaceBlob: sha } }, ['removed', 'retained'])
    assert.equal(prior.result.status, 'applied')
    await removed.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === prior.opId))
    const createdRecord = await send(admin, 'record.create', 'known-record', { id: 'known-record', data: { note: 'shared' } }, ['removed', 'retained'])
    assert.equal(createdRecord.result.status, 'applied')
    const room = 'yjs:known-record:description'
    removed.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'before-revoke-join', room }))
    assert.equal((await removed.wait(f => f.frameId === 'before-revoke-join')).type, 'yjs_ok')
    const revoke = await send(admin, 'module.share_revoked', 'private-module', { moduleId: 'private-module', authoritativeDelete: true, visibleToMemberIds: ['removed'] }, ['removed'])
    assert.equal(revoke.result.status, 'applied')
    await removed.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === revoke.opId))
    const narrowed = await send(admin, 'module.update', 'private-module', { id: 'private-module', name: 'Retained only' }, ['retained'])
    assert.equal(narrowed.result.status, 'applied')

    const offline = await connect('removed', 'removed-offline')
    const historyLeaked = offline.all.some(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === prior.opId))
    const downloaded = await fetch(blobUrl, { headers: { authorization: 'Bearer removed-live-token' } })
    const blobLeaked = downloaded.status === 200 && await downloaded.text() === blob.toString()
    const forged = await send(removed, 'record.update', 'known-record', { id: 'known-record', data: { note: 'after-revoke-write' } })
    let deliveredToRetained = false
    if (forged.result.status === 'applied') {
      await retained.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === forged.opId))
      deliveredToRetained = true
    }
    console.log(JSON.stringify({
      historicalContentDeliveredToOfflineRevokedDevice: historyLeaked,
      revokedAttachmentGetStatus: downloaded.status,
      revokedAttachmentBytesDelivered: blobLeaked,
      revokedMemberWriteStatus: forged.result.status,
      revokedMemberWriteRelayedToRetainedMember: deliveredToRetained,
    }, null, 2))
    assert.equal(historyLeaked, false, 'current ACL must filter historical snapshots')
    assert.equal(downloaded.status, 404, 'revoked attachment download is denied without an existence oracle')
    assert.equal(forged.result.status, 'refused', 'bridge must reject revoked writes before append')
    assert.equal(deliveredToRetained, false)
    removed.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'after-revoke-join', room }))
    assert.equal((await removed.wait(f => f.frameId === 'after-revoke-join')).type, 'yjs_refuse')
    removed.socket.send(JSON.stringify({ type: 'yjs_update', frameId: 'after-revoke-yjs-write', room, updateB64: 'AQ==' }))
    assert.equal((await removed.wait(f => f.frameId === 'after-revoke-yjs-write')).type, 'yjs_refuse')
    const retainedGet = await fetch(blobUrl, { headers: { authorization: 'Bearer retained-device-token' } })
    assert.equal(retainedGet.status, 200, 'retained recipients still download the same attachment')
    assert.equal(await retainedGet.text(), blob.toString())
    assert.equal((await send(admin, 'module.create', 'other-module', { id: 'other-module' }, ['removed', 'retained'], { moduleId: 'other-module' })).result.status, 'applied')
    const legacyBlob = await send(removed, 'record.create', 'legacy-blob', {}, undefined, {
      moduleId: 'other-module', payload_json: JSON.stringify({ id: 'legacy-blob', image: { __teamspaceBlob: sha } }),
    })
    assert.equal(legacyBlob.result.status, 'refused', 'legacy payload cannot introduce a revoked attachment hash')
    const legacyParent = await send(removed, 'record.create', 'legacy-parent', {}, undefined, {
      moduleId: 'other-module', payload_json: JSON.stringify({ id: 'legacy-parent', moduleId: 'private-module' }),
    })
    assert.equal(legacyParent.result.status, 'refused', 'legacy parent override must not bypass current authority')
    const validLegacy = await send(removed, 'record.create', 'legacy-valid', {}, undefined, {
      moduleId: 'other-module', payload_json: JSON.stringify({ id: 'legacy-valid', data: { note: 'canonical-content' } }),
    })
    assert.equal(validLegacy.result.status, 'applied')
    const legacyFrame = await retained.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === validLegacy.opId))
    const legacyWire = legacyFrame.ops.find((op: Frame) => op.opId === validLegacy.opId)
    assert.equal(legacyWire.patch.data.note, 'canonical-content')
    assert.equal('payload_json' in legacyWire, false)
    const deleted = await send(admin, 'module.delete', 'private-module', { id: 'private-module', secret: 'must-not-travel' }, ['retained'], { extraSecret: 'must-not-travel' })
    assert.equal(deleted.result.status, 'applied')
    const deleteFrame = await retained.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === deleted.opId))
    assert.equal(JSON.stringify(deleteFrame).includes('must-not-travel'), false, 'cleanup notices contain no historical payload or extra fields')
    const retainedOffline = await connect('retained', 'retained-offline')
    assert.equal(retainedOffline.all.some(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === deleted.opId)), true)
    assert.equal(retainedOffline.all.some(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === prior.opId)), false)

    async function composeAcl(memberIds: string[] | null) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/teamspace/compose-acl`, {
        method: 'POST', headers: { authorization: 'Bearer admin-device-token', 'content-type': 'application/json' },
        body: JSON.stringify({ teamId: 'audit-team', mutation: { documentId: 'board', memberIds } }),
      })
      assert.equal(response.status, 200, JSON.stringify(await response.json()))
    }
    await composeAcl(['removed', 'retained'])
    const board = await send(admin, 'compose.doc.create', 'board', { id: 'board', attachment: { __teamspaceBlob: sha } }, ['removed', 'retained'])
    assert.equal(board.result.status, 'applied')
    const boardRoom = 'yjs:composeDoc:board'
    removed.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'board-before', room: boardRoom }))
    assert.equal((await removed.wait(f => f.frameId === 'board-before')).type, 'yjs_ok')
    await composeAcl(['retained'])
    assert.equal((await fetch(blobUrl, { headers: { authorization: 'Bearer removed-live-token' } })).status, 404, 'HTTP board revoke must also revoke its synced blob')
    assert.equal((await send(removed, 'compose.doc.create', 'board', { id: 'board' })).result.status, 'refused')
    removed.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'board-http-revoked', room: boardRoom }))
    assert.equal((await removed.wait(f => f.frameId === 'board-http-revoked')).type, 'yjs_refuse')
    await composeAcl(['removed', 'retained'])
    const refreshed = await removed.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.kind === 'compose.access' && op.contentAclRevision > 1))
    const epoch = refreshed.ops.find((op: Frame) => op.kind === 'compose.access').contentAclRevision
    assert.equal((await send(removed, 'compose.doc.create', 'board', { id: 'board' }, undefined, { contentAclRevision: 0 })).result.status, 'refused', 'HTTP re-grant cannot revive old queued snapshots')
    assert.equal((await send(removed, 'compose.doc.create', 'board', { id: 'board' }, undefined, { contentAclRevision: epoch })).result.status, 'applied', 'retained/re-granted member can use the refreshed epoch')
    const wireRevoke = await send(admin, 'compose.share_revoked', 'board', { id: 'board', authoritativeDelete: true }, ['removed'])
    assert.equal(wireRevoke.result.status, 'applied')
    removed.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'board-wire-revoked', room: boardRoom }))
    assert.equal((await removed.wait(f => f.frameId === 'board-wire-revoked')).type, 'yjs_refuse', 'sync revoke must also revoke the HTTP-authorized room')
    console.log('Deletion delivery/redaction, canonical legacy payloads, and bidirectional Compose HTTP/sync revocation passed')
    // Control: whole-team kick still denies both HTTP and reconnect.
    const close = once(removed.socket, 'close')
    admin.socket.send(JSON.stringify({ type: 'kick_member', frameId: 'audit-kick', memberId: 'removed' }))
    await admin.wait(f => f.type === 'kick_ok' && f.frameId === 'audit-kick')
    await close
    const kickedGet = await fetch(blobUrl, { headers: { authorization: 'Bearer removed-live-token' } })
    assert.equal(kickedGet.status, 401)
    console.log('CONTROL: whole-team kick blocks the same blob GET (401)')
  } finally {
    for (const socket of sockets) socket.terminate()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
