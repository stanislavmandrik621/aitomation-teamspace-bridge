/** Restore the archive produced by the real native chat export into a disposable server. */
import assert from 'node:assert/strict'
import {initializeCurrentAuthority} from '../src/independent-authority.js'
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'
import WebSocket from 'ws'
import {hashSessionToken} from '../src/store.js'
import {ChatStore} from '../src/chat-store.js'
import {ChatRoomsStore} from '../src/chat-rooms-store.js'
const manifestPath=process.argv[2];if(!manifestPath)throw Error('Native archive manifest required')
const fixture=JSON.parse(readFileSync(manifestPath,'utf8')),dir=mkdtempSync(join(tmpdir(),'native-chat-restore-')),sockets:WebSocket[]=[]
let child:ReturnType<typeof spawn>|undefined
try{
 execFileSync('python3',['-c',`import zipfile,sys,pathlib\nz=zipfile.ZipFile(sys.argv[1]);root=pathlib.Path(sys.argv[2]).resolve()\nfor n in z.namelist():\n if not n.startswith('chat/') or n.endswith('/'):continue\n p=(root/n).resolve()\n if not p.is_relative_to(root):raise ValueError('unsafe archive path')\n p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(z.read(n))`,fixture.zip,dir])
 const rooms=new ChatRoomsStore(dir,null),store=new ChatStore(dir,90,365,null)
 assert.equal(rooms.memberCanAccess(fixture.locked.room,fixture.bobId),true)
 assert.equal(rooms.memberCanAccess(fixture.locked.room,fixture.viewerId),false)
 assert.ok(rooms.get(fixture.locked.room)?.bannedMemberIds.includes(fixture.viewerId))
 assert.equal(rooms.verifyPassword(fixture.locked.room,'deep-password-two'),true)
 assert.equal(rooms.verifyPassword(fixture.locked.room,'deep-password-one'),false)
 assert.ok(store.getPinnedMessageIds(fixture.locked.room).includes(fixture.locked.message.id))
 const group=await store.readRecent(fixture.group.room,100);assert.ok(!group.messages.some(m=>m.id===fixture.group.message.id))
 const identities=[['admin',fixture.aliceId,'admin'],['member',fixture.bobId,'member'],['outsider',fixture.viewerId,'viewer']]
 writeFileSync(join(dir,'team.json'),JSON.stringify({teamId:fixture.beta,name:'Restored native chat audit',createdAt:1}))
 writeFileSync(join(dir,'members.json'),JSON.stringify(identities.map(([name,memberId,role])=>({memberId,displayName:name,email:name+'@restore.invalid',role,createdAt:1,sessions:{['restore-'+name]:hashSessionToken('restore-token-'+name)}}))))
 // Explicitly trusted synthetic identities; normal restore never promotes an archive roster.
 initializeCurrentAuthority(dir,dir+'.authority')
 const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const port=(reserve.address() as {port:number}).port;await new Promise<void>(r=>reserve.close(()=>r()))
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('TEAMSPACE_'))delete env[k]
 child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...env,TEAMSPACE_DATA_DIR:dir,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port)},stdio:['ignore','pipe','pipe']})
 let listening=false,logs='';child.stdout!.on('data',d=>{if(String(d).includes('bridge listening'))listening=true});child.stderr!.on('data',d=>{logs=(logs+String(d).replace(/admin recovery key generated[^\n]*/g,'recovery key redacted')).slice(-2000)})
 async function wait<T>(read:()=>T|undefined){const end=Date.now()+20000;while(Date.now()<end){const value=read();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,10))}throw Error('Restore server timeout '+logs)}
 await wait(()=>listening||undefined)
 async function client(name:string,memberId:string){const ws=new WebSocket('ws://127.0.0.1:'+port);sockets.push(ws);const inbox:any[]=[];ws.on('message',b=>inbox.push(JSON.parse(String(b))));await once(ws,'open');const take=(test:(v:any)=>boolean)=>wait(()=>{const i=inbox.findIndex(test);return i<0?undefined:inbox.splice(i,1)[0]});ws.send(JSON.stringify({type:'hello',protocolVersion:2,memberId,deviceId:'restore-'+name,sessionToken:'restore-token-'+name}));await take(x=>x.type==='hello_ok');await take(x=>x.type==='catchup_status'&&x.done);let n=0;return async(frame:any)=>{const frameId=name+'-'+(++n);ws.send(JSON.stringify({...frame,frameId}));return take(x=>x.frameId===frameId)}}
 const member=await client('member',fixture.bobId),outsider=await client('outsider',fixture.viewerId)
 const read=await member({type:'chat_history',room:fixture.locked.room,limit:100});assert.equal(read.type,'chat_history_ok');assert.ok(read.messages.some((m:any)=>m.body==='PRIVATE SECRET '+fixture.tag));assert.ok(read.pinnedMessageIds.includes(fixture.locked.message.id))
 for(const type of ['chat_history','chat_search','chat_jump','chat_export','chat_pin']){const r=await outsider({type,room:fixture.locked.room,query:'SECRET',messageId:fixture.locked.message.id,pinned:true,format:'json'});assert.equal(r.type,'chat_refuse',type)}
 const bytes=await fetch('http://127.0.0.1:'+port+'/v1/chat/blobs/'+fixture.locked.blob,{headers:{Authorization:'Bearer restore-token-member'}});assert.equal(bytes.status,200);assert.equal(Buffer.from(await bytes.arrayBuffer()).toString(),fixture.locked.blobText)
 const denied=await fetch('http://127.0.0.1:'+port+'/v1/chat/blobs/'+fixture.locked.blob,{headers:{Authorization:'Bearer restore-token-outsider'}});assert.ok([403,404].includes(denied.status))
 const sent=await member({type:'chat_send',room:fixture.locked.room,body:'After restored backup',clientMsgId:'restore-'+fixture.tag});assert.equal(sent.type,'chat_ok')
 const report={status:'passed',boundary:'Actual native-export ZIP restored into a fresh disposable production bridge server; new synthetic auth credentials only.',cases:['rooms-and-ban-list-restored','rotated-password-restored','pins-restored','deleted-message-not-resurrected','authorized-history-and-file-bytes','outsider-read-search-jump-export-pin-and-file-refused','post-restore-message-accepted']}
 writeFileSync(new URL('../../../docs/docker-collaboration-audit-2026-09-09/chat-deep/restore-results.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log('PASS native chat backup restore: '+report.cases.join(', '))
}finally{sockets.forEach(s=>s.terminate());if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}rmSync(dir,{recursive:true,force:true});rmSync(dir+'.authority',{recursive:true,force:true})}
