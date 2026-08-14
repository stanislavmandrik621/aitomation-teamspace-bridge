/**
 * TCC-R1134-ENT-001: presence had only a clean-disconnect removal path
 * (`dropLiveSession` on the socket's own `close`/`error` events). A member
 * whose device force-quit or lost network without a WS close frame left a
 * half-open TCP socket that neither side would notice for a long time (OS
 * TCP keepalive defaults are hours, often disabled entirely), so their
 * presence row would show "online" forever. The fix adds a server-initiated
 * WS ping/pong heartbeat that terminates any socket that misses one pong
 * cycle, which fires the normal `close` -> `dropLiveSession` presence-leave
 * path exactly as a real disconnect would.
 *
 * `server.ts` starts a real HTTP+WS server as a module side effect, so this
 * is a source-scan pin (same technique as `ws-peer-close.ts` /
 * `server-hardening-pins.ts`) plus a pure-logic unit test of the bounded
 * env constant, rather than a live socket test.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from '../src/throughput.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const throughput = readFileSync(join(root, 'src/throughput.ts'), 'utf8')

describe('TCC-R1134-ENT-001 - server-side WS ping/pong heartbeat reaps ghost presence', () => {
  it('PRESENCE_HEARTBEAT_INTERVAL_MS is a bounded, env-tunable constant (not a magic number)', () => {
    assert.equal(typeof PRESENCE_HEARTBEAT_INTERVAL_MS, 'number')
    assert.ok(Number.isFinite(PRESENCE_HEARTBEAT_INTERVAL_MS) && PRESENCE_HEARTBEAT_INTERVAL_MS > 0)
    assert.equal(PRESENCE_HEARTBEAT_INTERVAL_MS, 30_000, 'default is 30s unless TEAMSPACE_PRESENCE_HEARTBEAT_INTERVAL_MS overrides it')
    assert.match(throughput, /envInt\(\s*\n?\s*'TEAMSPACE_PRESENCE_HEARTBEAT_INTERVAL_MS'/)
  })

  it('pendingHeartbeatAck WeakSet exists and is scoped to the module (no cast/any on the ws socket)', () => {
    assert.match(server, /const pendingHeartbeatAck = new WeakSet<WebSocket>\(\)/)
    assert.doesNotMatch(
      server.slice(server.indexOf('pendingHeartbeatAck'), server.indexOf('pendingHeartbeatAck') + 4000),
      /\bas any\b/,
    )
  })

  it('every new connection registers a pong handler that clears the pending flag', () => {
    const connIdx = server.indexOf("wss.on('connection', (ws, req) => {")
    assert.ok(connIdx > 0, 'connection handler exists')
    const closeIdx = server.indexOf("wss.on('error',", connIdx)
    assert.ok(closeIdx > connIdx, 'wss error listener follows the connection handler')
    const window = server.slice(connIdx, closeIdx)
    assert.match(window, /ws\.on\('pong', \(\) => \{\s*\n\s*pendingHeartbeatAck\.delete\(ws\)/, 'pong clears pending state')
    assert.match(window, /pendingHeartbeatAck\.delete\(ws\)/, 'close handler also clears pending state so the WeakSet cannot accumulate closed sockets')
  })

  it('the heartbeat interval terminates a socket that never answered the previous ping, otherwise pings + marks pending', () => {
    const idx = server.indexOf('const heartbeatInterval = setInterval(')
    assert.ok(idx > 0, 'heartbeatInterval must exist')
    const endIdx = server.indexOf('heartbeatInterval.unref?.()')
    assert.ok(endIdx > idx, 'unref call follows the interval body')
    const block = server.slice(idx, endIdx)
    assert.match(block, /for \(const ws of wss\.clients\)/, 'iterates every live WS client (incl. pre-hello sockets)')
    assert.match(block, /if \(pendingHeartbeatAck\.has\(ws\)\)/, 'checks whether the PREVIOUS ping went unanswered')
    assert.match(block, /ws\.terminate\(\)/, 'terminates (hard close, fires close handler) rather than a graceful ws.close()')
    assert.match(block, /pendingHeartbeatAck\.add\(ws\)/, 'marks every surviving socket pending before the next tick')
    assert.match(block, /ws\.ping\(\)/, 'sends a real WS-protocol ping (not the app-level JSON ping/pong frame)')
    assert.match(block, /PRESENCE_HEARTBEAT_INTERVAL_MS/, 'interval is env-tunable, not hardcoded')
    // The terminate branch must `continue` past the ping branch for that
    // socket - a socket that gets terminated this tick must never also be
    // re-armed as pending in the same pass.
    assert.match(block, /ws\.terminate\(\) \} catch \{ \/\* \*\/ \}\s*\n\s*continue/)
  })

  it('heartbeatInterval is unref-ed (never keeps the process alive on its own) and cleared on graceful shutdown', () => {
    assert.match(server, /heartbeatInterval\.unref\?\.\(\)/)
    const shutdownIdx = server.indexOf('function gracefulShutdown(')
    assert.ok(shutdownIdx > 0, 'gracefulShutdown exists')
    const shutdownEnd = server.indexOf('\n}', shutdownIdx)
    const shutdownBody = server.slice(shutdownIdx, shutdownEnd)
    assert.match(shutdownBody, /clearInterval\(heartbeatInterval\)/, 'graceful shutdown clears the heartbeat interval alongside maintenanceInterval')
  })

  it('terminate() reuses the existing close -> dropLiveSession presence-leave path (no separate presence-removal code)', () => {
    // The connection handler's close listener is the ONLY place dropLiveSession
    // is wired to a raw socket-close event; the heartbeat must not duplicate
    // that logic, it must rely on ws.terminate() firing the same close event.
    const closeHandlerCount = (server.match(/ws\.on\('close', \(\) => \{\s*\n\s*dropLiveSession\(ws\)/g) ?? []).length
    assert.equal(closeHandlerCount, 1, 'exactly one close handler calls dropLiveSession - heartbeat must not add a second one')
    const heartbeatIdx = server.indexOf('const heartbeatInterval = setInterval(')
    const heartbeatEnd = server.indexOf('heartbeatInterval.unref?.()')
    const heartbeatBlock = server.slice(heartbeatIdx, heartbeatEnd)
    assert.doesNotMatch(heartbeatBlock, /dropLiveSession/, 'heartbeat delegates presence cleanup to terminate() -> close, never calls dropLiveSession directly')
  })
})
