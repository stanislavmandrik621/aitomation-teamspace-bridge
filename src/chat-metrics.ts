/**
 * In-process chat counters for Admin metrics hooks (log/export via server).
 */

export type ChatMetricsSnapshot = {
  messagesAppended: number
  messagesEdited: number
  messagesDeleted: number
  reactions: number
  roomCreates: number
  historyReads: number
  searchQueries: number
  quotaRefusals: number
  migrations: number
  /** TCC-R1125-CHAT-001: findById resolved via disk fallback (cache miss). */
  findByIdDiskHits: number
  /** TCC-R1125-CHAT-001: disk fallback hit the bounded cross-room scan cap without finding the id. */
  findByIdScanCapped: number
}

const counters: ChatMetricsSnapshot = {
  messagesAppended: 0,
  messagesEdited: 0,
  messagesDeleted: 0,
  reactions: 0,
  roomCreates: 0,
  historyReads: 0,
  searchQueries: 0,
  quotaRefusals: 0,
  migrations: 0,
  findByIdDiskHits: 0,
  findByIdScanCapped: 0,
}

export function bumpChatMetric(key: keyof ChatMetricsSnapshot, n = 1): void {
  if (!Number.isFinite(n) || n <= 0) return
  counters[key] += Math.floor(n)
}

export function snapshotChatMetrics(): ChatMetricsSnapshot {
  return { ...counters }
}

export function resetChatMetricsForTests(): void {
  for (const k of Object.keys(counters) as (keyof ChatMetricsSnapshot)[]) {
    counters[k] = 0
  }
}
