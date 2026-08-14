/**
 * TCC-R1125-BRG-001 / TCC-R1126-BRG-001 - HTTP invite redeem and `leave_team`
 * must close every live WS peer for the affected member (kick/revoke parity).
 *
 * `server.ts` starts a real HTTP+WS server as a module side effect, so these
 * are source-scan pins (same technique as the hourly-GC pin in
 * `chat-blob-gc.ts`) rather than a live socket test - they fail loudly if the
 * close call is ever deleted or moved out of the fixed code path.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')

describe('WS peer close on invite redeem / leave_team (TCC-R1125-BRG-001 / TCC-R1126-BRG-001)', () => {
  it('HTTP /v1/invite/redeem closes other live WS peers for the redeemed member', () => {
    const routeIdx = server.indexOf("path === '/v1/invite/redeem'")
    assert.ok(routeIdx > 0, 'HTTP redeem route exists')
    const okIdx = server.indexOf('redeemed.ok', routeIdx)
    assert.ok(okIdx > routeIdx, 'redeemed.ok guard follows the route')
    const sendJsonIdx = server.indexOf('sendJson(res, 200,', okIdx)
    assert.ok(sendJsonIdx > okIdx, 'success response follows the guard')
    const window = server.slice(okIdx, sendJsonIdx)
    assert.match(window, /TCC-R1125-BRG-001/, 'fix is cited at the close site')
    assert.match(window, /for \(const \[peerWs, peer\] of live\)/, 'scans the live peer map')
    assert.match(window, /peer\.memberId === redeemed\.member\.memberId/, 'matches peers by redeemed member id')
    assert.match(window, /peerWs\.close\(4001, 'session rotated'\)/, 'closes with the WS-redeem parity code')
    assert.match(window, /quietDropLiveSession\(peerWs\)/, 'drops the live session map entry (no stale ops after close)')
  })

  it('leave_team closes every live WS socket for the leaving member (incl. actor + sibling devices)', () => {
    const caseIdx = server.indexOf("case 'leave_team':")
    assert.ok(caseIdx > 0, 'leave_team case exists')
    const nextCaseIdx = server.indexOf("case 'list_members':", caseIdx)
    assert.ok(nextCaseIdx > caseIdx, 'next case follows leave_team')
    const window = server.slice(caseIdx, nextCaseIdx)
    assert.match(window, /TCC-R1126-BRG-001/, 'fix is cited inside the case')
    assert.match(window, /store\.leaveTeam\(session\.memberId\)/, 'still calls store.leaveTeam first')
    assert.match(window, /leave_team_ok/, 'still replies leave_team_ok')
    // TCC-R1151-BRG-001: snapshot `[...live]` so dropLive during close is safe.
    assert.match(
      window,
      /for \(const \[peerWs, peer\] of (?:\[\.\.\.live\]|live)\)/,
      'scans the live peer map',
    )
    assert.match(window, /peer\.memberId === session\.memberId/, 'matches every socket for the leaving member (not just one device)')
    assert.match(window, /dropLiveSession\(peerWs\)/, 'drops live before close (no mid-close auth)')
    assert.match(window, /peerWs\.close\(4005, 'left team'\)/, 'closes with a leave-specific code (distinct from kick 4003 / revoke 4004)')
    // Order: reply before close, so the acting device's own ack is flushed
    // before its socket is torn down.
    const replyIdx = window.indexOf('leave_team_ok')
    const closeIdx = window.indexOf("peerWs.close(4005")
    assert.ok(replyIdx > 0 && closeIdx > replyIdx, 'replies leave_team_ok before closing sockets')
  })

  it('kick_member (4003) and revoke_session (4004) close codes are unchanged (no regression)', () => {
    assert.match(server, /peerWs\.close\(4003, 'kicked'\)/)
    assert.match(server, /peerWs\.close\(4004, 'session revoked'\)/)
  })
})
