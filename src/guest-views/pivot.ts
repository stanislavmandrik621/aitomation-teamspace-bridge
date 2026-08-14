/**
 * Guest Pivot override. Concatenated AFTER GUEST_RENDER_JS so this
 * `function renderPivotHtml` wins. Guest pages cannot mount the in-app
 * React view; this paints the same READ-ONLY matrix (row x col agg,
 * totals, Other caps) - never a record table and never a chart fallback.
 *
 * Embedded JS: no backticks, no dollar-brace interpolations. Pure
 * string -> string (no DOM). Double backslashes in regex/string literals.
 *
 * Overridden: renderPivotHtml
 * New helpers (do not exist on parent): pivotCfgSlug, pivotFieldBySlug,
 * pivotIsValueType, pivotResolveAgg, pivotAggLabel, pivotEmptyHtml,
 * pivotParseY, pivotAxisParts, pivotBucket, pivotEmptyAcc, pivotFold,
 * pivotFinish, pivotFormatCell, pivotBump, pivotRank, pivotTakeAcc,
 * pivotSep
 *
 * Gaps vs apps/desktop/src/components/views/pivot-view.tsx (stay off this page):
 * - Customize / click-through to a record (guest is view-not-edit).
 * - value_agg is not stamped on the public payload (overlay reads
 *   valueAgg / value_agg / yAgg when present, else Sum like desktop).
 * - Amber note CSS lives inline; theme has no pivot-note class.
 * - filtersActive is rarely on the payload; load-cap still uses truncated.
 * - Choice buckets prefer guest display text (SHARE display-first), not
 *   in-app filterKey / coerceChoiceValue.
 * - Tag fan-out is capped at 128 parts per cell (desktop is uncapped).
 */

export const GUEST_VIEW_PIVOT_JS = `
  function pivotCfgSlug(cfg, keys){
    if (!cfg) return '';
    var i, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim() && s.trim().length <= 128) return s.trim();
    }
    return '';
  }
  function pivotFieldBySlug(cols, slug){
    if (!slug) return null;
    var i, f;
    for (i=0;i<cols.length;i++){
      f = cols[i];
      if (!f) continue;
      if (f.slug === slug || f.id === slug) return f;
    }
    return null;
  }
  function pivotIsValueType(t){
    t = String(t || '').toLowerCase();
    return t === 'number' || t === 'currency' || t === 'percent' || t === 'rating' || t === 'progress' || t === 'vote';
  }
  function pivotResolveAgg(cfg, hasValue){
    if (!hasValue) return 'count';
    var raw = String((cfg && (cfg.valueAgg || cfg.value_agg || cfg.yAgg || cfg.y_agg)) || '').trim().toLowerCase();
    if (raw === 'sum' || raw === 'avg' || raw === 'min' || raw === 'max' || raw === 'count') return raw;
    return 'sum';
  }
  function pivotAggLabel(op){
    if (op === 'sum') return 'Sum';
    if (op === 'avg') return 'Avg';
    if (op === 'min') return 'Min';
    if (op === 'max') return 'Max';
    return 'Count';
  }
  function pivotEmptyHtml(title, desc){
    return '<div class="card"><div class="empty"><div>' + esc(title) + '</div>'
      + (desc ? '<p class="hint" style="margin:8px 0 0">' + esc(desc) + '</p>' : '')
      + '</div></div>';
  }
  function pivotParseY(row, slug){
    if (!slug) return null;
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var v = d[slug];
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'boolean' || v == null) return null;
    if (typeof v === 'object') return null;
    var s = String(v).replace(/[%$, ]/g, '').trim();
    if (!s || s === '-' || s === '+') {
      s = rowCellText(row, slug).replace(/[%$, ]/g, '').trim();
    }
    if (!s || s === '-' || s === '+') return null;
    var n = Number(s);
    return isFinite(n) ? n : null;
  }
  function pivotAxisParts(row, field){
    var t = String((field && field.field_type) || '').toLowerCase();
    var slug = field && field.slug;
    if (t === 'tags' || t === 'multiselect') {
      var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
      var raw = slug ? d[slug] : undefined;
      var items = [];
      var i, p;
      if (Array.isArray(raw)) {
        for (i=0;i<raw.length && i<128;i++){
          p = valueText(raw[i], 1);
          if (p) items.push(p);
        }
      }
      if (!items.length && slug) items = chipItems(row, slug);
      return items.length ? items : [''];
    }
    if (t === 'date' || t === 'datetime' || t === 'created_at' || t === 'updated_at') {
      return [slug ? rowDateKey(row, slug) : ''];
    }
    return [slug ? rowCellText(row, slug) : ''];
  }
  function pivotBucket(raw){
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return { key: '__empty__', label: 'Unknown', empty: true };
    return { key: s, label: s, empty: false };
  }
  function pivotEmptyAcc(){
    return { sum: 0, count: 0, min: Infinity, max: -Infinity, recordCount: 0 };
  }
  function pivotFold(acc, hasValue, yNum, op){
    acc.recordCount += 1;
    if (!hasValue) {
      acc.sum += 1;
      acc.count += 1;
      acc.min = Math.min(acc.min, 1);
      acc.max = Math.max(acc.max, 1);
      return;
    }
    if (op === 'count') {
      if (yNum !== null) acc.count += 1;
      return;
    }
    if (yNum === null) return;
    acc.sum += yNum;
    acc.count += 1;
    acc.min = Math.min(acc.min, yNum);
    acc.max = Math.max(acc.max, yNum);
  }
  function pivotFinish(acc, op, hasValue){
    if (!acc) return 0;
    if (!hasValue) return acc.recordCount;
    if (op === 'count') return acc.count;
    if (acc.count === 0) return 0;
    if (op === 'sum') return acc.sum;
    if (op === 'avg') return Math.round((acc.sum / acc.count) * 100) / 100;
    if (op === 'min') return isFinite(acc.min) ? acc.min : 0;
    if (op === 'max') return isFinite(acc.max) ? acc.max : 0;
    return 0;
  }
  function pivotFormatCell(n){
    if (!isFinite(n)) return '0';
    if (Math.round(n) === n) return n.toLocaleString('en-US');
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function pivotBump(meta, key, label, empty, weight){
    var prev = meta[key];
    if (prev) {
      prev.weight += weight;
      prev.recordCount += 1;
      return;
    }
    meta[key] = { key: key, label: label, empty: empty, weight: weight, recordCount: 1 };
  }
  function pivotRank(meta, cap, otherKey, otherPrefix){
    var list = [];
    var k;
    for (k in meta) {
      if (Object.prototype.hasOwnProperty.call(meta, k)) list.push(meta[k]);
    }
    list.sort(function(a, b){
      if (b.recordCount !== a.recordCount) return b.recordCount - a.recordCount;
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (a.empty !== b.empty) return a.empty ? 1 : -1;
      return String(a.label).localeCompare(String(b.label));
    });
    var remap = Object.create(null);
    var keys = [];
    var truncated = list.length > cap;
    var keep = truncated ? Math.max(cap - 1, 0) : list.length;
    var i;
    for (i=0;i<keep;i++){
      keys.push({
        key: list[i].key,
        label: list[i].empty ? 'Unknown' : list[i].label,
        empty: list[i].empty,
        rolledUp: false
      });
      remap[list[i].key] = list[i].key;
    }
    if (truncated) {
      var rest = list.length - keep;
      keys.push({ key: otherKey, label: otherPrefix + ' (' + rest + ')', empty: false, rolledUp: true });
      for (i=keep;i<list.length;i++) remap[list[i].key] = otherKey;
    }
    return { keys: keys, remap: remap, truncated: truncated };
  }
  function pivotTakeAcc(map, key){
    var a = map[key];
    if (!a) { a = pivotEmptyAcc(); map[key] = a; }
    return a;
  }
  function pivotSep(){
    return String.fromCharCode(0);
  }
  function renderPivotHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var cfg = viewCfg(content);
    var rowSlug = pivotCfgSlug(cfg, ['rowFieldSlug', 'row_field', 'rowField']);
    var colSlug = pivotCfgSlug(cfg, ['colFieldSlug', 'col_field', 'colField']);
    var rowField = pivotFieldBySlug(cols, rowSlug);
    var colField = pivotFieldBySlug(cols, colSlug);
    if (!rowField || !colField) {
      return pivotEmptyHtml('Pick row and column fields', 'This report needs two different fields for rows and columns.');
    }
    var sameAxis = rowSlug === colSlug
      || (!!rowField.slug && rowField.slug === colField.slug)
      || (!!rowField.id && !!colField.id && rowField.id === colField.id);
    if (sameAxis) {
      return pivotEmptyHtml('Row and column must differ', 'Using the same field only fills the diagonal.');
    }
    var filtersOn = !!(content && content.filtersActive === true);
    if (!rows.length) {
      return pivotEmptyHtml(
        filtersOn ? 'No matching records' : 'No records yet',
        filtersOn ? 'No records match the filters on this view.' : 'There are no rows to show in this report.'
      );
    }
    var valueSlug = pivotCfgSlug(cfg, ['valueFieldSlug', 'value_field', 'valueField']);
    var valueField = valueSlug ? pivotFieldBySlug(cols, valueSlug) : null;
    var valueOk = !!(valueField && pivotIsValueType(valueField.field_type));
    var valueUnavailable = !!valueSlug && !valueOk;
    var hasValue = valueOk;
    var agg = pivotResolveAgg(cfg, hasValue);
    var ROW_CAP = 40;
    var COL_CAP = 20;
    var rowMeta = Object.create(null);
    var colMeta = Object.create(null);
    var cells = [];
    var ri, rj, ck;
    for (ri=0;ri<rows.length;ri++){
      var r = rows[ri];
      var yNum = hasValue ? pivotParseY(r, valueField.slug) : null;
      var weight = hasValue ? (yNum !== null ? Math.abs(yNum) : 0) : 1;
      var rowParts = pivotAxisParts(r, rowField);
      var colParts = pivotAxisParts(r, colField);
      for (rj=0;rj<rowParts.length;rj++){
        var rb = pivotBucket(rowParts[rj]);
        for (ck=0;ck<colParts.length;ck++){
          var cb = pivotBucket(colParts[ck]);
          cells.push({ rowKey: rb.key, colKey: cb.key, yNum: yNum });
          pivotBump(rowMeta, rb.key, rb.label, rb.empty, weight);
          pivotBump(colMeta, cb.key, cb.label, cb.empty, weight);
        }
      }
    }
    var rowsCap = pivotRank(rowMeta, ROW_CAP, '__other_row__', 'Other rows');
    var colsCap = pivotRank(colMeta, COL_CAP, '__other_col__', 'Other columns');
    var cellAcc = Object.create(null);
    var rowAcc = Object.create(null);
    var colAcc = Object.create(null);
    var grand = pivotEmptyAcc();
    var sepCh = pivotSep();
    var ci;
    for (ci=0;ci<cells.length;ci++){
      var cell = cells[ci];
      var rk = rowsCap.remap[cell.rowKey] || cell.rowKey;
      var ck2 = colsCap.remap[cell.colKey] || cell.colKey;
      var id = rk + sepCh + ck2;
      pivotFold(pivotTakeAcc(cellAcc, id), hasValue, cell.yNum, agg);
      pivotFold(pivotTakeAcc(rowAcc, rk), hasValue, cell.yNum, agg);
      pivotFold(pivotTakeAcc(colAcc, ck2), hasValue, cell.yNum, agg);
      pivotFold(grand, hasValue, cell.yNum, agg);
    }
    var matrix = Object.create(null);
    var idKey;
    for (idKey in cellAcc) {
      if (!Object.prototype.hasOwnProperty.call(cellAcc, idKey)) continue;
      var sep = idKey.indexOf(sepCh);
      if (sep < 0) continue;
      var mrk = idKey.slice(0, sep);
      var mck = idKey.slice(sep + 1);
      if (!matrix[mrk]) matrix[mrk] = Object.create(null);
      matrix[mrk][mck] = pivotFinish(cellAcc[idKey], agg, hasValue);
    }
    var sticky = 'position:sticky;left:0;z-index:1;background:#131519;white-space:nowrap;';
    var stickyHead = 'position:sticky;left:0;z-index:2;background:#1b1e24;white-space:nowrap;text-align:left;';
    var numStyle = 'text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;';
    var muted = 'color:#9aa1ab;';
    var italic = muted + 'font-style:italic;';
    var noteStyle = 'margin:8px 12px 0;font-size:11px;color:#fbbf24;';
    var notes = '';
    var loadCapped = !!(content && content.truncated === true) && !filtersOn;
    if (loadCapped) {
      var shown = rows.length.toLocaleString('en-US');
      var totalN = (typeof content.total === 'number' && isFinite(content.total)) ? content.total.toLocaleString('en-US') : '';
      notes += '<p style="' + noteStyle + '">Showing the first ' + shown
        + (totalN ? ' of ' + totalN : '') + ' records. Totals may be incomplete.</p>';
    }
    if (valueUnavailable) {
      notes += '<p style="' + noteStyle + '">The value field is missing or is not a number anymore. Showing a count of records instead.</p>';
    }
    if (rowsCap.truncated || colsCap.truncated) {
      notes += '<p style="' + noteStyle + '">'
        + (rowsCap.truncated ? 'Too many row values - categories with the fewest records were rolled into Other. ' : '')
        + (colsCap.truncated ? 'Too many column values - categories with the fewest records were rolled into Other.' : '')
        + '</p>';
    }
    var valueName = valueUnavailable
      ? 'records'
      : ((valueField && (valueField.name || valueField.slug)) || 'records');
    var caption = '<p class="hint" style="margin:8px 12px 4px">'
      + esc(pivotAggLabel(agg) + ' of ' + valueName)
      + ' · rows: ' + esc(rowField.name || rowField.slug)
      + ' · columns: ' + esc(colField.name || colField.slug)
      + '</p>';
    var head = '<th style="' + stickyHead + '">' + esc(rowField.name || rowField.slug) + '</th>';
    var hj;
    for (hj=0;hj<colsCap.keys.length;hj++){
      var hc = colsCap.keys[hj];
      var hStyle = numStyle + (hc.rolledUp ? italic : (hc.empty ? muted : ''));
      head += '<th style="' + hStyle + '">' + esc(hc.label) + '</th>';
    }
    head += '<th style="' + numStyle + 'font-weight:600">Total</th>';
    var body = '';
    var rr;
    for (rr=0;rr<rowsCap.keys.length;rr++){
      var pr = rowsCap.keys[rr];
      var rStyle = sticky + 'font-weight:500;' + (pr.rolledUp ? italic : (pr.empty ? muted : ''));
      var cellsHtml = '';
      var cc;
      for (cc=0;cc<colsCap.keys.length;cc++){
        var pc = colsCap.keys[cc];
        var n = 0;
        if (matrix[pr.key] && Object.prototype.hasOwnProperty.call(matrix[pr.key], pc.key)) {
          n = matrix[pr.key][pc.key];
        }
        cellsHtml += '<td style="' + numStyle + '">'
          + (n === 0 ? '<span class="cell-muted">-</span>' : esc(pivotFormatCell(n)))
          + '</td>';
      }
      var rowTotal = pivotFinish(rowAcc[pr.key], agg, hasValue);
      body += '<tr><td style="' + rStyle + '">' + esc(pr.label) + '</td>'
        + cellsHtml
        + '<td style="' + numStyle + 'font-weight:500">' + esc(pivotFormatCell(rowTotal)) + '</td></tr>';
    }
    var footBg = 'background:#16181d;';
    var foot = '<td style="' + sticky + footBg + 'font-weight:600">Total</td>';
    var fj;
    for (fj=0;fj<colsCap.keys.length;fj++){
      var fc = colsCap.keys[fj];
      foot += '<td style="' + numStyle + footBg + 'font-weight:600">' + esc(pivotFormatCell(pivotFinish(colAcc[fc.key], agg, hasValue))) + '</td>';
    }
    foot += '<td style="' + numStyle + footBg + 'font-weight:600">' + esc(pivotFormatCell(pivotFinish(grand, agg, hasValue))) + '</td>';
    return '<div class="card"><div class="pivot-wrap">' + notes + caption
      + '<table class="pivot-matrix" style="width:max-content;min-width:100%;font-size:12px"><thead style="background:#1b1e24"><tr>' + head + '</tr></thead><tbody>' + body + '</tbody>'
      + '<tfoot><tr>' + foot + '</tr></tfoot></table></div></div>';
  }
`
