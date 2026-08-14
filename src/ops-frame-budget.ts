/**
 * BRG-061 / TS-OUT-042: split an ops list so one WS frame stays under the
 * byte ceiling, not only under MAX_OPS_PER_FRAME. A 500-count batch of fat
 * records (SEO-class pages) can exceed WS_MAX_PAYLOAD_BYTES and the server
 * closes the socket; the client then retries the same oversized frame forever.
 */

import { MAX_OPS_PER_FRAME, OPS_FRAME_MAX_BYTES } from './throughput.js'

export { MAX_OPS_PER_FRAME, OPS_FRAME_MAX_BYTES }

export function encodedOpByteLength(op: unknown): number {
  try {
    return JSON.stringify(op).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export function splitOpsForWsFrames<T>(
  ops: T[],
  opts?: { maxCount?: number; maxBytes?: number },
): { frames: T[][]; oversized: T[] } {
  const maxCountRaw = opts?.maxCount ?? MAX_OPS_PER_FRAME
  const maxBytesRaw = opts?.maxBytes ?? OPS_FRAME_MAX_BYTES
  const maxCount = Number.isFinite(maxCountRaw) && maxCountRaw > 0
    ? Math.floor(maxCountRaw)
    : MAX_OPS_PER_FRAME
  const maxBytes = Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
    ? Math.floor(maxBytesRaw)
    : OPS_FRAME_MAX_BYTES
  const frames: T[][] = []
  const oversized: T[] = []
  let current: T[] = []
  let bytes = 2
  for (const op of ops) {
    const encoded = encodedOpByteLength(op)
    if (!Number.isFinite(encoded) || encoded > maxBytes) {
      oversized.push(op)
      continue
    }
    const add = encoded + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && (current.length >= maxCount || bytes + add > maxBytes)) {
      frames.push(current)
      current = []
      bytes = 2
    }
    current.push(op)
    bytes += current.length === 1 ? encoded : add
  }
  if (current.length > 0) frames.push(current)
  return { frames, oversized }
}
