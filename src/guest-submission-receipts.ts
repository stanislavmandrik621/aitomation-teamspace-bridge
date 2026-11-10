/** Durable idempotency receipts for anonymous forms. Payloads stay in the existing
 * encrypted intake queue; receipts retain only keyed hashes and completion state.
 * Never evict a receipt and accidentally accept an old submission again. */
import {createHash,randomBytes} from 'node:crypto'
import {closeSync,fsyncSync,lstatSync,mkdirSync,openSync,opendirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {dirname,join} from 'node:path'
import {decryptJsonFile,encryptJsonFile,type AtRestKey} from './at-rest.js'
type Receipt={version:1;id:string;fingerprint:string;complete:boolean}
export type SubmissionReplay={id:string;fingerprint:string;exists:boolean;complete:boolean}
export class SubmissionReceiptError extends Error {
 constructor(readonly status:number,readonly code:string,message:string){super(message)}
}
const unavailable=()=>new SubmissionReceiptError(503,'retry_unavailable','Submission history could not be saved or verified. Try again after server storage is repaired.')
function canonical(value:unknown):string {
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']'
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}'
 return JSON.stringify(value)??'null'
}
export class GuestSubmissionReceipts {
 constructor(private readonly directory:string,private readonly atRest:AtRestKey|null){}
 private path(id:string){if(!/^[a-f0-9]{64}$/.test(id))throw unavailable();return join(this.directory,id.slice(0,2),id+'.json')}
 private read(id:string):Receipt|null {
  const path=this.path(id)
  try {
   const stat=lstatSync(path);if(!stat.isFile()||stat.size>4096)throw unavailable()
   const row=decryptJsonFile<Receipt|null>(this.atRest,readFileSync(path,'utf8'),null)
   if(!row||row.version!==1||row.id!==id||!/^[a-f0-9]{64}$/.test(row.fingerprint)||typeof row.complete!=='boolean')throw unavailable()
   return row
  }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw unavailable()}
 }
 probe(scope:string,key:unknown,data:unknown):SubmissionReplay|null {
  if(key===undefined||key===null)return null // Older clients retain their original behavior.
  if(typeof key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(key))throw new SubmissionReceiptError(400,'retry_key_invalid','Invalid submission retry key.')
  const id=createHash('sha256').update(scope+'\0'+key).digest('hex')
  const fingerprint=createHash('sha256').update(key+'\0'+canonical(data)).digest('hex')
  const row=this.read(id)
  if(row&&row.fingerprint!==fingerprint)throw new SubmissionReceiptError(409,'retry_content_changed','This submission was already sent with different content. Start a new submission.')
  return {id,fingerprint,exists:!!row,complete:row?.complete??false}
 }
 isComplete(id:string):boolean {return /^[a-f0-9]{64}$/.test(id)&&this.read(id)?.complete===true}
 reserve(replay:SubmissionReplay):void {if(!replay.exists)this.save({version:1,id:replay.id,fingerprint:replay.fingerprint,complete:false})}
 complete(id:string):void {
  if(!/^[a-f0-9]{64}$/.test(id))return // Legacy random 32-character ids have no receipt.
  const row=this.read(id);if(row&&!row.complete)this.save({...row,complete:true})
 }
 private save(row:Receipt):void {
  const path=this.path(row.id),bucket=dirname(path);let temporary:string|null=null
  try {
   mkdirSync(bucket,{recursive:true})
   if(!this.read(row.id)){
    const entries=opendirSync(bucket);let count=0
    try{while(entries.readSync())if(++count>=1024)throw unavailable()}finally{entries.closeSync()}
   }
   temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp'
   const file=openSync(temporary,'wx',0o600)
   try{writeFileSync(file,this.atRest?encryptJsonFile(this.atRest,row):JSON.stringify(row),'utf8');fsyncSync(file)}finally{closeSync(file)}
   renameSync(temporary,path);temporary=null
   if(process.platform!=='win32')for(const dir of [bucket,this.directory,dirname(this.directory)]){const fd=openSync(dir,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
  }catch{throw unavailable()}finally{if(temporary)try{unlinkSync(temporary)}catch{}}
 }
}
