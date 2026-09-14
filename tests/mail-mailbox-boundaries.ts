/** Real encrypted permission/cursor gates and deterministic MIME projection.
 * No provider traffic, OAuth token, delivery result or user mailbox is simulated. */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailStore } from '../src/mail-store.js'
import { MailOAuthError, MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'
import { googleDetail, googleMessage, mailboxCategories, mailboxId, microsoftDetail, microsoftMessage } from '../src/mail-provider-mailbox.js'

const key = { key: randomBytes(32) }, directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-mailbox-boundaries-')))
const owner: MailIdentity = { teamId: randomUUID(), memberId: randomUUID(), projectId: randomUUID(), deviceId: randomUUID() }
const reader = { ...owner, memberId: randomUUID(), deviceId: randomUUID() }
const scope = (value: MailIdentity) => JSON.stringify({ teamId: value.teamId, memberId: value.memberId, projectId: value.projectId, deviceId: value.deviceId })
const id = randomUUID()
const accessId = (value: MailIdentity) => createHash('sha256').update(`${scope(value)}\n${id}`).digest('hex')
let storage: MailStore | undefined, service: MailOAuthService | undefined
const code = (expected: string) => (error: unknown) => error instanceof MailOAuthError && error.code === expected
try {
  storage = new MailStore({ dataDir: directory, key }); await storage.ready()
  // Authorization-only records deliberately omit provider, address and tokens.
  await storage.batch([
    { collection: 'connections', id, owner: scope(owner), value: { id, identity: owner, readInbox: true, mailboxAccess: true, enabled: true } },
    ...[owner, reader].map(who => ({ collection: 'access', id: accessId(who), owner: scope(who), account: id,
      value: { connectionId: id, identity: who, send: false, read: true, manage: who === owner } })),
  ])
  await storage.close()
  service = new MailOAuthService({ dataDir: directory, key, publicUrl: 'http://127.0.0.1:32123' }); await service.ready()
  service.startWorkers(() => true)
  const internal = service as unknown as {
    scopes(provider: 'google' | 'microsoft', read: boolean, manage?: boolean): string[]
    encodeCursor(owner: MailIdentity, id: string, page: string, context: string): string
    decodeCursor(owner: MailIdentity, id: string, token: string, context: string): string
    changeAuthority(id: string): void
    requestGate(owner: MailIdentity, id: string, check: () => boolean, permission: 'manage'): { before(): Promise<void>; authorized(): boolean; assertCurrent(): void }
  }
  assert.ok(internal.scopes('google', true).includes('https://www.googleapis.com/auth/gmail.metadata'))
  assert.ok(!internal.scopes('google', true).includes('https://www.googleapis.com/auth/gmail.modify'))
  assert.ok(internal.scopes('google', true, true).includes('https://www.googleapis.com/auth/gmail.modify'))
  assert.ok(!internal.scopes('microsoft', true).includes('Mail.ReadWrite'))
  assert.ok(internal.scopes('microsoft', true, true).includes('Mail.ReadWrite'))
  assert.ok(!internal.scopes('microsoft', false).includes('Mail.ReadBasic'))
  assert.equal((await service.list(reader)).connections[0].canModify, false, 'old read grant does not gain mailbox mutation permission')
  assert.equal((await service.list(owner)).connections[0].canModify, true)
  await assert.rejects(service.message(reader, id, 'abc', () => true), code('not_found'), 'old summary grant does not gain full body access')
  await assert.rejects(service.attachments(reader, id, 'abc', () => true), code('not_found'), 'old summary grant does not gain attachment metadata access')
  await assert.rejects(service.attachment(reader, id, 'abc', 'g_MQ', () => true), code('not_found'), 'old summary grant does not gain attachment byte access')
  await assert.rejects(service.attachment({ ...owner, projectId: randomUUID() }, id, 'abc', 'g_MQ', () => true), code('not_found'))
  await assert.rejects(service.attachment(owner, id, 'abc', 'g_MQ', () => false), code('unauthorized'))
  await assert.rejects(service.updateMessage(reader, id, { messageId: 'abc', isRead: true }, () => true), code('not_found'))
  await assert.rejects(service.createFolder(reader, id, 'Not created', () => true), code('not_found'))
  await assert.rejects(service.updateMessage(owner, id, { messageId: 'abc', isRead: true, folderId: 'TRASH' }, () => true), code('message'), 'moves cannot claim atomicity with mixed updates')
  await assert.rejects(service.folders(owner, id, () => false), code('unauthorized'))
  const cursor = internal.encodeCursor(owner, id, 'provider-page', 'messages:SPAM')
  assert.equal(internal.decodeCursor(owner, id, cursor, 'messages:SPAM'), 'provider-page')
  for (const [who, mailbox, context] of [[reader, id, 'messages:SPAM'], [owner, randomUUID(), 'messages:SPAM'], [owner, id, 'messages:INBOX'], [owner, id, 'folders:SPAM']] as const) {
    assert.throws(() => internal.decodeCursor(who, mailbox, cursor, context), code('cursor'))
  }
  assert.throws(() => internal.decodeCursor(owner, id, `x${cursor}`, 'messages:SPAM'), code('cursor'))
  const attachmentCursor = internal.encodeCursor(owner, id, '50', 'attachments:abc')
  assert.equal(internal.decodeCursor(owner, id, attachmentCursor, 'attachments:abc'), '50')
  assert.throws(() => internal.decodeCursor(owner, id, attachmentCursor, 'attachments:other'), code('cursor'))
  assert.throws(() => internal.decodeCursor(reader, id, attachmentCursor, 'attachments:abc'), code('cursor'))
  assert.throws(() => internal.decodeCursor(owner, id, attachmentCursor, 'messages:INBOX'), code('cursor'))
  let authorized = true
  const gate = internal.requestGate(owner, id, () => authorized, 'manage')
  await gate.before(); assert.equal(gate.authorized(), true)
  authorized = false; assert.equal(gate.authorized(), false)
  await assert.rejects(gate.before(), code('unauthorized'))
  authorized = true
  let observations = 0
  const midAwait = internal.requestGate(owner, id, () => ++observations < 2, 'manage')
  await assert.rejects(midAwait.before(), code('unauthorized'), 'authorization lost during SQLite await must fail before dispatch')
  const consent = internal.requestGate(owner, id, () => true, 'manage')
  await consent.before(); internal.changeAuthority(id)
  assert.throws(() => consent.assertCurrent(), code('authority_changed'))
  await service.close()

  // Deterministic inputs exercise the production parsers, not provider responses.
  const base = { id: 'abc123', payload: { headers: [{ name: 'Subject', value: 'Plain subject' }] }, labelIds: ['INBOX', 'UNREAD', 'STARRED', 'Label_7'] }
  assert.equal(googleMessage(base).isRead, false)
  assert.equal(googleMessage(base).starred, true)
  assert.equal(googleMessage({ ...base, labelIds: [] }).isRead, true)
  assert.equal(googleMessage({ id: 'abc123' }).isRead, undefined, 'missing flag data is not invented as read')
  const encoded = 'AAMk+base64/part=='; assert.equal(mailboxId(encoded), encoded)
  assert.equal(mailboxId('a'.repeat(2048)).length, 2048)
  for (const invalid of ['../message', 'a?query=1', 'a#hash', '%2f', 'a'.repeat(2049), 'x\nAuthorization']) assert.throws(() => mailboxId(invalid))
  assert.throws(() => googleMessage({ id: 'abc', labelIds: ['bad?label'] }))
  assert.throws(() => microsoftMessage({ id: 'bad?path' }))
  assert.throws(() => mailboxCategories(['ok', 'bad\ncategory']))
  const hostile = '<script>throw new Error("not executed")</script><img src="https://invalid.example/tracker">'
  const html = googleDetail({ ...base, payload: { mimeType: 'text/html', body: { data: Buffer.from(hostile).toString('base64url') } } })
  assert.equal(html.bodyFormat, 'html-source'); assert.equal(html.text, hostile)
  const mime = googleDetail({ ...base, payload: { mimeType: 'multipart/mixed', parts: [
    { mimeType: 'text/plain', body: { data: Buffer.from('Safe body').toString('base64url') } },
    { mimeType: 'application/pdf', filename: 'document.pdf', body: { size: 10, attachmentId: 'provider-attachment-reference', data: Buffer.from('do not expose').toString('base64url') } },
  ] } })
  assert.equal(mime.text, 'Safe body'); assert.equal(mime.hasAttachments, true); assert.equal(mime.attachments.length, 1)
  assert.ok(!JSON.stringify(mime).includes('provider-attachment-reference')); assert.ok(!JSON.stringify(mime).includes('do not expose'))
  const huge = googleDetail({ ...base, payload: { mimeType: 'text/plain', body: { data: Buffer.alloc(300000, 'a').toString('base64url') } } })
  assert.equal(huge.bodyTruncated, true); assert.equal(huge.text.length, 262144)
  const charset = googleDetail({ ...base, payload: { mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=iso-8859-1' }], body: { data: Buffer.from([0xe9]).toString('base64url') } } })
  assert.equal(charset.text, 'é')
  const externalBody = googleDetail({ ...base, payload: { mimeType: 'text/plain', body: { attachmentId: 'not-downloaded', size: 500000 } } })
  assert.equal(externalBody.bodyTruncated, true)
  const graph = microsoftDetail({ id: encoded, isRead: false, flag: { flagStatus: 'flagged' }, categories: ['Client'], body: { contentType: 'html', content: hostile } })
  assert.equal(graph.isRead, false); assert.equal(graph.starred, true); assert.equal(graph.text, hostile); assert.equal(graph.bodyFormat, 'html-source')
  assert.equal(microsoftDetail({ id: encoded, body: { contentType: 'text', content: 'a'.repeat(300000) } }).bodyTruncated, true)
  console.log('PASS: real encrypted read/manage grant boundaries, revoked-await and consent fences, cursor owner/mailbox/folder binding, explicit scopes, encoded IDs and bounded inert MIME/Graph projection; no provider requests')
} finally {
  await service?.close().catch(() => undefined); await storage?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
}
