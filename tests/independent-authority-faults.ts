import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {BridgeStore} from '../src/store.js'
import {initializeCurrentAuthority,openIndependentAuthority} from '../src/independent-authority.js'

const fingerprint=(directory:string):string=>{
  const rows:string[]=[]
  const walk=(path:string)=>{for(const entry of fs.readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
    const file=join(path,entry.name);if(entry.isDirectory())walk(file);else if(!entry.name.startsWith('.authorization-binding.json'))rows.push(file.slice(directory.length)+':'+createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
  }};walk(directory);return rows.join('\n')
}
const isWorker=process.argv[2]==='--worker'
if(isWorker){
  const [root,mode,indexText]=process.argv.slice(3),index=Number(indexText)
  const data=join(root!,'data'),authority=join(root!,'authority');fs.mkdirSync(data,{recursive:true})
  const store=new BridgeStore(data,21,null,null)
  assert.equal(store.helloOrBootstrap({memberId:'owner',deviceId:'owner-device',displayName:'Owner'}).ok,true)
  // The migration contract requires a stopped source, including closed SQLite
  // handles. Checkpoint before measuring bytes, never confuse SQLite's normal
  // shutdown checkpoint with a migration write.
  for(const index of [store.contentAccess,store.recordTree,store.recordTeamwork]) (index as any).storage?.db.close()
  fs.mkdirSync(join(data,'chat'));fs.writeFileSync(join(data,'chat','rooms.json'),'CURRENT_PRIVATE_MEMBERS_ONLY')
  const before=fingerprint(data);fs.writeFileSync(join(root!,'source-fingerprint'),before)
  let count=0
  const trace:Array<{operation:string;path:string}>=[]
  const originals={copyFileSync:fs.copyFileSync,writeFileSync:fs.writeFileSync,renameSync:fs.renameSync,fsyncSync:fs.fsyncSync}
  for(const operation of Object.keys(originals) as Array<keyof typeof originals>){
    ;(fs as any)[operation]=(...args:any[])=>{
      const step=count++;trace.push({operation,path:typeof args[0]==='string'?args[0].replace(root!,''):''})
      if(step===index&&mode!=='none'){
        if(mode==='kill-before')process.kill(process.pid,'SIGKILL')
        if(mode==='ENOSPC'||mode==='EIO')throw Object.assign(new Error(`injected ${mode} ${operation}`),{code:mode})
      }
      const result=Reflect.apply(originals[operation],fs,args)
      if(step===index&&mode==='kill-after')process.kill(process.pid,'SIGKILL')
      return result
    }
  }
  syncBuiltinESMExports()
  try{initializeCurrentAuthority(data,authority)}catch(error){assert.match(String(error),/injected/)}
  finally{Object.assign(fs,originals);syncBuiltinESMExports()}
  assert.equal(fingerprint(data),before,'source bytes must survive any migration write failure')
  fs.writeFileSync(join(root!,'trace.json'),JSON.stringify(trace))
}else{
  const root=fs.mkdtempSync(join(tmpdir(),'authority-fault-matrix-'))
  let cases=0
  const run=(mode:string,index:number)=>{
    const directory=join(root,`${mode}-${index}`);fs.mkdirSync(directory)
    const result=spawnSync(process.execPath,['--import','tsx',import.meta.filename,'--worker',directory,mode,String(index)],{encoding:'utf8',timeout:30000})
    if(mode.startsWith('kill'))assert.equal(result.signal,'SIGKILL',result.stderr)
    else assert.equal(result.status,0,result.stderr)
    const data=join(directory,'data'),authority=join(directory,'authority')
    assert.equal(fingerprint(data),fs.readFileSync(join(directory,'source-fingerprint'),'utf8'),'crashed process preserves every source file')
    const dataBound=fs.existsSync(join(data,'.authorization-binding.json')),authorityBound=fs.existsSync(join(authority,'.authorization-binding.json'))
    if(dataBound&&authorityBound){
      openIndependentAuthority(data,authority)
      const recovered=new BridgeStore(data,21,null,null,undefined,authority)
      assert.ok(recovered.findMember('owner'),'committed binding contains the complete current roster')
      assert.equal(fs.readFileSync(join(authority,'chat','rooms.json'),'utf8'),'CURRENT_PRIVATE_MEMBERS_ONLY')
    }else{
      assert.throws(()=>openIndependentAuthority(data,authority),/missing/,'partial migration cannot bootstrap')
      const recovery=join(directory,'recovered-authority')
      initializeCurrentAuthority(data,recovery);openIndependentAuthority(data,recovery)
      assert.ok(new BridgeStore(data,21,null,null,undefined,recovery).findMember('owner'))
      assert.equal(fs.readFileSync(join(recovery,'chat','rooms.json'),'utf8'),'CURRENT_PRIVATE_MEMBERS_ONLY')
    }
    cases++;return directory
  }
  try{
    const baseline=run('none',-1),trace=JSON.parse(fs.readFileSync(join(baseline,'trace.json'),'utf8')) as Array<{operation:string}>
    for(let index=0;index<trace.length;index++){
      run('ENOSPC',index);run('EIO',index)
      if(trace[index]!.operation==='renameSync'||trace[index]!.operation==='fsyncSync'){run('kill-before',index);run('kill-after',index)}
    }
    console.log(JSON.stringify({status:'passed',cases,writeBoundaries:trace.length,sourcePreservation:true,partialStartupRefused:true,recoveryWithCurrentSource:true,actualProcessKills:true}))
  }finally{fs.rmSync(root,{recursive:true,force:true})}
}
