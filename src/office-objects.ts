import { retainIndependentCheckpoint } from './independent-authority.js'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { decryptJsonFile, encryptJsonFile, type AtRestKey } from './at-rest.js'

export type OfficeObjectKind = 'department' | 'floor' | 'room'
export type OfficeObjectShape = { kind: OfficeObjectKind; id: string; name: string; parentId?: string | null; floorId?: string; departmentId?: string | null; x?: number; y?: number; w?: number; h?: number; type?: string; order?: number }
export type OfficeObjectPerson = { id: string; label: string; kind: 'member'; teamId: string }
export type SharedOfficeObject = {
  teamId: string; sourceId: string; kind: OfficeObjectKind; version: number; deleted: boolean;
  shape: OfficeObjectShape; parents: OfficeObjectShape[];
  responsibilitiesText: string; leads: OfficeObjectPerson[]; backups: OfficeObjectPerson[]; members: OfficeObjectPerson[];
  updatedAt: number; updatedBy: string
}
export type OfficeObjectCommand = { teamId: string; commandId: string; expectedVersion: number; object: Omit<SharedOfficeObject, 'teamId' | 'version' | 'updatedAt' | 'updatedBy'> }
type State = { schema: 1; revision: number; objects: SharedOfficeObject[]; history: SharedOfficeObject[]; receipts: { memberId: string; commandId: string; digest: string; object: SharedOfficeObject }[] }
export class OfficeObjectError extends Error { constructor(public status: number, message: string) { super(message) } }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !['constructor','prototype','__proto__'].includes(value)
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
function cleanupObject(object:SharedOfficeObject):SharedOfficeObject {
  const clean=(value:OfficeObjectShape):OfficeObjectShape=>({kind:value.kind,id:value.id,name:'Unavailable',
    ...(value.kind==='department'?{parentId:value.parentId??null}:value.kind==='floor'?{order:0}:
      {floorId:value.floorId,departmentId:value.departmentId??null,x:0,y:0,w:300,h:200,type:'office'})})
  return {...object,shape:clean(object.shape),parents:object.parents.map(clean),responsibilitiesText:'',leads:[],backups:[],members:[]}
}
function shape(value: OfficeObjectShape): OfficeObjectShape {
  if (!value || !['department','floor','room'].includes(value.kind) || !validId(value.id) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256) throw new OfficeObjectError(400,'Invalid existing Office object')
  const result: OfficeObjectShape = {kind:value.kind,id:value.id,name:value.name}
  if (value.kind === 'department') { if (value.parentId != null && !validId(value.parentId)) throw new OfficeObjectError(400,'Invalid parent department'); result.parentId = value.parentId ?? null }
  if (value.kind === 'floor') { if (!Number.isSafeInteger(value.order ?? 0)) throw new OfficeObjectError(400,'Invalid floor order'); result.order = value.order ?? 0 }
  if (value.kind === 'room') {
    if (!validId(value.floorId) || (value.departmentId != null && !validId(value.departmentId))) throw new OfficeObjectError(400,'Invalid room parents')
    result.floorId=value.floorId; result.departmentId=value.departmentId ?? null
    for (const key of ['x','y','w','h'] as const) { const n=value[key]; if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n)>1_000_000 || ((key==='w'||key==='h')&&n<1)) throw new OfficeObjectError(400,'Invalid room geometry'); result[key]=n }
    if (typeof value.type!=='string' || !/^[a-z_-]{1,50}$/.test(value.type)) throw new OfficeObjectError(400,'Invalid room type'); result.type=value.type
  }
  return result
}
/** Canonical IDs are explicit source IDs. Parent snapshots never carry people or private configuration. */
export class OfficeObjectStore {
  private state: State
  private file: string
  backupRevision(): number { return this.state.revision }
  backupCreator(kind:string,id:string):string|null { return this.state.history.find(row=>row.kind===kind&&row.sourceId===id)?.updatedBy??null }
  backupObject(actor:{memberId:string;role:string}, kind:string, id:string):SharedOfficeObject|null {
    this.authority(actor,this.teamId())
    const object=this.state.objects.find(row=>row.kind===kind&&row.sourceId===id&&!row.deleted)
    return object?clone(object):null
  }
  constructor(private directory: string, private key: AtRestKey | null, private teamId: () => string, private member: (id: string) => {memberId:string;displayName:string;role:string} | null) {
    mkdirSync(directory,{recursive:true}); this.file=join(directory,'office-objects.json')
    this.state=existsSync(this.file)?decryptJsonFile<State>(key,readFileSync(this.file,'utf8'),null as never):{schema:1,revision:0,objects:[],history:[],receipts:[]}
    if (!this.state || this.state.schema!==1 || !Number.isSafeInteger(this.state.revision) || !Array.isArray(this.state.objects)||!Array.isArray(this.state.history)||!Array.isArray(this.state.receipts)) throw new Error('Office object storage is invalid; refusing to replace it')
  }
  private authority(actor: {memberId:string;role:string}, teamId: string, write=false) {
    const current=this.member(actor.memberId)
    if (!current || teamId!==this.teamId()) throw new OfficeObjectError(403,'This team is unavailable')
    if (write && current.role.toLowerCase()!=='admin') throw new OfficeObjectError(403,'Only an Admin can change shared Office objects')
    return current
  }
  receipt(actor:{memberId:string;role:string},teamId:string,commandId:string) { this.authority(actor,teamId);return clone(this.state.receipts.find(row=>row.memberId===actor.memberId&&row.commandId===commandId)?.object??null) }
  hasDepartment(teamId:string,id:string):boolean { return teamId===this.teamId() && this.state.objects.some(row=>row.teamId===teamId&&row.kind==='department'&&row.sourceId===id&&!row.deleted) }
  list(actor:{memberId:string;role:string}, teamId:string, offset=0,limit=100, revision?:number) {
    this.authority(actor,teamId)
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200) throw new OfficeObjectError(400,'Invalid Office page')
    if (revision!==undefined && revision!==this.state.revision) throw new OfficeObjectError(409,'The Office changed; restart the snapshot')
    const objects=this.state.objects.slice().sort((a,b)=>`${a.kind}:${a.sourceId}`.localeCompare(`${b.kind}:${b.sourceId}`))
    return clone({teamId,actor:{memberId:actor.memberId,canEdit:this.member(actor.memberId)?.role.toLowerCase()==='admin'},revision:this.state.revision,objects:objects.slice(offset,offset+limit).map(object=>object.deleted?cleanupObject(object):object),total:objects.length,hasMore:offset+limit<objects.length})
  }
  history(actor:{memberId:string;role:string},teamId:string,kind:string,id:string,offset=0,limit=50) {
    this.authority(actor,teamId)
    if(!this.state.objects.some(row=>row.kind===kind&&row.sourceId===id&&!row.deleted))throw new OfficeObjectError(404,'Office object not available')
    if (!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>200) throw new OfficeObjectError(400,'Invalid history page')
    const entries=this.state.history.filter(row=>row.kind===kind&&row.sourceId===id).reverse()
    return clone({entries:entries.slice(offset,offset+limit),total:entries.length,hasMore:offset+limit<entries.length})
  }
  command(raw: OfficeObjectCommand,actor:{memberId:string;role:string}): SharedOfficeObject {
    if (!raw || !validId(raw.teamId)||!validId(raw.commandId)||!Number.isSafeInteger(raw.expectedVersion)||raw.expectedVersion<0) throw new OfficeObjectError(400,'Invalid Office command')
    this.authority(actor,raw.teamId,true)
    const digest=createHash('sha256').update(JSON.stringify(raw)).digest('hex')
    const receipt=this.state.receipts.find(row=>row.memberId===actor.memberId&&row.commandId===raw.commandId)
    if (receipt) { if(receipt.digest!==digest) throw new OfficeObjectError(409,'This command ID was already used'); return clone(receipt.object) }
    const object=raw.object
    if(!object||!validId(object.sourceId)||object.shape?.id!==object.sourceId||object.shape.kind!==object.kind||typeof object.deleted!=='boolean'||typeof object.responsibilitiesText!=='string'||object.responsibilitiesText.length>20_000||!Array.isArray(object.parents)||object.parents.length>64) throw new OfficeObjectError(400,'Invalid shared Office object')
    const prior=this.state.objects.find(row=>row.sourceId===object.sourceId&&row.kind===object.kind)
    if((prior?.version??0)!==raw.expectedVersion) throw new OfficeObjectError(409,'This Office object changed. Load its latest version before saving')
    const safeShape=shape(object.shape), parents=object.parents.map(shape)
    const seen=new Set([`${safeShape.kind}:${safeShape.id}`]); for(const parent of parents){const key=`${parent.kind}:${parent.id}`;if(seen.has(key)||parent.kind==='room')throw new OfficeObjectError(400,'Invalid Office parent hierarchy');seen.add(key)}
    const needed=(row:OfficeObjectShape):string[]=>row.kind==='room'?[`floor:${row.floorId}`,...(row.departmentId?[`department:${row.departmentId}`]:[])]:row.kind==='department'&&row.parentId?[`department:${row.parentId}`]:[]
    const reachable=new Set<string>(); const visit=(row:OfficeObjectShape,path:Set<string>)=>{const key=`${row.kind}:${row.id}`;if(path.has(key))throw new OfficeObjectError(400,'Office parent cycle'); const next=new Set(path).add(key);for(const parentKey of needed(row)){const parent=parents.find(p=>`${p.kind}:${p.id}`===parentKey);if(!parent)throw new OfficeObjectError(400,'The required Office parent is missing');reachable.add(parentKey);visit(parent,next)}};visit(safeShape,new Set())
    if(reachable.size!==parents.length)throw new OfficeObjectError(400,'Unrelated Office objects cannot be included')
    const people=(rawPeople:OfficeObjectPerson[],group:'leads'|'backups'|'members')=>{
      if(!Array.isArray(rawPeople)||rawPeople.length>100)throw new OfficeObjectError(400,'Invalid Office people')
      const ids=new Set<string>()
      return rawPeople.map(person=>{if(!person||person.kind!=='member'||person.teamId!==raw.teamId||typeof person.id!=='string'||person.id.length>256||ids.has(person.id))throw new OfficeObjectError(400,'Only members of this team can be shared');ids.add(person.id);const live=this.member(person.id);if(live)return{id:live.memberId,label:live.displayName,kind:'member' as const,teamId:raw.teamId};const old=prior?.[group].find(p=>p.id===person.id);if(old&&JSON.stringify(old)===JSON.stringify(person))return old;throw new OfficeObjectError(409,'A selected teammate is no longer available')})
    }
    if(object.deleted && this.state.objects.some(row=>!row.deleted&&row.sourceId!==object.sourceId&&row.parents.some(parent=>parent.kind===object.kind&&parent.id===object.sourceId)))throw new OfficeObjectError(409,'Unshare dependent Office objects before removing their parent')
    const next:SharedOfficeObject={teamId:raw.teamId,sourceId:object.sourceId,kind:object.kind,version:(prior?.version??0)+1,deleted:object.deleted,shape:safeShape,parents,responsibilitiesText:object.responsibilitiesText,leads:people(object.leads,'leads'),backups:people(object.backups,'backups'),members:people(object.members,'members'),updatedAt:Date.now(),updatedBy:actor.memberId}
    const state=clone(this.state);state.revision++;state.objects=state.objects.filter(row=>!(row.kind===next.kind&&row.sourceId===next.sourceId));state.objects.push(next);state.history.push(next);state.receipts.push({memberId:actor.memberId,commandId:raw.commandId,digest,object:next})
    try { this.persist(state) } catch (error) { if(existsSync(this.file)) this.state=decryptJsonFile<State>(this.key,readFileSync(this.file,'utf8'),null as never); throw error };this.state=state;return clone(next)
  }
  private persist(state:State) {
    retainIndependentCheckpoint(this.directory,'office-objects.json')
    const temporary=`${this.file}.${randomUUID()}.tmp`
    try {writeFileSync(temporary,this.key?encryptJsonFile(this.key,state):JSON.stringify(state),{flag:'wx',mode:0o600});const fd=openSync(temporary,'r');try{fsyncSync(fd)}finally{closeSync(fd)};renameSync(temporary,this.file);const dir=openSync(this.directory,'r');try{fsyncSync(dir)}finally{closeSync(dir)}} catch(error){try{unlinkSync(temporary)}catch{};throw error}
  }
}
