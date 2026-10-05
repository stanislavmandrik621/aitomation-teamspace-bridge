/** Provider mailbox projection. Message HTML is never rendered or fetched here. */
export interface MailboxMessage {
  id: string; subject: string; from: string; receivedAt: string; isRead?: boolean; starred?: boolean
  labels: string[]; folderId?: string; hasAttachments?: boolean; warmup?: boolean
}
export interface MailboxFolder { id: string; name: string; kind: 'label' | 'folder'; system: boolean; childCount?: number; unreadCount?: number; totalCount?: number }
export interface MailboxDetail extends MailboxMessage { text: string; bodyFormat: 'text' | 'html-source'; bodyTruncated: boolean; attachments: Array<{ name: string; contentType: string; size: number }> }
export interface MailboxUpdate { messageId: string; isRead?: boolean; starred?: boolean; folderId?: string; addLabels?: string[]; removeLabels?: string[]; categories?: string[] }
const object = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
const clean = (raw: unknown, max: number) => typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : ''
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
  return { id: mailboxId(message.id), subject: header('subject'), from: header('from'), receivedAt: header('date'),
    ...(Array.isArray(message.labelIds) ? { isRead: !labels.includes('UNREAD'), starred: labels.includes('STARRED') } : {}), labels }
}
export function microsoftMessage(raw: unknown): MailboxMessage {
  const message = object(raw)
  return { id: mailboxId(message.id), subject: clean(message.subject, 500), from: clean(object(object(message.from).emailAddress).address, 500), receivedAt: clean(message.receivedDateTime, 100),
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
