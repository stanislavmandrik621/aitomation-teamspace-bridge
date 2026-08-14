/**
 * TS-BRG-008: shared token-bucket rate limiter for hello / invite / blob / HTTP.
 */

type Bucket = {
  tokens: number
  refillAt: number
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>()
  private readonly maxKeys: number

  constructor(maxKeys = 10_000) {
    this.maxKeys = maxKeys
  }

  /** Returns true when the action is allowed (and consumes one token). */
  take(key: string, maxTokens: number, windowMs: number, cost = 1): boolean {
    const k = String(key).slice(0, 256)
    if (!k || maxTokens <= 0 || windowMs <= 0 || cost <= 0) return false
    const now = Date.now()
    let b = this.buckets.get(k)
    if (!b || now >= b.refillAt) {
      // TS-SHOP-003: make room before inserting a new key.
      if (!b && this.buckets.size >= this.maxKeys) this.prune()
      b = { tokens: maxTokens, refillAt: now + windowMs }
      this.buckets.set(k, b)
    }
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  /** Drop oldest keys until size < maxKeys (room for one insert). */
  prune(): void {
    while (this.buckets.size >= this.maxKeys) {
      const first = this.buckets.keys().next().value
      if (first === undefined) break
      this.buckets.delete(first)
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
      if (prefix && !k.startsWith(prefix)) continue
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
      if (k.startsWith(keyPrefix)) this.buckets.delete(k)
    }
  }

  /** Test / metrics helper. */
  size(): number {
    return this.buckets.size
  }
}
