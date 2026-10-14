/** Actual indexed SQLite query-plan verification, not provider/account simulation. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MailStore, type MailStoreWrite } from '../src/mail-store.js'

const directory = realpathSync(mkdtempSync(join(tmpdir(), 'mail-store-query-')))
const store = new MailStore({ dataDir: directory, key: { key: randomBytes(32) } })
let inspection: DatabaseSync | undefined
try {
  await store.ready()
  const accounts = Array.from({ length: 2000 }, () => randomUUID())
  let writes: MailStoreWrite[] = []
  for (let index = 0; index < accounts.length; index++) {
    for (const [suffix, status, due] of [['early', 'pending', 1], ['later', 'pending', 2], ['history', 'accepted', 0]] as const) {
      writes.push({ collection: 'outbox', id: `diagnostic-${index}-${suffix}`, account: accounts[index], status, due, value: { storageOrdinal: index } })
    }
    if (writes.length >= 498) { await store.batch(writes); writes = [] }
  }
  if (writes.length) await store.batch(writes)
  const results = await store.list('outbox', { account: accounts[1000], status: 'pending', dueBefore: 10, limit: 10 })
  assert.deepEqual(results.map(row => row.id), ['diagnostic-1000-early', 'diagnostic-1000-later'])
  assert.equal(await store.count('outbox'), 6000)
  await store.close()
  // Never run the plan inspection beside the production worker connection.
  inspection = new DatabaseSync(join(directory, 'mail-oauth', 'mail-store.sqlite3'), { readOnly: true })
  const hashedAccount = inspection.prepare("SELECT account FROM mail_records WHERE collection='outbox' AND id='diagnostic-1000-early'").get()!.account as string
  const plan = inspection.prepare(`EXPLAIN QUERY PLAN SELECT * FROM mail_records
    WHERE collection=? AND deleted=0 AND account=? AND status=? AND due IS NOT NULL AND due<=?
    ORDER BY due,id LIMIT ?`).all('outbox', hashedAccount, 'pending', 10, 10)
  const details = plan.map(row => String(row.detail))
  assert.ok(details.some(detail => detail.includes('USING INDEX mail_account_status_due')), 'account queue lookup selects its matching composite index')
  assert.ok(details.every(detail => !/\bSCAN\b|TEMP B-TREE/i.test(detail)), 'account queue requires neither full scans nor a temporary sort')
  console.log(`PASS: real 6000-row / 2000-account queue query: ${details.join('; ')}`)
} finally {
  inspection?.close()
  await store.close().catch(() => undefined)
  rmSync(directory, { recursive: true, force: true })
}
