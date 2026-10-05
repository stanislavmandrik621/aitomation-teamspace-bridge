import {createHash,randomBytes} from 'node:crypto'
import {mkdirSync,readFileSync,statSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync} from 'node:fs'
import {join} from 'node:path'
import {decryptJsonFile,encryptJsonFile,type AtRestKey} from './at-rest.js'
export type ProfileFields={firstName:string;lastName:string;middleName:string;preferredName:string;title:string;responsibilities:string;skills:string[];languages:string[];availability:string;timezone:string;workHours:string}
export type Profile=ProfileFields & {version:number;updatedAt:number|null;updatedBy:string|null}
type Entry=Profile & {commandId:string;fingerprint:string}
type Disk={schemaVersion:1;teamId:string;memberId:string;entries:Entry[]}
type Member={memberId:string;displayName:string;role:string}
export class MemberProfileError extends Error {constructor(public status:number,message:string){super(message)}}
function fail(status:number,message:string):never {throw new MemberProfileError(status,message)}
export function profileId(value:unknown):string {if(typeof value!=='string'||!/^(?:device:)?[A-Za-z0-9_-]{1,128}$/.test(value))fail(400,'Invalid team or member identifier');return value}
function bag(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Invalid profile');return value as Record<string,unknown>}
function text(value:unknown,max:number):string {if(typeof value!=='string'||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(400,'Invalid or overlong profile text');return value.trim()}
function list(value:unknown,max:number):string[]{if(!Array.isArray(value)||value.length>max)fail(400,'Too many profile entries');const rows=value.map(v=>text(v,128));if(rows.some(v=>!v)||new Set(rows).size!==rows.length)fail(400,'Profile entries must be distinct and nonempty');return rows}
export function parseProfileFields(value:unknown):ProfileFields {const p=bag(value);return{firstName:text(p.firstName??'',200),lastName:text(p.lastName??'',200),middleName:text(p.middleName??'',200),preferredName:text(p.preferredName??'',200),title:text(p.title,200),responsibilities:text(p.responsibilities,4000),skills:list(p.skills,50),languages:list(p.languages,30),availability:text(p.availability,500),timezone:text(p.timezone,100),workHours:text(p.workHours,1000)}}
const empty=():Profile=>({firstName:'',lastName:'',middleName:'',preferredName:'',title:'',responsibilities:'',skills:[],languages:[],availability:'',timezone:'',workHours:'',version:0,updatedAt:null,updatedBy:null})
const publicEntry=(entry:Profile):Profile=>({...parseProfileFields(entry),version:entry.version,updatedAt:entry.updatedAt,updatedBy:entry.updatedBy})
/** One atomic encrypted file per exact team/member; immutable version history and command receipts share the commit. */
export class TeamMemberProfileStore {
 private dir:string;private uncertain=new Set<string>()
 constructor(dir:string,private key:AtRestKey|null,private findMember:(id:string)=>Member|null){this.dir=join(dir,'team-member-profiles');mkdirSync(this.dir,{recursive:true,mode:0o700})}
 private path(teamId:string,memberId:string){return join(this.dir,createHash('sha256').update(teamId+'\0'+memberId).digest('hex')+'.json')}
 private readDisk(teamId:string,memberId:string):Disk{
  const path=this.path(teamId,memberId);if(this.uncertain.has(path))fail(503,'Profile storage needs a server restart after an uncertain write')
  try{
   if(statSync(path).size>32_000_000)throw new Error('Oversized profile history')
   const raw=readFileSync(path,'utf8'), disk=bag(this.key?decryptJsonFile(this.key,raw,null):JSON.parse(raw))
   if(disk.schemaVersion!==1||disk.teamId!==teamId||disk.memberId!==memberId||!Array.isArray(disk.entries)||disk.entries.length>100_000)throw new Error('Invalid profile history')
   const receipts=new Set<string>()
   disk.entries.forEach((raw,index)=>{const e=bag(raw);parseProfileFields(e);if(e.version!==index+1||!Number.isSafeInteger(e.updatedAt)||Number(e.updatedAt)<0)throw new Error('Invalid history version');profileId(e.updatedBy);profileId(e.commandId);if(typeof e.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(e.fingerprint)||receipts.has(String(e.updatedBy)+':'+e.commandId))throw new Error('Invalid receipt');receipts.add(String(e.updatedBy)+':'+e.commandId)})
   return disk as unknown as Disk
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{schemaVersion:1,teamId,memberId,entries:[]};fail(503,'Profile history is unavailable; existing data was preserved')}
 }
 private authorize(teamId:string,memberId:string,actorId:string){profileId(teamId);profileId(memberId);profileId(actorId);const actor=this.findMember(actorId),member=this.findMember(memberId);if(!actor)fail(401,'Current team membership required');if(!member)fail(404,'This person is no longer a current team member');return{actor,member,canEdit:actor.memberId===memberId||actor.role==='admin'}}
 read(teamId:string,memberId:string,actorId:string){const access=this.authorize(teamId,memberId,actorId),disk=this.readDisk(teamId,memberId);return{teamId,memberId,displayName:access.member.displayName,role:access.member.role,actorMemberId:actorId,canEdit:access.canEdit,profile:disk.entries.length?publicEntry(disk.entries.at(-1)!):empty()}}
 save(raw:unknown,actorId:string){
  const args=bag(raw);if(Object.keys(args).some(k=>!['teamId','memberId','expectedVersion','commandId','firstName','lastName','middleName','preferredName','title','responsibilities','skills','languages','availability','timezone','workHours'].includes(k)))fail(400,'Unexpected profile property')
  const teamId=profileId(args.teamId),memberId=profileId(args.memberId),commandId=profileId(args.commandId),access=this.authorize(teamId,memberId,actorId)
  if(!access.canEdit)fail(403,'Only this person or a team Admin can edit this profile')
  const fields=parseProfileFields(args),disk=this.readDisk(teamId,memberId),fingerprint=createHash('sha256').update(JSON.stringify(fields)).digest('hex')
  const prior=disk.entries.find(e=>e.commandId===commandId&&e.updatedBy===actorId)
  if(prior){if(prior.fingerprint!==fingerprint)fail(409,'This save request was already used for different profile values');return this.read(teamId,memberId,actorId)}
  if(!Number.isSafeInteger(args.expectedVersion)||args.expectedVersion!==disk.entries.length)fail(409,'This profile changed. Load the latest version before saving')
  if(disk.entries.length>=100_000)fail(409,'Profile history capacity reached; existing history is preserved')
  const next:Disk={...disk,entries:[...disk.entries,{...fields,version:disk.entries.length+1,updatedAt:Date.now(),updatedBy:actorId,commandId,fingerprint}]}
  const serialized=this.key?encryptJsonFile(this.key,next):JSON.stringify(next)
  if(Buffer.byteLength(serialized)>32_000_000)fail(409,'Profile history storage capacity reached; existing history is preserved')
  const path=this.path(teamId,memberId),temp=path+'.'+randomBytes(8).toString('hex')+'.tmp';let fd:number|undefined,renamed=false
  try{fd=openSync(temp,'wx',0o600);writeFileSync(fd,serialized);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,path);renamed=true;fd=openSync(this.dir,'r');fsyncSync(fd);closeSync(fd);fd=undefined}
  catch{if(renamed)this.uncertain.add(path);fail(503,'Profile save could not be confirmed. Your draft should be kept')}
  finally{if(fd!==undefined)closeSync(fd);try{unlinkSync(temp)}catch{}}
  return this.read(teamId,memberId,actorId)
 }
 history(teamId:string,memberId:string,actorId:string,limit=10,cursor?:string|null){
  this.authorize(teamId,memberId,actorId);if(!Number.isInteger(limit)||limit<1||limit>50)fail(400,'History page limit must be 1–50');const disk=this.readDisk(teamId,memberId);let offset=0
  if(cursor){const m=/^(\d+):(\d+)$/.exec(cursor);if(!m||!Number.isSafeInteger(Number(m[2])))fail(400,'Invalid history cursor');if(Number(m[1])!==disk.entries.length)fail(409,'Profile history changed. Refresh history');offset=Number(m[2])}
  const entries=disk.entries.slice().reverse().slice(offset,offset+limit).map(publicEntry),total=disk.entries.length,hasMore=offset+entries.length<total
  return{teamId,memberId,entries,total,hasMore,nextCursor:hasMore?total+':'+(offset+entries.length):null}
 }
}
