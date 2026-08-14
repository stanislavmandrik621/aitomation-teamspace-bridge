/**
 * Plan L Presence - ephemeral online roster helpers (no disk).
 * Snapshot/fanout over the bridge `live` map; not Modules ops.
 */
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
  const t = raw.replace(/\0/g, '').trim().slice(0, 120)
  return t || 'Teammate'
}

function scrubId(raw: unknown, max = 128): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\0/g, '').trim().slice(0, max)
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
  const role: BridgeRole =
    raw.role === 'admin' || raw.role === 'viewer' || raw.role === 'member'
      ? raw.role
      : 'member'
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
  const out: PresencePeer[] = []
  for (const s of sessions) {
    const peer = normalizePresencePeer(s)
    if (!peer) continue
    out.push(peer)
    if (out.length >= PRESENCE_SNAPSHOT_MAX) break
  }
  out.sort((a, b) => {
    const byName = a.displayName.localeCompare(b.displayName)
    if (byName !== 0) return byName
    return a.memberId.localeCompare(b.memberId) || a.deviceId.localeCompare(b.deviceId)
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
