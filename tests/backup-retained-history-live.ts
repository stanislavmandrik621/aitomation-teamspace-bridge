/** Actual server recovery after the durable log's normal retention pass. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:net'
import WebSocket from 'ws'
import {BridgeStore,hashSessionToken,memberDeviceAckKey} from '../src/store.js'
import {initializeCurrentAuthority} from '../src/independent-authority.js'
import type {ModulesSyncOp} from '../src/index.js'

const root=mkdtempSync(join(tmpdir(),'backup-history-live-')),authority=root+'.authority'
const marker='LATEST_PERMITTED_CONTENT_AFTER_BACKUP',privateMarker='DENIED_RETAINED_SECRET'
let child:ReturnType<typeof spawn>|undefined
const sockets:WebSocket[]=[]
const old=Date.now()-40*86400000
const op=(kind:string,id:string,n:number,extra:Record<string,unknown>={}):ModulesSyncOp=>({
 opId:'history-'+n,kind,targetKind:kind.split('.')[0]!,targetId:id,moduleId:'module',originDevice:'admin',originMemberId:'admin',originRole:'admin',hlc:`${old+n}:0:admin`,protocolVersion:2,hopCount:0,...extra,
})
async function main(){
 try{
  writeFileSync(join(root,'team.json'),JSON.stringify({teamId:'history-team',name:'History test',createdAt:1}))
  writeFileSync(join(root,'members.json'),JSON.stringify(['admin','member'].map(id=>({memberId:id,displayName:id,email:id+'@example.test',createdAt:1,role:id,sessions:{[id]:hashSessionToken(id+'-token')}}))))
  const fixture=new BridgeStore(root,1,null,null)
  const ops=[op('module.create','module',1),op('entity.create','entity',2,{entityId:'entity'}),op('field.create','field',3,{entityId:'entity',patch:{slug:'name',fieldType:'text'}}),op('record.create','record',4,{entityId:'entity',patch:{data:{name:'BACKUP_OLD_VALUE'}}}),op('record.update','record',5,{entityId:'entity',patch:{data:{name:marker}}})]
  ops.push(op('field.create','secret-field',6,{entityId:'entity',patch:{slug:'secret',fieldType:'text'}}),op('record.update','record',7,{entityId:'entity',patch:{data:{secret:privateMarker}}}),op('module.update','module',8,{patch:{config:{teamSpaceAclGrantBag:{version:1,entities:[],fields:[{entityId:'entity',fieldSlug:'secret',role:'member',read:false,write:false,hidden:true}]}}}}))
  fixture.appendOps(ops)
  writeFileSync(join(root,'acks.json'),JSON.stringify(Object.fromEntries(['admin','member'].map(id=>[memberDeviceAckKey(id,id),Object.fromEntries(ops.map(o=>[o.opId,old]))]))))
  const retained=new BridgeStore(root,1,null,null)
  const removed=await retained.pruneOps()
  assert.ok(removed>0,'the test must run real retention, not truncate the file itself')
  if(process.env.HISTORY_LEGACY_EMPTY==='1')rmSync(join(root,'restore-history'),{recursive:true})
  initializeCurrentAuthority(root,authority)
  const reservation=createServer().listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as {port:number}).port
  await new Promise<void>(resolve=>reservation.close(()=>resolve()))
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('TEAMSPACE_'))delete env[key]
  child=spawn(process.execPath,['--import','tsx','src/server.ts'],{cwd:new URL('..',import.meta.url),env:{...env,TEAMSPACE_DATA_DIR:root,TEAMSPACE_AUTHORITY_DIR:authority,TEAMSPACE_BRIDGE_HOST:'127.0.0.1',TEAMSPACE_BRIDGE_PORT:String(port)},stdio:['ignore','pipe','pipe']})
  let ready=false,errors='';child.stdout!.on('data',b=>{if(String(b).includes('bridge listening'))ready=true});child.stderr!.on('data',b=>{errors=(errors+String(b)).slice(-1500)})
  const wait=async<T>(read:()=>T|undefined)=>{for(let n=0;n<1500;n++){const value=read();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,10))}throw Error('Timed out: '+errors)}
  await wait(()=>ready?true:undefined)
  const socket=new WebSocket(`ws://127.0.0.1:${port}`),frames:any[]=[];sockets.push(socket);socket.on('message',b=>frames.push(JSON.parse(String(b))));await once(socket,'open')
  socket.send(JSON.stringify({type:'hello',protocolVersion:2,memberId:'member',deviceId:'member',sessionToken:'member-token',restoreReplay:true}))
  const status=await wait(()=>frames.find(f=>f.type==='catchup_status'&&f.done))
  const latest=frames.some(f=>f.type==='ops'&&JSON.stringify(f.ops).includes(marker))
  assert.ok(latest||status.truncated===true,'Restoring an old backup must receive the newer value or report incomplete history; an empty successful replay is unsafe')
  assert.equal(JSON.stringify(frames.filter(f=>f.type==='ops')).includes(privateMarker),false,'current field restrictions must filter retained history')
  if(process.env.HISTORY_LEGACY_EMPTY==='1')assert.equal(status.truncated,true)
  else assert.equal(latest,true)
  console.log(JSON.stringify({privateRetainedValueAbsent:true,status:'passed',removed,latestRecovered:latest,incompleteHistoryReported:status.truncated===true,sourceLogBytes:readFileSync(join(root,'ops.jsonl')).length}))
 }finally{
  for(const socket of sockets)socket.terminate()
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited}
  rmSync(root,{recursive:true,force:true});rmSync(authority,{recursive:true,force:true})
 }
}
main().catch(error=>{console.error(error);process.exitCode=1})
