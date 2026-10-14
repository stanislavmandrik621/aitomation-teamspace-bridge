/** Wire-cell interpretation must match the desktop. Differential regressions
 * compare this dependency-free bridge leaf with record-update-data.ts/hlc.ts.
 * Ignored metadata or truncated nested values are never attachment authority.
 */
const meta = new Set(['patch', 'data', 'removeKeys', 'remove_keys', 'entityId', 'entity_id', 'moduleId', 'module_id', 'parent_id', 'parentId', 'id',
  'visibleToMemberIds', 'originRole', '__teamspaceContentAclRevision', 'contentAclRevision', 'contentAclItem', 'cellHlcs', 'baseCellHlcs', 'parentHlc',
  'yjsCheckpoint', 'yjsCheckpointSave', 'yjsCheckpointSaveId', 'yjsCheckpoints', 'yjsResets', 'teamId', 'team_id', 'hopCount', 'hop_count',
  'originMemberId', 'originMemberName', 'origin_member_id', 'origin_member_name', 'origin_role', 'originDevice', 'origin_device',
  'visible_to_member_ids', 'opId', 'kind', 'hlc'])
const unsafe = new Set(['__proto__', 'constructor', 'prototype'])
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// "kind" is a supported business field as well as envelope metadata.
// Nested cells/schema/clocks are unambiguous; legacy flat bags still strip it.
export const referenceCellSlug = (key: string): boolean => !!key && key.length <= 200 && !unsafe.has(key) && (!meta.has(key) || key === 'kind') && (!key.startsWith('_') || key === '_origin')
export function referenceCells(patch: Record<string, unknown>): Record<string, unknown> {
  let budget = 20_000
  const copy = (v: unknown, depth: number): unknown => {
    if (depth > 8 || budget <= 0) return Array.isArray(v) ? [] : object(v) ? Object.create(null) : v
    if (Array.isArray(v)) {
      const out: unknown[] = []
      for (const child of v.slice(0, 1000)) { if (budget <= 0) break; budget--; out.push(copy(child, depth + 1)) }
      return out
    }
    if (!object(v)) return v
    const out = Object.create(null)
    for (const [key, child] of Object.entries(v).slice(0, 1000)) {
      if (budget <= 0) break
      budget--
      if (!unsafe.has(key)) out[key] = copy(child, depth + 1)
    }
    return out
  }
  const cells = object(patch.data) ? patch.data : object(patch.patch) ? patch.patch : patch
  const flatEnvelope = cells === patch
  const out = Object.create(null)
  for (const [key, value] of Object.entries(cells).slice(0, 1000)) {
    if (budget <= 0) break
    budget--
    if (referenceCellSlug(key) && !(flatEnvelope && meta.has(key))) out[key] = copy(value, 0)
  }
  return out
}
type Clock = [number, number, string]
const capText = (raw: string, max: number): string => {
  const capped = raw.slice(0, max), last = capped.charCodeAt(capped.length - 1)
  return (last >= 0xd800 && last <= 0xdbff ? capped.slice(0, -1) : capped).toWellFormed()
}
export function referenceClock(raw: unknown): Clock | null {
  if (typeof raw !== 'string') return null
  const value = raw.replace(/\0/g, '').toWellFormed()
  if (!value || value.length > 200) return null
  const parts = value.split(':')
  if (parts.length < 3 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return null
  const wall = Number(parts[0]), count = Number(parts[1]), device = capText(parts.slice(2).join(':').trim(), 128).trim()
  return Number.isSafeInteger(wall) && Number.isSafeInteger(count) && device ? [wall, count, device] : null
}
export function newerReferenceClock(remote: Clock, local: Clock): boolean {
  for (let i = 0; i < 3; i++) { if (remote[i] !== local[i]) return remote[i] > local[i] }
  return false
}
export function referenceCellClock(patch: Record<string, unknown>, slug: string, fallback: unknown): { clock: Clock | null; poison: boolean } {
  const wire = object(patch.cellHlcs) ? Object.entries(patch.cellHlcs).slice(0, 1000).find(([key, value]) => key === slug && referenceCellSlug(key) && !key.startsWith('_') && typeof value === 'string' && !!value)?.[1] : undefined
  // parseWireCellHlcs uses a 128-character cap before the HLC parser.
  const raw = typeof wire === 'string' ? capText(wire, 128) : fallback
  const clock = referenceClock(raw)
  return { clock, poison: wire !== undefined && !clock }
}
