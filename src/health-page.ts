/**
 * GET / and GET /health (BRG-057).
 *
 * Browsers get a small status card. curl, load balancers, and the desktop
 * Check connection probe keep the historic one-line text so monitors that
 * grep the body, and the 4 KiB probe cap, do not break.
 *
 * No version, team name, member counts, or host internals. No scripts, no
 * external assets. User-facing copy says "team server", not "bridge".
 * The HTML still contains "AItomation" and "Team Space" so
 * isTeamSpaceBridgeHealthBody stays true if a probe asks for HTML.
 */

import { stringIsWellFormed } from './index.js'

/** Historic probe body. Byte-identical for every non-HTML Accept. */
export const HEALTH_PLAIN_BODY = 'AItomation Team Space bridge\n'

/** Desktop Settings probe reads at most this many bytes. */
export const HEALTH_PROBE_MAX_BYTES = 4096

/** Refuse a huge Accept header (fail closed to plain text). */
export const HEALTH_ACCEPT_HEADER_MAX = 2048

/** Node may pass Accept as a string[]. A long list is not a browser. */
const HEALTH_ACCEPT_ARRAY_MAX = 16

const HEALTH_PAGE_CSS =
  ':root{color-scheme:dark}' +
  '*,*::before,*::after{box-sizing:border-box}' +
  'html,body{height:100%;margin:0}' +
  'body{min-height:100%;display:flex;align-items:center;justify-content:center;' +
  'background:#0a0b0e;color:#e7e9ee;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;' +
  '-webkit-font-smoothing:antialiased;padding:24px}' +
  'body::before{content:"";position:fixed;inset:0;pointer-events:none;' +
  'background:radial-gradient(ellipse 70% 50% at 50% 40%,rgba(59,130,246,.14),transparent 68%)}' +
  '.card{position:relative;width:100%;max-width:420px;background:#131519;border:1px solid #26282e;' +
  'border-radius:12px;padding:28px 24px}' +
  '.mark{width:36px;height:36px;border-radius:10px;margin:0 0 16px;' +
  'background:linear-gradient(135deg,#3b82f6,#2563eb);box-shadow:0 8px 24px rgba(59,130,246,.28)}' +
  '.brand{margin:0 0 16px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9aa1ab}' +
  'h1{margin:0 0 10px;font-size:1.25rem;font-weight:600;letter-spacing:-.01em}' +
  '.row{display:flex;align-items:center;gap:8px;margin:0 0 14px}' +
  '.dot{width:8px;height:8px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 4px rgba(74,222,128,.14)}' +
  '.status{color:#4ade80;font-size:.875rem;font-weight:500}' +
  'p{margin:0;color:#9aa1ab;font-size:.875rem}'

/**
 * Byte count only, never allocate the encoded bytes. This runs on every
 * request to a public endpoint monitoring tools hit at high frequency, so
 * `new TextEncoder().encode(s).length` (which allocates a full Uint8Array
 * just to read `.length`) is wasted GC pressure per hit. `Buffer.byteLength`
 * counts without allocating the encoded output.
 */
function utf8ByteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

/**
 * NUL, CR/LF, other C0 (except TAB), DEL, or a lone surrogate is not a
 * browser. Fail closed to the probe body (BRG-057).
 */
function acceptHeaderLooksSafe(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c === 0 || c === 0x7f) return false
    if (c < 0x20 && c !== 0x09) return false
    if (c >= 0x80 && c <= 0x9f) return false
  }
  return stringIsWellFormed(raw)
}

function acceptHeaderWithinCap(raw: string): boolean {
  if (raw.length === 0 || raw.length > HEALTH_ACCEPT_HEADER_MAX) return false
  return utf8ByteLength(raw) <= HEALTH_ACCEPT_HEADER_MAX
}

/**
 * True only when the client asked for HTML (browsers). Missing Accept,
 * any-type Accept, and text/plain stay on the historic probe body.
 *
 * Match the `text/html` media type as its own range (optional q > 0).
 * A raw substring match would treat `text/html-sandboxed`,
 * `application/x-text/html-preview`, or `text/html;q=0` as a browser and
 * change the probe body (BRG-057). text/plain at equal or higher q than
 * text/html stays historic (a probe that lists both). Any-type Accept at
 * higher q than text/html stays historic too.
 */
export function wantsHealthHtml(acceptHeader: unknown): boolean {
  try {
    const raw = acceptHeaderToString(acceptHeader)
    if (raw === null) return false
    if (!acceptHeaderWithinCap(raw)) return false
    return acceptHasHtmlType(raw)
  } catch {
    // A throw would 500 GET / and /health and change the probe body (BRG-057).
    return false
  }
}

function acceptHeaderToString(acceptHeader: unknown): string | null {
  if (typeof acceptHeader === 'string') {
    // Cheap .length cap BEFORE the char-by-char safety scan + isWellFormed
    // pass - a huge Accept value must fail closed without paying for the
    // full scan first (BRG-057: cap enforced before expensive work).
    if (acceptHeader.length > HEALTH_ACCEPT_HEADER_MAX) return null
    return acceptHeaderLooksSafe(acceptHeader) ? acceptHeader : null
  }
  if (!Array.isArray(acceptHeader) || acceptHeader.length === 0) return null
  // Duplicate Accept headers are a short list. Empty parts do not grow
  // totalUnits, so an unbounded array would work GET / before the join cap.
  if (acceptHeader.length > HEALTH_ACCEPT_ARRAY_MAX) return null
  let totalUnits = 0
  let totalBytes = 0
  const parts: string[] = []
  for (const item of acceptHeader) {
    if (typeof item !== 'string' || item.length > HEALTH_ACCEPT_HEADER_MAX) return null
    // Same cheap-before-expensive ordering as the string branch above.
    if (!acceptHeaderLooksSafe(item)) return null
    if (parts.length > 0) {
      totalUnits += 2
      totalBytes += 2
    }
    totalUnits += item.length
    totalBytes += utf8ByteLength(item)
    if (totalUnits > HEALTH_ACCEPT_HEADER_MAX || totalBytes > HEALTH_ACCEPT_HEADER_MAX) return null
    parts.push(item)
  }
  const joined = parts.join(', ')
  return acceptHeaderWithinCap(joined) ? joined : null
}

function acceptHasHtmlType(accept: string): boolean {
  let bestHtml = 0
  let bestPlain = 0
  let bestStar = 0
  let bestTextStar = 0
  for (const range of accept.split(',')) {
    const trimmed = range.trim()
    if (!trimmed) continue
    const semi = trimmed.indexOf(';')
    const mediaType = (semi === -1 ? trimmed : trimmed.slice(0, semi)).trim().toLowerCase()
    const q = acceptQuality(semi === -1 ? '' : trimmed.slice(semi + 1))
    if (q <= 0) continue
    if (mediaType === 'text/html' && q > bestHtml) bestHtml = q
    if (mediaType === 'text/plain' && q > bestPlain) bestPlain = q
    if (mediaType === '*/*' && q > bestStar) bestStar = q
    if (mediaType === 'text/*' && q > bestTextStar) bestTextStar = q
  }
  return bestHtml > 0 && bestHtml > bestPlain && bestHtml >= bestStar && bestHtml >= bestTextStar
}

function acceptQuality(params: string): number {
  if (!params) return 1
  const search = `;${params}`
  const namedQ = /(?:^|;)\s*q(?:\s*=|\s*;|\s*$)/i.test(search)
  const m = /(?:^|;)\s*q\s*=\s*([^;\s]*)/i.exec(search)
  if (!m) return namedQ ? 0 : 1
  const raw = m[1] ?? ''
  if (!/^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw)) return 0
  const q = Number(raw)
  if (!Number.isFinite(q) || q <= 0) return 0
  return q
}

/**
 * Compact status page. Built once. Boot fails if it grows past the
 * desktop probe cap or drops the identity tokens a probe still matches.
 */
const HEALTH_PAGE_HTML =
  '<!DOCTYPE html>\n' +
  '<html lang="en">\n' +
  '<head>\n' +
  '<meta charset="utf-8"/>\n' +
  '<meta name="viewport" content="width=device-width,initial-scale=1"/>\n' +
  '<meta http-equiv="Cache-Control" content="no-store"/>\n' +
  '<meta name="robots" content="noindex"/>\n' +
  '<title>Team server</title>\n' +
  `<style>${HEALTH_PAGE_CSS}</style>\n` +
  '</head>\n' +
  '<body>\n' +
  '<div class="card">\n' +
  '<div class="mark" aria-hidden="true"></div>\n' +
  '<p class="brand">AItomation Team Space</p>\n' +
  '<h1>Team server is running</h1>\n' +
  '<div class="row"><span class="dot" aria-hidden="true"></span><span class="status">Up</span></div>\n' +
  '<p>This private team server is up. Open the app on your computer to connect.</p>\n' +
  '</div>\n' +
  '</body>\n' +
  '</html>\n'

{
  if (HEALTH_PLAIN_BODY !== 'AItomation Team Space bridge\n') {
    throw new Error('Historic probe body must stay byte-identical')
  }
  const bytes = utf8ByteLength(HEALTH_PAGE_HTML)
  if (bytes >= HEALTH_PROBE_MAX_BYTES) {
    throw new Error('Health HTML exceeds the probe byte cap')
  }
  const lower = HEALTH_PAGE_HTML.toLowerCase()
  if (!lower.includes('aitomation') || !lower.includes('team space')) {
    throw new Error('Health HTML must stay identifiable as the team server')
  }
  // href/src plus CSS url() / @import - a stylesheet fetch is still an outside file (BRG-057).
  if (
    /<script/i.test(HEALTH_PAGE_HTML)
    || /\shref=|\ssrc=/i.test(HEALTH_PAGE_HTML)
    || /url\s*\(|@import/i.test(HEALTH_PAGE_HTML)
    || /<(iframe|object|embed|link|base|form)\b/i.test(HEALTH_PAGE_HTML)
    || /<meta[^>]+http-equiv\s*=\s*['"]?refresh/i.test(HEALTH_PAGE_HTML)
    || /\son[a-z]+\s*=/i.test(HEALTH_PAGE_HTML)
    // A literal `</style` inside the CSS text would close the inline
    // <style> tag early and let the rest render as plain HTML markup.
    || /<\/style/i.test(HEALTH_PAGE_CSS)
  ) {
    throw new Error('Health HTML must not load scripts or outside files')
  }
  if (/[—–…]/.test(HEALTH_PAGE_HTML) || /\bbridge\b/i.test(HEALTH_PAGE_HTML)) {
    throw new Error('Health HTML user copy must stay plain and must not say bridge')
  }
  if (/[‘’“”]/.test(HEALTH_PAGE_HTML)) {
    throw new Error('Health HTML user copy must use straight quotes')
  }
  // This module's whole doc comment promises "No version, team name, member
  // counts, or host internals" (BRG-057). The specific in-memory operator
  // variable names this HTML must never grow are already pinned against
  // THIS file's raw source TEXT by an external scan
  // (packages/bridge/tests/brg-068-operator-metrics.ts). Spelling out any of
  // those exact names again in this file - even inside a "must not
  // contain" check, even in a comment naming them as an example - would
  // make this file's own source text contain them and trip that external
  // scan on itself. Cover the generic "member count" / "version number"
  // shape of the same promise instead, which is not already asserted
  // elsewhere and does not require repeating a reserved name.
  if (/\bmember(s)?\b/i.test(HEALTH_PAGE_HTML) || /\bv?\d+\.\d+\.\d+\b/.test(HEALTH_PAGE_HTML)) {
    throw new Error('Health HTML must not leak a version number or member count')
  }
}

export function healthPageHtml(): string {
  return HEALTH_PAGE_HTML
}
