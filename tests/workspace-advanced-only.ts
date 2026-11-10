/** Real encrypted self-hosted storage, fake identity-provider endpoint only. */
import assert from 'node:assert/strict'
import {generateKeyPairSync,randomBytes} from 'node:crypto'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createConfiguredWorkspaceConnections,workspaceConnectionActor} from '../src/workspace-connections/config.js'
import {SelfhostConnectionStore} from '../src/workspace-connections/store.js'
import {AdvancedCredentialBroker} from '../src/workspace-connections/advanced-credentials.js'

const directory=await mkdtemp(join(tmpdir(),'advanced-only-workspace-')),key={key:randomBytes(32)}
const env={TEAMSPACE_CONNECTIONS_PUBLIC_URL:'https://private.fixture.test'}
const identity={teamId:'team',memberId:'owner',deviceId:'desktop',projectId:'project',sessionHash:'session'},actor=workspaceConnectionActor(identity)
const privateKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()
const profile={provider:'google',authMode:'google-service-account',services:['drive'],credentials:{type:'service_account',client_email:'service@project.iam.gserviceaccount.com',client_id:'123456789',private_key:privateKey}}
let calls=0,configured:ReturnType<typeof createConfiguredWorkspaceConnections>
const fetcher:typeof fetch=async(url,init)=>{calls++;assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(String(init?.body)).get('grant_type'),'urn:ietf:params:oauth:grant-type:jwt-bearer');return Response.json({access_token:'isolated-native-token',expires_in:3600,token_type:'Bearer'})}
try{
  configured=createConfiguredWorkspaceConnections(directory,key,who=>JSON.stringify(who)===JSON.stringify(identity),env,fetcher)
  assert(configured);await configured.ready()
  const capabilities=configured.capabilities()
  assert.equal(capabilities.configured,false);assert(capabilities.providers.every(provider=>!provider.configured));assert.equal(capabilities.advancedSetup.configured,true)
  const first=(await configured.service.advancedCreate(actor,profile)).connection
  const lease=await configured.service.lease(actor,first.id)
  assert.equal(lease.credential.accessToken,'isolated-native-token');assert.equal(calls,1)
  await assert.rejects(configured.service.lease({...actor,projectId:'other-project'},first.id))
  await configured.close();configured=null
  const bytes=await readFile(join(directory,'workspace-connections','mail-oauth','mail-store.sqlite3'))
  assert.equal(bytes.includes(Buffer.from('-----BEGIN PRIVATE KEY-----')),false)
  assert.equal(bytes.includes(Buffer.from('isolated-native-token')),false)
  configured=createConfiguredWorkspaceConnections(directory,key,who=>JSON.stringify(who)===JSON.stringify(identity),env,fetcher)
  assert(configured);await configured.ready()
  assert.equal((await configured.service.list(actor)).connections[0]?.id,first.id)
  assert.equal((await configured.service.advancedCreate(actor,profile)).connection.id,first.id,'Lost acknowledgement/restart must not duplicate an administrator registration')
  assert.equal(calls,1,'An unexpired persisted administrator token does not require another exchange')
  await configured.service.disconnect(actor,first.id)
  assert.deepEqual((await configured.service.list(actor)).connections,[])
  await configured.close();configured=null
  // Two broker instances share the actual encrypted server store. Healthy
  // reads bypass another operation's lock; expired credentials serialize once.
  const storage=new SelfhostConnectionStore(directory,key)
  let time=Date.now(),refreshCalls=0
  const tokenFetch:typeof fetch=async()=>{refreshCalls++;await new Promise(resolve=>setTimeout(resolve,20));return Response.json({access_token:'concurrent-native-token',expires_in:3600,token_type:'Bearer'})}
  const brokers=[new AdvancedCredentialBroker(storage,async()=>{},{now:()=>time,fetch:tokenFetch}),new AdvancedCredentialBroker(storage,async()=>{},{now:()=>time,fetch:tokenFetch})]
  try{
    await storage.ready()
    const id=(await brokers[0].create(actor,profile)).connection.id
    let release!:()=>void,entered!:()=>void
    const ready=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve})
    const locked=storage.locked(actor,id,async()=>{entered();await hold})
    await ready
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
      const leases=await Promise.race([Promise.all(Array.from({length:20},(_,index)=>brokers[index%2].lease(actor,id))),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Healthy leases waited on a held account lock')),5000)})])
      assert.equal(leases.length,20);assert.equal(refreshCalls,1,'Healthy credentials avoid redundant exchanges and account locks')
    }finally{if(timer)clearTimeout(timer);release();await locked}
    time+=3600_000
    const leases=await Promise.all(Array.from({length:20},(_,index)=>brokers[index%2].lease(actor,id)))
    assert.equal(refreshCalls,2,'Twenty concurrent expired leases across brokers exchange once after safe lock admission retries')
    assert(leases.every(lease=>lease.credential.expiresAt>time&&lease.leaseExpiresAt>time))
    await brokers[0].remove(actor,id)
  }finally{await storage.close()}
  console.log('PASS advanced-only selfhost: no shared OAuth registration, encrypted restart recovery, exact session/project isolation, deduplication and cleanup')
}finally{await configured?.close();await rm(directory,{recursive:true,force:true})}
