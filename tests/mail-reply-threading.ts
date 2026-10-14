import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { googleMessage, microsoftMessage, providerReplyTarget, singleReplyAddress } from '../src/mail-provider-mailbox.js'
import { mailProviderSendRequest, MailOAuthService, type MailIdentity } from '../src/mail-oauth-service.js'
import { mailOutgoingAttachments } from '../src/mail-outgoing-attachments.js'

const original = () => ({ id: 'source123', threadId: 'thread123', internalDate: '1791532800000', labelIds: ['INBOX'], payload: { headers: [
  { name: 'From', value: 'Alex <alex@example.com>' }, { name: 'Reply-To', value: 'replies@example.com' },
  { name: 'Subject', value: 'Meeting tomorrow' }, { name: 'Message-ID', value: '<original@example.com>' },
  { name: 'References', value: '<parent@example.com>' }, { name: 'Date', value: 'Invalid sender clock' },
] } })

test('Provider projection keeps real thread, strict recipient, and Gmail server receive time', () => {
  const projected = googleMessage(original())
  assert.equal(projected.threadId, 'thread123')
  assert.equal(projected.fromAddress, 'alex@example.com')
  assert.equal(projected.replyToAddress, 'replies@example.com')
  assert.equal(projected.receivedAt, new Date(1791532800000).toISOString())
  assert.equal(projected.direction, 'inbound')
  const outlook = microsoftMessage({ id: 'opaque+id==', conversationId: 'conversation+id==', subject: 'Hello', from: { emailAddress: { address: 'ALEX@example.com' } }, replyTo: [{ emailAddress: { address: 'reply@example.com' } }] })
  assert.equal(outlook.fromAddress, 'alex@example.com')
  assert.equal(outlook.replyToAddress, 'reply@example.com')
  assert.equal(outlook.threadId, 'conversation+id==')
  assert.equal(singleReplyAddress('"Last, First" <alex@example.com>'), 'alex@example.com')
  for (const address of ['a@example.com, b@example.com', 'a@example.com, Other <b@example.com>', 'Alex <a@example.com>, Other <b@example.com>', 'a@example.com\r\nBcc: thief@example.com']) assert.equal(singleReplyAddress(address), undefined)
})

test('Verified Gmail reply uses provider thread and RFC headers, preserving exact approved text', () => {
  const target = providerReplyTarget('google', original(), 'source123', 'owner@example.com')
  const result = mailProviderSendRequest('google', 'owner@example.com', { to: ['replies@example.com'], subject: 'Model must not change this subject', text: '  Yes.\nTomorrow works.  ', replyTarget: target })
  assert.equal(result.body.threadId, 'thread123')
  const mime = Buffer.from(result.body.raw as string, 'base64url').toString()
  assert.match(mime, /In-Reply-To: <original@example.com>/)
  assert.match(mime, /References: <parent@example.com> <original@example.com>/)
  assert.ok(mime.includes(Buffer.from('Meeting tomorrow').toString('base64')))
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), '  Yes.\nTomorrow works.  ')
  assert.throws(() => mailProviderSendRequest('google', 'owner@example.com', { to: ['attacker@example.com'], subject: 's', text: 't', replyTarget: target }))
})

test('Graph reply uses exact original endpoint with a Text body and verified Reply-To', () => {
  const source = { id: 'opaque+id==', conversationId: 'conversation', subject: 'Original', from: { emailAddress: { address: 'from@example.com' } }, replyTo: [{ emailAddress: { address: 'reply@example.com' } }] }
  const target = providerReplyTarget('microsoft', source, source.id, 'owner@example.com')
  const result = mailProviderSendRequest('microsoft', 'owner@example.com', { to: ['reply@example.com'], subject: 'Ignored', text: 'Approved body', replyTarget: target })
  assert.equal(result.url, 'https://graph.microsoft.com/v1.0/me/messages/opaque%2Bid%3D%3D/reply')
  assert.deepEqual(result.body, { message: { body: { contentType: 'Text', content: 'Approved body' }, toRecipients: [{ emailAddress: { address: 'reply@example.com' } }] } })
})

test('Gmail MIME and Graph threaded replies carry validated exact bytes and safe UTF-8 file names', () => {
  const bytes = Buffer.from('exact file bytes\0with binary data')
  const file = { name: 'Résumé "October".pdf', mimeType: 'application/pdf', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }
  const target = providerReplyTarget('google', original(), 'source123', 'owner@example.com')
  const result = mailProviderSendRequest('google', 'owner@example.com', { to: ['replies@example.com'], subject: 'ignored', text: '', replyTarget: target, attachments: [file] })
  const mime = Buffer.from(result.body.raw as string, 'base64url').toString()
  assert.match(mime, /Content-Type: multipart\/mixed/)
  assert.match(mime, /filename\*0\*=UTF-8''R%C3%A9sum%C3%A9%20%22October%22\.pdf/)
  assert.ok(mime.includes(file.dataBase64))
  assert.equal(result.body.threadId, 'thread123')
  const outlook = mailProviderSendRequest('microsoft', 'owner@example.com', { to: ['replies@example.com'], subject: 'ignored', text: '', replyTarget: target, attachments: [file] })
  assert.deepEqual((outlook.body.message as any).attachments, [{ '@odata.type': '#microsoft.graph.fileAttachment', name: file.name, contentType: file.mimeType, contentBytes: file.dataBase64 }])
  for (const changed of [{ ...file, name: 'bad\r\nBcc: bad' }, { ...file, mimeType: 'text/plain\r\nX: bad' }, { ...file, sha256: 'a'.repeat(64) }, { ...file, dataBase64: file.dataBase64 + '\n' }]) assert.throws(() => mailOutgoingAttachments([changed]))
})

test('Changed, outbound, ambiguous, or injected original metadata cannot authorize replies', () => {
  assert.throws(() => providerReplyTarget('google', original(), 'wrong', 'owner@example.com'))
  assert.throws(() => providerReplyTarget('google', { ...original(), labelIds: ['SENT'] }, 'source123', 'owner@example.com'))
  assert.throws(() => providerReplyTarget('google', original(), 'source123', 'alex@example.com'))
  for (const headers of [
    [...original().payload.headers, { name: 'Reply-To', value: 'attacker@example.com' }],
    original().payload.headers.map(row => row.name === 'Reply-To' ? { ...row, value: 'a@example.com, b@example.com' } : row),
    original().payload.headers.map(row => row.name === 'Message-ID' ? { ...row, value: '<x>\r\nBcc: attacker@example.com' } : row),
  ]) assert.throws(() => providerReplyTarget('google', { ...original(), payload: { headers } }, 'source123', 'owner@example.com'))
})

test('Real encrypted outbox binds reply origin to idempotency and rechecks source before dispatch', async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'mail-reply-threading-')))
  const key = { key: randomBytes(32) }, service = new MailOAuthService({ dataDir, key, publicUrl: 'http://127.0.0.1:32123' })
  const owner: MailIdentity = { teamId: 'team', memberId: 'member', projectId: 'project', deviceId: 'device' }
  const connectionId = randomUUID(), scope = JSON.stringify(owner)
  const conn = { id: connectionId, identity: owner, provider: 'google', email: 'owner@example.com', enabled: true, readInbox: true, mailboxAccess: true, accountId: 'provider-account', registration: 'app', token: { accessToken: 'fixture-not-a-real-token', refreshToken: '', expiresAt: Date.now() + 1e6 } }
  const internal = service as any
  let providerOriginal = original(), submissions = 0
  try {
    await service.ready()
    internal.identityAuthorized = () => true
    await internal.store.batch([
      { collection: 'connections', id: connectionId, owner: scope, value: conn },
      { collection: 'access', id: createHash('sha256').update(`${scope}\n${connectionId}`).digest('hex'), owner: scope, account: connectionId, value: { connectionId, identity: owner, send: true, read: true, manage: true } },
    ])
    // Deterministic provider fixtures exercise production metadata verification;
    // this test has no network traffic or actual mailbox credentials.
    internal.mailboxContext = async () => ({ c: conn, check: async () => undefined, call: async () => providerOriginal })
    internal.token = async () => conn.token
    internal.request = async (_url: string, init: RequestInit) => { if (init.method === 'POST') submissions += 1; return { ok: true, status: 200, body: { id: 'fixture-receipt' } } }
    const args = { to: ['replies@example.com'], subject: 'Re: Meeting tomorrow', text: 'Yes', idempotencyKey: `m_${Date.now()}_${randomUUID()}`, replyToMessageId: 'source123' }
    const queued = await service.send(owner, connectionId, args, () => true)
    assert.equal(queued.status, 'queued')
    assert.equal((await service.send(owner, connectionId, args, () => true)).jobId, queued.jobId)
    await assert.rejects(service.send(owner, connectionId, { ...args, replyToMessageId: 'different-source' }, () => true), /different message content/)
    const status = await service.job(owner, queued.jobId!, () => true)
    assert.equal(status.connectionId, connectionId)
    assert.equal(status.status, 'queued')
    await assert.rejects(service.job({ ...owner, deviceId: 'another-device' }, queued.jobId!, () => true), /not found/)
    await assert.rejects(service.job(owner, queued.jobId!, () => false), /authorization expired/)
    providerOriginal = { ...original(), payload: { headers: original().payload.headers.map(row => row.name === 'Reply-To' ? { ...row, value: 'changed@example.com' } : row) } }
    const stored = await internal.store.get('outbox', queued.jobId!)
    await internal.dispatch(stored.id, stored.revision, stored.value)
    assert.equal((await service.job(owner, queued.jobId!, () => true)).status, 'rejected')
    assert.equal(submissions, 0)
    providerOriginal = original()
    const attachmentBytes = Buffer.alloc(2 * 1024 * 1024, 0x31)
    const attachment = { name: 'large.pdf', mimeType: 'application/pdf', size: attachmentBytes.length, sha256: createHash('sha256').update(attachmentBytes).digest('hex'), dataBase64: attachmentBytes.toString('base64') }
    const mediaArgs = { ...args, text: '', attachments: [attachment], replyRecordId: randomUUID(), idempotencyKey: `m_${Date.now()}_${randomUUID()}` }
    const fresh = await service.send(owner, connectionId, mediaArgs, () => true)
    assert.equal((await service.send(owner, connectionId, mediaArgs, () => true)).jobId, fresh.jobId)
    await assert.rejects(service.send(owner, connectionId, { ...mediaArgs, replyRecordId: randomUUID() }, () => true), /different message content/)
    const identicalSecond = await service.send(owner, connectionId, { ...mediaArgs, replyRecordId: randomUUID(), idempotencyKey: `m_${Date.now()}_${randomUUID()}` }, () => true)
    assert.notEqual(identicalSecond.jobId, fresh.jobId)
    assert.equal((await service.outbox(owner, () => true)).jobs.length, 3, 'large private file bytes never enter the metadata page')
    const next = await internal.store.get('outbox', fresh.jobId!)
    assert.equal(next.value.attachments[0].dataBase64, attachment.dataBase64)
    await internal.dispatch(next.id, next.revision, next.value)
    assert.equal((await service.job(owner, fresh.jobId!, () => true)).status, 'accepted')
    assert.equal(submissions, 1)
    const uncertain = await internal.store.get('outbox', identicalSecond.jobId!)
    internal.request = async () => { submissions++; throw new Error('Lost provider response after submission') }
    await internal.dispatch(uncertain.id, uncertain.revision, uncertain.value)
    assert.equal((await service.job(owner, identicalSecond.jobId!, () => true)).status, 'unknown')
    const uncertainPayload = (await internal.store.get('outbox', identicalSecond.jobId!)).value
    const checked = await service.send(owner, connectionId, { ...mediaArgs, replyRecordId: uncertainPayload.replyRecordId, idempotencyKey: uncertainPayload.idempotencyKey }, () => true)
    assert.equal(checked.status, 'unknown')
    assert.equal(submissions, 2, 'retrying a lost attachment result reads the durable receipt, never resends')
  } finally { await service.close(); rmSync(dataDir, { recursive: true, force: true }) }
})
