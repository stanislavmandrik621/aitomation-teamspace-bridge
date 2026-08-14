/**
 * Shared visual baseline for every guest-facing bridge page: public Module
 * share views/forms, external portal forms, Compose client pack downloads,
 * password/PIN/OTP gates, and the 404/410 not-found/gone pages.
 *
 * Guests receive one self-contained HTML document (no external assets, no
 * webfonts, no CDN scripts), so the whole look lives in this one inline CSS
 * string and every shell in server.ts embeds it via guestPageDocument().
 * Matching the desktop app's dark look: page #0a0b0e, cards #131519 with a
 * 1px #26282e border and 12px radius, text #e7e9ee, muted #9aa1ab, primary
 * buttons #3b82f6.
 */

/** Server-side HTML escape for the few strings the shells interpolate directly. */
export function escGuestHtml(s: unknown): string {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

export const GUEST_PAGE_CSS = `
:root{color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html,body{width:100%;min-width:0;min-height:100%}
body{margin:0;background:#0a0b0e;color:#e7e9ee;font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:none;margin:0;padding:20px 24px 32px;min-width:0}
main.narrow{max-width:560px;margin:0 auto;padding:20px 20px 28px}
a{color:#7cabf8;text-decoration:none}
a:hover{text-decoration:underline}
h1{font-size:1.25rem;font-weight:600;margin:0;letter-spacing:-.01em}
.page-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 12px;margin:0 0 4px}
.crumb{color:#9aa1ab;font-size:.8125rem}
.hint{color:#9aa1ab;font-size:.8125rem;margin:2px 0 20px}
.muted{color:#9aa1ab;font-size:.875rem}
.err{color:#f87171;font-size:.875rem}
.ok{color:#4ade80;font-size:.875rem}
.card{background:#131519;border:1px solid #26282e;border-radius:12px;padding:16px;margin-top:8px;width:100%;max-width:none}
.card.table-card{padding:6px 0;width:100%;max-width:100%;min-width:0;overflow:hidden}
.gate-wrap{display:flex;justify-content:center;padding-top:9vh}
.gate{width:100%;max-width:400px;background:#131519;border:1px solid #26282e;border-radius:12px;padding:28px}
.gate .muted{margin:8px 0 4px}
button{font:inherit;font-weight:500;height:36px;padding:0 16px;border:0;border-radius:8px;background:var(--guest-accent,#3b82f6);color:#fff;cursor:pointer}
button:hover{background:color-mix(in srgb,var(--guest-accent,#3b82f6) 88%,#000)}
button:disabled{opacity:.55;cursor:default}
.btn-block{display:block;width:100%;margin-top:14px}
.btn-secondary{background:#1d2027;border:1px solid #2b2e36;color:#e7e9ee}
.btn-secondary:hover{background:#232732}
label{display:block;font-size:.8125rem;color:#c3c8d1;margin-top:14px}
input,select,textarea{font:inherit;width:100%;margin-top:6px;background:#0d0f13;border:1px solid #2b2e36;border-radius:8px;color:#e7e9ee;padding:0 12px;height:36px}
textarea{height:auto;min-height:84px;padding:9px 12px;resize:vertical}
select{padding:0 10px}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--guest-accent,#3b82f6);box-shadow:0 0 0 3px color-mix(in srgb,var(--guest-accent,#3b82f6) 22%,transparent)}
input::placeholder,textarea::placeholder{color:#6b7280}
input[type=checkbox]{width:16px;height:16px;margin:0;accent-color:#3b82f6}
.checkbox-row{display:flex;align-items:center;gap:8px;margin-top:8px}
.req{color:#f87171;font-size:.75rem;margin-left:4px}
.multi{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.chip{display:inline-flex;align-items:center;gap:6px;background:#0d0f13;border:1px solid #2b2e36;border-radius:999px;padding:5px 12px;font-size:.8125rem;color:#e7e9ee;margin:0;width:auto;cursor:pointer}
.chip input{width:14px;height:14px;margin:0}
.pills{display:inline-flex;flex-wrap:wrap;gap:4px}
.pill{display:inline-flex;align-items:center;border-radius:999px;padding:2px 10px;font-size:.75rem;line-height:1.5;white-space:nowrap}
.pill-t0{background:rgba(59,130,246,.16);color:#93c5fd}
.pill-t1{background:rgba(16,185,129,.16);color:#6ee7b7}
.pill-t2{background:rgba(245,158,11,.16);color:#fcd34d}
.pill-t3{background:rgba(168,85,247,.16);color:#d8b4fe}
.pill-t4{background:rgba(236,72,153,.16);color:#f9a8d4}
.pill-t5{background:rgba(148,163,184,.16);color:#cbd5e1}
.pill-more{background:rgba(148,163,184,.12);color:#9aa1ab}
.pill-yes{background:rgba(16,185,129,.16);color:#6ee7b7}
.pill-no{background:rgba(148,163,184,.12);color:#9aa1ab}
.cell-muted{color:#6b7280}
.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:0 0 2px}
.toolbar .btn-secondary{margin-left:auto}
.table-wrap,.pivot-wrap{overflow-x:auto;overflow-y:hidden;min-width:0;max-width:100%;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:#3a3e48 #0a0b0e}
.table-wrap::-webkit-scrollbar,.pivot-wrap::-webkit-scrollbar{height:10px}
.table-wrap::-webkit-scrollbar-thumb,.pivot-wrap::-webkit-scrollbar-thumb{background:#3a3e48;border-radius:999px}
table{width:max-content;min-width:100%;border-collapse:collapse;font-size:.8125rem}
th,td{text-align:left;padding:9px 16px;border-bottom:1px solid #1e2126;vertical-align:top;white-space:nowrap}
th{color:#9aa1ab;font-weight:500;border-bottom:1px solid #26282e}
.cell-wrap,td.cell-wrap{white-space:normal;overflow-wrap:anywhere;min-width:280px;max-width:360px}
.cell-nowrap,td.cell-nowrap{white-space:nowrap}
tr:last-child td{border-bottom:0}
.empty{text-align:center;color:#9aa1ab;padding:40px 12px}
.stack{display:flex;flex-direction:column;gap:10px;margin-top:12px}
.row-card{background:#131519;border:1px solid #26282e;border-radius:12px;padding:14px 18px}
.row-title{font-weight:600;font-size:.875rem}
.kv{display:flex;gap:10px;font-size:.8125rem;margin-top:6px}
.kv-k{color:#9aa1ab;flex:0 0 130px;min-width:0}
.kv-v{flex:1;min-width:0;overflow-wrap:anywhere}
.board,.date-board{display:flex;flex-wrap:nowrap;gap:12px;overflow-x:auto;overflow-y:hidden;align-items:flex-start;margin-top:12px;padding-bottom:8px;min-width:0;-webkit-overflow-scrolling:touch;scrollbar-width:thin;scrollbar-color:#3a3e48 #0a0b0e}
.lane{flex:0 0 272px;max-width:272px;background:#101216;border:1px solid #26282e;border-radius:12px;padding:12px}
.lane-head{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:.8125rem;font-weight:600;margin:0 2px 4px;color:#c3c8d1}
.lane-head span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lane-count{flex:0 0 auto;color:#9aa1ab;font-weight:500;font-size:.75rem;background:#1b1e24;border-radius:999px;padding:1px 8px}
.board-card{background:#16181d;border:1px solid #26282e;border-radius:10px;padding:10px 12px;margin-top:8px}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:12px}
.gallery-card{background:#131519;border:1px solid #26282e;border-radius:12px;overflow:hidden}
.gallery-img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover;background:#0d0f13}
.gallery-ph{width:100%;aspect-ratio:4/3;background:linear-gradient(135deg,#14171c,#0d0f13)}
.gallery-title{padding:10px 12px;font-size:.875rem;font-weight:500}
.dash{margin-top:12px}
.dash-strip{display:flex;flex-wrap:wrap;align-items:center;gap:12px;margin:12px 0 4px}
.dash-tiles{display:flex;flex-wrap:wrap;gap:10px}
.dash-tile{background:#131519;border:1px solid #26282e;border-radius:12px;padding:12px 16px;min-width:112px}
.dash-tile-n{font-size:1.375rem;font-weight:600;letter-spacing:-.02em;line-height:1.2}
.dash-tile-k{color:#9aa1ab;font-size:.75rem;margin-top:2px}
.chart-wrap,.dash,.tl,.sched,.board,.date-board,.gallery,.stack,.tree,.map-list{width:100%;max-width:none}
.table-wrap,.pivot-wrap,.cal{width:100%;max-width:100%}
.chart-wrap{width:100%;max-width:none;margin-top:12px;background:#131519;border:1px solid #26282e;border-radius:12px;padding:16px 16px 8px}
.chart-svg{display:block;width:100%;height:auto;max-height:min(70vh,720px)}
.chart-pie,.chart-donut{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px}
.chart-pie .chart-svg,.chart-donut .chart-svg{flex:1 1 280px;max-width:520px}
.chart-pie .chart-legend,.chart-donut .chart-legend{flex:1 1 220px}
.chart-legend{display:flex;flex-wrap:wrap;gap:8px 16px;margin:4px 4px 12px}
.chart-legend-i{display:inline-flex;align-items:center;gap:6px;font-size:.75rem;color:#c3c8d1}
.chart-swatch{width:10px;height:10px;border-radius:2px;flex:0 0 auto}
.cal{display:grid;grid-template-columns:repeat(7,minmax(88px,1fr));gap:4px;margin-top:12px;width:100%;max-width:100%;overflow-x:auto;min-width:0;-webkit-overflow-scrolling:touch}
.cal-dow{color:#9aa1ab;font-size:.75rem;text-align:center;padding:6px 2px}
.cal-day{background:#131519;border:1px solid #26282e;border-radius:8px;min-height:92px;padding:6px;min-width:0}
.cal-day.out{opacity:.45}
.cal-day-n{color:#9aa1ab;font-size:.75rem}
.cal-item{font-size:.75rem;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pivot-wrap{margin-top:12px}
.tl{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.tl-row{display:flex;gap:12px;align-items:center}
.tl-lab{flex:0 0 180px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:.8125rem}
.tl-track{flex:1;min-width:0;height:28px;background:#101216;border:1px solid #26282e;border-radius:8px;position:relative}
.tl-bar{position:absolute;top:4px;bottom:4px;border-radius:6px;background:#3b82f6;min-width:8px}
.sched{margin-top:12px;display:flex;flex-direction:column;gap:8px;width:100%}
.wl-track{height:8px;background:#101216;border:1px solid #26282e;border-radius:999px;margin:6px 0 4px;overflow:hidden}
.wl-bar{height:100%;background:#3b82f6;border-radius:999px;min-width:4px}
.tree{padding:12px 16px}
.tree-row{padding:6px 0}
.tree details{margin:2px 0}
.tree summary{list-style:none;cursor:pointer}
.tree summary::-webkit-details-marker{display:none}
.table-card tbody th[colspan]{background:#101216;font-weight:600;color:#c3c8d1}
.doc-body{margin-top:8px;color:#c3c8d1;font-size:.8125rem;white-space:normal;overflow-wrap:anywhere}
.cal-undated{margin-top:12px}
.brand{display:flex;align-items:center;gap:14px;margin:0 0 10px}
.brand img{height:44px;width:auto;border-radius:8px;object-fit:contain}
.tag{color:#9aa1ab;font-size:.875rem;margin:2px 0 0}
.swatches{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.swatch{width:16px;height:16px;border-radius:4px;border:1px solid #26282e}
.footer{color:#9aa1ab;font-size:.75rem;margin-top:16px}
@media (max-width:640px){
main{padding:20px 12px 48px}
.card{padding:16px}
.gate{padding:22px}
.kv{flex-direction:column;gap:2px}
.kv-k{flex:none}
.dash-tile{min-width:0;flex:1 1 calc(50% - 10px)}
.tl-row{flex-direction:column;align-items:stretch}
.tl-lab{flex:none}
.cal-day{min-height:72px}
.gallery{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}
.sched .tl-lab,.tl-lab{flex:none}
}
`

/**
 * Guest HTML (share / portal / compose / 404) must not be cached. Same URL
 * also serves JSON when Accept is application/json, so Vary: Accept. JSON
 * already used no-store; HTML without it left a Chart share painting the
 * previous inline renderer (tiles + table) after the listener was rebuilt.
 */
export const GUEST_HTML_RESPONSE_HEADERS: Record<string, string> = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'pragma': 'no-cache',
  'vary': 'Accept',
}

/**
 * Wrap a guest page body (and optional inline script) in the shared shell
 * document. `title` is escaped here; `bodyHtml`/`scriptJs` are trusted
 * template output built by the callers in server.ts (everything dynamic in
 * them is escaped at build time or client-side via esc()).
 */
export function guestPageDocument(args: {
  title: string
  bodyHtml: string
  scriptJs?: string
  narrow?: boolean
}): string {
  const script = args.scriptJs ? `<script>${args.scriptJs}</script>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta http-equiv="Cache-Control" content="no-store"/>
<meta name="robots" content="noindex"/>
<title>${escGuestHtml(args.title)}</title>
<style>${GUEST_PAGE_CSS}</style>
</head>
<body>
<main${args.narrow ? ' class="narrow"' : ''}>${args.bodyHtml}</main>
${script}
</body>
</html>`
}

/**
 * Styled static page for the guest 404/410 responses (share/portal/compose
 * not found, revoked, expired). Same baseline as the live pages so a dead
 * link still looks intentional. Message stays plain English, ASCII only.
 */
export function guestErrorPageHtml(title: string, message: string): string {
  return guestPageDocument({
    title,
    narrow: true,
    bodyHtml:
      `<div class="gate-wrap"><div class="gate"><h1>${escGuestHtml(title)}</h1>` +
      `<p class="muted" style="margin:10px 0 0">${escGuestHtml(message)}</p></div></div>`,
  })
}
