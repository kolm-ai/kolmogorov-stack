// Gateway per-tenant spend caps + budget alerts + abuse throttling (P1).
//
// Three responsibilities, all tenant-fenced through the canonical event store:
//
//   1. checkBudget(tenant)  -> { allowed, spent_usd, cap_usd, remaining, pct, plan }
//      Sums the tenant's rolling-window USD spend from the event-store - the
//      authoritative cost ledger - and compares to a per-tenant cap resolved
//      from config override -> ctx -> plan default -> global default. The spend
//      read reuses the exact pattern src/billing-breakdown.js uses
//      (listEvents({tenant_id, since, until}) then sum estimated_cost_usd, with
//      a cost_micro_usd fallback), so caps and the billing dashboard always
//      agree on a tenant's spend.
//
//   2. enforceBudget()  -> Express middleware. Returns HTTP 402 when the tenant
//      is over budget. Mount in the gateway dispatch path AFTER auth and BEFORE
//      the upstream provider call so an over-budget tenant never incurs more
//      spend. Sets X-Kolm-Budget-* response headers and fires alerts.
//
//   3. throttle()  -> Express middleware. Per-tenant token-bucket abuse
//      throttle returning HTTP 429 + Retry-After.
//
// Plus emitBudgetAlerts(tenant, status) which appends a budget_alert event
// (via event-store.appendEvent) at the 80% and 100% thresholds (idempotent
// within a billing window).
//
// ESM module (package is "type":"module"). On any spend-read error it FAILS
// OPEN (spent_usd = 0) so a telemetry/store outage can never wrongly hard-block
// a paying tenant; the cap re-engages the moment spend is readable again.

import { listEvents, appendEvent } from './event-store.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling spend window. Monthly caps are billed over a 30-day trailing window.
export const BILLING_WINDOW_MS = 30 * DAY_MS;

// Monthly USD cap per plan. enterprise is contractual / invoiced - no hard
// gateway cap (Infinity). Override per-tenant via config (see resolveCapUsd).
export const PLAN_CAPS = Object.freeze({
  free: 5,
  starter: 50,
  pro: 500,
  team: 2000,
  business: 10000,
  enterprise: Infinity,
});

// Unknown / missing plan is treated as the most conservative tier.
export const DEFAULT_CAP_USD = 5;

// Alert thresholds as fraction of cap.
export const ALERT_THRESHOLDS = Object.freeze([0.8, 1.0]);

// Budget alerts are persisted as events in their own namespace so they are
// (a) queryable via listEvents({namespace}) and (b) trivially EXCLUDED from the
// spend sum (alert rows must never count as spend). The canonical event-schema
// (src/event-schema.js) drops unknown top-level keys, so the alert detail is
// JSON-encoded into the `feedback` free-text field, which survives canonicalize.
export const BUDGET_ALERT_NAMESPACE = 'kolm-budget-alerts';

// ---------------------------------------------------------------------------
// config + plan resolution
// ---------------------------------------------------------------------------

// Optional env-encoded JSON maps. We prefer an injected ctx (the auth
// middleware already resolved the tenant record); env maps are the fallback.
function _envMap(name) {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_) {
    return {};
  }
}

// Resolve the plan string for a tenant. Prefer the auth-resolved record on the
// request (ctx). Integrator: if the tenant record uses a different field than
// `plan`, extend the picks below.
export function resolveTenantPlan(tenant, ctx) {
  if (ctx) {
    const direct = ctx.plan || (ctx.tenant && ctx.tenant.plan) || (ctx.billing && ctx.billing.plan);
    if (direct) return String(direct).toLowerCase();
  }
  const planMap = _envMap('KOLM_TENANT_PLANS');
  if (planMap[tenant]) return String(planMap[tenant]).toLowerCase();
  return 'free';
}

// Resolve the USD cap for a tenant.
// Order: explicit per-tenant override -> ctx-supplied cap -> plan default -> global default.
export function resolveCapUsd(tenant, ctx) {
  // 1) explicit per-tenant override via env JSON map { "<tenant>": <usd|"unlimited"> }
  const overrides = _envMap('KOLM_SPEND_CAPS');
  if (Object.prototype.hasOwnProperty.call(overrides, tenant)) {
    const v = overrides[tenant];
    if (v === 'unlimited' || v === Infinity) return Infinity;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // 2) cap carried on the resolved tenant record (e.g. a custom contract cap)
  if (ctx) {
    const ctxCap = ctx.spend_cap_usd != null
      ? ctx.spend_cap_usd
      : (ctx.tenant && ctx.tenant.spend_cap_usd);
    if (ctxCap === 'unlimited') return Infinity;
    const n = Number(ctxCap);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // 3) plan default -> 4) global default
  const plan = resolveTenantPlan(tenant, ctx);
  if (Object.prototype.hasOwnProperty.call(PLAN_CAPS, plan)) return PLAN_CAPS[plan];
  return DEFAULT_CAP_USD;
}

// ---------------------------------------------------------------------------
// spend read (reuses the billing-breakdown.js ledger pattern)
// ---------------------------------------------------------------------------

// Pull a single event row's USD cost. Mirrors billing-breakdown.js:
// estimated_cost_usd is the canonical field the gateway receipt writes into the
// events table; cost_micro_usd (W411 parity field) is the fallback.
function _eventCostUsd(ev) {
  if (ev == null) return 0;
  const usd = Number(ev.estimated_cost_usd);
  if (Number.isFinite(usd)) return usd;
  const micro = Number(ev.cost_micro_usd);
  if (Number.isFinite(micro)) return micro / 1_000_000;
  return 0;
}

// Sum a tenant's USD spend over the billing window. Uses listEvents with a
// tenant_id filter (the seam billing-breakdown.js relies on) so the read is
// tenant-fenced at the store. Our own budget-alert rows live in
// BUDGET_ALERT_NAMESPACE and are excluded so an alert can never inflate spend.
// FAIL-OPEN: returns 0 on any read error so a store outage never wrongly blocks
// a paying tenant.
export async function readTenantSpendUsd(tenant, opts = {}) {
  // event-store accepts since/until as ISO strings; convert ms-epoch defaults.
  const sinceMs = opts.since || (Date.now() - BILLING_WINDOW_MS);
  const sinceIso = typeof sinceMs === 'number' ? new Date(sinceMs).toISOString() : String(sinceMs);
  const untilIso = opts.until
    ? (typeof opts.until === 'number' ? new Date(opts.until).toISOString() : String(opts.until))
    : undefined;
  try {
    const rows = await listEvents({ tenant_id: tenant, since: sinceIso, until: untilIso, limit: 0 });
    let total = 0;
    for (const ev of rows) {
      if (!ev) continue;
      // Defense in depth - listEvents already pinned tenant_id, but pin again
      // so this helper is safe to call directly from internal code.
      if (ev.tenant_id && tenant && ev.tenant_id !== tenant) continue;
      // Never count our own budget-alert rows as spend.
      if (ev.namespace === BUDGET_ALERT_NAMESPACE) continue;
      total += _eventCostUsd(ev);
    }
    return Math.max(0, total);
  } catch (_) {
    return 0; // fail-open
  }
}

// ---------------------------------------------------------------------------
// checkBudget
// ---------------------------------------------------------------------------

function _round4(n) {
  if (!Number.isFinite(n)) return n;
  return Math.round(n * 1e4) / 1e4;
}

// Returns { allowed, spent_usd, cap_usd, remaining, pct, plan }.
// cap_usd / remaining are null when the tenant has no hard cap (enterprise /
// "unlimited"); pct is 0 in that case. Async because the ledger read is async.
export async function checkBudget(tenant, opts = {}) {
  if (!tenant) {
    return { allowed: false, spent_usd: 0, cap_usd: 0, remaining: 0, pct: 1, plan: 'unknown', reason: 'missing_tenant' };
  }
  const ctx = opts.ctx;
  const cap = resolveCapUsd(tenant, ctx);
  const spent = await readTenantSpendUsd(tenant, { since: opts.since, until: opts.until });
  const unlimited = !Number.isFinite(cap);
  const remaining = unlimited ? Infinity : Math.max(0, cap - spent);
  const pct = unlimited ? 0 : (cap > 0 ? spent / cap : 1);
  return {
    allowed: unlimited || spent < cap,
    spent_usd: _round4(spent),
    cap_usd: unlimited ? null : _round4(cap),
    remaining: unlimited ? null : _round4(remaining),
    pct: _round4(pct),
    plan: resolveTenantPlan(tenant, ctx),
  };
}

// ---------------------------------------------------------------------------
// budget alerts (80% / 100%)
// ---------------------------------------------------------------------------

// In-process dedupe so the same threshold isn't re-emitted every request.
// Keyed by `${tenant}:${threshold}:${windowBucket}`, reset per billing window.
// NOTE: per-process only - for a multi-instance deployment the budget_alert
// event itself is the durable record; dedupe is a best-effort emission guard.
const _alertSent = new Map();

function _windowBucket() {
  return Math.floor(Date.now() / BILLING_WINDOW_MS);
}

// Emit budget alert events for any newly-crossed threshold. Idempotent within a
// billing window. Returns the list of thresholds fired this call.
//
// The canonical event-schema (src/event-schema.js) has a CLOSED field list and
// canonicalize() DROPS unknown top-level keys, so we encode the alert into
// fields that exist and survive: a dedicated namespace (BUDGET_ALERT_NAMESPACE,
// queryable + excluded from the spend sum), status 'blocked' for over-budget /
// 'rate_limited' for the 80% warning (both valid status enum values),
// source_type 'synthetic' (system-generated, not a real capture), and the full
// alert detail JSON-encoded into `feedback` (a 4096-char free-text field that
// survives canonicalize). estimated_cost_usd is 0 - alert rows add no spend.
export async function emitBudgetAlerts(tenant, status, _opts = {}) {
  const fired = [];
  if (!status || status.cap_usd == null) return fired; // unlimited / no cap
  const bucket = _windowBucket();
  for (const thr of ALERT_THRESHOLDS) {
    if (status.pct >= thr) {
      const key = `${tenant}:${thr}:${bucket}`;
      if (_alertSent.has(key)) continue;
      _alertSent.set(key, Date.now());
      const level = thr >= 1 ? 'over_budget' : 'warning';
      try {
        await appendEvent({
          tenant_id: tenant,
          namespace: BUDGET_ALERT_NAMESPACE,
          source_type: 'synthetic',
          status: thr >= 1 ? 'blocked' : 'rate_limited',
          estimated_cost_usd: 0, // alert rows carry no spend of their own
          feedback: JSON.stringify({
            type: 'budget.alert',
            level,
            threshold: thr,
            spent_usd: status.spent_usd,
            cap_usd: status.cap_usd,
            remaining: status.remaining,
            pct: status.pct,
            plan: status.plan,
          }),
        });
        fired.push(thr);
      } catch (_) {
        // Append failed - drop the dedupe key so a later request retries.
        _alertSent.delete(key);
      }
    }
  }
  // Bound the dedupe map.
  if (_alertSent.size > 10000) {
    const cutoff = Date.now() - 2 * BILLING_WINDOW_MS;
    for (const [k, v] of _alertSent) if (v < cutoff) _alertSent.delete(k);
  }
  return fired;
}

// Test hook.
export function _resetAlertDedupe() {
  _alertSent.clear();
}

// ---------------------------------------------------------------------------
// tenant resolution from a request
// ---------------------------------------------------------------------------

// Best-effort tenant extraction. The auth middleware sets the resolved tenant
// record on the request upstream; we probe the common shapes (incl. the
// req.tenant_record.id shape billing routes use, per event-store comments).
// Override via the resolveTenant option on any factory below if it differs.
function _defaultResolveTenant(req) {
  if (!req) return null;
  return (
    (req.tenant_record && req.tenant_record.id) ||
    (req.tenant && (req.tenant.id || (typeof req.tenant === 'string' ? req.tenant : null))) ||
    (req.auth && (req.auth.tenant_id || req.auth.tenant)) ||
    req.tenant_id ||
    req.tenantId ||
    (req.user && (req.user.tenant_id || req.user.tenant)) ||
    null
  );
}

function _authCtx(req) {
  return (req && (req.tenant_record || req.auth || req.tenant)) || null;
}

// ---------------------------------------------------------------------------
// enforceBudget middleware (HTTP 402)
// ---------------------------------------------------------------------------

// Mount in the gateway dispatch path, after auth and before the upstream call.
export function enforceBudget(options = {}) {
  const resolveTenant = options.resolveTenant || _defaultResolveTenant;

  return async function spendCapMiddleware(req, res, next) {
    let tenant;
    try { tenant = resolveTenant(req); } catch (_) { tenant = null; }
    if (!tenant) return next(); // unauthenticated paths are gated upstream

    let status;
    try {
      status = await checkBudget(tenant, { ctx: _authCtx(req) });
    } catch (_) {
      return next(); // fail-open on internal error - never block on a caps bug
    }

    // Best-effort alerts; never block the request on alert failure.
    emitBudgetAlerts(tenant, status).catch(() => {});

    if (res && typeof res.setHeader === 'function') {
      res.setHeader('X-Kolm-Budget-Spent-USD', String(status.spent_usd));
      if (status.cap_usd != null) {
        res.setHeader('X-Kolm-Budget-Cap-USD', String(status.cap_usd));
        res.setHeader('X-Kolm-Budget-Remaining-USD', String(status.remaining));
      }
    }

    if (!status.allowed) {
      const body = {
        ok: false,
        error: 'over_budget',
        message: 'Monthly spend cap reached for this tenant. Raise the cap in billing settings or contact support.',
        spent_usd: status.spent_usd,
        cap_usd: status.cap_usd,
        remaining: status.remaining,
        plan: status.plan,
      };
      if (res && typeof res.status === 'function') return res.status(402).json(body);
      res.statusCode = 402;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(body));
    }
    return next();
  };
}

// ---------------------------------------------------------------------------
// abuse throttle - per-tenant token bucket (HTTP 429)
// ---------------------------------------------------------------------------

// Per-process token buckets keyed by tenant (or IP for anon). For cluster-wide
// limits, back this with a shared store; per-node limits are usually fine for
// abuse protection layered on top of express-rate-limit (already a dep).
const _buckets = new Map();

function _takeToken(key, ratePerMin, burst) {
  const now = Date.now();
  const refillPerMs = ratePerMin / 60000;
  let b = _buckets.get(key);
  if (!b) {
    b = { tokens: burst, last: now };
    _buckets.set(key, b);
  }
  b.tokens = Math.min(burst, b.tokens + (now - b.last) * refillPerMs);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { ok: true, retryAfter: 0 };
  }
  const retryAfter = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs / 1000));
  return { ok: false, retryAfter };
}

// Defaults: 600 req/min, burst 120. Override globally via options or per-tenant
// via options.rateForTenant(tenant, req) -> { ratePerMin, burst }.
export function throttle(options = {}) {
  const defRate = options.ratePerMin || 600;
  const defBurst = options.burst || 120;
  const resolveTenant = options.resolveTenant || ((req) =>
    _defaultResolveTenant(req) ||
    (req && (req.ip || (req.connection && req.connection.remoteAddress))) ||
    'anon');

  return function throttleMiddleware(req, res, next) {
    let key;
    try { key = resolveTenant(req) || 'anon'; } catch (_) { key = 'anon'; }
    let rate = defRate;
    let burst = defBurst;
    if (typeof options.rateForTenant === 'function') {
      try {
        const r = options.rateForTenant(key, req);
        if (r && r.ratePerMin) rate = r.ratePerMin;
        if (r && r.burst) burst = r.burst;
      } catch (_) { /* defaults */ }
    }
    const result = _takeToken(key, rate, burst);
    if (result.ok) return next();
    const body = { ok: false, error: 'rate_limited', message: 'Too many requests. Slow down.', retry_after_s: result.retryAfter };
    if (res && typeof res.setHeader === 'function') res.setHeader('Retry-After', String(result.retryAfter));
    if (res && typeof res.status === 'function') return res.status(429).json(body);
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(body));
  };
}

// Test hook.
export function _resetBuckets() {
  _buckets.clear();
}

// ---------------------------------------------------------------------------
// GET /v1/usage/budget route handler
// ---------------------------------------------------------------------------

export function budgetRouteHandler(options = {}) {
  const resolveTenant = options.resolveTenant || _defaultResolveTenant;
  return async function getUsageBudget(req, res) {
    let tenant;
    try { tenant = resolveTenant(req); } catch (_) { tenant = null; }
    if (!tenant) {
      const body = { ok: false, error: 'unauthenticated', message: 'No tenant in request.' };
      if (res && typeof res.status === 'function') return res.status(401).json(body);
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(body));
    }
    let status;
    try {
      status = await checkBudget(tenant, { ctx: _authCtx(req) });
    } catch (_) {
      const body = { ok: false, error: 'budget_read_failed' };
      if (res && typeof res.status === 'function') return res.status(500).json(body);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(body));
    }
    const out = { ok: true, tenant, ...status, window_days: Math.round(BILLING_WINDOW_MS / DAY_MS) };
    if (res && typeof res.json === 'function') return res.json(out);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(out));
  };
}
