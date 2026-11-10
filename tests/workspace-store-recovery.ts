/** Real encrypted SQLite regressions for expiry recovery and bounded live lists. */
import assert from 'node:assert/strict'
import {createHash,randomBytes} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {ManagedConnectionService,type Actor} from '../src/workspace-connections/service.js'
import {SelfhostConnectionStore} from '../src/workspace-connections/store.js'

const directory=await mkdtemp(join(tmpdir(),'workspace-store-recovery-'))
const key={key:randomBytes(32)},actualNow=Date.now
let now=actualNow()
Date.now=()=>now
let storage=new SelfhostConnectionStore(directory,key)
const actor:Actor={userId:JSON.stringify(['team','member','device']),projectId:'project',tokenId:'current-session'}
const config={key:randomBytes(32),publicUrl:'https://private.example',providers:{google:{clientId:'fixture-client',clientSecret:'fixture-secret'}}}
const fakeFetch:typeof fetch=async(raw,init)=>{
  if(String(raw)==='https://oauth2.googleapis.com/token')return Response.json({access_token:new URLSearchParams(String(init?.body)).get('code'),refresh_token:'fixture-refresh',expires_in:3600,scope:'openid email https://mail.google.com/'})
  assert.equal(String(raw),'https://openidconnect.googleapis.com/v1/userinfo')
  return Response.json({sub:new Headers(init?.headers).get('Authorization')!.slice(7),email:'fixture@example.com',email_verified:true})
}
const makeService=()=>new ManagedConnectionService(config,storage,async()=>{},fakeFetch,()=>now)
let service=makeService()
async function start(owner=actor){return new URL((await service.start(owner,{provider:'google',services:['mail']})).authorizationUrl).searchParams.get('state')!}
async function finish(state:string,account:string){await service.callback('google',new URLSearchParams({state,code:account}))}
function accountId(owner:Actor,account:string){
  const hash=createHash('sha256').update(JSON.stringify([owner.userId,owner.projectId,'google',account])).digest('hex')
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`
}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
try{
  await storage.ready()
  await finish(await start(),'reconnected-account')
  const id=accountId(actor,'reconnected-account')
  await service.disconnect(actor,id)
  await finish(await start(),'reconnected-account')
  now+=21*60_000
  // Restart preserves both the account and the older, now-expired fence.
  await storage.close();storage=new SelfhostConnectionStore(directory,key);await storage.ready();service=makeService()
  assert.equal((await service.lease(actor,id)).ok,true)
  await service.disconnect(actor,id)
  assert.deepEqual((await service.list(actor)).connections,[],'Disconnect succeeds on its first attempt after an earlier removal marker expires')
  await assert.rejects(service.lease(actor,id),error=>(error as {code:string}).code==='not_found')
  const renewedFence=await storage.get('connection-revocation',id,actor)
  assert(renewedFence,'Disconnect durably renews its revocation fence')
  await storage.close();storage=new SelfhostConnectionStore(directory,key);await storage.ready();service=makeService()
  assert.deepEqual(await storage.get('connection-revocation',id,actor),renewedFence)

  const expiredId='expired-owner-record',unrelatedId='expired-unrelated-record',expired={id:expiredId,generation:'old'}
  await storage.put('connection-revocation',expiredId,actor,expired,now+1)
  await storage.put('connection-revocation',unrelatedId,actor,{id:unrelatedId,generation:'old'},now+1)
  now+=2
  for(const owner of [{...actor,userId:'other-owner'},{...actor,projectId:'other-project'}]){
    await assert.rejects(storage.put('connection-revocation',expiredId,owner,expired,now+60_000),error=>(error as {code:string}).code==='ownership','Expiry does not permit a different owner to replace the target')
    await storage.remove('connection-revocation',expiredId,owner)
    assert.equal(await storage.get('connection-revocation',expiredId,owner),null)
  }
  await storage.put('connection-revocation',expiredId,actor,{id:expiredId,generation:'new'},now+60_000)
  assert.deepEqual(await storage.get('connection-revocation',expiredId,actor),{id:expiredId,generation:'new'})
  // An unrelated write still sweeps expired rows: this ID can now be reused.
  await storage.put('connection-revocation',unrelatedId,{...actor,userId:'other-owner'},{id:unrelatedId,generation:'new'},now+60_000)

  const listActor={...actor,projectId:'bounded-live-list'}
  const accounts=Array.from({length:105},(_,index)=>{const account=`account-${index}`;return{account,id:accountId(listActor,account)}}).sort((a,b)=>a.id.localeCompare(b.id))
  for(const account of accounts.slice(0,100)){
    await finish(await start(listActor),account.account)
    await service.disconnect(listActor,account.id)
  }
  // Five tabs may be opened while there are exactly 100 recent removal
  // markers. Completing them yields 105 distinct markers without exceeding
  // the account cap; no storage rows are seeded behind the service boundary.
  const tabs:string[]=[]
  for(let index=0;index<5;index++)tabs.push(await start(listActor))
  await finish(tabs[0]!,accounts[100]!.account);await service.disconnect(listActor,accounts[100]!.id)
  now+=2*60_000
  for(let index=1;index<5;index++){
    await finish(tabs[index]!,accounts[100+index]!.account)
    await service.disconnect(listActor,accounts[100+index]!.id)
  }
  now+=19*60_000
  await storage.close();storage=new SelfhostConnectionStore(directory,key);await storage.ready();service=makeService()
  assert.equal((await storage.list('connection-revocation',listActor)).length,4,'Live markers after 101 expired rows survive pagination and restart')
  assert.deepEqual(await storage.list('connection-revocation',{...listActor,userId:'other-owner'}),[])
  const target=accounts[104]!
  assert(await storage.get('connection-revocation',target.id,listActor))
  await finish(await start(listActor),target.account)
  assert.equal((await service.list(listActor)).connections[0]?.id,target.id,'Fresh Add observes the current fence even when expired rows fill the first page')

  const entered=deferred(),release=deferred()
  const held=storage.locked(actor,['connection-a','oauth-start'],async()=>{entered.resolve();await release.promise})
  await entered.promise
  try{
    for(const lock of ['connection-a','oauth-start'])await assert.rejects(storage.locked(actor,lock,async()=>{}),error=>(error as {code:string}).code==='busy')
    await assert.rejects(storage.locked(actor,['free-key','oauth-start'],async()=>{}),error=>(error as {code:string}).code==='busy')
    await storage.locked(actor,'free-key',async()=>{})
    await storage.locked({...actor,projectId:'other-project'},['connection-a','oauth-start'],async()=>{})
  }finally{release.resolve();await held}
  await assert.rejects(storage.locked(actor,['connection-a','oauth-start'],async()=>{throw Error('fixture failure')}),/fixture failure/)
  await storage.locked(actor,['connection-a','oauth-start'],async()=>{})
  console.log('PASS workspace store recovery: expired fence replacement, durable owner isolation, bounded live pagination, fresh Add recovery and atomic multi-key lock release')
}finally{
  Date.now=actualNow
  await storage.close();await rm(directory,{recursive:true,force:true})
}
