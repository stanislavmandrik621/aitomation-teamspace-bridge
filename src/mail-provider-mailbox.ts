/** Provider mailbox projection. Message HTML is never rendered or fetched here. */
import { mailAddressList, mailReplyAddresses } from './mail-recipient-list.js'
export interface MailboxMessage {
  id: string; subject: string; from: string; receivedAt: string; isRead?: boolean; starred?: boolean
  labels: string[]; folderId?: string; hasAttachments?: boolean; warmup?: boolean
  threadId?: string; fromAddress?: string; replyToAddress?: string; internetMessageId?: string; references?: string; direction?: 'inbound' | 'outbound'
  to?: string[]; cc?: string[]; recipientsComplete?: boolean; replyToAmbiguous?: boolean
}
export interface MailboxFolder { id: string; name: string; kind: 'label' | 'folder'; system: boolean; childCount?: number; unreadCount?: number; totalCount?: number }
export interface MailboxDetail extends MailboxMessage { text: string; bodyFormat: 'text' | 'html-source'; bodyTruncated: boolean; attachments: Array<{ name: string; contentType: string; size: number }> }
export interface MailboxUpdate { messageId: string; isRead?: boolean; starred?: boolean; folderId?: string; addLabels?: string[]; removeLabels?: string[]; categories?: string[] }
const object = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
const clean = (raw: unknown, max: number) => typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : ''
/** One mailbox only. Ambiguous lists and header injection are never repaired. */
export function singleReplyAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1000 || /[\r\n\0]/.test(raw)) return undefined
  const text = raw.trim(), angle = /^[^<>]*<([^<>]+)>$/.exec(text)
  if (angle) {
    const display = text.slice(0, text.indexOf('<')).trim()
    // A preceding bare address is a list, not a display name. Commas in an
    // explicitly quoted display name are legitimate RFC mailbox syntax.
    if (display.includes('@') || (display.includes(',') && !/^"(?:[^"\\]|\\.)*"$/.test(display))) return undefined
  }
  const address = angle ? angle[1] : text
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(address) && address.length <= 254 ? address.toLowerCase() : undefined
}
function originalHeader(message: Record<string, unknown>, name: string): string | undefined {
  const headers = object(message.payload).headers
  if (!Array.isArray(headers)) return undefined
  const matches = headers.map(object).filter(header => typeof header.name === 'string' && header.name.toLowerCase() === name)
  if (matches.length !== 1 || typeof matches[0].value !== 'string' || /[\r\n\0]/.test(matches[0].value)) return undefined
  return matches[0].value
}
export interface MailReplyTarget { messageId: string; threadId: string; recipient: string; fromAddress: string; subject: string; internetMessageId?: string; references?: string; replyAllCc?: string[] }
export function providerReplyTarget(provider: 'google' | 'microsoft', raw: unknown, messageId: string, ownAddress: string): MailReplyTarget {
  const source = object(raw)
  if (mailboxId(source.id) !== mailboxId(messageId)) throw new Error('Original reply message identity changed')
  const projected = provider === 'google' ? googleMessage(raw) : microsoftMessage(raw)
  const fromAddress = projected.fromAddress
  if (!fromAddress || fromAddress === ownAddress.toLowerCase() || projected.direction === 'outbound') throw new Error('The original message is not a verified incoming email')
  const headers = object(source.payload).headers
  const hasGoogleReplyTo = Array.isArray(headers) && headers.some(header => String(object(header).name).toLowerCase() === 'reply-to')
  const rawReplyTo = provider === 'google' ? originalHeader(source, 'reply-to') : source.replyTo
  // A present but malformed/multi-recipient Reply-To must never fall back to From.
  if ((hasGoogleReplyTo || rawReplyTo !== undefined) && !projected.replyToAddress && !(Array.isArray(rawReplyTo) && rawReplyTo.length === 0)) throw new Error('The original Reply-To is ambiguous')
  const recipient = projected.replyToAddress ?? fromAddress
  if (recipient === ownAddress.toLowerCase()) throw new Error('Cannot automatically reply to the connected mailbox itself')
  const subject = provider === 'google' ? originalHeader(source, 'subject') ?? '' : source.subject
  if (provider === 'google' && Array.isArray(headers) && headers.filter(header => String(object(header).name).toLowerCase() === 'subject').length > 1) throw new Error('The original subject is ambiguous')
  if (!projected.threadId || typeof subject !== 'string' || subject.length > 500 || /[\r\n\0]/.test(subject)) throw new Error('The original conversation or subject is unavailable')
  if (provider === 'google' && !projected.internetMessageId) throw new Error('The original Message-ID required for threading is missing')
  const replyAllCc = projected.recipientsComplete ? mailReplyAddresses(projected, [ownAddress], true).cc : undefined
  return { messageId, threadId: projected.threadId, recipient, fromAddress, subject, ...(replyAllCc ? { replyAllCc } : {}),
    ...(projected.internetMessageId ? { internetMessageId: projected.internetMessageId } : {}), ...(projected.references ? { references: projected.references } : {}) }
}
export function mailboxId(raw: unknown): string {
  // Google IDs, Graph opaque base64 IDs and well-known folder names. No URL components.
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_=+\/-]{1,2048}$/.test(raw)) throw new Error('Invalid mailbox identifier')
  return raw
}
export function mailboxLabels(raw: unknown, max = 100): string[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > max) throw new Error('Invalid mailbox label list')
  return [...new Set(raw.map(mailboxId))]
}
export function mailboxCategories(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 25 || raw.some(v => typeof v !== 'string' || !v.trim() || v.length > 255 || /[\u0000-\u001f\u007f]/.test(v))) throw new Error('Invalid mailbox categories')
  return [...new Set(raw as string[])]
}
export function googleMessage(raw: unknown): MailboxMessage {
  const message = object(raw), metadata = object(message.payload).headers
  const header = (name: string) => clean(Array.isArray(metadata) ? object(metadata.find(h => clean(object(h).name, 32).toLowerCase() === name)).value : '', name === 'subject' ? 500 : 500)
  const labels = mailboxLabels(message.labelIds)
  const fromAddress = singleReplyAddress(originalHeader(message, 'from')), replyToAddress = singleReplyAddress(originalHeader(message, 'reply-to'))
  const to = mailAddressList(originalHeader(message, 'to') ?? ''), cc = mailAddressList(originalHeader(message, 'cc') ?? '')
  const replyHeaderPresent = Array.isArray(metadata) && metadata.some(raw => String(object(raw).name).toLowerCase() === 'reply-to')
  const internetId = originalHeader(message, 'message-id'), references = originalHeader(message, 'references')
  const internalTime = typeof message.internalDate === 'string' && /^\d{10,13}$/.test(message.internalDate) ? Number(message.internalDate) : NaN
  return { id: mailboxId(message.id), subject: header('subject'), from: header('from'), receivedAt: Number.isFinite(internalTime) && internalTime > 0 ? new Date(internalTime).toISOString() : header('date'),
    ...(typeof message.threadId === 'string' ? { threadId: mailboxId(message.threadId) } : {}),
    ...(fromAddress ? { fromAddress } : {}), ...(replyToAddress ? { replyToAddress } : {}),
    to: to ?? [], cc: cc ?? [], recipientsComplete: !!to && !!cc, replyToAmbiguous: replyHeaderPresent && !replyToAddress,
    ...(internetId && /^<[^<>\s]{1,900}>$/.test(internetId) ? { internetMessageId: internetId } : {}),
    ...(references && references.length <= 8000 && /^(?:<[^<>\s]+>\s*)+$/.test(references) ? { references: references.trim() } : {}),
    ...(Array.isArray(message.labelIds) ? { isRead: !labels.includes('UNREAD'), starred: labels.includes('STARRED'), direction: labels.includes('SENT') || labels.includes('DRAFT') ? 'outbound' as const : 'inbound' as const } : {}), labels }
}
export function microsoftMessage(raw: unknown): MailboxMessage {
  const message = object(raw)
  const recipients = (raw: unknown) => Array.isArray(raw) ? mailAddressList(raw.map(item => object(object(item).emailAddress).address)) : raw == null ? [] : null
  const to = recipients(message.toRecipients), cc = recipients(message.ccRecipients)
  const fromAddress = singleReplyAddress(object(object(message.from).emailAddress).address)
  const replyToAddress = Array.isArray(message.replyTo) && message.replyTo.length === 1 ? singleReplyAddress(object(object(message.replyTo[0]).emailAddress).address) : undefined
  return { id: mailboxId(message.id), subject: clean(message.subject, 500), from: clean(object(object(message.from).emailAddress).address, 500), receivedAt: clean(message.receivedDateTime, 100),
    ...(typeof message.conversationId === 'string' ? { threadId: mailboxId(message.conversationId) } : {}),
    ...(fromAddress ? { fromAddress } : {}), ...(replyToAddress ? { replyToAddress } : {}),
    to: to ?? [], cc: cc ?? [], recipientsComplete: !!to && !!cc,
    replyToAmbiguous: message.replyTo != null && (!Array.isArray(message.replyTo) || message.replyTo.length > 0 && !replyToAddress),
    ...(typeof message.internetMessageId === 'string' && /^<[^<>\s]{1,900}>$/.test(message.internetMessageId) ? { internetMessageId: message.internetMessageId } : {}),
    ...(message.isDraft === true ? { direction: 'outbound' as const } : {}),
    ...(typeof message.isRead === 'boolean' ? { isRead: message.isRead } : {}),
    ...(typeof object(message.flag).flagStatus === 'string' ? { starred: object(message.flag).flagStatus === 'flagged' } : {}),
    labels: Array.isArray(message.categories) ? mailboxCategories(message.categories) : [],
    ...(typeof message.parentFolderId === 'string' ? { folderId: mailboxId(message.parentFolderId) } : {}), hasAttachments: message.hasAttachments === true }
}
export function googleDetail(raw: unknown): MailboxDetail {
  const message = object(raw), plain: string[] = [], html: string[] = [], attachments: MailboxDetail['attachments'] = []
  let visited = 0, bytes = 0, bodyTruncated = false
  const walk = (rawPart: unknown, depth: number) => {
    if (++visited > 1000 || depth > 30) { bodyTruncated = true; return }
    const part = object(rawPart), body = object(part.body), name = clean(part.filename, 255), contentType = clean(part.mimeType, 200)
    if (name || body.attachmentId) {
      if (!name && ['text/plain', 'text/html'].includes(contentType)) bodyTruncated = true
      attachments.push({ name: name || 'Attachment', contentType, size: typeof body.size === 'number' && body.size >= 0 ? body.size : 0 })
      // Attachment content is deliberately not exposed without quarantine/scanning.
      return
    }
    if (['text/plain', 'text/html'].includes(contentType) && typeof body.data === 'string') {
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)) throw new Error('Invalid MIME body encoding')
      const data = Buffer.from(body.data, 'base64url')
      const remaining = Math.max(0, 262144 - bytes)
      if (data.byteLength > remaining) bodyTruncated = true
      const partHeaders = Array.isArray(part.headers) ? part.headers : []
      const typeHeader = clean(object(partHeaders.find(header => clean(object(header).name, 40).toLowerCase() === 'content-type')).value, 500)
      const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(typeHeader)?.[1] || 'utf-8'
      let value: string
      try { value = new TextDecoder(charset, { fatal: true }).decode(data.subarray(0, remaining)) }
      catch { value = data.subarray(0, remaining).toString('utf8'); bodyTruncated = true }
      value = value.replace(/\0/g, '')
      bytes += Math.min(data.byteLength, remaining)
      ;(contentType === 'text/plain' ? plain : html).push(value)
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1)
  }
  walk(message.payload, 0)
  const joined = (plain.length ? plain : html).join('\n')
  return { ...googleMessage(message), text: joined.slice(0, 262144), bodyFormat: plain.length || !html.length ? 'text' : 'html-source', bodyTruncated: bodyTruncated || joined.length > 262144, attachments, hasAttachments: attachments.length > 0 }
}
export function microsoftDetail(raw: unknown): MailboxDetail {
  const message = object(raw), body = object(message.body), content = typeof body.content === 'string' ? body.content.replace(/\0/g, '') : ''
  return { ...microsoftMessage(message), text: content.slice(0, 262144), bodyFormat: String(body.contentType).toLowerCase() === 'html' ? 'html-source' : 'text', bodyTruncated: content.length > 262144, attachments: [] }
}
