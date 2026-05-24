// W832 — kolm-meta meta-distillation model tests.
//
// Atomic items (12 tests):
//
//   1) META_FEATURES + META_TARGETS frozen contracts
//   2) appendTrainingRow persists to disk
//   3) appendTrainingRow rejects empty/missing features
//   4) readTrainingRows tenant-fenced (foreign tenant_id returns empty)
//   5) n_rows() returns count
//   6) trainKolmMeta with <2 rows returns insufficient_rows envelope
//   7) trainKolmMeta with >=2 rows returns a model object
//   8) inferKolmMeta with no model returns {ok:false, status:'no_model'}
//   9) inferKolmMeta with trained model returns {ok:true, kscore_predicted, ...}
//  10) recommendArchWithMeta with n<MIN_ROWS_FOR_META returns rule-source + meta_insufficient_data:true
//  11) recommendArchWithMeta with n>=MIN_ROWS_FOR_META + trained model returns meta-source
//  12) resetForTests() clears state
//
// Anti-brittleness (W604):
//   - Never assert exact byte counts; use regex + numeric threshold.
//   - Wave-family checks via regex + minimum (no explicit-array families).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  META_VERSION,
  META_FEATURES,
  META_TARGETS,
  MIN_ROWS_FOR_META,
  appendTrainingRow,
  readTrainingRows,
  n_rows,
  trainKolmMeta,
  inferKolmMeta,
  resetForTests,
} from '../src/kolm-meta-trainer.js';
import {
  recommendArchWithMeta,
} from '../src/student-arch-recommender.js';

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w832-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  resetForTests();
  return tmp;
}

// =============================================================================
// 1) Frozen contracts
// =============================================================================

test('W832 #1 — META_FEATURES + META_TARGETS frozen contracts', () => {
  freshDir();
  // Version regex anti-brittle: w832-v\d+ family.
  assert.match(META_VERSION, /^w832-v\d+$/);
  assert.equal(META_VERSION, 'w832-v1');
  // FEATURES + TARGETS are frozen arrays.
  assert.ok(Object.isFrozen(META_FEATURES), 'META_FEATURES must be frozen');
  assert.ok(Object.isFrozen(META_TARGETS), 'META_TARGETS must be frozen');
  // Membership checks (NOT exact-array equality — additions are OK, removals
  // would break callers).
  for (const k of ['capture_count', 'teacher_class', 'task_type', 'hw_tier']) {
    assert.ok(META_FEATURES.includes(k), 'META_FEATURES must include ' + k);
  }
  for (const k of ['kscore_predicted', 'compile_time_s_predicted', 'failure_mode_predicted']) {
    assert.ok(META_TARGETS.includes(k), 'META_TARGETS must include ' + k);
  }
});

// =============================================================================
// 2) appendTrainingRow persists
// =============================================================================

test('W832 #2 — appendTrainingRow persists to disk', () => {
  freshDir();
  const r = appendTrainingRow({
    tenant_id: 'tenant_w832_a',
    run_id: 'run_test_1',
    features: { capture_count: 50, teacher_class: 'open-weights' },
    observed: { kscore: 0.81, compile_time_s: 42.3, failure_modes: ['no_kscore'] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.version, META_VERSION);
  const rows = readTrainingRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tenant_id, 'tenant_w832_a');
  assert.equal(rows[0].observed.kscore, 0.81);
  assert.equal(rows[0].observed.compile_time_s, 42.3);
  assert.deepEqual(rows[0].observed.failure_modes, ['no_kscore']);
});

// =============================================================================
// 3) appendTrainingRow rejects empty/missing features
// =============================================================================

test('W832 #3 — appendTrainingRow rejects empty/missing features', () => {
  freshDir();
  // No features at all.
  assert.throws(
    () => appendTrainingRow({ tenant_id: 'x', observed: { kscore: 0.5 } }),
    (e) => e.code === 'features_required',
  );
  // Empty features object — no recognized keys.
  assert.throws(
    () => appendTrainingRow({ tenant_id: 'x', features: {}, observed: { kscore: 0.5 } }),
    (e) => e.code === 'features_required',
  );
  // Features but no observed.
  assert.throws(
    () => appendTrainingRow({ tenant_id: 'x', features: { capture_count: 1 } }),
    (e) => e.code === 'observed_required',
  );
});

// =============================================================================
// 4) readTrainingRows tenant-fenced
// =============================================================================

test('W832 #4 — readTrainingRows tenant-fenced (foreign tenant returns empty)', () => {
  freshDir();
  appendTrainingRow({
    tenant_id: 'tenant_owner',
    features: { capture_count: 10 },
    observed: { kscore: 0.7, compile_time_s: 30 },
  });
  appendTrainingRow({
    tenant_id: 'tenant_owner',
    features: { capture_count: 20 },
    observed: { kscore: 0.8, compile_time_s: 40 },
  });
  // All rows visible to no-filter caller.
  const all = readTrainingRows();
  assert.equal(all.length, 2);
  // Owner sees both.
  const owner = readTrainingRows({ tenant_id: 'tenant_owner' });
  assert.equal(owner.length, 2);
  // Foreign tenant sees zero.
  const foreign = readTrainingRows({ tenant_id: 'tenant_attacker' });
  assert.equal(foreign.length, 0, 'foreign tenant must NOT see owner rows');
});

// =============================================================================
// 5) n_rows() returns count
// =============================================================================

test('W832 #5 — n_rows() returns count', () => {
  freshDir();
  assert.equal(n_rows(), 0);
  for (let i = 0; i < 7; i++) {
    appendTrainingRow({
      tenant_id: 'tenant_count',
      features: { capture_count: i },
      observed: { kscore: 0.5 + i / 100, compile_time_s: 20 },
    });
  }
  assert.equal(n_rows(), 7);
  assert.equal(n_rows({ tenant_id: 'tenant_count' }), 7);
  assert.equal(n_rows({ tenant_id: 'someone_else' }), 0);
});

// =============================================================================
// 6) trainKolmMeta with <2 rows -> insufficient_rows envelope
// =============================================================================

test('W832 #6 — trainKolmMeta with <2 rows returns insufficient_rows envelope', () => {
  freshDir();
  // 0 rows.
  const e0 = trainKolmMeta({ rows: [] });
  assert.equal(e0.ok, false);
  assert.equal(e0.error, 'insufficient_rows');
  assert.equal(e0.rows, 0);
  // 1 row.
  const e1 = trainKolmMeta({
    rows: [{ features: { capture_count: 5 }, observed: { kscore: 0.7, compile_time_s: 30 } }],
  });
  assert.equal(e1.ok, false);
  assert.equal(e1.error, 'insufficient_rows');
  assert.equal(e1.rows, 1);
  // Non-array.
  const eN = trainKolmMeta({ rows: null });
  assert.equal(eN.ok, false);
  assert.equal(eN.error, 'rows_must_be_array');
});

// =============================================================================
// 7) trainKolmMeta with >=2 rows -> model object
// =============================================================================

test('W832 #7 — trainKolmMeta with >=2 rows returns a model object', () => {
  freshDir();
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push({
      features: { capture_count: 10 + i * 5, teacher_class: 'open-weights' },
      observed: { kscore: 0.6 + i / 50, compile_time_s: 30 + i, failure_modes: i > 5 ? ['no_kscore'] : [] },
    });
  }
  const env = trainKolmMeta({ rows });
  assert.equal(env.ok, true);
  assert.equal(env.model.n_train_rows, 10);
  assert.equal(env.model.schema, META_VERSION);
  assert.deepEqual(env.model.feature_order, [...META_FEATURES]);
  assert.deepEqual(env.model.target_order, [...META_TARGETS]);
  assert.ok(env.model.kscore_gbm, 'has kscore_gbm');
  assert.ok(env.model.compile_time_gbm, 'has compile_time_gbm');
  assert.ok(env.model.failure_classifier, 'has failure_classifier');
  // Honesty block — bounded claim.
  assert.equal(env.model.honesty.implementation, 'toy_stump_gbm');
  // Model file written.
  assert.ok(fs.existsSync(env.model_path), 'model file written to disk');
});

// =============================================================================
// 8) inferKolmMeta with no model -> ok:false, status:'no_model'
// =============================================================================

test('W832 #8 — inferKolmMeta with no model returns ok:false status no_model', () => {
  freshDir();
  const env = inferKolmMeta({ features: { capture_count: 100 } });
  assert.equal(env.ok, false);
  assert.equal(env.status, 'no_model');
  assert.match(String(env.hint || ''), /kolm meta retrain/);
});

// =============================================================================
// 9) inferKolmMeta with trained model -> ok:true with predictions
// =============================================================================

test('W832 #9 — inferKolmMeta with trained model returns ok:true predictions', () => {
  freshDir();
  // Seed training rows.
  const rows = [];
  for (let i = 0; i < 20; i++) {
    rows.push({
      features: { capture_count: 10 + i * 10, teacher_class: i % 2 === 0 ? 'open-weights' : 'proprietary' },
      observed: { kscore: 0.5 + i / 40, compile_time_s: 20 + i * 2, failure_modes: i > 10 ? ['no_kscore'] : [] },
    });
  }
  const trainEnv = trainKolmMeta({ rows });
  assert.equal(trainEnv.ok, true);
  // Infer.
  const env = inferKolmMeta({ features: { capture_count: 100, teacher_class: 'open-weights' } });
  assert.equal(env.ok, true);
  assert.equal(env.status, 'predicted');
  assert.ok(Number.isFinite(env.kscore_predicted), 'kscore_predicted finite');
  assert.ok(Number.isFinite(env.compile_time_s_predicted), 'compile_time_s_predicted finite');
  // failure_mode_predicted may be null if no failures seen — that's honest.
  assert.ok(env.failure_mode_predicted === null || typeof env.failure_mode_predicted === 'string');
  assert.ok(env.confidence >= 0 && env.confidence <= 1);
});

// =============================================================================
// 10) recommendArchWithMeta with n<MIN_ROWS_FOR_META -> rules + insufficient_data
// =============================================================================

test('W832 #10 — recommendArchWithMeta with n<MIN_ROWS_FOR_META falls back to rules', async () => {
  freshDir();
  // Seed 5 rows — well below the 1000-row floor.
  for (let i = 0; i < 5; i++) {
    appendTrainingRow({
      tenant_id: 'tenant_under',
      features: { capture_count: i },
      observed: { kscore: 0.7, compile_time_s: 30 },
    });
  }
  const stats = {
    n: 500,
    output_length: { p50: 800, p95: 1500, mean: 900 },
    vocab_entropy_bits: 9, reasoning_chain_depth_avg: 5,
    tool_use_rate: 0.1, task_complexity_proxy: 0.75,
  };
  // Ensure MoE gate is off for deterministic 7B branch.
  const prevMoe = process.env.KOLM_ENABLE_MOE;
  delete process.env.KOLM_ENABLE_MOE;
  try {
    const env = await recommendArchWithMeta({ stats, features: { capture_count: 500 } });
    assert.equal(env.source, 'rules');
    assert.equal(env.meta_insufficient_data, true);
    assert.equal(env.rows, 5);
    // Rule pick still present.
    assert.match(env.recommended.size_label, /^7B/);
    // No meta_prediction block.
    assert.equal(env.meta_prediction, undefined);
  } finally {
    if (prevMoe != null) process.env.KOLM_ENABLE_MOE = prevMoe;
  }
});

// =============================================================================
// 11) recommendArchWithMeta with n>=MIN_ROWS_FOR_META + trained model -> meta source
// =============================================================================

test('W832 #11 — recommendArchWithMeta with n>=threshold + trained model returns meta source', async () => {
  freshDir();
  // The MIN_ROWS_FOR_META constant was captured at module-load time, so we
  // CANNOT swap it at runtime via env var (the recommender's dynamic import
  // hits the cached module). Instead we honestly seed >= MIN_ROWS_FOR_META
  // rows — 1000 by spec. Each row is tiny so this stays fast.
  const N = MIN_ROWS_FOR_META + 5;
  for (let i = 0; i < N; i++) {
    appendTrainingRow({
      tenant_id: 'tenant_above',
      features: { capture_count: 10 + (i % 50), teacher_class: 'open-weights', task_type: 'kd_softmax' },
      observed: { kscore: 0.7 + (i % 20) / 100, compile_time_s: 20 + (i % 10), failure_modes: [] },
    });
  }
  // Train so we have a model on disk.
  const trainEnv = trainKolmMeta({ rows: readTrainingRows() });
  assert.equal(trainEnv.ok, true);
  assert.ok(n_rows() >= MIN_ROWS_FOR_META);
  const stats = {
    n: 500,
    output_length: { p50: 800, p95: 1500, mean: 900 },
    vocab_entropy_bits: 9, reasoning_chain_depth_avg: 5,
    tool_use_rate: 0.1, task_complexity_proxy: 0.75,
  };
  const prevMoe = process.env.KOLM_ENABLE_MOE;
  delete process.env.KOLM_ENABLE_MOE;
  try {
    const env = await recommendArchWithMeta({
      stats,
      features: { capture_count: 200, teacher_class: 'open-weights' },
    });
    assert.equal(env.source, 'meta');
    assert.equal(env.meta_insufficient_data, false);
    assert.ok(env.rows >= MIN_ROWS_FOR_META);
    assert.ok(env.meta_prediction, 'has meta_prediction block');
    assert.ok(Number.isFinite(env.meta_prediction.kscore_predicted));
    assert.ok(Number.isFinite(env.meta_prediction.compile_time_s_predicted));
    // Rule pick STILL present alongside meta — operator can compare.
    assert.match(env.recommended.size_label, /^7B/);
  } finally {
    if (prevMoe != null) process.env.KOLM_ENABLE_MOE = prevMoe;
  }
});

// =============================================================================
// 12) resetForTests() clears state
// =============================================================================

test('W832 #12 — resetForTests() clears state', () => {
  freshDir();
  appendTrainingRow({
    tenant_id: 'x',
    features: { capture_count: 1 },
    observed: { kscore: 0.5, compile_time_s: 10 },
  });
  assert.equal(n_rows(), 1);
  // Train so a model file exists.
  trainKolmMeta({
    rows: [
      { features: { capture_count: 1 }, observed: { kscore: 0.5, compile_time_s: 10 } },
      { features: { capture_count: 2 }, observed: { kscore: 0.6, compile_time_s: 12 } },
    ],
  });
  const env = inferKolmMeta({ features: { capture_count: 1 } });
  assert.equal(env.ok, true);
  // Reset.
  resetForTests();
  assert.equal(n_rows(), 0);
  const env2 = inferKolmMeta({ features: { capture_count: 1 } });
  assert.equal(env2.ok, false);
  assert.equal(env2.status, 'no_model');
});
