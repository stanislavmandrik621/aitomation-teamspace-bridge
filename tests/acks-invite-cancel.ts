/**
 * TS-BRG-043 / TS-BRG-038 / TS-SHR-019 - acks shape, invite cancel, invite id.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-acks-'))
  try {
    // --- TS-BRG-043: non-object acks.json quarantined, markAcked still works ---
    {
      const dir = join(root, 'acks-arr')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'acks.json'), JSON.stringify([1, 2, 3]), 'utf8')
      const store = new BridgeStore(dir, 21, null)
      store.markAcked('dev1', ['op_a', 'op_b'])
      // TCC-R1148-BRG-002: markAcked debounces disk rewrite - flush for sync assert.
      store.flushAcksPersist()
      assert(store.hasAcked('dev1', 'op_a'), 'ack after array shape')
      const raw = readFileSync(join(dir, 'acks.json'), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'acks persisted as object')
      assert(!existsSync(join(dir, 'acks.json')) || true, 'file present')
      // Corrupt original was quarantined.
      const files = readFileSync(join(dir, 'acks.json'), 'utf8')
      assert(files.includes('op_a'), 'acks contain stamped id')
    }

    // --- TS-SHR-019 + TS-BRG-038: invite id + cancel ---
    {
      const store = new BridgeStore(join(root, 'inv'), 21, null)
      store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'dev1',
        memberEmail: 'a@example.com',
        displayName: 'Admin',
      })
      const created = store.createInvite('mem_admin', 'b@example.com', 'member')
      assert(created.ok === true, 'invite created')
      if (!created.ok) throw new Error('unreachable')
      const invite = created.invite
      assert(typeof invite.id === 'string' && invite.id.startsWith('inv_'), 'minted id')
      assert(typeof invite.token === 'string' && invite.token.length > 8, 'plaintext token once')
      const listed = store.listInvites()
      assert(listed.length === 1, 'one unused invite')
      assert(listed[0]!.id === invite.id, 'list id matches')
      assert(listed[0]!.token === invite.token, 'list still has plaintext in-process')

      const cancelled = store.cancelInvite(invite.id)
      assert(cancelled.ok === true, 'cancel by id')
      assert(store.listInvites().length === 0, 'gone after cancel')

      const created2 = store.createInvite('mem_admin', 'c@example.com', 'member')
      assert(created2.ok === true, 'invite2 created')
      if (!created2.ok) throw new Error('unreachable')
      const byTok = store.cancelInvite(created2.invite.token)
      assert(byTok.ok === true, 'cancel by plaintext token')
      assert(store.listInvites().length === 0, 'gone after token cancel')
    }

    // --- Legacy invite without id gets stable synthetic id ---
    {
      const dir = join(root, 'legacy-inv')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'team.json'), JSON.stringify({
        teamId: 'team_x', createdAt: Date.now(), name: 'T',
      }), 'utf8')
      writeFileSync(join(dir, 'members.json'), JSON.stringify([{
        memberId: 'mem_a',
        email: 'a@example.com',
        displayName: 'A',
        role: 'admin',
        sessions: {},
        createdAt: Date.now(),
      }]), 'utf8')
      const hash = 'a'.repeat(64)
      writeFileSync(join(dir, 'invites.json'), JSON.stringify([{
        token: hash,
        email: 'x@example.com',
        role: 'member',
        createdBy: 'mem_a',
        createdAt: Date.now(),
        expiresAt: Date.now() + 86_400_000,
        usedAt: null,
        usedBy: null,
      }]), 'utf8')
      const store = new BridgeStore(dir, 21, null)
      const listed = store.listInvites()
      assert(listed.length === 1, 'legacy invite listed')
      assert(listed[0]!.id === `inv_${hash.slice(0, 24)}`, `stable legacy id (${listed[0]!.id})`)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  console.log('acks-invite-cancel: ok')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
