import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TeamContentLockStore, teamContentLockBlocks, teamContentLockRevisionRefusal } from '../src/team-content-lock-store.js'
import { KNOWN_OP_KINDS } from '../src/index.js'

for (const kind of [
  'playbook.create',
  'playbook.update',
  'playbook.delete',
  'compose.doc.create',
  'compose.doc.delete',
  'module.share_revoked',
  'playbook.share_revoked',
  'compose.share_revoked',
]) {
  assert.equal(KNOWN_OP_KINDS.has(kind), true, `${kind} must be accepted by the bridge ops log`)
}

const dir = mkdtempSync(join(tmpdir(), 'team-content-lock-'))
try {
  const store = new TeamContentLockStore(dir)
  assert.deepEqual(store.get('team-1'), {
    teamId: 'team-1', locked: false, revision: 0, changedAt: 0, changedByMemberId: '',
  })
  assert.equal(existsSync(join(dir, 'team-content-lock.initialized')), true)

  const nonAdmin = store.set({
    teamId: 'team-1', actorMemberId: 'member-1', actorRole: 'member', locked: true,
    expectedRevision: 0, mutationId: 'm-nonadmin', now: 10,
  })
  assert.equal(nonAdmin.ok, false)
  assert.equal(store.get('team-1').revision, 0)

  const locked = store.set({
    teamId: 'team-1', actorMemberId: 'admin-1', actorName: 'Ada', actorRole: 'admin',
    locked: true, expectedRevision: 0, mutationId: 'm-lock', reason: 'Incident review', now: 11,
  })
  assert.equal(locked.ok, true)
  if (!locked.ok) throw new Error(locked.reason)
  assert.equal(locked.changed, true)
  assert.equal(locked.state.revision, 1)
  assert.equal(locked.state.locked, true)

  // Same mutation is exactly-once even when a retry carries the old CAS value.
  const replay = store.set({
    teamId: 'team-1', actorMemberId: 'admin-1', actorRole: 'admin', locked: true,
    expectedRevision: 0, mutationId: 'm-lock', now: 12,
  })
  assert.equal(replay.ok, true)
  if (!replay.ok) throw new Error(replay.reason)
  assert.equal(replay.idempotent, true)
  assert.equal(replay.state.revision, 1)

  // Two devices racing from revision 1 have one winner and one conflict.
  const first = store.set({
    teamId: 'team-1', actorMemberId: 'admin-1', actorRole: 'admin', locked: false,
    expectedRevision: 1, mutationId: 'm-unlock-a', now: 13,
  })
  const stale = store.set({
    teamId: 'team-1', actorMemberId: 'admin-2', actorRole: 'admin', locked: false,
    expectedRevision: 1, mutationId: 'm-unlock-b', now: 14,
  })
  assert.equal(first.ok, true)
  assert.equal(stale.ok, false)
  if (stale.ok) throw new Error('expected conflict')
  assert.equal(stale.conflict, true)
  assert.equal(stale.state.revision, 2)

  // A delayed retry of the first mutation returns the latest authority, not
  // its historical receipt (which would regress a client's revision to 1).
  const delayedReplay = store.set({
    teamId: 'team-1', actorMemberId: 'admin-1', actorRole: 'admin', locked: true,
    expectedRevision: 0, mutationId: 'm-lock', now: 15,
  })
  assert.equal(delayedReplay.ok, true)
  if (!delayedReplay.ok) throw new Error(delayedReplay.reason)
  assert.equal(delayedReplay.state.revision, 2)
  assert.equal(delayedReplay.state.locked, false)
  assert.equal(teamContentLockRevisionRefusal(delayedReplay.state, undefined), 'missing')
  assert.equal(teamContentLockRevisionRefusal(delayedReplay.state, 1), 'stale')
  assert.equal(teamContentLockRevisionRefusal(delayedReplay.state, 2), null)
  assert.equal(teamContentLockRevisionRefusal({ ...delayedReplay.state, revision: 0 }, undefined), null)

  // State and audit survive a process restart.
  const reloaded = new TeamContentLockStore(dir)
  assert.equal(reloaded.get('team-1').revision, 2)
  assert.equal(reloaded.get('team-1').locked, false)
  assert.deepEqual(reloaded.listAudit('team-1').map((row) => row.action), ['lock', 'unlock'])

  // The lock surface is explicit: reads, recovery data, chat and governance stay usable.
  const on = { ...reloaded.get('team-1'), locked: true }
  for (const scope of ['modules_ops', 'module_yjs', 'public_intake', 'portal_intake', 'backup_restore'] as const) {
    assert.equal(teamContentLockBlocks(on, scope), true, scope)
  }
  for (const scope of ['catchup', 'backup_upload', 'chat', 'roster', 'governance'] as const) {
    assert.equal(teamContentLockBlocks(on, scope), false, scope)
  }

  // Existing torn/corrupt state fails closed and never gets silently replaced.
  writeFileSync(join(dir, 'team-content-lock.json'), '{torn')
  const broken = new TeamContentLockStore(dir).get('team-1')
  assert.equal(broken.locked, true)
  assert.equal(broken.unavailable, true)
  assert.equal(readFileSync(join(dir, 'team-content-lock.json'), 'utf8'), '{torn')

  console.log('team-content-lock-store tests passed')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// A first run may bootstrap revision zero once. Deleting the authority after
// that durable initialization must fail closed instead of silently resetting.
const deletedDir = mkdtempSync(join(tmpdir(), 'team-content-lock-deleted-'))
try {
  const initialized = new TeamContentLockStore(deletedDir)
  assert.equal(initialized.get('team-deleted').locked, false)
  unlinkSync(join(deletedDir, 'team-content-lock.json'))
  const missingAfterInit = new TeamContentLockStore(deletedDir).get('team-deleted')
  assert.equal(missingAfterInit.locked, true)
  assert.equal(missingAfterInit.unavailable, true)
  assert.equal(existsSync(join(deletedDir, 'team-content-lock.json')), false)
} finally {
  rmSync(deletedDir, { recursive: true, force: true })
}

// rename() already committed even if a following directory fsync/open fails.
// Reload authority so callers never observe or retry from stale revision 0.
const postRenameDir = mkdtempSync(join(tmpdir(), 'team-content-lock-post-rename-'))
try {
  let throwAfterRename = true
  const store = new TeamContentLockStore(postRenameDir, null, {
    afterRename: () => {
      if (throwAfterRename) {
        throwAfterRename = false
        throw new Error('simulated directory fsync/open failure')
      }
    },
  })
  const committed = store.set({
    teamId: 'team-power', actorMemberId: 'admin-power', actorRole: 'admin',
    locked: true, expectedRevision: 0, mutationId: 'power-lock', now: 20,
  })
  assert.equal(committed.ok, true)
  if (!committed.ok) throw new Error(committed.reason)
  assert.equal(committed.state.revision, 1)
  assert.equal(committed.state.locked, true)
  assert.equal(store.get('team-power').revision, 1)
  assert.equal(new TeamContentLockStore(postRenameDir).get('team-power').revision, 1)
} finally {
  rmSync(postRenameDir, { recursive: true, force: true })
}

// Restore permits survive a bridge restart, are bound to the exact
// admin/device/revision, exclude lock acquisition, and expire fail-safely.
const permitDir = mkdtempSync(join(tmpdir(), 'team-content-lock-permit-'))
try {
  const store = new TeamContentLockStore(permitDir)
  store.get('team-permit')
  const begun = store.beginRestorePermit({
    teamId: 'team-permit', actorMemberId: 'admin', actorDeviceId: 'device-a',
    actorRole: 'admin', expectedRevision: 0, now: Date.now(),
  })
  assert.equal(begun.ok, true)
  if (!begun.ok) throw new Error(begun.reason)
  const blockedLock = store.set({
    teamId: 'team-permit', actorMemberId: 'admin', actorRole: 'admin', locked: true,
    expectedRevision: 0, mutationId: 'lock-during-restore',
  })
  assert.equal(blockedLock.ok, false)
  const restarted = new TeamContentLockStore(permitDir)
  assert.equal(restarted.validateRestorePermit({
    teamId: 'team-permit', actorMemberId: 'admin', actorDeviceId: 'device-b', token: begun.permit.token,
  }).ok, false)
  const renewed = restarted.validateRestorePermit({
    teamId: 'team-permit', actorMemberId: 'admin', actorDeviceId: 'device-a', token: begun.permit.token,
  })
  assert.equal(renewed.ok, true)
  if (!renewed.ok) throw new Error(renewed.reason)
  assert.ok(renewed.expiresAt > Date.now())
  assert.equal(restarted.finishRestorePermit({
    teamId: 'team-permit', actorMemberId: 'admin', actorDeviceId: 'device-a', token: begun.permit.token,
  }).ok, true)
  assert.equal(restarted.set({
    teamId: 'team-permit', actorMemberId: 'admin', actorRole: 'admin', locked: true,
    expectedRevision: 0, mutationId: 'lock-after-restore',
  }).ok, true)
} finally {
  rmSync(permitDir, { recursive: true, force: true })
}

const expiredPermitDir = mkdtempSync(join(tmpdir(), 'team-content-lock-expired-permit-'))
try {
  const store = new TeamContentLockStore(expiredPermitDir)
  store.get('team-expired')
  const begun = store.beginRestorePermit({
    teamId: 'team-expired', actorMemberId: 'admin', actorDeviceId: 'device',
    actorRole: 'admin', expectedRevision: 0, now: 1,
  })
  assert.equal(begun.ok, true)
  const afterCrashAndExpiry = new TeamContentLockStore(expiredPermitDir)
  assert.equal(afterCrashAndExpiry.set({
    teamId: 'team-expired', actorMemberId: 'admin', actorRole: 'admin', locked: true,
    expectedRevision: 0, mutationId: 'lock-after-expiry',
  }).ok, true)
} finally {
  rmSync(expiredPermitDir, { recursive: true, force: true })
}
