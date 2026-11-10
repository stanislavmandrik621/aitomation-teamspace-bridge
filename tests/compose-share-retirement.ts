/** Actual registry/packs and durable negative-token history across races and restore. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'

for (const atRest of [null, { key: Buffer.alloc(32, 7) }]) {
 const dir = mkdtempSync(join(tmpdir(), 'compose-retirement-'))
 try {
  let store = new ComposeShareBridgeStore(dir, atRest)
  const args = (token: string, localShareId = 'share', teamId = 'a') => ({ tokenHash: hashComposeShareToken(token), localShareId, teamId, format: 'pdf', watermark: 'off', filename: 'pack.pdf', passwordHash: `s$${'11'.repeat(16)}$${'22'.repeat(32)}`, expiresAt: null, packBytes: Buffer.from('private pack') })
  assert.deepEqual(store.revokeShare({ tokenHash: hashComposeShareToken('pending-token'), localShareId: 'pending', teamId: 'a' }), { ok: true })
  assert.equal(store.upsertShare('owner', args('pending-token', 'pending')).ok, false, 'revoke overtaking first register cannot resurrect URL')
  assert.equal(store.upsertShare('owner', args('original-token')).ok, true)
  const savedRegistry = readFileSync(join(dir, 'compose-shares.json'))
  const savedPack = readFileSync(join(dir, 'compose-share-payloads', `${hashComposeShareToken('original-token')}.bin`))
  assert.equal(store.upsertShare('owner', args('replacement-token')).ok, true)
  assert.equal(store.resolveGuest('replacement-token').active, true)
  assert.equal(store.resolveGuest('original-token').active, false)
  assert.equal(store.readPackBytes(hashComposeShareToken('original-token')), null)
  assert.equal(store.revokeShare({ tokenHash: hashComposeShareToken('original-token'), localShareId: 'share', teamId: 'a' }).ok, true)
  assert.equal(store.resolveGuest('replacement-token').active, true, 'late old-token revoke cannot revoke replacement')
  assert.equal(store.revokeShare({ tokenHash: hashComposeShareToken('replacement-token'), localShareId: 'share', teamId: 'b' }).ok, false)
  assert.equal(store.resolveGuest('replacement-token').active, true, 'wrong team cannot retire active token')
  assert.equal(store.revokeShare({ tokenHash: hashComposeShareToken('replacement-token'), localShareId: 'share', teamId: 'a' }).ok, true)
  store = new ComposeShareBridgeStore(dir, atRest)
  assert.equal(store.upsertShare('owner', args('replacement-token')).ok, false, 'retired token stays retired after restart')
  // Old backup copies can restore a live-looking registry/pack. The separate
  // retirement record remains authoritative and blocks reads and republish.
  writeFileSync(join(dir, 'compose-shares.json'), savedRegistry)
  writeFileSync(join(dir, 'compose-share-payloads', `${hashComposeShareToken('original-token')}.bin`), savedPack)
  store = new ComposeShareBridgeStore(dir, atRest)
  assert.equal(store.resolveGuest('original-token').active, false)
  assert.equal(store.readPackBytes(hashComposeShareToken('original-token')), null)
  assert.equal(store.upsertShare('owner', args('original-token')).ok, false)
  // Corrupt negative history fails closed; it never becomes "not retired".
  const retired = hashComposeShareToken('original-token')
  writeFileSync(join(dir, 'compose-share-retired-tokens', retired.slice(0,2), `${retired}.json`), '{broken')
  assert.equal(store.resolveGuest('original-token').reason, 'unreadable')
  assert.equal(store.upsertShare('owner', args('original-token')).ok, false)
 } finally { rmSync(dir, { recursive: true, force: true }) }
}
console.log('compose retirement: revoke-before-register, rotation, late revoke, team isolation, restart, registry/pack restore and corrupt retirement history passed in plaintext and encrypted stores')
