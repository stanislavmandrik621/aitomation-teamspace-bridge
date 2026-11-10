import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComposeReviewSessions, reviewAuthor } from '../src/compose-review-identities.js'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'
const dir = mkdtempSync(join(tmpdir(), 'review-identities-'))
try {
  let time = 1000, memberAllowed = true
  const sessions = new ComposeReviewSessions(() => time, () => memberAllowed)
  let store = new ComposeShareBridgeStore(dir, null)
  const hash = `s$${'11'.repeat(16)}$${'22'.repeat(32)}`
  const r = store.upsertShare('owner', { tokenHash: hashComposeShareToken('test-review-identity'), localShareId: 'share-review-identity', format: 'png', filename: 'Board.png', watermark: 'off', passwordHash: hash, expiresAt: null, packBytes: Buffer.from('image'), allowComments: true, documentId: 'board' }); assert.ok(r.ok)
  let row = r.row
  const animal = sessions.issue(row, ''), guest = sessions.issue(row, 'Designer')
  assert.match(animal.viewer.name, /^\w+ \w+ \d{4}$/); assert.equal(guest.viewer.name, 'Designer'); assert.equal(guest.viewer.kind, 'guest')
  assert.equal(sessions.identify(row, animal.viewerToken)?.id, animal.viewer.id)
  assert.equal(sessions.identify({ ...row, tokenHash: hashComposeShareToken('foreign') }, animal.viewerToken), null)
  assert.equal(sessions.pulse(row, guest.viewerToken, 2).length, 2)
  time += 46_000; assert.equal(sessions.pulse(row, guest.viewerToken, 2).length, 1)
  const named = store.configureReview(row, { expectedRevision: 0, mode: 'named', grant: { name: 'Client Alex', passwordHash: hash } })
  assert.equal(named.grants.length, 1); assert.equal('passwordHash' in named.grants[0]!, false)
  row = store.publication(row.localShareId)!; assert.equal(sessions.identify(row, animal.viewerToken), null)
  const grant = row.reviewAccess!.grants[0]!, alex = sessions.issue(row, 'Fake name', grant)
  assert.equal(alex.viewer.name, 'Client Alex'); assert.equal(alex.viewer.kind, 'named')
  const alexTab2 = sessions.issue(row, '', grant); assert.equal(alexTab2.viewer.id, alex.viewer.id); assert.equal(sessions.pulse(row, alex.viewerToken, 1).length, 1)
  const root = store.addComment(row, { name: 'Spoofed', text: 'Move the heading', requestId: 'request_comment_root', author: alex.viewer, anchor: { page: 1, x: .1, y: .2, width: .3, height: .1 } }); assert.equal(root.name, 'Client Alex')
  const editor = reviewAuthor('member_one', 'Editor', 'member'), reply = store.addComment(row, { name: 'n', text: 'How far?', requestId: 'request_comment_reply', author: editor, parentId: root.id })
  const subreply = store.addComment(row, { name: 'n', text: 'Ten pixels', requestId: 'request_comment_nested', author: alex.viewer, parentId: reply.id })
  assert.equal(subreply.rootId, root.id); assert.equal(subreply.parentId, reply.id)
  assert.throws(() => store.addComment(row, { name: 'n', text: 'No', requestId: 'request_comment_wrong', author: editor, parentId: 'not-found' }))
  assert.throws(() => store.resolveComment(row, root.id, true, guest.viewer, false))
  store.resolveComment(row, root.id, true, alex.viewer, false)
  assert.throws(() => store.addComment(row, { name: 'n', text: 'Closed', requestId: 'request_comment_closed', author: editor, parentId: reply.id }))
  store.resolveComment(row, root.id, false, editor, true)
  assert.throws(() => store.configureReview(row, { expectedRevision: 0, mode: 'shared' }))
  store.configureReview(row, { expectedRevision: 1, revokeId: grant.id }); row = store.publication(row.localShareId)!; assert.equal(sessions.identify(row, alex.viewerToken), null)
  store = new ComposeShareBridgeStore(dir, null); assert.equal(store.publication(row.localShareId)!.reviewAccess!.grants[0]!.revoked, true); assert.equal(store.comments(row).comments[2]!.parentId, reply.id)
  const member = sessions.issue(row, '', undefined, editor); assert.equal(sessions.identify(row, member.viewerToken)?.kind, 'member'); memberAllowed = false; assert.equal(sessions.identify(row, member.viewerToken), null)
  time += 9 * 3600000; assert.equal(sessions.identify(r.row, guest.viewerToken), null)
  console.log('Review identities: anonymous aliases, stable named identity, expiry, presence TTL/dedup, credential revocation, current member access, threads, resolve permissions and persistence passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
