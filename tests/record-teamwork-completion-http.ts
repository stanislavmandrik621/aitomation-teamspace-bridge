import {compareYjsCellHlc} from '../src/record-teamwork-yjs.js'
import * as Y from 'yjs'
/** Actual loopback HTTP + BridgeStore. An assistant is authenticated account
 * delegation, not attestation of a particular LLM, agent UUID, or active run. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BridgeStore,hashSessionToken} from '../src/store.js'
import {createRecordTeamworkHttpHandler} from '../src/record-teamwork-http.js'
import type {ModulesSyncOp} from '../src/index.js'
const root=mkdtempSync(join(tmpdir(),'reviewed-completion-http-'))
writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','viewer'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id==='bob'?'Canonical Bob':id,role:id==='alice'?'admin':id==='bob'?'member':'viewer',createdAt:Date.now(),sessions:{[id+'-device']:hashSessionToken(id+'-token')}}))))
let store=new BridgeStore(root,21,null,null),serial=0,afterBody:(()=>void)|null=null,limited=false,locked=false,fieldHidden=false,boundTeam='team',revoked=false
const published:ModulesSyncOp[]=[]
const seed=(kind:string,targetId:string,patch:Record<string,unknown>={},rest:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'seed-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice-device',hlc:`${Date.now()}:0:alice`,protocolVersion:2,hopCount:0,patch,...rest})
store.appendOps([seed('module.create','m'),seed('entity.create','e',{moduleId:'m'},{moduleId:'m'}),seed('field.create','owner-field',{slug:'owner',field_type:'user'},{entityId:'e'}),seed('field.create','status-field',{slug:'status',field_type:'select'},{entityId:'e'}),seed('field.create','body-field',{slug:'body',field_type:'text'},{entityId:'e'}),seed('record.create','r',{data:{owner:null,status:'Todo',body:'baseline'}},{entityId:'e'})])
const handler=createRecordTeamworkHttpHandler({get store(){return store},teamId:()=>boundTeam,authenticate:req=>revoked?null:store.findBySession(String(req.headers.authorization??'')),departmentExists:()=>false,
 readBody:async(req,max)=>{const buffers:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Too large');buffers.push(Buffer.from(chunk))}const body=JSON.parse(Buffer.concat(buffers).toString());afterBody?.();afterBody=null;return body},releaseBody:()=>{},json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},drain:req=>req.resume(),takeWrite:()=>!limited,retryAfterSeconds:()=>7,publish:ops=>published.push(...ops),fieldRefusal:()=>null,canRead:()=>!fieldHidden,assertWritable:()=>{if(locked)throw Error('locked')}})
const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost')).then(done=>{if(!done){res.writeHead(404);res.end()}})})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port
const identity={teamId:'team',moduleId:'m',entityId:'e',recordId:'r'}
const request=async(actor:string,command:unknown,id:string,extra:Record<string,unknown>={},assistant=true)=>{const response=await fetch(base+'/api/record-teamwork'+(assistant?'/assistant':''),{method:'POST',headers:{authorization:actor+'-token','content-type':'application/json'},body:JSON.stringify({...identity,expectedRevision:store.recordTeamwork.read('r').revision,commandId:id,command,...extra})});return{status:response.status,body:await response.json() as any,headers:response.headers}}
const read=async(actor:string,assistant=true)=>{const response=await fetch(base+'/api/record-teamwork'+(assistant?'/assistant':'')+'?'+new URLSearchParams(identity),{headers:{authorization:actor+'-token'}});return{status:response.status,body:await response.json() as any}}
const complete=async(actor:string,commandId:string,extra:Record<string,unknown>={})=>{
 const response=await fetch(base+'/api/record-teamwork/completion',{method:'POST',headers:{authorization:actor+'-token','content-type':'application/json'},body:JSON.stringify({...identity,commandId,expectedRevision:store.recordTeamwork.read('r').revision,fieldSlug:'status',value:'Done',previous:'Todo',...extra})});return {status:response.status,body:await response.json() as any}
}
try{
 store.appendOp(seed('record.update','r',{data:{status:'Todo'}},{entityId:'e',moduleId:'m',hlc:`${Date.now()+2000}:7:slightly-ahead-device`}))
 const config={reviewRequired:true,reviewerMemberIds:['alice'],completedStatusValues:['Done'],statusFieldId:'status-field'}
 assert.equal((await request('alice',{action:'configure',config},'config',{},false)).status,200)
 const approve=async()=>{assert.equal((await request('bob',{action:'request_review'},'review-'+ ++serial,{},false)).status,200);assert.equal((await request('alice',{action:'approve'},'approve-'+ ++serial,{},false)).status,200)}
 await approve()
 const d=new Y.Doc();d.getMap('_modules_checkpoint').set('binding',JSON.stringify(['r','body','text']));d.getMap('_modules_checkpoint').set('genesis','a'.repeat(64));d.getText('content').insert(0,'baseline')
 const b64=()=>Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64')
 store.recordTeamwork.acceptYjs('r','body',b64());d.getText('content').insert(0,'unsaved ');store.recordTeamwork.acceptYjs('r','body',b64())
 const before=store.recordTeamwork.read('r').revision, count=published.length
 const blocked=await complete('bob','not-checkpointed');assert.equal(blocked.status,409);assert.match(blocked.body.error,/still saving/);assert.equal(store.recordTeamwork.read('r').revision,before);assert.equal(published.length,count)
 store.appendOps([seed('record.update','r',{data:{body:d.getText('content').toString()},yjsCheckpoint:{fieldSlug:'body',kind:'text',stateB64:b64()}},{entityId:'e',moduleId:'m'})]);await approve()
 assert.equal((await complete('viewer','viewer')).status,409)
 assert.equal((await complete('bob','extra',{data:{body:'overwrite'}})).status,409)
 assert.equal((await complete('bob','stale',{expectedRevision:0})).status,409)
 afterBody=()=>{fieldHidden=true};assert.equal((await complete('bob','hidden-during-body')).status,409);fieldHidden=false
 const revision=store.recordTeamwork.read('r').revision,statusBaseline=store.contentAccess.recordCellHlc('r','status')
 const outcomes=await Promise.all(Array.from({length:20},(_,i)=>complete('bob','race-'+i,{expectedRevision:revision})))
 assert.equal(outcomes.filter(r=>r.status===200).length,1);assert.equal(outcomes.filter(r=>r.status===409).length,19)
 const winner=outcomes.findIndex(r=>r.status===200),accepted=published.at(-1)!;assert.equal(accepted.kind,'record.update');assert.deepEqual(accepted.patch?.data,{status:'Done'});assert.deepEqual(accepted.patch?.baseCellHlcs,{status:statusBaseline});assert.equal(compareYjsCellHlc(accepted.hlc,statusBaseline),1,'completion advances beyond the observed cell even if its device clock was ahead')
 const retry=await complete('bob','race-'+winner,{expectedRevision:revision});assert.equal(retry.status,200);const total=published.length
 store=new BridgeStore(root,21,null,null)
 assert.equal((await complete('bob','race-'+winner,{expectedRevision:revision})).status,200);assert.equal(published.length,total)
 assert.equal((await complete('bob','race-'+winner,{expectedRevision:revision,value:'Todo'})).status,409)
 d.destroy();console.log('PASS reviewed completion: pending live state, role/ACL/CAS, 20 contenders, exact retry and restart receipt')
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true})}
