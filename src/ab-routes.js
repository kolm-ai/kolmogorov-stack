// src/ab-routes.js
//
// W822-5 - HTTP routes for the W822 A/B testing surface. Exports a single
// `registerAbRoutes(router, deps)` that bolts the /v1/ab/* routes onto an
// existing express.Router(). One-line wire-up in src/router.js to keep
// merge conflicts with parallel agents (WC07, WC14) to zero.
//
// deps:
//   authMiddleware  - real middleware from src/auth.js. Without it the routes
//                     fall through to a no-op gate that stamps req.tenant_record
//                     with a sentinel 'anonymous' tenant -- enough for local
//                     daemon mode + tests but never sufficient for prod.
//   selfImprovement - test seam. When supplied with an enqueue() function,
//                     /v1/ab/feedback fans the feedback row to that queue so
//                     the W720 self-improvement loop can ingest it.
//
// Routes (W822 spec):
//   POST  /v1/ab/configure   -> set up an A/B test for {namespace}
//   GET   /v1/ab/status      -> latest config + sample counts
//   POST  /v1/ab/feedback    -> record an outcome (also fans to W720)
//   POST  /v1/ab/promote     -> manual force-promote
//   GET   /v1/ab/metrics     -> aggregated per-variant metrics
//
// All routes are tenant-fenced via req.tenant_record.id (defense-in-depth even
// after the auth middleware filters out non-tenant traffic).

import { setSplit, getSplit, pickVariant, listSplits, W822_AB_VERSION } from './ab-router.js';
import { aggregate as abAggregate, AB_FEEDBACK_WORKFLOW, AB_METRICS_VERSION } from './ab-metrics.js';
import { decide, evaluate as abPromoteEvaluate, AB_PROMOTE_VERSION } from './ab-promote.js';

export const AB_ROUTES_VERSION = 'w822-v1';

function _tenantIdOf(req) {
  if (req && req.tenant_record && req.tenant_record.id) return req.tenant_record.id;
  if (req && req.tenant_id) return req.tenant_id;
  if (req && req.tenant) return String(req.tenant);
  return null;
}

function _isLocalDaemon(req) {
  // Same sentinel pattern as src/router.js __w411IsLocalDaemonMode -- when an
  // upstream middleware stamped a tenant_record with a 'local:*' id we treat
  // the caller as the local operator and let them through without an API key.
  if (!req || !req.tenant_record) return false;
  const id = String(req.tenant_record.id || '');
  return id.startsWith('local:');
}

function _denyUnauth(res) {
  return res.status(401).json({
    ok: false,
    error: 'unauthorized',
    hint: 'POST /v1/ab/* requires a kolm tenant API key (Authorization: Bearer ks_...)',
    version: AB_ROUTES_VERSION,
  });
}

function _safeBody(req) {
  if (!req) return {};
  const b = req.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) return b;
  return {};
}

/**
 * registerAbRoutes(router, deps) -- single-line entry point.
 *
 * deps:
 *   authMiddleware (function)  - required for prod; falls back to a stamp-only
 *                                middleware so tests can exercise the routes
 *                                without spinning up the full auth stack.
 *   selfImprovement.enqueue(payload) - optional. When supplied, /v1/ab/feedback
 *                                will call it after persisting the event so
 *                                the W720 detector queue picks up the row.
 */
export function registerAbRoutes(router, deps = {}) {
  if (!router || typeof router.get !== 'function' || typeof router.post !== 'function') {
    throw new Error('registerAbRoutes: router with .get/.post required');
  }
  const auth = (typeof deps.authMiddleware === 'function')
    ? deps.authMiddleware
    : (req, _res, next) => {
      // Test-mode passthrough -- stamp a tenant_record if none is present so
      // downstream handlers have a tenant id to fence on.
      if (!req.tenant_record && !req.tenant) {
        req.tenant_record = { id: 'anonymous' };
      }
      next();
    };

  const selfImpEnqueue = (deps.selfImprovement && typeof deps.selfImprovement.enqueue === 'function')
    ? deps.selfImprovement.enqueue
    : null;

  // ── POST /v1/ab/configure ──────────────────────────────────────────────────
  // Body: { namespace, version_a, version_b, split?, idempotency_key? }
  router.post('/v1/ab/configure', auth, (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);
    const body = _safeBody(req);
    const out = setSplit({
      tenant,
      namespace: body.namespace,
      version_a: body.version_a,
      version_b: body.version_b,
      split: body.split == null ? 0.5 : body.split,
      idempotency_key: body.idempotency_key || req.headers['x-idempotency-key'] || null,
    });
    if (!out.ok) return res.status(400).json(out);
    return res.status(out.idempotent_hit ? 200 : 201).json(out);
  });

  // ── GET /v1/ab/status?namespace=X ──────────────────────────────────────────
  router.get('/v1/ab/status', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);
    const namespace = req.query && req.query.namespace ? String(req.query.namespace) : null;
    if (!namespace) {
      // Caller asked for the rollup across the tenant.
      const lst = listSplits({ tenant });
      return res.status(lst.ok ? 200 : 400).json(lst);
    }
    const cfg = getSplit({ tenant, namespace });
    if (!cfg.ok) {
      return res.status(cfg.error === 'no_active_config' ? 404 : 400).json(cfg);
    }
    // Attach a lightweight metrics rollup so the dashboard has both shapes
    // (config + sample counts) in one round trip.
    let metrics = null;
    try {
      const m = await abAggregate({ tenant_id: tenant, namespace });
      if (m.ok) metrics = m.metrics;
    } catch { /* best effort */ }
    return res.status(200).json({
      ok: true,
      config: cfg.config,
      history_count: cfg.history_count,
      metrics,
      version: AB_ROUTES_VERSION,
    });
  });

  // ── POST /v1/ab/feedback ───────────────────────────────────────────────────
  // Body: { namespace, variant:'a'|'b', request_id?, k_score?, latency_ms?,
  //         thumb:'up'|'down'?, comment?, ab_test_id? }
  //
  // Persists a row to the event-store under workflow_id=AB_FEEDBACK_WORKFLOW
  // so ab-metrics.aggregate() can read it. Also fans the row to the W720
  // self-improvement queue when deps.selfImprovement.enqueue is wired.
  router.post('/v1/ab/feedback', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);
    const body = _safeBody(req);
    const namespace = body.namespace ? String(body.namespace) : null;
    const variant = (body.variant === 'a' || body.variant === 'b') ? body.variant : null;
    if (!namespace || !variant) {
      return res.status(400).json({
        ok: false,
        error: 'bad_args',
        hint: 'feedback requires {namespace, variant:"a"|"b"}',
        version: AB_ROUTES_VERSION,
      });
    }
    const k_score = Number.isFinite(Number(body.k_score)) ? Number(body.k_score) : null;
    const latency_ms = Number.isFinite(Number(body.latency_ms)) ? Math.trunc(Number(body.latency_ms)) : 0;
    const thumb = (body.thumb === 'up' || body.thumb === 'down') ? body.thumb : null;
    const status = body.status && /^(ok|error|timeout|rate_limited|blocked)$/i.test(String(body.status))
      ? String(body.status).toLowerCase()
      : 'ok';
    const ab_test_id = body.ab_test_id ? String(body.ab_test_id) : null;
    const request_id = body.request_id ? String(body.request_id) : null;

    const feedbackPayload = {
      kind: 'w822_ab_feedback',
      ab_test_id,
      namespace,
      variant,
      request_id,
      k_score,
      latency_ms,
      thumb,
      comment: body.comment ? String(body.comment).slice(0, 4000) : null,
      version: W822_AB_VERSION,
    };

    let appended = null;
    try {
      const es = await import('./event-store.js');
      appended = await es.appendEvent({
        tenant_id: tenant,
        namespace,
        workflow_id: AB_FEEDBACK_WORKFLOW,
        request_hash: request_id,
        model: 'ab_variant:' + variant,
        status,
        latency_ms,
        feedback: JSON.stringify(feedbackPayload),
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'event_store_write_failed',
        detail: String(e && e.message || e),
        version: AB_ROUTES_VERSION,
      });
    }

    // Fan to W720 self-improvement queue. Best-effort -- a failure here MUST
    // NOT swallow the feedback row (it's already persisted in event-store).
    let self_improvement = 'skipped';
    if (selfImpEnqueue) {
      try {
        await selfImpEnqueue({
          kind: 'ab_feedback',
          tenant_id: tenant,
          namespace,
          variant,
          request_id,
          k_score,
          latency_ms,
          thumb,
          ab_test_id,
          event_id: appended ? appended.event_id : null,
          source: 'w822',
          version: AB_ROUTES_VERSION,
        });
        self_improvement = 'enqueued';
      } catch (e) {
        self_improvement = 'failed:' + String(e && e.message || e);
      }
    } else {
      // No live queue wired -- but the row is tagged for W720 detection via the
      // 'w822_ab_feedback' kind + variant field, so the detector loop will pick
      // it up the next time it scans the event-store.
      self_improvement = 'tagged_for_detection';
    }

    return res.status(201).json({
      ok: true,
      event_id: appended ? appended.event_id : null,
      namespace,
      variant,
      self_improvement,
      version: AB_ROUTES_VERSION,
    });
  });

  // ── POST /v1/ab/promote ────────────────────────────────────────────────────
  // Body: { namespace, force?:boolean, thresholds?:{...} }
  // When `force=true` we bypass the decide() gate and promote variant_b
  // immediately. Otherwise we run the full evaluate() pipeline and only
  // promote when decide() returns 'promote'.
  router.post('/v1/ab/promote', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);
    const body = _safeBody(req);
    const namespace = body.namespace ? String(body.namespace) : null;
    if (!namespace) {
      return res.status(400).json({ ok: false, error: 'missing_namespace', version: AB_ROUTES_VERSION });
    }
    const cfgRes = getSplit({ tenant, namespace });
    if (!cfgRes.ok) {
      return res.status(404).json(cfgRes);
    }

    if (body.force === true) {
      // Manual force-promote -- flip the split so 100% of traffic lands on
      // version_b. Future configs can overwrite via /v1/ab/configure.
      const out = setSplit({
        tenant,
        namespace,
        version_a: cfgRes.config.version_a,
        version_b: cfgRes.config.version_b,
        split: 0,            // 0 means "no traffic to A" -> all to B
        idempotency_key: body.idempotency_key || null,
      });
      // Best-effort audit emit (mirror evaluate()'s behavior).
      let audit_emit = 'skipped';
      try {
        const auditMod = await import('./audit.js');
        auditMod.tryAppendAudit({
          tenant_id: tenant,
          op: 'ab.promoted',
          payload: {
            namespace,
            forced: true,
            previous_split: cfgRes.config.split,
            version_a: cfgRes.config.version_a,
            version_b: cfgRes.config.version_b,
            version: AB_ROUTES_VERSION,
          },
        });
        audit_emit = 'ok';
      } catch (e) { audit_emit = 'failed:' + String(e && e.message || e); }
      return res.status(200).json({
        ok: true,
        promoted: true,
        forced: true,
        config: out.config,
        audit_emit,
        version: AB_ROUTES_VERSION,
      });
    }

    // Gate-driven promote: run the evaluate pipeline.
    const decision = await abPromoteEvaluate({
      tenant_id: tenant,
      namespace,
      window_days: Number.isFinite(Number(body.window_days)) ? Number(body.window_days) : 7,
      thresholds: body.thresholds,
      seed: body.seed,
    });
    if (!decision.ok) {
      return res.status(400).json(decision);
    }
    // Only flip the config when decide() said promote.
    let postSplit = null;
    if (decision.decision === 'promote') {
      const out = setSplit({
        tenant,
        namespace,
        version_a: cfgRes.config.version_a,
        version_b: cfgRes.config.version_b,
        split: 0,
        idempotency_key: body.idempotency_key || null,
      });
      postSplit = out.config;
    } else if (decision.decision === 'rollback') {
      const out = setSplit({
        tenant,
        namespace,
        version_a: cfgRes.config.version_a,
        version_b: cfgRes.config.version_b,
        split: 1,           // 1 means "all traffic on A"
        idempotency_key: body.idempotency_key || null,
      });
      postSplit = out.config;
    }
    return res.status(200).json({
      ok: true,
      decision: decision.decision,
      reason: decision.reason,
      forced: false,
      deltas: decision.deltas,
      sig: decision.sig,
      thresholds: decision.thresholds,
      config: postSplit,
      audit_emit: decision.audit_emit,
      version: AB_ROUTES_VERSION,
    });
  });

  // ── GET /v1/ab/metrics?namespace=X ─────────────────────────────────────────
  router.get('/v1/ab/metrics', auth, async (req, res) => {
    const tenant = _tenantIdOf(req);
    if (!tenant) return _denyUnauth(res);
    const namespace = req.query && req.query.namespace ? String(req.query.namespace) : null;
    if (!namespace) {
      return res.status(400).json({ ok: false, error: 'missing_namespace', version: AB_ROUTES_VERSION });
    }
    const window_days = Number.isFinite(Number(req.query.window_days)) ? Number(req.query.window_days) : null;
    try {
      const out = await abAggregate({
        tenant_id: tenant,
        namespace,
        window_days,
      });
      if (!out.ok) {
        // Honest 404 for empty windows; 400 for bad input.
        const status = out.error === 'no_route_telemetry' || out.error === 'no_ab_tagged_events' ? 404 : 400;
        return res.status(status).json(out);
      }
      return res.status(200).json(out);
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'aggregate_failed',
        detail: String(e && e.message || e),
        version: AB_ROUTES_VERSION,
      });
    }
  });

  return router;
}

export default {
  AB_ROUTES_VERSION,
  registerAbRoutes,
};
