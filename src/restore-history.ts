/** Bounded recovery history, separate from delivery receipts and authorization.
 * Prune commits this copy before replacing the ordinary delivery log. Current
 * permissions are still applied by the server at every replay send boundary.
 */
import {createHash,randomUUID} from 'node:crypto'
import {createReadStream,existsSync,lstatSync,mkdirSync,openSync,closeSync,fsyncSync,writeSync,readSync,readFileSync,renameSync,writeFileSync,unlinkSync,constants} from 'node:fs'
import {StringDecoder} from 'node:string_decoder'
import {createInterface} from 'node:readline'
import {join} from 'node:path'
import {decryptJsonFile,encryptJsonFile,decryptOpsLine,type AtRestKey} from './at-rest.js'
import type {ModulesSyncOp} from './index.js'

type Manifest={version:1;file:string;sha256:string;bytes:number;complete:boolean}
export class RestoreHistory {
 private readonly dir:string
 private readonly manifestPath:string
 constructor(root:string,private key:AtRestKey|null,private maxBytes:number){this.dir=join(root,'restore-history');this.manifestPath=join(this.dir,'manifest.json')}
 private manifest():Manifest|null{
  if(existsSync(this.dir)){const s=lstatSync(this.dir);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Restore history directory is invalid')}
  if(!existsSync(this.manifestPath)){
   if(existsSync(join(this.dir,'initialized')))throw Error('Restore history manifest is missing')
   return null
  }
  this.regular(this.manifestPath,65536)
  const raw=readFileSync(this.manifestPath,'utf8')
  const m=decryptJsonFile(this.key,raw,null) as Manifest|null
  if(!m||m.version!==1||!/^generation-[a-f0-9-]{36}\.jsonl$/.test(m.file)||!/^[a-f0-9]{64}$/.test(m.sha256)||!Number.isSafeInteger(m.bytes)||m.bytes<0||m.bytes>this.maxBytes||typeof m.complete!=='boolean')throw Error('Restore history manifest is invalid')
  return m
 }
 /** Preserve command identity after delivery-log pruning, without applying
  * historical permissions to the independent current authorization stores. */
 remember(accept:(op:ModulesSyncOp)=>void):void{
  const m=this.manifest();if(!m)return
  const path=join(this.dir,m.file),s=this.regular(path,this.maxBytes)
  if(s.size!==m.bytes)throw Error('Restore history length changed')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),buffer=Buffer.alloc(65536),hash=createHash('sha256')
  try{
   let at=0,n:number
   while((n=readSync(fd,buffer,0,buffer.length,at))>0){at+=n;hash.update(buffer.subarray(0,n))}
   if(hash.digest('hex')!==m.sha256)throw Error('Restore history integrity check failed')
   at=0;let carry='';const decoder=new StringDecoder('utf8')
   while((n=readSync(fd,buffer,0,buffer.length,at))>0){at+=n;const lines=(carry+decoder.write(buffer.subarray(0,n))).split('\n');carry=lines.pop()!;for(const line of lines){if(!line)throw Error('Invalid restore history row');accept(JSON.parse(decryptOpsLine(this.key,line)) as ModulesSyncOp)}}
   carry+=decoder.end();if(carry)throw Error('Restore history has an unfinished row')
  }finally{closeSync(fd)}
 }
 private regular(path:string,max:number){const s=lstatSync(path);if(s.isSymbolicLink()||!s.isFile()||s.size>max)throw Error('Restore history path is invalid');return s}
 private syncDir(){const fd=openSync(this.dir,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
 /** Verified plaintext only lives for the current streamed row. */
 private async *lines(m:Manifest):AsyncGenerator<{line:string;op:ModulesSyncOp}>{
  const path=join(this.dir,m.file),s=this.regular(path,this.maxBytes)
  if(s.size!==m.bytes)throw Error('Restore history length changed')
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW),stream=createReadStream(path,{fd,encoding:'utf8'}),reader=createInterface({input:stream}),hash=createHash('sha256')
  stream.on('data',chunk=>hash.update(chunk))
  try{
   for await(const line of reader){
    if(!line)throw Error('Restore history contains an empty row')
    const op=JSON.parse(decryptOpsLine(this.key,line)) as ModulesSyncOp
    if(!op||typeof op.opId!=='string'||!op.opId||typeof op.kind!=='string')throw Error('Restore history contains an invalid operation')
    yield {line,op}
   }
   if(hash.digest('hex')!==m.sha256)throw Error('Restore history integrity check failed')
  }finally{reader.close();stream.destroy()}
 }
 async *scan():AsyncGenerator<ModulesSyncOp>{
  const m=this.manifest();if(!m)return
  // First verify every byte before releasing any operation from this generation.
  for await(const _row of this.lines(m)){/* integrity pass */}
  if(!m.complete)throw Error('Restore history reached its storage limit; a current recovery copy is required')
  for await(const row of this.lines(m))yield row.op
 }
 /** Called before pruning; a failed commit leaves the ordinary log intact. */
 async retain(removed:ReadonlyArray<{line:string;opId:string}>):Promise<void>{
  if(!removed.length)return
  if(existsSync(this.dir)){const s=lstatSync(this.dir);if(s.isSymbolicLink()||!s.isDirectory())throw Error('Restore history directory is invalid')}
  else mkdirSync(this.dir,{mode:0o700})
  const prior=this.manifest(),file='generation-'+randomUUID()+'.jsonl',path=join(this.dir,file)
  const fd=openSync(path,'wx',0o600),hash=createHash('sha256'),seen=new Map<string,string>()
  let bytes=0,complete=prior?.complete??true,published=false,closed=false
  const add=(line:string,opId:string)=>{
   const decoded=JSON.parse(decryptOpsLine(this.key,line)) as ModulesSyncOp
   if(decoded?.opId!==opId||typeof decoded.kind!=='string'||!decoded.kind)throw Error('Restore history operation identity is invalid')
   const fingerprint=createHash('sha256').update(JSON.stringify(decoded)).digest('hex'),priorFingerprint=seen.get(opId)
   if(priorFingerprint){if(priorFingerprint!==fingerprint)throw Error('Restore history operation identity conflicts');return}
   seen.set(opId,fingerprint)
   const buffer=Buffer.from(line+'\n')
   if(bytes+buffer.length>this.maxBytes){complete=false;return}
   let offset=0;while(offset<buffer.length){const n=writeSync(fd,buffer,offset);if(n<=0)throw Error('Restore history write did not progress');offset+=n}
   bytes+=buffer.length;hash.update(buffer)
  }
  try{
   if(prior)for await(const row of this.lines(prior))add(row.line,row.op.opId)
   for(let n=0;n<removed.length;n++){
    const row=removed[n]!
    if(!row.opId)throw Error('Cannot retain an unidentified operation')
    add(row.line,row.opId)
    if(n%64===0)await new Promise<void>(resolve=>setImmediate(resolve))
   }
   fsyncSync(fd);closeSync(fd);closed=true;this.syncDir()
   const m:Manifest={version:1,file,bytes,sha256:hash.digest('hex'),complete}
   const pending=join(this.dir,'manifest-'+randomUUID()+'.tmp'),serialized=this.key?encryptJsonFile(this.key,m):JSON.stringify(m)
   writeFileSync(pending,serialized,{mode:0o600,flag:'wx'});const mf=openSync(pending,'r');try{fsyncSync(mf)}finally{closeSync(mf)}
   renameSync(pending,this.manifestPath);this.syncDir();published=true
   const sentinel=join(this.dir,'initialized')
   if(existsSync(sentinel))this.regular(sentinel,1)
   else{const init=openSync(sentinel,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeSync(init,'1');fsyncSync(init)}finally{closeSync(init)};this.syncDir()}
   if(prior)try{unlinkSync(join(this.dir,prior.file));this.syncDir()}catch{/* current committed generation is retained */}
  }finally{if(!closed)closeSync(fd);if(!published)try{unlinkSync(path)}catch{/* preserve interrupted evidence */}}
 }
}
