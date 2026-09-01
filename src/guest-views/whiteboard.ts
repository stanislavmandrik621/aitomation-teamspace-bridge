/**
 * Guest whiteboard view snippet interpolated into the guest-page IIFE
 * (GUEST_RENDER_JS in guest-page-render.ts). Concatenate after the core so
 * a later function declaration could override parent renderers. Empty means
 * the parent stands.
 *
 * Desktop WhiteboardView (apps/desktop/src/components/views/whiteboard-view.tsx)
 * is an isolated drawing board: a left list of boards, a tool strip (select,
 * rectangle, ellipse, line, arrow, text), a Stage/Layer canvas, connector
 * anchors, text inline edit, sparse board_field save, and Team Space live
 * pointers. A public guest page is a self-contained HTML document with no
 * app bundle and no canvas host, so it cannot paint that board.
 *
 * Parent renderReadBodyHtml keeps viewType whiteboard on renderTableHtml and
 * sets simplified: true so the share shell shows
 * "This layout is simplified on the public page."
 * Guest canonicalViewType maps drawing / canvas / board_draw to whiteboard
 * (same as desktop), then that branch still uses the table + honest note.
 *
 * This overlay fills that path: when a json/text cell looks like a board
 * scene ({shapes:[]}), paint a title plus shape count. Otherwise keep the
 * parent table. Never a Stage, canvas, or drawing surface.
 *
 * Template-literal rules (same as GUEST_RENDER_JS): no backticks, no
 * ${ } in the snippet; double backslashes in regex/string literals.
 *
 * Gaps vs desktop WhiteboardView (none of these ship on the guest page):
 * - Drawing surface: Stage/Layer, tools, transformer resize, connector
 *   anchors (4 sides) + snap + endpoint handles, text inline editor,
 *   delete-selected with connector detach, mid-draw pointer-leave finalize,
 *   ellipse center-to-top-left writes, theme stroke/fill/text at render.
 * - Board list chrome: sidebar of records, rename via title_field or
 *   is_title (never the board JSON field), selected-board load, empty
 *   states (pick field / missing / wrong type / no boards / filters),
 *   Showing N of total page note, New record CTA.
 * - Scene I/O: parse/serialize board_field (json or text), shape cap 200,
 *   256 KiB byte cap, truncation note, load-error banner.
 * - Persistence: 500ms autosave, retry backoff, flush on hide/unmount,
 *   dirty park, Keep mine / Use theirs peer conflict.
 * - Team Space: Yjs live scene merge, awareness pointers, Viewer
 *   View only chrome (guest pages are already view-not-edit).
 * - Payload: VIEW_TYPE_SLUG_CONFIG_KEYS.whiteboard is only board_field, and
 *   buildPayloadViewConfig never stamps a boardFieldSlug. title_field is
 *   not in that key list, so titleFieldSlug is also omitted. The table
 *   path would not read those keys even if they landed.
 * - JSON cell honesty: a scene object ({version, shapes}) has no
 *   name/label/title, so valueText / cellHtml paint the board column as
 *   empty. This overlay counts shapes when the cell parses as a scene.
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
  function renderWhiteboardHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var note = '<p class="hint">This public page cannot show the drawing board. Records are listed below.</p>';
    if (!cols.length || !rows.length) return note + emptyStateHtml();
    var titleSlug = titleSlugOf(content, cols);
    var sceneCols = [];
    var i, t;
    for (i = 0; i < cols.length; i++) {
      t = String(cols[i].field_type || '').toLowerCase();
      if (guestWbIsSceneField(t)) sceneCols.push(cols[i]);
    }
    var cards = '';
    var found = 0;
    var ri, si, n, label;
    for (ri = 0; ri < rows.length; ri++) {
      n = -1;
      for (si = 0; si < sceneCols.length; si++) {
        n = guestWbSceneCount(guestWbReadCell(rows[ri], sceneCols[si].slug));
        if (n >= 0) break;
      }
      if (n < 0) continue;
      found += 1;
      label = n === 1 ? '1 shape' : (String(n) + ' shapes');
      cards += '<div class="row-card">' + rowTitleHtml(rows[ri], titleSlug)
        + '<div class="kv"><div class="kv-k">Board</div><div class="kv-v">' + esc(label) + '</div></div></div>';
    }
    if (found > 0) {
      return note + '<div class="stack whiteboard-read">' + cards + '</div>';
    }
    return note + renderTableHtml(content);
  }
  if (typeof renderReadBodyHtml === 'function') {
    var _guestWbReadBody = renderReadBodyHtml;
    renderReadBodyHtml = function(content){
      var vt = canonicalViewType(content && content.viewType);
      if (vt === 'whiteboard') return { html: renderWhiteboardHtml(content), simplified: true };
      return _guestWbReadBody(content);
    };
  }
`

