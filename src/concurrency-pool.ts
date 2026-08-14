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
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length
  const results: R[] = new Array(n)
  if (n === 0) return results
  const limit = Math.max(1, Math.floor(concurrency) || 1)
  let nextIndex = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex
      nextIndex += 1
      if (i >= n) return
      results[i] = await mapper(items[i] as T, i)
    }
  }
  const workers: Promise<void>[] = []
  for (let w = 0; w < Math.min(limit, n); w += 1) {
    workers.push(worker())
  }
  await Promise.all(workers)
  return results
}

/**
 * TCC-R1144-BRG-002: process-wide semaphore so concurrent `chat_rooms_list`
 * (and similar) callers share one scan budget instead of each opening their
 * own per-request pool of N workers.
 */
export class AsyncSemaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits) || 1)
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
    this.available += 1
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
  constructor(private readonly max: number) {}

  tryAcquire(): boolean {
    const ceiling = Math.max(1, Math.floor(this.max) || 1)
    if (this.inUse >= ceiling) return false
    this.inUse += 1
    return true
  }

  release(): void {
    this.inUse = Math.max(0, this.inUse - 1)
  }
}
