/** Real encrypted storage and scheduler, with a provider boundary fixture. Never sends live mail. */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailStore } from '../src/mail-store.js'
import { OAuthMailWarmup, DEFAULT_OAUTH_WARMUP_CONFIG, type OAuthWarmupAdapter, type OAuthWarmupJob } from '../src/mail-warmup.js'
import { defaultWarmupStudio, parseWarmupWorkspaceResult } from '../src/mail-warmup-studio.js'
import { saveMailRetentionPolicy } from '../src/mail-retention.js'
const directory=realpathSync(mkdtempSync(join(tmpdir(),'warmup-studio-real-'))), key={key:randomBytes(32)}
let store=new MailStore({dataDir:directory,key}), now=Date.now(), current=true
const owner={teamId:randomUUID(),memberId:randomUUID(),projectId:randomUUID(),deviceId:randomUUID()}
const boxes=[{id:'a',provider:'google' as const,email:'alex@controlled.invalid',fingerprint:'a'},{id:'b',provider:'microsoft' as const,email:'sam@other.invalid',fingerprint:'b'}]
const sent:OAuthWarmupJob[]=[], received=new Set<string>()
const adapter:OAuthWarmupAdapter={mailboxes:async(_owner,ids)=>boxes.filter(box=>ids.includes(box.id)),fence:(_ids,live)=>live,
 send:async(_owner,_box,job,live)=>{assert.ok(live());sent.push(structuredClone(job));return {status:'accepted',providerMessageId:`sent_${sent.length}`}},
 receipt:async(_owner,_box,job)=>received.has(job.id)?{id:`received_${job.id}`,rfcId:job.rfcId,from:job.from,to:[job.to],subject:job.subject,text:`Test reference: ${job.token}`}:null}
let engine=new OAuthMailWarmup(store,adapter,()=>now)
const config={...DEFAULT_OAUTH_WARMUP_CONFIG,enabled:true,profileIds:['a','b'],startDailyLimit:100,maxDailyLimit:100,minIntervalMinutes:5,maxExchanges:1,
 studio:{...defaultWarmupStudio(),includeBuiltIn:false,intervalJitterMinutes:0,rotation:'sequential' as const,templates:Array.from({length:61},(_,i)=>({id:`custom-${i}`,revision:2,name:`Message ${i}`,subject:`Topic ${i}`,message:`Conversation ${i} for {{recipient_name}}. ${'Body '.repeat(200)}`,replies:[],weight:1,enabled:true}))}}
const approved=boxes.map(({id,email})=>({id,email})), live=()=>current
const report=async(id:string)=>{const result=parseWarmupWorkspaceResult(await engine.workspace(owner,{action:'report',runId:id},live));assert.ok(result.ok&&result.run);return result}
try{
 await store.ready()
 const saved=await engine.save(owner,config,true,live,approved,'start'),runId=saved.state.activeRunId!
 assert.ok(runId);assert.equal(sent.length,0)
 for(let i=0;i<61;i++){
   await engine.tick(owner,live)
   assert.equal(sent.length,i+1)
   received.add(sent.at(-1)!.id);now+=5*60_000
 }
 // Receive final message, then exhaust exactly the saved pool without repeating.
 await engine.tick(owner,live)
 assert.equal(sent.length,61);assert.equal((await engine.get(owner,live)).state.config.enabled,false)
 assert.match((await engine.get(owner,live)).state.pauseReason!,/exhausted/)
 const totals=(await report(runId)).run!.totals
 assert.equal(totals.accepted,61);assert.equal(totals.received,61);assert.equal(totals.failed,0)
 assert.equal(new Set(sent.map(job=>job.templateId)).size,61)
 assert.ok(sent.every(job=>job.text.includes('Automated delivery test')))
 let cursor:string|undefined;const messages=[]
 do{const page=parseWarmupWorkspaceResult(await engine.workspace(owner,{action:'messages',runId,limit:13,...(cursor?{after:cursor}:{})},live));assert.ok(page.ok);messages.push(...page.messages!);cursor=page.nextCursor}while(cursor)
 assert.equal(messages.length,61);assert.equal(new Set(messages.map(job=>job.id)).size,61)
 assert.doesNotMatch(JSON.stringify(messages),/Test reference|private-proof|token|rfcId/)
 assert.ok(messages.every(job=>job.body.startsWith('Conversation')&&job.templateRevision===2))
 await assert.rejects(engine.workspace({...owner,projectId:randomUUID()},{action:'report',runId},live),/unavailable/)
 await assert.rejects(engine.save(owner,{...config,studio:{...config.studio,name:'Changed'}},true,live,approved,'resume'),/new run/)
 await store.close();store=new MailStore({dataDir:directory,key});await store.ready();engine=new OAuthMailWarmup(store,adapter,()=>now)
 assert.equal((await report(runId)).run!.totals.accepted,61)
 await engine.save(owner,config,true,live,approved,'resume');await engine.tick(owner,live)
 assert.equal(sent.length,61,'restart and resume retain pool exhaustion')
 now+=1
 const second=await engine.save(owner,{...config,enabled:false,studio:{...config.studio,name:'Next launch'}},false,live,undefined,'start')
 assert.notEqual(second.state.activeRunId,runId);assert.equal((await report(runId)).run!.status,'finished')
 const runs=parseWarmupWorkspaceResult(await engine.workspace(owner,{action:'runs',limit:1},live));assert.ok(runs.ok&&runs.hasMore);assert.equal(runs.runs![0].id,second.state.activeRunId)
 const next=parseWarmupWorkspaceResult(await engine.workspace(owner,{action:'runs',after:runs.nextCursor,limit:1},live));assert.ok(next.ok);assert.equal(next.runs![0].id,runId)
 await engine.workspace(owner,{action:'finish',runId:second.state.activeRunId!},live)
 assert.equal((await engine.get(owner,live)).state.activeRunId,null)
 await saveMailRetentionPolicy(store,owner,{retentionDays:7,approveDeletion:true,expectedRevision:0},live)
 now+=8*86_400_000
 for(let i=0;i<3;i++)await engine.tick(owner,live)
 assert.equal((await report(runId)).run!.totals.received,61,'approved body removal preserves durable totals')
 const retained=parseWarmupWorkspaceResult(await engine.workspace(owner,{action:'messages',runId,limit:100},live));assert.ok(retained.ok)
 assert.ok(retained.messages!.every(message=>message.body===''&&message.subject.includes('Content removed')))
 // Custom reply content is frozen and alternates identities, including after reopen.
 const repliesConfig={...config,maxExchanges:3,studio:{...config.studio,templates:[{...config.studio.templates[0],message:'Initial for {{recipient_name}}',replies:['Reply to {{recipient_name}} from {{sender_name}}','Final to {{recipient_name}} from {{sender_name}}']}]}}
 const replyStart=await engine.save(owner,repliesConfig,true,live,approved,'start')
 const beforeReplies=sent.length
 await engine.tick(owner,live);received.add(sent.at(-1)!.id)
 now+=1;await engine.tick(owner,live)
 assert.equal((await engine.get(owner,live)).state.queued,1)
 await store.close();store=new MailStore({dataDir:directory,key});await store.ready();engine=new OAuthMailWarmup(store,adapter,()=>now)
 now+=30*60_000;await engine.tick(owner,live)
 assert.equal(sent.length,beforeReplies+2)
 const root=sent[beforeReplies],reply=sent.at(-1)!
 assert.equal(reply.from,root.to);assert.equal(reply.to,root.from)
 assert.ok(reply.text.startsWith(`Reply to ${root.from.split('@')[0]} from ${root.to.split('@')[0]}`))
 received.add(reply.id);now+=1;await engine.tick(owner,live);now+=30*60_000;await engine.tick(owner,live)
 assert.equal(sent.length,beforeReplies+3)
 assert.ok(sent.at(-1)!.text.startsWith(`Final to ${root.to.split('@')[0]} from ${root.from.split('@')[0]}`))
 const replyReport=await report(replyStart.state.activeRunId!)
 assert.equal(replyReport.run!.totals.replies,2)
 // A maximum enrollment plus a large library must remain under each encrypted row ceiling.
 const largeBoxes=Array.from({length:1000},(_,i)=>({id:`box-${String(i).padStart(59,'0')}`,provider:'google' as const,email:`owned-${i}@controlled.invalid`,fingerprint:'f'.repeat(64)}))
 const largeOwner={...owner,projectId:randomUUID()},largeEngine=new OAuthMailWarmup(store,{...adapter,mailboxes:async()=>largeBoxes},()=>now)
 const largeConfig={...config,profileIds:largeBoxes.map(box=>box.id),studio:{...config.studio,templates:config.studio.templates.map(t=>({...t,message:'x'.repeat(1800)}))}}
 await largeEngine.save(largeOwner,largeConfig,true,live,largeBoxes.map(({id,email})=>({id,email})),'start')
 assert.equal((await largeEngine.get(largeOwner,live)).state.config.profileIds.length,1000)
 assert.equal((await largeEngine.get(largeOwner,live)).state.config.studio!.templates[0].message.length,1800)
 // More than the former 500-write ceiling is valid within the unchanged byte bound.
 assert.equal(await store.batch(Array.from({length:600},(_,i)=>({collection:'capacity-fixture',id:`row-${i}`,value:{n:i}}))),true)
 await assert.rejects(store.batch(Array.from({length:2501},(_,i)=>({collection:'capacity-fixture',id:`large-${i}`,value:{n:i}}))),/Invalid/)
 await assert.rejects(store.batch(Array.from({length:100},(_,i)=>({collection:'capacity-fixture',id:`bytes-${i}`,value:{text:'x'.repeat(50000)}}))),/storage limit/)
 current=false;await assert.rejects(engine.workspace(owner,{action:'runs'},live))
 console.log('PASS encrypted warm-up studio: 61 unique durable sends, full reports/pagination, frozen bodies, restart/exhaustion, new run/finish, scope isolation, approved content expiry and bounded atomic batches')
}finally{await store.close();rmSync(directory,{recursive:true,force:true})}
