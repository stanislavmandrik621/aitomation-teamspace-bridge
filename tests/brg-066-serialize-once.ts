/**
 * Pins BRG-066: a broadcast serializes its frame once per fan-out, never
 * once per recipient. `server.ts` starts a real HTTP+WS server as a module
 * side effect, so server wiring is a source-scan (same constraint as
 * `tests/server-hardening-pins.ts` / `tests/ws-peer-close.ts`).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeBridgeFrame, sendSerializedFrame } from '../src/ws-frame-send.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const helperSrc = readFileSync(join(root, 'src/ws-frame-send.ts'), 'utf8')

const FANOUT_FN_FLOOR = 17

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

function derivedFanoutNames(src: string): string[] {
  const names: string[] = []
  const re = /^function (fanout[A-Za-z0-9]*)\(/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    names.push(m[1])
  }
  return names
}

/**
 * Extract a single `for (...) { ... }` (or braceless `for (...) stmt;`)
 * loop's header + body starting at the `for` keyword's index. Both shapes
 * are used in this file (`closeEphemeralRoomNow`'s per-member relay is a
 * braceless single statement) - treating braceless as "unsupported" would
 * silently skip checking it for a reserialize-inside-the-loop bug.
 */
function extractForLoopHeaderAndBody(
  src: string,
  forIdx: number,
): { header: string; body: string; bodyEnd: number } | null {
  let i = src.indexOf('(', forIdx)
  if (i < 0) return null
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
  const header = src.slice(forIdx, i)
  while (i < src.length && /\s/.test(src[i])) i += 1
  if (src[i] === '{') {
    const bodyStart = i
    depth = 0
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') depth += 1
      else if (c === '}') {
        depth -= 1
        if (depth === 0) return { header, body: src.slice(bodyStart, i + 1), bodyEnd: i + 1 }
      }
    }
    return null
  }
  // Braceless: this codebase's style omits statement-terminating semicolons
  // (ASI), so a `for (...) stmt` line ends at bracket-depth-0 `;` OR the
  // next newline, whichever comes first. Never return null once bodyStart
  // is known - a silently-skipped loop is a silent false pass, the exact
  // failure mode `assertSerializeOnceLoop` exists to prevent.
  const bodyStart = i
  let pdepth = 0
  for (; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') pdepth += 1
    else if (c === ')' || c === '}' || c === ']') pdepth -= 1
    else if (pdepth <= 0 && (c === ';' || c === '\n')) break
  }
  return { header, body: src.slice(bodyStart, i), bodyEnd: i }
}

/**
 * Drop every nested `for (...) { ... }` loop's header+body out of `body`,
 * leaving only the content this loop owns directly. A BRG-061 byte-page
 * loop legitimately wraps `serializeBridgeFrame` around an inner
 * per-recipient loop - stripping the inner loop before checking "does this
 * loop directly call send" is what tells the outer page loop apart from
 * the actual recipient loop underneath it.
 */
function stripNestedForLoops(text: string): string {
  let result = text
  for (let guard = 0; guard < 500; guard++) {
    const idx = result.search(/\bfor\s*\(/)
    if (idx < 0) break
    const res = extractForLoopHeaderAndBody(result, idx)
    if (!res) break
    result = result.slice(0, idx) + result.slice(res.bodyEnd)
  }
  return result
}

// Any `.send(` call marks its enclosing loop as a recipient loop, whatever
// identifier is passed - a hand-typed variable-name allowlist would silently
// stop matching the next helper that names its serialized text differently.
const SEND_CALL_RE = /\bsendSerializedFrame\s*\(|\bsendSerializedToLiveMember\s*\(|\.send\s*\(/
const RESERIALIZE_RE = /serializeBridgeFrame\s*\(|JSON\.stringify\s*\(/

/**
 * BRG-066 invariant: the loop that actually iterates recipients and calls
 * send must never (re)serialize inside its own body. An outer BRG-061
 * byte-page loop may legitimately serialize once per page BEFORE handing
 * off to an inner per-recipient loop - that outer loop is not itself the
 * recipient loop and is not held to "no serialize inside", only the
 * innermost loop that actually owns the send call is. A single-target
 * relay (`sendToLiveMember`) has no loop at all and is not required to
 * have one - the unconditional checks above (serializeBridgeFrame present,
 * no reply()) already cover it.
 */
function assertSerializeOnceLoop(body: string, label: string): void {
  assert.match(body, /serializeBridgeFrame\s*\(/, `${label} must call serializeBridgeFrame`)
  assert.doesNotMatch(body, /\breply\s*\(/, `${label} must not call reply( for a shared frame`)
  const re = /\bfor\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const res = extractForLoopHeaderAndBody(body, m.index)
    if (!res) continue
    const direct = stripNestedForLoops(res.body)
    if (SEND_CALL_RE.test(direct)) {
      assert.doesNotMatch(
        direct,
        RESERIALIZE_RE,
        `${label}: the loop that sends to each recipient must not (re)serialize per recipient`,
      )
    }
  }
}

type FakeWs = {
  readyState: number
  OPEN: number
  bufferedAmount: number
  sent: string[]
  send: (data: string) => void
}

function makeFakeWs(opts?: { readyState?: number; bufferedAmount?: number }): FakeWs {
  const sent: string[] = []
  return {
    readyState: opts?.readyState ?? 1,
    OPEN: 1,
    bufferedAmount: opts?.bufferedAmount ?? 0,
    sent,
    send(data: string) {
      sent.push(data)
    },
  }
}

function withStringifyCount<T>(fn: (getCount: () => number) => T): T {
  const orig = JSON.stringify
  let count = 0
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    count += 1
    return orig.apply(JSON, args)
  }) as typeof JSON.stringify
  try {
    return fn(() => count)
  } finally {
    JSON.stringify = orig
  }
}

describe('BRG-066 test-helper self-check: assertSerializeOnceLoop is load-bearing', () => {
  it('still red on the classic per-recipient stringify bug (flat loop)', () => {
    const bad = `{
      for (const peer of sockets) {
        const text = serializeBridgeFrame(frame)
        sendSerializedFrame(peer, text, FANOUT_BACKPRESSURE_BYTES)
      }
    }`
    assert.throws(() => assertSerializeOnceLoop(bad, 'synthetic-flat-bug'), /must not \(re\)serialize per recipient/)
  })

  it('still red on the same bug wrapped in a legitimate-looking outer page loop', () => {
    const bad = `{
      for (const chunk of frames) {
        for (const peer of sockets) {
          const text = serializeBridgeFrame(frame)
          sendSerializedFrame(peer, text, FANOUT_BACKPRESSURE_BYTES)
        }
      }
    }`
    assert.throws(() => assertSerializeOnceLoop(bad, 'synthetic-nested-bug'), /must not \(re\)serialize per recipient/)
  })

  it('green on a real BRG-061 byte-page shape: serialize once per page, plain send in the inner loop', () => {
    const good = `{
      for (const chunk of frames) {
        const text = serializeBridgeFrame(out)
        for (const [peer] of live) {
          if (!sendSerializedFrame(peer, text, FANOUT_BACKPRESSURE_BYTES)) {
            forceCloseBackpressured(peer, 'ops fanout backpressure')
          }
        }
      }
    }`
    assert.doesNotThrow(() => assertSerializeOnceLoop(good, 'synthetic-good-paginated'))
  })

  it('green when a loop has nothing to do with sending (no false positive on unrelated loops)', () => {
    const unrelated = `{
      const text = serializeBridgeFrame(frame)
      for (const x of somethingUnrelated) {
        doSomethingElse(x)
      }
    }`
    assert.doesNotThrow(() => assertSerializeOnceLoop(unrelated, 'synthetic-unrelated-loop'))
  })

  it('green on a single-target relay with no loop at all (sendToLiveMember shape)', () => {
    const singleTarget = `{
      return sendSerializedToLiveMember(memberId, serializeBridgeFrame(frame))
    }`
    assert.doesNotThrow(() => assertSerializeOnceLoop(singleTarget, 'synthetic-single-target'))
  })

  it('still red on a braceless single-statement loop that reserializes per recipient', () => {
    const bad = `{
      const frame = { type: 'x' }
      for (const id of memberIds) sendSerializedToLiveMember(id, serializeBridgeFrame(frame))
    }`
    assert.throws(() => assertSerializeOnceLoop(bad, 'synthetic-braceless-bug'), /must not \(re\)serialize per recipient/)
  })

  it('green on the real braceless relay shape (closeEphemeralRoomNow)', () => {
    const good = `{
      const text = serializeBridgeFrame(frame)
      for (const id of r.memberIds) sendSerializedToLiveMember(id, text)
    }`
    assert.doesNotThrow(() => assertSerializeOnceLoop(good, 'synthetic-braceless-good'))
  })
})

describe('BRG-066 helper - serialize once', () => {
  it('50 sockets, one fat frame: JSON.stringify runs once and every send is the same string', () => {
    const frame = {
      type: 'ops',
      frameId: 'fan-brg-066',
      ops: Array.from({ length: 80 }, (_, i) => ({
        opId: `op-${i}`,
        kind: 'record.update',
        pad: 'x'.repeat(256),
      })),
    }
    withStringifyCount((getCount) => {
      const text = serializeBridgeFrame(frame)
      const sockets = Array.from({ length: 50 }, () => makeFakeWs())
      for (const ws of sockets) {
        const ok = sendSerializedFrame(ws, text, 2 * 1024 * 1024)
        assert.equal(ok, true)
      }
      assert.equal(getCount(), 1, 'fan-out must stringify exactly once')
      for (const ws of sockets) {
        assert.equal(ws.sent.length, 1)
        assert.equal(ws.sent[0], text)
        assert.ok(ws.sent[0] === text, 'every peer must receive the identical serialized string')
      }
    })
  })

  it('backpressure and not-OPEN skip send and do not re-stringify', () => {
    const frame = { type: 'presence_snapshot', peers: [{ id: 'm1' }] }
    withStringifyCount((getCount) => {
      const text = serializeBridgeFrame(frame)
      assert.equal(getCount(), 1)
      const blocked = makeFakeWs({ bufferedAmount: 200 })
      const closed = makeFakeWs({ readyState: 3 })
      assert.equal(sendSerializedFrame(blocked, text, 100), false)
      assert.equal(sendSerializedFrame(closed, text, 2 * 1024 * 1024), false)
      assert.equal(blocked.sent.length, 0)
      assert.equal(closed.sent.length, 0)
      assert.equal(getCount(), 1, 'skip paths must not stringify again')
    })
  })

  it('sendSerializedFrame never stringifies (source + runtime)', () => {
    const sendFn = sliceNamedFunction(helperSrc, 'sendSerializedFrame')
    assert.doesNotMatch(sendFn, /JSON\.stringify/, 'sendSerializedFrame must send the given string')
    assert.match(sendFn, /ws\.send\(\s*text\s*\)/, 'sendSerializedFrame must call ws.send(text)')
    const serFn = sliceNamedFunction(helperSrc, 'serializeBridgeFrame')
    assert.match(serFn, /JSON\.stringify\(\s*frame\s*\)/, 'serializeBridgeFrame is the one stringify')
    assert.doesNotMatch(
      helperSrc,
      /const FANOUT_BACKPRESSURE_BYTES/,
      'leaf must not own the backpressure constant',
    )

    withStringifyCount((getCount) => {
      const ws = makeFakeWs()
      assert.equal(sendSerializedFrame(ws, '{"type":"ping"}', 1024), true)
      assert.equal(getCount(), 0)
      assert.equal(ws.sent[0], '{"type":"ping"}')
    })
  })
})

describe('BRG-066 source-scan server.ts', () => {
  it('function reply has no JSON.stringify and routes through the helper', () => {
    const body = sliceNamedFunction(server, 'reply')
    assert.doesNotMatch(body, /JSON\.stringify/)
    assert.match(body, /sendSerializedFrame/)
    assert.match(body, /serializeBridgeFrame/)
  })

  it('named same-frame fan-outs serialize before for ( and do not call reply(', () => {
    const named = [
      'fanoutYjsUpdate',
      'fanoutYjsAwareness',
      'fanoutToAdmins',
      'fanoutAll',
      'fanoutChatCapsPeer',
      'sendToLiveMember',
      'sendToOtherLiveMembers',
      'schedulePresenceFanoutBroadcast',
    ]
    for (const name of named) {
      assertSerializeOnceLoop(sliceNamedFunction(server, name), name)
    }

    const sendLive = sliceNamedFunction(server, 'sendToLiveMember')
    assert.match(sendLive, /sendSerializedToLiveMember/)
    assert.doesNotMatch(sendLive, /\breply\s*\(/)

    const sendOther = sliceNamedFunction(server, 'sendToOtherLiveMembers')
    assert.doesNotMatch(sendOther, /sendToLiveMember\s*\(/, 'must not re-stringify per member via sendToLiveMember')
    assert.match(sendOther, /sendSerializedToLiveMember/)

    const walk = sliceNamedFunction(server, 'sendSerializedToLiveMember')
    assert.match(walk, /sendSerializedFrame/)
    assert.doesNotMatch(walk, /JSON\.stringify/)
    assert.doesNotMatch(walk, /\breply\s*\(/)
  })

  it('every function fanout* is serialize-once (derived, floored)', () => {
    const names = derivedFanoutNames(server)
    assert.ok(
      names.length >= FANOUT_FN_FLOOR,
      `expected at least ${FANOUT_FN_FLOOR} function fanout* declarations, got ${names.length}: ${names.join(', ')}`,
    )
    for (const name of names) {
      assertSerializeOnceLoop(sliceNamedFunction(server, name), name)
    }
  })

  it('handleOps team-wide loop serializes once; scoped ops bucket by payload and serialize once per bucket', () => {
    const teamWideIdx = server.indexOf('const teamWide = applied.filter')
    const scopedIdx = server.indexOf('if (scoped.length > 0)', teamWideIdx)
    assert.ok(teamWideIdx > 0 && scopedIdx > teamWideIdx, 'team-wide / scoped split exists')
    const teamWide = server.slice(teamWideIdx, scopedIdx)
    assertSerializeOnceLoop(teamWide, 'handleOps team-wide')
    assert.match(teamWide, /sendSerializedFrame/)
    assert.match(teamWide, /forceCloseBackpressured\(peer, 'ops fanout backpressure'\)/)

    // Scoped ops can differ per peer (visibility), so a naive single shared
    // frame is wrong here - but a raw per-peer reply() would re-stringify
    // per peer too. The current design buckets peers by identical resolved
    // payload and serializes once per bucket (BRG-066 comment on the fn).
    const scopedEnd = server.indexOf('function requireAdmin', scopedIdx)
    const scoped = server.slice(scopedIdx, scopedEnd)
    assert.match(scoped, /sendColleagueScopedOps\s*\(/, 'scoped ops delegate to the bucketed serialize-once helper')
    assert.doesNotMatch(
      scoped,
      /\breply\s*\(\s*peer,/,
      'scoped ops must not fall back to a raw per-peer reply(peer, ...) that would re-stringify per peer',
    )

    const scopedFn = sliceNamedFunction(server, 'sendColleagueScopedOps')
    assertSerializeOnceLoop(scopedFn, 'sendColleagueScopedOps')
    assert.match(scopedFn, /forceCloseBackpressured\(peer, 'ops fanout backpressure'\)/)
  })

  it('set_team_name / set_role / ephemeral shared-frame loops serialize once', () => {
    const nameCase = server.indexOf("case 'set_team_name':")
    const kickCase = server.indexOf("case 'kick_member':", nameCase)
    const nameWin = server.slice(server.indexOf('const peerFrame: BridgeFrame', nameCase), kickCase)
    assertSerializeOnceLoop(nameWin, 'set_team_name team_name_peer')

    const roleCase = server.indexOf("case 'set_role':")
    const inviteCase = server.indexOf("case 'invite_list':", roleCase)
    const roleWin = server.slice(server.indexOf('const rolePeer: BridgeFrame', roleCase), inviteCase)
    assertSerializeOnceLoop(roleWin, 'set_role role_peer')

    assertSerializeOnceLoop(sliceNamedFunction(server, 'closeEphemeralRoomNow'), 'closeEphemeralRoomNow')
    const cancelFn = sliceNamedFunction(server, 'cancelEphemeralGroupFormation')
    const cancelFan = cancelFn.slice(cancelFn.indexOf("type: 'ephemeral_group_cancelled'"))
    assertSerializeOnceLoop(cancelFan, 'cancelEphemeralGroupFormation fan-out')
    assert.match(server, /const progressText = serializeBridgeFrame\(progressFrame\)/)
    assert.match(server, /sendSerializedToLiveMember\(id, progressText\)/)
    assert.match(server, /const formedText = serializeBridgeFrame\(formedFrame\)/)
    assert.match(server, /sendSerializedToLiveMember\(id, formedText\)/)
  })

  it('identical-error loops stringify once (shutdown + capacity evict)', () => {
    const shutdown = sliceNamedFunction(server, 'gracefulShutdown')
    assertSerializeOnceLoop(shutdown, 'gracefulShutdown')
    assert.match(shutdown, /ws\.close\(1001, 'server restarting'\)/)
    const evict = sliceNamedFunction(server, 'evictSurplusLiveConnections')
    assertSerializeOnceLoop(evict, 'evictSurplusLiveConnections')
    assert.match(evict, /oldest\.terminate\(\)/)
    assert.match(evict, /dropLiveSession\(oldest\)/)
  })
})
