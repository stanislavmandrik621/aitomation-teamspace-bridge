/** Real WebSocket routes, with deterministic pauses at the disk/commit boundary. */
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
import { ChatUnreadStore } from '../src/chat-unread-store.js'
import { hashSessionToken } from '../src/store.js'

type Frame = Record<string, any>
if (process.argv.includes('--server-child')) {
  let failUnreadPersistence = false
  const persistUnread = (ChatUnreadStore.prototype as any).persistSync
  ;(ChatUnreadStore.prototype as any).persistSync = function () {
    if (failUnreadPersistence) throw new Error('Injected temporary unread disk failure')
    return persistUnread.call(this)
  }
  const gates = new Map<string, { tag: string; release: () => void; promise: Promise<void>; claimed?: boolean }>()
  process.on('message', (message: any) => {
    if (message.type === 'unreadFailure') {
      failUnreadPersistence = message.enabled === true
      process.send?.({ type: 'configured', tag: message.tag })
    } else if (message.type === 'arm') {
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      gates.set(message.method, { tag: message.tag, release, promise })
      process.send?.({ type: 'armed', tag: message.tag })
    } else if (message.type === 'release') {
      for (const gate of gates.values()) if (gate.tag === message.tag) gate.release()
    }
  })
  for (const method of ['readRecent', 'searchRoom', 'jumpToMessage', 'exportRoom', 'react', 'append', 'edit', 'authorUnsend', 'pinMessage', 'unpinMessage', 'softDelete']) {
    const original = (ChatStore.prototype as any)[method]
    ;(ChatStore.prototype as any)[method] = async function (...args: any[]) {
      const gate = gates.get(method)
      if (!gate || gate.claimed) return original.apply(this, args)
      gate.claimed = true
      const mutation = ['react','append','edit','authorUnsend','pinMessage','unpinMessage','softDelete'].includes(method)
      // Reads pause after obtaining the real private result; reactions pause
      // immediately before entering the actual store's queued authorization.
      const value = mutation ? undefined : await original.apply(this, args)
      process.send?.({ type: 'held', tag: gate.tag })
      await gate.promise
      gates.delete(method)
      const result = mutation ? await original.apply(this, args) : value
      process.send?.({ type: 'released', tag: gate.tag })
      return result
    }
  }
  await import('../src/server.js')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'chat-authority-live-'))
  const sockets: WebSocket[] = []
  let child: ReturnType<typeof spawn> | undefined
  let logs = ''
  const ipc: any[] = []
  const waitFor = async <T>(read: () => T | undefined, label: string): Promise<T> => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const result = read()
      if (result !== undefined) return result
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(`Timed out: ${label}\n${logs}`)
  }
  const take = <T>(items: T[], predicate: (item: T) => boolean): T | undefined => {
    const index = items.findIndex(predicate)
    return index < 0 ? undefined : items.splice(index, 1)[0]
  }
  const waitIpc = (type: string, tag: string) => waitFor(() => take(ipc, message => message.type === type && message.tag === tag), `${type}:${tag}`)
  try {
    writeFileSync(join(dir, 'team.json'), JSON.stringify({ teamId: 'chat-authority-team', name: 'Chat audit', createdAt: 1 }))
    writeFileSync(join(dir, 'members.json'), JSON.stringify(['mem_admin', 'mem_member', 'mem_other'].map(memberId => ({
      memberId, displayName: memberId, email: `${memberId}@example.test`, createdAt: 1,
      role: memberId === 'mem_admin' ? 'admin' : 'member',
      sessions: { [memberId]: hashSessionToken(`${memberId}-token`) },
    }))))
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = (reservation.address() as { port: number }).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith('TEAMSPACE_')) delete env[key]
    initializeCurrentAuthority(dir,dir+'.authority')
    child = spawn(process.execPath, ['--import', 'tsx', new URL(import.meta.url).pathname, '--server-child'], {
      cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...env, TEAMSPACE_DATA_DIR: dir, TEAMSPACE_BRIDGE_HOST: '127.0.0.1', TEAMSPACE_BRIDGE_PORT: String(port) },
    })
    child.on('message', message => ipc.push(message))
    child.stderr!.on('data', data => { logs = (logs + String(data).replace(/admin recovery key generated[^\n]*/g, 'test recovery key redacted')).slice(-6000) })
    let listening = false
    child.stdout!.on('data', data => { if (String(data).includes('bridge listening')) listening = true })
    await waitFor(() => listening || undefined, 'bridge startup')
    async function connect(memberId: string) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}`)
      sockets.push(socket)
      const inbox: Frame[] = [], all: Frame[] = []
      socket.on('message', data => { const frame = JSON.parse(String(data)); inbox.push(frame); all.push(frame) })
      await once(socket, 'open')
      const wait = (predicate: (frame: Frame) => boolean) => waitFor(() => take(inbox, predicate), 'WebSocket response')
      const hello = async (identity: string) => {
        socket.send(JSON.stringify({ type: 'hello', protocolVersion: 2, memberId: identity, deviceId: identity, sessionToken: `${identity}-token` }))
        await wait(frame => frame.type === 'hello_ok')
        await wait(frame => frame.type === 'catchup_status' && frame.done)
      }
      const request = async (frame: Frame) => { socket.send(JSON.stringify(frame)); return wait(row => row.frameId === frame.frameId) }
      await hello(memberId)
      return { socket, all, wait, request, hello }
    }
    const admin = await connect('mem_admin'), member = await connect('mem_member')
    const created = await admin.request({ type: 'chat_room_create', frameId: 'create', kind: 'private', title: 'Private authority race', memberIds: ['mem_member'] })
    assert.equal(created.type, 'chat_room_create_ok', JSON.stringify(created))
    const room = created.room.id
    assert.equal(typeof room, 'string', JSON.stringify(created))
    const sent = await admin.request({ type: 'chat_send', frameId: 'send', room, body: 'private audit text', clientMsgId: 'm'.repeat(128) })
    assert.equal(sent.type, 'chat_ok', JSON.stringify(sent))
    const messageId = sent.message.id
    for (const type of ['chat_delete', 'chat_edit', 'chat_react', 'chat_pin', 'chat_jump', 'chat_unsend']) {
      for (const suffix of ['x', '\0suffix']) {
        const response = await admin.request({ type, frameId: `${type}-invalid-${suffix.length}`, room,
          messageId: messageId + suffix, body: 'must not overwrite', emoji: '👍', pinned: true })
        assert.equal(response.type, 'chat_refuse', `${type} cannot truncate onto another message`)
      }
    }
    const collision = await admin.request({ type: 'chat_send', frameId: 'invalid-client-id', room, body: 'must not false-ack', clientMsgId: `${messageId}x` })
    assert.equal(collision.type, 'chat_refuse')
    const invalidWatermark = await member.request({ type: 'chat_unread_set', frameId: 'invalid-watermark-id', room, lastReadAt: 100, lastReadMsgId: `${messageId}x` })
    assert.equal(invalidWatermark.type, 'chat_refuse')
    const cases = [
      { method: 'readRecent', type: 'chat_history', payload: {} },
      { method: 'searchRoom', type: 'chat_search', payload: { query: 'private' } },
      { method: 'jumpToMessage', type: 'chat_jump', payload: { messageId } },
      { method: 'exportRoom', type: 'chat_export', payload: { format: 'json' } },
    ]
    for (const entry of cases) {
      for (const mutation of entry.type === 'chat_export' ? ['rebind'] : ['remove', 'rebind']) {
        const client = entry.type === 'chat_export' ? admin : member
        const identity = entry.type === 'chat_export' ? 'mem_admin' : 'mem_member'
        const tag = `${entry.type}-${mutation}`
        child.send!({ type: 'arm', method: entry.method, tag }); await waitIpc('armed', tag)
        client.socket.send(JSON.stringify({ type: entry.type, frameId: tag, room, ...entry.payload }))
        await waitIpc('held', tag)
        if (mutation === 'remove') {
          const removed = await admin.request({ type: 'chat_room_remove_members', frameId: `remove-${tag}`, room, memberIds: ['mem_member'] })
          assert.equal(removed.type, 'chat_room_remove_members_ok', JSON.stringify(removed))
        } else await client.hello('mem_other')
        child.send!({ type: 'release', tag }); await waitIpc('released', tag)
        await new Promise(resolve => setTimeout(resolve, 50))
        assert.equal(client.all.some(frame => frame.frameId === tag && frame.type.endsWith('_ok')), false, `${tag} cannot release old private result`)
        if (mutation === 'remove') {
          const added = await admin.request({ type: 'chat_room_add_members', frameId: `add-${tag}`, room, memberIds: ['mem_member'] })
          assert.equal(added.type, 'chat_room_add_members_ok', JSON.stringify(added))
        } else await client.hello(identity)
      }
    }
    const owned=await member.request({type:'chat_send',frameId:'own-before-races',room,body:'Original owned message',clientMsgId:'owned-race-message'})
    assert.equal(owned.type,'chat_ok');const ownId=owned.message.id
    await admin.request({type:'chat_room_set_permissions',frameId:'allow-pin-races',room,pinMessages:'anyone'})
    const mutations=[
      {method:'append',type:'chat_send',payload:{body:'Must never commit',clientMsgId:'revoked-send'}},
      {method:'edit',type:'chat_edit',payload:{messageId:ownId,body:'Must never commit'}},
      {method:'authorUnsend',type:'chat_unsend',payload:{messageId:ownId}},
      {method:'pinMessage',type:'chat_pin',payload:{messageId:ownId,pinned:true}},
      {method:'unpinMessage',type:'chat_pin',payload:{messageId:ownId,pinned:false}},
      {method:'react',type:'chat_react',payload:{messageId:ownId,emoji:'👍'}},
    ]
    for(const entry of mutations){
      if(entry.method==='unpinMessage')await admin.request({type:'chat_pin',frameId:'prepare-unpin',room,messageId:ownId,pinned:true})
      const before=await admin.request({type:'chat_history',frameId:'before-'+entry.method,room,limit:100})
      const tag='queued-'+entry.method
      child.send!({type:'arm',method:entry.method,tag});await waitIpc('armed',tag)
      member.socket.send(JSON.stringify({type:entry.type,frameId:tag,room,...entry.payload}));await waitIpc('held',tag)
      const removal=await admin.request({type:'chat_room_remove_members',frameId:'revoke-'+tag,room,memberIds:['mem_member']});assert.equal(removal.type,'chat_room_remove_members_ok')
      child.send!({type:'release',tag});await waitIpc('released',tag)
      const result=await member.wait(frame=>frame.frameId===tag);assert.equal(result.type,'chat_refuse',tag)
      const after=await admin.request({type:'chat_history',frameId:'after-'+entry.method,room,limit:100})
      assert.deepEqual(after.messages,before.messages,tag+' leaves messages untouched');assert.deepEqual(after.pinnedMessageIds,before.pinnedMessageIds,tag+' leaves pins untouched')
      await admin.request({type:'chat_room_add_members',frameId:'restore-'+tag,room,memberIds:['mem_member']})
    }
    {
      const tag='queued-admin-delete-rebind';child.send!({type:'arm',method:'softDelete',tag});await waitIpc('armed',tag)
      admin.socket.send(JSON.stringify({type:'chat_delete',frameId:tag,room,messageId:ownId}));await waitIpc('held',tag)
      await admin.hello('mem_other');child.send!({type:'release',tag});await waitIpc('released',tag);await new Promise(r=>setTimeout(r,50));assert.equal(admin.all.some(f=>f.frameId===tag&&f.type==='chat_delete_ok'),false)
      await admin.hello('mem_admin');const after=await admin.request({type:'chat_jump',frameId:'after-delete-rebind',room,messageId:ownId});assert.equal(after.message.body,'Original owned message')
    }
    console.log('chat async authority: queued send/edit/unsend/pin/unpin/reaction after removal and delete after identity rebind preserved state')
    const tag = 'reaction-policy-commit'
    child.send!({ type: 'arm', method: 'react', tag }); await waitIpc('armed', tag)
    member.socket.send(JSON.stringify({ type: 'chat_react', frameId: tag, room, messageId, emoji: '👍' }))
    await waitIpc('held', tag)
    const policy = await admin.request({ type: 'chat_room_set_reactions', frameId: 'restrict-reactions', room, allowedReactionEmojis: ['❤️'] })
    assert.equal(policy.type, 'chat_room_set_reactions_ok', JSON.stringify(policy))
    child.send!({ type: 'release', tag }); await waitIpc('released', tag)
    const reaction = await member.wait(frame => frame.frameId === tag)
    assert.equal(reaction.type, 'chat_refuse', JSON.stringify(reaction))
    const current = await admin.request({ type: 'chat_jump', frameId: 'after-reaction', room, messageId })
    assert.equal(current.message.reactions?.['👍'], undefined, 'queued reaction policy refusal must not write')
    const watermark = await member.request({ type: 'chat_unread_set', frameId: 'watermark', room, lastReadAt: 100, lastReadMsgId: messageId })
    assert.equal(watermark.type, 'chat_unread_set_ok', JSON.stringify(watermark))
    child.send!({ type: 'unreadFailure', enabled: true, tag: 'disk-failure' }); await waitIpc('configured', 'disk-failure')
    const failedMark = await member.request({ type: 'chat_unread_set', frameId: 'failed-watermark', room, lastReadAt: 200, lastReadMsgId: 'not-committed' })
    assert.equal(failedMark.type, 'chat_refuse', 'disk failure cannot acknowledge an unread write')
    const removal = await admin.request({ type: 'chat_room_remove_members', frameId: 'remove-with-unread-failure', room, memberIds: ['mem_member'] })
    assert.equal(removal.type, 'chat_room_remove_members_ok', JSON.stringify(removal))
    const oldMarks = await member.request({ type: 'chat_unread_get', frameId: 'removed-unread' })
    assert.equal(oldMarks.type, 'chat_unread_ok', JSON.stringify(oldMarks))
    assert.equal(oldMarks.marks[room], undefined, 'failed watermark cleanup cannot expose revoked room IDs')
    child.send!({ type: 'unreadFailure', enabled: false, tag: 'disk-recovered' }); await waitIpc('configured', 'disk-recovered')
    await admin.request({ type: 'chat_room_add_members', frameId: 'restore-member', room, memberIds: ['mem_member'] })
    const futureTip = Date.now() + 86_400_000
    const futureMark = await member.request({ type: 'chat_unread_set', frameId: 'future-watermark', room, lastReadAt: futureTip, lastReadMsgId: 'clamped-tip' })
    assert.equal(futureMark.type, 'chat_unread_set_ok', JSON.stringify(futureMark))
    const seen = await admin.wait(frame => frame.type === 'chat_seen_peer' && frame.lastReadMsgId === 'clamped-tip')
    assert.ok(seen.lastReadAt <= Date.now() + 60_000, 'peer receipt must use the committed clamped timestamp')
    const durableTip = await member.request({ type: 'chat_unread_get', frameId: 'committed-tip' })
    assert.equal(durableTip.marks[room].lastReadAt, seen.lastReadAt)
    const other = await connect('mem_other')
    const start = await member.request({ type: 'ephemeral_start', frameId: 'ephemeral-start', targetMemberId: 'mem_other' })
    assert.equal(start.type, 'ephemeral_start_ok', JSON.stringify(start))
    const invite = await other.wait(frame => frame.type === 'ephemeral_invite')
    assert.equal(invite.room, 'eph:mem_member.mem_other')
    const accepted = await other.request({ type: 'ephemeral_accept', frameId: 'ephemeral-accept', inviteId: invite.inviteId })
    assert.equal(accepted.type, 'ephemeral_accept_ok', JSON.stringify(accepted))
    const ephemeral = await member.request({ type: 'ephemeral_message', frameId: 'ephemeral-send', room: invite.room, body: 'temporary message', clientMsgId: 'ephemeral-id' })
    assert.equal(ephemeral.type, 'ephemeral_message_ok', JSON.stringify(ephemeral))
    console.log('chat async authority live: 7 delayed private reads, queued reaction policy, unread failure/revoked privacy/clamped receipt, and mem_* temporary lifecycle passed')
  } finally {
    sockets.forEach(socket => socket.terminate())
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    rmSync(dir, { recursive: true, force: true })
    rmSync(dir+'.authority', { recursive: true, force: true })
  }
}
