// W921 — tests for src/quality-predictor.js predictKScore({tenant, namespace,
// features}).
//
// Deterministic by construction: every call uses a UNIQUE test tenant id, which
// tenant-fences the meta-trainer row store (readTrainingRows filters by
// tenant_id). A fresh tenant therefore has 0 training rows, which is well below
// MIN_ROWS_FOR_META (default 1000) and below MIN_CONFORMAL_CAL, so the predictor
// deterministically takes the cold-start HEURISTIC path with no learned-model
// or conformal-pool variance. No real clock branching, no network: the only
// non-deterministic surface is the best-effort _persist event log, whose result
// only flips the additive `persisted` flag and never the contract under test.
//
// Contract under test (qp-v1):
//   bad input        -> { ok:false, error:'features_required', version }
//   junk-only keys   -> { ok:false, error:'no_recognized_features', version }
//   cold start       -> { ok:true, version, kscore_predicted, ci:[lo,hi],
//                         confidence, basis:'heuristic', n_train_rows }

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  predictKScore,
  QUALITY_PREDICTOR_VERSION,
} from '../src/quality-predictor.js';

// Unique-per-call tenant so the meta row store is always empty for this test.
let _seq = 0;
function uniqTenant() {
  _seq += 1;
  return `tenant_qp_w921_${process.pid}_${Date.now()}_${_seq}`;
}

// A high-quality data-feature vector (Trinity-like): many pairs, low dup, high
// coverage/quality/diversity, low CoT contamination.
const GOOD_FEATURES = Object.freeze({
  n_pairs: 410,
  dup_fraction: 0.03,
  coverage_score: 0.92,
  avg_quality: 0.9,
  cot_contam_fraction: 0.02,
  teacher_diversity: 0.85,
});

// A poor data-feature vector: few pairs, lots of dups, weak coverage/quality,
// heavy CoT contamination, single-teacher.
const POOR_FEATURES = Object.freeze({
  n_pairs: 8,
  dup_fraction: 0.7,
  coverage_score: 0.15,
  avg_quality: 0.2,
  cot_contam_fraction: 0.6,
  teacher_diversity: 0.05,
});

test('bad input — missing features => ok:false features_required', async () => {
  const r = await predictKScore({ tenant: uniqTenant() });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'features_required');
  assert.equal(r.version, QUALITY_PREDICTOR_VERSION);
});

test('bad input — array features => ok:false features_required', async () => {
  const r = await predictKScore({ tenant: uniqTenant(), features: [1, 2, 3] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'features_required');
  assert.equal(r.version, QUALITY_PREDICTOR_VERSION);
});

test('bad input — empty object (no recognized features) => ok:false no_recognized_features', async () => {
  const r = await predictKScore({ tenant: uniqTenant(), features: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'no_recognized_features');
  assert.equal(r.version, QUALITY_PREDICTOR_VERSION);
});

test('cold-start (no training rows) => ok:true, basis heuristic, honest confidence + n_train_rows', async () => {
  const r = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });

  // Envelope contract.
  assert.equal(r.ok, true);
  assert.equal(r.version, QUALITY_PREDICTOR_VERSION);
  assert.equal(r.basis, 'heuristic');

  // Fresh tenant => zero accumulated training rows.
  assert.equal(r.n_train_rows, 0);

  // Honest LOW confidence on the cold path: floor 0.10, ceiling 0.45.
  assert.equal(typeof r.confidence, 'number');
  assert.ok(r.confidence >= 0.10 && r.confidence <= 0.45,
    `cold confidence ${r.confidence} must be in the honest LOW band [0.10,0.45]`);
});

test('ci/confidence present in the envelope as a valid [lo,hi] band', async () => {
  const r = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });

  assert.equal(r.ok, true);
  assert.ok(Array.isArray(r.ci), 'ci must be an array');
  assert.equal(r.ci.length, 2);
  const [lo, hi] = r.ci;
  assert.equal(typeof lo, 'number');
  assert.equal(typeof hi, 'number');
  assert.ok(lo <= hi, `ci lo ${lo} must be <= hi ${hi}`);
  // Band stays inside the K range [0,1].
  assert.ok(lo >= 0 && hi <= 1, `ci band [${lo},${hi}] must lie within K range [0,1]`);
  // Point estimate sits inside its own band.
  assert.ok(r.kscore_predicted >= lo && r.kscore_predicted <= hi,
    `kscore_predicted ${r.kscore_predicted} must lie within ci [${lo},${hi}]`);
});

test('predicted score is within the valid K range [0,1]', async () => {
  const good = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });
  const poor = await predictKScore({ tenant: uniqTenant(), features: POOR_FEATURES });

  for (const r of [good, poor]) {
    assert.equal(r.ok, true);
    assert.equal(typeof r.kscore_predicted, 'number');
    assert.ok(Number.isFinite(r.kscore_predicted));
    assert.ok(r.kscore_predicted >= 0 && r.kscore_predicted <= 1,
      `kscore_predicted ${r.kscore_predicted} must be within K range [0,1]`);
  }
});

test('monotonic sanity — better feature vector predicts a higher kscore than a poor one', async () => {
  // Same path (both cold-start heuristic, both fresh tenants) so the only
  // difference is the feature vector — a clean monotonicity check.
  const good = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });
  const poor = await predictKScore({ tenant: uniqTenant(), features: POOR_FEATURES });

  assert.equal(good.ok, true);
  assert.equal(poor.ok, true);
  assert.equal(good.basis, 'heuristic');
  assert.equal(poor.basis, 'heuristic');
  assert.ok(good.kscore_predicted > poor.kscore_predicted,
    `good kscore ${good.kscore_predicted} must exceed poor kscore ${poor.kscore_predicted}`);
});

test('determinism — identical features on fresh tenants yield identical predictions', async () => {
  const a = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });
  const b = await predictKScore({ tenant: uniqTenant(), features: GOOD_FEATURES });

  assert.equal(a.kscore_predicted, b.kscore_predicted);
  assert.deepEqual(a.ci, b.ci);
  assert.equal(a.confidence, b.confidence);
  assert.equal(a.basis, b.basis);
});
