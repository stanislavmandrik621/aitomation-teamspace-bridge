/** Current server grants for a bounded backup inventory. No saved ACL, actor,
 * parent, payload or field name from the client participates in authorization. */
import { createHash } from 'node:crypto'
import type { BridgeRole } from './index.js'
import type { ContentAccessIndex } from './content-access.js'
import type { SharedOfficeObject } from './office-objects.js'

export const BACKUP_READ_SCOPE_VERSION = 1
export const BACKUP_READ_SCOPE_BATCH = 500
const kinds = new Set(['module', 'entity', 'field', 'view', 'record', 'comment', 'playbook', 'compose', 'blob', 'office-department', 'office-floor', 'office-room', 'chat-room', 'chat-blob'])
export type BackupReadTarget = { kind: string; id: string }
export type BackupReadGrant = BackupReadTarget & {
  root: string; entityId: string; parent: string; revision: number; privateFields: boolean
  field?: { slug: string; type?: string; multiple?: boolean }
  office?: SharedOfficeObject
  officeLocalOwner?: boolean
}
export type BackupReadScope = {
  version: 1; teamId: string; memberId: string; fingerprint: string; authorityStamp: string
  grants: Array<BackupReadGrant | null>
}
export function parseBackupReadTargets(raw: unknown): BackupReadTarget[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid backup inventory')
  const body = raw as Record<string, unknown>
  if (Object.keys(body).some(key => !['version', 'targets', 'fingerprint', 'authorityStamp'].includes(key)) || body.version !== BACKUP_READ_SCOPE_VERSION
    || !Array.isArray(body.targets) || !body.targets.length || body.targets.length > BACKUP_READ_SCOPE_BATCH) throw new Error('Invalid backup inventory')
  if (body.fingerprint !== undefined && (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint))) throw new Error('Invalid backup authority fingerprint')
  if (body.authorityStamp !== undefined && (typeof body.authorityStamp !== 'string' || !/^[a-f0-9]{64}$/.test(body.authorityStamp))) throw new Error('Invalid backup authority stamp')
  const seen = new Set<string>()
  return body.targets.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid backup target')
    const row = raw as Record<string, unknown>
    if (Object.keys(row).length !== 2 || typeof row.kind !== 'string' || !kinds.has(row.kind)
      || typeof row.id !== 'string' || !row.id || row.id.length > 128 || row.id.trim() !== row.id
      || !row.id.isWellFormed() || /[\p{Cc}\p{Default_Ignorable_Code_Point}]/u.test(row.id)
      || ['__proto__','prototype','constructor'].includes(row.id)
      || (row.kind === 'blob'||row.kind==='chat-blob') && !/^[a-f0-9]{64}$/.test(row.id)) throw new Error('Invalid backup target')
    const key = JSON.stringify([row.kind, row.id])
    if (seen.has(key)) throw new Error('Duplicate backup target')
    seen.add(key)
    return { kind: row.kind, id: row.id }
  })
}
export function backupReadScope(args: {
  targets: BackupReadTarget[]; authority: ContentAccessIndex; teamId: string; memberId: string; role: BridgeRole
  fieldAuthorityHash: string; composeAuthorityRevision?: number
  secondaryAuthorityStamp?: string
  secondaryTarget?: (target: BackupReadTarget) => BackupReadGrant | null
}): BackupReadScope {
  if (!args.authority.healthy() || !args.fieldAuthorityHash || !['admin','member','viewer'].includes(args.role)) throw new Error('Backup read authority is unavailable')
  const grants = args.targets.map(target => {
    if (target.kind.startsWith('office-') || target.kind.startsWith('chat-')) return args.secondaryTarget?.(target) ?? null
    const grant = args.authority.backupTarget(target.kind, target.id, args.memberId, args.role)
    if (!grant) return null
    const field = target.kind === 'field' ? args.authority.fieldDefinition(grant.entityId, target.id) : null
    return { ...target, ...grant, ...(field ? { field } : {}) }
  })
  const authorityStamp = createHash('sha256').update(JSON.stringify({ teamId: args.teamId, memberId: args.memberId,
    role: args.role, content: args.authority.backupAccessStamp(), field: args.fieldAuthorityHash,
    compose: args.composeAuthorityRevision ?? 0, secondary: args.secondaryAuthorityStamp ?? '' })).digest('hex')
  const fingerprint = createHash('sha256').update(JSON.stringify({ version: 1, teamId: args.teamId,
    memberId: args.memberId, role: args.role, fieldAuthorityHash: args.fieldAuthorityHash, targets: args.targets, grants })).digest('hex')
  return { version: 1, teamId: args.teamId, memberId: args.memberId, fingerprint, authorityStamp, grants }
}
