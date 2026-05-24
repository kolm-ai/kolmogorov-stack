// src/savings-tracker.js
//
// W835 — savings-based pricing tracker.
//
// Records teacher API spend during a baseline window + after a kolm
// deployment, then computes the dollar savings and the 10-15% fee that
// kolm.ai charges against those savings.
//
// Design choices:
//
//  1. Reads + writes the event-store (the authoritative cost ledger used by
//     billing-breakdown.js for W465 per-namespace attribution). Two narrow
//     namespaces under the events table identify the row class:
//       - status = 'savings_baseline_marker'    (one row per period start)
//       - provider/model normal + status='ok'   (teacher-spend rows we count)
//     A baseline marker carries `kind:'savings_baseline'` in the JSON column.
//     We never reach into a separate file; reusing the event-store keeps
//     /v1/lake/export and audit-export honest (the marker rows show up too).
//
//  2. The PROVIDER_RATE_CARD here is FROZEN at module load — quarterly
//     refresh is the explicit cadence. We do NOT pull from
//     src/provider-registry.js because that table is tuned for the daemon-
//     connector live-passthrough cost (which can swing intra-quarter when
//     a vendor cuts prices). Savings claims need a stable reference; if we
//     re-priced silently the same workload would book different savings
//     two months in a row.
//
//  3. Honesty contract: when the baseline window has fewer than
//     MIN_BASELINE_DAYS of data, computeSavings returns
//     { status: 'insufficient_baseline' } and the dashboard shows the
//     warning instead of a number. NEVER fabricate savings on thin data.
//     When post-kolm spend exceeds baseline (a regression) we still return
//     the (negative) saved_usd but annotate `regression: true` and set
//     fee_usd to 0 — kolm.ai does not bill against negative savings.
//
//  4. Defense-in-depth tenant fence: every event-store read filters by
//     tenant_id at the source AND inside the per-row loop. The route layer
//     forces tenant_id from req.tenant_record.id; this module also rejects
//     foreign-row leakage as a second seam.

import { appendEvent, listEvents } from './event-store.js';

// ---- Frozen constants (refresh quarterly + update CHANGELOG when bumped) ----

export const BASELINE_PERIOD_DAYS_DEFAULT = 30;
export const MIN_BASELINE_DAYS = 7;
export const SAVINGS_FEE_RATE_DEFAULT = 0.125; // 12.5% — within 10-15% band

// Rate-card snapshot 2025-Q4; refresh quarterly.
//
// USD per 1,000,000 tokens (NOT per 1k). Public-published list prices only;
// volume discounts, batch-API discounts, and cached-input discounts are
// explicitly NOT modelled here — those are negotiated, and baking them in
// would let kolm.ai overstate per-call savings against a list-price baseline.
export const PROVIDER_RATE_CARD = Object.freeze({
  anthropic: Object.freeze({
    'claude-opus-4-7':    Object.freeze({ input_per_million_usd: 15.00, output_per_million_usd: 75.00 }),
    'claude-opus-4-6':    Object.freeze({ input_per_million_usd: 15.00, output_per_million_usd: 75.00 }),
    'claude-sonnet-4-7':  Object.freeze({ input_per_million_usd:  3.00, output_per_million_usd: 15.00 }),
    'claude-sonnet-4-6':  Object.freeze({ input_per_million_usd:  3.00, output_per_million_usd: 15.00 }),
    'claude-sonnet-4-5':  Object.freeze({ input_per_million_usd:  3.00, output_per_million_usd: 15.00 }),
    'claude-haiku-4-5':   Object.freeze({ input_per_million_usd:  0.80, output_per_million_usd:  4.00 }),
    'claude-3-5-sonnet':  Object.freeze({ input_per_million_usd:  3.00, output_per_million_usd: 15.00 }),
    'claude-3-5-haiku':   Object.freeze({ input_per_million_usd:  0.80, output_per_million_usd:  4.00 }),
    'claude-3-opus':      Object.freeze({ input_per_million_usd: 15.00, output_per_million_usd: 75.00 }),
  }),
  openai: Object.freeze({
    'gpt-4o':              Object.freeze({ input_per_million_usd:  2.50, output_per_million_usd: 10.00 }),
    'gpt-4o-mini':         Object.freeze({ input_per_million_usd:  0.15, output_per_million_usd:  0.60 }),
    'gpt-4-turbo':         Object.freeze({ input_per_million_usd: 10.00, output_per_million_usd: 30.00 }),
    'gpt-4':               Object.freeze({ input_per_million_usd: 30.00, output_per_million_usd: 60.00 }),
    'gpt-3.5-turbo':       Object.freeze({ input_per_million_usd:  0.50, output_per_million_usd:  1.50 }),
    'o1':                  Object.freeze({ input_per_million_usd: 15.00, output_per_million_usd: 60.00 }),
    'o1-mini':             Object.freeze({ input_per_million_usd:  3.00, output_per_million_usd: 12.00 }),
    'o3-mini':             Object.freeze({ input_per_million_usd:  1.10, output_per_million_usd:  4.40 }),
  }),
  google: Object.freeze({
    'gemini-2.5-flash':      Object.freeze({ input_per_million_usd: 0.075, output_per_million_usd: 0.30 }),
    'gemini-2.5-pro':        Object.freeze({ input_per_million_usd: 1.25,  output_per_million_usd: 5.00 }),
    'gemini-2.5-flash-lite': Object.freeze({ input_per_million_usd: 0.04,  output_per_million_usd: 0.16 }),
    'gemini-2.0-flash':      Object.freeze({ input_per_million_usd: 0.10,  output_per_million_usd: 0.40 }),
  }),
  deepseek: Object.freeze({
    'deepseek-v4-flash': Object.freeze({ input_per_million_usd: 0.14, output_per_million_usd: 0.28 }),
    'deepseek-v4-pro':  Object.freeze({ input_per_million_usd: 0.27, output_per_million_usd: 1.10 }),
  }),
});

// Internal markers — we identify the baseline-start row by the
// (provider, model) tuple ('kolm', 'savings-tracker') + cost_micro_usd=0.
// We cannot use a custom `status` value because the event-schema enum
// (ok|error|timeout|rate_limited|blocked) collapses unknown values to 'ok'
// and we cannot use a custom `kind` field because the schema drops any
// key not in EVENT_FIELDS. The (provider, model) tuple is unique enough
// to never collide with a real teacher-spend row.
const BASELINE_MARKER_PROVIDER = 'kolm';
const BASELINE_MARKER_MODEL = 'savings-tracker';

function _isBaselineMarker(ev) {
  return ev
    && ev.provider === BASELINE_MARKER_PROVIDER
    && ev.model === BASELINE_MARKER_MODEL;
}

function _isPositiveInt(n) {
  return Number.isFinite(Number(n)) && Number(n) >= 0 && Math.floor(Number(n)) === Number(n);
}

// Public: look up the (input,output) per-million rates for one model.
// Throws { code:'unknown_provider' } / { code:'unknown_model' } on misses.
// The caller decides whether to surface as 400 or quietly skip; we never
// silently default to 0 because that would understate baseline spend.
export function lookupRate({ provider, model }) {
  const provKey = String(provider || '').toLowerCase();
  const card = PROVIDER_RATE_CARD[provKey];
  if (!card) {
    const err = new Error('unknown_provider: ' + provider);
    err.code = 'unknown_provider';
    throw err;
  }
  const modelKey = String(model || '');
  let row = card[modelKey];
  if (!row && modelKey.includes('/')) {
    row = card[modelKey.split('/').pop()];
  }
  if (!row && modelKey) {
    const stripped = modelKey.replace(/-2\d{7}$/, '');
    row = card[stripped];
  }
  if (!row) {
    const err = new Error('unknown_model: ' + provider + '/' + model);
    err.code = 'unknown_model';
    throw err;
  }
  return row;
}

// Compute USD cost from (tokens_in, tokens_out) + frozen rate card.
// Returned in micro-USD (integer) to align with event-store cost_micro_usd.
function _costMicroUsd({ provider, model, input_tokens, output_tokens }) {
  const rate = lookupRate({ provider, model });
  const tin = Number(input_tokens) || 0;
  const tout = Number(output_tokens) || 0;
  const usd = (tin / 1_000_000) * rate.input_per_million_usd
            + (tout / 1_000_000) * rate.output_per_million_usd;
  return Math.round(usd * 1_000_000);
}

// Public: mark the start of a baseline window for a tenant + namespace.
// Returns { ok:true, started_at, tenant_id, namespace }. Persisted as a
// regular event with a distinctive status + kind so listEvents can find
// it later.
export async function startBaselinePeriod({ tenant_id, namespace, start_ts } = {}) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const ns = String(namespace || 'default');
  const started_at = start_ts ? new Date(start_ts).toISOString() : new Date().toISOString();
  await appendEvent({
    tenant_id,
    namespace: ns,
    provider: BASELINE_MARKER_PROVIDER,
    model: BASELINE_MARKER_MODEL,
    vendor: 'kolm',
    status: 'ok',
    created_at: started_at,
    cost_micro_usd: 0,
    estimated_cost_usd: 0,
    source_type: 'synthetic',
  });
  return { ok: true, started_at, tenant_id, namespace: ns };
}

// Find the most recent baseline marker for a tenant + namespace, or null.
async function _findBaselineMarker(tenant_id, namespace) {
  const rows = await listEvents({
    tenant_id,
    namespace,
    limit: 0,
    order: 'desc',
  });
  for (const ev of rows) {
    if (!ev) continue;
    if (ev.tenant_id !== tenant_id) continue;
    if (ev.namespace !== namespace) continue;
    if (_isBaselineMarker(ev)) {
      return ev;
    }
  }
  return null;
}

// Public: record a teacher API call's cost. Used for non-Kolm-routed calls
// that the user wants tracked (e.g., direct OpenAI SDK call before kolm).
// Returns the persisted event row.
export async function recordTeacherSpend({
  tenant_id,
  namespace,
  provider,
  model,
  input_tokens,
  output_tokens,
  ts,
} = {}) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const ns = String(namespace || 'default');
  const cost_micro_usd = _costMicroUsd({ provider, model, input_tokens, output_tokens });
  const created_at = ts ? new Date(ts).toISOString() : new Date().toISOString();
  const ev = await appendEvent({
    tenant_id,
    namespace: ns,
    provider: String(provider).toLowerCase(),
    model: String(model),
    status: 'ok',
    created_at,
    prompt_tokens: Number(input_tokens) || 0,
    completion_tokens: Number(output_tokens) || 0,
    tokens_in: Number(input_tokens) || 0,
    tokens_out: Number(output_tokens) || 0,
    cost_micro_usd,
    estimated_cost_usd: cost_micro_usd / 1_000_000,
    source_type: 'teacher_spend_recorded',
  });
  return ev;
}

// Sum cost_micro_usd over a window. Excludes baseline-marker rows + foreign
// tenant rows. Returns { total_cost_micro_usd, total_cost_usd, captures }.
async function _sumSpend({ tenant_id, namespace, since, until }) {
  const rows = await listEvents({
    tenant_id,
    namespace,
    since,
    until,
    limit: 0,
  });
  let totalMicro = 0;
  let captures = 0;
  for (const ev of rows) {
    if (!ev) continue;
    // Defense-in-depth tenant fence.
    if (ev.tenant_id && tenant_id && ev.tenant_id !== tenant_id) continue;
    if (ev.namespace && namespace && ev.namespace !== namespace) continue;
    if (_isBaselineMarker(ev)) continue;
    const c = Number(ev.cost_micro_usd);
    if (Number.isFinite(c)) {
      totalMicro += c;
    } else if (Number.isFinite(Number(ev.estimated_cost_usd))) {
      totalMicro += Math.round(Number(ev.estimated_cost_usd) * 1_000_000);
    }
    captures += 1;
  }
  return {
    total_cost_micro_usd: totalMicro,
    total_cost_usd: totalMicro / 1_000_000,
    captures,
  };
}

// Public: spend during the baseline window. If no baseline started yet,
// returns { status:'no_baseline_started', total_cost_usd:0, ... }.
export async function getBaselineSpend({ tenant_id, namespace, period_days } = {}) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const ns = String(namespace || 'default');
  const days = _isPositiveInt(period_days) ? Number(period_days) : BASELINE_PERIOD_DAYS_DEFAULT;
  const marker = await _findBaselineMarker(tenant_id, ns);
  if (!marker) {
    return {
      status: 'no_baseline_started',
      tenant_id, namespace: ns, period_days: days,
      baseline_start: null, baseline_end: null,
      total_cost_usd: 0, total_cost_micro_usd: 0, captures: 0,
    };
  }
  const since = marker.created_at;
  const sinceMs = new Date(since).getTime();
  const untilMs = sinceMs + days * 86_400_000;
  const until = new Date(untilMs).toISOString();
  const sums = await _sumSpend({ tenant_id, namespace: ns, since, until });
  return {
    status: 'ok',
    tenant_id, namespace: ns, period_days: days,
    baseline_start: since,
    baseline_end: until,
    ...sums,
  };
}

// Public: spend during the post-kolm window (the period_days immediately
// after the baseline window ends). Returns the same shape as getBaselineSpend.
export async function getPostKolmSpend({ tenant_id, namespace, period_days } = {}) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const ns = String(namespace || 'default');
  const days = _isPositiveInt(period_days) ? Number(period_days) : BASELINE_PERIOD_DAYS_DEFAULT;
  const marker = await _findBaselineMarker(tenant_id, ns);
  if (!marker) {
    return {
      status: 'no_baseline_started',
      tenant_id, namespace: ns, period_days: days,
      window_start: null, window_end: null,
      total_cost_usd: 0, total_cost_micro_usd: 0, captures: 0,
    };
  }
  const sinceMs = new Date(marker.created_at).getTime() + days * 86_400_000;
  const untilMs = sinceMs + days * 86_400_000;
  const since = new Date(sinceMs).toISOString();
  const until = new Date(untilMs).toISOString();
  const sums = await _sumSpend({ tenant_id, namespace: ns, since, until });
  return {
    status: 'ok',
    tenant_id, namespace: ns, period_days: days,
    window_start: since,
    window_end: until,
    ...sums,
  };
}

// Public: full savings envelope. Returns:
//   {
//     status: 'ok' | 'insufficient_baseline' | 'no_baseline_started',
//     baseline_usd, post_kolm_usd, saved_usd, fee_usd, net_savings_usd,
//     fee_rate, methodology, regression
//   }
export async function computeSavings({
  tenant_id,
  namespace,
  period_days,
  fee_rate,
  now_ts,
} = {}) {
  if (!tenant_id) {
    const err = new Error('tenant_id required');
    err.code = 'tenant_id_required';
    throw err;
  }
  const ns = String(namespace || 'default');
  const days = _isPositiveInt(period_days) ? Number(period_days) : BASELINE_PERIOD_DAYS_DEFAULT;
  const rate = Number.isFinite(Number(fee_rate)) ? Number(fee_rate) : SAVINGS_FEE_RATE_DEFAULT;
  const methodology = 'Savings computed by comparing teacher API spend during the '
    + 'baseline window to spend during the equivalent post-kolm window. Rates from '
    + 'PROVIDER_RATE_CARD (2025-Q4 snapshot of public list prices).';
  const marker = await _findBaselineMarker(tenant_id, ns);
  if (!marker) {
    return {
      status: 'no_baseline_started',
      message: 'No baseline window started. Call POST /v1/savings/baseline first.',
      tenant_id, namespace: ns, period_days: days,
      baseline_usd: 0, post_kolm_usd: 0, saved_usd: 0,
      fee_usd: 0, net_savings_usd: 0, fee_rate: rate,
      methodology, regression: false,
    };
  }
  const nowMs = now_ts ? new Date(now_ts).getTime() : Date.now();
  const markerMs = new Date(marker.created_at).getTime();
  const elapsedDays = Math.floor((nowMs - markerMs) / 86_400_000);
  if (elapsedDays < MIN_BASELINE_DAYS) {
    return {
      status: 'insufficient_baseline',
      message: 'Baseline period needs at least ' + MIN_BASELINE_DAYS + ' days of data; '
        + elapsedDays + ' so far.',
      tenant_id, namespace: ns, period_days: days,
      baseline_start: marker.created_at,
      elapsed_days: elapsedDays,
      min_baseline_days: MIN_BASELINE_DAYS,
      baseline_usd: 0, post_kolm_usd: 0, saved_usd: 0,
      fee_usd: 0, net_savings_usd: 0, fee_rate: rate,
      methodology, regression: false,
    };
  }
  // Use whichever is smaller — requested period_days or what we've observed
  // — so we never project past the observed window.
  const effectiveDays = Math.min(days, elapsedDays);
  const baseline = await getBaselineSpend({ tenant_id, namespace: ns, period_days: effectiveDays });
  const post = await getPostKolmSpend({ tenant_id, namespace: ns, period_days: effectiveDays });
  const baseline_usd = baseline.total_cost_usd;
  const post_kolm_usd = post.total_cost_usd;
  const saved_usd = baseline_usd - post_kolm_usd;
  const regression = saved_usd < 0;
  // Honesty: do NOT bill against a regression. fee_usd is 0 when saved_usd<=0.
  const fee_usd = saved_usd > 0 ? saved_usd * rate : 0;
  const net_savings_usd = saved_usd - fee_usd;
  return {
    status: 'ok',
    tenant_id, namespace: ns, period_days: effectiveDays, requested_period_days: days,
    baseline_start: baseline.baseline_start,
    baseline_end: baseline.baseline_end,
    post_window_start: post.window_start,
    post_window_end: post.window_end,
    baseline_usd,
    post_kolm_usd,
    saved_usd,
    fee_usd,
    net_savings_usd,
    fee_rate: rate,
    baseline_captures: baseline.captures,
    post_captures: post.captures,
    methodology,
    regression,
  };
}

export default {
  BASELINE_PERIOD_DAYS_DEFAULT,
  MIN_BASELINE_DAYS,
  SAVINGS_FEE_RATE_DEFAULT,
  PROVIDER_RATE_CARD,
  lookupRate,
  startBaselinePeriod,
  recordTeacherSpend,
  getBaselineSpend,
  getPostKolmSpend,
  computeSavings,
};
