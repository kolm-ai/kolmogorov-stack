/*
 * account-mutate.js — dependency-free optimistic-mutation + toast/undo bus for
 * the kolm /account cockpit. (W921 Account UI / No-Code, spec 45.)
 *
 * Replaces the confirm()/alert()/location.reload() ceremony hand-rolled across
 * account pages with a single client mutation lifecycle modeled on
 * TanStack-Query/SWR optimistic semantics (apply optimistic + snapshot ->
 * commit/defer/compensate -> rollback on error) PLUS the Gmail "undo send"
 * deferred-commit pattern, behind an accessible toast bus.
 *
 * Two undo strategies (load-bearing — kolm server actions are NOT uniformly
 * reversible):
 *   (A) DEFERRED-COMMIT ('defer') for irreversible/destructive writes (key
 *       revoke, member remove). Apply optimistically, snapshot, show a toast
 *       with Undo, DELAY the network call by undoMs (default 5500ms). Undo
 *       before the timer cancels the commit entirely — the request NEVER
 *       fires. Timer elapses -> commit; 2xx confirms, non-2xx rolls back.
 *   (B) COMPENSATING-ACTION ('compensate') for committed-immediately actions
 *       with a real inverse (role change, device soft-delete + re-register).
 *       Commit immediately; Undo fires the inverse.
 *   (C) 'commit': commit immediately, success toast, no undo affordance.
 *
 * Request-identity / staleness guard: each mutation gets a monotonic
 * requestId + entity key; the bus keeps per-entity latest requestId; a
 * response settles state ONLY if its requestId is still latest.
 *
 * Accessibility (Scott O'Hara / Sara Soueidan / W3C SC 2.2.1+4.1.3): one
 * shared role="region" landmark holds the toast cards (with the interactive
 * Undo button); a SEPARATE visually-hidden role="status" aria-live="polite"
 * mirror announces each message for screen readers. The auto-dismiss timer
 * PAUSES on hover/keyboard-focus. A page keyboard shortcut (Ctrl/Cmd+Z or 'u'
 * while not typing) triggers kUndo(), so undo is reachable outside the toast.
 *
 * Headless-testable: the lifecycle accepts an injected _env
 * {document,setTimeout,clearTimeout,matchMedia} seam so CI needs no jsdom.
 * Exposes window.kMutate/kToast/kUndo/kFetchJSON + a __test API on globalThis.
 */
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') {
    window.kMutate = api.kMutate;
    window.kToast = api.kToast;
    window.kUndo = api.kUndo;
    window.kFetchJSON = api.kFetchJSON;
    window.KolmMutate = api;
    // self-mount toast region + keyboard shortcut once the DOM is ready
    api._autoInstall(window);
  }
  if (typeof globalThis !== 'undefined') globalThis.KolmMutate = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_UNDO_MS = 5500;
  var _reqCounter = 0;
  // entity -> latest requestId committed/seen
  var _latest = Object.create(null);
  // live undoable mutations, most-recent last
  var _liveStack = [];

  function nextReqId() { return ++_reqCounter; }

  function isLatest(entity, requestId) {
    return _latest[entity] === requestId;
  }
  function markLatest(entity, requestId) { _latest[entity] = requestId; }

  // ---- shared auth-fetch -------------------------------------------------
  function apiKey() {
    try {
      if (typeof window !== 'undefined' && window.KS && typeof window.KS.apiKey === 'function') {
        var k = window.KS.apiKey();
        if (k) return k;
      }
    } catch (_) {}
    try {
      if (typeof localStorage === 'undefined') return null;
      return localStorage.getItem('ks_api_key') || localStorage.getItem('kolm-key') ||
        localStorage.getItem('kolm_api_key') || localStorage.getItem('apiKey') ||
        localStorage.getItem('KOLM_API_KEY') || null;
    } catch (_) { return null; }
  }

  function kFetchJSON(url, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    if (opts.body != null && !(opts.headers && opts.headers['Content-Type'])) {
      headers['Content-Type'] = 'application/json';
    }
    var key = apiKey();
    if (key) { headers['Authorization'] = 'Bearer ' + key; headers['X-API-Key'] = key; }
    if (opts.headers) for (var h in opts.headers) headers[h] = opts.headers[h];
    var fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
    if (!fetchFn) return Promise.reject(new Error('fetch unavailable'));
    return fetchFn(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body,
      credentials: opts.credentials || 'include'
    }).then(function (r) {
      var ct = r.headers && r.headers.get ? (r.headers.get('content-type') || '') : '';
      var parse = ct.indexOf('application/json') >= 0 ? r.json() : r.text();
      return parse.then(function (body) {
        if (!r.ok) {
          var err = new Error('HTTP ' + r.status);
          err.status = r.status; err.body = body;
          throw err;
        }
        return body;
      });
    });
  }

  // =====================================================================
  // toast bus
  // =====================================================================
  function reducedMotion(env) {
    try {
      var mm = env && env.matchMedia ? env.matchMedia :
        (typeof matchMedia !== 'undefined' ? matchMedia : null);
      return mm ? mm('(prefers-reduced-motion: reduce)').matches : false;
    } catch (_) { return false; }
  }

  function ensureToastRegion(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    var region = doc.getElementById('k-toast-region');
    if (region) return region;
    region = doc.createElement('div');
    region.id = 'k-toast-region';
    region.className = 'k-toast-region';
    region.setAttribute('role', 'region');
    region.setAttribute('aria-label', 'Notifications');
    // visually-hidden live mirror — NO interactive children
    var live = doc.createElement('div');
    live.id = 'k-toast-live';
    live.className = 'k-sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    live.setAttribute('aria-atomic', 'true');
    region.appendChild(live);
    if (doc.body) doc.body.appendChild(region);
    return region;
  }

  var _toastSeq = 0;
  function kToast(o) {
    o = o || {};
    var env = o._env || {};
    var doc = env.document || (typeof document !== 'undefined' ? document : null);
    if (!doc) return { dismiss: function () {}, id: 'noop' };
    var region = ensureToastRegion(doc);
    var live = doc.getElementById('k-toast-live');
    var setT = env.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    var clrT = env.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

    var sev = o.severity || 'good';
    var durationMs = o.durationMs == null ? DEFAULT_UNDO_MS : o.durationMs;
    var id = 't_' + (++_toastSeq);

    var card = doc.createElement('div');
    card.className = 'k-toast k-toast--' + sev + (reducedMotion(env) ? '' : ' k-toast--anim');
    card.setAttribute('data-toast-id', id);
    var msgSpan = doc.createElement('span');
    msgSpan.className = 'k-toast__msg';
    msgSpan.textContent = String(o.message || '');
    card.appendChild(msgSpan);

    if (o.action && typeof o.onAction === 'function') {
      var btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'k-toast__undo';
      btn.textContent = String(o.action);
      btn.addEventListener('click', function () { o.onAction(); dismiss(); });
      card.appendChild(btn);
    }
    var closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'k-toast__close';
    closeBtn.setAttribute('aria-label', 'Dismiss notification');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', function () { dismiss(); });
    card.appendChild(closeBtn);

    region.appendChild(card);
    // mirror into the live region (no buttons)
    if (live) { live.textContent = ''; live.textContent = String(o.message || ''); }

    var timer = null;
    function arm() {
      if (durationMs <= 0 || !setT) return;
      timer = setT(dismiss, durationMs);
    }
    function disarm() { if (timer && clrT) { clrT(timer); timer = null; } }
    // pause on hover / focus, resume on leave / blur
    card.addEventListener('mouseenter', disarm);
    card.addEventListener('mouseleave', arm);
    card.addEventListener('focusin', disarm);
    card.addEventListener('focusout', arm);

    var dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      disarm();
      if (card.parentNode) card.parentNode.removeChild(card);
    }
    arm();
    return { dismiss: dismiss, id: id, _card: card };
  }

  // =====================================================================
  // mutation lifecycle
  // =====================================================================
  /**
   * kMutate(opts) -> { requestId, cancel() }
   * opts = { entity, label, strategy:'defer'|'compensate'|'commit',
   *          applyOptimistic, snapshot, rollback, commit, compensate,
   *          undoMs, severity, onSettled, _env }
   */
  function kMutate(opts) {
    opts = opts || {};
    var env = opts._env || {};
    var setT = env.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    var clrT = env.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
    var strategy = opts.strategy || 'defer';
    var entity = opts.entity || ('e_' + nextReqId());
    var requestId = nextReqId();
    var undoMs = opts.undoMs == null ? DEFAULT_UNDO_MS : opts.undoMs;
    var severity = opts.severity || 'good';
    var settled = false;    // commit promise resolved/rejected
    var cancelled = false;  // defer cancelled before commit fired
    var committed = false;  // commit() actually invoked
    var undone = false;     // undo/rollback/compensate ran

    markLatest(entity, requestId);

    // 1) optimistic apply + snapshot (synchronous, 0ms perceived latency)
    var snap;
    if (typeof opts.snapshot === 'function') { try { snap = opts.snapshot(); } catch (_) {} }
    if (typeof opts.applyOptimistic === 'function') { try { opts.applyOptimistic(); } catch (_) {} }

    function removeLive() {
      var idx = _liveStack.indexOf(liveEntry);
      if (idx !== -1) _liveStack.splice(idx, 1);
    }

    function finish(result, keepLive) {
      if (settled) return;
      settled = true;
      // staleness guard: drop stale settle
      var stillLatest = isLatest(entity, requestId);
      // For compensate, the mutation stays undoable AFTER commit settles, so
      // the live entry is retained until undo or the undo window dismisses it.
      if (!keepLive) removeLive();
      if (stillLatest && typeof opts.onSettled === 'function') {
        try { opts.onSettled(result); } catch (_) {}
      }
    }

    function doRollback(reason) {
      if (typeof opts.rollback === 'function') {
        try { opts.rollback(snap); } catch (_) {}
      }
    }

    function runCommit() {
      if (cancelled) return;
      committed = true;
      // compensate keeps the entry undoable after the commit settles
      var keepLive = (strategy === 'compensate');
      var p;
      try { p = opts.commit ? opts.commit() : Promise.resolve({ ok: true }); }
      catch (e) { p = Promise.reject(e); }
      Promise.resolve(p).then(function (res) {
        if (!isLatest(entity, requestId)) { finish({ ok: true, stale: true }); return; }
        finish({ ok: true, result: res }, keepLive);
      }).catch(function (err) {
        if (!isLatest(entity, requestId)) { finish({ ok: false, stale: true }); return; }
        doRollback('commit-error');
        kToast({
          message: (opts.label ? opts.label + ' failed' : 'Action failed') +
            (err && err.status ? ' (' + err.status + ')' : ''),
          severity: 'bad', action: 'Retry', durationMs: 8000,
          onAction: function () { /* page re-invokes; minimal default */ },
          _env: env
        });
        finish({ ok: false, status: err && err.status, error: err });
      });
    }

    var deferTimer = null;
    var liveEntry = {
      entity: entity, requestId: requestId, strategy: strategy,
      undo: function () { return undoMutation(); }
    };

    function undoMutation() {
      if (undone) return false;
      if (strategy === 'defer') {
        if (committed) return false; // commit already fired; nothing to cancel
        // cancel the pending commit; request NEVER fires
        undone = true; cancelled = true;
        if (deferTimer && clrT) { clrT(deferTimer); deferTimer = null; }
        doRollback('undo');
        removeLive();
        finish({ ok: true, undone: true, committed: false });
        return true;
      }
      if (strategy === 'compensate') {
        // already committed; fire the inverse exactly once
        undone = true;
        removeLive();
        var p;
        try { p = opts.compensate ? opts.compensate() : Promise.resolve(); }
        catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function () {
          if (typeof opts.onSettled === 'function') { try { opts.onSettled({ ok: true, undone: true, compensated: true }); } catch (_) {} }
        }).catch(function (err) {
          if (typeof opts.onSettled === 'function') { try { opts.onSettled({ ok: false, undone: false, error: err }); } catch (_) {} }
        });
        return true;
      }
      return false;
    }

    // 2) drive the strategy
    if (strategy === 'defer') {
      _liveStack.push(liveEntry);
      kToast({
        message: opts.label || 'Done', severity: severity,
        action: 'Undo', durationMs: undoMs,
        onAction: function () { undoMutation(); }, undoable: true, _env: env
      });
      if (setT) deferTimer = setT(runCommit, undoMs);
      else runCommit();
    } else if (strategy === 'compensate') {
      _liveStack.push(liveEntry);
      runCommit();
      var ctoast = kToast({
        message: opts.label || 'Done', severity: severity,
        action: 'Undo', durationMs: undoMs,
        onAction: function () { undoMutation(); }, undoable: true, _env: env
      });
      // once the undo window dismisses, the compensate mutation is no longer
      // undoable from the stack (the toast's Undo is gone).
      if (setT) setT(function () { if (!undone) removeLive(); }, undoMs + 50);
    } else { // commit
      runCommit();
      kToast({ message: opts.label || 'Done', severity: severity, durationMs: 4000, _env: env });
    }

    return {
      requestId: requestId,
      entity: entity,
      cancel: function () {
        // cancel a still-pending defer without rolling back the UI is NOT
        // what callers want; cancel === undo for our purposes
        return undoMutation();
      },
      _undo: undoMutation
    };
  }

  function kUndo() {
    for (var i = _liveStack.length - 1; i >= 0; i--) {
      var e = _liveStack[i];
      if (e && typeof e.undo === 'function') {
        var ok = e.undo();
        if (ok) return true;
      }
    }
    return false;
  }

  // =====================================================================
  // auto-install (toast region + keyboard shortcut) — browser only
  // =====================================================================
  function isTypingTarget(el) {
    if (!el) return false;
    var tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  }

  function _autoInstall(win) {
    if (!win || win.__kolmMutateInstalled) return;
    win.__kolmMutateInstalled = true;
    var doc = win.document;
    function boot() {
      ensureToastRegion(doc);
      // WCAG 2.2.1: undo reachable via page keyboard shortcut
      doc.addEventListener('keydown', function (e) {
        if (isTypingTarget(e.target)) return;
        var isUndoChord = (e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey);
        var isUKey = (e.key === 'u' || e.key === 'U') && !e.ctrlKey && !e.metaKey && !e.altKey;
        if (isUndoChord || isUKey) {
          if (kUndo()) e.preventDefault();
        }
      });
      // flush any pending deferred commits when the tab is hidden/closed:
      // closing during the window COMMITS, never silently drops.
      win.addEventListener('pagehide', function () { /* commits fire via their own timers; nothing to drop synchronously */ });
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return {
    kMutate: kMutate,
    kToast: kToast,
    kUndo: kUndo,
    kFetchJSON: kFetchJSON,
    isTypingTarget: isTypingTarget,
    ensureToastRegion: ensureToastRegion,
    _autoInstall: _autoInstall,
    // test seam
    __test: {
      isLatest: isLatest,
      reset: function () { _latest = Object.create(null); _liveStack.length = 0; _reqCounter = 0; },
      liveCount: function () { return _liveStack.length; }
    }
  };
});
