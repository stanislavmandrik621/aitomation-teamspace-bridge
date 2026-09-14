/** Provider metadata and bytes only. Callers must scan bytes before offering a save. */
export const MAIL_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
export const MAIL_ATTACHMENT_JSON_MAX_BYTES = Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4 + 128 * 1024
export interface MailboxAttachment {
  id?: string; name: string; contentType: string; size: number; inline: boolean; downloadable: boolean; unavailableReason?: string
}
export type ProviderMailboxCall = (url: string, init?: RequestInit, maxBytes?: number) => Promise<Record<string, unknown>>
const object = (raw: unknown): Record<string, unknown> => raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
const clean = (raw: unknown, max: number) => typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max).trim() : ''
export function attachmentId(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_=+\/-]{1,2048}$/.test(raw)) throw new Error('Invalid attachment identifier')
  return raw
}
function metadata(input: { id?: string; name: unknown; contentType: unknown; size: unknown; inline: boolean; reason?: string }): MailboxAttachment {
  const sizeKnown = typeof input.size === 'number' && Number.isSafeInteger(input.size) && input.size >= 0
  const size = sizeKnown ? input.size as number : 0
  const reason = input.reason || (!input.id ? 'The provider did not supply a usable attachment identifier.' : !sizeKnown ? 'The provider did not supply a valid attachment size.' : size === 0 ? 'Empty attachments are not available for download.' : size > MAIL_ATTACHMENT_MAX_BYTES ? 'This attachment exceeds the 10 MiB download limit.' : undefined)
  return { ...(input.id ? { id: input.id } : {}), name: clean(input.name, 255) || 'Attachment', contentType: clean(input.contentType, 200) || 'application/octet-stream',
    size, inline: input.inline, downloadable: !reason, ...(reason ? { unavailableReason: reason } : {}) }
}
export function googleAttachmentParts(raw: unknown): Array<{ metadata: MailboxAttachment; body: Record<string, unknown> }> {
  const found: Array<{ metadata: MailboxAttachment; body: Record<string, unknown> }> = []
  const seenIds = new Set<string>()
  let visited = 0
  const walk = (value: unknown, depth: number) => {
    if (++visited > 1000 || depth > 30) throw new Error('The MIME attachment structure exceeds the safe limit')
    const part = object(value), body = object(part.body), contentType = clean(part.mimeType, 200).toLowerCase()
    const headers = Array.isArray(part.headers) ? part.headers : []
    const header = (name: string) => clean(object(headers.find(h => clean(object(h).name, 100).toLowerCase() === name)).value, 1000)
    const inline = /^inline(?:\s*;|$)/i.test(header('content-disposition')) || !!header('content-id')
    if (clean(part.filename, 255) || body.attachmentId || (/^attachment(?:\s*;|$)/i.test(header('content-disposition')) && typeof body.data === 'string')) {
      // The immutable provider partId selects inline-encoded and external
      // MessagePartBody equally. No renderer-provided path or download URL.
      const partId = typeof part.partId === 'string' && part.partId.length <= 512 && !/[\u0000-\u001f\u007f]/.test(part.partId) ? part.partId : undefined
      const id = partId !== undefined ? `g_${Buffer.from(partId, 'utf8').toString('base64url')}` : undefined
      if (id && seenIds.has(id)) throw new Error('The provider returned duplicate MIME part identifiers')
      if (id) seenIds.add(id)
      const reason = inline ? 'Inline content is not offered as a downloadable file. View the original in your provider.'
        : contentType === 'message/rfc822' || contentType.startsWith('multipart/') ? 'Embedded messages and MIME containers are not supported for download.'
        : typeof body.data !== 'string' && typeof body.attachmentId !== 'string' ? 'The provider did not return attachment content or a content reference.' : undefined
      found.push({ metadata: metadata({ id, name: part.filename, contentType, size: body.size, inline, reason }), body })
      return
    }
    if (Array.isArray(part.parts)) for (const child of part.parts) walk(child, depth + 1)
  }
  walk(object(raw).payload, 0)
  return found
}
export function microsoftAttachment(raw: unknown): MailboxAttachment {
  const row = object(raw), kind = String(row['@odata.type']).replace(/^#/, '')
  const id = typeof row.id === 'string' ? attachmentId(row.id) : undefined
  const inline = row.isInline === true
  const reason = kind !== 'microsoft.graph.fileAttachment' ? kind === 'microsoft.graph.referenceAttachment'
    ? 'Cloud-link attachments are not downloaded. Open the original in your provider.'
    : kind === 'microsoft.graph.itemAttachment' ? 'Embedded Outlook items are not supported for download.' : 'The provider returned an unsupported attachment type.'
    : typeof row.isInline !== 'boolean' ? 'The provider did not supply attachment disposition metadata.'
    : inline ? 'Inline content is not offered as a downloadable file. View the original in your provider.' : undefined
  return metadata({ id, name: row.name, contentType: row.contentType, size: row.size, inline, reason })
}
export function decodeAttachmentBytes(raw: unknown, encoding: 'base64' | 'base64url', expectedSize?: number): Buffer {
  const alphabet = encoding === 'base64url' ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/
  if (typeof raw !== 'string' || raw.length > Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4 || !alphabet.test(raw) || raw.replace(/=+$/, '').length % 4 === 1) throw new Error('Invalid or oversized attachment encoding')
  const bytes = Buffer.from(raw, encoding)
  const canonical = bytes.toString(encoding).replace(/=+$/, '')
  const padded = canonical + '='.repeat((4 - canonical.length % 4) % 4)
  if (bytes.length > MAIL_ATTACHMENT_MAX_BYTES || (raw !== canonical && raw !== padded) || (expectedSize !== undefined && bytes.length !== expectedSize)) {
    bytes.fill(0); throw new Error('Attachment content length or encoding does not match provider metadata')
  }
  return bytes
}
export async function fetchProviderAttachment(provider: 'google' | 'microsoft', messageId: string, selectedId: string, call: ProviderMailboxCall) {
  const message = encodeURIComponent(attachmentId(messageId)), requested = attachmentId(selectedId)
  if (provider === 'google') {
    const parent = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message}?format=full`, {}, MAIL_ATTACHMENT_JSON_MAX_BYTES)
    if (parent.id !== messageId) throw new Error('Provider message identifier changed')
    const part = googleAttachmentParts(parent).find(part => part.metadata.id === requested)
    if (!part || !part.metadata.downloadable) throw new Error(part?.metadata.unavailableReason || 'Attachment is no longer present on this message')
    const body = typeof part.body.attachmentId === 'string'
      ? await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message}/attachments/${encodeURIComponent(attachmentId(part.body.attachmentId))}`, {}, MAIL_ATTACHMENT_JSON_MAX_BYTES)
      : part.body
    if (body.size !== part.metadata.size) throw new Error('Provider attachment size changed; refresh the message')
    return { metadata: part.metadata, bytes: decodeAttachmentBytes(body.data, 'base64url', part.metadata.size) }
  }
  const url = `https://graph.microsoft.com/v1.0/me/messages/${message}/attachments/${encodeURIComponent(requested)}`
  const initial = microsoftAttachment(await call(`${url}?$select=id,name,contentType,size,isInline`))
  if (initial.id !== requested || !initial.downloadable) throw new Error(initial.unavailableReason || 'Provider attachment identity changed')
  const raw = await call(url, {}, MAIL_ATTACHMENT_JSON_MAX_BYTES), verified = microsoftAttachment(raw)
  if (verified.id !== requested || !verified.downloadable || verified.name !== initial.name || verified.contentType !== initial.contentType || verified.size !== initial.size) throw new Error('Provider attachment changed; refresh the message')
  // Provider-reported attachment size and decoded file length are bounded
  // independently. Never follow contentLocation/sourceUrl.
  return { metadata: verified, bytes: decodeAttachmentBytes(raw.contentBytes, 'base64') }
}
