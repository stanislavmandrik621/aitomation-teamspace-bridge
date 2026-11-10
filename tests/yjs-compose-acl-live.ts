/**
 * Real self-host bridge integration: authenticated Compose/Yjs rooms,
 * replace-ACL revocation, live role changes, scoped Modules fanout, and chat.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'
import { BridgeStore } from '../src/store.js'

type Frame = Record<string, any>
type Client = {
  socket: WebSocket
  wait: (predicate: (frame: Frame) => boolean, timeoutMs?: number) => Promise<Frame>
  assertNo: (predicate: (frame: Frame) => boolean, durationMs?: number) => Promise<void>
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
  const dir = mkdtempSync(join(tmpdir(), 'bridge-collab-live-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  try {
    const store = new BridgeStore(dir, 21)
    const admin = store.helloOrBootstrap({
      memberId: 'mem_admin',
      deviceId: 'host-device',
      displayName: 'Alice Admin',
      memberEmail: 'alice@example.test',
    })
    assert.ok(admin.ok)
    const coAdminInvite = store.createInvite(admin.member.memberId, 'coadmin@example.test', 'admin')
    assert.ok(coAdminInvite.ok)
    const coAdmin = await store.redeemInvite({
      token: coAdminInvite.invite.token,
      deviceId: 'coadmin-device',
      displayName: 'Casey Co-Admin',
      memberEmail: 'coadmin@example.test',
    })
    assert.ok(coAdmin.ok)
    const memberInvite = store.createInvite(admin.member.memberId, 'bob@example.test', 'member')
    assert.ok(memberInvite.ok)
    const member = await store.redeemInvite({
      token: memberInvite.invite.token,
      deviceId: 'member-device',
      displayName: 'Bob Member',
      memberEmail: 'bob@example.test',
    })
    assert.ok(member.ok)
    const viewerInvite = store.createInvite(admin.member.memberId, 'view@example.test', 'viewer')
    assert.ok(viewerInvite.ok)
    const viewer = await store.redeemInvite({
      token: viewerInvite.invite.token,
      deviceId: 'viewer-device',
      displayName: 'Vera Viewer',
      memberEmail: 'view@example.test',
    })
    assert.ok(viewer.ok)
    const outsiderInvite = store.createInvite(admin.member.memberId, 'outside@example.test', 'member')
    assert.ok(outsiderInvite.ok)
    const outsider = await store.redeemInvite({
      token: outsiderInvite.invite.token,
      deviceId: 'outsider-device',
      displayName: 'Omar Outside',
      memberEmail: 'outside@example.test',
    })
    assert.ok(outsider.ok)
    const teamId = store.ensureTeam().teamId

    const port = await reservePort()
    initializeCurrentAuthority(dir,dir+'.authority')
    const startBridge = async () => {
    // The same scenarios can qualify a compiled release, without a TS loader.
    const entry = process.env.COMPOSE_BRIDGE_TEST_ENTRY
    child = spawn(process.execPath, entry ? [entry] : ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        TEAMSPACE_DATA_DIR: dir,
        TEAMSPACE_BRIDGE_HOST: '127.0.0.1',
        TEAMSPACE_BRIDGE_PORT: String(port),
        TEAMSPACE_YJS_COMPOSE_ENABLED: 'true',
        TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let startupErrors = ''
    child.stderr!.on('data', data => { startupErrors = (startupErrors + String(data)).slice(-3000) })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Bridge startup timeout')), 20_000)
      child!.stdout!.on('data', (data) => {
        if (String(data).includes('bridge listening')) {
          clearTimeout(timer)
          resolve()
        }
      })
      child!.once('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`Bridge exited ${code}: ${startupErrors}`))
      })
    })
    }
    const stopBridge = async () => {
      for (const socket of sockets.splice(0)) socket.terminate()
      if (child && child.exitCode === null) {
        const stopped = once(child, 'exit')
        child.kill('SIGTERM')
        await stopped
      }
    }
    await startBridge()

    async function connect(memberId: string, deviceId: string, sessionToken: string): Promise<Client> {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(socket)
      const inbox: Frame[] = []
      socket.on('message', (data) => inbox.push(JSON.parse(String(data)) as Frame))
      await once(socket, 'open')
      const wait = async (predicate: (frame: Frame) => boolean, timeoutMs = 10_000) => {
        const deadline = Date.now() + timeoutMs
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate)
          if (index >= 0) return inbox.splice(index, 1)[0]
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error('Expected bridge frame did not arrive')
      }
      const assertNo = async (predicate: (frame: Frame) => boolean, durationMs = 350) => {
        const deadline = Date.now() + durationMs
        while (Date.now() < deadline) {
          assert.equal(inbox.some(predicate), false, 'unexpected bridge frame arrived')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      socket.send(JSON.stringify({
        type: 'hello',
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        memberId,
        deviceId,
        sessionToken,
      }))
      await wait((frame) => frame.type === 'hello_ok')
      return { socket, wait, assertNo }
    }

    async function replaceComposeAcl(sessionToken: string, documentIds: string[]) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/teamspace/compose-acl`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ teamId, documentIds }),
      })
      return { status: response.status, body: await response.json() as Frame }
    }

    async function mutateScopedComposeAcl(
      sessionToken: string,
      mutation:
        | { documentId: string; memberIds: string[] | null }
        | { documentId: string; remove: true },
    ) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/teamspace/compose-acl`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${sessionToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ teamId, mutation }),
      })
      return { status: response.status, body: await response.json() as Frame }
    }

    const adminClient = await connect(admin.member.memberId, 'host-device', admin.sessionToken)
    const memberClient = await connect(member.member.memberId, 'member-device', member.sessionToken)
    const viewerClient = await connect(viewer.member.memberId, 'viewer-device', viewer.sessionToken)
    const room = 'yjs:composeDoc:board-enterprise'

    memberClient.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'join-private', room }))
    const privateJoin = await memberClient.wait((frame) => frame.frameId === 'join-private')
    assert.equal(privateJoin.type, 'yjs_refuse')
    assert.match(privateJoin.reason, /not shared/i)

    // Knowing the ID and holding an Admin role must not expose a private board.
    const coAdminClient = await connect(coAdmin.member.memberId, 'coadmin-device', coAdmin.sessionToken)
    for (const [client, frameId] of [[adminClient, 'private-owner'], [coAdminClient, 'private-coadmin']] as const) {
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId, room }))
      assert.equal((await client.wait(frame => frame.frameId === frameId)).type, 'yjs_refuse')
    }

    const nonAdminPush = await replaceComposeAcl(member.sessionToken, ['board-enterprise'])
    assert.equal(nonAdminPush.status, 401)
    const sharedPush = await replaceComposeAcl(admin.sessionToken, ['board-enterprise'])
    assert.equal(sharedPush.status, 200)
    assert.deepEqual(sharedPush.body, { ok: true, count: 1, evicted: 0 })

    for (const [client, frameId] of [
      [adminClient, 'join-admin'],
      [memberClient, 'join-member'],
      [viewerClient, 'join-viewer'],
    ] as const) {
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId, room }))
      assert.equal((await client.wait((frame) => frame.frameId === frameId)).type, 'yjs_ok')
    }

    memberClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'member-update', room, updateB64: 'AQ==',
      fromMemberId: admin.member.memberId, fromDeviceId: 'forged-device', teamId: 'forged-team',
    }))
    assert.equal((await memberClient.wait((frame) => frame.frameId === 'member-update')).type, 'yjs_ok')
    const memberPeerUpdate = await adminClient.wait(
      (frame) => frame.type === 'yjs_peer_update' && frame.updateB64 === 'AQ==',
    )
    assert.equal(memberPeerUpdate.fromMemberId, member.member.memberId)
    assert.equal(memberPeerUpdate.fromDeviceId, 'member-device')
    assert.equal(memberPeerUpdate.teamId, teamId)

    viewerClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'viewer-update', room, updateB64: 'Ag==',
    }))
    const viewerWrite = await viewerClient.wait((frame) => frame.frameId === 'viewer-update')
    assert.equal(viewerWrite.type, 'yjs_refuse')
    assert.match(viewerWrite.reason, /viewers cannot edit/i)
    viewerClient.socket.send(JSON.stringify({
      type: 'yjs_awareness', frameId: 'viewer-awareness', room, updateB64: 'Aw==',
      fromMemberId: admin.member.memberId, fromDeviceId: 'forged-device', teamId: 'forged-team',
    }))
    assert.equal((await viewerClient.wait((frame) => frame.frameId === 'viewer-awareness')).type, 'yjs_ok')
    const viewerAwareness = await adminClient.wait(
      (frame) => frame.type === 'yjs_peer_awareness' && frame.updateB64 === 'Aw==',
    )
    assert.equal(viewerAwareness.fromMemberId, viewer.member.memberId)
    assert.equal(viewerAwareness.fromDeviceId, 'viewer-device')
    assert.equal(viewerAwareness.teamId, teamId)

    for (const type of ['yjs_update', 'yjs_awareness']) {
      for (const [label, payload] of [['malformed', '!not-base64!'], ['oversized', 'A'.repeat(512_004)]]) {
        const frameId = `${type}-${label}`
        memberClient.socket.send(JSON.stringify({ type, frameId, room, updateB64: payload }))
        const refused = await memberClient.wait(frame => frame.frameId === frameId)
        assert.equal(refused.type, 'yjs_refuse', `${type} ${label} must be refused before fanout`)
        assert.match(refused.reason, /invalid|oversized/i)
        await adminClient.assertNo(frame => (frame.type === 'yjs_peer_update' || frame.type === 'yjs_peer_awareness') && frame.updateB64 === payload, 100)
      }
    }
    assert.equal(adminClient.socket.readyState, WebSocket.OPEN)
    assert.equal(memberClient.socket.readyState, WebSocket.OPEN)
    console.log('PASS forged sender/team fields cannot change authenticated identity; invalid/oversized content and awareness never fan out')

    const restrictedOp = {
      opId: 'restricted-record-update',
      kind: 'record.update',
      targetKind: 'record',
      targetId: 'record-1',
      entityId: 'entity-1',
      moduleId: 'module-1',
      patch: { data: { title: 'Scoped enterprise row' } },
      visibleToMemberIds: [member.member.memberId],
      hlc: `${Date.now()}:0001:live-test`,
      originDevice: 'forged-device',
      hopCount: 0,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    }
    adminClient.socket.send(JSON.stringify({
      type: 'ops', frameId: 'restricted-op', ops: [restrictedOp],
    }))
    const scoped = await memberClient.wait(
      (frame) => frame.type === 'ops' && frame.ops?.some((op: Frame) => op.opId === restrictedOp.opId),
    )
    const relayed = scoped.ops.find((op: Frame) => op.opId === restrictedOp.opId)
    assert.equal(relayed.originMemberId, admin.member.memberId)
    assert.equal(relayed.originMemberName, 'Alice Admin')
    assert.equal(relayed.originRole, 'admin')
    assert.equal(relayed.originDevice, 'host-device')
    await viewerClient.assertNo(
      (frame) => frame.type === 'ops' && frame.ops?.some((op: Frame) => op.opId === restrictedOp.opId),
    )
    const outsiderClient = await connect(
      outsider.member.memberId,
      'outsider-device',
      outsider.sessionToken,
    )
    const outsiderCatchup = await outsiderClient.wait(
      (frame) => frame.type === 'catchup_status' && frame.done === true,
    )
    assert.equal(outsiderCatchup.truncated, false)
    await outsiderClient.assertNo(
      (frame) => frame.type === 'ops' && frame.ops?.some((op: Frame) => op.opId === restrictedOp.opId),
    )

    memberClient.socket.send(JSON.stringify({
      type: 'chat_send',
      frameId: 'member-chat',
      room: 'chat:team',
      body: 'Concurrent collaboration is online',
      clientMsgId: 'live-chat-1',
    }))
    const chatOk = await memberClient.wait((frame) => frame.frameId === 'member-chat')
    assert.equal(chatOk.type, 'chat_ok')
    assert.equal(chatOk.message.memberId, member.member.memberId)
    assert.equal(chatOk.message.memberName, 'Bob Member')
    const viewerChat = await viewerClient.wait(
      (frame) => frame.type === 'chat_peer' && frame.message?.id === 'live-chat-1',
    )
    assert.equal(viewerChat.message.body, 'Concurrent collaboration is online')
    viewerClient.socket.send(JSON.stringify({
      type: 'chat_send', frameId: 'viewer-chat', room: 'chat:team', body: 'forbidden',
    }))
    const viewerChatWrite = await viewerClient.wait((frame) => frame.frameId === 'viewer-chat')
    assert.equal(viewerChatWrite.type, 'chat_refuse')
    assert.match(viewerChatWrite.reason, /viewers can read/i)

    // Narrow whole-team access to exactly Bob. The new `documents` field must
    // win over its empty legacy whole-team mirror: Vera is evicted, Bob stays.
    const narrowedPush = await mutateScopedComposeAcl(admin.sessionToken, {
      documentId: 'board-enterprise',
      memberIds: [member.member.memberId],
    })
    assert.equal(narrowedPush.status, 200)
    assert.deepEqual(narrowedPush.body, { ok: true, count: 1, evicted: 1 })
    const viewerNarrowed = await viewerClient.wait(
      (frame) => frame.type === 'yjs_refuse' && frame.frameId === 'compose-acl-revoked',
    )
    assert.equal(viewerNarrowed.room, room)
    await memberClient.assertNo(
      (frame) => frame.type === 'yjs_refuse' && frame.frameId === 'compose-acl-revoked',
    )

    // A second Admin reconnecting with a stale whole-team snapshot must not
    // replace the durable per-document mutation or re-grant Vera.
    const staleCoAdminPush = await replaceComposeAcl(
      coAdmin.sessionToken,
      ['board-enterprise'],
    )
    assert.equal(staleCoAdminPush.status, 200)

    memberClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'retained-member-update', room, updateB64: 'CQ==',
    }))
    assert.equal(
      (await memberClient.wait((frame) => frame.frameId === 'retained-member-update')).type,
      'yjs_ok',
    )
    assert.equal(
      (await adminClient.wait(
        (frame) => frame.type === 'yjs_peer_update' && frame.updateB64 === 'CQ==',
      )).fromMemberId,
      member.member.memberId,
    )

    viewerClient.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'viewer-rejoin-scoped', room }))
    const viewerScopedJoin = await viewerClient.wait((frame) => frame.frameId === 'viewer-rejoin-scoped')
    assert.equal(viewerScopedJoin.type, 'yjs_refuse')
    assert.match(viewerScopedJoin.reason, /not shared/i)
    outsiderClient.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'outsider-join-scoped', room }))
    const outsiderScopedJoin = await outsiderClient.wait((frame) => frame.frameId === 'outsider-join-scoped')
    assert.equal(outsiderScopedJoin.type, 'yjs_refuse')
    assert.match(outsiderScopedJoin.reason, /not shared/i)

    const revokedPush = await mutateScopedComposeAcl(admin.sessionToken, {
      documentId: 'board-enterprise',
      remove: true,
    })
    assert.equal(revokedPush.status, 200)
    assert.deepEqual(revokedPush.body, { ok: true, count: 0, evicted: 2 })
    const revoked = await memberClient.wait(
      (frame) => frame.type === 'yjs_refuse' && frame.frameId === 'compose-acl-revoked',
    )
    assert.equal(revoked.room, room)
    assert.match(revoked.reason, /not shared/i)
    memberClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'after-revoke-update', room, updateB64: 'BA==',
    }))
    const updateAfterRevoke = await memberClient.wait(
      (frame) => frame.frameId === 'after-revoke-update',
    )
    assert.equal(updateAfterRevoke.type, 'yjs_refuse')
    assert.match(updateAfterRevoke.reason, /not shared/i)
    await adminClient.assertNo(
      (frame) => frame.type === 'yjs_peer_update' && frame.updateB64 === 'BA==',
    )
    viewerClient.socket.send(JSON.stringify({
      type: 'yjs_awareness', frameId: 'after-revoke-awareness', room, updateB64: 'BQ==',
    }))
    const awarenessAfterRevoke = await viewerClient.wait(
      (frame) => frame.frameId === 'after-revoke-awareness',
    )
    assert.equal(awarenessAfterRevoke.type, 'yjs_refuse')
    assert.match(awarenessAfterRevoke.reason, /not shared/i)

    adminClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'admin-private-update', room, updateB64: 'Bg==',
    }))
    assert.equal(
      (await adminClient.wait((frame) => frame.frameId === 'admin-private-update')).type,
      'yjs_refuse',
    )

    assert.equal((await mutateScopedComposeAcl(admin.sessionToken, {
      documentId: 'board-enterprise',
      memberIds: [member.member.memberId],
    })).status, 200)
    adminClient.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'admin-rejoin-shared', room }))
    assert.equal((await adminClient.wait(frame => frame.frameId === 'admin-rejoin-shared')).type, 'yjs_ok')
    memberClient.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'member-rejoin', room }))
    assert.equal((await memberClient.wait((frame) => frame.frameId === 'member-rejoin')).type, 'yjs_ok')
    adminClient.socket.send(JSON.stringify({
      type: 'set_role',
      frameId: 'demote-member',
      memberId: member.member.memberId,
      role: 'viewer',
    }))
    assert.equal((await adminClient.wait((frame) => frame.frameId === 'demote-member')).type, 'set_role_ok')
    memberClient.socket.send(JSON.stringify({
      type: 'yjs_update', frameId: 'demoted-update', room, updateB64: 'Bw==',
    }))
    const demotedWrite = await memberClient.wait((frame) => frame.frameId === 'demoted-update')
    assert.equal(demotedWrite.type, 'yjs_refuse')
    assert.match(demotedWrite.reason, /viewers cannot edit/i)
    memberClient.socket.send(JSON.stringify({
      type: 'yjs_awareness', frameId: 'demoted-awareness', room, updateB64: 'CA==',
    }))
    assert.equal((await memberClient.wait((frame) => frame.frameId === 'demoted-awareness')).type, 'yjs_ok')
    assert.equal(
      (await adminClient.wait(
        (frame) => frame.type === 'yjs_peer_awareness' && frame.updateB64 === 'CA==',
      )).fromMemberId,
      member.member.memberId,
    )

    // Actual server restart must retain the exact audience and live role, and
    // reconnecting administrators must not resurrect an old whole-team grant.
    await stopBridge()
    await startBridge()
    const restarted = await Promise.all([
      connect(admin.member.memberId, 'host-device', admin.sessionToken),
      connect(coAdmin.member.memberId, 'coadmin-device', coAdmin.sessionToken),
      connect(member.member.memberId, 'member-device', member.sessionToken),
      connect(viewer.member.memberId, 'viewer-device', viewer.sessionToken),
      connect(outsider.member.memberId, 'outsider-device', outsider.sessionToken),
    ])
    assert.equal((await replaceComposeAcl(coAdmin.sessionToken, ['board-enterprise'])).status, 200)
    for (const [index, client] of restarted.entries()) {
      const frameId = `restart-join-${index}`
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId, room }))
      assert.equal((await client.wait(frame => frame.frameId === frameId)).type,
        index < 3 ? 'yjs_ok' : 'yjs_refuse', 'Restart must preserve selected members, not widen access')
      const privateId = `restart-private-${index}`
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId: privateId, room: 'yjs:composeDoc:never-shared' }))
      assert.equal((await client.wait(frame => frame.frameId === privateId)).type, 'yjs_refuse')
    }
    restarted[2].socket.send(JSON.stringify({ type: 'yjs_update', frameId: 'restart-viewer-write', room, updateB64: 'Bw==' }))
    assert.equal((await restarted[2].wait(frame => frame.frameId === 'restart-viewer-write')).type, 'yjs_refuse')

    assert.equal((await mutateScopedComposeAcl(admin.sessionToken, { documentId: 'board-enterprise', memberIds: null })).status, 200)
    for (const [index, client] of restarted.slice(3).entries()) {
      const frameId = `explicit-team-${index}`
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId, room }))
      assert.equal((await client.wait(frame => frame.frameId === frameId)).type, 'yjs_ok')
    }
    const finalRevoke = await mutateScopedComposeAcl(admin.sessionToken, { documentId: 'board-enterprise', remove: true })
    assert.equal(finalRevoke.status, 200)
    assert.equal(finalRevoke.body.evicted, 5, 'Unshare evicts administrators as well as other members')
    await stopBridge()
    await startBridge()
    assert.equal((await replaceComposeAcl(coAdmin.sessionToken, ['board-enterprise'])).status, 200)
    for (const [identity, deviceId] of [[admin, 'host-device'], [coAdmin, 'coadmin-device'], [member, 'member-device'], [viewer, 'viewer-device'], [outsider, 'outsider-device']] as const) {
      const client = await connect(identity.member.memberId, deviceId, identity.sessionToken)
      const frameId = `revoked-restart-${deviceId}`
      client.socket.send(JSON.stringify({ type: 'yjs_join', frameId, room }))
      assert.equal((await client.wait(frame => frame.frameId === frameId)).type, 'yjs_refuse', 'Revoked access must stay revoked after restart and a stale Admin bootstrap')
    }
    // The owner API is available to invited Members/Viewers (including Free
    // clients), without granting ordinary administrator or Viewer edit rights.
    const post = async (path: string, token: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() as Frame }
    }
    const publish = (token: string, documentId: string, memberIds: string[] | null, extra = {}) => post('/v1/teamspace/compose-board-share', token, {
      teamId, documentId, memberIds, snapshot: { id: documentId, title: 'Member owned editable campaign', tipRev: 1, schemaVersion: 1, graphJson: JSON.stringify({ blocks: { title: { kind: 'text', props: { text: 'Retained team work' } } } }) }, ...extra,
    })
    const access = async (token: string, documentId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/teamspace/compose-board-share?teamId=${teamId}&documentId=${documentId}`, { headers: { authorization: `Bearer ${token}` } })
      return { status: response.status, body: await response.json() as Frame }
    }
    const revokeBoard = (token: string, documentId: string) => post('/v1/teamspace/compose-board-share', token, { teamId, documentId, remove: true })
    const adminNow = await connect(admin.member.memberId, 'host-device', admin.sessionToken)
    const bobNow = await connect(member.member.memberId, 'member-device', member.sessionToken)
    const veraNow = await connect(viewer.member.memberId, 'viewer-device', viewer.sessionToken)
    const outsiderNow = await connect(outsider.member.memberId, 'outsider-device', outsider.sessionToken)
    assert.equal((await publish('', 'unauthed-board', null)).status, 401)
    assert.equal((await publish(member.sessionToken, 'foreign-team-board', null, { teamId: 'foreign-team' })).status, 403)
    const media = Buffer.from('disposable board media fixture')
    const mediaSha = createHash('sha256').update(media).digest('hex')
    const upload = (query: string) => fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}${query}`, { method: 'POST', headers: { authorization: `Bearer ${member.sessionToken}`, 'content-type': 'application/octet-stream' }, body: media })
    assert.equal((await upload('')).status, 403, 'ordinary Viewer upload stays refused')
    assert.equal((await upload(`?composeDocumentId=member-owned&teamId=foreign-team`)).status, 403)
    assert.equal((await upload(`?composeDocumentId=member-owned&teamId=${teamId}`)).status, 200, 'owner-scoped Viewer publication uploads media')
    const firstPublished = await publish(member.sessionToken, 'member-owned', [viewer.member.memberId], { snapshot: { id: 'member-owned', title: 'Media campaign', tipRev: 1, schemaVersion: 1, graphJson: JSON.stringify({ blocks: { photo: { props: { src: { __teamspaceBlob: mediaSha } } } } }) } })
    assert.equal(firstPublished.status, 200)
    assert(firstPublished.body.memberIds.includes(member.member.memberId), 'canonical response retains the owner')
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}`, { headers: { authorization: `Bearer ${viewer.sessionToken}` } })).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}`, { headers: { authorization: `Bearer ${outsider.sessionToken}` } })).status, 404)

    const hasSnapshot = (frame: Frame) => frame.type === 'ops' && frame.ops?.some((op: Frame) => op.targetId === 'member-owned' && op.kind === 'compose.doc.create')
    await adminNow.wait(hasSnapshot); await veraNow.wait(hasSnapshot); await bobNow.wait(hasSnapshot)
    await outsiderNow.assertNo(hasSnapshot)
    // Actual HTTP bytes, revocation and the same-digest owner re-upload. An
    // attachment staging grant permits publication, never revoked downloads.
    const mediaSnapshot = { id: 'member-owned', title: 'Media campaign', tipRev: 1, schemaVersion: 1,
      graphJson: JSON.stringify({ blocks: { photo: { props: { src: { __teamspaceBlob: mediaSha } } } } }) }
    assert.equal((await revokeBoard(member.sessionToken, 'member-owned')).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}`, { headers: { authorization: `Bearer ${viewer.sessionToken}` } })).status, 404)
    assert.equal((await publish(member.sessionToken, 'member-owned', [viewer.member.memberId], { snapshot: mediaSnapshot })).status, 403, 'digest knowledge alone cannot restore a revoked image')
    assert.equal((await upload(`?composeDocumentId=member-owned&teamId=${teamId}`)).status, 200)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}`, { headers: { authorization: `Bearer ${viewer.sessionToken}` } })).status, 404, 'fresh upload does not reopen the old viewer grant')
    assert.equal((await publish(member.sessionToken, 'member-owned', [viewer.member.memberId], { snapshot: mediaSnapshot })).status, 200, 'owner can re-share their saved bytes after a fresh upload')
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/blobs/${mediaSha}`, { headers: { authorization: `Bearer ${viewer.sessionToken}` } })).status, 200)
    assert.equal((await access(member.sessionToken, 'member-owned')).body.owned, true)
    assert.equal((await access(admin.sessionToken, 'member-owned')).body.canManage, true)
    assert.equal((await access(viewer.sessionToken, 'member-owned')).body.canManage, false)
    assert.equal((await publish(outsider.sessionToken, 'member-owned', null)).status, 403)
    bobNow.socket.send(JSON.stringify({ type: 'yjs_join', frameId: 'owner-viewer-join', room: 'yjs:composeDoc:member-owned' }))
    assert.equal((await bobNow.wait(frame => frame.frameId === 'owner-viewer-join')).type, 'yjs_ok')
    bobNow.socket.send(JSON.stringify({ type: 'yjs_update', frameId: 'owner-viewer-write', room: 'yjs:composeDoc:member-owned', updateB64: 'AQ==' }))
    assert.equal((await bobNow.wait(frame => frame.frameId === 'owner-viewer-write')).type, 'yjs_refuse')
    assert.equal((await revokeBoard(member.sessionToken, 'member-owned')).status, 200)
    await adminNow.wait(frame => frame.type === 'ops' && frame.ops?.some((op: Frame) => op.kind === 'compose.share_revoked' && op.targetId === 'member-owned' && op.visibleToMemberIds.includes(admin.member.memberId)))
    assert.equal((await access(admin.sessionToken, 'member-owned')).body.canManage, false, 'Admin cannot restore an author’s now-private board')
    assert.equal((await publish(member.sessionToken, 'member-owned', [viewer.member.memberId])).status, 200)
    assert.equal((await publish(viewer.sessionToken, 'whole-team-return', null)).status, 200)
    adminNow.socket.send(JSON.stringify({ type: 'kick_member', frameId: 'offboard-owner', memberId: member.member.memberId }))
    const kicked = await adminNow.wait(frame => frame.frameId === 'offboard-owner')
    assert.equal(kicked.type, 'kick_ok'); assert.equal(kicked.contentAclCleanupFailed, undefined)
    assert.equal((await access(member.sessionToken, 'member-owned')).status, 401, 'old bearer stops working')
    assert.equal((await access(admin.sessionToken, 'member-owned')).body.owned, true, 'shared ownership transferred')
    assert.equal((await post('/v1/invite/redeem', '', { token: memberInvite.invite.token, deviceId: 'member-device' })).status, 400, 'used original invite cannot bring a removed person back')
    const cancelled = await post('/v1/invite/create', admin.sessionToken, { email: 'bob@example.test', role: 'member' }); assert.equal(cancelled.status, 200)
    assert.equal((await post('/v1/invite/revoke', admin.sessionToken, { id: cancelled.body.id })).status, 200)
    assert.equal((await post('/v1/invite/redeem', '', { token: cancelled.body.token, deviceId: 'member-device' })).status, 400, 'cancelled invitation remains invalid')
    const fresh = await post('/v1/invite/create', admin.sessionToken, { email: 'bob@example.test', role: 'viewer' }); assert.equal(fresh.status, 200)
    const returned = await post('/v1/invite/redeem', '', { token: fresh.body.token, deviceId: 'member-device', memberEmail: 'bob@example.test' }); assert.equal(returned.status, 200)
    assert.notEqual(returned.body.memberId, member.member.memberId); assert.equal(returned.body.role, 'viewer')
    const returning = await connect(returned.body.memberId, 'member-device', returned.body.sessionToken)
    await returning.wait(frame => frame.type === 'catchup_status' && frame.done)
    await returning.assertNo(hasSnapshot)
    for (const [id, expected] of [['member-owned', 'yjs_refuse'], ['whole-team-return', 'yjs_ok'], ['never-shared', 'yjs_refuse']]) {
      returning.socket.send(JSON.stringify({ type: 'yjs_join', frameId: `return-${id}`, room: `yjs:composeDoc:${id}` }))
      assert.equal((await returning.wait(frame => frame.frameId === `return-${id}`)).type, expected)
    }
    assert.equal((await publish(returned.body.sessionToken, 'member-owned', null)).status, 403, 'fresh membership cannot reclaim transferred board')
    await stopBridge(); await startBridge()
    assert.equal((await access(admin.sessionToken, 'member-owned')).body.owned, true)
    assert.equal((await access(returned.body.sessionToken, 'member-owned')).body.canManage, false)
    assert.equal((await post('/v1/invite/redeem', '', { token: cancelled.body.token, deviceId: 'member-device' })).status, 400)
    console.log('PASS owner HTTP publishing, viewer write refusal, exact fanout, Admin cleanup, offboarding transfer, revoked invitation, same-email/device return and durable restart')
    console.log('real bridge collaboration: private-by-default, explicit selected/team audiences, all-role revoke, two server restarts, stale Admin reconnect, viewer/live-role policy, scoped Modules and chat passed')
  } finally {
    for (const socket of sockets) socket.terminate()
    if (child && child.exitCode === null) {
      child.kill('SIGTERM')
      await once(child, 'exit')
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
