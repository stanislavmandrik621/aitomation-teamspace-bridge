import { createComposeGuestPasswordVerifier } from '../src/compose-guest-password.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'
for (const key of [null, {key:Buffer.alloc(32,7)}]) {
 const dir=mkdtempSync(join(tmpdir(),'compose-comments-'))
 try {
  let store=new ComposeShareBridgeStore(dir,key)
  const args={tokenHash:hashComposeShareToken('guest-token-one'),localShareId:'share',teamId:'team',documentId:'board',format:'png',watermark:'off',filename:'Board.png',passwordHash:`s$${'11'.repeat(16)}$${'22'.repeat(32)}`,expiresAt:Date.now()+3600000,packBytes:Buffer.from('stable publication'),allowComments:true}
  const created=store.upsertShare('author',args);assert.ok(created.ok);let row=created.row
  assert.equal(store.management('share','', 'other',false).ok,false)
  assert.equal(store.management('share','', 'admin',true).ok,true)
  for(let i=0;i<125;i++)store.addComment(row,{name:'Reviewer',text:'Private feedback '+i,requestId:'request_number_'+String(i).padStart(4,'0')})
  assert.equal(store.comments(row).comments.length,50);assert.equal(store.comments(row).next,50)
  assert.equal(store.comments(row,50).comments.length,50);assert.equal(store.comments(row,100).comments.length,25);assert.equal(store.comments(row,100).next,null)
  const anchor={page:1,x:.2,y:.3,width:.25,height:.4},input={name:'Pinned reviewer',text:'Aligned area',requestId:'request_anchor_00001',anchor}
  const pinned=store.addComment(row,input);assert.deepEqual(pinned.anchor,anchor);assert.equal(store.addComment(row,input).id,pinned.id)
  assert.throws(()=>store.addComment(row,{...input,anchor:{...anchor,width:.1}}))
  for(const bad of [{...anchor,x:NaN},{...anchor,y:Infinity},{...anchor,x:-.1},{...anchor,width:.99},{...anchor,page:1.5},{...anchor,page:2},'invalid',[]])assert.throws(()=>store.addComment(row,{...input,requestId:'invalid_anchor_00001',anchor:bad}))
  const file=join(dir,'compose-share-payloads',args.tokenHash+'.comments.json')
  if(key)assert.equal(readFileSync(file,'utf8').includes('Private feedback'),false)
  store=new ComposeShareBridgeStore(dir,key);assert.equal(store.comments(row,100).comments.length,26)
  assert.deepEqual(store.comments(row,100).comments.at(-1)?.anchor,anchor)
  assert.equal(store.upsertShare('author',args).ok,true,'exact reconnect publication idempotent')
  assert.equal(store.upsertShare('author',{...args,packBytes:Buffer.from('different design')}).ok,false,'review comments stay bound to original bytes')
  assert.equal(store.upsertShare('author',{...args,passwordHash:`s$${'33'.repeat(16)}$${'44'.repeat(32)}`}).ok,false)
  assert.equal(store.reconcileOwners(new Set(['admin','returned-author']), 'admin').ok,true)
  assert.equal(store.management('share','', 'returned-author',false).ok,false)
  assert.equal(store.management('share','', 'admin',false).ok,true)
  writeFileSync(file,'{"comments":{}}');assert.throws(()=>store.comments(row));assert.throws(()=>store.addComment(row,{name:'n',text:'t',requestId:'request_number_9999'}));assert.equal(readFileSync(file,'utf8'),'{"comments":{}}','corrupt comments never overwritten')
 } finally {rmSync(dir,{recursive:true,force:true})}
}
console.log('Guest comments: plaintext/encrypted persistence, pagination, corruption refusal, immutable snapshots and ownership transfer passed')

let calls=0,time=100
const verify=createComposeGuestPasswordVerifier((hash,pw)=>{calls++;return hash==='hash1'&&pw==='correct'},()=>time)
assert.equal(verify('one','hash1','correct'),true);assert.equal(calls,1)
assert.equal(verify('one','hash1','correct'),true);assert.equal(calls,1)
assert.equal(verify('one','hash1','wrong'),false);assert.equal(calls,2)
assert.equal(verify('two','hash1','correct'),true);assert.equal(calls,3)
assert.equal(verify('one','hash2','correct'),false);assert.equal(calls,4)
time+=60001;assert.equal(verify('one','hash1','correct'),true);assert.equal(calls,5)
console.log('Guest password proof cache: bounded per-link/hash proof, wrong attempts and expiry tested')
