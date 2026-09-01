/**
 * G11 re-audit residual ("desktop copy pin; list hide above 2000"): the
 * TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row in docs/SELF-HOST.md claimed raising
 * the env var past 2000 "still hides older rooms from the list" - that was
 * true before G11-CORE raised the bridge's own CHAT_ROOMS_LIST_MAX to
 * 20_000 (see tests/chat-rooms-total-ceiling.ts) but was never corrected in
 * the operator-facing doc. This pin ties the doc row to the live source
 * facts on BOTH sides of the wire:
 *   - bridge: CHAT_ROOMS_LIST_MAX (chat-rooms-store.ts) must already cover
 *     the full range CHAT_ROOMS_TOTAL_MAX can be raised to (throughput.ts).
 *   - desktop: TEAMSPACE_CHAT_ROOMS_PARSE_MAX_CEILING
 *     (teamspace-settings-keys.ts) is the number this doc row must name as
 *     the desktop-side cap. If a future change raises that desktop
 *     constant (see the TAKE REQUEST filed alongside this pin), this test
 *     must fail until the doc row is updated to match - so the two sides
 *     cannot drift apart silently again.
 *
 * Pin-break (do not leave this in the tree):
 *   Restore the old sentence "still hides older rooms from the list" in
 *   the TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row. This file then EXIT 1. Revert
 *   and expect green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..', '..')
const guidePath = join(root, 'docs/SELF-HOST.md')
const storeSrc = readFileSync(join(root, 'src/chat-rooms-store.ts'), 'utf8')
const throughputSrc = readFileSync(join(root, 'src/throughput.ts'), 'utf8')
const desktopKeysSrc = readFileSync(
  join(repoRoot, 'apps/desktop/src/lib/teamspace-settings-keys.ts'),
  'utf8',
)

const STALE_CLAIM = 'still hides older rooms from the list'
const REQUIRED_NEVER_HIDES = 'never hides a room below this ceiling'
const REQUIRED_DESKTOP_NOTE = 'chats this computer keeps track of'

try {
  const guide = readFileSync(guidePath, 'utf8')
  const row = guide.split('\n').find((line) => line.includes('TEAMSPACE_CHAT_ROOMS_TOTAL_MAX'))
  assert.ok(row, 'SELF-HOST.md missing the TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row')

  assert.equal(
    row!.includes(STALE_CLAIM),
    false,
    `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row still claims raising it "${STALE_CLAIM}" - that was fixed bridge-side in G11-CORE (CHAT_ROOMS_LIST_MAX = 20_000)`,
  )
  assert.ok(
    row!.includes(REQUIRED_NEVER_HIDES),
    `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row must state the room list ${REQUIRED_NEVER_HIDES}`,
  )
  assert.ok(
    row!.includes(REQUIRED_DESKTOP_NOTE),
    `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row must disclose the desktop-side "${REQUIRED_DESKTOP_NOTE}" cap`,
  )

  // Cross-check against live bridge source: the list cap must already cover
  // the top of the range the total-max env var can be raised to.
  const listMaxMatch = storeSrc.match(/export const CHAT_ROOMS_LIST_MAX = ([\d_]+)/)
  assert.ok(listMaxMatch, 'chat-rooms-store.ts missing CHAT_ROOMS_LIST_MAX')
  const liveListMax = Number(listMaxMatch![1].replace(/_/g, ''))

  const totalMaxMatch = throughputSrc.match(
    /export const CHAT_ROOMS_TOTAL_MAX = envInt\('TEAMSPACE_CHAT_ROOMS_TOTAL_MAX', [\d_]+, [\d_]+, ([\d_]+)\)/,
  )
  assert.ok(totalMaxMatch, 'throughput.ts missing the CHAT_ROOMS_TOTAL_MAX envInt ceiling')
  const liveTotalMaxCeiling = Number(totalMaxMatch![1].replace(/_/g, ''))

  assert.ok(
    liveListMax >= liveTotalMaxCeiling,
    `CHAT_ROOMS_LIST_MAX (${liveListMax}) must cover the full CHAT_ROOMS_TOTAL_MAX range (${liveTotalMaxCeiling}) or the doc claim is false again`,
  )
  assert.ok(
    row!.includes(String(liveListMax)),
    `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row must name the live list ceiling (${liveListMax})`,
  )

  // Cross-check against the live desktop-side parse ceiling named in the
  // TAKE REQUEST. If that constant is raised, this doc row must be updated
  // in the same change, or this assertion catches the new drift.
  const desktopCeilingMatch = desktopKeysSrc.match(
    /export const TEAMSPACE_CHAT_ROOMS_PARSE_MAX_CEILING = ([\d_]+)/,
  )
  assert.ok(
    desktopCeilingMatch,
    'apps/desktop/src/lib/teamspace-settings-keys.ts missing TEAMSPACE_CHAT_ROOMS_PARSE_MAX_CEILING',
  )
  const liveDesktopCeiling = Number(desktopCeilingMatch![1].replace(/_/g, ''))
  assert.ok(
    row!.includes(`\`${liveDesktopCeiling}\``),
    `TEAMSPACE_CHAT_ROOMS_TOTAL_MAX row must name the live desktop-side parse ceiling (${liveDesktopCeiling}) - update the doc when that constant changes`,
  )

  console.log('self-host-chat-rooms-ceiling-docs: ok')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exit(1)
}
