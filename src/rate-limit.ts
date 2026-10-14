/**
 * TS-BRG-008: shared token-bucket rate limiter for hello / invite / blob / HTTP.
 *
 * Every distinct limiter in `server.ts` is one `TokenBucketLimiter` instance
 * shared across every member/IP that hits that budget - the KEY is what
 * keeps one member's burst from spending a different member's allowance,
 * so key hygiene here is a fairness boundary, not just a memory boundary.
 */

const RATE_BUCKET_KEY_MAX = 256

/**
 * Absolute upper bound on `maxKeys` regardless of what a caller constructs
 * with - this class exists specifically to cap unbounded key growth, so a
 * caller mistake (or a future refactor) that passes an enormous `maxKeys`
 * must not silently disable that protection (API-safety: hard to misuse).
 */
const RATE_LIMITER_MAX_KEYS_CEILING = 1_000_000

/**
 * Once the map is at `maxKeys`, a flood of unique new keys would otherwise
 * force a full `prune()` scan on EVERY single admission attempt - on this
 * bridge's one process / one event loop (BRG-069 group) that is exactly the
 * "large cleanup sweep done inline" DoS amplifier: at the default 10,000-key
 * ceiling, a sustained flood of distinct keys can burn a full Map scan per
 * request and starve every other live connection's dispatch latency. This
 * throttle bounds the SELF-TRIGGERED sweep to at most once per interval;
 * the explicit `prune()` the hourly maintenance timer calls is never
 * throttled by this constant. Correctness is unaffected either way - the
 * over-cap refusal below always re-checks `size() >= maxKeys` after the
 * (possibly skipped) prune, so a stale slot just waits at most one
 * interval longer to be reclaimed; a new key is never wrongly admitted.
 */
const AUTO_PRUNE_MIN_INTERVAL_MS = 1_000

type Bucket = {
  tokens: number
  refillAt: number
}

export type TokenBucketPeek = {
  tokens: number
  refillAt: number
  waitMs: number
}

/**
 * Validate (never repair) a caller-supplied key into a bucket identity.
 *
 * REFUSES (returns '') rather than silently normalizing an unsafe key onto
 * a shared bucket - two different real identities that happen to share a
 * common prefix must never collapse onto the same token budget. Concretely:
 *
 *  - An embedded NUL byte is refused outright. Truncating at the NUL (the
 *    pattern used for a human-typed team-id segment, where discarding
 *    "everything after the NUL" is correct because it is a single logical
 *    segment) is the WRONG move for a composite `family:identity` rate key:
 *    the truncated remainder can be a legitimate DIFFERENT caller's own key
 *    in full, so a corrupt or hostile identity string would consume - or
 *    even exhaust - a totally unrelated member's budget. Same class of bug
 *    as an eviction policy dropping a different tenant's live counter
 *    (TS-HOP-005 / TS-HOP-006), just reached via collision instead of
 *    eviction. Refusing never even inserts a bucket, so it cannot grow the
 *    map either - it closes the "mint infinite buckets via NUL-suffix
 *    variation" concern at least as well as truncating did.
 *  - A key longer than `RATE_BUCKET_KEY_MAX` is refused outright rather
 *    than truncated, for the identical reason (TS-HOP-007): two distinct
 *    over-length keys that agree only on their first `RATE_BUCKET_KEY_MAX`
 *    characters must not be repaired onto the same truncated slot.
 *
 * Every real key this bridge mints is a short literal family prefix plus a
 * server-issued memberId or a socket-derived IP address - both are well
 * under this ceiling and contain no NUL, so this never affects real traffic.
 */
function bucketKey(key: string): string {
  if (typeof key !== 'string') return ''
  if (key.length === 0 || key.length > RATE_BUCKET_KEY_MAX) return ''
  if (key.indexOf('\0') >= 0) return ''
  return key
}

/** Family prefix (`chatsend:`) vs exact key. Bare `hello:10.0.0.1` must not match `hello:10.0.0.10`. */
function bucketMatchesPrefix(k: string, prefix: string): boolean {
  if (!prefix) return true
  if (prefix.endsWith(':')) return k.startsWith(prefix)
  return k === bucketKey(prefix)
}

/**
 * `Date.now()` is effectively never NaN on a real Node runtime, but a rate
 * limiter's entire job is failing safely on whatever input/environment it
 * is handed. An unreadable clock reading must push every decision toward
 * REFUSING the request, never toward always-allow (same contract as the
 * hop-ambient clock guard, TS-HOP-007). Returns null when the reading
 * cannot be trusted so every caller can fail closed without doing
 * arithmetic on a NaN deadline.
 */
function safeNow(): number | null {
  const now = Date.now()
  return Number.isFinite(now) ? now : null
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>()
  private readonly maxKeys: number
  private lastAutoPruneAt = 0

  constructor(maxKeys = 10_000) {
    const n = typeof maxKeys === 'number' && Number.isFinite(maxKeys) ? Math.floor(maxKeys) : 10_000
    const bounded = n > 0 ? n : 10_000
    this.maxKeys = Math.min(bounded, RATE_LIMITER_MAX_KEYS_CEILING)
  }

  /** Returns true when the action is allowed (and consumes one token). */
  take(key: string, maxTokens: number, windowMs: number, cost = 1): boolean {
    const k = bucketKey(key)
    const now = safeNow()
    if (
      !k ||
      now === null ||
      !Number.isFinite(maxTokens) ||
      !Number.isFinite(windowMs) ||
      !Number.isFinite(cost) ||
      maxTokens <= 0 ||
      windowMs <= 0 ||
      cost <= 0
    ) {
      // Fail closed: an unreadable clock or a malformed key/budget must
      // never mutate state and must never allow the action through.
      return false
    }
    let b = this.buckets.get(k)
    if (!b || now >= b.refillAt) {
      // New key only: drop idle windows, then refuse if still at cap.
      // Never FIFO-evict a live lockout (MCP-005). Same polarity as a
      // count page that must not drop live work to admit a rotate storm
      // (BRG-061). An expired row for this same key is refreshed in place.
      if (!b) {
        if (this.buckets.size >= this.maxKeys) {
          // Throttled: see AUTO_PRUNE_MIN_INTERVAL_MS. Bounds the cost of
          // a unique-key flood to at most one full scan per interval,
          // never one scan per request.
          if (now - this.lastAutoPruneAt >= AUTO_PRUNE_MIN_INTERVAL_MS) {
            this.lastAutoPruneAt = now
            this.prune()
          }
        }
        if (this.buckets.size >= this.maxKeys) return false
      }
      b = { tokens: maxTokens, refillAt: now + windowMs }
      this.buckets.set(k, b)
    }
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  /**
   * Read remaining tokens / wait without consuming. Missing or expired
   * buckets look full (waitMs 0) and are not inserted.
   */
  peek(key: string, maxTokens: number, windowMs: number): TokenBucketPeek {
    const k = bucketKey(key)
    const now = safeNow()
    if (
      !k ||
      now === null ||
      !Number.isFinite(maxTokens) ||
      !Number.isFinite(windowMs) ||
      maxTokens <= 0 ||
      windowMs <= 0
    ) {
      // Fail closed: an unreadable clock or a malformed key/budget must
      // report "no budget" (tokens 0), never "full" - a peek that looks
      // full on bad input could make a caller skip its own slow-down hint.
      return { tokens: 0, refillAt: 0, waitMs: 0 }
    }
    const b = this.buckets.get(k)
    if (!b || now >= b.refillAt) {
      return { tokens: maxTokens, refillAt: now + windowMs, waitMs: 0 }
    }
    return {
      tokens: b.tokens,
      refillAt: b.refillAt,
      waitMs: Math.max(0, b.refillAt - now),
    }
  }

  /** Milliseconds until this key's window refills. 0 if full or missing. */
  waitMsUntilRefill(key: string, maxTokens: number, windowMs: number): number {
    return this.peek(key, maxTokens, windowMs).waitMs
  }

  /**
   * Drop expired (idle) windows only (BRG-054 / G3 / MCP-005).
   * Insertion-FIFO of live buckets evicts an admin-recovery lockout
   * while spent hello: keys still occupy slots, and a rotate storm
   * resets stamps so the next take looks under budget. No idle slot
   * means take() refuses the new key. Never delete a live window.
   */
  prune(): void {
    const now = safeNow()
    // An unreadable clock must never be treated as "everything is expired" -
    // that would delete live windows. Skip the sweep entirely; buckets stay
    // exactly as they are until the clock is readable again.
    if (now === null) return
    for (const [k, b] of this.buckets) {
      if (now >= b.refillAt) this.buckets.delete(k)
    }
  }

  /**
   * TCC-R1143-LIM-006: after Admin lowers a rate, surplus tokens from the
   * previous higher max would linger until the window refills. Cap every
   * matching key's remaining tokens to `maxTokens` (prefix match optional).
   */
  recap(maxTokens: number, keyPrefix?: string): void {
    if (!(typeof maxTokens === 'number') || !Number.isFinite(maxTokens) || maxTokens < 0) return
    const ceil = Math.floor(maxTokens)
    const prefix = typeof keyPrefix === 'string' ? keyPrefix : ''
    for (const [k, b] of this.buckets) {
      if (prefix && !bucketMatchesPrefix(k, prefix)) continue
      if (b.tokens > ceil) b.tokens = ceil
    }
  }

  /** Drop all buckets (or those matching prefix). */
  clear(keyPrefix?: string): void {
    if (!keyPrefix) {
      this.buckets.clear()
      return
    }
    for (const k of [...this.buckets.keys()]) {
      if (bucketMatchesPrefix(k, keyPrefix)) this.buckets.delete(k)
    }
  }

  /** Test / metrics helper. */
  size(): number {
    return this.buckets.size
  }
}
