/** Real invitation routes with concurrent sockets, failed durable writes and delayed timers. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { ChatRoomsStore } from '../src/chat-rooms-store.js'
import { hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
if (process.argv.includes('--server-child')) {
  let failPersist = false, offset = 0
  const originalPersist = (ChatRoomsStore.prototype as any).persistSync, originalNow = Date.now
  ;(ChatRoomsStore.prototype as any).persistSync = function () {
    if (failPersist) throw new Error('Injected room registry write refusal')
    return originalPersist.call(this)
  }
  Date.now = () => originalNow() + offset
  process.on('message', (message: Frame) => {
    if (message.type === 'configure') {
      if (typeof message.failPersist === 'boolean') failPersist = message.failPersist
      if (typeof message.advanceMs === 'number') offset += message.advanceMs
      process.send?.({ type: 'configured', tag: message.tag })
    }
  })
  await import('../src/server.js')
} else {
  const root = mkdtempSync(join(tmpdir(), 'chat-invite-concurrency-'))
  const sockets: WebSocket[] = [], ipc: Frame[] = []
  let child: ReturnType<typeof spawn> | undefined, logs = '', port = 0, serial = 0
  const tokenFor = (member: string, device: string) => `${member}-${device}-token`
  const take = <T>(items: T[], predicate: (item: T) => boolean): T | undefined => {
    const index = items.findIndex(predicate)
    return index < 0 ? undefined : items.splice(index, 1)[0]
  }
  const until = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const result = read()
      if (result !== undefined) return result
      if (child?.exitCode != null) throw new Error(`Bridge exited: ${logs}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out ${label}\n${logs}`)
  }
  async function stop() {
    for (const socket of sockets.splice(0)) socket.terminate()
    if (child && child.exitCode === null) {
      const owned = child, done = once(owned, 'exit'), timer = setTimeout(() => owned.kill('SIGKILL'), 5000)
      owned.kill('SIGTERM')
      try { await done } finally { clearTimeout(timer) }
    }
    child = undefined
  }
  async function start() {
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
    let ready = false
    logs = ''
    child = spawn(process.execPath, ['--import', 'tsx', new URL(import.meta.url).pathname, '--server-child'], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...env,
        TEAMSPACE_DATA_DIR: root, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port),
        TEAMSPACE_EPHEMERAL_ROOMS_PER_MEMBER_MAX: '1', TEAMSPACE_EPHEMERAL_START_TOKENS_PER_MIN: '60', TEAMSPACE_EPHEMERAL_INVITE_TTL_MS: '15000',
      },
    })
    child.on('message', message => ipc.push(message as Frame))
    child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) ready = true })
    child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, 'test recovery key redacted')).slice(-6000) })
    await until(() => ready || undefined, 'startup')
  }
  async function configure(values: Frame) {
    const tag = `configure-${++serial}`
    child!.send({ type: 'configure', tag, ...values })
    await until(() => take(ipc, frame => frame.type === 'configured' && frame.tag === tag), tag)
  }
  async function connect(member: string, device = 'one') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`), inbox: Frame[] = [], all: Frame[] = []
    sockets.push(socket)
    socket.on('message', data => { const frame = JSON.parse(String(data)); inbox.push(frame); all.push(frame) })
    await once(socket, 'open')
    const wait = (predicate: (frame: Frame) => boolean, label = 'response') => until(() => take(inbox, predicate), label)
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId: member, deviceId: device, sessionToken: tokenFor(member, device) }))
    await wait(frame => frame.type === 'hello_ok', `hello ${member}/${device}`)
    return { member, socket, all, wait, request: async (frame: Frame) => {
      const frameId = `request-${++serial}`
      socket.send(JSON.stringify({ ...frame, frameId }))
      return wait(row => row.frameId === frameId || row.requestId === frameId, `${frame.type}:${member}`)
    } }
  }
  const expect = (reply: Frame, type: string) => { assert.equal(reply.type, type, JSON.stringify(reply)); return reply }
  try {
    writeFileSync(join(root, 'team.json'), JSON.stringify({ teamId: 'chat-invite-team', name: 'Invite audit', createdAt: 1 }))
    writeFileSync(join(root, 'members.json'), JSON.stringify(['admin', 'alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'm'.repeat(128)].map(memberId => ({
      memberId, displayName: memberId, email: `${memberId}@example.test`, role: memberId === 'admin' ? 'admin' : 'member', createdAt: 1,
      sessions: Object.fromEntries(['one', 'two'].map(device => [device, hashSessionToken(tokenFor(memberId, device))])),
    }))))
    initializeCurrentAuthority(root,root+'.authority')
    await start()
    let admin = await connect('admin'), alice = await connect('alice'), aliceSecond = await connect('alice', 'two'), bob = await connect('bob')
    const carol = await connect('carol'), dave = await connect('dave'), erin = await connect('erin'), frank = await connect('frank')
    const privateA = expect(await admin.request({ type: 'chat_room_create', kind: 'private', title: 'Invite-only A', memberIds: [] }), 'chat_room_create_ok').room.id
    const privateB = expect(await admin.request({ type: 'chat_room_create', kind: 'private', title: 'Invite-only B', memberIds: [] }), 'chat_room_create_ok').room.id
    expect(await alice.request({ type: 'chat_room_join', room: privateA }), 'chat_refuse')
    expect(await admin.request({ type: 'chat_room_join', room: privateA }), 'chat_room_join_ok') // Existing membership is idempotent.
    const inviteB = expect(await admin.request({ type: 'chat_room_invite', room: privateB }), 'chat_room_invite_ok').inviteToken
    expect(await alice.request({ type: 'chat_room_join', room: privateA, inviteToken: inviteB }), 'chat_refuse')
    for (const invalid of [`${inviteB}\0`, `${inviteB} `, ['wrong']]) expect(await alice.request({ type: 'chat_room_join', room: privateB, inviteToken: invalid }), 'chat_refuse')
    expect(await alice.request({ type: 'chat_room_join', room: `${privateB}\0`, inviteToken: inviteB }), 'chat_refuse')
    expect(await alice.request({ type: 'chat_room_join', room: privateB, inviteToken: inviteB }), 'chat_room_join_ok')
    const singleUse = expect(await admin.request({ type: 'chat_room_invite', room: privateA }), 'chat_room_invite_ok').inviteToken
    const concurrent = await Promise.all([bob, carol].map(peer => peer.request({ type: 'chat_room_join', room: privateA, inviteToken: singleUse })))
    assert.deepEqual(concurrent.map(row => row.type).sort(), ['chat_refuse', 'chat_room_join_ok'])
    const retryToken = expect(await admin.request({ type: 'chat_room_invite', room: privateB }), 'chat_room_invite_ok').inviteToken
    const registry = join(root+'.authority', 'chat', 'rooms.json'), before = readFileSync(registry)
    await configure({ failPersist: true })
    expect(await frank.request({ type: 'chat_room_join', room: privateB, inviteToken: retryToken }), 'chat_refuse')
    assert.deepEqual(readFileSync(registry), before, 'failed redemption never consumes token or grants membership on disk')
    await configure({ failPersist: false })
    expect(await frank.request({ type: 'chat_room_join', room: privateB, inviteToken: retryToken }), 'chat_room_join_ok')
    expect(await erin.request({ type: 'chat_room_join', room: privateB, inviteToken: retryToken }), 'chat_refuse')

    for (const malformed of ['bob\0', `${'b'.repeat(128)}x`]) expect(await admin.request({ type: 'ephemeral_start', targetMemberId: malformed }), 'ephemeral_refuse')
    expect(await admin.request({ type: 'ephemeral_group_start', targetMemberIds: ['alice', 'bob\0'] }), 'ephemeral_refuse')
    const first = expect(await admin.request({ type: 'ephemeral_start', targetMemberId: 'alice' }), 'ephemeral_start_ok')
    const second = expect(await admin.request({ type: 'ephemeral_start', targetMemberId: 'bob' }), 'ephemeral_start_ok')
    expect(await alice.request({ type: 'ephemeral_accept', inviteId: `${first.inviteId}\0` }), 'ephemeral_refuse')
    const simultaneous = await Promise.all([alice, aliceSecond].map(peer => peer.request({ type: 'ephemeral_accept', inviteId: first.inviteId })))
    assert.deepEqual(simultaneous.map(row => row.type).sort(), ['ephemeral_accept_ok', 'ephemeral_refuse'])
    const liveRoom = simultaneous.find(row => row.type === 'ephemeral_accept_ok')!.room
    expect(await bob.request({ type: 'ephemeral_accept', inviteId: second.inviteId }), 'ephemeral_refuse')
    expect(await admin.request({ type: 'ephemeral_leave', room: liveRoom }), 'ephemeral_leave_ok')

    const group = expect(await admin.request({ type: 'ephemeral_group_start', targetMemberIds: ['alice', 'bob'] }), 'ephemeral_group_start_ok')
    expect(await alice.request({ type: 'ephemeral_group_accept', formationId: `${group.formationId}\0` }), 'ephemeral_refuse')
    expect(await alice.request({ type: 'ephemeral_group_accept', formationId: group.formationId }), 'ephemeral_group_accept_ok')
    expect(await aliceSecond.request({ type: 'ephemeral_group_accept', formationId: group.formationId }), 'ephemeral_refuse')
    alice.socket.terminate() // Another device remains; member is still online.
    expect(await bob.request({ type: 'ephemeral_group_accept', formationId: group.formationId }), 'ephemeral_group_accept_ok')
    const formed = await admin.wait(frame => frame.type === 'ephemeral_group_formed' && frame.formationId === group.formationId)
    assert.deepEqual(formed.memberIds, ['admin', 'alice', 'bob'])
    expect(await aliceSecond.request({ type: 'ephemeral_leave', room: formed.room }), 'ephemeral_leave_ok')
    expect(await bob.request({ type: 'ephemeral_leave', room: formed.room }), 'ephemeral_leave_ok')
    const offline = expect(await admin.request({ type: 'ephemeral_group_start', targetMemberIds: ['bob', 'carol'] }), 'ephemeral_group_start_ok')
    expect(await bob.request({ type: 'ephemeral_group_accept', formationId: offline.formationId }), 'ephemeral_group_accept_ok')
    bob.socket.terminate()
    await admin.wait(frame => frame.type === 'ephemeral_group_cancelled' && frame.formationId === offline.formationId, 'accepted invitee offline cancellation')
    expect(await carol.request({ type: 'ephemeral_group_accept', formationId: offline.formationId }), 'ephemeral_refuse')
    bob = await connect('bob')
    const kicked = expect(await admin.request({ type: 'ephemeral_group_start', targetMemberIds: ['dave', 'erin'] }), 'ephemeral_group_start_ok')
    expect(await dave.request({ type: 'ephemeral_group_accept', formationId: kicked.formationId }), 'ephemeral_group_accept_ok')
    expect(await admin.request({ type: 'kick_member', memberId: 'dave' }), 'kick_ok')
    await admin.wait(frame => frame.type === 'ephemeral_group_cancelled' && frame.formationId === kicked.formationId, 'accepted invitee team revoke cancellation')
    expect(await erin.request({ type: 'ephemeral_group_accept', formationId: kicked.formationId }), 'ephemeral_refuse')

    const expiringOne = expect(await admin.request({ type: 'ephemeral_start', targetMemberId: 'frank' }), 'ephemeral_start_ok')
    const expiringGroup = expect(await admin.request({ type: 'ephemeral_group_start', targetMemberIds: ['alice', 'bob'] }), 'ephemeral_group_start_ok')
    await configure({ advanceMs: 15001 }) // Timer has not fired; acceptance itself must enforce the deadline.
    expect(await frank.request({ type: 'ephemeral_accept', inviteId: expiringOne.inviteId }), 'ephemeral_refuse')
    expect(await aliceSecond.request({ type: 'ephemeral_group_accept', formationId: expiringGroup.formationId }), 'ephemeral_refuse')
    assert.equal(readFileSync(registry, 'utf8').includes('eph:'), false, 'temporary room state is never persisted')

    await configure({ advanceMs: 60001 }) // Separate authority-selector coverage from rate-limit denials.
    const exactRoom = expect(await admin.request({ type: 'chat_room_create', kind: 'group', title: 'Exact selectors', memberIds: ['alice', 'bob'] }), 'chat_room_create_ok').room.id
    expect(await admin.request({ type: 'chat_room_promote_owner', room: exactRoom, memberId: 'alice' }), 'chat_room_promote_owner_ok')
    expect(await admin.request({ type: 'chat_room_ban_member', room: exactRoom, memberId: 'erin' }), 'chat_room_ban_member_ok')
    async function refusedMutation(frame: Frame) {
      const old = readFileSync(registry)
      const refused = expect(await admin.request(frame), 'chat_refuse')
      assert.doesNotMatch(String(refused.reason), /rate limit/i, 'must reach selector validation')
      assert.deepEqual(readFileSync(registry), old, 'malformed selection must not mutate any membership')
    }
    for (const type of ['chat_room_add_members', 'chat_room_remove_members', 'chat_room_promote_owner', 'chat_room_demote_owner', 'chat_room_ban_member', 'chat_room_unban_member']) {
      const target = type === 'chat_room_unban_member' ? 'erin' : 'alice'
      await refusedMutation({ type, room: exactRoom, memberIds: ['frank', `${target}\0`], memberId: `${target}\0` })
      await refusedMutation({ type, room: `${exactRoom}\0`, memberIds: ['bob'], memberId: target })
    }
    await refusedMutation({ type: 'chat_room_add_members', room: exactRoom, memberIds: ['frank', 'not-in-this-team'] })
    await refusedMutation({ type: 'chat_room_add_members', room: exactRoom, memberIds: ['m'.repeat(128) + 'x'] })
    await refusedMutation({ type: 'chat_room_remove_members', room: exactRoom, memberIds: ['bob', ['alice']] })
    await refusedMutation({ type: 'chat_room_create', kind: 'group', title: 'Refuse whole batch', memberIds: ['frank', 'alice\0'] })
    await refusedMutation({ type: 'chat_room_create', kind: 'dm', targetMemberId: 'alice\0' })
    expect(await admin.request({ type: 'chat_room_add_members', room: exactRoom, memberIds: ['m'.repeat(128)] }), 'chat_room_add_members_ok')
    expect(await admin.request({ type: 'chat_room_remove_members', room: exactRoom, memberIds: ['m'.repeat(128)] }), 'chat_room_remove_members_ok')
    expect(await admin.request({ type: 'chat_room_create', kind: 'dm', targetMemberId: 'm'.repeat(128) }), 'chat_room_create_ok')
    await stop()
    await start()
    admin = await connect('admin'); alice = await connect('alice')
    expect(await alice.request({ type: 'chat_room_join', room: privateB }), 'chat_room_join_ok')
    expect(await alice.request({ type: 'chat_room_join', room: privateA, inviteToken: singleUse }), 'chat_refuse')
    console.log('chat invite concurrency: invite-only room, exact room/token/member IDs, one-use concurrent accepts, durable failure retry/restart, multi-device acceptance, accepted-member offline/kick cancellation, capacity and delayed-timer TTL passed')
  } finally { await stop(); rmSync(root, { recursive: true, force: true });rmSync(root+'.authority', { recursive: true, force: true }) }
}
