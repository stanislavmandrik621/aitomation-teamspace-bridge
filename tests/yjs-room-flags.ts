/**
 * TCC-R1125-WS-001 - bridge-side twin of the desktop-only
 * `isYjsRoomAllowedByFlags` gate. Pure-logic unit tests for the room
 * classifier + env-flag defaults; the wiring into `yjs_join` itself is
 * covered by the source-scan pin in `yjs-join-acl.ts` (server.ts starts a
 * real HTTP+WS server as a module side effect, so it can't be imported
 * directly in a unit test - same constraint documented in `ws-peer-close.ts`).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isYjsComposeRecordId,
  YJS_COMPOSE_RECORD_SENTINEL,
  parseYjsRoomId,
} from '../src/yjs-room.js'

describe('TCC-R1125-WS-001 - isYjsComposeRecordId classifies Compose vs Doc/WB rooms', () => {
  it('classifies the compose sentinel record id as a Compose room', () => {
    assert.equal(isYjsComposeRecordId(YJS_COMPOSE_RECORD_SENTINEL), true)
    assert.equal(YJS_COMPOSE_RECORD_SENTINEL, 'composeDoc')
  })

  it('classifies a real CRM record id as NOT a Compose room (Doc/WB)', () => {
    assert.equal(isYjsComposeRecordId('rec_12345'), false)
  })

  it('a parsed yjs:composeDoc:<docId> room resolves recordId to the sentinel', () => {
    const parsed = parseYjsRoomId('yjs:composeDoc:doc-abc')
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(isYjsComposeRecordId(parsed.recordId), true)
    }
  })

  it('a parsed yjs:<record>:<field> Doc/WB room does NOT classify as Compose', () => {
    const parsed = parseYjsRoomId('yjs:rec_1:description')
    assert.equal(parsed.ok, true)
    if (parsed.ok) {
      assert.equal(isYjsComposeRecordId(parsed.recordId), false)
    }
  })
})

describe('TCC-R1125-WS-001 - throughput.ts Yjs feature-flag env defaults are fail-closed', () => {
  it('TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED / TEAMSPACE_YJS_COMPOSE_ENABLED default OFF matching the client default', async () => {
    delete process.env.TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED
    delete process.env.TEAMSPACE_YJS_COMPOSE_ENABLED
    // Re-import via a cache-busting query so the module re-reads process.env
    // fresh (throughput.ts reads env at module-load time).
    const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
    assert.equal(mod.TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED, false)
    assert.equal(mod.TEAMSPACE_YJS_COMPOSE_ENABLED, false)
  })

  it('self-hoster can explicitly turn a surface on via env (server-wide opt-in)', async () => {
    process.env.TEAMSPACE_YJS_COMPOSE_ENABLED = 'true'
    try {
      const mod = await import(`../src/throughput.js?t=${Date.now()}-${Math.random()}`)
      assert.equal(mod.TEAMSPACE_YJS_COMPOSE_ENABLED, true)
      assert.equal(mod.TEAMSPACE_YJS_DOC_WHITEBOARD_ENABLED, false, 'the two flags are independent')
    } finally {
      delete process.env.TEAMSPACE_YJS_COMPOSE_ENABLED
    }
  })
})
