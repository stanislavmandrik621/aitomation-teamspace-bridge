/**
 * Plan L Presence - ephemeral online roster helpers (no disk).
 * Snapshot/fanout over the bridge `live` map; not Modules ops.
 */
import { capStr } from './text-cap.js'
import type { BridgeRole } from './index.js'

export const PRESENCE_SNAPSHOT_MAX = 128

export type PresencePeer = {
  memberId: string
  displayName: string
  role: BridgeRole
  deviceId: string
  lastSeen: number
}

function scrubName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Teammate'
  const t = capStr(raw.replace(/\0/g, '').trim(), 120)
  return t || 'Teammate'
}

function scrubId(raw: unknown, max = 128): string {
  if (typeof raw !== 'string') return ''
  return capStr(raw.replace(/\0/g, '').trim(), max)
}

export function normalizePresencePeer(raw: {
  memberId: unknown
  displayName?: unknown
  role: unknown
  deviceId: unknown
  lastSeen?: unknown
}): PresencePeer | null {
  const memberId = scrubId(raw.memberId)
  const deviceId = scrubId(raw.deviceId)
  if (!memberId || !deviceId) return null
  // TS-PRES-005: fail-closed to the lowest privilege on an unrecognized role
  // string - never assume 'member' for a value this scrub cannot vouch for.
  const role: BridgeRole =
    raw.role === 'admin' || raw.role === 'viewer' || raw.role === 'member'
      ? raw.role
      : 'viewer'
  const lastSeen =
    typeof raw.lastSeen === 'number' && Number.isFinite(raw.lastSeen)
      ? Math.max(0, Math.floor(raw.lastSeen))
      : Date.now()
  return {
    memberId,
    displayName: scrubName(raw.displayName),
    role,
    deviceId,
    lastSeen,
  }
}

/**
 * Build a capped online list. Multiple devices for one member stay as
 * separate rows (Settings can dedupe by memberId for dots).
 *
 * TS-PRES-003: the input iterable is `live.values()` insertion order (server
 * connection order), which has no relationship to who is most recently
 * active. Capping DURING iteration (old behavior) silently favored whichever
 * sessions happened to connect first and could starve a busy team's newest
 * members from ever appearing in the roster. This normalizes every session
 * first, then - only when the set exceeds the ceiling - keeps the most
 * recently seen `PRESENCE_SNAPSHOT_MAX` peers before the final display sort.
 *
 * TS-PRES-004: defensively dedupes by (memberId, deviceId) so an upstream
 * reconnect-reclaim race that leaves two live sessions for one device cannot
 * double-count that device (and cannot steal two of the admission slots).
 */
export function buildPresenceSnapshot(
  sessions: Iterable<{
    memberId: string
    displayName: string
    role: BridgeRole
    deviceId: string
    lastSeen: number
  }>,
): PresencePeer[] {
  const byDevice = new Map<string, PresencePeer>()
  for (const s of sessions) {
    const peer = normalizePresencePeer(s)
    if (!peer) continue
    const key = `${peer.memberId}\u0000${peer.deviceId}`
    const prior = byDevice.get(key)
    if (!prior || peer.lastSeen >= prior.lastSeen) byDevice.set(key, peer)
  }
  let out = Array.from(byDevice.values())
  if (out.length > PRESENCE_SNAPSHOT_MAX) {
    out.sort((a, b) => b.lastSeen - a.lastSeen)
    out = out.slice(0, PRESENCE_SNAPSHOT_MAX)
  }
  out.sort((a, b) => {
    const byName = a.displayName.localeCompare(b.displayName, 'en-US', { sensitivity: 'base' })
    if (byName !== 0) return byName
    return (
      a.memberId.localeCompare(b.memberId, 'en-US') ||
      a.deviceId.localeCompare(b.deviceId, 'en-US')
    )
  })
  return out
}

/** True when any other live socket still belongs to this member. */
export function memberHasOtherLiveSocket(
  sessions: Iterable<{ memberId: string }>,
  memberId: string,
): boolean {
  const id = scrubId(memberId)
  if (!id) return false
  for (const s of sessions) {
    if (s.memberId === id) return true
  }
  return false
}

/** Distinct memberIds currently online (for UI counts). */
export function uniqueOnlineMemberIds(peers: readonly PresencePeer[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const p of peers) {
    if (seen.has(p.memberId)) continue
    seen.add(p.memberId)
    out.push(p.memberId)
    if (out.length >= PRESENCE_SNAPSHOT_MAX) break
  }
  return out
}
