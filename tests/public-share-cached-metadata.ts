import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PublicShareBridgeStore} from '../src/public-share-store.js'
const root=mkdtempSync(join(tmpdir(),'public-cached-metadata-'))
try {
 const store=new PublicShareBridgeStore(root,null),hash='a'.repeat(64)
 writeFileSync(join(root,'public-share-payloads',hash+'.json'),JSON.stringify({version:2,mode:'read',viewType:'table',label:'Legacy publisher',entityId:'entity',fields:[{slug:'name'}],rows:[{id:'record',data:{name:'Visible',_private_metadata:'secret',_cell_hlc:{hidden:'clock'}},display:{name:'Visible',_private_metadata:'secret'}}],total:1,truncated:false}))
 const payload=store.readPayload(hash)
 assert.deepEqual(payload?.rows[0].data,{name:'Visible'})
 assert.deepEqual(payload?.rows[0].display,{name:'Visible'})
 console.log('Previously cached payloads omit internal record metadata even when the publisher is offline')
}finally{rmSync(root,{recursive:true,force:true})}
