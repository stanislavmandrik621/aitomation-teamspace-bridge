/**
 * BRG-068 first slice: last-seen ceiling so a retired device stops pinning
 * op-log prune. Pin-break (do not leave this in the tree): comment the
 * stale-skip inside the pruneOps quorum loop
 * (`if (this.deviceIsStaleForPrune(d, staleBefore)) continue`). Then
 * `removed === 0` and this file EXIT 1. Restore the skip. Expect green.
 *
 * Does not pin MAX_SESSIONS_PER_MEMBER as a substitute. Forget UI / IPC
 * stay CROSS-LANE. Store forget-device is revokeSession + dropDeviceAcks
 * (kick / leave / recovery-evict / re-redeem twins). Pins the ops-log byte ceiling,
 * all-stale retention drop, and late-joiner emitted replay.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeStore, hashSessionToken, memberSessionDeviceIds } from '../src/store.js'
import { TEAMSPACE_DEVICE_STALE_DAYS } from '../src/throughput.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const storeSrc = readFileSync(join(root, 'src/store.ts'), 'utf8')
const guide = readFileSync(join(root, 'docs/SELF-HOST.md'), 'utf8')
const throughputSrc = readFileSync(join(root, 'src/throughput.ts'), 'utf8')

const DAY = 24 * 60 * 60 * 1000
const STALE_MS = TEAMSPACE_DEVICE_STALE_DAYS * DAY

function sourceWithoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function sliceClassMethod(src: string, name: string): string {
  const re = new RegExp(`\\n  (?:private\\s+)?(?:async\\s+\\*?\\s*)?${name}\\(`)
  const m = re.exec(src)
  assert.ok(m, `missing method ${name}(`)
  const start = m.index + 1
  let i = m.index + m[0].length - 1
  assert.equal(src[i], '(')
  let paren = 1
  i += 1
  while (i < src.length && paren > 0) {
    if (src[i] === '(') paren += 1
    else if (src[i] === ')') paren -= 1
    i += 1
  }
  while (i < src.length && /\s/.test(src[i]!)) i += 1
  if (src[i] === ':') {
    i += 1
    for (;;) {
      while (i < src.length && /[\s|]/.test(src[i]!)) i += 1
      if (src[i] === '{') {
        let d = 0
        for (; i < src.length; i += 1) {
          if (src[i] === '{') d += 1
          else if (src[i] === '}') {
            d -= 1
            if (d === 0) {
              i += 1
              break
            }
          }
        }
        while (i < src.length && /\s/.test(src[i]!)) i += 1
        if (src[i] === '|') continue
        break
      }
      while (i < src.length && src[i] !== '{' && src[i] !== '\n') i += 1
      if (src[i] === '\n') {
        let j = i + 1
        while (j < src.length && /\s/.test(src[j]!)) j += 1
        if (src[j] === '|' || src[j] === '{') {
          i = j
          continue
        }
      }
      break
    }
  }
  while (i < src.length && /\s/.test(src[i]!)) i += 1
  assert.equal(src[i], '{', `no body for ${name}`)
  let depth = 0
  for (; i < src.length; i += 1) {
    const c = src[i]
    if (c === '{') depth += 1
    else if (c === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  assert.fail(`unclosed method ${name}`)
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

function op(id: string, hlc?: string): ModulesSyncOp {
  return {
    opId: id,
    kind: 'entity.create',
    targetKind: 'entity',
    targetId: id,
    hlc: hlc ?? `0/${id}`,
    originDevice: 'd1',
    hopCount: 0,
    protocolVersion: 2,
  }
}

function writeFixture(
  dir: string,
  args: {
    sessions: Record<string, string>
    sessionLastSeen?: Record<string, number>
    acks: Record<string, Record<string, number>>
    ops: ModulesSyncOp[]
  },
): void {
  mkdirSync(dir, { recursive: true })
  const row: Record<string, unknown> = {
    memberId: 'mem_a',
    email: 'a@example.com',
    displayName: 'A',
    role: 'admin',
    sessions: args.sessions,
    createdAt: 1,
  }
  if (args.sessionLastSeen) row.sessionLastSeen = args.sessionLastSeen
  writeFileSync(
    join(dir, 'team.json'),
    JSON.stringify({ teamId: 'team_g8', createdAt: 1, name: 'T' }),
    'utf8',
  )
  writeFileSync(join(dir, 'members.json'), JSON.stringify([row]), 'utf8')
  writeFileSync(join(dir, 'acks.json'), JSON.stringify(args.acks), 'utf8')
  writeFileSync(
    join(dir, 'ops.jsonl'),
    `${args.ops.map((rowOp) => JSON.stringify(rowOp)).join('\n')}\n`,
    'utf8',
  )
}

function openStore(dir: string): BridgeStore {
  return new BridgeStore(dir, 21, null, null)
}

function writeTwoAdminFixture(
  dir: string,
  args: {
    liveSessions: Record<string, string>
    ghostSessions?: Record<string, string>
    acks?: Record<string, Record<string, number>>
  },
): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'team.json'),
    JSON.stringify({ teamId: 'team_g8', createdAt: 1, name: 'T' }),
    'utf8',
  )
  writeFileSync(
    join(dir, 'members.json'),
    JSON.stringify([
      {
        memberId: 'mem_live',
        email: 'live@example.com',
        displayName: 'Live',
        role: 'admin',
        sessions: args.liveSessions,
        createdAt: 1,
      },
      {
        memberId: 'mem_ghost',
        email: 'ghost@example.com',
        displayName: 'Ghost',
        role: 'admin',
        sessions: args.ghostSessions ?? {},
        createdAt: 2,
      },
    ]),
    'utf8',
  )
  writeFileSync(join(dir, 'acks.json'), JSON.stringify(args.acks ?? {}), 'utf8')
}

function isRecent(at: unknown): boolean {
  return typeof at === 'number' && Number.isFinite(at) && Date.now() - at < 15_000
}

let passed = 0
function t(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed += 1
      console.log(`ok ${passed} ${name}`)
    })
}

const tmp = mkdtempSync(join(tmpdir(), 'brg-068-'))

try {
  await t('stale-skip lives inside the prune quorum loop (comment it and this EXIT 1)', () => {
    const prune = sourceWithoutComments(sliceClassMethod(storeSrc, 'pruneOps'))
    const forIdx = prune.indexOf('for (const d of devices)')
    assert.ok(forIdx >= 0, 'pruneOps must loop registered devices')
    const window = prune.slice(forIdx, forIdx + 900)
    assert.match(
      window,
      /deviceIsStaleForPrune/,
      'stale-skip must sit inside the quorum loop (comment that continue and this EXIT 1)',
    )
  })

  await t('load parser never invents Date.now() for a missing last-seen', () => {
    const parseFn = sliceFunction(storeSrc, 'parseSessionLastSeen')
    assert.equal(
      parseFn.includes('Date.now()'),
      false,
      'missing lastSeen on load must not become Date.now()',
    )
  })

  await t('TEAMSPACE_DEVICE_STALE_DAYS default 90, clamp 21-3650', () => {
    assert.equal(TEAMSPACE_DEVICE_STALE_DAYS >= 21, true)
    assert.equal(TEAMSPACE_DEVICE_STALE_DAYS <= 3650, true)
    assert.match(
      throughputSrc,
      /envInt\(\s*'TEAMSPACE_DEVICE_STALE_DAYS',\s*90,\s*21,\s*3650\s*\)/,
    )
  })

  await t('SELF-HOST names the stale window and the blocking device', () => {
    const row = guide
      .split('\n')
      .find((line) => line.includes('TEAMSPACE_DEVICE_STALE_DAYS'))
    assert.ok(row, 'SELF-HOST.md missing TEAMSPACE_DEVICE_STALE_DAYS row')
    assert.match(row, /90/)
    assert.match(row, /hourly/)
    assert.match(row, /blocking device|holding the log/)
  })

  await t('missing lastSeen on load stays missing (not Date.now())', () => {
    const dir = join(tmp, 'load-missing')
    writeFixture(dir, {
      sessions: { d1: hashSessionToken('tok1') },
      acks: {},
      ops: [op('op_fresh')],
    })
    const before = Date.now()
    const store = openStore(dir)
    const row = store.listMembers()[0]
    assert.ok(row, 'member loaded')
    assert.equal(row!.sessionLastSeen, undefined)
    const disk = JSON.parse(readFileSync(join(dir, 'members.json'), 'utf8')) as Array<{
      sessionLastSeen?: unknown
    }>
    assert.equal(disk[0]?.sessionLastSeen, undefined)
    assert.ok(Date.now() >= before)
  })

  await t('hello caps a trailing-emoji memberId without a lone surrogate', () => {
    const store = openStore(join(tmp, 'hello-cjk'))
    const emoji = '\u{1F600}'
    const hello = store.helloOrBootstrap({
      memberId: `${'m'.repeat(127)}${emoji}`,
      deviceId: `${'d'.repeat(127)}${emoji}`,
      memberEmail: 'cjk@example.com',
      displayName: `${'名'.repeat(199)}${emoji}`,
    })
    assert.equal(hello.ok, true)
    const row = store.listMembers()[0]
    assert.equal(row?.memberId, 'm'.repeat(127))
    assert.equal(row?.sessionLastSeen && Object.keys(row.sessionLastSeen)[0], 'd'.repeat(127))
    assert.equal(row?.displayName, '名'.repeat(199))
    assert.equal(row!.memberId.isWellFormed(), true)
    assert.equal(row!.displayName.isWellFormed(), true)
    assert.equal(row!.displayName.includes('\uFFFD'), false)
  })

  await t('hello mint stamps lastSeen', () => {
    const store = openStore(join(tmp, 'hello-mint'))
    const hello = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'dev_mint',
      memberEmail: 'a@example.com',
    })
    assert.equal(hello.ok, true)
    const row = store.listMembers()[0]
    assert.ok(isRecent(row?.sessionLastSeen?.dev_mint), 'hello mint must stamp lastSeen')
  })

  await t('successful hello auth refreshes lastSeen', () => {
    const dir = join(tmp, 'hello-auth')
    const plain = 'plain-hello-auth-token'
    const old = Date.now() - 120 * DAY
    writeFixture(dir, {
      sessions: { d1: hashSessionToken(plain) },
      sessionLastSeen: { d1: old },
      acks: {},
      ops: [],
    })
    const store = openStore(dir)
    const hello = store.helloOrBootstrap({
      memberId: 'mem_a',
      deviceId: 'd1',
      sessionToken: plain,
    })
    assert.equal(hello.ok, true)
    const at = store.listMembers()[0]?.sessionLastSeen?.d1
    assert.ok(isRecent(at), 'authenticateHelloSession must refresh lastSeen')
    assert.ok(typeof at === 'number' && at > old)
  })

  await t('redeem stamps lastSeen', async () => {
    const store = openStore(join(tmp, 'redeem'))
    const hello = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'dev_admin',
      memberEmail: 'admin@example.com',
    })
    assert.equal(hello.ok, true)
    const created = store.createInvite('mem_admin', 'b@example.com', 'member')
    assert.equal(created.ok, true)
    if (!created.ok) throw new Error('unreachable')
    const redeemed = await store.redeemInvite({
      token: created.invite.token,
      deviceId: 'dev_b',
      memberEmail: 'b@example.com',
      displayName: 'B',
    })
    assert.equal(redeemed.ok, true)
    if (!redeemed.ok) throw new Error('unreachable')
    const row = store.listMembers().find((m) => m.memberId === redeemed.member.memberId)
    assert.ok(isRecent(row?.sessionLastSeen?.dev_b), 'redeem must stamp lastSeen')
  })

  await t('recover stamps lastSeen on the new device', () => {
    const store = new BridgeStore(join(tmp, 'recover'), 21, null)
    const first = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'old-laptop',
      memberEmail: 'owner@example.com',
    })
    assert.equal(first.ok, true)
    assert.ok(store.adminRecovery, 'recovery key resolved')
    const recovered = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'new-laptop',
      adminRecoveryKey: store.adminRecovery!.secret,
    })
    assert.equal(recovered.ok, true)
    const row = store.listMembers()[0]
    assert.ok(isRecent(row?.sessionLastSeen?.['new-laptop']), 'recover must stamp lastSeen')
  })

  await t('markAcked stamps lastSeen', () => {
    const dir = join(tmp, 'ack-stamp')
    const old = Date.now() - 120 * DAY
    writeFixture(dir, {
      sessions: { d1: hashSessionToken('tok1') },
      sessionLastSeen: { d1: old },
      acks: {},
      ops: [op('op_ack')],
    })
    const store = openStore(dir)
    store.markAcked('d1', ['op_ack'])
    store.flushAcksPersist()
    const at = store.listMembers()[0]?.sessionLastSeen?.d1
    assert.ok(isRecent(at), 'markAcked must stamp lastSeen')
  })

  await t('two devices: stale d2 skipped, old acked lines prune (comment skip -> removed === 0)', async () => {
    const dir = join(tmp, 'two-device-lastseen')
    const ackOld = Date.now() - 100 * DAY
    const staleSeen = Date.now() - (STALE_MS + 30 * DAY)
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      sessionLastSeen: { d1: Date.now() - DAY, d2: staleSeen },
      acks: { d1: { op_old: ackOld } },
      ops: [op('op_old')],
    })
    const store = openStore(dir)
    const removed = await store.pruneOps()
    assert.ok(
      removed > 0,
      'stale d2 must not pin prune (comment the stale-skip inside the quorum loop and removed === 0)',
    )
    const recent = await store.readRecentOps(100)
    assert.equal(recent.some((row) => row.opId === 'op_old'), false)
  })

  await t('missing lastSeen + old ack max: infer stale and prune', async () => {
    const dir = join(tmp, 'infer-ack-max')
    const ackOld = Date.now() - 100 * DAY
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      acks: {
        d1: { op_old: ackOld, keep_alive: Date.now() - DAY },
        d2: { other_op: ackOld },
      },
      ops: [op('op_old')],
    })
    const store = openStore(dir)
    assert.equal(store.listMembers()[0]?.sessionLastSeen, undefined)
    const removed = await store.pruneOps()
    assert.ok(removed > 0, 'inferred stale d2 must not pin prune')
  })

  await t('missing lastSeen + no acks: new device still blocks', async () => {
    const dir = join(tmp, 'fresh-blocks')
    const ackOld = Date.now() - 100 * DAY
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      acks: { d1: { op_old: ackOld, keep_alive: Date.now() - DAY } },
      ops: [op('op_old')],
    })
    const store = openStore(dir)
    assert.equal(store.listMembers()[0]?.sessionLastSeen, undefined)
    const removed = await store.pruneOps()
    assert.equal(removed, 0, 'missing lastSeen and no acks must still count')
    assert.ok(
      store.lastPruneBlockingDeviceIds().includes('d2'),
      'hourly prune must name the blocking device',
    )
  })

  await t('all-stale branch drops past-retention lines (comment the drop and this EXIT 1)', () => {
    const prune = sourceWithoutComments(sliceClassMethod(storeSrc, 'pruneOps'))
    const standalone = /if \(ackTimes\.length === 0\) \{([\s\S]{0,500})/.exec(prune)
    assert.ok(standalone, 'all-stale must be its own ackTimes.length === 0 branch')
    assert.match(
      standalone[1]!,
      /opWallMsFromHlc/,
      'all-stale must age via HLC when acks are absent',
    )
    assert.match(
      standalone[1]!,
      /removed\+\+/,
      'all-stale past-retention must drop (comment that increment and this EXIT 1)',
    )
    assert.match(prune, /opsLogMaxBytes/, 'byte ceiling must sit on pruneOps')
    assert.match(prune, /some devices may need a full resync/)
  })

  await t('all-stale quorum drops a past-retention acked line', async () => {
    const dir = join(tmp, 'all-stale-acked')
    const ackOld = Date.now() - 100 * DAY
    const staleSeen = Date.now() - (STALE_MS + 30 * DAY)
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      sessionLastSeen: { d1: staleSeen, d2: staleSeen },
      acks: { d1: { op_old: ackOld } },
      ops: [op('op_old')],
    })
    const store = openStore(dir)
    const removed = await store.pruneOps()
    assert.ok(removed > 0, 'all-stale quorum must drop past-retention lines')
    const recent = await store.readRecentOps(100)
    assert.equal(recent.some((row) => row.opId === 'op_old'), false)
  })

  await t('all-stale + old HLC (no acks) drops', async () => {
    const dir = join(tmp, 'all-stale-hlc-old')
    const staleSeen = Date.now() - (STALE_MS + 30 * DAY)
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      sessionLastSeen: { d1: staleSeen, d2: staleSeen },
      acks: {},
      ops: [op('op_old_hlc', `${Date.now() - 100 * DAY}:0:d1`)],
    })
    const store = openStore(dir)
    const removed = await store.pruneOps()
    assert.ok(removed > 0, 'all-stale + old HLC must drop')
  })

  await t('all-stale + recent HLC (no acks) keeps', async () => {
    const dir = join(tmp, 'all-stale-hlc-fresh')
    const staleSeen = Date.now() - (STALE_MS + 30 * DAY)
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      sessionLastSeen: { d1: staleSeen, d2: staleSeen },
      acks: {},
      ops: [op('op_fresh_hlc', `${Date.now() - DAY}:0:d1`)],
    })
    const store = openStore(dir)
    const removed = await store.pruneOps()
    assert.equal(removed, 0, 'all-stale must keep a line still inside retention')
    const recent = await store.readRecentOps(100)
    assert.equal(recent.some((row) => row.opId === 'op_fresh_hlc'), true)
  })

  await t('source-scan: identity caps use capId/capTrim (comment them and this EXIT 1)', () => {
    const stamp = sourceWithoutComments(sliceFunction(storeSrc, 'stampSessionLastSeen'))
    assert.match(stamp, /capId\(/)
    assert.doesNotMatch(stamp, /\.slice\(\s*0\s*,\s*128\s*\)/)
    const hello = sourceWithoutComments(sliceClassMethod(storeSrc, 'helloOrBootstrap'))
    assert.match(hello, /capTrim\(\s*args\.memberId/)
    assert.doesNotMatch(hello, /args\.memberId\.trim\(\)\.slice/)
    const drop = sourceWithoutComments(sliceClassMethod(storeSrc, 'dropDeviceAcks'))
    assert.match(drop, /capId\(/)
    assert.doesNotMatch(drop, /\.slice\(\s*0\s*,\s*128\s*\)/)
  })

  await t('source-scan: forget-device twins drop acks (comment dropDeviceAcks and this EXIT 1)', () => {
    for (const name of ['revokeSession', 'kickMember', 'leaveTeam', 'recoverAdminWithKey', 'redeemInviteInner'] as const) {
      const body = sourceWithoutComments(sliceClassMethod(storeSrc, name))
      assert.match(
        body,
        /this\.dropDeviceAcks\s*\(/,
        `${name} must drop the forgotten device ack bag (BRG-068)`,
      )
    }
    const drop = sourceWithoutComments(sliceClassMethod(storeSrc, 'dropDeviceAcks'))
    assert.match(drop, /delete this\.acks\[d\]/)
    assert.match(drop, /this\.persistAcks\s*\(/)
    const persistIdx = drop.search(/this\.persistAcks\s*\(/)
    const dirtyFalseIdx = drop.search(/this\.acksDirty\s*=\s*false/)
    assert.ok(persistIdx >= 0 && dirtyFalseIdx >= 0, 'dropDeviceAcks must persist and clear dirty')
    assert.ok(
      persistIdx < dirtyFalseIdx,
      'persistAcks must run before acksDirty=false (comment that order and this EXIT 1)',
    )
  })

  await t('source-scan: revokeSession last-Admin is live sessions not role count', () => {
    const revoke = sourceWithoutComments(sliceClassMethod(storeSrc, 'revokeSession'))
    assert.match(revoke, /remainingAdminLiveSessions/)
    assert.doesNotMatch(
      revoke,
      /admins\.length\s*<=\s*1/,
      'role-count last-Admin is the ghost-admin brick (comment remainingAdminLiveSessions and this EXIT 1)',
    )
    const helper = sourceWithoutComments(sliceFunction(storeSrc, 'remainingAdminLiveSessions'))
    assert.match(helper, /dropAdminRole/)
    assert.match(helper, /dropAllSessions/)
    const mark = sourceWithoutComments(sliceClassMethod(storeSrc, 'markAcked'))
    assert.match(mark, /isRegisteredDevice/)
    const list = sourceWithoutComments(sliceClassMethod(storeSrc, 'listMembers'))
    assert.match(list, /cloneMemberRowForRead/)
    assert.doesNotMatch(list, /sessions:\s*\{\s*\}/)
    assert.doesNotMatch(list, /delete\s+\w+\.sessions/)
    const page = sourceWithoutComments(sliceClassMethod(storeSrc, 'listMembersPage'))
    assert.match(page, /cloneMemberRowForRead/)
    const clone = sourceWithoutComments(sliceFunction(storeSrc, 'cloneMemberRowForRead'))
    assert.match(clone, /sessions:\s*\{\s*\.\.\.member\.sessions\s*\}/)
  })

  await t('source-scan: late joiner replays emitted (comment the slice and this EXIT 1)', () => {
    const scan = sourceWithoutComments(sliceClassMethod(storeSrc, 'scanOpsFromStart'))
    assert.match(scan, /if \(existing\)/)
    assert.match(scan, /existing\.emitted\.slice/)
    assert.doesNotMatch(
      scan,
      /existing && !existing\.yielded/,
      'join-before-yield is the late-joiner second-decrypt leftover',
    )
  })

  await t('re-redeem forgets the prior device ack bag', async () => {
    const store = openStore(join(tmp, 'redeem-forget'))
    const hello = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'dev_admin',
      memberEmail: 'admin@example.com',
    })
    assert.equal(hello.ok, true)
    const created = store.createInvite('mem_admin', 'b@example.com', 'member')
    assert.equal(created.ok, true)
    if (!created.ok) throw new Error('unreachable')
    const first = await store.redeemInvite({
      token: created.invite.token,
      deviceId: 'dev_b1',
      memberEmail: 'b@example.com',
      displayName: 'B',
    })
    assert.equal(first.ok, true)
    if (!first.ok) throw new Error('unreachable')
    store.markAcked('dev_b1', ['op_old'])
    store.flushAcksPersist()
    assert.ok(store.deviceAckCount('dev_b1') > 0, 'first device must have acks before re-redeem')
    const created2 = store.createInvite('mem_admin', 'b@example.com', 'member')
    assert.equal(created2.ok, true)
    if (!created2.ok) throw new Error('unreachable')
    const second = await store.redeemInvite({
      token: created2.invite.token,
      deviceId: 'dev_b2',
      memberEmail: 'b@example.com',
    })
    assert.equal(second.ok, true)
    assert.equal(store.deviceAckCount('dev_b1'), 0, 're-redeem must drop the forgotten device ack bag')
    const row = store.listMembers().find((m) => m.email === 'b@example.com')
    assert.equal(row?.sessions.dev_b1, undefined)
    assert.ok(row?.sessions.dev_b2)
  })

  await t('revokeSession forgets the device ack bag so prune is not pinned', async () => {
    const dir = join(tmp, 'forget-acks')
    const ackOld = Date.now() - 100 * DAY
    writeFixture(dir, {
      sessions: {
        d1: hashSessionToken('tok1'),
        d2: hashSessionToken('tok2'),
      },
      sessionLastSeen: { d1: Date.now() - DAY, d2: Date.now() - DAY },
      acks: { d1: { op_old: ackOld }, d2: { op_old: ackOld } },
      ops: [op('op_old')],
    })
    const store = openStore(dir)
    const hello = store.helloOrBootstrap({
      memberId: 'mem_a',
      deviceId: 'd1',
      sessionToken: 'tok1',
    })
    assert.equal(hello.ok, true)
    const forgotten = store.revokeSession({
      actorMemberId: 'mem_a',
      targetMemberId: 'mem_a',
      deviceId: 'd2',
    })
    assert.equal(forgotten.ok, true)
    assert.equal(store.deviceAckCount('d2'), 0, 'forgotten device must not keep an ack bag')
    assert.ok(store.deviceAckCount('d1') > 0, 'live device acks must stay')
    store.markAcked('d2', ['op_late'])
    store.flushAcksPersist()
    assert.equal(store.deviceAckCount('d2'), 0, 'late markAcked must not rebuild a forgotten bag')
  })

  await t('BRG-104: revoking one member on a shared device must not drop the OTHER member\'s ack bag', () => {
    // Two people redeeming their own invite on one shared/kiosk workstation
    // legitimately register the identical deviceId under two separate
    // member rows. Revoking ONE of those rows must not zero the shared
    // ack bag while the other member still holds a live session for it.
    const dir = join(tmp, 'shared-kiosk-device')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'team.json'),
      JSON.stringify({ teamId: 'team_g8', createdAt: 1, name: 'T' }),
      'utf8',
    )
    writeFileSync(
      join(dir, 'members.json'),
      JSON.stringify([
        {
          memberId: 'mem_owner',
          email: 'owner@example.com',
          displayName: 'Owner',
          role: 'admin',
          sessions: { d_owner: hashSessionToken('tok-owner') },
          createdAt: 1,
        },
        {
          memberId: 'mem_alice',
          email: 'alice@example.com',
          displayName: 'Alice',
          role: 'member',
          sessions: { 'shared-kiosk': hashSessionToken('tok-alice') },
          createdAt: 2,
        },
        {
          memberId: 'mem_bob',
          email: 'bob@example.com',
          displayName: 'Bob',
          role: 'member',
          sessions: { 'shared-kiosk': hashSessionToken('tok-bob') },
          createdAt: 3,
        },
      ]),
      'utf8',
    )
    writeFileSync(
      join(dir, 'acks.json'),
      JSON.stringify({ 'shared-kiosk': { op_old: Date.now() - 100 * DAY } }),
      'utf8',
    )
    writeFileSync(join(dir, 'ops.jsonl'), `${JSON.stringify(op('op_old'))}\n`, 'utf8')
    const store = openStore(dir)
    assert.ok(store.deviceAckCount('shared-kiosk') > 0, 'precondition: shared device has acks')
    const revoked = store.revokeSession({
      actorMemberId: 'mem_owner',
      targetMemberId: 'mem_alice',
      deviceId: 'shared-kiosk',
    })
    assert.equal(revoked.ok, true, `revoke Alice failed: ${JSON.stringify(revoked)}`)
    assert.ok(
      store.deviceAckCount('shared-kiosk') > 0,
      'Bob still holds a live session for shared-kiosk - the ack bag must survive Alice\'s revoke',
    )
    // Now revoke Bob too - only once NO member row references the device
    // does its ack bag actually drop.
    const revokedBob = store.revokeSession({
      actorMemberId: 'mem_owner',
      targetMemberId: 'mem_bob',
      deviceId: 'shared-kiosk',
    })
    assert.equal(revokedBob.ok, true, `revoke Bob failed: ${JSON.stringify(revokedBob)}`)
    assert.equal(
      store.deviceAckCount('shared-kiosk'),
      0,
      'once no member row holds the device, the ack bag must drop',
    )
  })

  await t('revokeSession refuses last live Admin when the other Admin is a ghost', () => {
    const dir = join(tmp, 'ghost-admin-revoke')
    writeTwoAdminFixture(dir, {
      liveSessions: { d_live: hashSessionToken('tok-live') },
    })
    const store = openStore(dir)
    const refused = store.revokeSession({
      actorMemberId: 'mem_live',
      targetMemberId: 'mem_live',
      deviceId: 'd_live',
    })
    assert.equal(refused.ok, false, 'ghost Admin role must not unlock last live session revoke')
    if (refused.ok) throw new Error('unreachable')
    assert.match(refused.reason, /last Admin session/)
    const row = store.listMembers().find((m) => m.memberId === 'mem_live')
    assert.ok(row?.sessions.d_live, 'last live session must stay')
    assert.deepEqual(memberSessionDeviceIds(row!), ['d_live'])
  })

  await t('revokeSession allows forget when another Admin still has a live device', () => {
    const dir = join(tmp, 'two-live-admins')
    writeTwoAdminFixture(dir, {
      liveSessions: {
        d_a: hashSessionToken('tok-a'),
        d_forget: hashSessionToken('tok-forget'),
      },
      ghostSessions: { d_b: hashSessionToken('tok-b') },
      acks: { d_forget: { op_old: Date.now() - 100 * DAY } },
    })
    const store = openStore(dir)
    const forgotten = store.revokeSession({
      actorMemberId: 'mem_live',
      targetMemberId: 'mem_live',
      deviceId: 'd_forget',
    })
    assert.equal(forgotten.ok, true)
    assert.equal(store.deviceAckCount('d_forget'), 0)
    const row = store.listMembers().find((m) => m.memberId === 'mem_live')
    assert.deepEqual(memberSessionDeviceIds(row!), ['d_a'])
    const page = store.listMembersPage()
    const listed = page.members.find((m) => m.memberId === 'mem_live')
    assert.ok(listed?.sessions.d_a, 'listMembersPage must keep session device ids for L06')
    assert.equal(listed?.sessions.d_forget, undefined)
  })

  await t('kick/leave refuse the last live Admin even when a ghost Admin remains', () => {
    const dir = join(tmp, 'ghost-admin-kick')
    writeTwoAdminFixture(dir, {
      liveSessions: { d_live: hashSessionToken('tok-live') },
    })
    const store = openStore(dir)
    const kicked = store.kickMember('mem_ghost', 'mem_live')
    assert.equal(kicked.ok, false, 'kick of last live Admin must refuse')
    const left = store.leaveTeam('mem_live')
    assert.equal(left.ok, false, 'leave of last live Admin must refuse')
    const demote = store.setMemberRole({
      actorMemberId: 'mem_ghost',
      targetMemberId: 'mem_live',
      role: 'member',
    })
    assert.equal(demote.ok, false, 'demote of last live Admin must refuse')
  })

  await t('listMembers keeps a 128-char device id (L06 Object.keys(sessions))', () => {
    const dir = join(tmp, 'device-id-128')
    const deviceId = 'd'.repeat(128)
    writeFixture(dir, {
      sessions: { [deviceId]: hashSessionToken('tok128') },
      acks: {},
      ops: [],
    })
    const store = openStore(dir)
    const row = store.listMembers()[0]
    assert.ok(row, 'member loaded')
    const ids = memberSessionDeviceIds(row!)
    assert.equal(ids.length, 1)
    assert.equal(ids[0], deviceId)
    assert.equal(ids[0]!.length, 128)
    assert.ok(row!.sessions[deviceId], 'store read must not hide the device id')
    const pageIds = memberSessionDeviceIds(store.listMembersPage().members[0]!)
    assert.deepEqual(pageIds, [deviceId])
    delete row!.sessions[deviceId]
    assert.ok(
      store.listMembers()[0]?.sessions[deviceId],
      'listMembers snapshot must not share the live sessions map',
    )
  })

  await t('byte ceiling drops oldest never-acked lines and names a resync', async () => {
    const dir = join(tmp, 'byte-ceiling')
    const fat = 'x'.repeat(200)
    const ops: ModulesSyncOp[] = []
    for (let i = 0; i < 20; i++) {
      ops.push({ ...op(`op_fat_${i}`), patch: { blob: fat } })
    }
    writeFixture(dir, {
      sessions: { d1: hashSessionToken('tok1') },
      sessionLastSeen: { d1: Date.now() - DAY },
      acks: {},
      ops,
    })
    const store = new BridgeStore(dir, 21, null, null, 800)
    const removed = await store.pruneOps()
    assert.ok(removed > 0, 'byte ceiling must evict oldest lines')
    assert.equal(store.lastPruneForcedResync(), true)
    assert.ok(store.lastPruneByteCeilingEvicted() > 0)
    const recent = await store.readRecentOps(100)
    assert.ok(recent.length < 20)
    assert.equal(recent.some((row) => row.opId === 'op_fat_19'), true, 'newest must survive')
    assert.equal(recent.some((row) => row.opId === 'op_fat_0'), false, 'oldest must go')
  })

  console.log(`brg-068-stale-device-prune: ${passed}/30 ok`)
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exitCode = 1
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
