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

export const SAVINGS_ROUTES_CONTRACT_VERSION = 'w715-v1';
export const SAVINGS_ROUTE_LIMITS = Object.freeze({
  max_tenant_id_chars: 160,
  max_namespace_chars: 128,
  max_provider_chars: 64,
  max_model_chars: 128,
  max_error_detail_chars: 180,
  max_tokens_per_call: 50_000_000,
});

const SAFE_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const SAFE_NAMESPACE_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_PROVIDER_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const SAFE_MODEL_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;

function _cleanText(value, maxChars = SAVINGS_ROUTE_LIMITS.max_error_detail_chars) {
  const s = String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted_email]')
    .replace(/\b(?:sk|ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{16,}\b/g, '[redacted_secret]')
    .replace(/[A-Za-z]:\\[^\s"'<>]+/g, '[redacted_path]')
    .replace(/\/(?:Users|home|var|tmp|mnt|opt)\/[^\s"'<>]+/g, '[redacted_path]')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}

function _errorDetail(err) {
  return _cleanText((err && err.message) || err || 'savings route error');
}

function _json(res, statusCode, body) {
  return res.status(statusCode).json({
    route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION,
    ...body,
  });
}

function _safeId(value, maxChars = SAVINGS_ROUTE_LIMITS.max_tenant_id_chars) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  if (!s || s.length > maxChars || !SAFE_ID_RE.test(s)) return null;
  return s;
}

function _safeNamespace(value) {
  const raw = value == null || value === '' ? 'default' : String(value).trim();
  if (!raw || raw.length > SAVINGS_ROUTE_LIMITS.max_namespace_chars || !SAFE_NAMESPACE_RE.test(raw)) return null;
  return raw;
}

function _safeProvider(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw.length > SAVINGS_ROUTE_LIMITS.max_provider_chars || !SAFE_PROVIDER_RE.test(raw)) return null;
  return raw;
}

function _safeModel(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw || raw.length > SAVINGS_ROUTE_LIMITS.max_model_chars || !SAFE_MODEL_RE.test(raw)) return null;
  return raw;
}

function _safeTokenCount(value) {
  if (value == null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n || n > SAVINGS_ROUTE_LIMITS.max_tokens_per_call) return null;
  return n;
}

function _safeTimestamp(value) {
  if (value == null || value === '') return { ok: true, value: null };
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) return { ok: false, value: null };
  return { ok: true, value: d.toISOString() };
}

function _authOrReject(req, res) {
  const trec = req && req.tenant_record;
  const tenant_id = trec && _safeId(trec.id);
  if (!trec || !tenant_id) {
    res.status(401).json({
      ok: false,
      error: 'auth_required',
      hint: 'send Authorization: Bearer <ks_* or kao_* key>',
      route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION,
    });
    return null;
  }
  return { ...trec, id: tenant_id };
}

function _periodDays(req) {
  const raw = (req && req.query && req.query.period_days) || null;
  if (raw == null) return BASELINE_PERIOD_DAYS_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 365) return null; // signal invalid
  return Math.floor(n);
}

export function registerSavingsRoutes(r) {
  if (!r || typeof r.get !== 'function' || typeof r.post !== 'function') {
    throw new Error('registerSavingsRoutes: router with .get/.post required');
  }

  // GET /v1/savings/baseline - show whether a baseline window is active +
  // its start time + accumulated spend so far.
  r.get('/v1/savings/baseline', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const namespace = _safeNamespace(req.query && req.query.namespace);
    if (!namespace) {
      return _json(res, 400, { ok: false, error: 'invalid_namespace', hint: 'namespace must match [A-Za-z0-9_.:-] and be <=128 chars' });
    }
    const period_days = _periodDays(req);
    if (period_days == null) {
      return _json(res, 400, { ok: false, error: 'invalid_period_days', hint: 'period_days must be 1..365' });
    }
    try {
      const env = await getBaselineSpend({ tenant_id: trec.id, namespace, period_days });
      return res.json({ ok: true, route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION, ...env });
    } catch (e) {
      return _json(res, 500, {
        ok: false,
        error: 'savings_baseline_error',
        detail: _errorDetail(e),
      });
    }
  });

  // POST /v1/savings/baseline - start (or restart) a baseline window.
  // Body: { namespace?, start_ts? }.
  r.post('/v1/savings/baseline', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    const namespace = _safeNamespace(body.namespace);
    if (!namespace) {
      return _json(res, 400, { ok: false, error: 'invalid_namespace', hint: 'namespace must match [A-Za-z0-9_.:-] and be <=128 chars' });
    }
    const start = _safeTimestamp(body.start_ts);
    if (!start.ok) {
      return _json(res, 400, { ok: false, error: 'invalid_start_ts', hint: 'start_ts must be an ISO-parseable timestamp' });
    }
    try {
      const env = await startBaselinePeriod({ tenant_id: trec.id, namespace, start_ts: start.value });
      return res.json({ ok: true, route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION, ...env });
    } catch (e) {
      return _json(res, 500, {
        ok: false,
        error: 'savings_baseline_start_error',
        detail: _errorDetail(e),
      });
    }
  });

  // POST /v1/savings/record - record a teacher API call cost.
  // Body: { namespace?, provider, model, input_tokens, output_tokens, ts? }.
  r.post('/v1/savings/record', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const body = req.body || {};
    if (body.provider == null || body.provider === '') return _json(res, 400, { ok: false, error: 'provider_required' });
    if (body.model == null || body.model === '') return _json(res, 400, { ok: false, error: 'model_required' });
    const provider = _safeProvider(body.provider);
    const model = _safeModel(body.model);
    if (!provider) return _json(res, 400, { ok: false, error: 'invalid_provider', hint: 'provider must be <=64 chars and contain only safe identifier characters' });
    if (!model) return _json(res, 400, { ok: false, error: 'invalid_model', hint: 'model must be <=128 chars and contain only safe model identifier characters' });
    const namespace = _safeNamespace(body.namespace);
    if (!namespace) {
      return _json(res, 400, { ok: false, error: 'invalid_namespace', hint: 'namespace must match [A-Za-z0-9_.:-] and be <=128 chars' });
    }
    const input_tokens = _safeTokenCount(body.input_tokens);
    const output_tokens = _safeTokenCount(body.output_tokens);
    if (input_tokens == null || output_tokens == null) {
      return _json(res, 400, { ok: false, error: 'invalid_token_count', hint: 'input_tokens and output_tokens must be integers in 0..50000000' });
    }
    const ts = _safeTimestamp(body.ts);
    if (!ts.ok) {
      return _json(res, 400, { ok: false, error: 'invalid_ts', hint: 'ts must be an ISO-parseable timestamp' });
    }
    try {
      const ev = await recordTeacherSpend({
        tenant_id: trec.id,
        namespace, provider, model,
        input_tokens, output_tokens, ts: ts.value,
      });
      return res.json({
        ok: true,
        route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION,
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
        return _json(res, 400, { ok: false, error: code, detail: _errorDetail(e) });
      }
      return _json(res, 500, {
        ok: false,
        error: 'savings_record_error',
        detail: _errorDetail(e),
      });
    }
  });

  // GET /v1/savings/summary - full savings envelope.
  // Query: ?period_days=30&namespace=default[&fee_rate=0.125]
  r.get('/v1/savings/summary', async (req, res) => {
    const trec = _authOrReject(req, res);
    if (!trec) return;
    const namespace = _safeNamespace(req.query && req.query.namespace);
    if (!namespace) {
      return _json(res, 400, { ok: false, error: 'invalid_namespace', hint: 'namespace must match [A-Za-z0-9_.:-] and be <=128 chars' });
    }
    const period_days = _periodDays(req);
    if (period_days == null) {
      return _json(res, 400, { ok: false, error: 'invalid_period_days', hint: 'period_days must be 1..365' });
    }
    let fee_rate = SAVINGS_FEE_RATE_DEFAULT;
    if (req.query && req.query.fee_rate != null) {
      const r2 = Number(req.query.fee_rate);
      if (!Number.isFinite(r2) || r2 < 0 || r2 > 1) {
        return _json(res, 400, { ok: false, error: 'invalid_fee_rate', hint: 'fee_rate must be 0..1' });
      }
      fee_rate = r2;
    }
    try {
      const env = await computeSavings({
        tenant_id: trec.id, namespace, period_days, fee_rate,
      });
      return res.json({
        ok: true,
        route_contract_version: SAVINGS_ROUTES_CONTRACT_VERSION,
        defaults: {
          min_baseline_days: MIN_BASELINE_DAYS,
          baseline_period_days_default: BASELINE_PERIOD_DAYS_DEFAULT,
          savings_fee_rate_default: SAVINGS_FEE_RATE_DEFAULT,
        },
        ...env,
      });
    } catch (e) {
      return _json(res, 500, {
        ok: false,
        error: 'savings_summary_error',
        detail: _errorDetail(e),
      });
    }
  });

  return r;
}

export default registerSavingsRoutes;
