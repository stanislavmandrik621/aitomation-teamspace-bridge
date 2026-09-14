/** A failed legacy import must not retire its source or expose partial history. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatStore } from '../src/chat-store.js'
import { randomBytes } from 'node:crypto'
import { encryptOpsLine, resolveAtRestKeyFromEnv } from '../src/at-rest.js'

const root = fs.mkdtempSync(join(tmpdir(), 'chat-migration-interruption-'))
const append = fs.appendFileSync, copy = fs.copyFileSync, rename = fs.renameSync
const row = (id: string, body: string) => ({ id, room:'chat:team', body, memberId:'owner',memberName:'Owner',role:'admin',kind:'user',createdAt:Date.now() })
try {
  for (const encrypted of [false,true]) for (const phase of ['backup','append','quarantine']) {
    const key = encrypted ? resolveAtRestKeyFromEnv({TEAMSPACE_AT_REST_KEY:randomBytes(32).toString('hex')}) : null
    const dir = join(root, phase+'-'+encrypted); fs.mkdirSync(dir)
    const legacy = join(dir, 'chat.jsonl')
    const source = [row('one','Original one'),row('two','Original two'),{ ...row('one','Latest legacy edit'), editedAt:Date.now()+1 }].map(r => key ? encryptOpsLine(key,JSON.stringify(r)) : JSON.stringify(r)).join('\n') + '\n'
    fs.writeFileSync(legacy, source)
    let hits = 0
    fs.copyFileSync = ((from, to, ...rest: any[]) => {
      if (phase === 'backup' && String(from) === legacy) { hits++; throw Object.assign(new Error('injected backup EROFS'), { code:'EROFS' }) }
      return (copy as any)(from,to,...rest)
    }) as typeof fs.copyFileSync
    fs.appendFileSync = ((path, ...rest: any[]) => {
      if (phase === 'append' && String(path).endsWith('messages.jsonl') && ++hits === 2) throw Object.assign(new Error('injected import ENOSPC'), { code:'ENOSPC' })
      return (append as any)(path,...rest)
    }) as typeof fs.appendFileSync
    fs.renameSync = ((from,to) => {
      if (phase === 'quarantine' && String(from) === legacy) { hits++; throw Object.assign(new Error('injected quarantine EACCES'), { code:'EACCES' }) }
      return rename(from,to)
    }) as typeof fs.renameSync
    syncBuiltinESMExports()
    assert.throws(() => new ChatStore(dir,90,365,key), /migration/i, phase + ': refuse startup instead of serving incomplete data')
    assert.ok(hits > 0)
    assert.equal(fs.readFileSync(legacy,'utf8'), source, phase + ': source survives failure')
    fs.appendFileSync = append; fs.copyFileSync = copy; fs.renameSync = rename; syncBuiltinESMExports()
    const recovered = new ChatStore(dir,90,365,key)
    const history = await recovered.readRecent('chat:team',100)
    assert.deepEqual(history.messages.map(m => m.id).sort(), ['one','two'])
    assert.equal(history.messages.find(m => m.id === 'one')?.body, 'Latest legacy edit')
    assert.equal(fs.readFileSync(join(dir,'chat/rooms/team/messages.jsonl'),'utf8').trim().split('\n').length,2,'recovery must not append duplicate physical snapshots')
    assert.equal(fs.existsSync(legacy), false)
    recovered.flushAllPendingChatIndexes()
  }
  // A source retained by an older interrupted migrator must not rewind current rows.
  const dir = join(root,'existing'); fs.mkdirSync(dir)
  const store = new ChatStore(dir,90)
  await store.append({ ...row('one','Current durable edit'), role:'admin' })
  await store.append({ ...row('deleted','Private deleted body'), role:'admin' })
  await store.softDelete('deleted','owner','chat:team'); store.flushAllPendingChatIndexes()
  fs.writeFileSync(join(dir,'chat.jsonl'), [row('one','Stale legacy body'),row('deleted','Stale deleted body'),row('new','Remaining legacy message')].map(r=>JSON.stringify(r)).join('\n')+'\n')
  const migrated = new ChatStore(dir,90)
  assert.equal((await migrated.findById('one','chat:team'))?.body,'Current durable edit')
  assert.ok((await migrated.findById('deleted','chat:team'))?.deletedAt)
  assert.equal((await migrated.findById('new','chat:team'))?.body,'Remaining legacy message')
  migrated.flushAllPendingChatIndexes()
  const encryptedDir=join(root,'wrong-key'); fs.mkdirSync(encryptedDir)
  const key=resolveAtRestKeyFromEnv({TEAMSPACE_AT_REST_KEY:randomBytes(32).toString('hex')})!
  const encrypted=encryptOpsLine(key,JSON.stringify(row('protected','Encrypted private body')))+'\n'
  fs.writeFileSync(join(encryptedDir,'chat.jsonl'),encrypted)
  for(const badKey of [null,resolveAtRestKeyFromEnv({TEAMSPACE_AT_REST_KEY:randomBytes(32).toString('hex')})]) {
    assert.throws(()=>new ChatStore(encryptedDir,90,365,badKey),/migration.*decrypt/i)
    assert.equal(fs.readFileSync(join(encryptedDir,'chat.jsonl'),'utf8'),encrypted)
  }
  assert.equal((await new ChatStore(encryptedDir,90,365,key).readRecent('chat:team')).messages[0].body,'Encrypted private body')
  console.log('PASS interrupted legacy migration: plain/encrypted backup/write/quarantine refusal, source preservation, restart recovery, existing edits and tombstones, missing/wrong-key refusal')
} finally {
  fs.appendFileSync=append; fs.copyFileSync=copy; fs.renameSync=rename; syncBuiltinESMExports()
  fs.rmSync(root,{recursive:true,force:true})
}
