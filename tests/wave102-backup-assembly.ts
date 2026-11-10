import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync,writeFileSync,readFileSync,unlinkSync,statSync,openSync,closeSync,writeSync,existsSync,appendFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Writable } from 'node:stream'
import { createHash,randomUUID } from 'node:crypto'
import { createServer,request,type IncomingMessage } from 'node:http'
import { assembleBackupWave102,removeAssemblyWave102,assemblyExistsWave102 } from '../src/wave102-backup-assembly.js'
import { streamStoredBackupZip,type BackupZipEntry } from '../src/backup-zip.js'
import { serveExportWave99 } from '../src/wave99-backup-export.js'
const BLOCK=64*1024,binding='trusted-team-member-device-token'
function fixture(){const root=mkdtempSync(join(tmpdir(),'aiq-wave102-assembly-'));console.log(JSON.stringify({preservedFixture:root,reason:'Preserve source/databases/checkpoints/failed proofs'}));const entries:BackupZipEntry[]=[];for(const [name,bytes] of [['member/a.aimove',Buffer.from('first member')],['member/b.aimove',Buffer.alloc(BLOCK*4+17,7)],['chat/rooms.json',Buffer.from('{"original":true}')],['chat/history.jsonl',Buffer.from('original history\n')]] as const){const path=join(root,String(entries.length));writeFileSync(path,bytes);entries.push({name,size:bytes.length,absolutePath:path})}const outputPath=join(root,'archive.zip');writeFileSync(outputPath,'');return {root,entries,outputPath,database:join(root,'assembly.sqlite')}}
function readState(database:string){const db=new DatabaseSync(database);try{return JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get()!.value as string)}finally{db.close()}}
async function expected(entries:BackupZipEntry[]){const pieces:Buffer[]=[];const out=new Writable({write(b,_e,cb){pieces.push(Buffer.from(b));cb()}});const result=await streamStoredBackupZip(out,entries);assert.equal(result.ok,true);return Buffer.concat(pieces)}
async function run(f:ReturnType<typeof fixture>,options:Partial<Parameters<typeof assembleBackupWave102>[0]>={}){const output=await open(f.outputPath,'r+');try{return await assembleBackupWave102({database:f.database,output,outputPath:f.outputPath,binding,check:()=>{},sources:async function*(){yield* f.entries},admit:async()=>{},checkpointBytes:BLOCK,...options})}finally{await output.close()}}
async function interrupt(f:ReturnType<typeof fixture>){const ac=new AbortController();await assert.rejects(run(f,{check:()=>ac.signal.throwIfAborted(),onCheckpoint:p=>{if(p.active===2&&p.body>=BLOCK)ac.abort()}}));const s=readState(f.database);assert.equal(s.progress.completed,1);assert.equal(s.progress.active,2);assert.equal(s.progress.body,BLOCK);return s}
if(process.argv[2]==='crash-body'){
 const root=process.argv[3]!,f={root,entries:['member/a.aimove','member/b.aimove','chat/rooms.json','chat/history.jsonl'].map((name,i)=>({name,absolutePath:join(root,String(i)),size:statSync(join(root,String(i))).size})),outputPath:join(root,'archive.zip'),database:join(root,'assembly.sqlite')}
 void run(f,{onCheckpoint:p=>{if(p.active===2&&p.body>=BLOCK)process.exit(17)}}).catch(e=>{console.error(e);process.exitCode=1})
}else{
 test('real process restart seeks remaining member bytes, never reopens completed sources, and matches existing ZIP64 wire bytes',async()=>{const f=fixture(),want=await expected(f.entries),child=spawn(process.execPath,['--import','tsx',fileURLToPath(import.meta.url),'crash-body',f.root],{stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>{errors+=String(b)});const [code]=await once(child,'exit');assert.equal(code,17,errors);const s=readState(f.database);assert.equal(s.progress.body,BLOCK)
  unlinkSync(f.entries[0]!.absolutePath);writeFileSync(f.entries[2]!.absolutePath,'{"new":true}');const reads:Array<{name:string;offset:number}>=[]
  const result=await run(f,{sources:async function*(){throw Error('Must not enumerate newer source state')},onSourceRead:(name,offset)=>reads.push({name,offset})})
  assert.equal(reads.some(r=>r.name===f.entries[0]!.name),false);assert.equal(reads.find(r=>r.name===f.entries[1]!.name)?.offset,BLOCK);assert.deepEqual(readFileSync(f.outputPath),want);assert.equal(result.sha256,createHash('sha256').update(want).digest('hex'));assert.equal(result.headers['x-backup-export-count'],'2');assert.equal(result.headers['x-backup-export-chat-count'],'2')
 })
 test('uncommitted suffix is discarded only after retained prefix validation and preserves exact output',async()=>{const f=fixture(),want=await expected(f.entries);await interrupt(f);appendFileSync(f.outputPath,'unfinished descriptor/tail');await run(f);assert.deepEqual(readFileSync(f.outputPath),want)})
 test('active source mutation and retained prefix/CRC/offset/inventory tampering fail before source append',async()=>{
  for(const change of ['source','prefix','crc','offset','central','inventory','total']){const f=fixture();await interrupt(f)
   if(change==='source')writeFileSync(f.entries[1]!.absolutePath,Buffer.alloc(BLOCK*4+17,9))
   else if(change==='prefix'){const fd=openSync(f.outputPath,'r+');try{writeSync(fd,Buffer.from('X'),0,1,0)}finally{closeSync(fd)}}
   else{const db=new DatabaseSync(f.database);try{const s=readState(f.database);if(change==='central')db.exec('UPDATE central SET crc=crc+1 WHERE seq=1');else if(change==='inventory')db.exec("UPDATE entries SET name='member/wrong.aimove' WHERE seq=2");else{if(change==='crc')s.progress.crc^=1;if(change==='offset')s.progress.offset--;if(change==='total')s.total--;db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(s))}}finally{db.close()}}
   const before=readFileSync(f.outputPath);await assert.rejects(run(f));assert.deepEqual(readFileSync(f.outputPath),before)
  }
 })
 test('unknown regular journal/WAL/SHM sidecars remain byte-identical and prevent resume or cleanup',async()=>{
  for(const suffix of ['-journal','-wal','-shm']){const f=fixture();await interrupt(f);const path=f.database+suffix;writeFileSync(path,'UNRELATED RECOVERY EVIDENCE');const before=readFileSync(f.database),output=statSync(f.outputPath,{bigint:true});await assert.rejects(run(f));assert.throws(()=>removeAssemblyWave102({database:f.database,binding,outDev:String(output.dev),outIno:String(output.ino),check:()=>{}}));assert.equal(readFileSync(path,'utf8'),'UNRELATED RECOVERY EVIDENCE');assert.deepEqual(readFileSync(f.database),before)}
 })
 test('valid-looking SQLite hot journal is not ownership proof and remains untouched before native open',async()=>{const f=fixture();await interrupt(f);const journal=Buffer.alloc(512+4096+8);Buffer.from('d9d505f920a163d7','hex').copy(journal);journal.writeUInt32BE(1,8);journal.writeUInt32BE(1,16);journal.writeUInt32BE(512,20);journal.writeUInt32BE(4096,24);writeFileSync(f.database+'-journal',journal)
  const database=readFileSync(f.database),payload=readFileSync(f.outputPath),st=statSync(f.outputPath,{bigint:true});await assert.rejects(run(f));assert.throws(()=>removeAssemblyWave102({database:f.database,binding,outDev:String(st.dev),outIno:String(st.ino),check:()=>{}}));assert.deepEqual(readFileSync(f.database+'-journal'),journal);assert.deepEqual(readFileSync(f.database),database);assert.deepEqual(readFileSync(f.outputPath),payload)
 })
 test('current authorization and owner mismatch refuse continuation; incomplete inventory needs explicit reset',async()=>{const f=fixture();await interrupt(f);const before=readFileSync(f.outputPath);await assert.rejects(run(f,{check:()=>{throw Error('revoked')}}),/revoked/);await assert.rejects(run(f,{binding:'other-owner'}));assert.deepEqual(readFileSync(f.outputPath),before)
  const g=fixture();await assert.rejects(run(g,{sources:async function*(){yield g.entries[0]!;throw Error('inventory interrupted')}}),/inventory interrupted/);await assert.rejects(run(g),/inventory was interrupted/);assert.equal(statSync(g.outputPath).size,0)
 })
 async function requestZip(base:string,token:string,method='GET'):Promise<IncomingMessage>{return new Promise((resolve,reject)=>{const r=request(base,{method,headers:{'x-backup-export-token':token}},resolve);r.on('error',reject);r.end()})}
 async function consume(r:IncomingMessage){for await(const _ of r){/* drain bounded transport */}}
 async function serverFixture(f:ReturnType<typeof fixture>,onCheckpoint:NonNullable<Parameters<typeof assembleBackupWave102>[0]['onCheckpoint']>){const token=randomUUID(),active=new Set<Promise<void>>();let generation=0
  const server=createServer((req,res)=>{const ac=new AbortController();res.on('close',()=>ac.abort());const p=serveExportWave99({directory:join(f.root,'server-cache'),identity:'team/member/device',token:req.headers['x-backup-export-token'],request:req,response:res,signal:ac.signal,authorize:()=>true,build:async()=>{throw Error('legacy builder forbidden')},hasAssembly:()=>assemblyExistsWave102(join(f.root,'server-cache','assembly.sqlite')),assemble:async(output,outputPath,check,owner)=>{generation++;return assembleBackupWave102({database:join(f.root,'server-cache','assembly.sqlite'),output,outputPath,binding:owner,check,sources:async function*(){yield* f.entries},admit:async()=>{},checkpointBytes:BLOCK,onCheckpoint})},removeAssembly:(owner,outDev,outIno,check)=>removeAssemblyWave102({database:join(f.root,'server-cache','assembly.sqlite'),binding:owner,outDev,outIno,check})}).catch(e=>{if(!res.headersSent){res.writeHead(400);res.end(String(e))}else res.destroy()}).finally(()=>active.delete(p));active.add(p)}).listen(0,'127.0.0.1');await once(server,'listening');return {token,base:`http://127.0.0.1:${(server.address() as {port:number}).port}`,generation:()=>generation,settle:()=>Promise.all([...active]),close:async()=>{server.closeAllConnections();await Promise.all([...active]);await new Promise<void>(r=>server.close(()=>r()))}}
 }
 test('outer manifest downgrade cannot silently delete partial assembly and final full SHA rejects in-place rewrite during assembly',async()=>{
  for(const scenario of ['downgrade','rewrite']){const f=fixture(),s=await serverFixture(f,p=>{if(scenario==='downgrade'&&p.active===2&&p.body>=BLOCK)throw Error('interrupt');if(scenario==='rewrite'&&p.finalized){const fd=openSync(join(f.root,'server-cache','export.zip'),'r+');try{writeSync(fd,Buffer.from('X'),0,1,0)}finally{closeSync(fd)}}});try{const first=await requestZip(s.base,s.token);await consume(first);await s.settle();assert.equal(first.statusCode,400);const file=join(f.root,'server-cache','export.zip'),before=readFileSync(file),manifest=join(f.root,'server-cache','manifest.json'),state=JSON.parse(readFileSync(manifest,'utf8'));assert.equal(state.ready,false)
   if(scenario==='downgrade'){delete state.assembly;writeFileSync(manifest,JSON.stringify(state));for(const method of ['GET','DELETE']){const res=await requestZip(s.base,s.token,method);await consume(res);assert.equal(res.statusCode,400)}assert.deepEqual(readFileSync(file),before);assert.ok(existsSync(join(f.root,'server-cache','assembly.sqlite')))}
  }finally{await s.close()}}
 })
 test('finalized assembly and central-directory retry never reopens any original source; owned cleanup checks binding',async()=>{const f=fixture(),want=await expected(f.entries);await assert.rejects(run(f,{onCheckpoint:p=>{if(p.completed===4&&!p.finalized)throw Error('before central directory')}}));for(const e of f.entries)unlinkSync(e.absolutePath);const result=await run(f,{sources:async function*(){throw Error('must not recollect')}});assert.deepEqual(readFileSync(f.outputPath),want);assert.equal(result.sha256,createHash('sha256').update(want).digest('hex'));await run(f,{sources:async function*(){throw Error('must not recollect')}})
  const st=statSync(f.outputPath,{bigint:true});assert.throws(()=>removeAssemblyWave102({database:f.database,binding:'foreign',outDev:String(st.dev),outIno:String(st.ino),check:()=>{}}));assert.ok(existsSync(f.database));removeAssemblyWave102({database:f.database,binding,outDev:String(st.dev),outIno:String(st.ino),check:()=>{}});assert.equal(existsSync(f.database),false);assert.deepEqual(readFileSync(f.outputPath),want)
 })
}
