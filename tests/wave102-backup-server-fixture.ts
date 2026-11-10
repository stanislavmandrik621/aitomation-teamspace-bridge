// Test-only termination after a real active-member checkpoint COMMIT and its
// directory fsync. Production server, inventory, ZIP writer and guards run.
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { syncBuiltinESMExports } from 'node:module'
const originalPrepare=DatabaseSync.prototype.prepare,originalExec=DatabaseSync.prototype.exec,originalSync=fs.fsyncSync
let candidate:any,committed=false
DatabaseSync.prototype.prepare=function(sql:string){const statement=originalPrepare.call(this,sql);if(sql==='UPDATE state SET value=? WHERE id=1'){const run=statement.run.bind(statement);(statement as any).run=(...values:any[])=>{const result=run(...values);try{candidate=JSON.parse(values[0])}catch{}return result}}return statement}
DatabaseSync.prototype.exec=function(sql:string){const result=originalExec.call(this,sql);if(sql==='COMMIT'&&candidate?.inventoryReady&&candidate?.progress?.active>0&&candidate.progress.body>=8*1024*1024)committed=true;return result}
fs.fsyncSync=function(fd:number){originalSync(fd);if(committed&&fs.fstatSync(fd).isDirectory())process.exit(17)}
syncBuiltinESMExports()
void import('../src/server.js').catch(error=>{console.error(error);process.exitCode=1})
