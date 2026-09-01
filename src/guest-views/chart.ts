/**
 * Guest Chart read layout (public share / portal).
 *
 * Concatenate AFTER GUEST_RENDER_JS so later `function renderChartHtml` wins.
 * Parent already un-aliases chart to SVG bar / line / pie / donut at full
 * width (`.chart-wrap` / `.chart-svg`, theme `main` max-width:none). Do not
 * rewrite those shapes.
 *
 * Real gaps vs the in-app read-only Chart view:
 * - series_field / seriesFieldSlug: stacked bar and multi-series line
 *   (pie / donut still ignore series, same as desktop)
 * - empty copy is chart-specific ("No data to chart.") not the generic row empty
 * - pie / donut legend includes percent; stacked charts get a series legend
 *
 * Template-literal rule: no backticks, no ${ } in the embedded JS; double
 * backslashes in regex/string literals. Pure string -> string, no DOM.
 *
 * Overridden: renderChartHtml
 * New helpers (do not exist on parent): pickSeriesSlug, chartYNumber,
 * chartEmptyHtml, chartEmptyAcc, chartFoldY, chartFinishAgg,
 * isGuestSeriesFieldType, chartStackedData, renderStackedBarSvg,
 * renderMultiLineSvg, chartPieLegendHtml, chartSeriesLegendHtml,
 * chartTruncLabel
 */

export const GUEST_VIEW_CHART_JS = `
  function pickSeriesSlug(content){
    var cfg = viewCfg(content);
    var keys = ['seriesFieldSlug','seriesField','series_field'];
    var i, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  }
  function isGuestSeriesFieldType(t){
    t = String(t || '').toLowerCase();
    return t === 'select' || t === 'status';
  }
  function chartYNumber(row, slug){
    if (!slug) return null;
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var v = d[slug];
    if (typeof v === 'number' && isFinite(v)) return v;
    var s = rowCellText(row, slug).replace(/[^0-9.+-]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }
  function chartEmptyHtml(){
    return '<div class="card"><div class="empty">No data to chart.</div></div>';
  }
  function chartEmptyAcc(){
    return { sum: 0, count: 0, min: Infinity, max: -Infinity, recordCount: 0 };
  }
  function chartFoldY(acc, yNum, agg, hasY){
    acc.recordCount += 1;
    if (!hasY) {
      acc.sum += 1;
      acc.count += 1;
      if (1 < acc.min) acc.min = 1;
      if (1 > acc.max) acc.max = 1;
      return;
    }
    if (agg === 'count') {
      if (yNum !== null) acc.count += 1;
      return;
    }
    if (yNum === null) return;
    acc.sum += yNum;
    acc.count += 1;
    if (yNum < acc.min) acc.min = yNum;
    if (yNum > acc.max) acc.max = yNum;
  }
  function chartFinishAgg(acc, agg, hasY){
    if (!hasY) return acc.recordCount;
    if (agg === 'count') return acc.count;
    if (acc.count === 0) return 0;
    if (agg === 'sum') return acc.sum;
    if (agg === 'avg') return Math.round((acc.sum / acc.count) * 100) / 100;
    if (agg === 'min') return acc.min === Infinity ? 0 : acc.min;
    if (agg === 'max') return acc.max === -Infinity ? 0 : acc.max;
    return acc.sum;
  }
  function chartTruncLabel(k){
    k = typeof k === 'string' ? k : valueText(k, 0);
    return k.length > 14 ? capStr(k, 13) + '...' : capStr(k, 14);
  }
  function chartStackedData(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var xSlug = pickXSlug(content, cols);
    var ySlug = pickYSlug(content);
    var seriesSlug = pickSeriesSlug(content);
    var empty = { categories: [], series: [], matrix: Object.create(null) };
    var seriesField = null;
    var i;
    for (i=0;i<cols.length;i++){
      if (cols[i] && cols[i].slug === seriesSlug) { seriesField = cols[i]; break; }
    }
    if (!seriesSlug || !seriesField || !isGuestSeriesFieldType(seriesField.field_type)) return empty;
    var hasY = !!ySlug;
    var agg = pickYAgg(content, hasY);
    var seriesWeight = Object.create(null);
    var seriesLabel = Object.create(null);
    for (i=0;i<rows.length;i++){
      var r0 = rows[i];
      var ser0 = (seriesSlug ? rowCellText(r0, seriesSlug) : '').trim() || 'No value';
      var y0 = hasY ? chartYNumber(r0, ySlug) : null;
      var w0 = hasY ? (y0 !== null ? Math.abs(y0) : 0) : 1;
      if (!seriesWeight[ser0]) { seriesWeight[ser0] = 0; seriesLabel[ser0] = ser0; }
      seriesWeight[ser0] += w0;
    }
    var ranked = Object.keys(seriesWeight);
    ranked.sort(function(a, b){ return seriesWeight[b] - seriesWeight[a]; });
    var SERIES_CAP = 8;
    var truncatedSeries = ranked.length > SERIES_CAP;
    var keepN = truncatedSeries ? SERIES_CAP - 1 : ranked.length;
    var restSet = Object.create(null);
    var series = [];
    for (i=0;i<keepN;i++){
      series.push({ k: ranked[i], label: seriesLabel[ranked[i]] });
    }
    var otherKey = '__other_series__';
    if (truncatedSeries) {
      for (i=keepN;i<ranked.length;i++) restSet[ranked[i]] = 1;
      series.push({ k: otherKey, label: 'Other (' + (ranked.length - keepN) + ')' });
    }
    var catAcc = Object.create(null);
    var catOrder = [];
    var cells = Object.create(null);
    for (i=0;i<rows.length;i++){
      var r = rows[i];
      var cat = (xSlug ? rowCellText(r, xSlug) : '').trim() || 'No value';
      var ser = (seriesSlug ? rowCellText(r, seriesSlug) : '').trim() || 'No value';
      if (restSet[ser]) ser = otherKey;
      var yNum = hasY ? chartYNumber(r, ySlug) : null;
      if (!catAcc[cat]) { catAcc[cat] = chartEmptyAcc(); catOrder.push(cat); }
      chartFoldY(catAcc[cat], yNum, agg, hasY);
      if (!cells[cat]) cells[cat] = Object.create(null);
      if (!cells[cat][ser]) cells[cat][ser] = chartEmptyAcc();
      chartFoldY(cells[cat][ser], yNum, agg, hasY);
    }
    var categories = [];
    for (i=0;i<catOrder.length;i++){
      var ck = catOrder[i];
      var fv = chartFinishAgg(catAcc[ck], agg, hasY);
      if (!isFinite(fv)) fv = 0;
      categories.push({ k: ck, v: fv });
    }
    categories.sort(function(a, b){ return b.v - a.v; });
    var CAT_CAP = 12;
    var matrix = Object.create(null);
    var outCats = [];
    var otherCat = null;
    var otherRow = Object.create(null);
    for (i=0;i<categories.length;i++){
      var item = categories[i];
      var row = Object.create(null);
      var src = cells[item.k] || Object.create(null);
      var si;
      for (si=0;si<series.length;si++){
        var acc = src[series[si].k];
        row[series[si].k] = acc ? chartFinishAgg(acc, agg, hasY) : 0;
      }
      if (outCats.length >= CAT_CAP) {
        if (!otherCat) otherCat = { k: 'Other', v: 0 };
        otherCat.v += item.v;
        for (si=0;si<series.length;si++){
          var skey = series[si].k;
          otherRow[skey] = (otherRow[skey] || 0) + (row[skey] || 0);
        }
        continue;
      }
      matrix[item.k] = row;
      outCats.push(item);
    }
    if (otherCat) {
      otherCat.v = Math.round(otherCat.v * 100) / 100;
      matrix[otherCat.k] = otherRow;
      outCats.push(otherCat);
    }
    return { categories: outCats, series: series, matrix: matrix };
  }
  function renderStackedBarSvg(categories, series, matrix, agg){
    var fills = chartFills();
    var additive = agg === 'sum' || agg === 'count';
    var max = 0;
    var i, si, row, tot, sv;
    for (i=0;i<categories.length;i++){
      row = matrix[categories[i].k] || {};
      if (additive) {
        tot = 0;
        for (si=0;si<series.length;si++) tot += row[series[si].k] || 0;
        if (tot > max) max = tot;
      } else {
        if (categories[i].v > max) max = categories[i].v;
        for (si=0;si<series.length;si++) {
          sv = row[series[si].k] || 0;
          if (sv > max) max = sv;
        }
      }
    }
    if (max <= 0) max = 1;
    var w = 960, h = 320, padL = 36, padB = 56, padT = 28, padR = 16;
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var n = Math.max(categories.length, 1);
    var slot = innerW / n;
    var groupW = Math.max(10, slot * 0.62);
    var barW = additive ? groupW : Math.max(4, (groupW - (series.length - 1) * 2) / Math.max(series.length, 1));
    var parts = [];
    for (i=0;i<categories.length;i++){
      var slotX = padL + i * slot + (slot - groupW) / 2;
      row = matrix[categories[i].k] || {};
      var accH = 0;
      var labelVal = categories[i].v;
      var cx = slotX + groupW / 2;
      for (si=0;si<series.length;si++){
        var v = row[series[si].k] || 0;
        if (v <= 0 && additive) continue;
        var bh = (Math.max(v, 0) / max) * innerH;
        var x, y;
        if (additive) {
          x = slotX;
          y = padT + innerH - accH - bh;
          accH += bh;
        } else {
          x = slotX + si * (barW + 2);
          y = padT + innerH - bh;
        }
        parts.push('<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + Math.max(bh, v === 0 ? 0 : 1) + '" rx="5" fill="' + fills[si % fills.length] + '"/>');
      }
      parts.push('<text x="' + cx + '" y="' + (padT + innerH - (Math.max(labelVal, 0) / max) * innerH - 6) + '" text-anchor="middle" fill="#e7e9ee" font-size="11">' + esc(String(labelVal)) + '</text>');
      parts.push('<text x="' + cx + '" y="' + (h - 18) + '" text-anchor="middle" fill="#9aa1ab" font-size="11">' + esc(chartTruncLabel(categories[i].k)) + '</text>');
    }
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">' + parts.join('') + '</svg>';
  }
  function renderMultiLineSvg(categories, series, matrix){
    var fills = chartFills();
    var max = 0;
    var i, si, row, sv;
    for (i=0;i<categories.length;i++){
      row = matrix[categories[i].k] || {};
      for (si=0;si<series.length;si++){
        sv = row[series[si].k] || 0;
        if (sv > max) max = sv;
      }
    }
    if (max <= 0) max = 1;
    var w = 960, h = 320, padL = 36, padB = 56, padT = 28, padR = 16;
    var innerW = w - padL - padR;
    var innerH = h - padT - padB;
    var stepN = Math.max(categories.length - 1, 1);
    var parts = [];
    for (si=0;si<series.length;si++){
      var pts = [];
      var dots = [];
      for (i=0;i<categories.length;i++){
        var v = (matrix[categories[i].k] && matrix[categories[i].k][series[si].k]) || 0;
        var x = padL + (categories.length === 1 ? innerW / 2 : (i / stepN) * innerW);
        var y = padT + innerH - (Math.max(v, 0) / max) * innerH;
        pts.push(x + ',' + y);
        dots.push('<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + fills[si % fills.length] + '"/>');
      }
      parts.push('<polyline fill="none" stroke="' + fills[si % fills.length] + '" stroke-width="2.5" points="' + pts.join(' ') + '"/>');
      parts.push(dots.join(''));
    }
    for (i=0;i<categories.length;i++){
      var lx = padL + (categories.length === 1 ? innerW / 2 : (i / stepN) * innerW);
      parts.push('<text x="' + lx + '" y="' + (h - 18) + '" text-anchor="middle" fill="#9aa1ab" font-size="11">' + esc(chartTruncLabel(categories[i].k)) + '</text>');
    }
    return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">' + parts.join('') + '</svg>';
  }
  function chartPieLegendHtml(buckets){
    var fills = chartFills();
    var total = 0;
    var i;
    for (i=0;i<buckets.length;i++) total += Math.max(0, buckets[i].v);
    if (total <= 0) total = 1;
    var items = '';
    for (i=0;i<buckets.length;i++){
      var pct = Math.round((Math.max(0, buckets[i].v) / total) * 100);
      items += '<span class="chart-legend-i"><span class="chart-swatch" style="background:' + fills[i % fills.length] + '"></span>'
        + esc(buckets[i].k) + ' (' + esc(String(buckets[i].v)) + ', ' + pct + '%)</span>';
    }
    return items ? '<div class="chart-legend">' + items + '</div>' : '';
  }
  function chartSeriesLegendHtml(series){
    var fills = chartFills();
    var items = '';
    var i;
    for (i=0;i<series.length;i++){
      items += '<span class="chart-legend-i"><span class="chart-swatch" style="background:' + fills[i % fills.length] + '"></span>'
        + esc(series[i].label) + '</span>';
    }
    return items ? '<div class="chart-legend">' + items + '</div>' : '';
  }
  function renderChartHtml(content){
    var kind = pickChartType(content);
    var stacked = (kind === 'bar' || kind === 'line') ? chartStackedData(content) : null;
    if (stacked && stacked.series.length && stacked.categories.length) {
      var stackedSvg = kind === 'line'
        ? renderMultiLineSvg(stacked.categories, stacked.series, stacked.matrix)
        : renderStackedBarSvg(stacked.categories, stacked.series, stacked.matrix, pickYAgg(content, !!pickYSlug(content)));
      return '<div class="chart-wrap chart-' + kind + '">' + stackedSvg + chartSeriesLegendHtml(stacked.series) + '</div>';
    }
    var buckets = chartBuckets(content);
    if (!buckets.length) return chartEmptyHtml();
    if (kind === 'pie' || kind === 'donut') {
      var pieTotal = 0;
      var pi;
      for (pi=0;pi<buckets.length;pi++) pieTotal += Math.max(0, buckets[pi].v);
      if (pieTotal <= 0) return chartEmptyHtml();
    }
    var svg = kind === 'pie' ? renderPieSvg(buckets, false)
      : kind === 'donut' ? renderPieSvg(buckets, true)
      : kind === 'line' ? renderLineSvg(buckets)
      : renderBarSvg(buckets);
    var legend = (kind === 'pie' || kind === 'donut') ? chartPieLegendHtml(buckets) : chartLegendHtml(buckets);
    return '<div class="chart-wrap chart-' + kind + '">' + svg + legend + '</div>';
  }
`
