/**
 * BRG-069: CRM blob disk usage is an O(1) running total, same idea as the
 * chat attachment registry. Walk the blobs folder once at seed (boot, or
 * when the in-memory total was never established - persist miss). Public
 * reads never readdir. Add only after a successful NEW put lands on disk.
 * Count is the same O(1) register (hex files only). Unlink goes through
 * unlinkHexBlob / removeAfterUnlink so an in-process delete decrements.
 *
 * Seed fail is fail-closed: bytes() returns CRM_BLOB_DISK_UNREADABLE so a
 * quota check (`used + add > diskMax`) refuses new uploads instead of
 * treating an unreadable folder as empty (0).
 */

import { readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** Final CRM blob names are 64-char lowercase hex. `.part` files are not counted. */
export const CRM_BLOB_HEX_RE = /^[a-f0-9]{64}$/

/**
 * Fail-closed sentinel when the blobs folder cannot be measured.
 * Larger than any configured CRM disk ceiling, so quota refuses.
 */
export const CRM_BLOB_DISK_UNREADABLE = Number.MAX_SAFE_INTEGER

function isFsMissing(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code: unknown }).code === 'ENOENT',
  )
}

function sameResolvedPath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

export class CrmBlobDiskTotal {
  private total = 0
  private hexCount = 0
  private seeded = false
  private unreadable = false

  constructor(private readonly blobsDir: string) {}

  /**
   * Disk walk. No-op when this instance already has a readable total.
   * Retries after a failed seed so a later readable folder can recover.
   */
  seed(): void {
    if (this.seeded && !this.unreadable) return
    try {
      let total = 0
      let hexCount = 0
      for (const name of readdirSync(this.blobsDir)) {
        if (!CRM_BLOB_HEX_RE.test(name)) continue
        try {
          const st = statSync(join(this.blobsDir, name))
          if (!st.isFile()) continue
          total += st.size
          hexCount += 1
        } catch (err) {
          // ENOENT: vanished mid-walk. Any other stat fail is fail-closed
          // (under-count would let uploads past the real disk).
          if (isFsMissing(err)) continue
          throw err
        }
      }
      this.total = total
      this.hexCount = hexCount
      this.unreadable = false
      this.seeded = true
    } catch (err) {
      this.unreadable = true
      this.seeded = true
      this.total = CRM_BLOB_DISK_UNREADABLE
      this.hexCount = 0
      const detail = err instanceof Error ? err.message : 'unreadable'
      console.warn(
        `[bridge] CRM blob disk total unreadable - new uploads are refused until the folder can be read (${detail})`,
      )
    }
  }

  /**
   * O(1) after seed. Walks only on persist miss (never seeded in this process).
   * Must not readdir on this path.
   */
  bytes(): number {
    if (!this.seeded) this.seed()
    return this.unreadable ? CRM_BLOB_DISK_UNREADABLE : this.total
  }

  /**
   * O(1) hex-blob count after seed. Must not readdir on this path.
   * Unreadable seed returns 0; callers that refuse uploads use bytes() / isUnreadable().
   */
  count(): number {
    if (!this.seeded) this.seed()
    return this.unreadable ? 0 : this.hexCount
  }

  /** True when seed could not list the folder. Quota must refuse. */
  isUnreadable(): boolean {
    return this.unreadable
  }

  /**
   * After renameSync of a NEW sha (not an exists-skip). `onDiskBytes` is
   * toWrite.length / stat size after encrypt, never the pre-write Content-Length.
   * 0-byte files still increment hexCount (seed + unlinkHexBlob do the same).
   *
   * Persist-miss: seed walks AFTER the file is already on disk, so this must
   * not add again (walk is already truth). Same polarity as removeAfterUnlink
   * (BRG-073 / BRG-069).
   */
  addAfterNewPut(onDiskBytes: number): void {
    if (!this.seeded) {
      this.seed()
      return
    }
    if (this.unreadable) return
    if (!Number.isFinite(onDiskBytes) || onDiskBytes < 0) return
    this.total += Math.floor(onDiskBytes)
    this.hexCount += 1
  }

  /**
   * After unlinkSync of a hex blob. `onDiskBytes` is the stat size taken
   * BEFORE unlink. A persist-miss seed walks the folder after the file is
   * already gone, so this must not subtract again (walk is already truth).
   */
  removeAfterUnlink(onDiskBytes: number): void {
    if (!this.seeded) {
      this.seed()
      return
    }
    if (this.unreadable) return
    if (!Number.isFinite(onDiskBytes) || onDiskBytes < 0) return
    this.total = Math.max(0, this.total - Math.floor(onDiskBytes))
    this.hexCount = Math.max(0, this.hexCount - 1)
  }

  /**
   * In-process unlink chokepoint: stat, prove the path is this blobsDir hex
   * name, unlink, then decrement. A raw unlinkSync (operator / out-of-band)
   * leaves the running total high until the next process seed.
   */
  unlinkHexBlob(absPath: string): boolean {
    const raw = String(absPath || '')
    if (!raw) return false
    const name = basename(raw)
    if (!CRM_BLOB_HEX_RE.test(name)) return false
    const expected = join(this.blobsDir, name)
    if (!sameResolvedPath(raw, expected)) return false
    let size = 0
    try {
      const st = statSync(expected)
      if (!st.isFile()) return false
      size = st.size
    } catch {
      return false
    }
    try {
      unlinkSync(expected)
    } catch {
      return false
    }
    this.removeAfterUnlink(size)
    return true
  }
}

/** Seed immediately (boot walk). Store calls this after mkdirSync(blobsDir). */
export function createCrmBlobDiskTotal(blobsDir: string): CrmBlobDiskTotal {
  const disk = new CrmBlobDiskTotal(blobsDir)
  disk.seed()
  return disk
}
