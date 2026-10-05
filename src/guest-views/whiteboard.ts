/** Read-only SVG whiteboards for public links and portals.
 * Paints bounded saved scenes, resolves connector anchors, and escapes text.
 * Edit tools, live pointers and scene mutations remain desktop-only.
 */
export const GUEST_VIEW_WHITEBOARD_JS = `
  var GUEST_WB_SCENE_CHARS_MAX = 262144;
  var GUEST_WB_SHAPES_MAX = 200;
  function guestWbIsSceneField(t){
    t = String(t || '').toLowerCase();
    return t === 'json' || t === 'text' || t === 'long_text' || t === 'notes' || t === 'rich_text';
  }
  function guestWbSceneCount(raw){
    var obj = raw;
    if (raw == null || raw === '') return -1;
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (s.length < 2 || s.length > GUEST_WB_SCENE_CHARS_MAX) return -1;
      if (s.charAt(0) !== '{') return -1;
      try { obj = JSON.parse(s); }
      catch (err) { return -1; }
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return -1;
    if (!Array.isArray(obj.shapes)) return -1;
    var n = obj.shapes.length;
    if (n > GUEST_WB_SHAPES_MAX) n = GUEST_WB_SHAPES_MAX;
    return n;
  }
  function guestWbReadCell(row, slug){
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (Object.prototype.hasOwnProperty.call(d, slug)) return d[slug];
    return undefined;
  }
  function guestWbScene(raw){
    var scene = raw;
    try {
      var serialized = typeof raw === 'string' ? raw : JSON.stringify(raw);
      if (typeof serialized !== 'string' || new TextEncoder().encode(serialized).length > GUEST_WB_SCENE_CHARS_MAX) return null;
      if (typeof raw === 'string') scene = JSON.parse(raw);
    } catch (e) { return null; }
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.shapes)) return null;
    if (scene.version != null && scene.version !== 1) return null;
    var shapes = [], seen = Object.create(null), omitted = scene.shapes.length > GUEST_WB_SHAPES_MAX;
    for (var i = 0; i < scene.shapes.length && i < GUEST_WB_SHAPES_MAX; i++) {
      var s = scene.shapes[i];
      if (!s || typeof s !== 'object' || ['rect','ellipse','text','line','arrow'].indexOf(s.type) < 0
        || typeof s.id !== 'string' || !s.id || s.id.length > 64 || seen[s.id]
        || ![s.x,s.y,s.w,s.h].every(function(n){return typeof n === 'number' && isFinite(n) && Math.abs(n) <= 10000000;})
        || (['rect','ellipse','text'].indexOf(s.type) >= 0 && (s.w <= 0 || s.h <= 0))) { omitted = true; continue; }
      seen[s.id] = true; shapes.push(s);
      if (typeof s.text === 'string' && s.text.length > 2000) omitted = true;
    }
    return { shapes: shapes, omitted: omitted };
  }
  function guestWbAnchor(shapes, id, side, fallback, ownId){
    if (id === ownId || ['top','right','bottom','left'].indexOf(side) < 0) return fallback;
    var target = shapes.find(function(s){return s.id === id && ['rect','ellipse','text'].indexOf(s.type) >= 0;});
    if (!target) return fallback;
    return { x: target.x + (side === 'left' ? 0 : side === 'right' ? target.w : target.w / 2),
      y: target.y + (side === 'top' ? 0 : side === 'bottom' ? target.h : target.h / 2) };
  }
  function guestWbDrawing(scene){
    var shapes = scene.shapes, minX = 0, minY = 0, maxX = 320, maxY = 200, lines = '', nodes = '';
    function bound(x,y){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    for (var i = 0; i < shapes.length; i++) {
      var s = shapes[i], attr = ' data-whiteboard-shape="' + esc(s.id) + '"';
      if (s.type === 'line' || s.type === 'arrow') {
        var from = guestWbAnchor(shapes,s.fromId,s.fromAnchor,{x:s.x,y:s.y},s.id);
        var to = guestWbAnchor(shapes,s.toId,s.toAnchor,{x:s.x+s.w,y:s.y+s.h},s.id);
        bound(from.x,from.y);bound(to.x,to.y);
        lines += '<g' + attr + '><line x1="' + from.x + '" y1="' + from.y + '" x2="' + to.x + '" y2="' + to.y + '" stroke="var(--guest-secondary)" stroke-width="2" stroke-linecap="round"/>';
        var dx = to.x-from.x, dy = to.y-from.y, length = Math.hypot(dx,dy);
        if (s.type === 'arrow' && length > 0) {
          var ux=dx/length,uy=dy/length;
          lines += '<polygon points="' + to.x+','+to.y+' '+(to.x-10*ux-5*uy)+','+(to.y-10*uy+5*ux)+' '+(to.x-10*ux+5*uy)+','+(to.y-10*uy-5*ux)+'" fill="var(--guest-secondary)"/>';
        }
        lines += '</g>'; continue;
      }
      bound(s.x,s.y);bound(s.x+s.w,s.y+s.h);
      if (s.type === 'text') {
        nodes += '<foreignObject' + attr + ' x="'+s.x+'" y="'+s.y+'" width="'+s.w+'" height="'+s.h+'"><div xmlns="http://www.w3.org/1999/xhtml" style="font:14px/1 system-ui;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--guest-fg);overflow:hidden;height:100%">'+esc(typeof s.text === 'string' ? s.text.slice(0,2000) : '')+'</div></foreignObject>';
      } else if (s.type === 'ellipse') {
        nodes += '<ellipse'+attr+' cx="'+(s.x+s.w/2)+'" cy="'+(s.y+s.h/2)+'" rx="'+(s.w/2)+'" ry="'+(s.h/2)+'" fill="var(--guest-muted-bg)" stroke="var(--guest-secondary)" stroke-width="1.5"/>';
      } else nodes += '<rect'+attr+' x="'+s.x+'" y="'+s.y+'" width="'+s.w+'" height="'+s.h+'" fill="var(--guest-muted-bg)" stroke="var(--guest-secondary)" stroke-width="1.5"/>';
    }
    var width=maxX-minX+40,height=maxY-minY+40;
    return '<svg data-whiteboard-svg role="img" aria-label="Shared drawing" xmlns="http://www.w3.org/2000/svg" viewBox="'+(minX-20)+' '+(minY-20)+' '+width+' '+height+'" style="display:block;width:100%;height:auto;max-height:65vh;min-height:200px;background:var(--guest-input);border:1px solid var(--guest-border);border-radius:10px">'+lines+nodes+'</svg>'
      + (scene.omitted ? '<p class="hint">Some drawing content exceeded the supported limits or was invalid and is not shown.</p>' : '');
  }
  function renderWhiteboardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var note = '';
    if (!cols.length || !rows.length) return note + emptyStateHtml();
    var titleSlug = titleSlugOf(content, cols);
    var cfg = viewCfg(content), boardSlug = cfg.boardFieldSlug || cfg.board_field;
    var sceneCols = [];
    var i, t;
    for (i = 0; i < cols.length; i++) {
      t = String(cols[i].field_type || '').toLowerCase();
      if (guestWbIsSceneField(t) && (!boardSlug || cols[i].slug === boardSlug)) sceneCols.push(cols[i]);
    }
    var cards = '';
    var found = 0;
    var ri, si, n, label, scene;
    for (ri = 0; ri < rows.length; ri++) {
      n = -1;
      scene = null;
      for (si = 0; si < sceneCols.length; si++) {
        scene = guestWbScene(guestWbReadCell(rows[ri], sceneCols[si].slug));
        if (scene) { n = scene.shapes.length; break; }
      }
      if (n < 0) {
        cards += '<div class="row-card">'+rowTitleHtml(rows[ri],titleSlug)+'<p class="hint">No supported drawing is available for this record.</p></div>';
        continue;
      }
      found += 1;
      label = n === 1 ? '1 shape' : (String(n) + ' shapes');
      cards += '<div class="row-card">' + rowTitleHtml(rows[ri], titleSlug)
        + '<div class="hint">' + esc(label) + '</div>' + guestWbDrawing(scene) + '</div>';
    }
    if (found > 0) {
      return note + '<div class="stack whiteboard-read">' + cards + '</div>';
    }
    return '<div class="stack whiteboard-read">' + cards + '</div>';
  }
  if (typeof renderReadBodyHtml === 'function') {
    var _guestWbReadBody = renderReadBodyHtml;
    renderReadBodyHtml = function(content){
      var vt = canonicalViewType(content && content.viewType);
      if (vt === 'whiteboard') return { html: renderWhiteboardHtml(content), simplified: false };
      return _guestWbReadBody(content);
    };
  }
`
