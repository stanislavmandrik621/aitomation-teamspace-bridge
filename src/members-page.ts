/**
 * Team Space Admin member roster paging (TS-MEM-001).
 * Wire page size is bounded; total/has_more honesty so a silent slice cannot hide teammates.
 */

export const TEAMSPACE_MEMBERS_PAGE_DEFAULT = 100
export const TEAMSPACE_MEMBERS_PAGE_MAX = 500

export function clampMembersPageLimit(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.floor(raw)
    if (n <= 0) return TEAMSPACE_MEMBERS_PAGE_DEFAULT
    return Math.min(TEAMSPACE_MEMBERS_PAGE_MAX, n)
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw)
    if (Number.isFinite(n)) return clampMembersPageLimit(n)
  }
  return TEAMSPACE_MEMBERS_PAGE_DEFAULT
}

export function clampMembersPageOffset(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const n = Math.floor(raw)
    return n > 0 ? n : 0
  }
  if (typeof raw === 'string' && raw.trim()) {
    const n = Number(raw)
    if (Number.isFinite(n)) return clampMembersPageOffset(n)
  }
  return 0
}

export function pageMembersList<T>(
  all: readonly T[],
  limitRaw?: unknown,
  offsetRaw?: unknown,
): {
  members: T[]
  total: number
  limit: number
  offset: number
  has_more: boolean
  truncated: boolean
} {
  const total = all.length
  const limit = clampMembersPageLimit(limitRaw)
  const offset = Math.min(clampMembersPageOffset(offsetRaw), total)
  const members = all.slice(offset, offset + limit)
  const has_more = offset + members.length < total
  return {
    members,
    total,
    limit,
    offset,
    has_more,
    truncated: has_more,
  }
}
