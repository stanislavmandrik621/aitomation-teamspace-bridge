/**
 * BRG-068 / BRG-069 / BRG-057: Admin chat-metrics twins paint in-memory
 * operator numbers (named blocking devices, live connections, upload
 * reserve, O(1) CRM blob bytes). Public / and /health stay probe-safe.
 *
 * Pin-break (do not leave this in the tree): comment the live
 * `lastPruneBlockingDeviceIds()` read (or `wss.clients.size` /
 * `inflightHttpBodyBudgetUsed()`) inside ONE of the two twins
 * (`chat_metrics` vs `GET /v1/chat/metrics`). Then this file EXIT 1.
 * A `// lastPruneBlockingDeviceIds()` mention must also fail
 * (`sourceWithoutComments`, TOOL-G31-066). Restore SHA. Expect green.
 *
 * G12 residual: both twins also paint chatMeta retention/quota.
 * G3 residual: leftover takeOpsToken fails emit slow_down.
 * G13-server: overflow ops get a refused row.
 * G5 residual: readBodyBytes / readJsonBody copy into one buffer.
 * G7 residual: Compose JSON + CRM download/exists-skip take member share;
 * heap-budget 503s set Retry-After (form-not-ready 503s do not).
 * W8: scoped handleOps buckets via sendColleagueScopedOps (serialize-once);
 * Yjs evict uses serializeYjsRoomFullRefuse once per room; restart/queue_full
 * 503s set Retry-After; compose revoke + large payload JSON take member share;
 * chat attach/avatar GET take download share; large JSON releases in finally;
 * backup export.zip busy 429 uses sendRateLimited (Retry-After).
 * W8 hunt-again: portal/public-share register+revoke+payload pass
 * guestHttpBodyTeamId into the store; yjs/presence/role stamp boundTeamId;
 * HEAD skips takeHttpToken; CRM blob GET streams createBlobDecryptTransform.
 * W8R2: handleOps refuses oversized ops + byte-pages fan-out (BRG-061);
 * catch-up sent is actually-sent; pre-auth frame gate is UTF-8 bytes;
 * rate-limit prune drops expired first; last-admin mutators emit slow_down;
 * blob GET destroys the read stream on close.
 * W8R3: Admin list_members_ok deviceIds are Object.keys(sessions),
 * capped ids only. Non-Admin omits the field. Never hashes / tokens.
 * Roster + WS invite rate-limit fails emit slow_down.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  httpDownloadBudgetRefuseMessage,
  HTTP_DOWNLOAD_BUDGET_MEMBER_SHARE_BUSY,
  HTTP_DOWNLOAD_BUDGET_PROCESS_BUSY,
  releaseHttpDownloadBudget,
  resetHttpBodyBudgetForTests,
  tryReserveHttpDownloadBudget,
} from '../src/http-body-budget.js'
import { TokenBucketLimiter } from '../src/rate-limit.js'
import { MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER } from '../src/throughput.js'
import {
  LIST_MEMBER_DEVICE_ID_CAP,
  LIST_MEMBER_DEVICE_IDS_MAX,
  listMemberDeviceIdsForAdmin,
} from '../src/list-members-device-ids.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')
const healthSrc = readFileSync(join(root, 'src/health-page.ts'), 'utf8')
const budgetSrc = readFileSync(join(root, 'src/http-body-budget.ts'), 'utf8')

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function sliceChatMetricsWs(src: string): string {
  const start = src.indexOf("case 'chat_metrics':")
  assert.ok(start >= 0, 'missing chat_metrics case')
  const next = src.indexOf("case 'chat_config_get'", start)
  assert.ok(next > start, 'missing next case after chat_metrics')
  return src.slice(start, next)
}

function sliceChatMetricsHttp(src: string): string {
  const start = src.indexOf("if (req.method === 'GET' && path === '/v1/chat/metrics')")
  assert.ok(start >= 0, 'missing GET /v1/chat/metrics')
  const next = src.indexOf("if (req.method === 'POST' && path === '/v1/chat/avatars')", start)
  assert.ok(next > start, 'missing next HTTP route after chat metrics')
  return src.slice(start, next)
}

/**
 * G12 (Wave 14 box 12): class-method slicer for chat-blob-registry.ts,
 * matching the pattern in crm-blob-disk-total.ts's CRM twin.
 */
/** Index of the `}` matching the `{` at `openIdx` (naive brace counting). */
function matchingBraceIndex(src: string, openIdx: number): number {
  let depth = 0
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return j
    }
  }
  assert.fail('unmatched brace')
}

function sliceClassMethod(src: string, name: string): string {
  const re = new RegExp(`\\n  (?:(?:private|public|protected|static)\\s+)?(?:async\\s+)?${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing method ${name}(`)
  const start = m.index + 1
  let i = m.index + m[0].length - 1
  assert.equal(src[i], '(')
  let paren = 0
  let angle = 0
  let bodyOpen = -1
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') paren += 1
    else if (c === ')') paren -= 1
    else if (c === '<') angle += 1
    else if (c === '>' && angle > 0) angle -= 1
    else if (c === '{' && paren === 0 && angle === 0) {
      // Could be the real function body OR a `{...}` object-type return
      // annotation before it (e.g. `): { removedFiles: number } {`). If a
      // second `{` follows immediately after this brace's own close, this
      // one was the return-type object - keep scanning past it.
      const closeIdx = matchingBraceIndex(src, i)
      const gapLen = src.slice(closeIdx + 1).match(/^\s*/)?.[0].length ?? 0
      if (src[closeIdx + 1 + gapLen] === '{') {
        i = closeIdx
        continue
      }
      bodyOpen = i
      break
    }
  }
  assert.ok(bodyOpen >= 0, `no body for ${name}`)
  let depth = 0
  for (i = bodyOpen; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed method ${name}`)
}

function sliceListMembers(src: string): string {
  const start = src.indexOf("case 'list_members':")
  assert.ok(start >= 0, 'missing list_members case')
  const next = src.indexOf("case 'revoke_session':", start)
  assert.ok(next > start, 'missing revoke_session after list_members')
  return src.slice(start, next)
}

const LIVE_READS = [
  /lastPruneBlockingDeviceIds\s*\(/,
  /wss\.clients\.size/,
  /\blive\.size\b/,
  /inflightHttpBodyBudgetUsed\s*\(/,
  /MAX_INFLIGHT_HTTP_BODY_BYTES/,
  /blobDiskBytes\s*\(/,
  /blockingDeviceIds/,
  /blockingDeviceCount/,
  /liveConnections/,
  /authedConnections/,
  /uploadBytesUsed/,
  /uploadBytesMax/,
  // G5 (Wave 14 box 5): headroom signals both chat_metrics twins must expose
  // identically - see http-body-budget.ts's trackedHttpBodyBudgetMemberCount /
  // inflightHttpDownloadBudgetUsed / trackedHttpDownloadBudgetMemberCount.
  /trackedHttpBodyBudgetMemberCount\s*\(/,
  /inflightHttpDownloadBudgetUsed\s*\(/,
  /MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES/,
  /trackedHttpDownloadBudgetMemberCount\s*\(/,
  /crmBlobBytes/,
  /chatMeta\.get\s*\(/,
  /retentionDays/,
  /chatFilesQuotaBytes/,
  /chatBlobsQuotaBytes/,
  /chatFilesUsedBytes/,
  /measureChatFilesBytes\s*\(/,
] as const

function sliceNamedFunction(src: string, name: string): string {
  const needle = `function ${name}(`
  const start = src.indexOf(needle)
  assert.ok(start >= 0, `missing function ${name}(`)
  let i = start + needle.length - 1
  let depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(') depth += 1
    else if (c === ')') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }
  while (i < src.length && src[i] !== '{') i += 1
  assert.equal(src[i], '{', `no body for ${name}`)
  depth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed function ${name}`)
}

const FORBIDDEN = [
  /\bstatSync\s*\(/,
  /ops\.jsonl/,
  /hourlyRefus/,
  /opsLogBytes/,
  /refusalsThisHour/,
] as const

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

t('http-body-budget exports inflightHttpBodyBudgetUsed from processUsed', () => {
  const live = sourceWithoutComments(budgetSrc)
  assert.match(live, /export function inflightHttpBodyBudgetUsed\s*\(\s*\)\s*:\s*number\s*\{\s*return processUsed\s*\}/)
})

t('WS chat_metrics must not redeclare live (TDZ on live.size)', () => {
  const ws = sourceWithoutComments(sliceChatMetricsWs(serverSrc))
  assert.doesNotMatch(
    ws,
    /\bconst live\b/,
    'WS twin must use the session Map live; a later const live is a temporal dead zone on live.size',
  )
  assert.match(ws, /\blive\.size\b/)
})

t('both Admin metrics twins read the same in-memory operator numbers', () => {
  const ws = sourceWithoutComments(sliceChatMetricsWs(serverSrc))
  const http = sourceWithoutComments(sliceChatMetricsHttp(serverSrc))
  for (const re of LIVE_READS) {
    assert.match(ws, re, `WS twin missing ${re}`)
    assert.match(http, re, `HTTP twin missing ${re}`)
  }
  for (const re of FORBIDDEN) {
    assert.doesNotMatch(ws, re, `WS twin must not ${re}`)
    assert.doesNotMatch(http, re, `HTTP twin must not ${re}`)
  }
})

t('commenting lastPruneBlockingDeviceIds in one twin fails (TOOL-G31-066)', () => {
  const http = sliceChatMetricsHttp(serverSrc)
  assert.match(sourceWithoutComments(http), /lastPruneBlockingDeviceIds\s*\(/)

  const commented = http.replace(
    /const blockingDeviceIds = store\.lastPruneBlockingDeviceIds\(\)/,
    '// const blockingDeviceIds = store.lastPruneBlockingDeviceIds()',
  )
  assert.notEqual(commented, http, 'fixture must change the HTTP twin')
  assert.doesNotMatch(
    sourceWithoutComments(commented),
    /lastPruneBlockingDeviceIds\s*\(/,
    'a // mention of lastPruneBlockingDeviceIds must not count as a live read',
  )
  assert.match(commented, /lastPruneBlockingDeviceIds/, 'raw source still mentions the name')
})

t('G12: chatBlobs.totalBlobBytes() feeding both metrics twins is O(1), not a bySha scan (BRG-069)', () => {
  const registrySrc = readFileSync(join(root, 'src/chat-blob-registry.ts'), 'utf8')
  const body = sliceClassMethod(registrySrc, 'totalBlobBytes')
  const live = sourceWithoutComments(body)
  assert.doesNotMatch(
    live,
    /for\s*\(\s*const\s+row\s+of\s+this\.bySha\.values\s*\(\s*\)\s*\)/,
    'totalBlobBytes must not re-sum bySha on every poll - bySha grows up to 100_000 rows (BRG-069)',
  )
  assert.match(live, /this\.totalBytesTracked/, 'must return the running total field, not a fresh scan')

  const broken = body.replace(
    'return Math.max(0, this.totalBytesTracked)',
    'let n = 0\n    for (const row of this.bySha.values()) n += Math.max(0, row.bytes || 0)\n    return n',
  )
  assert.notEqual(broken, body, 'fixture must restore the O(n) scan')
  assert.match(
    sourceWithoutComments(broken),
    /for\s*\(\s*const\s+row\s+of\s+this\.bySha\.values\s*\(\s*\)\s*\)/,
    'putting the bySha scan back must fail this pin (TOOL-G31-066)',
  )

  // Both metrics twins call the O(1) leaf directly - neither inline-sums
  // bySha itself (that would defeat the fix at the call site instead).
  const ws = sourceWithoutComments(sliceChatMetricsWs(serverSrc))
  const http = sourceWithoutComments(sliceChatMetricsHttp(serverSrc))
  assert.match(ws, /chatBlobs\.totalBlobBytes\s*\(\s*\)/)
  assert.match(http, /chatBlobs\.totalBlobBytes\s*\(\s*\)/)
  assert.doesNotMatch(ws, /bySha/)
  assert.doesNotMatch(http, /bySha/)
})

t('G3 residual: leftover takeOpsToken fails emit slow_down', () => {
  const live = sourceWithoutComments(serverSrc)
  const helper = sourceWithoutComments(sliceNamedFunction(serverSrc, 'consumeOpsTokenOrSlowDown'))
  assert.match(helper, /takeOpsToken\s*\(/)
  assert.match(helper, /emitSlowDown\s*\(/)
  assert.match(helper, /maybeHintOpsApproaching\s*\(/)
  const helperFail = helper.slice(helper.indexOf('if (takeOpsToken'))
  assert.ok(helperFail.search(/emitSlowDown\s*\(/) > helperFail.indexOf('return true'), 'fail path emits after the allow return')

  const handle = sourceWithoutComments(sliceNamedFunction(serverSrc, 'handleOps'))
  const failIdx = handle.indexOf('if (!takeOpsToken(session))')
  assert.ok(failIdx >= 0, 'handleOps keeps the pinned inline fail')
  const failEnd = handle.indexOf('if (!Array.isArray(ops))', failIdx)
  const fail = handle.slice(failIdx, failEnd)
  assert.match(fail, /emitSlowDown\s*\(/)

  const stripped = live
    .replace(sourceWithoutComments(sliceNamedFunction(serverSrc, 'consumeOpsTokenOrSlowDown')), '')
    .replace(handle, '')
  assert.doesNotMatch(
    stripped,
    /if\s*\(\s*!takeOpsToken\s*\(/,
    'every other takeOpsToken fail must go through consumeOpsTokenOrSlowDown',
  )
  assert.match(live, /consumeOpsTokenOrSlowDown\s*\(/)
  assert.match(live, /if\s*\(\s*!takeCatchUpRequestToken\s*\([\s\S]{0,280}emitSlowDown\s*\(/)
  assert.match(live, /if\s*\(\s*!takeAckOpsToken\s*\([\s\S]{0,280}emitSlowDown\s*\(/)

  const adminHelper = sourceWithoutComments(sliceNamedFunction(serverSrc, 'consumeAdminMutateTokenOrSlowDown'))
  assert.match(adminHelper, /takeAdminMutateToken\s*\(/)
  assert.match(adminHelper, /emitSlowDown\s*\(/)
  const adminStripped = live.replace(adminHelper, '')
  assert.doesNotMatch(
    adminStripped,
    /if\s*\(\s*!takeAdminMutateToken\s*\(/,
    'every takeAdminMutateToken fail must go through consumeAdminMutateTokenOrSlowDown',
  )

  const rosterHelper = sourceWithoutComments(sliceNamedFunction(serverSrc, 'consumeRosterTokenOrSlowDown'))
  assert.match(rosterHelper, /takeRosterToken\s*\(/)
  assert.match(rosterHelper, /emitSlowDown\s*\(/)
  const rosterStripped = live.replace(rosterHelper, '')
  assert.doesNotMatch(
    rosterStripped,
    /if\s*\(\s*!takeRosterToken\s*\(/,
    'every takeRosterToken fail must go through consumeRosterTokenOrSlowDown',
  )

  const inviteHelper = sourceWithoutComments(sliceNamedFunction(serverSrc, 'consumeInviteTokenOrSlowDown'))
  assert.match(inviteHelper, /takeInviteToken\s*\(/)
  assert.match(inviteHelper, /emitSlowDown\s*\(/)
  const sendJsonIdx = live.indexOf('function sendJson')
  assert.ok(sendJsonIdx > 0, 'sendJson follows WS handlers')
  const wsWithoutInviteHelper = live.slice(0, sendJsonIdx).replace(inviteHelper, '')
  assert.doesNotMatch(
    wsWithoutInviteHelper,
    /if\s*\(\s*!takeInviteToken\s*\(/,
    'WS invite fails must go through consumeInviteTokenOrSlowDown',
  )
  assert.match(live, /if\s*\(\s*!takeInviteToken[\s\S]{0,280}sendRateLimited/)
})

t('G13-server: overflow ops get a refused row, never a silent drop', () => {
  const handle = sourceWithoutComments(sliceNamedFunction(serverSrc, 'handleOps'))
  assert.match(handle, /incoming\.length\s*>\s*MAX_OPS_PER_FRAME/)
  assert.match(handle, /Too many changes in one batch/)
  assert.match(handle, /permanent:\s*false/)
  const overflowIdx = handle.indexOf('incoming.length > MAX_OPS_PER_FRAME')
  assert.ok(overflowIdx > 0, 'overflow report exists')
  const overflow = handle.slice(overflowIdx)
  assert.match(overflow, /status:\s*'refused'/)
  assert.doesNotMatch(overflow, /status:\s*'applied'/)
  assert.match(handle, /encodedOpByteLength\s*\(/)
  assert.match(handle, /Change is too large to sync/)
  const oversizeIdx = handle.indexOf('Change is too large to sync')
  assert.ok(oversizeIdx > 0 && oversizeIdx < overflowIdx, 'oversize refuse is before count leftover')
  const gateIdx = handle.indexOf('if (!Number.isFinite(encoded)')
  const persistIdx = handle.indexOf('toPersist.push(stamped)')
  assert.ok(gateIdx > 0 && persistIdx > gateIdx, 'oversize gate sits before persist')
  const gate = handle.slice(gateIdx, persistIdx)
  assert.match(gate, /permanent:\s*true/)
  assert.match(gate, /OPS_FRAME_MAX_BYTES/)
  assert.match(gate, /continue/)
  assert.match(handle, /splitOpsForWsFrames\s*\(\s*teamWide/)
})

t('public health HTML has no connection / upload / device / log numbers (BRG-057)', () => {
  // Source-scan only. Do not import health-page.js from this lane: a JSDoc
  // any-type Accept token in that L08 file ends the comment and breaks parse.
  assert.match(healthSrc, /AItomation Team Space bridge\\n/)
  assert.match(healthSrc, /HEALTH_PROBE_MAX_BYTES/)
  assert.match(healthSrc, /Team server is running/)
  const leak = /liveConnections|authedConnections|uploadBytes|blockingDevice|ops\.jsonl|wss\.clients|inflightHttp|crmBlobBytes/i
  assert.doesNotMatch(healthSrc, leak)
})

t('G5: in-memory body readers copy into one buffer, never chunks.push + concat', () => {
  const bytesStart = serverSrc.indexOf('function readBodyBytes(')
  const jsonStart = serverSrc.indexOf('function readJsonBody(')
  const authStart = serverSrc.indexOf('function authFromReq(')
  assert.ok(bytesStart >= 0 && jsonStart > bytesStart && authStart > jsonStart)
  const bytesLive = sourceWithoutComments(serverSrc.slice(bytesStart, jsonStart))
  const jsonLive = sourceWithoutComments(serverSrc.slice(jsonStart, authStart))
  const sink = sourceWithoutComments(sliceNamedFunction(serverSrc, 'allocBoundedBodySink'))
  for (const [name, live] of [
    ['readBodyBytes', bytesLive],
    ['readJsonBody', jsonLive],
    ['allocBoundedBodySink', sink],
  ] as const) {
    assert.doesNotMatch(live, /chunks\.push/, `${name} must not collect chunks`)
    assert.doesNotMatch(live, /Buffer\.concat/, `${name} must not concat collected chunks`)
  }
  assert.match(sink, /chunk\.copy\(buf,\s*n\)/)
  assert.match(bytesLive, /sink\.toUint8Array\s*\(/)
  assert.match(jsonLive, /sink\.toUtf8\s*\(/)
})

t('G7: Compose JSON and CRM download / exists-skip take this member share', () => {
  const live = sourceWithoutComments(serverSrc)
  assert.match(
    live,
    /readJsonBody\(req, COMPOSE_SHARE_JSON_BODY_MAX,\s*\{\s*memberId:\s*auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(
    live,
    /readJsonBody\(req, COMPOSE_ACL_JSON_BODY_MAX,\s*\{\s*memberId:\s*auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(
    live,
    /readJsonBody\(req, 64_000,\s*\{\s*memberId:\s*auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(
    live,
    /readJsonBody\(req, PAYLOAD_JSON_BODY_MAX,\s*\{\s*memberId:\s*auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(live, /tryReserveHttpDownloadBudget\(onDisk,\s*auth\.member\.memberId\)/)
  assert.match(live, /releaseHttpDownloadBudget\(onDisk,\s*auth\.member\.memberId\)/)
  assert.match(live, /tryReserveHttpDownloadBudget\(len,\s*auth\.member\.memberId\)/)
  assert.match(live, /releaseHttpDownloadBudget\(len,\s*auth\.member\.memberId\)/)
  const chatGet = live.slice(live.indexOf('const chatBlobGet ='))
  assert.match(chatGet, /tryReserveHttpDownloadBudget\(onDisk,\s*auth\.member\.memberId\)/)
  const avatarGet = live.slice(live.indexOf('const chatAvatarGet ='))
  assert.match(avatarGet, /tryReserveHttpDownloadBudget\(onDisk,\s*auth\.member\.memberId\)/)
  const guestPack = live.slice(live.indexOf('const reservedPack = tryReserveHttpDownloadBudget'))
  assert.match(guestPack, /tryReserveHttpDownloadBudget\(approx\)/)
  assert.doesNotMatch(
    guestPack.slice(0, 180),
    /tryReserveHttpDownloadBudget\(approx,\s*auth/,
    'guest pack download stays process-only',
  )
})

t('G7: heap-budget 503s set Retry-After; form-not-ready 503s do not', () => {
  const busy = sourceWithoutComments(sliceNamedFunction(serverSrc, 'sendBusy503'))
  assert.match(busy, /Retry-After/)
  assert.match(busy, /HTTP_BODY_BUDGET_RETRY_AFTER_SEC/)
  assert.match(busy, /sendJson\(res,\s*503,/)

  const live = sourceWithoutComments(serverSrc)
  assert.match(live, /sendBusy503\(res, \{ ok: false, error: httpBodyBudgetRefuseMessage\(reserved\.kind\) \}\)/)
  assert.match(live, /sendBusy503\(res, \{ ok: false, error: httpDownloadBudgetRefuseMessage\(reservedDl\.kind\) \}\)/)
  assert.match(live, /sendBusy503\(res, \{ ok: false, error: httpDownloadBudgetRefuseMessage\(reservedVerify\.kind\) \}\)/)
  assert.match(live, /error_code:\s*'share\.busy'/)

  const formIdx = live.indexOf('Shared form is not ready yet')
  assert.ok(formIdx > 0, 'shared form not-ready 503 exists')
  const formWindow = live.slice(Math.max(0, formIdx - 220), formIdx + 80)
  assert.match(formWindow, /sendJson\(res,\s*503,/)
  assert.doesNotMatch(formWindow, /sendBusy503/)
  assert.doesNotMatch(formWindow, /Retry-After/)

  const portalIdx = live.indexOf('Portal form is not ready yet')
  assert.ok(portalIdx > 0, 'portal form not-ready 503 exists')
  const portalWindow = live.slice(Math.max(0, portalIdx - 220), portalIdx + 80)
  assert.match(portalWindow, /sendJson\(res,\s*503,/)
  assert.doesNotMatch(portalWindow, /sendBusy503/)
  assert.doesNotMatch(portalWindow, /Retry-After/)

  const restartIdx = live.indexOf('Bridge is restarting - retry shortly')
  assert.ok(restartIdx > 0, 'restart 503 exists')
  const restartWindow = live.slice(Math.max(0, restartIdx - 220), restartIdx + 40)
  assert.match(restartWindow, /Retry-After/)
  assert.match(restartWindow, /sendJson\(res,\s*503,/)

  const intake = sourceWithoutComments(sliceNamedFunction(serverSrc, 'sendIntakeStatusJson'))
  assert.match(intake, /Retry-After/)
  assert.match(intake, /portal\.payload_not_ready/)
  assert.match(intake, /share\.payload_not_ready/)
  assert.match(live, /sendIntakeStatusJson\(res, queued\.status/)
  assert.match(live, /sendIntakeStatusJson\(res, requested\.status/)

  const exportBusyIdx = live.indexOf('Another backup export is already running. Try again shortly.')
  assert.ok(exportBusyIdx > 0, 'backup export busy 429 exists')
  const exportBusyWindow = live.slice(Math.max(0, exportBusyIdx - 280), exportBusyIdx + 80)
  assert.match(exportBusyWindow, /sendRateLimited\s*\(/)
  assert.doesNotMatch(exportBusyWindow, /sendJson\(res,\s*429/)
})

t('G7: download member share is distinct from process-busy', () => {
  assert.ok(MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER >= 28_000_000)
  assert.notEqual(HTTP_DOWNLOAD_BUDGET_PROCESS_BUSY, HTTP_DOWNLOAD_BUDGET_MEMBER_SHARE_BUSY)
  assert.equal(httpDownloadBudgetRefuseMessage('process'), HTTP_DOWNLOAD_BUDGET_PROCESS_BUSY)
  assert.equal(httpDownloadBudgetRefuseMessage('member'), HTTP_DOWNLOAD_BUDGET_MEMBER_SHARE_BUSY)

  resetHttpBodyBudgetForTests()
  try {
    const hundred = 100 * 1024 * 1024
    const fifty = 50 * 1024 * 1024
    assert.equal(tryReserveHttpDownloadBudget(hundred, 'mem_host').ok, true)
    const over = tryReserveHttpDownloadBudget(fifty, 'mem_host')
    assert.equal(over.ok, false)
    if (!over.ok) assert.equal(over.kind, 'member')
    assert.equal(tryReserveHttpDownloadBudget(fifty, 'mem_peer').ok, true)
    assert.equal(tryReserveHttpDownloadBudget(0).ok, true)
    releaseHttpDownloadBudget(hundred, 'mem_host')
    assert.equal(tryReserveHttpDownloadBudget(hundred, 'mem_host').ok, true)
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('W8: evictSurplusYjsPeers stringifies once per room', () => {
  const evict = sourceWithoutComments(sliceNamedFunction(serverSrc, 'evictSurplusYjsPeers'))
  assert.match(evict, /serializeYjsRoomFullRefuse\s*\(\s*room\s*,\s*boundTeamId\s*\(\s*\)\s*\)/)
  assert.doesNotMatch(evict, /JSON\.stringify/)
  const serIdx = evict.indexOf('serializeYjsRoomFullRefuse')
  const whileIdx = evict.indexOf('while (peers.size > target)')
  assert.ok(serIdx >= 0 && whileIdx > serIdx, 'serialize before kicking peers in that room')
})

t('W8: scoped handleOps serializes once per unique payload', () => {
  const fan = sourceWithoutComments(sliceNamedFunction(serverSrc, 'sendColleagueScopedOps'))
  assert.match(fan, /serializeBridgeFrame/)
  assert.match(fan, /sendSerializedFrame/)
  assert.match(fan, /splitOpsForWsFrames\s*\(\s*bucket\.ops/)
  assert.doesNotMatch(fan, /\breply\s*\(/)
  const serIdx = fan.indexOf('serializeBridgeFrame')
  const forPeerIdx = fan.lastIndexOf('for (const peer of bucket.peers)')
  assert.ok(serIdx >= 0 && forPeerIdx > serIdx, 'stringify before the per-peer send loop')

  const handle = sourceWithoutComments(sliceNamedFunction(serverSrc, 'handleOps'))
  const scoped = handle.slice(handle.indexOf('if (scoped.length > 0)'))
  assert.match(scoped, /sendColleagueScopedOps\s*\(/)
  assert.doesNotMatch(scoped, /\breply\s*\(\s*peer/)
})

t('W8: large compose / payload JSON release in finally', () => {
  const live = sourceWithoutComments(serverSrc)
  const composeReg = live.slice(
    live.indexOf("path === '/v1/compose-share/register'"),
    live.indexOf("path === '/v1/compose-share/revoke'"),
  )
  assert.match(composeReg, /finally\s*\{\s*releaseJsonBody\(body\)\s*\}/)
  const composeAcl = live.slice(
    live.indexOf("path === '/v1/teamspace/compose-acl'"),
    live.indexOf('const composeShareMatch'),
  )
  assert.match(composeAcl, /finally\s*\{\s*releaseJsonBody\(body\)\s*\}/)
  const pubReg = live.slice(
    live.indexOf("path === '/v1/public-share/register'"),
    live.indexOf("path === '/v1/public-share/payload'"),
  )
  assert.match(pubReg, /finally\s*\{\s*releaseJsonBody\(body\)\s*\}/)
})

t('W8: guest-link register/revoke prove stamped team_id', () => {
  const proveStart = serverSrc.indexOf('function capRequestTeamId')
  const proveEnd = serverSrc.indexOf('function sendGuestHtml', proveStart)
  assert.ok(proveStart >= 0 && proveEnd > proveStart, 'capRequestTeamId sits before sendGuestHtml')
  const prove = sourceWithoutComments(serverSrc.slice(proveStart, proveEnd))
  assert.match(prove, /store\.getTeam\s*\(/)
  assert.doesNotMatch(prove, /ensureTeam/)
  assert.match(prove, /normalizeTeamIdSegment\s*\(/)
  assert.doesNotMatch(prove, /replace\(\s*\/\\0\/g/, 'team id must NUL-cut, never NUL-join')
  assert.match(prove, /GUEST_LINK_TEAM_ID_MAX/)
  assert.match(prove, /guestHttpBodyTeamId\s*\(\s*body\s*\)/)
  assert.match(prove, /function boundTeamId/)
  assert.match(prove, /This link belongs to a different team/)
  assert.match(prove, /function proveGuestLinkRequestTeamFromUrl/)
  assert.match(prove, /searchParams\.get\(\s*'teamId'\s*\)/)

  const live = sourceWithoutComments(serverSrc)
  assert.match(live, /guestHttpBodyTeamId/)
  for (const path of [
    '/v1/portal/register',
    '/v1/portal/revoke',
    '/v1/public-share/register',
    '/v1/public-share/revoke',
    '/v1/compose-share/register',
    '/v1/compose-share/revoke',
    '/v1/public-share/payload',
    '/v1/portal/otp-ack',
  ]) {
    const start = live.indexOf(`path === '${path}'`)
    assert.ok(start >= 0, `missing ${path}`)
    const window = live.slice(start, start + 1200)
    assert.match(window, /proveGuestLinkRequestTeam\s*\(\s*body\s*\)/, `${path} must prove team_id`)
  }

  const portalReg = live.slice(
    live.indexOf("path === '/v1/portal/register'"),
    live.indexOf("path === '/v1/portal/revoke'"),
  )
  assert.match(portalReg, /takeAdminHttpMutateToken/)
  assert.match(portalReg, /teamId:\s*guestHttpBodyTeamId\(body\)/)
  const portalRev = live.slice(
    live.indexOf("path === '/v1/portal/revoke'"),
    live.indexOf("path === '/v1/portal/submissions'"),
  )
  assert.match(portalRev, /takeAdminHttpMutateToken/)
  assert.match(portalRev, /proveGuestLinkRequestTeam/)
  assert.match(portalRev, /teamId:\s*guestHttpBodyTeamId\(body\)/)

  const pubReg = live.slice(
    live.indexOf("path === '/v1/public-share/register'"),
    live.indexOf("path === '/v1/public-share/payload'"),
  )
  assert.match(pubReg, /teamId:\s*guestHttpBodyTeamId\(body\)/)
  const pubPay = live.slice(
    live.indexOf("path === '/v1/public-share/payload'"),
    live.indexOf("path === '/v1/public-share/revoke'"),
  )
  assert.match(pubPay, /teamId:\s*guestHttpBodyTeamId\(body\)/)
  const pubRev = live.slice(
    live.indexOf("path === '/v1/public-share/revoke'"),
    live.indexOf("path === '/v1/public-share/submissions'"),
  )
  assert.match(pubRev, /teamId:\s*guestHttpBodyTeamId\(body\)/)

  for (const path of [
    '/v1/portal/submissions',
    '/v1/public-share/submissions',
    '/v1/portal/otp-pending',
  ]) {
    const start = live.indexOf(`path === '${path}'`)
    assert.ok(start >= 0, `missing ${path}`)
    const window = live.slice(start, start + 1400)
    assert.match(
      window,
      /proveGuestLinkRequestTeamFromUrl\s*\(\s*url\s*\)/,
      `${path} GET must prove query team_id`,
    )
    assert.match(
      window,
      /guestHttpDrainTeamIdFromUrl\s*\(\s*url\s*\)/,
      `${path} GET must pass drain teamId after prove (TCC-FIX-SHARE-013)`,
    )
  }

  const drainFn = sourceWithoutComments(sliceNamedFunction(serverSrc, 'guestHttpDrainTeamId'))
  assert.match(drainFn, /guestHttpBodyTeamId\s*\(\s*body\s*\)/)
  assert.match(drainFn, /boundTeamId\s*\(\s*\)/)
  assert.match(drainFn, /\|\|/, 'stamped id or live team; both empty stays omit')

  const pubAckIdx = live.indexOf('publicShares.ackSubmission')
  assert.ok(pubAckIdx > 0, 'publicShares.ackSubmission site')
  const pubAck = live.slice(pubAckIdx, pubAckIdx + 360)
  assert.match(pubAck, /guestHttpDrainTeamId\s*\(\s*body\s*\)/)

  const portalAckIdx = live.indexOf('portals.ackSubmission')
  assert.ok(portalAckIdx > 0, 'portals.ackSubmission site')
  const portalAck = live.slice(portalAckIdx, portalAckIdx + 520)
  assert.match(portalAck, /guestHttpDrainTeamId\s*\(\s*body\s*\)/)

  const otpIdx = live.indexOf('portals.listPendingOtpSends')
  assert.ok(otpIdx > 0, 'portals.listPendingOtpSends site')
  const otp = live.slice(otpIdx, otpIdx + 160)
  assert.match(otp, /guestHttpDrainTeamIdFromUrl\s*\(\s*url\s*\)/)
})

t('W8: frames stamp teamId; HEAD skips HTTP token; blob GET streams', () => {
  const live = sourceWithoutComments(serverSrc)
  const yjsUp = sliceNamedFunction(serverSrc, 'fanoutYjsUpdate')
  assert.match(sourceWithoutComments(yjsUp), /boundTeamId\s*\(/)
  assert.match(sourceWithoutComments(yjsUp), /teamId/)
  const yjsAw = sliceNamedFunction(serverSrc, 'fanoutYjsAwareness')
  assert.match(sourceWithoutComments(yjsAw), /boundTeamId\s*\(/)
  const presenceFan = sliceNamedFunction(serverSrc, 'schedulePresenceFanoutBroadcast')
  assert.match(sourceWithoutComments(presenceFan), /boundTeamId\s*\(/)
  const presencePush = sliceNamedFunction(serverSrc, 'pushPresenceSnapshot')
  assert.match(sourceWithoutComments(presencePush), /boundTeamId\s*\(/)
  const roleWin = live.slice(live.indexOf("type: 'role_peer'"), live.indexOf("type: 'role_peer'") + 280)
  assert.match(roleWin, /boundTeamId|roleTeamId/)

  const tokenIdx = live.indexOf('if (!takeHttpToken(ip))')
  const headGuard = live.lastIndexOf("req.method !== 'HEAD'", tokenIdx)
  assert.ok(headGuard >= 0 && headGuard < tokenIdx, 'HEAD must skip takeHttpToken')
  assert.match(live, /req\.method === 'GET' \|\| req\.method === 'HEAD'/)

  const blobGet = live.slice(live.indexOf('const reservedDl = tryReserveHttpDownloadBudget'), live.indexOf('if (req.method === \'POST\' || req.method === \'PUT\')'))
  assert.doesNotMatch(blobGet, /openBlobRead/)
  assert.match(blobGet, /createBlobDecryptTransform\s*\(\s*store\.atRest\s*\)/)
  assert.match(blobGet, /createReadStream\s*\(\s*blobPath\s*\)/)
  assert.match(blobGet, /fileStream\.destroy/)
  assert.match(blobGet, /res\.on\(\s*'close'/)
  const blobGate = live.slice(live.indexOf('const blobMatch ='), live.indexOf('if (!takeBlobToken'))
  assert.match(blobGate, /req\.method !== 'GET'/)
  assert.match(blobGate, /Method not allowed/)
})

t('G3: token prune drops expired windows before live lockouts', () => {
  const lim = new TokenBucketLimiter(3)
  assert.equal(lim.take('spent-a', 2, 1), true)
  assert.equal(lim.take('spent-b', 2, 1), true)
  assert.equal(lim.take('spent-c', 2, 1), true)
  const start = Date.now()
  while (Date.now() - start < 4) {
    /* expire the 1ms windows */
  }
  assert.equal(lim.take('live-lock', 5, 60_000), true)
  assert.equal(lim.size(), 1, 'expired keys must not occupy the cap after a new insert')
  assert.equal(lim.take('live-lock', 5, 60_000), true)
  assert.equal(lim.take('live-lock', 5, 60_000), true)
  assert.equal(lim.take('live-lock', 5, 60_000), true)
  assert.equal(lim.take('live-lock', 5, 60_000), true)
  assert.equal(lim.take('live-lock', 5, 60_000), false, 'live lockout must survive expired-key churn')
})

t('W8R2: catch-up sent is actually-sent; pre-auth gate is UTF-8 bytes', () => {
  const catchUp = sourceWithoutComments(sliceNamedFunction(serverSrc, 'sendCatchUpOps'))
  assert.match(catchUp, /sent \+= chunk\.length/)
  assert.match(catchUp, /setImmediate/)
  assert.doesNotMatch(catchUp, /sent:\s*unacked\.length/)

  const handleMsg = sourceWithoutComments(sliceNamedFunction(serverSrc, 'handleMessage'))
  assert.match(handleMsg, /buf\.length\s*>\s*maxFrame/)
  assert.doesNotMatch(handleMsg, /text\.length\s*>\s*maxFrame/)
  assert.match(handleMsg, /PRE_AUTH_WS_MAX_FRAME_BYTES/)
})

t('MUST-FIX: Admin list_members_ok deviceIds are Object.keys(sessions), never hashes', () => {
  const leafSrc = readFileSync(join(root, 'src/list-members-device-ids.ts'), 'utf8')
  const leaf = sourceWithoutComments(leafSrc)
  assert.match(leaf, /Object\.keys\s*\(\s*sessions\s*\)/)
  assert.match(leaf, /capStr\s*\(\s*raw,\s*LIST_MEMBER_DEVICE_ID_CAP\s*\)/)
  assert.doesNotMatch(leaf, /normalizeTeamIdSegment/)
  assert.match(leaf, /LIST_MEMBER_DEVICE_IDS_MAX/)
  assert.doesNotMatch(leaf, /Object\.values/)
  assert.doesNotMatch(leaf, /sessionToken|sessionLastSeen|hashSessionToken/)

  const listCase = sliceListMembers(serverSrc)
  const live = sourceWithoutComments(listCase)
  assert.match(live, /requireAdmin\s*\(\s*session\s*\)/)
  assert.match(live, /deviceIds:\s*listMemberDeviceIdsForAdmin\s*\(\s*m\.sessions\s*\)/)
  assert.match(live, /consumeRosterTokenOrSlowDown/)
  assert.match(live, /avatarRef/)
  assert.match(live, /avatarRev/)
  assert.match(live, /has_more/)
  assert.match(live, /truncated/)
  assert.doesNotMatch(live, /sessions:\s*m\.sessions/)
  assert.doesNotMatch(live, /sessionToken/)
  assert.doesNotMatch(live, /sessionLastSeen/)
  assert.doesNotMatch(live, /Object\.values\s*\(\s*m\.sessions/)
  assert.match(live, /\.\.\.\(adminRoster\s*\?[\s\S]*deviceIds:[\s\S]*:\s*\{\s*\}/)

  const commented = listCase.replace(
    /const adminRoster = requireAdmin\(session\)/,
    '// const adminRoster = requireAdmin(session)',
  )
  assert.notEqual(commented, listCase, 'fixture must comment the Admin gate')
  assert.doesNotMatch(
    sourceWithoutComments(commented),
    /const adminRoster = requireAdmin/,
    'a // mention of requireAdmin must not count as the live Admin gate',
  )
})

t('MUST-FIX runtime: deviceIds are capped keys only', () => {
  const hash = 'a'.repeat(64)
  const ids = listMemberDeviceIdsForAdmin({
    dev_one: hash,
    dev_two: 'plaintext-token-must-not-appear',
  })
  assert.deepEqual(ids, ['dev_one', 'dev_two'])
  assert.equal(ids.some((id) => id.includes(hash) || id.includes('plaintext')), false)
  assert.deepEqual(listMemberDeviceIdsForAdmin(null), [])
  assert.deepEqual(listMemberDeviceIdsForAdmin(undefined), [])
  assert.deepEqual(listMemberDeviceIdsForAdmin(['dev_one']), [])
  const own = Object.create(null) as Record<string, string>
  own.dev_ok = hash
  own.__proto__ = 'nope'
  own.constructor = 'nope'
  own.prototype = 'nope'
  assert.deepEqual(listMemberDeviceIdsForAdmin(own), ['dev_ok'])
  const long = `d${'e'.repeat(LIST_MEMBER_DEVICE_ID_CAP + 8)}`
  const capped = listMemberDeviceIdsForAdmin({ [long]: hash })
  assert.equal(capped.length, 1)
  assert.ok(capped[0] && capped[0].length <= LIST_MEMBER_DEVICE_ID_CAP)
  const many: Record<string, string> = {}
  for (let i = 0; i < LIST_MEMBER_DEVICE_IDS_MAX + 5; i++) many[`d${i}`] = hash
  assert.equal(listMemberDeviceIdsForAdmin(many).length, LIST_MEMBER_DEVICE_IDS_MAX)
  const leftoverA = 'foo\0aaa'
  const leftoverB = 'foo\0bbb'
  assert.deepEqual(
    listMemberDeviceIdsForAdmin({ [leftoverA]: hash, [leftoverB]: hash, dev_ok: hash }),
    [leftoverA, leftoverB, 'dev_ok'],
    'leftover session keys stay distinct so Forget can look them up (BRG-068)',
  )
  const uuid = '550e8400-e29b-41d4-a716-446655440000'
  assert.deepEqual(
    listMemberDeviceIdsForAdmin({ [uuid]: hash }),
    [uuid],
    'honest randomUUID device ids stay unchanged',
  )
})

console.log(`brg-068-operator-metrics: ${passed}/21 ok`)
