/** Real HTTP, durable production store and native page assembler; all data synthetic. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BridgeStore,hashSessionToken} from '../src/store.js'
import {createRecordTeamworkHttpHandler} from '../src/record-teamwork-http.js'
import {readRecordTeamworkPage} from '../../../apps/desktop/electron/modules-sync/record-teamwork-page.js'
import type {ModulesSyncOp} from '../src/index.js'
const root=mkdtempSync(join(tmpdir(),'teamwork-large-pages-'))
writeFileSync(join(root,'members.json'),JSON.stringify([{memberId:'alice',email:'alice@test.invalid',displayName:'Alice',role:'admin',createdAt:Date.now(),sessions:{device:hashSessionToken('test-token')}}]))
const store=new BridgeStore(root,21,null,null)
const identity={teamId:'team',moduleId:'m',entityId:'e',recordId:'r'}
const seed=(kind:string,targetId:string,patch={},extra={})=>({kind,targetId,targetKind:kind.split('.')[0],opId:kind+targetId,originMemberId:'alice',originRole:'admin',originDevice:'device',hlc:`${Date.now()}:0:alice`,protocolVersion:2,hopCount:0,patch,...extra}) as ModulesSyncOp
store.appendOps([seed('module.create','m'),seed('entity.create','e',{moduleId:'m'},{moduleId:'m'}),seed('record.create','r',{data:{name:'Large synthetic history'}},{entityId:'e'})])
const handler=createRecordTeamworkHttpHandler({store,teamId:()=> 'team',authenticate:req=>store.findBySession(String(req.headers.authorization??'')),departmentExists:()=>false,
readBody:async(req,max)=>{let size=0;const chunks:Buffer[]=[];for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Too large');chunks.push(Buffer.from(chunk))}return JSON.parse(Buffer.concat(chunks).toString())},releaseBody:()=>{},json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},drain:req=>req.resume(),takeWrite:()=>true,publish:()=>{},fieldRefusal:()=>null,canRead:()=>true,assertWritable:()=>{}})
const server=createServer((req,res)=>void handler(req,res,new URL(req.url!,'http://localhost')))
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address==='object');const base=`http://127.0.0.1:${address.port}/api/record-teamwork`
const headers={authorization:'test-token','content-type':'application/json'}
const notes=Array.from({length:105},(_,i)=>`${i}:`+(i%2?'世':'\u0001').repeat(19_990))
const sizes:number[]=[]
async function command(command:unknown,id:string){const response=await fetch(base,{method:'POST',headers,body:JSON.stringify({...identity,commandId:id,expectedRevision:store.recordTeamwork.read('r').revision,command,boundedHistory:'1'})});const text=await response.text();sizes.push(Buffer.byteLength(text));return{status:response.status,body:JSON.parse(text)}}
try{
assert.equal((await command({action:'configure',config:{reviewRequired:false,reviewerMemberIds:[],completedStatusValues:[]}},'config')).status,200)
for(let i=0;i<notes.length;i++){const result=await command({action:'submit_result',note:notes[i]},`result-${i}`);assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.data.result.note,notes[i])}
assert.equal((await command({action:'submit_result',note:'x'.repeat(20_001)},'too-long')).status,409)
let requests=0
const fetchPage=async(limit:number,offset:number)=>{
 const response=await fetch(base+'?'+new URLSearchParams({...identity,limit:String(limit),offset:String(offset),boundedHistory:'1'}),{headers});const text=await response.text();const size=Buffer.byteLength(text);sizes.push(size);requests++;assert(size<2_000_000,`Reply ${size} exceeds unchanged native limit`);assert.equal(response.status,200,text);return JSON.parse(text).data
}
const page=await readRecordTeamworkPage(fetchPage,100,0)
assert.equal(page.history.length,100);assert(requests>1);assert.equal(page.history[0].note,notes.at(-1))
assert.deepEqual(page.history.map(e=>e.id),store.recordTeamwork.history('r',100,0).history.map(e=>e.id))
const change=page.history[0].changes?.find(c=>c.field==='result');assert.equal(change?.before?.note,notes.at(-2));assert.equal(change?.after?.note,notes.at(-1))
const last=await readRecordTeamworkPage(fetchPage,100,100);assert.equal(last.history.length,6)
assert.equal(new Set([...page.history,...last.history].map(e=>e.id)).size,106)
assert(sizes.every(size=>size<2_000_000))
console.log(JSON.stringify({status:'passed',events:106,selectedPageSize:100,requests,maxResponseBytes:Math.max(...sizes),unicodeAndEscapedNotes:true,fullBeforeAfterPreserved:true,unchangedResponseLimit:2_000_000}))
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true})}
