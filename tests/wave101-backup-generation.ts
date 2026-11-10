import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, request, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { serveExportWave99 } from '../src/wave99-backup-export.js'
const BLOCK=64*1024,headers={'x-backup-export-mode':'all','x-backup-export-chat-truncated':'0','x-backup-export-missing-ids':'0','x-backup-export-ids-truncated':'0','x-backup-export-count':'41','x-backup-export-chat-count':'3'}
function fixture(){const root=mkdtempSync(join(tmpdir(),'aiq-wave101-generation-'));console.log(JSON.stringify({preservedFixture:root,reason:'Preserve source, manifests, databases and failures'}));const source=join(root,'source');writeFileSync(source,Buffer.alloc(BLOCK*4+17,0x5a));return {root,source,directory:join(root,'cache'),token:randomUUID()}}
function get(base:string,token:string,method='GET'):Promise<IncomingMessage>{return new Promise((resolve,reject)=>{const req=request(base,{method,headers:{'x-backup-export-token':token}},resolve);req.once('error',reject);req.end()})}
async function setup(f:ReturnType<typeof fixture>,hooks:{generated?:(ac:AbortController)=>void;verify?:(bytes:number,ac:AbortController)=>void;ready?:()=>void;forbidBuild?:boolean}={}){
 let builds=0,allowed=true,identity='team/member/device/all';const active=new Set<Promise<void>>()
 const server=createServer((req,res)=>{const ac=new AbortController();res.once('close',()=>ac.abort());const p=serveExportWave99({directory:f.directory,token:req.headers['x-backup-export-token'],identity,request:req,response:res,signal:ac.signal,authorize:()=>allowed,
 build:async out=>{if(hooks.forbidBuild)throw Error('Completed generation must never enumerate current sources');builds++;const bytes=readFileSync(f.source);for(let at=0;at<bytes.length;at+=BLOCK)if(!out.write(bytes.subarray(at,at+BLOCK)))await once(out,'drain');return {size:bytes.length,headers}},
 onGenerated:()=>hooks.generated?.(ac),onVerifyProgress:bytes=>hooks.verify?.(bytes,ac),onReady:hooks.ready,
 }).catch(e=>{if(!res.headersSent){res.writeHead(400,{'content-type':'text/plain'});res.end(String(e))}else res.destroy()}).finally(()=>active.delete(p));active.add(p)}).listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
 return {base,builds:()=>builds,setAllowed:(v:boolean)=>{allowed=v},setIdentity:(v:string)=>{identity=v},settle:()=>Promise.all([...active]),close:async()=>{server.closeAllConnections();await Promise.all([...active]);await new Promise<void>(r=>server.close(()=>r()))}}
}
async function consume(res:IncomingMessage){const chunks:Buffer[]=[];for await(const b of res)chunks.push(b);return Buffer.concat(chunks)}
if(process.argv[2]==='crash-generation'){
 const [root,token,boundary]=process.argv.slice(3),f={root:root!,source:join(root!,'source'),directory:join(root!,'cache'),token:token!}
 void(async()=>{const s=await setup(f,{generated:()=>{if(boundary==='generated')process.exit(17)},verify:bytes=>{if(boundary==='verify'&&bytes>=BLOCK)process.exit(17)},ready:()=>{if(boundary==='ready')process.exit(17)}});await consume(await get(s.base,f.token));await s.close()})().catch(e=>{console.error(e);process.exitCode=1})
}else{
 test('real process death after generation, during checksum and after ready all retain exact frozen bytes and original inventory honesty',async()=>{
  for(const boundary of ['generated','verify','ready']){const f=fixture(),expected=readFileSync(f.source),child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'crash-generation',f.root,f.token,boundary],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>{errors+=String(b)});const [code]=await once(child,'exit');assert.equal(code,17,errors)
   const state=JSON.parse(readFileSync(join(f.directory,'manifest.json'),'utf8'));assert.equal(state.generated,true);assert.equal(state.ready,boundary==='ready');assert.equal(state.sha256,boundary==='ready'?createHash('sha256').update(expected).digest('hex'):'');assert.deepEqual(state.headers,headers)
   writeFileSync(f.source,'new live source must not replace retained generation');let verified=0;const s=await setup(f,{forbidBuild:true,verify:n=>{verified=n}});try{const res=await get(s.base,f.token),bytes=await consume(res);assert.equal(res.statusCode,200);assert.deepEqual(bytes,expected);assert.equal(res.headers['x-backup-export-count'],'41');assert.equal(res.headers['x-backup-export-chat-count'],'3');assert.equal(s.builds(),0);assert.equal(verified,boundary==='ready'?0:expected.length)}finally{await s.close()}
  }
 })
 test('cancellation during checksum preserves generated checkpoint, sends no ZIP headers and retries the same artifact',async()=>{const f=fixture();let cancel=true;const s=await setup(f,{verify:(n,ac)=>{if(cancel&&n>=BLOCK)ac.abort()}});try{const first=await get(s.base,f.token);await consume(first);await s.settle();assert.equal(first.statusCode,400);assert.notEqual(first.headers['content-type'],'application/zip');let state=JSON.parse(readFileSync(join(f.directory,'manifest.json'),'utf8'));assert.equal(state.generated,true);assert.equal(state.ready,false);cancel=false
  writeFileSync(f.source,'changed-source');const next=await get(s.base,f.token);assert.deepEqual(await consume(next),Buffer.alloc(BLOCK*4+17,0x5a));assert.equal(next.statusCode,200);assert.equal(s.builds(),1)
 }finally{await s.close()}})
 test('current scope and revoked admin block generated validation before any readiness or delivery',async()=>{const f=fixture();let revoke=true;let s:Awaited<ReturnType<typeof setup>>;s=await setup(f,{verify:n=>{if(revoke&&n>=BLOCK)s.setAllowed(false)}});try{const first=await get(s.base,f.token);await consume(first);await s.settle();assert.equal(first.statusCode,400);assert.equal(JSON.parse(readFileSync(join(f.directory,'manifest.json'),'utf8')).ready,false)
  s.setAllowed(true);s.setIdentity('other-member');const foreign=await get(s.base,f.token);await consume(foreign);assert.equal(foreign.statusCode,400);assert.equal(s.builds(),1)
  s.setIdentity('team/member/device/all');revoke=false;const next=await get(s.base,f.token);assert.deepEqual(await consume(next),readFileSync(f.source));assert.equal(next.statusCode,200)
 }finally{await s.close()}})
 test('generated payload size, in-place rewrite and replacement refuse verify, DELETE and expiry cleanup without removing evidence',async()=>{
  for(const change of ['size','rewrite','replace']){const f=fixture();let stop=true;const s=await setup(f,{generated:ac=>{if(stop)ac.abort()}});try{await consume(await get(s.base,f.token));await s.settle();stop=false;const file=join(f.directory,'export.zip');if(change==='replace')renameSync(file,`${file}.original`);writeFileSync(file,Buffer.alloc(change==='size'?7:BLOCK*4+17,9));const changed=readFileSync(file)
   const failed=await get(s.base,f.token);await consume(failed);assert.equal(failed.statusCode,400);const del=await get(s.base,f.token,'DELETE');await consume(del);assert.equal(del.statusCode,400)
   const path=join(f.directory,'manifest.json'),state=JSON.parse(readFileSync(path,'utf8'));state.expires=0;writeFileSync(path,JSON.stringify(state));const expired=await get(s.base,randomUUID());await consume(expired);assert.equal(expired.statusCode,400);assert.deepEqual(readFileSync(file),changed);assert.ok(existsSync(path));assert.equal(s.builds(),1)
  }finally{await s.close()}}
 })
 test('malformed or downgraded generated markers fail closed; old ready manifests remain readable',async()=>{
  for(const change of ['wrong-type','omitted','false','bad-size','legacy-ready']){const f=fixture();let stop=true;const s=await setup(f,{generated:ac=>{if(stop&&change!=='legacy-ready')ac.abort()}});try{await consume(await get(s.base,f.token));await s.settle();stop=false;const path=join(f.directory,'manifest.json'),state=JSON.parse(readFileSync(path,'utf8'));if(change==='wrong-type')state.generated='yes';if(change==='false')state.generated=false;if(change==='bad-size')state.size=0;if(change==='omitted'||change==='legacy-ready')delete state.generated;writeFileSync(path,JSON.stringify(state));const before=readFileSync(join(f.directory,'export.zip'));const res=await get(s.base,f.token),bytes=await consume(res)
   if(change==='legacy-ready'){assert.equal(res.statusCode,200);assert.deepEqual(bytes,before)}else{assert.equal(res.statusCode,400);assert.deepEqual(readFileSync(join(f.directory,'export.zip')),before)}assert.equal(s.builds(),1)
  }finally{await s.close()}}
 })
 test('existing partial assembly semantics restart without falsely accepting a generated body',async()=>{const f=fixture(),s=await setup(f);try{const first=await get(s.base,f.token);await consume(first);await s.settle();const path=join(f.directory,'manifest.json'),state=JSON.parse(readFileSync(path,'utf8'));state.ready=false;delete state.generated;state.size=0;state.sha256='';state.mtime='';state.ctime='';state.headers={};writeFileSync(path,JSON.stringify(state));writeFileSync(f.source,'complete rebuilt archive');const res=await get(s.base,f.token);assert.equal(res.statusCode,200);assert.equal((await consume(res)).toString(),'complete rebuilt archive');assert.equal(s.builds(),2);assert.equal(statSync(join(f.directory,'export.zip')).size,24)
 }finally{await s.close()}})
}
