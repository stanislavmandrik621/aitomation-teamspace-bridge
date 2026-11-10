/** Real encrypted server -> HTTP ZIP -> fresh server, including bad-key recovery. */
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {createHash} from 'node:crypto'
import WebSocket from 'ws'
import {encryptJsonFile,resolveAtRestKeyFromEnv} from '../src/at-rest.js'
import {hashSessionToken} from '../src/store.js'
import {ChatRoomsStore} from '../src/chat-rooms-store.js'
import {ChatStore} from '../src/chat-store.js'
import {initializeCurrentAuthority} from '../src/independent-authority.js'
const root=mkdtempSync(join(tmpdir(),'chat-encrypted-live-')),secret='isolated-chat-audit-key-2026',key=resolveAtRestKeyFromEnv({TEAMSPACE_AT_REST_KEY:secret})!,cases:string[]=[]
const children:ReturnType<typeof spawn>[]=[],sockets:WebSocket[]=[]
const wait=async<T>(fn:()=>T|undefined,label:string)=>{const end=Date.now()+20000;while(Date.now()<end){const v=fn();if(v!==undefined)return v;await new Promise(r=>setTimeout(r,10))}throw Error('Timeout '+label)}
function seed(dir:string){mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'team.json'),encryptJsonFile(key,{teamId:'encrypted-audit',name:'Encrypted test',createdAt:1}));writeFileSync(join(dir,'members.json'),encryptJsonFile(key,['admin','member','outsider'].map(n=>({memberId:'mem_'+n,displayName:n,role:n==='admin'?'admin':'member',createdAt:1,sessions:{[n]:hashSessionToken('token-'+n)}}))))}
function fingerprint(dir:string):string{const rows:string[]=[];const walk=(p:string)=>{for(const e of readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const x=join(p,e.name);if(e.isDirectory())walk(x);else rows.push(x.slice(dir.length)+':'+createHash('sha256').update(readFileSync(x)).digest('hex'))}};walk(dir);return rows.join('\n')}
async function start(dir:string,password:string|undefined){const l=createServer().listen(0,'127.0.0.1');await once(l,'listening');const port=(l.address() as any).port;await new Promise<void>(r=>l.close(()=>r()));const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('TEAMSPACE_'))delete env[k];if(password!==undefined)env.TEAMSPACE_AT_REST_KEY=password
 const c=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...env,TEAMSPACE_DATA_DIR:dir,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port)},stdio:['ignore','pipe','pipe']});children.push(c);let ready=false,logs='';c.stdout!.on('data',b=>{if(String(b).includes('bridge listening'))ready=true});c.stderr!.on('data',b=>{logs=(logs+String(b)).slice(-2000)});await wait(()=>ready||c.exitCode!==null?true:undefined,'startup');return{c,ready,logs,base:'http://127.0.0.1:'+port,ws:'ws://127.0.0.1:'+port}}
async function client(server:Awaited<ReturnType<typeof start>>,name:string){const ws=new WebSocket(server.ws);sockets.push(ws);const inbox:any[]=[];ws.on('message',b=>inbox.push(JSON.parse(String(b))));await once(ws,'open');const take=(fn:(r:any)=>boolean)=>wait(()=>{const i=inbox.findIndex(fn);return i<0?undefined:inbox.splice(i,1)[0]},'frame');ws.send(JSON.stringify({type:'hello',protocolVersion:2,memberId:'mem_'+name,deviceId:name,sessionToken:'token-'+name}));await take(r=>r.type==='hello_ok');await take(r=>r.type==='catchup_status'&&r.done);let seq=0;return async(frame:any)=>{const frameId=name+'-'+ ++seq;ws.send(JSON.stringify({...frame,frameId}));return take(r=>r.frameId===frameId)}}
const header=(name:string)=>({Authorization:'Bearer token-'+name})
try{
 const source=join(root,'source');seed(source);initializeCurrentAuthority(source,source+'.authority');const server=await start(source,secret);assert.ok(server.ready)
 const admin=await client(server,'admin');const created=await admin({type:'chat_room_create',kind:'private',title:'SECRET PRIVATE ROOM',memberIds:['mem_member'],password:'private-passphrase'});assert.equal(created.type,'chat_room_create_ok');const room=created.room.id
 const bytes=Buffer.from('SECRET ENCRYPTED ATTACHMENT\0日本語');const upload=await fetch(server.base+'/v1/chat/blobs',{method:'POST',headers:{...header('admin'),'x-teamspace-chat-room':room,'x-filename':'encrypted.txt'},body:bytes});assert.equal(upload.status,200);const blob=(await upload.json() as any).blob
 const send=await admin({type:'chat_send',room,body:'SECRET ENCRYPTED MESSAGE',clientMsgId:'enc-live-1',attachments:[{blobId:blob.sha256,name:blob.name,bytes:blob.bytes,mime:blob.mime}]});assert.equal(send.type,'chat_ok',JSON.stringify(send));assert.equal((await admin({type:'chat_pin',room,messageId:send.message.id,pinned:true})).type,'chat_pin_ok')
 const exported=await fetch(server.base+'/v1/backups/export.zip',{headers:header('admin')});assert.equal(exported.status,200);const zip=join(root,'encrypted.zip');writeFileSync(zip,Buffer.from(await exported.arrayBuffer()))
 for(const text of ['SECRET PRIVATE ROOM','SECRET ENCRYPTED MESSAGE','SECRET ENCRYPTED ATTACHMENT',secret])assert.equal(readFileSync(zip).includes(Buffer.from(text)),false,'ZIP must retain at-rest ciphertext: '+text)
 cases.push('live-encrypted-private-room-message-pin-and-attachment-export-without-plaintext-or-key')
 const denied=await fetch(server.base+'/v1/backups/export.zip',{headers:header('member')});assert.equal(denied.status,403);cases.push('member-cannot-export-encrypted-team-backup')
 const restored=join(root,'restored');seed(restored);execFileSync('python3',['-c',`import zipfile,pathlib,sys\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\np=pathlib.Path(sys.argv[2]).resolve()\nfor n in z.namelist():\n if not n.startswith('chat/') or n.endswith('/'):continue\n q=(p/n).resolve();assert q.is_relative_to(p);q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(z.read(n))`,zip,restored])
 for(const password of [undefined,'wrong-but-long-enough-key']){const before=fingerprint(restored);const wrong=await start(restored,password);assert.equal(wrong.ready,false,'Missing/wrong key must prevent server startup');assert.notEqual(wrong.c.exitCode,0);assert.equal(fingerprint(restored),before,'Failed start cannot change restored encrypted data');cases.push(password?'wrong-key-start-refused-with-no-data-changes':'missing-key-start-refused-with-no-data-changes')}
 // The synthetic roster is explicitly known current. Production startup must
 // never trust an archive's historical roster or room membership automatically.
 initializeCurrentAuthority(restored,restored+'.authority')
 const fresh=await start(restored,secret);assert.ok(fresh.ready);const member=await client(fresh,'member'),outsider=await client(fresh,'outsider');const history=await member({type:'chat_history',room,limit:100});assert.equal(history.type,'chat_history_ok');assert.equal(history.messages.find((m:any)=>m.id===send.message.id).body,'SECRET ENCRYPTED MESSAGE');assert.ok(history.pinnedMessageIds.includes(send.message.id));cases.push('correct-key-fresh-server-restores-private-history-and-pins')
 const file=await fetch(fresh.base+'/v1/chat/blobs/'+blob.sha256,{headers:header('member')});assert.equal(file.status,200);assert.ok(Buffer.from(await file.arrayBuffer()).equals(bytes));cases.push('restored-encrypted-attachment-decrypts-to-exact-bytes')
 assert.equal((await outsider({type:'chat_history',room,limit:100})).type,'chat_refuse');assert.ok([403,404].includes((await fetch(fresh.base+'/v1/chat/blobs/'+blob.sha256,{headers:header('outsider')})).status));cases.push('restored-private-room-and-attachment-exclude-outsider')
 // Hold the real HTTP response body with enough encrypted bytes to force
 // socket backpressure, then change ACL/history while that ZIP is streaming.
 const padding=Buffer.alloc(8*1024*1024,65)
 const padded=await fetch(server.base+'/v1/chat/blobs',{method:'POST',headers:{...header('admin'),'x-teamspace-chat-room':room,'x-filename':'backpressure.txt'},body:padding});assert.equal(padded.status,200)
 const paddingBlob=(await padded.json() as any).blob
 assert.equal((await admin({type:'chat_send',room,body:'backup backpressure',clientMsgId:'backup-padding',attachments:[{blobId:paddingBlob.sha256,name:paddingBlob.name,bytes:paddingBlob.bytes,mime:paddingBlob.mime}]})).type,'chat_ok')
 const doomed=await admin({type:'chat_room_create',kind:'group',title:'Dissolve during backup',memberIds:['mem_member']});assert.equal(doomed.type,'chat_room_create_ok')
 const streaming=await fetch(server.base+'/v1/backups/export.zip',{headers:header('admin')});assert.equal(streaming.status,200)
 const overlap=await fetch(server.base+'/v1/backups/export.zip',{headers:header('admin')});assert.equal(overlap.status,429);assert.match(await overlap.text(),/already running/)
 assert.equal((await admin({type:'chat_pin',room,messageId:send.message.id,pinned:false})).type,'chat_pin_ok')
 assert.equal((await admin({type:'chat_delete',room,messageId:send.message.id})).type,'chat_delete_ok')
 assert.equal((await admin({type:'chat_room_remove_members',room,memberIds:['mem_member']})).type,'chat_room_remove_members_ok')
 assert.equal((await admin({type:'chat_room_dissolve',room:doomed.room.id})).type,'chat_room_dissolve_ok')
 const duringZip=join(root,'during.zip');writeFileSync(duringZip,Buffer.from(await streaming.arrayBuffer()))
 const afterExport=await fetch(server.base+'/v1/backups/export.zip',{headers:header('admin')});assert.equal(afterExport.status,200);const afterZip=join(root,'after.zip');writeFileSync(afterZip,Buffer.from(await afterExport.arrayBuffer()))
 for(const [label,archive] of [['during',duringZip],['after',afterZip]]){
  const target=join(root,label);mkdirSync(target);execFileSync('python3',['-c',`import zipfile,pathlib,sys\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\np=pathlib.Path(sys.argv[2]).resolve()\nfor n in z.namelist():\n if not n.startswith('chat/') or n.endswith('/'):continue\n q=(p/n).resolve();assert q.is_relative_to(p);q.parent.mkdir(parents=True,exist_ok=True);q.write_bytes(z.read(n))`,archive,target])
  const chat=new ChatStore(target,90,365,key),roomStore=new ChatRoomsStore(target,key),historical=label==='during'
  assert.equal(roomStore.memberCanAccess(room,'mem_member'),historical,label+' membership snapshot')
  assert.equal(roomStore.memberCanAccess(doomed.room.id,'mem_member'),historical,label+' dissolved-room snapshot')
  assert.equal((await chat.readRecent(room,100)).messages.some(m=>m.id===send.message.id),historical,label+' deleted-message snapshot')
  assert.equal(chat.getPinnedMessageIds(room).includes(send.message.id),historical,label+' pin snapshot')
 }
 cases.push('backpressured-real-export-keeps-consistent-pre-change-acl-history-pins-and-room-state','next-export-captures-member-removal-message-deletion-unpin-and-dissolution','both-concurrent-change-archives-have-valid-crc-and-readable-encrypted-content')
 console.log('PASS',cases)
 writeFileSync(new URL('../../../docs/docker-collaboration-audit-2026-09-09/chat-gaps/encrypted-backup.json',import.meta.url),JSON.stringify({status:'passed',cases,boundary:'Two real production bridge servers; actual encrypted HTTP ZIP exported and restored. Synthetic identities and temporary local files.'},null,2)+'\n')
}finally{for(const ws of sockets)ws.terminate();for(const c of children)if(c.exitCode===null){c.kill('SIGTERM');await once(c,'exit')}rmSync(root,{recursive:true,force:true})}
