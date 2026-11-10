/**
 * Team Space chat rate-limit budgets - bridge twin of desktop leaf.
 * apps/desktop/src/lib/teamspace-chat-rate-limits.ts
 */

export const CHAT_RATE_SEND_PER_MIN = 30
export const CHAT_RATE_HISTORY_PER_MIN = 60
export const CHAT_RATE_REACT_PER_MIN = 60
export const CHAT_RATE_TYPING_PER_SEC = 10
export const CHAT_RATE_PASSWORD_JOIN_PER_15MIN = 5
export const CHAT_RATE_BLOB_PUT_PER_MIN = 20
/**
 * TCC-R1133-SEC-001: chat attachment/avatar HTTP GET had no member-scoped
 * rate limit - only the shared per-IP budget (`HTTP_TOKENS_PER_WINDOW`,
 * checked once at the top of every HTTP request regardless of route), unlike
 * the attachment PUT (`CHAT_RATE_BLOB_PUT_PER_MIN`) and the CRM blob GET
 * sibling (`BLOB_TOKENS_PER_WINDOW`, member-scoped). A member (or anyone
 * sharing that IP behind NAT/VPN) could fire unlimited concurrent large
 * attachment/avatar downloads bounded only by the coarse per-IP HTTP budget,
 * spiking bridge heap/bandwidth. GET is legitimately much higher-volume than
 * PUT (opening a room loads many thumbnails at once), so this is set well
 * above the PUT budget - generous for real scrolling bursts, still finite.
 */
export const CHAT_RATE_BLOB_GET_PER_MIN = 300

/**
 * TCC-R1134-CHAT-040: `chat_delete` / `chat_pin` / `chat_unsend` had NO
 * member-scoped rate limit at all (unlike chat_send/history/react/edit,
 * which all call a `takeChat*Token` bucket before doing any work) - a
 * connected member (any non-viewer for unsend, an Admin for delete/pin)
 * could fire these in an unbounded loop, each one doing a disk write
 * (softDelete/setPinned/authorUnsend) plus a full-room fanout. Budgeted the
 * same as chat_send since they are comparable single-message mutations.
 */
export const CHAT_RATE_MUTATE_PER_MIN = 30
/**
 * TCC-R1134-CHAT-040: `chat_search` / `chat_jump` also had no rate limit -
 * both call `chatStore.searchRoom` / `chatStore.jumpToMessage`, which scan
 * the room's on-disk history (same cost class as `chat_history`), so they
 * share that budget rather than inventing a separate one.
 */
export const CHAT_RATE_SEARCH_PER_MIN = CHAT_RATE_HISTORY_PER_MIN
/**
 * TCC-R1134-CHAT-040: `chat_export` (Admin-only) serializes the ENTIRE room
 * history to a single reply (up to the 8 MB cap in `chat_export_ok`) - by
 * far the most expensive chat_* op per call, and also had no rate limit.
 * Kept low: no legitimate workflow exports the same room more than a
 * handful of times a minute.
 */
export const CHAT_RATE_EXPORT_PER_MIN = 6

/**
 * TCC-R1145-CHAT-013: room roster mutators (create/add/remove/ban/promote/...)
 * fan out members_peer and rewrite durable room meta - need a dedicated budget
 * distinct from per-message mutate (delete/pin/unsend).
 */
export const CHAT_RATE_ROOM_ADMIN_PER_MIN = 30

export const CHAT_RATE_LIMITS = {
  sendPerMin: CHAT_RATE_SEND_PER_MIN,
  historyPerMin: CHAT_RATE_HISTORY_PER_MIN,
  reactPerMin: CHAT_RATE_REACT_PER_MIN,
  typingPerSec: CHAT_RATE_TYPING_PER_SEC,
  passwordJoinPer15Min: CHAT_RATE_PASSWORD_JOIN_PER_15MIN,
  blobPutPerMin: CHAT_RATE_BLOB_PUT_PER_MIN,
  blobGetPerMin: CHAT_RATE_BLOB_GET_PER_MIN,
  mutatePerMin: CHAT_RATE_MUTATE_PER_MIN,
  searchPerMin: CHAT_RATE_SEARCH_PER_MIN,
  exportPerMin: CHAT_RATE_EXPORT_PER_MIN,
  roomAdminPerMin: CHAT_RATE_ROOM_ADMIN_PER_MIN,
} as const
