/**
 * BRG-061 / TS-OUT-042: split an ops list so one WS frame stays under the
 * byte ceiling, not only under MAX_OPS_PER_FRAME. A 500-count batch of fat
 * records (SEO-class pages) can exceed WS_MAX_PAYLOAD_BYTES and the server
 * closes the socket; the client then retries the same oversized frame forever.
 *
 * Byte length is UTF-8 (`Buffer.byteLength`). `JSON.stringify(op).length` is
 * UTF-16 code units, so CJK/emoji pages were under-counted and could still
 * blow the 8 MiB ceiling under concurrent catch-up.
 */

import { MAX_OPS_PER_FRAME, OPS_FRAME_MAX_BYTES } from './throughput.js'

export { MAX_OPS_PER_FRAME, OPS_FRAME_MAX_BYTES }

/** UTF-8 bytes of `[]` around the ops array. A lone op of `maxBytes` is already over. */
export const OPS_FRAME_JSON_WRAPPER_BYTES = 2

export function encodedOpByteLength(op: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(op), 'utf8')
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
  let bytes = OPS_FRAME_JSON_WRAPPER_BYTES
  for (const op of ops) {
    const encoded = encodedOpByteLength(op)
    // Frame is `[op]` (wrapper + encoded), never the bare stringify.
    if (!Number.isFinite(encoded) || encoded + OPS_FRAME_JSON_WRAPPER_BYTES > maxBytes) {
      oversized.push(op)
      continue
    }
    const add = encoded + (current.length > 0 ? 1 : 0)
    if (current.length > 0 && (current.length >= maxCount || bytes + add > maxBytes)) {
      frames.push(current)
      current = []
      bytes = OPS_FRAME_JSON_WRAPPER_BYTES
    }
    current.push(op)
    bytes += current.length === 1 ? encoded : add
  }
  if (current.length > 0) frames.push(current)
  return { frames, oversized }
}
