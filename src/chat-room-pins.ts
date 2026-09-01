/**
 * Team chat room pins - the ordered list of pinned message ids for one room.
 *
 * Zero-import leaf so the history store, the server frames, and the unit
 * tests all share one definition of what a pin list is, how a legacy
 * single-pin room migrates into one, and where the ceiling sits.
 *
 * Order is pin order, oldest first. The LAST entry is the most recently
 * pinned message, which is what a room banner shows.
 *
 * Reaching the ceiling REFUSES the new pin instead of evicting the oldest.
 * Silently dropping a pin somebody else put up is the same kind of surprise
 * as the single-pin overwrite this list replaced, so the caller is told to
 * unpin something first.
 */

/**
 * Most messages one room may keep pinned at once.
 *
 * Sized for a real room's standing notices (rules, links, the current
 * sprint goal) rather than for bulk tagging - a list longer than this stops
 * being scannable, and every pin is re-sent on the room's live pin frames.
 *
 * The desktop app keeps its own copy in
 * `apps/desktop/src/lib/teamspace-chat-pin.ts` because the two packages ship
 * separately (the bridge runs on the team server and is published without
 * the app). `apps/desktop/tests/unit/teamspace-chat-multi-pin.ts` reads THIS
 * file and fails if the two numbers ever drift apart, which is the same
 * mechanism `teamspace-chat-ipc-burst-vs-bridge-drift.ts` already uses for
 * the shared chat rate budgets.
 */
export const CHAT_ROOM_PINS_MAX = 50

/** Longest message id a pin entry may hold. Mirrors `CHAT_MSG_ID_MAX`. */
export const CHAT_PIN_ID_MAX = 128

/** Shown to the person whose pin was refused, so they know what to do next. */
export const CHAT_PINS_FULL_ERROR =
  `This room already has ${CHAT_ROOM_PINS_MAX} pinned messages. Unpin one before pinning another.`

/** On-disk shape of a room's pin meta file, both the current and legacy keys. */
export type ChatRoomPinMeta = {
  /** Current shape: pin order, oldest first. */
  pinnedMessageIds?: unknown
  /** Legacy shape: the single pinned message a room could hold before. */
  pinnedMessageId?: unknown
  updatedAt?: unknown
}

/** Trim, strip NUL, cap. Returns null for anything that is not a usable id. */
export function normalizeChatPinId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const id = raw.replace(/\0/g, '').trim().slice(0, CHAT_PIN_ID_MAX)
  return id || null
}

/**
 * Read a room's pin list out of its parsed meta file, migrating the legacy
 * single `pinnedMessageId` into a one-entry list on the way through.
 *
 * Read-side migration on purpose: it is idempotent, it never rewrites a file
 * that was only being read, and a room that is never pinned again keeps its
 * original bytes. An existing pin is carried over, never dropped.
 *
 * Duplicates and unusable entries are dropped, and the result is capped, so
 * a hand-edited or truncated file can never produce an oversized list.
 */
export function readChatRoomPinIds(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  const raw = meta as ChatRoomPinMeta
  const out: string[] = []
  const seen = new Set<string>()
  const push = (candidate: unknown): void => {
    const id = normalizeChatPinId(candidate)
    if (!id || seen.has(id) || out.length >= CHAT_ROOM_PINS_MAX) return
    seen.add(id)
    out.push(id)
  }
  if (Array.isArray(raw.pinnedMessageIds)) {
    for (const entry of raw.pinnedMessageIds) push(entry)
    return out
  }
  // Legacy single-pin room. `null` is the stored "nothing pinned" value.
  push(raw.pinnedMessageId)
  return out
}

/**
 * Build the meta object to persist for `ids`.
 *
 * `pinnedMessageId` is still written, holding the newest pin, so a server
 * rolled back to a single-pin build reads the most recent pin rather than
 * nothing at all.
 */
export function buildChatRoomPinMeta(ids: readonly string[]): {
  pinnedMessageIds: string[]
  pinnedMessageId: string | null
  updatedAt: number
} {
  const list = [...ids]
  return {
    pinnedMessageIds: list,
    pinnedMessageId: newestChatRoomPin(list),
    updatedAt: Date.now(),
  }
}

/** The most recently pinned message, which is what a room banner shows. */
export function newestChatRoomPin(ids: readonly string[]): string | null {
  for (let i = ids.length - 1; i >= 0; i--) {
    const id = normalizeChatPinId(ids[i])
    if (id) return id
  }
  return null
}

export type ChatPinListResult =
  | { ok: true; ids: string[]; changed: boolean }
  | { error: string }

/**
 * Add `messageId` to the end of the list.
 *
 * Already pinned is a no-op that reports `changed: false`, never an error -
 * two people pinning the same message, or one person double-clicking, is
 * ordinary behaviour and not a failure.
 */
export function addChatRoomPin(ids: readonly string[], messageId: unknown): ChatPinListResult {
  const id = normalizeChatPinId(messageId)
  if (!id) return { error: 'message id required to pin' }
  const current = [...ids]
  if (current.includes(id)) return { ok: true, ids: current, changed: false }
  if (current.length >= CHAT_ROOM_PINS_MAX) return { error: CHAT_PINS_FULL_ERROR }
  current.push(id)
  return { ok: true, ids: current, changed: true }
}

/**
 * Remove `messageId` from the list, keeping the order of everything else.
 * Not pinned is a no-op that reports `changed: false`, never an error.
 */
export function removeChatRoomPin(ids: readonly string[], messageId: unknown): ChatPinListResult {
  const id = normalizeChatPinId(messageId)
  if (!id) return { error: 'message id required to unpin' }
  const current = [...ids]
  const at = current.indexOf(id)
  if (at < 0) return { ok: true, ids: current, changed: false }
  current.splice(at, 1)
  return { ok: true, ids: current, changed: true }
}

/**
 * Drop every id in `gone` from the list - used when a pinned message is
 * removed from the room or aged out of history, so a pin can never point at
 * a message that is no longer there.
 */
export function pruneChatRoomPins(
  ids: readonly string[],
  keep: (id: string) => boolean,
): { ids: string[]; changed: boolean } {
  const current = [...ids]
  const next = current.filter((id) => keep(id))
  return { ids: next, changed: next.length !== current.length }
}
