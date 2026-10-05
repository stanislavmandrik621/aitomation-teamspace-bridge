import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecordTeamworkHttpDeps } from './record-teamwork-http.js';
import { resolveRecordTeamworkIdentity, recordTeamworkAuthority } from './record-teamwork-authority.js';
import { referenceClock } from './content-reference-data.js';
import type { RecordTreeOrder } from './record-tree-store.js';
import type { ModulesSyncOp } from './index.js';
export function createRecordTreeHttpHandler(deps: RecordTeamworkHttpDeps) {
    let lastWall = 0, counter = 0;
    return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
        if (url.pathname !== '/api/record-tree/reorder')
            return false;
        let body: unknown;
        try {
            const auth = deps.authenticate(req);
            if (!auth)
                throw Error('Current team session required');
            if (req.method !== 'POST')
                throw Error('Use POST to move records');
            if (!deps.takeWrite(auth.member.memberId)) {
                res.setHeader('Retry-After', String(deps.retryAfterSeconds?.(auth.member.memberId) ?? 1));
                deps.json(res, 429, { ok: false, error: 'Too many moves; retry shortly' });
                return true;
            }
            body = await deps.readBody(req, 2 * 1024 * 1024, { reserveBytes: 2 * 1024 * 1024, memberId: auth.member.memberId });
            const fresh = deps.authenticate(req);
            if (!fresh || fresh.member.memberId !== auth.member.memberId || fresh.deviceId !== auth.deviceId)
                throw Error('The team session changed');
            deps.assertWritable();
            if (!body || typeof body !== 'object' || Array.isArray(body))
                throw Error('Invalid reorder request');
            const args = body as {
                teamId: string;
                entityId: string;
                moduleId: string;
                commandId: string;
                order: RecordTreeOrder[];
            };
            if (Object.keys(args).some(k => !['teamId', 'entityId', 'moduleId', 'commandId', 'order'].includes(k)) || args.teamId !== deps.teamId() || typeof args.commandId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.commandId) || !Array.isArray(args.order) || !args.order.length || args.order.length > 2000)
                throw Error('Invalid reorder request');
            for (const row of args.order)
                if (!row || typeof row !== 'object' || Object.keys(row).some(k => !['id', 'sort_order', 'parent_id', 'prev_sort_order', 'prev_parent_id'].includes(k)) || !Object.hasOwn(row, 'prev_parent_id'))
                    throw Error('Reload the current tree before moving records');
            const identity = resolveRecordTeamworkIdentity(deps.store, args.teamId, args.order[0].id, fresh.member);
            if (identity.moduleId !== args.moduleId || identity.entityId !== args.entityId)
                throw Error('The module for this move changed');
            for (const row of args.order) {
                const target = resolveRecordTeamworkIdentity(deps.store, args.teamId, row.id, fresh.member);
                if (target.moduleId !== identity.moduleId || target.entityId !== identity.entityId || !recordTeamworkAuthority(deps.store, target, fresh.member, deps.departmentExists).canWrite)
                    throw Error('You cannot move these records');
            }
            const fingerprint = createHash('sha256').update(JSON.stringify([fresh.member.memberId, args])).digest('hex');
            const repeated = deps.store.recordTree.receipt(args.commandId, fingerprint);
            const probe = { protocolVersion: 2, opId: args.commandId, kind: 'cascade.patch', targetKind: 'record', targetId: args.order[0].id, entityId: identity.entityId, moduleId: identity.moduleId, hopCount: 0, hlc: '', originDevice: fresh.deviceId, originMemberId: fresh.member.memberId, originMemberName: fresh.member.displayName, originRole: fresh.member.role, teamId: args.teamId, team_id: args.teamId, patch: { reorderKind: 'record', entityId: identity.entityId, order: args.order } } as ModulesSyncOp;
            probe.contentAclRevision = deps.store.contentAccess.revision(probe);
            const refusal = deps.store.contentAccess.authorize(probe, fresh.member.memberId, fresh.member.role) || deps.fieldRefusal(probe, fresh.member);
            if (refusal)
                throw Error(refusal);
            if (repeated) {
                deps.json(res, 200, { ok: true, data: { commandId: args.commandId, opId: repeated.opId, teamId: args.teamId, entityId: args.entityId, updated: (repeated.patch?.order as unknown[])?.length ?? 0, staleSkipped: Number(repeated.patch?.treeStaleSkipped) || 0 } });
                return true;
            }
            if (deps.store.hasSeenOpId(args.commandId))
                throw Error('This move identity was already used');
            const prepared = deps.store.recordTree.prepare(identity.entityId, args.order);
            if (!prepared.order.length) {
                deps.json(res, 200, { ok: true, data: { commandId: args.commandId, opId: null, teamId: args.teamId, entityId: args.entityId, updated: 0, staleSkipped: prepared.staleSkipped } });
                return true;
            }
            const clocks = args.order.flatMap(row => { const n = deps.store.recordTree.node(row.id); return [referenceClock(n?.parentHlc), referenceClock(n?.sortHlc)].filter(Boolean) as Array<[
                number,
                number,
                string
            ]>; });
            const wall = Math.max(Date.now(), lastWall, ...clocks.map(c => c[0]));
            counter = Math.max(wall === lastWall ? counter + 1 : 0, ...clocks.filter(c => c[0] === wall).map(c => c[1] + 1));
            lastWall = wall;
            if (!Number.isSafeInteger(counter))
                throw Error('The record clock cannot advance safely');
            const op = { ...probe, hlc: `${wall}:${counter}:record-tree`, patch: { ...probe.patch, order: prepared.order, serverTreeReorder: true, treeRequestFingerprint: fingerprint, treeStaleSkipped: prepared.staleSkipped } };
            const saved = deps.store.appendOps([op], { recordTree: true });
            if (saved.accepted.length !== 1)
                throw Error('This move was not saved');
            deps.publish(saved.accepted);
            deps.json(res, 200, { ok: true, data: { commandId: args.commandId, opId: op.opId, teamId: args.teamId, entityId: args.entityId, updated: prepared.order.length, staleSkipped: prepared.staleSkipped } });
        }
        catch (error) {
            deps.json(res, 409, { ok: false, error: error instanceof Error ? error.message : 'The move could not be confirmed' });
        }
        finally {
            if (body !== undefined)
                deps.releaseBody(body);
            deps.drain(req);
        }
        return true;
    };
}
