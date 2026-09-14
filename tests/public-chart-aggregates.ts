import assert from 'node:assert/strict'
import { GUEST_ESC_JS, GUEST_RENDER_JS } from '../src/guest-page-render.js'
const api=new Function(GUEST_ESC_JS+GUEST_RENDER_JS+';return {buckets:chartBuckets,stacked:chartStackedData,num:numFromCell,pivot:pivotParseY}')()
for(const blank of [null,undefined,'',' ',false,{},'bad 9']){
 assert.equal(api.num({data:{value:blank}},'value'),null)
 assert.equal(api.pivot({data:{value:blank}},'value'),null)
}
assert.equal(api.num({data:{value:0}},'value'),0)
assert.equal(api.num({data:{value:'$ 1,200.50'}},'value'),1200.5)
const fields=[{slug:'category',field_type:'select'},{slug:'series',field_type:'select'},{slug:'value',field_type:'number'}]
const rows=[2,8,null,'',0].map(value=>({data:{category:'A',series:'One',value}}))
for(const [op,expected] of Object.entries({sum:10,avg:3.33,min:0,max:8,count:3})){
 const content={fields,rows,viewConfig:{xFieldSlug:'category',yFieldSlug:'value',seriesFieldSlug:'series',yAgg:op}}
 assert.deepEqual(api.buckets(content),[{k:'A',v:expected}])
 assert.equal(api.stacked(content).categories[0].v,expected)
}
const capped=[...Array.from({length:12},(_,i)=>({data:{category:'K'+i,value:1}})),{data:{category:'Rest A',value:2}},{data:{category:'Rest B',value:8}},{data:{category:'Rest B',value:10}}]
for(const [op,expected] of Object.entries({sum:20,avg:6.67,min:2,max:10,count:3}))assert.equal(api.buckets({fields,rows:capped,viewConfig:{xFieldSlug:'category',yFieldSlug:'value',yAgg:op}}).at(-1).v,expected)
console.log('PASS public numeric blanks, zero, flat/series aggregates and weighted overflow buckets')
