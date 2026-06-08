// src/ab-router.js
//
// W777 -- A/B testing infrastructure.
//
// Splits traffic deterministically between two artifact versions (arm_a +
// arm_b) for a given (tenant, namespace) and records each outcome under
// workflow_id='w777:ab' on the canonical event-store. The W778 gate reads
// those events back and decides whether arm B has earned a promotion.
//
// Design choices:
//
//  1. Deterministic split via fnv1a(request_hash) % 2. Same request_hash
//     always maps to the same arm so a retried call stays on its arm.
//     "Split" parameter is honored exactly when split === 0.5; we keep the
//     hash bucket for any split value but use bucketing thresholds so a
//     90/10 split still works (we hash to 1000 buckets then compare to
//     floor(split * 1000)).
//
//  2. Test records live in the kolm-store `ab_tests` table (W411 tenant
//     fence: every read uses findByTenant + an inner-loop defense-in-depth
//     tenant check). Outcomes live in the event-store (workflow_id keyed,
//     tenant+namespace columns) so the W778 gate + per-namespace billing
//     all read off the same source of truth.
//
//  3. promoteArm() flips the `promoted_arm` field on the test record and
//     appends a `w777:ab:promotion` event so the audit log + dashboard can
//     replay the promotion timeline. autoRollback() reverse-checks the
//     gate: if arm B previously promoted but the gate now fails AND arm B
//     mean is worse than arm A mean, the promotion is reverted.
//
//  4. assignArm() refuses to assign when no test is active for the
//     (tenant, namespace) pair -- consumers should fall back to their
//     normal routing in that case. Honest envelope, never silent default.
//
// W604 anti-brittleness:
//   - AB_ROUTER_VERSION = 'w777-vN' -- consumers MUST match /^w777-/ NOT
//     literal equality so a v1.x bump within the same wave doesn't break
//     callers.
//   - All numeric tunables are exported defaults.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findByField, insert, update, all as storeAll } from './store.js';
import { appendEvent, listEvents } from './event-store.js';

export const AB_ROUTER_VERSION = 'w777-v1';
export const AB_TESTS_TABLE = 'ab_tests';
export const AB_OUTCOMES_WORKFLOW = 'w777:ab';
export const AB_PROMOTION_WORKFLOW = 'w777:ab:promotion';
export const AB_ROLLBACK_WORKFLOW = 'w777:ab:rollback';
export const DEFAULT_SAMPLE_TARGET = 1000;
export const DEFAULT_SPLIT = 0.5;
export const HASH_BUCKETS = 1000;
export const STATUS = Object.freeze({
  ACTIVE: 'active',
  STOPPED: 'stopped',
  PROMOTED: 'promoted',
  ROLLED_BACK: 'rolled_back',
});

// =============================================================================
// fnv1a -- 32-bit deterministic hash. Plenty of entropy for traffic splits.
// =============================================================================

/**
 * fnv1a(s) returns a 32-bit unsigned integer hash of `s` (UTF-8 bytes).
 * @param {string} s
 * @returns {number}
 */
export function fnv1a(s) {
  const str = String(s == null ? '' : s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    // 32-bit multiply by FNV prime via Math.imul + force unsigned with >>>0.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// =============================================================================
// Helpers -- ab_tests row I/O with W411 tenant fence.
// =============================================================================

function _genTestId() {
  return 'abt_' + crypto.randomBytes(8).toString('hex');
}

function _readTest({ tenant, ab_test_id }) {
  if (!tenant || !ab_test_id) return null;
  // findByField -> filter by tenant -- the table uses `tenant` as the
  // canonical column to match findByTenant convention (store.js:415).
  const rows = findByField(AB_TESTS_TABLE, 'ab_test_id', ab_test_id);
  for (const r of rows) {
    if (!r) continue;
    // Inner-loop defense-in-depth tenant fence (W411).
    if (String(r.tenant) !== String(tenant) && String(r.tenant_id) !== String(tenant)) continue;
    return r;
  }
  return null;
}

function _writeTest(rec) {
  // Mirror tenant + tenant_id so either lookup path finds the row.
  if (!rec.tenant && rec.tenant_id) rec.tenant = rec.tenant_id;
  if (!rec.tenant_id && rec.tenant) rec.tenant_id = rec.tenant;
  insert(AB_TESTS_TABLE, rec);
  return rec;
}

function _updateTest(ab_test_id, tenant, patch) {
  update(AB_TESTS_TABLE,
    (r) => r && r.ab_test_id === ab_test_id && (
      String(r.tenant) === String(tenant) || String(r.tenant_id) === String(tenant)
    ),
    patch,
  );
}

// =============================================================================
// W777-1 -- createAbTest({tenant, namespace, arm_a, arm_b, split, sample_target}).
// =============================================================================

/**
 * Create a new A/B test record. Returns { ok, ab_test_id, record }.
 *
 * Validation:
 *   - tenant + namespace + arm_a + arm_b required.
 *   - arm_a != arm_b (no-op test rejected with bad_args envelope).
 *   - split in (0, 1) exclusive.
 *   - sample_target >= 1.
 */
export function createAbTest(args = {}) {
  const tenant = args.tenant ? String(args.tenant) : '';
  const namespace = args.namespace ? String(args.namespace) : '';
  const arm_a = args.arm_a ? String(args.arm_a) : '';
  const arm_b = args.arm_b ? String(args.arm_b) : '';
  const split = Number.isFinite(Number(args.split)) ? Number(args.split) : DEFAULT_SPLIT;
  const sample_target = Number.isFinite(Number(args.sample_target))
    ? Math.max(1, Math.trunc(Number(args.sample_target)))
    : DEFAULT_SAMPLE_TARGET;
  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'createAbTest({tenant, namespace, arm_a, arm_b}) requires tenant',
      version: AB_ROUTER_VERSION,
    };
  }
  if (!namespace) {
    return {
      ok: false,
      error: 'missing_namespace',
      hint: 'createAbTest refuses to default namespace; pass {namespace}',
      version: AB_ROUTER_VERSION,
    };
  }
  if (!arm_a || !arm_b) {
    return {
      ok: false,
      error: 'missing_arm',
      hint: 'arm_a + arm_b (artifact ids or versioned model names) are both required',
      version: AB_ROUTER_VERSION,
    };
  }
  if (arm_a === arm_b) {
    return {
      ok: false,
      error: 'bad_args',
      hint: 'arm_a must differ from arm_b -- a one-arm test is a no-op',
      version: AB_ROUTER_VERSION,
    };
  }
  if (!(split > 0 && split < 1)) {
    return {
      ok: false,
      error: 'bad_args',
      hint: 'split must be strictly between 0 and 1 (exclusive); got ' + split,
      version: AB_ROUTER_VERSION,
    };
  }
  const ab_test_id = _genTestId();
  const rec = {
    ab_test_id,
    tenant,
    tenant_id: tenant,
    namespace,
    arm_a,
    arm_b,
    split,
    sample_target,
    status: STATUS.ACTIVE,
    created_at: new Date().toISOString(),
    promoted_arm: null,
    promoted_at: null,
    rolled_back_at: null,
    version: AB_ROUTER_VERSION,
  };
  _writeTest(rec);
  return { ok: true, ab_test_id, record: rec, version: AB_ROUTER_VERSION };
}

// =============================================================================
// W777-1 -- assignArm({tenant, ab_test_id, request_hash}).
// =============================================================================

/**
 * Deterministically assign a request_hash to arm 'a' or 'b' for an active
 * test. Returns:
 *   { ok:true, arm:'a'|'b', artifact_id, ab_test_id, version }
 * or honest envelope when the test is missing / stopped / promoted.
 *
 * A promoted/rolled-back test no longer splits -- it returns the
 * `promoted_arm` (or arm_a fallback if rolled back) so downstream routing
 * stays on the chosen artifact.
 */
export function assignArm({ tenant, ab_test_id, request_hash } = {}) {
  if (!tenant || !ab_test_id) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'assignArm({tenant, ab_test_id, request_hash}) requires tenant + ab_test_id',
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  // Promoted -> stay on promoted_arm. Rolled back -> stay on arm_a.
  if (rec.status === STATUS.PROMOTED && rec.promoted_arm) {
    const arm = rec.promoted_arm;
    return {
      ok: true,
      arm,
      artifact_id: arm === 'a' ? rec.arm_a : rec.arm_b,
      ab_test_id,
      status: rec.status,
      reason: 'frozen_to_promoted_arm',
      version: AB_ROUTER_VERSION,
    };
  }
  if (rec.status === STATUS.ROLLED_BACK) {
    return {
      ok: true,
      arm: 'a',
      artifact_id: rec.arm_a,
      ab_test_id,
      status: rec.status,
      reason: 'rolled_back_to_arm_a',
      version: AB_ROUTER_VERSION,
    };
  }
  if (rec.status === STATUS.STOPPED) {
    return {
      ok: false,
      error: 'stopped',
      hint: 'test ' + ab_test_id + ' is stopped; do not route to its arms',
      version: AB_ROUTER_VERSION,
    };
  }
  const split = Number.isFinite(Number(rec.split)) ? Number(rec.split) : DEFAULT_SPLIT;
  const h = fnv1a(request_hash);
  const bucket = h % HASH_BUCKETS;
  // bucket < floor(split * HASH_BUCKETS) -> arm A.
  const threshold = Math.floor(split * HASH_BUCKETS);
  const arm = bucket < threshold ? 'a' : 'b';
  return {
    ok: true,
    arm,
    artifact_id: arm === 'a' ? rec.arm_a : rec.arm_b,
    ab_test_id,
    status: rec.status,
    version: AB_ROUTER_VERSION,
  };
}

// =============================================================================
// W777 -- recordOutcome({tenant, ab_test_id, arm, kscore, latency_ms}).
// =============================================================================

/**
 * Persist an outcome event so the W778 gate can read it. Returns the
 * appended event (or honest envelope on validation failure).
 */
export async function recordOutcome({ tenant, ab_test_id, arm, kscore, latency_ms, request_hash, namespace } = {}) {
  if (!tenant || !ab_test_id || !arm) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'recordOutcome requires tenant + ab_test_id + arm',
      version: AB_ROUTER_VERSION,
    };
  }
  if (arm !== 'a' && arm !== 'b') {
    return {
      ok: false,
      error: 'bad_args',
      hint: 'arm must be "a" or "b"; got ' + arm,
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  const ns = namespace || rec.namespace || 'default';
  const ev = await appendEvent({
    tenant_id: tenant,
    namespace: ns,
    workflow_id: AB_OUTCOMES_WORKFLOW,
    request_hash: request_hash || null,
    model: 'ab_test:' + arm,
    status: 'ok',
    latency_ms: Number.isFinite(Number(latency_ms)) ? Math.trunc(Number(latency_ms)) : 0,
    feedback: JSON.stringify({
      kind: 'w777_ab_outcome',
      ab_test_id,
      arm,
      kscore: Number.isFinite(Number(kscore)) ? Number(kscore) : null,
      latency_ms: Number.isFinite(Number(latency_ms)) ? Math.trunc(Number(latency_ms)) : null,
      version: AB_ROUTER_VERSION,
    }),
  });
  return { ok: true, event_id: ev.event_id, ab_test_id, arm, version: AB_ROUTER_VERSION };
}

// =============================================================================
// readSamples -- pull kscore arrays for arm A + arm B (for W778 gate).
// =============================================================================

/**
 * Returns { samples_a: number[], samples_b: number[], n_a, n_b }.
 * W411 tenant fence: listEvents fenced on tenant_id; inner-loop fence on
 * row.tenant_id; ab_test_id fence on the feedback payload.
 */
export async function readSamples({ tenant, ab_test_id } = {}) {
  if (!tenant || !ab_test_id) {
    return { samples_a: [], samples_b: [], n_a: 0, n_b: 0 };
  }
  const events = await listEvents({
    tenant_id: tenant,
    workflow_id: AB_OUTCOMES_WORKFLOW,
    limit: 0,
  });
  const a = [];
  const b = [];
  for (const ev of events) {
    if (!ev) continue;
    // Defense-in-depth tenant fence (W411).
    if (String(ev.tenant_id) !== String(tenant)) continue;
    if (!ev.feedback || typeof ev.feedback !== 'string') continue;
    let fb;
    try { fb = JSON.parse(ev.feedback); } catch { continue; }
    if (!fb || fb.kind !== 'w777_ab_outcome') continue;
    if (fb.ab_test_id !== ab_test_id) continue;
    if (!Number.isFinite(Number(fb.kscore))) continue;
    if (fb.arm === 'a') a.push(Number(fb.kscore));
    else if (fb.arm === 'b') b.push(Number(fb.kscore));
  }
  return { samples_a: a, samples_b: b, n_a: a.length, n_b: b.length };
}

// =============================================================================
// W777-4 / getAbStatus -- summary envelope used by dashboard + CLI.
// =============================================================================

/**
 * Returns:
 *   { ok:false, error:'no_traffic_in_window', ... } when both arms are empty
 *   { ok:true, status, n_a, n_b, kscore_a, kscore_b, sig_test:{...}, ... }
 */
export async function getAbStatus({ tenant, ab_test_id } = {}) {
  if (!tenant || !ab_test_id) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'getAbStatus requires tenant + ab_test_id',
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  const { samples_a, samples_b, n_a, n_b } = await readSamples({ tenant, ab_test_id });
  if (n_a === 0 && n_b === 0) {
    return {
      ok: false,
      error: 'no_traffic_in_window',
      hint: 'no outcomes recorded yet -- call recordOutcome() at least once on each arm',
      status: rec.status,
      record: _publicRecord(rec),
      version: AB_ROUTER_VERSION,
    };
  }
  const mean = (arr) => (arr.length === 0 ? null : arr.reduce((s, v) => s + v, 0) / arr.length);
  const kscore_a = mean(samples_a);
  const kscore_b = mean(samples_b);
  let sig_test = null;
  // W921 - additive anytime-valid (GAVI) interval so the dashboard can render a
  // peeking-safe confidence sequence alongside the legacy fixed-horizon CI. This
  // does NOT replace sig_test (welchT); it is a strict additive field.
  let sequential = null;
  try {
    const { welchT, gaviConfidenceSequence } = await import('./stat-sig.js');
    sig_test = welchT({ samples_a, samples_b });
    try {
      const gavi = gaviConfidenceSequence({ samples_a, samples_b });
      if (gavi && gavi.ok) {
        sequential = {
          method: 'gavi',
          mean_diff: gavi.mean_diff,
          cs_low: gavi.lower,
          cs_high: gavi.upper,
          half_width: gavi.half_width,
          t: gavi.t,
          version: gavi.version,
        };
      } else if (gavi) {
        sequential = { method: 'gavi', ok: false, error: gavi.error || 'insufficient_samples', version: gavi.version };
      }
    } catch (_) { /* advisory only; never fails getAbStatus */ }
  } catch (e) {
    sig_test = {
      ok: false,
      error: 'stat_sig_unavailable',
      detail: String(e && e.message || e),
      p: null,
    };
  }
  const out = {
    ok: true,
    ab_test_id,
    status: rec.status,
    n_a,
    n_b,
    kscore_a,
    kscore_b,
    record: _publicRecord(rec),
    sig_test,
    version: AB_ROUTER_VERSION,
  };
  if (sequential) out.sequential = sequential;
  return out;
}

// =============================================================================
// W921 - sequentialDecision: anytime-valid (mSPRT / GAVI) A/B verdict.
//
// Reads the SAME per-arm kscore samples as autoRollback's legacy gate path, then
// runs the always-valid sequentialGate (src/stat-sig.js) which is valid at every
// sample size simultaneously - safe for the autopilot's continuous per-tick
// peeking. This is ADDITIVE: it does not modify recordOutcome / readSamples /
// autoRollback's default decision; consumers (e.g. the deploy guardrail) opt in
// by calling this explicitly.
// =============================================================================

/**
 * @param {Object} args
 * @param {string} args.tenant
 * @param {string} args.ab_test_id
 * @param {'msprt'|'gavi'} [args.method='msprt']
 * @param {number} [args.alpha]
 * @param {number} [args.tau_sq]
 * @param {number} [args.n_tune]
 * @param {number} [args.min_effect_size]
 * @param {number} [args.min_n]
 * @returns {Promise<{ ok:boolean, decision:'promote'|'rollback'|'continue',
 *   method:string, avp?:number, cs_low?:number, cs_high?:number,
 *   effect_size?:number, n_a?:number, n_b?:number, seq_version?:string,
 *   version:string, error?:string }>}
 */
export async function sequentialDecision({ tenant, ab_test_id, method = 'msprt', alpha, tau_sq, n_tune, min_effect_size, min_n } = {}) {
  if (!tenant || !ab_test_id) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'sequentialDecision requires tenant + ab_test_id',
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  let res;
  try {
    const ss = await import('./stat-sig.js');
    res = await ss.sequentialGate({
      tenant, ab_test_id, method,
      alpha: Number.isFinite(Number(alpha)) ? Number(alpha) : undefined,
      tau_sq: Number.isFinite(Number(tau_sq)) ? Number(tau_sq) : undefined,
      n_tune: Number.isFinite(Number(n_tune)) ? Number(n_tune) : undefined,
      min_effect_size: Number.isFinite(Number(min_effect_size)) ? Number(min_effect_size) : undefined,
      min_n: Number.isFinite(Number(min_n)) ? Number(min_n) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'stat_sig_unavailable',
      detail: String(e && e.message || e),
      version: AB_ROUTER_VERSION,
    };
  }
  return {
    ok: !!(res && res.ok),
    decision: res && res.decision,
    method: res && res.method,
    avp: res && res.avp,
    cs_low: res && res.cs_low,
    cs_high: res && res.cs_high,
    effect_size: res && res.effect_size,
    n_a: res && res.n_a,
    n_b: res && res.n_b,
    seq_version: res && res.version,
    version: AB_ROUTER_VERSION,
  };
}

function _publicRecord(rec) {
  if (!rec) return null;
  return {
    ab_test_id: rec.ab_test_id,
    tenant_id: rec.tenant_id || rec.tenant,
    namespace: rec.namespace,
    arm_a: rec.arm_a,
    arm_b: rec.arm_b,
    split: rec.split,
    sample_target: rec.sample_target,
    status: rec.status,
    promoted_arm: rec.promoted_arm,
    promoted_at: rec.promoted_at,
    rolled_back_at: rec.rolled_back_at,
    created_at: rec.created_at,
  };
}

// =============================================================================
// listAbTests -- enumerate tests for a tenant. Tenant-fenced.
// =============================================================================

export function listAbTests({ tenant } = {}) {
  if (!tenant) {
    return {
      ok: false,
      error: 'missing_tenant',
      hint: 'listAbTests requires {tenant}',
      version: AB_ROUTER_VERSION,
    };
  }
  // findByField on tenant column.
  let rows = [];
  try { rows = findByField(AB_TESTS_TABLE, 'tenant', tenant); } catch (_) { rows = []; }
  // Defense-in-depth: filter out any foreign rows that slipped through.
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    if (String(r.tenant) !== String(tenant) && String(r.tenant_id) !== String(tenant)) continue;
    out.push(_publicRecord(r));
  }
  // newest first by created_at
  out.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return { ok: true, tests: out, count: out.length, version: AB_ROUTER_VERSION };
}

// =============================================================================
// stopAbTest -- flip status -> stopped. Idempotent.
// =============================================================================

export function stopAbTest({ tenant, ab_test_id, reason } = {}) {
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  _updateTest(ab_test_id, tenant, {
    status: STATUS.STOPPED,
    stopped_at: new Date().toISOString(),
    stopped_reason: reason || 'manual_stop',
  });
  return { ok: true, ab_test_id, status: STATUS.STOPPED, version: AB_ROUTER_VERSION };
}

// =============================================================================
// W777-1 -- promoteArm({tenant, ab_test_id, arm, reason}).
// =============================================================================

/**
 * Promote arm `arm` ('a' or 'b') on the test. Writes a promotion event so
 * the audit log preserves the decision lineage, then flips the test record.
 */
export async function promoteArm({ tenant, ab_test_id, arm, reason } = {}) {
  if (!tenant || !ab_test_id || !arm) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'promoteArm requires tenant + ab_test_id + arm',
      version: AB_ROUTER_VERSION,
    };
  }
  if (arm !== 'a' && arm !== 'b') {
    return {
      ok: false,
      error: 'bad_args',
      hint: 'arm must be "a" or "b"; got ' + arm,
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  const now = new Date().toISOString();
  _updateTest(ab_test_id, tenant, {
    status: STATUS.PROMOTED,
    promoted_arm: arm,
    promoted_at: now,
    promoted_reason: reason || 'manual_promote',
  });
  await appendEvent({
    tenant_id: tenant,
    namespace: rec.namespace || 'default',
    workflow_id: AB_PROMOTION_WORKFLOW,
    model: 'ab_test:promote:' + arm,
    status: 'ok',
    feedback: JSON.stringify({
      kind: 'w777_ab_promotion',
      ab_test_id,
      arm,
      reason: reason || 'manual_promote',
      promoted_at: now,
      version: AB_ROUTER_VERSION,
    }),
  });
  return {
    ok: true,
    ab_test_id,
    arm,
    status: STATUS.PROMOTED,
    promoted_at: now,
    version: AB_ROUTER_VERSION,
  };
}

// =============================================================================
// W777-4 / W778-2 -- autoRollback({tenant, ab_test_id}).
// =============================================================================

/**
 * Checks the W778 gate. If the gate decision is 'fail' AND arm B
 * underperforms arm A (mean_b < mean_a) AND the test was previously
 * promoted to arm B, the promotion is reverted. Returns:
 *   { ok:true, rolled_back:bool, reason, decision, version }
 */
export async function autoRollback({ tenant, ab_test_id } = {}) {
  if (!tenant || !ab_test_id) {
    return {
      ok: false,
      error: 'missing_args',
      hint: 'autoRollback requires tenant + ab_test_id',
      version: AB_ROUTER_VERSION,
    };
  }
  const rec = _readTest({ tenant, ab_test_id });
  if (!rec) {
    return {
      ok: false,
      error: 'not_found',
      hint: 'no ab_test for (tenant=' + tenant + ', ab_test_id=' + ab_test_id + ')',
      version: AB_ROUTER_VERSION,
    };
  }
  let gateRes;
  try {
    const ss = await import('./stat-sig.js');
    gateRes = await ss.gate({ tenant, ab_test_id });
  } catch (e) {
    return {
      ok: false,
      error: 'stat_sig_unavailable',
      detail: String(e && e.message || e),
      version: AB_ROUTER_VERSION,
    };
  }
  // Gate insufficient -> nothing to roll back yet (cold-start protection).
  if (gateRes.decision === 'insufficient') {
    return {
      ok: true,
      rolled_back: false,
      reason: 'insufficient_data',
      decision: gateRes.decision,
      gate: gateRes,
      version: AB_ROUTER_VERSION,
    };
  }
  // Gate pass -> arm B is winning; nothing to roll back.
  if (gateRes.decision === 'pass') {
    return {
      ok: true,
      rolled_back: false,
      reason: 'arm_b_winning',
      decision: gateRes.decision,
      gate: gateRes,
      version: AB_ROUTER_VERSION,
    };
  }
  // Gate fail -> consider rollback. Only roll back if (a) arm B was
  // previously promoted AND (b) arm B underperforms arm A.
  const armBWorse = Number.isFinite(Number(gateRes.mean_b))
    && Number.isFinite(Number(gateRes.mean_a))
    && Number(gateRes.mean_b) < Number(gateRes.mean_a);
  if (rec.promoted_arm === 'b' && armBWorse) {
    const now = new Date().toISOString();
    _updateTest(ab_test_id, tenant, {
      status: STATUS.ROLLED_BACK,
      rolled_back_at: now,
      rollback_reason: 'auto_rollback:arm_b_underperforms',
    });
    await appendEvent({
      tenant_id: tenant,
      namespace: rec.namespace || 'default',
      workflow_id: AB_ROLLBACK_WORKFLOW,
      model: 'ab_test:rollback',
      status: 'ok',
      feedback: JSON.stringify({
        kind: 'w777_ab_rollback',
        ab_test_id,
        reason: 'auto_rollback:arm_b_underperforms',
        mean_a: gateRes.mean_a,
        mean_b: gateRes.mean_b,
        p: gateRes.p,
        rolled_back_at: now,
        version: AB_ROUTER_VERSION,
      }),
    });
    return {
      ok: true,
      rolled_back: true,
      reason: 'arm_b_underperforms_and_was_promoted',
      decision: gateRes.decision,
      mean_a: gateRes.mean_a,
      mean_b: gateRes.mean_b,
      gate: gateRes,
      version: AB_ROUTER_VERSION,
    };
  }
  return {
    ok: true,
    rolled_back: false,
    reason: rec.promoted_arm === 'b'
      ? 'arm_b_not_clearly_worse'
      : 'arm_b_was_not_promoted',
    decision: gateRes.decision,
    gate: gateRes,
    version: AB_ROUTER_VERSION,
  };
}

// =============================================================================
// listOutcomeEvents -- audit-log lens for the dashboard.
// =============================================================================

/**
 * Returns the recent N outcome events for an A/B test (newest first).
 * Tenant fenced.
 */
export async function listOutcomeEvents({ tenant, ab_test_id, limit = 200 } = {}) {
  if (!tenant || !ab_test_id) {
    return { ok: false, error: 'missing_args', version: AB_ROUTER_VERSION };
  }
  const lim = Math.max(1, Math.min(10000, Math.trunc(Number(limit) || 200)));
  const events = await listEvents({
    tenant_id: tenant,
    workflow_id: AB_OUTCOMES_WORKFLOW,
    limit: 0,
  });
  const out = [];
  for (const ev of events) {
    if (!ev) continue;
    if (String(ev.tenant_id) !== String(tenant)) continue;
    if (!ev.feedback || typeof ev.feedback !== 'string') continue;
    let fb;
    try { fb = JSON.parse(ev.feedback); } catch { continue; }
    if (!fb || fb.kind !== 'w777_ab_outcome') continue;
    if (fb.ab_test_id !== ab_test_id) continue;
    out.push({
      event_id: ev.event_id,
      created_at: ev.created_at,
      arm: fb.arm,
      kscore: fb.kscore,
      latency_ms: fb.latency_ms,
    });
    if (out.length >= lim) break;
  }
  return { ok: true, events: out, count: out.length, version: AB_ROUTER_VERSION };
}

// =============================================================================
// W822 -- traffic splitter (per-tenant, per-namespace, jsonl persistence).
// =============================================================================
//
// W822-1 ships a thinner, jsonl-backed traffic splitter alongside the existing
// W777 ab-router. The W822 surface is the one /v1/ab/* HTTP routes target;
// W777 ships /v1/ab-tests/* and continues to host the SQLite-backed flow.
//
// Why both?
//   - W777 was designed around a single canonical artifact pair. W822-1 is
//     plain key=value config: "for (tenant, namespace) split traffic between
//     these two artifact_ids in this proportion." A namespace can have at
//     most ONE active W822 config at any time (latest write wins) -- the
//     jsonl is append-only so the previous configs are still readable for
//     audit + rollback.
//   - jsonl storage lives at ~/.kolm/ab-tests/<namespace>.jsonl so it stays
//     visible to operators via plain `cat` without spinning up Node.
//
// Stable variant hashing: pickVariant() uses fnv1a(tenant|namespace|request_id)
// so the same caller always sees the same variant within a (tenant, namespace,
// config) window. When the config rotates (new started_at) the window resets.

export const W822_AB_VERSION = 'w822-v1';

function _w822Home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _w822IsTestRunner() {
  return process.env.NODE_ENV === 'test'
    || process.env.npm_lifecycle_event === 'test'
    || (Array.isArray(process.execArgv) && process.execArgv.some((a) => a === '--test' || (typeof a === 'string' && a.startsWith('--test-'))))
    || (Array.isArray(process.argv) && process.argv.some((a) => a === '--test' || (typeof a === 'string' && a.startsWith('--test-'))));
}

function _w822BaseDir() {
  // KOLM_DATA_DIR takes precedence (test harness uses it). Then ~/.kolm.
  // In test mode without KOLM_DATA_DIR fall back to a per-pid tmp dir so
  // parallel tests don't fight over the same files.
  if (process.env.KOLM_DATA_DIR) {
    return path.join(path.resolve(process.env.KOLM_DATA_DIR), 'ab-tests');
  }
  if (_w822IsTestRunner()) {
    return path.join(os.tmpdir(), 'kolm-ab-tests-' + process.pid);
  }
  return path.join(_w822Home(), '.kolm', 'ab-tests');
}

function _w822SanitizeNs(ns) {
  // Allow [A-Za-z0-9_.-]. Reject empties + traversal. Keep at most 128 chars.
  const s = String(ns || '').slice(0, 128);
  if (!s) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(s)) return null;
  if (s === '.' || s === '..') return null;
  return s;
}

function _w822NamespacePath(namespace) {
  const safe = _w822SanitizeNs(namespace);
  if (!safe) return null;
  const dir = _w822BaseDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, safe + '.jsonl');
}

function _w822ReadAllConfigs(namespace) {
  const file = _w822NamespacePath(namespace);
  if (!file) return [];
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch { /* skip malformed line */ }
  }
  return out;
}

function _w822AppendConfig(namespace, cfg) {
  const file = _w822NamespacePath(namespace);
  if (!file) throw new Error('setSplit: invalid namespace');
  fs.appendFileSync(file, JSON.stringify(cfg) + '\n', 'utf8');
  return cfg;
}

/**
 * setSplit({tenant, namespace, version_a, version_b, split, idempotency_key}).
 *
 * Returns:
 *   { ok:true, config:{...}, version:'w822-vN' } on success
 *   { ok:false, error:'...', hint:'...' } on validation failure
 *
 * Idempotency: when idempotency_key matches the latest config row (same
 * tenant + namespace), we return the existing row instead of appending a
 * duplicate. Lets retry-on-network-failure stay safe.
 */
export function setSplit(args = {}) {
  const tenant = args.tenant ? String(args.tenant) : '';
  const namespace = args.namespace ? String(args.namespace) : '';
  const version_a = args.version_a ? String(args.version_a) : '';
  const version_b = args.version_b ? String(args.version_b) : '';
  const split = Number.isFinite(Number(args.split)) ? Number(args.split) : 0.5;
  const idempotency_key = args.idempotency_key ? String(args.idempotency_key) : null;

  if (!tenant) {
    return { ok: false, error: 'missing_tenant', hint: 'setSplit requires {tenant}', version: W822_AB_VERSION };
  }
  if (!_w822SanitizeNs(namespace)) {
    return { ok: false, error: 'bad_namespace', hint: 'namespace must match /^[A-Za-z0-9_.-]+$/ and be <=128 chars', version: W822_AB_VERSION };
  }
  if (!version_a || !version_b) {
    return { ok: false, error: 'missing_version', hint: 'version_a + version_b (artifact ids) both required', version: W822_AB_VERSION };
  }
  if (version_a === version_b) {
    return { ok: false, error: 'bad_args', hint: 'version_a must differ from version_b', version: W822_AB_VERSION };
  }
  if (!(split >= 0 && split <= 1)) {
    return { ok: false, error: 'bad_args', hint: 'split must be in [0, 1]; got ' + split, version: W822_AB_VERSION };
  }

  // Idempotency check -- compare against latest row of THIS tenant.
  if (idempotency_key) {
    const all = _w822ReadAllConfigs(namespace).filter(r => String(r.tenant) === tenant);
    const latest = all.length ? all[all.length - 1] : null;
    if (latest && latest.idempotency_key === idempotency_key) {
      return { ok: true, config: latest, idempotent_hit: true, version: W822_AB_VERSION };
    }
  }

  const cfg = {
    tenant,
    namespace,
    version_a,
    version_b,
    split,
    started_at: new Date().toISOString(),
    idempotency_key,
    w822_version: W822_AB_VERSION,
  };
  _w822AppendConfig(namespace, cfg);
  return { ok: true, config: cfg, version: W822_AB_VERSION };
}

/**
 * getSplit({tenant, namespace}) returns the *latest* active config for the
 * (tenant, namespace) pair. Honest envelope when none exists.
 */
export function getSplit(args = {}) {
  const tenant = args.tenant ? String(args.tenant) : '';
  const namespace = args.namespace ? String(args.namespace) : '';
  if (!tenant) {
    return { ok: false, error: 'missing_tenant', hint: 'getSplit requires {tenant}', version: W822_AB_VERSION };
  }
  if (!_w822SanitizeNs(namespace)) {
    return { ok: false, error: 'bad_namespace', hint: 'namespace must match /^[A-Za-z0-9_.-]+$/', version: W822_AB_VERSION };
  }
  const rows = _w822ReadAllConfigs(namespace);
  // Defense-in-depth: filter by tenant on every read.
  const mine = rows.filter(r => r && String(r.tenant) === tenant);
  if (mine.length === 0) {
    return { ok: false, error: 'no_active_config', hint: 'call setSplit() first to start an A/B test', version: W822_AB_VERSION };
  }
  return { ok: true, config: mine[mine.length - 1], history_count: mine.length, version: W822_AB_VERSION };
}

/**
 * pickVariant({tenant, namespace, request_id}) returns 'a' or 'b' (deterministic).
 *
 * Stable hashing: same request_id maps to the same variant within a config
 * window. When setSplit() is called again the config's started_at rotates,
 * which DOES NOT change the hash output -- callers who want a fresh bucket
 * per config can mix started_at into request_id at the call site. Default
 * behavior is "sticky across the namespace" so users in flight on variant A
 * keep getting A even if a new config is written.
 */
export function pickVariant(args = {}) {
  const tenant = args.tenant ? String(args.tenant) : '';
  const namespace = args.namespace ? String(args.namespace) : '';
  const request_id = args.request_id == null ? '' : String(args.request_id);
  if (!tenant || !namespace) {
    return { ok: false, error: 'missing_args', hint: 'pickVariant requires {tenant, namespace, request_id}', version: W822_AB_VERSION };
  }
  const cfgRes = getSplit({ tenant, namespace });
  if (!cfgRes.ok) {
    return cfgRes;
  }
  const cfg = cfgRes.config;
  // Hash on (tenant|namespace|request_id) so different tenants on the same
  // request_id still get independent variant assignments.
  const h = fnv1a(tenant + '|' + namespace + '|' + request_id);
  const bucket = h % HASH_BUCKETS;
  const threshold = Math.floor(Number(cfg.split) * HASH_BUCKETS);
  // bucket < threshold -> variant 'a'. Equivalent to assignArm() bucket math.
  const variant = bucket < threshold ? 'a' : 'b';
  const artifact_id = variant === 'a' ? cfg.version_a : cfg.version_b;
  return {
    ok: true,
    variant,
    artifact_id,
    namespace,
    config_started_at: cfg.started_at,
    bucket,
    version: W822_AB_VERSION,
  };
}

/**
 * listSplits({tenant}) -- enumerate active configs across all namespaces for
 * the tenant. Walks every jsonl file in the base dir; defense-in-depth tenant
 * filter. Returns {ok:true, configs:[{namespace, config}], count}.
 */
export function listSplits(args = {}) {
  const tenant = args.tenant ? String(args.tenant) : '';
  if (!tenant) {
    return { ok: false, error: 'missing_tenant', version: W822_AB_VERSION };
  }
  const dir = _w822BaseDir();
  if (!fs.existsSync(dir)) {
    return { ok: true, configs: [], count: 0, version: W822_AB_VERSION };
  }
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.jsonl')) continue;
    const namespace = file.slice(0, -'.jsonl'.length);
    if (!_w822SanitizeNs(namespace)) continue;
    const rows = _w822ReadAllConfigs(namespace).filter(r => r && String(r.tenant) === tenant);
    if (rows.length === 0) continue;
    out.push({ namespace, config: rows[rows.length - 1] });
  }
  out.sort((a, b) => String(b.config.started_at || '').localeCompare(String(a.config.started_at || '')));
  return { ok: true, configs: out, count: out.length, version: W822_AB_VERSION };
}

export default {
  AB_ROUTER_VERSION,
  AB_TESTS_TABLE,
  AB_OUTCOMES_WORKFLOW,
  AB_PROMOTION_WORKFLOW,
  AB_ROLLBACK_WORKFLOW,
  DEFAULT_SAMPLE_TARGET,
  DEFAULT_SPLIT,
  HASH_BUCKETS,
  STATUS,
  fnv1a,
  createAbTest,
  assignArm,
  recordOutcome,
  readSamples,
  getAbStatus,
  listAbTests,
  stopAbTest,
  promoteArm,
  autoRollback,
  listOutcomeEvents,
  // W921 anytime-valid sequential A/B decision (additive).
  sequentialDecision,
  // W822 surface
  W822_AB_VERSION,
  setSplit,
  getSplit,
  pickVariant,
  listSplits,
};
