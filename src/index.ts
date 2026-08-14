/**
 * @aitomation/bridge - Team Space wire protocol (desktop + bridge share shape).
 */

export const BRIDGE_PROTOCOL_VERSION = 2

export type BridgeRole = 'admin' | 'member' | 'viewer'

export type { ChatMessagePayload } from './chat-message-payload.js'
import type { ChatMessagePayload } from './chat-message-payload.js'

export type OpKind =
  | 'record.create' | 'record.update' | 'record.delete'
  | 'record.trash' | 'record.restore' | 'record.purge'
  | 'field.create' | 'field.update' | 'field.delete'
  | 'view.create' | 'view.update' | 'view.delete'
  | 'entity.create' | 'entity.update' | 'entity.delete'
  | 'module.create' | 'module.update' | 'module.delete'
  | 'comment.create' | 'comment.update' | 'comment.delete'
  | 'cascade.patch'

export const KNOWN_OP_KINDS: ReadonlySet<string> = new Set([
  'record.create', 'record.update', 'record.delete',
  'record.trash', 'record.restore', 'record.purge',
  'field.create', 'field.update', 'field.delete',
  'view.create', 'view.update', 'view.delete',
  'entity.create', 'entity.update', 'entity.delete',
  'module.create', 'module.update', 'module.delete',
  'comment.create', 'comment.update', 'comment.delete',
  'cascade.patch',
])

export type ModulesSyncOp = {
  opId: string
  kind: OpKind | string
  targetKind: string
  targetId: string
  entityId?: string | null
  moduleId?: string | null
  patch?: Record<string, unknown>
  removeKeys?: string[]
  hlc: string
  originDevice: string
  hopCount: number
  protocolVersion: number
  originMemberId?: string
  originMemberName?: string
  /**
   * TS-SHR-022: when present and non-empty, bridge fanout/catch-up delivers
   * this op only to listed member ids (plus the originator). Absent / empty =
   * whole-team delivery (unchanged default).
   */
  visibleToMemberIds?: string[]
}

export type BridgeFrame =
  | {
      type: 'hello'
      protocolVersion: number
      memberId: string
      deviceId: string
      sessionToken?: string
      memberEmail?: string
      displayName?: string
      /**
       * Optional Admin recovery key - the escape hatch for an Admin who lost
       * their session token (see `admin-recovery.ts`). Absent / blank behaves
       * exactly as a hello did before this field existed. Only ever rebinds a
       * member that is ALREADY an admin, so it can never escalate a role.
       */
      adminRecoveryKey?: string
      /** Optional chat avatar wire ref (`local:avatar:vN`). */
      avatarRef?: string
      avatarRev?: number
    }
  | {
      type: 'hello_ok'
      protocolVersion: number
      teamId: string
      /** Canonical private-server name (admin-owned; may be default "Team Space"). */
      teamName?: string
      role: BridgeRole
      memberId: string
      sessionToken?: string
      /** TCC-R1143-LIM-004: member-readable voice + edit window caps. */
      chatCaps?: {
        voiceMessageMaxSec: number
        chatEditWindowSec: number
      }
    }
  | {
      type: 'chat_caps'
      chatCaps: {
        voiceMessageMaxSec: number
        chatEditWindowSec: number
      }
    }
  | { type: 'hello_refuse'; reason: string }
  | {
      type: 'invite_create'
      frameId: string
      email?: string
      role?: BridgeRole
    }
  | {
      type: 'invite_ok'
      frameId: string
      /** Stable invite id for list/cancel (TS-SHR-019). */
      id: string
      token: string
      expiresAt: number
      /** TCC-R1143-INV-002: persisted role (admin|member|viewer). */
      role?: BridgeRole
    }
  | {
      type: 'invite_revoke'
      frameId: string
      /** Invite id or plaintext token (TS-BRG-038). */
      tokenOrId: string
    }
  | {
      type: 'invite_revoke_ok'
      frameId: string
      id: string
    }
  | {
      type: 'invite_redeem'
      frameId: string
      token: string
      deviceId: string
      memberEmail?: string
      displayName?: string
    }
  | {
      type: 'invite_redeem_ok'
      frameId: string
      sessionToken: string
      memberId: string
      role: BridgeRole
      teamId: string
      teamName?: string
    }
  | { type: 'ops'; frameId: string; ops: ModulesSyncOp[] }
  | {
      /**
       * BRG-059 / TS-BRG-002: sent once after `sendCatchUpOps` finishes.
       * New devices and saturated tails stream the durable log oldest-first
       * in batches until every unacked op is sent (no 5k / 200k stop).
       * `truncated:true` is reserved for a hard transport abort, not a
       * window ceiling. The client persists a local Sync Issue and clears
       * it on a later `truncated:false`.
       */
      type: 'catchup_status'
      frameId: string
      truncated: boolean
      /** BRG-060: ops sent so far (progress). Absent on older servers. */
      sent?: number
      /** True when this device's catch-up scan finished. */
      done?: boolean
    }
  | {
      type: 'ops_result'
      frameId: string
      results: Array<{
        opId: string
        status: 'applied' | 'refused' | 'parked'
        reason?: string
      }>
    }
  | { type: 'ping'; t: number }
  | { type: 'pong'; t: number }
  | { type: 'ack_ops'; frameId: string; opIds: string[]; deviceId: string }
  | { type: 'ack_ops_ok'; frameId: string }
  | {
      type: 'snapshot_request'
      frameId: string
      moduleId: string
    }
  | {
      type: 'snapshot_refuse'
      frameId: string
      reason: string
    }
  | {
      type: 'kick_member'
      frameId: string
      memberId: string
    }
  | {
      type: 'set_team_name'
      frameId: string
      name: string
    }
  | {
      type: 'set_team_name_ok'
      frameId: string
      teamId: string
      teamName: string
    }
  | {
      type: 'kick_ok'
      frameId: string
      memberId: string
    }
  | {
      type: 'leave_team'
      frameId: string
    }
  | {
      type: 'leave_team_ok'
      frameId: string
      memberId: string
    }
  | {
      type: 'list_members'
      frameId: string
      limit?: number
      offset?: number
    }
  | {
      type: 'list_members_ok'
      frameId: string
      members: Array<{
        memberId: string
        email: string
        displayName: string
        role: BridgeRole
        avatarRef?: string | null
        avatarRev?: number
      }>
      total: number
      limit: number
      offset: number
      has_more: boolean
      truncated: boolean
    }
  | {
      type: 'revoke_session'
      frameId: string
      memberId: string
      deviceId?: string
    }
  | {
      type: 'revoke_ok'
      frameId: string
      memberId: string
      revokedDeviceIds: string[]
    }
  | {
      type: 'set_role'
      frameId: string
      memberId: string
      role: BridgeRole
    }
  | {
      type: 'set_role_ok'
      frameId: string
      memberId: string
      role: BridgeRole
    }
  /** Fan-out when an Admin changes a member's bridge role (target must persist). */
  | {
      type: 'role_peer'
      memberId: string
      role: BridgeRole
    }
  /** TCC-R1152-BRG-003: fanout after Admin renames the team. */
  | {
      type: 'team_name_peer'
      teamId: string
      teamName: string
    }
  | {
      type: 'invite_list'
      frameId: string
    }
  | {
      type: 'invite_list_ok'
      frameId: string
      invites: Array<{
        /** Stable id (desktop requires row.id - TS-SHR-019). */
        id: string
        /** Plaintext when still in process memory; else empty. */
        token: string
        email: string
        role: BridgeRole
        createdAt: number
        expiresAt: number
      }>
    }
  /** M-P5YJS1: join a Doc/Whiteboard CRDT room (relay only; no persistence yet). */
  | {
      type: 'yjs_join'
      frameId: string
      room: string
    }
  | {
      type: 'yjs_leave'
      frameId: string
      room: string
    }
  | {
      type: 'yjs_update'
      frameId: string
      room: string
      /** Base64 / base64url Yjs update bytes. */
      updateB64: string
    }
  | {
      type: 'yjs_ok'
      frameId: string
      room: string
      action: 'join' | 'leave' | 'update'
    }
  | {
      type: 'yjs_refuse'
      frameId: string
      room?: string
      reason: string
    }
  /** Fan-out to other room peers (no frameId - not a request reply). */
  | {
      type: 'yjs_peer_update'
      room: string
      updateB64: string
      fromMemberId: string
      fromDeviceId: string
    }
  /**
   * Plan L: Yjs Awareness (cursors / pointers) - same room + size caps as
   * yjs_update; applied via y-protocols Awareness, not Y.applyUpdate.
   */
  | {
      type: 'yjs_awareness'
      frameId: string
      room: string
      updateB64: string
    }
  | {
      type: 'yjs_peer_awareness'
      room: string
      updateB64: string
      fromMemberId: string
      fromDeviceId: string
    }
  /** Plan L Presence: request current online roster. */
  | {
      type: 'presence_get'
      frameId: string
    }
  | {
      type: 'presence_snapshot'
      frameId?: string
      peers: Array<{
        memberId: string
        displayName: string
        role: BridgeRole
        deviceId: string
        lastSeen: number
      }>
    }
  /** Fan-out join/leave (no frameId). Leave only when member has no live socket left. */
  | {
      type: 'presence_peer'
      event: 'join' | 'leave'
      peer: {
        memberId: string
        displayName: string
        role: BridgeRole
        deviceId: string
        lastSeen: number
      }
    }
  /** P5-CHAT: post a message (Member/Admin; Viewer refused). */
  | {
      type: 'chat_send'
      frameId: string
      room: string
      body: string
      clientMsgId?: string
      replyToId?: string
      /** TCC-R1143-MEDIA-007: optional durationSec on voice attachments. */
      attachments?: Array<{
        blobId: string
        name?: string
        bytes?: number
        mime?: string
        durationSec?: number
      }>
    }
  | {
      type: 'chat_ok'
      frameId: string
      message: ChatMessagePayload
    }
  | {
      type: 'chat_refuse'
      frameId: string
      room?: string
      reason: string
      /**
       * Owner/admin succession (additive pass): set true ONLY when a
       * `chat_room_leave` refusal means "you are this room's sole owner and
       * other members remain" - the client must offer transfer-ownership or
       * dissolve instead of a generic error toast. Never set for any other
       * refusal reason (closed enum of ONE meaning, not a general flag).
       */
      requiresOwnerAction?: boolean
    }
  /** Fan-out chat to other live sockets (no frameId). */
  | {
      type: 'chat_peer'
      message: ChatMessagePayload
    }
  | {
      type: 'chat_history'
      frameId: string
      room: string
      limit?: number
      before?: number
    }
  | {
      type: 'chat_history_ok'
      frameId: string
      room: string
      messages: ChatMessagePayload[]
      truncated?: boolean
      /**
       * TCC-R1134-CHAT2-003: the room's authoritative pins, even ones outside
       * this page. `pinnedMessageIds` is the whole list in pin order, oldest
       * first; `pinnedMessageId` repeats its newest entry for clients built
       * before a room could hold more than one pin.
       */
      pinnedMessageId?: string | null
      pinnedMessageIds?: string[]
    }
  /** Admin soft-delete (moderate). */
  | {
      type: 'chat_delete'
      frameId: string
      messageId: string
    }
  | {
      type: 'chat_delete_ok'
      frameId: string
      messageId: string
    }
  | {
      type: 'chat_delete_peer'
      messageId: string
      room: string
      /** Original message createdAt (for peer unread honesty). */
      createdAt?: number
      /** Original author memberId (for peer unread honesty). */
      memberId?: string
    }
  | { type: 'chat_rooms_list'; frameId: string }
  | {
      type: 'chat_rooms_ok'
      frameId: string
      rooms: Array<{
        id: string
        kind: 'team' | 'dm' | 'group' | 'private'
        title: string
        memberIds: string[]
        createdAt: number
        unread?: number
        /** P2: group management panel fields, present for group/private rooms. */
        description?: string
        iconKind?: 'none' | 'preset' | 'custom'
        iconRef?: string | null
        iconRev?: number
        permissions?: {
          addMembers: 'owner_admin' | 'anyone'
          editInfo: 'owner_admin' | 'anyone'
          pinMessages: 'admin_only' | 'anyone'
        }
      }>
      /** True when bridge dropped rooms past CHAT_ROOMS_LIST_MAX. */
      truncated?: boolean
    }
  | {
      type: 'chat_room_create'
      frameId: string
      kind: 'dm' | 'group' | 'private'
      title?: string
      memberIds?: string[]
      targetMemberId?: string
      password?: string
      /** P2: optional description set at create time (group/private only). */
      description?: string
    }
  | {
      type: 'chat_room_create_ok'
      frameId: string
      room: {
        id: string
        kind: 'team' | 'dm' | 'group' | 'private'
        title: string
        memberIds: string[]
        createdAt: number
        ownerIds?: string[]
        bannedMemberIds?: string[]
        allowedReactionEmojis?: string[]
        description?: string
        iconKind?: 'none' | 'preset' | 'custom'
        iconRef?: string | null
        iconRev?: number
        permissions?: {
          addMembers: 'owner_admin' | 'anyone'
          editInfo: 'owner_admin' | 'anyone'
          pinMessages: 'admin_only' | 'anyone'
        }
      }
    }
  | { type: 'chat_unread_get'; frameId: string }
  | {
      type: 'chat_unread_ok'
      frameId: string
      marks: Record<string, { lastReadAt: number; lastReadMsgId?: string | null }>
    }
  | {
      type: 'chat_unread_set'
      frameId: string
      room: string
      lastReadAt?: number
      lastReadMsgId?: string | null
    }
  | { type: 'chat_unread_set_ok'; frameId: string; room: string }
  /** Typing indicator (Member/Admin; coalesced fanout). */
  | { type: 'chat_typing'; room: string; typing?: boolean }
  | {
      type: 'chat_typing_peer'
      room: string
      memberId: string
      memberName: string
      /** TCC-R1148-LIM-001: false clears peer typing chips. */
      typing?: boolean
    }
  | {
      type: 'chat_edit'
      frameId: string
      messageId: string
      body: string
      /**
       * TCC-R1125-CHAT-001: the desktop client already sends the owning room
       * on this frame - use it as a disk-lookup hint when the message fell
       * out of the bridge's in-memory `recentById` cache so edit doesn't
       * fail "Message not found" on rows past the LRU cap.
       */
      room?: string
    }
  | { type: 'chat_edit_ok'; frameId: string; message: ChatMessagePayload }
  | { type: 'chat_edit_peer'; message: ChatMessagePayload }
  | {
      type: 'chat_react'
      frameId: string
      messageId: string
      emoji: string
      remove?: boolean
      /** TCC-R1125-CHAT-001: same disk-lookup hint as chat_edit.room. */
      room?: string
    }
  | { type: 'chat_react_ok'; frameId: string; message: ChatMessagePayload }
  | { type: 'chat_react_peer'; message: ChatMessagePayload }
  | {
      type: 'chat_pin'
      frameId: string
      room: string
      messageId?: string | null
      /**
       * When false, unpin. A room can hold several pins, so an unpin names the
       * message to remove; a missing id unpins the most recently pinned one,
       * which is all a client built before multi-pin could ask for.
       */
      pinned?: boolean
    }
  /**
   * `pinnedMessageIds` is the room's whole pin list, oldest pin first.
   * `pinnedMessageId` repeats its newest entry for clients built before a
   * room could hold more than one pin.
   */
  | {
      type: 'chat_pin_ok'
      frameId: string
      room: string
      pinnedMessageId: string | null
      pinnedMessageIds?: string[]
    }
  | {
      type: 'chat_pin_peer'
      room: string
      pinnedMessageId: string | null
      pinnedMessageIds?: string[]
    }
  | {
      type: 'chat_search'
      frameId: string
      room: string
      query: string
      limit?: number
    }
  | {
      type: 'chat_search_ok'
      frameId: string
      room: string
      messageIds: string[]
      truncated?: boolean
    }
  | {
      type: 'chat_jump'
      frameId: string
      room: string
      messageId: string
    }
  | {
      type: 'chat_jump_ok'
      frameId: string
      room: string
      message: ChatMessagePayload | null
      offset?: number | null
    }
  | {
      type: 'chat_unsend'
      frameId: string
      messageId: string
      /** TCC-R1125-CHAT-001: disk-lookup hint (same purpose as chat_edit.room). */
      room?: string
    }
  | { type: 'chat_unsend_ok'; frameId: string; messageId: string }
  | {
      type: 'chat_export'
      frameId: string
      room: string
      format?: 'json' | 'txt'
    }
  | {
      type: 'chat_export_ok'
      frameId: string
      room: string
      format: 'json' | 'txt'
      body: string
      truncated?: boolean
    }
  | { type: 'chat_metrics'; frameId: string }
  | {
      type: 'chat_metrics_ok'
      frameId: string
      metrics: Record<string, number>
    }
  | { type: 'chat_config_get'; frameId: string }
  | {
      type: 'chat_config_set'
      frameId: string
      retentionDays?: number
      chatFilesBytes?: number
      chatBlobsBytes?: number
    }
  | {
      type: 'chat_config_ok'
      frameId: string
      config: {
        retentionDays: number
        chatFilesBytes: number
        chatBlobsBytes: number
        usedFilesBytes: number
        usedBlobsBytes: number
      }
    }
  | {
      type: 'chat_room_join'
      frameId: string
      room: string
      password?: string
      inviteToken?: string
    }
  | {
      type: 'chat_room_join_ok'
      frameId: string
      room: {
        id: string
        kind: 'team' | 'dm' | 'group' | 'private'
        title: string
        memberIds: string[]
        createdAt: number
        ownerIds?: string[]
        bannedMemberIds?: string[]
        allowedReactionEmojis?: string[]
      }
    }
  | {
      type: 'chat_room_invite'
      frameId: string
      room: string
    }
  | {
      type: 'chat_room_invite_ok'
      frameId: string
      room: string
      /** Plaintext invite token (show once; bridge stores hash only). */
      inviteToken: string
    }
  | {
      type: 'chat_room_leave'
      frameId: string
      room: string
    }
  | {
      type: 'chat_room_leave_ok'
      frameId: string
      room: string
    }
  /**
   * Owner/admin succession (additive pass): explicit "end this group for
   * everyone" - reuses the SAME server-side effect as `closeRoom` (clears
   * membership + stamps closedAt) but, unlike the internal team-departure
   * cleanup path, requires `canManageRoom` (room owner or team Admin) since
   * a member choosing this deliberately destroys the room for every other
   * member. Group/private only - team room has no dissolve, DM already has
   * its own close-on-leave path.
   */
  | {
      type: 'chat_room_dissolve'
      frameId: string
      room: string
    }
  | {
      type: 'chat_room_dissolve_ok'
      frameId: string
      room: string
    }
  | {
      type: 'chat_room_password'
      frameId: string
      room: string
      /** New private-room password (never echoed; bridge stores scrypt hash only). */
      password: string
    }
  | {
      type: 'chat_room_password_ok'
      frameId: string
      room: string
    }
  | {
      type: 'chat_room_add_members'
      frameId: string
      room: string
      memberIds: string[]
    }
  | {
      type: 'chat_room_add_members_ok'
      frameId: string
      room: string
      added: string[]
      memberIds: string[]
    }
  | {
      type: 'chat_room_remove_members'
      frameId: string
      room: string
      memberIds: string[]
    }
  | {
      type: 'chat_room_remove_members_ok'
      frameId: string
      room: string
      removed: string[]
      memberIds: string[]
    }
  | {
      type: 'chat_room_promote_owner'
      frameId: string
      room: string
      memberId: string
    }
  | {
      type: 'chat_room_promote_owner_ok'
      frameId: string
      room: string
      ownerIds: string[]
    }
  | {
      type: 'chat_room_demote_owner'
      frameId: string
      room: string
      memberId: string
    }
  | {
      type: 'chat_room_demote_owner_ok'
      frameId: string
      room: string
      ownerIds: string[]
    }
  | {
      type: 'chat_room_ban_member'
      frameId: string
      room: string
      memberId: string
    }
  | {
      type: 'chat_room_ban_member_ok'
      frameId: string
      room: string
      bannedMemberIds: string[]
      memberIds: string[]
    }
  | {
      type: 'chat_room_unban_member'
      frameId: string
      room: string
      memberId: string
    }
  | {
      type: 'chat_room_unban_member_ok'
      frameId: string
      room: string
      bannedMemberIds: string[]
    }
  | {
      type: 'chat_room_set_reactions'
      frameId: string
      room: string
      /** Empty = unrestricted (grant-all). */
      allowedReactionEmojis: string[]
    }
  | {
      type: 'chat_room_set_reactions_ok'
      frameId: string
      room: string
      allowedReactionEmojis: string[]
    }
  | {
      type: 'chat_room_members_peer'
      room: string
      memberIds: string[]
      ownerIds: string[]
      bannedMemberIds: string[]
      allowedReactionEmojis?: string[]
    }
  | {
      type: 'chat_seen_peer'
      room: string
      memberId: string
      lastReadAt: number
      lastReadMsgId?: string | null
    }
  | {
      type: 'chat_seen_get'
      frameId: string
      room: string
    }
  | {
      type: 'chat_seen_ok'
      frameId: string
      room: string
      marks: Array<{
        memberId: string
        lastReadAt: number
        lastReadMsgId?: string | null
      }>
    }
  | {
      type: 'chat_room_rename'
      frameId: string
      room: string
      title: string
    }
  | {
      type: 'chat_room_rename_ok'
      frameId: string
      room: string
      title: string
    }
  /** Peer fanout after rename (room members except actor). */
  | {
      type: 'chat_room_rename_peer'
      room: string
      title: string
    }
  /**
   * P2 group management panel: set description and/or icon in one request
   * (edited together in the same settings panel). `description: null`
   * clears it (empty string also clears - both accepted). `iconKind:'none'`
   * clears the icon. Server enforces `row.permissions.editInfo` policy.
   */
  | {
      type: 'chat_room_set_info'
      frameId: string
      room: string
      description?: string | null
      iconKind?: 'none' | 'preset' | 'custom'
      iconRef?: string | null
    }
  | {
      type: 'chat_room_set_info_ok'
      frameId: string
      room: string
      description: string
      iconKind: 'none' | 'preset' | 'custom'
      iconRef: string | null
      iconRev: number
    }
  /**
   * P2: patch the closed addMembers/editInfo permission policy. ALWAYS
   * owner/admin-only server-side regardless of current policy value.
   * `pinMessages` (additive) is deliberately role-based, not owner-based -
   * see `canPinRoomMessages` doc-comment in chat-rooms-store.ts.
   */
  | {
      type: 'chat_room_set_permissions'
      frameId: string
      room: string
      addMembers?: 'owner_admin' | 'anyone'
      editInfo?: 'owner_admin' | 'anyone'
      pinMessages?: 'admin_only' | 'anyone'
    }
  | {
      type: 'chat_room_set_permissions_ok'
      frameId: string
      room: string
      permissions: {
        addMembers: 'owner_admin' | 'anyone'
        editInfo: 'owner_admin' | 'anyone'
        pinMessages: 'admin_only' | 'anyone'
      }
    }
  /**
   * Peer fanout after a P2 description/icon/permissions change (room
   * members except actor). Only the field(s) that actually changed are
   * present - clients apply whichever of these are set.
   */
  | {
      type: 'chat_room_info_peer'
      room: string
      description?: string
      iconKind?: 'none' | 'preset' | 'custom'
      iconRef?: string | null
      iconRev?: number
      permissions?: {
        addMembers: 'owner_admin' | 'anyone'
        editInfo: 'owner_admin' | 'anyone'
        pinMessages: 'admin_only' | 'anyone'
      }
    }
  /** TS-CHAT-011: peer fanout when a DM closes (team depart / empty roster). */
  | {
      type: 'chat_room_close_peer'
      room: string
    }
  /** TS-CHAT-012 / E20: member updates display name and/or chat avatar ref. */
  | {
      type: 'profile_update'
      frameId: string
      displayName?: string
      avatarRef?: string | null
      avatarRev?: number
    }
  | {
      type: 'profile_update_ok'
      frameId: string
      displayName: string
      avatarRef?: string | null
      avatarRev?: number
    }
  /** Peer fanout after profile_update (all live sockets except actor). */
  | {
      type: 'profile_peer'
      memberId: string
      displayName: string
      avatarRef?: string | null
      avatarRev?: number
    }
  /**
   * Ask Admin devices to create a local Tasks item (never Modules CRM).
   * Bridge fans to Admin sockets only; Admin desktop replies with task_ack.
   */
  | {
      type: 'task_request'
      frameId: string
      title: string
      body?: string
      chatMessageId?: string
      fromMemberId: string
      fromMemberName: string
    }
  | {
      type: 'task_ack'
      frameId: string
      ok: boolean
      taskId?: string
      reason?: string
      hostMemberId?: string
      title?: string
    }
  /** Broadcast task outcome to all live sockets (plain-English notice). */
  | {
      type: 'task_peer_notice'
      ok: boolean
      title: string
      hostMemberId?: string
      reason?: string
      requesterMemberId?: string
    }
  /**
   * Temporary chat (never-persisted 1:1 DM). Message bodies and room
   * existence for every `ephemeral_*` frame live ONLY in bridge process
   * memory (see `ephemeral-chat.ts` + server.ts dispatcher) - never written
   * to the chat store, never queued past a synchronous live-relay attempt.
   */
  | {
      type: 'ephemeral_start'
      frameId: string
      targetMemberId: string
      /** Client-suggested close-timeout (ms); bridge clamps into its own bounds. */
      closeTimeoutMs?: number
    }
  | {
      type: 'ephemeral_start_ok'
      frameId: string
      inviteId: string
      targetMemberId: string
    }
  | {
      type: 'ephemeral_refuse'
      frameId: string
      reason: string
      room?: string
    }
  /** Live push to the target's connected sockets (no frameId). */
  | {
      type: 'ephemeral_invite'
      inviteId: string
      room: string
      fromMemberId: string
      fromMemberName: string
      expiresAt: number
    }
  | {
      type: 'ephemeral_accept'
      frameId: string
      inviteId: string
    }
  | {
      type: 'ephemeral_accept_ok'
      frameId: string
      room: string
    }
  | {
      type: 'ephemeral_decline'
      frameId: string
      inviteId: string
    }
  | {
      type: 'ephemeral_decline_ok'
      frameId: string
      inviteId: string
    }
  /** Push to the ORIGINAL inviter once the recipient answers (no frameId - not a reply to their own frame). */
  | {
      type: 'ephemeral_accepted'
      room: string
      byMemberId: string
      byMemberName: string
    }
  | {
      type: 'ephemeral_declined'
      inviteId: string
      room: string
      byMemberId: string
    }
  | {
      type: 'ephemeral_message'
      frameId: string
      room: string
      body: string
      clientMsgId?: string
      /** Reply-to-message parity: id of an earlier message in this SAME room. Opaque to the bridge - never resolved/looked up here, only bounded and relayed. */
      replyToId?: string
    }
  | {
      type: 'ephemeral_message_ok'
      frameId: string
      room: string
      clientMsgId?: string
      createdAt: number
    }
  /** Live relay to the other member's connected sockets only (no queueing). */
  | {
      type: 'ephemeral_peer_message'
      room: string
      body: string
      fromMemberId: string
      fromMemberName: string
      createdAt: number
      clientMsgId?: string
      replyToId?: string
    }
  /**
   * P2 (extended to temporary chats): set/clear the in-memory-only
   * description and/or preset icon for a still-live ephemeral room (1:1 or
   * group). No owner concept in ephemeral rooms - any current member may
   * set these (symmetric peer model, same as the rest of Temporary chat).
   * Never persisted anywhere - lives only in `EphemeralRoomState` and is
   * wiped when the room closes/tears down, same as message bodies.
   */
  | {
      type: 'ephemeral_set_info'
      frameId: string
      room: string
      description?: string | null
      iconPreset?: string | null
    }
  | {
      type: 'ephemeral_set_info_ok'
      frameId: string
      room: string
      description: string
      iconPreset: string | null
    }
  /** Live relay of an ephemeral_set_info change to the room's other current members. */
  | {
      type: 'ephemeral_info_peer'
      room: string
      description: string
      iconPreset: string | null
      fromMemberId: string
    }
  | {
      type: 'ephemeral_close_request'
      frameId: string
      room: string
    }
  | {
      type: 'ephemeral_close_request_ok'
      frameId: string
      room: string
    }
  /** Push to the other live member that this side asked to end the chat. */
  | {
      type: 'ephemeral_close_requested'
      room: string
      byMemberId: string
    }
  /** Terminal event - every recipient must wipe all local state for `room` on receipt. */
  | {
      type: 'ephemeral_closed'
      room: string
      reason: 'mutual' | 'timeout' | 'peer_left'
    }
  /** The other member's connection dropped; close-timeout countdown has started. */
  | {
      type: 'ephemeral_peer_offline'
      room: string
      memberId: string
    }
  /** The other member reconnected before the close-timeout elapsed. */
  | {
      type: 'ephemeral_peer_online'
      room: string
      memberId: string
    }
  /**
   * Round-1157: temporary GROUP chat (3+ members) - reuses the exact same
   * never-persisted contract as the 1:1 frames above. A group room is only
   * created once EVERY invited member has accepted (see `ephemeral-chat.ts`
   * doc-comment for why); `ephemeral_message`/`ephemeral_close_request`
   * above are reused unchanged once a room exists (they already fan out to
   * whichever member ids are in the room). `ephemeral_leave` is new: unlike
   * `ephemeral_close_request` (mutual N-party handshake to end for
   * everyone), Leave is an immediate, unilateral departure from a
   * still-multi-person room.
   */
  | {
      type: 'ephemeral_group_start'
      frameId: string
      targetMemberIds: string[]
      closeTimeoutMs?: number
    }
  | {
      type: 'ephemeral_group_start_ok'
      frameId: string
      formationId: string
      targetMemberIds: string[]
    }
  /** Live push to every invitee's connected sockets (no frameId). */
  | {
      type: 'ephemeral_group_invite'
      formationId: string
      fromMemberId: string
      fromMemberName: string
      /** Every OTHER invitee (not the recipient), for "who else is invited" context. */
      otherMemberIds: string[]
      otherMemberNames: string[]
      expiresAt: number
    }
  | {
      type: 'ephemeral_group_accept'
      frameId: string
      formationId: string
    }
  | {
      type: 'ephemeral_group_accept_ok'
      frameId: string
      formationId: string
    }
  | {
      type: 'ephemeral_group_decline'
      frameId: string
      formationId: string
    }
  | {
      type: 'ephemeral_group_decline_ok'
      frameId: string
      formationId: string
    }
  /** Live progress push to the initiator + everyone who has accepted so far. */
  | {
      type: 'ephemeral_group_member_accepted'
      formationId: string
      byMemberId: string
      byMemberName: string
      acceptedCount: number
      totalCount: number
    }
  /** Terminal success: pushed to every member once the LAST invitee accepts. */
  | {
      type: 'ephemeral_group_formed'
      formationId: string
      room: string
      memberIds: string[]
      members: Array<{ memberId: string; displayName: string }>
    }
  /** Terminal failure: pushed to every remaining formation participant (incl. the initiator). */
  | {
      type: 'ephemeral_group_cancelled'
      formationId: string
      reason: 'declined' | 'expired' | 'member_offline' | 'refused'
      byMemberId?: string
    }
  | {
      type: 'ephemeral_leave'
      frameId: string
      room: string
    }
  | {
      type: 'ephemeral_leave_ok'
      frameId: string
      room: string
    }
  /** Live push to every remaining member once someone leaves without ending the chat. */
  | {
      type: 'ephemeral_member_left'
      room: string
      memberId: string
      memberIds: string[]
    }
  | { type: 'error'; requestId?: string; message: string }

export function isFiniteRequestId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 200
}

export function mintToken(bytes = 32): string {
  const { randomBytes } = require('node:crypto') as typeof import('node:crypto')
  return randomBytes(bytes).toString('base64url')
}
