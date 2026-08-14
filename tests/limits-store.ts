/**
 * Bridge unit tests: TeamLimitsStore clamp + ceilings.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TeamLimitsStore,
  LIMITS_META_DEFAULTS,
  LIMITS_META_CEILINGS,
  LIMITS_META_FLOORS,
} from '../src/limits-store.js'
import { getChatRoomMembersCap } from '../src/chat-rooms-store.js'

const dir = mkdtempSync(join(tmpdir(), 'ts-limits-'))
try {
  const store = new TeamLimitsStore(dir)
  const effective = store.getEffective()
  assert.equal(effective.meta.schemaVersion, 1)
  assert.equal(typeof effective.meta.maxLiveConnections, 'number')
  assert.ok(effective.defaults.maxRoomMembers === LIMITS_META_DEFAULTS.maxRoomMembers)

  const raised = store.setMeta({ maxRoomMembers: 12, chatSendPerMin: 40 })
  assert.equal(raised.maxRoomMembers, 12)
  assert.equal(raised.chatSendPerMin, 40)
  assert.equal(getChatRoomMembersCap(), 12)

  const overCeil = store.setMeta({ maxRoomMembers: LIMITS_META_CEILINGS.maxRoomMembers + 999 })
  assert.equal(overCeil.maxRoomMembers, LIMITS_META_CEILINGS.maxRoomMembers)

  const underFloor = store.setMeta({ chatExportPerMin: 0 })
  assert.equal(underFloor.chatExportPerMin, LIMITS_META_FLOORS.chatExportPerMin)

  // TCC-R1143-CHAT-016: chatEditWindowSec default / floor / ceiling clamp.
  assert.equal(LIMITS_META_DEFAULTS.chatEditWindowSec, 1800)
  assert.equal(LIMITS_META_FLOORS.chatEditWindowSec, 60)
  assert.equal(LIMITS_META_CEILINGS.chatEditWindowSec, 86400)
  assert.equal(store.getMeta().chatEditWindowSec, 1800)
  const editRaised = store.setMeta({ chatEditWindowSec: 3600 })
  assert.equal(editRaised.chatEditWindowSec, 3600)
  const editOverCeil = store.setMeta({ chatEditWindowSec: LIMITS_META_CEILINGS.chatEditWindowSec + 999 })
  assert.equal(editOverCeil.chatEditWindowSec, LIMITS_META_CEILINGS.chatEditWindowSec)
  const editUnderFloor = store.setMeta({ chatEditWindowSec: 1 })
  assert.equal(editUnderFloor.chatEditWindowSec, LIMITS_META_FLOORS.chatEditWindowSec)

  const again = new TeamLimitsStore(dir)
  assert.equal(again.getMeta().maxRoomMembers, LIMITS_META_CEILINGS.maxRoomMembers)
  assert.equal(again.getMeta().chatEditWindowSec, LIMITS_META_FLOORS.chatEditWindowSec)

  console.log('limits-store: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
