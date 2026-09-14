/** Real isolated bridge sockets: lost ACKs, seeded races and diagnostic canaries. */
import assert from 'node:assert/strict'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { ChatStore } from '../src/chat-store.js'
import { hashSessionToken } from '../src/store.js'

if (process.argv.includes('--server-child')) {
  let gate: { phase: string; release: () => void; promise: Promise<void> } | undefined
  process.on('message', (message: any) => {
    if (message.type === 'arm') {
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      gate = { phase: message.phase, release, promise }
      process.send?.({ type: 'armed' })
    } else if (message.type === 'release') gate?.release()
  })
  const append = ChatStore.prototype.append
  ChatStore.prototype.append = async function (input) {
    const held = gate
    if (!held) return append.call(this, input)
    if (held.phase === 'before') {
      process.send?.({ type: 'held' }); await held.promise
    }
    const result = await append.call(this, input)
    if (held.phase === 'after') {
      process.send?.({ type: 'held' }); await held.promise
    }
    gate = undefined
    process.send?.({ type: 'released' })
    return result
  }
  await import('../src/server.js')
} else {
  const root = mkdtempSync(join(tmpdir(), 'chat-network-seeded-'))
  const children: ReturnType<typeof spawn>[] = [], sockets: WebSocket[] = []
  const canaries = ['PRIVATE_BODY_CANARY_72b8e9', 'PASSWORD_CANARY_72b8e9', 'TOKEN_CANARY_72b8e9']
  const initialSeed = Number(process.env.CHAT_RACE_SEED || 0x72b8e9)
  assert.ok(Number.isSafeInteger(initialSeed) && initialSeed > 0 && initialSeed <= 0xffffffff)
  const offlineMs = Number(process.env.CHAT_OFFLINE_MS || 60000)
  assert.ok(Number.isSafeInteger(offlineMs) && offlineMs >= 60000 && offlineMs <= 24 * 60 * 60 * 1000)
  let logs = '', sequence = 0, seed = initialSeed
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296 }
  const wait = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const result = read(); if (result !== undefined) return result
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Timed out: ' + label)
  }
  const take = <T>(items: T[], test: (item: T) => boolean) => { const i = items.findIndex(test); return i < 0 ? undefined : items.splice(i, 1)[0] }
  try {
    async function start(team: string) {
      const dir = join(root, team)
      const { mkdirSync } = await import('node:fs'); mkdirSync(dir)
      writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: team, name: team, createdAt: 1 }))
      const token = (id: string) => `${canaries[2]}-${team}-${id}`
      writeFileSync(join(dir, 'members.json'), JSON.stringify(['owner','member','outsider'].map(id => ({ memberId: id, displayName: id,
        email: id + '@synthetic.invalid', role: id === 'owner' ? 'admin' : 'member', createdAt: 1, sessions: { [id]: hashSessionToken(token(id)) } }))))
      const reserve = createServer().listen(0, '127.0.0.1'); await once(reserve, 'listening')
      const port = (reserve.address() as { port: number }).port
      await new Promise<void>(resolve => reserve.close(() => resolve()))
      const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
      initializeCurrentAuthority(dir,dir+'.authority')
      const child = spawn(process.execPath, ['--import','tsx',new URL(import.meta.url).pathname,'--server-child'], {
        stdio: ['ignore','pipe','pipe','ipc'], env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
      }); children.push(child)
      let ready = false; const ipc: any[] = []
      child.on('message', message => ipc.push(message))
      child.stdout!.on('data', chunk => { const value = String(chunk); logs += value; if (value.includes('bridge listening')) ready = true })
      child.stderr!.on('data', chunk => { logs += String(chunk) })
      await wait(() => ready || undefined, 'startup')
      const ipcWait = (type: string) => wait(() => take(ipc, row => row.type === type), type)
      async function connect(id: string) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`), frames: any[] = [], all: any[] = []
        sockets.push(ws); ws.on('message', data => { const frame = JSON.parse(String(data)); frames.push(frame); all.push(frame) })
        await once(ws, 'open')
        ws.send(JSON.stringify({ type:'hello',protocolVersion:2,memberId:id,deviceId:id,sessionToken:token(id) }))
        await wait(() => take(frames, row => row.type === 'hello_ok'), 'hello')
        await wait(() => take(frames, row => row.type === 'catchup_status' && row.done), 'catchup')
        const request = async (frame: any) => {
          const frameId = 'seed-' + (++sequence)
          ws.send(JSON.stringify({ ...frame, frameId }))
          return wait(() => take(frames, row => row.frameId === frameId && row.type !== 'slow_down'), frame.type)
        }
        return { ws, request, all }
      }
      return { child, ipcWait, connect, port, token }
    }
    const a = await start('project-a'), b = await start('project-b')
    const owner = await a.connect('owner'), outsider = await a.connect('outsider'), foreign = await b.connect('owner')
    let member = await a.connect('member')
    const created = await owner.request({ type:'chat_room_create',kind:'private',title:'Seeded private fixture',memberIds:['member'],password:canaries[1] })
    assert.equal(created.type, 'chat_room_create_ok'); const room = created.room.id
    const original = await owner.request({ type:'chat_send',room,body:canaries[0],clientMsgId:'shared-cross-project-id' })
    assert.equal(original.type, 'chat_ok')
    const foreignSend = await foreign.request({ type:'chat_send',room:'chat:team',body:'Foreign project fixture',clientMsgId:'shared-cross-project-id' })
    assert.equal(foreignSend.type, 'chat_ok', 'different teams may reuse a client message ID')
    for (const client of [outsider, foreign]) {
      for (const type of ['chat_history','chat_search','chat_jump','chat_export']) {
        const result = await client.request({ type,room,query:'CANARY',messageId:original.message.id,format:'json' })
        if (client === foreign && type === 'chat_export') {
          // Admin exports are server-local, including empty unknown-room exports.
          assert.equal(result.type, 'chat_export_ok')
          assert.deepEqual(JSON.parse(result.body), { room, truncated: false, messages: [] })
        } else assert.equal(result.type, 'chat_refuse', type + ': private/foreign room refused')
        assert.equal(JSON.stringify(result).includes(canaries[0]), false)
      }
    }
    const wrongAuth = await fetch(`http://127.0.0.1:${b.port}/v1/backups/export.zip`, { headers: { Authorization:'Bearer ' + a.token('owner') } })
    assert.equal(wrongAuth.ok, false, 'project A credentials cannot export project B')

    for (const phase of ['before','after']) {
      a.child.send!({ type:'arm',phase }); await a.ipcWait('armed')
      const clientMsgId = 'disconnect-' + phase
      member.ws.send(JSON.stringify({ type:'chat_send',frameId:clientMsgId,room,body:'Network canary ' + phase,clientMsgId }))
      await a.ipcWait('held')
      const closed = once(member.ws, 'close'); member.ws.terminate(); await closed
      a.child.send!({ type:'release' }); await a.ipcWait('released')
      member = await a.connect('member')
      const retry = await member.request({ type:'chat_send',room,body:'Network canary ' + phase,clientMsgId })
      assert.equal(retry.type, 'chat_ok', phase + ': retry accepted')
      const history = await owner.request({ type:'chat_history',room,limit:100 })
      assert.equal(history.messages.filter((row: any) => row.id === retry.message.id).length, 1, phase + ': exactly one durable message')
    }

    // Keep a send genuinely disconnected while access changes. Resuming the
    // old socket work and replaying the queued intent must both fail closed.
    a.child.send!({ type:'arm',phase:'before' }); await a.ipcWait('armed')
    member.ws.send(JSON.stringify({ type:'chat_send',frameId:'offline-revoked',room,body:'Offline revoked canary',clientMsgId:'offline-revoked' }))
    await a.ipcWait('held')
    const closed = once(member.ws,'close'); member.ws.terminate(); await closed
    assert.equal((await owner.request({ type:'chat_room_remove_members',room,memberIds:['member'] })).type,'chat_room_remove_members_ok')
    const offlineStarted = Date.now()
    console.log(JSON.stringify({phase:'offline-after-revocation',startedAt:new Date(offlineStarted).toISOString(),offlineMs}))
    await new Promise(resolve => setTimeout(resolve, offlineMs))
    assert.ok(Date.now() - offlineStarted >= offlineMs, 'the offline duration must elapse in real time')
    a.child.send!({ type:'release' }); await a.ipcWait('released')
    member = await a.connect('member')
    assert.equal((await member.request({ type:'chat_send',room,body:'Offline revoked canary',clientMsgId:'offline-revoked' })).type,'chat_refuse')
    const offlineHistory = await owner.request({ type:'chat_history',room,limit:100 })
    assert.ok(!offlineHistory.messages.some((row: any) => row.id === 'offline-revoked'))
    assert.equal((await owner.request({ type:'chat_room_add_members',room,memberIds:['member'] })).type,'chat_room_add_members_ok')

    assert.equal((await owner.request({ type:'chat_room_set_permissions',room,pinMessages:'anyone' })).type, 'chat_room_set_permissions_ok')
    for (let round = 0; round < 12; round++) {
      const sent = await member.request({ type:'chat_send',room,body:'Race original ' + round,clientMsgId:'race-' + round })
      assert.equal(sent.type, 'chat_ok'); const messageId = sent.message.id
      const actions = [
        () => member.request({ type:'chat_edit',room,messageId,body:'Race edit ' + round }),
        () => member.request({ type:'chat_react',room,messageId,emoji:'👍' }),
        () => member.request({ type:'chat_pin',room,messageId,pinned:true }),
        () => member.request({ type:'chat_unsend',room,messageId }),
        () => owner.request({ type:'chat_room_remove_members',room,memberIds:['member'] }),
      ]
      for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [actions[i],actions[j]] = [actions[j],actions[i]] }
      const results = await Promise.all(actions.map(async action => { await new Promise(resolve => setTimeout(resolve, Math.floor(random() * 12))); return action() }))
      assert.ok(results.some(row => row.type === 'chat_room_remove_members_ok'))
      assert.ok(results.every(row => row.type === 'chat_refuse' || row.type.endsWith('_ok')), 'all operations settle explicitly')
      const denied = await member.request({ type:'chat_send',room,body:'Revoked canary',clientMsgId:'revoked-' + round })
      assert.equal(denied.type, 'chat_refuse', 'no send ACK after revocation completes')
      const removed = await owner.request({ type:'chat_delete',room,messageId })
      assert.equal(removed.type, 'chat_delete_ok')
      const history = await owner.request({ type:'chat_history',room,limit:100 })
      assert.equal(history.type, 'chat_history_ok')
      assert.ok(!history.messages.some((row: any) => row.id === messageId && !row.deletedAt))
      assert.ok(!history.pinnedMessageIds.includes(messageId), 'deleted message must not remain pinned')
      assert.equal((await owner.request({ type:'chat_room_add_members',room,memberIds:['member'] })).type, 'chat_room_add_members_ok')
    }
    assert.equal(outsider.all.some(frame => JSON.stringify(frame).includes(canaries[0])), false, 'outsider fanout never receives private body')
    assert.equal(foreign.all.some(frame => JSON.stringify(frame).includes(canaries[0])), false, 'other project never receives private body')
    for (const canary of canaries) assert.equal(logs.includes(canary), false, 'server diagnostics must omit body/password/token canaries')
    console.log(`PASS seed ${initialSeed}: two isolated production servers, private/foreign reads, wrong-team backup auth, TCP loss before/after commit, exactly-once retries, ${offlineMs / 1000}-second offline revocation, 12 combined edit/react/pin/unsend/revoke races, deleted pins and diagnostic canaries`)
  } finally {
    sockets.forEach(socket => socket.terminate())
    for (const child of children) if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    rmSync(root, { recursive:true,force:true })
  }
}
