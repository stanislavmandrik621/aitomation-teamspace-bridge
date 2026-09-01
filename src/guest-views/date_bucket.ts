/**
 * Guest Date board (date_bucket / date_board) read layout.
 *
 * Concatenate AFTER GUEST_RENDER_CORE_JS so this `renderDateBucketHtml`
 * wins. Parent `renderDateBoardHtml` still paints calendar-day `.date-board`
 * lanes for calendar/timeline/scheduler fallbacks; this overlay must never
 * reassign that function or intercept those view types.
 *
 * After the share/portal shell paints read HTML, call
 * `enhanceGuestDateBucket(content)` so Today / Overdue retick past midnight.
 *
 * Template-literal rule: no backticks, no ${ } in the embedded source;
 * double backslashes in regex/string literals.
 *
 * Overridden: renderDateBucketHtml (and renderReadBodyHtml only when
 * canonicalViewType is date_bucket).
 * New helpers: pickGuestDateBucketSlug, pickGuestDateBucketTitleSlug,
 * guestDateBucketCfgSlug, guestDateYmd, guestClassifyDateRangeKeys,
 * guestDateBucketCoverSrc, guestDateBucketEmptyHtml.
 */

export const GUEST_VIEW_DATE_BUCKET_JS = `
  var GUEST_DATE_BUCKET_IDS = ['overdue','today','tomorrow','this_week','later','no_date'];
  var GUEST_DATE_BUCKET_LABELS = {
    overdue: 'Overdue',
    today: 'Today',
    tomorrow: 'Tomorrow',
    this_week: 'This week',
    later: 'Later',
    no_date: 'No date'
  };
  var GUEST_DATE_BUCKET_THEME = {
    overdue: { color: 'hsl(0,72%,51%)', bg: 'hsla(0,72%,51%,0.12)', border: 'hsla(0,72%,51%,0.35)' },
    today: { color: 'hsl(32,95%,44%)', bg: 'hsla(32,95%,44%,0.12)', border: 'hsla(32,95%,44%,0.35)' },
    tomorrow: { color: 'hsl(142,50%,36%)', bg: 'hsla(142,50%,36%,0.12)', border: 'hsla(142,50%,36%,0.35)' },
    this_week: { color: 'hsl(262,60%,55%)', bg: 'hsla(262,60%,55%,0.12)', border: 'hsla(262,60%,55%,0.35)' },
    later: { color: 'hsl(210,40%,50%)', bg: 'hsla(210,40%,50%,0.10)', border: 'hsla(210,40%,50%,0.30)' },
    no_date: { color: 'hsl(0,0%,50%)', bg: 'hsla(0,0%,50%,0.08)', border: 'hsla(0,0%,50%,0.25)' }
  };
  var GUEST_DATE_BUCKET_META_MAX = 3;
  var GUEST_DATE_BUCKET_DESC_MAX = 80;
  var _guestDateBucketTickArmed = false;
  var _guestDateBucketDayKey = '';
  var _guestDateBucketContent = null;

  function guestDateBucketIsDateType(ft){
    var t = String(ft || '').trim().toLowerCase();
    return t === 'date' || t === 'datetime' || t === 'date_range';
  }
  function guestDateBucketCfgSlug(cfg, keys){
    var i, s;
    for (i = 0; i < keys.length; i++) {
      s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  }
  function guestDateBucketHasSlug(cols, slug){
    var i;
    if (!slug) return false;
    for (i = 0; i < cols.length; i++) {
      if (cols[i] && cols[i].slug === slug) return true;
    }
    return false;
  }
  function guestDateBucketFieldType(cols, slug){
    var i;
    if (!slug) return '';
    for (i = 0; i < cols.length; i++) {
      if (cols[i] && cols[i].slug === slug) return String(cols[i].field_type || '').trim().toLowerCase();
    }
    return '';
  }
  function pickGuestDateBucketSlug(content, cols){
    var cfg = viewCfg(content);
    var keys = ['dateFieldSlug', 'date_field', 'dateField'];
    var i, s, t;
    for (i = 0; i < keys.length; i++) {
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s.trim()) continue;
      s = s.trim();
      t = guestDateBucketFieldType(cols, s);
      return guestDateBucketIsDateType(t) ? s : '';
    }
    for (i = 0; i < cols.length; i++) {
      if (guestDateBucketIsDateType(cols[i].field_type)) return cols[i].slug;
    }
    return '';
  }
  function pickGuestDateBucketTitleSlug(content, cols){
    var cfg = viewCfg(content);
    var s = guestDateBucketCfgSlug(cfg, ['titleFieldSlug', 'title_field', 'titleField']);
    if (s && guestDateBucketHasSlug(cols, s)) return s;
    return titleSlugOf(content, cols);
  }
  function guestDatePad2(n){
    n = Number(n);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return n < 10 ? '0' + n : String(n);
  }
  function guestDateYmd(d){
    return d.getFullYear() + '-' + guestDatePad2(d.getMonth() + 1) + '-' + guestDatePad2(d.getDate());
  }
  function guestDateBucketTodayKey(){
    return guestDateYmd(new Date());
  }
  function guestAddLocalDays(d, delta){
    var out = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    out.setDate(out.getDate() + delta);
    return out;
  }
  function guestStartOfWeekLocal(d, weekStart){
    var offset = weekStart === 'mon' ? 1 : 0;
    var raw = d.getDay();
    var daysFromStart = (raw - offset + 7) % 7;
    return guestAddLocalDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -daysFromStart);
  }
  function guestDateBucketWeekStart(content){
    var cfg = viewCfg(content);
    var v = cfg.weekStartDay || cfg.week_start_day;
    if (content && (content.weekStartDay === 'mon' || content.weekStartDay === 'sun')) v = content.weekStartDay;
    return v === 'mon' ? 'mon' : 'sun';
  }
  function guestClassifyDayKey(dayKey, todayKey, tomorrowKey, weekEndKey){
    if (dayKey < todayKey) return 'overdue';
    if (dayKey === todayKey) return 'today';
    if (dayKey === tomorrowKey) return 'tomorrow';
    if (dayKey <= weekEndKey) return 'this_week';
    return 'later';
  }
  function guestClassifyDateRangeKeys(startKey, endKey, todayKey, tomorrowKey, weekEndKey){
    if (!startKey && !endKey) return 'no_date';
    if (!startKey) startKey = endKey;
    if (!endKey) endKey = startKey;
    if (endKey < startKey) {
      var tmp = startKey;
      startKey = endKey;
      endKey = tmp;
    }
    if (todayKey >= startKey && todayKey <= endKey) return 'today';
    if (endKey < todayKey) return 'overdue';
    return guestClassifyDayKey(startKey, todayKey, tomorrowKey, weekEndKey);
  }
  function guestClassifyDateBucketValue(raw, todayKey, tomorrowKey, weekEndKey, depth){
    depth = depth || 0;
    if (raw == null || raw === '' || depth > 3) return 'no_date';
    if (Array.isArray(raw) && raw.length) {
      return guestClassifyDateRangeKeys(
        ymdFromValue(raw[0], 0),
        ymdFromValue(raw.length > 1 ? raw[1] : raw[0], 0),
        todayKey, tomorrowKey, weekEndKey
      );
    }
    if (raw && typeof raw === 'object') {
      if (Object.prototype.hasOwnProperty.call(raw, 'start') || Object.prototype.hasOwnProperty.call(raw, 'end')) {
        return guestClassifyDateRangeKeys(
          ymdFromValue(raw.start, 0),
          ymdFromValue(raw.end, 0),
          todayKey, tomorrowKey, weekEndKey
        );
      }
    }
    if (typeof raw === 'string') {
      var t = raw.trim();
      if ((t.charAt(0) === '{' || t.charAt(0) === '[') && t.length < 64000) {
        try {
          return guestClassifyDateBucketValue(JSON.parse(t), todayKey, tomorrowKey, weekEndKey, depth + 1);
        } catch (err) { /* unreadable range JSON - classify as scalar below */ }
      }
    }
    var key = ymdFromValue(raw, 0);
    if (!key) return 'no_date';
    return guestClassifyDayKey(key, todayKey, tomorrowKey, weekEndKey);
  }
  function guestRowDateBucketId(row, dateSlug, todayKey, tomorrowKey, weekEndKey){
    if (!dateSlug) return 'no_date';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var fromData = guestClassifyDateBucketValue(d[dateSlug], todayKey, tomorrowKey, weekEndKey, 0);
    if (fromData !== 'no_date') return fromData;
    var fromText = ymdFromValue(rowCellText(row, dateSlug), 0);
    if (!fromText) return 'no_date';
    return guestClassifyDayKey(fromText, todayKey, tomorrowKey, weekEndKey);
  }
  function guestDateBucketCoverSrc(row, slug){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var raw = d[slug];
    var cands = [];
    function push(v){
      if (typeof v === 'string' && v.trim()) cands.push(v.trim());
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        var keys = ['url', 'path', 'src', 'href'];
        var k;
        for (k = 0; k < keys.length; k++) {
          if (typeof v[keys[k]] === 'string' && v[keys[k]].trim()) {
            cands.push(v[keys[k]].trim());
            return;
          }
        }
      }
    }
    if (rowHasDisplay(row, slug)) {
      var dispRaw = rowDisplayMap(row)[slug];
      if (Array.isArray(dispRaw)) {
        var di;
        for (di = 0; di < dispRaw.length && di < 8; di++) push(dispRaw[di]);
      } else {
        push(dispRaw);
      }
    }
    if (Array.isArray(raw)) {
      var i;
      for (i = 0; i < raw.length && i < 8; i++) push(raw[i]);
    } else {
      push(raw);
    }
    var disp = rowCellText(row, slug);
    if (disp) cands.push(disp.trim());
    var j;
    for (j = 0; j < cands.length; j++) {
      if (isSafeHttpUrl(cands[j])) return cands[j];
    }
    return '';
  }
  function guestDateBucketPreview(text){
    var s = (typeof text === 'string' ? text : valueText(text, 0)).replace(/\\r?\\n/g, ' ').replace(/\\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= GUEST_DATE_BUCKET_DESC_MAX) return capStr(s, GUEST_DATE_BUCKET_DESC_MAX);
    return capStr(s, Math.max(0, GUEST_DATE_BUCKET_DESC_MAX - 3)) + '...';
  }
  function guestDateBucketEmptyHtml(kind){
    if (kind === 'no_date_field') {
      return '<div class="card"><div class="empty">This board needs a date column.</div></div>';
    }
    return '<div class="card"><div class="empty">No records yet.</div></div>';
  }
  function guestDateBucketCardHtml(row, cols, titleSlug, dateSlug, imgSlug, descSlug){
    var cover = '';
    if (imgSlug) {
      var src = guestDateBucketCoverSrc(row, imgSlug);
      if (src) {
        cover = '<img loading="lazy" alt="" src="' + esc(src) + '" style="display:block;width:100%;height:72px;object-fit:cover;border-radius:8px;margin-bottom:8px;background:#0d0f13"/>';
      }
    }
    var desc = '';
    if (descSlug) {
      var preview = guestDateBucketPreview(rowCellText(row, descSlug));
      if (preview) {
        desc = '<div class="muted" style="margin-top:2px;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(preview) + '</div>';
      }
    }
    var extra = '';
    var shown = 0;
    var ci, c, t, val;
    for (ci = 0; ci < cols.length && shown < GUEST_DATE_BUCKET_META_MAX; ci++) {
      c = cols[ci];
      if (!c || c.slug === titleSlug || c.slug === dateSlug || c.slug === imgSlug || c.slug === descSlug) continue;
      t = String(c.field_type || '').toLowerCase();
      if (t === 'image' || t === 'file' || t === 'rich_text') continue;
      val = cellHtml(c, row);
      if (val === '') continue;
      extra += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
      shown++;
    }
    return '<div class="board-card">' + cover + rowTitleHtml(row, titleSlug) + desc + extra + '</div>';
  }
  function guestDateBucketLaneHtml(id, cards){
    var theme = GUEST_DATE_BUCKET_THEME[id];
    var label = GUEST_DATE_BUCKET_LABELS[id];
    if (!theme || !label) return '';
    var n = cards.length;
    var body = n
      ? cards.join('')
      : '<div class="empty" style="padding:20px 8px;font-size:.75rem">No ' + esc(label.toLowerCase()) + ' records</div>';
    return '<div class="lane" data-date-bucket-column="' + id + '" style="border-color:' + theme.border + '">'
      + '<div class="lane-head" style="border-color:' + theme.border + ';background:' + theme.bg + ';box-shadow:inset 0 -2px 0 0 ' + theme.color + '">'
      + '<span style="flex:0 0 auto;width:8px;height:8px;border-radius:2px;background:' + theme.color + '"></span>'
      + '<span>' + esc(label) + '</span>'
      + '<span class="lane-count">' + n + '</span>'
      + '</div>' + body + '</div>';
  }
  function renderDateBucketHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length) return guestDateBucketEmptyHtml('no_date_field');
    if (!rows.length) return guestDateBucketEmptyHtml('no_rows');
    var dateSlug = pickGuestDateBucketSlug(content, cols);
    if (!dateSlug) return guestDateBucketEmptyHtml('no_date_field');
    var titleSlug = pickGuestDateBucketTitleSlug(content, cols);
    var cfg = viewCfg(content);
    var imgSlug = guestDateBucketCfgSlug(cfg, ['imageFieldSlug', 'image_field', 'imageField']);
    if (imgSlug && !guestDateBucketHasSlug(cols, imgSlug)) imgSlug = '';
    var descSlug = guestDateBucketCfgSlug(cfg, ['descriptionFieldSlug', 'description_field', 'descriptionField']);
    if (descSlug && !guestDateBucketHasSlug(cols, descSlug)) descSlug = '';
    var today = new Date();
    var todayKey = guestDateYmd(today);
    var tomorrowKey = guestDateYmd(guestAddLocalDays(today, 1));
    var weekEndKey = guestDateYmd(guestAddLocalDays(guestStartOfWeekLocal(today, guestDateBucketWeekStart(content)), 6));
    var by = { overdue: [], today: [], tomorrow: [], this_week: [], later: [], no_date: [] };
    var i, id;
    for (i = 0; i < rows.length; i++) {
      id = guestRowDateBucketId(rows[i], dateSlug, todayKey, tomorrowKey, weekEndKey);
      if (!by[id]) id = 'no_date';
      by[id].push(guestDateBucketCardHtml(rows[i], cols, titleSlug, dateSlug, imgSlug, descSlug));
    }
    var lanes = '';
    var b, bid;
    for (b = 0; b < GUEST_DATE_BUCKET_IDS.length; b++) {
      bid = GUEST_DATE_BUCKET_IDS[b];
      lanes += guestDateBucketLaneHtml(bid, by[bid]);
    }
    return '<div class="date-board" data-guest-date-bucket="1">' + lanes + '</div>';
  }
  function enhanceGuestDateBucket(content){
    if (typeof document === 'undefined') return;
    if (!content) return;
    var vt = canonicalViewType(content.viewType);
    if (vt !== 'date_bucket') return;
    _guestDateBucketContent = content;
    var mount = document.querySelector('[data-guest-date-bucket="1"]');
    if (!mount) {
      mount = document.querySelector('.date-board');
      if (!mount) return;
      if (mount.classList && mount.classList.contains('cal-undated')) return;
    }
    var next = guestDateBucketTodayKey();
    var already = mount.getAttribute && mount.getAttribute('data-guest-date-bucket') === '1';
    var skipReplace = (already && !_guestDateBucketDayKey) || (already && next === _guestDateBucketDayKey);
    if (!skipReplace) {
      var wrap = document.createElement('div');
      wrap.innerHTML = renderDateBucketHtml(content);
      var fresh = wrap.firstChild;
      if (fresh && mount.parentNode) mount.parentNode.replaceChild(fresh, mount);
    }
    _guestDateBucketDayKey = next;
    if (_guestDateBucketTickArmed) return;
    _guestDateBucketTickArmed = true;
    function syncGuestDateBucketDay(){
      if (document.visibilityState && document.visibilityState !== 'visible') return;
      var day = guestDateBucketTodayKey();
      if (day === _guestDateBucketDayKey) return;
      if (_guestDateBucketContent) enhanceGuestDateBucket(_guestDateBucketContent);
    }
    window.addEventListener('focus', syncGuestDateBucketDay);
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState === 'visible') syncGuestDateBucketDay();
    });
    window.setInterval(syncGuestDateBucketDay, 60000);
  }
  if (typeof renderReadBodyHtml === 'function') {
    var _guestRenderReadBodyHtml = renderReadBodyHtml;
    renderReadBodyHtml = function(content){
      var vt = canonicalViewType(content && content.viewType);
      if (vt === 'date_bucket') return { html: renderDateBucketHtml(content), simplified: false };
      return _guestRenderReadBodyHtml(content);
    };
  }
`
