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
const root=mkdtempSync(join(tmpdir(),'assistant-teamwork-http-'))
writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','viewer'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id==='bob'?'Canonical Bob':id,role:id==='alice'?'admin':id==='bob'?'member':'viewer',createdAt:Date.now(),sessions:{[id+'-device']:hashSessionToken(id+'-token')}}))))
let store=new BridgeStore(root,21,null,null),serial=0,afterBody:(()=>void)|null=null,limited=false,locked=false,fieldHidden=false,boundTeam='team',revoked=false
const published:ModulesSyncOp[]=[]
const seed=(kind:string,targetId:string,patch:Record<string,unknown>={},rest:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'seed-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice-device',hlc:`${Date.now()}:0:alice`,protocolVersion:2,hopCount:0,patch,...rest})
store.appendOps([seed('module.create','m'),seed('entity.create','e',{moduleId:'m'},{moduleId:'m'}),seed('field.create','owner-field',{slug:'owner',field_type:'user'},{entityId:'e'}),seed('field.create','status-field',{slug:'status',field_type:'select'},{entityId:'e'}),seed('record.create','r',{data:{owner:null,status:'Todo'}},{entityId:'e'})])
const handler=createRecordTeamworkHttpHandler({get store(){return store},teamId:()=>boundTeam,authenticate:req=>revoked?null:store.findBySession(String(req.headers.authorization??'')),departmentExists:()=>false,
 readBody:async(req,max)=>{const buffers:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Too large');buffers.push(Buffer.from(chunk))}const body=JSON.parse(Buffer.concat(buffers).toString());afterBody?.();afterBody=null;return body},releaseBody:()=>{},json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},drain:req=>req.resume(),takeWrite:()=>!limited,retryAfterSeconds:()=>7,publish:ops=>published.push(...ops),fieldRefusal:()=>null,canRead:()=>!fieldHidden,assertWritable:()=>{if(locked)throw Error('locked')}})
const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost')).then(done=>{if(!done){res.writeHead(404);res.end()}})})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port
const identity={teamId:'team',moduleId:'m',entityId:'e',recordId:'r'}
const request=async(actor:string,command:unknown,id:string,extra:Record<string,unknown>={},assistant=true)=>{const response=await fetch(base+'/api/record-teamwork'+(assistant?'/assistant':''),{method:'POST',headers:{authorization:actor+'-token','content-type':'application/json'},body:JSON.stringify({...identity,expectedRevision:store.recordTeamwork.read('r').revision,commandId:id,command,...extra})});return{status:response.status,body:await response.json() as any,headers:response.headers}}
const read=async(actor:string,assistant=true)=>{const response=await fetch(base+'/api/record-teamwork'+(assistant?'/assistant':'')+'?'+new URLSearchParams(identity),{headers:{authorization:actor+'-token'}});return{status:response.status,body:await response.json() as any}}
try{
 const config={reviewRequired:true,reviewerMemberIds:['alice'],completedStatusValues:['Done'],assigneeFieldId:'owner-field',statusFieldId:'status-field'}
 assert.equal((await request('alice',{action:'configure',config},'config',{},false)).status,200)
 for(const action of ['configure','approve','request_changes'])assert.equal((await request('alice',{action,note:'forbidden',config},'forbidden-'+action)).status,409)
 assert.equal((await request('bob',{action:'request_help',note:'Need dependency',actor:{kind:'member',id:'alice'}},'forged-command')).status,409)
 assert.equal((await request('bob',{action:'request_help',note:'Need dependency'},'forged-actor',{actor:{kind:'member',id:'alice'},agentId:'private-agent-uuid'})).status,409)
 assert.equal((await request('bob',{action:'submit_result',note:'Result',to:{id:'private-agent-uuid'}},'irrelevant-assignee')).status,409)
 assert.equal((await request('bob',{action:'handoff',to:{id:'bob',kind:'member',teamId:'team',label:'Bob',actorId:'private-agent-uuid'}},'nested-actor')).status,409)
 assert.equal((await request('viewer',{action:'request_help',note:'forbidden'},'viewer')).status,409)
 assert.equal((await request('bob',{action:'handoff',to:{kind:'agent',id:'private-agent-uuid',label:'Private Agent'}},'private-assignee')).status,409)
 const revision=store.recordTeamwork.read('r').revision,command={action:'handoff',note:'Hand off this existing record',to:{kind:'member',id:'bob',teamId:'team',label:'Forged label'}}
 const assigned=await request('bob',command,'handoff',{expectedRevision:revision});assert.equal(assigned.status,200,JSON.stringify(assigned.body))
 const actor=assigned.body.data.handoff.from;assert.equal(actor.kind,'agent');assert.match(actor.id,/^assistant:[a-f0-9]{64}$/);assert.equal(actor.name,'Assistant acting for Canonical Bob');assert.deepEqual(actor.delegatedBy,{id:'bob',name:'Canonical Bob',kind:'member'});assert.equal(assigned.body.data.handoff.to.label,'Canonical Bob')
 assert.equal(published.at(-1)?.kind,'record.update');assert.equal(published.at(-1)?.targetId,'r');assert.equal((published.at(-1)?.patch?.data as any).owner.id,'bob')
 const count=published.length,after=store.recordTeamwork.read('r').revision;assert.equal((await request('bob',command,'handoff',{expectedRevision:revision})).status,200);assert.equal(published.length,count);assert.equal(store.recordTeamwork.read('r').revision,after)
 assert.equal((await request('bob',command,'handoff',{expectedRevision:revision},false)).status,409,'Assistant receipt cannot be replayed as human authorship')
 assert.equal((await request('bob',{action:'request_help',note:'Need research'},'help')).status,200);assert.equal((await request('bob',{action:'resolve_help'},'resolved')).status,200)
 assert.equal((await request('bob',{action:'submit_result',note:'Results on this record'},'result')).status,200)
 assert.equal((await request('bob',{action:'request_review',note:'Review final content'},'review')).status,200)
 const delegated=await read('alice');assert.equal(delegated.status,200);assert.equal(delegated.body.data.canConfigure,false);assert.ok(!delegated.body.data.allowedActions.includes('approve'));assert.ok(!delegated.body.data.allowedActions.includes('request_changes'))
 assert.equal((await request('alice',{action:'approve'},'assistant-approval')).status,409)
 const human=await request('alice',{action:'approve'},'human-approval',{},false);assert.equal(human.status,200);assert.equal(human.body.data.review.reviewedBy.kind,'member')
 const allAssistantEvents=human.body.data.history.filter((event:any)=>event.actor.delegatedBy);assert.equal(allAssistantEvents.length,5);assert.ok(allAssistantEvents.every((event:any)=>event.actor.name==='Assistant acting for Canonical Bob'))
 assert.ok(!JSON.stringify(published).includes('private-agent-uuid'));assert.ok(!JSON.stringify(published).includes('Private Agent'))
 const contestRevision=store.recordTeamwork.read('r').revision,contenders=await Promise.all(Array.from({length:20},(_,i)=>request('bob',{action:'submit_result',note:'Concurrent '+i},'race-'+i,{expectedRevision:contestRevision})));assert.equal(contenders.filter(result=>result.status===200).length,1);assert.equal(contenders.filter(result=>result.status===409).length,19)
 afterBody=()=>{store.findMember('bob')!.role='viewer'};assert.equal((await request('bob',{action:'submit_result',note:'Demoted'},'demoted')).status,409);store.findMember('bob')!.role='member'
 afterBody=()=>{fieldHidden=true};assert.equal((await request('bob',{action:'submit_result',note:'Hidden'},'hidden')).status,409);fieldHidden=false
 afterBody=()=>{boundTeam='other'};assert.equal((await request('bob',{action:'submit_result',note:'Moved'},'moved')).status,409);boundTeam='team'
 afterBody=()=>{revoked=true};assert.equal((await request('bob',{action:'submit_result',note:'Revoked'},'revoked')).status,409);revoked=false
 locked=true;assert.equal((await request('bob',{action:'submit_result',note:'Locked'},'locked')).status,409);locked=false
 limited=true;const rate=await request('bob',{action:'submit_result',note:'Rate'},'rate');assert.equal(rate.status,429);assert.equal(rate.headers.get('retry-after'),'7');limited=false
 const state=store.recordTeamwork.read('r'),history=store.recordTeamwork.history('r');store=new BridgeStore(root,21,null,null);assert.deepEqual(store.recordTeamwork.read('r'),state);assert.deepEqual(store.recordTeamwork.history('r'),history)
 console.log('assistant teamwork HTTP: actual loopback/BridgeStore; closed actions, canonical delegated actor, same-record handoff, origin-separated retry, 20-way CAS, Viewer and mid-body ACL/role/session/team refusals, history privacy and restart persistence passed')
}finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(root,{recursive:true,force:true})}
