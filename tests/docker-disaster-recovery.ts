/** Destructive recovery is confined to uniquely named disposable containers/volumes. */
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {execFileSync,spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import WebSocket from 'ws'
type Frame=Record<string,any>
const token=randomUUID().slice(0,8),sockets:WebSocket[]=[],containers:string[]=[],volumes:string[]=[]
let serial=0
const scratch=mkdtempSync(join(tmpdir(),'aitomation-recovery-'))
const output=resolve('../../docs/docker-collaboration-audit-2026-09-09/docker-disaster-recovery')
mkdirSync(output,{recursive:true})
const report:Frame={startedAt:new Date().toISOString(),status:'running',cases:[],boundary:'Actual stopped Docker data-volume backup, destruction of original container and volume, restore to a fresh volume; authenticated protocol and attachment verification.'}
const save=()=>writeFileSync(join(output,'results.json'),JSON.stringify(report,null,2))
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(fn:()=>boolean,label:string){const end=Date.now()+30000;while(!fn()){assert.ok(Date.now()<end,label);await sleep(20)}}
const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',stdio:'pipe',timeout:45000}).trim()
async function server(label:string,start=true){
 const name=`aitomation-recovery-${token}-${label}`,volume=name+'-data';containers.push(name);volumes.push(volume)
 docker('volume','create',volume)
 docker('create','--name',name,'-p','127.0.0.1::8788','-v',`${volume}:/data`,'aitomation-collab-audit:20260909')
 if(start)docker('start',name)
 return{name,volume}
}
async function portOf(name:string){let port=0;for(let i=0;!port;i++){try{port=Number(docker('port',name,'8788').split(':').at(-1))}catch{if(i>30)throw new Error(JSON.stringify(spawnSync('docker',['logs',name],{encoding:'utf8'})));await sleep(100)}};for(let i=0;;i++){try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok)return port}catch{}assert.ok(i<100,'server health');await sleep(100)}}
class Client {
  ws: WebSocket; frames: Frame[] = []; ops = new Map<string, Frame>(); deliveries: string[] = []; credential: Frame = {}
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
 await until(()=>seed.every(op=>member.ops.has(op.opId)),'member accepted seed')
 const created=await admin.request({type:'chat_room_create',kind:'private',title:'Recovery private room',memberIds:[memberCredential.memberId]})
 assert.equal(created.type,'chat_room_create_ok',JSON.stringify(created));const room=created.room.id
 const bytes=Buffer.from('Recovery attachment: Unicode ✓ '+token)
 const upload=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs`,{method:'POST',headers:{authorization:`Bearer ${adminCredential.sessionToken}`,'x-teamspace-chat-room':room,'x-filename':'recovery.txt','content-type':'text/plain'},body:bytes})
 assert.equal(upload.status,200);const blob=(await upload.json() as Frame).blob
 const sent=await admin.request({type:'chat_send',room,body:'Message preserved through lost server',clientMsgId:randomUUID(),attachments:[blob]})
 assert.equal(sent.type,'chat_ok',JSON.stringify(sent))
 docker('stop',original.name)
 const archive=join(scratch,'data');mkdirSync(archive)
 docker('cp',`${original.name}:/data/.`,archive)
 docker('rm',original.name);docker('volume','rm',original.volume)
 const restored=await server('restored',false)
 docker('cp',archive+'/.',`${restored.name}:/data`);docker('run','--rm','--user','root','--entrypoint','chown','-v',`${restored.volume}:/data`,'aitomation-collab-audit:20260909','-R','bridge:bridge','/data');docker('start',restored.name);port=await portOf(restored.name)
 admin=await new Client(port).auth(adminCredential);member=await new Client(port).auth(memberCredential);viewer=await new Client(port).auth(viewerCredential)
 assert.ok(seed.every(op=>member.ops.has(op.opId)),'all schema/record history recovered for existing member')
 const history=await member.request({type:'chat_history',room,limit:20})
 assert.equal(history.type,'chat_history_ok');assert.equal(history.messages.filter((m:Frame)=>m.id===sent.message.id).length,1)
 const downloaded=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${memberCredential.sessionToken}`}})
 assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),bytes)
 const denied=await viewer.request({type:'chat_history',room,limit:20});assert.equal(denied.type,'chat_refuse')
 const deniedBlob=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${viewerCredential.sessionToken}`}});assert.equal(deniedBlob.status,404)
 const foreignBlob=await fetch(`http://127.0.0.1:${port}/v1/chat/blobs/${blob.sha256}`,{headers:{authorization:`Bearer ${foreignAdmin.credential.sessionToken}`}});assert.equal(foreignBlob.status,401)
 const update=op('record.update',recordId,{data:{name:'Edited after disaster recovery'}})
 const reply=await member.request({type:'ops',ops:[update]});assert.equal(reply.results?.[0].status,'applied',JSON.stringify(reply))
 await until(()=>admin.ops.has(update.opId),'post-recovery edit delivered')
 report.cases.push({id:'docker-fresh-volume-disaster-recovery',status:'passed',detail:{originalContainerAndVolumeDestroyed:true,freshVolumeRestore:true,existingThreeRolesAuthenticated:true,schemaAndRecordsRecovered:true,privateChatAndAttachmentBytesRecovered:true,excludedViewerAndForeignTeamDenied:true,subsequentWriteDelivered:true}})
 report.status='passed'
} catch(error){report.status='failed';report.error=String(error);throw error}
finally{for(const name of containers){try{writeFileSync(join(output,name+'.log'),JSON.stringify(spawnSync('docker',['logs',name],{encoding:'utf8'})))}catch{}}report.finishedAt=new Date().toISOString();save();for(const socket of sockets)socket.terminate();for(const name of containers){try{docker('rm','-f',name)}catch{}}for(const volume of volumes){try{docker('volume','rm',volume)}catch{}}rmSync(scratch,{recursive:true,force:true})}
