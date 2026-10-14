import {createHash} from 'node:crypto'
import * as Y from 'yjs'
import type {ModulesSyncOp} from './index.js'
import {isYjsUpdateB64,YJS_UPDATE_B64_MAX} from './yjs-room.js'

// The live frame cap remains unchanged. Aggregate history gets a separate bound:
// do not acknowledge content that cannot be durably retained for review proof.
export const YJS_REVIEW_AGGREGATE_MAX = Math.floor(YJS_UPDATE_B64_MAX * 3 / 4)
export type AcceptedYjsRoom = {recordId:string;fieldSlug:string;stateB64:string;settled:boolean;resetId?:string;awaitingReset?:boolean}
export type YjsCellBaseline={textHash:string;jsonHash?:string;resetId?:string;hlc?:string}
/** Existing record cells use HLC ordering; never locale/timezone string ordering. */
export function compareYjsCellHlc(a:string|undefined,b:string|undefined):number {
 const parse=(raw:string|undefined):[number,number,string]=>{const parts=(raw??'').split(':');return parts.length>=3&&/^\d+$/.test(parts[0])&&/^\d+$/.test(parts[1])&&Number.isSafeInteger(Number(parts[0]))&&Number.isSafeInteger(Number(parts[1]))?[Number(parts[0]),Number(parts[1]),parts.slice(2).join(':')]:[-1,-1,'']}
 const aa=parse(a),bb=parse(b)
 return aa[0]!==bb[0]?aa[0]<bb[0]?-1:1:aa[1]!==bb[1]?aa[1]<bb[1]?-1:1:aa[2]===bb[2]?0:aa[2]<bb[2]?-1:1
}
function canonicalJson(value:unknown):unknown {return Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a===b?0:a<b?-1:1).map(([key,item])=>[key,canonicalJson(item)])):value}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonicalJson(value))??'null').digest('hex')
export function yjsCellBaseline(value:unknown,resetId?:string):YjsCellBaseline {
 let parsed=value
 if(typeof value==='string'){try{parsed=JSON.parse(value)}catch{}}
 return {textHash:digest(value??''),jsonHash:digest(parsed),...(resetId?{resetId}:{})}
}
export function matchesYjsBaseline(metadata:ReturnType<typeof checkpointMetadata>,baseline:YjsCellBaseline):boolean {
 const hash=digest(metadata.value)
 return metadata.binding?.[2]==='whiteboard'?hash===baseline.jsonHash:hash===baseline.textHash
}
export const reviewRoomKey = (recordId:string,fieldSlug:string) => JSON.stringify([recordId,fieldSlug])
export function canonicalYjsState(updates:Uint8Array[]):Buffer {
 const doc=new Y.Doc()
 try {for(const update of updates)Y.applyUpdate(doc,update);return Buffer.from(Y.encodeStateAsUpdate(doc))}finally{doc.destroy()}
}
export function decodeCheckpoint(stateB64:unknown):Buffer {
 if(typeof stateB64!=='string'||stateB64.length>YJS_REVIEW_AGGREGATE_MAX*4/3+4||!stateB64||!/^[A-Za-z0-9+/]+={0,2}$/.test(stateB64))throw new Error('Invalid or oversized document checkpoint')
 const bytes=Buffer.from(stateB64,'base64')
 if(bytes.length>YJS_REVIEW_AGGREGATE_MAX)throw new Error('Document checkpoint exceeds the review history capacity')
 return canonicalYjsState([bytes])
}
export function checkpointMetadata(bytes:Uint8Array):{resetId?:string;genesis?:string;binding?:unknown[];value?:unknown;complete:boolean} {
 const doc=new Y.Doc()
 try{
  Y.applyUpdate(doc,bytes)
  const meta=doc.getMap<string>('_modules_checkpoint')
  let binding:unknown[]|undefined
  try{binding=JSON.parse(meta.get('binding')??'')}catch{}
  const kind=binding?.[2]
  if(!binding||binding.length!==3||!['text','whiteboard'].includes(String(kind))||!binding.slice(0,2).every(v=>typeof v==='string'&&v.length>0&&v.length<=128)||!/^[a-f0-9]{64}$/.test(meta.get('genesis')??''))throw new Error('Invalid document scope or generation')
  const allowed=new Set(kind==='text'?['_modules_checkpoint','content']:['_modules_checkpoint','shapes','order'])
  if([...doc.share.keys()].some(key=>!allowed.has(key))||[...meta.keys()].some(key=>!['binding','genesis','resetId'].includes(key)))throw new Error('Unexpected document checkpoint data')
  let value:unknown=kind==='text'?doc.getText('content').toString():undefined
  if(kind==='whiteboard'){
   const shapes=doc.getMap<string>('shapes'),order=doc.getArray<string>('order').toArray()
   const ordered=[...new Set(order)]
   if([...shapes.keys()].some(id=>id!=='__wbv'&&!ordered.includes(id)))throw new Error('Incomplete whiteboard checkpoint')
   value={version:Number(shapes.get('__wbv')??1),shapes:ordered.map(id=>{const shape=JSON.parse(shapes.get(id)??'null');if(!shape||shape.id!==id)throw new Error('Invalid whiteboard checkpoint');return shape})}
  }
  return {resetId:meta.get('resetId'),genesis:meta.get('genesis'),binding,value,complete:!doc.store.pendingStructs&&!doc.store.pendingDs}
 }finally{doc.destroy()}
}
export function mergeAcceptedYjs(previous:AcceptedYjsRoom|undefined,recordId:string,fieldSlug:string,updateB64:string):AcceptedYjsRoom {
 if(updateB64.length>YJS_UPDATE_B64_MAX||!isYjsUpdateB64(updateB64))throw new Error('Invalid or oversized update')
 const before=previous&&!previous.awaitingReset?Buffer.from(previous.stateB64,'base64'):canonicalYjsState([])
 const merged=canonicalYjsState([before,Buffer.from(updateB64,'base64')])
 const metadata=checkpointMetadata(merged)
 if(!metadata.complete)throw new Error('Incomplete document update; resend the complete latest state')
 if(previous&&!previous.awaitingReset){const prior=checkpointMetadata(before);if(prior.genesis&&metadata.genesis!==prior.genesis||metadata.resetId!==prior.resetId)throw new Error('This live edit belongs to another document generation')}
 if(previous?.awaitingReset&&(!metadata.complete||metadata.resetId!==previous.resetId||metadata.binding?.[0]!==recordId||metadata.binding?.[1]!==fieldSlug))throw new Error('This live edit belongs to an older document version. Reopen the latest document before editing.')
 if(merged.length>YJS_REVIEW_AGGREGATE_MAX)throw new Error('Document review history capacity reached; preserve your current content and start a new document')
 return {recordId,fieldSlug,stateB64:merged.toString('base64'),settled:merged.equals(before)?previous?.settled??true:false,...(metadata.resetId?{resetId:metadata.resetId}:{})}
}
/** Includes pending structs and deletion sets, unlike a state-vector-only test. */
export function checkpointContainsAccepted(candidate:Buffer,accepted:AcceptedYjsRoom):boolean {
 return canonicalYjsState([candidate,Buffer.from(accepted.stateB64,'base64')]).equals(candidate)
}
export function recordYjsCheckpoints(op:ModulesSyncOp):Array<{fieldSlug:string;stateB64:string;kind:string}> {
 if(op.kind!=='record.update'&&op.kind!=='record.create')return []
 const patch=op.patch??{},values=[patch.yjsCheckpoint,...(Array.isArray(patch.yjsCheckpoints)?patch.yjsCheckpoints:[])]
 return values.filter(v=>v!==undefined).map(v=>{
  if(!v||typeof v!=='object'||typeof (v as any).fieldSlug!=='string'||typeof (v as any).stateB64!=='string'||!['text','whiteboard'].includes((v as any).kind))throw new Error('Invalid document checkpoint')
  return v as {fieldSlug:string;stateB64:string;kind:string}
 })
}
