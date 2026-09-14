/** Real bridge child + real HTTP model-protocol fixture. This verifies transport,
 * not a model/provider's reasoning quality or integration. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashSessionToken } from '../src/store.js'
import { runWorkspaceAiReview } from '../src/workspace-ai-review-runner.js'
import WebSocket from 'ws'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'

const directory = mkdtempSync(join(tmpdir(), 'workspace-work-http-real-'))
let child: ReturnType<typeof spawn> | undefined
let adminSocket: WebSocket | undefined
const extraSockets: WebSocket[] = []
let modelMode: 'normal' | 'reflect-secret' | 'hold' | 'malformed' = 'normal'
let modelStarted: (() => void) | undefined
const modelServer = createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk
  const request = JSON.parse(raw)
  assert.equal(request.messages[0].role, 'system')
  assert.ok(request.messages[0].content.includes('untrusted'))
  assert.equal(request.response_format.type, 'json_schema')
  assert.equal(request.tools, undefined, 'reviewer has no execution tools')
  modelStarted?.()
  if (modelMode === 'hold') return
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ outcome: modelMode === 'malformed' ? 'approved' : 'approve', reasoning: modelMode === 'reflect-secret' ? String(req.headers.authorization).replace('Bearer ', '') : 'Transport fixture decision; no model reasoning was evaluated.' }) } }] }))
})
try {
  writeFileSync(join(directory, 'team.json'), JSON.stringify({ teamId: 'workspace_test_team', name: 'Work test', createdAt: 1 }))
  writeFileSync(join(directory, 'members.json'), JSON.stringify(['admin', 'worker', 'reviewer', 'outsider'].map(memberId => ({ memberId, email: `${memberId}@example.test`, displayName: memberId, role: memberId === 'worker' || memberId === 'reviewer' ? 'member' : 'admin', sessions: { [`${memberId}-device`]: hashSessionToken(`${memberId}-token`) }, createdAt: 1 }))))
  initializeCurrentAuthority(directory,directory+'.authority')
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: new URL('..', import.meta.url), env: { ...process.env, TEAMSPACE_DATA_DIR: directory, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port), TEAMSPACE_AT_REST_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolve, reject) => {
    let logs = ''; const timer = setTimeout(() => reject(new Error(`Bridge startup timeout: ${logs.slice(-1000)}`)), 15000)
    child!.stderr!.on('data', chunk => { logs += String(chunk) })
    child!.stdout!.on('data', chunk => { if (String(chunk).includes('bridge listening')) { clearTimeout(timer); resolve() } })
    child!.once('exit', code => { clearTimeout(timer); reject(new Error(`Bridge exited ${code}: ${logs.slice(-1000)}`)) })
  })
  const base = `http://127.0.0.1:${port}`
  async function request(path: string, actor: string | null = 'admin', body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(actor ? { authorization: `Bearer ${actor}-token` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    return { status: response.status, body: await response.json() as any }
  }
  assert.equal((await request('/workspace-work', null)).status, 401)
  assert.equal((await request('/workspace-work?token=admin-token', null)).status, 401, 'query bearer rejected')
  const invite = await request('/v1/invite/create', 'admin', { email: 'invited@example.test', role: 'member' })
  assert.equal(invite.status, 200)
  assert.equal((await fetch(base + '/workspace-work', { headers: { authorization: `Bearer ${invite.body.token}` } })).status, 401, 'pending invite is not an authenticated member session')
  const redeemed = await request('/v1/invite/redeem', null, { token: invite.body.token, deviceId: 'invited-device', memberEmail: 'invited@example.test', displayName: 'Invited member' })
  assert.equal(redeemed.status, 200)
  assert.equal((await fetch(base + '/workspace-work', { headers: { authorization: `Bearer ${redeemed.body.sessionToken}` } })).status, 200, 'accepted invite receives ordinary bridge directory access without invented paid-member gate')
  const directoryRead = await request('/workspace-work')
  assert.equal(directoryRead.body.data.kind, 'directory')
  assert.equal(directoryRead.body.data.members[0].sessions, undefined, 'no session secrets in directory')
  let revision = 0
  async function command(action: string, payload: unknown, actor = 'admin') {
    const result = await request('/workspace-work', actor, { workspaceId: 'ws', commandId: randomUUID(), expectedRevision: revision, action, payload })
    assert.equal(result.status, 200, JSON.stringify(result.body)); revision = result.body.data.revision; return result.body.data
  }
  await command('registerWorkspace', { name: 'Review workspace', memberIds: ['admin', 'worker', 'reviewer'], managerIds: ['admin'] })
  assert.equal((await request('/workspace-work?workspaceId=ws', 'outsider')).status, 403, 'admin has no implicit private workspace access')
  assert.equal((await fetch(base + '/workspace-work?workspaceId=ws', { headers: { authorization: `Bearer ${redeemed.body.sessionToken}` } })).status, 403, 'accepted team invite alone does not grant a workspace')
  const credential = await request('/workspace-work/ai-reviewers', 'admin', { workspaceId: 'ws', commandId: randomUUID(), expectedRevision: revision, agentId: 'local-reviewer', expiresAt: Date.now() + 60000 })
  assert.equal(credential.status, 200); revision = credential.body.data.revision
  await command('createTask', { id: 't', title: 'Review submitted evidence', description: 'Verify completion', assigneeId: 'worker', departmentId: null, dueAt: null, reviewPolicy: { mode: 'both', humanReviewerIds: ['reviewer'], aiReviewerIds: ['local-reviewer'], independent: true } })
  await command('claimTask', { taskId: 't' }, 'worker'); await command('startTask', { taskId: 't' }, 'worker'); await command('submitTask', { taskId: 't', evidence: 'Evidence-only protocol test' }, 'worker')
  const spoof = await request('/workspace-work', 'reviewer', { workspaceId: 'ws', commandId: randomUUID(), expectedRevision: revision, action: 'reviewTask', payload: { taskId: 't', reviewerKind: 'ai', submissionVersion: 1, outcome: 'approve', reasoning: 'spoof' } })
  assert.equal(spoof.status, 403)
  modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening')
  const modelPort = (modelServer.address() as { port: number }).port
  const result = await runWorkspaceAiReview({ bridgeUrl: base, credential: credential.body.data.token, workspaceId: 'ws', taskId: 't', modelEndpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions`, model: 'protocol-fixture-only' })
  revision = result.revision
  const pending = await request('/workspace-work?workspaceId=ws')
  assert.equal(pending.body.data.tasks[0].status, 'in_review', 'AI cannot bypass both-required human gate')
  await command('reviewTask', { taskId: 't', reviewerKind: 'human', submissionVersion: 1, outcome: 'approve', reasoning: 'Human gate protocol verification' }, 'reviewer')
  assert.equal((await request('/workspace-work?workspaceId=ws')).body.data.tasks[0].status, 'completed')
  const history = await request('/workspace-work?workspaceId=ws&taskId=t&history=decisions&limit=1')
  assert.equal(history.body.data.rows[0].reviewer.kind, 'ai'); assert.equal(history.body.data.page.hasMore, true)
  await command('createTask', { id: 'runner-safety', title: 'Pending runner test', description: 'No inference quality claim', assigneeId: 'worker', departmentId: null, dueAt: null, reviewPolicy: { mode: 'ai', humanReviewerIds: [], aiReviewerIds: ['local-reviewer'], independent: true } })
  await command('claimTask', { taskId: 'runner-safety' }, 'worker'); await command('startTask', { taskId: 'runner-safety' }, 'worker'); await command('submitTask', { taskId: 'runner-safety', evidence: 'Do not persist reflected secrets' }, 'worker')
  const runnerConfig = { bridgeUrl: base, credential: credential.body.data.token, workspaceId: 'ws', taskId: 'runner-safety', modelEndpoint: `http://127.0.0.1:${modelPort}/v1/chat/completions`, model: 'protocol-fixture-only' }
  modelMode = 'malformed'
  await assert.rejects(runWorkspaceAiReview(runnerConfig), /strict validation/)
  modelMode = 'reflect-secret'
  await assert.rejects(runWorkspaceAiReview({ ...runnerConfig, modelApiKey: 'private-model-key-test-only' }), /protected configuration/)
  const controller = new AbortController()
  modelMode = 'hold'
  const started = new Promise<void>(resolve => { modelStarted = resolve })
  const cancelledRun = runWorkspaceAiReview({ ...runnerConfig, signal: controller.signal })
  await started; controller.abort(new Error('Caller cancelled review'))
  await assert.rejects(cancelledRun, /Caller cancelled/)
  modelStarted = undefined; modelMode = 'normal'
  const unchanged = await request('/workspace-work?workspaceId=ws&taskId=runner-safety')
  assert.equal(unchanged.body.data.revision, revision, 'invalid/secret/cancelled model output never commits a review')
  assert.deepEqual(unchanged.body.data.tasks[0].decisions, [])
  adminSocket = new WebSocket(`ws://127.0.0.1:${port}/`); await once(adminSocket, 'open')
  async function frame(value: Record<string, unknown>, expected: string, target = adminSocket!) {
    const frameId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { target.off('message', listener); reject(new Error(`Missing ${expected}`)) }, 5000)
      const listener = (raw: WebSocket.RawData) => { const received = JSON.parse(String(raw)); if (received.frameId !== frameId && !(['hello_ok', 'pong'].includes(expected) && received.type === expected)) return; clearTimeout(timer); target.off('message', listener); if (received.type === expected) resolve(); else reject(new Error(`Unexpected ${received.type}`)) }
      target.on('message', listener); target.send(JSON.stringify({ ...value, frameId }))
    })
  }
  await frame({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, memberId: 'admin', deviceId: 'admin-device', sessionToken: 'admin-token' }, 'hello_ok')
  const pushes: Record<string, any[]> = { admin: [], worker: [], outsider: [] }
  adminSocket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'workspace_work_changed') pushes.admin.push(message) })
  for (const memberId of ['worker', 'outsider']) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`); extraSockets.push(socket); await once(socket, 'open')
    socket.on('message', raw => { const message = JSON.parse(String(raw)); if (message.type === 'workspace_work_changed') pushes[memberId].push(message) })
    await frame({ type: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, memberId, deviceId: `${memberId}-device`, sessionToken: `${memberId}-token` }, 'hello_ok', socket)
  }
  await command('setWorkspaceMembers', { memberIds: ['admin', 'reviewer'], managerIds: ['admin'] })
  // A same-socket ping response is an ordering barrier after the earlier commit broadcast.
  for (const socket of [adminSocket, ...extraSockets]) await frame({ type: 'ping', ts: Date.now() }, 'pong', socket)
  assert.deepEqual(pushes.admin, [{ type: 'workspace_work_changed', workspaceId: 'ws' }])
  assert.deepEqual(pushes.worker, [{ type: 'workspace_work_changed', workspaceId: 'ws' }], 'removed audience receives metadata-only invalidation')
  assert.deepEqual(pushes.outsider, [], 'unrelated administrator receives no private workspace metadata')
  assert.equal((await request('/workspace-work?workspaceId=ws', 'worker')).status, 403)
  await command('setWorkspaceMembers', { memberIds: ['admin', 'worker', 'reviewer'], managerIds: ['admin'] })
  await frame({ type: 'set_role', memberId: 'worker', role: 'viewer' }, 'set_role_ok')
  assert.equal((await request('/workspace-work?workspaceId=ws', 'worker')).body.data.actor.canWrite, false)
  assert.equal((await request('/workspace-work', 'worker', { workspaceId: 'ws', commandId: randomUUID(), expectedRevision: revision, action: 'updateProfile', payload: {} })).status, 403, 'role downgrade immediately removes mutation authority')
  await frame({ type: 'kick_member', memberId: 'worker' }, 'kick_ok')
  assert.equal((await request('/workspace-work?workspaceId=ws', 'worker')).status, 401, 'kicked member cannot use retained workspace assignment')
  console.log('PASS real bridge HTTP auth/scope, no query tokens, task lifecycle, scoped AI credential, one-shot runner protocol, independent human gate and history')
} finally {
  adminSocket?.terminate()
  extraSockets.forEach(socket => socket.terminate())
  modelServer.closeAllConnections(); await new Promise<void>(resolve => modelServer.close(() => resolve()))
  if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited }
  rmSync(directory, { recursive: true, force: true })
  rmSync(directory+'.authority', { recursive: true, force: true })
}
