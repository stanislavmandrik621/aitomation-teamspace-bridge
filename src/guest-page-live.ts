/** Shared, unbundled guest-page controller. No credentials or drafts persist to storage. */
export const GUEST_LIVE_JS = `
  function installGuestLivePage(options) {
    var timer = null, pending = 0, revision = 0, controller = null, background = false;
    var retryAt = 0, lastCheck = 0, fingerprint = null, gateFingerprint = null, blocked = true, review = false;
    var draft = Object.create(null), status = document.createElement('div'), draftPanel = document.createElement('div');
    status.id = 'guest-live-status'; status.setAttribute('role', 'status'); status.className = 'card'; status.hidden = true;
    draftPanel.id = 'guest-preserved-draft'; draftPanel.hidden = true;
    options.app.before(status); options.app.after(draftPanel);
    function formNodes() { return options.app.querySelectorAll('#form [data-slug]'); }
    function readNode(node) {
      var type = node.getAttribute('data-type') || node.type || node.tagName;
      var value = type === 'checkbox' ? node.checked : type === 'multiselect'
        ? Array.from(node.querySelectorAll('input:checked')).map(function(input){return input.value;}) : node.value;
      return { type: type, value: value };
    }
    function remember(event) {
      var node = event.target.closest('[data-slug]');
      if (node && options.app.contains(node)) draft[node.getAttribute('data-slug')] = readNode(node);
    }
    options.app.addEventListener('input', remember); options.app.addEventListener('change', remember);
    options.app.addEventListener('click', function(event){
      if ((blocked || review) && event.target.closest('#sub')) { event.preventDefault(); event.stopImmediatePropagation(); }
    }, true);
    function preserve() {
      var keys = Object.keys(draft); draftPanel.replaceChildren(); draftPanel.hidden = !keys.length;
      if (!keys.length) return;
      var details = document.createElement('details'), summary = document.createElement('summary'), text = document.createElement('textarea');
      summary.textContent = 'Your unsent draft'; text.readOnly = true; text.rows = 5;
      text.setAttribute('aria-label', 'Preserved unsent draft');
      text.value = keys.map(function(key){return key + ': ' + JSON.stringify(draft[key].value);}).join('\\n');
      details.append(summary, text); draftPanel.append(details);
    }
    function restore() {
      Array.prototype.forEach.call(formNodes(), function(node){
        var value = draft[node.getAttribute('data-slug')];
        if (!value || value.type !== readNode(node).type) return;
        if (value.type === 'checkbox') node.checked = value.value;
        else if (value.type === 'multiselect') Array.prototype.forEach.call(node.querySelectorAll('input'), function(input){input.checked = value.value.indexOf(input.value) >= 0;});
        else node.value = value.value;
      });
      preserve();
    }
    function disableForm(value) {
      Array.prototype.forEach.call(options.app.querySelectorAll('#form button'), function(button){
        if (value) { if (!button.hasAttribute('data-live-disabled')) button.setAttribute('data-live-disabled', button.disabled ? '1' : '0'); button.disabled = true; }
        else if (button.hasAttribute('data-live-disabled')) { button.disabled = button.getAttribute('data-live-disabled') === '1'; button.removeAttribute('data-live-disabled'); }
      });
    }
    function notice(message, action, label) {
      status.replaceChildren(); status.hidden = !message;
      if (!message) return;
      var text = document.createElement('p'); text.textContent = message; status.append(text);
      if (action) { var button = document.createElement('button'); button.type = 'button'; button.className = 'btn-secondary'; button.textContent = label || 'Check connection'; button.onclick = action; status.append(button); }
    }
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(check, Math.min(2147483647, Math.max(15000 + Math.random() * 3000, retryAt - Date.now())));
    }
    function accept(data, unlocked) {
      var locked = !data || !data.ok || ((data.needs_password || data.needs_pin || data.needs_otp) && !unlocked);
      if (locked) {
        blocked = true; review = false; fingerprint = null; options.clearCredentials();
        var gateKey = JSON.stringify([!!(data && data.ok), !!(data && data.needs_password), !!(data && data.needs_pin), !!(data && data.needs_otp), data && data.error]);
        if (gateFingerprint !== gateKey) options.render(data, unlocked);
        gateFingerprint = gateKey; preserve(); notice(''); return;
      }
      gateFingerprint = null;
      var next = JSON.stringify([data.share || data.portal, data.content, data.note]);
      var changed = fingerprint !== null && fingerprint !== next;
      blocked = false;
      if (fingerprint !== next || !options.app.firstChild) {
        var hadDraft = Object.keys(draft).length > 0;
        options.render(data, unlocked); restore();
        review = !!(hadDraft && options.app.querySelector('#form'));
        if (changed && options.app.querySelector('#form')) review = true;
      }
      fingerprint = next;
      if (review) notice('The form changed or access was renewed. Your draft is preserved. Review the current fields before submitting.', function(){ review = false; notice(''); disableForm(false); }, 'I reviewed the current form');
      else notice('');
      disableForm(review);
    }
    function api(method, body, isBackground) {
      if (Date.now() < retryAt) return Promise.resolve({status:429,j:{error:'Please wait before retrying.'},retryAfter:String(Math.ceil((retryAt-Date.now())/1000))});
      if (!isBackground && background && controller) controller.abort();
      var own = ++revision, abort = new AbortController(); controller = abort; background = !!isBackground; pending++;
      var timeout = setTimeout(function(){abort.abort();}, 15000);
      return options.api(method, body, abort.signal).then(function(response){
        if (own !== revision) return {stale:true};
        if (response.status === 429 || response.status === 503) {
          var seconds = Number(response.retryAfter), date = Date.parse(response.retryAfter || '');
          var delay = isFinite(seconds) && seconds > 0 ? seconds * 1000 : isFinite(date) ? Math.max(0,date-Date.now()) : 30000;
          retryAt = Date.now() + Math.max(1000,delay);
        }
        return response;
      }).catch(function(error){ if (own !== revision) return {stale:true}; throw error; })
        .finally(function(){ clearTimeout(timeout); pending--; if (own === revision) { controller = null; background = false; } schedule(); });
    }
    function rejectInvalid(response) {
      if (response.status === 401 || response.status === 403) {
        options.clearCredentials(); accept(options.locked(response.j), false);
        notice('Access changed. Sign in again to continue. Your unsent draft is preserved.'); return true;
      }
      if (response.status === 404 || response.status === 410) { accept(response.j, false); return true; }
      if (response.status === 429 || response.status >= 500 || response.status === 423) {
        blocked = true; disableForm(true); preserve();
        notice((response.j && response.j.error) || 'Could not verify this link. Submitting is paused.', check); return true;
      }
      return false;
    }
    function check() {
      clearTimeout(timer);
      if (document.hidden || pending || Date.now() < retryAt) { schedule(); return; }
      lastCheck = Date.now();
      var request = options.read();
      api(request.method, request.body, true).then(function(response){
        if (response.stale) return;
        if (response.status === 429 || response.status >= 500) throw new Error('Unavailable');
        if (response.status === 401 || response.status === 403) {
          options.clearCredentials();
          accept(options.locked(response.j), false); notice('Access changed. Sign in again to continue. Your unsent draft is preserved.');
          return;
        }
        accept(response.j, !!(response.j && response.j.unlocked));
      }).catch(function(){
        blocked = true; disableForm(true);
        // Once live access cannot be verified, do not leave a protected read snapshot on screen.
        if (!options.app.querySelector('#form')) { options.app.replaceChildren(); fingerprint = null; gateFingerprint = null; }
        preserve(); notice('Could not verify this link. Submitting is paused. Your unsent draft is preserved.', check);
      });
    }
    function focusCheck() { if (!document.hidden && Date.now() - lastCheck > 1500) check(); }
    window.addEventListener('pageshow', focusCheck); window.addEventListener('focus', focusCheck); window.addEventListener('online', focusCheck);
    document.addEventListener('visibilitychange', function(){ if (document.hidden) { blocked = true; disableForm(true); } else focusCheck(); });
    window.addEventListener('pagehide', function(){ clearTimeout(timer); revision++; if(controller)controller.abort(); });
    return {api:api, render:accept, start:check, rejectInvalid:rejectInvalid};
  }
`
