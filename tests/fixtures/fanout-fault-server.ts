// Test-only fault boundaries; production uses the unchanged real stores/socket.
import WebSocket from 'ws'
import { ChatRoomHistoryStore } from '../../src/chat-room-history-store.js'

const send = WebSocket.prototype.send
const emit = WebSocket.prototype.emit
WebSocket.prototype.emit = function (event: string | symbol, ...args: any[]) {
  if (event === 'message') {
    const frame = JSON.parse(String(args[0]))
    if (frame.frameId === 'fault-backpressure') {
      Object.defineProperty(this, 'bufferedAmount', { get: () => 256 * 1024 * 1024 })
      console.log('FAULT_SLOW_PEER_READY')
      return true
    }
  }
  return emit.call(this, event, ...args)
}
WebSocket.prototype.send = function (data: any, ...args: any[]) {
  if (typeof data === 'string') {
    const frame = JSON.parse(data)
    if (frame.type === 'ops_result' && frame.frameId === 'fault-ack') {
      throw new Error('injected sender acknowledgement failure')
    }
  }
  return send.call(this, data, ...args)
} as typeof send

const append = ChatRoomHistoryStore.prototype.append
ChatRoomHistoryStore.prototype.append = async function (...args) {
  const result = await append.apply(this, args)
  if (args[0].body === 'committed sender disconnect') {
    console.log('FAULT_CHAT_COMMITTED')
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  return result
}
for (const method of ['edit', 'react', 'pinMessage', 'softDelete'] as const) {
  const original = ChatRoomHistoryStore.prototype[method]
  ;(ChatRoomHistoryStore.prototype as any)[method] = async function (...args: any[]) {
    const result = await (original as any).apply(this, args)
    if (args.includes('committed-chat') && !('error' in result)) {
      console.log(`FAULT_${method}_COMMITTED`)
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    return result
  }
}
await import('../../src/server.js')
