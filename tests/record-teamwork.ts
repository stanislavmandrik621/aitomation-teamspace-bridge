import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'
import {BridgeStore,hashSessionToken} from '../src/store.js'
import type {ModulesSyncOp} from '../src/index.js'
import {applyRecordTeamworkCommand,emptyRecordTeamwork,recordTeamworkWriteGate,recordTeamworkAfterWrite,type RecordTeamworkAuthority} from '../src/record-teamwork-state.js'
import {recordTeamworkAuthority,resolveRecordTeamworkIdentity,recordTeamworkStatusKeys} from '../src/record-teamwork-authority.js'
import type {RecordTeamworkCommand,RecordTeamworkConfig} from '../src/record-teamwork-types.js'
const config:RecordTeamworkConfig={statusFieldId:'status-field',assigneeFieldId:'owner-field',dueFieldId:'due-field',completedStatusValues:['done'],reviewRequired:true,reviewerMemberIds:['bob']}
const members=new Set(['alice','bob'])
const auth=(id='alice',admin=false):RecordTeamworkAuthority=>({actor:{id,name:id,kind:'member'},teamId:'team',canWrite:true,canConfigure:admin,validateMember:id=>{if(!members.has(id))throw Error('removed')},validateConfig:()=>{},validateHandoff:to=>{if(to.kind!=='member'||to.teamId!=='team'||!members.has(to.id))throw Error('wrong person')}})
let n=0
const apply=(s:ReturnType<typeof emptyRecordTeamwork>,command:RecordTeamworkCommand,authority=auth('alice',true),expected=s.revision)=>applyRecordTeamworkCommand(s,expected,command,authority,{id:String(++n),at:new Date().toISOString()}).state

test('required review binds exact record revision; 100 concurrent decisions cannot rebase',()=>{
 let s=apply(emptyRecordTeamwork(),{action:'configure',config})
 assert.throws(()=>recordTeamworkWriteGate(s,{status:'done'},['status']),/requires approval/)
 s=apply(s,{action:'request_review'});const base=s.revision;let accepted=0
 for(let i=0;i<100;i++){try{s=apply(s,{action:'approve'},auth('bob'),base);accepted++}catch{}}
 assert.equal(accepted,1)
 assert.equal(recordTeamworkWriteGate(s,{status:'done'},['status']).completion,true)
 assert.throws(()=>recordTeamworkWriteGate(s,{status:'done',body:'unreviewed'},['status']),/Save content/)
 const changed=recordTeamworkAfterWrite(s,false);assert.equal(changed.review.state,'none')
 assert.throws(()=>recordTeamworkWriteGate(changed,{status:'done'},['status']),/requires approval/)
 assert.throws(()=>apply(changed,{action:'request_help',note:'draft'},auth(),base),/latest state/)
 assert.throws(()=>apply(emptyRecordTeamwork(),{action:'configure',config},{...auth('alice',true),teamId:null}),/shared/)
})
test('roles, revoked reviewers, local agent impersonation, clearing and required notes',()=>{
 let s=apply(emptyRecordTeamwork(),{action:'configure',config})
 assert.throws(()=>apply(s,{action:'configure',config:null},auth('bob')),/administrator/)
 assert.throws(()=>apply(s,{action:'request_help',note:' '}),/Add a note/)
 assert.throws(()=>apply(s,{action:'handoff',to:{id:'bob',label:'Bob',kind:'member',teamId:'other'}}),/wrong person/)
 s=apply(s,{action:'request_review'})
 assert.throws(()=>apply(s,{action:'approve'},{...auth('bob'),actor:{id:'bob',name:'pretend',kind:'agent'}}),/not allowed/)
 members.delete('bob');assert.throws(()=>apply(s,{action:'approve'},auth('bob')),/removed/);members.add('bob')
 assert.throws(()=>apply(s,{action:'approve'},{...auth('bob'),canWrite:false}),/cannot change/)
 s=apply(s,{action:'request_changes',note:'Please add evidence'},auth('bob'));assert.equal(s.review.state,'changes_requested')
 s=apply(s,{action:'configure',config:null});assert.equal(s.config,null)
 assert.equal(recordTeamworkWriteGate(s,{status:'done'},[]).completion,false)
})
test('BridgeStore direct-write admission, actual WAL and SQLite retention, history and field identity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'record-teamwork-'))
 try{
  const old=Date.now()-400*86400000
  writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','viewer'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id,role:id==='alice'?'admin':id==='bob'?'member':'viewer',createdAt:old,sessions:{[id]:hashSessionToken(id)},sessionLastSeen:{[id]:old}}))))
  let store=new BridgeStore(root,21,null,null),serial=0
  const op=(kind:string,targetId:string,patch:Record<string,unknown>={},extra:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'tw-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice',hlc:`${old}:0:alice`,protocolVersion:2,hopCount:0,patch,...extra})
  store.appendOps([op('module.create','module'),op('entity.create','entity',{moduleId:'module'},{moduleId:'module'}),op('field.create','status-field',{slug:'status',field_type:'select'},{entityId:'entity'}),op('field.create','owner-field',{slug:'owner',field_type:'user'},{entityId:'entity'}),op('field.create','due-field',{slug:'due',field_type:'date'},{entityId:'entity'}),op('record.create','record',{data:{status:'todo'}},{entityId:'entity'})])
  const identity=resolveRecordTeamworkIdentity(store,'team','record',store.findMember('alice')!)
  const command=(command:RecordTeamworkCommand,id='alice')=>{
   const member=store.findMember(id)!,base=store.recordTeamwork.read('record')
   const raw=op('record.teamwork','record',{data:{},expectedRevision:base.revision,command},{entityId:'entity',moduleId:'module',originMemberId:id,originRole:member.role})
   const stamped=store.recordTeamwork.stamp(raw,recordTeamworkAuthority(store,identity,member,()=>true),s=>recordTeamworkStatusKeys(store,'entity',s))
   assert.equal(store.recordTeamwork.read('record').revision,base.revision)
   store.appendOps([stamped]);return stamped
  }
  command({action:'configure',config})
  assert.throws(()=>store.appendOp(op('record.update','record',{data:{status:'done'}},{entityId:'entity'})),/requires approval/)
  command({action:'request_review'});const approval=command({action:'approve'},'bob')
  assert.equal(store.recordTeamwork.isExactCommand(approval),true)
  assert.equal(store.recordTeamwork.isExactCommand({...approval,patch:{...approval.patch,command:{action:'configure',config:null}}}),false)
  assert.throws(()=>store.appendOp(op('record.update','record',{data:{'status-field':'done',body:'unreviewed'}},{entityId:'entity'})),/Save content/)
  store.appendOp(op('record.update','record',{data:{status:'done'}},{entityId:'entity'}));assert.equal(store.recordTeamwork.read('record').review.state,'approved')
  store.appendOp(op('record.update','record',{data:{body:'after approval'}},{entityId:'entity'}));assert.equal(store.recordTeamwork.read('record').review.state,'none')
  const invalidated = store.recordTeamwork.history('record').history[0]
  assert.equal(invalidated.action, 'approval_invalidated'); assert.equal(invalidated.recordRevision, store.recordTeamwork.read('record').recordRevision)
  assert.equal(invalidated.changes?.find(c => c.field === 'review')?.before?.state, 'approved')
  assert.equal(invalidated.changes?.find(c => c.field === 'review')?.after?.state, 'none')
  assert.equal(store.recordTeamwork.history('record',1,1).history.length,1)
  const state=store.recordTeamwork.read('record'),history=store.recordTeamwork.history('record')
  await store.pruneOps();store=new BridgeStore(root,21,null,null)
  assert.deepEqual(store.recordTeamwork.read('record'),state);assert.deepEqual(store.recordTeamwork.history('record'),history)
  assert.throws(()=>store.appendOp(op('record.update','record',{data:{status:'done'}},{entityId:'entity'})),/requires approval/)
  unlinkSync(join(root,'record-teamwork','content-access.sqlite'))
  assert.equal(new BridgeStore(root,21,null,null).recordTeamwork.healthy(),false)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('HTTP commands preserve same-record assignment and exact retry while denying viewer, lock and wrong-link writes',async()=>{
 const {createRecordTeamworkHttpHandler}=await import('../src/record-teamwork-http.js')
 const root=mkdtempSync(join(tmpdir(),'record-teamwork-http-'))
 try{
  writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','viewer'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id,role:id==='alice'?'admin':id==='bob'?'member':'viewer',createdAt:1,sessions:{[id]:hashSessionToken(id)}}))))
  const store=new BridgeStore(root,21,null,null);let serial=0
  const seed=(kind:string,targetId:string,patch:Record<string,unknown>={},rest:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'seed-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice',hlc:`${Date.now()}:0:alice`,protocolVersion:2,hopCount:0,patch,...rest})
  store.appendOps([seed('module.create','m'),seed('entity.create','e',{}, {moduleId:'m'}),seed('field.create','owner-field',{slug:'owner',field_type:'user'},{entityId:'e'}),seed('record.create','r',{data:{owner:null}},{entityId:'e'})])
  let principal='alice',locked=false,reply:any,requestBody:any,changeDuringRead=false;const published:ModulesSyncOp[]=[]
  const handler=createRecordTeamworkHttpHandler({store,teamId:()=> 't',authenticate:()=>({member:store.findMember(principal)!,deviceId:principal}),departmentExists:()=>false,
   readBody:async()=>{if(changeDuringRead)principal='bob';return requestBody},releaseBody:()=>{},json:(_r,status,body)=>{reply={status,body}},drain:()=>{},takeWrite:()=>true,publish:ops=>published.push(...ops),fieldRefusal:()=>null,canRead:()=>true,assertWritable:()=>{if(locked)throw Error('locked')}})
  const request=async(command:RecordTeamworkCommand,id:string,extra:Record<string,unknown>={})=>{requestBody={teamId:'t',moduleId:'m',entityId:'e',recordId:'r',commandId:id,expectedRevision:store.recordTeamwork.read('r').revision,command,...extra};await handler({method:'POST'} as any,{setHeader:()=>{}} as any,new URL('http://localhost/api/record-teamwork'));return reply}
  assert.equal((await request({action:'configure',config:{reviewRequired:false,reviewerMemberIds:[],completedStatusValues:[],assigneeFieldId:'owner-field'}},'config')).status,200)
  const base=store.recordTeamwork.read('r').revision
  const handoff={action:'handoff' as const,to:{kind:'member' as const,teamId:'t',id:'bob',label:'Client claimed name'}}
  assert.equal((await request(handoff,'handoff',{expectedRevision:base})).status,200)
  assert.equal(published.at(-1)?.kind,'record.update');assert.equal(published.at(-1)?.targetId,'r')
  assert.equal((published.at(-1)?.patch?.data as any).owner.label,'bob','server owns displayed member name')
  const length=published.length,revision=store.recordTeamwork.read('r').revision
  assert.equal((await request(handoff,'handoff',{expectedRevision:base})).status,200)
  assert.equal(published.length,length);assert.equal(store.recordTeamwork.read('r').revision,revision)
  assert.equal((await request({action:'request_help',note:'different'},'handoff',{expectedRevision:base})).status,409)
  assert.equal((await request({action:'request_help',note:'other team'},'bad-team',{teamId:'other'})).status,409)
  assert.equal((await request({action:'request_help',note:'wrong link'},'bad-link',{entityId:'other'})).status,409)
  locked=true;assert.equal((await request({action:'request_help',note:'during lock'},'locked')).status,409);locked=false
  principal='viewer';assert.equal((await request({action:'request_help',note:'viewer'},'viewer')).status,409)
  principal='alice';changeDuringRead=true;assert.equal((await request({action:'request_help',note:'old session'},'session')).status,409)
 }finally{rmSync(root,{recursive:true,force:true})}
})
