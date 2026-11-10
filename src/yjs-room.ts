/**
 * Yjs room id helpers for the Team Space bridge (M-P5YJS1).
 * Keep byte-identical contract with apps/desktop/src/lib/teamspace-yjs-room.ts.
 */

import { normalizeTeamIdSegment } from './text-cap.js'
import { serializeBridgeFrame } from './ws-frame-send.js'

/**
 * Local copy of `throughput.ts`'s `envInt` (not imported - that file is a
 * hot-shared self-host env-var registry owned by other concurrent buckets;
 * this is the only env-tunable constant in this file).
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

export const YJS_ROOM_PREFIX = 'yjs:'
export const YJS_ROOM_MAX_LEN = 320
export const YJS_RECORD_ID_MAX = 128
export const YJS_FIELD_SLUG_MAX = 128
export const YJS_UPDATE_B64_MAX = 512_000
/**
 * TCC-R1133-SET-006: was a bare hardcoded `32` with no way to raise it - a
 * member with many open Doc/Whiteboard/Compose boards at once under
 * concurrent co-edit hit "refused" `yjs_join` with no self-host override.
 * Default raised 32 -> 64 (still a real ceiling against a client bug that
 * joins rooms without ever leaving) and made env-tunable for self-host
 * operators who legitimately need more. See docs/SELF-HOST.md.
 */
export const YJS_ROOMS_PER_SOCKET_MAX = envInt('TEAMSPACE_YJS_ROOMS_PER_SOCKET_MAX', 64, 8, 512)

/**
 * Join-time and Admin-lower evict share this sentence (TCC-R1143-LIM-009).
 * BRG-066 leftover lives in `evictSurplusYjsPeers` (server.ts, L06): that
 * loop still stringifies a `yjs_refuse` per kicked peer. This leaf is the
 * one-stringify-per-room helper that splice must call, then send the same
 * string to every surplus peer in that room. Do not read this comment as
 * the server loop already being fixed.
 */
export const YJS_REFUSE_ROOM_FULL =
  'Too many people have this document open right now. Try again shortly.'

/** BRG-066: one stringify per room, not per evicted peer. */
export function serializeYjsRoomFullRefuse(room: unknown, teamId?: string): string {
  const id = normalizeTeamIdSegment(room, YJS_ROOM_MAX_LEN)
  const tid = normalizeTeamIdSegment(teamId, 128)
  return serializeBridgeFrame({
    type: 'yjs_refuse',
    room: id,
    reason: YJS_REFUSE_ROOM_FULL,
    ...(tid ? { teamId: tid } : {}),
  })
}

/**
 * Sentinel recordId for Compose live co-edit rooms (COMPOSE-033) - never a
 * real CRM record id. Must stay byte-identical with
 * `apps/desktop/src/lib/teamspace-yjs-compose-room.ts`
 * `TEAMSPACE_YJS_COMPOSE_RECORD_SENTINEL` so the bridge classifies the same
 * room the same way the desktop client does (TCC-R1125-WS-001 flag gate).
 */
export const YJS_COMPOSE_RECORD_SENTINEL = 'composeDoc'

/** True when `recordId` (from a parsed `yjs:recordId:field` room) is a Compose co-edit room. */
export function isYjsComposeRecordId(recordId: string): boolean {
  return recordId === YJS_COMPOSE_RECORD_SENTINEL
}

function scrubSegment(raw: unknown, max: number): string | null {
  const s = normalizeTeamIdSegment(raw, max)
  if (!s) return null
  if (s.includes('..') || s.includes('/') || s.includes('\\') || s.includes(':')) return null
  return s
}

export function yjsRoomId(recordId: unknown, contentField: unknown): string | null {
  const rid = scrubSegment(recordId, YJS_RECORD_ID_MAX)
  const field = scrubSegment(contentField, YJS_FIELD_SLUG_MAX)
  if (!rid || !field) return null
  const room = `${YJS_ROOM_PREFIX}${rid}:${field}`
  if (room.length > YJS_ROOM_MAX_LEN) return null
  return room
}

export function parseYjsRoomId(room: unknown): {
  ok: true
  room: string
  recordId: string
  contentField: string
} | { ok: false; reason: string } {
  if (typeof room !== 'string') return { ok: false, reason: 'room required' }
  const s = normalizeTeamIdSegment(room, YJS_ROOM_MAX_LEN)
  if (!s.startsWith(YJS_ROOM_PREFIX)) {
    return { ok: false, reason: 'room must start with yjs:' }
  }
  if (s.length > YJS_ROOM_MAX_LEN) {
    return { ok: false, reason: 'room too long' }
  }
  const rest = s.slice(YJS_ROOM_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0 || colon === rest.length - 1) {
    return { ok: false, reason: 'room must be yjs:recordId:field' }
  }
  const recordId = rest.slice(0, colon)
  const contentField = rest.slice(colon + 1)
  const rebuilt = yjsRoomId(recordId, contentField)
  if (!rebuilt || rebuilt !== s) {
    return { ok: false, reason: 'invalid room segments' }
  }
  return { ok: true, room: rebuilt, recordId, contentField }
}

export function isYjsUpdateB64(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false
  if (!raw || raw.length > YJS_UPDATE_B64_MAX) return false
  return /^[A-Za-z0-9_+/=\-]+$/.test(raw)
}
