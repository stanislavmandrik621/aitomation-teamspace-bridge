/**
 * Guest Gallery read layout (public share / portal).
 *
 * Concatenate after GUEST_RENDER_JS so this later `function renderGalleryHtml`
 * wins. Parent already:
 * - paints a `.gallery` CSS grid of `.gallery-card` tiles (auto-fill, 4/3 cover)
 * - emits `<img class="gallery-img">` only after `isSafeHttpUrl` (http(s) only;
 *   javascript:/data:/attribute-breakout never become src)
 * - uses `.gallery-ph` when the cell is missing or refused
 * - titles from `titleFieldSlug` (else first column) with Untitled fallback
 *
 * Override vs parent: parent reads the image cell through `valueText`, which
 * misses `{url|path|src|href}` objects and joins URL arrays with ", " so the
 * http(s) gate never sees a real src. This snippet unwraps those shapes from
 * display first, then data, still gated by `isSafeHttpUrl` on every src
 * (local / file / data URLs cannot load on a public page).
 *
 * Read-only card chrome aligned with gallery-view.tsx (no create, no
 * lightbox, no Activate): primary cover, extra-thumb strip (3 slots), photo
 * count, overlay badges, subtitle, capped meta. Config keys: imageFieldSlug /
 * image_field, titleFieldSlug / title_field, subtitleFieldSlug /
 * subtitle_field, badgeFieldSlug / badge_field, badge2FieldSlug / badge2_field,
 * with the same auto-picks as `resolveAutoCardFieldSlugs` when a key is absent.
 *
 * Template-literal rule: no backticks, no ${ } in the embedded JS; double
 * backslashes in regex/string literals. Pure string -> string, no DOM.
 *
 * Gaps vs apps/desktop/src/components/views/gallery-view.tsx (stay off this page):
 * - Click-through to record detail, New record, column-density switch.
 * - Lightbox / zoom (useLocalMediaSrc, fileReadBase64, GALLERY_LIGHTBOX_URL_CAP).
 * - Local, relative, file://, and data: covers (guest is http(s) only).
 * - App CSP http:// refuse (MAUD-GAL-013); guest `isSafeHttpUrl` allows http.
 * - Initials-on-hue placeholder (existing guest theme + tests pin `.gallery-ph`).
 * - Button-field Activate, comment counts, attachment/deadline activity chips.
 * - Option-palette overlay chip colours (guest uses shared `cellHtml` pills).
 * - Settings stripSlots / maxExtraFields (`settings.views.gallery.*`); this
 *   page uses the desktop defaults (3 strip slots, 2 meta rows).
 * - subtitle_field / badge_field / badge2_field are not stamped on the share
 *   payload today (only titleFieldSlug + imageFieldSlug). This renderer still
 *   reads those keys when present and auto-detects like desktop.
 * - config.columns 2/3/4 (theme stays auto-fill minmax 200px).
 * - Empty copy stays "No rows to show yet." (no filter / page variants).
 * - Field-type aliases beyond image/file/url/text/select/status/rich_text
 *   (payload already sends canonical types).
 */

export const GUEST_VIEW_GALLERY_JS = `
  function guestGalleryCfgSlug(cfg, keys){
    for (var i = 0; i < keys.length; i++) {
      var s = cfg[keys[i]];
      if (typeof s === 'string' && s.trim()) return s.trim();
    }
    return '';
  }
  function guestGalleryHasSlug(cols, slug){
    if (!slug) return false;
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] && cols[i].slug === slug) return true;
    }
    return false;
  }
  function guestGalleryFieldType(cols, slug){
    if (!slug) return '';
    for (var i = 0; i < cols.length; i++) {
      if (cols[i] && cols[i].slug === slug) {
        return String(cols[i].field_type || '').toLowerCase();
      }
    }
    return '';
  }
  function guestGalleryFirstType(cols, types, skipSlug){
    for (var i = 0; i < cols.length; i++) {
      var t = String(cols[i].field_type || '').toLowerCase();
      if (skipSlug && cols[i].slug === skipSlug) continue;
      for (var j = 0; j < types.length; j++) {
        if (t === types[j]) return cols[i].slug;
      }
    }
    return '';
  }
  function guestGalleryLikelyImage(u){
    if (typeof u !== 'string') return false;
    var s = u.trim();
    if (!s) return false;
    return /\\.(jpg|jpeg|png|gif|webp|avif|svg)(\\?|$)/i.test(s);
  }
  function guestGalleryPushExtracted(raw, into, depth){
    depth = depth || 0;
    if (raw == null || raw === '' || depth > 2) return;
    if (into.length >= 40) return;
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (!s || s.length > 8192) return;
      if (s.charAt(0) === '[' || s.charAt(0) === '{') {
        try { guestGalleryPushExtracted(JSON.parse(s), into, depth + 1); return; }
        catch (err) { /* plain string */ }
      }
      if (s.indexOf(',') >= 0 && s.indexOf('data:') !== 0) {
        var first = s.split(',')[0];
        if (!/^https?:\\/\\//i.test(first)) {
          var parts = s.split(',');
          for (var p = 0; p < parts.length && into.length < 40; p++) {
            var part = parts[p].trim();
            if (part) into.push(part);
          }
          if (into.length) return;
        }
      }
      into.push(s);
      return;
    }
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length && i < 40 && into.length < 40; i++) {
        guestGalleryPushExtracted(raw[i], into, depth + 1);
      }
      return;
    }
    if (typeof raw === 'object') {
      var keys = ['url', 'path', 'src', 'href'];
      for (var k = 0; k < keys.length; k++) {
        var v = raw[keys[k]];
        if (typeof v === 'string' && v.trim()) {
          into.push(v.trim());
          return;
        }
      }
    }
  }
  function guestGalleryHttpUrlsFromCell(row, slug, requireLikely){
    if (!slug) return [];
    var extracted = [];
    if (rowHasDisplay(row, slug)) {
      guestGalleryPushExtracted(rowDisplayMap(row)[slug], extracted, 0);
    }
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    guestGalleryPushExtracted(d[slug], extracted, 0);
    var out = [];
    for (var i = 0; i < extracted.length && out.length < 40; i++) {
      var u = extracted[i];
      if (!isSafeHttpUrl(u)) continue;
      if (requireLikely && !guestGalleryLikelyImage(u)) continue;
      if (out.indexOf(u) >= 0) continue;
      out.push(u);
    }
    return out;
  }
  function guestGalleryCollectUrls(row, cols, imgSlug){
    var urls = [];
    var truncated = false;
    function absorb(slug, requireLikely){
      if (!slug) return;
      var more = guestGalleryHttpUrlsFromCell(row, slug, requireLikely);
      for (var i = 0; i < more.length; i++) {
        if (urls.length >= 40) { truncated = true; return; }
        if (urls.indexOf(more[i]) < 0) urls.push(more[i]);
      }
    }
    if (imgSlug) {
      var explicitType = guestGalleryFieldType(cols, imgSlug);
      absorb(imgSlug, explicitType === 'url' || explicitType === 'text');
    }
    for (var i = 0; i < cols.length; i++) {
      if (urls.length >= 40) { truncated = true; break; }
      var c = cols[i];
      if (!c || c.slug === imgSlug) continue;
      var t = String(c.field_type || '').toLowerCase();
      if (t === 'image' || t === 'file') absorb(c.slug, false);
      else if (t === 'url' || t === 'text') absorb(c.slug, true);
    }
    return { urls: urls, truncated: truncated };
  }
  function guestGalleryPreview(text){
    var s = typeof text === 'string' ? text : valueText(text, 0);
    s = s.replace(/<[^>]+>/g, ' ');
    s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
    s = s.replace(/\\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length <= 120) return capStr(s, 120);
    return capStr(s, 117) + '...';
  }
  function renderGalleryHtml(content){
    var GALLERY_STRIP_SLOTS = 3;
    var GALLERY_MAX_META = 2;
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    var titleSlug = guestGalleryCfgSlug(cfg, ['titleFieldSlug', 'title_field']);
    if (!guestGalleryHasSlug(cols, titleSlug)) {
      titleSlug = '';
      for (var ti = 0; ti < cols.length; ti++) {
        if (cols[ti].is_title === 1 || cols[ti].is_title === true) { titleSlug = cols[ti].slug; break; }
      }
      if (!titleSlug) titleSlug = titleSlugOf(content, cols);
    }
    var imgSlug = guestGalleryCfgSlug(cfg, ['imageFieldSlug', 'image_field']);
    if (!guestGalleryHasSlug(cols, imgSlug)) imgSlug = '';
    var subSlug = guestGalleryCfgSlug(cfg, ['subtitleFieldSlug', 'subtitle_field']);
    if (!guestGalleryHasSlug(cols, subSlug)) {
      subSlug = guestGalleryFirstType(cols, ['rich_text'], titleSlug);
      if (!subSlug) {
        for (var si = 0; si < cols.length; si++) {
          if (cols[si].slug === titleSlug) continue;
          if (String(cols[si].field_type || '').toLowerCase() === 'text') { subSlug = cols[si].slug; break; }
        }
      }
    }
    if (subSlug === titleSlug) subSlug = '';
    var badge1Slug = guestGalleryCfgSlug(cfg, ['badgeFieldSlug', 'badge_field']);
    if (!guestGalleryHasSlug(cols, badge1Slug)) badge1Slug = guestGalleryFirstType(cols, ['status', 'select'], titleSlug);
    if (badge1Slug === titleSlug) badge1Slug = '';
    var badge2Slug = guestGalleryCfgSlug(cfg, ['badge2FieldSlug', 'badge2_field']);
    if (!guestGalleryHasSlug(cols, badge2Slug)) badge2Slug = guestGalleryFirstType(cols, ['status', 'select'], badge1Slug);
    if (badge2Slug === titleSlug || badge2Slug === badge1Slug) badge2Slug = '';
    return '<div class="gallery">' + rows.map(function(r){
      var collected = guestGalleryCollectUrls(r, cols, imgSlug);
      var urls = collected.urls;
      var title = titleSlug ? rowCellText(r, titleSlug) : '';
      var alt = title ? title : 'Untitled';
      var primary = urls.length && isSafeHttpUrl(urls[0]) ? urls[0] : '';
      var img = primary
        ? '<img class="gallery-img" loading="lazy" alt="' + esc(alt) + '" src="' + esc(primary) + '"/>'
        : '<div class="gallery-ph"></div>';
      var badgeWrap = '';
      var b1 = '';
      var b2 = '';
      if (badge1Slug) {
        for (var bi = 0; bi < cols.length; bi++) {
          if (cols[bi].slug === badge1Slug) { b1 = cellHtml(cols[bi], r); break; }
        }
      }
      if (badge2Slug) {
        for (var bj = 0; bj < cols.length; bj++) {
          if (cols[bj].slug === badge2Slug) { b2 = cellHtml(cols[bj], r); break; }
        }
      }
      if (b1 || b2) {
        badgeWrap = '<div style="position:absolute;top:8px;left:8px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;max-width:calc(100% - 16px);pointer-events:none;z-index:1">' + b1 + b2 + '</div>';
      }
      var countWrap = '';
      if (urls.length > 1) {
        var countLabel = collected.truncated ? (String(urls.length) + '+ photos') : (String(urls.length) + ' photos');
        countWrap = '<div style="position:absolute;bottom:8px;right:8px;background:#00000080;color:#fff;font-size:10px;font-weight:500;padding:2px 6px;border-radius:4px;pointer-events:none;z-index:1">' + esc(countLabel) + '</div>';
      }
      var cover = '<div style="position:relative">' + img + badgeWrap + countWrap + '</div>';
      var strip = '';
      var extraEnd = 1 + GALLERY_STRIP_SLOTS;
      var extra = urls.slice(1, extraEnd);
      var remaining = urls.length - extraEnd;
      if (extra.length) {
        var thumbs = '';
        for (var ei = 0; ei < extra.length; ei++) {
          if (!isSafeHttpUrl(extra[ei])) continue;
          thumbs += '<div style="flex:1;min-width:0;height:40px;overflow:hidden;position:relative;background:#0d0f13">';
          thumbs += '<img loading="lazy" alt="" src="' + esc(extra[ei]) + '" style="display:block;width:100%;height:40px;object-fit:cover"/>';
          if (ei === extra.length - 1 && remaining > 0) {
            thumbs += '<div style="position:absolute;top:0;right:0;bottom:0;left:0;background:#00000099;color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;justify-content:center">+' + remaining + '</div>';
          }
          thumbs += '</div>';
        }
        if (thumbs) strip = '<div style="display:flex;gap:2px;height:40px;overflow:hidden">' + thumbs + '</div>';
      }
      var subtitle = subSlug ? guestGalleryPreview(rowCellText(r, subSlug)) : '';
      var subHtml = subtitle
        ? '<div class="muted" style="margin-top:4px;font-size:12px;line-height:1.45">' + esc(subtitle) + '</div>'
        : '';
      var kv = '';
      var shown = 0;
      for (var mi = 0; mi < cols.length && shown < GALLERY_MAX_META; mi++) {
        var c = cols[mi];
        var slug = c.slug;
        var ft = String(c.field_type || '').toLowerCase();
        if (slug === titleSlug || slug === imgSlug || slug === subSlug || slug === badge1Slug || slug === badge2Slug) continue;
        if (ft === 'image' || ft === 'file' || ft === 'json' || ft === 'button' || ft === 'formula' || ft === 'auto_id') continue;
        if (ft === 'url' || ft === 'text') {
          var cellUrls = guestGalleryHttpUrlsFromCell(r, slug, ft === 'url' || ft === 'text');
          var overlap = false;
          for (var ui = 0; ui < cellUrls.length; ui++) {
            if (urls.indexOf(cellUrls[ui]) >= 0) { overlap = true; break; }
          }
          if (overlap) continue;
        }
        var val = cellHtml(c, r);
        if (val === '') continue;
        kv += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || slug)) + '</div><div class="kv-v">' + val + '</div></div>';
        shown++;
      }
      var body = '<div class="gallery-title">' + (title ? esc(title) : '<span class="cell-muted">Untitled</span>') + subHtml + kv + '</div>';
      return '<div class="gallery-card">' + cover + strip + body + '</div>';
    }).join('') + '</div>';
  }
`
