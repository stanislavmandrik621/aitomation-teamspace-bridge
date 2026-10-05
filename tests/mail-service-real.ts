/** Real empty service + encrypted disk boundary checks. No OAuth credentials,
 * mailbox connections, provider responses, tokens, or fetch overrides are used. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { encryptBlobBody } from '../src/at-rest.js'
import { MailOAuthError, MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'
import { MailStore } from '../src/mail-store.js'
import { extendMailCooldown } from '../src/mail-cooldown.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-service-real-')))
const key = { key: randomBytes(32) }
const options = { dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' }
// These are empty caller namespaces, not seeded/authenticated mailbox accounts.
const namespace: MailIdentity = { teamId: randomUUID(), memberId: randomUUID(), deviceId: randomUUID(), projectId: randomUUID() }
const secondNamespace = { ...namespace, projectId: randomUUID() }
const absent = randomUUID()
// Deliberately contains no recipient or sendable message.
const unsendable = { to: [], subject: '', text: '', idempotencyKey: randomUUID() }
const allowed = () => true
const revoked = () => false
const errorCode = (code: string) => (error: unknown) => error instanceof MailOAuthError && error.code === code
let service: MailOAuthService | undefined
let inspection: MailStore | undefined
let watchdog: ReturnType<typeof setTimeout> | undefined

try {
  // Watchdog is a failing process guard, not a substitute for orderly shutdown.
  watchdog = setTimeout(() => { console.error('FAIL: real mailbox boundary check exceeded 15 seconds'); process.exit(1) }, 15_000)
  const mailDirectory = join(directory, 'mail-oauth')
  mkdirSync(mailDirectory, { mode: 0o700 })
  const legacyPath = join(mailDirectory, 'mail-oauth.v1.enc')
  const emptyLegacy = encryptBlobBody(key, Buffer.from(JSON.stringify({ version: 1, connections: [], sends: [] })))
  writeFileSync(legacyPath, emptyLegacy, { mode: 0o600, flag: 'wx' })
  service = new MailOAuthService(options)
  await service.ready()
  // Exercise real in-process fence state, not a mocked mailbox/provider.
  const fences = service as unknown as { authorityVersion(id: string): object; changeAuthority(id: string): void; authorityVersions: Map<string, object> }
  const before = fences.authorityVersion(absent)
  fences.changeAuthority(absent)
  assert.notEqual(fences.authorityVersion(absent), before)
  const changed = fences.authorityVersion(absent)
  fences.changeAuthority(absent)
  fences.authorityVersions.delete(absent)
  assert.notEqual(fences.authorityVersion(absent), before, 'forget never restores an old unfenced observation')
  assert.notEqual(fences.authorityVersion(absent), changed, 'forget never restores an old explicit observation')
  assert.equal(service.capabilities().google.configured, false)
  assert.equal(service.capabilities().microsoft.configured, false)
  for (const scope of [namespace, secondNamespace]) {
    assert.deepEqual(await service.list(scope, { limit: 1 }), { connections: [], hasMore: false })
    assert.deepEqual(await service.outbox(scope, { limit: 1 }), { jobs: [], hasMore: false })
  }
  await assert.rejects(service.list(namespace, { limit: 101 }), errorCode('page'))
  await assert.rejects(service.start(namespace, { provider: 'google' }, revoked), errorCode('unauthorized'))
  await assert.rejects(service.send(namespace, absent, unsendable, revoked), errorCode('unauthorized'))
  await assert.rejects(service.cancel(namespace, absent, revoked), errorCode('unauthorized'))
  await assert.rejects(service.inbox(namespace, absent, revoked), errorCode('unauthorized'))
  for (const provider of ['google', 'microsoft'] as const) {
    await assert.rejects(service.start(namespace, { provider }, allowed), errorCode('provider_unavailable'))
    await assert.rejects(service.callback(provider, new URLSearchParams(), allowed), errorCode('oauth_state'))
  }
  await assert.rejects(service.send(namespace, absent, unsendable, allowed), errorCode('not_found'))
  await assert.rejects(service.inbox(namespace, absent, allowed), errorCode('not_found'))
  await assert.rejects(service.disconnect(namespace, absent, allowed), errorCode('not_found'))
  await assert.rejects(service.pause(namespace, absent, false, allowed), errorCode('not_found'))
  await assert.rejects(service.grants(namespace, absent), errorCode('not_found'))
  await assert.rejects(service.grant(namespace, absent, secondNamespace, { send: true, read: false }, allowed), errorCode('not_found'))
  await assert.rejects(service.revokeGrant(namespace, absent, randomUUID(), allowed), errorCode('not_found'))
  await assert.rejects(service.cancel(namespace, absent, allowed), errorCode('not_found'))
  service.startWorkers(revoked)
  await delay(320)
  assert.deepEqual(service.capabilities().worker, { running: true, active: 0, healthy: true, lastErrorAt: undefined })
  await service.close()
  assert.equal(service.capabilities().worker.running, false)
  assert.equal(existsSync(join(mailDirectory, 'mail-store.sqlite3')), true)
  assert.deepEqual(readFileSync(legacyPath), emptyLegacy, 'migration preserves the original encrypted backup')

  // Inspect migration metadata only after the service's SQLite connection closes.
  inspection = new MailStore({ dataDir: directory, key })
  await inspection.ready()
  const marker = await inspection.get<{ version: number }>('meta', 'legacy-migrated')
  assert.equal(marker?.value.version, 2)
  assert.equal(await inspection.count('connections'), 0)
  assert.equal(await inspection.count('access'), 0)
  assert.equal(await inspection.count('outbox'), 0)
  const cooldownId = randomUUID()
  const cooldownBase = Date.now()
  await Promise.all(Array.from({ length: 16 }, (_, index) => extendMailCooldown(inspection!, cooldownId, cooldownBase + (index + 1) * 1000)))
  await extendMailCooldown(inspection, cooldownId, cooldownBase + 1000)
  assert.equal((await inspection.get<{ until: number }>('cooldowns', cooldownId))?.value.until, cooldownBase + 16_000, 'concurrent and stale cooldown writes cannot shorten the provider deadline')
  await inspection.close()
  service = new MailOAuthService(options)
  await service.ready()
  assert.deepEqual(await service.list(namespace), { connections: [], hasMore: false })
  await service.close()
  inspection = new MailStore({ dataDir: directory, key })
  await inspection.ready()
  assert.equal((await inspection.get('meta', 'legacy-migrated'))?.revision, marker?.revision, 'reopen does not repeat the completed migration')
  await inspection.close()
  console.log('PASS: real empty encrypted mail service, namespace pages, denied authorization/missing connections, provider-disabled/state guards, legacy migration, idle worker health, close/reopen; no provider requests or simulated accounts')
} finally {
  await service?.close().catch(() => undefined)
  await inspection?.close().catch(() => undefined)
  if (watchdog) clearTimeout(watchdog)
  rmSync(directory, { recursive: true, force: true })
}
