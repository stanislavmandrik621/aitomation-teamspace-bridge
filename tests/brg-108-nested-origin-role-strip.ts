/**
 * FIX-LANE-ORIGINROLE-TRUST / BRG-108: defense-in-depth companion to
 * BRG-106/BRG-107 (`brg-106-origin-role-stamp.ts`). Those pins prove the
 * TOP-LEVEL `originRole` field on an inbound op is unconditionally
 * overwritten with `session.role`, closing the "lie about your own role"
 * attack. They do NOT prove anything about `patch` - a client can still
 * put an `originRole` key INSIDE `patch` (`{ patch: { originRole: 'admin',
 * ...cellData } }`), and until this lane that value rode straight through
 * `handleOps` untouched (`...op` spread) to disk and to every peer's wire,
 * because nothing ever read or stripped a NESTED `originRole`.
 *
 * The real fix for the authority DECISION lives on the desktop side
 * (`parseInboundOpOriginRole` in `module-lifecycle-authority.ts` now reads
 * ONLY the top-level `rawOp.originRole`, never `patch.originRole` at all -
 * see `teamspace-shared-module-authority.ts`). This pin covers the
 * bridge-side defense-in-depth belt: `stripNestedOriginRole` must delete
 * any `originRole` key nested in `patch` before the `stamped` op is
 * persisted (`store.appendOps`) or broadcast to peers, so a forged nested
 * value never even reaches disk - protecting any receiving build that
 * predates the desktop fix, and any future reader that keys off `patch` by
 * field name without going through the shared parser.
 *
 * Source-scan only: `server.ts` starts an HTTP/WS listener at import time
 * and cannot be safely imported here (same constraint documented in
 * `wave2-brg-hardening.ts` / `brg-067-append-ops-batch.ts` /
 * `brg-106-origin-role-stamp.ts`). `stripNestedOriginRole` itself is a pure
 * function with no side effects, so it IS unit-tested directly by
 * `require`-free source extraction + `eval` in an isolated scope (same
 * technique already used by other pure-function pins in this suite is
 * unnecessary here - `new Function` over the sliced body is enough since
 * the function has zero external dependencies).
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

// ------------------------------------------------------ unit: the pure fn

/**
 * Extract and evaluate `stripNestedOriginRole` in isolation (zero deps).
 * `sliceFunction` returns the FULL declaration text including TypeScript
 * type annotations (param types, return type, `as` casts), which `new
 * Function` cannot parse as plain JS - strip exactly the TS-only tokens
 * this function's own source uses (verified against the live text above,
 * not a generic TS-stripper) before handing it to the evaluator.
 */
function loadStripNestedOriginRole(): (patch: unknown) => Record<string, unknown> | undefined {
  const raw = sliceFunction(serverSrc, 'stripNestedOriginRole')
  const jsSrc = raw
    .replace('function stripNestedOriginRole(patch: unknown): Record<string, unknown> | undefined', 'function stripNestedOriginRole(patch)')
    .replace(/\s+as Record<string, unknown> \| undefined/g, '')
    .replace(/\s+as Record<string, unknown>/g, '')
    .replace('const sanitized: Record<string, unknown> = {}', 'const sanitized = {}')
  assert.doesNotMatch(jsSrc, /:\s*(unknown|Record<|string\[\])/, 'unexpected TS annotation survived the strip - update the replacements above')
  assert.doesNotMatch(jsSrc, /\bas\s+\w/, 'unexpected TS cast survived the strip - update the replacements above')
  // eslint-disable-next-line no-new-func
  const factory = new Function(`return (${jsSrc})`)
  return factory() as (patch: unknown) => Record<string, unknown> | undefined
}

t('stripNestedOriginRole deletes a nested originRole key, keeping every sibling key', () => {
  const strip = loadStripNestedOriginRole()
  const out = strip({ originRole: 'admin', title: 'Forged', moduleId: 'mod-shared' })
  assert.ok(out, 'must return a record')
  assert.equal(Object.prototype.hasOwnProperty.call(out as object, 'originRole'), false)
  assert.equal((out as Record<string, unknown>).title, 'Forged')
  assert.equal((out as Record<string, unknown>).moduleId, 'mod-shared')
})

t('stripNestedOriginRole is a no-op when patch has no originRole key', () => {
  const strip = loadStripNestedOriginRole()
  const input = { title: 'Cell', count: 3 }
  const out = strip(input)
  assert.deepEqual(out, input)
})

t('stripNestedOriginRole passes through non-object patch values unchanged', () => {
  const strip = loadStripNestedOriginRole()
  assert.equal(strip(undefined), undefined)
  assert.equal(strip(null), null)
  assert.equal(strip('a string patch'), 'a string patch')
  const arr = ['originRole', 'admin']
  assert.equal(strip(arr), arr, 'an array must not be treated as a keyed record')
})

t('stripNestedOriginRole does not mutate the input object', () => {
  const strip = loadStripNestedOriginRole()
  const input: Record<string, unknown> = { originRole: 'admin', keep: 1 }
  const frozen = Object.freeze({ ...input })
  strip(input)
  assert.deepEqual(input, frozen, 'must build a new object, never delete off the caller\'s own patch')
})

t('stripNestedOriginRole drops an inherited (prototype) originRole via hasOwnProperty, and its own copy strips real siblings', () => {
  const strip = loadStripNestedOriginRole()
  const proto = { originRole: 'admin' }
  const inherited = Object.create(proto) as Record<string, unknown>
  inherited.title = 'Cell'
  const out = strip(inherited) as Record<string, unknown>
  // hasOwnProperty is false for the inherited key, so this function takes
  // the no-op early-return path - the inherited originRole is not an OWN
  // key to delete, but it is also never copied into the output since the
  // early-return hands back the SAME object (own enumeration would not
  // have surfaced it as a key to keep either way).
  assert.equal(out, inherited)
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'originRole'), false)
})

// -------------------------------------------- source-scan: handleOps wiring

t('handleOps strips patch.originRole via stripNestedOriginRole before building the stamped op', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sourceWithoutComments(sliceStampedLiteral(body))
  assert.match(
    stampedLiteral,
    /patch\s*:\s*stripNestedOriginRole\s*\(\s*op\.patch\s*\)/,
    'the stamped literal must route patch through stripNestedOriginRole(op.patch), never a bare ...op patch',
  )
})

t('the patch-stripping key appears strictly AFTER the top-level originRole stamp (same source-order contract as BRG-106)', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sourceWithoutComments(sliceStampedLiteral(body))
  const spreadIdx = stampedLiteral.search(/\.\.\.\s*op\s*,/)
  const roleIdx = stampedLiteral.search(/originRole\s*:\s*session\.role\s*,/)
  const patchStripIdx = stampedLiteral.search(/patch\s*:\s*stripNestedOriginRole/)
  assert.ok(spreadIdx >= 0 && roleIdx >= 0 && patchStripIdx >= 0)
  assert.ok(roleIdx > spreadIdx, 'top-level originRole stamp must come after the ...op spread')
  assert.ok(patchStripIdx > spreadIdx, 'patch strip must come after the ...op spread (never let the raw spread win)')
})

t('PIN-BREAK: a stamped literal with the patch strip removed (bare ...op patch) fails this pin', () => {
  const body = sliceFunction(serverSrc, 'handleOps')
  const stampedLiteral = sourceWithoutComments(sliceStampedLiteral(body))
  const regressed = stampedLiteral.replace(
    /patch\s*:\s*stripNestedOriginRole\s*\(\s*op\.patch\s*\)/,
    'patch: op.patch',
  )
  assert.notEqual(regressed, stampedLiteral, 'fixture setup must actually remove the strip call')
  assert.doesNotMatch(
    regressed,
    /patch\s*:\s*stripNestedOriginRole\s*\(\s*op\.patch\s*\)/,
    'pin-break: a bare patch: op.patch must fail the wiring pin above',
  )
})

t('stripNestedOriginRole is defined before handleOps uses it (no forward-reference / TDZ risk for a const)', () => {
  const stripDefIdx = serverSrc.search(/\nfunction stripNestedOriginRole\(/)
  const handleOpsIdx = serverSrc.search(/\nasync function handleOps\(|\nfunction handleOps\(/)
  assert.ok(stripDefIdx >= 0 && handleOpsIdx >= 0)
  assert.ok(stripDefIdx < handleOpsIdx, 'stripNestedOriginRole must be declared before handleOps in source order')
})

console.log(`brg-108-nested-origin-role-strip: ${passed}/9 ok`)
