import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn,type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,unlinkSync,statSync,existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID,createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { BridgeStore } from '../src/store.js'
import { TeamBackupStore } from '../src/backup-store.js'
import { initializeCurrentAuthority } from '../src/independent-authority.js'
async function start(root:string,port:number,crash=false){let logs='';const child=spawn(process.execPath,['--import','tsx',crash?'tests/wave102-backup-server-fixture.ts':'src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...process.env,TEAMSPACE_DATA_DIR:root,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port),TEAMSPACE_BACKUP_TOKENS:'100'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>{logs+=String(b)});child.stderr.on('data',b=>{logs+=String(b)});const deadline=Date.now()+20000;while(!logs.includes('bridge listening')){if(Date.now()>deadline||child.exitCode!==null)throw Error(logs);await new Promise(r=>setTimeout(r,20))}return child}
async function stop(child:ChildProcess){if(child.exitCode===null){const ended=once(child,'exit');child.kill('SIGTERM');await ended}}
test('actual full-export route resumes an8MiB member checkpoint after server death without recollecting changed sources',async()=>{
 const root=mkdtempSync(join(tmpdir(),'aiq-wave102-server-'));console.log(JSON.stringify({preservedFixture:root,preservedAuthority:root+'.authority',reason:'Preserve source/databases/partial archive and validation proof'}))
 const roster=new BridgeStore(root,21,null),admin=roster.helloOrBootstrap({memberId:'admin',deviceId:'admin-device',displayName:'Admin'});assert.ok(admin.ok)
 const backups=new TeamBackupStore(root),block=Buffer.alloc(64*1024,7),length=8*1024*1024+17
 const huge=await backups.putSnapshotFromStream({memberId:'huge-member',contentLength:length,stream:Readable.from((function*(){for(let at=0;at<length;at+=block.length)yield block.subarray(0,Math.min(block.length,length-at))})())});assert.ok(huge.ok)
 for(let n=0;n<41;n++){const b=Buffer.from(`small-${n}`);assert.ok((await backups.putSnapshotFromStream({memberId:`member-${n}`,contentLength:b.length,stream:Readable.from([b])})).ok)}
 mkdirSync(join(root,'chat'),{recursive:true});writeFileSync(join(root,'chat','snapshot.json'),'{"frozen":true}');initializeCurrentAuthority(root,root+'.authority')
 const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()))
 const url=`http://127.0.0.1:${port}/v1/backups/export.zip?mode=all`,token=randomUUID(),headers={authorization:`Bearer ${admin.sessionToken}`,'x-backup-export-token':token}
 let child=await start(root,port,true)
 try{
  const exited=once(child,'exit'),first=fetch(url,{headers}).then(r=>({status:r.status}),error=>({error}));const [code]=await exited;assert.equal(code,17);assert.ok('error' in await first,'No complete-export headers before final generation/SHA')
  const directory=join(root,'backup-export-resume'),dbPath=join(directory,'assembly.sqlite'),db=new DatabaseSync(dbPath);let state:any;try{state=JSON.parse(db.prepare('SELECT value FROM state WHERE id=1').get()!.value as string)}finally{db.close()}
  assert.equal(state.inventoryReady,true);assert.ok(state.progress.active>0);assert.equal(state.progress.body,8*1024*1024);assert.equal(state.snapshots,42)
  const archiveStamp=statSync(join(directory,'export.zip'),{bigint:true}),savedPrefix=readFileSync(join(directory,'export.zip'));assert.equal(savedPrefix.length,state.progress.offset)
  writeFileSync(join(root,'chat','snapshot.json'),'{"NEW":true}')
  // A newly indexed missing snapshot would make fresh full enumeration fail.
  // The frozen inventory must never touch that new row during resume.
  const extra=await backups.putSnapshotFromStream({memberId:'new-member',contentLength:1,stream:Readable.from([Buffer.from('x')])});assert.ok(extra.ok)
  let extraPath='';for await(const row of backups.iterateFullExportEntries())if(row.name.includes(extra.snapshot.id))extraPath=row.absolutePath;assert.ok(extraPath);unlinkSync(extraPath)
  child=await start(root,port)
  const resumed=await fetch(url,{headers});assert.equal(resumed.status,200);assert.equal(resumed.headers.get('x-backup-export-count'),'42');const bytes=Buffer.from(await resumed.arrayBuffer());assert.deepEqual(bytes.subarray(0,savedPrefix.length),savedPrefix);assert.ok(bytes.includes(Buffer.from('{"frozen":true}')));assert.ok(!bytes.includes(Buffer.from('{"NEW":true}')));assert.equal(resumed.headers.get('etag'),`"${createHash('sha256').update(bytes).digest('hex')}"`)
  const finalStamp=statSync(join(directory,'export.zip'),{bigint:true});assert.equal(finalStamp.ino,archiveStamp.ino);const final=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));assert.equal(final.assembly,true);assert.equal(final.generated,true);assert.equal(final.ready,true);assert.equal(final.sha256,final.assemblySha256)
  await stop(child);child=await start(root,port)
  const ack=await fetch(url,{method:'DELETE',headers});assert.equal(ack.status,204);assert.equal(existsSync(dbPath),false);assert.equal(existsSync(join(directory,'export.zip')),false)
 }finally{await stop(child)}
})
