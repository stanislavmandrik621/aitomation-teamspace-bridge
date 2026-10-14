/** Production image default USER, entrypoint locks and fresh independent volumes. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdirSync,writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
import WebSocket from 'ws'
import { BRIDGE_PROTOCOL_VERSION } from '../src/index.js'
const image=process.env.COMPOSE_REVIEW_DOCKER_IMAGE,output=resolve(process.env.COMPOSE_REVIEW_DOCKER_OUTPUT||'local/compose-presence-2026-10-06/docker-production-r3/default-user')
assert(image&&/^[a-z0-9][a-z0-9./:_-]+$/.test(image),'Use an explicit owned image')
mkdirSync(output,{recursive:true});const name='compose-review-default-'+randomUUID().slice(0,8)
const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=(reservation.address() as any).port;await new Promise<void>(r=>reservation.close(()=>r()))
const report:any={ok:false,image,name,startedAt:new Date().toISOString(),defaultUser:true};let ws:WebSocket|undefined
try{
 execFileSync('docker',['run','--rm','-d','--name',name,'--cpus','1','--memory','1g','--pids-limit','64','-p','127.0.0.1:'+port+':8788',image],{stdio:'pipe'})
 const deadline=Date.now()+30000;while(true){try{const r=await fetch('http://127.0.0.1:'+port+'/health');if(r.status===200)break}catch{}assert(Date.now()<deadline,'Default production image did not become ready');await new Promise(r=>setTimeout(r,200))}
 const actual=JSON.parse(execFileSync('docker',['exec',name,'node','-e',"const fs=require('node:fs');console.log(JSON.stringify({uid:process.getuid(),gid:process.getgid(),dataMode:fs.statSync('/data').mode&511,authorityMode:fs.statSync('/authority').mode&511,dataLock:fs.existsSync('/proc/1/fd/9'),authorityLock:fs.existsSync('/proc/1/fd/8')}))"],{encoding:'utf8'}))
 assert(actual.uid>0);assert.equal(actual.dataMode,448);assert.equal(actual.authorityMode,448);assert(actual.dataLock&&actual.authorityLock)
 ws=new WebSocket('ws://127.0.0.1:'+port);await once(ws,'open');const response=once(ws,'message');ws.send(JSON.stringify({type:'hello',protocolVersion:BRIDGE_PROTOCOL_VERSION,memberId:'default-admin-'+randomUUID(),deviceId:'default-fixture-device',memberEmail:'default@example.test',displayName:'Default image test'}));const frame=JSON.parse(String((await response)[0]));assert.equal(frame.type,'hello_ok');assert.equal(frame.role,'admin')
 const healthy=execFileSync('docker',['exec',name,'node','/app/healthcheck.cjs'],{stdio:'pipe'});report.ok=true;report.user=actual;report.nativeBootstrap=true;report.healthcheckExit=0;report.imageId=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8'}))[0].Image
}finally{
 ws?.terminate();try{execFileSync('docker',['stop','--time','10',name],{stdio:'pipe'})}catch{};report.finishedAt=new Date().toISOString();writeFileSync(join(output,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({ok:report.ok,defaultUser:report.user,nativeBootstrap:report.nativeBootstrap,output}))
}
