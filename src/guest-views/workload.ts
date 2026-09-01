/**
 * Guest Workload (team capacity board) override.
 *
 * Concatenated AFTER GUEST_RENDER_CORE_JS so this renderWorkloadHtml wins.
 * Parent already paints .board.workload lanes + .wl-bar. Parent pickUserSlug
 * falls through to pickGroupSlug (first select/status) when no person field
 * is configured. This overlay never does that.
 *
 * Read-only vs apps/desktop workload-view.tsx:
 * - Group only by a user/people/person or relation (link) field
 * - Configured slug of the wrong type fails closed (empty), never status
 * - No stamp: first people/user/relation on the schema, never groupByFieldSlug
 * - Multi-assignee fan-out, Unassigned always last, capacity + overload on
 *   person lanes only, dual-key assignee slug, up to 3 card meta rows,
 *   truncated-row banner from payload truncated/total
 *
 * Overridden: renderWorkloadHtml
 * New helpers: isWorkloadAssigneeType, workloadAllFields, workloadFieldBySlug,
 * pickWorkloadAssigneeSlug, pickWorkloadTitleSlug, readGuestWorkloadCapacity,
 * workloadCapStr, workloadRefFromUnknown, extractWorkloadRefs, workloadCellRaw,
 * workloadTruncNote
 *
 * Embedded JS: no backticks, no dollar-brace interpolations. Depends on esc /
 * viewCfg / visibleFields / rowCellText / cellHtml / rowTitleHtml /
 * emptyStateHtml / bestObjectText already in scope from GUEST_RENDER_CORE_JS.
 *
 * Leftover vs desktop (cannot close in this leaf):
 * - Roster-seeded empty people lanes (no agents / relation roster on payload)
 * - Drag-assign, in-flight drop lock, optimistic move, click-after-drag
 * - Column collapse, rich-card cover/comments/buttons
 * - viewConfig.capacity is read here but PublicSharePayloadViewConfig may
 *   omit it, so overload stays off until the payload stamps capacity
 * - Display-only joined strings stay one lane when data has no refs
 * - Empty-state copy cannot send the visitor to Customize
 */
export const GUEST_VIEW_WORKLOAD_JS = `
  var WORKLOAD_UNASSIGNED_KEY = '__unassigned__';
  var WORKLOAD_LANE_CAP = 500;
  var WORKLOAD_REFS_CAP = 64;
  var WORKLOAD_ID_MAX = 128;
  var WORKLOAD_LABEL_MAX = 256;
  var WORKLOAD_JSON_MAX = 64000;
  var WORKLOAD_CAPACITY_MIN = 1;
  var WORKLOAD_CAPACITY_MAX = 999;
  function isWorkloadAssigneeType(ft){
    var t = String(ft || '').trim().toLowerCase();
    return t === 'user' || t === 'people' || t === 'person' || t === 'relation';
  }
  function workloadAllFields(content, cols){
    var fields = Array.isArray(content && content.fields) ? content.fields : [];
    var out = [];
    var i;
    for (i = 0; i < fields.length; i++) {
      if (fields[i] && typeof fields[i].slug === 'string' && fields[i].slug) out.push(fields[i]);
    }
    return out.length ? out : cols;
  }
  function workloadFieldBySlug(fields, slug){
    if (!slug) return null;
    var i, f, id;
    for (i = 0; i < fields.length; i++) {
      f = fields[i];
      if (f.slug === slug) return f;
      id = f.id;
      if (typeof id === 'string' && id === slug) return f;
    }
    return null;
  }
  function pickWorkloadAssigneeSlug(content, cols){
    var cfg = viewCfg(content);
    var fields = workloadAllFields(content, cols);
    var keys = ['assigneeFieldSlug', 'assignee_field', 'assigneeField'];
    var i, s, found;
    for (i = 0; i < keys.length; i++) {
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s.trim()) continue;
      s = s.trim();
      found = workloadFieldBySlug(fields, s);
      if (found) return isWorkloadAssigneeType(found.field_type) ? (found.slug || s) : '';
      return '';
    }
    for (i = 0; i < fields.length; i++) {
      if (isWorkloadAssigneeType(fields[i].field_type)) return fields[i].slug;
    }
    return '';
  }
  function pickWorkloadTitleSlug(content, cols, groupSlug){
    var cfg = viewCfg(content);
    var fields = workloadAllFields(content, cols);
    var keys = ['titleFieldSlug', 'title_field', 'titleField'];
    var i, s, found, slug, t;
    for (i = 0; i < keys.length; i++) {
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s.trim()) continue;
      s = s.trim();
      found = workloadFieldBySlug(fields, s);
      if (found) return found.slug;
      return s;
    }
    for (i = 0; i < fields.length; i++) {
      slug = String(fields[i].slug || '').trim().toLowerCase();
      if (slug === 'name' || slug === 'title') return fields[i].slug;
    }
    for (i = 0; i < fields.length; i++) {
      t = String(fields[i].field_type || '').toLowerCase();
      if (t === 'text' || t === 'rich_text') return fields[i].slug;
    }
    for (i = 0; i < cols.length; i++) {
      if (cols[i].slug !== groupSlug) return cols[i].slug;
    }
    return cols.length ? cols[0].slug : '';
  }
  function readGuestWorkloadCapacity(content){
    var cfg = viewCfg(content);
    var raw = Object.prototype.hasOwnProperty.call(cfg, 'capacity') ? cfg.capacity : undefined;
    var n;
    if (typeof raw === 'number') {
      if (!isFinite(raw)) return null;
      n = Math.floor(raw);
    } else if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return null;
      n = Math.floor(Number(t));
      if (!isFinite(n)) return null;
    } else {
      return null;
    }
    if (n < WORKLOAD_CAPACITY_MIN || n > WORKLOAD_CAPACITY_MAX) return null;
    return n;
  }
  function workloadCapStr(s, max){
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
  function workloadRefFromUnknown(value){
    if (value == null || value === '') return null;
    var t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') {
      var s = String(value).trim();
      if (!s) return null;
      var sid = workloadCapStr(s, WORKLOAD_ID_MAX);
      return { id: sid, label: sid };
    }
    if (t === 'object' && !Array.isArray(value)) {
      var rec = value;
      var id = '';
      if (typeof rec.id === 'string' && rec.id.trim()) id = workloadCapStr(rec.id.trim(), WORKLOAD_ID_MAX);
      else if (typeof rec.value === 'string' && rec.value.trim()) id = workloadCapStr(rec.value.trim(), WORKLOAD_ID_MAX);
      else {
        var choice = bestObjectText(rec);
        if (choice) id = workloadCapStr(String(choice).trim(), WORKLOAD_ID_MAX);
      }
      if (!id) return null;
      var label = id;
      if (typeof rec.label === 'string' && rec.label.trim()) label = workloadCapStr(rec.label.trim(), WORKLOAD_LABEL_MAX);
      else if (typeof rec.name === 'string' && rec.name.trim()) label = workloadCapStr(rec.name.trim(), WORKLOAD_LABEL_MAX);
      else if (typeof rec.title === 'string' && rec.title.trim()) label = workloadCapStr(rec.title.trim(), WORKLOAD_LABEL_MAX);
      return { id: id, label: label };
    }
    return null;
  }
  function extractWorkloadRefs(raw){
    if (raw == null || raw === '') return [];
    if (Array.isArray(raw)) {
      var out = [];
      var seen = Object.create(null);
      var i, ref;
      for (i = 0; i < raw.length && out.length < WORKLOAD_REFS_CAP; i++) {
        ref = workloadRefFromUnknown(raw[i]);
        if (!ref || seen[ref.id]) continue;
        seen[ref.id] = 1;
        out.push(ref);
      }
      return out;
    }
    if (typeof raw === 'string') {
      var t = raw.trim();
      if ((t.charAt(0) === '[' || t.charAt(0) === '{') && t.length < WORKLOAD_JSON_MAX) {
        try { return extractWorkloadRefs(JSON.parse(t)); }
        catch (err) { /* scalar string, not JSON */ }
      }
    }
    var one = workloadRefFromUnknown(raw);
    return one ? [one] : [];
  }
  function workloadCellRaw(row, slug, field){
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (slug && Object.prototype.hasOwnProperty.call(d, slug)) return d[slug];
    var id = field && typeof field.id === 'string' ? field.id : '';
    if (id && Object.prototype.hasOwnProperty.call(d, id)) return d[id];
    return undefined;
  }
  function workloadTruncNote(content, n){
    if (!content || content.truncated !== true) return '';
    var msg = 'Showing the first ' + String(n) + ' records';
    var total = content.total;
    if (typeof total === 'number' && isFinite(total) && total > n) {
      msg += ' of ' + String(Math.floor(total));
    }
    msg += '. Counts may be incomplete.';
    return '<p class="hint" style="margin:0 0 8px">' + esc(msg) + '</p>';
  }
  function renderWorkloadHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length) return emptyStateHtml();
    var fields = workloadAllFields(content, cols);
    var groupSlug = pickWorkloadAssigneeSlug(content, cols);
    if (!groupSlug) {
      return '<div class="card"><div class="empty">This board has no person field. The owner needs to choose a person or link field for this layout.</div></div>';
    }
    var assigneeField = workloadFieldBySlug(fields, groupSlug);
    if (!assigneeField || !isWorkloadAssigneeType(assigneeField.field_type)) {
      return '<div class="card"><div class="empty">This board has no person field. The owner needs to choose a person or link field for this layout.</div></div>';
    }
    if (!rows.length) return emptyStateHtml();
    var titleSlug = pickWorkloadTitleSlug(content, cols, groupSlug);
    var capacity = readGuestWorkloadCapacity(content);
    var i;
    var lanes = Object.create(null);
    var labels = Object.create(null);
    labels[WORKLOAD_UNASSIGNED_KEY] = 'Unassigned';
    lanes[WORKLOAD_UNASSIGNED_KEY] = [];
    rows.forEach(function(r){
      var refs = extractWorkloadRefs(workloadCellRaw(r, groupSlug, assigneeField));
      if (!refs.length) {
        var txt = rowCellText(r, groupSlug).trim();
        if (txt) refs = [{ id: txt, label: txt }];
      }
      var keys = refs.length ? refs : [{ id: WORKLOAD_UNASSIGNED_KEY, label: 'Unassigned' }];
      var k;
      for (k = 0; k < keys.length; k++) {
        var id = keys[k].id;
        var lab = keys[k].label;
        if (!id) continue;
        if (id !== WORKLOAD_UNASSIGNED_KEY && (!labels[id] || (lab && lab !== id))) labels[id] = lab || id;
        if (!lanes[id]) lanes[id] = [];
        lanes[id].push(r);
      }
    });
    var personKeys = [];
    for (var pk in lanes) {
      if (!Object.prototype.hasOwnProperty.call(lanes, pk)) continue;
      if (pk !== WORKLOAD_UNASSIGNED_KEY) personKeys.push(pk);
    }
    personKeys.sort(function(a, b){
      return String(labels[a] || a).localeCompare(String(labels[b] || b), 'en-US', { sensitivity: 'base' });
    });
    var lanesTrunc = false;
    if (personKeys.length > WORKLOAD_LANE_CAP) {
      personKeys = personKeys.slice(0, WORKLOAD_LANE_CAP);
      lanesTrunc = true;
    }
    var order = personKeys.concat([WORKLOAD_UNASSIGNED_KEY]);
    var maxN = 1;
    for (i = 0; i < order.length; i++) {
      var ln = lanes[order[i]] ? lanes[order[i]].length : 0;
      if (ln > maxN) maxN = ln;
    }
    var note = workloadTruncNote(content, rows.length);
    if (lanesTrunc) {
      note += '<p class="hint" style="margin:0 0 8px">' + esc('Some people lanes are not shown.') + '</p>';
    }
    return note + '<div class="board workload">' + order.map(function(k){
      var list = lanes[k] || [];
      var n = list.length;
      var isUn = k === WORKLOAD_UNASSIGNED_KEY;
      var overloaded = !isUn && capacity !== null && n > capacity;
      var denom = (!isUn && capacity !== null) ? capacity : maxN;
      var pct = denom > 0 ? Math.round((n / denom) * 100) : 0;
      if (pct > 100) pct = 100;
      var countLabel = (!isUn && capacity !== null) ? (String(n) + '/' + String(capacity)) : String(n);
      var barStyle = 'width:' + pct + '%';
      if (overloaded) barStyle += ';background:#f59e0b';
      var laneStyle = overloaded ? ' style="border-color:#f59e0b"' : '';
      var cards = list.map(function(r){
        var extra = '';
        var shown = 0;
        var ci, c, ft, val;
        for (ci = 0; ci < cols.length && shown < 3; ci++) {
          c = cols[ci];
          if (c.slug === titleSlug || c.slug === groupSlug) continue;
          ft = String(c.field_type || '').toLowerCase();
          if (ft === 'image' || ft === 'file' || ft === 'media' || ft === 'cover' || ft === 'long_text' || ft === 'rich_text' || ft === 'notes') continue;
          val = cellHtml(c, r);
          if (val === '') continue;
          extra += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
          shown++;
        }
        return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + extra + '</div>';
      }).join('');
      return '<div class="lane"' + laneStyle + '><div class="lane-head"><span>' + esc(labels[k] || k) + '</span><span class="lane-count">' + esc(countLabel) + '</span></div>'
        + '<div class="wl-track"><div class="wl-bar" style="' + barStyle + '"></div></div>' + cards + '</div>';
    }).join('') + '</div>';
  }
`
