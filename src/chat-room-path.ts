/**
 * Filesystem-safe directory names for per-room chat storage.
 */

import { createHash } from 'node:crypto'
import { parseChatRoomId, splitChatDmPair } from './chat-room.js'

/**
 * DM pairs are validated unambiguously at parse time (the `.` pair separator
 * cannot appear inside a member token, so `chat:dm:A.B` always splits back
 * into exactly A and B - TS-CHAT-096). But this function then FLATTENS both
 * the separator and every `:`/`.` down to `_` for the on-disk name, and a
 * member token is allowed to contain `_` itself - so two DIFFERENT pairs can
 * flatten to the IDENTICAL directory name when a token's length is not fixed
 * (e.g. `dm:1_2.mem` and `dm:1.2_mem` both flatten to `dm_1_2_mem`), corrupting
 * one DM's history with another's (TS-CHAT-151).
 *
 * The only member ids this bridge ever mints (`mintId('mem')`) are the exact
 * fixed shape below - always 28 chars with the underscore at a fixed offset,
 * so flattening two SUCH tokens can never collide (the join position is
 * always deterministic). Anything else - variable-length underscore-free
 * legacy tokens included - is provably safe too, since with zero embedded
 * underscores the only underscores in the flattened string are the two
 * structural ones. Only a token that BOTH contains `_` AND is not this exact
 * mint shape can reintroduce the ambiguity, so that (never seen from a real
 * mint) case alone is diverted to a hash of the full canonical room id -
 * mirroring the existing over-length hash fallback below - rather than
 * changed for the safe, already-on-disk common case.
 */
const REAL_MINTED_MEMBER_ID_RE = /^mem_[a-f0-9]{24}$/

function dmPairFlattenIsAmbiguityProne(room: string): boolean {
  // room is the canonical `chat:dm:A<sep>B` string from parseChatRoomId.
  const pair = room.slice('chat:dm:'.length)
  const parts = splitChatDmPair(pair)
  if (!parts) return true
  return parts.some((tok) => tok.includes('_') && !REAL_MINTED_MEMBER_ID_RE.test(tok))
}

/** Map chat:team -> team, chat:dm:a.b -> dm_a_b, etc. */
export function safeChatRoomDirName(roomId: string): string | null {
  const parsed = parseChatRoomId(roomId)
  if (!parsed.ok) return null
  if (parsed.kind === 'dm' && dmPairFlattenIsAmbiguityProne(parsed.room)) {
    const hash = createHash('sha256').update(parsed.room).digest('hex').slice(0, 24)
    return `dm_${hash}`
  }
  const rest = parsed.room.slice('chat:'.length)
  const safe = rest.replace(/:/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!safe) return null
  if (safe.length > 120) {
    const hash = createHash('sha256').update(parsed.room).digest('hex').slice(0, 24)
    return `dm_${hash}`
  }
  return safe
}

export function chatRoomDir(dataDir: string, roomId: string): string | null {
  const name = safeChatRoomDirName(roomId)
  if (!name) return null
  return `${dataDir}/chat/rooms/${name}`
}
