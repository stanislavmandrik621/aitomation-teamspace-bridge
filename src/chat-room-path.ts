/**
 * Filesystem-safe directory names for per-room chat storage.
 */

import { createHash } from 'node:crypto'
import { parseChatRoomId } from './chat-room.js'

/** Map chat:team -> team, chat:dm:a.b -> dm_a_b, etc. */
export function safeChatRoomDirName(roomId: string): string | null {
  const parsed = parseChatRoomId(roomId)
  if (!parsed.ok) return null
  const rest = parsed.room.slice('chat:'.length)
  const safe = rest.replace(/:/g, '_').replace(/[^a-zA-Z0-9_-]/g, '_')
  if (!safe) return null
  if (safe.length > 120) {
    const hash = createHash('sha256').update(parsed.room).digest('hex').slice(0, 24)
    return `dm_${hash}`
  }
  return safe
}

export function chatRoomDir(dataDir: string, roomId: string): string | null {
  const name = safeChatRoomDirName(roomId)
  if (!name) return null
  return `${dataDir}/chat/rooms/${name}`
}
