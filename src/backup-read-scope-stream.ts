import {createHash} from 'node:crypto'
import type {ServerResponse} from 'node:http'
import {finished} from 'node:stream/promises'
import {backupReadAuthorityStamp,backupReadFingerprintStart,backupReadGrant,BACKUP_READ_SCOPE_STREAM_TYPE,type BackupReadScopeArgs} from './backup-read-scope.js'

/** Negotiated v2 only. Each JSON grant is complete; no page-sized grant bag or
 * response string is constructed. A single large grant still needs JSON RAM.
 * The terminal frame is provisional until the authority fence and HTTP EOF. */
export async function streamBackupReadScope(res:ServerResponse,args:BackupReadScopeArgs,check:()=>void,expected?:unknown,expectedAuthority?:unknown):Promise<void>{
 const terminal=finished(res,{cleanup:true}).then(()=>undefined,error=>error as unknown)
 try{
 const authorityStamp=backupReadAuthorityStamp(args)
 if(expectedAuthority!==undefined&&expectedAuthority!==authorityStamp)throw Error('Backup permissions changed. Restart the operation.')
 const fingerprint=backupReadFingerprintStart(args),transcript=createHash('sha256')
 const write=async(raw:string,hashed=true)=>{
  const bytes=Buffer.from(raw,'utf8')
  if(hashed)transcript.update(bytes)
  for(let offset=0;offset<bytes.length;offset+=65536){
   check()
   if(res.destroyed)throw Error('Backup read response closed')
   await new Promise<void>((resolve,reject)=>{
    const onClose=()=>{cleanup();reject(Error('Backup read response closed'))}
    const onError=(error:Error)=>{cleanup();reject(error)}
    const cleanup=()=>{res.off('close',onClose);res.off('error',onError)}
    res.once('close',onClose);res.once('error',onError)
    try{res.write(bytes.subarray(offset,offset+65536),error=>{cleanup();error?reject(error):resolve()})}catch(error){cleanup();reject(error)}
   })
   check()
  }
 }
 check()
 res.writeHead(200,{'Content-Type':BACKUP_READ_SCOPE_STREAM_TYPE,'Cache-Control':'no-store','Vary':'Accept'})
 await write(JSON.stringify({type:'header',version:2,teamId:args.teamId,memberId:args.memberId,authorityStamp,count:args.targets.length})+'\n')
 for(let index=0;index<args.targets.length;index++){
  check()
  const grant=JSON.stringify(backupReadGrant(args,args.targets[index]!))
  fingerprint.update((index?',':'')+grant)
  await write('{"type":"grant","index":'+index+',"grant":'+grant+'}\n')
 }
 const digest=fingerprint.update(']}').digest('hex')
 if(expected!==undefined&&expected!==digest)throw Error('Backup permissions changed. Restart the operation.')
 check()
 await write(JSON.stringify({type:'commit',version:2,count:args.targets.length,fingerprint:digest,authorityStamp,digest:transcript.digest('hex')})+'\n',false)
 check()
 res.end()
 const endError=await terminal
 if(endError!==undefined)throw endError
 }catch(error){
  let closeFailure:unknown
  try{res.destroy(error instanceof Error?error:Error('Backup read stream failed'))}catch(cleanup){closeFailure=cleanup}
  const endError=closeFailure===undefined?await terminal:undefined
  const failures=[error]
  if(closeFailure!==undefined)failures.push(closeFailure)
  if(endError!==undefined&&endError!==error)failures.push(endError)
  if(failures.length>1)throw new AggregateError(failures,'Backup read stream and close failed')
  throw error
 }
}
