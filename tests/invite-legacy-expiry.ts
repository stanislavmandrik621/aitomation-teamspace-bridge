/**
 * TCC-R1186-INV-001: invite rows predating `expiresAt` count as EXPIRED
 * (TS-CHAT-031 family), never as fresh. The old normalize default stamped
 * `Date.now()` on every load; since redeem re-reads disk and compares
 * `expiresAt < Date.now()` in the same millisecond, a legacy row was
 * effectively immortal and redeemable forever. This test rewrites a freshly
 * minted row WITHOUT `expiresAt` and proves the plaintext credential that
 * would otherwise match is refused and the dead row is cleared from disk.
 *
 * TCC-R1186-INV-002: pending (unused, unexpired) invites are capped at 500 -
 * the per-connection rate limit bounds burst speed, not lifetime growth of
 * invites.json inside one 24h TTL window. Cancel frees a slot.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function legacyRowWithoutExpiryIsExpired(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-invite-legacy-'))
  try {
    const mintStore = new BridgeStore(root, 21, null)
    const created = mintStore.createInvite('mem_admin', 'legacy@example.com', 'member')
    assert(created.ok === true, 'mint for legacy test')
    const plain = created.ok ? created.invite.token : ''
    assert(plain.length > 0, 'plaintext token returned once at mint')

    // Simulate a row written by a bridge version that predates expiresAt.
    const invitesPath = join(root, 'invites.json')
    const rows = JSON.parse(readFileSync(invitesPath, 'utf8')) as Array<Record<string, unknown>>
    assert(rows.length === 1, 'one row on disk after mint')
    delete rows[0]!.expiresAt
    writeFileSync(invitesPath, JSON.stringify(rows), 'utf8')

    // Fresh store = fresh load + normalize. The credential WOULD match
    // (same plaintext, hashed row) - only the missing deadline may refuse.
    const store = new BridgeStore(root, 21, null)
    const redeemed = await store.redeemInvite({ token: plain, deviceId: 'dev-legacy-1' })
    assert(redeemed.ok === false, 'legacy no-expiry row must refuse redeem')

    // Dead secret cleared from disk by the prune touchpoint.
    const onDisk = JSON.parse(readFileSync(invitesPath, 'utf8')) as unknown[]
    assert(onDisk.length === 0, `legacy row cleared from disk (got ${onDisk.length})`)

    // And the admin list never shows it.
    const visible = store.listInvites()
    assert(visible.length === 0, 'legacy row invisible to admin list')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function pendingInviteCap(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-invite-cap-'))
  try {
    const now = Date.now()
    const rows = Array.from({ length: 500 }, (_, i) => ({
      id: `inv_cap_${i}`,
      token: 'f'.repeat(63) + (i % 10).toString(),
      email: '',
      role: 'member',
      createdBy: 'mem_admin',
      createdAt: now,
      expiresAt: now + 86_400_000,
      usedAt: null,
      usedBy: null,
    }))
    writeFileSync(join(root, 'invites.json'), JSON.stringify(rows), 'utf8')

    const store = new BridgeStore(root, 21, null)
    const refused = store.createInvite('mem_admin', 'over@example.com', 'member')
    assert(refused.ok === false, 'mint over the pending cap refuses')
    assert(
      refused.ok === false && /Too many pending invites/.test(refused.reason),
      'cap refusal names the fix (cancel or wait for expiry)',
    )

    // Cancel one -> a slot frees up and mint succeeds again.
    const cancelled = store.cancelInvite('inv_cap_0')
    assert(cancelled.ok === true, 'cancel frees a slot')
    const ok = store.createInvite('mem_admin', 'under@example.com', 'member')
    assert(ok.ok === true, 'mint succeeds after cancel under the cap')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  await legacyRowWithoutExpiryIsExpired()
  await pendingInviteCap()
  console.log('invite-legacy-expiry: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
