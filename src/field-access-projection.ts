/** Current table/field permissions at the server byte boundary, not just UI. */
import type { BridgeRole, ModulesSyncOp } from './index.js'
import { normalizeBridgeFieldAclBag } from './team-field-acl.js'
import { referenceCellSlug } from './content-reference-data.js'

type Action = 'read' | 'write' | 'create' | 'delete'
type EntityGrant = { entityId: string; role: string; read: boolean; create: boolean; update: boolean; delete: boolean }
type FieldGrant = { entityId: string; fieldSlug: string; role: string; read: boolean; write: boolean; hidden: boolean }
type Bag = { entities: EntityGrant[]; fields: FieldGrant[] }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const roleDefault = (role: BridgeRole, action: Action) => role === 'admin' || role === 'member' && action !== 'delete' || role === 'viewer' && action === 'read'
const safeSlug = (value: unknown): value is string => typeof value === 'string' && referenceCellSlug(value) && value.trim() === value && !value.includes('\0') && value.isWellFormed()
export type FieldAccessLineage = {
  entityForOp(op: ModulesSyncOp): string
  resolveFieldSlug(entityId: string, key: string): string | null
  fieldSlugs(entityId: string): string[]
}

/** Construct once per authority hash. Deny rows merge; exact beats wildcard,
 * matching the desktop's existing grant semantics. */
export class FieldAccessProjection {
  private readonly entities = new Map<string, EntityGrant>()
  private readonly fields = new Map<string, FieldGrant>()
  private readonly healthy: boolean
  constructor(raw: unknown, available = true) {
    this.healthy = available
    if (!available) return
    try {
      const bag = normalizeBridgeFieldAclBag(raw) as Bag | null
      for (const row of bag?.entities ?? []) {
        const key = JSON.stringify([row.entityId, row.role]), old = this.entities.get(key)
        this.entities.set(key, old ? { ...row, read: row.read && old.read, create: row.create && old.create,
          update: row.update && old.update, delete: row.delete && old.delete } : row)
      }
      for (const row of bag?.fields ?? []) {
        const key = JSON.stringify([row.entityId, row.role, row.fieldSlug]), old = this.fields.get(key)
        this.fields.set(key, old ? { ...row, read: row.read && old.read, write: row.write && old.write,
          hidden: row.hidden || old.hidden } : row)
      }
    } catch { this.healthy = false }
  }
  allows(entityId: string, role: BridgeRole, fieldSlug?: string, action: Action = 'read'): boolean {
    if (!this.healthy || !['admin', 'member', 'viewer'].includes(role)) return false
    // Administrators retain the authority recovery surface and original data.
    if (role === 'admin') return true
    // Legacy root-only records have no table lineage. They remain readable
    // under empty/default grants, never once table/field restrictions exist.
    if (!entityId) return this.entities.size === 0 && this.fields.size === 0 && roleDefault(role, action)
    const entity = this.entities.get(JSON.stringify([entityId, role]))
    if (entity ? !entity[action === 'write' ? 'update' : action] : !roleDefault(role, action)) return false
    if (fieldSlug === undefined) return true
    if (!safeSlug(fieldSlug)) return false
    const row = this.fields.get(JSON.stringify([entityId, role, fieldSlug])) ?? this.fields.get(JSON.stringify([entityId, role, '*']))
    return row ? !row.hidden && (action === 'read' ? row.read : row.write) : roleDefault(role, action === 'delete' ? 'write' : action)
  }
  private cellAllowed(entity: string, slug: string, role: BridgeRole, lineage: FieldAccessLineage, action: Action = 'read'): boolean {
    const resolved = lineage.resolveFieldSlug(entity, slug)
    return resolved !== null && this.allows(entity, role, slug, action) && this.allows(entity, role, resolved, action)
  }
  hasPrivateFields(entity: string, role: BridgeRole, lineage: FieldAccessLineage): boolean {
    return !this.allows(entity, role, '*') || lineage.fieldSlugs(entity).some(slug => !this.cellAllowed(entity, slug, role, lineage))
      || [...this.fields.values()].some(row => row.entityId === entity && row.role === role && !this.allows(entity, role, row.fieldSlug))
  }
  private privateReference(value: unknown, entity: string, role: BridgeRole, lineage: FieldAccessLineage): boolean {
    let budget = 50_000
    const known = new Set(lineage.fieldSlugs(entity))
    for (const row of this.fields.values()) if (row.entityId === entity && row.fieldSlug !== '*') known.add(row.fieldSlug)
    const knownField = (value: string): boolean => known.has(value) || lineage.resolveFieldSlug(entity, value) !== value
    const selector = /^(field|fieldId|field_id|fieldSlug|field_slug|fields|fieldIds|field_ids|fieldSlugs|field_slugs|columns|column|columnId|column_id|groupBy|group_by|sortBy|sort_by|contentField|content_field|sourceField|source_field|targetField|target_field)$/
    const visit = (value: unknown, depth: number, fieldSelector = false): boolean => {
      if (--budget < 0 || depth > 32) return true
      if (typeof value === 'string') return safeSlug(value) && (fieldSelector || knownField(value)) && !this.cellAllowed(entity, value, role, lineage)
      if (Array.isArray(value)) return value.some(child => visit(child, depth + 1, fieldSelector))
      if (!object(value)) return false
      for (const [key, child] of Object.entries(value)) {
        if (/^(entityId|entity_id|targetEntityId|target_entity_id|sourceEntityId|source_entity_id)$/.test(key)
          && typeof child === 'string' && !this.allows(child, role)) return true
        if (knownField(key) && !this.cellAllowed(entity, key, role, lineage)) return true
        if (visit(child, depth + 1, selector.test(key))) return true
      }
      return false
    }
    return visit(value, 0)
  }
  /** Scrub every cell-bearing representation, including old flat/patch bags,
   * per-cell clocks, removal lists, encoded checkpoints, and reset metadata. */
  project(op: ModulesSyncOp, role: BridgeRole, lineage: FieldAccessLineage): ModulesSyncOp | null {
    if (!this.healthy) return null
    if (role === 'admin') return op
    const family = op.kind.split('.')[0]
    if (!['entity', 'record', 'field', 'view', 'comment', 'cascade'].includes(family)) return op
    // The server separately rebuilds content-free cleanup notices. They must
    // reach a former recipient even after their field/table becomes hidden.
    if (op.kind.endsWith('.delete') || op.kind === 'record.purge') return op
    const patch = object(op.patch) ? op.patch : {}
    if (family === 'cascade' && patch.reorderKind === 'module') return op
    if (family === 'cascade' && patch.reorderKind === 'entity' && Array.isArray(patch.order)) {
      const kept = patch.order.flatMap((raw, index) => {
        const row = object(raw) ? raw : {}, id = typeof raw === 'string' ? raw : row.id
        if (typeof id !== 'string' || !this.allows(id, role)) return []
        return [{ ...row, id, sort_order: typeof (row.sort_order ?? row.sortOrder) === 'number' ? row.sort_order ?? row.sortOrder : index }]
      })
      if (!kept.length) return null
      return kept.length === patch.order.length ? op : { ...op, targetId: kept[0].id, entityId: kept[0].id,
        patch: { ...patch, ...(own(patch, 'id') ? { id: kept[0].id } : {}), order: kept } }
    }
    const entity = lineage.entityForOp(op)
    if (!this.allows(entity, role)) return null
    if (op.kind === 'record.teamwork') return this.hasPrivateFields(entity, role, lineage) ? null : op
    if(op.teamwork&&this.hasPrivateFields(entity,role,lineage)){const {teamwork:_private,...safe}=op;op=safe}
    if (family === 'field') {
      const slug = typeof patch.slug === 'string' ? patch.slug : op.targetId
      return this.cellAllowed(entity, op.targetId, role, lineage) && this.cellAllowed(entity, slug, role, lineage)
        && !this.privateReference(patch.config, entity, role, lineage) ? op : null
    }
    if (family === 'view' || family === 'entity') {
      return this.privateReference(patch.config, entity, role, lineage) ? null : op
    }
    if (family === 'comment') {
      const slug = patch.fieldSlug ?? patch.field_slug
      return typeof slug === 'string' ? this.cellAllowed(entity, slug, role, lineage) ? op : null
        : this.hasPrivateFields(entity, role, lineage) ? null : op
    }
    if (family === 'cascade') {
      if (patch.reorderKind === 'field' && Array.isArray(patch.order)) {
        const kept = patch.order.flatMap((raw, index) => {
          const row = object(raw) ? raw : {}, id = typeof raw === 'string' ? raw : row.id
          if (typeof id !== 'string' || !this.cellAllowed(entity, id, role, lineage)) return []
          return [{ ...row, id, sort_order: typeof (row.sort_order ?? row.sortOrder) === 'number' ? row.sort_order ?? row.sortOrder : index }]
        })
        if (!kept.length) return null
        return kept.length === patch.order.length ? op : { ...op, targetId: kept[0].id,
          patch: { ...patch, ...(own(patch, 'id') ? { id: kept[0].id } : {}), order: kept } }
      }
      return this.privateReference(patch.action === 'rename_field_slug' ? [patch.oldSlug, patch.newSlug] : undefined, entity, role, lineage) ? null : op
    }
    const allowed = (slug: string) => this.cellAllowed(entity, slug, role, lineage)
    const source = object(patch.data) ? patch.data : object(patch.patch) ? patch.patch : patch
    const cells = Object.fromEntries(Object.entries(source).filter(([slug]) => safeSlug(slug) && allowed(slug)))
    const next: Record<string, unknown> = {}
    // These metadata values are not arbitrary record cell containers.
    for (const key of ['id', 'entityId', 'entity_id', 'moduleId', 'module_id', 'parent_id', 'parentId', 'sort_order', 'sortOrder',
      'parentHlc', 'trashed_at', 'trashedAt', 'is_trashed', 'visibleToMemberIds']) if (own(patch, key)) next[key] = patch[key]
    next.data = cells
    const filterSlugs = (value: unknown) => Array.isArray(value) ? value.filter((slug): slug is string => safeSlug(slug) && allowed(slug)) : []
    for (const key of ['removeKeys', 'remove_keys']) if (own(patch, key)) next[key] = filterSlugs(patch[key])
    if (object(patch.baseCellHlcs)) next.baseCellHlcs = Object.fromEntries(Object.entries(patch.baseCellHlcs).filter(([slug]) => safeSlug(slug) && allowed(slug)))
    if (object(patch.cellHlcs)) next.cellHlcs = Object.fromEntries(Object.entries(patch.cellHlcs).filter(([slug]) => safeSlug(slug) && allowed(slug)))
    const checkpoint = (raw: unknown): Record<string, unknown> | null => {
      if (!object(raw) || !safeSlug(raw.fieldSlug) || !allowed(raw.fieldSlug) || !own(cells, raw.fieldSlug)
        || !['text', 'whiteboard'].includes(String(raw.kind)) || typeof raw.stateB64 !== 'string') return null
      return { fieldSlug: raw.fieldSlug, kind: raw.kind, stateB64: raw.stateB64 }
    }
    const single = checkpoint(patch.yjsCheckpoint)
    if (single) {
      next.yjsCheckpoint = single
      if (patch.yjsCheckpointSave === true && typeof patch.yjsCheckpointSaveId === 'string') {
        next.yjsCheckpointSave = true; next.yjsCheckpointSaveId = patch.yjsCheckpointSaveId
      }
    }
    if (Array.isArray(patch.yjsCheckpoints)) next.yjsCheckpoints = patch.yjsCheckpoints.map(checkpoint).filter(Boolean)
    if (Array.isArray(patch.yjsResets)) next.yjsResets = patch.yjsResets.flatMap(raw => object(raw) && safeSlug(raw.fieldSlug)
      && allowed(raw.fieldSlug) && typeof raw.resetId === 'string' ? [{ fieldSlug: raw.fieldSlug, resetId: raw.resetId }] : [])
    const removeKeys = op.removeKeys ? filterSlugs(op.removeKeys) : undefined
    return { ...op, patch: next, ...(removeKeys ? { removeKeys } : {}) }
  }
  /** Authorization is all-or-nothing: never ACK a silently dropped write. */
  writeRefusal(op: ModulesSyncOp, role: BridgeRole, lineage: FieldAccessLineage): string | null {
    if (!this.healthy) return 'Field access authority unavailable'
    if (role === 'admin') return null
    const family = op.kind.split('.')[0]
    if (!['entity', 'record', 'field', 'view', 'comment', 'cascade'].includes(family)) return null
    const entity = lineage.entityForOp(op), patch = object(op.patch) ? op.patch : {}
    if (family === 'cascade' && patch.reorderKind === 'module') return null
    const action: Action = op.kind.endsWith('.create') ? 'create' : op.kind.endsWith('.delete') || op.kind === 'record.purge' ? 'delete' : 'write'
    if (!this.allows(entity, role, undefined, action)) return 'Your role cannot change this table'
    if (family === 'field' && (!this.cellAllowed(entity, op.targetId, role, lineage, action)
      || !this.cellAllowed(entity, typeof patch.slug === 'string' ? patch.slug : op.targetId, role, lineage, action))) return 'Your role cannot change this field'
    if (family === 'comment' && typeof (patch.fieldSlug ?? patch.field_slug) === 'string'
      && !this.cellAllowed(entity, String(patch.fieldSlug ?? patch.field_slug), role, lineage, action)) return 'Your role cannot change this field'
    if (family === 'cascade' && patch.reorderKind === 'field' && Array.isArray(patch.order)
      && patch.order.some(raw => !this.cellAllowed(entity, typeof raw === 'string' ? raw : object(raw) && typeof raw.id === 'string' ? raw.id : '', role, lineage, action))) return 'Your role cannot reorder this field'
    if (op.kind === 'record.teamwork') return this.hasPrivateFields(entity, role, lineage) ? 'Teamwork requires access to all record fields' : null
    if (family === 'record') {
      const source = object(patch.data) ? patch.data : object(patch.patch) ? patch.patch : patch
      const slugs = [...Object.keys(source).filter(safeSlug), ...(Array.isArray(op.removeKeys) ? op.removeKeys : []),
        ...(Array.isArray(patch.removeKeys ?? patch.remove_keys) ? patch.removeKeys as string[] ?? patch.remove_keys as string[] : [])]
      if (object(patch.baseCellHlcs)) slugs.push(...Object.keys(patch.baseCellHlcs))
      if (object(patch.cellHlcs)) slugs.push(...Object.keys(patch.cellHlcs))
      for (const raw of [patch.yjsCheckpoint, ...(Array.isArray(patch.yjsCheckpoints) ? patch.yjsCheckpoints : []), ...(Array.isArray(patch.yjsResets) ? patch.yjsResets : [])]) {
        if (raw == null) continue
        if (!object(raw) || !safeSlug(raw.fieldSlug)) return 'Invalid document field binding'
        slugs.push(raw.fieldSlug)
      }
      if (slugs.some(slug => !safeSlug(slug) || !this.cellAllowed(entity, slug, role, lineage, action))) return 'Your role cannot change this field'
    }
    if (!this.project(op, role, lineage)) return 'Your role cannot change inaccessible field content'
    return null
  }
}
