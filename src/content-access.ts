/** Current item authority. The durable ops log is the write-ahead source;
 * this checkpoint survives log retention and is repaired from newer log rows
 * on startup. A failed checkpoint freezes access and prevents log pruning.
 */
import { existsSync, readFileSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'
import type { ModulesSyncOp, BridgeRole } from './index.js'
import { ContentAccessStorage, authoritySlot, type AuthorityEntry } from './content-access-storage.js'
import { referenceCells, referenceCellSlug, referenceCellClock, referenceClock, newerReferenceClock } from './content-reference-data.js'

type Item = { audience: string[] | null; denied: string[]; revision: number; deleted: boolean }
type Field = { entity: string; slug: string; type?: string; multiple?: boolean; previousSlug?: string; previousSlugs?: string[] }
type State = { version: 1; items: Record<string, Item>; targets: Record<string, string>; blobs: Record<string, string[]>; uploads: Record<string, string[]>; controls: string[]; composeHttpRevisions?: Record<string, number> }
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
const CHECKPOINT_BYTES_MAX = 128 * 1024 * 1024
const bag = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
/** Match the desktop's legacy payload precedence, then emit only one bag. */
export function canonicalContentOp(op: ModulesSyncOp): ModulesSyncOp {
  const raw = op as ModulesSyncOp & { payload?: unknown; payload_json?: unknown }
  let patch: unknown = raw.patch ?? raw.payload
  if (raw.payload_json != null && raw.payload_json !== '') {
    if (typeof raw.payload_json !== 'string') throw new Error('Invalid legacy payload')
    patch = JSON.parse(raw.payload_json)
  }
  if (patch != null && (typeof patch !== 'object' || Array.isArray(patch))) throw new Error('Invalid content patch')
  const { payload: _payload, payload_json: _json, ...rest } = raw
  return { ...rest, ...(patch != null ? { patch: patch as Record<string, unknown> } : {}) }
}
function id(v: unknown): string { return typeof v === 'string' && v.trim().length <= 128 && !v.includes('\0') && v.isWellFormed() ? v.trim() : '' }
function cascadeFamily(op: ModulesSyncOp): string {
  const p = bag(op.patch)
  if (p.action === 'rename_field_slug') return 'field'
  return ['module', 'entity', 'field', 'view', 'record'].includes(String(p.reorderKind)) ? String(p.reorderKind) : ''
}
function targetKey(op: ModulesSyncOp): string {
  const family = op.kind === 'cascade.patch' ? cascadeFamily(op) : op.kind.startsWith('compose.') ? 'compose' : op.kind.split('.')[0]
  return `${family}:${id(op.targetId)}`
}
function rootKey(op: ModulesSyncOp): string {
  return /^(module|playbook|compose)\./.test(op.kind) ? targetKey(op) : ''
}
function audience(op: ModulesSyncOp): string[] | null {
  const p = bag(canonicalContentOp(op).patch)
  const raw = own(op, 'visibleToMemberIds') ? op.visibleToMemberIds : p.visibleToMemberIds
  if (raw === undefined) return null
  if (!Array.isArray(raw) || raw.length > 500 || raw.some(v => !id(v))) throw new Error('Invalid member audience')
  return [...new Set(raw.map(id))].sort()
}
export function contentBlobHashes(value: unknown): string[] {
  const hashes = new Set<string>()
  let nodes = 0
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error('Content references exceed safety limits')
    if (!v || typeof v !== 'object') return
    const b = bag(v)
    if (own(b, '__teamspaceBlob')) {
      const sha = typeof b.__teamspaceBlob === 'string' ? b.__teamspaceBlob.trim().toLowerCase() : ''
      if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('Invalid attachment reference')
      hashes.add(sha)
    }
    for (const child of Object.values(v)) visit(child, depth + 1)
  }
  visit(value, 0)
  return [...hashes]
}

export class ContentAccessIndex {
  private state: State = { version: 1, items: {}, targets: {}, blobs: {}, uploads: {}, controls: [] }
  private controls = new Set<string>()
  private processed = new Set<string>()
  private references: Record<string, Record<string, string[]>> = Object.create(null)
  private parents: Record<string, string> = Object.create(null)
  private deletedTargets = new Set<string>()
  private notices: Record<string, ModulesSyncOp> = Object.create(null)
  private cellClocks: Record<string, Record<string, string>> = Object.create(null)
  private fields: Record<string, Field> = Object.create(null)
  private retiredCells: Record<string, string[]> = Object.create(null)
  private memberIds: () => string[] = () => []
  private repairCleanup = false
  private changes = new Map<string, AuthorityEntry>()
  private storage?: ContentAccessStorage
  private migrated = false
  private dirty = false
  private unavailable = false
  private readonly backupAuthorityInstance = randomBytes(16).toString('hex')
  private backupAuthorityRevision = 0
  private composeAccessCheck?: (documentId: string, memberId: string) => boolean
  private fieldAccessCheck?: (entityId: string, fieldSlug: string | undefined, role: BridgeRole, action: 'read' | 'write' | 'create' | 'delete') => boolean
  private privateFieldsCheck?: (entityId: string, role: BridgeRole) => boolean
  private fieldIdentityLookup: Map<string, Map<string, string>> | null = null
  private readonly path: string
  private readonly initialized: string
  constructor(private root: string, private atRest: AtRestKey | null) {
    this.path = join(root, 'content-access.json')
    this.initialized = join(root, 'content-access.initialized')
    try {
      if (existsSync(this.path)) {
        if (statSync(this.path).size > CHECKPOINT_BYTES_MAX) throw new Error('Content authority checkpoint exceeds safety limit')
        const text = readFileSync(this.path, 'utf8')
        const loaded = decryptJsonFile<State | { version: 2; storage: string; referenceVersion?: number } | null>(atRest, text, null)
        if (!loaded) throw new Error('Unreadable content authority')
        if (loaded.version === 2) {
          if (loaded.storage !== 'sqlite') throw new Error('Invalid authority storage')
          if (loaded.referenceVersion !== undefined && loaded.referenceVersion !== 2) throw new Error('Unsupported authority reference version')
          this.storage = new ContentAccessStorage(root, atRest, true)
          for (const entry of this.storage.load()) this.loadEntry(entry)
          this.migrated = true
          if (loaded.referenceVersion !== 2) {
            this.repairCleanup = true
            // Earlier reference checkpoints had no cell ordering/schema proof.
            // Rebuild from retained WAL; never reuse possibly phantom grants.
            for (const kind of ['references', 'cellClocks', 'fields', 'retiredCells'] as const) {
              for (const key of Object.keys(this[kind])) this.changed(kind, key, undefined)
              this[kind] = Object.create(null)
            }
            for (const key of Object.keys(this.state.blobs)) this.changed('blobs', key, undefined)
            this.state.blobs = {}
            for (const key of this.processed) this.changed('processed', key, undefined)
            this.processed.clear()
            this.dirty = true
          }
          this.retireLegacyCascadeReferences()
          return
        }
        if (loaded.version !== 1 || !loaded.items || !loaded.targets || !loaded.blobs || !loaded.uploads || !Array.isArray(loaded.controls)) throw new Error('Invalid content authority')
        for (const object of [loaded.items, loaded.targets, loaded.blobs, loaded.uploads]) {
          if (typeof object !== 'object' || Array.isArray(object)) throw new Error('Invalid content authority map')
        }
        for (const item of Object.values(loaded.items)) {
          if (!item || !(item.audience === null || Array.isArray(item.audience)) || !Array.isArray(item.denied) || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.deleted !== 'boolean') throw new Error('Invalid content grant')
          if ((item.audience ?? []).some(member => !id(member)) || item.denied.some(member => !id(member))) throw new Error('Invalid content member identity')
        }
        if (Object.values(loaded.targets).some(key => typeof key !== 'string')
          || Object.values(loaded.blobs).some(refs => !Array.isArray(refs) || refs.some(key => typeof key !== 'string'))
          || Object.values(loaded.uploads).some(owners => !Array.isArray(owners) || owners.some(owner => !id(owner)))
          || loaded.controls.some(control => typeof control !== 'string')) throw new Error('Invalid content reference index')
        this.state = loaded
        this.repairCleanup = true
        if (loaded.composeHttpRevisions !== undefined && (!loaded.composeHttpRevisions || typeof loaded.composeHttpRevisions !== 'object'
          || Array.isArray(loaded.composeHttpRevisions) || Object.values(loaded.composeHttpRevisions).some(v => !Number.isSafeInteger(v) || v < 0))) throw new Error('Invalid Compose authority revisions')
        this.controls = new Set(loaded.controls)
        // Legacy blob grants were historical root relationships, not current
        // references. Reconstruct only provable references from retained WAL;
        // unavailable historical ownership must not silently keep granting.
        this.state.blobs = {}
        // Old checkpoints retained denials but not cleanup receipts. Recover
        // content-free notices even when the corresponding WAL was pruned.
        for (const [itemKey, item] of Object.entries(loaded.items)) {
          const split = itemKey.indexOf(':')
          const family = itemKey.slice(0, split), targetId = itemKey.slice(split + 1)
          const base = { targetId, targetKind: family === 'compose' ? 'compose_doc' : family,
            originRole: 'admin' as const, originMemberId: 'bridge-access-control', originDevice: 'bridge-access-control',
            hlc: '0:0:bridge-access-control', protocolVersion: 2, hopCount: 0, patch: { id: targetId, authoritativeDelete: true },
            ...(family === 'module' ? { moduleId: targetId } : {}) }
          for (let offset = 0; offset < item.denied.length; offset += 500) {
            const opId = `acl-recovery:${createHash('sha256').update(JSON.stringify([itemKey, item.revision, offset])).digest('hex')}`
            this.notices[opId] = { ...base, opId, kind: `${family}.share_revoked`, visibleToMemberIds: item.denied.slice(offset, offset + 500) }
          }
          if (item.deleted) {
            const opId = `acl-delete:${createHash('sha256').update(JSON.stringify([itemKey, item.revision])).digest('hex')}`
            this.notices[opId] = { ...base, opId, kind: family === 'compose' ? 'compose.doc.delete' : `${family}.delete`,
              ...(item.audience !== null ? { visibleToMemberIds: item.audience } : {}) }
          }
        }
      } else if (existsSync(this.initialized)) throw new Error('Content authority checkpoint missing')
    } catch { this.unavailable = true }
  }
  private loadEntry({ kind, key, value }: AuthorityEntry): void {
    if (kind === 'controls' || kind === 'processed' || kind === 'deletedTargets') {
      if (value !== true) throw new Error('Invalid authority marker')
      this[kind].add(key)
    } else if (kind === 'retiredCells') {
      if (!Array.isArray(value) || value.some(slug => typeof slug !== 'string' || !referenceCellSlug(slug))) throw new Error('Invalid retired field keys')
      this.retiredCells[key] = value
    } else if (kind === 'references' || kind === 'parents' || kind === 'notices' || kind === 'cellClocks' || kind === 'fields') {
      if (!value || (kind === 'parents' ? typeof value !== 'string' : typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid authority relationship')
      if (kind === 'references' && Object.values(value as object).some(hashes => !Array.isArray(hashes) || hashes.some(sha => typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)))) throw new Error('Invalid reference cells')
      if (kind === 'cellClocks' && Object.values(value as object).some(clock => !referenceClock(clock))) throw new Error('Invalid reference clocks')
      if (kind === 'fields') {
        const field = value as { entity?: unknown; slug?: unknown; type?: unknown; previousSlug?: unknown; previousSlugs?: unknown }
        if (typeof field.entity !== 'string' || !field.entity.startsWith('entity:') || !id(field.entity.slice(7))
          || typeof field.slug !== 'string' || !referenceCellSlug(field.slug) || field.type !== undefined && typeof field.type !== 'string'
          || field.previousSlug !== undefined && (typeof field.previousSlug !== 'string' || !referenceCellSlug(field.previousSlug))
          || field.previousSlugs !== undefined && (!Array.isArray(field.previousSlugs) || field.previousSlugs.some(slug => typeof slug !== 'string' || !referenceCellSlug(slug)))) throw new Error('Invalid reference field')
      }
      if (kind === 'notices') {
        const notice = value as ModulesSyncOp
        if (typeof notice.opId !== 'string' || !notice.opId || typeof notice.kind !== 'string'
          || !(notice.kind.endsWith('.delete') || notice.kind.endsWith('.share_revoked') || notice.kind === 'record.purge')
          || !id(notice.targetId) || !['admin', 'member'].includes(String(notice.originRole))) throw new Error('Invalid cleanup notice')
        audience(notice)
      }
      Object.assign(this[kind], { [key]: value })
    } else if (['items', 'targets', 'blobs', 'uploads', 'composeHttpRevisions'].includes(kind)) {
      if (kind === 'items') {
        const item = value as Item
        if (!item || !(item.audience === null || Array.isArray(item.audience)) || !Array.isArray(item.denied)
          || !Number.isSafeInteger(item.revision) || item.revision < 0 || typeof item.deleted !== 'boolean'
          || (item.audience ?? []).some(v => !id(v)) || item.denied.some(v => !id(v))) throw new Error('Invalid content grant')
      } else if (kind === 'targets' ? typeof value !== 'string'
        : kind === 'composeHttpRevisions' ? !Number.isSafeInteger(value) || Number(value) < 0
          : !Array.isArray(value) || value.some(v => typeof v !== 'string')) throw new Error('Invalid authority value')
      const state = this.state as unknown as Record<string, Record<string, unknown>>
      state[kind] ??= Object.create(null)
      state[kind][key] = value
    } else throw new Error('Unknown authority entry')
  }
  private changed(kind: string, key: string, value: unknown): void {
    if (['items','targets','parents','deletedTargets','fields','retiredCells','composeHttpRevisions','blobs','references'].includes(kind)) this.backupAuthorityRevision++
    if (kind === 'fields' || kind === 'deletedTargets' || kind === 'retiredCells') this.fieldIdentityLookup = null
    this.changes.set(authoritySlot(kind, key), { kind, key, value })
    this.dirty = true
  }
  /** Old cascade:* entries described command metadata, never attachment cells. */
  private retireLegacyCascadeReferences(): void {
    for (const [sha, targets] of Object.entries(this.state.blobs)) {
      const real = targets.filter(target => !target.startsWith('cascade:'))
      if (real.length === targets.length) continue
      if (real.length) this.state.blobs[sha] = real
      else delete this.state.blobs[sha]
      this.changed('blobs', sha, real.length ? real : undefined)
    }
    for (const kind of ['references', 'cellClocks', 'parents'] as const) {
      for (const key of Object.keys(this[kind])) if (key.startsWith('cascade:')) {
        delete this[kind][key]
        this.changed(kind, key, undefined)
      }
    }
    for (const key of Object.keys(this.state.targets)) if (key.startsWith('cascade:')) {
      delete this.state.targets[key]
      this.changed('targets', key, undefined)
    }
  }
  private *allEntries(): Generator<AuthorityEntry> {
    for (const kind of ['items', 'targets', 'blobs', 'uploads', 'composeHttpRevisions'] as const)
      for (const [key, value] of Object.entries(this.state[kind] ?? {})) yield { kind, key, value }
    for (const kind of ['references', 'parents', 'notices', 'cellClocks', 'fields', 'retiredCells'] as const)
      for (const [key, value] of Object.entries(this[kind])) yield { kind, key, value }
    for (const kind of ['controls', 'processed', 'deletedTargets'] as const)
      for (const key of this[kind]) yield { kind, key, value: true }
  }
  cleanupNotices(): ModulesSyncOp[] { return this.healthy() ? Object.values(this.notices) : [] }
  compactReplayIds(retained: Set<string>): void {
    for (const kind of ['processed', 'controls'] as const) for (const key of this[kind]) {
      if (!retained.has(key)) { this[kind].delete(key); this.changed(kind, key, undefined) }
    }
    this.flush()
  }
  healthy(): boolean { return !this.unavailable }
  /** A legacy empty delivery log is not proof that an old client is current. */
  hasLiveModuleContent(): boolean {
    return Object.entries(this.state.items).some(([key,item])=>key.startsWith('module:')&&!item.deleted)
  }
  /** Restart changes the instance, so an old backup check never validates
   * against a rolled-back server checkpoint with the same numeric revision. */
  backupAccessStamp(): string { return `${this.backupAuthorityInstance}:${this.backupAuthorityRevision}` }
  /** Backup readers must prove that a target already exists in durable server
   * lineage. Live create authorization deliberately accepts a claimed parent;
   * using that rule for a backup would let a hidden cached row borrow another
   * module's grant. No parent or role from the archive is accepted here. */
  backupTarget(kind: string, targetId: string, memberId: string, role: BridgeRole): {
    root: string; entityId: string; parent: string; revision: number; privateFields: boolean
  } | null {
    if (kind === 'blob') {
      if (!this.healthy() || !/^[a-f0-9]{64}$/.test(targetId)) return null
      // A local path (or an archive-supplied hash) grants nothing. Require a
      // current, readable, field-aware reference in durable server lineage.
      // Unreferenced uploads and Admin's broad download fallback are excluded.
      for (const target of this.state.blobs[targetId] ?? []) {
        const split = target.indexOf(':')
        const family = target.slice(0, split)
        if (split < 1 || family === 'blob' || !this.blobFieldReadable(target, targetId, role)) continue
        const grant = this.backupTarget(family, target.slice(split + 1), memberId, role)
        if (grant) return grant
      }
      return null
    }
    if (!this.healthy() || !['module', 'entity', 'field', 'view', 'record', 'comment', 'playbook', 'compose'].includes(kind)
      || !targetId || id(targetId) !== targetId) return null
    const target = `${kind}:${targetId}`
    const root = ['module', 'playbook', 'compose'].includes(kind) ? target : this.state.targets[target]
    // Even an Admin must not turn an unknown/deleted target into a readable
    // backup target. Admin recovery of whole server archives is separate.
    if (!root || !this.state.items[root] || this.state.items[root].deleted || !this.targetAvailable(target)
      || !this.admits(root, memberId, role)) return null
    let parent = this.parents[target] ?? ''
    if (parent.startsWith('record:')) parent = this.parents[parent] ?? ''
    const entityId = kind === 'entity' ? targetId : parent.startsWith('entity:') ? parent.slice(7) : ''
    if (['entity', 'field', 'view', 'record', 'comment'].includes(kind)
      && (!entityId || !this.fieldAllows(entityId, role))) return null
    if (kind === 'field') {
      const field = this.fields[target]
      if (!field || [targetId, field.slug, ...(field.previousSlugs ?? []), ...(field.previousSlug ? [field.previousSlug] : [])]
        .some(slug => !this.fieldAllows(entityId, role, slug))) return null
    }
    return { root, entityId, parent: this.parents[target] ?? '', revision: this.state.items[root].revision,
      privateFields: !!entityId && (this.privateFieldsCheck?.(entityId, role) ?? true) }
  }

  setMemberIdsReader(read: () => string[]): void {
    this.memberIds = read
    if (!this.repairCleanup || !this.healthy()) return
    // Older checkpoints could hold a narrowed grant without a matching
    // cleanup operation. Reconcile denied current members during migration.
    const members = read()
    for (const [key, item] of Object.entries(this.state.items)) {
      const removed = members.filter(member => item.deleted || item.denied.includes(member)
        || item.audience !== null && !item.audience.includes(member))
      const split = key.indexOf(':'), family = key.slice(0, split), targetId = key.slice(split + 1)
      for (let offset = 0; offset < removed.length; offset += 500) {
        this.updateNotices({ opId: `acl-repair:${createHash('sha256').update(JSON.stringify([key, item.revision, removed.slice(offset, offset + 500)])).digest('hex')}`,
          kind: `${family}.share_revoked`, targetKind: family === 'compose' ? 'compose_doc' : family, targetId,
          originRole: 'admin', originMemberId: 'bridge-access-control', originDevice: 'bridge-access-control',
          hlc: '0:0:bridge-access-control', protocolVersion: 2, hopCount: 0,
          visibleToMemberIds: removed.slice(offset, offset + 500), patch: { id: targetId, authoritativeDelete: true } }, key)
      }
    }
    this.repairCleanup = false
  }
  setComposeAccessCheck(check: (documentId: string, memberId: string) => boolean): void { this.composeAccessCheck = check }
  setFieldAccessCheck(check: NonNullable<ContentAccessIndex['fieldAccessCheck']>, hasPrivateFields?: (entityId: string, role: BridgeRole) => boolean): void {
    this.fieldAccessCheck = check
    // Unstructured refs need a whole-policy proof, not merely known schema:
    // a hidden grant may precede / outlive its field definition in this index.
    this.privateFieldsCheck = hasPrivateFields ?? (() => true)
  }
  /** Public immutable lineage proof for current field-aware projections. */
  entityForOp(op: ModulesSyncOp): string {
    const target = targetKey(op)
    if (target.startsWith('entity:')) return target.slice(7)
    let parent = this.parents[target]
    if (parent?.startsWith('record:')) parent = this.parents[parent]
    if (parent?.startsWith('entity:')) return parent.slice(7)
    const p = bag(op.patch)
    return id(op.entityId ?? p.entityId ?? p.entity_id)
  }
  resolveFieldSlug(entityId: string, key: string): string | null {
    if (!this.fieldIdentityLookup) {
      this.fieldIdentityLookup = new Map()
      for (const [target, field] of Object.entries(this.fields)) {
        if (this.deletedTargets.has(target)) continue
        const fields = this.fieldIdentityLookup.get(field.entity) ?? new Map<string, string>()
        fields.set(field.slug, field.slug)
        this.fieldIdentityLookup.set(field.entity, fields)
      }
      for (const [target, field] of Object.entries(this.fields)) {
        if (this.deletedTargets.has(target)) continue
        const fields = this.fieldIdentityLookup.get(field.entity)!
        if (!fields.has(target.slice(6))) fields.set(target.slice(6), field.slug)
        for (const alias of [...(field.previousSlugs ?? []), ...(field.previousSlug ? [field.previousSlug] : [])]) if (!fields.has(alias)) fields.set(alias, field.slug)
      }
    }
    const resolved = this.fieldIdentityLookup.get(`entity:${entityId}`)?.get(key)
    if (resolved) return resolved
    return (this.retiredCells[`entity:${entityId}`] ?? []).includes(key) ? null : key
  }
  recordCellHlc(recordId:string,slug:string):string|undefined { return this.cellClocks[`record:${recordId}`]?.[slug] }
  fieldDefinition(entityId: string, fieldId: string): {slug:string;type?:string;multiple?:boolean} | null {
    const field = this.fields[`field:${fieldId}`]
    return field && field.entity === `entity:${entityId}` && !this.deletedTargets.has(`field:${fieldId}`) ? {slug:field.slug,type:field.type,multiple:field.multiple} : null
  }
  fieldSlugs(entityId: string): string[] {
    this.resolveFieldSlug(entityId, '')
    return [...new Set(this.fieldIdentityLookup!.get(`entity:${entityId}`)?.values() ?? [])]
  }
  private fieldAllows(entityId: string, role: BridgeRole, slug?: string, action: 'read' | 'write' | 'create' | 'delete' = 'read'): boolean {
    if (!this.fieldAccessCheck) return true
    if (!entityId) return this.fieldAccessCheck('', slug, role, action)
    if (slug === undefined) return this.fieldAccessCheck(entityId, undefined, role, action)
    const resolved = this.resolveFieldSlug(entityId, slug)
    return resolved !== null && this.fieldAccessCheck(entityId, slug, role, action) && this.fieldAccessCheck(entityId, resolved, role, action)
  }
  composeHttpRevision(documentId: string): number { return this.state.composeHttpRevisions && own(this.state.composeHttpRevisions, documentId) ? this.state.composeHttpRevisions[documentId] : -1 }
  mayReadCompose(documentId: string, memberId: string, role: BridgeRole): boolean { return this.admits(`compose:${id(documentId)}`, memberId, role) }
  mayReadRecord(recordId: string, memberId: string, role: BridgeRole): boolean {
    const target = `record:${id(recordId)}`
    return this.targetAvailable(target) && this.admits(this.state.targets[target] ?? '', memberId, role)
      && this.fieldAllows(this.parents[target]?.startsWith('entity:') ? this.parents[target].slice(7) : '', role)
  }
  mayAccessRecordField(recordId: string, slug: string, memberId: string, role: BridgeRole, action: 'read' | 'write' = 'read'): boolean {
    const target = `record:${id(recordId)}`
    return this.mayReadRecord(recordId, memberId, role)
      && this.fieldAllows(this.parents[target]?.startsWith('entity:') ? this.parents[target].slice(7) : '', role, slug, action)
  }
  private targetAvailable(target: string): boolean {
    const seen = new Set<string>()
    while (target) {
      if (seen.has(target) || this.deletedTargets.has(target)) return false
      seen.add(target)
      const parent = this.parents[target]
      // Old producers echo entityId on entity.create. That is the entity's
      // identity, not a self-parent; tolerate old checkpoints without making
      // actual record/tree cycles readable.
      target = parent === target && target.startsWith('entity:') ? '' : parent
    }
    return true
  }
  mayReadEditTarget(target: { recordId?: string; entityId: string; viewId: string }, memberId: string, role: BridgeRole): boolean {
    const key = this.state.targets[target.recordId ? `record:${id(target.recordId)}` : `entity:${id(target.entityId)}`]
    if (!key || !this.admits(key, memberId, role)) return false
    if (!this.fieldAllows(id(target.entityId), role)) return false
    for (const child of [`entity:${id(target.entityId)}`, `view:${id(target.viewId)}`, ...(target.recordId ? [`record:${id(target.recordId)}`] : [])]) {
      if (!this.targetAvailable(child) || (this.state.targets[child] && this.state.targets[child] !== key)) return false
    }
    return true
  }
  failClosed(): void { this.unavailable = true }
  private targetOwner(target: string, pending: ModulesSyncOp[]): string {
    const stored = this.state.targets[target]
    if (stored) return stored
    for (let i = pending.length - 1; i >= 0; i--) {
      if (targetKey(pending[i]) === target) return this.itemKey(pending[i], pending.slice(0, i))
    }
    return ''
  }
  private operationParent(op: ModulesSyncOp, key: string): string {
    const p = bag(op.patch), family = targetKey(op).split(':')[0]
    if (family === 'entity') return key
    if (family === 'module' || family === 'playbook' || family === 'compose') return ''
    const value = family === 'comment' ? id(p.recordId ?? p.record_id) : id(op.entityId ?? p.entityId ?? p.entity_id)
    return value ? `${family === 'comment' ? 'record' : 'entity'}:${value}` : ''
  }
  private targetParent(target: string, pending: ModulesSyncOp[]): string {
    const stored = this.parents[target]
    if (stored && stored !== target) return stored
    for (let i = pending.length - 1; i >= 0; i--) if (targetKey(pending[i]) === target) {
      return this.operationParent(pending[i], this.itemKey(pending[i], pending.slice(0, i)))
    }
    return ''
  }
  private targetAvailableInBatch(target: string, pending: ModulesSyncOp[]): boolean {
    if (!this.targetAvailable(target)) return false
    const parent = this.targetParent(target, pending), root = this.targetOwner(target, pending)
    return !pending.some(prior => (prior.kind.endsWith('.delete') || prior.kind === 'record.purge')
      && (targetKey(prior) === target || targetKey(prior) === parent || rootKey(prior) === root))
  }
  itemKey(op: ModulesSyncOp, pending: ModulesSyncOp[] = []): string {
    let p: Record<string, unknown>
    try { p = bag(canonicalContentOp(op).patch) } catch { return '' }
    if (own(p, 'id') && id(p.id) !== id(op.targetId)) return ''
    const exactAliases = (values: unknown[]): string | null => {
      const present = values.filter(v => v !== undefined && v !== null && v !== '')
      if (present.some(v => !id(v))) return null
      const ids = [...new Set(present.map(id))]
      return ids.length > 1 ? null : ids[0] ?? ''
    }
    const aliases = op as ModulesSyncOp & { module_id?: unknown; entity_id?: unknown }
    const claimed = exactAliases([op.moduleId, aliases.module_id, p.moduleId, p.module_id])
    const entity = exactAliases([op.entityId, aliases.entity_id, p.entityId, p.entity_id])
    if (claimed === null || entity === null) return ''
    const root = rootKey(op)
    if (root && id(op.targetId)) return root.startsWith('module:') && claimed && root !== `module:${claimed}` ? '' : root
    const known = this.targetOwner(targetKey(op), pending)
    const record = op.kind.startsWith('comment.') ? exactAliases([p.recordId, p.record_id]) : ''
    if (record === null) return ''
    const entityParent = entity ? this.targetOwner(`entity:${entity}`, pending) : ''
    const recordParent = record ? this.targetOwner(`record:${record}`, pending) : ''
    if (entityParent && recordParent && entityParent !== recordParent) return ''
    const parent = entityParent || recordParent
    if (parent && claimed && parent !== `module:${claimed}`) return ''
    // A sender cannot use a different allowed parent to move an existing id
    // out of a revoked item. Missing parents are never independent grants.
    if (known && ((claimed && known !== `module:${claimed}`) || (parent && parent !== known))) return ''
    return known || parent || (claimed ? `module:${claimed}` : '')
  }
  /** Composite ops carry identities for every affected row, not just targetId. */
  private cascadeRefusal(op: ModulesSyncOp, memberId: string, role: BridgeRole, pending: ModulesSyncOp[] = [], historical = false): string | null {
    if (op.kind !== 'cascade.patch') return null
    const family = cascadeFamily(op), p = bag(op.patch), root = this.itemKey(op, pending)
    if (!family || op.targetKind !== family) return 'Invalid cascade target family'
    if (!root) return 'Invalid cascade item identity'
    if (p.action === 'rename_field_slug') {
      if (p.reorderKind !== undefined || p.moduleIds !== undefined || p.order !== undefined) return 'Conflicting cascade action'
      if (!id(p.oldSlug) || !id(p.newSlug)) return 'Invalid field rename'
      // The desktop cascade mutates by oldSlug, not targetId. Bind that pair
      // to the actual preceding field update, including updates in this WAL
      // frame; never let a valid field id authorize a different column.
      const fields: Record<string, Field> = { ...this.fields }
      for (const prior of pending) {
        const target = targetKey(prior), patch = bag(prior.patch), field = fields[target]
        if (prior.kind === 'field.create' && !field) fields[target] = {
          entity: this.operationParent(prior, this.itemKey(prior, pending)),
          slug: typeof patch.slug === 'string' && referenceCellSlug(patch.slug) ? patch.slug : id(prior.targetId),
        }
        else if (prior.kind === 'field.update' && field && typeof patch.slug === 'string' && referenceCellSlug(patch.slug) && patch.slug !== field.slug) {
          fields[target] = { ...field, previousSlug: field.slug, slug: patch.slug }
        }
        else if (prior.kind === 'field.delete') delete fields[target]
      }
      const target = targetKey(op), field = fields[target]
      if (!field || field.entity !== this.operationParent(op, root) || field.slug !== p.newSlug || field.previousSlug !== p.oldSlug) return 'Field rename does not match the authored schema transition'
      if (Object.entries(fields).some(([key, other]) => key !== target && !this.deletedTargets.has(key)
        && other.entity === field.entity && (other.slug === p.oldSlug || other.slug === p.newSlug))) return 'Field rename conflicts with another column identity'
      return null
    }
    if (p.action && p.action !== '') return 'Unknown cascade action'
    if (family !== 'module' && p.moduleIds !== undefined) return 'Conflicting cascade module targets'
    if (!Array.isArray(p.order) || !p.order.length || p.order.length > 500) return 'Invalid cascade order'
    const targets = p.order.map(row => id(typeof row === 'string' ? row : bag(row).id))
    if (targets.some(target => !target) || new Set(targets).size !== targets.length || !targets.includes(id(op.targetId))) return 'Invalid cascade identities'
    if (family === 'module' && (targets.length !== 1 || p.moduleIds !== undefined
      && (!Array.isArray(p.moduleIds) || p.moduleIds.length !== 1 || id(p.moduleIds[0]) !== targets[0]))) return 'Split module reorders by item access revision'
    const expectedParent = this.operationParent(op, root) || this.targetParent(targetKey(op), pending)
    for (const row of p.order) {
      const b = bag(row), target = `${family}:${id(typeof row === 'string' ? row : b.id)}`
      if (this.targetOwner(target, pending) !== root || !historical && !this.targetAvailableInBatch(target, pending)) return 'Cascade target belongs to another item, was deleted or is unknown'
      const parent = this.targetParent(target, pending)
      if (expectedParent && parent && parent !== expectedParent) return 'Cascade target belongs to another parent'
      for (const property of ['parent_id', 'parentId', 'prev_parent_id', 'prevParentId']) {
        if (b[property] == null || b[property] === '') continue
        const reference = id(b[property]), referenceTarget = `${family}:${reference}`
        const referenceRoot = this.targetOwner(referenceTarget, pending)
        if (!reference || !referenceRoot || !historical && (!this.targetAvailableInBatch(referenceTarget, pending) || !this.admits(referenceRoot, memberId, role))
          || family !== 'module' && (referenceRoot !== root || expectedParent && this.targetParent(referenceTarget, pending) !== expectedParent)) return 'Cascade parent reference is inaccessible'
      }
    }
    return null
  }
  private admits(key: string, memberId: string, role: BridgeRole): boolean {
    if (this.unavailable) return false
    if (role === 'admin') return true
    if (key.startsWith('compose:') && this.composeAccessCheck && !this.composeAccessCheck(key.slice(8), memberId)) return false
    const item = this.state.items[key]
    return !!item && !item.deleted && !item.denied.includes(memberId) && (item.audience === null || item.audience.includes(memberId))
  }
  revision(op: ModulesSyncOp): number { return this.state.items[this.itemKey(op)]?.revision ?? 0 }
  mayRead(op: ModulesSyncOp, memberId: string, role: BridgeRole): boolean {
    return this.projectForRead(op, memberId, role) !== null
  }
  /**
   * A later deletion must not hide surviving rows in an earlier reorder.
   * Validate the ORIGINAL composite's immutable ownership first, then remove
   * unavailable rows. Never use a projected subset to launder cross-item IDs.
   * Callers must send this projection, not merely test it and send the input.
   */
  projectForRead(op: ModulesSyncOp, memberId: string, role: BridgeRole): ModulesSyncOp | null {
    if (this.unavailable) return null
    try {
      const canonical = canonicalContentOp(op)
      if (own(op, 'payload') || own(op, 'payload_json')) op = canonical
    } catch { return null }
    if (op.kind !== 'cascade.patch') return this.mayReadWhole(op, memberId, role) ? op : null
    if (this.cascadeRefusal(op, memberId, role, [], true)) return null
    const root = this.itemKey(op), p = bag(op.patch), family = cascadeFamily(op)
    if (!this.admits(root, memberId, role)) return null
    // field.update already applies the schema/cell rename on desktop. A
    // duplicate cascade is useful only while its exact transition is current;
    // replaying an obsolete one could rename a newly reused column instead.
    if (p.action === 'rename_field_slug') return this.targetAvailable(targetKey(op)) ? op : null
    const kept: Array<{ raw: unknown; index: number }> = []
    for (const [index, raw] of (p.order as unknown[]).entries()) {
      const row = bag(raw), target = `${family}:${id(typeof raw === 'string' ? raw : row.id)}`
      if (!this.targetAvailable(target)) continue
      // Parent IDs are also authority references, including CAS baselines.
      // If one is no longer readable, omit this row rather than dropping its
      // baseline or inventing a replacement parent. Independent rows survive.
      const hiddenParent = ['parent_id', 'parentId', 'prev_parent_id', 'prevParentId'].some(property => {
        if (row[property] == null || row[property] === '') return false
        const reference = `${family}:${id(row[property])}`, owner = this.targetOwner(reference, [])
        return !this.targetAvailable(reference) || !this.admits(owner, memberId, role)
      })
      if (!hiddenParent) kept.push({ raw, index })
    }
    if (!kept.length) return null
    if (kept.length === (p.order as unknown[]).length) return op
    const order = kept.map(({ raw, index }) => {
      const row = bag(raw), sort = row.sort_order ?? row.sortOrder
      // Bare IDs / absent sorts mean ORIGINAL array position on desktop.
      // Filtering an earlier row must not renumber surviving positions.
      return { ...row, id: id(typeof raw === 'string' ? raw : row.id),
        sort_order: typeof sort === 'number' && Number.isFinite(sort) ? Math.floor(sort) : index }
    })
    const targetId = order[0]!.id
    const entityIdentity = family === 'entity' ? targetId : op.entityId
    return { ...op, targetId, ...(family === 'entity' ? { entityId: entityIdentity,
      ...(own(op, 'entity_id') ? { entity_id: entityIdentity } : {}) } : {}),
      patch: { ...p, ...(own(p, 'id') ? { id: targetId } : {}),
        ...(family === 'entity' && own(p, 'entityId') ? { entityId: entityIdentity } : {}),
        ...(family === 'entity' && own(p, 'entity_id') ? { entity_id: entityIdentity } : {}), order } }
  }
  private mayReadWhole(op: ModulesSyncOp, memberId: string, role: BridgeRole): boolean {
    if (this.unavailable) return false
    // A narrowly addressed lifecycle notice must reach a removed recipient.
    if (op.kind.endsWith('.share_revoked')) return op.originRole === 'admin'
      && (role === 'admin' || ((audience(op) ?? []).includes(memberId) && !this.admits(this.itemKey(op), memberId, role)))
    if (rootKey(op) && op.kind.endsWith('.delete') && op.originRole === 'admin') {
      const item = this.state.items[this.itemKey(op)]
      // Deletion denies the snapshot, not its content-free cleanup notice.
      // Do not replay an old delete over a subsequently restored grant.
      return role === 'admin' || !!item?.deleted && !item.denied.includes(memberId)
        && (item.audience === null || item.audience.includes(memberId))
    }
    if (this.deletedTargets.has(targetKey(op)) && !op.kind.endsWith('.delete') && op.kind !== 'record.purge') return false
    return this.admits(this.itemKey(op), memberId, role)
  }
  mayReadBlob(sha: string, memberId: string, role: BridgeRole): boolean {
    if (this.unavailable) return false
    if (role === 'admin') return true
    const refs = this.state.blobs[sha] ?? []
    return refs.length ? refs.some(target => !target.startsWith('cascade:') && this.targetAvailable(target)
      && this.admits(this.state.targets[target] ?? '', memberId, role) && this.blobFieldReadable(target, sha, role)) : (this.state.uploads[sha] ?? []).includes(memberId)
  }
  private blobFieldReadable(target: string, sha: string, role: BridgeRole): boolean {
    if (!this.fieldAccessCheck) return true
    let parent = this.parents[target]
    if (parent?.startsWith('record:')) parent = this.parents[parent]
    const entity = target.startsWith('entity:') ? target.slice(7) : parent?.startsWith('entity:') ? parent.slice(7) : ''
    if (!entity) return !/^(record|field|view|comment):/.test(target) || this.fieldAllows('', role)
    if (!this.fieldAllows(entity, role)) return false
    if (target.startsWith('field:')) return this.fieldAllows(entity, role, this.fields[target]?.slug ?? target.slice(6))
    if (target.startsWith('record:')) return Object.entries(this.references[target] ?? {}).some(([path, hashes]) => {
      if (!hashes.includes(sha)) return false
      try {
        const cell = JSON.parse(path)
        return Array.isArray(cell) && cell.length === 2 && cell[0] === 'data' && typeof cell[1] === 'string' && this.fieldAllows(entity, role, cell[1])
      } catch { return false }
    })
    // Unstructured comments/view configuration have no provable field binding.
    return !this.privateFieldsCheck?.(entity, role)
  }
  noteUpload(sha: string, memberId: string): void {
    if (this.unavailable) throw new Error('Content authority unavailable')
    const owners = this.state.uploads[sha] ?? []
    if (!owners.includes(memberId)) { this.state.uploads[sha] = [...owners, memberId]; this.changed('uploads', sha, this.state.uploads[sha]); this.flush() }
  }
  authorize(op: ModulesSyncOp, memberId: string, role: BridgeRole, pending: ModulesSyncOp[] = []): string | null {
    if (this.unavailable) return 'Content authority unavailable'
    try { op = canonicalContentOp(op) } catch { return 'Invalid content patch' }
    if (op.kind === 'compose.access') return 'Server-only access control'
    const key = this.itemKey(op, pending)
    if (!key || !id(op.targetId)) return 'Content parent is unknown or conflicts with its stored owner'
    const target = targetKey(op)
    const parent = this.operationParent(op, key), storedParent = this.targetParent(target, pending)
    if (this.deletedTargets.has(parent) || (storedParent && this.deletedTargets.has(storedParent))
      || (!rootKey(op) && this.deletedTargets.has(target) && !op.kind.endsWith('.delete') && op.kind !== 'record.purge')) return 'Content target or parent was deleted'
    if (storedParent && parent && storedParent !== parent) return 'Content parent conflicts with its stored owner'
    const cascadeRefusal = this.cascadeRefusal(op, memberId, role, pending)
    if (cascadeRefusal) return cascadeRefusal
    // Earlier deletes in this accepted frame are already authority, even
    // though the shared WAL append has not happened yet.
    for (const prior of pending) {
      if (!prior.kind.endsWith('.delete') && prior.kind !== 'record.purge') continue
      const deleted = targetKey(prior)
      if (deleted === target || deleted === parent || deleted === this.parents[target]
        || rootKey(prior) && this.itemKey(prior) === key) return 'Content target or parent was deleted in this batch'
    }
    let current = this.state.items[key]
    // Validation precedes the frame's single WAL append. Include earlier
    // accepted controls so revoke + stale snapshot in one frame cannot undo
    // the revoke merely because neither has been persisted yet.
    if (role === 'admin' && rootKey(op)) for (const prior of pending) {
      if (rootKey(prior) && this.itemKey(prior) === key && prior.originRole === 'admin' && !this.controls.has(prior.opId)) current = this.transitionItem(prior, current)
    }
    // Restrictive lifecycle operations remain usable in large paged batches.
    // Ordinary administrator snapshots may never change/restore an old grant
    // without the current author-time epoch. This is not refreshed at send.
    if (role === 'admin' && current && rootKey(op) && !op.kind.endsWith('.delete') && !op.kind.endsWith('.share_revoked')
      && (op.kind.endsWith('.create') || own(op, 'visibleToMemberIds') || own(bag(op.patch), 'visibleToMemberIds'))) {
      const next = audience(op)
      const changesGrant = current.deleted || current.denied.length > 0 || JSON.stringify(next) !== JSON.stringify(current.audience)
      if (changesGrant && (op.contentAclRevision ?? 0) !== current.revision) return 'Item access revision changed; discard this queued grant'
    }
    if (role !== 'admin') {
      if (role === 'viewer' || !this.admits(key, memberId, role)) return 'Item access was revoked or not granted'
      if (op.kind.endsWith('.share_revoked') || ['module.create', 'module.delete', 'entity.delete', 'field.delete', 'playbook.delete', 'compose.doc.delete'].includes(op.kind)) return 'Admin only'
      if (!op.kind.endsWith('.create') && !this.targetOwner(target, pending) && !rootKey(op)) return 'Content target is unknown'
      const revision = this.revision(op)
      if (revision > 0 && op.contentAclRevision === undefined) return 'Update the app before editing this item after access changes'
      if ((op.contentAclRevision ?? 0) !== revision) return 'Item access revision changed; discard this queued change'
    }
    try {
      for (const sha of contentBlobHashes(op.patch)) {
        if (!this.mayReadBlob(sha, memberId, role) && !(this.state.uploads[sha] ?? []).includes(memberId)) return 'Attachment is not accessible through a current item grant'
      }
    } catch { return 'Invalid content references' }
    return null
  }
  private transitionItem(op: ModulesSyncOp, current?: Item): Item {
    const old = current ?? { audience: audience(op), denied: [], revision: 0, deleted: false }
    let next: Item = { ...old, denied: [...old.denied] }
    if (op.kind.endsWith('.share_revoked')) {
      if (bag(op.patch).unsharedFromTeam === true) next.deleted = true
      for (const member of audience(op) ?? []) {
        if (!next.denied.includes(member) && (next.audience === null || next.audience.includes(member))) next.denied.push(member)
      }
    } else if (op.kind.endsWith('.delete')) next.deleted = true
    else if (op.kind === 'compose.access' || op.kind.endsWith('.create') || own(op, 'visibleToMemberIds') || own(bag(op.patch), 'visibleToMemberIds')) {
      next = { ...next, audience: audience(op), denied: [], deleted: false }
    }
    if (JSON.stringify({ ...old, revision: 0 }) !== JSON.stringify({ ...next, revision: 0 }) || op.kind === 'compose.access') next.revision = old.revision + 1
    return next
  }
  /** Called only for bridge-stamped, durably appended operations, and boot replay. */
  observe(op: ModulesSyncOp): void {
    if (this.unavailable) return
    op = canonicalContentOp(op)
    if (op.originRole !== 'admin' && (op.kind.endsWith('.share_revoked') || ['module.delete', 'entity.delete', 'field.delete', 'playbook.delete', 'compose.doc.delete'].includes(op.kind))) return
    if (this.processed.has(op.opId)) {
      // Upgrade older checkpoints' one-step rename proof from retained WAL
      // without replaying their grant/body mutations. A public A→B→C cell
      // still needs A on catch-up; a now-hidden C must hide all three keys.
      const field = this.fields[targetKey(op)], slug = bag(op.patch).slug
      if (field && (op.kind === 'field.create' || op.kind === 'field.update') && typeof slug === 'string'
        && referenceCellSlug(slug) && slug !== field.slug && !(field.previousSlugs ?? []).includes(slug)) {
        field.previousSlugs = [...(field.previousSlugs ?? []), slug]
        this.changed('fields', targetKey(op), field)
      }
      return
    }
    const key = this.itemKey(op)
    if (!key || !id(op.targetId)) return
    const root = rootKey(op)
    const httpRevision = op.kind === 'compose.access' ? bag(op.patch).composeAclRevision : undefined
    if (op.kind === 'compose.access' && (op.originRole !== 'admin' || typeof httpRevision !== 'number' || !Number.isSafeInteger(httpRevision)
      || httpRevision <= this.composeHttpRevision(op.targetId))) return
    // A retained legacy log may start after its original root snapshot was
    // pruned. Only an authenticated Admin op can bootstrap that missing item;
    // subsequent non-root writes can never broaden or replace its grant.
    if (!this.state.items[key] && op.originRole === 'admin') {
      this.state.items[key] = { audience: audience(op), denied: [], revision: 0, deleted: false }
      this.changed('items', key, this.state.items[key])
    }
    if (root && op.originRole === 'admin' && !this.controls.has(op.opId)) {
      const previous = this.state.items[key]
      const next = this.transitionItem(op, previous)
      this.state.items[key] = next
      this.changed('items', key, next)
      if (previous && !previous.deleted && next.revision !== previous.revision
        && !op.kind.endsWith('.share_revoked') && !op.kind.endsWith('.delete')) {
        const removed = (previous.audience ?? this.memberIds()).filter(member => !previous.denied.includes(member)
          && (next.deleted || next.denied.includes(member) || next.audience !== null && !next.audience.includes(member)))
        for (let offset = 0; offset < removed.length; offset += 500) {
          this.updateNotices({ ...op, opId: `acl-cleanup:${createHash('sha256').update(JSON.stringify([op.opId, offset])).digest('hex')}`,
            kind: `${key.split(':')[0]}.share_revoked`, visibleToMemberIds: removed.slice(offset, offset + 500),
            patch: { id: op.targetId, authoritativeDelete: true } }, key)
        }
      }
      if (typeof httpRevision === 'number') {
        this.state.composeHttpRevisions ??= Object.create(null) as Record<string, number>
        this.state.composeHttpRevisions[op.targetId] = httpRevision
        this.changed('composeHttpRevisions', op.targetId, httpRevision)
      }
      this.controls.add(op.opId)
      this.changed('controls', op.opId, true)
    }
    const target = targetKey(op)
    if (!this.state.targets[target]) { this.state.targets[target] = key; this.changed('targets', target, key) }
    this.updateReferences(op, target, key)
    if (root && op.originRole === 'admin' || op.kind.endsWith('.delete') || op.kind === 'record.purge') this.updateNotices(op, key)
    this.processed.add(op.opId)
    this.changed('processed', op.opId, true)
  }
  private replaceReferences(target: string, next: Record<string, string[]>): void {
    const before = new Set(Object.values(this.references[target] ?? {}).flat())
    const after = new Set(Object.values(next).flat())
    for (const sha of before) if (!after.has(sha)) {
      const refs = (this.state.blobs[sha] ?? []).filter(ref => ref !== target)
      if (refs.length) this.state.blobs[sha] = refs
      else delete this.state.blobs[sha]
      this.changed('blobs', sha, refs.length ? refs : undefined)
    }
    for (const sha of after) if (!before.has(sha)) {
      this.state.blobs[sha] = [...(this.state.blobs[sha] ?? []), target]
      this.changed('blobs', sha, this.state.blobs[sha])
      // Upload ownership is only a staging grant, not perpetual access after
      // the first reference has been deleted or revoked.
      delete this.state.uploads[sha]
      this.changed('uploads', sha, undefined)
    }
    if (Object.keys(next).length) this.references[target] = next
    else delete this.references[target]
    this.changed('references', target, Object.keys(next).length ? next : undefined)
  }
  private updateReferences(op: ModulesSyncOp, target: string, root: string): void {
    const patch = bag(op.patch)
    const parent = this.operationParent(op, root)
    if (parent && (!this.parents[target] || this.parents[target] === target)) { this.parents[target] = parent; this.changed('parents', target, parent) }
    const rawType = patch.fieldType ?? patch.field_type
    let fieldConfig = patch.config
    let configValid = true
    if (typeof fieldConfig === 'string') { try { fieldConfig = JSON.parse(fieldConfig) } catch { fieldConfig = undefined; configValid = false } }
    if (fieldConfig !== undefined && fieldConfig !== null && (typeof fieldConfig !== 'object' || Array.isArray(fieldConfig))) configValid = false
    const multiple = configValid ? bag(fieldConfig).allow_multiple === true || bag(fieldConfig).allowMultiple === true : undefined
    if (op.kind === 'field.create' && !this.deletedTargets.has(target) && parent.startsWith('entity:')) {
      const slug = typeof patch.slug === 'string' && referenceCellSlug(patch.slug) ? patch.slug : id(op.targetId)
      if (!this.fields[target]) {
        this.fields[target] = { entity: parent, slug, multiple, ...(typeof rawType === 'string' ? { type: rawType } : {}) }
        this.changed('fields', target, this.fields[target])
        this.retiredCells[parent] = (this.retiredCells[parent] ?? []).filter(key => key !== slug && key !== op.targetId)
        this.changed('retiredCells', parent, this.retiredCells[parent])
      }
    }
    const field = this.fields[op.kind === 'cascade.patch' ? `field:${id(op.targetId)}` : target]
    if ((op.kind === 'field.update' || op.kind === 'cascade.patch' && patch.action === 'rename_field_slug') && field) {
      const nextSlug = op.kind === 'field.update' ? patch.slug : patch.newSlug
      const renamed = typeof nextSlug === 'string' && referenceCellSlug(nextSlug) && nextSlug !== field.slug
      const typeChanged = op.kind === 'field.update' && typeof rawType === 'string' && rawType !== field.type
      if (renamed || typeChanged) {
        for (const [record, owner] of Object.entries(this.parents)) {
          if (!record.startsWith('record:') || owner !== field.entity) continue
          const next = { ...(this.references[record] ?? {}) }, oldPath = JSON.stringify(['data', field.slug])
          if (renamed && next[oldPath] && !typeChanged) next[JSON.stringify(['data', nextSlug])] = next[oldPath]
          delete next[oldPath]
          if (typeChanged) delete next[JSON.stringify(['data', op.targetId])]
          this.replaceReferences(record, next)
          if (renamed && this.cellClocks[record]?.[field.slug]) {
            this.cellClocks[record][nextSlug] = this.cellClocks[record][field.slug]
            delete this.cellClocks[record][field.slug]
            this.changed('cellClocks', record, this.cellClocks[record])
          }
          if (typeChanged) {
            const clock = referenceClock(op.hlc)
            if (clock) {
              this.cellClocks[record] ??= Object.create(null)
              for (const slug of [field.slug, id(op.targetId), ...(renamed ? [nextSlug as string] : [])]) {
                const previous = referenceClock(this.cellClocks[record][slug])
                if (!previous || newerReferenceClock(clock, previous)) this.cellClocks[record][slug] = clock.join(':')
              }
              this.changed('cellClocks', record, this.cellClocks[record])
            }
          }
        }
        if (renamed) {
          this.retiredCells[field.entity] = [...new Set([...(this.retiredCells[field.entity] ?? []), field.slug])].filter(slug => slug !== nextSlug)
          this.changed('retiredCells', field.entity, this.retiredCells[field.entity])
          field.previousSlug = field.slug
          field.previousSlugs = [...new Set([...(field.previousSlugs ?? []), field.slug])]
          field.slug = nextSlug
        }
        if (typeof rawType === 'string') field.type = rawType
        this.changed('fields', op.kind === 'cascade.patch' ? `field:${id(op.targetId)}` : target, field)
      }
      if (op.kind === 'field.update' && Object.hasOwn(patch, 'config')) {
        field.multiple = multiple
        this.changed('fields', target, field)
      }
    }
    if (op.kind === 'field.delete') {
      if (field) {
        this.retiredCells[field.entity] = [...new Set([...(this.retiredCells[field.entity] ?? []), field.slug, id(op.targetId)])]
        this.changed('retiredCells', field.entity, this.retiredCells[field.entity])
      }
      if (field) for (const [record, owner] of Object.entries(this.parents)) {
        if (!record.startsWith('record:') || owner !== field.entity) continue
        const next = { ...(this.references[record] ?? {}) }
        delete next[JSON.stringify(['data', field.slug])]
        delete next[JSON.stringify(['data', op.targetId])]
        this.replaceReferences(record, next)
      }
    }
    if (op.kind.endsWith('.delete') || op.kind === 'record.purge') {
      const deleting = new Set([target])
      if (rootKey(op)) for (const [child, owner] of Object.entries(this.state.targets)) { if (owner === root) deleting.add(child) }
      let added = true
      while (added) {
        added = false
        for (const [child, owner] of Object.entries(this.parents)) if (deleting.has(owner) && !deleting.has(child)) { deleting.add(child); added = true }
      }
      for (const child of deleting) {
        this.replaceReferences(child, {})
        this.deletedTargets.add(child)
        this.changed('deletedTargets', child, true)
      }
      return
    }
    if (op.kind.endsWith('.share_revoked') || op.kind === 'compose.access' || op.kind === 'cascade.patch') return
    // Hard-deleted records/tables are tombstoned on desktops too. An old
    // snapshot cannot resurrect them; explicit item re-share is separate.
    if (rootKey(op) && op.kind.endsWith('.create') && this.deletedTargets.delete(target)) this.changed('deletedTargets', target, undefined)
    if (this.deletedTargets.has(target)) return
    if (this.deletedTargets.has(this.parents[target])) return
    const next = { ...(this.references[target] ?? {}) }
    const replace = (path: string, value: unknown) => {
      const hashes = contentBlobHashes(value)
      if (hashes.length) next[path] = hashes
      else delete next[path]
    }
    // Record cell updates merge at slug granularity. Other patch properties
    // are replacements; do not retain a previous hash when a value is cleared.
    if (op.kind.startsWith('record.')) {
      const cells = referenceCells(patch)
      const removeKeys = patch.removeKeys ?? patch.remove_keys
      const removals = Array.isArray(removeKeys) ? removeKeys.filter((slug): slug is string => typeof slug === 'string' && referenceCellSlug(slug)) : []
      const clocks = { ...(this.cellClocks[target] ?? {}) }
      let stamped = false
      for (const slug of new Set([...Object.keys(cells), ...removals])) {
        if ((this.retiredCells[this.parents[target]] ?? []).includes(slug)) continue
        const { clock, poison } = referenceCellClock(patch, slug, op.hlc)
        const previous = referenceClock(clocks[slug])
        if (poison || (slug !== '_origin' && clock && previous && !newerReferenceClock(clock, previous))) continue
        replace(JSON.stringify(['data', slug]), removals.includes(slug) ? null : cells[slug])
        if (clock && slug !== '_origin') { clocks[slug] = clock.join(':'); stamped = true }
      }
      if (stamped) { this.cellClocks[target] = clocks; this.changed('cellClocks', target, clocks) }
    } else for (const [name, value] of Object.entries(patch)) replace(JSON.stringify([name]), value)
    if (JSON.stringify(next) !== JSON.stringify(this.references[target] ?? {})) this.replaceReferences(target, next)
  }
  private updateNotices(op: ModulesSyncOp, key: string): void {
    if (op.kind.endsWith('.share_revoked') || op.kind.endsWith('.delete') || op.kind === 'record.purge') {
      // Store only the lifecycle envelope, never the deleted object's body.
      const notice: ModulesSyncOp = { opId: op.opId, kind: op.kind, targetKind: op.targetKind, targetId: op.targetId,
        originMemberId: op.originMemberId, originRole: op.originRole, originDevice: op.originDevice, teamId: op.teamId,
        hlc: op.hlc, protocolVersion: op.protocolVersion, hopCount: op.hopCount,
        ...(audience(op) !== null ? { visibleToMemberIds: audience(op)! } : {}),
        ...(key.startsWith('module:') ? { moduleId: key.slice(7) } : {}),
        ...(this.parents[targetKey(op)]?.startsWith('entity:') ? { entityId: this.parents[targetKey(op)].slice(7) } : {}),
        patch: { id: op.targetId, ...(bag(op.patch).authoritativeDelete === true ? { authoritativeDelete: true } : {}) } }
      const slot = createHash('sha256').update(JSON.stringify([key, op.kind, op.targetId, audience(op)])).digest('hex')
      this.notices[slot] = notice
      this.changed('notices', slot, notice)
    }
    for (const [opId, notice] of Object.entries(this.notices)) {
      if (this.itemKey(notice) !== key) continue
      const audienceIds = audience(notice)
      const obsolete = notice.kind.endsWith('.delete') || notice.kind === 'record.purge' ? (rootKey(notice) ? !this.state.items[key]?.deleted : !this.deletedTargets.has(targetKey(notice)))
        : !!audienceIds && audienceIds.every(member => this.admits(key, member, 'member'))
      if (obsolete) { delete this.notices[opId]; this.changed('notices', opId, undefined) }
    }
  }
  flush(): void {
    if (this.unavailable) throw new Error('Content authority unavailable')
    if (!this.dirty && this.migrated && existsSync(this.initialized)) return
    const tmp = `${this.path}.${randomBytes(8).toString('hex')}.tmp`
    try {
      mkdirSync(this.root, { recursive: true })
      this.storage ??= new ContentAccessStorage(this.root, this.atRest, false)
      this.storage.write(this.migrated ? this.changes.values() : this.allEntries())
      const manifest = { version: 2, storage: 'sqlite', referenceVersion: 2 }
      const plain = JSON.stringify(manifest)
      const fd = openSync(tmp, 'wx', 0o600)
      try { writeFileSync(fd, this.atRest ? encryptJsonFile(this.atRest, manifest) : plain); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(tmp, this.path)
      const initialized = openSync(this.initialized, 'w', 0o600)
      try { writeFileSync(initialized, '1'); fsyncSync(initialized) } finally { closeSync(initialized) }
      const dir = openSync(this.root, 'r')
      try { fsyncSync(dir) } finally { closeSync(dir) }
      this.dirty = false
      this.migrated = true
      this.changes.clear()
    } catch (error) { this.unavailable = true; throw error }
  }
}
