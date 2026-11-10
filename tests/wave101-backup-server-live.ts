import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID, createHash } from 'node:crypto'
import { BridgeStore } from '../src/store.js'
import { TeamBackupStore } from '../src/backup-store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
async function start(root:string,port:number,crash=false){let logs='';const child=spawn(process.execPath,['--import','tsx',crash?'tests/wave101-backup-server-fixture.ts':'src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,TEAMSPACE_DATA_DIR:root,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port),TEAMSPACE_BACKUP_TOKENS:'100'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{logs+=String(b)});child.stderr.on('data',b=>{logs+=String(b)});const deadline=Date.now()+20000;while(!logs.includes('bridge listening')){if(Date.now()>deadline||child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,20))}return child}
async function stop(child:ChildProcess){if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended}}
test('actual full export recovers completed generation after process death before checksum without re-enumerating newer snapshots or chat',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aiq-wave101-server-'));console.log(JSON.stringify({preservedFixture:root,preservedAuthority:root+'.authority',reason:'Preserve all source/database/checkpoint evidence'}))
 const roster=new BridgeStore(root,21,null),admin=roster.helloOrBootstrap({memberId:'admin',deviceId:'admin-device',displayName:'Admin'});assert.ok(admin.ok)
 const backups=new TeamBackupStore(root)
 for(let n=0;n<41;n++){const bytes=Buffer.from(`original-member-${n}`);assert.ok((await backups.putSnapshotFromStream({memberId:`member-${n}`,contentLength:bytes.length,stream:Readable.from([bytes])})).ok)}
 mkdirSync(join(root,'chat','history'),{recursive:true});writeFileSync(join(root,'chat','history','all.jsonl'),'original chat payload')
 initializeCurrentAuthority(root,root+'.authority')
 const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
 const url=`http://127.0.0.1:${port}/v1/backups/export.zip?mode=all`,token=randomUUID(),headers={authorization:`Bearer ${admin.sessionToken}`,'x-backup-export-token':token}
 let child=await start(root,port,true)
 try{
  const ended=once(child,'exit'),first=fetch(url,{headers}).then(response=>({status:response.status}),error=>({error}))
  const [code]=await ended;assert.equal(code,17);assert.ok('error' in await first,'No ZIP200 headers may precede complete verification')
  const path=join(root,'backup-export-resume'),state=JSON.parse(readFileSync(join(path,'manifest.json'),'utf8')),frozen=readFileSync(join(path,'export.zip'))
  assert.equal(state.generated,true);assert.equal(state.ready,false);assert.equal(state.sha256,'');assert.equal(state.headers['x-backup-export-count'],'41');assert.equal(frozen.length,state.size)
  writeFileSync(join(root,'chat','history','all.jsonl'),'new chat MUST NOT be silently mixed into frozen export')
  const newer=Buffer.from('new snapshot MUST NOT be enumerated');assert.ok((await backups.putSnapshotFromStream({memberId:'member-new',contentLength:newer.length,stream:Readable.from([newer])})).ok)
  child=await start(root,port)
  const recovered=await fetch(url,{headers});assert.equal(recovered.status,200);assert.equal(recovered.headers.get('x-backup-export-count'),'41');assert.equal(recovered.headers.get('x-backup-export-chat-count'),state.headers['x-backup-export-chat-count']);assert.deepEqual(Buffer.from(await recovered.arrayBuffer()),frozen)
  assert.equal(recovered.headers.get('etag'),`"${createHash('sha256').update(frozen).digest('hex')}"`);assert.ok(frozen.includes(Buffer.from('original-member-40')));assert.ok(frozen.includes(Buffer.from('original chat payload')))
  const complete=JSON.parse(readFileSync(join(path,'manifest.json'),'utf8'));assert.equal(complete.generated,true);assert.equal(complete.ready,true)
 }finally{await stop(child)}
})
