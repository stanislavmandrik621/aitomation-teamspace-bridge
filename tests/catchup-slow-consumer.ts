import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeStore } from '../src/store.js'
const dir=mkdtempSync(join(tmpdir(),'catchup-paced-'))
try {
 const store=new BridgeStore(dir,21,null,null)
 const count=2400
 store.appendOps(Array.from({length:count},(_,i)=>({opId:`paced-${i}`,kind:'entity.create',targetId:`entity-${i}`,targetKind:'entity',hlc:`${Date.now()}-${i}-source`,originDevice:'source',protocolVersion:2,hopCount:0,patch:{name:'History '+i}} as any)))
 const consume=async(slow:boolean)=>{const ids=[];for await(const op of store.scanOpsFromStart()){ids.push(op.opId);if(slow&&ids.length%16===0)await new Promise(resolve=>setTimeout(resolve,5))}return ids}
 const [fast,slow]=await Promise.all([consume(false),consume(true)])
 assert.equal(fast.length,count);assert.deepEqual(slow,fast);assert.equal(new Set(slow).size,count)
 assert.ok(store.fullScanShareStats().sharedJoins>=1)
 console.log('PASS shared catch-up: fast and paced consumers both receive all 2,400 ordered operations without dropping a backlog')
}finally{rmSync(dir,{recursive:true,force:true})}
