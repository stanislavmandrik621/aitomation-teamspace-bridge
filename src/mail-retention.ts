/** Private mail history retention. No record implies KEEP FOREVER, never
 * inherited approval from legacy expiration timestamps or other owners. */
import { createHash } from 'node:crypto'
import type { MailIdentity } from './mail-oauth-service.js'
import type { MailStore } from './mail-store.js'

export interface MailRetentionPolicy { retentionDays: number; approvedAt: number | null; revision: number }
interface StoredPolicy { version: 1; owner: MailIdentity; retentionDays: number; approvedAt: number | null }
export class MailRetentionError extends Error {
  constructor(message: string) { super(message); this.name = 'MailRetentionError' }
}
const DAY_MS = 86_400_000
export function mailRetentionOwnerKey(owner: MailIdentity): string {
  const value = { teamId: owner?.teamId, memberId: owner?.memberId, projectId: owner?.projectId, deviceId: owner?.deviceId }
  if (Object.values(value).some(part => typeof part !== 'string' || !part || part.length > 256 || /[\u0000-\u001f\u007f]/.test(part))) throw new MailRetentionError('An exact mail owner, project and device are required.')
  return JSON.stringify(value)
}
export function mailRetentionPolicyCheck(owner: MailIdentity, revision: number) {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new MailRetentionError('Invalid mail retention revision.')
  return { collection: 'mail-retention', id: createHash('sha256').update(mailRetentionOwnerKey(owner)).digest('hex'), revision: revision === 0 ? null : revision }
}
const validDays = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && (value === 0 || (value >= 7 && value <= 3650))
function check(current: () => boolean) {
  let allowed = false
  try { allowed = current() === true } catch { /* Authorization failures never authorize deletion. */ }
  if (!allowed) throw new MailRetentionError('Mail retention authorization changed. Refresh before continuing.')
}
export async function readMailRetentionPolicy(store: MailStore, owner: MailIdentity): Promise<MailRetentionPolicy> {
  const key = mailRetentionPolicyCheck(owner, 0), row = await store.get<StoredPolicy>(key.collection, key.id)
  if (!row) return { retentionDays: 0, approvedAt: null, revision: 0 }
  const value = row.value
  if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || value.version !== 1 || mailRetentionOwnerKey(value.owner) !== mailRetentionOwnerKey(owner) || !validDays(value.retentionDays)
    || (value.retentionDays === 0 ? value.approvedAt !== null : typeof value.approvedAt !== 'number' || !Number.isSafeInteger(value.approvedAt) || value.approvedAt <= 0 || value.approvedAt > 8.64e15)) throw new MailRetentionError('Saved mail retention policy is invalid. No cleanup is permitted.')
  return { retentionDays: value.retentionDays, approvedAt: value.approvedAt, revision: row.revision }
}
export async function saveMailRetentionPolicy(store: MailStore, owner: MailIdentity, raw: unknown, current: () => boolean): Promise<MailRetentionPolicy> {
  check(current)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MailRetentionError('Invalid mail retention settings.')
  const value = raw as Record<string, unknown>
  if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || Object.keys(value).some(key => !['retentionDays', 'approveDeletion', 'expectedRevision'].includes(key))) throw new MailRetentionError('Invalid mail retention settings.')
  if (!validDays(value.retentionDays) || typeof value.approveDeletion !== 'boolean' || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) throw new MailRetentionError('Choose Keep forever or 7-3650 days and the current policy revision.')
  if (value.retentionDays !== 0 && value.approveDeletion !== true) throw new MailRetentionError('Explicitly approve deletion before enabling automatic history cleanup.')
  const previous = await readMailRetentionPolicy(store, owner)
  check(current)
  if (previous.revision !== value.expectedRevision) throw new MailRetentionError('Mail retention policy changed. Refresh and approve the current settings.')
  const stored: StoredPolicy = { version: 1, owner: { ...owner }, retentionDays: value.retentionDays, approvedAt: value.retentionDays === 0 ? null : Date.now() }
  const key = mailRetentionPolicyCheck(owner, previous.revision)
  if (!await store.batch([{ collection: key.collection, id: key.id, value: stored, owner: mailRetentionOwnerKey(owner), status: stored.retentionDays === 0 ? 'disabled' : 'enabled' }], { checks: [key], limits: [{ collection: key.collection, max: 100_000 }] })) throw new MailRetentionError('Mail retention policy changed or storage is full. Refresh and approve the current settings.')
  check(current)
  const result = await readMailRetentionPolicy(store, owner)
  check(current)
  return result
}

/** One small owner-scoped page. Its cursor advances even when recent/unknown
 * rows are skipped, and generic ID cursors remain valid after row deletion. */
export async function cleanupApprovedOutboxHistory(store: MailStore, owner: MailIdentity, options: { after?: string; now?: number } = {}, current: () => boolean) {
  check(current)
  const policy = await readMailRetentionPolicy(store, owner)
  check(current)
  if (!policy.retentionDays || !policy.approvedAt) return { deleted: 0, hasMore: false }
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < policy.approvedAt) return { deleted: 0, hasMore: false }
  const rows = await store.list<Record<string, unknown>>('outbox', { owner: mailRetentionOwnerKey(owner), after: options.after, limit: 10 })
  check(current)
  const cutoff = now - policy.retentionDays * DAY_MS
  const expired = rows.filter(({ value }) => {
    if (!['accepted', 'rejected', 'cancelled'].includes(String(value.status))) return false
    try { if (mailRetentionOwnerKey(value.actor as MailIdentity) !== mailRetentionOwnerKey(owner)) return false } catch { return false }
    // New jobs record the actual terminal transition. Legacy due was an expiry
    // date, so using it is deliberately conservative and never earlier.
    const completedAt = value.completedAt ?? value.due, keyTime = /^m_(\d{13})_[a-f0-9-]{36}$/.exec(String(value.idempotencyKey))
    return typeof value.createdAt === 'number' && Number.isSafeInteger(value.createdAt) && value.createdAt >= 0
      && typeof completedAt === 'number' && Number.isSafeInteger(completedAt) && completedAt >= value.createdAt && completedAt <= cutoff
      && !!keyTime && Number(keyTime[1]) <= now - 7 * DAY_MS && Number(keyTime[1]) <= cutoff
  })
  if (expired.length) {
    check(current)
    const saved = await store.batch(expired.map(row => ({ collection: 'outbox', id: row.id, delete: true })), {
      checks: [mailRetentionPolicyCheck(owner, policy.revision), ...expired.map(row => ({ collection: 'outbox', id: row.id, revision: row.revision }))],
    })
    if (!saved) throw new MailRetentionError('Mail history or deletion approval changed. No cleanup was committed.')
  }
  return { deleted: expired.length, hasMore: rows.length === 10, ...(rows.length === 10 ? { nextCursor: rows.at(-1)!.id } : {}) }
}
