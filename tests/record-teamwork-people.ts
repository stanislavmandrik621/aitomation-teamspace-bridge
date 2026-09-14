import {compareYjsCellHlc} from '../src/record-teamwork-yjs.js'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BridgeStore,hashSessionToken} from '../src/store.js'
import {teamworkHandoffPeople,teamworkSharedPeople} from '../src/record-teamwork-people.js'
import {createRecordTeamworkHttpHandler} from '../src/record-teamwork-http.js'
import type {ModulesSyncOp} from '../src/index.js'
const alice={id:'alice',label:'Alice',kind:'member' as const,teamId:'t'},bob={...alice,id:'bob',label:'Bob'},charlie={...alice,id:'charlie',label:'Charlie'},ai={id:'private-ai',label:'Private AI'}
test('mixed transfer retains unrelated humans/local AI, adds when initiator absent and deduplicates destination',()=>{
 assert.deepEqual(teamworkHandoffPeople([alice,charlie,ai],bob,true,{id:'alice',teamId:'t'}),[charlie,ai,bob])
 assert.deepEqual(teamworkHandoffPeople([charlie,ai,bob],bob,true,{id:'alice',teamId:'t'}),[charlie,ai,bob])
 assert.deepEqual(teamworkHandoffPeople([alice,ai],bob,false,{id:'alice',teamId:'t'}),bob)
 assert.deepEqual(teamworkHandoffPeople([ai,{...ai,id:'other-ai'}],ai,true),[{...ai,id:'other-ai'},ai])
 assert.throws(()=>teamworkHandoffPeople(Array.from({length:50},(_,i)=>({...charlie,id:String(i)})),bob,true),/at most 50/)
 assert.deepEqual(teamworkSharedPeople([alice,ai,{id:'secret',label:'private'}]),[alice])
})
test('actual HTTP multiple handoff + durable ordered person projection preserves coassignees and rejects unknown baseline',async()=>{
 const root=mkdtempSync(join(tmpdir(),'teamwork-multi-'))
 try{
  writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','charlie'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id,role:id==='alice'?'admin':'member',createdAt:1,sessions:{[id]:hashSessionToken(id)}}))))
  let store=new BridgeStore(root,21,null,null),serial=0
  const seed=(kind:string,targetId:string,patch:Record<string,unknown>={},rest:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'people-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice',hlc:`${Date.now()}:${serial}:alice`,protocolVersion:2,hopCount:0,patch,...rest})
  store.appendOps([seed('module.create','m'),seed('entity.create','e',{}, {moduleId:'m'}),seed('field.create','f',{slug:'owner',field_type:'user',config:{allow_multiple:true}},{entityId:'e'}),seed('record.create','r',{data:{owner:[alice,charlie]}},{entityId:'e'}),seed('record.create','unknown',{data:{}},{entityId:'e'})])
  assert.equal(store.contentAccess.fieldDefinition('e','f')?.multiple,true)
  store.contentAccess.flush();store.recordTeamwork.flush();store=new BridgeStore(root,21,null,null)
  assert.deepEqual(store.recordTeamwork.sharedPersonCell('r','owner','t'),[alice,charlie])
  assert.throws(()=>store.recordTeamwork.sharedPersonCell('unknown','owner','t'),/unavailable/)
  const old=seed('record.update','r',{data:{owner:[bob]}},{entityId:'e',hlc:'1:0:old'})
  store.appendOp(old);assert.deepEqual(store.recordTeamwork.sharedPersonCell('r','owner','t'),[alice,charlie],'late old update cannot replace current assignment projection')
  let body:any,reply:any;const published:ModulesSyncOp[]=[],refreshes:unknown[]=[]
  const handler=createRecordTeamworkHttpHandler({get store(){return store},requestAssignmentSnapshot:r=>refreshes.push(r),teamId:()=> 't',authenticate:()=>({member:store.findMember('alice')!,deviceId:'alice'}),departmentExists:()=>false,readBody:async()=>body,releaseBody:()=>{},json:(_r,status,result)=>reply={status,result},drain:()=>{},takeWrite:()=>true,publish:ops=>published.push(...ops),fieldRefusal:()=>null,canRead:()=>true,assertWritable:()=>{}})
  const request=async(command:unknown,path='/api/record-teamwork')=>{body={teamId:'t',moduleId:'m',entityId:'e',recordId:'r',commandId:'command-'+ ++serial,expectedRevision:store.recordTeamwork.read('r').revision,command};await handler({method:'POST'} as any,{setHeader:()=>{}} as any,new URL('http://localhost'+path));return reply}
  assert.equal((await request({action:'configure',config:{reviewRequired:false,reviewerMemberIds:[],completedStatusValues:[],assigneeFieldId:'f'}})).status,200)
  store.appendOp(seed('record.update','r',{data:{owner:[alice,charlie]}},{entityId:'e',moduleId:'m',hlc:`${Date.now()+2000}:7:slightly-ahead-device`}))
  const ownerBaseline=store.contentAccess.recordCellHlc('r','owner')
  const result=await request({action:'handoff',to:bob},'/api/record-teamwork/assistant');assert.equal(result.status,200,JSON.stringify(result))
  assert.equal((published.at(-1)?.patch?.baseCellHlcs as any).owner,ownerBaseline,'accepted handoff identifies the exact prior assignment version');assert.equal(compareYjsCellHlc(published.at(-1)?.hlc,ownerBaseline),1,'handoff advances the observed version even with an accepted clock lead')
  assert.deepEqual((published.at(-1)?.patch?.data as any).owner.map((p:any)=>p.id),['charlie','bob'])
  assert(!JSON.stringify(published).includes('private-ai'))
  assert.deepEqual(store.recordTeamwork.sharedPersonCell('r','owner','t').map(p=>p.id),['charlie','bob'])
  store.contentAccess.flush();store.recordTeamwork.flush();store=new BridgeStore(root,21,null,null)
  assert.deepEqual(store.recordTeamwork.sharedPersonCell('r','owner','t').map(p=>p.id),['charlie','bob'])
  // Simulate an old checkpoint that has authoritative clocks but no Person projection.
  ;(store.recordTeamwork as any).personCells.clear()
  const clock=store.contentAccess.recordCellHlc('r','owner')!
  store.appendOp(seed('record.create','r',{data:{owner:[alice]},cellHlcs:{owner:'1:0:old'}},{entityId:'e'}))
  assert.equal(store.recordTeamwork.hasSharedPersonCell('r','owner'),false,'stale publisher snapshot cannot seed a missing projection')
  const before=published.length,revision=store.recordTeamwork.read('r').revision
  const missing=await request({action:'handoff',to:alice});assert.equal(missing.status,409);assert.match(missing.result.error,/Refreshing/)
  assert.equal(published.length,before);assert.equal(store.recordTeamwork.read('r').revision,revision);assert.deepEqual(refreshes,[{teamId:'t',moduleId:'m',entityId:'e',recordId:'r',fieldId:'f'}])
  store.appendOp(seed('record.create','r',{data:{owner:[charlie,bob]},cellHlcs:{owner:clock}},{entityId:'e'}))
  assert.equal(store.recordTeamwork.read('r').revision,revision,'observing an unchanged snapshot does not invalidate reviews or create new work revisions')
  assert.equal((await request({action:'handoff',to:alice})).status,200)
  assert.deepEqual((published.at(-1)?.patch?.data as any).owner.map((p:any)=>p.id),['charlie','bob','alice'],'hydrated handoff preserves every other assignee')
  store.appendOp(seed('field.update','f',{config:{allowMultiple:false}},{entityId:'e'}));assert.equal(store.contentAccess.fieldDefinition('e','f')?.multiple,false)
  store.appendOp(seed('field.update','f',{config:{allowMultiple:true}},{entityId:'e'}));assert.equal(store.contentAccess.fieldDefinition('e','f')?.multiple,true)
 }finally{rmSync(root,{recursive:true,force:true})}
})
