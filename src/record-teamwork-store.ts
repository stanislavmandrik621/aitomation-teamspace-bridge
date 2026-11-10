import {teamworkSharedPeople} from './record-teamwork-people.js'
import type {ModulePersonReference} from './record-teamwork-types.js'
import { join } from 'node:path'
import { existsSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs'
import type { AtRestKey } from './at-rest.js'
import type { ModulesSyncOp } from './index.js'
import { ContentAccessStorage } from './content-access-storage.js'
import { referenceCells } from './content-reference-data.js'
import { applyRecordTeamworkCommand, emptyRecordTeamwork, recordTeamworkAfterWrite, recordTeamworkChanges, recordTeamworkWriteGate, type RecordTeamworkAuthority } from './record-teamwork-state.js'
import type { RecordTeamworkCommand, RecordTeamworkEvent, RecordTeamworkState } from './record-teamwork-types.js'

import {mergeAcceptedYjs,decodeCheckpoint,checkpointContainsAccepted,recordYjsCheckpoints,reviewRoomKey,checkpointMetadata,yjsCellBaseline,matchesYjsBaseline,compareYjsCellHlc,type YjsCellBaseline,type AcceptedYjsRoom} from './record-teamwork-yjs.js'

type PersonCell = {hlc:string;members:ModulePersonReference[]}
type Entry = { state: RecordTeamworkState; event?: RecordTeamworkEvent }
export class RecordTeamworkStore {
  private personCells = new Map<string,PersonCell>()
  private pendingPersonCells = new Map<string,PersonCell>()
  private states = new Map<string, RecordTeamworkState>()
  private events = new Map<string, RecordTeamworkEvent[]>()
  private pending = new Map<string, Entry>()
  private receipts = new Map<string,string>()
  private pendingReceipts = new Map<string,string>()
  private pendingEvents = new Map<string, {recordId:string;event:RecordTeamworkEvent}>()
  private storage: ContentAccessStorage | null = null
  private unavailable = false
  private observedYjsOps = new Set<string>()
  private pendingYjsOps = new Set<string>()
  private baselines = new Map<string,YjsCellBaseline>()
  private pendingBaselines = new Map<string,YjsCellBaseline>()
  private rooms = new Map<string,AcceptedYjsRoom>()
  private pendingRooms = new Map<string,AcceptedYjsRoom>()
  constructor(root: string, atRest: AtRestKey | null, private readonly acceptedCellHlc?:(recordId:string,slug:string)=>string|undefined) {
    try {
      const directory = join(root, 'record-teamwork')
      const database = join(directory, 'content-access.sqlite'), marker = join(root, 'record-teamwork.initialized')
      if (existsSync(marker) && !existsSync(database)) throw new Error('Record teamwork checkpoint is missing')
      this.storage = new ContentAccessStorage(directory, atRest, existsSync(database))
      if (!existsSync(marker)) { const fd=openSync(marker,'wx',0o600); try { writeFileSync(fd,'1');fsyncSync(fd) } finally { closeSync(fd) } }
      for (const entry of this.storage.load()) {
        if(entry.kind==='person-cell')this.personCells.set(entry.key,entry.value as PersonCell)
        if (entry.kind === 'yjs-cell')this.baselines.set(entry.key,entry.value as YjsCellBaseline)
        if (entry.kind === 'yjs-op') this.observedYjsOps.add(entry.key)
        if (entry.kind === 'yjs-room') this.rooms.set(entry.key,entry.value as AcceptedYjsRoom)
        if (entry.kind === 'receipt') this.receipts.set(entry.key,String(entry.value))
        if (entry.kind === 'state') this.states.set(entry.key, entry.value as RecordTeamworkState)
        if (entry.kind === 'event') {
          const {recordId,...event} = entry.value as RecordTeamworkEvent & {recordId:string}
          // Loading a long history must not copy every preceding event again.
          // The checkpoint is iterated once, then each record is sorted below.
          const rows = this.events.get(recordId)
          if (rows) rows.push(event)
          else this.events.set(recordId, [event])
        }
      }
      for (const rows of this.events.values()) rows.sort((a,b) => b.revision-a.revision)
    } catch { this.unavailable = true }
  }
  hasSharedPersonCell(recordId:string,fieldSlug:string):boolean { return this.personCells.has(reviewRoomKey(recordId,fieldSlug)) }
  sharedPersonCell(recordId:string,fieldSlug:string,teamId:string):ModulePersonReference[] {
    this.read(recordId)
    const value=this.personCells.get(reviewRoomKey(recordId,fieldSlug))
    if(!value)throw new Error('The current assignee list is unavailable. Sync or save the current Person field before handing off; no assignments were changed.')
    return value.members.filter(person=>person.kind==='member'&&person.teamId===teamId).map(person=>({...person}))
  }
  private observePersonCells(op:ModulesSyncOp):void {
    if(op.kind!=='record.create'&&op.kind!=='record.update')return
    const cells=referenceCells(op.patch??{}),removed=op.removeKeys??op.patch?.removeKeys??op.patch?.remove_keys
    if(Array.isArray(removed))for(const field of removed)if(typeof field==='string')cells[field]=null
    const clocks=op.patch?.cellHlcs as Record<string,string>|undefined
    for(const [field,raw] of Object.entries(cells)){
      const key=reviewRoomKey(op.targetId,field),hlc=clocks?.[field]||op.hlc,previous=this.personCells.get(key)
      const accepted=this.acceptedCellHlc?.(op.targetId,field)
      if(accepted&&compareYjsCellHlc(hlc,accepted)<0)continue
      if(previous&&compareYjsCellHlc(hlc,previous.hlc)<=0)continue
      const value={hlc,members:teamworkSharedPeople(raw)}
      this.personCells.set(key,value);this.pendingPersonCells.set(key,value)
    }
  }
  /** Called after current ACL validation and before either peer fanout or sender acknowledgement. */
  acceptYjs(recordId:string,fieldSlug:string,updateB64:string):void {
    this.read(recordId)
    const key=reviewRoomKey(recordId,fieldSlug), previous=this.rooms.get(key)
    const next=mergeAcceptedYjs(previous,recordId,fieldSlug,updateB64)
    if(!previous||previous.awaitingReset){
      const metadata=checkpointMetadata(Buffer.from(next.stateB64,'base64')),baseline=this.baselines.get(key)
      if(!metadata.complete||metadata.binding?.[0]!==recordId||metadata.binding?.[1]!==fieldSlug||baseline&&metadata.resetId!==baseline.resetId)throw new Error('Load the latest complete document state before editing')
      if(baseline&&matchesYjsBaseline(metadata,baseline))next.settled=true
    }
    if(previous?.stateB64===next.stateB64&&previous.settled===next.settled)return
    this.rooms.set(key,next);this.pendingRooms.set(key,next)
    this.flush()
  }
  acceptedYjsState(recordId:string,fieldSlug:string):string|undefined {
    this.read(recordId)
    const room=this.rooms.get(reviewRoomKey(recordId,fieldSlug))
    return room&&!room.awaitingReset?room.stateB64:undefined
  }
  hasUnsettledYjs(recordId:string):boolean {
    this.read(recordId)
    return [...this.rooms.values()].some(room=>room.recordId===recordId&&!room.settled)
  }
  private assertYjsSettled(recordId:string):void {
    if(this.hasUnsettledYjs(recordId))throw new Error('Live document changes are still saving. Wait for the latest checkpoint before requesting review, approving, or completing this record.')
  }
  private acceptsCellHlc(op:ModulesSyncOp,field:string):boolean {
    const old=this.baselines.get(reviewRoomKey(op.targetId,field)),clocks=op.patch?.cellHlcs as Record<string,string>|undefined
    return !old?.hlc||compareYjsCellHlc(clocks?.[field]||op.hlc,old.hlc)>0
  }
  private ordinaryRoomWrites(op:ModulesSyncOp):AcceptedYjsRoom[] {
    if(op.kind!=='record.update'&&op.kind!=='record.create')return []
    const cells=referenceCells(op.patch??{}), removed=op.removeKeys??op.patch?.removeKeys??op.patch?.remove_keys
    if(Array.isArray(removed))for(const key of removed)if(typeof key==='string')cells[key]=null
    const checkpointFields=new Set(recordYjsCheckpoints(op).map(cp=>cp.fieldSlug))
    return [...this.rooms.values()].filter(room=>room.recordId===op.targetId&&this.acceptsCellHlc(op,room.fieldSlug)&&!checkpointFields.has(room.fieldSlug)&&Object.hasOwn(cells,room.fieldSlug)
      && (room.awaitingReset||!matchesYjsBaseline(checkpointMetadata(Buffer.from(room.stateB64,'base64')),yjsCellBaseline(cells[room.fieldSlug]))))
  }
  private validateCheckpoints(op:ModulesSyncOp):void {
    for(const room of this.ordinaryRoomWrites(op))if(!room.settled)throw new Error('Live document changes are still saving. Save their latest checkpoint before replacing this field.')
    for(const checkpoint of recordYjsCheckpoints(op)){
      const candidate=decodeCheckpoint(checkpoint.stateB64), room=this.rooms.get(reviewRoomKey(op.targetId,checkpoint.fieldSlug))
      const metadata=checkpointMetadata(candidate),cells=referenceCells(op.patch??{})
      if(!metadata.complete||metadata.binding?.[0]!==op.targetId||metadata.binding?.[1]!==checkpoint.fieldSlug||metadata.binding?.[2]!==checkpoint.kind||!Object.hasOwn(cells,checkpoint.fieldSlug)||!matchesYjsBaseline(metadata,yjsCellBaseline(cells[checkpoint.fieldSlug])))throw new Error('Document checkpoint does not match its record field')
      if(room?.awaitingReset&&checkpointMetadata(candidate).resetId!==room.resetId)throw new Error('This checkpoint belongs to an older document version')
      if(room&&!room.awaitingReset&&!checkpointContainsAccepted(candidate,room))throw new Error('This document checkpoint is behind accepted live edits. Refresh the document and save its latest state.')
    }
  }
  private observeCheckpoints(op:ModulesSyncOp):void {
    if(op.kind!=='record.update'&&op.kind!=='record.create'||this.observedYjsOps.has(op.opId))return
    // Keep replay receipts alongside room state: an old scalar replacement in
    // retained WAL must not reset a newer durably accepted live generation.
    this.observedYjsOps.add(op.opId);this.pendingYjsOps.add(op.opId)
    for(const room of this.ordinaryRoomWrites(op)){
      const marker=Array.isArray(op.patch?.yjsResets)?op.patch.yjsResets.find((r:any)=>r?.fieldSlug===room.fieldSlug) as any:undefined
      const cellClocks=op.patch?.cellHlcs as Record<string,string>|undefined
      const resetId=typeof marker?.resetId==='string'?marker.resetId:`hlc:${cellClocks?.[room.fieldSlug]||op.hlc}`
      const next={...room,stateB64:'',settled:true,awaitingReset:true,resetId}
      const key=reviewRoomKey(room.recordId,room.fieldSlug);this.rooms.set(key,next);this.pendingRooms.set(key,next)
    }
    const cells=referenceCells(op.patch??{}),removed=op.removeKeys??op.patch?.removeKeys??op.patch?.remove_keys
    if(Array.isArray(removed))for(const field of removed)if(typeof field==='string')cells[field]=null
    for(const [field,value] of Object.entries(cells)){
      const key=reviewRoomKey(op.targetId,field),old=this.baselines.get(key),next=yjsCellBaseline(value)
      const checkpoint=recordYjsCheckpoints(op).find(cp=>cp.fieldSlug===field)
      if(!checkpoint&&!this.acceptsCellHlc(op,field))continue
      const marker=Array.isArray(op.patch?.yjsResets)?op.patch.yjsResets.find((r:any)=>r?.fieldSlug===field) as any:undefined
      const clocks=op.patch?.cellHlcs as Record<string,string>|undefined
      const resetId=checkpoint?checkpointMetadata(decodeCheckpoint(checkpoint.stateB64)).resetId:op.kind==='record.create'?marker?.resetId:old&&old.textHash===next.textHash?old.resetId:`hlc:${clocks?.[field]||op.hlc}`
      next.hlc=compareYjsCellHlc(clocks?.[field]||op.hlc,old?.hlc)>0?clocks?.[field]||op.hlc:old?.hlc
      if(resetId)next.resetId=resetId
      this.baselines.set(key,next);this.pendingBaselines.set(key,next)
    }
    for(const checkpoint of recordYjsCheckpoints(op)){
      const candidate=decodeCheckpoint(checkpoint.stateB64),key=reviewRoomKey(op.targetId,checkpoint.fieldSlug),room=this.rooms.get(key)
      // Old WAL rows replay after the durable live aggregate. They cannot settle newer updates.
      if(room?.awaitingReset&&checkpointMetadata(candidate).resetId!==room.resetId)continue
      if(room&&!room.awaitingReset&&!checkpointContainsAccepted(candidate,room))continue
      const next={recordId:op.targetId,fieldSlug:checkpoint.fieldSlug,stateB64:candidate.toString('base64'),settled:true}
      this.rooms.set(key,next);this.pendingRooms.set(key,next)
    }
  }
  private commandKey(op:ModulesSyncOp):string{return JSON.stringify([op.targetId,op.originMemberId,op.originDevice,op.patch?.expectedRevision,op.patch?.command && (op.patch.command as any).action==='handoff'?{...(op.patch.command as any),to:{...(op.patch.command as any).to,label:''}}:op.patch?.command,...(op.patch?.assistantDelegation===true?['assistant']:[])])}
  private completionKey(op:ModulesSyncOp):string{return JSON.stringify([op.targetId,op.entityId,op.moduleId,op.originMemberId,op.originDevice,op.patch?.expectedRevision,op.patch?.data,op.patch?.previous])}
  isExactCompletion(op:ModulesSyncOp):boolean{return this.receipts.get(`completion:${op.opId}`)===this.completionKey(op)}
  isExactCommand(op:ModulesSyncOp):boolean{return this.receipts.get(op.opId)===this.commandKey(op)}
  healthy(): boolean { return !this.unavailable }
  read(recordId: string): RecordTeamworkState {
    if (!this.healthy()) throw new Error('Record teamwork authority is unavailable')
    return structuredClone(this.states.get(recordId) ?? emptyRecordTeamwork())
  }
  history(recordId: string, limit = 20, offset = 0, maxBytes = Infinity): {history:RecordTeamworkEvent[];historyTotal:number} {
    this.read(recordId)
    const rows = this.events.get(recordId) ?? []
    const selected:RecordTeamworkEvent[]=[]
    let bytes=0
    for(let i=offset;i<Math.min(rows.length,offset+limit);i++){
      const size=Number.isFinite(maxBytes)?Buffer.byteLength(JSON.stringify(rows[i]))+1:0
      if(bytes+size>maxBytes)break
      selected.push(rows[i]);bytes+=size
    }
    return {history:structuredClone(selected),historyTotal:rows.length}
  }
  private preview(recordId: string, pending: ModulesSyncOp[]): RecordTeamworkState {
    let state = this.read(recordId)
    for (const op of pending) if (op.targetId === recordId && op.teamwork?.state) state = op.teamwork.state
    return structuredClone(state)
  }
  private changedCells(op:ModulesSyncOp):Record<string,unknown> {
    const cells=referenceCells(op.patch??{}),removed=op.removeKeys??op.patch?.removeKeys??op.patch?.remove_keys
    if(Array.isArray(removed))for(const key of removed)if(typeof key==='string')cells[key]=null
    const clocks=op.patch?.cellHlcs as Record<string,string>|undefined
    if(op.kind==='record.create'&&clocks&&this.acceptedCellHlc)for(const key of Object.keys(cells)){
      const accepted=this.acceptedCellHlc(op.targetId,key)
      if(accepted&&clocks[key]&&compareYjsCellHlc(clocks[key],accepted)<=0)delete cells[key]
    }
    return cells
  }
  stamp(op: ModulesSyncOp, authority: RecordTeamworkAuthority, statusKeys: (state:RecordTeamworkState)=>string[], pending:ModulesSyncOp[] = []): ModulesSyncOp {
    const {teamwork:_claimed,...clean} = op
    const state = this.preview(op.targetId,pending)
    if (op.kind === 'record.teamwork') {
      const command = op.patch?.command as RecordTeamworkCommand
      if(command?.action==='request_review'||command?.action==='approve')this.assertYjsSettled(op.targetId)
      const next = applyRecordTeamworkCommand(state,Number(op.patch?.expectedRevision),command,authority,{id:op.opId,at:new Date().toISOString()})
      return {...clean,teamwork:next,patch:{data:{},expectedRevision:op.patch?.expectedRevision,command,...(authority.actor.delegatedBy?{assistantDelegation:true}:{})}}
    }
    if ((op.kind === 'record.update' || op.kind === 'record.create') && state.config) {
      const cells=this.changedCells(op)
      if(!Object.keys(cells).length)return clean
      const {completion}=recordTeamworkWriteGate(state,cells,statusKeys(state))
      const next=recordTeamworkAfterWrite(state,completion)
      return {...clean,teamwork:{state:next,...(state.review.state!=='none' && next.review.state==='none'?{event:{id:op.opId,at:new Date().toISOString(),revision:next.revision,action:'approval_invalidated' as const,recordRevision:next.recordRevision,changes:recordTeamworkChanges(state,next),actor:authority.actor}}:{})}}
    }
    return clean
  }
  /** Even internal/public writers must pass completion admission before the WAL append. */
  validateCommit(ops:ModulesSyncOp[], statusKeys:(recordId:string,state:RecordTeamworkState)=>string[], accepted:ModulesSyncOp[]=[]):void {
    const pending:ModulesSyncOp[]=[...accepted]
    for(const op of ops){
      const state=this.preview(op.targetId,pending)
      this.validateCheckpoints(op)
      if(op.kind==='record.teamwork'&&['request_review','approve'].includes(String((op.patch?.command as any)?.action)))this.assertYjsSettled(op.targetId)
      if(op.kind==='record.teamwork' && !op.teamwork)throw new Error('Record teamwork requires authenticated admission')
      if((op.kind==='record.update'||op.kind==='record.create')&&state.config){
        const cells=this.changedCells(op)
        if(!Object.keys(cells).length){pending.push(op);continue}
        const {completion}=recordTeamworkWriteGate(state,cells,statusKeys(op.targetId,state))
        if(completion&&state.config.reviewRequired)this.assertYjsSettled(op.targetId)
        if(!op.teamwork){const next=recordTeamworkAfterWrite(state,completion);op.teamwork={state:next,...(state.review.state!=='none'&&next.review.state==='none'?{event:{id:op.opId,at:new Date().toISOString(),revision:next.revision,action:'approval_invalidated' as const,recordRevision:next.recordRevision,changes:recordTeamworkChanges(state,next),actor:{id:op.originMemberId||'public-form',name:op.originMemberName||'Public form',kind:op.originMemberId?'member' as const:'user' as const}}}:{})}}
      }
      if(op.teamwork && op.teamwork.state.revision !== state.revision+1)throw new Error('Record teamwork changed before commit')
      pending.push(op)
    }
  }
  observe(op:ModulesSyncOp):void {
    if(!this.healthy())return
    this.observePersonCells(op)
    this.observeCheckpoints(op)
    if(!op.teamwork)return
    if(op.kind==='record.update'&&op.patch?.reviewedCompletion===true){const key=`completion:${op.opId}`,value=this.completionKey(op);this.receipts.set(key,value);this.pendingReceipts.set(key,value)}
    if(op.kind==='record.teamwork'){const receipt=this.commandKey(op);this.receipts.set(op.opId,receipt);this.pendingReceipts.set(op.opId,receipt)}
    const {state,event}=op.teamwork, previous=this.states.get(op.targetId)
    if(previous && previous.revision>=state.revision)return
    if(!Number.isSafeInteger(state.revision)||state.revision<1){this.unavailable=true;return}
    this.states.set(op.targetId,structuredClone(state))
    if(event){const rows=this.events.get(op.targetId)??[];if(!rows.some(row=>row.id===event.id))rows.unshift(structuredClone(event));this.events.set(op.targetId,rows)}
    this.pending.set(op.targetId,{state})
    if(event)this.pendingEvents.set(event.id,{recordId:op.targetId,event})
  }
  flush():void {
    if(!this.healthy())throw new Error('Record teamwork authority is unavailable')
    try{
      const entries:import('./content-access-storage.js').AuthorityEntry[]=[...this.pending].flatMap(([recordId,{state,event}])=>[
        {kind:'state',key:recordId,value:state},...(event?[{kind:'event',key:event.id,value:{...event,recordId}}]:[]),
      ])
      entries.push(...[...this.pendingPersonCells].map(([key,value])=>({kind:'person-cell',key,value})))
      entries.push(...[...this.pendingEvents].map(([key,{recordId,event}])=>({kind:'event',key,value:{...event,recordId}})))
      entries.push(...[...this.pendingReceipts].map(([key,value])=>({kind:'receipt',key,value})))
      entries.push(...[...this.pendingBaselines].map(([key,value])=>({kind:'yjs-cell',key,value})))
      entries.push(...[...this.pendingYjsOps].map(key=>({kind:'yjs-op',key,value:true})))
      entries.push(...[...this.pendingRooms].map(([key,value])=>({kind:'yjs-room',key,value})))
      if(entries.length)this.storage!.write(entries)
      this.pendingPersonCells.clear();this.pending.clear();this.pendingEvents.clear();this.pendingReceipts.clear();this.pendingRooms.clear();this.pendingYjsOps.clear();this.pendingBaselines.clear()
    }catch(error){this.unavailable=true;throw error}
  }
}
