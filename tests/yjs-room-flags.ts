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
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isYjsComposeRecordId,
  YJS_COMPOSE_RECORD_SENTINEL,
  parseYjsRoomId,
  serializeYjsRoomFullRefuse,
  YJS_REFUSE_ROOM_FULL,
} from '../src/yjs-room.js'
import { serializeBridgeFrame } from '../src/ws-frame-send.js'

const yjsSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'yjs-room.ts'),
  'utf8',
)

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

describe('G13-chat / BRG-066 - per-room Yjs evict stringify once', () => {
  it('serializeYjsRoomFullRefuse uses serializeBridgeFrame and the shared room-full sentence', () => {
    assert.match(yjsSrc, /export function serializeYjsRoomFullRefuse\(/)
    assert.match(yjsSrc, /serializeBridgeFrame\(/)
    assert.match(yjsSrc, /YJS_REFUSE_ROOM_FULL/)
    assert.equal(
      YJS_REFUSE_ROOM_FULL,
      'Too many people have this document open right now. Try again shortly.',
    )
    const room = 'yjs:rec_1:description'
    const once = serializeYjsRoomFullRefuse(room)
    const again = serializeYjsRoomFullRefuse(room)
    assert.equal(once, again, 'same room must serialize to the same string')
    assert.equal(
      once,
      serializeBridgeFrame({
        type: 'yjs_refuse',
        room,
        reason: YJS_REFUSE_ROOM_FULL,
      }),
    )
    const named = serializeYjsRoomFullRefuse(room, 'team-named')
    assert.equal(
      named,
      serializeBridgeFrame({
        type: 'yjs_refuse',
        room,
        reason: YJS_REFUSE_ROOM_FULL,
        teamId: 'team-named',
      }),
    )
    const leftover = serializeYjsRoomFullRefuse(`${room}\0junk`, 'team-a\0junk')
    assert.equal(
      leftover,
      serializeBridgeFrame({
        type: 'yjs_refuse',
        room,
        reason: YJS_REFUSE_ROOM_FULL,
        teamId: 'team-a',
      }),
      'yjs refuse room/teamId must NUL-cut leftover, never join',
    )
    const joinedRoom = parseYjsRoomId(`yjs:rec_1\0junk:description`)
    assert.equal(joinedRoom.ok, false, 'embedded NUL in a room id must cut, not join into another room')
  })

  it('helper body has no JSON.stringify and no per-peer loop (pin-break: stringify in a for-loop)', () => {
    const start = yjsSrc.indexOf('export function serializeYjsRoomFullRefuse')
    assert.notEqual(start, -1, 'serializeYjsRoomFullRefuse exists')
    const open = yjsSrc.indexOf('{', start)
    let depth = 0
    let close = -1
    for (let i = open; i < yjsSrc.length; i++) {
      if (yjsSrc[i] === '{') depth++
      else if (yjsSrc[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    const body = yjsSrc.slice(open, close + 1)
    const live = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
    assert.doesNotMatch(live, /JSON\.stringify/)
    assert.doesNotMatch(live, /\bfor\s*\(/)
    assert.match(live, /serializeBridgeFrame\(/)
    const looped = live.replace(
      'return serializeBridgeFrame({',
      'for (const _peer of [1, 2]) { JSON.stringify({',
    )
    assert.match(looped, /JSON\.stringify/)
    assert.notEqual(looped, live, 'commenting serializeBridgeFrame for a per-peer stringify must fail this pin')
  })
})
