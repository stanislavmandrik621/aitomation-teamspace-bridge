/**
 * TCC-R1132-TLS-001 / TCC-R1132-TLS-002 / TCC-R1132-TLS-003 - regression:
 * a stored hash (session or invite) must never work as the bearer
 * credential itself, and a corrupt/undecryptable invites.json must fail
 * closed instead of being treated as "zero invites".
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BridgeStore,
  hashSessionToken,
  hashInviteToken,
} from '../src/store.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-tls-hash-'))
  try {
    // --- TCC-R1132-TLS-001: disk session hash must not authenticate as bearer ---
    {
      const store = new BridgeStore(join(root, 'sess'), 21, null)
      const hello = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'dev1',
        memberEmail: 'a@example.com',
        displayName: 'Admin',
      })
      assert(hello.ok === true, 'first hello mints')
      if (!hello.ok) throw new Error('unreachable')
      const plain = hello.sessionToken
      const diskHash = hashSessionToken(plain)

      // Presenting the disk hash itself (as if stolen from members.json) must
      // NOT authenticate - only the real plaintext bearer token may.
      const hitWithHash = store.findBySession(diskHash)
      assert(hitWithHash === null, 'disk session hash must not authenticate as bearer')

      // The real plaintext token must still work, and must not have been
      // rewritten to hash-of-hash by a rejected raw-hash attempt.
      const hitWithPlain = store.findBySession(plain)
      assert(!!hitWithPlain && hitWithPlain.member.memberId === 'mem_admin', 'real bearer still authenticates after hash-as-bearer attempt')

      // hello-path (device re-auth) must apply the same rule.
      const helloWithHash = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'dev1',
        sessionToken: diskHash,
      })
      assert(helloWithHash.ok === false, 'hello device re-auth must not accept disk hash as bearer')
    }

    // --- TCC-R1132-TLS-002: disk invite hash must not redeem as a credential ---
    {
      const store = new BridgeStore(join(root, 'inv'), 21, null)
      store.helloOrBootstrap({
        memberId: 'mem_a', deviceId: 'd1', memberEmail: 'a@example.com',
      })
      const created = store.createInvite('mem_a', 'b@example.com', 'member')
      assert(created.ok === true, 'invite minted')
      if (!created.ok) throw new Error('unreachable')
      const plainToken = created.invite.token
      const diskHash = hashInviteToken(plainToken)
      const invitesRaw = readFileSync(join(root, 'inv', 'invites.json'), 'utf8')
      assert(invitesRaw.includes(diskHash), 'disk stores hash only')
      assert(!invitesRaw.includes(plainToken), 'plaintext token never on disk')

      // Presenting the disk hash itself (as if read straight out of
      // invites.json) must NOT redeem the invite.
      const redeemedWithHash = await store.redeemInvite({
        token: diskHash,
        deviceId: 'dev-attacker',
      })
      assert(redeemedWithHash.ok === false, 'disk invite hash must not redeem as a credential')

      // The real plaintext invite link must still redeem normally.
      const redeemedWithPlain = await store.redeemInvite({
        token: plainToken,
        deviceId: 'dev-real',
        displayName: 'Real Teammate',
      })
      assert(redeemedWithPlain.ok === true, 'real plaintext invite link still redeems')
    }

    // --- TCC-R1132-TLS-003: undecryptable invites.json fails closed (no wipe) ---
    {
      const dir = join(root, 'inv-corrupt')
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
      // Torn/corrupt invites.json (not valid JSON, not empty).
      const corruptRaw = '{not-json-and-not-an-array'
      writeFileSync(join(dir, 'invites.json'), corruptRaw, 'utf8')

      const store = new BridgeStore(dir, 21, null)
      assert(store.isInvitesStoreUnusable() === true, 'corrupt invites.json flagged unusable')

      // createInvite must refuse rather than silently minting into an
      // in-memory [] and persisting that empty array over the real file.
      const created = store.createInvite('mem_a', 'new@example.com', 'member')
      assert(created.ok === false, 'createInvite refuses while invites store is unusable')

      // cancelInvite must refuse too (same wipe class).
      const cancelled = store.cancelInvite('anything')
      assert(cancelled.ok === false, 'cancelInvite refuses while invites store is unusable')

      // The corrupt file must have been quarantined (renamed aside to
      // invites.json.corrupt.<tag>.<ts>) rather than silently replaced by a
      // fresh `[]` or `[{...new invite...}]`.
      let sawQuarantine = false
      const { readdirSync } = await import('node:fs')
      for (const f of readdirSync(dir)) {
        if (f.startsWith('invites.json.corrupt.')) sawQuarantine = true
      }
      assert(sawQuarantine, 'corrupt invites.json was quarantined, not silently replaced')
    }

    console.log('tls-hash-as-bearer: ok')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
