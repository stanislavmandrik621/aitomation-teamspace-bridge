/** Snapshot payloads stream through fs/HTTP; exact Number indexing is the bound.
 * Storage quotas and archive-format reader limits are separate caller policies. */
export const MAX_BACKUP_TRANSFER_BYTES_WAVE95 = Number.MAX_SAFE_INTEGER
export function validBackupTransferSizeWave95(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
export function parseBackupTransferLengthWave95(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) return undefined
  const size = Number(value)
  return validBackupTransferSizeWave95(size) ? size : undefined
}
/** Refuse before hashing/writing a chunk which exceeds its authenticated framing. */
export function advanceBackupTransferWave95(current: number, bytes: number, declared: number): number {
  if (!validBackupTransferSizeWave95(declared) || !Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(bytes) || bytes < 0 || current > declared || bytes > declared - current) {
    throw new Error('Backup exceeded declared Content-Length')
  }
  return current + bytes
}
/** Quota totals are exact even near the Number boundary; saturation fails closed. */
export function backupQuotaFitsWave95(limit: number, ...sizes: number[]): boolean {
  if (!validBackupTransferSizeWave95(limit)) return false
  let remaining = limit
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0 || size > remaining) return false
    remaining -= size
  }
  return true
}
export function addBackupStorageBytesWave95(total: number, size: number): number {
  if (!backupQuotaFitsWave95(MAX_BACKUP_TRANSFER_BYTES_WAVE95, total, size)) throw new Error('Backup storage exceeds exact byte indexing')
  return total + size
}
