/**
 * Guest form view snippet interpolated into the guest-page IIFE
 * (GUEST_RENDER_JS in guest-page-render.ts) AFTER the core helpers.
 *
 * Desktop FormView (apps/desktop/src/components/views/form-view.tsx) is
 * create-only: labeled type-aware FieldInput controls, optional parent
 * SearchableSelect, then Create Record. There is no desktop read-mode
 * form. Guest CREATE already interpolates GUEST_FORM_FIELD_JS into the
 * share and portal shells (server.ts: fieldInputHtml + readGuestFormFields
 * + Submit). This file must not mint a second fieldInputHtml /
 * readGuestFormFields - those would drift from the live create path.
 *
 * A view-only public link cannot host that create surface (page head
 * already says anyone with the link can view, not edit). Parent
 * renderReadBodyHtml maps viewType form to
 * renderListHtml(content, 'stack') with simplified:false. This overlay
 * wraps renderReadBodyHtml for form only and paints every visible field
 * as a labeled row (still `.stack` / `.row-card` so existing guest tests
 * hold). Create-mode stays GUEST_FORM_FIELD_JS in the share/portal shells.
 *
 * Do not mint a second fieldInputHtml / readGuestFormFields. Do not emit
 * inputs here. date_bucket still owns the outermost renderReadBodyHtml wrap.
 *
 * Template-literal rules (same as GUEST_RENDER_JS): no backticks, no
 * ${ } in any future snippet; double backslashes in regex/string literals.
 *
 * Gaps vs desktop FormView (none of these ship from this overlay):
 *
 * Create-mode lives in GUEST_FORM_FIELD_JS + share/portal shells (out of
 * this file). Missing vs FieldInput / FormView:
 * - Parent record SearchableSelect (siblingRecords / PARENT_ROOT_VALUE)
 * - Two-column @container grid and wide col-span (rich_text, json,
 *   signature, multiselect, tags, link, progress, checklist)
 * - validateCreateFormData / isEmptyValue / schema membership / inline
 *   fieldErrors / toast (guest submit is whatever the bridge create
 *   handler accepts; shells only disable Submit while the POST is in
 *   flight)
 * - Max lengths (text 2048, rich/json 65536, url 2048, ip 64, color 32)
 * - seedCreateFormDefaults / mergeNewCreateDefaults / fingerprint re-seed
 *   beyond String(default_value)
 * - hiddenFields: desktop still maps sortedFields (hidden rows paint);
 *   guest create uses content.fields as given (no Customize hidden filter,
 *   no isNonInputFieldType skip - a computed field on the payload becomes
 *   a text input)
 * - Empty "Add fields first" state (guest create with zero fields still
 *   paints Submit)
 * - Create Record copy, submitting spinner, Publish form (host-only);
 *   guest button is Submit; success copy is "Thanks - your submission
 *   was received."
 * - rating stars + max from config (guest is type=number step=any)
 * - currency symbol prefix; percent 0-100 clamp; config min/max
 * - datetime / time / week pickers (fall through to text)
 * - Switch + Yes/No (guest is a native checkbox with no label)
 * - tags add-on-Enter chips + suggestions stored as JSON array (guest:
 *   option chips or a comma-separated input; readGuestFormFields joins
 *   with commas, not JSON)
 * - checklist editor (ids, toggle, inline edit, assignee roster, item
 *   cap CHECKLIST_ITEMS_PER_FIELD_MAX)
 * - relation / user RelationPicker
 * - color picker + hex; progress range + bar; duration h/m
 * - location, link label+url, embed url, json textarea, barcode
 * - image/file URL + Browse (Browse is app-only; guest has no file IPC)
 * - ip_address, vote +/-, country list, date_range pair, signature pad
 * - notes (desktop default text; guest also text, not a textarea)
 * - computed/system read-only row (formula, lookup, rollup, count,
 *   time_tracked, button, auto_id, auto_number, created_at, updated_at,
 *   created_by, last_modified_by)
 * - phone type=tel
 * - required select: desktop omits - None -; guest always emits an empty
 *   <option> (clearable even when required)
 * - option objects: guest normOpts keeps string / .value only (cap 200);
 *   desktop normalizeOptions also unwraps colored {value,color} the same
 *   way for value, but guest never paints option color
 * - Shell labels wrap every field in <label> + "required" span; no 2-col
 *   layout, no per-field inline error, no reset-after-success (share
 *   keeps the filled form)
 *
 * Read-mode (this overlay: labeled stacked cards, every visible field):
 * - Not the create FormView (no inputs, no 2-col, no required *).
 * - Empty cells show a muted dash so the form shape stays.
 * - Cannot submit on a view-only link (correct)
 * - cellHtml does not cover FormView's structured widgets (stars,
 *   signature, checklist, duration) - display ladder + chips only
 * - No click-through to a record, no Publish form, no New record
 */
export const GUEST_VIEW_FORM_JS = `
  function renderFormReadHtml(content){
    var cols = visibleFields(content);
    var rows = Array.isArray(content && content.rows) ? content.rows : [];
    if (!cols.length || !rows.length) return emptyStateHtml();
    var titleSlug = titleSlugOf(content, cols);
    var html = '<p class="hint">This public page lists each record as a filled form. It cannot submit a new record.</p>';
    html += '<div class="stack form-read">';
    var ri, i, r, c, val;
    for (ri = 0; ri < rows.length; ri++) {
      r = rows[ri];
      html += '<div class="row-card">' + rowTitleHtml(r, titleSlug);
      for (i = 0; i < cols.length; i++) {
        c = cols[i];
        if (c.slug === titleSlug) continue;
        val = cellHtml(c, r);
        html += '<div class="kv"><div class="kv-k">' + esc(fieldLabel(c.name || c.slug)) + '</div><div class="kv-v">'
          + (val === '' ? '<span class="muted">-</span>' : val) + '</div></div>';
      }
      html += '</div>';
    }
    return html + '</div>';
  }
  if (typeof renderReadBodyHtml === 'function') {
    var _guestFormReadBody = renderReadBodyHtml;
    renderReadBodyHtml = function(content){
      var vt = canonicalViewType(content && content.viewType);
      if (vt === 'form') return { html: renderFormReadHtml(content), simplified: false };
      return _guestFormReadBody(content);
    };
  }
`

