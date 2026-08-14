/**
 * TCC-R1143-CHAT-020: chat_delete_peer must carry optional createdAt/memberId
 * from tombstoned rows on both chat_delete and chat_unsend success paths.
 * server.ts boots a real listener as a module side effect, so this is a
 * source-scan pin (same class as chat-rate-limits.ts).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')
const index = readFileSync(join(root, 'src/index.ts'), 'utf8')

assert.match(
  index,
  /type:\s*'chat_delete_peer'[\s\S]*?createdAt\?:/,
  'BridgeFrame chat_delete_peer declares optional createdAt',
)
assert.match(
  index,
  /type:\s*'chat_delete_peer'[\s\S]*?memberId\?:/,
  'BridgeFrame chat_delete_peer declares optional memberId',
)

assert.match(
  server,
  /function fanoutChatDeletePeer\(\s*from: WebSocket \| null,\s*messageId: string,\s*room: string,\s*meta\?:/,
  'fanoutChatDeletePeer accepts optional meta',
)
assert.match(
  server,
  /type:\s*'chat_delete_peer'[\s\S]{0,200}createdAt/,
  'fanout builds chat_delete_peer with optional createdAt',
)
assert.match(
  server,
  /type:\s*'chat_delete_peer'[\s\S]{0,280}memberId/,
  'fanout builds chat_delete_peer with optional memberId',
)

function caseWindow(caseName: string, nextCaseName: string): string {
  const caseIdx = server.indexOf(`case '${caseName}':`)
  assert.ok(caseIdx > 0, `${caseName} case exists`)
  const nextCaseIdx = server.indexOf(`case '${nextCaseName}':`, caseIdx)
  assert.ok(nextCaseIdx > caseIdx, `${nextCaseName} case follows ${caseName}`)
  return server.slice(caseIdx, nextCaseIdx)
}

const deleteWin = caseWindow('chat_delete', 'chat_rooms_list')
assert.match(
  deleteWin,
  /fanoutChatDeletePeer\(\s*ws,\s*messageId,\s*(?:del\.room|delRoom)[\s\S]*?createdAt[\s\S]*?memberId/,
  'chat_delete passes createdAt/memberId from tomb',
)

const unsendWin = caseWindow('chat_unsend', 'chat_export')
assert.match(
  unsendWin,
  /fanoutChatDeletePeer\(\s*ws,\s*messageId,\s*uns\.room[\s\S]*?createdAt[\s\S]*?memberId/,
  'chat_unsend passes createdAt/memberId from tomb/prev',
)

console.log('chat-delete-peer-meta: ok')
