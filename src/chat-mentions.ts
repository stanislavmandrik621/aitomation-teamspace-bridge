/** Mentions use a stable member identity; names are presentation only. */
export function chatBodyMentionsMember(body: string, memberId: string): boolean {
  if (!memberId || typeof body !== 'string') return false
  const token = memberId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}_@])@${token}(?![\\p{L}\\p{N}_])`, 'iu').test(body.split('\0', 1)[0] || '')
}
