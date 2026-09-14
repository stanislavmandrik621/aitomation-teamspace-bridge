/**
 * Real self-host bridge integration: authenticated Compose/Yjs rooms,
 * replace-ACL revocation, live role changes, scoped Modules fanout, and chat.
 */
import assert from 'node:assert/strict'
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
    child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
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
        reject(new Error(`Bridge exited ${code}`))
      })
    })

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
    }))
    assert.equal((await viewerClient.wait((frame) => frame.frameId === 'viewer-awareness')).type, 'yjs_ok')
    const viewerAwareness = await adminClient.wait(
      (frame) => frame.type === 'yjs_peer_awareness' && frame.updateB64 === 'Aw==',
    )
    assert.equal(viewerAwareness.fromMemberId, viewer.member.memberId)

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
    assert.deepEqual(revokedPush.body, { ok: true, count: 0, evicted: 1 })
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
      'yjs_ok',
    )

    assert.equal((await mutateScopedComposeAcl(admin.sessionToken, {
      documentId: 'board-enterprise',
      memberIds: [member.member.memberId],
    })).status, 200)
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

    console.log(
      'real bridge collaboration: Compose ACL join/revoke/rejoin, Yjs authorship, viewer/live-role policy, scoped Modules live+catch-up, and team chat passed',
    )
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
