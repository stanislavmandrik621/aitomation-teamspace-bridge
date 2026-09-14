/**
 * TCC-R1132-BRG-001 - guest public-share / portal `queue_full` ceilings were
 * dead: `listPending*` hard-caps its RETURN length at 100 (Admin page size)
 * regardless of the `limit` argument passed in, so probing
 * `listPending*(REAL_MAX + 1).length >= REAL_MAX` could never trip (100 can
 * never be >= 2000, or >= 200) no matter how backed up the real on-disk
 * queue got. The fix adds a dedicated uncapped-by-page-size counter
 * (`countPendingSubmissions` / `countPendingOtpSends`) that `enqueueSubmission`
 * / `requestOtp` probe instead, while `listPending*` itself keeps its 100-row
 * Admin-list cap unchanged.
 *
 * These tests seed the REAL production ceiling's worth of pending rows
 * directly on disk (bypassing the per-caller rate limiters that would
 * otherwise make a same-process end-to-end repro slow/flaky) and then make
 * ONE real `enqueueSubmission` / `requestOtp` call to prove `queue_full`
 * actually fires - and that a queue just under the ceiling is NOT refused.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import {
  PublicShareBridgeStore,
  type PublicShareRow,
  type PublicSharePayload,
} from '../src/public-share-store.js'
import { PortalBridgeStore, type PortalRow, type PortalPayload } from '../src/portal-store.js'

const MAX_PENDING_SUBMISSIONS = 2_000 // must match public-share-store.ts / portal-store.ts
const MAX_PENDING_OTP_SENDS = 200 // must match portal-store.ts

function seedPendingSubmissionFiles(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const id = randomBytes(8).toString('hex')
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        localShareId: 'share1',
        entityId: 'entity1',
        data: { name: `row ${i}` },
        status: 'pending',
        error: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      'utf8',
    )
  }
}

function seedPendingOtpFiles(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < count; i += 1) {
    const id = randomBytes(8).toString('hex')
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        id,
        tokenHash: 'a'.repeat(64),
        email: `guest${i}@example.com`,
        portalName: 'Test portal',
        codePlain: '123456',
        codeHash: 'b'.repeat(64),
        expiresAt: Date.now() + 10 * 60 * 1000,
        createdAt: Date.now(),
      }),
      'utf8',
    )
  }
}

describe('TCC-R1132-BRG-001 - queue_full ceilings match the real store MAX', () => {
  it('public share enqueueSubmission refuses with share.queue_full once the REAL 2000 ceiling is reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-share-queue-'))
    try {
      const store = new PublicShareBridgeStore(dir, null)
      const submissionsDir = (store as unknown as { submissionsDir: string }).submissionsDir
      // One under the real ceiling: must NOT be refused.
      seedPendingSubmissionFiles(submissionsDir, MAX_PENDING_SUBMISSIONS - 1)
      const row: PublicShareRow = {
        tokenHash: 'a'.repeat(64),
        localShareId: 'share1',
        mode: 'create',
        viewType: 'table',
        label: 'Test',
        passwordHash: null,
        includeCsv: false,
        expiresAt: null,
        revokedAt: null,
        payloadReady: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ownerMemberId: 'owner1',
      }
      const payload: PublicSharePayload = {
        version: 1,
        mode: 'create',
        viewType: 'table',
        label: 'Test',
        entityId: 'entity1',
        fields: [
          { slug: 'name', name: 'Name', field_type: 'text', required: false, config: {}, default_value: null },
        ],
        rows: [],
        total: 0,
        truncated: false,
        includeCsv: false,
        pushedAt: Date.now(),
      }
      const under = store.enqueueSubmission({ row, payload, rawData: { name: 'ok' } })
      assert.equal(under.ok, true, 'queue just under the real ceiling must be accepted')

      // Cross the real ceiling: the NEXT enqueue must be refused.
      seedPendingSubmissionFiles(submissionsDir, 2)
      const over = store.enqueueSubmission({ row, payload, rawData: { name: 'blocked' } })
      assert.equal(over.ok, false, 'queue at/over the real 2000 ceiling must be refused')
      if (!over.ok) {
        assert.equal(over.error_code, 'share.queue_full')
        assert.equal(over.status, 503)
      }

      // Regression pin: the OLD bug used listPendingSubmissions(MAX+1).length,
      // which hard-caps at 100 regardless of argument - so it could never
      // reach a 2000 ceiling. Confirm that cap is still exactly 100 (Admin
      // list UI contract unchanged) while enqueueSubmission above proves the
      // real check no longer routes through that capped list.
      const displayList = store.listPendingSubmissions(MAX_PENDING_SUBMISSIONS + 1)
      assert.ok(displayList.length <= 100, 'Admin display list stays capped at 100 rows')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('portal requestOtp refuses with portal.otp_queue_full once the REAL 200 ceiling is reached', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-portal-otp-queue-'))
    try {
      const store = new PortalBridgeStore(dir, null)
      const otpPendingDir = (store as unknown as { otpPendingDir: string }).otpPendingDir
      seedPendingOtpFiles(otpPendingDir, MAX_PENDING_OTP_SENDS - 1)
      const row: PortalRow = {
        tokenHash: 'c'.repeat(64),
        localPortalId: 'portal1',
        name: 'Test portal',
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
      const under = store.requestOtp({ row, email: 'guest-under@example.com', clientIp: '10.0.0.1' })
      assert.equal(under.ok, true, 'queue just under the real 200 ceiling must be accepted')

      seedPendingOtpFiles(otpPendingDir, 2)
      const over = store.requestOtp({ row, email: 'guest-over@example.com', clientIp: '10.0.0.2' })
      assert.equal(over.ok, false, 'queue at/over the real 200 ceiling must be refused')
      if (!over.ok) {
        assert.equal(over.error_code, 'portal.otp_queue_full')
        assert.equal(over.status, 503)
      }

      const displayList = store.listPendingOtpSends(MAX_PENDING_OTP_SENDS + 1)
      assert.ok(displayList.length <= 100, 'Admin display list stays capped at 100 rows')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('portal enqueueSubmission refuses with portal.queue_full once the REAL 2000 ceiling is reached (separate from the OTP-send queue)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ts-portal-submit-queue-'))
    try {
      const store = new PortalBridgeStore(dir, null)
      const submissionsDir = (store as unknown as { submissionsDir: string }).submissionsDir
      seedPendingSubmissionFiles(submissionsDir, MAX_PENDING_SUBMISSIONS - 1)
      const row: PortalRow = {
        tokenHash: 'd'.repeat(64),
        localPortalId: 'portal2',
        name: 'Test portal',
        authMode: 'anonymous',
        pinHash: null,
        allowedActions: ['create'],
        expiresAt: null,
        revokedAt: null,
        payloadReady: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ownerMemberId: 'owner1',
      }
      const payload: PortalPayload = {
        version: 1,
        portalId: 'portal2',
        name: 'Test portal',
        entityId: 'entity1',
        authMode: 'anonymous',
        allowedActions: ['create'],
        design: {},
        aclSnapshot: {},
        fields: [
          { slug: 'name', name: 'Name', field_type: 'text', required: false, config: {}, default_value: null },
        ],
        pushedAt: Date.now(),
      }
      const under = store.enqueueSubmission({
        row,
        payload,
        rawData: { name: 'ok' },
        clientIp: '10.1.0.1',
      })
      assert.equal(under.ok, true, 'queue just under the real ceiling must be accepted')

      seedPendingSubmissionFiles(submissionsDir, 2)
      const over = store.enqueueSubmission({
        row,
        payload,
        rawData: { name: 'blocked' },
        clientIp: '10.1.0.2',
      })
      assert.equal(over.ok, false, 'queue at/over the real 2000 ceiling must be refused')
      if (!over.ok) {
        assert.equal(over.error_code, 'portal.queue_full')
        assert.equal(over.status, 503)
      }

      const displayList = store.listPendingSubmissions(MAX_PENDING_SUBMISSIONS + 1)
      assert.ok(displayList.length <= 100, 'Admin display list stays capped at 100 rows')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
