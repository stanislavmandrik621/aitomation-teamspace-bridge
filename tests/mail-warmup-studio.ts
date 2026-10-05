import assert from 'node:assert/strict'
import { defaultWarmupStudio, parseWarmupStudio, renderWarmupContent, orderedWarmupTemplates, warmupWorkingNow, warmupPairAllowed, warmupSpacingMinutes, parseWarmupWorkspaceRequest, parseWarmupWorkspaceResult, emptyWarmupCounters } from '../src/mail-warmup-studio.js'
const studio = { ...defaultWarmupStudio(), includeBuiltIn: false, variables: { topic: ['Planning', 'Design', 'Research'] }, templates: [
  { id: 'custom-a', revision: 3, name: 'A', subject: '{{topic}} for {{recipient_name}}', message: 'Hi {{recipient_name}}, let us discuss {{topic}}. From {{sender_name}}.', replies: ['Hi {{recipient_name}}, {{topic}} sounds good. From {{sender_name}}.'], weight: 1, enabled: true },
] }
assert.deepEqual(parseWarmupStudio(studio), studio)
const from = { id:'a',email:'alex@example.test',name:'Alex'},to={id:'b',email:'sam@other.test',name:'Sam'}
const content = renderWarmupContent(studio.templates[0],studio,from,to,'consistent',0)
assert.match(content.messages[0],/^Hi Sam,/);assert.match(content.messages[1],/^Hi Alex,/)
assert.equal(content.messages[0].split('discuss ')[1].split('.')[0],content.messages[1].split(', ')[1].split(' sounds')[0])
assert.deepEqual(content,renderWarmupContent(studio.templates[0],studio,from,to,'consistent',0),'recovery never redraws variable substitutions')
assert.equal(content.revision,3)
assert.throws(()=>parseWarmupStudio({...studio,templates:[{...studio.templates[0],message:'{{missing}}'}]}),/Provide a value/)
assert.throws(()=>parseWarmupStudio({...studio,variables:JSON.parse('{"__proto__":["bad"]}')}),/Invalid/)
assert.throws(()=>parseWarmupStudio({...studio,templates:[{...studio.templates[0],subject:'Subject\r\nBcc: attacker@test'}]}),/Subject/)
assert.throws(()=>parseWarmupStudio({...studio,timeZone:'Nowhere/Invalid'}),/timezone/)
assert.throws(()=>parseWarmupStudio({...studio,startMinute:0,endMinute:0}),/nonempty/)
assert.throws(()=>parseWarmupStudio({...studio,weekdays:[]}),/days/)
assert.throws(()=>parseWarmupStudio({...studio,templates:Array.from({length:1001},(_,i)=>({...studio.templates[0],id:`custom-${i}`}))}),/1,000/)
const large={...studio,templates:Array.from({length:150},(_,i)=>({...studio.templates[0],id:`custom-${i}`,message:'x'.repeat(1000)}))}
assert.throws(()=>parseWarmupStudio(large),/128 KiB/)
const expansion={...studio,variables:{topic:['😀'.repeat(250)]},templates:[{...studio.templates[0],subject:'Normal',message:'{{topic}}'.repeat(40),replies:[]}]}
assert.throws(()=>renderWarmupContent(expansion.templates[0],expansion,from,to,'a',0),/32 KiB/)
const schedule={...studio,timeZone:'America/New_York',weekdays:[1],startMinute:22*60,endMinute:2*60}
assert.equal(warmupWorkingNow(schedule,Date.parse('2026-09-22T03:00:00Z')),true,'Monday overnight')
assert.equal(warmupWorkingNow(schedule,Date.parse('2026-09-22T05:59:00Z')),true)
assert.equal(warmupWorkingNow(schedule,Date.parse('2026-09-22T06:00:00Z')),false)
assert.equal(warmupWorkingNow(schedule,Date.parse('2026-09-23T03:00:00Z')),false)
const permutation={...studio,templates:Array.from({length:100},(_,i)=>({...studio.templates[0],id:`custom-${i}`,weight:i+1}))}
const shuffled=orderedWarmupTemplates(permutation,'seed').map(t=>t.id)
assert.equal(new Set(shuffled).size,100);assert.deepEqual(shuffled,orderedWarmupTemplates(permutation,'seed').map(t=>t.id))
assert.notDeepEqual(shuffled,orderedWarmupTemplates(permutation,'different').map(t=>t.id))
assert.deepEqual(orderedWarmupTemplates({...permutation,rotation:'sequential'},'a').map(t=>t.id),permutation.templates.map(t=>t.id))
assert.equal(warmupPairAllowed({...studio,pairing:'cross-domain'},from,to),true)
assert.equal(warmupPairAllowed({...studio,pausedProfileIds:['a']},from,to),false)
for(let i=0;i<100;i++){const spacing=warmupSpacingMinutes(studio,30,'a',i);assert.ok(spacing>=30&&spacing<=40)}
assert.throws(()=>parseWarmupWorkspaceRequest({action:'messages',runId:'a',projectId:'forged'}),/Unexpected/)
const row={id:'run',name:'Run',startedAt:1,endedAt:null,status:'running',reason:null,totals:emptyWarmupCounters(),config:{private:'secret'},token:'private-proof'}
assert.doesNotMatch(JSON.stringify(parseWarmupWorkspaceResult({ok:true,runs:[row],hasMore:false})),/secret|proof|token|config/)
console.log('PASS shared warm-up studio: validation, alternating reply variables, Unicode capacity, deterministic rotation, overnight timezone schedules and public projection')
