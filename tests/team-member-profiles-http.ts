/** Actual loopback HTTP requests through production profile handler/store, no Docker/native process. */
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {TeamMemberProfileStore,type ProfileFields} from '../src/team-member-profile-store.js'
import {createTeamMemberProfileHttpHandler} from '../src/team-member-profile-http.js'
const dir=mkdtempSync(join(tmpdir(),'profile-http-'))
const members=new Map([['admin',{memberId:'admin',displayName:'Admin',role:'admin'}],['bob',{memberId:'bob',displayName:'Bob',role:'member'}],['viewer',{memberId:'viewer',displayName:'Viewer',role:'viewer'}]])
const sessions=new Map([...members.keys()].map(id=>[id,{memberId:id,deviceId:id+'-device'}]))
let boundTeam='team-a',limited=false,afterBody:(()=>void)|null=null,releaseCount=0
const store=new TeamMemberProfileStore(dir,null,id=>members.get(id)??null)
const handler=createTeamMemberProfileHttpHandler({store,teamId:()=>boundTeam,authenticate:req=>{const session=sessions.get(String(req.headers.authorization??''));const member=session&&members.get(session.memberId);return session&&member?{member,deviceId:session.deviceId}:null},readBody:async(req,max)=>{const buffers=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw Error('Too large');buffers.push(chunk)}const body=JSON.parse(Buffer.concat(buffers).toString());afterBody?.();afterBody=null;return body},releaseBody:()=>{releaseCount++},json:(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body))},drain:req=>req.resume(),takeWrite:()=>!limited,retryAfterSeconds:()=>7})
const server=createServer((req,res)=>{void handler(req,res,new URL(req.url!,'http://localhost')).then(handled=>{if(!handled){res.writeHead(404);res.end()}})})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr==='object');const base='http://127.0.0.1:'+addr.port
const fields:ProfileFields={firstName:'Alex',lastName:'Doe',middleName:'',preferredName:'',title:'Designer',responsibilities:'Same module records',skills:['Research'],languages:[],availability:'Weekdays',timezone:'Pacific/Kiritimati',workHours:''}
const post=(actor:string,memberId:string,version:number,commandId:string,extra={})=>fetch(base+'/api/team-member-profile',{method:'POST',headers:{authorization:actor,'content-type':'application/json'},body:JSON.stringify({teamId:'team-a',memberId,expectedVersion:version,commandId,...fields,...extra})})
const get=(actor:string,team='team-a',member='bob',suffix='')=>fetch(base+'/api/team-member-profile'+suffix+'?'+new URLSearchParams({teamId:team,memberId:member}),{headers:{authorization:actor}})
try{
 assert.equal((await get('')).status,401);assert.equal((await get('viewer','foreign-team')).status,403)
 const viewer=await post('viewer','viewer',0,'self');assert.equal(viewer.status,200);assert.equal((await viewer.json()).data.role,'viewer');assert.equal((await post('viewer','bob',0,'other')).status,403)
 const contest=await Promise.all(Array.from({length:100},(_,i)=>post('bob','bob',0,'race-'+i,{title:'Editor '+i})));assert.equal(contest.filter(r=>r.status===200).length,1);assert.equal(contest.filter(r=>r.status===409).length,99)
 const latest=await (await get('viewer')).json();assert.equal(latest.data.profile.version,1);assert.equal(latest.data.profile.updatedBy,'bob');assert.equal(latest.data.profile.timezone,'Pacific/Kiritimati')
 const winner=contest.findIndex(r=>r.status===200),retry=await post('bob','bob',0,'race-'+winner,{title:'Editor '+winner});assert.equal(retry.status,200);assert.equal((await retry.json()).data.profile.version,1)
 afterBody=()=>members.set('admin',{memberId:'admin',displayName:'Admin',role:'viewer'});assert.equal((await post('admin','bob',1,'demoted-during-body')).status,403);members.set('admin',{memberId:'admin',displayName:'Admin',role:'admin'})
 afterBody=()=>sessions.delete('bob');assert.equal((await post('bob','bob',1,'revoked-during-body')).status,401);sessions.set('bob',{memberId:'bob',deviceId:'bob-device'})
 afterBody=()=>{boundTeam='team-b'};assert.equal((await post('admin','bob',1,'switched-team-during-body')).status,403);boundTeam='team-a'
 limited=true;const throttled=await post('bob','bob',1,'rate-limit');assert.equal(throttled.status,429);assert.equal(throttled.headers.get('retry-after'),'7');limited=false
 assert.equal((await post('bob','bob',1,'forged-attribution',{updatedAt:99999999999999})).status,400)
 const history=await get('viewer','team-a','bob','/history');assert.equal(history.status,200);const body=await history.json();assert.equal(body.data.total,1);assert.equal(history.headers.get('cache-control'),'no-store');assert.ok(releaseCount>=110)
 console.log('profile HTTP: 100 concurrent requests => 1 CAS winner/99 conflicts; Viewer self-edit/read, cross-team refusal, idempotent retry, mid-body role/session/team changes, Retry-After, attribution and history passed')
}finally{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));rmSync(dir,{recursive:true,force:true})}
