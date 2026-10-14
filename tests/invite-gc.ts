/**
 * TCC-R1133-TLS-002: invite store must GC used/expired rows opportunistically
 * (create/cancel/redeem/list touchpoints) so a long-lived self-host bridge
 * does not keep plaintext-hash-adjacent invite rows on disk forever. An
 * in-flight incomplete claim (`claim:<deviceId>:...`, TS-RACE-004 crash-retry)
 * must survive the sweep even though it carries a `usedAt` stamp.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-invite-gc-'))
  try {
    const now = Date.now()
    const rows = [
      // Expired, never used -> must be pruned.
      {
        id: 'inv_expired',
        token: 'a'.repeat(64),
        email: 'expired@example.com',
        role: 'member',
        createdBy: 'mem_admin',
        createdAt: now - 100_000,
        expiresAt: now - 1_000,
        usedAt: null,
        usedBy: null,
      },
      // Fully redeemed (real member id, not a claim: nonce) -> must be pruned
      // even though its expiresAt is still in the future.
      {
        id: 'inv_completed',
        token: 'b'.repeat(64),
        email: 'completed@example.com',
        role: 'member',
        createdBy: 'mem_admin',
        createdAt: now - 100_000,
        expiresAt: now + 86_400_000,
        usedAt: now - 1_000,
        usedBy: 'mem_joined_already',
      },
      // Incomplete crash-retry claim -> must be PRESERVED (redeemInviteInner
      // retry path still needs to find it) despite having a usedAt stamp.
      {
        id: 'inv_claim',
        token: 'c'.repeat(64),
        email: 'claim@example.com',
        role: 'member',
        createdBy: 'mem_admin',
        createdAt: now - 100_000,
        expiresAt: now + 86_400_000,
        usedAt: now - 1_000,
        usedBy: 'claim:dev1:abc123:xyz',
      },
      // Still pending, not expired -> must be preserved.
      {
        id: 'inv_pending',
        token: 'd'.repeat(64),
        email: 'pending@example.com',
        role: 'member',
        createdBy: 'mem_admin',
        createdAt: now - 100_000,
        expiresAt: now + 86_400_000,
        usedAt: null,
        usedBy: null,
      },
    ]
    writeFileSync(join(root, 'invites.json'), JSON.stringify(rows), 'utf8')

    const store = new BridgeStore(root, 21, null)
    // Any touchpoint (listInvites here) opportunistically sweeps.
    const admin = store.listInvites()
    // Admin-facing list already filters !usedAt && !expired, so only the
    // pending row is visible here - the real GC proof is the on-disk file.
    assert(admin.length === 1 && admin[0]!.id === 'inv_pending', 'admin view shows only pending invite')

    const onDisk = JSON.parse(readFileSync(join(root, 'invites.json'), 'utf8')) as Array<{ id: string }>
    const ids = onDisk.map((r) => r.id).sort()
    assert(ids.length === 2, `expired + completed rows must be pruned from disk (got ${ids.length}: ${ids.join(',')})`)
    assert(ids.includes('inv_claim'), 'incomplete claim survives the sweep')
    assert(ids.includes('inv_pending'), 'pending invite survives the sweep')
    assert(!ids.includes('inv_expired'), 'expired invite removed from disk')
    assert(!ids.includes('inv_completed'), 'completed invite removed from disk')

    // A second sweep touchpoint (createInvite) with nothing left to prune
    // must be a no-op, not throw or blow away the survivors.
    const created = store.createInvite('mem_admin', 'new@example.com', 'member')
    assert(created.ok === true, 'createInvite still works after GC')
    const onDisk2 = JSON.parse(readFileSync(join(root, 'invites.json'), 'utf8')) as Array<{ id: string }>
    assert(onDisk2.length === 3, `claim + pending + new invite survive (got ${onDisk2.length})`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  console.log('invite-gc: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
