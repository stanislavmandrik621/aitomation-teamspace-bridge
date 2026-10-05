/**
 * BRG-070 residual (G10 DOCUMENT-THE-RISK): host sudden-power loss can
 * drop the last writes the app already accepted. The stated decision
 * lives in docs/SELF-HOST.md, not in a flush. This pin only requires
 * that guide paragraph. It does not scan store writers and it does not
 * require any flush call to stay absent.
 *
 * Unique phrases (must both appear, and not only on the presence
 * heartbeat row that says "lost power"):
 *   - loses power suddenly
 *   - already accepted
 *
 * Pin-break (do not leave this in the tree):
 *   Delete the "Sudden power loss" subsection in docs/SELF-HOST.md
 *   (the paragraph that contains both unique phrases). This file then
 *   EXIT 1. Restore the subsection. Expect green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const guidePath = join(root, 'docs/SELF-HOST.md')

const LOSES_POWER_SUDDENLY = 'loses power suddenly'
const ALREADY_ACCEPTED = 'already accepted'
const PRESENCE_FALSE_FRIEND = 'lost power'

try {
  const guide = readFileSync(guidePath, 'utf8')

  const suddenIdx = guide.indexOf(LOSES_POWER_SUDDENLY)
  const acceptedIdx = guide.indexOf(ALREADY_ACCEPTED)
  assert.ok(suddenIdx >= 0, `SELF-HOST.md missing "${LOSES_POWER_SUDDENLY}"`)
  assert.ok(acceptedIdx >= 0, `SELF-HOST.md missing "${ALREADY_ACCEPTED}"`)

  const headingIdx = guide.indexOf('### Sudden power loss')
  assert.ok(headingIdx >= 0, 'SELF-HOST.md missing ### Sudden power loss')

  const nextHeading = guide.indexOf('\n## ', headingIdx + 1)
  const section = nextHeading >= 0 ? guide.slice(headingIdx, nextHeading) : guide.slice(headingIdx)
  assert.ok(
    section.includes(LOSES_POWER_SUDDENLY),
    'unique phrase "loses power suddenly" is not inside ### Sudden power loss',
  )
  assert.ok(
    section.includes(ALREADY_ACCEPTED),
    'unique phrase "already accepted" is not inside ### Sudden power loss',
  )
  assert.equal(
    section.includes(PRESENCE_FALSE_FRIEND),
    false,
    'Sudden power loss reused presence "lost power" wording',
  )

  const presenceLine = guide
    .split('\n')
    .find((line) => line.includes('TEAMSPACE_PRESENCE_HEARTBEAT_INTERVAL_MS'))
  assert.ok(presenceLine, 'presence heartbeat row missing (false-friend check)')
  assert.equal(
    presenceLine.includes(LOSES_POWER_SUDDENLY),
    false,
    'do not satisfy this pin by editing the presence heartbeat row',
  )
  assert.equal(
    presenceLine.includes(ALREADY_ACCEPTED),
    false,
    'do not satisfy this pin by editing the presence heartbeat row',
  )

  console.log('ok')
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  console.log('FAIL', message)
  process.exit(1)
}
