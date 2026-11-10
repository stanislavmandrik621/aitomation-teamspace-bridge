/** Verify an already-generated immutable ZIP after process restart. The durable
 * generation checkpoint is not a checksum proof and never authorizes delivery.
 * A fresh complete SHA pass and current authorization are mandatory. */
import { createHash } from 'node:crypto'
import { fstatSync, lstatSync } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
export type GeneratedBackupStampWave101={size:number;dev:string;ino:string;mtime:string;ctime:string}
const changed=()=>Error('The completed backup generation changed. Original files were retained.')
export async function verifyGeneratedBackupWave101(args:{
 source:FileHandle;path:string;stamp:GeneratedBackupStampWave101;check():void;
 /** Lifecycle observation only; never an authority or checksum input. */
 progress?:(bytes:number)=>void;
}):Promise<string>{
 const s=args.stamp
 if(!Number.isSafeInteger(s.size)||s.size<=0||![s.dev,s.ino,s.mtime,s.ctime].every(v=>typeof v==='string'&&/^\d+$/.test(v)))throw changed()
 const check=()=>{
  args.check()
  for(const now of [fstatSync(args.source.fd,{bigint:true}),lstatSync(args.path,{bigint:true})]){
   if(!now.isFile()||now.nlink!==1n||String(now.dev)!==s.dev||String(now.ino)!==s.ino||now.size!==BigInt(s.size)||String(now.mtimeNs)!==s.mtime||String(now.ctimeNs)!==s.ctime)throw changed()
  }
 }
 check();const buffer=Buffer.alloc(64*1024),hash=createHash('sha256')
 try{
  for(let at=0;at<s.size;){
   check();const result=await args.source.read(buffer,0,Math.min(buffer.length,s.size-at),at);check()
   if(!result.bytesRead)throw changed();hash.update(buffer.subarray(0,result.bytesRead));at+=result.bytesRead
   args.progress?.(at);check()
  }
  check();return hash.digest('hex')
 }finally{buffer.fill(0)}
}
