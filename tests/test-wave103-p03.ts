import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync,writeFileSync,readFileSync,statSync } from 'node:fs'
import {open} from 'node:fs/promises'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {assembleBackupWave103P03} from '../src/wave103-p03-backup-assembly.js'
const home=process.env.P03_PROOF_ROOT || tmpdir()
async function fixture(){const root=mkdtempSync(join(home,'fixture-'));const entries=['a.aimove','b.aimove','chat/c.json'].map((name,i)=>{const absolutePath=join(root,String(i)),data=Buffer.from('payload-'+i);writeFileSync(absolutePath,data);return{name,absolutePath,size:data.length}});const outputPath=join(root,'out.zip');writeFileSync(outputPath,'');await new Promise(r=>setTimeout(r,700));return{root,entries,outputPath,database:join(root,'assembly.sqlite')}}
async function run(f:Awaited<ReturnType<typeof fixture>>,sources:any=async function*(){yield* f.entries},binding='owner'){const output=await open(f.outputPath,'r+');try{return await assembleBackupWave103P03({output,outputPath:f.outputPath,database:f.database,binding,sources,check:()=>{},admit:async()=>{}})}finally{await output.close()}}
async function stop(f:Awaited<ReturnType<typeof fixture>>){await assert.rejects(run(f,async function*(){yield f.entries[0];throw Error('stop')}),/stop/);assert.equal(statSync(f.outputPath).size,0)}
test('unsealed inventory resumes all rows even after reorder; checksum and counts exact',async()=>{const f=await fixture();await stop(f);const result=await run(f,async function*(){yield f.entries[2];yield f.entries[0];yield f.entries[1]});const bytes=readFileSync(f.outputPath);for(let i=0;i<3;i++)assert.ok(bytes.includes(Buffer.from('payload-'+i)));assert.equal(result.sha256,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.headers['x-backup-export-count'],'2');assert.equal(result.headers['x-backup-export-chat-count'],'1');await run(f,async function*(){throw Error('sealed must not enumerate')})})
test('missing retained entry rejects before output and preserves database',async()=>{const f=await fixture();await stop(f);await assert.rejects(run(f,async function*(){yield f.entries[1]}));assert.equal(statSync(f.outputPath).size,0);assert.ok(statSync(f.database).size>0)})
test('mutated committed source rejects before output',async()=>{const f=await fixture();await stop(f);writeFileSync(f.entries[0].absolutePath,'payload-X');await assert.rejects(run(f));assert.equal(statSync(f.outputPath).size,0)})
test('duplicate producer row rejects instead of omission',async()=>{const f=await fixture();await stop(f);await assert.rejects(run(f,async function*(){yield f.entries[0];yield f.entries[0]}));assert.equal(statSync(f.outputPath).size,0)})
test('owner mismatch rejects without database mutation',async()=>{const f=await fixture();await stop(f);const before=readFileSync(f.database);await assert.rejects(run(f,undefined,'foreign'));assert.deepEqual(readFileSync(f.database),before)})
test('repeated enumeration cancellation keeps all committed rows resumable',async()=>{const f=await fixture();await stop(f);await assert.rejects(run(f,async function*(){yield f.entries[0];yield f.entries[1];throw Error('again')}),/again/);const result=await run(f);assert.equal(result.headers['x-backup-export-count'],'2')})

test('process exit after inventory commit resumes and includes every entry',async()=>{
 const {spawn}=await import('node:child_process'),{once}=await import('node:events'),{fileURLToPath}=await import('node:url');const f=await fixture()
 const child=spawn(process.execPath,[...process.execArgv,fileURLToPath(new URL('./crash-wave103-p03.ts',import.meta.url)),JSON.stringify(f)],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const [code]=await once(child,'exit');assert.equal(code,17,stderr)
 const result=await run(f);assert.equal(result.headers['x-backup-export-count'],'2');assert.equal(result.headers['x-backup-export-chat-count'],'1');const zip=readFileSync(f.outputPath);for(let i=0;i<3;i++)assert.ok(zip.includes(Buffer.from('payload-'+i)))
})
