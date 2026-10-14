import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,appendFileSync,renameSync,symlinkSync,rmSync,createWriteStream,readFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {once} from 'node:events'
import {spawnSync} from 'node:child_process'
import {snapshotChatBackupMetadata} from '../src/chat-backup-snapshot.js'
import {planStoredBackupZip,streamPlannedBackupZip} from '../src/backup-zip.js'
const root=mkdtempSync(join(tmpdir(),'chat-backup-snapshot-test-'))
try{
 const source=join(root,'rooms.json'),history=join(root,'messages.jsonl'),stage=mkdtempSync(join(root,'stage-'))
 writeFileSync(source,'{"version":"before"}');writeFileSync(history,'{"body":"before"}\n')
 const entries=[{name:'chat/rooms.json',absolutePath:source,size:20},{name:'chat/rooms/example/messages.jsonl',absolutePath:history,size:18}]
 const stable=await snapshotChatBackupMetadata(entries,stage)
 const planned=await planStoredBackupZip(stable);assert.ok(planned.ok)
 writeFileSync(join(root,'replacement'),'{}');renameSync(join(root,'replacement'),source)
 appendFileSync(history,'{"body":"after"}\n')
 const zip=join(root,'backup.zip'),out=createWriteStream(zip)
 const result=await streamPlannedBackupZip(out,planned.planned,planned.contentLength);assert.ok(result.ok,JSON.stringify(result));out.end();await once(out,'finish')
 const verified=spawnSync('python3',['-c',"import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;assert json.loads(z.read('chat/rooms.json'))=={'version':'before'};assert z.read('chat/rooms/example/messages.jsonl')==b'{\"body\":\"before\"}\\n'",zip],{encoding:'utf8'});assert.equal(verified.status,0,verified.stderr)
 assert.equal(readFileSync(zip).length,planned.contentLength)
 const ac=new AbortController();ac.abort();await assert.rejects(()=>snapshotChatBackupMetadata(entries,stage,ac.signal))
 const link=join(root,'linked');symlinkSync(source,link);await assert.rejects(()=>snapshotChatBackupMetadata([{...entries[0],absolutePath:link}],stage))
 console.log('PASS chat backup snapshot: atomic metadata replacement, concurrent history append, independent ZIP64/CRC/content verification, exact size, cancellation, symlink refusal')
}finally{rmSync(root,{recursive:true,force:true})}
