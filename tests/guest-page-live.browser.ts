/** Real generated share/portal scripts over isolated HTTP. No native app or Docker changes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { guestPageScripts } from './_guest-page-scripts.js'
import { guestPageDocument } from '../src/guest-page-theme.js'
const {chromium,expect}=createRequire(new URL('../../../apps/desktop/package.json',import.meta.url))('@playwright/test')
const scripts=guestPageScripts(), cases:string[]=[]
let kind='share', mode='read', title='Initial shared record', password='', revoked=false, expires=false, authMode='anonymous', otpUnlocked=false, throttle=false, requests=0, active=0, maxActive=0, hold=false, release:(()=>void)|null=null
const fields=()=>[{slug:'title',name:'Title',field_type:'text',required:true,config:{},default_value:''}]
let schema=fields(), portalActions=['create'], contentModeOverride:string|null=null
const server=createServer(async(req,res)=>{
 const isJson=String(req.headers.accept||'').includes('application/json')
 if(!isJson){res.setHeader('Content-Type','text/html');res.end(guestPageDocument({title:'Live guest audit',bodyHtml:'<div id="app">Loading</div>',scriptJs:scripts[kind==='share'?'guestShareShellHtml':'guestPortalShellHtml']}));return}
 requests++;active++;maxActive=Math.max(maxActive,active)
 res.on('close',()=>active--)
 const send=(status:number,data:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data))}
 let raw='';for await(const chunk of req)raw+=chunk
 const body=raw?JSON.parse(raw):{}, allowed=!password||body.password===password||body.pin===password
 const content={version:2,mode:contentModeOverride||mode,viewType:mode==='read'?'table':'form',label:'Shared audit',name:'Portal audit',design:{},fields:schema,rows:[{id:'one',data:{title}}],total:1,truncated:false,allowedActions:['create']}
 const result=()=>kind==='share'?{ok:true,unlocked:allowed,needs_password:!!password,share:{mode,viewType:content.viewType},content:allowed?content:null}:{ok:true,unlocked:authMode==='magic_link'?otpUnlocked:allowed,needs_pin:authMode==='pin',needs_otp:authMode==='magic_link',auth_mode:authMode,portal:{name:'Portal audit',allowed_actions:portalActions},content:(authMode==='magic_link'?otpUnlocked:allowed)?content:null}
 const captured=result()
 if(hold){hold=false;await new Promise<void>(resolve=>release=resolve)}
 if(throttle){res.setHeader('Retry-After','10');send(429,{error:'Busy'});return}
 if(revoked||expires){send(410,{error:revoked?'This link was revoked':'This link has expired'});return}
 if(req.method==='POST'&&!allowed){send(401,{error:'Wrong password'});return}
 if(body.action==='verify_otp'){otpUnlocked=true;send(200,result());return}
 if(body.action==='create'){send(200,{ok:true,submitted:true,message:'Received'});return}
 send(200,captured)
})
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+ (server.address() as any).port
const browser=await chromium.launch({channel:'chrome',headless:true})
const page=await browser.newPage();page.setDefaultTimeout(10000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
await page.clock.install()
async function refresh(){await page.clock.fastForward(1600);await page.evaluate(()=>window.dispatchEvent(new Event('focus')))}
async function open(){await page.goto(url+'/'+kind+'/test-token')}
try{
 await open();await expect(page.getByText(title,{exact:true})).toBeVisible();title='Latest shared record';await page.clock.fastForward(19000);await expect(page.getByText(title,{exact:true})).toBeVisible();await expect(page.getByText('Initial shared record',{exact:true})).toHaveCount(0);cases.push('open-read-share-refreshes-payload')
 revoked=true;await refresh();await expect(page.getByText('This link was revoked',{exact:true})).toBeVisible();await expect(page.getByText(title,{exact:true})).toHaveCount(0);cases.push('revoked-open-share-removes-read-data')
 revoked=false;password='first';await open();await expect(page.locator('#pw')).toBeVisible();await page.locator('#pw').fill('first');await page.locator('#go').click();await expect(page.getByText(title,{exact:true})).toBeVisible();title='Protected latest';await refresh();await expect(page.getByText(title,{exact:true})).toBeVisible();password='second';await refresh();await expect(page.locator('#pw')).toBeVisible();await expect(page.getByText(title,{exact:true})).toHaveCount(0);await page.locator('#pw').fill('second');await page.locator('#go').click();await expect(page.getByText(title,{exact:true})).toBeVisible();cases.push('password-revalidated-and-rotation-removes-protected-data')
 mode='create';password='';await open();await page.locator('[data-slug=title]').fill('My unsent words');schema=[...fields(),{slug:'note',name:'Note',field_type:'text',required:false,config:{},default_value:''}];await refresh();await expect(page.locator('[data-slug=note]')).toBeVisible();await expect(page.locator('[data-slug=title]')).toHaveValue('My unsent words');await expect(page.locator('#sub')).toBeDisabled();await page.getByRole('button',{name:'I reviewed the current form'}).click();await expect(page.locator('#sub')).toBeEnabled();cases.push('updated-form-preserves-draft-and-requires-review')
 schema=schema.filter(f=>f.slug!=='title');await refresh();await expect(page.locator('[data-slug=title]')).toHaveCount(0);await expect(page.getByLabel('Preserved unsent draft')).toHaveValue(/My unsent words/);expires=true;await refresh();await expect(page.getByText('This link has expired',{exact:true})).toBeVisible();await expect(page.locator('#sub')).toHaveCount(0);await expect(page.getByLabel('Preserved unsent draft')).toHaveValue(/My unsent words/);cases.push('removed-field-and-expiry-preserve-only-guest-draft')
 expires=false;schema=fields();kind='portal';authMode='pin';password='1234';await open();await page.locator('#pin').fill('1234');await page.locator('#go').click();await expect(page.locator('#sub')).toBeVisible();await page.locator('[data-slug=title]').fill('Portal draft');password='5678';await refresh();await expect(page.locator('#pin')).toBeVisible();await expect(page.locator('#sub')).toHaveCount(0);await page.locator('#pin').fill('5678');await page.locator('#go').click();await expect(page.locator('[data-slug=title]')).toHaveValue('Portal draft');await page.getByRole('button',{name:'I reviewed the current form'}).click();cases.push('pin-rotation-gates-open-portal-and-restores-draft')
 authMode='magic_link';password='';otpUnlocked=true;await open();await expect(page.locator('#sub')).toBeVisible();await page.locator('[data-slug=title]').fill('OTP draft');otpUnlocked=false;await refresh();await expect(page.locator('#otp-email')).toBeVisible();await expect(page.locator('#sub')).toHaveCount(0);await page.locator('#otp-email').fill('test@example.test');await page.locator('#otp-code').fill('111111');await refresh();await expect(page.locator('#otp-email')).toHaveValue('test@example.test');await expect(page.locator('#otp-code')).toHaveValue('111111');await page.locator('#verify-code').click();await expect(page.locator('[data-slug=title]')).toHaveValue('OTP draft');await page.getByRole('button',{name:'I reviewed the current form'}).click();cases.push('otp-expiry-hides-form-and-reauth-restores-draft')
 portalActions=[];await refresh();await expect(page.getByText('This portal does not accept new records.',{exact:true})).toBeVisible();await expect(page.locator('#sub')).toHaveCount(0);await expect(page.getByLabel('Preserved unsent draft')).toHaveValue(/OTP draft/);portalActions=['create'];await refresh();await expect(page.locator('[data-slug=title]')).toHaveValue('OTP draft');await page.getByRole('button',{name:'I reviewed the current form'}).click();cases.push('portal-action-removal-overrides-stale-payload-and-restores-draft-on-grant')
 throttle=true;await refresh();await expect(page.locator('#sub')).toBeDisabled();const before=requests;await refresh();await refresh();assert.equal(requests,before,'focus checks must obey Retry-After');throttle=false;await page.clock.fastForward(11000);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(page.locator('#sub')).toBeEnabled();await expect(page.locator('[data-slug=title]')).toHaveValue('OTP draft');cases.push('429-retry-after-pauses-submit-and-prevents-focus-flood')
 // A poll resolving after a newer successful auth response must not repaint the old gate.
 otpUnlocked=false;hold=true;await refresh();await expect.poll(()=>!!release).toBe(true);await page.evaluate(()=>window.dispatchEvent(new Event('focus')));assert.ok(maxActive<=1,'background polls must not overlap');release!();await expect(page.locator('#otp-email')).toBeVisible();cases.push('no-overlapping-background-requests')
 release=null;hold=true;await refresh();await expect.poll(()=>!!release).toBe(true);await page.locator('#otp-email').fill('test@example.test');await page.locator('#otp-code').fill('222222');await page.locator('#verify-code').click();await expect(page.locator('#sub')).toBeVisible();release!();await page.waitForTimeout(100);await expect(page.locator('#otp-email')).toHaveCount(0);await expect(page.locator('[data-slug=title]')).toHaveValue('OTP draft');cases.push('late-locked-poll-cannot-overwrite-newer-successful-auth')
 await page.getByRole('button',{name:'I reviewed the current form'}).click();revoked=true;await page.locator('#sub').click();await expect(page.getByText('This link was revoked',{exact:true})).toBeVisible();await expect(page.locator('#sub')).toHaveCount(0);await expect(page.getByLabel('Preserved unsent draft')).toHaveValue(/OTP draft/);cases.push('revoked-submit-immediately-locks-page-and-preserves-draft')
 revoked=false;kind='share';mode='create';await open();await page.locator('[data-slug=title]').fill('Mode-change draft');mode='read';contentModeOverride='create';await refresh();await expect(page.locator('#sub')).toHaveCount(0);await expect(page.getByLabel('Preserved unsent draft')).toHaveValue(/Mode-change draft/);cases.push('share-read-mode-overrides-stale-create-payload')
 assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'passed',boundary:'Actual generated guest scripts with isolated HTTP fixture; no Docker/native server launched',cases},null,2))
}finally{await browser.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
