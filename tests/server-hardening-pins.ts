/**
 * Source-scan pins for TCC-R1125-WS-001, TCC-R1133-WS-001, and
 * TCC-R1133-BRG-001. `server.ts` starts a real HTTP+WS server as a module
 * side effect, so it cannot be imported directly in a unit test - same
 * constraint documented in `ws-peer-close.ts`. These pins fail loudly if the
 * fixed code path is ever deleted, reordered, or replaced with a weaker
 * check.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const budgetLeaf = readFileSync(join(root, 'src/http-body-budget.ts'), 'utf8')

describe('TCC-R1125-WS-001 - yjs_join enforces server-side feature-flag ACL before joining', () => {
  it('yjs_join checks the room-type feature flag AFTER parsing the room and BEFORE joinYjsRoom', () => {
    const caseIdx = server.indexOf("case 'yjs_join':")
    assert.ok(caseIdx > 0, 'yjs_join case exists')
    const nextCaseIdx = server.indexOf("case 'yjs_leave':", caseIdx)
    assert.ok(nextCaseIdx > caseIdx, 'next case follows yjs_join')
    const window = server.slice(caseIdx, nextCaseIdx)
    assert.match(window, /TCC-R1125-WS-001/, 'fix is cited inside the case')

    const parseIdx = window.indexOf('parseYjsRoomId(frame.room)')
    const flagCheckIdx = window.indexOf('isYjsComposeRecordId(parsed.recordId)')
    const joinIdx = window.indexOf('joinYjsRoom(ws, parsed.room)')
    assert.ok(parseIdx > 0, 'parses the room id first')
    assert.ok(flagCheckIdx > parseIdx, 'the feature-flag classification runs after parsing the room')
    assert.ok(joinIdx > flagCheckIdx, 'joinYjsRoom only runs after the feature-flag gate')

    assert.match(
      window,
      /const roomEnabled = isYjsComposeRecordId\(parsed\.recordId\)\s*\n\s*\?\s*TEAMSPACE_YJS_COMPOSE_ENABLED\s*\n\s*:\s*TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED/,
      'selects the Compose vs Doc/Whiteboard flag based on the room record id',
    )
    assert.match(window, /if \(!roomEnabled\) \{/, 'refuses when the matching flag is off')
    assert.match(window, /type: 'yjs_refuse'/, 'refusal uses the standard yjs_refuse frame')

    // Refusal branch must return before reaching joinYjsRoom (fail-closed,
    // not fall-through).
    const refuseBlockStart = window.indexOf('if (!roomEnabled) {')
    const refuseBlockEnd = window.indexOf('return', refuseBlockStart)
    assert.ok(refuseBlockStart > 0 && refuseBlockEnd > refuseBlockStart, 'refusal branch returns')
    assert.ok(refuseBlockEnd < joinIdx, 'refusal return happens before joinYjsRoom is ever reached')
  })

  it('imports the shared flag/classifier symbols from throughput.ts and yjs-room.ts (no local re-implementation)', () => {
    assert.match(server, /TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED,?\s*\n?\s*TEAMSPACE_YJS_COMPOSE_ENABLED/)
    assert.match(server, /import \{[\s\S]*?isYjsComposeRecordId[\s\S]*?\} from '\.\/yjs-room\.js'/)
  })
})

describe('TCC-R1133-WS-001 - chat_rooms_list scans rooms through a bounded concurrency pool', () => {
  it('replaces the unbounded Promise.all fan-out with mapWithConcurrency(baseRooms, CHAT_ROOMS_LIST_SCAN_CONCURRENCY, ...)', () => {
    const caseIdx = server.indexOf("case 'chat_rooms_list':")
    assert.ok(caseIdx > 0, 'chat_rooms_list case exists')
    const nextCaseIdx = server.indexOf("case 'chat_room_create':", caseIdx)
    assert.ok(nextCaseIdx > caseIdx, 'next case follows chat_rooms_list')
    const window = server.slice(caseIdx, nextCaseIdx)
    assert.match(window, /TCC-R1133-WS-001/, 'fix is cited inside the case')
    assert.match(
      window,
      /mapWithConcurrency\(baseRooms, CHAT_ROOMS_LIST_SCAN_CONCURRENCY, async \(r\) => \{/,
      'fans out through the bounded pool, not Promise.all',
    )
    assert.doesNotMatch(window, /Promise\.all\(\s*baseRooms\.map/, 'no unbounded Promise.all over baseRooms remains')
    assert.match(window, /await chatStore\.readRecent\(r\.id, 51\)/, 'still reads recent messages per room (TCC-R1148-CHAT-010 honesty probe past the 50-row badge page)')
  })

  it('imports mapWithConcurrency from the dedicated concurrency-pool module', () => {
    assert.match(
      server,
      /import \{ mapWithConcurrency(?:, AsyncSemaphore, TrySemaphore)? \} from '\.\/concurrency-pool\.js'/,
    )
  })

  it('CHAT_ROOMS_LIST_SCAN_CONCURRENCY is sourced from throughput.ts (env-tunable, not a magic number)', () => {
    const importIdx = server.indexOf('CHAT_ROOMS_LIST_SCAN_CONCURRENCY,')
    assert.ok(importIdx > 0 && importIdx < server.indexOf("case 'chat_rooms_list':"), 'imported before use')
  })
})

describe('TCC-R1133-BRG-001 - process-wide HTTP body budget bounds concurrent upload heap', () => {
  it('readBodyBytes and readJsonBody both reserve against the shared budget before buffering', () => {
    assert.match(server, /function readBodyBytes\(/)
    assert.match(server, /function readJsonBody\(/)
    const bytesIdx = server.indexOf('function readBodyBytes(')
    const jsonIdx = server.indexOf('function readJsonBody(')
    const bytesFn = server.slice(bytesIdx, jsonIdx)
    // TCC-R1145-BRG-001 / TCC-R1146-BRG-005: reserve may be CL-sized (`reserve`), held until caller release().
    assert.match(bytesFn, /tryReserveHttpBodyBudget\(reserve, opts\?\.memberId\)/, 'readBodyBytes reserves budget up front')
    assert.match(bytesFn, /if \(!reserved\.ok\)/, 'readBodyBytes refuses on leaf result')
    assert.match(bytesFn, /status: 503/, 'readBodyBytes signals 503 on budget exhaustion')
    assert.match(bytesFn, /httpBodyBudgetRefuseMessage\(reserved\.kind\)/, 'distinct 503 by refuse kind')
    assert.match(bytesFn, /retryAfterSec: HTTP_BODY_BUDGET_RETRY_AFTER_SEC/, 'includes a retry-after hint')
    assert.match(bytesFn, /releaseHttpBodyBudget\(reserve, opts\?\.memberId\)/, 'releases the reservation on a terminal path')
    assert.match(bytesFn, /resolve\(\{ bytes: sink\.toUint8Array\(\), release \}\)/, 'holds until caller release')

    assert.match(server, /jsonBodyReleases/, 'JSON body holds reservation past socket end')
    assert.match(server, /function releaseJsonBody\(/, 'callers can explicitly release JSON body budget')
    assert.match(
      server.slice(jsonIdx, jsonIdx + 2500),
      /tryReserveHttpBodyBudget\(reserve, opts\?\.memberId\)[\s\S]*?reject\(new HttpBodyBudgetExhaustedError\(HTTP_BODY_BUDGET_RETRY_AFTER_SEC, reserved\.kind\)\)/,
      'readJsonBody rejects with the budget-exhausted error up front',
    )
  })

  it('the process-wide counter is bounded by MAX_INFLIGHT_HTTP_BODY_BYTES sourced from throughput.ts (env-tunable)', () => {
    assert.match(budgetLeaf, /import \{[\s\S]*?MAX_INFLIGHT_HTTP_BODY_BYTES,?[\s\S]*?\} from '\.\/throughput\.js'/)
    assert.match(
      budgetLeaf,
      /if \(processUsed \+ bytes > MAX_INFLIGHT_HTTP_BODY_BYTES\)/,
      'reservation is refused once the shared ceiling would be exceeded',
    )
  })

  it('release is clamped at 0 so a defensive double-release cannot silently widen the budget', () => {
    assert.match(
      budgetLeaf,
      /processUsed = Math\.max\(0, processUsed - bytes\)/,
    )
  })

  it('the top-level handleHttp catch maps a budget-exhausted rejection to 503 + Retry-After (not the generic 500)', () => {
    const idx = server.indexOf('void handleHttp(req, res).catch((err) => {')
    assert.ok(idx > 0, 'top-level handleHttp catch exists')
    const window = server.slice(idx, idx + 1200)
    assert.match(window, /TCC-R1133-BRG-001/)
    assert.match(window, /if \(err instanceof HttpBodyBudgetExhaustedError\) \{/)
    assert.match(window, /res\.setHeader\('Retry-After', String\(err\.retryAfterSec\)\)/)
    assert.match(window, /sendJson\(res, err\.status, \{ ok: false, error: err\.message \}\)/)
    // Falls through to the generic 500 only for non-budget errors.
    const budgetBlockEnd = window.indexOf('return', window.indexOf('if (err instanceof HttpBodyBudgetExhaustedError) {'))
    const genericIdx = window.indexOf('sendJson(res, 500,')
    assert.ok(genericIdx > budgetBlockEnd, 'generic 500 stays as the fallback for real server errors')
  })

  it('per-route catch blocks route through sendCatchError / sendBodyBytesError instead of a bare generic 400', () => {
    const sendCatchCount = (server.match(/sendCatchError\(res, err\)/g) ?? []).length
    const sendBodyBytesCount = (server.match(/sendBodyBytesError\(res, body\)/g) ?? []).length
    assert.ok(sendCatchCount >= 8, `expected many call sites routed through sendCatchError, found ${sendCatchCount}`)
    assert.ok(sendBodyBytesCount >= 2, `expected readBodyBytes call sites routed through sendBodyBytesError, found ${sendBodyBytesCount}`)
  })
})

describe('TCC-R1134-BRG-001 - wss/server-level "error" events are non-fatal', () => {
  it('the WebSocketServer and the underlying HTTP(S) Server both have an error listener', () => {
    assert.match(
      server,
      /wss\.on\('error', \(err\) => \{\s*\n\s*console\.error\('\[bridge\] WebSocket server error \(non-fatal - other connections keep serving\)', err\)\s*\n\s*\}\)/,
      'wss.on(\'error\', ...) logs and does not exit/throw',
    )
    assert.match(
      server,
      /server\.on\('error', \(err\) => \{\s*\n\s*console\.error\('\[bridge\] HTTP server error \(non-fatal - other connections keep serving\)', err\)\s*\n\s*\}\)/,
      'server.on(\'error\', ...) logs and does not exit/throw',
    )
  })

  it('both server-level error listeners are registered before the process ever starts listening (installed once, not per-request)', () => {
    const wssErrIdx = server.indexOf("wss.on('error',")
    const serverErrIdx = server.indexOf("server.on('error',")
    const listenIdx = server.indexOf('server.listen(PORT, BIND_HOST')
    assert.ok(wssErrIdx > 0 && serverErrIdx > wssErrIdx, 'wss error listener registered before server error listener')
    assert.ok(listenIdx > serverErrIdx, 'both error listeners exist before server.listen() is called')
  })
})

describe('TCC-R1134-BRG-002 - graceful SIGTERM/SIGINT shutdown drains live connections', () => {
  it('gracefulShutdown notifies + cleanly closes every live WS socket before stopping the servers', () => {
    const fnIdx = server.indexOf('function gracefulShutdown(signal: string, exitCode = 0): void {')
    assert.ok(fnIdx > 0, 'gracefulShutdown exists with a defaulted exitCode param')
    const fnEnd = server.indexOf('\nprocess.on(\'SIGTERM\'', fnIdx)
    assert.ok(fnEnd > fnIdx, 'function body precedes signal registration')
    const fn = server.slice(fnIdx, fnEnd)

    assert.match(fn, /if \(shuttingDown\) return/, 'idempotent - a second signal during drain is a no-op')
    assert.match(fn, /shuttingDown = true/, 'flips the guard before any async work')
    assert.match(fn, /clearInterval\(maintenanceInterval\)/, 'stops the hourly maintenance timer so it cannot fire mid-shutdown')

    // TCC-R1144-BRG-004: drain every wss.clients entry (incl. pre-auth), not only `live`.
    const closeLoopIdx = fn.indexOf('for (const ws of wss.clients) {')
    const wssCloseIdx = fn.indexOf('try { wss.close() } catch')
    const serverCloseIdx = fn.indexOf('server.close(() => {')
    assert.ok(closeLoopIdx > 0, 'iterates every wss.clients socket (live + pre-auth)')
    assert.ok(wssCloseIdx > closeLoopIdx, 'stops accepting new WS upgrades only AFTER existing sockets are notified/closed')
    assert.ok(serverCloseIdx > wssCloseIdx, 'stops the HTTP(S) server (letting in-flight requests finish) after wss.close()')

    assert.match(fn, /ws\.close\(1001, 'server restarting'\)/, 'closes each live socket with a real close code, not an abrupt reset')
    assert.match(fn, /const forceExitTimer = setTimeout\(/, 'a stuck keep-alive connection cannot wedge shutdown forever')
    assert.match(fn, /forceExitTimer\.unref\?\.\(\)/, 'the force-exit timer itself never keeps the process alive if drain finishes first')
    assert.match(fn, /clearTimeout\(forceExitTimer\)/, 'the force-exit timer is cleared once server.close() actually completes')

    // TCC-R1134-BRG-004: every terminal exit inside the drain must honor the
    // caller-supplied exit code (not a hardcoded 0), so a crash-triggered
    // drain still reports non-zero to a process supervisor.
    assert.match(fn, /process\.exit\(exitCode\)/, 'forceExitTimer exits with the caller-supplied code')
    const exitCalls = (fn.match(/process\.exit\(exitCode\)/g) ?? []).length
    assert.strictEqual(exitCalls, 3, 'all three terminal exit points (force-timer, close callback, close-throw catch) use exitCode, none hardcode 0/1')
  })

  it('SIGTERM and SIGINT are the only signal listeners server.ts registers, both wired to gracefulShutdown', () => {
    assert.match(server, /process\.on\('SIGTERM', \(\) => gracefulShutdown\('SIGTERM'\)\)/)
    assert.match(server, /process\.on\('SIGINT', \(\) => gracefulShutdown\('SIGINT'\)\)/)
  })

  it('GRACEFUL_SHUTDOWN_TIMEOUT_MS is clamped to a sane bounded range (never 0, never unbounded)', () => {
    assert.match(
      server,
      /const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Math\.max\(\s*1_000,\s*Math\.min\(60_000, Number\(process\.env\.TEAMSPACE_SHUTDOWN_TIMEOUT_MS \|\| 5_000\) \|\| 5_000\),\s*\)/,
    )
  })
})

describe('TCC-R1134-BRG-004 - uncaughtException/unhandledRejection drain instead of hard process.exit', () => {
  it('both handlers call gracefulShutdown(..., 1) instead of a bare process.exit(1)', () => {
    const uncaughtIdx = server.indexOf("process.on('uncaughtException', (err) => {")
    assert.ok(uncaughtIdx > 0, 'uncaughtException handler exists')
    const rejectionIdx = server.indexOf("process.on('unhandledRejection', (err) => {", uncaughtIdx)
    assert.ok(rejectionIdx > uncaughtIdx, 'unhandledRejection handler follows uncaughtException')
    const maintenanceIdx = server.indexOf('const maintenanceInterval = setInterval(', rejectionIdx)
    assert.ok(maintenanceIdx > rejectionIdx, 'maintenance interval follows both handlers')

    const uncaughtWindow = server.slice(uncaughtIdx, rejectionIdx)
    const rejectionWindow = server.slice(rejectionIdx, maintenanceIdx)

    assert.match(uncaughtWindow, /console\.error\('\[bridge\] uncaughtException', err\)/)
    assert.match(uncaughtWindow, /gracefulShutdown\('uncaughtException', 1\)/, 'routes through the same bounded drain as a real signal, exit code 1 preserved')
    assert.doesNotMatch(uncaughtWindow, /process\.exit\(1\)/, 'no longer bypasses the drain with a bare process.exit(1)')

    assert.match(rejectionWindow, /console\.error\('\[bridge\] unhandledRejection', err\)/)
    assert.match(rejectionWindow, /gracefulShutdown\('unhandledRejection', 1\)/, 'routes through the same bounded drain, exit code 1 preserved')
    assert.doesNotMatch(rejectionWindow, /process\.exit\(1\)/, 'no longer bypasses the drain with a bare process.exit(1)')
  })

  it('gracefulShutdown is declared as a hoisted function (safe to call before its textual definition from the earlier handlers)', () => {
    const uncaughtIdx = server.indexOf("process.on('uncaughtException', (err) => {")
    const fnIdx = server.indexOf('function gracefulShutdown(signal: string, exitCode = 0): void {')
    assert.ok(uncaughtIdx > 0 && fnIdx > uncaughtIdx, 'handler is registered textually before the function definition')
    assert.match(server.slice(uncaughtIdx - 5, uncaughtIdx), /\n$|^$/, 'sanity: handler starts on its own line')
  })
})
