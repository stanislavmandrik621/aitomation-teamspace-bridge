/**
 * P1-C public share registry + Form intake queue on the Team Space bridge.
 * Never store this in Directus / v-aid cloud - TEAMSPACE_DATA_DIR only.
 */

import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  type AtRestKey,
  decryptJsonFile,
  encryptJsonFile,
} from './at-rest.js'
import {
  findGuestRegistryIndex,
  GUEST_STORE_SHARE_TEAM_MISMATCH,
  pruneSessionMapOverCap,
  resolveGuestStoreStamp,
  capGuestStoreTeamId,
  capGuestStoreScopeId,
  GUEST_STORE_LOCAL_SHARE_ID_MAX,
  GUEST_STORE_SCOPE_ID_MAX,
  mapGuestRegistryRows,
  readGuestRegistryArray,
} from './portal-store.js'
import { capStr } from './text-cap.js'

const REGISTRY_FILE = 'public-shares.json'
const PAYLOAD_DIR = 'public-share-payloads'
const SUBMISSIONS_DIR = 'public-share-submissions'
const PAYLOAD_JSON_MAX = 1_500_000
const MAX_SHARES = 500
const MAX_PENDING_SUBMISSIONS = 2_000
/** TCC-R1150-BKP-001 public-share twin: peer drain skips a stamped lease. */
const SUBMISSION_CLAIM_LEASE_MS = 5 * 60 * 1000
/** TCC-R1147-BRG-003: same anon create budget as portal twin (10 / hour). */
const ANON_RATE_PER_WINDOW = 10
const ANON_RATE_WINDOW_MS = 60 * 60_000

export type PublicShareMode = 'read' | 'create'

export type PublicShareRow = {
  tokenHash: string
  localShareId: string
  mode: PublicShareMode
  viewType: string
  label: string
  passwordHash: string | null
  includeCsv: boolean
  expiresAt: number | null
  revokedAt: number | null
  payloadReady: boolean
  createdAt: number
  updatedAt: number
  ownerMemberId: string
  /** Optional desktop `team_id`. Blank is leftover. Named mismatch refuses. */
  teamId?: string
}

/**
 * Guest share payload. Version 1 is the original flat shape (rows carry raw
 * `data` only; the guest page renders a table). Version 2 (SHARE-PAGES-A /
 * SHARE-DESK-B wave) adds the fields the per-viewType guest renderers need:
 * module/table display names for the page header, `columns` (ordered visible
 * field slugs), `viewConfig` bindings (board lanes, card title, gallery
 * image), and per-row `display` maps of preformatted human-readable strings
 * so the guest page never has to stringify raw objects. Both versions stay
 * admitted - a desktop older than the bridge keeps pushing v1 forever.
 */
export type PublicSharePayload = {
  version: 1 | 2
  mode: PublicShareMode
  viewType: string
  label: string
  /** v2 only: module display name for the guest page header (capped by the desktop builder). */
  moduleName?: string
  /** v2 only: table display name for the guest page header (capped by the desktop builder). */
  entityName?: string
  entityId: string
  fields: Array<{
    slug: string
    name: string
    field_type: string
    required: boolean
    config: Record<string, unknown>
    default_value: string | null
  }>
  /** v2 only: ordered field slugs the view displays; omitted = all fields in order. */
  columns?: string[]
  /** v2 only: view bindings the guest renderers dispatch on. */
  viewConfig?: {
    groupByFieldSlug?: string | null
    titleFieldSlug?: string | null
    imageFieldSlug?: string | null
    dateFieldSlug?: string | null
    contentFieldSlug?: string | null
    startDateFieldSlug?: string | null
  }
  rows: Array<{ id: string; data: Record<string, unknown>; display?: Record<string, string> }>
  total: number
  truncated: boolean
  includeCsv: boolean
  pushedAt: number
}

export type PublicShareSubmission = {
  id: string
  localShareId: string
  entityId: string
  data: Record<string, unknown>
  status: 'pending' | 'applied' | 'rejected'
  error: string | null
  createdAt: number
  updatedAt: number
  /** Set when an Admin drain pages this row (TCC-R1150-BKP-001 twin). */
  claimedAt?: number | null
}

function atomicWriteJson(path: string, data: unknown, atRest: AtRestKey | null): void {
  const tmp = `${path}.${process.pid}.tmp`
  const body = atRest
    ? encryptJsonFile(atRest, data)
    : JSON.stringify(data, null, 2)
  writeFileSync(tmp, body, 'utf8')
  renameSync(tmp, path)
}

function readJson<T>(path: string, fallback: T, atRest: AtRestKey | null): T {
  try {
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, 'utf8')
    return decryptJsonFile<T>(atRest, raw, fallback) ?? fallback
  } catch {
    return fallback
  }
}

export function hashPublicShareToken(tokenPlain: string): string {
  return createHash('sha256').update(String(tokenPlain), 'utf8').digest('hex')
}

export function isPublicSharePasswordHash(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  const s = raw.trim()
  if (!s || s.length > 200) return false
  const parts = s.split('$')
  if (parts.length !== 3 || parts[0] !== 's') return false
  const saltHex = parts[1] ?? ''
  const hashHex = parts[2] ?? ''
  return (
    /^[0-9a-f]+$/i.test(saltHex) &&
    /^[0-9a-f]+$/i.test(hashHex) &&
    saltHex.length >= 16 &&
    hashHex.length >= 32
  )
}

export function verifyPublicSharePassword(
  stored: string | null | undefined,
  attempt: string | null | undefined,
): boolean {
  if (!stored) return true
  if (typeof attempt !== 'string' || !attempt) return false
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 's') return false
  const saltHex = parts[1] ?? ''
  const hashHex = parts[2] ?? ''
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false
  try {
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const got = scryptSync(attempt, salt, expected.length, { N: 16384, r: 8, p: 1 })
    if (got.length !== expected.length) return false
    return timingSafeEqual(got, expected)
  } catch {
    return false
  }
}

function isShareActive(row: PublicShareRow, now = Date.now()): boolean {
  if (typeof row.revokedAt === 'number' && row.revokedAt > 0) return false
  if (typeof row.expiresAt === 'number' && row.expiresAt > 0 && now >= row.expiresAt) {
    return false
  }
  return true
}

function shareDeadAt(row: PublicShareRow): number {
  const rev = typeof row.revokedAt === 'number' && row.revokedAt > 0 ? row.revokedAt : 0
  const exp = typeof row.expiresAt === 'number' && row.expiresAt > 0 ? row.expiresAt : 0
  const updated = typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0
  return Math.max(rev, exp, updated)
}

function isShareRevoked(row: PublicShareRow): boolean {
  return typeof row.revokedAt === 'number' && row.revokedAt > 0
}

/**
 * TCC-FIX-SHARE-013 drain/ack/count twin. Named caller sees that team only.
 * Omit/blank sees leftover '' only (never every team). Upsert leftover-admit
 * stays the other polarity: a blank drain must not apply a named team's intake.
 */
function guestStoreTeamMatchesScope(stored: unknown, caller: unknown): boolean {
  const s = capGuestStoreTeamId(stored)
  const c = capGuestStoreTeamId(caller)
  if (c) return s === c
  return !s
}

/**
 * Guest form POST bodies can still send objects. String(object) persisted
 * "[object Object]" into the intake queue (TCC-FIX-SHARE-002 write twin).
 * Keep primitives, join primitive arrays, take a name/label/... string from
 * objects, otherwise skip the key. Caps go through capStr so a cut mid
 * surrogate pair drops the trailing lead (TS-CHAT-032/034).
 */
function acceptGuestFieldValue(v: unknown): unknown {
  if (typeof v === 'string') return capStr(v, 10_000)
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'boolean') return v
  if (v === null) return null
  if (Array.isArray(v)) {
    const parts: string[] = []
    for (let i = 0; i < v.length && i < 100; i += 1) {
      const item = v[i]
      if (typeof item === 'string' && item.trim()) parts.push(capStr(item, 200))
      else if (typeof item === 'number' && Number.isFinite(item)) parts.push(String(item))
      else if (typeof item === 'boolean') parts.push(String(item))
    }
    return capStr(parts.join(', '), 10_000)
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const key of ['name', 'label', 'title', 'display', 'value', 'id'] as const) {
      const x = o[key]
      if (typeof x === 'string' && x.trim()) return capStr(x, 10_000)
      if (typeof x === 'number' && Number.isFinite(x)) return String(x)
    }
  }
  return undefined
}

function isPayload(raw: unknown): raw is PublicSharePayload {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const o = raw as Record<string, unknown>
  // v1 (legacy flat shape) and v2 (display cells + columns + viewConfig)
  // are both admitted; anything else is refused so the guest page never
  // meets a shape the renderers were not written for.
  if (o.version !== 1 && o.version !== 2) return false
  if (o.mode !== 'read' && o.mode !== 'create') return false
  if (typeof o.viewType !== 'string' || typeof o.label !== 'string') return false
  if (typeof o.entityId !== 'string' || !o.entityId.trim()) return false
  if (!Array.isArray(o.fields) || !Array.isArray(o.rows)) return false
  if (o.version === 2) {
    // v2 extras are optional but must be the declared shape when present.
    if (o.columns !== undefined && !Array.isArray(o.columns)) return false
    if (
      o.viewConfig !== undefined &&
      (o.viewConfig === null || typeof o.viewConfig !== 'object' || Array.isArray(o.viewConfig))
    ) {
      return false
    }
    if (o.moduleName !== undefined && typeof o.moduleName !== 'string') return false
    if (o.entityName !== undefined && typeof o.entityName !== 'string') return false
  }
  return true
}

export class PublicShareBridgeStore {
  private readonly registryPath: string
  private readonly payloadDir: string
  private readonly submissionsDir: string
  private readonly atRest: AtRestKey | null
  /** TCC-R1147-BRG-003: per-IP anon create submission budget. */
  private readonly anonBuckets = new Map<string, { count: number; refillAt: number }>()

  constructor(dataDir: string, atRest: AtRestKey | null) {
    this.atRest = atRest
    this.registryPath = join(dataDir, REGISTRY_FILE)
    this.payloadDir = join(dataDir, PAYLOAD_DIR)
    this.submissionsDir = join(dataDir, SUBMISSIONS_DIR)
    mkdirSync(this.payloadDir, { recursive: true })
    mkdirSync(this.submissionsDir, { recursive: true })
  }

  takeAnonRate(ipKey: string): boolean {
    const k = String(ipKey || 'unknown').slice(0, 128)
    const now = Date.now()
    let b = this.anonBuckets.get(k)
    if (!b || now >= b.refillAt) {
      b = { count: 0, refillAt: now + ANON_RATE_WINDOW_MS }
      this.anonBuckets.set(k, b)
    }
    if (b.count >= ANON_RATE_PER_WINDOW) {
      pruneSessionMapOverCap(this.anonBuckets, now, (v) => v.refillAt)
      return false
    }
    b.count += 1
    pruneSessionMapOverCap(this.anonBuckets, now, (v) => v.refillAt)
    return true
  }

  private loadRegistryResult():
    | { ok: true; shares: PublicShareRow[] }
    | { ok: false; reason: string } {
    const loaded = readGuestRegistryArray(this.registryPath, this.atRest, 'shares')
    if (!loaded.ok) return loaded
    const shares = mapGuestRegistryRows<PublicShareRow>(loaded.rows).map((row) => ({
      ...row,
      localShareId: capGuestStoreScopeId(row.localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX),
      ownerMemberId: capGuestStoreScopeId(row.ownerMemberId, GUEST_STORE_SCOPE_ID_MAX),
    }))
    return { ok: true, shares }
  }

  private unlinkPayloadFile(tokenHash: string): void {
    const h = typeof tokenHash === 'string' ? tokenHash.toLowerCase() : ''
    if (!/^[0-9a-f]{64}$/.test(h)) return
    try {
      const p = join(this.payloadDir, `${h}.json`)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
  }

  private scrubSubmissionsForLocalShareId(localShareId: string): void {
    const id = capGuestStoreScopeId(localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    if (!id) return
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return
    }
    for (const name of names) {
      const path = join(this.submissionsDir, name)
      const sub = readJson<PublicShareSubmission | null>(path, null, this.atRest)
      if (sub && typeof sub.localShareId === 'string' && sub.localShareId === id) {
        try {
          unlinkSync(path)
        } catch {
          /* best-effort */
        }
      }
    }
  }

  private sweepOrphanPayloads(keptHashes: Set<string>): void {
    let names: string[] = []
    try {
      names = readdirSync(this.payloadDir)
    } catch {
      return
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        try {
          unlinkSync(join(this.payloadDir, name))
        } catch {
          /* best-effort */
        }
        continue
      }
      if (!name.endsWith('.json')) continue
      const hash = name.slice(0, -5).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(hash)) continue
      if (!keptHashes.has(hash)) this.unlinkPayloadFile(hash)
    }
  }

  /**
   * TCC-R1153-BKP-002 public-share twin: keep every still-active row, then
   * the newest revoked/expired tombstones in the leftover room. A silent
   * slice(0, 500) dropped the oldest live guest link after a lifetime of
   * publish+revoke. Dropped rows unlink their payload and leftover intake
   * so public-share-payloads/ cannot grow past the registry.
   */
  private saveRegistry(shares: PublicShareRow[]): void {
    const now = Date.now()
    const live: PublicShareRow[] = []
    const dead: PublicShareRow[] = []
    for (const s of shares) {
      if (isShareActive(s, now)) live.push(s)
      else dead.push(s)
    }
    for (const row of dead) {
      if (row.payloadReady) row.payloadReady = false
      this.unlinkPayloadFile(row.tokenHash)
      // Expire twin of revoke: leftover intake must not pin queue_full
      // while the tombstone still occupies leftover registry room.
      this.scrubSubmissionsForLocalShareId(row.localShareId)
    }
    dead.sort((a, b) => shareDeadAt(b) - shareDeadAt(a))
    const room = Math.max(0, MAX_SHARES - live.length)
    const keptDead = dead.slice(0, room)
    const dropped = [
      ...live.slice(MAX_SHARES),
      ...dead.slice(room),
    ]
    const capped = [...live.slice(0, MAX_SHARES), ...keptDead].slice(0, MAX_SHARES)
    atomicWriteJson(this.registryPath, { shares: capped }, this.atRest)
    const keptHashes = new Set(capped.map((s) => s.tokenHash))
    for (const row of dropped) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalShareId(row.localShareId)
    }
    this.sweepOrphanPayloads(keptHashes)
  }

  findByTokenHash(tokenHash: string): PublicShareRow | null {
    const h = tokenHash.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(h)) return null
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return null
    return loaded.shares.find((s) => s.tokenHash === h) ?? null
  }

  findByLocalShareId(localShareId: string): PublicShareRow | null {
    const id = capGuestStoreScopeId(localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    if (!id) return null
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return null
    return loaded.shares.find((s) => s.localShareId === id) ?? null
  }

  upsertShare(
    ownerMemberId: string,
    args: {
      tokenHash: string
      localShareId: string
      mode: PublicShareMode
      viewType: string
      label: string
      passwordHash: string | null
      includeCsv: boolean
      expiresAt: number | null
      payload?: unknown
      teamId?: unknown
      team_id?: unknown
    },
  ): { ok: true; row: PublicShareRow } | { ok: false; error: string } {
    const tokenHash = args.tokenHash.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'Invalid token hash' }
    }
    const localShareId = capGuestStoreScopeId(args.localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    if (!localShareId) return { ok: false, error: 'local_share_id required' }
    if (args.mode !== 'read' && args.mode !== 'create') {
      return { ok: false, error: 'Invalid mode' }
    }
    if (args.passwordHash != null && !isPublicSharePasswordHash(args.passwordHash)) {
      return { ok: false, error: 'Invalid password hash' }
    }
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''

    const now = Date.now()
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    let shares = loaded.shares
    const found = findGuestRegistryIndex(shares, {
      tokenHash,
      localId: localShareId,
      localOf: (s) => s.localShareId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    const idx = found.idx
    const prev = idx >= 0 ? shares[idx] : null
    const stampedTeam = resolveGuestStoreStamp(prev?.teamId, callerTeam)
    const addingLive = !prev || !isShareActive(prev, now)
    if (addingLive) {
      const liveCount = shares.filter((s) => isShareActive(s, now)).length
      if (liveCount >= MAX_SHARES) {
        return { ok: false, error: 'Too many public links on this server' }
      }
    }
    let payloadReady = prev?.payloadReady === true
    if (args.payload !== undefined) {
      const wrote = this.writePayloadFile(tokenHash, args.payload)
      if (!wrote.ok) return wrote
      payloadReady = true
    }

    const row: PublicShareRow = {
      tokenHash,
      localShareId,
      mode: args.mode,
      viewType: (typeof args.viewType === 'string' && args.viewType.trim()
        ? args.viewType
        : 'table'
      ).slice(0, 64),
      label: capStr(typeof args.label === 'string' && args.label.trim() ? args.label : 'Shared', 200),
      passwordHash: args.passwordHash,
      includeCsv: args.includeCsv === true,
      expiresAt:
        typeof args.expiresAt === 'number' && Number.isFinite(args.expiresAt)
          ? Math.floor(args.expiresAt)
          : null,
      revokedAt: null,
      payloadReady,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      ownerMemberId: capGuestStoreScopeId(ownerMemberId, GUEST_STORE_SCOPE_ID_MAX),
      ...(stampedTeam ? { teamId: stampedTeam } : {}),
    }
    if (idx >= 0) shares[idx] = row
    else shares = [row, ...shares]
    this.saveRegistry(shares)
    return { ok: true, row }
  }

  revokeShare(args: {
    localShareId?: string
    tokenHash?: string
    teamId?: unknown
    team_id?: unknown
  }): { ok: true } | { ok: false; error: string } {
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const shares = loaded.shares
    const localId = capGuestStoreScopeId(args.localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    const hash =
      typeof args.tokenHash === 'string' ? args.tokenHash.toLowerCase().trim() : ''
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const found = findGuestRegistryIndex(shares, {
      tokenHash: hash,
      localId,
      localOf: (s) => s.localShareId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    const idx = found.idx
    if (idx < 0) return { ok: false, error: 'Share not found' }
    const now = Date.now()
    shares[idx] = { ...shares[idx], revokedAt: now, updatedAt: now, payloadReady: false }
    const revoked = shares[idx]
    this.saveRegistry(shares)
    this.unlinkPayloadFile(revoked.tokenHash)
    this.scrubSubmissionsForLocalShareId(revoked.localShareId)
    return { ok: true }
  }

  setPayload(
    args: {
      localShareId?: string
      tokenHash?: string
      payload: unknown
      teamId?: unknown
      team_id?: unknown
    },
  ): { ok: true } | { ok: false; error: string } {
    const tokenHash =
      typeof args.tokenHash === 'string' ? args.tokenHash.toLowerCase().trim() : ''
    const localId = capGuestStoreScopeId(args.localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    const callerTeam = resolveGuestStoreStamp(undefined, args.teamId ?? args.team_id) ?? ''
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const shares = loaded.shares
    const found = findGuestRegistryIndex(shares, {
      tokenHash,
      localId,
      localOf: (s) => s.localShareId,
      callerTeam,
    })
    if (found.idx < 0 && found.otherTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    const row = found.idx >= 0 ? shares[found.idx] : null
    if (!row) return { ok: false, error: 'Share not found' }
    if (!isShareActive(row)) return { ok: false, error: 'Share is not active' }
    const wrote = this.writePayloadFile(row.tokenHash, args.payload)
    if (!wrote.ok) return wrote
    const idx = found.idx
    if (idx >= 0) {
      shares[idx] = {
        ...shares[idx],
        payloadReady: true,
        updatedAt: Date.now(),
      }
      this.saveRegistry(shares)
    }
    return { ok: true }
  }

  private writePayloadFile(
    tokenHash: string,
    payload: unknown,
  ): { ok: true } | { ok: false; error: string } {
    if (!isPayload(payload)) return { ok: false, error: 'Invalid payload' }
    let encoded: string
    try {
      encoded = JSON.stringify(payload)
    } catch {
      return { ok: false, error: 'Could not encode payload' }
    }
    if (encoded.length > PAYLOAD_JSON_MAX) {
      return { ok: false, error: 'Payload too large' }
    }
    const path = join(this.payloadDir, `${tokenHash}.json`)
    atomicWriteJson(path, payload, this.atRest)
    return { ok: true }
  }

  readPayload(tokenHash: string): PublicSharePayload | null {
    const path = join(this.payloadDir, `${tokenHash.toLowerCase()}.json`)
    const data = readJson<unknown>(path, null, this.atRest)
    return isPayload(data) ? data : null
  }

  resolveGuest(tokenPlain: string): {
    row: PublicShareRow | null
    active: boolean
    reason: 'not_found' | 'revoked' | 'expired' | 'ok' | 'unreadable'
  } {
    const hash = hashPublicShareToken(tokenPlain)
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { row: null, active: false, reason: 'unreadable' }
    const row = loaded.shares.find((s) => s.tokenHash === hash) ?? null
    if (!row) return { row: null, active: false, reason: 'not_found' }
    if (typeof row.revokedAt === 'number' && row.revokedAt > 0) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalShareId(row.localShareId)
      return { row, active: false, reason: 'revoked' }
    }
    if (
      typeof row.expiresAt === 'number' &&
      row.expiresAt > 0 &&
      Date.now() >= row.expiresAt
    ) {
      this.unlinkPayloadFile(row.tokenHash)
      this.scrubSubmissionsForLocalShareId(row.localShareId)
      return { row, active: false, reason: 'expired' }
    }
    return { row, active: true, reason: 'ok' }
  }

  enqueueSubmission(args: {
    row: PublicShareRow
    payload: PublicSharePayload
    rawData: unknown
    clientIp?: string
  }):
    | { ok: true; id: string }
    | { ok: false; error: string; error_code: string; status: number; fieldErrors?: string[] } {
    if (!isShareActive(args.row)) {
      const revoked = isShareRevoked(args.row)
      return {
        ok: false,
        error: revoked ? 'This link is no longer available' : 'This link has expired',
        error_code: revoked ? 'share.revoked' : 'share.expired',
        status: 410,
      }
    }
    if (args.row.mode !== 'create') {
      return {
        ok: false,
        error: 'This link is view-only',
        error_code: 'share.read_only',
        status: 403,
      }
    }
    if (!args.row.payloadReady) {
      return {
        ok: false,
        error: 'Shared form is not ready yet',
        error_code: 'share.payload_not_ready',
        status: 503,
      }
    }
    // TCC-R1147-BRG-003: portal twin - gate create intake per client IP.
    if (!this.takeAnonRate(args.clientIp || 'unknown')) {
      return {
        ok: false,
        error: 'Too many submissions from this network. Try again later.',
        error_code: 'share.rate_limited',
        status: 429,
      }
    }
    // TCC-R1132-BRG-001: listPendingSubmissions() hard-caps its return length
    // at 100 (Admin page size) regardless of the limit argument, so probing
    // it against MAX_PENDING_SUBMISSIONS (2000) here never actually reached
    // the real ceiling and queue_full could never fire. Count uncapped by
    // the page-size ceiling instead; keep listPendingSubmissions() itself
    // capped at 100 for the Admin list UI.
    const pendingCount = this.countPendingSubmissions(MAX_PENDING_SUBMISSIONS, args.row.teamId)
    if (pendingCount >= MAX_PENDING_SUBMISSIONS) {
      return {
        ok: false,
        error: 'Too many pending submissions. Try again later.',
        error_code: 'share.queue_full',
        status: 503,
      }
    }

    const allowed = new Set(
      args.payload.fields
        .filter((f) => typeof f.slug === 'string' && f.slug)
        .map((f) => f.slug),
    )
    const required = new Set(
      args.payload.fields.filter((f) => f.required).map((f) => f.slug),
    )
    const raw =
      args.rawData && typeof args.rawData === 'object' && !Array.isArray(args.rawData)
        ? (args.rawData as Record<string, unknown>)
        : {}
    const data: Record<string, unknown> = {}
    const fieldErrors: string[] = []
    for (const [k, v] of Object.entries(raw)) {
      if (!k || k.startsWith('_') || k === '__proto__' || k === 'constructor' || k === 'prototype') {
        continue
      }
      if (!allowed.has(k)) continue
      const accepted = acceptGuestFieldValue(v)
      if (accepted !== undefined) data[k] = accepted
    }
    for (const slug of required) {
      const v = data[slug]
      if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
        fieldErrors.push(slug)
      }
    }
    if (fieldErrors.length > 0) {
      return {
        ok: false,
        error: 'Fill in the required fields',
        error_code: 'share.validation',
        status: 400,
        fieldErrors,
      }
    }

    const id = randomBytes(16).toString('hex')
    const now = Date.now()
    const sub: PublicShareSubmission = {
      id,
      localShareId: args.row.localShareId,
      entityId: args.payload.entityId,
      data,
      status: 'pending',
      error: null,
      createdAt: now,
      updatedAt: now,
    }
    atomicWriteJson(join(this.submissionsDir, `${id}.json`), sub, this.atRest)
    return { ok: true, id }
  }

  /**
   * List pending public-form intake. When `ownerMemberId` is set, only
   * submissions for shares owned by that member are returned
   * (TCC-R1151-BKP-001 public-share twin). Optional `teamId`: named = that
   * team only; omit/blank = leftover '' only (TCC-FIX-SHARE-013 drain twin).
   */
  listPendingSubmissions(
    limit = 50,
    ownerMemberId?: string,
    teamId?: unknown,
  ): PublicShareSubmission[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    const now = Date.now()
    const owner = capGuestStoreScopeId(ownerMemberId, GUEST_STORE_SCOPE_ID_MAX)
    const callerTeam = capGuestStoreTeamId(teamId)
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return []
    const registry = loaded.shares
    const byLocal = new Map(registry.map((s) => [s.localShareId, s] as const))
    const scopedLocalIds = new Set(
      registry
        .filter((s) => {
          if (!isShareActive(s, now)) return false
          if (owner && s.ownerMemberId !== owner) return false
          return guestStoreTeamMatchesScope(s.teamId, callerTeam)
        })
        .map((s) => s.localShareId),
    )
    const all: Array<{ path: string; row: PublicShareSubmission }> = []
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    for (const name of names) {
      const path = join(this.submissionsDir, name)
      const sub = readJson<PublicShareSubmission | null>(path, null, this.atRest)
      if (!sub || sub.status !== 'pending') continue
      if (typeof sub.id !== 'string' || !sub.localShareId || !sub.entityId) continue
      if (!sub.data || typeof sub.data !== 'object') continue
      const parent = byLocal.get(sub.localShareId)
      if (parent && !isShareActive(parent, now)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      if (parent) {
        if (!scopedLocalIds.has(sub.localShareId)) continue
      } else if (owner || callerTeam) {
        continue
      }
      const claimedAt =
        typeof sub.claimedAt === 'number' && Number.isFinite(sub.claimedAt) ? sub.claimedAt : 0
      if (claimedAt > 0 && now - claimedAt < SUBMISSION_CLAIM_LEASE_MS) continue
      all.push({ path, row: sub })
    }
    // Portal twin TCC-R1150-BKP-002: sort ALL matching oldest-first, then page.
    // Hex filename order is not createdAt and hid older intake at the page cap.
    all.sort((a, b) => {
      const ac = typeof a.row.createdAt === 'number' && Number.isFinite(a.row.createdAt) ? a.row.createdAt : 0
      const bc = typeof b.row.createdAt === 'number' && Number.isFinite(b.row.createdAt) ? b.row.createdAt : 0
      return ac - bc
    })
    const out: PublicShareSubmission[] = []
    for (const item of all.slice(0, cap)) {
      // TCC-R1150-BKP-001: stamp lease before return so a peer drain skips.
      const claimed: PublicShareSubmission = { ...item.row, claimedAt: now, updatedAt: now }
      try {
        atomicWriteJson(item.path, claimed, this.atRest)
      } catch {
        continue
      }
      out.push(claimed)
    }
    return out
  }

  /**
   * TCC-R1132-BRG-001: uncapped-by-Admin-page-size count for the real
   * `queue_full` ceiling probe (`enqueueSubmission`). Stops scanning once it
   * has confirmed `ceiling + 1` valid pending rows so a runaway directory
   * cannot turn one enqueue call into an unbounded disk scan. Optional
   * `teamId` uses the same named / leftover polarity as list/ack
   * (TCC-FIX-SHARE-013) so T2 leftover cannot trip T1 `queue_full`.
   */
  private countPendingSubmissions(ceiling: number, teamId?: unknown): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    const callerTeam = capGuestStoreTeamId(teamId)
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return stopAt
    const byLocal = new Map(loaded.shares.map((s) => [s.localShareId, s] as const))
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const path = join(this.submissionsDir, name)
      const sub = readJson<PublicShareSubmission | null>(path, null, this.atRest)
      if (!sub || sub.status !== 'pending') continue
      if (typeof sub.id !== 'string' || !sub.localShareId || !sub.entityId) continue
      if (!sub.data || typeof sub.data !== 'object') continue
      const parent = byLocal.get(sub.localShareId)
      // Only unlink when the parent exists and is dead. A missing parent is
      // still a real pending file (queue_full seeds, in-memory enqueue).
      if (parent && !isShareActive(parent)) {
        try {
          unlinkSync(path)
        } catch {
          /* leftover after revoke or expiry */
        }
        continue
      }
      if (parent) {
        if (!guestStoreTeamMatchesScope(parent.teamId, callerTeam)) continue
      } else if (callerTeam) {
        continue
      }
      count += 1
    }
    return count
  }

  /**
   * TCC-R1133-PRT-003: acked submissions are UNLINKED, not rewritten with a
   * terminal status - same class/fix as the portal-store.ts twin. Nothing
   * on the bridge ever reads a non-pending submission back
   * (`listPendingSubmissions`/`countPendingSubmissions` both filter to
   * `status === 'pending'` only, and there is no "past submissions"
   * endpoint in `server.ts`), and the desktop main process has already
   * durably recorded the applied/rejected outcome locally before calling
   * this. Leaving the acked row on disk only grew
   * `public-share-submissions/` forever, forcing every future
   * `enqueueSubmission`'s `countPendingSubmissions` to `readdirSync` +
   * decrypt every historical row (pending or not) to find the still-live
   * ones.
   */
  ackSubmission(
    submissionId: string,
    _status: 'applied' | 'rejected',
    _error: string | null,
    teamId?: unknown,
  ): { ok: true } | { ok: false; error: string } {
    const id = submissionId.trim().replace(/[^a-f0-9]/gi, '').slice(0, 64)
    if (!id) return { ok: false, error: 'Invalid submission id' }
    const path = join(this.submissionsDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Submission not found' }
    const callerTeam = capGuestStoreTeamId(teamId)
    const loaded = this.loadRegistryResult()
    if (!loaded.ok) return { ok: false, error: loaded.reason }
    const sub = readJson<PublicShareSubmission | null>(path, null, this.atRest)
    const localId = capGuestStoreScopeId(sub?.localShareId, GUEST_STORE_LOCAL_SHARE_ID_MAX)
    const parent = localId
      ? loaded.shares.find((s) => s.localShareId === localId)
      : undefined
    if (parent) {
      if (!guestStoreTeamMatchesScope(parent.teamId, callerTeam)) {
        return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
      }
    } else if (callerTeam) {
      return { ok: false, error: GUEST_STORE_SHARE_TEAM_MISMATCH }
    }
    try {
      unlinkSync(path)
    } catch {
      // TS-SEC2-008: catch that answers the page never returns err.message
      // (unlink can name the path). Handler-owned sentence only.
      return { ok: false, error: 'Could not remove submission' }
    }
    return { ok: true }
  }
}

export function toPublicShareMeta(row: PublicShareRow): Record<string, unknown> {
  const teamId = capGuestStoreTeamId(row.teamId)
  return {
    mode: row.mode,
    viewType: row.viewType,
    label: row.label,
    hasPassword: Boolean(row.passwordHash),
    includeCsv: row.includeCsv === true,
    payloadReady: row.payloadReady === true,
    ...(teamId ? { team_id: teamId } : {}),
    expiresAt:
      typeof row.expiresAt === 'number' && row.expiresAt > 0
        ? new Date(row.expiresAt).toISOString()
        : null,
  }
}
