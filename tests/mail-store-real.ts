/** Real Node SQLite + real worker/disk/crypto verification. No mail provider or OAuth is simulated. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MailStore } from '../src/mail-store.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-store-real-')))
const emptyDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-store-empty-')))
const key = { key: randomBytes(32) }
const owner = randomUUID()
const account = randomUUID()
const secret = `storage-integrity-probe-${randomUUID()}`
const opened: MailStore[] = []
async function create(dataDir = directory, encryptionKey = key) {
  const store = new MailStore({ dataDir, key: encryptionKey })
  opened.push(store)
  await store.ready()
  return store
}

try {
  const store = await create()
  const second = await create()
  const lock = new DatabaseSync(join(directory, 'mail-oauth', 'mail-store.sqlite3'))
  lock.exec('BEGIN IMMEDIATE')
  let eventLoopRan = false
  const waiting = store.batch([{ collection: 'verification', id: 'event-loop', value: { storageProbe: true } }])
  setTimeout(() => { eventLoopRan = true; lock.exec('COMMIT'); lock.close() }, 25)
  assert.equal(await waiting, true)
  assert.equal(eventLoopRan, true, 'SQLite busy wait is off the parent event loop')
  assert.equal(await store.batch([{ collection: 'verification', id: 'one', owner, account, value: { secret } }], {
    checks: [{ collection: 'verification', id: 'one', revision: null }], limits: [{ collection: 'verification', owner, max: 1 }],
  }), true)
  assert.equal((await store.get<{ secret: string }>('verification', 'one'))?.value.secret, secret)
  assert.equal(await store.batch([{ collection: 'verification', id: 'two', owner, value: 'must-not-commit' }], {
    limits: [{ collection: 'verification', owner, max: 1 }],
  }), false)
  assert.equal(await store.get('verification', 'two'), null)
  assert.equal(await store.count('verification', { owner, account }), 1)
  assert.equal(await store.count('verification', { owner: randomUUID() }), 0)
  assert.equal(await store.batch([{ collection: 'verification', id: 'one', owner, account, value: 'wrong-revision' }], {
    checks: [{ collection: 'verification', id: 'one', revision: 99 }],
  }), false)
  const contend = () => ({ writes: [{ collection: 'verification', id: 'race', owner, value: randomUUID() }],
    options: { checks: [{ collection: 'verification', id: 'race', revision: null }] } })
  const a = contend(); const b = contend()
  const winners = await Promise.all([store.batch(a.writes, a.options), second.batch(b.writes, b.options)])
  assert.equal(winners.filter(Boolean).length, 1, 'BEGIN IMMEDIATE CAS permits exactly one real worker winner')
  const otherAccount = randomUUID()
  const otherOwner = randomUUID()
  const accountQuota = { limits: [{ collection: 'quota-verification', account, max: 2 }] }
  assert.equal(await store.batch([
    { collection: 'quota-verification', id: 'first', account, owner, value: 1 },
    { collection: 'quota-verification', id: 'other-account', account: otherAccount, owner, value: 2 },
  ], accountQuota), true)
  const accountRacers = await Promise.all([
    store.batch([{ collection: 'quota-verification', id: 'contender-a', account, owner, value: 3 }], accountQuota),
    second.batch([{ collection: 'quota-verification', id: 'contender-b', account, owner: otherOwner, value: 4 }], accountQuota),
  ])
  assert.equal(accountRacers.filter(Boolean).length, 1, 'different owners contend atomically for the same account quota')
  assert.equal(await store.count('quota-verification', { account }), 2)
  assert.equal(await store.count('quota-verification', { account: otherAccount }), 1)
  assert.equal(await store.batch([{ collection: 'quota-verification', id: 'other-account', account, owner, value: 5 }], accountQuota), false, 'moving a row into a full account is denied')
  assert.equal(await store.count('quota-verification', { account: otherAccount }), 1, 'denied account move is atomic')
  assert.equal(await store.batch([
    { collection: 'quota-verification', id: 'first', delete: true },
    { collection: 'quota-verification', id: 'replacement', account, owner, value: 6 },
  ], accountQuota), true, 'same-transaction delete frees an account quota slot')
  assert.equal(await store.batch([{ collection: 'quota-verification', id: 'owner-specific', account: otherAccount, owner: otherOwner, value: 7 }], {
    limits: [{ collection: 'quota-verification', owner: otherOwner, account: otherAccount, max: 1 }],
  }), true, 'combined quota filters owner AND account')
  assert.equal(await store.batch([{ collection: 'quota-verification', id: 'owner-specific-extra', account: otherAccount, owner: otherOwner, value: 8 }], {
    limits: [{ collection: 'quota-verification', owner: otherOwner, account: otherAccount, max: 1 }],
  }), false)
  const capacityAccount = randomUUID()
  const capacityQuota = { limits: [{ collection: 'quota-verification', account: capacityAccount, max: 2000 }] }
  for (let offset = 0; offset < 2000; offset += 500) {
    assert.equal(await store.batch(Array.from({ length: 500 }, (_, index) => ({
      collection: 'quota-verification', id: `capacity-${offset + index}`, account: capacityAccount, owner,
      value: { storageOrdinal: offset + index },
    })), capacityQuota), true)
  }
  assert.equal(await store.count('quota-verification', { account: capacityAccount }), 2000)
  assert.equal(await store.batch([{ collection: 'quota-verification', id: 'capacity-overflow', account: capacityAccount, owner: otherOwner, value: 2000 }], capacityQuota), false, 'actual 2000-record account boundary rejects record 2001')
  assert.equal(await store.batch([{ collection: 'verification', id: 'one', owner, account, value: { secret } }]), true)
  assert.equal((await store.get('verification', 'one'))?.revision, 2)
  await store.batch([{ collection: 'verification', id: 'one', delete: true }])
  assert.equal(await store.get('verification', 'one'), null)
  await store.batch([{ collection: 'verification', id: 'one', owner, account, value: { secret } }], { checks: [{ collection: 'verification', id: 'one', revision: null }] })
  assert.equal((await store.get('verification', 'one'))?.revision, 4, 'delete/recreate retains monotonic revision')
  const page = await store.list('verification', { owner, limit: 1 })
  const next = await store.list('verification', { owner, limit: 1, after: page[0]!.id })
  assert.equal(page[0]?.id, 'one')
  assert.equal(next[0]?.id, 'race')

  await store.batch([
    { collection: 'outbox', id: 'z', owner, status: 'queued', due: 1, value: { ordinal: 1 } },
    { collection: 'outbox', id: 'a', owner, status: 'queued', due: 2, value: { ordinal: 2 } },
    { collection: 'outbox', id: 'terminal', owner, status: 'accepted', due: 0, value: { ordinal: 0 } },
  ])
  const due = await store.list('outbox', { owner, status: 'queued', dueBefore: 2, limit: 1 })
  const dueNext = await store.list('outbox', { owner, status: 'queued', dueBefore: 2, limit: 1, after: due[0]!.id })
  assert.equal(due[0]?.id, 'z')
  assert.equal(dueNext[0]?.id, 'a')
  await assert.rejects(store.purge('outbox', { status: 'queued', dueBefore: 5, limit: 10 }))
  await assert.rejects(store.purge('verification', { dueBefore: 5, limit: 10 }))
  assert.equal(await store.purge('outbox', { dueBefore: 5, limit: 10 }), 1)
  assert.equal(await store.count('outbox'), 2)
  await assert.rejects(store.batch([{ collection: 'verification', id: 'oversized', value: randomBytes(256 * 1024).toString('hex') }]))

  // Read actual SQLite/WAL bytes; neither payload nor routing identity is plaintext.
  const mailDirectory = join(directory, 'mail-oauth')
  assert.equal(statSync(mailDirectory).mode & 0o777, 0o700)
  for (const name of readdirSync(mailDirectory)) {
    const bytes = readFileSync(join(mailDirectory, name))
    assert.equal(bytes.includes(Buffer.from(secret)), false)
    assert.equal(bytes.includes(Buffer.from(owner)), false)
    assert.equal(bytes.includes(Buffer.from(account)), false)
    assert.equal(statSync(join(mailDirectory, name)).mode & 0o077, 0)
  }
  await second.close()
  await store.close()
  const crashProof = randomUUID()
  const compiledModule = new URL('../src/mail-store.js', import.meta.url)
  const crashModule = existsSync(compiledModule) ? compiledModule : new URL('../src/mail-store.ts', import.meta.url)
  const loaderArgs = crashModule.pathname.endsWith('.ts') ? ['--import', 'tsx'] : []
  const crash = spawnSync(process.execPath, [...loaderArgs, '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { MailStore } from ${JSON.stringify(crashModule.href)};
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const storage = new MailStore({ dataDir: input.directory, key: { key: Buffer.from(input.key, 'hex') } });
    await storage.ready();
    if (!await storage.batch([{ collection: 'verification', id: 'crash-ack', value: { proof: input.proof } }])) process.exit(2);
    process.exit(0);
  `], { input: JSON.stringify({ directory, key: key.key.toString('hex'), proof: crashProof }), encoding: 'utf8', timeout: 30_000 })
  assert.equal(crash.status, 0, 'real subprocess exits abruptly after durable write acknowledgement')
  const reopened = await create()
  assert.equal((await reopened.get<{ secret: string }>('verification', 'one'))?.value.secret, secret, 'encrypted data survives real SQLite close/reopen')
  assert.equal((await reopened.get<{ proof: string }>('verification', 'crash-ack'))?.value.proof, crashProof, 'WAL commit survives subprocess exit without orderly close')
  await reopened.close()
  const wrong = new MailStore({ dataDir: directory, key: { key: randomBytes(32) } })
  opened.push(wrong)
  await assert.rejects(wrong.ready(), /key|integrity/)
  const empty = await create(emptyDirectory)
  await empty.close()
  const wrongEmpty = new MailStore({ dataDir: emptyDirectory, key: { key: randomBytes(32) } })
  opened.push(wrongEmpty)
  await assert.rejects(wrongEmpty.ready(), /key|integrity/, 'empty encrypted stores retain key verification sentinel')

  // Tamper only with this generated verification database's routing column.
  const raw = new DatabaseSync(join(mailDirectory, 'mail-store.sqlite3'))
  raw.prepare("UPDATE mail_records SET owner=? WHERE collection='verification' AND id='one'").run('f'.repeat(64))
  raw.close()
  const integrity = await create()
  await assert.rejects(integrity.get('verification', 'one'), /key|integrity/, 'GCM AAD authenticates routing metadata')
  console.log('PASS: real SQLite workers, event-loop isolation, atomic CAS/quotas, indexed pagination, encrypted durability/crash reopen, wrong-key sentinel, metadata integrity, bounded terminal expiry')
} finally {
  await Promise.all(opened.map(store => store.close().catch(() => undefined)))
  rmSync(directory, { recursive: true, force: true })
  rmSync(emptyDirectory, { recursive: true, force: true })
}
