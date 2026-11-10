/** Durable ZIP64 assembly. The outer export lease owns this one DB+payload.
 * Restart revalidates retained ZIP bytes, then seeks remaining source bytes.
 * No serialized crypto state, full archive buffers or original-prefix reread. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, lstatSync, fstatSync, fsyncSync, unlinkSync, type BigIntStats } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { planStoredBackupZip, crc32Of, measureStoredBackupZipWave96, type BackupZipEntry } from './backup-zip.js'
import { localWave102, descriptorWave102, centralWave102, endWave102 } from './wave102-backup-zip-layout.js'
const BLOCK=64*1024,INTERVAL=8*1024*1024
const bad=()=>Error('Retained backup assembly changed. Existing files were retained; start a new complete export.')
const sha=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)
const integer=(n:unknown):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0
const hash=()=>createHash('sha256')
type Stamp={dev:string;ino:string;mtime:string;ctime:string;size:number}
type Row=Stamp&{seq:number;name:string;path:string;kind:number;metadataSha:string}
type Progress={completed:number;offset:number;prefix:string;active:number;body:number;crc:number;local:number;finalized:boolean}
type State={version:1;binding:string;dbDev:string;dbIno:string;outDev:string;outIno:string;inventoryReady:boolean;inventorySha:string;count:number;snapshots:number;chat:number;total:number;centralOffset:number;centralBytes:number;progress:Progress}
const stamp=(s:BigIntStats):Stamp=>({dev:String(s.dev),ino:String(s.ino),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),size:Number(s.size)})
function same(s:BigIntStats,t:Stamp){return s.isFile()&&s.nlink===1n&&String(s.dev)===t.dev&&String(s.ino)===t.ino&&String(s.mtimeNs)===t.mtime&&String(s.ctimeNs)===t.ctime&&s.size===BigInt(t.size)}
function regular(path:string){const s=lstatSync(path,{bigint:true});if(!s.isFile()||s.nlink!==1n)throw bad();return s}
function syncDir(path:string){if(process.platform==='win32')return;const fd=openSync(path,constants.O_RDONLY);try{fsyncSync(fd)}finally{closeSync(fd)}}
function maybe(path:string){try{return regular(path)}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}}
function journalGuard(path:string){
 // Even a valid SQLite header is not evidence that this process owns a
 // pre-existing recovery journal. Never let native open replay/delete it.
 // A crash during an uncommitted transaction needs explicit operator recovery.
 for(const suffix of ['-journal','-wal','-shm'])if(maybe(path+suffix))throw bad()
}
export function assemblyExistsWave102(path:string){return !!maybe(path)}
function connect(path:string){const before=regular(path);journalGuard(path);const db=new DatabaseSync(path);try{const now=regular(path);if(now.dev!==before.dev||now.ino!==before.ino)throw bad();db.exec('PRAGMA busy_timeout=0;PRAGMA journal_mode=DELETE;PRAGMA synchronous=FULL;PRAGMA cache_size=-2048;PRAGMA temp_store=FILE');return {db,before}}catch(e){db.close();throw e}}
function load(db:DatabaseSync):State{const raw=db.prepare('SELECT value FROM state WHERE id=1 AND length(value)<=8192').get();if(!raw||typeof raw.value!=='string')throw bad();const s=JSON.parse(raw.value) as State,p=s?.progress
 if(!s||s.version!==1||!sha(s.binding)||![s.dbDev,s.dbIno,s.outDev,s.outIno].every(v=>typeof v==='string'&&/^\d+$/.test(v))||typeof s.inventoryReady!=='boolean'||!p||typeof p.finalized!=='boolean'||![s.count,s.snapshots,s.chat,s.total,s.centralOffset,s.centralBytes,p.completed,p.offset,p.active,p.body,p.crc,p.local].every(integer)||!sha(p.prefix)||p.crc>0xffffffff||p.completed>s.count||p.active!==0&&p.active!==p.completed+1||p.active>s.count||p.active===0&&(p.body!==0||p.crc!==0||p.local!==0)||p.offset>s.total&&s.inventoryReady||s.inventoryReady&&!sha(s.inventorySha))throw bad();return s}
function save(db:DatabaseSync,s:State){db.prepare('UPDATE state SET value=? WHERE id=1').run(JSON.stringify(s))}
function row(raw:Record<string,unknown>):Row{const r=raw as unknown as Row;if(!integer(r.seq)||r.seq<1||!integer(r.size)||![r.dev,r.ino,r.mtime,r.ctime].every(v=>typeof v==='string'&&/^\d+$/.test(v))||typeof r.name!=='string'||typeof r.path!=='string'||r.kind!==0&&r.kind!==1||r.kind===1&&!sha(r.metadataSha))throw bad();return r}
function* rows(db:DatabaseSync){for(const raw of db.prepare('SELECT * FROM entries ORDER BY seq').iterate())yield row(raw)}
async function inventoryDigest(db:DatabaseSync,check:()=>void){const h=hash();let count=0;for(const r of rows(db)){check();if(r.seq!==++count)throw bad();h.update(JSON.stringify(r));h.update('\n');if(count%64===0)await new Promise<void>(resolve=>setImmediate(resolve))}check();return {sha:h.digest('hex'),count}}
function bindingFor(value:string){return hash().update(value).digest('hex')}
export type AssemblyContextWave102={database:string;output:FileHandle;outputPath:string;binding:string;check():void}
export async function assembleBackupWave103P03(args:AssemblyContextWave102&{
 sources():AsyncIterable<BackupZipEntry>;admit(bytes:number):Promise<void>;
 checkpointBytes?:number;
 /** Instrumentation only, never authority/state inputs. */
 onSourceRead?(name:string,offset:number,bytes:number):void;onCheckpoint?(progress:Readonly<Progress>):void;
}):Promise<{size:number;sha256:string;headers:Record<string,string>}>{
 args.check();const interval=args.checkpointBytes??INTERVAL;if(!integer(interval)||interval<BLOCK||interval>INTERVAL)throw bad()
 const outputBefore=fstatSync(args.output.fd,{bigint:true}),named=regular(args.outputPath)
 if(!outputBefore.isFile()||outputBefore.nlink!==1n||outputBefore.dev!==named.dev||outputBefore.ino!==named.ino)throw bad()
 let fresh=false
 if(!maybe(args.database)){
  if(outputBefore.size!==0n)throw bad();const fd=openSync(args.database,'wx',0o600);closeSync(fd);fresh=true
 }
 const {db,before}=connect(args.database),binding=bindingFor(args.binding)
 let state:State
 const check=()=>{args.check();const d=regular(args.database),f=fstatSync(args.output.fd,{bigint:true}),n=regular(args.outputPath);if(d.dev!==before.dev||d.ino!==before.ino||!f.isFile()||f.nlink!==1n||f.dev!==outputBefore.dev||f.ino!==outputBefore.ino||n.dev!==f.dev||n.ino!==f.ino)throw bad()}
 const buffer=Buffer.alloc(BLOCK)
 try{
  if(fresh){
   state={version:1,binding,dbDev:String(before.dev),dbIno:String(before.ino),outDev:String(outputBefore.dev),outIno:String(outputBefore.ino),inventoryReady:false,inventorySha:'',count:0,snapshots:0,chat:0,total:0,centralOffset:0,centralBytes:0,progress:{completed:0,offset:0,prefix:hash().digest('hex'),active:0,body:0,crc:0,local:0,finalized:false}}
   db.exec('BEGIN IMMEDIATE;CREATE TABLE state(id INTEGER PRIMARY KEY,value TEXT NOT NULL);CREATE TABLE entries(seq INTEGER PRIMARY KEY,name TEXT NOT NULL,identity TEXT UNIQUE NOT NULL,path TEXT NOT NULL,kind INTEGER NOT NULL,size INTEGER NOT NULL,dev TEXT NOT NULL,ino TEXT NOT NULL,mtime TEXT NOT NULL,ctime TEXT NOT NULL,metadataSha TEXT NOT NULL);CREATE TABLE metadata(seq INTEGER NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(seq,part));CREATE TABLE central(seq INTEGER PRIMARY KEY,crc INTEGER NOT NULL,local INTEGER NOT NULL);')
   db.prepare('INSERT INTO state VALUES(1,?)').run(JSON.stringify(state));db.exec('COMMIT');syncDir(dirname(args.database));check()
  }else state=load(db)
  check();if(state.binding!==binding||state.dbDev!==String(before.dev)||state.dbIno!==String(before.ino)||state.outDev!==String(outputBefore.dev)||state.outIno!==String(outputBefore.ino))throw bad()
  if(!state.inventoryReady){
   // An unsealed inventory has no archive bytes. Preserve committed metadata;
   // enumerate again to completion and require every retained identity to exist.
   if(state.progress.offset!==0||state.progress.completed!==0||state.progress.active!==0||state.progress.finalized||outputBefore.size!==0n)throw bad()
   const existing=await inventoryDigest(db,check)
   if(existing.count!==state.count||state.chat+state.snapshots!==state.count)throw bad()
   db.exec('CREATE TEMP TABLE wave103_seen(identity TEXT PRIMARY KEY)')
   const insert=db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?,?)'),blob=db.prepare('INSERT INTO metadata VALUES(?,?,?)')
   for await(const entry of args.sources()){
    check();const planned=await planStoredBackupZip([entry]);check();if(!planned.ok)throw Error(planned.error)
    const plan=planned.planned[0]!,initial=regular(entry.absolutePath),st=stamp(initial)
    if(initial.dev!==BigInt(plan.device)||initial.ino!==BigInt(plan.inode)||st.size!==plan.size)throw bad()
    const identity=entry.name.normalize('NFC').toLowerCase()
    // Disk-backed uniqueness also rejects duplicate producer rows on retries.
    db.prepare('INSERT INTO wave103_seen VALUES(?)').run(identity)
    const retained=db.prepare('SELECT * FROM entries WHERE identity=?').get(identity)
    if(retained){const prior=row(retained);if(prior.name!==entry.name||prior.path!==entry.absolutePath||!same(initial,prior))throw bad();continue}
    const r:Row={...st,seq:state.count+1,name:entry.name,path:entry.absolutePath,kind:entry.name.startsWith('chat/')&&entry.name.endsWith('.json')?1:0,metadataSha:''}
    db.exec('BEGIN IMMEDIATE')
    try{
     if(r.kind===1){
      await args.admit(r.size);check();const input=await open(r.path,constants.O_RDONLY|constants.O_NOFOLLOW),digest=hash()
      const sourceCheck=()=>{check();if(!same(fstatSync(input.fd,{bigint:true}),r)||!same(regular(r.path),r))throw bad()}
      try{let part=0;for(let at=0;at<r.size;){sourceCheck();const n=await input.read(buffer,0,Math.min(BLOCK,r.size-at),at);sourceCheck();if(!n.bytesRead)throw bad();digest.update(buffer.subarray(0,n.bytesRead));blob.run(r.seq,part++,buffer.subarray(0,n.bytesRead));at+=n.bytesRead}sourceCheck();r.metadataSha=digest.digest('hex')}finally{await input.close()}
     }
     insert.run(r.seq,r.name,r.name.normalize('NFC').toLowerCase(),r.path,r.kind,r.size,r.dev,r.ino,r.mtime,r.ctime,r.metadataSha);state.count++;if(r.name.startsWith('chat/'))state.chat++;else state.snapshots++;save(db,state);db.exec('COMMIT')
    }catch(e){db.exec('ROLLBACK');throw e}
    if(state.count%64===0)await new Promise<void>(r=>setImmediate(r))
   }
   if(db.prepare('SELECT seq FROM entries WHERE identity NOT IN (SELECT identity FROM wave103_seen) LIMIT 1').get())throw bad()
   if(state.count===0)throw Error('No backups or team chat files on disk')
   const layout=await measureStoredBackupZipWave96((function*(){for(const r of rows(db))yield {size:r.size,nameBuf:Buffer.from(r.name)}})(),{authorize:()=>{check();return true}})
   await args.admit(layout.contentLength);check();const inventory=await inventoryDigest(db,check);if(inventory.count!==state.count)throw bad()
   state={...state,inventoryReady:true,inventorySha:inventory.sha,total:layout.contentLength,centralOffset:layout.centralOffset,centralBytes:layout.centralBytes};save(db,state);syncDir(dirname(args.database));check()
  }
  check();if(state.binding!==binding||state.dbDev!==String(before.dev)||state.dbIno!==String(before.ino)||state.outDev!==String(outputBefore.dev)||state.outIno!==String(outputBefore.ino))throw bad()
  const inv=await inventoryDigest(db,check);if(inv.sha!==state.inventorySha||inv.count!==state.count||state.snapshots+state.chat!==state.count)throw bad()
  const layout=await measureStoredBackupZipWave96((function*(){for(const r of rows(db))yield {size:r.size,nameBuf:Buffer.from(r.name)}})(),{authorize:()=>{check();return true}})
  if(layout.contentLength!==state.total||layout.centralOffset!==state.centralOffset||layout.centralBytes!==state.centralBytes)throw bad()
  const p=state.progress,centralCount=db.prepare('SELECT count(*) AS count,min(seq) AS first,max(seq) AS last FROM central').get()!
  if(centralCount.count!==p.completed||p.completed>0&&(centralCount.first!==1||centralCount.last!==p.completed))throw bad()
  const outputHash=hash();let offset=0
  const outputStamp=fstatSync(args.output.fd,{bigint:true})
  const readCheck=()=>{check();if(!same(fstatSync(args.output.fd,{bigint:true}),stamp(outputStamp))||!same(regular(args.outputPath),stamp(outputStamp)))throw bad()}
  const readBytes=async(length:number,expected?:Buffer,withCrc=false)=>{let done=0,crc=0;while(done<length){readCheck();const n=await args.output.read(buffer,0,Math.min(BLOCK,length-done),offset);readCheck();if(!n.bytesRead)throw bad();const bytes=buffer.subarray(0,n.bytesRead);if(expected&&!bytes.equals(expected.subarray(done,done+n.bytesRead)))throw bad();outputHash.update(bytes);if(withCrc)crc=crc32Of(bytes,crc);done+=n.bytesRead;offset+=n.bytesRead}return crc}
  // Reparse retained members instead of trusting SQLite CRC/offset metadata.
  for(const r of rows(db)){
   if(r.seq>p.completed&&r.seq!==p.active)break
   const local=offset;await readBytes(localWave102(Buffer.from(r.name),r.size).length,localWave102(Buffer.from(r.name),r.size))
   if(r.seq<=p.completed){const crc=await readBytes(r.size,undefined,true);await readBytes(24,descriptorWave102(r.size,crc));const c=db.prepare('SELECT crc,local FROM central WHERE seq=?').get(r.seq);if(!c||c.crc!==crc||c.local!==local)throw bad()}
   else{if(p.local!==local||p.body>r.size)throw bad();const crc=await readBytes(p.body,undefined,true);if(crc!==p.crc)throw bad()}
  }
  if(p.finalized){
   if(p.completed!==state.count||p.active!==0||offset!==state.centralOffset)throw bad()
   for(const r of rows(db)){const c=db.prepare('SELECT crc,local FROM central WHERE seq=?').get(r.seq);if(!c)throw bad();const bytes=centralWave102(Buffer.from(r.name),r.size,Number(c.crc),Number(c.local));await readBytes(bytes.length,bytes)}
   const end=endWave102(state.count,state.centralOffset,state.centralBytes);await readBytes(end.length,end)
  }
  if(offset!==p.offset||outputHash.copy().digest('hex')!==p.prefix||outputStamp.size<BigInt(offset))throw bad();readCheck()
  await args.output.truncate(offset);check()
  const write=async(bytes:Buffer)=>{let at=0;while(at<bytes.length){check();const n=await args.output.write(bytes,at,bytes.length-at,offset+at);check();if(!n.bytesWritten)throw bad();at+=n.bytesWritten}outputHash.update(bytes);offset+=bytes.length}
  const commit=async(next:Progress,central?:{seq:number;crc:number;local:number})=>{
   await args.output.sync();check();if(fstatSync(args.output.fd).size!==offset)throw bad()
   next.offset=offset;next.prefix=outputHash.copy().digest('hex');db.exec('BEGIN IMMEDIATE');try{if(central)db.prepare('INSERT INTO central VALUES(?,?,?)').run(central.seq,central.crc,central.local);state.progress=next;save(db,state);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}
   syncDir(dirname(args.database));args.onCheckpoint?.({...next});check()
  }
  if(!p.finalized){
   for(const r of rows(db)){
    if(r.seq<=state.progress.completed)continue
    let body=state.progress.active===r.seq?state.progress.body:0,crc=state.progress.active===r.seq?state.progress.crc:0,local=state.progress.active===r.seq?state.progress.local:offset
    if(state.progress.active!==r.seq){await write(localWave102(Buffer.from(r.name),r.size));await commit({completed:r.seq-1,active:r.seq,body:0,crc:0,local,offset:0,prefix:'',finalized:false})}
    let committed=body
    if(r.kind===1){
     const digest=hash();let at=0,part=0
     for(const raw of db.prepare('SELECT part,CASE WHEN length(data) BETWEEN 1 AND 65536 THEN data ELSE NULL END AS data FROM metadata WHERE seq=? ORDER BY part').iterate(r.seq)){
      check();if(raw.part!==part++||!(raw.data instanceof Uint8Array)||raw.data.length<1||raw.data.length>BLOCK||at+raw.data.length>r.size)throw bad();const bytes=Buffer.from(raw.data);digest.update(bytes)
      if(at+bytes.length>body){const view=bytes.subarray(Math.max(0,body-at));await write(view);crc=crc32Of(view,crc);body+=view.length}
      at+=bytes.length
      if(part%64===0){await new Promise<void>(resolve=>setImmediate(resolve));check()}
      if(body-committed>=interval){await commit({completed:r.seq-1,active:r.seq,body,crc,local,offset:0,prefix:'',finalized:false});committed=body}
     }
     if(at!==r.size||digest.digest('hex')!==r.metadataSha)throw bad()
    }else{
     const input=await open(r.path,constants.O_RDONLY|constants.O_NOFOLLOW)
     const sourceCheck=()=>{check();if(!same(fstatSync(input.fd,{bigint:true}),r)||!same(regular(r.path),r))throw bad()}
     try{
      sourceCheck();while(body<r.size){sourceCheck();const start=body,n=await input.read(buffer,0,Math.min(BLOCK,r.size-body),body);sourceCheck();if(!n.bytesRead)throw bad();await write(buffer.subarray(0,n.bytesRead));crc=crc32Of(buffer.subarray(0,n.bytesRead),crc);body+=n.bytesRead;args.onSourceRead?.(r.name,start,n.bytesRead);sourceCheck()
       if(body-committed>=interval){await commit({completed:r.seq-1,active:r.seq,body,crc,local,offset:0,prefix:'',finalized:false});committed=body}
      }sourceCheck()
     }finally{await input.close()}
    }
    if(body!==r.size)throw bad();await write(descriptorWave102(r.size,crc));await commit({completed:r.seq,active:0,body:0,crc:0,local:0,offset:0,prefix:'',finalized:false},{seq:r.seq,crc,local})
   }
   if(offset!==state.centralOffset)throw bad()
   for(const r of rows(db)){check();const c=db.prepare('SELECT crc,local FROM central WHERE seq=?').get(r.seq);if(!c)throw bad();await write(centralWave102(Buffer.from(r.name),r.size,Number(c.crc),Number(c.local)))}
   await write(endWave102(state.count,state.centralOffset,state.centralBytes));if(offset!==state.total)throw bad()
   await commit({completed:state.count,active:0,body:0,crc:0,local:0,offset:0,prefix:'',finalized:true})
  }
  check();if(offset!==state.total||fstatSync(args.output.fd).size!==state.total)throw bad()
  return {size:state.total,sha256:state.progress.prefix,headers:{'x-backup-export-count':String(state.snapshots),'x-backup-export-chat-count':String(state.chat),'x-backup-export-chat-truncated':'0','x-backup-export-missing-ids':'0','x-backup-export-ids-truncated':'0','x-backup-export-mode':'all'}}
 }finally{buffer.fill(0);db.close()}
}
/** Only the exact assembly DB tied to this token/scope/output may be removed.
 * Unknown sidecars or corrupt ownership stop cleanup and preserve the payload. */
export function removeAssemblyWave102(args:{database:string;binding:string;outDev:string;outIno:string;check():void}){
 args.check();if(!maybe(args.database))return
 const {db,before}=connect(args.database)
 try{const s=load(db);if(s.binding!==bindingFor(args.binding)||s.dbDev!==String(before.dev)||s.dbIno!==String(before.ino)||s.outDev!==args.outDev||s.outIno!==args.outIno)throw bad()}finally{db.close()}
 args.check();const current=regular(args.database);if(current.dev!==before.dev||current.ino!==before.ino)throw bad()
 for(const suffix of ['-journal','-wal','-shm'])if(maybe(args.database+suffix))throw bad()
 unlinkSync(args.database);syncDir(dirname(args.database))
}
