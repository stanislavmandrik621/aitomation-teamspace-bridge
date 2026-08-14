/**
 * Team Space chat room id helpers.
 * Keep byte-identical contract with apps/desktop/src/lib/teamspace-chat-room.ts.
 */

export const CHAT_ROOM_PREFIX = 'chat:'
/** Default team-wide room. */
export const CHAT_ROOM_TEAM = 'chat:team'
/**
 * Two member tokens (max 128) plus `chat:dm:` and the pair separator.
 * TS-CHAT-096: member ids may contain `_` (`mem_44b80f71`), so the pair
 * separator is `.` and this ceiling must fit `chat:dm:` + 128 + `.` + 128.
 */
export const CHAT_ROOM_MAX_LEN = 280
/** TS-CHAT-096: `.` is not in member tokens (`[a-zA-Z0-9_-]`). */
export const CHAT_DM_PAIR_SEP = '.'
export const CHAT_BODY_MAX = 4_000
export const CHAT_HISTORY_LIMIT_DEFAULT = 50
export const CHAT_HISTORY_LIMIT_MAX = 100
export const CHAT_MSG_ID_MAX = 128
export const CHAT_TITLE_MAX = 200
export const CHAT_UNSEND_MS = 15 * 60 * 1000
/** Author edit window (separate from unsend). Admin bypasses. */
export const CHAT_EDIT_MS = 30 * 60 * 1000
export const CHAT_ATTACH_MAX_BYTES_DEFAULT = 10 * 1024 * 1024
export const CHAT_ATTACH_MAX_BYTES_CEILING = 25 * 1024 * 1024
export const CHAT_ATTACH_MAX_PER_MESSAGE = 10
export const CHAT_AVATAR_MAX_BYTES = 2 * 1024 * 1024
export const CHAT_DISK_QUOTA_CHAT_DEFAULT = 10 * 1024 * 1024 * 1024
export const CHAT_DISK_QUOTA_BLOBS_DEFAULT = 20 * 1024 * 1024 * 1024
/**
 * Pre-v2 defaults (2 GiB history / 8 GiB attachments). ChatMetaStore's
 * schemaVersion 1 -> 2 migration upgrades a persisted value still equal to
 * the old default to the new default exactly once; an Admin-chosen value
 * (anything else) is left alone.
 */
export const CHAT_DISK_QUOTA_CHAT_LEGACY_DEFAULT = 2 * 1024 * 1024 * 1024
export const CHAT_DISK_QUOTA_BLOBS_LEGACY_DEFAULT = 8 * 1024 * 1024 * 1024
export const CHAT_RETENTION_DAYS_DEFAULT = 90
export const CHAT_TOMBSTONE_DAYS_DEFAULT = 365

export type ChatRoomKind = 'team' | 'dm' | 'group' | 'private'

function isOpaqueId(s: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(s)
}

function isMemberToken(s: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(s)
}

/**
 * TS-CHAT-096: split `a.b` (current) or legacy `a_b` (ids without `_`).
 * `mem_44b80f71_mem_abc` is not a valid pair - that is the Invalid DM bug.
 */
export function splitChatDmPair(pair: string): [string, string] | null {
  const s = String(pair || '')
  if (!s) return null
  if (s.includes(CHAT_DM_PAIR_SEP)) {
    const parts = s.split(CHAT_DM_PAIR_SEP)
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null
    return [parts[0], parts[1]]
  }
  const parts = s.split('_')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return [parts[0], parts[1]]
}

export function parseChatRoomId(room: unknown): {
  ok: true
  room: string
  kind: ChatRoomKind
} | { ok: false; reason: string } {
  if (typeof room !== 'string') return { ok: false, reason: 'room required' }
  const s = room.replace(/\0/g, '').trim()
  if (!s.startsWith(CHAT_ROOM_PREFIX)) {
    return { ok: false, reason: 'room must start with chat:' }
  }
  if (s.length > CHAT_ROOM_MAX_LEN) {
    return { ok: false, reason: 'room too long' }
  }
  const rest = s.slice(CHAT_ROOM_PREFIX.length)
  if (!rest || rest.includes('..') || rest.includes('/') || rest.includes('\\')) {
    return { ok: false, reason: 'invalid room id' }
  }
  if (s === CHAT_ROOM_TEAM) {
    return { ok: true, room: CHAT_ROOM_TEAM, kind: 'team' }
  }
  if (rest.startsWith('dm:')) {
    const pair = rest.slice(3)
    const parts = splitChatDmPair(pair)
    if (!parts) {
      return { ok: false, reason: 'invalid dm room id' }
    }
    if (!isMemberToken(parts[0]) || !isMemberToken(parts[1])) {
      return { ok: false, reason: 'invalid dm member ids' }
    }
    if (parts[0] === parts[1]) return { ok: false, reason: 'dm needs two members' }
    const [a, b] = parts[0] < parts[1] ? [parts[0], parts[1]] : [parts[1], parts[0]]
    // Keep the separator that was on the wire so a legacy `a_b` row still
    // resolves. New rooms always mint with CHAT_DM_PAIR_SEP (see dmRoomId).
    const sep = pair.includes(CHAT_DM_PAIR_SEP) ? CHAT_DM_PAIR_SEP : '_'
    return { ok: true, room: `${CHAT_ROOM_PREFIX}dm:${a}${sep}${b}`, kind: 'dm' }
  }
  if (rest.startsWith('g:')) {
    const id = rest.slice(2)
    if (!isOpaqueId(id)) return { ok: false, reason: 'invalid group room id' }
    return { ok: true, room: `${CHAT_ROOM_PREFIX}g:${id}`, kind: 'group' }
  }
  if (rest.startsWith('p:')) {
    const id = rest.slice(2)
    if (!isOpaqueId(id)) return { ok: false, reason: 'invalid private room id' }
    return { ok: true, room: `${CHAT_ROOM_PREFIX}p:${id}`, kind: 'private' }
  }
  return { ok: false, reason: 'Unknown chat room kind' }
}

export function dmRoomId(memberA: string, memberB: string): string | null {
  const a = String(memberA || '').replace(/\0/g, '').trim()
  const b = String(memberB || '').replace(/\0/g, '').trim()
  if (!a || !b || a === b) return null
  const parsed = parseChatRoomId(`${CHAT_ROOM_PREFIX}dm:${a}${CHAT_DM_PAIR_SEP}${b}`)
  return parsed.ok ? parsed.room : null
}

/** Legacy `chat:dm:a_b` for member ids that never contained `_` or `.`. */
export function legacyDmRoomId(memberA: string, memberB: string): string | null {
  const a = String(memberA || '').replace(/\0/g, '').trim()
  const b = String(memberB || '').replace(/\0/g, '').trim()
  if (!a || !b || a === b) return null
  if (a.includes('_') || b.includes('_') || a.includes('.') || b.includes('.')) return null
  const parsed = parseChatRoomId(`${CHAT_ROOM_PREFIX}dm:${a}_${b}`)
  return parsed.ok ? parsed.room : null
}

/**
 * TS-CHAT-034: cut user text at a cap without ever splitting an emoji or other
 * astral character in half. JS string indices are UTF-16 code units, so a bare
 * `slice(0, max)` can leave a trailing high surrogate with no low surrogate
 * after it - that renders as a replacement glyph, and for a room title /
 * description / message body it is then broadcast to every peer and written to
 * durable history. Dropping the orphan lead unit costs one character in the
 * rare case it triggers and keeps the value well-formed.
 *
 * Desktop twin: `capTeamChatText` in `apps/desktop/src/lib/teamspace-chat-room.ts`
 * (TS-CHAT-032). `ephemeral-chat.ts` keeps its own copy on purpose - it is a
 * deliberate zero-import leaf.
 *
 * TS-CHAT-042: the orphan check runs on EVERY input, not only when this call
 * actually truncated. A client that already cut its own text at exactly `max`
 * hands us a value whose length is `max`, so an early `length <= max` return
 * would pass a lone lead surrogate straight through to the peer fanout and
 * (on the history path) to durable JSONL - the exact corruption this helper
 * exists to prevent.
 */
export function capChatText(raw: string, max: number): string {
  if (typeof raw !== 'string') return raw
  const cut = raw.length <= max ? raw : raw.slice(0, max)
  if (cut.length === 0) return cut
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export function scrubChatBody(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\0/g, '').trim()
  if (!s || s.length > CHAT_BODY_MAX) return null
  return s
}

export function parseChatTaskCommand(body: string): { title: string } | null {
  const m = /^\/task(?:\s+|$)(.*)$/is.exec(body.trim())
  if (!m) return null
  const title = capChatText(String(m[1] ?? '').replace(/\0/g, '').trim(), CHAT_TITLE_MAX)
  if (!title) return { title: '' }
  return { title }
}
