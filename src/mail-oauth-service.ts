/** Self-hosted, owner/device/project-scoped OAuth mail. Provider tokens never leave this service. */
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { decryptBlobBody, isEncryptedBlob, type AtRestKey } from './at-rest.js'
import { MailStore, MailStoreError } from './mail-store.js'
import { extendMailCooldown } from './mail-cooldown.js'
import { googleDetail, googleMessage, mailboxCategories, mailboxId, mailboxLabels, microsoftDetail, microsoftMessage, type MailboxDetail, type MailboxFolder, type MailboxMessage, type MailboxUpdate } from './mail-provider-mailbox.js'
import { attachmentId, fetchProviderAttachment, googleAttachmentParts, microsoftAttachment, MAIL_ATTACHMENT_JSON_MAX_BYTES, type MailboxAttachment } from './mail-provider-attachments.js'
import { OAuthMailWarmup, type OAuthWarmupJob, type WarmupMailbox } from './mail-warmup.js'
import { readWarmupReceipt, warmupMime } from './mail-warmup-provider.js'
import { cleanupApprovedOutboxHistory, MailRetentionError, mailRetentionOwnerKey, mailRetentionPolicyCheck, readMailRetentionPolicy, saveMailRetentionPolicy } from './mail-retention.js'

export type MailProvider = 'google' | 'microsoft'
export interface MailIdentity { teamId: string; memberId: string; projectId: string; deviceId: string }
export interface PublicMailConnection { id: string; provider: MailProvider; email: string; readInbox: boolean; mailboxAccess?: boolean; createdAt: string; enabled?: boolean; canManage?: boolean; canSend?: boolean; canRead?: boolean; canModify?: boolean }
export interface MailSendResult { status: 'queued' | 'retry_wait' | 'dispatching' | 'accepted' | 'unknown' | 'rejected' | 'cancelled'; idempotencyKey: string; jobId?: string; providerMessageId?: string }
export interface MailInboxResult { messages: MailboxMessage[]; hasMore: boolean; nextCursor?: string }
export class MailOAuthError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400, public readonly retryAfterMs = 0) { super(message); this.name = 'MailOAuthError' }
}
type ClientConfig = { clientId: string; clientSecret: string }
type Options = { dataDir: string; key: AtRestKey; publicUrl: string; google?: ClientConfig; microsoft?: ClientConfig & { tenant?: string }; maxConnections?: number; maxConnectionsPerScope?: number; workers?: number; maxQueued?: number }
type Token = { accessToken: string; refreshToken: string; expiresAt: number }
type Connection = PublicMailConnection & { identity: MailIdentity; accountId: string; registration: string; token: Token; warmupConsentId?: string }
type SendRecord = { id: string; connectionId: string; digest: string; result: MailSendResult }
type DiskState = { version: 1; connections: Connection[]; sends: SendRecord[] }
type Pending = { provider: MailProvider; identity: MailIdentity; verifier: string; readInbox: boolean; mailboxAccess: boolean; expiresAt: number; isAuthorized: () => boolean }
type Access = { connectionId: string; identity: MailIdentity; send: boolean; read: boolean; manage: boolean }
type Job = MailSendResult & { jobId: string; actor: MailIdentity; connectionId: string; account: string; digest: string; to: string[]; subject: string; text?: string; createdAt: number; completedAt?: number; due: number; attempts: number; error?: string }
type AccountWork = { account: string }
type RequestGate = { before: () => Promise<void>; authorized: () => boolean; assertCurrent?: () => void }
const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
const META_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata'
const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify'
const STATE_TTL = 10 * 60_000
const MAX_STORE_BYTES = 16 * 1024 * 1024
const KEY_AGE_MS = 7 * 86400_000
const terminal = new Set(['accepted', 'unknown', 'rejected', 'cancelled'])
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
function fail(code: string, message: string, status = 400): never { throw new MailOAuthError(code, message, status) }
function bag(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}
function clean(raw: unknown, max: number): string {
  return typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : ''
}
function identity(raw: MailIdentity): MailIdentity {
  const value: MailIdentity = { teamId: raw?.teamId, memberId: raw?.memberId, projectId: raw?.projectId, deviceId: raw?.deviceId }
  for (const v of Object.values(value)) if (typeof v !== 'string' || !v || v.length > 256 || /[\u0000-\u001f\u007f]/.test(v)) fail('identity', 'A valid mail owner, team, project and device are required.', 403)
  return value
}
const identityKey = (i: MailIdentity) => JSON.stringify(identity(i))
function authorized(check: () => boolean): void {
  let allowed = false
  try { allowed = check() === true } catch { /* fail closed */ }
  if (!allowed) fail('unauthorized', 'Mail authorization expired. Sign in again.', 403)
}
function validEmail(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(raw)
}
function publicConnection(c: Connection): PublicMailConnection {
  return { id: c.id, provider: c.provider, email: c.email, readInbox: c.readInbox, mailboxAccess: c.mailboxAccess === true, createdAt: c.createdAt }
}
function encodedSubject(subject: string): string {
  // RFC 2047 encoded words are limited to 75 characters, including delimiters.
  const words: string[] = []
  let part = ''
  for (const point of subject) {
    if (Buffer.byteLength(part + point) > 42) {
      words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`)
      part = ''
    }
    part += point
  }
  if (part) words.push(`=?UTF-8?B?${Buffer.from(part).toString('base64')}?=`)
  return words.join('\r\n ')
}

export class MailOAuthService {
  private readonly options: Options
  private readonly store: MailStore
  private readonly warmupService: OAuthMailWarmup
  private readonly initialization: Promise<void>
  private readonly pending = new Map<string, Pending>()
  private readonly refreshes = new Map<string, Promise<Token>>()
  private readonly activeAccounts = new Set<string>()
  private readonly networkByAccount = new Map<string, number>()
  private networkActive = 0
  private attachmentActive = 0
  private workerTimer?: ReturnType<typeof setTimeout>
  private stopping = false
  private pumping = false
  private identityAuthorized: (owner: MailIdentity) => boolean = () => false
  private readonly running = new Set<Promise<void>>()
  private lastCleanup = 0
  private cleanupPolicyCursor: string | undefined
  private workerLastErrorAt = 0
  private readonly workerFailures = new Set<string>()
  // Synchronous fences bridge the gap between worker reads and provider fetch.
  // A unique fallback prevents ABA when a disconnected connection is removed.
  private authorityFallback = {}
  private readonly authorityVersions = new Map<string, object>()
  private authorityVersion(id: string) { return this.authorityVersions.get(id) ?? this.authorityFallback }
  private changeAuthority(id: string) {
    const version = {}
    this.authorityFallback = version
    this.authorityVersions.set(id, version)
  }

  constructor(options: Options) {
    if (!Buffer.isBuffer(options.key?.key) || options.key.key.length !== 32) fail('encryption_required', 'Mailbox OAuth requires a valid at-rest encryption key.', 503)
    const publicUrl = new URL(options.publicUrl)
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname)
    if ((publicUrl.protocol !== 'https:' && !(loopback && publicUrl.protocol === 'http:')) || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') fail('public_url', 'Mail OAuth requires a secure public origin (HTTP is allowed only on loopback).', 503)
    for (const config of [options.google, options.microsoft]) {
      if (config && (!config.clientId || !config.clientSecret || config.clientId.length > 1024 || config.clientSecret.length > 8192 || /[\r\n\0]/.test(config.clientId + config.clientSecret))) fail('provider_config', 'Mailbox provider configuration is invalid.', 503)
    }
    const tenant = options.microsoft?.tenant ?? 'common'
    if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(tenant)) fail('provider_config', 'Microsoft tenant is invalid.', 503)
    this.options = { ...options, key: { key: Buffer.from(options.key.key) }, publicUrl: publicUrl.origin,
      google: options.google ? { ...options.google } : undefined, microsoft: options.microsoft ? { ...options.microsoft, tenant } : undefined }
    this.store = new MailStore({ dataDir: options.dataDir, key: options.key })
    this.warmupService = new OAuthMailWarmup(this.store, {
      mailboxes: (owner, ids, current) => this.warmupMailboxes(owner, ids, current),
      fence: (ids, current) => {
        const versions = ids.map(id => this.authorityVersion(id))
        return () => !this.stopping && current() && ids.every((id, index) => versions[index] === this.authorityVersion(id))
      },
      send: (owner, from, job, current) => this.warmupSend(owner, from, job, current),
      receipt: async (owner, recipient, job, current) => {
        const { c, call } = await this.mailboxContext(owner, recipient.id, current, true)
        return readWarmupReceipt(c.provider, job, call)
      },
    })
    this.initialization = this.initialize(options.dataDir)
    // Initialization failure is observed on every public operation; no fallback.
    void this.initialization.catch(() => undefined)
  }

  capabilities() {
    return { google: { configured: !!this.options.google }, microsoft: { configured: !!this.options.microsoft }, inboxSummariesOnly: false, mailboxManagement: true, warmup: true,
      maxConnections: this.options.maxConnections ?? 20_000, maxConnectionsPerScope: this.options.maxConnectionsPerScope ?? 2_000, queuedSending: true, historyDays: 0, mailRetention: true,
      worker: { running: !!this.workerTimer && !this.stopping, active: this.running.size, healthy: this.workerFailures.size === 0, lastErrorAt: this.workerLastErrorAt || undefined } }
  }

  async warmup(action: string, owner: MailIdentity, value: Record<string, unknown>, current: () => boolean) {
    await this.initialization
    identity(owner); authorized(current)
    const live = () => !this.stopping && current() && this.ownerActive(owner)
    authorized(live)
    if (action === 'warmup-get') return this.warmupService.get(owner, live)
    if (action === 'warmup-save') return this.warmupService.save(owner, value.config, value.acknowledge, live, value.expectedMailboxes)
    if (action === 'warmup-pause') return this.warmupService.pause(owner, live)
    if (action === 'warmup-tick') return this.warmupService.tick(owner, live)
    if (action === 'warmup-history') return this.warmupService.history(owner, { after: value.after as string | undefined, limit: value.limit as number | undefined }, live)
    fail('warmup', 'Unknown automated mail test action.')
  }
  async retention(action: 'retention-get' | 'retention-save', owner: MailIdentity, value: Record<string, unknown>, current: () => boolean) {
    await this.initialization
    identity(owner)
    const live = () => !this.stopping && current() && this.ownerActive(owner)
    authorized(live)
    if (!value || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new MailRetentionError('Invalid mail retention settings.')
    const { projectId: _projectId, ...settings } = value
    const policy = action === 'retention-get' ? await readMailRetentionPolicy(this.store, owner) : await saveMailRetentionPolicy(this.store, owner, settings, live)
    authorized(live)
    return { policy }
  }
  private async warmupMailboxes(owner: MailIdentity, ids: string[], current: () => boolean): Promise<WarmupMailbox[]> {
    const result: WarmupMailbox[] = []
    // Bounded concurrency avoids saturating encrypted storage for large pools.
    for (let offset = 0; offset < ids.length; offset += 16) {
      const page = await Promise.all(ids.slice(offset, offset + 16).map(async id => {
        authorized(current)
        const { record, access } = await this.connectionSnapshot(owner, id, 'manage'), c = record.value
        if (identityKey(c.identity) !== identityKey(owner) || !access.value.send || !access.value.read || c.enabled === false || !c.readInbox || !c.mailboxAccess
          || c.registration !== this.registration(c.provider)) fail('warmup_owner', 'Automated tests require distinct enabled mailboxes owned by this exact member, project and device, with full mailbox consent.', 403)
        authorized(current)
        return { id, provider: c.provider, email: c.email,
          fingerprint: hash(JSON.stringify([c.id, c.provider, c.email.toLowerCase(), c.accountId, c.registration, c.warmupConsentId ?? 'legacy', c.readInbox, c.mailboxAccess])) }
      }))
      result.push(...page)
    }
    if (new Set(result.map(box => box.email.toLowerCase())).size !== ids.length) fail('warmup_owner', 'Select separate mailbox addresses, not duplicate connections.', 403)
    return result
  }
  private async warmupSend(owner: MailIdentity, from: WarmupMailbox, job: OAuthWarmupJob, current: () => boolean): Promise<{ status: 'accepted' | 'failed' | 'unknown'; providerMessageId?: string }> {
    authorized(current)
    const c = await this.connection(owner, from.id, 'send')
    if (c.email !== from.email || c.enabled === false || identityKey(c.identity) !== identityKey(owner)) fail('warmup_owner', 'Mailbox changed before sending.', 403)
    const token = await this.token(owner, from.id, current)
    authorized(current)
    const mime = warmupMime(job)
    const result = await this.request(c.provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : 'https://graph.microsoft.com/v1.0/me/sendMail',
      { method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': c.provider === 'google' ? 'application/json' : 'text/plain' },
        body: c.provider === 'google' ? JSON.stringify({ raw: Buffer.from(mime).toString('base64url') }) : Buffer.from(mime).toString('base64') },
      true, 20_000, this.accountKey(c), this.requestGate(owner, from.id, current, 'send'))
    // Even a definitive throttle is paused; warm-up never enters the normal
    // server outbox, and no worker may retry it after the desktop locks.
    return { status: result.ok ? 'accepted' : result.status >= 400 && result.status < 500 ? 'failed' : 'unknown',
      ...(result.ok && typeof result.body.id === 'string' ? { providerMessageId: mailboxId(result.body.id) } : {}) }
  }

  private config(provider: MailProvider): ClientConfig {
    if (provider !== 'google' && provider !== 'microsoft') return fail('provider', 'Unsupported mailbox provider.')
    const result = this.options[provider]
    return result ?? fail('provider_unavailable', 'This mailbox provider is not configured on the team server.', 503)
  }
  private callbackUrl(provider: MailProvider) { return `${this.options.publicUrl}/v1/mail/oauth/${provider}/callback` }
  private registration(provider: MailProvider) {
    return hash(JSON.stringify([provider, this.config(provider).clientId, provider === 'microsoft' ? this.options.microsoft?.tenant : '']))
  }
  private tokenUrl(provider: MailProvider) {
    return provider === 'google' ? 'https://oauth2.googleapis.com/token'
      : `https://login.microsoftonline.com/${this.options.microsoft?.tenant ?? 'common'}/oauth2/v2.0/token`
  }
  private scopes(provider: MailProvider, readInbox: boolean, mailboxAccess = false) {
    return provider === 'google' ? ['openid', 'email', SEND_SCOPE, ...(readInbox ? [mailboxAccess ? MODIFY_SCOPE : META_SCOPE] : [])]
      : ['offline_access', 'User.Read', 'Mail.Send', ...(readInbox ? [mailboxAccess ? 'Mail.ReadWrite' : 'Mail.ReadBasic'] : [])]
  }

  async start(owner: MailIdentity, args: { provider: MailProvider; readInbox?: boolean; mailboxAccess?: boolean }, isAuthorized: () => boolean): Promise<{ authorizationUrl: string }> {
    await this.initialization
    authorized(isAuthorized)
    const bound = identity(owner)
    const config = this.config(args.provider)
    if (args.readInbox !== undefined && typeof args.readInbox !== 'boolean') fail('scope', 'Inbox access must be explicitly on or off.')
    if ((args.mailboxAccess !== undefined && typeof args.mailboxAccess !== 'boolean') || (args.mailboxAccess === true && args.readInbox !== true)) fail('scope', 'Mailbox management requires explicit read and modify consent.')
    for (const [k, p] of this.pending) if (p.expiresAt <= Date.now()) this.pending.delete(k)
    if (this.pending.size >= 200 || [...this.pending.values()].filter(p => identityKey(p.identity) === identityKey(bound)).length >= 5) fail('busy', 'Too many pending mailbox authorizations. Try again later.', 429)
    const state = randomBytes(32).toString('base64url')
    const verifier = randomBytes(48).toString('base64url')
    const url = new URL(args.provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth'
      : `https://login.microsoftonline.com/${this.options.microsoft?.tenant ?? 'common'}/oauth2/v2.0/authorize`)
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: this.callbackUrl(args.provider), response_type: 'code', state,
      scope: this.scopes(args.provider, args.readInbox === true, args.mailboxAccess === true).join(' '), code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      ...(args.provider === 'google' ? { access_type: 'offline', prompt: 'consent select_account' } : { response_mode: 'query', prompt: 'select_account' }),
    }).toString()
    this.pending.set(hash(state), { provider: args.provider, identity: bound, verifier, readInbox: args.readInbox === true, mailboxAccess: args.mailboxAccess === true, expiresAt: Date.now() + STATE_TTL, isAuthorized })
    return { authorizationUrl: url.toString() }
  }

  async callback(provider: MailProvider, params: URLSearchParams, isIdentityAuthorized: (owner: MailIdentity) => boolean): Promise<void> {
    await this.initialization
    const state = params.get('state') ?? ''
    const key = hash(state)
    const pending = this.pending.get(key)
    this.pending.delete(key) // Consume before any await, denial, or token exchange.
    if (!pending || state.length !== 43 || pending.provider !== provider || pending.expiresAt <= Date.now() || params.getAll('state').length !== 1) fail('oauth_state', 'Mailbox authorization expired or was already used. Start again.')
    const check = () => !this.stopping && pending.expiresAt > Date.now() && pending.isAuthorized() && isIdentityAuthorized({ ...pending.identity })
    authorized(check)
    const code = params.get('code')
    if (params.has('error') || !code || code.length > 4096 || params.getAll('code').length !== 1) fail('oauth_denied', 'Mailbox authorization was not completed.')
    const config = this.config(provider)
    const token = await this.exchange(provider, new URLSearchParams({ grant_type: 'authorization_code', code, client_id: config.clientId,
      client_secret: config.clientSecret, redirect_uri: this.callbackUrl(provider), code_verifier: pending.verifier }), pending.readInbox, undefined, 20_000, 'oauth', { before: async () => { authorized(check) }, authorized: check }, pending.mailboxAccess)
    authorized(check)
    const account = await this.request(provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : 'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName', { headers: { Authorization: `Bearer ${token.accessToken}` } }, false, 20_000, 'oauth', { before: async () => { authorized(check) }, authorized: check })
    authorized(check)
    if (!account.ok) fail('mailbox_identity', 'Could not verify the authorized mailbox. Reconnect the account.')
    const email = provider === 'google' ? account.body.email : (account.body.mail || account.body.userPrincipalName)
    const accountId = provider === 'google' ? account.body.sub : account.body.id
    if (!validEmail(email) || typeof accountId !== 'string' || !accountId || accountId.length > 512 || (provider === 'google' && account.body.email_verified !== true)) fail('mailbox_identity', 'The provider did not confirm a valid mailbox address.')
    const scope = identityKey(pending.identity)
    const accountKey = hash(JSON.stringify([this.registration(provider), accountId]))
    const uniqueKey = hash(JSON.stringify([scope, accountKey]))
    const unique = await this.store.get<{ connectionId: string }>('connection-keys', uniqueKey)
    const existing = (await this.store.list<Connection>('connections', { owner: scope, account: accountKey, limit: 1 }))[0]
    authorized(check)
    const id = existing?.id ?? randomUUID()
    const connection: Connection = { id, identity: pending.identity, provider, email, accountId, registration: this.registration(provider), readInbox: pending.readInbox, mailboxAccess: pending.mailboxAccess, enabled: true, createdAt: existing?.value.createdAt ?? new Date().toISOString(), token, warmupConsentId: randomUUID() }
    const access: Access = { connectionId: id, identity: pending.identity, manage: true, send: true, read: pending.readInbox }
    if (existing) this.changeAuthority(id)
    const stored = await this.store.batch([
      { collection: 'connections', id, value: connection, owner: scope, account: accountKey },
      { collection: 'access', id: this.accessId(pending.identity, id), value: access, owner: scope, account: id },
      { collection: 'connection-keys', id: uniqueKey, value: { connectionId: id }, owner: scope, account: accountKey },
    ], { checks: [{ collection: 'connections', id, revision: existing?.revision ?? null }, { collection: 'connection-keys', id: uniqueKey, revision: unique?.revision ?? null }], limits: [
      { collection: 'connections', max: this.options.maxConnections ?? 20_000 },
      { collection: 'connections', owner: scope, max: this.options.maxConnectionsPerScope ?? 2_000 },
      { collection: 'access', owner: scope, max: this.options.maxConnectionsPerScope ?? 2_000 },
      { collection: 'access', max: 100_000 },
    ] })
    if (!stored) fail('capacity', 'Mailbox limit reached or connection changed; refresh and retry.', 409)
    if (!existing) this.changeAuthority(id)
  }

  private accessId(owner: MailIdentity, id: string) { return hash(`${identityKey(owner)}\n${id}`) }
  private accountKey(c: Connection) { return hash(JSON.stringify([c.registration, c.accountId])) }
  private ownerActive(owner: MailIdentity): boolean {
    try { return this.identityAuthorized(identity(owner)) === true } catch { return false }
  }
  async list(owner: MailIdentity, args: { after?: string; limit?: number } = {}) {
    await this.initialization
    const limit = this.pageLimit(args.limit)
    const rows = await this.store.list<Access>('access', { owner: identityKey(owner), after: args.after, limit: limit + 1 })
    const connections: Array<{ connection: PublicMailConnection; owner: MailIdentity }> = []
    for (const row of rows.slice(0, limit)) {
      const c = await this.store.get<Connection>('connections', row.value.connectionId)
      if (c && this.ownerActive(c.value.identity)) connections.push({ owner: c.value.identity,
        connection: { ...publicConnection(c.value), enabled: c.value.enabled !== false, canManage: row.value.manage, canSend: row.value.send, canRead: row.value.read && c.value.readInbox, canModify: row.value.manage && c.value.mailboxAccess === true } })
    }
    return { connections: connections.filter(row => this.ownerActive(row.owner)).map(row => row.connection), hasMore: rows.length > limit, ...(rows.length > limit ? { nextCursor: rows[limit - 1].id } : {}) }
  }
  private async connection(owner: MailIdentity, id: string, permission: 'send' | 'read' | 'manage' = 'send'): Promise<Connection> {
    return (await this.connectionSnapshot(owner, id, permission)).record.value
  }
  private async connectionSnapshot(owner: MailIdentity, id: string, permission: 'send' | 'read' | 'manage' = 'send') {
    const [record, access] = await Promise.all([this.store.get<Connection>('connections', id), this.store.get<Access>('access', this.accessId(owner, id))])
    if (!record || !access || identityKey(access.value.identity) !== identityKey(owner) || access.value.connectionId !== id || !access.value[permission]) fail('not_found', 'Mailbox connection or permission not found.', 404)
    // Grants do not turn a member/device-owned credential into a service-owned
    // mailbox. Removing its original owner/device disables every shared use.
    if (!this.ownerActive(record.value.identity)) fail('not_found', 'Mailbox connection or permission not found.', 404)
    if (permission === 'read' && !record.value.readInbox) fail('scope', 'Inbox permission was not granted.', 403)
    return { record, access }
  }
  private requestGate(owner: MailIdentity, id: string, check: () => boolean, permission: 'send' | 'read' | 'manage', deadline = Infinity): RequestGate {
    let observed: object | undefined
    let originalOwner: MailIdentity | undefined
    const assertCurrent = () => { if (observed !== this.authorityVersion(id)) fail('authority_changed', 'Mailbox permissions changed before provider access. Refresh and retry.', 409) }
    return { authorized: () => check() && !!originalOwner && this.ownerActive(originalOwner), assertCurrent, before: async () => {
      authorized(check)
      const snapshot = this.authorityVersion(id)
      observed = snapshot
      const c = await this.connection(owner, id, permission)
      originalOwner = identity(c.identity)
      authorized(check)
      if (snapshot !== this.authorityVersion(id)) fail('authority_changed', 'Mailbox permissions changed before provider access. Refresh and retry.', 409)
      if (this.stopping) fail('busy', 'Mail service is restarting.', 503)
      if (c.enabled === false) fail('paused', 'Mailbox paused before provider access.', 409)
      if (permission === 'manage' && !c.mailboxAccess) fail('scope', 'Mailbox management consent changed. Reconnect with the requested access.', 403)
      if (Date.now() > deadline) fail('timeout', 'Mailbox request deadline exceeded.', 504)
    } }
  }
  async disconnect(owner: MailIdentity, id: string, check: () => boolean): Promise<void> {
    await this.initialization
    const { record, access } = await this.connectionSnapshot(owner, id, 'manage')
    authorized(check)
    this.changeAuthority(id)
    if (!await this.store.batch([{ collection: 'connections', id, delete: true },
      { collection: 'connection-keys', id: hash(JSON.stringify([identityKey(record.value.identity), this.accountKey(record.value)])), delete: true },
    ], { checks: [
      { collection: 'connections', id, revision: record.revision }, { collection: 'access', id: access.id, revision: access.revision },
    ] })) fail('changed', 'Mailbox changed. Refresh and retry.', 409)
    // An absent connection denies even before its access indexes are cleaned.
    for (;;) {
      const rows = await this.store.list<Access>('access', { account: id, limit: 100 })
      if (!rows.length) break
      await this.store.batch(rows.map(row => ({ collection: 'access', id: row.id, delete: true })))
    }
    this.authorityVersions.delete(id)
    // Provider-wide grant revocation can affect other connections/apps; this
    // disconnect erases local tokens only. Provider account settings can revoke consent.
  }

  private async token(owner: MailIdentity, id: string, check: () => boolean, deadline = Date.now() + 20_000, permission: 'send' | 'read' = 'send'): Promise<Token> {
    authorized(check)
    const current = await this.connection(owner, id, permission)
    if (current.registration !== this.registration(current.provider)) fail('reconnect', 'Mailbox provider registration changed. Reconnect the account.', 401)
    if (current.token.expiresAt > Date.now() + 60_000) return current.token
    let flight = this.refreshes.get(id)
    if (!flight) {
      flight = (async () => {
        const config = this.config(current.provider)
        const refreshed = await this.exchange(current.provider, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: current.token.refreshToken,
          client_id: config.clientId, client_secret: config.clientSecret,
          ...(current.provider === 'microsoft' ? { scope: this.scopes(current.provider, current.readInbox, current.mailboxAccess).join(' ') } : {}),
        }), current.readInbox, current.token.refreshToken, Math.max(1, deadline - Date.now()), this.accountKey(current), this.requestGate(owner, id, check, permission, deadline), current.mailboxAccess)
        // Atomically compare only credential/consent fields and merge rotation
        // into the latest row. Pause updates survive; newer consent always wins.
        // Retain rotation after a grantee is revoked; returning it stays gated.
        const rotated = await this.store.rotateConnection<Connection>(id, {
          registration: current.registration, readInbox: current.readInbox, mailboxAccess: current.mailboxAccess === true, token: current.token,
        }, refreshed)
        if (rotated.kind === 'missing') fail('not_found', 'Mailbox disconnected.', 404)
        return rotated.value.token
      })()
      this.refreshes.set(id, flight)
      const release = () => { if (this.refreshes.get(id) === flight) this.refreshes.delete(id) }
      void flight.then(release, release)
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([flight, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new MailOAuthError('timeout', 'Mailbox token refresh deadline exceeded.', 504)), Math.max(1, deadline - Date.now()))
      })])
      authorized(check); await this.connection(owner, id, permission); return result
    } finally { if (timeout !== undefined) clearTimeout(timeout) }
  }

  async send(owner: MailIdentity, id: string, args: { to: string[]; subject: string; text: string; idempotencyKey: string }, isAuthorized: () => boolean): Promise<MailSendResult> {
    await this.initialization
    if (this.stopping) fail('busy', 'Mail service is restarting.', 503)
    authorized(isAuthorized)
    const c = await this.connection(owner, id)
    if (c.enabled === false) fail('paused', 'This mailbox is paused.', 409)
    if (!args || !Array.isArray(args.to) || !args.to.length || args.to.length > 20 || !args.to.every(validEmail)
      || typeof args.subject !== 'string' || !args.subject.trim() || args.subject.length > 500 || /[\r\n\0]/.test(args.subject)
      || typeof args.text !== 'string' || !args.text.trim() || Buffer.byteLength(args.text) > 60_000
      || typeof args.idempotencyKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(args.idempotencyKey)) fail('message', 'Mail requires valid recipients, a subject, a bounded text body, and an idempotency key.')
    const payload = { to: [...new Set(args.to)], subject: args.subject, text: args.text }
    const digest = hash(JSON.stringify(payload))
    const legacyId = hash(`${identityKey(owner)}\n${id}\n${args.idempotencyKey}`)
    const keyTime = /^m_(\d{13})_[a-f0-9-]{36}$/.exec(args.idempotencyKey)
    // Sort newest request identities first using the existing owner/id index.
    // No full-history scan or additional plaintext message metadata is needed.
    const ledgerId = keyTime ? `${String(9_999_999_999_999 - Number(keyTime[1])).padStart(13, '0')}_${legacyId}` : legacyId
    const existing = await this.store.get<Job>('outbox', ledgerId)
      ?? (ledgerId !== legacyId ? await this.store.get<Job>('outbox', legacyId) : null)
    if (existing) {
      if (existing.value.digest !== digest) fail('idempotency_conflict', 'This send key was already used for different message content.', 409)
      return this.sendResult(existing.value)
    }
    const legacy = await this.store.get<SendRecord>('legacy-sends', legacyId)
    if (legacy) {
      if (legacy.value.digest !== digest) fail('idempotency_conflict', 'This send key was already used for different message content.', 409)
      return { ...legacy.value.result, jobId: legacyId }
    }
    if (!keyTime || Number(keyTime[1]) < Date.now() - KEY_AGE_MS || Number(keyTime[1]) > Date.now() + 300_000) fail('expired_key', 'This unrecorded request key is expired. Check Sent mail and outbox before deliberately starting a separate message.', 409)
    authorized(isAuthorized)
    const access = await this.store.get<Access>('access', this.accessId(owner, id))
    const record = await this.store.get<Connection>('connections', id)
    if (!access?.value.send || !record || record.value.enabled === false || !this.ownerActive(record.value.identity)) fail('not_found', 'Mailbox authorization changed.', 403)
    authorized(isAuthorized)
    const account = this.accountKey(c)
    if (this.stopping) fail('busy', 'Mail service is restarting; retry this same request after restart.', 503)
    const now = Date.now()
    const job: Job = { jobId: ledgerId, idempotencyKey: args.idempotencyKey, status: 'queued', actor: identity(owner), connectionId: id, account, digest, ...payload, createdAt: now, due: now, attempts: 0 }
    const stored = await this.store.batch([
      this.jobWrite(job), { collection: 'queue-accounts', id: account, value: { account }, account, status: 'ready', due: now },
    ], { checks: [{ collection: 'outbox', id: ledgerId, revision: null }, { collection: 'access', id: access.id, revision: access.revision }, { collection: 'connections', id, revision: record.revision }],
      limits: [{ collection: 'outbox', max: this.options.maxQueued ?? 1_000_000 }] })
    if (!stored) {
      const claimed = await this.store.get<Job>('outbox', ledgerId)
      if (claimed?.value.digest === digest) return this.sendResult(claimed.value)
      fail('capacity', 'Outbox limit reached or mailbox changed. Refresh and retry the same request.', 409)
    }
    return this.sendResult(job)
  }

  private sendResult(job: Job): MailSendResult { return { jobId: job.jobId, idempotencyKey: job.idempotencyKey, status: job.status, ...(job.providerMessageId ? { providerMessageId: job.providerMessageId } : {}) } }
  private jobWrite(job: Job) { return { collection: 'outbox', id: job.jobId, value: job, owner: identityKey(job.actor), account: job.account, status: terminal.has(job.status) ? job.status : job.status === 'dispatching' ? 'dispatching' : 'pending', due: job.due } }
  private pageLimit(raw?: number) { if (raw !== undefined && (!Number.isInteger(raw) || raw < 1 || raw > 100)) fail('page', 'Page size must be between 1 and 100.'); return raw ?? 50 }

  async outbox(owner: MailIdentity, args: { after?: string; limit?: number } = {}) {
    await this.initialization
    const limit = this.pageLimit(args.limit)
    const rows = await this.store.list<Job>('outbox', { owner: identityKey(owner), after: args.after, limit: limit + 1, metadataOnly: true })
    return { jobs: rows.slice(0, limit).map(({ value: job }) => ({ ...this.sendResult(job), connectionId: job.connectionId, to: job.to, subject: job.subject, createdAt: job.createdAt, error: job.error })),
      hasMore: rows.length > limit, ...(rows.length > limit ? { nextCursor: rows[limit - 1].id } : {}) }
  }
  async cancel(owner: MailIdentity, jobId: string, check: () => boolean) {
    await this.initialization
    const record = await this.store.get<Job>('outbox', jobId)
    authorized(check)
    if (!record || identityKey(record.value.actor) !== identityKey(owner)) fail('not_found', 'Outbox item not found.', 404)
    if (terminal.has(record.value.status)) return this.sendResult(record.value)
    if (record.value.status === 'dispatching') fail('dispatching', 'This request may already have reached the provider. Check Sent mail; cancellation is no longer guaranteed.', 409)
    const job = { ...record.value, status: 'cancelled' as const, completedAt: Date.now(), due: Date.now() }
    if (!await this.store.batch([this.jobWrite(job)], { checks: [{ collection: 'outbox', id: jobId, revision: record.revision }] })) fail('dispatching', 'Outbox item changed; refresh its status.', 409)
    return this.sendResult(job)
  }

  startWorkers(check: (owner: MailIdentity) => boolean) {
    this.identityAuthorized = check
    if (this.workerTimer || this.stopping) return
    const tick = async () => {
      try { await this.initialization; await this.pump(); this.workerFailures.delete('pump') } catch { this.workerLastErrorAt = Date.now(); this.workerFailures.add('pump') }
      if (!this.stopping) { this.workerTimer = setTimeout(() => { void tick() }, 250); this.workerTimer.unref?.() }
    }
    this.workerTimer = setTimeout(() => { void tick() }, 0)
  }
  private async pump() {
    if (this.pumping || this.stopping) return
    this.pumping = true
    try {
      if (Date.now() - this.lastCleanup > 5_000) {
        await this.cleanupOutboxHistory()
        this.lastCleanup = Date.now()
      }
      const slots = (this.options.workers ?? 8) - this.running.size
      if (slots <= 0) return
      const accounts = await this.store.list<AccountWork>('queue-accounts', { status: 'ready', dueBefore: Date.now(), limit: Math.min(100, this.activeAccounts.size + slots * 4) })
      for (const row of accounts) {
        if (this.running.size >= (this.options.workers ?? 8) || this.stopping) break
        if (this.activeAccounts.has(row.id)) continue
        this.activeAccounts.add(row.id)
        const work = this.runAccount(row.id).then(() => { this.workerFailures.delete(row.id) }).catch(() => { this.workerLastErrorAt = Date.now(); this.workerFailures.add(row.id) }).finally(() => { this.activeAccounts.delete(row.id); this.running.delete(work) })
        this.running.add(work)
      }
    } finally { this.pumping = false }
  }
  private async cleanupOutboxHistory() {
    // No policy means no scan and no deletion. Rotate bounded policy pages;
    // each owner's independent row cursor survives service restarts.
    const policies = await this.store.list<{ owner: MailIdentity }>('mail-retention', { status: 'enabled', after: this.cleanupPolicyCursor, limit: 5 })
    for (const policy of policies) {
      this.cleanupPolicyCursor = policy.id
      if (this.stopping) break
      try {
        const owner = identity(policy.value.owner), current = () => !this.stopping && this.ownerActive(owner)
        if (!current()) continue
        const cursor = await this.store.get<{ after?: string }>('mail-retention-cursors', policy.id)
        const after = cursor?.value.after
        if (after !== undefined && (typeof after !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(after))) throw new Error('Invalid mail cleanup cursor')
        const result = await cleanupApprovedOutboxHistory(this.store, owner, { after }, current)
        authorized(current)
        await this.store.batch([{ collection: 'mail-retention-cursors', id: policy.id, value: result.hasMore ? { after: result.nextCursor } : {}, owner: mailRetentionOwnerKey(owner) }], {
          checks: [mailRetentionPolicyCheck(owner, policy.revision), { collection: 'mail-retention-cursors', id: policy.id, revision: cursor?.revision ?? null }],
        })
        this.workerFailures.delete(`retention:${policy.id}`)
      } catch {
        // Invalid policies or races preserve records without preventing normal
        // delivery or starving subsequent owners in the cleanup cursor.
        this.workerLastErrorAt = Date.now(); this.workerFailures.add(`retention:${policy.id}`)
      }
    }
    if (policies.length < 5) this.cleanupPolicyCursor = undefined
  }
  private async runAccount(account: string) {
    // The account is exclusively held here. A leftover claim means a previous
    // attempt could not persist its outcome (e.g. disk full), not fresh work.
    const stranded = await this.store.list<Job>('outbox', { account, status: 'dispatching', limit: 10 })
    if (stranded.length) await this.store.batch(stranded.map(row => this.jobWrite({ ...row.value, status: 'unknown', completedAt: Date.now(), due: Date.now(),
      error: 'Dispatch outcome could not be persisted. Check provider Sent mail; no automatic resend.' })),
    { checks: stranded.map(row => ({ collection: 'outbox', id: row.id, revision: row.revision })) })
    const pending = (await this.store.list<Job>('outbox', { account, status: 'pending', dueBefore: Date.now(), limit: 1 }))[0]
    if (pending) await this.dispatch(pending.id, pending.revision, pending.value)
    // CAS prevents a concurrent enqueue from being hidden by an idle update.
    const queue = await this.store.get<AccountWork>('queue-accounts', account)
    const next = (await this.store.list<Job>('outbox', { account, status: 'pending', dueBefore: 8_640_000_000_000_000, limit: 1 }))[0]
    if (queue) await this.store.batch([{ collection: 'queue-accounts', id: account, value: { account }, account, status: next ? 'ready' : 'idle', due: next ? Math.max(Date.now() + 100, next.value.due) : 0 }],
      { checks: [{ collection: 'queue-accounts', id: account, revision: queue.revision }] })
  }
  private async dispatch(id: string, revision: number, original: Job) {
    let job = { ...original }
    const check = () => !this.stopping && this.identityAuthorized(job.actor)
    let c: Connection
    let token: Token
    let permit: Awaited<ReturnType<MailOAuthService['connectionSnapshot']>>
    try {
      authorized(check)
      c = await this.connection(job.actor, job.connectionId)
      if (c.enabled === false) { job.status = 'retry_wait'; job.due = Date.now() + 60_000; await this.store.batch([this.jobWrite(job)], { checks: [{ collection: 'outbox', id, revision }] }); return }
      const cooldown = await this.store.get<{ until: number }>('cooldowns', job.account)
      if (cooldown && cooldown.value.until > Date.now()) throw new MailOAuthError('throttled', 'Provider cooldown is active.', 429, cooldown.value.until - Date.now())
      token = await this.token(job.actor, job.connectionId, check)
      authorized(check)
      permit = await this.connectionSnapshot(job.actor, job.connectionId)
      authorized(check)
    } catch (error) {
      if (this.stopping) return
      if (error instanceof MailStoreError) throw error
      if (error instanceof MailOAuthError && ['provider', 'throttled', 'busy', 'timeout', 'authority_changed'].includes(error.code) && job.attempts < 12) {
        job.status = 'retry_wait'; job.attempts++; job.due = Date.now() + this.retryDelay(job.attempts, error.retryAfterMs)
        job.error = 'Provider temporarily unavailable; scheduled retry before sending.'
      } else { job.status = 'rejected'; job.completedAt = Date.now(); job.due = Date.now(); job.error = 'Mailbox access or authorization is unavailable. Nothing was submitted by this attempt.' }
      await this.store.batch([this.jobWrite(job)], { checks: [{ collection: 'outbox', id, revision }] })
      return
    }
    job.status = 'dispatching'; job.attempts++; job.due = Date.now()
    // Durable claim BEFORE calling provider. Recovery marks these unknown, never retries.
    if (!await this.store.batch([this.jobWrite(job)], { checks: [{ collection: 'outbox', id, revision },
      { collection: 'connections', id: permit.record.id, revision: permit.record.revision },
      { collection: 'access', id: permit.access.id, revision: permit.access.revision },
    ] })) return
    let result: MailSendResult['status'] = 'unknown'
    let retryAfter = 0
    try {
      authorized(check)
      const current = await this.connection(job.actor, job.connectionId)
      if (current.enabled === false) fail('paused', 'Mailbox paused before dispatch.', 409)
      const url = c.provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' : 'https://graph.microsoft.com/v1.0/me/sendMail'
      const mime = [`From: ${c.email}`, `To: ${job.to.join(',\r\n ')}`, `Subject: ${encodedSubject(job.subject)}`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(job.text ?? '').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''].join('\r\n')
      const body = c.provider === 'google' ? { raw: Buffer.from(mime).toString('base64url') }
        : { message: { subject: job.subject, body: { contentType: 'Text', content: job.text }, toRecipients: job.to.map(address => ({ emailAddress: { address } })) }, saveToSentItems: true }
      const response = await this.request(url, { method: 'POST', headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, true, 20_000, job.account, this.requestGate(job.actor, job.connectionId, check, 'send'))
      result = response.ok ? 'accepted' : response.throttled && job.attempts < 12 ? 'retry_wait' : response.status >= 400 && response.status < 500 ? 'rejected' : 'unknown'
      retryAfter = response.retryAfterMs
      if (response.ok && typeof response.body.id === 'string') job.providerMessageId = clean(response.body.id, 512)
    } catch (error) {
      // Local admission errors occur before fetch, so they are safe to defer.
      if (error instanceof MailOAuthError && ['busy', 'throttled', 'authority_changed'].includes(error.code)) { result = 'retry_wait'; retryAfter = error.retryAfterMs }
      // These gates fail locally before fetch; no provider submission took place.
      if (error instanceof MailOAuthError && ['unauthorized', 'not_found', 'scope'].includes(error.code)) result = 'rejected'
      if (error instanceof MailOAuthError && error.code === 'paused') { result = 'retry_wait'; retryAfter = 60_000 }
    }
    job.status = result
    job.due = Date.now() + (result === 'retry_wait' ? this.retryDelay(job.attempts, retryAfter) : 0)
    job.error = result === 'unknown' ? 'Delivery is uncertain. Check the provider; no automatic resend.' : result === 'rejected' ? 'Provider rejected the message.' : undefined
    if (terminal.has(result)) job.completedAt = Date.now()
    const claim = await this.store.get<Job>('outbox', id)
    if (claim?.value.status === 'dispatching') await this.store.batch([this.jobWrite(job)], { checks: [{ collection: 'outbox', id, revision: claim.revision }] })
  }
  private retryDelay(attempt: number, providerDelay = 0) { return Math.max(providerDelay, Math.min(3600_000, 1000 * 2 ** Math.min(attempt, 11)) + Math.floor(Math.random() * 1000)) }

  async inbox(owner: MailIdentity, id: string, isAuthorized: () => boolean, cursor?: string, folderId?: string, filter: 'all' | 'unread' | 'read' | 'starred' = 'all'): Promise<MailInboxResult> {
    await this.initialization
    authorized(isAuthorized)
    const version = this.authorityVersion(id)
    const current = () => isAuthorized() && version === this.authorityVersion(id)
    const c = await this.connection(owner, id, 'read')
    if (c.enabled === false) fail('paused', 'This mailbox is paused.', 409)
    if (!c.readInbox) fail('scope', 'Reconnect this mailbox with inbox summaries enabled.', 403)
    const deadline = Date.now() + 18_000
    const token = await this.token(owner, id, current, deadline, 'read')
    const headers = { Authorization: `Bearer ${token.accessToken}` }
    // Each parallel request gets its own immutable authority observation.
    const gate = () => this.requestGate(owner, id, current, 'read', deadline)
    const check = () => gate().before()
    await check()
    const folder = mailboxId(folderId ?? (c.provider === 'google' ? 'INBOX' : 'inbox'))
    if (!['all', 'unread', 'read', 'starred'].includes(filter)) fail('filter', 'Unsupported mailbox filter.')
    if (c.provider === 'google' && filter === 'read' && !c.mailboxAccess) fail('scope', 'Filtering Gmail by read messages requires upgraded mailbox consent.', 403)
    const context = `messages:${folder}:${filter}`
    const page = cursor ? this.decodeCursor(owner, id, cursor, context) : ''
    const accountKey = this.accountKey(c)
    const wrap = (token?: string) => token ? { nextCursor: this.encodeCursor(owner, id, token, context), hasMore: true } : { hasMore: false }
    if (c.provider === 'microsoft') {
      const path = `/v1.0/me/mailFolders/${encodeURIComponent(folder)}/messages`
      // Combining an unrelated $filter with receivedDateTime $orderby causes
      // Graph InefficientFilter failures. Filtered pages keep provider ordering.
      const query = filter === 'all' ? '$orderby=receivedDateTime%20desc' : `$filter=${encodeURIComponent(filter === 'starred' ? "flag/flagStatus eq 'flagged'" : `isRead eq ${filter === 'read'}`)}`
      const url = page || `https://graph.microsoft.com${path}?$top=25&$select=id,subject,from,receivedDateTime,isRead,flag,categories,parentFolderId,hasAttachments&${query}`
      const parsed = new URL(url)
      if (parsed.origin !== 'https://graph.microsoft.com' || parsed.pathname !== path || parsed.username || parsed.password || parsed.hash) fail('cursor', 'Invalid provider page.', 400)
      const res = await this.request(url, { headers }, false, deadline - Date.now(), accountKey, gate())
      await check()
      if (!res.ok || !Array.isArray(res.body.value)) fail('inbox', 'Could not read inbox summaries. Check provider access.', 502)
      if (res.body.value.length > 25) fail('inbox', 'Provider returned an oversized page.', 502)
      const messages = res.body.value.map(microsoftMessage), verified = await this.warmupService.verifiedIds(owner, id, messages.map(message => message.id))
      await check()
      return { messages: messages.map(message => ({ ...message, warmup: verified.has(message.id) })), ...wrap(typeof res.body['@odata.nextLink'] === 'string' ? res.body['@odata.nextLink'] : undefined) }
    }
    const query = new URLSearchParams({ includeSpamTrash: 'true', maxResults: '10' })
    if (folder !== 'ALL') query.append('labelIds', folder)
    if (filter === 'unread' || filter === 'starred') query.append('labelIds', filter === 'unread' ? 'UNREAD' : 'STARRED')
    if (filter === 'read') query.set('q', 'is:read')
    if (page) query.set('pageToken', page)
    const res = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`, { headers }, false, deadline - Date.now(), accountKey, gate())
    await check()
    if (!res.ok || (res.body.messages !== undefined && !Array.isArray(res.body.messages))) fail('inbox', 'Could not read inbox summaries. Check provider access.', 502)
    const messages: MailInboxResult['messages'] = []
    const rows = (res.body.messages ?? []) as unknown[]
    if (rows.length > 10) fail('inbox', 'Provider returned an oversized page.', 502)
    const read = async (raw: unknown): Promise<MailInboxResult['messages'][number]> => {
      const messageId = bag(raw).id
      if (typeof messageId !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(messageId)) fail('inbox', 'Provider returned an invalid message identifier.', 502)
      await check()
      const row = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`, { headers }, false, deadline - Date.now(), accountKey, gate())
      await check()
      if (!row.ok) fail('inbox', 'Some inbox summaries could not be read.', 502)
      return googleMessage({ ...row.body, id: messageId })
    }
    for (let offset = 0; offset < rows.length; offset += 2) {
      await check()
      messages.push(...await Promise.all(rows.slice(offset, offset + 2).map(read)))
    }
    const verified = await this.warmupService.verifiedIds(owner, id, messages.map(message => message.id))
    await check()
    return { messages: messages.map(message => ({ ...message, warmup: verified.has(message.id) })), ...wrap(typeof res.body.nextPageToken === 'string' ? res.body.nextPageToken : undefined) }
  }

  private async mailboxContext(owner: MailIdentity, id: string, isAuthorized: () => boolean, modify = false) {
    await this.initialization
    authorized(isAuthorized)
    const version = this.authorityVersion(id)
    const current = () => isAuthorized() && version === this.authorityVersion(id)
    const permission = modify ? 'manage' : 'read'
    const c = await this.connection(owner, id, permission)
    if (c.enabled === false) fail('paused', 'This mailbox is paused.', 409)
    if (modify && !c.mailboxAccess) fail('scope', 'Reconnect with explicit mailbox management permission. Existing read grants do not permit changes.', 403)
    const deadline = Date.now() + 18_000
    const token = await this.token(owner, id, current, deadline, 'read')
    const gate = () => this.requestGate(owner, id, current, permission, deadline)
    const check = () => gate().before()
    const call = async (url: string, init: RequestInit = {}, maxBytes = 256 * 1024) => {
      const result = await this.request(url, { ...init, headers: { Authorization: `Bearer ${token.accessToken}`, 'Content-Type': 'application/json', ...init.headers } }, false, deadline - Date.now(), this.accountKey(c), gate(), maxBytes)
      await check()
      if (!result.ok) fail(result.status === 401 || result.status === 403 ? 'scope' : 'mailbox', result.status === 401 || result.status === 403 ? 'Provider mailbox permission is missing or expired. Reconnect with the requested access.' : 'The provider could not complete this mailbox operation. Refresh before retrying.', result.status === 404 ? 404 : 502)
      return result.body
    }
    return { c, call, check }
  }

  async folders(owner: MailIdentity, id: string, isAuthorized: () => boolean, args: { parentId?: string; cursor?: string } = {}) {
    const { c, call } = await this.mailboxContext(owner, id, isAuthorized)
    const parent = args.parentId ? mailboxId(args.parentId) : ''
    const context = `folders:${parent}`
    const page = args.cursor ? this.decodeCursor(owner, id, args.cursor, context) : ''
    let folders: MailboxFolder[], next: string | undefined
    if (c.provider === 'google') {
      if (parent) fail('folder', 'Gmail uses labels, not child mail folders.')
      if (page && !/^\d{1,5}$/.test(page)) fail('cursor', 'Invalid label page.')
      const data = await call('https://gmail.googleapis.com/gmail/v1/users/me/labels', {}, 2 * 1024 * 1024)
      if (!Array.isArray(data.labels) || data.labels.length > 10000) fail('folders', 'Provider returned an invalid label list.', 502)
      const labels: MailboxFolder[] = [{ id: 'ALL', name: 'All messages (including Spam and Trash)', kind: 'label', system: true }, ...data.labels.map(raw => {
        const row = bag(raw)
        return { id: mailboxId(row.id), name: clean(row.name, 255), kind: 'label' as const, system: row.type === 'system' }
      })]
      const offset = Number(page || 0)
      folders = labels.slice(offset, offset + 100)
      if (offset + 100 < labels.length) next = String(offset + 100)
    } else {
      const path = parent ? `/v1.0/me/mailFolders/${encodeURIComponent(parent)}/childFolders` : '/v1.0/me/mailFolders'
      const url = page || `https://graph.microsoft.com${path}?includeHiddenFolders=true&$top=100&$select=id,displayName,childFolderCount,unreadItemCount,totalItemCount`
      const parsed = new URL(url)
      if (parsed.origin !== 'https://graph.microsoft.com' || parsed.pathname !== path || parsed.username || parsed.password || parsed.hash) fail('cursor', 'Invalid folder page.')
      const data = await call(url)
      if (!Array.isArray(data.value) || data.value.length > 100) fail('folders', 'Provider returned an invalid folder page.', 502)
      const count = (raw: unknown) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined
      folders = data.value.map(raw => { const row = bag(raw); return { id: mailboxId(row.id), name: clean(row.displayName, 255), kind: 'folder', system: false,
        childCount: count(row.childFolderCount), unreadCount: count(row.unreadItemCount), totalCount: count(row.totalItemCount) } })
      if (typeof data['@odata.nextLink'] === 'string') next = data['@odata.nextLink']
    }
    return { folders, hasMore: !!next, ...(next ? { nextCursor: this.encodeCursor(owner, id, next, context) } : {}) }
  }

  async message(owner: MailIdentity, id: string, messageId: string, isAuthorized: () => boolean): Promise<{ message: MailboxDetail }> {
    const { c, call, check } = await this.mailboxContext(owner, id, isAuthorized, true)
    if (!c.mailboxAccess) fail('scope', 'Reconnect with explicit mailbox management permission to read message bodies.', 403)
    const safeId = encodeURIComponent(mailboxId(messageId))
    const data = await call(c.provider === 'google' ? `https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}?format=full`
      : `https://graph.microsoft.com/v1.0/me/messages/${safeId}?$select=id,subject,from,receivedDateTime,isRead,flag,categories,parentFolderId,hasAttachments,body`,
    c.provider === 'microsoft' ? { headers: { Prefer: 'outlook.body-content-type="text"' } } : {}, 2 * 1024 * 1024)
    // GET never marks a provider message read implicitly. Attachments remain unavailable until scanned.
    const verified = await this.warmupService.verifiedIds(owner, id, [messageId])
    await check()
    return { message: { ...(c.provider === 'google' ? googleDetail(data) : microsoftDetail(data)), warmup: verified.has(messageId) } }
  }

  async attachments(owner: MailIdentity, id: string, messageId: string, isAuthorized: () => boolean, cursor?: string) {
    if (this.attachmentActive >= 2) fail('busy', 'Attachment requests are busy. Try again shortly.', 429)
    this.attachmentActive++
    try {
      const { c, call, check } = await this.mailboxContext(owner, id, isAuthorized, true)
      const safeId = encodeURIComponent(mailboxId(messageId)), context = `attachments:${messageId}`
      const page = cursor ? this.decodeCursor(owner, id, cursor, context) : ''
      let attachments: MailboxAttachment[], next: string | undefined
      if (c.provider === 'google') {
        if (page && !/^\d{1,4}$/.test(page)) fail('cursor', 'Invalid attachment page.')
        const data = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}?format=full`, {}, MAIL_ATTACHMENT_JSON_MAX_BYTES)
        if (data.id !== messageId) fail('attachment', 'Provider message identity changed. Refresh the message.', 502)
        const found = googleAttachmentParts(data).map(part => part.metadata), offset = Number(page || 0)
        attachments = found.slice(offset, offset + 50)
        if (offset + 50 < found.length) next = String(offset + 50)
      } else {
        const path = `/v1.0/me/messages/${safeId}/attachments`
        const url = page || `https://graph.microsoft.com${path}?$top=50&$select=id,name,contentType,size,isInline`
        const parsed = new URL(url)
        if (parsed.origin !== 'https://graph.microsoft.com' || parsed.pathname !== path || parsed.username || parsed.password || parsed.hash) fail('cursor', 'Invalid attachment page.')
        const data = await call(url)
        if (!Array.isArray(data.value) || data.value.length > 50) fail('attachment', 'Provider attachment metadata is incomplete.', 502)
        attachments = data.value.map(microsoftAttachment)
        if (typeof data['@odata.nextLink'] === 'string') next = data['@odata.nextLink']
      }
      await check()
      return { attachments, hasMore: !!next, ...(next ? { nextCursor: this.encodeCursor(owner, id, next, context) } : {}) }
    } catch (error) {
      if (error instanceof MailOAuthError || error instanceof MailStoreError) throw error
      fail('attachment', 'The provider attachment metadata is unavailable or exceeds the safe limit. View the original message in your provider.', 400)
    } finally { this.attachmentActive-- }
  }

  async attachment(owner: MailIdentity, id: string, messageId: string, selectedId: string, isAuthorized: () => boolean) {
    mailboxId(messageId); attachmentId(selectedId)
    // File bytes have a larger bound than ordinary JSON. Limit concurrent
    // acquisition separately, independent of the number of connected accounts.
    if (this.attachmentActive >= 2) fail('busy', 'Attachment downloads are busy. Try again shortly.', 429)
    this.attachmentActive++
    let bytes: Buffer | undefined
    try {
      const { c, call, check } = await this.mailboxContext(owner, id, isAuthorized, true)
      const attachment = await fetchProviderAttachment(c.provider, messageId, selectedId, call)
      bytes = attachment.bytes
      await check()
      return { attachment: { ...attachment.metadata, size: bytes.length, data: bytes.toString('base64') } }
    } catch (error) {
      if (error instanceof MailOAuthError || error instanceof MailStoreError) throw error
      fail('attachment', 'This attachment is unavailable, unsupported, changed, or exceeds the safe download limit. Refresh the message or use the original provider.', 400)
    } finally { bytes?.fill(0); this.attachmentActive-- }
  }

  async updateMessage(owner: MailIdentity, id: string, input: MailboxUpdate, isAuthorized: () => boolean) {
    const safeId = encodeURIComponent(mailboxId(input.messageId))
    for (const key of ['isRead', 'starred'] as const) if (input[key] !== undefined && typeof input[key] !== 'boolean') fail('message', 'Invalid message flag.')
    const changes = Object.keys(input).filter(key => key !== 'messageId' && input[key as keyof MailboxUpdate] !== undefined)
    if (!changes.length || changes.some(key => !['isRead', 'starred', 'folderId', 'addLabels', 'removeLabels', 'categories'].includes(key))) fail('message', 'Choose a supported mailbox change.')
    // A move is a separate request. Never report an atomic success after a partial multi-request update.
    if (input.folderId !== undefined && changes.length !== 1) fail('message', 'Move a message separately from changing its flags or labels.')
    const { c, call } = await this.mailboxContext(owner, id, isAuthorized, true)
    if (c.provider === 'google') {
      if (input.categories !== undefined) fail('message', 'Gmail uses label IDs, not Outlook categories.')
      const add = new Set(mailboxLabels(input.addLabels)), remove = new Set(mailboxLabels(input.removeLabels))
      if ([...add, ...remove].some(label => ['TRASH', 'SPAM', 'SENT', 'DRAFT', 'INBOX'].includes(label))) fail('message', 'Use the explicit folder move action for system mail folders.')
      if (input.isRead !== undefined) (input.isRead ? remove : add).add('UNREAD')
      if (input.starred !== undefined) (input.starred ? add : remove).add('STARRED')
      const folder = input.folderId === undefined ? undefined : mailboxId(input.folderId)
      if (folder === 'TRASH') {
        await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}/trash`, { method: 'POST', body: '{}' })
      } else {
        if (folder) {
          if (!['INBOX', 'SPAM', 'ARCHIVE'].includes(folder)) fail('folder', 'Gmail moves support Inbox, Spam, Archive or Trash; use labels for other destinations.')
          // Restoring Trash uses Google's explicit untrash operation, not a
          // guessed label mutation. If the following destination update fails,
          // the caller must refresh; this is not claimed as an atomic move.
          const current = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}?format=minimal`)
          if (mailboxLabels(current.labelIds).includes('TRASH')) await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}/untrash`, { method: 'POST' })
          if (folder === 'INBOX') { add.add('INBOX'); remove.add('SPAM') }
          if (folder === 'SPAM') { add.add('SPAM'); remove.add('INBOX') }
          if (folder === 'ARCHIVE') { remove.add('INBOX'); remove.add('SPAM') }
        }
        if ([...add].some(label => remove.has(label)) || add.size > 100 || remove.size > 100) fail('message', 'Conflicting or too many label changes.')
        await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${safeId}/modify`, { method: 'POST', body: JSON.stringify({ addLabelIds: [...add], removeLabelIds: [...remove] }) })
      }
    } else {
      if (input.addLabels !== undefined || input.removeLabels !== undefined) fail('message', 'Outlook uses categories, not Gmail labels.')
      const url = `https://graph.microsoft.com/v1.0/me/messages/${safeId}`
      if (input.folderId !== undefined) await call(`${url}/move`, { method: 'POST', body: JSON.stringify({ destinationId: mailboxId(input.folderId) }) })
      else await call(url, { method: 'PATCH', body: JSON.stringify({ ...(input.isRead !== undefined ? { isRead: input.isRead } : {}),
        ...(input.starred !== undefined ? { flag: { flagStatus: input.starred ? 'flagged' : 'notFlagged' } } : {}),
        ...(input.categories !== undefined ? { categories: mailboxCategories(input.categories) } : {}) }) })
    }
    return { ok: true }
  }

  async createFolder(owner: MailIdentity, id: string, name: string, isAuthorized: () => boolean, parentId?: string) {
    if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[\u0000-\u001f\u007f]/.test(name)) fail('folder', 'Choose a folder or label name (1–255 characters).')
    const { c, call } = await this.mailboxContext(owner, id, isAuthorized, true)
    if (c.provider === 'google' && parentId) fail('folder', 'Gmail labels do not use a parent folder ID.')
    const data = await call(c.provider === 'google' ? 'https://gmail.googleapis.com/gmail/v1/users/me/labels'
      : `https://graph.microsoft.com/v1.0/me/mailFolders${parentId ? `/${encodeURIComponent(mailboxId(parentId))}/childFolders` : ''}`,
    { method: 'POST', body: JSON.stringify(c.provider === 'google' ? { name: name.trim(), labelListVisibility: 'labelShow', messageListVisibility: 'show' } : { displayName: name.trim() }) })
    return { folder: { id: mailboxId(data.id), name: clean(c.provider === 'google' ? data.name : data.displayName, 255), kind: c.provider === 'google' ? 'label' : 'folder', system: false } }
  }

  private async exchange(provider: MailProvider, body: URLSearchParams, readInbox: boolean, fallbackRefresh?: string, timeoutMs = 20_000, account = 'oauth', gate?: RequestGate, mailboxAccess = false): Promise<Token> {
    const res = await this.request(this.tokenUrl(provider), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, false, timeoutMs, account, gate)
    const access = res.body.access_token
    const refresh = res.body.refresh_token ?? fallbackRefresh
    const expires = res.body.expires_in
    if (!res.ok || typeof access !== 'string' || !access || access.length > 32_768 || /[\r\n\0]/.test(access)
      || typeof refresh !== 'string' || !refresh || refresh.length > 32_768 || typeof expires !== 'number' || !Number.isFinite(expires) || expires < 60 || expires > 604800
      || (typeof res.body.token_type === 'string' && res.body.token_type.toLowerCase() !== 'bearer')) fail('reconnect', 'Mailbox authorization could not be renewed. Reconnect with offline access.', 401)
    if (!fallbackRefresh && typeof res.body.scope !== 'string') fail('scope', 'The provider did not confirm granted mail permissions.', 403)
    if (typeof res.body.scope === 'string') {
      const normalizeScope = (scope: string) => provider === 'microsoft'
        ? scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase() : scope
      const scopes = new Set(res.body.scope.split(/\s+/).map(normalizeScope))
      const needed = provider === 'google' ? [SEND_SCOPE, ...(readInbox ? [mailboxAccess ? MODIFY_SCOPE : META_SCOPE] : [])] : ['Mail.Send', ...(readInbox ? [mailboxAccess ? 'Mail.ReadWrite' : 'Mail.ReadBasic'] : [])]
      if (needed.some(s => !scopes.has(normalizeScope(s)))) fail('scope', 'The provider did not grant the requested mail permissions.', 403)
    }
    return { accessToken: access, refreshToken: refresh, expiresAt: Date.now() + expires * 1000 }
  }

  private async request(url: string, init: RequestInit, acceptanceOnly = false, timeoutMs = 20_000, account = 'oauth', gate?: RequestGate, maxBytes = 256 * 1024): Promise<{ ok: boolean; status: number; body: Record<string, unknown>; retryAfterMs: number; throttled?: boolean }> {
    if (this.networkActive >= Math.max(16, (this.options.workers ?? 8) * 4) || (this.networkByAccount.get(account) ?? 0) >= (account === 'oauth' ? 16 : 3)) throw new MailOAuthError('busy', 'Mailbox network capacity is busy.', 429, 1000)
    const application = url.startsWith('https://gmail.googleapis.com/') && this.options.google ? `application-${this.registration('google')}` : undefined
    const cooldowns = await Promise.all([account, ...(application ? [application] : [])].map(id => this.store.get<{ until: number }>('cooldowns', id)))
    const until = Math.max(0, ...cooldowns.map(row => row?.value.until ?? 0))
    if (until > Date.now()) throw new MailOAuthError('throttled', 'Provider cooldown is active.', 429, until - Date.now())
    // Recheck after storage await before reserving scarce network slots.
    if (this.networkActive >= Math.max(16, (this.options.workers ?? 8) * 4) || (this.networkByAccount.get(account) ?? 0) >= (account === 'oauth' ? 16 : 3)) throw new MailOAuthError('busy', 'Mailbox network capacity is busy.', 429, 1000)
    this.networkActive++
    this.networkByAccount.set(account, (this.networkByAccount.get(account) ?? 0) + 1)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(20_000, timeoutMs)))
    let response: Response | undefined
    try {
      if (gate) { await gate.before(); authorized(gate.authorized); gate.assertCurrent?.() }
      if (this.stopping) fail('busy', 'Mail service is restarting.', 503)
      if (controller.signal.aborted) fail('timeout', 'Mailbox request deadline exceeded before submission.', 504)
      response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' })
      if (response.status >= 300 && response.status < 400) fail('provider', 'Mailbox provider redirected unexpectedly.', 502)
      const byteLimit = Math.min(MAIL_ATTACHMENT_JSON_MAX_BYTES, maxBytes)
      const declared = response.headers.get('content-length')
      if (declared && (!/^\d+$/.test(declared) || Number(declared) > byteLimit)) fail('provider', 'Mailbox provider response exceeded the safe size limit.', 502)
      const parts: Uint8Array[] = []
      let total = 0
      const reader = response.body?.getReader()
      if (reader) {
        try {
          while (true) {
            const part = await reader.read()
            if (part.done) break
            total += part.value.byteLength
            if (total > byteLimit) fail('provider', 'Mailbox provider response exceeded the safe size limit.', 502)
            if (gate) { authorized(gate.authorized); gate.assertCurrent?.() }
            parts.push(part.value)
          }
        } finally { await reader.cancel().catch(() => undefined) }
      }
      const text = Buffer.concat(parts).toString('utf8')
      let body: Record<string, unknown> = {}
      if (text) { try { body = bag(JSON.parse(text)) } catch { if (!acceptanceOnly) fail('provider', 'Mailbox provider returned an invalid response.', 502) } }
      const rawRetry = response.headers.get('retry-after')
      const retryAfterMs = rawRetry ? Math.min(86400_000, Math.max(1000, /^\d+$/.test(rawRetry) ? Number(rawRetry) * 1000 : Date.parse(rawRetry) - Date.now() || 1000)) : 1000
      const providerErrors = bag(body.error).errors
      const throttled = response.status === 429 || (response.status === 403 && Array.isArray(providerErrors)
        && providerErrors.some(value => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded'].includes(String(bag(value).reason))))
      if (throttled) {
        const applicationLimit = application && Array.isArray(providerErrors) && providerErrors.some(value => bag(value).reason === 'dailyLimitExceeded')
        await extendMailCooldown(this.store, applicationLimit ? application : account, Date.now() + retryAfterMs)
        if (!acceptanceOnly) throw new MailOAuthError('throttled', 'Provider requests must wait before retrying.', 429, retryAfterMs)
      }
      if (!acceptanceOnly && response.status >= 500) throw new MailOAuthError('provider', 'Mailbox provider is temporarily unavailable.', 503, retryAfterMs)
      return { ok: response.ok, status: response.status, body, retryAfterMs, throttled }
    } catch (error) {
      if (acceptanceOnly && response?.ok) return { ok: true, status: response.status, body: {}, retryAfterMs: 0 }
      if (error instanceof MailOAuthError) throw error
      return fail('provider', 'Mailbox provider request failed or timed out.', 502)
    } finally {
      clearTimeout(timer)
      this.networkActive--
      const left = (this.networkByAccount.get(account) ?? 1) - 1
      if (left > 0) this.networkByAccount.set(account, left); else this.networkByAccount.delete(account)
    }
  }

  async ready() { await this.initialization }
  private async initialize(dataDir: string) {
    await this.store.ready()
    const marker = await this.store.get('meta', 'legacy-migrated')
    if (!marker) {
      const file = join(dataDir, 'mail-oauth', 'mail-oauth.v1.enc')
      if (existsSync(file)) {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) fail('storage', 'Legacy mailbox storage is invalid.', 503)
        const raw = readFileSync(file)
        if (!isEncryptedBlob(raw)) fail('storage', 'Plaintext mailbox storage is refused.', 503)
        const parsed = bag(JSON.parse(decryptBlobBody(this.options.key, raw).toString('utf8')))
        if (parsed.version !== 1 || !Array.isArray(parsed.connections) || !Array.isArray(parsed.sends)) fail('storage', 'Invalid legacy mailbox store.', 503)
        const state = parsed as unknown as DiskState
        const ids = new Set<string>()
        for (const c of state.connections) {
          identity(c.identity)
          if (!c.id || ids.has(c.id) || !validEmail(c.email) || !['google', 'microsoft'].includes(c.provider) || typeof c.accountId !== 'string' || !/^[a-f0-9]{64}$/.test(c.registration) || typeof c.readInbox !== 'boolean'
            || !c.token || typeof c.token.accessToken !== 'string' || typeof c.token.refreshToken !== 'string' || !c.token.accessToken || !c.token.refreshToken || c.token.accessToken.length > 32768 || c.token.refreshToken.length > 32768 || !Number.isFinite(c.token.expiresAt)) fail('storage', 'Invalid legacy mailbox connection.', 503)
          ids.add(c.id)
        }
        for (const s of state.sends) if (!s || !/^[a-f0-9]{64}$/.test(s.id) || !/^[a-f0-9]{64}$/.test(s.digest) || !s.result || !terminal.has(s.result.status)) fail('storage', 'Invalid legacy send history.', 503)
        // Service is unavailable until all restart-idempotent chunks and marker commit.
        for (let offset = 0; offset < state.connections.length; offset += 25) {
          await this.store.batch(state.connections.slice(offset, offset + 25).flatMap(c => [
            { collection: 'connections', id: c.id, value: { ...c, enabled: true }, owner: identityKey(c.identity), account: this.accountKey(c) },
            { collection: 'access', id: this.accessId(c.identity, c.id), value: { connectionId: c.id, identity: c.identity, send: true, read: c.readInbox, manage: true }, owner: identityKey(c.identity), account: c.id },
          ]))
        }
        for (let offset = 0; offset < state.sends.length; offset += 200) await this.store.batch(state.sends.slice(offset, offset + 200).map(s => ({ collection: 'legacy-sends', id: s.id, value: s })))
      }
      await this.store.batch([{ collection: 'meta', id: 'legacy-migrated', value: { version: 2, at: Date.now() } }])
    }
    for (;;) {
      const rows = await this.store.list<Job>('outbox', { status: 'dispatching', limit: 10 })
      if (!rows.length) break
      await this.store.batch(rows.map(row => this.jobWrite({ ...row.value, status: 'unknown', completedAt: Date.now(), due: Date.now(), error: 'Server restarted during dispatch. Check provider Sent mail; no automatic resend.' })))
    }
  }
  beginShutdown() {
    this.stopping = true
    if (this.workerTimer) clearTimeout(this.workerTimer)
  }
  async close() {
    this.beginShutdown()
    await this.initialization.catch(() => undefined)
    while (this.pumping) await new Promise(resolve => setTimeout(resolve, 10))
    await Promise.allSettled([...this.running])
    await Promise.allSettled([...this.refreshes.values()])
    await this.store.close()
  }

  async grants(owner: MailIdentity, id: string) {
    await this.initialization
    await this.connection(owner, id, 'manage')
    const grants: Array<{ id: string; memberId: string; projectId: string; deviceId: string; send: boolean; read: boolean }> = []
    let after: string | undefined
    for (;;) {
      const rows = await this.store.list<Access>('access', { account: id, after, limit: 100 })
      for (const row of rows) if (!row.value.manage) grants.push({ id: row.id, ...row.value.identity, send: row.value.send, read: row.value.read })
      if (rows.length < 100) break
      after = rows[rows.length - 1].id
      if (grants.length >= 2000) fail('capacity', 'Too many mailbox grants to display.', 409)
    }
    return { grants }
  }
  async grant(owner: MailIdentity, id: string, target: MailIdentity, rights: { send: boolean; read: boolean }, check: () => boolean) {
    await this.initialization
    const { record, access: ownerAccess } = await this.connectionSnapshot(owner, id, 'manage')
    const c = record.value
    identity(target)
    if (target.teamId !== owner.teamId || !this.identityAuthorized(target) || identityKey(target) === identityKey(c.identity)) fail('grant', 'Choose another active member/device and an exact project namespace in this team.', 400)
    if ((!rights.send && !rights.read) || (rights.read && !c.readInbox)) fail('scope', 'Choose permitted send or inbox access.', 403)
    const access: Access = { connectionId: id, identity: target, send: rights.send, read: rights.read, manage: false }
    authorized(check)
    if (!this.identityAuthorized(target)) fail('grant', 'Grant target is no longer active.', 403)
    this.changeAuthority(id)
    if (!await this.store.batch([{ collection: 'access', id: this.accessId(target, id), value: access, owner: identityKey(target), account: id }],
      { checks: [{ collection: 'connections', id, revision: record.revision }, { collection: 'access', id: ownerAccess.id, revision: ownerAccess.revision }], limits: [{ collection: 'access', owner: identityKey(target), max: this.options.maxConnectionsPerScope ?? 2000 }, { collection: 'access', account: id, max: 2000 }, { collection: 'access', max: 100_000 }] })) fail('capacity', 'Mailbox grant limit reached or connection changed.', 409)
    return { ok: true }
  }
  async revokeGrant(owner: MailIdentity, id: string, grantId: string, check: () => boolean) {
    await this.initialization
    const { record, access } = await this.connectionSnapshot(owner, id, 'manage')
    const row = await this.store.get<Access>('access', grantId)
    if (!row || row.value.connectionId !== id || row.value.manage) fail('grant', 'Shared mailbox grant not found.', 404)
    authorized(check)
    this.changeAuthority(id)
    if (!await this.store.batch([{ collection: 'access', id: grantId, delete: true }], { checks: [
      { collection: 'connections', id, revision: record.revision }, { collection: 'access', id: access.id, revision: access.revision },
      { collection: 'access', id: grantId, revision: row.revision },
    ] })) fail('changed', 'Mailbox grant changed. Refresh and retry.', 409)
    return { ok: true }
  }
  async pause(owner: MailIdentity, id: string, enabled: boolean, check: () => boolean) {
    await this.initialization
    const { record: row, access } = await this.connectionSnapshot(owner, id, 'manage')
    authorized(check)
    this.changeAuthority(id)
    if (!await this.store.batch([{ collection: 'connections', id, value: { ...row.value, enabled, warmupConsentId: randomUUID() }, owner: identityKey(row.value.identity), account: this.accountKey(row.value) }], { checks: [{ collection: 'connections', id, revision: row.revision }, { collection: 'access', id: access.id, revision: access.revision }] })) fail('changed', 'Mailbox changed. Refresh and retry.', 409)
    return { ok: true }
  }
  private encodeCursor(owner: MailIdentity, id: string, page: string, context = 'messages:INBOX') {
    if (page.length > 6000) fail('cursor', 'Provider cursor exceeded safe size.', 502)
    const body = Buffer.from(JSON.stringify({ scope: identityKey(owner), id, page, context, expires: Date.now() + 3600_000 })).toString('base64url')
    const cursor = `${body}.${createHmac('sha256', this.options.key.key).update(`mail-page:${body}`).digest('base64url')}`
    if (cursor.length > 10000) fail('cursor', 'Provider cursor exceeded safe size.', 502)
    return cursor
  }
  private decodeCursor(owner: MailIdentity, id: string, token: string, context = 'messages:INBOX') {
    if (token.length > 10000) fail('cursor', 'Invalid inbox page.', 400)
    const [body, sig, extra] = token.split('.')
    const expected = createHmac('sha256', this.options.key.key).update(`mail-page:${body}`).digest()
    const actual = Buffer.from(sig ?? '', 'base64url')
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('cursor', 'Inbox page expired or changed.', 400)
    const value = bag(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')))
    if (value.scope !== identityKey(owner) || value.id !== id || value.context !== context || typeof value.expires !== 'number' || value.expires < Date.now() || typeof value.page !== 'string') fail('cursor', 'Inbox page expired or changed.', 400)
    return value.page
  }
}
