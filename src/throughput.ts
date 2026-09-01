/**
 * Team Space bridge throughput defaults (self-host catch-up).
 *
 * Design: every connected device may backlog offline edits. Local SQLite on
 * each desktop always accepts writes into the outbox; the bridge drains and
 * fans those ops out without tiny token buckets that stall a busy reconnect.
 * Caps still bound a runaway client. Defaults target a single self-hosted
 * team within a bounded op-log window - not hosted multi-tenant SaaS and not
 * a guarantee for every org size / infinite offline history.
 *
 * Override via env when self-hosting (see docs/SELF-HOST.md).
 */

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** Closed `true`/`false` (case-insensitive) parse - anything else keeps `fallback` (fail closed for off-by-default flags). */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const s = raw.trim().toLowerCase()
  if (s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return fallback
}

/** Ops accepted in one WS `ops` frame (remainder stays on the client outbox). */
export const MAX_OPS_PER_FRAME = envInt('TEAMSPACE_MAX_OPS_PER_FRAME', 500, 50, 5_000)

/**
 * Incoming WS frame ceiling (bytes). Lockstep with `WebSocketServer`
 * `maxPayload` and the post-hello `handleMessage` length check (BRG-046 /
 * BRG-061). Count-only batches of 500 can still exceed this when records
 * are fat (SEO-class pages).
 */
export const WS_MAX_PAYLOAD_BYTES = envInt(
  'TEAMSPACE_WS_MAX_PAYLOAD_BYTES',
  8_000_000,
  1_000_000,
  32_000_000,
)

/**
 * JSON budget for the `ops` array inside one frame. Leaves headroom under
 * `WS_MAX_PAYLOAD_BYTES` for the envelope. Desktop `TEAMSPACE_OPS_FRAME_MAX_BYTES`
 * must stay in the same ballpark (TS-OUT-042).
 */
export const OPS_FRAME_MAX_BYTES = envInt(
  'TEAMSPACE_OPS_FRAME_MAX_BYTES',
  6_000_000,
  256_000,
  16_000_000,
)

/**
 * How many ops frames one session may send per refill window.
 * Default 120 frames / 10s ≈ 12 frames/sec × 500 ops = 6_000 ops/sec peak
 * per device before the token bucket waits - enough to drain multi-hour
 * offline imports without looking "stuck", still finite against abuse.
 */
export const OPS_FRAME_TOKENS_PER_WINDOW = envInt('TEAMSPACE_OPS_FRAME_TOKENS', 120, 10, 2_000)

/** Refill window for the per-session ops-frame token bucket (ms). */
export const OPS_FRAME_WINDOW_MS = envInt('TEAMSPACE_OPS_FRAME_WINDOW_MS', 10_000, 1_000, 60_000)

/** Catch-up replay window when a device reconnects (op-log tail). */
export const RECENT_OPS_CATCHUP_LIMIT = envInt('TEAMSPACE_RECENT_OPS_LIMIT', 5_000, 100, 50_000)

/**
 * BRG-059: progress-log interval while streaming the durable log (not a
 * send stop). Catch-up keeps going until every unacked op is sent.
 */
export const FULL_OPS_CATCHUP_LIMIT = envInt(
  'TEAMSPACE_FULL_OPS_CATCHUP_LIMIT',
  200_000,
  5_000,
  1_000_000,
)

/**
 * Max op ids stamped acked in one `ack_ops` / markAcked call.
 * Desktop `sendAckOps` chunks at the same default - keep them in lockstep
 * (or the server silently drops the tail and catch-up re-fans forever).
 */
export const ACK_IDS_PER_CALL = envInt('TEAMSPACE_ACK_IDS_PER_CALL', 2_000, 100, 20_000)

/**
 * BRG-068: a registered device with no last-seen stamp (or inferred ack)
 * older than this many days drops out of prune quorum so retention can
 * drop lines that device never acked. Floor is the 21-day catch-up
 * window. Default 90. Ceiling 3650 (10 years).
 */
export const TEAMSPACE_DEVICE_STALE_DAYS = envInt('TEAMSPACE_DEVICE_STALE_DAYS', 90, 21, 3650)

/** TS-BRG-008: hello attempts per IP per window (connection / auth storm). */
export const HELLO_TOKENS_PER_WINDOW = envInt('TEAMSPACE_HELLO_TOKENS', 30, 5, 500)

/**
 * Admin recovery attempts per IP per `ADMIN_RECOVERY_WINDOW_MS`.
 *
 * This is a password-equivalent endpoint, so it gets its own budget that is far
 * stricter than the ordinary hello budget (30 per 10 s) and is NOT shared with
 * it. Because the token bucket only refills once the whole window has elapsed,
 * spending the budget is a hard lockout for the rest of the window rather than a
 * slow drip - 5 tries per 15 minutes is 480 per day, against a 256-bit generated
 * key, so guessing is not a threat model. Five is also enough for a real operator
 * to fat-finger a paste a few times.
 */
export const ADMIN_RECOVERY_TOKENS_PER_WINDOW = envInt('TEAMSPACE_ADMIN_RECOVERY_TOKENS', 5, 1, 50)

/** Lockout window for `ADMIN_RECOVERY_TOKENS_PER_WINDOW` (default 15 minutes). */
export const ADMIN_RECOVERY_WINDOW_MS = envInt(
  'TEAMSPACE_ADMIN_RECOVERY_WINDOW_MS',
  15 * 60_000,
  60_000,
  24 * 60 * 60_000,
)

/** TS-BRG-008: invite create / list / revoke actions per member key per window. */
export const INVITE_TOKENS_PER_WINDOW = envInt('TEAMSPACE_INVITE_TOKENS', 20, 5, 200)

/** TS-BRG-008: blob upload/download actions per session per window. */
export const BLOB_TOKENS_PER_WINDOW = envInt('TEAMSPACE_BLOB_TOKENS', 60, 10, 1_000)

/**
 * P6: backup list/upload/download/delete per session per window.
 * Uploads are infrequent; keep lower than blobs so a storm cannot fill disk.
 */
export const BACKUP_TOKENS_PER_WINDOW = envInt('TEAMSPACE_BACKUP_TOKENS', 20, 5, 200)

/** TS-BRG-008: HTTP redeem / misc requests per IP per window. */
export const HTTP_TOKENS_PER_WINDOW = envInt('TEAMSPACE_HTTP_TOKENS', 60, 10, 1_000)

/**
 * TCC-R1125-WS-001: bridge-side twin of the desktop-only
 * `isYjsRoomAllowedByFlags` gate (`electron/modules-sync/yjs-room-gate.ts`).
 * Both Doc/Whiteboard and Compose live co-edit are experimental and default
 * OFF on the client (`TEAMSPACE_KEY_YJS_DOC_WHITEBOARD` /
 * `TEAMSPACE_KEY_YJS_COMPOSE`), but that is a PER-USER local Setting the
 * client itself enforces - the bridge previously joined any authenticated
 * socket to any `yjs:*` room with no server-side opinion at all, so a stale
 * build, a compromised/modified client, or a raw WS client speaking the
 * protocol directly could join and read/write live-edit rooms the
 * self-hoster never intended to expose. These env flags are the
 * server-operator's kill switch: OFF (matching the client default) means the
 * bridge refuses every `yjs_join` for that room class regardless of what any
 * individual client claims locally, fail-closed until the self-hoster
 * explicitly turns the surface on server-wide.
 */
export const TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED = envBool(
  'TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED',
  false,
)
/** See `TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED` - same contract, Compose co-edit rooms. */
export const TEAMSPACE_YJS_COMPOSE_ENABLED = envBool('TEAMSPACE_YJS_COMPOSE_ENABLED', false)

/**
 * TCC-R1133-WS-001: `chat_rooms_list` fans out one `readRecent` (full
 * `scanRoomFile`, up to `MAX_LINES_SCAN` lines each) per visible room. With
 * no cap, a member visible to hundreds/thousands of rooms (or a reconnect
 * storm re-requesting the list) can pin the event loop scanning every room
 * file back-to-back in one unbounded `Promise.all`. Bound how many room
 * scans run concurrently per `chat_rooms_list` call; the rest queue behind
 * the pool instead of firing all at once. 8 concurrent full-file scans keeps
 * disk I/O and single-threaded JSON/decrypt work bounded per call while
 * still draining a typical (<100 room) roster in a couple of batches.
 */
export const CHAT_ROOMS_LIST_SCAN_CONCURRENCY = envInt(
  'TEAMSPACE_CHAT_ROOMS_LIST_SCAN_CONCURRENCY',
  8,
  1,
  64,
)

/**
 * TCC-R1133-BRG-001: process-wide ceiling on total bytes currently buffered
 * in memory across all in-flight HTTP request bodies (chat/compose blob
 * uploads, JSON bodies, etc - every `readBodyBytes`/`readJsonBody` caller).
 * Each individual upload is already capped per-route (e.g. 25 MiB chat / 28
 * MiB compose attachments), but with NO process-wide budget those per-route
 * caps only bound one request - hundreds of parallel uploads from distinct
 * sessions each buffering up to their own per-route max can still multiply
 * into multi-GiB resident heap and OOM the bridge process. Default 256 MiB
 * is generous for a single self-hosted team's simultaneous uploads while
 * still bounding worst-case resident memory for this budget to a fraction
 * of a typical small VPS's RAM; self-hosters with more headroom (or more
 * concurrent members) can raise it.
 */
export const MAX_INFLIGHT_HTTP_BODY_BYTES = envInt(
  'TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES',
  256 * 1024 * 1024,
  8 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
)

/**
 * BRG-069: per-member share of the same HTTP body heap question.
 * Binary uploads only (avatar, chat attach, CRM). Four concurrent 25 MiB
 * desktop defaults are 100 MiB; a 64 MiB share would 503 the host.
 * Default 128 MiB. Floor is 28_000_000 so one compose-sized body can
 * still reserve when the route passes memberId. Blank memberId stays
 * process-only (guest JSON and other unauthenticated readers).
 */
export const MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER = envInt(
  'TEAMSPACE_MAX_INFLIGHT_HTTP_BODY_BYTES_PER_MEMBER',
  128 * 1024 * 1024,
  28_000_000,
  4 * 1024 * 1024 * 1024,
)

/**
 * TCC-R1133-WS-002: `readRecentOps()` streams and decrypts the WHOLE
 * `ops.jsonl` file on every call - it has no global concurrency/shared-read
 * gate, so a reconnect storm (many devices/IPs sending `hello` within a
 * short window, e.g. after a bridge restart or a network blip) independently
 * fires one full-file scan per hello, multiplying disk I/O and per-line
 * decrypt CPU work on the single-threaded event loop. `readRecentOps()`
 * coalesces concurrent/near-concurrent calls into ONE real scan (single-
 * flight while a scan is in flight; TTL reuse of the last completed result
 * for calls that land shortly after) - this window bounds how stale a
 * catch-up read can be, so keep it short relative to `OPS_FRAME_WINDOW_MS`.
 * A device that misses a very recent op due to this window still catches up
 * on its next `hello` retry (already a documented best-effort contract).
 */
export const RECENT_OPS_SHARED_READ_WINDOW_MS = envInt(
  'TEAMSPACE_RECENT_OPS_SHARED_READ_WINDOW_MS',
  2_000,
  250,
  30_000,
)

/**
 * TCC-R1133-WS-003: presence join fanout on every `hello` was O(live) with
 * no coalesce - a full reconnect storm (N devices reconnecting close
 * together, e.g. after a bridge restart) produced O(N^2) `presence_peer`
 * frames (each of the N hellos individually fanning out to the other N-1
 * live sockets). Batch join/leave notifications behind a short coalescing
 * window: multiple presence changes inside this window collapse into ONE
 * fanout pass (a fresh `presence_snapshot` broadcast) instead of one fanout
 * per change. The newly-connected socket itself still gets its own
 * `presence_snapshot` immediately on `hello_ok` (no delay) - only the
 * broadcast to OTHER already-connected members is coalesced.
 */
export const PRESENCE_JOIN_COALESCE_MS = envInt(
  'TEAMSPACE_PRESENCE_JOIN_COALESCE_MS',
  300,
  0,
  5_000,
)

/**
 * TCC-R1134-CMP-021: max sockets allowed to join ONE Yjs room (co-editors on
 * one Doc/Whiteboard/Compose board) at the same time. `fanoutYjsUpdate` /
 * `fanoutYjsAwareness` loop over every peer in the room on EVERY message a
 * co-editor sends - with no per-room cap, a team-wide "everyone opens the
 * same popular board" moment (e.g. right after an announcement) turns each
 * editor's normal edit/cursor traffic into O(n) fanout writes per message,
 * i.e. O(n^2) bridge-wide work for that one room as n grows. `YJS_ROOMS_PER_SOCKET_MAX`
 * already bounds how many rooms one socket can join; this bounds the other
 * axis (how many sockets one room can hold). Default 40 is generous for real
 * live co-editing (cursor/CRDT awareness is a small-group feature) while
 * still bounding worst-case per-room fanout for a self-hosted team of any
 * size; self-hosters with more headroom can raise it via env.
 */
export const YJS_ROOM_MAX_PEERS = envInt('TEAMSPACE_YJS_ROOM_MAX_PEERS', 40, 5, 500)

/**
 * TCC-R1133-BRG-003 / TCC-R1133-TLS-003 / TCC-R1134-CONC-001: hard cap on
 * concurrent WebSocket sessions per bridge process. This USED to be a local
 * `const` in `server.ts` that silently hard-clamped
 * `TEAMSPACE_MAX_WS_CONNECTIONS` to 500 no matter what value a self-hoster
 * set - a larger self-hosted deployment (or a company running one bridge
 * process for a big org) could not raise the real ceiling past 500 even
 * though the docs implied the env var was the authority. Moved into the
 * shared `envInt` helper (same pattern as every other throughput ceiling in
 * this file) with a much higher real max - 500 concurrent WS connections is
 * a small fraction of what a single Node.js process can hold open, and
 * self-hosters explicitly asking for headroom (env-set, not the default)
 * should get it.
 *
 * Default raised 64 -> 200 (TCC-R1134-CONC-001): a fresh self-host with no
 * env override must comfortably admit a 100+ person team out of the box -
 * each member typically opens at least one desktop-app WS connection, and
 * many keep a second window/device connected, so 64 refused real teams at
 * exactly the concurrency level this product explicitly targets. 200 gives
 * ~2x headroom above 100 concurrent people for multi-window/multi-device
 * use without requiring every self-hoster to discover and set an env var
 * before their team can grow past 64 simultaneous connections.
 */
export const MAX_LIVE_CONNECTIONS = envInt('TEAMSPACE_MAX_WS_CONNECTIONS', 200, 8, 20_000)

/**
 * TCC-R1134-ENT-001: presence (online/away roster) had only a clean-
 * disconnect path - `dropLiveSession` ran on the socket's own `close`/
 * `error` events, which the underlying `ws`/TCP layer only fires for a
 * graceful close or a detected reset. A member whose device force-quit,
 * lost power, or dropped off the network without sending a WS close frame
 * (laptop sleep, pulled cable, OS-level kill -9 of the desktop process)
 * leaves a TCP half-open socket that neither side tears down - by default
 * most OSes do not even notice for hours (Linux's default TCP keepalive is
 * 2+ hours, and many client OSes disable it entirely), so that member's
 * presence row would show "online" indefinitely with no way for a
 * server-side timeout to ever reap it. Server-initiated WS ping/pong
 * (native to the `ws` protocol, not the app-level `ping`/`pong` JSON frame
 * case) closes this gap: every live socket must answer a ping within one
 * interval or it is treated as dead and `terminate()`d, which fires this
 * socket's own `close` handler and runs the exact same `dropLiveSession`
 * presence-leave fanout as a clean disconnect. Default 30s balances catching
 * ghost sessions reasonably fast against extra keepalive traffic for a
 * small self-hosted team; worst-case detection latency is ~2x this value
 * (one interval to notice the missed pong, one to have sent the ping).
 */
export const PRESENCE_HEARTBEAT_INTERVAL_MS = envInt(
  'TEAMSPACE_PRESENCE_HEARTBEAT_INTERVAL_MS',
  30_000,
  5_000,
  300_000,
)

/**
 * TCC-R1134-BRGLIM-001: `yjs_update` (Y.Doc CRDT content updates) and
 * `yjs_awareness` (cursor/selection presence) had NO per-member rate limit
 * at all - unlike every other mutating WS frame (`ops`/`chat_send`/
 * `task_request` share `takeOpsToken`; chat has its own per-action buckets),
 * these two cases only validated the update's size/shape and room
 * membership before calling `fanoutYjsUpdate`/`fanoutYjsAwareness`, which
 * loop over every OTHER socket in the room (`YJS_ROOM_MAX_PEERS`, default
 * 40). A single stuck/malicious client sending frames at wire speed would
 * multiply into up to 40x that rate of outbound fanout writes bridge-wide
 * for that room, with nothing to slow it down. Awareness (mouse/cursor
 * position) is naturally higher-frequency than content edits (which Yjs
 * clients already locally batch/debounce), so it gets a slightly higher
 * budget; both are generous multiples of real interactive use (a human
 * cannot type or move a cursor anywhere near these rates) so legitimate
 * fast typing/dragging never gets throttled.
 */
export const YJS_UPDATE_TOKENS_PER_SEC = envInt('TEAMSPACE_YJS_UPDATE_TOKENS_PER_SEC', 20, 5, 200)
/** See `YJS_UPDATE_TOKENS_PER_SEC` - same contract, `yjs_awareness` cursor/presence frames. */
export const YJS_AWARENESS_TOKENS_PER_SEC = envInt(
  'TEAMSPACE_YJS_AWARENESS_TOKENS_PER_SEC',
  30,
  5,
  200,
)

/**
 * TCC-R1144-BRG-002: process-wide cap on concurrent `chat_rooms_list` room-file
 * scans across ALL sockets (per-request pool alone still multiplies to M×8).
 */
export const CHAT_ROOMS_LIST_PROCESS_CONCURRENCY = envInt(
  'TEAMSPACE_CHAT_ROOMS_LIST_PROCESS_CONCURRENCY',
  16,
  1,
  128,
)

/**
 * TCC-R1144-BRG-005 / TCC-R1145-BRG-002 / TCC-R1146-BRG-002 / TCC-R1147-BRG-005:
 * process-wide ceiling on bytes loaded into heap for HTTP downloads / exists-
 * skip verify (CRM blob GET, compose pack download, guest payload reads).
 */
export const MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES = envInt(
  'TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES',
  256 * 1024 * 1024,
  8 * 1024 * 1024,
  4 * 1024 * 1024 * 1024,
)

/**
 * BRG-069 / G7: per-member share of the download / exists-skip heap.
 * Same default and floor as the upload share so one compose pack or CRM
 * blob still fits. Blank memberId (guest pack / public payload) is
 * process-only.
 */
export const MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER = envInt(
  'TEAMSPACE_MAX_INFLIGHT_HTTP_DOWNLOAD_BYTES_PER_MEMBER',
  128 * 1024 * 1024,
  28_000_000,
  4 * 1024 * 1024 * 1024,
)

/** TCC-R1147-BRG-001: pre-auth WS frames must stay tiny (hello only). */
export const PRE_AUTH_WS_MAX_FRAME_BYTES = envInt(
  'TEAMSPACE_PRE_AUTH_WS_MAX_FRAME_BYTES',
  64 * 1024,
  4 * 1024,
  512 * 1024,
)

/** TCC-R1147-BRG-001: per-IP pre-auth message budget (before hello). */
export const PRE_AUTH_WS_TOKENS_PER_WINDOW = envInt(
  'TEAMSPACE_PRE_AUTH_WS_TOKENS',
  30,
  5,
  200,
)

/** TCC-R1145-BRG-003: sockets that never hello are reaped after this deadline. */
export const PRE_AUTH_HELLO_DEADLINE_MS = envInt(
  'TEAMSPACE_PRE_AUTH_HELLO_DEADLINE_MS',
  30_000,
  5_000,
  300_000,
)

/** TCC-R1147-BRG-002: guest password/PIN fail budget per token (+ optional IP). */
export const GUEST_AUTH_FAIL_MAX = envInt('TEAMSPACE_GUEST_AUTH_FAIL_MAX', 8, 3, 40)
export const GUEST_AUTH_FAIL_WINDOW_MS = envInt(
  'TEAMSPACE_GUEST_AUTH_FAIL_WINDOW_MS',
  15 * 60_000,
  60_000,
  60 * 60_000,
)

/**
 * TCC-R1154-BRG-002: team-wide CRM media blob disk ceiling (bytes on disk under
 * blobs/). Distinct from chat attachment quota (`chatBlobsBytes`).
 */
export const CRM_BLOBS_DISK_MAX_BYTES = envInt(
  'TEAMSPACE_CRM_BLOBS_DISK_MAX_BYTES',
  8 * 1024 * 1024 * 1024,
  64 * 1024 * 1024,
  512 * 1024 * 1024 * 1024,
)

/** TCC-R1149-BRG-002: process-wide chat_export lease (one heavy export at a time). */
export const CHAT_EXPORT_PROCESS_LEASES = envInt(
  'TEAMSPACE_CHAT_EXPORT_PROCESS_LEASES',
  1,
  1,
  4,
)

/** TCC-R1148-BRG-005: process-wide backup zip export lease. */
export const BACKUP_EXPORT_PROCESS_LEASES = envInt(
  'TEAMSPACE_BACKUP_EXPORT_PROCESS_LEASES',
  1,
  1,
  2,
)

/** TCC-R1150-BRG-004: roster list budget separate from invite mutators. */
export const ROSTER_TOKENS_PER_WINDOW = envInt('TEAMSPACE_ROSTER_TOKENS', 60, 10, 500)

/** TCC-R1151-BRG-004: Admin kick/leave/revoke/set_role/set_team_name budget. */
export const ADMIN_MUTATE_TOKENS_PER_WINDOW = envInt(
  'TEAMSPACE_ADMIN_MUTATE_TOKENS',
  30,
  5,
  200,
)

/** TCC-R1148-BRG-003: Admin HTTP share/portal/compose mutator budget. */
export const ADMIN_HTTP_MUTATE_TOKENS_PER_WINDOW = envInt(
  'TEAMSPACE_ADMIN_HTTP_MUTATE_TOKENS',
  20,
  5,
  200,
)

/** TCC-R1153-BRG-004: yjs_join / yjs_leave per-member budget (per second). */
export const YJS_JOIN_TOKENS_PER_SEC = envInt('TEAMSPACE_YJS_JOIN_TOKENS_PER_SEC', 10, 2, 100)

/** TCC-R1148-BRG-002: ack_ops shares ops budget; dedicated ceiling per window. */
export const ACK_OPS_TOKENS_PER_WINDOW = envInt('TEAMSPACE_ACK_OPS_TOKENS', 60, 10, 500)

/** BRG-062: on-demand catch-up is a full log scan. Keep this low. */
export const CATCHUP_REQUEST_TOKENS_PER_WINDOW = envInt(
  'TEAMSPACE_CATCHUP_REQUEST_TOKENS',
  8,
  2,
  30,
)

/** TCC-R1144-BRG-002: per-member chat_rooms_list token budget. */
export const CHAT_ROOMS_LIST_TOKENS_PER_MIN = envInt(
  'TEAMSPACE_CHAT_ROOMS_LIST_TOKENS_PER_MIN',
  30,
  5,
  200,
)

/** TCC-R1146-BRG-003: avatar PUT dedicated bucket (attach PUT already gated). */
export const CHAT_AVATAR_PUT_TOKENS_PER_MIN = envInt(
  'TEAMSPACE_CHAT_AVATAR_PUT_TOKENS_PER_MIN',
  20,
  5,
  120,
)

/** TCC-R1153-BRG-003: profile_update fanout budget. */
export const PROFILE_UPDATE_TOKENS_PER_MIN = envInt(
  'TEAMSPACE_PROFILE_UPDATE_TOKENS_PER_MIN',
  30,
  5,
  200,
)

/** TCC-R1147-BRG-005 / guest payload: concurrent guest download slots. */
export const GUEST_DOWNLOAD_TOKENS_PER_WINDOW = envInt(
  'TEAMSPACE_GUEST_DOWNLOAD_TOKENS',
  20,
  5,
  100,
)

/**
 * Temporary chat (never-persisted 1:1 DM): per-member budgets + room ceilings.
 * Every ephemeral_* frame writes NOTHING to disk - the caps below exist only
 * to bound in-memory state and fanout work, not durable storage growth.
 */
export const EPHEMERAL_START_TOKENS_PER_MIN = envInt('TEAMSPACE_EPHEMERAL_START_TOKENS_PER_MIN', 10, 2, 60)
export const EPHEMERAL_MESSAGE_TOKENS_PER_MIN = envInt('TEAMSPACE_EPHEMERAL_MESSAGE_TOKENS_PER_MIN', 30, 5, 300)
export const EPHEMERAL_CLOSE_TOKENS_PER_MIN = envInt('TEAMSPACE_EPHEMERAL_CLOSE_TOKENS_PER_MIN', 20, 5, 120)
/** P2 (extended to temporary chats): set description/preset-icon - infrequent, edit-panel-driven. */
export const EPHEMERAL_INFO_TOKENS_PER_MIN = envInt('TEAMSPACE_EPHEMERAL_INFO_TOKENS_PER_MIN', 10, 3, 60)
/** Concurrent live temporary-chat rooms one member may hold open at once. */
export const EPHEMERAL_ROOMS_PER_MEMBER_MAX = envInt('TEAMSPACE_EPHEMERAL_ROOMS_PER_MEMBER_MAX', 5, 1, 50)
/**
 * Concurrent live temporary-chat rooms across the whole bridge process.
 * Round-1157 (Deep BRG-009): the official multi-team hosted bridge serves
 * MANY Team Spaces at once, not one - the original default of 500 was sized
 * like a single-team dev placeholder (a few hundred teams each holding a
 * handful of concurrent temporary chats already exceeds it). Raised the
 * DEFAULT only; floor/ceiling bounds are unchanged so existing env overrides
 * still clamp the same way.
 */
export const EPHEMERAL_ROOMS_TOTAL_MAX = envInt('TEAMSPACE_EPHEMERAL_ROOMS_TOTAL_MAX', 2_000, 10, 20_000)
/**
 * Lasting (persisted) chat rooms for this team: the team room plus open DMs,
 * groups, and private rooms. Twin of EPHEMERAL_ROOMS_TOTAL_MAX (BRG-009).
 * Default 2000 so a new room is refused before the per-member list hides
 * rows (CHAT_ROOMS_LIST_MAX). Closed rooms do not count. Floor 2 so the
 * always-present team room plus one more room can still be minted.
 */
export const CHAT_ROOMS_TOTAL_MAX = envInt('TEAMSPACE_CHAT_ROOMS_TOTAL_MAX', 2_000, 2, 20_000)
/** Pending (sent, not yet accepted/declined) invites one member may hold open. */
export const EPHEMERAL_PENDING_INVITES_PER_MEMBER_MAX = envInt(
  'TEAMSPACE_EPHEMERAL_PENDING_INVITES_PER_MEMBER_MAX',
  5,
  1,
  50,
)
/** How long an unanswered invite stays live before it silently expires. */
export const EPHEMERAL_INVITE_TTL_MS = envInt('TEAMSPACE_EPHEMERAL_INVITE_TTL_MS', 2 * 60_000, 15_000, 15 * 60_000)
/**
 * Round-1157: temporary GROUP chats (3+ members). No pre-existing
 * `*_ROOM_MAX_MEMBERS`-style constant was found anywhere in the codebase for
 * regular (persisted) group rooms either (grepped `chat-room.ts`,
 * `server.ts`'s `chat_room_create`/`chat_room_add_members` handlers, and
 * `throughput.ts` - none cap member COUNT, only room id length). This
 * constant is therefore the first such cap in the codebase; sized as a
 * small, sane ceiling rather than copying a nonexistent sibling. Future
 * regular-group member-count work should adopt/extend this same constant
 * instead of inventing a second one.
 */
export const EPHEMERAL_GROUP_MEMBERS_MAX = envInt('TEAMSPACE_EPHEMERAL_GROUP_MEMBERS_MAX', 12, 3, 50)
/** Concurrent PENDING (not-yet-formed) group formations one member may initiate at once. */
export const EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX = envInt(
  'TEAMSPACE_EPHEMERAL_GROUP_FORMATIONS_PER_MEMBER_MAX',
  3,
  1,
  20,
)
/**
 * Close-handshake bound: once either side asks to end the chat, the room is
 * force-closed after this much time even if the other side never confirms
 * (mutual-close is the happy path; this is the "someone went quiet" floor).
 * The client MAY suggest a shorter value in `ephemeral_start.closeTimeoutMs`
 * (Settings `settings.teamSpace.ephemeralChatCloseTimeoutMs`); the bridge
 * always clamps it into [FLOOR, CEILING] and never lets a client raise it
 * past the ceiling.
 */
export const EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT = envInt(
  'TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_DEFAULT',
  10 * 60_000,
  30_000,
  60 * 60_000,
)
export const EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR = envInt('TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_FLOOR', 30_000, 5_000, 60 * 60_000)
export const EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING = envInt(
  'TEAMSPACE_EPHEMERAL_CLOSE_TIMEOUT_MS_CEILING',
  30 * 60_000,
  60_000,
  6 * 60 * 60_000,
)
