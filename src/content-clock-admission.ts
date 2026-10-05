import type { ModulesSyncOp } from './index.js'
import { referenceClock } from './content-reference-data.js'

// UTC epoch time, independent of either device's display time zone. A
// broken clock must not install a future cell watermark on every replica.
export const MAX_CONTENT_CLOCK_AHEAD_MS = 5 * 60_000
export function contentClockAdmissionError(op: ModulesSyncOp, now = Date.now()): string | null {
  const patch = op.patch
  const stamps: unknown[] = [op.hlc, patch?.parentHlc]
  for (const name of ['cellHlcs', 'baseCellHlcs']) {
    const map = patch?.[name]
    if (map && typeof map === 'object' && !Array.isArray(map)) stamps.push(...Object.values(map))
  }
  for (const raw of stamps) {
    const clock = referenceClock(raw)
    if (clock && clock[0] > now + MAX_CONTENT_CLOCK_AHEAD_MS) {
      return 'This change is dated too far in the future. Correct the device date and time, sync with the team, then review and reapply the edit.'
    }
  }
  return null
}
