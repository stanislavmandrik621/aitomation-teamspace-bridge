/**
 * TCC-R1134-CMP-021: Yjs rooms had a per-socket room-count cap
 * (`YJS_ROOMS_PER_SOCKET_MAX`) but no cap on the OTHER axis - how many
 * sockets may join ONE room. `fanoutYjsUpdate` / `fanoutYjsAwareness` loop
 * over every peer in the room on every message, so an uncapped room turns a
 * team-wide "everyone opens the same board" moment into unbounded per-message
 * fanout work. `YJS_ROOM_MAX_PEERS` (throughput.ts) + the `joinYjsRoom` gate
 * (server.ts) close that gap. `server.ts` starts a real HTTP+WS server as a
 * module side effect, so the wiring itself is a source-scan pin (same
 * constraint documented in `ws-peer-close.ts` / `yjs-room-flags.ts`); the env
 * default/override behavior of the constant is tested directly here.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')

describe('TCC-R1134-CMP-021 - YJS_ROOM_MAX_PEERS env default/override (throughput.ts)', () => {
  it('defaults to 40 when unset', async () => {
    delete process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS
    const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
    assert.equal(mod.YJS_ROOM_MAX_PEERS, 40)
  })

  it('self-hoster can raise or lower it via env, clamped to [5, 500]', async () => {
    process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS = '120'
    try {
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.equal(mod.YJS_ROOM_MAX_PEERS, 120)
    } finally {
      delete process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS
    }
    process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS = '1'
    try {
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.equal(mod.YJS_ROOM_MAX_PEERS, 5, 'clamped up to the floor')
    } finally {
      delete process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS
    }
    process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS = '999999'
    try {
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.equal(mod.YJS_ROOM_MAX_PEERS, 500, 'clamped down to the ceiling')
    } finally {
      delete process.env.TEAMSPACE_YJS_ROOM_MAX_PEERS
    }
  })
})

describe('TCC-R1134-CMP-021 - joinYjsRoom refuses once a room is at capacity', () => {
  it('checks peers.size against Admin Limits yjsPeerCap (env ceiling fallback) before mutating membership', () => {
    const fnIdx = server.indexOf('function joinYjsRoom(ws: WebSocket, room: string)')
    assert.ok(fnIdx > 0, 'joinYjsRoom exists')
    const fnEnd = server.indexOf('\nfunction ', fnIdx + 10)
    const fn = server.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 1500)
    assert.match(fn, /TCC-R1134-CMP-021/, 'fix is cited inside the function')
    // Admin Limits meta can lower (not raise past env ceiling) via TeamLimitsStore.
    assert.match(
      fn,
      /const yjsPeerCap = limitsStore\.getMeta\(\)\.yjsRoomMaxPeers \|\| YJS_ROOM_MAX_PEERS/,
      'live Admin Limits override with env/hardcoded ceiling fallback',
    )
    assert.match(
      fn,
      /if \(!peers\.has\(ws\) && peers\.size >= yjsPeerCap\)/,
      'refuses new joiners once the room is full (rejoin by an existing peer is never refused)',
    )
    assert.match(fn, /reason: 'Too many people have this document open right now\. Try again shortly\.'/,
      'plain-English refusal copy (no internal jargon)')

    // Order: the per-room capacity check happens BEFORE `mine.add(room)` /
    // `peers.add(ws)` - a refused join must never partially mutate state.
    const capCheckIdx = fn.indexOf('peers.size >= yjsPeerCap')
    const mineAddIdx = fn.indexOf('mine.add(room)')
    const peersAddIdx = fn.indexOf('peers.add(ws)')
    assert.ok(capCheckIdx > 0 && mineAddIdx > capCheckIdx && peersAddIdx > capCheckIdx,
      'capacity check runs before any membership mutation')
  })

  it('imports YJS_ROOM_MAX_PEERS from throughput.ts (env-tunable ceiling, not a magic number)', () => {
    assert.match(server, /import \{[\s\S]*?YJS_ROOM_MAX_PEERS,?[\s\S]*?\} from '\.\/throughput\.js'/)
  })

  it('the per-socket cap (rooms one socket may join) and the per-room cap (sockets one room may hold) are two independent checks', () => {
    const fnIdx = server.indexOf('function joinYjsRoom(ws: WebSocket, room: string)')
    const fnEnd = server.indexOf('\nfunction ', fnIdx + 10)
    const fn = server.slice(fnIdx, fnEnd > fnIdx ? fnEnd : fnIdx + 1500)
    assert.match(fn, /mine\.size >= YJS_ROOMS_PER_SOCKET_MAX/, 'per-socket room-count cap still present')
    assert.match(fn, /peers\.size >= yjsPeerCap/, 'per-room peer-count cap present (Admin Limits)')
  })
})

console.log('yjs-room-peer-cap: ok')
