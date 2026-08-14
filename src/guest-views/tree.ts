/**
 * Guest Tree read layout (public share / portal).
 *
 * Concatenate AFTER `GUEST_RENDER_JS` so this `renderTreeHtml` overrides the
 * parent's indent-only walk (sloppy IIFE: last function declaration wins).
 *
 * Desktop source: `apps/desktop/src/components/views/tree-view.tsx` read-only
 * surface (no drag, no Add child, no record-click). Guest pages are
 * string-to-string, so expand/collapse is nested `<details open>` (default
 * expanded like the app). Theme already hides the native summary marker
 * (`.tree summary::-webkit-details-marker`), so this leaf draws the chevron.
 *
 * Depends on parent helpers already in scope: `esc`, `visibleFields`,
 * `viewCfg`, `titleSlugOf`, `emptyStateHtml`, `cellHtml`, `rowCellText`,
 * `pickParentSlug`, `rowIdOf`, `rowParentId`.
 *
 * Template-literal rules (same as `GUEST_RENDER_JS`): no backticks, no
 * dollar-brace interpolation in the embedded JS; double backslashes in
 * regex/string literals.
 *
 * Gaps vs desktop TreeView (not closable in this snippet):
 * - Payload rows are `{id,data,display}` only. Desktop nests on
 *   `entity_records.parent_id` + `sort_order`. `loadPublicRows` does not
 *   SELECT those columns, so until the payload stamps them this renderer
 *   reads `data.parent_id` / a relation field (or every row as a root).
 *   Sibling order then ties on id, not desktop sort_order.
 * - Tree viewConfig is `title_field` + `metaFields`. Payload stamps
 *   `titleFieldSlug` but not `metaFields`, so Customize chip lists never
 *   arrive; auto first-3 still runs.
 * - Fields on the wire have no `is_title`; title is `title_field` /
 *   `titleFieldSlug` / first column.
 * - Drag reorder / nest, Add child, record-click, and localStorage
 *   collapsed ids (MAUD-TREE-002). Expand uses `<details>` and does not
 *   persist. Theme `.tree` padding stays; row chrome is inline here.
 * - Empty-state copy cannot split filters / cap-glitch / nothing-placed
 *   the way the app does (guest payload is pre-filtered). Truncation is
 *   a banner when `content.truncated` is present.
 * - Honesty banner omits "Re-parent or delete to fix" (guests cannot).
 * - Full-bleed `h-full` scroll host (UI-TREE-BLEED) needs the page shell.
 */
export const GUEST_VIEW_TREE_JS = `
  var GUEST_TREE_INDENT_PX = 18;
  var GUEST_TREE_MAX_INDENT = 8;
  var GUEST_TREE_DEPTH_CAP = 10;
  var GUEST_TREE_META_MAX = 3;
  var GUEST_TREE_META_STORE_CAP = 20;
  var GUEST_TREE_PARENT_JSON_MAX = 512;
  function guestTreeNormId(raw){
    return typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 128) : '';
  }
  function guestTreeData(row){
    return row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  }
  function guestTreeUnwrapParent(raw, depth){
    depth = depth || 0;
    if (raw == null || raw === '' || depth > 2) return '';
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (!s) return '';
      if ((s.charAt(0) === '{' || s.charAt(0) === '[') && s.length > 1) {
        if (s.length > GUEST_TREE_PARENT_JSON_MAX) return s.length <= 128 ? s : '';
        try { return guestTreeUnwrapParent(JSON.parse(s), depth + 1); }
        catch (err) { return s.length <= 128 ? s : ''; }
      }
      return s.length <= 128 ? s : '';
    }
    if (typeof raw === 'number' && isFinite(raw)) return String(raw);
    if (Array.isArray(raw) && raw.length) return guestTreeUnwrapParent(raw[0], depth + 1);
    if (typeof raw === 'object') {
      var fromId = guestTreeNormId(raw.id);
      if (fromId) return fromId;
      return guestTreeNormId(raw.value);
    }
    return '';
  }
  function guestTreeParentId(row, slug){
    if (row) {
      var top = guestTreeNormId(row.parent_id);
      if (!top) top = guestTreeNormId(row.parentId);
      if (top) return top;
    }
    var d = guestTreeData(row);
    var fromData = guestTreeUnwrapParent(d.parent_id, 0);
    if (!fromData) fromData = guestTreeUnwrapParent(d.parentId, 0);
    if (fromData) return fromData;
    if (slug) {
      var fromSlug = guestTreeUnwrapParent(d[slug], 0);
      if (fromSlug) return fromSlug;
      return rowParentId(row, slug);
    }
    return '';
  }
  function guestTreeSortOrder(row){
    if (!row) return 0;
    var n = row.sort_order;
    if (typeof n === 'number' && isFinite(n)) return n;
    n = row.sortOrder;
    if (typeof n === 'number' && isFinite(n)) return n;
    var d = guestTreeData(row);
    n = d.sort_order;
    if (typeof n === 'number' && isFinite(n)) return n;
    n = d.sortOrder;
    if (typeof n === 'number' && isFinite(n)) return n;
    return 0;
  }
  function guestTreeCompare(a, b){
    var sa = guestTreeSortOrder(a);
    var sb = guestTreeSortOrder(b);
    if (sa !== sb) return sa - sb;
    return rowIdOf(a).localeCompare(rowIdOf(b));
  }
  function guestTreeIsSkippedMeta(t){
    t = String(t || '').toLowerCase();
    if (t === 'image' || t === 'file' || t === 'json' || t === 'long_text' || t === 'rich_text') return true;
    if (t === 'formula' || t === 'lookup' || t === 'rollup' || t === 'count' || t === 'button' || t === 'time_tracked') return true;
    if (t === 'auto_id' || t === 'auto_number' || t === 'created_at' || t === 'updated_at' || t === 'created_by' || t === 'last_modified_by') return true;
    return false;
  }
  function guestTreeIsEmptyMeta(row, field){
    var slug = field && typeof field.slug === 'string' ? field.slug : '';
    if (!slug) return true;
    var text = rowCellText(row, slug);
    if (typeof text === 'string') {
      var trimmed = text.trim();
      if (!trimmed || trimmed === '[]' || trimmed === '{}') return true;
    } else if (text == null || text === '') {
      return true;
    }
    var raw = guestTreeData(row)[slug];
    if (raw && typeof raw === 'object') {
      if (Array.isArray(raw) && !raw.length) return true;
      if (!Array.isArray(raw) && !Object.keys(raw).length) return true;
    }
    return false;
  }
  function guestTreeFieldLabel(name){
    var s = String(name == null ? '' : name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    if (!s) return '';
    return s.replace(/\\b\\w/g, function(c){ return c.toUpperCase(); });
  }
  function guestTreeMetaFields(cols, titleSlug, parentSlug, cfg){
    var candidates = [];
    var i, f, slug;
    for (i=0;i<cols.length;i++){
      f = cols[i];
      slug = typeof f.slug === 'string' ? f.slug : '';
      if (!slug || slug === titleSlug || slug === parentSlug) continue;
      if (guestTreeIsSkippedMeta(f.field_type)) continue;
      candidates.push(f);
    }
    var raw = cfg ? cfg.metaFields : undefined;
    if (raw === undefined && cfg) raw = cfg.meta_fields;
    var MAX = GUEST_TREE_META_MAX;
    if (raw === undefined || raw === null || !Array.isArray(raw)) return candidates.slice(0, MAX);
    if (!raw.length) return [];
    var parsed = [];
    var seenParse = Object.create(null);
    for (i=0;i<raw.length && parsed.length<GUEST_TREE_META_STORE_CAP;i++){
      if (typeof raw[i] !== 'string') continue;
      slug = raw[i].trim();
      if (!slug || slug.length > 128) continue;
      if (Object.prototype.hasOwnProperty.call(seenParse, slug)) continue;
      seenParse[slug] = 1;
      parsed.push(slug);
    }
    var bySlug = Object.create(null);
    for (i=0;i<candidates.length;i++){
      slug = candidates[i].slug;
      if (slug && !Object.prototype.hasOwnProperty.call(bySlug, slug)) bySlug[slug] = candidates[i];
    }
    var out = [];
    for (i=0;i<parsed.length && out.length<MAX;i++){
      slug = parsed[i];
      if (Object.prototype.hasOwnProperty.call(bySlug, slug)) out.push(bySlug[slug]);
    }
    return out;
  }
  function guestTreeForest(rows, parentSlug){
    var byId = Object.create(null);
    var i, r, id;
    for (i=0;i<rows.length;i++){
      r = rows[i];
      id = rowIdOf(r);
      if (id) byId[id] = r;
    }
    var childrenMap = Object.create(null);
    var orphanIds = Object.create(null);
    var ids = Object.keys(byId);
    for (i=0;i<ids.length;i++){
      id = ids[i];
      r = byId[id];
      var parent = guestTreeParentId(r, parentSlug);
      var key = parent;
      if (parent && !byId[parent]) {
        key = '';
        orphanIds[id] = 1;
      }
      if (!parent) key = '';
      if (!childrenMap[key]) childrenMap[key] = [];
      childrenMap[key].push(r);
    }
    var visited = Object.create(null);
    var depthCap = GUEST_TREE_DEPTH_CAP;
    function walk(parentKey, depth, cycleRecovered, overDepth){
      var kids = (childrenMap[parentKey] || []).slice().sort(guestTreeCompare);
      var out = [];
      var j;
      for (j=0;j<kids.length;j++){
        var rec = kids[j];
        var rid = rowIdOf(rec);
        if (!rid || visited[rid]) continue;
        visited[rid] = 1;
        var hitDepthCap = depth > depthCap;
        var children = hitDepthCap ? [] : walk(rid, depth + 1, false, false);
        out.push({
          record: rec,
          children: children,
          orphan: !!orphanIds[rid],
          cycleRecovered: cycleRecovered,
          overDepth: overDepth || hitDepthCap
        });
      }
      return out;
    }
    var roots = walk('', 1, false, false);
    for (i=0;i<ids.length;i++){
      id = ids[i];
      if (visited[id]) continue;
      visited[id] = 1;
      r = byId[id];
      var p = guestTreeParentId(r, parentSlug);
      var parentVisited = !!(p && visited[p] && byId[p]);
      var asOverDepth = parentVisited && !orphanIds[id];
      var rescued = walk(id, 2, !asOverDepth, asOverDepth);
      roots.push({
        record: r,
        children: rescued,
        orphan: !!orphanIds[id],
        cycleRecovered: !asOverDepth,
        overDepth: asOverDepth
      });
    }
    roots.sort(function(a, b){ return guestTreeCompare(a.record, b.record); });
    return roots;
  }
  function guestTreeHonestyBanner(nodes){
    var overDepth = 0;
    var cycleRecovered = 0;
    function tally(list){
      var i, n;
      for (i=0;i<list.length;i++){
        n = list[i];
        if (n.overDepth) overDepth += 1;
        if (n.cycleRecovered) cycleRecovered += 1;
        if (n.children && n.children.length) tally(n.children);
      }
    }
    tally(nodes);
    var parts = [];
    if (overDepth > 0) {
      parts.push(overDepth + (overDepth === 1 ? ' deeply nested record is' : ' deeply nested records are') + ' shown at the top level');
    }
    if (cycleRecovered > 0) {
      parts.push(cycleRecovered + (cycleRecovered === 1 ? ' record with a looped parent link is' : ' records with looped parent links are') + ' shown at the top level');
    }
    if (!parts.length) return '';
    return '<p class="gt-banner hint">' + esc(parts.join('. ') + '.') + '</p>';
  }
  function guestTreeTruncatedBanner(content, shown){
    if (!content || content.truncated !== true) return '';
    var total = content.total;
    var more = (typeof total === 'number' && isFinite(total) && total > shown)
      ? (total - shown) + ' more stay in the app.'
      : 'More records stay in the app.';
    return '<p class="gt-banner hint">' + esc('This page shows ' + shown + ' records. ' + more) + '</p>';
  }
  function guestTreeHonestyLine(node){
    var msg = '';
    if (node.orphan) msg = 'Parent not in this view - shown at the top level';
    else if (node.cycleRecovered) msg = 'Parent link forms a loop - shown at the top level';
    else if (node.overDepth) msg = 'Too deeply nested - shown at the top level';
    if (!msg) return '';
    return '<div class="hint" style="margin:2px 0 0;color:#fcd34d;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(msg) + '</div>';
  }
  function guestTreeTitleHtml(row, titleSlug){
    var title = titleSlug ? rowCellText(row, titleSlug) : '';
    if (typeof title === 'string') title = title.trim();
    else title = '';
    if (!title) {
      if (!titleSlug) {
        var id = rowIdOf(row);
        title = id ? id.slice(0, 8) : '(Untitled)';
      } else {
        title = '(Untitled)';
      }
    }
    return '<p style="margin:0;font-size:14px;font-weight:500;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(title) + '</p>';
  }
  function guestTreeMetaHtml(row, metaFields){
    if (!metaFields.length) return '';
    var chips = '';
    var i, f, val, label, tip;
    for (i=0;i<metaFields.length;i++){
      f = metaFields[i];
      if (guestTreeIsEmptyMeta(row, f)) continue;
      val = cellHtml(f, row);
      if (!val) continue;
      label = guestTreeFieldLabel(f.name || f.slug);
      tip = rowCellText(row, f.slug);
      chips += '<span class="cell-muted" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px"'
        + (tip ? ' title="' + esc(label + ': ' + tip) + '"' : '')
        + '>' + esc(label) + ': <span style="color:#c3c8d1">' + val + '</span></span>';
    }
    if (!chips) return '';
    return '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:2px;min-width:0">' + chips + '</div>';
  }
  function guestTreeGuides(depth){
    var n = Math.min(depth, GUEST_TREE_MAX_INDENT);
    var html = '';
    var lvl;
    for (lvl=0;lvl<n;lvl++){
      html += '<span aria-hidden="true" style="position:absolute;top:0;bottom:0;width:1px;background:#26282e;pointer-events:none;left:' + (12 + lvl * GUEST_TREE_INDENT_PX + 9) + 'px"></span>';
    }
    return html;
  }
  function guestTreeChevronHtml(hasKids){
    if (!hasKids) {
      return '<span aria-hidden="true" style="flex:0 0 auto;width:20px;height:20px"></span>';
    }
    return '<span aria-hidden="true" class="gt-chev" style="flex:0 0 auto;width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;color:#8b909a;font-size:11px;line-height:1">'
      + '<span class="gt-chev-shut">&#9656;</span>'
      + '<span class="gt-chev-open">&#9662;</span>'
      + '</span>';
  }
  function guestTreeRowInner(node, depth, titleSlug, metaFields, showBorder){
    var rec = node.record;
    var kids = node.children || [];
    var pad = 12 + Math.min(depth, GUEST_TREE_MAX_INDENT) * GUEST_TREE_INDENT_PX;
    var border = showBorder ? 'border-top:1px solid #1e2126;' : 'border-top:0;';
    var body = guestTreeGuides(depth)
      + guestTreeChevronHtml(kids.length > 0)
      + '<div style="flex:1;min-width:0">'
      + guestTreeTitleHtml(rec, titleSlug)
      + guestTreeMetaHtml(rec, metaFields)
      + guestTreeHonestyLine(node)
      + '</div>';
    if (kids.length) {
      body += '<span class="cell-muted" style="flex:0 0 auto;font-size:10px;font-variant-numeric:tabular-nums">' + kids.length + '</span>';
    }
    return '<div class="tree-row" style="position:relative;display:flex;align-items:center;gap:6px;padding:8px 12px 8px ' + pad + 'px;' + border + '">'
      + body + '</div>';
  }
  function guestTreeNodeHtml(node, depth, titleSlug, metaFields, showBorder){
    var kids = node.children || [];
    var row = guestTreeRowInner(node, depth, titleSlug, metaFields, showBorder);
    if (!kids.length) return row;
    var inner = '';
    var i;
    for (i=0;i<kids.length;i++) inner += guestTreeNodeHtml(kids[i], depth + 1, titleSlug, metaFields, true);
    return '<details open><summary style="list-style:none;cursor:pointer">' + row + '</summary>' + inner + '</details>';
  }
  function guestTreeStyleHtml(){
    return '<style>'
      + '.guest-tree .gt-banner{margin:0 0 8px;padding:6px 12px;color:#fcd34d;border-bottom:1px solid #26282e;background:rgba(245,158,11,0.05);font-size:11px}'
      + '.guest-tree details{margin:0}'
      + '.guest-tree summary{list-style:none;cursor:pointer}'
      + '.guest-tree summary::-webkit-details-marker{display:none}'
      + '.guest-tree .gt-chev-open{display:none}'
      + '.guest-tree details[open]>summary .gt-chev-open{display:inline}'
      + '.guest-tree details[open]>summary .gt-chev-shut{display:none}'
      + '</style>';
  }
  function renderTreeHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var titleSlug = '';
    var i;
    if (typeof cfg.title_field === 'string' && cfg.title_field) titleSlug = cfg.title_field;
    else if (typeof cfg.titleFieldSlug === 'string' && cfg.titleFieldSlug) titleSlug = cfg.titleFieldSlug;
    else {
      for (i=0;i<cols.length;i++){
        if (cols[i].is_title === true && cols[i].slug) { titleSlug = cols[i].slug; break; }
      }
      if (!titleSlug && cols.length) titleSlug = titleSlugOf(content, cols);
    }
    var parentSlug = '';
    if (typeof cfg.relationFieldSlug === 'string' && cfg.relationFieldSlug) parentSlug = cfg.relationFieldSlug;
    else if (typeof cfg.relation_field === 'string' && cfg.relation_field) parentSlug = cfg.relation_field;
    else parentSlug = pickParentSlug(cols, titleSlug);
    var metaFields = guestTreeMetaFields(cols, titleSlug, parentSlug, cfg);
    var forest = guestTreeForest(rows, parentSlug);
    if (!forest.length) {
      return '<div class="card"><div class="empty">Nothing to show in the tree<div class="muted" style="margin-top:8px">Records are present but none could be placed as roots.</div></div></div>';
    }
    var html = '<div class="tree card guest-tree" style="max-height:100%;overflow-y:auto;overflow-x:hidden">'
      + guestTreeStyleHtml()
      + guestTreeTruncatedBanner(content, rows.length)
      + guestTreeHonestyBanner(forest);
    for (i=0;i<forest.length;i++) html += guestTreeNodeHtml(forest[i], 0, titleSlug, metaFields, i > 0);
    html += '</div>';
    return html;
  }
`
