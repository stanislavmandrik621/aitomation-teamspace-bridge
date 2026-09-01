/**
 * Client-side renderer source for the guest pages served by server.ts.
 *
 * Guest pages are self-contained HTML documents whose data arrives as JSON
 * after the page loads (and, for protected links, after the password/PIN
 * gate), so rendering has to happen in the guest's browser. There is no
 * bundler for these pages - the shells interpolate these plain-JS source
 * strings into their own <script> IIFE, exactly like the pre-existing
 * GUEST_FORM_FIELD_JS pattern, so every shell shares one renderer and none
 * can drift.
 *
 * Everything in GUEST_RENDER_JS is a pure string -> string function with no
 * DOM access, which is what lets tests/guest-page-render.ts evaluate this
 * source in Node and pin the rendering contracts (no "[object Object]",
 * escaping, board grouping, image URL gating) without a browser.
 *
 * Template-literal escaping rules for this file: no backticks, no ${ } in
 * the embedded JS; backslashes in regex/string literals are doubled so the
 * emitted JS carries a single backslash.
 *
 * GUEST_RENDER_JS is the core string plus per-view overlays from
 * guest-views/*.ts (later function declarations win).
 */

import { GUEST_VIEW_OVERLAYS_JS } from './guest-views/index.js'

/**
 * HTML-escape helper. Every other snippet depends on this being in scope first.
 * capStr / capTrim mirror text-cap.ts (TS-CHAT-032/034/042). Guest pages have
 * no bundler, so the same contract is emitted here once instead of a per-view
 * slice (TCC-FIX-SHARE-001 display ladder sits on this helper). Do not change
 * the UTF-16 capStr contract (4000-char body lockstep). Over-length and
 * exact-fit both go through repairIfNeeded - never a toWellFormed-only fork.
 */
export const GUEST_ESC_JS = `
  function guestPlainText(s){
    if (s == null) return '';
    var t = typeof s;
    if (t === 'string') return s;
    if (t === 'number') return isFinite(s) ? String(s) : '';
    if (t === 'boolean' || t === 'bigint') return String(s);
    if (Array.isArray(s)) {
      var parts = [];
      for (var i = 0; i < s.length && i < 100; i++) {
        var p = guestPlainText(s[i]);
        if (p) parts.push(p);
      }
      return parts.join(', ');
    }
    if (t === 'object') {
      var keys = ['name','label','title','display','value','id'];
      for (var k = 0; k < keys.length; k++) {
        var v = s[keys[k]];
        if (typeof v === 'string' && v.trim()) return v;
        if (typeof v === 'number' && isFinite(v)) return String(v);
      }
      return '';
    }
    return '';
  }
  function esc(s){ return guestPlainText(s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];}); }
  var FIELD_LABEL_ACRONYMS_RE = /\\b(url|id|api|uuid|uri|ip|ui|sku|crm|erp)\\b/gi;
  function fieldLabel(name){
    var s = guestPlainText(name).trim();
    if (!s) return '';
    return s
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(FIELD_LABEL_ACRONYMS_RE, function(m){ return m.toUpperCase(); })
      .replace(/\\b\\w/g, function(c){ return c.toUpperCase(); })
      .trim();
  }
  function dropTrailingLoneSurrogate(s){
    if (!s.length) return s;
    var last = s.charCodeAt(s.length - 1);
    return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
  }
  function repairIfNeeded(s){
    var dropped = dropTrailingLoneSurrogate(s);
    if (typeof dropped.isWellFormed === 'function' && dropped.isWellFormed()) return dropped;
    if (typeof dropped.toWellFormed === 'function') return dropped.toWellFormed();
    return dropped;
  }
  function capStr(s, max){
    if (typeof max !== 'number' || !isFinite(max)) return '';
    var n = Math.floor(max);
    if (n <= 0) return '';
    if (typeof s !== 'string') return '';
    var cut = s.length <= n ? s : s.slice(0, n);
    return repairIfNeeded(cut);
  }
  function capTrim(v, max){
    if (typeof v !== 'string') return '';
    return capStr(v.trim(), max);
  }
`

/**
 * Centered gate card (password/PIN/OTP/download/error). Title and intro are
 * caller-built HTML (constants or already-escaped); body is caller-built HTML.
 */
export const GUEST_GATE_JS = `
  function gateHtml(titleHtml, introHtml, bodyHtml){
    return '<div class="gate-wrap"><div class="gate"><h1>' + titleHtml + '</h1>' + introHtml + bodyHtml + '</div></div>';
  }
`

/**
 * Read-view renderers + cell formatting. Depends on esc() (GUEST_ESC_JS).
 *
 * Payload contract:
 * - v1 and v2 both dispatch on content.viewType (the share shell copies
 *   share.viewType onto content when the payload omitted it). Version is
 *   not a layout gate.
 * - v2 adds moduleName/entityName, columns (ordered visible slugs),
 *   viewConfig {groupByFieldSlug,titleFieldSlug,imageFieldSlug,dateFieldSlug},
 *   and per-row display maps (any JSON value; the ladder below formats them).
 * - Unknown view types plus whiteboard fall back to the table renderer
 *   with an honest "simplified" note. Chart/pivot/calendar/timeline/
 *   scheduler/workload/tree/map/doc/form keep their own layouts. Desktop
 *   aliases (graph -> chart, gantt -> timeline, geo -> map, ...) resolve
 *   here so a share cannot silently table.
 *
 * Cell text can never emit "[object Object]": when display has the slug,
 * that value wins (including an empty string); otherwise use data. Then
 * the fallback ladder: primitives stringify, arrays of primitives join
 * with ", ", objects take the first string among name/label/title/
 * display/value/id, else empty. Never String(object). URL/image cells
 * unwrap url/href/src through isSafeHttpUrl (never path as a link).
 */
const GUEST_RENDER_CORE_JS = `
  function isSafeHttpUrl(u){
    if (typeof u !== 'string') return false;
    var s = u.trim();
    if (!s || s.length > 2048) return false;
    if (/[\\u0000-\\u0020\\u007f<>"'\\\\]/.test(s)) return false;
    return /^https?:\\/\\//i.test(s);
  }
  function isSafeLogoSrc(u){
    if (typeof u !== 'string') return false;
    var s = u.trim();
    if (s.length > 200000) return false;
    if (/^data:image\\/[a-zA-Z0-9.+-]+;base64,[a-zA-Z0-9+/=]+$/.test(s)) return true;
    return isSafeHttpUrl(s) && /^https:\\/\\//i.test(s);
  }
  function isHexColor(c){
    return typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim());
  }
  function isPlaceholderChrome(s){
    if (typeof s !== 'string') return true;
    var t = s.replace(/\\u0000/g,'').trim().toLowerCase();
    return !t || t === 'tagline' || t === 'your tagline' || t === 'footer' || t === 'footer text';
  }
  function firstAccentHex(palette){
    if (!Array.isArray(palette)) return '';
    for (var i = 0; i < palette.length && i < 24; i++){
      if (isHexColor(palette[i])) return String(palette[i]).trim();
    }
    return '';
  }
  function bestObjectText(o){
    var keys = ['name','label','title','display','value','id'];
    for (var i=0;i<keys.length;i++){
      var v = o[keys[i]];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' && isFinite(v)) return String(v);
    }
    return '';
  }
  function valueText(v, depth){
    depth = depth || 0;
    if (v == null) return '';
    var t = typeof v;
    if (t === 'string') return v;
    if (t === 'number') return isFinite(v) ? String(v) : '';
    if (t === 'boolean' || t === 'bigint') return String(v);
    if (Array.isArray(v)) {
      if (depth > 2) return '';
      var parts = [];
      for (var i=0;i<v.length && i<100;i++){
        var p = valueText(v[i], depth+1);
        if (p !== '') parts.push(p);
      }
      return parts.join(', ');
    }
    if (t === 'object') return bestObjectText(v);
    return '';
  }
  function rowDisplayMap(row){
    return row && row.display && typeof row.display === 'object' && !Array.isArray(row.display) ? row.display : null;
  }
  function rowHasDisplay(row, slug){
    var m = rowDisplayMap(row);
    return !!(m && slug && Object.prototype.hasOwnProperty.call(m, slug));
  }
  function rowCellText(row, slug){
    if (!slug) return '';
    if (rowHasDisplay(row, slug)) return valueText(rowDisplayMap(row)[slug], 0);
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    return valueText(d[slug], 0);
  }
  function httpUrlFromUnknown(v, depth){
    depth = depth || 0;
    if (v == null || depth > 2) return '';
    if (typeof v === 'string') {
      var s = v.trim();
      if (isSafeHttpUrl(s)) return s;
      if (!s || s.length > 8192) return '';
      if (s.charAt(0) === '[' || s.charAt(0) === '{') {
        try { return httpUrlFromUnknown(JSON.parse(s), depth + 1); }
        catch (err) { return ''; }
      }
      return '';
    }
    if (Array.isArray(v)) {
      for (var i = 0; i < v.length && i < 8; i++) {
        var u = httpUrlFromUnknown(v[i], depth + 1);
        if (u) return u;
      }
      return '';
    }
    if (typeof v === 'object') {
      var keys = ['url', 'href', 'src'];
      for (var k = 0; k < keys.length; k++) {
        if (typeof v[keys[k]] === 'string') {
          var t = v[keys[k]].trim();
          if (isSafeHttpUrl(t)) return t;
        }
      }
    }
    return '';
  }
  function rowHttpUrl(row, slug){
    if (!slug) return '';
    if (rowHasDisplay(row, slug)) {
      var fromDisp = httpUrlFromUnknown(rowDisplayMap(row)[slug], 0);
      if (fromDisp) return fromDisp;
    }
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    return httpUrlFromUnknown(d[slug], 0);
  }
  function chipItems(row, slug){
    var items = [];
    function absorb(raw){
      if (!Array.isArray(raw)) return;
      for (var i=0;i<raw.length && i<24;i++){
        var p = valueText(raw[i], 1);
        if (p) items.push(p);
      }
    }
    if (rowHasDisplay(row, slug)) {
      absorb(rowDisplayMap(row)[slug]);
      if (!items.length) {
        var txt = rowCellText(row, slug);
        items = txt ? txt.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
      }
      return items;
    }
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    absorb(d[slug]);
    if (!items.length) {
      var txt2 = rowCellText(row, slug);
      items = txt2 ? txt2.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
    }
    return items;
  }
  function chipClass(text){
    var h = 0;
    for (var i=0;i<text.length;i++){ h = ((h<<5)-h+text.charCodeAt(i))|0; }
    return 'pill-t' + (Math.abs(h)%6);
  }
  function chipsHtml(items){
    var out = '';
    var max = 8;
    for (var i=0;i<items.length && i<max;i++){
      out += '<span class="pill ' + chipClass(items[i]) + '">' + esc(items[i]) + '</span>';
    }
    if (items.length > max) out += '<span class="pill pill-more">+' + (items.length - max) + '</span>';
    return out ? '<span class="pills">' + out + '</span>' : '';
  }
  function isTruthyCell(v){
    if (v === true || v === 1) return true;
    if (typeof v === 'string') {
      var s = v.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'yes' || s === 'on';
    }
    return false;
  }
  function cellHtml(field, row){
    var slug = field && typeof field.slug === 'string' ? field.slug : '';
    var t = String((field && field.field_type) || 'text');
    var text = rowCellText(row, slug);
    if (t === 'checkbox') {
      var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
      var yes = isTruthyCell(d[slug]) || isTruthyCell(text);
      return yes ? '<span class="pill pill-yes">Yes</span>' : '<span class="pill pill-no">No</span>';
    }
    if (t === 'select' || t === 'status' || t === 'multiselect' || t === 'tags') {
      var items = chipItems(row, slug);
      return items.length ? chipsHtml(items) : '';
    }
    if (t === 'url') {
      var u = rowHttpUrl(row, slug);
      if (u) {
        var label = text.trim() || u;
        return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + esc(label) + '</a>';
      }
      return esc(text);
    }
    if (t === 'email') {
      var em = text.trim();
      if (em && em.length <= 320 && /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(em)) {
        return '<a href="mailto:' + esc(em) + '">' + esc(em) + '</a>';
      }
      return esc(text);
    }
    if (t === 'long_text' || t === 'rich_text' || t === 'notes') {
      return '<span class="cell-wrap">' + esc(text).replace(/\\r?\\n/g, '<br/>') + '</span>';
    }
    if (t === 'phone') {
      return text ? '<span class="cell-nowrap">' + esc(text) + '</span>' : '';
    }
    return esc(text);
  }
  function visibleFields(content){
    var fields = Array.isArray(content && content.fields)
      ? content.fields.filter(function(f){ return f && typeof f.slug === 'string' && f.slug; })
      : [];
    if (!fields.length) {
      var rows0 = Array.isArray(content && content.rows) ? content.rows : [];
      var first = rows0.length && rows0[0] && rows0[0].data && typeof rows0[0].data === 'object' && !Array.isArray(rows0[0].data) ? rows0[0].data : null;
      if (first) {
        return Object.keys(first).slice(0, 60).map(function(s){ return { slug: s, name: s, field_type: 'text' }; });
      }
      return [];
    }
    var cols = Array.isArray(content.columns) ? content.columns : null;
    if (!cols || !cols.length) return fields;
    var bySlug = Object.create(null);
    fields.forEach(function(f){ if (!Object.prototype.hasOwnProperty.call(bySlug, f.slug)) bySlug[f.slug] = f; });
    var out = [];
    for (var i=0;i<cols.length;i++){
      var f = typeof cols[i] === 'string' ? bySlug[cols[i]] : undefined;
      if (f) out.push(f);
    }
    return out.length ? out : fields;
  }
  function viewCfg(content){
    var c = content && content.viewConfig;
    return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
  }
  function titleSlugOf(content, cols){
    var cfg = viewCfg(content);
    if (typeof cfg.titleFieldSlug === 'string' && cfg.titleFieldSlug) return cfg.titleFieldSlug;
    return cols.length ? cols[0].slug : '';
  }
  function canonicalViewType(vt){
    var t = String(vt == null ? '' : vt).trim().toLowerCase().replace(/[\\s-]+/g, '_');
    if (!t) return 'table';
    if (t === 'board' || t === 'kanban' || t === 'scrum' || t === 'kanban_board' || t === 'cards' || t === 'pipeline' || t === 'scrum_board' || t === 'sprint_board') return 'board';
    if (t === 'grid' || t === 'spreadsheet' || t === 'datagrid' || t === 'data_table') return 'table';
    if (t === 'date_board' || t === 'datebucket' || t === 'buckets' || t === 'sla_board') return 'date_bucket';
    if (t === 'graph' || t === 'analytics' || t === 'metrics') return 'chart';
    if (t === 'stats' || t === 'summary') return 'dashboard';
    if (t === 'gantt' || t === 'roadmap') return 'timeline';
    if (t === 'agenda' || t === 'schedule' || t === 'month') return 'calendar';
    if (t === 'gallery_grid' || t === 'cards_grid' || t === 'tiles') return 'gallery';
    if (t === 'hierarchy' || t === 'outline' || t === 'nested') return 'tree';
    if (t === 'team' || t === 'capacity' || t === 'staffing') return 'workload';
    if (t === 'geo' || t === 'locations' || t === 'geospatial') return 'map';
    if (t === 'bookings' || t === 'resources' || t === 'resource_scheduler') return 'scheduler';
    if (t === 'report' || t === 'crosstab' || t === 'pivot_table') return 'pivot';
    if (t === 'activity' || t === 'activity_feed' || t === 'timeline_feed') return 'feed';
    if (t === 'wiki' || t === 'document' || t === 'documents' || t === 'page') return 'doc';
    if (t === 'drawing' || t === 'canvas' || t === 'board_draw') return 'whiteboard';
    if (t === 'mind_map' || t === 'mindmap_view') return 'mindmap';
    if (t === 'detail' || t === 'details' || t === 'record' || t === 'edit') return 'form';
    return t;
  }
  function pickGroupSlug(content, cols){
    var cfg = viewCfg(content);
    if (typeof cfg.groupByFieldSlug === 'string' && cfg.groupByFieldSlug) return cfg.groupByFieldSlug;
    var titleSlug = titleSlugOf(content, cols);
    var i, t;
    for (i=0;i<cols.length;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (t === 'select' || t === 'status') return cols[i].slug;
    }
    for (i=0;i<cols.length;i++){
      if (cols[i].slug !== titleSlug) return cols[i].slug;
    }
    return '';
  }
  function pickDateSlug(content, cols){
    var cfg = viewCfg(content);
    var keys = ['dateFieldSlug','date_field','startDateFieldSlug','start_date_field'];
    for (var i=0;i<keys.length;i++){
      var s = cfg[keys[i]];
      if (typeof s === 'string' && s) return s;
    }
    for (var j=0;j<cols.length;j++){
      var t = String(cols[j].field_type || '').toLowerCase();
      if (t === 'date' || t === 'datetime' || t === 'date_range' || t === 'created_at' || t === 'updated_at') return cols[j].slug;
    }
    return '';
  }
  function ymdFromDate(d){
    if (!d || isNaN(d.getTime())) return '';
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return String(y) + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }
  function ymdFromValue(v, depth){
    depth = depth || 0;
    if (v == null || depth > 2) return '';
    if (typeof v === 'number' && isFinite(v)) return ymdFromDate(new Date(v));
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return '';
      var m = s.match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
      if (m) return m[1] + '-' + m[2] + '-' + m[3];
      var parsed = Date.parse(s);
      if (isFinite(parsed)) return ymdFromDate(new Date(parsed));
      return '';
    }
    if (Array.isArray(v) && v.length) return ymdFromValue(v[0], depth+1);
    if (typeof v === 'object') {
      var dkeys = ['start','end','from','to','date','value'];
      for (var i=0;i<dkeys.length;i++){
        if (!Object.prototype.hasOwnProperty.call(v, dkeys[i])) continue;
        var got = ymdFromValue(v[dkeys[i]], depth+1);
        if (got) return got;
      }
    }
    return '';
  }
  function rowDateKey(row, slug){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var fromData = ymdFromValue(d[slug], 0);
    if (fromData) return fromData;
    return ymdFromValue(rowCellText(row, slug), 0);
  }
  function pickStatusSlug(cols){
    for (var i=0;i<cols.length;i++){
      var t = String(cols[i].field_type || '').toLowerCase();
      if (t === 'select' || t === 'status') return cols[i].slug;
    }
    return '';
  }
  function rowTitleHtml(row, titleSlug){
    var title = rowCellText(row, titleSlug);
    return '<div class="row-title">' + (title ? esc(title) : '<span class="cell-muted">Untitled</span>') + '</div>';
  }
  function emptyStateHtml(){
    return '<div class="card"><div class="empty">No rows to show yet.</div></div>';
  }
  function renderTableHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var thead = '<tr>' + cols.map(function(c){ return '<th>' + esc(fieldLabel(c.name || c.slug)) + '</th>'; }).join('') + '</tr>';
    var tbody = rows.map(function(r){
      return '<tr>' + cols.map(function(c){ return '<td>' + cellHtml(c, r) + '</td>'; }).join('') + '</tr>';
    }).join('');
    return '<div class="card table-card"><div class="table-wrap"><table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div></div>';
  }
  function renderListHtml(content, wrapClass){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var titleSlug = titleSlugOf(content, cols);
    var wrap = wrapClass ? String(wrapClass) : 'stack';
    return '<div class="' + wrap + '">' + rows.map(function(r){
      var kv = '';
      for (var i=0;i<cols.length;i++){
        var c = cols[i];
        if (c.slug === titleSlug) continue;
        var val = cellHtml(c, r);
        if (val === '') continue;
        kv += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
      }
      return '<div class="row-card">' + rowTitleHtml(r, titleSlug) + kv + '</div>';
    }).join('') + '</div>';
  }
  function renderBoardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var groupSlug = pickGroupSlug(content, cols);
    if (!groupSlug) return renderTableHtml(content);
    var titleSlug = titleSlugOf(content, cols);
    var MAX_LANES = 30;
    var laneOrder = [];
    var lanes = Object.create(null);
    rows.forEach(function(r){
      var key = rowCellText(r, groupSlug).trim() || 'No value';
      if (!lanes[key]) {
        if (laneOrder.length >= MAX_LANES) key = 'Other';
        if (!lanes[key]) { lanes[key] = []; laneOrder.push(key); }
      }
      lanes[key].push(r);
    });
    return '<div class="board">' + laneOrder.map(function(k){
      var cards = lanes[k].map(function(r){
        var extra = '';
        var shown = 0;
        for (var i=0;i<cols.length && shown<4;i++){
          var c = cols[i];
          if (c.slug === titleSlug || c.slug === groupSlug) continue;
          var val = cellHtml(c, r);
          if (val === '') continue;
          extra += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
          shown++;
        }
        return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + extra + '</div>';
      }).join('');
      return '<div class="lane"><div class="lane-head"><span>' + esc(k) + '</span><span class="lane-count">' + lanes[k].length + '</span></div>' + cards + '</div>';
    }).join('') + '</div>';
  }
  function renderGalleryHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var imgSlug = typeof cfg.imageFieldSlug === 'string' ? cfg.imageFieldSlug : '';
    var titleSlug = titleSlugOf(content, cols);
    return '<div class="gallery">' + rows.map(function(r){
      var img = '';
      if (imgSlug) {
        var d = r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
        var u = valueText(d[imgSlug], 0).trim();
        if (isSafeHttpUrl(u)) img = '<img class="gallery-img" loading="lazy" alt="" src="' + esc(u) + '"/>';
      }
      if (!img) img = '<div class="gallery-ph"></div>';
      var title = rowCellText(r, titleSlug);
      return '<div class="gallery-card">' + img + '<div class="gallery-title">' + (title ? esc(title) : '<span class="cell-muted">Untitled</span>') + '</div></div>';
    }).join('') + '</div>';
  }
  function renderDateBoardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var dateSlug = pickDateSlug(content, cols);
    var titleSlug = titleSlugOf(content, cols);
    var MAX_LANES = 30;
    var laneOrder = [];
    var lanes = Object.create(null);
    rows.forEach(function(r){
      var key = dateSlug ? rowDateKey(r, dateSlug) : '';
      if (!key) key = 'No date';
      if (!lanes[key]) {
        var named = 0;
        for (var li=0;li<laneOrder.length;li++){
          if (laneOrder[li] !== 'No date' && laneOrder[li] !== 'Other') named++;
        }
        if (key !== 'No date' && named >= MAX_LANES) key = 'Other';
        if (!lanes[key]) { lanes[key] = []; laneOrder.push(key); }
      }
      lanes[key].push(r);
    });
    var dates = [];
    var hasOther = false;
    var hasNone = false;
    for (var i=0;i<laneOrder.length;i++){
      var k = laneOrder[i];
      if (k === 'No date') hasNone = true;
      else if (k === 'Other') hasOther = true;
      else dates.push(k);
    }
    dates.sort();
    laneOrder = dates.slice();
    if (hasOther) laneOrder.push('Other');
    if (hasNone) laneOrder.push('No date');
    return '<div class="date-board">' + laneOrder.map(function(k){
      var cards = lanes[k].map(function(r){
        var extra = '';
        var shown = 0;
        for (var ci=0;ci<cols.length && shown<4;ci++){
          var c = cols[ci];
          if (c.slug === titleSlug || c.slug === dateSlug) continue;
          var val = cellHtml(c, r);
          if (val === '') continue;
          extra += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
          shown++;
        }
        return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + extra + '</div>';
      }).join('');
      return '<div class="lane"><div class="lane-head"><span>' + esc(k) + '</span><span class="lane-count">' + lanes[k].length + '</span></div>' + cards + '</div>';
    }).join('') + '</div>';
  }
  function chartFills(){
    return ['#3b82f6','#10b981','#f59e0b','#a855f7','#ec4899','#64748b','#06b6d4','#f97316'];
  }
  function numFromCell(row, slug){
    if (!slug) return 0;
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var v = d[slug];
    if (typeof v === 'number' && isFinite(v)) return v;
    var s = rowCellText(row, slug).replace(/[^0-9.+-]/g, '');
    var n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }
  function pickXSlug(content, cols){
    var cfg = viewCfg(content);
    if (typeof cfg.xFieldSlug === 'string' && cfg.xFieldSlug) return cfg.xFieldSlug;
    return pickGroupSlug(content, cols);
  }
  function pickYSlug(content){
    var cfg = viewCfg(content);
    return (typeof cfg.yFieldSlug === 'string' && cfg.yFieldSlug) ? cfg.yFieldSlug : '';
  }
  function pickChartType(content){
    var cfg = viewCfg(content);
    var raw = String(cfg.chartType || cfg.chart_type || '').trim().toLowerCase();
    if (raw === 'pie' || raw === 'donut' || raw === 'line' || raw === 'bar') return raw;
    return 'bar';
  }
  function pickYAgg(content, hasY){
    var cfg = viewCfg(content);
    var raw = String(cfg.yAgg || cfg.y_agg || '').trim().toLowerCase();
    if (!hasY) return 'count';
    if (raw === 'sum' || raw === 'avg' || raw === 'min' || raw === 'max' || raw === 'count') return raw;
    return 'sum';
  }
  function chartBuckets(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var xSlug = pickXSlug(content, cols);
    var ySlug = pickYSlug(content);
    var agg = pickYAgg(content, !!ySlug);
    var counts = Object.create(null);
    var sums = Object.create(null);
    var mins = Object.create(null);
    var maxs = Object.create(null);
    var order = [];
    rows.forEach(function(r){
      var key = (xSlug ? rowCellText(r, xSlug) : '').trim() || 'No value';
      if (!counts[key]) { counts[key] = 0; sums[key] = 0; mins[key] = Infinity; maxs[key] = -Infinity; order.push(key); }
      counts[key]++;
      var n = ySlug ? numFromCell(r, ySlug) : 1;
      sums[key] += n;
      if (n < mins[key]) mins[key] = n;
      if (n > maxs[key]) maxs[key] = n;
    });
    var out = [];
    var cap = 12;
    var other = 0;
    for (var i=0;i<order.length;i++){
      var k = order[i];
      var v;
      if (agg === 'count') v = counts[k];
      else if (agg === 'avg') v = counts[k] ? sums[k] / counts[k] : 0;
      else if (agg === 'min') v = mins[k] === Infinity ? 0 : mins[k];
      else if (agg === 'max') v = maxs[k] === -Infinity ? 0 : maxs[k];
      else v = sums[k];
      if (!isFinite(v)) v = 0;
      if (agg === 'avg') v = Math.round(v * 100) / 100;
      if (out.length >= cap) { other += v; continue; }
      out.push({ k: k, v: v });
    }
    if (other) out.push({ k: 'Other', v: Math.round(other * 100) / 100 });
    return out;
  }
  function chartLegendHtml(buckets){
    var fills = chartFills();
    var items = '';
    for (var i=0;i<buckets.length;i++){
      items += '<span class="chart-legend-i"><span class="chart-swatch" style="background:' + fills[i % fills.length] + '"></span>'
        + esc(buckets[i].k) + ' (' + esc(String(buckets[i].v)) + ')</span>';
    }
    return items ? '<div class="chart-legend">' + items + '</div>' : '';
  }
  function renderBarSvg(buckets){
    var fills = chartFills();
    var max = 0;
    var i;
    for (i=0;i<buckets.length;i++) if (buckets[i].v > max) max = buckets[i].v;
    if (max <= 0) max = 1;
    var w = 960, h = 320, padL = 36, padB = 56, padT = 28, padR = 16;
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var n = Math.max(buckets.length, 1);
    var slot = innerW / n;
    var bw = Math.max(10, slot * 0.62);
    var parts = [];
    for (i=0;i<buckets.length;i++){
      var bh = (buckets[i].v / max) * innerH;
      var x = padL + i * slot + (slot - bw) / 2;
      var y = padT + innerH - bh;
      var cx = x + bw / 2;
      var label = buckets[i].k.length > 14 ? capStr(buckets[i].k, 13) + '...' : capStr(buckets[i].k, 14);
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(bh, 1) + '" rx="5" fill="' + fills[i % fills.length] + '"/>');
      parts.push('<text x="' + cx + '" y="' + (y - 6) + '" text-anchor="middle" fill="#e7e9ee" font-size="11">' + esc(String(buckets[i].v)) + '</text>');
      parts.push('<text x="' + cx + '" y="' + (h - 18) + '" text-anchor="middle" fill="#9aa1ab" font-size="11">' + esc(label) + '</text>');
    }
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">' + parts.join('') + '</svg>';
  }
  function renderLineSvg(buckets){
    var fills = chartFills();
    var max = 0;
    var i;
    for (i=0;i<buckets.length;i++) if (buckets[i].v > max) max = buckets[i].v;
    if (max <= 0) max = 1;
    var w = 960, h = 320, padL = 36, padB = 56, padT = 28, padR = 16;
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var n = Math.max(buckets.length - 1, 1);
    var pts = [];
    var dots = [];
    for (i=0;i<buckets.length;i++){
      var x = padL + (buckets.length === 1 ? innerW / 2 : (i / n) * innerW);
      var y = padT + innerH - (buckets[i].v / max) * innerH;
      pts.push(x + ',' + y);
      dots.push('<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + fills[0] + '"/>');
      dots.push('<text x="' + x + '" y="' + (y - 10) + '" text-anchor="middle" fill="#e7e9ee" font-size="11">' + esc(String(buckets[i].v)) + '</text>');
      var label = buckets[i].k.length > 14 ? capStr(buckets[i].k, 13) + '...' : capStr(buckets[i].k, 14);
      dots.push('<text x="' + x + '" y="' + (h - 18) + '" text-anchor="middle" fill="#9aa1ab" font-size="11">' + esc(label) + '</text>');
    }
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">'
      + '<polyline fill="none" stroke="' + fills[0] + '" stroke-width="2.5" points="' + pts.join(' ') + '"/>'
      + dots.join('') + '</svg>';
  }
  function renderPieSvg(buckets, donut){
    var fills = chartFills();
    var total = 0;
    var i;
    for (i=0;i<buckets.length;i++) total += buckets[i].v;
    if (total <= 0) return emptyStateHtml();
    var cx = 180, cy = 160, r = 92;
    var circ = 2 * Math.PI * r;
    var acc = 0;
    var parts = [];
    var strokeW = donut ? 36 : 92;
    for (i=0;i<buckets.length;i++){
      var frac = buckets[i].v / total;
      var dash = Math.max(frac * circ, 0.01);
      var gap = Math.max(circ - dash, 0);
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + fills[i % fills.length]
        + '" stroke-width="' + strokeW + '" stroke-dasharray="' + dash + ' ' + gap
        + '" stroke-dashoffset="' + (-acc) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>');
      acc += dash;
    }
    var center = donut
      ? '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#e7e9ee" font-size="18" font-weight="600">' + esc(String(Math.round(total * 100) / 100)) + '</text>'
      : '';
    return '<svg class="chart-svg" viewBox="0 0 640 320" width="100%" role="img">' + parts.join('') + center + '</svg>';
  }
  function renderChartHtml(content){
    var buckets = chartBuckets(content);
    if (!buckets.length) return emptyStateHtml();
    var kind = pickChartType(content);
    var svg = kind === 'pie' ? renderPieSvg(buckets, false)
      : kind === 'donut' ? renderPieSvg(buckets, true)
      : kind === 'line' ? renderLineSvg(buckets)
      : renderBarSvg(buckets);
    return '<div class="chart-wrap chart-' + kind + '">' + svg + chartLegendHtml(buckets) + '</div>';
  }
  function renderDashboardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var buckets = chartBuckets(content);
    var tiles = '<div class="dash-tiles"><div class="dash-tile"><div class="dash-tile-n">' + rows.length + '</div><div class="dash-tile-k">Rows</div></div>';
    for (var i=0;i<buckets.length && i<8;i++){
      tiles += '<div class="dash-tile"><div class="dash-tile-n">' + esc(String(buckets[i].v)) + '</div><div class="dash-tile-k">' + esc(buckets[i].k) + '</div></div>';
    }
    tiles += '</div>';
    var chart = buckets.length ? renderChartHtml(content) : '';
    return '<div class="dash">' + tiles + chart + '</div>';
  }
  function pickUserSlug(content, cols){
    var cfg = viewCfg(content);
    if (typeof cfg.assigneeFieldSlug === 'string' && cfg.assigneeFieldSlug) return cfg.assigneeFieldSlug;
    var i, t;
    for (i=0;i<cols.length;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (t === 'user' || t === 'people' || t === 'created_by' || t === 'last_modified_by') return cols[i].slug;
    }
    return pickGroupSlug(content, cols);
  }
  function renderWorkloadHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var groupSlug = pickUserSlug(content, cols);
    var titleSlug = titleSlugOf(content, cols);
    var lanes = Object.create(null);
    var order = [];
    rows.forEach(function(r){
      var key = rowCellText(r, groupSlug).trim() || 'Unassigned';
      if (!lanes[key]) { lanes[key] = []; order.push(key); }
      lanes[key].push(r);
    });
    var maxN = 1;
    for (var mi=0;mi<order.length;mi++) if (lanes[order[mi]].length > maxN) maxN = lanes[order[mi]].length;
    return '<div class="board workload">' + order.map(function(k){
      var pct = Math.round((lanes[k].length / maxN) * 100);
      var cards = lanes[k].map(function(r){
        return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + '</div>';
      }).join('');
      return '<div class="lane"><div class="lane-head"><span>' + esc(k) + '</span><span class="lane-count">' + lanes[k].length + '</span></div>'
        + '<div class="wl-track"><div class="wl-bar" style="width:' + pct + '%"></div></div>' + cards + '</div>';
    }).join('') + '</div>';
  }
  function renderPivotHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var rowSlug = (typeof cfg.rowFieldSlug === 'string' && cfg.rowFieldSlug) ? cfg.rowFieldSlug : pickGroupSlug(content, cols);
    var colSlug = (typeof cfg.colFieldSlug === 'string' && cfg.colFieldSlug) ? cfg.colFieldSlug : '';
    if (!colSlug) {
      for (var i=0;i<cols.length;i++){
        if (cols[i].slug !== rowSlug && (String(cols[i].field_type || '') === 'select' || String(cols[i].field_type || '') === 'status')) {
          colSlug = cols[i].slug;
          break;
        }
      }
    }
    if (!rowSlug || !colSlug) return renderChartHtml(content);
    var grid = Object.create(null);
    var rowKeys = [];
    var colKeys = [];
    var colSeen = Object.create(null);
    rows.forEach(function(r){
      var rk = rowCellText(r, rowSlug).trim() || 'No value';
      var ck = rowCellText(r, colSlug).trim() || 'No value';
      if (!grid[rk]) { grid[rk] = Object.create(null); rowKeys.push(rk); }
      if (!grid[rk][ck]) grid[rk][ck] = 0;
      grid[rk][ck]++;
      if (!colSeen[ck]) { colSeen[ck] = 1; colKeys.push(ck); }
    });
    var head = '<th></th>' + colKeys.map(function(c){ return '<th>' + esc(c) + '</th>'; }).join('');
    var body = rowKeys.map(function(rk){
      var cells = colKeys.map(function(ck){
        var n = (grid[rk] && grid[rk][ck]) ? grid[rk][ck] : 0;
        return '<td>' + (n ? esc(String(n)) : '') + '</td>';
      }).join('');
      return '<tr><th>' + esc(rk) + '</th>' + cells + '</tr>';
    }).join('');
    return '<div class="card table-card"><div class="pivot-wrap"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div></div>';
  }
  function monthStartUtc(ymd){
    var p = String(ymd || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    if (!isFinite(y) || !isFinite(m)) return null;
    return { y: y, m: m };
  }
  function renderCalendarHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var dateSlug = pickDateSlug(content, cols);
    if (!dateSlug) return renderDateBoardHtml(content);
    var titleSlug = titleSlugOf(content, cols);
    var byDay = Object.create(null);
    var dates = [];
    rows.forEach(function(r){
      var k = rowDateKey(r, dateSlug);
      if (!k) return;
      if (!byDay[k]) { byDay[k] = []; dates.push(k); }
      byDay[k].push(r);
    });
    if (!dates.length) return renderDateBoardHtml(content);
    dates.sort();
    var start = monthStartUtc(dates[0]);
    if (!start) return renderDateBoardHtml(content);
    var first = new Date(Date.UTC(start.y, start.m - 1, 1));
    var last = new Date(Date.UTC(start.y, start.m, 0));
    var lead = first.getUTCDay();
    var daysIn = last.getUTCDate();
    var dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var html = '<div class="cal">';
    for (var d=0;d<7;d++) html += '<div class="cal-dow">' + dow[d] + '</div>';
    var i;
    for (i=0;i<lead;i++) html += '<div class="cal-day out"></div>';
    for (i=1;i<=daysIn;i++){
      var mm = start.m < 10 ? '0' + start.m : String(start.m);
      var dd = i < 10 ? '0' + i : String(i);
      var key = String(start.y) + '-' + mm + '-' + dd;
      var items = byDay[key] || [];
      var cards = '';
      for (var j=0;j<items.length && j<4;j++){
        cards += '<div class="cal-item">' + esc(rowCellText(items[j], titleSlug) || 'Untitled') + '</div>';
      }
      if (items.length > 4) cards += '<div class="cal-item">+' + (items.length - 4) + '</div>';
      html += '<div class="cal-day"><div class="cal-day-n">' + i + '</div>' + cards + '</div>';
    }
    html += '</div>';
    var undated = [];
    rows.forEach(function(r){
      if (!rowDateKey(r, dateSlug)) undated.push(r);
    });
    if (undated.length) {
      html += '<div class="date-board cal-undated"><div class="lane"><div class="lane-head"><span>No date</span><span class="lane-count">'
        + undated.length + '</span></div>'
        + undated.map(function(r){ return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + '</div>'; }).join('')
        + '</div></div>';
    }
    return html;
  }
  function renderTimelineHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var startSlug = (typeof cfg.startDateFieldSlug === 'string' && cfg.startDateFieldSlug) ? cfg.startDateFieldSlug : pickDateSlug(content, cols);
    var endSlug = (typeof cfg.endDateFieldSlug === 'string' && cfg.endDateFieldSlug) ? cfg.endDateFieldSlug : startSlug;
    var titleSlug = titleSlugOf(content, cols);
    if (!startSlug) return renderDateBoardHtml(content);
    var parsed = [];
    var min = Infinity, max = -Infinity;
    rows.forEach(function(r){
      var a = rowDateKey(r, startSlug);
      var b = rowDateKey(r, endSlug) || a;
      if (!a) return;
      var as = Date.parse(a + 'T00:00:00Z');
      var bs = Date.parse(b + 'T00:00:00Z');
      if (!isFinite(as)) return;
      if (!isFinite(bs) || bs < as) bs = as;
      if (as < min) min = as;
      if (bs > max) max = bs;
      parsed.push({ r: r, a: as, b: bs });
    });
    if (!parsed.length || !isFinite(min)) return renderDateBoardHtml(content);
    if (max <= min) max = min + 86400000;
    var span = max - min;
    var html = '<div class="tl">';
    parsed.slice(0, 80).forEach(function(p){
      var left = ((p.a - min) / span) * 100;
      var width = Math.max(((p.b - p.a) / span) * 100, 1.5);
      html += '<div class="tl-row"><div class="tl-lab">' + esc(rowCellText(p.r, titleSlug) || 'Untitled') + '</div>'
        + '<div class="tl-track"><div class="tl-bar" style="left:' + left + '%;width:' + width + '%"></div></div></div>';
    });
    html += '</div>';
    return html;
  }
  function renderSchedulerHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var resSlug = (typeof cfg.resourceFieldSlug === 'string' && cfg.resourceFieldSlug) ? cfg.resourceFieldSlug : pickUserSlug(content, cols);
    var startSlug = (typeof cfg.startDateFieldSlug === 'string' && cfg.startDateFieldSlug) ? cfg.startDateFieldSlug : pickDateSlug(content, cols);
    var endSlug = (typeof cfg.endDateFieldSlug === 'string' && cfg.endDateFieldSlug) ? cfg.endDateFieldSlug : startSlug;
    var titleSlug = titleSlugOf(content, cols);
    if (!startSlug) return renderWorkloadHtml(content);
    var parsed = [];
    var min = Infinity, max = -Infinity;
    rows.forEach(function(r){
      var a = rowDateKey(r, startSlug);
      var b = rowDateKey(r, endSlug) || a;
      if (!a) return;
      var as = Date.parse(a + 'T00:00:00Z');
      var bs = Date.parse(b + 'T00:00:00Z');
      if (!isFinite(as)) return;
      if (!isFinite(bs) || bs < as) bs = as;
      if (as < min) min = as;
      if (bs > max) max = bs;
      parsed.push({ r: r, a: as, b: bs, res: rowCellText(r, resSlug).trim() || 'Unassigned' });
    });
    if (!parsed.length || !isFinite(min)) return renderWorkloadHtml(content);
    if (max <= min) max = min + 86400000;
    var span = max - min;
    var lanes = Object.create(null);
    var order = [];
    parsed.forEach(function(p){
      if (!lanes[p.res]) { lanes[p.res] = []; order.push(p.res); }
      lanes[p.res].push(p);
    });
    var html = '<div class="sched">';
    order.forEach(function(k){
      var bars = '';
      lanes[k].forEach(function(p){
        var left = ((p.a - min) / span) * 100;
        var width = Math.max(((p.b - p.a) / span) * 100, 1.5);
        bars += '<div class="tl-bar" style="left:' + left + '%;width:' + width + '%" title="' + esc(rowCellText(p.r, titleSlug) || 'Untitled') + '"></div>';
      });
      html += '<div class="tl-row"><div class="tl-lab">' + esc(k) + ' (' + lanes[k].length + ')</div>'
        + '<div class="tl-track">' + bars + '</div></div>';
    });
    html += '</div>';
    return html;
  }
  function pickParentSlug(cols, titleSlug){
    var i, s, t;
    for (i=0;i<cols.length;i++){
      s = String(cols[i].slug || '').toLowerCase();
      if (s === 'parent_id' || s === 'parent' || s === 'parentid') return cols[i].slug;
    }
    for (i=0;i<cols.length;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if ((t === 'relation' || t === 'lookup') && cols[i].slug !== titleSlug) return cols[i].slug;
    }
    return '';
  }
  function rowIdOf(row){
    return row && typeof row.id === 'string' ? row.id : '';
  }
  function rowParentId(row, slug){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var v = d[slug];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.id === 'string') return v.id;
    if (typeof v === 'string' && v.trim()) return v.trim();
    return '';
  }
  function renderTreeHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var titleSlug = titleSlugOf(content, cols);
    var parentSlug = (typeof viewCfg(content).relationFieldSlug === 'string' && viewCfg(content).relationFieldSlug)
      ? viewCfg(content).relationFieldSlug
      : pickParentSlug(cols, titleSlug);
    if (!parentSlug) return renderListHtml(content, 'stack tree');
    var byId = Object.create(null);
    rows.forEach(function(r){ var id = rowIdOf(r); if (id) byId[id] = r; });
    var kids = Object.create(null);
    var roots = [];
    rows.forEach(function(r){
      var pid = rowParentId(r, parentSlug);
      if (pid && byId[pid] && pid !== rowIdOf(r)) {
        if (!kids[pid]) kids[pid] = [];
        kids[pid].push(r);
      } else {
        roots.push(r);
      }
    });
    function walk(node, depth){
      var id = rowIdOf(node);
      var pad = Math.min(depth, 8) * 18;
      var out = '<div class="tree-row" style="padding-left:' + pad + 'px">' + rowTitleHtml(node, titleSlug) + '</div>';
      var list = kids[id] || [];
      for (var i=0;i<list.length;i++) out += walk(list[i], depth + 1);
      return out;
    }
    return '<div class="tree card">' + roots.map(function(r){ return walk(r, 0); }).join('') + '</div>';
  }
  function pickSlugByType(cols, names, cfgKey, cfg){
    if (cfg && typeof cfg[cfgKey] === 'string' && cfg[cfgKey]) return cfg[cfgKey];
    for (var i=0;i<cols.length;i++){
      var t = String(cols[i].field_type || '').toLowerCase();
      var s = String(cols[i].slug || '').toLowerCase();
      for (var j=0;j<names.length;j++){
        if (s === names[j] || t === names[j]) return cols[i].slug;
      }
    }
    return '';
  }
  function renderMapHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var titleSlug = (typeof cfg.labelFieldSlug === 'string' && cfg.labelFieldSlug) ? cfg.labelFieldSlug : titleSlugOf(content, cols);
    var locSlug = pickSlugByType(cols, ['location','address','geo'], 'locationFieldSlug', cfg);
    var latSlug = (typeof cfg.latFieldSlug === 'string' && cfg.latFieldSlug) ? cfg.latFieldSlug : pickSlugByType(cols, ['lat','latitude'], 'latFieldSlug', cfg);
    var lngSlug = (typeof cfg.lngFieldSlug === 'string' && cfg.lngFieldSlug) ? cfg.lngFieldSlug : pickSlugByType(cols, ['lng','lon','longitude'], 'lngFieldSlug', cfg);
    var cards = rows.map(function(r){
      var loc = locSlug ? rowCellText(r, locSlug) : '';
      var lat = latSlug ? rowCellText(r, latSlug) : '';
      var lng = lngSlug ? rowCellText(r, lngSlug) : '';
      var geo = (lat && lng) ? (lat + ', ' + lng) : loc;
      return '<div class="row-card map-card">' + rowTitleHtml(r, titleSlug)
        + (geo ? '<div class="kv"><div class="kv-k">Location</div><div class="kv-v">' + esc(geo) + '</div></div>' : '')
        + '</div>';
    }).join('');
    return '<div class="stack map-list">' + cards
      + '<p class="hint">Places are listed here. This public page does not draw a map.</p></div>';
  }
  function renderDocHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var titleSlug = titleSlugOf(content, cols);
    var bodySlug = (typeof cfg.contentFieldSlug === 'string' && cfg.contentFieldSlug) ? cfg.contentFieldSlug : '';
    if (!bodySlug) {
      for (var i=0;i<cols.length;i++){
        var t = String(cols[i].field_type || '').toLowerCase();
        if (t === 'long_text' || t === 'rich_text' || t === 'notes') { bodySlug = cols[i].slug; break; }
      }
    }
    return '<div class="stack doc-list">' + rows.map(function(r){
      var body = bodySlug ? rowCellText(r, bodySlug) : '';
      return '<div class="row-card">' + rowTitleHtml(r, titleSlug)
        + (body ? '<div class="doc-body">' + esc(body).replace(/\\r?\\n/g, '<br/>') + '</div>' : '')
        + '</div>';
    }).join('') + '</div>';
  }
  function renderFeedHtml(content){
    return renderListHtml(content, 'stack feed');
  }
  function renderDateBucketHtml(content){
    return renderDateBoardHtml(content);
  }
  function renderReadBodyHtml(content){
    var vt = canonicalViewType(content && content.viewType);
    if (vt === 'list') return { html: renderListHtml(content, 'stack'), simplified: false };
    if (vt === 'feed') return { html: renderFeedHtml(content), simplified: false };
    if (vt === 'board') return { html: renderBoardHtml(content), simplified: false };
    if (vt === 'gallery') return { html: renderGalleryHtml(content), simplified: false };
    if (vt === 'table') return { html: renderTableHtml(content), simplified: false };
    if (vt === 'date_bucket') return { html: renderDateBucketHtml(content), simplified: false };
    if (vt === 'dashboard') return { html: renderDashboardHtml(content), simplified: false };
    if (vt === 'chart') return { html: renderChartHtml(content), simplified: false };
    if (vt === 'pivot') return { html: renderPivotHtml(content), simplified: false };
    if (vt === 'workload') return { html: renderWorkloadHtml(content), simplified: false };
    if (vt === 'calendar') return { html: renderCalendarHtml(content), simplified: false };
    if (vt === 'timeline') return { html: renderTimelineHtml(content), simplified: false };
    if (vt === 'scheduler') return { html: renderSchedulerHtml(content), simplified: false };
    if (vt === 'tree') return { html: renderTreeHtml(content), simplified: false };
    if (vt === 'map') return { html: renderMapHtml(content), simplified: false };
    if (vt === 'form') return { html: renderListHtml(content, 'stack'), simplified: false };
    if (vt === 'doc') return { html: renderDocHtml(content), simplified: false };
    if (vt === 'mindmap') return { html: renderTreeHtml(content), simplified: false };
    if (vt === 'whiteboard') {
      return { html: renderTableHtml(content), simplified: true };
    }
    return { html: renderTableHtml(content), simplified: true };
  }
  function runGuestEnhancers(content){
    if (typeof enhanceGuestDateBucket === 'function') enhanceGuestDateBucket(content);
    if (typeof enhanceGuestChart === 'function') enhanceGuestChart(content);
  }
  function pageHeadHtml(share, content){
    var title = (content && typeof content.label === 'string' && content.label) || (share && share.label) || 'Shared view';
    var crumbs = [];
    if (content && typeof content.moduleName === 'string' && content.moduleName) crumbs.push(content.moduleName);
    if (content && typeof content.entityName === 'string' && content.entityName) crumbs.push(content.entityName);
    var create = (share && share.mode === 'create') || (content && content.mode === 'create');
    var mode = create
      ? 'Anyone with the link can submit a new record.'
      : 'Anyone with the link can view (not edit).';
    return '<div class="page-head"><h1>' + esc(title) + '</h1>'
      + (crumbs.length ? '<span class="crumb">' + esc(crumbs.join(' / ')) + '</span>' : '')
      + '</div><p class="hint">' + esc(mode) + '</p>';
  }
  function csvCell(s){
    s = valueText(s, 0);
    if (/^[=+@-]/.test(s) && !/^-?\\d+(\\.\\d+)?$/.test(s)) s = "'" + s;
    if (/[",\\n\\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function csvFromContent(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var lines = [cols.map(function(c){ return csvCell(fieldLabel(c.name || c.slug)); }).join(',')];
    rows.forEach(function(r){
      lines.push(cols.map(function(c){ return csvCell(rowCellText(r, c.slug)); }).join(','));
    });
    return lines.join('\\r\\n');
  }
`

/** Live guest renderer: core helpers plus per-view overlays (later fn wins). */
export const GUEST_RENDER_JS = GUEST_RENDER_CORE_JS + GUEST_VIEW_OVERLAYS_JS

/**
 * Vanilla-JS client-side field renderer shared by every guest-facing form
 * shell (public module share create-mode AND external portal create-mode).
 * Renders a type-aware control per `field_type` (select/multiselect options
 * from `config.options`, checkbox, number, date, email, url, long text)
 * instead of a single generic text `<input>` for every field - matching the
 * desktop app's own FormView so a select/checkbox/multiselect field the
 * host configured actually behaves like one for the external guest, not a
 * free-text box that a guest could type anything into. Interpolated as a
 * literal source-code string into each guest page's own `<script>` IIFE
 * (each page has an independent JS runtime - there is no shared bundle to
 * import), so both shells inherit the exact same field logic and cannot
 * drift into two different renderers for the same field types. Depends on
 * the enclosing scope already defining `esc(s)`.
 */
export const GUEST_FORM_FIELD_JS = `
  function normOpts(opts){
    if (!Array.isArray(opts)) return [];
    var out = [];
    for (var i=0;i<opts.length && i<200;i++){
      var o = opts[i];
      if (typeof o === 'string') out.push(o);
      else if (o && typeof o === 'object' && typeof o.value === 'string') out.push(o.value);
    }
    return out;
  }
  function fieldInputHtml(f){
    var t = String(f.field_type || 'text');
    var slug = esc(f.slug);
    var def = '';
    var cfg = (f.config && typeof f.config === 'object') ? f.config : {};
    var reqAttr = f.required ? ' required' : '';
    if (t === 'checkbox') {
      var checked = (def === 'true' || def === '1') ? ' checked' : '';
      return '<div class="checkbox-row"><input type="checkbox" data-slug="' + slug + '" data-type="checkbox"' + checked + '/></div>';
    }
    if (t === 'select' || t === 'status') {
      var opts = normOpts(cfg.options);
      var optsHtml = '<option value=""></option>' + opts.map(function(o){
        return '<option value="' + esc(o) + '"' + (o === def ? ' selected' : '') + '>' + esc(o) + '</option>';
      }).join('');
      return '<select data-slug="' + slug + '"' + reqAttr + '>' + optsHtml + '</select>';
    }
    if (t === 'multiselect' || t === 'tags') {
      var opts2 = normOpts(cfg.options);
      var defArr = def ? def.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
      if (opts2.length) {
        return '<div class="multi" data-slug="' + slug + '" data-type="multiselect">' + opts2.map(function(o){
          return '<label class="chip"><input type="checkbox" value="' + esc(o) + '"' + (defArr.indexOf(o) >= 0 ? ' checked' : '') + '/> ' + esc(o) + '</label>';
        }).join('') + '</div>';
      }
      return '<input data-slug="' + slug + '" value="' + esc(def) + '" placeholder="Comma-separated"/>';
    }
    if (t === 'number' || t === 'currency' || t === 'percent' || t === 'rating' || t === 'progress' || t === 'vote') {
      return '<input type="number" data-slug="' + slug + '" value="' + esc(def) + '" step="any"' + reqAttr + '/>';
    }
    if (t === 'date') {
      return '<input type="date" data-slug="' + slug + '" value="' + esc(def) + '"' + reqAttr + '/>';
    }
    if (t === 'email') {
      return '<input type="email" data-slug="' + slug + '" value="' + esc(def) + '"' + reqAttr + '/>';
    }
    if (t === 'url') {
      return '<input type="url" data-slug="' + slug + '" value="' + esc(def) + '"' + reqAttr + '/>';
    }
    if (t === 'long_text' || t === 'rich_text') {
      return '<textarea data-slug="' + slug + '" rows="3"' + reqAttr + '>' + esc(def) + '</textarea>';
    }
    return '<input data-slug="' + slug + '" value="' + esc(def) + '"' + reqAttr + '/>';
  }
  function readGuestFormFields(){
    var dataBag = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-slug]'), function(node){
      var slug = node.getAttribute('data-slug');
      var type = node.getAttribute('data-type');
      if (type === 'checkbox') { dataBag[slug] = node.checked; return; }
      if (type === 'multiselect') {
        var vals = [];
        Array.prototype.forEach.call(node.querySelectorAll('input[type=checkbox]:checked'), function(c){ vals.push(c.value); });
        dataBag[slug] = vals.join(',');
        return;
      }
      dataBag[slug] = node.value;
    });
    return dataBag;
  }
`
