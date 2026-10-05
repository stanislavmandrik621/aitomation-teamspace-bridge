/** Read-only Scrum board: the same backlog classification and point totals as desktop. */
export const GUEST_VIEW_SCRUM_JS = `
  var guestScrumContent = null;
  var guestScrumSelected = '';
  function guestScrumIsScrumType(vt){
    var t = String(vt || '').trim().toLowerCase().replace(/[\\s-]+/g, '_');
    return t === 'scrum' || t === 'scrum_board' || t === 'sprint_board';
  }
  function guestScrumChoice(value){
    return guestKanbanChoiceKey(value, 0);
  }
  function renderScrumHtml(content){
    guestScrumContent = content;
    var cols = visibleFields(content), cfg = viewCfg(content);
    var status = cfg.groupByFieldSlug || cfg.statusFieldSlug || cfg.status_field;
    var sprint = cfg.sprintFieldSlug || cfg.sprint_field;
    var points = cfg.pointsFieldSlug || cfg.points_field;
    var sf = guestKanbanFieldBySlug(cols, status), sp = guestKanbanFieldBySlug(cols, sprint);
    var pf = guestKanbanFieldBySlug(cols, points);
    if (!sf || !sp || status === sprint || ['select','status'].indexOf(sf.field_type) < 0 || ['select','status'].indexOf(sp.field_type) < 0) {
      return '<div class="card"><div class="empty">Status and sprint fields are unavailable<div class="muted">This board needs two different visible select or status fields.</div></div></div>';
    }
    if (!pf || ['number','currency','percent','rating'].indexOf(pf.field_type) < 0) points = '';
    var rows = Array.isArray(content.rows) ? content.rows : [], opt = guestKanbanReadOptions(sf);
    var lanes = Object.create(null), order = [], sprints = [], backlog = [], seen = Object.create(null);
    function lane(key){ if (!Object.prototype.hasOwnProperty.call(lanes,key)) { lanes[key] = []; order.push(key); } return lanes[key]; }
    opt.keys.forEach(lane);
    rows.forEach(function(row){
      var id = rowIdOf(row); if (id && seen[id]) return; if (id) seen[id] = true;
      var data = row.data || {}, s = guestScrumChoice(data[sprint]);
      if (!s || s.toLowerCase() === 'backlog') { backlog.push(row); return; }
      if (sprints.indexOf(s) < 0) sprints.push(s);
    });
    sprints.sort(function(a,b){return a.localeCompare(b);});
    if (guestScrumSelected && sprints.indexOf(guestScrumSelected) < 0) guestScrumSelected = '';
    rows.forEach(function(row){
      var data = row.data || {}, s = guestScrumChoice(data[sprint]);
      if (!s || s.toLowerCase() === 'backlog' || guestScrumSelected && s !== guestScrumSelected) return;
      var key = guestScrumChoice(data[status]); key = opt.alias[key] || key || GUEST_KANBAN_UNCATEGORIZED;
      var list = lane(key), id = rowIdOf(row);
      if (!id || !list.some(function(other){return rowIdOf(other) === id;})) list.push(row);
    });
    lane(GUEST_KANBAN_UNCATEGORIZED);
    order = order.filter(function(k){return k !== GUEST_KANBAN_UNCATEGORIZED;}).concat([GUEST_KANBAN_UNCATEGORIZED]);
    var title = titleSlugOf(content, cols), image = cfg.imageFieldSlug || '', desc = cfg.descriptionFieldSlug || cfg.description_field || '';
    var metaCols = cols.filter(function(f){return f.slug !== sprint && f.slug !== points;});
    function column(key,label,list){
      var total = 0, cards = list.map(function(row){
        var n = row.data && row.data[points];
        if (typeof n === 'string' && n.trim()) n = Number(n.trim());
        if (typeof n === 'number' && isFinite(n)) total += n;
        var sprintLabel = guestScrumChoice(row.data && row.data[sprint]);
        var footer = key !== '__backlog__' && !guestScrumSelected && sprintLabel ? '<div class="muted" style="margin-top:4px;font-size:.7rem">'+esc(sprintLabel)+'</div>' : '';
        return guestKanbanCardHtml(row, metaCols, title, status, image, desc, 4, footer);
      }).join('');
      return '<section class="lane"'+(opt.colors[key] ? ' style="border-color:'+esc(opt.colors[key])+'"' : '')+' data-scrum-lane="'+esc(key)+'"><div class="lane-head"><span>'+esc(label)+'</span><span class="lane-count">'+list.length+'</span>'+(points && total > 0 ? '<span>'+esc(String(total))+' pts</span>' : '')+'</div>'+cards+'</section>';
    }
    var html = '<div data-guest-scrum-root="1"><div class="scrum-filters" aria-label="Sprint filter"><button type="button" data-scrum-sprint="" aria-pressed="'+String(!guestScrumSelected)+'">All active sprints</button>';
    sprints.forEach(function(s){html += '<button type="button" data-scrum-sprint="'+esc(s)+'" aria-pressed="'+String(s === guestScrumSelected)+'">'+esc(s)+'</button>';});
    html += '</div>'+(content.truncated ? '<p class="hint">This page shows a capped set of records.</p>' : '')+'<div class="board" data-guest-scrum="1">'+column('__backlog__','Backlog',backlog);
    order.forEach(function(k){html += column(k,k === GUEST_KANBAN_UNCATEGORIZED ? 'No status' : opt.labels[k] || k,lanes[k]);});
    return html + '</div></div>';
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('click', function(event){
    var button = event.target && event.target.closest && event.target.closest('[data-scrum-sprint]');
    if (!button || !guestScrumContent) return;
    var root = button.closest('[data-guest-scrum-root]'); if (!root) return;
    guestScrumSelected = button.getAttribute('data-scrum-sprint') || '';
    var restoreFocus = document.activeElement === button;
    root.outerHTML = renderScrumHtml(guestScrumContent);
    if (restoreFocus) {
      var current = document.querySelector('[data-guest-scrum-root]');
      if (current) Array.prototype.forEach.call(current.querySelectorAll('[data-scrum-sprint]'),function(next){
        if (next.getAttribute('data-scrum-sprint') === guestScrumSelected) next.focus();
      });
    }
  });
  if (typeof renderBoardHtml === 'function') {
    var _guestScrumParentBoardHtml = renderBoardHtml;
    renderBoardHtml = function(content){return guestScrumIsScrumType(content && content.viewType) ? renderScrumHtml(content) : _guestScrumParentBoardHtml(content);};
  }
`
