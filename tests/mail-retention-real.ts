/** Real encrypted SQLite and service lifecycle checks. Records below are local
 * test fixtures with no credentials/connections; no provider can be contacted. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailStore, type MailStoreBatchOptions, type MailStoreWrite } from '../src/mail-store.js'
import { MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'
import { cleanupApprovedOutboxHistory, mailRetentionOwnerKey, mailRetentionPolicyCheck, readMailRetentionPolicy, saveMailRetentionPolicy } from '../src/mail-retention.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-retention-real-')))
const key = { key: randomBytes(32) }, now = Date.now(), day = 86_400_000
const owner: MailIdentity = { teamId: randomUUID(), memberId: randomUUID(), projectId: randomUUID(), deviceId: randomUUID() }
const other = { ...owner, projectId: randomUUID() }
let store = new MailStore({ dataDir: directory, key }), service: MailOAuthService | undefined
const allowed = () => true
function job(id: string, status: string, actor = owner, options: { createdAt?: number; completedAt?: number; keyAt?: number } = {}) {
  const createdAt = options.createdAt ?? now - 120 * day
  return { jobId: id, actor, status, connectionId: 'absent-connection', account: 'unsendable-account', digest: 'test-digest', to: ['fixture@controlled.invalid'],
    subject: 'Local retention verification', text: 'Keep this private original message body forever unless deletion was explicitly approved.',
    createdAt, ...(options.completedAt === undefined ? {} : { completedAt: options.completedAt }), due: createdAt + 30 * day, attempts: 1,
    idempotencyKey: `m_${options.keyAt ?? createdAt}_${randomUUID()}` }
}
async function put(id: string, status: string, actor = owner, options?: Parameters<typeof job>[3]) {
  const value = job(id, status, actor, options)
  await store.batch([{ collection: 'outbox', id, value, owner: mailRetentionOwnerKey(actor), status: ['queued', 'retry_wait'].includes(status) ? 'pending' : status, account: value.account, due: value.due }])
  return value
}
try {
  await store.ready()
  const original = await put('old_accepted', 'accepted')
  for (const status of ['rejected', 'cancelled', 'unknown', 'dispatching']) await put(`old_${status}`, status)
  await put('cancel_me', 'queued')
  await put('other_owner', 'accepted', other)
  await put('fresh_key', 'accepted', owner, { keyAt: now })
  await put('fresh_completion', 'accepted', owner, { completedAt: now })
  assert.deepEqual(await readMailRetentionPolicy(store, owner), { retentionDays: 0, approvedAt: null, revision: 0 })
  assert.equal((await cleanupApprovedOutboxHistory(store, owner, {}, allowed)).deleted, 0, 'legacy due/30-day timestamps do not imply deletion approval')
  await assert.rejects(saveMailRetentionPolicy(store, owner, { retentionDays: 30, approveDeletion: false, expectedRevision: 0 }, allowed), /Explicitly approve/)
  await assert.rejects(saveMailRetentionPolicy(store, owner, { retentionDays: 30, approveDeletion: true, expectedRevision: 0, forged: true }, allowed), /Invalid/)
  await assert.rejects(saveMailRetentionPolicy(store, owner, Object.assign(Object.create({ inherited: true }), { retentionDays: 30, approveDeletion: true, expectedRevision: 0 }), allowed), /Invalid/)
  await store.close()
  service = new MailOAuthService({ dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' })
  await service.ready()
  service.startWorkers(allowed)
  assert.equal(service.capabilities().historyDays, 0)
  assert.equal(service.capabilities().mailRetention, true)
  assert.deepEqual(await service.retention('retention-get', owner, {}, allowed), { policy: { retentionDays: 0, approvedAt: null, revision: 0 } })
  await service.cancel(owner, 'cancel_me', allowed)
  await service.close(); service = undefined
  store = new MailStore({ dataDir: directory, key }); await store.ready()
  for (const id of ['old_accepted', 'old_rejected', 'old_cancelled', 'old_unknown', 'old_dispatching', 'cancel_me']) {
    assert.equal((await store.get<Record<string, unknown>>('outbox', id))?.value.text, original.text, `${id} retains its original body through startup/cancellation`)
  }
  assert.equal((await store.get<Record<string, unknown>>('outbox', 'old_dispatching'))?.value.status, 'unknown')
  const approved = await saveMailRetentionPolicy(store, owner, { retentionDays: 7, approveDeletion: true, expectedRevision: 0 }, allowed)
  assert.equal(approved.revision, 1); assert.ok(approved.approvedAt)
  assert.equal(await store.count('mail-retention', { status: 'enabled' }), 1, 'worker admission indexes only explicitly enabled cleanup policies')
  await assert.rejects(saveMailRetentionPolicy(store, owner, { retentionDays: 0, approveDeletion: false, expectedRevision: 0 }, allowed), /changed/)
  const cleaned = await cleanupApprovedOutboxHistory(store, owner, {}, allowed)
  assert.equal(cleaned.deleted, 3, 'only explicitly approved old definitive terminal history is removed')
  for (const id of ['old_unknown', 'old_dispatching', 'cancel_me', 'other_owner', 'fresh_key', 'fresh_completion']) assert.ok(await store.get('outbox', id), `${id} must survive approved cleanup`)
  assert.deepEqual(await readMailRetentionPolicy(store, other), { retentionDays: 0, approvedAt: null, revision: 0 }, 'another owner/project never inherits consent')

  await put('race_policy', 'accepted')
  // Inject only an interleaving before the REAL SQLite transaction. Both policy
  // save and deletion execute production CAS code; no in-memory storage mock.
  const realBatch = store.batch.bind(store)
  let policyRace = true
  store.batch = async (writes: MailStoreWrite[], options?: MailStoreBatchOptions) => {
    if (policyRace && writes.some(write => write.collection === 'outbox' && write.delete)) {
      policyRace = false
      await saveMailRetentionPolicy(store, owner, { retentionDays: 0, approveDeletion: false, expectedRevision: 1 }, allowed)
    }
    return realBatch(writes, options)
  }
  await assert.rejects(cleanupApprovedOutboxHistory(store, owner, {}, allowed), /approval changed/)
  assert.ok(await store.get('outbox', 'race_policy'), 'revoking approval before the delete transaction preserves history')
  assert.equal(await store.count('mail-retention', { status: 'enabled' }), 0, 'Keep forever removes the policy from automatic cleanup admission')
  store.batch = realBatch
  const policy = await saveMailRetentionPolicy(store, owner, { retentionDays: 7, approveDeletion: true, expectedRevision: 2 }, allowed)
  let rowRace = true
  store.batch = async (writes: MailStoreWrite[], options?: MailStoreBatchOptions) => {
    if (rowRace && writes.some(write => write.collection === 'outbox' && write.delete)) {
      rowRace = false
      const row = await store.get<Record<string, unknown>>('outbox', 'race_policy')
      await realBatch([{ collection: 'outbox', id: 'race_policy', value: { ...row!.value, status: 'unknown' }, owner: mailRetentionOwnerKey(owner), status: 'unknown' }])
    }
    return realBatch(writes, options)
  }
  await assert.rejects(cleanupApprovedOutboxHistory(store, owner, {}, allowed), /history or deletion approval changed/)
  assert.equal((await store.get<Record<string, unknown>>('outbox', 'race_policy'))?.value.status, 'unknown')
  store.batch = realBatch

  for (let index = 0; index < 22; index++) await put(`a_protected_${String(index).padStart(3, '0')}`, 'unknown')
  await put('z_late_eligible', 'cancelled')
  let after: string | undefined, pages = 0
  do {
    const result = await cleanupApprovedOutboxHistory(store, owner, { after }, allowed)
    after = result.nextCursor; pages++
  } while (after && pages < 20)
  assert.ok(pages > 2)
  assert.equal(await store.get('outbox', 'z_late_eligible'), null, 'protected rows cannot starve later eligible history')
  assert.ok(await store.get('outbox', 'a_protected_000'))
  await put('auth_changed', 'accepted')
  await assert.rejects(cleanupApprovedOutboxHistory(store, owner, {}, () => false), /authorization changed/)
  assert.ok(await store.get('outbox', 'auth_changed'))
  const policyKey = mailRetentionPolicyCheck(owner, policy.revision)
  await realBatch([{ collection: policyKey.collection, id: policyKey.id, value: { version: 1, owner, retentionDays: 7, approvedAt: null } }])
  await assert.rejects(readMailRetentionPolicy(store, owner), /invalid/)
  await assert.rejects(cleanupApprovedOutboxHistory(store, owner, {}, allowed), /invalid/, 'corrupt policy cannot be interpreted as deletion approval')
  assert.ok(await store.get('outbox', 'auth_changed'))
  await store.close()
  assert.equal(readFileSync(join(directory, 'mail-oauth', 'mail-store.sqlite3')).includes(Buffer.from(original.text)), false)
  console.log('PASS: encrypted keep-forever default, preserved terminal/cancel/restart bodies, explicit owner-scoped deletion approval, revision and authorization fences, 7-day idempotency safety, protected unknown/active work, fair cleanup cursor and corrupt-policy fail closed; no provider requests')
} finally { await service?.close().catch(() => undefined); await store.close().catch(() => undefined); rmSync(directory, { recursive: true, force: true }) }
