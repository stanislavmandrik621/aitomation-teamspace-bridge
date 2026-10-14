/** Large persisted teamwork history, using the production encrypted SQLite store.
 * Separate reader processes measure cold recovery without retaining fixture data.
 * Run: node --import tsx tests/record-teamwork-scale.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { ContentAccessStorage, type AuthorityEntry } from '../src/content-access-storage.js'
import { RecordTeamworkStore } from '../src/record-teamwork-store.js'
import { emptyRecordTeamwork, applyRecordTeamworkCommand } from '../src/record-teamwork-state.js'
import type { ModulesSyncOp } from '../src/index.js'

const count = 100_000
const auditMetadata = process.env.TEAMWORK_SCALE_AUDIT_METADATA === '1'
const note = (revision: number) => `Result ${revision}: ${'Synthetic evidence '.repeat(25)}`.trim()
const actor = { id: 'member', name: 'Member', kind: 'member' as const }
const config = { reviewRequired: false, reviewerMemberIds: [], completedStatusValues: [] }
const reportPath = process.env.TEAMWORK_SCALE_REPORT
if (process.argv[2] === '--reader') {
  const root = process.argv[3]
  const key = { key: readFileSync(join(root, 'fixture.key')) }
  const before = performance.now()
  const store = new RecordTeamworkStore(root, key)
  const startupMs = performance.now() - before
  assert(store.healthy())
  const history = store.history('busy-record', 100, 0)
  assert.equal(history.historyTotal, count)
  if (auditMetadata) {
    const change = history.history[0].changes?.find(c => c.field === 'result')
    assert.equal(change?.before?.note, note(count - 1))
    assert.equal(change?.after?.note, note(count))
  }
  assert.deepEqual(history.history.map(e => e.revision), Array.from({ length: 100 }, (_, i) => count - i))
  assert.equal(store.history('busy-record', 100, count - 1).history[0].revision, 1)
  assert.equal(store.history('busy-record', 100, count).history.length, 0)
  const pagingStart = performance.now()
  const ids = new Set<string>()
  for (let offset = 0; offset < count; offset += 100) {
    const page = store.history('busy-record', 100, offset)
    assert.equal(page.historyTotal, count)
    for (const event of page.history) { assert(!ids.has(event.id)); ids.add(event.id) }
  }
  assert.equal(ids.size, count)
  const pagingMs = performance.now() - pagingStart
  const state = store.read('busy-record')
  const op = { kind: 'record.teamwork', targetId: 'busy-record', opId: 'after-reopen',
    originMemberId: 'member', originDevice: 'device', patch: { expectedRevision: count, command: { action: 'submit_result', note: 'After reopen' } },
    teamwork: { state: { ...state, revision: count + 1 }, event: { id: 'after-reopen', revision: count + 1, action: 'submit_result', at: '2026-09-13T00:00:00Z', actor: { id: 'member', name: 'Member', kind: 'member' }, note: 'After reopen' } } } as ModulesSyncOp
  store.observe(op); store.observe(op); store.flush()
  assert.equal(store.history('busy-record').historyTotal, count + 1, 'replay cannot duplicate history')
  assert.equal(store.history('busy-record').history[0].id, 'after-reopen')
  assert(store.isExactCommand(op), 'durable retry identity is preserved')
  const measurements = { startupMs, pagingMs, rssMiB: process.memoryUsage().rss / 1024 ** 2, historyEvents: count, pages: count / 100, encrypted: true, auditMetadata }
  console.log(JSON.stringify(measurements))
  // Conservative local qualification budgets, not a production service SLA.
  assert(startupMs < 10_000, `Cold history recovery took ${startupMs.toFixed(0)} ms`)
  assert(pagingMs < 5_000, `History pagination took ${pagingMs.toFixed(0)} ms`)
  assert(measurements.rssMiB < 768, 'Fixture must stay within a 768 MiB process budget')
} else {
  const root = mkdtempSync(join(tmpdir(), 'teamwork-history-scale-'))
  const key = { key: randomBytes(32) }
  writeFileSync(join(root, 'fixture.key'), key.key, { mode: 0o600 })
  new RecordTeamworkStore(root, key)
  const storage = new ContentAccessStorage(join(root, 'record-teamwork'), key, true)
  for (let start = 0; start < count; start += 500) {
    const entries: AuthorityEntry[] = []
    for (let i = start; i < Math.min(count, start + 500); i++) {
      const revision = i + 1
      const identity = { id: `event-${revision}`, at: '2026-09-13T00:00:00Z' }
      const event = auditMetadata ? applyRecordTeamworkCommand({ ...emptyRecordTeamwork(), revision: revision - 1, config, ...(revision > 1 ? { result: { note: note(revision - 1), submittedBy: actor } } : {}) }, revision - 1,
        { action: 'submit_result', note: note(revision) }, { actor, teamId: 'team', canWrite: true, canConfigure: true, validateMember() {}, validateConfig() {}, validateHandoff() {} }, identity).event
        : { ...identity, revision, action: 'submit_result', actor, note: note(revision) }
      entries.push({ kind: 'event', key: identity.id, value: { recordId: 'busy-record', ...event } })
      entries.push({ kind: 'receipt', key: `command-${revision}`, value: `durable-retry-${revision}` })
    }
    storage.write(entries)
  }
  storage.write([{ kind: 'state', key: 'busy-record', value: { ...emptyRecordTeamwork(), revision: count } }])
  const result = spawnSync(process.execPath, ['--import', 'tsx', process.argv[1], '--reader', root], { encoding: 'utf8', timeout: 120_000 })
  const report = { status: result.status === 0 && !result.error ? 'passed' : 'failed', root, events: count, receipts: count, stdout: result.stdout, stderr: result.stderr, error: result.error?.message }
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  assert.equal(result.status, 0, result.error?.message || 'History scale reader failed')
  console.log('PASS encrypted teamwork history: cold restart, 1,000 pages, no missing/duplicate events, and durable exact retries')
}
