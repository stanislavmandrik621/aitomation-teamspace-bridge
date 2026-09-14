import type {ModulePersonReference} from './record-teamwork-types.js'
const key=(p:ModulePersonReference)=>p.kind==='member'?`member:${p.teamId}:${p.id}`:`agent:${p.id}`
export function teamworkHandoffPeople(current:readonly ModulePersonReference[],to:ModulePersonReference,multiple:boolean,initiator?:{id:string;teamId:string}):ModulePersonReference|ModulePersonReference[]{
 if(!multiple)return to
 const destination=key(to),seen=new Set<string>()
 const retained=current.filter(person=> !(initiator&&person.kind==='member'&&person.teamId===initiator.teamId&&person.id===initiator.id)&&key(person)!==destination)
 const result=[...retained,to].filter(person=>{const id=key(person);if(seen.has(id))return false;seen.add(id);return true})
 if(result.length>50)throw new Error('This Person field accepts at most 50 assignees. Remove an assignee before adding another.')
 return result
}
/** Human projection only; local agent IDs, names and arbitrary record text never enter this index. */
export function teamworkSharedPeople(raw:unknown):ModulePersonReference[]{
 if(typeof raw==='string'){try{raw=JSON.parse(raw)}catch{return []}}
 const values=Array.isArray(raw)?raw:raw==null?[]:[raw],seen=new Set<string>()
 return values.filter((value):value is Extract<ModulePersonReference,{kind:'member'}>=>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false
  const p=value as Record<string,unknown>
  if(p.kind!=='member'||typeof p.id!=='string'||!p.id||p.id.length>128||typeof p.teamId!=='string'||!p.teamId||p.teamId.length>128||typeof p.label!=='string'||p.label.length>256)return false
  const id=`${p.teamId}:${p.id}`;if(seen.has(id))return false;seen.add(id);return true
 }).map(({id,label,teamId})=>({id,label,teamId,kind:'member'}))
}
