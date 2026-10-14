/**
 * Team Space admin-editable Limits meta (throughput / room / chat rates / Yjs).
 * Persisted under TEAMSPACE_DATA_DIR/config/_limits.json.
 * Pattern mirrors TeamBackupMeta in backup-store.ts.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_RATE_EXPORT_PER_MIN,
  CHAT_RATE_HISTORY_PER_MIN,
  CHAT_RATE_MUTATE_PER_MIN,
  CHAT_RATE_REACT_PER_MIN,
  CHAT_RATE_SEARCH_PER_MIN,
  CHAT_RATE_SEND_PER_MIN,
} from './chat-rate-limits.js'
import {
  CHAT_ROOM_MEMBERS_DEFAULT_CAP,
  CHAT_ROOM_MEMBERS_HARD_CAP,
  setChatRoomMembersCap,
} from './chat-rooms-store.js'
import { MAX_LIVE_CONNECTIONS, YJS_ROOM_MAX_PEERS } from './throughput.js'

export type TeamLimitsMeta = {
  schemaVersion: number
  maxLiveConnections: number
  maxRoomMembers: number
  chatSendPerMin: number
  chatReactPerMin: number
  chatMutatePerMin: number
  chatSearchPerMin: number
  chatHistoryPerMin: number
  chatExportPerMin: number
  yjsRoomMaxPeers: number
  /** Max voice-message recording seconds (desktop + bridge upload hint). */
  voiceMessageMaxSec: number
  /** Author message edit window in seconds (bridge enforces; Admin bypasses). */
  chatEditWindowSec: number
}

/** Member-readable subset (voice + edit window) - not Admin-only. */
export const LIMITS_META_PUBLIC_KEYS = [
  'voiceMessageMaxSec',
  'chatEditWindowSec',
] as const

export type TeamLimitsPublicKey = (typeof LIMITS_META_PUBLIC_KEYS)[number]

export const LIMITS_META_DEFAULTS: TeamLimitsMeta = {
  schemaVersion: 1,
  maxLiveConnections: MAX_LIVE_CONNECTIONS,
  maxRoomMembers: CHAT_ROOM_MEMBERS_DEFAULT_CAP,
  chatSendPerMin: CHAT_RATE_SEND_PER_MIN,
  chatReactPerMin: CHAT_RATE_REACT_PER_MIN,
  chatMutatePerMin: CHAT_RATE_MUTATE_PER_MIN,
  chatSearchPerMin: CHAT_RATE_SEARCH_PER_MIN,
  chatHistoryPerMin: CHAT_RATE_HISTORY_PER_MIN,
  chatExportPerMin: CHAT_RATE_EXPORT_PER_MIN,
  yjsRoomMaxPeers: YJS_ROOM_MAX_PEERS,
  voiceMessageMaxSec: 300,
  chatEditWindowSec: 1800,
}

/** Env / structural ceilings an admin cannot raise past. */
export const LIMITS_META_CEILINGS = {
  maxLiveConnections: 20_000,
  maxRoomMembers: CHAT_ROOM_MEMBERS_HARD_CAP,
  chatSendPerMin: 600,
  chatReactPerMin: 600,
  chatMutatePerMin: 600,
  chatSearchPerMin: 600,
  chatHistoryPerMin: 600,
  chatExportPerMin: 60,
  yjsRoomMaxPeers: 500,
  voiceMessageMaxSec: 1800,
  chatEditWindowSec: 86400,
} as const

export const LIMITS_META_FLOORS = {
  maxLiveConnections: 8,
  maxRoomMembers: 2,
  chatSendPerMin: 5,
  chatReactPerMin: 5,
  chatMutatePerMin: 5,
  chatSearchPerMin: 5,
  chatHistoryPerMin: 5,
  chatExportPerMin: 1,
  yjsRoomMaxPeers: 5,
  voiceMessageMaxSec: 30,
  chatEditWindowSec: 60,
} as const

function clampInt(n: unknown, floor: number, ceil: number, fallback: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback
  return Math.min(ceil, Math.max(floor, Math.floor(n)))
}

function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
  renameSync(tmp, path)
}

type LimitsFileRead =
  | { ok: true; missing: true }
  | { ok: true; missing: false; value: Partial<TeamLimitsMeta> }
  | { ok: false }

function readLimitsFile(path: string): LimitsFileRead {
  if (!existsSync(path)) return { ok: true, missing: true }
  try {
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) return { ok: false }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
    return { ok: true, missing: false, value: parsed as Partial<TeamLimitsMeta> }
  } catch {
    return { ok: false }
  }
}

export type LimitsOverrideListener = (meta: TeamLimitsMeta) => void

export class TeamLimitsStore {
  readonly root: string
  private metaPath: string
  private listeners = new Set<LimitsOverrideListener>()
  private cached: TeamLimitsMeta | null = null
  private cachedAt = 0
  private readonly cacheTtlMs = 2_000

  constructor(dataDir: string) {
    this.root = join(dataDir, 'config')
    this.metaPath = join(this.root, '_limits.json')
    mkdirSync(this.root, { recursive: true })
    this.ensureMeta()
  }

  onChange(fn: LimitsOverrideListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private notify(meta: TeamLimitsMeta): void {
    for (const fn of this.listeners) {
      try {
        fn(meta)
      } catch {
        /* listener fail soft */
      }
    }
  }

  private normalize(partial: Partial<TeamLimitsMeta> | null | undefined): TeamLimitsMeta {
    const cur = partial ?? {}
    return {
      schemaVersion: 1,
      maxLiveConnections: clampInt(
        cur.maxLiveConnections,
        LIMITS_META_FLOORS.maxLiveConnections,
        Math.min(LIMITS_META_CEILINGS.maxLiveConnections, MAX_LIVE_CONNECTIONS),
        LIMITS_META_DEFAULTS.maxLiveConnections,
      ),
      maxRoomMembers: clampInt(
        cur.maxRoomMembers,
        LIMITS_META_FLOORS.maxRoomMembers,
        LIMITS_META_CEILINGS.maxRoomMembers,
        LIMITS_META_DEFAULTS.maxRoomMembers,
      ),
      chatSendPerMin: clampInt(
        cur.chatSendPerMin,
        LIMITS_META_FLOORS.chatSendPerMin,
        LIMITS_META_CEILINGS.chatSendPerMin,
        LIMITS_META_DEFAULTS.chatSendPerMin,
      ),
      chatReactPerMin: clampInt(
        cur.chatReactPerMin,
        LIMITS_META_FLOORS.chatReactPerMin,
        LIMITS_META_CEILINGS.chatReactPerMin,
        LIMITS_META_DEFAULTS.chatReactPerMin,
      ),
      chatMutatePerMin: clampInt(
        cur.chatMutatePerMin,
        LIMITS_META_FLOORS.chatMutatePerMin,
        LIMITS_META_CEILINGS.chatMutatePerMin,
        LIMITS_META_DEFAULTS.chatMutatePerMin,
      ),
      chatSearchPerMin: clampInt(
        cur.chatSearchPerMin,
        LIMITS_META_FLOORS.chatSearchPerMin,
        LIMITS_META_CEILINGS.chatSearchPerMin,
        LIMITS_META_DEFAULTS.chatSearchPerMin,
      ),
      chatHistoryPerMin: clampInt(
        cur.chatHistoryPerMin,
        LIMITS_META_FLOORS.chatHistoryPerMin,
        LIMITS_META_CEILINGS.chatHistoryPerMin,
        LIMITS_META_DEFAULTS.chatHistoryPerMin,
      ),
      chatExportPerMin: clampInt(
        cur.chatExportPerMin,
        LIMITS_META_FLOORS.chatExportPerMin,
        LIMITS_META_CEILINGS.chatExportPerMin,
        LIMITS_META_DEFAULTS.chatExportPerMin,
      ),
      yjsRoomMaxPeers: clampInt(
        cur.yjsRoomMaxPeers,
        LIMITS_META_FLOORS.yjsRoomMaxPeers,
        Math.min(LIMITS_META_CEILINGS.yjsRoomMaxPeers, YJS_ROOM_MAX_PEERS),
        LIMITS_META_DEFAULTS.yjsRoomMaxPeers,
      ),
      voiceMessageMaxSec: clampInt(
        cur.voiceMessageMaxSec,
        LIMITS_META_FLOORS.voiceMessageMaxSec,
        LIMITS_META_CEILINGS.voiceMessageMaxSec,
        LIMITS_META_DEFAULTS.voiceMessageMaxSec,
      ),
      chatEditWindowSec: clampInt(
        cur.chatEditWindowSec,
        LIMITS_META_FLOORS.chatEditWindowSec,
        LIMITS_META_CEILINGS.chatEditWindowSec,
        LIMITS_META_DEFAULTS.chatEditWindowSec,
      ),
    }
  }

  private ensureMeta(): TeamLimitsMeta {
    const read = readLimitsFile(this.metaPath)
    if (!read.ok) {
      // Present but unreadable: use defaults in memory. Never persist a wipe.
      const next = this.normalize({})
      this.cached = next
      this.cachedAt = Date.now()
      setChatRoomMembersCap(next.maxRoomMembers)
      return next
    }
    const cur = read.missing ? {} : read.value
    const next = this.normalize(cur)
    // TCC-R1143-LIM-010: heal OOB / missing file so disk matches normalize.
    let needsWrite = read.missing
    if (!needsWrite) {
      try {
        const raw = JSON.stringify(cur)
        const norm = JSON.stringify(next)
        if (raw !== norm) needsWrite = true
      } catch {
        needsWrite = true
      }
    }
    if (needsWrite) {
      atomicWriteJson(this.metaPath, next)
    }
    this.cached = next
    this.cachedAt = Date.now()
    setChatRoomMembersCap(next.maxRoomMembers)
    return next
  }

  getMeta(): TeamLimitsMeta {
    const now = Date.now()
    if (this.cached && now - this.cachedAt < this.cacheTtlMs) {
      return { ...this.cached }
    }
    const read = readLimitsFile(this.metaPath)
    if (!read.ok) {
      const next = this.cached ?? this.normalize({})
      this.cached = next
      this.cachedAt = now
      return { ...next }
    }
    const next = this.normalize(read.missing ? {} : read.value)
    this.cached = next
    this.cachedAt = now
    return { ...next }
  }

  /** Public chat caps any authenticated member may read. */
  getPublicChatCaps(): Pick<TeamLimitsMeta, TeamLimitsPublicKey> {
    const meta = this.getMeta()
    return {
      voiceMessageMaxSec: meta.voiceMessageMaxSec,
      chatEditWindowSec: meta.chatEditWindowSec,
    }
  }

  setMeta(patch: Partial<TeamLimitsMeta>): TeamLimitsMeta {
    const merged = this.normalize({ ...this.getMeta(), ...patch })
    atomicWriteJson(this.metaPath, merged)
    this.cached = merged
    this.cachedAt = Date.now()
    setChatRoomMembersCap(merged.maxRoomMembers)
    this.notify(merged)
    return { ...merged }
  }

  /**
   * Effective values + which keys differ from hardcoded/env defaults.
   * TCC-R1143-LIM-005: ceilings advertise env-capped effective max so Admin
   * UI never suggests a value normalize will silently clamp.
   */
  getEffective(): {
    meta: TeamLimitsMeta
    defaults: TeamLimitsMeta
    ceilings: Record<keyof typeof LIMITS_META_CEILINGS, number>
    floors: typeof LIMITS_META_FLOORS
    overridden: (keyof TeamLimitsMeta)[]
  } {
    const meta = this.getMeta()
    const defaults = { ...LIMITS_META_DEFAULTS }
    const overridden: (keyof TeamLimitsMeta)[] = []
    for (const key of Object.keys(defaults) as (keyof TeamLimitsMeta)[]) {
      if (key === 'schemaVersion') continue
      if (meta[key] !== defaults[key]) overridden.push(key)
    }
    const ceilings: Record<keyof typeof LIMITS_META_CEILINGS, number> = {
      ...LIMITS_META_CEILINGS,
      maxLiveConnections: Math.min(
        LIMITS_META_CEILINGS.maxLiveConnections,
        MAX_LIVE_CONNECTIONS,
      ),
      yjsRoomMaxPeers: Math.min(LIMITS_META_CEILINGS.yjsRoomMaxPeers, YJS_ROOM_MAX_PEERS),
    }
    return {
      meta,
      defaults,
      ceilings,
      floors: LIMITS_META_FLOORS,
      overridden,
    }
  }
}
