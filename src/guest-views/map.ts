/**
 * Guest Map read layout (public share / portal).
 *
 * Concatenate after GUEST_RENDER_JS so this later `function renderMapHtml`
 * wins. Guest pages are self-contained HTML (no CDN, no webfonts, no OSM
 * tiles). Do not load Leaflet, tile images, or any other external asset.
 *
 * Parent already paints a `.map-list` of `.map-card` rows plus the honest
 * note "Places are listed here. This public page does not draw a map."
 * and keeps `simplified: false`. This override keeps that list contract
 * and aligns cell parsing with desktop `resolveMapRecordCoords` /
 * `parseMapLatLng` in `apps/desktop/src/lib/map-view.ts` (parent
 * `rowCellText` misses `{lat,lng}` objects the same way gallery's parent
 * missed `{url}`).
 *
 * Read-only list (map-view.tsx without the live map):
 * - Config slugs camel+snake, 128-cap, field slug or id (fieldDataKey).
 * - Lat/lng fields win and do not fall through to the location cell.
 * - Location objects `{lat,lng}` / `[lat,lng]` / JSON strings parse.
 * - Address-shaped objects `{label|address|name}` list as text, not JSON.
 * - Empty overlays match desktop titles (Pick location fields / No records
 *   yet / Nothing to plot).
 * - MAP_MARKERS_MAX 500 listed places + payload truncated honesty.
 * - Extra kv skips bound coord fields plus image / rich_text (popup meta).
 *
 * Template-literal rule: no backticks, no ${ } in the embedded JS; double
 * backslashes in regex/string literals. Pure string -> string, no DOM.
 *
 * Gaps vs apps/desktop/src/components/views/map-view.tsx (stay off this page):
 * - Interactive map: Leaflet, OSM raster tiles, GuardedOsmTileLayer,
 *   allowlisted tile hosts, attribution, min/max zoom, Fit to pins,
 *   start_position / start_zoom, pan-to-pin, camera-touch, ResizeObserver.
 * - Locate addresses (Nominatim IPC, GEOCODE_BATCH_MAX 25, write-back).
 * - Rich pin popup (ModulesRichCardBody activity footer, comment counts,
 *   Open record). Cover here is http(s) only.
 * - Settings default map position / zoom (settings:changed).
 * - Click-through to the record (guest is view-not-edit).
 * - Filter empty copy ("No matching records") - share rows are pre-filtered.
 * - View-type aliases geo / locations / geospatial: parent canonicalViewType
 *   already maps those to map (not this overlay).
 */

export const GUEST_VIEW_MAP_JS = `
  var GUEST_MAP_MARKERS_MAX = 500;
  var GUEST_MAP_SLUG_MAX = 128;
  var GUEST_MAP_JSON_MAX = 512;
  var GUEST_MAP_PAIR_MAX = 128;
  var GUEST_MAP_ADDR_MAX = 200;
  var GUEST_MAP_DESC_MAX = 120;
  var GUEST_MAP_META_MAX = 4;
  var GUEST_MAP_NOTE = 'Places are listed here. This public page does not draw a map.';
  function guestMapOwn(rec, key){
    if (!rec || typeof rec !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(rec, key)) return undefined;
    return rec[key];
  }
  function guestMapReadSlug(cfg, keys){
    if (!cfg || typeof cfg !== 'object') return '';
    for (var i=0;i<keys.length;i++){
      if (!Object.prototype.hasOwnProperty.call(cfg, keys[i])) continue;
      var s = cfg[keys[i]];
      if (typeof s !== 'string') continue;
      var t = s.trim();
      if (t && t.length <= GUEST_MAP_SLUG_MAX) return t;
    }
    return '';
  }
  function guestMapField(cols, slug){
    if (!slug) return null;
    for (var i=0;i<cols.length;i++){
      var c = cols[i];
      if (!c) continue;
      if (c.slug === slug) return c;
      if (typeof c.id === 'string' && c.id && c.id === slug) return c;
    }
    return null;
  }
  function guestMapPickByNames(cols, names){
    for (var i=0;i<cols.length;i++){
      var t = String(cols[i].field_type || '').toLowerCase();
      var s = String(cols[i].slug || '').toLowerCase();
      for (var j=0;j<names.length;j++){
        if (s === names[j] || t === names[j]) return cols[i];
      }
    }
    return null;
  }
  function guestMapIsCoordType(fieldType){
    var t = String(fieldType || '').trim().toLowerCase();
    return t === 'number' || t === 'currency' || t === 'percent' || t === 'rating' || t === 'text';
  }
  function guestMapIsLocationType(fieldType){
    var t = String(fieldType || '').trim().toLowerCase();
    return t === 'location' || t === 'text' || t === 'json';
  }
  function guestMapCap(s, max){
    s = String(s == null ? '' : s);
    var n = 0, i = 0, out = '';
    while (i < s.length && n < max) {
      var code = s.charCodeAt(i);
      if (code >= 0xD800 && code <= 0xDBFF && i + 1 < s.length) {
        out += s.charAt(i) + s.charAt(i + 1);
        i += 2;
      } else {
        out += s.charAt(i);
        i += 1;
      }
      n++;
    }
    return out;
  }
  function guestMapFiniteCoord(n, kind){
    if (typeof n === 'number' && isFinite(n)) {
      if (kind === 'lat' && n >= -90 && n <= 90) return n;
      if (kind === 'lng' && n >= -180 && n <= 180) return n;
      return null;
    }
    if (typeof n === 'string') {
      var t = n.trim();
      if (!t || t.length > 32) return null;
      var v = Number(t);
      if (!isFinite(v)) return null;
      return guestMapFiniteCoord(v, kind);
    }
    return null;
  }
  function guestMapParseLatLng(value, depth){
    depth = depth || 0;
    if (value == null || value === '' || depth > 2) return null;
    if (typeof value === 'string') {
      var t = value.trim();
      if (!t) return null;
      if (t.charAt(0) === '{' || t.charAt(0) === '[') {
        if (t.length > GUEST_MAP_JSON_MAX) return null;
        try { return guestMapParseLatLng(JSON.parse(t), depth + 1); }
        catch (err) { return null; }
      }
      if (t.length > GUEST_MAP_PAIR_MAX) return null;
      var m = t.match(/^(-?\\d+(?:\\.\\d+)?)\\s*[,;\\s]\\s*(-?\\d+(?:\\.\\d+)?)$/);
      if (!m) return null;
      var slat = guestMapFiniteCoord(m[1], 'lat');
      var slng = guestMapFiniteCoord(m[2], 'lng');
      if (slat == null || slng == null) return null;
      return { lat: slat, lng: slng };
    }
    if (Array.isArray(value) && value.length >= 2) {
      var alat = guestMapFiniteCoord(value[0], 'lat');
      var alng = guestMapFiniteCoord(value[1], 'lng');
      if (alat == null || alng == null) return null;
      return { lat: alat, lng: alng };
    }
    if (typeof value === 'object') {
      var rec = value;
      var latKey = guestMapOwn(rec, 'lat');
      if (latKey == null) latKey = guestMapOwn(rec, 'latitude');
      var lngKey = guestMapOwn(rec, 'lng');
      if (lngKey == null) lngKey = guestMapOwn(rec, 'lon');
      if (lngKey == null) lngKey = guestMapOwn(rec, 'longitude');
      var olat = guestMapFiniteCoord(latKey, 'lat');
      var olng = guestMapFiniteCoord(lngKey, 'lng');
      if (olat == null || olng == null) return null;
      return { lat: olat, lng: olng };
    }
    return null;
  }
  function guestMapRaw(row, field){
    if (!field) return undefined;
    var d = row && row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
    var slug = typeof field.slug === 'string' ? field.slug : '';
    if (slug && Object.prototype.hasOwnProperty.call(d, slug) && d[slug] !== undefined) return d[slug];
    var id = typeof field.id === 'string' ? field.id : '';
    if (id && Object.prototype.hasOwnProperty.call(d, id) && d[id] !== undefined) return d[id];
    return undefined;
  }
  function guestMapResolveCoords(hasLatLng, latRaw, lngRaw, locRaw){
    if (hasLatLng) {
      var lat = guestMapFiniteCoord(latRaw, 'lat');
      var lng = guestMapFiniteCoord(lngRaw, 'lng');
      if (lat != null && lng != null) return { lat: lat, lng: lng };
      return null;
    }
    return guestMapParseLatLng(locRaw, 0);
  }
  function guestMapAddrFromObject(rec){
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return '';
    var keys = ['label', 'address', 'name'];
    for (var i=0;i<keys.length;i++){
      var v = guestMapOwn(rec, keys[i]);
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
  }
  function guestMapAddrText(raw, slug, row, depth){
    depth = depth || 0;
    if (depth > 2) return '';
    if (guestMapParseLatLng(raw, 0)) return '';
    if (typeof raw === 'string') {
      var t = raw.trim();
      if (!t) return '';
      if (t.charAt(0) === '{' || t.charAt(0) === '[') {
        if (t.length > GUEST_MAP_JSON_MAX) return '';
        try { return guestMapAddrText(JSON.parse(t), slug, row, depth + 1); }
        catch (err) { return ''; }
      }
      return guestMapCap(t, GUEST_MAP_ADDR_MAX);
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      var fromObj = guestMapAddrFromObject(raw);
      return fromObj ? guestMapCap(fromObj, GUEST_MAP_ADDR_MAX) : '';
    }
    var txt = slug ? rowCellText(row, slug) : '';
    if (!txt) return '';
    var s = txt.trim();
    if (!s || s.charAt(0) === '{' || s.charAt(0) === '[') return '';
    return guestMapCap(s, GUEST_MAP_ADDR_MAX);
  }
  function guestMapHttpSrc(raw, depth){
    depth = depth || 0;
    if (raw == null || raw === '' || depth > 2) return '';
    if (typeof raw === 'string') {
      var s = raw.trim();
      if (!s) return '';
      if (isSafeHttpUrl(s)) return s;
      if (s.length > 8192) return '';
      if (s.charAt(0) === '[' || s.charAt(0) === '{') {
        try { return guestMapHttpSrc(JSON.parse(s), depth + 1); }
        catch (err) { return ''; }
      }
      return '';
    }
    if (Array.isArray(raw)) {
      for (var i=0;i<raw.length && i<40;i++){
        var fromItem = guestMapHttpSrc(raw[i], depth + 1);
        if (fromItem) return fromItem;
      }
      return '';
    }
    if (typeof raw === 'object') {
      var ukeys = ['url', 'src', 'path', 'href'];
      for (var k=0;k<ukeys.length;k++){
        var v = guestMapOwn(raw, ukeys[k]);
        if (typeof v === 'string') {
          var u = v.trim();
          if (isSafeHttpUrl(u)) return u;
        }
      }
    }
    return '';
  }
  function guestMapTitleText(row, field, slug){
    var raw = field ? guestMapRaw(row, field) : undefined;
    var text = '';
    if (typeof raw === 'string') text = raw.trim();
    else if (raw != null && raw !== '') text = valueText(raw, 0);
    if (!text && slug) text = rowCellText(row, slug);
    return text;
  }
  function guestMapTitleHtml(row, field, slug){
    var text = guestMapTitleText(row, field, slug);
    return '<div class="row-title">' + (text ? esc(text) : '<span class="cell-muted">Untitled</span>') + '</div>';
  }
  function guestMapHint(notes){
    var bits = notes.slice();
    bits.push(GUEST_MAP_NOTE);
    return '<p class="hint">' + esc(bits.join(' ')) + '</p>';
  }
  function guestMapEmpty(title, desc, notes){
    return '<div class="stack map-list"><div class="card"><div class="empty">' + esc(title)
      + (desc ? '<div class="muted" style="margin-top:8px">' + esc(desc) + '</div>' : '')
      + '</div></div>' + guestMapHint(notes || []) + '</div>';
  }
  function renderMapHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    var cfg = viewCfg(content);
    var titleSlug = guestMapReadSlug(cfg, ['labelFieldSlug','label_field','titleFieldSlug','title_field']);
    var titleField = guestMapField(cols, titleSlug);
    if (!titleField) {
      titleSlug = titleSlugOf(content, cols);
      titleField = guestMapField(cols, titleSlug);
    }
    if (!titleField) {
      for (var ti=0;ti<cols.length;ti++){
        var tf = cols[ti];
        if (tf && (tf.is_title === true || tf.is_title === 1)) { titleField = tf; break; }
      }
    }
    titleSlug = titleField && titleField.slug ? titleField.slug : (titleSlug || '');
    var locSlug = guestMapReadSlug(cfg, ['locationFieldSlug','location_field']);
    var latSlug = guestMapReadSlug(cfg, ['latFieldSlug','lat_field']);
    var lngSlug = guestMapReadSlug(cfg, ['lngFieldSlug','lng_field']);
    var locField = guestMapField(cols, locSlug);
    var latField = guestMapField(cols, latSlug);
    var lngField = guestMapField(cols, lngSlug);
    if (locField && !guestMapIsLocationType(locField.field_type)) locField = null;
    if (latField && !guestMapIsCoordType(latField.field_type)) latField = null;
    if (lngField && !guestMapIsCoordType(lngField.field_type)) lngField = null;
    if (!locField) {
      locField = guestMapPickByNames(cols, ['location','address','geo']);
      if (locField && !guestMapIsLocationType(locField.field_type)) locField = null;
    }
    if (!latField) {
      latField = guestMapPickByNames(cols, ['lat','latitude']);
      if (latField && !guestMapIsCoordType(latField.field_type)) latField = null;
    }
    if (!lngField) {
      lngField = guestMapPickByNames(cols, ['lng','lon','longitude']);
      if (lngField && !guestMapIsCoordType(lngField.field_type)) lngField = null;
    }
    locSlug = locField && locField.slug ? locField.slug : '';
    latSlug = latField && latField.slug ? latField.slug : '';
    lngSlug = lngField && lngField.slug ? lngField.slug : '';
    var hasLatLng = Boolean(latField && lngField);
    var configured = hasLatLng || Boolean(locField);
    if (!configured) {
      return guestMapEmpty(
        'Pick location fields',
        'This share needs a location field (lat, lng text) or separate latitude and longitude fields.'
      );
    }
    if (!rows.length) {
      return guestMapEmpty(
        'No records yet',
        'There are no records in this view.'
      );
    }
    var skip = Object.create(null);
    if (titleSlug) skip[titleSlug] = true;
    if (titleField && typeof titleField.id === 'string' && titleField.id) skip[titleField.id] = true;
    if (latSlug) skip[latSlug] = true;
    if (latField && typeof latField.id === 'string' && latField.id) skip[latField.id] = true;
    if (lngSlug) skip[lngSlug] = true;
    if (lngField && typeof lngField.id === 'string' && lngField.id) skip[lngField.id] = true;
    if (locSlug) skip[locSlug] = true;
    if (locField && typeof locField.id === 'string' && locField.id) skip[locField.id] = true;
    var coverField = null;
    var descField = null;
    var fi, ft;
    for (fi=0;fi<cols.length;fi++){
      ft = String(cols[fi].field_type || '').trim().toLowerCase();
      if (!coverField && ft === 'image' && !skip[cols[fi].slug]) coverField = cols[fi];
      if (!descField && ft === 'rich_text' && !skip[cols[fi].slug]) descField = cols[fi];
    }
    if (coverField && coverField.slug) skip[coverField.slug] = true;
    if (descField && descField.slug) skip[descField.slug] = true;
    var unmappable = 0;
    var listed = 0;
    var truncatedList = false;
    var cards = '';
    for (var ri=0;ri<rows.length;ri++){
      var r = rows[ri];
      var latRaw = latField ? guestMapRaw(r, latField) : undefined;
      var lngRaw = lngField ? guestMapRaw(r, lngField) : undefined;
      var locRaw = locField ? guestMapRaw(r, locField) : undefined;
      var coords = guestMapResolveCoords(hasLatLng, latRaw, lngRaw, locRaw);
      if (!coords && hasLatLng) {
        coords = guestMapResolveCoords(true, rowCellText(r, latSlug), rowCellText(r, lngSlug), null);
      }
      if (!coords && !hasLatLng && locSlug) {
        coords = guestMapParseLatLng(rowCellText(r, locSlug), 0);
      }
      var geo = '';
      if (coords) {
        geo = String(coords.lat) + ', ' + String(coords.lng);
      } else {
        geo = guestMapAddrText(locRaw, locSlug, r, 0);
        if (!geo) unmappable++;
      }
      if (!geo) continue;
      if (listed >= GUEST_MAP_MARKERS_MAX) {
        truncatedList = true;
        continue;
      }
      listed++;
      var extra = '';
      var shown = 0;
      var ci, c, val;
      for (ci=0;ci<cols.length && shown<GUEST_MAP_META_MAX;ci++){
        c = cols[ci];
        if (!c || skip[c.slug]) continue;
        val = cellHtml(c, r);
        if (val === '') continue;
        extra += '<div class="kv"><div class="kv-k">' + esc(c.name || c.slug) + '</div><div class="kv-v">' + val + '</div></div>';
        shown++;
      }
      var cover = '';
      if (coverField) {
        var src = guestMapHttpSrc(guestMapRaw(r, coverField), 0);
        if (!src) {
          var dispSrc = rowCellText(r, coverField.slug);
          if (dispSrc && isSafeHttpUrl(dispSrc.trim())) src = dispSrc.trim();
        }
        if (src) {
          var alt = guestMapTitleText(r, titleField, titleSlug) || 'Untitled';
          cover = '<img loading="lazy" alt="' + esc(alt) + '" src="' + esc(src) + '" style="display:block;width:100%;height:120px;object-fit:cover;border-radius:8px;margin:0 0 8px"/>';
        }
      }
      var desc = '';
      if (descField) {
        var dtxt = rowCellText(r, descField.slug).replace(/\\r?\\n/g, ' ').replace(/\\s+/g, ' ').trim();
        if (dtxt) {
          if (dtxt.length > GUEST_MAP_DESC_MAX) dtxt = guestMapCap(dtxt, GUEST_MAP_DESC_MAX) + '...';
          desc = '<div class="muted" style="margin:0 0 8px">' + esc(dtxt) + '</div>';
        }
      }
      cards += '<div class="row-card map-card">' + cover + guestMapTitleHtml(r, titleField, titleSlug) + desc
        + '<div class="kv"><div class="kv-k">Location</div><div class="kv-v">' + esc(geo) + '</div></div>'
        + extra + '</div>';
    }
    if (!listed) {
      var nothingDesc = unmappable > 0
        ? (String(unmappable) + (unmappable === 1 ? ' record has' : ' records have') + ' no usable coordinates. Use lat, lng, number fields, or a location field with a street address.')
        : 'No records have usable coordinates yet.';
      return guestMapEmpty('Nothing to plot', nothingDesc);
    }
    var notes = [];
    if (content && content.truncated === true) {
      var total = typeof content.total === 'number' && isFinite(content.total) ? content.total : 0;
      if (total > rows.length) notes.push('Showing the first ' + rows.length + ' of ' + total + ' records.');
      else notes.push('This page may not include every record.');
    }
    if (truncatedList) {
      notes.push('List shows the first ' + String(GUEST_MAP_MARKERS_MAX) + ' places.');
    }
    if (unmappable > 0) {
      notes.push(String(unmappable) + (unmappable === 1 ? ' record has' : ' records have') + ' no usable coordinates.');
    }
    return '<div class="stack map-list">' + cards + guestMapHint(notes) + '</div>';
  }
`
