import { createHash } from 'node:crypto'

export interface MailOutgoingAttachment { name: string; mimeType: string; size: number; sha256: string; dataBase64: string }
export const MAIL_OUTGOING_FILE_BYTES = 2 * 1024 * 1024
export const MAIL_OUTGOING_JSON_BYTES = 3 * 1024 * 1024

/** Validate decoded bytes before persisting or building a provider payload. */
export function mailOutgoingAttachments(raw: unknown): MailOutgoingAttachment[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length > 5) throw new Error('Select at most five mail attachments.')
  let total = 0
  return raw.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid mail attachment.')
    const file = value as Record<string, unknown>
    if (typeof file.name !== 'string' || !file.name.trim() || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)
      || typeof file.mimeType !== 'string' || file.mimeType.length > 127 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType)
      || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAIL_OUTGOING_FILE_BYTES
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)
      || typeof file.dataBase64 !== 'string' || file.dataBase64.length !== Math.ceil(file.size / 3) * 4
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.dataBase64)) throw new Error('Invalid mail attachment.')
    total += file.size
    if (total > MAIL_OUTGOING_FILE_BYTES) throw new Error('Mail attachments exceed the 2 MiB combined limit.')
    const bytes = Buffer.from(file.dataBase64, 'base64')
    try {
      if (bytes.length !== file.size || bytes.toString('base64') !== file.dataBase64
        || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Mail attachment content changed.')
    } finally { bytes.fill(0) }
    return { name: file.name, mimeType: file.mimeType, size: file.size, sha256: file.sha256, dataBase64: file.dataBase64 }
  })
}

export function mailAttachmentMimeParts(files: readonly MailOutgoingAttachment[], boundary: string): string[] {
  return files.flatMap(file => {
    // RFC2231 UTF-8 parameter avoids raw filenames becoming MIME headers.
    const encodedName = encodeURIComponent(file.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
    const segments = encodedName.match(/(?:%[0-9A-F]{2}|[^%]){1,45}/g) ?? []
    const parameters = segments.map((segment, index) => ` filename*${index}*=${index === 0 ? "UTF-8''" : ''}${segment}`).join(';\r\n')
    return [`--${boundary}`, `Content-Type: ${file.mimeType}`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment;\r\n${parameters}`, '', file.dataBase64.match(/.{1,76}/g)?.join('\r\n') ?? '']
  })
}
