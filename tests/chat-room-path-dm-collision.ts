/**
 * TS-CHAT-151: two distinct DM room ids must never flatten to the same
 * on-disk directory name. `safeChatRoomDirName` collapses both the pair
 * separator AND every internal `_` in a member token down to `_`, so a
 * variable-length token containing `_` can make two different pairs land
 * on the identical directory - corrupting one DM's history with another's.
 *
 * This pin proves:
 * 1. The specific colliding pair from the audit (`dm:1_2.mem` vs
 *    `dm:1.2_mem`) now resolves to two DIFFERENT directory names.
 * 2. Real, bridge-minted member ids (`mem_<24 hex>`, the only shape
 *    `mintId('mem')` ever produces) still resolve to the exact same
 *    un-hashed flattened name as before the fix - no migration break for
 *    every DM room that already exists on disk.
 * 3. Legacy underscore-free member ids (no `_` in either token) are also
 *    unaffected.
 */
import assert from 'node:assert/strict'
import { safeChatRoomDirName } from '../src/chat-room-path.js'

// 1. The exact collision found in the audit must now be split apart.
const dirA = safeChatRoomDirName('chat:dm:1_2.mem')
const dirB = safeChatRoomDirName('chat:dm:1.2_mem')
assert.ok(dirA, 'dm:1_2.mem must resolve to a directory name')
assert.ok(dirB, 'dm:1.2_mem must resolve to a directory name')
assert.notEqual(dirA, dirB, 'two distinct DM pairs must never flatten to the same directory name')
// Both member tokens are non-canonical (not `mem_<hex>`) and one contains an
// embedded `_`, so the ambiguity guard must divert both to the hash form.
assert.match(String(dirA), /^dm_[a-f0-9]{24}$/, 'ambiguous pair must use the hash fallback name')
assert.match(String(dirB), /^dm_[a-f0-9]{24}$/, 'ambiguous pair must use the hash fallback name')

// 2. Real minted member ids (mem_<24 hex>) must keep the exact legacy
//    flattened name - this is what is already on disk for every live DM.
const memA = `mem_${'a'.repeat(24)}`
const memB = `mem_${'b'.repeat(24)}`
const realDir = safeChatRoomDirName(`chat:dm:${memA}.${memB}`)
assert.equal(realDir, `dm_${memA}_${memB}`, 'real minted member ids must not be re-hashed (no migration break)')

// Order-independence (parseChatRoomId sorts the pair) - same directory
// regardless of which member id is passed first.
const realDirSwapped = safeChatRoomDirName(`chat:dm:${memB}.${memA}`)
assert.equal(realDirSwapped, realDir, 'DM directory name must be independent of argument order')

// 3. Legacy underscore-free ids (pre-mem_-prefix scheme) are unaffected.
const legacyDir = safeChatRoomDirName('chat:dm:alice_bob')
assert.equal(legacyDir, 'dm_alice_bob', 'legacy underscore-free ids keep their historic flattened name')

// A team-wide room and group/private rooms (single opaque token, no pair
// concatenation) never hit the DM ambiguity path.
assert.equal(safeChatRoomDirName('chat:team'), 'team')
assert.equal(safeChatRoomDirName('chat:g:abcdEFGH12345678'), 'g_abcdEFGH12345678')

console.log('chat-room-path-dm-collision: PASS')
