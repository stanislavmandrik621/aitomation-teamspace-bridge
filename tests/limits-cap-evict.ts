/**
 * TCC-R1143-LIM-009: lowering maxLiveConnections / yjsRoomMaxPeers must
 * evict surplus (oldest WS close / oldest Yjs peer leave), not next-join only.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')

assert.match(server, /function evictSurplusLiveConnections\(/)
assert.match(server, /function evictSurplusYjsPeers\(/)
assert.match(server, /TCC-R1143-LIM-009/)
// TCC-R1149-LIM-001: snapshot once - never spin on async clients.size after close().
assert.match(server, /const snapshot = \[\.\.\.wss\.clients\]/)
assert.match(server, /const surplus = snapshot\.length - target/)
assert.match(server, /leaveYjsRoom\(oldest, room\)/)
assert.match(server, /oldest\.terminate\(\)/)
assert.match(
  server,
  /limitsStore\.onChange\(\(meta\) => \{\s*const closed = evictSurplusLiveConnections/,
)

// Eviction must be wired AFTER wss is created (not only refuse-new at connect).
const wssIdx = server.indexOf('const wss = new WebSocketServer')
const evictOnChangeIdx = server.indexOf('evictSurplusLiveConnections(meta.maxLiveConnections)')
assert.ok(wssIdx > 0 && evictOnChangeIdx > wssIdx, 'eviction onChange must follow wss creation')

// TCC-R1150-LIM-003: Admin maxRoomMembers lower trims surplus members.
assert.match(server, /function evictSurplusRoomMembers\(/)
assert.match(server, /trimMembersToCap/)
assert.match(server, /fanoutChatCapsPeer/)

console.log('limits-cap-evict: ok')
