/**
 * P6 - TeamBackupStore: stream upload, quotas, ownership index.
 */
import assert from 'node:assert/strict'
import { createReadStream, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  TeamBackupStore,
  isSafeBackupMemberId,
  isSafeBackupSnapshotId,
  MAX_BACKUP_BYTES,
  parseBackupMetaHeader,
  parseBackupOwnerFields,
} from '../src/backup-store.js'
import { MAX_BACKUP_ZIP_AIMOVES, MAX_BACKUP_ZIP_AIMOVES_HARD_CAP } from '../src/backup-zip.js'

assert.equal(isSafeBackupMemberId('mem_abc-1'), true)
assert.equal(isSafeBackupMemberId('../x'), false)
assert.equal(isSafeBackupSnapshotId('snap_2026-01-01_abcd'), true)
assert.equal(isSafeBackupSnapshotId('bad'), false)

const root = mkdtempSync(join(tmpdir(), 'ts-backup-'))
const store = new TeamBackupStore(root)
store.setMeta({ minIntervalMs: 0, maxKeepPerMember: 2 })

const payload = Buffer.from('fake-aimove-archive-bytes-for-test')
const put1 = await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([payload]),
  contentLength: payload.length,
  label: 'manual',
  includesBrowserSessions: false,
})
assert.equal(put1.ok, true)
if (!put1.ok) throw new Error('put1 failed')
assert.equal(put1.snapshot.bytes, payload.length)
assert.equal(put1.snapshot.sha256.length, 64)
assert.equal(put1.snapshot.memberId, 'mem_a')

const listed = store.listForMember('mem_a')
assert.equal(listed.length, 1)
assert.equal(listed[0]?.id, put1.snapshot.id)

const opened = await store.openSnapshotRead('mem_a', put1.snapshot.id)
assert.ok(opened)
assert.equal(opened!.size, payload.length)

// Wrong Content-Length must fail closed.
const badLen = await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([payload]),
  contentLength: payload.length + 10,
})
assert.equal(badLen.ok, false)

// Oversize declared length refused before write.
const over = await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([Buffer.alloc(4)]),
  contentLength: MAX_BACKUP_BYTES + 1,
})
assert.equal(over.ok, false)

// Keep prune: third upload drops oldest when maxKeep=2.
await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([Buffer.from('two')]),
  contentLength: 3,
  label: 'two',
})
await store.putSnapshotFromStream({
  memberId: 'mem_a',
  stream: Readable.from([Buffer.from('three')]),
  contentLength: 5,
  label: 'three',
})
const afterPrune = store.listForMember('mem_a')
assert.equal(afterPrune.length, 2)
assert.equal(afterPrune.some((r) => r.id === put1.snapshot.id), false)

// Delete
const victim = afterPrune[0]!
assert.equal((await store.deleteSnapshot('mem_a', victim.id)).ok, true)
assert.equal(store.listForMember('mem_a').length, 1)

// File-backed stream (realistic path)
const filePath = join(root, 'sample.aimove')
writeFileSync(filePath, Buffer.from('from-disk-stream'))
const putFile = await store.putSnapshotFromStream({
  memberId: 'mem_b',
  stream: createReadStream(filePath),
  contentLength: Buffer.byteLength('from-disk-stream'),
  label: 'disk',
})
assert.equal(putFile.ok, true)
assert.equal(store.listAll().filter((r) => r.memberId === 'mem_b').length, 1)

// TS-P6-006: wipe entire member folder
const wiped = await store.deleteAllForMember('mem_b')
assert.equal(wiped.ok, true)
if (!wiped.ok) throw new Error('wipe failed')
assert.equal(wiped.deletedCount, 1)
assert.equal(store.listForMember('mem_b').length, 0)
assert.equal(store.listMemberFolderIds().includes('mem_b'), false)
assert.equal((await store.deleteAllForMember('mem_missing')).ok, false)

// TCC-R1133-BKP-001: delete/wipe must serialize against a concurrent upload
// for the SAME member (same lock covers put finalize + delete + wipe), so a
// racing put and delete/wipe for a different upload never interleave their
// index read-modify-write or observe a half-written snapshot file.
const raceMemberId = 'mem_race'
const racePayload = Buffer.from('race-condition-guard-payload')
const firstPut = await store.putSnapshotFromStream({
  memberId: raceMemberId,
  stream: Readable.from([racePayload]),
  contentLength: racePayload.length,
  label: 'first',
})
assert.equal(firstPut.ok, true)
if (!firstPut.ok) throw new Error('firstPut failed')
const [racedPut, racedDelete] = await Promise.all([
  store.putSnapshotFromStream({
    memberId: raceMemberId,
    stream: Readable.from([Buffer.from('second-upload-bytes')]),
    contentLength: Buffer.byteLength('second-upload-bytes'),
    label: 'second',
  }),
  store.deleteSnapshot(raceMemberId, firstPut.snapshot.id),
])
assert.equal(racedPut.ok, true)
assert.equal(racedDelete.ok, true)
// Exactly one snapshot should remain (the racing put's), never both index
// entries corrupted and never zero from a lost-update overwrite.
const afterRace = store.listForMember(raceMemberId)
assert.equal(afterRace.length, 1)
assert.equal(afterRace.some((r) => r.id === firstPut.snapshot.id), false)

// Viewer-path: cleanupPartials is safe
assert.equal(typeof store.cleanupPartials(), 'number')

// TCC-R1133-BKP-002: concurrent near-quota uploads from DIFFERENT members
// must never jointly overshoot `maxBytesTeam`. Each upload alone fits
// (15 <= 20) but 15 + 15 = 30 > 20, so a check-then-act race with only a
// per-member lock would let both pass the pre-upload `teamBytes() + len`
// check against the same stale total. A dedicated global reservation lock
// must serialize the accounting step so exactly one of the two is refused.
const teamRoot = mkdtempSync(join(tmpdir(), 'ts-backup-teamquota-'))
const teamStore = new TeamBackupStore(teamRoot)
teamStore.setMeta({ maxBytesTeam: 20, minIntervalMs: 0 })
const [teamPutX, teamPutY] = await Promise.all([
  teamStore.putSnapshotFromStream({
    memberId: 'mem_x',
    stream: Readable.from([Buffer.alloc(15, 'x')]),
    contentLength: 15,
  }),
  teamStore.putSnapshotFromStream({
    memberId: 'mem_y',
    stream: Readable.from([Buffer.alloc(15, 'y')]),
    contentLength: 15,
  }),
])
const teamOkCount = [teamPutX, teamPutY].filter((r) => r.ok).length
assert.equal(teamOkCount, 1, 'exactly one of two jointly-over-quota uploads must be accepted')
const teamTotalBytes = teamStore.listAll().reduce((n, r) => n + r.bytes, 0)
assert.ok(teamTotalBytes <= 20, `team total ${teamTotalBytes} must never exceed maxBytesTeam=20`)
// The reservation for the refused upload must be released so a LATER
// upload that now fits under the ceiling is not permanently blocked by a
// leaked accounting entry.
const teamRetryFitsRemaining = 20 - teamTotalBytes
if (teamRetryFitsRemaining > 0) {
  const teamRetry = await teamStore.putSnapshotFromStream({
    memberId: 'mem_z',
    stream: Readable.from([Buffer.alloc(teamRetryFitsRemaining, 'z')]),
    contentLength: teamRetryFitsRemaining,
  })
  assert.equal(teamRetry.ok, true, 'a right-sized retry after release must succeed')
}
rmSync(teamRoot, { recursive: true, force: true })

// TCC-R1133-SET-005: maxZipAimoves defaults to MAX_BACKUP_ZIP_AIMOVES (40),
// is admin-raisable via setMeta, and is always clamped to
// MAX_BACKUP_ZIP_AIMOVES_HARD_CAP (500) regardless of what was requested.
const zipMetaRoot = mkdtempSync(join(tmpdir(), 'ts-backup-zipmeta-'))
const zipMetaStore = new TeamBackupStore(zipMetaRoot)
assert.equal(zipMetaStore.getMeta().maxZipAimoves, MAX_BACKUP_ZIP_AIMOVES, 'default maxZipAimoves must match the legacy hardcoded 40')
const raised = zipMetaStore.setMeta({ maxZipAimoves: 200 })
assert.equal(raised.maxZipAimoves, 200, 'admin must be able to raise maxZipAimoves')
const overCap = zipMetaStore.setMeta({ maxZipAimoves: 99_999 })
assert.equal(overCap.maxZipAimoves, MAX_BACKUP_ZIP_AIMOVES_HARD_CAP, 'maxZipAimoves must clamp to the hard cap, never accept an unbounded admin request')
const rejectedNonPositive = zipMetaStore.setMeta({ maxZipAimoves: 0 })
assert.equal(rejectedNonPositive.maxZipAimoves, MAX_BACKUP_ZIP_AIMOVES_HARD_CAP, 'a non-positive patch value must be ignored (keep prior value), not zero out the cap')
// Reopening the store (simulates a bridge restart) must reload the persisted value, not silently reset to default.
const reopened = new TeamBackupStore(zipMetaRoot)
assert.equal(reopened.getMeta().maxZipAimoves, MAX_BACKUP_ZIP_AIMOVES_HARD_CAP, 'maxZipAimoves must persist across a store reopen')
rmSync(zipMetaRoot, { recursive: true, force: true })

// TCC-R1186-BKP-002: persist x-backup-meta owner; header memberId cannot re-key folder.
const ownerRoot = mkdtempSync(join(tmpdir(), 'ts-backup-owner-'))
const ownerStore = new TeamBackupStore(ownerRoot)
ownerStore.setMeta({ minIntervalMs: 0, maxKeepPerMember: 5 })
const ownerPayload = Buffer.from('owner-meta-bytes')
const headerOwner = parseBackupMetaHeader(
  Buffer.from(JSON.stringify({
    memberId: 'spoof_other',
    memberEmail: 'ada@example.com',
    displayName: 'Ada',
    deviceName: 'Ada-Mac',
  }), 'utf8').toString('base64url'),
)
assert.ok(headerOwner, 'header parses')
assert.equal(headerOwner!.memberId, 'spoof_other', 'header may claim any memberId')
const ownerPut = await ownerStore.putSnapshotFromStream({
  memberId: 'mem_real',
  stream: Readable.from([ownerPayload]),
  contentLength: ownerPayload.length,
  label: 'with-owner',
  owner: headerOwner,
})
assert.equal(ownerPut.ok, true, 'put with owner')
if (!ownerPut.ok) throw new Error('owner put failed')
assert.equal(ownerPut.snapshot.memberId, 'mem_real', 'storage folder stays auth memberId')
assert.equal(ownerPut.snapshot.owner?.memberId, 'mem_real', 'persisted owner.memberId overwritten to auth')
assert.equal(ownerPut.snapshot.owner?.memberEmail, 'ada@example.com', 'email persisted')
assert.equal(ownerPut.snapshot.owner?.displayName, 'Ada', 'name persisted')
assert.equal(ownerPut.snapshot.owner?.deviceName, 'Ada-Mac', 'device persisted')
const listedOwner = ownerStore.listForMember('mem_real')
assert.equal(listedOwner[0]?.owner?.memberEmail, 'ada@example.com', 'list round-trips owner')
assert.equal(ownerStore.listForMember('spoof_other').length, 0, 'spoof memberId does not create a folder')
const fields = parseBackupOwnerFields({ memberEmail: 'x@y.z', extra: 'drop', memberId: 'keep' })
assert.equal(fields?.memberEmail, 'x@y.z', 'closed keys kept')
assert.equal((fields as { extra?: string } | undefined)?.extra, undefined, 'unknown keys dropped')
rmSync(ownerRoot, { recursive: true, force: true })

rmSync(root, { recursive: true, force: true })
console.log('backup-store: ok')
