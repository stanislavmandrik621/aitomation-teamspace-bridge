import { createHash } from 'node:crypto'
import type { MailStore, MailStoreWrite, MailStoreBatchOptions } from './mail-store.js'
import { WarmupPreparationError, addWarmupCounters, emptyWarmupCounters, warmupMessageCounters, parseWarmupWorkspaceRequest, orderedWarmupTemplates, renderWarmupContent,
  type WarmupRun, type WarmupRunMessage, type WarmupCounters, type WarmupWorkspaceResult, type WarmupStudioConfig, type WarmupAddress, type WarmupContent } from './mail-warmup-studio.js'

export interface WarmupUsage { pair: string; cycle: number; templateId: string; fingerprint: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
/** Stage the ledger and counters inside the same transaction as the durable provider claim. */
export class WarmupRunStore {
  constructor(private readonly store: MailStore) {}
  async stage(owner: string, messages: WarmupRunMessage[], current: () => void, options: { start?: WarmupRun; finish?: string; runId?: string; enabled: boolean; reason: string | null; now: number; usage?: {runId:string; value:WarmupUsage}[] }) {
    const writes: MailStoreWrite[] = [], checks: NonNullable<MailStoreBatchOptions['checks']> = []
    const runs = new Map<string,WarmupRun>(), originals = new Map<string,number|null>()
    const readRun = async(id:string) => {
      if (runs.has(id)) return runs.get(id)!
      const row = await this.store.get<WarmupRun>('warmup-runs',`${owner}:${id}`);current()
      if (!row) throw new Error('Saved run history is missing')
      runs.set(id,row.value);originals.set(id,row.revision);return row.value
    }
    if (options.start) {runs.set(options.start.id,options.start);originals.set(options.start.id,null);writes.push({collection:'warmup-run-index',id:`${owner}:${String(8_640_000_000_000_000-options.start.startedAt).padStart(16,'0')}:${options.start.id}`,owner,value:{runId:options.start.id}})}
    const stats = new Map<string,{revision:number|null; value:{kind:'mailbox'|'day';key:string;email?:string;totals:WarmupCounters};runId:string}>()
    const changeStats = async(runId:string,kind:'mailbox'|'day',key:string,delta:WarmupCounters,sign:number,email?:string) => {
      const id=`${owner}:${runId}:${kind}:${key}`
      let row=stats.get(id)
      if (!row) {const stored=await this.store.get<{kind:'mailbox'|'day';key:string;email?:string;totals:WarmupCounters}>('warmup-run-stats',id);current();row={revision:stored?.revision??null,value:stored?.value??{kind,key,totals:emptyWarmupCounters()},runId};stats.set(id,row)}
      if(email)row.value.email=email
      addWarmupCounters(row.value.totals,delta,sign)
    }
    for (const message of messages) {
      const id=`${owner}:${message.runId}:${message.id}`,previous=await this.store.get<WarmupRunMessage>('warmup-run-messages',id);current()
      if (previous && JSON.stringify(previous.value)===JSON.stringify(message)) continue
      const run=await readRun(message.runId)
      for (const [job,sign] of [[previous?.value,-1],[message,1]] as const) if (job) {
        const counts=warmupMessageCounters(job);addWarmupCounters(run.totals,counts,sign)
        await changeStats(job.runId,'mailbox',job.fromProfileId,counts,sign,job.from)
        await changeStats(job.runId,'day',new Date(job.dueAt).toISOString().slice(0,10),counts,sign)
      }
      writes.push({collection:'warmup-run-messages',id,value:message,owner,account:message.runId})
      checks.push({collection:'warmup-run-messages',id,revision:previous?.revision??null})
    }
    if (options.runId) {const run=await readRun(options.runId);run.status=options.enabled?'running':'paused';run.reason=options.reason}
    if (options.finish) {const run=await readRun(options.finish);run.status='finished';run.endedAt=options.now;run.reason=options.reason??'Finished by you'}
    for (const [id,run] of runs) {writes.push({collection:'warmup-runs',id:`${owner}:${id}`,value:run,owner});checks.push({collection:'warmup-runs',id:`${owner}:${id}`,revision:originals.get(id)??null})}
    for (const [id,row] of stats) {writes.push({collection:'warmup-run-stats',id,value:row.value,owner,account:row.runId});checks.push({collection:'warmup-run-stats',id,revision:row.revision})}
    for (const entry of options.usage??[]) {
      const account=hash(`${entry.runId}:${entry.value.pair}`),id=`${owner}:${account}:${entry.value.cycle}:${entry.value.templateId}`
      writes.push({collection:'warmup-rotation',id,value:entry.value,owner,account,status:String(entry.value.cycle)})
      checks.push({collection:'warmup-rotation',id,revision:null})
      const cycleId=`${owner}:${account}`,cycle=await this.store.get<{cycle:number}>('warmup-rotation-cycles',cycleId);current()
      writes.push({collection:'warmup-rotation-cycles',id:cycleId,value:{cycle:Math.max(entry.value.cycle,cycle?.value.cycle??0)},owner})
      checks.push({collection:'warmup-rotation-cycles',id:cycleId,revision:cycle?.revision??null})
      if(cycle&&cycle.value.cycle<entry.value.cycle){let after:string|undefined;do{const previous=await this.store.list<WarmupUsage>('warmup-rotation',{owner,account,status:String(cycle.value.cycle),limit:100,...(after?{after}:{})});current();for(const row of previous)writes.push({collection:'warmup-rotation',id:row.id,delete:true});after=previous.length===100?previous.at(-1)!.id:undefined}while(after)}
    }
    return {writes,checks}
  }
  async choose(owner:string,runId:string,studio:WarmupStudioConfig,from:WarmupAddress,to:WarmupAddress,now:number,current:()=>void):Promise<{content:WarmupContent;usage:WarmupUsage}> {
    const pair=[from.id,to.id].sort().join(':'),account=hash(`${runId}:${pair}`)
    const last=await this.store.list<WarmupUsage>('warmup-rotation',{owner,account,limit:1});current()
    // Cycle is held in a separate small record so selection never scans older cycles.
    const cycleRow=await this.store.get<{cycle:number}>('warmup-rotation-cycles',`${owner}:${account}`);current()
    let cycle=cycleRow?.value.cycle??last[0]?.value.cycle??0
    for(let pass=0;pass<2;pass++,cycle++) {
      const used=new Set<string>(),fingerprints=new Set<string>();let after:string|undefined
      do {
        const rows=await this.store.list<WarmupUsage>('warmup-rotation',{owner,account,status:String(cycle),limit:100,...(after?{after}:{})});current()
        rows.forEach(row=>{used.add(row.value.templateId);fingerprints.add(row.value.fingerprint)})
        after=rows.length===100?rows.at(-1)!.id:undefined
      } while(after)
      const seed=`${runId}:${pair}:${cycle}`
      for(const template of orderedWarmupTemplates(studio,seed)) {
        if(used.has(template.id))continue
        let content:WarmupContent
        try{content=renderWarmupContent(template,studio,from,to,`${seed}:${template.id}`,now)}catch(error){throw new WarmupPreparationError(error instanceof Error?error.message:'Invalid message template')}
        const fingerprint=hash(JSON.stringify([content.subject.trim().toLowerCase(),content.messages[0].trim().replace(/\s+/g,' ').toLowerCase()]))
        if(!fingerprints.has(fingerprint))return {content,usage:{pair,cycle,templateId:template.id,fingerprint}}
      }
      if(studio.exhaustion!=='repeat')break
    }
    throw new WarmupPreparationError('The unique message pool for this mailbox pair is exhausted. Add templates or start a run that allows repeating the pool.')
  }
  async workspace(owner:string,raw:unknown,current:()=>void):Promise<WarmupWorkspaceResult> {
    const args=parseWarmupWorkspaceRequest(raw);current()
    const after='after'in args?args.after:undefined
    if(after && (!after.startsWith(`${owner}:`)||after.length>1024))throw new Error('History cursor belongs to another mail workspace')
    if(args.action==='runs') {
      const rows=await this.store.list<{runId:string}>('warmup-run-index',{owner,limit:args.limit??50,...(after?{after}:{})});current()
      // A full page may have a following page; querying it is cheap and keeps completion honest.
      const more=rows.length===(args.limit??50)?await this.store.list('warmup-run-index',{owner,limit:1,after:rows.at(-1)!.id}):[];current()
      const runs:WarmupRun[]=[]
      for(const item of rows){const row=await this.store.get<WarmupRun>('warmup-runs',`${owner}:${item.value.runId}`);current();if(!row)throw new Error('Saved run is unavailable');runs.push({...row.value,config:undefined})}
      return {ok:true,runs,hasMore:more.length>0,...(more.length?{nextCursor:rows.at(-1)!.id}:{})}
    }
    const run=await this.store.get<WarmupRun>('warmup-runs',`${owner}:${args.runId}`);current()
    if(!run)throw new Error('The saved run is unavailable in this mail workspace')
    if(args.action==='finish')throw new Error('Finish must use the authorized scheduler transaction')
    if(args.action==='messages') {
      if(after&&!after.startsWith(`${owner}:${args.runId}:`))throw new Error('History cursor belongs to another run')
      const rows=await this.store.list<WarmupRunMessage>('warmup-run-messages',{owner,account:args.runId,limit:args.limit??50,...(after?{after}:{})});current()
      const more=rows.length===(args.limit??50)?await this.store.list('warmup-run-messages',{owner,account:args.runId,limit:1,after:rows.at(-1)!.id}):[];current()
      const messages:WarmupRunMessage[]=[]
      for(const row of rows){const payload=await this.store.get<{body:string}>('warmup-payloads',`${owner}:${row.value.id}`);current();messages.push({...row.value,body:payload?.value.body??''})}
      return {ok:true,messages,hasMore:more.length>0,...(more.length?{nextCursor:rows.at(-1)!.id}:{})}
    }
    const mailboxes:{id:string;email?:string;totals:WarmupCounters}[]=[],days:{day:string;totals:WarmupCounters}[]=[]
    let cursor:string|undefined
    do {
      const page=await this.store.list<{kind:'mailbox'|'day';key:string;email?:string;totals:WarmupCounters}>('warmup-run-stats',{owner,account:args.runId,limit:100,...(cursor?{after:cursor}:{})});current()
      for(const row of page) {if(row.value.kind==='mailbox')mailboxes.push({id:row.value.key,...(row.value.email?{email:row.value.email}:{}),totals:row.value.totals});else days.push({day:row.value.key,totals:row.value.totals})}
      cursor=page.length===100?page.at(-1)!.id:undefined
    } while(cursor)
    const latest=await this.store.get<WarmupRun>('warmup-runs',`${owner}:${args.runId}`);current()
    if(latest?.revision!==run.revision)throw new Error('Run totals changed while loading. Refresh the report.')
    return {ok:true,run:run.value,mailboxes,days:days.sort((a,b)=>a.day.localeCompare(b.day))}
  }
}
