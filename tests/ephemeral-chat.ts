/**
 * Round-1157: Temporary group chat (3+ members) pure-logic coverage for
 * packages/bridge/src/ephemeral-chat.ts. Companion to the desktop mirror's
 * tests/unit/teamspace-ephemeral-chat.ts (1:1 + N-party close-decision +
 * no-persistence grep + IPC-burst-vs-bridge-budget drift).
 */
import { readFileSync } from 'node:fs'
import {
  ephemeralRoomId,
  ephemeralGroupRoomId,
  parseEphemeralGroupRoomId,
  parseEphemeralRoomId,
  isEphemeralGroupRoomId,
  parseAnyEphemeralRoomId,
  validateEphemeralGroupTargetMemberIds,
  resolveEphemeralCloseDecision,
  isEphemeralGroupCancelReason,
  scrubEphemeralReplyToId,
  scrubEphemeralGroupDescription,
  isEphemeralGroupIconPreset,
  EPHEMERAL_GROUP_DESCRIPTION_MAX,
  EPHEMERAL_GROUP_MEMBERS_MIN,
  EPHEMERAL_REPLY_TO_ID_MAX,
} from '../src/ephemeral-chat.js'
import { capChatText } from '../src/chat-room.js'
import {
  EPHEMERAL_GROUP_MEMBERS_MAX,
  EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX,
  EPHEMERAL_ROOMS_TOTAL_MAX,
} from '../src/throughput.js'

function must(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}

// ── Group room id: mint (bridge-only) + parse + never confusable with 1:1 ──
{
  must(ephemeralGroupRoomId('abcd1234') === 'eph:g:abcd1234', 'mints canonical eph:g: prefix')
  must(ephemeralGroupRoomId('short') === null, 'token below the 8-char floor refused')
  must(ephemeralGroupRoomId('has spaces!!') === null, 'non-token characters refused')
  must(ephemeralGroupRoomId('') === null, 'empty token refused')

  const parsed = parseEphemeralGroupRoomId('eph:g:abcd1234')
  must(parsed.ok === true, 'parses a well-formed group room id')
  if (parsed.ok) must(parsed.room === 'eph:g:abcd1234', 'round-trips unchanged')

  must(parseEphemeralGroupRoomId('eph:alice_bob').ok === false, 'a 1:1 room id is never accepted as a group room id')
  must(parseEphemeralGroupRoomId('eph:g:' + 'a'.repeat(200)).ok === false, 'over-length group room id refused')
  must(parseEphemeralGroupRoomId(null).ok === false, 'non-string refused')

  must(isEphemeralGroupRoomId('eph:g:abcd1234') === true, 'classifies a group id')
  must(isEphemeralGroupRoomId('eph:alice_bob') === false, 'does not misclassify a 1:1 id')
  must(isEphemeralGroupRoomId(42) === false, 'non-string never classified as a group id')

  // parseAnyEphemeralRoomId dispatches on prefix to the right parser for both kinds.
  const anyGroup = parseAnyEphemeralRoomId('eph:g:abcd1234')
  must(anyGroup.ok === true && anyGroup.room === 'eph:g:abcd1234', 'dispatches group ids to the group parser')
  const any11 = parseAnyEphemeralRoomId('eph:bob_alice')
  must(any11.ok === true && any11.room === ephemeralRoomId('alice', 'bob'), 'dispatches 1:1 ids to the 1:1 parser (and still canonicalizes order)')
}

// ── validateEphemeralGroupTargetMemberIds: dedupe, strip self, enforce ceilings ──
{
  const ok = validateEphemeralGroupTargetMemberIds('alice', ['bob', 'carol'], EPHEMERAL_GROUP_MEMBERS_MAX)
  must(ok.ok === true, 'accepts a valid 2-target list (3 total with the initiator)')
  if (ok.ok) must(ok.targets.length === 2 && ok.targets.includes('bob') && ok.targets.includes('carol'), 'preserves valid targets')

  const dedup = validateEphemeralGroupTargetMemberIds('alice', ['bob', 'bob', 'carol'], EPHEMERAL_GROUP_MEMBERS_MAX)
  must(dedup.ok === true && dedup.targets.length === 2, 'de-duplicates repeated target ids')

  const stripsSelf = validateEphemeralGroupTargetMemberIds('alice', ['alice', 'bob', 'carol'], EPHEMERAL_GROUP_MEMBERS_MAX)
  must(stripsSelf.ok === true && stripsSelf.targets.length === 2 && !stripsSelf.targets.includes('alice'), 'strips the initiator\'s own id if present')

  const tooFew = validateEphemeralGroupTargetMemberIds('alice', ['bob'], EPHEMERAL_GROUP_MEMBERS_MAX)
  must(tooFew.ok === false, `fewer than ${EPHEMERAL_GROUP_MEMBERS_MIN} total members is refused (a single target would just be a 1:1 chat)`)

  const notArray = validateEphemeralGroupTargetMemberIds('alice', 'bob', EPHEMERAL_GROUP_MEMBERS_MAX)
  must(notArray.ok === false, 'non-array targetMemberIds refused')

  const badToken = validateEphemeralGroupTargetMemberIds('alice', ['bob', 'has space'], EPHEMERAL_GROUP_MEMBERS_MAX)
  must(badToken.ok === false, 'a malformed member token refuses the whole request rather than silently dropping it')

  const overCap = validateEphemeralGroupTargetMemberIds(
    'alice',
    Array.from({ length: EPHEMERAL_GROUP_MEMBERS_MAX }, (_, i) => `m${i}`),
    EPHEMERAL_GROUP_MEMBERS_MAX,
  )
  must(overCap.ok === false, `targets.length + 1 > maxTotalMembers (${EPHEMERAL_GROUP_MEMBERS_MAX}) is refused`)

  const atCap = validateEphemeralGroupTargetMemberIds(
    'alice',
    Array.from({ length: EPHEMERAL_GROUP_MEMBERS_MAX - 1 }, (_, i) => `m${i}`),
    EPHEMERAL_GROUP_MEMBERS_MAX,
  )
  must(atCap.ok === true, 'exactly at the ceiling (targets.length + 1 === maxTotalMembers) is accepted')
}

// ── Group-formation cancel reason vocabulary is closed ──
{
  must(isEphemeralGroupCancelReason('declined') === true, 'declined is valid')
  must(isEphemeralGroupCancelReason('expired') === true, 'expired is valid')
  must(isEphemeralGroupCancelReason('member_offline') === true, 'member_offline is valid')
  must(isEphemeralGroupCancelReason('refused') === true, 'refused is valid')
  must(isEphemeralGroupCancelReason('something_else') === false, 'unknown reason refused')
  must(isEphemeralGroupCancelReason(undefined) === false, 'undefined refused')
}

// ── resolveEphemeralCloseDecision generalized to N (3, 4) members ──
// Round-1157: the SAME state machine that already governs 1:1 rooms, not a
// parallel implementation - these assertions exercise the N-party
// generalization rules documented on the function itself.
{
  const threeMembers = ['alice', 'bob', 'carol'] as const

  // Nobody has requested close yet, everyone live -> stays open.
  must(
    resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(),
      liveMemberIds: new Set(threeMembers),
      timeoutElapsed: false,
    }).shouldClose === false,
    'a healthy 3-party room with no close requests stays open',
  )

  // Two of three have requested close - not "mutual" yet (not EVERY member).
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(['alice', 'bob']),
      liveMemberIds: new Set(threeMembers),
      timeoutElapsed: false,
    })
    must(d.shouldClose === false, 'a partial (2-of-3) close request does not close a 3-party room before the timeout')
  }

  // All three have requested close -> mutual, regardless of party size.
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(threeMembers),
      liveMemberIds: new Set(threeMembers),
      timeoutElapsed: false,
    })
    must(d.shouldClose === true && d.reason === 'mutual', 'every current member requesting close ends a 3-party room with reason=mutual')
  }

  // A departure (Leave) drops membership below 2 -> tear down immediately.
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: ['alice'],
      closeRequestedBy: new Set(),
      liveMemberIds: new Set(['alice']),
      timeoutElapsed: false,
    })
    must(d.shouldClose === true && d.reason === 'peer_left', 'fewer than 2 members remaining always tears the room down, independent of live/requested state')
  }

  // 3 remain after one of 4 leaves -> stays open (>= 2 remain).
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: ['alice', 'bob', 'carol'],
      closeRequestedBy: new Set(),
      liveMemberIds: new Set(['alice', 'bob', 'carol']),
      timeoutElapsed: false,
    })
    must(d.shouldClose === false, 'a 4-party room that drops to 3 members (still >= 2) stays open for the rest')
  }

  // Nobody in a 3-party room is live -> abandoned, closes.
  must(
    resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(),
      liveMemberIds: new Set(),
      timeoutElapsed: false,
    }).shouldClose === true,
    'a 3-party room with nobody live closes immediately (abandoned), even before any timeout',
  )

  // One of three requested close, timeout elapses without the others confirming.
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(['alice']),
      liveMemberIds: new Set(threeMembers),
      timeoutElapsed: true,
    })
    must(d.shouldClose === true && d.reason === 'timeout', 'a single close request in a 3-party room force-closes with reason=timeout once the deadline elapses')
  }

  // Bare disconnect (no close request from anyone): some but not all live, timeout elapsed.
  {
    const d = resolveEphemeralCloseDecision({
      memberIds: threeMembers,
      closeRequestedBy: new Set(),
      liveMemberIds: new Set(['alice']),
      timeoutElapsed: true,
    })
    must(d.shouldClose === true && d.reason === 'timeout', 'a bare disconnect in a 3-party room (some but not all live) still starts the same abandon-timeout clock')
  }

  // For exactly 2 members, the N-party generalization must be byte-identical
  // to the original 2-party decisions (regression guard for EPH-001).
  {
    const twoMembers = ['alice', 'bob'] as const
    const mutual = resolveEphemeralCloseDecision({
      memberIds: twoMembers,
      closeRequestedBy: new Set(twoMembers),
      liveMemberIds: new Set(twoMembers),
      timeoutElapsed: false,
    })
    must(mutual.shouldClose === true && mutual.reason === 'mutual', '2-party mutual close unchanged by the N-party generalization')
  }
}

// ── scrubEphemeralReplyToId: bounded/opaque relay field, never a lookup ──
{
  must(scrubEphemeralReplyToId('eph_123_abcdef') === 'eph_123_abcdef', 'accepts a well-formed client message id')
  must(scrubEphemeralReplyToId('a\0b') === 'ab', 'strips NUL bytes')
  must(scrubEphemeralReplyToId('  padded  ') === 'padded', 'trims whitespace')
  must(scrubEphemeralReplyToId('') === null, 'empty string refused')
  must(scrubEphemeralReplyToId('   ') === null, 'whitespace-only refused')
  must(scrubEphemeralReplyToId(null) === null, 'null refused (not a reply)')
  must(scrubEphemeralReplyToId(undefined) === null, 'undefined refused (not a reply)')
  must(scrubEphemeralReplyToId(42) === null, 'non-string refused')
  must(scrubEphemeralReplyToId('x'.repeat(EPHEMERAL_REPLY_TO_ID_MAX + 1)) === null, 'over-length id refused')
  must(scrubEphemeralReplyToId('x'.repeat(EPHEMERAL_REPLY_TO_ID_MAX)) === 'x'.repeat(EPHEMERAL_REPLY_TO_ID_MAX), 'exactly-at-cap id accepted')
}

// ── Sane, production-scale ceilings (not dev-placeholder sized) ──
{
  must(EPHEMERAL_GROUP_MEMBERS_MAX >= EPHEMERAL_GROUP_MEMBERS_MIN, 'group member ceiling is at least the group minimum')
  must(EPHEMERAL_GROUP_MEMBERS_MAX <= 50, 'group member ceiling stays a small, sane number (never an unbounded fanout target)')
  must(EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX >= 1, 'per-member pending-formation ceiling present')
  must(
    EPHEMERAL_ROOMS_TOTAL_MAX >= 2_000,
    `bridge-wide concurrent temporary-room ceiling (${EPHEMERAL_ROOMS_TOTAL_MAX}) must be sized for hundreds of teams, not a single-team dev placeholder`,
  )
}

// ── P2 (extended to temporary chats): description scrub + icon preset validation ──
{
  must(scrubEphemeralGroupDescription('  Launch planning  ') === 'Launch planning', 'trims whitespace')
  must(scrubEphemeralGroupDescription('a\0b') === 'ab', 'strips NUL bytes')
  must(scrubEphemeralGroupDescription('') === '', 'empty string is a valid clear, not null')
  must(scrubEphemeralGroupDescription(null) === null, 'null input refused (caller must skip the patch)')
  must(scrubEphemeralGroupDescription(42) === null, 'non-string input refused')
  must(
    (scrubEphemeralGroupDescription('x'.repeat(EPHEMERAL_GROUP_DESCRIPTION_MAX + 100)) ?? '').length === EPHEMERAL_GROUP_DESCRIPTION_MAX,
    'over-length description is truncated at the cap, never refused outright',
  )

  must(isEphemeralGroupIconPreset('blue') === true, 'known preset accepted')
  must(isEphemeralGroupIconPreset('slate') === true, 'last preset in the closed set accepted')
  must(isEphemeralGroupIconPreset('mauve') === false, 'unknown preset refused')
  must(isEphemeralGroupIconPreset(null) === false, 'null refused')
  must(isEphemeralGroupIconPreset(42) === false, 'non-string refused')
}

// ── TS-CHAT-034: every user-text cap cuts on a character boundary ──
{
  // Land the cap exactly inside a surrogate pair: `max - 1` filler chars, then
  // an astral character whose lead unit sits at the last allowed index.
  const rocket = '\u{1F680}' // 2 UTF-16 code units
  const straddling = 'x'.repeat(EPHEMERAL_GROUP_DESCRIPTION_MAX - 1) + rocket + 'tail'
  const capped = scrubEphemeralGroupDescription(straddling) ?? ''
  must(
    capped.length === EPHEMERAL_GROUP_DESCRIPTION_MAX - 1,
    'a cap landing mid-surrogate drops the orphan lead unit (one char shorter), never keeps it',
  )
  must(capped.isWellFormed(), 'temporary-chat description is never stored/relayed with a lone surrogate')

  // A pair that fits entirely stays intact - the guard must not eat valid text.
  const fits = 'y'.repeat(EPHEMERAL_GROUP_DESCRIPTION_MAX - 2) + rocket
  const kept = scrubEphemeralGroupDescription(fits) ?? ''
  must(kept.endsWith(rocket), 'an astral character that fits inside the cap is preserved whole')
  must(kept.length === EPHEMERAL_GROUP_DESCRIPTION_MAX, 'exactly-at-cap input is not truncated')

  // Shared bridge helper (regular rooms: title / description / durable body).
  must(capChatText('abc', 10) === 'abc', 'under cap returned unchanged')
  must(capChatText('a' + rocket, 2) === 'a', 'shared helper drops the orphan lead unit too')
  must(capChatText('a' + rocket, 3) === 'a' + rocket, 'shared helper keeps a pair that fits')
  must(capChatText('a' + rocket, 3).isWellFormed(), 'shared helper output is well-formed')
}

// ── TS-CHAT-042: the repair runs even when nothing needed truncating ──
{
  // A value that arrives ALREADY cut at exactly the cap (a client that
  // pre-truncated, an older build's stored value, a hand-rolled slice
  // elsewhere) used to skip the surrogate repair entirely, because every cap
  // returned early on `length <= max`. The malformed unit was then broadcast
  // to peers and, on the durable path, appended to history verbatim.
  const lead = '\uD83D'
  const exactFit = 'x'.repeat(9) + lead
  must(exactFit.length === 10, 'fixture must sit exactly at the cap, needing no truncation')
  must(capChatText(exactFit, 10) === 'x'.repeat(9), 'exact-fit lone lead surrogate is dropped, not passed through')
  must(capChatText(exactFit, 10).isWellFormed(), 'capChatText never returns a lone surrogate')
  must(capChatText('', 10) === '', 'empty input is untouched')
  must(capChatText(lead, 10) === '', 'a value that is nothing but an orphan lead unit collapses to empty')

  const descExact = 'x'.repeat(EPHEMERAL_GROUP_DESCRIPTION_MAX - 1) + lead
  const descCapped = scrubEphemeralGroupDescription(descExact) ?? ''
  must(descCapped.isWellFormed(), 'temporary-chat description repairs an exact-fit lone surrogate too')
  must(descCapped.length === EPHEMERAL_GROUP_DESCRIPTION_MAX - 1, 'only the orphan unit is dropped')
}

// ── TS-CHAT-038 / TS-EPH-PERF-003: reconnect + start-path source pins ──
{
  const serverSrc = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')

  const onlineStart = serverSrc.indexOf('function handleEphemeralMemberOnline(')
  must(onlineStart > 0, 'handleEphemeralMemberOnline must exist')
  const onlineBody = serverSrc.slice(onlineStart, serverSrc.indexOf('\n}', onlineStart))
  const sendIdx = onlineBody.indexOf("type: 'ephemeral_peer_online'")
  const guardIdx = onlineBody.indexOf('closeRequestedBy.size === 0')
  must(sendIdx > 0, 'reconnect must fan out ephemeral_peer_online')
  must(guardIdx > 0, 'the deadline clear must still be guarded by the pending-close check')
  must(
    sendIdx < guardIdx,
    'TS-CHAT-038: the online frame must be sent UNCONDITIONALLY, before/outside the close-request guard - ' +
    'gating the message on timer state left peers showing "offline" for a member who is demonstrably back',
  )

  const startIdx = serverSrc.indexOf("case 'ephemeral_start'")
  must(startIdx > 0, "ephemeral_start dispatcher case must exist")
  const startBody = serverSrc.slice(startIdx, startIdx + 4000)
  must(
    startBody.includes('firstLiveSessionForMember(targetMemberId)'),
    'TS-EPH-PERF-003: the start path must use the O(1) reverse index for its online check',
  )
  must(
    !/\[\.\.\.live\.values\(\)\]\.some/.test(startBody),
    'TS-EPH-PERF-003: no O(all bridge sockets) scan may remain on the temporary-chat start path',
  )
}

// ── TS-CHAT-145: leaving the team ends that member's temporary chats now ──
{
  const serverSrc = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8')
  const live = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')

  const start = serverSrc.indexOf('function handleMemberLeaveChat(')
  must(start > 0, 'handleMemberLeaveChat must exist')
  const body = serverSrc.slice(start, serverSrc.indexOf('\n}', start))
  const liveBody = live(body)
  must(
    liveBody.includes('ephemeralRoomsByMember.get(memberId)'),
    'TS-CHAT-145: departure must walk this member\'s temporary rooms - the durable room walk below cannot see them',
  )
  must(
    liveBody.includes('leaveEphemeralRoom('),
    'TS-CHAT-145: each of those rooms must be left now, not waited out on the close timeout',
  )
  // A commented-out call must not satisfy this pin (TOOL-G31-066).
  must(
    !live(body.replace(/leaveEphemeralRoom\(/g, '// leaveEphemeralRoom(')).includes('leaveEphemeralRoom('),
    'commenting the temporary-chat teardown must fail this pin',
  )
  // Both departure paths share that one function.
  for (const frame of ['kick_member', 'leave_team']) {
    const at = serverSrc.indexOf(`case '${frame}': {`)
    must(at > 0, `${frame} handler must exist`)
    must(
      live(serverSrc.slice(at, at + 2_500)).includes('handleMemberLeaveChat('),
      `${frame} must run the shared chat departure teardown`,
    )
  }
}

console.log('ephemeral-chat.ts (bridge): all assertions passed')
