import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import {
  COMPOSE_ACL_MAX_IDS,
  COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT,
  bootstrapComposeAclDocuments,
  composeAclStoreStatus,
  configureComposeAclStore,
  isComposeDocSharedWithMember,
  isComposeDocSharedWithTeam,
  removeComposeAclMembers,
  resetComposeAclStoreForTests,
  mutateComposeAclDocument,
  setComposeAclDocuments,
  setComposeAclSharedDocIds,
} from '../src/compose-acl-store.js'

const server = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.ts'),
  'utf8',
)

function caseWindow(type: string, nextType: string): string {
  const start = server.indexOf(`case '${type}':`)
  const end = server.indexOf(`case '${nextType}':`, start)
  assert.ok(start >= 0 && end > start, `${type} case window exists`)
  return server.slice(start, end)
}

describe('Compose live-room ACL replacement', () => {
  it('migrates the legacy whole-team allowlist and fails closed for absent ids', () => {
    resetComposeAclStoreForTests()
    assert.deepEqual(
      setComposeAclSharedDocIds(['board-a', 'board-b']),
      { ok: true, count: 2 },
    )
    assert.equal(isComposeDocSharedWithTeam('board-a'), true)
    assert.equal(isComposeDocSharedWithMember('board-a', 'mem-any'), true)
    assert.equal(isComposeDocSharedWithTeam('board-b'), true)
    assert.deepEqual(setComposeAclSharedDocIds(['board-b']), { ok: true, count: 1 })
    assert.equal(isComposeDocSharedWithTeam('board-a'), false)
    assert.equal(isComposeDocSharedWithMember('board-a', 'mem-any'), false)
    assert.equal(isComposeDocSharedWithTeam('board-b'), true)
    assert.deepEqual(setComposeAclSharedDocIds('board-b'), {
      ok: false,
      reason: 'documentIds must be an array',
    })
    assert.equal(isComposeDocSharedWithTeam('board-b'), true, 'invalid replacement preserves the last valid ACL')
    resetComposeAclStoreForTests()
  })

  it('enforces exact per-document member audiences including an empty audience', () => {
    resetComposeAclStoreForTests()
    assert.deepEqual(setComposeAclDocuments([
      { documentId: 'board-team', memberIds: null },
      { documentId: 'board-scoped', memberIds: ['mem-a', 'mem-b'] },
      { documentId: 'board-admin-only', memberIds: [] },
    ]), { ok: true, count: 3 })

    assert.equal(isComposeDocSharedWithTeam('board-team'), true)
    assert.equal(isComposeDocSharedWithMember('board-team', 'mem-outside'), true)
    assert.equal(isComposeDocSharedWithTeam('board-scoped'), false)
    assert.equal(isComposeDocSharedWithMember('board-scoped', 'mem-a'), true)
    assert.equal(isComposeDocSharedWithMember('board-scoped', 'mem-outside'), false)
    assert.equal(isComposeDocSharedWithMember('board-admin-only', 'mem-a'), false)
    resetComposeAclStoreForTests()
  })

  it('rejects malformed, duplicate, and over-cap snapshots atomically', () => {
    resetComposeAclStoreForTests()
    assert.deepEqual(
      setComposeAclDocuments([{ documentId: 'known-good', memberIds: ['mem-a'] }]),
      { ok: true, count: 1 },
    )

    const invalidSnapshots: unknown[] = [
      [{ documentId: 'dupe', memberIds: null }, { documentId: 'dupe', memberIds: [] }],
      [{ documentId: 'board', memberIds: ['mem-a', 'mem-a'] }],
      [{ documentId: 'board' }],
      [{ documentId: 'board', memberIds: ['bad\0member'] }],
      Array.from({ length: COMPOSE_ACL_MAX_IDS + 1 }, (_, i) => ({
        documentId: `board-${i}`,
        memberIds: null,
      })),
      [{
        documentId: 'board',
        memberIds: Array.from(
          { length: COMPOSE_ACL_MAX_MEMBERS_PER_DOCUMENT + 1 },
          (_, i) => `mem-${i}`,
        ),
      }],
    ]
    for (const snapshot of invalidSnapshots) {
      assert.equal(setComposeAclDocuments(snapshot).ok, false)
      assert.equal(
        isComposeDocSharedWithMember('known-good', 'mem-a'),
        true,
        'an invalid replacement cannot partially mutate the current ACL',
      )
    }
    assert.equal(setComposeAclSharedDocIds(['dupe', 'dupe']).ok, false)
    assert.equal(isComposeDocSharedWithMember('known-good', 'mem-a'), true)
    resetComposeAclStoreForTests()
  })

  it('evicts active non-Admin Compose peers before acknowledging a replacement', () => {
    const routeStart = server.indexOf("path === '/v1/teamspace/compose-acl'")
    const routeEnd = server.indexOf('// --- Compose guest share link ---', routeStart)
    assert.ok(routeStart >= 0 && routeEnd > routeStart)
    const route = server.slice(routeStart, routeEnd)
    const mutationAt = route.indexOf('mutateComposeAclDocument(body.mutation)')
    const scopedBootstrapAt = route.indexOf('bootstrapComposeAclDocuments(body.documents)')
    const legacyBootstrapAt = route.indexOf('bootstrapComposeAclSharedDocIds(body.documentIds)')
    const evictAt = route.indexOf('evictUnsharedComposeYjsPeers()')
    const replyAt = route.indexOf('sendJson(res, 200')
    assert.ok(mutationAt >= 0 && scopedBootstrapAt > mutationAt && legacyBootstrapAt > scopedBootstrapAt)
    assert.ok(evictAt > legacyBootstrapAt && replyAt > evictAt)

    const helperStart = server.indexOf('function evictUnsharedComposeYjsPeers()')
    const helperEnd = server.indexOf('/**\n * Temporary chat', helperStart)
    assert.ok(helperStart >= 0 && helperEnd > helperStart)
    const helper = server.slice(helperStart, helperEnd)
    assert.match(helper, /peerYjsRoomStillAuthorized\(peerSession, parsed\.recordId, parsed\.contentField\)/)
    assert.match(helper, /leaveYjsRoom\(peer, room\)/)
    assert.match(helper, /frameId: 'compose-acl-revoked'/)
  })

  it('persists exact mutations and ignores a stale reconnect bootstrap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-acl-durable-'))
    try {
      configureComposeAclStore(dir)
      assert.equal(composeAclStoreStatus().bootstrapped, false)
      assert.equal(bootstrapComposeAclDocuments([
        { documentId: 'board-a', memberIds: null },
        { documentId: 'board-b', memberIds: ['mem-b'] },
      ]).ok, true)
      assert.equal(mutateComposeAclDocument({
        documentId: 'board-a',
        memberIds: ['mem-a'],
      }).ok, true)
      assert.equal(mutateComposeAclDocument({ documentId: 'board-b', remove: true }).ok, true)

      // Simulate a bridge restart, then a stale Admin reconnecting with the
      // original broader snapshot. Durable per-doc state must win.
      configureComposeAclStore(dir)
      assert.equal(isComposeDocSharedWithMember('board-a', 'mem-a'), true)
      assert.equal(isComposeDocSharedWithMember('board-a', 'mem-outside'), false)
      assert.equal(isComposeDocSharedWithMember('board-b', 'mem-b'), false)
      const stale = bootstrapComposeAclDocuments([
        { documentId: 'board-a', memberIds: null },
        { documentId: 'board-b', memberIds: ['mem-b'] },
      ])
      assert.equal(stale.ok, true)
      assert.equal(stale.ok && stale.changed, false)
      assert.equal(isComposeDocSharedWithMember('board-a', 'mem-outside'), false)
      assert.equal(isComposeDocSharedWithMember('board-b', 'mem-b'), false)
    } finally {
      resetComposeAclStoreForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('durably removes kicked members from every exact audience without widening empty audiences', () => {
    const dir = mkdtempSync(join(tmpdir(), 'compose-acl-member-revoke-'))
    try {
      configureComposeAclStore(dir)
      assert.equal(bootstrapComposeAclDocuments([
        { documentId: 'board-team', memberIds: null },
        { documentId: 'board-two', memberIds: ['mem-leaving', 'mem-staying'] },
        { documentId: 'board-last', memberIds: ['mem-leaving'] },
        { documentId: 'board-empty', memberIds: [] },
      ]).ok, true)

      const removed = removeComposeAclMembers(['mem-leaving'])
      assert.equal(removed.ok, true)
      assert.equal(removed.ok && removed.changed, true)
      assert.equal(removed.ok && removed.changedDocuments, 2)
      assert.equal(isComposeDocSharedWithMember('board-two', 'mem-leaving'), false)
      assert.equal(isComposeDocSharedWithMember('board-two', 'mem-staying'), true)
      assert.equal(isComposeDocSharedWithMember('board-last', 'mem-leaving'), false)
      assert.equal(isComposeDocSharedWithMember('board-last', 'mem-any'), false)
      assert.equal(isComposeDocSharedWithMember('board-empty', 'mem-any'), false)
      assert.equal(isComposeDocSharedWithMember('board-team', 'mem-any'), true)

      // A bridge restart must retain the exact empty audience produced by
      // removing its last member; absence/delete and whole-team are distinct.
      configureComposeAclStore(dir)
      assert.equal(isComposeDocSharedWithMember('board-two', 'mem-staying'), true)
      assert.equal(isComposeDocSharedWithMember('board-two', 'mem-leaving'), false)
      assert.equal(isComposeDocSharedWithTeam('board-last'), false)
      assert.equal(isComposeDocSharedWithMember('board-last', 'mem-any'), false)
      assert.equal(isComposeDocSharedWithMember('board-team', 'mem-any'), true)
      const again = removeComposeAclMembers(['mem-leaving'])
      assert.equal(again.ok, true)
      assert.equal(again.ok && again.changed, false)
      assert.equal(again.ok && again.changedDocuments, 0)
    } finally {
      resetComposeAclStoreForTests()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs canonical Compose member cleanup after roster commit and before kick/leave replies', () => {
    assert.match(server, /removeComposeAclMembers,/)
    for (const [type, nextType, rosterMutation] of [
      ['kick_member', 'kick_members', 'store.kickMember'],
      ['kick_members', 'leave_team', 'store.kickMembers'],
      ['leave_team', 'list_members', 'store.leaveTeam'],
    ] as const) {
      const code = caseWindow(type, nextType)
      const rosterAt = code.indexOf(rosterMutation)
      const cleanupAt = code.indexOf('removeMembersFromComposeAuthority(')
      const replyAt = code.indexOf('reply(ws, {', cleanupAt)
      assert.ok(rosterAt >= 0, `${type} mutates the roster`)
      assert.ok(cleanupAt > rosterAt, `${type} cleans Compose ACL after a successful roster mutation`)
      assert.ok(replyAt > cleanupAt, `${type} reports cleanup failures instead of replying early`)
      assert.match(code, /contentAclCleanupFailed/)
    }
    const wrapper = server.slice(server.indexOf('function removeMembersFromComposeAuthority('), server.indexOf('function handleOps('))
    assert.match(wrapper, /removeComposeAclMembers\(memberIds\)/)
    assert.match(wrapper, /syncComposeContentAccess\(store\)/)
  })

  it('keys peer authorization to the live session member identity', () => {
    const helperStart = server.indexOf('function peerYjsRoomStillAuthorized(')
    const helperEnd = server.indexOf('/**\n * Re-check Compose authorization', helperStart)
    assert.ok(helperStart >= 0 && helperEnd > helperStart)
    const helper = server.slice(helperStart, helperEnd)
    assert.match(helper, /session\.role === 'admin'/)
    assert.match(helper, /isComposeDocSharedWithMember\(contentField, session\.memberId\)/)
  })

  it('re-checks current Compose access on content and awareness relays', () => {
    const update = caseWindow('yjs_update', 'yjs_awareness')
    const awareness = caseWindow('yjs_awareness', 'presence_edit')
    for (const code of [update, awareness]) {
      const parseAt = code.indexOf('parseYjsRoomId(frame.room)')
      const aclAt = code.indexOf('composeYjsAccessRefusal(')
      const leaveAt = code.indexOf('leaveYjsRoom(ws, parsed.room)')
      const fanoutAt = code.indexOf('fanoutYjs')
      assert.ok(parseAt >= 0 && aclAt > parseAt, 'ACL is evaluated after the canonical room parse')
      assert.ok(leaveAt > aclAt, 'stale membership is removed on refusal')
      assert.ok(fanoutAt > leaveAt, 'refusal runs before relay fanout')
    }
  })
})
