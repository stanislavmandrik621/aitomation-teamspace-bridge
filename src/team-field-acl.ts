/** Bridge-owned compare-and-swap for whole-team field grants. The ops WAL is
 * written first; this fsynced checkpoint survives retention. A damaged or
 * missing initialized checkpoint freezes content instead of restoring defaults.
 */
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'
import type { BridgeRole, ModulesSyncOp, TeamFieldAclAuthority } from './index.js'
import { newerReferenceClock, referenceClock } from './content-reference-data.js'

const KEY = 'teamSpaceAclGrantBag'
const MAX_BYTES = 8 * 1024 * 1024
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const own = (v: object, k: string): boolean => Object.prototype.hasOwnProperty.call(v, k)
function fileState(path: string): 'file' | 'missing' | 'invalid' {
  try { const info = lstatSync(path); return info.isFile() && !info.isSymbolicLink() ? 'file' : 'invalid' }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid' }
}

/** Same algorithm on desktop: sorted object keys, original array order. */
export function canonicalFieldAclJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFieldAclJson).join(',')}]`
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalFieldAclJson(value[key])}`).join(',')}}`
  throw new Error('Invalid field access grants')
}
export function hashTeamFieldAclBag(bag: unknown): string {
  return createHash('sha256').update(canonicalFieldAclJson(bag)).digest('hex')
}

/** Mirrors the desktop's normalized bag, but rejects lossy identity aliases. */
export function normalizeBridgeFieldAclBag(raw: unknown): unknown | null {
  if (raw === null) return null
  if (!object(raw) || !Array.isArray(raw.entities) || !Array.isArray(raw.fields)
    || raw.entities.length > 5000 || raw.fields.length > 20000) throw new Error('Invalid field access grants')
  const id = (v: unknown, max: number): string => {
    if (typeof v !== 'string' || !v || v.trim() !== v || v.length > max || v.includes('\0') || !v.isWellFormed()) throw new Error('Invalid field access identity')
    return v
  }
  const role = (v: unknown): string => {
    if (typeof v !== 'string' || !['admin', 'member', 'viewer'].includes(v)) throw new Error('Invalid field access role')
    return v
  }
  const entities = raw.entities.map(row => {
    if (!object(row)) throw new Error('Invalid entity grant')
    return { entityId: id(row.entityId, 128), role: role(row.role), read: row.read === true,
      create: row.create === true, update: row.update === true, delete: row.delete === true }
  })
  const fields = raw.fields.map(row => {
    if (!object(row)) throw new Error('Invalid field grant')
    const hidden = row.hidden === true
    return { entityId: id(row.entityId, 128), fieldSlug: id(row.fieldSlug, 200), role: role(row.role),
      read: !hidden && row.read === true, write: !hidden && row.write === true, hidden }
  })
  return { version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? Math.floor(raw.version) : 0, entities, fields }
}

export function fieldAclProposal(op: ModulesSyncOp): { bag: unknown | null; hash: string } | null {
  if (op.kind !== 'module.create' && op.kind !== 'module.update') return null
  const config = op.patch?.config
  if (!object(config) || !own(config, KEY)) return null
  const bag = normalizeBridgeFieldAclBag(config[KEY])
  return { bag, hash: hashTeamFieldAclBag(bag) }
}

export class TeamFieldAclStore {
  private state: TeamFieldAclAuthority = { revision: 0, hash: hashTeamFieldAclBag(null), bag: null }
  private legacyHlc = ''
  private unavailable = false
  private dirty = false
  /** Server frames append immutable stamped rows. Reuse the verified prefix
   * so large multi-module ACL fanouts do not repeatedly hash every prior bag. */
  private readonly previews = new WeakMap<ModulesSyncOp[], { base: TeamFieldAclAuthority; length: number; last?: ModulesSyncOp; state: TeamFieldAclAuthority }>()
  private readonly path: string
  private readonly marker: string
  private readonly migrating: boolean
  constructor(private readonly root: string, private readonly atRest: AtRestKey | null) {
    this.path = join(root, 'team-field-acl.json')
    this.marker = join(root, 'team-field-acl.initialized')
    const checkpoint = fileState(this.path), marker = fileState(this.marker)
    this.migrating = checkpoint === 'missing' && marker === 'missing'
    try {
      if (checkpoint === 'invalid' || marker === 'invalid') throw new Error('Unsafe field access checkpoint path')
      if (this.migrating) { this.dirty = true; return }
      if (statSync(this.path).size > MAX_BYTES) throw new Error('Field grants too large')
      const doc = decryptJsonFile<Record<string, unknown> | null>(atRest, readFileSync(this.path, 'utf8'), null)
      if (!doc || doc.version !== 1 || !Number.isSafeInteger(doc.revision) || (doc.revision as number) < 0) throw new Error('Invalid grant checkpoint')
      const bag = normalizeBridgeFieldAclBag(doc.bag), hash = hashTeamFieldAclBag(bag)
      if (hash !== doc.hash) throw new Error('Invalid grant checkpoint hash')
      this.state = { revision: doc.revision as number, hash, bag }
      this.legacyHlc = typeof doc.legacyHlc === 'string' ? doc.legacyHlc : ''
    } catch { this.unavailable = true }
  }
  healthy(): boolean { return !this.unavailable }
  failClosed(): void { this.unavailable = true }
  currentHash(): string | undefined { return this.healthy() ? this.state.hash : undefined }
  previewHash(pending: ModulesSyncOp[]): string | undefined {
    return this.healthy() ? this.previewState(pending).hash : undefined
  }
  previewSnapshot(pending: ModulesSyncOp[]): TeamFieldAclAuthority | undefined {
    return this.healthy() ? structuredClone(this.previewState(pending)) : undefined
  }
  isCurrentHash(hash: unknown): boolean {
    return this.healthy() && ((hash === undefined && this.state.revision === 0)
      || (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) && hash === this.state.hash))
  }
  snapshot(): TeamFieldAclAuthority | undefined {
    return this.healthy() ? structuredClone(this.state) : undefined
  }
  /** Historical module snapshots must not temporarily restore old grants on
   * a fresh member desktop before its catch-up reaches the newest ACL row. */
  currentForRead(op: ModulesSyncOp): ModulesSyncOp {
    if (!this.healthy()) throw new Error('Field access authority unavailable')
    if (op.originRole !== 'admin' || !fieldAclProposal(op)) return op
    if (op.fieldAclRevision === this.state.revision && fieldAclProposal(op)?.hash === this.state.hash) return op
    return { ...op, fieldAclRevision: this.state.revision, patch: { ...op.patch,
      config: { ...(op.patch!.config as Record<string, unknown>), [KEY]: structuredClone(this.state.bag) } } }
  }
  private next(op: ModulesSyncOp, role: BridgeRole, state: TeamFieldAclAuthority): TeamFieldAclAuthority {
    const proposal = fieldAclProposal(op)
    if (own(op, 'fieldAclBaseHash') && (typeof op.fieldAclBaseHash !== 'string' || !/^[a-f0-9]{64}$/.test(op.fieldAclBaseHash))) throw new Error('Invalid field access baseline')
    if (!proposal) {
      // Edits authored before a privacy change must not carry stale plaintext
      // to storage/fanout merely because this device has not seen the winner.
      if ((state.revision > 0 || op.fieldAclBaseHash !== undefined) && /^(module|entity|field|view|record|comment|cascade)\./.test(op.kind)
        && op.fieldAclBaseHash !== state.hash) throw new Error('Field access changed before this edit; review and reapply the queued change')
      return state
    }
    if (proposal.hash === state.hash) return state // fanout siblings and unchanged ordinary snapshots
    if (role !== 'admin') throw new Error('Only an Admin can change field access grants')
    if (op.fieldAclBaseHash !== state.hash && !(state.revision === 0 && op.fieldAclBaseHash === undefined)) {
      throw new Error('Field access changed on another device; reload access settings before retrying')
    }
    if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Field access revision exhausted')
    return { revision: state.revision + 1, ...proposal }
  }
  private previewState(pending: ModulesSyncOp[]): TeamFieldAclAuthority {
    const cached = this.previews.get(pending)
    const reusable = cached && cached.base === this.state && cached.length <= pending.length
      && (cached.length === 0 || pending[cached.length - 1] === cached.last)
    let state = reusable ? cached.state : this.state
    for (let i = reusable ? cached.length : 0; i < pending.length; i++) {
      const previous = pending[i]!
      state = this.next(previous, previous.originRole ?? 'member', state)
    }
    this.previews.set(pending, { base: this.state, length: pending.length, last: pending.at(-1), state })
    return state
  }
  /** Preview only; no grant becomes effective before its WAL row is written. */
  stamp(op: ModulesSyncOp, role: BridgeRole, pending: ModulesSyncOp[] = []): ModulesSyncOp {
    if (!this.healthy()) throw new Error('Field access authority unavailable')
    const state = this.previewState(pending)
    const next = this.next(op, role, state)
    const { fieldAclRevision: _claimed, ...rest } = op
    return role === 'admin' && fieldAclProposal(op) ? { ...rest, fieldAclRevision: next.revision } : rest
  }
  /** Validate the exact rows that survived idempotency/sealing before append. */
  validateCommit(ops: ModulesSyncOp[]): void {
    if (!this.healthy()) throw new Error('Field access authority unavailable')
    let state = this.state
    for (const op of ops) {
      if (op.fieldAclRevision === undefined && op.fieldAclBaseHash === undefined) continue // trusted legacy/internal fixture writes
      state = this.next(op, op.originRole ?? 'member', state)
      if (op.fieldAclRevision !== undefined && op.fieldAclRevision !== state.revision) throw new Error('Field access batch changed before commit')
    }
  }
  /** Called only for committed WAL rows, or replay during startup. */
  observe(op: ModulesSyncOp): void {
    if (!this.healthy()) return
    try {
      const proposal = fieldAclProposal(op)
      if (!proposal) return
      if (op.fieldAclRevision === undefined) {
        if (!this.migrating || op.originRole !== 'admin') return
        const clock = referenceClock(op.hlc), prior = referenceClock(this.legacyHlc)
        if (!clock || (prior && !newerReferenceClock(clock, prior))) return
        this.legacyHlc = op.hlc
        this.state = { revision: this.state.revision + 1, ...proposal }
      } else {
        const revision = op.fieldAclRevision
        if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid grant revision')
        if (revision < this.state.revision) return
        if (revision === this.state.revision) {
          if (proposal.hash !== this.state.hash) throw new Error('Conflicting grant revision')
          return
        }
        const next = this.next(op, op.originRole ?? 'member', this.state)
        if (next.revision !== revision) throw new Error('Missing grant predecessor')
        this.state = next
      }
      this.dirty = true
    } catch { this.unavailable = true }
  }
  private atomicWrite(path: string, text: string): void {
    const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let fd = -1, dir = -1
    try {
      fd = openSync(tmp, 'wx', 0o600)
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd); closeSync(fd); fd = -1
      renameSync(tmp, path)
      dir = openSync(this.root, 'r'); fsyncSync(dir)
    } finally {
      if (fd >= 0) try { closeSync(fd) } catch { /* */ }
      if (dir >= 0) try { closeSync(dir) } catch { /* */ }
      try { unlinkSync(tmp) } catch { /* */ }
    }
  }
  flush(): void {
    if (!this.healthy()) throw new Error('Field access authority unavailable')
    try {
      if (this.dirty) {
        const plain = JSON.stringify({ version: 1, ...this.state, legacyHlc: this.legacyHlc })
        if (Buffer.byteLength(plain) > MAX_BYTES) throw new Error('Field grants too large')
        this.atomicWrite(this.path, this.atRest ? encryptJsonFile(this.atRest, JSON.parse(plain)) : plain)
        this.dirty = false
      }
      const marker = fileState(this.marker)
      if (marker === 'invalid') throw new Error('Unsafe field access initialization path')
      if (marker === 'missing') this.atomicWrite(this.marker, '1\n')
    } catch (error) { this.unavailable = true; throw error }
  }
}
