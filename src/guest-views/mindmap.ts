/**
 * Guest Mind map read layout (public share / portal).
 *
 * Concatenate after GUEST_RENDER_JS so this can wrap `renderReadBodyHtml`.
 * Parent already reuses tree nesting for `viewType === 'mindmap'`:
 * `renderReadBodyHtml` calls `renderTreeHtml` (`simplified: false`).
 * The tree overlay (earlier in this concat) owns `renderTreeHtml` - do not
 * declare a second copy here. This leaf prepares rows to match desktop
 * mindmap-view.tsx READ-ONLY parent/title/cap/honesty, then calls that
 * shared `renderTreeHtml`.
 *
 * Guest pages are pure string -> string HTML with no DOM, so pan/zoom,
 * pointer-capture drag, and fit-to-view cannot run here.
 *
 * Template-literal rule for the embedded JS: no backticks, no ${ };
 * double backslashes in regex/string literals.
 *
 * Leftover vs apps/desktop/src/components/views/mindmap-view.tsx:
 * - No left-to-right SVG (140x32 nodes, cubic bezier edges, 20px chrome).
 * - No pan / zoom (0.35-2.5) / percent reset / fit-to-view.
 * - No Create CTA and no record-click (guest is view-only; no DOM host).
 * - No dashed SVG orphan stroke; tree overlay paints "Parent not in this view".
 * - Titles are full row titles, not capDisplay 18.
 * - Payload rows are `{id,data,display}` - `loadPublicRows` does not SELECT
 *   `entity_records.parent_id`, so a map that nests only on that SQL column
 *   (no bound relation_field) stays flat roots.
 */
export const GUEST_VIEW_MINDMAP_JS = `
  var GUEST_MINDMAP_NODES_MAX = 300;
  var GUEST_MINDMAP_WALK_MAX = 32;
  var GUEST_MINDMAP_RELATION_JSON_PARSE_MAX = 512;
  var GUEST_MINDMAP_PARENT_SENTINEL = '__guest_mindmap_parent';

  function guestMindmapNormId(raw){
    return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
  }
  function guestMindmapIsTitleType(fieldType){
    var t = String(fieldType || '').trim().toLowerCase();
    return t === 'text' || t === 'rich_text' || t === 'email' || t === 'phone' || t === 'url' || t === 'select' || t === 'status';
  }
  function guestMindmapIsRelationType(fieldType){
    var t = String(fieldType || '').trim().toLowerCase();
    return t === 'relation' || t === 'user' || t === 'link';
  }
  function guestMindmapCfgSlug(cfg, keys){
    if (!cfg) return '';
    var i, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  }
  function guestMindmapFieldBySlug(cols, slug){
    if (!slug) return null;
    var i, f, key;
    for (i=0;i<cols.length;i++){
      f = cols[i];
      if (!f) continue;
      if (f.slug === slug) return f;
      key = typeof f.id === 'string' ? f.id : '';
      if (key && key === slug) return f;
    }
    return null;
  }
  function guestMindmapTitleSlug(content, cols){
    var cfg = viewCfg(content);
    var slug = guestMindmapCfgSlug(cfg, ['titleFieldSlug','title_field']);
    var f = guestMindmapFieldBySlug(cols, slug);
    if (f && guestMindmapIsTitleType(f.field_type)) return f.slug;
    var i;
    for (i=0;i<cols.length;i++){
      f = cols[i];
      if (f && f.is_title === true && f.slug && guestMindmapIsTitleType(f.field_type)) return f.slug;
    }
    for (i=0;i<cols.length;i++){
      f = cols[i];
      if (f && f.slug && guestMindmapIsTitleType(f.field_type)) return f.slug;
    }
    return '';
  }
  function guestMindmapRelationSlug(content, cols){
    var cfg = viewCfg(content);
    var slug = guestMindmapCfgSlug(cfg, ['relationFieldSlug','relation_field']);
    var f = guestMindmapFieldBySlug(cols, slug);
    if (f && guestMindmapIsRelationType(f.field_type)) return f.slug;
    return '';
  }
  function guestMindmapReadParentFromCell(raw, depth){
    depth = depth || 0;
    if (depth > 4) return '';
    if (raw == null || raw === '') return '';
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      var id = guestMindmapNormId(raw.id);
      if (!id) id = guestMindmapNormId(raw.value);
      return id;
    }
    if (Array.isArray(raw) && raw.length > 0) {
      return guestMindmapReadParentFromCell(raw[0], depth + 1);
    }
    var s = typeof raw === 'string' ? raw.trim() : String(raw).trim();
    if (!s) return '';
    if ((s.charAt(0) === '{' || s.charAt(0) === '[') && s.length > 1) {
      if (s.length > GUEST_MINDMAP_RELATION_JSON_PARSE_MAX) return '';
      try {
        return guestMindmapReadParentFromCell(JSON.parse(s), depth + 1);
      } catch (err) {
        return s.length <= 128 ? s : '';
      }
    }
    return s.length <= 128 ? s : '';
  }
  function guestMindmapParentOf(row, relationSlug){
    if (!row) return '';
    var top = guestMindmapNormId(row.parent_id);
    if (!top) top = guestMindmapNormId(row.parentId);
    if (top) return top;
    var d = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (relationSlug) return guestMindmapReadParentFromCell(d[relationSlug], 0);
    var fromData = guestMindmapReadParentFromCell(d.parent_id, 0);
    if (!fromData) fromData = guestMindmapReadParentFromCell(d.parentId, 0);
    return fromData;
  }
  function guestMindmapIdSort(a, b){
    return String(a).localeCompare(String(b));
  }
  function guestMindmapBfsKeep(allIds, proposed, maxNodes){
    var idSet = Object.create(null);
    var children = Object.create(null);
    var i, id, p, keys, kept, seen, q, cur, kids, k;
    children[''] = [];
    for (i=0;i<allIds.length;i++) idSet[allIds[i]] = 1;
    for (i=0;i<allIds.length;i++){
      id = allIds[i];
      p = proposed[id] || '';
      if (p && (!Object.prototype.hasOwnProperty.call(idSet, p) || p === id)) p = '';
      if (!children[p]) children[p] = [];
      children[p].push(id);
    }
    keys = Object.keys(children);
    for (i=0;i<keys.length;i++) children[keys[i]].sort(guestMindmapIdSort);
    kept = [];
    seen = Object.create(null);
    q = (children[''] || []).slice();
    while (q.length && kept.length < maxNodes) {
      cur = q.shift();
      if (seen[cur]) continue;
      seen[cur] = 1;
      kept.push(cur);
      if (kept.length >= maxNodes) break;
      kids = children[cur] || [];
      for (k=0;k<kids.length;k++){
        if (!seen[kids[k]]) q.push(kids[k]);
      }
    }
    return kept;
  }
  function guestMindmapWouldCycle(childId, parentId, parentOf){
    var cur = parentId;
    var seen = Object.create(null);
    var walk = 0;
    while (cur && walk < GUEST_MINDMAP_WALK_MAX) {
      if (cur === childId) return true;
      if (seen[cur]) return true;
      seen[cur] = 1;
      cur = Object.prototype.hasOwnProperty.call(parentOf, cur) ? (parentOf[cur] || '') : '';
      walk += 1;
    }
    return false;
  }
  function guestMindmapStampRow(row, parentId){
    return {
      id: row.id,
      data: row.data,
      display: row.display,
      parent_id: parentId || ''
    };
  }
  function guestMindmapCloneCfg(cfg){
    var out = {};
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return out;
    var keys = Object.keys(cfg);
    var i, k;
    for (i=0;i<keys.length;i++){
      k = keys[i];
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = cfg[k];
    }
    return out;
  }
  function guestMindmapPrepare(content, rows, titleSlug, relationSlug){
    var byId = Object.create(null);
    var proposed = Object.create(null);
    var ids = [];
    var i, r, id, p;
    for (i=0;i<rows.length;i++){
      r = rows[i];
      id = rowIdOf(r);
      if (!id) continue;
      if (!Object.prototype.hasOwnProperty.call(byId, id)) ids.push(id);
      byId[id] = r;
      p = guestMindmapParentOf(r, relationSlug);
      if (p === id) p = '';
      proposed[id] = p;
    }
    ids.sort(guestMindmapIdSort);
    var bfsTruncated = ids.length > GUEST_MINDMAP_NODES_MAX;
    var keptIds = bfsTruncated
      ? guestMindmapBfsKeep(ids, proposed, GUEST_MINDMAP_NODES_MAX)
      : ids;
    var keptSet = Object.create(null);
    for (i=0;i<keptIds.length;i++) keptSet[keptIds[i]] = 1;
    var parentOf = Object.create(null);
    for (i=0;i<keptIds.length;i++) parentOf[keptIds[i]] = '';
    var cycleSkips = 0;
    var keptSorted = keptIds.slice().sort(guestMindmapIdSort);
    for (i=0;i<keptSorted.length;i++){
      id = keptSorted[i];
      p = proposed[id] || '';
      if (!p) continue;
      if (!Object.prototype.hasOwnProperty.call(keptSet, p)) continue;
      if (guestMindmapWouldCycle(id, p, parentOf)) {
        cycleSkips += 1;
        continue;
      }
      parentOf[id] = p;
    }
    var outRows = [];
    for (i=0;i<keptIds.length;i++){
      id = keptIds[i];
      r = byId[id];
      p = parentOf[id] || '';
      if (!p) {
        var rawP = proposed[id] || '';
        if (rawP && !Object.prototype.hasOwnProperty.call(keptSet, rawP)) p = rawP;
      }
      outRows.push(guestMindmapStampRow(r, p));
    }
    var nextCfg = guestMindmapCloneCfg(viewCfg(content));
    nextCfg.titleFieldSlug = titleSlug;
    nextCfg.title_field = titleSlug;
    nextCfg.relationFieldSlug = relationSlug || GUEST_MINDMAP_PARENT_SENTINEL;
    nextCfg.relation_field = relationSlug || GUEST_MINDMAP_PARENT_SENTINEL;
    return {
      content: {
        viewType: content && content.viewType,
        fields: content && content.fields,
        columns: content && content.columns,
        rows: outRows,
        viewConfig: nextCfg,
        truncated: false,
        total: content && content.total
      },
      shown: outRows.length,
      inventory: ids.length,
      bfsTruncated: bfsTruncated,
      cycleSkips: cycleSkips
    };
  }
  function guestMindmapEmptyHtml(kind){
    if (kind === 'title') {
      return '<div class="card"><div class="empty">Pick a title field.<div class="muted" style="margin-top:8px">This public page needs a text field for each item label.</div></div></div>';
    }
    return '<div class="card"><div class="empty">No records to show.</div></div>';
  }
  function guestMindmapNotesHtml(shown, inventory, bfsTruncated, payloadTotal, payloadTruncated, cycleSkips){
    var parts = [];
    var total = inventory;
    if (typeof payloadTotal === 'number' && isFinite(payloadTotal) && payloadTotal > total) total = Math.floor(payloadTotal);
    if (bfsTruncated) {
      parts.push('Showing ' + shown + ' of ' + total + ' records (roots first, up to 300).');
    } else if (payloadTruncated && total > shown) {
      parts.push('Showing ' + shown + ' of ' + total + ' records.');
    }
    if (cycleSkips > 0) {
      parts.push('Skipped ' + cycleSkips + (cycleSkips === 1 ? ' parent link that would loop.' : ' parent links that would loop.'));
    }
    if (!parts.length) return '';
    return '<p class="hint" style="margin:0 0 8px">' + esc(parts.join(' ')) + '</p>';
  }
  function renderGuestMindmapHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var titleSlug = guestMindmapTitleSlug(content, cols);
    if (!titleSlug) return guestMindmapEmptyHtml('title');
    if (!rows.length) return guestMindmapEmptyHtml('rows');
    var relationSlug = guestMindmapRelationSlug(content, cols);
    var prepared = guestMindmapPrepare(content, rows, titleSlug, relationSlug);
    var html = renderTreeHtml(prepared.content);
    var payloadTotal = content && typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
    var notes = guestMindmapNotesHtml(
      prepared.shown,
      prepared.inventory,
      prepared.bfsTruncated,
      payloadTotal,
      content && content.truncated === true,
      prepared.cycleSkips
    );
    var hint = '<p class="hint">This public page shows a nested list, not a drawing.</p>';
    return hint + notes + html;
  }
  if (typeof renderReadBodyHtml === 'function') {
    var _guestMindmapReadBody = renderReadBodyHtml;
    renderReadBodyHtml = function(content){
      var vt = canonicalViewType(content && content.viewType);
      if (vt === 'mindmap') return { html: renderGuestMindmapHtml(content), simplified: false };
      return _guestMindmapReadBody(content);
    };
  }
`
