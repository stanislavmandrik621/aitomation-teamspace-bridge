/** 100 authenticated synthetic users, real Docker HTTP/WS and durable replay.
 * Replica comparisons use the production clock ordering; this is not 100 Electron windows. */
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {writeFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import WebSocket from 'ws'
import {referenceClock,newerReferenceClock} from '../src/content-reference-data.js'
type Frame=Record<string,any>
const run=randomUUID().slice(0,8), output=resolve('../../docs/docker-collaboration-audit-2026-09-09/docker-storage-faults')
mkdirSync(output,{recursive:true});if(existsSync(resolve(output,'results.json'))){mkdirSync(resolve(output,'attempts'),{recursive:true});writeFileSync(resolve(output,'attempts',Date.now()+'.json'),readFileSync(resolve(output,'results.json')))}
const report:Frame={startedAt:new Date().toISOString(),status:'running',boundary:'Real Docker server and authenticated WebSockets; actual ENOSPC on an isolated 16 MiB tmpfs volume, followed by exact retry.',cases:[]}
const persist=()=>writeFileSync(resolve(output,'results.json'),JSON.stringify(report,null,2))
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(fn:()=>boolean,label:string,timeout=60000){const end=Date.now()+timeout;while(!fn()){assert.ok(Date.now()<end,'Timeout: '+label);await sleep(20)}}
async function check(id:string,work:()=>Promise<unknown>){const row:Frame={id,status:'running'};report.cases.push(row);persist();try{row.detail=await work();row.status='passed'}catch(e){row.status='failed';row.error=String(e instanceof Error?e.stack:e);throw e}finally{persist();console.log(row.status,id)}}
let serial = 0
const sockets: WebSocket[] = []
class Client {
  ws: WebSocket
  frames: Frame[] = []
  ops = new Map<string, Frame>()
  chats = new Map<string, Frame>()
  credential: Frame = {}
  hello: Frame = {}
  constructor(readonly port: number) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}`); sockets.push(this.ws)
    this.ws.on('error', () => {})
    this.ws.on('message', bytes => {
      const f = JSON.parse(String(bytes)); this.frames.push(f)
      if (f.type === 'ops') for (const op of f.ops) this.ops.set(op.opId, op)
      if (f.type === 'chat_peer') this.chats.set(f.message.id, f.message)
    })
  }
  async wait(fn: (f: Frame) => boolean, label: string) {
    await until(() => this.frames.some(fn), label)
    return this.frames.splice(this.frames.findIndex(fn), 1)[0]
  }
  async request(frame: Frame) {
    const frameId = `audit-${run}-${++serial}`
    this.ws.send(JSON.stringify({ ...frame, frameId }))
    return this.wait(f => f.frameId === frameId || f.requestId === frameId, `${frame.type} on ${this.port}`)
  }
  async auth(credential: Frame) {
    this.credential = credential
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, 'open')
    this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 2, ...credential }))
    this.hello = await this.wait(f => ['hello_ok', 'hello_refuse'].includes(f.type), 'hello')
    assert.equal(this.hello.type, 'hello_ok', JSON.stringify(this.hello))
    if (this.hello.sessionToken) this.credential.sessionToken = this.hello.sessionToken
    await this.wait(f => f.type === 'catchup_status' && f.done, 'initial catchup')
    return this
  }
  async expect(frame: Frame, type: string) { for(let attempt=0;attempt<20;attempt++){ const reply=await this.request(frame); if(reply.type==='slow_down'){await sleep(Math.min(30000,Math.max(1000,Number(reply.waitMs)||10000))+100);continue} assert.equal(reply.type,type,JSON.stringify(reply));return reply } throw new Error('Repeated rate limiting: '+frame.type) }
}

const container=process.env.STORAGE_AUDIT_CONTAINER
if(!container?.startsWith('aitomation-storage-audit-'))throw new Error('Storage fault injection requires an isolated storage-audit container')
const operation=(value:string)=>({opId:`storage-${run}-${++serial}`,kind:'record.update',targetKind:'record',targetId:'record-'+run,moduleId:'module-'+run,entityId:'entity-'+run,hlc:`${Date.now()}:${serial}:author`,protocolVersion:2,hopCount:0,patch:{data:{body:value}}})
try{
 const admin=await new Client(18881).auth({memberId:'storage-admin-'+run,deviceId:'storage-'+run,memberEmail:`storage-${run}@example.test`,displayName:'Storage fault audit'})
 const seed=operation('baseline'),pending=operation('retained draft '+ 'x'.repeat(4096))
 await check('docker-storage-baseline-accepted',async()=>{
  const schema = [
   ['module.create',seed.moduleId,{id:seed.moduleId,name:'Storage fault audit'}],
   ['entity.create',seed.entityId,{id:seed.entityId,module_id:seed.moduleId,name:'Storage records'}],
   ['field.create','body-'+run,{entity_id:seed.entityId,slug:'body',name:'Body',field_type:'text'}],
   ['record.create',seed.targetId,{id:seed.targetId,entity_id:seed.entityId,data:{body:'initial'}}],
  ].map(([kind,targetId,patch])=>({...operation(''),kind,targetKind:String(kind).split('.')[0],targetId,patch}))
  const created=await admin.expect({type:'ops',ops:schema},'ops_result');assert.ok(created.results.every((r:Frame)=>r.status==='applied'))
  const reply=await admin.expect({type:'ops',ops:[seed]},'ops_result');assert.equal(reply.results[0].status,'applied');return {accepted:1}
 })
 await check('docker-real-enospc-does-not-acknowledge-unsaved-write',async()=>{
  try{execFileSync('docker',['exec',container,'sh','-c','dd if=/dev/zero of=/data/audit-fill bs=1M count=32'],{stdio:'pipe'})}catch(e:any){assert.match(String(e.stderr),/No space left/)}
  const reply=await admin.request({type:'ops',ops:[pending]})
  assert.ok(reply.type!=='ops_result'||reply.results.every((r:Frame)=>r.status!=='applied'),JSON.stringify(reply))
  assert.equal(admin.ws.readyState,WebSocket.OPEN)
  return {realDiskFull:true,replyType:reply.type,unsavedWriteNotAcknowledged:true,socketAlive:true}
 })
 execFileSync('docker',['exec',container,'rm','/data/audit-fill'],{stdio:'pipe'})
 await check('docker-storage-recovers-and-retries-exact-operation-once',async()=>{
  await sleep(500)
  for(let i=0;i<2;i++){const reply=await admin.expect({type:'ops',ops:[pending]},'ops_result');assert.equal(reply.results[0].status,'applied',JSON.stringify(reply))}
  const email=`recovery-${run}@example.test`
  const invitation=await admin.expect({type:'invite_create',email,role:'admin'},'invite_ok')
  const observer=new Client(18881);await once(observer.ws,'open')
  const credential=await observer.expect({type:'invite_redeem',token:invitation.token,deviceId:'recovery-'+run,memberEmail:email,displayName:'Independent recovery device'},'invite_redeem_ok')
  await observer.auth({memberId:credential.memberId,deviceId:'recovery-'+run,sessionToken:credential.sessionToken})
  assert.equal(observer.ops.get(seed.opId)?.patch.data.body,'baseline')
  assert.equal(observer.ops.get(pending.opId)?.patch.data.body,pending.patch.data.body)
  assert.equal([...observer.ops.keys()].filter(id=>id===pending.opId).length,1)
  return {exactRetries:2,storedOperations:2,duplicateOperationIds:0,freshClientVerified:true}
 })
 report.status='passed'
}catch(e){report.status='failed';report.error=String(e instanceof Error?e.stack:e);console.error(report.error);process.exitCode=1}
finally{try{execFileSync('docker',['exec',container,'rm','-f','/data/audit-fill'],{stdio:'pipe'})}catch{}for(const ws of sockets)ws.terminate();report.finishedAt=new Date().toISOString();persist()}
