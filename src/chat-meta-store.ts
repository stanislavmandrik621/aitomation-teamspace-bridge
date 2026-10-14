/**
 * Team chat Admin retention + disk quota meta (durable under chat/_meta.json).
 * Env vars seed first-run defaults; Admin set via chat_config_set wins thereafter.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AtRestKey } from './at-rest.js'
import { decryptJsonFile, encryptJsonFile } from './at-rest.js'
import {
  CHAT_DISK_QUOTA_BLOBS_DEFAULT,
  CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT,
  CHAT_RETENTION_DAYS_DEFAULT,
} from './chat-room.js'
import type { ChatDiskQuotas } from './chat-disk-quota.js'

export const CHAT_RETENTION_DAYS_MIN = 0
export const CHAT_RETENTION_DAYS_MAX = 3650
/** Soft floor so Admin cannot set a useless 1-byte ceiling. */
export const CHAT_QUOTA_BYTES_MIN = 64 * 1024 * 1024
export const CHAT_QUOTA_FILES_MAX = 64 * 1024 * 1024 * 1024
export const CHAT_QUOTA_BLOBS_MAX = 128 * 1024 * 1024 * 1024

/**
 * v2: quota defaults moved 2 GiB -> 10 GiB (history) and 8 GiB -> 20 GiB
 * (attachments). Loading a v1 file upgrades a stored value still equal to
 * the OLD default to the new default once, then stamps v2 so a later
 * deliberate Admin choice of exactly 2/8 GiB is never bumped again.
 */
export const CHAT_META_SCHEMA_VERSION = 2

export type ChatServerMeta = {
  schemaVersion: typeof CHAT_META_SCHEMA_VERSION
  /** 0 = keep forever; else prune messages older than N days. */
  retentionDays: number
  chatFilesBytes: number
  chatBlobsBytes: number
}

export type ChatServerMetaSeed = {
  retentionDays: number
  chatFilesBytes: number
  chatBlobsBytes: number
}

type MetaFile = Partial<ChatServerMeta> & { schemaVersion?: number }

function clampRetentionDays(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n < 0) return CHAT_RETENTION_DAYS_DEFAULT
  if (n === 0) return 0
  return Math.min(CHAT_RETENTION_DAYS_MAX, Math.floor(n))
}

function clampQuotaBytes(raw: unknown, max: number, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.max(CHAT_QUOTA_BYTES_MIN, Math.floor(n)))
}

function normalizeMeta(cur: MetaFile, seed: ChatServerMetaSeed): ChatServerMeta {
  return {
    schemaVersion: CHAT_META_SCHEMA_VERSION,
    retentionDays: clampRetentionDays(
      typeof cur.retentionDays === 'number' ? cur.retentionDays : seed.retentionDays,
    ),
    chatFilesBytes: clampQuotaBytes(
      typeof cur.chatFilesBytes === 'number' ? cur.chatFilesBytes : seed.chatFilesBytes,
      CHAT_QUOTA_FILES_MAX,
      seed.chatFilesBytes > 0 ? seed.chatFilesBytes : CHAT_DISK_QUOTA_CHAT_DEFAULT,
    ),
    chatBlobsBytes: clampQuotaBytes(
      typeof cur.chatBlobsBytes === 'number' ? cur.chatBlobsBytes : seed.chatBlobsBytes,
      CHAT_QUOTA_BLOBS_MAX,
      seed.chatBlobsBytes > 0 ? seed.chatBlobsBytes : CHAT_DISK_QUOTA_BLOBS_DEFAULT,
    ),
  }
}

/**
 * One-shot v1 -> v2 quota-default upgrade. Only a stored value byte-equal to
 * the pre-v2 default is treated as "never explicitly chosen" and dropped so
 * normalizeMeta re-resolves it from the seed (env override or new default).
 * Runs exclusively on files still stamped v1 (or unstamped), so an Admin who
 * later picks exactly the old numbers keeps them forever.
 */
function migrateLegacyQuotaDefaults(cur: MetaFile): MetaFile {
  const version = typeof cur.schemaVersion === 'number' ? cur.schemaVersion : 1
  if (version >= CHAT_META_SCHEMA_VERSION) return cur
  const next: MetaFile = { ...cur }
  if (next.chatFilesBytes === CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT) delete next.chatFilesBytes
  if (next.chatBlobsBytes === CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT) delete next.chatBlobsBytes
  return next
}

export class ChatMetaStore {
  private readonly metaPath: string
  private readonly chatRoot: string
  private readonly seed: ChatServerMetaSeed
  private cached: ChatServerMeta
  private registryUnreadable = false

  constructor(
    dataDir: string,
    private atRest: AtRestKey | null,
    seed?: Partial<ChatServerMetaSeed>,
  ) {
    this.chatRoot = join(dataDir, 'chat')
    if (!existsSync(this.chatRoot)) mkdirSync(this.chatRoot, { recursive: true })
    this.metaPath = join(this.chatRoot, '_meta.json')
    this.seed = {
      retentionDays: clampRetentionDays(seed?.retentionDays ?? CHAT_RETENTION_DAYS_DEFAULT),
      chatFilesBytes: clampQuotaBytes(
        seed?.chatFilesBytes ?? CHAT_DISK_QUOTA_CHAT_DEFAULT,
        CHAT_QUOTA_FILES_MAX,
        CHAT_DISK_QUOTA_CHAT_DEFAULT,
      ),
      chatBlobsBytes: clampQuotaBytes(
        seed?.chatBlobsBytes ?? CHAT_DISK_QUOTA_BLOBS_DEFAULT,
        CHAT_QUOTA_BLOBS_MAX,
        CHAT_DISK_QUOTA_BLOBS_DEFAULT,
      ),
    }
    this.cached = this.loadOrSeed()
  }

  get(): ChatServerMeta {
    return { ...this.cached }
  }

  getQuotas(): ChatDiskQuotas {
    return {
      chatFilesBytes: this.cached.chatFilesBytes,
      chatBlobsBytes: this.cached.chatBlobsBytes,
    }
  }

  /**
   * Admin patch. Omit a key to leave it unchanged. Returns the live meta after write.
   */
  set(patch: {
    retentionDays?: number
    chatFilesBytes?: number
    chatBlobsBytes?: number
  }  ): ChatServerMeta | { error: string } {
    if (this.registryUnreadable) {
      return {
        error: 'Chat settings could not be loaded. Check the team server data file and the encryption key.',
      }
    }
    if (!patch || typeof patch !== 'object') {
      return { error: 'Invalid chat settings' }
    }
    const next: ChatServerMeta = { ...this.cached }
    if ('retentionDays' in patch && patch.retentionDays !== undefined) {
      const n = Number(patch.retentionDays)
      if (!Number.isFinite(n) || n < CHAT_RETENTION_DAYS_MIN || n > CHAT_RETENTION_DAYS_MAX) {
        return {
          error: `Message retention must be ${CHAT_RETENTION_DAYS_MIN} (keep forever) to ${CHAT_RETENTION_DAYS_MAX} days`,
        }
      }
      next.retentionDays = n === 0 ? 0 : Math.floor(n)
    }
    if ('chatFilesBytes' in patch && patch.chatFilesBytes !== undefined) {
      const n = Number(patch.chatFilesBytes)
      if (!Number.isFinite(n) || n < CHAT_QUOTA_BYTES_MIN || n > CHAT_QUOTA_FILES_MAX) {
        return {
          error: `Chat history storage must be between ${Math.floor(CHAT_QUOTA_BYTES_MIN / (1024 * 1024))} MiB and ${Math.floor(CHAT_QUOTA_FILES_MAX / (1024 * 1024 * 1024))} GiB`,
        }
      }
      next.chatFilesBytes = Math.floor(n)
    }
    if ('chatBlobsBytes' in patch && patch.chatBlobsBytes !== undefined) {
      const n = Number(patch.chatBlobsBytes)
      if (!Number.isFinite(n) || n < CHAT_QUOTA_BYTES_MIN || n > CHAT_QUOTA_BLOBS_MAX) {
        return {
          error: `Chat attachment storage must be between ${Math.floor(CHAT_QUOTA_BYTES_MIN / (1024 * 1024))} MiB and ${Math.floor(CHAT_QUOTA_BLOBS_MAX / (1024 * 1024 * 1024))} GiB`,
        }
      }
      next.chatBlobsBytes = Math.floor(n)
    }
    this.persist(next)
    this.cached = next
    return { ...next }
  }

  private loadOrSeed(): ChatServerMeta {
    if (!existsSync(this.metaPath)) {
      const seeded = normalizeMeta({}, this.seed)
      this.persist(seeded)
      return seeded
    }
    try {
      const raw = readFileSync(this.metaPath, 'utf8')
      const parsed = this.atRest
        ? decryptJsonFile<MetaFile>(this.atRest, raw, null as unknown as MetaFile)
        : (JSON.parse(raw) as MetaFile)
      if (
        parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (parsed as { v?: unknown }).v === 1
        && typeof (parsed as { ciphertext?: unknown }).ciphertext === 'string'
        && !this.atRest
      ) {
        this.registryUnreadable = true
        return normalizeMeta({}, this.seed)
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.registryUnreadable = true
        return normalizeMeta({}, this.seed)
      }
      const cur = parsed
      const version = typeof cur.schemaVersion === 'number' ? cur.schemaVersion : 1
      const next = normalizeMeta(migrateLegacyQuotaDefaults(cur), this.seed)
      // Persist upgraded files so the version stamp makes the migration one-shot.
      if (version < CHAT_META_SCHEMA_VERSION) this.persist(next)
      return next
    } catch {
      this.registryUnreadable = true
      return normalizeMeta({}, this.seed)
    }
  }

  private persist(meta: ChatServerMeta): void {
    if (this.registryUnreadable) return
    const payload: ChatServerMeta = {
      schemaVersion: CHAT_META_SCHEMA_VERSION,
      retentionDays: meta.retentionDays,
      chatFilesBytes: meta.chatFilesBytes,
      chatBlobsBytes: meta.chatBlobsBytes,
    }
    const body = this.atRest
      ? encryptJsonFile(this.atRest, payload)
      : JSON.stringify(payload, null, 2)
    const tmp = `${this.metaPath}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, this.metaPath)
  }
}
