/**
 * Guest timeline (Gantt) override. Concatenate AFTER GUEST_RENDER_JS so this
 * `renderTimelineHtml` replaces the parent. Depends on esc, visibleFields,
 * viewCfg, titleSlugOf, pickDateSlug, pickStatusSlug, rowDateKey, rowCellText,
 * emptyStateHtml, renderDateBoardHtml, ymdFromValue.
 *
 * Read-only bars matching timeline-view.tsx without drag, resize, zoom, pan,
 * or create. Chrome is the parent `.tl` / `.tl-row` / `.tl-lab` / `.tl-track`
 * / `.tl-bar` (theme already `width:100%` and at 640px stacks `.tl-row` to
 * a column). Dates live under the row label so every row stays two children
 * and the 640px stack is not a 110px-tall third column. Bar width uses the
 * same min(max(48px, pct%), room%) floor as the in-app bars.
 *
 * No backticks and no ${ } inside the embedded JS (this file is itself a
 * template literal).
 */

export const GUEST_VIEW_TIMELINE_JS = `
  var GUEST_TL_MS_DAY = 86400000;
  var GUEST_TL_MIN_SPAN_DAYS = 7;
  var GUEST_TL_ROW_CAP = 500;
  var GUEST_TL_TICK_CAP = 24;
  var GUEST_TL_MIN_BAR_PX = 48;
  var GUEST_TL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var GUEST_TL_PALETTE = ['#4f83cc','#34a853','#f29900','#9334e6','#ea4335','#17a2b8'];

  function guestTlCfgStr(cfg, keys){
    var i, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  }

  function guestTlIsDateType(t){
    t = String(t || '').toLowerCase();
    return t === 'date' || t === 'datetime' || t === 'date_range' || t === 'created_at' || t === 'updated_at';
  }

  function guestTlFieldType(cols, slug){
    var i;
    if (!slug) return '';
    for (i=0;i<cols.length;i++){
      if (cols[i] && cols[i].slug === slug) return String(cols[i].field_type || '').toLowerCase();
    }
    return '';
  }

  function guestTlPickEndSlug(cfg, cols, startSlug){
    var fromCfg = guestTlCfgStr(cfg, ['endDateFieldSlug','end_date_field']);
    if (fromCfg) return fromCfg;
    var dates = [];
    var i, slug, low;
    for (i=0;i<cols.length;i++){
      if (!guestTlIsDateType(cols[i].field_type)) continue;
      dates.push(cols[i]);
    }
    for (i=0;i<dates.length;i++){
      slug = dates[i].slug;
      if (slug === startSlug) continue;
      low = String(slug || '').toLowerCase();
      if (low.indexOf('end') >= 0 || low.indexOf('due') >= 0 || low.indexOf('finish') >= 0) return slug;
    }
    for (i=0;i<dates.length;i++){
      if (dates[i].slug !== startSlug) return dates[i].slug;
    }
    return startSlug;
  }

  function guestTlPct(n){
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 1000) / 1000);
  }

  function guestTlBarWidthCss(widthPct, leftPct){
    var left = isFinite(leftPct) ? Math.max(0, Math.min(leftPct, 99.5)) : 0;
    var room = Math.max(0.5, 100 - left);
    var pct = isFinite(widthPct) && widthPct > 0 ? widthPct : 0;
    return 'min(max(' + GUEST_TL_MIN_BAR_PX + 'px, ' + guestTlPct(pct) + '%), ' + guestTlPct(room) + '%)';
  }

  function guestTlFmt(ms){
    var d = new Date(ms);
    return GUEST_TL_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  function guestTlRangePiece(v, role){
    if (v == null || v === '') return '';
    if (typeof v === 'number' && isFinite(v)) return ymdFromValue(v, 0);
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return '';
      if ((s.charAt(0) === '{' || s.charAt(0) === '[') && s.length <= 4000) {
        try { v = JSON.parse(s); } catch (err) { return ymdFromValue(s, 0); }
      } else {
        var cut = s.indexOf(' to ');
        var left = '';
        var right = '';
        if (cut > 0) {
          left = ymdFromValue(s.slice(0, cut), 0);
          right = ymdFromValue(s.slice(cut + 4), 0);
        } else {
          cut = s.indexOf('..');
          if (cut > 0) {
            left = ymdFromValue(s.slice(0, cut), 0);
            right = ymdFromValue(s.slice(cut + 2), 0);
          }
        }
        if (left || right) return role === 'end' ? (right || left) : (left || right);
        return ymdFromValue(s, 0);
      }
    }
    if (Array.isArray(v)) {
      var a = ymdFromValue(v[0], 0);
      var b = ymdFromValue(v.length > 1 ? v[1] : '', 0);
      return role === 'end' ? (b || a) : (a || b);
    }
    if (typeof v === 'object') {
      var hasStart = Object.prototype.hasOwnProperty.call(v, 'start') || Object.prototype.hasOwnProperty.call(v, 'from');
      var hasEnd = Object.prototype.hasOwnProperty.call(v, 'end') || Object.prototype.hasOwnProperty.call(v, 'to');
      if (!hasStart && !hasEnd) return '';
      var rs = ymdFromValue(v.start != null ? v.start : v.from, 0);
      var re = ymdFromValue(v.end != null ? v.end : v.to, 0);
      return role === 'end' ? (re || rs) : (rs || re);
    }
    return '';
  }

  function guestTlYmdRole(row, slug, role, fieldType){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (fieldType === 'date_range') {
      var fromRange = guestTlRangePiece(d[slug], role);
      if (fromRange) return fromRange;
    }
    return rowDateKey(row, slug);
  }

  function guestTlTickLabel(ms, unit){
    var d = new Date(ms);
    if (unit === 'year') return String(d.getUTCFullYear());
    if (unit === 'quarter') {
      return 'Q' + String(Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + d.getUTCFullYear();
    }
    if (unit === 'month') {
      var lab = GUEST_TL_MONTHS[d.getUTCMonth()];
      return d.getUTCMonth() === 0 ? lab + ' ' + d.getUTCFullYear() : lab;
    }
    return GUEST_TL_MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate();
  }

  function guestTlTicks(minMs, maxMs){
    var span = maxMs - minMs;
    var ticks = [];
    if (!(span > 0)) return { ticks: ticks, truncated: false };
    var spanDays = span / GUEST_TL_MS_DAY;
    var unit = 'day';
    if (spanDays > 16) unit = 'week';
    if (spanDays > 70) unit = 'month';
    if (spanDays > 180) unit = 'quarter';
    if (spanDays > 420) unit = 'year';
    var cursor = new Date(minMs);
    cursor.setUTCHours(0, 0, 0, 0);
    if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() - cursor.getUTCDay());
    else if (unit === 'month') cursor.setUTCDate(1);
    else if (unit === 'quarter') cursor.setUTCMonth(Math.floor(cursor.getUTCMonth() / 3) * 3, 1);
    else if (unit === 'year') cursor.setUTCMonth(0, 1);
    var truncated = false;
    var guard = 0;
    while (cursor.getTime() <= maxMs && guard < 64) {
      var t = cursor.getTime();
      if (t >= minMs) {
        if (ticks.length >= GUEST_TL_TICK_CAP) { truncated = true; break; }
        ticks.push({ pct: ((t - minMs) / span) * 100, label: guestTlTickLabel(t, unit) });
      }
      if (unit === 'day') cursor.setUTCDate(cursor.getUTCDate() + 1);
      else if (unit === 'week') cursor.setUTCDate(cursor.getUTCDate() + 7);
      else if (unit === 'month') cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      else if (unit === 'quarter') cursor.setUTCMonth(cursor.getUTCMonth() + 3);
      else cursor.setUTCFullYear(cursor.getUTCFullYear() + 1);
      guard++;
    }
    return { ticks: ticks, truncated: truncated };
  }

  function guestTlWeekends(minMs, maxMs){
    var span = maxMs - minMs;
    var bands = [];
    if (!(span > 0)) return bands;
    var spanDays = span / GUEST_TL_MS_DAY;
    if (spanDays > 92) return bands;
    var cursor = new Date(minMs);
    cursor.setUTCHours(0, 0, 0, 0);
    var i, cap = Math.ceil(spanDays) + 2;
    function pushBand(startMs, days){
      var rawLeft = ((startMs - minMs) / span) * 100;
      var rawWidth = ((days * GUEST_TL_MS_DAY) / span) * 100;
      var left = Math.max(0, rawLeft);
      var width = Math.min(rawWidth - (left - rawLeft), 100 - left);
      if (width > 0 && left < 100) bands.push({ left: left, width: width });
    }
    for (i=0;i<=cap;i++){
      var dow = cursor.getUTCDay();
      if (dow === 6) pushBand(cursor.getTime(), 2);
      else if (dow === 0 && i === 0) pushBand(cursor.getTime(), 1);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return bands;
  }

  function guestTlLabelColor(hex){
    if (typeof hex !== 'string' || hex.length < 7) return '#fff';
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    if (!isFinite(r) || !isFinite(g) || !isFinite(b)) return '#fff';
    var L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return L > 0.55 ? '#111827' : '#fff';
  }

  function guestTlDecor(ticks, bands, todayPct, showToday){
    var html = '';
    var i;
    for (i=0;i<bands.length;i++){
      html += '<div style="position:absolute;top:0;bottom:0;left:' + guestTlPct(bands[i].left)
        + '%;width:' + guestTlPct(bands[i].width) + '%;background:rgba(255,255,255,0.04);pointer-events:none"></div>';
    }
    for (i=0;i<ticks.length;i++){
      html += '<div style="position:absolute;top:0;bottom:0;left:' + guestTlPct(ticks[i].pct)
        + '%;width:1px;background:#26282e;pointer-events:none"></div>';
    }
    if (showToday) {
      html += '<div style="position:absolute;top:0;bottom:0;left:' + guestTlPct(todayPct)
        + '%;width:1px;background:#3b82f6;opacity:.65;pointer-events:none"></div>';
    }
    return html;
  }

  function guestTlLabHtml(title, dates){
    return '<div class="tl-lab" style="white-space:normal">'
      + '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(title) + '</div>'
      + (dates
        ? '<div style="font-size:.75rem;color:#9aa1ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(dates) + '</div>'
        : '')
      + '</div>';
  }

  function guestTlLaneHeader(label, count){
    var extra = isFinite(count) ? ' (' + String(count) + ')' : '';
    return '<div class="tl-row"><div class="tl-lab" style="white-space:normal">'
      + '<div style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#9aa1ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
      + esc(label + extra) + '</div></div>'
      + '<div class="tl-track" style="height:1px;background:transparent;border:none;border-top:1px solid #26282e"></div></div>';
  }

  function guestTlBarRow(p, min, span, tickInfo, bands, todayPct, showToday, idx, colorMap){
    var left = ((p.a - min) / span) * 100;
    var width = ((p.b - p.a) / span) * 100;
    if (left + width <= 0 || left >= 100) return '';
    var bg = (p.colorKey && colorMap[p.colorKey]) ? colorMap[p.colorKey] : (GUEST_TL_PALETTE[idx % GUEST_TL_PALETTE.length]);
    var fg = guestTlLabelColor(bg);
    var range = guestTlFmt(p.a) + ' - ' + guestTlFmt(p.b);
    var tip = p.label + ': ' + range;
    var leftCss = guestTlPct(Math.max(0, left));
    return '<div class="tl-row">' + guestTlLabHtml(p.label, range)
      + '<div class="tl-track">' + guestTlDecor(tickInfo.ticks, bands, todayPct, showToday)
      + '<div class="tl-bar" title="' + esc(tip) + '" style="left:' + leftCss + '%;width:' + guestTlBarWidthCss(width, left)
      + ';background:' + bg + ';overflow:hidden;display:flex;align-items:center;padding:0 6px;box-sizing:border-box;color:' + fg
      + ';font-size:11px;font-weight:500;white-space:nowrap;text-overflow:ellipsis">' + esc(p.label) + '</div></div></div>';
  }

  function renderTimelineHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var startSlug = guestTlCfgStr(cfg, ['startDateFieldSlug','start_date_field']) || pickDateSlug(content, cols);
    var endSlug = guestTlPickEndSlug(cfg, cols, startSlug);
    var titleSlug = guestTlCfgStr(cfg, ['labelFieldSlug','label_field','titleFieldSlug','title_field']) || titleSlugOf(content, cols);
    var colorSlug = guestTlCfgStr(cfg, ['colorFieldSlug','color_field']) || pickStatusSlug(cols);
    var laneSlug = guestTlCfgStr(cfg, ['swimlaneFieldSlug','swimlane_field']);
    var laneType = guestTlFieldType(cols, laneSlug);
    if (laneType !== 'select' && laneType !== 'status') laneSlug = '';
    if (!startSlug) return renderDateBoardHtml(content);
    var startType = guestTlFieldType(cols, startSlug);
    var endType = guestTlFieldType(cols, endSlug);
    var parsed = [];
    var min = Infinity, max = -Infinity;
    var skipped = 0;
    rows.forEach(function(r){
      var a = guestTlYmdRole(r, startSlug, 'start', startType);
      if (!a) { skipped++; return; }
      var b = guestTlYmdRole(r, endSlug, 'end', endType) || a;
      var as = Date.parse(a + 'T00:00:00Z');
      var bs = Date.parse(b + 'T00:00:00Z');
      if (!isFinite(as)) { skipped++; return; }
      if (!isFinite(bs) || bs <= as) bs = as + GUEST_TL_MS_DAY;
      if (as < min) min = as;
      if (bs > max) max = bs;
      var laneLabel = '';
      if (laneSlug) {
        laneLabel = rowCellText(r, laneSlug).trim() || 'Uncategorized';
      }
      parsed.push({
        r: r,
        a: as,
        b: bs,
        label: rowCellText(r, titleSlug) || 'Untitled',
        colorKey: colorSlug ? (rowCellText(r, colorSlug).trim() || '') : '',
        lane: laneLabel
      });
    });
    if (!parsed.length || !isFinite(min)) return renderDateBoardHtml(content);
    var overflow = parsed.length > GUEST_TL_ROW_CAP;
    if (overflow) parsed = parsed.slice(0, GUEST_TL_ROW_CAP);
    var span0 = max - min;
    var padDays = span0 < GUEST_TL_MIN_SPAN_DAYS * GUEST_TL_MS_DAY ? 3 : 1;
    min -= padDays * GUEST_TL_MS_DAY;
    max += padDays * GUEST_TL_MS_DAY;
    var span = max - min;
    if (!(span > 0)) span = GUEST_TL_MS_DAY;
    var tickInfo = guestTlTicks(min, max);
    var bands = guestTlWeekends(min, max);
    var todayPct = ((Date.now() - min) / span) * 100;
    var showToday = todayPct >= 0 && todayPct <= 100;
    var colorMap = Object.create(null);
    var colorOrder = [];
    var colorIdx = 0;
    parsed.forEach(function(p){
      if (p.colorKey && !Object.prototype.hasOwnProperty.call(colorMap, p.colorKey)) {
        colorMap[p.colorKey] = GUEST_TL_PALETTE[colorIdx % GUEST_TL_PALETTE.length];
        colorOrder.push(p.colorKey);
        colorIdx++;
      }
    });
    var html = '<style type="text/css">.tl{width:100%;max-width:none}@media (max-width:640px){.tl .tl-row{flex-direction:column;align-items:stretch}.tl .tl-lab{flex:none;width:auto;max-width:none}.tl .tl-track{flex:none;width:100%;min-width:0}}</style>'
      + '<div class="tl" style="width:100%;max-width:none">';
    var axisTicks = '';
    var ti;
    for (ti=0;ti<tickInfo.ticks.length;ti++){
      axisTicks += '<span style="position:absolute;top:0;left:' + guestTlPct(tickInfo.ticks[ti].pct)
        + '%;transform:translateX(-50%);font-size:11px;color:#9aa1ab;white-space:nowrap;pointer-events:none">'
        + esc(tickInfo.ticks[ti].label) + '</span>';
    }
    if (showToday) {
      axisTicks += '<span style="position:absolute;bottom:0;left:' + guestTlPct(todayPct)
        + '%;transform:translateX(-50%);font-size:9px;font-weight:600;color:#3b82f6;white-space:nowrap;pointer-events:none">Today</span>';
    }
    html += '<div class="tl-row">' + guestTlLabHtml('', '')
      + '<div class="tl-track" style="height:22px;background:transparent;border:none;overflow:visible">' + axisTicks + '</div></div>';
    var laneOrder = [];
    var byLane = Object.create(null);
    if (laneSlug) {
      parsed.forEach(function(p){
        var k = p.lane || 'Uncategorized';
        if (!Object.prototype.hasOwnProperty.call(byLane, k)) {
          byLane[k] = [];
          laneOrder.push(k);
        }
        byLane[k].push(p);
      });
      laneOrder.forEach(function(k){
        var list = byLane[k];
        html += guestTlLaneHeader(k, list.length);
        list.forEach(function(p, idx){
          html += guestTlBarRow(p, min, span, tickInfo, bands, todayPct, showToday, idx, colorMap);
        });
      });
    } else {
      parsed.forEach(function(p, idx){
        html += guestTlBarRow(p, min, span, tickInfo, bands, todayPct, showToday, idx, colorMap);
      });
    }
    html += '</div>';
    if (colorOrder.length) {
      var legend = '';
      for (ti=0;ti<colorOrder.length;ti++){
        legend += '<span class="swatch" style="background:' + colorMap[colorOrder[ti]] + '"></span>'
          + '<span class="muted" style="margin-right:10px">' + esc(colorOrder[ti]) + '</span>';
      }
      html += '<div class="swatches" style="align-items:center">' + legend + '</div>';
    }
    if (skipped === 1) html += '<p class="muted">1 record has no start date and is not shown</p>';
    else if (skipped > 1) html += '<p class="muted">' + skipped + ' records have no start date and are not shown</p>';
    if (overflow) html += '<p class="muted">Showing the first ' + GUEST_TL_ROW_CAP + ' dated records.</p>';
    else if (content && content.truncated) html += '<p class="muted">This page shows a limited set of records.</p>';
    if (tickInfo.truncated) html += '<p class="muted">The date range is too wide to label every point, so the scale stops part way.</p>';
    if (laneSlug) html += '<p class="muted">Grouped into swimlanes by the bound category field.</p>';
    return html;
  }
`
