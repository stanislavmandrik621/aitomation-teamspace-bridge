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

// TS-SHOP-003: prune bounds Map when over maxKeys (via take).
{
  const lim = new TokenBucketLimiter(50)
  for (let i = 0; i < 80; i++) {
    must(lim.take(`k${i}`, 5, 60_000), `seed ${i}`)
  }
  must(lim.size() <= 50, `prune kept size <= 50 (got ${lim.size()})`)
  lim.prune()
  must(lim.size() <= 50, 'explicit prune idempotent')
}

console.log('rate-limit-throughput: ok')
