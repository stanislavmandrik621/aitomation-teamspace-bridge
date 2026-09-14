/** Real encrypted SQLite and state machine tests. The provider adapter is an
 * explicit test double; this suite never contacts or authenticates a mailbox. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailStore } from '../src/mail-store.js'
import { DEFAULT_OAUTH_WARMUP_CONFIG, OAuthMailWarmup, parseOAuthWarmupConfig, verifiedWarmupReceipt,
  type OAuthWarmupAdapter, type OAuthWarmupJob, type WarmupMailbox, type WarmupReceipt } from '../src/mail-warmup.js'
import { readWarmupReceipt, warmupMime } from '../src/mail-warmup-provider.js'
import { MailOAuthError, MailOAuthService } from '../src/mail-oauth-service.js'
import { DEFAULT_MAIL_WARMUP_CONFIG, parseMailWarmupConfig } from '../../../apps/desktop/src/lib/mail-warmup-types.js'
import { getMailWarmupTemplateForJob } from '../src/mail-warmup-templates.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'oauth-warmup-real-')))
const key = { key: randomBytes(32) }
let store = new MailStore({ dataDir: directory, key })
let service: MailOAuthService | undefined
const owner = { teamId: randomUUID(), memberId: randomUUID(), projectId: randomUUID(), deviceId: randomUUID() }
const other = { ...owner, projectId: randomUUID() }
let now = Date.UTC(2026, 8, 9, 12), authority = true
let boxes: WarmupMailbox[] = [{ id: 'google', provider: 'google', email: 'owned-google@controlled.invalid', fingerprint: 'g1' },
  { id: 'microsoft', provider: 'microsoft', email: 'owned-microsoft@controlled.invalid', fingerprint: 'm1' }]
const receipts = new Map<string, WarmupReceipt>()
const sends: OAuthWarmupJob[] = []
let mode: 'accepted' | 'unknown' = 'accepted'
let engine: OAuthMailWarmup
const adapter: OAuthWarmupAdapter = {
  mailboxes: async (_owner, ids, current) => { assert.ok(current()); return boxes.filter(box => ids.includes(box.id)) },
  fence: (_ids, current) => () => current() && authority,
  send: async (_owner, _from, job, current) => {
    assert.ok(current())
    const state = await engine.get(owner, () => true)
    assert.equal(state.state.jobs.find(row => row.id === job.id)?.status, 'dispatching', 'claim reaches encrypted durable SQLite BEFORE dispatch')
    assert.equal(state.state.attemptedToday, sends.length + 1, 'both durable attempt budget and job claim precede dispatch')
    sends.push(structuredClone(job))
    return { status: mode, providerMessageId: `sent_${sends.length}` }
  },
  receipt: async (_owner, _to, job, current) => { assert.ok(current()); return receipts.get(job.id) ?? null },
}
const live = () => authority
const config = { ...DEFAULT_OAUTH_WARMUP_CONFIG, enabled: true, profileIds: ['google', 'microsoft'],
  startDailyLimit: 1, maxDailyLimit: 3, minIntervalMinutes: 5, replyDelayMinutes: 5, maxExchanges: 2 }
const receiptFor = (job: OAuthWarmupJob): WarmupReceipt => ({ id: `receipt_${job.id}`, rfcId: job.rfcId,
  from: job.from, to: [job.to], subject: job.subject, text: job.text })
const approved = (mailboxes: WarmupMailbox[]) => mailboxes.map(({ id, email }) => ({ id, email }))
try {
  await store.ready()
  engine = new OAuthMailWarmup(store, adapter, () => now)
  assert.deepEqual(DEFAULT_OAUTH_WARMUP_CONFIG, DEFAULT_MAIL_WARMUP_CONFIG, 'desktop and bridge defaults stay aligned')
  assert.deepEqual(parseOAuthWarmupConfig(config), parseMailWarmupConfig(config), 'desktop and bridge schemas agree')
  assert.throws(() => parseOAuthWarmupConfig({ ...config, minIntervalMinutes: 4 }))
  assert.throws(() => parseOAuthWarmupConfig({ ...config, profileIds: ['google', 'google'] }))
  assert.equal((await engine.tick(owner, live)).state.config.enabled, false)
  assert.equal(sends.length, 0)
  await assert.rejects(engine.save(owner, config, false, live), /Confirm/)
  await assert.rejects(engine.save(owner, config, true, live), /explicitly approve/, 'old clients cannot authorize unseen mailbox addresses')
  await assert.rejects(engine.save(owner, config, true, live, approved(boxes).map(box => ({ ...box, email: 'changed@controlled.invalid' }))), /changed after approval/)
  await assert.rejects(engine.save(owner, config, true, live, [approved(boxes)[0], approved(boxes)[0]]), /invalid/, 'duplicate approved IDs cannot omit another mailbox')
  let releaseEnrollment!: () => void
  const enrollmentGate = new Promise<void>(resolve => { releaseEnrollment = resolve })
  const changedOwner = { ...owner, projectId: randomUUID() }
  let enrollmentBoxes = boxes
  const changedEngine = new OAuthMailWarmup(store, { ...adapter, mailboxes: async () => { await enrollmentGate; return enrollmentBoxes } }, () => now)
  const pendingEnrollment = changedEngine.save(changedOwner, config, true, live, approved(boxes))
  enrollmentBoxes = boxes.map(box => ({ ...box, email: `replaced-${box.email}` }))
  releaseEnrollment()
  await assert.rejects(pendingEnrollment, /changed after approval/, 'an address replaced during asynchronous authorization cannot inherit old user consent')
  assert.equal((await changedEngine.get(changedOwner, live)).state.config.enabled, false)
  await engine.save(owner, config, true, live, approved(boxes))
  assert.equal(sends.length, 0, 'saving consent never sends')
  assert.equal((await engine.get(other, live)).state.config.enabled, false, 'owner/device/project pools are isolated')
  await Promise.all([engine.tick(owner, live), engine.tick(owner, live), engine.tick(owner, live)])
  assert.equal(sends.length, 1, 'concurrent ticks cannot duplicate a claim')
  const first = sends[0], valid = receiptFor(first)
  const template = getMailWarmupTemplateForJob(first.id)
  assert.equal(first.templateId, template.id)
  assert.equal(first.subject, template.subject)
  assert.ok(first.text.startsWith(template.message))
  assert.ok(first.text.includes(`Test reference: ${first.token}`))
  assert.match(warmupMime(first), /Auto-Submitted: auto-generated/)
  assert.ok(warmupMime(first).includes(`Message-ID: ${first.rfcId}`))
  const visible = JSON.stringify((await engine.get(owner, live)).state)
  assert.ok(!visible.includes(first.token), 'public state omits proof tokens and bodies')
  for (const forged of [{ ...valid, rfcId: '<other@invalid>' }, { ...valid, from: 'other@invalid' }, { ...valid, to: ['other@invalid'] },
    { ...valid, subject: 'Warm-up' }, { ...valid, text: 'A subject alone is not receipt proof' }]) {
    assert.equal(verifiedWarmupReceipt(first, forged), false)
    receipts.set(first.id, forged)
    await engine.tick(owner, live)
    assert.equal(sends.length, 1, 'forged receipts cannot authorize automatic replies')
  }
  assert.equal((await engine.verifiedIds(owner, first.toProfileId, [valid.id])).size, 0)
  receipts.set(first.id, valid)
  await engine.tick(owner, live)
  assert.equal(sends.length, 1, 'verified receipt starts a real reply delay')
  assert.equal((await engine.get(owner, live)).state.queued, 1)
  assert.ok((await engine.verifiedIds(owner, first.toProfileId, [valid.id])).has(valid.id), 'only committed actual receipt establishes private label')
  assert.equal((await engine.verifiedIds(other, first.toProfileId, [valid.id])).size, 0, 'receipt labels cannot leak across namespaces')
  now += 5 * 60_000
  await engine.tick(owner, live)
  assert.equal(sends.length, 2)
  const reply = sends[1]
  assert.equal(reply.from, first.to); assert.equal(reply.to, first.from); assert.equal(reply.inReplyTo, first.rfcId)
  assert.equal(reply.templateId, template.id, 'durable template selection is inherited by replies')
  assert.equal(reply.subject, first.subject, 'OAuth reply subject remains unchanged for provider threading')
  assert.ok(reply.text.startsWith(template.reply))
  assert.ok(reply.text.includes(`Test reference: ${reply.token}`))
  assert.notEqual(reply.token, first.token)
  receipts.set(reply.id, receiptFor(reply))
  await engine.tick(owner, live)
  assert.equal((await engine.get(owner, live)).state.queued, 0, 'maxExchanges includes the initial message')
  now += 20 * 60_000
  await engine.tick(owner, live)
  assert.equal(sends.length, 2, 'daily budgets include initial messages and replies for each sender and recipient')
  await engine.pause(owner, live)
  await engine.save(owner, config, true, live, approved(boxes))
  await engine.tick(owner, live)
  assert.equal(sends.length, 2, 'pause/re-enable preserves daily budgets')
  boxes = boxes.map(box => ({ ...box, fingerprint: `${box.fingerprint}-reconsented` }))
  assert.equal((await engine.tick(owner, live)).state.config.enabled, false, 'access/consent change pauses without sending')
  now += 86_400_000
  await engine.save(owner, config, true, live, approved(boxes))
  assert.equal((await engine.get(owner, live)).state.todayLimitPerAccount, 2, 'daily ramp retains original enrollment age')
  mode = 'unknown'
  // The adapter's durability assertion uses total test calls; reset expected count for the new UTC day.
  const previousSends = sends.splice(0)
  await engine.tick(owner, live)
  assert.equal(sends.length, 1)
  assert.equal((await engine.get(owner, live)).state.config.enabled, false)
  await engine.tick(owner, live)
  assert.equal(sends.length, 1, 'uncertain provider outcomes are never automatically retried')
  await store.close()
  const disk = readFileSync(join(directory, 'mail-oauth', 'mail-store.sqlite3'))
  for (const secret of [first.from, first.to, first.token, first.text]) assert.equal(disk.includes(Buffer.from(secret)), false, 'SQLite persistence encrypts mailbox data and receipt secrets')
  store = new MailStore({ dataDir: directory, key }); await store.ready()
  engine = new OAuthMailWarmup(store, adapter, () => now)
  await engine.tick(owner, live)
  assert.equal(sends.length, 1, 'reopen cannot retry an uncertain send')
  assert.ok((await engine.verifiedIds(owner, first.toProfileId, [valid.id])).has(valid.id), 'verified labels survive close/reopen and job history changes')
  authority = false
  await assert.rejects(engine.get(owner, live), /changed/)
  await assert.rejects(engine.tick(owner, live), /changed/)
  authority = true

  // Direct provider parsers run against bounded fixture payloads. These are
  // protocol boundary tests, not provider delivery evidence.
  const payload = { id: 'gmail_received', labelIds: ['INBOX'], payload: { mimeType: 'text/plain',
    headers: [{ name: 'Message-ID', value: first.rfcId }, { name: 'From', value: first.from }, { name: 'To', value: first.to }, { name: 'Subject', value: first.subject }],
    body: { data: Buffer.from(first.text).toString('base64url') } } }
  const googleCalls: string[] = []
  const gmailReceipt = await readWarmupReceipt('google', first, async url => {
    googleCalls.push(url)
    return url.includes('?format=full') ? payload : { messages: [{ id: payload.id }] }
  })
  assert.ok(gmailReceipt && verifiedWarmupReceipt(first, gmailReceipt))
  assert.equal(googleCalls.length, 2)
  assert.ok(new URL(googleCalls[0]).searchParams.get('q')?.includes(`rfc822msgid:${first.rfcId}`))
  const secondGmailReceipt = await readWarmupReceipt('google', first, async url => {
    if (!url.includes('?format=full')) return { messages: [{ id: 'forged_first' }, { id: payload.id }] }
    return url.includes('/forged_first?') ? { ...payload, payload: { ...payload.payload, body: { data: Buffer.from('No private proof').toString('base64url') } } } : payload
  })
  assert.equal(secondGmailReceipt?.id, payload.id, 'a same-RFC-id forged first result cannot mask a verified second receipt')
  const graphReceipt = await readWarmupReceipt('microsoft', first, async url => {
    if (new URL(url).pathname.includes('/mailFolders/')) return { id: new URL(url).pathname.endsWith('sentitems') ? 'sent_folder_id' : 'draft_folder_id' }
    assert.equal(new URL(url).pathname, '/v1.0/me/messages')
    return { value: [{ id: 'graph_received', internetMessageId: first.rfcId, from: { emailAddress: { address: first.from } },
      toRecipients: [{ emailAddress: { address: first.to } }], subject: first.subject, body: { contentType: 'text', content: first.text },
      isDraft: false, parentFolderId: 'junk_folder_id', receivedDateTime: new Date(now).toISOString() }] }
  })
  assert.ok(graphReceipt && verifiedWarmupReceipt(first, graphReceipt))
  const secondGraphReceipt = await readWarmupReceipt('microsoft', first, async url => {
    if (new URL(url).pathname.includes('/mailFolders/')) return { id: new URL(url).pathname.endsWith('sentitems') ? 'sent_folder_id' : 'draft_folder_id' }
    const received = { id: 'graph_received', internetMessageId: first.rfcId, from: { emailAddress: { address: first.from } },
      toRecipients: [{ emailAddress: { address: first.to } }], subject: first.subject, body: { contentType: 'text', content: first.text },
      isDraft: false, parentFolderId: 'junk_folder_id', receivedDateTime: new Date(now).toISOString() }
    return { value: [{ ...received, id: 'forged_first', body: { contentType: 'text', content: 'No private proof' } }, received] }
  })
  assert.equal(secondGraphReceipt?.id, 'graph_received', 'Graph checks each bounded candidate against the private proof')
  for (const folder of ['sent_folder_id', 'draft_folder_id']) {
    assert.equal(await readWarmupReceipt('microsoft', first, async url => new URL(url).pathname.includes('/mailFolders/')
      ? { id: new URL(url).pathname.endsWith('sentitems') ? 'sent_folder_id' : 'draft_folder_id' }
      : { value: [{ id: 'outgoing_copy', internetMessageId: first.rfcId, from: { emailAddress: { address: first.from } },
        toRecipients: [{ emailAddress: { address: first.to } }], subject: first.subject, body: { contentType: 'text', content: first.text },
        isDraft: false, parentFolderId: folder, receivedDateTime: new Date(now).toISOString() }] }), null, 'Sent/Drafts cannot attest actual inbound receipt')
  }
  assert.equal(await readWarmupReceipt('google', first, async url => url.includes('?format=full') ? { ...payload, labelIds: ['SENT'] } : { messages: [{ id: payload.id }] }), null)
  // Exercise actual CAS conflict handling on the encrypted state: a stale
  // snapshot cannot overwrite the existing claim or budget.
  const programs = await store.list<Record<string, any>>('warmup-programs', { limit: 10 })
  const stored = programs.find(row => row.value.owner.projectId === owner.projectId)!
  assert.ok(stored)
  assert.equal(await store.batch([{ collection: 'warmup-programs', id: stored.id, value: stored.value }],
    { checks: [{ collection: 'warmup-programs', id: stored.id, revision: stored.revision - 1 }] }), false)
  // Model the durable on-disk point left by process termination between claim
  // commit and result commit; new service must recover it as unknown.
  stored.value.config.enabled = true
  assert.equal(stored.value.version, 2, 'active jobs and budgets migrate to bounded encrypted pages')
  const jobPageId = `${stored.id}:jobs:${stored.value.jobPages - 1}`
  const jobPage = await store.get<OAuthWarmupJob[]>('warmup-pages', jobPageId)
  assert.ok(jobPage)
  jobPage.value.at(-1)!.status = 'dispatching'
  assert.equal(await store.batch([{ collection: 'warmup-programs', id: stored.id, value: stored.value }, { collection: 'warmup-pages', id: jobPageId, value: jobPage.value }],
    { checks: [{ collection: 'warmup-programs', id: stored.id, revision: stored.revision }] }), true)
  await store.close()
  store = new MailStore({ dataDir: directory, key }); await store.ready()
  engine = new OAuthMailWarmup(store, adapter, () => now)
  const recovered = await engine.tick(owner, live)
  assert.equal(recovered.state.config.enabled, false)
  assert.ok(recovered.state.jobs.some(job => job.status === 'unknown'))
  assert.equal(sends.length, 1, 'durable interrupted claim recovery never dispatches')

  // Real 1,000-account active pool, not just enrollment. Long IDs, fingerprints
  // and addresses would exceed the old 256 KiB single-row limit after only a
  // fraction of these actual durable dispatch claims.
  const scaleOwner = { ...owner, projectId: randomUUID() }
  const scaleBoxes = Array.from({ length: 1000 }, (_, index) => ({ id: `scale_${String(index).padStart(4, '0')}_${'x'.repeat(53)}`,
    provider: 'google' as const, email: `${String(index).padStart(4, '0')}${'a'.repeat(59)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.test`, fingerprint: createHash('sha256').update(String(index)).digest('hex') }))
  let scaleSends = 0
  const scaleAdapter: OAuthWarmupAdapter = { mailboxes: async (_who, ids) => scaleBoxes.filter(box => ids.includes(box.id)), fence: (_ids, current) => current,
    send: async () => { scaleSends++; return { status: 'accepted' } }, receipt: async () => null }
  let scaleEngine = new OAuthMailWarmup(store, scaleAdapter, () => now)
  await scaleEngine.save(scaleOwner, { ...config, profileIds: scaleBoxes.map(box => box.id), dailyIncrement: 0, startDailyLimit: 1, maxDailyLimit: 1, maxExchanges: 1 }, true, () => true, approved(scaleBoxes))
  for (let index = 0; index < 500; index++) await scaleEngine.tick(scaleOwner, () => true)
  assert.equal(scaleSends, 500)
  assert.equal((await scaleEngine.get(scaleOwner, () => true)).state.awaitingReceipt, 500)
  scaleEngine = new OAuthMailWarmup(store, scaleAdapter, () => now)
  await scaleEngine.tick(scaleOwner, () => true)
  assert.equal(scaleSends, 500, 'new service instance preserves all occupied accounts and active claims')
  const scalePaused = await scaleEngine.pause(scaleOwner, () => true)
  assert.equal(scalePaused.state.attemptedToday, 500)
  assert.equal(scalePaused.state.jobs.length, 50, 'pause bounds the recent display without deleting history or resetting budgets')
  let historyAfter: string | undefined, historyCount = 0
  do {
    const history = await scaleEngine.history(scaleOwner, { limit: 100, after: historyAfter }, () => true)
    historyCount += history.jobs.length; historyAfter = history.nextCursor
  } while (historyAfter)
  assert.equal(historyCount, 500, 'all500 paused jobs remain available through runtime plus encrypted archive')
  const scaleStored = (await store.list<Record<string, any>>('warmup-programs', { limit: 10 })).find(row => row.value.owner.projectId === scaleOwner.projectId)!
  assert.ok(Buffer.byteLength(JSON.stringify(scaleStored.value)) < 256 * 1024, 'the 1,000-account header respects the unchanged encrypted row bound')
  const missingPageId = `${scaleStored.id}:jobs:0`, missingPage = await store.get<OAuthWarmupJob[]>('warmup-pages', missingPageId)
  assert.ok(missingPage)
  await store.batch([{ collection: 'warmup-pages', id: missingPageId, delete: true }])
  await assert.rejects(scaleEngine.get(scaleOwner, () => true), /incomplete/, 'missing pages fail closed, never an empty or reset pool')
  await store.batch([{ collection: 'warmup-pages', id: missingPageId, value: missingPage.value.slice(1) }])
  await assert.rejects(scaleEngine.get(scaleOwner, () => true), /incomplete/, 'a truncated page cannot silently discard durable claims')
  await store.batch([{ collection: 'warmup-pages', id: missingPageId, value: missingPage.value }])

  // The previous single-row format stays readable and moves to pages without
  // erasing quotas, pacing or the original consent/ramp metadata.
  const legacyOwner = { ...owner, projectId: randomUUID() }, legacyKey = createHash('sha256').update(JSON.stringify([legacyOwner.teamId, legacyOwner.memberId, legacyOwner.projectId, legacyOwner.deviceId])).digest('hex')
  const legacy = { version: 1, owner: legacyOwner, config: { ...config, enabled: false }, consent: randomUUID(), fingerprints: {}, startedAt: now - 86_400_000,
    day: Math.floor(now / 86_400_000), outgoing: { [first.from]: 1 }, incoming: { [first.to]: 1 }, lastSent: { [first.from]: now }, nextSender: 1, jobs: [], pauseReason: null }
  await store.batch([{ collection: 'warmup-programs', id: legacyKey, value: legacy }])
  assert.equal((await engine.get(legacyOwner, live)).state.attemptedToday, 1)
  const migrated = await engine.pause(legacyOwner, live)
  assert.equal(migrated.state.attemptedToday, 1)
  assert.equal(migrated.state.startedAt, legacy.startedAt)
  assert.equal((await store.get<Record<string, any>>('warmup-programs', legacyKey))!.value.version, 2)

  // Moving the system clock backwards must never mint a new UTC-day budget.
  const rollbackOwner = { ...owner, projectId: randomUUID() }
  let rollbackNow = now, rollbackSends = 0
  const rollbackEngine = new OAuthMailWarmup(store, { ...scaleAdapter, mailboxes: async () => scaleBoxes.slice(0, 2), send: async () => { rollbackSends++; return { status: 'accepted' } } }, () => rollbackNow)
  const rollbackConfig = { ...config, profileIds: scaleBoxes.slice(0, 2).map(box => box.id), dailyIncrement: 0, startDailyLimit: 1, maxDailyLimit: 1, maxExchanges: 1 }
  await rollbackEngine.save(rollbackOwner, rollbackConfig, true, () => true, approved(scaleBoxes.slice(0, 2)))
  await rollbackEngine.tick(rollbackOwner, () => true)
  rollbackNow -= 86_400_000
  const rollbackPaused = await rollbackEngine.tick(rollbackOwner, () => true)
  assert.equal(rollbackPaused.state.config.enabled, false)
  assert.equal(rollbackPaused.state.attemptedToday, 1)
  assert.match(rollbackPaused.state.pauseReason!, /clock/)
  await rollbackEngine.save(rollbackOwner, rollbackConfig, true, () => true, approved(scaleBoxes.slice(0, 2)))
  await rollbackEngine.tick(rollbackOwner, () => true)
  assert.equal(rollbackSends, 1, 're-enrollment while clock is behind cannot reset prior counters')
  // Real service ownership checks using encrypted authorization-only records.
  // These intentionally omit provider, addresses and credentials; no provider
  // call is possible or required to reject an ineligible enrollment.
  const foreign = { ...owner, memberId: randomUUID(), deviceId: randomUUID() }
  const identityKey = (who: typeof owner) => JSON.stringify({ teamId: who.teamId, memberId: who.memberId, projectId: who.projectId, deviceId: who.deviceId })
  const ids = [randomUUID(), randomUUID()]
  await store.batch(ids.flatMap(id => [{ collection: 'connections', id, value: { id, identity: owner, enabled: true, readInbox: true, mailboxAccess: true } },
    ...[owner, foreign].map(who => ({ collection: 'access', id: createHash('sha256').update(`${identityKey(who)}\n${id}`).digest('hex'),
      value: { connectionId: id, identity: who, manage: true, send: who === foreign, read: true } }))]))
  await store.close()
  service = new MailOAuthService({ dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' })
  await service.ready(); service.startWorkers(() => true)
  const enrollment = { config: { ...config, profileIds: ids }, acknowledge: true, expectedMailboxes: ids.map(id => ({ id, email: `${id}@controlled.invalid` })) }
  await assert.rejects(service.warmup('warmup-save', foreign, enrollment, () => true),
    error => error instanceof MailOAuthError && error.code === 'warmup_owner', 'even a manage/send grant cannot enroll a different credential owner')
  await assert.rejects(service.warmup('warmup-save', owner, enrollment, () => true),
    error => error instanceof MailOAuthError && error.code === 'warmup_owner', 'exact owner still needs actual sending permission')
  await assert.rejects(service.warmup('warmup-tick', owner, {}, () => false),
    error => error instanceof MailOAuthError && error.code === 'unauthorized', 'revoked desktop session cannot enter provider scheduling')
  await service.close()
  assert.ok(previousSends.length === 2)
  console.log('PASS: OAuth warm-up real encrypted storage, claim-before-dispatch, exact consent, scope isolation, forged receipt rejection, finite replies, pacing/quotas/ramp, restart/unknown no-retry, durable verified labels; provider adapter fixtures only, no real mail sent')
} finally { await service?.close().catch(() => undefined); await store.close().catch(() => undefined); rmSync(directory, { recursive: true, force: true }) }
