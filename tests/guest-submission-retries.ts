import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PublicShareBridgeStore} from '../src/public-share-store.js'
import {PortalBridgeStore} from '../src/portal-store.js'
for(const kind of ['share','portal'] as const){
 const root=mkdtempSync(join(tmpdir(),'guest-retry-'))
 try {
  const factory=()=>kind==='share'?new PublicShareBridgeStore(root,null):new PortalBridgeStore(root)
  let store=factory()
  const row:any={tokenHash:'b'.repeat(64),localShareId:'test-share',localPortalId:'test-portal',mode:'create',viewType:'form',label:'Test',name:'Test',authMode:'anonymous',pinHash:null,passwordHash:null,allowedActions:['create'],includeCsv:false,expiresAt:null,revokedAt:null,payloadReady:true,createdAt:Date.now(),updatedAt:Date.now(),ownerMemberId:'admin'}
  const payload:any={version:2,mode:'create',viewType:'form',label:'Test',entityId:'entity',name:'Test',authMode:'anonymous',allowedActions:['create'],design:{},aclSnapshot:{},fields:[{slug:'title',name:'Title',field_type:'text',required:true,config:{},default_value:null}],rows:[],total:0,truncated:false,pushedAt:Date.now()}
  const submit=(key='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',title='Retained request')=>store.enqueueSubmission({row,payload,rawData:{title},clientIp:'one-office',submissionKey:key} as any)
  const first=submit();assert.ok(first.ok)
  for(let i=0;i<20;i++){const retry=submit();assert.ok(retry.ok,JSON.stringify(retry));assert.equal(retry.id,first.id,'retry must return the original submission ID')}
  assert.equal(store.listPendingSubmissions().length,1)
  store=factory();const restarted=submit();assert.ok(restarted.ok);assert.equal(restarted.id,first.id)
  const receiptPath=join(root,kind==='share'?'share-submission-receipts':'portal-submission-receipts',first.id.slice(0,2),first.id+'.json')
  const receipt=readFileSync(receiptPath)
  writeFileSync(receiptPath,'partial-write')
  const corrupt=submit();assert.equal(corrupt.ok,false);if(!corrupt.ok)assert.equal(corrupt.status,503,'unreadable receipts refuse instead of accepting duplicates')
  writeFileSync(receiptPath,receipt)
  const otherScope=store.enqueueSubmission({row:{...row,tokenHash:'c'.repeat(64)},payload,rawData:{title:'Retained request'},clientIp:'another-office',submissionKey:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'} as any)
  assert.ok(otherScope.ok);assert.notEqual(otherScope.id,first.id,'identical retry key is isolated by public token')
  const scopeAck=kind==='share'?(store as PublicShareBridgeStore).ackSubmission(otherScope.id,'applied',null):(store as PortalBridgeStore).ackSubmission({submissionId:otherScope.id,status:'applied'})
  assert.ok(scopeAck.ok)
  const mismatch=submit(undefined,'Different content');assert.equal(mismatch.ok,false);if(!mismatch.ok)assert.equal(mismatch.status,409)
  const path=join(root,kind==='share'?'public-share-submissions':'portal-submissions',first.id+'.json'),pending=readFileSync(path)
  const ack=kind==='share'?(store as PublicShareBridgeStore).ackSubmission(first.id,'applied',null):(store as PortalBridgeStore).ackSubmission({submissionId:first.id,status:'applied'})
  assert.ok(ack.ok);assert.equal(existsSync(path),false)
  store=factory();const afterAck=submit();assert.ok(afterAck.ok);assert.equal(afterAck.id,first.id);assert.equal(store.listPendingSubmissions().length,0,'lost success response must not recreate an acknowledged submission')
  // Simulate process exit after receipt commit but before pending-file unlink.
  writeFileSync(path,pending);assert.equal(store.listPendingSubmissions().length,0,'completed receipt suppresses leftover pending file')
  const next=submit('ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee');assert.ok(next.ok);assert.notEqual(next.id,first.id,'new explicit submission remains allowed')
  row.revokedAt=Date.now();assert.equal(submit().ok,false,'revocation still checked before replay')
  console.log(kind+': pending retries, restart, mismatch, acknowledged retry, crash residue and revoke passed')
 }finally{rmSync(root,{recursive:true,force:true})}
}
