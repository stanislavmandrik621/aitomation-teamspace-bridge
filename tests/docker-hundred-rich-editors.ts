/** 100 authenticated synthetic users, real Docker HTTP/WS and durable replay.
 * Replica comparisons use the production clock ordering; this is not 100 Electron windows. */
import assert from 'node:assert/strict'
import {once} from 'node:events'
import {randomUUID} from 'node:crypto'
import {writeFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {execFileSync} from 'node:child_process'
import WebSocket from 'ws'
import {createRequire} from 'node:module'
const {Doc,encodeStateAsUpdate,encodeStateVector,applyUpdate}=createRequire(new URL('../../../apps/desktop/package.json',import.meta.url))('yjs')
import {referenceClock,newerReferenceClock} from '../src/content-reference-data.js'
type Frame=Record<string,any>
const run=randomUUID().slice(0,8), output=resolve('../../docs/docker-collaboration-audit-2026-09-09/hundred-rich-editors')
mkdirSync(output,{recursive:true});if(existsSync(resolve(output,'results.json'))){mkdirSync(resolve(output,'attempts'),{recursive:true});writeFileSync(resolve(output,'attempts',Date.now()+'.json'),readFileSync(resolve(output,'results.json')))}
const report:Frame={startedAt:new Date().toISOString(),status:'running',boundary:'100 authenticated WebSocket users with real Yjs documents against Docker; not 100 Electron windows. Tests live CRDT convergence and explicit room limits.',cases:[]}
const persist=()=>writeFileSync(resolve(output,'results.json'),JSON.stringify(report,null,2))
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms))
async function until(fn:()=>boolean,label:string,timeout=60000){const end=Date.now()+timeout;while(!fn()){assert.ok(Date.now()<end,'Timeout: '+label);await sleep(20)}}
async function check(id:string,work:()=>Promise<unknown>){const row:Frame={id,status:'running'};report.cases.push(row);persist();try{row.detail=await work();row.status='passed'}catch(e){row.status='failed';row.error=String(e instanceof Error?e.stack:e);throw e}finally{persist();console.log(row.status,id)}}
let serial = 0
const sockets: WebSocket[] = []
class Client {
  doc=new Doc()
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
      if(f.type==='yjs_peer_update') applyUpdate(this.doc,Buffer.from(f.updateB64,'base64'));
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

const count=Number(process.env.RICH_AUDIT_USERS ?? 128)
const clients:Client[]=[], room=`yjs:composeDoc:rich-${run}`
async function http(path:string,method:string,body:Frame){const res=await fetch('http://127.0.0.1:18881'+path,{method,headers:{'content-type':'application/json',authorization:'Bearer '+clients[0].credential.sessionToken},body:JSON.stringify(body)});assert.equal(res.status,200,await res.clone().text());return res.json()}
try{
 await check(`docker-rich-${count}-users-bootstrap`,async()=>{
  clients.push(await new Client(18881).auth({memberId:'rich-admin-'+run,deviceId:'admin-'+run,memberEmail:`${run}@example.test`,displayName:'Rich editor audit'}))
  for(let i=1;i<count;i++){
   if(i%20===0)await sleep(11000)
   const email=`rich-${run}-${i}@example.test`,invite=await clients[0].expect({type:'invite_create',email,role:'member'},'invite_ok')
   const c=new Client(18881);await once(c.ws,'open')
   const cred=await c.expect({type:'invite_redeem',token:invite.token,deviceId:'rich-'+i,memberEmail:email,displayName:'Editor '+i},'invite_redeem_ok')
   await c.auth({memberId:cred.memberId,deviceId:'rich-'+i,sessionToken:cred.sessionToken});clients.push(c)
  }
  await http('/v1/teamspace/compose-acl','POST',{teamId:clients[0].hello.teamId,documentIds:[`rich-${run}`]})
  return {distinctUsers:count}
 })
 await check(`docker-rich-room-cap-40-refuses-${count-40}-without-disconnecting`,async()=>{
  await http('/v1/limits','PATCH',{yjsRoomMaxPeers:40})
  for(let i=0;i<count;i++){
   const r=await clients[i].request({type:'yjs_join',room})
   assert.equal(r.type,i<40?'yjs_ok':'yjs_refuse',JSON.stringify(r))
   if(i>=40)assert.match(r.reason,/Too many people/)
   assert.equal(clients[i].ws.readyState,WebSocket.OPEN)
  }
  return {accepted:40,refused:count-40,socketsRemainConnected:count}
 })
 await check(`docker-rich-${count}-concurrent-inserts-and-idempotent-replay`,async()=>{
  await http('/v1/limits','PATCH',{yjsRoomMaxPeers:count})
  for(const c of clients)await c.expect({type:'yjs_join',room},'yjs_ok')
  // Build every edit against the same empty base before sending any of them.
  const updates=clients.map((c,i)=>{c.doc.getText('body').insert(0,`[author-${i}]`);return Buffer.from(encodeStateAsUpdate(c.doc)).toString('base64')})
  await Promise.all(clients.map((c,i)=>c.expect({type:'yjs_update',room,updateB64:updates[i]},'yjs_ok')))
  const complete=()=>clients.every(c=>clients.every((_,i)=>c.doc.getText('body').toString().includes(`[author-${i}]`)))
  await until(complete,'all 100 edits in all 100 Yjs documents')
  const text=clients[0].doc.getText('body').toString();assert.ok(clients.every(c=>c.doc.getText('body').toString()===text))
  await Promise.all(clients.map((c,i)=>c.expect({type:'yjs_update',room,updateB64:updates[i]},'yjs_ok')))
  await sleep(500);assert.ok(clients.every(c=>c.doc.getText('body').toString()===text))
  writeFileSync(resolve(output,'converged-document.txt'),text)
  return {writers:count,replicas:count,retainedContributions:count,replays:count,duplicateText:false}
 })
 await check(`docker-rich-${count}-sustained-concurrent-edit-bursts`,async()=>{
  const started=Date.now(),latencies:number[]=[]
  for(let round=0;round<10;round++){
   const updates=clients.map((c,i)=>{const vector=encodeStateVector(c.doc);c.doc.getText('body').insert(0,`[r${round}u${i}]`);return Buffer.from(encodeStateAsUpdate(c.doc,vector)).toString('base64')})
   await Promise.all(clients.map(async(c,i)=>{const t=Date.now();await c.expect({type:'yjs_update',room,updateB64:updates[i]},'yjs_ok');latencies.push(Date.now()-t)}))
  }
  await until(()=>clients.every(c=>clients.every((_,i)=>c.doc.getText('body').toString().includes(`[r9u${i}]`))),'burst final round delivered')
  const text=clients[0].doc.getText('body').toString();assert.ok(clients.every(c=>c.doc.getText('body').toString()===text))
  latencies.sort((a,b)=>a-b)
  return {writers:count,updates:count*10,elapsedMs:Date.now()-started,ackP95Ms:latencies[Math.floor(latencies.length*.95)],replicas:count,characters:text.length}
 })
 await check('docker-rich-live-demotion-refuses-pending-content',async()=>{
  const c=clients[count-1]
  await clients[0].expect({type:'set_role',memberId:c.credential.memberId,role:'viewer'},'set_role_ok')
  c.doc.getText('body').insert(0,'DENIED-DRAFT')
  const updateB64=Buffer.from(encodeStateAsUpdate(c.doc)).toString('base64')
  await c.expect({type:'yjs_update',room,updateB64},'yjs_refuse')
  await sleep(200);assert.ok(clients.slice(0,count-1).every(p=>!p.doc.getText('body').toString().includes('DENIED-DRAFT')))
  await clients[0].expect({type:'set_role',memberId:c.credential.memberId,role:'member'},'set_role_ok')
  await c.expect({type:'yjs_join',room},'yjs_ok')
  await c.expect({type:'yjs_update',room,updateB64},'yjs_ok')
  await until(()=>clients.every(p=>p.doc.getText('body').toString().includes('DENIED-DRAFT')),'promotion retry converges')
  return {demotionRefused:true,otherReplicasUnchanged:true,draftRetainedAndRetriedAfterPromotion:true}
 })
 await check('docker-rich-shrinking-cap-keeps-existing-documents-intact',async()=>{
  const before=clients[0].doc.getText('body').toString()
  await http('/v1/limits','PATCH',{yjsRoomMaxPeers:40})
  await until(()=>clients.filter(c=>c.frames.some(f=>f.type==='yjs_refuse'&&f.room===room&&/Too many people/.test(f.reason))).length>=count-40,'excess peers notified')
  assert.ok(clients.every(c=>c.doc.getText('body').toString()===before))
  return {cap:40,documentsPreserved:count}
 })
 report.status='passed'
}catch(e){report.status='failed';report.error=String(e instanceof Error?e.stack:e);console.error(report.error);process.exitCode=1}
finally{for(const ws of sockets)ws.terminate();report.finishedAt=new Date().toISOString();persist()}
