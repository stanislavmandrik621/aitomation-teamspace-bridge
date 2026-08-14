/**
 * Chat rate-limit constants pinned for bridge/desktop parity.
 *
 * TCC-R1134-CHAT-040: `chat_delete` / `chat_pin` / `chat_unsend` /
 * `chat_search` / `chat_jump` / `chat_export` had ZERO rate limit at all
 * (unlike chat_send/history/react/edit, which each gate on a `takeChat*Token`
 * bucket before doing any disk work). `server.ts` starts a real HTTP+WS
 * server as a module side effect so it cannot be imported directly here
 * (same constraint as `server-hardening-pins.ts`) - the second half of this
 * file source-scans the six case bodies to prove each one calls its budget
 * check BEFORE the store call that does the actual disk read/write.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHAT_RATE_SEND_PER_MIN,
  CHAT_RATE_HISTORY_PER_MIN,
  CHAT_RATE_REACT_PER_MIN,
  CHAT_RATE_TYPING_PER_SEC,
  CHAT_RATE_PASSWORD_JOIN_PER_15MIN,
  CHAT_RATE_MUTATE_PER_MIN,
  CHAT_RATE_SEARCH_PER_MIN,
  CHAT_RATE_EXPORT_PER_MIN,
  CHAT_RATE_ROOM_ADMIN_PER_MIN,
  CHAT_RATE_LIMITS,
} from '../src/chat-rate-limits.js'

assert.equal(CHAT_RATE_SEND_PER_MIN, 30)
assert.equal(CHAT_RATE_HISTORY_PER_MIN, 60)
assert.equal(CHAT_RATE_REACT_PER_MIN, 60)
assert.equal(CHAT_RATE_TYPING_PER_SEC, 10)
assert.equal(CHAT_RATE_PASSWORD_JOIN_PER_15MIN, 5)
assert.equal(CHAT_RATE_LIMITS.sendPerMin, CHAT_RATE_SEND_PER_MIN)
assert.equal(CHAT_RATE_LIMITS.reactPerMin, CHAT_RATE_REACT_PER_MIN)

// TCC-R1134-CHAT-040 constants.
assert.equal(CHAT_RATE_MUTATE_PER_MIN, 30)
assert.equal(CHAT_RATE_SEARCH_PER_MIN, CHAT_RATE_HISTORY_PER_MIN)
assert.equal(CHAT_RATE_EXPORT_PER_MIN, 6)
assert.equal(CHAT_RATE_LIMITS.mutatePerMin, CHAT_RATE_MUTATE_PER_MIN)
assert.equal(CHAT_RATE_LIMITS.searchPerMin, CHAT_RATE_SEARCH_PER_MIN)
assert.equal(CHAT_RATE_LIMITS.exportPerMin, CHAT_RATE_EXPORT_PER_MIN)
// TCC-R1145-CHAT-013
assert.equal(CHAT_RATE_ROOM_ADMIN_PER_MIN, 30)
assert.equal(CHAT_RATE_LIMITS.roomAdminPerMin, CHAT_RATE_ROOM_ADMIN_PER_MIN)
// Every budget must be a finite positive number - a zero/NaN ceiling would
// permanently lock every member out of that op.
for (const [name, v] of Object.entries(CHAT_RATE_LIMITS)) {
  assert.ok(Number.isFinite(v) && v > 0, `${name} must be a positive finite number`)
}

// ---- TCC-R1134-CHAT-040 source-scan: server.ts case bodies call the token ----
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = readFileSync(join(root, 'src/server.ts'), 'utf8')

function caseWindow(caseName: string, nextCaseName: string): string {
  const caseIdx = server.indexOf(`case '${caseName}':`)
  assert.ok(caseIdx > 0, `${caseName} case exists`)
  const nextCaseIdx = server.indexOf(`case '${nextCaseName}':`, caseIdx)
  assert.ok(nextCaseIdx > caseIdx, `${nextCaseName} case follows ${caseName}`)
  return server.slice(caseIdx, nextCaseIdx)
}

function assertTokenGateBeforeCall(
  caseName: string,
  nextCaseName: string,
  tokenFn: string,
  storeCall: string,
): void {
  const window = caseWindow(caseName, nextCaseName)
  const tokenIdx = window.indexOf(tokenFn)
  const storeIdx = window.indexOf(storeCall)
  assert.ok(tokenIdx > 0, `${caseName} calls ${tokenFn}`)
  assert.ok(storeIdx > tokenIdx, `${caseName} calls ${storeCall} only after the ${tokenFn} gate`)
}

assertTokenGateBeforeCall('chat_delete', 'chat_rooms_list', 'takeChatMutateToken(', 'chatStore.softDelete(')
// TS-CHAT-075: a room holds several pins, so the case body has one write per
// direction. Derive the list from the case body itself rather than naming one
// call, so a third pin write added later cannot skip the gate unnoticed.
{
  const window = caseWindow('chat_pin', 'chat_search')
  const writes = [...window.matchAll(/chatStore\.\w+\(/g)].map((m) => m[0])
  const pinWrites = writes.filter((c) => /pinMessage|unpinMessage|setPinned/.test(c))
  assert.ok(pinWrites.length > 0, 'chat_pin writes pins through chatStore')
  for (const call of new Set(pinWrites)) {
    assertTokenGateBeforeCall('chat_pin', 'chat_search', 'takeChatMutateToken(', `chatStore.${call.slice('chatStore.'.length)}`)
  }
}
assertTokenGateBeforeCall('chat_search', 'chat_jump', 'takeChatSearchToken(', 'chatStore.searchRoom(')
assertTokenGateBeforeCall('chat_jump', 'chat_unsend', 'takeChatSearchToken(', 'chatStore.jumpToMessage(')
assertTokenGateBeforeCall('chat_unsend', 'chat_export', 'takeChatMutateToken(', 'chatStore.authorUnsend(')
assertTokenGateBeforeCall('chat_export', 'chat_metrics', 'takeChatExportToken(', 'chatStore.exportRoom(')
assertTokenGateBeforeCall('chat_room_create', 'chat_room_join', 'takeChatRoomAdminToken(', 'chatRooms.getOrCreateDm(')
// TCC-R1151-CHAT-005: react burns token only after shape/access checks.
{
  const window = caseWindow('chat_react', 'chat_pin')
  const msgIdIdx = window.indexOf("message id and emoji required")
  const tokenIdx = window.indexOf('takeChatReactToken(')
  assert.ok(msgIdIdx > 0, 'chat_react validates shape')
  assert.ok(tokenIdx > msgIdIdx, 'chat_react takeChatReactToken after shape validation')
}

console.log('chat-rate-limits: ok')
