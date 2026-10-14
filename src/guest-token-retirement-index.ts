/** An independent negative-authority checkpoint. Losing a legacy per-token
 * file must not make a permanently retired guest URL available again. */
import {DatabaseSync} from 'node:sqlite'
import {constants,existsSync,lstatSync,mkdirSync,openSync,closeSync,fsyncSync,opendirSync,readFileSync,type Stats} from 'node:fs'
import {join,dirname,basename} from 'node:path'
import {decryptJsonFile,encryptJsonFile,type AtRestKey} from './at-rest.js'
import {independentCheckpointPaths,retainIndependentCheckpoint} from './independent-authority.js'

export class GuestTokenRetirementIndex {
 private db:DatabaseSync
 private path:string
 private inode:Stats
 constructor(directory:string,key:AtRestKey|null){
  this.path=join(directory,'retired.sqlite')
  const authority=dirname(directory),checkpoint=basename(directory)+'/retired.sqlite'
  const required=independentCheckpointPaths(authority).includes(checkpoint),existing=existsSync(this.path)
  if(required&&!existing)throw Error('Retired guest authorization is missing')
  mkdirSync(directory,{recursive:true,mode:0o700})
  const dirStat=lstatSync(directory)
  if(dirStat.isSymbolicLink()||!dirStat.isDirectory())throw Error('Unsafe retired guest authorization folder')
  // Commit the requirement before creating the checkpoint; interruption can
  // refuse recovery, but can never create a fresh empty authorization store.
  retainIndependentCheckpoint(authority,checkpoint)
  if(!existing){const fd=openSync(this.path,constants.O_CREAT|constants.O_EXCL|constants.O_RDWR|constants.O_NOFOLLOW,0o600);closeSync(fd)}
  this.inode=lstatSync(this.path)
  if(!this.inode.isFile()||this.inode.isSymbolicLink()||this.inode.nlink!==1)throw Error('Unsafe retired guest authorization file')
  this.db=new DatabaseSync(this.path)
  try{
   if(existing){
    if(Object.values(this.db.prepare('PRAGMA quick_check').get()??{})[0]!=='ok')throw Error('Retired guest authorization is corrupt')
    const metadata=this.db.prepare('SELECT body FROM metadata').get()
    if(decryptJsonFile<{version:number}|null>(key,String(metadata?.body??''),null)?.version!==1)throw Error('Retired guest authorization is incomplete')
   }else{
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE; CREATE TABLE retired(token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64)) STRICT; CREATE TABLE metadata(body TEXT NOT NULL) STRICT;')
    const insert=this.db.prepare('INSERT INTO retired VALUES (?)')
    const buckets=opendirSync(directory)
    try{let bucket;while((bucket=buckets.readSync())){
     if(!/^[0-9a-f]{2}$/.test(bucket.name))continue
     const bucketPath=join(directory,bucket.name)
     if(!bucket.isDirectory()||lstatSync(bucketPath).isSymbolicLink())throw Error('Unsafe retired guest history')
     const files=opendirSync(bucketPath)
     try{let file,count=0;while((file=files.readSync())){
      if(file.name.endsWith('.tmp'))continue
      if(++count>1024)throw Error('Retired guest history bucket is full')
      const hash=file.name.replace(/\.json$/,'')
      if(!/^[0-9a-f]{64}\.json$/.test(file.name)||!hash.startsWith(bucket.name)||!file.isFile())throw Error('Invalid retired guest history')
      const path=join(bucketPath,file.name),stat=lstatSync(path)
      if(stat.isSymbolicLink()||stat.nlink!==1||stat.size>4096)throw Error('Unsafe retired guest history')
      const record=decryptJsonFile<{version:number;tokenHash:string}|null>(key,readFileSync(path,'utf8'),null)
      if(record?.version!==1||record.tokenHash!==hash)throw Error('Unreadable retired guest history')
      insert.run(hash)
     }}finally{files.closeSync()}
    }}finally{buckets.closeSync()}
    const body=key?encryptJsonFile(key,{version:1}):JSON.stringify({version:1})
    this.db.prepare('INSERT INTO metadata VALUES (?)').run(body)
    this.db.exec('COMMIT')
    if(process.platform!=='win32'){for(const path of [directory,authority]){const fd=openSync(path,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}}
   }
   this.db.exec('PRAGMA synchronous=EXTRA')
  }catch(error){this.db.close();throw error}
 }
 private assertCurrent(){const stat=lstatSync(this.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.dev!==this.inode.dev||stat.ino!==this.inode.ino)throw Error('Retired guest authorization changed')}
 has(hash:string){this.assertCurrent();return Boolean(this.db.prepare('SELECT 1 FROM retired WHERE token_hash=?').get(hash))}
 retain(hash:string){
  this.assertCurrent();this.db.exec('BEGIN IMMEDIATE')
  try{
   if(!this.db.prepare('SELECT 1 FROM retired WHERE token_hash=?').get(hash)){
    const prefix=hash.slice(0,2)
    if(Number(this.db.prepare('SELECT COUNT(*) AS count FROM retired WHERE token_hash BETWEEN ? AND ?').get(prefix+'0'.repeat(62),prefix+'f'.repeat(62))?.count)>=1024)throw Error('Retired guest history bucket is full')
    this.db.prepare('INSERT INTO retired VALUES (?)').run(hash)
   }
   this.db.exec('COMMIT')
  }catch(error){this.db.exec('ROLLBACK');throw error}
 }
 close(){this.db.close()}
}
