/** Deterministic MIME/Graph projections and byte validation only.
 * These checks do not claim a live provider download or antivirus verdict. */
import assert from 'node:assert/strict'
import { attachmentId, decodeAttachmentBytes, fetchProviderAttachment, googleAttachmentParts, microsoftAttachment, MAIL_ATTACHMENT_MAX_BYTES } from '../src/mail-provider-attachments.js'

const bytes = Buffer.from('Attachment parser boundary\n')
const googlePart = { partId: '1.2', filename: 'report.txt', mimeType: 'text/plain', body: { size: bytes.length, attachmentId: 'provider+attachment/reference==' } }
const google = googleAttachmentParts({ payload: { mimeType: 'multipart/mixed', parts: [googlePart] } })[0]
assert.equal(google.metadata.id, `g_${Buffer.from('1.2').toString('base64url')}`)
assert.equal(google.metadata.downloadable, true)
assert.ok(!JSON.stringify(google.metadata).includes('provider+attachment/reference=='), 'renderer metadata uses a message part selector, not a provider content reference')
assert.equal(googleAttachmentParts({ payload: { ...googlePart, body: { size: bytes.length, data: bytes.toString('base64url') } } })[0].metadata.downloadable, true)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, partId: undefined } })[0].metadata.downloadable, false)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, mimeType: 'message/rfc822' } })[0].metadata.downloadable, false)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, headers: [{ name: 'Content-ID', value: '<image>' }] } })[0].metadata.downloadable, false)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, body: { ...googlePart.body, size: MAIL_ATTACHMENT_MAX_BYTES + 1 } } })[0].metadata.downloadable, false)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, body: { ...googlePart.body, size: -1 } } })[0].metadata.downloadable, false)
assert.equal(googleAttachmentParts({ payload: { ...googlePart, body: { size: 0, data: '' } } })[0].metadata.downloadable, false)
assert.throws(() => googleAttachmentParts({ payload: { parts: [googlePart, googlePart] } }), /duplicate/)
assert.throws(() => googleAttachmentParts({ payload: { parts: Array.from({ length: 1001 }, (_, index) => ({ partId: String(index) })) } }), /safe limit/)
const recursive: { parts?: unknown[] } = {}; recursive.parts = [recursive]
assert.throws(() => googleAttachmentParts({ payload: recursive }), /safe limit/)

const graph = { id: 'AAMk+file/part==', '@odata.type': '#microsoft.graph.fileAttachment', name: 'report.txt', size: bytes.length, contentType: 'text/plain', isInline: false }
assert.equal(microsoftAttachment(graph).downloadable, true)
for (const kind of ['#microsoft.graph.referenceAttachment', '#microsoft.graph.itemAttachment', '#unknown']) {
  const item = microsoftAttachment({ ...graph, '@odata.type': kind, sourceUrl: 'https://invalid.example/never-fetch' })
  assert.equal(item.downloadable, false); assert.ok(item.unavailableReason)
  assert.ok(!JSON.stringify(item).includes('invalid.example'))
}
assert.equal(microsoftAttachment({ ...graph, isInline: true }).downloadable, false)
assert.equal(microsoftAttachment({ ...graph, isInline: undefined }).downloadable, false)
assert.equal(microsoftAttachment({ ...graph, size: undefined }).downloadable, false)
assert.equal(microsoftAttachment({ ...graph, size: MAIL_ATTACHMENT_MAX_BYTES + 1 }).downloadable, false)
assert.throws(() => microsoftAttachment({ ...graph, id: '../attachment' }))
assert.equal(attachmentId(graph.id), graph.id)
for (const id of ['../a', 'a?query', 'a#fragment', '%2F', 'https://invalid.example/a', 'a\n', 'a'.repeat(2049)]) assert.throws(() => attachmentId(id))
for (const encoding of ['base64', 'base64url'] as const) {
  assert.deepEqual(decodeAttachmentBytes(bytes.toString(encoding), encoding, bytes.length), bytes)
  assert.throws(() => decodeAttachmentBytes(bytes.toString(encoding), encoding, bytes.length + 1))
  for (const bad of ['a', 'AQ=', 'AB==', '!!', 'AA===', 'AA==\n']) assert.throws(() => decodeAttachmentBytes(bad, encoding))
}
assert.throws(() => decodeAttachmentBytes('A'.repeat(Math.ceil(MAIL_ATTACHMENT_MAX_BYTES / 3) * 4 + 4), 'base64'))
const exactLimit = Buffer.alloc(MAIL_ATTACHMENT_MAX_BYTES)
const decodedLimit = decodeAttachmentBytes(exactLimit.toString('base64'), 'base64', MAIL_ATTACHMENT_MAX_BYTES)
assert.equal(decodedLimit.length, MAIL_ATTACHMENT_MAX_BYTES)
decodedLimit.fill(0)
// One extra byte has the same base64 character count at this boundary.
// The decoded-byte bound must still refuse it independently of encoded size.
assert.throws(() => decodeAttachmentBytes(Buffer.alloc(MAIL_ATTACHMENT_MAX_BYTES + 1).toString('base64'), 'base64'))
const noProviderTraffic = async (): Promise<Record<string, unknown>> => { assert.fail('Invalid identifiers must fail before provider access') }
await assert.rejects(fetchProviderAttachment('google', '../message', 'g_MQ', noProviderTraffic), /Invalid attachment/)
await assert.rejects(fetchProviderAttachment('microsoft', 'valid-message', 'https://invalid.example/attachment', noProviderTraffic), /Invalid attachment/)
console.log('PASS: bounded Gmail MIME part selection, Microsoft attachment kinds, opaque IDs, canonical base64 and decoded byte limits; no provider traffic')
