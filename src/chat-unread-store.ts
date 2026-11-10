/**
 * Per-member per-room unread watermarks for Team chat.
 * File: chat/unread.json under TEAMSPACE_DATA_DIR.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { AtRestKey } from './at-rest.js'
import { encryptJsonFile, decryptJsonFile } from './at-rest.js'
import { CHAT_ROOMS_LIST_MAX } from './chat-rooms-store.js'
import { parseChatRoomId } from './chat-room.js'

function memberKey(value: string): string {
  const key = String(value || '').trim()
  return key && key.length <= 128 && !key.includes('\0') ? key : ''
}
function roomKey(value: string): string {
  const parsed = parseChatRoomId(value)
  return parsed.ok ? parsed.room : ''
}

export type UnreadMark = {
  lastReadAt: number
  lastReadMsgId?: string | null
}

type UnreadFile = {
  version: 1
  /** memberId -> roomId -> mark */
  marks: Record<string, Record<string, UnreadMark>>
}

function looksEncryptedJsonFile(parsed: unknown): boolean {
  return Boolean(
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as { v?: unknown }).v === 1
    && typeof (parsed as { ciphertext?: unknown }).ciphertext === 'string',
  )
}

export class ChatUnreadStore {
  private readonly path: string
  private marks: UnreadFile['marks'] = Object.create(null)
  private registryUnreadable = false

  constructor(
    dataDir: string,
    private atRest: AtRestKey | null,
  ) {
    const dir = join(dataDir, 'chat')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.path = join(dir, 'unread.json')
    this.load()
  }

  private load(): void {
    if (!existsSync(this.path)) return
    try {
      const raw = readFileSync(this.path, 'utf8')
      if (!raw.trim()) {
        this.registryUnreadable = true
        return
      }
      const parsed = decryptJsonFile<UnreadFile>(this.atRest, raw, null as unknown as UnreadFile)
      if (looksEncryptedJsonFile(parsed) && !this.atRest) {
        this.registryUnreadable = true
        return
      }
      if (!parsed || !parsed.marks || typeof parsed.marks !== 'object' || Array.isArray(parsed.marks)) {
        this.registryUnreadable = true
        return
      }
      // Null-prototype maps keep opaque member IDs such as `__proto__` data,
      // never object properties. Malformed persisted rows cannot become keys.
      const marks: UnreadFile['marks'] = Object.create(null)
      for (const [memberId, rooms] of Object.entries(parsed.marks)) {
        if (memberKey(memberId) !== memberId || !rooms || typeof rooms !== 'object' || Array.isArray(rooms)) continue
        const next: Record<string, UnreadMark> = Object.create(null)
        for (const [room, mark] of Object.entries(rooms)) {
          if (!roomKey(room) || !mark || typeof mark !== 'object' || !Number.isFinite(mark.lastReadAt)) continue
          next[roomKey(room)] = { lastReadAt: mark.lastReadAt, lastReadMsgId: typeof mark.lastReadMsgId === 'string' ? mark.lastReadMsgId : null }
        }
        marks[memberId] = next
      }
      this.marks = marks
    } catch {
      this.registryUnreadable = true
      this.marks = Object.create(null)
    }
  }

  private persistSync(): void {
    const payload: UnreadFile = { version: 1, marks: this.marks }
    const body = this.atRest ? encryptJsonFile(this.atRest, payload) : JSON.stringify(payload)
    const tmp = `${this.path}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, this.path)
  }

  /**
   * TCC-R1134-CHAT-022: this used to defer the actual disk write to the next
   * microtask via an unawaited `this.writeChain.then(...)` chain, even though
   * `persistSync` itself is fully synchronous (`writeFileSync` +
   * `renameSync`, no real async I/O) - the chain bought no real
   * serialization benefit here since every caller in `server.ts` invokes
   * `set()`/`wipeMember()` synchronously with no `await` gap between them.
   * All it did was open a real crash-loss window: `chat_unread_set`'s reply
   * (`server.ts`) ACKs `chat_unread_set_ok` in the SAME synchronous tick
   * `set()` returns in, so a bridge crash between that return and the
   * deferred microtask actually running left the read-position advance lost
   * even though the client already believes it landed - the room then
   * resurfaces stale messages as unread again after the next restart.
   * Persisting synchronously, right here, closes that window.
   */
  private queuePersist(): void {
    this.persistSync()
  }

  get(memberId: string, roomId: string): UnreadMark | null {
    const mid = memberKey(memberId)
    const rid = roomKey(roomId)
    if (!mid || !rid) return null
    const mark = this.marks[mid]?.[rid]
    return mark ? { ...mark } : null
  }

  getAllForMember(memberId: string): Record<string, UnreadMark> {
    const mid = memberKey(memberId)
    if (!mid) return {}
    return Object.fromEntries(Object.entries(this.marks[mid] || {}).map(([room, mark]) => [room, { ...mark }]))
  }

  /**
   * Invert member->room marks into per-room peer watermarks (for chat_seen_get).
   * TCC-R1143-RCPT-001: when `memberIds` is a non-empty allowlist, only return
   * marks for current room members (never leak departed/kicked peers' read
   * watermarks). Omit / empty allowlist = unrestricted (team room).
   */
  getAllForRoom(
    roomId: string,
    memberIds?: readonly string[] | null,
  ): Array<{ memberId: string; lastReadAt: number; lastReadMsgId?: string | null }> {
    const rid = roomKey(roomId)
    if (!rid) return []
    const allow =
      Array.isArray(memberIds) && memberIds.length > 0
        ? new Set(memberIds.map((x) => String(x || '').trim()).filter(Boolean))
        : null
    const out: Array<{ memberId: string; lastReadAt: number; lastReadMsgId?: string | null }> = []
    for (const [memberId, rooms] of Object.entries(this.marks)) {
      if (allow && !allow.has(memberId)) continue
      const mark = rooms?.[rid]
      if (!mark || typeof mark.lastReadAt !== 'number') continue
      out.push({
        memberId,
        lastReadAt: mark.lastReadAt,
        lastReadMsgId: mark.lastReadMsgId ?? null,
      })
      if (out.length >= 5000) break
    }
    return out
  }

  set(
    memberId: string,
    roomId: string,
    mark: UnreadMark,
  ): { ok: true; advanced: boolean } | { error: string } {
    if (this.registryUnreadable) {
      return {
        error: 'Chat read positions could not be loaded. Check the team server data file and the encryption key.',
      }
    }
    const mid = memberKey(memberId)
    const rid = roomKey(roomId)
    if (!mid || !rid) return { error: 'memberId and room required' }
    let lastReadAt =
      typeof mark.lastReadAt === 'number' && Number.isFinite(mark.lastReadAt)
        ? Math.floor(mark.lastReadAt)
        : Date.now()
    // TCC-R1153-CHAT-005: refuse future watermarks (small skew allowance).
    const nowCeil = Date.now() + 60_000
    if (lastReadAt > nowCeil) lastReadAt = nowCeil
    const lastReadMsgId =
      typeof mark.lastReadMsgId === 'string'
        ? mark.lastReadMsgId.replace(/\0/g, '').trim().slice(0, 128)
        : null
    const previousRooms = this.marks[mid]
    const prev = previousRooms?.[rid]
    // Watermarks only advance (never rewind) unless explicit clear with 0.
    // TCC-R1146-CHAT-006 (M sibling): rewind no-op returns advanced:false so
    // the bridge can skip seen-peer fanout.
    if (prev && lastReadAt > 0 && lastReadAt < (prev.lastReadAt || 0)) {
      return { ok: true, advanced: false }
    }
    const prevAt = prev?.lastReadAt || 0
    const prevMsg = prev?.lastReadMsgId ?? null
    // TCC-R1152-CHAT-006: equal tip watermark is a no-op (no re-assign / persist / fanout).
    if (prev && lastReadAt > 0 && lastReadAt === prevAt && lastReadMsgId === prevMsg) {
      return { ok: true, advanced: false }
    }
    const advanced = lastReadAt === 0 || lastReadAt > prevAt || lastReadMsgId !== prevMsg
    this.marks[mid] = Object.assign(Object.create(null), previousRooms)
    this.marks[mid][rid] = { lastReadAt, lastReadMsgId }
    // G11 residual twin: this used to be a hardcoded 2000, so raising
    // TEAMSPACE_CHAT_ROOMS_TOTAL_MAX minted rooms whose unread watermark
    // was then evicted. Stay at CHAT_ROOMS_LIST_MAX (create env max).
    const keys = Object.keys(this.marks[mid])
    if (keys.length > CHAT_ROOMS_LIST_MAX) {
      keys
        .sort((a, b) => (this.marks[mid][a]?.lastReadAt || 0) - (this.marks[mid][b]?.lastReadAt || 0))
        .slice(0, keys.length - CHAT_ROOMS_LIST_MAX)
        .forEach((k) => { delete this.marks[mid][k] })
    }
    try { this.queuePersist() }
    catch {
      if (previousRooms) this.marks[mid] = previousRooms
      else delete this.marks[mid]
      return { error: 'Chat read position could not be saved. Please try again.' }
    }
    return { ok: true, advanced }
  }

  wipeMember(memberId: string): void {
    if (this.registryUnreadable) return
    const mid = memberKey(memberId)
    if (!mid) return
    const previous = this.marks[mid]
    delete this.marks[mid]
    try { this.queuePersist() }
    catch (error) { if (previous) this.marks[mid] = previous; throw error }
  }

  /** Clear one room mark for a member (voluntary leave / remove / ban). */
  wipeMemberRoom(memberId: string, roomId: string): void {
    if (this.registryUnreadable) return
    const mid = memberKey(memberId)
    const rid = roomKey(roomId)
    if (!mid || !rid || !this.marks[mid]) return
    if (!(rid in this.marks[mid])) return
    const previous = this.marks[mid]
    this.marks[mid] = Object.assign(Object.create(null), previous)
    delete this.marks[mid][rid]
    try { this.queuePersist() }
    catch (error) { this.marks[mid] = previous; throw error }
  }
}
