/**
 * Wire-format chat message shape shared by BridgeFrame variants.
 */

import type { BridgeRole } from './index.js'
import type { ChatAttachmentMeta, ChatMessageRow, ChatReactionMap } from './chat-room-history-store.js'

export type ChatMessagePayload = {
  id: string
  room: string
  body: string
  memberId: string
  memberName: string
  role: BridgeRole
  createdAt: number
  kind?: 'user' | 'system'
  replyToId?: string | null
  editedAt?: number | null
  /** TCC-R1130-CHAT-001 / TCC-R1132-CHAT-001: soft-delete tombstone timestamp, so
   *  Find/jump and react/pin fanout never resurrect a removed message client-side. */
  deletedAt?: number | null
  reactions?: ChatReactionMap
  pinned?: boolean
  attachments?: ChatAttachmentMeta[]
  /** TS-CHAT-013: live profile avatar blob sha (enriched from MemberRow, not history). */
  avatarRef?: string
  /**
   * TCC-R1152-CHAT-001: when the client minted this row's id as `clientMsgId`,
   * echo it so optimistic `pending-${id}` bubbles can be replaced on drain.
   */
  clientMsgId?: string
}

export function toChatMessagePayload(
  row: ChatMessageRow,
  opts?: {
    avatarRef?: string | null
    /** Authoritative room pin id - remaps sticky jsonl `pinned` (TCC-R1153-CHAT-009). */
    pinnedMessageId?: string | null
    /**
     * Authoritative room pin LIST - wins over `pinnedMessageId` when given.
     * A room can hold several pins, so membership of this list is what makes
     * a row pinned; the single id above only ever named the newest one.
     */
    pinnedMessageIds?: readonly string[]
    clientMsgId?: string | null
  },
): ChatMessagePayload {
  const avatarRaw = opts?.avatarRef
  const avatarRef =
    typeof avatarRaw === 'string' && /^[a-f0-9]{64}$/.test(avatarRaw.trim().toLowerCase())
      ? avatarRaw.trim().toLowerCase()
      : undefined
  const pinId =
    opts && 'pinnedMessageId' in (opts || {})
      ? opts?.pinnedMessageId === null
        ? null
        : typeof opts?.pinnedMessageId === 'string'
          ? opts.pinnedMessageId
          : undefined
      : undefined
  const pinIds = opts && Array.isArray(opts.pinnedMessageIds) ? opts.pinnedMessageIds : undefined
  const pinned =
    pinIds !== undefined
      ? pinIds.includes(row.id)
      : pinId === undefined
        ? row.pinned
        : pinId !== null && pinId === row.id
  const clientMsgId =
    typeof opts?.clientMsgId === 'string' && opts.clientMsgId.trim()
      ? opts.clientMsgId.trim().slice(0, 128)
      : undefined
  return {
    id: row.id,
    room: row.room,
    body: row.body,
    memberId: row.memberId,
    memberName: row.memberName,
    role: row.role,
    createdAt: row.createdAt,
    kind: row.kind,
    replyToId: row.replyToId ?? undefined,
    editedAt: row.editedAt ?? undefined,
    deletedAt: row.deletedAt ?? undefined,
    reactions: row.reactions,
    pinned,
    attachments: row.attachments,
    ...(avatarRef ? { avatarRef } : {}),
    ...(clientMsgId ? { clientMsgId } : {}),
  }
}
