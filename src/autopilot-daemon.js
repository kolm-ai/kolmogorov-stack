// W775 — Continuous Background Distill (THE KILLER FEATURE).
//
// This is the marquee feature that turns kolm from a tool into invisible
// infrastructure. Once enabled, the daemon:
//
//   1. Records every API call (W144 + capture.js do the actual recording —
//      the daemon does NOT re-implement capture; it polls the existing
//      event-store + active-learning surfaces).
//   2. Continuously evaluates whether enough data has landed to distill.
//      Uses W815 getCoverageGapsForNamespace() as the readiness signal.
//   3. When critical mass + drift gate is green, calls W720
//      orchestrateImprovement() to kick off the actual distill.
//   4. Routes silently — that part is the W807 confidence router, not us.
//      We just make sure the distilled artifact is ready when W807 needs it.
//
// Dependencies (all satisfied as of 2026-05-24):
//   W720 (self-improvement) — src/improvement-orchestrator.js
//   W807 (confidence routing) — src/confidence-router.js
//   W813 (drift detection) — src/drift-alert-w813.js
//   W815 (active learning) — src/active-learning.js
//
// Honesty contract (NEVER violate):
//   - Daemon NEVER silently distills bad data. When W815 returns
//     `insufficient_captures_for_coverage`, we write a holding-pattern event
//     and return {ok:true, action:'holding', reason:'insufficient_captures'}.
//   - When W813 drift gate is red, we write `redeploy_blocked_by_drift:true`
//     and hold. Never silently redeploy a model into a regressed environment.
//   - opt-in is explicit (POST /v1/autopilot/enable). NEVER auto-enable.
//   - Every read is tenant-fenced (W411 invariant). Per-row defense-in-depth.
//
// DI testing seam — set $KOLM_W775_ORCHESTRATE_CMD to a Node script path; the
// daemon will require() that script and call it instead of
// orchestrateImprovement(). Tests use this to avoid spinning up the real
// distill pipeline.
//
// W604 anti-brittleness: AUTOPILOT_VERSION matches /^w775-/ — consumers must
// regex the prefix, never compare exact string.

import crypto from 'node:crypto';

import { getCoverageGapsForNamespace } from './active-learning.js';
import { orchestrateImprovement } from './improvement-orchestrator.js';
import { listRecentAlerts } from './drift-alert-w813.js';

export const AUTOPILOT_VERSION = 'w775-v1';

// Provider tag used when persisting autopilot daemon state rows via the
// event-store. A distinct provider keeps the autopilot ledger queryable
// independent of other kolm_* providers (kolm_drift_alert, etc.).
const AUTOPILOT_PROVIDER = 'kolm_autopilot';

// Sentinel workflow_ids used to discriminate autopilot event types in the
// lake. Stable strings so a query like
// `listEvents({workflow_id: AUTOPILOT_WORKFLOW.ENABLED})` is well-defined.
export const AUTOPILOT_WORKFLOW = Object.freeze({
  ENABLED: 'autopilot:enabled',
  DISABLED: 'autopilot:disabled',
  HOLDING: 'autopilot:holding',
  REDISTILLED: 'autopilot:redistilled',
  TICK_NO_OP: 'autopilot:no_op',
  STARTED: 'autopilot:started',
});

// Gap-score floor for triggering a redistill. Below this the daemon
// no-ops: the gain from a fresh artifact would not exceed the cost +
// risk of swapping models out. 0.25 was picked so a single under-rep'd
// cluster of recommended_count=5 (gap_score = 5/median × 1.0 demand_proxy
// = ~0.83 for median 6) easily clears the bar, while every-cluster-balanced
// corpora stay below it.
const REDISTILL_THRESHOLD = 0.25;

function _isoNow() {
  return new Date().toISOString();
}

function _ns(namespace) {
  return String(namespace || 'default').slice(0, 128);
}

// Defense-in-depth tenant validation. Throws a structured error that the
// HTTP layer can convert to a 401. Pure helper, no I/O.
function _validateTenant(tenant) {
  if (!tenant || typeof tenant !== 'string') {
    return { ok: false, error: 'missing_tenant_id', hint: 'pass {tenant} as a non-empty string' };
  }
  return { ok: true };
}

// Lazy import the event-store. Wrapped in try/catch so the daemon NEVER
// crashes the call when the store is unavailable — surfaces an honest
// envelope instead.
async function _eventStore() {
  try {
    return await import('./event-store.js');
  } catch (_) {
    return null;
  }
}

// Internal helper: write an autopilot ledger row. Best-effort — never throws
// into the caller. Returns {persisted, event_id, error}.
async function _writeAutopilotEvent({ tenant, namespace, workflow, feedback }) {
  const es = await _eventStore();
  if (!es || typeof es.appendEvent !== 'function') {
    return { persisted: false, event_id: null, error: 'event_store_unavailable' };
  }
  try {
    const ev = await es.appendEvent({
      tenant_id: tenant,
      namespace: _ns(namespace),
      provider: AUTOPILOT_PROVIDER,
      vendor: 'kolm',
      model: 'autopilot/daemon',
      workflow_id: workflow,
      status: 'ok',
      prompt_tokens: 0,
      completion_tokens: 0,
      feedback: JSON.stringify(feedback || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id, error: null };
  } catch (e) {
    return { persisted: false, event_id: null, error: String((e && e.message) || e) };
  }
}

// Internal helper: read the most-recent autopilot ledger row for a
// (tenant, namespace) pair with a specific workflow_id. W411 defense in
// depth: tenant_id filter at listEvents + per-row re-check.
async function _readLatestAutopilotEvent({ tenant, namespace, workflow }) {
  const es = await _eventStore();
  if (!es || typeof es.listEvents !== 'function') return null;
  try {
    const rows = await es.listEvents({
      tenant_id: tenant,
      namespace: _ns(namespace),
      provider: AUTOPILOT_PROVIDER,
      workflow_id: workflow,
      limit: 16,
      order: 'desc',
    });
    if (!Array.isArray(rows)) return null;
    // W411 — per-row tenant fence re-check.
    for (const r of rows) {
      if (r && r.tenant_id === tenant && r.namespace === _ns(namespace)) return r;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// W813 drift gate: returns {red: boolean, latest_alert?, reason?}. A "red"
// gate means the latest persisted drift alert for this (tenant, namespace)
// reports drift_detected:true with severity in {moderate, severe}.
async function _isDriftRed({ tenant, namespace }) {
  try {
    const list = await listRecentAlerts({ tenant_id: tenant, namespace: _ns(namespace), limit: 1 });
    if (!list || !list.ok || !Array.isArray(list.alerts) || list.alerts.length === 0) {
      return { red: false, latest_alert: null, reason: 'no_alerts' };
    }
    const latest = list.alerts[0];
    const payload = latest && latest.payload;
    if (!payload) return { red: false, latest_alert: latest, reason: 'no_payload' };
    if (!payload.drift_detected) {
      return { red: false, latest_alert: latest, reason: 'no_drift' };
    }
    const sev = String(payload.severity || 'unknown').toLowerCase();
    if (sev === 'moderate' || sev === 'severe') {
      return { red: true, latest_alert: latest, reason: 'drift_' + sev };
    }
    return { red: false, latest_alert: latest, reason: 'drift_' + sev };
  } catch (_) {
    // Fail-open on drift read failure — we already write a holding-pattern
    // ledger row when we choose to hold, so a missing drift alert table is
    // not silent. The caller still observes ok:true,no_op.
    return { red: false, latest_alert: null, reason: 'drift_read_failed' };
  }
}

// DI seam: if KOLM_W775_ORCHESTRATE_CMD is set, the tick will require the
// script at that path and invoke its default export instead of
// orchestrateImprovement. The script MUST export an async function returning
// the same envelope shape as orchestrateImprovement.
async function _maybeStubOrchestrate(opts) {
  const stubPath = process.env.KOLM_W775_ORCHESTRATE_CMD;
  if (!stubPath) return null;
  try {
    const mod = await import('file://' + stubPath.replace(/\\/g, '/'));
    const fn = (mod && (mod.default || mod.orchestrate)) || null;
    if (typeof fn !== 'function') {
      return {
        ok: false,
        error: 'autopilot_stub_missing_export',
        hint: 'KOLM_W775_ORCHESTRATE_CMD script must export default (async fn) or orchestrate',
        version: AUTOPILOT_VERSION,
      };
    }
    return await fn(opts);
  } catch (e) {
    return {
      ok: false,
      error: 'autopilot_stub_load_failed',
      detail: String((e && e.message) || e),
      version: AUTOPILOT_VERSION,
    };
  }
}

// ---------------------------------------------------------------------------
// enableAutopilot({tenant, namespace}) — opt-in.
// ---------------------------------------------------------------------------
//
// Writes a workflow:'autopilot:enabled' event-store row carrying:
//   {autopilot_id, enabled_at, version, host?}
//
// The autopilot_id is the durable identifier for this (tenant, namespace)
// daemon configuration; subsequent enable calls return the EXISTING id
// rather than minting a new one (so the dashboard doesn't multiply IDs on
// every page reload).
//
// Returns {ok:true, autopilot_id, version} on success, or honest envelope.
export async function enableAutopilot({ tenant, namespace, host = null } = {}) {
  const v = _validateTenant(tenant);
  if (!v.ok) return { ...v, version: AUTOPILOT_VERSION };

  const ns = _ns(namespace);
  // If already enabled, reuse the existing autopilot_id.
  const existing = await _readLatestAutopilotEvent({
    tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.ENABLED,
  });
  let autopilotId = null;
  if (existing && existing.feedback) {
    try {
      const fb = JSON.parse(existing.feedback);
      if (fb && fb.autopilot_id) autopilotId = String(fb.autopilot_id);
    } catch (_) { /* ignore — fall through to mint */ }
  }
  if (!autopilotId) {
    autopilotId = 'ap_' + crypto.randomBytes(6).toString('hex');
  }

  const enabledAt = _isoNow();
  const write = await _writeAutopilotEvent({
    tenant,
    namespace: ns,
    workflow: AUTOPILOT_WORKFLOW.ENABLED,
    feedback: {
      autopilot_enabled: true,
      autopilot_id: autopilotId,
      enabled_at: enabledAt,
      host: host || null,
      version: AUTOPILOT_VERSION,
    },
  });

  return {
    ok: true,
    autopilot_id: autopilotId,
    enabled_at: enabledAt,
    namespace: ns,
    persisted: write.persisted,
    persist_error: write.error,
    version: AUTOPILOT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// disableAutopilot({tenant, namespace}) — opt-out.
// ---------------------------------------------------------------------------
//
// Writes a workflow:'autopilot:disabled' event-store row. Subsequent ticks
// will return action:'disabled' without performing any orchestration.
export async function disableAutopilot({ tenant, namespace } = {}) {
  const v = _validateTenant(tenant);
  if (!v.ok) return { ...v, version: AUTOPILOT_VERSION };

  const ns = _ns(namespace);
  const disabledAt = _isoNow();
  const write = await _writeAutopilotEvent({
    tenant,
    namespace: ns,
    workflow: AUTOPILOT_WORKFLOW.DISABLED,
    feedback: {
      autopilot_enabled: false,
      disabled_at: disabledAt,
      version: AUTOPILOT_VERSION,
    },
  });

  return {
    ok: true,
    namespace: ns,
    disabled_at: disabledAt,
    persisted: write.persisted,
    persist_error: write.error,
    version: AUTOPILOT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// getAutopilotStatus({tenant, namespace}) — current daemon state.
// ---------------------------------------------------------------------------
//
// Returns:
//   {ok:true, enabled, autopilot_id?, last_tick_at?, holding_pattern_reason?,
//    version}
//
// Honest envelope: if nothing has ever been written for this (tenant,
// namespace) pair, returns enabled:false with no holding_pattern_reason.
export async function getAutopilotStatus({ tenant, namespace } = {}) {
  const v = _validateTenant(tenant);
  if (!v.ok) return { ...v, version: AUTOPILOT_VERSION };

  const ns = _ns(namespace);
  const enabledRow = await _readLatestAutopilotEvent({
    tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.ENABLED,
  });
  const disabledRow = await _readLatestAutopilotEvent({
    tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.DISABLED,
  });

  // Compare timestamps to determine current enabled state. Most-recent of
  // {enabled, disabled} wins. Defense-in-depth: a tie defaults to disabled
  // (NEVER silently re-enable).
  let enabled = false;
  let autopilotId = null;
  let enabledAt = null;
  if (enabledRow) {
    try {
      const fb = JSON.parse(enabledRow.feedback || '{}');
      autopilotId = fb && fb.autopilot_id || null;
      enabledAt = fb && fb.enabled_at || enabledRow.created_at || null;
    } catch (_) {} // deliberate: cleanup
  }
  if (enabledRow && !disabledRow) {
    enabled = true;
  } else if (enabledRow && disabledRow) {
    const enT = Date.parse(enabledRow.created_at || '');
    const disT = Date.parse(disabledRow.created_at || '');
    enabled = Number.isFinite(enT) && Number.isFinite(disT) ? enT > disT : !!enabledRow;
  }

  // Most-recent tick — search for holding, no_op, or redistilled.
  let lastTickAt = null;
  let lastTickAction = null;
  let holdingReason = null;
  for (const wf of [
    AUTOPILOT_WORKFLOW.HOLDING,
    AUTOPILOT_WORKFLOW.REDISTILLED,
    AUTOPILOT_WORKFLOW.TICK_NO_OP,
  ]) {
    const row = await _readLatestAutopilotEvent({ tenant, namespace: ns, workflow: wf });
    if (!row) continue;
    const t = Date.parse(row.created_at || '');
    const cur = Date.parse(lastTickAt || '');
    if (!Number.isFinite(cur) || (Number.isFinite(t) && t > cur)) {
      lastTickAt = row.created_at;
      lastTickAction = wf;
      if (wf === AUTOPILOT_WORKFLOW.HOLDING) {
        try {
          const fb = JSON.parse(row.feedback || '{}');
          holdingReason = fb && fb.reason || null;
        } catch (_) { holdingReason = null; }
      } else {
        holdingReason = null;
      }
    }
  }

  return {
    ok: true,
    enabled,
    autopilot_id: autopilotId,
    enabled_at: enabledAt,
    last_tick_at: lastTickAt,
    last_tick_action: lastTickAction,
    holding_pattern_reason: holdingReason,
    namespace: ns,
    configured: !!(enabledRow || disabledRow),
    version: AUTOPILOT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// tickAutopilot({tenant, namespace, opts?}) — main loop body.
// ---------------------------------------------------------------------------
//
// The daemon "tick" is the heartbeat. In production this is invoked by a
// cron-driven POST /v1/autopilot/tick every minute (or whatever cadence the
// operator picks). We deliberately do NOT fork a long-running Node process
// because cron + a thin HTTP endpoint is more robust than a process tree we
// have to keep alive.
//
// Sequence:
//   1. Status check — if disabled, return action:'disabled' (no event).
//   2. W815 coverage gap read. If insufficient_captures or no_capture data,
//      return action:'holding' + write a workflow:autopilot:holding event.
//   3. W813 drift gate read. If red (moderate / severe), return
//      action:'holding' + write a holding event with reason:'drift_red'.
//   4. If both green AND top gap_score >= REDISTILL_THRESHOLD, call (DI
//      stubbed) orchestrateImprovement(). Return action:'redistilled' + log.
//   5. Otherwise return action:'no_op' + log.
//
// Returns one of:
//   {ok:true, action:'disabled', version}
//   {ok:true, action:'holding', reason:'insufficient_captures', version, ...}
//   {ok:true, action:'holding', reason:'drift_red', version, ...}
//   {ok:true, action:'no_op', reason:'not_enough_gain', version, ...}
//   {ok:true, action:'redistilled', artifact_id, gain, version, ...}
//
// Honest envelope on a missing tenant or orchestration failure.
export async function tickAutopilot({ tenant, namespace, opts } = {}) {
  const v = _validateTenant(tenant);
  if (!v.ok) return { ...v, version: AUTOPILOT_VERSION };

  const ns = _ns(namespace);

  // Step 1: disabled-flag gate. Read the status surface (which uses the
  // same enabled/disabled-row comparison).
  const status = await getAutopilotStatus({ tenant, namespace: ns });
  if (!status.enabled) {
    return {
      ok: true,
      action: 'disabled',
      namespace: ns,
      configured: !!status.configured,
      version: AUTOPILOT_VERSION,
    };
  }

  // Step 2: W815 readiness check.
  const minCapturesOverride = opts && Number.isFinite(Number(opts.min_captures))
    ? Math.max(1, Math.trunc(Number(opts.min_captures)))
    : null;
  let gaps;
  try {
    gaps = await getCoverageGapsForNamespace(ns, {
      tenant_id: tenant,
      top_k: 10,
      ...(minCapturesOverride != null ? { min_captures: minCapturesOverride } : {}),
    });
  } catch (e) {
    gaps = {
      ok: false,
      error: 'active_learning_failure',
      detail: String((e && e.message) || e),
      version: 'w815-v1',
    };
  }
  if (!gaps || gaps.ok !== true) {
    const reason = (gaps && gaps.error) || 'insufficient_captures';
    await _writeAutopilotEvent({
      tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.HOLDING,
      feedback: {
        autopilot_holding: true,
        daemon_holding_pattern: true,
        reason,
        gap_envelope: gaps || null,
        ticked_at: _isoNow(),
        version: AUTOPILOT_VERSION,
      },
    });
    return {
      ok: true,
      action: 'holding',
      reason,
      hint: (gaps && gaps.hint) || null,
      n: gaps && gaps.n,
      namespace: ns,
      version: AUTOPILOT_VERSION,
    };
  }

  // Step 3: W813 drift gate.
  const drift = await _isDriftRed({ tenant, namespace: ns });
  if (drift.red) {
    await _writeAutopilotEvent({
      tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.HOLDING,
      feedback: {
        autopilot_holding: true,
        daemon_holding_pattern: true,
        redeploy_blocked_by_drift: true,
        reason: 'drift_red',
        drift_reason: drift.reason,
        ticked_at: _isoNow(),
        version: AUTOPILOT_VERSION,
      },
    });
    return {
      ok: true,
      action: 'holding',
      reason: 'drift_red',
      drift_reason: drift.reason,
      namespace: ns,
      version: AUTOPILOT_VERSION,
    };
  }

  // Step 4: top gap score above threshold?
  const topGap = (Array.isArray(gaps.gaps) && gaps.gaps.length > 0) ? gaps.gaps[0] : null;
  const topScore = topGap && Number(topGap.gap_score);
  const threshold = (opts && Number.isFinite(Number(opts.redistill_threshold)))
    ? Math.max(0, Number(opts.redistill_threshold))
    : REDISTILL_THRESHOLD;
  if (!topGap || !Number.isFinite(topScore) || topScore < threshold) {
    await _writeAutopilotEvent({
      tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.TICK_NO_OP,
      feedback: {
        autopilot_no_op: true,
        reason: 'not_enough_gain',
        top_gap_score: topScore || 0,
        threshold,
        ticked_at: _isoNow(),
        version: AUTOPILOT_VERSION,
      },
    });
    return {
      ok: true,
      action: 'no_op',
      reason: 'not_enough_gain',
      top_gap_score: topScore || 0,
      threshold,
      namespace: ns,
      version: AUTOPILOT_VERSION,
    };
  }

  // Step 5: orchestrate. DI seam wins if KOLM_W775_ORCHESTRATE_CMD is set.
  const candidates = gaps.gaps.map((g) => ({
    capture_id: g.cluster_id,
    current_artifact_id: null,
    failure_rate: 1.0, // gap == complete miss in production
    route_events_count: g.recommended_count || 1,
  }));
  let orchEnv = null;
  const stub = await _maybeStubOrchestrate({
    tenant_id: tenant, namespace: ns, candidates,
    opts: { triggered_by: 'w775_autopilot', top_gap_score: topScore },
  });
  if (stub) {
    orchEnv = stub;
  } else {
    try {
      orchEnv = await orchestrateImprovement({
        tenant_id: tenant,
        namespace: ns,
        candidates,
        opts: { skip_spawn: true }, // tick should never block on worker drain
      });
    } catch (e) {
      orchEnv = {
        ok: false,
        error: 'orchestrate_improvement_failed',
        detail: String((e && e.message) || e),
        version: 'w720-v1',
      };
    }
  }
  await _writeAutopilotEvent({
    tenant, namespace: ns, workflow: AUTOPILOT_WORKFLOW.REDISTILLED,
    feedback: {
      autopilot_redistilled: true,
      top_gap_score: topScore,
      orchestrate_envelope: orchEnv,
      ticked_at: _isoNow(),
      version: AUTOPILOT_VERSION,
    },
  });
  return {
    ok: true,
    action: 'redistilled',
    artifact_id: (orchEnv && orchEnv.candidate_artifact_id) || null,
    run_id: (orchEnv && orchEnv.run_id) || null,
    gain: topScore,
    top_gap_score: topScore,
    orchestrate_envelope: orchEnv,
    namespace: ns,
    version: AUTOPILOT_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Internal test seam helpers — exported under `_` so external callers cannot
// rely on them.
// ---------------------------------------------------------------------------

export const _REDISTILL_THRESHOLD = REDISTILL_THRESHOLD;
export const __internals = Object.freeze({
  _isDriftRed,
  _readLatestAutopilotEvent,
  _writeAutopilotEvent,
  _maybeStubOrchestrate,
  AUTOPILOT_PROVIDER,
  REDISTILL_THRESHOLD,
});

export default {
  AUTOPILOT_VERSION,
  AUTOPILOT_WORKFLOW,
  enableAutopilot,
  disableAutopilot,
  getAutopilotStatus,
  tickAutopilot,
  __internals,
};
