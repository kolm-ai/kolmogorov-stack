// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  BENCH_CASES,
  referenceScorer,
  runBench,
} from '../src/kscore-bench.js';
import { buildRouter } from '../src/router.js';

function withServer(app, fn) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const out = await fn(base);
        server.close(() => resolve(out));
      } catch (e) {
        server.close(() => reject(e));
      }
    });
    server.on('error', reject);
  });
}

test('W587 #1 - K-score calibration suite is frozen across all four task classes', async () => {
  assert.equal(BENCH_CASES.length, 30);
  const byClass = BENCH_CASES.reduce((acc, c) => {
    acc[c.cls] = (acc[c.cls] || 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(byClass, {
    classification: 8,
    code: 7,
    extraction: 7,
    generation: 8,
  });
  const result = await runBench(referenceScorer);
  assert.equal(result.summary.n, 30);
  assert.equal(result.summary.pass + result.summary.fail, 30);
  assert.ok(result.summary.pass > result.summary.fail);
  assert.ok(result.summary.composite_mean >= result.summary.gate);
  assert.ok(result.summary.axis_means.A > 0.8);
  assert.ok(result.summary.axis_means.Z > 0.9);
});

test('W587 #2 - GET /v1/eval/k-score-calibration is public, enveloped, and honest about scope', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/eval/k-score-calibration');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-surface'), 'capture-data-eval-training');
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.surface, 'capture-data-eval-training');
    assert.equal(body.readiness.status, 'implemented');
    assert.equal(body.data.spec, 'kolm-bench-v1');
    assert.equal(body.data.case_count, 30);
    assert.equal(body.data.class_counts.classification, 8);
    assert.equal(body.data.class_counts.extraction, 7);
    assert.equal(body.data.class_counts.generation, 8);
    assert.equal(body.data.class_counts.code, 7);
    assert.equal(body.data.secret_values_included, false);
    assert.match(body.data.claim_scope, /broader competitive claims require/i);
    assert.equal(body.data.leaderboard.submission_mode, 'manual_review');
    assert.equal(body.data.leaderboard.submission_endpoint, null);
    assert.ok(body.data.leaderboard.rows.length >= 3);
    assert.ok(body.evidence.source_paths.includes('src/kscore-bench.js'));
    assert.ok(body.next_actions.some((a) => /verify:kscore-calibration/.test(a.value)));
  });
});
