/**
 * TCC-R1132-CMPY-002 - compose-share/register must refuse a null/missing/
 * malformed password_hash. Client share LINKS are always password-gated by
 * product policy; the bridge is the guest-facing unlock authority so it must
 * enforce this itself instead of trusting the caller.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes, scryptSync } from 'node:crypto'
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

    console.log('compose-share-password: ok')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

main()
