import { composeAclAuthorityDocuments } from './compose-acl-store.js'
import { randomUUID } from 'node:crypto'
import type { BridgeStore } from './store.js'
import type { ModulesSyncOp } from './index.js'

/** Repairable bridge between HTTP/Yjs authority and durable snapshot authority.
 * HTTP commits first; current reads also intersect the HTTP ACL while this
 * checkpoint is being repaired. Per-document revisions include tombstones.
 */
export function syncComposeContentAccess(store: BridgeStore): ModulesSyncOp[] {
  if (!store.contentAccess.healthy()) throw new Error('Content authority unavailable')
  const teamId = store.ensureTeam().teamId
  const ops: ModulesSyncOp[] = composeAclAuthorityDocuments()
    .filter(doc => doc.revision > store.contentAccess.composeHttpRevision(doc.documentId))
    .map(doc => ({
      opId: `compose-acl:${randomUUID()}`, kind: 'compose.access',
      targetKind: 'compose_doc', targetId: doc.documentId, teamId, team_id: teamId,
      originMemberId: 'bridge-access-control', originDevice: 'bridge-access-control', originRole: 'admin',
      hlc: '0:0:bridge-access-control', protocolVersion: 2, hopCount: 0,
      // Explicit [] on removal; omitted means whole-team, matching sync wire.
      ...(doc.memberIds !== null ? { visibleToMemberIds: doc.memberIds } : {}),
      patch: { id: doc.documentId, composeAclRevision: doc.revision },
    }))
  if (!ops.length) return []
  try {
    const result = store.appendOps(ops)
    if (result.outcomes.some(outcome => outcome.status !== 'accepted' && outcome.status !== 'idempotent')) throw new Error('Could not persist Compose access notification')
    return result.accepted
  } catch (error) { store.contentAccess.failClosed(); throw error }
}
