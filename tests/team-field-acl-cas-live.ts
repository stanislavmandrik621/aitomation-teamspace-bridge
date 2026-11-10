/** Two independent Admin sockets must not erase each other's ACL tightening. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

type Bag = { version: number; entities: unknown[]; fields: Array<{ entityId: string; fieldSlug: string; role: 'member' | 'viewer'; read: boolean; write: boolean; hidden: boolean }> }
type Authority = { revision: number; hash: string; bag: Bag | null }
type Frame = Record<string, any>
// Intentionally independent of server helpers: an incorrect canonical hash
// must fail this protocol test, not produce the same incorrect expectation.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  const text = JSON.stringify(value)
  assert.notEqual(text, undefined)
  return text!
}
const hash = (bag: Bag | null): string => createHash('sha256').update(canonical(bag)).digest('hex')
const hiddenBag = (version: number, ...slugs: string[]): Bag => ({ version, entities: [], fields: slugs.flatMap(fieldSlug =>
  (['member', 'viewer'] as const).map(role => ({ entityId: 'entity', fieldSlug, role, read: false, write: false, hidden: true }))) })
function authority(frame: Frame): Authority {
  const row = frame.fieldAclAuthority as Authority | undefined
  assert.ok(row, `Admin response must carry current field ACL authority: ${JSON.stringify(frame)}`)
  assert.ok(Number.isSafeInteger(row.revision) && row.revision >= 0)
  assert.equal(row.hash, hash(row.bag), 'authority hash matches independently canonicalized normalized bag')
  return row
}
const dir = mkdtempSync(join(tmpdir(), 'field-acl-cas-live-'))
let child: ReturnType<typeof spawn> | undefined, logs = '', serial = 0
let port = 0
const sockets: WebSocket[] = []
const op = (kind: string, targetId: string, extra: Record<string, unknown> = {}): ModulesSyncOp => ({
  opId: `field-acl-cas-${++serial}`, kind, targetId, targetKind: kind.split('.')[0], moduleId: targetId,
  originDevice: 'admin-a', originMemberId: 'admin-a', originRole: 'admin', hlc: `${serial}:0:admin-a`, protocolVersion: 2, hopCount: 0,
  ...extra,
})
const proposal = (moduleId: string, bag: Bag | null, base: string, extra: Record<string, unknown> = {}) => op('module.update', moduleId, {
  fieldAclBaseHash: base, patch: { config: { teamSpaceAclGrantBag: bag } }, ...extra,
})
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const result = read()
    if (result !== undefined) return result
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}\n${logs}`)
}
async function stop(): Promise<void> {
  for (const socket of sockets.splice(0)) socket.terminate()
  if (child && child.exitCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await exited
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
    env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED: 'true' },
  })
  child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) listening = true })
  child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, 'test recovery key redacted')).slice(-6000) })
  await until(() => listening || undefined, 'bridge startup')
}
async function connect(memberId: string, restoreReplay=false) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`), frames: Frame[] = []
  sockets.push(socket)
  socket.on('message', data => frames.push(JSON.parse(String(data))))
  await once(socket, 'open')
  socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId, deviceId: memberId, sessionToken: `${memberId}-token`,restoreReplay }))
  const hello = await until(() => frames.find(frame => frame.type === 'hello_ok'), 'hello')
  await until(() => frames.find(frame => frame.type === 'catchup_status' && frame.done), 'catchup')
  const request = async (frameId: string, ops: ModulesSyncOp[]) => {
    socket.send(JSON.stringify({ type: 'ops', frameId, ops }))
    return until(() => frames.find(frame => frame.type === 'ops_result' && frame.frameId === frameId), frameId)
  }
  const delivered = () => frames.flatMap(frame => frame.type === 'ops' ? frame.ops : []) as ModulesSyncOp[]
  const rawRequest = async (frame: Frame) => {
    socket.send(JSON.stringify(frame))
    return until(() => frames.find(row => row.frameId === frame.frameId), 'raw request')
  }
  return { socket, frames, hello, request, delivered, rawRequest }
}
try {
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'field-acl-cas-team', name: 'ACL CAS test', createdAt: 1 }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify(['admin-a', 'admin-b', 'member', 'viewer'].map(memberId => ({
    memberId, displayName: memberId, email: `${memberId}@example.test`, createdAt: 1,
    role: memberId.startsWith('admin') ? 'admin' : memberId, sessions: { [memberId]: hashSessionToken(`${memberId}-token`) },
  }))))
  const fixture = new BridgeStore(dir, 21, null, null)
  const historicalSecret = 'HISTORICAL_SALARY_PRIVATE_CAS_PROBE'
  const document = (field: string, text: string) => {
    const doc = new Y.Doc(), meta = doc.getMap('_modules_checkpoint')
    meta.set('binding', JSON.stringify(['historical-record', field, 'text']))
    meta.set('genesis', 'a'.repeat(64))
    doc.getText('content').insert(0, text)
    return doc
  }
  const salaryDoc = document('salary', historicalSecret), publicDoc = document('public_note', 'Public note')
  const encoded = (doc: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64')
  const historicalCheckpoint = encoded(salaryDoc)
  const bytes = Buffer.from('private field attachment'), blobSha = createHash('sha256').update(bytes).digest('hex')
  assert.equal((await fixture.putBlobFromStream(blobSha, Readable.from([bytes]), bytes.length)).ok, true)
  fixture.appendOps([op('module.create', 'module-one'), op('module.create', 'module-two'),
    op('entity.create', 'entity', { moduleId: 'module-one', entityId: 'entity' }),
    op('field.create', 'salary-field', { moduleId: 'module-one', entityId: 'entity', patch: { slug: 'salary', fieldType: 'text' } }),
    op('field.create', 'private-file-field', { moduleId: 'module-one', entityId: 'entity', patch: { slug: 'private_file', fieldType: 'file' } }),
    op('record.create', 'historical-record', { moduleId: 'module-one', entityId: 'entity',
      patch: { data: { salary: historicalSecret, private_file: [{ __teamspaceBlob: blobSha }], public_note: 'Public note' }, cellHlcs: { salary: '5:0:admin-a', public_note: '5:0:admin-a' },
        yjsCheckpoint: { fieldSlug: 'salary', kind: 'text', stateB64: historicalCheckpoint },
        yjsCheckpointSave: true, yjsCheckpointSaveId: 'private-checkpoint-save', yjsResets: [{ fieldSlug: 'salary', resetId: 'hlc:private-reset' }] } }),
  ])
  initializeCurrentAuthority(dir,dir+'.authority')
  await start()
  const adminA = await connect('admin-a'), adminB = await connect('admin-b'), member = await connect('member'), viewer = await connect('viewer')
  const h0 = authority(adminA.hello)
  assert.deepEqual(authority(adminB.hello), h0, 'both independent Admins author from the same snapshot')
  assert.equal(h0.bag, null)
  assert.equal(h0.revision, 0)
  assert.equal(Object.hasOwn(member.hello, 'fieldAclAuthority'), false, 'member hello cannot disclose the team-wide ACL bag')
  assert.deepEqual(member.hello.fieldAclBaseline, {revision:h0.revision,hash:h0.hash})
  assert.deepEqual(viewer.hello.fieldAclBaseline, {revision:h0.revision,hash:h0.hash})
  const secretRoom = 'yjs:historical-record:salary', publicRoom = 'yjs:historical-record:public_note'
  for (const client of [adminA, member, viewer]) assert.equal((await client.rawRequest({ type: 'yjs_join', frameId: 'join-before-hide', room: secretRoom })).type, 'yjs_ok')
  assert.equal((await member.rawRequest({ type: 'yjs_join', frameId: 'join-public', room: publicRoom })).type, 'yjs_ok')
  const blobGet = (identity: string) => fetch(`http://127.0.0.1:${port}/v1/blobs/${blobSha}`, { headers: { authorization: `Bearer ${identity}-token` } })
  assert.equal((await blobGet('member')).status, 200, 'reference was downloadable before field Hide')
  const bagA = hiddenBag(1, 'salary', 'private_file'), bagB = hiddenBag(1, 'billing_secret')
  const authoredA = proposal('module-one', bagA, h0.hash, { fieldAclRevision: 999_999 })
  const authoredB = proposal('module-two', bagB, h0.hash)
  const first = await adminA.request('first-tightening', [authoredA])
  assert.equal(first.results[0]?.status, 'applied', JSON.stringify(first))
  const h1 = authority(first)
  assert.equal(h1.revision, h0.revision + 1, 'forged client revision is ignored')
  assert.deepEqual(h1.bag, bagA)
  for (const client of [member, viewer]) {
    const notice = await until(() => client.frames.find(frame => frame.type === 'field_acl_baseline' && frame.fieldAclBaseline?.revision === h1.revision), 'member current permission version')
    assert.deepEqual(notice, {type:'field_acl_baseline',teamId:adminA.hello.teamId,fieldAclBaseline:{revision:h1.revision,hash:h1.hash}}, 'permission notification contains no hidden item identifiers or grants')
  }
  for (const client of [member, viewer]) {
    await until(() => client.frames.find(frame => frame.type === 'yjs_refuse' && frame.room === secretRoom), 'already joined private-field peer evicted')
    assert.equal((await client.rawRequest({ type: 'yjs_join', frameId: 'join-after-hide', room: secretRoom })).type, 'yjs_refuse')
  }
  assert.equal((await member.rawRequest({ type: 'yjs_update', frameId: 'write-after-hide', room: secretRoom, updateB64: 'AQ==' })).type, 'yjs_refuse')
  assert.equal((await member.rawRequest({ type: 'yjs_update', frameId: 'public-write', room: publicRoom, updateB64: encoded(publicDoc) })).type, 'yjs_ok', 'public sibling remains co-editable')
  assert.equal((await adminA.rawRequest({ type: 'yjs_update', frameId: 'admin-private-write', room: secretRoom, updateB64: encoded(salaryDoc) })).type, 'yjs_ok')
  assert.equal((await blobGet('member')).status, 404, 'hidden-field-only attachment loses download access')
  assert.equal((await blobGet('viewer')).status, 404)
  assert.equal((await blobGet('admin-a')).status, 200, 'Admin keeps original attachment')
  const memberFresh = await member.request('member-fresh-after-receipt', [op('record.update', 'historical-record', {
    moduleId:'module-one',entityId:'entity',fieldAclBaseHash:h1.hash,patch:{data:{public_note:'Member edit after current permission receipt'}},
  })])
  assert.equal(memberFresh.results[0]?.status, 'applied', JSON.stringify(memberFresh))
  assert.deepEqual(memberFresh.fieldAclBaseline, {revision:h1.revision,hash:h1.hash})
  assert.equal(Object.hasOwn(memberFresh, 'fieldAclAuthority'), false)
  const memberStale = await member.request('member-old-queued-version', [op('record.update', 'historical-record', {
    moduleId:'module-one',entityId:'entity',fieldAclBaseHash:h0.hash,patch:{data:{public_note:'Older queued edit must require review'}},
  })])
  assert.equal(memberStale.results[0]?.status, 'refused')
  assert.equal(memberStale.results[0]?.permanent, true)
  const peerFirst = await until(() => adminB.delivered().find(row => row.opId === authoredA.opId), 'first ACL fanout')
  assert.equal((peerFirst as any).fieldAclRevision, h1.revision, 'peer receives bridge-stamped revision')
  const beforeRefusal = adminA.delivered().length
  const stale = await adminB.request('stale-other-admin', [authoredB])
  assert.equal(stale.results[0]?.status, 'refused', JSON.stringify(stale))
  assert.equal(stale.results[0]?.permanent, true, 'stale author-time ACL cannot be silently retried/rebased')
  assert.deepEqual(authority(stale), h1, 'the loser learns the actual winner')
  assert.equal(adminA.delivered().length, beforeRefusal, 'refused proposal is never fanned out')
  assert.equal(member.delivered().some(row => row.opId === authoredB.opId), false)

  // One team-wide ACL is propagated on each module, but these copies are one
  // permission transition, including retries still carrying its original base.
  const fanout = await adminA.request('same-bag-fanout', [proposal('module-two', bagA, h0.hash), proposal('module-one', bagA, h0.hash)])
  assert.deepEqual(fanout.results.map((row: any) => row.status), ['applied', 'applied'])
  assert.deepEqual(authority(fanout), h1, 'same-bag copies do not inflate authority revision')
  const merged = hiddenBag(2, 'salary', 'private_file', 'billing_secret')
  const rebased = await adminB.request('explicit-rebase', [proposal('module-two', merged, h1.hash)])
  assert.equal(rebased.results[0]?.status, 'applied')
  const h2 = authority(rebased)
  assert.equal(h2.revision, h1.revision + 1)
  assert.deepEqual(h2.bag, merged, 'explicit rebase preserves both Admin restrictions')

  // The bridge must validate against earlier accepted proposals in the same
  // frame, not only against its pre-frame disk checkpoint.
  const bag3 = hiddenBag(3, 'salary', 'private_file', 'billing_secret', 'private_notes')
  const bag4 = hiddenBag(4, 'salary', 'private_file', 'billing_secret', 'private_notes', 'access_token')
  const queued3 = proposal('module-one', bag3, h2.hash)
  const queued4 = proposal('module-two', bag4, hash(bag3))
  const chain = await adminA.request('queued-causal-chain', [queued3, queued4])
  assert.deepEqual(chain.results.map((row: any) => row.status), ['applied', 'applied'], JSON.stringify(chain))
  const winner = authority(chain)
  assert.equal(winner.revision, h2.revision + 2)
  assert.deepEqual(winner.bag, bag4)
  const lastPeer = await until(() => adminB.delivered().find(row => row.opId === queued4.opId), 'queued winner fanout')
  assert.equal((lastPeer as any).fieldAclRevision, winner.revision)
  const firstPeer = adminB.delivered().find(row => row.opId === queued3.opId)!
  assert.equal((firstPeer as any).fieldAclRevision, winner.revision, 'wire projects earlier same-frame ACL to latest winner')
  assert.deepEqual((firstPeer.patch!.config as any).teamSpaceAclGrantBag, winner.bag)
  const wal = readFileSync(join(dir, 'ops.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(wal.find(row => row.opId === queued3.opId).fieldAclRevision, winner.revision - 1, 'WAL retains exact first causal revision')
  assert.equal(wal.find(row => row.opId === queued4.opId).fieldAclRevision, winner.revision, 'WAL retains exact second causal revision')
  assert.deepEqual(wal.find(row => row.opId === queued3.opId).patch.config.teamSpaceAclGrantBag, bag3, 'read projection never mutates durable authored payload')
  const observedRetryCount = adminB.delivered().filter(row => row.opId === authoredA.opId).length
  const exact = await adminA.request('exact-old-retry', [authoredA])
  assert.equal(exact.results[0]?.status, 'applied', 'durable exact retry bypasses stale proposal comparison')
  assert.deepEqual(authority(exact), winner, 'old retry cannot roll authority back')
  assert.equal(adminB.delivered().filter(row => row.opId === authoredA.opId).length, observedRetryCount, 'exact retry is not re-fanned out')

  const unauthorized = await member.request('member-unhide', [proposal('module-one', hiddenBag(5), winner.hash, { fieldAclRevision: winner.revision + 10 })])
  assert.equal(unauthorized.results[0]?.status, 'refused', JSON.stringify(unauthorized))
  assert.equal(unauthorized.results[0]?.permanent, true)
  assert.equal(Object.hasOwn(unauthorized, 'fieldAclAuthority'), false, 'non-Admin refusal cannot include the global winner bag')
  const stalePlaintext = 'STALE_OFFLINE_SECRET_MUST_NOT_RELAY'
  const staleContent = op('record.update', 'historical-record', { moduleId: 'module-one', entityId: 'entity',
    fieldAclBaseHash: h0.hash, patch: { data: { salary: stalePlaintext } } })
  const mixedStale = await adminB.request('stale-acl-and-plaintext', [proposal('module-one', bagB, h0.hash), staleContent])
  assert.deepEqual(mixedStale.results.map((row: any) => row.status), ['refused', 'refused'], 'stale privacy proposal and its plaintext follow-on are both refused')
  assert.ok(mixedStale.results.every((row: any) => row.permanent === true))
  assert.deepEqual(authority(mixedStale), winner)
  await member.request('member-observation-barrier', [])
  assert.equal(JSON.stringify(member.frames).includes(stalePlaintext), false, 'stale mixed frame cannot relay private bytes')
  assert.equal(readFileSync(join(dir, 'ops.jsonl'), 'utf8').includes(stalePlaintext), false, 'stale plaintext is never durably committed')
  salaryDoc.getText('content').delete(0, salaryDoc.getText('content').length)
  salaryDoc.getText('content').insert(0, 'LIVE_PRIVATE_VALUE')
  const freshContent = op('record.update', 'historical-record', { moduleId: 'module-one', entityId: 'entity',
    fieldAclBaseHash: winner.hash, patch: { data: { public_note: 'Fresh public edit', salary: 'LIVE_PRIVATE_VALUE' },
      cellHlcs: { salary: '100:0:admin-a' }, yjsCheckpoint: { fieldSlug: 'salary', kind: 'text', stateB64: encoded(salaryDoc) } } })
  const fresh = await adminA.request('fresh-content-current-hash', [freshContent])
  assert.equal(fresh.results[0]?.status, 'applied')
  assert.deepEqual(authority(fresh), winner)
  const freshPeer = await until(() => member.delivered().find(row => row.opId === freshContent.opId), 'public live sibling projection')
  assert.deepEqual(freshPeer.patch!.data, { public_note: 'Fresh public edit' })
  assert.equal(JSON.stringify(freshPeer).includes('LIVE_PRIVATE'), false, 'late Admin checkpoint/live private cell is scrubbed for Member')
  const hiddenWrite = await member.request('member-current-hidden-write', [op('record.update', 'historical-record', { moduleId: 'module-one', entityId: 'entity',
    fieldAclBaseHash: winner.hash, patch: { data: { public_note: 'must not partially ACK', salary: 'FORBIDDEN_MEMBER_WRITE' } } })])
  assert.equal(hiddenWrite.results[0]?.status, 'refused', 'knowing the latest hash does not authorize hidden-field writes')
  const memberCreates = await member.request('permitted-member-schema-and-row', [
    op('entity.create', 'member-table', { moduleId: 'module-one', entityId: 'member-table', fieldAclBaseHash: winner.hash, patch: { name: 'New table' } }),
    op('field.create', 'member-field', { moduleId: 'module-one', entityId: 'member-table', fieldAclBaseHash: winner.hash, patch: { name: 'New field', slug: 'member_cell', fieldType: 'text' } }),
    op('record.create', 'member-row', { moduleId: 'module-one', entityId: 'member-table', fieldAclBaseHash: winner.hash, patch: { data: { member_cell: 'new public record' } } }),
  ])
  assert.deepEqual(memberCreates.results.map((row: any) => row.status), ['applied', 'applied', 'applied'], 'same-frame new entity/field/record retains legitimate Member defaults')
  const readAfterRefusal = await adminA.request('authority-after-refusal', [op('module.update', 'module-one', { fieldAclBaseHash: winner.hash, patch: { name: 'Still private' } })])
  assert.deepEqual(authority(readAfterRefusal), winner, 'non-ACL Admin results also carry the current authority')
  await stop()
  await start()
  const restartedA = await connect('admin-a'), restartedB = await connect('admin-b'), restartedMember = await connect('member')
  assert.deepEqual(authority(restartedA.hello), winner, 'winner and both tightenings survive durable restart')
  assert.deepEqual(authority(restartedB.hello), winner)
  assert.equal(Object.hasOwn(restartedMember.hello, 'fieldAclAuthority'), false)
  const replayedAcl = restartedMember.delivered().filter(row => (row.patch?.config as any)?.teamSpaceAclGrantBag !== undefined)
  assert.ok(replayedAcl.length > 0, 'member fixture receives ordinary module ACL replay')
  for (const row of replayedAcl) {
    assert.deepEqual((row.patch!.config as any).teamSpaceAclGrantBag, winner.bag, 'all historical module ACL snapshots project latest restrictions')
    assert.equal((row as any).fieldAclRevision, winner.revision)
  }
  const restartedStale = await restartedB.request('stale-after-restart', [proposal('module-two', bagB, h0.hash)])
  assert.equal(restartedStale.results[0]?.status, 'refused')
  assert.deepEqual(authority(restartedStale), winner)
  const originalAgain = await restartedA.request('exact-after-restart', [authoredA])
  assert.equal(originalAgain.results[0]?.status, 'applied')
  assert.deepEqual(authority(originalAgain), winner)
  const records = restartedMember.delivered().filter(row => row.kind.startsWith('record.'))
  assert.equal(records.some(row => JSON.stringify(row).includes(historicalSecret)), false, 'current Hide removes historical raw record secret')
  assert.equal(records.some(row => JSON.stringify(row).includes(historicalCheckpoint)), false, 'hidden encoded checkpoint does not bypass field filtering')
  assert.equal(records.some(row => JSON.stringify(row).includes('private-checkpoint-save') || JSON.stringify(row).includes('private-reset')), false)
  assert.ok(records.some(row => (row.patch?.data as any)?.public_note === 'Public note'), 'historical public sibling remains available')
  assert.equal(records.some(row => Object.hasOwn(row.patch?.cellHlcs ?? {}, 'salary')), false, 'hidden cell-clock identity is removed')
  assert.equal((await blobGet('member')).status, 404, 'attachment privacy survives restart')
  assert.equal((await restartedMember.rawRequest({ type: 'yjs_join', frameId: 'restart-hidden-join', room: secretRoom })).type, 'yjs_refuse')
  // Simulate an older local database on the SAME registered device: durable
  // server acknowledgements already include newer content, including its own
  // writes. Restore replay must recover both, under today's private-field gate.
  restartedMember.socket.send(JSON.stringify({type:'ack_ops',frameId:'ack-before-local-restore',deviceId:'member',opIds:restartedMember.delivered().map(row=>row.opId)}))
  await restartedMember.request('ack-order-barrier',[])
  const restoredMember=await connect('member',true)
  assert.equal(restoredMember.hello.restoreReplay,true)
  assert.ok(restoredMember.delivered().some(row=>row.opId===freshContent.opId),'already acknowledged peer changes replay after local restore')
  assert.ok(restoredMember.delivered().some(row=>row.opId===memberFresh.results[0].opId),'already authored own changes replay after local restore')
  assert.equal(JSON.stringify(restoredMember.delivered()).includes('LIVE_PRIVATE_VALUE'),false)
  assert.equal(JSON.stringify(restoredMember.delivered()).includes(historicalSecret),false)
  assert.equal((await blobGet('member')).status,404)
  console.log('same-device restore replay: acknowledged peer and own changes recovered, current hidden values and attachments remain denied')
  console.log('team field ACL CAS live: two-Admin conflict, explicit merged rebase, same-bag fanout, queued chain, forged revision, exact retry, member refusal and durable restart passed')
} finally {
  await stop()
  rmSync(dir, { recursive: true, force: true })
  rmSync(dir+'.authority', { recursive: true, force: true })
}
