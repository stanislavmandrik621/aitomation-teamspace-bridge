/**
 * G11-CORE: lasting chat-room total ceiling (BRG-009 ephemeral twin).
 *
 * Pin the assertCanMintLastingRoom body, not CHAT_ROOMS_LIST_MAX.
 * Comment that helper / its size check and createGroup (or a NEW
 * getOrCreateDm) past cap succeeds - this file must then EXIT 1.
 * Reopen of an existing DM at cap must still succeed.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/chat-rooms-store.ts'), 'utf8')
const throughputSrc = readFileSync(join(root, 'src/throughput.ts'), 'utf8')

function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function methodBody(src: string, declaration: string): string {
  const start = src.indexOf(declaration)
  assert.notEqual(start, -1, `${declaration} still exists`)
  const paren = src.indexOf('(', start)
  assert.notEqual(paren, -1, `${declaration} has a parameter list`)
  let parenDepth = 0
  let afterParams = -1
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') parenDepth++
    else if (src[i] === ')') {
      parenDepth--
      if (parenDepth === 0) {
        afterParams = i + 1
        break
      }
    }
  }
  assert.notEqual(afterParams, -1, `${declaration} parameter list closes`)
  let angle = 0
  let open = -1
  for (let i = afterParams; i < src.length; i++) {
    const ch = src[i]
    if (ch === '<') angle++
    else if (ch === '>') angle = Math.max(0, angle - 1)
    else if (ch === '{') {
      const close = matchBrace(src, i)
      assert.notEqual(close, -1, `${declaration} has balanced braces`)
      if (angle > 0) {
        i = close
        continue
      }
      let j = close + 1
      while (j < src.length && /\s/.test(src[j])) j++
      const next = src[j]
      if (next === '|' || next === '&' || next === '{') {
        i = next === '{' ? j - 1 : close
        continue
      }
      open = i
      break
    }
  }
  assert.notEqual(open, -1, `${declaration} has a body`)
  const close = matchBrace(src, open)
  assert.notEqual(close, -1, `${declaration} body is unterminated`)
  return src.slice(open, close + 1)
}

/** TOOL-G31-066: a `/fn(/` match inside `// fn(` is not load-bearing. */
function sourceWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

const REFUSE_SENTENCE = 'This team already has ${open} chat rooms, but the limit is ${CHAT_ROOMS_TOTAL_MAX}'

function helperRefusesAtCap(src: string): boolean {
  const body = sourceWithoutComments(methodBody(src, 'assertCanMintLastingRoom('))
  return (
    body.includes('listAllOpenRooms()') &&
    /open\s*>=\s*CHAT_ROOMS_TOTAL_MAX/.test(body) &&
    !body.includes('CHAT_ROOMS_LIST_MAX') &&
    body.includes('This team already has') &&
    body.includes('but the limit is')
  )
}

function createGroupCallsHelper(src: string): boolean {
  return sourceWithoutComments(methodBody(src, 'createGroup(input:')).includes(
    'assertCanMintLastingRoom()',
  )
}

function getOrCreateDmCallsHelperOnNewInsert(src: string): boolean {
  const body = methodBody(src, 'getOrCreateDm(memberA:')
  const live = sourceWithoutComments(body)
  const existingReturn = live.indexOf('return existing')
  const helperCall = live.indexOf('assertCanMintLastingRoom()')
  return (
    helperCall >= 0 &&
    existingReturn >= 0 &&
    helperCall > existingReturn &&
    live.includes('if (!existing)')
  )
}

assert.match(
  throughputSrc,
  /export const CHAT_ROOMS_TOTAL_MAX = envInt\('TEAMSPACE_CHAT_ROOMS_TOTAL_MAX', 2_000, 2, 20_000\)/,
  'CHAT_ROOMS_TOTAL_MAX uses the same envInt shape as EPHEMERAL_ROOMS_TOTAL_MAX',
)
assert.ok(
  throughputSrc.includes('Twin of EPHEMERAL_ROOMS_TOTAL_MAX (BRG-009)'),
  'lasting-room ceiling cites the ephemeral BRG-009 twin',
)

assert.match(
  storeSrc,
  /export const CHAT_ROOMS_LIST_MAX = 20_000/,
  'list cap must be the TEAMSPACE_CHAT_ROOMS_TOTAL_MAX env ceiling, not a hardcoded 2000 hide',
)
assert.equal(
  /export const CHAT_ROOMS_LIST_MAX = 2000/.test(storeSrc),
  false,
  'CHAT_ROOMS_LIST_MAX = 2000 hides rooms the create ceiling can mint (G11 residual)',
)

const listHonestyBody = sourceWithoutComments(methodBody(storeSrc, 'listForMemberWithHonesty(memberId:'))
assert.match(
  listHonestyBody,
  /sorted\.length > CHAT_ROOMS_LIST_MAX/,
  'list honesty must compare against CHAT_ROOMS_LIST_MAX, not a literal 2000',
)
assert.match(
  listHonestyBody,
  /truncated \? sorted\.slice\(0, CHAT_ROOMS_LIST_MAX\)/,
  'list slice must use CHAT_ROOMS_LIST_MAX',
)
assert.equal(
  /\b2000\b/.test(listHonestyBody),
  false,
  'listForMemberWithHonesty must not hardcode 2000 (comment the LIST_MAX bind and this EXIT 1)',
)

const listMaxReverted = storeSrc.replace(
  'export const CHAT_ROOMS_LIST_MAX = 20_000',
  'export const CHAT_ROOMS_LIST_MAX = 2000',
)
assert.equal(
  /export const CHAT_ROOMS_LIST_MAX = 20_000/.test(listMaxReverted),
  false,
  'reverting the list cap to 2000 must fail this pin',
)

assert.equal(helperRefusesAtCap(storeSrc), true, 'helper body counts open rooms and names the live cap')
assert.equal(createGroupCallsHelper(storeSrc), true, 'createGroup must call assertCanMintLastingRoom')
assert.equal(
  getOrCreateDmCallsHelperOnNewInsert(storeSrc),
  true,
  'getOrCreateDm must call assertCanMintLastingRoom only on NEW insert',
)

const helperCommented = storeSrc.replace(
  /if \(open >= CHAT_ROOMS_TOTAL_MAX\)/,
  '// if (open >= CHAT_ROOMS_TOTAL_MAX)',
)
assert.equal(
  helperRefusesAtCap(helperCommented),
  false,
  'commenting the size check must fail this pin (TOOL-G31-066)',
)

const createBody = methodBody(storeSrc, 'createGroup(input:')
const createCommented = storeSrc.replace(
  createBody,
  createBody.replace(
    'const refuse = this.assertCanMintLastingRoom()',
    '// const refuse = this.assertCanMintLastingRoom()',
  ),
)
assert.equal(
  createGroupCallsHelper(createCommented),
  false,
  'commenting assertCanMintLastingRoom in createGroup must fail this pin',
)

const dmCommented = storeSrc.replace(
  /if \(!existing\) \{\s*const refuse = this\.assertCanMintLastingRoom\(\)/,
  'if (!existing) {\n      // const refuse = this.assertCanMintLastingRoom()',
)
assert.equal(
  getOrCreateDmCallsHelperOnNewInsert(dmCommented),
  false,
  'commenting assertCanMintLastingRoom on the new-DM path must fail this pin',
)

process.env.TEAMSPACE_CHAT_ROOMS_TOTAL_MAX = '4'

void (async () => {
  const { ChatRoomsStore } = await import('../src/chat-rooms-store.js')
  const { CHAT_ROOMS_TOTAL_MAX } = await import('../src/throughput.js')
  assert.equal(CHAT_ROOMS_TOTAL_MAX, 4, 'test process must run under the env override')

  const expectedRefuse = `This team already has ${CHAT_ROOMS_TOTAL_MAX} chat rooms, but the limit is ${CHAT_ROOMS_TOTAL_MAX}`
  assert.equal(
    expectedRefuse,
    `This team already has 4 chat rooms, but the limit is 4`,
    `refuse sentence template: ${REFUSE_SENTENCE}`,
  )

  function fillToCap(
    rooms: InstanceType<typeof ChatRoomsStore>,
    createdBy: string,
  ): void {
    let n = 0
    while (rooms.listAllOpenRooms().length < CHAT_ROOMS_TOTAL_MAX) {
      n += 1
      const made = rooms.createGroup({
        kind: 'group',
        title: `Fill ${n}`,
        createdBy,
        memberIds: [],
      })
      assert.ok(!('error' in made), `fill ${n} under cap must succeed`)
    }
    assert.equal(rooms.listAllOpenRooms().length, CHAT_ROOMS_TOTAL_MAX)
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'ts-rooms-total-group-'))
    try {
      const rooms = new ChatRoomsStore(dir, null)
      fillToCap(rooms, 'alice')
      const over = rooms.createGroup({
        kind: 'group',
        title: 'Past cap',
        createdBy: 'alice',
        memberIds: ['bob'],
      })
      assert.ok('error' in over, 'createGroup past cap must refuse (comment the helper and this EXIT 1)')
      assert.equal(over.error, expectedRefuse)
      const priv = rooms.createGroup({
        kind: 'private',
        title: 'Past cap private',
        createdBy: 'alice',
        memberIds: ['bob'],
      })
      assert.ok('error' in priv, 'createGroup private past cap must refuse')
      assert.equal(priv.error, expectedRefuse)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'ts-rooms-total-dm-'))
    try {
      const rooms = new ChatRoomsStore(dir, null)
      const existing = rooms.getOrCreateDm('alice', 'bob')
      assert.ok(!('error' in existing), 'first DM under cap must succeed')
      fillToCap(rooms, 'alice')
      const again = rooms.getOrCreateDm('alice', 'bob')
      assert.ok(!('error' in again), 'reopen of an existing DM at cap must still succeed')
      if (!('error' in again) && !('error' in existing)) {
        assert.equal(again.id, existing.id)
      }
      const fresh = rooms.getOrCreateDm('alice', 'carol')
      assert.ok(
        'error' in fresh,
        'new getOrCreateDm past cap must refuse (comment the helper and this EXIT 1)',
      )
      assert.equal(fresh.error, expectedRefuse)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'ts-rooms-total-reopen-closed-'))
    try {
      const rooms = new ChatRoomsStore(dir, null)
      const dm = rooms.getOrCreateDm('eve', 'frank')
      if ('error' in dm) throw new Error(dm.error)
      fillToCap(rooms, 'eve')
      const closed = rooms.closeRoom(dm.id)
      assert.ok(!('error' in closed), 'closeRoom at cap must succeed')
      fillToCap(rooms, 'eve')
      const reopened = rooms.getOrCreateDm('eve', 'frank')
      assert.ok(
        !('error' in reopened),
        'reopen of a closed existing DM at cap must still succeed',
      )
      if (!('error' in reopened)) {
        assert.equal(reopened.id, dm.id)
        assert.ok(!reopened.closedAt)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  {
    const dir = mkdtempSync(join(tmpdir(), 'ts-rooms-list-hide-'))
    try {
      const { CHAT_ROOMS_LIST_MAX } = await import('../src/chat-rooms-store.js')
      assert.equal(
        CHAT_ROOMS_LIST_MAX,
        20_000,
        'live LIST_MAX must be the TOTAL_MAX env ceiling (revert to 2000 and this EXIT 1)',
      )
      const chatDir = join(dir, 'chat')
      mkdirSync(chatDir, { recursive: true })
      const aboveOldHide = 2001
      const rooms = []
      for (let i = 0; i < aboveOldHide; i += 1) {
        rooms.push({
          id: `chat:g:r${String(i).padStart(7, '0')}`,
          kind: 'group',
          title: `Room ${i}`,
          memberIds: ['alice'],
          createdBy: 'alice',
          createdAt: 1_000_000 + i,
          ownerIds: ['alice'],
          bannedMemberIds: [],
          allowedReactionEmojis: [],
          description: '',
          iconKind: 'none',
          iconRef: null,
          iconRev: 0,
          permissions: { addMembers: 'anyone', editInfo: 'anyone', pinMessages: 'admin_only' },
        })
      }
      writeFileSync(join(chatDir, 'rooms.json'), JSON.stringify({ version: 1, rooms }), 'utf8')
      const listed = new ChatRoomsStore(dir, null)
      const honesty = listed.listForMemberWithHonesty('alice')
      const groupCount = honesty.rooms.filter((r) => r.kind === 'group').length
      assert.equal(
        groupCount,
        aboveOldHide,
        `list must not hide rooms above the old 2000 slice (got ${groupCount})`,
      )
      assert.equal(
        honesty.truncated,
        false,
        '2001 open rooms is under the 20_000 list ceiling - truncated must stay false',
      )
      assert.ok(
        honesty.rooms.some((r) => r.id === 'chat:g:r0000000'),
        'oldest of the 2001 rooms must still be listed (newest-first used to drop it at 2000)',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  console.log('chat-rooms-total-ceiling: ok')
})().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
