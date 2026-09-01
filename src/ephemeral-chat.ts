/**
 * Temporary chat (never-persisted 1:1 DM AND group chat) - pure id/validation
 * helpers.
 *
 * Contract: nothing in this module (or anything that consumes it) may write
 * message content or room existence to disk. Rooms and messages for this
 * feature live ONLY in the bridge process's memory (see `server.ts`) and are
 * gone the moment the process restarts, the room closes, or the process
 * exits - by design, not as a bug. Round-1157 extended the original 1:1-only
 * design (EPH-001) to N-party group rooms (`EPHEMERAL_GROUP_ROOM_PREFIX`)
 * without introducing a parallel close-handshake state machine - see
 * `resolveEphemeralCloseDecision`.
 *
 * Keep byte-identical contract with
 * apps/desktop/src/lib/teamspace-ephemeral-chat.ts.
 */

import { capStr } from './text-cap.js'

export const EPHEMERAL_ROOM_PREFIX = 'eph:'
export const EPHEMERAL_ROOM_MAX_LEN = 160
export const EPHEMERAL_BODY_MAX = 4_000
export const EPHEMERAL_INVITE_ID_MAX = 128
/** A `replyToId` is a client-minted message id (see `clientMsgId`) or the bridge's own fallback id shape - bound its length, never trust it beyond that. */
export const EPHEMERAL_REPLY_TO_ID_MAX = 200

/**
 * Round-1157: group temporary chats (3+ members). A group room's id cannot be
 * derived from its members (membership can change via Leave), so it gets an
 * opaque random token under its own prefix - never confusable with a 1:1
 * `eph:<a>_<b>` id even though both start with `eph:`.
 */
export const EPHEMERAL_GROUP_ROOM_PREFIX = 'eph:g:'
export const EPHEMERAL_GROUP_MEMBERS_MIN = 3
function isMemberToken(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(s)
}

function isGroupRoomToken(s: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(s)
}

/** Build the canonical (sorted, order-independent) room id for two members. */
export function ephemeralRoomId(memberA: string, memberB: string): string | null {
  const a = String(memberA || '').replace(/\0/g, '').trim()
  const b = String(memberB || '').replace(/\0/g, '').trim()
  if (!a || !b || a === b) return null
  if (!isMemberToken(a) || !isMemberToken(b)) return null
  const [x, y] = a < b ? [a, b] : [b, a]
  return `${EPHEMERAL_ROOM_PREFIX}${x}_${y}`
}

/** Mint a group room id from an opaque random token (see `mintToken()` in index.ts). */
export function ephemeralGroupRoomId(token: string): string | null {
  const t = String(token || '').replace(/\0/g, '').trim()
  if (!isGroupRoomToken(t)) return null
  return `${EPHEMERAL_GROUP_ROOM_PREFIX}${t}`
}

/** Parse/validate a wire-supplied 1:1 ephemeral room id (never trust the client blindly). */
export function parseEphemeralRoomId(room: unknown): { ok: true; room: string } | { ok: false; reason: string } {
  if (typeof room !== 'string') return { ok: false, reason: 'room required' }
  const s = room.replace(/\0/g, '').trim()
  if (!s.startsWith(EPHEMERAL_ROOM_PREFIX) || s.startsWith(EPHEMERAL_GROUP_ROOM_PREFIX)) {
    return { ok: false, reason: 'invalid temporary chat room id' }
  }
  if (s.length > EPHEMERAL_ROOM_MAX_LEN) return { ok: false, reason: 'room id too long' }
  const rest = s.slice(EPHEMERAL_ROOM_PREFIX.length)
  const parts = rest.split('_')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid temporary chat room id' }
  if (!isMemberToken(parts[0]) || !isMemberToken(parts[1])) return { ok: false, reason: 'invalid temporary chat room id' }
  if (parts[0] === parts[1]) return { ok: false, reason: 'invalid temporary chat room id' }
  const [a, b] = parts[0] < parts[1] ? [parts[0], parts[1]] : [parts[1], parts[0]]
  return { ok: true, room: `${EPHEMERAL_ROOM_PREFIX}${a}_${b}` }
}

/** Parse/validate a wire-supplied GROUP ephemeral room id. */
export function parseEphemeralGroupRoomId(room: unknown): { ok: true; room: string } | { ok: false; reason: string } {
  if (typeof room !== 'string') return { ok: false, reason: 'room required' }
  const s = room.replace(/\0/g, '').trim()
  if (!s.startsWith(EPHEMERAL_GROUP_ROOM_PREFIX)) return { ok: false, reason: 'invalid temporary group chat room id' }
  if (s.length > EPHEMERAL_ROOM_MAX_LEN) return { ok: false, reason: 'room id too long' }
  const token = s.slice(EPHEMERAL_GROUP_ROOM_PREFIX.length)
  if (!isGroupRoomToken(token)) return { ok: false, reason: 'invalid temporary group chat room id' }
  return { ok: true, room: s }
}

export function isEphemeralGroupRoomId(room: unknown): boolean {
  return typeof room === 'string' && room.startsWith(EPHEMERAL_GROUP_ROOM_PREFIX)
}

/** Parse either a 1:1 or a group ephemeral room id - dispatch on prefix. */
export function parseAnyEphemeralRoomId(room: unknown): { ok: true; room: string } | { ok: false; reason: string } {
  if (typeof room === 'string' && room.startsWith(EPHEMERAL_GROUP_ROOM_PREFIX)) {
    return parseEphemeralGroupRoomId(room)
  }
  return parseEphemeralRoomId(room)
}

/**
 * Validate the initiator-supplied target member list for `ephemeral_group_start`.
 * Dedupes, strips the initiator's own id if present, rejects malformed tokens,
 * and enforces the group's total member ceiling (targets.length + 1 <= max).
 */
export function validateEphemeralGroupTargetMemberIds(
  initiatorMemberId: string,
  raw: unknown,
  maxTotalMembers: number,
): { ok: true; targets: string[] } | { ok: false; reason: string } {
  const initiator = String(initiatorMemberId || '').replace(/\0/g, '').trim()
  if (!Array.isArray(raw)) return { ok: false, reason: 'targetMemberIds required' }
  const seen = new Set<string>()
  const targets: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') continue
    const id = capStr(entry.replace(/\0/g, '').trim(), 128)
    if (!id || id === initiator) continue
    if (!isMemberToken(id)) return { ok: false, reason: 'Invalid temporary group chat member' }
    if (seen.has(id)) continue
    seen.add(id)
    targets.push(id)
  }
  if (targets.length < EPHEMERAL_GROUP_MEMBERS_MIN - 1) {
    return { ok: false, reason: `A temporary group chat needs at least ${EPHEMERAL_GROUP_MEMBERS_MIN} people` }
  }
  if (targets.length + 1 > maxTotalMembers) {
    return { ok: false, reason: `A temporary group chat can have at most ${maxTotalMembers} people` }
  }
  return { ok: true, targets }
}

/** The other member id in a 1:1 temporary-chat room (null when own id is not in the pair). */
export function ephemeralPeerMemberId(room: string, ownMemberId: string | null | undefined): string | null {
  const parsed = parseEphemeralRoomId(room)
  if (!parsed.ok) return null
  const own = typeof ownMemberId === 'string' ? ownMemberId.replace(/\0/g, '').trim() : ''
  if (!own) return null
  const pair = parsed.room.slice(EPHEMERAL_ROOM_PREFIX.length).split('_')
  if (pair.length !== 2) return null
  if (pair[0] === own) return pair[1]
  if (pair[1] === own) return pair[0]
  return null
}

/** Same scrub contract as regular chat body (trim, strip NUL, non-empty, capped). */
export function scrubEphemeralBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\0/g, '').trim()
  // Same refuse-then-repair contract as scrubChatBody (A10 + TS-CHAT-042).
  if (!cleaned || cleaned.length > EPHEMERAL_BODY_MAX) return null
  return capStr(cleaned, EPHEMERAL_BODY_MAX)
}

/**
 * Scrub a client-supplied reply target id before relaying it in
 * `ephemeral_peer_message`. The bridge never stores message history (zero
 * persistence, not even in-memory beyond the live fan-out), so it has no way
 * to look up whether the referenced id "really" belongs to this room - that
 * check is enforced structurally on the READ side instead: every client
 * looks up `replyToId` ONLY inside that same room's own local message buffer
 * (never a global cross-room map), so a wrong/foreign id can only ever fail
 * to resolve (honest "no longer available" fallback), never resolve to a
 * different room's content. This function only bounds shape/length so the
 * field cannot be used to smuggle an oversized or control-character payload
 * through the relay.
 */
export function scrubEphemeralReplyToId(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return null
  const cleaned = raw.replace(/\0/g, '').trim()
  if (!cleaned || cleaned.length > EPHEMERAL_REPLY_TO_ID_MAX) return null
  return capStr(cleaned, EPHEMERAL_REPLY_TO_ID_MAX)
}

/**
 * P2 (extended to temporary chats): bounded, in-memory-only room
 * description. Same cap as the persisted group description
 * (`CHAT_ROOM_DESCRIPTION_MAX` in `chat-rooms-store.ts`) kept as a literal
 * here rather than imported, since this module is intentionally a
 * zero-import pure-logic leaf (see file doc-comment) - never written to
 * disk on either side, lives only in `EphemeralRoomState` until teardown.
 */
export const EPHEMERAL_GROUP_DESCRIPTION_MAX = 500

/** Empty string clears the description; null/undefined leave it untouched (caller distinguishes). */
/**
 * TS-CHAT-034: cut at the cap without splitting an emoji / astral character in
 * half - a bare `slice` can leave a lone lead surrogate, which renders as a
 * replacement glyph on every peer that receives this description. Own copy
 * rather than importing `capChatText` from `chat-room.ts`, for the same
 * deliberate zero-import-leaf reason as the cap literal above.
 *
 * TS-CHAT-042: the orphan check runs on EVERY input, not only when this call
 * truncated. The desktop composer caps the description at the same `max`
 * before sending, so a straddling emoji arrives here as a value that is
 * already exactly `max` units long - an early `length <= max` return would
 * relay that lone lead surrogate to every peer unchanged.
 */
function capEphemeralText(raw: string, max: number): string {
  return capStr(raw, max)
}

export function scrubEphemeralGroupDescription(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = capEphemeralText(raw.replace(/\0/g, '').trim(), EPHEMERAL_GROUP_DESCRIPTION_MAX)
  return s
}

/**
 * Closed set of preset icons for temporary chats (memory-only, never a
 * custom image upload - see P2 doc: full custom-image upload is reserved
 * for regular persisted groups because it would require touching the
 * on-disk/blob avatar pipeline, violating this feature's zero-persistence
 * contract). Kept as its OWN literal copy of `CHAT_ROOM_ICON_PRESETS`
 * (chat-rooms-store.ts) rather than a shared import, for the same
 * zero-import-leaf reason as the description cap above - if the presets
 * ever diverge, update both call sites deliberately, not silently.
 */
export const EPHEMERAL_GROUP_ICON_PRESETS = [
  'blue', 'green', 'purple', 'orange', 'pink', 'teal', 'red', 'slate',
] as const
export type EphemeralGroupIconPreset = (typeof EPHEMERAL_GROUP_ICON_PRESETS)[number]
export function isEphemeralGroupIconPreset(v: unknown): v is EphemeralGroupIconPreset {
  return typeof v === 'string' && (EPHEMERAL_GROUP_ICON_PRESETS as readonly string[]).includes(v)
}

export function isValidEphemeralInviteId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[a-zA-Z0-9_-]{8,64}$/.test(raw)
}

/** Same token shape as an invite id - used for group-formation ids (`ephemeral_group_*`). */
export const isValidEphemeralFormationId = isValidEphemeralInviteId

/** Close reason vocabulary shared by bridge + desktop (never invent new strings ad hoc). */
export type EphemeralCloseReason = 'mutual' | 'timeout' | 'peer_left'

export function isEphemeralCloseReason(raw: unknown): raw is EphemeralCloseReason {
  return raw === 'mutual' || raw === 'timeout' || raw === 'peer_left'
}

/**
 * Group-formation cancellation vocabulary (before the room exists - no
 * member has ever chatted yet, so this is a distinct, smaller vocabulary
 * from `EphemeralCloseReason`). Design: a group temporary chat requires
 * EVERY invited person to accept before the room is created (`formed`) -
 * a single decline, or any invitee going fully offline before answering,
 * cancels the whole formation for everyone rather than forming a partial
 * room. This matches the existing 1:1 invite/accept/decline shape most
 * closely and avoids the extra state-machine complexity of "late joiners"
 * trickling into an already-active room.
 */
export type EphemeralGroupCancelReason = 'declined' | 'expired' | 'member_offline' | 'refused'

export function isEphemeralGroupCancelReason(raw: unknown): raw is EphemeralGroupCancelReason {
  return raw === 'declined' || raw === 'expired' || raw === 'member_offline' || raw === 'refused'
}

/**
 * Pure close-handshake decision: given which members have requested close and
 * which members are currently live, decide whether the room should close now
 * and why. Exported so both the bridge dispatcher and unit tests can reason
 * about the state machine without spinning up a real WebSocket server.
 *
 * Round-1157: generalized from a fixed 2-member tuple to N members (>=2) so
 * group temporary chats reuse the EXACT same state machine as 1:1 rooms -
 * no parallel close-handshake code path. For `memberIds.length === 2` this
 * produces byte-identical decisions to the original 2-party version (see
 * unit tests). The N-party generalizations:
 *  - "both requested" -> "every current member requested" (reason 'mutual')
 *  - a membership count that has fallen below 2 (after a Leave) closes
 *    immediately with reason 'peer_left' - too few people left to continue
 *  - "neither live" -> "no current member has a live connection" (abandoned
 *    room, reason 'peer_left')
 *  - the bare-disconnect timeout fallback (TS-EPH-002) generalizes from
 *    "exactly one of two is live" to "some but not all members are live"
 */
export function resolveEphemeralCloseDecision(args: {
  memberIds: readonly string[]
  closeRequestedBy: ReadonlySet<string>
  liveMemberIds: ReadonlySet<string>
  /** True once the close-timeout deadline (from the first close request OR a disconnect) has elapsed. */
  timeoutElapsed: boolean
}): { shouldClose: true; reason: EphemeralCloseReason } | { shouldClose: false } {
  const members = args.memberIds
  // A departure (Leave) that drops membership below 2 always tears the room
  // down immediately, independent of close requests or liveness.
  if (members.length < 2) return { shouldClose: true, reason: 'peer_left' }
  const allRequested = members.every((id) => args.closeRequestedBy.has(id))
  if (allRequested) return { shouldClose: true, reason: 'mutual' }
  const noneLive = members.every((id) => !args.liveMemberIds.has(id))
  if (noneLive) return { shouldClose: true, reason: 'peer_left' }
  if (args.closeRequestedBy.size > 0 && args.timeoutElapsed) {
    return { shouldClose: true, reason: 'timeout' }
  }
  // TS-EPH-002: a bare disconnect (no close request from anyone yet) still
  // starts the same timeout clock so an abandoned room cannot linger
  // forever - once it elapses with SOME but not all members ever having
  // been live, the caller passes timeoutElapsed=true independent of
  // closeRequestedBy.
  if (args.closeRequestedBy.size === 0 && args.timeoutElapsed) {
    const liveCount = members.filter((id) => args.liveMemberIds.has(id)).length
    const someButNotAllLive = liveCount > 0 && liveCount < members.length
    if (someButNotAllLive) return { shouldClose: true, reason: 'timeout' }
  }
  return { shouldClose: false }
}

/** Clamp a client-suggested close timeout into the bridge's configured [floor, ceiling]. */
export function resolveEphemeralCloseTimeoutMs(
  raw: unknown,
  bounds: { floorMs: number; ceilingMs: number; defaultMs: number },
): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.floor(raw) : NaN
  if (!Number.isFinite(n) || n <= 0) return bounds.defaultMs
  if (n < bounds.floorMs) return bounds.floorMs
  if (n > bounds.ceilingMs) return bounds.ceilingMs
  return n
}
