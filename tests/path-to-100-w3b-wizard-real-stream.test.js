// W-3 part 2 (Path to 100%) — the no-code wizard streams a REAL compile.
//
// /v1/compile/start now runs createJob + runJob (real W283 holdout compile) and
// /v1/compile/stream maps that job to the SSE contract via buildRealEventLog —
// replacing compile-stream.js's deterministic stub (22 fabricated events, fake
// k_scores 0.71/0.83/0.91, GPU-themed steps that never ran). This pins the event
// mapper: real holdout K-score only, real .kolm URL, honest error on failure.

import { test } from 'node:test';
import assert from 'node:assert';
import { buildRealEventLog, REAL_COMPILE_STEPS } from '../src/compile-stream.js';

test('W-3/2: a completed job emits a real `done` with the real holdout K-score + .kolm URL', () => {
  const job = {
    id: 'job_abc123def456',
    status: 'completed',
    k_score: 0.93,
    cid: 'cidv1:sha256:deadbeef',
    stages: [{ name: 'split.done', holdout_count: 2 }, { name: 'distill.done' }, { name: 'package.done' }],
    seed_provenance: { holdout_count: 2 },
    manifest: { artifact_class: 'rule' },
  };
  const log = buildRealEventLog(job);

  // hello declares the REAL pipeline steps (overlay renders these).
  const hello = log.find((e) => e.event === 'hello');
  assert.deepStrictEqual(hello.data.steps.map((s) => s.id), REAL_COMPILE_STEPS.map((s) => s.id));

  const done = log.find((e) => e.event === 'done');
  assert.ok(done, 'a completed job emits done');
  assert.strictEqual(done.data.k_score, 0.93, 'the real measured holdout K-score');
  assert.strictEqual(done.data.artifact_url, '/v1/compile/job_abc123def456/.kolm');
  assert.strictEqual(done.data.holdout_count, 2);

  // The ONLY metric is the real holdout score — no fabricated per-pass curve.
  const metrics = log.filter((e) => e.event === 'metric');
  assert.strictEqual(metrics.length, 1);
  assert.strictEqual(metrics[0].data.k_score, 0.93);
  assert.strictEqual(metrics[0].data.source, 'holdout');
});

test('W-3/2: a failed job emits an honest `error`, never `done`', () => {
  const job = {
    id: 'job_fail',
    status: 'failed',
    error_code: 'KOLM_E_K_SCORE_BELOW_THRESHOLD',
    error: 'k_score 0.62 below threshold 0.85',
    stages: [{ name: 'split.done' }, { name: 'distill.done' }],
  };
  const log = buildRealEventLog(job);
  const err = log.find((e) => e.event === 'error');
  assert.ok(err, 'a failed compile emits error');
  assert.strictEqual(err.data.error_code, 'KOLM_E_K_SCORE_BELOW_THRESHOLD');
  assert.strictEqual(log.find((e) => e.event === 'done'), undefined, 'never a fake done');
});

test('W-3/2: a completed job with no measured K-score reports null (not fabricated)', () => {
  const job = {
    id: 'job_nok',
    status: 'completed',
    stages: [{ name: 'split.done' }, { name: 'distill.done' }, { name: 'package.done' }],
  };
  const log = buildRealEventLog(job);
  const done = log.find((e) => e.event === 'done');
  assert.strictEqual(done.data.k_score, null);
  assert.strictEqual(log.filter((e) => e.event === 'metric').length, 0, 'no metric without a real score');
});
