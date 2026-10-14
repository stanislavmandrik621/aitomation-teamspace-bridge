/** Conservative RFC mailbox-list reader. Display names may contain quoted
 * commas; malformed/group addresses never become guessed reply recipients. */
export function mailAddressList(raw: unknown): string[] | null {
  if (Array.isArray(raw)) {
    if (raw.length > 50) return null
    const rows = raw.map(value => typeof value === 'string' ? mailAddressList(value) : null)
    return rows.some(value => !value || value.length !== 1) ? null : [...new Set(rows.flat() as string[])]
  }
  if (typeof raw !== 'string' || raw.length > 16_000 || /[\r\n\0]/.test(raw)) return null
  if (!raw.trim()) return []
  const parts: string[] = []; let text = '', quoted = false, escaped = false, angle = 0
  for (const char of raw) {
    if (escaped) { text += char; escaped = false; continue }
    if (quoted && char === '\\') { text += char; escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (!quoted && char === '<') angle++
    if (!quoted && char === '>') angle--
    if (angle < 0 || angle > 1) return null
    if (!quoted && !angle && char === ',') { parts.push(text); text = '' } else text += char
  }
  if (quoted || escaped || angle) return null
  parts.push(text)
  if (parts.length > 50) return null
  const result: string[] = []
  for (const part of parts) {
    const value = part.trim(), bracketed = /^(?:"(?:[^"\\]|\\.)*"|[^<>,;:]*)\s*<([^<>]+)>$/.exec(value)
    const email = (bracketed ? bracketed[1] : value).trim().toLowerCase()
    if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(email) || email.length > 254) return null
    if (!result.includes(email)) result.push(email)
  }
  return result
}

export function mailReplyAddresses(message: { fromAddress?: unknown; replyToAddress?: unknown; replyToAmbiguous?: unknown; to?: unknown; cc?: unknown }, own: string[], all = false): { to: string[]; cc: string[] } {
  const excluded = new Set(own.map(value => value.toLowerCase()))
  const reply = message.replyToAmbiguous === true ? null : mailAddressList(message.replyToAddress || message.fromAddress)
  if (!reply || reply.length !== 1) throw Error('The original reply address is ambiguous. Enter the recipient explicitly before sending.')
  const to = reply.filter(value => !excluded.has(value))
  if (!to.length) throw Error('The original message points back to this mailbox. Enter the recipient explicitly.')
  if (!all) return { to, cc: [] }
  const originalTo = mailAddressList(message.to ?? []), originalCc = mailAddressList(message.cc ?? [])
  if (!originalTo || !originalCc) throw Error('The original recipient list is incomplete. Review recipients before using Reply all.')
  return { to, cc: [...new Set([...originalTo, ...originalCc])].filter(value => !excluded.has(value) && !to.includes(value)) }
}
