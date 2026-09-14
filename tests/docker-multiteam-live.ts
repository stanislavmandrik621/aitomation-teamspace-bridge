/** Actual Docker wire audit. Start the audit compose.yml first; all data is synthetic.
 * No filesystem seeding: bootstrap, invitations and content go through public protocols.
 * Each run uses fresh members in the already isolated teams. Credentials stay in memory.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID, createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'

type Frame = Record<string, any>
const output = resolve(process.env.DOCKER_AUDIT_OUTPUT ?? '../../docs/docker-collaboration-audit-2026-09-09')
const compose = resolve('../../docs/docker-collaboration-audit-2026-09-09/compose.yml')
const run = randomUUID().slice(0, 8)
const report: Frame = { startedAt: new Date().toISOString(), run, boundary: 'Production Docker image; real HTTP/WS; three independent volumes/teams; synthetic clients, not Electron UI', cases: [], metrics: {} }
mkdirSync(output, { recursive: true })
const persist = () => writeFileSync(resolve(output, 'docker-results.json'), JSON.stringify(report, null, 2))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function until(fn: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (!fn()) { assert.ok(Date.now() < deadline, `Timeout: ${label}`); await sleep(10) }
}
async function check(id: string, work: () => Promise<void>) {
  const row: Frame = { id, status: 'running', startedAt: new Date().toISOString() }; report.cases.push(row); persist()
  const start = performance.now()
  try { await work(); row.status = 'passed' }
  catch (error) { row.status = 'failed'; row.error = String(error instanceof Error ? error.stack : error); console.error(id, row.error) }
  row.elapsedMs = Math.round(performance.now() - start); persist(); console.log(`${row.status}: ${id}`)
}
let serial = 0
const sockets: WebSocket[] = []
class Client {
  ws: WebSocket
  frames: Frame[] = []
  ops = new Map<string, Frame>()
  chats = new Map<string, Frame>()
  credential: Frame = {}
  hello: Frame = {}
  constructor(readonly port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(this.ws)
    this.ws.on('error', () => {})
    this.ws.on('message', bytes => {
      const f = JSON.parse(String(bytes)); this.frames.push(f)
      if (f.type === 'ops') for (const op of f.ops) this.ops.set(op.opId, op)
      if (f.type === 'chat_peer') this.chats.set(f.message.id, f.message)
    })
  }
  async wait(fn: (f: Frame) => boolean, label: string) {
    await until(() => this.frames.some(fn), label)
    return this.frames.splice(this.frames.findIndex(fn), 1)[0]
  }
  async request(frame: Frame) {
    const frameId = `audit-${run}-${++serial}`
    this.ws.send(JSON.stringify({ ...frame, frameId }))
    return this.wait(f => f.frameId === frameId || f.requestId === frameId, `${frame.type} on ${this.port}`)
  }
  async auth(credential: Frame) {
    this.credential = credential
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open')
    this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, ...credential }))
    this.hello = await this.wait(f => ['hello_ok', 'hello_refuse'].includes(f.type), 'hello')
    assert.equal(this.hello.type, 'hello_ok', JSON.stringify(this.hello))
    if (this.hello.sessionToken) this.credential.sessionToken = this.hello.sessionToken
    await this.wait(f => f.type === 'catchup_status' && f.done, 'initial catchup')
    return this
  }
  async expect(frame: Frame, type: string) { const reply = await this.request(frame); assert.equal(reply.type, type, JSON.stringify(reply)); return reply }
}
type Team = { name: string; port: number; id: string; admin: Client; members: Client[]; viewer: Client; module: string; entity: string; record: string; seed: string[] }
const teams: Team[] = []
const op = (team: Team, kind: string, targetId: string, extra: Frame = {}) => ({ opId: `${run}-${++serial}`, kind, targetKind: kind.split('.')[0], targetId,
  moduleId: team.module, ...(kind.startsWith('module.') ? {} : { entityId: team.entity }),
  hlc: `${Date.now()}:${serial}:audit`, originDevice: 'FORGED-DEVICE', originMemberId: 'FORGED-MEMBER', originRole: 'admin', teamId: 'FORGED-TEAM',
  hopCount: 0, protocolVersion: 2, ...extra })
async function sendOps(client: Client, operations: Frame[], expected = 'applied') {
  const reply = await client.expect({ type: 'ops', ops: operations }, 'ops_result')
  assert.equal(reply.results.length, operations.length)
  assert.ok(reply.results.every((r: Frame) => r.status === expected), JSON.stringify(reply.results)); return reply
}
async function invite(admin: Client, role: string, index: number) {
  const email = `${run}-${admin.port}-${index}@example.test`
  const invitation = await admin.expect({ type: 'invite_create', email, role }, 'invite_ok')
  const member = new Client(admin.port); await once(member.ws, 'open')
  const credential = await member.expect({ type: 'invite_redeem', token: invitation.token, deviceId: `device-${index}`, memberEmail: email, displayName: `Audit ${index}` }, 'invite_redeem_ok')
  return member.auth({ memberId: credential.memberId, deviceId: `device-${index}`, sessionToken: credential.sessionToken })
}
async function http(team: Team, path: string, body?: Frame, token?: string) {
  const response = await fetch(`http://127.0.0.1:${team.port}${path}`, { method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(15_000),
    headers: { Accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await response.text(); let data: any; try { data = JSON.parse(text) } catch { data = text }
  return { status: response.status, data, text }
}

try {
  // A rerun requires fresh audit volumes. Never replace or clear an existing team's members.
  for (const [i, name] of ['alpha', 'beta', 'gamma'].entries()) {
    const port = 18881 + i
    await check(`${name}/bootstrap-and-eight-invites`, async () => {
      const admin = await new Client(port).auth({ memberId: `admin-${run}`, deviceId: 'admin-device', memberEmail: `${run}-${name}@example.test`, displayName: `Audit ${name} Admin` })
      const members: Client[] = []
      for (let j = 0; j < 7; j++) members.push(await invite(admin, 'member', j))
      const viewer = await invite(admin, 'viewer', 7)
      const team: Team = { name, port, id: admin.hello.teamId, admin, members, viewer, module: `module-${run}`, entity: `entity-${run}`, record: `record-${run}`, seed: [] }
      teams.push(team)
      assert.equal(admin.hello.role, 'admin'); assert.equal(viewer.hello.role, 'viewer')
      assert.equal((await admin.expect({ type: 'list_members', limit: 100 }, 'list_members_ok')).total, 9)
      const seed = [op(team, 'module.create', team.module, { patch: { id: team.module, name: `${name} audit project` } }),
        op(team, 'entity.create', team.entity, { patch: { id: team.entity, module_id: team.module, name: 'Concurrent tasks' } }),
        op(team, 'record.create', team.record, { patch: { id: team.record, entity_id: team.entity, data: { title: `${name} shared task` } } }),
        op(team, 'view.create', 'audit-board', { patch: { id: 'audit-board', entity_id: team.entity, name: 'Test board', view_type: 'kanban', config: {} } })]
      await sendOps(admin, seed); team.seed = seed.map(o => o.opId)
      await until(() => [...members, viewer].every(c => seed.every(o => c.ops.has(o.opId))), 'shared project/schema/record/view receipt')
    })
  }
  assert.equal(teams.length, 3, 'all three teams must bootstrap before interaction tests')
  await check('cross-team/credentials-and-op-isolation', async () => {
    assert.equal(new Set(teams.map(t => t.id)).size, 3)
    for (const [i, team] of teams.entries()) {
      const other = teams[(i + 1) % teams.length]
      const bad = new Client(other.port); await once(bad.ws, 'open')
      bad.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, ...team.admin.credential }))
      assert.equal((await bad.wait(f => ['hello_ok', 'hello_refuse'].includes(f.type), 'cross-team refusal')).type, 'hello_refuse'); bad.ws.terminate()
      assert.ok(team.members.every(c => [...c.ops.values()].every(o => o.teamId === team.id && o.team_id === team.id)))
      assert.ok(team.members.every(c => !other.seed.some(id => c.ops.has(id))))
    }
  })
  await Promise.all(teams.map(team => check(`${team.name}/large-concurrent-edits-and-chat`, async () => {
    const clients = [team.admin, ...team.members]
    const expected = new Map<string, number>(), latencies: number[] = []
    const started = performance.now(); let bytes = 0
    await Promise.all(clients.map(async (client, author) => {
      for (let batch = 0; batch < 4; batch++) {
        const operations = Array.from({ length: 25 }, (_, n) => op(team, 'record.update', team.record, { patch: { data: { [`author_${author}`]: `${batch}:${n}:${'x'.repeat(8192)}` } } }))
        for (const operation of operations) expected.set(operation.opId, author)
        bytes += Buffer.byteLength(JSON.stringify(operations)); const start = performance.now()
        await Promise.all([sendOps(client, operations), client.expect({ type: 'chat_send', room: 'chat:team', clientMsgId: `${run}-load-${author}-${batch}`, body: `${team.name} ${author}/${batch}` }, 'chat_ok')])
        latencies.push(performance.now() - start)
      }
    }))
    await until(() => clients.every((c, i) => [...expected].every(([id, author]) => author === i || c.ops.has(id))) && [...expected.keys()].every(id => team.viewer.ops.has(id)), 'every permitted edit received')
    await until(() => clients.every(c => c.chats.size >= 28) && team.viewer.chats.size >= 32, 'concurrent team chat fanout')
    for (const c of clients) for (const [id, author] of expected) if (c.ops.has(id)) {
      const received = c.ops.get(id)!
      assert.equal(received.originMemberId, clients[author].credential.memberId); assert.equal(received.originDevice, clients[author].credential.deviceId)
      assert.equal(received.teamId, team.id); assert.equal(received.patch.data[`author_${author}`].length >= 8192, true)
    }
    latencies.sort((a, b) => a - b)
    report.metrics[team.name] = { clients: 9, simultaneousWriters: 8, edits: expected.size, submittedBytes: bytes, chatMessages: 32,
      elapsedMs: Math.round(performance.now() - started), batchAckP95Ms: Math.round(latencies[Math.floor(latencies.length * .95)]), verifiedEditPeerDeliveries: expected.size * 8 }
    const retry = op(team, 'record.update', team.record, { patch: { data: { retry: 'original' } } })
    await sendOps(team.admin, [retry]); const again = await team.admin.expect({ type: 'ops', ops: [retry] }, 'ops_result')
    assert.equal(again.results[0].status, 'applied', JSON.stringify(again))
    const changedRetry = await team.admin.expect({ type: 'ops', ops: [{ ...retry, patch: { data: { retry: 'tampered' } } }] }, 'ops_result')
    assert.equal(changedRetry.results[0].status, 'refused', 'same op ID cannot replace committed content')
    const denied = await team.viewer.request({ type: 'ops', ops: [op(team, 'record.update', team.record, { patch: { data: { illegal: true } } })] })
    assert.equal(denied.type, 'error')
  })))
  for (const team of teams) {
    await check(`${team.name}/room-types-and-message-lifecycle`, async () => {
      const [bob, carol] = team.members
      const rooms: string[] = ['chat:team']
      for (const kind of ['group', 'private', 'dm']) {
        const result = await team.admin.expect({ type: 'chat_room_create', kind, title: `${kind} audit`, memberIds: [bob.credential.memberId, carol.credential.memberId], targetMemberId: bob.credential.memberId, ...(kind === 'private' ? { password: 'local-audit-password' } : {}) }, 'chat_room_create_ok')
        rooms.push(result.room.id)
      }
      for (const room of rooms) {
        const sent = await bob.expect({ type: 'chat_send', room, body: `Original ${room}`, clientMsgId: `${run}-lifecycle-${room}` }, 'chat_ok')
        const id = sent.message.id
        const edits = await Promise.all(Array.from({ length: 5 }, (_, i) => bob.expect({ type: 'chat_edit', room, messageId: id, body: `Revision ${i}` }, 'chat_edit_ok')))
        assert.ok(edits[4].message.editedAt > edits[0].message.editedAt)
        await team.admin.expect({ type: 'chat_react', room, messageId: id, emoji: '👍' }, 'chat_react_ok')
        await bob.expect({ type: 'chat_react', room, messageId: id, emoji: '👍' }, 'chat_react_ok')
        const removed = await bob.expect({ type: 'chat_react', room, messageId: id, emoji: '👍', remove: true }, 'chat_react_ok')
        assert.deepEqual(removed.message.reactions['👍'], [team.admin.credential.memberId])
        await team.admin.expect({ type: 'chat_pin', room, messageId: id, pinned: true }, 'chat_pin_ok')
        const history = await bob.expect({ type: 'chat_history', room, limit: 100 }, 'chat_history_ok')
        assert.equal(history.messages.find((m: Frame) => m.id === id).body, 'Revision 4')
        await bob.expect({ type: 'chat_unread_set', room, lastReadMsgId: id, lastReadAt: sent.message.createdAt }, 'chat_unread_set_ok')
        await bob.expect({ type: 'chat_export', room, format: 'json' }, 'chat_refuse')
        await team.admin.expect({ type: 'chat_export', room, format: 'json' }, 'chat_export_ok')
        await bob.expect({ type: 'chat_unsend', room, messageId: id }, 'chat_unsend_ok')
        const after = await bob.expect({ type: 'chat_history', room, limit: 100 }, 'chat_history_ok')
        const tomb = after.messages.find((m: Frame) => m.id === id); assert.ok(!tomb || (tomb.deletedAt && !tomb.body))
        if (room !== 'chat:team') assert.equal((await team.viewer.request({ type: 'chat_history', room, limit: 100 })).type, 'chat_refuse')
      }
      assert.equal((await team.viewer.request({ type: 'chat_send', room: 'chat:team', body: 'forbidden', clientMsgId: `${run}-viewer` })).type, 'chat_refuse')
      const room = rooms[1]
      await team.admin.expect({ type: 'chat_room_remove_members', room, memberIds: [carol.credential.memberId] }, 'chat_room_remove_members_ok')
      assert.equal((await carol.request({ type: 'chat_send', room, body: 'removed', clientMsgId: `${run}-removed` })).type, 'chat_refuse')
    })
    await check(`${team.name}/scoped-ops-presence-and-live-demotion`, async () => {
      const [bob, excluded] = team.members
      const scoped = op(team, 'record.update', team.record, { patch: { data: { scoped: team.name } }, visibleToMemberIds: [bob.credential.memberId] })
      await sendOps(team.admin, [scoped]); await until(() => bob.ops.has(scoped.opId), 'scoped op')
      await sleep(200); assert.ok(!excluded.ops.has(scoped.opId)); assert.ok(!team.viewer.ops.has(scoped.opId))
      const target = { leaseId: `${run}-lease`, entityId: team.entity, viewId: 'audit-board', recordId: team.record, value: 'PRIVATE_VALUE' }
      await bob.expect({ type: 'presence_edit', target, active: true }, 'presence_snapshot')
      const present = await team.admin.expect({ type: 'presence_get' }, 'presence_snapshot')
      const edit = present.peers.find((p: Frame) => p.memberId === bob.credential.memberId).editing[0]
      assert.equal(edit.recordId, team.record); assert.equal(edit.value, undefined)
      await team.admin.expect({ type: 'set_role', memberId: bob.credential.memberId, role: 'viewer' }, 'set_role_ok')
      assert.equal((await bob.request({ type: 'presence_edit', target, active: true })).type, 'error')
      assert.equal((await bob.request({ type: 'ops', ops: [op(team, 'record.update', team.record)] })).type, 'error')
      await team.admin.expect({ type: 'set_role', memberId: bob.credential.memberId, role: 'member' }, 'set_role_ok')
    })
    await check(`${team.name}/compose-yjs-share-revoke`, async () => {
      const bob = team.members[0], room = `yjs:composeDoc:board-${run}`
      assert.equal((await bob.request({ type: 'yjs_join', room })).type, 'yjs_refuse')
      assert.equal((await http(team, '/v1/teamspace/compose-acl', { teamId: team.id, documentIds: [`board-${run}`] }, team.admin.credential.sessionToken)).status, 200)
      for (const c of [team.admin, bob, team.viewer]) await c.expect({ type: 'yjs_join', room }, 'yjs_ok')
      await bob.expect({ type: 'yjs_update', room, updateB64: 'AQ==' }, 'yjs_ok')
      const peer = await team.admin.wait(f => f.type === 'yjs_peer_update' && f.room === room, 'Yjs peer'); assert.equal(peer.fromMemberId, bob.credential.memberId)
      await team.viewer.expect({ type: 'yjs_update', room, updateB64: 'AQ==' }, 'yjs_refuse')
      await team.viewer.expect({ type: 'yjs_awareness', room, updateB64: 'AQ==' }, 'yjs_ok')
      assert.equal((await http(team, '/v1/teamspace/compose-acl', { teamId: team.id, mutation: { documentId: `board-${run}`, remove: true } }, team.admin.credential.sessionToken)).status, 200)
      await bob.expect({ type: 'yjs_update', room, updateB64: 'AQ==' }, 'yjs_refuse')
    })
    await check(`${team.name}/public-share-portal-and-cross-team-http`, async () => {
      const token = `audit-public-${run}-${team.name}`, hash = createHash('sha256').update(token).digest('hex')
      const fields = [{ slug: 'title', name: 'Title', field_type: 'text', config: {} }]
      const content = { version: 2, mode: 'read', viewType: 'table', label: 'Audit public', entityId: team.entity, fields,
        rows: [{ id: team.record, data: { title: `PUBLIC-${team.name}` } }], total: 1, truncated: false, includeCsv: true, pushedAt: Date.now() }
      const body = { teamId: team.id, fieldAclBaseHash: team.admin.hello.fieldAclAuthority.hash, token_hash: hash, local_share_id: `share-${run}`, mode: 'read', view_type: 'table', include_csv: true, payload: content }
      assert.equal((await http(team, '/v1/public-share/register', body, team.admin.credential.sessionToken)).status, 200)
      const guest = await http(team, `/share/${token}`); assert.equal(guest.status, 200); assert.ok(guest.text.includes(`PUBLIC-${team.name}`))
      const other = teams.find(t => t !== team)!
      assert.equal((await http(other, `/share/${token}`)).status, 404)
      assert.equal((await http(team, '/v1/public-share/register', { ...body, teamId: other.id }, team.admin.credential.sessionToken)).status, 403)
      const portal = `audit-portal-${run}-${team.name}`
      const portalBody = { teamId: team.id, fieldAclBaseHash: team.admin.hello.fieldAclAuthority.hash,
        token_hash: createHash('sha256').update(portal).digest('hex'), local_portal_id: `portal-${run}`, name: 'Audit intake', auth_mode: 'anonymous', allowed_actions: ['create'],
        payload: { version: 1, portalId: `portal-${run}`, name: 'Audit intake', entityId: team.entity, authMode: 'anonymous', allowedActions: ['create'], design: {}, aclSnapshot: { hiddenSlugs: [] }, fields, pushedAt: Date.now() } }
      assert.equal((await http(team, '/v1/portal/register', portalBody, team.admin.credential.sessionToken)).status, 200)
      assert.equal((await http(team, `/portal/${portal}`)).status, 200)
      const intake = await http(team, `/portal/${portal}`, { action: 'create', data: { title: 'Guest-created task' } }); assert.ok(intake.status >= 200 && intake.status < 300, intake.text)
      assert.equal((await http(team, '/v1/public-share/revoke', { teamId: team.id, token_hash: hash }, team.admin.credential.sessionToken)).status, 200)
      assert.equal((await http(team, `/share/${token}`)).status, 410)
    })
  }
  await check('three-teams/abrupt-restart-and-durable-replay', async () => {
    const saved: Array<{ team: Team; message: Frame; op: Frame }> = []
    for (const team of teams) {
      const operation = op(team, 'record.update', team.record, { patch: { data: { durable: run } } }); await sendOps(team.members[0], [operation])
      const message = await team.admin.expect({ type: 'chat_send', room: 'chat:team', clientMsgId: `${run}-durable`, body: 'Survives SIGKILL' }, 'chat_ok')
      saved.push({ team, message: message.message, op: operation })
    }
    execFileSync('docker', ['compose', '-f', compose, 'kill', '-s', 'SIGKILL'], { stdio: 'pipe' })
    execFileSync('docker', ['compose', '-f', compose, 'up', '-d', '--wait'], { stdio: 'pipe', timeout: 60_000 })
    for (const { team, message, op: operation } of saved) {
      const admin = await new Client(team.port).auth(team.admin.credential)
      assert.ok(admin.ops.has(operation.opId), 'durable remote edit replays after hard stop')
      assert.ok([...admin.ops.values()].every(o => o.teamId === team.id), 'replay remains team isolated')
      const history = await admin.expect({ type: 'chat_history', room: 'chat:team', limit: 100 }, 'chat_history_ok')
      assert.equal(history.messages.find((m: Frame) => m.id === message.id).body, 'Survives SIGKILL')
      const retry = await admin.expect({ type: 'chat_send', room: 'chat:team', clientMsgId: `${run}-durable`, body: 'MUST NOT REPLACE' }, 'chat_ok')
      assert.equal(retry.message.id, message.id); assert.equal(retry.message.body, message.body)
    }
  })
} catch (error) { report.fatal = String(error instanceof Error ? error.stack : error) }
finally {
  for (const ws of sockets) ws.terminate()
  report.finishedAt = new Date().toISOString(); report.status = report.fatal || report.cases.some((c: Frame) => c.status !== 'passed') ? 'failed' : 'passed'
  persist(); console.log(JSON.stringify({ status: report.status, cases: report.cases.length, metrics: report.metrics, fatal: report.fatal }, null, 2))
  if (report.status !== 'passed') process.exitCode = 1
}
