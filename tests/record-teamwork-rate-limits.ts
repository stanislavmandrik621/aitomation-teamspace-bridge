import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { TokenBucketLimiter } from '../src/rate-limit.js'
import { createMemberHttpWriteBudget, ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS } from '../src/throughput.js'
import { createRecordTeamworkHttpHandler } from '../src/record-teamwork-http.js'
import { createTeamMemberProfileHttpHandler } from '../src/team-member-profile-http.js'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import type { ModulesSyncOp } from '../src/index.js'

function fixture(budget = createMemberHttpWriteBudget(3, 10000)) {
  const root = mkdtempSync(join(tmpdir(), 'teamwork-rate-'))
  writeFileSync(join(root, 'members.json'), JSON.stringify(['alice', 'bob'].map(id => ({ memberId: id, email: `${id}@test.invalid`, displayName: id, role: id === 'alice' ? 'admin' : 'member', createdAt: Date.now(), sessions: { [id]: hashSessionToken(id) }, sessionLastSeen: { [id]: Date.now() } }))))
  const store = new BridgeStore(root, 21, null, null)
  let serial = 0, bodyReads = 0, releases = 0
  const op = (kind: string, targetId: string, patch: Record<string, unknown> = {}, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({ kind, targetId, targetKind: kind.split('.')[0], opId: `seed-${++serial}`, originMemberId: 'alice', originRole: 'admin', originDevice: 'alice', hlc: `${Date.now()}:0:alice`, protocolVersion: 2, hopCount: 0, patch, ...extra })
  store.appendOps([op('module.create', 'module'), op('entity.create', 'entity', { moduleId: 'module' }, { moduleId: 'module' }), op('record.create', 'record', { data: { name: 'Own test record' } }, { entityId: 'entity' })])
  let reply: { status: number; body: any; headers: Map<string, string> }
  const handler = createRecordTeamworkHttpHandler({
    store, teamId: () => 'team', authenticate: req => ({ member: store.findMember((req as any).actor)!, deviceId: (req as any).actor }),
    departmentExists: () => false, readBody: async req => { bodyReads++; return (req as any).body }, releaseBody: () => { releases++ }, drain: () => {},
    json: (_res, status, body) => { reply.status = status; reply.body = body }, takeWrite: budget.take, retryAfterSeconds: budget.retryAfterSeconds,
    publish: () => {}, fieldRefusal: () => null, canRead: () => true, assertWritable: () => {},
  })
  return {
    store, budget,
    counts: () => ({ bodyReads, releases }),
    async write(actor: string, action = 'request_help') {
      reply = { status: 0, body: null, headers: new Map() }
      const command = action === 'configure' ? { action, config: { completedStatusValues: [], reviewRequired: false, reviewerMemberIds: [] } } : { action, note: `Note ${++serial}` }
      await handler({ method: 'POST', actor, body: { teamId: 'team', moduleId: 'module', entityId: 'entity', recordId: 'record', commandId: `test-${++serial}`, expectedRevision: store.recordTeamwork.read('record').revision, command } } as any, { setHeader: (key: string, value: string) => reply.headers.set(key, value) } as any, new URL('http://local/api/record-teamwork'))
      return reply
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test('exhausted Admin operations do not reject the first normal teamwork save; two native actor keys are independent', async () => {
  const admin = new TokenBucketLimiter(), f = fixture()
  try {
    for (let i = 0; i < ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW; i++) assert.equal(admin.take('adminhttp:alice', ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS), true)
    assert.equal(admin.take('adminhttp:alice', ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS), false)
    assert.equal((await f.write('alice', 'configure')).status, 200)
    assert.equal((await f.write('alice')).status, 200)
    assert.equal((await f.write('alice')).status, 200)
    const before = f.counts().bodyReads, denied = await f.write('alice')
    assert.equal(denied.status, 429); assert.match(denied.body.error, /Too many teamwork changes/)
    assert.equal(f.counts().bodyReads, before, 'rate refusal precedes body allocation')
    assert.equal((await f.write('bob')).status, 200, 'Alice burst cannot consume Bob allowance')
    assert.equal(f.store.recordTeamwork.read('record').revision, 4)
  } finally { f.cleanup() }
})

test('HTTP Retry-After reflects remaining actual window, recovers exactly at refill; flood produces no hidden events', async () => {
  const realNow = Date.now; let now = realNow()
  Date.now = () => now
  const f = fixture(createMemberHttpWriteBudget(2, 10000))
  try {
    assert.equal((await f.write('alice', 'configure')).status, 200)
    assert.equal((await f.write('alice')).status, 200)
    const rev = f.store.recordTeamwork.read('record').revision
    now += 1101
    for (let i = 0; i < 30; i++) { const result = await f.write('alice'); assert.equal(result.status, 429); assert.equal(result.headers.get('Retry-After'), '9') }
    assert.equal(f.store.recordTeamwork.read('record').revision, rev)
    now += 8898; assert.equal((await f.write('alice')).headers.get('Retry-After'), '1')
    now += 2; assert.equal((await f.write('alice')).status, 200)
    assert.equal(f.store.recordTeamwork.read('record').revision, rev + 1)
  } finally { Date.now = realNow; f.cleanup() }
})

test('separate profile family cannot starve teamwork; profile 429 gives actual window and avoids body allocation', async () => {
  const profiles = createMemberHttpWriteBudget(1, 25000), teamwork = createMemberHttpWriteBudget(2, 10000)
  assert.equal(profiles.take('alice'), true)
  let status = 0, allocated = false; const headers = new Map()
  const handler = createTeamMemberProfileHttpHandler({ store: {} as any, teamId: () => 'team', authenticate: () => ({ member: { memberId: 'alice', role: 'admin' }, deviceId: 'alice' }), readBody: async () => { allocated = true; return {} }, releaseBody: () => {}, json: (_res, code) => { status = code }, drain: () => {}, takeWrite: profiles.take, retryAfterSeconds: profiles.retryAfterSeconds })
  await handler({ method: 'POST' } as any, { setHeader: (key: string, value: string) => headers.set(key, value) } as any, new URL('http://local/api/team-member-profile'))
  assert.equal(status, 429); assert.equal(allocated, false); assert.equal(headers.get('Retry-After'), '25')
  assert.equal(teamwork.take('alice'), true); assert.equal(profiles.take('bob'), true)
})

test('bounded per-member budget refuses identity flood without evicting existing members', () => {
  const budget = createMemberHttpWriteBudget(2, 60000, 3)
  for (const id of ['a', 'b', 'c']) assert.equal(budget.take(id), true)
  for (let i = 0; i < 100; i++) assert.equal(budget.take(`new-${i}`), false)
  for (const id of ['a', 'b', 'c']) { assert.equal(budget.take(id), true); assert.equal(budget.take(id), false) }
  assert.equal(budget.take('a\0extra'), false)
})

test('self-host overrides have documented defaults, bounds and invalid-input fallback', () => {
  const url = new URL('../src/throughput.ts', import.meta.url).href
  const read = (extra: Record<string, string>) => {
    const env = { ...process.env, TEAMSPACE_AUTH_HTTP_TOKENS: '', TEAMSPACE_RECORD_TEAMWORK_HTTP_TOKENS: '', TEAMSPACE_MEMBER_PROFILE_HTTP_TOKENS: '', ...extra }
    return JSON.parse(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `const t=await import(${JSON.stringify(url)});console.log(JSON.stringify([t.AUTH_HTTP_TOKENS_PER_WINDOW,t.RECORD_TEAMWORK_HTTP_TOKENS_PER_WINDOW,t.MEMBER_PROFILE_HTTP_TOKENS_PER_WINDOW]))`], { env, encoding: 'utf8' }))
  }
  assert.deepEqual(read({}), [600, 600, 60])
  assert.deepEqual(read({ TEAMSPACE_AUTH_HTTP_TOKENS: '10000' }), [10000, 10000, 60])
  assert.deepEqual(read({ TEAMSPACE_RECORD_TEAMWORK_HTTP_TOKENS: '999999', TEAMSPACE_MEMBER_PROFILE_HTTP_TOKENS: '999999' }), [600, 10000, 10000])
  assert.deepEqual(read({ TEAMSPACE_RECORD_TEAMWORK_HTTP_TOKENS: '-2', TEAMSPACE_MEMBER_PROFILE_HTTP_TOKENS: '0' }), [600, 10, 5])
  assert.deepEqual(read({ TEAMSPACE_RECORD_TEAMWORK_HTTP_TOKENS: 'bad', TEAMSPACE_MEMBER_PROFILE_HTTP_TOKENS: 'Infinity' }), [600, 600, 60])
})

test('server connects the actual route handlers to independent authenticated member budgets', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  const teamwork = source.slice(source.indexOf('const recordTeamworkHttpDeps:'), source.indexOf('const handleWorkspaceWorkHttp ='))
  const profile = source.slice(source.indexOf('const handleTeamMemberProfileHttp ='), source.indexOf('// Explicitly associated existing Office objects'))
  assert.match(teamwork, /takeWrite: recordTeamworkHttpBudget.take/); assert.match(teamwork, /retryAfterSeconds: recordTeamworkHttpBudget.retryAfterSeconds/)
  assert.match(profile, /takeWrite: memberProfileHttpBudget.take/)
  assert.doesNotMatch(teamwork + profile, /takeAdminHttpMutateToken/)
})
