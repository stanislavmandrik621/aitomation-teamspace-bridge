/** STAGED, UNVERIFIED. OAuth/control plane only; this module never contacts a mail provider. */
import { createHash, randomUUID } from 'node:crypto'
import type { MailStore, MailStoreRecord, MailStoreWrite } from './mail-store.js'
import type { MailIdentity, MailSendResult } from './mail-oauth-service.js'
import { mailOutgoingAttachments } from './mail-outgoing-attachments.js'
import { mailboxId } from './mail-provider-mailbox.js'
import type { MailEndpointIdentityReceipt } from './mail-native-endpoint-identity.js'

const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const ownerKey = (owner: MailIdentity) => JSON.stringify({ teamId: owner.teamId, memberId: owner.memberId, projectId: owner.projectId, deviceId: owner.deviceId })
export interface NativeMailAuthority { version: 1; accessEpoch: string; enabledAt: number; readyAt: number }
export interface NativeMailbox {
  id: string; identity: MailIdentity; provider: 'google' | 'microsoft'; email: string; accountId: string; registration: string;
  readInbox: boolean; mailboxAccess?: boolean; createdAt: string; enabled?: boolean; warmupConsentId?: string; nativeExecution?: NativeMailAuthority; token?: { scopes?: string[]; identityReceipt?: MailEndpointIdentityReceipt }
  capabilityEvidence?: { accountType: 'personal' | 'work'; accountTypeSource: 'provider_identity'; cloud?: 'global' | 'usgov' | 'dod' | 'china'; tenantId?: string }
}
export interface NativeMailAccess { connectionId: string; identity: MailIdentity; send: boolean; read: boolean; manage: boolean }
export interface NativeMailHandoff {
  protocol: 1; claimId: string; localAttemptId: string; generation: string; accessEpoch: string; account: string;
  payloadDigest: string; phase: 'claimed' | 'begun' | 'complete'; claimedAt: number; begunAt?: number;
  dispatchPermitHash?: string; completion?: 'accepted' | 'rejected' | 'unknown'
}
export interface NativeLegacyMailJob extends MailSendResult {
  jobId: string; actor: MailIdentity; connectionId: string; account: string; digest: string;
  to: string[]; cc?: string[]; subject: string; text?: string; attachments?: unknown; replyToMessageId?: string; replyRecordId?: string; replyTarget?: unknown;
  createdAt: number; due: number; attempts: number; completedAt?: number; error?: string; nativeDelivery?: NativeMailHandoff
}
export interface NativeMailLocator { connectionId: string; idempotencyKey: string; jobId?: string }
export interface NativeMailFence { expectedGeneration: string; accessEpoch: string }
export interface NativeMailClaimInput extends NativeMailLocator, NativeMailFence { localAttemptId: string }
export interface NativeMailBeginInput extends NativeMailClaimInput { jobId: string; claimId: string; payloadDigest: string }
export interface NativeMailCompleteInput extends NativeMailBeginInput { dispatchPermit: string; status: 'accepted' | 'rejected' | 'unknown'; providerMessageId?: string }
export interface NativeMailCancelInput extends NativeMailLocator, NativeMailFence { claimId?: string }
type Snapshot<C> = { record: MailStoreRecord<C>; access: MailStoreRecord<NativeMailAccess> }
interface Ports<C extends NativeMailbox> {
  store: Pick<MailStore, 'get' | 'batch'>;
  snapshot(owner: MailIdentity, connectionId: string, current: () => boolean, permission?: 'send' | 'manage'): Promise<Snapshot<C>>;
  assertAuthorized(current: () => boolean): void;
  changeAuthority(connectionId: string): void;
  jobWrite(job: NativeLegacyMailJob): MailStoreWrite;
  now?: () => number;
}
export class NativeMailControlError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); this.name = 'NativeMailControlError' }
}
function deny(code: string, message: string): never { throw new NativeMailControlError(code, message) }
function text(value: unknown, max = 160): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u0020\u007f]/.test(value)) deny('native_mail_binding', 'Invalid native mail binding.')
  return value
}
export const nativeMailAccount = (c: NativeMailbox) => sha(JSON.stringify([c.registration, c.accountId]))
export function nativeMailEvidence(c: NativeMailbox): NativeMailbox['capabilityEvidence'] {
  const receipt = c.token?.identityReceipt
  if (receipt && receipt.provider === c.provider && receipt.providerAccountId === c.accountId) return { accountType: receipt.accountType, accountTypeSource: 'provider_identity',
    ...(receipt.cloud ? { cloud: receipt.cloud } : {}), ...(receipt.tenantId ? { tenantId: receipt.tenantId } : {}) }
  if (receipt) return undefined
  return c.capabilityEvidence
}
export const nativeMailGeneration = (c: NativeMailbox) => sha(JSON.stringify([ownerKey(c.identity), c.id, c.provider, nativeMailAccount(c), c.registration, c.warmupConsentId ?? 'legacy', c.readInbox, c.mailboxAccess === true, nativeMailEvidence(c) ?? null]))
/** Byte-for-byte legacy send() digest order, including attachment canonicalization.
 * Callers compare this before importing an exact previous request key. */
export function nativeLegacyPayloadDigest(args: { to: string[]; cc?: string[]; subject: string; text: string; replyToMessageId?: string; replyRecordId?: string; attachments?: unknown }) {
  const attachments = mailOutgoingAttachments(args.attachments), cc = args.cc ?? []
  const reply = args.replyToMessageId === undefined ? undefined : mailboxId(args.replyToMessageId)
  return sha(JSON.stringify({ to: [...new Set(args.to)], ...(cc.length ? { cc: [...new Set(cc.map(address => address.toLowerCase()))] } : {}), subject: args.subject, text: args.text,
    ...(reply ? { replyToMessageId: reply } : {}), ...(args.replyRecordId ? { replyRecordId: args.replyRecordId } : {}), ...(attachments.length ? { attachments } : {}) }))
}
export function nativeMailMetadata(c: NativeMailbox) {
  return { generation: nativeMailGeneration(c), accountBinding: nativeMailAccount(c), execution: c.nativeExecution ? 'native' as const : 'server' as const,
    ...(c.nativeExecution ? { accessEpoch: c.nativeExecution.accessEpoch, readyAt: c.nativeExecution.readyAt, deliveryMode: 'native-app' as const, nativeOutboxProtocol: 1, deliveryRequiresApp: true } : {}) }
}

/** Execution transitions compare connection, access and job revisions in the
 * SAME SQLite transaction. Receipt-only completion instead binds the immutable
 * begun actor/claim/permit so revocation cannot erase accepted evidence. No
 * lease timeout proves unsent or returns a claimed job to the server worker. */
export class NativeMailControl<C extends NativeMailbox> {
  private readonly now: () => number
  constructor(private readonly ports: Ports<C>) { this.now = ports.now ?? Date.now }
  private checks(snapshot: Snapshot<C>) {
    return [{ collection: 'connections', id: snapshot.record.id, revision: snapshot.record.revision }, { collection: 'access', id: snapshot.access.id, revision: snapshot.access.revision }]
  }
  private async ownerSnapshot(owner: MailIdentity, id: string, current: () => boolean) {
    text(id); this.ports.assertAuthorized(current)
    const snapshot = await this.ports.snapshot(owner, id, current, 'manage'), c = snapshot.record.value
    if (ownerKey(c.identity) !== ownerKey(owner) || ownerKey(snapshot.access.value.identity) !== ownerKey(owner)
      || snapshot.access.value.connectionId !== id || !snapshot.access.value.manage || !snapshot.access.value.send)
      deny('native_mail_owner_required', 'Native mail credentials require this mailbox owner, project and device. Connect your own mailbox to use native delivery.')
    this.ports.assertAuthorized(current)
    return snapshot
  }
  private async actorSnapshot(owner: MailIdentity, id: string, current: () => boolean) {
    text(id); this.ports.assertAuthorized(current)
    const snapshot = await this.ports.snapshot(owner, id, current, 'send')
    if (snapshot.access.value.connectionId !== id || ownerKey(snapshot.access.value.identity) !== ownerKey(owner) || !snapshot.access.value.send)
      deny('native_mail_actor_required', 'This earlier message requires its exact current sender permission, project and device.')
    this.ports.assertAuthorized(current)
    return snapshot
  }
  private async nativeSnapshot(owner: MailIdentity, input: NativeMailLocator & NativeMailFence, current: () => boolean, ready = false, ownerOnly = true) {
    const snapshot = ownerOnly ? await this.ownerSnapshot(owner, input.connectionId, current) : await this.actorSnapshot(owner, input.connectionId, current), c = snapshot.record.value
    if (!c.nativeExecution || nativeMailGeneration(c) !== text(input.expectedGeneration, 128) || c.nativeExecution.accessEpoch !== text(input.accessEpoch, 128))
      deny('native_mail_changed', 'This mailbox or its native authority changed. Refresh and review again.')
    if (ownerOnly && c.enabled === false) deny('native_mail_paused', 'This mailbox is paused.')
    if (ready && c.nativeExecution.readyAt > this.now()) deny('native_mail_quiescing', 'Earlier server operations are finishing. Native delivery is held until the execution fence is ready.')
    return snapshot
  }
  async status(owner: MailIdentity, connectionId: string, current: () => boolean) {
    const snapshot = await this.ownerSnapshot(owner, connectionId, current)
    return this.statusResult(snapshot.record.value, snapshot.access.value)
  }
  private statusResult(c: C, access: NativeMailAccess) {
    const evidence = nativeMailEvidence(c)
    return { ok: true, nativeOutboxProtocol: 1, legacyHandoffProtocol: 1, ownerOnly: true,
      ...(c.nativeExecution ? { readyAt: c.nativeExecution.readyAt, deliveryMode: 'native-app' as const, deliveryRequiresApp: true } : {}),
      connection: { id: c.id, provider: c.provider, email: c.email, createdAt: c.createdAt, readInbox: c.readInbox, mailboxAccess: c.mailboxAccess === true, enabled: c.enabled !== false,
        canRead: access.read && c.readInbox, canManage: access.manage, canSend: access.send, nativeSendEligible: true,
        accountType: evidence?.accountType === 'work' ? 'work_school' as const : evidence?.accountType === 'personal' ? 'personal' as const : 'unknown' as const,
        requiresNativeIdentity: !evidence, ...(evidence ? { capabilityEvidence: structuredClone(evidence) } : {}),
        grantedScopes: [...(c.token?.scopes ?? [])], ...nativeMailMetadata(c) } }
  }
  async enable(owner: MailIdentity, connectionId: string, expectedGeneration: string, current: () => boolean) {
    const snapshot = await this.ownerSnapshot(owner, connectionId, current), c = snapshot.record.value
    if (nativeMailGeneration(c) !== text(expectedGeneration, 128)) deny('native_mail_changed', 'This mailbox changed. Refresh before moving execution to the app.')
    if (c.nativeExecution) return this.status(owner, connectionId, current)
    const now = this.now(), updated = { ...c, nativeExecution: { version: 1 as const, accessEpoch: randomUUID(), enabledAt: now, readyAt: now + 60_000 } }
    this.ports.assertAuthorized(current); this.ports.changeAuthority(connectionId)
    if (!await this.ports.store.batch([{ collection: 'connections', id: connectionId, value: updated, owner: ownerKey(c.identity), account: nativeMailAccount(c) }], { checks: this.checks(snapshot) }))
      deny('native_mail_changed', 'This mailbox changed during cutover. Refresh its native execution status.')
    this.ports.assertAuthorized(current)
    return this.statusResult(updated, snapshot.access.value)
  }
  private ids(owner: MailIdentity, locator: NativeMailLocator) {
    text(locator.connectionId); const key = text(locator.idempotencyKey, 128)
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) deny('native_mail_binding', 'Invalid legacy send key.')
    const legacy = sha(`${ownerKey(owner)}\n${locator.connectionId}\n${key}`), time = /^m_(\d{13})_[a-f0-9-]{36}$/.exec(key)
    const newest = time ? `${String(9_999_999_999_999 - Number(time[1])).padStart(13, '0')}_${legacy}` : legacy
    return { legacy, newest }
  }
  private async exactRow(owner: MailIdentity, locator: NativeMailLocator) {
    const { newest, legacy } = this.ids(owner, locator)
    const [recent, older, archived] = await Promise.all([
      this.ports.store.get<NativeLegacyMailJob>('outbox', newest),
      newest !== legacy ? this.ports.store.get<NativeLegacyMailJob>('outbox', legacy) : Promise.resolve(null),
      this.ports.store.get('legacy-sends', legacy),
    ])
    if ([recent, older, archived].filter(Boolean).length > 1) deny('native_mail_history_conflict', 'More than one historical receipt uses this exact send key. Hold the message for reconciliation; do not replay it.')
    const row = recent ?? older
    if (row) {
      const job = row.value
      if (job.jobId !== row.id || job.connectionId !== locator.connectionId || job.idempotencyKey !== locator.idempotencyKey || ownerKey(job.actor) !== ownerKey(owner)
        || locator.jobId !== undefined && locator.jobId !== job.jobId) deny('native_mail_binding', 'The exact legacy message identity did not match.')
    }
    return row
  }
  private async find(owner: MailIdentity, locator: NativeMailLocator, c: C) {
    const row = await this.exactRow(owner, locator), { legacy } = this.ids(owner, locator)
    if (row) {
      if (row.value.account !== nativeMailAccount(c)) deny('native_mail_binding', 'The source credential account changed.')
      return { row, legacy: null }
    }
    const old = await this.ports.store.get<{ connectionId: string; digest: string; result: MailSendResult }>('legacy-sends', legacy)
    if (old && (old.value.connectionId !== c.id || old.value.result.idempotencyKey !== locator.idempotencyKey || locator.jobId !== undefined && locator.jobId !== legacy)) deny('native_mail_binding', 'The exact legacy send history did not match.')
    if (!old && locator.jobId !== undefined) deny('native_mail_not_found', 'This exact earlier outbox item was not found. Do not recreate it under another identity.')
    return { row: null, legacy: old }
  }
  private metadata(job: NativeLegacyMailJob) {
    return { origin: 'legacy-server' as const, jobId: job.jobId, connectionId: job.connectionId, idempotencyKey: job.idempotencyKey, payloadDigest: job.digest, status: job.status,
      heldForNative: ['queued', 'retry_wait'].includes(job.status), ...(job.providerMessageId ? { providerMessageId: job.providerMessageId } : {}),
      ...(job.nativeDelivery ? { claimId: job.nativeDelivery.claimId, localAttemptId: job.nativeDelivery.localAttemptId, handoffPhase: job.nativeDelivery.phase } : {}) }
  }
  async lookup(owner: MailIdentity, input: NativeMailLocator & NativeMailFence, current: () => boolean) {
    const snapshot = await this.nativeSnapshot(owner, input, current, false, false), found = await this.find(owner, input, snapshot.record.value)
    // A CAS read barrier rejects a reconnect/revoke/cutover race after history IO.
    this.ports.assertAuthorized(current)
    if (!await this.ports.store.batch([], { checks: this.checks(snapshot) })) deny('native_mail_changed', 'Mailbox authority changed during legacy reconciliation.')
    this.ports.assertAuthorized(current)
    if (found.row) return { ok: true, matched: true, ...this.metadata(found.row.value), claimable: ownerKey(snapshot.record.value.identity) === ownerKey(owner) && snapshot.access.value.manage && ['queued', 'retry_wait'].includes(found.row.value.status) && (!found.row.value.nativeDelivery || found.row.value.nativeDelivery.phase === 'claimed') }
    if (found.legacy) return { ok: true, matched: true, ...found.legacy.value.result, origin: 'legacy-server' as const, jobId: found.legacy.id, connectionId: input.connectionId, payloadDigest: found.legacy.value.digest, claimable: false }
    // Missing history may have expired. Client key timestamps are not proof:
    // the legacy queue accepted a five-minute future clock window. Only main's
    // durable native-origin identity, created AFTER cutover+ready and never
    // submitted to the server, can authorize a separate new local request.
    return { ok: true, matched: false, absenceProvesUnsent: false, reconciliationRequired: true, connectionId: input.connectionId, idempotencyKey: input.idempotencyKey, checkedAccessEpoch: input.accessEpoch, checkedGeneration: input.expectedGeneration }
  }
  private binding(job: NativeLegacyMailJob, input: NativeMailBeginInput) {
    const handoff = job.nativeDelivery
    if (!handoff || handoff.claimId !== text(input.claimId) || handoff.localAttemptId !== text(input.localAttemptId, 128) || handoff.payloadDigest !== text(input.payloadDigest, 128)
      || job.digest !== input.payloadDigest || handoff.generation !== input.expectedGeneration || handoff.accessEpoch !== input.accessEpoch || handoff.account !== job.account)
      deny('native_mail_binding', 'This exact native handoff identity changed. Nothing may be sent under a replacement claim.')
    return handoff
  }
  private payload(job: NativeLegacyMailJob) {
    return structuredClone({ to: job.to, ...(job.cc ? { cc: job.cc } : {}), subject: job.subject, text: job.text ?? '', ...(job.attachments ? { attachments: job.attachments } : {}),
      ...(job.replyToMessageId ? { replyToMessageId: job.replyToMessageId } : {}), ...(job.replyRecordId ? { replyRecordId: job.replyRecordId } : {}), ...(job.replyTarget ? { replyTarget: job.replyTarget } : {}) })
  }
  async claim(owner: MailIdentity, input: NativeMailClaimInput, current: () => boolean) {
    const snapshot = await this.nativeSnapshot(owner, input, current, true), found = await this.find(owner, input, snapshot.record.value)
    if (!found.row || !['queued', 'retry_wait'].includes(found.row.value.status)) deny('native_mail_not_unsent', 'Only a proved queued or waiting earlier message can be moved. Sent, dispatching and uncertain messages cannot be replayed.')
    const row = found.row, prior = row.value.nativeDelivery, attempt = text(input.localAttemptId, 128)
    if (prior && (prior.localAttemptId !== attempt || prior.phase !== 'claimed')) deny('native_mail_already_claimed', 'This earlier message already belongs to another native attempt. Recover that attempt or review its status.')
    const handoff: NativeMailHandoff = { protocol: 1, claimId: prior?.claimId ?? randomUUID(), localAttemptId: attempt, generation: input.expectedGeneration, accessEpoch: input.accessEpoch,
      account: row.value.account, payloadDigest: row.value.digest, phase: 'claimed', claimedAt: prior?.claimedAt ?? this.now() }
    const job = { ...row.value, nativeDelivery: handoff }
    const payload = this.payload(job)
    if (nativeLegacyPayloadDigest(payload) !== job.digest) deny('native_mail_binding', 'The stored source payload no longer matches its original digest. Sending is held for reconciliation.')
    this.ports.assertAuthorized(current)
    if (!await this.ports.store.batch([this.ports.jobWrite(job)], { checks: [...this.checks(snapshot), { collection: 'outbox', id: row.id, revision: row.revision }] }))
      deny('native_mail_changed', 'The legacy handoff changed. Recover this same local attempt; do not create another one.')
    this.ports.assertAuthorized(current)
    return { ok: true, ...this.metadata(job), generation: handoff.generation, accessEpoch: handoff.accessEpoch, payload }
  }
  async begin(owner: MailIdentity, input: NativeMailBeginInput, current: () => boolean) {
    const snapshot = await this.nativeSnapshot(owner, input, current, true), found = await this.find(owner, input, snapshot.record.value)
    if (!found.row) deny('native_mail_not_found', 'The exact source message is missing. Sending is blocked.')
    const row = found.row, handoff = this.binding(row.value, input)
    // Never reissue a provider dispatch permit, including after a lost begin ACK.
    if (handoff.phase !== 'claimed' || !['queued', 'retry_wait'].includes(row.value.status)) return { ok: true, ...this.metadata(row.value), authorizedToDispatch: false }
    const dispatchPermit = randomUUID(), now = this.now()
    const job: NativeLegacyMailJob = { ...row.value, status: 'dispatching', attempts: row.value.attempts + 1, due: now,
      nativeDelivery: { ...handoff, phase: 'begun', begunAt: now, dispatchPermitHash: sha(dispatchPermit) } }
    this.ports.assertAuthorized(current)
    if (!await this.ports.store.batch([this.ports.jobWrite(job)], { checks: [...this.checks(snapshot), { collection: 'outbox', id: row.id, revision: row.revision }] }))
      deny('native_mail_changed', 'Dispatch authority changed. Do not submit; recover this exact source attempt.')
    this.ports.assertAuthorized(current)
    return { ok: true, ...this.metadata(job), authorizedToDispatch: true, dispatchPermit, dispatchPermitExpiresAt: now + 10_000 }
  }
  async complete(owner: MailIdentity, input: NativeMailCompleteInput, current: () => boolean) {
    // Receipt recording is not execution authorization. A revoked grant,
    // disconnected credential or newly read-only actor must not erase accepted
    // evidence. Require the exact authenticated original actor and begun secret;
    // release no credential/payload and compare only that immutable source row.
    this.ports.assertAuthorized(current)
    const row = await this.exactRow(owner, input)
    if (!row) deny('native_mail_not_found', 'The exact source message is missing. Keep the local receipt.')
    const handoff = this.binding(row.value, input)
    if (!['accepted', 'rejected', 'unknown'].includes(input.status) || handoff.phase === 'claimed' || handoff.dispatchPermitHash !== sha(text(input.dispatchPermit))) deny('native_mail_binding', 'A matching begun dispatch receipt is required.')
    if (input.providerMessageId !== undefined) text(input.providerMessageId, 512)
    if (handoff.phase === 'complete' && handoff.completion !== 'unknown') {
      if (handoff.completion !== input.status || (row.value.providerMessageId ?? '') !== (input.providerMessageId ?? '')) deny('native_mail_receipt_conflict', 'A different definitive receipt is already recorded. Keep both local observations for review.')
      return { ok: true, ...this.metadata(row.value), receiptRecorded: true }
    }
    if (!['dispatching', 'unknown'].includes(row.value.status)) deny('native_mail_not_begun', 'This source message has no matching uncertain dispatch.')
    const now = this.now(), job: NativeLegacyMailJob = { ...row.value, status: input.status, completedAt: now, due: now,
      error: input.status === 'unknown' ? 'Native delivery is uncertain. Check provider Sent mail; no automatic resend.' : undefined,
      ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}), nativeDelivery: { ...handoff, phase: 'complete', completion: input.status } }
    this.ports.assertAuthorized(current)
    if (!await this.ports.store.batch([this.ports.jobWrite(job)], { checks: [{ collection: 'outbox', id: row.id, revision: row.revision }] })) deny('native_mail_changed', 'Receipt storage changed. Retry only this same completion receipt; never send again.')
    this.ports.assertAuthorized(current)
    return { ok: true, ...this.metadata(job), receiptRecorded: true }
  }
  async cancel(owner: MailIdentity, input: NativeMailCancelInput, current: () => boolean) {
    const snapshot = await this.nativeSnapshot(owner, input, current, false, false), found = await this.find(owner, input, snapshot.record.value)
    if (!found.row) deny('native_mail_not_found', 'The exact source message is missing. Cancellation is not proved.')
    const row = found.row, job = row.value
    if (job.nativeDelivery && job.nativeDelivery.claimId !== input.claimId) deny('native_mail_binding', 'Cancellation must name the current source claim.')
    if (job.status === 'cancelled') return { ok: true, ...this.metadata(job), cancellationRecorded: true }
    if (!['queued', 'retry_wait'].includes(job.status) || job.nativeDelivery && job.nativeDelivery.phase !== 'claimed') deny('native_mail_not_unsent', 'A begun, sent or uncertain message cannot be cancelled as unsent.')
    const cancelled = { ...job, status: 'cancelled' as const, completedAt: this.now(), due: this.now() }
    this.ports.assertAuthorized(current)
    if (!await this.ports.store.batch([this.ports.jobWrite(cancelled)], { checks: [...this.checks(snapshot), { collection: 'outbox', id: row.id, revision: row.revision }] })) deny('native_mail_changed', 'Cancellation raced dispatch or another edit. Refresh; cancellation is not proved.')
    this.ports.assertAuthorized(current)
    return { ok: true, ...this.metadata(cancelled), cancellationRecorded: true }
  }
}
