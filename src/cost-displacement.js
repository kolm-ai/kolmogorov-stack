// R-8 - Cost displacement reporting.
//
// Distinct from src/savings-tracker.js (W835):
//
//   - savings-tracker.js  : "baseline period vs post-kolm period" with a
//                            fee-on-savings model. Operator marks a moment
//                            in time as "baseline started" and we compare
//                            spend before/after that marker. Used for the
//                            kolm.ai pricing fee - the 12.5% of saved spend.
//
//   - cost-displacement.js: THIS FILE. Per-namespace, per-receipt reasoning
//                            using ConfidenceRouter's route_decision tag.
//                            For each receipt we ask: "if we had ALWAYS
//                            gone to frontier, what would this have cost?"
//                            vs "what did it actually cost?". The delta is
//                            the value the local artifact + ConfidenceRouter
//                            displaced. No fee math - this is operator-facing
//                            "what did kolm save me this month" without the
//                            pricing model baked in.
//
// Output shape (per spec):
//
//   {
//     ok: true,
//     baseline_cost_usd,         // if every routed call had gone to frontier
//     actual_cost_usd,           // what was actually billed (local=$0)
//     savings_usd,               // baseline - actual
//     cumulative_savings_usd,    // same math since artifact_deployed_at
//     payback_period_months,     // compile_cost / monthly_savings_rate
//                                 // (number, 0, or 'instant')
//     period: {
//       period_days, since_ms, until_ms,
//       receipt_count, local_count, frontier_count, frontier_fallback_count,
//     },
//     // Provenance - never silent on missing data.
//     ok_status: 'computed' | 'no_receipts' | 'no_route_decisions' | ...
//   }
//
// Cost model:
//
//   For each receipt we trust `cost_usd` as the actual cost. We do NOT
//   re-price from a rate card here - the receipt already carries the
//   authoritative number because the router stamped it at decision time.
//
//   For BASELINE we need "what would frontier have cost?" - that depends on
//   the route_decision:
//
//     route_decision = 'frontier'          : actual cost (no displacement)
//     route_decision = 'frontier_fallback' : actual cost (we already paid full)
//     route_decision = 'local'             : the frontier-equivalent cost
//                                            for the model that WOULD have run
//
//   For the local case we don't have a counterfactual on the row, so we use
//   the namespace's primary/fallback config to look up the model and price it
//   off the same provider rate card src/savings-tracker.js uses. If we
//   cannot resolve a baseline price, the row is excluded and ok_status
//   reports 'partial:<n>_unrepriced'. We never invent numbers.
//
// Tenant + namespace scoping is enforced by the caller (the route layer
// pins tenant_id to req.tenant_record.id and forwards namespace as-is).
// This module accepts those already-scoped inputs and never reaches across.
//
// Pure JS - no model imports.

import * as store from './store.js';
import { PROVIDER_RATE_CARD } from './savings-tracker.js';

export const COST_DISPLACEMENT_VERSION = 'r8-v1';

export const DEFAULT_PERIOD_DAYS = 30;

// =============================================================================
// Helpers - row scoping + timestamp parsing
// =============================================================================

function _rowTimestampMs(row) {
  if (!row || typeof row !== 'object') return NaN;
  if (typeof row.ts === 'number' && Number.isFinite(row.ts)) return row.ts;
  if (typeof row.created_at === 'string') {
    const t = new Date(row.created_at).getTime();
    if (Number.isFinite(t)) return t;
  }
  if (typeof row.created_at === 'number' && Number.isFinite(row.created_at)) {
    return row.created_at;
  }
  return NaN;
}

function _byNamespace(rows, namespace) {
  if (!namespace || namespace === '*') return rows;
  return rows.filter((r) => r && (r.namespace === namespace || r.corpus_namespace === namespace));
}

function _defaultReadReceipts(tenant_id) {
  try {
    return store.findByTenant('observations', tenant_id) || [];
  } catch (_) {
    return [];
  }
}

// =============================================================================
// Rate-card pricing for the "what would frontier have cost" counterfactual.
// =============================================================================

// Look up a per-token cost from the savings-tracker frozen rate card.
// Returns { input_per_million_usd, output_per_million_usd } or null.
function _rateCardEntry(provider, model) {
  if (!provider || !model) return null;
  const p = String(provider).toLowerCase();
  const m = String(model);
  const providerTable = PROVIDER_RATE_CARD[p];
  if (!providerTable) return null;
  return providerTable[m] || null;
}

// Counterfactual frontier cost for a receipt, given its token counts and
// the namespace's frontier model (which we read from the namespace config
// if available; otherwise we fall back to the receipt's own model). When
// we cannot resolve a price we return null and the caller flags the row
// as 'unrepriced'.
function _frontierCostForReceipt(receipt, frontierProvider, frontierModel) {
  const inT = Number(receipt.input_tokens) || 0;
  const outT = Number(receipt.output_tokens) || 0;
  if (inT === 0 && outT === 0) return null;
  // Prefer the configured frontier model (the row would have been routed
  // there if local hadn't won); fall back to the receipt's own model when
  // the namespace config doesn't pin one.
  let entry = _rateCardEntry(frontierProvider, frontierModel);
  if (!entry) entry = _rateCardEntry(receipt.provider, receipt.model);
  if (!entry) return null;
  const cost = (inT * entry.input_per_million_usd + outT * entry.output_per_million_usd) / 1_000_000;
  return cost;
}

// =============================================================================
// Artifact passport reads - compile_cost + deployed_at for cumulative math.
// =============================================================================

// Best-effort read of compile_cost + deployed_at from the artifact passport.
// We accept an explicit override so a caller / test can pass these in
// without us touching disk. Returns {compile_cost_usd, deployed_at_ms}.
function _passportLookup(opts) {
  // Explicit overrides win.
  const explicit = {
    compile_cost_usd: opts.compile_cost_usd,
    deployed_at_ms: opts.deployed_at_ms,
  };
  if (Number.isFinite(Number(explicit.compile_cost_usd))
      && Number.isFinite(Number(explicit.deployed_at_ms))) {
    return {
      compile_cost_usd: Number(explicit.compile_cost_usd),
      deployed_at_ms: Number(explicit.deployed_at_ms),
    };
  }
  // If passport reader injected, use it.
  if (typeof opts.readPassport === 'function' && opts.artifact_id) {
    try {
      const p = opts.readPassport(opts.artifact_id);
      if (p && typeof p === 'object') {
        const cc = Number(p.compile_cost_usd);
        const da = (typeof p.deployed_at === 'string')
          ? new Date(p.deployed_at).getTime()
          : Number(p.deployed_at_ms);
        return {
          compile_cost_usd: Number.isFinite(cc) ? cc : 0,
          deployed_at_ms: Number.isFinite(da) ? da : null,
        };
      }
    } catch (_) { /* fall through */ }
  }
  return {
    compile_cost_usd: Number.isFinite(Number(explicit.compile_cost_usd)) ? Number(explicit.compile_cost_usd) : 0,
    deployed_at_ms: Number.isFinite(Number(explicit.deployed_at_ms)) ? Number(explicit.deployed_at_ms) : null,
  };
}

// =============================================================================
// Main entry point
// =============================================================================

/**
 * computeDisplacement({tenant_id, namespace, period_days, ...})
 *
 * Returns the envelope documented at the top of the file. On bad input
 * returns { ok:false, error, hint, version }.
 *
 * Optional opts:
 *   - now              : injected clock (epoch ms), default Date.now()
 *   - readReceipts(t)  : injected lake reader, default store.findByTenant
 *   - readPassport(id) : injected artifact passport reader (for compile_cost
 *                        + deployed_at)
 *   - artifact_id      : artifact id to look up the passport for
 *   - compile_cost_usd : explicit override for compile cost
 *   - deployed_at_ms   : explicit override for deployment epoch ms
 *   - frontier_provider, frontier_model : if known, the counterfactual
 *                                          model used for re-pricing local
 *                                          receipts. Defaults to the
 *                                          receipt's own provider/model.
 */
export function computeDisplacement(opts = {}) {
  const {
    tenant_id = null,
    namespace = 'default',
    period_days = DEFAULT_PERIOD_DAYS,
    now = Date.now(),
    readReceipts = _defaultReadReceipts,
    frontier_provider = null,
    frontier_model = null,
  } = opts || {};

  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'cost displacement is tenant-scoped; pass tenant_id',
      version: COST_DISPLACEMENT_VERSION,
    };
  }
  const days = Number(period_days);
  if (!Number.isFinite(days) || days <= 0 || days > 3650) {
    return {
      ok: false,
      error: 'invalid_period_days',
      hint: 'period_days must be a positive number <= 3650',
      version: COST_DISPLACEMENT_VERSION,
    };
  }

  const dayMs = 24 * 3600 * 1000;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const sinceMs = nowMs - days * dayMs;

  const allRows = readReceipts(tenant_id) || [];
  const nsRows = _byNamespace(allRows, namespace);
  const windowRows = nsRows.filter((r) => {
    const t = _rowTimestampMs(r);
    return Number.isFinite(t) && t >= sinceMs && t <= nowMs;
  });

  if (windowRows.length === 0) {
    return {
      ok: true,
      version: COST_DISPLACEMENT_VERSION,
      tenant_id,
      namespace,
      baseline_cost_usd: 0,
      actual_cost_usd: 0,
      savings_usd: 0,
      cumulative_savings_usd: 0,
      payback_period_months: 'instant',
      period: {
        period_days: days,
        since_ms: sinceMs,
        until_ms: nowMs,
        receipt_count: 0,
        local_count: 0,
        frontier_count: 0,
        frontier_fallback_count: 0,
        unrepriced_count: 0,
      },
      ok_status: 'no_receipts',
    };
  }

  // Walk receipts: sum actual cost, sum baseline cost, count each route.
  let actualCost = 0;
  let baselineCost = 0;
  let localCount = 0;
  let frontierCount = 0;
  let fallbackCount = 0;
  let unknownRouteCount = 0;
  let unrepricedCount = 0;

  for (const r of windowRows) {
    const actual = Number(r.cost_usd) || 0;
    actualCost += actual;

    const decision = typeof r.route_decision === 'string' ? r.route_decision : null;
    if (decision === 'local') {
      localCount++;
      // Counterfactual: what would frontier have cost?
      const fc = _frontierCostForReceipt(r, frontier_provider, frontier_model);
      if (fc == null) {
        unrepricedCount++;
        // Caveat fallback: count actual (which is $0 for local) as baseline
        // so the row contributes nothing to savings rather than inventing
        // a price.
        baselineCost += actual;
      } else {
        baselineCost += fc;
      }
    } else if (decision === 'frontier') {
      frontierCount++;
      // No displacement - would have gone to frontier anyway.
      baselineCost += actual;
    } else if (decision === 'frontier_fallback') {
      fallbackCount++;
      // We already paid full frontier price; no displacement here either.
      baselineCost += actual;
    } else {
      // Receipts without route_decision (older rows) - best we can say is
      // that what we paid is what we would have paid. No savings claim.
      unknownRouteCount++;
      baselineCost += actual;
    }
  }

  const savings = baselineCost - actualCost;

  // Cumulative savings since the artifact was deployed (or, if we don't
  // know the deployment time, since the start of the rows we have for
  // this namespace).
  const passport = _passportLookup(opts);
  let cumulativeSinceMs = passport.deployed_at_ms;
  if (!Number.isFinite(cumulativeSinceMs)) {
    // Fall back to the earliest row in the namespace.
    let earliest = Infinity;
    for (const r of nsRows) {
      const t = _rowTimestampMs(r);
      if (Number.isFinite(t) && t < earliest) earliest = t;
    }
    cumulativeSinceMs = Number.isFinite(earliest) ? earliest : nowMs;
  }
  const cumulativeRows = nsRows.filter((r) => {
    const t = _rowTimestampMs(r);
    return Number.isFinite(t) && t >= cumulativeSinceMs && t <= nowMs;
  });
  let cumulativeActual = 0;
  let cumulativeBaseline = 0;
  for (const r of cumulativeRows) {
    const actual = Number(r.cost_usd) || 0;
    cumulativeActual += actual;
    const decision = typeof r.route_decision === 'string' ? r.route_decision : null;
    if (decision === 'local') {
      const fc = _frontierCostForReceipt(r, frontier_provider, frontier_model);
      cumulativeBaseline += fc != null ? fc : actual;
    } else {
      cumulativeBaseline += actual;
    }
  }
  const cumulativeSavings = cumulativeBaseline - cumulativeActual;

  // Payback period = compile_cost / monthly_savings_rate.
  // monthly_savings_rate = (savings / period_days) * 30
  let payback_period_months;
  const compileCost = Number(passport.compile_cost_usd) || 0;
  if (compileCost <= 0) {
    payback_period_months = 'instant';
  } else {
    const monthlyRate = (savings / days) * 30;
    if (monthlyRate <= 0) {
      // No net savings yet - payback period is undefined; report it.
      payback_period_months = null;
    } else {
      payback_period_months = compileCost / monthlyRate;
    }
  }

  // ok_status - be loud about partials.
  let ok_status = 'computed';
  if (unrepricedCount > 0) ok_status = 'partial:' + unrepricedCount + '_unrepriced';
  if (localCount + frontierCount + fallbackCount === 0) {
    ok_status = 'no_route_decisions';
  }

  return {
    ok: true,
    version: COST_DISPLACEMENT_VERSION,
    tenant_id,
    namespace,
    baseline_cost_usd: baselineCost,
    actual_cost_usd: actualCost,
    savings_usd: savings,
    cumulative_savings_usd: cumulativeSavings,
    payback_period_months,
    period: {
      period_days: days,
      since_ms: sinceMs,
      until_ms: nowMs,
      receipt_count: windowRows.length,
      local_count: localCount,
      frontier_count: frontierCount,
      frontier_fallback_count: fallbackCount,
      unknown_route_count: unknownRouteCount,
      unrepriced_count: unrepricedCount,
    },
    compile_cost_usd: compileCost,
    deployed_at_ms: Number.isFinite(passport.deployed_at_ms) ? passport.deployed_at_ms : null,
    ok_status,
  };
}

// ---------------------------------------------------------------------------
// wave4-r-enrich: calculateSavings + estimateFrontierCost helpers. Distinct
// from computeDisplacement above:
//   - returns the (total_calls, local_calls, frontier_calls, local_ratio,
//     baseline_cost_usd, actual_cost_usd, savings_usd, savings_percent,
//     by_provider, compile_cost_usd, net_savings_usd, payback_days) shape
//     the Part-B spec asks for.
//   - returns days (number) rather than months (string|number).
//   - groups spend by provider so the dashboard can render the breakdown.
// ---------------------------------------------------------------------------

/**
 * estimateFrontierCost(input_tokens, output_tokens, model) -> number
 *
 * Look up `model` in the frozen PROVIDER_RATE_CARD (savings-tracker.js's
 * source of truth) and return USD cost. Searches every provider for the
 * model string; returns 0 when no match. We do NOT scale prices, infer
 * discounts, or invent costs - public list price only.
 *
 * Both arguments are coerced to numbers; non-finite values are treated as 0.
 */
export function estimateFrontierCost(input_tokens, output_tokens, model) {
  const inT = Number(input_tokens) || 0;
  const outT = Number(output_tokens) || 0;
  if (inT === 0 && outT === 0) return 0;
  const key = String(model || '');
  if (!key) return 0;
  for (const provider of Object.keys(PROVIDER_RATE_CARD)) {
    const table = PROVIDER_RATE_CARD[provider];
    if (table && table[key]) {
      const e = table[key];
      return (inT * e.input_per_million_usd + outT * e.output_per_million_usd) / 1_000_000;
    }
  }
  // Fall back to a fuzzy lookup that strips a publisher prefix
  // ('anthropic/claude-3-5-sonnet' -> 'claude-3-5-sonnet').
  const bare = key.includes('/') ? key.split('/').pop() : key;
  if (bare && bare !== key) {
    for (const provider of Object.keys(PROVIDER_RATE_CARD)) {
      const table = PROVIDER_RATE_CARD[provider];
      if (table && table[bare]) {
        const e = table[bare];
        return (inT * e.input_per_million_usd + outT * e.output_per_million_usd) / 1_000_000;
      }
    }
  }
  return 0;
}

/**
 * calculateSavings(namespace, period) -> Promise<envelope>
 *
 * Async wrapper that bundles up the displacement numbers in the v2 shape
 * the Part-B spec asks for. Reads observations from store.js using the
 * caller's `tenant_id` (passed via the `period` opts object).
 *
 * @param {string} namespace
 * @param {Object} period
 * @param {string} period.tenant_id  REQUIRED
 * @param {number} [period.period_days=30]
 * @param {number} [period.now]      epoch ms; defaults to Date.now()
 * @param {function} [period.readReceipts] inject for tests
 * @param {string} [period.frontier_model] frontier model id for re-pricing
 * @param {number} [period.compile_cost_usd] one-time compile cost
 *
 * Returns:
 *   {
 *     ok, version,
 *     total_calls, local_calls, frontier_calls,
 *     local_ratio,
 *     baseline_cost_usd, actual_cost_usd, savings_usd, savings_percent,
 *     by_provider: { provider: { calls, actual_cost, baseline_cost } },
 *     compile_cost_usd, net_savings_usd, payback_days
 *   }
 */
export async function calculateSavings(namespace, period = {}) {
  const tenant_id = period.tenant_id;
  if (!tenant_id || typeof tenant_id !== 'string') {
    return {
      ok: false,
      error: 'tenant_id_required',
      hint: 'pass period.tenant_id (savings are tenant-scoped)',
      version: COST_DISPLACEMENT_VERSION,
    };
  }
  const period_days = Number.isFinite(Number(period.period_days)) ? Number(period.period_days) : DEFAULT_PERIOD_DAYS;
  const now = Number.isFinite(Number(period.now)) ? Number(period.now) : Date.now();
  const readReceipts = period.readReceipts || _defaultReadReceipts;
  const frontier_model = period.frontier_model || null;
  const compile_cost_usd = Number.isFinite(Number(period.compile_cost_usd)) ? Number(period.compile_cost_usd) : 0;

  const dayMs = 24 * 3600 * 1000;
  const sinceMs = now - period_days * dayMs;
  const allRows = readReceipts(tenant_id) || [];
  const nsRows = _byNamespace(allRows, namespace);
  const windowRows = nsRows.filter((r) => {
    const t = _rowTimestampMs(r);
    return Number.isFinite(t) && t >= sinceMs && t <= now;
  });

  let total_calls = 0;
  let local_calls = 0;
  let frontier_calls = 0;
  let baseline_cost_usd = 0;
  let actual_cost_usd = 0;
  const by_provider = {};

  for (const r of windowRows) {
    total_calls++;
    const actual = Number(r.cost_usd) || 0;
    actual_cost_usd += actual;
    const provider = String(r.provider || 'unknown');
    if (!by_provider[provider]) {
      by_provider[provider] = { calls: 0, actual_cost: 0, baseline_cost: 0 };
    }
    by_provider[provider].calls++;
    by_provider[provider].actual_cost += actual;

    const decision = typeof r.route_decision === 'string' ? r.route_decision : null;
    let baseline;
    if (decision === 'local') {
      local_calls++;
      // What would frontier have cost? Use the configured frontier model
      // if provided, otherwise the receipt's own model.
      const model = frontier_model || r.model || '';
      const inT = Number(r.input_tokens) || 0;
      const outT = Number(r.output_tokens) || 0;
      baseline = estimateFrontierCost(inT, outT, model);
      // If we couldn't price (unknown model), the row contributes its
      // actual cost (which is $0 for local) - never invent.
      if (baseline === 0 && (inT > 0 || outT > 0)) baseline = actual;
    } else if (decision === 'frontier' || decision === 'frontier_fallback') {
      frontier_calls++;
      baseline = actual;
    } else {
      // Older row without route_decision - count it as frontier so we don't
      // overstate savings.
      frontier_calls++;
      baseline = actual;
    }
    baseline_cost_usd += baseline;
    by_provider[provider].baseline_cost += baseline;
  }

  const local_ratio = total_calls > 0 ? local_calls / total_calls : 0;
  const savings_usd = baseline_cost_usd - actual_cost_usd;
  const savings_percent = baseline_cost_usd > 0 ? (savings_usd / baseline_cost_usd) * 100 : 0;
  const net_savings_usd = savings_usd - compile_cost_usd;

  // payback_days = compile_cost / (savings_per_day). Returns:
  //   0       when compile_cost_usd <= 0 (instant)
  //   Infinity when savings per day <= 0
  //   number  otherwise
  let payback_days;
  if (compile_cost_usd <= 0) {
    payback_days = 0;
  } else {
    const savings_per_day = period_days > 0 ? savings_usd / period_days : 0;
    payback_days = savings_per_day > 0 ? compile_cost_usd / savings_per_day : Infinity;
  }

  return {
    ok: true,
    version: COST_DISPLACEMENT_VERSION,
    tenant_id,
    namespace,
    period_days,
    total_calls,
    local_calls,
    frontier_calls,
    local_ratio,
    baseline_cost_usd,
    actual_cost_usd,
    savings_usd,
    savings_percent,
    by_provider,
    compile_cost_usd,
    net_savings_usd,
    payback_days,
  };
}

export default {
  COST_DISPLACEMENT_VERSION,
  DEFAULT_PERIOD_DAYS,
  computeDisplacement,
  calculateSavings,
  estimateFrontierCost,
};
