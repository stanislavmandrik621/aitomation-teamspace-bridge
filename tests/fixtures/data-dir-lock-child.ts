import { acquireBridgeDataDirLock } from '../../src/data-dir-lock.js'
const lock = acquireBridgeDataDirLock(process.argv[2]!)
if (!lock.ok) { console.log(lock.reason); process.exit(2) }
if (process.argv[3] === 'hold') {
  process.send?.({ locked: true })
  setInterval(() => {}, 1000)
} else { lock.release(); process.exit(0) }
