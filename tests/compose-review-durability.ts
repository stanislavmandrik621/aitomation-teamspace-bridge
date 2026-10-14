/** Exercise real file storage and controlled OS flush failures; no model/network. */
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComposeShareBridgeStore, hashComposeShareToken } from '../src/compose-share-store.js'
const fs = createRequire(import.meta.url)('node:fs'), originalSync = fs.fsyncSync
function intercept(fn: (fd: number) => void) { fs.fsyncSync=fn; syncBuiltinESMExports() }
function restore() { fs.fsyncSync=originalSync; syncBuiltinESMExports() }
for (const atRest of [null,{key:Buffer.alloc(32,9)}]) {
 const dir=mkdtempSync(join(tmpdir(),'compose-review-durability-'))
 try {
  const store=new ComposeShareBridgeStore(dir,atRest)
  const args={tokenHash:hashComposeShareToken('durability-fixture'),localShareId:'durable-share',teamId:'team',documentId:'board',format:'png',watermark:'off',filename:'Board.png',passwordHash:`s$${'11'.repeat(16)}$${'22'.repeat(32)}`,expiresAt:Date.now()+3600000,packBytes:Buffer.from('Published fixture'),allowComments:true}
  const registered=store.upsertShare('author',args);assert(registered.ok);const row=registered.row
  store.addComment(row,{name:'Alex',text:'Before failure',requestId:'before_failure_0001'})
  const file=join(dir,'compose-share-payloads',args.tokenHash+'.comments.json'),before=readFileSync(file)
  assert.equal(statSync(file).mode&0o777,0o600,'Comments must be private on disk')
  const retry={name:'Alex',text:'One logical retry',requestId:'durable_retry_00001'}
  intercept(()=>{throw Error('Controlled file flush failure')})
  assert.throws(()=>store.addComment(row,retry),/Could not save the comment/)
  restore();assert.deepEqual(readFileSync(file),before,'Failed pre-commit flush preserves previous comments')
  assert.equal(readdirSync(join(dir,'compose-share-payloads')).filter(n=>n.endsWith('.tmp')).length,0)
  let calls=0
  intercept(fd=>{if(++calls===2)throw Error('Controlled directory flush failure');originalSync(fd)})
  assert.throws(()=>store.addComment(row,retry),/Could not save the comment/)
  restore();assert.equal(store.comments(row).comments.length,2,'Uncertain committed write is retained')
  calls=0;intercept(fd=>{calls++;originalSync(fd)})
  const recovered=store.addComment(row,retry);restore()
  assert.equal(calls,2,'Idempotent retry confirms both file and directory durability')
  assert.equal(store.addComment(row,retry).id,recovered.id);assert.equal(store.comments(row).comments.length,2)
  assert.equal(new ComposeShareBridgeStore(dir,atRest).comments(row).comments.length,2)
  if(atRest)assert(!readFileSync(file,'utf8').includes('One logical retry'))
  intercept(()=>{throw Error('Controlled pack flush failure')})
  const refused=store.upsertShare('author',{...args,tokenHash:hashComposeShareToken('new-durable-pack'),localShareId:'new-pack'})
  restore();assert.equal(refused.ok,false);assert.equal(store.reviewById('new-pack'),null)
  assert.equal(readdirSync(join(dir,'compose-share-payloads')).filter(n=>n.endsWith('.tmp')).length,0)
 } finally {restore();rmSync(dir,{recursive:true,force:true})}
}
console.log('Review durability: private encrypted/plaintext files, failed flush refusal, atomic old-state preservation, uncertain commit and idempotent durable retry passed')
