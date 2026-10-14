import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import {createRequire,syncBuiltinESMExports} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RestoreHistory} from '../src/restore-history.js'
import {encryptOpsLine,decryptJsonFile} from '../src/at-rest.js'
const root=fs.mkdtempSync(join(tmpdir(),'restore-history-test-')),key={key:Buffer.alloc(32,17)}
const require=createRequire(import.meta.url),mutable=require('node:fs') as typeof fs
const row=(id:string)=>({opId:id,line:encryptOpsLine(key,JSON.stringify({opId:id,kind:'record.update',targetId:'record',patch:{data:{name:'PRIVATE_HISTORY_'+id}}}))})
const scan=async(history:RestoreHistory)=>{const result=[];for await(const op of history.scan())result.push(op);return result}
async function main(){try{
 const history=new RestoreHistory(root,key,65536)
 await history.retain([row('a'),row('b')]);await history.retain([row('b'),row('c')])
 assert.deepEqual((await scan(history)).map(o=>o.opId),['a','b','c'])
 assert.deepEqual((await scan(new RestoreHistory(root,key,65536))).map(o=>o.opId),['a','b','c'])
 const ids:string[]=[];history.remember(op=>ids.push(op.opId));assert.deepEqual(ids,['a','b','c'])
 const manifest=join(root,'restore-history/manifest.json'),bytes=fs.readFileSync(manifest)
 const m=decryptJsonFile<any>(key,bytes.toString(),null),dataPath=join(root,'restore-history',m.file),data=fs.readFileSync(dataPath)
 assert.equal(data.includes(Buffer.from('PRIVATE_HISTORY')),false);assert.equal(bytes.includes(Buffer.from(m.file)),false)
 await assert.rejects(history.retain([{opId:'a',line:encryptOpsLine(key,JSON.stringify({opId:'a',kind:'record.update',targetId:'other'}))}]),/identity conflicts/)
 assert.deepEqual(fs.readFileSync(manifest),bytes)
 const rename=mutable.renameSync
 try{mutable.renameSync=((a,b)=>{if(String(b)===manifest)throw Object.assign(Error('Injected disk full'),{code:'ENOSPC'});return rename(a,b)}) as typeof rename;syncBuiltinESMExports();await assert.rejects(history.retain([row('d')]),/disk full/)}finally{mutable.renameSync=rename;syncBuiltinESMExports()}
 assert.deepEqual(fs.readFileSync(manifest),bytes);assert.deepEqual((await scan(history)).map(o=>o.opId),['a','b','c'])
 const changed=Buffer.from(data);changed[20]^=1;fs.writeFileSync(dataPath,changed)
 let received=0;await assert.rejects(async()=>{for await(const _op of history.scan())received++});assert.equal(received,0);assert.deepEqual(fs.readFileSync(dataPath),changed)
 fs.writeFileSync(dataPath,data);fs.unlinkSync(manifest);await assert.rejects(scan(history),/manifest is missing/);fs.writeFileSync(manifest,bytes)
 await assert.rejects(scan(new RestoreHistory(root,{key:Buffer.alloc(32,18)},65536)));assert.deepEqual(fs.readFileSync(manifest),bytes)
 fs.mkdirSync(join(root,'small'));const small=new RestoreHistory(join(root,'small'),key,200);await small.retain([row('a'),row('b')]);await assert.rejects(scan(small),/storage limit/)
 const target=join(root,'linked');fs.symlinkSync(join(root,'restore-history'),target);await assert.rejects(scan(new RestoreHistory(root+'/linked-parent',key,65536)).then(()=>{fs.mkdirSync(root+'/linked-parent',{recursive:true});fs.symlinkSync(target,root+'/linked-parent/restore-history');return scan(new RestoreHistory(root+'/linked-parent',key,65536))}),/directory is invalid/)
 console.log('restore-history: encrypted restart/replay, duplicate identity, bounded storage, failed atomic commit, corruption, missing manifest, wrong key and symlink refusal passed')
 }finally{fs.rmSync(root,{recursive:true,force:true})}}
main().catch(error=>{console.error(error);process.exitCode=1})
