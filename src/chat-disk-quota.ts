/**
 * Team chat disk quotas (files under chat/ + chat-linked blobs).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_DISK_QUOTA_BLOBS_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_DEFAULT,
} from './chat-room.js'

/**
 * Fail-closed sentinel when chat/rooms cannot be measured.
 * Larger than any configured history ceiling, so quota refuses writes.
 */
export const CHAT_FILES_BYTES_UNREADABLE = Number.MAX_SAFE_INTEGER

function isFsMissing(err: unknown): boolean {
  return Boolean(
    err
    && typeof err === 'object'
    && 'code' in err
    && (err as { code: unknown }).code === 'ENOENT',
  )
}

export type ChatDiskQuotas = {
  chatFilesBytes: number
  chatBlobsBytes: number
}

/** Env-only defaults (seed ChatMetaStore on first run). */
export function resolveEnvChatDiskQuotas(): ChatDiskQuotas {
  const filesRaw = Number(process.env.TEAMSPACE_CHAT_DISK_QUOTA_FILES || '')
  const blobsRaw = Number(process.env.TEAMSPACE_CHAT_DISK_QUOTA_BLOBS || '')
  return {
    chatFilesBytes:
      Number.isFinite(filesRaw) && filesRaw > 0
        ? Math.floor(filesRaw)
        : CHAT_DISK_QUOTA_CHAT_DEFAULT,
    chatBlobsBytes:
      Number.isFinite(blobsRaw) && blobsRaw > 0
        ? Math.floor(blobsRaw)
        : CHAT_DISK_QUOTA_BLOBS_DEFAULT,
  }
}

/** Live Admin meta (chat/_meta.json) when bound; else env defaults. */
let liveQuotaResolver: (() => ChatDiskQuotas) | null = null

export function setChatDiskQuotaLiveResolver(
  fn: (() => ChatDiskQuotas) | null,
): void {
  liveQuotaResolver = fn
}

export function resolveChatDiskQuotas(): ChatDiskQuotas {
  if (liveQuotaResolver) {
    try {
      return liveQuotaResolver()
    } catch {
      /* fall through to env */
    }
  }
  return resolveEnvChatDiskQuotas()
}

function measureTreeBytes(root: string, depth = 0): number {
  // Depth cap is fail-closed. Returning 0 here under-counts and lets writes
  // through (quota fail-open). A symlink cycle hits this ceiling.
  if (depth > 12) return CHAT_FILES_BYTES_UNREADABLE
  let rootStat
  try {
    rootStat = statSync(root)
  } catch (err) {
    if (isFsMissing(err)) return 0
    return CHAT_FILES_BYTES_UNREADABLE
  }
  if (!rootStat.isDirectory()) return CHAT_FILES_BYTES_UNREADABLE
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch (err) {
    if (isFsMissing(err)) return 0
    return CHAT_FILES_BYTES_UNREADABLE
  }
  for (const name of names) {
    if (!name || name === '.' || name === '..') continue
    const p = join(root, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) {
        const sub = measureTreeBytes(p, depth + 1)
        if (sub === CHAT_FILES_BYTES_UNREADABLE) return CHAT_FILES_BYTES_UNREADABLE
        total += sub
      } else if (st.isFile()) {
        total += st.size
      }
    } catch (err) {
      if (isFsMissing(err)) continue
      return CHAT_FILES_BYTES_UNREADABLE
    }
  }
  return total
}

/**
 * TCC-R1133-CHAT-002 / TCC-R1132-CHAT-002: this used to walk the WHOLE
 * `chat/` tree (rooms + blobs + avatars + registry) on every call, and
 * `checkQuotaBeforeWrite` in chat-room-history-store.ts calls it on every
 * single send/edit/react/pin/delete - a full recursive readdir+stat walk on
 * the hot path, and it double-counted attachment/avatar bytes into the
 * "chat history storage" quota the Admin UI shows as a SEPARATE knob from
 * "chat attachment storage" (`chatBlobs.totalBlobBytes()`), so raising only
 * the attachment limit never freed the history quota.
 * Fix: scope the measurement to the history-only `chat/rooms` subtree (the
 * same tree the Admin "history" label and the write-path quota both mean),
 * and cache the result for a short TTL so concurrent hot-path writers share
 * one walk instead of paying one each. A short cache window can transiently
 * under-count fresh growth (safe: quota enforcement degrades to "checked at
 * most CHAT_HISTORY_BYTES_CACHE_TTL_MS ago", never a data-loss risk) and is
 * invalidated immediately after `prune()` frees space.
 */
const CHAT_HISTORY_BYTES_CACHE_TTL_MS = 2_000
/** Cap so tests / odd multi-dir processes cannot grow this Map without bound. */
export const CHAT_HISTORY_BYTES_CACHE_MAX = 16
const historyBytesCache = new Map<string, { bytes: number; measuredAt: number }>()

function rememberHistoryBytes(dataDir: string, bytes: number, measuredAt: number): void {
  historyBytesCache.set(dataDir, { bytes, measuredAt })
  if (historyBytesCache.size <= CHAT_HISTORY_BYTES_CACHE_MAX) return
  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [key, row] of historyBytesCache) {
    if (key === dataDir) continue
    if (row.measuredAt < oldestAt) {
      oldestAt = row.measuredAt
      oldestKey = key
    }
  }
  if (oldestKey) historyBytesCache.delete(oldestKey)
}

export function measureChatFilesBytes(dataDir: string): number {
  const now = Date.now()
  const cached = historyBytesCache.get(dataDir)
  if (cached && now - cached.measuredAt < CHAT_HISTORY_BYTES_CACHE_TTL_MS) {
    return cached.bytes
  }
  const bytes = measureTreeBytes(join(dataDir, 'chat', 'rooms'))
  rememberHistoryBytes(dataDir, bytes, now)
  return bytes
}

/** Force a fresh measurement on the next call (e.g. right after `prune()` frees space). */
export function invalidateChatFilesBytesCache(dataDir: string): void {
  historyBytesCache.delete(dataDir)
}

export function measureChatBlobRegistryBytes(dataDir: string): number {
  const reg = join(dataDir, 'chat', 'blob-registry.json')
  try {
    const st = statSync(reg)
    if (!st.isFile()) return CHAT_FILES_BYTES_UNREADABLE
    return st.size
  } catch (err) {
    if (isFsMissing(err)) return 0
    return CHAT_FILES_BYTES_UNREADABLE
  }
}

const CHAT_BLOB_USAGE_ROW_CAP = 100_000

/** Sum registered chat blob bytes (registry tracks attachment puts). */
export function readChatBlobUsageBytes(dataDir: string): number {
  const path = join(dataDir, 'chat', 'blob-registry.json')
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (
      parsed
      && parsed.v === 1
      && typeof parsed.ciphertext === 'string'
    ) {
      // At-rest wrapper. This helper has no key - refuse rather than 0.
      return CHAT_FILES_BYTES_UNREADABLE
    }
    if (Array.isArray(parsed.blobs)) {
      if (parsed.blobs.length > CHAT_BLOB_USAGE_ROW_CAP) return CHAT_FILES_BYTES_UNREADABLE
      let n = 0
      for (const row of parsed.blobs) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue
        const bytes = (row as { bytes?: unknown }).bytes
        if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) continue
        n += Math.floor(bytes)
      }
      return n
    }
    if (typeof parsed.totalBytes === 'number' && Number.isFinite(parsed.totalBytes) && parsed.totalBytes >= 0) {
      return Math.floor(parsed.totalBytes)
    }
    return CHAT_FILES_BYTES_UNREADABLE
  } catch (err) {
    if (isFsMissing(err)) return 0
    return CHAT_FILES_BYTES_UNREADABLE
  }
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${Math.floor(n)} B`
}

export function chatQuotaRefusal(
  kind: 'files' | 'blobs',
  used: number,
  limit: number,
): string {
  if (used >= CHAT_FILES_BYTES_UNREADABLE) {
    return kind === 'files'
      ? 'Chat history storage cannot be checked. New messages are paused until the chat folder can be read.'
      : 'Chat attachment storage cannot be checked. New uploads are paused until the attachment folder can be read.'
  }
  const label = kind === 'files' ? 'chat history' : 'chat attachments'
  return `${label} storage is full (${formatBytes(used)} of ${formatBytes(limit)}). Remove old messages or ask your Admin to raise the limit.`
}
