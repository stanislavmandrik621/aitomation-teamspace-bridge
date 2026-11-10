/** Deterministic OAuth-provider fixtures, with the production service and real
 * encrypted SQLite storage. No real login, provider request or mail delivery. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, get } from 'node:http'
import { once } from 'node:events'
import { createConfiguredMailService } from '../src/mail-config.js'
import { createMailHttpHandler } from '../src/mail-http.js'
import { MailOAuthError, MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'
import { mailProviderCapabilities, normalizeMailMicrosoftTenant, normalizeMailOAuthFailure } from '../src/mail-oauth-policy.js'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mail-oauth-corporate-')))
const key = { key: randomBytes(32) }
const owner: MailIdentity = { teamId: 'fixture-team', memberId: 'fixture-member', projectId: 'fixture-project', deviceId: 'fixture-device' }
const options = { key, publicUrl: 'https://mail.example.invalid', google: { clientId: 'fixture-google', clientSecret: 'fixture-google-secret' }, microsoft: { clientId: 'fixture-microsoft', clientSecret: 'fixture-microsoft-secret' } }
const uuid = 'AABBCCDD-1234-5678-ABCD-1234567890AB'
const code = (expected: string) => (error: unknown) => error instanceof MailOAuthError && error.code === expected
const services: MailOAuthService[] = []
const originalFetch = globalThis.fetch
let requestCount = 0
let providerReply: (url: string, init: RequestInit) => Response | Promise<Response> = () => { throw new Error('Unexpected provider request') }
globalThis.fetch = async (url, init = {}) => {
  requestCount++
  assert.ok(/^https:\/\/(oauth2.googleapis.com|openidconnect.googleapis.com|login.microsoftonline.com|graph.microsoft.com)\//.test(String(url)))
  return providerReply(String(url), init)
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
async function service(tenant = 'common') {
  const dataDir = join(root, randomUUID()); mkdirSync(dataDir)
  const instance = new MailOAuthService({ ...options, dataDir, microsoft: { ...options.microsoft, tenant } })
  services.push(instance); await instance.ready(); instance.startWorkers(() => true)
  return instance
}
async function callbackParams(instance: MailOAuthService, provider: 'google' | 'microsoft', actor = owner) {
  const url = new URL((await instance.start(actor, { provider, readInbox: true, mailboxAccess: true }, () => true)).authorizationUrl)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('redirect_uri'), `https://mail.example.invalid/v1/mail/oauth/${provider}/callback`)
  assert.ok(!url.toString().includes('secret'))
  if (provider === 'google') { assert.equal(url.searchParams.get('hd'), null); assert.equal(url.searchParams.get('access_type'), 'offline') }
  else assert.ok(url.searchParams.get('scope')?.includes('offline_access'))
  return new URLSearchParams({ state: url.searchParams.get('state')!, code: 'fixture-code' })
}

try {
  for (const [input, output] of [[undefined, 'common'], [' common ', 'common'], ['ORGANIZATIONS', 'organizations'], ['consumers', 'consumers'], [uuid, uuid]] as const) {
    assert.equal(normalizeMailMicrosoftTenant(input), output)
  }
  for (const invalid of ['', ' ', 'tenant.example.com', '../common', 'common?x=1', 'common#x', 'common\n', uuid + '/authorize', '1234', null, 3]) {
    assert.throws(() => normalizeMailMicrosoftTenant(invalid as string))
    assert.throws(() => new MailOAuthService({ ...options, dataDir: join(root, 'invalid'), microsoft: { ...options.microsoft, tenant: invalid as string } }), code('provider_config'))
  }
  assert.equal(createConfiguredMailService(root, key, {}), null)
  assert.throws(() => createConfiguredMailService(root, key, { TEAMSPACE_MAIL_PUBLIC_URL: options.publicUrl, TEAMSPACE_MAIL_MICROSOFT_CLIENT_ID: 'fixture', TEAMSPACE_MAIL_MICROSOFT_CLIENT_SECRET: 'fixture', TEAMSPACE_MAIL_MICROSOFT_TENANT: '../bad' }), /Invalid Microsoft mail tenant/)
  mkdirSync(join(root, 'env-guid'))
  const configured = createConfiguredMailService(join(root, 'env-guid'), key, { TEAMSPACE_MAIL_PUBLIC_URL: options.publicUrl, TEAMSPACE_MAIL_MICROSOFT_CLIENT_ID: 'fixture', TEAMSPACE_MAIL_MICROSOFT_CLIENT_SECRET: 'fixture', TEAMSPACE_MAIL_MICROSOFT_TENANT: uuid })!
  services.push(configured); await configured.ready()
  assert.deepEqual(configured.capabilities().microsoft.accountTypes, ['work_school'])
  assert.deepEqual(configured.capabilities().google.accountTypes, [])
  for (const [tenant, expected] of [['common', ['personal', 'work_school']], ['organizations', ['work_school']], ['consumers', ['personal']], [uuid, ['work_school']], ['9188040d-6c67-4c5b-b112-36a304b66dad', ['personal']]] as const) {
    const instance = await service(tenant)
    const capability = instance.capabilities().microsoft
    assert.deepEqual(capability.accountTypes, expected)
    assert.equal(capability.adminApprovalPossible, expected.some(value => value === 'work_school'))
    assert.equal(capability.accountTypesDependOnAppRegistration, true)
    const url = new URL((await instance.start(owner, { provider: 'microsoft' }, () => true)).authorizationUrl)
    assert.equal(url.pathname, `/${tenant}/oauth2/v2.0/authorize`)
    await instance.close()
  }
  assert.deepEqual(mailProviderCapabilities('google', true).accountTypes, ['personal', 'work_school'])
  assert.deepEqual(mailProviderCapabilities('microsoft', false).accountTypes, [])
  console.log('PASS: shared env/service tenant validation, GUID preservation, audience eligibility and app-registration caveat; personal and corporate endpoints')

  const denial = await service()
  const beforeDenied = requestCount
  for (const [provider, error, expected] of [
    ['google', 'admin_policy_enforced', 'organization_policy'], ['google', 'org_internal', 'account_type'],
    ['microsoft', 'access_denied', 'oauth_denied'], ['microsoft', 'consent_required', 'consent_required'],
    ['microsoft', 'unauthorized_client', 'provider_config'], ['microsoft', 'interaction_required', 'reconnect'],
  ] as const) {
    const params = await callbackParams(denial, provider)
    params.delete('code'); params.set('error', error); params.set('error_description', '<script>PRIVATE_PROVIDER_TEXT</script>')
    await assert.rejects(denial.callback(provider, params, () => true), error => {
      assert.ok(code(expected)(error)); assert.ok(!(error as Error).message.includes('PRIVATE_PROVIDER_TEXT')); return true
    })
    await assert.rejects(denial.callback(provider, params, () => true), code('oauth_state'))
  }
  assert.equal(requestCount, beforeDenied, 'denied callbacks never exchange tokens')
  const foreignState = await callbackParams(denial, 'google')
  await assert.rejects(denial.callback('microsoft', foreignState, () => true), code('oauth_state'))
  const revoked = await callbackParams(denial, 'google')
  await assert.rejects(denial.callback('google', revoked, () => false), code('unauthorized'))
  assert.equal(normalizeMailOAuthFailure('microsoft', '<script>PRIVATE</script>', 'callback').code, 'oauth_denied')
  console.log('PASS: safe organization/consent/config guidance, callback state single-use/provider binding and revoked identity fences')

  for (const provider of ['google', 'microsoft'] as const) for (const accountKind of ['personal', 'corporate'] as const) {
    const tenant = provider === 'microsoft' ? accountKind === 'personal' ? 'consumers' : uuid : 'common'
    const instance = await service(tenant)
    const scope = provider === 'google' ? 'openid email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify' : 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite'
    let stage: 'initial' | 'refresh' | 'revoked' | 'reconnect' | 'missing-refresh' | 'unverified' = 'initial'
    let tokenRequests = 0
    const firstRefresh = `${provider}-fixture-refresh-1`
    const nextRefresh = `${provider}-fixture-refresh-2`
    providerReply = (url, init) => {
      if (url.endsWith('/token')) {
        tokenRequests++
        const body = new URLSearchParams(String(init.body))
        assert.equal(init.method, 'POST')
        assert.equal(body.get('client_id'), options[provider].clientId)
        if (provider === 'microsoft') assert.equal(new URL(url).pathname, `/${tenant}/oauth2/v2.0/token`)
        if (body.get('grant_type') === 'refresh_token') {
          assert.equal(body.get('refresh_token'), firstRefresh)
          if (stage === 'revoked') return json({ error: 'invalid_grant', error_description: 'PRIVATE_PROVIDER_TEXT' }, 400)
          assert.equal(stage, 'refresh')
          return json({ access_token: `${provider}-fixture-access-refreshed`, ...(provider === 'microsoft' ? { refresh_token: nextRefresh } : {}), expires_in: 3600, token_type: 'Bearer' })
        }
        assert.ok(body.get('code_verifier')!.length >= 43)
        return json({ access_token: `${provider}-fixture-access-${stage}`, ...(stage === 'missing-refresh' ? {} : { refresh_token: firstRefresh }), expires_in: stage === 'initial' ? 60 : 3600, token_type: 'Bearer', scope })
      }
      return json(provider === 'google'
        ? { sub: `fixture-${accountKind}-account`, email: accountKind === 'personal' ? 'fixture@gmail.com' : 'member@workspace.example', email_verified: stage !== 'unverified' }
        : { id: `fixture-${accountKind}-account`, mail: accountKind === 'personal' ? 'fixture@outlook.com' : null, userPrincipalName: 'member@corporate.example' })
    }
    await instance.callback(provider, await callbackParams(instance, provider), () => true)
    const first = (await instance.list(owner)).connections[0]!
    assert.equal(first.provider, provider); assert.equal(first.canModify, true)
    assert.ok(!JSON.stringify(await instance.list(owner)).includes('fixture-refresh'))
    for (const actor of [{ ...owner, projectId: 'other-project' }, { ...owner, memberId: 'other-member' }, { ...owner, deviceId: 'other-device' }, { ...owner, teamId: 'other-team' }]) {
      assert.equal((await instance.list(actor)).connections.length, 0)
    }
    const runtime = instance as unknown as { token(actor: MailIdentity, id: string, current: () => boolean): Promise<{ accessToken: string; refreshToken: string }>; options: { dataDir: string } }
    stage = 'revoked'
    await assert.rejects(runtime.token(owner, first.id, () => true), code('reconnect'))
    assert.equal((await instance.list(owner)).connections[0]?.id, first.id, 'renewal failure preserves the connection for reconnect')
    stage = 'refresh'
    const before = tokenRequests
    const renewed = await Promise.all([runtime.token(owner, first.id, () => true), runtime.token(owner, first.id, () => true)])
    assert.equal(tokenRequests, before + 1, 'concurrent renewal shares one provider exchange')
    assert.equal(renewed[0].refreshToken, provider === 'microsoft' ? nextRefresh : firstRefresh)
    stage = 'missing-refresh'
    await assert.rejects(instance.callback(provider, await callbackParams(instance, provider), () => true), code('reconnect'))
    assert.equal((await runtime.token(owner, first.id, () => true)).accessToken, renewed[0].accessToken, 'incomplete reconnect leaves prior credentials intact')
    stage = 'reconnect'
    await instance.callback(provider, await callbackParams(instance, provider), () => true)
    const reconnected = (await instance.list(owner)).connections
    assert.equal(reconnected.length, 1); assert.equal(reconnected[0].id, first.id); assert.equal(reconnected[0].createdAt, first.createdAt)
    assert.equal((await runtime.token(owner, first.id, () => true)).accessToken, `${provider}-fixture-access-reconnect`)
    if (provider === 'google') {
      stage = 'unverified'
      await assert.rejects(instance.callback(provider, await callbackParams(instance, provider), () => true), code('mailbox_identity'))
      assert.equal((await instance.list(owner)).connections.length, 1)
    }
    const disk = readFileSync(join(runtime.options.dataDir, 'mail-oauth', 'mail-store.sqlite3'))
    assert.equal(disk.includes(Buffer.from(firstRefresh)), false)
    assert.equal(disk.includes(Buffer.from(`${provider}-fixture-access-reconnect`)), false)
    await instance.close()
    console.log(`PASS: ${provider} ${accountKind} identity, scoped storage, shared refresh/rotation, renewal failure, safe reconnect without duplicate mailbox, tokens remain private`)
  }

  // Real callback HTTP transport verifies users receive safe actionable text.
  const httpService = await service()
  const params = await callbackParams(httpService, 'google')
  params.delete('code'); params.set('error', 'admin_policy_enforced'); params.set('error_description', 'PRIVATE_PROVIDER_TEXT')
  const handler = createMailHttpHandler({ service: httpService, authenticate: () => null, teamId: () => owner.teamId, identityExists: () => true,
    readBody: async () => ({}), releaseBody: () => {}, json: (_res, _status, _body) => { throw new Error('Unexpected JSON route') }, drain: req => { req.resume() } })
  const server = createServer((req, res) => { void handler(req, res, new URL(req.url!, 'http://127.0.0.1')).catch(() => { res.statusCode = 500; res.end() }) })
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    const response = await new Promise<{ status?: number; text: string; type?: string; cache?: string }>((resolve, reject) => {
      get(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1/mail/oauth/google/callback?${params}`, res => {
        let text = ''; res.on('data', value => { text += value }); res.on('end', () => resolve({ status: res.statusCode, text, type: res.headers['content-type'], cache: res.headers['cache-control'] }))
      }).on('error', reject)
    })
    assert.equal(response.status, 403); assert.equal(response.type, 'text/plain; charset=utf-8'); assert.equal(response.cache, 'no-store')
    assert.match(response.text, /Workspace administrator/); assert.ok(!response.text.includes('PRIVATE_PROVIDER_TEXT'))
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  console.log('PASS: real callback HTTP shows fixed administrator guidance without reflecting provider text')
} finally {
  globalThis.fetch = originalFetch
  await Promise.all(services.map(instance => instance.close().catch(() => undefined)))
  rmSync(root, { recursive: true, force: true })
}
