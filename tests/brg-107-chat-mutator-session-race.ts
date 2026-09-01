/**
 * BRG-107: `handleMessage`'s `chat_send` and `chat_delete` both re-check
 * `sessionStillAuthorized(ws, session)` at the moment their mutation's
 * promise resolves (TCC-R1151-BRG-002 for `chat_send`, same pattern for
 * `chat_delete`) - closing the window where a member kicked/removed mid-
 * flight would otherwise still get a reply and peer fan-out for a write
 * that was dispatched before the kick landed. `chat_react`, `chat_edit`,
 * and `chat_pin` skipped that same re-check, so a kicked member's
 * in-flight reaction/edit/pin could still land on peers' screens for the
 * gap between their kick and their next reconnect-driven auth refresh.
 *
 * Fix: `chat_edit`, `chat_react`, and `chat_pin` now call
 * `sessionStillAuthorized(ws, session)` as the FIRST statement inside the
 * `.then()` callback that follows their store mutation
 * (`chatStore.edit`/`chatStore.react`/`chatStore.pinMessage`/
 * `chatStore.unpinMessage`), before the `'error' in <result>` check and
 * before any reply/fan-out - identical placement, shape, and refuse
 * behavior (a silent `return`, same as `chat_send`/`chat_delete`) to the
 * two mutators that already had this guard.
 *
 * This is a source-scan pin: `server.ts` starts an HTTP/WS listener at
 * module import time (`server.listen(...)` at the bottom of the file) and
 * cannot be safely imported in a unit test process, exactly the same
 * constraint already documented in `wave2-brg-hardening.ts` and
 * `brg-106-origin-role-stamp.ts`. Every assertion below is proven
 * load-bearing via an explicit PIN-BREAK case (mutate the sliced source
 * string to reproduce the regression, assert the checker now returns
 * false / the match now fails, then prove the un-mutated source still
 * passes).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/**
 * Find the index of the `{` at `openIndex`'s matching `}`, skipping braces
 * that appear inside line comments, block comments, single/double-quoted
 * strings, and template literals (including `${...}` template expressions,
 * which can themselves contain real code braces one level deep). A naive
 * depth counter over raw characters breaks the moment it walks through a
 * string/template literal containing an unmatched `{` or `}` (server.ts's
 * `handleMessage` (the switch that dispatches every `chat_*` op kind) is
 * thousands of lines long and full of reply-string templates) - it can
 * silently close "the function" hundreds of lines early and then report
 * "missing case 'x'" for a case that is very much still inside the real
 * function body. This tokenizer-lite scan is what makes slicing safe. (This
 * is a DIFFERENT function from `handleOps`, the smaller `ops`-frame handler
 * BRG-106's pin slices - the task brief called the chat dispatcher
 * "handleOps" informally, but the real switch lives in `handleMessage`.)
 */
function findMatchingBrace(src: string, openIndex: number): number {
  assert.equal(src[openIndex], '{', 'findMatchingBrace must start on an opening brace')
  let depth = 0
  let i = openIndex
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i)
      i = nl < 0 ? n : nl + 1
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      const quote = c
      i += 1
      while (i < n && src[i] !== quote) i += src[i] === '\\' ? 2 : 1
      i += 1
      continue
    }
    if (c === '`') {
      i += 1
      let tplExprDepth = 0
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue }
        if (tplExprDepth === 0 && src[i] === '`') { i += 1; break }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; tplExprDepth += 1; continue }
        if (tplExprDepth > 0 && src[i] === '{') { tplExprDepth += 1; i += 1; continue }
        if (tplExprDepth > 0 && src[i] === '}') { tplExprDepth -= 1; i += 1; continue }
        i += 1
      }
      continue
    }
    if (c === '{') { depth += 1; i += 1; continue }
    if (c === '}') {
      depth -= 1
      if (depth === 0) return i
      i += 1
      continue
    }
    i += 1
  }
  return -1
}

function sliceFunction(src: string, name: string): string {
  const re = new RegExp(`\\nfunction ${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing function ${name}(`)
  const start = m.index + 1
  let braceStart = start
  while (braceStart < src.length && src[braceStart] !== '{') braceStart += 1
  assert.equal(src[braceStart], '{', `no body for ${name}`)
  const end = findMatchingBrace(src, braceStart)
  assert.ok(end >= 0, `unclosed function ${name}`)
  return src.slice(start, end + 1)
}

/** Bound a `case '<name>': { ... }` block inside handleMessage's switch. */
function sliceCase(handleMessageBody: string, caseName: string): string {
  const re = new RegExp(`case '${caseName}':\\s*\\{`)
  const m = re.exec(handleMessageBody)
  assert.ok(m, `missing case '${caseName}':`)
  const braceStart = handleMessageBody.indexOf('{', m.index)
  assert.ok(braceStart >= 0)
  const end = findMatchingBrace(handleMessageBody, braceStart)
  assert.ok(end >= 0, `unclosed case ${caseName}`)
  return handleMessageBody.slice(braceStart, end + 1)
}

/**
 * Bound the `.then((<param>) => { ... })` callback whose parameter is
 * `param` (the settled mutation result) - this is the exact scope
 * `chat_send`/`chat_delete` place their `sessionStillAuthorized` check
 * inside, and the exact scope the fix adds it to for edit/react/pin.
 */
function sliceThenCallback(caseBody: string, param: string): string {
  const re = new RegExp(`\\.then\\(\\(${param}\\)\\s*=>\\s*\\{`)
  const m = re.exec(caseBody)
  assert.ok(m, `missing .then((${param}) => {`)
  const braceStart = caseBody.indexOf('{', m.index)
  assert.ok(braceStart >= 0)
  const end = findMatchingBrace(caseBody, braceStart)
  assert.ok(end >= 0, `unclosed .then((${param}) => {...}) callback`)
  return caseBody.slice(braceStart, end + 1)
}

/**
 * The regression this pin exists to catch: the callback missing the
 * `sessionStillAuthorized` re-check entirely, OR the check present but
 * placed AFTER the `'error' in <resultVar>` check (too late - a reply or
 * fan-out could already have started down the error branch, and the
 * intent is to refuse BEFORE any reply/fan-out decision is made).
 */
function thenCallbackRechecksSessionBeforeErrorHandling(
  thenCallback: string,
  resultVar: string,
): boolean {
  const live = sourceWithoutComments(thenCallback)
  const checkIdx = live.search(/if\s*\(!sessionStillAuthorized\(ws,\s*session\)\)/)
  const errorIdx = live.search(new RegExp(`if\\s*\\(\\s*'error'\\s*in\\s*${resultVar}\\s*\\)`))
  if (checkIdx < 0) return false
  if (errorIdx < 0) return false
  return checkIdx < errorIdx
}

t('handleMessage chat_edit re-checks sessionStillAuthorized before its error/reply/fanout branch', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_edit')
  const thenCb = sliceThenCallback(caseBody, 'edited')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(thenCb, 'edited'),
    true,
    'chat_edit must call sessionStillAuthorized(ws, session) before checking `\'error\' in edited`',
  )
})

t('handleMessage chat_react re-checks sessionStillAuthorized before its error/reply/fanout branch', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_react')
  const thenCb = sliceThenCallback(caseBody, 'reacted')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(thenCb, 'reacted'),
    true,
    'chat_react must call sessionStillAuthorized(ws, session) before checking `\'error\' in reacted`',
  )
})

t('handleMessage chat_pin re-checks sessionStillAuthorized before its error/reply/fanout branch', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_pin')
  const thenCb = sliceThenCallback(caseBody, 'pinned')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(thenCb, 'pinned'),
    true,
    'chat_pin must call sessionStillAuthorized(ws, session) before checking `\'error\' in pinned`',
  )
})

t('REGRESSION GUARD: chat_send still re-checks sessionStillAuthorized (TCC-R1151-BRG-002 unchanged)', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_send')
  const thenCb = sliceThenCallback(caseBody, 'appended')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(thenCb, 'appended'),
    true,
    'chat_send must keep its pre-existing sessionStillAuthorized re-check before `\'error\' in appended`',
  )
})

t('REGRESSION GUARD: chat_delete still re-checks sessionStillAuthorized', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_delete')
  const thenCb = sliceThenCallback(caseBody, 'del')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(thenCb, 'del'),
    true,
    'chat_delete must keep its pre-existing sessionStillAuthorized re-check before `\'error\' in del`',
  )
})

t('PIN-BREAK: removing the chat_edit session re-check fails this pin (proves it is load-bearing)', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_edit')
  const thenCb = sliceThenCallback(caseBody, 'edited')
  const regressed = thenCb.replace(
    /\n\s*if \(!sessionStillAuthorized\(ws, session\)\) return\n/,
    '\n',
  )
  assert.notEqual(regressed, thenCb, 'fixture setup must actually remove the check line')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(regressed, 'edited'),
    false,
    'pin-break: a chat_edit .then() callback missing the session re-check must fail this pin',
  )
})

t('PIN-BREAK: removing the chat_react session re-check fails this pin', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_react')
  const thenCb = sliceThenCallback(caseBody, 'reacted')
  const regressed = thenCb.replace(
    /\n\s*if \(!sessionStillAuthorized\(ws, session\)\) return\n/,
    '\n',
  )
  assert.notEqual(regressed, thenCb, 'fixture setup must actually remove the check line')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(regressed, 'reacted'),
    false,
    'pin-break: a chat_react .then() callback missing the session re-check must fail this pin',
  )
})

t('PIN-BREAK: removing the chat_pin session re-check fails this pin', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_pin')
  const thenCb = sliceThenCallback(caseBody, 'pinned')
  const regressed = thenCb.replace(
    /\n\s*if \(!sessionStillAuthorized\(ws, session\)\) return\n/,
    '\n',
  )
  assert.notEqual(regressed, thenCb, 'fixture setup must actually remove the check line')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(regressed, 'pinned'),
    false,
    'pin-break: a chat_pin .then() callback missing the session re-check must fail this pin',
  )
})

t('PIN-BREAK: moving the chat_edit check AFTER the error branch fails this pin (placement matters)', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_edit')
  const thenCb = sliceThenCallback(caseBody, 'edited')
  // Simulate the check existing but placed too late (after the error
  // return) - the regression this guards is not "check missing" but
  // "check exists somewhere in this function, order not verified".
  const stripped = thenCb.replace(
    /\n\s*if \(!sessionStillAuthorized\(ws, session\)\) return\n/,
    '\n',
  )
  const regressed = stripped.replace(
    /(reply\(ws, \{ type: 'chat_edit_ok', frameId, message \}\)\n)/,
    `$1            if (!sessionStillAuthorized(ws, session)) return\n`,
  )
  assert.notEqual(regressed, stripped, 'fixture setup must actually relocate the check')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(regressed, 'edited'),
    false,
    'pin-break: a session re-check placed after the reply/fan-out must fail this pin',
  )
})

t('PIN-BREAK: swapping to a client-trusting session read fails this pin', () => {
  const body = sliceFunction(serverSrc, 'handleMessage')
  const caseBody = sliceCase(body, 'chat_react')
  const thenCb = sliceThenCallback(caseBody, 'reacted')
  // A weaker "fix" that checks the frame's own claim instead of the live
  // session table must not satisfy this pin.
  const regressed = thenCb.replace(
    /if \(!sessionStillAuthorized\(ws, session\)\) return/,
    'if (frame.stillAuthorized === false) return',
  )
  assert.notEqual(regressed, thenCb, 'fixture setup must actually swap the check')
  assert.equal(
    thenCallbackRechecksSessionBeforeErrorHandling(regressed, 'reacted'),
    false,
    'pin-break: trusting a client-supplied flag instead of sessionStillAuthorized must fail this pin',
  )
})

t('sessionStillAuthorized itself re-validates against the LIVE session table (unchanged contract)', () => {
  const fn = sliceFunction(serverSrc, 'sessionStillAuthorized')
  const live = sourceWithoutComments(fn)
  assert.match(live, /live\.has\(ws\)/, 'must consult the live WebSocket->session map')
  assert.match(live, /store\.findMember\(session\.memberId\)/, 'must re-check the member still exists in the live store (kick/removal)')
})

console.log(`brg-107-chat-mutator-session-race: ${passed}/11 ok`)
assert.equal(passed, 11, 'expected exactly 11 assertions to run')
