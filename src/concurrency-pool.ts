/**
 * Generic bounded-concurrency `Promise.all` replacement.
 *
 * TCC-R1133-WS-001 (twin TCC-R1133-WIN-001): several bridge call sites fan
 * an unbounded `Promise.all` over a list whose size scales with roster/room
 * count (up to thousands), each doing real disk I/O (full file scan +
 * decrypt). With no cap, a reconnect/roster storm can fire hundreds of those
 * scans back-to-back in one microtask burst and stall the single-threaded
 * event loop long enough to starve every other socket on the bridge. This
 * helper processes at most `concurrency` items in flight at a time; the
 * rest queue behind the pool instead of firing all at once - same eventual
 * result, bounded worst-case burst.
 */
function finiteFloorAtLeast1(n: number): number {
  const f = Math.floor(n)
  return Number.isFinite(f) && f >= 1 ? f : 1
}

/**
 * G16 leftover stringify/decrypt must not delay the 30s heartbeat.
 * `await mapper()` only yields a microtask when the mapper is already
 * done (sync decrypt then Promise.resolve). Heartbeat is a macrotask.
 * setImmediate, never worker_threads (BRG-069).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length
  const results: R[] = new Array(n)
  if (n === 0) return results
  // Infinity / NaN must not disable the cap (unbounded Promise.all).
  const limit = finiteFloorAtLeast1(concurrency)
  let nextIndex = 0
  // A rejected mapper used to leave sibling workers claiming the rest of
  // the list (leftover decrypt after the caller already failed).
  let failed = false
  async function worker(): Promise<void> {
    while (true) {
      if (failed) return
      const i = nextIndex
      nextIndex += 1
      if (i >= n) return
      try {
        results[i] = await mapper(items[i] as T, i)
      } catch (err) {
        failed = true
        throw err
      }
      if (failed || i + 1 >= n) return
      await yieldToEventLoop()
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(limit, n); w += 1) {
    workers.push(worker())
  }
  // Promise.all rejects on the first throw and leaves a sibling throw
  // unhandled. The bridge turns unhandledRejection into process exit.
  const settled = await Promise.allSettled(workers)
  const firstReject = settled.find((row): row is PromiseRejectedResult => row.status === 'rejected')
  if (firstReject) throw firstReject.reason
  return results
}

/**
 * TCC-R1144-BRG-002: process-wide semaphore so concurrent `chat_rooms_list`
 * (and similar) callers share one scan budget instead of each opening their
 * own per-request pool of N workers.
 */
export class AsyncSemaphore {
  private available: number
  private readonly max: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.max = finiteFloorAtLeast1(permits)
    this.available = this.max
  }

  async acquire(): Promise<void> {
    if (this.available > 0) {
      this.available -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
      return
    }
    if (this.available < this.max) this.available += 1
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }
}

/**
 * TCC-R1148-BRG-005 / TCC-R1149-BRG-002: try-acquire lease that refuses when
 * all slots are held (HTTP 429 / WS refuse) instead of queueing forever.
 */
export class TrySemaphore {
  private inUse = 0
  private readonly max: number

  constructor(permits: number) {
    // Clamp at construct (same as AsyncSemaphore). Infinity / NaN must
    // not live on `max` for a later reader to treat as "no ceiling".
    this.max = finiteFloorAtLeast1(permits)
  }

  tryAcquire(): boolean {
    if (this.inUse >= this.max) return false
    this.inUse += 1
    return true
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1)
  }
}
