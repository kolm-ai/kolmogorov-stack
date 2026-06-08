// src/savings-routes.js
//
// W835 - savings-based pricing tracker HTTP routes.
//
// Lives as a one-call mount to keep src/router.js diff to 1 line (concurrent
// WC07/WC14 fix agents are editing router.js in parallel - every extra line
// we touch is a potential merge conflict).
//
// All four routes are auth-required + tenant-scoped. tenant_id is forced
// from req.tenant_record.id; never read from request body or query string.
//
//   GET  /v1/savings/baseline - current baseline status
//   POST /v1/savings/baseline - start/restart baseline window
//   POST /v1/savings/record - record one teacher API call's cost
//   GET  /v1/savings/summary?period_days=30 - saved $ + fee $ + net $
//
// Honesty contract:
//   - GET /summary returns status:'insufficient_baseline' when <7 days observed
//   - GET /summary returns status:'no_baseline_started' when no marker exists
//   - regression (post > baseline) → saved_usd<0 + fee_usd=0 + regression:true
//
// All envelopes pass through okEnvelope-style {ok:true, ...} so the
// front-end can branch on `body.ok` first, then on `body.status` for the
// honest-by-default sub-states.

import {
  startBaselinePeriod,
  recordTeacherSpend,
  getBaselineSpend,
  computeSavings,
  BASELINE_PERIOD_DAYS_DEFAULT,
  MIN_BASELINE_DAYS,
  SAVINGS_FEE_RATE_DEFAULT,
} from './savings-tracker.js';

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  if (!trec) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
    });
    return null;
  }
  return trec;
}

function _periodDays(req) {
  const raw = (req && req.query && req.query.period_days) || null;
  if (raw == null) return BASELINE_PERIOD_DAYS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 365) return null; // signal invalid
  return Math.floor(n);
}

export function registerSavingsRoutes(r) {
  // GET /v1/savings/baseline - show whether a baseline window is active +
  // its start time + accumulated spend so far.
  r.get('/v1/savings/baseline', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const namespace = String((req.query && req.query.namespace) || 'default');
    const period_days = _periodDays(req);
    if (period_days == null) {
      return res.status(400).json({ ok: false, error: 'invalid_period_days', hint: 'period_days must be 1..365' });
    }
    try {
      const env = await getBaselineSpend({ tenant_id: trec.id, namespace, period_days });
      return res.json({ ok: true, ...env });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'savings_baseline_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // POST /v1/savings/baseline - start (or restart) a baseline window.
  // Body: { namespace?, start_ts? }.
  r.post('/v1/savings/baseline', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    const namespace = String(body.namespace || 'default');
    const start_ts = body.start_ts || null;
    try {
      const env = await startBaselinePeriod({ tenant_id: trec.id, namespace, start_ts });
      return res.json({ ok: true, ...env });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'savings_baseline_start_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // POST /v1/savings/record - record a teacher API call cost.
  // Body: { namespace?, provider, model, input_tokens, output_tokens, ts? }.
  r.post('/v1/savings/record', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    const provider = body.provider;
    const model = body.model;
    if (!provider) return res.status(400).json({ ok: false, error: 'provider_required' });
    if (!model) return res.status(400).json({ ok: false, error: 'model_required' });
    const namespace = String(body.namespace || 'default');
    const input_tokens = Number(body.input_tokens) || 0;
    const output_tokens = Number(body.output_tokens) || 0;
    const ts = body.ts || null;
    try {
      const ev = await recordTeacherSpend({
        tenant_id: trec.id,
        namespace, provider, model,
        input_tokens, output_tokens, ts,
      });
      return res.json({
        ok: true,
        recorded: {
          event_id: ev.event_id,
          namespace: ev.namespace,
          provider: ev.provider,
          model: ev.model,
          cost_micro_usd: ev.cost_micro_usd,
          cost_usd: (Number(ev.cost_micro_usd) || 0) / 1_000_000,
          input_tokens, output_tokens,
        },
      });
    } catch (e) {
      const code = e && e.code;
      if (code === 'unknown_provider' || code === 'unknown_model') {
        return res.status(400).json({ ok: false, error: code, detail: String(e.message || '') });
      }
      return res.status(500).json({
        ok: false,
        error: 'savings_record_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  // GET /v1/savings/summary - full savings envelope.
  // Query: ?period_days=30&namespace=default[&fee_rate=0.125]
  r.get('/v1/savings/summary', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const namespace = String((req.query && req.query.namespace) || 'default');
    const period_days = _periodDays(req);
    if (period_days == null) {
      return res.status(400).json({ ok: false, error: 'invalid_period_days', hint: 'period_days must be 1..365' });
    }
    let fee_rate = SAVINGS_FEE_RATE_DEFAULT;
    if (req.query && req.query.fee_rate != null) {
      const r2 = Number(req.query.fee_rate);
      if (!Number.isFinite(r2) || r2 < 0 || r2 > 1) {
        return res.status(400).json({ ok: false, error: 'invalid_fee_rate', hint: 'fee_rate must be 0..1' });
      }
      fee_rate = r2;
    }
    try {
      const env = await computeSavings({
        tenant_id: trec.id, namespace, period_days, fee_rate,
      });
      return res.json({
        ok: true,
        defaults: {
          min_baseline_days: MIN_BASELINE_DAYS,
          baseline_period_days_default: BASELINE_PERIOD_DAYS_DEFAULT,
          savings_fee_rate_default: SAVINGS_FEE_RATE_DEFAULT,
        },
        ...env,
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: 'savings_summary_error',
        detail: String((e && e.message) || e),
      });
    }
  });

  return r;
}

export default registerSavingsRoutes;
