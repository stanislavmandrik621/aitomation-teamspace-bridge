/**
 * TCC-R1132-CMPY-002 - compose-share/register must refuse a null/missing/
 * malformed password_hash. Client share LINKS are always password-gated by
 * product policy; the bridge is the guest-facing unlock authority so it must
 * enforce this itself instead of trusting the caller.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
import { GUEST_STORE_SHARE_TEAM_MISMATCH } from '../src/portal-store.js'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'

function must(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function hashPasswordForTest(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 })
  return `s$${salt.toString('hex')}$${hash.toString('hex')}`
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'ts-compose-share-'))
  try {
    const store = new ComposeShareBridgeStore(root, null)
      const packBytes = Buffer.from('fake-pdf-bytes')
      const plainToken = 'token-plain-1234'
      const tokenHash = hashComposeShareToken(plainToken)

    // --- null password_hash refused (TCC-R1132-CMPY-002 core bug) ---
    {
      const res = store.upsertShare('mem_admin', {
        tokenHash,
        localShareId: 'share_1',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: null,
        expiresAt: null,
        packBytes,
      })
      must(res.ok === false, 'null password_hash refused')
      if (res.ok) throw new Error('unreachable')
      must(/password_hash/.test(res.error), 'error mentions password_hash')
    }

    // --- empty-string password_hash refused ---
    {
      const res = store.upsertShare('mem_admin', {
        tokenHash,
        localShareId: 'share_2',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: '' as unknown as string,
        expiresAt: null,
        packBytes,
      })
      must(res.ok === false, 'empty password_hash refused')
    }

    // --- malformed password_hash refused ---
    {
      const res = store.upsertShare('mem_admin', {
        tokenHash,
        localShareId: 'share_3',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: 'not-a-real-hash',
        expiresAt: null,
        packBytes,
      })
      must(res.ok === false, 'malformed password_hash refused')
    }

    // --- valid password_hash accepted; guest cannot unlock without it ---
    {
      const validHash = hashPasswordForTest('correct horse battery staple')
      const res = store.upsertShare('mem_admin', {
        tokenHash,
        localShareId: 'share_4',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: validHash,
        expiresAt: null,
        packBytes,
      })
      must(res.ok === true, 'valid password_hash accepted')
      if (!res.ok) throw new Error('unreachable')
      must(res.row.passwordHash === validHash, 'stored hash round-trips')

      const resolved = store.resolveGuest(plainToken)
      must(resolved.active === true, 'share resolves active')
      must(!!resolved.row?.passwordHash, 'guest-facing row still requires a password (never null)')
    }

    // TCC-FIX-SHARE-013: named vs named refuse; blank leftover still admits
    {
      const validHash = hashPasswordForTest('compose team isolation')
      const tokenA = 'token-team-a-aaaa'
      const hashA = hashComposeShareToken(tokenA)
      const upA = store.upsertShare('mem_admin', {
        tokenHash: hashA,
        localShareId: 'share_iso',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: validHash,
        expiresAt: null,
        packBytes,
        teamId: 'team-a',
      })
      must(upA.ok === true, 'named team-a upsert ok')
      const steal = store.upsertShare('mem_other', {
        tokenHash: hashComposeShareToken('token-team-b-bbbb'),
        localShareId: 'share_iso',
        format: 'pdf',
        watermark: 'off',
        filename: 'stolen.pdf',
        passwordHash: validHash,
        expiresAt: null,
        packBytes,
        team_id: 'team-b',
      })
      must(steal.ok === false, 'named team-b cannot overwrite team-a localShareId')
      if (!steal.ok) must(steal.error === GUEST_STORE_SHARE_TEAM_MISMATCH, 'mismatch copy')
      const badRevoke = store.revokeShare({ localShareId: 'share_iso', team_id: 'team-b' })
      must(badRevoke.ok === false, 'named team-b cannot revoke team-a')
      if (!badRevoke.ok) must(badRevoke.error === GUEST_STORE_SHARE_TEAM_MISMATCH, 'revoke mismatch copy')
      const blankAdmit = store.revokeShare({ localShareId: 'share_iso' })
      must(blankAdmit.ok === true, 'blank leftover caller still admits a named row')
    }

    {
      const validHash = hashPasswordForTest('nul cut scope')
      const up = store.upsertShare('mem_admin\0other', {
        tokenHash: hashComposeShareToken('token-nul-scope-xxxx'),
        localShareId: 'share_nul\0junk',
        format: 'pdf',
        watermark: 'off',
        filename: 'pack.pdf',
        passwordHash: validHash,
        expiresAt: null,
        packBytes,
        teamId: 'team-a\0junk',
      })
      must(up.ok === true, 'compose scope/team NUL leftover cuts')
      if (!up.ok) throw new Error('unreachable')
      must(up.row.localShareId === 'share_nul', 'localShareId NUL-cut')
      must(up.row.ownerMemberId === 'mem_admin', 'ownerMemberId NUL-cut')
      must(up.row.teamId === 'team-a', 'teamId NUL-cut')
    }

    {
      const unreadRoot = mkdtempSync(join(tmpdir(), 'ts-compose-share-unread-'))
      try {
        writeFileSync(join(unreadRoot, 'compose-shares.json'), '{"shares":{"not":"array"}}', 'utf8')
        const unread = new ComposeShareBridgeStore(unreadRoot, null)
        const res = unread.upsertShare('mem_admin', {
          tokenHash: hashComposeShareToken('token-unread-yyyy'),
          localShareId: 'share_unread',
          format: 'pdf',
          watermark: 'off',
          filename: 'pack.pdf',
          passwordHash: hashPasswordForTest('unread'),
          expiresAt: null,
          packBytes,
        })
        must(res.ok === false, 'unreadable compose registry must refuse')
        if (!res.ok) must(res.error === 'Share registry unreadable', 'refuse copy')
        must(
          readFileSync(join(unreadRoot, 'compose-shares.json'), 'utf8') === '{"shares":{"not":"array"}}',
          'unreadable compose-shares.json must not be wiped',
        )
        must(unread.resolveGuest('token-unread-yyyy').reason === 'unreadable', 'guest resolve unreadable')
      } finally {
        try { rmSync(unreadRoot, { recursive: true, force: true }) } catch { /* */ }
      }
    }

    console.log('compose-share-password: ok')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

main()
