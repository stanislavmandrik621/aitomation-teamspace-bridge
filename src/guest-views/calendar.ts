/**
 * Guest calendar override. Concatenate AFTER GUEST_RENDER_JS so this
 * `renderCalendarHtml` replaces the parent. Depends on esc, visibleFields,
 * viewCfg, titleSlugOf, rowDateKey, rowCellText, ymdFromValue, ymdFromDate,
 * emptyStateHtml.
 *
 * Read-only 7-column CSS grid (.cal) matching calendar-view.tsx month
 * mode. Never a <table>, never a .date-board / No date strip. Undated
 * rows stay off the grid and are named in the footer. No backticks and
 * no ${ } inside the embedded JS (this file is itself a template literal).
 */

export const GUEST_VIEW_CALENDAR_JS = `
  var CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var CAL_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var CAL_PILL_CAP = 3;
  var CAL_SPAN_DAY_CAP = 366;
  var CAL_MONTH_CAP = 12;

  function calIsDateType(ft){
    var t = String(ft || '').toLowerCase();
    return t === 'date' || t === 'datetime' || t === 'date_range';
  }

  function calPickDateSlug(content, cols){
    var cfg = viewCfg(content);
    var keys = ['dateFieldSlug','date_field','dateField'];
    var i, j, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s) continue;
      for (j=0;j<cols.length;j++){
        if (cols[j] && cols[j].slug === s) return s;
      }
    }
    for (j=0;j<cols.length;j++){
      if (cols[j] && calIsDateType(cols[j].field_type)) return cols[j].slug;
    }
    return '';
  }

  function calFieldType(cols, slug){
    var i, t;
    for (i=0;i<cols.length;i++){
      if (cols[i] && cols[i].slug === slug) {
        t = String(cols[i].field_type || '').toLowerCase();
        return t;
      }
    }
    return '';
  }

  function calWeekOffset(content){
    var cfg = viewCfg(content);
    var v = cfg.weekStartDay || cfg.week_start_day;
    return v === 'mon' ? 1 : 0;
  }

  function calPad2(n){
    n = Number(n);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return n < 10 ? '0' + n : String(n);
  }

  function calYmd(y, m, d){
    return String(y) + '-' + calPad2(m) + '-' + calPad2(d);
  }

  function calYmdFromLocalDate(dt){
    if (!dt || isNaN(dt.getTime())) return '';
    return calYmd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  function calParseYmd(ymd){
    var p = String(ymd || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    var d = parseInt(p[2], 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: y, m: m, d: d };
  }

  function calParseYm(ym){
    var p = String(ym || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    return { y: y, m: m };
  }

  function calAddLocalDays(ymd, n){
    var p = calParseYmd(ymd);
    if (!p) return '';
    var dt = new Date(p.y, p.m - 1, p.d);
    dt.setDate(dt.getDate() + n);
    return calYmdFromLocalDate(dt);
  }

  function calMaybeJson(raw){
    if (typeof raw !== 'string') return raw;
    var s = raw.trim();
    if (!s || s.length > 4000) return raw;
    var c0 = s.charAt(0);
    if (c0 !== '{' && c0 !== '[') return raw;
    try { return JSON.parse(s); } catch (e) { return raw; }
  }

  function calRangePair(raw){
    raw = calMaybeJson(raw);
    if (raw == null || raw === '') return null;
    var a, b, s, left, right, cut;
    if (Array.isArray(raw) && raw.length) {
      a = ymdFromValue(raw[0], 0);
      b = ymdFromValue(raw.length > 1 ? raw[1] : raw[0], 0);
      if (!a && !b) return null;
      return { start: a || b, end: b || a };
    }
    if (typeof raw === 'object') {
      a = ymdFromValue(raw.start != null ? raw.start : (raw.from != null ? raw.from : raw.begin), 0);
      b = ymdFromValue(raw.end != null ? raw.end : (raw.to != null ? raw.to : raw.finish), 0);
      if (!a && !b) return null;
      return { start: a || b, end: b || a };
    }
    if (typeof raw === 'string') {
      s = raw.trim();
      left = '';
      right = '';
      cut = s.indexOf(' to ');
      if (cut > 0) {
        left = ymdFromValue(s.slice(0, cut), 0);
        right = ymdFromValue(s.slice(cut + 4), 0);
      } else {
        cut = s.indexOf('..');
        if (cut > 0) {
          left = ymdFromValue(s.slice(0, cut), 0);
          right = ymdFromValue(s.slice(cut + 2), 0);
        } else {
          cut = s.indexOf(' - ');
          if (cut > 0) {
            left = ymdFromValue(s.slice(0, cut), 0);
            right = ymdFromValue(s.slice(cut + 3), 0);
          }
        }
      }
      if (left || right) return { start: left || right, end: right || left };
      var one = ymdFromValue(s, 0);
      return one ? { start: one, end: one } : null;
    }
    var k = ymdFromValue(raw, 0);
    return k ? { start: k, end: k } : null;
  }

  function calEnumerateSpan(start, end){
    if (!start) return { keys: [], truncated: false };
    if (!end) end = start;
    if (end < start) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    var keys = [];
    var cur = start;
    var i;
    for (i=0;i<CAL_SPAN_DAY_CAP;i++){
      keys.push(cur);
      if (cur === end) return { keys: keys, truncated: false };
      cur = calAddLocalDays(cur, 1);
      if (!cur) break;
    }
    return { keys: keys, truncated: cur !== end };
  }

  function calRowDateKeys(row, slug, fieldType){
    if (!slug) return { keys: [], truncated: false };
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (fieldType === 'date_range') {
      var pair = calRangePair(d[slug]);
      if (!pair) {
        var fallback = rowDateKey(row, slug);
        return fallback ? { keys: [fallback], truncated: false } : { keys: [], truncated: false };
      }
      return calEnumerateSpan(pair.start, pair.end);
    }
    var k = rowDateKey(row, slug);
    return k ? { keys: [k], truncated: false } : { keys: [], truncated: false };
  }

  function calUniqueInPrefix(byDay, prefix){
    var seen = Object.create(null);
    var n = 0;
    var k, i, id, items;
    for (k in byDay) {
      if (!Object.prototype.hasOwnProperty.call(byDay, k)) continue;
      if (k.indexOf(prefix) !== 0) continue;
      items = byDay[k];
      for (i=0;i<items.length;i++){
        id = items[i] && items[i].id;
        if (id && !seen[id]) { seen[id] = 1; n++; }
      }
    }
    return n;
  }

  function calPushUnique(list, row){
    var id = row && row.id;
    if (!id) { list.push(row); return; }
    var i;
    for (i=0;i<list.length;i++){
      if (list[i] && list[i].id === id) return;
    }
    list.push(row);
  }

  function calEmptyConfiguredHtml(){
    return '<div class="card"><div class="empty">No date field configured</div></div>';
  }

  function calMonthGridHtml(y, m, byDay, titleSlug, todayKey, weekOffset, multiIds){
    var first = new Date(y, m - 1, 1);
    var last = new Date(y, m, 0);
    var lead = (first.getDay() - weekOffset + 7) % 7;
    var daysIn = last.getDate();
    var html = '<div class="muted" style="font-size:1rem;font-weight:600;color:#e7e9ee;margin:12px 0 0">'
      + esc((CAL_MONTH_NAMES[m - 1] || '') + ' ' + y) + '</div>';
    html += '<div class="cal">';
    var d, di;
    for (d=0;d<7;d++){
      di = (d + weekOffset) % 7;
      html += '<div class="cal-dow">' + CAL_DOW[di] + '</div>';
    }
    for (d=0;d<lead;d++) html += '<div class="cal-day out"></div>';
    var i, j, mm, dd, key, items, cards, nHtml, extra, pillStyle, rid;
    mm = calPad2(m);
    for (i=1;i<=daysIn;i++){
      dd = calPad2(i);
      key = String(y) + '-' + mm + '-' + dd;
      items = byDay[key] || [];
      cards = '';
      for (j=0;j<items.length && j<CAL_PILL_CAP;j++){
        rid = items[j] && items[j].id;
        pillStyle = (rid && multiIds && multiIds[rid]) ? ' style="border-left:3px solid #3b82f6"' : '';
        cards += '<div class="cal-item"' + pillStyle + '>' + esc(rowCellText(items[j], titleSlug) || 'Untitled') + '</div>';
      }
      if (items.length > CAL_PILL_CAP) {
        extra = items.length - CAL_PILL_CAP;
        cards += '<div class="cal-item">+' + extra + ' more</div>';
      }
      if (key === todayKey) {
        nHtml = '<div class="cal-day-n" style="text-align:right"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:999px;background:#3b82f6;color:#fff">' + i + '</span></div>';
      } else {
        nHtml = '<div class="cal-day-n" style="text-align:right">' + i + '</div>';
      }
      html += '<div class="cal-day">' + nHtml + cards + '</div>';
    }
    var filled = lead + daysIn;
    var pad = (7 - (filled % 7)) % 7;
    for (d=0;d<pad;d++) html += '<div class="cal-day out"></div>';
    html += '</div>';
    var count = calUniqueInPrefix(byDay, String(y) + '-' + mm + '-');
    html += '<p class="muted">' + esc(String(count) + ' records this month') + '</p>';
    return html;
  }

  function renderCalendarHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var dateSlug = calPickDateSlug(content, cols);
    if (!dateSlug) return calEmptyConfiguredHtml();
    var titleSlug = titleSlugOf(content, cols);
    var fieldType = calFieldType(cols, dateSlug);
    var weekOffset = calWeekOffset(content);
    var byDay = Object.create(null);
    var monthSet = Object.create(null);
    var monthList = [];
    var multiIds = Object.create(null);
    var undatedCount = 0;
    var spanTruncatedCount = 0;
    rows.forEach(function(r){
      var info = calRowDateKeys(r, dateSlug, fieldType);
      if (!info.keys.length) { undatedCount++; return; }
      if (info.truncated) spanTruncatedCount++;
      if (info.keys.length > 1 && r && r.id) multiIds[r.id] = 1;
      var i, k, mk;
      for (i=0;i<info.keys.length;i++){
        k = info.keys[i];
        if (!byDay[k]) byDay[k] = [];
        calPushUnique(byDay[k], r);
        mk = k.slice(0, 7);
        if (!monthSet[mk]) { monthSet[mk] = 1; monthList.push(mk); }
      }
    });
    var todayKey = ymdFromDate(new Date());
    if (!monthList.length) {
      var todayYm = todayKey ? todayKey.slice(0, 7) : '';
      if (todayYm) monthList.push(todayYm);
    }
    monthList.sort();
    var monthsTruncated = monthList.length > CAL_MONTH_CAP;
    if (monthsTruncated) monthList = monthList.slice(0, CAL_MONTH_CAP);
    var html = '';
    var mi, ym, parsed;
    for (mi=0;mi<monthList.length;mi++){
      ym = monthList[mi];
      parsed = calParseYm(ym);
      if (!parsed) continue;
      html += calMonthGridHtml(parsed.y, parsed.m, byDay, titleSlug, todayKey, weekOffset, multiIds);
    }
    if (!html) {
      var now = new Date();
      html = calMonthGridHtml(now.getFullYear(), now.getMonth() + 1, byDay, titleSlug, todayKey, weekOffset, multiIds);
    }
    var notes = [];
    if (undatedCount === 1) notes.push('1 record has no date and is not shown');
    else if (undatedCount > 1) notes.push(undatedCount + ' records have no date and are not shown');
    if (spanTruncatedCount === 1) notes.push('1 long date range is only shown for its first year of days');
    else if (spanTruncatedCount > 1) notes.push(spanTruncatedCount + ' long date ranges are only shown for their first year of days');
    if (monthsTruncated) notes.push('Later months are not shown');
    if (content && content.truncated === true) {
      var total = typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
      if (total > rows.length) notes.push('of first ' + rows.length + ' loaded; ' + total + ' total');
      else notes.push('loaded set may be capped');
    }
    if (notes.length) html += '<p class="muted">' + esc(notes.join(' - ')) + '</p>';
    return html;
  }
`
