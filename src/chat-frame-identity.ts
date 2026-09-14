/** Admission for chat identity selectors before any legacy sanitizers run. */
import { parseChatRoomId } from './chat-room.js'
import { parseAnyEphemeralRoomId } from './ephemeral-chat.js'

export function exactChatMessageId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.includes('\0')) return ''
  const id = raw.trim()
  return id.length > 0 && id.length <= 128 ? id : ''
}

export function chatFrameIdentityError(frame: Record<string, unknown>): string | null {
  const type = typeof frame.type === 'string' ? frame.type : ''
  if (!type.startsWith('chat_') && !type.startsWith('ephemeral_')) return null
  const ephemeral = type.startsWith('ephemeral_')
  for (const key of ['room', 'roomId']) {
    const raw = frame[key]
    if (raw == null || raw === '') continue
    if (typeof raw !== 'string' || raw.includes('\0')) return `Invalid ${key}`
    const parsed = ephemeral ? parseAnyEphemeralRoomId(raw) : parseChatRoomId(raw)
    if (!parsed.ok) return `Invalid ${key}`
  }
  for (const key of ['messageId', 'clientMsgId', 'replyToId', 'lastReadMsgId', 'memberId', 'targetMemberId', 'inviteId', 'formationId']) {
    const raw = frame[key]
    if (raw == null || raw === '') continue
    const max = key === 'inviteId' || key === 'formationId' ? 64 : ephemeral && key === 'replyToId' ? 200 : 128
    if (typeof raw !== 'string' || raw.includes('\0') || raw.trim().length > max) return `Invalid ${key}`
  }
  for (const key of ['memberIds', 'targetMemberIds']) {
    const raw = frame[key]
    if (raw == null) continue
    if (!Array.isArray(raw) || raw.some(id => typeof id !== 'string' || id.includes('\0') || id.trim().length > 128)) return `Invalid ${key}`
  }
  return null
}
