/**
 * Guest Doc view (read-only public share / portal).
 *
 * Concatenate AFTER GUEST_RENDER_JS so this `renderDocHtml` wins. Parent
 * already stacks title+body `.row-card` tiles in `.stack.doc-list`. Public
 * pages cannot mount TipTap, Yjs, the write toolbar, or Write / Split /
 * Preview, so this leaf keeps that stacked-card contract and paints the
 * desktop DocView read-only chrome a string-only page can: document jump
 * list, title + escaped body, heading outline, word/character counts,
 * 200000-character clamp (DOC_CONTENT_MAX_CHARS).
 *
 * Record bodies are always escaped (never raw HTML). TipTap HTML is
 * flattened to text with headings reconstructed from tags. Markdown is a
 * bounded subset (headings, lists, quotes, fences, bold/italic/strike,
 * http(s) links and images). `isSafeHttpUrl` gates every href/src.
 *
 * Depends on: esc, visibleFields, viewCfg, titleSlugOf, rowCellText,
 * rowTitleHtml, emptyStateHtml, rowIdOf, isSafeHttpUrl.
 *
 * Template-literal rules: no backticks, no ${ } in the embedded JS;
 * backslashes in regex/string literals are doubled.
 *
 * Gaps vs apps/desktop/src/components/views/doc-view.tsx (stay off this page):
 * - TipTap editor, Yjs live merge, awareness chips, caret publish.
 * - Write / Split / Preview, formatting toolbar, outline drag-resize.
 * - One-document selection, autosave, peer Keep mine / Use theirs,
 *   shorten-and-save for an oversized DB body.
 * - New record CTA; filter vs empty-list copy split.
 * - Full markdown preview (syntax highlight, math, copy, task widgets).
 * - Raw HTML preview (guest never injects unsanitized markup).
 * - Customize empty-state actions (pick / missing / wrong-type field).
 * - Project-relative images; only http(s) images pass the URL gate.
 */

export const GUEST_VIEW_DOC_JS = `
  function docTick(){
    return String.fromCharCode(96);
  }
  function docFenceMarks(){
    return docTick() + docTick() + docTick();
  }
  function docCfgString(cfg, camel, snake){
    if (cfg && typeof cfg[camel] === 'string' && cfg[camel].trim()) return cfg[camel].trim();
    if (cfg && typeof cfg[snake] === 'string' && cfg[snake].trim()) return cfg[snake].trim();
    return '';
  }
  function docNormType(raw){
    var t = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!t) return '';
    if (t === 'richtext' || t === 'longtext' || t === 'long_text' || t === 'textarea' || t === 'paragraph' || t === 'markdown' || t === 'notes') return 'rich_text';
    if (t === 'string' || t === 'short_text' || t === 'singleline' || t === 'single_line') return 'text';
    return t;
  }
  function docIsContentType(raw){
    var t = docNormType(raw);
    return t === 'text' || t === 'rich_text';
  }
  function docFindField(cols, token){
    var s = String(token == null ? '' : token).trim();
    if (!s) return null;
    var i, f, slug, id;
    for (i=0;i<cols.length;i++){
      f = cols[i];
      slug = typeof f.slug === 'string' ? f.slug.trim() : '';
      id = typeof f.id === 'string' ? f.id.trim() : '';
      if (slug && slug === s) return f;
      if (id && id === s) return f;
    }
    return null;
  }
  function docFmtInt(n){
    var v = typeof n === 'number' && isFinite(n) ? Math.floor(n) : 0;
    try { return v.toLocaleString('en-US'); }
    catch (err) { return String(v); }
  }
  function docEmptyHtml(title, desc){
    return '<div class="card"><div class="empty"><div class="row-title" style="margin-bottom:6px">' + esc(title) + '</div><div class="muted">' + esc(desc) + '</div></div></div>';
  }
  function docLooksLikeHtml(s){
    return /^\\s*</.test(String(s || ''));
  }
  function docDecodeEntities(s){
    return String(s || '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
  }
  function docHtmlToText(html){
    var s = String(html || '');
    s = s.replace(/<script[\\s\\S]*?<\\/script>/gi, '');
    s = s.replace(/<style[\\s\\S]*?<\\/style>/gi, '');
    s = s.replace(/<br\\s*\\/?>/gi, '\\n');
    s = s.replace(/<\\/p>/gi, '\\n');
    s = s.replace(/<\\/h[1-6]>/gi, '\\n');
    s = s.replace(/<\\/li>/gi, '\\n');
    s = s.replace(/<\\/div>/gi, '\\n');
    s = s.replace(/<[^>]+>/g, '');
    return docDecodeEntities(s);
  }
  function docRawBody(row, slug){
    if (!slug) return '';
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var raw = d[slug];
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
    if (raw && typeof raw === 'object') {
      try { return JSON.stringify(raw); }
      catch (err) { return rowCellText(row, slug); }
    }
    return rowCellText(row, slug);
  }
  function docClampText(raw){
    var text = String(raw == null ? '' : raw);
    var max = 200000;
    if (text.length <= max) return { text: text, truncated: false };
    var cut = text.slice(0, max);
    var last = cut.length ? cut.charCodeAt(cut.length - 1) : 0;
    if (last >= 55296 && last <= 56319) cut = cut.slice(0, -1);
    if (typeof cut.toWellFormed === 'function') cut = cut.toWellFormed();
    return { text: cut, truncated: true };
  }
  function docWordCount(s){
    var t = String(s || '').replace(/\\s+/g, ' ').trim();
    if (!t) return 0;
    return t.split(/\\s+/).length;
  }
  function docFenceOpen(ln){
    var t = String(ln || '').replace(/^\\s+/, '');
    return t.indexOf(docFenceMarks()) === 0 || t.indexOf('~~~') === 0;
  }
  function docHeadingSize(h){
    if (h <= 1) return '1.25rem';
    if (h === 2) return '1.125rem';
    if (h === 3) return '0.95rem';
    if (h === 4) return '0.875rem';
    if (h === 5) return '0.8125rem';
    return '0.75rem';
  }
  function docCollectMdToc(text, max){
    max = max || 200;
    var lines = String(text || '').split(/\\r?\\n/);
    var out = [];
    var inFence = false;
    var i, ln, m;
    for (i=0;i<lines.length && out.length<max;i++){
      ln = lines[i];
      if (docFenceOpen(ln)) { inFence = !inFence; continue; }
      if (inFence) continue;
      m = /^(#{1,6})\\s+(.+)$/.exec(ln);
      if (m) out.push({ level: m[1].length, text: m[2].replace(/#+\\s*$/, '').trim() });
    }
    return out;
  }
  function docCollectHtmlToc(html, max){
    max = max || 200;
    var out = [];
    var re = /<h([1-6])(?:\\s[^>]*)?>([\\s\\S]*?)<\\/h\\1>/gi;
    var m, text;
    while (out.length < max && (m = re.exec(String(html || '')))) {
      text = docHtmlToText(m[2]).replace(/\\s+/g, ' ').trim();
      if (text) out.push({ level: parseInt(m[1], 10), text: text });
    }
    return out;
  }
  function docAnchor(raw, fallback){
    var s = String(raw || '');
    var out = '';
    var i, c, ok;
    for (i=0;i<s.length && out.length<64;i++){
      c = s.charCodeAt(i);
      ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;
      if (ok) out += s.charAt(i);
    }
    return out ? ('gdoc-' + out) : fallback;
  }
  function docOutlineHtml(items, prefix){
    if (!items.length) return '';
    var html = '<div style="border-left:1px solid #26282e;padding:6px 0;margin:8px 0 10px">';
    html += '<div class="muted" style="font-size:.65rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:0 12px 6px">Outline</div>';
    var i, it, pad;
    for (i=0;i<items.length;i++){
      it = items[i];
      pad = 12 + Math.max(0, it.level - 1) * 10;
      html += '<a href="#' + prefix + '-h' + i + '" style="display:block;padding:3px 12px 3px ' + pad + 'px;font-size:.75rem;color:#9aa1ab">' + esc(it.text) + '</a>';
    }
    html += '</div>';
    return html;
  }
  function docEatUrl(s, start){
    var k = start;
    var ch;
    while (k < s.length){
      ch = s.charAt(k);
      if (ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r' || ch === ')' || ch === ']') break;
      k++;
    }
    var url = s.slice(start, k).replace(/[.,;:!?]+$/, '');
    return { url: url, next: start + url.length };
  }
  function docInlineHtml(raw, depth){
    depth = depth || 0;
    var s = String(raw || '');
    if (!s) return '';
    if (depth > 4) return esc(s);
    var tick = docTick();
    var out = '';
    var i = 0;
    var n = s.length;
    var j, end, label, url, eaten, low, imgEnd;
    while (i < n){
      if (s.charAt(i) === tick) {
        j = s.indexOf(tick, i + 1);
        if (j > i) {
          out += '<code style="background:#0d0f13;border:1px solid #26282e;border-radius:4px;padding:1px 4px;font-size:.8em">' + esc(s.slice(i + 1, j)) + '</code>';
          i = j + 1;
          continue;
        }
      }
      if (s.charAt(i) === '!' && s.charAt(i + 1) === '[') {
        j = s.indexOf('](', i + 2);
        if (j > i) {
          imgEnd = s.indexOf(')', j + 2);
          if (imgEnd > j) {
            label = s.slice(i + 2, j);
            url = s.slice(j + 2, imgEnd).trim();
            if (isSafeHttpUrl(url)) {
              out += '<img alt="' + esc(label) + '" src="' + esc(url) + '" style="max-width:100%;height:auto;border-radius:8px;display:block;margin:8px 0"/>';
              i = imgEnd + 1;
              continue;
            }
          }
        }
      }
      if (s.charAt(i) === '[') {
        j = s.indexOf('](', i + 1);
        if (j > i) {
          end = s.indexOf(')', j + 2);
          if (end > j) {
            label = s.slice(i + 1, j);
            url = s.slice(j + 2, end).trim();
            if (isSafeHttpUrl(url)) {
              out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + docInlineHtml(label, depth + 1) + '</a>';
              i = end + 1;
              continue;
            }
          }
        }
      }
      if (s.charAt(i) === '*' && s.charAt(i + 1) === '*') {
        end = s.indexOf('**', i + 2);
        if (end > i + 1) {
          out += '<strong>' + docInlineHtml(s.slice(i + 2, end), depth + 1) + '</strong>';
          i = end + 2;
          continue;
        }
      }
      if (s.charAt(i) === '~' && s.charAt(i + 1) === '~') {
        end = s.indexOf('~~', i + 2);
        if (end > i + 1) {
          out += '<s>' + docInlineHtml(s.slice(i + 2, end), depth + 1) + '</s>';
          i = end + 2;
          continue;
        }
      }
      if (s.charAt(i) === '*' ) {
        end = s.indexOf('*', i + 1);
        if (end > i) {
          out += '<em>' + docInlineHtml(s.slice(i + 1, end), depth + 1) + '</em>';
          i = end + 1;
          continue;
        }
      }
      low = s.slice(i, i + 8).toLowerCase();
      if (low.indexOf('https://') === 0 || low.indexOf('http://') === 0) {
        eaten = docEatUrl(s, i);
        if (isSafeHttpUrl(eaten.url)) {
          out += '<a href="' + esc(eaten.url) + '" target="_blank" rel="noopener noreferrer">' + esc(eaten.url) + '</a>';
          i = eaten.next;
          continue;
        }
      }
      j = i + 1;
      while (j < n){
        if (s.charAt(j) === tick || s.charAt(j) === '[' || s.charAt(j) === '*' || s.charAt(j) === '~' || s.charAt(j) === '!') break;
        if (s.slice(j, j + 4).toLowerCase() === 'http') break;
        j++;
      }
      out += esc(s.slice(i, j));
      i = j;
    }
    return out;
  }
  function docPreHtml(lines){
    var body = esc(lines.join('\\n'));
    return '<pre class="doc-body" style="background:#0d0f13;border:1px solid #26282e;border-radius:8px;padding:10px 12px;overflow-x:auto;white-space:pre-wrap;margin:8px 0"><code>' + body + '</code></pre>';
  }
  function docMdBodyHtml(text, prefix){
    var lines = String(text || '').split(/\\r?\\n/);
    var out = [];
    var inFence = false;
    var fenceBuf = [];
    var headingAt = 0;
    var para = [];
    var listKind = '';
    var listBuf = [];
    var quoteBuf = [];
    var i, ln, m, h, hid, item, flushPara, flushList, flushQuote, flushFence, openList;
    flushPara = function(){
      if (!para.length) return;
      out.push('<div class="doc-body">' + docInlineHtml(para.join('\\n')) + '</div>');
      para = [];
    };
    flushList = function(){
      if (!listBuf.length) return;
      var tag = listKind === 'ol' ? 'ol' : 'ul';
      var html = '<' + tag + ' class="doc-body" style="margin:6px 0 6px 1.2em;padding:0">';
      var li;
      for (li=0;li<listBuf.length;li++) html += '<li style="margin:2px 0">' + listBuf[li] + '</li>';
      html += '</' + tag + '>';
      out.push(html);
      listBuf = [];
      listKind = '';
    };
    flushQuote = function(){
      if (!quoteBuf.length) return;
      out.push('<blockquote class="doc-body" style="margin:8px 0;padding:4px 0 4px 12px;border-left:2px solid #26282e">' + docInlineHtml(quoteBuf.join('\\n')) + '</blockquote>');
      quoteBuf = [];
    };
    flushFence = function(){
      out.push(docPreHtml(fenceBuf));
      fenceBuf = [];
    };
    openList = function(kind, html){
      if (listKind && listKind !== kind) flushList();
      listKind = kind;
      listBuf.push(html);
    };
    for (i=0;i<lines.length;i++){
      ln = lines[i];
      if (docFenceOpen(ln)) {
        flushPara(); flushList(); flushQuote();
        if (inFence) { flushFence(); inFence = false; }
        else { inFence = true; fenceBuf = []; }
        continue;
      }
      if (inFence) { fenceBuf.push(ln); continue; }
      m = /^(#{1,6})\\s+(.+)$/.exec(ln);
      if (m) {
        flushPara(); flushList(); flushQuote();
        h = m[1].length;
        hid = prefix + '-h' + headingAt;
        headingAt += 1;
        out.push('<h' + h + ' id="' + hid + '" style="margin:12px 0 6px;font-size:' + docHeadingSize(h) + '">' + esc(m[2].replace(/#+\\s*$/, '').trim()) + '</h' + h + '>');
        continue;
      }
      if (/^\\s*---+$/.test(ln) || /^\\s*\\*\\*\\*+$/.test(ln)) {
        flushPara(); flushList(); flushQuote();
        out.push('<hr style="border:0;border-top:1px solid #26282e;margin:12px 0"/>');
        continue;
      }
      m = /^>\\s?(.*)$/.exec(ln);
      if (m) {
        flushPara(); flushList();
        quoteBuf.push(m[1]);
        continue;
      }
      if (quoteBuf.length) flushQuote();
      m = /^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.*)$/.exec(ln);
      if (m) {
        flushPara();
        item = '<span class="muted">' + (m[1] === ' ' ? '[ ]' : '[x]') + '</span> ' + docInlineHtml(m[2]);
        openList('ul', item);
        continue;
      }
      m = /^\\s*[-*]\\s+(.+)$/.exec(ln);
      if (m) {
        flushPara();
        openList('ul', docInlineHtml(m[1]));
        continue;
      }
      m = /^\\s*\\d+\\.\\s+(.+)$/.exec(ln);
      if (m) {
        flushPara();
        openList('ol', docInlineHtml(m[1]));
        continue;
      }
      if (listBuf.length) flushList();
      if (!ln.trim()) {
        flushPara();
        continue;
      }
      para.push(ln);
    }
    if (inFence) flushFence();
    flushQuote();
    flushList();
    flushPara();
    if (!out.length) return '';
    return out.join('');
  }
  function docHtmlBodyHtml(html, prefix){
    var s = String(html || '');
    var re = /<h([1-6])(?:\\s[^>]*)?>([\\s\\S]*?)<\\/h\\1>/gi;
    var out = [];
    var last = 0;
    var headingAt = 0;
    var m, before, text, h, hid;
    while ((m = re.exec(s))) {
      before = docHtmlToText(s.slice(last, m.index)).replace(/^\\s+|\\s+$/g, '');
      if (before) out.push('<div class="doc-body">' + esc(before).replace(/\\r?\\n/g, '<br/>') + '</div>');
      h = parseInt(m[1], 10);
      hid = prefix + '-h' + headingAt;
      headingAt += 1;
      text = docHtmlToText(m[2]).replace(/\\s+/g, ' ').trim();
      if (text) out.push('<h' + h + ' id="' + hid + '" style="margin:12px 0 6px;font-size:' + docHeadingSize(h) + '">' + esc(text) + '</h' + h + '>');
      last = m.index + m[0].length;
    }
    before = docHtmlToText(s.slice(last)).replace(/^\\s+|\\s+$/g, '');
    if (before) out.push('<div class="doc-body">' + esc(before).replace(/\\r?\\n/g, '<br/>') + '</div>');
    return out.join('');
  }
  function docBodySlugOf(content, cols, titleSlug){
    var cfg = viewCfg(content);
    var token = docCfgString(cfg, 'contentFieldSlug', 'content_field');
    var field, i, t, slug;
    if (token) {
      field = docFindField(cols, token);
      if (!field) return { slug: '', missing: token, wrongType: false };
      if (!docIsContentType(field.field_type)) return { slug: '', missing: '', wrongType: true };
      return { slug: field.slug, missing: '', wrongType: false };
    }
    for (i=0;i<cols.length;i++){
      t = docNormType(cols[i].field_type);
      slug = cols[i].slug;
      if ((t === 'rich_text') && slug && slug !== titleSlug) return { slug: slug, missing: '', wrongType: false };
    }
    for (i=0;i<cols.length;i++){
      t = docNormType(cols[i].field_type);
      slug = cols[i].slug;
      if ((t === 'text' || t === 'rich_text') && slug && slug !== titleSlug) return { slug: slug, missing: '', wrongType: false };
    }
    return { slug: '', missing: '', wrongType: false };
  }
  function docTitleSlugOf(content, cols){
    var cfg = viewCfg(content);
    var token = docCfgString(cfg, 'titleFieldSlug', 'title_field');
    var field = token ? docFindField(cols, token) : null;
    var i, t;
    if (field && field.slug) return field.slug;
    for (i=0;i<cols.length;i++){
      if (cols[i].is_title === true && cols[i].slug) return cols[i].slug;
    }
    for (i=0;i<cols.length;i++){
      t = docNormType(cols[i].field_type);
      if ((t === 'text' || t === 'rich_text') && cols[i].slug) return cols[i].slug;
    }
    return titleSlugOf(content, cols);
  }
  function renderDocHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length) return emptyStateHtml();
    if (!rows.length) return docEmptyHtml('No documents yet', 'This view has no documents to show.');
    var titleSlug = docTitleSlugOf(content, cols);
    var bodyInfo = docBodySlugOf(content, cols, titleSlug);
    if (bodyInfo.missing) {
      return docEmptyHtml('Body field missing', 'This view points at "' + bodyInfo.missing + '", which is not on this table.');
    }
    if (bodyInfo.wrongType) {
      return docEmptyHtml('Wrong field type', 'The body field must be text or long text.');
    }
    var bodySlug = bodyInfo.slug;
    var total = content && typeof content.total === 'number' && isFinite(content.total) ? content.total : rows.length;
    var pageNote = total > rows.length ? ('Showing ' + docFmtInt(rows.length) + ' of ' + docFmtInt(total)) : '';
    var nav = '';
    var articles = '';
    var i, r, aid, titleText, rawBody, clamped, body, isHtml, toc, words, chars, bodyHtml, footer;
    for (i=0;i<rows.length;i++){
      r = rows[i];
      aid = docAnchor(rowIdOf(r), 'gdoc-' + i);
      titleText = rowCellText(r, titleSlug);
      rawBody = bodySlug ? docRawBody(r, bodySlug) : '';
      clamped = docClampText(rawBody);
      body = clamped.text;
      isHtml = docLooksLikeHtml(body);
      toc = isHtml ? docCollectHtmlToc(body, 200) : docCollectMdToc(body, 200);
      words = docWordCount(body);
      chars = body.length;
      nav += '<a href="#' + aid + '" style="display:block;padding:8px 12px;font-size:.75rem;border-bottom:1px solid #1e2126;color:' + (i === 0 ? '#e7e9ee' : '#9aa1ab') + '">' + (titleText ? esc(titleText) : '<span class="cell-muted">Untitled</span>') + '</a>';
      if (!body.trim()) {
        bodyHtml = '<p class="muted" style="margin:8px 0;font-size:.75rem;font-style:italic">This document has no body yet.</p>';
      } else if (isHtml) {
        bodyHtml = docHtmlBodyHtml(body, aid);
      } else {
        bodyHtml = docMdBodyHtml(body, aid);
      }
      footer = '<div class="muted" style="margin-top:10px;font-size:.65rem;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;border-top:1px solid #26282e;padding-top:8px">';
      footer += '<span>' + docFmtInt(words) + (words === 1 ? ' word' : ' words') + ' - ' + docFmtInt(chars) + ' characters</span>';
      footer += '<span>Markdown supported</span></div>';
      articles += '<div id="' + aid + '" class="row-card" style="min-width:0">';
      articles += rowTitleHtml(r, titleSlug);
      if (clamped.truncated) {
        articles += '<p class="hint" style="margin:6px 0 0">This document is longer than 200,000 characters. The public page shows a shortened copy.</p>';
      }
      articles += docOutlineHtml(toc, aid);
      articles += bodyHtml;
      articles += footer;
      articles += '</div>';
    }
    return '<div class="stack doc-list">'
      + '<p class="hint" style="margin:0">View only. You can read these documents, not edit them.</p>'
      + '<div class="card" style="padding:0;margin-top:0">'
      + '<div class="muted" style="padding:8px 12px;border-bottom:1px solid #26282e;font-size:.7rem">Documents' + (pageNote ? (' - ' + esc(pageNote)) : '') + '</div>'
      + nav
      + '</div>'
      + articles
      + '</div>';
  }
`
