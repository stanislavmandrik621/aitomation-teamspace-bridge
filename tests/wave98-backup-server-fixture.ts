import { TeamBackupStore } from '../src/backup-store.js'
import { Readable } from 'node:stream'
const original = TeamBackupStore.prototype.openSnapshotRead
let paused = false
TeamBackupStore.prototype.openSnapshotRead = async function (...args) {
  const opened = await original.apply(this, args)
  if (opened && args[2]?.start && !paused) {
    paused = true
    const pinned = opened.stream
    opened.stream = Readable.from((async function* () {
      let chunks = 0
      try { for await (const chunk of pinned) {
        yield chunk
        if (++chunks === 2) {
          // Only pause source delivery. Actual server authorization transform
          // and EOF guard run unchanged after root test revokes the live role.
          await new Promise<void>(resolve => { process.once('message', () => resolve()); console.log('WAVE98_RANGE_PAUSED') })
        }
      } } finally { pinned.destroy() }
    })())
  }
  return opened
}
void import('../src/server.js').catch(error => { console.error(error); process.exitCode = 1 })
