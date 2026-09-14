/** Public Mind map: connected, cycle-safe SVG with inline view controls.
 * Only the already-scrubbed published rows and fields enter the drawing.
 * No record mutations or external assets are available to anonymous readers.
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
    // A component made entirely of cyclic links has no root. Keep bounded
    // nodes so the cycle breaker below can expose it instead of losing it.
    for (i=0;i<allIds.length && kept.length<maxNodes;i++) {
      if (!seen[allIds[i]]) { seen[allIds[i]] = 1; kept.push(allIds[i]); }
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
      sort_order: row.sort_order,
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
  function guestMindmapDrawingHtml(content, titleSlug){
    var rows = content.rows || [], byId = Object.create(null), kids = Object.create(null), roots = [], placed = Object.create(null), heights = Object.create(null), nodes = [];
    var i, id, p, hasEdges = false;
    rows.forEach(function(row){ byId[row.id] = row; kids[row.id] = []; });
    rows.forEach(function(row){
      p = row.parent_id;
      if (p && byId[p]) { kids[p].push(row.id); hasEdges = true; }
      else roots.push(row.id);
    });
    // Desktop Mind map orders roots/children deterministically by record ID.
    roots.sort(guestMindmapIdSort);
    Object.keys(kids).forEach(function(key){ kids[key].sort(guestMindmapIdSort); });
    function measure(key, seen){
      if (seen[key]) return 54;
      seen[key] = true;
      var h = 0;
      kids[key].forEach(function(child, index){ h += measure(child, seen) + (index ? 18 : 0); });
      heights[key] = Math.max(54, h);
      return heights[key];
    }
    roots.forEach(function(key){ measure(key, Object.create(null)); });
    function place(key, depth, top){
      if (placed[key]) return;
      placed[key] = true;
      nodes.push({id:key, x:34 + depth * 252, y:24 + top + (heights[key] || 54) / 2 - 27});
      var cursor = top;
      kids[key].forEach(function(child){ place(child, depth + 1, cursor); cursor += (heights[child] || 54) + 18; });
    }
    var cursor = 0;
    roots.forEach(function(key){ place(key, 0, cursor); cursor += (heights[key] || 54) + 36; });
    if (!hasEdges) nodes.forEach(function(node, index){ node.x = 24 + index % 3 * 232; node.y = 24 + Math.floor(index / 3) * 72; });
    var width = 400, height = 200, positions = Object.create(null);
    nodes.forEach(function(node){ positions[node.id] = node; width = Math.max(width, node.x + 240); height = Math.max(height, node.y + 88); });
    var edges = '', labels = '';
    nodes.forEach(function(node){
      var row = byId[node.id], parent = positions[row.parent_id];
      if (parent) {
        var x1 = parent.x + 200, y1 = parent.y + 24, x2 = node.x, y2 = node.y + 24, mid = (x1 + x2) / 2;
        edges += '<path data-mindmap-edge d="M' + x1 + ',' + y1 + ' C' + mid + ',' + y1 + ' ' + mid + ',' + y2 + ' ' + x2 + ',' + y2 + '" fill="none" stroke="var(--guest-muted)" stroke-width="1.5" opacity=".6"/>';
      }
      var title = rowCellText(row, titleSlug) || '(Untitled)', paint = String(title).slice(0,80);
      if (String(title).length > 80) paint += '…';
      labels += '<g data-mindmap-node="' + esc(node.id) + '" tabindex="0" role="img" aria-label="' + esc(title) + '"><title>' + esc(title) + '</title><rect x="' + node.x + '" y="' + node.y + '" width="200" height="48" rx="12" fill="var(--guest-card)" stroke="var(--guest-border)"' + (row.parent_id && !parent ? ' stroke-dasharray="4 3"' : '') + '/><foreignObject x="' + (node.x+14) + '" y="' + (node.y+5) + '" width="172" height="38"><div xmlns="http://www.w3.org/1999/xhtml" style="height:38px;display:flex;align-items:center;font:13px system-ui;color:var(--guest-fg)"><span style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere">' + esc(paint) + '</span></div></foreignObject></g>';
    });
    return '<section data-guest-mindmap style="max-width:100%;min-width:0"><div role="toolbar" aria-label="Mind map controls" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:10px"><button class="btn-secondary" data-mindmap-action="out" aria-label="Zoom out">−</button><button class="btn-secondary" data-mindmap-action="reset" aria-label="Reset zoom"><span data-mindmap-percent>100%</span></button><button class="btn-secondary" data-mindmap-action="in" aria-label="Zoom in">+</button><button class="btn-secondary" data-mindmap-action="fit">Fit to view</button><span class="hint" style="margin:0">Scroll to pan</span></div><div data-mindmap-viewport tabindex="0" role="region" aria-label="Mind map" style="overflow:auto;max-width:100%;height:min(65vh,600px);min-height:280px;border:1px solid var(--guest-border);border-radius:12px;background:var(--guest-muted-bg)"><svg xmlns="http://www.w3.org/2000/svg" data-mindmap-svg data-width="' + width + '" data-height="' + height + '" data-scale="1" width="' + width + '" height="' + height + '" viewBox="0 0 ' + width + ' ' + height + '" style="display:block;max-width:none">' + edges + labels + '</svg></div></section>';
  }
  function guestMindmapZoom(root, action){
    var svg = root.querySelector('[data-mindmap-svg]'), viewport = root.querySelector('[data-mindmap-viewport]');
    if (!svg || !viewport) return;
    var width = Number(svg.getAttribute('data-width')), height = Number(svg.getAttribute('data-height')), old = Number(svg.getAttribute('data-scale')) || 1;
    var scale = action === 'fit' ? Math.min(viewport.clientWidth / width, viewport.clientHeight / height, 1) : action === 'reset' ? 1 : old + (action === 'in' ? .15 : -.15);
    scale = Math.max(.1, Math.min(2.5, scale));
    var x = (viewport.scrollLeft + viewport.clientWidth / 2) / old, y = (viewport.scrollTop + viewport.clientHeight / 2) / old;
    svg.setAttribute('width', String(width * scale)); svg.setAttribute('height', String(height * scale)); svg.setAttribute('data-scale', String(scale));
    root.querySelector('[data-mindmap-percent]').textContent = Math.round(scale * 100) + '%';
    viewport.scrollLeft = action === 'fit' ? 0 : x * scale - viewport.clientWidth / 2;
    viewport.scrollTop = action === 'fit' ? 0 : y * scale - viewport.clientHeight / 2;
  }
  if (typeof document !== 'undefined' && document.addEventListener) {
    function guestMindmapInitialize(){
      document.querySelectorAll('[data-guest-mindmap]').forEach(function(root){
        var svg = root.querySelector('[data-mindmap-svg]');
        if (svg && !svg.hasAttribute('data-initialized')) {
          svg.setAttribute('data-initialized','true');
          guestMindmapZoom(root,'fit');
        }
      });
    }
    if (typeof MutationObserver !== 'undefined' && document.documentElement) {
      new MutationObserver(guestMindmapInitialize).observe(document.documentElement, { childList:true, subtree:true });
    }
    guestMindmapInitialize();
    document.addEventListener('click', function(event){
      var button = event.target && event.target.closest && event.target.closest('[data-mindmap-action]');
      if (button) guestMindmapZoom(button.closest('[data-guest-mindmap]'), button.getAttribute('data-mindmap-action'));
    });
    document.addEventListener('keydown', function(event){
      var viewport = event.target && event.target.closest && event.target.closest('[data-mindmap-viewport]');
      if (!viewport || event.ctrlKey || event.metaKey || event.altKey) return;
      var action = event.key === '+' || event.key === '=' ? 'in' : event.key === '-' ? 'out' : event.key === '0' ? 'reset' : event.key.toLowerCase() === 'f' ? 'fit' : '';
      if (action) { event.preventDefault(); guestMindmapZoom(viewport.closest('[data-guest-mindmap]'), action); }
    });
  }
  function renderGuestMindmapHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var titleSlug = guestMindmapTitleSlug(content, cols);
    if (!titleSlug) return guestMindmapEmptyHtml('title');
    if (!rows.length) return guestMindmapEmptyHtml('rows');
    var relationSlug = guestMindmapRelationSlug(content, cols);
    var prepared = guestMindmapPrepare(content, rows, titleSlug, relationSlug);
    var html = guestMindmapDrawingHtml(prepared.content, titleSlug);
    var payloadTotal = content && typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
    var notes = guestMindmapNotesHtml(
      prepared.shown,
      prepared.inventory,
      prepared.bfsTruncated,
      payloadTotal,
      content && content.truncated === true,
      prepared.cycleSkips
    );
    return notes + html;
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
