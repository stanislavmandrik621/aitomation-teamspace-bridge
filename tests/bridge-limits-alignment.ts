/**
 * Bucket 13 "bridge-limits-alignment" test pins for the R1133/R1134
 * rate-limit / ceiling-alignment backlog:
 *
 * - TCC-R1133-BRG-002 (verify): Portal OTP in-memory Maps stay capped.
 * - TCC-R1133-BRG-003 / TCC-R1133-TLS-003: `TEAMSPACE_MAX_WS_CONNECTIONS`
 *   env override is honored past the old hard-clamped 500.
 * - TCC-R1133-WS-002: `readRecentOps()` coalesces concurrent calls into one
 *   real file scan (reconnect-storm mitigation).
 * - TCC-R1133-WS-003: presence join fanout is coalesced behind a shared
 *   timer instead of one broadcast per hello/redeem.
 * - TCC-R1133-SEC-001: chat attachment/avatar HTTP GET has a member-scoped
 *   rate limit (not only the shared per-IP budget).
 * - TCC-R1134-BRGLIM-001: `yjs_update` / `yjs_awareness` have a per-member
 *   rate limit (previously unbounded despite fanning out to every room peer).
 *
 * `server.ts` starts a real HTTP+WS server as a module side effect, so it
 * cannot be imported directly in a unit test (same constraint documented in
 * `ws-peer-close.ts` / `server-hardening-pins.ts`) - the WS-003/SEC-001/
 * BRGLIM-001 wiring pins below are source-scans; BRG-003/TLS-003 and WS-002
 * are real behavioral tests against `throughput.ts` / `store.ts` directly.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TokenBucketLimiter } from '../src/rate-limit.js'
import { BridgeStore } from '../src/store.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const portalStore = readFileSync(join(root, 'src/portal-store.ts'), 'utf8')

function must(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

describe('TCC-R1133-BRG-002 (verify) - Portal OTP in-memory Maps are cap-swept', () => {
  it('every OTP session Map (request buckets, challenges, unlocks) prunes over the shared soft cap', () => {
    assert.match(portalStore, /const OTP_SESSION_MAP_SOFT_CAP = \d[\d_]*/, 'soft cap constant is finite')
    assert.match(
      portalStore,
      /pruneSessionMapOverCap\(this\.otpRequestBuckets, now, \(v\) => v\.refillAt\)/,
      'otpRequestBuckets is swept',
    )
    assert.match(
      portalStore,
      /pruneSessionMapOverCap\(this\.otpChallenges, now, \(v\) => v\.expiresAt\)/,
      'otpChallenges is swept',
    )
    assert.match(
      portalStore,
      /pruneSessionMapOverCap\(this\.otpUnlocks, Date\.now\(\), \(v\) => v\.expiresAt\)/,
      'otpUnlocks is swept',
    )
  })
})

describe('TCC-R1133-BRG-003 / TCC-R1133-TLS-003 - TEAMSPACE_MAX_WS_CONNECTIONS is no longer hard-clamped to 500', () => {
  it('a self-hoster setting the env var above 500 gets the real value, not a silent 500 clamp', async () => {
    process.env.TEAMSPACE_MAX_WS_CONNECTIONS = '5000'
    try {
      // Cache-busting query so throughput.ts re-reads process.env fresh
      // (module-load-time envInt(), same technique as yjs-room-flags.ts).
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.equal(mod.MAX_LIVE_CONNECTIONS, 5000, 'env value honored above the old 500 clamp')
    } finally {
      delete process.env.TEAMSPACE_MAX_WS_CONNECTIONS
    }
  })

  it('an unset env var defaults to 200 (TCC-R1134-CONC-001: headroom above a 100+ person team out of the box)', async () => {
    delete process.env.TEAMSPACE_MAX_WS_CONNECTIONS
    const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
    assert.equal(mod.MAX_LIVE_CONNECTIONS, 200)
    assert.ok(mod.MAX_LIVE_CONNECTIONS > 100, 'default must clear 100 concurrent people with multi-window/device headroom')
  })

  it('the ceiling itself is generous (>= 10000) so a large self-host can raise it meaningfully', async () => {
    process.env.TEAMSPACE_MAX_WS_CONNECTIONS = '999999'
    try {
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.ok(mod.MAX_LIVE_CONNECTIONS >= 10_000, `ceiling is generous (got ${mod.MAX_LIVE_CONNECTIONS})`)
    } finally {
      delete process.env.TEAMSPACE_MAX_WS_CONNECTIONS
    }
  })
})

describe('TCC-R1133-WS-002 - readRecentOps() coalesces a reconnect-storm into one real scan', () => {
  it('N concurrent calls with the same limit share ONE underlying file scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-ws002-'))
    try {
      const store = new BridgeStore(dir, 21, null)
      store.helloOrBootstrap({ memberId: 'mem_a', deviceId: 'd1', memberEmail: 'a@example.com' })
      for (let i = 0; i < 20; i++) {
        store.appendOp({
          opId: `op_${i}`,
          kind: 'record.update',
          protocolVersion: 1,
          hopCount: 0,
          originDevice: 'd1',
          data: { i },
        } as never)
      }
      const before = store.recentOpsCacheStats()
      const results = await Promise.all(
        Array.from({ length: 25 }, () => store.readRecentOps(10)),
      )
      const after = store.recentOpsCacheStats()
      must(results.every((r) => r.length === 10), 'every concurrent caller got the full result')
      must(
        after.realScans - before.realScans === 1,
        `concurrent storm shared ONE real scan (got ${after.realScans - before.realScans})`,
      )
      must(
        after.sharedHits - before.sharedHits >= 24,
        `remaining 24 calls reused the in-flight/cached scan (got ${after.sharedHits - before.sharedHits})`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a call after the shared-read window expires triggers a fresh real scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-ws002b-'))
    try {
      const store = new BridgeStore(dir, 21, null)
      store.helloOrBootstrap({ memberId: 'mem_a', deviceId: 'd1', memberEmail: 'a@example.com' })
      store.appendOp({
        opId: 'op_x',
        kind: 'record.update',
        protocolVersion: 1,
        hopCount: 0,
        originDevice: 'd1',
        data: {},
      } as never)
      await store.readRecentOps(5)
      const mid = store.recentOpsCacheStats()
      await new Promise((r) => setTimeout(r, 2_100))
      await store.readRecentOps(5)
      const end = store.recentOpsCacheStats()
      must(end.realScans > mid.realScans, 'a call well after the window triggers a fresh scan (not stale forever)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('TCC-R1133-WS-003 - presence join fanout is coalesced (no O(N^2) presence_peer storm)', () => {
  it('schedulePresenceFanoutBroadcast exists and is a debounced setTimeout-based single dispatcher', () => {
    const fnIdx = server.indexOf('function schedulePresenceFanoutBroadcast')
    assert.ok(fnIdx > 0, 'schedulePresenceFanoutBroadcast is defined')
    const docIdx = server.lastIndexOf('/**', fnIdx)
    const fnEndIdx = server.indexOf('\n}\n', fnIdx)
    const withDoc = server.slice(docIdx, fnEndIdx)
    const body = server.slice(fnIdx, fnEndIdx)
    assert.match(withDoc, /TCC-R1133-WS-003/, 'fix is cited on the function')
    assert.match(body, /if \(presenceFanoutTimer\) return/, 'a pending timer short-circuits duplicate scheduling')
    assert.match(body, /setTimeout\(/, 'uses a coalescing timer, not an immediate broadcast')
    assert.match(body, /PRESENCE_JOIN_COALESCE_MS/, 'window is the shared configurable constant')
    assert.match(body, /type: 'presence_snapshot'/, 'fanout is a single full-roster snapshot broadcast')
    assert.match(body, /for \(const \[sock\] of live\)/, 'broadcasts to every live socket in one pass')
  })

  it('hello, invite_redeem, and dropLiveSession all route through the coalesced dispatcher (no direct per-change fanout left)', () => {
    const helloCaseIdx = server.indexOf("case 'hello':")
    const inviteRedeemCaseIdx = server.indexOf("case 'invite_redeem':")
    assert.ok(helloCaseIdx > 0 && inviteRedeemCaseIdx > 0, 'both cases exist')
    const helloNextIdx = server.indexOf("case 'invite_create':", helloCaseIdx)
    const inviteRedeemNextIdx = server.indexOf("case 'set_team_name':", inviteRedeemCaseIdx)
    assert.match(
      server.slice(helloCaseIdx, helloNextIdx),
      /schedulePresenceFanoutBroadcast\(\)/,
      'hello schedules a coalesced presence fanout on new-device join',
    )
    assert.match(
      server.slice(inviteRedeemCaseIdx, inviteRedeemNextIdx),
      /schedulePresenceFanoutBroadcast\(\)/,
      'invite_redeem schedules a coalesced presence fanout on new member join',
    )
    const dropFnIdx = server.indexOf('function dropLiveSession')
    const dropFnNextIdx = server.indexOf('\nfunction ', dropFnIdx + 10)
    assert.match(
      server.slice(dropFnIdx, dropFnNextIdx),
      /schedulePresenceFanoutBroadcast\(\)/,
      'dropLiveSession schedules a coalesced presence fanout on leave',
    )
    // No leftover unbounded per-peer loop fanning a single presence_peer frame.
    assert.doesNotMatch(server, /type: 'presence_peer'/, 'no direct O(N) presence_peer fanout remains')
  })

  it('the newly-connected socket itself still gets an immediate (non-coalesced) snapshot via pushPresenceSnapshot', () => {
    assert.match(server, /function pushPresenceSnapshot/, 'pushPresenceSnapshot still exists for the joining socket')
  })
})

describe('TCC-R1133-SEC-001 - chat attachment/avatar HTTP GET has a member-scoped rate limit', () => {
  it('GET /v1/chat/avatars/:sha checks takeChatAvatarGetToken before serving bytes', () => {
    const routeIdx = server.indexOf('const chatAvatarGet =')
    assert.ok(routeIdx > 0, 'chat avatar GET route exists')
    const nextRouteIdx = server.indexOf('SEC-CHAT-05', routeIdx)
    const window = server.slice(routeIdx, nextRouteIdx)
    assert.match(window, /TCC-R1133-SEC-001/, 'fix is cited at the route')
    assert.match(window, /if \(!takeChatAvatarGetToken\(auth\.member\.memberId\)\)/, 'checks the member-scoped token')
    assert.match(window, /sendJson\(res, 429,/, 'refuses with 429 when the budget is exhausted')
    const authIdx = window.indexOf('authFromReq(req')
    const tokenIdx = window.indexOf('takeChatAvatarGetToken')
    const writeHeadIdx = window.indexOf('res.writeHead(200')
    assert.ok(authIdx > 0 && authIdx < tokenIdx && tokenIdx < writeHeadIdx, 'order: auth -> rate limit -> serve')
  })

  it('GET /v1/chat/blobs/:sha checks takeChatBlobGetToken before serving bytes', () => {
    const routeIdx = server.indexOf('const chatBlobGet =')
    assert.ok(routeIdx > 0, 'chat blob GET route exists')
    const window = server.slice(routeIdx, routeIdx + 1200)
    assert.match(window, /TCC-R1133-SEC-001/, 'fix is cited at the route')
    assert.match(window, /if \(!takeChatBlobGetToken\(auth\.member\.memberId\)\)/, 'checks the member-scoped token')
    assert.match(window, /sendJson\(res, 429,/, 'refuses with 429 when the budget is exhausted')
  })

  it('the GET-side budget is a distinct bucket from the PUT-side upload budget (download bursts do not eat upload quota)', () => {
    assert.match(server, /function takeChatBlobGetToken/, 'dedicated GET helper exists')
    assert.match(server, /function takeChatBlobPutToken/, 'dedicated PUT helper still exists (unchanged)')
    assert.match(server, /chatLimiter\.take\(`chatblobget:\$\{memberId\}`/, 'GET uses its own key namespace')
  })
})

describe('TCC-R1134-BRGLIM-001 - yjs_update/yjs_awareness get a per-member rate limit (new finding)', () => {
  it('YJS_UPDATE_TOKENS_PER_SEC / YJS_AWARENESS_TOKENS_PER_SEC are sane and awareness >= update', async () => {
    const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
    must(mod.YJS_UPDATE_TOKENS_PER_SEC >= 5, 'update budget present and non-trivial')
    must(mod.YJS_AWARENESS_TOKENS_PER_SEC >= 5, 'awareness budget present and non-trivial')
    must(
      mod.YJS_AWARENESS_TOKENS_PER_SEC >= mod.YJS_UPDATE_TOKENS_PER_SEC,
      'awareness (cursor/presence) budget is at least as generous as content updates',
    )
  })

  it('a TokenBucketLimiter using these budgets refuses once the per-second budget is exhausted', async () => {
    const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
    const lim = new TokenBucketLimiter()
    let allowed = 0
    for (let i = 0; i < mod.YJS_UPDATE_TOKENS_PER_SEC + 10; i++) {
      if (lim.take('yjsupd:mem_a', mod.YJS_UPDATE_TOKENS_PER_SEC, 1_000)) allowed++
    }
    assert.equal(allowed, mod.YJS_UPDATE_TOKENS_PER_SEC, 'exact budget honored before refusing')
    assert.equal(
      lim.take('yjsupd:mem_a', mod.YJS_UPDATE_TOKENS_PER_SEC, 1_000),
      false,
      'over-budget calls are refused',
    )
  })

  it('yjs_update and yjs_awareness cases both check their token before fanning out, using a distinct limiter namespace', () => {
    const updateCaseIdx = server.indexOf("case 'yjs_update':")
    const awarenessCaseIdx = server.indexOf("case 'yjs_awareness':")
    assert.ok(updateCaseIdx > 0 && awarenessCaseIdx > 0, 'both cases exist')
    const updateWindow = server.slice(updateCaseIdx, awarenessCaseIdx)
    const presenceGetIdx = server.indexOf("case 'presence_get':")
    const awarenessWindow = server.slice(awarenessCaseIdx, presenceGetIdx)

    assert.match(updateWindow, /TCC-R1134-BRGLIM-001/, 'fix is cited in yjs_update')
    assert.match(updateWindow, /if \(!takeYjsUpdateToken\(session\.memberId\)\)/, 'yjs_update checks its token')
    const updateTokenIdx = updateWindow.indexOf('takeYjsUpdateToken')
    const updateFanoutIdx = updateWindow.indexOf('fanoutYjsUpdate(')
    assert.ok(updateTokenIdx > 0 && updateTokenIdx < updateFanoutIdx, 'rate limit runs before the fanout')

    assert.match(awarenessWindow, /TCC-R1134-BRGLIM-001/, 'fix is cited in yjs_awareness')
    assert.match(awarenessWindow, /if \(!takeYjsAwarenessToken\(session\.memberId\)\)/, 'yjs_awareness checks its token')
    const awarenessTokenIdx = awarenessWindow.indexOf('takeYjsAwarenessToken')
    const awarenessFanoutIdx = awarenessWindow.indexOf('fanoutYjsAwareness(')
    assert.ok(awarenessTokenIdx > 0 && awarenessTokenIdx < awarenessFanoutIdx, 'rate limit runs before the fanout')

    assert.match(server, /yjsLimiter\.take\(`yjsupd:\$\{memberId\}`/, 'update uses its own key namespace')
    assert.match(server, /yjsLimiter\.take\(`yjsaware:\$\{memberId\}`/, 'awareness uses its own key namespace')
  })

  it('yjsLimiter (and the pre-existing chatLimiter) are pruned on the same periodic maintenance schedule as every other limiter', () => {
    const maintIdx = server.indexOf('helloLimiter.prune()')
    assert.ok(maintIdx > 0, 'maintenance block exists')
    const window = server.slice(maintIdx, maintIdx + 600)
    assert.match(window, /inviteLimiter\.prune\(\)/)
    assert.match(window, /blobLimiter\.prune\(\)/)
    assert.match(window, /backupLimiter\.prune\(\)/)
    assert.match(window, /httpLimiter\.prune\(\)/)
    assert.match(window, /yjsLimiter\.prune\(\)/, 'new yjsLimiter is pruned too (unbounded-key-growth guard)')
    assert.match(window, /chatLimiter\.prune\(\)/, 'pre-existing chatLimiter now also gets a periodic prune')
  })
})

console.log('bridge-limits-alignment: ok')
