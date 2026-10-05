import {createHash} from 'node:crypto'
import type { RecordTeamworkActor } from './record-teamwork-types.js'
import type { BridgeStore, MemberRow } from './store.js'
import type { ModulesSyncOp } from './index.js'
import type { RecordTeamworkAuthority } from './record-teamwork-state.js'
import type { RecordTeamworkIdentity,RecordTeamworkState } from './record-teamwork-types.js'
export function resolveRecordTeamworkIdentity(store:BridgeStore,teamId:string,recordId:string,member:MemberRow):RecordTeamworkIdentity {
 const probe={kind:'record.update',targetId:recordId} as ModulesSyncOp
 const entityId=store.contentAccess.entityForOp(probe),root=store.contentAccess.itemKey(probe)
 if(!recordId||!entityId||!root.startsWith('module:')||!store.contentAccess.mayReadRecord(recordId,member.memberId,member.role))throw new Error('This record is unavailable to your team membership')
 return {teamId,moduleId:root.slice(7),entityId,recordId}
}
export function recordTeamworkAuthority(store:BridgeStore,identity:RecordTeamworkIdentity,member:MemberRow,departmentExists:(teamId:string,id:string)=>boolean):RecordTeamworkAuthority {
 const validateMember=(id:string)=>{
  const person=store.findMember(id)
  if(!person||!store.contentAccess.mayReadRecord(identity.recordId,id,person.role)||store.contentAccess.fieldSlugs(identity.entityId).some(slug=>!store.contentAccess.mayAccessRecordField(identity.recordId,slug,id,person.role)))throw new Error('A selected teammate no longer has access to this record')
 }
 const validateField=(id:string,type:string[])=>{
  const field=store.contentAccess.fieldDefinition(identity.entityId,id)
  if(!field||!type.includes(field.type??''))throw new Error('A configured field is missing or has the wrong type')
  if(!store.contentAccess.mayAccessRecordField(identity.recordId,field.slug,member.memberId,member.role,'write'))throw new Error('You cannot change the configured field')
  return field
 }
 return {actor:{id:member.memberId,name:member.displayName,kind:'member'},teamId:identity.teamId,canWrite:member.role!=='viewer',canConfigure:member.role==='admin',validateMember,
  validateConfig:config=>{
   if(config.assigneeFieldId)validateField(config.assigneeFieldId,['user'])
   if(config.statusFieldId)validateField(config.statusFieldId,['select','status','multiselect','multi_select'])
   if(config.dueFieldId)validateField(config.dueFieldId,['date','datetime'])
   if(config.departmentId&&!departmentExists(identity.teamId!,config.departmentId))throw new Error('This shared department is unavailable')
  },
  validateHandoff:(to,config)=>{
   if(to.kind!=='member'||to.teamId!==identity.teamId)throw new Error('Shared handoffs require a current teammate in this module team')
   validateMember(to.id)
   const field=validateField(config.assigneeFieldId!,['user']),person=store.findMember(to.id)!
   if(!store.contentAccess.mayAccessRecordField(identity.recordId,field.slug,to.id,person.role))throw new Error('This teammate cannot read the assignee field')
   to.label=person.displayName||person.email||person.memberId
  }}
}
export function recordTeamworkStatusKeys(store:BridgeStore,entityId:string,state:RecordTeamworkState):string[]{
 const id=state.config?.statusFieldId
 return id?[id,store.contentAccess.resolveFieldSlug(entityId,id)??id]:[]
}

/** Delegation is authenticated account activity, never proof of a particular AI run.
 * The opaque per-team/device principal reveals no local agent identifier or name. */
export function recordTeamworkAssistantActor(scopeId:string,principal:{id:string;name:string;kind:'member'|'user'},deviceId=''):RecordTeamworkActor {
 const name=principal.name.trim().slice(0,200)||(principal.kind==='member'?'Teammate':'You')
 return {id:'assistant:'+createHash('sha256').update(JSON.stringify([scopeId,principal.id,deviceId])).digest('hex'),name:`Assistant acting for ${name}`,kind:'agent',delegatedBy:{id:principal.id,name,kind:principal.kind}}
}
export function asRecordTeamworkAssistant(authority:RecordTeamworkAuthority,scopeId:string,deviceId=''):RecordTeamworkAuthority {
 if(authority.actor.kind!=='member'&&authority.actor.kind!=='user')throw new Error('A current account is required to delegate assistant work')
 return {...authority,canConfigure:false,actor:recordTeamworkAssistantActor(scopeId,{id:authority.actor.id,name:authority.actor.name,kind:authority.actor.kind},deviceId)}
}
