/** Real WebSocket server, four concurrent rooms and two devices for one person. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
const root = mkdtempSync(join(tmpdir(), 'chat-four-room-delivery-'))
const children: ReturnType<typeof spawn>[] = [], sockets: WebSocket[] = []
let serial = 0
const token = (team: string, member: string, device: string) => `fixture-${team}-${member}-${device}`
async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out: ${label}`)
}
function take(rows: Frame[], predicate: (row: Frame) => boolean): Frame | undefined {
  const index = rows.findIndex(predicate)
  return index < 0 ? undefined : rows.splice(index, 1)[0]
}
async function start(team: string) {
  const dir = join(root, team); mkdirSync(dir)
  writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: team, name: team, createdAt: 1 }))
  writeFileSync(join(dir, 'members.json'), JSON.stringify(['alice', 'bob', 'carol', 'dave'].map(memberId => ({
    memberId, displayName: memberId, email: `${memberId}@example.test`, role: memberId === 'alice' ? 'admin' : 'member', createdAt: 1,
    sessions: Object.fromEntries(['one', 'two'].map(device => [device, hashSessionToken(token(team, memberId, device))])),
  }))))
  initializeCurrentAuthority(dir, dir + '.authority')
  const reservation = createServer().listen(0, '127.0.0.1'); await once(reservation, 'listening')
  const port = (reservation.address() as { port: number }).port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
  const child = spawn(process.execPath, ['--import', 'tsx', new URL('../src/server.ts', import.meta.url).pathname], {
    cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
  }); children.push(child)
  let ready = false
  child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) ready = true })
  child.stderr!.on('data', () => {})
  await until(() => { assert.equal(child.exitCode, null, 'fixture server stays alive'); return ready || undefined }, 'server startup')
  async function connect(member: string, device = 'one') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`), inbox: Frame[] = [], all: Frame[] = []
    sockets.push(socket)
    socket.on('message', data => { const row = JSON.parse(String(data)); inbox.push(row); all.push(row) })
    await once(socket, 'open')
    socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId: member, deviceId: device, sessionToken: token(team, member, device) }))
    await until(() => take(inbox, row => row.type === 'hello_ok'), `hello ${team}/${member}/${device}`)
    await until(() => take(inbox, row => row.type === 'catchup_status' && row.done), 'initial catchup')
    return { member, socket, all, request: async (frame: Frame) => {
      const frameId = `four-room-${++serial}`
      socket.send(JSON.stringify({ ...frame, frameId }))
      return until(() => take(inbox, row => (row.frameId === frameId || row.requestId === frameId) && row.type !== 'slow_down'), `${member}:${frame.type}`)
    } }
  }
  return { connect }
}
const expectType = (row: Frame, type: string) => { assert.equal(row.type, type, JSON.stringify(row)); return row }
try {
  const server = await start('team-one'), other = await start('team-two')
  const alice = await server.connect('alice'), aliceSecond = await server.connect('alice', 'two')
  const bob = await server.connect('bob'), carol = await server.connect('carol'), dave = await server.connect('dave')
  const foreign = await other.connect('alice')
  const create = async (title: string, memberIds: string[]) => expectType(await alice.request({ type: 'chat_room_create', kind: 'private', title, memberIds }), 'chat_room_create_ok').room.id as string
  const rooms = ['chat:team', await create('Alice and Bob A', ['bob']), await create('Alice and Bob B', ['bob']), await create('Alice and Carol', ['carol'])]
  const peers = [alice, aliceSecond, bob, carol, dave]
  const allowed = (member: string, room: string) => room === rooms[0] || member === 'alice' || (member === 'bob' && [rooms[1], rooms[2]].includes(room)) || (member === 'carol' && room === rooms[3])
  const expected = new Map(rooms.map(room => [room, new Map<string, string>()]))
  // Same member writes to every room; two different peers concurrently reply.
  await Promise.all(rooms.flatMap((room, roomIndex) => Array.from({ length: 3 }, (_, round) => {
    const writers = [round % 2 ? aliceSecond : alice, roomIndex === 3 ? carol : bob]
    return writers.map(async (writer, writerIndex) => {
      const id = `r${roomIndex}-n${round}-w${writerIndex}`, body = `${id} · ${writer.member} · 中文 👋`
      expected.get(room)!.set(id, body)
      const ack = expectType(await writer.request({ type: 'chat_send', room, body, clientMsgId: id }), 'chat_ok')
      assert.equal(ack.message.room, room); assert.equal(ack.message.body, body)
    })
  }).flat()))
  // A round-trip after the sends is a socket barrier for earlier broadcasts.
  for (const peer of peers) {
    for (const room of rooms) {
      const history = await peer.request({ type: 'chat_history', room, limit: 100 })
      if (!allowed(peer.member, room)) { expectType(history, 'chat_refuse'); continue }
      expectType(history, 'chat_history_ok')
      assert.equal(history.messages.length, 6, `${peer.member}: exactly six rows in ${room}`)
      assert.deepEqual(new Map(history.messages.map((row: Frame) => [row.id, row.body])), expected.get(room))
      assert.ok(history.messages.every((row: Frame) => row.room === room))
    }
    const incoming = peer.all.filter(row => (row.type === 'chat_peer' || row.type === 'chat_ok')).map(row => row.message)
    for (const row of incoming) assert.ok(allowed(peer.member, row.room), `${peer.member} never receives another room's private payload`)
    for (const room of rooms.filter(room => allowed(peer.member, room))) {
      for (const id of expected.get(room)!.keys()) assert.equal(incoming.filter(row => row.room === room && row.id === id).length, 1, `${peer.member}: one live delivery for ${id}`)
    }
  }
  expectType(await foreign.request({ type: 'chat_history', room: 'chat:team', limit: 100 }), 'chat_history_ok')
  assert.equal(JSON.stringify(foreign.all).includes('r0-n0-w0'), false, 'same member ID in another team receives no payload')
  // Two devices retry one acknowledged send concurrently; never duplicate history.
  const retryId = 'r1-n0-w0', retryBody = expected.get(rooms[1])!.get(retryId)!
  await Promise.all([alice, aliceSecond].map(async peer => expectType(await peer.request({ type: 'chat_send', room: rooms[1], body: retryBody, clientMsgId: retryId }), 'chat_ok')))
  const restored = await server.connect('bob', 'two')
  for (const room of rooms.slice(1, 3)) {
    const history = expectType(await restored.request({ type: 'chat_history', room, limit: 100 }), 'chat_history_ok')
    assert.equal(history.messages.length, 6, 'reconnect recovers both Bob rooms without duplicate retries')
  }
  const denied = await carol.request({ type: 'chat_send', room: rooms[1], body: 'MUST_NOT_LEAK', clientMsgId: 'denied' })
  expectType(denied, 'chat_refuse')
  const final = expectType(await alice.request({ type: 'chat_history', room: rooms[1], limit: 100 }), 'chat_history_ok')
  assert.equal(final.messages.length, 6)
  const mentions = await Promise.all(rooms.map((room, i) => alice.request({ type: 'chat_send', room, body: `Hello @${i === 3 ? 'carol' : 'bob'}`, clientMsgId: `mention-${i}` })))
  for (const ack of mentions) expectType(ack, 'chat_ok')
  const listed = async (peer: typeof bob) => expectType(await peer.request({ type: 'chat_rooms_list' }), 'chat_rooms_ok').rooms as Frame[]
  const bobRooms = await listed(bob), carolRooms = await listed(carol)
  assert.deepEqual(rooms.slice(0, 3).map(room => bobRooms.find(r => r.id === room)?.unreadMentions), [1, 1, 1])
  assert.equal(carolRooms.find(r => r.id === rooms[0])?.unreadMentions, 0, 'another recipient does not get Bob mention badges')
  assert.equal(carolRooms.find(r => r.id === rooms[3])?.unreadMentions, 1)
  assert.equal((await listed(foreign)).find(r => r.id === 'chat:team')?.unreadMentions, 0, 'same room ID in another team has no mention')
  expectType(await bob.request({ type: 'chat_unread_set', room: rooms[1], watermarkMs: mentions[1].message.createdAt }), 'chat_unread_set_ok')
  assert.equal((await listed(restored)).find(r => r.id === rooms[1])?.unreadMentions, 0, 'read acknowledgement clears the badge for the same person on another device')
  assert.equal((await listed(restored)).find(r => r.id === rooms[2])?.unreadMentions, 1, 'reading one room preserves unread mentions in another')
  console.log('PASS four concurrent rooms: overlapping/different participants, same person on two devices, exact live delivery, isolated history, retry dedup, reconnect, cross-team isolation, recipient-specific mention badges and read acknowledgement across devices')
} finally {
  for (const socket of sockets) socket.terminate()
  for (const child of children) if (child.exitCode === null) {
    const done = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.kill('SIGTERM'); try { await done } finally { clearTimeout(timer) }
  }
  rmSync(root, { recursive: true, force: true })
}
