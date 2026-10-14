import assert from 'node:assert/strict'
import fs from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {syncBuiltinESMExports} from 'node:module'
import {DatabaseSync} from 'node:sqlite'
import {GuestTokenRetirementStore} from '../src/guest-token-retirement.js'
import {openIndependentAuthority} from '../src/independent-authority.js'
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const digest=(file:string)=>hash(fs.readFileSync(file).toString('base64'))
const close=(store:GuestTokenRetirementStore)=>(store as any).index?.close()
if(process.argv[2]==='--crash'){
 const directory=process.argv[3]!,token=process.argv[4]!,store=new GuestTokenRetirementStore(directory,null)
 const mkdir=fs.mkdirSync
 fs.mkdirSync=((path:any,...args:any[])=>{if(path===join(directory,token.slice(0,2)))process.kill(process.pid,'SIGKILL');return Reflect.apply(mkdir,fs,[path,...args])}) as typeof fs.mkdirSync
 syncBuiltinESMExports();store.retire(token);throw Error('Crash was not injected')
}else{
 const root=fs.mkdtempSync(join(tmpdir(),'retired-guest-checkpoint-'));let cases=0
 try{
  for(const family of ['public-share-retired-tokens','compose-share-retired-tokens','portal-retired-tokens'])for(const key of [null,{key:Buffer.alloc(32,7)}]){
   const base=join(root,family+(key?'-encrypted':'-plain')),data=join(base,'data'),authority=join(base,'authority'),directory=join(authority,family),legacy=join(base,'legacy')
   const token=hash('original-'+family),second=hash('second-'+family),legacyStore=new GuestTokenRetirementStore(legacy,key)
   legacyStore.retire(token);legacyStore.retire(second)
   const original=join(legacy,token.slice(0,2),token+'.json'),before=digest(original)
   openIndependentAuthority(data,authority);fs.cpSync(legacy,directory,{recursive:true})
   let store=new GuestTokenRetirementStore(directory,key)
   assert.equal(store.isRetired(token),true);assert.equal(store.isRetired(second),true);assert.equal(digest(original),before)
   const oldFile=join(directory,token.slice(0,2),token+'.json');fs.unlinkSync(oldFile)
   assert.equal(store.isRetired(token),true,'missing legacy record cannot revive URL');close(store)
   store=new GuestTokenRetirementStore(directory,key);assert.equal(store.isRetired(token),true);cases++
   const peer=new GuestTokenRetirementStore(directory,key),newToken=hash('concurrent-'+family)
   store.retire(newToken);assert.equal(peer.isRetired(newToken),true);close(peer);close(store);cases++
   const checkpoint=join(directory,'retired.sqlite'),held=checkpoint+'.held',checkpointHash=digest(checkpoint)
   fs.renameSync(checkpoint,held)
   assert.throws(()=>openIndependentAuthority(data,authority),/incomplete/)
   assert.throws(()=>new GuestTokenRetirementStore(directory,key),/missing/)
   fs.renameSync(held,checkpoint);assert.equal(digest(checkpoint),checkpointHash);cases++
   fs.copyFileSync(checkpoint,held);fs.writeFileSync(checkpoint,'corrupt retirement checkpoint')
   assert.throws(()=>new GuestTokenRetirementStore(directory,key));assert.equal(fs.readFileSync(checkpoint,'utf8'),'corrupt retirement checkpoint')
   fs.copyFileSync(held,checkpoint);assert.equal(digest(checkpoint),checkpointHash);cases++
   if(key){assert.throws(()=>new GuestTokenRetirementStore(directory,{key:Buffer.alloc(32,8)}));assert.equal(digest(checkpoint),checkpointHash);cases++}
   store=new GuestTokenRetirementStore(directory,key);assert.equal(store.isRetired(token),true);close(store)
   const indexDb=new DatabaseSync(checkpoint),put=indexDb.prepare('INSERT OR IGNORE INTO retired VALUES (?)')
   indexDb.exec('BEGIN IMMEDIATE');for(let i=0;i<1024;i++)put.run('aa'+i.toString(16).padStart(62,'0'));indexDb.exec('COMMIT');indexDb.close()
   store=new GuestTokenRetirementStore(directory,key)
   assert.throws(()=>store.retire('aa'+'f'.repeat(62)),/history/)
   assert.equal(store.isRetired('aa'+'0'.repeat(62)),true,'a full bucket preserves every prior revocation');close(store);cases++
   if(!key){const crashToken=hash('crashed-'+family),result=spawnSync(process.execPath,['--import','tsx',import.meta.filename,'--crash',directory,crashToken],{encoding:'utf8',timeout:30000})
    assert.equal(result.signal,'SIGKILL',result.stderr);store=new GuestTokenRetirementStore(directory,key);assert.equal(store.isRetired(crashToken),true,'committed revocation survives kill before legacy file');assert.equal(fs.existsSync(join(directory,crashToken.slice(0,2),crashToken+'.json')),false);close(store);cases++}
  }
  console.log(JSON.stringify({status:'passed',cases,families:3,legacyPreserved:true,missingRetirementFileBlocked:true,missingOrCorruptIndexRefused:true,wrongKeyPreserved:true,actualProcessKill:true,concurrentReaders:true}))
 }finally{fs.rmSync(root,{recursive:true,force:true})}
}
