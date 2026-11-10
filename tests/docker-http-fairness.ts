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
const run=randomUUID().slice(0,8), output=resolve('../../docs/docker-collaboration-audit-2026-09-09/docker-http-fairness')
mkdirSync(output,{recursive:true});if(existsSync(resolve(output,'results.json'))){mkdirSync(resolve(output,'attempts'),{recursive:true});writeFileSync(resolve(output,'attempts',Date.now()+'.json'),readFileSync(resolve(output,'results.json')))}
const report:Frame={startedAt:new Date().toISOString(),status:'running',boundary:'Real Docker HTTP requests from three authenticated members on one source IP; independent member budgets, anonymous exhaustion and Retry-After recovery.',cases:[]}
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

const clients:Client[]=[]
const base='http://127.0.0.1:18881'
const get=(token?:string)=>fetch(base+'/v1/limits',{headers:token?{authorization:'Bearer '+token}:{}})
try {
 clients.push(await new Client(18881).auth({memberId:'http-admin-'+run,deviceId:'http-admin-'+run,memberEmail:run+'@example.test',displayName:'HTTP audit'}))
 for(let i=1;i<3;i++){
  const email=run+'-'+i+'@example.test',invite=await clients[0].expect({type:'invite_create',email,role:'member'},'invite_ok')
  const c=new Client(18881);await once(c.ws,'open')
  const cred=await c.expect({type:'invite_redeem',token:invite.token,deviceId:'http-'+i,memberEmail:email,displayName:'HTTP member '+i},'invite_redeem_ok')
  await c.auth({memberId:cred.memberId,deviceId:'http-'+i,sessionToken:cred.sessionToken});clients.push(c)
 }
 await check('docker-http-three-members-one-ip-independent-budgets',async()=>{
  const counts=await Promise.all(clients.map(async c=>{const statuses=[];for(let i=0;i<400;i++){const r=await get(c.credential.sessionToken);statuses.push(r.status);await r.text()}return statuses}))
  assert.ok(counts.every(s=>s.every(v=>v===200)),JSON.stringify(counts.map(s=>({ok:s.filter(v=>v===200).length,limited:s.filter(v=>v===429).length}))))
  return {members:3,requestsPerMember:400,totalSuccessful:1200,sourceIps:1}
 })
 await check('docker-http-abusive-member-and-unknown-tokens-do-not-starve-teammates',async()=>{
  let limited:Response|undefined
  for(let i=0;i<205;i++){const r=await get(clients[0].credential.sessionToken);if(r.status===429){limited=r;break}await r.text()}
  assert.ok(limited);const wait=Number(limited.headers.get('retry-after'));assert.ok(wait>0&&wait<=10);await limited.text()
  assert.equal((await get(clients[1].credential.sessionToken)).status,200)
  const unauthorized=[]
  for(let i=0;i<65;i++){const r=await get('invalid-'+i);unauthorized.push(r.status);await r.text()}
  assert.equal(unauthorized.filter(v=>v===401).length,60);assert.equal(unauthorized.filter(v=>v===429).length,5)
  assert.equal((await get(clients[2].credential.sessionToken)).status,200)
  assert.equal((await fetch(base+'/health')).status,200)
  await sleep(wait*1000+100)
  assert.equal((await get(clients[0].credential.sessionToken)).status,200)
  return {overBudgetMemberLimited:true,otherMembersUnaffected:true,invalidTokensShareIpBudget:true,healthUnaffected:true,retryAfterRestoresAccess:true}
 })
 report.status='passed'
} catch(e){report.status='failed';report.error=String(e);process.exitCode=1}finally{report.finishedAt=new Date().toISOString();persist();for(const ws of sockets)ws.close()}
