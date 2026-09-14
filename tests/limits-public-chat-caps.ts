/**
 * TCC-R1143-LIM: public chat caps + effective ceilings + rate recap.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TeamLimitsStore,
  LIMITS_META_CEILINGS,
  LIMITS_META_PUBLIC_KEYS,
} from '../src/limits-store.js'
import { TokenBucketLimiter } from '../src/rate-limit.js'
import { MAX_LIVE_CONNECTIONS, YJS_ROOM_MAX_PEERS } from '../src/throughput.js'
import { readFileSync } from 'node:fs'

const dir = mkdtempSync(join(tmpdir(), 'ts-lim-pub-'))
try {
  const store = new TeamLimitsStore(dir)
  const pub = store.getPublicChatCaps()
  assert.equal(pub.voiceMessageMaxSec, 300)
  assert.equal(pub.chatEditWindowSec, 1800)
  assert.deepEqual([...LIMITS_META_PUBLIC_KEYS].sort(), ['chatEditWindowSec', 'voiceMessageMaxSec'].sort())

  const eff = store.getEffective()
  assert.equal(
    eff.ceilings.maxLiveConnections,
    Math.min(LIMITS_META_CEILINGS.maxLiveConnections, MAX_LIVE_CONNECTIONS),
  )
  assert.equal(
    eff.ceilings.yjsRoomMaxPeers,
    Math.min(LIMITS_META_CEILINGS.yjsRoomMaxPeers, YJS_ROOM_MAX_PEERS),
  )

  // LIM-010: heal OOB disk values on ensure/construct.
  writeFileSync(join(dir, 'config', '_limits.json'), JSON.stringify({
    schemaVersion: 1,
    chatEditWindowSec: 1,
    voiceMessageMaxSec: 99999,
  }), 'utf8')
  const healed = new TeamLimitsStore(dir)
  assert.equal(healed.getMeta().chatEditWindowSec, 60)
  assert.equal(healed.getMeta().voiceMessageMaxSec, 1800)

  const lim = new TokenBucketLimiter()
  assert.equal(lim.take('chatsend:a', 30, 60_000), true)
  // Drain most tokens then lower max - surplus must recap.
  for (let i = 0; i < 20; i++) lim.take('chatsend:a', 30, 60_000)
  lim.recap(5, 'chatsend:')
  // After recap to 5 with ~9 left from 30-21... actually we took 21 times from 30 = 9 left, recap to 5.
  assert.equal(lim.take('chatsend:a', 5, 60_000), true)
  assert.equal(lim.take('chatsend:a', 5, 60_000), true)
  assert.equal(lim.take('chatsend:a', 5, 60_000), true)
  assert.equal(lim.take('chatsend:a', 5, 60_000), true)
  assert.equal(lim.take('chatsend:a', 5, 60_000), true)
  assert.equal(lim.take('chatsend:a', 5, 60_000), false)

  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  assert.match(server, /getPublicChatCaps/)
  assert.match(server, /chatLimiter\.recap/)
  assert.match(server, /public: true/)
  assert.match(server, /clampedKeys/)

  console.log('limits-public-chat-caps: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
