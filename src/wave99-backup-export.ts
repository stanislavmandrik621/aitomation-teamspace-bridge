/** One private durable full-export slot. This resumes delivery of a completed
 * frozen ZIP; partial assembly restarts. Completed generation survives final
 * verification interruption through Wave101, and never exposes unverified bytes. */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { constants, openSync, closeSync, fsyncSync, lstatSync, fstatSync, mkdirSync, realpathSync, readFileSync, unlinkSync, readdirSync, createReadStream } from 'node:fs'
import { open, statfs, type FileHandle } from 'node:fs/promises'
import { dirname, basename, resolve, join } from 'node:path'
import { Writable, Transform } from 'node:stream'
import { pipeline, finished } from 'node:stream/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { planBackupRangeWave98 } from './wave98-backup-range.js'
import { verifyBackupWithProgressWave103P05, validateBackupVerificationProgressWave103P05, type BackupVerificationProgressWave103P05 } from './wave103-p05-backup-verification.js'
import { observeBackupManifestWave103P05, assertBackupManifestWave103P05, saveBackupManifestWave103P05 } from './wave103-p05-backup-manifest.js'
const TTL = 24 * 60 * 60 * 1000, RESERVE = 64n * 1024n * 1024n
const bad = () => Error('Retained full export changed; files were retained.')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const tokenOK = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value)
type State = { verification?: BackupVerificationProgressWave103P05; version: 1; token: string; identity: string; expires: number; dev: string; ino: string; ready: boolean; generated?: boolean; assembly?: boolean; assemblySha256?: string; size: number; sha256: string; mtime: string; ctime: string; headers: Record<string,string> }
function regular(path: string) { const s = lstatSync(path, { bigint: true }); if (!s.isFile() || s.nlink !== 1n) throw bad(); return s }
function syncDir(path: string) { if (process.platform === 'win32') return; const fd = openSync(path, constants.O_RDONLY); try { fsyncSync(fd) } finally { closeSync(fd) } }
function load(path: string): State | undefined {
  let fd: number
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e }
  try {
    const st = fstatSync(fd); if (!st.isFile() || st.nlink !== 1 || st.size > 8192) throw bad()
    const s = JSON.parse(readFileSync(fd, 'utf8')) as State
    if (s.version !== 1 || !tokenOK(s.token) || !/^[a-f0-9]{64}$/.test(s.identity) || !Number.isSafeInteger(s.expires)
      || !/^\d+$/.test(s.dev) || !/^\d+$/.test(s.ino) || typeof s.ready !== 'boolean' || !Number.isSafeInteger(s.size) || s.size < 0
      || s.generated !== undefined && typeof s.generated !== 'boolean'
      || s.assembly !== undefined && typeof s.assembly !== 'boolean'
      || s.assembly && (s.ready || s.generated) && (typeof s.assemblySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.assemblySha256))
      || (s.ready || s.generated) && (s.size <= 0 || !/^\d+$/.test(s.mtime) || !/^\d+$/.test(s.ctime))
      || s.ready && !/^[a-f0-9]{64}$/.test(s.sha256)
      || !s.ready && s.generated && s.sha256 !== ''
      || !s.ready && !s.generated && (s.size !== 0 || s.sha256 !== '' || s.mtime !== '' || s.ctime !== '' || Object.keys(s.headers ?? {}).length !== 0)
      || !s.headers || Object.entries(s.headers).some(([k,v]) => !/^x-backup-export-[a-z-]+$/.test(k) || typeof v !== 'string' || v.length > 128 || /[\r\n]/.test(v))) throw bad()
    if(s.verification !== undefined){
      if(!s.generated || s.ready)throw bad()
      validateBackupVerificationProgressWave103P05(s.verification,JSON.stringify([s.identity,s.token]),s)
    }
    return s
  } finally { closeSync(fd) }
}
export async function admitExportBytesWave99(directory: string, bytes: number): Promise<void> {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw bad()
  const fs = await statfs(directory, { bigint: true })
  if (BigInt(bytes) + RESERVE > fs.bavail * fs.bsize) throw Error('Insufficient free space to stage a complete resumable export.')
}
export async function serveExportWave99(args: {
  directory: string; identity: string; token: unknown; request: IncomingMessage; response: ServerResponse;
  signal?: AbortSignal; authorize(): boolean;
  build(output: Writable): Promise<{ size: number; headers: Record<string,string> }>;
  hasAssembly?(): boolean;
  assemble?(output: FileHandle, path: string, check: () => void, binding: string): Promise<{ size: number; sha256: string; headers: Record<string,string> }>;
  removeAssembly?(binding: string, outDev: string, outIno: string, check: () => void): void;
  /** Test lifecycle observation only, not an authority input. */
  onReady?(): void;
  onGenerated?(): void;
  onVerifyProgress?(bytes: number): void;
}): Promise<void> {
  let manifestCheck = () => {}
  let ownershipCheck = () => {}
  const check = () => { args.signal?.throwIfAborted(); ownershipCheck(); manifestCheck(); if (!args.authorize()) throw Error('Admin session required') }
  check(); if (!tokenOK(args.token)) throw Error('Invalid export resume token')
  const token = args.token, directory = join(realpathSync(dirname(resolve(args.directory))), basename(args.directory))
  try { mkdirSync(directory, { mode: 0o700 }) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const d = lstatSync(directory)
  if (!d.isDirectory() || process.platform !== 'win32' && ((d.mode & 0o077) !== 0 || typeof process.getuid === 'function' && d.uid !== process.getuid())) throw bad()
  const lock = join(directory,'owner.sqlite'), statePath = join(directory,'manifest.json'), file = join(directory,'export.zip')
  try { const fd = openSync(lock,'wx',0o600); closeSync(fd) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  const originalLock = regular(lock)
  ownershipCheck = () => { const now=lstatSync(directory), lease=regular(lock); if(!now.isDirectory() || now.dev!==d.dev || now.ino!==d.ino || process.platform!=='win32' && ((now.mode&0o077)!==0 || now.uid!==d.uid) || lease.dev!==originalLock.dev || lease.ino!==originalLock.ino)throw bad() }
  const db = new DatabaseSync(lock)
  let locked = false, handle: FileHandle | undefined
  try {
    const lockNow = regular(lock); if (lockNow.dev !== originalLock.dev || lockNow.ino !== originalLock.ino) throw bad()
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE'); locked = true
    let manifestReceipt = observeBackupManifestWave103P05(statePath)
    let s = load(statePath)
    manifestCheck = () => assertBackupManifestWave103P05(statePath,manifestReceipt)
    manifestCheck()
    const saveState = (value: State) => {check();manifestReceipt=saveBackupManifestWave103P05(statePath,value,manifestReceipt);check()}
    if(s && !s.assembly && args.hasAssembly?.())throw bad()
    const owned = () => { const st = regular(file); if (!s || String(st.dev) !== s.dev || String(st.ino) !== s.ino) throw bad(); return st }
    const remove = () => {
      // Keep the manifest until the exact owned payload is gone. A crash
      // after unlink is recoverable; foreign or symlink files are never removed.
      try { const st=owned(); if((s?.ready || s?.generated) && (st.size!==BigInt(s.size)||String(st.mtimeNs)!==s.mtime||String(st.ctimeNs)!==s.ctime))throw bad() } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if(s?.assembly){if(!args.removeAssembly)throw bad();args.removeAssembly(JSON.stringify([s.identity,s.token]),s.dev,s.ino,check)}
      try { owned(); unlinkSync(file); syncDir(directory) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      manifestCheck(); unlinkSync(statePath); manifestReceipt=undefined; syncDir(directory); s = undefined
    }
    check()
    if (s && s.expires <= Date.now()) remove()
    const identity = hash(args.identity)
    if (s && (s.token !== token || s.identity !== identity)) throw Error('Another full export owns the retained slot; retry after expiry.')
    if (args.request.method === 'DELETE') {
      if (s) remove()
      check(); args.response.writeHead(204); args.response.end(); return
    }
    if (!s && args.request.headers.range !== undefined) { args.response.writeHead(412); args.response.end(); return }
    if (s && !s.ready && !s.generated && !s.assembly) remove() // Legacy incomplete assembly restarts; durable assembly resumes.
    if (!s) {
      // Refuse unknown orphan payloads instead of accumulating/deleting them.
      if (readdirSync(directory).some(n => !['owner.sqlite','owner.sqlite-journal','manifest.json.next'].includes(n))) throw bad()
      handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const st = fstatSync(handle.fd,{bigint:true})
      s = { version:1,token,identity,expires:Date.now()+TTL,dev:String(st.dev),ino:String(st.ino),ready:false,assembly:args.assemble?true:undefined,size:0,sha256:'',mtime:'',ctime:'',headers:{} }
      await handle.sync(); saveState(s)
    }
    if (!s.ready && !s.generated) {
      handle ??= await open(file,constants.O_RDWR|constants.O_NOFOLLOW)
      const opened=fstatSync(handle.fd,{bigint:true}),named=owned()
      if(opened.dev!==named.dev||opened.ino!==named.ino)throw bad()
      let bytes = 0
      let result: Awaited<ReturnType<typeof args.build>>,assemblySha256: string | undefined
      if(s.assembly){
        if(!args.assemble)throw bad()
        const assembled=await args.assemble(handle,file,check,JSON.stringify([s.identity,s.token]))
        result=assembled;assemblySha256=assembled.sha256;bytes=fstatSync(handle.fd).size
        if(!/^[a-f0-9]{64}$/.test(assemblySha256))throw bad()
      }else{
        const output = new Writable({ highWaterMark:64*1024, write(chunk: Buffer,_encoding,callback) {
          void (async () => { check(); let at=0; while(at<chunk.length){ const result=await handle!.write(chunk,at,chunk.length-at,bytes+at); if(!result.bytesWritten)throw bad(); at+=result.bytesWritten; check() } bytes+=chunk.length })().then(()=>callback(),callback)
        } })
        const done = finished(output); void done.catch(()=>{})
        try { result = await args.build(output); output.end(); await done; check() } catch(e) { output.destroy(); await done.catch(()=>{}); throw e }
      }
      if (result.size !== bytes || bytes <= 0) throw Error('Full export size did not match its complete inventory')
      await handle.sync(); check()
      const complete = fstatSync(handle.fd,{bigint:true}), after=owned()
      if(complete.size!==BigInt(bytes)||after.size!==complete.size||after.dev!==complete.dev||after.ino!==complete.ino||after.mtimeNs!==complete.mtimeNs||after.ctimeNs!==complete.ctimeNs)throw bad()
      // Exact writer completion + data fsync precede this durable intermediate
      // marker. A retry must verify the same file, never enumerate newer data.
      s={...s,generated:true,assemblySha256,size:bytes,sha256:'',mtime:String(complete.mtimeNs),ctime:String(complete.ctimeNs),headers:result.headers};saveState(s)
      args.onGenerated?.(); check()
    }
    if (!s.ready) {
      if (!s.generated) throw bad()
      handle ??= await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
      const sha256=await verifyBackupWithProgressWave103P05({source:handle,path:file,stamp:s,binding:JSON.stringify([s.identity,s.token]),previous:s.verification,check,
        persist:verification=>{check();s={...s!,verification};saveState(s);check()},progress:args.onVerifyProgress})
      check();if(s.assembly&&sha256!==s.assemblySha256)throw Error('Backup assembly failed complete SHA verification; existing files were retained.')
      const verified=owned()
      if(verified.size!==BigInt(s.size)||String(verified.mtimeNs)!==s.mtime||String(verified.ctimeNs)!==s.ctime)throw bad()
      s={...s,ready:true,sha256,verification:undefined};saveState(s)
      await handle.close(); handle=undefined; args.onReady?.(); check()
    }
    const state=s, st=owned()
    const stable=()=>{check();const now=owned();if(now.size!==BigInt(state.size)||String(now.mtimeNs)!==state.mtime||String(now.ctimeNs)!==state.ctime)throw bad()}
    stable();const range=planBackupRangeWave98(args.request.headers.range,args.request.headers['if-match'],state.sha256,state.size)
    if(!range.ok){args.response.writeHead(range.status);args.response.end();return}
    handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW)
    const fdst=fstatSync(handle.fd,{bigint:true});if(fdst.dev!==st.dev||fdst.ino!==st.ino)throw bad();stable()
    args.response.writeHead(range.status,{'content-type':'application/zip','content-length':String(range.length),'etag':range.etag,'accept-ranges':'bytes','x-backup-sha256':state.sha256,'x-backup-export-token':token,'cache-control':'no-store',...state.headers,...(range.contentRange?{'content-range':range.contentRange}:{})})
    let sent=0,last:Buffer|undefined
    const guard=new Transform({transform(chunk,_enc,cb){try{stable();if(chunk.length>range.length-sent)throw bad();sent+=chunk.length;if(last)this.push(last);last=Buffer.from(chunk);cb()}catch(e){cb(e as Error)}},flush(cb){try{stable();if(sent!==range.length)throw bad();cb(null,last)}catch(e){cb(e as Error)}}})
    const input=createReadStream(file,{fd:handle.fd,autoClose:false,start:range.start,end:state.size-1,highWaterMark:64*1024})
    await pipeline(input,guard,args.response,{signal:args.signal})
  } finally { try { await handle?.close() } finally { try { if(locked)db.exec('ROLLBACK') } finally { db.close() } } }
}
