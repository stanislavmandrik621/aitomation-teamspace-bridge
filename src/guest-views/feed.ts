/**
 * Guest Feed read layout (public share / portal).
 *
 * Desktop FeedView is an entity-scoped activity stream (creates / edits /
 * comments), not a record-card surface (MAUD-FEED-005). Parent still paints
 * stacked list cards (`renderListHtml(..., 'stack feed')`). This later
 * `function renderFeedHtml` wins after GUEST_RENDER_JS concatenate.
 *
 * Read-only stack this leaf can host from a string -> string renderer:
 * day separators, hue avatars, kind pills, summary, comment body, field
 * diffs (cap 6 + truncated honesty), kind chips (CSS radio filter), count
 * hint. Cards are divs, never record-open buttons. No New record, Refresh,
 * or Load older (snapshot has no IPC).
 *
 * When the payload has `content.events`, that stream is canonical. Until
 * payload-build stamps activity, rows become created/updated cards so the
 * page is not a field-kv list, with an honest note that history stays in
 * the app. Existing guest tests pin `class="stack feed"`.
 *
 * Depends on enclosing scope: esc, visibleFields, cellHtml, titleSlugOf,
 * rowTitleHtml, rowCellText, ymdFromDate, valueText, viewCfg.
 *
 * Embedded JS: no backticks, no ${ } (this string is itself a template
 * literal). Double backslashes in regex/string literals.
 *
 * Gaps vs apps/desktop/src/components/views/feed-view.tsx (cannot close here):
 * - Share payload is `rows` only (SELECT id, data). No recordActivity list,
 *   so live create/edit/comment history is missing until payload-build.
 * - No record click-through, Removed-bin toast, New record, Refresh, or
 *   Load older (guest is view-not-edit; snapshot has one page, cap 200).
 * - Kind chips filter the loaded window in CSS (no IPC kinds=). Chip counts
 *   are that window; ~ when truncated (MAUD-FEED-002). Day seps hide when
 *   a day has none of the selected kind.
 * - Lucide kind icons are pills (Created / Updated / Comment). Avatar hue
 *   uses the dark-theme avatar token (hsl h,35%,28%), not live light/dark.
 * - Secret diffs are redacted again here; desktop also scrubs at IPC write.
 * - Empty copy has no Create CTA (MAUD-FEED-003 is app-only).
 */

export const GUEST_VIEW_FEED_JS = `
  var FEED_HARD_CAP = 200;
  var FEED_UI_CHANGE_CAP = 6;
  var FEED_COMMENT_CAP = 4000;
  var FEED_HIDDEN = '[hidden]';
  var FEED_LOCALE = 'en-US';

  function feedEmptyHtml(){
    return '<div class="stack feed"><div class="card"><div class="empty">No activity yet.<div class="muted" style="margin-top:8px">Creates, edits, and comments stay in the app.</div></div></div></div>';
  }
  function feedStampMs(v){
    if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    if (typeof v === 'string') {
      var s = v.trim();
      if (!s) return 0;
      var n = Date.parse(s);
      return isFinite(n) ? n : 0;
    }
    return 0;
  }
  function feedDayKey(ms){
    if (!ms) return '';
    return ymdFromDate(new Date(ms));
  }
  function feedDayLabel(ms){
    if (!ms) return 'Earlier';
    var d = new Date(ms);
    if (!isFinite(d.getTime())) return 'Earlier';
    var now = new Date();
    var key = feedDayKey(ms);
    if (key === feedDayKey(now.getTime())) return 'Today';
    var yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (key === feedDayKey(yest.getTime())) return 'Yesterday';
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(FEED_LOCALE, opts);
  }
  function feedTimeLabel(ms){
    if (!ms) return '';
    var d = new Date(ms);
    if (!isFinite(d.getTime())) return '';
    return d.toLocaleTimeString(FEED_LOCALE, { hour: '2-digit', minute: '2-digit' });
  }
  function feedDaySepHtml(ms){
    return '<div class="feed-day-sep" aria-hidden="true" style="display:flex;align-items:center;gap:10px;padding-top:6px"><span class="muted" style="font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;flex:0 0 auto">' + esc(feedDayLabel(ms)) + '</span><span style="flex:1;height:1px;background:#26282e"></span></div>';
  }
  function feedFirstChar(str){
    if (!str) return '';
    if (typeof Array.from === 'function') {
      var chars = Array.from(str);
      return chars.length ? chars[0] : '';
    }
    return str.charAt(0);
  }
  function feedInitials(name){
    var s = (typeof name === 'string' ? name : valueText(name, 0)).trim();
    if (!s) return '?';
    var parts = s.split(/\\s+/);
    var out = [];
    var i;
    for (i=0;i<parts.length;i++){ if (parts[i]) out.push(parts[i]); }
    if (!out.length) return '?';
    if (out.length === 1) {
      var one = out[0];
      var slice = (typeof Array.from === 'function') ? Array.from(one).slice(0, 2).join('') : capStr(one, 2);
      return (slice || '?').toUpperCase();
    }
    return ((feedFirstChar(out[0]) + feedFirstChar(out[1])) || '?').toUpperCase();
  }
  function feedHue(str){
    var s = typeof str === 'string' ? str : valueText(str, 0);
    var h = 0;
    var i;
    for (i=0;i<s.length;i++){
      h = (((h << 5) - h) + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 360;
  }
  function feedAvatarBg(name){
    return 'hsl(' + feedHue(name || '?') + ',35%,28%)';
  }
  function feedKindOf(kind){
    var k = (typeof kind === 'string' ? kind : '').trim().toLowerCase();
    if (k === 'created') return 'created';
    if (k === 'comment') return 'comment';
    return 'updated';
  }
  function feedKindLabel(kind){
    if (kind === 'created') return 'Created';
    if (kind === 'comment') return 'Comment';
    return 'Updated';
  }
  function feedKindPill(kind){
    var cls = kind === 'created' ? 'pill-t1' : (kind === 'comment' ? 'pill-t0' : 'pill-t2');
    return '<span class="pill ' + cls + '">' + esc(feedKindLabel(kind)) + '</span>';
  }
  function feedStr(o, camel, snake){
    if (!o || typeof o !== 'object') return '';
    var a = o[camel];
    if (typeof a === 'string' && a.trim()) return a;
    var b = o[snake];
    if (typeof b === 'string' && b.trim()) return b;
    return '';
  }
  function feedSensitiveField(slugOrName){
    var lower = (typeof slugOrName === 'string' ? slugOrName : '').toLowerCase();
    if (!lower) return false;
    if (/password/.test(lower)) return true;
    if (/passwd/.test(lower)) return true;
    if (/secret/.test(lower)) return true;
    if (/credential/.test(lower)) return true;
    if (/api[_-]?key/.test(lower)) return true;
    if (/access[_-]?token/.test(lower)) return true;
    if (/refresh[_-]?token/.test(lower)) return true;
    if (/auth[_-]?token/.test(lower)) return true;
    if (/private[_-]?key/.test(lower)) return true;
    if (/client[_-]?secret/.test(lower)) return true;
    if (/[_-]?token$/.test(lower)) return true;
    if (/bearer/.test(lower)) return true;
    if (/ssn/.test(lower)) return true;
    if (/social[_-]?security/.test(lower)) return true;
    return false;
  }
  function feedDiffText(v){
    if (v == null || v === '') return '(empty)';
    var t = valueText(v, 0);
    return t !== '' ? t : '(empty)';
  }
  function feedEventStamp(ev){
    var ms = feedStampMs(ev && ev.createdAt);
    if (ms) return ms;
    return feedStampMs(ev && ev.created_at);
  }
  function feedSafeId(raw, fallback){
    var id = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') return fallback;
    return id;
  }
  function feedCollectEvents(content){
    var raw = content && content.events;
    if (!Array.isArray(raw) || !raw.length) return [];
    var out = [];
    var seen = Object.create(null);
    var i, ev, id;
    for (i=0;i<raw.length && out.length<FEED_HARD_CAP;i++){
      ev = raw[i];
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) continue;
      id = feedSafeId(ev.id, 'ev-' + String(i));
      if (Object.prototype.hasOwnProperty.call(seen, id)) continue;
      seen[id] = 1;
      out.push(ev);
    }
    out.sort(function(a, b){ return feedEventStamp(b) - feedEventStamp(a); });
    return out;
  }
  function feedChangeLine(ch){
    if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return '';
    var label = feedStr(ch, 'field', 'slug') || 'Field';
    var fromTxt;
    var toTxt;
    if (feedSensitiveField(label) || feedSensitiveField(ch.slug) || feedSensitiveField(ch.field)) {
      fromTxt = FEED_HIDDEN;
      toTxt = FEED_HIDDEN;
    } else {
      fromTxt = feedDiffText(ch.from);
      toTxt = feedDiffText(ch.to);
    }
    return '<div style="font-size:11px;color:#9aa1ab;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px"><span style="font-weight:500;color:#c3c8d1">' + esc(label) + '</span>: <span style="text-decoration:line-through;opacity:.6">' + esc(fromTxt) + '</span> -> <span>' + esc(toTxt) + '</span></div>';
  }
  function feedEventCardHtml(ev){
    var kind = feedKindOf(ev.kind);
    var actor = feedStr(ev, 'actorName', 'actor_name') || 'Someone';
    var summary = feedStr(ev, 'summary', 'summary') || feedKindLabel(kind);
    var ms = feedEventStamp(ev);
    var payload = ev.payload && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? ev.payload : {};
    var source = feedStr(payload, 'source', 'source');
    var comment = feedStr(payload, 'comment', 'comment');
    if (!comment) comment = valueText(payload.comment, 0);
    var commentSliced = comment.length > FEED_COMMENT_CAP;
    comment = capStr(comment, FEED_COMMENT_CAP);
    var commentTrunc = payload.commentTruncated === true || commentSliced;
    var changes = Array.isArray(payload.changes) ? payload.changes : [];
    var changesTrunc = payload.changesTruncated === true;
    var time = feedTimeLabel(ms);
    var html = '<div class="row-card feed-ev" data-kind="' + esc(kind) + '" style="display:flex;gap:10px;align-items:flex-start">';
    html += '<span style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:999px;background:' + feedAvatarBg(actor) + ';color:#fff;font-size:10px;font-weight:700;flex:0 0 auto" aria-hidden="true">' + esc(feedInitials(actor)) + '</span>';
    html += '<div style="flex:1;min-width:0">';
    html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px">';
    html += '<div style="display:flex;align-items:center;gap:6px;min-width:0"><span class="row-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(actor) + '</span>';
    if (source) html += '<span class="muted" style="font-size:10px;flex:0 0 auto;max-width:7rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(source) + '</span>';
    html += '</div>';
    if (time) html += '<span class="muted" style="font-size:10px;flex:0 0 auto;font-variant-numeric:tabular-nums">' + esc(time) + '</span>';
    html += '</div>';
    html += '<div class="muted" style="margin-top:2px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">' + feedKindPill(kind) + '<span style="min-width:0;overflow-wrap:anywhere">' + esc(summary) + '</span></div>';
    if (kind === 'comment' && comment) {
      html += '<div class="doc-body" style="margin-top:6px;background:#0d0f13;border:1px solid #26282e;border-radius:8px;padding:6px 8px;white-space:pre-wrap;overflow-wrap:anywhere">' + esc(comment) + (commentTrunc ? '...' : '') + '</div>';
    }
    if (changes.length) {
      var shown = 0;
      var i;
      html += '<div style="margin-top:6px">';
      for (i=0;i<changes.length && shown<FEED_UI_CHANGE_CAP;i++){
        var line = feedChangeLine(changes[i]);
        if (!line) continue;
        html += line;
        shown++;
      }
      var extra = changes.length - shown;
      if (extra > 0) html += '<div class="muted" style="font-size:10px;margin-top:4px">+' + extra + ' more</div>';
      if (changesTrunc) html += '<div class="muted" style="font-size:10px;margin-top:2px">And more fields not listed</div>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }
  function feedFmtCount(n){
    n = typeof n === 'number' && isFinite(n) ? n : 0;
    try { return n.toLocaleString(FEED_LOCALE); } catch (err) { return String(n); }
  }
  function feedCountHint(shown, total, truncated, noun){
    var n = typeof shown === 'number' && isFinite(shown) ? shown : 0;
    var t = typeof total === 'number' && isFinite(total) ? total : n;
    var singular = noun.replace(/s$/, '');
    if (truncated || t > n) {
      return '<p class="hint">Showing newest ' + feedFmtCount(n) + ' of ' + feedFmtCount(t) + ' ' + noun + '.</p>';
    }
    return '<p class="hint">' + feedFmtCount(n) + ' ' + (n === 1 ? singular : noun) + '</p>';
  }
  function feedChipLabel(id, label, count, tilde){
    return '<label for="gfk-' + id + '" style="margin:0;cursor:pointer"><span class="feed-chip" style="display:inline-flex;align-items:center;height:28px;padding:0 10px;border:1px solid #26282e;border-radius:8px;background:#0a0b0e;color:#9aa1ab;font-size:11px">' + esc(label) + '<span style="margin-left:4px;font-variant-numeric:tabular-nums;opacity:.7">' + (tilde ? '~' : '') + feedFmtCount(count) + '</span></span></label>';
  }
  function feedFilterCss(){
    return '<style>'
      + '.feed-root>.feed-kind-radio{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0)}'
      + '.feed-root #gfk-all:checked~.feed-kind-bar label[for=gfk-all] .feed-chip,'
      + '.feed-root #gfk-created:checked~.feed-kind-bar label[for=gfk-created] .feed-chip,'
      + '.feed-root #gfk-updated:checked~.feed-kind-bar label[for=gfk-updated] .feed-chip,'
      + '.feed-root #gfk-comment:checked~.feed-kind-bar label[for=gfk-comment] .feed-chip{border-color:#3b82f6;background:rgba(59,130,246,.12);color:#e7e9ee}'
      + '.feed-root #gfk-created:checked~.stack.feed .feed-ev:not([data-kind=created]),'
      + '.feed-root #gfk-updated:checked~.stack.feed .feed-ev:not([data-kind=updated]),'
      + '.feed-root #gfk-comment:checked~.stack.feed .feed-ev:not([data-kind=comment]){display:none}'
      + '.feed-root #gfk-created:checked~.stack.feed .feed-day:not([data-kinds*=" created "]),'
      + '.feed-root #gfk-updated:checked~.stack.feed .feed-day:not([data-kinds*=" updated "]),'
      + '.feed-root #gfk-comment:checked~.stack.feed .feed-day:not([data-kinds*=" comment "]){display:none}'
      + '.feed-filter-empty{display:none;text-align:center;color:#9aa1ab;font-size:12px;padding:32px 0}'
      + '.feed-root #gfk-created:checked~.stack.feed:not(:has(.feed-ev[data-kind=created])) .feed-empty-created,'
      + '.feed-root #gfk-updated:checked~.stack.feed:not(:has(.feed-ev[data-kind=updated])) .feed-empty-updated,'
      + '.feed-root #gfk-comment:checked~.stack.feed:not(:has(.feed-ev[data-kind=comment])) .feed-empty-comment{display:block}'
      + '</style>';
  }
  function feedTotalOf(content, shown, fromRows){
    if (fromRows) {
      if (typeof content.total === 'number' && isFinite(content.total) && content.total >= shown) return content.total;
      return shown;
    }
    if (typeof content.eventTotal === 'number' && isFinite(content.eventTotal) && content.eventTotal >= shown) return content.eventTotal;
    if (typeof content.eventsTotal === 'number' && isFinite(content.eventsTotal) && content.eventsTotal >= shown) return content.eventsTotal;
    if (typeof content.total === 'number' && isFinite(content.total) && content.total >= shown) return content.total;
    return shown;
  }
  function feedIsTruncated(content, shown, total, fromRows){
    if (fromRows) return content.truncated === true || total > shown;
    return content.eventsTruncated === true || content.truncated === true || total > shown;
  }
  function feedRenderEventsHtml(content, events, fromRows){
    var shown = events.length;
    var total = feedTotalOf(content, shown, fromRows);
    var truncated = feedIsTruncated(content, shown, total, fromRows);
    var noun = fromRows ? 'records' : 'events';
    var counts = { all: shown, created: 0, updated: 0, comment: 0 };
    var i, ev, kind;
    for (i=0;i<events.length;i++){
      kind = feedKindOf(events[i] && events[i].kind);
      if (kind === 'created') counts.created++;
      else if (kind === 'comment') counts.comment++;
      else counts.updated++;
    }
    var html = '<div class="feed-root" data-guest-feed="1">';
    html += feedFilterCss();
    html += '<input class="feed-kind-radio" type="radio" name="guest-feed-kind" id="gfk-all" checked>';
    html += '<input class="feed-kind-radio" type="radio" name="guest-feed-kind" id="gfk-created">';
    html += '<input class="feed-kind-radio" type="radio" name="guest-feed-kind" id="gfk-updated">';
    html += '<input class="feed-kind-radio" type="radio" name="guest-feed-kind" id="gfk-comment">';
    html += feedCountHint(shown, total, truncated, noun);
    if (fromRows) {
      html += '<p class="hint">Creates, edits, and comments stay in the app. This page lists records as an activity stack.</p>';
    }
    html += '<div class="feed-kind-bar" style="display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px">';
    html += feedChipLabel('all', 'All', counts.all, false);
    html += feedChipLabel('created', 'Created', counts.created, truncated);
    html += feedChipLabel('updated', 'Updated', counts.updated, truncated);
    html += feedChipLabel('comment', 'Comments', counts.comment, truncated);
    html += '</div>';
    if (truncated) {
      html += '<p class="hint" style="margin-top:0">Chip counts cover the newest loaded ' + noun + ' only (of ' + feedFmtCount(total) + ' total).</p>';
    }
    html += '<div class="stack feed">';
    html += '<div class="feed-filter-empty feed-empty-created">No created events in this feed.</div>';
    html += '<div class="feed-filter-empty feed-empty-updated">No updated events in this feed.</div>';
    html += '<div class="feed-filter-empty feed-empty-comment">No comment events in this feed.</div>';
    var prevDay = null;
    var dayOpen = false;
    var kindsBag = ' ';
    var ms, day;
    function closeDay(){
      if (dayOpen) {
        html += '</div>';
        dayOpen = false;
      }
    }
    for (i=0;i<events.length;i++){
      ev = events[i];
      ms = feedEventStamp(ev);
      day = feedDayKey(ms);
      if (day !== prevDay) {
        closeDay();
        kindsBag = ' ';
        var j;
        for (j=i;j<events.length;j++){
          var d2 = feedDayKey(feedEventStamp(events[j]));
          if (d2 !== day) break;
          kindsBag += feedKindOf(events[j].kind) + ' ';
        }
        html += '<div class="feed-day" data-kinds="' + esc(kindsBag) + '">';
        html += feedDaySepHtml(ms);
        dayOpen = true;
        prevDay = day;
      }
      html += feedEventCardHtml(ev);
    }
    closeDay();
    html += '</div></div>';
    return html;
  }
  function feedPickFromRow(row, keys){
    if (!row || typeof row !== 'object') return 0;
    var i, ms;
    for (i=0;i<keys.length;i++){
      ms = feedStampMs(row[keys[i]]);
      if (ms) return ms;
    }
    var d = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    for (i=0;i<keys.length;i++){
      ms = feedStampMs(d[keys[i]]);
      if (ms) return ms;
    }
    var disp = row.display && typeof row.display === 'object' && !Array.isArray(row.display) ? row.display : {};
    for (i=0;i<keys.length;i++){
      ms = feedStampMs(disp[keys[i]]);
      if (ms) return ms;
    }
    return 0;
  }
  function feedRowStamp(row){
    return feedPickFromRow(row, ['updatedAt', 'updated_at', 'createdAt', 'created_at']);
  }
  function feedRowKind(row){
    var updated = feedPickFromRow(row, ['updatedAt', 'updated_at']);
    var created = feedPickFromRow(row, ['createdAt', 'created_at']);
    if (updated && created && updated > created) return 'updated';
    if (updated && !created) return 'updated';
    return 'created';
  }
  function feedRowActor(row, cols){
    var i, t, name;
    for (i=0;i<cols.length;i++){
      t = String(cols[i].field_type || '').toLowerCase();
      if (t === 'last_modified_by' || t === 'created_by' || t === 'user') {
        name = rowCellText(row, cols[i].slug);
        if (name) return name;
      }
    }
    return 'Someone';
  }
  function feedEventsFromRows(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows.slice() : [];
    if (!rows.length) return [];
    var titleSlug = titleSlugOf(content, cols);
    var out = [];
    var i, r, title, id, ms;
    var hasStamp = false;
    for (i=0;i<rows.length && out.length<FEED_HARD_CAP;i++){
      r = rows[i];
      if (!r || typeof r !== 'object') continue;
      id = feedSafeId(r.id, 'row-' + String(i));
      title = titleSlug ? rowCellText(r, titleSlug) : '';
      ms = feedRowStamp(r);
      if (ms) hasStamp = true;
      out.push({
        id: id,
        kind: feedRowKind(r),
        actorName: feedRowActor(r, cols),
        summary: title || 'Untitled',
        createdAt: ms,
        payload: {}
      });
    }
    if (hasStamp) out.sort(function(a, b){ return feedEventStamp(b) - feedEventStamp(a); });
    return out;
  }
  function renderFeedHtml(content){
    var events = feedCollectEvents(content);
    var fromRows = false;
    if (!events.length) {
      events = feedEventsFromRows(content);
      fromRows = events.length > 0;
    }
    if (!events.length) return feedEmptyHtml();
    return feedRenderEventsHtml(content, events, fromRows);
  }
`
