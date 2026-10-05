import { retainIndependentCheckpoint } from './independent-authority.js'
/**
 * Team Space Compose document live co-edit ACL.
 *
 * The desktop Admin is authoritative and replaces this in-memory snapshot on
 * reconnect and whenever sharing changes. A document maps either to `null`
 * (shared with the whole team) or to an exact set of member ids. Missing or
 * malformed ids never grant access.
 *
 * The legacy `documentIds: string[]` representation remains supported and is
 * migrated in memory to `documentId -> null`, preserving old desktop clients.
 *
 * The bridge process used to keep this map only in memory and let every Admin
 * replace the whole thing on reconnect. Two Admins with different local
 * snapshots could therefore re-grant a board that another Admin had just
 * narrowed. The configured server store below is durable and accepts normal
 * changes as one-document mutations. A full snapshot is bootstrap-only; once
 * bootstrapped, a stale reconnect is a no-op instead of an ACL replacement.
 */

import { randomBytes } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'

const COMPOSE_ACL_ID_MAX_LEN = 128
const COMPOSE_ACL_MEMBER_ID_MAX_LEN = 128

/** Defensive ceiling independent of whatever the desktop side claims. */
export const COMPOSE_ACL_MAX_IDS = 10_000
/** Matches the desktop's bounded colleague audience for one shared item. */
export const COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT = 500
/** Bounds aggregate allocation even when every individual document is valid. */
export const COMPOSE_ACL_MAX_MEMBER_IDS_TOTAL = 50_000

type ComposeAclAudience = Set<string> | null

export type ComposeAclDocument = {
  documentId: string
  /** `null` means whole team; an array is an exact (possibly empty) audience. */
  memberIds: string[] | null
}

let composeAclByDocumentId = new Map<string, ComposeAclAudience>()

const COMPOSE_ACL_SCHEMA_VERSION = 1
const COMPOSE_ACL_FILE_NAME = 'compose-live-acl.json'
const COMPOSE_ACL_INITIALIZED_FILE_NAME = 'compose-live-acl.initialized'

type ComposeAclDiskDocument = {
  schemaVersion: 1
  revision: number
  /** False only during a new-server bootstrap that already received deltas. */
  bootstrapped: boolean
  /** Includes delete tombstones until the first full bootstrap. */
  touchedDocumentIds: string[]
  documents: ComposeAclDocument[]
  documentRevisions?: Record<string, number>
}

type ComposeAclPersistence = {
  dataDir: string
  path: string
  initializedPath: string
  atRest: AtRestKey | null
}

let composeAclPersistence: ComposeAclPersistence | null = null
let composeAclUnavailable = false
let composeAclBootstrapped = false
let composeAclRevision = 0
let composeAclDocumentRevisions = new Map<string, number>()
let composeAclTouchedDocumentIds = new Set<string>()

function scrubBoundedId(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string' || raw.includes('\0')) return null
  const value = raw.trim()
  if (!value || value.length > maxLength) return null
  return value
}

function scrubComposeAclId(raw: unknown): string | null {
  return scrubBoundedId(raw, COMPOSE_ACL_ID_MAX_LEN)
}

function scrubComposeAclMemberId(raw: unknown): string | null {
  return scrubBoundedId(raw, COMPOSE_ACL_MEMBER_ID_MAX_LEN)
}

function invalid(reason: string): { ok: false; reason: string } {
  return { ok: false, reason }
}

function cloneAudience(audience: ComposeAclAudience): ComposeAclAudience {
  return audience === null ? null : new Set(audience)
}

function cloneAclMap(source = composeAclByDocumentId): Map<string, ComposeAclAudience> {
  const next = new Map<string, ComposeAclAudience>()
  for (const [documentId, audience] of source) next.set(documentId, cloneAudience(audience))
  return next
}

function documentsFromMap(source: Map<string, ComposeAclAudience>): ComposeAclDocument[] {
  return [...source].map(([documentId, audience]) => ({
    documentId,
    memberIds: audience === null ? null : [...audience],
  }))
}

function parseComposeAclDocuments(
  rawDocuments: unknown,
): { ok: true; next: Map<string, ComposeAclAudience> } | { ok: false; reason: string } {
  if (!Array.isArray(rawDocuments)) return invalid('documents must be an array')
  if (rawDocuments.length > COMPOSE_ACL_MAX_IDS) {
    return invalid(`Too many documents (max ${COMPOSE_ACL_MAX_IDS})`)
  }

  const next = new Map<string, ComposeAclAudience>()
  let totalMemberIds = 0
  for (const rawDocument of rawDocuments) {
    if (!rawDocument || typeof rawDocument !== 'object' || Array.isArray(rawDocument)) {
      return invalid('documents must contain objects')
    }
    const row = rawDocument as Record<string, unknown>
    const documentId = scrubComposeAclId(row.documentId)
    if (!documentId) return invalid('Invalid documentId')
    if (next.has(documentId)) return invalid(`Duplicate documentId: ${documentId}`)

    if (row.memberIds === null) {
      next.set(documentId, null)
      continue
    }
    if (!Array.isArray(row.memberIds)) {
      return invalid('memberIds must be null or an array')
    }
    if (row.memberIds.length > COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT) {
      return invalid(
        `Too many members for document ${documentId} (max ${COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT})`,
      )
    }

    const audience = new Set<string>()
    for (const rawMemberId of row.memberIds) {
      const memberId = scrubComposeAclMemberId(rawMemberId)
      if (!memberId) return invalid(`Invalid memberId for document ${documentId}`)
      if (audience.has(memberId)) {
        return invalid(`Duplicate memberId for document ${documentId}: ${memberId}`)
      }
      audience.add(memberId)
      totalMemberIds += 1
      if (totalMemberIds > COMPOSE_ACL_MAX_MEMBER_IDS_TOTAL) {
        return invalid(`Too many member ids (max ${COMPOSE_ACL_MAX_MEMBER_IDS_TOTAL})`)
      }
    }
    next.set(documentId, audience)
  }
  return { ok: true, next }
}

function fileState(path: string): 'present' | 'missing' | 'unreadable' {
  try {
    return statSync(path).isFile() ? 'present' : 'unreadable'
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unreadable'
  }
}

function atomicWrite(path: string, dataDir: string, text: string): void {
  retainIndependentCheckpoint(dataDir, path===join(dataDir,COMPOSE_ACL_FILE_NAME)?COMPOSE_ACL_FILE_NAME:COMPOSE_ACL_INITIALIZED_FILE_NAME)
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  let fd = -1
  let dirFd = -1
  try {
    fd = openSync(tmp, 'wx', 0o600)
    writeSync(fd, text, undefined, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = -1
    renameSync(tmp, path)
    dirFd = openSync(dataDir, 'r')
    fsyncSync(dirFd)
    closeSync(dirFd)
    dirFd = -1
  } finally {
    if (fd >= 0) try { closeSync(fd) } catch { /* */ }
    if (dirFd >= 0) try { closeSync(dirFd) } catch { /* */ }
    try { unlinkSync(tmp) } catch { /* */ }
  }
}

function ensureInitializedMarker(persistence: ComposeAclPersistence): boolean {
  const state = fileState(persistence.initializedPath)
  if (state === 'present') return true
  if (state === 'unreadable') return false
  try {
    atomicWrite(
      persistence.initializedPath,
      persistence.dataDir,
      `${COMPOSE_ACL_SCHEMA_VERSION}\n`,
    )
    return true
  } catch {
    return false
  }
}

function parseDiskDocument(raw: unknown): {
  map: Map<string, ComposeAclAudience>
  revision: number
  bootstrapped: boolean
  touched: Set<string>
  documentRevisions: Map<string, number>
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const row = raw as Record<string, unknown>
  if (
    row.schemaVersion !== COMPOSE_ACL_SCHEMA_VERSION
    || typeof row.revision !== 'number'
    || !Number.isSafeInteger(row.revision)
    || row.revision < 0
    || typeof row.bootstrapped !== 'boolean'
    || !Array.isArray(row.touchedDocumentIds)
    || row.touchedDocumentIds.length > COMPOSE_ACL_MAX_IDS
  ) return null
  const parsed = parseComposeAclDocuments(row.documents)
  if (!parsed.ok) return null
  const touched = new Set<string>()
  for (const rawId of row.touchedDocumentIds) {
    const id = scrubComposeAclId(rawId)
    if (!id || touched.has(id)) return null
    touched.add(id)
  }
  if (row.bootstrapped && touched.size > 0) return null
  const documentRevisions = new Map<string, number>()
  if (row.documentRevisions !== undefined) {
    if (!row.documentRevisions || typeof row.documentRevisions !== 'object' || Array.isArray(row.documentRevisions)) return null
    for (const [id, revision] of Object.entries(row.documentRevisions)) {
      if (scrubComposeAclId(id) !== id || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0 || revision > row.revision) return null
      documentRevisions.set(id, revision)
    }
  }
  for (const id of new Set([...parsed.next.keys(), ...touched])) {
    if (!documentRevisions.has(id)) documentRevisions.set(id, row.revision)
  }
  return {
    map: parsed.next,
    revision: row.revision,
    bootstrapped: row.bootstrapped,
    touched,
    documentRevisions,
  }
}

/** Configure durable server storage. Existing unreadable state fails closed. */
export function configureComposeAclStore(
  dataDir: string,
  atRest: AtRestKey | null = null,
): void {
  mkdirSync(dataDir, { recursive: true })
  const persistence: ComposeAclPersistence = {
    dataDir,
    path: join(dataDir, COMPOSE_ACL_FILE_NAME),
    initializedPath: join(dataDir, COMPOSE_ACL_INITIALIZED_FILE_NAME),
    atRest,
  }
  composeAclPersistence = persistence
  composeAclByDocumentId = new Map()
  composeAclUnavailable = false
  composeAclBootstrapped = false
  composeAclRevision = 0
  composeAclDocumentRevisions = new Map()
  composeAclTouchedDocumentIds = new Set()

  const authorityFile = fileState(persistence.path)
  const markerFile = fileState(persistence.initializedPath)
  if (authorityFile === 'missing') {
    // A marker proves an authority file used to exist. Its disappearance is
    // corruption/deletion, never permission to accept a stale broad snapshot.
    if (markerFile !== 'missing') composeAclUnavailable = true
    return
  }
  if (authorityFile !== 'present' || markerFile === 'unreadable') {
    composeAclUnavailable = true
    return
  }
  try {
    const parsedRaw = decryptJsonFile<unknown>(
      atRest,
      readFileSync(persistence.path, 'utf8'),
      null,
    )
    const parsed = parseDiskDocument(parsedRaw)
    if (!parsed) throw new Error('invalid Compose ACL document')
    if (!ensureInitializedMarker(persistence)) throw new Error('marker write failed')
    composeAclByDocumentId = parsed.map
    composeAclRevision = parsed.revision
    composeAclDocumentRevisions = parsed.documentRevisions
    composeAclBootstrapped = parsed.bootstrapped
    composeAclTouchedDocumentIds = parsed.touched
  } catch {
    composeAclByDocumentId = new Map()
    composeAclUnavailable = true
  }
}

function commitComposeAcl(
  next: Map<string, ComposeAclAudience>,
  bootstrapped: boolean,
  touched: Set<string>,
): { ok: true; count: number; revision: number } | { ok: false; reason: string } {
  if (composeAclUnavailable) return invalid('Compose ACL store is unavailable')
  const revision = composeAclRevision + 1
  const documentRevisions = new Map(composeAclDocumentRevisions)
  for (const id of new Set([...composeAclByDocumentId.keys(), ...next.keys(), ...touched])) {
    const before = composeAclByDocumentId.get(id)
    const after = next.get(id)
    const same = before === after || (before instanceof Set && after instanceof Set
      && before.size === after.size && [...before].every(member => after.has(member)))
    if (!same || !documentRevisions.has(id)) documentRevisions.set(id, revision)
  }
  if (documentRevisions.size > 100_000) return invalid('Compose ACL revision index is full')
  const persistence = composeAclPersistence
  if (persistence) {
    const payload: ComposeAclDiskDocument = {
      schemaVersion: COMPOSE_ACL_SCHEMA_VERSION,
      revision,
      bootstrapped,
      touchedDocumentIds: bootstrapped ? [] : [...touched],
      documents: documentsFromMap(next),
      documentRevisions: Object.fromEntries(documentRevisions),
    }
    try {
      const encoded = persistence.atRest
        ? encryptJsonFile(persistence.atRest, payload)
        : JSON.stringify(payload, null, 2)
      atomicWrite(persistence.path, persistence.dataDir, encoded)
      if (!ensureInitializedMarker(persistence)) throw new Error('marker write failed')
    } catch {
      // The rename may have committed while a later fsync/marker failed.
      // Never serve the older, possibly broader in-memory audience afterward.
      composeAclUnavailable = true
      return invalid('Could not persist Compose ACL')
    }
  }
  composeAclByDocumentId = next
  composeAclBootstrapped = bootstrapped
  composeAclTouchedDocumentIds = bootstrapped ? new Set() : new Set(touched)
  composeAclRevision = revision
  composeAclDocumentRevisions = documentRevisions
  return { ok: true, count: next.size, revision }
}

/**
 * Replace the full ACL with the member-aware representation. Validation is
 * atomic: an invalid snapshot is rejected without partially broadening or
 * partially narrowing the last valid authoritative snapshot.
 */
export function setComposeAclDocuments(
  rawDocuments: unknown,
): { ok: true; count: number } | { ok: false; reason: string } {
  const parsed = parseComposeAclDocuments(rawDocuments)
  if (!parsed.ok) return parsed
  const committed = commitComposeAcl(parsed.next, true, new Set())
  return committed.ok
    ? { ok: true, count: committed.count }
    : committed
}

/** Legacy whole-team replace API. Every listed id becomes a whole-team entry. */
export function setComposeAclSharedDocIds(
  rawIds: unknown,
): { ok: true; count: number } | { ok: false; reason: string } {
  if (!Array.isArray(rawIds)) return invalid('documentIds must be an array')
  if (rawIds.length > COMPOSE_ACL_MAX_IDS) {
    return invalid(`Too many documentIds (max ${COMPOSE_ACL_MAX_IDS})`)
  }
  const documents: ComposeAclDocument[] = []
  const seen = new Set<string>()
  for (const rawId of rawIds) {
    const documentId = scrubComposeAclId(rawId)
    if (!documentId) return invalid('Invalid documentId')
    if (seen.has(documentId)) return invalid(`Duplicate documentId: ${documentId}`)
    seen.add(documentId)
    documents.push({ documentId, memberIds: null })
  }
  return setComposeAclDocuments(documents)
}

export type ComposeAclMutation =
  | { documentId: string; memberIds: string[] | null }
  | { documentId: string; remove: true }

/**
 * Apply one exact document change. This is the normal multi-Admin API: it
 * cannot clobber unrelated documents, and a delete remains as a bootstrap
 * tombstone if it arrives before the original Admin's first snapshot.
 */
export function mutateComposeAclDocument(
  rawMutation: unknown,
): { ok: true; count: number; revision: number; changed: boolean } | { ok: false; reason: string } {
  if (!rawMutation || typeof rawMutation !== 'object' || Array.isArray(rawMutation)) {
    return invalid('mutation must be an object')
  }
  const row = rawMutation as Record<string, unknown>
  const documentId = scrubComposeAclId(row.documentId)
  if (!documentId) return invalid('Invalid documentId')
  const isRemove = row.remove === true
  if (isRemove && Object.prototype.hasOwnProperty.call(row, 'memberIds')) {
    return invalid('remove mutation must not include memberIds')
  }
  let desired: ComposeAclAudience | undefined
  if (!isRemove) {
    const parsed = parseComposeAclDocuments([{
      documentId,
      memberIds: row.memberIds,
    }])
    if (!parsed.ok) return parsed
    desired = parsed.next.get(documentId)
  }

  const current = composeAclByDocumentId.get(documentId)
  const unchanged = isRemove
    ? !composeAclByDocumentId.has(documentId)
    : current === null
      ? desired === null
      : current instanceof Set
        && desired instanceof Set
        && current.size === desired.size
        && [...current].every((id) => desired.has(id))
  const touched = new Set(composeAclTouchedDocumentIds)
  touched.add(documentId)
  // Before bootstrap, even an otherwise-idempotent remove must be persisted
  // as a tombstone so the later snapshot cannot resurrect the document.
  if (unchanged && (composeAclBootstrapped || composeAclTouchedDocumentIds.has(documentId))) {
    return {
      ok: true,
      count: composeAclByDocumentId.size,
      revision: composeAclRevision,
      changed: false,
    }
  }
  const next = cloneAclMap()
  if (isRemove) next.delete(documentId)
  else next.set(documentId, cloneAudience(desired!))
  const committed = commitComposeAcl(next, composeAclBootstrapped, touched)
  return committed.ok ? { ...committed, changed: true } : committed
}

/**
 * Remove departed members from every exact live-board audience in one durable
 * commit. Whole-team entries stay whole-team: the roster/session authority is
 * what excludes a departed member there. Keeping this cleanup on the bridge
 * means a stale Admin desktop cannot leave the removed member in the canonical
 * explicit ACL, and bulk offboarding does not require one HTTP write per board.
 */
export function removeComposeAclMembers(
  rawMemberIds: unknown,
):
  | { ok: true; count: number; revision: number; changed: boolean; changedDocuments: number }
  | { ok: false; reason: string } {
  if (!Array.isArray(rawMemberIds)) return invalid('memberIds must be an array')
  if (rawMemberIds.length > COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT) {
    return invalid(`Too many memberIds (max ${COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT})`)
  }
  const targets = new Set<string>()
  for (const rawMemberId of rawMemberIds) {
    const memberId = scrubComposeAclMemberId(rawMemberId)
    if (!memberId) return invalid('Invalid memberId')
    targets.add(memberId)
  }
  if (targets.size === 0) {
    return {
      ok: true,
      count: composeAclByDocumentId.size,
      revision: composeAclRevision,
      changed: false,
      changedDocuments: 0,
    }
  }

  const next = cloneAclMap()
  const touched = new Set(composeAclTouchedDocumentIds)
  let changedDocuments = 0
  for (const [documentId, audience] of next) {
    if (!(audience instanceof Set)) continue
    let changed = false
    for (const memberId of targets) {
      if (audience.delete(memberId)) changed = true
    }
    if (!changed) continue
    changedDocuments += 1
    touched.add(documentId)
  }
  if (changedDocuments === 0) {
    if (composeAclUnavailable) return invalid('Compose ACL store is unavailable')
    return {
      ok: true,
      count: composeAclByDocumentId.size,
      revision: composeAclRevision,
      changed: false,
      changedDocuments: 0,
    }
  }
  const committed = commitComposeAcl(next, composeAclBootstrapped, touched)
  return committed.ok
    ? { ...committed, changed: true, changedDocuments }
    : committed
}

/**
 * Seed a new bridge once. Deltas that landed first win per document; their
 * ids (including delete tombstones) are not overwritten by the snapshot.
 */
export function bootstrapComposeAclDocuments(
  rawDocuments: unknown,
): { ok: true; count: number; revision: number; changed: boolean } | { ok: false; reason: string } {
  const parsed = parseComposeAclDocuments(rawDocuments)
  if (!parsed.ok) return parsed
  if (composeAclUnavailable) return invalid('Compose ACL store is unavailable')
  if (composeAclBootstrapped) {
    return {
      ok: true,
      count: composeAclByDocumentId.size,
      revision: composeAclRevision,
      changed: false,
    }
  }
  const next = cloneAclMap()
  for (const [documentId, audience] of parsed.next) {
    if (composeAclTouchedDocumentIds.has(documentId)) continue
    next.set(documentId, cloneAudience(audience))
  }
  const committed = commitComposeAcl(next, true, new Set())
  return committed.ok ? { ...committed, changed: true } : committed
}

export function bootstrapComposeAclSharedDocIds(
  rawIds: unknown,
): { ok: true; count: number; revision: number; changed: boolean } | { ok: false; reason: string } {
  if (!Array.isArray(rawIds)) return invalid('documentIds must be an array')
  if (rawIds.length > COMPOSE_ACL_MAX_IDS) {
    return invalid(`Too many documentIds (max ${COMPOSE_ACL_MAX_IDS})`)
  }
  const documents: ComposeAclDocument[] = []
  const seen = new Set<string>()
  for (const rawId of rawIds) {
    const documentId = scrubComposeAclId(rawId)
    if (!documentId) return invalid('Invalid documentId')
    if (seen.has(documentId)) return invalid(`Duplicate documentId: ${documentId}`)
    seen.add(documentId)
    documents.push({ documentId, memberIds: null })
  }
  return bootstrapComposeAclDocuments(documents)
}

export function composeAclStoreStatus(): {
  unavailable: boolean
  bootstrapped: boolean
  revision: number
  count: number
} {
  return {
    unavailable: composeAclUnavailable,
    bootstrapped: composeAclBootstrapped,
    revision: composeAclRevision,
    count: composeAclByDocumentId.size,
  }
}

/** True when a document is explicitly shared with the whole team. */
export function isComposeDocSharedWithTeam(documentId: unknown): boolean {
  const id = scrubComposeAclId(documentId)
  if (!id || !composeAclByDocumentId.has(id)) return false
  return composeAclByDocumentId.get(id) === null
}

/** True when this exact member may access the document. */
export function isComposeDocSharedWithMember(
  documentId: unknown,
  memberId: unknown,
): boolean {
  const id = scrubComposeAclId(documentId)
  const member = scrubComposeAclMemberId(memberId)
  if (composeAclUnavailable || !id || !member || !composeAclByDocumentId.has(id)) return false
  const audience = composeAclByDocumentId.get(id)
  return audience === null || audience?.has(member) === true
}

export function composeAclSharedDocCount(): number {
  return composeAclByDocumentId.size
}

/** Includes removal tombstones so sync authority can recover after a crash. */
export function composeAclAuthorityDocuments(): Array<ComposeAclDocument & { revision: number }> {
  if (composeAclUnavailable) throw new Error('Compose ACL store is unavailable')
  return [...composeAclDocumentRevisions].map(([documentId, revision]) => ({
    documentId, revision,
    memberIds: composeAclByDocumentId.get(documentId) === null ? null : [...(composeAclByDocumentId.get(documentId) ?? [])],
  }))
}

/** Test-only reset hook (unit tests import this to isolate cases). */
export function resetComposeAclStoreForTests(): void {
  composeAclByDocumentId = new Map<string, ComposeAclAudience>()
  composeAclPersistence = null
  composeAclUnavailable = false
  composeAclBootstrapped = false
  composeAclRevision = 0
  composeAclDocumentRevisions = new Map()
  composeAclTouchedDocumentIds = new Set()
}
