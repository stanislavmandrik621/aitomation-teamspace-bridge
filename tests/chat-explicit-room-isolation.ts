/** Explicit room IDs must never fall through to a different room, warm or cold. */
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ChatStore} from '../src/chat-store.js'
const dir=mkdtempSync(join(tmpdir(),'chat-explicit-room-'))
const actual='chat:team',wrong='chat:g:aaaaaaaaaaaaaaaa',id='collision',fields={room:actual,id,body:'must stay unchanged',memberId:'alice',memberName:'Alice',role:'admin' as const}
try{
 const store=new ChatStore(dir,90);assert.ok(!('error' in await store.append(fields)));store.flushAllPendingChatIndexes()
 for(const [label,s] of [['cached',store],['disk',new ChatStore(dir,90)]] as const){
  assert.ok('error' in await s.append({...fields,room:wrong}),label+' sequential ID reuse refuses')
  assert.equal(await s.findById(id,wrong),null,label+' wrong room')
  assert.equal(await s.findById(id,'../invalid'),null,label+' malformed room')
  for(const result of [await s.react(id,'alice','👍',false,wrong),await s.edit(id,'alice','WRONG',true,wrong),await s.authorUnsend(id,'alice',false,wrong),await s.softDelete(id,'alice',wrong)])assert.ok('error' in result,label+' mutation must refuse')
  const row=await s.findById(id,actual);assert.equal(row?.body,fields.body);assert.ok(!row?.deletedAt);assert.deepEqual(row?.reactions??{},{});assert.equal((await s.findById(id))?.room,actual,'legacy unscoped lookup remains supported');s.flushAllPendingChatIndexes()
 }
 console.log('PASS explicit chat room isolation: cached/disk/malformed lookup, react/edit/unsend/delete, original preserved, legacy no-room lookup')
}finally{rmSync(dir,{recursive:true,force:true})}
