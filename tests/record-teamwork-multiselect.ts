import assert from 'node:assert/strict'
import {emptyRecordTeamwork,applyRecordTeamworkCommand,recordTeamworkWriteGate,recordTeamworkAfterWrite,type RecordTeamworkAuthority} from '../src/record-teamwork-state.js'
const authority:RecordTeamworkAuthority={actor:{id:'reviewer',name:'Reviewer',kind:'member'},teamId:'team',canWrite:true,canConfigure:true,validateMember:()=>{},validateConfig:()=>{},validateHandoff:()=>{}}
let state=applyRecordTeamworkCommand(emptyRecordTeamwork(),0,{action:'configure',config:{statusFieldId:'status-id',reviewRequired:true,completedStatusValues:['Done'],reviewerMemberIds:['reviewer']}},authority,{id:'configure',at:'now'}).state
for(const value of ['Done',['Done'],['Doing','Done'],['Done','Doing']])assert.throws(()=>recordTeamworkWriteGate(state,{status:value},['status','status-id']),/requires approval/)
for(const value of ['Done,Doing',['Doing'],[],null])assert.equal(recordTeamworkWriteGate(state,{status:value},['status','status-id']).completion,false,'Do not invent choices by joining or splitting strings')
state=applyRecordTeamworkCommand(state,state.revision,{action:'request_review'},authority,{id:'request',at:'now'}).state
state=applyRecordTeamworkCommand(state,state.revision,{action:'approve'},authority,{id:'approve',at:'now'}).state
assert.equal(recordTeamworkWriteGate(state,{status:['Doing','Done']},['status','status-id']).completion,true)
assert.equal(recordTeamworkWriteGate(state,{'status-id':['Done','Doing']},['status','status-id']).completion,true)
assert.throws(()=>recordTeamworkWriteGate(state,{status:['Doing','Done'],body:'new content'},['status','status-id']),/Save content/)
state=recordTeamworkAfterWrite(state,false)
assert.throws(()=>recordTeamworkWriteGate(state,{status:['Doing','Done']},['status','status-id']),/requires approval/)
console.log('teamwork multiselect: any completed choice requires latest approval, ID/slug aliases, unreviewed content refusal, exact scalar choices and approval invalidation passed')

// Exercise the canonical field spelling through the actual server schema authority.
const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs')
const {tmpdir}=await import('node:os'),{join}=await import('node:path')
const {BridgeStore,hashSessionToken}=await import('../src/store.js')
const {recordTeamworkAuthority,resolveRecordTeamworkIdentity}=await import('../src/record-teamwork-authority.js')
const directory=mkdtempSync(join(tmpdir(),'teamwork-multiselect-'))
try{
 writeFileSync(join(directory,'members.json'),JSON.stringify([{memberId:'admin',email:'admin@test.invalid',displayName:'Admin',role:'admin',createdAt:Date.now(),sessions:{device:hashSessionToken('token')},sessionLastSeen:{device:Date.now()}}]))
 const store=new BridgeStore(directory,21,null,null);let serial=0
 const op=(kind:string,targetId:string,patch:Record<string,unknown>={},extra:Record<string,unknown>={})=>({kind,targetId,targetKind:kind.split('.')[0],opId:`multi-${++serial}`,originMemberId:'admin',originRole:'admin',originDevice:'device',hlc:`${Date.now()}:0:admin`,protocolVersion:2,hopCount:0,patch,...extra}) as import('../src/index.js').ModulesSyncOp
 store.appendOps([op('module.create','module'),op('entity.create','entity',{moduleId:'module'},{moduleId:'module'}),op('field.create','status-id',{slug:'status',field_type:'multiselect'},{entityId:'entity'}),op('record.create','record',{data:{status:['Doing']}},{entityId:'entity'})])
 const member=store.findMember('admin')!,identity=resolveRecordTeamworkIdentity(store,'team','record',member),serverAuthority=recordTeamworkAuthority(store,identity,member,()=>true)
 const command={action:'configure' as const,config:{statusFieldId:'status-id',completedStatusValues:['Done'],reviewRequired:true,reviewerMemberIds:['admin']}}
 const stamped=store.recordTeamwork.stamp(op('record.teamwork','record',{data:{},expectedRevision:0,command},{entityId:'entity',moduleId:'module'}),serverAuthority,()=>['status','status-id'])
 store.appendOp(stamped)
 assert.throws(()=>store.appendOp(op('record.update','record',{data:{status:['Doing','Done']}},{entityId:'entity'})),/requires approval/)
 assert.throws(()=>store.appendOp(op('record.update','record',{data:{'status-id':['Done','Doing']}},{entityId:'entity'})),/requires approval/)
 console.log('teamwork multiselect: real BridgeStore canonical field configure and direct mixed-array write admission passed')
}finally{rmSync(directory,{recursive:true,force:true})}
