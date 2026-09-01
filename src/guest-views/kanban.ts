/**
 * Guest Kanban read layout (public share / portal).
 *
 * Concatenate AFTER GUEST_RENDER_JS so this can wrap `renderBoardHtml`.
 * Do not redeclare `renderBoardHtml` (that would steal scrum / pipeline /
 * board). Do not wrap `renderReadBodyHtml` (date_bucket owns that wrap).
 *
 * Parent `canonicalViewType` maps `kanban` / `kanban_board` to `board`, so
 * `renderReadBodyHtml` already calls `renderBoardHtml`. That paints `.board`
 * > `.lane` > `.lane-head` + `.board-card`. This overlay keeps that chrome
 * and closes the read-only gaps vs apps/desktop/src/components/views/kanban-view.tsx
 * that the payload can support:
 * - columns from field `config.options` (order preserved, empty stages shown)
 * - unknown values after options; `Uncategorized` always last
 * - multiselect fan-out (one card per chosen column)
 * - bound `groupByFieldSlug` must be select/status/multiselect; else auto
 *   status then select (never a random text field, never auto-multiselect)
 * - option label aliases onto the value key so display-first cells still
 *   land in the option column; lane head uses the option label
 *
 * Gaps vs kanban-view.tsx that this leaf cannot close (payload / read-only):
 * - Drag, add-in-column, column collapse, per-column scroll-to-load-more
 * - Swimlanes, WIP limits, stale badges, color_rules, column sums (those
 *   bindings are not on PublicSharePayloadViewConfig)
 * - cardFields extras (not stamped); Settings maxExtraFields (guest uses 2)
 * - Comment-count badges; rich-card cover / media / description chrome
 * - Empty-column "drag cards here" copy (edit language)
 * - Named lanes past 40 fold into Other; options walk caps at 80
 * - Column accent is a hex border only (no hue fill); rgb() option colors skipped
 * - Multiselect chip fan-out inherits chipItems cap 24
 *
 * Template-literal rule: no backticks, no ${ } in the embedded source;
 * double backslashes in regex/string literals. Pure string -> string, no DOM.
 *
 * Overridden (wrap): renderBoardHtml when viewType is kanban / kanban_board
 * New helpers: guestKanbanIsKanbanType, guestKanbanChoiceKey,
 * guestKanbanOptionColor, guestKanbanOptionLabel, guestKanbanFieldBySlug,
 * guestKanbanIsGroupType, guestKanbanGroupSlug, guestKanbanReadOptions,
 * guestKanbanResolveKey, guestKanbanLaneKeys, guestKanbanSkipExtra,
 * guestKanbanEmptyFieldHtml, guestKanbanCardHtml, renderKanbanHtml
 */
export const GUEST_VIEW_KANBAN_JS = `
  var GUEST_KANBAN_UNCATEGORIZED = 'Uncategorized';
  var GUEST_KANBAN_OTHER = 'Other';
  var GUEST_KANBAN_LANES_MAX = 40;
  var GUEST_KANBAN_OPTIONS_MAX = 80;
  var GUEST_KANBAN_CARD_EXTRAS = 2;
  var GUEST_KANBAN_KEY_MAX = 200;
  function guestKanbanIsKanbanType(vt){
    var t = (typeof vt === 'string' ? vt : '').trim().toLowerCase().replace(/[\\s-]+/g, '_');
    return t === 'kanban' || t === 'kanban_board';
  }
  function guestKanbanCapKey(s){
    s = typeof s === 'string' || typeof s === 'number' || typeof s === 'boolean' ? String(s) : valueText(s, 0);
    if (s.length <= GUEST_KANBAN_KEY_MAX) return capStr(s, GUEST_KANBAN_KEY_MAX);
    return capStr(s, GUEST_KANBAN_KEY_MAX - 3) + '...';
  }
  function guestKanbanChoiceKey(raw, depth){
    depth = depth || 0;
    if (raw == null || raw === '' || depth > 2) return '';
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      var rec = raw;
      var v = rec.value;
      if (typeof v === 'string' && v.trim()) return guestKanbanCapKey(v.trim());
      v = rec.label;
      if (typeof v === 'string' && v.trim()) return guestKanbanCapKey(v.trim());
      v = rec.name;
      if (typeof v === 'string' && v.trim()) return guestKanbanCapKey(v.trim());
      return '';
    }
    if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return '';
      if ((t.charAt(0) === '{' || t.charAt(0) === '[') && t.length > 1 && t.length <= 4000) {
        try { return guestKanbanChoiceKey(JSON.parse(t), depth + 1); }
        catch (err) { return guestKanbanCapKey(t); }
      }
      return guestKanbanCapKey(t);
    }
    if (typeof raw === 'number' && isFinite(raw)) return String(raw);
    if (typeof raw === 'boolean') return String(raw);
    return '';
  }
  function guestKanbanOptionColor(raw){
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
    var c = raw.color;
    if (typeof c === 'string' && isHexColor(c)) return c.trim();
    return '';
  }
  function guestKanbanFieldBySlug(cols, slug){
    if (!slug) return null;
    var i, f;
    for (i = 0; i < cols.length; i++) {
      f = cols[i];
      if (f && f.slug === slug) return f;
    }
    return null;
  }
  function guestKanbanIsGroupType(t){
    t = String(t || '').toLowerCase();
    return t === 'select' || t === 'status' || t === 'multiselect';
  }
  function guestKanbanGroupSlug(content, cols){
    var cfg = viewCfg(content);
    var keys = ['groupByFieldSlug', 'kanban_field', 'kanbanField'];
    var i, s, f;
    for (i = 0; i < keys.length; i++) {
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s.trim()) continue;
      s = capStr(s.trim(), 128);
      f = guestKanbanFieldBySlug(cols, s);
      if (f && guestKanbanIsGroupType(f.field_type)) return s;
      return '';
    }
    for (i = 0; i < cols.length; i++) {
      if (String(cols[i].field_type || '').toLowerCase() === 'status') return cols[i].slug;
    }
    for (i = 0; i < cols.length; i++) {
      if (String(cols[i].field_type || '').toLowerCase() === 'select') return cols[i].slug;
    }
    return '';
  }
  function guestKanbanOptionLabel(raw){
    if (raw == null || raw === '') return '';
    if (typeof raw === 'string') return guestKanbanCapKey(raw.trim());
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      var lab = raw.label;
      if (typeof lab === 'string' && lab.trim()) return guestKanbanCapKey(lab.trim());
      lab = raw.name;
      if (typeof lab === 'string' && lab.trim()) return guestKanbanCapKey(lab.trim());
    }
    return guestKanbanChoiceKey(raw, 0);
  }
  function guestKanbanReadOptions(field){
    var cfg = field && field.config && typeof field.config === 'object' && !Array.isArray(field.config) ? field.config : {};
    var raw = cfg.options;
    var keys = [];
    var colors = Object.create(null);
    var labels = Object.create(null);
    var alias = Object.create(null);
    var seen = Object.create(null);
    if (!Array.isArray(raw)) return { keys: keys, colors: colors, labels: labels, alias: alias };
    var i, key, lab, col;
    for (i = 0; i < raw.length && i < GUEST_KANBAN_OPTIONS_MAX; i++) {
      key = guestKanbanChoiceKey(raw[i], 0);
      if (!key || Object.prototype.hasOwnProperty.call(seen, key)) continue;
      seen[key] = true;
      keys.push(key);
      lab = guestKanbanOptionLabel(raw[i]) || key;
      labels[key] = lab;
      alias[key] = key;
      if (lab) alias[lab] = key;
      col = guestKanbanOptionColor(raw[i]);
      if (col) colors[key] = col;
    }
    return { keys: keys, colors: colors, labels: labels, alias: alias };
  }
  function guestKanbanResolveKey(text, alias){
    if (!text) return text;
    if (alias && Object.prototype.hasOwnProperty.call(alias, text)) return alias[text];
    return text;
  }
  function guestKanbanLaneKeys(row, slug, isMulti, alias){
    if (isMulti) {
      var items = chipItems(row, slug);
      if (!items.length) return [GUEST_KANBAN_UNCATEGORIZED];
      var out = [];
      var seen = Object.create(null);
      var i, k;
      for (i = 0; i < items.length; i++) {
        k = guestKanbanResolveKey(guestKanbanCapKey(typeof items[i] === 'string' ? items[i].trim() : valueText(items[i], 0)), alias);
        if (!k || Object.prototype.hasOwnProperty.call(seen, k)) continue;
        seen[k] = true;
        out.push(k);
      }
      return out.length ? out : [GUEST_KANBAN_UNCATEGORIZED];
    }
    var t = rowCellText(row, slug).trim();
    if (!t) return [GUEST_KANBAN_UNCATEGORIZED];
    return [guestKanbanResolveKey(guestKanbanCapKey(t), alias)];
  }
  function guestKanbanSkipExtra(c, titleSlug, groupSlug, imgSlug, descSlug){
    var slug = c && c.slug;
    if (!slug) return true;
    if (slug === titleSlug || slug === groupSlug || slug === imgSlug || slug === descSlug) return true;
    var t = String(c.field_type || '').toLowerCase();
    return t === 'image' || t === 'file' || t === 'rich_text';
  }
  function guestKanbanEmptyFieldHtml(){
    return '<div class="card"><div class="empty">No board field<div class="muted" style="margin-top:8px">This page needs a status or select field to show columns.</div></div></div>';
  }
  function guestKanbanCardHtml(r, cols, titleSlug, groupSlug, imgSlug, descSlug){
    var extra = '';
    var shown = 0;
    var i, c, val;
    for (i = 0; i < cols.length && shown < GUEST_KANBAN_CARD_EXTRAS; i++) {
      c = cols[i];
      if (guestKanbanSkipExtra(c, titleSlug, groupSlug, imgSlug, descSlug)) continue;
      val = cellHtml(c, r);
      if (val === '') continue;
      extra += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">' + val + '</div></div>';
      shown++;
    }
    return '<div class="board-card">' + rowTitleHtml(r, titleSlug) + extra + '</div>';
  }
  function renderKanbanHtml(content){
    var cols = visibleFields(content);
    if (!cols.length) return emptyStateHtml();
    var groupSlug = guestKanbanGroupSlug(content, cols);
    if (!groupSlug) return guestKanbanEmptyFieldHtml();
    var groupField = guestKanbanFieldBySlug(cols, groupSlug);
    var isMulti = groupField && String(groupField.field_type || '').toLowerCase() === 'multiselect';
    var titleSlug = titleSlugOf(content, cols);
    var cfg = viewCfg(content);
    var imgSlug = typeof cfg.imageFieldSlug === 'string' ? cfg.imageFieldSlug : '';
    var descSlug = typeof cfg.descriptionFieldSlug === 'string' && cfg.descriptionFieldSlug
      ? cfg.descriptionFieldSlug
      : (typeof cfg.description_field === 'string' ? cfg.description_field : '');
    var opt = guestKanbanReadOptions(groupField);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var lanes = Object.create(null);
    var laneOrder = [];
    var named = 0;
    function ensureLane(key){
      if (Object.prototype.hasOwnProperty.call(lanes, key)) return key;
      if (key !== GUEST_KANBAN_UNCATEGORIZED && key !== GUEST_KANBAN_OTHER && named >= GUEST_KANBAN_LANES_MAX) {
        key = GUEST_KANBAN_OTHER;
        if (Object.prototype.hasOwnProperty.call(lanes, key)) return key;
      }
      lanes[key] = [];
      if (key !== GUEST_KANBAN_UNCATEGORIZED && key !== GUEST_KANBAN_OTHER) named += 1;
      laneOrder.push(key);
      return key;
    }
    var oi;
    for (oi = 0; oi < opt.keys.length; oi++) ensureLane(opt.keys[oi]);
    var ri, keys, ki, key, list, id, dup, di;
    for (ri = 0; ri < rows.length; ri++) {
      keys = guestKanbanLaneKeys(rows[ri], groupSlug, isMulti, opt.alias);
      for (ki = 0; ki < keys.length; ki++) {
        key = ensureLane(keys[ki]);
        list = lanes[key];
        id = rowIdOf(rows[ri]);
        dup = false;
        if (id) {
          for (di = 0; di < list.length; di++) {
            if (rowIdOf(list[di]) === id) { dup = true; break; }
          }
        }
        if (!dup) list.push(rows[ri]);
      }
    }
    ensureLane(GUEST_KANBAN_UNCATEGORIZED);
    var ordered = [];
    var hasOther = false;
    var hasUncat = false;
    var li, k;
    for (li = 0; li < laneOrder.length; li++) {
      k = laneOrder[li];
      if (k === GUEST_KANBAN_UNCATEGORIZED) hasUncat = true;
      else if (k === GUEST_KANBAN_OTHER) hasOther = true;
      else ordered.push(k);
    }
    if (hasOther) ordered.push(GUEST_KANBAN_OTHER);
    if (hasUncat) ordered.push(GUEST_KANBAN_UNCATEGORIZED);
    var notes = '';
    if (isMulti) {
      notes += '<p class="hint">Each card can appear in more than one column.</p>';
    }
    if (content && content.truncated === true) {
      notes += '<p class="hint">This page shows a capped set of records.</p>';
    }
    var html = notes + '<div class="board" data-guest-kanban="1">';
    for (li = 0; li < ordered.length; li++) {
      k = ordered[li];
      list = lanes[k] || [];
      var cards = '';
      var ci;
      for (ci = 0; ci < list.length; ci++) {
        cards += guestKanbanCardHtml(list[ci], cols, titleSlug, groupSlug, imgSlug, descSlug);
      }
      var st = opt.colors[k] ? ' style="border-color:' + esc(opt.colors[k]) + '"' : '';
      var head = (opt.labels && opt.labels[k]) ? opt.labels[k] : k;
      html += '<div class="lane"' + st + '><div class="lane-head"><span>' + esc(head) + '</span><span class="lane-count">' + String(list.length) + '</span></div>' + cards + '</div>';
    }
    return html + '</div>';
  }
  if (typeof renderBoardHtml === 'function') {
    var _guestKanbanParentBoardHtml = renderBoardHtml;
    renderBoardHtml = function(content){
      if (guestKanbanIsKanbanType(content && content.viewType)) return renderKanbanHtml(content);
      return _guestKanbanParentBoardHtml(content);
    };
  }
`
