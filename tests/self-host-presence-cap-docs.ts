/**
 * G11 re-audit: the "Presence (online + cursors)" section in
 * docs/SELF-HOST.md never disclosed that the online-peer snapshot is
 * capped at a fixed 128 entries (PRESENCE_SNAPSHOT_MAX in
 * src/presence.ts, not an environment variable). A team at or above the
 * TEAMSPACE_MAX_WS_CONNECTIONS default (200 sockets) can silently show
 * fewer online names than are actually connected. This pin ties the doc
 * sentence to the live constant on both the bridge and the desktop, so a
 * future change to either cap must update the doc in the same change.
 *
 * Pin-break (do not leave this in the tree):
 *   Delete the "128 entries per snapshot" sentence under
 *   ## Presence (online + cursors) in docs/SELF-HOST.md. This file then
 *   EXIT 1. Restore the sentence. Expect green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = join(root, '..', '..')
const guidePath = join(root, 'docs/SELF-HOST.md')
const presenceSrc = readFileSync(join(root, 'src/presence.ts'), 'utf8')
const desktopPresenceSrc = readFileSync(
  join(repoRoot, 'apps/desktop/src/lib/teamspace-presence.ts'),
  'utf8',
)

const HEADING = '## Presence (online + cursors)'
const REQUIRED_FIXED_NOTE = 'fixed in the server, not an environment variable'

function sectionAfterHeading(src: string, heading: string): string {
  const headingIdx = src.indexOf(heading)
  assert.ok(headingIdx >= 0, `missing heading ${heading}`)
  const after = src.slice(headingIdx + heading.length)
  const next = after.search(/\n## /)
  return next >= 0 ? after.slice(0, next) : after
}

try {
  const guide = readFileSync(guidePath, 'utf8')
  const section = sectionAfterHeading(guide, HEADING)

  const bridgeCapMatch = presenceSrc.match(/export const PRESENCE_SNAPSHOT_MAX = (\d+)/)
  assert.ok(bridgeCapMatch, 'presence.ts missing PRESENCE_SNAPSHOT_MAX')
  const liveBridgeCap = Number(bridgeCapMatch![1])

  const desktopCapMatch = desktopPresenceSrc.match(
    /export const TEAMSPACE_PRESENCE_SNAPSHOT_MAX = (\d+)/,
  )
  assert.ok(desktopCapMatch, 'teamspace-presence.ts missing TEAMSPACE_PRESENCE_SNAPSHOT_MAX')
  const liveDesktopCap = Number(desktopCapMatch![1])

  assert.equal(
    liveBridgeCap,
    liveDesktopCap,
    `bridge PRESENCE_SNAPSHOT_MAX (${liveBridgeCap}) and desktop TEAMSPACE_PRESENCE_SNAPSHOT_MAX (${liveDesktopCap}) must agree - update the other constant in the same change`,
  )

  assert.ok(
    section.includes(`capped at ${liveBridgeCap} entries per snapshot`),
    `Presence section must name the live snapshot cap (${liveBridgeCap} entries)`,
  )
  assert.ok(
    section.includes(REQUIRED_FIXED_NOTE),
    `Presence section must disclose the cap is ${REQUIRED_FIXED_NOTE}`,
  )
  assert.ok(
    section.includes('TEAMSPACE_MAX_WS_CONNECTIONS'),
    'Presence section must connect the snapshot cap to the WS connection ceiling that can exceed it',
  )

  console.log('self-host-presence-cap-docs: ok')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exit(1)
}
