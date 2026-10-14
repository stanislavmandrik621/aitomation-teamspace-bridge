/** Production mail HTTP handler + service + encrypted roster over real loopback
 * HTTP. No provider registration, credentials, network or responses are mocked. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
import { MailOAuthService } from '../src/mail-oauth-service.js'
import { createMailHttpHandler } from '../src/mail-http.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-retention-http-'))), key = { key: randomBytes(32) }, teamId = randomUUID()
const roster = new BridgeStore(directory, 21, key)
const admin = roster.helloOrBootstrap({ memberId: randomUUID(), deviceId: randomUUID(), displayName: 'Retention HTTP verification' })
assert.ok(admin.ok)
const invitation = roster.createInvite(admin.member.memberId, 'member@controlled.invalid', 'member')
assert.ok(invitation.ok)
const member = await roster.redeemInvite({ token: invitation.invite.token, deviceId: randomUUID(), displayName: 'Retention policy owner', memberEmail: 'member@controlled.invalid' })
assert.ok(member.ok)
const viewerInvitation = roster.createInvite(admin.member.memberId, 'viewer@controlled.invalid', 'viewer')
assert.ok(viewerInvitation.ok)
const viewer = await roster.redeemInvite({ token: viewerInvitation.invite.token, deviceId: randomUUID(), displayName: 'Read-only session', memberEmail: 'viewer@controlled.invalid' })
assert.ok(viewer.ok)
const service = new MailOAuthService({ dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' })
await service.ready()
service.startWorkers(identity => identity.teamId === teamId && !!roster.findMember(identity.memberId)?.sessions[identity.deviceId]
  && roster.findMember(identity.memberId)?.role !== 'viewer')
const handler = createMailHttpHandler({
  service, authenticate: req => roster.findBySession(/^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? ''), teamId: () => teamId,
  identityExists: identity => !!roster.findMember(identity.memberId)?.sessions[identity.deviceId],
  readBody: async (req, max) => {
    let bytes = 0; const chunks: Buffer[] = []
    for await (const chunk of req) { const part = Buffer.from(chunk); bytes += part.length; if (bytes > max) throw new Error('Request too large'); chunks.push(part) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  },
  releaseBody: () => undefined,
  json: (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) },
  drain: req => { req.resume() },
})
const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, 'http://127.0.0.1')).then(handled => {
  if (!handled) { res.statusCode = 404; res.end() }
}).catch(() => { res.statusCode = 500; res.end() }) })
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const post = (action: string, token = member.sessionToken, value: Record<string, unknown> = {}) => fetch(`${base}/v1/mail/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ projectId: 'project-a', ...value }),
  })
  for (const action of ['retention-get', 'retention-save', 'warmup-history']) {
    assert.equal((await post(action, '')).status, 403)
    assert.equal((await post(action, viewer.sessionToken)).status, 403)
  }
  const initial = await post('retention-get')
  assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store')
  assert.deepEqual(await initial.json(), { ok: true, policy: { retentionDays: 0, approvedAt: null, revision: 0 } })
  const refused = await post('retention-save', member.sessionToken, { retentionDays: 30, approveDeletion: false, expectedRevision: 0 })
  assert.equal(refused.status, 409); assert.equal((await refused.json()).error_code, 'mail_retention')
  const approved = await post('retention-save', member.sessionToken, { retentionDays: 30, approveDeletion: true, expectedRevision: 0 })
  assert.equal(approved.status, 200)
  const saved = (await approved.json()).policy
  assert.equal(saved.retentionDays, 30); assert.equal(saved.revision, 1); assert.ok(saved.approvedAt > 0)
  const other = await post('retention-get', member.sessionToken, { projectId: 'project-b' })
  assert.deepEqual((await other.json()).policy, { retentionDays: 0, approvedAt: null, revision: 0 })
  assert.equal((await post('retention-save', member.sessionToken, { retentionDays: 0, approveDeletion: false, expectedRevision: 0 })).status, 409)
  const forever = await post('retention-save', member.sessionToken, { retentionDays: 0, approveDeletion: false, expectedRevision: 1 })
  assert.equal(forever.status, 200)
  assert.deepEqual((await forever.json()).policy, { retentionDays: 0, approvedAt: null, revision: 2 })
  assert.equal((await post('retention-save', member.sessionToken, { retentionDays: 7, approveDeletion: true, expectedRevision: 2, forged: true })).status, 409)
  const history = await post('warmup-history', member.sessionToken, { limit: 100 })
  assert.equal(history.status, 200); assert.deepEqual(await history.json(), { ok: true, jobs: [], hasMore: false })
  assert.equal((await post('warmup-history', member.sessionToken, { limit: 101 })).status, 400)
  assert.equal((await post('warmup-history', member.sessionToken, { after: Buffer.from('foreign-scope:1234567890000000:job').toString('base64url') })).status, 409)
  assert.equal((await post('retention-get', member.sessionToken, { projectId: '../wrong' })).status, 400)
  assert.ok(roster.revokeSession({ actorMemberId: admin.member.memberId, targetMemberId: member.member.memberId, deviceId: Object.keys(member.member.sessions)[0]! }).ok)
  for (const action of ['retention-get', 'retention-save', 'warmup-history']) assert.equal((await post(action)).status, 403)
  console.log('PASS: real loopback retention/history routes, encrypted roster sessions, viewer/revoked refusal, keep-forever default, explicit approval/revision conflict, owner/project isolation and bounded history; no provider traffic')
} finally {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await service.close()
  rmSync(directory, { recursive: true, force: true })
}
