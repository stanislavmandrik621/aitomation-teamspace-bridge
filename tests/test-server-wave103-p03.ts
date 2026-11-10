import {tmpdir} from 'node:os'
import test from 'node:test'
import assert from 'node:assert/strict'
import {spawn,type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'
import {mkdtempSync,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {Readable} from 'node:stream'
import {randomUUID,createHash} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {BridgeStore} from '../src/store.ts'
import {TeamBackupStore} from '../src/backup-store.ts'
import {initializeCurrentAuthority} from '../src/independent-authority.ts'
async function start(root:string,port:number,crash=false){let logs='';const child=spawn(process.execPath,[...process.execArgv,crash?fileURLToPath(new URL('./server-crash-wave103-p03.ts',import.meta.url)):fileURLToPath(new URL('../src/server.ts',import.meta.url))],{env:{...process.env,TEAMSPACE_DATA_DIR:root,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port),TEAMSPACE_BACKUP_TOKENS:'100'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);const deadline=Date.now()+20000;while(!logs.includes('bridge listening')){if(Date.now()>deadline||child.exitCode!==null){child.kill('SIGTERM');throw Error(logs)}await new Promise(r=>setTimeout(r,20))}return child}
async function stop(child:ChildProcess){if(child.exitCode===null){const done=once(child,'exit');child.kill('SIGTERM');await done}}
test('actual server full export route recovers unsealed inventory after process exit',async()=>{const root=mkdtempSync(join((process.env.P03_PROOF_ROOT || tmpdir()),'server-')),store=new BridgeStore(root,21,null),admin=store.helloOrBootstrap({memberId:'admin',deviceId:'admin-device',displayName:'Admin'});assert.ok(admin.ok);const backups=new TeamBackupStore(root);for(const name of ['a','b']){const b=Buffer.from(`full-source-${name}`);assert.ok((await backups.putSnapshotFromStream({memberId:`member-${name}`,contentLength:b.length,stream:Readable.from([b])})).ok)}initializeCurrentAuthority(root,root+'.authority');await new Promise(r=>setTimeout(r,700));const listener=createServer().listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));const url=`http://127.0.0.1:${port}/v1/backups/export.zip?mode=all`,headers={authorization:`Bearer ${admin.sessionToken}`,'x-backup-export-token':randomUUID()};let child=await start(root,port,true)
 try{const exited=once(child,'exit'),first=fetch(url,{headers}).then(r=>({status:r.status}),error=>({error}));const [code]=await exited;assert.equal(code,17);assert.ok('error' in await first);const database=join(root,'backup-export-resume','assembly.sqlite'),db=new DatabaseSync(database);try{const state=JSON.parse(db.prepare('SELECT value FROM state').get()!.value as string);assert.equal(state.inventoryReady,false);assert.equal(state.count,1)}finally{db.close()};child=await start(root,port);const response=await fetch(url,{headers});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.ok(bytes.includes(Buffer.from('full-source-a')));assert.ok(bytes.includes(Buffer.from('full-source-b')));assert.equal(response.headers.get('x-backup-export-count'),'2');assert.equal(response.headers.get('etag'),`"${createHash('sha256').update(bytes).digest('hex')}"`);const final=JSON.parse(readFileSync(join(root,'backup-export-resume','manifest.json'),'utf8'));assert.equal(final.ready,true);assert.equal(final.sha256,final.assemblySha256)}finally{await stop(child)}})
