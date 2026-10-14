/**
 * BRG-066: serialize a bridge frame once per fan-out, then hand the same
 * string to every peer. `ws.send` takes a string directly - calling a
 * reply helper that stringifies inside the loop costs peers x payload on
 * the single event loop.
 *
 * One-socket paths (capacity refuse, 1:1 reply) use `sendBridgeFrame` so
 * they cannot pass a frame object into `ws.send` and hide a stringify.
 *
 * Stringify is fail-closed: circular / BigInt / a non-string return, and
 * NaN / Infinity anywhere in the payload (JSON would otherwise emit null).
 * Invalid Date and an own `__proto__` getter are the same silent-null class.
 *
 * Backpressure bytes are passed in by the caller. This leaf must not
 * own that ceiling. A non-finite or negative ceiling fail-closes the send
 * (NaN would otherwise disable the bufferedAmount check). The same class
 * applies to a present bufferedAmount: NaN / Infinity / negative must
 * refuse, because `NaN > ceiling` is always false and would send.
 *
 * WS byte ceiling (BRG-061 / TS-OUT-042 twin): refuse when UTF-8
 * `Buffer.byteLength` exceeds the caller ceiling (default
 * `WS_MAX_PAYLOAD_BYTES`). `text.length` is UTF-16 and under-counts CJK.
 * Never slice to fit (that would cut a surrogate and break JSON).
 *
 * `TEAMSPACE_JSON_FINITE_WALK_MAX_DEPTH` (default 64, clamped 8..2048)
 * raises the finite-walk depth cap for self-hosted deployments with
 * legitimately deep record trees, without disabling the cap outright.
 */

import { WS_MAX_PAYLOAD_BYTES } from './throughput.js'

export type BridgeSendSocket = {
  readyState: number
  OPEN?: number
  bufferedAmount?: number
  send: (data: string) => void
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0
}

/** Same clamped-fallback env-int reader as `throughput.ts` (kept local: that module exports no helper, and this leaf must stay a single file to edit). */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * JSON.stringify turns NaN / Infinity into `null` without throwing.
 * A hop, remaining count, or byte length that went non-finite would
 * otherwise ship as null and look like a real frame. Fail closed.
 * Walk first so `JSON.stringify(frame)` stays the one stringify
 * (BRG-066 pin). Cap depth so a hostile nest cannot stall heartbeat.
 * Operator-configurable (self-hosted deployments can carry legitimately
 * deep record trees) - never a bare literal a customer cannot raise.
 */
const JSON_FINITE_WALK_MAX = envInt('TEAMSPACE_JSON_FINITE_WALK_MAX_DEPTH', 64, 8, 2_048)

function assertJsonFinite(value: unknown, seen: WeakSet<object>, depth: number): void {
  if (depth > JSON_FINITE_WALK_MAX) {
    throw new TypeError('bridge frame is not JSON-serializable')
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('bridge frame is not JSON-serializable')
  }
  if (value instanceof Number && !Number.isFinite(value.valueOf())) {
    throw new TypeError('bridge frame is not JSON-serializable')
  }
  // Date#toJSON turns Invalid Date into null (same silent NaN as stringify).
  if (value instanceof Date) {
    let t: number
    try {
      t = value.getTime()
    } catch {
      throw new TypeError('bridge frame is not JSON-serializable')
    }
    if (!Number.isFinite(t)) {
      throw new TypeError('bridge frame is not JSON-serializable')
    }
  }
  if (value == null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  const toJSON = (value as { toJSON?: unknown }).toJSON
  if (typeof toJSON === 'function') {
    let next: unknown
    try {
      next = toJSON.call(value)
    } catch {
      throw new TypeError('bridge frame is not JSON-serializable')
    }
    assertJsonFinite(next, seen, depth + 1)
    return
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonFinite(value[i], seen, depth + 1)
    }
    return
  }
  const rec = value as Record<string, unknown>
  for (const key of Object.keys(rec)) {
    // `Object.keys` only ever yields '__proto__' here when `rec` carries
    // an OWN property of that name (JSON.parse's own-property reviver, or
    // a hand-built frame using defineProperty) - own-property lookup
    // always wins over the inherited `Object.prototype.__proto__`
    // accessor, so `rec[key]` would in fact read the right value too.
    // Go through the descriptor anyway to explicitly separate a data
    // value from a getter/setter shape rather than relying on implicit
    // getter-invocation semantics, and to skip a write-only accessor
    // (`desc.get` undefined) the same way `rec[key]` would read it as
    // undefined - never to dodge a prototype walk that cannot happen.
    if (key === '__proto__') {
      const desc = Object.getOwnPropertyDescriptor(rec, key)
      if (!desc) continue
      if (Object.prototype.hasOwnProperty.call(desc, 'value')) {
        assertJsonFinite(desc.value, seen, depth + 1)
      } else if (typeof desc.get === 'function') {
        let next: unknown
        try {
          next = desc.get.call(value)
        } catch {
          throw new TypeError('bridge frame is not JSON-serializable')
        }
        assertJsonFinite(next, seen, depth + 1)
      }
      continue
    }
    assertJsonFinite(rec[key], seen, depth + 1)
  }
}

/** Same-string fan-out (BRG-066) must not walk UTF-8 once per peer. */
let lastUtf8Text: string | null = null
let lastUtf8Bytes = 0

/** UTF-8 wire size. `string.length` is UTF-16 code units (CJK under-count). */
export function utf8FrameByteLength(text: string): number {
  if (typeof text !== 'string') return Number.POSITIVE_INFINITY
  if (text === lastUtf8Text) return lastUtf8Bytes
  const n = Buffer.byteLength(text, 'utf8')
  lastUtf8Text = text
  lastUtf8Bytes = n
  return n
}

export function serializeBridgeFrame(frame: unknown): string {
  let text: unknown
  try {
    assertJsonFinite(frame, new WeakSet(), 0)
    text = JSON.stringify(frame)
  } catch {
    // Twin of a non-string return: circular / BigInt throw instead of
    // returning undefined. Same fail-closed TypeError either way.
    // NaN / Infinity in the payload throw from the finite walk.
    throw new TypeError('bridge frame is not JSON-serializable')
  }
  if (typeof text !== 'string') {
    throw new TypeError('bridge frame is not JSON-serializable')
  }
  return text
}

export function sendSerializedFrame(
  ws: BridgeSendSocket,
  text: string,
  backpressureBytes: number,
  maxFrameBytes: number = WS_MAX_PAYLOAD_BYTES,
): boolean {
  if (typeof text !== 'string') return false
  if (!isFiniteNonNegative(backpressureBytes)) return false
  if (!isFiniteNonNegative(maxFrameBytes)) return false
  if (utf8FrameByteLength(text) > maxFrameBytes) return false
  if (ws == null || typeof ws !== 'object') return false
  if (typeof ws.send !== 'function') return false
  // Read each duck-typed sample exactly once. `BridgeSendSocket` is a
  // structural type - a real caller can hand in an object whose `OPEN`
  // or `bufferedAmount` is a getter (or a Proxy trap) that is not
  // guaranteed to return the same value twice. Validating one read and
  // then acting on a second, later read is a TOCTOU: the socket could
  // report itself open/under-budget for the check and closed/flooded
  // for the send, or vice versa.
  const openSample = ws.OPEN
  if (openSample != null && !Number.isFinite(openSample)) return false
  const open = typeof openSample === 'number' ? openSample : 1
  if (ws.readyState !== open) return false
  // Present sample must be a usable number. A string / null / NaN
  // would otherwise skip the check (`typeof !== 'number'`).
  const bufferedAmountSample = ws.bufferedAmount
  if (bufferedAmountSample !== undefined) {
    if (!isFiniteNonNegative(bufferedAmountSample)) return false
    if (bufferedAmountSample > backpressureBytes) return false
  }
  try {
    ws.send(text)
    return true
  } catch {
    return false
  }
}

/** 1:1 serialize-then-send. Fan-out loops must serialize once, then call sendSerializedFrame. */
export function sendBridgeFrame(
  ws: BridgeSendSocket,
  frame: unknown,
  backpressureBytes: number,
  maxFrameBytes: number = WS_MAX_PAYLOAD_BYTES,
): boolean {
  try {
    return sendSerializedFrame(ws, serializeBridgeFrame(frame), backpressureBytes, maxFrameBytes)
  } catch {
    return false
  }
}
