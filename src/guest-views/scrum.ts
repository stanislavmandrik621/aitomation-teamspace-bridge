/**
 * Guest Scrum read layout (public share / portal).
 *
 * Concatenate after GUEST_RENDER_JS so a later wrap can override parent
 * `renderBoardHtml`. Kanban overlay (earlier in this concat) already wraps
 * kanban / kanban_board. This leaf wraps scrum / scrum_board / sprint_board.
 *
 * Parent `canonicalViewType` maps `scrum`, `scrum_board`, and `sprint_board`
 * (and `kanban`) to `board`. `renderReadBodyHtml` then paints `.board` lanes
 * with `simplified: false`. Payload `viewConfig` stamps scrum `status_field`
 * as `groupByFieldSlug` (plus `titleFieldSlug` / `imageFieldSlug` when bound).
 * `PublicSharePayloadViewConfig` has no `sprintFieldSlug` or `pointsFieldSlug`,
 * so this overlay cannot honestly build the desktop backlog rail without
 * guessing a sprint field.
 *
 * This overlay wraps `renderBoardHtml` for scrum types and reuses the kanban
 * lane helpers (concatenated earlier) with "No status" for blanks, plus an
 * honest note that sprint backlog / points / filter are not on this page.
 *
 * Template-literal rule: no backticks, no ${ } in the embedded source;
 * double backslashes in regex/string literals.
 *
 * Desktop source of truth: apps/desktop/src/components/views/scrum-view.tsx
 * plus apps/desktop/src/lib/scrum-view.ts (`buildScrumBoard`).
 *
 * Gaps vs desktop ScrumView (none of these ship on the guest page; closing
 * them needs payload + un-alias work in other files, not a guessed overlay):
 * - No backlog rail. Desktop puts empty / "Backlog" sprint cells only in a
 *   left Backlog column; guest board lanes every row by status, so backlog
 *   cards sit in status columns.
 * - No sprint_field on the public payload, so no All-active / per-sprint
 *   filter chip bar and no per-card sprint when the filter is all-active.
 * - No points_field / lane points sum.
 * - Blank status is guest "No value"; desktop Uncategorized is "No status".
 * - Extra status values past 30 lanes fold into "Other"; desktop keeps
 *   option order, then extras, then Uncategorized (no Other fold).
 * - No collapsed_columns strip, drag between backlog/status, add-in-column,
 *   or in-flight drop lock (guest is view-not-edit).
 * - No bind-status-and-sprint / same-field empty states (guest still paints
 *   a status board when groupByFieldSlug is present).
 * - No rich-card cover / description / comment badges / record-click.
 * - Payload truncated / totalCount is not shown on the board.
 */
export const GUEST_VIEW_SCRUM_JS = `
  var GUEST_SCRUM_NO_STATUS = 'No status';
  function guestScrumIsScrumType(vt){
    var t = (typeof vt === 'string' ? vt : '').trim().toLowerCase().replace(/[\\s-]+/g, '_');
    return t === 'scrum' || t === 'scrum_board' || t === 'sprint_board';
  }
  function renderScrumHtml(content){
    var note = '<p class="hint">This public page shows status columns. Sprint backlog, points, and the sprint filter are not on this page.</p>';
    var cols = visibleFields(content);
    if (!cols.length) return note + emptyStateHtml();
    if (typeof guestKanbanGroupSlug !== 'function' || typeof guestKanbanCardHtml !== 'function') {
      return note + (typeof renderKanbanHtml === 'function' ? renderKanbanHtml(content) : '');
    }
    var groupSlug = guestKanbanGroupSlug(content, cols);
    if (!groupSlug) {
      return note + '<div class="card"><div class="empty">No board field<div class="muted" style="margin-top:8px">This page needs a status or select field to show columns.</div></div></div>';
    }
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
    if (content && content.truncated === true) {
      note += '<p class="hint">This page shows a capped set of records.</p>';
    }
    var html = note + '<div class="board" data-guest-scrum="1">';
    for (li = 0; li < ordered.length; li++) {
      k = ordered[li];
      list = lanes[k] || [];
      var cards = '';
      var ci;
      for (ci = 0; ci < list.length; ci++) {
        cards += guestKanbanCardHtml(list[ci], cols, titleSlug, groupSlug, imgSlug, descSlug);
      }
      var st = opt.colors[k] ? ' style="border-color:' + esc(opt.colors[k]) + '"' : '';
      var head = k === GUEST_KANBAN_UNCATEGORIZED
        ? GUEST_SCRUM_NO_STATUS
        : ((opt.labels && opt.labels[k]) ? opt.labels[k] : k);
      html += '<div class="lane"' + st + '><div class="lane-head"><span>' + esc(head) + '</span><span class="lane-count">' + String(list.length) + '</span></div>' + cards + '</div>';
    }
    return html + '</div>';
  }
  if (typeof renderBoardHtml === 'function') {
    var _guestScrumParentBoardHtml = renderBoardHtml;
    renderBoardHtml = function(content){
      if (guestScrumIsScrumType(content && content.viewType)) return renderScrumHtml(content);
      return _guestScrumParentBoardHtml(content);
    };
  }
`

