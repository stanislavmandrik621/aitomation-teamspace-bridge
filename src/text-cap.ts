/**
 * Unicode-safe length capping for untrusted text (room titles, filenames,
 * message bodies, passwords) that the team server persists or fans out.
 *
 * A bare `String.slice` cuts UTF-16 code units and can split a surrogate
 * pair (emoji, astral CJK), leaving a lone surrogate that breaks JSON
 * serialization, `encodeURIComponent`, and durable history.
 *
 * This file mirrors `apps/desktop/src/lib/brand/text-cap.ts` byte-for-byte
 * (`capStr` / `capTrim` contract only). The bridge package cannot import
 * across that package boundary (runtime dep is `ws` only). If the desktop
 * leaf's contract ever changes, this file must change too.
 *
 * Bridge `tsconfig` lib is ES2022. `isWellFormed` / `toWellFormed` shipped in
 * ES2024 and are present on Node 20+ (this package's engines floor). The
 * ambient below is local to this file's typecheck and does not raise the
 * package lib target.
 */

declare global {
  interface String {
    isWellFormed(): boolean
    toWellFormed(): string
  }
}

/**
 * Drop a lone lead surrogate left dangling at the end of a slice, so a cut
 * landing mid-pair loses the half character instead of gaining a visible
 * U+FFFD replacement char (what `toWellFormed()` alone would produce).
 */
function dropTrailingLoneSurrogate(s: string): string {
  if (s.length === 0) return s
  const last = s.charCodeAt(s.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s
}

/**
 * Repair the OUTPUT of a cap (TS-CHAT-032/034/042).
 *
 * Being under the cap does not make text safe: untrusted input can arrive with a
 * lone surrogate in it, and skipping the repair when `length <= max` would let
 * short malformed text straight through to durable JSONL, a filename encode, or
 * a hop/team id, while the exact same text one character longer got cleaned.
 * The membership test comes first so a clean string (nearly all of them) is
 * returned as-is with no copy.
 *
 * A trailing lone LEAD surrogate must be DROPPED, not replaced, so a value that
 * arrives already cut at exactly the cap behaves the same as one this function
 * cuts itself (TS-CHAT-042) - `toWellFormed()` alone only swaps it for a visible
 * U+FFFD, which keeps the length unchanged and looks like the repair did nothing.
 */
function repairIfNeeded(s: string): string {
  const dropped = dropTrailingLoneSurrogate(s)
  return dropped.isWellFormed() ? dropped : dropped.toWellFormed()
}

function safeCapLength(max: number): number {
  if (!Number.isFinite(max)) return 0
  const n = Math.floor(max)
  return n > 0 ? n : 0
}

/**
 * Cap `s` to at most `max` UTF-16 units, then repair (TS-CHAT-032/034/042).
 *
 * Lockstep with desktop `brand/text-cap.ts`. The budget is UTF-16 code units,
 * never UTF-8 bytes. Disk/export byte ceilings live elsewhere (TS-CHAT-108).
 * Slice only when over the cap, then ALWAYS run the repair on the output. An
 * early `return s` when `length <= max` is the TS-CHAT-042 hole: already-capped
 * drafts, forwards, and load-normalize still carry a lone surrogate.
 */
export function capStr(s: string, max: number): string {
  const n = safeCapLength(max)
  if (n <= 0) return ''
  if (typeof s !== 'string') return ''
  const cut = s.length <= n ? s : s.slice(0, n)
  return repairIfNeeded(cut)
}

/** Trim, then cap. Returns '' for non-strings so callers can `|| null` it. */
export function capTrim(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return capStr(v.trim(), max)
}

/**
 * One NUL-free identity segment (TS-HOP-003). Strip leading NULs, cut at
 * the first remaining NUL (never join leftover parts), then capTrim.
 */
export function normalizeTeamIdSegment(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return ''
  let s = raw.replace(/^\0+/, '')
  const cut = s.indexOf('\0')
  if (cut >= 0) s = s.slice(0, cut)
  return capTrim(s, max)
}
