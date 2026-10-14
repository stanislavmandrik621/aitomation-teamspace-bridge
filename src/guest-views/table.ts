/**
 * Guest Table read layout (public share / portal).
 *
 * Concatenate after GUEST_RENDER_CORE_JS so this `function renderTableHtml`
 * replaces the parent. Layout chrome stays the parent full-width card:
 * `.card.table-card` > `.table-wrap` > `table` (theme: table is
 * `width:max-content;min-width:100%`, wrap scrolls sideways, notes cells
 * keep a 280px floor so they do not collapse. Phone breakpoint does not
 * wrap every cell or turn board lanes into a stack).
 *
 * Parent already: `visibleFields` honors `content.columns` (payload strips
 * ACL / Hidden fields), choice/tag chips, long_text wrap span, phone nowrap
 * span, mailto / http(s) url, checkbox Yes/No. This override only closes
 * table-shaped gaps vs the in-app read table:
 * - wrap/nowrap on the td (theme `th,td{white-space:nowrap}` otherwise wins;
 *   phone cells stay nowrap at 640px via `.cell-nowrap`)
 * - tel: links (digits/+ only, 3-20 chars)
 * - person chips for user / relation / created_by / last_modified_by
 * - group section headers from `groupByFieldSlug` (payload stamp) or
 *   desktop `group_field`, select/status only when that field is in schema,
 *   Uncategorized + 200-char cap matching table-group-by.ts
 *
 * Do not add a second table renderer. Shared `cellHtml` / `chipsHtml` /
 * `emptyStateHtml` stay the cell ladder.
 *
 * Desktop extras that stay off the public page (edit chrome + payload):
 * - Sort headers, frozen columns, inline edit, row selection, add-row
 * - Column resize, density toggle, Hide columns, Undo, Actions
 * - Footers, color-rule fills, activity badges, click-through to a record
 * - Sticky thead (needs an opaque header bg the theme does not give)
 * - Empty-cell dash, formula eval, button fire, rating/progress widgets
 * - Image/file thumbs, embed previews, currency/percent/date locale fmt
 * - Tag overflow +3 (guest chipsHtml is +8), Settings preview caps
 *
 * Embedded JS: no backticks, no ${ }. Double backslashes in regex.
 */
export const GUEST_VIEW_TABLE_JS = `
  function tableFieldType(field){
    return String((field && field.field_type) || 'text').toLowerCase();
  }
  function tableTdClass(field){
    var t = tableFieldType(field);
    if (t === 'phone') return 'cell-nowrap';
    if (t === 'long_text' || t === 'rich_text' || t === 'notes') return 'cell-wrap';
    return '';
  }
  function tablePhoneHtml(row, slug){
    var text = rowCellText(row, slug);
    if (!text) return '';
    var tel = '';
    for (var i=0;i<text.length;i++){
      var ch = text.charAt(i);
      if ((ch >= '0' && ch <= '9') || ch === '+') tel += ch;
    }
    if (tel.length >= 3 && tel.length <= 20) {
      return '<a class="cell-nowrap" href="tel:' + esc(tel) + '">' + esc(text) + '</a>';
    }
    return '<span class="cell-nowrap">' + esc(text) + '</span>';
  }
  function tableCellHtml(field, row){
    var t = tableFieldType(field);
    var slug = field && typeof field.slug === 'string' ? field.slug : '';
    if (t === 'phone') return tablePhoneHtml(row, slug);
    if (t === 'user' || t === 'relation' || t === 'created_by' || t === 'last_modified_by') {
      var items = chipItems(row, slug);
      return items.length ? chipsHtml(items) : '';
    }
    return cellHtml(field, row);
  }
  function tableGroupLabel(row, slug){
    var label = rowCellText(row, slug).trim();
    if (!label) return 'Uncategorized';
    if (label.length > 200) return capStr(label, 197) + '...';
    return capStr(label, 200);
  }
  function tableGroupSlug(content, cols){
    var cfg = viewCfg(content);
    var slug = '';
    var keys = ['groupByFieldSlug', 'group_field'];
    var i, s, fields, found, t;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s === 'string' && s) { slug = s; break; }
    }
    if (!slug) return '';
    fields = Array.isArray(content && content.fields) ? content.fields : cols;
    found = null;
    for (i=0;i<fields.length;i++){
      if (fields[i] && fields[i].slug === slug) { found = fields[i]; break; }
    }
    if (!found) return slug;
    t = tableFieldType(found);
    if (t !== 'select' && t !== 'status') return '';
    return slug;
  }
  function tableDataRowHtml(cols, row){
    return '<tr>' + cols.map(function(c){
      var cls = tableTdClass(c);
      return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + tableCellHtml(c, row) + '</td>';
    }).join('') + '</tr>';
  }
  function renderTableHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var groupSlug = tableGroupSlug(content, cols);
    var thead = '<tr>' + cols.map(function(c){ return '<th>' + esc(fieldLabel(c.name || c.slug)) + '</th>'; }).join('') + '</tr>';
    var tbody = '';
    if (groupSlug) {
      var order = [];
      var buckets = Object.create(null);
      var i, key, list, r, g;
      for (i=0;i<rows.length;i++){
        key = tableGroupLabel(rows[i], groupSlug);
        if (!buckets[key]) { buckets[key] = []; order.push(key); }
        buckets[key].push(rows[i]);
      }
      for (g=0;g<order.length;g++){
        list = buckets[order[g]];
        tbody += '<tr><th colspan="' + String(cols.length) + '">' + esc(order[g]) + ' <span class="cell-muted">' + String(list.length) + '</span></th></tr>';
        for (r=0;r<list.length;r++) tbody += tableDataRowHtml(cols, list[r]);
      }
    } else {
      tbody = rows.map(function(row){ return tableDataRowHtml(cols, row); }).join('');
    }
    return '<div class="card table-card"><div class="table-wrap"><table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table></div></div>';
  }
`
