/** Real filesystem/SQLite failure-boundary checks; no provider simulation. */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MailStore } from '../src/mail-store.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-store-failures-')))
const key = { key: randomBytes(32) }
let store: MailStore | undefined
let lock: DatabaseSync | undefined
let release: ReturnType<typeof setTimeout> | undefined
try {
  const linkDirectory = join(directory, 'dangling-link')
  const mailDirectory = join(linkDirectory, 'mail-oauth')
  mkdirSync(mailDirectory, { recursive: true, mode: 0o700 })
  const outsideTarget = join(directory, 'must-not-be-created.sqlite3')
  symlinkSync(outsideTarget, join(mailDirectory, 'mail-store.sqlite3'))
  store = new MailStore({ dataDir: linkDirectory, key })
  await assert.rejects(store.ready(), /storage is unavailable/, 'dangling database symlinks must be rejected before SQLite opens them')
  assert.equal(existsSync(outsideTarget), false, 'SQLite must not create files through a dangling symlink')
  await store.close()

  const queueDirectory = join(directory, 'queue')
  mkdirSync(queueDirectory, { mode: 0o700 })
  store = new MailStore({ dataDir: queueDirectory, key })
  await store.ready()
  lock = new DatabaseSync(join(queueDirectory, 'mail-oauth', 'mail-store.sqlite3'))
  lock.exec('BEGIN IMMEDIATE')
  const queued = Array.from({ length: 1023 }, (_, index) => store!.batch([
    { collection: 'shutdown', id: `write-${index}`, value: index },
  ]).then(value => ({ value }), error => ({ error: error.code as string })))
  const overflow = store.batch([{ collection: 'shutdown', id: 'overflow', value: true }]).then(value => ({ value }), error => ({ error: error.code as string }))
  const closing = store.close()
  release = setTimeout(() => { lock!.exec('COMMIT'); lock!.close(); lock = undefined }, 25)
  assert.deepEqual(await overflow, { error: 'queue_full' })
  await closing
  assert.equal((await Promise.all(queued)).every(result => 'value' in result && result.value === true), true, 'shutdown drains every accepted write even when the data queue is full')
  store = new MailStore({ dataDir: queueDirectory, key })
  await store.ready()
  assert.equal(await store.count('shutdown'), 1023, 'all acknowledged shutdown writes survive reopen')
  const diagnosticBody = randomBytes(45_000).toString('base64')
  for (let offset = 0; offset < 100; offset += 25) {
    await store.batch(Array.from({ length: 25 }, (_, index) => {
      const id = `metadata-${String(offset + index).padStart(3, '0')}`
      return { collection: 'outbox', id, status: 'pending', value: {
        jobId: id, subject: `Storage diagnostic ${offset + index}`, createdAt: offset + index,
        text: diagnosticBody, digest: randomBytes(32).toString('hex'), actor: { diagnostic: true }, privateFutureField: diagnosticBody,
      } }
    }))
  }
  await assert.rejects(store.list('outbox', { limit: 100 }), /storage limit reached/, 'full-body list remains strictly bounded')
  const projected = await store.list<Record<string, unknown>>('outbox', { limit: 100, metadataOnly: true })
  assert.equal(projected.length, 100, '100 actual large encrypted records can be paged as bounded metadata')
  for (const row of projected) assert.deepEqual(Object.keys(row.value).sort(), ['createdAt', 'jobId', 'subject'])
  const projectedNext = await store.list('outbox', { limit: 100, metadataOnly: true, after: projected[49]!.id })
  assert.equal(projectedNext.length, 50, 'metadata projection preserves keyset pagination')
  await assert.rejects(store.list('shutdown', { limit: 100, metadataOnly: true }), /Invalid encrypted/, 'projection cannot be used to export other encrypted collections')
  await assert.rejects(store.batch(projected.map(row => ({ collection: 'outbox', id: row.id, delete: true }))), /storage limit reached/, 'secure deletion budgets existing encrypted bytes, not just the tiny delete request')
  assert.equal(await store.count('outbox'), 100, 'oversized delete rolls back without removing any row')
  await store.batch(projected.slice(0, 25).map(row => ({ collection: 'outbox', id: row.id, delete: true })))
  assert.equal(await store.count('outbox'), 75, 'bounded secure-delete chunk succeeds')
  // Reuse these actual large storage diagnostics as terminal expiry records.
  for (const row of projected.slice(25)) {
    await store.batch([{ collection: 'outbox', id: row.id, status: 'accepted', due: 1,
      value: { jobId: row.id, text: diagnosticBody, privateFutureField: diagnosticBody } }])
  }
  const firstPurge = await store.purge('outbox', { dueBefore: 1, limit: 500 })
  assert.ok(firstPurge > 0 && firstPurge < 75, 'one purge bounds old encrypted payload bytes even when its row limit is large')
  let purged = firstPurge
  while (await store.count('outbox')) purged += await store.purge('outbox', { dueBefore: 1, limit: 500 })
  assert.equal(purged, 75)
  // Generic credential generations exercise actual encrypted merge semantics,
  // not OAuth connections: no provider, identity, address or network is used.
  const credentialId = 'credential-generation-probe'
  const oldToken = { accessToken: randomBytes(24).toString('hex'), refreshToken: randomBytes(24).toString('hex'), expiresAt: 1000 }
  const freshToken = { accessToken: randomBytes(24).toString('hex'), refreshToken: randomBytes(24).toString('hex'), expiresAt: 2000 }
  const expected = { registration: randomBytes(32).toString('hex'), readInbox: false, token: oldToken }
  await store.batch([{ collection: 'connections', id: credentialId, value: { ...expected, enabled: true } }])
  await store.batch([{ collection: 'connections', id: credentialId, value: { ...expected, enabled: false } }])
  const rotated = await store.rotateConnection<Record<string, unknown>>(credentialId, expected, freshToken)
  assert.equal(rotated.kind, 'updated')
  assert.equal(rotated.value.enabled, false, 'atomic credential merge preserves concurrently changed settings')
  assert.deepEqual(rotated.value.token, freshToken)
  const beforeStaleRotation = await store.get('connections', credentialId)
  const stale = await store.rotateConnection<Record<string, unknown>>(credentialId, expected, oldToken)
  assert.equal(stale.kind, 'changed', 'old generation cannot overwrite a newer credential generation')
  assert.deepEqual(stale.value.token, freshToken)
  assert.equal((await store.get('connections', credentialId))?.revision, beforeStaleRotation?.revision, 'stale rotation is a read-only result')
  const nextExpected = { ...expected, token: freshToken }
  const racers = await Promise.all([
    store.rotateConnection(credentialId, nextExpected, { ...oldToken, expiresAt: 3000 }),
    store.rotateConnection(credentialId, nextExpected, { ...oldToken, expiresAt: 4000 }),
  ])
  assert.deepEqual(racers.map(row => row.kind).sort(), ['changed', 'updated'], 'exactly one credential generation wins competing atomic merges')
  await store.batch([{ collection: 'connections', id: credentialId, value: { ...expected, mailboxAccess: true, enabled: true } }])
  const oldConsent = await store.rotateConnection<Record<string, unknown>>(credentialId, expected, freshToken)
  assert.equal(oldConsent.kind, 'changed', 'refresh from summary consent cannot overwrite newly granted mailbox-management consent')
  const upgradedConsent = await store.rotateConnection<Record<string, unknown>>(credentialId, { ...expected, mailboxAccess: true }, freshToken)
  assert.equal(upgradedConsent.kind, 'updated')
  assert.equal(upgradedConsent.value.mailboxAccess, true, 'refresh preserves explicit mailbox-management consent')
  await store.batch([{ collection: 'connections', id: credentialId, value: { ...expected, mailboxAccess: false, enabled: true } }])
  assert.equal((await store.rotateConnection(credentialId, { ...expected, mailboxAccess: true }, freshToken)).kind, 'changed', 'refresh cannot undo a consent downgrade')
  await store.batch([{ collection: 'connections', id: credentialId, delete: true }])
  assert.deepEqual(await store.rotateConnection(credentialId, nextExpected, oldToken), { kind: 'missing' }, 'rotation cannot resurrect a disconnected record')
  assert.equal(await store.get('connections', credentialId), null)
  await assert.rejects(store.rotateConnection(credentialId, { ...expected, registration: 'invalid' }, freshToken), /Invalid encrypted/)
  await store.close()

  const capacityDirectory = join(directory, 'capacity')
  mkdirSync(capacityDirectory, { mode: 0o700 })
  const maxBytes = 64 * 1024 * 1024
  store = new MailStore({ dataDir: capacityDirectory, key, maxBytes })
  await store.ready()
  const capacityPayload = randomBytes(180_000).toString('base64')
  let accepted = 0
  let full = false
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await store.batch(Array.from({ length: 10 }, (_, index) => ({ collection: 'capacity', id: `row-${accepted + index}`, value: capacityPayload })))
      accepted += 10
    } catch (error) {
      assert.equal((error as { code: string }).code, 'capacity', 'real SQLITE_FULL is reported as a sanitized capacity error')
      full = true
      assert.equal(await store.count('capacity'), accepted, 'actual SQLite page exhaustion rolls back the entire multi-row batch')
      break
    }
  }
  assert.equal(full, true, 'real SQLite reaches the configured 64-MiB envelope')
  await store.batch(Array.from({ length: 10 }, (_, index) => ({ collection: 'capacity', id: `row-${index}`, delete: true })))
  assert.equal(await store.batch([{ collection: 'capacity', id: 'after-reclamation', value: capacityPayload }]), true, 'bounded deletion frees reusable pages after real capacity exhaustion')
  const physical = readdirSync(join(capacityDirectory, 'mail-oauth')).reduce((bytes, name) => bytes + statSync(join(capacityDirectory, 'mail-oauth', name)).size, 0)
  assert.ok(physical <= maxBytes, 'committed SQLite/WAL files fit the configured disk budget')
  await store.close()
  store = new MailStore({ dataDir: capacityDirectory, key, maxBytes })
  await store.ready()
  assert.equal(await store.count('capacity'), accepted - 9, 'capacity recovery remains durable after reopen')
  console.log('PASS: real symlink rejection, full-queue drain, bounded large-body metadata/deletion/expiry, atomic credential merge, SQLITE_FULL rollback and reclamation/reopen')
} finally {
  if (release) clearTimeout(release)
  if (lock) { try { lock.exec('ROLLBACK') } catch {} lock.close() }
  await store?.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
}
