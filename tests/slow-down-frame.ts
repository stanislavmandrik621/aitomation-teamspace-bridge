/**
 * G3-BRIDGE source-scan: slow_down emit exists; reply( stays out of fan-out
 * loops (BRG-066 leftover). Strip comments before matching (TOOL-G31-066).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

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

function sliceForLoop(body: string, label: string): string {
  const forIdx = body.search(/\bfor\s*\(/)
  assert.ok(forIdx >= 0, `${label} must have a for (`)
  let i = body.indexOf('{', forIdx)
  assert.ok(i >= 0, `${label} for ( has no body`)
  let depth = 0
  for (; i < body.length; i++) {
    const c = body[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return body.slice(forIdx, i + 1)
    }
  }
  assert.fail(`${label} unclosed for (`)
}

function findNodes<T extends ts.Node>(node: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (child: ts.Node): void => {
    if (matches(child)) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function assertHttpRateResponses(src: string): void {
  const parsed = ts.createSourceFile('server.ts', src, ts.ScriptTarget.Latest, true)
  const calls = (node: ts.Node, name: string) => findNodes(node, ts.isCallExpression)
    .filter(call => ts.isIdentifier(call.expression) && call.expression.text === name)
  const refusals = findNodes(parsed, ts.isIfStatement).filter(statement => {
    const test = statement.expression
    return ts.isPrefixUnaryExpression(test) && test.operator === ts.SyntaxKind.ExclamationToken
      && ts.isCallExpression(test.operand) && ts.isIdentifier(test.operand.expression)
      && test.operand.expression.text === 'takeHttpToken'
  })
  assert.equal(refusals.length, 1, 'one canonical HTTP budget refusal')
  const refusal = refusals[0]!
  assert.ok(ts.isBlock(refusal.thenStatement))
  const statements = refusal.thenStatement.statements
  const html = statements[0]
  assert.ok(html && ts.isIfStatement(html) && ts.isBlock(html.thenStatement), 'HTML exception is scoped inside the same budget refusal')
  const condition = html.expression.getText(parsed)
  assert.match(condition, /req\.method\s*===\s*'GET'/)
  assert.match(condition, /compose.*share\|review.*\.test\(path\)/)
  assert.match(condition, /!wantsJson\(req\)/, 'JSON clients do not enter the HTML response branch')
  const htmlCalls = calls(html.thenStatement, 'sendGuestHtml')
  assert.equal(htmlCalls.length, 1)
  assert.deepEqual(htmlCalls[0]!.arguments.slice(0, 2).map(arg => arg.getText(parsed)), ['res', '429'])
  assert.equal(calls(html.thenStatement, 'guestPageDocument').length, 1)
  assert.match(html.thenStatement.getText(parsed), /setHeader\(\s*'Retry-After',\s*String\(Math\.ceil\(delay\s*\/\s*1000\)\)\)/)
  const delayCalls = calls(html.thenStatement, 'limiterPace')
  assert.equal(delayCalls.length, 1)
  assert.deepEqual(delayCalls[0]!.arguments.map(arg => arg.getText(parsed)), ['httpLimiter', 'httpKey', 'httpTokens', 'OPS_FRAME_WINDOW_MS'])
  assert.ok(ts.isReturnStatement(html.thenStatement.statements.at(-1)!))
  assert.equal(calls(html.thenStatement, 'sendRateLimited').length, 0, 'HTML branch terminates without a JSON response')

  const json = calls(refusal.thenStatement, 'sendRateLimited')
  assert.equal(json.length, 1)
  assert.ok(statements.some(statement => ts.isExpressionStatement(statement) && statement.expression === json[0]), 'ordinary JSON response is a direct fallback, not a nested unreachable branch')
  assert.equal(json[0]!.arguments[0]!.getText(parsed), 'res')
  assert.match(json[0]!.arguments[1]!.getText(parsed), /^limiterPace\(httpLimiter,\s*httpKey,\s*httpTokens,\s*OPS_FRAME_WINDOW_MS\)\.waitMs$/)
  assert.equal(json[0]!.arguments[2]!.getText(parsed), "'Rate limited - slow down'")
  const drain = calls(refusal.thenStatement, 'drainRequestBody')
  assert.equal(drain.length, 1)
  assert.ok(drain[0]!.getStart(parsed) > html.end && drain[0]!.end < json[0]!.getStart(parsed), 'fallback drains request before JSON rate response')
  assert.ok(ts.isReturnStatement(statements.at(-1)!))
}

describe('G3-BRIDGE slow_down frame', () => {
  it('BridgeFrame includes additive slow_down with waitMs', () => {
    const clean = sourceWithoutComments(indexSrc)
    assert.match(clean, /type:\s*'slow_down'/)
    assert.match(clean, /waitMs:\s*number/)
    assert.match(clean, /reason\?:\s*'rate'\s*\|\s*'backpressure'\s*\|\s*'busy'/)
    assert.doesNotMatch(clean, /BRIDGE_PROTOCOL_VERSION\s*=\s*3/)
  })

  it('emitSlowDown and sendRateLimited exist and keep refuse / 429 text', () => {
    const emitFn = sourceWithoutComments(sliceNamedFunction(server, 'emitSlowDown'))
    assert.match(emitFn, /type:\s*'slow_down'/)
    assert.match(emitFn, /waitMs/)
    assert.match(emitFn, /\breply\s*\(/, '1:1 emit may reply()')

    const sendFn = sourceWithoutComments(sliceNamedFunction(server, 'sendRateLimited'))
    assert.match(sendFn, /setHeader\(\s*'Retry-After'/)
    assert.match(sendFn, /sendJson\(\s*res,\s*429/)
    assert.doesNotMatch(sendFn, /guest|PIN|password attempts/i)
  })

  it('handleOps takeOpsToken fail emits slow_down BEFORE the existing error', () => {
    const body = sourceWithoutComments(sliceNamedFunction(server, 'handleOps'))
    const failIdx = body.indexOf('if (!takeOpsToken(session))')
    assert.ok(failIdx >= 0, 'takeOpsToken fail branch exists')
    const failEnd = body.indexOf('if (!Array.isArray(ops))', failIdx)
    assert.ok(failEnd > failIdx, 'ops array check follows takeOpsToken')
    const fail = body.slice(failIdx, failEnd)
    const hintIdx = fail.search(/emitSlowDown\s*\(/)
    const refuseIdx = fail.indexOf("Rate limited - slow down")
    assert.ok(hintIdx >= 0, 'fail branch must call emitSlowDown')
    assert.ok(refuseIdx > hintIdx, 'existing error text stays AFTER the hint')
    assert.match(fail, /opsWaitMs\s*\(\s*session\s*\)/)
    assert.match(body, /maybeHintOpsApproaching\s*\(/)
  })

  it('hello takeHelloToken fail emits slow_down BEFORE hello_refuse', () => {
    const caseIdx = server.indexOf("case 'hello':")
    assert.ok(caseIdx > 0, 'hello case exists')
    const nextCase = server.indexOf("case '", caseIdx + 10)
    const window = sourceWithoutComments(server.slice(caseIdx, nextCase))
    const failIdx = window.indexOf('if (!takeHelloToken(connIp))')
    assert.ok(failIdx >= 0, 'takeHelloToken fail branch exists')
    const failEnd = window.indexOf('const memberId', failIdx)
    assert.ok(failEnd > failIdx, 'memberId parse follows hello token')
    const fail = window.slice(failIdx, failEnd)
    const hintIdx = fail.search(/emitSlowDown\s*\(/)
    const refuseIdx = fail.indexOf("Rate limited - slow down")
    assert.ok(hintIdx >= 0, 'hello fail must call emitSlowDown')
    assert.ok(refuseIdx > hintIdx, 'hello_refuse text stays AFTER the hint')
    assert.match(fail, /type:\s*'hello_refuse'/)
    assert.match(window, /maybeHintLimiterApproaching\s*\(/)
  })

  it('HTTP pace 429s use sendRateLimited; guest / PIN lockout does not', () => {
    const clean = sourceWithoutComments(server)
    assertHttpRateResponses(server)
    assert.match(clean, /if\s*\(\s*!takeBlobToken\(auth\.member\.memberId\)\s*\)[\s\S]{0,240}sendRateLimited\s*\(/)
    assert.match(clean, /if\s*\(\s*!takeChatBlobPutToken\(auth\.member\.memberId\)\s*\)[\s\S]{0,280}sendRateLimited\s*\(/)
    assert.match(clean, /Attachment upload rate limited/)

    const guestPwd = clean.indexOf('Too many wrong password attempts. Try again later.')
    assert.ok(guestPwd > 0, 'guest password lockout text remains')
    const guestWindow = clean.slice(Math.max(0, guestPwd - 180), guestPwd + 80)
    assert.match(guestWindow, /sendJson\(\s*res,\s*429/)
    assert.doesNotMatch(guestWindow, /sendRateLimited/)

    const pin = clean.indexOf('Too many wrong PIN attempts. Try again later.')
    assert.ok(pin > 0, 'PIN lockout text remains')
    const pinWindow = clean.slice(Math.max(0, pin - 180), pin + 80)
    assert.match(pinWindow, /sendJson\(\s*res,\s*429/)
    assert.doesNotMatch(pinWindow, /sendRateLimited/)

    assert.match(
      clean,
      /if\s*\(\s*!takeGuestDownloadToken\s*\([\s\S]{0,400}sendRateLimited\s*\(/,
      'Compose pack download pace 429 must use sendRateLimited (Retry-After)',
    )
    const dlIdx = clean.indexOf('if (!takeGuestDownloadToken')
    assert.ok(dlIdx >= 0, 'takeGuestDownloadToken fail exists')
    const dl = clean.slice(dlIdx, dlIdx + 520)
    assert.match(dl, /guestDownloadLimiter/)
    assert.match(dl, /guestdl:\$\{downloadIp\}/)
    assert.match(dl, /error_code:\s*'share\.rate_limited'/)
    assert.match(dl, /GUEST_DOWNLOAD_TOKENS_PER_WINDOW/)
  })

  it('HTTP source contract rejects a missing HTML 429 or JSON fallback', () => {
    assert.throws(() => assertHttpRateResponses(server.replace('sendGuestHtml(res, 429, guestPageDocument', 'sendGuestHtml(res, 200, guestPageDocument')))
    assert.throws(() => assertHttpRateResponses(server.replace("sendRateLimited(res, limiterPace(httpLimiter, httpKey, httpTokens, OPS_FRAME_WINDOW_MS).waitMs, 'Rate limited - slow down')", 'sendJson(res, 200, { ok: true })')))
    assert.throws(() => assertHttpRateResponses(server.replaceAll('&& !wantsJson(req)', '&& wantsJson(req)')))
  })

  it('leftover chat TokenBucket fails emit slow_down before refuse', () => {
    const clean = sourceWithoutComments(server)
    const leftover: Array<{ take: string; key: string; min: number }> = [
      { take: 'takeChatHistoryToken', key: 'chathist:', min: 1 },
      { take: 'takeChatMutateToken', key: 'chatmutate:', min: 4 },
      { take: 'takeChatRoomsListToken', key: 'chatrooms:', min: 1 },
      { take: 'takeChatRoomAdminToken', key: 'chatroomadmin:', min: 16 },
      { take: 'takeChatUnreadToken', key: 'chatunread:', min: 1 },
      { take: 'takeChatTypingToken', key: 'chattype:', min: 1 },
      { take: 'takeChatReactToken', key: 'chatreact:', min: 1 },
      { take: 'takeChatSearchToken', key: 'chatsearch:', min: 2 },
      { take: 'takeChatExportToken', key: 'chatexport:', min: 1 },
      { take: 'takeProfileUpdateToken', key: 'profile:', min: 1 },
    ]
    for (const row of leftover) {
      const needle = `!${row.take}(`
      const fails: string[] = []
      let from = 0
      while (true) {
        const idx = clean.indexOf(needle, from)
        if (idx < 0) break
        const ifIdx = clean.lastIndexOf('if (', idx)
        assert.ok(ifIdx >= 0 && idx - ifIdx < 80, `${row.take} fail must sit in if (`)
        fails.push(clean.slice(ifIdx, ifIdx + 420))
        from = idx + needle.length
      }
      assert.ok(fails.length >= row.min, `${row.take} expected at least ${row.min} fails, got ${fails.length}`)
      for (const fail of fails) {
        const hintIdx = fail.search(/emitSlowDown\s*\(/)
        const refuseIdx = fail.search(/reply\s*\(/)
        assert.ok(hintIdx >= 0, `${row.take} fail must call emitSlowDown`)
        assert.ok(refuseIdx > hintIdx, `${row.take} refuse stays AFTER emitSlowDown`)
        assert.match(fail, /limiterPace\s*\(/)
        assert.match(fail, /chatLimiter/)
        assert.match(fail, new RegExp(row.key.replace(':', '\\:')))
      }
    }

    const joinIdx = clean.indexOf('if (!takeChatPasswordJoinToken')
    assert.ok(joinIdx >= 0, 'password-join take remains')
    const join = clean.slice(joinIdx, joinIdx + 280)
    assert.doesNotMatch(join, /emitSlowDown/, 'password-join lockout stays hint-free')
    assert.match(join, /Too many password attempts/)
  })

  it('fan-out loops warn without reply( (BRG-066 leftover)', () => {
    const warnFn = sourceWithoutComments(sliceNamedFunction(server, 'maybeWarnFanoutBackpressure'))
    assert.match(warnFn, /FANOUT_BACKPRESSURE_WARN_BYTES/)
    assert.match(warnFn, /sendSerializedFrame/)
    assert.doesNotMatch(warnFn, /\breply\s*\(/)

    for (const name of ['fanoutYjsUpdate', 'fanoutYjsAwareness'] as const) {
      const body = sourceWithoutComments(sliceNamedFunction(server, name))
      assert.match(body, /maybeWarnFanoutBackpressure\s*\(/)
      const loop = sliceForLoop(body, name)
      assert.doesNotMatch(loop, /\breply\s*\(/, `${name} for-loop must not call reply(`)
    }

    assert.match(sliceNamedFunction(server, 'handleOps'), /sendColleagueScopedOps\(ws, frameId, applied\)/)
    const bucketed = sourceWithoutComments(sliceNamedFunction(server, 'sendColleagueScopedOps'))
    assert.match(bucketed, /maybeWarnFanoutBackpressure\s*\(/)
    assert.doesNotMatch(bucketed, /\breply\s*\(/, 'current-ACL fanout must not reserialize per peer')
  })
})
