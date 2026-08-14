/**
 * Team Space chat log facade (per-room history under chat/rooms/).
 */

import type { BridgeRole } from './index.js'
import type { AtRestKey } from './at-rest.js'
import {
  ChatRoomHistoryStore,
  type ChatAttachmentMeta,
  type ChatMessageRow,
  type ChatPinWriteResult,
  type ChatReactionMap,
} from './chat-room-history-store.js'
import { CHAT_TOMBSTONE_DAYS_DEFAULT } from './chat-room.js'

export type { ChatAttachmentMeta, ChatMessageRow, ChatPinWriteResult, ChatReactionMap }

export class ChatStore {
  private readonly inner: ChatRoomHistoryStore

  constructor(
    dataDir: string,
    retentionDays: number,
    tombstoneDays: number = CHAT_TOMBSTONE_DAYS_DEFAULT,
    atRest: AtRestKey | null = null,
  ) {
    this.inner = new ChatRoomHistoryStore(dataDir, retentionDays, tombstoneDays, atRest)
  }

  /** TCC-R1125-CHAT-001: async - falls back to a bounded disk lookup on cache miss. */
  findById(id: string, roomHint?: string): Promise<ChatMessageRow | null> {
    return this.inner.findById(id, roomHint)
  }

  /** TCC-R1133-CHAT-001: async - serialized per-room against concurrent writes/prune. */
  append(input: {
    room: string
    body: string
    memberId: string
    memberName: string
    role: BridgeRole
    kind?: 'user' | 'system'
    id?: string
    replyToId?: string | null
    attachments?: ChatAttachmentMeta[]
  }): Promise<ChatMessageRow | { error: string }> {
    return this.inner.append(input)
  }

  edit(
    messageId: string,
    editorMemberId: string,
    newBody: string,
    isAdmin: boolean,
    roomHint?: string,
    editWindowMs?: number,
  ): Promise<ChatMessageRow | { error: string }> {
    return this.inner.edit(messageId, editorMemberId, newBody, isAdmin, roomHint, editWindowMs)
  }

  react(
    messageId: string,
    memberId: string,
    emoji: string,
    remove: boolean,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string }> {
    return this.inner.react(messageId, memberId, emoji, remove, roomHint)
  }

  /** Pin one message. Already pinned is `unchanged`, a full room refuses. */
  pinMessage(roomId: string, messageId: string, byAdmin: boolean): Promise<ChatPinWriteResult> {
    return this.inner.pinMessage(roomId, messageId, byAdmin)
  }

  /** Unpin one message. Not pinned is `unchanged`. Null means the newest pin. */
  unpinMessage(
    roomId: string,
    messageId: string | null,
    byAdmin: boolean,
  ): Promise<ChatPinWriteResult> {
    return this.inner.unpinMessage(roomId, messageId, byAdmin)
  }

  /** Back-compat: an id pins, null unpins the newest. */
  setPinned(
    roomId: string,
    messageId: string | null,
    byAdmin: boolean,
  ): Promise<ChatPinWriteResult> {
    return this.inner.setPinned(roomId, messageId, byAdmin)
  }

  /** Every pinned message in the room, oldest pin first. */
  getPinnedMessageIds(roomId: string): string[] {
    return this.inner.getPinnedMessageIds(roomId)
  }

  /** The most recently pinned message - what a room banner shows. */
  getPinnedMessageId(roomId: string): string | null {
    return this.inner.getPinnedMessageId(roomId)
  }

  softDelete(
    messageId: string,
    byMemberId: string,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string } | { unchanged: true; tomb: ChatMessageRow }> {
    return this.inner.softDelete(messageId, byMemberId, roomHint)
  }

  /** Author unsend within CHAT_UNSEND_MS (or Admin). */
  authorUnsend(
    messageId: string,
    memberId: string,
    isAdmin: boolean,
    roomHint?: string,
  ): Promise<ChatMessageRow | { error: string } | { unchanged: true; tomb: ChatMessageRow }> {
    return this.inner.authorUnsend(messageId, memberId, isAdmin, roomHint)
  }

  exportRoom(
    room: string,
    format: 'json' | 'txt',
    opts?: { signal?: AbortSignal; maxBodyBytes?: number },
  ): Promise<{ body: string; truncated: boolean } | { error: string }> {
    return this.inner.exportRoom(room, format, opts)
  }

  readRecent(
    room: string,
    limit?: number,
    before?: number,
    beforeId?: string,
  ): Promise<{ messages: ChatMessageRow[]; truncated: boolean }> {
    // TCC-R1147-CHAT-005: thread beforeId so same-timestamp paging works
    // through the ChatStore facade (server already passes it).
    return this.inner.readRecent(room, limit, before, beforeId)
  }

  searchRoom(
    room: string,
    query: string,
    limit?: number,
  ): Promise<{ messageIds: string[]; truncated: boolean }> {
    return this.inner.searchRoom(room, query, limit)
  }

  jumpToMessage(
    room: string,
    messageId: string,
  ): Promise<{ message: ChatMessageRow | null; offset: number | null }> {
    return this.inner.jumpToMessage(room, messageId)
  }

  prune(): Promise<number> {
    return this.inner.prune()
  }

  /** TCC-R1144-MEDIA-002: live attachment blob digests for keep-set GC. */
  collectLiveBlobShas(): Promise<Set<string>> {
    return this.inner.collectLiveBlobShas()
  }

  getRetentionDays(): number {
    return this.inner.getRetentionDays()
  }

  setRetentionDays(days: number): void {
    this.inner.setRetentionDays(days)
  }

  /** TCC-R1133-CHAT-002: flush any debounced search-index writes now (shutdown / test hook). */
  flushAllPendingChatIndexes(): void {
    this.inner.flushAllPendingChatIndexes()
  }
}
