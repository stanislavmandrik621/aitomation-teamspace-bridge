import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import * as Y from 'yjs'
import {RecordTeamworkStore} from '../src/record-teamwork-store.js'
import {checkpointContainsAccepted,canonicalYjsState,mergeAcceptedYjs} from '../src/record-teamwork-yjs.js'
import {emptyRecordTeamwork,type RecordTeamworkAuthority} from '../src/record-teamwork-state.js'
import type {ModulesSyncOp} from '../src/index.js'
const authority:RecordTeamworkAuthority={actor:{id:'a',name:'Alice',kind:'member'},teamId:'t',canWrite:true,canConfigure:true,validateMember:()=>{},validateConfig:()=>{},validateHandoff:()=>{}}
let serial=0
const op=(kind:string,data:Record<string,unknown>={},extra:Record<string,unknown>={}):ModulesSyncOp=>({kind,targetKind:'record',targetId:'r',entityId:'e',moduleId:'m',opId:'yjs-'+ ++serial,hlc:`${Date.now()}:${serial}:a`,originDevice:'a',originMemberId:'a',originRole:'admin',hopCount:0,protocolVersion:2,patch:{data,...extra}})
function doc(text='baseline',resetId?:string){const d=new Y.Doc();d.getMap('_modules_checkpoint').set('binding',JSON.stringify(['r','body','text']));d.getMap('_modules_checkpoint').set('genesis','a'.repeat(64));if(resetId)d.getMap('_modules_checkpoint').set('resetId',resetId);d.getText('content').insert(0,text);return d}
const b64=(d:Y.Doc)=>Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64')
const checkpoint=(d:Y.Doc)=>({fieldSlug:'body',kind:'text',stateB64:b64(d)})
function save(s:RecordTeamworkStore,o:ModulesSyncOp){s.validateCommit([o],()=>['status']);s.observe(o);s.flush()}
function command(s:RecordTeamworkStore,action:string){const current=s.read('r');const o=op('record.teamwork',{}, {expectedRevision:current.revision,command:action==='configure'?{action,config:{statusFieldId:'s',completedStatusValues:['done'],reviewRequired:true,reviewerMemberIds:['a']}}:{action}});const stamped=s.stamp(o,authority,()=>['status']);save(s,stamped)}
function fixture(fn:(store:RecordTeamworkStore,path:string)=>void){const path=mkdtempSync(join(tmpdir(),'teamwork-yjs-'));try{fn(new RecordTeamworkStore(path,null),path)}finally{rmSync(path,{recursive:true,force:true})}}

test('initial equal seed is settled; newly accepted insert/delete blocks review, approval and completion until exact checkpoint',()=>fixture(s=>{
 save(s,op('record.create',{body:'baseline',status:'todo'}))
 const d=doc();s.acceptYjs('r','body',b64(d));assert.equal(s.hasUnsettledYjs('r'),false)
 command(s,'configure');command(s,'request_review')
 const stale=checkpoint(d)
 d.getText('content').insert(0,'remote ');s.acceptYjs('r','body',b64(d))
 assert.throws(()=>command(s,'approve'),/still saving/)
 assert.throws(()=>command(s,'request_review'),/still saving/)
 assert.throws(()=>save(s,op('record.update',{body:'baseline'},{yjsCheckpoint:stale})),/behind accepted/)
 assert.throws(()=>save(s,op('record.update',{body:'plain replacement'})),/still saving/)
 save(s,op('record.update',{body:d.getText('content').toString()},{yjsCheckpoint:checkpoint(d)}))
 command(s,'request_review');command(s,'approve')
 const beforeDelete=checkpoint(d);const vector=Y.encodeStateVector(d)
 d.getText('content').delete(0,7)
 // Delete-only update has an unchanged state vector; vector-only receipts would be unsafe.
 assert.deepEqual(Y.encodeStateVector(d),vector)
 s.acceptYjs('r','body',Buffer.from(Y.encodeStateAsUpdate(d,vector)).toString('base64'))
 assert.throws(()=>save(s,op('record.update',{status:'done'})),/still saving/)
 assert.throws(()=>save(s,op('record.update',{body:'remote baseline'},{yjsCheckpoint:beforeDelete})),/behind accepted/)
 save(s,op('record.update',{body:'baseline'},{yjsCheckpoint:checkpoint(d)}))
 assert.equal(s.hasUnsettledYjs('r'),false);assert.equal(s.read('r').review.state,'none');d.destroy()
}))
test('durable acceptance survives restart before checkpoint and old WAL replay cannot settle or reset it',()=>fixture((s,path)=>{
 const created=op('record.create',{body:'baseline'});save(s,created)
 const d=doc();const baseline=op('record.update',{body:'baseline'},{yjsCheckpoint:checkpoint(d)});save(s,baseline)
 d.getText('content').insert(0,'accepted ');s.acceptYjs('r','body',b64(d))
 let reopened=new RecordTeamworkStore(path,null);reopened.observe(created);reopened.observe(baseline);reopened.flush()
 const recovered=new Y.Doc();Y.applyUpdate(recovered,Buffer.from(reopened.acceptedYjsState('r','body')!,'base64'));assert.equal(recovered.getText('content').toString(),'accepted baseline');recovered.destroy()
 assert.equal(reopened.hasUnsettledYjs('r'),true)
 command(reopened,'configure');assert.throws(()=>command(reopened,'request_review'),/still saving/)
 const cp=op('record.update',{body:d.getText('content').toString()},{yjsCheckpoint:checkpoint(d)});save(reopened,cp)
 reopened=new RecordTeamworkStore(path,null);assert.equal(reopened.hasUnsettledYjs('r'),false)
 command(reopened,'request_review');d.destroy()
}))
test('settled scalar replacement fences old generation, accepts exact new seed, preserves restart receipt',()=>fixture((s,path)=>{
 save(s,op('record.create',{body:'baseline'}));const d=doc();s.acceptYjs('r','body',b64(d))
 const replacement=op('record.update',{body:'replacement'});save(s,replacement)
 const staleScalar={...op('record.update',{body:'old delayed scalar'}),hlc:'1:0:old'};save(s,staleScalar)
 assert.throws(()=>s.acceptYjs('r','body',b64(d)),/older document/)
 const fresh=doc('replacement',`hlc:${replacement.hlc}`);s.acceptYjs('r','body',b64(fresh));assert.equal(s.hasUnsettledYjs('r'),false)
 const reopened=new RecordTeamworkStore(path,null);reopened.observe(replacement);reopened.flush()
 fresh.getText('content').insert(0,'next ');reopened.acceptYjs('r','body',b64(fresh));assert.equal(reopened.hasUnsettledYjs('r'),true)
 save(reopened,op('record.update',{body:'next replacement'},{yjsCheckpoint:checkpoint(fresh)}));assert.equal(reopened.hasUnsettledYjs('r'),false)
 d.destroy();fresh.destroy()
}))
test('malformed, oversized, wrong-bound and content-mismatched checkpoints never mark accepted state settled',()=>fixture(s=>{
 save(s,op('record.create',{body:'baseline'}));const d=doc();s.acceptYjs('r','body',b64(d));d.getText('content').insert(0,'new ');s.acceptYjs('r','body',b64(d))
 assert.throws(()=>s.acceptYjs('r','body','A'.repeat(512001)),/oversized/)
 assert.throws(()=>s.acceptYjs('r','body','aaaa'),()=>true)
 assert.throws(()=>save(s,op('record.update',{body:'forged scalar'},{yjsCheckpoint:checkpoint(d)})),/does not match/)
 const wrong=doc();wrong.getMap('_modules_checkpoint').set('binding',JSON.stringify(['other','body','text']))
 assert.throws(()=>save(s,op('record.update',{body:'baseline'},{yjsCheckpoint:checkpoint(wrong)})),/does not match/)
 assert.equal(s.hasUnsettledYjs('r'),true);d.destroy();wrong.destroy()
}))
test('100 writers retain every accepted intent and checkpoints must include aggregate, including late dependencies',()=>fixture(s=>{
 save(s,op('record.create',{body:'baseline'}));const baseline=doc(),writers:Array<Y.Doc>=[];command(s,'configure')
 const started=performance.now()
 for(let i=0;i<100;i++){const d=new Y.Doc();Y.applyUpdate(d,Y.encodeStateAsUpdate(baseline));d.getText('content').insert(0,`[${i}]`);s.acceptYjs('r','body',b64(d));writers.push(d)}
 const joined=new Y.Doc();for(const writer of writers)Y.applyUpdate(joined,Y.encodeStateAsUpdate(writer))
 const text=joined.getText('content').toString();for(let i=0;i<100;i++)assert.ok(text.includes(`[${i}]`))
 save(s,op('record.update',{body:text},{yjsCheckpoint:checkpoint(joined)}));assert.equal(s.hasUnsettledYjs('r'),false)
 console.log(`100 durable Yjs acceptances + aggregate checkpoint: ${Math.round(performance.now()-started)}ms (small record, local SQLite)`)
 for(const d of [baseline,joined,...writers])d.destroy()
}))
test('whiteboard accepted moves and deletions need matching checkpoint and remain recoverable',()=>fixture(s=>{
 const shape={id:'one',type:'rect',x:1,y:2,width:20,height:30}
 const scene={version:1,shapes:[shape]}
 save(s,op('record.create',{board:JSON.stringify(scene)}))
 const d=new Y.Doc(),meta=d.getMap('_modules_checkpoint');meta.set('binding',JSON.stringify(['r','board','whiteboard']));meta.set('genesis','b'.repeat(64));d.getMap('shapes').set('__wbv','1');d.getMap('shapes').set('one',JSON.stringify(shape));d.getArray('order').insert(0,['one'])
 s.acceptYjs('r','board',b64(d));assert.equal(s.hasUnsettledYjs('r'),false)
 d.getMap('shapes').set('one',JSON.stringify({...shape,x:9}));s.acceptYjs('r','board',b64(d));assert.equal(s.hasUnsettledYjs('r'),true)
 const cp={fieldSlug:'board',kind:'whiteboard',stateB64:b64(d)}
 assert.throws(()=>save(s,op('record.update',{board:JSON.stringify(scene)},{yjsCheckpoint:cp})),/does not match/)
 save(s,op('record.update',{board:{version:1,shapes:[{...shape,x:9}]}},{yjsCheckpoint:cp}));assert.equal(s.hasUnsettledYjs('r'),false)
 d.transact(()=>{d.getMap('shapes').delete('one');d.getArray('order').delete(0,1)})
 s.acceptYjs('r','board',b64(d));assert.equal(s.hasUnsettledYjs('r'),true)
 const recovered=new Y.Doc();Y.applyUpdate(recovered,Buffer.from(s.acceptedYjsState('r','board')!,'base64'));assert.equal(recovered.getArray('order').length,0)
 save(s,op('record.update',{board:JSON.stringify({version:1,shapes:[]})},{yjsCheckpoint:{...cp,stateB64:b64(d)}}));assert.equal(s.hasUnsettledYjs('r'),false)
 recovered.destroy();d.destroy()
}))
