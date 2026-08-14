/**
 * Guest Dashboard read layout (public share / portal).
 *
 * Concatenate AFTER GUEST_RENDER_CORE_JS so this `renderDashboardHtml`
 * replaces the parent. Parent contract this leaf MUST keep: `.dash-tiles` /
 * `.dash-tile` chrome and no row `<table>`. Public pages cannot mount the
 * in-app DashboardView, so this paints a simplified card grid: authored
 * viewConfig.widgets when present (stamped by payload-build), else the same
 * auto set (count, numeric sums capped at 3, checkbox percents, then
 * breakdowns). Each widget is its own card (number / percent ring /
 * donut-pie-bar). Recent is a view-only list of the loaded rows.
 *
 * Leftover vs desktop (cannot close in this leaf):
 * - No Add card / drag reorder / column switch / icon picker / Lucide.
 * - config.columns is not stamped on the payload; grid is auto-fill cards
 *   (about 3 across on a wide page), not a locked 2/3/4 switch.
 * - Percent is a ring SVG, not the in-app ProgressRing component.
 * - Breakdown charts are compact SVG; no category click-to-filter.
 * - Recent has no record click and no created_at column (payload rows are
 *   already newest-first).
 * - Formula / rollup / lookup cells are not recomputed here.
 * - Settings compact-locale is en-US; currency symbol only when config
 *   is on the field spec.
 *
 * Template-literal rule: no backticks, no dollar-brace in the embedded JS;
 * double backslashes in regex/string literals. Pure string -> string, no DOM.
 *
 * Overridden: renderDashboardHtml
 * New helpers: dashCapStr, dashOwnStr, dashIsNumType, dashIsBreakdownType,
 * dashFieldByRef, dashParseNum, dashCheckboxOn, dashCompactNum, dashFullNum,
 * dashParseWidgets, dashAutoWidgets, dashCardOpen, dashNumberCard,
 * dashPercentRing, dashMiniPieSvg, dashMiniBarSvg, dashBreakdownCard,
 * dashBreakdownBuckets, dashRecentHtml
 */

export const GUEST_VIEW_DASHBOARD_JS = `
  var DASH_WIDGET_MAX = 20;
  var DASH_AUTO_SUM_MAX = 3;
  var DASH_TITLE_MAX = 120;
  var DASH_BUCKET_CAP = 12;
  var DASH_SYMBOL_MAX = 8;
  var DASH_RECENT_MAX = 8;
  var DASH_CARD_STYLE = 'min-width:0;display:flex;flex-direction:column;justify-content:flex-start;height:100%';
  var DASH_GRID_STYLE = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;align-items:stretch';

  function dashCapStr(s, max){
    s = String(s == null ? '' : s);
    if (s.length <= max) return s;
    return s.slice(0, max);
  }
  function dashOwnStr(o, key){
    if (!o || typeof o !== 'object' || Array.isArray(o)) return '';
    if (!Object.prototype.hasOwnProperty.call(o, key)) return '';
    var v = o[key];
    return typeof v === 'string' ? v.trim() : '';
  }
  function dashIsNumType(t){
    t = String(t || '').toLowerCase();
    return t === 'number' || t === 'currency' || t === 'percent' || t === 'rating' || t === 'progress' || t === 'vote';
  }
  function dashIsBreakdownType(t){
    t = String(t || '').toLowerCase();
    return t === 'select' || t === 'status' || t === 'multiselect' || t === 'tags' || t === 'user' || t === 'relation';
  }
  function dashFieldByRef(cols, ref){
    if (!ref) return null;
    var i;
    for (i=0;i<cols.length;i++){
      if (cols[i].slug === ref || cols[i].id === ref) return cols[i];
    }
    return null;
  }
  function dashParseNum(raw){
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    if (typeof raw === 'boolean' || typeof raw === 'object') return null;
    var s = String(raw).replace(/[%$, ]/g, '').trim();
    if (!s || s === '-' || s === '+') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function dashCheckboxOn(v){
    return v === true || v === 1 || v === 'true' || v === '1';
  }
  function dashCompactNum(n){
    if (!isFinite(n)) return '0';
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    function trim1(s){
      return s.length > 2 && s.charAt(s.length - 2) === '.' && s.charAt(s.length - 1) === '0' ? s.slice(0, s.length - 2) : s;
    }
    if (abs < 1000) {
      if (Math.round(n) === n) return String(n);
      return String(Math.round(n * 100) / 100);
    }
    if (abs < 1000000) return sign + trim1((abs / 1000).toFixed(1)) + 'k';
    if (abs < 1000000000) return sign + trim1((abs / 1000000).toFixed(1)) + 'M';
    return sign + trim1((abs / 1000000000).toFixed(1)) + 'B';
  }
  function dashFullNum(n){
    if (!isFinite(n)) return '0';
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function dashParseWidgets(raw){
    if (!Array.isArray(raw)) return [];
    var out = [];
    var i, w, type, field, title, chart, span;
    for (i=0;i<raw.length && out.length<DASH_WIDGET_MAX;i++){
      w = raw[i];
      if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
      type = dashOwnStr(w, 'type');
      if (type !== 'count' && type !== 'sum' && type !== 'avg' && type !== 'breakdown' && type !== 'percent') continue;
      field = dashOwnStr(w, 'field');
      title = dashOwnStr(w, 'title');
      if (title) title = dashCapStr(title, DASH_TITLE_MAX);
      chart = dashOwnStr(w, 'chart').toLowerCase();
      if (chart !== 'donut' && chart !== 'pie' && chart !== 'bar' && chart !== 'column') chart = 'donut';
      span = dashOwnStr(w, 'span').toLowerCase();
      if (span !== 'row') span = 'card';
      out.push({ type: type, field: field, title: title, chart: chart, span: span });
    }
    return out;
  }
  function dashAutoWidgets(cols){
    var out = [{ type: 'count', field: '', title: '', chart: 'donut', span: 'card' }];
    var numbers = 0;
    var i, t;
    for (i=0;i<cols.length && out.length<DASH_WIDGET_MAX;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (!dashIsNumType(t) || numbers >= DASH_AUTO_SUM_MAX) continue;
      out.push({ type: 'sum', field: cols[i].slug, title: '', chart: 'donut', span: 'card' });
      numbers += 1;
    }
    for (i=0;i<cols.length && out.length<DASH_WIDGET_MAX;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (t === 'checkbox') out.push({ type: 'percent', field: cols[i].slug, title: '', chart: 'donut', span: 'card' });
    }
    for (i=0;i<cols.length && out.length<DASH_WIDGET_MAX;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (dashIsBreakdownType(t)) out.push({ type: 'breakdown', field: cols[i].slug, title: '', chart: 'donut', span: 'card' });
    }
    return out;
  }
  function dashCardOpen(span, tip){
    var st = DASH_CARD_STYLE;
    if (span === 'row') st += ';grid-column:1 / -1';
    var title = tip ? ' title="' + esc(tip) + '"' : '';
    return '<div class="dash-tile"' + title + ' style="' + st + '">';
  }
  function dashNumberCard(n, k, sub, tip, span){
    var subHtml = sub ? '<div class="muted" style="margin-top:4px">' + esc(sub) + '</div>' : '';
    return dashCardOpen(span, tip)
      + '<div class="dash-tile-k">' + esc(k) + '</div>'
      + '<div class="dash-tile-n">' + esc(n) + '</div>'
      + subHtml + '</div>';
  }
  function dashPercentRing(pct, title, caption, span){
    var clamped = Math.max(0, Math.min(100, pct));
    var R = 30;
    var circ = 2 * Math.PI * R;
    var ring = (clamped / 100) * circ;
    var svg = '<svg class="chart-svg" viewBox="0 0 72 72" width="100%" style="max-width:160px;margin:0 auto;display:block" role="img">'
      + '<g transform="rotate(-90 36 36)">'
      + '<circle cx="36" cy="36" r="' + R + '" fill="none" stroke="#26282e" stroke-width="8"/>'
      + '<circle cx="36" cy="36" r="' + R + '" fill="none" stroke="#3b82f6" stroke-width="8" stroke-linecap="round" stroke-dasharray="'
      + ring + ' ' + circ + '"/>'
      + '</g>'
      + '<text x="36" y="40" text-anchor="middle" fill="#e7e9ee" font-size="14" font-weight="600">' + esc(String(clamped)) + '%</text>'
      + '</svg>';
    var cap = caption ? '<div class="muted" style="text-align:center;margin-top:6px">' + esc(caption) + '</div>' : '';
    return dashCardOpen(span, '') + '<div class="dash-tile-k">' + esc(title || 'Completion') + '</div>' + svg + cap + '</div>';
  }
  function dashMiniPieSvg(buckets, donut){
    var fills = chartFills();
    var total = 0;
    var i;
    for (i=0;i<buckets.length;i++) total += Math.max(0, buckets[i].v);
    if (total <= 0) return '';
    var cx = 100, cy = 100, r = 62;
    var circ = 2 * Math.PI * r;
    var acc = 0;
    var parts = [];
    var strokeW = donut ? 24 : 62;
    for (i=0;i<buckets.length;i++){
      var frac = Math.max(0, buckets[i].v) / total;
      var slice = Math.max(frac * circ, 0.01);
      var gap = Math.max(circ - slice, 0);
      parts.push('<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + fills[i % fills.length]
        + '" stroke-width="' + strokeW + '" stroke-dasharray="' + slice + ' ' + gap
        + '" stroke-dashoffset="' + (-acc) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>');
      acc += slice;
    }
    var center = donut
      ? '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#e7e9ee" font-size="16" font-weight="600">' + esc(String(Math.round(total * 100) / 100)) + '</text>'
      : '';
    return '<svg class="chart-svg" viewBox="0 0 200 200" width="100%" style="max-width:200px;margin:8px auto 0;display:block" role="img">' + parts.join('') + center + '</svg>';
  }
  function dashMiniBarSvg(buckets){
    var fills = chartFills();
    var max = 0;
    var i;
    for (i=0;i<buckets.length;i++) if (buckets[i].v > max) max = buckets[i].v;
    if (max <= 0) max = 1;
    var w = 280, h = 140, padL = 8, padB = 36, padT = 18, padR = 8;
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var n = Math.max(buckets.length, 1);
    var slot = innerW / n;
    var bw = Math.max(8, slot * 0.62);
    var parts = [];
    for (i=0;i<buckets.length;i++){
      var bh = (Math.max(buckets[i].v, 0) / max) * innerH;
      var x = padL + i * slot + (slot - bw) / 2;
      var y = padT + innerH - bh;
      var cx = x + bw / 2;
      var label = buckets[i].k.length > 10 ? buckets[i].k.slice(0, 9) + '...' : buckets[i].k;
      parts.push('<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + Math.max(bh, 1) + '" rx="4" fill="' + fills[i % fills.length] + '"/>');
      parts.push('<text x="' + cx + '" y="' + (y - 4) + '" text-anchor="middle" fill="#e7e9ee" font-size="9">' + esc(String(buckets[i].v)) + '</text>');
      parts.push('<text x="' + cx + '" y="' + (h - 10) + '" text-anchor="middle" fill="#9aa1ab" font-size="9">' + esc(label) + '</text>');
    }
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">' + parts.join('') + '</svg>';
  }
  function dashBreakdownBuckets(rows, field){
    var counts = Object.create(null);
    var labels = Object.create(null);
    var t = String(field.field_type || '').toLowerCase();
    var i, j, parts, lab, key;
    for (i=0;i<rows.length;i++){
      if (t === 'tags' || t === 'multiselect') {
        parts = chipItems(rows[i], field.slug);
        if (!parts.length) parts = [''];
      } else {
        lab = rowCellText(rows[i], field.slug).trim();
        parts = [lab];
      }
      for (j=0;j<parts.length;j++){
        lab = String(parts[j] == null ? '' : parts[j]).trim();
        key = lab ? lab : '__empty__';
        if (!counts[key]) { counts[key] = 0; labels[key] = lab ? lab : 'Unknown'; }
        counts[key] += 1;
      }
    }
    var list = [];
    for (key in counts) {
      if (!Object.prototype.hasOwnProperty.call(counts, key)) continue;
      list.push({ k: labels[key], v: counts[key], empty: key === '__empty__' });
    }
    list.sort(function(a, b){
      if (b.v !== a.v) return b.v - a.v;
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      return String(a.k).localeCompare(String(b.k));
    });
    var out = [];
    var other = 0;
    for (i=0;i<list.length;i++){
      if (out.length >= DASH_BUCKET_CAP) { other += list[i].v; continue; }
      out.push({ k: list[i].k, v: list[i].v });
    }
    if (other) out.push({ k: 'Other', v: other });
    return out;
  }
  function dashBreakdownCard(title, buckets, kind, span, otherRolled){
    if (!buckets || !buckets.length) {
      return dashCardOpen(span, '') + '<div class="dash-tile-k">' + esc(title) + '</div><div class="muted">No values to chart.</div></div>';
    }
    var k = kind === 'pie' ? 'pie' : (kind === 'bar' || kind === 'column') ? 'bar' : 'donut';
    var svg = k === 'bar' ? dashMiniBarSvg(buckets) : dashMiniPieSvg(buckets, k === 'donut');
    var legend = (k === 'pie' || k === 'donut') && typeof chartPieLegendHtml === 'function'
      ? chartPieLegendHtml(buckets)
      : chartLegendHtml(buckets);
    var note = otherRolled ? '<div class="muted" style="margin-top:4px">Some categories are grouped as Other.</div>' : '';
    return dashCardOpen(span, '') + '<div class="dash-tile-k">' + esc(title) + '</div>' + svg + legend + note + '</div>';
  }
  function dashRecentHtml(content, cols, rows, capped, totalN){
    var titleSlug = titleSlugOf(content, cols);
    var n = Math.min(rows.length, DASH_RECENT_MAX);
    var items = '';
    var i;
    for (i=0;i<n;i++){
      items += '<div class="row-card" style="margin-top:8px">' + rowTitleHtml(rows[i], titleSlug) + '</div>';
    }
    var countLine = capped && totalN > rows.length
      ? ('Showing ' + dashFullNum(n) + ' of the first ' + dashFullNum(rows.length) + ' loaded (of ' + dashFullNum(totalN) + ')')
      : (dashFullNum(rows.length) + (rows.length === 1 ? ' record' : ' records'));
    return '<div class="card" style="margin-top:12px"><div class="dash-tile-k">Recent</div>'
      + '<div class="muted" style="margin-top:2px">' + esc(countLine) + '</div>'
      + items + '</div>';
  }
  function renderDashboardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length) return emptyStateHtml();
    if (!rows.length) {
      var totalEmpty = content && typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
      if (totalEmpty > 0) return '<div class="card"><div class="empty">No records to show.</div></div>';
      return '<div class="card"><div class="empty">No records yet.</div></div>';
    }
    var cfg = viewCfg(content);
    var widgets = dashParseWidgets(cfg.widgets);
    if (!widgets.length) widgets = dashAutoWidgets(cols);
    var capped = !!(content && content.truncated === true);
    var totalN = content && typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
    if (capped && totalN > 0 && totalN <= rows.length) capped = false;
    var cards = '';
    var otherRolled = false;
    var wi, w, field, t, title, nHtml, kHtml, tip, d, raw, parsed, sum, counted, avg, checked, totalVals, pct, symbol, suffix, compact, full, buckets, ri, sub;
    for (wi=0;wi<widgets.length;wi++){
      w = widgets[wi];
      field = w.field ? dashFieldByRef(cols, w.field) : null;
      if (w.type === 'breakdown') {
        if (!field || !dashIsBreakdownType(field.field_type)) continue;
        buckets = dashBreakdownBuckets(rows, field);
        if (buckets.length && buckets[buckets.length - 1].k === 'Other') otherRolled = true;
        title = w.title || (field.name || field.slug || 'Breakdown');
        cards += dashBreakdownCard(title, buckets, w.chart, w.span, buckets.length && buckets[buckets.length - 1].k === 'Other');
        continue;
      }
      if (w.type === 'count') {
        title = w.title || 'Total Records';
        compact = (capped ? '~' : '') + dashCompactNum(rows.length);
        full = capped && totalN > rows.length
          ? 'About ' + dashFullNum(rows.length) + ' of ' + dashFullNum(totalN) + ' loaded'
          : dashFullNum(rows.length);
        sub = capped && totalN > rows.length
          ? ('First ' + dashFullNum(rows.length) + ' of ' + dashFullNum(totalN) + ' loaded')
          : '';
        cards += dashNumberCard(compact, title, sub, full, w.span);
        continue;
      }
      if (w.type === 'percent') {
        if (!field || String(field.field_type || '').toLowerCase() !== 'checkbox') continue;
        checked = 0;
        totalVals = 0;
        for (ri=0;ri<rows.length;ri++){
          d = rows[ri] && rows[ri].data && typeof rows[ri].data === 'object' && !Array.isArray(rows[ri].data) ? rows[ri].data : {};
          raw = d[field.slug];
          if (raw == null) continue;
          totalVals += 1;
          if (dashCheckboxOn(raw)) checked += 1;
        }
        pct = totalVals > 0 ? Math.round((checked / totalVals) * 100) : 0;
        title = w.title || (field.name || field.slug || 'Completion');
        kHtml = checked + ' of ' + totalVals + (capped ? ' (loaded)' : '');
        cards += dashPercentRing(pct, title, kHtml, w.span);
        continue;
      }
      if (w.type === 'sum' || w.type === 'avg') {
        if (!field || !dashIsNumType(field.field_type)) continue;
        t = String(field.field_type || '').toLowerCase();
        sum = 0;
        counted = 0;
        for (ri=0;ri<rows.length;ri++){
          d = rows[ri] && rows[ri].data && typeof rows[ri].data === 'object' && !Array.isArray(rows[ri].data) ? rows[ri].data : {};
          parsed = dashParseNum(d[field.slug]);
          if (parsed == null) continue;
          sum += parsed;
          counted += 1;
        }
        avg = counted > 0 ? Math.round((sum / counted) * 100) / 100 : 0;
        symbol = '';
        if (t === 'currency') {
          var fcfg = field.config && typeof field.config === 'object' && !Array.isArray(field.config) ? field.config : {};
          if (typeof fcfg.symbol === 'string' && fcfg.symbol.trim()) symbol = dashCapStr(fcfg.symbol.trim(), DASH_SYMBOL_MAX);
        }
        suffix = t === 'percent' ? '%' : '';
        nHtml = w.type === 'sum' ? sum : avg;
        compact = symbol + dashCompactNum(nHtml) + suffix;
        full = symbol + dashFullNum(nHtml) + suffix;
        title = w.title || ((w.type === 'sum' ? 'Total ' : 'Average ') + (field.name || field.slug || '')).trim();
        sub = '';
        if (w.type === 'sum' && counted > 0) sub = 'Avg ' + symbol + dashCompactNum(avg) + suffix + (capped ? ' from loaded records' : '');
        else if (capped) sub = 'From loaded records';
        cards += dashNumberCard(compact, title, sub, full + (capped ? ' from loaded records' : ''), w.span);
      }
    }
    if (!cards) {
      cards = dashNumberCard((capped ? '~' : '') + dashCompactNum(rows.length), 'Total Records', '', dashFullNum(rows.length), 'card');
    }
    var notes = [];
    if (capped) {
      notes.push(totalN > rows.length
        ? ('Showing the first ' + dashFullNum(rows.length) + ' of ' + dashFullNum(totalN) + ' records. Totals may be incomplete')
        : 'This page may not include every record. Totals may be incomplete');
    }
    if (otherRolled) notes.push('Some categories are grouped as Other');
    var noteHtml = notes.length ? '<p class="muted">' + esc(notes.join('. ')) + '.</p>' : '';
    return '<div class="dash"><div class="dash-tiles" style="' + DASH_GRID_STYLE + '">' + cards + '</div>'
      + dashRecentHtml(content, cols, rows, capped, totalN) + noteHtml + '</div>';
  }
`
