/** Finite, owner-consented OAuth delivery tests. No timer and no queue worker:
 * only an authenticated desktop tick can cross the provider send boundary. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { MailIdentity } from './mail-oauth-service.js'
import type { MailStore, MailStoreRecord } from './mail-store.js'
import { getMailWarmupTemplate, getMailWarmupTemplateForJob } from './mail-warmup-templates.js'
import { readMailRetentionPolicy, mailRetentionPolicyCheck } from './mail-retention.js'

export interface OAuthWarmupConfig {
  enabled: boolean; profileIds: string[]; startDailyLimit: number; dailyIncrement: number; maxDailyLimit: number
  minIntervalMinutes: number; replyDelayMinutes: number; maxExchanges: number
}
export const DEFAULT_OAUTH_WARMUP_CONFIG: OAuthWarmupConfig = {
  enabled: false, profileIds: [], startDailyLimit: 2, dailyIncrement: 1, maxDailyLimit: 20,
  minIntervalMinutes: 30, replyDelayMinutes: 30, maxExchanges: 3,
}
export interface WarmupMailbox { id: string; provider: 'google' | 'microsoft'; email: string; fingerprint: string }
export interface OAuthWarmupJob {
  id: string; fromProfileId: string; toProfileId: string; from: string; to: string; exchange: number
  token: string; rfcId: string; subject: string; text: string; inReplyTo?: string; templateId?: string
  status: 'queued' | 'dispatching' | 'accepted' | 'accepted_paused' | 'received' | 'unknown' | 'failed' | 'cancelled'
  dueAt: number; sentAt: number | null; receivedAt: number | null; checkedAt: number
  receiptId?: string; providerMessageId?: string; labelled?: boolean; error: string | null
}
export interface WarmupReceipt { id: string; rfcId: string; from: string; to: string[]; subject: string; text: string }
export interface OAuthWarmupAdapter {
  /** Requires the exact credential owner/device/project, enabled send/read and full mailbox consent. */
  mailboxes(owner: MailIdentity, ids: string[], current: () => boolean): Promise<WarmupMailbox[]>
  /** Captures synchronous connection consent fences for both endpoints. */
  fence(ids: string[], current: () => boolean): () => boolean
  /** One attempt only. A durable dispatch claim is committed before this is called. */
  send(owner: MailIdentity, from: WarmupMailbox, job: OAuthWarmupJob, current: () => boolean): Promise<{ status: 'accepted' | 'failed' | 'unknown'; providerMessageId?: string }>
  /** Actual provider read; no renderer-provided fields can attest receipt. */
  receipt(owner: MailIdentity, recipient: WarmupMailbox, job: OAuthWarmupJob, current: () => boolean): Promise<WarmupReceipt | null>
}
interface Program {
  version: 1; owner: MailIdentity; config: OAuthWarmupConfig; consent: string; fingerprints: Record<string, string>
  startedAt: number | null; day: number; outgoing: Record<string, number>; incoming: Record<string, number>
  lastSent: Record<string, number>; nextSender: number; jobs: OAuthWarmupJob[]; pauseReason: string | null
}
type BudgetRow = [email: string, outgoing: number, incoming: number, lastSent: number]
type StoredProgram = Omit<Program, 'version' | 'jobs' | 'outgoing' | 'incoming' | 'lastSent'> & { version: 2; jobPages: number; budgetPages: number; jobCount: number; budgetCount: number }
const PAGE_SIZE = 25
const MAX_JOBS = 550 // One active conversation per pair, plus 50 recent jobs.
const MAX_BUDGET_MAILBOXES = 5_000 // Retain same-day budgets across explicit re-enrollment.
const MAX_HISTORY = 1_000_000
const HISTORY_EPOCH = 8_640_000_000_000_000
const mayExpire = (job: OAuthWarmupJob) => ['received', 'failed', 'cancelled'].includes(job.status)
const jobTime = (job: OAuthWarmupJob) => Math.max(job.dueAt, job.sentAt ?? 0, job.receivedAt ?? 0)
const publicJob = (job: OAuthWarmupJob) => ({ id: job.id, fromProfileId: job.fromProfileId, toProfileId: job.toProfileId,
  exchange: job.exchange, status: job.status, dueAt: job.dueAt, sentAt: job.sentAt, receivedAt: job.receivedAt, error: job.error })
export class OAuthWarmupError extends Error {
  constructor(message: string) { super(message); this.name = 'OAuthWarmupError' }
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const scope = (owner: MailIdentity) => JSON.stringify([owner.teamId, owner.memberId, owner.projectId, owner.deviceId])
const active = (job: OAuthWarmupJob) => ['queued', 'dispatching', 'accepted'].includes(job.status)
const check = (current: () => boolean) => { if (!current()) throw new OAuthWarmupError('Mail connection or project changed. Refresh before continuing.') }
export function parseOAuthWarmupConfig(raw: unknown): OAuthWarmupConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OAuthWarmupError('Invalid automated mail test settings')
  const value = raw as Record<string, unknown>
  if (typeof value.enabled !== 'boolean') throw new OAuthWarmupError('Enable must be true or false')
  if (!Array.isArray(value.profileIds) || value.profileIds.length > 1000 || value.profileIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))
    || new Set(value.profileIds).size !== value.profileIds.length) throw new OAuthWarmupError('Choose distinct mail profiles (maximum 1,000)')
  const integer = (key: string, min: number, max: number) => {
    const n = value[key]
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) throw new OAuthWarmupError(`${key} must be a whole number from ${min} to ${max}`)
    return n
  }
  const config: OAuthWarmupConfig = { enabled: value.enabled, profileIds: [...value.profileIds] as string[],
    startDailyLimit: integer('startDailyLimit', 1, 100), dailyIncrement: integer('dailyIncrement', 0, 20), maxDailyLimit: integer('maxDailyLimit', 1, 100),
    minIntervalMinutes: integer('minIntervalMinutes', 5, 1440), replyDelayMinutes: integer('replyDelayMinutes', 5, 1440), maxExchanges: integer('maxExchanges', 1, 6) }
  if (config.startDailyLimit > config.maxDailyLimit) throw new OAuthWarmupError('Starting daily limit cannot exceed the maximum')
  if (config.enabled && config.profileIds.length < 2) throw new OAuthWarmupError('Enroll at least two mail profiles you control')
  return config
}
function approvedMailboxSnapshot(raw: unknown, ids: string[]): Map<string, string> {
  if (!Array.isArray(raw) || raw.length !== ids.length || raw.length > 1000) throw new OAuthWarmupError('Refresh and explicitly approve the exact mailbox addresses before enabling tests.')
  const expected = new Map<string, string>()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(entry.id)
      || expected.has(entry.id) || !ids.includes(entry.id) || typeof entry.email !== 'string' || !entry.email.trim() || entry.email.length > 320 || /[\u0000-\u001f\u007f]/.test(entry.email)) throw new OAuthWarmupError('The approved mailbox addresses are invalid. Refresh and approve the exact accounts again.')
    expected.set(entry.id, entry.email.trim().toLowerCase())
  }
  return expected
}
export function verifiedWarmupReceipt(job: OAuthWarmupJob, receipt: WarmupReceipt): boolean {
  return !!receipt.id && receipt.rfcId === job.rfcId && receipt.from.trim().toLowerCase() === job.from.toLowerCase()
    && receipt.to.some(address => address.trim().toLowerCase() === job.to.toLowerCase())
    && receipt.subject === job.subject && receipt.text.includes(`Test reference: ${job.token}`)
}
function empty(owner: MailIdentity, now: number): Program {
  return { version: 1, owner: { ...owner }, config: { ...DEFAULT_OAUTH_WARMUP_CONFIG, profileIds: [] }, consent: randomUUID(), fingerprints: {},
    startedAt: null, day: Math.floor(now / 86_400_000), outgoing: {}, incoming: {}, lastSent: {}, nextSender: 0, jobs: [], pauseReason: null }
}
function pause(program: Program, reason: string) {
  program.config.enabled = false; program.pauseReason = reason; program.consent = randomUUID()
  for (const job of program.jobs) {
    if (job.status === 'queued') { job.status = 'cancelled'; job.error = reason }
    if (job.status === 'dispatching') { job.status = 'unknown'; job.error = 'A delivery had already started; inspect Sent mail. No automatic resend.' }
    if (job.status === 'accepted') { job.status = 'accepted_paused'; job.error = 'Provider accepted this test. Further automatic receipt checks and replies stopped.' }
  }
}
function view(program: Program, now: number) {
  const limit = Math.min(program.config.maxDailyLimit, program.config.startDailyLimit + Math.max(0, Math.floor((now - (program.startedAt ?? now)) / 86_400_000)) * program.config.dailyIncrement)
  return { config: program.config, startedAt: program.startedAt, todayLimitPerAccount: limit,
    attemptedToday: program.day >= Math.floor(now / 86_400_000) ? Object.values(program.outgoing).reduce((sum, n) => sum + n, 0) : 0,
    queued: program.jobs.filter(job => job.status === 'queued').length, awaitingReceipt: program.jobs.filter(job => job.status === 'accepted').length,
    pauseReason: program.pauseReason, jobs: program.jobs.slice(-50).reverse().map(publicJob) }
}

export class OAuthMailWarmup {
  private readonly running = new Set<string>()
  private readonly epochs = new Map<string, object>()
  private readonly snapshots = new WeakMap<MailStoreRecord<Program>, Map<string, string>>()
  constructor(private readonly store: MailStore, private readonly adapter: OAuthWarmupAdapter, private readonly now = () => Date.now()) {}
  private key(owner: MailIdentity) { return hash(scope(owner)) }
  private historyId(owner: MailIdentity, job: OAuthWarmupJob) {
    if (!Number.isSafeInteger(job.dueAt) || job.dueAt < 0 || job.dueAt > HISTORY_EPOCH || !/^[a-zA-Z0-9_-]{1,64}$/.test(job.id)) throw new OAuthWarmupError('Invalid retained mail test identity.')
    return `${this.key(owner)}:${String(HISTORY_EPOCH - job.dueAt).padStart(16, '0')}:${job.id}`
  }
  private async read(owner: MailIdentity) {
    const key = this.key(owner), row = await this.store.get<Program | StoredProgram>('warmup-programs', key)
    if (!row) return null
    if (scope(row.value.owner) !== scope(owner)) throw new OAuthWarmupError('Automated test storage is invalid.')
    if (row.value.version === 1) return row as MailStoreRecord<Program> // Migrate atomically on the next write.
    if (row.value.version !== 2 || !Number.isSafeInteger(row.value.jobPages) || row.value.jobPages < 0 || row.value.jobPages > Math.ceil(MAX_JOBS / PAGE_SIZE)
      || !Number.isSafeInteger(row.value.budgetPages) || row.value.budgetPages < 0 || row.value.budgetPages > Math.ceil(MAX_BUDGET_MAILBOXES / PAGE_SIZE)
      || !Number.isSafeInteger(row.value.jobCount) || row.value.jobCount < 0 || row.value.jobCount > MAX_JOBS || Math.ceil(row.value.jobCount / PAGE_SIZE) !== row.value.jobPages
      || !Number.isSafeInteger(row.value.budgetCount) || row.value.budgetCount < 0 || row.value.budgetCount > MAX_BUDGET_MAILBOXES || Math.ceil(row.value.budgetCount / PAGE_SIZE) !== row.value.budgetPages) throw new OAuthWarmupError('Automated test storage is invalid.')
    const stored = row.value, snapshots = new Map<string, string>()
    const jobs: OAuthWarmupJob[] = [], budgets: BudgetRow[] = []
    for (const [kind, count] of [['jobs', stored.jobPages], ['budgets', stored.budgetPages]] as const) {
      // Sequential bounded pages avoid monopolizing the encrypted worker queue.
      for (let index = 0; index < count; index++) {
        const id = `${key}:${kind}:${index}`, page = await this.store.get<unknown[]>('warmup-pages', id)
        const total = kind === 'jobs' ? stored.jobCount : stored.budgetCount
        if (!page || !Array.isArray(page.value) || page.value.length !== Math.min(PAGE_SIZE, total - index * PAGE_SIZE)) throw new OAuthWarmupError('Automated test storage is incomplete. Refresh before continuing.')
        snapshots.set(id, JSON.stringify(page.value))
        if (kind === 'jobs') jobs.push(...page.value as OAuthWarmupJob[])
        else budgets.push(...page.value as BudgetRow[])
      }
    }
    // All pages and the header commit in the same transaction. A concurrent
    // writer may run between individual reads, so never expose a mixed view.
    if ((await this.store.get('warmup-programs', key))?.revision !== row.revision) throw new OAuthWarmupError('Automated test state changed. Refresh and try again.')
    const { jobPages: _jobPages, budgetPages: _budgetPages, jobCount: _jobCount, budgetCount: _budgetCount, ...header } = stored
    const value: Program = { ...header, version: 1, jobs, outgoing: {}, incoming: {}, lastSent: {} }
    for (const [email, outgoing, incoming, lastSent] of budgets) {
      if (outgoing) value.outgoing[email] = outgoing
      if (incoming) value.incoming[email] = incoming
      if (lastSent) value.lastSent[email] = lastSent
    }
    const result = { ...row, value }
    this.snapshots.set(result, snapshots)
    return result
  }
  private async write(owner: MailIdentity, value: Program, row: MailStoreRecord<Program> | null, current: () => boolean) {
    check(current)
    const labels = value.jobs.filter(job => job.status === 'received' && job.receiptId && !job.labelled).slice(0, 50).flatMap(job => {
      job.labelled = true
      return [{ connectionId: job.toProfileId, messageId: job.receiptId! },
        ...(job.providerMessageId ? [{ connectionId: job.fromProfileId, messageId: job.providerMessageId }] : [])].map(link => ({
        collection: 'warmup-labels', id: hash(JSON.stringify([scope(owner), link.connectionId, link.messageId])), owner: scope(owner),
        value: { ...link, jobId: job.id, receivedAt: job.receivedAt },
      }))
    })
    const policy = await readMailRetentionPolicy(this.store, owner)
    check(current)
    const retentionNow = this.now()
    const cutoff = policy.retentionDays > 0 && policy.approvedAt !== null && Number.isSafeInteger(retentionNow) && retentionNow >= policy.approvedAt
      ? retentionNow - policy.retentionDays * 86_400_000 : null
    const archiveSize = await this.store.count('warmup-history')
    const expired: Array<MailStoreRecord<OAuthWarmupJob>> = []
    if (cutoff !== null && cutoff >= 0) {
      for (const status of ['received', 'failed', 'cancelled']) {
        if (expired.length >= 50) break
        expired.push(...await this.store.list<OAuthWarmupJob>('warmup-history', { owner: scope(owner), status, dueBefore: cutoff, limit: 50 - expired.length }))
      }
    }
    check(current)
    // Terminal history is retained indefinitely by default. Explicitly approved
    // expiry never touches active/uncertain jobs or the durable receipt labels.
    if (cutoff !== null) value.jobs = value.jobs.filter(job => !mayExpire(job) || jobTime(job) > cutoff || (job.status === 'received' && !job.labelled))
    const terminal = value.jobs.filter(job => !active(job))
    const recent = new Set(terminal.slice(-50).map(job => job.id))
    const archives = terminal.filter(job => !recent.has(job.id) && (job.status !== 'received' || job.labelled))
      .slice(0, Math.min(100, Math.max(0, MAX_HISTORY - archiveSize + expired.length)))
    const archived = new Set(archives.map(job => job.id))
    value.jobs = value.jobs.filter(job => !archived.has(job.id))
    const { jobs, outgoing, incoming, lastSent, ...header } = value
    const emails = [...new Set([...Object.keys(outgoing), ...Object.keys(incoming), ...Object.keys(lastSent)])].sort()
    if (jobs.length > MAX_JOBS || emails.length > MAX_BUDGET_MAILBOXES) throw new OAuthWarmupError('Automated test storage limit reached. Pause and review retained mailbox budgets.')
    const budgets: BudgetRow[] = emails.map(email => [email, outgoing[email] ?? 0, incoming[email] ?? 0, lastSent[email] ?? 0])
    const key = this.key(owner), previous = row ? this.snapshots.get(row) ?? new Map<string, string>() : new Map<string, string>()
    const pages = new Map<string, OAuthWarmupJob[] | BudgetRow[]>()
    for (const [kind, entries] of [['jobs', jobs], ['budgets', budgets]] as const) {
      for (let index = 0; index < entries.length; index += PAGE_SIZE) pages.set(`${key}:${kind}:${index / PAGE_SIZE}`, entries.slice(index, index + PAGE_SIZE))
    }
    const stored: StoredProgram = { ...header, version: 2, jobPages: Math.ceil(jobs.length / PAGE_SIZE), budgetPages: Math.ceil(budgets.length / PAGE_SIZE), jobCount: jobs.length, budgetCount: budgets.length }
    // Per-page records keep 1,000-account active pools below the encrypted
    // store's 256 KiB row limit. Only changed pages are rewritten; the header
    // CAS atomically covers every page, quota and receipt label.
    const pageWrites = [...pages].filter(([id, entries]) => previous.get(id) !== JSON.stringify(entries)).map(([id, entries]) => ({ collection: 'warmup-pages', id, value: entries, owner: scope(owner) }))
    const pageDeletes = [...previous.keys()].filter(id => !pages.has(id)).map(id => ({ collection: 'warmup-pages', id, delete: true }))
    const archiveWrites = archives.map(job => ({ collection: 'warmup-history', id: this.historyId(owner, job), value: job,
      owner: scope(owner), status: job.status, due: jobTime(job) }))
    if (!await this.store.batch([{ collection: 'warmup-programs', id: key, value: stored, owner: scope(owner) }, ...pageWrites, ...pageDeletes, ...labels,
      ...archiveWrites, ...expired.map(entry => ({ collection: 'warmup-history', id: entry.id, delete: true }))],
      { checks: [{ collection: 'warmup-programs', id: this.key(owner), revision: row?.revision ?? null }, mailRetentionPolicyCheck(owner, policy.revision),
          ...archiveWrites.map(entry => ({ collection: entry.collection, id: entry.id, revision: null })),
          ...expired.map(entry => ({ collection: 'warmup-history', id: entry.id, revision: entry.revision }))],
        limits: [{ collection: 'warmup-labels', max: 1_000_000 }, { collection: 'warmup-history', max: MAX_HISTORY }] })) throw new OAuthWarmupError('Automated test state or retention policy changed, or retained history storage is full. Refresh and review storage; no history was silently discarded.')
    check(current)
  }
  async get(owner: MailIdentity, current: () => boolean) {
    check(current); const row = await this.read(owner); check(current)
    return { state: view(row?.value ?? empty(owner, this.now()), this.now()) }
  }
  async history(owner: MailIdentity, args: { after?: string; limit?: number }, current: () => boolean) {
    check(current)
    const limit = args.limit ?? 50
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new OAuthWarmupError('History page size must be from 1 to 100.')
    let after: string | undefined
    if (args.after !== undefined) {
      if (typeof args.after !== 'string' || args.after.length > 300 || !/^[A-Za-z0-9_-]+$/.test(args.after)) throw new OAuthWarmupError('Invalid mail test history cursor.')
      after = Buffer.from(args.after, 'base64url').toString('utf8')
      if (!new RegExp(`^${this.key(owner)}:[0-9]{16}:[a-zA-Z0-9_-]{1,64}$`).test(after)) throw new OAuthWarmupError('Mail test history cursor belongs to a different scope or is invalid.')
    }
    const row = await this.read(owner)
    const archived = await this.store.list<OAuthWarmupJob>('warmup-history', { owner: scope(owner), ...(after ? { after } : {}), limit: limit + 1 })
    check(current)
    if ((await this.store.get('warmup-programs', this.key(owner)))?.revision !== row?.revision) throw new OAuthWarmupError('Mail test history changed while loading. Refresh and try again.')
    const all = [...archived, ...(row?.value.jobs ?? []).map(job => ({ id: this.historyId(owner, job), revision: 0, value: job }))]
      .filter(entry => !after || entry.id > after).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    const unique = [...new Map(all.map(entry => [entry.id, entry])).values()]
    const selected = unique.slice(0, limit), hasMore = unique.length > limit
    check(current)
    return { jobs: selected.map(entry => publicJob(entry.value)), hasMore,
      ...(hasMore && selected.length ? { nextCursor: Buffer.from(selected[selected.length - 1].id).toString('base64url') } : {}) }
  }
  async save(owner: MailIdentity, raw: unknown, acknowledge: unknown, current: () => boolean, expectedMailboxes?: unknown) {
    check(current)
    const config = parseOAuthWarmupConfig(raw)
    if (typeof acknowledge !== 'boolean' || (config.enabled && !acknowledge)) throw new OAuthWarmupError('Confirm exact mailbox ownership and consent before enabling or changing active tests.')
    const approved = config.enabled ? approvedMailboxSnapshot(expectedMailboxes, config.profileIds) : null
    const key = this.key(owner), epoch = {}
    this.epochs.set(key, epoch)
    const live = this.adapter.fence(config.profileIds, () => current() && this.epochs.get(key) === epoch)
    const mailboxes = config.enabled ? await this.adapter.mailboxes(owner, config.profileIds, live) : []
    check(live)
    if (config.enabled && (mailboxes.length !== config.profileIds.length || new Set(mailboxes.map(box => box.email.toLowerCase())).size !== mailboxes.length)) throw new OAuthWarmupError('Enroll distinct enabled mailboxes owned by this exact account, project and device.')
    if (approved && mailboxes.some(box => approved.get(box.id) !== box.email.trim().toLowerCase())) throw new OAuthWarmupError('Mailbox addresses changed after approval. Refresh and explicitly approve the new accounts.')
    const row = await this.read(owner), program = row?.value ?? empty(owner, this.now())
    // Saving cannot erase uncertain claims, daily attempts, or pacing.
    for (const job of program.jobs) {
      if (job.status === 'dispatching') { job.status = 'unknown'; job.error = 'Previous dispatch outcome is uncertain; no automatic resend.' }
      if (job.status === 'queued') { job.status = 'cancelled'; job.error = 'Consent settings changed.' }
      if (job.status === 'accepted') { job.status = 'accepted_paused'; job.error = 'Previously accepted test. Changed consent does not authorize further replies.' }
    }
    program.config = config; program.consent = randomUUID(); program.pauseReason = null
    program.fingerprints = Object.fromEntries(mailboxes.map(box => [box.id, box.fingerprint]))
    if (config.enabled && program.startedAt === null) program.startedAt = this.now()
    await this.write(owner, program, row, live)
    return { state: view(program, this.now()) }
  }
  async pause(owner: MailIdentity, current: () => boolean) {
    check(current)
    const key = this.key(owner), epoch = {}
    this.epochs.set(key, epoch)
    const live = () => current() && this.epochs.get(key) === epoch
    const row = await this.read(owner), program = row?.value ?? empty(owner, this.now())
    pause(program, 'Paused by the mailbox owner. Already submitted mail cannot be recalled.')
    await this.write(owner, program, row, live)
    return { state: view(program, this.now()) }
  }
  async verifiedIds(owner: MailIdentity, connectionId: string, messageIds: string[]): Promise<Set<string>> {
    if (messageIds.length > 100) throw new OAuthWarmupError('Mail label page is too large.')
    const links = await Promise.all(messageIds.map(async messageId => {
      const row = await this.store.get<{ connectionId: string; messageId: string }>('warmup-labels', hash(JSON.stringify([scope(owner), connectionId, messageId])))
      return row?.value.connectionId === connectionId && row.value.messageId === messageId ? messageId : ''
    }))
    return new Set(links.filter(Boolean))
  }
  async tick(owner: MailIdentity, authorized: () => boolean) {
    check(authorized)
    const key = this.key(owner)
    if (this.running.has(key)) return this.get(owner, authorized)
    this.running.add(key)
    if (!this.epochs.has(key)) this.epochs.set(key, {})
    const epoch = this.epochs.get(key), current = () => authorized() && this.epochs.get(key) === epoch
    try { return await this.runTick(owner, current) } finally { this.running.delete(key) }
  }
  private async runTick(owner: MailIdentity, current: () => boolean) {
    let row = await this.read(owner), program = row?.value ?? empty(owner, this.now())
    check(current)
    const finish = async () => { await this.write(owner, program, row, current); return { state: view(program, this.now()) } }
    if (!program.config.enabled) return finish()
    if (await this.store.count('warmup-history') >= MAX_HISTORY) {
      pause(program, 'Retained mail test history reached its storage limit. Review storage or explicitly approve a retention policy before scheduling more tests.'); return finish()
    }
    if (program.jobs.some(job => job.status === 'dispatching')) {
      for (const job of program.jobs) if (job.status === 'dispatching') { job.status = 'unknown'; job.error = 'Interrupted dispatch; inspect provider Sent mail. No automatic resend.' }
      pause(program, 'A previous delivery outcome is uncertain. Review Sent mail before explicitly enrolling again.')
      return finish()
    }
    const live = this.adapter.fence(program.config.profileIds, current)
    let mailboxes: WarmupMailbox[]
    try { mailboxes = await this.adapter.mailboxes(owner, program.config.profileIds, live) }
    catch { check(current); pause(program, 'Mailbox ownership, consent, or access changed. Reconnect and explicitly enroll again.'); return finish() }
    check(live)
    if (mailboxes.length !== program.config.profileIds.length || mailboxes.some(box => program.fingerprints[box.id] !== box.fingerprint)) {
      pause(program, 'Mailbox consent changed. Review the exact enrolled accounts and explicitly enroll again.'); return finish()
    }
    const boxes = new Map(mailboxes.map(box => [box.id, box]))
    let now = this.now()
    if (Math.floor(now / 86_400_000) < program.day) {
      pause(program, 'The server clock moved to an earlier UTC day. Correct the clock before explicitly enrolling again. Existing budgets were preserved.'); return finish()
    }
    if (program.jobs.some(job => job.status === 'accepted' && now - (job.sentAt ?? now) >= 86_400_000)) {
      pause(program, 'No verified receipt within 24 hours. Inspect provider delivery and explicitly enroll again.'); return finish()
    }
    const awaiting = program.jobs.filter(job => job.status === 'accepted').sort((a, b) => a.checkedAt - b.checkedAt)[0]
    if (awaiting) {
      let receipt: WarmupReceipt | null
      try { receipt = await this.adapter.receipt(owner, boxes.get(awaiting.toProfileId)!, awaiting, live) }
      catch { check(current); pause(program, 'Provider receipt access failed or changed. Review access and explicitly enroll again.'); return finish() }
      check(live); now = this.now()
      if (Math.floor(now / 86_400_000) < program.day) {
        pause(program, 'The server clock moved to an earlier UTC day. Correct the clock before explicitly enrolling again. Existing budgets were preserved.'); return finish()
      }
      awaiting.checkedAt = now
      if (receipt && verifiedWarmupReceipt(awaiting, receipt)) {
        awaiting.status = 'received'; awaiting.receivedAt = now; awaiting.receiptId = receipt.id
        if (awaiting.exchange < program.config.maxExchanges) program.jobs.push(this.job(boxes.get(awaiting.toProfileId)!, boxes.get(awaiting.fromProfileId)!,
          now + program.config.replyDelayMinutes * 60_000, awaiting))
      }
    }
    if (program.day !== Math.floor(now / 86_400_000)) {
      program.day = Math.floor(now / 86_400_000); program.outgoing = {}; program.incoming = {}
      program.lastSent = Object.fromEntries(Object.entries(program.lastSent).filter(([, sentAt]) => now - sentAt <= 86_400_000))
    }
    const limit = view(program, now).todayLimitPerAccount
    const quotaKey = (id: string) => boxes.get(id)!.email.toLowerCase()
    const eligible = (from: string, to: string) => (program.outgoing[quotaKey(from)] ?? 0) < limit && (program.incoming[quotaKey(to)] ?? 0) < limit
      && (!program.lastSent[quotaKey(from)] || now - program.lastSent[quotaKey(from)] >= program.config.minIntervalMinutes * 60_000)
    let job = program.jobs.find(job => job.status === 'queued' && job.dueAt <= now && eligible(job.fromProfileId, job.toProfileId))
    if (!job) {
      const occupied = new Set(program.jobs.filter(active).flatMap(job => [job.fromProfileId, job.toProfileId]))
      const ids = program.config.profileIds
      for (let offset = 0; offset < ids.length && !job; offset++) {
        const index = (program.nextSender + offset) % ids.length, from = ids[index]
        if (occupied.has(from)) continue
        const to = ids.find((other, n) => n !== index && !occupied.has(other) && eligible(from, other))
        if (to) { job = this.job(boxes.get(from)!, boxes.get(to)!, now); program.jobs.push(job); program.nextSender = (index + 1) % ids.length }
      }
    }
    if (!job) return finish()
    check(live)
    job.status = 'dispatching'; job.sentAt = now
    program.outgoing[quotaKey(job.fromProfileId)] = (program.outgoing[quotaKey(job.fromProfileId)] ?? 0) + 1
    program.incoming[quotaKey(job.toProfileId)] = (program.incoming[quotaKey(job.toProfileId)] ?? 0) + 1
    program.lastSent[quotaKey(job.fromProfileId)] = now
    // Durable claim and both endpoint quotas precede provider access. A crash
    // after this write is always uncertain and can never be automatically sent again.
    await this.write(owner, program, row, live)
    row = await this.read(owner)
    check(live)
    if (!row || row.value.consent !== program.consent) throw new OAuthWarmupError('Mailbox test consent changed before dispatch.')
    let result: Awaited<ReturnType<OAuthWarmupAdapter['send']>>
    try { result = await this.adapter.send(owner, boxes.get(job.fromProfileId)!, job, live) }
    catch { result = { status: 'unknown' } }
    // Even if a pause invalidates current(), never restore the old enabled
    // program. Its durable dispatch claim remains visible for recovery.
    check(current)
    job.status = result.status; job.providerMessageId = result.providerMessageId
    if (result.status !== 'accepted') {
      job.error = result.status === 'unknown' ? 'Delivery is uncertain; no automatic resend.' : 'Provider declined the test; no automatic retry.'
      pause(program, job.error)
    }
    return finish()
  }
  private job(from: WarmupMailbox, to: WarmupMailbox, dueAt: number, parent?: OAuthWarmupJob): OAuthWarmupJob {
    const id = randomUUID(), token = randomBytes(32).toString('base64url')
    const template = (parent?.templateId ? getMailWarmupTemplate(parent.templateId) : undefined)
      ?? getMailWarmupTemplateForJob(parent?.id ?? id)
    return { id, fromProfileId: from.id, toProfileId: to.id, from: from.email, to: to.email, exchange: (parent?.exchange ?? 0) + 1,
      token, rfcId: `<${id}@warmup.vaid.invalid>`, subject: parent?.subject ?? template.subject, templateId: template.id,
      text: `${parent ? template.reply : template.message}\n\nTest reference: ${token}\nExchange ${(parent?.exchange ?? 0) + 1}.\n`,
      ...(parent ? { inReplyTo: parent.rfcId } : {}), status: 'queued', dueAt, sentAt: null, receivedAt: null, checkedAt: 0, error: null }
  }
}
