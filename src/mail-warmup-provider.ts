import { googleDetail, mailboxId } from './mail-provider-mailbox.js'
import { verifiedWarmupReceipt, type OAuthWarmupJob, type WarmupReceipt } from './mail-warmup.js'

type Call = (url: string, init?: RequestInit, maxBytes?: number) => Promise<Record<string, unknown>>
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
function addresses(raw: string): string[] {
  // Generated tests use ASCII addresses. No decoding, HTML interpretation, or
  // permissive substring match against a display name can establish ownership.
  return raw.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).flatMap(part => {
    const match = /^(?:[^<>\r\n]*<)?([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63})>?$/.exec(part.trim())
    return match ? [match[1]] : []
  })
}
export function warmupMime(job: OAuthWarmupJob): string {
  // Every field comes from a validated owner mailbox or cryptographic native
  // job, never a renderer-supplied arbitrary header.
  if (![job.from, job.to, job.subject, job.rfcId, job.inReplyTo ?? ''].every(value => !/[\r\n\0]/.test(value))) throw new Error('Invalid test headers')
  return [`From: ${job.from}`, `To: ${job.to}`, `Subject: ${job.subject}`, `Message-ID: ${job.rfcId}`,
    ...(job.inReplyTo ? [`In-Reply-To: ${job.inReplyTo}`, `References: ${job.inReplyTo}`] : []),
    'Auto-Submitted: auto-generated', 'X-Auto-Response-Suppress: All', 'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    Buffer.from(job.text).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''].join('\r\n')
}
/** Exact RFC-id query, then independently verify real provider message fields.
 * Gmail full bodies require gmail.modify; Graph bodies require Mail.ReadWrite
 * under the explicit mailbox consent flow. Neither metadata scope suffices. */
export async function readWarmupReceipt(provider: 'google' | 'microsoft', job: OAuthWarmupJob, call: Call): Promise<WarmupReceipt | null> {
  if (!/^<[a-f0-9-]{36}@warmup\.vaid\.invalid>$/.test(job.rfcId)) throw new Error('Invalid delivery test identity')
  if (provider === 'google') {
    const query = new URLSearchParams({ q: `rfc822msgid:${job.rfcId} -in:sent -in:drafts`, includeSpamTrash: 'true', maxResults: '2' })
    const list = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${query}`)
    if (list.messages === undefined) return null
    if (!Array.isArray(list.messages) || list.messages.length > 2) throw new Error('Invalid receipt page')
    for (const item of list.messages) {
      const id = mailboxId(object(item).id)
      const raw = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {}, 2 * 1024 * 1024)
      const payload = object(raw.payload), fields = Array.isArray(payload.headers) ? payload.headers.map(object) : []
      const header = (name: string) => {
        const matches = fields.filter(field => text(field.name).toLowerCase() === name.toLowerCase())
        return matches.length === 1 ? text(matches[0].value) : ''
      }
      const labels = Array.isArray(raw.labelIds) ? raw.labelIds : []
      if (labels.includes('SENT') || labels.includes('DRAFT')) continue
      const body = googleDetail(raw)
      const from = addresses(header('From'))
      if (from.length !== 1 || body.bodyFormat !== 'text' || body.bodyTruncated) continue
      const receipt = { id, rfcId: header('Message-ID').trim(), from: from[0], to: addresses(header('To')), subject: header('Subject'), text: body.text }
      if (verifiedWarmupReceipt(job, receipt)) return receipt
    }
    return null
  }
  // Search the mailbox, including Junk/Archive/Deleted Items. Resolve real
  // Sent/Drafts folder IDs, so outbound copies never attest inbound delivery.
  const query = new URLSearchParams({ '$filter': `internetMessageId eq '${job.rfcId}'`, '$top': '2',
    '$select': 'id,internetMessageId,from,toRecipients,subject,body,isDraft,receivedDateTime,parentFolderId' })
  const list = await call(`https://graph.microsoft.com/v1.0/me/messages?${query}`, { headers: { Prefer: 'outlook.body-content-type="text"' } }, 2 * 1024 * 1024)
  if (!Array.isArray(list.value) || list.value.length > 2) throw new Error('Invalid receipt page')
  if (!list.value.length) return null
  const excluded = new Set(await Promise.all(['sentitems', 'drafts'].map(async folder => mailboxId((await call(`https://graph.microsoft.com/v1.0/me/mailFolders/${folder}?$select=id`)).id))))
  for (const item of list.value) {
    const row = object(item), body = object(row.body)
    if (row.isDraft !== false || !text(row.parentFolderId) || excluded.has(text(row.parentFolderId)) || !Number.isFinite(Date.parse(text(row.receivedDateTime))) || text(body.contentType).toLowerCase() !== 'text'
      || !Array.isArray(row.toRecipients) || text(body.content).length > 262144) continue
    const receipt = { id: mailboxId(row.id), rfcId: text(row.internetMessageId), from: text(object(object(row.from).emailAddress).address),
      to: row.toRecipients.map(item => text(object(object(item).emailAddress).address)), subject: text(row.subject), text: text(body.content) }
    if (verifiedWarmupReceipt(job, receipt)) return receipt
  }
  return null
}
