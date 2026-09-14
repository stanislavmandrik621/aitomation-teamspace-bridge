/** Never imported on the bridge event loop. Node's synchronous SQLite stays in this worker. */
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'
import type { MailStoreBatchOptions } from './mail-store.js'

type Row = { collection: string; id: string; owner: string | null; account: string | null; status: string | null; due: number | null; revision: number; payload: Uint8Array | null; deleted: number; payloadBytes?: number }
type PreparedWrite = { collection: string; id: string; value?: unknown; owner: string | null; account: string | null; status: string | null; due: number | null; delete: boolean; plain: Buffer | null }
class StoreFailure extends Error { constructor(readonly code: string) { super(code) } }
function failureCode(error: unknown): string {
  if (error instanceof StoreFailure) return error.code
  // SQLite's real page/disk capacity error must remain actionable without
  // exposing its raw SQL message or filesystem paths to the caller.
  if ((error as { code?: unknown; errcode?: unknown })?.code === 'ERR_SQLITE_ERROR'
    && (error as { errcode?: unknown }).errcode === 13) return 'capacity'
  return 'storage'
}
const invalid = (): never => { throw new StoreFailure('invalid') }
const MAX_ROW = 256 * 1024
const MAX_BATCH = 4 * 1024 * 1024
const TERMINAL = ['accepted', 'rejected', 'cancelled', 'unknown']
const port = parentPort
if (!port) throw new Error('Mailbox storage requires a worker')
const key = Buffer.from(workerData.key ?? [])
if (key.length !== 32) throw new Error('Mailbox storage key required')
const indexKey = createHmac('sha256', key).update('mail-store-routing-v1').digest()
let db: DatabaseSync
let dbPath = ''
let directory = ''
const maxBytes = Number(workerData.maxBytes)

function own(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid()
  return raw as Record<string, unknown>
}
function collection(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw)) return invalid()
  return raw
}
function recordId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_.:-]{1,256}$/.test(raw)) return invalid()
  return raw
}
function routing(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !raw || raw.length > 4096 || /[\u0000-\u001f\u007f]/.test(raw)) return invalid()
  return createHmac('sha256', indexKey).update(raw).digest('hex')
}
function status(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(raw)) return invalid()
  return raw
}
function timestamp(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0 || raw > 8_640_000_000_000_000) return invalid()
  return raw
}
function limit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 500) return invalid()
  return raw
}
function aad(row: Omit<Row, 'payload' | 'deleted'>): Buffer {
  return Buffer.from(JSON.stringify(['mail-row-v1', row.collection, row.id, row.owner, row.account, row.status, row.due, row.revision]))
}
function seal(plain: Buffer, binding: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(binding)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from('MSE1'), iv, cipher.getAuthTag(), body])
}
function open(payload: Uint8Array, binding: Buffer): Buffer {
  try {
    const bytes = Buffer.from(payload)
    if (bytes.length < 33 || bytes.length > MAX_ROW + 64 || bytes.subarray(0, 4).toString() !== 'MSE1') throw new Error('invalid')
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(4, 16))
    decipher.setAAD(binding)
    decipher.setAuthTag(bytes.subarray(16, 32))
    return Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()])
  } catch { throw new StoreFailure('key') }
}
function decode(row: Row) {
  if (!row.payload || row.deleted || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new StoreFailure('key')
  try { return { id: row.id, revision: row.revision, value: JSON.parse(open(row.payload, aad(row)).toString('utf8')) as unknown } }
  catch { throw new StoreFailure('key') }
}
function fileSafe(path: string): void {
  // existsSync follows symlinks, so it mistakes a dangling link for an absent
  // path and would let SQLite create a file at the link's external target.
  let stat: ReturnType<typeof lstatSync>
  try { stat = lstatSync(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new StoreFailure('storage')
  chmodSync(path, 0o600)
}
function initialize(): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 * 1024 * 1024 || maxBytes > 1024 ** 4) invalid()
  const dataDir = resolve(String(workerData.dataDir))
  if (lstatSync(dataDir).isSymbolicLink() || !lstatSync(dataDir).isDirectory()) throw new StoreFailure('storage')
  directory = join(dataDir, 'mail-oauth')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new StoreFailure('storage')
  chmodSync(directory, 0o700)
  dbPath = join(directory, 'mail-store.sqlite3')
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) fileSafe(path)
  if (!existsSync(dbPath)) {
    try { const fd = openSync(dbPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(fd) }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err; fileSafe(dbPath) }
  }
  db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false })
  db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA journal_size_limit=0; PRAGMA wal_autocheckpoint=128; PRAGMA secure_delete=ON;')
  const pageSize = Number(db.prepare('PRAGMA page_size').get()?.page_size)
  db.exec(`PRAGMA max_page_count=${Math.floor((maxBytes - 16 * 1024 * 1024) / pageSize)}`)
  db.exec('BEGIN IMMEDIATE')
  try {
    const existed = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='mail_records'").get()
    db.exec(`CREATE TABLE IF NOT EXISTS mail_meta (name TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS mail_records (
        collection TEXT NOT NULL, id TEXT NOT NULL, owner TEXT, account TEXT, status TEXT, due INTEGER,
        revision INTEGER NOT NULL, payload BLOB, deleted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (collection,id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS mail_owner_id ON mail_records(collection,owner,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_account_id ON mail_records(collection,account,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_status_id ON mail_records(collection,status,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_due_id ON mail_records(collection,due,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_status_due ON mail_records(collection,status,due,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_account_status_due ON mail_records(collection,account,status,due,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_owner_status_due ON mail_records(collection,owner,status,due,id) WHERE deleted=0;
      CREATE INDEX IF NOT EXISTS mail_owner_account_id ON mail_records(collection,owner,account,id) WHERE deleted=0;`)
    const sentinel = db.prepare("SELECT value FROM mail_meta WHERE name='key-sentinel-v1'").get() as { value: Uint8Array } | undefined
    const binding = Buffer.from('mail-store-key-sentinel-v1')
    if (sentinel) {
      if (open(sentinel.value, binding).toString('utf8') !== 'mail-store-v1') throw new StoreFailure('key')
    } else {
      if (existed) throw new StoreFailure('key')
      db.prepare("INSERT INTO mail_meta(name,value) VALUES('key-sentinel-v1',?)").run(seal(Buffer.from('mail-store-v1'), binding))
    }
    db.exec('COMMIT')
  } catch (err) { db.exec('ROLLBACK'); throw err }
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) fileSafe(path)
}
function rowFor(coll: string, id: string): Row | undefined {
  return db.prepare('SELECT * FROM mail_records WHERE collection=? AND id=?').get(coll, id) as Row | undefined
}
function rowMetadata(coll: string, id: string): Row | undefined {
  return db.prepare('SELECT collection,id,owner,account,status,due,revision,deleted,length(payload) AS payloadBytes,NULL AS payload FROM mail_records WHERE collection=? AND id=?').get(coll, id) as Row | undefined
}
function filter(coll: string, query: Record<string, unknown>, includeDeleted = false): { sql: string; values: Array<string | number> } {
  const clauses = ['collection=?', ...(includeDeleted ? [] : ['deleted=0'])]
  const values: Array<string | number> = [coll]
  for (const field of ['owner', 'account'] as const) {
    if (query[field] !== undefined) { clauses.push(`${field}=?`); values.push(routing(query[field])!) }
  }
  if (query.status !== undefined) { clauses.push('status=?'); values.push(status(query.status)!) }
  if (query.dueBefore !== undefined) { clauses.push('due IS NOT NULL AND due<=?'); values.push(timestamp(query.dueBefore)) }
  return { sql: clauses.join(' AND '), values }
}
function count(coll: string, query: Record<string, unknown>): number {
  const where = filter(coll, query)
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM mail_records WHERE ${where.sql}`).get(...where.values)?.count)
}
function list(coll: string, query: Record<string, unknown>) {
  const pageSize = limit(query.limit)
  if (query.metadataOnly !== undefined && (typeof query.metadataOnly !== 'boolean' || (query.metadataOnly && coll !== 'outbox'))) invalid()
  const where = filter(coll, query)
  const due = query.dueBefore !== undefined
  if (query.after !== undefined) {
    const after = recordId(query.after)
    if (due) {
      const cursor = db.prepare(`SELECT due FROM mail_records WHERE ${where.sql} AND id=?`).get(...where.values, after) as { due: number } | undefined
      if (!cursor) invalid()
      where.sql += ' AND (due>? OR (due=? AND id>?))'
      where.values.push(cursor!.due, cursor!.due, after)
    } else { where.sql += ' AND id>?'; where.values.push(after) }
  }
  const rows = db.prepare(`SELECT * FROM mail_records WHERE ${where.sql} ORDER BY ${due ? 'due,id' : 'id'} LIMIT ?`).iterate(...where.values, pageSize)
  const result: ReturnType<typeof decode>[] = []
  let bytes = 0
  // Enforce the byte budget while stepping SQLite, not after materializing up
  // to 500 large encrypted records in memory.
  for (const raw of rows) {
    const row = raw as Row
    const decoded = decode(row)
    if (query.metadataOnly) {
      const value = own(decoded.value)
      // Return only public outbox fields. Bodies, payload digests, actor
      // identities and future private fields never cross this IPC projection.
      decoded.value = Object.fromEntries(['jobId', 'idempotencyKey', 'status', 'providerMessageId', 'connectionId', 'to', 'subject', 'createdAt', 'error']
        .filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]))
    }
    bytes += query.metadataOnly ? Buffer.byteLength(JSON.stringify(decoded)) : row.payload?.byteLength ?? 0
    if (bytes > MAX_BATCH) throw new StoreFailure('capacity')
    result.push(decoded)
  }
  return result
}
function prepareWrites(raw: unknown): PreparedWrite[] {
  if (!Array.isArray(raw) || raw.length > 500) invalid()
  const writes: PreparedWrite[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const item of raw as unknown[]) {
    const value = own(item)
    const coll = collection(value.collection); const id = recordId(value.id)
    const key = `${coll}\n${id}`
    if (seen.has(key) || (value.delete !== undefined && typeof value.delete !== 'boolean')) invalid()
    seen.add(key)
    let plain: Buffer | null = null
    if (value.delete !== true) {
      let json: string | undefined
      try { json = JSON.stringify(value.value) } catch { invalid() }
      if (json === undefined) invalid()
      plain = Buffer.from(json!)
      if (plain.byteLength > MAX_ROW) throw new StoreFailure('capacity')
      bytes += plain.byteLength + 128
      if (bytes > MAX_BATCH) throw new StoreFailure('capacity')
    }
    writes.push({ collection: coll, id, value: value.value, owner: routing(value.owner), account: routing(value.account), status: status(value.status), due: value.due === undefined ? null : timestamp(value.due), delete: value.delete === true, plain })
  }
  return writes
}
function diskRoom(): void {
  let total = 0
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (existsSync(path)) total += statSync(path).size
  if (total + MAX_BATCH * 2 > maxBytes) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    total = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].reduce((n, path) => n + (existsSync(path) ? statSync(path).size : 0), 0)
    if (total + MAX_BATCH * 2 > maxBytes) throw new StoreFailure('capacity')
  }
}
function batch(raw: unknown, rawOptions: unknown): boolean {
  const writes = prepareWrites(raw)
  const options = own(rawOptions) as MailStoreBatchOptions
  const checks = options.checks ?? []
  const limits = options.limits ?? []
  if (!Array.isArray(checks) || checks.length > 1000 || !Array.isArray(limits) || limits.length > 100) invalid()
  for (const check of checks) { collection(check.collection); recordId(check.id); if (check.revision !== null && (!Number.isSafeInteger(check.revision) || check.revision < 1)) invalid() }
  for (const quota of limits) { collection(quota.collection); routing(quota.owner); routing(quota.account); if (!Number.isSafeInteger(quota.max) || quota.max < 0 || quota.max > 10_000_000) invalid() }
  diskRoom()
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const check of checks) {
      const row = rowMetadata(check.collection, check.id)
      const actual = row && !row.deleted ? row.revision : null
      if (actual !== check.revision) { db.exec('ROLLBACK'); return false }
    }
    const previous = new Map(writes.map(w => [`${w.collection}\n${w.id}`, rowMetadata(w.collection, w.id)]))
    // secure_delete also rewrites old overflow pages. A small replacement or
    // delete request can otherwise dirty hundreds of MiB of existing payloads.
    const touchedBytes = writes.reduce((bytes, write) => bytes + (write.plain?.byteLength ?? 0)
      + (previous.get(`${write.collection}\n${write.id}`)?.payloadBytes ?? 0), 0)
    if (touchedBytes > MAX_BATCH) throw new StoreFailure('capacity')
    for (const quota of limits) {
      const quotaOwner = routing(quota.owner)
      const quotaAccount = routing(quota.account)
      let nextCount = count(quota.collection, { owner: quota.owner, account: quota.account })
      for (const write of writes) {
        if (write.collection !== quota.collection) continue
        const old = previous.get(`${write.collection}\n${write.id}`)
        if (old && !old.deleted && (quotaOwner === null || old.owner === quotaOwner) && (quotaAccount === null || old.account === quotaAccount)) nextCount--
        if (!write.delete && (quotaOwner === null || write.owner === quotaOwner) && (quotaAccount === null || write.account === quotaAccount)) nextCount++
      }
      if (nextCount > quota.max) { db.exec('ROLLBACK'); return false }
    }
    const put = db.prepare(`INSERT INTO mail_records(collection,id,owner,account,status,due,revision,payload,deleted) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(collection,id) DO UPDATE SET owner=excluded.owner,account=excluded.account,status=excluded.status,due=excluded.due,revision=excluded.revision,payload=excluded.payload,deleted=excluded.deleted`)
    for (const write of writes) {
      const old = previous.get(`${write.collection}\n${write.id}`)
      if (write.delete && (!old || old.deleted)) continue
      const revision = (old?.revision ?? 0) + 1
      if (!Number.isSafeInteger(revision)) throw new StoreFailure('capacity')
      const row = { collection: write.collection, id: write.id, owner: write.delete ? null : write.owner, account: write.delete ? null : write.account,
        status: write.delete ? old?.status ?? null : write.status, due: write.delete ? old?.due ?? null : write.due, revision }
      put.run(row.collection, row.id, row.owner, row.account, row.status, row.due, revision, write.delete ? null : seal(write.plain!, aad(row)), write.delete ? 1 : 0)
    }
    db.exec('COMMIT')
    return true
  } catch (err) { try { db.exec('ROLLBACK') } catch { /* already rolled back by SQLite */ }; throw err }
}
function credentialToken(raw: unknown) {
  const value = own(raw)
  if (Object.keys(value).some(key => !['accessToken', 'refreshToken', 'expiresAt'].includes(key))
    || typeof value.accessToken !== 'string' || !value.accessToken || value.accessToken.length > 32768
    || typeof value.refreshToken !== 'string' || !value.refreshToken || value.refreshToken.length > 32768
    || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0) return invalid()
  return { accessToken: value.accessToken, refreshToken: value.refreshToken, expiresAt: value.expiresAt }
}
function rotateConnection(id: string, rawExpected: unknown, rawReplacement: unknown) {
  const expected = own(rawExpected)
  if (Object.keys(expected).some(key => !['registration', 'readInbox', 'mailboxAccess', 'token'].includes(key))
    || typeof expected.registration !== 'string' || !/^[a-f0-9]{64}$/.test(expected.registration)
    || typeof expected.readInbox !== 'boolean' || (expected.mailboxAccess !== undefined && typeof expected.mailboxAccess !== 'boolean')) invalid()
  const priorToken = credentialToken(expected.token)
  const replacement = credentialToken(rawReplacement)
  diskRoom()
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = rowFor('connections', id)
    if (!row || row.deleted) { db.exec('COMMIT'); return { kind: 'missing' } }
    const value = own(decode(row).value)
    const current = credentialToken(value.token)
    if (value.registration !== expected.registration || value.readInbox !== expected.readInbox
      || (value.mailboxAccess === true) !== (expected.mailboxAccess === true)
      || current.accessToken !== priorToken.accessToken || current.refreshToken !== priorToken.refreshToken || current.expiresAt !== priorToken.expiresAt) {
      db.exec('COMMIT'); return { kind: 'changed', value }
    }
    const updated = { ...value, token: replacement }
    const plain = Buffer.from(JSON.stringify(updated))
    if (plain.byteLength > MAX_ROW || plain.byteLength + (row.payload?.byteLength ?? 0) > MAX_BATCH) throw new StoreFailure('capacity')
    const revision = row.revision + 1
    if (!Number.isSafeInteger(revision)) throw new StoreFailure('capacity')
    db.prepare("UPDATE mail_records SET payload=?,revision=? WHERE collection='connections' AND id=?")
      .run(seal(plain, aad({ ...row, revision })), revision, id)
    db.exec('COMMIT')
    return { kind: 'updated', value: updated }
  } catch (error) { try { db.exec('ROLLBACK') } catch { /* SQLite may already have rolled back. */ }; throw error }
}
function purge(coll: string, query: Record<string, unknown>): number {
  if (coll !== 'outbox') invalid()
  const cutoff = timestamp(query.dueBefore); const take = limit(query.limit)
  const chosen = query.status === undefined ? TERMINAL : [status(query.status)!]
  if (chosen.some(s => !TERMINAL.includes(s))) invalid()
  const placeholders = chosen.map(() => '?').join(',')
  db.exec('BEGIN IMMEDIATE')
  try {
    const eligible = db.prepare(`SELECT id,length(payload) AS bytes FROM mail_records WHERE collection='outbox'
      AND status IN (${placeholders}) AND due IS NOT NULL AND due<=? ORDER BY due,id LIMIT ?`).iterate(...chosen, cutoff, take)
    const ids: string[] = []
    let bytes = 0
    for (const row of eligible) {
      const next = Number(row.bytes ?? 0)
      if (next > MAX_BATCH && !ids.length) throw new StoreFailure('capacity')
      if (bytes + next > MAX_BATCH) break
      ids.push(String(row.id)); bytes += next
    }
    const remove = db.prepare("DELETE FROM mail_records WHERE collection='outbox' AND id=?")
    for (const id of ids) remove.run(id)
    db.exec('COMMIT')
    db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    return ids.length
  } catch (err) { try { db.exec('ROLLBACK') } catch { /* already committed/rolled back */ }; throw err }
}

try {
  initialize()
  port.postMessage({ ready: true })
  port.on('message', (message: unknown) => {
    let id = 0
    try {
      const request = own(message)
      if (!Number.isSafeInteger(request.id) || Number(request.id) < 1) invalid()
      id = Number(request.id)
      const args = own(request.args)
      let value: unknown
      if (request.operation === 'get') { const row = rowFor(collection(args.collection), recordId(args.id)); value = row && !row.deleted ? decode(row) : null }
      else if (request.operation === 'list') value = list(collection(args.collection), own(args.query) as unknown as Record<string, unknown>)
      else if (request.operation === 'count') value = count(collection(args.collection), own(args.query))
      else if (request.operation === 'batch') value = batch(args.writes, args.options)
      else if (request.operation === 'rotateConnection') value = rotateConnection(recordId(args.id), args.expected, args.replacementToken)
      else if (request.operation === 'purge') value = purge(collection(args.collection), own(args.query))
      else if (request.operation === 'close') { db.close(); key.fill(0); indexKey.fill(0); port.postMessage({ id, value: undefined }); port.close(); return }
      else invalid()
      port.postMessage({ id, value })
    } catch (err) { port.postMessage({ id, error: failureCode(err) }) }
  })
} catch (err) {
  try { db!?.close() } catch { /* startup failed */ }
  key.fill(0); indexKey.fill(0)
  port.postMessage({ id: 0, error: failureCode(err) })
  port.close()
}
