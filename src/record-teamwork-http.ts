import {referenceClock} from './content-reference-data.js'
import {teamworkHandoffPeople} from './record-teamwork-people.js'
import { OPS_FRAME_WINDOW_MS } from './throughput.js'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {randomUUID} from 'node:crypto'
import type {BridgeStore,MemberRow} from './store.js'
import type {ModulesSyncOp} from './index.js'
import {recordTeamworkAllowedActions,assertRecordTeamworkAssistantCommand,recordTeamworkWriteGate} from './record-teamwork-state.js'
import {recordTeamworkAuthority,asRecordTeamworkAssistant,recordTeamworkStatusKeys,resolveRecordTeamworkIdentity} from './record-teamwork-authority.js'
import type {RecordTeamworkCommand} from './record-teamwork-types.js'
type Auth={member:MemberRow;deviceId:string}
export type RecordTeamworkHttpDeps = {store:BridgeStore;teamId():string;authenticate(req:IncomingMessage):Auth|null;departmentExists(teamId:string,id:string):boolean;readBody(req:IncomingMessage,max:number,args:{reserveBytes:number;memberId:string}):Promise<unknown>;releaseBody(body:unknown):void;json(res:ServerResponse,status:number,body:unknown):void;drain(req:IncomingMessage):void;takeWrite(memberId:string):boolean;retryAfterSeconds?(memberId:string):number;publish(ops:ModulesSyncOp[]):void;requestAssignmentSnapshot?(request:{teamId:string;moduleId:string;entityId:string;recordId:string;fieldId:string}):void;fieldRefusal(op:ModulesSyncOp,member:MemberRow):string|null;canRead(op:ModulesSyncOp,member:MemberRow):boolean;assertWritable():void}
export function createRecordTeamworkHttpHandler(deps:RecordTeamworkHttpDeps){
 let lastWall=0,counter=0
 // Authoritative actions have observed the accepted cell, so their wire
 // patch must carry that causal baseline just like an ordinary client edit.
 const baseline=(recordId:string,slug:string)=>{const hlc=deps.store.contentAccess.recordCellHlc(recordId,slug);return hlc?{baseCellHlcs:{[slug]:hlc}}:{}}
 const clock=(observed?:string)=>{
  // A small accepted device clock lead must not make a later reviewed
  // action sort before the cell it just read, including after server restart.
  const base=referenceClock(observed),wall=Math.max(Date.now(),lastWall,base?.[0]??0)
  counter=Math.max(wall===lastWall?counter+1:0,base&&wall===base[0]?base[1]+1:0)
  if(!Number.isSafeInteger(counter))throw new Error('The record clock cannot advance safely; reconnect and review its latest state')
  lastWall=wall;return `${wall}:${counter}:teamwork`
 }
 return async(req:IncomingMessage,res:ServerResponse,url:URL)=>{
  const assistant=url.pathname==='/api/record-teamwork/assistant'
  const completion=url.pathname==='/api/record-teamwork/completion'
  if(!assistant&&!completion&&url.pathname!=='/api/record-teamwork')return false
  let body:unknown
  try{
   const auth=deps.authenticate(req);if(!auth)throw new Error('Current team session required')
   const teamId=deps.teamId()
   if(req.method==='POST'){
    if(!deps.takeWrite(auth.member.memberId)){res.setHeader('Retry-After',String(deps.retryAfterSeconds?.(auth.member.memberId) ?? Math.max(1,Math.ceil(OPS_FRAME_WINDOW_MS/1000))));deps.json(res,429,{ok:false,error:'Too many teamwork changes; retry shortly'});return true}
    // Notes allow 20,000 characters; UTF-8 and JSON escapes can exceed 32 KB.
    // Keep this operation bounded while admitting valid Unicode notes/config.
    body=await deps.readBody(req,512_000,{reserveBytes:512_000,memberId:auth.member.memberId})
   }else if(req.method!=='GET')throw new Error('Use GET or POST')
   const fresh=deps.authenticate(req);if(!fresh||fresh.member.memberId!==auth.member.memberId||fresh.deviceId!==auth.deviceId||deps.teamId()!==teamId)throw new Error('Your team session changed')
   const args=(req.method==='GET'?Object.fromEntries(url.searchParams):body) as Record<string,unknown>
   if(!args||args.teamId!==teamId||typeof args.recordId!=='string'||args.recordId.length>128)throw new Error('This record belongs to another team')
   if(assistant&&Object.keys(args).some(key=>!['teamId','moduleId','entityId','recordId','commandId','expectedRevision','command','limit','offset','boundedHistory'].includes(key)))throw new Error('Assistant actor identity is derived from the authenticated account')
   const identity=resolveRecordTeamworkIdentity(deps.store,teamId,args.recordId,fresh.member)
   for(const key of ['entityId','moduleId'] as const)if(args[key]!==undefined&&args[key]!==identity[key])throw new Error('This link does not match the record identity')
   const memberAuthority=recordTeamworkAuthority(deps.store,identity,fresh.member,deps.departmentExists)
   const authority=assistant?asRecordTeamworkAssistant(memberAuthority,teamId,fresh.deviceId):memberAuthority
   const probe={targetKind:'record',opId:'read',hlc:'',originDevice:'',hopCount:0,protocolVersion:2,kind:'record.teamwork',targetId:identity.recordId,entityId:identity.entityId,moduleId:identity.moduleId,patch:{data:{}}} as ModulesSyncOp
   // Unstructured notes follow the same complete-record field visibility policy as comments.
   if(!deps.canRead(probe,fresh.member))throw new Error('Teamwork requires access to all record fields')
   if(completion){
    if(req.method!=='POST')throw new Error('Use POST for completion')
    deps.assertWritable()
    if(!authority.canWrite)throw new Error('You cannot complete this record')
    if(Object.keys(args).some(key=>!['recordId','entityId','moduleId','teamId','expectedRevision','fieldSlug','value','previous','commandId'].includes(key)))throw new Error('Only the reviewed status can change during completion')
    if(typeof args.commandId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(args.commandId)||typeof args.fieldSlug!=='string'||!Number.isSafeInteger(args.expectedRevision))throw new Error('Invalid completion request')
    const current=deps.store.recordTeamwork.read(identity.recordId)
    if(!current.config?.reviewRequired||!recordTeamworkStatusKeys(deps.store,identity.entityId,current).includes(args.fieldSlug))throw new Error('The reviewed status configuration changed; refresh this record')
    let op:ModulesSyncOp={...probe,kind:'record.update',opId:args.commandId,hlc:clock(deps.store.contentAccess.recordCellHlc(identity.recordId,args.fieldSlug)),originDevice:fresh.deviceId,originMemberId:fresh.member.memberId,originMemberName:fresh.member.displayName,originRole:fresh.member.role,teamId,team_id:teamId,contentAclRevision:deps.store.contentAccess.revision(probe),patch:{data:{[args.fieldSlug]:args.value},...baseline(identity.recordId,args.fieldSlug),expectedRevision:args.expectedRevision,previous:args.previous,reviewedCompletion:true}}
    const refusal=deps.store.contentAccess.authorize(op,fresh.member.memberId,fresh.member.role)||deps.fieldRefusal(op,fresh.member)
    if(refusal)throw new Error(refusal)
    const repeated=deps.store.recordTeamwork.isExactCompletion(op)
    if(deps.store.hasSeenOpId(op.opId)&&!repeated)throw new Error('This completion identity was already used for another change')
    if(!repeated){
     if(current.revision!==args.expectedRevision)throw new Error('Record teamwork changed. Review the latest state before completing')
     if(!recordTeamworkWriteGate(current,{[args.fieldSlug]:args.value},recordTeamworkStatusKeys(deps.store,identity.entityId,current)).completion)throw new Error('Choose a completed status')
     op=deps.store.recordTeamwork.stamp(op,authority,state=>recordTeamworkStatusKeys(deps.store,identity.entityId,state))
     // appendOps rechecks the approved content and accepted live document state
     // in the same synchronous admission as the durable operation append.
     const saved=deps.store.appendOps([op])
     if(saved.accepted.length!==1)throw new Error('Completion was not saved')
     deps.publish(saved.accepted)
    }
    deps.json(res,200,{ok:true,data:{commandId:args.commandId,recordId:identity.recordId,teamId,revision:deps.store.recordTeamwork.read(identity.recordId).revision}})
    return true
   }
   if(req.method==='POST'){
    deps.assertWritable()
    const command=args.command as RecordTeamworkCommand
    if(assistant)assertRecordTeamworkAssistantCommand(command)
    if(!authority.canWrite)throw new Error('You cannot change teamwork for this record')
    const commandId=typeof args.commandId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(args.commandId)?args.commandId:randomUUID()
    let op:ModulesSyncOp={...probe,opId:commandId,protocolVersion:2,hlc:clock(),originDevice:fresh.deviceId,hopCount:0,originMemberId:fresh.member.memberId,originMemberName:fresh.member.displayName,originRole:fresh.member.role,teamId,team_id:teamId,contentAclRevision:deps.store.contentAccess.revision(probe),patch:{data:{},expectedRevision:args.expectedRevision,command,...(assistant?{assistantDelegation:true}:{})}}
    if(deps.store.hasSeenOpId(commandId)&&!deps.store.recordTeamwork.isExactCommand(op))throw new Error('This command identity was already used for another change')
    if(!deps.store.recordTeamwork.isExactCommand(op)){
     const contentRefusal=deps.store.contentAccess.authorize(op,fresh.member.memberId,fresh.member.role)
     if(contentRefusal)throw new Error(contentRefusal)
     op=deps.store.recordTeamwork.stamp(op,authority,state=>recordTeamworkStatusKeys(deps.store,identity.entityId,state))
     const ops=[op]
     if(command.action==='handoff'){
      const state=op.teamwork!.state,field=deps.store.contentAccess.fieldDefinition(identity.entityId,state.config!.assigneeFieldId!)!
      if(field.multiple===undefined||field.multiple&&!deps.store.recordTeamwork.hasSharedPersonCell(identity.recordId,field.slug)){
       deps.requestAssignmentSnapshot?.({...identity,teamId,fieldId:state.config!.assigneeFieldId!})
       throw new Error('Refreshing the current assignee list from an online Admin. Keep this draft and retry shortly. If no Admin is connected, reconnect the publishing computer first. No assignments were changed.')
      }
      const value=teamworkHandoffPeople(field.multiple?deps.store.recordTeamwork.sharedPersonCell(identity.recordId,field.slug,teamId):[],state.handoff!.to,field.multiple,{id:fresh.member.memberId,teamId})
      let update:ModulesSyncOp={...op,kind:'record.update',opId:commandId+'-assignment',hlc:clock(deps.store.contentAccess.recordCellHlc(identity.recordId,field.slug)),patch:{data:{[field.slug]:value},...baseline(identity.recordId,field.slug)},teamwork:undefined}
      const fieldRefusal=deps.fieldRefusal(update,fresh.member);if(fieldRefusal)throw new Error(fieldRefusal)
      update=deps.store.recordTeamwork.stamp(update,authority,next=>recordTeamworkStatusKeys(deps.store,identity.entityId,next),ops)
      ops.push(update)
     }
     const saved=deps.store.appendOps(ops)
     if(saved.accepted.length!==ops.length)throw new Error('The teamwork change was not fully saved')
     deps.publish(saved.accepted)
    }
   }
   const state=deps.store.recordTeamwork.read(identity.recordId)
   const limit=Math.max(1,Math.min(100,Math.floor(Number(args.limit)||20))),offset=Math.max(0,Math.floor(Number(args.offset)||0))
   const data={...state,identity,currentMemberId:fresh.member.memberId,currentUserId:null,canConfigure:authority.canConfigure,allowedActions:recordTeamworkAllowedActions(state,authority)}
   // Opt in: current desktops assemble the selected page across bounded replies.
   // Older clients retain their existing row-count contract.
   const maxBytes=args.boundedHistory==='1'?Math.max(0,1_900_000-Buffer.byteLength(JSON.stringify({ok:true,data}))-256):Infinity
   const history=deps.store.recordTeamwork.history(identity.recordId,limit,offset,maxBytes)
   if(req.method==='GET'&&history.historyTotal>offset&&!history.history.length)throw new Error('This history entry is too large to load safely')
   deps.json(res,200,{ok:true,data:{...data,...history}})
  }catch(error){deps.drain(req);deps.json(res,409,{ok:false,error:error instanceof Error?error.message:'Record teamwork is unavailable'})}
  finally{deps.releaseBody(body)}return true
 }
}
