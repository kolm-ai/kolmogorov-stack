// W775+ — Full Autopilot Mode (the capstone).
//
// tickAutopilotFull layers the autopilot intelligence components on top of the
// W775 heartbeat (src/autopilot-daemon.js tickAutopilot, the tested path) and
// adds the propose-only-default auto-deploy guardrail.
//
// One full tick:
//   0. (optional) bootstrapFromDescription — seed corpus + recipe from a phrase.
//   1. W775 heartbeat (tickAutopilot) — unchanged: WATCH (W815 gaps) + drift gate.
//   2. derive the current data feature vector from raw-pairs.jsonl.
//   3. ② Cost Optimizer  — rankStrategies under budget  -> plan.
//   4. ④ Compile Simulator — simulateCompile on the recommended move -> compile|skip.
//   5. ⑥ Temporal Analyzer — seasonal/temporal coverage gaps (advisory).
//   6. ③ Failure Analyst  — only when an eval artifact is supplied.
//   7. ⑧ Deploy guardrail — propose-only by default; --auto gates on 5 conditions.
//   8. ⑦ Flywheel — record a K-Score point when a fresh candidate K is known.
//
// Returns the W775 envelope (ok, action, namespace, version:w775-*) PLUS
// {plan, simulate_decision, deploy_decision, temporal, failure, features,
//  bootstrap, kscore_recorded, lifecycle_version}.
//
// AUTO-DEPLOY GUARDRAIL (high blast radius — explicit):
//   Default is PROPOSE-ONLY: a compile-worthy candidate writes a
//   DEPLOY_PROPOSED ledger row and stops. opts.auto===true is the ONLY path to
//   an autonomous deploy, and a deploy (DEPLOY_EXECUTED) fires ONLY when ALL of
//   these hold:
//     (1) compareAndDecide ⇒ 'promote' (K ≥ base + min_kscore_delta)
//     (2) regressions ≤ max_regression_classes (default 0)
//     (3) adversarial + safety eval pass (opts.eval_pass === true)
//     (4) W813 drift gate green
//     (5) 48h grace elapsed since DEPLOY_PROPOSED with no DEPLOY_OBJECTED
//   Grace is derived from the proposed-row timestamp (cron re-evaluates — no
//   long-lived process). The execute path reuses compareAndDecide's tested
//   promote/rollback receipt write — never a second deploy code path.

import {
  tickAutopilot,
  AUTOPILOT_VERSION,
  __internals as daemonInternals,
} from './autopilot-daemon.js';
import { rankStrategies, __internals as costInternals } from './cost-optimizer.js';
import { simulateCompile } from './compile-simulator.js';
import { compareAndDecide } from './improvement-orchestrator.js';

export const LIFECYCLE_VERSION = 'apl-v1';

// Reuse the daemon's tenant-fenced event-store helpers — ONE shared write/read
// path (risk #4: no per-component persistence sprawl).
const _writeAutopilotEvent = daemonInternals._writeAutopilotEvent;
const _readLatestAutopilotEvent = daemonInternals._readLatestAutopilotEvent;
const _isDriftRed = daemonInternals._isDriftRed;

// Strategy feature-delta priors — maps a recommended strategy name back to the
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

function _ns(namespace) {
  return String(namespace || 'default').slice(0, 128);
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

// Read raw-pairs for a namespace without throwing — a cold namespace yields [].
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

// Derive the predictor's recognized feature vector from raw-pairs alone — cheap
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
        executed: false, reason: 'propose_only_default', version: LIFECYCLE_VERSION,
      };
    }
    return {
      mode: 'propose_only', decision: 'skip', executed: false,
      reason: 'simulator_skip', version: LIFECYCLE_VERSION,
    };
  }

  // --auto path. Evaluate the 5 conditions.
  const conditions = {};
  const failed = [];

  // (1)+(2) compareAndDecide ⇒ promote + regressions bound. base_kscore /
  // candidate_kscore overrides (when supplied) let the gate run without a real
  // .kolm on disk — the tested decision logic is unchanged.
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

  // (3) adversarial + safety eval pass — fail-closed unless explicitly asserted.
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
        executed: false, reason: 'grace_started', conditions, grace, version: LIFECYCLE_VERSION,
      };
    }
    return {
      mode: 'auto', decision: 'skip', executed: false, reason: 'simulator_skip',
      conditions, grace, version: LIFECYCLE_VERSION,
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
      executed: true, conditions, grace, promote, version: LIFECYCLE_VERSION,
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
    executed: false, conditions, grace, failed_conditions: failed, version: LIFECYCLE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// objectToDeploy — a human (or a guard) vetoes a proposed deploy. Writes a
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
// tickAutopilotFull — the full lifecycle tick.
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

  // 3. ② Cost Optimizer — rank strategies under budget.
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

  // 4. ④ Compile Simulator — should we compile the recommended move?
  const recommended = (plan && plan.ok === true && plan.recommended) ? plan.recommended : null;
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

  // 5. ⑥ Temporal coverage (advisory — informs WHICH data to acquire next).
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

  // 6. ③ Failure Analyst — only when an eval artifact is supplied.
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

  // 8. ⑦ Flywheel — record a K point when a fresh candidate K is known and the
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
});

export default {
  LIFECYCLE_VERSION,
  DEPLOY_WORKFLOW,
  tickAutopilotFull,
  objectToDeploy,
  __internals,
};
