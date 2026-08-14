/**
 * Team Space chat room registry (multi-room messenger).
 * File: chat/rooms.json under TEAMSPACE_DATA_DIR.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import type { AtRestKey } from './at-rest.js'
import { encryptJsonFile, decryptJsonFile } from './at-rest.js'
import {
  CHAT_ROOM_TEAM,
  type ChatRoomKind,
  dmRoomId,
  legacyDmRoomId,
  splitChatDmPair,
  parseChatRoomId,
  capChatText,
} from './chat-room.js'

export type ChatRoomRow = {
  id: string
  kind: ChatRoomKind
  title: string
  memberIds: string[]
  createdBy: string
  createdAt: number
  closedAt?: number | null
  /** Hashed invite token for private rooms (never plaintext). */
  inviteHash?: string | null
  /**
   * Absolute wall-clock deadline for the outstanding `inviteHash`
   * (`CHAT_ROOM_INVITE_TTL_MS` after mint). `null` on rows minted before this
   * field existed - those are treated as ALREADY EXPIRED on redeem rather than
   * as never-expiring, so an old leaked token cannot outlive this change.
   */
  inviteExpiresAt?: number | null
  /** scrypt password hash for private join (optional). */
  passwordHash?: string | null
  /**
   * Per-room owners (creator becomes owner on create; team Admin always
   * overrides regardless of membership). Back-filled to `[createdBy]` on load
   * when missing. Empty only for the system team room.
   */
  ownerIds: string[]
  /** Members banned from rejoining this room (checked before admit/invite redeem). */
  bannedMemberIds: string[]
  /**
   * Reaction emoji allowlist. Empty `[]` = unrestricted (grant-all convention,
   * same polarity as agent `config.tools`). Non-empty = only listed emoji may
   * be used in `chat_react` for this room.
   */
  allowedReactionEmojis: string[]
  /**
   * Group management panel (P2, additive): bounded-length group description.
   * Empty string = no description set. Group/private only (team/dm never
   * carry one - `setDescription` refuses those kinds the same as `setTitle`).
   */
  description: string
  /**
   * Room icon. `'none'` = no custom icon (client falls back to its default
   * kind-based glyph). `'preset'` = `iconRef` is one of the closed
   * `CHAT_ROOM_ICON_PRESETS` ids (no bytes stored anywhere). `'custom'` =
   * `iconRef` is a content-addressed sha256 already present in the SAME
   * `ChatAvatarStore` blob dir member avatars use (TS-CHAT-012/013 pipeline
   * reused, not a second avatar system) - `server.ts` proves the blob exists
   * via `chatAvatars.get()` before ever accepting `'custom'`.
   */
  iconKind: 'none' | 'preset' | 'custom'
  iconRef: string | null
  /** Bumped on every icon change so clients can cache-bust like `avatarRev`. */
  iconRev: number
  /**
   * Closed, enumerable, server-enforced permission set (P2). `removeMembers`
   * is deliberately NOT a toggle here - it is always owner/admin only,
   * matching the pre-existing `chat_room_remove_members` gate this store
   * already enforced before P2 existed. `addMembers`/`editInfo` toggle
   * between the two closed policies; default `'anyone'` preserves the exact
   * pre-P2 behavior (any non-viewer member could already add members/rename)
   * so existing rooms are not silently tightened by this migration.
   * `pinMessages` (additive) toggles who may pin/unpin in this room; default
   * `'admin_only'` preserves the exact pre-existing `chat_pin` behavior
   * (hardcoded team-Admin-only) so existing rooms are not silently loosened.
   */
  permissions: {
    addMembers: 'owner_admin' | 'anyone'
    editInfo: 'owner_admin' | 'anyone'
    pinMessages: 'admin_only' | 'anyone'
  }
}

/** Bounded length for the P2 group description field (same order as title's 120 cap). */
export const CHAT_ROOM_DESCRIPTION_MAX = 500

/**
 * How long a minted private-room invite token stays redeemable. Matches the
 * team-invite TTL in `store.ts` (`INVITE_TTL_MS`, 24h) so both invite families
 * age out on the same clock. Fixed, NOT env-tunable: the desktop copy shown
 * when the token is copied states the 24-hour window in plain English
 * (`copy.teamspace.ts` `mintInviteCopied`), and a tunable value would let that
 * promise drift from reality per deployment.
 */
export const CHAT_ROOM_INVITE_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Closed set of preset room icons (P2). No free-text emoji upload needed per
 * spec - these are stable ids the client maps to a fixed glyph+color; never
 * add a value here without also adding its client-side rendering, and never
 * accept an icon value outside this set for `iconKind:'preset'`.
 */
export const CHAT_ROOM_ICON_PRESETS = [
  'blue', 'green', 'purple', 'orange', 'pink', 'teal', 'red', 'slate',
] as const
export type ChatRoomIconPreset = (typeof CHAT_ROOM_ICON_PRESETS)[number]
export function isChatRoomIconPreset(v: unknown): v is ChatRoomIconPreset {
  return typeof v === 'string' && (CHAT_ROOM_ICON_PRESETS as readonly string[]).includes(v)
}

/** Named presets plus `#rrggbb` from the desktop color picker. */
export function isChatRoomIconColorRef(v: unknown): boolean {
  if (isChatRoomIconPreset(v)) return true
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v.trim())
}

function defaultRoomPermissions(): ChatRoomRow['permissions'] {
  return { addMembers: 'anyone', editInfo: 'anyone', pinMessages: 'admin_only' }
}

/** Cap for rooms listed per member (oldest-created kept first after sort). */
export const CHAT_ROOMS_LIST_MAX = 2000

/**
 * Structural hard ceiling for room members (never raise past this even via
 * admin Limits meta). Soft default used when no live Limits override is set.
 */
export const CHAT_ROOM_MEMBERS_HARD_CAP = 5000
export const CHAT_ROOM_MEMBERS_DEFAULT_CAP = 500

/** Live room-member cap resolver (wired from TeamLimitsMeta; defaults here). */
let _roomMembersCap = CHAT_ROOM_MEMBERS_DEFAULT_CAP

export function getChatRoomMembersCap(): number {
  return _roomMembersCap
}

export function setChatRoomMembersCap(n: number): number {
  const next = Math.min(
    CHAT_ROOM_MEMBERS_HARD_CAP,
    Math.max(2, Math.floor(Number.isFinite(n) ? n : CHAT_ROOM_MEMBERS_DEFAULT_CAP)),
  )
  _roomMembersCap = next
  return next
}

function normalizeIdList(raw: unknown, cap: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const id = x.replace(/\0/g, '').trim().slice(0, 128)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= cap) break
  }
  return out
}

function normalizeEmojiAllowlist(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const x of raw) {
    if (typeof x !== 'string') continue
    const emoji = x.replace(/\0/g, '').trim().slice(0, 32)
    if (!emoji || seen.has(emoji)) continue
    seen.add(emoji)
    out.push(emoji)
    if (out.length >= 500) break
  }
  return out
}

function publicRoomFields(row: ChatRoomRow): {
  id: string
  kind: ChatRoomKind
  title: string
  memberIds: string[]
  createdAt: number
  ownerIds: string[]
  bannedMemberIds: string[]
  allowedReactionEmojis: string[]
  description: string
  iconKind: 'none' | 'preset' | 'custom'
  iconRef: string | null
  iconRev: number
  permissions: {
    addMembers: 'owner_admin' | 'anyone'
    editInfo: 'owner_admin' | 'anyone'
    pinMessages: 'admin_only' | 'anyone'
  }
} {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    memberIds: [...row.memberIds],
    createdAt: row.createdAt,
    ownerIds: [...row.ownerIds],
    bannedMemberIds: [...row.bannedMemberIds],
    allowedReactionEmojis: [...row.allowedReactionEmojis],
    description: row.description,
    iconKind: row.iconKind,
    iconRef: row.iconRef,
    iconRev: row.iconRev,
    permissions: { ...row.permissions },
  }
}

export { publicRoomFields }

export function isRoomOwner(row: ChatRoomRow, memberId: string): boolean {
  const id = String(memberId || '').trim()
  if (!id) return false
  return row.ownerIds.includes(id)
}

export function canManageRoom(
  row: ChatRoomRow,
  memberId: string,
  teamRole: string | null | undefined,
): boolean {
  if (teamRole === 'admin') return true
  return isRoomOwner(row, memberId)
}

/**
 * P2 permission model: whether `memberId` may add new members to `row`,
 * given `row.permissions.addMembers`. Caller must already have proven the
 * actor is a session member/team-Admin (this only applies the POLICY, not
 * authentication/membership - same split as `canManageRoom`).
 */
export function canAddRoomMembers(
  row: ChatRoomRow,
  memberId: string,
  teamRole: string | null | undefined,
): boolean {
  if (row.permissions.addMembers === 'anyone') return true
  return canManageRoom(row, memberId, teamRole)
}

/**
 * P2 permission model: whether `memberId` may rename or change the
 * description/icon of `row`, given `row.permissions.editInfo`.
 */
export function canEditRoomInfo(
  row: ChatRoomRow,
  memberId: string,
  teamRole: string | null | undefined,
): boolean {
  if (row.permissions.editInfo === 'anyone') return true
  return canManageRoom(row, memberId, teamRole)
}

/**
 * Whether `memberId` may pin/unpin messages in `row`, given
 * `row.permissions.pinMessages`. Unlike `canAddRoomMembers`/`canEditRoomInfo`
 * this is deliberately ROLE-based, not owner-based - a room owner with no
 * team-Admin role gets no special pin right under the default `'admin_only'`
 * policy, matching the plain-English "Only Admins can pin messages" /
 * "Any member can pin messages" toggle copy exactly (no owner carve-out to
 * document). Viewers can never pin regardless of policy (read-only role).
 */
export function canPinRoomMessages(
  row: ChatRoomRow,
  _memberId: string,
  teamRole: string | null | undefined,
): boolean {
  if (teamRole === 'admin') return true
  if (teamRole === 'viewer') return false
  return row.permissions.pinMessages === 'anyone'
}

export function isReactionEmojiAllowed(row: ChatRoomRow, emoji: string): boolean {
  if (!row.allowedReactionEmojis || row.allowedReactionEmojis.length === 0) return true
  return row.allowedReactionEmojis.includes(emoji)
}

type RoomsFile = { version: 1; rooms: ChatRoomRow[] }

function mintGroupId(kind: 'g' | 'p'): string {
  return `chat:${kind}:${randomBytes(12).toString('base64url')}`
}

function hashInvite(token: string): string {
  return scryptSync(token, 'teamspace-chat-invite', 32).toString('hex')
}

export class ChatRoomsStore {
  private readonly dir: string
  private readonly path: string
  private rooms = new Map<string, ChatRoomRow>()

  constructor(
    dataDir: string,
    private atRest: AtRestKey | null,
  ) {
    this.dir = join(dataDir, 'chat')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.path = join(this.dir, 'rooms.json')
    this.load()
    this.ensureTeamRoom()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = this.atRest
        ? decryptJsonFile(this.atRest, raw, { version: 1, rooms: [] } as RoomsFile)
        : (JSON.parse(raw) as RoomsFile)
      if (!parsed || !Array.isArray(parsed.rooms)) return
      for (const row of parsed.rooms.slice(0, 50_000)) {
        if (!row || typeof row.id !== 'string') continue
        const p = parseChatRoomId(row.id)
        if (!p.ok) continue
        const createdBy = typeof row.createdBy === 'string' ? row.createdBy.slice(0, 128) : ''
        const memberIds = normalizeIdList(row.memberIds, CHAT_ROOM_MEMBERS_HARD_CAP)
        let ownerIds = normalizeIdList(
          (row as ChatRoomRow).ownerIds,
          CHAT_ROOM_MEMBERS_HARD_CAP,
        )
        // Back-fill: existing rooms without ownerIds get the creator as owner.
        if (ownerIds.length === 0 && createdBy && createdBy !== 'system') {
          ownerIds = [createdBy]
        }
        this.rooms.set(p.room, {
          id: p.room,
          kind: p.kind,
          title: typeof row.title === 'string' ? row.title.slice(0, 120) : '',
          memberIds,
          createdBy,
          createdAt:
            typeof row.createdAt === 'number' && Number.isFinite(row.createdAt)
              ? row.createdAt
              : Date.now(),
          closedAt: typeof row.closedAt === 'number' ? row.closedAt : null,
          inviteHash: typeof row.inviteHash === 'string' ? row.inviteHash : null,
          inviteExpiresAt:
            typeof row.inviteExpiresAt === 'number' && Number.isFinite(row.inviteExpiresAt)
              ? row.inviteExpiresAt
              : null,
          passwordHash: typeof row.passwordHash === 'string' ? row.passwordHash : null,
          ownerIds,
          bannedMemberIds: normalizeIdList(
            (row as ChatRoomRow).bannedMemberIds,
            CHAT_ROOM_MEMBERS_HARD_CAP,
          ),
          allowedReactionEmojis: normalizeEmojiAllowlist(
            (row as ChatRoomRow).allowedReactionEmojis,
          ),
          // P2 back-fill: rooms persisted before the group-management-panel
          // pass have none of these fields on disk - default to the exact
          // pre-P2 behavior (no description/icon, permissions wide open),
          // same "back-fill on load" convention as ownerIds above.
          description:
            typeof (row as ChatRoomRow).description === 'string'
              ? capChatText((row as ChatRoomRow).description, CHAT_ROOM_DESCRIPTION_MAX)
              : '',
          iconKind:
            (row as ChatRoomRow).iconKind === 'preset' || (row as ChatRoomRow).iconKind === 'custom'
              ? (row as ChatRoomRow).iconKind
              : 'none',
          iconRef: typeof (row as ChatRoomRow).iconRef === 'string' ? (row as ChatRoomRow).iconRef : null,
          iconRev:
            typeof (row as ChatRoomRow).iconRev === 'number' && Number.isFinite((row as ChatRoomRow).iconRev)
              ? Math.max(0, Math.floor((row as ChatRoomRow).iconRev))
              : 0,
          permissions: {
            addMembers:
              (row as ChatRoomRow).permissions?.addMembers === 'owner_admin' ? 'owner_admin' : 'anyone',
            editInfo:
              (row as ChatRoomRow).permissions?.editInfo === 'owner_admin' ? 'owner_admin' : 'anyone',
            pinMessages:
              (row as ChatRoomRow).permissions?.pinMessages === 'anyone' ? 'anyone' : 'admin_only',
          },
        })
      }
    } catch {
      /* fail soft - empty registry */
    }
  }

  private persistSync(): void {
    const payload: RoomsFile = {
      version: 1,
      rooms: [...this.rooms.values()],
    }
    const body = this.atRest ? encryptJsonFile(this.atRest, payload) : JSON.stringify(payload)
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, this.path)
  }

  /**
   * TCC-R1134-CHAT-022: `persistSync` is already fully synchronous
   * (`writeFileSync` + `renameSync`, no real async I/O) - deferring it to
   * the next microtask via an unawaited `writeChain.then(...)` bought no
   * serialization benefit (every caller here mutates `this.rooms` and calls
   * `queuePersist()` synchronously with no `await` in between) but did open
   * a real crash-loss window: room create/invite/rename/membership replies
   * in `server.ts` return in the SAME synchronous tick this call returns
   * in, so a bridge crash between that reply and the deferred microtask
   * actually running silently rolled the room registry back to its
   * pre-mutation state on next boot (e.g. a just-created room or a just-set
   * invite token vanishing). Persisting synchronously, right here, closes
   * that window.
   */
  private queuePersist(): void {
    try {
      this.persistSync()
    } catch {
      // Best-effort: `this.rooms` already carries the change in memory, so
      // the NEXT successful mutation's persist still includes it.
    }
  }

  private ensureTeamRoom(): void {
    if (this.rooms.has(CHAT_ROOM_TEAM)) return
    this.rooms.set(CHAT_ROOM_TEAM, {
      id: CHAT_ROOM_TEAM,
      kind: 'team',
      title: 'Team',
      memberIds: [],
      createdBy: 'system',
      createdAt: Date.now(),
      ownerIds: [],
      bannedMemberIds: [],
      allowedReactionEmojis: [],
      description: '',
      iconKind: 'none',
      iconRef: null,
      iconRev: 0,
      permissions: defaultRoomPermissions(),
    })
    this.queuePersist()
  }

  /** Team room admits every authenticated member. Others require membership. */
  memberCanAccess(roomId: string, memberId: string): boolean {
    const p = parseChatRoomId(roomId)
    if (!p.ok) return false
    if (p.kind === 'team') return true
    const row = this.rooms.get(p.room)
    if (!row || row.closedAt) return false
    return row.memberIds.includes(memberId)
  }

  /** TCC-R1150-LIM-003: open rooms for surplus-member eviction (Admin cap lower). */
  listAllOpenRooms(): ChatRoomRow[] {
    const out: ChatRoomRow[] = []
    for (const row of this.rooms.values()) {
      if (row.closedAt) continue
      out.push(row)
    }
    return out
  }

  /**
   * TCC-R1150-LIM-003: keep owners first, then oldest members; drop newest surplus.
   * Actor is synthetic `__limits__` so removeMembers self-check never blocks.
   */
  trimMembersToCap(
    roomId: string,
    cap: number,
  ): { ok: true; removed: string[]; memberIds: string[] } | { error: string } {
    const row = this.get(roomId)
    if (!row || row.closedAt) return { error: 'Room not found' }
    if (row.kind === 'team' || row.kind === 'dm') return { ok: true, removed: [], memberIds: [...row.memberIds] }
    const target = Math.max(2, Math.floor(Number.isFinite(cap) ? cap : 2))
    if (row.memberIds.length <= target) return { ok: true, removed: [], memberIds: [...row.memberIds] }
    const owners = new Set(row.ownerIds)
    const keep: string[] = []
    const rest: string[] = []
    for (const id of row.memberIds) {
      if (owners.has(id)) keep.push(id)
      else rest.push(id)
    }
    while (keep.length + rest.length > target && rest.length > 0) rest.pop()
    const next = [...keep, ...rest].slice(0, target)
    const removed = row.memberIds.filter((id) => !next.includes(id))
    if (removed.length === 0) return { ok: true, removed: [], memberIds: [...row.memberIds] }
    return this.removeMembers(roomId, removed, '__limits__')
  }

  listForMember(memberId: string): ChatRoomRow[] {
    return this.listForMemberWithHonesty(memberId).rooms
  }

  /** TCC-CHAT-005: same list as listForMember plus truncated when over CHAT_ROOMS_LIST_MAX. */
  listForMemberWithHonesty(memberId: string): { rooms: ChatRoomRow[]; truncated: boolean } {
    const out: ChatRoomRow[] = []
    for (const row of this.rooms.values()) {
      if (row.closedAt) continue
      if (row.kind === 'team' || row.memberIds.includes(memberId)) out.push(row)
    }
    // TCC-R1149-CHAT-008: keep newest memberships when the list cap bites
    // (oldest-first used to drop the rooms the member just joined).
    const sorted = out.sort((a, b) => b.createdAt - a.createdAt)
    const truncated = sorted.length > CHAT_ROOMS_LIST_MAX
    return {
      rooms: truncated ? sorted.slice(0, CHAT_ROOMS_LIST_MAX) : sorted,
      truncated,
    }
  }

  get(roomId: string): ChatRoomRow | null {
    const p = parseChatRoomId(roomId)
    if (!p.ok) return null
    return this.rooms.get(p.room) ?? null
  }

  getOrCreateDm(memberA: string, memberB: string): ChatRoomRow | { error: string } {
    const id = dmRoomId(memberA, memberB)
    if (!id) return { error: 'Invalid DM members' }
    const a = String(memberA || '').replace(/\0/g, '').trim().slice(0, 128)
    const b = String(memberB || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!a || !b) return { error: 'Invalid DM members' }
    const legacyId = legacyDmRoomId(a, b)
    const existing = this.rooms.get(id) ?? (legacyId ? this.rooms.get(legacyId) : undefined)
    const existingId = existing?.id ?? id
    // TCC-R1146-CHAT-002: open one-sided DMs (voluntary leave without close)
    // must re-admit the canonical pair so create/reopen restores access.
    if (existing && !existing.closedAt) {
      if (existing.bannedMemberIds.includes(a) || existing.bannedMemberIds.includes(b)) {
        return { error: 'Direct message is unavailable' }
      }
      const pair = splitChatDmPair(existingId.slice('chat:dm:'.length)) ?? [a, b]
      let changed = false
      for (const mid of pair) {
        if (!existing.memberIds.includes(mid)) {
          existing.memberIds = [...existing.memberIds, mid]
          changed = true
        }
      }
      if (changed) {
        if (existing.ownerIds.length === 0) {
          existing.ownerIds = [a, b].filter(Boolean)
        }
        this.rooms.set(existingId, existing)
        this.queuePersist()
      }
      return existing
    }
    const members = splitChatDmPair(id.slice('chat:dm:'.length)) ?? [a, b]
    const row: ChatRoomRow = {
      id,
      kind: 'dm',
      title: '',
      memberIds: members,
      createdBy: a,
      createdAt: Date.now(),
      ownerIds: [a, b].filter(Boolean),
      bannedMemberIds: [],
      allowedReactionEmojis: [],
      description: '',
      iconKind: 'none',
      iconRef: null,
      iconRev: 0,
      permissions: defaultRoomPermissions(),
    }
    this.rooms.set(id, row)
    this.queuePersist()
    return row
  }

  createGroup(input: {
    kind: 'group' | 'private'
    title: string
    createdBy: string
    memberIds: string[]
    password?: string
    /** P2: optional description set at create time (edit-after-create also supported via setDescription). */
    description?: string
  }): ChatRoomRow | { error: string } {
    const title = String(input.title || '').replace(/\0/g, '').trim().slice(0, 120)
    if (!title) return { error: 'Title required' }
    const createdBy = String(input.createdBy || '').trim().slice(0, 128)
    if (!createdBy) return { error: 'createdBy required' }
    const members = new Set<string>(
      [createdBy, ...input.memberIds]
        .map((x) => String(x || '').trim().slice(0, 128))
        .filter(Boolean),
    )
    const cap = getChatRoomMembersCap()
    if (members.size > cap) {
      return {
        error: `This room would have ${members.size} members, but the limit is ${cap}`,
      }
    }
    const id = mintGroupId(input.kind === 'private' ? 'p' : 'g')
    const row: ChatRoomRow = {
      id,
      kind: input.kind,
      title,
      memberIds: [...members],
      createdBy,
      createdAt: Date.now(),
      passwordHash:
        input.kind === 'private' && input.password
          ? scryptSync(String(input.password), `chat-pw:${id}`, 32).toString('hex')
          : null,
      ownerIds: [createdBy],
      bannedMemberIds: [],
      allowedReactionEmojis: [],
      description:
        typeof input.description === 'string'
          ? capChatText(input.description.replace(/\0/g, '').trim(), CHAT_ROOM_DESCRIPTION_MAX)
          : '',
      iconKind: 'none',
      iconRef: null,
      iconRev: 0,
      permissions: defaultRoomPermissions(),
    }
    this.rooms.set(id, row)
    this.queuePersist()
    return row
  }

  admitMember(roomId: string, memberId: string): { ok: true } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { ok: true }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid) return { error: 'Member required' }
    if (row.bannedMemberIds.includes(mid)) {
      return { error: 'You are banned from this room' }
    }
    // TCC-R1145-CHAT-009: DMs are not open join - only existing participants
    // (or create/reopen via getOrCreateDm) may access.
    if (row.kind === 'dm' && !row.memberIds.includes(mid)) {
      return { error: 'You are not a participant in this direct message' }
    }
    if (!row.memberIds.includes(mid)) {
      const cap = getChatRoomMembersCap()
      if (row.memberIds.length >= cap) {
        return { error: `This room is full (limit ${cap} members)` }
      }
      row.memberIds = [...row.memberIds, mid]
      this.rooms.set(row.id, row)
      this.queuePersist()
    }
    return { ok: true }
  }

  /**
   * Add teammates to an existing group/private room (create-time pick is not enough).
   * Team/DM refuse. Empty batch refuse. Cap per call + total roster (refuse, never truncate).
   */
  addMembers(
    roomId: string,
    memberIds: string[],
  ): { ok: true; added: string[]; memberIds: string[] } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { error: 'Cannot add members to the team room' }
    if (row.kind === 'dm') return { error: 'Cannot add members to a direct message' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    const incoming = [
      ...new Set(
        memberIds
          .map((x) => String(x || '').replace(/\0/g, '').trim().slice(0, 128))
          .filter(Boolean),
      ),
    ].slice(0, 50)
    if (incoming.length === 0) return { error: 'Pick at least one teammate' }
    const banned = new Set(row.bannedMemberIds)
    const have = new Set(row.memberIds)
    const added: string[] = []
    for (const id of incoming) {
      if (banned.has(id)) {
        return { error: `Cannot add banned member` }
      }
      if (have.has(id)) continue
      have.add(id)
      added.push(id)
    }
    if (added.length === 0) {
      return { ok: true, added: [], memberIds: [...row.memberIds] }
    }
    const cap = getChatRoomMembersCap()
    if (row.memberIds.length + added.length > cap) {
      return {
        error: `Adding ${added.length} would exceed the room limit of ${cap} members`,
      }
    }
    row.memberIds = [...row.memberIds, ...added]
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, added, memberIds: [...row.memberIds] }
  }

  /**
   * Remove teammates from an existing group/private room (add twin).
   * Self-remove must use leave. Team/DM refuse. Empty batch refuse.
   * Empty roster after remove closes the room (same as leave).
   */
  removeMembers(
    roomId: string,
    memberIds: string[],
    actorId: string,
  ): { ok: true; removed: string[]; memberIds: string[] } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { error: 'Cannot remove members from the team room' }
    if (row.kind === 'dm') return { error: 'Cannot remove members from a direct message' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    const actor = String(actorId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!actor) return { error: 'Actor required' }
    const incoming = [
      ...new Set(
        memberIds
          .map((x) => String(x || '').replace(/\0/g, '').trim().slice(0, 128))
          .filter(Boolean),
      ),
    ].slice(0, 50)
    if (incoming.length === 0) return { error: 'Pick at least one teammate' }
    if (incoming.some((id) => id === actor)) {
      return { error: 'Leave the room instead of removing yourself' }
    }
    const have = new Set(row.memberIds)
    const removed: string[] = []
    for (const id of incoming) {
      if (!have.has(id)) continue
      have.delete(id)
      removed.push(id)
    }
    if (removed.length === 0) {
      return { ok: true, removed: [], memberIds: [...row.memberIds] }
    }
    row.memberIds = row.memberIds.filter((id) => !removed.includes(id))
    row.ownerIds = row.ownerIds.filter((id) => !removed.includes(id))
    if (row.memberIds.length === 0) {
      row.closedAt = Date.now()
    } else if (row.ownerIds.length === 0 && row.createdBy && row.memberIds.includes(row.createdBy)) {
      // Keep at least one owner when possible (creator still in room).
      row.ownerIds = [row.createdBy]
    } else if (row.ownerIds.length === 0 && row.memberIds[0]) {
      row.ownerIds = [row.memberIds[0]]
    }
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, removed, memberIds: [...row.memberIds] }
  }

  promoteOwner(
    roomId: string,
    memberId: string,
  ): { ok: true; ownerIds: string[]; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team' || row.kind === 'dm') {
      return { error: 'Group or private room required' }
    }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid) return { error: 'Member required' }
    if (!row.memberIds.includes(mid)) return { error: 'Member is not in this room' }
    if (row.ownerIds.includes(mid)) {
      return { ok: true, ownerIds: [...row.ownerIds], unchanged: true as const }
    }
    row.ownerIds = [...row.ownerIds, mid]
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, ownerIds: [...row.ownerIds] }
  }

  demoteOwner(
    roomId: string,
    memberId: string,
    opts?: { allowLastOwner?: boolean },
  ): { ok: true; ownerIds: string[]; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team' || row.kind === 'dm') {
      return { error: 'Group or private room required' }
    }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid) return { error: 'Member required' }
    if (!row.ownerIds.includes(mid)) {
      return { ok: true, ownerIds: [...row.ownerIds], unchanged: true as const }
    }
    if (row.ownerIds.length <= 1 && opts?.allowLastOwner !== true) {
      return { error: 'Cannot demote the last room owner' }
    }
    row.ownerIds = row.ownerIds.filter((id) => id !== mid)
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, ownerIds: [...row.ownerIds] }
  }

  banMember(
    roomId: string,
    memberId: string,
    actorId: string,
    opts?: { actorIsTeamAdmin?: boolean },
  ): { ok: true; bannedMemberIds: string[]; memberIds: string[]; removed: boolean; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team' || row.kind === 'dm') {
      return { error: 'Group or private room required' }
    }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    const actor = String(actorId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid) return { error: 'Member required' }
    if (mid === actor) return { error: 'Cannot ban yourself' }
    // TCC-R1143-ROLE-003: only team Admin may ban a room owner (co-owners
    // must demote first, or ask Admin). Prevents mutual owner wipe races.
    if (row.ownerIds.includes(mid) && opts?.actorIsTeamAdmin !== true) {
      return { error: 'Only a team Admin can ban a room owner' }
    }
    let removed = false
    if (row.memberIds.includes(mid)) {
      const rem = this.removeMembers(roomId, [mid], actor)
      if ('error' in rem) return rem
      removed = rem.removed.includes(mid)
    }
    const fresh = this.get(roomId)
    if (!fresh) return { error: 'Room not found' }
    let unchanged = false
    if (!fresh.bannedMemberIds.includes(mid)) {
      fresh.bannedMemberIds = [...fresh.bannedMemberIds, mid]
      fresh.ownerIds = fresh.ownerIds.filter((id) => id !== mid)
      // TS-CHAT-033: same succession twin `leave()` / `removeMembers()` already
      // have. `removeMembers` above only runs when the banned member is still
      // IN the room; a row whose `ownerIds` holds a non-member (the load
      // back-fill seeds `[createdBy]` for pre-ownerIds rooms even when the
      // creator has since left) would otherwise drop to zero owners here while
      // members remain - the exact orphaned-room state TS-CHAT-027 closed for
      // every other mutation.
      if (fresh.ownerIds.length === 0 && fresh.memberIds[0] && !fresh.closedAt) {
        fresh.ownerIds = [fresh.memberIds[0]]
      }
      this.rooms.set(fresh.id, fresh)
      this.queuePersist()
    } else if (!removed) {
      unchanged = true
    }
    return {
      ok: true,
      bannedMemberIds: [...fresh.bannedMemberIds],
      memberIds: [...fresh.memberIds],
      removed,
      ...(unchanged ? { unchanged: true as const } : {}),
    }
  }

  unbanMember(
    roomId: string,
    memberId: string,
  ): { ok: true; bannedMemberIds: string[]; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    // TCC-R1150-CHAT-011: closed rooms refuse unban (same as add/remove/ban).
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team' || row.kind === 'dm') {
      return { error: 'Group or private room required' }
    }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid) return { error: 'Member required' }
    if (!row.bannedMemberIds.includes(mid)) {
      return { ok: true, bannedMemberIds: [...row.bannedMemberIds], unchanged: true as const }
    }
    row.bannedMemberIds = row.bannedMemberIds.filter((id) => id !== mid)
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, bannedMemberIds: [...row.bannedMemberIds] }
  }

  setAllowedReactionEmojis(
    roomId: string,
    emojis: string[],
  ): { ok: true; allowedReactionEmojis: string[] } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') {
      // Team room reactions stay unrestricted (no per-room admin roster).
      return { error: 'Cannot restrict reactions on the team room' }
    }
    row.allowedReactionEmojis = normalizeEmojiAllowlist(emojis)
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, allowedReactionEmojis: [...row.allowedReactionEmojis] }
  }

  /**
   * Owner/admin succession (additive pass): a room's SOLE owner leaving
   * voluntarily while other members remain must never silently orphan the
   * room. `opts.forced` is the escape hatch for paths where the member is
   * being removed involuntarily (leaving the whole team, kicked by an
   * Admin) - those already have their own "who becomes owner next" answer
   * (earliest-joined remaining member, same fallback used below) and must
   * still succeed even when that member happens to be the sole owner, or a
   * departing/kicked teammate would get stuck as a permanent room owner.
   * The voluntary `chat_room_leave` IPC path (server.ts) calls this WITHOUT
   * `forced` so the sole owner is blocked and must explicitly transfer
   * ownership (`promoteOwner`) or dissolve the room (`closeRoom` via the new
   * `chat_room_dissolve` frame) first - never a silent third option.
   */
  leave(
    roomId: string,
    memberId: string,
    opts?: { forced?: boolean },
  ): { ok: true } | { error: string; requiresOwnerAction?: true } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.kind === 'team') return { error: 'Cannot leave the team room' }
    // TCC-R1150-CHAT-009: refuse closed rooms; never refresh closedAt; require membership.
    if (typeof row.closedAt === 'number' && Number.isFinite(row.closedAt) && row.closedAt > 0) {
      return { error: 'Room is closed' }
    }
    const mid = String(memberId || '').replace(/\0/g, '').trim().slice(0, 128)
    if (!mid || !row.memberIds.includes(mid)) {
      return { error: 'You are not in this chat room' }
    }
    const remainingAfterLeave = row.memberIds.filter((id) => id !== mid)
    const isSoleOwner = row.ownerIds.length === 1 && row.ownerIds[0] === mid
    if (!opts?.forced && isSoleOwner && remainingAfterLeave.length > 0) {
      return {
        error: 'You are the only owner of this group - promote another member or end the group for everyone first',
        requiresOwnerAction: true,
      }
    }
    row.memberIds = remainingAfterLeave
    row.ownerIds = row.ownerIds.filter((id) => id !== mid)
    if (row.memberIds.length === 0) {
      row.closedAt = Date.now()
    } else if (row.ownerIds.length === 0 && row.memberIds[0]) {
      // Earliest-joined remaining member (memberIds preserves join order -
      // see addMembers/createGroup) becomes the new sole owner. This is the
      // ONLY path that can leave ownerIds empty (forced departure, or a
      // non-owner leaving a room some other mutation already de-owned) -
      // never a silent no-owner state.
      row.ownerIds = [row.memberIds[0]]
    }
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true }
  }

  /**
   * TS-CHAT-011 / E16: stamp closedAt and clear members (departed DM).
   * Team room refuse. Idempotent when already closed.
   */
  closeRoom(roomId: string): { ok: true; closedAt: number; peerIds: string[] } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.kind === 'team') return { error: 'Cannot close the team room' }
    const peerIds = [...row.memberIds]
    const closedAt =
      typeof row.closedAt === 'number' && Number.isFinite(row.closedAt) && row.closedAt > 0
        ? row.closedAt
        : Date.now()
    row.memberIds = []
    row.closedAt = closedAt
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, closedAt, peerIds }
  }

  verifyPassword(roomId: string, password: string): boolean {
    const row = this.get(roomId)
    if (!row?.passwordHash) return !row?.passwordHash
    try {
      const got = scryptSync(String(password), `chat-pw:${row.id}`, 32)
      const want = Buffer.from(row.passwordHash, 'hex')
      if (got.length !== want.length) return false
      return timingSafeEqual(got, want)
    } catch {
      return false
    }
  }

  /**
   * Rename an existing group/private room (title is create-only without this).
   * Team/DM refuse. Empty/whitespace title refuse (same bar as create).
   */
  setTitle(
    roomId: string,
    title: string,
  ): { ok: true; title: string; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { error: 'Cannot rename the team room' }
    if (row.kind === 'dm') return { error: 'Cannot rename a direct message' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    const next = String(title || '').replace(/\0/g, '').trim().slice(0, 120)
    if (!next) return { error: 'Title required' }
    // TCC-R1151-CHAT-009: identical title is a no-op (no persist / no fanout).
    if (row.title === next) return { ok: true, title: next, unchanged: true as const }
    row.title = next
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, title: next }
  }

  /**
   * P2: set/clear an existing group/private room's description. Team/DM
   * refuse (same bar as `setTitle`). Empty string clears the description
   * (unlike title, an empty description is valid - "no description" is a
   * normal end state, not an error).
   */
  setDescription(
    roomId: string,
    description: string,
  ): { ok: true; description: string; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { error: 'The team room has no description' }
    if (row.kind === 'dm') return { error: 'Direct messages have no description' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    const next = capChatText(String(description || '').replace(/\0/g, '').trim(), CHAT_ROOM_DESCRIPTION_MAX)
    if (row.description === next) return { ok: true, description: next, unchanged: true as const }
    row.description = next
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, description: next }
  }

  /**
   * P2: set/clear an existing group/private room's icon. `'custom'` refs are
   * validated by the CALLER (`server.ts` proves the sha already exists in
   * `ChatAvatarStore` before calling this - the store itself has no blob
   * store access) - `'preset'` refs are validated here against the closed
   * `CHAT_ROOM_ICON_PRESETS` set since that check needs no I/O.
   */
  setIcon(
    roomId: string,
    iconKind: 'none' | 'preset' | 'custom',
    iconRef: string | null,
  ): { ok: true; iconKind: string; iconRef: string | null; iconRev: number; unchanged?: boolean } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind === 'team') return { error: 'The team room icon cannot be changed' }
    if (row.kind === 'dm') return { error: 'Direct messages have no group icon' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    let nextRef: string | null = null
    if (iconKind === 'preset') {
      const ref = typeof iconRef === 'string' ? iconRef.trim().toLowerCase() : ''
      if (!isChatRoomIconColorRef(ref)) return { error: 'Unknown icon preset' }
      nextRef = ref
    } else if (iconKind === 'custom') {
      const ref = String(iconRef || '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(ref)) return { error: 'Invalid icon reference' }
      nextRef = ref
    } else if (iconKind !== 'none') {
      return { error: 'Unknown icon kind' }
    }
    if (row.iconKind === iconKind && row.iconRef === nextRef) {
      return { ok: true, iconKind: row.iconKind, iconRef: row.iconRef, iconRev: row.iconRev, unchanged: true as const }
    }
    row.iconKind = iconKind
    row.iconRef = nextRef
    row.iconRev = row.iconRev + 1
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, iconKind: row.iconKind, iconRef: row.iconRef, iconRev: row.iconRev }
  }

  /**
   * P2: patch the closed permission policy for an existing group/private
   * room. Caller (`server.ts`) must ALWAYS gate this behind `canManageRoom`
   * regardless of the current `editInfo` policy value - letting the current
   * policy govern who may change the policy itself would be a privilege
   * escalation hole (a non-owner member could flip `editInfo` to `'anyone'`
   * then edit anything). This method only validates shape, not permission.
   */
  setPermissions(
    roomId: string,
    patch: {
      addMembers?: 'owner_admin' | 'anyone'
      editInfo?: 'owner_admin' | 'anyone'
      pinMessages?: 'admin_only' | 'anyone'
    },
  ): { ok: true; permissions: ChatRoomRow['permissions'] } | { error: string } {
    const row = this.get(roomId)
    if (!row) return { error: 'Room not found' }
    if (row.closedAt) return { error: 'Room is closed' }
    if (row.kind !== 'group' && row.kind !== 'private') {
      return { error: 'Group or private room required' }
    }
    const next = { ...row.permissions }
    if (patch.addMembers !== undefined) {
      if (patch.addMembers !== 'owner_admin' && patch.addMembers !== 'anyone') {
        return { error: 'Unknown addMembers policy' }
      }
      next.addMembers = patch.addMembers
    }
    if (patch.editInfo !== undefined) {
      if (patch.editInfo !== 'owner_admin' && patch.editInfo !== 'anyone') {
        return { error: 'Unknown editInfo policy' }
      }
      next.editInfo = patch.editInfo
    }
    if (patch.pinMessages !== undefined) {
      if (patch.pinMessages !== 'admin_only' && patch.pinMessages !== 'anyone') {
        return { error: 'Unknown pinMessages policy' }
      }
      next.pinMessages = patch.pinMessages
    }
    row.permissions = next
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true, permissions: { ...row.permissions } }
  }

  /**
   * Admin: rotate private-room password (scrypt hash only at rest).
   * Empty password refused - use a real new password (same bar as create).
   */
  setPassword(roomId: string, password: string): { ok: true } | { error: string } {
    const row = this.get(roomId)
    if (!row || row.kind !== 'private') return { error: 'Private room required' }
    if (row.closedAt) return { error: 'Room is closed' }
    const pw = String(password || '').replace(/\0/g, '').slice(0, 128)
    if (!pw.trim()) return { error: 'Password required' }
    row.passwordHash = scryptSync(pw, `chat-pw:${row.id}`, 32).toString('hex')
    // TCC-R1148-CHAT-009: password rotate invalidates Admin-minted invite tokens.
    row.inviteHash = null
    row.inviteExpiresAt = null
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { ok: true }
  }

  mintInviteToken(roomId: string): { token: string; expiresAt: number } | { error: string } {
    const row = this.get(roomId)
    if (!row || row.kind !== 'private') return { error: 'Private room required' }
    const token = randomBytes(24).toString('base64url')
    row.inviteHash = hashInvite(token)
    // TS-CHAT-031: an invite that never expires stays redeemable forever once
    // it leaks into a mail thread / screenshot / paste buffer. Single-use
    // (cleared on redeem below) bounds how many people it lets in; this bounds
    // for how long an unredeemed one stays live.
    row.inviteExpiresAt = Date.now() + CHAT_ROOM_INVITE_TTL_MS
    this.rooms.set(row.id, row)
    this.queuePersist()
    return { token, expiresAt: row.inviteExpiresAt }
  }

  redeemInvite(token: string, memberId: string): ChatRoomRow | { error: string } {
    const h = hashInvite(String(token || ''))
    const now = Date.now()
    for (const row of this.rooms.values()) {
      if (row.kind !== 'private' || !row.inviteHash || row.closedAt) continue
      if (row.inviteHash !== h) continue
      // TS-CHAT-031: expired (or pre-TTL legacy, which normalizes to `null`)
      // fails closed AND self-heals - the dead hash is dropped here so the
      // stored row cannot keep a stale credential around indefinitely.
      const expiresAt = typeof row.inviteExpiresAt === 'number' ? row.inviteExpiresAt : 0
      if (!(expiresAt > now)) {
        row.inviteHash = null
        row.inviteExpiresAt = null
        this.rooms.set(row.id, row)
        this.queuePersist()
        return { error: 'Invite expired - ask for a new one' }
      }
      const admit = this.admitMember(row.id, memberId)
      if ('error' in admit) return admit
      // TCC-R1146-CHAT-013: single-use invite - clear hash after successful admit.
      row.inviteHash = null
      row.inviteExpiresAt = null
      this.rooms.set(row.id, row)
      this.queuePersist()
      return row
    }
    return { error: 'Invite not found' }
  }
}
