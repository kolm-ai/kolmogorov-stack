// W775+ - Full Autopilot Mode (the capstone).
//
// tickAutopilotFull layers the autopilot intelligence components on top of the
// W775 heartbeat (src/autopilot-daemon.js tickAutopilot, the tested path) and
// adds the propose-only-default auto-deploy guardrail.
//
// One full tick:
//   0. (optional) bootstrapFromDescription - seed corpus + recipe from a phrase.
//   1. W775 heartbeat (tickAutopilot) - unchanged: WATCH (W815 gaps) + drift gate.
//   2. derive the current data feature vector from raw-pairs.jsonl.
//   3. ② Cost Optimizer - rankStrategies under budget  -> plan.
//   4. ④ Compile Simulator - simulateCompile on the recommended move -> compile|skip.
//   5. ⑥ Temporal Analyzer - seasonal/temporal coverage gaps (advisory).
//   6. ③ Failure Analyst - only when an eval artifact is supplied.
//   7. ⑧ Deploy guardrail - propose-only by default; --auto gates on 5 conditions.
//   8. ⑦ Flywheel - record a K-Score point when a fresh candidate K is known.
//
// Returns the W775 envelope (ok, action, namespace, version:w775-*) PLUS
// {plan, simulate_decision, deploy_decision, temporal, failure, features,
//  bootstrap, kscore_recorded, lifecycle_version}.
//
// AUTO-DEPLOY GUARDRAIL (high blast radius - explicit):
//   Default is PROPOSE-ONLY: a compile-worthy candidate writes a
//   DEPLOY_PROPOSED ledger row and stops. opts.auto===true is the ONLY path to
//   an autonomous deploy, and a deploy (DEPLOY_EXECUTED) fires ONLY when ALL of
//   these hold:
//     (1) compareAndDecide ⇒ 'promote' (K ≥ base + min_kscore_delta)
//     (2) regressions ≤ max_regression_classes (default 0)
//     (3) adversarial + safety eval pass (opts.eval_pass === true)
//     (4) W813 drift gate green
//     (5) 48h grace elapsed since DEPLOY_PROPOSED with no DEPLOY_OBJECTED
//   Grace is derived from the proposed-row timestamp (cron re-evaluates - no
//   long-lived process). The execute path reuses compareAndDecide's tested
//   promote/rollback receipt write - never a second deploy code path.

import {
  tickAutopilot,
  AUTOPILOT_VERSION,
  __internals as daemonInternals,
} from './autopilot-daemon.js';
import { rankStrategies, __internals as costInternals } from './cost-optimizer.js';
import { simulateCompile } from './compile-simulator.js';
import { compareAndDecide } from './improvement-orchestrator.js';

export const LIFECYCLE_VERSION = 'apl-v1';

// Reuse the daemon's tenant-fenced event-store helpers - ONE shared write/read
// path (risk #4: no per-component persistence sprawl).
const _writeAutopilotEvent = daemonInternals._writeAutopilotEvent;
const _readLatestAutopilotEvent = daemonInternals._readLatestAutopilotEvent;
const _isDriftRed = daemonInternals._isDriftRed;

// Strategy feature-delta priors - maps a recommended strategy name back to the
// feature-space delta the simulator should score.
const STRATEGIES = costInternals.STRATEGIES;

// New deploy lifecycle sentinels. Distinct workflow_ids so the deploy ledger is
// queryable independently of the daemon's enable/disable/holding rows. They
// ride the same AUTOPILOT_PROVIDER tag via _writeAutopilotEvent.
export const DEPLOY_WORKFLOW = Object.freeze({
  PROPOSED: 'autopilot:deploy_proposed',
  GRACE: 'autopilot:deploy_grace',
  EXECUTED: 'autopilot:deploy_executed',
  OBJECTED: 'autopilot:deploy_objected',
});

const GRACE_MS = 48 * 60 * 60 * 1000; // 48 hours

// W921 - ship gate on the K-Score composite scale (mirrors src/kscore.js +
// quality-predictor.js). Used by the conformal-lower-bound advisory below.
const SHIP_GATE = 0.85;

// W921 - strategy-feature priors live in the cost-optimizer (re-exported here as
// STRATEGIES). The bandit advisory warms each arm's prior mean from the
// cost-optimizer's per-strategy predicted_delta_k (the exact number the greedy
// path uses today), so at zero observed outcomes the bandit ranking matches the
// greedy ranking - no day-0 regression.

function _ns(namespace) {
  return String(namespace || 'default').slice(0, 128);
}

// ---------------------------------------------------------------------------
// W921 - always-valid (mSPRT / GAVI) sequential A/B advisory.
//
// The autopilot peeks the SAME accumulating A/B samples on every cron tick; a
// fixed-horizon test inflates Type-I error toward 1 under that peeking. The
// anytime-valid sequentialGate (src/stat-sig.js) is valid at every sample size
// simultaneously, so consulting it on each tick is safe. This is computed ONLY
// when an ab_test_id is in scope, and is ADDITIVE: by default it is an advisory
// signal attached to the decision envelope. It becomes a fail-closed deploy
// condition ONLY when opts.enforce_sequential === true, so existing deploy
// behavior (no A/B test wired) is byte-for-byte unchanged.
// ---------------------------------------------------------------------------
async function _sequentialAdvisory({ tenant, opts }) {
  const abTestId = opts && opts.ab_test_id;
  if (!abTestId) {
    return { applicable: false, reason: 'no_ab_test', decision: null, version: null };
  }
  try {
    const ss = await import('./stat-sig.js');
    const method = (opts && opts.seq_method === 'gavi') ? 'gavi' : 'msprt';
    const res = await ss.sequentialGate({
      tenant,
      ab_test_id: abTestId,
      method,
      alpha: (opts && Number.isFinite(Number(opts.seq_alpha))) ? Number(opts.seq_alpha) : undefined,
      min_effect_size: (opts && Number.isFinite(Number(opts.seq_min_effect_size)))
        ? Number(opts.seq_min_effect_size) : undefined,
      min_n: (opts && Number.isFinite(Number(opts.seq_min_n))) ? Number(opts.seq_min_n) : undefined,
    });
    return {
      applicable: true,
      method,
      decision: res && res.decision,
      ok: !!(res && res.ok),
      avp: res && res.avp,
      cs_low: res && res.cs_low,
      cs_high: res && res.cs_high,
      effect_size: res && res.effect_size,
      n_a: res && res.n_a,
      n_b: res && res.n_b,
      version: res && res.version,
    };
  } catch (e) {
    return { applicable: true, error: String((e && e.message) || e), decision: null, version: null };
  }
}

// W921 - conformal-lower-bound advisory for the candidate K-Score interval.
// When the caller supplies the candidate's conformal interval (candidate_ci,
// e.g. from quality-predictor.predicted_interval / inferKolmMeta), report
// whether the LOWER bound clears the ship gate. Additive: advisory by default,
// fail-closed condition only under opts.enforce_conformal === true.
function _conformalAdvisory({ opts }) {
  const ci = opts && (opts.candidate_ci || opts.candidate_conformal_interval);
  const lo = Array.isArray(ci) ? Number(ci[0]) : (ci && Number(ci.lo));
  if (!Number.isFinite(lo)) {
    return { applicable: false, reason: 'no_candidate_interval', lower: null, clears_gate: null };
  }
  return {
    applicable: true,
    lower: lo,
    ship_gate: SHIP_GATE,
    clears_gate: lo >= SHIP_GATE,
  };
}

function _isoNow() {
  return new Date().toISOString();
}

// Parse a budget that may arrive as a number or a string like "$50/month".
function _budgetUsd(v) {
  if (v == null) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  const m = String(v).match(/([\d.]+)/);
  return m ? Number(m[1]) : undefined;
}

// Read raw-pairs for a namespace without throwing - a cold namespace yields [].
async function _safeRawPairs(namespace) {
  try {
    const ing = await import('./data-ingest.js');
    if (typeof ing.readRawPairs !== 'function') return [];
    const r = ing.readRawPairs(namespace);
    return Array.isArray(r) ? r : [];
  } catch (_) {
    return [];
  }
}

// Derive the predictor's recognized feature vector from raw-pairs alone - cheap
// and real (no event-store dependency): n_pairs, dup_fraction (by input hash),
// teacher_diversity (distinct source_ref). coverage_score / avg_quality come
// from a curate run and are supplied via opts.features when available.
function _deriveFeatures(pairs) {
  const n = Array.isArray(pairs) ? pairs.length : 0;
  if (n === 0) return { n_pairs: 0 };
  const seen = new Set();
  const sources = new Set();
  let dups = 0;
  for (const p of pairs) {
    const input = (p && p.input != null) ? String(p.input) : '';
    if (input) {
      if (seen.has(input)) dups += 1;
      else seen.add(input);
    }
    const src = p && (p.source_ref || p.source);
    if (src) sources.add(String(src));
  }
  return {
    n_pairs: n,
    dup_fraction: Number((dups / n).toFixed(4)),
    teacher_diversity: sources.size,
  };
}

// Timestamp of an autopilot ledger row. Prefers a feedback timestamp
// (proposed_at / waiting_at) so a test can backdate the grace clock; falls back
// to the store-stamped created_at.
function _eventTs(row) {
  if (!row) return 0;
  try {
    const fb = JSON.parse(row.feedback || '{}');
    const t = Date.parse(fb.proposed_at || fb.waiting_at || fb.executed_at || '');
    if (Number.isFinite(t)) return t;
  } catch (_) { /* fall through to created_at */ }
  const c = Date.parse((row && row.created_at) || '');
  return Number.isFinite(c) ? c : 0;
}

// ---------------------------------------------------------------------------
// W921 - bandit strategy-ranking advisory (ADDITIVE, OPT-IN).
//
// When opts.use_bandit === true the autopilot consults the budgeted,
// non-stationary Thompson-sampling bandit (src/bandit-thompson.js) as a SECOND
// opinion alongside the cost-optimizer's greedy ranking. It is strictly
// advisory: the default propose-only gate and the simulator input
// (plan.recommended) are UNCHANGED. The bandit's pick is surfaced as
// bandit.recommended so an operator (or a future opt-in flag) can act on it;
// it never overrides the greedy recommended unless opts.bandit_decides === true.
//
// Warm-start: each arm's prior mean = the cost-optimizer's predicted_delta_k for
// that strategy, so n=0 behavior matches greedy (no day-0 regression). The bandit
// also writes a pending CHOICE row tying the chosen strategy to the base K so the
// OBSERVE leg (recordStrategyOutcome) can fold the realized ΔK back next tick.
//
// Deterministic: opts.rng (a seeded function) flows straight through to the
// sampler, so a test can pin the draw. Any import/throw falls back to a null
// advisory - the autopilot never regresses because the bandit is unavailable.
// ---------------------------------------------------------------------------
async function _banditAdvisory({ tenant, namespace, opts, plan, baseK, baseFeatures }) {
  if (!opts || opts.use_bandit !== true) {
    return { applicable: false, reason: 'not_enabled', recommended: null };
  }
  const ranked = (plan && plan.ok === true && Array.isArray(plan.ranked)) ? plan.ranked : null;
  if (!ranked || ranked.length === 0) {
    return { applicable: false, reason: 'no_cost_plan', recommended: null };
  }
  try {
    const bandit = await import('./bandit-thompson.js');
    // Build arms warm-started from the greedy plan's per-strategy ΔK + cost.
    const arms = ranked.map((r) => ({
      strategy: r.strategy,
      prior_mu: Number.isFinite(Number(r.predicted_delta_k)) ? Number(r.predicted_delta_k) : 0,
      est_cost_usd: Number.isFinite(Number(r.est_cost_usd)) ? Number(r.est_cost_usd) : 0,
      fits_budget: r.fits_budget === undefined ? true : !!r.fits_budget,
    }));
    const gamma = Number.isFinite(Number(opts.bandit_gamma)) ? Number(opts.bandit_gamma) : bandit.DEFAULT_GAMMA;
    const res = await bandit.rankByThompson({
      tenant, namespace, arms, gamma, rng: opts.rng,
    });
    if (!res || res.ok !== true) {
      return { applicable: true, error: (res && res.error) || 'bandit_failed', recommended: null };
    }

    // Write a pending CHOICE row for the bandit's pick so the loop can close.
    let choice = null;
    const recommended = res.recommended || null;
    if (recommended) {
      const picked = res.ranked.find((x) => x.strategy === recommended) || null;
      choice = await bandit.recordStrategyChoice({
        tenant, namespace, strategy: recommended,
        base_kscore: Number.isFinite(Number(baseK)) ? Number(baseK) : null,
        base_features: (baseFeatures && typeof baseFeatures === 'object') ? baseFeatures : null,
        est_cost_usd: picked ? picked.est_cost_usd : null,
        sampled_ratio: picked ? picked.sampled_ratio : null,
        run_id: opts.run_id || null,
      });
    }

    return {
      applicable: true,
      method: 'discounted-thompson',
      gamma: res.gamma,
      recommended,
      ranked: res.ranked,
      choice_id: choice && choice.choice_id,
      // Whether the bandit pick agrees with the greedy pick (diagnostic).
      agrees_with_greedy: !!(recommended && plan.recommended && recommended === plan.recommended),
      version: bandit.STRATEGY_BANDIT_VERSION,
    };
  } catch (e) {
    return { applicable: true, error: String((e && e.message) || e), recommended: null };
  }
}

// W921 - OBSERVE leg of the bandit loop. When the bandit is in use AND a fresh
// REALIZED candidate K is known, fold ΔK = candidate_K - base_K into the
// discounted posterior so the next tick learns from this round. Best-effort;
// idempotent on choice_id. Never throws.
async function _banditObserve({ tenant, namespace, opts, advisory, baseK, candidateK }) {
  if (!advisory || advisory.applicable !== true || !advisory.recommended) {
    return { recorded: false, reason: 'no_bandit_choice' };
  }
  if (!Number.isFinite(Number(candidateK)) || !Number.isFinite(Number(baseK))) {
    return { recorded: false, reason: 'no_realized_reward' };
  }
  try {
    const bandit = await import('./bandit-thompson.js');
    const gamma = Number.isFinite(Number(opts && opts.bandit_gamma)) ? Number(opts.bandit_gamma) : bandit.DEFAULT_GAMMA;
    const out = await bandit.recordStrategyOutcome({
      tenant, namespace,
      strategy: advisory.recommended,
      realized_delta_k: Number(candidateK) - Number(baseK),
      candidate_kscore: Number(candidateK),
      base_kscore: Number(baseK),
      choice_id: advisory.choice_id || null,
      run_id: (opts && opts.run_id) || null,
      gamma,
    });
    return {
      recorded: !!(out && out.ok),
      strategy: advisory.recommended,
      posterior: out && out.posterior,
      idempotent_hit: !!(out && out.idempotent_hit),
    };
  } catch (e) {
    return { recorded: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Deploy guardrail. Propose-only by default; --auto gates on the 5 conditions.
// ---------------------------------------------------------------------------
async function _evaluateDeploy({ tenant, namespace, opts, simulate }) {
  const ns = _ns(namespace);
  const auto = !!(opts && opts.auto === true);
  const wantsCompile = !!(simulate && simulate.ok === true && simulate.decision === 'compile');

  const baseArtifactId = (opts && opts.base_artifact_id) || null;
  const candidateArtifactId = (opts && opts.candidate_artifact_id) || null;
  const minDelta = (opts && Number.isFinite(Number(opts.min_kscore_delta))) ? Number(opts.min_kscore_delta) : 0.02;
  const maxReg = (opts && Number.isFinite(Number(opts.max_regression_classes))) ? Number(opts.max_regression_classes) : 0;

  // W921 - ADDITIVE guardrail signals the deploy gate can consult. Both are
  // advisory by default (attached to the envelope, never block) and become
  // fail-closed conditions only under the explicit opt-in flags
  // (enforce_sequential / enforce_conformal). With neither an ab_test_id nor a
  // candidate interval, both are N/A and the deploy path is unchanged.
  const sequential = await _sequentialAdvisory({ tenant, opts });
  const conformal = _conformalAdvisory({ opts });

  // PROPOSE-ONLY DEFAULT. Never executes a deploy. A compile-worthy candidate
  // writes/refreshes a DEPLOY_PROPOSED row so a later --auto tick can start its
  // 48h grace clock from this timestamp.
  if (!auto) {
    if (wantsCompile) {
      await _writeAutopilotEvent({
        tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.PROPOSED,
        feedback: {
          proposed_at: _isoNow(), mode: 'propose_only',
          simulate_decision: simulate.decision, delta_k: simulate.delta_k,
          candidate_artifact_id: candidateArtifactId, base_artifact_id: baseArtifactId,
          version: LIFECYCLE_VERSION,
        },
      });
      return {
        mode: 'propose_only', decision: 'propose', deploy_event: DEPLOY_WORKFLOW.PROPOSED,
        executed: false, reason: 'propose_only_default',
        sequential, conformal, version: LIFECYCLE_VERSION,
      };
    }
    return {
      mode: 'propose_only', decision: 'skip', executed: false,
      reason: 'simulator_skip', sequential, conformal, version: LIFECYCLE_VERSION,
    };
  }

  // --auto path. Evaluate the 5 conditions.
  const conditions = {};
  const failed = [];

  // (1)+(2) compareAndDecide ⇒ promote + regressions bound. base_kscore /
  // candidate_kscore overrides (when supplied) let the gate run without a real
  // .kolm on disk - the tested decision logic is unchanged.
  let compare = null;
  if (candidateArtifactId && baseArtifactId) {
    compare = await compareAndDecide({
      tenant_id: tenant,
      base_artifact_id: baseArtifactId,
      candidate_artifact_id: candidateArtifactId,
      base_kscore: (opts && Number.isFinite(Number(opts.base_kscore))) ? Number(opts.base_kscore) : undefined,
      candidate_kscore: (opts && Number.isFinite(Number(opts.candidate_kscore))) ? Number(opts.candidate_kscore) : undefined,
      gate: { min_kscore_delta: minDelta, max_regression_classes: maxReg, auto_promote: false },
    });
    conditions.promote = !!(compare && compare.ok === true && compare.decision === 'promote');
    conditions.regressions_ok = !!(compare && compare.ok === true && Array.isArray(compare.regressions) && compare.regressions.length <= maxReg);
  } else {
    conditions.promote = false;
    conditions.regressions_ok = false;
  }
  if (!conditions.promote) failed.push('not_promote');
  if (!conditions.regressions_ok) failed.push('regressions');

  // (3) adversarial + safety eval pass - fail-closed unless explicitly asserted.
  conditions.eval_pass = !!(opts && opts.eval_pass === true);
  if (!conditions.eval_pass) failed.push('eval');

  // (4) W813 drift green.
  const drift = await _isDriftRed({ tenant, namespace: ns });
  conditions.drift_green = !drift.red;
  if (!conditions.drift_green) failed.push('drift_red');

  // (5) 48h grace since DEPLOY_PROPOSED with no DEPLOY_OBJECTED after it.
  const proposedRow = await _readLatestAutopilotEvent({ tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.PROPOSED });
  const objectedRow = await _readLatestAutopilotEvent({ tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.OBJECTED });
  let grace = { satisfied: false, proposed: false };
  if (proposedRow) {
    const proposedAt = _eventTs(proposedRow);
    const elapsed = Date.now() - proposedAt;
    const objectedAfter = !!(objectedRow && _eventTs(objectedRow) >= proposedAt);
    grace = {
      proposed: true,
      proposed_at: new Date(proposedAt).toISOString(),
      elapsed_h: Number((elapsed / 3.6e6).toFixed(2)),
      grace_h: 48,
      remaining_h: Math.max(0, Number(((GRACE_MS - elapsed) / 3.6e6).toFixed(2))),
      objected: objectedAfter,
      satisfied: elapsed >= GRACE_MS && !objectedAfter,
    };
  }
  conditions.grace = grace.satisfied;
  if (!conditions.grace) failed.push('grace');

  // (6) W921 OPT-IN - always-valid sequential A/B promote. Off by default
  // (enforce_sequential!==true) so existing deploy behavior is unchanged. When
  // enabled AND an ab_test_id is in scope, EXECUTE additionally requires the
  // anytime-valid gate to say 'promote'; absent an ab_test_id the condition is
  // N/A (true) so the K-delta path for no-A/B-traffic is preserved.
  // W921 NOW-4: close the peeking hole. When a REAL A/B test is in scope
  // (sequential.applicable - an ab_test_id with enough samples), the fixed-
  // horizon K-delta decision is statistically invalid under continuous cron
  // peeking, so EXECUTE now REQUIRES the anytime-valid (mSPRT/GAVI) gate to say
  // 'promote' BY DEFAULT. Operators can opt out with enforce_sequential===false.
  // Absent a real A/B test the condition is N/A (true), preserving the K-delta
  // path for no-A/B-traffic deploys. This only ever makes autonomous deploy MORE
  // conservative (it blocks promotions the peeking-naive test would wrongly pass).
  const _seqGated = (opts && opts.enforce_sequential === false)
    ? false
    : (sequential.applicable || (opts && opts.enforce_sequential === true));
  if (_seqGated) {
    conditions.sequential_promote = (!sequential.applicable)
      ? true
      : sequential.decision === 'promote';
    if (!conditions.sequential_promote) failed.push('sequential');
  }

  // (7) W921 OPT-IN - conformal lower bound clears the ship gate. Off by default
  // (enforce_conformal!==true). When enabled AND a candidate interval is in
  // scope, EXECUTE additionally requires the conformal LOWER bound >= ship gate
  // (deploy on the certified floor, not the point estimate); absent a candidate
  // interval the condition is N/A (true).
  if (opts && opts.enforce_conformal === true) {
    conditions.conformal_clears_gate = (!conformal.applicable)
      ? true
      : conformal.clears_gate === true;
    if (!conditions.conformal_clears_gate) failed.push('conformal_below_gate');
  }

  // No proposal yet: the --auto path PROPOSES first (starts the clock), it does
  // not execute on the same tick it first sees a candidate.
  if (!proposedRow) {
    if (wantsCompile) {
      await _writeAutopilotEvent({
        tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.PROPOSED,
        feedback: {
          proposed_at: _isoNow(), mode: 'auto',
          simulate_decision: simulate.decision, delta_k: simulate.delta_k,
          candidate_artifact_id: candidateArtifactId, base_artifact_id: baseArtifactId,
          version: LIFECYCLE_VERSION,
        },
      });
      return {
        mode: 'auto', decision: 'propose', deploy_event: DEPLOY_WORKFLOW.PROPOSED,
        executed: false, reason: 'grace_started', conditions, grace,
        sequential, conformal, version: LIFECYCLE_VERSION,
      };
    }
    return {
      mode: 'auto', decision: 'skip', executed: false, reason: 'simulator_skip',
      conditions, grace, sequential, conformal, version: LIFECYCLE_VERSION,
    };
  }

  // All conditions hold: EXECUTE via the tested compareAndDecide promote path
  // (auto_promote:true writes the registry receipt). This is the only deploy
  // code path.
  if (failed.length === 0) {
    const promote = await compareAndDecide({
      tenant_id: tenant,
      base_artifact_id: baseArtifactId,
      candidate_artifact_id: candidateArtifactId,
      base_kscore: (opts && Number.isFinite(Number(opts.base_kscore))) ? Number(opts.base_kscore) : undefined,
      candidate_kscore: (opts && Number.isFinite(Number(opts.candidate_kscore))) ? Number(opts.candidate_kscore) : undefined,
      gate: { min_kscore_delta: minDelta, max_regression_classes: maxReg, auto_promote: true },
    });
    await _writeAutopilotEvent({
      tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.EXECUTED,
      feedback: {
        executed_at: _isoNow(), promote_envelope: promote,
        candidate_artifact_id: candidateArtifactId, base_artifact_id: baseArtifactId,
        version: LIFECYCLE_VERSION,
      },
    });
    return {
      mode: 'auto', decision: 'execute', deploy_event: DEPLOY_WORKFLOW.EXECUTED,
      executed: true, conditions, grace, promote,
      sequential, conformal, version: LIFECYCLE_VERSION,
    };
  }

  // Proposal exists but a condition is unmet: HOLD in grace. Write a grace
  // marker so the status surface shows what we are waiting on.
  await _writeAutopilotEvent({
    tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.GRACE,
    feedback: { waiting_at: _isoNow(), failed_conditions: failed, grace, version: LIFECYCLE_VERSION },
  });
  return {
    mode: 'auto', decision: 'hold', deploy_event: DEPLOY_WORKFLOW.GRACE,
    executed: false, conditions, grace, failed_conditions: failed,
    sequential, conformal, version: LIFECYCLE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// objectToDeploy - a human (or a guard) vetoes a proposed deploy. Writes a
// DEPLOY_OBJECTED row; the next --auto tick's grace check sees it and holds.
// ---------------------------------------------------------------------------
export async function objectToDeploy({ tenant, namespace, reason } = {}) {
  if (!tenant || typeof tenant !== 'string') {
    return { ok: false, error: 'missing_tenant_id', version: LIFECYCLE_VERSION };
  }
  const ns = _ns(namespace);
  const write = await _writeAutopilotEvent({
    tenant, namespace: ns, workflow: DEPLOY_WORKFLOW.OBJECTED,
    feedback: { objected_at: _isoNow(), reason: String(reason || 'unspecified').slice(0, 500), version: LIFECYCLE_VERSION },
  });
  return { ok: true, namespace: ns, persisted: write.persisted, version: LIFECYCLE_VERSION };
}

// ---------------------------------------------------------------------------
// tickAutopilotFull - the full lifecycle tick.
// ---------------------------------------------------------------------------
export async function tickAutopilotFull({ tenant, namespace, opts = {} } = {}) {
  if (!tenant || typeof tenant !== 'string') {
    return { ok: false, error: 'missing_tenant_id', version: LIFECYCLE_VERSION };
  }
  const ns = _ns(namespace);
  const o = opts || {};

  // 0. Optional bootstrap from a description.
  let bootstrap = null;
  if (o.describe && typeof o.describe === 'string' && o.describe.trim()) {
    try {
      const mod = await import('./autopilot-bootstrap.js');
      bootstrap = await mod.bootstrapFromDescription({
        tenant, namespace: ns, description: o.describe, budget_usd: o.budget_usd,
      });
    } catch (e) {
      bootstrap = { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 1. W775 heartbeat (tested path, unchanged).
  let heartbeat;
  try {
    heartbeat = await tickAutopilot({ tenant, namespace: ns, opts: o });
  } catch (e) {
    heartbeat = { ok: false, action: 'error', error: String((e && e.message) || e), version: AUTOPILOT_VERSION };
  }

  // 2. Current feature vector. opts.features (a full curate-derived vector)
  // wins; otherwise derive what we can from raw-pairs.
  const features = (o.features && typeof o.features === 'object' && !Array.isArray(o.features))
    ? o.features
    : _deriveFeatures(await _safeRawPairs(ns));

  // 3. ② Cost Optimizer - rank strategies under budget.
  let plan;
  try {
    plan = await rankStrategies({
      tenant, namespace: ns,
      budget_usd: _budgetUsd(o.budget_usd),
      target_kscore: o.target_kscore,
      current_features: features,
      teacher_spec: o.teacher_spec,
    });
  } catch (e) {
    plan = { ok: false, error: String((e && e.message) || e) };
  }

  // 3b. W921 - bandit strategy-ranking advisory (ADDITIVE, opt-in via
  // opts.use_bandit). Warm-started from the greedy plan so n=0 == greedy. This
  // is a SECOND opinion only; plan.recommended (the simulator input below) is
  // unchanged unless opts.bandit_decides === true.
  const baseK = (plan && plan.ok === true && Number.isFinite(Number(plan.current_k)))
    ? Number(plan.current_k) : null;
  const bandit = await _banditAdvisory({
    tenant, namespace: ns, opts: o, plan, baseK, baseFeatures: features,
  });

  // 4. ④ Compile Simulator - should we compile the recommended move?
  // Default: the greedy cost-optimizer's recommended strategy. The bandit pick
  // is consulted ONLY when the operator explicitly opts in (bandit_decides), and
  // even then we never recommend a move the bandit's advisory could not produce.
  const greedyRecommended = (plan && plan.ok === true && plan.recommended) ? plan.recommended : null;
  const recommended = (o.use_bandit === true && o.bandit_decides === true && bandit && bandit.recommended)
    ? bandit.recommended
    : greedyRecommended;
  const proposedDelta = (recommended && STRATEGIES[recommended] && STRATEGIES[recommended].delta) || {};
  let simulate;
  try {
    simulate = await simulateCompile({
      tenant, namespace: ns,
      current_features: features,
      proposed_delta: proposedDelta,
      min_delta_k: o.min_delta_k,
    });
  } catch (e) {
    simulate = { ok: false, error: String((e && e.message) || e) };
  }

  // 5. ⑥ Temporal coverage (advisory - informs WHICH data to acquire next).
  let temporal = null;
  if (o.skip_temporal !== true) {
    try {
      const mod = await import('./temporal-analyzer.js');
      temporal = await mod.analyzeTemporalCoverage({
        tenant, namespace: ns,
        window_days: Number.isFinite(Number(o.temporal_window_days)) ? Number(o.temporal_window_days) : 30,
      });
    } catch (e) {
      temporal = { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 6. ③ Failure Analyst - only when an eval artifact is supplied.
  let failure = null;
  if (o.eval_path || o.run_dir) {
    try {
      const mod = await import('./failure-analyst.js');
      failure = await mod.analyzeFailures({
        tenant, namespace: ns,
        eval_path: o.eval_path, run_dir: o.run_dir, teacher_base: o.teacher_base,
      });
    } catch (e) {
      failure = { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 7. ⑧ Deploy guardrail (propose-only default).
  const deploy_decision = await _evaluateDeploy({ tenant, namespace: ns, opts: o, simulate });

  // 8. ⑦ Flywheel - record a K point when a fresh candidate K is known and the
  // caller asked us to (record_kscore:true). The chart on namespaces.html reads
  // these via GET /v1/kscore/series.
  let kscore_recorded = null;
  const freshK = (simulate && simulate.ok === true) ? simulate.k_proposed : null;
  if (o.record_kscore === true && Number.isFinite(Number(freshK))) {
    try {
      const mod = await import('./kscore-timeseries.js');
      kscore_recorded = await mod.recordKScore({
        tenant, namespace: ns, kscore: Number(freshK),
        artifact_id: o.candidate_artifact_id || null,
        run_id: (heartbeat && heartbeat.run_id) || null,
      });
    } catch (e) {
      kscore_recorded = { ok: false, error: String((e && e.message) || e) };
    }
  }

  // 8b. W921 - bandit OBSERVE leg. When the bandit is in use AND a REALIZED
  // candidate K is supplied (opts.candidate_kscore - the realized post-distill K,
  // NOT the simulator's predicted K), fold ΔK = candidate_K - base_K into the
  // discounted posterior so the next tick learns which strategy actually paid
  // off. Additive + best-effort; the loop closes only when the caller hands us a
  // realized reward. Absent that, this is a no-op.
  let bandit_observe = null;
  if (o.use_bandit === true && bandit && bandit.applicable === true) {
    const realizedK = Number.isFinite(Number(o.candidate_kscore)) ? Number(o.candidate_kscore) : null;
    if (realizedK != null && baseK != null) {
      bandit_observe = await _banditObserve({
        tenant, namespace: ns, opts: o, advisory: bandit, baseK, candidateK: realizedK,
      });
    } else {
      bandit_observe = { recorded: false, reason: 'no_realized_candidate_k' };
    }
  }

  // Optional weekly digest row (email cron consumes provider kolm_autopilot_digest).
  if (o.digest === true) {
    try {
      await _writeAutopilotEvent({
        tenant, namespace: ns, workflow: 'autopilot:digest',
        feedback: {
          digested_at: _isoNow(),
          action: heartbeat && heartbeat.action,
          recommended,
          simulate_decision: simulate && simulate.decision,
          deploy_decision: deploy_decision && deploy_decision.decision,
          current_k: plan && plan.current_k,
          version: LIFECYCLE_VERSION,
        },
      });
    } catch (_) { /* best-effort */ }
  }

  return {
    // W775 heartbeat envelope spread first (ok, action, namespace, version:w775-*).
    ...heartbeat,
    lifecycle_version: LIFECYCLE_VERSION,
    bootstrap,
    features,
    plan,
    simulate_decision: simulate,
    temporal,
    failure,
    deploy_decision,
    kscore_recorded,
    // W921 - additive bandit advisory + OBSERVE result (null unless opts.use_bandit).
    bandit,
    bandit_observe,
  };
}

export const __internals = Object.freeze({
  _deriveFeatures,
  _evaluateDeploy,
  _eventTs,
  _budgetUsd,
  DEPLOY_WORKFLOW,
  GRACE_MS,
  STRATEGIES,
  // W921 additive advisories.
  _sequentialAdvisory,
  _conformalAdvisory,
  SHIP_GATE,
  // W921 additive bandit advisory + OBSERVE leg.
  _banditAdvisory,
  _banditObserve,
});

export default {
  LIFECYCLE_VERSION,
  DEPLOY_WORKFLOW,
  tickAutopilotFull,
  objectToDeploy,
  __internals,
};
