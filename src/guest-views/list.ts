/**
 * Guest List layout (read-only public share / portal).
 *
 * Parent `renderListHtml` already stacks `.row-card` inside `.stack` (feed and
 * form-read reuse that with an extra wrap class). This leaf replaces that
 * body so each card matches the in-app list-view.tsx READ-ONLY chrome:
 * 36px cover or initials, truncated title, description under the title,
 * status badge, wrapping Label: value meta (defaults 4 / 2 / 80), and a
 * 640px pass that keeps title ellipsis + wrapping chips (does not use
 * `.kv`, so the theme's 640px column stack cannot restyle list meta).
 *
 * Concatenate after the shared helpers in GUEST_RENDER_JS (`esc`,
 * `visibleFields`, `titleSlugOf`, `viewCfg`, `cellHtml`, `rowCellText`,
 * `chipItems`, `chipClass`, `isSafeHttpUrl`, `emptyStateHtml`,
 * `isTruthyCell`).
 *
 * Embedded JS: no backticks, no ${ } (this string is itself a template
 * literal). Backslashes in regexes are doubled.
 *
 * Gaps vs desktop list-view.tsx (guest cannot close these in this leaf):
 * - No row selection, bulk edit/delete/duplicate, New record, or inline edit.
 * - No click-through to a record detail.
 * - No nested-child counts or Add nested (payload rows have no parent_id).
 * - No activity badges (deadline / attachments / comments).
 * - No view color-rule inset / soft fill (color_rules not on viewConfig).
 * - badge_field / description_field / hiddenFields are not stamped on the
 *   share payload today (only titleFieldSlug + imageFieldSlug). This renderer
 *   still reads those keys when present and auto-detects like desktop.
 * - Local / project-relative covers cannot load (http(s) only); initials
 *   stand in. Formula/button are not evaluated here.
 * - Settings maxMetaFields / maxTagsShown / textPreviewLength are app-only;
 *   this page uses the desktop defaults (4 meta, 2 tags, 80-char text,
 *   120-char description under the title).
 * - Empty copy stays the shared "No rows to show yet." (no filter/page
 *   variants).
 * - Cards stay separate `.row-card` tiles (parent contract), not one bordered
 *   list with divider rows.
 * - Checkbox meta shows only Yes (unchecked omitted), matching desktop.
 */
export const GUEST_VIEW_LIST_JS = `
  function renderListHtml(content, wrapClass){
    var LIST_MAX_META = 4;
    var LIST_MAX_TAGS = 2;
    var LIST_DESC_MAX = 120;
    var LIST_TEXT_PREVIEW = 80;
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var cfg = viewCfg(content);
    function cfgSlug(keys){
      for (var i=0;i<keys.length;i++){
        var s = cfg[keys[i]];
        if (typeof s === 'string' && s.trim()) return s.trim();
      }
      return '';
    }
    function hasSlug(slug){
      if (!slug) return false;
      for (var i=0;i<cols.length;i++){
        if (cols[i].slug === slug) return true;
      }
      return false;
    }
    function fieldTypeOf(field){
      var t = String((field && field.field_type) || '').toLowerCase();
      if (t === 'long_text' || t === 'longtext' || t === 'notes' || t === 'textarea' || t === 'markdown') return 'rich_text';
      return t;
    }
    function isMediaType(t){ return t === 'image' || t === 'file'; }
    function isDescType(t){ return t === 'rich_text'; }
    function isAlwaysShow(t){
      return t === 'formula' || t === 'button' || t === 'auto_id' || t === 'created_at' || t === 'updated_at' || t === 'created_by' || t === 'last_modified_by' || t === 'count';
    }
    function hiddenSet(){
      var raw = Array.isArray(cfg.hiddenFields) ? cfg.hiddenFields
        : (Array.isArray(cfg.hidden_fields) ? cfg.hidden_fields : []);
      var out = Object.create(null);
      for (var i=0;i<raw.length;i++){
        if (typeof raw[i] === 'string' && raw[i]) out[raw[i]] = true;
      }
      return out;
    }
    function listHttpSrc(raw, depth){
      depth = depth || 0;
      if (raw == null || raw === '' || depth > 2) return '';
      if (typeof raw === 'string') {
        var s = raw.trim();
        if (!s) return '';
        if (isSafeHttpUrl(s)) return s;
        if (s.length > 8192) return '';
        if (s.charAt(0) === '[' || s.charAt(0) === '{') {
          try { return listHttpSrc(JSON.parse(s), depth + 1); }
          catch (err) { return ''; }
        }
        return '';
      }
      if (Array.isArray(raw)) {
        for (var i=0;i<raw.length && i<8;i++){
          var fromItem = listHttpSrc(raw[i], depth + 1);
          if (fromItem) return fromItem;
        }
        return '';
      }
      if (typeof raw === 'object') {
        var keys = ['url','src','path','href'];
        for (var k=0;k<keys.length;k++){
          if (typeof raw[keys[k]] === 'string') {
            var t = raw[keys[k]].trim();
            if (isSafeHttpUrl(t)) return t;
          }
        }
      }
      return '';
    }
    function isLikelyImageSrc(u){
      if (typeof u !== 'string') return false;
      return /\\.(jpg|jpeg|png|gif|webp|avif|svg)(\\?|$)/i.test(u.trim());
    }
    function coverSrcForSlug(row, slug){
      if (!slug) return '';
      if (rowHasDisplay(row, slug)) {
        var fromDisp = listHttpSrc(rowDisplayMap(row)[slug], 0);
        if (fromDisp) return fromDisp;
      }
      var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
      var fromData = listHttpSrc(d[slug], 0);
      if (fromData) return fromData;
      var text = rowCellText(row, slug);
      if (text && isSafeHttpUrl(text.trim())) return text.trim();
      return '';
    }
    function coverSrc(row, imgSlug, titleSlug){
      var u = coverSrcForSlug(row, imgSlug);
      if (u) return u;
      var i, t, f;
      for (i=0;i<cols.length;i++){
        f = cols[i];
        t = fieldTypeOf(f);
        if (t !== 'image') continue;
        if (f.slug === imgSlug) continue;
        u = coverSrcForSlug(row, f.slug);
        if (u) return u;
      }
      for (i=0;i<cols.length;i++){
        f = cols[i];
        if (f.slug === titleSlug || f.slug === imgSlug) continue;
        t = fieldTypeOf(f);
        if (t !== 'url' && t !== 'text') continue;
        u = coverSrcForSlug(row, f.slug);
        if (u && isLikelyImageSrc(u)) return u;
      }
      return '';
    }
    function listChars(s, n){
      var out = [];
      var i = 0;
      while (i < s.length && out.length < n) {
        var c = s.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
          out.push(s.slice(i, i + 2));
          i += 2;
        } else {
          out.push(s.charAt(i));
          i += 1;
        }
      }
      return out.join('');
    }
    function initialsOf(title){
      var s = (typeof title === 'string' ? title : valueText(title, 0)).trim();
      if (!s) return '?';
      var parts = s.split(/\\s+/);
      var words = [];
      for (var w=0;w<parts.length;w++) if (parts[w]) words.push(parts[w]);
      if (!words.length) return '?';
      if (words.length === 1) {
        var one = listChars(words[0], 2).toUpperCase();
        return one || '?';
      }
      var two = (listChars(words[0], 1) + listChars(words[1], 1)).toUpperCase();
      return two || '?';
    }
    function hueOf(title){
      var h = 0;
      var s = typeof title === 'string' ? title : valueText(title, 0);
      for (var i=0;i<s.length;i++) h = ((h<<5)-h+s.charCodeAt(i))|0;
      return Math.abs(h) % 360;
    }
    function preview(text, max){
      var s = typeof text === 'string' ? text : valueText(text, 0);
      s = s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ');
      s = s.replace(/\\r?\\n/g, ' ').replace(/\\s+/g, ' ').trim();
      if (!s) return '';
      if (s.length <= max) return capStr(s, max);
      return capStr(s, Math.max(0, max - 3)) + '...';
    }
    function listChipsHtml(items){
      var out = '';
      var max = LIST_MAX_TAGS;
      for (var i=0;i<items.length && i<max;i++){
        out += '<span class="pill ' + chipClass(items[i]) + '">' + esc(items[i]) + '</span>';
      }
      if (items.length > max) out += '<span class="pill pill-more">+' + (items.length - max) + '</span>';
      return out ? '<span class="pills">' + out + '</span>' : '';
    }
    function listTitleHtml(row, titleSlug){
      var title = titleSlug ? rowCellText(row, titleSlug) : '';
      return '<div class="row-title">' + (title ? esc(title) : '<span class="cell-muted">(Untitled)</span>') + '</div>';
    }
    function listFieldVal(field, row){
      var t = fieldTypeOf(field);
      var slug = field && typeof field.slug === 'string' ? field.slug : '';
      if (t === 'tags' || t === 'multiselect' || t === 'select' || t === 'status') {
        return listChipsHtml(chipItems(row, slug));
      }
      if (t === 'text') {
        var p = preview(rowCellText(row, slug), LIST_TEXT_PREVIEW);
        return p ? esc(p) : '';
      }
      if (t === 'auto_id') {
        var id = row && typeof row.id === 'string' ? row.id : '';
        if (id) return '<code style="font-size:10px;color:#9aa1ab">' + esc(id.slice(0, 8)) + '</code>';
      }
      return cellHtml(field, row);
    }
    function listShareCss(){
      return '<style>' +
        '.list-share .row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.35}' +
        '.list-row{display:flex;align-items:flex-start;gap:12px;min-width:0}' +
        '.list-thumb{flex:0 0 36px;width:36px;height:36px;border-radius:8px;overflow:hidden;border:1px solid #26282e}' +
        '.list-thumb img,.list-ph{display:block;width:36px;height:36px}' +
        '.list-ph{display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#fff}' +
        '.list-body{flex:1;min-width:0}' +
        '.list-head{display:flex;align-items:flex-start;gap:10px;min-width:0}' +
        '.list-title-block{flex:1;min-width:0}' +
        '.list-desc{margin-top:2px;font-size:11px;color:#9aa1ab;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
        '.list-badge{flex:0 0 auto;max-width:42%;margin-top:2px}' +
        '.list-meta{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:6px}' +
        '.list-meta-i{display:flex;align-items:center;gap:4px;min-width:0}' +
        '.list-meta-k{font-size:10px;color:#6b7280;flex:0 0 auto}' +
        '.list-meta-v{min-width:0;overflow:hidden}' +
        '@media (max-width:640px){' +
          '.list-share .row-card{padding:12px}' +
          '.list-row{gap:10px}' +
          '.list-badge{max-width:38%}' +
          '.list-meta{gap:6px 10px}' +
        '}' +
      '</style>';
    }
    var hidden = hiddenSet();
    var titleSlug = cfgSlug(['titleFieldSlug','title_field']);
    if (!hasSlug(titleSlug)) {
      titleSlug = '';
      for (var ti=0;ti<cols.length;ti++){
        if (cols[ti].is_title === true || cols[ti].is_title === 1) { titleSlug = cols[ti].slug; break; }
      }
      if (!titleSlug) titleSlug = titleSlugOf(content, cols);
    }
    var badgeSlug = cfgSlug(['badgeFieldSlug','badge_field']);
    if (!hasSlug(badgeSlug)) {
      badgeSlug = '';
      for (var bi=0;bi<cols.length;bi++){
        if (fieldTypeOf(cols[bi]) === 'status') { badgeSlug = cols[bi].slug; break; }
      }
      if (!badgeSlug) {
        for (var bj=0;bj<cols.length;bj++){
          if (fieldTypeOf(cols[bj]) === 'select') { badgeSlug = cols[bj].slug; break; }
        }
      }
    }
    if (badgeSlug === titleSlug) badgeSlug = '';
    var imgSlug = cfgSlug(['imageFieldSlug','image_field']);
    if (!hasSlug(imgSlug)) {
      imgSlug = '';
      for (var ii=0;ii<cols.length;ii++){
        if (fieldTypeOf(cols[ii]) === 'image') { imgSlug = cols[ii].slug; break; }
      }
    }
    var descSlug = cfgSlug(['descriptionFieldSlug','description_field']);
    if (!hasSlug(descSlug)) {
      descSlug = '';
      for (var di=0;di<cols.length;di++){
        if (!isDescType(fieldTypeOf(cols[di]))) continue;
        if (cols[di].slug === titleSlug) continue;
        descSlug = cols[di].slug;
        break;
      }
    }
    if (descSlug === titleSlug) descSlug = '';
    var wrap = wrapClass ? String(wrapClass) : 'stack';
    if (!/^[a-z0-9 -]+$/i.test(wrap)) wrap = 'stack';
    if ((' ' + wrap + ' ').indexOf(' list-share ') < 0) wrap += ' list-share';
    return listShareCss() + '<div class="' + wrap + '">' + rows.map(function(r){
      var titleText = titleSlug ? rowCellText(r, titleSlug) : '';
      var titleLabel = titleText || '(Untitled)';
      var src = coverSrc(r, imgSlug, titleSlug);
      var thumbInner = src
        ? '<img loading="lazy" alt="' + esc(titleLabel) + '" src="' + esc(src) + '"/>'
        : '<div class="list-ph" style="background:hsl(' + hueOf(titleLabel) + ',45%,30%)">' + esc(initialsOf(titleLabel)) + '</div>';
      var thumb = '<div class="list-thumb">' + thumbInner + '</div>';
      var desc = descSlug ? preview(rowCellText(r, descSlug), LIST_DESC_MAX) : '';
      var descHtml = desc ? '<div class="list-desc">' + esc(desc) + '</div>' : '';
      var badgeHtml = '';
      if (badgeSlug) {
        var badgeField = null;
        for (var bfi=0;bfi<cols.length;bfi++){
          if (cols[bfi].slug === badgeSlug) { badgeField = cols[bfi]; break; }
        }
        if (badgeField) {
          var b = listFieldVal(badgeField, r);
          if (b) badgeHtml = '<div class="list-badge">' + b + '</div>';
        }
      }
      var kv = '';
      var shown = 0;
      for (var i=0;i<cols.length && shown<LIST_MAX_META;i++){
        var c = cols[i];
        var slug = c.slug;
        var t = fieldTypeOf(c);
        if (slug === titleSlug || slug === badgeSlug) continue;
        if (isMediaType(t) || isDescType(t) || t === 'json') continue;
        if (hidden[slug]) continue;
        if (t === 'checkbox') {
          var d = r && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : {};
          if (!isTruthyCell(d[slug]) && !isTruthyCell(rowCellText(r, slug))) continue;
        }
        var val = listFieldVal(c, r);
        if (val === '' && !isAlwaysShow(t)) continue;
        if (val === '') continue;
        kv += '<div class="list-meta-i"><span class="list-meta-k">' + esc(fieldLabel(c.name || slug)) + ':</span><span class="list-meta-v">' + val + '</span></div>';
        shown++;
      }
      var metaHtml = kv ? '<div class="list-meta">' + kv + '</div>' : '';
      var body = '<div class="list-row">' + thumb
        + '<div class="list-body"><div class="list-head">'
        + '<div class="list-title-block">' + listTitleHtml(r, titleSlug) + descHtml + '</div>'
        + badgeHtml + '</div>' + metaHtml + '</div></div>';
      return '<div class="row-card">' + body + '</div>';
    }).join('') + '</div>';
  }
`
