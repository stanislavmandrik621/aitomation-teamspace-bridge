/**
 * Image deps/build stages must COPY the lockfile and run npm ci so the
 * published image gets the same runtime ws this repo tests (8.21.1).
 *
 * L40 exclusive also pins guest-store residuals (package.json is parent-only):
 * live-first share GC, expire/revoke intake unlinked from queue_full, and
 * guest write never persists "[object Object]".
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PublicShareBridgeStore } from '../src/public-share-store.js'
import {
  PortalBridgeStore,
  GUEST_STORE_PORTAL_TEAM_MISMATCH,
  GUEST_STORE_SHARE_TEAM_MISMATCH,
  guestHttpBodyTeamId,
} from '../src/portal-store.js'
import { GUEST_ESC_JS } from '../src/guest-page-render.js'
import { escGuestHtml } from '../src/guest-page-theme.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dockerfilePath = join(root, 'Dockerfile')
const lockPath = join(root, 'package-lock.json')

function namedStage(df: string, name: string): string {
  const start = new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${name}\\s*$`, 'im')
  const m = start.exec(df)
  assert.ok(m, `missing ${name} stage`)
  const after = df.slice(m.index + m[0].length)
  const next = /^FROM\s+/im.exec(after)
  return next ? after.slice(0, next.index) : after
}

function copyLines(stage: string): string[] {
  return stage
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('COPY ') && !line.startsWith('COPY --from='))
}

function assertInstallStage(stage: string, name: string): void {
  assert.doesNotMatch(stage, /\bnpm install\b/, `${name}: npm install without ci`)
  assert.match(stage, /\bnpm ci\b/, `${name}: missing npm ci`)
  const copies = copyLines(stage)
  for (const line of copies) {
    if (/\bpackage\.json\b/.test(line) && !/\bpackage-lock\.json\b/.test(line)) {
      assert.fail(`${name}: COPY package.json without package-lock.json`)
    }
  }
  assert.ok(
    copies.some((line) => /\bpackage\.json\b/.test(line) && /\bpackage-lock\.json\b/.test(line)),
    `${name}: must COPY package-lock.json with package.json`,
  )
}

try {
  const df = readFileSync(dockerfilePath, 'utf8')
  assertInstallStage(namedStage(df, 'deps'), 'deps')
  assertInstallStage(namedStage(df, 'build'), 'build')

  assert.equal(existsSync(lockPath), true, 'package-lock.json is missing')
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    packages?: Record<string, { version?: string }>
    dependencies?: Record<string, { version?: string }>
  }
  const wsVersion = lock.packages?.['node_modules/ws']?.version ?? lock.dependencies?.ws?.version
  assert.equal(wsVersion, '8.21.1', `locked ws is ${String(wsVersion)}, expected 8.21.1`)
  assert.ok(GUEST_ESC_JS.includes('function guestPlainText'), 'esc must use guestPlainText')
  assert.equal(
    GUEST_ESC_JS.includes("String(s==null?'':s)"),
    false,
    'GUEST_ESC_JS esc must not String(object)',
  )
  assert.equal(escGuestHtml({ name: 'Acme' }), 'Acme')
  assert.equal(escGuestHtml({ weird: true }), '')
  assert.ok(!escGuestHtml({ weird: true }).includes('[object Object]'))
  console.log('ok')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exit(1)
}

function hex64(ch: string): string {
  return ch.repeat(64)
}

function sharePayload(): {
  version: 1
  mode: 'create'
  viewType: string
  label: string
  entityId: string
  fields: Array<{
    slug: string
    name: string
    field_type: string
    required: boolean
    config: Record<string, unknown>
    default_value: string | null
  }>
  rows: []
  total: number
  truncated: boolean
  includeCsv: boolean
  pushedAt: number
} {
  return {
    version: 1,
    mode: 'create',
    viewType: 'table',
    label: 'Form',
    entityId: 'ent_1',
    fields: [
      { slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null },
    ],
    rows: [],
    total: 0,
    truncated: false,
    includeCsv: false,
    pushedAt: Date.now(),
  }
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ts-l40-share-gc-'))
  try {
    const now = Date.now()
    const liveHashes: string[] = []
    const shares: Array<Record<string, unknown>> = []
    for (let i = 0; i < 10; i += 1) {
      shares.push({
        tokenHash: hex64((i + 1).toString(16)),
        localShareId: `revoked_${i}`,
        mode: 'read',
        viewType: 'table',
        label: `Revoked ${i}`,
        passwordHash: null,
        includeCsv: false,
        expiresAt: null,
        revokedAt: now - i,
        payloadReady: false,
        createdAt: now - 10_000 + i,
        updatedAt: now - i,
        ownerMemberId: 'owner1',
      })
    }
    for (let i = 0; i < 490; i += 1) {
      const tokenHash = `${i.toString(16).padStart(4, '0')}${'a'.repeat(60)}`
      liveHashes.push(tokenHash)
      shares.push({
        tokenHash,
        localShareId: `live_${i}`,
        mode: 'read',
        viewType: 'table',
        label: `Live ${i}`,
        passwordHash: null,
        includeCsv: false,
        expiresAt: null,
        revokedAt: null,
        payloadReady: false,
        createdAt: now - 20_000 + i,
        updatedAt: now - 20_000 + i,
        ownerMemberId: 'owner1',
      })
    }
    writeFileSync(join(dir, 'public-shares.json'), JSON.stringify({ shares }), 'utf8')
    const store = new PublicShareBridgeStore(dir, null)
    const added = store.upsertShare('owner1', {
      tokenHash: hex64('f'),
      localShareId: 'live_new',
      mode: 'read',
      viewType: 'table',
      label: 'New live',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
    })
    assert.equal(added.ok, true, '11th live after 490 live + 10 revoked must be admitted')
    assert.ok(store.findByTokenHash(hex64('f')), 'new live kept')
    for (const h of liveHashes) {
      assert.ok(store.findByTokenHash(h), `live-first GC dropped ${h}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: live-first share GC ok')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ts-l40-share-expire-'))
  try {
    const store = new PublicShareBridgeStore(dir, null)
    const tokenHash = hex64('c')
    const payload = sharePayload()
    const up = store.upsertShare('owner1', {
      tokenHash,
      localShareId: 'share_expire',
      mode: 'create',
      viewType: 'table',
      label: 'Expire',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
    })
    assert.equal(up.ok, true)
    if (!up.ok) throw new Error('unreachable')
    const enq = store.enqueueSubmission({
      row: up.row,
      payload,
      rawData: { title: 'keep' },
      clientIp: 'ip-1',
    })
    assert.equal(enq.ok, true)
    const expired = store.upsertShare('owner1', {
      tokenHash,
      localShareId: 'share_expire',
      mode: 'create',
      viewType: 'table',
      label: 'Expire',
      passwordHash: null,
      includeCsv: false,
      expiresAt: Date.now() - 1000,
      payload,
    })
    assert.equal(expired.ok, true)
    assert.equal(store.listPendingSubmissions(50).length, 0, 'expiry must unlink leftover intake')
    const refuse = store.enqueueSubmission({
      row: { ...up.row, expiresAt: Date.now() - 1000 },
      payload,
      rawData: { title: 'late' },
      clientIp: 'ip-2',
    })
    assert.equal(refuse.ok, false)
    if (!refuse.ok) assert.equal(refuse.error_code, 'share.expired')

    const named = { name: 'Acme Co' }
    const live = store.upsertShare('owner1', {
      tokenHash: hex64('d'),
      localShareId: 'share_write',
      mode: 'create',
      viewType: 'table',
      label: 'Write',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
    })
    assert.equal(live.ok, true)
    if (!live.ok) throw new Error('unreachable')
    const objOk = store.enqueueSubmission({
      row: live.row,
      payload,
      rawData: { title: named },
      clientIp: 'ip-3',
    })
    assert.equal(objOk.ok, true)
    const listed = store.listPendingSubmissions(10)
    assert.equal(listed[0]?.data.title, 'Acme Co')
    assert.ok(!JSON.stringify(listed[0]?.data).includes('[object Object]'))
    const objSkip = store.enqueueSubmission({
      row: live.row,
      payload,
      rawData: { title: { weird: true } },
      clientIp: 'ip-4',
    })
    assert.equal(objSkip.ok, true)
    const listed2 = store.listPendingSubmissions(10)
    for (const row of listed2) {
      assert.notEqual(row.data.title, '[object Object]')
    }

    const olderId = 'aa'.repeat(16)
    const newerId = '00'.repeat(16)
    const subDir = join(dir, 'public-share-submissions')
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      join(subDir, `${newerId}.json`),
      JSON.stringify({
        id: newerId,
        localShareId: 'share_write',
        entityId: 'ent_1',
        data: { title: 'newer' },
        status: 'pending',
        error: null,
        createdAt: 200,
        updatedAt: 200,
      }),
      'utf8',
    )
    writeFileSync(
      join(subDir, `${olderId}.json`),
      JSON.stringify({
        id: olderId,
        localShareId: 'share_write',
        entityId: 'ent_1',
        data: { title: 'older' },
        status: 'pending',
        error: null,
        createdAt: 100,
        updatedAt: 100,
      }),
      'utf8',
    )
    const page = store.listPendingSubmissions(1)
    assert.equal(page[0]?.data.title, 'older', 'listPending must page oldest createdAt first')
    const page2 = store.listPendingSubmissions(1)
    assert.equal(page2[0]?.data.title, 'newer', 'claimed lease must skip the row the first drain already took')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: expire intake + write ladder + oldest-first ok')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ts-l40-portal-expire-'))
  try {
    const store = new PortalBridgeStore(dir, null)
    const payload = {
      version: 1 as const,
      portalId: 'portal_expire',
      name: 'P',
      entityId: 'ent_1',
      authMode: 'magic_link' as const,
      allowedActions: ['create'],
      design: {},
      aclSnapshot: {},
      fields: [
        { slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null },
      ],
      pushedAt: Date.now(),
    }
    const up = store.upsertPortal('owner1', {
      tokenHash: hex64('a'),
      localPortalId: 'portal_expire',
      name: 'P',
      authMode: 'magic_link',
      pinHash: null,
      allowedActions: ['create'],
      payload,
    })
    assert.equal(up.ok, true)
    if (!up.ok) throw new Error('unreachable')
    const sent = store.requestOtp({ row: up.row, email: 'guest@example.com', clientIp: 'ip-p1' })
    assert.equal(sent.ok, true)
    assert.equal(store.listPendingOtpSends(10).length, 1)
    const expired = store.upsertPortal('owner1', {
      tokenHash: hex64('a'),
      localPortalId: 'portal_expire',
      name: 'P',
      authMode: 'magic_link',
      pinHash: null,
      allowedActions: ['create'],
      expiresAt: Date.now() - 1000,
      payload,
    })
    assert.equal(expired.ok, true)
    assert.equal(store.listPendingOtpSends(10).length, 0, 'expiry must unlink leftover OTP')
    const refuseOtp = store.requestOtp({
      row: { ...up.row, expiresAt: Date.now() - 1000 },
      email: 'late@example.com',
      clientIp: 'ip-p2',
    })
    assert.equal(refuseOtp.ok, false)
    if (!refuseOtp.ok) assert.equal(refuseOtp.error_code, 'portal.expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: portal expire OTP unlink ok')
}

{
  assert.equal(guestHttpBodyTeamId({ team_id: 'team-a' }), 'team-a')
  assert.equal(guestHttpBodyTeamId({ teamId: 'team-b', team_id: 'other' }), 'team-b')
  assert.equal(guestHttpBodyTeamId({ team_id: 'x\0y' }), 'x')
  const dir = mkdtempSync(join(tmpdir(), 'ts-l40-team-iso-'))
  try {
    const portals = new PortalBridgeStore(dir, null)
    const shares = new PublicShareBridgeStore(dir, null)
    const payload = {
      version: 1 as const,
      portalId: 'portal_iso',
      name: 'P',
      entityId: 'ent_1',
      authMode: 'anonymous' as const,
      allowedActions: ['create'],
      design: {},
      aclSnapshot: {},
      fields: [
        { slug: 'title', name: 'Title', field_type: 'text', required: false, config: {}, default_value: null },
      ],
      pushedAt: Date.now(),
    }
    const upA = portals.upsertPortal('owner1', {
      tokenHash: hex64('1'),
      localPortalId: 'portal_iso',
      name: 'P',
      authMode: 'anonymous',
      pinHash: null,
      allowedActions: ['create'],
      team_id: 'team-a',
      payload,
    })
    assert.equal(upA.ok, true)
    if (!upA.ok) throw new Error('unreachable')
    assert.equal(upA.row.teamId, 'team-a')
    const steal = portals.upsertPortal('owner2', {
      tokenHash: hex64('2'),
      localPortalId: 'portal_iso',
      name: 'Stolen',
      authMode: 'anonymous',
      pinHash: null,
      allowedActions: ['create'],
      team_id: 'team-b',
    })
    assert.equal(steal.ok, false)
    if (!steal.ok) assert.equal(steal.error, GUEST_STORE_PORTAL_TEAM_MISMATCH)
    const stillA = portals.upsertPortal('owner1', {
      tokenHash: hex64('1'),
      localPortalId: 'portal_iso',
      name: 'P-kept',
      authMode: 'anonymous',
      pinHash: null,
      allowedActions: ['create'],
      team_id: 'team-a',
    })
    assert.equal(stillA.ok, true)
    if (stillA.ok) assert.equal(stillA.row.name, 'P-kept')
    const badRevoke = portals.revokePortal({ localPortalId: 'portal_iso', team_id: 'team-b' })
    assert.equal(badRevoke.ok, false)
    if (!badRevoke.ok) assert.equal(badRevoke.error, GUEST_STORE_PORTAL_TEAM_MISMATCH)
    const goodRevoke = portals.revokePortal({ localPortalId: 'portal_iso', team_id: 'team-a' })
    assert.equal(goodRevoke.ok, true)

    const shareUp = shares.upsertShare('owner1', {
      tokenHash: hex64('3'),
      localShareId: 'share_iso',
      mode: 'read',
      viewType: 'table',
      label: 'S',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      teamId: 'team-a',
    })
    assert.equal(shareUp.ok, true)
    const shareSteal = shares.upsertShare('owner2', {
      tokenHash: hex64('4'),
      localShareId: 'share_iso',
      mode: 'read',
      viewType: 'table',
      label: 'Stolen',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      team_id: 'team-b',
    })
    assert.equal(shareSteal.ok, false)
    if (!shareSteal.ok) assert.equal(shareSteal.error, GUEST_STORE_SHARE_TEAM_MISMATCH)
    const payloadSteal = shares.setPayload({
      localShareId: 'share_iso',
      payload: sharePayload(),
      team_id: 'team-b',
    })
    assert.equal(payloadSteal.ok, false)
    if (!payloadSteal.ok) assert.equal(payloadSteal.error, GUEST_STORE_SHARE_TEAM_MISMATCH)
    const shareBad = shares.revokeShare({ localShareId: 'share_iso', team_id: 'team-b' })
    assert.equal(shareBad.ok, false)
    const shareOk = shares.revokeShare({ localShareId: 'share_iso', teamId: 'team-a' })
    assert.equal(shareOk.ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: register/revoke team_id isolation ok')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ts-g13-share-drain-'))
  try {
    const store = new PublicShareBridgeStore(dir, null)
    const payload = sharePayload()
    const leftover = store.upsertShare('owner1', {
      tokenHash: hex64('5'),
      localShareId: 'share_left',
      mode: 'create',
      viewType: 'table',
      label: 'Left',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
    })
    const t1 = store.upsertShare('owner1', {
      tokenHash: hex64('6'),
      localShareId: 'share_t1',
      mode: 'create',
      viewType: 'table',
      label: 'T1',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
      teamId: 'team-a',
    })
    const t2 = store.upsertShare('owner1', {
      tokenHash: hex64('7'),
      localShareId: 'share_t2',
      mode: 'create',
      viewType: 'table',
      label: 'T2',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
      team_id: 'team-b',
    })
    assert.equal(leftover.ok && t1.ok && t2.ok, true)
    if (!leftover.ok || !t1.ok || !t2.ok) throw new Error('unreachable')

    const enqLeft = store.enqueueSubmission({
      row: leftover.row,
      payload,
      rawData: { title: `ok\uD800` },
      clientIp: 'ip-d1',
    })
    const enqT1 = store.enqueueSubmission({
      row: t1.row,
      payload,
      rawData: { title: 't1' },
      clientIp: 'ip-d2',
    })
    const enqT2 = store.enqueueSubmission({
      row: t2.row,
      payload,
      rawData: { title: 't2' },
      clientIp: 'ip-d3',
    })
    assert.equal(enqLeft.ok && enqT1.ok && enqT2.ok, true)
    if (!enqLeft.ok || !enqT1.ok || !enqT2.ok) throw new Error('unreachable')

    const omit = store.listPendingSubmissions(50, 'owner1')
    assert.equal(omit.length, 1, 'omit/blank drain is leftover only')
    assert.equal(omit[0]?.data.title, 'ok', 'capStr must drop a trailing lead surrogate')
    assert.equal(omit[0]?.localShareId, 'share_left')

    const onlyT1 = store.listPendingSubmissions(50, 'owner1', 'team-a\0junk')
    assert.equal(onlyT1.length, 1, 'named T1 drain must not apply T2')
    assert.equal(onlyT1[0]?.data.title, 't1')

    const onlyT2 = store.listPendingSubmissions(50, 'owner1', 'team-b')
    assert.equal(onlyT2.length, 1, 'named T2 drain must not apply T1')
    assert.equal(onlyT2[0]?.data.title, 't2')

    const subDir = join(dir, 'public-share-submissions')
    const t2Path = join(subDir, `${enqT2.id}.json`)
    const stealAck = store.ackSubmission(enqT2.id, 'applied', null, 'team-a')
    assert.equal(stealAck.ok, false, 'T1 ack must refuse a T2 row')
    if (!stealAck.ok) assert.equal(stealAck.error, GUEST_STORE_SHARE_TEAM_MISMATCH)
    assert.equal(existsSync(t2Path), true, 'refused ack must leave the T2 file')

    const blankAck = store.ackSubmission(enqT2.id, 'applied', null)
    assert.equal(blankAck.ok, false, 'blank leftover ack must not delete a named row')
    if (!blankAck.ok) assert.equal(blankAck.error, GUEST_STORE_SHARE_TEAM_MISMATCH)
    assert.equal(existsSync(t2Path), true)

    const okAck = store.ackSubmission(enqT2.id, 'applied', null, 'team-b')
    assert.equal(okAck.ok, true)
    assert.equal(existsSync(t2Path), false)

    const leftoverAck = store.ackSubmission(enqLeft.id, 'rejected', null)
    assert.equal(leftoverAck.ok, true, 'blank leftover ack still admits leftover intake')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: drain/ack team_id + capStr ok')
}

{
  const dir = mkdtempSync(join(tmpdir(), 'ts-g13-share-queue-team-'))
  try {
    const store = new PublicShareBridgeStore(dir, null)
    const payload = sharePayload()
    const subDir = join(dir, 'public-share-submissions')
    mkdirSync(subDir, { recursive: true })
    for (let i = 0; i < 2000; i += 1) {
      const id = `b${i.toString(16).padStart(31, '0')}`
      writeFileSync(
        join(subDir, `${id}.json`),
        JSON.stringify({
          id,
          localShareId: 'share_orphan',
          entityId: 'ent_1',
          data: { title: 'orphan' },
          status: 'pending',
          error: null,
          createdAt: i,
          updatedAt: i,
        }),
        'utf8',
      )
    }
    const t1 = store.upsertShare('owner1', {
      tokenHash: hex64('8'),
      localShareId: 'share_q1',
      mode: 'create',
      viewType: 'table',
      label: 'Q1',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
      teamId: 'team-a',
    })
    assert.equal(t1.ok, true)
    if (!t1.ok) throw new Error('unreachable')
    const namedOk = store.enqueueSubmission({
      row: t1.row,
      payload,
      rawData: { title: 'named' },
      clientIp: 'ip-q1',
    })
    assert.equal(namedOk.ok, true, 'leftover T2/orphan pending must not trip T1 queue_full')

    const leftoverRow = store.upsertShare('owner1', {
      tokenHash: hex64('9'),
      localShareId: 'share_qleft',
      mode: 'create',
      viewType: 'table',
      label: 'QL',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
    })
    assert.equal(leftoverRow.ok, true)
    if (!leftoverRow.ok) throw new Error('unreachable')
    const leftoverFull = store.enqueueSubmission({
      row: leftoverRow.row,
      payload,
      rawData: { title: 'blocked' },
      clientIp: 'ip-q2',
    })
    assert.equal(leftoverFull.ok, false, 'leftover count still honors the 2000 ceiling')
    if (!leftoverFull.ok) assert.equal(leftoverFull.error_code, 'share.queue_full')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  console.log('l40 guest-store: named enqueue ignores leftover queue_full ok')
}

{
  const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
  assert.match(server, /function guestHttpDrainTeamId/)
  assert.match(server, /guestHttpBodyTeamId\s*\(\s*body\s*\)\s*\|\|\s*boundTeamId\s*\(\s*\)/)
  assert.match(
    server,
    /publicShares\.listPendingSubmissions\s*\([\s\S]{0,240}guestHttpDrainTeamIdFromUrl\s*\(\s*url\s*\)/,
  )
  assert.match(
    server,
    /publicShares\.ackSubmission\s*\([\s\S]{0,280}guestHttpDrainTeamId\s*\(\s*body\s*\)/,
  )
  assert.match(
    server,
    /portals\.listPendingSubmissions[\s\S]{0,480}guestHttpDrainTeamIdFromUrl\s*\(\s*url\s*\)/,
  )
  assert.match(
    server,
    /portals\.ackSubmission[\s\S]{0,480}guestHttpDrainTeamId\s*\(\s*body\s*\)/,
  )
  assert.match(
    server,
    /listPendingOtpSends\s*\(\s*limitRaw\s*,\s*guestHttpDrainTeamIdFromUrl\s*\(\s*url\s*\)/,
  )
  console.log('l40 guest-store: HTTP drain passes teamId (TCC-FIX-SHARE-013) ok')
}
