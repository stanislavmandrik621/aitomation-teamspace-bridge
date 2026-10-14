/** Public, ephemeral edit targets. Never carries cell values or caller identity. */
export const MODULE_EDIT_PRESENCE_TTL_MS = 30_000
export const MODULE_EDIT_PRESENCE_MAX = 32
export type ModuleEditTarget = {
  leaseId: string
  entityId: string
  viewId: string
  recordId?: string
  fieldSlug?: string
}
export type ModuleEditLease = ModuleEditTarget & { expiresAt: number }

function id(raw: unknown): string {
  return typeof raw === 'string' && raw.length <= 128 && raw.trim() === raw
    && raw.length > 0 && !/[\u0000-\u001f]/.test(raw)
    && !['__proto__', 'prototype', 'constructor'].includes(raw) ? raw : ''
}

export function parseModuleEditTarget(raw: unknown): ModuleEditTarget | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const leaseId = id(r.leaseId), entityId = id(r.entityId), viewId = id(r.viewId)
  if (!leaseId || !entityId || !viewId) return null
  if (r.recordId !== undefined && !id(r.recordId)) return null
  if (r.fieldSlug !== undefined && !id(r.fieldSlug)) return null
  return { leaseId, entityId, viewId,
    ...(r.recordId ? { recordId: id(r.recordId) } : {}),
    ...(r.fieldSlug ? { fieldSlug: id(r.fieldSlug) } : {}) }
}

export function liveModuleEditLeases(raw: unknown, now = Date.now()): ModuleEditLease[] {
  if (!Array.isArray(raw)) return []
  const out: ModuleEditLease[] = []
  for (const r of raw.slice(0, MODULE_EDIT_PRESENCE_MAX)) {
    const target = parseModuleEditTarget(r)
    if (!target || typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)
      || r.expiresAt <= now || r.expiresAt > now + MODULE_EDIT_PRESENCE_TTL_MS + 5_000) continue
    out.push({ ...target, expiresAt: r.expiresAt })
  }
  return out
}

/** Server clock owns expiry; a caller cannot create a permanent editor. */
export function updateModuleEditLeases(raw: unknown, target: ModuleEditTarget, active: boolean, now = Date.now()): ModuleEditLease[] {
  const out = liveModuleEditLeases(raw, now).filter((r) => r.leaseId !== target.leaseId)
  if (active) {
    if (out.length >= MODULE_EDIT_PRESENCE_MAX) throw new Error('Too many active editors on this device')
    out.push({ ...target, expiresAt: now + MODULE_EDIT_PRESENCE_TTL_MS })
  }
  return out
}
