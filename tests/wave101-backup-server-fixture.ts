// Test-only process death after the actual generated checkpoint's directory
// fsync. Production route, inventory, writer, ownership and guards are unchanged.
import fs from 'node:fs'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
const root=process.env.TEAMSPACE_DATA_DIR!
const original=fs.fsyncSync
fs.fsyncSync=function(fd:number){
 original(fd)
 if(!fs.fstatSync(fd).isDirectory())return
 try{const state=JSON.parse(fs.readFileSync(join(root,'backup-export-resume','manifest.json'),'utf8'));if(state.generated===true&&state.ready===false)process.exit(17)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
}
syncBuiltinESMExports()
void import('../src/server.js').catch(error=>{console.error(error);process.exitCode=1})
