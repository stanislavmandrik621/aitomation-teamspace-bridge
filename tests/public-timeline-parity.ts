import assert from 'node:assert/strict'
import { GUEST_ESC_JS,GUEST_RENDER_JS } from '../src/guest-page-render.js'
const api=new Function(GUEST_ESC_JS+GUEST_RENDER_JS+';return {render:renderTimelineBodyHtml,time:guestTlTimestamp}')()
const content={fields:[{slug:'name',field_type:'text'},{slug:'start',field_type:'datetime'},{slug:'end',field_type:'datetime'}],rows:[{id:'a',data:{name:'Morning',start:'2026-09-11T09:00:00Z',end:'2026-09-11T10:00:00Z'}},{id:'b',data:{name:'Afternoon',start:'2026-09-11T15:00:00Z',end:'2026-09-11T16:00:00Z'}}],viewConfig:{startDateFieldSlug:'start',endDateFieldSlug:'end',titleFieldSlug:'name'}}
assert.equal(api.time(content.rows[1],'start','start','datetime')-api.time(content.rows[0],'start','start','datetime'),6*3600000)
assert.match(api.render(content,1,0),/data-axis-days="7"/);
const html=api.render(content,7,0);assert.match(html,/data-axis-days="7"/);assert.match(html,/Morning/);assert.match(html,/Afternoon/)
assert.doesNotMatch(api.render(content,7,7*86400000),/class="tl-bar"/)
for(const zone of ['America/New_York','Asia/Makassar']){process.env.TZ=zone;const row={data:{start:'2026-03-08'}};const value=api.time(row,'start','start','date');assert.equal(new Date(value).getHours(),0);assert.equal(new Date(value).getDate(),8)}
console.log('PASS timeline timestamp precision, saved span, offscreen bars and local date-only midnight')
