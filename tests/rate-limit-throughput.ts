/**
 * TS-BRG-008 / TS-SHOP-003 / TS-SHOP-004 behavioral: token bucket refuse + prune + backup.
 */
import { TokenBucketLimiter } from '../src/rate-limit.js'
import {
  HELLO_TOKENS_PER_WINDOW,
  INVITE_TOKENS_PER_WINDOW,
  BLOB_TOKENS_PER_WINDOW,
  BACKUP_TOKENS_PER_WINDOW,
  HTTP_TOKENS_PER_WINDOW,
  OPS_FRAME_WINDOW_MS,
} from '../src/throughput.js'

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

{
  const lim = new TokenBucketLimiter()
  const key = 'hello:127.0.0.1'
  let allowed = 0
  for (let i = 0; i < HELLO_TOKENS_PER_WINDOW + 5; i++) {
    if (lim.take(key, HELLO_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)) allowed++
  }
  must(allowed === HELLO_TOKENS_PER_WINDOW, `hello budget exact (${allowed} vs ${HELLO_TOKENS_PER_WINDOW})`)
  must(lim.take(key, HELLO_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS) === false, 'hello over budget refused')
}

{
  must(INVITE_TOKENS_PER_WINDOW >= 5, 'invite budget present')
  must(BLOB_TOKENS_PER_WINDOW >= 10, 'blob budget present')
  must(HTTP_TOKENS_PER_WINDOW >= 10, 'http budget present')
  must(BACKUP_TOKENS_PER_WINDOW >= 5, 'backup budget present')
  const lim = new TokenBucketLimiter()
  for (let i = 0; i < INVITE_TOKENS_PER_WINDOW; i++) {
    must(lim.take('invite:m1', INVITE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS), `invite ${i}`)
  }
  must(lim.take('invite:m1', INVITE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS) === false, 'invite over budget')
}

// TS-SHOP-004: backup take() refuses after budget (same class as hello/invite).
{
  const lim = new TokenBucketLimiter()
  let allowed = 0
  for (let i = 0; i < BACKUP_TOKENS_PER_WINDOW + 5; i++) {
    if (lim.take('backup:sess1', BACKUP_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)) allowed++
  }
  must(allowed === BACKUP_TOKENS_PER_WINDOW, `backup budget exact (${allowed})`)
  must(
    lim.take('backup:sess1', BACKUP_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS) === false,
    'backup over budget refused',
  )
}

// TS-SHOP-003 / MCP-005: at maxKeys, refuse a new live key. Never FIFO-evict.
{
  const lim = new TokenBucketLimiter(50)
  for (let i = 0; i < 50; i++) {
    must(lim.take(`k${i}`, 5, 60_000), `seed ${i}`)
  }
  must(lim.take('k50', 5, 60_000) === false, '51st live refuse')
  must(lim.size() === 50, `size stays 50 (got ${lim.size()})`)
  lim.prune()
  must(lim.size() === 50, 'explicit prune keeps live windows')
}

// G3: peek / waitMsUntilRefill are read-only and report refill wait after refuse.
{
  const lim = new TokenBucketLimiter()
  const key = 'g3:hello'
  const max = 3
  const windowMs = 60_000
  const missing = lim.peek(key, max, windowMs)
  must(missing.tokens === max, 'peek missing key looks full')
  must(missing.waitMs === 0, 'peek missing key waitMs 0')
  must(lim.waitMsUntilRefill(key, max, windowMs) === 0, 'waitMs missing key 0')
  must(lim.size() === 0, 'peek must not insert a bucket')

  must(lim.take(key, max, windowMs), 'take 1')
  must(lim.take(key, max, windowMs), 'take 2')
  const mid = lim.peek(key, max, windowMs)
  must(mid.tokens === 1, `peek remaining after 2 takes (got ${mid.tokens})`)
  must(mid.waitMs > 0 && mid.waitMs <= windowMs, `peek waitMs in window (got ${mid.waitMs})`)
  must(lim.take(key, max, windowMs), 'take 3 last token')
  must(lim.take(key, max, windowMs) === false, 'over budget')

  const refused = lim.peek(key, max, windowMs)
  must(refused.tokens === 0, 'peek tokens 0 after exhaust')
  must(refused.waitMs > 0 && refused.waitMs <= windowMs, `waitMs after refuse (got ${refused.waitMs})`)
  const waitA = lim.waitMsUntilRefill(key, max, windowMs)
  const waitB = lim.waitMsUntilRefill(key, max, windowMs)
  must(Math.abs(waitA - waitB) <= 2, 'waitMsUntilRefill is stable and does not consume')
  must(lim.peek(key, max, windowMs).tokens === 0, 'second peek still 0')
  must(lim.take(key, max, windowMs) === false, 'peek did not refill or consume')
}

{
  const lim = new TokenBucketLimiter()
  const key = 'g3:short'
  const max = 2
  const windowMs = 15
  must(lim.take(key, max, windowMs), 'short take 1')
  must(lim.take(key, max, windowMs), 'short take 2')
  must(lim.take(key, max, windowMs) === false, 'short over budget')
  must(lim.waitMsUntilRefill(key, max, windowMs) > 0, 'short window waitMs > 0')
  const start = Date.now()
  while (Date.now() - start < 20) {
    /* spin until the short window expires */
  }
  must(lim.waitMsUntilRefill(key, max, windowMs) === 0, 'expired window waitMs 0')
  must(lim.peek(key, max, windowMs).tokens === max, 'expired peek looks full')
  must(lim.take(key, max, windowMs) === true, 'take succeeds after refill')
}

// Wave 14 G3: a key with an embedded NUL is REFUSED outright, never
// silently truncated onto another (real) identity's bucket. Truncating
// "hello:127.0.0.1\0junk" down to "hello:127.0.0.1" would let a corrupt or
// hostile identity string consume a totally unrelated caller's own budget
// (TS-HOP-005 class: repairing an unsafe id onto a shared slot is a
// cross-tenant leak). Refusing never even inserts a bucket, so it closes
// the original "mint infinite buckets via NUL-suffix variation" concern at
// least as well as truncating did.
{
  const lim = new TokenBucketLimiter()
  const max = 2
  const windowMs = 60_000
  must(lim.take('hello:127.0.0.1\0junk', max, windowMs) === false, 'NUL key refused outright')
  must(lim.size() === 0, 'a refused NUL key must not mint any bucket at all')
  // The clean identity gets its own full, unaffected budget - a malformed
  // variant of its key must never have spent any of its tokens.
  must(lim.take('hello:127.0.0.1', max, windowMs), 'clean identity take 1 (unaffected by the NUL attempt)')
  must(lim.take('hello:127.0.0.1', max, windowMs), 'clean identity take 2')
  must(lim.take('hello:127.0.0.1', max, windowMs) === false, 'clean identity correctly exhausted at its own budget')
}

// Item 6 (API safety): an over-length key is refused, not truncated -
// truncating two different over-length keys down to the same
// RATE_BUCKET_KEY_MAX prefix would alias two distinct real identities onto
// one shared bucket (same class as the NUL case, TS-HOP-007).
{
  const lim = new TokenBucketLimiter()
  const max = 3
  const windowMs = 60_000
  const longShared = 'x'.repeat(300)
  const keyA = `chatsend:${longShared}AAA`
  const keyB = `chatsend:${longShared}BBB`
  must(keyA.length > 256 && keyB.length > 256, 'fixture keys are actually over the cap')
  must(lim.take(keyA, max, windowMs) === false, 'over-length key A refused')
  must(lim.take(keyB, max, windowMs) === false, 'over-length key B refused')
  must(lim.size() === 0, 'no bucket minted for either over-length key')
  // A key exactly at the boundary is a normal, distinct identity.
  const atBoundary = `y${'z'.repeat(255)}`
  must(atBoundary.length === 256, 'boundary fixture is exactly 256 chars')
  must(lim.take(atBoundary, max, windowMs), 'exactly-256-char key is accepted (not "over")')
}

// Item 3 (per-member fairness): two distinct keys sharing a common literal
// family prefix must never share tokens - one member's burst must only
// ever consume that member's own bucket.
{
  const lim = new TokenBucketLimiter()
  const max = 2
  const windowMs = 60_000
  must(lim.take('chatsend:mem_a', max, windowMs), 'member A token 1')
  must(lim.take('chatsend:mem_a', max, windowMs), 'member A token 2')
  must(lim.take('chatsend:mem_a', max, windowMs) === false, 'member A exhausted')
  // A completely different member sharing the same family prefix must
  // still have its full, independent budget.
  must(lim.take('chatsend:mem_b', max, windowMs), 'member B unaffected by member A burst - token 1')
  must(lim.take('chatsend:mem_b', max, windowMs), 'member B token 2')
  must(lim.take('chatsend:mem_b', max, windowMs) === false, 'member B exhausted at its own budget')
}

// Item 1 (memory bounds / admission control under flood): once the map is
// at cap with every slot LIVE, a large flood of brand-new distinct keys
// must be refused admission every single time, and must never evict - or
// otherwise alter the token count of - any existing live key.
{
  const lim = new TokenBucketLimiter(10)
  for (let i = 0; i < 10; i++) {
    must(lim.take(`seed${i}`, 5, 60_000), `seed live key ${i}`)
  }
  must(lim.take('seed0', 5, 60_000), 'spend seed0 token 2 of 5')
  must(lim.take('seed0', 5, 60_000), 'spend seed0 token 3 of 5')
  const before = lim.peek('seed0', 5, 60_000).tokens
  must(before === 2, `seed0 has exactly 2 tokens left before the flood (got ${before})`)

  let admitted = 0
  for (let i = 0; i < 500; i++) {
    if (lim.take(`flood${i}`, 5, 60_000)) admitted++
  }
  must(admitted === 0, `no flood key was ever admitted while the cap is full of live keys (got ${admitted})`)
  must(lim.size() === 10, `map size stays exactly at the cap - no eviction happened (got ${lim.size()})`)

  const after = lim.peek('seed0', 5, 60_000).tokens
  must(after === 2, `seed0's own remaining tokens are untouched by the flood (got ${after})`)
  for (let i = 0; i < 10; i++) {
    const t = lim.peek(`seed${i}`, 5, 60_000).tokens
    must(t >= 0 && t <= 5, `seed${i} bucket is still present and healthy (tokens=${t})`)
  }
}

// Item 5 (clock safety): an unreadable (NaN) clock reading must fail
// toward refusing every request, must never mutate any bucket, and a
// `peek()` under a NaN clock must report "no budget" rather than "full".
{
  const lim = new TokenBucketLimiter()
  const key = 'clocknan:member'
  const max = 3
  const windowMs = 60_000
  must(lim.take(key, max, windowMs), 'seed one real take before the clock breaks (3 -> 2 remaining)')
  const realNow = Date.now
  try {
    Date.now = () => NaN
    must(lim.take(key, max, windowMs) === false, 'NaN clock refuses take on an existing key')
    must(lim.take('brand-new-key-under-nan-clock', max, windowMs) === false, 'NaN clock refuses a brand-new key too')
    must(lim.size() === 1, 'NaN clock must not mint a bucket for the refused new key')
    const p = lim.peek(key, max, windowMs)
    must(p.tokens === 0, `NaN clock peek reports zero, never "full" (got ${p.tokens})`)
    must(p.waitMs === 0, 'NaN clock peek waitMs is the safe default, not a NaN-derived value')
  } finally {
    Date.now = realNow
  }
  // Once the clock is readable again, the seeded bucket's remaining tokens
  // must be EXACTLY what they were before the NaN window - no silent
  // mutation, no reset, no extra grant.
  must(lim.take(key, max, windowMs), 'first of the 2 remaining tokens survived the NaN window intact')
  must(lim.take(key, max, windowMs), 'second remaining token also intact')
  must(lim.take(key, max, windowMs) === false, 'bucket correctly exhausted at its original 3-token budget')
}

// Items 2/5 (refill correctness + clock safety): a BACKWARD system-clock
// jump must never grant extra tokens beyond the configured budget. It may
// only make the current window last longer (favors refusing), and refill
// must still happen once real elapsed time (from the bucket's own stamped
// `refillAt`) has genuinely passed.
{
  const lim = new TokenBucketLimiter()
  const key = 'clockjump:member'
  const max = 3
  const windowMs = 1_000
  const realNow = Date.now
  let fakeNow = 10_000_000
  Date.now = () => fakeNow
  try {
    must(lim.take(key, max, windowMs), 'clock-jump take 1 of 3')
    must(lim.take(key, max, windowMs), 'clock-jump take 2 of 3')
    must(lim.take(key, max, windowMs), 'clock-jump take 3 of 3')
    must(lim.take(key, max, windowMs) === false, 'exhausted before any clock jump')

    // Jump the clock BACKWARD by an hour. The window must not appear to
    // have advanced early, and no extra tokens beyond the original budget
    // may ever be granted.
    fakeNow -= 60 * 60 * 1000
    must(lim.take(key, max, windowMs) === false, 'backward clock jump must not allow extra tokens')
    must(lim.take(key, max, windowMs) === false, 'still refused after a second backward-jumped attempt')

    // Jump forward past the ORIGINAL refillAt (10_000_000 + 1_000) - a
    // real elapsed-time refill must still occur once that point passes,
    // proving the backward jump only delayed refill, never destroyed it.
    fakeNow = 10_000_000 + windowMs + 1
    must(lim.take(key, max, windowMs), 'refill occurs once real time actually passes the original window')
    must(lim.take(key, max, windowMs), 'fresh window grants exactly the configured budget (2 of 3)')
    must(lim.take(key, max, windowMs), 'fresh window token 3 of 3')
    must(lim.take(key, max, windowMs) === false, 'fresh window still caps at the configured budget, not more')
  } finally {
    Date.now = realNow
  }
}

// Item 4 (high concurrency at scale): take()/peek() on an EXISTING key must
// stay cheap regardless of how many OTHER distinct keys are tracked. A Map
// get/set is O(1); a per-call full-table scan would make this loop's cost
// scale with the tracked-key count and blow well past the generous bound
// below. This is a regression guard against reintroducing an inline O(n)
// scan on the hot admission path.
{
  const lim = new TokenBucketLimiter(60_000)
  const bulkN = 50_000
  for (let i = 0; i < bulkN; i++) {
    lim.take(`bulk${i}`, 5, 60_000)
  }
  must(lim.size() === bulkN, `bulk fill reached the expected tracked-key count (got ${lim.size()})`)

  const hotKey = 'hot:member'
  must(lim.take(hotKey, 1_000_000, 60_000), 'seed the hot key with a large budget')
  const iterations = 20_000
  const start = process.hrtime.bigint()
  for (let i = 0; i < iterations; i++) {
    lim.peek(hotKey, 1_000_000, 60_000)
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000
  const perCallUs = (elapsedMs * 1000) / iterations
  must(
    perCallUs < 20,
    `peek() on a live key stays O(1)-cheap with ${bulkN} other tracked keys `
      + `(avg ${perCallUs.toFixed(3)}us/call over ${iterations} calls - `
      + 'an inline full-table scan would blow past this bound)',
  )
}

console.log('rate-limit-throughput: ok')
