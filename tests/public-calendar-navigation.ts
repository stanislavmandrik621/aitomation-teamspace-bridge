import assert from 'node:assert/strict'
import { GUEST_ESC_JS, GUEST_RENDER_JS } from '../src/guest-page-render.js'
const { render, range } = new Function(GUEST_ESC_JS + GUEST_RENDER_JS + ';return {render:calRender,range:calRange}')()
const field = (slug:string,type='text') => ({slug,name:slug,field_type:type})
const content = {fields:[field('name'),field('due','date_range')],rows:[
 {id:'range',data:{name:'Across month',due:{start:'2026-09-30',end:'2026-10-02'}}},
 {id:'unsafe',data:{name:'<script>unsafe</script>',due:{start:'2026-10-01',end:'2026-10-01'}}},
 {id:'none',data:{name:'Undated'}}],viewConfig:{dateFieldSlug:'due'}}
const date=new Date(2026,9,1)
for(const mode of ['month','week','day','agenda']) {
 const html=render(content,mode,date)
 assert.match(html,/Across month/)
 assert.match(html,/&lt;script&gt;unsafe/)
 assert.doesNotMatch(html,/<script>unsafe/)
 assert.match(html,new RegExp('data-calendar-range="'+mode+'" aria-pressed="true"'))
 assert.match(html,/1 record has no date/)
 if(mode==='agenda') assert.doesNotMatch(html,/data-calendar-nav="1"/)
 else assert.match(html,/data-calendar-nav="1"/)
}
assert.doesNotMatch(render(content,'month',new Date(2026,10,1)),/Across month/)
assert.match(render({...content,rows:[]},'month',date),/class="cal"/)
assert.equal(range('bad'),'month')
console.log('PASS shared calendar ranges, span boundaries, empty navigation and escaped titles')
