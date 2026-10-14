/** Real-server regressions for enterprise revocation boundaries.
 * Run: node --import tsx tests/revocation-enterprise-audit-live.ts
 */
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
  const dir = mkdtempSync(join(tmpdir(), 'revocation-enterprise-audit-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  let logs = ''
  try {
    const members = ['admin', 'coadmin', 'removed', 'retained']
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'enterprise-audit', name: 'Audit', createdAt: 1 }))
    writeFileSync(join(dir, 'members.json'), JSON.stringify(members.map(memberId => ({
      memberId, displayName: memberId, email: `${memberId}@example.test`, createdAt: 1,
      role: memberId.endsWith('admin') ? 'admin' : 'member',
      sessions: Object.fromEntries(['live', 'offline'].map(device => [`${memberId}-${device}`, hashSessionToken(`${memberId}-${device}-token`)])),
    }))))
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
    initializeCurrentAuthority(dir,dir+'.authority')
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Startup timeout: ${logs}`)), 20_000)
      child!.stderr!.on('data', data => { logs = (logs + String(data)).slice(-8000) })
      child!.stdout!.on('data', data => { if (String(data).includes('bridge listening')) { clearTimeout(timer); resolve() } })
      child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${logs}`)) })
    })
    async function open() {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(socket)
      const inbox: Frame[] = [], all: Frame[] = []
      socket.on('message', data => { const frame = JSON.parse(String(data)); inbox.push(frame); all.push(frame) })
      await once(socket, 'open')
      const wait = async (predicate: (frame: Frame) => boolean) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate)
          if (index >= 0) return inbox.splice(index, 1)[0]!
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        throw new Error(`Expected frame missing: ${JSON.stringify(inbox).slice(-3000)}`)
      }
      const request = async (frame: Frame) => {
        socket.send(JSON.stringify(frame))
        return wait(f => f.frameId === frame.frameId || f.requestId === frame.frameId)
      }
      return { socket, all, wait, request }
    }
    async function connect(memberId: string, device = 'live') {
      const client = await open()
      client.socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId,
        deviceId: `${memberId}-${device}`, sessionToken: `${memberId}-${device}-token` }))
      await client.wait(f => f.type === 'hello_ok')
      await client.wait(f => f.type === 'catchup_status' && f.done)
      return client
    }
    const admin = await connect('admin'), removed = await connect('removed'), retained = await connect('retained')
    let counter = 0
    const epochs = new Map<string, number>()
    async function send(client: typeof admin, moduleId: string, kind: string, targetId: string, patch: Frame, audience?: string[], revision?: number) {
      const opId = `enterprise-${++counter}`
      const response = await client.request({ type: 'ops', frameId: opId, ops: [{ opId, kind, targetId,
        targetKind: kind.split('.')[0], moduleId, patch, originDevice: 'claimed',
        protocolVersion: 2, hopCount: 0, hlc: `${Date.now()}:0:audit`,
        ...(audience === undefined ? {} : { visibleToMemberIds: audience }),
        contentAclRevision: revision ?? epochs.get(moduleId) ?? 0,
      }] })
      assert.equal(response.type, 'ops_result', JSON.stringify(response))
      if (typeof response.results[0].contentAclRevision === 'number') epochs.set(moduleId, response.results[0].contentAclRevision)
      return { opId, result: response.results[0] }
    }
    async function makeModule(moduleId: string, audience?: string[]) {
      const bytes = Buffer.from(`private-bytes:${moduleId}`)
      const sha = createHash('sha256').update(bytes).digest('hex')
      const url = `http://127.0.0.1:${port}/v1/blobs/${sha}`
      assert.equal((await fetch(url, { method: 'PUT', headers: { authorization: 'Bearer admin-live-token' }, body: bytes })).status, 200)
      const create = await send(admin, moduleId, 'module.create', moduleId, { id: moduleId, attachment: { __teamspaceBlob: sha } }, audience)
      assert.equal(create.result.status, 'applied')
      return { url, bytes, create }
    }
    // Match desktop unshare: current durable roster, chunked targeted cleanup,
    // Explicit whole-team unshare is separate from individual cleanup targets.
    const unshared = await makeModule('whole-team-unshared')
    assert.equal((await send(admin, 'whole-team-unshared', 'module.share_revoked', 'whole-team-unshared',
      { moduleId: 'whole-team-unshared', authoritativeDelete: true, unsharedFromTeam: true, revokedAt: Date.now() }, members)).result.status, 'applied')
    const currentGet = await fetch(unshared.url, { headers: { authorization: 'Bearer removed-live-token' } })
    assert.equal(currentGet.status, 404, 'control: current removed member is blocked')
    const invite = await admin.request({ type: 'invite_create', frameId: 'new-member-invite', email: 'future@example.test', role: 'member' })
    assert.equal(invite.type, 'invite_ok', JSON.stringify(invite))
    const future = await open()
    const redemption = await future.request({ type: 'invite_redeem', frameId: 'new-member-redeem', token: invite.token,
      deviceId: 'future-device', memberEmail: 'future@example.test', displayName: 'Future member' })
    assert.equal(redemption.type, 'invite_redeem_ok', JSON.stringify(redemption))
    await future.wait(f => f.type === 'catchup_status' && f.done)
    const futureGet = await fetch(unshared.url, { headers: { authorization: `Bearer ${redemption.sessionToken}` } })
    const futureBytes = futureGet.status === 200 && await futureGet.text() === unshared.bytes.toString()
    const futureHistory = future.all.some(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === unshared.create.opId))

    const restricted = await makeModule('revoked-private', ['removed', 'retained'])
    assert.equal((await send(admin, 'revoked-private', 'record.create', 'private-record', { id: 'private-record', data: { secret: 'classified' } })).result.status, 'applied')
    const revoke = await send(admin, 'revoked-private', 'module.update', 'revoked-private', { id: 'revoked-private' }, ['retained'])
    assert.equal(revoke.result.status, 'applied')
    const automaticCleanup = await removed.wait(f => f.type === 'ops' && f.ops.some((op: Frame) => op.kind === 'module.share_revoked' && op.targetId === 'revoked-private'))
    assert.ok(automaticCleanup.ops.some((op: Frame) => op.targetId === 'revoked-private' && op.patch.authoritativeDelete === true && op.teamId === 'enterprise-audit'), 'narrowing itself must deliver team-bound cleanup live')
    assert.equal((await fetch(restricted.url, { headers: { authorization: 'Bearer removed-live-token' } })).status, 404)
    const retainedLease = await retained.request({ type: 'presence_edit', frameId: 'retained-presence', active: true,
      target: { leaseId: 'retained-lease', entityId: 'private-entity', viewId: 'private-view', recordId: 'private-record' } })
    assert.equal(retainedLease.type, 'presence_snapshot', JSON.stringify(retainedLease))
    const observed = await removed.request({ type: 'presence_get', frameId: 'revoked-observer' })
    assert.equal(observed.type, 'presence_snapshot')
    const leakedPresence = observed.peers.some((peer: Frame) => peer.memberId === 'retained'
      && peer.editing?.some((lease: Frame) => lease.recordId === 'private-record'))
    const revokedLease = await removed.request({ type: 'presence_edit', frameId: 'revoked-presence', active: true,
      target: { leaseId: 'unauthorized-lease', entityId: 'private-entity', viewId: 'private-view', recordId: 'private-record' } })
    const retainedObservation = await retained.request({ type: 'presence_get', frameId: 'retained-observer' })
    const forgedPresence = retainedObservation.peers?.some((peer: Frame) => peer.memberId === 'removed'
      && peer.editing?.some((lease: Frame) => lease.recordId === 'private-record')) === true

    // A legitimate co-admin's pre-revocation snapshot drains late. It is an
    // ordinary module update, not an explicit request to re-share the item.
    const coadmin = await connect('coadmin')
    const stale = await send(coadmin, 'revoked-private', 'module.update', 'revoked-private',
      { id: 'revoked-private', name: 'Old offline name' }, ['removed', 'retained'], 0)
    const afterStale = await fetch(restricted.url, { headers: { authorization: 'Bearer removed-live-token' } })
    const staleBytes = afterStale.status === 200 && await afterStale.text() === restricted.bytes.toString()
    const offlineRemoved = await connect('removed', 'offline')
    const staleHistory = offlineRemoved.all.some(f => f.type === 'ops' && f.ops.some((op: Frame) => op.opId === restricted.create.opId))
    // A second live reference correctly preserves a shared attachment; deleting
    // that last authorized reference must not preserve historical blob authority.
    const lineage = await makeModule('lineage-private', ['removed', 'retained'])
    const lineageSha = createHash('sha256').update(lineage.bytes).digest('hex')
    assert.equal((await send(admin, 'lineage-retained', 'module.create', 'lineage-retained', { id: 'lineage-retained' }, ['removed'])).result.status, 'applied')
    assert.equal((await send(admin, 'lineage-retained', 'record.create', 'last-reference', { id: 'last-reference', image: { __teamspaceBlob: lineageSha } })).result.status, 'applied')
    assert.equal((await send(admin, 'lineage-private', 'module.update', 'lineage-private', { id: 'lineage-private' }, ['retained'])).result.status, 'applied')
    const lineageGet = () => fetch(lineage.url, { headers: { authorization: 'Bearer removed-live-token' } })
    assert.equal((await lineageGet()).status, 200, 'control: another current reference preserves access')
    assert.equal((await send(admin, 'lineage-retained', 'record.delete', 'last-reference', { id: 'last-reference' })).result.status, 'applied')
    const deletedReferenceGet = await lineageGet()
    const deletedReferenceBytes = deletedReferenceGet.status === 200 && await deletedReferenceGet.text() === lineage.bytes.toString()
    const batchItem = await makeModule('batch-safety', ['removed', 'retained'])
    const batchBase = { targetId: 'batch-safety', targetKind: 'module', moduleId: 'batch-safety', originDevice: 'claimed',
      protocolVersion: 2, hopCount: 0, hlc: `${Date.now()}:0:audit`, contentAclRevision: 0 }
    const batchRevoke = { ...batchBase, opId: 'in-frame-revoke', kind: 'module.share_revoked', visibleToMemberIds: ['removed'], patch: { authoritativeDelete: true } }
    const batchStale = { ...batchBase, opId: 'in-frame-stale', kind: 'module.update', visibleToMemberIds: ['removed', 'retained'], patch: { id: 'batch-safety' } }
    const batchResult = await admin.request({ type: 'ops', frameId: 'in-frame-race', ops: [batchRevoke, batchStale] })
    assert.equal(batchResult.results.find((row: Frame) => row.opId === batchRevoke.opId).status, 'applied')
    assert.equal(batchResult.results.find((row: Frame) => row.opId === batchStale.opId).status, 'refused')
    assert.equal((await fetch(batchItem.url, { headers: { authorization: 'Bearer removed-live-token' } })).status, 404)
    const grant = { ...batchStale, opId: 'explicit-current-grant', contentAclRevision: batchResult.results[0].contentAclRevision }
    const granted = await admin.request({ type: 'ops', frameId: 'explicit-grant', ops: [grant] })
    assert.equal(granted.results[0].status, 'applied', 'fresh explicit administrator grant remains supported')
    assert.ok(granted.results[0].contentAclRevision > grant.contentAclRevision, 'sender receives the committed new epoch')
    const retry = await admin.request({ type: 'ops', frameId: 'exact-grant-retry', ops: [grant] })
    assert.equal(retry.results[0].status, 'applied', 'lost acknowledgements may retry exactly without replaying the mutation')
    assert.equal(retry.results[0].contentAclRevision, granted.results[0].contentAclRevision)
    // Fresh reads must agree with the desktop's current cells and lifecycle.
    const holder = 'lineage-retained'
    await send(admin, holder, 'entity.create', 'lineage-entity', { id: 'lineage-entity', moduleId: holder })
    await send(admin, holder, 'record.create', 'ordered-reference', { entityId: 'lineage-entity', data: { image: { __teamspaceBlob: lineageSha } }, cellHlcs: { image: '100:0:d' } })
    assert.equal((await lineageGet()).status, 200)
    await send(admin, holder, 'record.update', 'ordered-reference', { data: { image: null, cellHlcs: { __teamspaceBlob: lineageSha } }, cellHlcs: { image: '300:0:d' } })
    assert.equal((await lineageGet()).status, 404, 'ignored cell metadata cannot retain a download grant')
    await send(admin, holder, 'record.update', 'ordered-reference', { data: { image: { __teamspaceBlob: lineageSha } }, cellHlcs: { image: '200:0:d' } })
    assert.equal((await lineageGet()).status, 404, 'a delayed field write cannot restore the reference')
    await send(admin, holder, 'field.create', 'lineage-field', { entityId: 'lineage-entity', slug: 'image', fieldType: 'file' })
    await send(admin, holder, 'record.update', 'ordered-reference', { data: { image: { __teamspaceBlob: lineageSha } }, cellHlcs: { image: '400:0:d' } })
    assert.equal((await lineageGet()).status, 200)
    assert.equal((await send(removed, holder, 'field.delete', 'lineage-field', {})).result.status, 'refused')
    assert.equal((await send(admin, holder, 'field.delete', 'lineage-field', {})).result.status, 'applied')
    assert.equal((await lineageGet()).status, 404, 'field deletion retires its cells')
    await send(admin, holder, 'record.create', 'purged-reference', { entityId: 'lineage-entity', data: { other: { __teamspaceBlob: lineageSha } } })
    assert.equal((await lineageGet()).status, 200)
    assert.equal((await send(removed, holder, 'record.purge', 'purged-reference', {})).result.status, 'refused', 'default Member role cannot delete table records')
    assert.equal((await send(admin, holder, 'record.purge', 'purged-reference', {})).result.status, 'applied')
    assert.equal((await lineageGet()).status, 404, 'authorized row purge retires the last reference')
    assert.equal((await send(admin, holder, 'entity.delete', 'lineage-entity', {})).result.status, 'applied')
    assert.equal((await send(admin, holder, 'record.create', 'deleted-parent-child', { entityId: 'lineage-entity' })).result.status, 'refused')
    const findings = {
      wholeUnshare: { existingMemberGet: currentGet.status, futureMemberGet: futureGet.status,
        futureMemberReceivedPrivateBytes: futureBytes, futureMemberReceivedHistoricalSnapshot: futureHistory },
      staleCoAdmin: { oldRevision: 0, writeStatus: stale.result.status, revokedMemberGet: afterStale.status,
        revokedMemberReceivedPrivateBytes: staleBytes, revokedDeviceReceivedHistoricalSnapshot: staleHistory },
      presence: { revokedMemberSawPrivateRecordEditing: leakedPresence,
        revokedMemberLeaseResponse: revokedLease.type, unauthorizedLeaseDeliveredToRetainedMember: forgedPresence },
      blobLineage: { lastAuthorizedReferenceDeleted: true, revokedMemberGet: deletedReferenceGet.status,
        privateBytesAvailableThroughDeletedReference: deletedReferenceBytes },
    }
    console.log(JSON.stringify(findings, null, 2))
    const blocked = futureBytes || futureHistory || staleBytes || staleHistory || leakedPresence || forgedPresence || deletedReferenceBytes
    assert.equal(futureGet.status, 404)
    assert.equal(stale.result.status, 'refused')
    assert.equal(afterStale.status, 404)
    assert.equal(deletedReferenceGet.status, 404)
    assert.equal(revokedLease.type, 'error')
    assert.equal(blocked, false, 'every adversarial revocation gate must stay closed')
    console.log('Enterprise revocation live regression: all gates passed, including automatic cleanup, ordered/metadata references, field deletion and purge')
  } finally {
    for (const socket of sockets) socket.terminate()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
