import { resolve } from 'node:path'
import { acquireBridgeDataDirLock } from './data-dir-lock.js'
import { initializeCurrentAuthority } from './independent-authority.js'
import { resolveAtRestKeyFromEnv } from './at-rest.js'
import { verifyAtRestStartupKey } from './at-rest-startup.js'

const [data,authority,confirmation]=process.argv.slice(2)
if(!data||!authority||confirmation!=='--trust-current-permissions'){
  console.error('Stop the server first. For a known-current legacy installation only: node dist/authority-migrate.js /data /authority --trust-current-permissions')
  process.exit(1)
}
const locks=[acquireBridgeDataDirLock(resolve(data)),acquireBridgeDataDirLock(resolve(authority))]
try{
  for(const lock of locks)if(!lock.ok)throw new Error(lock.reason)
  verifyAtRestStartupKey(resolve(data),resolveAtRestKeyFromEnv())
  initializeCurrentAuthority(resolve(data),resolve(authority))
  console.log('Independent authorization initialized. Original files were preserved. Retain this authorization volume separately from data backups.')
}catch(error){console.error(error instanceof Error?error.message:'Authorization migration failed');process.exitCode=1}
finally{for(const lock of locks)if(lock.ok)lock.release()}
