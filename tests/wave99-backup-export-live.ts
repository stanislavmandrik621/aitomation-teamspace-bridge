import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { Readable } from 'node:stream'
import { randomUUID, createHash } from 'node:crypto'
import { BridgeStore } from '../src/store.js'
import { TeamBackupStore } from '../src/backup-store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
async function start(root:string,port:number){let logs='';const child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,TEAMSPACE_DATA_DIR:root,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port),TEAMSPACE_BACKUP_TOKENS:'100'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{logs+=String(b)});child.stderr.on('data',b=>{logs+=String(b)});const deadline=Date.now()+20000;while(!logs.includes('bridge listening')){if(Date.now()>deadline||child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,20))}return child}
async function stop(child:ChildProcess){if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended}}
test('actual complete-export route freezes full inventory, survives server restart and enforces token/range identity',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aiq-wave99-server-'));console.log(JSON.stringify({preservedFixture:root,preservedAuthority:root+'.authority',reason:'Preserve all databases/source evidence'}))
 const roster=new BridgeStore(root,21,null),admin=roster.helloOrBootstrap({memberId:'admin',deviceId:'admin-device',displayName:'Admin'});assert.ok(admin.ok)
 const backups=new TeamBackupStore(root),payload=Buffer.alloc(128*1024+17,7)
 // More than the ordinary maxZipAimoves default: complete mode must not use it.
 for(let n=0;n<41;n++){const body=Buffer.from(`member-payload-${n}`);const stored=await backups.putSnapshotFromStream({memberId:`member-${n}`,contentLength:body.length,stream:Readable.from([body])});assert.ok(stored.ok)}
 mkdirSync(join(root,'chat','history'),{recursive:true});writeFileSync(join(root,'chat','history','all.jsonl'),payload)
 initializeCurrentAuthority(root,root+'.authority')
 const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
 const url=`http://127.0.0.1:${port}/v1/backups/export.zip?mode=all`,token=randomUUID(),headers={authorization:`Bearer ${admin.sessionToken}`,'x-backup-export-token':token}
 let child=await start(root,port)
 try{
  const first=await fetch(url,{headers});assert.equal(first.status,200);assert.equal(first.headers.get('x-backup-export-count'),'41');assert.equal(first.headers.get('x-backup-export-mode'),'all');assert.equal(first.headers.get('x-backup-export-chat-truncated'),'0')
  const bytes=Buffer.from(await first.arrayBuffer()),etag=first.headers.get('etag')!;assert.equal(etag,`"${createHash('sha256').update(bytes).digest('hex')}"`);assert.ok(bytes.includes(Buffer.from('member-payload-40')));assert.ok(bytes.includes(Buffer.from('chat/history/all.jsonl')))
  await stop(child);writeFileSync(join(root,'chat','history','all.jsonl'),'new-source-after-frozen-export');child=await start(root,port)
  const resumed=await fetch(url,{headers:{...headers,range:'bytes=17-','if-match':etag}});assert.equal(resumed.status,206);assert.deepEqual(Buffer.from(await resumed.arrayBuffer()),bytes.subarray(17))
  const wrong=await fetch(url,{headers:{...headers,range:'bytes=17-','if-match':'"wrong"'}});assert.equal(wrong.status,412);await wrong.arrayBuffer()
  const foreign=await fetch(url,{headers:{...headers,'x-backup-export-token':randomUUID()}});assert.equal(foreign.status,400);await foreign.arrayBuffer()
  const denied=await fetch(url,{headers:{'x-backup-export-token':token}});assert.ok([401,403].includes(denied.status));await denied.arrayBuffer()
  const ack=await fetch(url,{method:'DELETE',headers});assert.equal(ack.status,204)
  const fresh=await fetch(url,{headers:{...headers,'x-backup-export-token':randomUUID()}});assert.equal(fresh.status,200);const freshBytes=Buffer.from(await fresh.arrayBuffer());assert.ok(freshBytes.includes(Buffer.from('new-source-after-frozen-export')))
  // Wait for the previous server to release its streaming export lease.
  // A fresh process also proves persisted expiry handling independently of RAM.
  await stop(child);child=await start(root,port)
  // Expiry cleanup is explicit and only removes an exact owned stable artifact.
  const path=join(root,'backup-export-resume','manifest.json'),state=JSON.parse(readFileSync(path,'utf8'));state.expires=0;writeFileSync(path,JSON.stringify(state))
  const expired=await fetch(url,{headers:{...headers,range:'bytes=17-','if-match':etag}});assert.equal(expired.status,412);await expired.arrayBuffer()
 }finally{await stop(child)}
})
