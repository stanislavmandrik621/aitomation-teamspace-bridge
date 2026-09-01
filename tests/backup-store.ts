/**
 * P6 - TeamBackupStore: stream upload, quotas, ownership index.
 */
import assert from 'node:assert/strict'
import {
  chmodSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs'
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
import {
  MAX_BACKUP_ZIP_AIMOVES,
  MAX_BACKUP_ZIP_AIMOVES_HARD_CAP,
  ZIP_ENTRY_NAME_UTF8_MAX,
  sanitizeZipEntryName,
} from '../src/backup-zip.js'

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

// User-typed backup labels: surrogate-safe cap (same class as TS-CHAT-032/034/042).
const labelRoot = mkdtempSync(join(tmpdir(), 'ts-backup-label-'))
const labelStore = new TeamBackupStore(labelRoot)
labelStore.setMeta({ minIntervalMs: 0, maxKeepPerMember: 20 })
const labelPayload = Buffer.from('label-cap-bytes')
const rocket = '\u{1F680}'
const lead = '\uD83D'

const overRocket = await labelStore.putSnapshotFromStream({
  memberId: 'mem_label',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: 'x'.repeat(119) + rocket,
})
assert.equal(overRocket.ok, true, 'over-cap rocket put')
if (!overRocket.ok) throw new Error('overRocket put failed')
assert.ok(overRocket.snapshot.label.isWellFormed(), 'over-cap rocket label is well-formed')
assert.equal(overRocket.snapshot.label.length, 119, 'rocket dropped, orphan lead dropped')
assert.equal(overRocket.snapshot.label, 'x'.repeat(119), 'over-cap rocket leaves only the filler')

const fitsRocket = await labelStore.putSnapshotFromStream({
  memberId: 'mem_label',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: 'x'.repeat(118) + rocket,
})
assert.equal(fitsRocket.ok, true, 'exact-fit rocket put')
if (!fitsRocket.ok) throw new Error('fitsRocket put failed')
assert.ok(fitsRocket.snapshot.label.endsWith(rocket), 'an astral character that fits is kept whole')
assert.equal(fitsRocket.snapshot.label.length, 120, 'exact-fit rocket stays at the cap')
assert.ok(fitsRocket.snapshot.label.isWellFormed(), 'exact-fit rocket label is well-formed')

const exactLead = await labelStore.putSnapshotFromStream({
  memberId: 'mem_label',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: 'x'.repeat(119) + lead,
})
assert.equal(exactLead.ok, true, 'exact-fit lone lead put')
if (!exactLead.ok) throw new Error('exactLead put failed')
assert.equal(exactLead.snapshot.label, 'x'.repeat(119), 'exact-fit lone lead is dropped, not passed through')
assert.ok(exactLead.snapshot.label.isWellFormed(), 'exact-fit lone lead label is well-formed')
assert.equal(('x'.repeat(119) + lead).length, 120, 'fixture sits exactly at the cap')

const healPut = await labelStore.putSnapshotFromStream({
  memberId: 'mem_heal',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: 'ok',
})
assert.equal(healPut.ok, true, 'heal seed put')
if (!healPut.ok) throw new Error('heal put failed')
const healIndexPath = join(labelRoot, 'backups', 'members', 'mem_heal', 'index.json')
const healIndex = JSON.parse(readFileSync(healIndexPath, 'utf8')) as { snapshots: Array<Record<string, unknown>> }
assert.ok(Array.isArray(healIndex.snapshots) && healIndex.snapshots[0], 'heal index has a row')
healIndex.snapshots[0]!.label = 'poisoned' + lead
writeFileSync(healIndexPath, JSON.stringify(healIndex, null, 2), 'utf8')
const reopenedHeal = new TeamBackupStore(labelRoot)
const healed = reopenedHeal.listForMember('mem_heal')
assert.equal(healed.length, 1, 'reopen still lists the poisoned row')
assert.ok(healed[0]!.label.isWellFormed(), 'read heals a dangling lead surrogate')
assert.equal(healed[0]!.label, 'poisoned', 'read drops only the orphan lead')

const nulPut = await labelStore.putSnapshotFromStream({
  memberId: 'mem_nul',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: '\0 hello \0',
})
assert.equal(nulPut.ok, true, 'NUL label put')
if (!nulPut.ok) throw new Error('nulPut failed')
assert.equal(nulPut.snapshot.label, 'hello', 'NUL + trim yields hello')

const omitPut = await labelStore.putSnapshotFromStream({
  memberId: 'mem_omit',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
})
assert.equal(omitPut.ok, true, 'omit label put')
if (!omitPut.ok) throw new Error('omitPut failed')
assert.equal(omitPut.snapshot.label, '', 'omitted label is empty')

const nonStringPut = await labelStore.putSnapshotFromStream({
  memberId: 'mem_nonstr',
  stream: Readable.from([labelPayload]),
  contentLength: labelPayload.length,
  label: 42 as unknown as string,
})
assert.equal(nonStringPut.ok, true, 'non-string label put')
if (!nonStringPut.ok) throw new Error('nonStringPut failed')
assert.equal(nonStringPut.snapshot.label, '', 'non-string label is empty')

const ownerLead = parseBackupOwnerFields({
  displayName: 'x'.repeat(199) + lead,
})
assert.ok(ownerLead?.displayName, 'owner displayName kept after repair')
assert.ok(ownerLead!.displayName!.isWellFormed(), 'owner displayName exact-fit lone lead is well-formed')
assert.equal(ownerLead!.displayName, 'x'.repeat(199), 'owner displayName drops only the orphan lead at 200')

// A20: streamed writes must fail fast once actual bytes exceed the
// DECLARED Content-Length, not only the 8 GiB global ceiling - a
// lying/mismatched stream must not be allowed to write and hash
// arbitrarily more than it declared before the post-hoc
// `bytes !== len` mismatch check finally catches it.
const overDeclaredRoot = mkdtempSync(join(tmpdir(), 'ts-backup-overdeclared-'))
const overDeclaredStore = new TeamBackupStore(overDeclaredRoot)
overDeclaredStore.setMeta({ minIntervalMs: 0 })
let overDeclaredChunksYielded = 0
async function* manyChunksGenerator(count: number, chunkSize: number) {
  for (let i = 0; i < count; i++) {
    overDeclaredChunksYielded++
    yield Buffer.alloc(chunkSize, 'a')
  }
}
const overDeclaredResult = await overDeclaredStore.putSnapshotFromStream({
  memberId: 'mem_overdeclared',
  stream: Readable.from(manyChunksGenerator(50, 4)),
  contentLength: 10,
})
assert.equal(overDeclaredResult.ok, false, 'a stream exceeding its declared Content-Length must fail')
assert.ok(
  overDeclaredChunksYielded < 50,
  `must abort once bytes exceed the declared length instead of draining the whole stream (yielded ${overDeclaredChunksYielded}/50)`,
)
assert.equal(overDeclaredStore.cleanupPartials(), 0, 'no leftover .part file after an over-declared-length abort')
rmSync(overDeclaredRoot, { recursive: true, force: true })

// A20: an index-persist failure AFTER the snapshot bytes are already
// safely renamed into place must never reject the promise uncaught, and
// must never leave the file orphaned on disk (invisible to quota
// accounting/listing/pruning forever because it never made it into the
// index). Simulate an unwritable index.json by pre-creating it as a
// directory, so atomicWriteJson's renameSync(tmp, indexPath) fails.
const idxFailRoot = mkdtempSync(join(tmpdir(), 'ts-backup-idxfail-'))
const idxFailStore = new TeamBackupStore(idxFailRoot)
idxFailStore.setMeta({ minIntervalMs: 0 })
const idxFailMemberId = 'mem_idxfail'
mkdirSync(join(idxFailRoot, 'backups', 'members', idxFailMemberId, 'index.json'), { recursive: true })
const idxFailPayload = Buffer.from('index-write-failure-payload')
const idxFailPut = await idxFailStore.putSnapshotFromStream({
  memberId: idxFailMemberId,
  stream: Readable.from([idxFailPayload]),
  contentLength: idxFailPayload.length,
  label: 'should-not-orphan',
})
assert.equal(idxFailPut.ok, false, 'index write failure must surface as ok:false, never throw/reject')
let idxFailLeftoverFiles: string[] = []
try {
  idxFailLeftoverFiles = readdirSync(join(idxFailRoot, 'backups', 'members', idxFailMemberId, 'snapshots'))
} catch { /* directory may not exist - also fine, nothing orphaned */ }
assert.equal(
  idxFailLeftoverFiles.length,
  0,
  'a snapshot that could not be indexed must not be left orphaned on disk',
)
rmSync(idxFailRoot, { recursive: true, force: true })

// A20: same class of bug on the delete path - if the index can't be
// re-persisted after a snapshot file is removed, deleteSnapshot must
// return ok:false instead of throwing/rejecting uncaught.
if (process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0)) {
  const delFailRoot = mkdtempSync(join(tmpdir(), 'ts-backup-delfail-'))
  const delFailStore = new TeamBackupStore(delFailRoot)
  delFailStore.setMeta({ minIntervalMs: 0 })
  const delFailMemberId = 'mem_delfail'
  const delFailPayload = Buffer.from('delete-index-failure-payload')
  const delFailPut = await delFailStore.putSnapshotFromStream({
    memberId: delFailMemberId,
    stream: Readable.from([delFailPayload]),
    contentLength: delFailPayload.length,
    label: 'to-delete',
  })
  assert.equal(delFailPut.ok, true, 'seed put for delete-failure test')
  if (!delFailPut.ok) throw new Error('seed put failed')
  const delFailMemberDir = join(delFailRoot, 'backups', 'members', delFailMemberId)
  // Remove write permission on the member dir so atomicWriteJson cannot
  // create its `index.json.<pid>.tmp` sibling file during the delete's
  // index rewrite (the snapshot file itself lives in a separate
  // `snapshots/` subdirectory whose own permissions are untouched, so
  // the earlier unlinkSync of that file still succeeds normally).
  chmodSync(delFailMemberDir, 0o500)
  let delFailResult: { ok: boolean; error?: string }
  try {
    delFailResult = await delFailStore.deleteSnapshot(delFailMemberId, delFailPut.snapshot.id)
  } finally {
    chmodSync(delFailMemberDir, 0o700)
  }
  assert.equal(delFailResult.ok, false, 'index write failure during delete must surface as ok:false, never throw')
  rmSync(delFailRoot, { recursive: true, force: true })
}

// TS-P6-021: `cleanupPartials()` runs on a 60-minute maintenance tick with no
// member lock and no age gate, while one upload may legitimately stream for a
// full 60 minutes. A sweep that lands mid-`pipeline()` used to unlink the live
// `.part`, and because POSIX keeps the unlinked inode open the transfer then
// "succeeded" all the way to a `renameSync` that failed with ENOENT - so a
// multi-GB backup died after moving every byte. The live path must be skipped
// while genuine crash residue in the very same folder is still collected.
{
  const raceRoot = mkdtempSync(join(tmpdir(), 'ts-backup-partrace-'))
  const raceStore = new TeamBackupStore(raceRoot)
  raceStore.setMeta({ minIntervalMs: 0 })
  const raceMember = 'mem_partrace'
  const raceSnapshots = join(raceRoot, 'backups', 'members', raceMember, 'snapshots')

  let openGate: (() => void) | null = null
  const gate = new Promise<void>((res) => { openGate = res })
  async function* slowBody(): AsyncGenerator<Buffer> {
    yield Buffer.from('first-half--')
    await gate
    yield Buffer.from('second-half-')
  }
  const inFlight = raceStore.putSnapshotFromStream({
    memberId: raceMember,
    stream: Readable.from(slowBody()),
    contentLength: 24,
    label: 'slow upload',
  })

  // Wait for the upload to actually own a `.part` on disk.
  let livePartName = ''
  for (let i = 0; i < 200 && !livePartName; i += 1) {
    await new Promise((res) => setTimeout(res, 5))
    try {
      livePartName = readdirSync(raceSnapshots).find((f) => f.endsWith('.part')) ?? ''
    } catch { /* dir not created yet */ }
  }
  assert.ok(livePartName, 'the in-flight upload should be streaming into a .part file')

  // Genuine crash residue sitting beside it must still be collected.
  const orphanPart = join(raceSnapshots, 'snap_2020-01-01_dead.aimove.999999.part')
  writeFileSync(orphanPart, 'residue from a crashed run')
  const swept = raceStore.cleanupPartials()
  assert.equal(swept, 1, 'the sweep must collect the orphan and skip the live upload')
  assert.equal(
    readdirSync(raceSnapshots).includes(livePartName),
    true,
    'a live upload\'s .part must survive a concurrent maintenance sweep',
  )

  openGate?.()
  const raced = await inFlight
  assert.equal(raced.ok, true, 'an upload straddling a maintenance sweep must still succeed')
  if (raced.ok) {
    assert.equal(raced.snapshot.bytes, 24)
    // The renamed file must be on disk and indexed - the old bug made the
    // rename fail with ENOENT after every byte had already been transferred.
    assert.ok(
      readdirSync(raceSnapshots).includes(`${raced.snapshot.id}.aimove`),
      'the finished snapshot must exist under its final name',
    )
    assert.ok(
      raceStore.getSnapshot(raceMember, raced.snapshot.id),
      'the finished snapshot must be indexed',
    )
  }
  // Registration is dropped on the way out, so later sweeps are unaffected.
  assert.equal(raceStore.cleanupPartials(), 0)
  rmSync(raceRoot, { recursive: true, force: true })
}

const backupStoreSrc = readFileSync(new URL('../src/backup-store.ts', import.meta.url), 'utf8')
assert.equal(
  backupStoreSrc.includes('.trim().slice(0, 120)'),
  false,
  'label sites must not use raw trim+slice(0, 120)',
)
assert.ok(backupStoreSrc.includes('function capBackupLabel('), 'capBackupLabel helper exists')
assert.ok(backupStoreSrc.includes('label: capBackupLabel(r.label)'), 'readIndex uses capBackupLabel')
assert.ok(backupStoreSrc.includes('label: capBackupLabel(args.label)'), 'putSnapshotFromStream uses capBackupLabel')
assert.equal(
  backupStoreSrc.includes('.trim().slice(0, BACKUP_META_FIELD_MAX)'),
  false,
  'owner fields must not use raw trim+slice',
)
assert.ok(
  backupStoreSrc.includes('capStr(v.replace(/[\\u0000-\\u001f\\u007f]/g, \'\').trim(), BACKUP_META_FIELD_MAX)')
    || backupStoreSrc.includes('capStr(v.replace(/[\\u0000-\\u001f\\u007f]/g, "").trim(), BACKUP_META_FIELD_MAX)'),
  'parseBackupOwnerFields caps via capStr after the control-strip',
)
assert.equal(
  backupStoreSrc.includes('err.message.slice'),
  false,
  'backup-store must not raw-slice err.message',
)
assert.ok(backupStoreSrc.includes('function capBackupError('), 'capBackupError helper exists')
assert.ok(
  backupStoreSrc.includes('capStr(err.message, BACKUP_META_FIELD_MAX)'),
  'capBackupError routes through capStr',
)
assert.ok(
  backupStoreSrc.includes("capBackupError(err, 'Backup write failed')"),
  'write catch uses capBackupError',
)
assert.ok(
  backupStoreSrc.includes("capBackupError(err, 'Could not finalize backup')"),
  'finalize catch uses capBackupError',
)
assert.ok(
  backupStoreSrc.includes("capBackupError(err, 'Could not delete member backups')"),
  'delete catch uses capBackupError',
)
assert.ok(
  backupStoreSrc.includes('if (bytes > len)'),
  'streamed write must bound against the declared Content-Length, not only the global ceiling',
)
assert.ok(
  backupStoreSrc.includes("capBackupError(err, 'Could not record backup')"),
  'putSnapshotFromStream must catch an index-persist failure after rename, not let it throw uncaught',
)
assert.ok(
  backupStoreSrc.includes("capBackupError(err, 'Could not update the backup index')"),
  'deleteSnapshot must catch an index-persist failure, not let it throw uncaught',
)

const zipSrc = readFileSync(new URL('../src/backup-zip.ts', import.meta.url), 'utf8')
assert.equal(ZIP_ENTRY_NAME_UTF8_MAX, 720, 'UTF-8 name ceiling covers capStr(180) CJK')
assert.equal(zipSrc.includes('nameBuf.length > 200'), false, 'zip plan must not refuse at 200 UTF-8 bytes')
assert.ok(zipSrc.includes('nameBuf.length > ZIP_ENTRY_NAME_UTF8_MAX'), 'zip plan uses the UTF-8 ceiling')
assert.ok(zipSrc.includes('ZIP_ENTRY_NAME_MAX - ext.length'), 'zip basename reserves the extension')
const cjkZipName = '你'.repeat(180)
const cjkZipBytes = Buffer.byteLength(sanitizeZipEntryName(cjkZipName), 'utf8')
assert.ok(cjkZipBytes > 200, '180 CJK units exceed the old 200-byte refuse')
assert.ok(cjkZipBytes <= ZIP_ENTRY_NAME_UTF8_MAX, '180 CJK units fit the UTF-8 name ceiling')
const longAimove = `mem_${'a'.repeat(124)}/${'文'.repeat(120)}.aimove`
const cappedAimove = sanitizeZipEntryName(longAimove)
assert.ok(longAimove.length > 180)
assert.equal(cappedAimove.endsWith('.aimove'), true, 'memberId+label path must keep .aimove')
assert.ok(cappedAimove.length <= 180)
assert.ok(Buffer.byteLength(cappedAimove, 'utf8') <= ZIP_ENTRY_NAME_UTF8_MAX)

rmSync(labelRoot, { recursive: true, force: true })

rmSync(root, { recursive: true, force: true })
console.log('backup-store: ok')
