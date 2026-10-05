/**
 * Admin recovery key - locked-out sole Admin escape hatch.
 *
 * `helloOrBootstrap` mints a session only for the very first hello. After that a
 * hello needs a session token bound to the presenting device, and the only other
 * way in is an invite - which only an Admin can mint. So a solo self-hoster who
 * lost their session token was locked out of their own server forever with all
 * of their data still on the volume.
 *
 * This suite is the standalone-repo twin of the monorepo unit
 * `apps/desktop/tests/unit/bridge-admin-recovery.ts` (which additionally pins the
 * server.ts wiring). Both must stay green - this one is what runs in the public
 * team-server repo, where `apps/desktop` does not exist.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore, hashSessionToken } from '../src/store.js'
import {
  ADMIN_RECOVERY_ENV_VAR,
  ADMIN_RECOVERY_KEY_FILENAME,
  ADMIN_RECOVERY_KEY_MIN_LEN,
  ADMIN_RECOVERY_REFUSE_BAD_KEY,
  ADMIN_RECOVERY_REFUSE_NO_ADMIN,
  ADMIN_RECOVERY_REFUSE_UNAVAILABLE,
  adminRecoveryKeyMatches,
  generateAdminRecoveryKey,
  resetAdminRecoveryKeyCacheForTests,
  resolveAdminRecoveryKey,
} from '../src/admin-recovery.js'
import {
  ADMIN_RECOVERY_TOKENS_PER_WINDOW,
  ADMIN_RECOVERY_WINDOW_MS,
  HELLO_TOKENS_PER_WINDOW,
} from '../src/throughput.js'
import { TokenBucketLimiter } from '../src/rate-limit.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'ts-bridge-recovery-'))
  try {
    // --- no key presented: unchanged dead end, byte-identical refusal ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const store = new BridgeStore(join(root, 'unchanged'), 21)
      const first = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'old-laptop',
        memberEmail: 'owner@example.com',
      })
      assert(first.ok === true, 'first hello bootstraps admin')
      const refused = store.helloOrBootstrap({ memberId: 'mem_admin', deviceId: 'new-laptop' })
      assert(refused.ok === false, 'no session, no key -> refused')
      if (refused.ok) throw new Error('unreachable')
      assert(
        refused.reason === 'Session token required',
        `refusal reason must stay byte-identical (got: ${refused.reason})`,
      )
    }

    // --- wrong key refused, nothing bound; right key rebinds and works ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const dir = join(root, 'rebind')
      const store = new BridgeStore(dir, 21)
      store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'old-laptop',
        memberEmail: 'owner@example.com',
      })
      assert(!!store.adminRecovery, 'a recovery key is resolved for the data dir')
      const recoveryKey = store.adminRecovery!.secret

      const wrong = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'new-laptop',
        adminRecoveryKey: `${recoveryKey}-nope`,
      })
      assert(wrong.ok === false, 'wrong key refused')
      if (wrong.ok) throw new Error('unreachable')
      assert(wrong.reason === ADMIN_RECOVERY_REFUSE_BAD_KEY, 'distinct bad-key reason')
      assert(
        Object.keys(store.findMember('mem_admin')?.sessions ?? {}).length === 1,
        'a wrong key binds no device',
      )

      const recovered = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'new-laptop',
        adminRecoveryKey: recoveryKey,
      })
      assert(recovered.ok === true, 'right key rebinds admin')
      if (!recovered.ok) throw new Error('unreachable')
      assert(recovered.minted === true, 'recovery mints a session')
      assert(recovered.recoveredAdmin === true, 'flagged as a recovery')
      assert(recovered.member.role === 'admin', 'target is an admin')

      // Minted token authenticates, is stored hashed, and survives a restart.
      const reHello = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'new-laptop',
        sessionToken: recovered.sessionToken,
      })
      assert(reHello.ok === true, 'recovered session authenticates')
      const raw = readFileSync(join(dir, 'members.json'), 'utf8')
      assert(!raw.includes(recovered.sessionToken), 'recovered token never stored in plaintext')
      assert(raw.includes(hashSessionToken(recovered.sessionToken)), 'recovered token stored hashed')
      resetAdminRecoveryKeyCacheForTests()
      const reopened = new BridgeStore(dir, 21)
      assert(!!reopened.findBySession(recovered.sessionToken), 'rebind survives a restart')
      assert(
        Object.keys(reopened.findMember('mem_admin')?.sessions ?? {}).sort().join(',') ===
          'new-laptop,old-laptop',
        'recovery ADDS a device session and keeps the old one',
      )
    }

    // --- no escalation: a viewer presenting the key lands on the admin row ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const store = new BridgeStore(join(root, 'no-escalation'), 21)
      store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'old-laptop',
        memberEmail: 'owner@example.com',
      })
      const recoveryKey = store.adminRecovery!.secret
      const invite = store.createInvite('mem_admin', 'watcher@example.com', 'viewer')
      assert(invite.ok === true, 'viewer invite minted')
      if (!invite.ok) throw new Error('unreachable')
      const joined = await store.redeemInvite({
        token: invite.invite.token,
        deviceId: 'viewer-box',
        memberEmail: 'watcher@example.com',
      })
      assert(joined.ok === true, 'viewer joined')
      if (!joined.ok) throw new Error('unreachable')
      const viewerId = joined.member.memberId
      assert(store.findMember(viewerId)?.role === 'viewer', 'fixture: viewer role')

      const attempt = store.helloOrBootstrap({
        memberId: viewerId,
        deviceId: 'viewer-second-box',
        adminRecoveryKey: recoveryKey,
      })
      assert(attempt.ok === true, 'key authorizes recovery of the admin account')
      if (!attempt.ok) throw new Error('unreachable')
      assert(
        attempt.member.memberId === 'mem_admin',
        'recovery falls back to the earliest admin, never promotes the presenting viewer',
      )
      const viewerAfter = store.findMember(viewerId)
      assert(viewerAfter?.role === 'viewer', 'viewer was NOT promoted')
      assert(
        Object.keys(viewerAfter?.sessions ?? {}).join(',') === 'viewer-box',
        'no session bound onto the viewer row',
      )

      // Teammate rows and their sessions are untouched by recovery.
      assert(joined.sessionToken.length > 0, 'viewer holds its own session token')
      const viewerStillWorks = store.helloOrBootstrap({
        memberId: viewerId,
        deviceId: 'viewer-box',
        sessionToken: joined.sessionToken,
      })
      assert(viewerStillWorks.ok === true, 'viewer session still authenticates after recovery')
    }

    // --- TS-BRG-013: torn members.json still refuses, key or no key ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const dir = join(root, 'torn')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'members.json'), '{not-json', 'utf8')
      const store = new BridgeStore(dir, 21)
      assert(store.isMembersStoreUnusable() === true, 'torn roster flagged')
      const refused = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'new-laptop',
        adminRecoveryKey: store.adminRecovery!.secret,
      })
      assert(refused.ok === false, 'recovery must not weaken the torn-roster guard')
      if (refused.ok) throw new Error('unreachable')
      assert(
        refused.reason === store.membersStoreError(),
        'torn-roster reason wins over any recovery reason',
      )
    }

    // --- roster with no admin -> honest refusal, never a promotion ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const dir = join(root, 'no-admin')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'members.json'),
        JSON.stringify([
          {
            memberId: 'mem_member',
            email: 'm@example.com',
            displayName: 'M',
            role: 'member',
            sessions: {},
            createdAt: Date.now(),
          },
        ]),
        'utf8',
      )
      const store = new BridgeStore(dir, 21)
      const refused = store.helloOrBootstrap({
        memberId: 'mem_member',
        deviceId: 'box',
        adminRecoveryKey: store.adminRecovery!.secret,
      })
      assert(refused.ok === false, 'no admin row -> refuse')
      if (refused.ok) throw new Error('unreachable')
      assert(refused.reason === ADMIN_RECOVERY_REFUSE_NO_ADMIN, 'distinct no-admin reason')
      assert(store.findMember('mem_member')?.role === 'member', 'nobody was promoted')
    }

    // --- recovery explicitly disabled -> honest refusal ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const store = new BridgeStore(join(root, 'disabled'), 21, null, null)
      assert(store.adminRecovery === null, 'recovery disabled')
      store.helloOrBootstrap({ memberId: 'mem_admin', deviceId: 'box-1', memberEmail: 'a@b.c' })
      const refused = store.helloOrBootstrap({
        memberId: 'mem_admin',
        deviceId: 'box-2',
        adminRecoveryKey: generateAdminRecoveryKey(),
      })
      assert(refused.ok === false, 'no server key -> refuse')
      if (refused.ok) throw new Error('unreachable')
      assert(refused.reason === ADMIN_RECOVERY_REFUSE_UNAVAILABLE, 'distinct unavailable reason')
    }

    // --- secret resolution: durable, 0600, env wins, weak values fail loud ---
    {
      resetAdminRecoveryKeyCacheForTests()
      const dir = join(root, 'resolve')
      const first = resolveAdminRecoveryKey(dir, {})
      assert(first.source === 'generated', 'first resolve generates')
      assert(first.path === join(dir, ADMIN_RECOVERY_KEY_FILENAME), 'key file in the data dir')
      assert(first.secret.length >= ADMIN_RECOVERY_KEY_MIN_LEN, 'generated key long enough')
      if (process.platform !== 'win32') {
        assert((statSync(first.path!).mode & 0o777) === 0o600, 'key file is 0600')
      }
      resetAdminRecoveryKeyCacheForTests()
      const again = resolveAdminRecoveryKey(dir, {})
      assert(again.source === 'file', 'later boot reads the persisted file')
      assert(again.secret === first.secret, 'key survives a container restart')

      resetAdminRecoveryKeyCacheForTests()
      const strong = 'operator-chosen-recovery-passphrase'
      const fromEnv = resolveAdminRecoveryKey(dir, { [ADMIN_RECOVERY_ENV_VAR]: strong })
      assert(fromEnv.source === 'env' && fromEnv.secret === strong, 'env wins over the file')

      let threw = false
      try {
        resolveAdminRecoveryKey(dir, { [ADMIN_RECOVERY_ENV_VAR]: 'short' })
      } catch {
        threw = true
      }
      assert(threw, 'a too-short operator key fails loud')
    }

    // --- constant-time compare: unequal lengths handled, no throw ---
    {
      const secret = generateAdminRecoveryKey()
      const key = { secret, source: 'generated' as const, path: null, warnings: [] }
      assert(adminRecoveryKeyMatches(key, secret) === true, 'exact match accepted')
      assert(adminRecoveryKeyMatches(key, `${secret}x`) === false, 'longer rejected')
      assert(adminRecoveryKeyMatches(key, secret.slice(0, -1)) === false, 'shorter rejected')
      assert(adminRecoveryKeyMatches(key, '') === false, 'empty rejected')
      // Whitespace can never be part of a real key (every resolve path trims),
      // so a paste that picked up a space or newline must still match.
      assert(adminRecoveryKeyMatches(key, `  ${secret}\n`) === true, 'padded paste accepted')
      assert(adminRecoveryKeyMatches(key, 'x'.repeat(9_000)) === false, 'oversized rejected')
      assert(adminRecoveryKeyMatches(null, secret) === false, 'no server key never matches')
    }

    // --- strict per-IP budget: hard lockout, own namespace, per-IP ---
    {
      assert(
        ADMIN_RECOVERY_TOKENS_PER_WINDOW < HELLO_TOKENS_PER_WINDOW,
        'recovery budget stricter than hello',
      )
      assert(ADMIN_RECOVERY_WINDOW_MS >= 60_000, 'lockout window is minutes, not seconds')
      const limiter = new TokenBucketLimiter()
      let allowed = 0
      for (let i = 0; i < ADMIN_RECOVERY_TOKENS_PER_WINDOW + 5; i++) {
        if (
          limiter.take(
            'adminrecovery:203.0.113.7',
            ADMIN_RECOVERY_TOKENS_PER_WINDOW,
            ADMIN_RECOVERY_WINDOW_MS,
          )
        ) {
          allowed++
        }
      }
      assert(allowed === ADMIN_RECOVERY_TOKENS_PER_WINDOW, 'exactly the budget, then locked out')
      assert(
        limiter.take(
          'adminrecovery:198.51.100.9',
          ADMIN_RECOVERY_TOKENS_PER_WINDOW,
          ADMIN_RECOVERY_WINDOW_MS,
        ) === true,
        'a different IP keeps its own budget',
      )
    }

    console.log('admin-recovery: ok')
  } finally {
    try {
      rmSync(root, { recursive: true, force: true })
    } catch {
      /* */
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
