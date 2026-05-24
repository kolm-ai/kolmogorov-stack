// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import {
  QUALITY_CALIBRATION_CASES,
  QUALITY_CALIBRATION_THRESHOLDS,
  runQualityCalibration,
} from '../src/quality-calibration.js';
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

test('W588 #1 - quality judge calibration fixture covers pass/fail labels by task class', () => {
  assert.ok(QUALITY_CALIBRATION_CASES.length >= QUALITY_CALIBRATION_THRESHOLDS.min_cases);
  const byClass = QUALITY_CALIBRATION_CASES.reduce((acc, c) => {
    acc[c.task_type] = (acc[c.task_type] || 0) + 1;
    return acc;
  }, {});
  for (const taskType of ['classification', 'code', 'extraction', 'generation', 'legal', 'privacy', 'safety', 'translation']) {
    assert.ok(byClass[taskType] >= 1, `${taskType} missing from quality calibration`);
  }
  const labels = new Set(QUALITY_CALIBRATION_CASES.map((c) => c.gold_label));
  assert.deepEqual([...labels].sort(), ['fail', 'pass']);
  const report = runQualityCalibration({ generatedAt: '2026-05-23T00:00:00.000Z' });
  const wrongIntent = report.rows.find((c) => c.id === 'classification-wrong-intent');
  assert.equal(wrongIntent.predicted_label, 'fail');
  assert.equal(wrongIntent.correct, true);
});

test('W588 #2 - quality calibration reports agreement, MAE, and zero false accepts', () => {
  const report = runQualityCalibration({
    generatedAt: '2026-05-23T00:00:00.000Z',
    includeCases: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.spec, 'kolm-quality-judge-calibration-1');
  assert.equal(report.counts.cases, QUALITY_CALIBRATION_CASES.length);
  assert.equal(report.metrics.agreement, 1);
  assert.equal(report.metrics.confusion.fp, 0);
  assert.equal(report.metrics.confusion.fn, 0);
  assert.ok(report.metrics.brier <= QUALITY_CALIBRATION_THRESHOLDS.max_brier);
  assert.equal(report.metrics.by_task_type.safety.agreement, 1);
  assert.match(report.note, /deterministic local judge-calibration contract/);
});

test('W588 #3 - GET /v1/eval/quality-calibration is public, enveloped, and secret-safe', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/eval/quality-calibration');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-surface'), 'capture-data-eval-training');
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.surface, 'capture-data-eval-training');
    assert.equal(body.readiness.status, 'implemented');
    assert.equal(body.data.secret_values_included, false);
    assert.equal(body.data.calibration.ok, true);
    assert.equal(body.data.calibration.metrics.agreement, 1);
    assert.equal(body.data.calibration.metrics.confusion.fp, 0);
    assert.ok(body.evidence.source_paths.includes('src/quality-calibration.js'));
    assert.ok(body.next_actions.some((a) => /verify:quality-calibration/.test(a.value)));
  });
});
