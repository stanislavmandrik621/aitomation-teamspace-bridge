import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, type BigIntStats } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

export type BackupManifestReceiptWave103P05 = { dev: string; ino: string; size: string; mtime: string; ctime: string; sha256: string } | undefined
const changed = () => Error('Retained backup manifest or temporary checkpoint changed; foreign contents were retained.')
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
function identity(s: BigIntStats) {
  if (!s.isFile() || s.nlink !== 1n || s.size > 8192n) throw changed()
  return {dev:String(s.dev),ino:String(s.ino),size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs)}
}
export function observeBackupManifestWave103P05(path: string): BackupManifestReceiptWave103P05 {
  let fd: number
  try { fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW) }
  catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e }
  try {
    const before=identity(fstatSync(fd,{bigint:true})), bytes=readFileSync(fd)
    if(JSON.stringify(before)!==JSON.stringify(identity(fstatSync(fd,{bigint:true})))
      || JSON.stringify(before)!==JSON.stringify(identity(lstatSync(path,{bigint:true}))))throw changed()
    return {...before,sha256:digest(bytes)}
  } finally {closeSync(fd)}
}
export function assertBackupManifestWave103P05(path: string, expected: BackupManifestReceiptWave103P05): void {
  if(JSON.stringify(observeBackupManifestWave103P05(path))!==JSON.stringify(expected))throw changed()
}
/** Exclusive-create, never truncate or adopt an existing .next. Every publication
 * checks the exact observed destination and owned temporary inode/content. */
export function saveBackupManifestWave103P05(path: string, value: unknown, expected: BackupManifestReceiptWave103P05): BackupManifestReceiptWave103P05 {
  const bytes=Buffer.from(JSON.stringify(value)), next=path+'.next'
  if(bytes.length>8192)throw changed()
  assertBackupManifestWave103P05(path,expected)
  const fd=openSync(next,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600)
  try {
    const empty={...identity(fstatSync(fd,{bigint:true})),sha256:digest(Buffer.alloc(0))}
    assertBackupManifestWave103P05(path,expected)
    assertBackupManifestWave103P05(next,empty)
    writeFileSync(fd,bytes);fsyncSync(fd)
    const written={...identity(fstatSync(fd,{bigint:true})),sha256:digest(bytes)}
    assertBackupManifestWave103P05(next,written)
    assertBackupManifestWave103P05(path,expected)
    renameSync(next,path)
    const published=observeBackupManifestWave103P05(path)
    if(!published || published.dev!==written.dev || published.ino!==written.ino || published.size!==written.size || published.sha256!==written.sha256)throw changed()
    if(process.platform!=='win32'){
      const directory=openSync(dirname(path),constants.O_RDONLY)
      try {fsyncSync(directory)}finally{closeSync(directory)}
    }
    assertBackupManifestWave103P05(path,published)
    return published
  } finally {closeSync(fd)}
}
