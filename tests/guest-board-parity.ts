import assert from 'node:assert/strict'
import { GUEST_ESC_JS, GUEST_GATE_JS, GUEST_RENDER_JS } from '../src/guest-page-render.js'
const runtime = new Function(GUEST_ESC_JS+GUEST_GATE_JS+GUEST_RENDER_JS+'\nreturn {render:renderReadBodyHtml, select:function(v){guestScrumSelected=v}}')()
const fields = [
 {slug:'name',name:'Name',field_type:'text',config:{}},
 {slug:'status',name:'Status',field_type:'status',config:{options:['Todo','Doing']}},
 {slug:'sprint',name:'Sprint',field_type:'select',config:{options:['Backlog','Sprint 1','Sprint 2']}},
 {slug:'points',name:'Points',field_type:'number',config:{}},
 {slug:'summary',name:'Summary',field_type:'text',config:{}},
]
const content = { version:2,viewType:'scrum',fields,columns:fields.map(f=>f.slug),rows:[
 {id:'a',data:{name:'BACKLOG_TASK',status:'Todo',sprint:'Backlog',points:3}},
 {id:'b',data:{name:'ACTIVE_ONE',status:'Doing',sprint:'Sprint 1',points:5}},
 {id:'c',data:{name:'ACTIVE_TWO',status:'Todo',sprint:'Sprint 2',points:8}},
],viewConfig:{groupByFieldSlug:'status',sprintFieldSlug:'sprint',pointsFieldSlug:'points',titleFieldSlug:'name'}}
let html=runtime.render(content).html
assert.match(html,/data-scrum-lane="__backlog__"/)
assert.match(html,/3 pts/);assert.match(html,/5 pts/);assert.match(html,/8 pts/)
assert.equal(html.split('BACKLOG_TASK').length-1,1,'backlog must not also appear in a status lane')
runtime.select('Sprint 1');html=runtime.render(content).html
assert.match(html,/BACKLOG_TASK/);assert.match(html,/ACTIVE_ONE/);assert.doesNotMatch(html,/ACTIVE_TWO/)
const hidden=runtime.render({...content,fields:fields.filter(f=>f.slug!=='sprint')}).html
assert.match(hidden,/fields are unavailable/);assert.doesNotMatch(hidden,/ACTIVE_ONE/)
const board=runtime.render({...content,viewType:'kanban',viewConfig:{groupByFieldSlug:'status',swimlaneFieldSlug:'sprint',sumFieldSlug:'points',titleFieldSlug:'name',cardFields:['points']}}).html
assert.match(board,/data-guest-swimlanes/);assert.match(board,/data-column-sum="5"/)
assert.equal(board.split('ACTIVE_ONE').length-1,1)
const malicious=runtime.render({...content,rows:[{id:'x',data:{name:'<img src=x onerror=alert(1)>',status:'Todo',sprint:'<script>attack</script>',points:2}}]}).html
assert.doesNotMatch(malicious,/<script>attack/);assert.match(malicious,/&lt;script&gt;/)
console.log('PASS Scrum backlog, sprint filtering, point totals, hidden bindings, Kanban swimlanes/sums and HTML escaping')
