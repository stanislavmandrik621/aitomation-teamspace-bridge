/**
 * Permanent negative token history, independent of the capped guest registries.
 * No cache or eviction: forgetting a retired bearer token would reopen a URL.
 * Hash buckets bound each admission scan and total disk usage; a full/unreadable
 * bucket refuses mutations until storage is repaired, rather than forgetting.
 */
import { randomBytes } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, existsSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'
import {GuestTokenRetirementIndex} from './guest-token-retirement-index.js'

export const GUEST_TOKEN_RETIREMENT_BUCKET_CAP = 1024
export const GUEST_TOKEN_RETIREMENT_UNAVAILABLE =
  'Guest token history could not be saved or verified. Repair server storage before changing links.'

export class GuestTokenRetirementStore {
  private readonly index:GuestTokenRetirementIndex|null
  constructor(
    private readonly directory: string,
    private readonly atRest: AtRestKey | null,
  ) {this.index=existsSync(join(dirname(directory),'.authorization-binding.json'))?new GuestTokenRetirementIndex(directory,atRest):null}

  private tokenPath(tokenHash: string): string {
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
    return join(this.directory, tokenHash.slice(0, 2), `${tokenHash}.json`)
  }

  isRetired(tokenHash: string): boolean {
    const path = this.tokenPath(tokenHash)
    try{if(this.index?.has(tokenHash))return true}catch{throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)}
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
    }
    try {
      if (!stat.isFile() || stat.size > 4096) throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
      const record = decryptJsonFile<{ version?: unknown; tokenHash?: unknown } | null>(
        this.atRest, readFileSync(path, 'utf8'), null,
      )
      if (record?.version !== 1 || record.tokenHash !== tokenHash) {
        throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
      }
      this.index?.retain(tokenHash)
      return true
    } catch {
      throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
    }
  }

  retire(tokenHash: string): void {
    if (this.isRetired(tokenHash)) return
    const path = this.tokenPath(tokenHash)
    const bucket = join(this.directory, tokenHash.slice(0, 2))
    let temporary: string | null = null
    try {
      // A durable negative decision precedes the legacy file. If a later
      // write fails, the old URL stays blocked and the source is preserved.
      this.index?.retain(tokenHash)
      mkdirSync(bucket, { recursive: true })
      let count = 0
      const entries = opendirSync(bucket)
      try {
        while (entries.readSync()) {
          if (++count >= GUEST_TOKEN_RETIREMENT_BUCKET_CAP) {
            throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
          }
        }
      } finally { entries.closeSync() }
      temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`
      const record = { version: 1, tokenHash }
      const body = this.atRest ? encryptJsonFile(this.atRest, record) : JSON.stringify(record)
      const file = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(file, body, 'utf8')
        fsyncSync(file)
      } finally { closeSync(file) }
      renameSync(temporary, path)
      temporary = null
      // Persist the directory entry before acknowledging revoke or replacing
      // the active token. Registries may subsequently garbage-collect the row.
      // Node cannot open/flush directory handles on Windows. File fsync and
      // atomic rename still apply there; do not turn every revoke into EPERM.
      if (process.platform !== 'win32') {
        for (const directory of [bucket, this.directory, dirname(this.directory)]) {
          const handle = openSync(directory, 'r')
          try { fsyncSync(handle) } finally { closeSync(handle) }
        }
      }
    } catch {
      throw new Error(GUEST_TOKEN_RETIREMENT_UNAVAILABLE)
    } finally {
      if (temporary) {
        try { unlinkSync(temporary) } catch { /* Failure remains fail-closed. */ }
      }
    }
  }
}
