/**
 * BRG-106: `originRole` on outbound ops used to ride through untouched from
 * the client's own frame (`...op`), i.e. self-reported by the sending
 * desktop client from its own local settings
 * (`teamSpaceOriginRoleForEnqueue`). `module-lifecycle-authority.ts`'s
 * admin-only gate for `module.delete` reads that exact stamp on the
 * RECEIVING desktop, so a client that lied about its own role (a modified
 * build, a tampered settings file, or a compromised session) could forge
 * admin authority for the one op kind that destroys a shared module for the
 * whole team - defense-in-depth against an honest client, but no defense at
 * all against a forged one.
 *
 * `handleOps` in server.ts must stamp/overwrite `originRole` from the
 * AUTHENTICATED session's own live `LiveSession.role` the same way it
 * already stamps `originMemberId` from `session.memberId` - never trust the
 * client-supplied value. This is a source-scan pin (server.ts starts an
 * HTTP/WS listener at import time and cannot be safely imported here, same
 * constraint documented in wave2-brg-hardening.ts and mirrored by the sibling
 * BRG-067 `handleOps` source-scan in brg-067-append-ops-batch.ts).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const serverSrc = readFileSync(join(root, 'src/server.ts'), 'utf8')
const indexSrc = readFileSync(join(root, 'src/index.ts'), 'utf8')

let passed = 0
function t(name: string, fn: () => void): void {
  fn()
  passed += 1
  console.log(`ok ${passed} ${name}`)
}

function sliceFunction(src: string, name: string): string {
  const re = new RegExp(`\\nfunction ${name}\\(`)
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

function sourceWithoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

/** Bound the `const stamped: ModulesSyncOp = { ... }` object literal only. */
function sliceStampedLiteral(handleOpsBody: string): string {
  const anchor = handleOpsBody.search(/const\s+stamped\s*:\s*ModulesSyncOp\s*=\s*\{/)
  assert.ok(anchor >= 0, 'handleOps must build a `const stamped: ModulesSyncOp = {...}` literal')
  const braceStart = handleOpsBody.indexOf('{', anchor)
  assert.ok(braceStart >= 0)
  let depth = 0
  for (let i = braceStart; i < handleOpsBody.length; i++) {
    const c = handleOpsBody[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return handleOpsBody.slice(braceStart, i + 1)
    }
  }
  assert.fail('unclosed stamped literal')
}

/**
 * The regression this pin exists to catch: `originRole` absent from the
 * `stamped` literal (so it silently rides through from `...op`), or present
 * but reading straight off the client-supplied `op`/`frame` instead of the
 * authenticated `session`.
 */
function stampedLiteralHasAuthoritativeOriginRole(stampedLiteral: string): boolean {
  const live = sourceWithoutComments(stampedLiteral)
  const spreadIdx = live.search(/\.\.\.\s*op\s*,/)
  const roleIdx = live.search(/originRole\s*:\s*session\.role\s*,/)
  if (spreadIdx < 0 || roleIdx < 0) return false
  // Object literal semantics: a later key wins over an earlier spread, so
  // the explicit `originRole:` key must appear strictly AFTER `...op,` in
  // the literal's source order, exactly like every other authoritative
  // stamp in this same object (originMemberId, originMemberName,
  // originDevice all sit after the spread too).
  if (roleIdx <= spreadIdx) return false
  // Guard the inverse regression too: a client-trusting read must not
  // exist anywhere in this literal (e.g. `originRole: op.originRole` or
  // `originRole: (frame as any).originRole`).
  if (/originRole\s*:\s*(op|frame|raw)\b/.test(live)) return false
  return true
}

t('handleOps stamps originRole from the authenticated session, overwriting the spread client value', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sliceStampedLiteral(body)
  assert.equal(
    stampedLiteralHasAuthoritativeOriginRole(stampedLiteral),
    true,
    'stamped.originRole must be session.role, placed after the ...op spread',
  )
})

t('handleOps stamps originRole the same way it stamps originMemberId (twin pattern)', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sourceWithoutComments(sliceStampedLiteral(body))
  const memberIdIdx = stampedLiteral.search(/originMemberId\s*:\s*session\.memberId/)
  const roleIdx = stampedLiteral.search(/originRole\s*:\s*session\.role/)
  assert.ok(memberIdIdx >= 0, 'originMemberId must still be stamped from session.memberId')
  assert.ok(roleIdx >= 0, 'originRole must be stamped from session.role')
})

t('PIN-BREAK: removing the originRole stamp fails this pin (proves it is load-bearing)', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sliceStampedLiteral(body)
  const regressed = stampedLiteral.replace(/\n\s*originRole:\s*session\.role,\n/, '\n')
  assert.notEqual(regressed, stampedLiteral, 'fixture setup must actually remove the line')
  assert.equal(
    stampedLiteralHasAuthoritativeOriginRole(regressed),
    false,
    'pin-break: a stamped literal missing originRole must fail this pin',
  )
})

t('PIN-BREAK: reverting to a client-trusting originRole fails this pin', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sliceStampedLiteral(body)
  const regressed = stampedLiteral.replace(
    /originRole:\s*session\.role,/,
    'originRole: op.originRole,',
  )
  assert.notEqual(regressed, stampedLiteral, 'fixture setup must actually swap the line')
  assert.equal(
    stampedLiteralHasAuthoritativeOriginRole(regressed),
    false,
    'pin-break: trusting the client-supplied op.originRole must fail this pin',
  )
})

t('ModulesSyncOp.originRole is typed as BridgeRole in the shared wire shape', () => {
  const live = sourceWithoutComments(indexSrc)
  assert.match(
    live,
    /originRole\?\s*:\s*BridgeRole/,
    'shared ModulesSyncOp type must declare originRole?: BridgeRole so both sides agree on the wire shape',
  )
})

console.log(`brg-106-origin-role-stamp: ${passed}/5 ok`)
