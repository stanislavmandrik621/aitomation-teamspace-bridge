import assert from 'node:assert/strict'
import test from 'node:test'
import { Writable } from 'node:stream'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, symlinkSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { serveExportWave99 } from '../src/wave99-backup-export.js'
const here=dirname(fileURLToPath(import.meta.url)), proof=join(here,'../../../proof/fixtures')
mkdirSync(proof,{recursive:true})
const payload=Buffer.alloc(2*1024*1024+17,0x5a), identity='owner/device/all'
function fixture(){const directory=join(mkdtempSync(join(proof,'case-')),'cache');return {directory,token:randomUUID()}}
function state(f:{directory:string}){return JSON.parse(readFileSync(join(f.directory,'manifest.json'),'utf8'))}
async function run(f:{directory:string;token:string}, hooks:{progress?:(bytes:number)=>void;authorize?:()=>boolean;forbidBuild?:boolean;identity?:string}={}){
 const chunks:Buffer[]=[];let status=0,headers:Record<string,unknown>={},builds=0
 const response=new Writable({write(chunk,_enc,cb){chunks.push(Buffer.from(chunk));cb()}}) as Writable & {writeHead:(code:number,h:Record<string,unknown>)=>void}
 response.writeHead=(code,h)=>{status=code;headers=h}
 const promise=serveExportWave99({directory:f.directory,token:f.token,identity:hooks.identity??identity,request:{method:'GET',headers:{}} as IncomingMessage,response:response as unknown as ServerResponse,authorize:hooks.authorize??(()=>true),
  build:async output=>{assert.ok(!hooks.forbidBuild,'must not regenerate frozen ZIP');builds++;output.write(payload);return {size:payload.length,headers:{'x-backup-export-count':'7'}}},onVerifyProgress:hooks.progress})
 try{await promise;return {status,headers,body:Buffer.concat(chunks),builds}}catch(error){assert.equal(status,0,'no delivery before verified SHA');throw error}
}
if(process.argv[2]==='crash'){
 await run({directory:process.argv[3]!,token:process.argv[4]!},{progress:()=>process.exit(17)})
}else{
 test('durable first checksum observation survives process death; restart rereads all bytes and publishes canonical SHA',async()=>{
  const f=fixture(),child=spawnSync(process.execPath,[...process.execArgv.filter(a=>!a.startsWith('--test')),fileURLToPath(import.meta.url),'crash',f.directory,f.token],{encoding:'utf8',maxBuffer:1024*1024})
  assert.equal(child.status,17,child.stderr);const before=state(f);assert.equal(before.ready,false);assert.equal(before.sha256,'');assert.equal(before.verification.bytes,65536);assert.equal(before.verification.attempt,1)
  const progress:number[]=[];let attempt=0,previous=0
  const result=await run(f,{forbidBuild:true,progress:n=>{progress.push(n);const s=state(f);attempt=s.verification.attempt;previous=s.verification.previousAttemptBytes}})
  assert.equal(progress[0],65536);assert.equal(progress.at(-1),payload.length);assert.equal(attempt,2);assert.equal(previous,65536)
  assert.equal(result.status,200);assert.deepEqual(result.body,payload);assert.equal(result.headers['x-backup-sha256'],createHash('sha256').update(payload).digest('hex'))
  assert.equal(state(f).verification,undefined);assert.equal(state(f).ready,true)
 })
 test('checkpoint writes are bounded and preserve original inventory',async()=>{
  const f=fixture();const observations=new Set<number>()
  await run(f,{progress:()=>{const s=state(f);observations.add(s.verification.bytes);assert.equal(s.headers['x-backup-export-count'],'7')}})
  assert.equal(observations.size,3);assert.ok(observations.has(payload.length))
 })
 test('forged complete offsets never bypass full checksum; wrong binding or malformed progress fails closed',async()=>{
  for(const mutation of ['complete','binding','bytes','stamp']){
   const f=fixture();await assert.rejects(run(f,{progress:()=>{throw Error('interrupt')}}),/interrupt/)
   const s=state(f);if(mutation==='complete')s.verification.bytes=s.size;if(mutation==='binding')s.verification.binding='foreign';if(mutation==='bytes')s.verification.bytes=s.size+1;if(mutation==='stamp')s.verification.stamp.ino='0'
   writeFileSync(join(f.directory,'manifest.json'),JSON.stringify(s));let first=0
   if(mutation==='complete'){await run(f,{forbidBuild:true,progress:n=>{first ||= n}});assert.equal(first,65536)}
   else await assert.rejects(run(f,{forbidBuild:true}),/progress changed/)
  }
 })
 test('current authority loss and modified retained bytes never publish',async()=>{
  const f=fixture();let allowed=true
  await assert.rejects(run(f,{authorize:()=>allowed,progress:()=>{allowed=false}}),/Admin session/)
  assert.equal(state(f).ready,false);assert.ok(state(f).verification)
  await assert.rejects(run(f,{forbidBuild:true,identity:'foreign'}),/owns the retained slot/)
  writeFileSync(join(f.directory,'export.zip'),Buffer.alloc(payload.length,0x42))
  await assert.rejects(run(f,{forbidBuild:true}),/generation changed/)
  assert.equal(state(f).ready,false);assert.ok(existsSync(join(f.directory,'export.zip')))
 })
 test('foreign manifest and temporary checkpoint substitutions are preserved without delivery',async()=>{
  for(const mutation of ['manifest-replaced','manifest-in-place','temporary-file','temporary-symlink']){
   const f=fixture();let changed=false;let foreign='';let foreignBytes=Buffer.from('foreign checkpoint must survive')
   await assert.rejects(run(f,{progress:()=>{
    if(changed)return;changed=true
    const manifest=join(f.directory,'manifest.json')
    if(mutation==='manifest-replaced'){
     foreign=manifest;foreignBytes=readFileSync(manifest);renameSync(manifest,manifest+'.observed');writeFileSync(manifest,foreignBytes)
    }else if(mutation==='manifest-in-place'){
     foreign=manifest;writeFileSync(manifest,foreignBytes)
    }else if(mutation==='temporary-file'){
     foreign=manifest+'.next';writeFileSync(foreign,foreignBytes)
    }else{
     foreign=join(f.directory,'foreign-source');writeFileSync(foreign,foreignBytes);symlinkSync(foreign,manifest+'.next')
    }
   }}))
   assert.deepEqual(readFileSync(foreign),foreignBytes)
   if(mutation==='temporary-symlink')assert.ok(lstatSync(join(f.directory,'manifest.json.next')).isSymbolicLink())
   assert.ok(existsSync(join(f.directory,'export.zip')))
  }
 })
 test('legacy generated manifests without checksum progress remain resumable',async()=>{
  const f=fixture();await assert.rejects(run(f,{progress:()=>{throw Error('interrupt')}}),/interrupt/)
  const s=state(f);delete s.verification;writeFileSync(join(f.directory,'manifest.json'),JSON.stringify(s))
  let attempt=0;await run(f,{forbidBuild:true,progress:()=>{attempt=state(f).verification.attempt}});assert.equal(attempt,1)
 })
}
