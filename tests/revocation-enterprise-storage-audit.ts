/** Bounded audit of retention and authority-index growth; disposable local data. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { performance } from 'node:perf_hooks'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import { ContentAccessIndex } from '../src/content-access.js'
import type { ModulesSyncOp } from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'revocation-storage-audit-'))
let counter = 0
const op = (kind: string, targetId: string, extra: Partial<ModulesSyncOp> = {}): ModulesSyncOp => ({
  opId: `storage-${++counter}`, kind, targetKind: kind.split('.')[0], targetId,
  originMemberId: 'admin', originRole: 'admin', originDevice: 'admin-device',
  hlc: `${Date.now() - 400 * 86_400_000}:0:audit`, protocolVersion: 2, hopCount: 0, ...extra,
})
try {
  const retention = join(root, 'retention')
  mkdirSync(retention)
  const stale = Date.now() - 400 * 86_400_000
  writeFileSync(join(retention, 'members.json'), JSON.stringify(['admin', 'removed'].map(memberId => ({
    memberId, email: `${memberId}@example.test`, displayName: memberId, role: memberId === 'admin' ? 'admin' : 'member',
    createdAt: stale, sessions: { [`${memberId}-device`]: hashSessionToken(`${memberId}-token`) },
    sessionLastSeen: { [`${memberId}-device`]: stale },
  }))))
  const store = new BridgeStore(retention, 21, null, null)
  const create = op('module.create', 'private', { visibleToMemberIds: ['removed'] })
  const revoke = op('module.share_revoked', 'private', { visibleToMemberIds: ['removed'], patch: { authoritativeDelete: true } })
  store.appendOps([create, revoke])
  assert.equal(store.contentAccess.mayRead(revoke, 'removed', 'member'), true)
  const before: ModulesSyncOp[] = []
  for await (const row of store.scanOpsFromStart()) before.push(row)
  assert.equal(before.some(row => row.opId === revoke.opId), true)
  const pruned = await store.pruneOps()
  const restarted = new BridgeStore(retention, 21, null, null)
  const after: ModulesSyncOp[] = []
  for await (const row of restarted.scanOpsFromStart()) after.push(row)
  const retentionReport = { offlineDays: 400, retentionDays: 21, operationsPruned: pruned,
    networkAccessStillDenied: !restarted.contentAccess.mayRead(create, 'removed', 'member'),
    cleanupNoticeAvailableAfterRestart: after.some(row => row.opId === revoke.opId),
    catchupRowsAvailable: after.length }
  console.log(JSON.stringify({ retention: retentionReport }, null, 2))

  // Maximum legal identifier lengths, 250k targets, one item. No unbounded soak.
  // Exercises the actual index and its full-checkpoint durability path directly;
  // it does not claim that 250k is the threshold for shorter production IDs.
  const scaleDir = join(root, 'index-scale')
  const index = new ContentAccessIndex(scaleDir, null)
  const moduleId = 'module-'.padEnd(128, 'm')
  index.observe(op('module.create', moduleId, { visibleToMemberIds: ['removed'] }))
  const measurements: { targets: number; lastCheckpointBytes: number; flushMs: number; error: string | null }[] = []
  for (let count = 1; count <= 250_000; count++) {
    const recordId = `record-${count}-`.padEnd(128, 'r')
    index.observe(op('record.create', recordId, { moduleId, patch: { id: recordId } }))
    if (count % 50_000 === 0) {
      let error: string | null = null
      const started = performance.now()
      try { index.flush() } catch (caught) { error = caught instanceof Error ? caught.message : String(caught) }
      measurements.push({ targets: count, lastCheckpointBytes: statSync(join(scaleDir, 'content-access.sqlite')).size,
        flushMs: Math.round(performance.now() - started), error })
      if (error) break
    }
  }
  const scaleReport = { identifierLength: 128, measurements, healthyAfterGrowth: index.healthy(),
    administratorReadAvailable: index.mayReadRecord('record-1-'.padEnd(128, 'r'), 'admin', 'admin') }
  console.log(JSON.stringify({ authorityIndex: scaleReport }, null, 2))
  assert.equal(retentionReport.cleanupNoticeAvailableAfterRestart, true)
  assert.equal(retentionReport.networkAccessStillDenied, true)
  assert.equal(index.healthy(), true)
  assert.ok(measurements.every(row => row.error === null))
  const reopened = new ContentAccessIndex(scaleDir, null)
  assert.equal(reopened.healthy(), true)
  assert.equal(reopened.mayReadRecord('record-250000-'.padEnd(128, 'r'), 'removed', 'member'), true)
  console.log('Enterprise storage regression: retained cleanup, incremental 250k-target persistence and reopen passed')
} finally { rmSync(root, { recursive: true, force: true }) }
