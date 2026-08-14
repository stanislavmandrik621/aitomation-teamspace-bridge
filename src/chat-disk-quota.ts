/**
 * Team chat disk quotas (files under chat/ + chat-linked blobs).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_DISK_QUOTA_BLOBS_DEFAULT,
  CHAT_DISK_QUOTA_CHAT_DEFAULT,
} from './chat-room.js'

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
  if (!existsSync(root)) return 0
  if (depth > 12) return 0
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  for (const name of names) {
    if (!name || name === '.' || name === '..') continue
    const p = join(root, name)
    try {
      const st = statSync(p)
      if (st.isDirectory()) total += measureTreeBytes(p, depth + 1)
      else if (st.isFile()) total += st.size
    } catch {
      /* skip */
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
/** One entry per bridge process data dir (effectively a single-item cache). */
const historyBytesCache = new Map<string, { bytes: number; measuredAt: number }>()

export function measureChatFilesBytes(dataDir: string): number {
  const now = Date.now()
  const cached = historyBytesCache.get(dataDir)
  if (cached && now - cached.measuredAt < CHAT_HISTORY_BYTES_CACHE_TTL_MS) {
    return cached.bytes
  }
  const bytes = measureTreeBytes(join(dataDir, 'chat', 'rooms'))
  historyBytesCache.set(dataDir, { bytes, measuredAt: now })
  return bytes
}

/** Force a fresh measurement on the next call (e.g. right after `prune()` frees space). */
export function invalidateChatFilesBytesCache(dataDir: string): void {
  historyBytesCache.delete(dataDir)
}

export function measureChatBlobRegistryBytes(dataDir: string): number {
  const reg = join(dataDir, 'chat', 'blob-registry.json')
  if (!existsSync(reg)) return 0
  try {
    const st = statSync(reg)
    return st.isFile() ? st.size : 0
  } catch {
    return 0
  }
}

/** Sum registered chat blob bytes (registry tracks attachment puts). */
export function readChatBlobUsageBytes(dataDir: string): number {
  const path = join(dataDir, 'chat', 'blob-registry.json')
  if (!existsSync(path)) return 0
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as { totalBytes?: number }
    return typeof parsed.totalBytes === 'number' && parsed.totalBytes >= 0
      ? Math.floor(parsed.totalBytes)
      : 0
  } catch {
    return 0
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
  const label = kind === 'files' ? 'chat history' : 'chat attachments'
  return `${label} storage is full (${formatBytes(used)} of ${formatBytes(limit)}). Remove old messages or ask your Admin to raise the limit.`
}
