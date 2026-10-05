/**
 * Per-view guest overlays. Concatenated AFTER GUEST_RENDER_CORE_JS so a later
 * `function renderXHtml` declaration wins (and date_bucket can wrap
 * renderReadBodyHtml). Empty exports are intentional no-ops: the parent
 * renderer already matches that view.
 *
 * Order: leaf renderers first, date_bucket last (it reassigns
 * renderReadBodyHtml at eval time).
 */
import { GUEST_VIEW_TABLE_JS } from './table.js'
import { GUEST_VIEW_LIST_JS } from './list.js'
import { GUEST_VIEW_GALLERY_JS } from './gallery.js'
import { GUEST_VIEW_CHART_JS } from './chart.js'
import { GUEST_VIEW_PIVOT_JS } from './pivot.js'
import { GUEST_VIEW_CALENDAR_JS } from './calendar.js'
import { GUEST_VIEW_TIMELINE_JS } from './timeline.js'
import { GUEST_VIEW_SCHEDULER_JS } from './scheduler.js'
import { GUEST_VIEW_WORKLOAD_JS } from './workload.js'
import { GUEST_VIEW_TREE_JS } from './tree.js'
import { GUEST_VIEW_MAP_JS } from './map.js'
import { GUEST_VIEW_DOC_JS } from './doc.js'
import { GUEST_VIEW_FEED_JS } from './feed.js'
import { GUEST_VIEW_FORM_JS } from './form.js'
import { GUEST_VIEW_KANBAN_JS } from './kanban.js'
import { GUEST_VIEW_SCRUM_JS } from './scrum.js'
import { GUEST_VIEW_DASHBOARD_JS } from './dashboard.js'
import { GUEST_VIEW_WHITEBOARD_JS } from './whiteboard.js'
import { GUEST_VIEW_MINDMAP_JS } from './mindmap.js'
import { GUEST_VIEW_DATE_BUCKET_JS } from './date_bucket.js'

export const GUEST_VIEW_OVERLAYS_JS =
  GUEST_VIEW_TABLE_JS +
  GUEST_VIEW_LIST_JS +
  GUEST_VIEW_GALLERY_JS +
  GUEST_VIEW_CHART_JS +
  GUEST_VIEW_PIVOT_JS +
  GUEST_VIEW_CALENDAR_JS +
  GUEST_VIEW_TIMELINE_JS +
  GUEST_VIEW_SCHEDULER_JS +
  GUEST_VIEW_WORKLOAD_JS +
  GUEST_VIEW_TREE_JS +
  GUEST_VIEW_MAP_JS +
  GUEST_VIEW_DOC_JS +
  GUEST_VIEW_FEED_JS +
  GUEST_VIEW_FORM_JS +
  GUEST_VIEW_KANBAN_JS +
  GUEST_VIEW_SCRUM_JS +
  GUEST_VIEW_DASHBOARD_JS +
  GUEST_VIEW_WHITEBOARD_JS +
  GUEST_VIEW_MINDMAP_JS +
  GUEST_VIEW_DATE_BUCKET_JS
