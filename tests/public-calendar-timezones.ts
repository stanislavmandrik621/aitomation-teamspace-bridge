import assert from 'node:assert/strict'
import { GUEST_ESC_JS,GUEST_RENDER_JS } from '../src/guest-page-render.js'
const render=new Function(GUEST_ESC_JS+GUEST_RENDER_JS+';return {model:calModel,render:calRender}')()
const content={fields:[{slug:'name',field_type:'text'},{slug:'due',field_type:'datetime'}],rows:[{id:'a',data:{name:'Midnight boundary',due:'2026-09-11T23:30:00Z'}}],viewConfig:{dateFieldSlug:'due'}}
const saved=process.env.TZ
try{
 for(const [zone,key,hour] of [['UTC','2026-09-11',23],['Asia/Makassar','2026-09-12',7],['America/New_York','2026-09-11',19]] as const){
  process.env.TZ=zone
  assert.deepEqual(Object.keys(render.model(content).byDay),[key])
  const html=render.render(content,'day',new Date(key+'T12:00:00'))
  assert.equal((html.match(/data-calendar-hour=/g)||[]).length,24)
  assert.ok(html.slice(html.indexOf('data-calendar-hour="'+hour+'"'),html.indexOf('data-calendar-hour="'+hour+'"')+600).includes('Midnight boundary'))
 }
 console.log('PASS Calendar datetime day/hour placement across UTC, Makassar and New York')
}finally{if(saved===undefined)delete process.env.TZ;else process.env.TZ=saved}
