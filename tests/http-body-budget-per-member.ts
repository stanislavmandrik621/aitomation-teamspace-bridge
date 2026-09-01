/**
 * BRG-069: HTTP body heap is one question. Process-wide ceiling plus a
 * per-member share on binary uploads (avatar, chat attach, CRM). Compose
 * 28 MiB residual stays process-only (blank memberId).
 *
 * Pin-break (do not leave this in the tree): comment the per-member
 * reserve check in tryReserveHttpBodyBudget
 * (`if (used + bytes > MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER)`).
 * Then this file EXIT 1. Restore SHA. Expect green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HTTP_BODY_BUDGET_MEMBER_SHARE_BUSY,
  HTTP_BODY_BUDGET_PROCESS_BUSY,
  httpBodyBudgetRefuseMessage,
  inflightHttpBodyBudgetUsed,
  inflightHttpDownloadBudgetUsed,
  releaseHttpBodyBudget,
  releaseHttpDownloadBudget,
  resetHttpBodyBudgetForTests,
  tryReserveHttpBodyBudget,
  tryReserveHttpDownloadBudget,
} from '../src/http-body-budget.js'
import {
  MAX_INFLIGHT_HTTP_BODY_BYTES,
  MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER,
} from '../src/throughput.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const leafSrc = readFileSync(join(root, 'src/http-body-budget.ts'), 'utf8')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')
const throughputSrc = readFileSync(join(root, 'src/throughput.ts'), 'utf8')

const MIB = 1024 * 1024
const TWENTY_FIVE = 25 * MIB
const HUNDRED = 100 * MIB
const FIFTY = 50 * MIB

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function sliceFunction(src: string, name: string): string {
  const re = new RegExp(`\\nexport function ${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing function ${name}(`)
  const start = m.index + 1
  let i = start
  while (i < src.length && src[i] !== '{') i += 1
  assert.equal(src[i], '{', `no body for ${name}`)
  let depth = 0
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

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

t('floor is >= 28_000_000 and default is 128 MiB', () => {
  assert.ok(
    MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER >= 28_000_000,
    `per-member ceiling ${MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER} must be >= 28_000_000`,
  )
  assert.match(
    throughputSrc,
    /MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER = envInt\(\s*'TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER',\s*128 \* 1024 \* 1024,\s*28_000_000,/,
  )
  assert.ok(MAX_INFLIGHT_HTTP_BODY_BYTES >= 256 * MIB)
})

t('503 copy is distinct for member-share vs process-busy', () => {
  assert.notEqual(HTTP_BODY_BUDGET_PROCESS_BUSY, HTTP_BODY_BUDGET_MEMBER_SHARE_BUSY)
  assert.equal(httpBodyBudgetRefuseMessage('process'), HTTP_BODY_BUDGET_PROCESS_BUSY)
  assert.equal(httpBodyBudgetRefuseMessage('member'), HTTP_BODY_BUDGET_MEMBER_SHARE_BUSY)
})

t('4x25 MiB from one member fits; a second 50 after 100 is member-share', () => {
  resetHttpBodyBudgetForTests()
  try {
    for (let i = 0; i < 4; i += 1) {
      const r = tryReserveHttpBodyBudget(TWENTY_FIVE, 'mem_host')
      assert.equal(r.ok, true, `4x25 reserve ${i} must succeed`)
    }
    resetHttpBodyBudgetForTests()
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_host').ok, true)
    const over = tryReserveHttpBodyBudget(FIFTY, 'mem_host')
    assert.equal(over.ok, false)
    if (!over.ok) assert.equal(over.kind, 'member')
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('a second member can still reserve while the first is at their share', () => {
  resetHttpBodyBudgetForTests()
  try {
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_a').ok, true)
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_b').ok, true)
    const overA = tryReserveHttpBodyBudget(FIFTY, 'mem_a')
    assert.equal(overA.ok, false)
    if (!overA.ok) assert.equal(overA.kind, 'member')
    const peer = tryReserveHttpBodyBudget(TWENTY_FIVE, 'mem_b')
    assert.equal(peer.ok, true)
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('blank memberId is process-only (compose residual)', () => {
  resetHttpBodyBudgetForTests()
  try {
    const first = tryReserveHttpBodyBudget(200 * MIB, '')
    assert.equal(first.ok, true, 'blank memberId may exceed 128 MiB')
    const ws = tryReserveHttpBodyBudget(TWENTY_FIVE, '   ')
    assert.equal(ws.ok, true, 'whitespace memberId is process-only')
    const none = tryReserveHttpBodyBudget(TWENTY_FIVE)
    assert.equal(none.ok, true)
    const processFull = tryReserveHttpBodyBudget(20 * MIB, '')
    assert.equal(processFull.ok, false)
    if (!processFull.ok) assert.equal(processFull.kind, 'process')
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('memberId leftover after NUL shares the same budget slot', () => {
  resetHttpBodyBudgetForTests()
  try {
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_x\0other').ok, true)
    const over = tryReserveHttpBodyBudget(FIFTY, 'mem_x')
    assert.equal(over.ok, false, 'NUL leftover must not mint a second member slot')
    if (!over.ok) assert.equal(over.kind, 'member')
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('release pairs with the same memberId and double-release cannot go negative', () => {
  resetHttpBodyBudgetForTests()
  try {
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_x').ok, true)
    releaseHttpBodyBudget(HUNDRED, 'mem_x')
    releaseHttpBodyBudget(HUNDRED, 'mem_x')
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_x').ok, true)
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('source-scan: per-member reserve is load-bearing (comment is not)', () => {
  const body = sliceFunction(leafSrc, 'tryReserveHttpBodyBudget')
  const live = sourceWithoutComments(body)
  assert.match(live, /used \+ bytes > MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER/)
  assert.match(live, /kind:\s*'member'/)
  assert.match(live, /memberUsed\.set\(/)

  const commented = body.replace(
    /if \(used \+ bytes > MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER\) \{\s*return \{ ok: false, kind: 'member' \}\s*\}/,
    (block) =>
      block
        .split('\n')
        .map((line) => (line.trim() ? `// ${line}` : line))
        .join('\n'),
  )
  assert.doesNotMatch(
    sourceWithoutComments(commented),
    /used \+ bytes > MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER/,
    'commenting the per-member reserve must drop the live check',
  )
})

t('source-scan: three binary sites and compose JSON pass memberId', () => {
  const live = sourceWithoutComments(serverSrc)
  assert.match(
    live,
    /readBodyBytes\(req, CHAT_AVATAR_MAX_BYTES, \{\s*reserveBytes: reserve,\s*memberId: auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(
    live,
    /readBodyBytes\(req, CHAT_ATTACH_MAX_BYTES_CEILING, \{\s*reserveBytes: reserve,\s*memberId: auth\.member\.memberId,\s*\}\)/,
  )
  assert.match(live, /tryReserveHttpBodyBudget\(len, auth\.member\.memberId\)/)
  const crmReleases = live.match(/releaseHttpBodyBudget\(len, auth\.member\.memberId\)/g) ?? []
  assert.equal(crmReleases.length, 2, 'CRM exists-skip fail and finally both release with memberId')
  assert.match(
    live,
    /readJsonBody\(req, COMPOSE_SHARE_JSON_BODY_MAX, \{\s*memberId: auth\.member\.memberId,\s*\}\)/,
  )
})

// G5 (Wave 14 box 5): a caller bug that double-releases (or over-releases)
// on the BLANK (unauthenticated/guest) path used to subtract straight from
// the shared process-wide counter with no clamp of its own - eroding it
// below the true in-flight total and handing back apparent headroom that
// does not really exist, even though the erosion came from a completely
// unrelated caller on a completely unrelated (authenticated, per-member)
// reservation. This regression-tests the fix: the blank path's own refund
// is clamped to what the blank path actually has tracked
// (`blankBodyUsed`), so it can never borrow against mem_a's real share.
t('blank-path double-release cannot erode a different members tracked share (cross-caller)', () => {
  resetHttpBodyBudgetForTests()
  try {
    assert.equal(tryReserveHttpBodyBudget(HUNDRED, 'mem_a').ok, true)
    assert.equal(tryReserveHttpBodyBudget(TWENTY_FIVE, '').ok, true)
    releaseHttpBodyBudget(TWENTY_FIVE, '')
    // Double-release: the blank path has nothing left to refund. Before the
    // fix this still subtracted another 25 MiB from the SHARED processUsed
    // counter, artificially freeing 25 MiB of headroom mem_a's still-live
    // 100 MiB reservation should not have made available to anyone. Assert
    // the exposed counter directly rather than via a reservation-refusal
    // side effect: MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER (default 128 MiB)
    // is smaller than the true remaining process headroom at default sizing
    // (256 MiB - 100 MiB = 156 MiB), so a peer reservation sized to exceed
    // the true remaining would always be refused on the per-member ceiling
    // first regardless of whether processUsed had been corrupted.
    releaseHttpBodyBudget(TWENTY_FIVE, '')
    assert.equal(
      inflightHttpBodyBudgetUsed(),
      HUNDRED,
      'processUsed must still equal mem_a\'s real 100 MiB - the blank double-release must not have eroded it',
    )
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

t('blank-path download double-release cannot erode a different members tracked share (cross-caller)', () => {
  resetHttpBodyBudgetForTests()
  try {
    assert.equal(tryReserveHttpDownloadBudget(HUNDRED, 'mem_a').ok, true)
    assert.equal(tryReserveHttpDownloadBudget(TWENTY_FIVE, '').ok, true)
    releaseHttpDownloadBudget(TWENTY_FIVE, '')
    releaseHttpDownloadBudget(TWENTY_FIVE, '')
    assert.equal(
      inflightHttpDownloadBudgetUsed(),
      HUNDRED,
      'download processUsed must still equal mem_a\'s real 100 MiB share',
    )
  } finally {
    resetHttpBodyBudgetForTests()
  }
})

console.log(`http-body-budget-per-member: ${passed}/11 ok`)
