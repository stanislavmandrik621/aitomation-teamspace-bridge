/** Real encrypted SQLite retention/archive tests. No provider authentication or
 * sending occurs; legacy records are deliberately seeded as migration inputs. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailStore } from '../src/mail-store.js'
import { OAuthMailWarmup, DEFAULT_OAUTH_WARMUP_CONFIG, type OAuthWarmupAdapter, type OAuthWarmupJob } from '../src/mail-warmup.js'
import { readMailRetentionPolicy, saveMailRetentionPolicy } from '../src/mail-retention.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'warmup-history-real-')))
const key = { key: randomBytes(32) }
let store = new MailStore({ dataDir: directory, key })
const owner = { teamId: randomUUID(), memberId: randomUUID(), projectId: randomUUID(), deviceId: randomUUID() }
const scope = JSON.stringify([owner.teamId, owner.memberId, owner.projectId, owner.deviceId])
const id = createHash('sha256').update(scope).digest('hex')
let now = Date.now()
const old = now - 30 * 86_400_000
const adapter: OAuthWarmupAdapter = { mailboxes: async () => { throw new Error('No mailbox access expected') },
  fence: (_ids, current) => current, send: async () => { throw new Error('No sending expected') }, receipt: async () => { throw new Error('No provider reads expected') } }
const jobs: OAuthWarmupJob[] = Array.from({ length: 164 }, (_, index) => ({ id: `history_${String(index).padStart(4, '0')}`,
  fromProfileId: 'a', toProfileId: 'b', from: 'a@controlled.invalid', to: 'b@controlled.invalid', exchange: 1,
  token: `private-proof-${index}`, rfcId: `<${index}@controlled.invalid>`, subject: 'Private test subject', text: `Private retained body ${index}`,
  status: index === 0 ? 'unknown' : index === 1 ? 'accepted_paused' : index === 2 ? 'queued' : index === 3 ? 'accepted'
    : index % 3 === 1 ? 'received' : index % 3 === 2 ? 'failed' : 'cancelled',
  dueAt: old + index, sentAt: index === 2 ? null : old + index, receivedAt: index >= 4 && index % 3 === 1 ? old + index : null,
  checkedAt: old, labelled: true, receiptId: `receipt_${index}`, error: null,
}))
const record = { version: 1, owner, config: { ...DEFAULT_OAUTH_WARMUP_CONFIG, profileIds: ['a', 'b'] }, consent: randomUUID(), fingerprints: {},
  startedAt: old, day: Math.floor(now / 86_400_000), outgoing: {}, incoming: {}, lastSent: {}, nextSender: 0, jobs, pauseReason: null }
async function all(engine: OAuthMailWarmup, who = owner) {
  const found: Array<{ id: string }> = []
  let after: string | undefined
  do {
    const page = await engine.history(who, { limit: 17, ...(after ? { after } : {}) }, () => true)
    assert.ok(page.jobs.length <= 17)
    const output = JSON.stringify(page)
    assert.doesNotMatch(output, /private-proof|Private retained body|rfcId|receiptId|controlled\.invalid/)
    found.push(...page.jobs)
    after = page.nextCursor
    assert.equal(page.hasMore, after !== undefined)
  } while (after)
  assert.equal(new Set(found.map(job => job.id)).size, found.length, 'pages never duplicate runtime/archive entries')
  return found
}
try {
  await store.ready()
  await store.batch([{ collection: 'warmup-programs', id, value: record, owner: scope },
    { collection: 'warmup-labels', id: 'preserved-proof-label', owner: scope, value: { messageId: 'receipt_4', jobId: jobs[4].id } }])
  let engine = new OAuthMailWarmup(store, adapter, () => now)
  assert.equal((await readMailRetentionPolicy(store, owner)).retentionDays, 0, 'new scopes keep forever')
  assert.equal((await engine.get(owner, () => true)).state.jobs.length, 50, 'latest50 is display only')
  assert.equal((await all(engine)).length, 164, 'legacy history is complete before migration')
  await engine.tick(owner, () => true)
  assert.equal(await store.count('warmup-history', { owner: scope }), 100, 'bounded archive preserves terminal overflow')
  assert.equal((await all(engine)).length, 164)
  const firstPage = await engine.history(owner, { limit: 1 }, () => true)
  await assert.rejects(engine.history({ ...owner, projectId: randomUUID() }, { after: firstPage.nextCursor }, () => true), /scope|invalid/)
  for (const limit of [0, 101, NaN, 0.1]) await assert.rejects(engine.history(owner, { limit }, () => true))
  await assert.rejects(engine.history(owner, { after: 'invalid!' }, () => true))
  await assert.rejects(engine.history(owner, {}, () => false))
  assert.deepEqual(await all(engine, { ...owner, memberId: randomUUID() }), [])
  await store.close()
  store = new MailStore({ dataDir: directory, key }); await store.ready()
  engine = new OAuthMailWarmup(store, adapter, () => now + 3650 * 86_400_000)
  await engine.tick(owner, () => true)
  assert.equal((await all(engine)).length, 164, 'restart plus ten years never discards default-retained history')
  engine = new OAuthMailWarmup(store, adapter, () => now)
  await assert.rejects(saveMailRetentionPolicy(store, owner, { retentionDays: 7, approveDeletion: false, expectedRevision: 0 }, () => true))
  assert.equal((await all(engine)).length, 164)
  const firstApproved = await saveMailRetentionPolicy(store, owner, { retentionDays: 7, approveDeletion: true, expectedRevision: 0 }, () => true)
  const rollbackEngine = new OAuthMailWarmup(store, adapter, () => firstApproved.approvedAt! - 1)
  await rollbackEngine.tick(owner, () => true)
  assert.equal((await all(rollbackEngine)).length, 164, 'clock rollback before the approval timestamp cannot authorize history deletion')
  now = Math.max(now, firstApproved.approvedAt!)
  const originalBatch = store.batch.bind(store)
  let changePolicy = true
  store.batch = async (writes, options) => {
    if (changePolicy && writes.some(write => write.collection === 'warmup-programs')) {
      changePolicy = false
      await saveMailRetentionPolicy(store, owner, { retentionDays: 0, approveDeletion: false, expectedRevision: 1 }, () => true)
    }
    return originalBatch(writes, options)
  }
  await assert.rejects(engine.tick(owner, () => true), /retention policy changed/)
  store.batch = originalBatch
  assert.equal((await all(engine)).length, 164, 'switching back to forever before deletion commit cancels the entire purge transaction')
  const reapproved = await saveMailRetentionPolicy(store, owner, { retentionDays: 7, approveDeletion: true, expectedRevision: 2 }, () => true)
  now = Math.max(now, reapproved.approvedAt!)
  for (let iteration = 0; iteration < 4; iteration++) await engine.tick(owner, () => true)
  assert.deepEqual(new Set((await all(engine)).map(job => job.id)), new Set(jobs.slice(0, 4).map(job => job.id)),
    'approved retention removes expired completed jobs but protects unknown, accepted-paused and active jobs')
  assert.ok(await store.get('warmup-labels', 'preserved-proof-label'), 'history retention never deletes verified-mail labels')
  const retainedUnknown = (await store.list<OAuthWarmupJob>('warmup-history', { owner: scope, status: 'unknown', limit: 1 }))[0]
  assert.equal(retainedUnknown.value.text, jobs[0].text, 'retained original private content remains encrypted and recoverable')
  // The real store/batch remains in use; only its count observation is
  // instrumented to exercise the million-record cap without inserting a
  // million test rows. Scheduling must pause without dropping history.
  const fullOwner = { ...owner, projectId: randomUUID() }, fullScope = JSON.stringify([fullOwner.teamId, fullOwner.memberId, fullOwner.projectId, fullOwner.deviceId])
  const fullId = createHash('sha256').update(fullScope).digest('hex')
  await store.batch([{ collection: 'warmup-programs', id: fullId, owner: fullScope,
    value: { ...record, owner: fullOwner, config: { ...record.config, enabled: true } } }])
  const originalCount = store.count.bind(store)
  store.count = async (collection, query) => collection === 'warmup-history' ? 1_000_000 : originalCount(collection, query)
  const full = await engine.tick(fullOwner, () => true)
  store.count = originalCount
  assert.equal(full.state.config.enabled, false)
  assert.match(full.state.pauseReason!, /storage limit/)
  assert.equal((await all(engine, fullOwner)).length, 164, 'capacity exhaustion keeps every job while stopping scheduling')
  console.log('PASS: encrypted warm-up archive, complete restart-safe paginated history, default forever, explicit approved expiry, protected unknown/active jobs, scope/cursor isolation and private projection')
} finally { await store.close(); rmSync(directory, { recursive: true, force: true }) }
