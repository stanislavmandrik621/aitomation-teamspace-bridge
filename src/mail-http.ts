/** Private, header-authenticated self-host mailbox routes. No sync/Directus paths. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MailIdentity, MailOAuthService } from './mail-oauth-service.js'
import { MailOAuthError } from './mail-oauth-service.js'
import { MailStoreError } from './mail-store.js'
import { OAuthWarmupError } from './mail-warmup.js'
import { MailRetentionError } from './mail-retention.js'
import { TokenBucketLimiter } from './rate-limit.js'

type Auth = { member: { memberId: string; role: string }; deviceId: string }
type Deps = {
  service: MailOAuthService | null
  authenticate(req: IncomingMessage): Auth | null
  teamId(): string
  identityExists(identity: MailIdentity): boolean
  readBody(req: IncomingMessage, max: number, opts: { reserveBytes: number; memberId: string }): Promise<unknown>
  releaseBody(body: unknown): void
  json(res: ServerResponse, status: number, body: unknown): void
  drain(req: IncomingMessage): void
}

const actions = new Set(['capabilities', 'start', 'list', 'disconnect', 'send', 'inbox', 'folders', 'message', 'attachments', 'attachment', 'update-message', 'create-folder', 'outbox', 'cancel', 'grants', 'grant', 'revoke-grant', 'pause', 'warmup-get', 'warmup-save', 'warmup-pause', 'warmup-tick', 'warmup-history', 'retention-get', 'retention-save'])
const idPattern = /^[A-Za-z0-9_-]{1,160}$/

export function createMailHttpHandler(deps: Deps) {
  const limiter = new TokenBucketLimiter()
  const inflight = new Map<string, number>()
  let callbacksInFlight = 0
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!url.pathname.startsWith('/v1/mail/')) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const callback = /^\/v1\/mail\/oauth\/(google|microsoft)\/callback$/.exec(url.pathname)
    if (callback && req.method === 'GET') {
      // No dynamic HTML or provider error text, no redirects carrying codes/tokens.
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      if (callbacksInFlight >= 16 || !limiter.take('mail-callback', 60, 60_000)) {
        res.statusCode = 429
        res.end('Too many connection attempts. Please start a new connection later.')
        return true
      }
      callbacksInFlight++
      try {
        if (!deps.service || url.search.length > 8192) throw new Error('Unavailable')
        await deps.service.callback(callback[1] as 'google' | 'microsoft', url.searchParams, deps.identityExists)
        res.statusCode = 200
        res.end('Mailbox connected to your self-hosted server. Return to V-Aid and refresh the connections list.')
      } catch (error) {
        res.statusCode = error instanceof MailStoreError ? 503 : 400
        res.end('Mailbox connection was not completed. Return to V-Aid and start a new connection.')
      } finally {
        callbacksInFlight--
      }
      return true
    }
    const action = url.pathname.slice('/v1/mail/'.length)
    if (req.method !== 'POST' || !actions.has(action) || url.search) {
      deps.drain(req)
      deps.json(res, 404, { ok: false, error: 'Unknown mailbox route' })
      return true
    }
    const auth = deps.authenticate(req)
    const teamId = deps.teamId()
    if (!auth || !teamId || auth.member.role === 'viewer') {
      deps.drain(req)
      deps.json(res, 403, { ok: false, error: 'An active, non-viewer Team Space session is required' })
      return true
    }
    const member = auth.member.memberId
    if (!limiter.take(`mail:${member}`, 300, 60_000)
      || (action === 'start' && !limiter.take(`mail-start:${member}`, 20, 60_000))
      || (inflight.get(member) ?? 0) >= 16) {
      deps.drain(req)
      deps.json(res, 429, { ok: false, error: 'Mailbox request limit reached; try again later' })
      return true
    }
    inflight.set(member, (inflight.get(member) ?? 0) + 1)
    let body: unknown
    try {
      // An exact 1,000-mailbox approval repeats bounded IDs and addresses.
      // Allow their UTF-8 JSON representation only on this authenticated route;
      // the same per-member/process body reservation and in-flight limits apply.
      const maxBodyBytes = action === 'warmup-save' ? 2 * 1024 * 1024 : 96_000
      body = await deps.readBody(req, maxBodyBytes, { reserveBytes: maxBodyBytes, memberId: member })
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid mailbox request')
      const value = body as Record<string, unknown>
      if (typeof value.projectId !== 'string' || !idPattern.test(value.projectId)) throw new Error('Project binding is required')
      const identity: MailIdentity = { teamId, memberId: member, deviceId: auth.deviceId, projectId: value.projectId }
      const isAuthorized = () => {
        const fresh = deps.authenticate(req)
        return (!['warmup-tick', 'attachments', 'attachment', 'retention-save'].includes(action) || !res.destroyed) && deps.teamId() === teamId && fresh?.member.memberId === member
          && fresh.deviceId === auth.deviceId && fresh.member.role !== 'viewer'
      }
      if (!isAuthorized()) throw new Error('Team Space session changed')
      if (action === 'list' && value.query !== undefined) throw new Error('Mailbox list search is not supported')
      const service = deps.service
      if (action === 'capabilities') {
        if (service) await service.ready()
        if (!isAuthorized()) throw new Error('Team Space session changed')
        deps.json(res, 200, { ok: true, projectId: identity.projectId, memberId: identity.memberId, deviceId: identity.deviceId, enabled: !!service, ...(service?.capabilities() ?? {
          google: { configured: false }, microsoft: { configured: false }, inboxSummariesOnly: true,
        }) })
        return true
      }
      if (!service) {
        deps.json(res, 503, { ok: false, error: 'Ask your server administrator to configure self-hosted mailbox OAuth' })
        return true
      }
      let result: unknown
      if (action === 'retention-get' || action === 'retention-save') {
        result = await service.retention(action, identity, value, isAuthorized)
      } else if (action === 'warmup-get' || action === 'warmup-save' || action === 'warmup-pause' || action === 'warmup-tick' || action === 'warmup-history') {
        if (action === 'warmup-history' && ((value.after !== undefined && (typeof value.after !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(value.after)))
          || (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 100)))) throw new Error('Invalid mail history page')
        result = await service.warmup(action, identity, value, isAuthorized)
      } else if (action === 'start') {
        if (value.provider !== 'google' && value.provider !== 'microsoft') throw new Error('Unsupported mailbox provider')
        if (value.readInbox !== undefined && typeof value.readInbox !== 'boolean') throw new Error('Invalid inbox permission')
        if (value.mailboxAccess !== undefined && typeof value.mailboxAccess !== 'boolean') throw new Error('Invalid mailbox permission')
        result = await service.start(identity, { provider: value.provider, readInbox: value.readInbox === true, mailboxAccess: value.mailboxAccess === true }, isAuthorized)
      } else if (action === 'list' || action === 'outbox') {
        if (value.after !== undefined && (typeof value.after !== 'string' || !idPattern.test(value.after))) throw new Error('Invalid cursor')
        if (value.limit !== undefined && (typeof value.limit !== 'number' || !Number.isInteger(value.limit) || value.limit < 1 || value.limit > 100)) throw new Error('Invalid page size')
        const page = { after: value.after as string | undefined, limit: value.limit as number | undefined }
        result = action === 'list' ? await service.list(identity, page) : await service.outbox(identity, page)
      } else if (action === 'cancel') {
        if (typeof value.jobId !== 'string' || !idPattern.test(value.jobId)) throw new Error('Invalid outbox item')
        result = await service.cancel(identity, value.jobId, isAuthorized)
      } else {
        if (typeof value.connectionId !== 'string' || !idPattern.test(value.connectionId)) throw new Error('Invalid mailbox connection')
        if (action === 'disconnect') {
          await service.disconnect(identity, value.connectionId, isAuthorized)
          result = { ok: true }
        } else if (action === 'inbox') {
          if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 10000)) throw new Error('Invalid inbox cursor')
          if (value.folderId !== undefined && typeof value.folderId !== 'string') throw new Error('Invalid folder')
          if (value.filter !== undefined && !['all', 'unread', 'read', 'starred'].includes(String(value.filter))) throw new Error('Invalid filter')
          result = await service.inbox(identity, value.connectionId, isAuthorized, value.cursor as string | undefined, value.folderId as string | undefined, value.filter as 'all' | 'unread' | 'read' | 'starred' | undefined)
        } else if (action === 'folders') {
          if (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 10000)) throw new Error('Invalid folder cursor')
          if (value.parentId !== undefined && typeof value.parentId !== 'string') throw new Error('Invalid parent folder')
          result = await service.folders(identity, value.connectionId, isAuthorized, { cursor: value.cursor as string | undefined, parentId: value.parentId as string | undefined })
        } else if (action === 'message') {
          if (typeof value.messageId !== 'string') throw new Error('Invalid message')
          result = await service.message(identity, value.connectionId, value.messageId, isAuthorized)
        } else if (action === 'attachments') {
          if (typeof value.messageId !== 'string' || (value.cursor !== undefined && (typeof value.cursor !== 'string' || value.cursor.length > 10000))) throw new Error('Invalid attachment page')
          result = await service.attachments(identity, value.connectionId, value.messageId, isAuthorized, value.cursor as string | undefined)
        } else if (action === 'attachment') {
          if (typeof value.messageId !== 'string' || typeof value.attachmentId !== 'string') throw new Error('Invalid attachment')
          result = await service.attachment(identity, value.connectionId, value.messageId, value.attachmentId, isAuthorized)
        } else if (action === 'update-message') {
          if (typeof value.messageId !== 'string') throw new Error('Invalid message')
          result = await service.updateMessage(identity, value.connectionId, { messageId: value.messageId,
            ...(value.isRead !== undefined ? { isRead: value.isRead as boolean } : {}), ...(value.starred !== undefined ? { starred: value.starred as boolean } : {}),
            ...(value.folderId !== undefined ? { folderId: value.folderId as string } : {}), ...(value.addLabels !== undefined ? { addLabels: value.addLabels as string[] } : {}),
            ...(value.removeLabels !== undefined ? { removeLabels: value.removeLabels as string[] } : {}), ...(value.categories !== undefined ? { categories: value.categories as string[] } : {}) }, isAuthorized)
        } else if (action === 'create-folder') {
          if (typeof value.name !== 'string' || (value.parentId !== undefined && typeof value.parentId !== 'string')) throw new Error('Invalid folder')
          result = await service.createFolder(identity, value.connectionId, value.name, isAuthorized, value.parentId as string | undefined)
        } else if (action === 'grants') {
          result = await service.grants(identity, value.connectionId)
        } else if (action === 'revoke-grant') {
          if (typeof value.grantId !== 'string' || !idPattern.test(value.grantId)) throw new Error('Invalid grant')
          result = await service.revokeGrant(identity, value.connectionId, value.grantId, isAuthorized)
        } else if (action === 'pause') {
          if (typeof value.enabled !== 'boolean') throw new Error('Invalid mailbox state')
          result = await service.pause(identity, value.connectionId, value.enabled, isAuthorized)
        } else if (action === 'grant') {
          for (const key of ['memberId', 'deviceId', 'targetProjectId']) if (typeof value[key] !== 'string' || !idPattern.test(value[key] as string)) throw new Error('Invalid grant identity')
          if (typeof value.send !== 'boolean' || typeof value.read !== 'boolean') throw new Error('Invalid grant rights')
          const target = { teamId, memberId: value.memberId as string, deviceId: value.deviceId as string, projectId: value.targetProjectId as string }
          if (!deps.identityExists(target)) throw new Error('Grant target is not active')
          result = await service.grant(identity, value.connectionId, target, { send: value.send, read: value.read }, isAuthorized)
        } else if (action === 'send') {
          if (!Array.isArray(value.to) || !value.to.every(v => typeof v === 'string')
            || typeof value.subject !== 'string' || typeof value.text !== 'string'
            || typeof value.idempotencyKey !== 'string') throw new Error('Invalid message')
          result = await service.send(identity, value.connectionId, {
            to: value.to as string[], subject: value.subject, text: value.text, idempotencyKey: value.idempotencyKey,
          }, isAuthorized)
        }
      }
      if (!isAuthorized()) throw new Error('Team Space session changed; message delivery, if requested, may be uncertain')
      deps.json(res, 200, { ok: true, ...(result as object) })
    } catch (error) {
      // Never serialize provider responses, tokens, filesystem paths, or request bodies.
      if (error instanceof MailStoreError) {
        deps.json(res, 503, { ok: false, error: 'Encrypted mailbox storage is unavailable. Try again later.', error_code: 'storage' })
      } else if (error instanceof OAuthWarmupError) {
        deps.json(res, 409, { ok: false, error: error.message, error_code: 'warmup' })
      } else if (error instanceof MailRetentionError) {
        deps.json(res, 409, { ok: false, error: error.message, error_code: 'mail_retention' })
      } else if (error instanceof MailOAuthError) {
        deps.json(res, error.status, { ok: false, error: error.message, error_code: error.code })
      } else {
        deps.json(res, 400, { ok: false, error: 'Mailbox request failed. Check the connection and permissions. If sending, check Sent mail before retrying.' })
      }
    } finally {
      deps.releaseBody(body)
      const count = (inflight.get(member) ?? 1) - 1
      if (count > 0) inflight.set(member, count)
      else inflight.delete(member)
    }
    return true
  }
}
