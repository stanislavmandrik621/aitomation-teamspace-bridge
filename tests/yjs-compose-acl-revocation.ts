import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import ts from 'typescript'
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

function findNodes<T extends ts.Node>(node: ts.Node, matches: (node: ts.Node) => node is T): T[] {
  const found: T[] = []
  const visit = (child: ts.Node): void => {
    if (matches(child)) found.push(child)
    ts.forEachChild(child, visit)
  }
  visit(node)
  return found
}

function oneCall(scope: ts.Node, name: string): ts.CallExpression {
  const matches = findNodes(scope, ts.isCallExpression)
    .filter(call => ts.isIdentifier(call.expression) && call.expression.text === name)
  assert.equal(matches.length, 1, `one ${name} call in its owning branch`)
  return matches[0]!
}

function assertActorBoundAclRoute(src: string): void {
  const parsed = ts.createSourceFile('server.ts', src, ts.ScriptTarget.Latest, true)
  const routes = findNodes(parsed, ts.isIfStatement).filter(statement =>
    findNodes(statement.expression, ts.isStringLiteral).some(literal => literal.text === '/v1/teamspace/compose-acl'))
  assert.equal(routes.length, 1)
  const route = routes[0]!.thenStatement
  const mutation = oneCall(route, 'mutateComposeAclDocument')
  assert.equal(mutation.arguments.length, 2, 'mutation receives its authenticated actor')
  assert.equal(mutation.arguments[0]!.getText(parsed), 'body.mutation')
  const actor = mutation.arguments[1]!
  assert.ok(ts.isObjectLiteralExpression(actor))
  const properties = new Map(actor.properties.map(property => {
    assert.ok(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name))
    return [property.name.text, property.initializer] as const
  }))
  assert.deepEqual([...properties.keys()].sort(), ['knownDocument', 'memberId', 'role'])
  assert.equal(properties.get('memberId')!.getText(parsed), 'auth.member.memberId')
  assert.equal(properties.get('role')!.getText(parsed), 'auth.member.role')
  const known = properties.get('knownDocument')!
  assert.ok(ts.isBinaryExpression(known) && known.operatorToken.kind === ts.SyntaxKind.GreaterThanEqualsToken)
  assert.equal(known.right.getText(parsed), '0')
  const revision = findNodes(known.left, ts.isCallExpression)
    .filter(call => call.expression.getText(parsed) === 'store.contentAccess.composeHttpRevision')
  assert.equal(revision.length, 1, 'known-document proof comes from retained content authority')
  assert.match(revision[0]!.arguments[0]!.getText(parsed), /^String\(\(body\.mutation\s+as\s+Record<string,\s*unknown>\)\?\.documentId\s*\|\|\s*''\)$/)
  const scoped = oneCall(route, 'bootstrapComposeAclDocuments')
  const legacy = oneCall(route, 'bootstrapComposeAclSharedDocIds')
  assert.equal(scoped.arguments[0]!.getText(parsed), 'body.documents')
  assert.equal(legacy.arguments[0]!.getText(parsed), 'body.documentIds')
  assert.ok(scoped.getStart(parsed) > mutation.end && legacy.getStart(parsed) > scoped.end)
  const synchronize = oneCall(route, 'syncComposeContentAccess')
  const evict = oneCall(route, 'evictUnsharedComposeYjsPeers')
  const acknowledgments = findNodes(route, ts.isCallExpression).filter(call =>
    ts.isIdentifier(call.expression) && call.expression.text === 'sendJson'
    && call.arguments[1]?.getText(parsed) === '200')
  assert.equal(acknowledgments.length, 1)
  assert.ok(synchronize.getStart(parsed) > legacy.end && evict.getStart(parsed) > synchronize.end && acknowledgments[0]!.getStart(parsed) > evict.end,
    'persist current authority and evict revoked peers before acknowledging access')
}

function assertMemberOwnerTransfer(src: string): void {
  const parsed = ts.createSourceFile('server.ts', src, ts.ScriptTarget.Latest, true)
  const helpers = findNodes(parsed, ts.isFunctionDeclaration)
    .filter(fn => fn.name?.text === 'removeMembersFromComposeAuthority')
  assert.equal(helpers.length, 1)
  const helper = helpers[0]!
  const successor = findNodes(helper, ts.isVariableDeclaration)
    .find(variable => ts.isIdentifier(variable.name) && variable.name.text === 'successor')
  assert.ok(successor?.initializer)
  const selection = successor.initializer.getText(parsed)
  assert.match(selection, /store\.listMembers\(\)\.filter\(member\s*=>\s*member\.role\s*===\s*'admin'\s*&&\s*!memberIds\.includes\(member\.memberId\)\)/)
  assert.match(selection, /\.sort\(\(a, b\)\s*=>\s*a\.createdAt\s*-\s*b\.createdAt\s*\|\|\s*a\.memberId\.localeCompare\(b\.memberId\)\)\[0\]$/)
  const guests = oneCall(helper, 'reconcileComposeGuestOwners')
  const remove = oneCall(helper, 'removeComposeAclMembers')
  assert.deepEqual(remove.arguments.map(arg => arg.getText(parsed)), ['memberIds', 'successor?.memberId'])
  const sync = oneCall(helper, 'syncComposeContentAccess')
  assert.equal(sync.arguments[0]!.getText(parsed), 'store')
  assert.ok(guests.end < remove.getStart(parsed) && remove.end < sync.getStart(parsed), 'guest ownership transfer precedes ACL removal and projection')
  const refusals = findNodes(helper, ts.isIfStatement).filter(statement => statement.expression.getText(parsed) === '!result.ok')
  assert.equal(refusals.length, 1)
  assert.ok(ts.isReturnStatement(refusals[0]!.thenStatement) && refusals[0]!.thenStatement.expression?.getText(parsed) === 'result')
  assert.ok(refusals[0]!.getStart(parsed) > remove.end && refusals[0]!.end < sync.getStart(parsed), 'failed transfer never proceeds to access projection')
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
    assertActorBoundAclRoute(server)

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
    assertMemberOwnerTransfer(server)
  })

  it('source contracts reject unbound actors, missing owner transfer, and early acknowledgment', () => {
    assert.throws(() => assertActorBoundAclRoute(server.replace('memberId: auth.member.memberId, role: auth.member.role, knownDocument:', 'memberId: auth.member.memberId, role: body.role, knownDocument:')))
    assert.throws(() => assertMemberOwnerTransfer(server.replace('removeComposeAclMembers(memberIds, successor?.memberId)', 'removeComposeAclMembers(memberIds)')))
    assert.throws(() => assertMemberOwnerTransfer(server.replace('if (!reconcileComposeGuestOwners())', 'if (!skipComposeGuestOwners())')))
    const earlyReply = server
      .replaceAll('const evicted = evictUnsharedComposeYjsPeers()', 'sendJson(res, 200, { ok: true }); const evicted = evictUnsharedComposeYjsPeers()')
      .replace('sendJson(res, 200, { ok: true, count: result.count, evicted })', 'void evicted')
    assert.throws(() => assertActorBoundAclRoute(earlyReply))
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
