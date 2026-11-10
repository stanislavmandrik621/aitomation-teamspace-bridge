import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {BridgeStore,hashSessionToken} from '../src/store.js'
import {createRecordTreeHttpHandler} from '../src/record-tree-http.js'
import type {ModulesSyncOp} from '../src/index.js'
const root=mkdtempSync(join(tmpdir(),'record-tree-http-'))
writeFileSync(join(root,'members.json'),JSON.stringify(['alice','bob','viewer'].map(id=>({memberId:id,email:id+'@test.invalid',displayName:id,role:id==='alice'?'admin':id==='bob'?'member':'viewer',createdAt:Date.now(),sessions:{[id+'-device']:hashSessionToken(id+'-token')}}))))
let store=new BridgeStore(root,21,null,null),serial=0,afterBody:(()=>void)|null=null,locked=false
const published:ModulesSyncOp[]=[]
const seed=(kind:string,targetId:string,patch:Record<string,unknown>={},rest:Partial<ModulesSyncOp>={}):ModulesSyncOp=>({kind,targetId,targetKind:kind.split('.')[0],opId:'seed-'+ ++serial,originMemberId:'alice',originRole:'admin',originDevice:'alice-device',hlc:`${Date.now()}:${serial}:alice`,protocolVersion:2,hopCount:0,patch,...rest})
store.appendOps([seed('module.create','m'),seed('entity.create','e',{moduleId:'m'},{moduleId:'m'}),...['a','b','c','d'].map((id,i)=>seed('record.create',id,{data:{name:id},parent_id:null,sort_order:i+1},{entityId:'e',moduleId:'m'}))])
const handler=createRecordTreeHttpHandler({get store(){return store},teamId:()=> 'team',authenticate:req=>store.findBySession(String(req.headers.authorization??'')),departmentExists:()=>false,
 readBody:async(req,max)=>{const buffers:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Too large');buffers.push(Buffer.from(chunk))}const body=JSON.parse(Buffer.concat(buffers).toString());afterBody?.();afterBody=null;return body},releaseBody:()=>{},json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},drain:req=>req.resume(),takeWrite:()=>true,publish:ops=>published.push(...ops),fieldRefusal:()=>null,canRead:()=>true,assertWritable:()=>{if(locked)throw Error('locked')}})
const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost'))});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const base='http://127.0.0.1:'+address.port
const payload=(id:string,target:string|null,commandId:string)=>{const row=store.recordTree.node(id)!;return{teamId:'team',moduleId:'m',entityId:'e',commandId,order:[{id,sort_order:row.sortOrder??1,parent_id:target,prev_parent_id:row.parentId,prev_sort_order:row.sortOrder??1}]}}
const request=async(actor:string,body:unknown)=>{const response=await fetch(base+'/api/record-tree/reorder',{method:'POST',headers:{authorization:actor+'-token','content-type':'application/json'},body:JSON.stringify(body)});return{status:response.status,body:await response.json() as any}}
try{
 assert.equal((await request('viewer',payload('a','b','viewer'))).status,409)
 const requests=[payload('b','c','opposite-b'),payload('c','b','opposite-c')]
 const outcomes=await Promise.all(requests.map((body,i)=>request(i?'bob':'alice',body)))
 assert.equal(outcomes.filter(r=>r.status===200).length,1);assert.equal(outcomes.filter(r=>r.status===409).length,1);assert.match(outcomes.find(r=>r.status===409)!.body.error,/loop/)
 assert.ok(!(store.recordTree.node('b')!.parentId==='c'&&store.recordTree.node('c')!.parentId==='b'))
 const winner=outcomes.findIndex(r=>r.status===200),before=published.length,actor=winner?'bob':'alice'
 assert.equal((await request(actor,requests[winner])).status,200);assert.equal(published.length,before)
 store=new BridgeStore(root,21,null,null);assert.equal((await request(actor,requests[winner])).status,200);assert.equal(published.length,before)
 assert.equal((await request(actor,{...requests[winner],order:[{...requests[winner].order[0],parent_id:null}]})).status,409)
 const stale=payload('a','b','stale');assert.equal((await request('alice',payload('a','c','move-first'))).status,200)
 const skipped=await request('bob',stale);assert.equal(skipped.status,200);assert.equal(skipped.body.data.updated,0);assert.equal(skipped.body.data.staleSkipped,1);assert.equal(store.recordTree.node('a')!.parentId,'c')
 const badTarget=payload('a','d','deleted-target');afterBody=()=>store.appendOp(seed('record.delete','d',{}, {entityId:'e',moduleId:'m'}));assert.equal((await request('alice',badTarget)).status,409)
 locked=true;assert.equal((await request('alice',payload('a',null,'locked'))).status,409);locked=false
 const oldWs=seed('cascade.patch',requests[1-winner].order[0].id,{reorderKind:'record',order:requests[1-winner].order},{entityId:'e',moduleId:'m'});assert.throws(()=>store.appendOp(oldWs),/loop/)
 assert.throws(()=>store.appendOp(seed('record.update',requests[1-winner].order[0].id,{parent_id:requests[1-winner].order[0].parent_id},{entityId:'e',moduleId:'m'})),/loop/)
 assert.throws(()=>store.appendOp({...oldWs,opId:'spoof',patch:{...oldWs.patch,serverTreeReorder:true}}),/Server-only/)
 const createTree=(id:string,parentId:string|null)=>seed('record.create',id,{data:{name:id},parent_id:parentId,sort_order:1},{entityId:'e',moduleId:'m'})
 // A shared snapshot can transmit children before parents; resolving that
 // pending reference must still refuse a cycle and a cross-table link.
 store.appendOp(createTree('snapshot-child','snapshot-parent'))
 store.appendOp(createTree('snapshot-parent',null))
 assert.equal(store.recordTree.node('snapshot-child')!.parentId,'snapshot-parent')
 store.appendOp(createTree('cycle-child','cycle-parent'))
 assert.throws(()=>store.appendOp(createTree('cycle-parent','cycle-child')),/loop/)
 store.appendOp(createTree('grandparent',null))
 store.appendOp(createTree('parent','grandparent'))
 store.appendOp(createTree('child','parent'))
 store.appendOp(seed('record.delete','parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal(store.recordTree.node('child')!.parentId,'grandparent')
 assert.equal(store.recordTree.node('child')!.sortOrder,2,'promotion appends after the not-yet-deleted parent')
 assert.equal((await request('alice',payload('child',null,'after-promote'))).status,200)
 store.appendOp(createTree('trash-parent',null))
 store.appendOp(createTree('trash-child','trash-parent'))
 store.appendOp(seed('record.trash','trash-parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal(store.recordTree.node('trash-parent')!.deleted,true)
 assert.equal(store.recordTree.node('trash-child')!.parentId,null)
 store=new BridgeStore(root,21,null,null)
 store.appendOp(seed('record.restore','trash-parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal(store.recordTree.node('trash-parent')!.deleted,false)
 assert.equal(store.recordTree.node('trash-child')!.parentId,'trash-parent')
 assert.equal(store.recordTree.node('trash-child')!.sortOrder,0,'restored first child uses native zero-based sort')
 store.appendOp(seed('record.trash','trash-parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal((await request('alice',payload('trash-child','grandparent','explicit-move'))).status,200)
 store.appendOp(seed('record.restore','trash-parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal(store.recordTree.node('trash-child')!.parentId,'grandparent','restore must preserve a later explicit child move')
 store.appendOp(seed('record.purge','trash-parent',{}, {entityId:'e',moduleId:'m'}))
 assert.equal(store.recordTree.node('trash-parent')!.deleted,true)
 console.log('PASS record tree: concurrent opposite parents, native-style CAS, deleted target, roles, lock, exact retry/restart and WebSocket bypass refusal')
}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(root,{recursive:true,force:true})}
