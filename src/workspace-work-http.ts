import type { IncomingMessage, ServerResponse } from 'node:http'
import { WorkspaceWorkError, type WorkspaceWorkStore, type WorkCollection } from './workspace-work.js'
import { TokenBucketLimiter } from './rate-limit.js'
import type { WorkspaceCoordinatorMonitor } from './workspace-coordinator-monitor.js'
type Auth = { member: { memberId: string; role: string }; deviceId: string }
type Deps = {
  store: WorkspaceWorkStore
  coordinator?: WorkspaceCoordinatorMonitor
  authenticate(req: IncomingMessage): Auth | null
  members(): { memberId: string; displayName: string; role: string }[]
  readBody(req: IncomingMessage, max: number, options: { reserveBytes: number; memberId: string }): Promise<unknown>
  releaseBody(body: unknown): void
  json(res: ServerResponse, status: number, body: unknown): void
  drain(req: IncomingMessage): void
}
export function createWorkspaceWorkHttpHandler(deps: Deps) {
  const limiter = new TokenBucketLimiter()
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    if (!['/workspace-work', '/workspace-work/ai-reviewers', '/workspace-work/ai-review', '/workspace-work/coordinator'].includes(url.pathname)) return false
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (url.pathname === '/workspace-work/ai-review') {
      let aiBody: unknown
      try {
        const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? '')?.[1] ?? ''
        const workspaceId = url.searchParams.get('workspaceId') ?? ''
        let actor = deps.store.authenticateAi(workspaceId, token)
        if (!limiter.take(`ai:${workspaceId}:${actor.agentId}`, 120, 60_000)) throw new WorkspaceWorkError(429, 'rate_limit', 'AI review request limit reached')
        if (req.method === 'GET') deps.json(res, 200, { ok: true, data: deps.store.readAiTask(workspaceId, url.searchParams.get('taskId') ?? '', actor) })
        else if (req.method === 'POST') {
          aiBody = await deps.readBody(req, 32000, { reserveBytes: 32000, memberId: actor.memberId })
          actor = deps.store.authenticateAi(workspaceId, token)
          if (!aiBody || typeof aiBody !== 'object' || Array.isArray(aiBody)) throw new WorkspaceWorkError(400, 'invalid', 'Invalid AI review')
          const request = aiBody as Record<string, unknown>
          if (request.workspaceId !== workspaceId || request.action !== 'reviewTask') throw new WorkspaceWorkError(400, 'invalid', 'Review scope mismatch')
          const result = deps.store.command(request, actor)
          // A service reviewer never receives the member's directory or other tasks.
          deps.json(res, 200, { ok: true, data: { kind: 'ai_review_receipt', workspaceId, revision: result.revision } })
        } else throw new WorkspaceWorkError(405, 'method_not_allowed', 'Use GET or POST')
      } catch (error) { deps.drain(req); deps.json(res, error instanceof WorkspaceWorkError ? error.status : 503, { ok: false, code: error instanceof WorkspaceWorkError ? error.code : 'unavailable', error: error instanceof WorkspaceWorkError ? error.message : 'AI review unavailable' }) }
      finally { deps.releaseBody(aiBody) }
      return true
    }
    const auth = deps.authenticate(req)
    if (!auth) { deps.drain(req); deps.json(res, 401, { ok: false, code: 'unauthorized', error: 'Active Team Space session required' }); return true }
    if (!limiter.take(auth.member.memberId, 240, 60_000)) { deps.drain(req); deps.json(res, 429, { ok: false, code: 'rate_limit', error: 'Workspace request limit reached' }); return true }
    let body: unknown
    try {
      if (url.pathname === '/workspace-work/coordinator') {
        if (!deps.coordinator) throw new WorkspaceWorkError(501, 'unsupported', 'Update the team server to use coordinator monitoring')
        if (req.method === 'GET') {
          if ([...url.searchParams.keys()].some(key => key !== 'workspaceId') || url.searchParams.getAll('workspaceId').length !== 1) throw new WorkspaceWorkError(400, 'invalid', 'Choose a workspace')
          deps.json(res, 200, { ok: true, data: deps.coordinator.read(url.searchParams.get('workspaceId') ?? '', auth.member.memberId) })
        } else if (req.method === 'POST' && !url.search) {
          body = await deps.readBody(req, 1000, { reserveBytes: 1000, memberId: auth.member.memberId })
          const fresh = deps.authenticate(req)
          if (!fresh || fresh.member.memberId !== auth.member.memberId || fresh.deviceId !== auth.deviceId) throw new WorkspaceWorkError(401, 'unauthorized', 'Team Space session changed')
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'enabled,workspaceId') throw new WorkspaceWorkError(400, 'invalid', 'Invalid monitoring preference')
          const request = body as { workspaceId: string; enabled: boolean }
          deps.json(res, 200, { ok: true, data: deps.coordinator.configure(request.workspaceId, fresh.member.memberId, request.enabled) })
        } else throw new WorkspaceWorkError(405, 'method_not_allowed', 'Use GET or POST')
      } else if (url.pathname === '/workspace-work/ai-reviewers') {
        if (req.method !== 'POST' || url.search) throw new WorkspaceWorkError(405, 'method_not_allowed', 'Use POST')
        body = await deps.readBody(req, 32000, { reserveBytes: 32000, memberId: auth.member.memberId })
        const fresh = deps.authenticate(req)
        if (!fresh || fresh.member.memberId !== auth.member.memberId || fresh.deviceId !== auth.deviceId) throw new WorkspaceWorkError(401, 'unauthorized', 'Team Space session changed')
        deps.json(res, 200, { ok: true, data: deps.store.provisionAi(body, { memberId: fresh.member.memberId, role: fresh.member.role }) })
      } else if (req.method === 'GET') {
        const workspaceId = url.searchParams.get('workspaceId')
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 10
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new WorkspaceWorkError(400, 'invalid', 'Page limit must be 1–50')
        if (!workspaceId) {
          const offset = Number(url.searchParams.get('cursor') ?? 0)
          if (!Number.isSafeInteger(offset) || offset < 0) throw new WorkspaceWorkError(400, 'invalid', 'Invalid directory cursor')
          const all = deps.store.directory(auth.member)
          const memberOffset = Number(url.searchParams.get('memberCursor') ?? 0)
          if (!Number.isSafeInteger(memberOffset) || memberOffset < 0) throw new WorkspaceWorkError(400, 'invalid', 'Invalid member cursor')
          // Directory is the team's existing member directory, not project contents or secrets.
          const members = deps.members()
          deps.json(res, 200, { ok: true, data: { kind: 'directory', actor: { memberId: auth.member.memberId, canRegister: auth.member.role === 'admin' }, workspaces: all.slice(offset, offset + limit), members: members.slice(memberOffset, memberOffset + limit), page: { total: all.length, hasMore: offset + limit < all.length, nextCursor: offset + limit < all.length ? String(offset + limit) : null }, membersPage: { total: members.length, hasMore: memberOffset + limit < members.length, nextCursor: memberOffset + limit < members.length ? String(memberOffset + limit) : null } } })
        } else {
          const history = url.searchParams.get('history')
          if (history) {
            if (history !== 'submissions' && history !== 'decisions') throw new WorkspaceWorkError(400, 'invalid', 'Unknown task history')
            deps.json(res, 200, { ok: true, data: deps.store.history(workspaceId, url.searchParams.get('taskId') ?? '', auth.member, history, url.searchParams.get('cursor') ?? undefined, limit) })
            return true
          }
          const collection = url.searchParams.get('collection') ?? undefined
          if (collection && !['profiles', 'departments', 'tasks', 'events'].includes(collection)) throw new WorkspaceWorkError(400, 'invalid', 'Unknown collection')
          const data = deps.store.read(workspaceId, auth.member, { collection: collection as WorkCollection | undefined, cursor: url.searchParams.get('cursor') ?? undefined, limit, taskId: url.searchParams.get('taskId') ?? undefined })
          const memberOffset = Number(url.searchParams.get('memberCursor') ?? 0)
          if (!Number.isSafeInteger(memberOffset) || memberOffset < 0) throw new WorkspaceWorkError(400, 'invalid', 'Invalid member cursor')
          const members = deps.members().filter(m => data.workspace.memberIds.includes(m.memberId))
          deps.json(res, 200, { ok: true, data: { ...data, actor: { ...data.actor, canWrite: auth.member.role !== 'viewer' }, members: members.slice(memberOffset, memberOffset + limit), membersPage: { total: members.length, hasMore: memberOffset + limit < members.length, nextCursor: memberOffset + limit < members.length ? String(memberOffset + limit) : null } } })
        }
      } else if (req.method === 'POST' && !url.search) {
        body = await deps.readBody(req, 96_000, { reserveBytes: 96_000, memberId: auth.member.memberId })
        const fresh = deps.authenticate(req)
        if (!fresh || fresh.member.memberId !== auth.member.memberId || fresh.deviceId !== auth.deviceId) throw new WorkspaceWorkError(401, 'unauthorized', 'Team Space session changed')
        // No await between the current-principal check and atomic mutation.
        deps.json(res, 200, { ok: true, data: deps.store.command(body, { memberId: fresh.member.memberId, role: fresh.member.role }) })
      } else { deps.drain(req); deps.json(res, 405, { ok: false, code: 'method_not_allowed', error: 'Use GET or POST' }) }
    } catch (error) {
      deps.json(res, error instanceof WorkspaceWorkError ? error.status : 503, { ok: false, code: error instanceof WorkspaceWorkError ? error.code : 'unavailable', error: error instanceof WorkspaceWorkError ? error.message : 'Workspace work request could not be completed' })
    } finally { deps.releaseBody(body) }
    return true
  }
}
