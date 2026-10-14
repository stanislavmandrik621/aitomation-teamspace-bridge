/** Incremental authority checkpoint. The bridge WAL remains the replay source.
 * Values (including identities) are encrypted with the existing at-rest key;
 * SQLite indexes only a digest. FULL-synchronous transactions publish batches.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash, createHmac } from 'node:crypto'
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'

export type AuthorityEntry = { kind: string; key: string; value: unknown }
export const authoritySlot = (kind: string, key: string): string => createHash('sha256').update(JSON.stringify([kind, key])).digest('hex')
export class ContentAccessStorage {
  private db: DatabaseSync
  private slot(kind: string, key: string): string {
    return this.encryption ? createHmac('sha256', this.encryption.key).update(JSON.stringify(['content-authority-v2', kind, key])).digest('hex') : authoritySlot(kind, key)
  }
  constructor(root: string, private encryption: AtRestKey | null, existing: boolean) {
    const path = join(root, 'content-access.sqlite')
    if (existing && !existsSync(path)) throw new Error('Content authority database missing')
    mkdirSync(root, { recursive: true })
    const safe = (file: string) => {
      try {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe authority database path')
        chmodSync(file, 0o600)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) safe(file)
    if (!existsSync(path)) {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
      closeSync(fd)
    }
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS authority (slot TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS authority_meta (version INTEGER NOT NULL)')
    if (existing && this.db.prepare('SELECT version FROM authority_meta').get()?.version !== 2) throw new Error('Content authority database is incomplete')
    if (!existing) this.db.exec('BEGIN IMMEDIATE; DELETE FROM authority; DELETE FROM authority_meta; INSERT INTO authority_meta VALUES (2); COMMIT')
  }
  *load(): Generator<AuthorityEntry> {
    for (const row of this.db.prepare('SELECT slot, body FROM authority').iterate()) {
      const entry = decryptJsonFile<AuthorityEntry | null>(this.encryption, String(row.body), null)
      if (!entry || typeof entry.kind !== 'string' || typeof entry.key !== 'string'
        || this.slot(entry.kind, entry.key) !== row.slot) throw new Error('Invalid content authority entry')
      yield entry
    }
  }
  write(entries: Iterable<AuthorityEntry>): void {
    const put = this.db.prepare('INSERT INTO authority VALUES (?, ?) ON CONFLICT(slot) DO UPDATE SET body = excluded.body')
    const remove = this.db.prepare('DELETE FROM authority WHERE slot = ?')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        const slot = this.slot(entry.kind, entry.key)
        if (entry.value === undefined) remove.run(slot)
        else put.run(slot, this.encryption ? encryptJsonFile(this.encryption, entry) : JSON.stringify(entry))
      }
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
}
