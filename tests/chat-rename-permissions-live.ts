/** Real WebSocket permission boundary for shared chat names. */
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
const root = mkdtempSync(join(tmpdir(), 'chat-rename-permissions-'))
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
    memberId, displayName: memberId, email: `${memberId}@example.test`, role: memberId === 'alice' ? 'admin' : memberId === 'dave' ? 'viewer' : 'member', createdAt: 1,
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
  const server = await start('rename-team')
  const admin = await server.connect('alice'), owner = await server.connect('bob'), member = await server.connect('carol'), viewer = await server.connect('dave')
  for (const kind of ['group', 'private']) {
    const creator = kind === 'private' ? admin : owner
    const made = expectType(await creator.request({ type: 'chat_room_create', kind, title: 'Original', memberIds: ['alice', 'bob', 'carol', 'dave'] }), 'chat_room_create_ok')
    const room = made.room.id
    if (kind === 'private') expectType(await admin.request({ type: 'chat_room_promote_owner', room, memberId: 'bob' }), 'chat_room_promote_owner_ok')
    // Default editInfo is anyone: ordinary members may still edit the description.
    expectType(await member.request({ type: 'chat_room_set_info', room, description: 'Member description' }), 'chat_room_set_info_ok')
    const denied = expectType(await member.request({ type: 'chat_room_rename', room, title: 'Unauthorized name' }), 'chat_refuse')
    assert.match(denied.reason, /owner or team Admin/)
    expectType(await viewer.request({ type: 'chat_room_rename', room, title: 'Viewer name' }), 'chat_refuse')
    const renamed = expectType(await owner.request({ type: 'chat_room_rename', room, title: 'Owner name' }), 'chat_room_rename_ok')
    assert.equal(renamed.title, 'Owner name')
    expectType(await admin.request({ type: 'chat_room_rename', room, title: 'Admin name' }), 'chat_room_rename_ok')
    expectType(await owner.request({ type: 'chat_room_set_permissions', room, editInfo: 'owner_admin' }), 'chat_room_set_permissions_ok')
    expectType(await member.request({ type: 'chat_room_rename', room, title: 'Still unauthorized' }), 'chat_refuse')
    expectType(await owner.request({ type: 'chat_room_rename', room, title: 'Final name' }), 'chat_room_rename_ok')
    const listed = expectType(await member.request({ type: 'chat_rooms_list', limit: 100 }), 'chat_rooms_ok')
    assert.equal(listed.rooms.find((r: Frame) => r.id === room || r.room === room)?.title, 'Final name')
    assert.ok(!member.all.some(r => r.type === 'chat_room_rename_peer' && r.title === 'Unauthorized name'))
  }
  const dm = expectType(await owner.request({ type: 'chat_room_create', kind: 'dm', targetMemberId: 'carol' }), 'chat_room_create_ok').room.id
  expectType(await owner.request({ type: 'chat_room_rename', room: dm, title: 'Shared DM rename' }), 'chat_refuse')
  expectType(await admin.request({ type: 'chat_room_rename', room: 'chat:team', title: 'Team rename' }), 'chat_refuse')
  console.log('PASS live shared rename permissions: group/private owners and team admins allowed; ordinary members denied under both editInfo policies; viewers denied; description permission preserved; final names visible to peers; personal DM labels cannot mutate shared titles')
} finally {
  for (const socket of sockets) socket.terminate()
  for (const child of children) if (child.exitCode === null) {
    const done = once(child, 'exit'), timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.kill('SIGTERM'); try { await done } finally { clearTimeout(timer) }
  }
  rmSync(root, { recursive: true, force: true })
}
