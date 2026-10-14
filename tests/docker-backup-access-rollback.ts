/** Destructive recovery is confined to uniquely named disposable containers/volumes. */
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID,createHash,scryptSync} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import WebSocket from 'ws'
type Frame=Record<string,any>
const image=process.env.BACKUP_ROLLBACK_IMAGE || 'aitomation-personal-backup-privacy:independent-authority'
const token=randomUUID().slice(0,8),sockets:WebSocket[]=[],containers:string[]=[],volumes:string[]=[]
const encryptionKey=createHash('sha256').update('isolated-recovery-key-'+token).digest('hex')
let serial=0
const scratch=mkdtempSync(join(tmpdir(),'aitomation-access-rollback-'))
const output=resolve(process.env.BACKUP_ROLLBACK_OUTPUT||'../../docs/docker-collaboration-audit-2026-09-09/backup-expanded-20260913/server-access-rollback')
mkdirSync(output,{recursive:true})
const report:Frame={startedAt:new Date().toISOString(),status:'running',cases:[],boundary:'Actual stopped Docker data-volume backup, destruction of original container and volume, restore to a fresh volume; authenticated protocol and attachment verification.'}
const save=()=>writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2))
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(fn:()=>boolean,label:string){const end=Date.now()+30000;while(!fn()){assert.ok(Date.now()<end,label);await sleep(20)}}
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:'pipe',timeout:45000}).trim()
async function server(label:string,start=true,retainedAuthority?:string,key=encryptionKey){
 const name=`aitomation-access-rollback-${token}-${label}`,volume=name+'-data';containers.push(name);volumes.push(volume)
 docker('volume','create',volume)
 const authority=retainedAuthority||name+'-authority'
 if(!retainedAuthority){volumes.push(authority);docker('volume','create',authority)}
 docker('create','--name',name,'-p','127.0.0.1::8788','-e',`TEAMSPACE_AT_REST_KEY=${key}`,'-e','TEAMSPACE_ADMIN_HTTP_MUTATE_TOKENS=200','-e','TEAMSPACE_YJS_COMPOSE_ENABLED=true','-e','TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED=true','-v',`${volume}:/data`,'-v',`${authority}:/authority`,image)
 if(start)docker('start',name)
 return{name,volume,authority}
}
async function portOf(name:string){let port=0;for(let i=0;!port;i++){try{port=Number(docker('port',name,'8788').split(':').at(-1))}catch{if(i>30)throw new Error(JSON.stringify(spawnSync('docker',['logs',name],{encoding:'utf8'})));await sleep(100)}};for(let i=0;;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return port}catch{}assert.ok(i<100,'server health');await sleep(100)}}
class Client {
  ws: WebSocket; frames: Frame[] = []; ops = new Map<string, Frame>(); deliveries: string[] = []; credential: Frame = {}; hello: Frame = {}
  constructor(address: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${address}`); sockets.push(this.ws)
    this.ws.on('error', () => {})
    this.ws.on('message', bytes => {
      const frame = JSON.parse(String(bytes)); this.frames.push(frame)
      if (frame.type === 'ops') for (const op of frame.ops) { this.ops.set(op.opId, op); this.deliveries.push(op.opId) }
    })
  }
  async wait(match: (frame: Frame) => boolean, label: string) {
    await until(() => this.frames.some(match), label)
    return this.frames.splice(this.frames.findIndex(match), 1)[0]
  }
  send(frame: Frame) { const frameId = `${token}-frame-${++serial}`; this.ws.send(JSON.stringify({ ...frame, frameId })); return frameId }
  async request(frame: Frame) {
    const id = this.send(frame)
    return this.wait(reply => reply.frameId === id || reply.requestId === id, frame.type)
  }
  async auth(credential: Frame) {
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open')
    this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, ...credential }))
    const reply = await this.wait(frame => ['hello_ok', 'hello_refuse'].includes(frame.type), 'hello')
    assert.equal(reply.type, 'hello_ok', JSON.stringify(reply))
    this.hello = reply
    this.credential = { ...credential, sessionToken: reply.sessionToken || credential.sessionToken }
    await this.wait(frame => frame.type === 'catchup_status' && frame.done, 'catchup')
    return this
  }
}

try {
 const original=await server('original'),foreign=await server('foreign')
 let port=await portOf(original.name)
 const identity={memberId:`recovery-admin-${token}`,deviceId:`recovery-admin-${token}`,memberEmail:`${token}@example.test`,displayName:'Recovery admin'}
 let admin=await new Client(port).auth(identity)
 const adminCredential=admin.credential
 const foreignAdmin=await new Client(await portOf(foreign.name)).auth({...identity,memberId:`foreign-${token}`,deviceId:`foreign-${token}`})
 const joinMember=async(role:string)=>{
  const deviceId=`${role}-${token}`,email=`${deviceId}@example.test`,invite=await admin.request({type:'invite_create',email,role})
  assert.equal(invite.type,'invite_ok')
  const c=new Client(port);await once(c.ws,'open')
  const joined=await c.request({type:'invite_redeem',token:invite.token,deviceId,memberEmail:email,displayName:role})
  assert.equal(joined.type,'invite_redeem_ok')
  return c.auth({memberId:joined.memberId,deviceId,sessionToken:joined.sessionToken})
 }
 let member=await joinMember('member'),viewer=await joinMember('viewer')
 const memberCredential=member.credential,viewerCredential=viewer.credential
 const moduleId=`recovery-module-${token}`,entityId=`recovery-entity-${token}`,recordId=`recovery-record-${token}`
 const op=(kind:string,targetId:string,patch:Frame)=>({opId:randomUUID(),kind,targetKind:kind.split('.')[0],targetId,moduleId,entityId,patch,hlc:`${Date.now()}:${++serial}:recovery`,protocolVersion:2,hopCount:0})
 const seed=[op('module.create',moduleId,{id:moduleId,name:'Recovered module'}),op('entity.create',entityId,{id:entityId,module_id:moduleId,name:'Records'}),op('field.create',`name-${token}`,{entity_id:entityId,slug:'name',name:'Name',field_type:'text'}),op('record.create',recordId,{id:recordId,entity_id:entityId,data:{name:'Durable recovery record'}})]
 const accepted=await admin.request({type:'ops',ops:seed});assert.ok(accepted.results?.every((r:Frame)=>r.status==='applied'),JSON.stringify(accepted))
 const privateModuleId=`private-module-${token}`,privateSeed={...op('module.create',privateModuleId,{id:privateModuleId,name:'PRIVATE_BEFORE_ROLLBACK'}),moduleId:privateModuleId,entityId:undefined,contentAclRevision:0,visibleToMemberIds:[memberCredential.memberId,viewerCredential.memberId]}
 const privateAccepted=await admin.request({type:'ops',ops:[privateSeed]});assert.equal(privateAccepted.results?.[0].status,'applied',JSON.stringify(privateAccepted))
 await until(()=>seed.every(op=>member.ops.has(op.opId)),'member accepted seed')
 const created=await admin.request({type:'chat_room_create',kind:'private',title:'Recovery private room',memberIds:[memberCredential.memberId,viewerCredential.memberId]})
 assert.equal(created.type,'chat_room_create_ok',JSON.stringify(created));const room=created.room.id
 const bytes=Buffer.from('Recovery attachment: Unicode ✓ '+token)
 const upload=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs`,{method:'POST',headers:{authorization:`Bearer ${adminCredential.sessionToken}`,'x-teamspace-chat-room':room,'x-filename':'recovery.txt','content-type':'text/plain'},body:bytes})
 assert.equal(upload.status,200);const blob=(await upload.json() as Frame).blob
 const sent=await admin.request({type:'chat_send',room,body:'Message preserved through lost server',clientMsgId:randomUUID(),attachments:[blob]})
 assert.equal(sent.type,'chat_ok',JSON.stringify(sent))
 const promoted=await admin.request({type:'set_role',memberId:viewerCredential.memberId,role:'member'});assert.equal(promoted.type,'set_role_ok')
 const publicToken='restore-public-'+token,publicHash=createHash('sha256').update(publicToken).digest('hex'),teamId=admin.hello.teamId
 const post=async(path:string,body:Frame)=>fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{authorization:`Bearer ${adminCredential.sessionToken}`,'content-type':'application/json'},body:JSON.stringify(body)})
 const published=await post('/v1/public-share/register',{teamId,fieldAclBaseHash:admin.hello.fieldAclAuthority.hash,token_hash:publicHash,local_share_id:'restore-share-'+token,mode:'read',view_type:'table',payload:{version:2,mode:'read',viewType:'table',label:'Recovery public',entityId,fields:[{slug:'name',name:'Name',field_type:'text',config:{}}],rows:[{id:recordId,data:{name:'PUBLIC-RECOVERY-'+token}}],total:1,truncated:false,includeCsv:false,pushedAt:Date.now()}});assert.equal(published.status,200,await published.text())
 assert.equal((await fetch(`http://127.0.0.1:${port}/share/${publicToken}`)).status,200)
 const office={sourceId:'rollback-floor',kind:'floor',deleted:false,shape:{kind:'floor',id:'rollback-floor',name:'Previously shared Office',order:0},parents:[],responsibilitiesText:'Office before revoke',leads:[],backups:[],members:[]}
 assert.equal((await post('/office-objects',{teamId,commandId:randomUUID(),expectedVersion:0,object:office})).status,200)
 const documentIds=['rollback-document-'+token,'rollback-whiteboard-'+token]
 assert.equal((await post('/v1/teamspace/compose-acl',{teamId,documentIds})).status,200)
 const invite=await admin.request({type:'invite_create',email:'removed-invite-'+token+'@example.test',role:'member'});assert.equal(invite.type,'invite_ok')
 const composeToken='rollback-compose-'+token,composeHash=createHash('sha256').update(composeToken).digest('hex')
 const salt=Buffer.alloc(16,3),passwordHash=`s$${salt.toString('hex')}$${scryptSync('test-only-password',salt,32).toString('hex')}`
 const composeBody={teamId,token_hash:composeHash,local_share_id:'compose-'+token,format:'pdf',password_hash:passwordHash,pack_b64:Buffer.from('PRIVATE_PDF_'+token).toString('base64')}
 assert.equal((await post('/v1/compose-share/register',composeBody)).status,200)
 const portalToken='rollback-portal-'+token,portalHash=createHash('sha256').update(portalToken).digest('hex')
 const portalBody={teamId,fieldAclBaseHash:admin.hello.fieldAclAuthority.hash,token_hash:portalHash,local_portal_id:'portal-'+token,name:'Recovery portal',auth_mode:'anonymous',allowed_actions:['create'],payload:{version:1,portalId:'portal-'+token,name:'Recovery portal',entityId,authMode:'anonymous',allowedActions:['create'],design:{},aclSnapshot:{hiddenSlugs:[]},fields:[{slug:'name',name:'Name',field_type:'text',required:false,config:{}}],pushedAt:1}}
 assert.equal((await post('/v1/portal/register',portalBody)).status,200)
 docker('stop',original.name)
 const archive=join(scratch,'data');mkdirSync(archive)
 docker('cp',`${original.name}:/data/.`,archive)
 docker('start',original.name);port=await portOf(original.name)
 admin=await new Client(port).auth(adminCredential)
 for(const documentId of documentIds)assert.equal((await post('/v1/teamspace/compose-acl',{teamId,mutation:{documentId,memberIds:[adminCredential.memberId]}})).status,200)
 const cancelled=await admin.request({type:'invite_revoke',id:invite.id});assert.equal(cancelled.type,'invite_revoke_ok',JSON.stringify(cancelled))
 assert.equal((await post('/v1/compose-share/revoke',{teamId,token_hash:composeHash})).status,200)
 assert.equal((await post('/v1/portal/revoke',{teamId,token_hash:portalHash})).status,200)
 const narrow={...op('module.update',privateModuleId,{name:'Current restricted module'}),moduleId:privateModuleId,entityId:undefined,contentAclRevision:privateAccepted.results[0].contentAclRevision,visibleToMemberIds:[memberCredential.memberId]}
 const narrowed=await admin.request({type:'ops',ops:[narrow]});assert.equal(narrowed.results?.[0].status,'applied',JSON.stringify(narrowed))
 const demoted=await admin.request({type:'set_role',memberId:viewerCredential.memberId,role:'viewer'});assert.equal(demoted.type,'set_role_ok')
 const removedFromRoom=await admin.request({type:'chat_room_remove_members',room,memberIds:[viewerCredential.memberId]});assert.equal(removedFromRoom.type,'chat_room_remove_members_ok',JSON.stringify(removedFromRoom))
 assert.equal((await post('/office-objects',{teamId,commandId:randomUUID(),expectedVersion:1,object:{...office,deleted:true}})).status,200)
 assert.equal((await post('/v1/public-share/revoke',{teamId,token_hash:publicHash})).status,200);assert.equal((await fetch(`http://127.0.0.1:${port}/share/${publicToken}`)).status,410)
 const kicked=await admin.request({type:'kick_member',memberId:memberCredential.memberId});assert.equal(kicked.type,'kick_ok',JSON.stringify(kicked))
 const deniedAfterKick=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${memberCredential.sessionToken}`}});assert.equal(deniedAfterKick.status,401)
 report.cases.push({id:'post-backup-member-revocation-is-enforced',status:'passed',detail:{cachedSessionDenied:true}})
 docker('stop',original.name)
 const retained=join(scratch,'retained-current-authority');mkdirSync(retained);docker('cp',`${original.name}:/authority/.`,retained)
 docker('rm',original.name);docker('volume','rm',original.volume);docker('volume','rm',original.authority)
 const restored=await server('restored',false)
 docker('cp',retained+'/.',`${restored.name}:/authority`)
 docker('run','--rm','--user','root','--entrypoint','chown','-v',`${restored.authority}:/authority`,image,'-R','bridge:bridge','/authority')
 docker('cp',archive+'/.',`${restored.name}:/data`);docker('run','--rm','--user','root','--entrypoint','chown','-v',`${restored.volume}:/data`,image,'-R','bridge:bridge','/data');docker('start',restored.name);port=await portOf(restored.name)
 admin=await new Client(port).auth(adminCredential);viewer=await new Client(port).auth(viewerCredential)
 assert.equal(viewer.hello.role,'viewer')
 for(const documentId of documentIds){
   const deniedJoin=await viewer.request({type:'yjs_join',room:`yjs:composeDoc:${documentId}`});assert.equal(deniedJoin.type,'yjs_refuse')
   const allowedJoin=await admin.request({type:'yjs_join',room:`yjs:composeDoc:${documentId}`});assert.equal(allowedJoin.type,'yjs_ok',JSON.stringify(allowedJoin))
 }
 assert.equal((await post('/v1/compose-share/register',composeBody)).status,400,'stale publisher cannot revive retired Compose link')
 assert.equal((await post('/v1/portal/register',portalBody)).status,400,'stale publisher cannot revive retired portal')
 const oldInvite=new Client(port);await once(oldInvite.ws,'open')
 const refusedInvite=await oldInvite.request({type:'invite_redeem',token:invite.token,deviceId:'stale-invite-'+token,memberEmail:'removed-invite-'+token+'@example.test'})
 assert.notEqual(refusedInvite.type,'invite_redeem_ok')
 report.cases.push({id:'private-documents-whiteboards-links-and-invites-after-rollback',status:'passed',detail:{documentAndWhiteboardAcl:true,retiredComposeAndPortalCannotRepublish:true,cancelledInviteDenied:true}})
 report.cases.push({id:'fresh-server-recovers-separately-retained-encrypted-authority',status:'passed',detail:{bothOriginalVolumesDestroyed:true,currentAuthorizationRecoveredFromSeparateCopy:true,oldDataRecoveredOnFreshVolumes:true}})
 const revokedClient=new Client(port);await once(revokedClient.ws,'open');revokedClient.ws.send(JSON.stringify({type:'hello',protocolVersion:2,...memberCredential}))
 const refused=await revokedClient.wait(frame=>['hello_ok','hello_refuse'].includes(frame.type),'revoked session refused');assert.equal(refused.type,'hello_refuse')
 assert.equal((await fetch(`http://127.0.0.1:${port}/share/${publicToken}`)).status,410)
 assert.ok(seed.every(op=>viewer.ops.has(op.opId)),'restored records remain readable by the current Viewer')
 assert.equal(viewer.ops.has(privateSeed.opId),false,'retained current module grant filters pre-revocation history after rollback')
 const history=await admin.request({type:'chat_history',room,limit:20})
 assert.equal(history.type,'chat_history_ok');assert.equal(history.messages.filter((m:Frame)=>m.id===sent.message.id).length,1)
 const downloaded=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${adminCredential.sessionToken}`}})
 assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes)
 const revokedBlob=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${memberCredential.sessionToken}`}});assert.equal(revokedBlob.status,401)
 const scopes=await fetch(`http://127.0.0.1:${port}/v1/backups/read-scope`,{method:'POST',headers:{authorization:`Bearer ${viewerCredential.sessionToken}`,'content-type':'application/json'},body:JSON.stringify({version:1,targets:[{kind:'office-floor',id:'rollback-floor'},{kind:'chat-room',id:room},{kind:'chat-blob',id:blob.sha256}]})})
 assert.equal(scopes.status,200);assert.deepEqual((await scopes.json() as Frame).grants,[null,null,null],'Office removal and private chat removal survive data rollback for a still-valid session')
 const denied=await viewer.request({type:'chat_history',room,limit:20});assert.equal(denied.type,'chat_refuse')
 const deniedBlob=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${viewerCredential.sessionToken}`}});assert.equal(deniedBlob.status,404)
 const foreignBlob=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${foreignAdmin.credential.sessionToken}`}});assert.equal(foreignBlob.status,401)
 const update=op('record.update',recordId,{data:{name:'Edited after disaster recovery'}})
 const reply=await admin.request({type:'ops',ops:[update]});assert.equal(reply.results?.[0].status,'applied',JSON.stringify(reply))
 await until(()=>viewer.ops.has(update.opId),'post-recovery edit delivered to still-authorized Viewer')
 report.cases.push({id:'full-data-rollback-retains-current-independent-authorization',status:'passed',detail:{removedMemberCachedSessionDenied:true,revokedPublicLinkStillRevoked:true,demotedRoleStillViewer:true,restrictedModuleHistoryDenied:true,unsharedOfficeDenied:true,removedPrivateChatMembershipDenied:true,authorizedHistoryAndAttachmentPreserved:true,excludedViewerAndForeignTeamDenied:true,postRestoreEditConverged:true}})
 docker('stop',restored.name)
 docker('run','--rm','--user','root','--entrypoint','sh','-v',`${restored.authority}:/authority`,image,'-c','mv /authority/team-field-acl.json /authority/held-field-acl.json && mv /authority/team-field-acl.initialized /authority/held-field-acl.initialized')
 docker('start',restored.name)
 assert.equal(docker('wait',restored.name),'1','loss of both ACL and local marker must refuse startup')
 const refusedLogs=spawnSync('docker',['logs',restored.name],{encoding:'utf8',timeout:10000})
 assert.match(refusedLogs.stdout+refusedLogs.stderr,/authorization is incomplete/)
 docker('run','--rm','--user','root','--entrypoint','sh','-v',`${restored.authority}:/authority`,image,'-c','mv /authority/held-field-acl.json /authority/team-field-acl.json && mv /authority/held-field-acl.initialized /authority/team-field-acl.initialized')
 docker('start',restored.name);port=await portOf(restored.name)
 admin=await new Client(port).auth(adminCredential)
 assert.equal((await admin.request({type:'chat_history',room,limit:20})).type,'chat_history_ok')
 report.cases.push({id:'incomplete-authority-refuses-bootstrap-and-recovers-with-original-files',status:'passed',detail:{missingAclAndMarkerRefused:true,originalCheckpointsRestored:true,authorizedHistoryPreserved:true}})
 const damagedFiles=['team.json','members.json','invites.json','revoked-sessions.json','team-field-acl.json','compose-live-acl.json','office-objects.json','chat/rooms.json','public-shares.json','compose-shares.json','portals.json','public-share-retired-tokens/retired.sqlite','compose-share-retired-tokens/retired.sqlite','portal-retired-tokens/retired.sqlite']
 for(const file of damagedFiles){
   docker('stop',restored.name)
   // The path comes from the fixed list above; never from network input.
   docker('run','--rm','--user','root','--entrypoint','sh','-v',`${restored.authority}:/authority`,image,'-c',`mv /authority/${file} /authority/${file}.held`)
   for(const mode of ['missing','corrupt']){
     console.log('Testing retained authorization',file,mode)
     if(mode==='corrupt')docker('run','--rm','--user','root','--entrypoint','sh','-v',`${restored.authority}:/authority`,image,'-c',`printf '{broken' > /authority/${file}`)
     docker('start',restored.name);assert.equal(docker('wait',restored.name),'1',`${mode} ${file} refuses before bootstrap`)
   }
   docker('run','--rm','--user','root','--entrypoint','sh','-v',`${restored.authority}:/authority`,image,'-c',`mv /authority/${file}.held /authority/${file}`)
   docker('start',restored.name);port=await portOf(restored.name)
   admin=await new Client(port).auth(adminCredential)
   assert.equal((await admin.request({type:'chat_history',room,limit:20})).type,'chat_history_ok','original checkpoint recovers authorized content')
 }
 report.cases.push({id:'every-populated-authorization-family-missing-and-corrupt',status:'passed',detail:{files:damagedFiles,cases:damagedFiles.length*2,originalFilesRecovered:true}})
 // Regrant is a new authorization decision. It must not un-retire old sessions
 // or make an edit stamped with the old content permission revision valid.
 const readmitted=await joinMember('member')
 const staleSession=new Client(port);await once(staleSession.ws,'open');staleSession.ws.send(JSON.stringify({type:'hello',protocolVersion:2,...memberCredential}))
 assert.equal((await staleSession.wait(frame=>['hello_ok','hello_refuse'].includes(frame.type),'readmitted stale session')).type,'hello_refuse')
 const regrant={...op('module.update',privateModuleId,{name:'Explicitly regranted'}),moduleId:privateModuleId,entityId:undefined,contentAclRevision:narrowed.results[0].contentAclRevision,visibleToMemberIds:[readmitted.credential.memberId,viewerCredential.memberId]}
 const regranted=await admin.request({type:'ops',ops:[regrant]});assert.equal(regranted.results[0].status,'applied',JSON.stringify(regranted))
 const staleEdit={...op('module.update',privateModuleId,{name:'MUST_NOT_REPLAY'}),moduleId:privateModuleId,entityId:undefined,contentAclRevision:privateAccepted.results[0].contentAclRevision}
 assert.equal((await readmitted.request({type:'ops',ops:[staleEdit]})).results[0].status,'refused')
 for(const documentId of documentIds){assert.equal((await post('/v1/teamspace/compose-acl',{teamId,mutation:{documentId,memberIds:[adminCredential.memberId,readmitted.credential.memberId]}})).status,200);assert.equal((await readmitted.request({type:'yjs_join',room:`yjs:composeDoc:${documentId}`})).type,'yjs_ok')}
 assert.equal((await post('/office-objects',{teamId,commandId:randomUUID(),expectedVersion:2,object:office})).status,200)
 report.cases.push({id:'revoke-restore-regrant-does-not-revive-stale-authority',status:'passed',detail:{freshMembershipAndDocumentAccess:true,oldSessionStillRefused:true,oldPermissionEditRefused:true,officeExplicitRegrant:true}})
 docker('stop',restored.name)
 const stoppedData=join(scratch,'key-check-data'),stoppedAuthority=join(scratch,'key-check-authority');mkdirSync(stoppedData);mkdirSync(stoppedAuthority)
 docker('cp',`${restored.name}:/data/.`,stoppedData);docker('cp',`${restored.name}:/authority/.`,stoppedAuthority)
 const volumeDigest=(volume:string)=>docker('run','--rm','--user','root','--entrypoint','node','-v',`${volume}:/scan:ro`,image,'-e',"const f=require('fs'),p=require('path'),c=require('crypto'),h=c.createHash('sha256');function walk(d){for(const n of f.readdirSync(d).sort()){if(n.startsWith('.bridge'))continue;const a=p.join(d,n),s=f.lstatSync(a);if(s.isDirectory())walk(a);else{h.update(a);h.update(f.readFileSync(a))}}}walk('/scan');console.log(h.digest('hex'))")
 for(const [label,key] of [['wrong-key','01'.repeat(32)],['missing-key','']]){
  const bad=await server(label!,false,undefined,key)
  docker('cp',stoppedData+'/.',`${bad.name}:/data`);docker('cp',stoppedAuthority+'/.',`${bad.name}:/authority`)
  docker('run','--rm','--user','root','--entrypoint','chown','-v',`${bad.volume}:/data`,'-v',`${bad.authority}:/authority`,image,'-R','bridge:bridge','/data','/authority')
  const before=[volumeDigest(bad.volume),volumeDigest(bad.authority)]
  docker('start',bad.name);assert.equal(docker('wait',bad.name),'1')
  assert.deepEqual([volumeDigest(bad.volume),volumeDigest(bad.authority)],before,'wrong key cannot quarantine or rewrite original encrypted files')
 }
 docker('start',restored.name);port=await portOf(restored.name);admin=await new Client(port).auth(adminCredential)
 assert.equal((await admin.request({type:'chat_history',room,limit:20})).type,'chat_history_ok')
 report.cases.push({id:'missing-and-wrong-encryption-key-preserve-both-stores',status:'passed',detail:{originalKeyRecovery:true,allStoredBytesUnchanged:true,wrongAndMissingKeyRefused:true}})
 report.status='passed'
} catch(error){report.status='failed';report.error=String(error);throw error}
finally{for(const name of containers){try{writeFileSync(join(output,name+'.log'),JSON.stringify(spawnSync('docker',['logs',name],{encoding:'utf8'})))}catch{}}report.finishedAt=new Date().toISOString();save();for(const socket of sockets)socket.terminate();for(const name of containers){try{docker('rm','-f',name)}catch{}}for(const volume of volumes){try{docker('volume','rm',volume)}catch{}}rmSync(scratch,{recursive:true,force:true})}
