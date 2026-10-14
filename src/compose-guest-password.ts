import { createHmac, randomBytes } from 'node:crypto'
import { verifyPublicSharePassword } from './public-share-store.js'

/** Bounded successful-proof cache: no plaintext credentials; still resolve the live link on every request. */
export function createComposeGuestPasswordVerifier(verify = verifyPublicSharePassword, now = Date.now) {
  const secret = randomBytes(32)
  const proofs = new Map<string, number>()
  return (tokenHash: string, passwordHash: string, attempt: string): boolean => {
    const key = createHmac('sha256', secret).update(JSON.stringify([tokenHash, passwordHash, attempt])).digest('hex')
    const time = now(), expiry = proofs.get(key)
    if (expiry && expiry > time) return true
    proofs.delete(key)
    if (!verify(passwordHash, attempt)) return false
    for (const [id, expires] of proofs) if (expires <= time) proofs.delete(id)
    while (proofs.size >= 2048) proofs.delete(proofs.keys().next().value!)
    proofs.set(key, time + 60_000)
    return true
  }
}
