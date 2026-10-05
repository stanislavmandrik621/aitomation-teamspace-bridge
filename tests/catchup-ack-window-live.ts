import assert from 'node:assert/strict'
import {initializeCurrentAuthority} from '../src/independent-authority.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { BridgeStore, hashSessionToken } from '../src/store.js'
const dir=mkdtempSync(join(tmpdir(),'catchup-ack-window-')), sockets:WebSocket[]=[]
let child:ReturnType<typeof spawn>|undefined, logs=''
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
async function until<T>(read:()=>T|undefined,label:string):Promise<T>{const end=Date.now()+15000;while(Date.now()<end){const v=read();if(v!==undefined)return v;await delay(10)}throw new Error(label+' '+logs)}
try{
 writeFileSync(join(dir,'team.json'),JSON.stringify({teamId:'paced-team',name:'Paced',createdAt:1}))
 writeFileSync(join(dir,'members.json'),JSON.stringify(['admin','slow','legacy','excluded','partial'].map(memberId=>({memberId,displayName:memberId,email:memberId+'@test.invalid',createdAt:1,role:memberId==='admin'?'admin':'member',sessions:{[memberId]:hashSessionToken(memberId+'-token')}}))))
 const store=new BridgeStore(dir,21,null,null);let serial=0
 const op=(kind:string,targetId:string,extra:any={})=>({opId:'paced-'+serial++,kind,targetId,targetKind:kind.split('.')[0],originRole:'admin',originMemberId:'admin',originDevice:'admin',hlc:`${Date.now()}:${serial}:admin`,protocolVersion:2,hopCount:0,moduleId:'module',...extra})
 const seeds=[op('module.create','module',{visibleToMemberIds:['slow','legacy','partial']}),op('entity.create','entity',{entityId:'entity'}),...Array.from({length:110},(_,i)=>op('record.create','record-'+i,{entityId:'entity',patch:{data:{name:'Row '+i}}}))]
 store.appendOps(seeds)
 initializeCurrentAuthority(dir,dir+'.authority')
 const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as any).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('TEAMSPACE_'))delete env[k]
 child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','pipe'],env:{...env,TEAMSPACE_DATA_DIR:dir,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port)}})
 let ready=false;child.stdout!.on('data',b=>{if(String(b).includes('bridge listening'))ready=true});child.stderr!.on('data',b=>{logs=(logs+String(b)).slice(-4000)})
 await until(()=>ready||undefined,'server startup')
 async function connect(memberId:string,windowed:boolean){const socket=new WebSocket(`ws://127.0.0.1:${port}`),frames:any[]=[];sockets.push(socket);socket.on('message',b=>frames.push(JSON.parse(String(b))));await once(socket,'open');socket.send(JSON.stringify({type:'hello',protocolVersion:2,memberId,deviceId:memberId,sessionToken:memberId+'-token',catchupAckWindow:windowed}));await until(()=>frames.find(f=>f.type==='hello_ok'),'hello');return{socket,frames}}
 const slow=await connect('slow',true)
 const first=await until(()=>slow.frames.find(f=>f.type==='ops'),'first chunk')
 assert.ok(first.ops.length<=32)
 slow.socket.send(JSON.stringify({type:'ping',t:42}))
 await until(()=>slow.frames.find(f=>f.type==='pong'&&f.t===42),'control reply while durable ACK held')
 slow.socket.send(JSON.stringify({type:'catchup_processed',frameId:'wrong-frame'}));await delay(200);assert.equal(slow.frames.filter(f=>f.type==='ops').length,1,'next frame must wait for durable receipt')
 assert.equal(slow.frames.some(f=>f.type==='catchup_status'&&f.done),false)
 // Disconnect before ACK: it must replay this exact unaccepted prefix.
 slow.socket.close();await once(slow.socket,'close')
 const resumed=await connect('slow',true), replay=await until(()=>resumed.frames.find(f=>f.type==='ops'),'replayed prefix')
 assert.deepEqual(replay.ops.map((o:any)=>o.opId),first.ops.map((o:any)=>o.opId))
 let n=0;const delivered:string[]=[]
 while(delivered.length<seeds.length){const frame=await until(()=>resumed.frames.filter(f=>f.type==='ops')[n],'next chunk');n++;delivered.push(...frame.ops.map((o:any)=>o.opId));resumed.socket.send(JSON.stringify({type:'ack_ops',frameId:'receipt-'+n,deviceId:'slow',opIds:frame.ops.map((o:any)=>o.opId)}));resumed.socket.send(JSON.stringify({type:'catchup_processed',frameId:frame.frameId}))}
 await until(()=>resumed.frames.find(f=>f.type==='catchup_status'&&f.done),'durable catch-up completion')
 assert.deepEqual(delivered,seeds.map(o=>o.opId))
 const partial=await connect('partial',true),partialFirst=await until(()=>partial.frames.find(f=>f.type==='ops'),'partial first');partial.socket.send(JSON.stringify({type:'catchup_processed',frameId:partialFirst.frameId}));await until(()=>partial.frames.filter(f=>f.type==='ops')[1],'credit advances without durable ACK');partial.socket.close();await once(partial.socket,'close');const partialRetry=await connect('partial',true),partialReplay=await until(()=>partialRetry.frames.find(f=>f.type==='ops'),'partial replay');assert.deepEqual(partialReplay.ops.map((o:any)=>o.opId),partialFirst.ops.map((o:any)=>o.opId),'flow credit must never stamp durable acceptance');partialRetry.socket.close();
 const legacy=await connect('legacy',false);await until(()=>legacy.frames.find(f=>f.type==='catchup_status'&&f.done),'legacy streaming');assert.equal(legacy.frames.flatMap(f=>f.type==='ops'?f.ops:[]).length,seeds.length)
 const excluded=await connect('excluded',true);await until(()=>excluded.frames.find(f=>f.type==='catchup_status'&&f.done),'excluded completion');assert.equal(excluded.frames.filter(f=>f.type==='ops').length,0)
 console.log('PASS live catch-up ACK window: one frame, responsive control, lost receipt replay, complete ordered history, legacy compatibility and excluded member isolation')
}finally{for(const socket of sockets)socket.terminate();if(child&&child.exitCode===null){const done=once(child,'exit'),timer=setTimeout(()=>child!.kill('SIGKILL'),5000);child.kill('SIGTERM');await done;clearTimeout(timer)}rmSync(dir,{recursive:true,force:true});rmSync(dir+'.authority',{recursive:true,force:true})}
