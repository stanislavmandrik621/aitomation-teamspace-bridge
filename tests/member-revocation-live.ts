/**
 * Real bridge regression for bulk offboarding: every target socket is dropped,
 * chat membership is cleaned, and offline reconnect gets the durable code.
 */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'
import { hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
type Client = {
  socket: WebSocket
  wait: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>
}

async function reservePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-member-revocation-live-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  try {
    mkdirSync(dir, { recursive: true })
    const maxLengthMemberId = 'm'.repeat(128)
    const tokens = {
      admin: 'live-admin-token',
      alice1: 'live-alice-token-1',
      alice2: 'live-alice-token-2',
      bob: 'live-bob-token',
      max: 'live-max-token',
    }
    writeFileSync(
      join(dir, 'team.json'),
      JSON.stringify({ teamId: 'team_live_revocation', name: 'Live revocation', createdAt: 1 }),
      'utf8',
    )
    writeFileSync(
      join(dir, 'members.json'),
      JSON.stringify([
        {
          memberId: 'admin',
          email: 'admin@example.test',
          displayName: 'Admin',
          role: 'admin',
          sessions: { 'admin-device': hashSessionToken(tokens.admin) },
          createdAt: 1,
        },
        {
          memberId: 'alice',
          email: 'alice@example.test',
          displayName: 'Alice',
          role: 'member',
          sessions: {
            'alice-device-1': hashSessionToken(tokens.alice1),
            'alice-device-2': hashSessionToken(tokens.alice2),
          },
          createdAt: 2,
        },
        {
          memberId: 'bob',
          email: 'bob@example.test',
          displayName: 'Bob',
          role: 'member',
          sessions: { 'bob-device': hashSessionToken(tokens.bob) },
          createdAt: 3,
        },
        {
          memberId: maxLengthMemberId,
          email: 'max@example.test',
          displayName: 'Max-length member',
          role: 'member',
          sessions: { 'max-device': hashSessionToken(tokens.max) },
          createdAt: 4,
        },
      ]),
      'utf8',
    )

    const port = await reservePort()
    initializeCurrentAuthority(dir,dir+'.authority')
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        TEAMSPACE_DATA_DIR: dir,
        TEAMSPACE_BRIDGE_HOST: '127.0.0.1',
        TEAMSPACE_BRIDGE_PORT: String(port),
        TEAMSPACE_AT_REST_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge startup timeout')), 20_000)
      child!.stdout!.on('data', (data) => {
        if (!String(data).includes('bridge listening')) return
        clearTimeout(timer)
        resolve()
      })
      child!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Bridge exited ${code}`))
      })
    })

    async function connect(
      memberId: string,
      deviceId: string,
      sessionToken: string,
      expectOk = true,
    ): Promise<Client> {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(socket)
      const inbox: Frame[] = []
      socket.on('message', (data) => inbox.push(JSON.parse(String(data)) as Frame))
      await once(socket, 'open')
      const wait = async (
        predicate: (frame: Frame) => boolean,
        timeoutMs = 10_000,
      ): Promise<Frame> => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate)
          if (index >= 0) return inbox.splice(index, 1)[0]!
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Expected bridge frame did not arrive')
      }
      socket.send(JSON.stringify({
        type: 'hello',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        memberId,
        deviceId,
        sessionToken,
      }))
      if (expectOk) await wait((frame) => frame.type === 'hello_ok')
      return { socket, wait }
    }

    const admin = await connect('admin', 'admin-device', tokens.admin)
    const alice1 = await connect('alice', 'alice-device-1', tokens.alice1)
    const alice2 = await connect('alice', 'alice-device-2', tokens.alice2)
    const bob = await connect('bob', 'bob-device', tokens.bob)

    const malformedAudiences = [
      [`${maxLengthMemberId}x`],
      ['alice\0suffix'],
      ['\ud800'],
      null,
      ['alice', 17],
      Array.from({ length: 501 }, (_, i) => `member-${i}`),
    ]
    const audienceOps = malformedAudiences.map((visibleToMemberIds, i) => ({
      opId: `bad-audience-${i}`, kind: 'module.update', targetKind: 'module', targetId: 'scope-test',
      hlc: `1:${i}:admin-device`, originDevice: 'admin-device', protocolVersion: 2, hopCount: 0,
      ...(i % 2 ? { patch: { visibleToMemberIds } } : { visibleToMemberIds }),
    }))
    admin.socket.send(JSON.stringify({ type: 'ops', frameId: 'bad-audiences', ops: audienceOps }))
    const refusedAudiences = await admin.wait((frame) => frame.type === 'ops_result' && frame.frameId === 'bad-audiences')
    assert.equal(refusedAudiences.results.length, malformedAudiences.length)
    for (const result of refusedAudiences.results) {
      assert.equal(result.status, 'refused')
      assert.equal(result.permanent, true)
      assert.equal(result.reason, 'Invalid member audience')
    }
    admin.socket.send(JSON.stringify({ type: 'ops', frameId: 'valid-audience', ops: [{
      ...audienceOps[0], opId: 'valid-audience-op', visibleToMemberIds: ['alice'],
    }] }))
    const validAudience = await admin.wait((frame) => frame.type === 'ops_result' && frame.frameId === 'valid-audience')
    assert.equal(validAudience.results[0].status, 'applied')
    const delivered = await alice1.wait((frame) => frame.type === 'ops' && frame.ops.some((op: Frame) => op.opId === 'valid-audience-op'))
    assert.deepEqual(delivered.ops[0].visibleToMemberIds, ['alice'])
    assert.equal(readFileSync(join(dir, 'ops.jsonl'), 'utf8').includes('bad-audience-'), false,
      'malformed restrictions are never persisted or delivered under an aliased recipient')

    admin.socket.send(JSON.stringify({
      type: 'kick_member',
      frameId: 'kick-overlong',
      memberId: `${maxLengthMemberId}x`,
    }))
    const overlong = await admin.wait((frame) => frame.requestId === 'kick-overlong')
    assert.equal(overlong.type, 'error', 'an overlong selector is refused, never truncated')
    admin.socket.send(JSON.stringify({ type: 'list_members', frameId: 'members-after-overlong' }))
    const membersAfterOverlong = await admin.wait((frame) => frame.frameId === 'members-after-overlong')
    assert.ok(
      membersAfterOverlong.members.some((member: Frame) => member.memberId === maxLengthMemberId),
      'the valid 128-character member remains after the aliased request',
    )

    const aclResponse = await fetch(`http://127.0.0.1:${port}/v1/teamspace/compose-acl`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.admin}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        teamId: 'team_live_revocation',
        documents: [
          { documentId: 'board-both', memberIds: ['alice', 'bob'] },
          { documentId: 'board-alice', memberIds: ['alice'] },
          { documentId: 'board-empty', memberIds: [] },
          { documentId: 'board-team', memberIds: null },
        ],
      }),
    })
    assert.equal(aclResponse.status, 200)
    assert.deepEqual(await aclResponse.json(), { ok: true, count: 4, evicted: 0 })

    admin.socket.send(JSON.stringify({
      type: 'chat_room_create',
      frameId: 'room-before-kick',
      kind: 'group',
      title: 'Offboarding room',
      memberIds: ['alice', 'bob'],
    }))
    const roomCreated = await admin.wait((frame) => frame.frameId === 'room-before-kick')
    assert.equal(roomCreated.type, 'chat_room_create_ok')
    assert.deepEqual(new Set(roomCreated.room.memberIds), new Set(['admin', 'alice', 'bob']))

    const alice1Closed = once(alice1.socket, 'close')
    const alice2Closed = once(alice2.socket, 'close')
    const bobClosed = once(bob.socket, 'close')
    admin.socket.send(JSON.stringify({
      type: 'kick_members',
      frameId: 'kick-many',
      memberIds: ['alice', 'bob', 'alice'],
    }))
    const kicked = await admin.wait((frame) => frame.frameId === 'kick-many')
    assert.equal(kicked.type, 'kick_members_ok')
    assert.deepEqual(kicked.members, [
      {
        memberId: 'alice',
        kickedDeviceIds: ['alice-device-1', 'alice-device-2'],
        kickedDeviceIdsTotal: 2,
        deviceIdsTruncated: false,
      },
      {
        memberId: 'bob',
        kickedDeviceIds: ['bob-device'],
        kickedDeviceIdsTotal: 1,
        deviceIdsTruncated: false,
      },
    ])
    assert.equal(kicked.chatCleanupFailedMemberIds, undefined)
    assert.equal(kicked.contentAclCleanupFailedMemberIds, undefined)
    const persistedAcl = JSON.parse(
      readFileSync(join(dir+'.authority', 'compose-live-acl.json'), 'utf8'),
    ) as { documents?: Array<{ documentId?: string; memberIds?: string[] | null }> }
    const audience = new Map(
      (persistedAcl.documents ?? []).map((row) => [row.documentId, row.memberIds]),
    )
    assert.deepEqual(audience.get('board-both'), [], 'bulk kick removes every departed member')
    assert.deepEqual(audience.get('board-alice'), [], 'removing the last member persists an empty audience')
    assert.deepEqual(audience.get('board-empty'), [], 'an existing empty audience stays fail-closed')
    assert.equal(audience.get('board-team'), null, 'whole-team ACL stays whole-team; roster revocation excludes peers')
    for (const closed of [alice1Closed, alice2Closed, bobClosed]) {
      const [code, reason] = await closed
      assert.equal(code, 4003)
      assert.equal(String(reason), 'kicked')
    }
    assert.equal(admin.socket.readyState, WebSocket.OPEN, 'Admin socket remains live')

    admin.socket.send(JSON.stringify({ type: 'chat_rooms_list', frameId: 'rooms-after-kick' }))
    const rooms = await admin.wait((frame) => frame.frameId === 'rooms-after-kick')
    assert.equal(rooms.type, 'chat_rooms_ok')
    const room = rooms.rooms.find((row: Frame) => row.id === roomCreated.room.id)
    assert.ok(room, 'group still exists for the Admin')
    assert.deepEqual(room.memberIds, ['admin'], 'all kicked members removed from the room')

    for (const [memberId, deviceId, token] of [
      ['alice', 'alice-device-1', tokens.alice1],
      ['alice', 'alice-device-2', tokens.alice2],
      ['bob', 'bob-device', tokens.bob],
    ] as const) {
      const refused = await connect(memberId, deviceId, token, false)
      const frame = await refused.wait((candidate) => candidate.type === 'hello_refuse')
      assert.equal(frame.reason, 'Invalid session')
      assert.equal(frame.code, 'membership_revoked')
      refused.socket.close()
    }
    const invalid = await connect('alice', 'alice-device-1', 'never-valid', false)
    const invalidFrame = await invalid.wait((candidate) => candidate.type === 'hello_refuse')
    assert.equal(invalidFrame.reason, 'Invalid session')
    assert.equal(invalidFrame.code, undefined, 'random bearer remains generic')
    invalid.socket.close()

    console.log('member revocation live: atomic batch reply, every socket 4003, chat cleanup and coded offline refusal passed')
  } finally {
    for (const socket of sockets) {
      try { socket.close() } catch { /* */ }
    }
    if (child && child.exitCode === null) child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
