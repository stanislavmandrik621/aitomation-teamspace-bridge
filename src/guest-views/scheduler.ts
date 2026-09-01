/**
 * Guest Scheduler overlay. Concatenated AFTER GUEST_RENDER_JS so this
 * renderSchedulerHtml declaration wins. Parent already paints .sched
 * resource lanes with .tl-bar (workload fallback when no start field).
 *
 * Aligns the public share with scheduler-view.tsx READ-ONLY resource
 * lanes: 7-day day-column grid, weekend + today chrome, multi-resource
 * fan-out, date_range start/end roles, refuse end-before-start, stacked
 * packing, painted-only double-booked, bar labels, lane/booking caps.
 * Weeks that contain bookings are stacked (static page, no week strip
 * buttons). No drag, no create.
 *
 * Embedded JS: no backticks, no dollar-brace interpolations.
 */

export const GUEST_VIEW_SCHEDULER_JS = `
  var SCHED_BOOKINGS_MAX = 2000;
  var SCHED_LANES_MAX = 200;
  var SCHED_LANE_ROWS_MAX = 12;
  var SCHED_KEYS_PER_CELL_MAX = 64;
  var SCHED_KEY_MAX = 128;
  var SCHED_WEEKS_MAX = 16;
  var SCHED_UNASSIGNED = '__unassigned__';
  var SCHED_ROW_H = 26;
  var SCHED_ROW_GAP = 4;
  var SCHED_LANE_PAD = 6;
  var SCHED_LANE_MIN_H = 44;
  var SCHED_VISIBLE_DAYS = 7;
  var SCHED_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var SCHED_MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var SCHED_GRID_HEAD = '140px repeat(7,minmax(0,1fr))';
  var SCHED_GRID_LANE = '140px minmax(0,1fr)';
  var SCHED_GRID_DAYS = 'repeat(7,minmax(0,1fr))';
  function schedCfgStr(cfg, camel, snake){
    if (cfg && typeof cfg[camel] === 'string' && cfg[camel].trim()) return cfg[camel].trim();
    if (cfg && typeof cfg[snake] === 'string' && cfg[snake].trim()) return cfg[snake].trim();
    return '';
  }
  function schedAllFields(content, cols){
    var fields = Array.isArray(content && content.fields) ? content.fields : [];
    var out = [];
    var i;
    for (i=0;i<fields.length;i++){
      if (fields[i] && typeof fields[i].slug === 'string' && fields[i].slug) out.push(fields[i]);
    }
    return out.length ? out : cols;
  }
  function schedCol(fields, slug){
    if (!slug) return null;
    var i, f, id;
    for (i=0;i<fields.length;i++){
      f = fields[i];
      if (f.slug === slug) return f;
      id = f.id;
      if (typeof id === 'string' && id === slug) return f;
    }
    return null;
  }
  function schedFieldType(fields, slug){
    var f = schedCol(fields, slug);
    return f ? String(f.field_type || '').trim().toLowerCase() : '';
  }
  function schedIsDateType(t){
    t = String(t || '').trim().toLowerCase();
    return t === 'date' || t === 'datetime' || t === 'date_range';
  }
  function schedIsResType(t){
    t = String(t || '').trim().toLowerCase();
    return t === 'user' || t === 'relation' || t === 'select' || t === 'status' || t === 'text';
  }
  function schedResolveSlug(fields, slug, kind){
    if (!slug) return '';
    var t = schedFieldType(fields, slug);
    if (!t) return slug;
    if (kind === 'date') return schedIsDateType(t) ? slug : '';
    if (kind === 'res') return schedIsResType(t) ? slug : '';
    return slug;
  }
  function schedCap(s, max){
    s = typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean' ? String(s) : valueText(s, 0);
    var n = 0, i = 0, out = '';
    while (i < s.length && n < max) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
        out += s.charAt(i) + s.charAt(i + 1);
        i += 2;
      } else {
        out += s.charAt(i);
        i += 1;
      }
      n++;
    }
    return out;
  }
  function schedPad2(n){
    return n < 10 ? '0' + n : String(n);
  }
  function schedParseYmd(ymd){
    var p = String(ymd || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    var d = parseInt(p[2], 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: y, m: m, d: d };
  }
  function schedYmdFromParts(y, m, d){
    return String(y) + '-' + schedPad2(m) + '-' + schedPad2(d);
  }
  function schedLocalDate(ymd){
    var p = schedParseYmd(ymd);
    if (!p) return null;
    var dt = new Date(p.y, p.m - 1, p.d);
    if (dt.getFullYear() !== p.y || dt.getMonth() !== p.m - 1 || dt.getDate() !== p.d) return null;
    return dt;
  }
  function schedAddDays(ymd, n){
    var dt = schedLocalDate(ymd);
    if (!dt) return '';
    dt.setDate(dt.getDate() + n);
    return schedYmdFromParts(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function schedWeekStartSun(ymd){
    var dt = schedLocalDate(ymd);
    if (!dt) return '';
    dt.setDate(dt.getDate() - dt.getDay());
    return schedYmdFromParts(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }
  function schedWeekDays(weekStart){
    var out = [];
    var cur = weekStart;
    var i, next;
    for (i=0;i<SCHED_VISIBLE_DAYS;i++){
      if (!cur) break;
      out.push(cur);
      next = schedAddDays(cur, 1);
      if (!next) break;
      cur = next;
    }
    return out;
  }
  function schedIsWeekend(ymd){
    var dt = schedLocalDate(ymd);
    if (!dt) return false;
    var dow = dt.getDay();
    return dow === 0 || dow === 6;
  }
  function schedDayParts(ymd){
    var dt = schedLocalDate(ymd);
    if (!dt) return { weekday: ymd, day: '' };
    return {
      weekday: SCHED_DOW[dt.getDay()] || ymd,
      day: (SCHED_MON[dt.getMonth()] || '') + ' ' + dt.getDate()
    };
  }
  function schedFmtRange(a, b){
    var pa = schedDayParts(a);
    var pb = schedDayParts(b);
    var left = pa.weekday + ', ' + pa.day;
    var right = pb.weekday + ', ' + pb.day;
    return left + ' - ' + right;
  }
  function schedPct(n){
    if (!isFinite(n)) return '0';
    return String(Math.round(n * 1000) / 1000);
  }
  function schedIntersectsWeek(startDay, endDay, weekStart, weekEnd){
    if (!startDay || !endDay || !weekStart || !weekEnd) return false;
    return endDay >= weekStart && startDay <= weekEnd;
  }
  function schedRangePiece(v, role){
    if (v == null || v === '') return '';
    if (typeof v === 'number' && isFinite(v)) return ymdFromValue(v, 0);
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return '';
      if ((s.charAt(0) === '{' || s.charAt(0) === '[') && s.length <= 4000) {
        try { v = JSON.parse(s); } catch (err) { return ymdFromValue(s, 0); }
      } else {
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
  function schedYmdRole(row, slug, role){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var fromRange = schedRangePiece(d[slug], role);
    if (fromRange) return fromRange;
    return rowDateKey(row, slug);
  }
  function schedResScalar(item){
    if (item == null || item === '') return '';
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      var s = String(item).trim();
      return s ? schedCap(s, SCHED_KEY_MAX) : '';
    }
    if (typeof item === 'object' && !Array.isArray(item)) {
      if (typeof item.id === 'string' && item.id.trim()) return schedCap(item.id.trim(), SCHED_KEY_MAX);
      if (typeof item.value === 'string' && item.value.trim()) return schedCap(item.value.trim(), SCHED_KEY_MAX);
      var t = valueText(item, 0).trim();
      return t ? schedCap(t, SCHED_KEY_MAX) : '';
    }
    return '';
  }
  function schedResLabel(item, key){
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      if (typeof item.label === 'string' && item.label.trim()) return item.label.trim();
      if (typeof item.name === 'string' && item.name.trim()) return item.name.trim();
    }
    var t = valueText(item, 0).trim();
    return t || key;
  }
  function schedResKeys(raw){
    var out = [];
    var seen = Object.create(null);
    function add(k){
      if (!k || seen[k]) return;
      if (out.length >= SCHED_KEYS_PER_CELL_MAX) return;
      seen[k] = 1;
      out.push(k);
    }
    if (raw == null || raw === '') return out;
    if (Array.isArray(raw)) {
      for (var i=0;i<raw.length && out.length<SCHED_KEYS_PER_CELL_MAX;i++){
        var inner = schedResKeys(raw[i]);
        for (var j=0;j<inner.length;j++) add(inner[j]);
      }
      return out;
    }
    add(schedResScalar(raw));
    return out;
  }
  function schedPack(bookings){
    var sorted = bookings.slice().sort(function(a, b){
      if (a.startDay !== b.startDay) return a.startDay < b.startDay ? -1 : 1;
      if (a.endDay !== b.endDay) return a.endDay < b.endDay ? -1 : 1;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    var rowEnds = [];
    var placed = [];
    var overflow = [];
    for (var i=0;i<sorted.length;i++){
      var booking = sorted[i];
      var row = -1;
      for (var r=0;r<rowEnds.length;r++){
        if (rowEnds[r] < booking.startDay) { row = r; break; }
      }
      if (row === -1) {
        if (rowEnds.length >= SCHED_LANE_ROWS_MAX) { overflow.push(booking); continue; }
        row = rowEnds.length;
        rowEnds.push(booking.endDay);
      } else if (booking.endDay > rowEnds[row]) {
        rowEnds[row] = booking.endDay;
      }
      placed.push({ booking: booking, row: row });
    }
    return { placed: placed, rowCount: Math.max(1, rowEnds.length), overflow: overflow };
  }
  function schedConflicts(bookings){
    var ids = Object.create(null);
    var byRes = Object.create(null);
    var i, j, k, list, a, b;
    for (i=0;i<bookings.length;i++){
      k = bookings[i].resourceKey;
      if (!byRes[k]) byRes[k] = [];
      byRes[k].push(bookings[i]);
    }
    for (k in byRes) {
      if (!Object.prototype.hasOwnProperty.call(byRes, k)) continue;
      list = byRes[k];
      for (i=0;i<list.length;i++){
        for (j=i+1;j<list.length;j++){
          a = list[i];
          b = list[j];
          if (a.startDay <= b.endDay && b.startDay <= a.endDay) {
            ids[a.id] = 1;
            ids[b.id] = 1;
          }
        }
      }
    }
    return ids;
  }
  function schedLaneLabel(key, labelById){
    if (key === SCHED_UNASSIGNED) return 'Unassigned';
    return (labelById[key] || key);
  }
  function schedIndexOfDay(days, ymd){
    var i;
    for (i=0;i<days.length;i++){
      if (days[i] === ymd) return i;
    }
    return -1;
  }
  function schedEmptyCard(title, desc){
    var html = '<div class="sched"><div class="card"><div class="empty">' + esc(title);
    if (desc) html += '<div class="muted" style="margin-top:8px">' + esc(desc) + '</div>';
    html += '</div></div></div>';
    return html;
  }
  function schedWeekStartsFor(startDay, endDay){
    var out = [];
    var ws = schedWeekStartSun(startDay);
    var last = schedWeekStartSun(endDay);
    var guard = 0;
    if (!ws || !last) return out;
    while (ws && ws <= last && guard < 54) {
      out.push(ws);
      ws = schedAddDays(ws, 7);
      guard++;
    }
    return out;
  }
  function renderSchedulerHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var fields = schedAllFields(content, cols);
    var resSlug = schedResolveSlug(fields, schedCfgStr(cfg, 'resourceFieldSlug', 'resource_field') || pickUserSlug(content, cols), 'res');
    var startSlug = schedResolveSlug(fields, schedCfgStr(cfg, 'startDateFieldSlug', 'start_date_field') || pickDateSlug(content, cols), 'date');
    var endSlug = schedResolveSlug(fields, schedCfgStr(cfg, 'endDateFieldSlug', 'end_date_field') || startSlug, 'date') || startSlug;
    var titleSlug = schedCfgStr(cfg, 'titleFieldSlug', 'title_field') || titleSlugOf(content, cols);
    if (!startSlug) return renderWorkloadHtml(content);
    if (!resSlug) {
      return schedEmptyCard(
        'Pick resource and dates',
        'This share needs a resource field plus start and end dates to show bookings.'
      );
    }
    var usesDatetime = schedFieldType(fields, startSlug) === 'datetime' || schedFieldType(fields, endSlug) === 'datetime';
    var bookings = [];
    var truncated = false;
    var skippedNoDate = 0;
    var skippedOverCap = 0;
    var skippedEndBeforeStart = 0;
    var labelById = Object.create(null);
    rows.forEach(function(r, rowIndex){
      var startDay = schedYmdRole(r, startSlug, 'start');
      var endRaw = schedYmdRole(r, endSlug, 'end');
      if (!startDay) { skippedNoDate++; return; }
      if (endRaw && endRaw < startDay) { skippedEndBeforeStart++; return; }
      var endDay = endRaw || startDay;
      var d = r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
      var rawRes = resSlug ? d[resSlug] : undefined;
      var keys = schedResKeys(rawRes);
      if (!keys.length) keys = [SCHED_UNASSIGNED];
      var multi = keys.length > 1;
      var ki;
      if (Array.isArray(rawRes)) {
        for (ki=0;ki<rawRes.length;ki++){
          var itemKey = schedResScalar(rawRes[ki]);
          if (itemKey && itemKey !== SCHED_UNASSIGNED) labelById[itemKey] = schedResLabel(rawRes[ki], itemKey);
        }
      } else if (keys[0] && keys[0] !== SCHED_UNASSIGNED) {
        labelById[keys[0]] = schedResLabel(rawRes, keys[0]);
      }
      var label = titleSlug ? (rowCellText(r, titleSlug).trim() || 'Untitled') : 'Untitled';
      var recId = rowIdOf(r) || ('row-' + rowIndex);
      for (ki=0;ki<keys.length;ki++){
        if (bookings.length >= SCHED_BOOKINGS_MAX) { truncated = true; skippedOverCap++; continue; }
        var rk = keys[ki];
        bookings.push({
          id: multi ? schedCap(recId + '::' + rk, 200) : recId,
          recordId: recId,
          resourceKey: rk,
          startDay: startDay,
          endDay: endDay,
          label: label
        });
      }
    });
    function honestyBits(weeksTruncated, weeksHidden){
      var s = '';
      if (content && content.truncated === true) {
        var total = typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
        if (total > rows.length) s += 'Showing the first ' + rows.length + ' of ' + total + ' records. ';
        else s += 'This page may not include every record. ';
      }
      if (truncated || skippedOverCap > 0) {
        s += 'Scheduler caps at ' + SCHED_BOOKINGS_MAX + ' bookings';
        if (skippedOverCap > 0) s += ' (' + skippedOverCap + ' not shown past the cap)';
        s += '. ';
      }
      if (weeksTruncated) {
        s += 'Showing the first ' + SCHED_WEEKS_MAX + ' weeks that have bookings';
        if (weeksHidden > 0) s += ' (+' + weeksHidden + ' more weeks hidden)';
        s += '. ';
      }
      if (skippedNoDate > 0) s += skippedNoDate + ' without usable dates skipped. ';
      if (skippedEndBeforeStart > 0) s += skippedEndBeforeStart + ' with end before start skipped. ';
      if (s) s += 'Counts may be incomplete.';
      return s;
    }
    if (!bookings.length) {
      var missH = honestyBits(false, 0);
      var miss = '<div class="sched"><div class="card"><div class="empty">No bookings with usable dates to show.</div></div>';
      if (missH) miss += '<p class="hint" style="color:#f59e0b">' + esc(missH) + '</p>';
      return miss + '</div>';
    }
    var weekSeen = Object.create(null);
    var weeks = [];
    var bi, wi, wlist, ws;
    for (bi=0;bi<bookings.length;bi++){
      wlist = schedWeekStartsFor(bookings[bi].startDay, bookings[bi].endDay);
      for (wi=0;wi<wlist.length;wi++){
        ws = wlist[wi];
        if (!ws || weekSeen[ws]) continue;
        weekSeen[ws] = 1;
        weeks.push(ws);
      }
    }
    weeks.sort();
    var weeksTruncated = false;
    var weeksHidden = 0;
    if (weeks.length > SCHED_WEEKS_MAX) {
      weeksTruncated = true;
      weeksHidden = weeks.length - SCHED_WEEKS_MAX;
      weeks = weeks.slice(0, SCHED_WEEKS_MAX);
    }
    if (!weeks.length) {
      return schedEmptyCard('No bookings with usable dates to show.', honestyBits(false, 0));
    }
    var todayKey = ymdFromDate(new Date());
    var paintedConflict = Object.create(null);
    var html = '<div class="sched">';
    function paintWeek(weekStart){
      var days = schedWeekDays(weekStart);
      if (days.length < SCHED_VISIBLE_DAYS) return '';
      var weekEnd = days[days.length - 1];
      var weekBookings = [];
      var i;
      for (i=0;i<bookings.length;i++){
        if (schedIntersectsWeek(bookings[i].startDay, bookings[i].endDay, weekStart, weekEnd)) {
          weekBookings.push(bookings[i]);
        }
      }
      if (!weekBookings.length) return '';
      var byLane = Object.create(null);
      for (i=0;i<weekBookings.length;i++){
        var lk = weekBookings[i].resourceKey;
        if (!byLane[lk]) byLane[lk] = [];
        byLane[lk].push(weekBookings[i]);
      }
      var named = [];
      var nk;
      for (nk in byLane) {
        if (!Object.prototype.hasOwnProperty.call(byLane, nk)) continue;
        if (nk === SCHED_UNASSIGNED) continue;
        named.push(nk);
      }
      named.sort(function(a, b){
        return String(schedLaneLabel(a, labelById)).localeCompare(String(schedLaneLabel(b, labelById)), 'en-US', { sensitivity: 'base' });
      });
      var lanesTruncated = false;
      var lanesHidden = 0;
      if (named.length > SCHED_LANES_MAX) {
        lanesTruncated = true;
        lanesHidden = named.length - SCHED_LANES_MAX;
        named = named.slice(0, SCHED_LANES_MAX);
      }
      var order = named.slice();
      if (byLane[SCHED_UNASSIGNED] && byLane[SCHED_UNASSIGNED].length) order.push(SCHED_UNASSIGNED);
      if (!order.length) return '';
      var conflictIds = schedConflicts(weekBookings);
      var out = '<p class="hint" style="margin:12px 0 6px">' + esc(schedFmtRange(weekStart, weekEnd)) + '</p>';
      out += '<div style="overflow-x:auto;border:1px solid #26282e;border-radius:8px;min-width:0">';
      out += '<div style="min-width:720px">';
      out += '<div style="display:grid;grid-template-columns:' + SCHED_GRID_HEAD + ';position:sticky;top:0;z-index:3;background:#0a0b0e;border-bottom:1px solid #26282e">';
      out += '<div style="position:sticky;left:0;z-index:4;background:#0a0b0e;padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#9aa1ab;font-weight:500;border-right:1px solid #26282e">Resource</div>';
      var di, parts, isToday, isWknd, headBg;
      for (di=0;di<days.length;di++){
        parts = schedDayParts(days[di]);
        isToday = days[di] === todayKey;
        isWknd = schedIsWeekend(days[di]);
        headBg = isToday ? 'rgba(59,130,246,0.16)' : (isWknd ? 'rgba(255,255,255,0.04)' : 'transparent');
        out += '<div style="padding:4px 4px;text-align:center;border-left:1px solid #26282e;min-width:0;background:' + headBg + '">';
        out += '<div style="font-size:9px;text-transform:uppercase;letter-spacing:.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'
          + (isToday ? '#3b82f6;font-weight:600' : '#9aa1ab') + '">' + esc(parts.weekday) + '</div>';
        out += '<div style="font-size:11px;line-height:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:'
          + (isToday ? '#3b82f6;font-weight:600' : '#c3c8d1') + '">' + esc(parts.day) + '</div>';
        out += '</div>';
      }
      out += '</div>';
      order.forEach(function(k){
        var packing = schedPack(byLane[k] || []);
        var trackH = Math.max(SCHED_LANE_MIN_H, packing.rowCount * SCHED_ROW_H + SCHED_LANE_PAD * 2);
        var bands = '';
        for (di=0;di<days.length;di++){
          isToday = days[di] === todayKey;
          isWknd = schedIsWeekend(days[di]);
          headBg = isToday ? 'rgba(59,130,246,0.08)' : (isWknd ? 'rgba(255,255,255,0.04)' : 'transparent');
          bands += '<div style="border-left:1px solid #26282e;height:100%;background:' + headBg + '"></div>';
        }
        var bars = '';
        packing.placed.forEach(function(p){
          var b = p.booking;
          var leftIdx = b.startDay < weekStart ? 0 : Math.max(0, schedIndexOfDay(days, b.startDay));
          var rightRaw = schedIndexOfDay(days, b.endDay);
          var rightIdx = b.endDay > weekEnd
            ? (days.length - 1)
            : Math.max(leftIdx, rightRaw >= 0 ? rightRaw : (days.length - 1));
          var spanDays = Math.max(1, rightIdx - leftIdx + 1);
          var leftPct = (leftIdx / days.length) * 100;
          var widthPct = (spanDays / days.length) * 100;
          var top = SCHED_LANE_PAD + p.row * SCHED_ROW_H;
          var h = SCHED_ROW_H - SCHED_ROW_GAP;
          var conflict = !!conflictIds[b.id];
          if (conflict) paintedConflict[b.id] = 1;
          var tip = conflict ? (b.label + ' - booked on the same day as another job here') : b.label;
          var bg = conflict ? 'rgba(245,158,11,0.22)' : 'rgba(59,130,246,0.22)';
          var bd = conflict ? '#f59e0b' : 'rgba(59,130,246,0.45)';
          var fg = conflict ? '#fbbf24' : '#e7e9ee';
          var mark = conflict ? '<span style="flex:0 0 auto;font-weight:700;margin-right:4px">!</span>' : '';
          bars += '<div class="tl-bar" style="left:calc(' + schedPct(leftPct) + '% + 2px);width:calc(' + schedPct(widthPct)
            + '% - 4px);top:' + top + 'px;height:' + h + 'px;bottom:auto;background:' + bg + ';border:1px solid ' + bd
            + ';color:' + fg + ';overflow:hidden;font-size:11px;line-height:' + h + 'px;padding:0 6px;box-sizing:border-box;display:flex;align-items:center;min-width:8px" title="'
            + esc(tip) + '">' + mark + '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
            + esc(b.label || 'Untitled') + '</span></div>';
        });
        if (packing.overflow.length > 0) {
          var moreN = packing.overflow.length;
          var moreItems = packing.overflow.slice(0, 40);
          var moreList = '';
          var oi;
          for (oi=0;oi<moreItems.length;oi++){
            var ob = moreItems[oi];
            var oConflict = !!conflictIds[ob.id];
            moreList += '<div style="padding:4px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'
              + (oConflict ? '! ' : '') + esc(ob.label || 'Untitled') + '</div>';
          }
          if (moreN > moreItems.length) {
            moreList += '<div class="muted" style="padding-top:6px;border-top:1px solid #26282e">Showing first '
              + moreItems.length + ' of ' + moreN + '</div>';
          }
          bars += '<details style="position:absolute;right:6px;bottom:2px;z-index:2;font-size:10px;color:#f59e0b">'
            + '<summary style="cursor:pointer;list-style:none">+' + moreN + ' more</summary>'
            + '<div class="at-scroll" style="position:absolute;right:0;bottom:18px;width:220px;max-height:min(50vh,320px);overflow-y:auto;overflow-x:hidden;background:#131519;border:1px solid #26282e;border-radius:8px;padding:8px 10px;color:#e7e9ee">'
            + moreList + '</div></details>';
        }
        out += '<div style="display:grid;grid-template-columns:' + SCHED_GRID_LANE + ';border-bottom:1px solid #26282e">';
        out += '<div class="tl-lab" style="position:sticky;left:0;z-index:2;background:#0a0b0e;padding:8px;font-size:12px;font-weight:500;border-right:1px solid #26282e;align-self:stretch;display:flex;align-items:flex-start">'
          + esc(schedLaneLabel(k, labelById)) + '</div>';
        out += '<div class="tl-track" style="height:' + trackH + 'px;border:none;border-radius:0;background:transparent">';
        out += '<div style="position:absolute;inset:0;display:grid;grid-template-columns:' + SCHED_GRID_DAYS + ';pointer-events:none">' + bands + '</div>';
        out += bars;
        out += '</div></div>';
      });
      out += '</div></div>';
      if (lanesTruncated) {
        out += '<p class="hint" style="color:#f59e0b">Showing the first ' + SCHED_LANES_MAX + ' resources';
        if (lanesHidden > 0) out += ' (+' + lanesHidden + ' more lanes hidden)';
        out += '.</p>';
      }
      return out;
    }
    var conflictCount = 0;
    var cid;
    var weekHtml = '';
    for (wi=0;wi<weeks.length;wi++){
      weekHtml += paintWeek(weeks[wi]);
    }
    for (cid in paintedConflict) {
      if (Object.prototype.hasOwnProperty.call(paintedConflict, cid)) conflictCount++;
    }
    var foot = '';
    if (conflictCount > 0) foot += conflictCount + ' double booked. ';
    if (usesDatetime) foot += 'Conflicts use whole days. ';
    foot += honestyBits(weeksTruncated, weeksHidden);
    if (foot) html += '<p class="hint" style="color:#f59e0b;margin:0 0 8px">' + esc(foot) + '</p>';
    html += weekHtml;
    html += '</div>';
    return html;
  }
`
