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

const REGISTRY_FILE = 'public-shares.json'
const PAYLOAD_DIR = 'public-share-payloads'
const SUBMISSIONS_DIR = 'public-share-submissions'
const PAYLOAD_JSON_MAX = 1_500_000
const MAX_SHARES = 500
const MAX_PENDING_SUBMISSIONS = 2_000
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
}

type RegistryFile = { shares: PublicShareRow[] }

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

function isShareActive(row: PublicShareRow): boolean {
  if (typeof row.revokedAt === 'number' && row.revokedAt > 0) return false
  if (typeof row.expiresAt === 'number' && row.expiresAt > 0 && Date.now() >= row.expiresAt) {
    return false
  }
  return true
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
    if (b.count >= ANON_RATE_PER_WINDOW) return false
    b.count += 1
    if (this.anonBuckets.size > 50_000) {
      for (const [key, row] of this.anonBuckets) {
        if (now >= row.refillAt) this.anonBuckets.delete(key)
      }
    }
    return true
  }

  private loadRegistry(): PublicShareRow[] {
    const file = readJson<RegistryFile>(this.registryPath, { shares: [] }, this.atRest)
    return Array.isArray(file.shares) ? file.shares : []
  }

  private saveRegistry(shares: PublicShareRow[]): void {
    const capped = shares.slice(0, MAX_SHARES)
    atomicWriteJson(this.registryPath, { shares: capped }, this.atRest)
  }

  findByTokenHash(tokenHash: string): PublicShareRow | null {
    const h = tokenHash.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(h)) return null
    return this.loadRegistry().find((s) => s.tokenHash === h) ?? null
  }

  findByLocalShareId(localShareId: string): PublicShareRow | null {
    const id = localShareId.trim().slice(0, 64)
    if (!id) return null
    return this.loadRegistry().find((s) => s.localShareId === id) ?? null
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
    },
  ): { ok: true; row: PublicShareRow } | { ok: false; error: string } {
    const tokenHash = args.tokenHash.toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) {
      return { ok: false, error: 'Invalid token hash' }
    }
    const localShareId = args.localShareId.trim().slice(0, 64)
    if (!localShareId) return { ok: false, error: 'local_share_id required' }
    if (args.mode !== 'read' && args.mode !== 'create') {
      return { ok: false, error: 'Invalid mode' }
    }
    if (args.passwordHash != null && !isPublicSharePasswordHash(args.passwordHash)) {
      return { ok: false, error: 'Invalid password hash' }
    }

    const now = Date.now()
    let shares = this.loadRegistry()
    const idx = shares.findIndex(
      (s) => s.tokenHash === tokenHash || s.localShareId === localShareId,
    )
    const prev = idx >= 0 ? shares[idx] : null
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
      viewType: String(args.viewType || 'table').slice(0, 64),
      label: String(args.label || 'Shared').slice(0, 200),
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
      ownerMemberId: ownerMemberId.slice(0, 128),
    }
    if (idx >= 0) shares[idx] = row
    else shares = [row, ...shares]
    this.saveRegistry(shares)
    return { ok: true, row }
  }

  revokeShare(args: {
    localShareId?: string
    tokenHash?: string
  }): { ok: true } | { ok: false; error: string } {
    const shares = this.loadRegistry()
    const localId = typeof args.localShareId === 'string' ? args.localShareId.trim() : ''
    const hash =
      typeof args.tokenHash === 'string' ? args.tokenHash.toLowerCase().trim() : ''
    const idx = shares.findIndex(
      (s) =>
        (localId && s.localShareId === localId) ||
        (hash && s.tokenHash === hash),
    )
    if (idx < 0) return { ok: false, error: 'Share not found' }
    const now = Date.now()
    shares[idx] = { ...shares[idx], revokedAt: now, updatedAt: now, payloadReady: false }
    this.saveRegistry(shares)
    try {
      const p = join(this.payloadDir, `${shares[idx].tokenHash}.json`)
      if (existsSync(p)) unlinkSync(p)
    } catch {
      /* best-effort */
    }
    return { ok: true }
  }

  setPayload(
    args: { localShareId?: string; tokenHash?: string; payload: unknown },
  ): { ok: true } | { ok: false; error: string } {
    const row =
      (args.tokenHash && this.findByTokenHash(args.tokenHash)) ||
      (args.localShareId && this.findByLocalShareId(args.localShareId)) ||
      null
    if (!row) return { ok: false, error: 'Share not found' }
    if (!isShareActive(row)) return { ok: false, error: 'Share is not active' }
    const wrote = this.writePayloadFile(row.tokenHash, args.payload)
    if (!wrote.ok) return wrote
    const shares = this.loadRegistry()
    const idx = shares.findIndex((s) => s.tokenHash === row.tokenHash)
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
    reason: 'not_found' | 'revoked' | 'expired' | 'ok'
  } {
    const hash = hashPublicShareToken(tokenPlain)
    const row = this.findByTokenHash(hash)
    if (!row) return { row: null, active: false, reason: 'not_found' }
    if (typeof row.revokedAt === 'number' && row.revokedAt > 0) {
      return { row, active: false, reason: 'revoked' }
    }
    if (
      typeof row.expiresAt === 'number' &&
      row.expiresAt > 0 &&
      Date.now() >= row.expiresAt
    ) {
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
    const pendingCount = this.countPendingSubmissions(MAX_PENDING_SUBMISSIONS)
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
      if (typeof v === 'string') data[k] = v.slice(0, 10_000)
      else if (typeof v === 'number' || typeof v === 'boolean') data[k] = v
      else if (v === null) data[k] = null
      else data[k] = String(v).slice(0, 10_000)
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
   * (TCC-R1151-BKP-001 public-share twin).
   */
  listPendingSubmissions(limit = 50, ownerMemberId?: string): PublicShareSubmission[] {
    const cap = Math.max(1, Math.min(100, Math.floor(limit)))
    const owner =
      typeof ownerMemberId === 'string' && ownerMemberId.trim()
        ? ownerMemberId.trim().slice(0, 128)
        : ''
    const ownedLocalIds = owner
      ? new Set(
          this.loadRegistry()
            .filter((s) => s.ownerMemberId === owner && !s.revokedAt)
            .map((s) => s.localShareId),
        )
      : null
    const out: PublicShareSubmission[] = []
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    names.sort()
    for (const name of names) {
      if (out.length >= cap) break
      const sub = readJson<PublicShareSubmission | null>(
        join(this.submissionsDir, name),
        null,
        this.atRest,
      )
      if (!sub || sub.status !== 'pending') continue
      if (typeof sub.id !== 'string' || !sub.localShareId || !sub.entityId) continue
      if (!sub.data || typeof sub.data !== 'object') continue
      if (ownedLocalIds && !ownedLocalIds.has(sub.localShareId)) continue
      out.push(sub)
    }
    return out
  }

  /**
   * TCC-R1132-BRG-001: uncapped-by-Admin-page-size count for the real
   * `queue_full` ceiling probe (`enqueueSubmission`). Stops scanning once it
   * has confirmed `ceiling + 1` valid pending rows so a runaway directory
   * cannot turn one enqueue call into an unbounded disk scan.
   */
  private countPendingSubmissions(ceiling: number): number {
    const stopAt = Math.max(1, Math.floor(ceiling)) + 1
    let names: string[] = []
    try {
      names = readdirSync(this.submissionsDir).filter((n) => n.endsWith('.json'))
    } catch {
      return 0
    }
    let count = 0
    for (const name of names) {
      if (count >= stopAt) break
      const sub = readJson<PublicShareSubmission | null>(
        join(this.submissionsDir, name),
        null,
        this.atRest,
      )
      if (!sub || sub.status !== 'pending') continue
      if (typeof sub.id !== 'string' || !sub.localShareId || !sub.entityId) continue
      if (!sub.data || typeof sub.data !== 'object') continue
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
  ): { ok: true } | { ok: false; error: string } {
    const id = submissionId.trim().replace(/[^a-f0-9]/gi, '').slice(0, 64)
    if (!id) return { ok: false, error: 'Invalid submission id' }
    const path = join(this.submissionsDir, `${id}.json`)
    if (!existsSync(path)) return { ok: false, error: 'Submission not found' }
    try {
      unlinkSync(path)
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'Could not remove submission',
      }
    }
    return { ok: true }
  }
}

export function toPublicShareMeta(row: PublicShareRow): Record<string, unknown> {
  return {
    mode: row.mode,
    viewType: row.viewType,
    label: row.label,
    hasPassword: Boolean(row.passwordHash),
    includeCsv: row.includeCsv === true,
    payloadReady: row.payloadReady === true,
    expiresAt:
      typeof row.expiresAt === 'number' && row.expiresAt > 0
        ? new Date(row.expiresAt).toISOString()
        : null,
  }
}
