// src/data-feedback.js
//
// KOLM DATA ENGINE - FEEDBACK stage (closes the 6-stage loop).
//
// Pipeline position: INGEST → CURATE → AUGMENT → TRAIN → EVALUATE → [FEEDBACK].
//
// This stage looks at production usage, finds coverage gaps the deployed model
// is missing, and PROPOSES a recompile. It NEVER triggers training itself: it
// writes proposal rows that the autopilot tick consumes on its own schedule.
// That seam keeps "decide what to train" separate from "actually spend GPU".
//
// Surface:
//   identifyProdGaps({tenant, namespace, opts, injectGaps}) - find gaps + map to actions
//   proposeRecompile({tenant, namespace, gaps})             - write a proposal row
//   latestProposal({tenant, namespace})                     - read back newest proposal
//   recordABResult({tenant, namespace, variant_a, variant_b, winner, metric})
//   scheduleRecompile({cron, namespace})                    - validate a cron descriptor (pure)
//   costPrune({pairs, max_cost_usd, avg_input_tokens, avg_output_tokens})
//
// Persistence is best-effort via src/event-store.js. The public API never
// throws - every return path is an envelope {ok, version, ...}.
//
// Reuses (no new deps):
//   - getCoverageGapsForNamespace (src/active-learning.js) for real gap data
//   - estimateBatchCost-style per-pair math (src/cost-estimator.js) for prune
//
// Caveats: scheduleRecompile only validates the cron string shape; it does not
// register a real cron job. costPrune uses output length as a value proxy, not
// a learned quality score. Both limitations are intentional for this stage.

import * as eventStore from './event-store.js';
import { getCoverageGapsForNamespace } from './active-learning.js';
import { estimateCost } from './cost-estimator.js';

export const FEEDBACK_VERSION = 'feedback-v1';

const PROVIDER = 'kolm_data_feedback';
const DEFAULT_TENANT = 'tenant_local';

// Cost-prune token assumptions mirror src/cost-estimator.js
// (estimateBatchCost defaults: 256 in / 384 out, ~0.25 tokens/char).
const DEFAULT_AVG_INPUT_TOKENS = 256;
const DEFAULT_AVG_OUTPUT_TOKENS = 384;
const PRUNE_VENDOR = 'openai';
const PRUNE_MODEL = 'gpt-4o-mini';

// ---------------------------------------------------------------------------
// Persistence - EXACT mandated pattern. Best-effort; never throws across API.
// ---------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try { const ev = await eventStore.appendEvent({ tenant_id: tenant, namespace: namespace||'default', provider: PROVIDER, vendor:'kolm', model:'data-feedback/v1', workflow_id: workflow, status:'ok', prompt_tokens:0, completion_tokens:0, feedback: JSON.stringify(payload||{}) }); return { persisted:true, event_id: ev && ev.event_id }; }
  catch (e) { return { persisted:false, error:String((e&&e.message)||e) }; }
}

async function _readLatest({ tenant, namespace, workflow, limit=16 }) {
  try { const rows = await eventStore.listEvents({ tenant_id: tenant, namespace: namespace||'default', provider: PROVIDER, workflow_id: workflow, limit, order:'desc' }); for (const r of (rows||[])) if (r && r.tenant_id===tenant) return r; return null; } catch { return null; }
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function _isoNow() { return new Date().toISOString(); }

function _tenant(t) { return (t && String(t)) || DEFAULT_TENANT; }

// Coerce an arbitrary gap-ish object into the canonical {cluster_id, gap_score,
// recommended_count} triple the rest of this module relies on. Defensive so a
// malformed injectGaps entry never crashes the public API.
function _normalizeGap(g, i) {
  const cluster_id = (g && g.cluster_id != null) ? String(g.cluster_id) : `cluster_${i}`;
  const gap_score = Number(g && g.gap_score) || 0;
  const recCount = Number(g && g.recommended_count);
  const recommended_count = Number.isFinite(recCount) ? Math.max(0, Math.trunc(recCount)) : 0;
  return { cluster_id, gap_score, recommended_count };
}

function _sumEstPairs(gaps) {
  return (Array.isArray(gaps) ? gaps : []).reduce(
    (acc, g) => acc + (Number(g && g.recommended_count) || 0), 0);
}

// Parse the feedback JSON blob we persisted back into an object. Returns null
// on any decode failure so callers can fall through to a clean "null" path.
function _decodeFeedback(row) {
  if (!row) return null;
  try {
    const raw = row.feedback;
    if (raw == null) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// identifyProdGaps - find production coverage gaps, map each to an augment action.
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} [args.tenant]
 * @param {string} [args.namespace]
 * @param {object} [args.opts]        forwarded to getCoverageGapsForNamespace
 * @param {Array}  [args.injectGaps]  when provided, used directly (testable path)
 * @returns {Promise<{ok:boolean, version:string, gaps:Array,
 *   recommended_actions:Array<{action,cluster_id,est_pairs}>, n_gaps:number,
 *   error?:string}>}
 */
export async function identifyProdGaps({ tenant, namespace, opts, injectGaps } = {}) {
  const t = _tenant(tenant);
  const ns = (namespace && String(namespace)) || 'default';
  try {
    let gaps;
    if (Array.isArray(injectGaps)) {
      gaps = injectGaps.map(_normalizeGap);
    } else {
      const res = await getCoverageGapsForNamespace(ns, { tenant_id: t, ...(opts || {}) });
      if (!res || res.ok !== true) {
        // No usable gap data yet (e.g. insufficient_captures). Surface it as an
        // empty, well-formed envelope rather than an error so the autopilot
        // tick can treat "nothing to do" uniformly.
        return {
          ok: true,
          version: FEEDBACK_VERSION,
          gaps: [],
          recommended_actions: [],
          n_gaps: 0,
          note: (res && res.error) || 'no_coverage_gaps_available',
        };
      }
      gaps = (res.gaps || []).map(_normalizeGap);
    }

    const recommended_actions = gaps.map((g) => ({
      action: 'augment:gap-fill',
      cluster_id: g.cluster_id,
      est_pairs: g.recommended_count,
    }));

    return {
      ok: true,
      version: FEEDBACK_VERSION,
      gaps,
      recommended_actions,
      n_gaps: gaps.length,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: FEEDBACK_VERSION };
  }
}

// ---------------------------------------------------------------------------
// proposeRecompile - persist a proposal row. NEVER starts training.
// ---------------------------------------------------------------------------

/**
 * Writes a 'feedback:recompile-proposed' row that the autopilot tick consumes.
 * @returns {Promise<{ok:boolean, version:string, proposal:object, error?:string}>}
 */
export async function proposeRecompile({ tenant, namespace, gaps } = {}) {
  const t = _tenant(tenant);
  const ns = (namespace && String(namespace)) || 'default';
  try {
    const normGaps = (Array.isArray(gaps) ? gaps : []).map(_normalizeGap);
    const est_pairs_needed = _sumEstPairs(normGaps);
    const proposed_at = _isoNow();
    const gaps_summary = normGaps.map((g) => ({
      cluster_id: g.cluster_id,
      gap_score: g.gap_score,
      recommended_count: g.recommended_count,
    }));
    const reason = normGaps.length
      ? `${normGaps.length} production coverage gap(s) detected in namespace '${ns}'; ~${est_pairs_needed} gap-fill pairs recommended.`
      : `No production coverage gaps detected in namespace '${ns}'; recompile not required.`;

    const proposal = {
      reason,
      est_pairs_needed,
      strategy: 'gap-fill',
      proposed_at,
      gaps_summary,
    };

    // Best-effort persist; the proposal is returned regardless so the caller
    // (and tests) can act on it even if the store is unavailable.
    const p = await _persist({
      tenant: t,
      namespace: ns,
      workflow: 'feedback:recompile-proposed',
      payload: proposal,
    });

    return {
      ok: true,
      version: FEEDBACK_VERSION,
      proposal,
      persisted: p.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: FEEDBACK_VERSION };
  }
}

// ---------------------------------------------------------------------------
// latestProposal - read back the newest recompile proposal.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, proposal:object|null}>}
 */
export async function latestProposal({ tenant, namespace } = {}) {
  const t = _tenant(tenant);
  const ns = (namespace && String(namespace)) || 'default';
  try {
    const row = await _readLatest({
      tenant: t,
      namespace: ns,
      workflow: 'feedback:recompile-proposed',
    });
    const proposal = _decodeFeedback(row);
    return { ok: true, version: FEEDBACK_VERSION, proposal: proposal || null };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: FEEDBACK_VERSION };
  }
}

// ---------------------------------------------------------------------------
// recordABResult - persist an A/B comparison outcome.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ok:boolean, version:string, recorded:boolean, winner:any}>}
 */
export async function recordABResult({ tenant, namespace, variant_a, variant_b, winner, metric } = {}) {
  const t = _tenant(tenant);
  const ns = (namespace && String(namespace)) || 'default';
  try {
    const payload = {
      variant_a: variant_a != null ? String(variant_a) : null,
      variant_b: variant_b != null ? String(variant_b) : null,
      winner: winner != null ? String(winner) : null,
      metric: metric != null ? metric : null,
      recorded_at: _isoNow(),
    };
    const p = await _persist({
      tenant: t,
      namespace: ns,
      workflow: 'feedback:ab',
      payload,
    });
    return {
      ok: true,
      version: FEEDBACK_VERSION,
      recorded: true,
      winner: payload.winner,
      persisted: p.persisted === true,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), version: FEEDBACK_VERSION };
  }
}

// ---------------------------------------------------------------------------
// scheduleRecompile - validate a cron-ish descriptor (pure; no real cron).
// ---------------------------------------------------------------------------

/**
 * Pure validation. Confirms `cron` is a non-empty string and returns a schedule
 * descriptor. Does NOT register a real cron job - the autopilot owns scheduling.
 * @returns {{ok:boolean, version:string, schedule?:object, error?:string}}
 */
export function scheduleRecompile({ cron, namespace } = {}) {
  const cronStr = (cron == null ? '' : String(cron)).trim();
  if (!cronStr) {
    return { ok: false, error: 'empty_cron', version: FEEDBACK_VERSION };
  }
  const ns = (namespace && String(namespace)) || 'default';
  // next_hint is a human-readable acknowledgement, NOT a computed fire time - 
  // we deliberately do not own a cron parser here.
  const next_hint = `validated; the autopilot tick will honor cron '${cronStr}' for namespace '${ns}'`;
  return {
    ok: true,
    version: FEEDBACK_VERSION,
    schedule: {
      cron: cronStr,
      namespace: ns,
      next_hint,
    },
  };
}

// ---------------------------------------------------------------------------
// costPrune - greedily keep highest-value pairs under a USD ceiling.
// ---------------------------------------------------------------------------

// Per-pair USD estimate using the same heuristic as estimateBatchCost: each
// pair costs avg_input_tokens of prompt + avg_output_tokens of completion at
// the chosen reference model's price. Local/unknown models would estimate $0,
// so we anchor on a real priced model (openai:gpt-4o-mini) for a meaningful cap.
function _perPairCostUsd(avgIn, avgOut) {
  const c = estimateCost({
    provider: PRUNE_VENDOR,
    model: PRUNE_MODEL,
    prompt_tokens: avgIn,
    completion_tokens: avgOut,
  });
  return Number(c) || 0;
}

// Value proxy: longer non-empty outputs are treated as higher value. Empty
// outputs score 0 and are dropped first. (Caveat: a length proxy, not a
// learned quality signal - see module header.)
function _outputText(pair) {
  if (pair == null) return '';
  if (typeof pair === 'string') return '';
  const o = pair.output != null ? pair.output
    : (pair.completion != null ? pair.completion
      : (pair.response != null ? pair.response : ''));
  return o == null ? '' : String(o);
}

/**
 * @param {object} args
 * @param {Array}  args.pairs               training pairs ({input, output}-ish)
 * @param {number} args.max_cost_usd        cumulative USD ceiling
 * @param {number} [args.avg_input_tokens]  per-pair prompt-token assumption
 * @param {number} [args.avg_output_tokens] per-pair completion-token assumption
 * @returns {{ok:boolean, version:string, kept:Array, dropped_count:number, est_cost_usd:number}}
 */
export function costPrune({ pairs, max_cost_usd, avg_input_tokens, avg_output_tokens } = {}) {
  const list = Array.isArray(pairs) ? pairs.slice() : [];
  const total = list.length;
  const ceiling = Number(max_cost_usd);
  const avgIn = Number.isFinite(Number(avg_input_tokens)) ? Number(avg_input_tokens) : DEFAULT_AVG_INPUT_TOKENS;
  const avgOut = Number.isFinite(Number(avg_output_tokens)) ? Number(avg_output_tokens) : DEFAULT_AVG_OUTPUT_TOKENS;

  const perPair = _perPairCostUsd(avgIn, avgOut);

  // Rank by value proxy (longest non-empty output first). Stable on ties via index.
  const ranked = list
    .map((p, idx) => ({ p, idx, len: _outputText(p).length }))
    .sort((a, b) => (b.len - a.len) || (a.idx - b.idx));

  const kept = [];
  let est = 0;
  if (Number.isFinite(ceiling) && ceiling > 0 && perPair > 0) {
    for (const item of ranked) {
      // Empty-output pairs carry no value under the proxy - never keep them.
      if (item.len <= 0) continue;
      const next = est + perPair;
      // Greedy: stop once adding this pair would exceed the ceiling.
      if (next > ceiling) break;
      kept.push(item.p);
      est = next;
    }
  } else if (perPair === 0) {
    // Reference model returned no price - cost cap is meaningless, keep all
    // non-empty pairs (est stays 0). Defensive fall-through.
    for (const item of ranked) {
      if (item.len <= 0) continue;
      kept.push(item.p);
    }
  }
  // ceiling <= 0 or non-finite → keep nothing; est = 0.

  return {
    ok: true,
    version: FEEDBACK_VERSION,
    kept,
    dropped_count: total - kept.length,
    est_cost_usd: Number(est.toFixed(6)),
  };
}
