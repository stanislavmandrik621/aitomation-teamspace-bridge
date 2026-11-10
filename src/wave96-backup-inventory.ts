/** Full export inventory. Payloads and central-directory rows stay on disk. */
import { DatabaseSync } from 'node:sqlite'
import { opendir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { CHAT_BACKUP_TOP_LEVEL } from './chat-backup-paths.js'
import { planStoredBackupZip, measureStoredBackupZipWave96, type BackupZipEntry, type PlannedBackupZipEntry, type BackupZipCentralStore } from './backup-zip.js'
import { snapshotChatBackupMetadata } from './chat-backup-snapshot.js'

function check(signal?: AbortSignal, authorize?: () => boolean): void {
  signal?.throwIfAborted()
  if (authorize && !authorize()) throw Error('Backup access is no longer allowed')
}

/** Directory handles buffer only 32 entries. Unreadable/deep trees fail closed. */
export async function* walkChatWave96(dataDir: string, authorityDir = dataDir, signal?: AbortSignal): AsyncGenerator<BackupZipEntry> {
  const pinned = new Set<string>(CHAT_BACKUP_TOP_LEVEL)
  const root = join(dataDir, 'chat')
  let hasRoot = true
  try {
    if (!(await lstat(root)).isDirectory()) throw Error('Chat backup root must be a real directory')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    hasRoot = false
  }
  for (const name of pinned) {
    check(signal)
    const absolutePath = join(name === 'chat/rooms.json' ? authorityDir : dataDir, name)
    try {
      const st = await lstat(absolutePath)
      if (st.isFile()) yield { name, absolutePath, size: st.size }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
  }
  async function* walk(directory: string, rel: string, depth: number): AsyncGenerator<BackupZipEntry> {
    check(signal)
    if (depth > 14) throw Error('Chat backup directory depth exceeds safe traversal depth')
    const dir = await opendir(directory, { bufferSize: 32 })
    for await (const child of dir) {
      check(signal)
      if (/\.(?:tmp|part|rewrite)(?:\.|$)/.test(child.name)) continue
      const absolutePath = join(directory, child.name)
      const name = `${rel}/${child.name}`
      if (pinned.has(name)) continue
      const st = await lstat(absolutePath)
      if (st.isDirectory()) yield* walk(absolutePath, name, depth + 1)
      else if (st.isFile()) yield { name, absolutePath, size: st.size }
    }
  }
  if (hasRoot) yield* walk(root, 'chat', 0)
}

type DiskPlan = { name: string; absolutePath: string; size: number; device: number; inode: number }

/** Caller owns directory, closes DB then removes directory in finally. */
export class BackupInventoryWave96 implements Iterable<PlannedBackupZipEntry> {
  private db: DatabaseSync
  count = 0
  chatCount = 0
  snapshotCount = 0
  constructor(private directory: string) {
    this.db = new DatabaseSync(join(directory, 'inventory.sqlite'))
    try { this.db.exec(`PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;
      PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
      CREATE TABLE entries (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, identity TEXT UNIQUE NOT NULL,
        absolutePath TEXT NOT NULL, size INTEGER NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL);
      CREATE TABLE central (seq INTEGER PRIMARY KEY, name BLOB NOT NULL, crc INTEGER NOT NULL, size INTEGER NOT NULL, localOffset INTEGER NOT NULL);`)
    } catch (error) { try { this.db.close() } catch { /* preserve schema failure */ } throw error }
  }
  async collect(entries: AsyncIterable<BackupZipEntry> | Iterable<BackupZipEntry>, opts: { signal?: AbortSignal; authorize?: () => boolean } = {}): Promise<void> {
    const insert = this.db.prepare('INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?, ?)')
    for await (const entry of entries) {
      check(opts.signal, opts.authorize)
      const staged = await snapshotChatBackupMetadata([entry], this.directory, opts.signal, this.count)
      const result = await planStoredBackupZip(staged, { signal: opts.signal })
      if (!result.ok) throw Error(result.error)
      const row = result.planned[0]!
      // Disk UNIQUE index preserves cross-batch case/Unicode collision checks.
      insert.run(this.count + 1, entry.name, entry.name.normalize('NFC').toLowerCase(), row.absolutePath, row.size, row.device, row.inode)
      this.count++
      if (entry.name.startsWith('chat/')) this.chatCount++
      else this.snapshotCount++
      if (this.count % 64 === 0) await new Promise<void>(resolve => setImmediate(resolve))
    }
  }
  *[Symbol.iterator](): Generator<PlannedBackupZipEntry> {
    for (const raw of this.db.prepare('SELECT name, absolutePath, size, device, inode FROM entries ORDER BY seq').iterate()) {
      const row = raw as unknown as DiskPlan
      yield { ...row, nameBuf: Buffer.from(row.name, 'utf8'), crc: 0 }
    }
  }
  measure(opts?: { signal?: AbortSignal; authorize?: () => boolean }): ReturnType<typeof measureStoredBackupZipWave96> { return measureStoredBackupZipWave96(this, opts) }
  centralStore(): BackupZipCentralStore {
    const db = this.db
    db.exec('DELETE FROM central')
    let length = 0
    const insert = db.prepare('INSERT INTO central VALUES (?, ?, ?, ?, ?)')
    return {
      get length() { return length },
      push(row) { insert.run(++length, row.nameBuf, row.crc, row.size, row.localOffset) },
      *[Symbol.iterator]() {
        for (const row of db.prepare('SELECT name, crc, size, localOffset FROM central ORDER BY seq').iterate()) {
          yield { nameBuf: Buffer.from(row.name as Uint8Array), crc: row.crc as number, size: row.size as number, localOffset: row.localOffset as number }
        }
      },
    }
  }
  close(): void { this.db.close() }
}
