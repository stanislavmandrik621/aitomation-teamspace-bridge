/**
 * Team Space Compose document live co-edit ACL (TCC-FIX-CMP-001).
 *
 * Desktop's `sharedComposeDocIds` model (COMPOSE-036) is whole-team-only: a
 * Compose board is either shared with the whole team or not shared at all -
 * there is no per-member colleague scope for Compose like Modules'
 * `sharedModuleMemberScopes`. This store mirrors that exact polarity on the
 * bridge so it does not invent a finer-grained model than desktop supports.
 *
 * The desktop HOST (Admin) is the source of truth and pushes the full
 * current shared-doc id set here over HTTP (`POST /v1/teamspace/compose-acl`)
 * whenever its local allowlist changes, and again on every reconnect (see
 * `apps/desktop/electron/modules-sync/compose-acl-push.ts`) - this map is
 * in-memory only and a bridge restart clears it until the host re-pushes.
 *
 * Fail closed: an id with no entry is NOT shared (matches the desktop
 * default documented in `shared-gate.ts`: "empty sharedComposeDocIds = none
 * shared" - never "whole team" for a missing id).
 */

const COMPOSE_ACL_ID_MAX_LEN = 128

/** Defensive ceiling independent of whatever the desktop side claims - matches TEAMSPACE_SHARED_IDS_CEILING_MAX. */
export const COMPOSE_ACL_MAX_IDS = 10_000

let sharedComposeDocIds = new Set<string>()

function scrubComposeAclId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\0/g, '').trim()
  if (!s || s.length > COMPOSE_ACL_ID_MAX_LEN) return null
  return s
}

/**
 * Admin HOST pushes the full current shared-doc set (replace semantics, not
 * a delta) - simplest correct design given the host always has the full
 * local allowlist on hand and this also doubles as the reconnect resync.
 */
export function setComposeAclSharedDocIds(
  rawIds: unknown,
): { ok: true; count: number } | { ok: false; reason: string } {
  if (!Array.isArray(rawIds)) {
    return { ok: false, reason: 'documentIds must be an array' }
  }
  const next = new Set<string>()
  for (const raw of rawIds) {
    const id = scrubComposeAclId(raw)
    if (!id) continue
    next.add(id)
    if (next.size >= COMPOSE_ACL_MAX_IDS) break
  }
  sharedComposeDocIds = next
  return { ok: true, count: next.size }
}

/** True when `documentId` is currently shared with the whole team. */
export function isComposeDocSharedWithTeam(documentId: unknown): boolean {
  const id = scrubComposeAclId(documentId)
  if (!id) return false
  return sharedComposeDocIds.has(id)
}

export function composeAclSharedDocCount(): number {
  return sharedComposeDocIds.size
}

/** Test-only reset hook (unit tests import this to isolate cases). */
export function resetComposeAclStoreForTests(): void {
  sharedComposeDocIds = new Set<string>()
}
