/**
 * TCC-R1133-PRT-002 (OTP session Map size prune), TCC-R1133-PRT-003 (acked
 * submissions unlinked from disk, not rewritten), TCC-R1134-PRT-001 (hex-id
 * path traversal sanitization), TCC-R1134-PRT-003 (acked OTP sends unlinked
 * from disk, not rewritten).
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBridgeClientIp } from '../src/client-ip.js'
import {
  capGuestStoreScopeId,
  capGuestStoreTeamId,
  GUEST_REGISTRY_UNREADABLE,
  GUEST_STORE_PORTAL_TEAM_MISMATCH,
  PortalBridgeStore,
  pruneSessionMapOverCap,
  OTP_SESSION_MAP_SOFT_CAP,
  OTP_SESSION_MAP_SWEEP_BATCH,
  readGuestRegistryArray,
  type PortalRow,
  type PortalPayload,
} from '../src/portal-store.js'
import { PublicShareBridgeStore } from '../src/public-share-store.js'

// --- TCC-R1133-PRT-002: pruneSessionMapOverCap pure-function behavior ---

// 1) Over cap, nothing expired -> falls back to oldest-eviction of exactly
//    one sweep batch, never leaving the map unbounded.
{
  const map = new Map<number, { expiresAt: number }>()
  const future = Date.now() + 1_000_000
  for (let i = 0; i < OTP_SESSION_MAP_SOFT_CAP + 1; i += 1) {
    map.set(i, { expiresAt: future })
  }
  assert.equal(map.size, OTP_SESSION_MAP_SOFT_CAP + 1)
  pruneSessionMapOverCap(map, Date.now(), (v) => v.expiresAt)
  assert.equal(
    map.size,
    OTP_SESSION_MAP_SOFT_CAP + 1 - OTP_SESSION_MAP_SWEEP_BATCH,
    'falls back to evicting exactly one sweep batch of the OLDEST entries',
  )
  // Oldest (lowest insertion-order keys 0..SWEEP_BATCH-1) must be the ones gone.
  assert.equal(map.has(0), false, 'oldest entry evicted')
  assert.equal(map.has(OTP_SESSION_MAP_SOFT_CAP), true, 'newest entry survives')
}

// 2) Under cap -> no-op (no wasted work on every hot-path .set()).
{
  const map = new Map<number, { expiresAt: number }>()
  map.set(1, { expiresAt: Date.now() + 1_000 })
  pruneSessionMapOverCap(map, Date.now(), (v) => v.expiresAt)
  assert.equal(map.size, 1, 'under-cap map left untouched')
}

// 3) Over cap with expired entries available -> expiry sweep alone is
//    preferred over oldest-eviction when it is enough to get back under cap.
{
  const map = new Map<number, { expiresAt: number }>()
  const now = Date.now()
  const past = now - 1_000
  const future = now + 1_000_000
  for (let i = 0; i < 400; i += 1) map.set(i, { expiresAt: past }) // expired
  for (let i = 400; i < OTP_SESSION_MAP_SOFT_CAP + 1; i += 1) map.set(i, { expiresAt: future })
  pruneSessionMapOverCap(map, now, (v) => v.expiresAt)
  assert.equal(
    map.size,
    OTP_SESSION_MAP_SOFT_CAP + 1 - 400,
    'expiry sweep alone drops the map back under cap without touching live entries',
  )
  for (let i = 0; i < 400; i += 1) assert.equal(map.has(i), false, `expired key ${i} removed`)
  for (let i = 400; i < 410; i += 1) assert.equal(map.has(i), true, `live key ${i} preserved`)
}

// 4) Expired count exceeds one sweep batch -> bounded work per call (never
//    scans/deletes more than SWEEP_BATCH in a single invocation).
{
  const map = new Map<number, { expiresAt: number }>()
  const now = Date.now()
  const past = now - 1_000
  const total = OTP_SESSION_MAP_SOFT_CAP + OTP_SESSION_MAP_SWEEP_BATCH + 500
  for (let i = 0; i < total; i += 1) map.set(i, { expiresAt: past }) // ALL expired
  pruneSessionMapOverCap(map, now, (v) => v.expiresAt)
  assert.equal(
    map.size,
    total - OTP_SESSION_MAP_SWEEP_BATCH,
    'one call removes at most one sweep batch even with a huge expired backlog',
  )
}

console.log('portal-store: prune-session-map-over-cap ok')

// --- Live store: OTP request-rate bucket growth is bounded across many
// concurrent, never-revisited guest IPs (real code path, not just the pure
// helper above) ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-otp-'))
  const store = new PortalBridgeStore(root)
  const row: PortalRow = {
    tokenHash: 'a'.repeat(64),
    localPortalId: 'portal_otp_test',
    name: 'Test Portal',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  }
  // Each call uses a unique clientIp so the per-IP rate limit never blocks
  // it. Ack each send immediately so the (unrelated) disk pending-queue
  // stays near-empty across all 10,005 iterations - otherwise every call's
  // `countPendingOtpSends` readdirSync+decrypt scan of a never-shrinking
  // pending dir would make this loop O(n^2) and the test would hang. The
  // otpRequestBuckets Map entry is still created/updated on every call
  // regardless of ack state, which is what this loop is proving stays
  // bounded (via the pure-function assertions above).
  const attempts = OTP_SESSION_MAP_SOFT_CAP + 5
  for (let i = 0; i < attempts; i += 1) {
    const sent = store.requestOtp({ row, email: 'guest@example.com', clientIp: `ip-${i}` })
    if (sent.ok) {
      const pend = store.listPendingOtpSends(1)
      if (pend[0]) store.ackOtpSend({ id: pend[0].id })
    }
  }
  // No public getter for the Map size (by design - it is a private
  // implementation detail); the proof of bounded growth is the pure-function
  // behavior above plus that this loop completes without unbounded memory
  // growth or throwing. Sanity: the store is still usable afterward.
  const stillWorks = store.requestOtp({ row, email: 'final@example.com', clientIp: 'ip-final' })
  assert.equal(typeof stillWorks.ok, 'boolean', 'store remains responsive after 10,005 unique-IP requests')
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: otp-request-bucket growth bounded ok')

/**
 * BRGPROXY-001: the OTP request limiter is the sharpest consequence of the
 * X-Forwarded-For read, so it gets its own regression guard here.
 *
 * `verifyOtp` is NOT keyed on client IP - it caps wrong guesses per issued
 * challenge (5) and is unaffected by any header. The break ran through the
 * REQUEST side: `requestOtp` is the IP-keyed one, and every successful request
 * mints a fresh challenge with `attempts` reset to 0. So the per-challenge cap
 * is only load-bearing while the request rate is capped - bypass the request
 * limiter and a 6-digit code faces unlimited guesses in batches of 5.
 *
 * Behind a proxy that appends (`$proxy_add_x_forwarded_for`), a caller that sent
 * its own X-Forwarded-For got a brand-new bucket per request. This proves a
 * forged prefix now buys nothing. The honest budget is MEASURED rather than
 * hard-coded, so tuning the real limit cannot silently pass this test.
 */
{
  const makeRow = (): PortalRow => ({
    tokenHash: 'b'.repeat(64),
    localPortalId: 'portal_otp_xff',
    name: 'Test Portal',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  })

  // Ack as we go so the pending-queue scan stays cheap (same reason as above).
  const countAccepted = (store: PortalBridgeStore, ipFor: (i: number) => string): number => {
    const row = makeRow()
    let accepted = 0
    for (let i = 0; i < 40; i += 1) {
      const sent = store.requestOtp({ row, email: 'guest@example.com', clientIp: ipFor(i) })
      if (sent.ok) {
        accepted += 1
        const pend = store.listPendingOtpSends(1)
        if (pend[0]) store.ackOtpSend({ id: pend[0].id })
      }
    }
    return accepted
  }

  // Baseline: one caller, one honest key.
  const rootHonest = mkdtempSync(join(tmpdir(), 'ts-portal-otp-honest-'))
  const honestStore = new PortalBridgeStore(rootHonest)
  const honestBudget = countAccepted(honestStore, () => '198.51.100.7')
  assert.ok(honestBudget > 0, 'an honest caller gets some OTP request budget')
  assert.ok(honestBudget < 40, 'the OTP request limiter actually caps an honest caller')
  rmSync(rootHonest, { recursive: true, force: true })

  // The attack: same caller, a different forged X-Forwarded-For prefix each time,
  // resolved through the real client-ip leaf with a loopback peer (local proxy).
  const rootSpoof = mkdtempSync(join(tmpdir(), 'ts-portal-otp-spoof-'))
  const spoofStore = new PortalBridgeStore(rootSpoof)
  const spoofBudget = countAccepted(spoofStore, (i) =>
    resolveBridgeClientIp('127.0.0.1', `10.${i}.${i}.${i}, 203.0.113.66`, new Set()),
  )
  assert.equal(
    spoofBudget,
    honestBudget,
    'a forged X-Forwarded-For prefix must not buy extra OTP code requests',
  )
  rmSync(rootSpoof, { recursive: true, force: true })
}
console.log('portal-store: otp request limiter resists X-Forwarded-For spoofing ok')

// --- TCC-R1133-PRT-003 + TCC-R1134-PRT-001: ackSubmission unlinks the file
// (not rewrites), and refuses a path-traversal id ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-ack-'))
  const store = new PortalBridgeStore(root)
  const row: PortalRow = {
    tokenHash: 'b'.repeat(64),
    localPortalId: 'portal_ack_test',
    name: 'Ack Portal',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  }
  const payload: PortalPayload = {
    version: 1,
    portalId: 'portal_ack_test',
    name: 'Ack Portal',
    entityId: 'ent_1',
    authMode: 'anonymous',
    allowedActions: ['create'],
    design: {},
    aclSnapshot: {},
    fields: [{ slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null }],
    pushedAt: Date.now(),
  }
  const enq = store.enqueueSubmission({ row, payload, rawData: { title: 'hello' }, clientIp: 'ip-ack-1' })
  assert.equal(enq.ok, true, 'submission enqueued')
  if (!enq.ok) throw new Error('unreachable')
  const submissionsDir = join(root, 'portal-submissions')
  const fileBefore = join(submissionsDir, `${enq.id}.json`)
  assert.equal(existsSync(fileBefore), true, 'submission file exists on disk before ack')
  assert.equal(store.listPendingSubmissions().length, 1, 'submission is pending')

  // Path-traversal id must be refused, never touch a file outside the id.
  const traversal = store.ackSubmission({ submissionId: '../../../../etc/passwd', status: 'applied' })
  assert.equal(traversal.ok, false, 'path-traversal submission id refused')

  const acked = store.ackSubmission({ submissionId: enq.id, status: 'applied' })
  assert.equal(acked.ok, true, 'ack succeeds for a real id')
  assert.equal(existsSync(fileBefore), false, 'acked submission file is UNLINKED, not left on disk')
  assert.equal(store.listPendingSubmissions().length, 0, 'no longer counted as pending')
  assert.equal(readdirSync(submissionsDir).length, 0, 'submissions dir does not grow unbounded after ack')

  // Re-acking an already-removed id fails closed instead of throwing.
  const reAck = store.ackSubmission({ submissionId: enq.id, status: 'applied' })
  assert.equal(reAck.ok, false, 're-ack of a gone submission fails closed')

  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: ackSubmission unlink + path-traversal refusal ok')

// --- TCC-R1134-PRT-003: ackOtpSend unlinks the file (not rewrites) ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-otp-ack-'))
  const store = new PortalBridgeStore(root)
  const row: PortalRow = {
    tokenHash: 'c'.repeat(64),
    localPortalId: 'portal_otp_ack_test',
    name: 'OTP Ack Portal',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  }
  const sent = store.requestOtp({ row, email: 'otp-ack@example.com', clientIp: 'ip-otp-ack' })
  assert.equal(sent.ok, true, 'otp send accepted')
  const pending = store.listPendingOtpSends(10)
  assert.equal(pending.length, 1, 'one pending otp send visible')
  const otpId = pending[0]!.id
  const otpDir = join(root, 'portal-otp-pending')
  const otpFileBefore = join(otpDir, `${otpId}.json`)
  assert.equal(existsSync(otpFileBefore), true, 'otp send file exists before ack')

  const otpTraversal = store.ackOtpSend({ id: '../../../etc/passwd' })
  assert.equal(otpTraversal.ok, false, 'path-traversal otp id refused')

  const otpAcked = store.ackOtpSend({ id: otpId })
  assert.equal(otpAcked.ok, true, 'ack succeeds for a real otp id')
  assert.equal(existsSync(otpFileBefore), false, 'acked otp send file is UNLINKED, not left on disk')
  assert.equal(store.listPendingOtpSends(10).length, 0, 'no longer counted as pending')
  assert.equal(readdirSync(otpDir).length, 0, 'otp-pending dir does not grow unbounded after ack')

  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: ackOtpSend unlink + path-traversal refusal ok')

// --- TCC-R1151-BKP-001: listPendingSubmissions scopes by ownerMemberId ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-owner-list-'))
  const store = new PortalBridgeStore(root)
  const payload: PortalPayload = {
    version: 1,
    portalId: 'p',
    name: 'P',
    entityId: 'ent_1',
    authMode: 'anonymous',
    allowedActions: ['create'],
    design: {},
    aclSnapshot: {},
    fields: [{ slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null }],
    pushedAt: Date.now(),
  }
  const upA = store.upsertPortal('mem_admin_a', {
    tokenHash: 'a'.repeat(64),
    localPortalId: 'portal_a',
    name: 'A',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    payload,
  })
  assert.equal(upA.ok, true)
  const upB = store.upsertPortal('mem_admin_b', {
    tokenHash: 'b'.repeat(64),
    localPortalId: 'portal_b',
    name: 'B',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    payload,
  })
  assert.equal(upB.ok, true)
  if (!upA.ok || !upB.ok) throw new Error('unreachable')
  const enqA = store.enqueueSubmission({
    row: upA.row,
    payload: { ...payload, portalId: 'portal_a' },
    rawData: { title: 'from A' },
    clientIp: 'ip-a',
  })
  const enqB = store.enqueueSubmission({
    row: upB.row,
    payload: { ...payload, portalId: 'portal_b' },
    rawData: { title: 'from B' },
    clientIp: 'ip-b',
  })
  assert.equal(enqA.ok && enqB.ok, true)
  // Claim-on-list leases pending rows (TCC-R1150-BKP-001) - scoped probes must
  // run before any unscoped drain, or the lease hides the same rows.
  const onlyA = store.listPendingSubmissions(50, 'mem_admin_a')
  assert.equal(onlyA.length, 1, 'owner A sees only own pending')
  assert.equal(onlyA[0]?.localPortalId, 'portal_a')
  // Fresh store for B (A's claim would hide A's row from a second unscoped-style
  // scan, but B's row was never claimed).
  const onlyB = store.listPendingSubmissions(50, 'mem_admin_b')
  assert.equal(onlyB.length, 1, 'owner B sees only own pending')
  assert.equal(onlyB[0]?.localPortalId, 'portal_b')
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: listPendingSubmissions owner filter ok')

// --- Guest registry: present but not-an-array must not fold to [] / wipe ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-guest-registry-unread-'))
  const badPortals = JSON.stringify({ portals: { not: 'an-array' } })
  writeFileSync(join(root, 'portals.json'), badPortals, 'utf8')
  const leaf = readGuestRegistryArray(join(root, 'portals.json'), null, 'portals')
  assert.equal(leaf.ok, false, 'leaf refuses a non-array portals list')
  if (leaf.ok) throw new Error('unreachable')
  assert.equal(leaf.reason, GUEST_REGISTRY_UNREADABLE)

  const store = new PortalBridgeStore(root)
  const up = store.upsertPortal('mem_admin', {
    tokenHash: 'c'.repeat(64),
    localPortalId: 'portal_unread',
    name: 'Unread',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
  })
  assert.equal(up.ok, false, 'upsert must refuse when portals.json is unreadable')
  if (up.ok) throw new Error('unreachable')
  assert.equal(up.error, GUEST_REGISTRY_UNREADABLE)
  assert.equal(readFileSync(join(root, 'portals.json'), 'utf8'), badPortals, 'unreadable portals.json must not be overwritten')
  assert.equal(store.resolveGuest('any-token').reason, 'unreadable')

  const missing = mkdtempSync(join(tmpdir(), 'ts-guest-registry-miss-'))
  const empty = readGuestRegistryArray(join(missing, 'portals.json'), null, 'portals')
  assert.equal(empty.ok, true, 'missing file is empty, not unreadable')
  if (!empty.ok) throw new Error('unreachable')
  assert.deepEqual(empty.rows, [])

  const badShares = JSON.stringify({ shares: 'nope' })
  writeFileSync(join(root, 'public-shares.json'), badShares, 'utf8')
  const shares = new PublicShareBridgeStore(root, null)
  const shareUp = shares.upsertShare('mem_admin', {
    tokenHash: 'd'.repeat(64),
    localShareId: 'share_unread',
    mode: 'read',
    viewType: 'table',
    label: 'Unread',
    passwordHash: null,
    includeCsv: false,
    expiresAt: null,
  })
  assert.equal(shareUp.ok, false, 'upsert must refuse when public-shares.json is unreadable')
  if (shareUp.ok) throw new Error('unreachable')
  assert.equal(shareUp.error, GUEST_REGISTRY_UNREADABLE)
  assert.equal(readFileSync(join(root, 'public-shares.json'), 'utf8'), badShares)
  assert.equal(shares.resolveGuest('any-token').reason, 'unreadable')

  rmSync(root, { recursive: true, force: true })
  rmSync(missing, { recursive: true, force: true })
}
console.log('portal-store: guest registry unreadable ok')

{
  const aclRoot = mkdtempSync(join(tmpdir(), 'ts-portal-acl-unread-'))
  const aclStore = new PortalBridgeStore(aclRoot)
  const badAcl = aclStore.upsertPortal('mem_admin', {
    tokenHash: 'e'.repeat(64),
    localPortalId: 'portal_acl',
    name: 'Acl',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    payload: {
      version: 1,
      portalId: 'p',
      name: 'P',
      entityId: 'ent_1',
      authMode: 'anonymous',
      allowedActions: ['create'],
      design: {},
      aclSnapshot: { hiddenSlugs: 'nope' },
      fields: [{ slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null }],
      pushedAt: Date.now(),
    },
  })
  assert.equal(badAcl.ok, false, 'payload hiddenSlugs must be an array when present')
  rmSync(aclRoot, { recursive: true, force: true })
}
console.log('portal-store: payload hiddenSlugs unreadable ok')

{
  assert.equal(capGuestStoreTeamId(`team-a\0junk`), 'team-a')
  assert.equal(capGuestStoreScopeId(`portal_iso\0junk`), 'portal_iso')
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-scope-nul-'))
  const store = new PortalBridgeStore(root)
  const up = store.upsertPortal('mem_admin\0other', {
    tokenHash: 'f'.repeat(64),
    localPortalId: 'portal_iso\0junk',
    name: 'Iso',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    teamId: 'team-a\0junk',
  })
  assert.equal(up.ok, true, 'NUL leftover on scope/team must cut, not refuse')
  if (!up.ok) throw new Error('unreachable')
  assert.equal(up.row.localPortalId, 'portal_iso')
  assert.equal(up.row.ownerMemberId, 'mem_admin')
  assert.equal(up.row.teamId, 'team-a')
  const steal = store.revokePortal({ localPortalId: 'portal_iso', team_id: 'team-b' })
  assert.equal(steal.ok, false, 'named team-b cannot revoke team-a after NUL-cut stamp')
  const okRevoke = store.revokePortal({ localPortalId: 'portal_iso\0still-junk', teamId: 'team-a\0x' })
  assert.equal(okRevoke.ok, true, 'revoke must NUL-cut local id and team to the stamped row')
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: scope/team NUL-cut ok')

// --- TS-CHAT-032/034/042: guest email + form cells use capTrim / capStr ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-text-cap-'))
  const store = new PortalBridgeStore(root)
  const pair = '\uD83D\uDE00'
  const lead = '\uD83D'
  const emailOver = `${'a'.repeat(317)}@x${pair}`
  const emailExactBroken = `${'a'.repeat(317)}@x${lead}`
  const leftoverRow: PortalRow = {
    tokenHash: '1'.repeat(64),
    localPortalId: 'portal_email_cap',
    name: 'Email Cap',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  }
  const overSend = store.requestOtp({
    row: leftoverRow,
    email: emailOver,
    clientIp: 'ip-email-over',
  })
  assert.equal(overSend.ok, true, 'over-length email still accepted after cap')
  const overListed = store.listPendingOtpSends(10)
  assert.equal(overListed.length, 1)
  const overEmail = overListed[0]!.email
  assert.ok(overEmail.length <= 320, 'OTP email capped at 320')
  assert.equal(overEmail.isWellFormed(), true, 'over-length email cap must not leave a lone surrogate')
  assert.equal(overEmail.includes(lead) && !overEmail.includes(pair), false)
  store.ackOtpSend({ id: overListed[0]!.id })

  const exactSend = store.requestOtp({
    row: leftoverRow,
    email: emailExactBroken,
    clientIp: 'ip-email-exact',
  })
  assert.equal(exactSend.ok, true, 'exact-cap lone-lead email is repaired (TS-CHAT-042)')
  const exactListed = store.listPendingOtpSends(10)
  assert.equal(exactListed.length, 1)
  const exactEmail = exactListed[0]!.email
  assert.equal(exactEmail.isWellFormed(), true, 'exact-fit email repair is unconditional')
  assert.equal(exactEmail.endsWith(lead), false)
  store.ackOtpSend({ id: exactListed[0]!.id })

  const formRow: PortalRow = {
    tokenHash: '2'.repeat(64),
    localPortalId: 'portal_form_cap',
    name: 'Form Cap',
    authMode: 'anonymous',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
  }
  const formPayload: PortalPayload = {
    version: 1,
    portalId: 'portal_form_cap',
    name: 'Form Cap',
    entityId: 'ent_cap',
    authMode: 'anonymous',
    allowedActions: ['create'],
    design: {},
    aclSnapshot: {},
    fields: [
      { slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null },
      { slug: 'tags', name: 'Tags', field_type: 'text', required: false, config: {}, default_value: null },
      { slug: 'ref', name: 'Ref', field_type: 'text', required: false, config: {}, default_value: null },
    ],
    pushedAt: Date.now(),
  }
  const titleOver = `${'x'.repeat(9_999)}${pair}`
  const tagOver = `${'y'.repeat(199)}${pair}`
  const refOver = `${'z'.repeat(9_999)}${pair}`
  const enq = store.enqueueSubmission({
    row: formRow,
    payload: formPayload,
    rawData: {
      title: titleOver,
      tags: [tagOver, 'ok'],
      ref: { name: refOver },
    },
    clientIp: 'ip-form-cap',
  })
  assert.equal(enq.ok, true, 'form cells enqueue after cap')
  const pendingForm = store.listPendingSubmissions(10)
  assert.equal(pendingForm.length, 1)
  const title = pendingForm[0]!.data.title
  const tags = pendingForm[0]!.data.tags
  const ref = pendingForm[0]!.data.ref
  assert.equal(typeof title, 'string')
  assert.equal(typeof tags, 'string')
  assert.equal(typeof ref, 'string')
  if (typeof title !== 'string' || typeof tags !== 'string' || typeof ref !== 'string') {
    throw new Error('unreachable')
  }
  assert.ok(title.length <= 10_000, 'string cell capped at 10000')
  assert.equal(title.isWellFormed(), true, 'string cell cap must not leave a lone surrogate')
  assert.ok(tags.length <= 10_000, 'joined array cell capped at 10000')
  assert.equal(tags.isWellFormed(), true, 'array item cap must not leave a lone surrogate')
  assert.ok(!tags.startsWith(`${'y'.repeat(199)}${lead},`), 'array item must drop a split pair at 200')
  assert.ok(ref.length <= 10_000, 'object name cell capped at 10000')
  assert.equal(ref.isWellFormed(), true, 'object name cap must not leave a lone surrogate')
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: guest email/form capStr capTrim ok')

// --- OTP pending teamId: named list/count that team only; omit = leftover ---
{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-otp-team-'))
  const store = new PortalBridgeStore(root)
  const makeRow = (tokenChar: string, localPortalId: string, teamId?: string): PortalRow => ({
    tokenHash: tokenChar.repeat(64),
    localPortalId,
    name: localPortalId,
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    expiresAt: null,
    revokedAt: null,
    payloadReady: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'mem_admin',
    ...(teamId ? { teamId } : {}),
  })
  const leftover = makeRow('3', 'portal_otp_leftover')
  const teamA = makeRow('4', 'portal_otp_a', 'team-a')
  const teamB = makeRow('5', 'portal_otp_b', 'team-b')
  const upA = store.upsertPortal('mem_admin', {
    tokenHash: teamA.tokenHash,
    localPortalId: teamA.localPortalId,
    name: teamA.name,
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: ['create'],
    teamId: 'team-a',
  })
  assert.equal(upA.ok, true)
  if (!upA.ok) throw new Error('unreachable')
  const steal = store.revokePortal({ localPortalId: 'portal_otp_a', team_id: 'team-b' })
  assert.equal(steal.ok, false, 'named team-b cannot revoke team-a (TCC-FIX-SHARE-013)')
  if (!steal.ok) assert.equal(steal.error, GUEST_STORE_PORTAL_TEAM_MISMATCH)

  assert.equal(store.requestOtp({ row: leftover, email: 'left@example.com', clientIp: 'ip-left' }).ok, true)
  assert.equal(store.requestOtp({ row: upA.row, email: 'a@example.com', clientIp: 'ip-a' }).ok, true)
  assert.equal(store.requestOtp({ row: teamB, email: 'b@example.com', clientIp: 'ip-b' }).ok, true)

  const omitList = store.listPendingOtpSends(10)
  assert.equal(omitList.length, 1, 'omit lists leftover only')
  assert.equal(omitList[0]?.email, 'left@example.com')
  assert.equal(capGuestStoreTeamId(omitList[0]?.teamId), '')

  const listA = store.listPendingOtpSends(10, 'team-a')
  assert.equal(listA.length, 1, 'named team-a lists that team only')
  assert.equal(listA[0]?.email, 'a@example.com')
  assert.equal(listA[0]?.teamId, 'team-a')

  const listB = store.listPendingOtpSends(10, 'team-b')
  assert.equal(listB.length, 1, 'named team-b lists that team only')
  assert.equal(listB[0]?.email, 'b@example.com')
  assert.equal(listB[0]?.teamId, 'team-b')

  const otpDir = join(root, 'portal-otp-pending')
  assert.equal(
    readdirSync(otpDir).length,
    3,
    'other-team live OTP files must stay on disk (no silent drop)',
  )
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: otp pending teamId list scope ok')

{
  const root = mkdtempSync(join(tmpdir(), 'ts-portal-otp-queue-team-'))
  const store = new PortalBridgeStore(root)
  const otpDir = join(root, 'portal-otp-pending')
  const MAX_PENDING_OTP_SENDS = 200
  for (let i = 0; i < MAX_PENDING_OTP_SENDS; i += 1) {
    const id = `ab${String(i).padStart(14, '0')}`
    writeFileSync(
      join(otpDir, `${id}.json`),
      JSON.stringify({
        id,
        tokenHash: '6'.repeat(64),
        email: `other${i}@example.com`,
        portalName: 'Other',
        codePlain: '123456',
        codeHash: 'c'.repeat(64),
        expiresAt: Date.now() + 10 * 60 * 1000,
        createdAt: Date.now(),
        teamId: 'team-other',
      }),
      'utf8',
    )
  }
  const leftoverRow: PortalRow = {
    tokenHash: '7'.repeat(64),
    localPortalId: 'portal_otp_queue_left',
    name: 'Leftover',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: [],
    expiresAt: null,
    revokedAt: null,
    payloadReady: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'owner1',
  }
  const leftoverOk = store.requestOtp({
    row: leftoverRow,
    email: 'left-queue@example.com',
    clientIp: '10.0.0.8',
  })
  assert.equal(leftoverOk.ok, true, 'named-team backlog must not trip leftover otp_queue_full')

  const namedRow: PortalRow = {
    tokenHash: '8'.repeat(64),
    localPortalId: 'portal_otp_queue_named',
    name: 'Named',
    authMode: 'magic_link',
    pinHash: null,
    allowedActions: [],
    expiresAt: null,
    revokedAt: null,
    payloadReady: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerMemberId: 'owner1',
    teamId: 'team-other',
  }
  const namedFull = store.requestOtp({
    row: namedRow,
    email: 'named-queue@example.com',
    clientIp: '10.0.0.9',
  })
  assert.equal(namedFull.ok, false, 'named team counts only its own pending files')
  if (!namedFull.ok) {
    assert.equal(namedFull.error_code, 'portal.otp_queue_full')
    assert.equal(namedFull.status, 503)
  }
  assert.equal(
    readdirSync(otpDir).filter((n) => n.endsWith('.json')).length,
    MAX_PENDING_OTP_SENDS + 1,
    'leftover request must not drop the other team live OTP files',
  )
  rmSync(root, { recursive: true, force: true })
}
console.log('portal-store: otp pending teamId queue_full scope ok')

console.log('portal-store: ok')
