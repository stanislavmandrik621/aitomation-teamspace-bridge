/**
 * SHARE-PAGES-A: guest public page rendering contracts.
 *
 * The guest pages render client-side from JSON, so the renderers live as
 * plain-JS source strings (guest-page-render.ts) that the shells embed.
 * They are pure string -> string functions with no DOM access, so this test
 * evaluates that exact source in Node and pins:
 *  (a) a v1 payload renders without throwing and an object cell can never
 *      print the literal "[object Object]" (name/label/title/id extraction);
 *  (b) v2 board grouping buckets rows by the DISPLAY value of
 *      groupByFieldSlug, with a "No value" lane for blanks;
 *  (c) HTML escaping still applies (a <script> cell value comes out escaped);
 *  (d) gallery image URLs that are not http(s) are never emitted as an
 *      <img src> (javascript:/data:/attribute-breakout attempts refused).
 * Plus: viewType dispatch is NOT v2-only (v1 board with a groupable field
 * paints a board); calendar/date_bucket/dashboard are real layouts (not a
 * simplified table); unknown types still table + simplified:true; the CSV
 * export uses display values with real CSV quoting; the store admits payload
 * v1 AND v2 but refuses unknown versions; and the server.ts shells all route
 * through the shared theme + renderer modules (structural pins bounded by
 * each shell function's own region, not character windows).
 */

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  GUEST_ESC_JS,
  GUEST_FORM_FIELD_JS,
  GUEST_GATE_JS,
  GUEST_RENDER_JS,
} from '../src/guest-page-render.js'
import {
  guestErrorPageHtml,
  guestPageDocument,
  GUEST_PAGE_CSS,
  GUEST_HTML_RESPONSE_HEADERS,
} from '../src/guest-page-theme.js'
import { PublicShareBridgeStore, hashPublicShareToken } from '../src/public-share-store.js'
import { guestPageScripts } from './_guest-page-scripts.js'

// Evaluate the exact client source in Node. Function declarations hoist, so
// the trailing return can hand every renderer back for direct calls.
/* eslint-disable @typescript-eslint/no-explicit-any */
const rendererApi = new Function(
  GUEST_ESC_JS +
    GUEST_GATE_JS +
    GUEST_RENDER_JS +
    `
  return {
    esc: esc,
    gateHtml: gateHtml,
    isSafeHttpUrl: isSafeHttpUrl,
    isSafeLogoSrc: isSafeLogoSrc,
    isHexColor: isHexColor,
    isPlaceholderChrome: isPlaceholderChrome,
    firstAccentHex: firstAccentHex,
    cellHtml: cellHtml,
    rowCellText: rowCellText,
    renderTableHtml: renderTableHtml,
    renderListHtml: renderListHtml,
    renderBoardHtml: renderBoardHtml,
    renderGalleryHtml: renderGalleryHtml,
    renderReadBodyHtml: renderReadBodyHtml,
    pageHeadHtml: pageHeadHtml,
    csvFromContent: csvFromContent,
  };
`,
)() as Record<string, (...args: any[]) => any>

function field(slug: string, name: string, fieldType = 'text'): Record<string, unknown> {
  return { slug, name, field_type: fieldType, required: false, config: {}, default_value: null }
}

// ---- (a) v1 payload: never "[object Object]", viewType dispatch is live ----
{
  const v1 = {
    version: 1,
    mode: 'read',
    viewType: 'board',
    label: 'Deals',
    entityId: 'ent1',
    fields: [
      field('title', 'Title'),
      field('owner', 'Owner', 'user'),
      field('stage', 'Stage', 'status'),
      field('tags', 'Tags', 'tags'),
    ],
    rows: [
      { id: 'r1', data: { title: 'Acme deal', owner: { id: 'u1', name: 'Jane Doe' }, stage: 'open', tags: ['alpha', 'beta'] } },
      { id: 'r2', data: { title: 'Beta deal', owner: { weird: true }, stage: 'open', tags: [{ label: 'hot' }] } },
      { id: 'r3', data: { title: null, owner: [{ name: 'Bob' }, { name: 'Ann' }], stage: 'won', tags: 7 } },
    ],
    total: 3,
    truncated: false,
    includeCsv: true,
    pushedAt: Date.now(),
  }
  const out = rendererApi.renderReadBodyHtml(v1)
  assert.equal(out.simplified, false, 'v1 board with a groupable status field is a real board')
  assert.ok(out.html.includes('class="board"'), 'v1 viewType board renders board lanes, not a forced table')
  assert.ok(!out.html.includes('[object Object]'), 'object cells never stringify raw')
  assert.ok(out.html.includes('Jane Doe'), 'object cell extracts name property')
  assert.ok(out.html.includes('hot'), 'array-of-objects cell extracts label property')
  assert.ok(out.html.includes('Bob, Ann'), 'array of objects joins extracted names')
  // {weird:true} has no name-ish property -> empty string, never "[object Object]"
  const csv = rendererApi.csvFromContent(v1)
  assert.ok(!csv.includes('[object Object]'), 'CSV never emits raw object stringification')
  assert.ok(csv.includes('Jane Doe'), 'CSV carries extracted cell text')

  // Board with only a title field has nothing to group by -> table, not simplified.
  const titleOnly = {
    version: 1,
    mode: 'read',
    viewType: 'board',
    label: 'Names',
    entityId: 'ent1',
    fields: [field('title', 'Title')],
    rows: [{ id: 'r1', data: { title: 'Acme deal' } }],
    total: 1,
    truncated: false,
    includeCsv: false,
    pushedAt: Date.now(),
  }
  const titleOut = rendererApi.renderReadBodyHtml(titleOnly)
  assert.equal(titleOut.simplified, false)
  assert.ok(titleOut.html.includes('<table'), 'board with no group field falls back to a table')
  assert.ok(!titleOut.html.includes('class="board"'), 'no group field means no empty board chrome')
}

// ---- (b) v2 board grouping by display value, "No value" lane for blanks ----
{
  const v2 = {
    version: 2,
    mode: 'read',
    viewType: 'board',
    label: 'Pipeline',
    moduleName: 'Sales',
    entityName: 'Deals',
    entityId: 'e1',
    fields: [field('name', 'Name'), field('stage', 'Stage', 'status'), field('amount', 'Amount', 'number')],
    columns: ['name', 'stage', 'amount'],
    viewConfig: { groupByFieldSlug: 'stage', titleFieldSlug: 'name', imageFieldSlug: null },
    rows: [
      { id: '1', data: { name: 'A', stage: 'won', amount: 5 }, display: { name: 'A', stage: 'Won', amount: '$5' } },
      { id: '2', data: { name: 'B', stage: 'lost' }, display: { name: 'B', stage: 'Lost' } },
      { id: '3', data: { name: 'C', stage: 'won' }, display: { name: 'C', stage: 'Won' } },
      { id: '4', data: { name: 'D' }, display: { name: 'D' } },
    ],
    total: 4,
    truncated: false,
    includeCsv: true,
    pushedAt: Date.now(),
  }
  const out = rendererApi.renderReadBodyHtml(v2)
  assert.equal(out.simplified, false)
  assert.ok(out.html.includes('class="board"'), 'v2 board viewType uses the board renderer')
  assert.ok(
    out.html.includes('<span>Won</span><span class="lane-count">2</span>'),
    'rows bucket by the display value of groupByFieldSlug (Won x2)',
  )
  assert.ok(
    out.html.includes('<span>Lost</span><span class="lane-count">1</span>'),
    'second display bucket present',
  )
  assert.ok(
    out.html.includes('<span>No value</span><span class="lane-count">1</span>'),
    'blank group value lands in the No value lane',
  )
  // Display strings feed the cells too ($5, not 5).
  assert.ok(out.html.includes('$5'), 'board card renders display string for cells')

  // CSV uses display values and real CSV quoting.
  const csvContent = {
    ...v2,
    viewType: 'table',
    rows: [
      { id: '1', data: { name: 'x' }, display: { name: 'Comma, Inc.', stage: 'He said "hi"', amount: '=SUM(A1)' } },
    ],
  }
  const csv = rendererApi.csvFromContent(csvContent)
  assert.ok(csv.includes('"Comma, Inc."'), 'comma cell is quoted')
  assert.ok(csv.includes('"He said ""hi"""'), 'inner quotes are doubled')
  assert.ok(csv.includes("'=SUM(A1)"), 'formula-looking cell is defanged for spreadsheets')

  // Calendar / date_bucket / date_board group into YYYY-MM-DD lanes (not a simplified table).
  const dated = {
    ...v2,
    viewType: 'calendar',
    fields: [
      field('name', 'Name'),
      field('stage', 'Stage', 'status'),
      field('due', 'Due', 'date'),
    ],
    columns: ['name', 'stage', 'due'],
    viewConfig: { ...v2.viewConfig, dateFieldSlug: 'due' },
    rows: [
      { id: '1', data: { name: 'A', stage: 'won', due: '2026-08-13' }, display: { name: 'A', stage: 'Won', due: '2026-08-13' } },
      { id: '2', data: { name: 'B', stage: 'lost', due: '2026-08-13' }, display: { name: 'B', stage: 'Lost', due: '2026-08-13' } },
      { id: '4', data: { name: 'D' }, display: { name: 'D' } },
    ],
  }
  const cal = rendererApi.renderReadBodyHtml(dated)
  assert.equal(cal.simplified, false, 'calendar is a real month-grid layout, not a simplified table')
  assert.ok(cal.html.includes('class="cal"'), 'calendar uses the month grid')
  assert.ok(cal.html.includes('cal-item') && cal.html.includes('A'), 'dated rows appear as items on the month grid')
  assert.ok(
    cal.html.includes('1 record has no date and is not shown'),
    'blank dates stay off the month grid and are named in the footer (same as the in-app calendar)',
  )

  const bucket = rendererApi.renderReadBodyHtml({ ...dated, viewType: 'date_bucket' })
  assert.equal(bucket.simplified, false)
  assert.ok(bucket.html.includes('class="date-board"'), 'date_bucket aliases to date-board')
  assert.ok(
    bucket.html.includes('data-guest-date-bucket') || (bucket.html.includes('Overdue') && bucket.html.includes('Today')),
    'date_bucket paints Overdue/Today lanes, not a row table',
  )

  const bucketNoDateField = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'date_bucket' })
  assert.ok(
    bucketNoDateField.html.includes('This board needs a date column.'),
    'date_bucket with no date field does not dump every row into No date',
  )

  const dateBoardAlias = rendererApi.renderReadBodyHtml({ ...dated, viewType: 'date_board' })
  assert.equal(dateBoardAlias.simplified, false)
  assert.ok(dateBoardAlias.html.includes('class="date-board"'), 'date_board aliases to date-board')

  const dash = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'dashboard' })
  assert.equal(dash.simplified, false, 'dashboard is not a simplified-to-table-only layout')
  assert.ok(dash.html.includes('dash-tiles'), 'dashboard summary uses dash-tiles')
  assert.ok(!dash.html.includes('<table'), 'dashboard is KPI tiles + chart, not a row table')

  const chart = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'chart' })
  assert.equal(chart.simplified, false)
  assert.ok(chart.html.includes('chart-wrap') && chart.html.includes('chart-svg'), 'chart paints a full-width SVG')
  assert.ok(!chart.html.includes('<table'), 'chart is not aliased to a table')
  assert.ok(chart.html.includes('Won') || chart.html.includes('Lead') || chart.html.includes('chart-legend'), 'chart buckets the category field')

  const graphAlias = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'graph' })
  assert.equal(graphAlias.simplified, false)
  assert.ok(graphAlias.html.includes('chart-svg'), 'graph alias paints a chart, not a simplified table')
  assert.ok(!graphAlias.html.includes('<table'), 'graph alias is not a table')

  const geoAlias = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'geo' })
  assert.equal(geoAlias.simplified, false)
  assert.ok(geoAlias.html.includes('map-list'), 'geo alias paints the map list, not a simplified table')

  assert.ok(GUEST_RENDER_JS.includes('pickSeriesSlug'), 'per-view chart overlay is concatenated into the live renderer')
  assert.ok(GUEST_RENDER_JS.includes('renderDateBucketHtml'), 'date board overlay is concatenated into the live renderer')
  assert.ok(GUEST_RENDER_JS.includes('schedWeekStartSun'), 'scheduler overlay is concatenated into the live renderer')
  assert.ok(GUEST_RENDER_JS.includes('GUEST_TREE_DEPTH_CAP'), 'tree overlay is concatenated into the live renderer')
  assert.ok(GUEST_RENDER_JS.includes('pickWorkloadAssigneeSlug'), 'workload overlay is concatenated into the live renderer')
  assert.ok(GUEST_RENDER_JS.includes('guestTlLabHtml'), 'timeline overlay is concatenated into the live renderer')

  const pivot = rendererApi.renderReadBodyHtml({
    ...v2,
    viewType: 'pivot',
    viewConfig: {
      ...v2.viewConfig,
      rowFieldSlug: 'stage',
      colFieldSlug: 'name',
      valueFieldSlug: 'amount',
    },
  })
  assert.equal(pivot.simplified, false)
  assert.ok(pivot.html.includes('pivot-wrap') && pivot.html.includes('pivot-matrix'), 'pivot is a matrix, not a record table or chart')
  assert.ok(pivot.html.includes('Total'), 'pivot paints row/column totals')
  assert.ok(!pivot.html.includes('chart-svg'), 'pivot is not a chart fallback')

  const pivotUnbound = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'pivot' })
  assert.ok(
    pivotUnbound.html.includes('Pick row and column fields'),
    'pivot without row/col bindings does not guess a chart',
  )

  const calGrid = rendererApi.renderReadBodyHtml({ ...dated, viewType: 'calendar' })
  assert.equal(calGrid.simplified, false)
  assert.ok(calGrid.html.includes('class="cal"') || calGrid.html.includes('date-board'), 'calendar is a month grid (or date-board when undated)')

  // Unknown view types fall back to table WITH the honest simplified flag.
  const weird = { ...v2, viewType: 'not_a_real_view' }
  const fallback = rendererApi.renderReadBodyHtml(weird)
  assert.ok(fallback.html.includes('<table'), 'unknown viewType falls back to table')
  assert.equal(fallback.simplified, true, 'fallback discloses the simplified layout')
  assert.ok(!fallback.html.includes('date-board'), 'unknown viewType is not a date board')

  const docView = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'doc' })
  assert.equal(docView.simplified, false, 'doc paints title + body cards, not a simplified table')
  assert.ok(docView.html.includes('doc-list') || docView.html.includes('row-card'), 'doc uses stacked document cards')

  const formView = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'form' })
  assert.equal(formView.simplified, false)
  assert.ok(formView.html.includes('class="stack') && formView.html.includes('row-card'), 'form read uses stacked field cards')

  const tl = rendererApi.renderReadBodyHtml({
    ...dated,
    viewType: 'timeline',
    viewConfig: { ...dated.viewConfig, startDateFieldSlug: 'due', endDateFieldSlug: 'due' },
  })
  assert.equal(tl.simplified, false)
  assert.ok(tl.html.includes('class="tl"') && tl.html.includes('tl-bar'), 'timeline paints horizontal bars')

  const sched = rendererApi.renderReadBodyHtml({
    ...dated,
    viewType: 'scheduler',
    viewConfig: { ...dated.viewConfig, startDateFieldSlug: 'due', resourceFieldSlug: 'stage' },
  })
  assert.equal(sched.simplified, false)
  assert.ok(sched.html.includes('class="sched"'), 'scheduler paints resource lanes')
  assert.ok(sched.html.includes('>Resource<'), 'scheduler 7-day grid has a Resource header')
  assert.ok(sched.html.includes('repeat(7,minmax(0,1fr))'), 'scheduler paints a 7-day day-column grid')
  assert.ok(sched.html.includes('tl-bar'), 'scheduler paints booking bars')
  assert.ok(/won/i.test(sched.html) && /lost/i.test(sched.html), 'scheduler fans resources into lanes')
  assert.ok(!sched.html.includes('<table'), 'scheduler is not a row table')

  const work = rendererApi.renderReadBodyHtml({
    ...v2,
    viewType: 'workload',
    fields: [field('name', 'Name'), field('owner', 'Owner', 'user'), field('stage', 'Stage', 'status')],
    columns: ['name', 'owner', 'stage'],
    viewConfig: { ...v2.viewConfig, assigneeFieldSlug: 'owner' },
    rows: [
      { id: '1', data: { name: 'A', owner: { id: 'u1', name: 'Jane' }, stage: 'won' }, display: { name: 'A', owner: 'Jane', stage: 'Won' } },
      { id: '2', data: { name: 'B', owner: { id: 'u2', name: 'Bob' }, stage: 'lost' }, display: { name: 'B', owner: 'Bob', stage: 'Lost' } },
      { id: '4', data: { name: 'D' }, display: { name: 'D' } },
    ],
  })
  assert.equal(work.simplified, false)
  assert.ok(work.html.includes('workload') && work.html.includes('wl-bar'), 'workload paints capacity bars')

  const workStatusOnly = rendererApi.renderReadBodyHtml({
    ...v2,
    viewType: 'workload',
    viewConfig: { ...v2.viewConfig, assigneeFieldSlug: 'stage' },
  })
  assert.ok(
    workStatusOnly.html.includes('no person field'),
    'workload does not silently group by status when the stamp is not a person field',
  )

  const tree = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'tree' })
  assert.equal(tree.simplified, false)
  assert.ok(tree.html.includes('guest-tree'), 'tree paints nested guest-tree chrome, not a generic table')

  const mapView = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'map' })
  assert.equal(mapView.simplified, false)
  assert.ok(mapView.html.includes('map-list'), 'map is a location list (no live map tiles on the public page)')

  // List + gallery renderers dispatch on their slugs.
  const list = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'list' })
  assert.ok(list.html.includes('class="stack') && list.html.includes('list-share'), 'list viewType uses stacked cards')
  assert.ok(list.html.includes('class="row-title"') || list.html.includes('list-thumb'), 'list card has a title or cover')

  const feed = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'feed' })
  assert.ok(feed.html.includes('stack feed'), 'feed keeps the stacked feed chrome')
  assert.ok(
    feed.html.includes('Creates, edits, and comments stay in the app'),
    'feed without activity events is honest that history stays in the app',
  )

  const scrum = rendererApi.renderReadBodyHtml({ ...v2, viewType: 'scrum' })
  assert.ok(scrum.html.includes('class="board"'), 'scrum aliases to board')

  // Page header shows label + module/entity crumb + mode hint.
  const head = rendererApi.pageHeadHtml({ label: 'Pipeline', mode: 'read' }, v2)
  assert.ok(head.includes('Pipeline'))
  assert.ok(head.includes('Sales / Deals'), 'moduleName/entityName crumb rendered')
  assert.ok(head.includes('can view (not edit)'), 'mode hint rendered')
}

// ---- (c) escaping still applies everywhere ----
{
  const hostile = {
    version: 2,
    mode: 'read',
    viewType: 'list',
    label: '<img src=x onerror=alert(1)>',
    entityId: 'e1',
    fields: [field('name', '<b>Name</b>')],
    columns: ['name'],
    viewConfig: { titleFieldSlug: 'name' },
    rows: [
      { id: '1', data: { name: '<script>alert(1)</script>' }, display: { name: '<script>alert(1)</script>' } },
    ],
    total: 1,
    truncated: false,
    includeCsv: false,
    pushedAt: Date.now(),
  }
  const out = rendererApi.renderReadBodyHtml(hostile)
  assert.ok(!out.html.includes('<script>'), 'script tag in a cell never survives raw')
  assert.ok(out.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'cell value is HTML-escaped')
  assert.ok(!out.html.includes('<b>Name</b>'), 'field names are escaped too')
  const head = rendererApi.pageHeadHtml({ label: hostile.label, mode: 'read' }, hostile)
  assert.ok(!head.includes('<img src=x'), 'share label is escaped in the page header')
}

// ---- (d) image URL gating on the gallery renderer ----
{
  const gallery = {
    version: 2,
    mode: 'read',
    viewType: 'gallery',
    label: 'Catalog',
    entityId: 'e1',
    fields: [field('name', 'Name'), field('img', 'Image', 'url')],
    columns: ['name', 'img'],
    viewConfig: { titleFieldSlug: 'name', imageFieldSlug: 'img' },
    rows: [
      { id: '1', data: { name: 'Good', img: 'https://example.com/a.png' }, display: { name: 'Good' } },
      { id: '2', data: { name: 'Js', img: 'javascript:alert(1)' }, display: { name: 'Js' } },
      { id: '3', data: { name: 'Data', img: 'data:image/png;base64,AAAA' }, display: { name: 'Data' } },
      { id: '4', data: { name: 'Breakout', img: 'https://example.com/a.png" onerror="alert(1)' }, display: { name: 'Breakout' } },
      { id: '5', data: { name: 'None' }, display: { name: 'None' } },
    ],
    total: 5,
    truncated: false,
    includeCsv: false,
    pushedAt: Date.now(),
  }
  const out = rendererApi.renderReadBodyHtml(gallery)
  const imgCount = out.html.split('<img class="gallery-img"').length - 1
  assert.equal(imgCount, 1, 'only the valid http(s) URL becomes an <img>')
  assert.ok(out.html.includes('src="https://example.com/a.png"'), 'valid https image emitted')
  assert.ok(!out.html.includes('javascript:'), 'javascript: URL never appears')
  assert.ok(!out.html.includes('data:image'), 'data: URL is not an allowed cell image source')
  const phCount = out.html.split('gallery-ph').length - 1
  assert.equal(phCount, 4, 'every refused/missing image gets the placeholder block')

  // url cells share the same gate in table cells.
  assert.equal(rendererApi.isSafeHttpUrl('https://example.com/x'), true)
  assert.equal(rendererApi.isSafeHttpUrl('javascript:alert(1)'), false)
  assert.equal(rendererApi.isSafeHttpUrl('https://e.com/a" onmouseover="x'), false)
  // Portal logo gate: https or base64 data image only (mirrors the desktop writer).
  assert.equal(rendererApi.isSafeLogoSrc('https://example.com/logo.png'), true)
  assert.equal(rendererApi.isSafeLogoSrc('http://example.com/logo.png'), false)
  assert.equal(rendererApi.isSafeLogoSrc('data:image/png;base64,aGVsbG8='), true)
  assert.equal(rendererApi.isSafeLogoSrc('data:text/html;base64,aGVsbG8='), false)
  assert.equal(rendererApi.isPlaceholderChrome('Tagline'), true)
  assert.equal(rendererApi.isPlaceholderChrome('Footer'), true)
  assert.equal(rendererApi.isPlaceholderChrome('Built for solar'), false)
  assert.equal(rendererApi.firstAccentHex(['#3b82f6', '#22c55e']), '#3b82f6')
  assert.equal(rendererApi.firstAccentHex(['nope', '#abc']), '#abc')
  assert.equal(rendererApi.firstAccentHex([]), '')
  assert.ok(GUEST_PAGE_CSS.includes('--guest-accent'), 'buttons use the brand accent variable')
  assert.ok(GUEST_PAGE_CSS.includes('padding:20px 20px 28px'), 'narrow portal form does not add a tall bottom gap')
  assert.ok(GUEST_FORM_FIELD_JS.includes("var def = '';"), 'guest forms start empty')
  assert.equal(GUEST_FORM_FIELD_JS.includes('f.default_value'), false, 'guest forms do not seed CRM defaults')
}

// ---- Cell chrome: checkbox Yes/No, chips, links, line breaks ----
{
  const row = {
    id: 'r',
    data: {
      done: true,
      undone: false,
      tags: ['red', 'blue'],
      site: 'https://example.com/page',
      badSite: 'javascript:alert(1)',
      mail: 'a@b.co',
      notes: 'line one\nline two',
    },
  }
  assert.ok(rendererApi.cellHtml(field('done', 'Done', 'checkbox'), row).includes('Yes'))
  assert.ok(rendererApi.cellHtml(field('undone', 'Undone', 'checkbox'), row).includes('No'))
  const chips = rendererApi.cellHtml(field('tags', 'Tags', 'tags'), row)
  assert.ok(chips.includes('class="pill') && chips.includes('red') && chips.includes('blue'), 'tag cells render pills')
  const link = rendererApi.cellHtml(field('site', 'Site', 'url'), row)
  assert.ok(link.includes('rel="noopener noreferrer"') && link.includes('target="_blank"'), 'url cell is a safe link')
  const badLink = rendererApi.cellHtml(field('badSite', 'Bad', 'url'), row)
  assert.ok(!badLink.includes('<a '), 'non-http(s) url cell renders as plain text')
  assert.ok(rendererApi.cellHtml(field('mail', 'Mail', 'email'), row).includes('mailto:a@b.co'))
  assert.ok(rendererApi.cellHtml(field('notes', 'Notes', 'long_text'), row).includes('line one<br/>line two'))
}

// ---- Theme: shared baseline document + styled 404/410 page ----
{
  const doc = guestPageDocument({ title: 'X <script>', bodyHtml: '<div id="app"></div>' })
  assert.ok(doc.includes('X &lt;script&gt;'), 'document title is escaped')
  assert.ok(doc.includes('#0a0b0e'), 'baseline page background present')
  assert.ok(GUEST_PAGE_CSS.includes('#131519') && GUEST_PAGE_CSS.includes('#26282e'), 'card colors in baseline')
  assert.ok(GUEST_PAGE_CSS.includes('.date-board') && GUEST_PAGE_CSS.includes('.dash-tiles'), 'date-board and dash-tiles live in the shared CSS')
  assert.ok(GUEST_PAGE_CSS.includes('.chart-svg') && GUEST_PAGE_CSS.includes('.cal'), 'chart SVG and calendar grid live in the shared CSS')
  assert.ok(GUEST_PAGE_CSS.includes('.sched') && GUEST_PAGE_CSS.includes('.wl-bar'), 'scheduler and workload chrome live in the shared CSS')
  assert.ok(GUEST_PAGE_CSS.includes('html,body{width:100%'), 'html/body stretch to the viewport')
  assert.ok(GUEST_PAGE_CSS.includes('max-width:none'), 'guest read pages are full width, not a 1100px column')
  assert.ok(!GUEST_PAGE_CSS.includes('max-width:1100px'), 'the 1100px guest column cap is gone')
  assert.ok(GUEST_PAGE_CSS.includes('table{width:max-content;min-width:100%'), 'wide tables grow past the viewport instead of squeezing')
  assert.ok(GUEST_PAGE_CSS.includes('.table-wrap,.pivot-wrap{overflow-x:auto'), 'table and pivot scroll sideways')
  assert.ok(GUEST_PAGE_CSS.includes('min-width:280px'), 'notes cells keep a floor so they do not collapse')
  const phoneCss = GUEST_PAGE_CSS.slice(GUEST_PAGE_CSS.indexOf('@media (max-width:640px)'))
  assert.ok(!phoneCss.includes('th,td{white-space:normal}'), 'phone breakpoint does not wrap every table cell')
  assert.ok(!phoneCss.includes('overflow-x:hidden'), 'phone breakpoint does not kill board sideways scroll')
  assert.ok(GUEST_RENDER_JS.includes('class="card table-card"><div class="table-wrap">'), 'table uses outer card + inner scroll wrap')
  assert.ok(
    GUEST_RENDER_JS.includes('class="card table-card"><div class="pivot-wrap">') ||
      GUEST_RENDER_JS.includes('class="card"><div class="pivot-wrap">'),
    'pivot uses two nodes so overflow and radius stay apart',
  )
  assert.ok(!GUEST_RENDER_JS.includes('pivot-wrap card'), 'pivot never puts overflow and radius on one node')
  assert.ok(GUEST_PAGE_CSS.includes('repeat(7,minmax(88px,1fr))'), 'calendar days keep a floor and can scroll sideways')
  assert.ok(GUEST_PAGE_CSS.includes('min(70vh,720px)'), 'chart SVG can grow with the viewport')
  assert.ok(GUEST_HTML_RESPONSE_HEADERS['cache-control'] === 'no-store', 'guest HTML is not cacheable')
  assert.ok(GUEST_HTML_RESPONSE_HEADERS.vary === 'Accept', 'guest HTML varies on Accept so JSON cannot reuse it')
  assert.ok(doc.includes('Cache-Control" content="no-store"'), 'guest document also asks the browser not to cache')
  assert.ok(GUEST_PAGE_CSS.includes('@media (max-width:640px)'), 'layouts collapse on a phone-width viewport')
  assert.ok(!doc.includes('http://') && !doc.includes('https://'), 'no external assets in the shell document')
  const gone = guestErrorPageHtml('Link no longer available', 'This share has expired. Ask for a new link.')
  assert.ok(gone.includes('gate-wrap'), '404/410 page uses the centered gate card')
  assert.ok(gone.includes('This share has expired'), 'plain message rendered')
  assert.ok(gone.includes('#0a0b0e'), 'error page carries the same baseline')
}

// ---- Store admit: v1 and v2 both land, unknown versions refused ----
{
  const root = mkdtempSync(join(tmpdir(), 'ts-guest-page-'))
  try {
    const store = new PublicShareBridgeStore(root, null)
    const basePayload = {
      mode: 'read',
      viewType: 'table',
      label: 'Rows',
      entityId: 'ent1',
      fields: [field('name', 'Name')],
      rows: [{ id: '1', data: { name: 'a' } }],
      total: 1,
      truncated: false,
      includeCsv: false,
      pushedAt: Date.now(),
    }
    const shareArgs = (tokenPlain: string, localShareId: string, payload: unknown) => ({
      tokenHash: hashPublicShareToken(tokenPlain),
      localShareId,
      mode: 'read' as const,
      viewType: 'table',
      label: 'Rows',
      passwordHash: null,
      includeCsv: false,
      expiresAt: null,
      payload,
    })

    const v1 = store.upsertShare('mem1', shareArgs('tok-v1', 'ls1', { version: 1, ...basePayload }))
    assert.equal(v1.ok, true, 'v1 payload still admitted')

    const v2Payload = {
      version: 2,
      ...basePayload,
      viewType: 'board',
      moduleName: 'Sales',
      entityName: 'Deals',
      columns: ['name'],
      viewConfig: { groupByFieldSlug: 'name', titleFieldSlug: 'name', imageFieldSlug: null },
      rows: [{ id: '1', data: { name: 'a' }, display: { name: 'A' } }],
    }
    const v2 = store.upsertShare('mem1', shareArgs('tok-v2', 'ls2', v2Payload))
    assert.equal(v2.ok, true, 'v2 payload admitted')
    const readBack = store.readPayload(hashPublicShareToken('tok-v2'))
    assert.ok(readBack && readBack.version === 2, 'v2 payload round-trips')
    assert.equal(readBack?.rows[0]?.display?.name, 'A', 'display map survives the round trip')
    assert.equal(readBack?.viewConfig?.groupByFieldSlug, 'name', 'viewConfig survives the round trip')

    const v3 = store.upsertShare('mem1', shareArgs('tok-v3', 'ls3', { version: 3, ...basePayload }))
    assert.equal(v3.ok, false, 'unknown payload version refused')

    const badCols = store.upsertShare(
      'mem1',
      shareArgs('tok-v4', 'ls4', { version: 2, ...basePayload, columns: 'name' }),
    )
    assert.equal(badCols.ok, false, 'v2 with malformed columns refused')
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* */ }
  }
}

// ---- server.ts shells route through the shared modules (structural pins) ----
{
  const serverSrc = readFileSync(
    fileURLToPath(new URL('../src/server.ts', import.meta.url)),
    'utf8',
  )

  // Bound each shell to its own function region (start anchor to the next
  // top-level declaration), never a character window.
  const sliceRegion = (startAnchor: string, endAnchor: string): string => {
    const start = serverSrc.indexOf(startAnchor)
    assert.ok(start >= 0, `region anchor missing: ${startAnchor}`)
    const end = serverSrc.indexOf(endAnchor, start + startAnchor.length)
    assert.ok(end > start, `region end anchor missing after ${startAnchor}`)
    return serverSrc.slice(start, end)
  }

  const shareShell = sliceRegion('function guestShareShellHtml', 'async function handleGuestComposeShare')
  assert.ok(shareShell.includes('guestPageDocument('), 'share shell uses the shared document')
  assert.ok(shareShell.includes('${GUEST_RENDER_JS}'), 'share shell embeds the shared renderers')
  assert.ok(shareShell.includes('${GUEST_FORM_FIELD_JS}'), 'share shell embeds the shared form fields')
  assert.ok(
    shareShell.includes('unlockedPassword = pw') && shareShell.includes('body.password = unlockedPassword'),
    'password-protected create submit carries the unlocked password (the gate input is gone after unlock)',
  )
  assert.ok(shareShell.includes('renderReadBodyHtml(content)'), 'read mode dispatches per viewType')
  assert.ok(shareShell.includes("cache: 'no-store'"), 'share JSON fetch is not cacheable')
  assert.ok(shareShell.includes('runGuestEnhancers(content)'), 'share shell runs post-paint enhancers')
  assert.ok(GUEST_RENDER_JS.includes('function runGuestEnhancers'), 'enhancer chokepoint lives in the concatenated renderer')
  assert.ok(
    /if\s*\((?:content\s*&&\s*)?!content\.viewType\s*&&\s*share\.viewType\)\s*content\.viewType\s*=\s*share\.viewType/.test(shareShell),
    'share.viewType fills a missing payload viewType before dispatch',
  )
  assert.ok(
    shareShell.includes('This layout is simplified on the public page.'),
    'simplified layouts use the honest ASCII note',
  )
  assert.ok(shareShell.includes('csvFromContent(content)'), 'CSV export uses the shared display-value builder')

  const composeShell = sliceRegion('function guestComposeShareShellHtml', 'async function handleGuestPortal')
  assert.ok(composeShell.includes('guestPageDocument('), 'compose shell uses the shared document')
  assert.ok(composeShell.includes('${GUEST_GATE_JS}'), 'compose shell embeds the shared gate card')

  const portalShell = sliceRegion('function guestPortalShellHtml', 'async function handleGuestPublicShare')
  assert.ok(portalShell.includes('guestPageDocument('), 'portal shell uses the shared document')
  assert.ok(portalShell.includes('isSafeLogoSrc'), 'portal logo src is gated client-side')
  assert.ok(GUEST_RENDER_JS.includes('function isHexColor'), 'portal accent hex is gated in the shared renderer')
  assert.ok(portalShell.includes('isPlaceholderChrome'), 'placeholder Tagline/Footer is skipped')
  assert.ok(portalShell.includes('firstAccentHex'), 'first palette hex becomes the accent')
  assert.ok(portalShell.includes('--guest-accent'), 'accent is a CSS variable, not a swatch strip')
  assert.ok(!portalShell.includes('class="swatches"'), 'portal chrome does not paint brand swatches')

  // Every guest 404/410 HTML response routes through the styled error page;
  // no bare inline error documents remain anywhere in server.ts.
  const errorPageCalls = serverSrc.split('guestErrorPageHtml(').length - 1
  assert.ok(errorPageCalls >= 6, `all six guest 404/410 sites use guestErrorPageHtml (found ${errorPageCalls})`)
  assert.ok(serverSrc.includes('function sendGuestHtml'), 'guest HTML goes through one no-store helper')
  assert.ok(
    !/'content-type': 'text\/html; charset=utf-8'/.test(serverSrc),
    'no bare guest HTML writeHead remains beside sendGuestHtml',
  )
  assert.ok(
    !serverSrc.includes('<!DOCTYPE html><html><body><p>'),
    'no bare unstyled guest error documents remain',
  )

  // The embedded page scripts must PARSE as JavaScript (constructing a
  // Function parses without executing). Catches template-literal escaping
  // mistakes in any shell before a guest ever loads the page.
  for (const [name, script] of Object.entries(guestPageScripts())) {
    assert.doesNotThrow(() => new Function(script), `${name} page script parses`)
  }
}

console.log('guest-page-render: ok')
