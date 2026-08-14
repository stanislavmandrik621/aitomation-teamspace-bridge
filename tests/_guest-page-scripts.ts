/**
 * Test helper: rebuild each guest shell's embedded <script> source exactly
 * as server.ts emits it, WITHOUT importing server.ts (which boots a real
 * HTTP+WS listener as a module side effect - the same reason every other
 * bridge test source-scans it instead of importing it).
 *
 * Extraction: each shell passes its script as a `scriptJs: \`...\`` template
 * literal whose body deliberately contains no backticks, so the region runs
 * from the opening backtick to the next backtick. The known interpolations
 * are substituted with the real shared constants; any interpolation this
 * helper does not know fails loudly instead of silently parsing a hole.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  GUEST_ESC_JS,
  GUEST_FORM_FIELD_JS,
  GUEST_GATE_JS,
  GUEST_RENDER_JS,
} from '../src/guest-page-render.js'

const KNOWN_INTERPOLATIONS: Record<string, string> = {
  '${safeTok}': JSON.stringify('test-token'),
  '${GUEST_ESC_JS}': GUEST_ESC_JS,
  '${GUEST_GATE_JS}': GUEST_GATE_JS,
  '${GUEST_RENDER_JS}': GUEST_RENDER_JS,
  '${GUEST_FORM_FIELD_JS}': GUEST_FORM_FIELD_JS,
}

export function guestPageScripts(): Record<string, string> {
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    'utf8',
  )
  const shells = [
    'function guestShareShellHtml',
    'function guestComposeShareShellHtml',
    'function guestPortalShellHtml',
  ]
  const out: Record<string, string> = {}
  for (const anchor of shells) {
    const fnStart = serverSrc.indexOf(anchor)
    if (fnStart < 0) throw new Error(`shell function missing: ${anchor}`)
    const marker = 'scriptJs: `'
    const scriptStart = serverSrc.indexOf(marker, fnStart)
    if (scriptStart < 0) throw new Error(`scriptJs template missing in ${anchor}`)
    const bodyStart = scriptStart + marker.length
    const bodyEnd = serverSrc.indexOf('`', bodyStart)
    if (bodyEnd < 0) throw new Error(`scriptJs template not closed in ${anchor}`)
    let script = serverSrc.slice(bodyStart, bodyEnd)
    for (const [needle, replacement] of Object.entries(KNOWN_INTERPOLATIONS)) {
      script = script.split(needle).join(replacement)
    }
    const leftover = script.indexOf('${')
    if (leftover >= 0) {
      throw new Error(
        `unknown interpolation in ${anchor}: ${script.slice(leftover, leftover + 40)}`,
      )
    }
    out[anchor.replace('function ', '')] = script
  }
  return out
}
