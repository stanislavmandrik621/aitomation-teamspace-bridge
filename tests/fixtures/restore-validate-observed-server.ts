import { IncomingMessage } from 'node:http'

// Only observation and deterministic lease time; production auth, HTTP parsing,
// roster mutations and durable permit writes run unchanged.
const realNow = Date.now
let offset = 0
Date.now = () => realNow() + offset
process.on('message', (message: any) => {
  if (message?.type === 'advance-clock' && Number.isSafeInteger(message.ms)) {
    offset += message.ms
    process.send?.({ type: 'clock-advanced' })
  }
})
const emit = IncomingMessage.prototype.emit
IncomingMessage.prototype.emit = function (event, ...args) {
  const result = emit.call(this, event, ...args)
  if (event === 'data' && this.url === '/v1/team-content-restore/validate') {
    process.send?.({ type: 'validate-body-data' })
  }
  return result
}
await import('../../src/server.js')
