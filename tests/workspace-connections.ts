/** Real HTTP + encrypted SQLite boundary tests; provider OAuth is a deterministic fixture. */
import assert from 'node:assert/strict'
import {microsoftFixtureIdToken,microsoftFixtureJwksResponse,microsoftFixtureJwksUrl} from '../../../scripts/test-helpers/microsoft-oidc-wave41.mjs'
import {createServer} from 'node:http'
import {randomBytes} from 'node:crypto'
import {mkdtemp,rm,access} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {once} from 'node:events'
import {createConfiguredWorkspaceConnections,workspaceConnectionActor,actorWorkspaceIdentity} from '../src/workspace-connections/config.js'
import {createWorkspaceConnectionsHttpHandler} from '../src/workspace-connections/http.js'
import {hashSessionToken} from '../src/store.js'
import {SelfhostConnectionStore} from '../src/workspace-connections/store.js'

const directory=await mkdtemp(join(tmpdir(),'workspace-connections-'))
const key={key:randomBytes(32)}
const members=new Map([
  ['owner-session',{member:{memberId:'owner',role:'owner'},deviceId:'desktop'}],
  ['other-session',{member:{memberId:'other',role:'member'},deviceId:'desktop'}],
  ['other-device',{member:{memberId:'owner',role:'owner'},deviceId:'second-device'}],
  ['viewer-session',{member:{memberId:'viewer',role:'viewer'},deviceId:'desktop'}],
])
const identity={teamId:'team',memberId:'owner',deviceId:'desktop',projectId:'project',sessionHash:hashSessionToken('owner-session')}
const microsoftClient='33333333-3333-4333-8333-333333333333',microsoftTenant='11111111-1111-4111-8111-111111111111'
let providerCalls=0,bodyReads=0,bodyReleases=0,signingKeyCalls=0,microsoftNonce=''
let afterGoogleToken:(()=>Promise<void>)|undefined
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return{promise,resolve}}
const fakeFetch:typeof fetch=async(raw,init)=>{
  const url=String(raw)
  if(url===microsoftFixtureJwksUrl){signingKeyCalls++;return microsoftFixtureJwksResponse()}
  providerCalls++
  if(url==='https://oauth2.googleapis.com/token'){
    const hook=afterGoogleToken;afterGoogleToken=undefined;await hook?.()
    const body=new URLSearchParams(String(init?.body))
    assert.equal(body.get('client_id'),'fixture-client');assert.equal(body.get('client_secret'),'fixture-secret')
    if(body.get('grant_type')==='refresh_token'){
      assert.equal(body.get('refresh_token'),'revoked-refresh')
      return Response.json({error:'invalid_grant',error_description:'sensitive-provider-diagnostic'},{status:400})
    }
    assert.equal(body.get('redirect_uri'),'https://private.example/v1/connections/oauth/google/callback')
    assert.match(body.get('code_verifier')??'',/^[\w-]{64}$/)
    const limited=body.get('code')==='limited-code',revoked=body.get('code')==='revoked-code'
    return Response.json({access_token:'fixture-access',refresh_token:revoked?'revoked-refresh':'fixture-refresh',expires_in:revoked?60:3600,scope:limited?'openid email https://www.googleapis.com/auth/gmail.readonly':'openid email https://mail.google.com/ https://www.googleapis.com/auth/drive'})
  }
  if(url==='https://openidconnect.googleapis.com/v1/userinfo')return Response.json({sub:'provider-owner',email:'owner@example.com',email_verified:true})
  if(url==='https://login.microsoftonline.com/organizations/oauth2/v2.0/token')return Response.json({id_token:microsoftFixtureIdToken({clientId:microsoftClient,tenantId:microsoftTenant,subject:'work-account',nonce:microsoftNonce,now:Date.now(),accessToken:'ms-access'}),access_token:'ms-access',refresh_token:'ms-refresh',expires_in:3600,scope:'openid email User.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Files.ReadWrite.All Contacts.ReadWrite'})
  if(url==='https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName')return Response.json({id:'work-account',mail:null,userPrincipalName:'employee@work.example'})
  throw Error('Unexpected provider business-data request')
}
const configured=createConfiguredWorkspaceConnections(directory,key,scope=>scope.teamId==='team'&&[...members.entries()].some(([token,member])=>member.member.role!=='viewer'&&member.member.memberId===scope.memberId&&member.deviceId===scope.deviceId&&hashSessionToken(token)===scope.sessionHash),{
  TEAMSPACE_CONNECTIONS_PUBLIC_URL:'https://private.example',TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_ID:'fixture-client',TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_SECRET:'fixture-secret',
  TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_ID:microsoftClient,TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_SECRET:'fixture-ms-secret',TEAMSPACE_CONNECTIONS_MICROSOFT_TENANT:'organizations',
},fakeFetch)!
const handler=createWorkspaceConnectionsHttpHandler({connections:configured,teamId:()=> 'team',
  authenticate:req=>members.get(String(req.headers.authorization??'').replace(/^Bearer /i,'').trim())??null,
  readBody:async(req,max,opts)=>{bodyReads++;assert.equal(max,16*1024);assert.equal(opts.reserveBytes,max);const chunks:Buffer[]=[];let size=0;for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>max)throw Error('Too large');chunks.push(bytes)}return JSON.parse(Buffer.concat(chunks).toString())},
  releaseBody:()=>{bodyReleases++},drain:req=>{req.resume()},json:(res,status,body)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(body))},
})
const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost')).then(handled=>{if(!handled){res.statusCode=404;res.end()}}).catch(()=>{res.statusCode=500;res.end()})})
server.listen(0,'127.0.0.1');await once(server,'listening')
const address=server.address();assert(address&&typeof address!=='string')
const origin=`http://127.0.0.1:${address.port}`
const call=async(route:string,body:unknown={},token='owner-session',authorization=`Bearer ${token}`)=>{
  const response=await fetch(`${origin}/v1/connections/${route}`,{method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json'},body:JSON.stringify(body)})
  assert.equal(response.headers.get('cache-control'),'no-store')
  return {status:response.status,data:await response.json() as any}
}
try {
  await configured.ready()
  await access(join(directory,'workspace-connections','mail-oauth','mail-store.sqlite3'))
  await assert.rejects(access(join(directory,'mail-oauth','mail-store.sqlite3')),'New Connections storage never opens the legacy mail database')
  assert.deepEqual(actorWorkspaceIdentity(workspaceConnectionActor(identity)),identity)
  assert.throws(()=>actorWorkspaceIdentity({userId:'["team","owner","desktop","extra"]',projectId:'project',tokenId:'session'}))
  assert.throws(()=>workspaceConnectionActor({} as typeof identity),'Every identity field is required')
  const capability=await call('capabilities',{projectId:'project'})
  assert.equal(capability.status,200);assert.equal(capability.data.execution,'native');assert.equal(capability.data.credentialProtocol,1)
  assert.equal(capability.data.hosting,'selfhosted');assert.equal(capability.data.entitled,true,'BYO access does not require a managed-cloud subscription')
  assert.deepEqual(capability.data.providers.map((p:any)=>p.provider),['google','microsoft'],'Desktop provider rows have stable provider identifiers')
  assert.deepEqual(capability.data.providers[0].accountTypes,['personal','work_school'])
  assert.deepEqual(capability.data.providers[1].accountTypes,['work_school'])
  assert.equal(capability.data.providers[1].accountTypesDependOnAppRegistration,true)
  const optional=capability.data.providers[1].optionalPermissions
  for(const id of ['microsoft.excel.workbooks.manage','microsoft.orgcontacts.read','microsoft.orgcontacts.membership.read','microsoft.calendar.forward']){
    const choice=optional.find((value:any)=>value.id===id)
    assert(choice,'Private capability response exposes the explicit endpoint choice '+id)
    assert.equal('scopes'in choice,false,'Scope strings never become user-supplied consent fields')
    assert.equal(choice.requiresWorkAccount,id!=='microsoft.calendar.forward')
  }
  for(const header of ['bearer owner-session','BEARER   owner-session '])assert.equal((await call('capabilities',{projectId:'project'},'owner-session',header)).status,200,'Bearer normalization matches the Team Space authentication boundary')
  const ms=await call('start',{projectId:'project',provider:'microsoft',services:['mail']})
  assert.equal(new URL(ms.data.authorizationUrl).pathname,'/organizations/oauth2/v2.0/authorize','Enterprise BYO tenant is preserved')
  const opted=await call('start',{projectId:'project',provider:'microsoft',services:['chat'],optionalPermissionIds:['microsoft.teams.tags.manage']})
  assert.equal(opted.status,200,'Private-server HTTP accepts the exact optional-permission contract')
  assert.ok(new URL(opted.data.authorizationUrl).searchParams.get('scope')!.split(' ').includes('TeamworkTag.ReadWrite'))
  for(const optionalPermissionIds of [['google.drive.apps.read'],['TeamworkTag.ReadWrite']]){
    const invalid=await call('start',{projectId:'project',provider:'microsoft',services:['chat'],optionalPermissionIds})
    assert.equal(invalid.status,400);assert.equal(invalid.data.error_code,'connections.invalid_permissions')
  }
  for(const route of ['prepare','approve','action']){
    const before=bodyReads,result=await call(route,{dataBase64:'x'.repeat(20_000)})
    assert.equal(result.status,409);assert.equal(result.data.error_code,'connections.native_required');assert.equal(bodyReads,before,'No business-data body parsed')
  }
  for(const token of ['missing','viewer-session']){
    const before=bodyReads,result=await call('lease',{projectId:'project',connectionId:'absent'},token)
    assert.equal(result.status,403);assert.equal(bodyReads,before)
  }
  const start=await call('start',{projectId:'project',provider:'google',services:['mail','drive']})
  assert.equal(start.status,200)
  const oauth=new URL(start.data.authorizationUrl)
  assert.equal(oauth.searchParams.get('redirect_uri'),'https://private.example/v1/connections/oauth/google/callback')
  const callback=await fetch(`${origin}/v1/connections/oauth/google/callback?${new URLSearchParams({state:oauth.searchParams.get('state')!,code:'fixture-code'})}`)
  assert.equal(callback.status,200)
  const listed=await call('list',{projectId:'project'}),connection=listed.data.connections[0]
  assert.equal(connection.email,'owner@example.com');assert.equal(JSON.stringify(listed.data).includes('fixture-access'),false)
  const leased=await call('lease',{projectId:'project',connectionId:connection.id})
  assert.equal(leased.status,200);assert.equal(leased.data.credential.accessToken,'fixture-access')
  assert.equal(leased.data.credential.refreshToken,undefined);assert(leased.data.leaseExpiresAt>Date.now());assert(leased.data.leaseExpiresAt<=Date.now()+300_000)
  assert.equal(providerCalls,2,'Healthy leases do not proxy provider data or re-exchange credentials')
  for(const [token,projectId] of [['other-session','project'],['other-device','project'],['owner-session','other-project']]){
    const result=await call('lease',{projectId,connectionId:connection.id},token)
    assert.equal(result.status,404,'Leases are member, device and project scoped');assert.equal(result.data.credential,undefined)
  }
  const updated=await call('update',{projectId:'project',connectionId:connection.id,services:['mail'],expectedGeneration:connection.generation})
  assert.equal(updated.status,200)
  const stale=await call('update',{projectId:'project',connectionId:connection.id,services:['mail','drive'],expectedGeneration:connection.generation})
  assert.equal(stale.status,409);assert.equal(stale.data.error_code,'connections.changed','A stale private-server editor cannot re-enable paused services')
  assert.equal((await call('update',{projectId:'project',connectionId:connection.id,services:['mail','drive']})).status,400,'Older clients cannot overwrite service settings without a reviewed version')
  const refreshed=await call('lease',{projectId:'project',connectionId:connection.id})
  assert.notEqual(refreshed.data.connection.generation,leased.data.connection.generation)
  assert(!refreshed.data.connection.availableActions.some((a:string)=>a.startsWith('drive.')))
  assert.equal((await call('update',{projectId:'project',connectionId:connection.id,services:[],expectedGeneration:updated.data.connection.generation})).status,200,'All services can be paused')
  assert.deepEqual((await call('lease',{projectId:'project',connectionId:connection.id})).data.connection.availableActions,[])
  assert.equal((await call('lease',{projectId:'project',connectionId:connection.id,credential:'injection'})).status,400)
  assert.equal((await call('disconnect',{projectId:'project',connectionId:connection.id})).status,200)
  assert.equal((await call('lease',{projectId:'project',connectionId:connection.id})).status,404)

  // The broker can issue a scoped native lease for an organizational account,
  // including a UPN when Microsoft does not return a primary mail address.
  microsoftNonce=new URL(ms.data.authorizationUrl).searchParams.get('nonce')!;assert.ok(microsoftNonce)
  const msCallback=await fetch(`${origin}/v1/connections/oauth/microsoft/callback?${new URLSearchParams({state:new URL(ms.data.authorizationUrl).searchParams.get('state')!,code:'ms-code'})}`)
  assert.equal(msCallback.status,200);assert.equal(signingKeyCalls,1)
  const msConnection=(await call('list',{projectId:'project'})).data.connections[0]
  assert.equal(msConnection.provider,'microsoft');assert.equal(msConnection.email,'employee@work.example')
  assert.deepEqual(msConnection.services,['mail'],'Unselected services stay disabled even when consent has more scopes')
  assert.equal((await call('lease',{projectId:'project',connectionId:msConnection.id})).data.credential.accessToken,'ms-access')
  assert.equal((await call('update',{projectId:'project',connectionId:msConnection.id,services:['calendar','drive','contacts'],expectedGeneration:msConnection.generation})).status,200)
  assert.equal((await call('disconnect',{projectId:'project',connectionId:msConnection.id})).status,200)

  const finishGoogle=async(code:string,projectId='project')=>{
    const started=await call('start',{projectId,provider:'google',services:['mail','drive']})
    assert.equal(started.status,200)
    const state=new URL(started.data.authorizationUrl).searchParams.get('state')!
    const response=await fetch(`${origin}/v1/connections/oauth/google/callback?${new URLSearchParams({state,code})}`)
    assert.equal(response.status,200)
    return (await call('list',{projectId})).data.connections[0]
  }
  const limited=await finishGoogle('limited-code')
  assert.deepEqual(limited.services,['mail']);assert.deepEqual(limited.grantedServices,['mail'])
  assert(limited.availableActions.includes('mail.get'));assert(!limited.availableActions.includes('mail.send'));assert(!limited.availableActions.includes('mail.delete'))
  assert.equal((await call('update',{projectId:'project',connectionId:limited.id,services:['drive'],expectedGeneration:limited.generation})).data.error_code,'connections.consent_required')
  await call('disconnect',{projectId:'project',connectionId:limited.id})

  const revoked=await finishGoogle('revoked-code')
  const deniedRefresh=await call('lease',{projectId:'project',connectionId:revoked.id})
  assert.equal(deniedRefresh.status,401);assert.equal(deniedRefresh.data.error_code,'connections.reconnect')
  assert(!JSON.stringify(deniedRefresh.data).includes('sensitive-provider-diagnostic'))
  assert.equal((await call('list',{projectId:'project'})).data.connections[0].requiresReconnect,true)
  assert.equal((await call('disconnect',{projectId:'project',connectionId:revoked.id})).status,200,'Revoked credentials remain removable')

  // A browser tab opened through Add must not recreate a connection after
  // another sign-in connected it and the user explicitly removed it.
  const staleAdd=await call('start',{projectId:'project',provider:'google',services:['mail']})
  assert.equal(staleAdd.status,200)
  const entered=deferred(),finish=deferred()
  afterGoogleToken=async()=>{entered.resolve();await finish.promise}
  const staleCallback=fetch(`${origin}/v1/connections/oauth/google/callback?${new URLSearchParams({state:new URL(staleAdd.data.authorizationUrl).searchParams.get('state')!,code:'fixture-code'})}`)
  await entered.promise
  try{
    const current=await finishGoogle('fixture-code')
    assert.equal((await call('disconnect',{projectId:'project',connectionId:current.id})).status,200)
  }finally{finish.resolve()}
  assert.equal((await staleCallback).status,409)
  assert.deepEqual((await call('list',{projectId:'project'})).data.connections,[])
  const fresh=await finishGoogle('fixture-code')
  assert.equal((await call('disconnect',{projectId:'project',connectionId:fresh.id})).status,200,'A fresh sign-in after removal remains possible')

  // State belongs to the exact session that initiated OAuth; old device sessions
  // cannot complete an authorization after their membership/session is removed.
  const pending=await call('start',{projectId:'project',provider:'google',services:['mail']})
  members.delete('owner-session')
  const beforeDeniedCallback=providerCalls
  const deniedCallback=await fetch(`${origin}/v1/connections/oauth/google/callback?${new URLSearchParams({state:new URL(pending.data.authorizationUrl).searchParams.get('state')!,code:'fixture-code'})}`)
  assert.equal(deniedCallback.status,403);assert.equal(providerCalls,beforeDeniedCallback)
  assert.equal((await call('list',{projectId:'project'})).status,403)
  configured.beginShutdown()
  assert.equal((await call('list',{projectId:'project'},'other-session')).status,503)
  assert.equal(bodyReads,bodyReleases,'Every admitted body reservation is released')
  console.log('PASS workspace connections: native capabilities, BYO independence, HTTP denial, lease ownership, enterprise consent, scope narrowing, late OAuth/removal fencing, credential/session revocation and shutdown')
} finally {
  server.close();server.closeAllConnections();await once(server,'close')
  await configured.close();await rm(directory,{recursive:true,force:true})
}

// Registration fallback is all-or-nothing per provider, never a mixed secret.
const configDirectory=await mkdtemp(join(tmpdir(),'workspace-connections-config-'))
const legacy={TEAMSPACE_MAIL_PUBLIC_URL:'https://private.example',TEAMSPACE_MAIL_GOOGLE_CLIENT_ID:'legacy-client',TEAMSPACE_MAIL_GOOGLE_CLIENT_SECRET:'legacy-secret'}
try{
  assert.equal(createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{}),null)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_SECRET:'only-secret'}),/HTTPS public origin/)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,null,()=>true,legacy),/AT_REST_KEY/)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{...legacy,TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_ID:'new-client'}),/Incomplete/)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{...legacy,TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_SECRET:'new-secret'}),/Incomplete/)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{...legacy,TEAMSPACE_CONNECTIONS_PUBLIC_URL:'https://private.example/path'}),/HTTPS public origin/)
  assert.throws(()=>createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{...legacy,TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_ID:'bad\nclient',TEAMSPACE_CONNECTIONS_GOOGLE_CLIENT_SECRET:'new-secret'}),/invalid/)
  for(const [tenant,types] of [['common',['personal','work_school']],['consumers',['personal']],['organizations',['work_school']],['11111111-2222-3333-4444-555555555555',['work_school']]] as const){
    const service=createConfiguredWorkspaceConnections(configDirectory,key,()=>true,{...legacy,TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_ID:'ms',TEAMSPACE_CONNECTIONS_MICROSOFT_CLIENT_SECRET:'ms-secret',TEAMSPACE_CONNECTIONS_MICROSOFT_TENANT:tenant})!
    try{
      await service.ready()
      const actor=workspaceConnectionActor({...identity,projectId:tenant})
      assert.deepEqual(service.capabilities().providers.find(p=>p.provider==='microsoft')!.accountTypes,types)
      const started=await service.service.start(actor,{provider:'microsoft',services:['mail','calendar','drive','contacts']})
      const url=new URL(started.authorizationUrl)
      assert.equal(url.pathname,`/${tenant}/oauth2/v2.0/authorize`)
      for(const scope of ['offline_access','User.Read','Mail.ReadWrite','Mail.Send','Calendars.ReadWrite','Files.ReadWrite.All','Contacts.ReadWrite'])assert(url.searchParams.get('scope')!.split(' ').includes(scope))
      const google=await service.service.start(actor,{provider:'google',services:['mail']})
      assert.equal(new URL(google.authorizationUrl).searchParams.get('client_id'),'legacy-client')
    }finally{await service.close()}
  }
  // Restart persistence and owner checks use real encrypted SQLite and separate
  // workers, without sending any account data to an external provider.
  const owner={userId:'stored-owner',projectId:'stored-project'},record={secret:'encrypted-fixture-refresh'}
  let storage=new SelfhostConnectionStore(configDirectory,key)
  const revocation={id:'stored-record',generation:'durable-removal-generation'}
  await storage.ready();await storage.put('connection','stored-record',owner,record)
  await storage.put('connection-revocation','stored-record',owner,revocation,Date.now()+20*60_000)
  await storage.close()
  storage=new SelfhostConnectionStore(configDirectory,key)
  try{
    await storage.ready();assert.deepEqual(await storage.get('connection','stored-record',owner),record)
    assert.deepEqual(await storage.get('connection-revocation','stored-record',owner),revocation)
    assert.equal(await storage.get('connection-revocation','stored-record',{...owner,projectId:'other-project'}),null)
    await assert.rejects(storage.put('connection-revocation','stored-record',{...owner,userId:'other-owner'},revocation))
    assert.equal(await storage.get('connection','stored-record',{...owner,projectId:'other-project'}),null)
    await assert.rejects(storage.put('connection','stored-record',{...owner,userId:'other-owner'},record))
    await storage.remove('connection','stored-record',{...owner,userId:'other-owner'})
    assert.deepEqual(await storage.get('connection','stored-record',owner),record)
    await storage.remove('connection','stored-record',owner);assert.equal(await storage.get('connection','stored-record',owner),null)
  }finally{await storage.close()}
  console.log('PASS workspace connection configuration: complete registrations, personal/corporate audiences, all service scopes, durable revocation markers and owner isolation')
}finally{await rm(configDirectory,{recursive:true,force:true})}
