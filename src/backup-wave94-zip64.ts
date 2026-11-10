/** ZIP64 permits 64-bit sizes; our fs/HTTP Number interfaces require exact integers.
 * PKWARE APPNOTE 6.3.10 §§4.3.9,4.3.14,4.5.3. This is a representation
 * boundary, not a memory budget: payloads continue through file streams.
 */
export const MAX_BACKUP_ZIP64_BYTES_WAVE94 = Number.MAX_SAFE_INTEGER

export function addBackupZip64BytesWave94(current: number, increment: number): number {
  if (!Number.isSafeInteger(current) || current < 0
    || !Number.isSafeInteger(increment) || increment < 0
    || increment > MAX_BACKUP_ZIP64_BYTES_WAVE94 - current) {
    throw new Error('Backup ZIP64 size exceeds exact byte indexing')
  }
  return current + increment
}

/** Validate every offset and the complete wire length before response/output.
 * Name lengths are still unsigned 16-bit ZIP fields; ZIP64 does not widen them.
 * One pass, constant auxiliary space. The caller retains its bounded entry list.
 */
export function measureBackupZip64Wave94(entries: Iterable<{ size: number; nameBuf: { length: number } }>): {
  contentLength: number; totalPayloadBytes: number; centralOffset: number; centralBytes: number
} {
  let totalPayloadBytes = 0, centralOffset = 0, centralBytes = 0
  for (const { size, nameBuf } of entries) {
    if (!Number.isSafeInteger(nameBuf.length) || nameBuf.length < 1 || nameBuf.length > 0xffff) {
      throw new Error('Invalid ZIP entry name length')
    }
    totalPayloadBytes = addBackupZip64BytesWave94(totalPayloadBytes, size)
    // Local header + name + ZIP64 sizes extra + payload + signed data descriptor.
    centralOffset = addBackupZip64BytesWave94(centralOffset, 30 + nameBuf.length + 20 + 24)
    centralOffset = addBackupZip64BytesWave94(centralOffset, size)
    // Central header + name + ZIP64 sizes/offset extra.
    centralBytes = addBackupZip64BytesWave94(centralBytes, 46 + nameBuf.length + 28)
  }
  const contentLength = addBackupZip64BytesWave94(addBackupZip64BytesWave94(centralOffset, centralBytes), 56 + 20 + 22)
  return { contentLength, totalPayloadBytes, centralOffset, centralBytes }
}
