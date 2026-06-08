// src/account-ui-routes.js
//
// W921 Account UI / No-Code - server routes for two client modules that need a
// backend touchpoint. Exports a single `registerAccountUiRoutes(router, deps)`
// that bolts the routes onto an existing express.Router(), so the wire-up in
// src/router.js is one line and parallel-agent merge conflicts stay at zero.
//
// Routes:
//   POST /v1/client-error          (spec 47) - public, IP-rate-limited, redacted
//                                   breadcrumb sink for the global client error
//                                   boundary. Append-only. Returns 204.
//   POST   /v1/automations          (spec 49) - create an automation
//   GET    /v1/automations          (spec 49) - list (tenant-fenced)
//   PATCH  /v1/automations/:id       (spec 49) - enable/disable (confirm)
//   DELETE /v1/automations/:id       (spec 49) - delete (confirm)
//   POST   /v1/automations/:id/run   (spec 49) - manual "run again"
//   POST   /v1/automations/tick      (spec 49) - platform-cron dispatcher,
//                                   gated by KOLM_CRON_SECRET (NOT tenant-authed)
//
// deps:
//   authMiddleware - real middleware from src/auth.js. Without it the tenant
//     routes fall through to a stamp-only no-op gate (tests/local only).
//   eventStore - { appendEvent, listEvents } (src/event-store.js); when absent
//     the automation routes run against an in-process Map (test/dev mode) so
//     the surface is exercisable without the durable ledger wired.
//   runRecipe(tenant_id, recipe_id) -> Promise<actionResult> - the recipe-run
//     ACTION (router handleRun / runtime.runConcept). Optional; when absent
//     "run again" returns a not_wired envelope rather than firing a fake job.
//   cronSecret - process.env.KOLM_CRON_SECRET equivalent (fail-closed if unset).
//   now() - injectable clock for tests.

export const ACCOUNT_UI_ROUTES_VERSION = 'w921-account-ui-v1';
export const AUTOMATION_PROVIDER = 'kolm_automation';

// ───────────────────────────── cron-next (vendored) ─────────────────────────
const FIELD_RANGES = [
  { min: 0, max: 59 }, { min: 0, max: 23 }, { min: 1, max: 31 },
  { min: 1, max: 12 }, { min: 0, max: 7 },
];
const NAME_MAP = [
  {}, {}, {},
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
];

function resolveNum(s, names) {
  s = String(s).trim().toLowerCase();
  if (names[s] != null) return names[s];
  const n = parseInt(s, 10);
  return Number.isInteger(n) ? n : null;
}

function parseField(token, idx) {
  const range = FIELD_RANGES[idx];
  const names = NAME_MAP[idx] || {};
  const allowed = {};
  for (const rawPart of String(token).split(',')) {
    let part = rawPart.trim().toLowerCase();
    if (part === '') return null;
    let step = 1;
    const slash = part.indexOf('/');
    if (slash !== -1) {
      step = parseInt(part.slice(slash + 1), 10);
      if (!Number.isInteger(step) || step <= 0) return null;
      part = part.slice(0, slash);
    }
    let lo, hi;
    if (part === '*') { lo = range.min; hi = range.max; }
    else {
      const dash = part.indexOf('-');
      if (dash !== -1) { lo = resolveNum(part.slice(0, dash), names); hi = resolveNum(part.slice(dash + 1), names); }
      else { lo = hi = resolveNum(part, names); }
      if (lo == null || hi == null) return null;
      if (lo < range.min || hi > range.max || lo > hi) return null;
    }
    for (let v = lo; v <= hi; v += step) {
      const nv = (idx === 4 && v === 7) ? 0 : v;
      allowed[nv] = true;
    }
  }
  return Object.keys(allowed).map(Number).sort((a, b) => a - b);
}

export function validateCron(expr) {
  if (typeof expr !== 'string') return { ok: false, error: 'expression must be a string' };
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) return { ok: false, error: `expected 5 fields, got ${tokens.length}` };
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const set = parseField(tokens[i], i);
    if (!set || !set.length) return { ok: false, error: `invalid field ${i + 1}: "${tokens[i]}"` };
    fields.push(set);
  }
  return { ok: true, fields };
}

function partsUtc(date) {
  return {
    minute: date.getUTCMinutes(), hour: date.getUTCHours(),
    dom: date.getUTCDate(), month: date.getUTCMonth() + 1, dow: date.getUTCDay(),
  };
}

function matchParts(fields, p) {
  const minOk = fields[0].includes(p.minute);
  const hourOk = fields[1].includes(p.hour);
  const monthOk = fields[3].includes(p.month);
  const domField = fields[2], dowField = fields[4];
  const domRestricted = !(domField.length === 31 && domField[0] === 1);
  const dowRestricted = !(dowField.length === 7);
  const domMatch = domField.includes(p.dom);
  const dowMatch = dowField.includes(p.dow);
  let dayOk;
  if (domRestricted && dowRestricted) dayOk = domMatch || dowMatch;
  else if (domRestricted) dayOk = domMatch;
  else if (dowRestricted) dayOk = dowMatch;
  else dayOk = true;
  return minOk && hourOk && monthOk && dayOk;
}

export function cronNextRun(expr, fromDate) {
  const v = validateCron(expr);
  if (!v.ok) return null;
  let start = fromDate instanceof Date ? new Date(fromDate.getTime()) : new Date();
  start.setUTCSeconds(0, 0);
  let cursor = start.getTime() + 60000;
  const horizon = cursor + 4 * 366 * 24 * 60 * 60 * 1000;
  let iters = 0;
  while (cursor <= horizon) {
    if (++iters > 200000) return null;
    const d = new Date(cursor);
    const p = partsUtc(d);
    // fast day-skip when the day can never match
    const monthOk = v.fields[3].includes(p.month);
    const domField = v.fields[2], dowField = v.fields[4];
    const domRestricted = !(domField.length === 31 && domField[0] === 1);
    const dowRestricted = !(dowField.length === 7);
    const dayMatches = monthOk && (
      (domRestricted && dowRestricted) ? (domField.includes(p.dom) || dowField.includes(p.dow))
        : domRestricted ? domField.includes(p.dom)
          : dowRestricted ? dowField.includes(p.dow)
            : true);
    if (!dayMatches) {
      const nd = new Date(cursor); nd.setUTCHours(0, 0, 0, 0);
      cursor = nd.getTime() + 86400000;
      continue;
    }
    if (matchParts(v.fields, p)) return d;
    cursor += 60000;
  }
  return null;
}

// ───────────────────────────── helpers ──────────────────────────────────────
function _tenantIdOf(req) {
  if (req && req.tenant_record && req.tenant_record.id) return req.tenant_record.id;
  if (req && req.tenant_id) return req.tenant_id;
  if (req && req.tenant) return String(req.tenant);
  return null;
}
function _safeBody(req) {
  const b = req && req.body;
  return (b && typeof b === 'object' && !Array.isArray(b)) ? b : {};
}
function _denyUnauth(res, hint) {
  return res.status(401).json({ ok: false, error: 'unauthorized', hint, version: ACCOUNT_UI_ROUTES_VERSION });
}

// Validate + normalize an automation trigger. Returns {ok, trigger?|error}.
function normalizeTrigger(t) {
  t = t || {};
  const type = t.type;
  if (type === 'manual') return { ok: true, trigger: { type: 'manual' } };
  if (type === 'schedule') {
    const v = validateCron(t.cron || '');
    if (!v.ok) return { ok: false, error: 'invalid cron: ' + v.error };
    return { ok: true, trigger: { type: 'schedule', cron: String(t.cron), tz: t.tz ? String(t.tz) : 'UTC' } };
  }
  if (type === 'event') {
    const SIGNALS = ['drift', 'staleness', 'capture_count', 'coverage_readiness', 'kscore_regression'];
    if (!SIGNALS.includes(t.signal)) return { ok: false, error: 'unknown signal' };
    const thr = Number(t.threshold);
    if (!Number.isFinite(thr)) return { ok: false, error: 'threshold must be a number' };
    return {
      ok: true,
      trigger: {
        type: 'event', signal: t.signal, threshold: thr,
        direction: t.direction === 'below' ? 'below' : 'above',
        rearm_band: Number.isFinite(Number(t.rearm_band)) ? Number(t.rearm_band) : 0.15,
        min_interval_s: Number.isFinite(Number(t.min_interval_s)) ? Number(t.min_interval_s) : 3600,
      },
    };
  }
  return { ok: false, error: 'unknown trigger type' };
}

export function buildIdempotencyKey(automation, bucket) {
  return String(automation.automation_id || automation.id) + ':' + String(bucket);
}

export function scheduleIsDue(automation, now) {
  if (!automation || !automation.trigger || automation.trigger.type !== 'schedule') return { due: false };
  if (automation.enabled === false) return { due: false };
  const nextAt = automation.next_run_at ? Date.parse(automation.next_run_at) : null;
  if (nextAt == null || isNaN(nextAt)) return { due: false };
  if (now.getTime() < nextAt) return { due: false };
  const bucket = new Date(nextAt); bucket.setUTCSeconds(0, 0);
  return { due: true, scheduled_minute: bucket.toISOString().slice(0, 16) };
}

// ───────────────────────────── registration ─────────────────────────────────
export function registerAccountUiRoutes(router, deps = {}) {
  if (!router || typeof router.post !== 'function' || typeof router.get !== 'function') {
    throw new Error('registerAccountUiRoutes: router with .get/.post required');
  }
  const auth = (typeof deps.authMiddleware === 'function')
    ? deps.authMiddleware
    : (req, _res, next) => { if (!req.tenant_record && !req.tenant) req.tenant_record = { id: 'anonymous' }; next(); };
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const cronSecret = deps.cronSecret != null ? deps.cronSecret : (typeof process !== 'undefined' ? process.env.KOLM_CRON_SECRET : null);
  const runRecipe = typeof deps.runRecipe === 'function' ? deps.runRecipe : null;

  // ── automation store: durable event-store when present, else in-process ──
  const memStore = new Map(); // automation_id -> record
  const store = deps.eventStore || null;

  async function putAutomation(rec) {
    if (store && typeof store.appendEvent === 'function') {
      await store.appendEvent({
        provider: AUTOMATION_PROVIDER, tenant: rec.tenant_id,
        namespace: rec.namespace || 'default', kind: 'automation_record',
        payload: rec, idempotency_key: 'automation:' + rec.automation_id,
      });
    }
    memStore.set(rec.automation_id, rec);
  }
  async function listAutomationsFor(tenant_id) {
    // in-process is authoritative within a process lifetime; the event-store
    // is the durable mirror. Read from memory first, fall back to the ledger.
    const out = [];
    for (const rec of memStore.values()) if (rec.tenant_id === tenant_id) out.push(rec);
    if (out.length) return out;
    if (store && typeof store.listEvents === 'function') {
      try {
        const evs = await store.listEvents({ provider: AUTOMATION_PROVIDER, tenant: tenant_id });
        const byId = new Map();
        for (const e of (evs || [])) {
          const p = e.payload || e;
          if (p && p.automation_id) byId.set(p.automation_id, p);
        }
        return Array.from(byId.values());
      } catch (_) { /* fall through */ }
    }
    return out;
  }

  // ── POST /v1/client-error (public, rate-limited, redacted) ──────────────────
  const ipBuckets = new Map(); // ip -> { count, windowStart }
  const RATE_MAX = 30, RATE_WINDOW_MS = 60000;
  function rateLimited(ip) {
    const t = now().getTime();
    let b = ipBuckets.get(ip);
    if (!b || (t - b.windowStart) > RATE_WINDOW_MS) { b = { count: 0, windowStart: t }; ipBuckets.set(ip, b); }
    b.count++;
    return b.count > RATE_MAX;
  }
  router.post('/v1/client-error', (req, res) => {
    const ip = (req.headers && (req.headers['x-forwarded-for'] || '').split(',')[0].trim()) ||
      (req.socket && req.socket.remoteAddress) || 'unknown';
    if (rateLimited(ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const b = _safeBody(req);
    if (!b.message || typeof b.message !== 'string') return res.status(400).json({ ok: false, error: 'message required' });
    // redact: cap fields, never store auth/localStorage values
    const breadcrumb = {
      message: String(b.message).slice(0, 240),
      source: b.source ? String(b.source).slice(0, 240) : null,
      lineno: Number.isFinite(b.lineno) ? b.lineno : null,
      colno: Number.isFinite(b.colno) ? b.colno : null,
      stack: b.stack ? String(b.stack).split('\n').slice(0, 3).join('\n').slice(0, 600) : null,
      path: b.path ? String(b.path).slice(0, 200) : null,
      ua: b.ua ? String(b.ua).slice(0, 160) : null,
      ts: now().toISOString(),
    };
    if (store && typeof store.appendEvent === 'function') {
      Promise.resolve(store.appendEvent({
        provider: 'kolm_client_error', tenant: 'anonymous', kind: 'client_error', payload: breadcrumb,
      })).catch(() => {});
    }
    return res.status(204).end();
  });

  // ── POST /v1/automations ────────────────────────────────────────────────────
  router.post('/v1/automations', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res, 'POST /v1/automations requires a tenant API key');
    const b = _safeBody(req);
    if (!b.recipe_id) return res.status(400).json({ ok: false, error: 'recipe_id required', version: ACCOUNT_UI_ROUTES_VERSION });
    const nt = normalizeTrigger(b.trigger);
    if (!nt.ok) return res.status(400).json({ ok: false, error: nt.error, version: ACCOUNT_UI_ROUTES_VERSION });
    const id = 'auto_' + now().getTime().toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36);
    const rec = {
      automation_id: id, tenant_id: tenant, namespace: b.namespace || 'default',
      recipe_id: String(b.recipe_id), trigger: nt.trigger,
      action: { kind: (b.action && b.action.kind) === 'recompile' ? 'recompile' : 'recipe_run' },
      enabled: b.enabled !== false, auto: b.auto === true, armed: true,
      next_run_at: nt.trigger.type === 'schedule' ? (cronNextRun(nt.trigger.cron, now()) || null) : null,
      created_at: now().toISOString(),
    };
    if (rec.next_run_at instanceof Date) rec.next_run_at = rec.next_run_at.toISOString();
    await putAutomation(rec);
    return res.status(201).json({ ok: true, automation_id: id, next_run_at: rec.next_run_at, version: ACCOUNT_UI_ROUTES_VERSION });
  });

  // ── GET /v1/automations ───────────────────────────────────────────────────
  router.get('/v1/automations', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res, 'GET /v1/automations requires a tenant API key');
    const list = await listAutomationsFor(tenant);
    return res.status(200).json({ ok: true, automations: list, version: ACCOUNT_UI_ROUTES_VERSION });
  });

  // ── PATCH /v1/automations/:id (enable/disable, confirm) ─────────────────────
  router.patch('/v1/automations/:id', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res, 'PATCH requires a tenant API key');
    const b = _safeBody(req);
    if (b.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm_required', version: ACCOUNT_UI_ROUTES_VERSION });
    const rec = memStore.get(req.params.id);
    if (!rec || rec.tenant_id !== tenant) return res.status(404).json({ ok: false, error: 'not_found' });
    rec.enabled = b.enabled !== false;
    await putAutomation(rec);
    return res.status(200).json({ ok: true, automation_id: rec.automation_id, enabled: rec.enabled, version: ACCOUNT_UI_ROUTES_VERSION });
  });

  // ── DELETE /v1/automations/:id (confirm) ────────────────────────────────────
  router.delete('/v1/automations/:id', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res, 'DELETE requires a tenant API key');
    const b = _safeBody(req);
    if (b.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm_required', version: ACCOUNT_UI_ROUTES_VERSION });
    const rec = memStore.get(req.params.id);
    if (!rec || rec.tenant_id !== tenant) return res.status(404).json({ ok: false, error: 'not_found' });
    memStore.delete(req.params.id);
    return res.status(200).json({ ok: true, version: ACCOUNT_UI_ROUTES_VERSION });
  });

  // ── POST /v1/automations/:id/run (run again) ────────────────────────────────
  router.post('/v1/automations/:id/run', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res, 'POST .../run requires a tenant API key');
    const rec = memStore.get(req.params.id);
    if (!rec || rec.tenant_id !== tenant) return res.status(404).json({ ok: false, error: 'not_found' });
    if (!runRecipe) {
      return res.status(200).json({ ok: true, fired: false, reason: 'recipe_run_not_wired', version: ACCOUNT_UI_ROUTES_VERSION });
    }
    try {
      const result = await runRecipe(tenant, rec.recipe_id);
      return res.status(200).json({ ok: true, fired: true, action_result: result, version: ACCOUNT_UI_ROUTES_VERSION });
    } catch (e) {
      return res.status(502).json({ ok: false, fired: false, error: String(e && e.message || e), version: ACCOUNT_UI_ROUTES_VERSION });
    }
  });

  // ── POST /v1/automations/tick (platform cron; KOLM_CRON_SECRET) ─────────────
  router.post('/v1/automations/tick', async (req, res) => {
    const presented = req.headers && (req.headers['x-kolm-cron-secret'] || req.headers['X-Kolm-Cron-Secret']);
    if (!cronSecret || presented !== cronSecret) {
      return res.status(403).json({ ok: false, error: 'forbidden', hint: 'platform cron only (x-kolm-cron-secret)', version: ACCOUNT_UI_ROUTES_VERSION });
    }
    const t = now();
    const fired = [], skipped = [], errors = [];
    for (const rec of memStore.values()) {
      try {
        if (rec.enabled === false) continue;
        const due = scheduleIsDue(rec, t);
        if (!due.due) { continue; }
        const idem = buildIdempotencyKey(rec, due.scheduled_minute);
        if (rec._last_fired_key === idem) { skipped.push(idem); continue; } // SKIP, never double-launch
        rec._last_fired_key = idem;
        rec.last_fired_at = t.toISOString();
        rec.next_run_at = rec.trigger.type === 'schedule'
          ? (cronNextRun(rec.trigger.cron, t) || null) : rec.next_run_at;
        if (rec.next_run_at instanceof Date) rec.next_run_at = rec.next_run_at.toISOString();
        if (runRecipe && rec.auto === true) {
          await runRecipe(rec.tenant_id, rec.recipe_id);
        }
        await putAutomation(rec);
        fired.push({ automation_id: rec.automation_id, idempotency_key: idem, proposed: rec.auto !== true });
      } catch (e) {
        errors.push({ automation_id: rec.automation_id, error: String(e && e.message || e) });
      }
    }
    return res.status(200).json({ ok: true, scanned: memStore.size, fired, skipped, errors, version: ACCOUNT_UI_ROUTES_VERSION });
  });

  return { version: ACCOUNT_UI_ROUTES_VERSION, _memStore: memStore };
}
