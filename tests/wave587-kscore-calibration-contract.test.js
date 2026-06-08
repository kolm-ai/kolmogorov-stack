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
