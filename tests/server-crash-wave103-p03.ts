import {DatabaseSync} from 'node:sqlite'
const prepare=DatabaseSync.prototype.prepare,exec=DatabaseSync.prototype.exec
let candidate:any
DatabaseSync.prototype.prepare=function(sql:string){const statement=prepare.call(this,sql);if(sql==='UPDATE state SET value=? WHERE id=1'){const run=statement.run.bind(statement);(statement as any).run=(...values:any[])=>{const result=run(...values);candidate=JSON.parse(values[0]);return result}}return statement}
DatabaseSync.prototype.exec=function(sql:string){const result=exec.call(this,sql);if(sql==='COMMIT'&&candidate?.inventoryReady===false&&candidate?.count===1)process.exit(17);return result}
await import('../src/server.ts')
