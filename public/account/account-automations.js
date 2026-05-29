/*
 * account-automations.js — dependency-free client layer for kolm no-code
 * automation: cron-next math + the recipes.html "Run again" / schedule /
 * event-trigger UI helpers. (W921 Account UI / No-Code, spec 49 — client tier.)
 *
 * An "automation" binds a TRIGGER (schedule cron | event signal | manual) to
 * the EXISTING recipe-run action. The durable record + platform-cron tick +
 * tenant-fenced routes live server-side (declared as a NEW route module
 * src/account-automations-routes.js for the orchestrator to mount — NOT
 * edited here). This file ships:
 *
 *   (1) A vendored ZERO-DEPENDENCY cron-next calculator (croner semantics:
 *       5-field Vixie, dom/dow OR-rule, parse-only — validateCron / cronMatch
 *       / cronNextRun / CRON_PRESETS). Pure + headless-testable.
 *   (2) describeTrigger() — render a human-readable trigger summary for the UI.
 *   (3) renderRunAgainButton() / wireRunAgain() — the "Run again" affordance
 *       that re-fires a saved recipe via the existing POST /v1/recipes/:id/run.
 *   (4) mountAutomationsCard() — lists/creates/enable/disable automations on
 *       recipes.html via the (server-mounted) /v1/automations* routes, with a
 *       graceful "not yet available" state when the routes are absent.
 *
 * Isomorphic like ks-sparkline.js: pure cron helpers attach to window AND
 * globalThis and export under a CommonJS shim so the headless smoke can run.
 *
 * Palette: cool-slate ONLY (NO warm/brown/orange/amber hex).
 */
(function (root, factory) {
  var api = factory();
  if (typeof window !== 'undefined') {
    window.KolmAutomations = api;
    window.validateCron = api.validateCron;
    window.cronMatch = api.cronMatch;
    window.cronNextRun = api.cronNextRun;
  }
  if (typeof globalThis !== 'undefined') globalThis.KolmAutomations = api;
  if (typeof module !== 'undefined' && module && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // =====================================================================
  // cron-next calculator (vendored, zero-dep)
  // 5 fields: minute hour day-of-month month day-of-week
  // =====================================================================
  var FIELD_RANGES = [
    { min: 0, max: 59 }, // minute
    { min: 0, max: 23 }, // hour
    { min: 1, max: 31 }, // day of month
    { min: 1, max: 12 }, // month
    { min: 0, max: 7 }   // day of week (0 or 7 = Sunday)
  ];
  var NAME_MAP = [
    {},
    {},
    {},
    { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
    { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }
  ];

  function parseField(token, fieldIdx) {
    var range = FIELD_RANGES[fieldIdx];
    var names = NAME_MAP[fieldIdx] || {};
    var allowed = {};
    var parts = token.split(',');
    for (var p = 0; p < parts.length; p++) {
      var part = parts[p].trim().toLowerCase();
      if (part === '') return null;
      var step = 1;
      var slash = part.indexOf('/');
      if (slash !== -1) {
        step = parseInt(part.slice(slash + 1), 10);
        if (!Number.isInteger(step) || step <= 0) return null;
        part = part.slice(0, slash);
      }
      var lo, hi;
      if (part === '*') { lo = range.min; hi = range.max; }
      else {
        var dash = part.indexOf('-');
        if (dash !== -1) {
          lo = resolveNum(part.slice(0, dash), names);
          hi = resolveNum(part.slice(dash + 1), names);
        } else {
          lo = hi = resolveNum(part, names);
        }
        if (lo == null || hi == null) return null;
        if (lo < range.min || hi > range.max || lo > hi) return null;
      }
      for (var v = lo; v <= hi; v += step) {
        // normalize dow 7 -> 0 (Sunday)
        var nv = (fieldIdx === 4 && v === 7) ? 0 : v;
        allowed[nv] = true;
      }
    }
    return Object.keys(allowed).map(Number).sort(function (a, b) { return a - b; });
  }

  function resolveNum(s, names) {
    s = s.trim().toLowerCase();
    if (names[s] != null) return names[s];
    var n = parseInt(s, 10);
    if (!Number.isInteger(n)) return null;
    return n;
  }

  function validateCron(expr) {
    if (typeof expr !== 'string') return { ok: false, error: 'expression must be a string' };
    var tokens = expr.trim().split(/\s+/);
    if (tokens.length !== 5) return { ok: false, error: 'expected 5 fields, got ' + tokens.length };
    var fields = [];
    for (var i = 0; i < 5; i++) {
      var set = parseField(tokens[i], i);
      if (set == null || set.length === 0) {
        return { ok: false, error: 'invalid field ' + (i + 1) + ': "' + tokens[i] + '"' };
      }
      fields.push(set);
    }
    return { ok: true, fields: fields };
  }

  // tz-aware wall-clock parts via Intl
  function partsInTz(date, tz) {
    if (!tz) {
      return {
        minute: date.getUTCMinutes(), hour: date.getUTCHours(),
        dom: date.getUTCDate(), month: date.getUTCMonth() + 1,
        dow: date.getUTCDay()
      };
    }
    try {
      var fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hour12: false,
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', weekday: 'short'
      });
      var map = {};
      fmt.formatToParts(date).forEach(function (pt) { map[pt.type] = pt.value; });
      var wdMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      var hour = parseInt(map.hour, 10); if (hour === 24) hour = 0;
      return {
        minute: parseInt(map.minute, 10),
        hour: hour,
        dom: parseInt(map.day, 10),
        month: parseInt(map.month, 10),
        dow: wdMap[map.weekday]
      };
    } catch (_) {
      return partsInTz(date, null);
    }
  }

  function matchParts(fields, parts) {
    var minOk = fields[0].indexOf(parts.minute) !== -1;
    var hourOk = fields[1].indexOf(parts.hour) !== -1;
    var monthOk = fields[3].indexOf(parts.month) !== -1;
    // Vixie OR-rule for dom/dow when either is restricted
    var domField = fields[2], dowField = fields[4];
    var domRestricted = !(domField.length === 31 && domField[0] === 1);
    var dowRestricted = !(dowField.length === 7);
    var domMatch = domField.indexOf(parts.dom) !== -1;
    var dowMatch = dowField.indexOf(parts.dow) !== -1;
    var dayOk;
    if (domRestricted && dowRestricted) dayOk = domMatch || dowMatch;
    else if (domRestricted) dayOk = domMatch;
    else if (dowRestricted) dayOk = dowMatch;
    else dayOk = true;
    return minOk && hourOk && monthOk && dayOk;
  }

  function cronMatch(expr, date, tz) {
    var v = validateCron(expr);
    if (!v.ok) return false;
    return matchParts(v.fields, partsInTz(date, tz));
  }

  function dayMatches(fields, parts) {
    var monthOk = fields[3].indexOf(parts.month) !== -1;
    if (!monthOk) return false;
    var domField = fields[2], dowField = fields[4];
    var domRestricted = !(domField.length === 31 && domField[0] === 1);
    var dowRestricted = !(dowField.length === 7);
    var domMatch = domField.indexOf(parts.dom) !== -1;
    var dowMatch = dowField.indexOf(parts.dow) !== -1;
    if (domRestricted && dowRestricted) return domMatch || dowMatch;
    if (domRestricted) return domMatch;
    if (dowRestricted) return dowMatch;
    return true;
  }

  function cronNextRun(expr, fromDate, tz) {
    var v = validateCron(expr);
    if (!v.ok) return null;
    var start = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date();
    // advance to the next whole minute boundary
    start.setUTCSeconds(0, 0);
    start = new Date(start.getTime() + 60000);
    var horizonMs = start.getTime() + 4 * 366 * 24 * 60 * 60 * 1000; // 4-year cap
    var cursor = start.getTime();
    var DAY = 86400000, MIN = 60000;
    var iters = 0;
    while (cursor <= horizonMs) {
      // hard iteration ceiling guards against pathological exprs (Feb 30):
      // at most ~1466 day-skips + ~1440 minute-steps in the last day.
      if (++iters > 200000) return null;
      var d = new Date(cursor);
      var parts = partsInTz(d, tz);
      var utcTz = !tz || tz === 'UTC' || tz === 'Etc/UTC';
      if (utcTz && !dayMatches(v.fields, parts)) {
        // UTC fast path: skip the whole non-matching day at once.
        var nextDay = new Date(cursor);
        nextDay.setUTCHours(0, 0, 0, 0);
        cursor = nextDay.getTime() + DAY;
        continue;
      }
      if (matchParts(v.fields, parts)) return d;
      cursor += MIN;
    }
    return null;
  }

  var CRON_PRESETS = Object.freeze({
    every_15m: '*/15 * * * *',
    hourly: '0 * * * *',
    daily: '0 0 * * *',
    weekly: '0 0 * * 1'
  });

  // =====================================================================
  // trigger description (UI)
  // =====================================================================
  function describeTrigger(trigger) {
    if (!trigger || !trigger.type) return 'manual';
    if (trigger.type === 'manual') return 'Manual (run again)';
    if (trigger.type === 'schedule') {
      var cron = trigger.cron || '';
      for (var k in CRON_PRESETS) if (CRON_PRESETS[k] === cron) return 'Schedule: ' + k.replace('_', ' ');
      return 'Schedule: ' + cron + (trigger.tz ? ' (' + trigger.tz + ')' : '');
    }
    if (trigger.type === 'event') {
      var dir = trigger.direction === 'below' ? 'falls below' : 'crosses above';
      return 'When ' + (trigger.signal || 'signal') + ' ' + dir + ' ' + (trigger.threshold != null ? trigger.threshold : '?');
    }
    return String(trigger.type);
  }

  // =====================================================================
  // "Run again" affordance
  // =====================================================================
  function renderRunAgainButton(recipeId) {
    return '<button type="button" class="btn kauto-runagain" data-recipe-id="' +
      esc(recipeId) + '">Run again</button>';
  }

  // wireRunAgain(rootEl, fetchJSON?, toast?) — delegate clicks on
  // .kauto-runagain to POST /v1/recipes/:id/run, using the optimistic toast
  // bus when present.
  function wireRunAgain(rootEl, deps) {
    deps = deps || {};
    var fetchJSON = deps.fetchJSON ||
      (typeof window !== 'undefined' && window.kFetchJSON) ||
      (typeof window !== 'undefined' && window.kfetch) || null;
    var toast = deps.toast || (typeof window !== 'undefined' && window.kToast) || null;
    if (!rootEl) return;
    rootEl.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('kauto-runagain')) return;
      var id = t.getAttribute('data-recipe-id');
      if (!id || !fetchJSON) return;
      t.disabled = true;
      Promise.resolve(fetchJSON('/v1/recipes/' + encodeURIComponent(id) + '/run', {
        method: 'POST', body: JSON.stringify({})
      })).then(function (res) {
        t.disabled = false;
        if (toast) toast({ message: 'Recipe re-run started', severity: 'good' });
        var artId = res && (res.artifact_id || res.run_id || res.id);
        if (artId && typeof window !== 'undefined') {
          // optionally surface a link to results
          t.insertAdjacentHTML('afterend',
            ' <a class="btn" href="/account/artifacts?recipe=' + encodeURIComponent(id) + '">Results &rarr;</a>');
        }
      }).catch(function (err) {
        t.disabled = false;
        if (toast) toast({ message: 'Run failed' + (err && err.status ? ' (' + err.status + ')' : ''), severity: 'bad' });
      });
    });
  }

  // =====================================================================
  // automations card (recipes.html) — degrades gracefully if routes absent
  // =====================================================================
  function mountAutomationsCard(mountEl, deps) {
    if (!mountEl) return null;
    deps = deps || {};
    var fetchJSON = deps.fetchJSON ||
      (typeof window !== 'undefined' && window.kFetchJSON) || null;

    function rowHtml(a) {
      var enabled = a.enabled !== false;
      return '<tr data-automation-id="' + esc(a.automation_id || a.id) + '">' +
        '<td><code>' + esc(a.recipe_id || '-') + '</code></td>' +
        '<td>' + esc(describeTrigger(a.trigger)) + '</td>' +
        '<td><span class="pill ' + (enabled ? 'ok' : 'mute') + '">' + (enabled ? 'enabled' : 'disabled') + '</span></td>' +
        '<td>' + (a.next_run_at ? esc(String(a.next_run_at).slice(0, 16).replace('T', ' ')) : '-') + '</td>' +
        '<td><button type="button" class="btn kauto-toggle" data-id="' + esc(a.automation_id || a.id) +
        '" data-enabled="' + (enabled ? '1' : '0') + '">' + (enabled ? 'Disable' : 'Enable') + '</button></td>' +
        '</tr>';
    }

    function render(list) {
      if (!list || !list.length) {
        mountEl.innerHTML = '<div class="empty"><strong>No automations yet.</strong> ' +
          'Schedule a recipe to recompile on a cadence, or trigger it when drift crosses a threshold.</div>';
        return;
      }
      mountEl.innerHTML = '<table class="ktable" aria-label="Automations">' +
        '<thead><tr><th scope="col">Recipe</th><th scope="col">Trigger</th>' +
        '<th scope="col">Status</th><th scope="col">Next run</th><th scope="col">Actions</th></tr></thead>' +
        '<tbody>' + list.map(rowHtml).join('') + '</tbody></table>';
    }

    function load() {
      if (!fetchJSON) {
        mountEl.innerHTML = '<div class="empty">Automations require sign-in.</div>';
        return;
      }
      Promise.resolve(fetchJSON('/v1/automations')).then(function (j) {
        render((j && (j.automations || j.items)) || []);
      }).catch(function (err) {
        if (err && err.status === 404) {
          mountEl.innerHTML = '<div class="empty">Automation scheduling is rolling out. ' +
            'Use the per-recipe <strong>Run again</strong> button for now.</div>';
        } else {
          mountEl.innerHTML = '<div class="empty">Could not load automations.</div>';
        }
      });
    }

    mountEl.addEventListener('click', function (e) {
      var t = e.target;
      if (!t.classList || !t.classList.contains('kauto-toggle') || !fetchJSON) return;
      var id = t.getAttribute('data-id');
      var enabled = t.getAttribute('data-enabled') === '1';
      Promise.resolve(fetchJSON('/v1/automations/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify({ enabled: !enabled, confirm: true })
      })).then(load).catch(function () {});
    });

    load();
    return { reload: load, render: render };
  }

  return {
    validateCron: validateCron,
    cronMatch: cronMatch,
    cronNextRun: cronNextRun,
    CRON_PRESETS: CRON_PRESETS,
    describeTrigger: describeTrigger,
    renderRunAgainButton: renderRunAgainButton,
    wireRunAgain: wireRunAgain,
    mountAutomationsCard: mountAutomationsCard,
    partsInTz: partsInTz
  };
});
