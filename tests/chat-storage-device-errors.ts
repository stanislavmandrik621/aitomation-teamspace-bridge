/** Coded disk failures in an isolated process; never fills or changes the host disk. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatRoomsStore } from '../src/chat-rooms-store.js'
import { ChatStore } from '../src/chat-store.js'

const root = fs.mkdtempSync(join(tmpdir(), 'chat-device-errors-'))
const write = fs.writeFileSync, append = fs.appendFileSync
let cases = 0
try {
  for (const code of ['ENOSPC', 'EROFS', 'EACCES']) {
    const dir = join(root, code); fs.mkdirSync(dir)
    const rooms = new ChatRoomsStore(dir, null)
    const created = rooms.createGroup({ kind: 'private', title: 'Private fixture', createdBy: 'owner', memberIds: ['member'], password: 'fixture-password' })
    assert.ok(!('error' in created)); const id = created.id
    const registry = join(dir, 'chat', 'rooms.json'), before = fs.readFileSync(registry)
    let hits = 0
    fs.writeFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
      // The registry writes through an already opened exclusive temporary fd.
      if (typeof path === 'number' || String(path).startsWith(registry)) { hits++; throw Object.assign(new Error('injected storage failure'), { code }) }
      return (write as any)(path, ...args)
    }) as typeof fs.writeFileSync
    syncBuiltinESMExports()
    for (const mutation of [() => rooms.setTitle(id, 'Uncommitted title'), () => rooms.removeMembers(id, ['member'], 'owner'), () => rooms.setPassword(id, 'uncommitted-password')]) {
      assert.ok('error' in mutation(), code + ': mutation must refuse')
      assert.deepEqual(fs.readFileSync(registry), before)
      assert.equal(rooms.get(id)?.title, 'Private fixture')
      assert.equal(rooms.memberCanAccess(id, 'member'), true)
      cases++
    }
    assert.ok(hits >= 3)
    fs.writeFileSync = write; syncBuiltinESMExports()
    assert.ok(!('error' in rooms.setTitle(id, 'Recovered title')))
    assert.equal(new ChatRoomsStore(dir, null).get(id)?.title, 'Recovered title')

    const history = new ChatStore(dir, 90, 365, null)
    const input = { room: id, id: 'disk-' + code, body: 'Only one durable copy', memberId: 'owner', memberName: 'Owner', role: 'admin' as const }
    let appendHits = 0
    fs.appendFileSync = ((path: fs.PathOrFileDescriptor, ...args: any[]) => {
      if (String(path).endsWith('messages.jsonl')) { appendHits++; throw Object.assign(new Error('injected append failure'), { code }) }
      return (append as any)(path, ...args)
    }) as typeof fs.appendFileSync
    syncBuiltinESMExports()
    await assert.rejects(async () => { const result = await history.append(input); if ('error' in result) throw new Error(result.error) })
    assert.ok(appendHits > 0)
    fs.appendFileSync = append; syncBuiltinESMExports()
    assert.ok(!('error' in await history.append(input)))
    assert.ok(!('error' in await history.append(input)))
    const restarted = new ChatStore(dir, 90, 365, null)
    assert.equal((await restarted.readRecent(id, 100)).messages.filter(m => m.id === input.id).length, 1)
    cases++
  }
  console.log(`${cases} coded disk-failure cases passed: refuse, preserve ACL/history, recover and retry without duplicates`)
} finally {
  fs.writeFileSync = write; fs.appendFileSync = append; syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
