import { IncomingMessage } from 'node:http'
import { TeamBackupStore } from '../../src/backup-store.js'

// Observability at actual HTTP/store boundaries; no authorization or storage
// behavior is replaced. Tests use these markers to revoke while I/O is pending.
const emit = IncomingMessage.prototype.emit
IncomingMessage.prototype.emit = function (event, ...args) {
  const result = emit.call(this, event, ...args)
  if (event === 'data' && this.method === 'PATCH' && this.url === '/v1/backups/meta') {
    console.log('BACKUP_META_BODY_READ')
  }
  if (event === 'data' && this.method === 'POST' && this.url === '/v1/backups/read-scope') console.log('BACKUP_SCOPE_BODY_READ')
  return result
}
const open = TeamBackupStore.prototype.openSnapshotRead
TeamBackupStore.prototype.openSnapshotRead = function (...args) {
  const result = open.apply(this, args)
  console.log('BACKUP_READ_ENTERED')
  return result
}
await import('../../src/server.js')
