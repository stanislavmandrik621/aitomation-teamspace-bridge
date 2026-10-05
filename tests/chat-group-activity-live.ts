/** Membership activity is durable, visible to invitees, and confined to the room. */
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
  const root = mkdtempSync(join(tmpdir(), 'chat-group-activity-'))
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
    const nativeAdmin = 'local:admin-pro@example.test'
    writeFileSync(join(root, 'team.json'), JSON.stringify({ teamId: 'activity-team', name: 'Test team', createdAt: 1 }))
    writeFileSync(join(root, 'members.json'), JSON.stringify([nativeAdmin, 'alice', 'bob', 'carol', 'outsider'].map(memberId => ({
      memberId, displayName: memberId === nativeAdmin ? 'Admin' : memberId, email: `${memberId}@example.test`, role: memberId === nativeAdmin ? 'admin' : 'member', createdAt: 1,
      sessions: Object.fromEntries(['one', 'two'].map(device => [device, hashSessionToken(tokenFor(memberId, device))])),
    }))))
    initializeCurrentAuthority(root, root + '.authority')
    await start()
    let admin = await connect(nativeAdmin), alice = await connect('alice'), bob = await connect('bob')
    const outsider = await connect('outsider')
    const activity = (peer: typeof admin, room: string) => peer.all.filter(frame => frame.type === 'chat_peer' && frame.message?.room === room && frame.message.kind === 'system').map(frame => frame.message)
    const waitActivity = (peer: typeof admin, room: string, count: number) => until(() => activity(peer, room).length >= count ? activity(peer, room) : undefined, `${count} activity messages`)
    const history = async (peer: typeof admin, room: string) => expect(await peer.request({type:'chat_history',room,limit:100}), 'chat_history_ok').messages as Frame[]

    // Native bootstrap admin identities must work for DMs as well as groups.
    const dm = expect(await admin.request({type:'chat_room_create',kind:'dm',targetMemberId:'alice'}), 'chat_room_create_ok').room.id
    assert.equal(expect(await alice.request({type:'chat_room_create',kind:'dm',targetMemberId:nativeAdmin}), 'chat_room_create_ok').room.id, dm)
    const group = expect(await admin.request({type:'chat_room_create',kind:'group',title:'Design team',memberIds:['alice']}), 'chat_room_create_ok').room.id
    const initial = await waitActivity(alice, group, 2)
    assert.deepEqual(initial.map(row => row.body), ['Admin created the group “Design team”.', 'Admin added alice to “Design team”.'])
    await waitActivity(admin, group, 2)
    assert.equal(activity(outsider, group).length, 0)
    assert.equal((await history(alice, group)).length, 2)

    expect(await admin.request({type:'chat_room_add_members',room:group,memberIds:['bob']}), 'chat_room_add_members_ok')
    await waitActivity(alice, group, 3)
    assert.equal((await waitActivity(bob, group, 1))[0].body, 'Admin added bob to “Design team”.')
    assert.equal((await history(bob, group)).length, 3, 'newly added user can read the saved creation and invitation entries')
    expect(await admin.request({type:'chat_room_add_members',room:group,memberIds:['bob','bob']}), 'chat_room_add_members_ok')
    assert.equal((await history(alice, group)).length, 3, 'idempotent additions do not duplicate history')

    await configure({failPersist:true})
    expect(await admin.request({type:'chat_room_add_members',room:group,memberIds:['carol']}), 'chat_refuse')
    await configure({failPersist:false})
    assert.equal((await history(alice, group)).length, 3, 'refused registry writes do not invent activity')
    expect(await bob.request({type:'chat_room_remove_members',room:group,memberIds:['alice']}), 'chat_refuse')
    assert.equal((await history(alice, group)).length, 3, 'unauthorized removals do not invent activity')

    expect(await admin.request({type:'chat_room_remove_members',room:group,memberIds:['bob']}), 'chat_room_remove_members_ok')
    assert.equal((await waitActivity(alice, group, 4)).at(-1).body, 'Admin removed bob from “Design team”.')
    assert.equal(activity(bob, group).length, 1, 'removal never bypasses the current room ACL to deliver history')
    expect(await bob.request({type:'chat_history',room:group,limit:100}), 'chat_refuse')
    expect(await admin.request({type:'chat_room_remove_members',room:group,memberIds:['bob']}), 'chat_room_remove_members_ok')
    assert.equal((await history(alice, group)).length, 4)

    expect(await alice.request({type:'chat_room_leave',room:group}), 'chat_room_leave_ok')
    assert.equal((await waitActivity(admin, group, 5)).at(-1).body, 'alice left “Design team”.')
    expect(await alice.request({type:'chat_room_join',room:group}), 'chat_room_join_ok')
    assert.equal((await waitActivity(admin, group, 6)).at(-1).body, 'alice joined “Design team”.')
    expect(await alice.request({type:'chat_room_join',room:group}), 'chat_room_join_ok')
    assert.equal((await history(alice, group)).length, 6)

    const privateRoom = expect(await admin.request({type:'chat_room_create',kind:'private',title:'Private design',memberIds:[]}), 'chat_room_create_ok').room.id
    await waitActivity(admin, privateRoom, 1)
    const invite = expect(await admin.request({type:'chat_room_invite',room:privateRoom}), 'chat_room_invite_ok').inviteToken
    // The inviter and the existing transcript survive a full server restart.
    await stop(); await start()
    admin = await connect(nativeAdmin); alice = await connect('alice'); bob = await connect('bob')
    const carol = await connect('carol')
    expect(await carol.request({type:'chat_room_join',room:privateRoom,inviteToken:invite}), 'chat_room_join_ok')
    const joined = (await waitActivity(carol, privateRoom, 1))[0]
    assert.equal(joined.body, 'carol joined “Private design” using an invitation from Admin.')
    assert.equal((await history(carol, privateRoom)).length, 2)
    expect(await bob.request({type:'chat_history',room:privateRoom,limit:100}), 'chat_refuse')
    const restored = await history(alice, group)
    assert.equal(restored.length, 6)
    assert.ok(restored.every(message => message.kind === 'system' && message.memberId === 'system'))
    expect(await alice.request({type:'chat_edit',room:group,messageId:restored[0].id,body:'Forged membership history'}), 'chat_refuse')
    expect(await admin.request({type:'chat_room_ban_member',room:group,memberId:'alice'}), 'chat_room_ban_member_ok')
    assert.equal((await waitActivity(admin, group, 1)).at(-1).body, 'Admin banned alice from “Design team”.')
    console.log('PASS: native-admin DM creation; group create/add/remove/join/leave/ban history; invite attribution after restart; actor + invitee delivery; no duplicate/failed/refused events; outsider and removal ACLs; immutable system messages')
  } finally { await stop(); rmSync(root, {recursive:true,force:true}); rmSync(root+'.authority', {recursive:true,force:true}) }
}
