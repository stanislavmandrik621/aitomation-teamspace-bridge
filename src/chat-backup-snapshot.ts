import {constants,openSync,closeSync,fstatSync,lstatSync,statSync,createReadStream,createWriteStream} from 'node:fs'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {pipeline} from 'node:stream/promises'
import {MAX_BACKUP_ZIP_BYTES,type BackupZipEntry} from './backup-zip.js'

/** Keep atomic chat metadata replacements from invalidating a streaming ZIP.
 * The caller owns a private temporary directory and removes it on every exit.
 * History retains the ZIP writer's fixed append-only prefix; large files never
 * enter memory. Only mutable JSON metadata is staged before response headers.
 */
export async function snapshotChatBackupMetadata(entries:readonly BackupZipEntry[],directory:string,signal?:AbortSignal):Promise<BackupZipEntry[]>{
 const staged:BackupZipEntry[]=[]
 let bytes=0
 for(const [index,entry] of entries.entries()){
  signal?.throwIfAborted()
  if(!entry.name.startsWith('chat/')||!entry.name.endsWith('.json')){staged.push(entry);continue}
  const before=lstatSync(entry.absolutePath)
  if(!before.isFile())throw Error('Chat backup metadata must be a regular file')
  const fd=openSync(entry.absolutePath,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  let handedOff=false
  try{
   const stat=fstatSync(fd)
   if(!stat.isFile()||stat.dev!==before.dev||stat.ino!==before.ino)throw Error('Chat backup metadata changed before snapshot')
   bytes+=stat.size
   if(bytes>MAX_BACKUP_ZIP_BYTES)throw Error('Chat backup metadata exceeds export size limit')
   const target=join(directory,String(index))
   if(stat.size===0)await writeFile(target,'',{flag:'wx',mode:0o600,signal})
   else{
    const input=createReadStream(entry.absolutePath,{fd,autoClose:true,end:stat.size-1});handedOff=true
    await pipeline(input,createWriteStream(target,{flags:'wx',mode:0o600}),{signal})
   }
   if(statSync(target).size!==stat.size)throw Error('Chat backup metadata changed during snapshot')
   staged.push({...entry,absolutePath:target,size:stat.size})
  }finally{if(!handedOff)closeSync(fd)}
 }
 return staged
}
