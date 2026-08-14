/**
 * Team Space bridge server (Phase 1).
 *
 * - Per-member sessions (never one global overwrite slot)
 * - Exactly one reply per inbound WS frame
 * - Durable file store under TEAMSPACE_DATA_DIR
 * - HTTP blob upload/download + invite redeem
 * - Batched ops; unknown op.kind parks (never acks/discards)
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  BRIDGE_PROTOCOL_VERSION,
  KNOWN_OP_KINDS,
  type BridgeFrame,
  type BridgeRole,
  type ModulesSyncOp,
  isFiniteRequestId,
  mintToken,
} from './index.js'
import { acquireBridgeDataDirLock } from './data-dir-lock.js'
import {
  atRestKeyFingerprint,
  resolveAtRestKeyFromEnv,
} from './at-rest.js'
import { BridgeStore, MAX_BLOB_BYTES_EXPORT } from './store.js'
import {
  PublicShareBridgeStore,
  toPublicShareMeta,
  verifyPublicSharePassword,
} from './public-share-store.js'
import {
  ComposeShareBridgeStore,
  COMPOSE_SHARE_PACK_MAX_BYTES,
  toComposeShareMeta,
  verifyPublicSharePassword as verifyComposeSharePassword,
} from './compose-share-store.js'
import {
  PortalBridgeStore,
  toPortalMeta,
  verifyPortalPin,
  type PortalAuthMode,
} from './portal-store.js'
import {
  guestErrorPageHtml,
  guestPageDocument,
  GUEST_HTML_RESPONSE_HEADERS,
} from './guest-page-theme.js'
import {
  HEALTH_PLAIN_BODY,
  healthPageHtml,
  wantsHealthHtml,
} from './health-page.js'
import {
  GUEST_ESC_JS,
  GUEST_FORM_FIELD_JS,
  GUEST_GATE_JS,
  GUEST_RENDER_JS,
} from './guest-page-render.js'

/** Admin register body: pack_b64 + meta (~28 MiB ceiling for 20 MiB pack). */
const COMPOSE_SHARE_JSON_BODY_MAX = 28_000_000
/** TCC-FIX-CMP-001: documentIds[] only, capped well under 10k ids x 128 chars. */
const COMPOSE_ACL_JSON_BODY_MAX = 2_000_000
import {
  MAX_OPS_PER_FRAME,
  OPS_FRAME_TOKENS_PER_WINDOW,
  OPS_FRAME_WINDOW_MS,
  ACK_IDS_PER_CALL,
  HELLO_TOKENS_PER_WINDOW,
  INVITE_TOKENS_PER_WINDOW,
  BLOB_TOKENS_PER_WINDOW,
  BACKUP_TOKENS_PER_WINDOW,
  HTTP_TOKENS_PER_WINDOW,
  TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED,
  TEAMSPACE_YJS_COMPOSE_ENABLED,
  CHAT_ROOMS_LIST_SCAN_CONCURRENCY,
  CHAT_ROOMS_LIST_PROCESS_CONCURRENCY,
  CHAT_ROOMS_LIST_TOKENS_PER_MIN,
  MAX_INFLIGHT_HTTP_BODY_BYTES,
  MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES,
  PRE_AUTH_WS_MAX_FRAME_BYTES,
  PRE_AUTH_WS_TOKENS_PER_WINDOW,
  PRE_AUTH_HELLO_DEADLINE_MS,
  GUEST_AUTH_FAIL_MAX,
  GUEST_AUTH_FAIL_WINDOW_MS,
  CRM_BLOBS_DISK_MAX_BYTES,
  CHAT_EXPORT_PROCESS_LEASES,
  BACKUP_EXPORT_PROCESS_LEASES,
  ROSTER_TOKENS_PER_WINDOW,
  ADMIN_MUTATE_TOKENS_PER_WINDOW,
  ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW,
  YJS_JOIN_TOKENS_PER_SEC,
  ACK_OPS_TOKENS_PER_WINDOW,
  CHAT_AVATAR_PUT_TOKENS_PER_MIN,
  PROFILE_UPDATE_TOKENS_PER_MIN,
  GUEST_DOWNLOAD_TOKENS_PER_WINDOW,
  YJS_ROOM_MAX_PEERS,
  PRESENCE_JOIN_COALESCE_MS,
  MAX_LIVE_CONNECTIONS,
  PRESENCE_HEARTBEAT_INTERVAL_MS,
  YJS_UPDATE_TOKENS_PER_SEC,
  YJS_AWARENESS_TOKENS_PER_SEC,
  EPHEMERAL_START_TOKENS_PER_MIN,
  EPHEMERAL_MESSAGE_TOKENS_PER_MIN,
  EPHEMERAL_CLOSE_TOKENS_PER_MIN,
  EPHEMERAL_INFO_TOKENS_PER_MIN,
  EPHEMERAL_ROOMS_PER_MEMBER_MAX,
  EPHEMERAL_ROOMS_TOTAL_MAX,
  EPHEMERAL_PENDING_INVITES_PER_MEMBER_MAX,
  EPHEMERAL_INVITE_TTL_MS,
  EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT,
  EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR,
  EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING,
  EPHEMERAL_GROUP_MEMBERS_MAX,
  EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX,
  RECENT_OPS_CATCHUP_LIMIT,
  FULL_OPS_CATCHUP_LIMIT,
  ADMIN_RECOVERY_TOKENS_PER_WINDOW,
  ADMIN_RECOVERY_WINDOW_MS,
  WS_MAX_PAYLOAD_BYTES,
  OPS_FRAME_MAX_BYTES,
} from './throughput.js'
import { encodedOpByteLength, splitOpsForWsFrames } from './ops-frame-budget.js'
import {
  ADMIN_RECOVERY_ENV_VAR,
  ADMIN_RECOVERY_KEY_MAX_LEN,
  ADMIN_RECOVERY_REFUSE_LOCKED,
  adminRecoveryKeyFingerprint,
  hasPresentedAdminRecoveryKey,
  resolveAdminRecoveryKey,
  type AdminRecoveryKey,
} from './admin-recovery.js'
import {
  ephemeralRoomId,
  ephemeralGroupRoomId,
  parseEphemeralRoomId,
  parseAnyEphemeralRoomId,
  scrubEphemeralBody,
  scrubEphemeralReplyToId,
  isValidEphemeralInviteId,
  isValidEphemeralFormationId,
  validateEphemeralGroupTargetMemberIds,
  resolveEphemeralCloseDecision,
  resolveEphemeralCloseTimeoutMs,
  scrubEphemeralGroupDescription,
  isEphemeralGroupIconPreset,
  type EphemeralCloseReason,
  type EphemeralGroupCancelReason,
} from './ephemeral-chat.js'
import { TokenBucketLimiter } from './rate-limit.js'
import { mapWithConcurrency, AsyncSemaphore, TrySemaphore } from './concurrency-pool.js'
import { parseTrustedProxies, parseTrustedProxyHops, resolveBridgeClientIp } from './client-ip.js'
import {
  parseYjsRoomId,
  isYjsUpdateB64,
  isYjsComposeRecordId,
  YJS_ROOMS_PER_SOCKET_MAX,
} from './yjs-room.js'
import {
  setComposeAclSharedDocIds,
  isComposeDocSharedWithTeam,
} from './compose-acl-store.js'
import {
  buildPresenceSnapshot,
  memberHasOtherLiveSocket,
  type PresencePeer,
} from './presence.js'
import {
  CHAT_HISTORY_LIMIT_DEFAULT,
  CHAT_ROOM_TEAM,
  CHAT_ATTACH_MAX_BYTES_CEILING,
  CHAT_AVATAR_MAX_BYTES,
  parseChatRoomId,
  parseChatTaskCommand,
  scrubChatBody,
  CHAT_TITLE_MAX,
  capChatText,
} from './chat-room.js'
import { sanitizeChatAttachmentName } from './chat-dangerous-type.js'
import { ChatStore } from './chat-store.js'
import {
  ChatRoomsStore,
  canManageRoom,
  canAddRoomMembers,
  canEditRoomInfo,
  canPinRoomMessages,
  isReactionEmojiAllowed,
  isChatRoomIconPreset,
} from './chat-rooms-store.js'
import { ChatUnreadStore } from './chat-unread-store.js'
import { TeamLimitsStore } from './limits-store.js'
import { ChatBlobRegistry, chatBlobRoomIds } from './chat-blob-registry.js'
import { ChatMetaStore } from './chat-meta-store.js'
import { cleanupChatTmpFiles } from './chat-tmp-sweep.js'
import {
  measureChatFilesBytes,
  resolveEnvChatDiskQuotas,
  setChatDiskQuotaLiveResolver,
} from './chat-disk-quota.js'
import {
  CHAT_RATE_SEND_PER_MIN,
  CHAT_RATE_HISTORY_PER_MIN,
  CHAT_RATE_REACT_PER_MIN,
  CHAT_RATE_TYPING_PER_SEC,
  CHAT_RATE_PASSWORD_JOIN_PER_15MIN,
  CHAT_RATE_BLOB_PUT_PER_MIN,
  CHAT_RATE_BLOB_GET_PER_MIN,
  CHAT_RATE_MUTATE_PER_MIN,
  CHAT_RATE_SEARCH_PER_MIN,
  CHAT_RATE_EXPORT_PER_MIN,
  CHAT_RATE_ROOM_ADMIN_PER_MIN,
} from './chat-rate-limits.js'
import { toChatMessagePayload } from './chat-message-payload.js'
import { ChatAvatarStore, isTeamChatAvatarBlobSha } from './chat-avatar-store.js'
import { snapshotChatMetrics, bumpChatMetric } from './chat-metrics.js'
import {
  TeamBackupStore,
  MAX_BACKUP_BYTES,
  isSafeBackupSnapshotId,
  isSafeBackupMemberId,
  parseBackupMetaHeader,
} from './backup-store.js'
import {
  streamStoredBackupZip,
  planStoredBackupZip,
  streamPlannedBackupZip,
  MAX_BACKUP_ZIP_AIMOVES,
  MAX_BACKUP_ZIP_CHAT_ENTRIES,
  combinedBackupZipEntryCeiling,
} from './backup-zip.js'

/**
 * TS-BRG-051: default 8788, NOT 8787. The AItomation desktop app runs its own
 * Local Agent API on 127.0.0.1:8787 (`DEV_LOCAL_API_DEFAULT_PORT`), and the
 * self-host docs recommend running this server on the same computer as the
 * app, so an 8787 default guarantees a collision: whichever process starts
 * second fails to bind, and a client pointed at ws://127.0.0.1:8787 while the
 * app holds that port talks to the app's own HTTP server instead of a team
 * server (its health route is /v1/health, so the probe here reports a bare
 * status code with no hint about what actually answered). Anyone pinned to
 * 8787 can still set TEAMSPACE_BRIDGE_PORT explicitly.
 */
const PORT = Number(process.env.TEAMSPACE_BRIDGE_PORT || 8788)
/**
 * BRGDATA-001: whether the data dir was CONFIGURED or fell back to the cwd.
 *
 * The official image sets TEAMSPACE_DATA_DIR, so the fallback never fires there.
 * On a plain VPS it is a trap with two common shapes, both of which silently
 * start the server on an empty folder and mint a brand-new team while the real
 * one sits untouched somewhere else:
 *   - a systemd unit with no `WorkingDirectory=` runs with cwd `/`, so the data
 *     dir becomes `/data`;
 *   - the release-directory deploy pattern (`/srv/app/releases/<timestamp>` with
 *     a flipped `current` symlink) gives a DIFFERENT cwd on every upgrade, so
 *     each deploy starts fresh and orphans the previous team.
 * Boot warns when this fired - see the `data dir:` lines below.
 */
const DATA_DIR_CONFIGURED = typeof process.env.TEAMSPACE_DATA_DIR === 'string'
  && process.env.TEAMSPACE_DATA_DIR.trim() !== ''
const DATA_DIR = DATA_DIR_CONFIGURED
  ? String(process.env.TEAMSPACE_DATA_DIR).trim()
  : join(process.cwd(), 'data')
const RETENTION_DAYS = Number(process.env.TEAMSPACE_OP_RETENTION_DAYS || 21)
const CHAT_RETENTION_DAYS = Number(process.env.TEAMSPACE_CHAT_RETENTION_DAYS || 90)
const CHAT_TOMBSTONE_DAYS = Number(process.env.TEAMSPACE_CHAT_TOMBSTONE_DAYS || 365)

/**
 * TS-BRG-005: default loopback only (matches docs). LAN/VPN self-host must set
 * TEAMSPACE_BRIDGE_HOST=0.0.0.0 (or a specific IPv4) explicitly.
 */
function resolveBindHost(): string {
  const raw = String(process.env.TEAMSPACE_BRIDGE_HOST || '127.0.0.1').trim()
  if (!raw || raw === '127.0.0.1' || raw === 'localhost') return '127.0.0.1'
  if (raw === '::1') return '::1'
  if (raw === '0.0.0.0' || raw === '::') return raw
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw)) {
    const parts = raw.split('.').map((p) => Number(p))
    if (parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return raw
  }
  console.error('[bridge] Invalid TEAMSPACE_BRIDGE_HOST - use 127.0.0.1, 0.0.0.0, or an IPv4 address')
  process.exit(1)
}

const BIND_HOST = resolveBindHost()

let atRestKey: ReturnType<typeof resolveAtRestKeyFromEnv>
try {
  atRestKey = resolveAtRestKeyFromEnv()
} catch (err) {
  console.error(`[bridge] ${err instanceof Error ? err.message : 'Invalid TEAMSPACE_AT_REST_KEY'}`)
  process.exit(1)
}

const dataDirLock = acquireBridgeDataDirLock(DATA_DIR)
if (!dataDirLock.ok) {
  console.error(`[bridge] ${dataDirLock.reason}`)
  process.exit(1)
}

/**
 * TCC-R1134-CHAT-021: sweep leftover `.tmp`/`.part` files under `chat/` from
 * an interrupted write-then-rename BEFORE any chat store opens - the
 * dataDirLock above already guarantees no other bridge process can be
 * writing to this data dir, so anything matching here can only be debris
 * from a previous crashed run of this same process. Mirrors the existing
 * `backupStore.cleanupPartials()` crash-recovery sweep below for P6 backups.
 */
const chatTmpFilesRemoved = cleanupChatTmpFiles(DATA_DIR)
if (chatTmpFilesRemoved > 0) {
  console.log(`[bridge] removed ${chatTmpFilesRemoved} orphaned chat tmp/part file(s) left by a previous crash`)
}

/**
 * Resolve the Admin recovery key before the store opens, so a bad
 * TEAMSPACE_ADMIN_RECOVERY_KEY fails with one clear line instead of surfacing as
 * a store constructor throw. Resolution is memoized per data dir, so passing it
 * into BridgeStore below reuses this exact instance (and the auto-generated key
 * file is written at most once per boot).
 */
let adminRecoveryKey: AdminRecoveryKey
try {
  adminRecoveryKey = resolveAdminRecoveryKey(DATA_DIR)
} catch (err) {
  console.error(`[bridge] ${err instanceof Error ? err.message : `Invalid ${ADMIN_RECOVERY_ENV_VAR}`}`)
  process.exit(1)
}

const store = new BridgeStore(DATA_DIR, RETENTION_DAYS, atRestKey, adminRecoveryKey)

/**
 * BRGTEAM-001: snapshot whether a team already existed BEFORE anything can call
 * `ensureTeam()`, so the boot summary can tell "loaded your team" apart from
 * "this folder had no team". Read here rather than at listen time because the
 * first hello can land before the listen callback runs on a busy start.
 */
const teamAtBoot = store.getTeam()

/**
 * The other half of BRGTEAM-001: a team minted while we are running. `teamAtBoot`
 * covers a wrong folder that was empty at boot; this covers the folder that was
 * correct at boot and then disappeared (volume detached, bind mount replaced),
 * and it is the line that names the moment a duplicate team came into existence.
 */
store.onTeamCreated = (team) => {
  console.warn(
    `[bridge] created a NEW team ${team.teamId} - no team.json existed in ${DATA_DIR}.` +
      ' If you expected an existing team, stop the server now: it is not reading the folder you think it is,'
      + ' and the computer that just connected is now the Admin of a brand-new empty team.',
  )
}

/** P5-CHAT: separate chat log (never Modules ops.jsonl). */
const envChatQuotas = resolveEnvChatDiskQuotas()
const chatMeta = new ChatMetaStore(DATA_DIR, atRestKey, {
  retentionDays: CHAT_RETENTION_DAYS,
  chatFilesBytes: envChatQuotas.chatFilesBytes,
  chatBlobsBytes: envChatQuotas.chatBlobsBytes,
})
setChatDiskQuotaLiveResolver(() => chatMeta.getQuotas())
const chatStore = new ChatStore(
  DATA_DIR,
  chatMeta.get().retentionDays,
  CHAT_TOMBSTONE_DAYS,
  atRestKey,
)
const chatRooms = new ChatRoomsStore(DATA_DIR, atRestKey)
const chatUnread = new ChatUnreadStore(DATA_DIR, atRestKey)
const limitsStore = new TeamLimitsStore(DATA_DIR)
const chatLimiter = new TokenBucketLimiter()
// TCC-R1143-LIM-006: when Admin lowers chat rates, immediately recap surplus
// tokens so the old higher budget cannot linger until the window refills.

limitsStore.onChange((meta) => {
  chatLimiter.recap(meta.chatSendPerMin || CHAT_RATE_SEND_PER_MIN, 'chatsend:')
  chatLimiter.recap(meta.chatHistoryPerMin || CHAT_RATE_HISTORY_PER_MIN, 'chathist:')
  chatLimiter.recap(meta.chatReactPerMin || CHAT_RATE_REACT_PER_MIN, 'chatreact:')
  chatLimiter.recap(meta.chatMutatePerMin || CHAT_RATE_MUTATE_PER_MIN, 'chatmutate:')
  chatLimiter.recap(meta.chatSearchPerMin || CHAT_RATE_SEARCH_PER_MIN, 'chatsearch:')
  chatLimiter.recap(meta.chatExportPerMin || CHAT_RATE_EXPORT_PER_MIN, 'chatexport:')
})
const chatBlobs = new ChatBlobRegistry(DATA_DIR, atRestKey)
const chatAvatars = new ChatAvatarStore(DATA_DIR, atRestKey)
/** P1-C: public Module share + Form intake (same data dir as CRM - never Directus). */
const publicShares = new PublicShareBridgeStore(DATA_DIR, atRestKey)
const composeShares = new ComposeShareBridgeStore(DATA_DIR, atRestKey)
const portals = new PortalBridgeStore(DATA_DIR, atRestKey)
/** P6: per-member full app backups (dedicated tree - never CRM blobs/). */
const backupStore = new TeamBackupStore(DATA_DIR)
backupStore.cleanupPartials()
// TCC-R1154-BRG-003: CRM blobs/*.part twin of chat/backup partial sweep.
store.cleanupBlobPartials()

/**
 * TS-CX-041: hard cap concurrent WS sessions per bridge process.
 * TCC-R1133-BRG-003: sourced from throughput.ts (`envInt`) instead of a
 * locally hard-clamped `Math.min(500, ...)` - see that constant's doc for
 * why the old 500 ceiling silently ignored larger self-host env values.
 */
/** Skip fanout to a peer whose send buffer is already this large (bytes). */
const FANOUT_BACKPRESSURE_BYTES = Math.max(
  64 * 1024,
  Math.min(16 * 1024 * 1024, Number(process.env.TEAMSPACE_FANOUT_BACKPRESSURE_BYTES || 2 * 1024 * 1024) || 2 * 1024 * 1024),
)

type LiveSession = {
  memberId: string
  deviceId: string
  role: BridgeRole
  displayName: string
  sessionToken: string
  ws: WebSocket
  lastSeen: number
  opsTokens: number
  opsRefillAt: number
}

const live = new Map<WebSocket, LiveSession>()

/**
 * TCC-R1134-ENT-001: sockets currently awaiting a pong for the LAST
 * heartbeat ping sent to them (see the heartbeat interval near the bottom
 * of this file). Membership, not a boolean flag on the socket itself, so no
 * `as` cast is needed on the third-party `WebSocket` type - present in the
 * set means "no pong seen since the last ping", which the next tick treats
 * as a dead connection.
 */
const pendingHeartbeatAck = new WeakSet<WebSocket>()

/** M-P5YJS1: roomId -> sockets currently joined (in-memory relay only). */
const yjsRooms = new Map<string, Set<WebSocket>>()
/** Reverse index: socket -> rooms (for leave-all on close). */
const yjsSocketRooms = new Map<WebSocket, Set<string>>()

function leaveYjsRoom(ws: WebSocket, room: string): void {
  const peers = yjsRooms.get(room)
  if (peers) {
    peers.delete(ws)
    if (peers.size === 0) yjsRooms.delete(room)
  }
  const mine = yjsSocketRooms.get(ws)
  if (mine) {
    mine.delete(room)
    if (mine.size === 0) yjsSocketRooms.delete(ws)
  }
}

function leaveAllYjsRooms(ws: WebSocket): void {
  const mine = yjsSocketRooms.get(ws)
  if (!mine) return
  for (const room of [...mine]) leaveYjsRoom(ws, room)
}

/**
 * Temporary chat (never-persisted 1:1 DM AND group chat) - process memory
 * ONLY. Every field here (room state, invites, group formations) is gone on
 * process restart and is NEVER written to `store`/`chatStore`/any file -
 * that is the whole point of the feature. See ephemeral-chat.ts for the pure
 * id/state-machine helpers. Round-1157 generalized 1:1-only rooms
 * (`memberIds` was a fixed 2-tuple) to N-party group rooms.
 */
type EphemeralRoomState = {
  /** Mutable membership (Leave removes an id; never grows past its formed size). */
  memberIds: string[]
  createdAt: number
  closeRequestedBy: Set<string>
  closeTimeoutMs: number
  /** Countdown deadline once a close request or a lone disconnect starts the clock; null = stable. */
  deadlineAt: number | null
  timer: ReturnType<typeof setTimeout> | null
  /**
   * P2 (extended to temporary chats): in-memory-only description/preset
   * icon. Never persisted - lives only here and is dropped with the rest
   * of `EphemeralRoomState` on teardown (see `ephemeral-chat.ts` doc).
   */
  description: string
  iconPreset: string | null
}
type EphemeralInviteState = {
  inviteId: string
  room: string
  fromMemberId: string
  toMemberId: string
  closeTimeoutMs: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}
/**
 * Round-1157: a group temporary chat is not a room yet while forming - it
 * becomes one (`ephemeralRooms.set(...)`) only once EVERY invited member has
 * accepted. `pendingMemberIds` shrinks as accepts arrive; `acceptedMemberIds`
 * always starts containing the initiator (auto-accepted, they proposed it).
 */
type EphemeralGroupFormation = {
  formationId: string
  initiatorMemberId: string
  initiatorName: string
  /** Fixed at start time: initiator + every invitee. Never changes during formation. */
  allMemberIds: string[]
  acceptedMemberIds: Set<string>
  pendingMemberIds: Set<string>
  memberNames: Map<string, string>
  room: string
  closeTimeoutMs: number
  createdAt: number
  timer: ReturnType<typeof setTimeout>
}
const ephemeralRooms = new Map<string, EphemeralRoomState>()
/** memberId -> room ids they currently hold open (reverse index for disconnect/reconnect hooks + per-member cap). */
const ephemeralRoomsByMember = new Map<string, Set<string>>()
const ephemeralInvites = new Map<string, EphemeralInviteState>()
/** memberId -> invite ids they have sent that are still awaiting an answer (cap + cleanup on disconnect). */
const ephemeralPendingInvitesByMember = new Map<string, Set<string>>()
const ephemeralGroupFormations = new Map<string, EphemeralGroupFormation>()
/** memberId (invitee) -> formation ids awaiting THEIR answer (offline-expiry hook + accept/decline lookup). */
const ephemeralGroupInviteesByMember = new Map<string, Set<string>>()
/** memberId (initiator) -> formation ids they started but are not yet formed (cap + offline cleanup). */
const ephemeralGroupFormationsByInitiator = new Map<string, Set<string>>()

/**
 * TS-EPH-PERF-001 (Round-1157 audit fix): `sendToLiveMember`/`liveMemberIdsFor`
 * used to scan the ENTIRE bridge-wide `live` map (every connected socket,
 * across every team, every feature) to find the sockets for ONE known
 * memberId - O(total bridge connections) per ephemeral message/lifecycle
 * event instead of O(that member's own socket count). At "hundreds of teams,
 * thousands of members" scale this is a real per-message cost. Ephemeral
 * chat always knows the exact target memberId(s) up front (unlike the
 * regular chat-room fanout elsewhere in this file, which must ACL-check
 * every live socket against room membership and is out of scope for this
 * feature-scoped fix) so a dedicated reverse index makes this exact and O(1)
 * per member instead of O(n) bridge-wide.
 */
const liveSocketsByMember = new Map<string, Set<WebSocket>>()
function indexLiveSocketForMember(memberId: string, ws: WebSocket): void {
  let set = liveSocketsByMember.get(memberId)
  if (!set) {
    set = new Set()
    liveSocketsByMember.set(memberId, set)
  }
  set.add(ws)
}
function unindexLiveSocketForMember(memberId: string, ws: WebSocket): void {
  const set = liveSocketsByMember.get(memberId)
  if (!set) return
  set.delete(ws)
  if (set.size === 0) liveSocketsByMember.delete(memberId)
}

/** O(1)-amortized: read one live session for a memberId (display name lookups), never scans all connections. */
function firstLiveSessionForMember(memberId: string): LiveSession | undefined {
  const sockets = liveSocketsByMember.get(memberId)
  if (!sockets || sockets.size === 0) return undefined
  for (const socket of sockets) {
    const s = live.get(socket)
    if (s) return s
  }
  return undefined
}

function liveMemberIdsFor(memberIds: readonly string[]): Set<string> {
  const out = new Set<string>()
  for (const id of memberIds) {
    const sockets = liveSocketsByMember.get(id)
    if (sockets && sockets.size > 0) out.add(id)
  }
  return out
}

/** Relay to every currently-connected socket of one member. Never queues past this synchronous attempt. */
function sendToLiveMember(memberId: string, frame: BridgeFrame): boolean {
  const sockets = liveSocketsByMember.get(memberId)
  if (!sockets || sockets.size === 0) return false
  let sent = false
  for (const peer of sockets) {
    if (peer.readyState !== 1 /* OPEN */) continue
    if (reply(peer, frame)) sent = true
  }
  return sent
}

/** Relay to every OTHER member of a room/formation (never the sender). */
function sendToOtherLiveMembers(memberIds: readonly string[], excludeMemberId: string, frame: BridgeFrame): number {
  let count = 0
  for (const id of memberIds) {
    if (id === excludeMemberId) continue
    if (sendToLiveMember(id, frame)) count += 1
  }
  return count
}

function addEphemeralRoomIndex(room: string, memberIds: readonly string[]): void {
  for (const id of memberIds) {
    let set = ephemeralRoomsByMember.get(id)
    if (!set) {
      set = new Set()
      ephemeralRoomsByMember.set(id, set)
    }
    set.add(room)
  }
}
function removeEphemeralRoomIndex(room: string, memberIds: readonly string[]): void {
  for (const id of memberIds) {
    const set = ephemeralRoomsByMember.get(id)
    if (!set) continue
    set.delete(room)
    if (set.size === 0) ephemeralRoomsByMember.delete(id)
  }
}

function clearEphemeralTimer(r: EphemeralRoomState): void {
  if (r.timer) {
    try { clearTimeout(r.timer) } catch { /* */ }
    r.timer = null
  }
  r.deadlineAt = null
}

/** Terminal event: fan out ephemeral_closed to any still-connected member(s) and wipe the room. */
function closeEphemeralRoomNow(room: string, reason: EphemeralCloseReason): void {
  const r = ephemeralRooms.get(room)
  if (!r) return
  clearEphemeralTimer(r)
  const frame: BridgeFrame = { type: 'ephemeral_closed', room, reason }
  for (const id of r.memberIds) sendToLiveMember(id, frame)
  removeEphemeralRoomIndex(room, r.memberIds)
  ephemeralRooms.delete(room)
  // TS-EPH-001: only room bookkeeping is logged - never message content, never a full memberId list.
  console.log(`[bridge] temporary chat closed room=${room.slice(0, 24)} reason=${reason} members=${r.memberIds.length}`)
}

function ensureEphemeralDeadline(r: EphemeralRoomState, room: string): void {
  if (r.deadlineAt !== null) return
  r.deadlineAt = Date.now() + r.closeTimeoutMs
  const timer = setTimeout(() => onEphemeralDeadline(room), r.closeTimeoutMs)
  timer.unref?.()
  r.timer = timer
}

function onEphemeralDeadline(room: string): void {
  const r = ephemeralRooms.get(room)
  if (!r) return
  r.timer = null
  const liveIds = liveMemberIdsFor(r.memberIds)
  const decision = resolveEphemeralCloseDecision({
    memberIds: r.memberIds,
    closeRequestedBy: r.closeRequestedBy,
    liveMemberIds: liveIds,
    timeoutElapsed: true,
  })
  if (decision.shouldClose) {
    closeEphemeralRoomNow(room, decision.reason)
  } else {
    r.deadlineAt = null
  }
}

/** Re-evaluate close state right after an event (close request, disconnect, reconnect, leave). */
function evaluateEphemeralRoomImmediate(room: string): void {
  const r = ephemeralRooms.get(room)
  if (!r) return
  const liveIds = liveMemberIdsFor(r.memberIds)
  const decision = resolveEphemeralCloseDecision({
    memberIds: r.memberIds,
    closeRequestedBy: r.closeRequestedBy,
    liveMemberIds: liveIds,
    timeoutElapsed: false,
  })
  if (decision.shouldClose) {
    closeEphemeralRoomNow(room, decision.reason)
    return
  }
  const someButNotAllLive = liveIds.size > 0 && liveIds.size < r.memberIds.length
  if (r.closeRequestedBy.size > 0 || someButNotAllLive) {
    ensureEphemeralDeadline(r, room)
  }
}

/** A member voluntarily leaves a still-multi-person room without ending it for everyone. */
function leaveEphemeralRoom(room: string, memberId: string): { ok: true; ended: boolean } | { ok: false } {
  const r = ephemeralRooms.get(room)
  if (!r || !r.memberIds.includes(memberId)) return { ok: false }
  r.memberIds = r.memberIds.filter((id) => id !== memberId)
  r.closeRequestedBy.delete(memberId)
  removeEphemeralRoomIndex(room, [memberId])
  if (r.memberIds.length < 2) {
    // TS-EPH-GRP-004: fewer than 2 remain - tear the whole room down, but the
    // LEAVER already got their own leave-ok reply and local wipe; the
    // remaining member (if still live) gets the standard ephemeral_closed.
    closeEphemeralRoomNow(room, 'peer_left')
    return { ok: true, ended: true }
  }
  sendToOtherLiveMembers(r.memberIds, memberId, { type: 'ephemeral_member_left', room, memberId, memberIds: [...r.memberIds] })
  // A leave can complete an in-progress mutual close-for-everyone request
  // (the remaining members' existing requests now cover 100% of who's left).
  evaluateEphemeralRoomImmediate(room)
  return { ok: true, ended: false }
}

/** Hook from dropLiveSession: this member has NO live socket left anywhere. */
function handleEphemeralMemberOffline(memberId: string): void {
  const rooms = ephemeralRoomsByMember.get(memberId)
  if (rooms && rooms.size > 0) {
    for (const room of [...rooms]) {
      const r = ephemeralRooms.get(room)
      if (!r) continue
      sendToOtherLiveMembers(r.memberIds, memberId, { type: 'ephemeral_peer_offline', room, memberId })
      evaluateEphemeralRoomImmediate(room)
    }
  }
  // TS-EPH-003: a pending (unanswered) invite from/to a now-fully-offline
  // member cannot be accepted/declined by anyone live - expire it now
  // instead of leaving it to linger until its TTL.
  const pending = ephemeralPendingInvitesByMember.get(memberId)
  if (pending) {
    for (const inviteId of [...pending]) expireEphemeralInvite(inviteId)
  }
  for (const [inviteId, invite] of ephemeralInvites) {
    if (invite.toMemberId === memberId) expireEphemeralInvite(inviteId)
  }
  // TS-EPH-GRP-005: same "cannot wait for someone unreachable" principle for
  // group formations - both as a still-deciding invitee AND as the
  // initiator (a formation with a vanished initiator has no one to notify
  // final acceptance to and should not linger).
  const asInvitee = ephemeralGroupInviteesByMember.get(memberId)
  if (asInvitee) {
    for (const formationId of [...asInvitee]) cancelEphemeralGroupFormation(formationId, 'member_offline', memberId)
  }
  const asInitiator = ephemeralGroupFormationsByInitiator.get(memberId)
  if (asInitiator) {
    for (const formationId of [...asInitiator]) cancelEphemeralGroupFormation(formationId, 'member_offline', memberId)
  }
}

/** Hook from bindLiveSession: this member just became reachable again. */
function handleEphemeralMemberOnline(memberId: string): void {
  const rooms = ephemeralRoomsByMember.get(memberId)
  if (!rooms || rooms.size === 0) return
  for (const room of [...rooms]) {
    const r = ephemeralRooms.get(room)
    if (!r) continue
    // TS-CHAT-038: the offline frame is fanned out unconditionally, so the
    // online frame must be too. Gating the MESSAGE on timer state left every
    // other member staring at "X is offline" for someone demonstrably back -
    // most visibly whenever a close-for-everyone request was already pending,
    // since that branch never sent an online frame at all.
    sendToOtherLiveMembers(r.memberIds, memberId, { type: 'ephemeral_peer_online', room, memberId })
    // Only the offline-grace countdown belongs to this reconnect. A pending
    // close-for-everyone request owns the same timer and must keep running,
    // and in a group OTHER members can still be offline - re-evaluate so their
    // grace countdown is re-armed instead of the room losing its deadline.
    if (r.closeRequestedBy.size === 0 && r.deadlineAt !== null) {
      clearEphemeralTimer(r)
      evaluateEphemeralRoomImmediate(room)
    }
  }
}

function expireEphemeralInvite(inviteId: string): void {
  const invite = ephemeralInvites.get(inviteId)
  if (!invite) return
  try { clearTimeout(invite.timer) } catch { /* */ }
  ephemeralInvites.delete(inviteId)
  const pending = ephemeralPendingInvitesByMember.get(invite.fromMemberId)
  if (pending) {
    pending.delete(inviteId)
    if (pending.size === 0) ephemeralPendingInvitesByMember.delete(invite.fromMemberId)
  }
}

/** Terminal failure path for a group formation - notify everyone still involved and wipe all bookkeeping. */
function cancelEphemeralGroupFormation(
  formationId: string,
  reason: EphemeralGroupCancelReason,
  byMemberId?: string,
): void {
  const f = ephemeralGroupFormations.get(formationId)
  if (!f) return
  try { clearTimeout(f.timer) } catch { /* */ }
  ephemeralGroupFormations.delete(formationId)
  for (const memberId of f.pendingMemberIds) {
    const set = ephemeralGroupInviteesByMember.get(memberId)
    if (set) {
      set.delete(formationId)
      if (set.size === 0) ephemeralGroupInviteesByMember.delete(memberId)
    }
  }
  const initSet = ephemeralGroupFormationsByInitiator.get(f.initiatorMemberId)
  if (initSet) {
    initSet.delete(formationId)
    if (initSet.size === 0) ephemeralGroupFormationsByInitiator.delete(f.initiatorMemberId)
  }
  const frame: BridgeFrame = { type: 'ephemeral_group_cancelled', formationId, reason, byMemberId }
  // Notify everyone who was ever part of this formation (initiator + every
  // invitee, whether they had already accepted or were still deciding).
  for (const memberId of f.allMemberIds) sendToLiveMember(memberId, frame)
  console.log(`[bridge] temporary group chat formation cancelled formationId=${formationId.slice(0, 12)} reason=${reason} members=${f.allMemberIds.length}`)
}

const ephemeralLimiter = new TokenBucketLimiter()
function takeEphemeralStartToken(memberId: string): boolean {
  return ephemeralLimiter.take(`ephstart:${memberId}`, EPHEMERAL_START_TOKENS_PER_MIN, 60_000)
}
function takeEphemeralMessageToken(memberId: string): boolean {
  return ephemeralLimiter.take(`ephmsg:${memberId}`, EPHEMERAL_MESSAGE_TOKENS_PER_MIN, 60_000)
}
function takeEphemeralCloseToken(memberId: string): boolean {
  return ephemeralLimiter.take(`ephclose:${memberId}`, EPHEMERAL_CLOSE_TOKENS_PER_MIN, 60_000)
}
function takeEphemeralInfoToken(memberId: string): boolean {
  return ephemeralLimiter.take(`ephinfo:${memberId}`, EPHEMERAL_INFO_TOKENS_PER_MIN, 60_000)
}

function joinYjsRoom(ws: WebSocket, room: string): { ok: true } | { ok: false; reason: string } {
  let mine = yjsSocketRooms.get(ws)
  if (!mine) {
    mine = new Set()
    yjsSocketRooms.set(ws, mine)
  }
  if (!mine.has(room) && mine.size >= YJS_ROOMS_PER_SOCKET_MAX) {
    return { ok: false, reason: 'Too many live document rooms on this connection' }
  }
  let peers = yjsRooms.get(room)
  if (!peers) {
    peers = new Set()
    yjsRooms.set(room, peers)
  }
  // TCC-R1134-CMP-021: cap co-editors on ONE board so a team-wide "everyone
  // opens the same board" storm cannot turn this room's fanout into an
  // unbounded O(n^2) broadcast (see YJS_ROOM_MAX_PEERS doc comment).
  // Admin Limits meta can lower (not raise past env ceiling) via TeamLimitsStore.
  const yjsPeerCap = limitsStore.getMeta().yjsRoomMaxPeers || YJS_ROOM_MAX_PEERS
  if (!peers.has(ws) && peers.size >= yjsPeerCap) {
    return {
      ok: false,
      reason: 'Too many people have this document open right now. Try again shortly.',
    }
  }
  mine.add(room)
  peers.add(ws)
  return { ok: true }
}

function fanoutYjsUpdate(
  from: WebSocket,
  room: string,
  updateB64: string,
  session: LiveSession,
): void {
  const peers = yjsRooms.get(room)
  if (!peers) return
  const frame: BridgeFrame = {
    type: 'yjs_peer_update',
    room,
    updateB64,
    fromMemberId: session.memberId,
    fromDeviceId: session.deviceId,
  }
  for (const peer of peers) {
    if (peer === from) continue
    if (peer.readyState !== 1 /* OPEN */) continue
    if (typeof peer.bufferedAmount === 'number' && peer.bufferedAmount > FANOUT_BACKPRESSURE_BYTES) {
      // TCC-R1148-BRG-001: silent skip loses durable-less yjs forever - force resync.
      forceCloseBackpressured(peer, 'yjs backpressure')
      continue
    }
    if (!reply(peer, frame)) {
      forceCloseBackpressured(peer, 'yjs send failed')
    }
  }
}

function fanoutYjsAwareness(
  from: WebSocket,
  room: string,
  updateB64: string,
  session: LiveSession,
): void {
  const peers = yjsRooms.get(room)
  if (!peers) return
  const frame: BridgeFrame = {
    type: 'yjs_peer_awareness',
    room,
    updateB64,
    fromMemberId: session.memberId,
    fromDeviceId: session.deviceId,
  }
  for (const peer of peers) {
    if (peer === from) continue
    if (peer.readyState !== 1) continue
    if (typeof peer.bufferedAmount === 'number' && peer.bufferedAmount > FANOUT_BACKPRESSURE_BYTES) {
      // TCC-R1148-BRG-001: silent skip loses durable-less yjs forever - force resync.
      forceCloseBackpressured(peer, 'yjs backpressure')
      continue
    }
    if (!reply(peer, frame)) {
      forceCloseBackpressured(peer, 'yjs send failed')
    }
  }
}

function presencePeerFromSession(s: LiveSession): PresencePeer {
  return {
    memberId: s.memberId,
    displayName: s.displayName,
    role: s.role,
    deviceId: s.deviceId,
    lastSeen: s.lastSeen,
  }
}

function presenceSnapshotNow(): PresencePeer[] {
  return buildPresenceSnapshot([...live.values()].map(presencePeerFromSession))
}

/**
 * TCC-R1133-WS-003: presence join fanout used to fire one `presence_peer`
 * broadcast per `hello`/redeem, each independently looping every OTHER live
 * socket - a reconnect storm of N devices produced O(N) fanout work per
 * hello, i.e. O(N^2) `presence_peer` frames for the whole storm. Multiple
 * join/leave changes inside `PRESENCE_JOIN_COALESCE_MS` now collapse into
 * ONE fanout pass: a fresh `presence_snapshot` broadcast to every live
 * socket, sent at most once per coalescing window regardless of how many
 * members joined/left inside it. The client already treats an unsolicited
 * `presence_snapshot` as a full-roster replace (same handling as the
 * snapshot it gets immediately on its own `hello_ok`/redeem via
 * `pushPresenceSnapshot`), so this is wire-compatible with every existing
 * client - no new frame type, no client-side change needed.
 */
let presenceFanoutTimer: ReturnType<typeof setTimeout> | null = null
function schedulePresenceFanoutBroadcast(): void {
  if (presenceFanoutTimer) return
  presenceFanoutTimer = setTimeout(() => {
    presenceFanoutTimer = null
    const frame: BridgeFrame = { type: 'presence_snapshot', peers: presenceSnapshotNow() }
    for (const [sock] of live) {
      if (sock.readyState !== 1) continue
      reply(sock, frame)
    }
  }, PRESENCE_JOIN_COALESCE_MS)
  presenceFanoutTimer.unref?.()
}

function pushPresenceSnapshot(ws: WebSocket, frameId?: string): void {
  const frame: BridgeFrame = frameId
    ? { type: 'presence_snapshot', frameId, peers: presenceSnapshotNow() }
    : { type: 'presence_snapshot', peers: presenceSnapshotNow() }
  reply(ws, frame)
}

/** Drop a live socket and fan leave when the member has no other device online. */
function dropLiveSession(ws: WebSocket): void {
  const session = live.get(ws)
  leaveAllYjsRooms(ws)
  live.delete(ws)
  if (!session) return
  unindexLiveSocketForMember(session.memberId, ws)
  if (memberHasOtherLiveSocket(live.values(), session.memberId)) return
  schedulePresenceFanoutBroadcast()
  handleEphemeralMemberOffline(session.memberId)
}

/** Drop without presence leave (session rotate / same-member reclaim). */
function quietDropLiveSession(ws: WebSocket): void {
  const session = live.get(ws)
  leaveAllYjsRooms(ws)
  live.delete(ws)
  if (session) unindexLiveSocketForMember(session.memberId, ws)
}

/** TCC-R1144-BRG-002: process-wide rooms-list scan budget. */
const roomsListProcessPool = new AsyncSemaphore(CHAT_ROOMS_LIST_PROCESS_CONCURRENCY)
/** TCC-R1149-BRG-002 / TCC-R1148-BRG-005: heavy export leases. */
const chatExportLease = new TrySemaphore(CHAT_EXPORT_PROCESS_LEASES)
const backupExportLease = new TrySemaphore(BACKUP_EXPORT_PROCESS_LEASES)

/** TCC-R1152-BRG-002 / TCC-R1153-BRG-001 / TCC-R1154-BRG-004: per-socket generations. */
const socketAuthGeneration = new WeakMap<WebSocket, number>()
const socketCatchUpGeneration = new WeakMap<WebSocket, number>()
const socketRedeemInFlight = new WeakSet<WebSocket>()
const preAuthConnectedAt = new WeakMap<WebSocket, number>()

function bumpSocketAuthGeneration(ws: WebSocket): number {
  const next = (socketAuthGeneration.get(ws) || 0) + 1
  socketAuthGeneration.set(ws, next)
  return next
}

function currentSocketAuthGeneration(ws: WebSocket): number {
  return socketAuthGeneration.get(ws) || 0
}

/** TCC-R1147-BRG-002: per-token (+IP) guest password/PIN fail lockout. */
const guestAuthFails = new Map<string, { fails: number; resetAt: number }>()
function takeGuestAuthAttempt(key: string): boolean {
  const now = Date.now()
  let row = guestAuthFails.get(key)
  if (!row || now >= row.resetAt) {
    row = { fails: 0, resetAt: now + GUEST_AUTH_FAIL_WINDOW_MS }
    guestAuthFails.set(key, row)
  }
  if (row.fails >= GUEST_AUTH_FAIL_MAX) return false
  return true
}
function noteGuestAuthFailure(key: string): void {
  const now = Date.now()
  let row = guestAuthFails.get(key)
  if (!row || now >= row.resetAt) {
    row = { fails: 0, resetAt: now + GUEST_AUTH_FAIL_WINDOW_MS }
    guestAuthFails.set(key, row)
  }
  row.fails += 1
}
function clearGuestAuthFailures(key: string): void {
  guestAuthFails.delete(key)
}

/** TCC-R1144-BRG-005 twin: process-wide download / exists-skip heap budget. */
let inflightHttpDownloadBudgetUsed = 0
function tryReserveHttpDownloadBudget(bytes: number): boolean {
  const n = Math.max(0, Math.floor(bytes) || 0)
  if (n <= 0) return true
  if (inflightHttpDownloadBudgetUsed + n > MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES) return false
  inflightHttpDownloadBudgetUsed += n
  return true
}
function releaseHttpDownloadBudget(bytes: number): void {
  const n = Math.max(0, Math.floor(bytes) || 0)
  inflightHttpDownloadBudgetUsed = Math.max(0, inflightHttpDownloadBudgetUsed - n)
}

/**
 * TCC-R1144-BRG-003: drain unread request bodies on early refuse so keep-alive
 * sockets are not stuck with an undrained upload.
 */
function drainRequestBody(req: IncomingMessage): void {
  const method = (req.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  try {
    if (typeof (req as { readableEnded?: boolean }).readableEnded === 'boolean'
      && (req as { readableEnded?: boolean }).readableEnded) {
      return
    }
    req.resume()
  } catch { /* */ }
}

/** TCC-R1148-BRG-001: never silently skip after durable work - force-close peer. */
function forceCloseBackpressured(ws: WebSocket, reason = 'backpressure'): void {
  try { quietDropLiveSession(ws) } catch { /* */ }
  try { ws.close(1013, reason.slice(0, 120)) } catch { /* */ }
}

function replyOrForceClose(ws: WebSocket, frame: BridgeFrame, reason = 'backpressure'): boolean {
  const ok = reply(ws, frame)
  if (!ok && ws.readyState === ws.OPEN) {
    forceCloseBackpressured(ws, reason)
  }
  return ok
}

/** Bind a live session, preserving ops tokens on same-member re-hello. */
function bindLiveSession(
  ws: WebSocket,
  next: Omit<LiveSession, 'opsTokens' | 'opsRefillAt' | 'ws' | 'lastSeen'> & {
    opsTokens?: number
    opsRefillAt?: number
  },
): LiveSession {
  const prior = live.get(ws)
  // TCC-R1152-BRG-001: identity rebind must leave prior Yjs rooms first.
  if (prior && prior.memberId !== next.memberId) {
    leaveAllYjsRooms(ws)
    // TS-EPH-PERF-001: the ephemeral-chat reverse index is keyed by memberId,
    // not by socket - an identity rebind on the same socket must move this
    // socket out of the OLD memberId's set before it's re-indexed below,
    // or the old identity would keep a phantom "live" socket forever.
    unindexLiveSocketForMember(prior.memberId, ws)
  } else if (prior && prior.memberId === next.memberId) {
    // same member re-hello: keep yjs rooms
  } else if (prior) {
    leaveAllYjsRooms(ws)
  }
  // TCC-R1154-BRG-001: preserve ops budget on same-socket re-hello / redeem.
  const preserveOps = !!(prior && prior.memberId === next.memberId)
  const session: LiveSession = {
    memberId: next.memberId,
    deviceId: next.deviceId,
    role: next.role,
    displayName: next.displayName,
    sessionToken: next.sessionToken,
    ws,
    lastSeen: Date.now(),
    opsTokens: preserveOps ? prior!.opsTokens : (next.opsTokens ?? OPS_FRAME_TOKENS_PER_WINDOW),
    opsRefillAt: preserveOps ? prior!.opsRefillAt : (next.opsRefillAt ?? (Date.now() + OPS_FRAME_WINDOW_MS)),
  }
  live.set(ws, session)
  indexLiveSocketForMember(session.memberId, ws)
  handleEphemeralMemberOnline(session.memberId)
  return session
}

function sessionStillAuthorized(ws: WebSocket, session: LiveSession): boolean {
  if (!live.has(ws)) return false
  const liveS = live.get(ws)
  if (!liveS || liveS.memberId !== session.memberId) return false
  if (!store.findMember(session.memberId)) return false
  return true
}

/** TS-CHAT-013: enrich live MemberRow avatar blob sha onto chat payloads. */
function payloadForChatRow(
  message: Parameters<typeof toChatMessagePayload>[0],
  opts?: { clientMsgId?: string | null },
) {
  const m = store.findMember(message.memberId)
  const ref = m?.avatarRef
  // TCC-R1153-CHAT-009: always remap sticky jsonl `pinned` via the room's
  // pin list so edit/react peers cannot re-pin after unpin, and so a message
  // pinned earlier stays pinned when a newer one is pinned beside it.
  const pinIds =
    typeof message.room === 'string' ? chatStore.getPinnedMessageIds(message.room) : []
  return toChatMessagePayload(message, {
    avatarRef: isTeamChatAvatarBlobSha(ref) ? String(ref).toLowerCase() : null,
    pinnedMessageIds: pinIds,
    clientMsgId: opts?.clientMsgId,
  })
}

function fanoutChatPeer(
  from: WebSocket | null,
  message: Parameters<typeof toChatMessagePayload>[0],
): void {
  const frame: BridgeFrame = { type: 'chat_peer', message: payloadForChatRow(message) }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    // SEC-CHAT-01: room-scoped fanout (team = all live; DM/group = members only).
    if (!chatRooms.memberCanAccess(message.room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function fanoutChatEditPeer(from: WebSocket | null, message: Parameters<typeof toChatMessagePayload>[0]): void {
  const frame: BridgeFrame = { type: 'chat_edit_peer', message: payloadForChatRow(message) }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(message.room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function fanoutChatReactPeer(from: WebSocket | null, message: Parameters<typeof toChatMessagePayload>[0]): void {
  const frame: BridgeFrame = { type: 'chat_react_peer', message: payloadForChatRow(message) }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(message.room, sess.memberId)) continue
    reply(peer, frame)
  }
}

/**
 * Live pin change for everyone else in the room.
 *
 * `pinnedMessageIds` is the room's whole list after the change and is what a
 * current client applies. `pinnedMessageId` carries only its newest entry,
 * for clients built before a room could hold more than one pin - they show
 * that one message, which is the same thing they showed before.
 */
function fanoutChatPinPeer(
  from: WebSocket | null,
  room: string,
  pinnedMessageIds: readonly string[],
): void {
  const ids = [...pinnedMessageIds]
  const frame: BridgeFrame = {
    type: 'chat_pin_peer',
    room,
    pinnedMessageId: ids.length ? ids[ids.length - 1] : null,
    pinnedMessageIds: ids,
  }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function fanoutChatRoomRenamePeer(
  from: WebSocket | null,
  room: string,
  title: string,
): void {
  const frame: BridgeFrame = { type: 'chat_room_rename_peer', room, title }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

/**
 * P2: fan out a description/icon/permissions change to every other current
 * member. Only the fields the caller actually changed are included on the
 * frame (live-update convention shared with `fanoutChatRoomRenamePeer`).
 */
function fanoutChatRoomInfoPeer(
  from: WebSocket | null,
  room: string,
  patch: {
    description?: string
    iconKind?: 'none' | 'preset' | 'custom'
    iconRef?: string | null
    iconRev?: number
    permissions?: {
      addMembers: 'owner_admin' | 'anyone'
      editInfo: 'owner_admin' | 'anyone'
      pinMessages: 'admin_only' | 'anyone'
    }
  },
): void {
  const frame: BridgeFrame = { type: 'chat_room_info_peer', room, ...patch }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function fanoutChatRoomMembersPeer(
  from: WebSocket | null,
  roomId: string,
  opts?: { alsoNotifyMemberIds?: string[] },
): void {
  const row = chatRooms.get(roomId)
  if (!row) return
  const frame: BridgeFrame = {
    type: 'chat_room_members_peer',
    room: row.id,
    memberIds: [...row.memberIds],
    ownerIds: [...row.ownerIds],
    bannedMemberIds: [...row.bannedMemberIds],
    allowedReactionEmojis: [...row.allowedReactionEmojis],
  }
  const also = new Set(
    (opts?.alsoNotifyMemberIds || [])
      .map((x) => String(x || '').trim())
      .filter(Boolean),
  )
  for (const [peer, sess] of live) {
    // TCC-R1148-CHAT-008: include the mutating socket (`from`) so its other
    // windows heal ACL without a rooms_list round-trip that omits fields.
    if (peer.readyState !== 1) continue
    const maySee =
      chatRooms.memberCanAccess(row.id, sess.memberId)
      || sess.role === 'admin'
      || also.has(sess.memberId)
    if (!maySee) continue
    reply(peer, frame)
  }
}

function fanoutChatSeenPeer(
  from: WebSocket | null,
  room: string,
  memberId: string,
  lastReadAt: number,
  lastReadMsgId: string | null,
): void {
  const frame: BridgeFrame = {
    type: 'chat_seen_peer',
    room,
    memberId,
    lastReadAt,
    lastReadMsgId,
  }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function roomPayload(row: {
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
    pinMessages?: 'admin_only' | 'anyone'
  }
}): {
  id: string
  kind: 'team' | 'dm' | 'group' | 'private'
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
    ownerIds: Array.isArray(row.ownerIds) ? [...row.ownerIds] : [],
    bannedMemberIds: Array.isArray(row.bannedMemberIds) ? [...row.bannedMemberIds] : [],
    allowedReactionEmojis: Array.isArray(row.allowedReactionEmojis)
      ? [...row.allowedReactionEmojis]
      : [],
    description: typeof row.description === 'string' ? row.description : '',
    iconKind: row.iconKind === 'preset' || row.iconKind === 'custom' ? row.iconKind : 'none',
    iconRef: typeof row.iconRef === 'string' ? row.iconRef : null,
    iconRev: typeof row.iconRev === 'number' && Number.isFinite(row.iconRev) ? row.iconRev : 0,
    permissions: {
      addMembers: row.permissions?.addMembers ?? 'anyone',
      editInfo: row.permissions?.editInfo ?? 'anyone',
      pinMessages: row.permissions?.pinMessages ?? 'admin_only',
    },
  }
}

/**
 * TS-CHAT-011: notify remaining DM peers before membership is cleared.
 * Must key off captured peer ids - memberCanAccess is false after close.
 */
function fanoutChatRoomClosePeer(
  from: WebSocket | null,
  room: string,
  peerIds: string[],
): void {
  if (!Array.isArray(peerIds) || peerIds.length === 0) return
  const want = new Set(peerIds.filter((id) => typeof id === 'string' && id.trim()))
  if (want.size === 0) return
  const frame: BridgeFrame = { type: 'chat_room_close_peer', room }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!want.has(sess.memberId)) continue
    reply(peer, frame)
  }
}

/** TS-CHAT-012: fan avatar/name updates to every other live socket. */
function fanoutChatProfilePeer(
  from: WebSocket | null,
  payload: {
    memberId: string
    displayName: string
    avatarRef?: string | null
    avatarRev?: number
  },
): void {
  const frame: BridgeFrame = {
    type: 'profile_peer',
    memberId: payload.memberId,
    displayName: payload.displayName,
    avatarRef: payload.avatarRef,
    avatarRev: payload.avatarRev,
  }
  for (const [peer] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    reply(peer, frame)
  }
}

function fanoutChatTypingPeer(
  from: WebSocket | null,
  room: string,
  memberId: string,
  memberName: string,
  typing: boolean,
): void {
  // TCC-R1148-LIM-001: honor client start/stop so peers clear typing chips.
  const frame: BridgeFrame = {
    type: 'chat_typing_peer',
    room,
    memberId,
    memberName,
    typing: typing === true,
  }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function fanoutChatDeletePeer(
  from: WebSocket | null,
  messageId: string,
  room: string,
  meta?: { createdAt?: number; memberId?: string },
): void {
  const createdAt =
    typeof meta?.createdAt === 'number'
    && Number.isFinite(meta.createdAt)
    && meta.createdAt > 0
      ? Math.floor(meta.createdAt)
      : undefined
  const memberId =
    typeof meta?.memberId === 'string' && meta.memberId.trim()
      ? meta.memberId.replace(/\0/g, '').trim().slice(0, 128)
      : undefined
  const frame: BridgeFrame = {
    type: 'chat_delete_peer',
    messageId,
    room,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(memberId !== undefined ? { memberId } : {}),
  }
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    if (!chatRooms.memberCanAccess(room, sess.memberId)) continue
    reply(peer, frame)
  }
}

function takeChatSendToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatSendPerMin || CHAT_RATE_SEND_PER_MIN
  return chatLimiter.take(`chatsend:${memberId}`, n, 60_000)
}

function takeChatHistoryToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatHistoryPerMin || CHAT_RATE_HISTORY_PER_MIN
  return chatLimiter.take(`chathist:${memberId}`, n, 60_000)
}

function takeChatTypingToken(memberId: string): boolean {
  return chatLimiter.take(`chattype:${memberId}`, CHAT_RATE_TYPING_PER_SEC, 1_000)
}

function takeChatReactToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatReactPerMin || CHAT_RATE_REACT_PER_MIN
  return chatLimiter.take(`chatreact:${memberId}`, n, 60_000)
}

function takeChatPasswordJoinToken(memberId: string): boolean {
  return chatLimiter.take(
    `chatjoin:${memberId}`,
    CHAT_RATE_PASSWORD_JOIN_PER_15MIN,
    15 * 60_000,
  )
}

function takeChatBlobPutToken(memberId: string): boolean {
  return chatLimiter.take(`chatblob:${memberId}`, CHAT_RATE_BLOB_PUT_PER_MIN, 60_000)
}

/**
 * TCC-R1133-SEC-001: member-scoped budget for chat attachment/avatar GET,
 * matching the PUT sibling above and the CRM `/v1/blobs/:sha` GET sibling
 * (`takeBlobToken`). Attachments and avatars get their own bucket namespace
 * (distinct keys, same limit) so a burst of avatar loads on room-open cannot
 * starve attachment downloads in the same window or vice versa.
 */
function takeChatBlobGetToken(memberId: string): boolean {
  return chatLimiter.take(`chatblobget:${memberId}`, CHAT_RATE_BLOB_GET_PER_MIN, 60_000)
}
function takeChatAvatarGetToken(memberId: string): boolean {
  return chatLimiter.take(`chatavatarget:${memberId}`, CHAT_RATE_BLOB_GET_PER_MIN, 60_000)
}

/**
 * TCC-R1134-CHAT-040: shared bucket for chat_delete/chat_pin/chat_unsend -
 * see CHAT_RATE_MUTATE_PER_MIN doc comment.
 */
function takeChatMutateToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatMutatePerMin || CHAT_RATE_MUTATE_PER_MIN
  return chatLimiter.take(`chatmutate:${memberId}`, n, 60_000)
}

/** TCC-R1134-CHAT-040: shared bucket for chat_search/chat_jump (both disk-scan reads). */
function takeChatSearchToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatSearchPerMin || CHAT_RATE_SEARCH_PER_MIN
  return chatLimiter.take(`chatsearch:${memberId}`, n, 60_000)
}

/** TCC-R1134-CHAT-040: chat_export (Admin-only, whole-room serialize - most expensive chat_* op). */
function takeChatExportToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatExportPerMin || CHAT_RATE_EXPORT_PER_MIN
  return chatLimiter.take(`chatexport:${memberId}`, n, 60_000)
}

/** TCC-R1145-CHAT-010: durable unread write + room-wide seen fanout budget. */
function takeChatUnreadToken(memberId: string): boolean {
  const n = limitsStore.getMeta().chatMutatePerMin || CHAT_RATE_MUTATE_PER_MIN
  return chatLimiter.take(`chatunread:${memberId}`, n, 60_000)
}

/** TCC-R1145-CHAT-013: room create / roster mutators + members_peer fanout. */
function takeChatRoomAdminToken(memberId: string): boolean {
  return chatLimiter.take(`chatroomadmin:${memberId}`, CHAT_RATE_ROOM_ADMIN_PER_MIN, 60_000)
}

/** TCC-R1149-CHAT-009: Admin may read/export closed rooms (history/export/blob). */
function chatRoomReadable(roomId: string, memberId: string, role: string | undefined): boolean {
  if (chatRooms.memberCanAccess(roomId, memberId)) return true
  if (role === 'admin') {
    const row = chatRooms.get(roomId)
    if (row) return true
  }
  return false
}

/**
 * SEC-CHAT-14 + TS-CHAT-011: wipe unread marks when a member leaves the team.
 * DMs close fully (closedAt) so the survivor cannot keep sending to a departed peer.
 * Groups/private: remove the departed member only (empty roster still stamps closedAt via leave).
 */
function handleMemberLeaveChat(memberId: string): void {
  chatUnread.wipeMember(memberId)
  for (const row of chatRooms.listForMember(memberId)) {
    if (row.kind === 'team') continue
    if (row.kind === 'dm') {
      const peers = row.memberIds.filter((id) => id !== memberId)
      const closed = chatRooms.closeRoom(row.id)
      if (!('error' in closed)) {
        fanoutChatRoomClosePeer(null, row.id, peers)
      }
      continue
    }
    // Owner/admin succession: the member is leaving the WHOLE team (or was
    // kicked), not choosing to hand off this one room - `forced:true` skips
    // the voluntary "you are the sole owner" block so this cannot get stuck.
    // Succession (earliest-joined remaining member becomes owner) still
    // runs inside `leave()` and remaining members are notified live below.
    const wasSoleOwner = row.ownerIds.length === 1 && row.ownerIds[0] === memberId
    const left = chatRooms.leave(row.id, memberId, { forced: true })
    if (!('error' in left) && wasSoleOwner) {
      const after = chatRooms.get(row.id)
      if (after && after.ownerIds.length > 0) {
        console.log(
          `[bridge] room ${row.id} owner departed the team - auto-promoted ${after.ownerIds[0]} (earliest-joined remaining member)`,
        )
      }
    }
    if (!('error' in left)) fanoutChatRoomMembersPeer(null, row.id)
  }
}

function fanoutToAdmins(
  from: WebSocket | null,
  frame: BridgeFrame,
): number {
  let n = 0
  for (const [peer, sess] of live) {
    if (from && peer === from) continue
    if (sess.role !== 'admin') continue
    if (peer.readyState !== 1) continue
    if (reply(peer, frame)) n++
  }
  return n
}

function fanoutAll(from: WebSocket | null, frame: BridgeFrame): void {
  for (const [peer] of live) {
    if (from && peer === from) continue
    if (peer.readyState !== 1) continue
    reply(peer, frame)
  }
}

/** TS-BRG-008: shared limiters for hello / invite / blob / HTTP (not only ops frames). */
const helloLimiter = new TokenBucketLimiter()
const inviteLimiter = new TokenBucketLimiter()
const blobLimiter = new TokenBucketLimiter()
const backupLimiter = new TokenBucketLimiter()
const httpLimiter = new TokenBucketLimiter()
/** TCC-R1134-BRGLIM-001: per-member budget for `yjs_update` / `yjs_awareness` frames. */
const yjsLimiter = new TokenBucketLimiter()
const preAuthWsLimiter = new TokenBucketLimiter()
const rosterLimiter = new TokenBucketLimiter()
const adminMutateLimiter = new TokenBucketLimiter()
const adminHttpMutateLimiter = new TokenBucketLimiter()
const guestDownloadLimiter = new TokenBucketLimiter()
const ackOpsLimiter = new TokenBucketLimiter()
/**
 * Admin recovery attempts. Deliberately its own limiter (never shared with
 * `helloLimiter`) so a normal reconnect storm cannot spend the recovery budget,
 * and a recovery brute force cannot hide inside ordinary hello traffic.
 */
const adminRecoveryLimiter = new TokenBucketLimiter()

/** TS-SHOP-002: only loopback + TEAMSPACE_TRUSTED_PROXIES may supply X-Forwarded-For. */
const TRUSTED_PROXIES = parseTrustedProxies(process.env.TEAMSPACE_TRUSTED_PROXIES)

/**
 * BRGPROXY-001: how many entries on the RIGHT of a trusted X-Forwarded-For
 * chain belong to our own infrastructure. Everything left of that is caller
 * supplied and must never key a rate limiter. Set to 0 when nothing proxies
 * this bridge.
 */
const TRUSTED_PROXY_HOPS = parseTrustedProxyHops(process.env.TEAMSPACE_TRUSTED_PROXY_HOPS)

function clientIp(req: IncomingMessage): string {
  return resolveBridgeClientIp(
    req.socket.remoteAddress,
    req.headers['x-forwarded-for'],
    TRUSTED_PROXIES,
    TRUSTED_PROXY_HOPS,
  )
}

function takeHelloToken(ip: string): boolean {
  return helloLimiter.take(`hello:${ip}`, HELLO_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeInviteToken(key: string): boolean {
  return inviteLimiter.take(`invite:${key}`, INVITE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

/**
 * Strict per-IP budget for Admin recovery attempts - see the doc comment on
 * `ADMIN_RECOVERY_TOKENS_PER_WINDOW` (throughput.ts). A token is consumed BEFORE
 * the key is compared, so a wrong guess and a right one cost the same, and once
 * the budget is gone the IP is locked out until the whole window rolls over.
 */
function takeAdminRecoveryToken(ip: string): boolean {
  return adminRecoveryLimiter.take(
    `adminrecovery:${ip}`,
    ADMIN_RECOVERY_TOKENS_PER_WINDOW,
    ADMIN_RECOVERY_WINDOW_MS,
  )
}

/** Truncated id for operator logs - never enough to identify a person's data. */
function logId(value: string): string {
  const raw = String(value || '')
  if (!raw) return '(none)'
  return raw.length > 12 ? `${raw.slice(0, 12)}...` : raw
}

function takeBlobToken(sessionKey: string): boolean {
  return blobLimiter.take(`blob:${sessionKey}`, BLOB_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeBackupToken(sessionKey: string): boolean {
  return backupLimiter.take(`backup:${sessionKey}`, BACKUP_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

/** TCC-R1134-BRGLIM-001: see the doc comment on `YJS_UPDATE_TOKENS_PER_SEC` (throughput.ts). */
function takeYjsUpdateToken(memberId: string): boolean {
  return yjsLimiter.take(`yjsupd:${memberId}`, YJS_UPDATE_TOKENS_PER_SEC, 1_000)
}
/** TCC-R1134-BRGLIM-001: see the doc comment on `YJS_AWARENESS_TOKENS_PER_SEC` (throughput.ts). */
function takeYjsAwarenessToken(memberId: string): boolean {
  return yjsLimiter.take(`yjsaware:${memberId}`, YJS_AWARENESS_TOKENS_PER_SEC, 1_000)
}

function takeHttpToken(ip: string): boolean {
  return httpLimiter.take(`http:${ip}`, HTTP_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takePreAuthWsToken(ip: string): boolean {
  return preAuthWsLimiter.take(`preauth:${ip}`, PRE_AUTH_WS_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeRosterToken(memberId: string): boolean {
  return rosterLimiter.take(`roster:${memberId}`, ROSTER_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeAdminMutateToken(memberId: string): boolean {
  return adminMutateLimiter.take(`adminmut:${memberId}`, ADMIN_MUTATE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeAdminHttpMutateToken(memberId: string): boolean {
  return adminHttpMutateLimiter.take(`adminhttp:${memberId}`, ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeGuestDownloadToken(ip: string): boolean {
  return guestDownloadLimiter.take(`guestdl:${ip}`, GUEST_DOWNLOAD_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeAckOpsToken(session: LiveSession): boolean {
  return ackOpsLimiter.take(`ackops:${session.memberId}`, ACK_OPS_TOKENS_PER_WINDOW, OPS_FRAME_WINDOW_MS)
}

function takeChatRoomsListToken(memberId: string): boolean {
  return chatLimiter.take(`chatrooms:${memberId}`, CHAT_ROOMS_LIST_TOKENS_PER_MIN, 60_000)
}

function takeChatAvatarPutToken(memberId: string): boolean {
  return chatLimiter.take(`chatavatarput:${memberId}`, CHAT_AVATAR_PUT_TOKENS_PER_MIN, 60_000)
}

function takeProfileUpdateToken(memberId: string): boolean {
  return chatLimiter.take(`profile:${memberId}`, PROFILE_UPDATE_TOKENS_PER_MIN, 60_000)
}

function takeYjsJoinToken(memberId: string): boolean {
  return yjsLimiter.take(`yjsjoin:${memberId}`, YJS_JOIN_TOKENS_PER_SEC, 1_000)
}

function reply(ws: WebSocket, frame: BridgeFrame): boolean {
  if (ws.readyState !== ws.OPEN) return false
  try {
    // TS-CX-041: never pile onto a stalled peer (bounded buffer).
    if (typeof ws.bufferedAmount === 'number' && ws.bufferedAmount > FANOUT_BACKPRESSURE_BYTES) {
      return false
    }
    ws.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

function takeOpsToken(s: LiveSession): boolean {
  const now = Date.now()
  if (now >= s.opsRefillAt) {
    s.opsTokens = OPS_FRAME_TOKENS_PER_WINDOW
    s.opsRefillAt = now + OPS_FRAME_WINDOW_MS
  }
  if (s.opsTokens <= 0) return false
  s.opsTokens -= 1
  return true
}

/**
 * TS-SHR-022 / TCC-R1143-SHR-001: normalize optional colleague-scope list.
 * - `undefined` = key absent = whole team
 * - `string[]` (including empty) = restricted (empty = nobody except origin)
 * Never collapse empty → null (that failed open to whole-team fanout).
 */
function opVisibleToMemberIds(op: ModulesSyncOp): string[] | undefined {
  const hasTop = Array.isArray(op.visibleToMemberIds)
  const hasPatch =
    !!op.patch
    && typeof op.patch === 'object'
    && !Array.isArray(op.patch)
    && Array.isArray((op.patch as { visibleToMemberIds?: unknown }).visibleToMemberIds)
  if (!hasTop && !hasPatch) return undefined
  const raw = hasTop
    ? (op.visibleToMemberIds as unknown[])
    : ((op.patch as { visibleToMemberIds: unknown[] }).visibleToMemberIds)
  return raw
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 128))
    .slice(0, 500)
}

/** TS-SHR-022: may this live peer receive the op under colleague scope? */
function peerMayReceiveScopedOp(
  peerSession: LiveSession,
  op: ModulesSyncOp,
): boolean {
  const visible = opVisibleToMemberIds(op)
  if (visible === undefined) return true
  if (peerSession.memberId === op.originMemberId) return true
  // TCC-R1147-ACL-001: Admins always receive colleague-scoped ops (UI picker
  // omits self; wire must not blind co-admins from Specific-people shares).
  if (peerSession.role === 'admin') return true
  return visible.includes(peerSession.memberId)
}

function handleOps(ws: WebSocket, session: LiveSession, frameId: string, ops: unknown): void {
  // TS-SEC-005: Viewer is read-only on the wire (ops mutate CRM).
  if (session.role === 'viewer') {
    reply(ws, { type: 'error', requestId: frameId, message: 'Viewers cannot change shared Modules' })
    return
  }
  if (!takeOpsToken(session)) {
    reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
    return
  }
  if (!Array.isArray(ops)) {
    reply(ws, { type: 'error', requestId: frameId, message: 'ops must be an array' })
    return
  }
  const batch = ops.slice(0, MAX_OPS_PER_FRAME) as ModulesSyncOp[]
  const results: Array<{ opId: string; status: 'applied' | 'refused' | 'parked'; reason?: string }> = []
  const applied: ModulesSyncOp[] = []

  for (const raw of batch) {
    if (!raw || typeof raw !== 'object') {
      results.push({ opId: 'unknown', status: 'refused', reason: 'malformed op' })
      continue
    }
    const op = raw as ModulesSyncOp
    const opId = typeof op.opId === 'string' ? op.opId.slice(0, 200) : ''
    if (!opId) {
      results.push({ opId: 'unknown', status: 'refused', reason: 'opId required' })
      continue
    }
    if (!KNOWN_OP_KINDS.has(String(op.kind))) {
      results.push({
        opId,
        status: 'parked',
        reason: 'Update the app to see this change',
      })
      continue
    }
    const scopedVisible = opVisibleToMemberIds(op)
    const stamped: ModulesSyncOp = {
      ...op,
      opId,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      hopCount: typeof op.hopCount === 'number' ? Math.max(0, Math.floor(op.hopCount)) : 0,
      originMemberId: session.memberId,
      originMemberName: session.displayName,
      originDevice: typeof op.originDevice === 'string' ? op.originDevice : session.deviceId,
      // TCC-R1143-SHR-001: preserve empty arrays (scoped-to-nobody).
      ...(scopedVisible !== undefined ? { visibleToMemberIds: scopedVisible } : {}),
    }
    try {
      store.appendOp(stamped)
      results.push({ opId, status: 'applied' })
      applied.push(stamped)
    } catch (err) {
      results.push({
        opId,
        status: 'refused',
        reason: err instanceof Error ? err.message.slice(0, 200) : 'persist failed',
      })
    }
  }

  // TCC-R1150-BRG-002: if ops_result cannot be delivered after durable append,
  // force-close so the client reconnects instead of silently retry-duplicating
  // (appendOp is now idempotent by opId as a second belt).
  const resultOk = reply(ws, { type: 'ops_result', frameId, results })
  if (!resultOk) {
    forceCloseBackpressured(ws, 'ops_result backpressure')
    return
  }

  if (applied.length > 0) {
    // TS-SHR-022 / TCC-R1143-SHR-001: split team-wide vs member-scoped ops.
    // Empty visibleTo stays scoped (nobody except origin), never team-wide.
    const teamWide = applied.filter((op) => opVisibleToMemberIds(op) === undefined)
    const scoped = applied.filter((op) => opVisibleToMemberIds(op) !== undefined)
    if (teamWide.length > 0) {
      const out: BridgeFrame = {
        type: 'ops',
        frameId: `fan-${frameId}`,
        ops: teamWide,
      }
      for (const [peer] of live) {
        if (peer === ws) continue
        // TCC-R1148-BRG-001: durable ops already applied - never silent-drop peer.
        if (!reply(peer, out)) forceCloseBackpressured(peer, 'ops fanout backpressure')
      }
    }
    if (scoped.length > 0) {
      for (const [peer, s] of live) {
        if (peer === ws) continue
        const forPeer = scoped.filter((op) => peerMayReceiveScopedOp(s, op))
        if (forPeer.length === 0) continue
        if (!reply(peer, {
          type: 'ops',
          frameId: `fan-${frameId}-${s.memberId.slice(0, 16)}`,
          ops: forPeer,
        })) {
          forceCloseBackpressured(peer, 'ops fanout backpressure')
        }
      }
    }
  }
}

function requireAdmin(session: LiveSession | undefined): session is LiveSession {
  return !!session && session.role === 'admin'
}

function catchUpOpNeeded(
  op: ModulesSyncOp,
  deviceId: string,
  peerSession: LiveSession | undefined,
): boolean {
  const opId = typeof op.opId === 'string' ? op.opId : ''
  if (!opId) return false
  if (store.hasAcked(deviceId, opId)) return false
  if (typeof op.originDevice === 'string' && op.originDevice === deviceId) return false
  if (peerSession && !peerMayReceiveScopedOp(peerSession, op)) return false
  return true
}

function sendCatchUpChunk(
  ws: WebSocket,
  deviceId: string,
  offset: number,
  chunk: ModulesSyncOp[],
): boolean {
  const ok = reply(ws, {
    type: 'ops',
    frameId: `catchup-${deviceId.slice(0, 24)}-${offset}`,
    ops: chunk,
  })
  if (!ok) {
    try {
      reply(ws, {
        type: 'error',
        message: 'Catch-up incomplete - reconnect to finish sync',
      })
    } catch { /* */ }
    forceCloseBackpressured(ws, 'catchup backpressure')
  }
  return ok
}

function sendCatchUpStatus(
  ws: WebSocket,
  deviceId: string,
  truncated: boolean,
  extra?: { sent?: number; done?: boolean },
): void {
  reply(ws, {
    type: 'catchup_status',
    frameId: `catchup-status-${deviceId.slice(0, 24)}`,
    truncated,
    ...(typeof extra?.sent === 'number' && Number.isFinite(extra.sent)
      ? { sent: Math.floor(extra.sent) }
      : {}),
    ...(extra?.done === true ? { done: true } : {}),
  })
}

/** BRG-059: stream the durable log oldest-first (new device / missed history). */
async function sendFullCatchUpOps(
  ws: WebSocket,
  deviceId: string,
  generation: number,
  peerSession: LiveSession | undefined,
): Promise<void> {
  let sent = 0
  let chunk: ModulesSyncOp[] = []
  let chunkBytes = 2
  let truncated = false
  for await (const op of store.scanOpsFromStart()) {
    if (!live.has(ws)) return
    if (socketCatchUpGeneration.get(ws) !== generation) return
    if (!catchUpOpNeeded(op, deviceId, peerSession)) continue
    const encoded = encodedOpByteLength(op)
    // BRG-061: a single op over the byte budget cannot ride this socket.
    // Skip it so catch-up does not reconnect-loop on the same fat row.
    if (!Number.isFinite(encoded) || encoded > OPS_FRAME_MAX_BYTES) {
      const opId = typeof op.opId === 'string' ? op.opId.slice(0, 40) : ''
      console.warn(`[bridge] catch-up skip oversized op device=${deviceId.slice(0, 24)} op=${opId} bytes=${encoded}`)
      continue
    }
    const add = encoded + (chunk.length > 0 ? 1 : 0)
    if (chunk.length > 0 && (chunk.length >= MAX_OPS_PER_FRAME || chunkBytes + add > OPS_FRAME_MAX_BYTES)) {
      if (!sendCatchUpChunk(ws, deviceId, sent, chunk)) return
      sent += chunk.length
      chunk = []
      chunkBytes = 2
      // BRG-059: never stop because the log is large. Yield so a 100k / 10M
      // record share lands little by little instead of one giant frame.
      if (sent > 0 && sent % FULL_OPS_CATCHUP_LIMIT === 0) {
        console.log(`[bridge] catch-up still sending device=${deviceId.slice(0, 24)} sent=${sent}`)
        sendCatchUpStatus(ws, deviceId, false, { sent, done: false })
      }
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
    chunk.push(op)
    chunkBytes += chunk.length === 1 ? encoded : add
  }
  if (!live.has(ws)) return
  if (socketCatchUpGeneration.get(ws) !== generation) return
  if (chunk.length > 0) {
    if (!sendCatchUpChunk(ws, deviceId, sent, chunk)) return
    sent += chunk.length
  }
  if (!live.has(ws)) return
  if (socketCatchUpGeneration.get(ws) !== generation) return
  sendCatchUpStatus(ws, deviceId, truncated, { sent, done: true })
}

/** TS-BRG-002: replay unacked ops after hello so offline peers catch up. */
async function sendCatchUpOps(ws: WebSocket, deviceId: string, generation?: number): Promise<void> {
  try {
    const gen = generation ?? (socketCatchUpGeneration.get(ws) || 0)
    const peerSession = live.get(ws)

    // BRG-059: a device that has never acked (new originDevice after
    // replace-connection, first join) must read the full durable log.
    // The 5k tail drops older share snapshots (large SEO-class modules).
    if (store.deviceAckCount(deviceId) === 0) {
      await sendFullCatchUpOps(ws, deviceId, gen, peerSession)
      return
    }

    const recent = await store.readRecentOps()
    if (generation !== undefined && socketCatchUpGeneration.get(ws) !== gen) return
    const unacked = recent.filter((op) => catchUpOpNeeded(op, deviceId, peerSession))

    // Tail window saturated + oldest relevant still unacked = missed history
    // before the scan. Stream the full log instead of only flagging truncated.
    const windowSaturated = recent.length >= RECENT_OPS_CATCHUP_LIMIT
    let oldestRelevantUnacked = false
    if (windowSaturated) {
      for (const op of recent) {
        const opId = typeof op.opId === 'string' ? op.opId : ''
        if (!opId) continue
        if (typeof op.originDevice === 'string' && op.originDevice === deviceId) continue
        if (peerSession && !peerMayReceiveScopedOp(peerSession, op)) continue
        oldestRelevantUnacked = !store.hasAcked(deviceId, opId)
        break
      }
    }
    if (windowSaturated && oldestRelevantUnacked) {
      await sendFullCatchUpOps(ws, deviceId, gen, peerSession)
      return
    }

    const { frames, oversized } = splitOpsForWsFrames(unacked, {
      maxCount: MAX_OPS_PER_FRAME,
      maxBytes: OPS_FRAME_MAX_BYTES,
    })
    for (const bad of oversized) {
      const opId = typeof bad.opId === 'string' ? bad.opId.slice(0, 40) : ''
      console.warn(`[bridge] catch-up skip oversized tail op device=${deviceId.slice(0, 24)} op=${opId}`)
    }
    let offset = 0
    for (const chunk of frames) {
      if (!live.has(ws)) return
      if (generation !== undefined && socketCatchUpGeneration.get(ws) !== gen) return
      if (!sendCatchUpChunk(ws, deviceId, offset, chunk)) return
      offset += chunk.length
    }
    if (!live.has(ws)) return
    if (generation !== undefined && socketCatchUpGeneration.get(ws) !== gen) return
    sendCatchUpStatus(ws, deviceId, false, { sent: unacked.length, done: true })
  } catch {
    /* catch-up is best-effort; next hello retries */
  }
}

function startCatchUpOps(ws: WebSocket, deviceId: string): void {
  // TCC-R1154-BRG-004: coalesce concurrent catch-up senders per socket.
  const gen = (socketCatchUpGeneration.get(ws) || 0) + 1
  socketCatchUpGeneration.set(ws, gen)
  void sendCatchUpOps(ws, deviceId, gen)
}

function handleMessage(ws: WebSocket, data: Buffer | ArrayBuffer | Buffer[], connIp: string): void {
  // TCC-R1150-BRG-003: refuse mutators while draining.
  if (shuttingDown) {
    reply(ws, { type: 'error', message: 'Bridge is restarting - reconnect shortly' })
    try { ws.close(1001, 'server restarting') } catch { /* */ }
    return
  }
  let parsed: unknown
  const authedEarly = live.has(ws)
  try {
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8')
    // TCC-R1147-BRG-001: pre-auth frames stay small; full 8 MiB only after hello.
    const maxFrame = authedEarly ? WS_MAX_PAYLOAD_BYTES : PRE_AUTH_WS_MAX_FRAME_BYTES
    if (text.length > maxFrame) {
      reply(ws, { type: 'error', message: 'frame too large' })
      if (!authedEarly) {
        try { ws.close(1009, 'frame too large') } catch { /* */ }
      }
      return
    }
    if (!authedEarly) {
      if (!takePreAuthWsToken(connIp)) {
        reply(ws, { type: 'error', message: 'Rate limited - slow down' })
        return
      }
    }
    parsed = JSON.parse(text)
  } catch {
    reply(ws, { type: 'error', message: 'invalid JSON' })
    return
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    reply(ws, { type: 'error', message: 'frame must be an object' })
    return
  }
  const frame = parsed as Record<string, unknown>
  const type = typeof frame.type === 'string' ? frame.type : ''
  const session = live.get(ws)

  // TCC-R1147-BRG-001: before hello, only hello/ping/invite_redeem are admitted.
  if (!session && type !== 'hello' && type !== 'ping' && type !== 'invite_redeem') {
    reply(ws, { type: 'error', message: 'Not authenticated - send hello first' })
    return
  }

  try {
    switch (type) {
      case 'hello': {
        if (!takeHelloToken(connIp)) {
          reply(ws, { type: 'hello_refuse', reason: 'Rate limited - slow down' })
          return
        }
        const memberId = typeof frame.memberId === 'string' ? frame.memberId.slice(0, 128) : ''
        const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId.slice(0, 128) : ''
        const protocolVersion = Number(frame.protocolVersion)
        if (!Number.isFinite(protocolVersion) || protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
          reply(ws, { type: 'hello_refuse', reason: 'protocol version mismatch - update the app or bridge' })
          return
        }
        /**
         * Optional Admin recovery key (frozen wire field `adminRecoveryKey`).
         * Absent / blank behaves exactly as it did before this field existed:
         * `recoveryRequested` stays false and nothing below runs. Capped by
         * truncation before use so an oversized value cannot force extra work.
         */
        const recoveryRaw =
          typeof frame.adminRecoveryKey === 'string'
            ? frame.adminRecoveryKey.slice(0, ADMIN_RECOVERY_KEY_MAX_LEN)
            : ''
        const recoveryRequested = hasPresentedAdminRecoveryKey(recoveryRaw)
        if (recoveryRequested && !takeAdminRecoveryToken(connIp)) {
          console.warn(
            `[bridge] admin recovery locked out - too many attempts from ${connIp}` +
              ` (member ${logId(memberId)}, device ${logId(deviceId)})`,
          )
          reply(ws, { type: 'hello_refuse', reason: ADMIN_RECOVERY_REFUSE_LOCKED })
          return
        }
        const result = store.helloOrBootstrap({
          memberId,
          deviceId,
          sessionToken: typeof frame.sessionToken === 'string' ? frame.sessionToken : undefined,
          memberEmail: typeof frame.memberEmail === 'string' ? frame.memberEmail : undefined,
          displayName: typeof frame.displayName === 'string' ? frame.displayName : undefined,
          ...(recoveryRequested ? { adminRecoveryKey: recoveryRaw } : {}),
        })
        if (!result.ok) {
          // Every recovery attempt is logged at a level the operator sees in
          // `docker logs`. The key itself (or any part of it) is never logged.
          if (recoveryRequested) {
            console.warn(
              `[bridge] admin recovery refused: ${result.reason}` +
                ` (member ${logId(memberId)}, device ${logId(deviceId)}, from ${connIp})`,
            )
          }
          reply(ws, { type: 'hello_refuse', reason: result.reason })
          return
        }
        if (result.recoveredAdmin) {
          console.warn(
            `[bridge] admin recovery accepted - rebound Admin ${logId(result.member.memberId)}` +
              ` to device ${logId(deviceId)} (from ${connIp}). No rooms, messages, or member rows were changed.`,
          )
          if (result.evictedDeviceIds && result.evictedDeviceIds.length > 0) {
            console.warn(
              `[bridge] admin recovery dropped ${result.evictedDeviceIds.length} oldest device` +
                ` session(s) to stay under the per-member cap: ` +
                `${result.evictedDeviceIds.map((d) => logId(d)).join(', ')}`,
            )
          }
        }
        // TS-CHAT-012 / TCC-R1153-BRG-002: stamp avatar only when CAS accepts.
        if (typeof frame.avatarRef === 'string' && frame.avatarRef.trim()) {
          const rev =
            typeof frame.avatarRev === 'number' && Number.isFinite(frame.avatarRev) && frame.avatarRev > 0
              ? Math.floor(frame.avatarRev)
              : undefined
          const avatarUpdate = store.updateMemberChatProfile(result.member.memberId, {
            avatarRef: frame.avatarRef.trim().slice(0, 256),
            ...(rev !== undefined ? { avatarRev: rev } : {}),
          })
          // Soft-skip stale avatar on hello (do not refuse the session).
          if (avatarUpdate.ok && avatarUpdate.avatarApplied) {
            /* accepted */
          }
        }
        const team = store.ensureTeam()
        const liveMember = store.findMember(result.member.memberId) ?? result.member
        const authGen = bumpSocketAuthGeneration(ws)
        // TCC-R1146-LIM-004: reclaim prior sockets for same member+device
        // before bind (sleep / force-quit left a live row until TCP timeout).
        for (const [peerWs, peer] of live) {
          if (peerWs === ws) continue
          if (peer.memberId === liveMember.memberId && peer.deviceId === deviceId) {
            quietDropLiveSession(peerWs)
            try { peerWs.close(4001, 'session rotated') } catch { /* */ }
          }
        }
        bindLiveSession(ws, {
          memberId: liveMember.memberId,
          deviceId,
          role: liveMember.role,
          displayName: liveMember.displayName,
          sessionToken: result.sessionToken,
        })
        schedulePresenceFanoutBroadcast()
        // TCC-R1143-LIM-004 / MEDIA-002: stamp member-readable chat caps on
        // hello so non-admins apply voice max + edit window without Admin GET.
        const chatCaps = limitsStore.getPublicChatCaps()
        // TCC-R1150-BRG-001: only keep the live binding if hello_ok delivers.
        const helloOk = reply(ws, {
          type: 'hello_ok',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          teamId: team.teamId,
          teamName: typeof team.name === 'string' && team.name.trim()
            ? team.name.trim().slice(0, 200)
            : 'Team Space',
          role: liveMember.role,
          memberId: result.member.memberId,
          sessionToken: result.minted ? result.sessionToken : undefined,
          chatCaps,
        })
        if (!helloOk || currentSocketAuthGeneration(ws) !== authGen) {
          quietDropLiveSession(ws)
          forceCloseBackpressured(ws, 'hello_ok undelivered')
          return
        }
        // TS-CHAT-097: peers who are already online never see hello. Re-fan
        // the connecting member's photo/name so the other device paints it
        // without waiting for the next chat message.
        {
          const announced = store.findMember(result.member.memberId) ?? liveMember
          const ref = announced.avatarRef
          fanoutChatProfilePeer(ws, {
            memberId: announced.memberId,
            displayName: announced.displayName,
            avatarRef: isTeamChatAvatarBlobSha(ref) ? String(ref).toLowerCase() : null,
            avatarRev:
              typeof announced.avatarRev === 'number' && announced.avatarRev > 0
                ? Math.floor(announced.avatarRev)
                : undefined,
          })
        }
        pushPresenceSnapshot(ws)
        startCatchUpOps(ws, deviceId)
        return
      }
      case 'invite_create': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeInviteToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const email = typeof frame.email === 'string' ? frame.email : ''
        let role: BridgeRole = 'member'
        if (frame.role === 'viewer') role = 'viewer'
        else if (frame.role === 'admin') role = 'admin'
        const created = store.createInvite(session.memberId, email, role)
        if (!created.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: created.reason })
          return
        }
        reply(ws, {
          type: 'invite_ok',
          frameId,
          id: created.invite.id,
          token: created.invite.token,
          expiresAt: created.invite.expiresAt,
          // TCC-R1143-INV-002: echo persisted role so clients can detect coerce.
          role: created.invite.role,
        })
        return
      }
      case 'invite_revoke': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeInviteToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const tokenOrId = typeof frame.tokenOrId === 'string'
          ? frame.tokenOrId
          : (typeof (frame as { token?: unknown }).token === 'string'
            ? String((frame as { token: string }).token)
            : (typeof (frame as { id?: unknown }).id === 'string'
              ? String((frame as { id: string }).id)
              : ''))
        const cancelled = store.cancelInvite(tokenOrId)
        if (!cancelled.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: cancelled.reason })
          return
        }
        reply(ws, { type: 'invite_revoke_ok', frameId, id: cancelled.id })
        return
      }
      case 'invite_redeem': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!takeInviteToken(`redeem:${connIp}`)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        // TCC-R1152-BRG-002: single-flight redeem per socket.
        if (socketRedeemInFlight.has(ws)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Redeem already in progress on this connection' })
          return
        }
        const token = typeof frame.token === 'string' ? frame.token : ''
        const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId : ''
        const redeemGen = bumpSocketAuthGeneration(ws)
        socketRedeemInFlight.add(ws)
        void store.redeemInvite({
          token,
          deviceId,
          memberEmail: typeof frame.memberEmail === 'string' ? frame.memberEmail : undefined,
          displayName: typeof frame.displayName === 'string' ? frame.displayName : undefined,
        }).then((redeemed) => {
          socketRedeemInFlight.delete(ws)
          // TCC-R1153-BRG-001: after await, refuse live.bind if socket gone / gen drifted.
          if (ws.readyState !== ws.OPEN || currentSocketAuthGeneration(ws) !== redeemGen) {
            return
          }
          if (!redeemed.ok) {
            reply(ws, { type: 'error', requestId: frameId, message: redeemed.reason })
            return
          }
          // TS-BRG-037: drop other live sockets for this member (rotated sessions).
          for (const [peerWs, peer] of live) {
            if (peer.memberId === redeemed.member.memberId && peerWs !== ws) {
              quietDropLiveSession(peerWs)
              try { peerWs.close(4001, 'session rotated') } catch { /* */ }
            }
          }
          const team = store.ensureTeam()
          bindLiveSession(ws, {
            memberId: redeemed.member.memberId,
            deviceId,
            role: redeemed.member.role,
            displayName: redeemed.member.displayName,
            sessionToken: redeemed.sessionToken,
          })
          schedulePresenceFanoutBroadcast()
          const ok = reply(ws, {
            type: 'invite_redeem_ok',
            frameId,
            sessionToken: redeemed.sessionToken,
            memberId: redeemed.member.memberId,
            role: redeemed.member.role,
            teamId: team.teamId,
            teamName: typeof team.name === 'string' && team.name.trim()
              ? team.name.trim().slice(0, 200)
              : 'Team Space',
          })
          if (!ok || currentSocketAuthGeneration(ws) !== redeemGen) {
            quietDropLiveSession(ws)
            forceCloseBackpressured(ws, 'invite_redeem_ok undelivered')
            return
          }
          pushPresenceSnapshot(ws)
          startCatchUpOps(ws, deviceId)
        }).catch((err) => {
          socketRedeemInFlight.delete(ws)
          if (ws.readyState !== ws.OPEN || currentSocketAuthGeneration(ws) !== redeemGen) return
          reply(ws, {
            type: 'error',
            requestId: frameId,
            message: err instanceof Error ? err.message.slice(0, 200) : 'Redeem failed',
          })
        })
        return
      }
      case 'set_team_name': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeAdminMutateToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const rawName = typeof frame.name === 'string' ? frame.name : ''
        const team = store.setTeamName(rawName)
        reply(ws, {
          type: 'set_team_name_ok',
          frameId,
          teamId: team.teamId,
          teamName: team.name,
        })
        // TCC-R1152-BRG-003: peers need live team name without reconnect.
        const peerFrame: BridgeFrame = {
          type: 'team_name_peer',
          teamId: team.teamId,
          teamName: team.name,
        }
        for (const [peerWs] of live) {
          if (peerWs === ws) continue
          if (peerWs.readyState !== 1) continue
          reply(peerWs, peerFrame)
        }
        return
      }
      case 'kick_member': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeAdminMutateToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const targetId = typeof frame.memberId === 'string' ? frame.memberId.slice(0, 128) : ''
        const kicked = store.kickMember(session.memberId, targetId)
        if (!kicked.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: kicked.reason })
          return
        }
        // TS-P6-006: retain team-server backups under backups/members/<id>.
        // Admins download or DELETE /v1/backups/members/:id after offboarding.
        handleMemberLeaveChat(targetId)
        // TCC-R1151-BRG-001: dropLive BEFORE close so mid-close frames cannot auth.
        for (const [peerWs, peer] of [...live]) {
          if (peer.memberId === targetId) {
            dropLiveSession(peerWs)
            try { peerWs.close(4003, 'kicked') } catch { /* */ }
          }
        }
        reply(ws, { type: 'kick_ok', frameId, memberId: targetId })
        return
      }
      case 'leave_team': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated - send hello first' })
          return
        }
        if (!takeAdminMutateToken(session.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const left = store.leaveTeam(session.memberId)
        if (!left.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: left.reason })
          return
        }
        handleMemberLeaveChat(session.memberId)
        // Desktop tears down after leave_team_ok (do not close as kick 4003 - wrong copy).
        reply(ws, { type: 'leave_team_ok', frameId, memberId: session.memberId })
        // TCC-R1126-BRG-001 + TCC-R1151-BRG-001: sync-drop then close every socket.
        for (const [peerWs, peer] of [...live]) {
          if (peer.memberId === session.memberId) {
            dropLiveSession(peerWs)
            try { peerWs.close(4005, 'left team') } catch { /* */ }
          }
        }
        return
      }
      case 'list_members': {
        // TCC-R1147-LIM-001 / TCC-R1148-LIM-002: member-readable directory for
        // chat people pickers + @-mentions (Admin kick/role stay Admin-only).
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated' })
          return
        }
        // TCC-R1150-BRG-004: roster paging must not starve invite mint budget.
        if (!takeRosterToken(session.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        // TS-MEM-001: page with total/has_more - never silently ship an uncapped roster.
        const page = store.listMembersPage({
          limit: frame.limit,
          offset: frame.offset,
        })
        reply(ws, {
          type: 'list_members_ok',
          frameId,
          members: page.members.map((m) => ({
            memberId: m.memberId,
            email: m.email,
            displayName: m.displayName,
            role: m.role,
            // TCC-R1125-SHR-002: stable invite id (not the join token) so the
            // host can resolve a token-only access-template invite intent.
            joinedViaInviteId: m.joinedViaInviteId ?? null,
            // TS-CHAT-097: directory must carry the blob sha so a peer who
            // never received chat_history still paints the photo.
            avatarRef: isTeamChatAvatarBlobSha(m.avatarRef)
              ? String(m.avatarRef).toLowerCase()
              : null,
            avatarRev:
              typeof m.avatarRev === 'number' && Number.isFinite(m.avatarRev) && m.avatarRev > 0
                ? Math.floor(m.avatarRev)
                : 0,
          })),
          total: page.total,
          limit: page.limit,
          offset: page.offset,
          has_more: page.has_more,
          truncated: page.truncated,
        })
        return
      }
      case 'revoke_session': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeAdminMutateToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const targetId = typeof frame.memberId === 'string' ? frame.memberId.slice(0, 128) : ''
        const deviceId = typeof frame.deviceId === 'string' ? frame.deviceId.slice(0, 128) : undefined
        const revoked = store.revokeSession({
          actorMemberId: session.memberId,
          targetMemberId: targetId,
          deviceId,
        })
        if (!revoked.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: revoked.reason })
          return
        }
        for (const [peerWs, peer] of [...live]) {
          if (peer.memberId === targetId && (!deviceId || peer.deviceId === deviceId)) {
            dropLiveSession(peerWs)
            try { peerWs.close(4004, 'session revoked') } catch { /* */ }
          }
        }
        reply(ws, {
          type: 'revoke_ok',
          frameId,
          memberId: targetId,
          revokedDeviceIds: revoked.revokedDeviceIds,
        })
        return
      }
      case 'set_role': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeAdminMutateToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const targetId = typeof frame.memberId === 'string' ? frame.memberId.slice(0, 128) : ''
        const role = frame.role === 'viewer' || frame.role === 'member' || frame.role === 'admin'
          ? frame.role
          : null
        if (!role) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Invalid role' })
          return
        }
        const set = store.setMemberRole({
          actorMemberId: session.memberId,
          targetMemberId: targetId,
          role,
        })
        if (!set.ok) {
          reply(ws, { type: 'error', requestId: frameId, message: set.reason })
          return
        }
        for (const peer of live.values()) {
          if (peer.memberId === targetId) peer.role = set.role
        }
        reply(ws, { type: 'set_role_ok', frameId, memberId: targetId, role: set.role })
        // TS-ROLE-001: target devices must stamp settings role without waiting for hello.
        // Skip the actor socket (they get set_role_ok); fanout other live sockets for that member.
        const rolePeer: BridgeFrame = {
          type: 'role_peer',
          memberId: targetId,
          role: set.role,
        }
        for (const [peerWs, peer] of live.entries()) {
          if (peer.memberId !== targetId) continue
          if (peerWs === ws) continue
          if (peerWs.readyState !== 1) continue
          reply(peerWs, rolePeer)
        }
        return
      }
      case 'invite_list': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!requireAdmin(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Admin only' })
          return
        }
        if (!takeInviteToken(session!.memberId)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        const invites = store.listInvites().map((i) => ({
          id: i.id,
          token: i.token,
          email: i.email,
          role: i.role,
          createdAt: i.createdAt,
          expiresAt: i.expiresAt,
        }))
        reply(ws, { type: 'invite_list_ok', frameId, invites })
        return
      }
      case 'ops': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        handleOps(ws, session, frameId, frame.ops)
        return
      }
      case 'ack_ops': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated' })
          return
        }
        // TCC-R1148-BRG-002: ack_ops is not free - share dedicated + ops budgets.
        if (!takeAckOpsToken(session) || !takeOpsToken(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - slow down' })
          return
        }
        // TS-BRG-047: use ACK_IDS_PER_CALL (not a hardcoded 500) so desktop
        // 2000-id chunks are not silently truncated (catch-up would re-fan forever).
        const opIds = Array.isArray(frame.opIds)
          ? frame.opIds.filter((x): x is string => typeof x === 'string').slice(0, ACK_IDS_PER_CALL)
          : []
        store.markAcked(session.deviceId, opIds)
        reply(ws, { type: 'ack_ops_ok', frameId })
        return
      }
      case 'snapshot_request': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        // Snapshots are desktop-driven (Admin pushes share); bridge parks for now.
        reply(ws, {
          type: 'snapshot_refuse',
          frameId,
          reason: 'Share a module from the Admin app - bridge snapshot relay lands with the next update',
        })
        return
      }
      case 'ping': {
        const t = typeof frame.t === 'number' && Number.isFinite(frame.t) ? frame.t : Date.now()
        if (session) session.lastSeen = Date.now()
        reply(ws, { type: 'pong', t })
        return
      }
      case 'yjs_join': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        // TCC-R1153-BRG-004: join/leave need a rate token (not only update/awareness).
        if (!takeYjsJoinToken(session.memberId)) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        session.lastSeen = Date.now()
        const parsed = parseYjsRoomId(frame.room)
        if (!parsed.ok) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: parsed.reason })
          return
        }
        // TCC-R1125-WS-001: bridge-side twin of the desktop-only
        // `isYjsRoomAllowedByFlags` gate. Doc/Whiteboard and Compose live
        // co-edit are experimental and default OFF - the client only
        // refuses to SEND yjs_join for a disabled surface locally, but the
        // bridge previously joined ANY authenticated socket to ANY yjs:*
        // room regardless, so a stale build, a tampered client, or a raw WS
        // client speaking the protocol directly could still join. Refuse
        // fail-closed here unless the self-hoster explicitly turned the
        // matching surface on server-wide (env flags, off by default).
        const roomEnabled = isYjsComposeRecordId(parsed.recordId)
          ? TEAMSPACE_YJS_COMPOSE_ENABLED
          : TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED
        if (!roomEnabled) {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            room: parsed.room,
            reason: 'This live co-edit surface is not enabled on this server',
          })
          return
        }
        // TCC-FIX-CMP-001: feature-flag above is server-wide only - it does
        // NOT prove this member was granted access to THIS compose document.
        // Bridge twin of the desktop-only `isComposeSharedInTeamSpace` gate
        // (`teamspace:yjs:join`, TCC-R1148-CMP-003) so a raw WS client that
        // skips the desktop IPC call cannot join a board it was never shared.
        // Admin always allowed (host owns sharing); Doc/Whiteboard rooms are
        // unaffected (recordId is a real CRM record, not the compose sentinel).
        if (isYjsComposeRecordId(parsed.recordId) && session.role !== 'admin') {
          if (!isComposeDocSharedWithTeam(parsed.contentField)) {
            reply(ws, {
              type: 'yjs_refuse',
              frameId,
              room: parsed.room,
              reason: 'This board is not shared with the team',
            })
            return
          }
        }
        const joined = joinYjsRoom(ws, parsed.room)
        if (!joined.ok) {
          reply(ws, { type: 'yjs_refuse', frameId, room: parsed.room, reason: joined.reason })
          return
        }
        reply(ws, { type: 'yjs_ok', frameId, room: parsed.room, action: 'join' })
        return
      }
      case 'yjs_leave': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        if (!takeYjsJoinToken(session.memberId)) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        session.lastSeen = Date.now()
        const parsed = parseYjsRoomId(frame.room)
        if (!parsed.ok) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: parsed.reason })
          return
        }
        leaveYjsRoom(ws, parsed.room)
        reply(ws, { type: 'yjs_ok', frameId, room: parsed.room, action: 'leave' })
        return
      }
      case 'yjs_update': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        // Viewer read-only Y: refuse content updates; awareness stays allowed below.
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            reason: 'Viewers cannot edit shared documents',
          })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1134-BRGLIM-001: yjs_update fans out to every peer in the room
        // on every message - throttle before any further work.
        if (!takeYjsUpdateToken(session.memberId)) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        const parsed = parseYjsRoomId(frame.room)
        if (!parsed.ok) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: parsed.reason })
          return
        }
        if (!isYjsUpdateB64(frame.updateB64)) {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            room: parsed.room,
            reason: 'Invalid or oversized update',
          })
          return
        }
        const mine = yjsSocketRooms.get(ws)
        if (!mine || !mine.has(parsed.room)) {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            room: parsed.room,
            reason: 'Join the document room before sending updates',
          })
          return
        }
        fanoutYjsUpdate(ws, parsed.room, frame.updateB64, session)
        reply(ws, { type: 'yjs_ok', frameId, room: parsed.room, action: 'update' })
        return
      }
      case 'yjs_awareness': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        // Viewers may relay read-awareness (cursors); write binding stays desktop ACL.
        session.lastSeen = Date.now()
        // TCC-R1134-BRGLIM-001: yjs_awareness fans out to every peer in the room
        // on every message - throttle before any further work.
        if (!takeYjsAwarenessToken(session.memberId)) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        const parsed = parseYjsRoomId(frame.room)
        if (!parsed.ok) {
          reply(ws, { type: 'yjs_refuse', frameId, reason: parsed.reason })
          return
        }
        if (!isYjsUpdateB64(frame.updateB64)) {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            room: parsed.room,
            reason: 'Invalid or oversized awareness update',
          })
          return
        }
        const mine = yjsSocketRooms.get(ws)
        if (!mine || !mine.has(parsed.room)) {
          reply(ws, {
            type: 'yjs_refuse',
            frameId,
            room: parsed.room,
            reason: 'Join the document room before sending awareness',
          })
          return
        }
        fanoutYjsAwareness(ws, parsed.room, frame.updateB64, session)
        reply(ws, { type: 'yjs_ok', frameId, room: parsed.room, action: 'update' })
        return
      }
      case 'presence_get': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1148-LIM-004: presence snapshots are not free - share ops budget.
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Rate limited - try again shortly' })
          return
        }
        pushPresenceSnapshot(ws, frameId)
        return
      }
      case 'chat_send': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Viewers can read team chat but cannot post',
          })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeChatSendToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Chat send rate limited - try again shortly' })
          return
        }
        const roomRaw = typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM
        const roomParsed = parseChatRoomId(roomRaw)
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        {
          const roomRow = chatRooms.get(roomParsed.room)
          if (roomRow?.closedAt) {
            reply(ws, {
              type: 'chat_refuse',
              frameId,
              room: roomParsed.room,
              reason: 'This chat is closed',
            })
            return
          }
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        const bodyRaw = scrubChatBody(frame.body)
        const clientMsgId =
          typeof frame.clientMsgId === 'string'
            ? frame.clientMsgId.replace(/\0/g, '').trim().slice(0, 128)
            : undefined
        const replyToId =
          typeof frame.replyToId === 'string'
            ? frame.replyToId.replace(/\0/g, '').trim().slice(0, 128) || undefined
            : undefined
        const attachments: Array<{
          blobId: string
          name?: string
          bytes?: number
          mime?: string
          durationSec?: number
        }> = []
        if (Array.isArray(frame.attachments)) {
          for (const row of frame.attachments.slice(0, 10)) {
            if (!row || typeof row !== 'object') continue
            const o = row as Record<string, unknown>
            const blobId =
              typeof o.blobId === 'string'
                ? o.blobId.replace(/\0/g, '').trim().toLowerCase().slice(0, 64)
                : ''
            if (!/^[a-f0-9]{64}$/.test(blobId)) continue
            const reg = chatBlobs.get(blobId)
            // TCC-R1146-MEDIA-003: content-addressed sha may be granted to
            // multiple rooms (roomId + roomIds).
            if (!reg || !chatBlobRoomIds(reg).includes(roomParsed.room)) {
              reply(ws, {
                type: 'chat_refuse',
                frameId,
                room: roomParsed.room,
                reason: 'Attachment is missing or not for this room',
              })
              return
            }
            // TCC-R1143-MEDIA-007 / TCC-R1150-LIM-001 / TCC-R1151-LIM-002:
            // client-measured voice duration (bridge does not decode audio).
            // Voice MIME requires a finite duration within the Admin cap
            // (hard ceiling 1800); out-of-range / missing refuses the send.
            const rawDur = o.durationSec ?? o.duration_sec
            const durN =
              typeof rawDur === 'number' && Number.isFinite(rawDur)
                ? Math.floor(rawDur)
                : NaN
            const mimeLower = typeof reg.mime === 'string' ? reg.mime.toLowerCase() : ''
            const isVoiceAttach =
              mimeLower.startsWith('audio/')
              || /\.(webm|ogg|m4a|mp3|wav|aac)$/i.test(reg.name || '')
            const voiceMax = limitsStore.getMeta().voiceMessageMaxSec
            const voiceCap =
              typeof voiceMax === 'number' && Number.isFinite(voiceMax) && voiceMax >= 1
                ? Math.min(1800, Math.floor(voiceMax))
                : 1800
            if (isVoiceAttach) {
              if (!(durN >= 1 && durN <= voiceCap)) {
                reply(ws, {
                  type: 'chat_refuse',
                  frameId,
                  room: roomParsed.room,
                  reason:
                    durN > voiceCap
                      ? `Voice messages can be at most ${voiceCap} seconds`
                      : 'Voice messages need a valid duration',
                })
                return
              }
              attachments.push({
                blobId,
                name: reg.name,
                bytes: reg.bytes,
                mime: reg.mime,
                durationSec: durN,
              })
            } else {
              const durationSec =
                durN >= 1 && durN <= 1800 ? durN : undefined
              attachments.push({
                blobId,
                name: reg.name,
                bytes: reg.bytes,
                mime: reg.mime,
                ...(durationSec !== undefined ? { durationSec } : {}),
              })
            }
          }
        }
        // TCC-R1154-MEDIA-003: plain-English fallback for attach/voice-only
        // (never wire parenthetical `(attachment)` into peers / notify / history).
        let attachFallback = ''
        if (!bodyRaw && attachments.length > 0) {
          const only = attachments.length === 1 ? attachments[0] : null
          const mimeLower = typeof only?.mime === 'string' ? only.mime.toLowerCase() : ''
          const voiceOnly = !!only && (
            (typeof only.durationSec === 'number' && only.durationSec >= 1)
            || mimeLower.startsWith('audio/')
            || /\.(webm|ogg|m4a|mp3|wav|aac|opus)$/i.test(only.name || '')
          )
          attachFallback = voiceOnly ? 'Voice message' : 'Attachment'
        }
        const body = bodyRaw || attachFallback
        if (!body) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'Message is empty or too long',
          })
          return
        }
        // TCC-R1133-CHAT-001: append is now serialized per-room (queueRoomWrite)
        // against concurrent appends/prune - it returns a Promise.
        void chatStore.append({
          room: roomParsed.room,
          body,
          memberId: session.memberId,
          memberName: session.displayName || 'Member',
          role: session.role,
          kind: 'user',
          id: clientMsgId || undefined,
          replyToId,
          attachments: attachments.length ? attachments : undefined,
        }).then((appended) => {
          // TCC-R1151-BRG-002: re-check roster + live after await (kick mid-queue).
          if (!sessionStillAuthorized(ws, session)) {
            return
          }
          if ('error' in appended) {
            reply(ws, {
              type: 'chat_refuse',
              frameId,
              room: roomParsed.room,
              reason: appended.error,
            })
            return
          }
          // TCC-R1152-CHAT-001: echo clientMsgId when the client minted the id
          // so desktop can replace pending-${id} optimistic bubbles on drain.
          const message = payloadForChatRow(appended, {
            clientMsgId: clientMsgId || appended.id,
          })
          reply(ws, { type: 'chat_ok', frameId, message })
          fanoutChatPeer(ws, appended)

          // Optional /task only in the team room.
          const taskCmd = parseChatTaskCommand(body)
          if (taskCmd && roomParsed.room === CHAT_ROOM_TEAM) {
            if (!taskCmd.title) {
              // Already posted the chat line; tell sender why no task ran.
              reply(ws, {
                type: 'task_ack',
                frameId: `${frameId}:task`,
                ok: false,
                reason: 'Add a short title after /task (for example /task Fix onboarding copy)',
              })
            } else {
              const delivered = fanoutToAdmins(ws, {
                type: 'task_request',
                frameId: `${frameId}:task`,
                title: capChatText(taskCmd.title, CHAT_TITLE_MAX),
                body,
                chatMessageId: message.id,
                fromMemberId: session.memberId,
                fromMemberName: session.displayName || 'Member',
              })
              if (delivered === 0) {
                reply(ws, {
                  type: 'task_ack',
                  frameId: `${frameId}:task`,
                  ok: false,
                  reason: 'No Admin is connected to create tasks right now',
                })
              }
            }
          }
        }).catch(() => {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'Failed to send message',
          })
        })
        return
      }
      case 'chat_history': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatHistoryToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Chat history rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(
          typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM,
        )
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1149-CHAT-009: team Admin may read/export closed rooms.
        if (!chatRoomReadable(roomParsed.room, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        const limit =
          typeof frame.limit === 'number' && Number.isFinite(frame.limit)
            ? frame.limit
            : CHAT_HISTORY_LIMIT_DEFAULT
        const before =
          typeof frame.before === 'number' && Number.isFinite(frame.before)
            ? frame.before
            : undefined
        const beforeId =
          typeof frame.beforeId === 'string'
            ? frame.beforeId.replace(/\0/g, '').trim().slice(0, 128)
            : undefined
        void chatStore.readRecent(roomParsed.room, limit, before, beforeId).then((res) => {
          // Meta pins are authoritative (jsonl may retain stale pinned:true from prior pins).
          const pinIds = chatStore.getPinnedMessageIds(roomParsed.room)
          if (!live.has(ws)) return
          reply(ws, {
            type: 'chat_history_ok',
            frameId,
            room: roomParsed.room,
            messages: res.messages.map((m) => {
              const p = payloadForChatRow(m)
              return { ...p, pinned: pinIds.includes(p.id) }
            }),
            truncated: res.truncated,
            /** Every pin in the room, oldest first, even ones outside this page. */
            pinnedMessageIds: pinIds,
            // TCC-R1134-CHAT2-003: a pin can predate this page (an old
            // message pinned long ago, or a fresh room re-open landing on
            // the newest page while the pin is further back) - without this,
            // no row in `messages` above ever carries `pinned:true` and the
            // client's pinned list silently shows nothing even though a
            // message IS pinned. Always echo the pins so the client can
            // fetch-and-splice them via chat_jump when absent from the page.
            // The single id stays for clients built before multi-pin.
            pinnedMessageId: pinIds.length ? pinIds[pinIds.length - 1] : null,
          })
        }).catch(() => {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'Could not load chat history',
          })
        })
        return
      }
      /**
       * Temporary chat (never-persisted 1:1 DM). Room state + message bodies
       * for every ephemeral_* frame live ONLY in the in-memory maps declared
       * near `live`/`yjsRooms` above - nothing here ever touches chatStore,
       * chatRooms, or any file. See ephemeral-chat.ts for the shared pure
       * validation/state-machine helpers (mirrored on desktop for tests).
       */
      case 'ephemeral_start': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Viewers cannot start a temporary chat' })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralStartToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const targetMemberId =
          typeof frame.targetMemberId === 'string'
            ? frame.targetMemberId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        if (!targetMemberId || targetMemberId === session.memberId) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Choose someone else to start a temporary chat with' })
          return
        }
        const room = ephemeralRoomId(session.memberId, targetMemberId)
        if (!room) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Invalid temporary chat target' })
          return
        }
        if (ephemeralRooms.has(room)) {
          reply(ws, {
            type: 'ephemeral_refuse',
            frameId,
            room,
            reason: 'You already have a temporary chat open with this person',
          })
          return
        }
        // TS-EPH-PERF-003: use the reverse index, never an O(all sockets) scan
        // of `live` - this runs on every 1:1 temporary chat start.
        if (!firstLiveSessionForMember(targetMemberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That person is not currently online' })
          return
        }
        if ((ephemeralRoomsByMember.get(session.memberId)?.size || 0) >= EPHEMERAL_ROOMS_PER_MEMBER_MAX) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'You have too many temporary chats open at once' })
          return
        }
        if (ephemeralRooms.size >= EPHEMERAL_ROOMS_TOTAL_MAX) {
          reply(ws, {
            type: 'ephemeral_refuse',
            frameId,
            reason: 'Bridge is at capacity for temporary chats right now - try again later',
          })
          return
        }
        const pendingForSender = ephemeralPendingInvitesByMember.get(session.memberId)
        if (pendingForSender && pendingForSender.size >= EPHEMERAL_PENDING_INVITES_PER_MEMBER_MAX) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'You have too many pending temporary chat invites' })
          return
        }
        const inviteId = mintToken(16)
        const closeTimeoutMs = resolveEphemeralCloseTimeoutMs(frame.closeTimeoutMs, {
          floorMs: EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR,
          ceilingMs: EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING,
          defaultMs: EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT,
        })
        const expiresAt = Date.now() + EPHEMERAL_INVITE_TTL_MS
        const timer = setTimeout(() => expireEphemeralInvite(inviteId), EPHEMERAL_INVITE_TTL_MS)
        timer.unref?.()
        const sent = sendToLiveMember(targetMemberId, {
          type: 'ephemeral_invite',
          inviteId,
          room,
          fromMemberId: session.memberId,
          fromMemberName: session.displayName || 'Member',
          expiresAt,
        })
        if (!sent) {
          // Went offline between the live-check above and the send attempt - fail closed, no dangling invite.
          try { clearTimeout(timer) } catch { /* */ }
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That person is not currently online' })
          return
        }
        ephemeralInvites.set(inviteId, {
          inviteId,
          room,
          fromMemberId: session.memberId,
          toMemberId: targetMemberId,
          closeTimeoutMs,
          expiresAt,
          timer,
        })
        let pendingSet = ephemeralPendingInvitesByMember.get(session.memberId)
        if (!pendingSet) {
          pendingSet = new Set()
          ephemeralPendingInvitesByMember.set(session.memberId, pendingSet)
        }
        pendingSet.add(inviteId)
        reply(ws, { type: 'ephemeral_start_ok', frameId, inviteId, targetMemberId })
        return
      }
      case 'ephemeral_accept': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralStartToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const inviteId = typeof frame.inviteId === 'string' ? frame.inviteId.replace(/\0/g, '').trim() : ''
        const invite = isValidEphemeralInviteId(inviteId) ? ephemeralInvites.get(inviteId) : undefined
        if (!invite || invite.toMemberId !== session.memberId) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That invite is no longer available' })
          return
        }
        if (ephemeralRooms.has(invite.room)) {
          expireEphemeralInvite(inviteId)
          reply(ws, { type: 'ephemeral_refuse', frameId, room: invite.room, reason: 'This temporary chat already started' })
          return
        }
        expireEphemeralInvite(inviteId)
        const memberIds: string[] = [invite.fromMemberId, invite.toMemberId]
        const roomState: EphemeralRoomState = {
          memberIds,
          createdAt: Date.now(),
          closeRequestedBy: new Set(),
          closeTimeoutMs: invite.closeTimeoutMs,
          deadlineAt: null,
          timer: null,
          description: '',
          iconPreset: null,
        }
        ephemeralRooms.set(invite.room, roomState)
        addEphemeralRoomIndex(invite.room, memberIds)
        reply(ws, { type: 'ephemeral_accept_ok', frameId, room: invite.room })
        sendToLiveMember(invite.fromMemberId, {
          type: 'ephemeral_accepted',
          room: invite.room,
          byMemberId: session.memberId,
          byMemberName: session.displayName || 'Member',
        })
        return
      }
      case 'ephemeral_decline': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        const inviteId = typeof frame.inviteId === 'string' ? frame.inviteId.replace(/\0/g, '').trim() : ''
        const invite = isValidEphemeralInviteId(inviteId) ? ephemeralInvites.get(inviteId) : undefined
        if (!invite || invite.toMemberId !== session.memberId) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That invite is no longer available' })
          return
        }
        expireEphemeralInvite(inviteId)
        reply(ws, { type: 'ephemeral_decline_ok', frameId, inviteId })
        sendToLiveMember(invite.fromMemberId, {
          type: 'ephemeral_declined',
          inviteId,
          room: invite.room,
          byMemberId: session.memberId,
        })
        return
      }
      case 'ephemeral_group_start': {
        // Round-1157: mirrors ephemeral_start's shape but for 2+ targets.
        // Nothing is created in `ephemeralRooms` yet - only a transient
        // `EphemeralGroupFormation` that becomes a room once every invitee
        // accepts (see EphemeralGroupFormation doc-comment for the "all must
        // accept" design rationale: a partially-joined group chat where some
        // invitees can already read messages the still-deciding invitees
        // cannot is a confusing half-state and complicates the close
        // handshake's "everyone" semantics - so a formation is all-or-nothing).
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Viewers cannot start a temporary chat' })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralStartToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const validated = validateEphemeralGroupTargetMemberIds(
          session.memberId,
          frame.targetMemberIds,
          EPHEMERAL_GROUP_MEMBERS_MAX,
        )
        if (!validated.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: validated.reason })
          return
        }
        const targets = validated.targets
        if (ephemeralRooms.size >= EPHEMERAL_ROOMS_TOTAL_MAX) {
          reply(ws, {
            type: 'ephemeral_refuse',
            frameId,
            reason: 'Bridge is at capacity for temporary chats right now - try again later',
          })
          return
        }
        if ((ephemeralRoomsByMember.get(session.memberId)?.size || 0) >= EPHEMERAL_ROOMS_PER_MEMBER_MAX) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'You have too many temporary chats open at once' })
          return
        }
        const pendingFormations = ephemeralGroupFormationsByInitiator.get(session.memberId)
        if (pendingFormations && pendingFormations.size >= EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'You have too many pending temporary group chat invites' })
          return
        }
        // Every target must be reachable up front - fail closed with no
        // partial invites rather than forming a group some invitees never saw.
        const memberNames = new Map<string, string>()
        memberNames.set(session.memberId, session.displayName || 'Member')
        const notLiveCount = targets.reduce((count, targetId) => {
          const targetSession = firstLiveSessionForMember(targetId)
          if (!targetSession) return count + 1
          memberNames.set(targetId, targetSession.displayName || 'Member')
          return count
        }, 0)
        if (notLiveCount > 0) {
          reply(ws, {
            type: 'ephemeral_refuse',
            frameId,
            reason:
              notLiveCount === 1
                ? 'One of the people you invited is not currently online'
                : `${notLiveCount} of the people you invited are not currently online`,
          })
          return
        }
        const groupToken = mintToken(24)
        const room = ephemeralGroupRoomId(groupToken)
        if (!room) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Could not start temporary group chat' })
          return
        }
        const closeTimeoutMs = resolveEphemeralCloseTimeoutMs(frame.closeTimeoutMs, {
          floorMs: EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR,
          ceilingMs: EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING,
          defaultMs: EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT,
        })
        const allMemberIds = [session.memberId, ...targets]
        const expiresAt = Date.now() + EPHEMERAL_INVITE_TTL_MS
        const formationId = mintToken(16)
        const timer = setTimeout(() => cancelEphemeralGroupFormation(formationId, 'expired'), EPHEMERAL_INVITE_TTL_MS)
        timer.unref?.()
        const formation: EphemeralGroupFormation = {
          formationId,
          initiatorMemberId: session.memberId,
          initiatorName: session.displayName || 'Member',
          allMemberIds,
          acceptedMemberIds: new Set([session.memberId]),
          pendingMemberIds: new Set(targets),
          memberNames,
          room,
          closeTimeoutMs,
          createdAt: Date.now(),
          timer,
        }
        ephemeralGroupFormations.set(formationId, formation)
        let initSet = ephemeralGroupFormationsByInitiator.get(session.memberId)
        if (!initSet) {
          initSet = new Set()
          ephemeralGroupFormationsByInitiator.set(session.memberId, initSet)
        }
        initSet.add(formationId)
        for (const targetId of targets) {
          let inviteeSet = ephemeralGroupInviteesByMember.get(targetId)
          if (!inviteeSet) {
            inviteeSet = new Set()
            ephemeralGroupInviteesByMember.set(targetId, inviteeSet)
          }
          inviteeSet.add(formationId)
        }
        for (const targetId of targets) {
          sendToLiveMember(targetId, {
            type: 'ephemeral_group_invite',
            formationId,
            fromMemberId: session.memberId,
            fromMemberName: session.displayName || 'Member',
            otherMemberIds: allMemberIds.filter((id) => id !== targetId),
            otherMemberNames: allMemberIds.filter((id) => id !== targetId).map((id) => memberNames.get(id) || 'Member'),
            expiresAt,
          })
        }
        reply(ws, { type: 'ephemeral_group_start_ok', frameId, formationId, targetMemberIds: targets })
        return
      }
      case 'ephemeral_group_accept': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralStartToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const formationId = typeof frame.formationId === 'string' ? frame.formationId.replace(/\0/g, '').trim() : ''
        const formation = isValidEphemeralFormationId(formationId) ? ephemeralGroupFormations.get(formationId) : undefined
        if (!formation || !formation.pendingMemberIds.has(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That temporary group chat invite is no longer available' })
          return
        }
        formation.pendingMemberIds.delete(session.memberId)
        formation.acceptedMemberIds.add(session.memberId)
        const inviteeSet = ephemeralGroupInviteesByMember.get(session.memberId)
        if (inviteeSet) {
          inviteeSet.delete(formationId)
          if (inviteeSet.size === 0) ephemeralGroupInviteesByMember.delete(session.memberId)
        }
        reply(ws, { type: 'ephemeral_group_accept_ok', frameId, formationId })
        if (formation.pendingMemberIds.size > 0) {
          const progressFrame: BridgeFrame = {
            type: 'ephemeral_group_member_accepted',
            formationId,
            byMemberId: session.memberId,
            byMemberName: formation.memberNames.get(session.memberId) || 'Member',
            acceptedCount: formation.acceptedMemberIds.size,
            totalCount: formation.allMemberIds.length,
          }
          for (const id of formation.acceptedMemberIds) sendToLiveMember(id, progressFrame)
          return
        }
        // Last acceptance - re-verify ceilings right before minting the room
        // (they were checked at start time too, but capacity can have
        // shifted during the invite-accept window; fail closed, never form
        // an over-cap room).
        if (ephemeralRooms.size >= EPHEMERAL_ROOMS_TOTAL_MAX) {
          cancelEphemeralGroupFormation(formationId, 'refused')
          return
        }
        const overCeilingMemberId = formation.allMemberIds.find(
          (id) => (ephemeralRoomsByMember.get(id)?.size || 0) >= EPHEMERAL_ROOMS_PER_MEMBER_MAX,
        )
        if (overCeilingMemberId) {
          cancelEphemeralGroupFormation(formationId, 'refused')
          return
        }
        ephemeralGroupFormations.delete(formationId)
        const initSet = ephemeralGroupFormationsByInitiator.get(formation.initiatorMemberId)
        if (initSet) {
          initSet.delete(formationId)
          if (initSet.size === 0) ephemeralGroupFormationsByInitiator.delete(formation.initiatorMemberId)
        }
        try { clearTimeout(formation.timer) } catch { /* */ }
        const roomState: EphemeralRoomState = {
          memberIds: [...formation.allMemberIds],
          createdAt: Date.now(),
          closeRequestedBy: new Set(),
          closeTimeoutMs: formation.closeTimeoutMs,
          deadlineAt: null,
          timer: null,
          description: '',
          iconPreset: null,
        }
        ephemeralRooms.set(formation.room, roomState)
        addEphemeralRoomIndex(formation.room, roomState.memberIds)
        const formedFrame: BridgeFrame = {
          type: 'ephemeral_group_formed',
          formationId,
          room: formation.room,
          memberIds: [...formation.allMemberIds],
          members: formation.allMemberIds.map((id) => ({ memberId: id, displayName: formation.memberNames.get(id) || 'Member' })),
        }
        for (const id of formation.allMemberIds) sendToLiveMember(id, formedFrame)
        console.log(
          `[bridge] temporary group chat formed room=${formation.room.slice(0, 24)} members=${formation.allMemberIds.length}`,
        )
        return
      }
      case 'ephemeral_group_decline': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        const formationId = typeof frame.formationId === 'string' ? frame.formationId.replace(/\0/g, '').trim() : ''
        const formation = isValidEphemeralFormationId(formationId) ? ephemeralGroupFormations.get(formationId) : undefined
        if (!formation || !formation.pendingMemberIds.has(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'That temporary group chat invite is no longer available' })
          return
        }
        reply(ws, { type: 'ephemeral_group_decline_ok', frameId, formationId })
        cancelEphemeralGroupFormation(formationId, 'declined', session.memberId)
        return
      }
      case 'ephemeral_message': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Viewers cannot post in a temporary chat' })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralMessageToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Temporary chat send rate limited - try again shortly' })
          return
        }
        // Round-1157: accepts both 1:1 (`eph:a_b`) and group (`eph:g:<token>`) rooms.
        const roomParsed = parseAnyEphemeralRoomId(frame.room)
        if (!roomParsed.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const r = ephemeralRooms.get(roomParsed.room)
        if (!r || !r.memberIds.includes(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'This temporary chat is closed' })
          return
        }
        const body = scrubEphemeralBody(frame.body)
        if (!body) {
          reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'Message is empty or too long' })
          return
        }
        const clientMsgId =
          typeof frame.clientMsgId === 'string'
            ? frame.clientMsgId.replace(/\0/g, '').trim().slice(0, 128) || undefined
            : undefined
        // Reply-to-message parity: bounded/scrubbed only - the bridge never
        // stores message history so it cannot verify "this id belongs to
        // this room" by lookup. That guarantee comes from the receiving
        // client resolving replyToId ONLY against its own per-room buffer
        // (see scrubEphemeralReplyToId doc-comment) - never trust this
        // field for anything beyond opaque relay.
        const replyToId = scrubEphemeralReplyToId(frame.replyToId) || undefined
        const createdAt = Date.now()
        // NEVER log message.body - only room id prefix + byte length, matching
        // the redaction convention used elsewhere in this file. Fans out to
        // EVERY other current member (1 for a 1:1 room, up to N-1 for a group).
        const deliveredCount = sendToOtherLiveMembers(r.memberIds, session.memberId, {
          type: 'ephemeral_peer_message',
          room: roomParsed.room,
          body,
          fromMemberId: session.memberId,
          fromMemberName: session.displayName || 'Member',
          createdAt,
          clientMsgId,
          replyToId,
        })
        const otherMembersCount = r.memberIds.length - 1
        if (deliveredCount === 0 && otherMembersCount > 0) {
          reply(ws, {
            type: 'ephemeral_refuse',
            frameId,
            room: roomParsed.room,
            reason:
              otherMembersCount === 1
                ? 'The other person is not currently in this chat - message was not sent'
                : 'Nobody else is currently in this chat - message was not sent',
          })
          return
        }
        reply(ws, { type: 'ephemeral_message_ok', frameId, room: roomParsed.room, clientMsgId, createdAt })
        return
      }
      case 'ephemeral_set_info': {
        // P2 (extended to temporary chats): set/clear in-memory-only
        // description/preset icon. No owner concept in ephemeral rooms -
        // any current member may set these (symmetric peer model). Never
        // written to disk anywhere - lives only in EphemeralRoomState.
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Viewers cannot change a temporary chat' })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralInfoToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseAnyEphemeralRoomId(frame.room)
        if (!roomParsed.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const r = ephemeralRooms.get(roomParsed.room)
        if (!r || !r.memberIds.includes(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'This temporary chat is closed' })
          return
        }
        if (Object.prototype.hasOwnProperty.call(frame, 'description')) {
          const scrubbed = scrubEphemeralGroupDescription(frame.description)
          r.description = scrubbed ?? ''
        }
        if (Object.prototype.hasOwnProperty.call(frame, 'iconPreset')) {
          if (frame.iconPreset === null) {
            r.iconPreset = null
          } else if (isEphemeralGroupIconPreset(frame.iconPreset)) {
            r.iconPreset = frame.iconPreset
          } else {
            reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'Unknown icon preset' })
            return
          }
        }
        reply(ws, {
          type: 'ephemeral_set_info_ok',
          frameId,
          room: roomParsed.room,
          description: r.description,
          iconPreset: r.iconPreset,
        })
        sendToOtherLiveMembers(r.memberIds, session.memberId, {
          type: 'ephemeral_info_peer',
          room: roomParsed.room,
          description: r.description,
          iconPreset: r.iconPreset,
          fromMemberId: session.memberId,
        })
        return
      }
      case 'ephemeral_close_request': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralCloseToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseAnyEphemeralRoomId(frame.room)
        if (!roomParsed.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const r = ephemeralRooms.get(roomParsed.room)
        if (!r || !r.memberIds.includes(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'This temporary chat is already closed' })
          return
        }
        r.closeRequestedBy.add(session.memberId)
        reply(ws, { type: 'ephemeral_close_request_ok', frameId, room: roomParsed.room })
        sendToOtherLiveMembers(r.memberIds, session.memberId, {
          type: 'ephemeral_close_requested',
          room: roomParsed.room,
          byMemberId: session.memberId,
        })
        evaluateEphemeralRoomImmediate(roomParsed.room)
        return
      }
      case 'ephemeral_leave': {
        // Round-1157: immediate, unilateral departure from a still-multi-
        // person room - distinct from `ephemeral_close_request` above (which
        // needs mutual N-party confirmation to end the chat for EVERYONE).
        // Valid on a 1:1 room too (it degenerates to a full close, same as
        // requesting-then-timing-out, but immediate).
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Not authenticated - send hello first' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeOpsToken(session)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - slow down' })
          return
        }
        if (!takeEphemeralCloseToken(session.memberId)) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseAnyEphemeralRoomId(frame.room)
        if (!roomParsed.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const result = leaveEphemeralRoom(roomParsed.room, session.memberId)
        if (!result.ok) {
          reply(ws, { type: 'ephemeral_refuse', frameId, room: roomParsed.room, reason: 'This temporary chat is already closed' })
          return
        }
        reply(ws, { type: 'ephemeral_leave_ok', frameId, room: roomParsed.room })
        return
      }
      case 'chat_delete': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can remove chat messages',
          })
          return
        }
        // TCC-R1134-CHAT-040: was completely unrate-limited.
        if (!takeChatMutateToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const messageId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        if (!messageId) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'message id required' })
          return
        }
        // TCC-R1152-CHAT-008: prefer caller room hint so findById/softDelete
        // do not invent TEAM tombs on miss.
        const roomHintRaw = typeof frame.room === 'string' ? frame.room : ''
        const roomHintParsed = parseChatRoomId(roomHintRaw)
        const roomHint = roomHintParsed.ok ? roomHintParsed.room : undefined
        const pinnedIdsBeforeDelete = roomHint ? chatStore.getPinnedMessageIds(roomHint) : []
        void chatStore.softDelete(messageId, session.memberId, roomHint).then((del) => {
          if (!sessionStillAuthorized(ws, session)) return
          if ('error' in del) {
            reply(ws, { type: 'chat_refuse', frameId, reason: del.error })
            return
          }
          reply(ws, { type: 'chat_delete_ok', frameId, messageId })
          // TCC-R1151-CHAT-011: already-tombstoned idempotent ok - no re-fanout.
          // (Plain `'unchanged' in del` - not `&& del.unchanged === true` - so
          // TS narrows the `{ unchanged: true; tomb }` branch out of `del`
          // below; `unchanged` is always the literal `true` when present.)
          if ('unchanged' in del) {
            return
          }
          // TCC-R1143-CHAT-020: carry tombstoned createdAt/memberId so peers
          // can reverse inactive-room unread bumps without inventing meta.
          const delRoom = del.room || CHAT_ROOM_TEAM
          fanoutChatDeletePeer(ws, messageId, delRoom, {
            createdAt: typeof del.createdAt === 'number' ? del.createdAt : undefined,
            memberId: typeof del.memberId === 'string' ? del.memberId : undefined,
          })
          // TCC-R1152-CHAT-010: deleting a pinned message drops that one pin
          // (the store does it in the same write). Fan the room's remaining
          // pins so peers lose the dead row and keep the live ones.
          if (pinnedIdsBeforeDelete.includes(messageId)) {
            fanoutChatPinPeer(ws, delRoom, chatStore.getPinnedMessageIds(delRoom))
          }
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Failed to remove message' })
        })
        return
      }
      case 'chat_rooms_list': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1144-BRG-002: per-member rate + process-wide scan semaphore.
        if (!takeChatRoomsListToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const memberId = session.memberId
        const listed = chatRooms.listForMemberWithHonesty(memberId)
        const baseRooms = listed.rooms
        const roomsTruncated = listed.truncated === true
        // TCC-R1133-WS-001 (twin TCC-R1133-WIN-001): baseRooms can hold up
        // to CHAT_ROOMS_LIST_MAX (2000) visible rooms, and each iteration
        // below awaits chatStore.readRecent -> a full scanRoomFile (up to
        // MAX_LINES_SCAN lines + decrypt). Fanning that unbounded via
        // Promise.all let a reconnect/roster storm fire hundreds of full
        // file scans in one microtask burst, stalling the single-threaded
        // event loop for every other socket on the bridge. Bound it to
        // CHAT_ROOMS_LIST_SCAN_CONCURRENCY in-flight scans at a time.
        void roomsListProcessPool.run(() => mapWithConcurrency(baseRooms, CHAT_ROOMS_LIST_SCAN_CONCURRENCY, async (r) => {
            const mark = chatUnread.get(memberId, r.id)
            const wm =
              mark && typeof mark.lastReadAt === 'number' && Number.isFinite(mark.lastReadAt)
                ? mark.lastReadAt
                : 0
            let unread = 0
            let unreadTruncated = false
            let unreadError = false
            try {
              // TCC-R1148-CHAT-010: probe past the badge page so undercount is honest.
              const recent = await chatStore.readRecent(r.id, 51)
              for (const m of recent.messages) {
                if (m.kind === 'system') continue
                if (m.deletedAt) continue
                if (m.createdAt <= wm) continue
                if (m.memberId === memberId) continue
                unread += 1
              }
              if (unread > 50) {
                unread = 50
                unreadTruncated = true
              } else if (recent.truncated && unread >= 50) {
                unreadTruncated = true
              }
            } catch {
              // TCC-R1149-CHAT-010: never paint "caught up" on decrypt/IO failure.
              unread = 0
              unreadError = true
            }
            // TCC-R1147-CHAT-008 / TCC-R1154-CHAT-005: list must carry ACL +
            // reaction allowlist so desktop owner chrome / emoji gates heal
            // without waiting for a members_peer frame.
            return {
              id: r.id,
              kind: r.kind,
              title: r.title,
              memberIds: r.memberIds,
              createdAt: r.createdAt,
              unread,
              unreadTruncated,
              unreadError,
              ownerIds: [...r.ownerIds],
              bannedMemberIds: [...r.bannedMemberIds],
              allowedReactionEmojis: [...r.allowedReactionEmojis],
              // P2: group management panel fields ride the initial list load
              // (same convention as ownerIds above) so opening a room shows
              // description/icon/permissions without waiting on a peer push.
              description: r.description,
              iconKind: r.iconKind,
              iconRef: r.iconRef,
              iconRev: r.iconRev,
              permissions: { ...r.permissions },
            }
          },
        )).then((rooms) => {
          if (!live.has(ws)) return
          reply(ws, {
            type: 'chat_rooms_ok',
            frameId,
            rooms,
            truncated: roomsTruncated,
          })
        }).catch(() => {
          if (!live.has(ws)) return
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Could not list chat rooms',
          })
        })
        return
      }
      case 'chat_room_create': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot create chat rooms' })
          return
        }
        const kind = frame.kind
        if (kind === 'dm') {
          const target =
            typeof frame.targetMemberId === 'string'
              ? frame.targetMemberId.replace(/\0/g, '').trim().slice(0, 128)
              : ''
          if (!target) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'targetMemberId required for DM' })
            return
          }
          // TCC-R1146-CHAT-004: only live roster members may be DM targets.
          if (target === session.memberId) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Cannot start a direct message with yourself' })
            return
          }
          if (!store.findMember(target)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Member not found' })
            return
          }
          const created = chatRooms.getOrCreateDm(session.memberId, target)
          if ('error' in created) {
            reply(ws, { type: 'chat_refuse', frameId, reason: created.error })
            return
          }
          reply(ws, {
            type: 'chat_room_create_ok',
            frameId,
            room: roomPayload(created),
          })
          // TCC-R1147-CHAT-010: co-member needs members_peer (DM peer invent-row).
          fanoutChatRoomMembersPeer(ws, created.id)
          bumpChatMetric('roomCreates')
          return
        }
        if (kind !== 'group' && kind !== 'private') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Invalid room kind' })
          return
        }
        if (kind === 'private' && session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can create private rooms',
          })
          return
        }
        const memberIds = Array.isArray(frame.memberIds)
          ? frame.memberIds
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.replace(/\0/g, '').trim().slice(0, 128))
              .filter(Boolean)
          : []
        // TCC-R1146-CHAT-004: refuse phantom roster ids on group/private create.
        for (const mid of memberIds) {
          if (mid === session.memberId) continue
          if (!store.findMember(mid)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Member not found' })
            return
          }
        }
        const password =
          typeof frame.password === 'string' ? frame.password.slice(0, 128) : undefined
        const created = chatRooms.createGroup({
          kind,
          title: typeof frame.title === 'string' ? frame.title : '',
          createdBy: session.memberId,
          memberIds,
          password,
          description: typeof frame.description === 'string' ? frame.description : undefined,
        })
        if ('error' in created) {
          reply(ws, { type: 'chat_refuse', frameId, reason: created.error })
          return
        }
        reply(ws, {
          type: 'chat_room_create_ok',
          frameId,
          room: roomPayload(created),
        })
        // TCC-R1147-CHAT-010: stamped co-members need members_peer (not reply-only).
        fanoutChatRoomMembersPeer(ws, created.id)
        bumpChatMetric('roomCreates')
        return
      }
      case 'chat_room_join': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot join rooms' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Room not found' })
          return
        }
        const inviteToken =
          typeof frame.inviteToken === 'string'
            ? frame.inviteToken.replace(/\0/g, '').trim()
            : ''
        if (inviteToken) {
          const redeemed = chatRooms.redeemInvite(inviteToken, session.memberId)
          if ('error' in redeemed) {
            reply(ws, { type: 'chat_refuse', frameId, reason: redeemed.error })
            return
          }
          reply(ws, {
            type: 'chat_room_join_ok',
            frameId,
            room: roomPayload(redeemed),
          })
          // TCC-R1145-CHAT-012: peers must learn roster changes on invite join.
          fanoutChatRoomMembersPeer(ws, redeemed.id)
          return
        }
        if (row.kind === 'private' && row.passwordHash) {
          if (!takeChatPasswordJoinToken(session.memberId)) {
            reply(ws, {
              type: 'chat_refuse',
              frameId,
              reason: 'Too many password attempts - wait 15 minutes',
            })
            return
          }
          const pw = typeof frame.password === 'string' ? frame.password : ''
          if (!chatRooms.verifyPassword(roomParsed.room, pw)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Wrong room password' })
            return
          }
        }
        // TCC-R1145-CHAT-009: refuse DM self-admit before admitMember (store
        // also refuses; keep an early plain-English refuse at the wire).
        if (row.kind === 'dm' && !row.memberIds.includes(session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'You are not a participant in this direct message',
          })
          return
        }
        const admit = chatRooms.admitMember(roomParsed.room, session.memberId)
        if ('error' in admit) {
          reply(ws, { type: 'chat_refuse', frameId, reason: admit.error })
          return
        }
        reply(ws, {
          type: 'chat_room_join_ok',
          frameId,
          room: roomPayload(chatRooms.get(roomParsed.room) ?? row),
        })
        // TCC-R1145-CHAT-012: join must fan members_peer (reverse of leave).
        if (row.kind !== 'team' && row.kind !== 'dm') {
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      case 'chat_room_invite': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can mint private room invites',
          })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1150-CHAT-008: team Admin may mint without membership (roster parity).
        if (
          session.role !== 'admin'
          && !chatRooms.memberCanAccess(roomParsed.room, session.memberId)
        ) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this room' })
          return
        }
        const minted = chatRooms.mintInviteToken(roomParsed.room)
        if ('error' in minted) {
          reply(ws, { type: 'chat_refuse', frameId, reason: minted.error })
          return
        }
        reply(ws, {
          type: 'chat_room_invite_ok',
          frameId,
          room: roomParsed.room,
          inviteToken: minted.token,
        })
        return
      }
      case 'chat_room_leave': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot leave rooms' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (roomParsed.kind === 'team') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Cannot leave the team room' })
          return
        }
        const before = chatRooms.get(roomParsed.room)
        if (!before) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Room not found' })
          return
        }
        // TCC-R1146-CHAT-009 / TS-CHAT-011: voluntary DM leave must close the
        // room and fan close_peer to the survivor (same as team-depart).
        if (before.kind === 'dm') {
          const peers = before.memberIds.filter((id) => id !== session.memberId)
          const closed = chatRooms.closeRoom(roomParsed.room)
          if ('error' in closed) {
            reply(ws, { type: 'chat_refuse', frameId, reason: closed.error })
            return
          }
          // TCC-R1147-CHAT-012: wipe unread marks for the leaving member (DM path).
          chatUnread.wipeMemberRoom(session.memberId, roomParsed.room)
          fanoutChatRoomClosePeer(ws, roomParsed.room, peers)
          reply(ws, {
            type: 'chat_room_leave_ok',
            frameId,
            room: roomParsed.room,
          })
          return
        }
        const peersBeforeLeave = [...before.memberIds]
        const left = chatRooms.leave(roomParsed.room, session.memberId)
        if ('error' in left) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: left.error,
            ...(left.requiresOwnerAction ? { requiresOwnerAction: true as const } : {}),
          })
          return
        }
        chatUnread.wipeMemberRoom(session.memberId, roomParsed.room)
        reply(ws, {
          type: 'chat_room_leave_ok',
          frameId,
          room: roomParsed.room,
        })
        // TCC-R1146-CHAT-003: remaining members need members_peer (owner
        // back-fill included). Empty/closed rooms get close_peer instead.
        const after = chatRooms.get(roomParsed.room)
        if (after && typeof after.closedAt === 'number' && after.closedAt > 0) {
          fanoutChatRoomClosePeer(
            ws,
            roomParsed.room,
            peersBeforeLeave.filter((id) => id !== session.memberId),
          )
        } else {
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      /**
       * Owner/admin succession: explicit "end this group for everyone"
       * (the dissolve counterpart to `leave`'s new sole-owner block).
       * Group/private only, owner-or-team-Admin only, server-enforced via
       * the SAME `canManageRoom` chokepoint promote/demote already use.
       */
      case 'chat_room_dissolve': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (roomParsed.kind === 'team' || roomParsed.kind === 'dm') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Only a group or private room can be ended for everyone' })
          return
        }
        const dissolveRow = chatRooms.get(roomParsed.room)
        if (!dissolveRow || !canManageRoom(dissolveRow, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can end this group for everyone',
          })
          return
        }
        const peersBeforeDissolve = [...dissolveRow.memberIds]
        const dissolved = chatRooms.closeRoom(roomParsed.room)
        if ('error' in dissolved) {
          reply(ws, { type: 'chat_refuse', frameId, reason: dissolved.error })
          return
        }
        console.log(`[bridge] room ${roomParsed.room} dissolved by ${session.memberId} (${peersBeforeDissolve.length} members)`)
        for (const mid of peersBeforeDissolve) chatUnread.wipeMemberRoom(mid, roomParsed.room)
        reply(ws, { type: 'chat_room_dissolve_ok', frameId, room: roomParsed.room })
        fanoutChatRoomClosePeer(ws, roomParsed.room, peersBeforeDissolve.filter((id) => id !== session.memberId))
        return
      }
      case 'chat_room_password': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can reset a private room password',
          })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1150-CHAT-008: Admin already gated above - no membership require.
        const password =
          typeof frame.password === 'string' ? frame.password.slice(0, 128) : ''
        const set = chatRooms.setPassword(roomParsed.room, password)
        if ('error' in set) {
          reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
          return
        }
        reply(ws, {
          type: 'chat_room_password_ok',
          frameId,
          room: roomParsed.room,
        })
        return
      }
      case 'chat_room_add_members': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Viewers cannot add chat room members',
          })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1143-ROLE-001: team Admin may add without being in the room
        // (same override as ban/promote). Other roles still need membership.
        if (
          session.role !== 'admin'
          && !chatRooms.memberCanAccess(roomParsed.room, session.memberId)
        ) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this room' })
          return
        }
        // P2: apply the room's addMembers policy (default 'anyone' keeps
        // pre-P2 behavior unless an owner/Admin explicitly tightens it).
        const addGateRow = chatRooms.get(roomParsed.room)
        if (
          addGateRow
          && session.role !== 'admin'
          && !canAddRoomMembers(addGateRow, session.memberId, session.role)
        ) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can add members',
          })
          return
        }
        const memberIds = Array.isArray(frame.memberIds)
          ? frame.memberIds
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.replace(/\0/g, '').trim().slice(0, 128))
              .filter(Boolean)
          : []
        const added = chatRooms.addMembers(roomParsed.room, memberIds)
        if ('error' in added) {
          reply(ws, { type: 'chat_refuse', frameId, reason: added.error })
          return
        }
        reply(ws, {
          type: 'chat_room_add_members_ok',
          frameId,
          room: roomParsed.room,
          added: added.added,
          memberIds: added.memberIds,
        })
        // TCC-R1149-CHAT-011: no-op add (already members) must not amp members_peer.
        if (added.added.length > 0) {
          // TCC-R1143-ROLE-002: peers must learn roster changes (remove/ban already fan out).
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      case 'chat_room_remove_members': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Viewers cannot remove chat room members',
          })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1143-ROLE-001: team Admin remove must not require membership
        // (ban/promote already allow Admin override without memberCanAccess).
        if (
          session.role !== 'admin'
          && !chatRooms.memberCanAccess(roomParsed.room, session.memberId)
        ) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this room' })
          return
        }
        const manageRow = chatRooms.get(roomParsed.room)
        if (!manageRow || !canManageRoom(manageRow, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can remove members',
          })
          return
        }
        const memberIds = Array.isArray(frame.memberIds)
          ? frame.memberIds
              .filter((x): x is string => typeof x === 'string')
              .map((x) => x.replace(/\0/g, '').trim().slice(0, 128))
              .filter(Boolean)
          : []
        const removed = chatRooms.removeMembers(roomParsed.room, memberIds, session.memberId)
        if ('error' in removed) {
          reply(ws, { type: 'chat_refuse', frameId, reason: removed.error })
          return
        }
        reply(ws, {
          type: 'chat_room_remove_members_ok',
          frameId,
          room: roomParsed.room,
          removed: removed.removed,
          memberIds: removed.memberIds,
        })
        // TCC-R1149-CHAT-011: no-op remove (already absent) must not amp fanout.
        if (removed.removed.length > 0) {
          // TCC-R1147-CHAT-009: victims no longer pass memberCanAccess - notify
          // them explicitly + close-peer so their desktop drops the room.
          fanoutChatRoomMembersPeer(ws, roomParsed.room, {
            alsoNotifyMemberIds: removed.removed,
          })
          fanoutChatRoomClosePeer(ws, roomParsed.room, removed.removed)
          // TCC-R1147-CHAT-012: wipe unread marks for removed members.
          for (const mid of removed.removed) {
            chatUnread.wipeMemberRoom(mid, roomParsed.room)
          }
        }
        return
      }
      case 'chat_room_promote_owner': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row || !canManageRoom(row, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can promote owners',
          })
          return
        }
        const memberId =
          typeof frame.memberId === 'string'
            ? frame.memberId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        const promoted = chatRooms.promoteOwner(roomParsed.room, memberId)
        if ('error' in promoted) {
          reply(ws, { type: 'chat_refuse', frameId, reason: promoted.error })
          return
        }
        reply(ws, {
          type: 'chat_room_promote_owner_ok',
          frameId,
          room: roomParsed.room,
          ownerIds: promoted.ownerIds,
        })
        if (promoted.unchanged !== true) {
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      case 'chat_room_demote_owner': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row || !canManageRoom(row, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can demote owners',
          })
          return
        }
        const memberId =
          typeof frame.memberId === 'string'
            ? frame.memberId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        // TCC-R1148-CHAT-011: never allow sole-owner demote to empty ownerIds
        // (Admin must promote another owner first).
        const demoted = chatRooms.demoteOwner(roomParsed.room, memberId, {
          allowLastOwner: false,
        })
        if ('error' in demoted) {
          reply(ws, { type: 'chat_refuse', frameId, reason: demoted.error })
          return
        }
        reply(ws, {
          type: 'chat_room_demote_owner_ok',
          frameId,
          room: roomParsed.room,
          ownerIds: demoted.ownerIds,
        })
        if (demoted.unchanged !== true) {
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      case 'chat_room_ban_member': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row || !canManageRoom(row, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can ban members',
          })
          return
        }
        const memberId =
          typeof frame.memberId === 'string'
            ? frame.memberId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        const banned = chatRooms.banMember(roomParsed.room, memberId, session.memberId, {
          actorIsTeamAdmin: session.role === 'admin',
        })
        if ('error' in banned) {
          reply(ws, { type: 'chat_refuse', frameId, reason: banned.error })
          return
        }
        reply(ws, {
          type: 'chat_room_ban_member_ok',
          frameId,
          room: roomParsed.room,
          bannedMemberIds: banned.bannedMemberIds,
          memberIds: banned.memberIds,
        })
        // TCC-R1150-CHAT-010: no-op re-ban must not amp members_peer.
        if (banned.unchanged !== true) {
          // TCC-R1147-CHAT-009: banned member must learn they lost access.
          fanoutChatRoomMembersPeer(ws, roomParsed.room, {
            alsoNotifyMemberIds: memberId ? [memberId] : [],
          })
          if (memberId && banned.removed) {
            fanoutChatRoomClosePeer(ws, roomParsed.room, [memberId])
            chatUnread.wipeMemberRoom(memberId, roomParsed.room)
          }
        }
        return
      }
      case 'chat_room_unban_member': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row || !canManageRoom(row, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can unban members',
          })
          return
        }
        const memberId =
          typeof frame.memberId === 'string'
            ? frame.memberId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        const unbanned = chatRooms.unbanMember(roomParsed.room, memberId)
        if ('error' in unbanned) {
          reply(ws, { type: 'chat_refuse', frameId, reason: unbanned.error })
          return
        }
        reply(ws, {
          type: 'chat_room_unban_member_ok',
          frameId,
          room: roomParsed.room,
          bannedMemberIds: unbanned.bannedMemberIds,
        })
        if (unbanned.unchanged !== true) {
          fanoutChatRoomMembersPeer(ws, roomParsed.room)
        }
        return
      }
      case 'chat_room_set_reactions': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        const row = chatRooms.get(roomParsed.room)
        if (!row || !canManageRoom(row, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can change reaction settings',
          })
          return
        }
        const emojis = Array.isArray(frame.allowedReactionEmojis)
          ? frame.allowedReactionEmojis.filter((x): x is string => typeof x === 'string')
          : []
        const set = chatRooms.setAllowedReactionEmojis(roomParsed.room, emojis)
        if ('error' in set) {
          reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
          return
        }
        reply(ws, {
          type: 'chat_room_set_reactions_ok',
          frameId,
          room: roomParsed.room,
          allowedReactionEmojis: set.allowedReactionEmojis,
        })
        fanoutChatRoomMembersPeer(ws, roomParsed.room)
        return
      }
      case 'chat_room_rename': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Viewers cannot rename chat rooms',
          })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this room' })
          return
        }
        // P2: rename shares the SAME editInfo policy as description/icon
        // (spec groups them as one toggle) - default 'anyone' preserves the
        // exact pre-P2 behavior for rooms that never touch permissions.
        const renameGateRow = chatRooms.get(roomParsed.room)
        if (
          renameGateRow
          && session.role !== 'admin'
          && !canEditRoomInfo(renameGateRow, session.memberId, session.role)
        ) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can rename this room',
          })
          return
        }
        const title = typeof frame.title === 'string' ? frame.title : ''
        const renamed = chatRooms.setTitle(roomParsed.room, title)
        if ('error' in renamed) {
          reply(ws, { type: 'chat_refuse', frameId, reason: renamed.error })
          return
        }
        reply(ws, {
          type: 'chat_room_rename_ok',
          frameId,
          room: roomParsed.room,
          title: renamed.title,
        })
        // TCC-R1151-CHAT-009: identical title - reply ok, no rename_peer amp.
        if (renamed.unchanged !== true) {
          fanoutChatRoomRenamePeer(ws, roomParsed.room, renamed.title)
        }
        return
      }
      case 'chat_room_set_info': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot edit chat room info' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this room' })
          return
        }
        const infoGateRow = chatRooms.get(roomParsed.room)
        if (
          !infoGateRow
          || (session.role !== 'admin' && !canEditRoomInfo(infoGateRow, session.memberId, session.role))
        ) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: "Only a room owner or team Admin can edit this room's info",
          })
          return
        }
        const infoPatch: {
          description?: string
          iconKind?: 'none' | 'preset' | 'custom'
          iconRef?: string | null
          iconRev?: number
        } = {}
        let latestRow = infoGateRow
        if (Object.prototype.hasOwnProperty.call(frame, 'description')) {
          const raw = frame.description === null ? '' : frame.description
          const set = chatRooms.setDescription(roomParsed.room, typeof raw === 'string' ? raw : '')
          if ('error' in set) {
            reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
            return
          }
          if (set.unchanged !== true) infoPatch.description = set.description
        }
        if (
          Object.prototype.hasOwnProperty.call(frame, 'iconKind')
          || Object.prototype.hasOwnProperty.call(frame, 'iconRef')
        ) {
          const kind = frame.iconKind === 'preset' || frame.iconKind === 'custom' ? frame.iconKind : 'none'
          const ref = typeof frame.iconRef === 'string' ? frame.iconRef : null
          // TS-CHAT-012/013 pipeline reuse: a 'custom' ref must already be a
          // real uploaded blob in the SAME content-addressed avatar store
          // member avatars use - never accept an unproven sha as "custom".
          if (kind === 'custom') {
            const proof = chatAvatars.get(ref || '')
            if (!proof) {
              reply(ws, { type: 'chat_refuse', frameId, reason: 'Upload the image first' })
              return
            }
          }
          const set = chatRooms.setIcon(roomParsed.room, kind, kind === 'none' ? null : ref)
          if ('error' in set) {
            reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
            return
          }
          if (set.unchanged !== true) {
            infoPatch.iconKind = set.iconKind as 'none' | 'preset' | 'custom'
            infoPatch.iconRef = set.iconRef
            infoPatch.iconRev = set.iconRev
          }
        }
        latestRow = chatRooms.get(roomParsed.room) ?? infoGateRow
        reply(ws, {
          type: 'chat_room_set_info_ok',
          frameId,
          room: roomParsed.room,
          description: latestRow.description,
          iconKind: latestRow.iconKind,
          iconRef: latestRow.iconRef,
          iconRev: latestRow.iconRev,
        })
        if (Object.keys(infoPatch).length > 0) {
          fanoutChatRoomInfoPeer(ws, roomParsed.room, infoPatch)
        }
        return
      }
      case 'chat_room_set_permissions': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (!takeChatRoomAdminToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot edit chat room permissions' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // Deliberately NOT policy-gated by editInfo - changing the
        // permission policy itself is ALWAYS owner/admin only, regardless
        // of the current policy value (see setPermissions doc-comment).
        const permGateRow = chatRooms.get(roomParsed.room)
        if (!permGateRow || !canManageRoom(permGateRow, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only a room owner or team Admin can change permissions',
          })
          return
        }
        const addMembers =
          frame.addMembers === 'owner_admin' || frame.addMembers === 'anyone' ? frame.addMembers : undefined
        const editInfo =
          frame.editInfo === 'owner_admin' || frame.editInfo === 'anyone' ? frame.editInfo : undefined
        const pinMessages =
          frame.pinMessages === 'admin_only' || frame.pinMessages === 'anyone' ? frame.pinMessages : undefined
        if (addMembers === undefined && editInfo === undefined && pinMessages === undefined) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Nothing to update' })
          return
        }
        const set = chatRooms.setPermissions(roomParsed.room, { addMembers, editInfo, pinMessages })
        if ('error' in set) {
          reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
          return
        }
        reply(ws, {
          type: 'chat_room_set_permissions_ok',
          frameId,
          room: roomParsed.room,
          permissions: set.permissions,
        })
        fanoutChatRoomInfoPeer(ws, roomParsed.room, { permissions: set.permissions })
        return
      }
      case 'chat_unread_get': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        reply(ws, {
          type: 'chat_unread_ok',
          frameId,
          marks: chatUnread.getAllForMember(session.memberId),
        })
        return
      }
      case 'chat_unread_set': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1145-CHAT-010: durable write + room-wide fanout needs a budget.
        if (!takeChatUnreadToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        const lastReadAt =
          typeof frame.lastReadAt === 'number' && Number.isFinite(frame.lastReadAt)
            ? frame.lastReadAt
            : Date.now()
        const lastReadMsgId =
          typeof frame.lastReadMsgId === 'string'
            ? frame.lastReadMsgId.replace(/\0/g, '').trim().slice(0, 128)
            : null
        const set = chatUnread.set(session.memberId, roomParsed.room, {
          lastReadAt,
          lastReadMsgId,
        })
        if ('error' in set) {
          reply(ws, { type: 'chat_refuse', frameId, reason: set.error })
          return
        }
        reply(ws, { type: 'chat_unread_set_ok', frameId, room: roomParsed.room })
        // Skip fanout on monotonic rewind no-op (advanced:false).
        if (set.advanced) {
          fanoutChatSeenPeer(ws, roomParsed.room, session.memberId, lastReadAt, lastReadMsgId)
        }
        return
      }
      case 'chat_seen_get': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : '')
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        // TCC-R1143-RCPT-001: for group/DM/private rooms, only return watermarks
        // for current members (empty allowlist on team room = unrestricted).
        const roomRow = chatRooms.get(roomParsed.room)
        const memberAllow =
          roomRow && roomRow.kind !== 'team' && Array.isArray(roomRow.memberIds)
            ? roomRow.memberIds
            : null
        reply(ws, {
          type: 'chat_seen_ok',
          frameId,
          room: roomParsed.room,
          marks: chatUnread.getAllForRoom(roomParsed.room, memberAllow),
        })
        return
      }
      case 'chat_typing': {
        // TCC-R1148-LIM-001 / TCC-R1150-LIM-004: honor typing bool; refuse
        // rate-limited starts (never silent-drop); stops always fan out.
        if (!session) return
        session.lastSeen = Date.now()
        if (session.role === 'viewer') return
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM)
        if (!roomParsed.ok) return
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) return
        const typingOn = (frame as { typing?: unknown }).typing === true
        if (typingOn && !takeChatTypingToken(session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId: 'typing',
            room: roomParsed.room,
            reason: 'Typing rate limited - try again shortly',
          })
          return
        }
        fanoutChatTypingPeer(
          ws,
          roomParsed.room,
          session.memberId,
          session.displayName || 'Member',
          typingOn,
        )
        return
      }
      case 'chat_edit': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot edit messages' })
          return
        }
        if (!takeChatMutateToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Chat edit rate limited - try again shortly' })
          return
        }
        const messageId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        const body = scrubChatBody(frame.body)
        if (!messageId || !body) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'message id and body required' })
          return
        }
        // TCC-R1125-CHAT-001: the desktop client already sends the owning
        // room on this frame - use it as a disk-lookup hint so edit on a row
        // that fell out of the bridge's bounded `recentById` cache still
        // resolves instead of failing "Message not found".
        const roomHint = typeof frame.room === 'string' ? frame.room : undefined
        void chatStore.findById(messageId, roomHint).then((prev) => {
          // The access check always trusts the ROW's actual room (never the
          // caller-supplied hint) - `edit()` re-resolves and re-validates
          // internally regardless, so this is purely a fast, honest refusal.
          if (prev && !chatRooms.memberCanAccess(prev.room, session.memberId)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this chat room' })
            return
          }
          const editWindowMs =
            (limitsStore.getMeta().chatEditWindowSec || 1800) * 1000
          return chatStore.edit(
            messageId,
            session.memberId,
            body,
            session.role === 'admin',
            roomHint,
            editWindowMs,
          ).then((edited) => {
            if ('error' in edited) {
              reply(ws, { type: 'chat_refuse', frameId, reason: edited.error })
              return
            }
            const message = payloadForChatRow(edited)
            reply(ws, { type: 'chat_edit_ok', frameId, message })
            fanoutChatEditPeer(ws, edited)
          })
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Failed to edit message' })
        })
        return
      }
      case 'chat_react': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot react to messages' })
          return
        }
        const messageId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        const emoji =
          typeof frame.emoji === 'string'
            ? frame.emoji.replace(/\0/g, '').trim().slice(0, 32)
            : ''
        if (!messageId || !emoji) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'message id and emoji required' })
          return
        }
        // TCC-R1125-CHAT-001: same disk-lookup hint as chat_edit.
        const roomHint = typeof frame.room === 'string' ? frame.room : undefined
        void chatStore.findById(messageId, roomHint).then((prev) => {
          if (!prev) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Message not found' })
            return
          }
          if (!chatRooms.memberCanAccess(prev.room, session.memberId)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this chat room' })
            return
          }
          if (typeof prev.deletedAt === 'number' && prev.deletedAt > 0) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Message was removed' })
            return
          }
          if (frame.remove !== true) {
            const roomRow = chatRooms.get(prev.room)
            if (roomRow && !isReactionEmojiAllowed(roomRow, emoji)) {
              reply(ws, {
                type: 'chat_refuse',
                frameId,
                reason: 'This reaction is not allowed in this room',
              })
              return
            }
          }
          // TCC-R1151-CHAT-005: burn react budget only after shape/access/allowlist pass.
          if (!takeChatReactToken(session.memberId)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'Reaction rate limited - try again shortly' })
            return
          }
          return chatStore.react(
            messageId,
            session.memberId,
            emoji,
            frame.remove === true,
            roomHint,
          ).then((reacted) => {
            if ('error' in reacted) {
              reply(ws, { type: 'chat_refuse', frameId, reason: reacted.error })
              return
            }
            const message = payloadForChatRow(reacted)
            reply(ws, { type: 'chat_react_ok', frameId, message })
            // TCC-R1150-CHAT-006: identical react row - no peer amp.
            if (reacted !== prev && (
              JSON.stringify(reacted.reactions || {}) !== JSON.stringify(prev.reactions || {})
            )) {
              fanoutChatReactPeer(ws, reacted)
            }
          })
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Failed to react to message' })
        })
        return
      }
      case 'chat_pin': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM)
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TS-CHAT-043: per-room `permissions.pinMessages` policy ('admin_only'
        // default, 'anyone' opt-in) replaces the old hardcoded team-Admin-only
        // gate - checked BEFORE rate-limit token consumption (same ordering the
        // pre-existing admin-only check used) so a doomed request never burns
        // the caller's mutate-token budget.
        const pinRow = chatRooms.get(roomParsed.room)
        if (!pinRow || !canPinRoomMessages(pinRow, session.memberId, session.role)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'Only Admins can pin messages in this room',
          })
          return
        }
        // TCC-R1134-CHAT-040: was completely unrate-limited.
        if (!takeChatMutateToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        // TCC-R1150-CHAT-008: team Admin pin/unpin without membership (roster parity).
        if (
          session.role !== 'admin'
          && !chatRooms.memberCanAccess(roomParsed.room, session.memberId)
        ) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        // TS-CHAT-010: honor pinned:false as unpin (the desktop toggle sends it).
        // A room can hold several pins, so an unpin names the message to
        // remove; `messageId: null` is only accepted from clients built
        // before multi-pin, which could not say which one, and means the
        // most recently pinned message - exactly the one pin they could see.
        const wantPin = frame.pinned !== false
        const namedId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128) || null
            : null
        if (wantPin && !namedId) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'messageId required to pin' })
          return
        }
        const pinWrite = wantPin && namedId
          ? chatStore.pinMessage(roomParsed.room, namedId, true)
          : chatStore.unpinMessage(roomParsed.room, namedId, true)
        void pinWrite.then((pinned) => {
          if ('error' in pinned) {
            reply(ws, { type: 'chat_refuse', frameId, reason: pinned.error })
            return
          }
          reply(ws, {
            type: 'chat_pin_ok',
            frameId,
            room: roomParsed.room,
            pinnedMessageId: pinned.pinnedId,
            pinnedMessageIds: pinned.pinnedIds,
          })
          // TCC-R1151-CHAT-010: unchanged pin/unpin - no pin_peer amp.
          if (pinned.unchanged !== true) {
            fanoutChatPinPeer(ws, roomParsed.room, pinned.pinnedIds)
          }
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, room: roomParsed.room, reason: 'Failed to pin message' })
        })
        return
      }
      case 'chat_search': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1134-CHAT-040: chat_search scans the room's on-disk history - was
        // completely unrate-limited (chat_history has an equivalent budget).
        if (!takeChatSearchToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Search rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM)
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        const query =
          typeof frame.query === 'string' ? frame.query.replace(/\0/g, '').trim().slice(0, 200) : ''
        const limit =
          typeof frame.limit === 'number' && Number.isFinite(frame.limit) ? frame.limit : 30
        void chatStore.searchRoom(roomParsed.room, query, limit).then((res) => {
          if (!live.has(ws)) return
          reply(ws, {
            type: 'chat_search_ok',
            frameId,
            room: roomParsed.room,
            messageIds: res.messageIds,
            truncated: res.truncated,
          })
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Search failed' })
        })
        return
      }
      case 'chat_jump': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        // TCC-R1134-CHAT-040: chat_jump scans the room's on-disk history - was
        // completely unrate-limited (shares chat_search's budget).
        if (!takeChatSearchToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM)
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        if (!chatRooms.memberCanAccess(roomParsed.room, session.memberId)) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            room: roomParsed.room,
            reason: 'You are not in this chat room',
          })
          return
        }
        const messageId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        if (!messageId) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'message id required' })
          return
        }
        void chatStore.jumpToMessage(roomParsed.room, messageId).then((res) => {
          // TCC-R1134-CHAT2-001: same authoritative-pin override chat_history
          // already applies - a pin write never clears the OLD pinned row's
          // on-disk `pinned:true` when that message is later unpinned, so
          // jumping to a message that was pinned in the PAST (e.g. a search
          // result) would otherwise resurrect a stale pin badge on it and
          // leak it into the client's pinned list.
          const pinIds = chatStore.getPinnedMessageIds(roomParsed.room)
          const message = res.message ? payloadForChatRow(res.message) : null
          if (!live.has(ws)) return
          reply(ws, {
            type: 'chat_jump_ok',
            frameId,
            room: roomParsed.room,
            message: message ? { ...message, pinned: pinIds.includes(message.id) } : null,
            offset: res.offset,
          })
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Could not load message' })
        })
        return
      }
      case 'chat_unsend': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Viewers cannot unsend messages' })
          return
        }
        // TCC-R1134-CHAT-040: was completely unrate-limited.
        if (!takeChatMutateToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        const messageId =
          typeof frame.messageId === 'string'
            ? frame.messageId.replace(/\0/g, '').trim().slice(0, 128)
            : ''
        if (!messageId) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'message id required' })
          return
        }
        // TCC-R1125-CHAT-001: `frame.room` was already declared on this
        // frame type but never read here - wire it through as the disk
        // fallback hint like chat_edit/chat_react.
        const roomHint = typeof frame.room === 'string' ? frame.room : undefined
        void chatStore.findById(messageId, roomHint).then((prev) => {
          if (prev && !chatRooms.memberCanAccess(prev.room, session.memberId)) {
            reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this chat room' })
            return
          }
          return chatStore.authorUnsend(
            messageId,
            session.memberId,
            session.role === 'admin',
            roomHint,
          ).then((uns) => {
            if ('error' in uns) {
              reply(ws, { type: 'chat_refuse', frameId, reason: uns.error })
              return
            }
            reply(ws, { type: 'chat_unsend_ok', frameId, messageId })
            // TCC-R1133-CHAT-001 twin: a concurrent authorUnsend racing an
            // admin softDelete on the same id can land here idempotently
            // (`{ unchanged: true, tomb }`) - same no-re-fanout rule as
            // chat_delete_peer above; skip the redundant second fanout.
            if ('unchanged' in uns) {
              return
            }
            // Prefer pre-tombstone author/createdAt; fall back to returned row.
            const createdAt =
              typeof prev?.createdAt === 'number' && Number.isFinite(prev.createdAt)
                ? prev.createdAt
                : typeof uns.createdAt === 'number'
                  ? uns.createdAt
                  : undefined
            const memberId =
              typeof prev?.memberId === 'string' && prev.memberId.trim()
                ? prev.memberId
                : typeof uns.memberId === 'string'
                  ? uns.memberId
                  : undefined
            fanoutChatDeletePeer(ws, messageId, uns.room || CHAT_ROOM_TEAM, {
              createdAt,
              memberId,
            })
          })
        }).catch(() => {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Failed to unsend message' })
        })
        return
      }
      case 'chat_export': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can export chat',
          })
          return
        }
        // TCC-R1134-CHAT-040: was completely unrate-limited - the single
        // most expensive chat_* op (serializes the whole room).
        if (!takeChatExportToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Export rate limited - try again shortly' })
          return
        }
        const roomParsed = parseChatRoomId(
          typeof frame.room === 'string' ? frame.room : CHAT_ROOM_TEAM,
        )
        if (!roomParsed.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: roomParsed.reason })
          return
        }
        // TCC-R1150-CHAT-008: team Admin export without membership (roster parity).
        if (
          session.role !== 'admin'
          && !chatRooms.memberCanAccess(roomParsed.room, session.memberId)
        ) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'You are not in this chat room' })
          return
        }
        const format = frame.format === 'txt' ? 'txt' : 'json'
        // TCC-R1149-BRG-002: process-wide export lease (heap/CPU ceiling).
        if (!chatExportLease.tryAcquire()) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Another export is already running. Try again shortly.' })
          return
        }
        void chatStore.exportRoom(roomParsed.room, format, { maxBodyBytes: 8_000_000 }).then((res) => {
          chatExportLease.release()
          // TCC-R1149-BRG-003: skip reply work when socket already gone.
          if (!live.has(ws)) return
          if ('error' in res) {
            reply(ws, { type: 'chat_refuse', frameId, reason: res.error })
            return
          }
          reply(ws, {
            type: 'chat_export_ok',
            frameId,
            room: roomParsed.room,
            format,
            body: res.body.slice(0, 8_000_000),
            truncated: res.truncated || res.body.length > 8_000_000,
          })
        }).catch(() => {
          chatExportLease.release()
          if (!live.has(ws)) return
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Export failed' })
        })
        return
      }
      case 'chat_metrics': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        if (session.role !== 'admin') {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Only the team Admin can view chat metrics' })
          return
        }
        session.lastSeen = Date.now()
        const live = chatMeta.get()
        reply(ws, {
          type: 'chat_metrics_ok',
          frameId,
          metrics: {
            ...snapshotChatMetrics(),
            blobBytes: chatBlobs.totalBlobBytes(),
            retentionDays: live.retentionDays,
            chatFilesQuotaBytes: live.chatFilesBytes,
            chatBlobsQuotaBytes: live.chatBlobsBytes,
            chatFilesUsedBytes: measureChatFilesBytes(DATA_DIR),
          },
        })
        return
      }
      case 'chat_config_get':
      case 'chat_config_set': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Only the team Admin can change chat retention and storage limits',
          })
          return
        }
        session.lastSeen = Date.now()
        if (frame.type === 'chat_config_set') {
          const patch: {
            retentionDays?: number
            chatFilesBytes?: number
            chatBlobsBytes?: number
          } = {}
          if ('retentionDays' in frame) {
            patch.retentionDays =
              typeof frame.retentionDays === 'number' ? frame.retentionDays : Number(frame.retentionDays)
          }
          if ('chatFilesBytes' in frame) {
            patch.chatFilesBytes =
              typeof frame.chatFilesBytes === 'number' ? frame.chatFilesBytes : Number(frame.chatFilesBytes)
          }
          if ('chatBlobsBytes' in frame) {
            patch.chatBlobsBytes =
              typeof frame.chatBlobsBytes === 'number' ? frame.chatBlobsBytes : Number(frame.chatBlobsBytes)
          }
          if (
            !('retentionDays' in patch)
            && !('chatFilesBytes' in patch)
            && !('chatBlobsBytes' in patch)
          ) {
            reply(ws, {
              type: 'chat_refuse',
              frameId,
              reason: 'Nothing to update - send retentionDays, chatFilesBytes, or chatBlobsBytes',
            })
            return
          }
          const setRes = chatMeta.set(patch)
          if ('error' in setRes) {
            reply(ws, { type: 'chat_refuse', frameId, reason: setRes.error })
            return
          }
          chatStore.setRetentionDays(setRes.retentionDays)
        }
        const liveCfg = chatMeta.get()
        reply(ws, {
          type: 'chat_config_ok',
          frameId,
          config: {
            retentionDays: liveCfg.retentionDays,
            chatFilesBytes: liveCfg.chatFilesBytes,
            chatBlobsBytes: liveCfg.chatBlobsBytes,
            usedFilesBytes: measureChatFilesBytes(DATA_DIR),
            usedBlobsBytes: chatBlobs.totalBlobBytes(),
          },
        })
        return
      }
      case 'profile_update': {
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Not authenticated' })
          return
        }
        // TCC-R1153-BRG-003: profile fanout is not free.
        if (!takeProfileUpdateToken(session.memberId)) {
          reply(ws, { type: 'chat_refuse', frameId, reason: 'Rate limited - try again shortly' })
          return
        }
        session.lastSeen = Date.now()
        const patch: {
          displayName?: string
          avatarRef?: string | null
          avatarRev?: number
        } = {}
        if (typeof frame.displayName === 'string') {
          const d = frame.displayName.replace(/\0/g, '').trim().slice(0, 200)
          if (d) patch.displayName = d
        }
        if (Object.prototype.hasOwnProperty.call(frame, 'avatarRef')) {
          if (frame.avatarRef === null) {
            patch.avatarRef = null
          } else if (typeof frame.avatarRef === 'string') {
            const ref = frame.avatarRef.replace(/\0/g, '').trim().slice(0, 256)
            patch.avatarRef = ref || null
          }
        }
        if (typeof frame.avatarRev === 'number' && Number.isFinite(frame.avatarRev) && frame.avatarRev > 0) {
          patch.avatarRev = Math.floor(frame.avatarRev)
        }
        if (
          patch.displayName === undefined
          && !Object.prototype.hasOwnProperty.call(patch, 'avatarRef')
          && patch.avatarRev === undefined
        ) {
          reply(ws, {
            type: 'chat_refuse',
            frameId,
            reason: 'Nothing to update - send displayName, avatarRef, or avatarRev',
          })
          return
        }
        const updated = store.updateMemberChatProfile(session.memberId, patch)
        if (!updated.ok) {
          reply(ws, { type: 'chat_refuse', frameId, reason: updated.reason })
          return
        }
        // TCC-R1152-LIM-003: stamp every live socket for this member (set_role twin).
        for (const peer of live.values()) {
          if (peer.memberId === updated.member.memberId) {
            peer.displayName = updated.member.displayName
          }
        }
        const avatarRefOut =
          updated.member.avatarRef === null
            ? null
            : typeof updated.member.avatarRef === 'string'
              ? updated.member.avatarRef
              : undefined
        const avatarRevOut =
          typeof updated.member.avatarRev === 'number' && updated.member.avatarRev > 0
            ? updated.member.avatarRev
            : undefined
        reply(ws, {
          type: 'profile_update_ok',
          frameId,
          displayName: updated.member.displayName,
          avatarRef: avatarRefOut,
          avatarRev: avatarRevOut,
        })
        fanoutChatProfilePeer(ws, {
          memberId: updated.member.memberId,
          displayName: updated.member.displayName,
          avatarRef: avatarRefOut,
          avatarRev: avatarRevOut,
        })
        schedulePresenceFanoutBroadcast()
        return
      }
      case 'task_request': {
        // Explicit task frame (UI parsed /task). Member/Admin may request; Viewer refuse.
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, {
            type: 'task_ack',
            frameId,
            ok: false,
            reason: 'Not authenticated',
          })
          return
        }
        session.lastSeen = Date.now()
        if (session.role === 'viewer') {
          reply(ws, {
            type: 'task_ack',
            frameId,
            ok: false,
            reason: 'Viewers cannot create tasks from team chat',
          })
          return
        }
        if (!takeOpsToken(session)) {
          reply(ws, {
            type: 'task_ack',
            frameId,
            ok: false,
            reason: 'Rate limited - slow down',
          })
          return
        }
        const title =
          typeof frame.title === 'string'
            ? capChatText(frame.title.replace(/\0/g, '').trim(), CHAT_TITLE_MAX)
            : ''
        if (!title) {
          reply(ws, {
            type: 'task_ack',
            frameId,
            ok: false,
            reason: 'Add a short title after /task',
          })
          return
        }
        const delivered = fanoutToAdmins(ws, {
          type: 'task_request',
          frameId,
          title,
          body: typeof frame.body === 'string' ? scrubChatBody(frame.body) || undefined : undefined,
          chatMessageId:
            typeof frame.chatMessageId === 'string'
              ? frame.chatMessageId.slice(0, 128)
              : undefined,
          fromMemberId: session.memberId,
          fromMemberName: session.displayName || 'Member',
        })
        if (delivered === 0) {
          reply(ws, {
            type: 'task_ack',
            frameId,
            ok: false,
            reason: 'No Admin is connected to create tasks right now',
          })
          return
        }
        // Ack that the request was delivered; Admin will emit task_ack with result.
        reply(ws, {
          type: 'task_ack',
          frameId,
          ok: true,
          reason: 'Waiting for Admin to create the task on their computer',
        })
        return
      }
      case 'task_ack': {
        // Admin desktop replies after creating (or refusing) a local task.
        const frameId = isFiniteRequestId(frame.frameId) ? frame.frameId : 'missing-frame'
        if (!session) {
          reply(ws, { type: 'error', requestId: frameId, message: 'Not authenticated' })
          return
        }
        session.lastSeen = Date.now()
        if (session.role !== 'admin') {
          reply(ws, {
            type: 'error',
            requestId: frameId,
            message: 'Only Admin can confirm task creation',
          })
          return
        }
        const ok = frame.ok === true
        const title =
          typeof frame.title === 'string'
            ? capChatText(frame.title.replace(/\0/g, '').trim(), CHAT_TITLE_MAX)
            : ''
        const reason =
          typeof frame.reason === 'string'
            ? frame.reason.replace(/\0/g, '').trim().slice(0, 500)
            : undefined
        // Echo ack to the requester frame owner via fanout notice.
        fanoutAll(null, {
          type: 'task_peer_notice',
          ok,
          title: title || 'Task',
          hostMemberId: session.memberId,
          reason,
          requesterMemberId:
            typeof frame.hostMemberId === 'string' ? undefined : undefined,
        })
        // Persist a system chat line so history shows the outcome.
        const sysBody = ok
          ? `Task created on Admin's computer${title ? `: ${title}` : ''}`
          : `Could not create task${reason ? ` - ${reason}` : ''}`
        // Best-effort system chat line - task_ack below does not depend on it.
        void chatStore.append({
          room: CHAT_ROOM_TEAM,
          body: sysBody,
          memberId: session.memberId,
          memberName: session.displayName || 'Admin',
          role: 'admin',
          kind: 'system',
        }).then((sys) => {
          if (!('error' in sys)) {
            fanoutChatPeer(null, {
              id: sys.id,
              room: sys.room,
              body: sys.body,
              memberId: sys.memberId,
              memberName: sys.memberName,
              role: sys.role,
              createdAt: sys.createdAt,
              kind: 'system',
            })
          }
        }).catch(() => {
          // Task ack already sent below regardless - this line is cosmetic history only.
        })
        reply(ws, {
          type: 'task_ack',
          frameId,
          ok,
          taskId: typeof frame.taskId === 'string' ? frame.taskId.slice(0, 128) : undefined,
          reason,
          hostMemberId: session.memberId,
          title: title || undefined,
        })
        return
      }
      default:
        reply(ws, {
          type: 'error',
          requestId: typeof frame.frameId === 'string' ? frame.frameId : undefined,
          message: `unknown frame type: ${type.slice(0, 64) || '(empty)'}`,
        })
    }
  } catch (err) {
    reply(ws, {
      type: 'error',
      message: err instanceof Error ? err.message.slice(0, 500) : 'internal error',
    })
  }
}

function sanitizeHeaderFilename(raw: string): string {
  try {
    return sanitizeChatAttachmentName(decodeURIComponent(raw))
  } catch {
    return sanitizeChatAttachmentName(raw)
  }
}

/**
 * TCC-R1133-BRG-001: process-wide HTTP body budget exhausted. Thrown by
 * `readJsonBody` (and surfaced as a resolved `{error, status:503}` by
 * `readBodyBytes`, which never rejects) instead of accepting an unbounded
 * number of parallel in-memory body buffers. Callers map this to a clear
 * 503 + `Retry-After` via `sendCatchError` / `sendBodyBytesError` instead of
 * the generic 400/500 a parse or size error gets.
 */
class HttpBodyBudgetExhaustedError extends Error {
  readonly status = 503
  readonly retryAfterSec: number
  constructor(retryAfterSec: number) {
    super('Server is busy handling other uploads. Try again shortly.')
    this.name = 'HttpBodyBudgetExhaustedError'
    this.retryAfterSec = retryAfterSec
  }
}

/** TCC-R1133-BRG-001: seconds a refused caller should wait before retrying an upload. */
const HTTP_BODY_BUDGET_RETRY_AFTER_SEC = 3

/**
 * TCC-R1133-BRG-001: total bytes currently reserved across every in-flight
 * `readBodyBytes` / `readJsonBody` call. Each per-route byte cap (25 MiB
 * chat, 28 MiB compose, etc) only bounds ONE request; with hundreds of
 * concurrent uploads from distinct members each buffering up to their own
 * cap, unbounded parallelism still multiplies into multi-GiB resident heap.
 * This counter bounds the SUM across every concurrent body read.
 */
let inflightHttpBodyBudgetUsed = 0

/**
 * Reserve `maxBytes` - the route's declared per-request ceiling, not the
 * body's actual (unknown-until-fully-read) size - against the process-wide
 * budget BEFORE any bytes are buffered. Reserving the worst case up front is
 * deliberately pessimistic: it bounds worst-case resident memory even if
 * every in-flight request happens to use its full cap, which is exactly the
 * OOM scenario this finding describes. Reservation is released in every
 * terminal path (success, size-exceeded, socket error) via `finally`-style
 * `release()` closures in the two readers below.
 */
function tryReserveHttpBodyBudget(maxBytes: number): boolean {
  if (inflightHttpBodyBudgetUsed + maxBytes > MAX_INFLIGHT_HTTP_BODY_BYTES) return false
  inflightHttpBodyBudgetUsed += maxBytes
  return true
}

function releaseHttpBodyBudget(maxBytes: number): void {
  // Clamp at 0: a double-release (defensive, should never happen given the
  // `released` guards below) must not let the counter drift negative and
  // silently widen the effective budget for every future request.
  inflightHttpBodyBudgetUsed = Math.max(0, inflightHttpBodyBudgetUsed - maxBytes)
}

/** Shared response mapper for a `readBodyBytes` resolved `{error}` result. */
function sendBodyBytesError(
  res: ServerResponse,
  body: { error: string; status?: number; retryAfterSec?: number },
): void {
  if (typeof body.retryAfterSec === 'number') {
    res.setHeader('Retry-After', String(body.retryAfterSec))
  }
  sendJson(res, body.status ?? 400, { ok: false, error: body.error })
}

/**
 * Shared catch-block response mapper for `readJsonBody` (and any processing
 * that runs after it in the same try): a budget-exhausted rejection gets a
 * clear 503 + Retry-After; everything else keeps the existing generic
 * 400 "Bad request" behavior.
 */
function sendCatchError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpBodyBudgetExhaustedError) {
    res.setHeader('Retry-After', String(err.retryAfterSec))
    sendJson(res, err.status, { ok: false, error: err.message })
    return
  }
  sendJson(res, 400, {
    ok: false,
    error: err instanceof Error ? err.message.slice(0, 200) : 'Bad request',
  })
}

function readBodyBytes(
  req: IncomingMessage,
  maxBytes: number,
  opts?: { reserveBytes?: number },
): Promise<
  | { bytes: Uint8Array; release: () => void }
  | { error: string; status?: number; retryAfterSec?: number }
> {
  // TCC-R1146-BRG-005: prefer Content-Length when present and valid.
  const reserve = Math.max(
    1,
    Math.min(
      maxBytes,
      typeof opts?.reserveBytes === 'number' && Number.isFinite(opts.reserveBytes) && opts.reserveBytes > 0
        ? Math.floor(opts.reserveBytes)
        : maxBytes,
    ),
  )
  if (!tryReserveHttpBodyBudget(reserve)) {
    return Promise.resolve({
      error: 'Server is busy handling other uploads. Try again shortly.',
      status: 503,
      retryAfterSec: HTTP_BODY_BUDGET_RETRY_AFTER_SEC,
    })
  }
  return new Promise((resolve) => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseHttpBodyBudget(reserve)
    }
    const chunks: Buffer[] = []
    let n = 0
    let settled = false
    const fail = (error: string) => {
      if (settled) return
      settled = true
      try { req.destroy() } catch { /* */ }
      release()
      resolve({ error })
    }
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > maxBytes) {
        fail(`File is too large (max ${Math.floor(maxBytes / (1024 * 1024))} MB)`)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      // TCC-R1145-BRG-001: hold reservation until caller finishes with bytes.
      resolve({ bytes: new Uint8Array(Buffer.concat(chunks)), release })
    })
    req.on('error', () => fail('Upload interrupted'))
  })
}

/**
 * TCC-R1145-BRG-001: reservation is held past socket `end` until the caller
 * invokes `releaseJsonBody(value)` (or the safety timer fires). Large compose /
 * payload routes MUST call `releaseJsonBody` in `finally` after disk write.
 */
const jsonBodyReleases = new WeakMap<object, () => void>()

function releaseJsonBody(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const rel = jsonBodyReleases.get(value as object)
  if (!rel) return
  jsonBodyReleases.delete(value as object)
  rel()
}

function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
  opts?: { reserveBytes?: number },
): Promise<unknown> {
  const reserve = Math.max(
    1,
    Math.min(
      maxBytes,
      typeof opts?.reserveBytes === 'number' && Number.isFinite(opts.reserveBytes) && opts.reserveBytes > 0
        ? Math.floor(opts.reserveBytes)
        : maxBytes,
    ),
  )
  if (!tryReserveHttpBodyBudget(reserve)) {
    return Promise.reject(new HttpBodyBudgetExhaustedError(HTTP_BODY_BUDGET_RETRY_AFTER_SEC))
  }
  return new Promise((resolve, reject) => {
    let released = false
    const release = () => {
      if (released) return
      released = true
      releaseHttpBodyBudget(reserve)
    }
    const chunks: Buffer[] = []
    let n = 0
    req.on('data', (c: Buffer) => {
      n += c.length
      if (n > maxBytes) {
        release()
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        const value: unknown = text ? JSON.parse(text) : {}
        if (value && typeof value === 'object') {
          jsonBodyReleases.set(value as object, release)
          // Safety net so a forgotten release cannot pin the budget forever.
          const t = setTimeout(release, 60_000)
          t.unref?.()
        } else {
          release()
        }
        resolve(value)
      } catch (e) {
        release()
        reject(e)
      }
    })
    req.on('error', (e) => {
      release()
      reject(e)
    })
  })
}

/**
 * TS-BRG-009: prefer Authorization Bearer over `?token=`.
 * When an Authorization header is present, ignore query (never mix).
 * Blob routes are header-only (`allowQueryToken: false`).
 */
function authFromReq(
  req: IncomingMessage,
  opts?: { allowQueryToken?: boolean },
): ReturnType<BridgeStore['findBySession']> {
  const hdr = req.headers.authorization
  let token = ''
  let fromQuery = false
  const headerPresent = typeof hdr === 'string'
  if (headerPresent && hdr.toLowerCase().startsWith('bearer ')) {
    token = hdr.slice(7).trim()
  }
  // TCC-R1148-BRG-004: query tokens opt-IN only (default header-only).
  if (!headerPresent && opts?.allowQueryToken === true) {
    try {
      const u = new URL(req.url || '/', 'http://localhost')
      token = (u.searchParams.get('token') || '').trim()
      fromQuery = !!token
    } catch { /* */ }
  }
  if (fromQuery && token) {
    console.warn('[bridge] Deprecation: pass session token via Authorization: Bearer header, not ?token=')
  }
  return store.findBySession(token)
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const raw = JSON.stringify(body)
  // TCC-R1151-BRG-003: never let intermediaries cache session/invite/media JSON.
  // TCC-FIX-SHARE-009: same URL may also serve HTML; Vary so Accept cannot mix them.
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    'cache-control': 'no-store',
    vary: 'Accept',
  })
  res.end(raw)
}

function sendGuestHtml(res: ServerResponse, code: number, html: string): void {
  const raw = Buffer.from(html, 'utf8')
  res.writeHead(code, {
    ...GUEST_HTML_RESPONSE_HEADERS,
    'content-length': raw.length,
  })
  res.end(raw)
}

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req)
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`)
  const path = url.pathname

  // TCC-R1150-BRG-003: refuse new work while draining.
  if (shuttingDown) {
    drainRequestBody(req)
    sendJson(res, 503, { ok: false, error: 'Bridge is restarting - retry shortly' })
    return
  }

  // TCC-R1149-BRG-004: health/root probes must not share the mutator HTTP bucket.
  // BRG-057: browsers (Accept: text/html) get a status card; curl / Settings
  // keep the historic plain body. Both stay no-store + Vary Accept.
  if (req.method === 'GET' && (path === '/' || path === '/health')) {
    if (wantsHealthHtml(req.headers.accept)) {
      sendGuestHtml(res, 200, healthPageHtml())
      return
    }
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      vary: 'Accept',
    })
    res.end(HEALTH_PLAIN_BODY)
    return
  }

  if (!takeHttpToken(ip)) {
    drainRequestBody(req)
    sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
    return
  }

  if (req.method === 'GET' && path === '/v1/chat/metrics') {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    sendJson(res, 200, {
      ok: true,
      metrics: {
        ...snapshotChatMetrics(),
        blobBytes: chatBlobs.totalBlobBytes(),
      },
    })
    return
  }

  // TS-CHAT-013: profile avatar PUT/GET (any session role; team-wide read).
  if (req.method === 'POST' && path === '/v1/chat/avatars') {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      drainRequestBody(req)
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    // TCC-R1146-BRG-003: avatar PUT needs its own bucket (attach PUT already gated).
    if (!takeChatAvatarPutToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const cl = Number(req.headers['content-length'] || 0)
    const reserve = Number.isFinite(cl) && cl > 0 ? Math.min(cl, CHAT_AVATAR_MAX_BYTES) : CHAT_AVATAR_MAX_BYTES
    const body = await readBodyBytes(req, CHAT_AVATAR_MAX_BYTES, { reserveBytes: reserve })
    if ('error' in body) {
      sendBodyBytesError(res, body)
      return
    }
    try {
      const put = chatAvatars.put(body.bytes)
      if ('error' in put) {
        sendJson(res, 400, { ok: false, error: put.error })
        return
      }
      sendJson(res, 200, {
        ok: true,
        sha256: put.sha256,
        mime: put.mime,
        bytes: put.bytes,
      })
      return
    } finally {
      body.release()
    }
  }

  const chatAvatarGet = /^\/v1\/chat\/avatars\/([a-fA-F0-9]{64})$/.exec(path)
  if (req.method === 'GET' && chatAvatarGet) {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    // TCC-R1133-SEC-001: member-scoped budget (was only the shared per-IP one).
    if (!takeChatAvatarGetToken(auth.member.memberId)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const sha = chatAvatarGet[1].toLowerCase()
    const row = chatAvatars.get(sha)
    if (!row) {
      sendJson(res, 404, { ok: false, error: 'Avatar not found' })
      return
    }
    res.writeHead(200, {
      'content-type': row.mime,
      'content-length': row.bytes.length,
      'cache-control': 'private, max-age=86400',
    })
    res.end(row.bytes)
    return
  }

  // SEC-CHAT-05: chat attachment PUT (room ACL + dangerous-type + quota).
  if (req.method === 'POST' && path === '/v1/chat/blobs') {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      drainRequestBody(req)
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    if (auth.member.role === 'viewer') {
      drainRequestBody(req)
      sendJson(res, 403, { ok: false, error: 'Viewers cannot upload attachments' })
      return
    }
    if (!takeChatBlobPutToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Attachment upload rate limited' })
      return
    }
    const roomRaw = String(req.headers['x-teamspace-chat-room'] || '').trim()
    const roomParsed = parseChatRoomId(roomRaw || CHAT_ROOM_TEAM)
    if (!roomParsed.ok) {
      drainRequestBody(req)
      sendJson(res, 400, { ok: false, error: roomParsed.reason })
      return
    }
    if (!chatRooms.memberCanAccess(roomParsed.room, auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 403, { ok: false, error: 'You are not in this chat room' })
      return
    }
    const filename = sanitizeHeaderFilename(String(req.headers['x-filename'] || 'file'))
    const cl = Number(req.headers['content-length'] || 0)
    const reserve = Number.isFinite(cl) && cl > 0 ? Math.min(cl, CHAT_ATTACH_MAX_BYTES_CEILING) : CHAT_ATTACH_MAX_BYTES_CEILING
    const body = await readBodyBytes(req, CHAT_ATTACH_MAX_BYTES_CEILING, { reserveBytes: reserve })
    if ('error' in body) {
      sendBodyBytesError(res, body)
      return
    }
    try {
      const registered = await chatBlobs.registerUpload({
        roomId: roomParsed.room,
        uploadedBy: auth.member.memberId,
        filename,
        bytes: body.bytes,
      })
      if ('error' in registered) {
        sendJson(res, 400, { ok: false, error: registered.error })
        return
      }
      sendJson(res, 200, {
        ok: true,
        blob: {
          sha256: registered.sha256,
          roomId: registered.roomId,
          name: registered.name,
          bytes: registered.bytes,
          mime: registered.mime,
        },
      })
      return
    } finally {
      body.release()
    }
  }

  const chatBlobGet = /^\/v1\/chat\/blobs\/([a-fA-F0-9]{64})$/.exec(path)
  if (req.method === 'GET' && chatBlobGet) {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    // TCC-R1133-SEC-001: member-scoped budget (was only the shared per-IP one).
    if (!takeChatBlobGetToken(auth.member.memberId)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const sha = chatBlobGet[1].toLowerCase()
    const row = chatBlobs.get(sha)
    // TCC-R1147-BRG-004 / TCC-R1146-MEDIA-003: missing and ACL-denied are the
    // same 404 (no existence oracle); ACL admits any granted room.
    const canRead = !!row && chatBlobRoomIds(row).some((r) =>
      chatRooms.memberCanAccess(r, auth.member.memberId),
    )
    if (!row || !canRead) {
      sendJson(res, 404, { ok: false, error: 'Attachment not found' })
      return
    }
    // TCC-R1125-BRG-002 / TCC-R1148-MEDIA-004: read through the registry so
    // at-rest bytes decrypt; distinguish missing vs unreadable.
    let buf: Buffer | null = null
    try {
      buf = chatBlobs.readBlobBytes(sha)
    } catch {
      sendJson(res, 500, { ok: false, error: 'Could not read attachment' })
      return
    }
    if (!buf) {
      sendJson(res, 404, { ok: false, error: 'Attachment file missing' })
      return
    }
    try {
      res.writeHead(200, {
        'content-type': row.mime || 'application/octet-stream',
        'content-length': buf.length,
        'content-disposition': `attachment; filename="${row.name.replace(/"/g, '')}"`,
      })
      res.end(buf)
    } catch {
      sendJson(res, 500, { ok: false, error: 'Could not read attachment' })
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/invite/create') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeInviteToken(auth.member.memberId)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const body = await readJsonBody(req, 64_000) as Record<string, unknown>
    const email = typeof body.email === 'string' ? body.email : ''
    // TCC-R1143-INV-003: HTTP twin of WS invite_create - accept admin|viewer|member.
    const role: BridgeRole =
      body.role === 'viewer' || body.role === 'admin' ? body.role : 'member'
    const created = store.createInvite(auth.member.memberId, email, role)
    if (!created.ok) {
      sendJson(res, 400, { ok: false, error: created.reason })
      return
    }
    sendJson(res, 200, {
      ok: true,
      id: created.invite.id,
      token: created.invite.token,
      expiresAt: created.invite.expiresAt,
      role: created.invite.role,
    })
    return
  }

  // TS-BRG-038: Admin Bearer cancel/revoke of an unused invite.
  if (req.method === 'POST' && (path === '/v1/invite/cancel' || path === '/v1/invite/revoke')) {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeInviteToken(auth.member.memberId)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const body = await readJsonBody(req, 64_000) as Record<string, unknown>
    const tokenOrId = typeof body.tokenOrId === 'string'
      ? body.tokenOrId
      : (typeof body.token === 'string'
        ? body.token
        : (typeof body.id === 'string' ? body.id : ''))
    const cancelled = store.cancelInvite(tokenOrId)
    if (!cancelled.ok) {
      sendJson(res, 400, { ok: false, error: cancelled.reason })
      return
    }
    sendJson(res, 200, { ok: true, id: cancelled.id })
    return
  }

  if (req.method === 'POST' && path === '/v1/invite/redeem') {
    if (!takeInviteToken(`redeem:${ip}`)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const body = await readJsonBody(req, 64_000) as Record<string, unknown>
    const token = typeof body.token === 'string' ? body.token : ''
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId : ''
    const redeemed = await store.redeemInvite({
      token,
      deviceId,
      memberEmail: typeof body.memberEmail === 'string' ? body.memberEmail : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
    })
    if (!redeemed.ok) {
      sendJson(res, 400, { ok: false, error: redeemed.reason })
      return
    }
    // TCC-R1125-BRG-001: HTTP redeem rotates member.sessions on disk (same as
    // WS invite_redeem) - drop every other live WS peer for this member so a
    // stale device cannot keep sending ops/chat/yjs on a revoked session.
    // TCC-R1144-LIM-001: fan out presence after quietDrop so peers drop ghosts
    // (WS invite_redeem already calls schedulePresenceFanoutBroadcast).
    for (const [peerWs, peer] of live) {
      if (peer.memberId === redeemed.member.memberId) {
        quietDropLiveSession(peerWs)
        try { peerWs.close(4001, 'session rotated') } catch { /* */ }
      }
    }
    schedulePresenceFanoutBroadcast()
    const team = store.ensureTeam()
    sendJson(res, 200, {
      ok: true,
      sessionToken: redeemed.sessionToken,
      memberId: redeemed.member.memberId,
      role: redeemed.member.role,
      teamId: team.teamId,
      teamName: typeof team.name === 'string' && team.name.trim()
        ? team.name.trim().slice(0, 200)
        : 'Team Space',
    })
    return
  }

  const blobMatch = /^\/v1\/blobs\/([a-fA-F0-9]{64})$/.exec(path)
  if (blobMatch) {
    const sha = blobMatch[1].toLowerCase()
    // TS-BRG-009: blob paths are header-only (no ?token=).
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      drainRequestBody(req)
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    if (!takeBlobToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    if (req.method === 'GET') {
      const onDisk = store.blobOnDiskSize(sha)
      if (onDisk === null) {
        sendJson(res, 404, { ok: false, error: 'Not found' })
        return
      }
      // TCC-R1144-BRG-005: download heap budget before readFileSync+decrypt.
      if (!tryReserveHttpDownloadBudget(onDisk)) {
        sendJson(res, 503, { ok: false, error: 'Server is busy serving other downloads. Try again shortly.' })
        return
      }
      let dlReleased = false
      const releaseDl = () => {
        if (dlReleased) return
        dlReleased = true
        releaseHttpDownloadBudget(onDisk)
      }
      try {
        const opened = store.openBlobRead(sha)
        if (!opened) {
          releaseDl()
          sendJson(res, 404, { ok: false, error: 'Not found' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': opened.size,
          'cache-control': 'no-store',
        })
        opened.stream.on('end', releaseDl)
        opened.stream.on('error', releaseDl)
        res.on('close', releaseDl)
        opened.stream.pipe(res)
        return
      } catch {
        releaseDl()
        sendJson(res, 500, { ok: false, error: 'Download failed' })
        return
      }
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      if (auth.member.role === 'viewer') {
        drainRequestBody(req)
        sendJson(res, 403, { ok: false, error: 'Viewers cannot upload files' })
        return
      }
      const len = Number(req.headers['content-length'] || 0)
      if (!Number.isFinite(len) || len <= 0 || len > MAX_BLOB_BYTES_EXPORT) {
        drainRequestBody(req)
        sendJson(res, 400, { ok: false, error: 'Invalid Content-Length' })
        return
      }
      // TCC-R1144-BRG-001: CRM blob uploads share the process-wide body budget.
      if (!tryReserveHttpBodyBudget(len)) {
        drainRequestBody(req)
        sendJson(res, 503, { ok: false, error: 'Server is busy handling other uploads. Try again shortly.' })
        return
      }
      // TCC-R1146-BRG-002: exists-skip verify also needs download heap budget.
      const exists = store.hasBlob(sha)
      if (exists && !tryReserveHttpDownloadBudget(len)) {
        releaseHttpBodyBudget(len)
        drainRequestBody(req)
        sendJson(res, 503, { ok: false, error: 'Server is busy verifying media. Try again shortly.' })
        return
      }
      try {
        const put = await store.putBlobFromStream(sha, req, len, {
          diskMaxBytes: CRM_BLOBS_DISK_MAX_BYTES,
        })
        if (!put.ok) {
          sendJson(res, put.status ?? 400, { ok: false, error: put.error })
          return
        }
        sendJson(res, 200, { ok: true, sha256: put.sha256, bytes: put.bytes })
        return
      } finally {
        releaseHttpBodyBudget(len)
        if (exists) releaseHttpDownloadBudget(len)
      }
    }
  }

  // TCC-R1146-BRG-001: GET/PATCH /v1/limits must be reachable independently of
  // the /v1/backups path guard (nested inside backups made every limits call 404).
  // Header-only auth (same class as blobs/backups - no ?token=).
  if (path === '/v1/limits') {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    const isAdmin = auth.member.role === 'admin'

    if (req.method === 'GET') {
      // TCC-R1143-LIM-004: any authenticated member may read the public chat
      // caps subset; full throughput meta stays Admin-only.
      if (!isAdmin) {
        const caps = limitsStore.getPublicChatCaps()
        const eff = limitsStore.getEffective()
        sendJson(res, 200, {
          ok: true,
          public: true,
          meta: caps,
          defaults: {
            voiceMessageMaxSec: eff.defaults.voiceMessageMaxSec,
            chatEditWindowSec: eff.defaults.chatEditWindowSec,
          },
          floors: {
            voiceMessageMaxSec: eff.floors.voiceMessageMaxSec,
            chatEditWindowSec: eff.floors.chatEditWindowSec,
          },
          ceilings: {
            voiceMessageMaxSec: eff.ceilings.voiceMessageMaxSec,
            chatEditWindowSec: eff.ceilings.chatEditWindowSec,
          },
          overridden: eff.overridden.filter(
            (k) => k === 'voiceMessageMaxSec' || k === 'chatEditWindowSec',
          ),
        })
        return
      }
      sendJson(res, 200, { ok: true, ...limitsStore.getEffective() })
      return
    }

    if (req.method === 'PATCH') {
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: 'Admin session required' })
        return
      }
      try {
        const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
        const patch: Record<string, number> = {}
        const ignoredKeys: string[] = []
        const keys = [
          'maxLiveConnections',
          'maxRoomMembers',
          'chatSendPerMin',
          'chatReactPerMin',
          'chatMutatePerMin',
          'chatSearchPerMin',
          'chatHistoryPerMin',
          'chatExportPerMin',
          'yjsRoomMaxPeers',
          'voiceMessageMaxSec',
          'chatEditWindowSec',
        ] as const
        for (const key of keys) {
          if (!Object.prototype.hasOwnProperty.call(body, key)) continue
          const v = body[key]
          // TCC-R1143-LIM-007: present-but-invalid refuses (not silent drop).
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            sendJson(res, 400, {
              ok: false,
              error: `${key} must be a finite number`,
              ignoredKeys: [key],
            })
            return
          }
          patch[key] = v
        }
        for (const k of Object.keys(body)) {
          if (!(keys as readonly string[]).includes(k)) ignoredKeys.push(k.slice(0, 64))
        }
        if (Object.keys(patch).length === 0) {
          sendJson(res, 400, {
            ok: false,
            error: 'Nothing to update',
            ignoredKeys: ignoredKeys.slice(0, 32),
          })
          return
        }
        const before = limitsStore.getMeta()
        const after = limitsStore.setMeta(patch)
        const clampedKeys: string[] = []
        for (const key of Object.keys(patch) as Array<keyof typeof patch>) {
          if (patch[key] !== after[key as keyof typeof after]) clampedKeys.push(String(key))
        }
        // Silence unused before (kept for future audit diffs).
        void before
        sendJson(res, 200, {
          ok: true,
          ...limitsStore.getEffective(),
          ...(clampedKeys.length > 0 ? { clampedKeys } : {}),
          ...(ignoredKeys.length > 0 ? { ignoredKeys: ignoredKeys.slice(0, 32) } : {}),
        })
      } catch (err) {
        sendCatchError(res, err)
      }
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
    return
  }

  // --- P6 team-server backups (dedicated store; never CRM blobs) ---
  // Header-only auth (same class as blobs - no ?token=).
  if (path === '/v1/backups' || path.startsWith('/v1/backups/')) {
    const auth = authFromReq(req, { allowQueryToken: false })
    if (!auth) {
      sendJson(res, 401, { ok: false, error: 'Session required' })
      return
    }
    if (!takeBackupToken(auth.member.memberId)) {
      sendJson(res, 429, { ok: false, error: 'Rate limited - slow down' })
      return
    }
    const isAdmin = auth.member.role === 'admin'
    const memberId = auth.member.memberId

    if (req.method === 'GET' && path === '/v1/backups') {
      const scope = url.searchParams.get('scope')
      const wantAll = scope === 'all' || scope === 'team'
      if (wantAll && !isAdmin) {
        sendJson(res, 403, { ok: false, error: 'Admin session required' })
        return
      }
      const liveMemberIds = new Set(store.listMembers().map((m) => m.memberId))
      const rows = wantAll ? backupStore.listAll() : backupStore.listForMember(memberId)
      sendJson(res, 200, {
        ok: true,
        backups: rows.map((r) => ({
          id: r.id,
          memberId: r.memberId,
          createdAt: r.createdAt,
          bytes: r.bytes,
          sha256: r.sha256,
          label: r.label,
          includesBrowserSessions: r.includesBrowserSessions,
          // TS-P6-006: folder kept after kick; annotate when not on live roster.
          departed: wantAll ? !liveMemberIds.has(r.memberId) : false,
          owner: r.owner,
        })),
        meta: isAdmin ? backupStore.getMeta() : undefined,
      })
      return
    }

    if (req.method === 'POST' && path === '/v1/backups') {
      if (auth.member.role === 'viewer') {
        sendJson(res, 403, { ok: false, error: 'Viewers cannot upload backups' })
        return
      }
      const len = Number(req.headers['content-length'] || 0)
      if (!Number.isFinite(len) || len <= 0 || len > MAX_BACKUP_BYTES) {
        sendJson(res, 400, { ok: false, error: 'Invalid Content-Length for backup' })
        return
      }
      const labelHdr = req.headers['x-backup-label']
      const label = typeof labelHdr === 'string' ? labelHdr : ''
      const sessionsHdr = req.headers['x-backup-include-sessions']
      const includesBrowserSessions =
        sessionsHdr === '1' || sessionsHdr === 'true'
      const shaHdr = req.headers['x-backup-sha256']
      const sha256Expected = typeof shaHdr === 'string' ? shaHdr : undefined
      const keepHdr = req.headers['x-backup-keep']
      const keepHint =
        typeof keepHdr === 'string' && /^\d{1,3}$/.test(keepHdr.trim())
          ? Number(keepHdr.trim())
          : undefined
      const owner = parseBackupMetaHeader(req.headers['x-backup-meta'])
      const put = await backupStore.putSnapshotFromStream({
        memberId,
        stream: req,
        contentLength: len,
        label,
        includesBrowserSessions,
        sha256Expected,
        keepHint,
        owner,
      })
      if (!put.ok) {
        sendJson(res, put.status ?? 400, { ok: false, error: put.error })
        return
      }
      sendJson(res, 200, {
        ok: true,
        backup: {
          id: put.snapshot.id,
          memberId: put.snapshot.memberId,
          createdAt: put.snapshot.createdAt,
          bytes: put.snapshot.bytes,
          sha256: put.snapshot.sha256,
          label: put.snapshot.label,
          includesBrowserSessions: put.snapshot.includesBrowserSessions,
          owner: put.snapshot.owner,
        },
      })
      return
    }

    if (req.method === 'PATCH' && path === '/v1/backups/meta') {
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: 'Admin session required' })
        return
      }
      try {
        const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
        const meta = backupStore.setMeta({
          maxKeepPerMember:
            typeof body.maxKeepPerMember === 'number' ? body.maxKeepPerMember : undefined,
          maxBytesPerMember:
            typeof body.maxBytesPerMember === 'number' ? body.maxBytesPerMember : undefined,
          maxBytesTeam: typeof body.maxBytesTeam === 'number' ? body.maxBytesTeam : undefined,
          minIntervalMs: typeof body.minIntervalMs === 'number' ? body.minIntervalMs : undefined,
          allowMemberDownloadOthers:
            body.allowMemberDownloadOthers === true || body.allowMemberDownloadOthers === false
              ? body.allowMemberDownloadOthers
              : undefined,
          // TCC-R1133-SET-005
          maxZipAimoves:
            typeof body.maxZipAimoves === 'number' ? body.maxZipAimoves : undefined,
        })
        sendJson(res, 200, { ok: true, meta })
      } catch (err) {
        sendCatchError(res, err)
      }
      return
    }

    // TS-P6-006: wipe entire departed-member folder (register before /:id).
    const memberFolderMatch = /^\/v1\/backups\/members\/([a-zA-Z0-9._-]{1,128})$/.exec(path)
    if (memberFolderMatch && req.method === 'DELETE') {
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: 'Admin session required' })
        return
      }
      const targetMemberId = memberFolderMatch[1] || ''
      if (!isSafeBackupMemberId(targetMemberId)) {
        sendJson(res, 400, { ok: false, error: 'Invalid member id' })
        return
      }
      const stillOnTeam = store.listMembers().some((m) => m.memberId === targetMemberId)
      if (stillOnTeam) {
        sendJson(res, 409, {
          ok: false,
          error:
            'This person is still on the team. Remove them first, or delete individual backups.',
        })
        return
      }
      const wiped = await backupStore.deleteAllForMember(targetMemberId)
      if (!wiped.ok) {
        sendJson(res, 404, { ok: false, error: wiped.error })
        return
      }
      sendJson(res, 200, {
        ok: true,
        memberId: targetMemberId,
        deletedCount: wiped.deletedCount,
        bytesFreed: wiped.bytesFreed,
      })
      return
    }

    if (req.method === 'GET' && path === '/v1/backups/export.zip') {
      if (!isAdmin) {
        sendJson(res, 403, { ok: false, error: 'Admin session required' })
        return
      }
      // TCC-R1148-BRG-005: process-wide export lease (overlapping zips OOM).
      if (!backupExportLease.tryAcquire()) {
        sendJson(res, 429, { ok: false, error: 'Another backup export is already running. Try again shortly.' })
        return
      }
      res.on('close', () => backupExportLease.release())
      const modeRaw = url.searchParams.get('mode')
      const mode = modeRaw === 'ids' ? 'ids' : 'newestPerMember'
      const idsRaw = url.searchParams.get('ids') || ''
      // TCC-R1133-SET-005: admin-raisable via PATCH /v1/backups/meta instead
      // of the bare module constant - clamped to MAX_BACKUP_ZIP_AIMOVES_HARD_CAP
      // inside backupStore.getMeta()/setMeta() regardless of what was requested.
      const maxAimoves = backupStore.getMeta().maxZipAimoves || MAX_BACKUP_ZIP_AIMOVES
      const ids = idsRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, maxAimoves)
      const picked = backupStore.pickExportEntries({ mode, ids })
      if (!picked.ok) {
        sendJson(res, 404, { ok: false, error: picked.error })
        return
      }
      if (picked.entries.length > maxAimoves) {
        sendJson(res, 400, {
          ok: false,
          error: `Too many backups (max ${maxAimoves})`,
        })
        return
      }
      // TS-CHAT-009: live chat/ via listChatBackupZipEntries (never a parallel walk).
      const chatPick = backupStore.pickChatExportEntries(MAX_BACKUP_ZIP_CHAT_ENTRIES)
      const zipEntries = [
        ...picked.entries.map((e) => ({
          name: e.name,
          size: e.size,
          absolutePath: e.absolutePath,
        })),
        ...chatPick.entries,
      ]
      if (zipEntries.length === 0) {
        sendJson(res, 404, { ok: false, error: 'No backups or team chat files on disk' })
        return
      }
      const combinedCeiling = combinedBackupZipEntryCeiling(maxAimoves)
      if (zipEntries.length > combinedCeiling) {
        sendJson(res, 400, {
          ok: false,
          error: `Too many export files (max ${combinedCeiling})`,
        })
        return
      }
      // TCC-R1145-BKP-002 / TCC-R1146-BKP-003: plan CRC+Content-Length with live ceiling.
      const planned = await planStoredBackupZip(zipEntries, { maxEntries: combinedCeiling })
      if (!planned.ok) {
        sendJson(res, 400, { ok: false, error: planned.error })
        return
      }
      const idsRequested = mode === 'ids' && Array.isArray(ids) ? ids.length : 0
      const idsTruncated = mode === 'ids' && idsRequested > maxAimoves
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-length': String(planned.contentLength),
        'content-disposition': 'attachment; filename="team-backups.zip"',
        'x-backup-export-count': String(picked.entries.length),
        'x-backup-export-chat-count': String(chatPick.entries.length),
        'x-backup-export-chat-truncated': chatPick.truncated ? '1' : '0',
        'x-backup-export-missing-ids': String(picked.missingIds + picked.missingOnDisk),
        'x-backup-export-ids-truncated': idsTruncated ? '1' : '0',
        'x-backup-export-mode': mode,
      })
      const zipped = await streamPlannedBackupZip(res, planned.planned, planned.contentLength)
      if (!zipped.ok) {
        // Headers may already be sent - destroy the socket with a trailer note.
        try {
          res.destroy(new Error(zipped.error))
        } catch {
          /* */
        }
        return
      }
      try {
        res.end()
      } catch {
        /* */
      }
      return
    }

    const oneMatch = /^\/v1\/backups\/([a-zA-Z0-9._-]{8,128})$/.exec(path)
    if (oneMatch) {
      const snapId = oneMatch[1]
      if (!isSafeBackupSnapshotId(snapId)) {
        sendJson(res, 400, { ok: false, error: 'Invalid backup id' })
        return
      }
      // Resolve owner: own index first, then (admin / allow-others) scan.
      let ownerId = memberId
      let row = backupStore.getSnapshot(memberId, snapId)
      if (!row) {
        const all = backupStore.listAll()
        const found = all.find((r) => r.id === snapId)
        if (found) {
          const meta = backupStore.getMeta()
          const may =
            isAdmin ||
            (meta.allowMemberDownloadOthers && req.method === 'GET')
          if (!may) {
            sendJson(res, 404, { ok: false, error: 'Not found' })
            return
          }
          // Non-admin may download others only when meta allows; never delete others.
          if (req.method === 'DELETE' && !isAdmin) {
            sendJson(res, 403, { ok: false, error: 'Admin session required' })
            return
          }
          ownerId = found.memberId
          row = found
        }
      }
      if (!row) {
        sendJson(res, 404, { ok: false, error: 'Not found' })
        return
      }

      if (req.method === 'GET') {
        const opened = await backupStore.openSnapshotRead(ownerId, snapId)
        if (!opened) {
          sendJson(res, 404, { ok: false, error: 'Not found' })
          return
        }
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': opened.size,
          'x-backup-sha256': opened.row.sha256,
          'x-backup-member-id': opened.row.memberId,
        })
        opened.stream.pipe(res)
        return
      }

      if (req.method === 'DELETE') {
        if (ownerId !== memberId && !isAdmin) {
          sendJson(res, 403, { ok: false, error: 'Admin session required' })
          return
        }
        const del = await backupStore.deleteSnapshot(ownerId, snapId)
        if (!del.ok) {
          sendJson(res, 404, { ok: false, error: del.error })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
    return
  }

  // --- P1-C public share (Admin session) ---
  if (req.method === 'POST' && path === '/v1/public-share/register') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeAdminHttpMutateToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - try again shortly.' })
      return
    }
    try {
      const body = (await readJsonBody(req, PAYLOAD_JSON_BODY_MAX)) as Record<string, unknown>
      const mode = body.mode === 'create' ? 'create' : body.mode === 'read' ? 'read' : null
      if (!mode) {
        sendJson(res, 400, { ok: false, error: 'mode must be read or create' })
        return
      }
      const result = publicShares.upsertShare(auth.member.memberId, {
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : '',
        localShareId: typeof body.local_share_id === 'string' ? body.local_share_id : '',
        mode,
        viewType: typeof body.view_type === 'string' ? body.view_type : 'table',
        label: typeof body.label === 'string' ? body.label : 'Shared',
        passwordHash:
          typeof body.password_hash === 'string' ? body.password_hash : null,
        includeCsv: body.include_csv === true,
        expiresAt:
          typeof body.expires_at_ms === 'number' ? body.expires_at_ms : null,
        payload: body.payload ?? body.content,
      })
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true, share: toPublicShareMeta(result.row) })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/public-share/payload') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, PAYLOAD_JSON_BODY_MAX)) as Record<string, unknown>
      const result = publicShares.setPayload({
        localShareId: typeof body.local_share_id === 'string' ? body.local_share_id : undefined,
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : undefined,
        payload: body.payload ?? body.content,
      })
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/public-share/revoke') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const result = publicShares.revokeShare({
        localShareId: typeof body.local_share_id === 'string' ? body.local_share_id : undefined,
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : undefined,
      })
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'GET' && path === '/v1/public-share/submissions') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    const limitRaw = Number(url.searchParams.get('limit') || 50)
    // TCC-R1151-BKP-001: scope to the calling Admin's shares only.
    const pending = publicShares.listPendingSubmissions(limitRaw, auth.member.memberId)
    sendJson(res, 200, {
      ok: true,
      submissions: pending.map((s) => ({
        id: s.id,
        local_share_id: s.localShareId,
        entity_id: s.entityId,
        data: s.data,
        created_at: s.createdAt,
      })),
    })
    return
  }

  if (req.method === 'POST' && path === '/v1/public-share/submissions') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const status =
        body.status === 'applied' || body.status === 'rejected' ? body.status : null
      if (!status) {
        sendJson(res, 400, { ok: false, error: 'status must be applied or rejected' })
        return
      }
      const result = publicShares.ackSubmission(
        typeof body.submission_id === 'string' ? body.submission_id : '',
        status,
        typeof body.error === 'string' ? body.error : null,
      )
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  // --- P3-D portal (Admin session) ---
  if (req.method === 'POST' && path === '/v1/portal/register') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, PAYLOAD_JSON_BODY_MAX)) as Record<string, unknown>
      const authModeRaw =
        typeof body.auth_mode === 'string' ? body.auth_mode.trim().toLowerCase() : 'anonymous'
      const authMode: PortalAuthMode =
        authModeRaw === 'pin' || authModeRaw === 'magic_link' ? authModeRaw : 'anonymous'
      const allowedActions = Array.isArray(body.allowed_actions)
        ? body.allowed_actions.filter((x): x is string => typeof x === 'string')
        : ['create']
      const result = portals.upsertPortal(auth.member.memberId, {
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : '',
        localPortalId:
          typeof body.local_portal_id === 'string' ? body.local_portal_id : '',
        name: typeof body.name === 'string' ? body.name : 'Portal',
        authMode,
        pinHash: typeof body.pin_hash === 'string' ? body.pin_hash : null,
        allowedActions,
        payload: body.payload ?? body.content,
      })
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true, portal: toPortalMeta(result.row) })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/portal/revoke') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const result = portals.revokePortal({
        localPortalId:
          typeof body.local_portal_id === 'string' ? body.local_portal_id : undefined,
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : undefined,
      })
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'GET' && path === '/v1/portal/submissions') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    const limitRaw = Number(url.searchParams.get('limit') || 50)
    // TCC-R1151-BKP-001: scope to the calling Admin's portals only.
    const pending = portals.listPendingSubmissions(limitRaw, auth.member.memberId)
    sendJson(res, 200, {
      ok: true,
      submissions: pending.map((s) => ({
        id: s.id,
        local_portal_id: s.localPortalId,
        entity_id: s.entityId,
        data: s.data,
        contact_label: s.contactLabel,
        created_at: s.createdAt,
      })),
    })
    return
  }

  if (req.method === 'POST' && path === '/v1/portal/submissions') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const status =
        body.status === 'applied' || body.status === 'rejected' ? body.status : null
      if (!status) {
        sendJson(res, 400, { ok: false, error: 'status must be applied or rejected' })
        return
      }
      const result = portals.ackSubmission({
        submissionId: typeof body.submission_id === 'string' ? body.submission_id : '',
        status,
        error: typeof body.error === 'string' ? body.error : null,
      })
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'GET' && path === '/v1/portal/otp-pending') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    const limitRaw = Number(url.searchParams.get('limit') || 50)
    const pending = portals.listPendingOtpSends(limitRaw)
    sendJson(res, 200, {
      ok: true,
      pending: pending.map((p) => ({
        id: p.id,
        token_hash: p.tokenHash,
        email: p.email,
        portal_name: p.portalName,
        code: p.codePlain,
        expires_at: p.expiresAt,
        created_at: p.createdAt,
      })),
    })
    return
  }

  if (req.method === 'POST' && path === '/v1/portal/otp-ack') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const id = typeof body.id === 'string' ? body.id : typeof body.otp_id === 'string' ? body.otp_id : ''
      const result = portals.ackOtpSend({ id })
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  // --- Compose client share link (Admin session) ---
  if (req.method === 'POST' && path === '/v1/compose-share/register') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeAdminHttpMutateToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - try again shortly.' })
      return
    }
    try {
      const body = (await readJsonBody(req, COMPOSE_SHARE_JSON_BODY_MAX)) as Record<
        string,
        unknown
      >
      const packB64 = typeof body.pack_b64 === 'string' ? body.pack_b64 : ''
      if (!packB64 || packB64.length > COMPOSE_SHARE_JSON_BODY_MAX) {
        sendJson(res, 400, { ok: false, error: 'pack_b64 is required' })
        return
      }
      let packBytes: Buffer
      try {
        packBytes = Buffer.from(packB64, 'base64')
      } catch {
        sendJson(res, 400, { ok: false, error: 'pack_b64 is not valid base64' })
        return
      }
      if (packBytes.length === 0 || packBytes.length > COMPOSE_SHARE_PACK_MAX_BYTES) {
        sendJson(res, 400, {
          ok: false,
          error: `Pack must be 1..${COMPOSE_SHARE_PACK_MAX_BYTES} bytes`,
        })
        return
      }
      const result = composeShares.upsertShare(auth.member.memberId, {
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : '',
        localShareId: typeof body.local_share_id === 'string' ? body.local_share_id : '',
        format: typeof body.format === 'string' ? body.format : 'pdf',
        watermark: typeof body.watermark === 'string' ? body.watermark : 'off',
        filename: typeof body.filename === 'string' ? body.filename : 'compose-share.pdf',
        passwordHash:
          typeof body.password_hash === 'string' ? body.password_hash : null,
        expiresAt:
          typeof body.expires_at_ms === 'number' && Number.isFinite(body.expires_at_ms)
            ? Math.floor(body.expires_at_ms)
            : null,
        packBytes,
      })
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true, share: toComposeShareMeta(result.row) })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  if (req.method === 'POST' && path === '/v1/compose-share/revoke') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeAdminHttpMutateToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - try again shortly.' })
      return
    }
    try {
      const body = (await readJsonBody(req, 64_000)) as Record<string, unknown>
      const result = composeShares.revokeShare({
        localShareId: typeof body.local_share_id === 'string' ? body.local_share_id : undefined,
        tokenHash: typeof body.token_hash === 'string' ? body.token_hash : undefined,
      })
      if (!result.ok) {
        sendJson(res, 404, { ok: false, error: result.error })
        return
      }
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  // --- Compose live co-edit ACL (TCC-FIX-CMP-001) ---
  // Admin HOST pushes the full current `sharedComposeDocIds` allowlist here
  // (replace semantics) whenever it changes AND on every reconnect, so the
  // in-memory map below always reflects the desktop source of truth even
  // after a bridge restart. See `compose-acl-store.ts` for the fail-closed
  // read side consulted by the `yjs_join` handler.
  if (req.method === 'POST' && path === '/v1/teamspace/compose-acl') {
    const auth = authFromReq(req)
    if (!auth || auth.member.role !== 'admin') {
      sendJson(res, 401, { ok: false, error: 'Admin session required' })
      return
    }
    if (!takeAdminHttpMutateToken(auth.member.memberId)) {
      drainRequestBody(req)
      sendJson(res, 429, { ok: false, error: 'Rate limited - try again shortly.' })
      return
    }
    try {
      const body = (await readJsonBody(req, COMPOSE_ACL_JSON_BODY_MAX)) as Record<string, unknown>
      const result = setComposeAclSharedDocIds(body.documentIds)
      if (!result.ok) {
        sendJson(res, 400, { ok: false, error: result.reason })
        return
      }
      sendJson(res, 200, { ok: true, count: result.count })
    } catch (err) {
      sendCatchError(res, err)
    }
    return
  }

  // --- Compose guest share link ---
  const composeShareMatch = /^\/compose\/share\/([A-Za-z0-9_-]{8,128})$/.exec(path)
  if (composeShareMatch) {
    const tokenPlain = composeShareMatch[1]
    await handleGuestComposeShare(req, res, tokenPlain)
    return
  }

  // --- P1-C guest public share ---
  const shareMatch = /^\/share\/([A-Za-z0-9_-]{8,128})$/.exec(path)
  if (shareMatch) {
    const tokenPlain = shareMatch[1]
    await handleGuestPublicShare(req, res, tokenPlain, url)
    return
  }

  // --- P3-D guest portal ---
  const portalMatch = /^\/portal\/([A-Za-z0-9_-]{8,128})$/.exec(path)
  if (portalMatch) {
    const tokenPlain = portalMatch[1]
    await handleGuestPortal(req, res, tokenPlain)
    return
  }

  sendJson(res, 404, { ok: false, error: 'Not found' })
}

const PAYLOAD_JSON_BODY_MAX = 1_600_000

function wantsJson(req: IncomingMessage): boolean {
  const accept = String(req.headers.accept || '')
  return accept.includes('application/json')
}

/**
 * Public module share guest page. One shared baseline (guest-page-theme.ts)
 * plus the shared client renderers (guest-page-render.ts): password gate,
 * create-mode form, and per-view read renderers (table/list/board/gallery,
 * date lanes, dashboard tiles; honest simplified-to-table note for the
 * rest). Payload v1 and v2 both dispatch on viewType (share.viewType fills
 * in when the payload omitted it). Object cells never print as
 * "[object Object]". English only (bridge has no CMS translations).
 */
function guestShareShellHtml(token: string): string {
  const safeTok = JSON.stringify(token)
  return guestPageDocument({
    title: 'Shared view',
    bodyHtml: '<div id="app"><p class="muted">Opening share...</p></div>',
    scriptJs: `
(function(){
  var token = ${safeTok};
  var app = document.getElementById('app');
  // A password-protected share re-checks the password on EVERY POST
  // (including create submits), so keep the unlocked password in memory for
  // the submit call - the gate input is gone once the form renders.
  var unlockedPassword = '';
  function el(html){ app.innerHTML = html; }
${GUEST_ESC_JS}
${GUEST_GATE_JS}
${GUEST_RENDER_JS}
${GUEST_FORM_FIELD_JS}
  function api(method, body){
    return fetch('/share/'+encodeURIComponent(token), {
      method: method,
      cache: 'no-store',
      headers: {'Accept':'application/json','Content-Type':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    }).then(function(r){ return r.json().then(function(j){ return {status:r.status, j:j}; }); });
  }
  function showError(message){
    el(gateHtml('Something went wrong', '', '<p class="err" style="margin:10px 0 0">' + esc(message || 'Could not open this share.') + '</p>'));
  }
  function render(data, unlocked){
    if (!data || !data.ok) { showError(data && data.error); return; }
    if (data.needs_password && !unlocked) {
      el(gateHtml('Password required',
        '<p class="muted">This link is protected. Enter the password to continue.</p>',
        '<label>Password<input id="pw" type="password" autocomplete="current-password"/></label>'
        + '<button id="go" class="btn-block">Continue</button><p id="msg" class="err" style="margin:10px 0 0"></p>'));
      var tryUnlock = function(){
        var pw = document.getElementById('pw').value;
        api('POST', { password: pw }).then(function(res){
          if (res.j && res.j.unlocked) { unlockedPassword = pw; render(res.j, true); }
          else document.getElementById('msg').textContent = (res.j && res.j.error) || 'Wrong password.';
        }).catch(function(){
          document.getElementById('msg').textContent = 'Could not reach the server. Try again.';
        });
      };
      document.getElementById('go').onclick = tryUnlock;
      document.getElementById('pw').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') tryUnlock(); });
      return;
    }
    var share = data.share || {};
    var content = data.content;
    if (!content) {
      el(pageHeadHtml(share, null) + '<div class="card"><p class="muted" style="margin:0">'
        + esc(data.note || 'Shared content is not online yet. Ask the owner to keep AItomation connected to the team server after publishing.')
        + '</p></div>');
      return;
    }
    if (!content.viewType && share.viewType) content.viewType = share.viewType;
    if (share.mode === 'create' || content.mode === 'create') {
      var fields = Array.isArray(content.fields) ? content.fields : [];
      el(pageHeadHtml(share, content) + '<div class="card" id="form">'
        + fields.map(function(f){
            var req = f.required ? '<span class="req">required</span>' : '';
            return '<label>' + esc(f.name || f.slug) + req + fieldInputHtml(f) + '</label>';
          }).join('')
        + '<button id="sub" style="margin-top:18px">Submit</button><p id="msg" style="margin:10px 0 0"></p></div>');
      document.getElementById('sub').onclick = function(){
        var btn = document.getElementById('sub');
        btn.disabled = true;
        var body = { action: 'create', data: readGuestFormFields() };
        if (unlockedPassword) body.password = unlockedPassword;
        api('POST', body).then(function(res){
          btn.disabled = false;
          var msg = document.getElementById('msg');
          if (res.j && res.j.ok && res.j.submitted) {
            msg.className = 'ok';
            msg.textContent = res.j.message || 'Thanks - your submission was received.';
          } else {
            msg.className = 'err';
            msg.textContent = (res.j && res.j.error) || 'Could not submit.';
          }
        }).catch(function(){
          btn.disabled = false;
          var msg = document.getElementById('msg');
          msg.className = 'err';
          msg.textContent = 'Could not reach the server. Try again.';
        });
      };
      return;
    }
    var readBody = renderReadBodyHtml(content);
    var rows = Array.isArray(content.rows) ? content.rows : [];
    var noteBits = [];
    if (content.truncated) {
      var total = typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
      noteBits.push(total > rows.length ? 'Showing ' + rows.length + ' of ' + total + ' rows.' : 'Showing a recent sample of rows.');
    }
    if (readBody.simplified) noteBits.push('This layout is simplified on the public page.');
    var wantCsv = (share.includeCsv || content.includeCsv) && rows.length;
    var toolbar = '';
    if (noteBits.length || wantCsv) {
      toolbar = '<div class="toolbar">'
        + (noteBits.length ? '<span class="muted">' + esc(noteBits.join(' ')) + '</span>' : '')
        + (wantCsv ? '<button id="csv" class="btn-secondary">Download CSV</button>' : '')
        + '</div>';
    }
    el(pageHeadHtml(share, content) + toolbar + readBody.html);
    if (typeof runGuestEnhancers === 'function') runGuestEnhancers(content);
    var csvBtn = document.getElementById('csv');
    if (csvBtn) csvBtn.onclick = function(){
      var blob = new Blob([csvFromContent(content)], {type:'text/csv'});
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'share.csv';
      a.click();
      setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    };
  }
  api('GET').then(function(res){ render(res.j, !!(res.j && res.j.unlocked)); }).catch(function(){
    showError('Could not reach the server. Check your connection and reload.');
  });
})();
`,
  })
}

async function handleGuestComposeShare(
  req: IncomingMessage,
  res: ServerResponse,
  tokenPlain: string,
): Promise<void> {
  const resolved = composeShares.resolveGuest(tokenPlain)
  if (!resolved.row || resolved.reason === 'not_found') {
    // Identical 404 for unknown / revoked / expired when probing - no existence leak on GET HTML.
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 404, guestErrorPageHtml('Share not found', 'This link does not exist or is no longer available.'))
      return
    }
    sendJson(res, 404, { error: 'Share not found', error_code: 'share.not_found' })
    return
  }
  if (!resolved.active) {
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 404, guestErrorPageHtml('Share not found', 'This link does not exist or is no longer available.'))
      return
    }
    sendJson(res, 404, { error: 'Share not found', error_code: 'share.not_found' })
    return
  }

  const row = resolved.row

  if (req.method === 'GET') {
    if (!wantsJson(req)) {
      const html = guestComposeShareShellHtml(tokenPlain)
      sendGuestHtml(res, 200, html)
      return
    }
    sendJson(res, 200, {
      ok: true,
      needs_password: Boolean(row.passwordHash),
      unlocked: !row.passwordHash,
      share: toComposeShareMeta(row),
    })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    const raw = await readJsonBody(req, 256_000)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      body = raw as Record<string, unknown>
    }
  } catch {
    /* empty ok */
  }

  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : ''
  const guestKey = `compose:${row.tokenHash}:${clientIp(req)}`
  // TCC-R1147-BRG-002: per-token+IP fail lockout beyond coarse takeHttpToken.
  if (row.passwordHash) {
    if (!takeGuestAuthAttempt(guestKey)) {
      releaseJsonBody(body)
      sendJson(res, 429, {
        error: 'Too many wrong password attempts. Try again later.',
        error_code: 'share.rate_limited',
      })
      return
    }
    if (!verifyComposeSharePassword(row.passwordHash, password)) {
      noteGuestAuthFailure(guestKey)
      releaseJsonBody(body)
      sendJson(res, 401, {
        error: 'Wrong password. Try again.',
        error_code: 'share.wrong_password',
      })
      return
    }
    clearGuestAuthFailures(guestKey)
  }

  const action =
    typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'download'
  if (action !== 'download' && action !== '') {
    // Only download is supported for Compose packs.
  }

  if (!takeGuestDownloadToken(clientIp(req))) {
    releaseJsonBody(body)
    sendJson(res, 429, { error: 'Rate limited - try again shortly.', error_code: 'share.rate_limited' })
    return
  }
  // TCC-R1145-BRG-002: pack download heap budget.
  const approx = Math.min(COMPOSE_SHARE_PACK_MAX_BYTES, 20 * 1024 * 1024)
  if (!tryReserveHttpDownloadBudget(approx)) {
    releaseJsonBody(body)
    sendJson(res, 503, { error: 'Server is busy. Try again shortly.', error_code: 'share.busy' })
    return
  }
  let bytes: Buffer | null = null
  try {
    bytes = composeShares.readPackBytes(row.tokenHash)
  } finally {
    releaseJsonBody(body)
  }
  if (!bytes) {
    releaseHttpDownloadBudget(approx)
    sendJson(res, 404, { error: 'Share not found', error_code: 'share.not_found' })
    return
  }
  if (bytes.length > approx) {
    // Rare: pack larger than reserve - charge the surplus or refuse.
    if (!tryReserveHttpDownloadBudget(bytes.length - approx)) {
      releaseHttpDownloadBudget(approx)
      sendJson(res, 503, { error: 'Server is busy. Try again shortly.', error_code: 'share.busy' })
      return
    }
  }
  const filename = row.filename.replace(/[^\w.\- ()[\]]+/g, '_').slice(0, 180) || 'compose-share.bin'
  const ctype =
    row.format === 'png'
      ? 'image/png'
      : row.format === 'svg'
        ? 'image/svg+xml'
        : 'application/pdf'
  const charged = Math.max(approx, bytes.length)
  res.writeHead(200, {
    'content-type': ctype,
    'content-length': String(bytes.length),
    'content-disposition': `attachment; filename="${filename}"`,
    'cache-control': 'no-store',
  })
  res.on('close', () => releaseHttpDownloadBudget(charged))
  res.end(bytes)
}

/**
 * Compose client pack guest page: one centered gate card (shared baseline)
 * with an optional password field and a Download button.
 */
function guestComposeShareShellHtml(token: string): string {
  const safeTok = JSON.stringify(token)
  return guestPageDocument({
    title: 'Client pack',
    narrow: true,
    bodyHtml: '<div id="app"><p class="muted">Opening share...</p></div>',
    scriptJs: `
(function(){
  var token = ${safeTok};
  var app = document.getElementById('app');
  function el(html){ app.innerHTML = html; }
${GUEST_ESC_JS}
${GUEST_GATE_JS}
  function meta(){
    return fetch('/compose/share/'+encodeURIComponent(token), {
      cache: 'no-store',
      headers: {'Accept':'application/json'}
    }).then(function(r){ return r.json().then(function(j){ return {status:r.status, j:j}; }); });
  }
  function download(password){
    return fetch('/compose/share/'+encodeURIComponent(token), {
      method: 'POST',
      cache: 'no-store',
      headers: {'Accept':'application/json','Content-Type':'application/json'},
      body: JSON.stringify({ password: password || '', action: 'download' })
    }).then(function(r){
      if (!r.ok) {
        return r.json().then(function(j){ throw new Error((j && j.error) || 'Download failed'); });
      }
      var cd = r.headers.get('content-disposition') || '';
      var m = /filename="([^"]+)"/.exec(cd);
      var name = m ? m[1] : 'compose-share';
      return r.blob().then(function(b){ return { blob: b, name: name }; });
    });
  }
  function save(blob, name){
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
  }
  function showError(message){
    el(gateHtml('Something went wrong', '', '<p class="err" style="margin:10px 0 0">' + esc(message || 'Could not open this share.') + '</p>'));
  }
  function showForm(needsPw){
    el(gateHtml('Client pack',
      '<p class="muted">Download the file prepared for you. This link can expire or be turned off by the sender.</p>',
      (needsPw ? '<label>Password<input id="pw" type="password" autocomplete="current-password"/></label>' : '')
      + '<button id="go" class="btn-block">Download</button><p id="msg" class="err" style="margin:10px 0 0"></p>'));
    var run = function(){
      var pw = needsPw ? (document.getElementById('pw').value || '') : '';
      var msg = document.getElementById('msg');
      msg.textContent = '';
      download(pw).then(function(res){
        save(res.blob, res.name);
        msg.className = 'muted';
        msg.textContent = 'Download started.';
      }).catch(function(err){
        msg.className = 'err';
        msg.textContent = err && err.message ? err.message : 'Could not download.';
      });
    };
    document.getElementById('go').onclick = run;
    var pwEl = document.getElementById('pw');
    if (pwEl) pwEl.addEventListener('keydown', function(ev){ if (ev.key === 'Enter') run(); });
  }
  meta().then(function(res){
    if (!res.j || !res.j.ok) {
      showError((res.j && res.j.error) || 'Share not found.');
      return;
    }
    showForm(!!res.j.needs_password);
  }).catch(function(){
    showError('Could not reach the server. Check your connection and reload.');
  });
})();
`,
  })
}

async function handleGuestPortal(
  req: IncomingMessage,
  res: ServerResponse,
  tokenPlain: string,
): Promise<void> {
  const resolved = portals.resolveGuest(tokenPlain)
  if (!resolved.row || resolved.reason === 'not_found') {
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 404, guestErrorPageHtml('Portal not found', 'This link does not exist or is no longer available.'))
      return
    }
    sendJson(res, 404, { error: 'Portal not found', error_code: 'portal.not_found' })
    return
  }
  if (!resolved.active) {
    const code = resolved.reason === 'revoked' ? 'portal.revoked' : 'portal.expired'
    const msg =
      resolved.reason === 'revoked' ? 'This portal was revoked' : 'This portal has expired'
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 410, guestErrorPageHtml('Link no longer available', `${msg}. Ask the person who sent it for a new link.`))
      return
    }
    sendJson(res, 410, { error: msg, error_code: code })
    return
  }

  const row = resolved.row
  const needsPin = row.authMode === 'pin'
  const needsOtp = row.authMode === 'magic_link'

  const sessionIdFromQuery = (reqUrl: URL): string => {
    const raw = reqUrl.searchParams.get('session_id') ?? reqUrl.searchParams.get('sessionId')
    return typeof raw === 'string' ? raw.trim().slice(0, 128) : ''
  }

  if (req.method === 'GET') {
    const reqUrl = new URL(req.url ?? '/', 'http://localhost')
    const sessionId = sessionIdFromQuery(reqUrl)
    const otpUnlocked = needsOtp ? portals.isOtpUnlocked(row.tokenHash, sessionId) : false
    // PIN mode with missing hash stays locked (needsPin true, unlocked false until verified).
    const unlocked = needsOtp ? otpUnlocked : !needsPin

    if (!wantsJson(req)) {
      const html = guestPortalShellHtml(tokenPlain)
      sendGuestHtml(res, 200, html)
      return
    }
    const content =
      unlocked && row.payloadReady ? portals.readPayload(row.tokenHash) : null
    sendJson(res, 200, {
      ok: true,
      needs_pin: needsPin,
      needs_otp: needsOtp,
      unlocked,
      auth_mode: row.authMode,
      portal: toPortalMeta(row),
      content: unlocked ? content : null,
      note:
        unlocked && !content
          ? 'This portal is registered. Form content is not online yet - ask the owner to keep AItomation connected to the team server after publishing.'
          : needsOtp && !unlocked
            ? 'Enter your email and we will send a one-time sign-in code.'
            : null,
    })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    const raw = await readJsonBody(req, 256_000)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      body = raw as Record<string, unknown>
    }
  } catch {
    /* empty ok for unlock */
  }

  const sessionId =
    typeof body.session_id === 'string'
      ? body.session_id.trim().slice(0, 128)
      : typeof body.sessionId === 'string'
        ? body.sessionId.trim().slice(0, 128)
        : ''

  const action =
    typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''

  if (needsOtp && action === 'request_otp') {
    const email =
      typeof body.email === 'string'
        ? body.email
        : typeof body.contact_email === 'string'
          ? body.contact_email
          : ''
    const requested = portals.requestOtp({
      row,
      email,
      clientIp: clientIp(req),
    })
    if (!requested.ok) {
      sendJson(res, requested.status, {
        error: requested.error,
        error_code: requested.error_code,
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      message:
        'If this email can sign in, a code was queued. Check your inbox in a few minutes.',
    })
    return
  }

  if (needsOtp && action === 'verify_otp') {
    const email =
      typeof body.email === 'string'
        ? body.email
        : typeof body.contact_email === 'string'
          ? body.contact_email
          : ''
    const otp =
      typeof body.otp === 'string'
        ? body.otp
        : typeof body.code === 'string'
          ? body.code
          : ''
    const verified = portals.verifyOtp({
      tokenHash: row.tokenHash,
      email,
      code: otp,
      sessionId,
    })
    if (!verified.ok) {
      sendJson(res, verified.status, {
        error: verified.error,
        error_code: verified.error_code,
      })
      return
    }
    const content = row.payloadReady ? portals.readPayload(row.tokenHash) : null
    sendJson(res, 200, {
      ok: true,
      unlocked: true,
      needs_otp: true,
      auth_mode: row.authMode,
      portal: toPortalMeta(row),
      content,
      note: !content
        ? 'Signed in. Form content is not online yet - ask the owner to keep AItomation connected to the team server after publishing.'
        : null,
    })
    return
  }

  const pin =
    typeof body.pin === 'string'
      ? body.pin.slice(0, 200)
      : typeof body.password === 'string'
        ? body.password.slice(0, 200)
        : ''
  if (needsPin) {
    const guestKey = `portal:${row.tokenHash}:${clientIp(req)}`
    if (!takeGuestAuthAttempt(guestKey)) {
      sendJson(res, 429, {
        error: 'Too many wrong PIN attempts. Try again later.',
        error_code: 'portal.rate_limited',
      })
      return
    }
    if (!verifyPortalPin(row.pinHash, pin)) {
      noteGuestAuthFailure(guestKey)
      sendJson(res, 401, {
        error: 'Wrong PIN. Try again.',
        error_code: 'portal.wrong_pin',
      })
      return
    }
    clearGuestAuthFailures(guestKey)
  }

  const otpUnlockEmail = needsOtp ? portals.getOtpUnlockEmail(row.tokenHash, sessionId) : null
  const otpUnlocked = needsOtp ? Boolean(otpUnlockEmail) : true
  if (needsOtp && !otpUnlocked) {
    sendJson(res, 401, {
      error: 'Sign in with your email code before submitting.',
      error_code: 'portal.otp_required',
      needs_otp: true,
    })
    return
  }

  const isCreate =
    action === 'create'
    || (body.data != null && typeof body.data === 'object' && !Array.isArray(body.data))

  if (isCreate) {
    const payload = portals.readPayload(row.tokenHash)
    if (!payload) {
      sendJson(res, 503, {
        error: 'Portal form is not ready yet',
        error_code: 'portal.payload_not_ready',
      })
      return
    }
    // TCC-R1148-BKP-002: bind guest contact to the OTP-verified email.
    const contactFromBody =
      typeof body.contact_email === 'string'
        ? body.contact_email
        : typeof body.contactEmail === 'string'
          ? body.contactEmail
          : typeof body.email === 'string'
            ? body.email
            : ''
    if (needsOtp && otpUnlockEmail) {
      const want = otpUnlockEmail
      const got = typeof contactFromBody === 'string' ? contactFromBody.trim().toLowerCase() : ''
      if (got && got !== want) {
        sendJson(res, 403, {
          error: 'Submit using the same email that received the sign-in code.',
          error_code: 'portal.otp_email_mismatch',
        })
        return
      }
    }
    const queued = portals.enqueueSubmission({
      row,
      payload,
      rawData: body.data ?? body.fields ?? {},
      contactLabel:
        needsOtp && otpUnlockEmail
          ? otpUnlockEmail
          : typeof body.contact_label === 'string'
            ? body.contact_label
            : typeof body.contactLabel === 'string'
              ? body.contactLabel
              : null,
      clientIp: clientIp(req),
    })
    if (!queued.ok) {
      sendJson(res, queued.status, {
        error: queued.error,
        error_code: queued.error_code,
        ...(queued.fieldErrors ? { field_errors: queued.fieldErrors } : {}),
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      submitted: true,
      message: 'Thanks - your submission was received.',
    })
    return
  }

  const content = row.payloadReady ? portals.readPayload(row.tokenHash) : null
  sendJson(res, 200, {
    ok: true,
    needs_pin: needsPin,
    unlocked: true,
    auth_mode: row.authMode,
    portal: toPortalMeta(row),
    content,
    note:
      !content
        ? 'This portal is registered. Form content is not online yet - ask the owner to keep AItomation connected to the team server after publishing.'
        : null,
  })
}

/**
 * External portal guest page: shared baseline, gate cards for OTP/PIN, and
 * the branded create form. The owner-authored brand chrome (logo, accent)
 * is defensively gated client-side too: logo src must be https or a base64
 * data image (mirrors the desktop writer), the first palette hex becomes
 * --guest-accent. Placeholder Tagline/Footer copy is skipped.
 */
function guestPortalShellHtml(token: string): string {
  const safeTok = JSON.stringify(token)
  return guestPageDocument({
    title: 'Portal',
    bodyHtml: '<div id="app"><p class="muted">Opening portal...</p></div>',
    scriptJs: `
(function(){
  var token = ${safeTok};
  var app = document.getElementById('app');
  var unlockedPin = '';
  var sessionId = '';
  try {
    sessionId = sessionStorage.getItem('portalSessionId') || '';
    if (!sessionId) {
      sessionId = (typeof crypto !== 'undefined' && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(24))).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join('') : (Date.now().toString(16) + Math.random().toString(16).slice(2))).slice(0, 48);
      sessionStorage.setItem('portalSessionId', sessionId);
    }
  } catch (e) {
    sessionId = (typeof crypto !== 'undefined' && crypto.getRandomValues ? Array.from(crypto.getRandomValues(new Uint8Array(24))).map(function(b){return ('0'+b.toString(16)).slice(-2)}).join('') : (Date.now().toString(16) + Math.random().toString(16).slice(2))).slice(0, 48);
  }
  function el(html){ app.innerHTML = html; }
${GUEST_ESC_JS}
${GUEST_GATE_JS}
${GUEST_RENDER_JS}
${GUEST_FORM_FIELD_JS}
  function api(method, body){
    var url = '/portal/'+encodeURIComponent(token);
    if (sessionId) url += '?session_id=' + encodeURIComponent(sessionId);
    return fetch(url, {
      method: method,
      cache: 'no-store',
      headers: {'Accept':'application/json','Content-Type':'application/json'},
      body: body ? JSON.stringify(body) : undefined
    }).then(function(r){ return r.json().then(function(j){ return {status:r.status, j:j}; }); });
  }
  function showError(message){
    el(gateHtml('Something went wrong', '', '<p class="err" style="margin:10px 0 0">' + esc(message || 'Could not open this portal.') + '</p>'));
  }
  function chrome(design, title){
    design = design || {};
    var logo = (typeof design.logoUrl === 'string' && isSafeLogoSrc(design.logoUrl))
      ? '<img src="'+esc(design.logoUrl.trim())+'" alt=""/>' : '';
    var header = esc(design.header || title || 'Portal');
    var tag = !isPlaceholderChrome(design.tagline)
      ? '<p class="tag">'+esc(String(design.tagline).trim())+'</p>' : '';
    var accent = firstAccentHex(design.palette);
    var wrap = accent
      ? '<div class="guest-branded" style="--guest-accent:'+esc(accent)+'">'
      : '<div class="guest-branded">';
    var foot = !isPlaceholderChrome(design.footer)
      ? '<p class="footer">'+esc(String(design.footer).trim())+'</p>' : '';
    return {
      head: wrap + '<div class="brand">'+logo+'<div><h1>'+header+'</h1>'+tag+'</div></div>',
      foot: foot + '</div>',
    };
  }
  function render(data, unlocked){
    if (!data || !data.ok) { showError(data && data.error); return; }
    if (data.needs_otp && !unlocked) {
      el(gateHtml('Email sign-in',
        '<p class="muted">Enter your email and we will send a one-time code.</p>',
        '<label>Email<input id="otp-email" type="email" autocomplete="email"/></label>'
        + '<button id="send-code" class="btn-block btn-secondary">Send code</button>'
        + '<label>Code<input id="otp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="8"/></label>'
        + '<button id="verify-code" class="btn-block">Verify code</button>'
        + '<p id="msg" class="muted" style="margin:10px 0 0"></p>'));
      document.getElementById('send-code').onclick = function(){
        var email = document.getElementById('otp-email').value;
        var msg = document.getElementById('msg');
        msg.className = 'muted';
        msg.textContent = 'Sending...';
        api('POST', { action: 'request_otp', email: email, session_id: sessionId }).then(function(res){
          if (res.j && res.j.ok) {
            msg.className = 'ok';
            msg.textContent = res.j.message || 'Code queued. Check your inbox.';
          } else {
            msg.className = 'err';
            msg.textContent = (res.j && res.j.error) || 'Could not send code.';
          }
        }).catch(function(){
          msg.className = 'err';
          msg.textContent = 'Could not reach the server. Try again.';
        });
      };
      document.getElementById('verify-code').onclick = function(){
        var email = document.getElementById('otp-email').value;
        var code = document.getElementById('otp-code').value;
        var msg = document.getElementById('msg');
        api('POST', { action: 'verify_otp', email: email, otp: code, session_id: sessionId }).then(function(res){
          if (res.j && res.j.ok && res.j.unlocked) render(res.j, true);
          else {
            msg.className = 'err';
            msg.textContent = (res.j && res.j.error) || 'Wrong code.';
          }
        }).catch(function(){
          msg.className = 'err';
          msg.textContent = 'Could not reach the server. Try again.';
        });
      };
      return;
    }
    if (data.needs_pin && !unlocked) {
      el(gateHtml('PIN required',
        '<p class="muted">Enter the PIN to continue.</p>',
        '<label>PIN<input id="pin" type="password" autocomplete="current-password"/></label>'
        + '<button id="go" class="btn-block">Continue</button><p id="msg" class="err" style="margin:10px 0 0"></p>'));
      var tryPin = function(){
        unlockedPin = document.getElementById('pin').value;
        api('POST', { pin: unlockedPin, session_id: sessionId }).then(function(res){
          if (res.j && res.j.unlocked) render(res.j, true);
          else document.getElementById('msg').textContent = (res.j && res.j.error) || 'Wrong PIN.';
        }).catch(function(){
          document.getElementById('msg').textContent = 'Could not reach the server. Try again.';
        });
      };
      document.getElementById('go').onclick = tryPin;
      document.getElementById('pin').addEventListener('keydown', function(ev){ if (ev.key === 'Enter') tryPin(); });
      return;
    }
    var portal = data.portal || {};
    var content = data.content;
    var title = esc(portal.name || 'Portal');
    if (!content) {
      el('<div class="page-head"><h1>'+title+'</h1></div><div class="card"><p class="muted" style="margin:0">'
        + esc(data.note || 'Portal content is not online yet.')
        + '</p></div>');
      return;
    }
    var ch = chrome(content.design, content.name || portal.name);
    var fields = Array.isArray(content.fields) ? content.fields : [];
    var actions = Array.isArray(content.allowedActions) ? content.allowedActions
      : (Array.isArray(portal.allowed_actions) ? portal.allowed_actions : ['create']);
    if (actions.indexOf('create') < 0) {
      el(ch.head + '<div class="card"><div class="empty">This portal does not accept new records.</div></div>' + ch.foot);
      return;
    }
    var form = ch.head + '<div class="card" id="form">'
      + fields.map(function(f){
        var req = f.required ? '<span class="req">required</span>' : '';
        return '<label>'+esc(f.name||f.slug)+req + fieldInputHtml(f) + '</label>';
      }).join('')
      + '<button id="sub" style="margin-top:18px">Submit</button><p id="msg" style="margin:10px 0 0"></p></div>' + ch.foot;
    el(form);
    document.getElementById('sub').onclick = function(){
      var btn = document.getElementById('sub');
      btn.disabled = true;
      var dataBag = readGuestFormFields();
      var body = { action: 'create', data: dataBag, session_id: sessionId };
      if (unlockedPin) body.pin = unlockedPin;
      api('POST', body).then(function(res){
        btn.disabled = false;
        var msg = document.getElementById('msg');
        if (res.j && res.j.ok && res.j.submitted) {
          msg.className = 'ok';
          msg.textContent = res.j.message || 'Thanks - your submission was received.';
        } else {
          msg.className = 'err';
          msg.textContent = (res.j && res.j.error) || 'Could not submit.';
        }
      }).catch(function(){
        btn.disabled = false;
        var msg = document.getElementById('msg');
        msg.className = 'err';
        msg.textContent = 'Could not reach the server. Try again.';
      });
    };
  }
  api('GET').then(function(res){ render(res.j, !!(res.j && res.j.unlocked)); }).catch(function(){
    showError('Could not reach the server. Check your connection and reload.');
  });
})();
`,
  })
}

async function handleGuestPublicShare(
  req: IncomingMessage,
  res: ServerResponse,
  tokenPlain: string,
  _url: URL,
): Promise<void> {
  const resolved = publicShares.resolveGuest(tokenPlain)
  if (!resolved.row || resolved.reason === 'not_found') {
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 404, guestErrorPageHtml('Share not found', 'This link does not exist or is no longer available.'))
      return
    }
    sendJson(res, 404, { error: 'Share not found', error_code: 'share.not_found' })
    return
  }
  if (!resolved.active) {
    const code = resolved.reason === 'revoked' ? 'share.revoked' : 'share.expired'
    const msg =
      resolved.reason === 'revoked' ? 'This share was revoked' : 'This share has expired'
    if (req.method === 'GET' && !wantsJson(req)) {
      sendGuestHtml(res, 410, guestErrorPageHtml('Link no longer available', `${msg}. Ask the person who sent it for a new link.`))
      return
    }
    sendJson(res, 410, { error: msg, error_code: code })
    return
  }

  const row = resolved.row

  if (req.method === 'GET') {
    if (!wantsJson(req)) {
      const html = guestShareShellHtml(tokenPlain)
      sendGuestHtml(res, 200, html)
      return
    }
    const unlocked = !row.passwordHash
    const content =
      unlocked && row.payloadReady ? publicShares.readPayload(row.tokenHash) : null
    sendJson(res, 200, {
      ok: true,
      needs_password: Boolean(row.passwordHash),
      unlocked,
      share: toPublicShareMeta(row),
      content: unlocked ? content : null,
      note:
        unlocked && !content
          ? 'This link is registered. Shared content is not online yet - ask the person who shared it to keep AItomation connected to the team server after publishing.'
          : null,
    })
    return
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: 'Method not allowed' })
    return
  }

  let body: Record<string, unknown> = {}
  try {
    const raw = await readJsonBody(req, 256_000)
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      body = raw as Record<string, unknown>
    }
  } catch {
    /* empty ok for unlock */
  }

  const password = typeof body.password === 'string' ? body.password.slice(0, 200) : ''
  const guestKey = `share:${row.tokenHash}:${clientIp(req)}`
  if (row.passwordHash) {
    if (!takeGuestAuthAttempt(guestKey)) {
      releaseJsonBody(body)
      sendJson(res, 429, {
        error: 'Too many wrong password attempts. Try again later.',
        error_code: 'share.rate_limited',
      })
      return
    }
    if (!verifyPublicSharePassword(row.passwordHash, password)) {
      noteGuestAuthFailure(guestKey)
      releaseJsonBody(body)
      sendJson(res, 401, {
        error: 'Wrong password. Try again.',
        error_code: 'share.wrong_password',
      })
      return
    }
    clearGuestAuthFailures(guestKey)
  }

  const action =
    typeof body.action === 'string' ? body.action.trim().toLowerCase() : ''
  const isCreate =
    action === 'create' ||
    (body.data != null && typeof body.data === 'object' && !Array.isArray(body.data))

  if (isCreate) {
    // TCC-R1147-BRG-005: guest payload read shares download heap budget.
    const approx = Math.min(PAYLOAD_JSON_BODY_MAX, 8 * 1024 * 1024)
    if (!tryReserveHttpDownloadBudget(approx)) {
      releaseJsonBody(body)
      sendJson(res, 503, {
        error: 'Server is busy. Try again shortly.',
        error_code: 'share.busy',
      })
      return
    }
    let payload: ReturnType<typeof publicShares.readPayload> = null
    try {
      payload = publicShares.readPayload(row.tokenHash)
    } finally {
      releaseHttpDownloadBudget(approx)
      releaseJsonBody(body)
    }
    if (!payload) {
      sendJson(res, 503, {
        error: 'Shared form is not ready yet',
        error_code: 'share.payload_not_ready',
      })
      return
    }
    const queued = publicShares.enqueueSubmission({
      row,
      payload,
      rawData: body.data ?? body.fields ?? {},
      clientIp: clientIp(req),
    })
    if (!queued.ok) {
      sendJson(res, queued.status, {
        error: queued.error,
        error_code: queued.error_code,
        ...(queued.fieldErrors ? { field_errors: queued.fieldErrors } : {}),
      })
      return
    }
    sendJson(res, 200, {
      ok: true,
      submitted: true,
      message: 'Thanks - your submission was received.',
    })
    return
  }

  // Prefill is applied in the guest HTML from location.search.
  // TCC-R1147-BRG-005: guest payload read shares download heap budget.
  let content: ReturnType<typeof publicShares.readPayload> = null
  if (row.payloadReady) {
    const approx = Math.min(PAYLOAD_JSON_BODY_MAX, 8 * 1024 * 1024)
    if (!tryReserveHttpDownloadBudget(approx)) {
      releaseJsonBody(body)
      sendJson(res, 503, {
        error: 'Server is busy. Try again shortly.',
        error_code: 'share.busy',
      })
      return
    }
    try {
      content = publicShares.readPayload(row.tokenHash)
    } finally {
      releaseHttpDownloadBudget(approx)
      releaseJsonBody(body)
    }
  } else {
    releaseJsonBody(body)
  }
  sendJson(res, 200, {
    ok: true,
    needs_password: Boolean(row.passwordHash),
    unlocked: true,
    share: toPublicShareMeta(row),
    content,
    note:
      !content
        ? 'This link is registered. Shared content is not online yet - ask the person who shared it to keep AItomation connected to the team server after publishing.'
        : null,
  })
}

/**
 * TS-BRG-051: optional native TLS terminate when both cert + key paths are set.
 * Prefer a reverse proxy; this path is for self-host without one.
 */
function createBridgeHttpServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): { server: HttpServer | HttpsServer; tls: boolean; scheme: 'ws' | 'wss' } {
  const certPath = String(process.env.TEAMSPACE_TLS_CERT_FILE || '').trim()
  const keyPath = String(process.env.TEAMSPACE_TLS_KEY_FILE || '').trim()
  if (certPath || keyPath) {
    if (!certPath || !keyPath) {
      console.error('[bridge] Set both TEAMSPACE_TLS_CERT_FILE and TEAMSPACE_TLS_KEY_FILE (or neither)')
      process.exit(1)
    }
    if (!existsSync(certPath) || !existsSync(keyPath)) {
      console.error('[bridge] TLS cert or key file not found')
      process.exit(1)
    }
    try {
      const cert = readFileSync(certPath)
      const key = readFileSync(keyPath)
      const server = createHttpsServer({ cert, key }, handler)
      return { server, tls: true, scheme: 'wss' }
    } catch (err) {
      console.error(`[bridge] Could not load TLS files: ${err instanceof Error ? err.message : 'error'}`)
      process.exit(1)
    }
  }
  return { server: createHttpServer(handler), tls: false, scheme: 'ws' }
}

const { server, tls: tlsEnabled, scheme: listenScheme } = createBridgeHttpServer((req, res) => {
  void handleHttp(req, res).catch((err) => {
    try {
      // TCC-R1133-BRG-001: routes that call readJsonBody with no local
      // try/catch (the rejection bubbles up to here) still need the 503 +
      // Retry-After contract, not this handler's generic 500 last-resort,
      // when the budget is what refused them. Any other uncaught error
      // (a real server bug) keeps the existing 500 behavior.
      if (err instanceof HttpBodyBudgetExhaustedError) {
        res.setHeader('Retry-After', String(err.retryAfterSec))
        sendJson(res, err.status, { ok: false, error: err.message })
        return
      }
      sendJson(res, 500, {
        ok: false,
        error: err instanceof Error ? err.message.slice(0, 200) : 'error',
      })
    } catch { /* */ }
  })
})

// TS-BRG-046: cap WS frames at the same 8 MiB the message handler refuses
// (ws default ~100 MiB would buffer before our length check).
const wss = new WebSocketServer({ server, maxPayload: WS_MAX_PAYLOAD_BYTES })
wss.on('connection', (ws, req) => {
  const connIp = clientIp(req)
  // TCC-R1150-BRG-003: refuse upgrades while draining.
  if (shuttingDown) {
    try { ws.close(1001, 'server restarting') } catch { /* */ }
    return
  }
  // TS-CX-041: refuse past hard connection cap (clients includes this socket).
  if (wss.clients.size > limitsStore.getMeta().maxLiveConnections) {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        message: 'Bridge is at capacity - try again later',
      }))
    } catch { /* */ }
    try { ws.close(1013, 'capacity') } catch { /* */ }
    return
  }
  // TCC-R1145-BRG-003: pre-auth sockets that only answer ping must still hello.
  preAuthConnectedAt.set(ws, Date.now())
  const helloDeadline = setTimeout(() => {
    if (live.has(ws)) return
    try { ws.close(1008, 'hello timeout') } catch { /* */ }
  }, PRE_AUTH_HELLO_DEADLINE_MS)
  helloDeadline.unref?.()
  ws.on('message', (data) => handleMessage(ws, data as Buffer, connIp))
  ws.on('close', () => {
    dropLiveSession(ws)
    pendingHeartbeatAck.delete(ws)
    preAuthConnectedAt.delete(ws)
    try { clearTimeout(helloDeadline) } catch { /* */ }
  })
  ws.on('error', () => {
    dropLiveSession(ws)
    try { ws.close() } catch { /* */ }
  })
  // TCC-R1134-ENT-001: fresh connection always starts "answered" so the
  // first heartbeat tick pings it rather than terminating it immediately.
  ws.on('pong', () => {
    pendingHeartbeatAck.delete(ws)
  })
})

/**
 * TCC-R1134-BRG-001: `WebSocketServer` and the underlying HTTP(S) `Server`
 * each emit their OWN 'error' event, separate from the per-connection
 * `ws.on('error', ...)` already wired inside `wss.on('connection', ...)`
 * above. A Node `EventEmitter` with no listener for 'error' THROWS
 * synchronously when that event fires - with neither of these two emitters
 * having one, a single malformed WS upgrade (bad handshake headers, a
 * client that resets the TCP connection mid-handshake, a perMessageDeflate
 * negotiation error) or a transport-level fault on the HTTP/HTTPS server
 * (e.g. EMFILE under a connection storm, a TLS record error when
 * `TEAMSPACE_TLS_CERT_FILE`/`KEY_FILE` are set) became an *uncaught
 * exception* that the `process.on('uncaughtException')` handler below turns
 * into `process.exit(1)` - one misbehaving remote client (or a transient
 * resource blip) killing the ENTIRE bridge process and every other team
 * member's live session. Both classes of error are inherently
 * per-connection-attempt and recoverable; log and keep serving everyone
 * else instead of treating them as fatal.
 */
wss.on('error', (err) => {
  console.error('[bridge] WebSocket server error (non-fatal - other connections keep serving)', err)
})
server.on('error', (err) => {
  console.error('[bridge] HTTP server error (non-fatal - other connections keep serving)', err)
})

/**
 * TCC-R1143-LIM-009 / TCC-R1149-LIM-001: when Admin lowers maxLiveConnections,
 * close oldest WS sockets until under the new cap (same 1013 capacity close
 * as refuse-new). Snapshot clients once - `wss.clients` only deletes on the
 * async `close` event, so looping on `clients.size` while `close()` is
 * pending can spin forever on the same socket.
 */
function evictSurplusLiveConnections(cap: number): number {
  const target = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0))
  const snapshot = [...wss.clients]
  const surplus = snapshot.length - target
  if (surplus <= 0) return 0
  let closed = 0
  for (const oldest of snapshot) {
    if (closed >= surplus) break
    try {
      oldest.send(JSON.stringify({
        type: 'error',
        message: 'Bridge connection limit was lowered - reconnect if needed',
      }))
    } catch { /* */ }
    try { oldest.terminate() } catch {
      try { oldest.close(1013, 'capacity') } catch { /* */ }
    }
    // Ensure maps drop even if the close event is delayed.
    dropLiveSession(oldest)
    closed += 1
    if (closed > 20_000) break
  }
  return closed
}

/**
 * TCC-R1143-LIM-009: when Admin lowers yjsRoomMaxPeers, kick oldest peers
 * out of each over-capacity room (leave room + yjs_refuse; keep the WS so
 * other rooms on that socket stay live). Matches join-time refusal copy.
 */
function evictSurplusYjsPeers(cap: number): number {
  const target = Math.max(0, Math.floor(Number.isFinite(cap) ? cap : 0))
  let kicked = 0
  for (const [room, peers] of yjsRooms) {
    while (peers.size > target) {
      const oldest = peers.values().next().value as WebSocket | undefined
      if (!oldest) break
      leaveYjsRoom(oldest, room)
      try {
        oldest.send(JSON.stringify({
          type: 'yjs_refuse',
          room,
          reason: 'Too many people have this document open right now. Try again shortly.',
        }))
      } catch { /* */ }
      kicked += 1
      if (kicked > 20_000) return kicked
    }
  }
  return kicked
}

/** TCC-R1150-LIM-003: when Admin lowers maxRoomMembers, trim surplus non-owner members. */
function evictSurplusRoomMembers(cap: number): number {
  const target = Math.max(2, Math.floor(Number.isFinite(cap) ? cap : 2))
  let removedTotal = 0
  for (const row of chatRooms.listAllOpenRooms()) {
    if (row.kind === 'team' || row.kind === 'dm') continue
    if (row.memberIds.length <= target) continue
    const res = chatRooms.trimMembersToCap(row.id, target)
    if ('error' in res || res.removed.length === 0) continue
    removedTotal += res.removed.length
    fanoutChatRoomMembersPeer(null, row.id, { alsoNotifyMemberIds: res.removed })
    if (res.removed.length > 0) {
      fanoutChatRoomClosePeer(null, row.id, res.removed)
      for (const mid of res.removed) {
        try { chatUnread.wipeMemberRoom(mid, row.id) } catch { /* */ }
      }
    }
  }
  return removedTotal
}

/** TCC-R1144-LIM-005: push public chat caps to every live socket after Admin PATCH. */
function fanoutChatCapsPeer(meta: { voiceMessageMaxSec: number; chatEditWindowSec: number }): void {
  const chatCaps = {
    voiceMessageMaxSec: meta.voiceMessageMaxSec,
    chatEditWindowSec: meta.chatEditWindowSec,
  }
  for (const [peerWs] of live) {
    try {
      reply(peerWs, { type: 'chat_caps', chatCaps })
    } catch { /* */ }
  }
}

// Wired after wss exists so PATCH can evict surplus immediately (not next-join only).
limitsStore.onChange((meta) => {
  const closed = evictSurplusLiveConnections(meta.maxLiveConnections)
  const kicked = evictSurplusYjsPeers(meta.yjsRoomMaxPeers)
  const roomEvicted = evictSurplusRoomMembers(meta.maxRoomMembers)
  fanoutChatCapsPeer(meta)
  if (closed > 0 || kicked > 0 || roomEvicted > 0) {
    console.log(
      `[bridge] limits lowered - evicted ${closed} live connection(s), kicked ${kicked} yjs peer(s), trimmed ${roomEvicted} room member(s)`,
    )
  }
})

/**
 * TCC-R1134-BRG-004: these two handlers used to call `process.exit(1)`
 * directly - completely bypassing the graceful-drain path added below by
 * TCC-R1134-BRG-002. An uncaught exception is exactly the kind of event a
 * long-running unattended bridge is most likely to hit (a bad upstream
 * library throw, a null deref in a rarely-exercised branch), and it used to
 * hard-reset every connected team member's WS socket with zero notice - the
 * one scenario BRG-002 exists to prevent, silently un-prevented for the
 * single most likely crash trigger. `gracefulShutdown()` is safe to reuse
 * here even though the process may be in a degraded state: every step
 * (notify, close, wss.close, server.close) is already wrapped in try/catch
 * and the whole sequence is bounded by `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, so it
 * cannot hang or throw again - it can only get every reachable client a
 * clean close code before the process exits, same as a real crash-restart
 * quorum would want. Exit code 1 is preserved through the drain (instead of
 * BRG-002's normal 0) so an external process supervisor (systemd/PM2/Docker
 * restart policies keyed on non-zero exit) still sees this as an abnormal
 * exit and restarts the bridge - draining connections gracefully must never
 * quietly turn a real crash into what looks like a clean stop.
 */
process.on('uncaughtException', (err) => {
  console.error('[bridge] uncaughtException', err)
  gracefulShutdown('uncaughtException', 1)
})
process.on('unhandledRejection', (err) => {
  console.error('[bridge] unhandledRejection', err)
  gracefulShutdown('unhandledRejection', 1)
})

const maintenanceInterval = setInterval(() => {
  // TCC-R1144-BKP-007: periodic backup .part GC (boot-only left crash orphans forever).
  try {
    const n = backupStore.cleanupPartials()
    if (n > 0) console.log(`[bridge] backup partial sweep removed=${n}`)
  } catch { /* */ }
  void store.pruneOps().then((n) => {
    if (n > 0) console.log(`[bridge] pruned ${n} ops`)
  }).catch(() => { /* */ })
  void chatStore.prune().then(async (n) => {
    if (n > 0) console.log(`[bridge] pruned ${n} chat lines`)
    const m = snapshotChatMetrics()
    console.log(
      `[bridge] chat metrics appended=${m.messagesAppended} edited=${m.messagesEdited} deleted=${m.messagesDeleted} reactions=${m.reactions} searches=${m.searchQueries} quotaRefusals=${m.quotaRefusals}`,
    )
    // TS-CHAT-014 + TCC-R1144-MEDIA-002: keep-set GC after prune so retention
    // and soft-delete tombs actually free registered attachment bytes.
    try {
      const keepBlobs = await chatStore.collectLiveBlobShas()
      const blobGc = chatBlobs.gc(keepBlobs)
      if (blobGc.removedFiles > 0 || blobGc.removedRows > 0) {
        console.log(
          `[bridge] chat blob gc files=${blobGc.removedFiles} rows=${blobGc.removedRows}`,
        )
      }
    } catch { /* */ }
    // TCC-R1147-MEDIA-005: hourly tmp/*.part sweep (boot-only was insufficient).
    try {
      const tmpN = cleanupChatTmpFiles(DATA_DIR)
      if (tmpN > 0) console.log(`[bridge] chat tmp sweep removed=${tmpN}`)
    } catch { /* */ }
  }).catch(() => { /* */ })
  try {
    const keepAvatars = new Set<string>()
    for (const m of store.listMembers()) {
      const ref = m.avatarRef
      if (isTeamChatAvatarBlobSha(ref)) keepAvatars.add(String(ref).toLowerCase())
    }
    // P2: custom room icons reuse this SAME content-addressed blob store
    // (TS-CHAT-012/013 pipeline) - without this, GC would treat every
    // uploaded room icon as unreferenced and delete it from under live rooms.
    for (const room of chatRooms.listAllOpenRooms()) {
      if (room.iconKind === 'custom' && isTeamChatAvatarBlobSha(room.iconRef)) {
        keepAvatars.add(String(room.iconRef).toLowerCase())
      }
    }
    const avGc = chatAvatars.gc(keepAvatars)
    if (avGc.removedFiles > 0) {
      console.log(`[bridge] chat avatar gc files=${avGc.removedFiles}`)
    }
  } catch { /* */ }
  // TS-SHOP-003: periodic prune even when take() is quiet.
  helloLimiter.prune()
  inviteLimiter.prune()
  blobLimiter.prune()
  backupLimiter.prune()
  httpLimiter.prune()
  // TCC-R1134-BRGLIM-001: yjsLimiter/chatLimiter are also unbounded-size
  // TokenBucketLimiter maps keyed by memberId - prune them on the same
  // schedule as every sibling limiter above (chatLimiter had no periodic
  // prune call anywhere before this fix). Keep these two immediately after
  // httpLimiter so source-scan pins (600-char window) stay green.
  yjsLimiter.prune()
  chatLimiter.prune()
  preAuthWsLimiter.prune()
  rosterLimiter.prune()
  adminMutateLimiter.prune()
  adminHttpMutateLimiter.prune()
  guestDownloadLimiter.prune()
  ackOpsLimiter.prune()
  adminRecoveryLimiter.prune()
  try { store.cleanupBlobPartials() } catch { /* */ }
}, 60 * 60 * 1000)
maintenanceInterval.unref?.()

/**
 * TCC-R1134-ENT-001: server-initiated WS ping/pong heartbeat - see the doc
 * comment on `PRESENCE_HEARTBEAT_INTERVAL_MS` (throughput.ts) and
 * `pendingHeartbeatAck` (near the `live` map above) for the full ghost-
 * presence problem this closes. Every tick: a socket still owing a pong
 * from the PREVIOUS tick never answered in time and is terminated (its own
 * `close` handler then runs the normal `dropLiveSession` presence-leave
 * fanout); every other live socket is pinged and marked pending for the
 * next tick. Applies to every entry in `wss.clients` (including sockets
 * that connected but never completed `hello`), not just authenticated
 * `live` sessions, so a dead pre-auth socket cannot sit forever counting
 * against `MAX_LIVE_CONNECTIONS` either.
 */
const heartbeatInterval = setInterval(() => {
  let reaped = 0
  for (const ws of wss.clients) {
    if (pendingHeartbeatAck.has(ws)) {
      reaped++
      try { ws.terminate() } catch { /* */ }
      continue
    }
    pendingHeartbeatAck.add(ws)
    try { ws.ping() } catch { /* */ }
  }
  if (reaped > 0) {
    console.log(`[bridge] presence heartbeat reaped ${reaped} unresponsive socket(s)`)
  }
}, PRESENCE_HEARTBEAT_INTERVAL_MS)
heartbeatInterval.unref?.()

/**
 * TCC-R1134-BRG-002: prior to this fix the bridge had NO SIGTERM/SIGINT
 * listener at all. Node's default action for an unhandled SIGTERM is to
 * terminate the process immediately with zero cleanup - for a server meant
 * to run unattended for months, every routine restart (a self-hoster's
 * `systemctl restart`, a Docker/PM2 redeploy, a host reboot script, or even
 * `Ctrl+C` during manual `pnpm start`) hard-kills every live WS connection
 * with no notice and no chance for in-flight async work to settle. Durable
 * writes on this bridge already go through atomic write-temp+rename
 * (`atomicWriteJson` and friends), so a mid-write kill cannot corrupt the
 * FINAL on-disk file - but it can still: (a) leave connected clients with a
 * hard socket reset instead of a clean close (slower reconnect - some WS
 * clients back off longer on an abnormal close than a clean one), and (b)
 * abandon an in-flight HTTP upload/response mid-stream. Drain instead: stop
 * accepting new WS upgrades, notify + cleanly close every live WS socket,
 * stop the HTTP(S) server from accepting new connections and let any
 * already-in-flight HTTP request finish, then exit - all bounded by a hard
 * timeout so one stuck keep-alive connection can never wedge a restart
 * forever (`server.close()`'s callback does not fire until every open
 * socket, including idle keep-alive ones, has closed).
 */
let shuttingDown = false
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = Math.max(
  1_000,
  Math.min(60_000, Number(process.env.TEAMSPACE_SHUTDOWN_TIMEOUT_MS || 5_000) || 5_000),
)

/**
 * TCC-R1134-BRG-004: `exitCode` defaults to 0 for a routine signal-driven
 * stop, but callers reporting a genuine failure (uncaughtException /
 * unhandledRejection) pass 1 so an external process supervisor still sees a
 * non-zero exit and restarts the bridge - graceful draining must never
 * disguise a real crash as a clean stop.
 */
function gracefulShutdown(signal: string, exitCode = 0): void {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`[bridge] received ${signal} - draining ${live.size} live connection(s) before exit (code ${exitCode})`)
  try { clearInterval(maintenanceInterval) } catch { /* */ }
  try { clearInterval(heartbeatInterval) } catch { /* */ }
  try { store.flushAcksPersist() } catch { /* */ }

  // TCC-R1144-BRG-004: notify+close EVERY wss.clients entry (incl. pre-auth),
  // not only the authenticated `live` map.
  for (const ws of wss.clients) {
    try {
      ws.send(JSON.stringify({ type: 'error', message: 'Bridge is restarting - reconnect shortly' }))
    } catch { /* */ }
    try { ws.close(1001, 'server restarting') } catch { /* */ }
  }

  // Stop accepting new WS upgrades / new HTTP connections immediately.
  try { wss.close() } catch { /* */ }

  const forceExitTimer = setTimeout(() => {
    console.warn(`[bridge] graceful shutdown did not finish within ${GRACEFUL_SHUTDOWN_TIMEOUT_MS}ms - forcing exit`)
    process.exit(exitCode)
  }, GRACEFUL_SHUTDOWN_TIMEOUT_MS)
  forceExitTimer.unref?.()

  try {
    server.close(() => {
      clearTimeout(forceExitTimer)
      console.log('[bridge] shutdown complete')
      process.exit(exitCode)
    })
  } catch {
    clearTimeout(forceExitTimer)
    process.exit(exitCode)
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

server.listen(PORT, BIND_HOST, () => {
  const displayHost = BIND_HOST === '0.0.0.0' || BIND_HOST === '::' ? '127.0.0.1' : BIND_HOST
  console.log(`[bridge] Team Space bridge listening on ${listenScheme}://${displayHost}:${PORT} (bind ${BIND_HOST}${tlsEnabled ? ', TLS' : ''})`)
  if (BIND_HOST === '0.0.0.0' || BIND_HOST === '::') {
    console.warn('[bridge] Bound on all interfaces - prefer a firewall and wss:// for any public network')
  }
  if (!tlsEnabled && BIND_HOST !== '127.0.0.1' && BIND_HOST !== '::1') {
    console.warn('[bridge] Plaintext listen on a non-loopback bind - set TEAMSPACE_TLS_CERT_FILE + TEAMSPACE_TLS_KEY_FILE or terminate TLS in front')
  }
  console.log(`[bridge] data dir: ${DATA_DIR} (${DATA_DIR_CONFIGURED ? 'configured' : 'DEFAULTED from the current folder'})`)
  if (!DATA_DIR_CONFIGURED) {
    console.warn(
      '[bridge] the data folder was not configured, so it was guessed from the folder'
        + ' this process happens to be running in.'
        + ' A service started without a working folder set, or a deploy that unpacks each release'
        + ' into a new folder, gets a DIFFERENT data folder every restart - each one starts an'
        + ' empty team and leaves the real one behind. Set TEAMSPACE_DATA_DIR to an absolute path.',
    )
  }
  /**
   * BRGTEAM-001: say which team this process is serving. An operator who sees
   * "no team" here on a server that should have one has found their bug in one
   * line, instead of discovering a duplicate team in someone's roster later.
   */
  if (teamAtBoot) {
    console.log(
      `[bridge] team: ${teamAtBoot.teamId} "${teamAtBoot.name}"`
        + ` (created ${new Date(teamAtBoot.createdAt).toISOString()}, loaded from ${DATA_DIR})`,
    )
  } else {
    console.warn(
      `[bridge] no team yet - no team.json in ${DATA_DIR}, so the first computer that connects`
        + ' becomes Admin of a brand-new team. If you expected an existing team, stop now and'
        + ' check that this is the folder holding your data - a new team here does NOT reach the old one.',
    )
  }
  if (store.atRest) {
    console.log(`[bridge] at-rest encryption on (key fp ${atRestKeyFingerprint(store.atRest)}) - covers CRM/chat/compose op logs, blobs, chat attachments/avatars, and compose share packs`)
  } else {
    console.warn('[bridge] at-rest encryption off - CRM op log, blobs, chat attachments/avatars, and compose share packs are plaintext on disk (set TEAMSPACE_AT_REST_KEY or encrypt the volume)')
  }
  /**
   * Admin recovery discoverability. A self-hoster reads their server through
   * `docker logs`, so the location always goes to the log.
   *
   * The key VALUE is printed only on the boot that generated it. That is the one
   * moment nobody could have read it yet, and it keeps a password-equivalent
   * secret out of every later log line (log files get shipped to aggregators,
   * pasted into support threads, and kept far longer than the container). On
   * every later boot the file stays the durable source of truth, so the operator
   * reads it from the volume instead.
   */
  if (adminRecoveryKey.source === 'env') {
    console.log(
      `[bridge] admin recovery key: set from ${ADMIN_RECOVERY_ENV_VAR}` +
        ` (fingerprint ${adminRecoveryKeyFingerprint(adminRecoveryKey)})`,
    )
  } else if (adminRecoveryKey.source === 'generated') {
    console.warn(
      `[bridge] admin recovery key generated (printed once - save it now): ${adminRecoveryKey.secret}`,
    )
    console.log(
      `[bridge] admin recovery key saved to ${adminRecoveryKey.path} (owner read/write only).` +
        ' Use it in the app when you lose access to your own Admin account.',
    )
  } else {
    console.log(
      `[bridge] admin recovery key: ${adminRecoveryKey.path}` +
        ` (fingerprint ${adminRecoveryKeyFingerprint(adminRecoveryKey)}).` +
        ` Set ${ADMIN_RECOVERY_ENV_VAR} to pin your own instead.`,
    )
  }
  for (const warning of adminRecoveryKey.warnings) {
    console.warn(`[bridge] ${warning}`)
  }
  console.log(`[bridge] op retention: ${RETENTION_DAYS} days`)
  const liveChat = chatMeta.get()
  console.log(
    `[bridge] chat retention: ${liveChat.retentionDays} days (env seed ${CHAT_RETENTION_DAYS}; Admin may override)`,
  )
  console.log(
    `[bridge] chat quotas: files=${liveChat.chatFilesBytes} blobs=${liveChat.chatBlobsBytes}`,
  )
})
