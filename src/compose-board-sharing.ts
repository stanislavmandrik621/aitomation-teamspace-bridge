import { randomUUID } from 'node:crypto'
import { composeAclManagement, mutateComposeAclDocument } from './compose-acl-store.js'
import { syncComposeContentAccess } from './compose-content-access.js'
import { contentBlobHashes } from './content-access.js'
import type { BridgeStore } from './store.js'
import type { BridgeRole, ModulesSyncOp } from './index.js'

export function composeBoardManagement(store: BridgeStore, documentId: string, memberId: string, role: BridgeRole) {
  return composeAclManagement(documentId, memberId, role, store.contentAccess.composeHttpRevision(documentId) >= 0
    || store.contentAccess.revision({ kind: 'compose.doc.create', targetId: documentId } as ModulesSyncOp) > 0)
}

/** An invited member publishes their own board without becoming an Admin.
 * Only this narrow endpoint mints a server-authored snapshot; ordinary Viewer
 * writes and arbitrary client-supplied administrator operations stay refused. */
export function shareOwnedComposeBoard(store: BridgeStore, memberId: string, role: BridgeRole, raw: unknown):
  { ok: true; ops: ModulesSyncOp[]; memberIds: string[] | null } | { ok: false; status: number; error: string } {
  const fail = (error: string, status = 400) => ({ ok: false as const, error, status })
  if (!store.contentAccess.healthy()) return fail('Content authority is unavailable', 503)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid board sharing request')
  const body = raw as Record<string, unknown>
  const documentId = typeof body.documentId === 'string' ? body.documentId : ''
  if (!documentId || documentId.length > 128 || documentId.trim() !== documentId || /[\u0000-\u001f]/.test(documentId)) return fail('Invalid board ID')
  const access = composeBoardManagement(store, documentId, memberId, role)
  if (!access.canManage) return fail('Only the board owner or an authorized administrator can change access', 403)
  const remove = body.remove === true
  if (remove && !access.known) return fail('This board has never been shared', 409)
  let snapshot: Record<string, unknown> | undefined
  let attachments: string[] = []
  let audience: string[] | null = null
  if (!remove) {
    if (body.memberIds !== null) {
      if (!Array.isArray(body.memberIds) || !body.memberIds.length || body.memberIds.length > 500
        || body.memberIds.some(id => typeof id !== 'string' || !id || id.length > 128 || id.trim() !== id)) return fail('Choose valid teammates or the whole team')
      const roster = new Set(store.listMembers().map(member => member.memberId))
      if (body.memberIds.some(id => !roster.has(id))) return fail('The selected teammate is no longer on this team')
      audience = [...new Set([...body.memberIds, access.ownerMemberId || memberId])]
    }
    const source = body.snapshot as Record<string, unknown> | undefined
    if (!source || typeof source !== 'object' || Array.isArray(source) || source.id !== documentId
      || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 500
      || typeof source.graphJson !== 'string' || Buffer.byteLength(source.graphJson) > 512 * 1024
      || !Number.isSafeInteger(source.tipRev) || Number(source.tipRev) < 0 || source.graphTruncated === true) return fail('A complete saved board snapshot is required')
    let graph: unknown
    try { graph = JSON.parse(source.graphJson) } catch { return fail('Invalid board scene') }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) return fail('Invalid board scene')
    try {
      attachments = [...contentBlobHashes(graph)]
      for (const hash of attachments) {
        if (!store.contentAccess.mayAttachBlob(hash, memberId, role)) return fail('A board attachment is not accessible', 403)
      }
    } catch { return fail('Invalid board attachments') }
    snapshot = { id: documentId, title: source.title, graphJson: source.graphJson, tipRev: source.tipRev,
      schemaVersion: Number.isSafeInteger(source.schemaVersion) ? source.schemaVersion : 1 }
  }
  const changed = mutateComposeAclDocument(remove ? { documentId, remove: true } : { documentId, memberIds: audience },
    { memberId, role, knownDocument: access.known })
  if (!changed.ok) return fail(changed.reason, 503)
  const ops = syncComposeContentAccess(store)
  if (snapshot) {
    const teamId = store.ensureTeam().teamId
    const snapshotOp: ModulesSyncOp = {
      opId: `compose-share:${randomUUID()}`, kind: 'compose.doc.create', targetKind: 'compose_doc', targetId: documentId,
      teamId, team_id: teamId, originRole: 'admin', originMemberId: 'bridge-access-control', originDevice: 'bridge-access-control',
      hlc: `${Date.now()}:0:bridge-compose`, protocolVersion: 2, hopCount: 0,
      ...(audience !== null ? { visibleToMemberIds: audience } : {}), patch: snapshot,
    }
    const saved = store.appendOps([snapshotOp])
    if (saved.outcomes.some(result => result.status !== 'accepted' && result.status !== 'idempotent')) return fail('Could not persist the shared board snapshot', 503)
    ops.push(...saved.accepted)
    // A repeated snapshot may be idempotent, so reference indexing need not
    // run again. Consume this publisher's fresh staging grants explicitly.
    for (const hash of attachments) store.contentAccess.consumeUpload(hash, memberId)
  }
  return { ok: true, ops, memberIds: audience }
}
