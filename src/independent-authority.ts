/** Authorization is live state, never part of a restorable data snapshot. */
import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

const marker = '.authorization-binding.json'
type Binding = { version: 1; id: string; established?: true; checkpoints?: 1; required?: string[] }
const checkpointFiles=['content-access.json','content-access.initialized','content-access.sqlite','team-field-acl.json','team-field-acl.initialized',
  'record-tree.initialized','record-tree/content-access.sqlite','record-teamwork.initialized','record-teamwork/content-access.sqlite']
function read(path: string): Binding {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65_536) throw new Error('Invalid authorization binding')
  const value = JSON.parse(readFileSync(path, 'utf8')) as Binding
  if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id)||(value.established!==undefined&&value.established!==true)||(value.checkpoints!==undefined&&value.checkpoints!==1)) throw new Error('Invalid authorization binding')
  if(value.required!==undefined&&(!Array.isArray(value.required)||value.required.length>512||value.required.some(path=>typeof path!=='string'||!safeCheckpoint(path))))throw new Error('Invalid authorization checkpoint inventory')
  return value
}
function safeCheckpoint(path:string){return path.length<=160&&/^[a-z0-9._/-]+$/.test(path)&&!path.startsWith('/')&&!path.split('/').some(part=>!part||part==='.'||part==='..')}
export function independentCheckpointPaths(directory:string):readonly string[]{
  const path=join(directory,marker)
  if(!existsSync(path))return []
  const binding=read(path)
  return [...new Set([...(binding.required??[]),...(binding.established?['team.json','members.json']:[]),...(binding.checkpoints?checkpointFiles:[])])]
}
/** Register a store before its first durable write. Losing its data AND its
 * own local marker must never turn a previously used store into a fresh one.
 * Old standalone unit stores have no independent binding and keep their API. */
export function retainIndependentCheckpoint(directory:string,path:string):void {
  const bindingPath=join(directory,marker)
  if(!existsSync(bindingPath))return
  if(!safeCheckpoint(path))throw new Error('Invalid authorization checkpoint path')
  const binding=read(bindingPath),required=binding.required??[]
  if(required.includes(path))return
  if(required.length>=512)throw new Error('Authorization checkpoint inventory is full')
  save(bindingPath,{...binding,required:[...required,path].sort()})
}
function save(path: string, value: Binding) {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, path)
    const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir) } finally { closeSync(dir) }
  } finally { if(existsSync(tmp))rmSync(tmp) }
}
function directory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error('Authorization folders must be real, independent directories')
}
function nested(a:string,b:string){const path=relative(a,b);return !path||path!=='..'&&!path.startsWith(`..${sep}`)&&!isAbsolute(path)}
function requireFiles(authority:string,names:readonly string[]){
  for(const name of names){
    let path=authority
    const parts=name.split('/')
    for(const [index,part] of parts.entries()){
      path=join(path,part)
      if(!existsSync(path))throw new Error('Retained authorization is incomplete; restore its current checkpoints before starting')
      const stat=lstatSync(path)
      if(stat.isSymbolicLink()||(index===parts.length-1?(!stat.isFile()||stat.nlink!==1||stat.size===0):!stat.isDirectory()))throw new Error('Retained authorization is incomplete or unsafe')
    }
  }
}
/** Fresh installs initialize once. Existing data without its independent
 * authority is never silently promoted to current permissions. Operators must
 * supply the retained authority volume, or explicitly reconcile an old install.
 * Neither missing bindings nor foreign bindings cause deletion or replacement. */
export function openIndependentAuthority(dataDirectory: string, authorityDirectory: string): string {
  directory(dataDirectory); directory(authorityDirectory)
  const data = realpathSync(dataDirectory), authority = realpathSync(authorityDirectory)
  if (nested(data, authority) || nested(authority, data)) throw new Error('Authorization storage must be outside the data backup directory')
  directory(data); directory(authority)
  const dataMarker = join(data, marker), authorityMarker = join(authority, marker)
  if (existsSync(dataMarker) && existsSync(authorityMarker)) {
    const current=read(authorityMarker)
    if (read(dataMarker).id !== current.id) throw new Error('The retained authorization belongs to another server')
    if(current.established)requireFiles(authority,['team.json','members.json'])
    if(current.checkpoints)requireFiles(authority,checkpointFiles)
    if(current.required)requireFiles(authority,current.required)
    return authority
  }
  // Authority is committed first. A data binding without its authority can
  // never be an interrupted first initialization, even if data has no records.
  if(existsSync(dataMarker))throw new Error('The independent authorization volume is missing. Original data was kept; reconnect the retained volume.')
  // A crash between the two initial marker commits can be resumed only while
  // both folders are still empty of server state.
  const empty = (path: string) => readdirSync(path).every(name => name === marker || name.startsWith('.bridge.') || name.endsWith('.tmp'))
  if (!empty(data) || !empty(authority)) throw new Error('Retained authorization is missing. Keep this server isolated and restore its independent authorization volume; existing data was not changed.')
  const binding = existsSync(dataMarker) ? read(dataMarker) : existsSync(authorityMarker) ? read(authorityMarker) : { version: 1 as const, id: randomUUID() }
  if (!existsSync(authorityMarker)) save(authorityMarker, binding)
  if (!existsSync(dataMarker)) save(dataMarker, binding)
  return authority
}

/** Persist before the first roster acknowledgement. Losing identity files
 * later must not reopen unauthenticated first-admin bootstrap. */
export function establishIndependentAuthority(authorityDirectory:string):void {
  const path=join(authorityDirectory,marker),binding=read(path)
  if(!binding.established)save(path,{...binding,established:true})
}
/** Record successful initialization separately from the roster. Losing both
 * an ACL database and its old local marker must not rebuild grants from an old
 * operation archive. Legacy migration initializes these once, while isolated. */
export function protectIndependentCheckpoints(authorityDirectory:string):void {
  requireFiles(authorityDirectory,checkpointFiles)
  const path=join(authorityDirectory,marker),binding=read(path)
  if(!binding.checkpoints)save(path,{...binding,checkpoints:1})
}

/** Explicit, stopped-server upgrade of a known-current legacy installation.
 * This is never invoked by normal startup or by a restore request. Keep every
 * source byte; commit the copied authority before binding the data directory. */
export function initializeCurrentAuthority(dataDirectory:string,authorityDirectory:string):void {
  directory(dataDirectory);directory(authorityDirectory)
  const data=realpathSync(dataDirectory),authority=realpathSync(authorityDirectory)
  if(nested(data,authority)||nested(authority,data))throw new Error('Authorization storage must be independent')
  if(existsSync(join(data,marker))||existsSync(join(authority,marker)))throw new Error('This server already has an authorization binding; use its retained volume')
  if(!existsSync(join(data,'team.json'))||!existsSync(join(data,'members.json')))throw new Error('A current legacy team and roster are required')
  if(readdirSync(authority).some(name=>!name.startsWith('.bridge.')))throw new Error('The destination authority directory must be empty')
  const names=new Set(['team.json','members.json','invites.json','invite-redemption.pending.json','revoked-sessions.json','admin-recovery.key',
    'content-access.json','content-access.initialized','content-access.sqlite','content-access.sqlite-wal','content-access.sqlite-shm',
    'team-field-acl.json','team-field-acl.initialized','record-tree','record-tree.initialized','record-teamwork','record-teamwork.initialized',
    'compose-live-acl.json','compose-live-acl.initialized','office-objects.json','workspace-work.json','workspace-coordinator-monitor.json',
    'team-member-profiles','public-shares.json','public-share-retired-tokens','public-share-payloads','public-share-submissions','share-submission-receipts',
    'compose-shares.json','compose-share-retired-tokens','compose-share-payloads','portals.json','portal-retired-tokens','portal-payloads','portal-submissions','portal-submission-receipts','portal-otp-pending'])
  const staging=join(authority,`.migration-${randomUUID()}`);mkdirSync(staging,{mode:0o700})
  const copy=(source:string,dest:string)=>{
    const stat=lstatSync(source)
    if(stat.isSymbolicLink()||!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))throw new Error('Unsafe legacy authority path; source was kept')
    if(stat.isDirectory()){
      mkdirSync(dest,{mode:0o700});for(const name of readdirSync(source))copy(join(source,name),join(dest,name))
      const fd=openSync(dest,'r');try{fsyncSync(fd)}finally{closeSync(fd)}
    }else{copyFileSync(source,dest);chmodSync(dest,0o600);const fd=openSync(dest,'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
  }
  try{
    for(const name of names)if(existsSync(join(data,name)))copy(join(data,name),join(staging,name))
    if(existsSync(join(data,'chat','rooms.json'))){mkdirSync(join(staging,'chat'),{mode:0o700});copy(join(data,'chat','rooms.json'),join(staging,'chat','rooms.json'));const fd=openSync(join(staging,'chat'),'r');try{fsyncSync(fd)}finally{closeSync(fd)}}
    for(const name of readdirSync(staging))renameSync(join(staging,name),join(authority,name))
    const required=[...names,'chat/rooms.json'].filter(name=>existsSync(join(authority,name))&&lstatSync(join(authority,name)).isFile()&&!name.endsWith('-wal')&&!name.endsWith('-shm'))
    const binding={version:1 as const,id:randomUUID(),established:true as const,required};save(join(authority,marker),binding);save(join(data,marker),binding)
  }finally{rmSync(staging,{recursive:true,force:true})}
}
