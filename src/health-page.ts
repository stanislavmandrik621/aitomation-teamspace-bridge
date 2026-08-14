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

/** Historic probe body. Byte-identical for every non-HTML Accept. */
export const HEALTH_PLAIN_BODY = 'AItomation Team Space bridge\n'

/** Desktop Settings probe reads at most this many bytes. */
export const HEALTH_PROBE_MAX_BYTES = 4096

/** Refuse a huge Accept header (fail closed to plain text). */
export const HEALTH_ACCEPT_HEADER_MAX = 2048

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
 * True only when the client asked for HTML (browsers). Missing Accept,
 * any-type Accept, and text/plain stay on the historic probe body.
 */
export function wantsHealthHtml(acceptHeader: unknown): boolean {
  if (typeof acceptHeader !== 'string') return false
  if (acceptHeader.length === 0 || acceptHeader.length > HEALTH_ACCEPT_HEADER_MAX) return false
  return acceptHeader.toLowerCase().includes('text/html')
}

/** Compact status page. Must stay under HEALTH_PROBE_MAX_BYTES. */
export function healthPageHtml(): string {
  return (
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
  )
}
