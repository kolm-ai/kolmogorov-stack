/*
 * account-net.js — dependency-free global client error boundary + connectivity
 * supervisor + degraded-mode banner for the kolm /account cockpit.
 * (W921 Account UI / No-Code, spec 47.)
 *
 * Three layered client primitives, self-installed once per account page (the
 * spec's original nav.js mount was refuted for load-order + over-scope; this
 * module is account-scoped and installs itself on load, after which it still
 * registers global handlers — the page includes it directly so order is
 * controlled by the page):
 *
 *  (1) GLOBAL ERROR BOUNDARY — window 'error' (sync + capture-phase resource
 *      failures) + 'unhandledrejection' (the dominant failure mode: kfetch
 *      .then(render) with no terminal .catch). On a caught top-level error:
 *      (a) swap any stuck [aria-busy=true] skeleton to a retry card in place
 *      (NEVER white-screen), (b) de-dupe by message+stack hash so a render
 *      loop does not spam, (c) hand a redacted breadcrumb to a report sink
 *      (no PII / localStorage / Authorization; stack capped at 2 frames),
 *      (d) NEVER unregister the SW or wipe localStorage.
 *
 *  (2) CONNECTIVITY SUPERVISOR — a {ONLINE,PROBING,OFFLINE,DEGRADED} state
 *      machine. navigator.onLine + online/offline are HINTS only; reachability
 *      is CONFIRMED with fetch('/health',{cache:'no-store'}). A 3-strike
 *      circuit breaker (3 consecutive network failures) flips to PROBING
 *      without waiting for the OS offline event. Probe cadence = exponential
 *      backoff with jitter (min(1000*2^n,30000) * U(0.8,1.2)) so a fleet of
 *      tabs never thundering-herds /health.
 *
 *  (3) DEGRADED-MODE BANNER — /health already returns per-subsystem fields
 *      {gateway,capture_store,signing_key}. ok:true but a subsystem != 'ok'
 *      shows an amber DEGRADED banner (page still renders cached data),
 *      distinct from a red OFFLINE banner.
 *
 * Headless-testable: pure helpers (backoffDelay, classifyFetchError,
 * ConnectivitySupervisor with injected probe/now) attach to globalThis and
 * window.KolmNet, with an injected _env seam so CI needs no jsdom.
 *
 * Palette: cool-slate ONLY (status tokens var(--good)/--bad/--warn).
 */
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') {
    window.KolmNet = api;
    api._autoInstall(window);
  }
  if (typeof globalThis !== 'undefined') globalThis.KolmNet = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_BASE_MS = 1000;
  var DEFAULT_CAP_MS = 30000;
  var DEFAULT_STRIKES = 3;

  // ---- backoff -----------------------------------------------------------
  function backoffDelay(attempt, base, cap, rng) {
    base = base > 0 ? base : DEFAULT_BASE_MS;
    cap = cap > 0 ? cap : DEFAULT_CAP_MS;
    var n = Math.max(0, Math.floor(attempt) || 0);
    var raw = Math.min(base * Math.pow(2, n), cap);
    var r = typeof rng === 'function' ? rng() : Math.random();
    var jitter = 0.8 + r * 0.4; // U(0.8,1.2)
    var d = Math.round(raw * jitter);
    // never exceed cap*1.2 absolute ceiling; clamp to cap*1.2
    var ceil = Math.round(cap * 1.2);
    return Math.min(d, ceil);
  }

  // ---- fetch error classification ---------------------------------------
  function classifyFetchError(errOrResp) {
    // Response-like (has .status + .ok)
    if (errOrResp && typeof errOrResp.status === 'number' && 'ok' in errOrResp) {
      var s = errOrResp.status;
      var retryAfter = null;
      try {
        if (errOrResp.headers && errOrResp.headers.get) {
          var ra = errOrResp.headers.get('Retry-After');
          if (ra != null) { var n = Number(ra); if (Number.isFinite(n)) retryAfter = n * 1000; }
        }
      } catch (_) {}
      if (s >= 400 && s < 500) {
        if (s === 429) return { kind: 'retryable', retryable: true, retryAfterMs: retryAfter, status: s };
        return { kind: 'http_4xx', retryable: false, retryAfterMs: retryAfter, status: s };
      }
      if (s >= 500) {
        if (s === 503 && retryAfter != null) return { kind: 'retryable', retryable: true, retryAfterMs: retryAfter, status: s };
        return { kind: 'http_5xx', retryable: true, retryAfterMs: retryAfter, status: s };
      }
      return { kind: 'http_4xx', retryable: false, retryAfterMs: retryAfter, status: s };
    }
    // Error with .status (kfetch throw shape)
    if (errOrResp && typeof errOrResp.status === 'number') {
      return classifyFetchError({ status: errOrResp.status, ok: false, headers: null });
    }
    // TypeError / network failure
    return { kind: 'network', retryable: true, retryAfterMs: null, status: null };
  }

  // ---- health probe ------------------------------------------------------
  function probeHealth(url, env) {
    env = env || {};
    var probeUrl = url || '/health';
    var fetchFn = env.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return Promise.resolve({ reachable: false, ok: false, subsystems: {}, status: 0 });
    return fetchFn(probeUrl, { cache: 'no-store', credentials: 'omit' }).then(function (r) {
      return (r.json ? r.json() : Promise.resolve({})).catch(function () { return {}; }).then(function (j) {
        j = j || {};
        return {
          reachable: true,
          ok: j.ok === true || j.status === 'ok',
          subsystems: {
            gateway: j.gateway || 'unknown',
            capture_store: j.capture_store || 'unknown',
            signing_key: j.signing_key || 'unknown'
          },
          status: r.status
        };
      });
    }).catch(function () {
      return { reachable: false, ok: false, subsystems: {}, status: 0 };
    });
  }

  function subsystemsHealthy(subs) {
    if (!subs) return true;
    var keys = ['gateway', 'capture_store', 'signing_key'];
    for (var i = 0; i < keys.length; i++) {
      var v = subs[keys[i]];
      if (v == null || v === 'unknown') continue;
      if (v !== 'ok' && v !== 'loaded' && v !== 'disabled') return false;
    }
    return true;
  }

  // ---- connectivity state machine ----------------------------------------
  function ConnectivitySupervisor(opts) {
    opts = opts || {};
    var env = opts._env || {};
    var probeUrl = opts.probeUrl || '/health';
    var base = opts.baseDelayMs || DEFAULT_BASE_MS;
    var cap = opts.capDelayMs || DEFAULT_CAP_MS;
    var strikeThreshold = opts.strikeThreshold || DEFAULT_STRIKES;
    var probeFn = opts.probe || function () { return probeHealth(probeUrl, env); };
    var rng = opts.rng || Math.random;
    var onChange = typeof opts.onChange === 'function' ? opts.onChange : function () {};
    var setT = env.setTimeout || (typeof setTimeout !== 'undefined' ? setTimeout : null);
    var clrT = env.clearTimeout || (typeof clearTimeout !== 'undefined' ? clearTimeout : null);

    var state = 'ONLINE';
    var strikes = 0;
    var attempt = 0;
    var probeTimer = null;
    var running = false;

    function setState(s, detail) {
      if (s === state) { if (detail) onChange(s, detail); return; }
      state = s;
      onChange(s, detail || {});
    }

    function schedule() {
      if (!running || !setT) return;
      if (probeTimer && clrT) clrT(probeTimer);
      var d = backoffDelay(attempt, base, cap, rng);
      probeTimer = setT(runProbe, d);
    }

    function runProbe() {
      return Promise.resolve(probeFn()).then(function (snap) {
        snap = snap || {};
        if (!snap.reachable) {
          attempt++;
          setState('OFFLINE', { snapshot: snap });
          schedule();
          return snap;
        }
        // reachable
        if (snap.ok && subsystemsHealthy(snap.subsystems)) {
          var wasBad = state === 'OFFLINE' || state === 'DEGRADED' || state === 'PROBING';
          strikes = 0; attempt = 0;
          if (probeTimer && clrT) { clrT(probeTimer); probeTimer = null; }
          setState('ONLINE', { reconnected: wasBad, snapshot: snap });
        } else {
          attempt = 0;
          setState('DEGRADED', { snapshot: snap });
          // keep a slow probe going to detect recovery
          schedule();
        }
        return snap;
      }).catch(function () {
        attempt++;
        setState('OFFLINE', {});
        schedule();
      });
    }

    function onFetchFail(detail) {
      var c = (detail && detail.classification) || { kind: 'network' };
      if (c.kind === 'network') {
        strikes++;
        if (strikes >= strikeThreshold && state === 'ONLINE') {
          setState('PROBING', { strikes: strikes });
          attempt = 0;
          runProbe();
        }
      }
    }

    return {
      start: function () {
        if (running) return;
        running = true;
        if (typeof window !== 'undefined') {
          this._onOnline = function () { attempt = 0; runProbe(); };
          this._onOffline = function () { setState('PROBING', {}); attempt = 0; runProbe(); };
          this._onFail = function (e) { onFetchFail(e && e.detail); };
          window.addEventListener('online', this._onOnline);
          window.addEventListener('offline', this._onOffline);
          window.addEventListener('kolm:fetch-fail', this._onFail);
        }
      },
      stop: function () {
        running = false;
        if (probeTimer && clrT) { clrT(probeTimer); probeTimer = null; }
        if (typeof window !== 'undefined') {
          if (this._onOnline) window.removeEventListener('online', this._onOnline);
          if (this._onOffline) window.removeEventListener('offline', this._onOffline);
          if (this._onFail) window.removeEventListener('kolm:fetch-fail', this._onFail);
        }
      },
      getState: function () { return state; },
      forceProbe: function () { return runProbe(); },
      reportFetchFail: function (detail) { onFetchFail(detail); }
    };
  }

  // ---- error boundary ----------------------------------------------------
  var _seen = Object.create(null);
  function hashMsg(s) {
    s = String(s || '');
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return String(h);
  }
  function redactStack(stack) {
    if (!stack) return '';
    var lines = String(stack).split('\n').slice(0, 3); // message + 2 frames
    return lines.join('\n').slice(0, 600);
  }

  function reportClientError(payload, report) {
    if (typeof report === 'function') { try { report(payload); } catch (_) {} return; }
    // default: best-effort POST, never loop on the sink itself
    if (payload && payload.source && String(payload.source).indexOf('/v1/client-error') !== -1) return;
    try {
      if (typeof fetch === 'undefined') return;
      fetch('/v1/client-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        keepalive: true
      }).catch(function () { /* sink unreachable: drop silently */ });
    } catch (_) {}
  }

  function installErrorBoundary(opts) {
    opts = opts || {};
    if (typeof window === 'undefined') return;
    if (window.__kolmBoundaryInstalled) return;
    window.__kolmBoundaryInstalled = true;
    var report = opts.report;
    var dedupeWindowMs = opts.dedupeWindowMs || 8000;

    function handle(message, source, lineno, colno, stack) {
      var key = hashMsg(message + '|' + redactStack(stack));
      var now = Date.now();
      if (_seen[key] && (now - _seen[key]) < dedupeWindowMs) return;
      _seen[key] = now;
      // swap stuck skeletons to a retry card (in place, never white-screen)
      try { swapStuckSkeletons(); } catch (_) {}
      reportClientError({
        message: String(message || '').slice(0, 240),
        source: String(source || '').slice(0, 240),
        lineno: lineno || null, colno: colno || null,
        stack: redactStack(stack),
        path: (typeof location !== 'undefined' ? location.pathname : '') ,
        ua: (typeof navigator !== 'undefined' ? String(navigator.userAgent || '').slice(0, 160) : '')
      }, report);
    }

    window.addEventListener('error', function (e) {
      // resource-load failures (capture phase) have no e.error
      var msg = e && e.message ? e.message : (e && e.target && e.target.src ? 'resource error: ' + e.target.src : 'error');
      var stack = e && e.error && e.error.stack ? e.error.stack : '';
      handle(msg, e && e.filename, e && e.lineno, e && e.colno, stack);
    }, true);

    window.addEventListener('unhandledrejection', function (e) {
      var reason = e && e.reason;
      var msg = reason && reason.message ? reason.message : String(reason);
      var stack = reason && reason.stack ? reason.stack : '';
      handle(msg, 'unhandledrejection', null, null, stack);
    });
  }

  function swapStuckSkeletons() {
    if (typeof document === 'undefined') return;
    var stuck = document.querySelectorAll('[aria-busy="true"]');
    for (var i = 0; i < stuck.length; i++) {
      var el = stuck[i];
      if (el.getAttribute('data-kolm-retry') === '1') continue;
      el.setAttribute('data-kolm-retry', '1');
      el.setAttribute('aria-busy', 'false');
      var card = document.createElement('div');
      card.className = 'kolm-retry-card';
      card.setAttribute('role', 'alert');
      card.innerHTML = 'Something went wrong loading this section. ' +
        '<button type="button" class="kolm-retry-btn">Retry</button>';
      var btn = card.querySelector('.kolm-retry-btn');
      if (btn) btn.addEventListener('click', function () { location.reload(); });
      el.appendChild(card);
    }
  }

  // ---- banner ------------------------------------------------------------
  function ensureBanner(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    var b = doc.getElementById('ks-netbanner');
    if (b) return b;
    b = doc.createElement('div');
    b.id = 'ks-netbanner';
    b.className = 'ks-netbanner';
    b.hidden = true;
    if (doc.body) doc.body.insertBefore(b, doc.body.firstChild);
    return b;
  }

  function renderNetBanner(state, detail, doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc) return;
    var b = ensureBanner(doc);
    if (!b) return;
    detail = detail || {};
    if (state === 'HIDDEN' || state === 'ONLINE') {
      b.hidden = true;
      b.className = 'ks-netbanner';
      b.removeAttribute('role');
      b.innerHTML = '';
      return;
    }
    b.hidden = false;
    if (state === 'OFFLINE') {
      b.className = 'ks-netbanner ks-netbanner--offline';
      b.setAttribute('role', 'alert');
      b.innerHTML = '<span class="ks-netbanner__dot"></span>' +
        '<span>You are offline. Reconnecting&hellip; cached data shown.</span>' +
        '<button type="button" class="ks-netbanner__retry">Retry now</button>';
    } else if (state === 'DEGRADED') {
      b.className = 'ks-netbanner ks-netbanner--degraded';
      b.setAttribute('role', 'status');
      var subs = detail.subsystems || (detail.snapshot && detail.snapshot.subsystems) || {};
      var bad = [];
      Object.keys(subs).forEach(function (k) {
        var v = subs[k];
        if (v && v !== 'ok' && v !== 'loaded' && v !== 'disabled' && v !== 'unknown') bad.push(k.replace(/_/g, ' '));
      });
      var which = bad.length ? bad.join(', ') : 'a service';
      b.innerHTML = '<span class="ks-netbanner__dot"></span>' +
        '<span>Degraded: ' + which + ' temporarily unavailable. Cached data shown.</span>';
    } else if (state === 'RECONNECTED') {
      b.className = 'ks-netbanner ks-netbanner--ok';
      b.setAttribute('role', 'status');
      b.innerHTML = '<span class="ks-netbanner__dot"></span><span>Reconnected.</span>';
      // auto-hide after a moment
      try { setTimeout(function () { renderNetBanner('HIDDEN', null, doc); }, 3000); } catch (_) {}
    }
    var retry = b.querySelector('.ks-netbanner__retry');
    if (retry) retry.addEventListener('click', function () {
      if (typeof window !== 'undefined' && window.__kolmNetSupervisor) window.__kolmNetSupervisor.forceProbe();
    });
  }

  // ---- auto-install ------------------------------------------------------
  function _autoInstall(win) {
    if (!win || win.__kolmNetInstalled) return;
    win.__kolmNetInstalled = true;
    var doc = win.document;
    function boot() {
      installErrorBoundary({});
      ensureBanner(doc);
      var sup = ConnectivitySupervisor({
        onChange: function (state, detail) {
          if (state === 'ONLINE' && detail && detail.reconnected) {
            renderNetBanner('RECONNECTED', detail, doc);
          } else if (state === 'ONLINE') {
            renderNetBanner('HIDDEN', null, doc);
          } else if (state === 'OFFLINE' || state === 'DEGRADED') {
            renderNetBanner(state, detail, doc);
          }
        }
      });
      win.__kolmNetSupervisor = sup;
      sup.start();
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
    else boot();
  }

  return {
    backoffDelay: backoffDelay,
    classifyFetchError: classifyFetchError,
    probeHealth: probeHealth,
    subsystemsHealthy: subsystemsHealthy,
    ConnectivitySupervisor: ConnectivitySupervisor,
    installErrorBoundary: installErrorBoundary,
    reportClientError: reportClientError,
    renderNetBanner: renderNetBanner,
    ensureBanner: ensureBanner,
    swapStuckSkeletons: swapStuckSkeletons,
    _autoInstall: _autoInstall
  };
});
