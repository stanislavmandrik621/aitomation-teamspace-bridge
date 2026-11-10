import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { GUEST_ESC_JS, GUEST_RENDER_JS } from '../src/guest-page-render.js'
import { GUEST_PAGE_CSS } from '../src/guest-page-theme.js'
const require=createRequire(new URL('../../../apps/desktop/package.json',import.meta.url))
const {chromium,expect}=require('@playwright/test')
const renderer=new Function(GUEST_ESC_JS+GUEST_RENDER_JS+';return {cal:renderCalendarHtml,feed:renderFeedHtml}')()
const now=new Date(),date=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
const make=(name:string)=>({entityId:name,fields:[{slug:'name',field_type:'text'},{slug:'due',field_type:'date'}],rows:[{id:name,data:{name,due:date}}],viewConfig:{dateFieldSlug:'due',calendarRange:'day'},total:1})
const feed={entityId:'feed',fields:[{slug:'name',field_type:'text'}],rows:[],events:[{id:'a',kind:'updated',createdAt:new Date().toISOString(),summary:'Updated record',payload:{}},{id:'b',kind:'comment',createdAt:new Date().toISOString(),summary:'Comment',payload:{comment:'Public comment'}}],eventsTruncated:false}
const browser=await chromium.launch({headless:true,channel:'chrome'})
try{
 const page=await browser.newPage({viewport:{width:780,height:900}})
 await page.setContent('<style>'+GUEST_PAGE_CSS+'</style>'+renderer.cal(make('Calendar A'))+renderer.cal(make('Calendar B'))+renderer.feed(feed)+'<script>'+GUEST_ESC_JS+GUEST_RENDER_JS+'</script>')
 const roots=page.locator('[data-guest-calendar]')
 await roots.nth(0).getByRole('button',{name:'Next day',exact:true}).click();await expect(roots.nth(0).getByText('Calendar A',{exact:true})).toHaveCount(0)
 await expect(roots.nth(1).getByText('Calendar B',{exact:true})).toBeVisible()
 await roots.nth(0).getByRole('button',{name:'Today',exact:true}).click();await expect(roots.nth(0).getByText('Calendar A',{exact:true})).toBeVisible();await expect(roots.nth(0).getByText('Calendar B',{exact:true})).toHaveCount(0)
 await page.locator('label[for=gfk-updated]').click();await expect(page.locator('#gfk-updated')).toBeChecked();await expect(page.getByText('Public comment',{exact:true})).toBeHidden()
 await page.locator('#gfk-updated').focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#gfk-comment')).toBeChecked();await expect(page.getByText('Public comment',{exact:true})).toBeVisible()
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))

 const chart={fields:[{slug:'name',field_type:'text'},{slug:'value',field_type:'number'}],rows:[{id:'a',data:{name:'A',value:5}},{id:'b',data:{name:'B',value:6}}],viewConfig:{xFieldSlug:'name',yFieldSlug:'value',chartType:'bar',yAgg:'sum'}}
 await page.evaluate(content=>{document.body.innerHTML=renderChartHtml(content);enhanceGuestChart()},chart)
 for(const width of [390,1440,650]){
  await page.setViewportSize({width,height:850})
  await expect.poll(()=>page.evaluate(()=>{const text=document.querySelector('.chart-svg text');return text?Number(text.getAttribute('font-size'))*text.getScreenCTM().a:0})).toBeGreaterThanOrEqual(10)
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
 }
 console.log('PASS independent calendars, Feed filters and readable chart labels across live viewport resizing')
}finally{await browser.close()}
