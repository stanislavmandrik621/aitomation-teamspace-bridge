/** Accepted record hierarchy, rebuilt from the WAL and checkpointed before pruning. */
import { existsSync, openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { ContentAccessStorage, type AuthorityEntry } from './content-access-storage.js';
import type { AtRestKey } from './at-rest.js';
import type { ModulesSyncOp } from './index.js';
import { compareYjsCellHlc } from './record-teamwork-yjs.js';
export type RecordTreeNode = {
    id: string;
    entityId: string;
    parentId: string | null;
    parentHlc: string;
    sortOrder?: number;
    sortHlc: string;
    deleted: boolean;
    lifeHlc: string;
    previousParentId?: string | null;
};
export type RecordTreeOrder = {
    id: string;
    sort_order: number;
    parent_id?: string | null;
    prev_sort_order?: number;
    prev_parent_id?: string | null;
};
const own = (value: object, key: string) => Object.hasOwn(value, key);
const parent = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const newer = (incoming: string, current: string) => !current || compareYjsCellHlc(incoming, current) > 0;
export class RecordTreeStore {
    private nodes = new Map<string, RecordTreeNode>();
    private receipts = new Map<string, {
        fingerprint: string;
        op: ModulesSyncOp;
    }>();
    private pending = new Map<string, AuthorityEntry>();
    private storage: ContentAccessStorage | null = null;
    private unavailable = false;
    constructor(root: string, atRest: AtRestKey | null) { try {
        const directory = join(root, 'record-tree'), database = join(directory, 'content-access.sqlite'), marker = join(root, 'record-tree.initialized');
        if (existsSync(marker) && !existsSync(database))
            throw Error('Missing record tree checkpoint');
        this.storage = new ContentAccessStorage(directory, atRest, existsSync(database));
        for (const row of this.storage.load()) {
            if (row.kind === 'node') {
                const n = row.value as RecordTreeNode;
                if (n.id !== row.key || typeof n.entityId !== 'string' || typeof n.parentHlc !== 'string')
                    throw Error('Invalid record tree checkpoint');
                this.nodes.set(row.key, n);
            }
            else if (row.kind === 'receipt')
                this.receipts.set(row.key, row.value as {
                    fingerprint: string;
                    op: ModulesSyncOp;
                });
        }
        if (!existsSync(marker)) {
            const fd = openSync(marker, 'wx', 0o600);
            try {
                writeFileSync(fd, '1');
                fsyncSync(fd);
            }
            finally {
                closeSync(fd);
            }
        }
    }
    catch {
        this.unavailable = true;
    } }
    healthy() { return !this.unavailable; }
    private assert() { if (!this.healthy())
        throw Error('Record hierarchy is unavailable; reconnect and retry'); }
    private changed(n: RecordTreeNode) { this.nodes.set(n.id, n); this.pending.set('node:' + n.id, { kind: 'node', key: n.id, value: n }); }
    receipt(commandId: string, fingerprint: string) { this.assert(); const r = this.receipts.get(commandId); if (r && r.fingerprint !== fingerprint)
        throw Error('This reorder command was already used for another change'); return r?.op; }
    node(id: string) { this.assert(); const row = this.nodes.get(id); return row ? { ...row } : undefined; }
    prepare(entityId: string, order: RecordTreeOrder[]): {
        order: RecordTreeOrder[];
        staleSkipped: number;
    } {
        this.assert();
        const accepted: RecordTreeOrder[] = [], seen = new Set<string>();
        let staleSkipped = 0;
        for (const item of order) {
            if (!item || typeof item.id !== 'string' || seen.has(item.id) || !Number.isFinite(item.sort_order))
                throw Error('Invalid or duplicate record reorder item');
            seen.add(item.id);
            const current = this.nodes.get(item.id);
            if (!current || current.deleted || current.entityId !== entityId)
                throw Error('A record in this move is unavailable');
            const previousParent = own(item, 'prev_parent_id') ? parent(item.prev_parent_id) : undefined;
            if (previousParent !== undefined && previousParent !== current.parentId || item.prev_sort_order !== undefined && current.sortOrder !== undefined && item.prev_sort_order !== current.sortOrder) {
                staleSkipped++;
                continue;
            }
            const nextParent = own(item, 'parent_id') ? parent(item.parent_id) : current.parentId;
            if (nextParent) {
                const target = this.nodes.get(nextParent);
                if (!target || target.deleted || target.entityId !== entityId)
                    throw Error('The target parent is unavailable');
            }
            accepted.push({ ...item, parent_id: nextParent, prev_parent_id: current.parentId, ...(current.sortOrder !== undefined ? { prev_sort_order: current.sortOrder } : {}) });
        }
        const changes = new Map(accepted.map(item => [item.id, item.parent_id ?? null]));
        this.validateParents(entityId, changes);
        return { order: accepted, staleSkipped };
    }
    private validateParents(entityId: string, changes: Map<string, string | null>) {
        for (const id of changes.keys()) {
            const seen = new Set<string>();
            let cursor: string | null = id, depth = 0;
            while (cursor) {
                if (seen.has(cursor))
                    throw Error('This change would create a loop in the record tree');
                seen.add(cursor);
                if (++depth > 128)
                    throw Error('This record tree is too deep');
                const row = this.nodes.get(cursor);
                if (!row || row.deleted || row.entityId !== entityId)
                    break;
                cursor = changes.has(cursor) ? changes.get(cursor)! : row.parentId;
            }
        }
    }
    /** Called before appending legacy WebSocket reorders too, so bypassing HTTP cannot admit a loop. */
    validateCommit(ops: ModulesSyncOp[]) {
        if (!ops.some(op => op.kind === 'cascade.patch' && op.patch?.reorderKind === 'record' || ['record.create', 'record.update'].includes(op.kind) && (own(op.patch ?? {}, 'parent_id') || own(op.patch ?? {}, 'parentId'))))
            return;
        this.assert();
        const scratch = new RecordTreeStoreProjection(this.nodes);
        for (const op of ops) {
            if (op.kind === 'cascade.patch' && op.patch?.reorderKind === 'record') {
                const entityId = String(op.entityId ?? op.patch.entityId ?? '');
                const raw = op.patch.order;
                if (!Array.isArray(raw))
                    throw Error('Invalid record reorder');
                scratch.validate(entityId, raw as RecordTreeOrder[]);
            }
            else if (['record.create', 'record.update'].includes(op.kind))
                scratch.validateParentWrite(op);
            scratch.observe(op);
        }
    }
    observe(op: ModulesSyncOp) { if (!this.healthy())
        return; const scratch = new RecordTreeStoreProjection(this.nodes); for (const n of scratch.observe(op))
        this.changed(n); if (op.patch?.serverTreeReorder === true && typeof op.patch.treeRequestFingerprint === 'string') {
        const value = { fingerprint: op.patch.treeRequestFingerprint, op };
        this.receipts.set(op.opId, value);
        this.pending.set('receipt:' + op.opId, { kind: 'receipt', key: op.opId, value });
    } }
    flush() { this.assert(); try {
        if (this.pending.size)
            this.storage!.write(this.pending.values());
        this.pending.clear();
    }
    catch (error) {
        this.unavailable = true;
        throw error;
    } }
}
/** Temporary projection permits atomic validation of multiple operations without publishing them. */
class RecordTreeStoreProjection {
    constructor(private base: Map<string, RecordTreeNode>) { }
    private changed = new Map<string, RecordTreeNode>();
    private get(id: string) { return this.changed.get(id) ?? this.base.get(id); }
    validateParentWrite(op: ModulesSyncOp) { const p = op.patch ?? {}; if (!own(p, 'parent_id') && !own(p, 'parentId'))
        return; const existing = this.get(op.targetId), entityId = String(op.entityId ?? p.entityId ?? existing?.entityId ?? ''); const ph = typeof p.parentHlc === 'string' ? p.parentHlc : op.hlc; if (existing && !newer(ph, existing.parentHlc))
        return; if (!existing) {
        if (op.kind !== 'record.create')
            return;
        this.changed.set(op.targetId, { id: op.targetId, entityId, parentId: null, parentHlc: '', sortHlc: '', deleted: false, lifeHlc: '' });
    } this.validate(entityId, [{ id: op.targetId, sort_order: existing?.sortOrder ?? 0, parent_id: parent(own(p, 'parent_id') ? p.parent_id : p.parentId) }], op.kind === 'record.create'); }
    validate(entityId: string, order: RecordTreeOrder[], allowPendingParent = false) { const changes = new Map<string, string | null>(); for (const item of order) {
        const row = this.get(item.id);
        if (!row || row.deleted || row.entityId !== entityId)
            throw Error('A record in this move is unavailable');
        if (own(item, 'prev_parent_id') && parent(item.prev_parent_id) !== row.parentId)
            throw Error('The tree changed; start the move again');
        if (own(item, 'parent_id')) {
            const target = parent(item.parent_id);
            if (target) {
                const p = this.get(target);
                if ((!p && !allowPendingParent) || p && (p.deleted || p.entityId !== entityId))
                    throw Error('The target parent is unavailable');
            }
            changes.set(item.id, target);
        }
    } for (const id of changes.keys()) {
        let cursor: string | null = id;
        const seen = new Set<string>();
        while (cursor) {
            if (seen.has(cursor))
                throw Error('This change would create a loop in the record tree');
            seen.add(cursor);
            if (seen.size > 128)
                throw Error('This record tree is too deep');
            const row = this.get(cursor);
            if (!row || row.deleted || row.entityId !== entityId)
                break;
            cursor = changes.has(cursor) ? changes.get(cursor)! : row.parentId;
        }
    } }
    observe(op: ModulesSyncOp): RecordTreeNode[] {
        const patch = op.patch ?? {}, result: RecordTreeNode[] = [];
        const put = (id: string, entityId: string, p: Record<string, unknown>, isCreate = false, isDelete = false) => {
            if (!id || !entityId)
                return;
            const previous = this.get(id);
            if (!previous && !isCreate)
                return;
            const n = { ...(previous ?? { id, entityId, parentId: null, parentHlc: '', sortHlc: '', deleted: false, lifeHlc: '' }) };
            if (n.entityId !== entityId)
                return;
            if ((isCreate || isDelete) && newer(op.hlc, n.lifeHlc)) {
                n.deleted = isDelete;
                n.lifeHlc = op.hlc;
            }
            const ph = typeof p.parentHlc === 'string' ? p.parentHlc : op.hlc;
            if ((own(p, 'parent_id') || own(p, 'parentId')) && newer(ph, n.parentHlc)) {
                n.parentId = parent(own(p, 'parent_id') ? p.parent_id : p.parentId);
                n.parentHlc = ph;
                if (!isCreate)
                    n.previousParentId = null;
            }
            if (typeof p.sort_order === 'number' && Number.isFinite(p.sort_order) && newer(op.hlc, n.sortHlc)) {
                n.sortOrder = p.sort_order;
                n.sortHlc = op.hlc;
            }
            if (previous && JSON.stringify(previous) === JSON.stringify(n))
                return;
            this.changed.set(id, n);
            result.push(n);
        };
        const lifecycle = ['record.delete', 'record.trash', 'record.purge', 'record.restore'].includes(op.kind);
        const before = this.get(op.targetId);
        const lifecycleAccepted = lifecycle && before && newer(op.hlc, before.lifeHlc);
        if (['record.create', 'record.update', 'record.delete', 'record.trash', 'record.purge', 'record.restore'].includes(op.kind)) {
            put(op.targetId, String(op.entityId ?? patch.entityId ?? before?.entityId ?? ''), patch, op.kind === 'record.create' || op.kind === 'record.restore', ['record.delete', 'record.trash', 'record.purge'].includes(op.kind));
        }
        // Native lifecycle operations also change child links. Mirror those effects
        // even when no explicit child update follows (trash and restore, in particular).
        if (lifecycleAccepted) {
            const rows = () => [...new Map([...this.base, ...this.changed]).values()];
            const move = (row: RecordTreeNode, target: string | null, previousParentId: string | null) => {
                if (!newer(op.hlc, row.parentHlc) && !(op.kind === 'record.restore' && op.hlc === row.parentHlc))
                    return;
                const next = { ...row, parentId: target, previousParentId, parentHlc: op.hlc, sortHlc: op.hlc };
                // Native promotion appends after siblings. Old snapshots did not contain
                // sort_order, so do not invent an authoritative sort preimage for them.
                // Hard deletion promotes before removing the parent in SQLite; that
                // parent's sort position still participates in the sibling maximum.
                const siblings = rows().map(n => n.id === before.id && ['record.delete', 'record.purge'].includes(op.kind) ? before : n)
                    .filter(n => n.id !== row.id && n.entityId === row.entityId && !n.deleted && n.parentId === target);
                next.sortOrder = siblings.every(n => n.sortOrder !== undefined)
                    ? (siblings.length ? Math.max(...siblings.map(n => n.sortOrder!)) : -1) + 1 : undefined;
                this.changed.set(next.id, next);
                result.push(next);
            };
            if (op.kind !== 'record.restore') {
                const trash = op.kind === 'record.trash';
                const children = rows().filter(n => n.parentId === before.id && (!trash || !n.deleted))
                    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id));
                for (const child of children)
                    move(child, trash ? null : before.parentId, trash ? before.id : child.previousParentId ?? null);
            }
            else {
                let restored = this.get(before.id)!;
                if (restored.parentId) {
                    const target = this.get(restored.parentId);
                    if (!target || target.deleted) {
                        move(restored, null, restored.previousParentId ?? restored.parentId);
                        restored = this.get(before.id)!;
                    }
                }
                const reclaim = (row: RecordTreeNode, targetId: string) => {
                    const target = this.get(targetId);
                    if (!target || target.deleted || target.entityId !== row.entityId)
                        return;
                    try {
                        this.validate(row.entityId, [{ id: row.id, sort_order: row.sortOrder ?? 0, parent_id: targetId }]);
                    }
                    catch {
                        return;
                    }
                    move(row, targetId, null);
                };
                if (!restored.parentId && restored.previousParentId)
                    reclaim(restored, restored.previousParentId);
                for (const child of rows())
                    if (!child.deleted && child.parentId === null && child.previousParentId === before.id)
                        reclaim(child, before.id);
            }
        }
        if (op.kind === 'cascade.patch' && patch.reorderKind === 'record' && Array.isArray(patch.order))
            for (const row of patch.order)
                if (row && typeof row === 'object')
                    put(String(row.id ?? ''), String(op.entityId ?? patch.entityId ?? ''), row);
        return result;
    }
}
