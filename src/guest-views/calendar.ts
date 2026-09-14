/**
 * Guest calendar override. Concatenate AFTER GUEST_RENDER_JS so this
 * `renderCalendarHtml` replaces the parent. Depends on esc, visibleFields,
 * viewCfg, titleSlugOf, rowDateKey, rowCellText, ymdFromValue, ymdFromDate,
 * emptyStateHtml.
 *
 * Read-only calendar with the saved range and local navigation, matching
 * calendar-view.tsx. Never a <table>, never a .date-board / No date strip. Undated
 * rows stay off the grid and are named in the footer. No backticks and
 * no ${ } inside the embedded JS (this file is itself a template literal).
 */

export const GUEST_VIEW_CALENDAR_JS = `
  var CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var CAL_DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var CAL_PILL_CAP = 3;
  var CAL_SPAN_DAY_CAP = 366;
  var CAL_MONTH_CAP = 12;

  function calIsDateType(ft){
    var t = String(ft || '').toLowerCase();
    return t === 'date' || t === 'datetime' || t === 'date_range';
  }

  function calPickDateSlug(content, cols){
    var cfg = viewCfg(content);
    var keys = ['dateFieldSlug','date_field','dateField'];
    var i, j, s;
    for (i=0;i<keys.length;i++){
      s = cfg[keys[i]];
      if (typeof s !== 'string' || !s) continue;
      for (j=0;j<cols.length;j++){
        if (cols[j] && cols[j].slug === s) return s;
      }
    }
    for (j=0;j<cols.length;j++){
      if (cols[j] && calIsDateType(cols[j].field_type)) return cols[j].slug;
    }
    return '';
  }

  function calFieldType(cols, slug){
    var i, t;
    for (i=0;i<cols.length;i++){
      if (cols[i] && cols[i].slug === slug) {
        t = String(cols[i].field_type || '').toLowerCase();
        return t;
      }
    }
    return '';
  }

  function calWeekOffset(content){
    var cfg = viewCfg(content);
    var v = cfg.weekStartDay || cfg.week_start_day;
    return v === 'mon' ? 1 : 0;
  }

  function calPad2(n){
    n = Number(n);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);
    return n < 10 ? '0' + n : String(n);
  }

  function calYmd(y, m, d){
    return String(y) + '-' + calPad2(m) + '-' + calPad2(d);
  }

  function calYmdFromLocalDate(dt){
    if (!dt || isNaN(dt.getTime())) return '';
    return calYmd(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
  }

  function calParseYmd(ymd){
    var p = String(ymd || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    var d = parseInt(p[2], 10);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y: y, m: m, d: d };
  }

  function calParseYm(ym){
    var p = String(ym || '').split('-');
    var y = parseInt(p[0], 10);
    var m = parseInt(p[1], 10);
    if (!isFinite(y) || !isFinite(m) || m < 1 || m > 12) return null;
    return { y: y, m: m };
  }

  function calAddLocalDays(ymd, n){
    var p = calParseYmd(ymd);
    if (!p) return '';
    var dt = new Date(p.y, p.m - 1, p.d);
    dt.setDate(dt.getDate() + n);
    return calYmdFromLocalDate(dt);
  }

  function calMaybeJson(raw){
    if (typeof raw !== 'string') return raw;
    var s = raw.trim();
    if (!s || s.length > 4000) return raw;
    var c0 = s.charAt(0);
    if (c0 !== '{' && c0 !== '[') return raw;
    try { return JSON.parse(s); } catch (e) { return raw; }
  }

  function calRangePair(raw){
    raw = calMaybeJson(raw);
    if (raw == null || raw === '') return null;
    var a, b, s, left, right, cut;
    if (Array.isArray(raw) && raw.length) {
      a = ymdFromValue(raw[0], 0);
      b = ymdFromValue(raw.length > 1 ? raw[1] : raw[0], 0);
      if (!a && !b) return null;
      return { start: a || b, end: b || a };
    }
    if (typeof raw === 'object') {
      a = ymdFromValue(raw.start != null ? raw.start : (raw.from != null ? raw.from : raw.begin), 0);
      b = ymdFromValue(raw.end != null ? raw.end : (raw.to != null ? raw.to : raw.finish), 0);
      if (!a && !b) return null;
      return { start: a || b, end: b || a };
    }
    if (typeof raw === 'string') {
      s = raw.trim();
      left = '';
      right = '';
      cut = s.indexOf(' to ');
      if (cut > 0) {
        left = ymdFromValue(s.slice(0, cut), 0);
        right = ymdFromValue(s.slice(cut + 4), 0);
      } else {
        cut = s.indexOf('..');
        if (cut > 0) {
          left = ymdFromValue(s.slice(0, cut), 0);
          right = ymdFromValue(s.slice(cut + 2), 0);
        } else {
          cut = s.indexOf(' - ');
          if (cut > 0) {
            left = ymdFromValue(s.slice(0, cut), 0);
            right = ymdFromValue(s.slice(cut + 3), 0);
          }
        }
      }
      if (left || right) return { start: left || right, end: right || left };
      var one = ymdFromValue(s, 0);
      return one ? { start: one, end: one } : null;
    }
    var k = ymdFromValue(raw, 0);
    return k ? { start: k, end: k } : null;
  }

  function calEnumerateSpan(start, end){
    if (!start) return { keys: [], truncated: false };
    if (!end) end = start;
    if (end < start) {
      var tmp = start;
      start = end;
      end = tmp;
    }
    var keys = [];
    var cur = start;
    var i;
    for (i=0;i<CAL_SPAN_DAY_CAP;i++){
      keys.push(cur);
      if (cur === end) return { keys: keys, truncated: false };
      cur = calAddLocalDays(cur, 1);
      if (!cur) break;
    }
    return { keys: keys, truncated: cur !== end };
  }

  function calRowDateKeys(row, slug, fieldType){
    if (!slug) return { keys: [], truncated: false };
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    if (fieldType === 'datetime') {
      var raw=d[slug], dt=raw==null||raw===''?null:new Date(raw);
      var local=dt&&!isNaN(dt.getTime())?calYmdFromLocalDate(dt):'';
      return {keys:local?[local]:[],truncated:false};
    }
    if (fieldType === 'date_range') {
      var pair = calRangePair(d[slug]);
      if (!pair) {
        var fallback = rowDateKey(row, slug);
        return fallback ? { keys: [fallback], truncated: false } : { keys: [], truncated: false };
      }
      return calEnumerateSpan(pair.start, pair.end);
    }
    var k = rowDateKey(row, slug);
    return k ? { keys: [k], truncated: false } : { keys: [], truncated: false };
  }

  function calUniqueInPrefix(byDay, prefix){
    var seen = Object.create(null);
    var n = 0;
    var k, i, id, items;
    for (k in byDay) {
      if (!Object.prototype.hasOwnProperty.call(byDay, k)) continue;
      if (k.indexOf(prefix) !== 0) continue;
      items = byDay[k];
      for (i=0;i<items.length;i++){
        id = items[i] && items[i].id;
        if (id && !seen[id]) { seen[id] = 1; n++; }
      }
    }
    return n;
  }

  function calPushUnique(list, row){
    var id = row && row.id;
    if (!id) { list.push(row); return; }
    var i;
    for (i=0;i<list.length;i++){
      if (list[i] && list[i].id === id) return;
    }
    list.push(row);
  }

  function calEmptyConfiguredHtml(){
    return '<div class="card"><div class="empty">No date field configured</div></div>';
  }

  function calMonthGridHtml(y, m, byDay, titleSlug, todayKey, weekOffset, multiIds){
    var first = new Date(y, m - 1, 1);
    var last = new Date(y, m, 0);
    var lead = (first.getDay() - weekOffset + 7) % 7;
    var daysIn = last.getDate();
    var html = '<div class="muted" style="font-size:1rem;font-weight:600;color:var(--guest-fg);margin:12px 0 0">'
      + esc((CAL_MONTH_NAMES[m - 1] || '') + ' ' + y) + '</div>';
    html += '<div class="cal">';
    var d, di;
    for (d=0;d<7;d++){
      di = (d + weekOffset) % 7;
      html += '<div class="cal-dow">' + CAL_DOW[di] + '</div>';
    }
    for (d=0;d<lead;d++) html += '<div class="cal-day out"></div>';
    var i, j, mm, dd, key, items, cards, nHtml, extra, pillStyle, rid;
    mm = calPad2(m);
    for (i=1;i<=daysIn;i++){
      dd = calPad2(i);
      key = String(y) + '-' + mm + '-' + dd;
      items = byDay[key] || [];
      cards = '';
      for (j=0;j<items.length && j<CAL_PILL_CAP;j++){
        rid = items[j] && items[j].id;
        pillStyle = (rid && multiIds && multiIds[rid]) ? ' style="border-left:3px solid #3b82f6"' : '';
        cards += '<div class="cal-item"' + pillStyle + '>' + esc(rowCellText(items[j], titleSlug) || 'Untitled') + '</div>';
      }
      if (items.length > CAL_PILL_CAP) {
        extra = items.length - CAL_PILL_CAP;
        cards += '<button type="button" class="cal-item" data-calendar-more="' + esc(key) + '" aria-label="Show ' + extra + ' more records">+' + extra + ' more</button>';
      }
      if (key === todayKey) {
        nHtml = '<div class="cal-day-n" style="text-align:right"><span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:999px;background:#3b82f6;color:#fff">' + i + '</span></div>';
      } else {
        nHtml = '<div class="cal-day-n" style="text-align:right">' + i + '</div>';
      }
      html += '<div class="cal-day">' + nHtml + cards + '</div>';
    }
    var filled = lead + daysIn;
    var pad = (7 - (filled % 7)) % 7;
    for (d=0;d<pad;d++) html += '<div class="cal-day out"></div>';
    html += '</div>';
    var count = calUniqueInPrefix(byDay, String(y) + '-' + mm + '-');
    html += '<p class="muted">' + esc(String(count) + ' records this month') + '</p>';
    return html;
  }

  function calModel(content){
    var cols = visibleFields(content), rows = Array.isArray(content && content.rows) ? content.rows : [];
    var dateSlug = calPickDateSlug(content, cols), type = calFieldType(cols, dateSlug);
    var model = { dateSlug:dateSlug, titleSlug:titleSlugOf(content,cols), fieldType:type, byDay:Object.create(null), multiIds:Object.create(null), undated:0, truncated:0 };
    rows.forEach(function(row){
      var info = calRowDateKeys(row,dateSlug,type);
      if (!info.keys.length) model.undated++;
      if (info.truncated) model.truncated++;
      if (info.keys.length > 1 && row.id) model.multiIds[row.id] = 1;
      info.keys.forEach(function(key){ if (!model.byDay[key]) model.byDay[key]=[]; calPushUnique(model.byDay[key],row); });
    });
    return model;
  }
  function calRange(raw){ return ['month','week','day','agenda'].indexOf(raw)>=0 ? raw : 'month'; }
  function calDateLabel(key){
    var p=calParseYmd(key); return p ? new Date(p.y,p.m-1,p.d).toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric'}) : '';
  }
  function calTime(row,model){
    if (model.fieldType !== 'datetime') return 'All day';
    var raw = row && row.data && row.data[model.dateSlug], dt = new Date(raw);
    return raw && !isNaN(dt.getTime()) ? dt.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'}) : 'All day';
  }
  function calListDay(key,model){
    var rows=model.byDay[key]||[], html='<section class="guest-cal-agenda-day" data-calendar-day="'+esc(key)+'"><h3>'+esc(calDateLabel(key))+'</h3>';
    if (!rows.length) html+='<p class="muted">No records for this day</p>';
    rows.forEach(function(row){ html+='<div class="cal-agenda-item"><span class="muted">'+esc(calTime(row,model))+'</span><span>'+esc(rowCellText(row,model.titleSlug)||'Untitled')+'</span></div>'; });
    return html+'</section>';
  }
  function calHourlyDay(key,model){
    var buckets=Array.from({length:24},function(){return [];});
    (model.byDay[key]||[]).forEach(function(row){var dt=new Date(row.data[model.dateSlug]);if(!isNaN(dt.getTime()))buckets[dt.getHours()].push(row);});
    var html='<section data-calendar-day="'+esc(key)+'" class="guest-cal-hours">';
    buckets.forEach(function(rows,hour){
      html+='<div class="guest-cal-hour" data-calendar-hour="'+hour+'"><span class="muted">'+esc(new Date(2000,0,1,hour).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}))+'</span><div>';
      rows.sort(function(a,b){return new Date(a.data[model.dateSlug])-new Date(b.data[model.dateSlug]);}).forEach(function(row){html+='<div class="cal-item"><span class="muted">'+esc(calTime(row,model))+'</span> '+esc(rowCellText(row,model.titleSlug)||'Untitled')+'</div>';});
      html+='</div></div>';
    });
    return html+'</section>';
  }
  function calWeekHtml(date,model,offset){
    var start=new Date(date.getFullYear(),date.getMonth(),date.getDate()); start.setDate(start.getDate()-(start.getDay()-offset+7)%7);
    var html='<div class="cal">', keys=[];
    for(var i=0;i<7;i++){var key=calAddLocalDays(calYmdFromLocalDate(start),i);keys.push(key);html+='<div class="cal-dow">'+esc(calDateLabel(key))+'</div>';}
    keys.forEach(function(key){html+='<div class="cal-day" data-calendar-day="'+esc(key)+'">';(model.byDay[key]||[]).forEach(function(row){html+='<div class="cal-item" title="'+esc(rowCellText(row,model.titleSlug)||'Untitled')+'">'+esc(rowCellText(row,model.titleSlug)||'Untitled')+'</div>';});html+='</div>';});
    return html+'</div>';
  }
  function calRender(content,range,date){
    var model=calModel(content); if(!model.dateSlug) return calEmptyConfiguredHtml();
    var today=calYmdFromLocalDate(new Date()), key=calYmdFromLocalDate(date), offset=calWeekOffset(content);
    var title=range==='agenda'?'Agenda':range==='day'?calDateLabel(key):range==='week'?'Week of '+calDateLabel(calAddLocalDays(key,-(date.getDay()-offset+7)%7)):CAL_MONTH_NAMES[date.getMonth()]+' '+date.getFullYear();
    var html='<div class="guest-cal-toolbar"><h2>'+esc(title)+'</h2><div class="guest-cal-controls"><div role="group" aria-label="Calendar range">';
    ['month','week','day','agenda'].forEach(function(mode){html+='<button type="button" data-calendar-range="'+mode+'" aria-pressed="'+(range===mode)+'">'+mode.charAt(0).toUpperCase()+mode.slice(1)+'</button>';});
    html+='</div><div role="group" aria-label="Calendar navigation">';
    var period=range==='day'?'day':range==='week'?'week':'month';
    if(range!=='agenda')html+='<button type="button" data-calendar-nav="-1" aria-label="Previous '+period+'">&#8249;</button>';
    html+='<button type="button" data-calendar-nav="0">Today</button>';
    if(range!=='agenda')html+='<button type="button" data-calendar-nav="1" aria-label="Next '+period+'">&#8250;</button>';
    html+='</div></div></div><div class="guest-cal-body">';
    if(range==='month')html+=calMonthGridHtml(date.getFullYear(),date.getMonth()+1,model.byDay,model.titleSlug,today,offset,model.multiIds);
    else if(range==='week')html+=calWeekHtml(date,model,offset);
    else if(range==='day')html+=model.fieldType==='datetime'?calHourlyDay(key,model):calListDay(key,model);
    else {var keys=Object.keys(model.byDay).sort();if(!keys.length)html+='<p class="muted">No dated records</p>';keys.forEach(function(day){html+=calListDay(day,model);});}
    html+='</div>';
    if(model.undated)html+='<p class="muted">'+model.undated+' record'+(model.undated===1?' has':'s have')+' no date and '+(model.undated===1?'is':'are')+' not shown</p>';
    if(model.truncated)html+='<p class="muted">'+model.truncated+' long date ranges are only shown for their first year of days</p>';
    if(content.truncated)html+='<p class="muted">Showing dates from the first '+content.rows.length+' loaded records.</p>';
    return html;
  }
  function renderCalendarHtml(content){
    var range=calRange(viewCfg(content).calendarRange||viewCfg(content).calendar_range);
    return '<section data-guest-calendar data-calendar-initial-range="'+range+'" data-calendar-content="'+esc(JSON.stringify(content))+'"><style>'
      + '.guest-cal-hours{border:1px solid var(--guest-border);border-radius:8px;max-height:65vh;overflow:auto}.guest-cal-hour{display:flex;gap:8px;min-height:48px;padding:10px 12px;box-sizing:border-box;border-bottom:1px solid var(--guest-border)}.guest-cal-hour>span{flex:0 0 65px;font-size:12px}.guest-cal-hour>div{min-width:0;flex:1}.guest-cal-hour .cal-item{white-space:normal;overflow-wrap:anywhere}.cal-day button.cal-item{display:block;width:100%;text-align:left;color:var(--guest-fg);cursor:pointer;border:1px solid var(--guest-border)}.guest-cal-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.guest-cal-toolbar h2{font-size:16px;margin:0}.guest-cal-controls{display:flex;gap:8px;flex-wrap:wrap}.guest-cal-controls [role=group]{display:flex;gap:2px;align-items:center}.guest-cal-controls button{background:var(--guest-card);color:var(--guest-fg);border:1px solid var(--guest-border);border-radius:6px;padding:6px 9px;font:inherit;cursor:pointer}.guest-cal-controls button[aria-pressed=true]{background:var(--guest-input);font-weight:600}.guest-cal-controls button:focus-visible{outline:2px solid #3b82f6;outline-offset:2px}.guest-cal-body{overflow-x:auto;max-width:100%;margin-top:12px}.guest-cal-agenda-day h3{font-size:12px;padding:8px;background:var(--guest-input)}.cal-agenda-item{display:flex;gap:12px;padding:10px;border-bottom:1px solid var(--guest-border);overflow-wrap:anywhere}.cal-agenda-item>span:first-child{flex:0 0 75px}.cal-agenda-item>span:last-child{min-width:0}.guest-cal-body>.muted:first-child{display:none}'
      + '</style><div data-calendar-body>'+calRender(content,range,new Date())+'</div></section>';
  }
  if(typeof document!=='undefined' && typeof MutationObserver!=='undefined'){
    var initCalendars=function(){document.querySelectorAll('[data-guest-calendar]').forEach(function(root){
      if(root.__calendarReady)return;root.__calendarReady=true;
      var content;try{content=JSON.parse(root.getAttribute('data-calendar-content')||'{}');}catch(error){return;}root.removeAttribute('data-calendar-content');
      var range=calRange(root.getAttribute('data-calendar-initial-range')),date=new Date();
      root.addEventListener('click',function(event){
        var button=event.target.closest('button[data-calendar-range],button[data-calendar-nav],button[data-calendar-more]');if(!button||!root.contains(button))return;
        var mode=button.getAttribute('data-calendar-range'), nav=button.getAttribute('data-calendar-nav');
        var more=button.getAttribute('data-calendar-more');
        if(more){var parts=calParseYmd(more);if(!parts)return;date=new Date(parts.y,parts.m-1,parts.d);range='day';}
        else if(mode)range=calRange(mode);
        else if(nav==='0')date=new Date();
        else if(range==='day'||range==='week')date.setDate(date.getDate()+Number(nav)*(range==='week'?7:1));
        else {date.setDate(1);date.setMonth(date.getMonth()+Number(nav));}
        root.querySelector('[data-calendar-body]').innerHTML=calRender(content,range,date);
        var selector=more?'[data-calendar-range="day"]':mode?'[data-calendar-range="'+range+'"]':'[data-calendar-nav="'+nav+'"]';
        var next=root.querySelector(selector);if(next)next.focus();
        if(range==='agenda'&&nav==='0'){var today=root.querySelector('[data-calendar-day="'+calYmdFromLocalDate(date)+'"]');if(today)today.scrollIntoView({block:'nearest'});}
      });
    });};
    new MutationObserver(initCalendars).observe(document.documentElement,{childList:true,subtree:true});
    initCalendars();
  }
`
