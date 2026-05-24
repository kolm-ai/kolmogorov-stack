// @public-routes-only
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { runRedactionBenchmark } from '../src/redaction-benchmark.js';
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

test('W586 #1 - public redaction benchmark module reports precision, recall, and F1', () => {
  const report = runRedactionBenchmark({
    generatedAt: '2026-05-23T00:00:00.000Z',
    includeHost: false,
  });
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.equal(report.spec, 'kolm-redaction-benchmark-1');
  assert.equal(report.host, undefined, 'public benchmark report must not leak host metadata when includeHost=false');
  assert.equal(report.totals.tp, 9);
  assert.equal(report.totals.fp, 0);
  assert.equal(report.totals.fn, 0);
  assert.equal(report.totals.precision, 1);
  assert.equal(report.totals.recall, 1);
  assert.equal(report.totals.f1, 1);
  assert.ok(Object.keys(report.per_type).includes('ssn'));
  assert.match(report.note, /Synthetic public fixture benchmark/);
});

test('W586 #2 - GET /v1/privacy/redaction-benchmark is public, enveloped, and secret-safe', async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(buildRouter());
  await withServer(app, async (base) => {
    const res = await fetch(base + '/v1/privacy/redaction-benchmark');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-kolm-surface'), 'governance-compliance-security');
    assert.equal(res.headers.get('x-kolm-readiness'), 'implemented');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.surface, 'governance-compliance-security');
    assert.equal(body.readiness.status, 'implemented');
    assert.equal(body.data.secret_values_included, false);
    assert.equal(body.data.benchmark.ok, true);
    assert.equal(body.data.benchmark.host, undefined);
    assert.equal(body.data.benchmark.totals.f1, 1);
    assert.ok(body.evidence.source_paths.includes('src/redaction-benchmark.js'));
    assert.ok(body.next_actions.some((a) => /verify:redaction-benchmark/.test(a.value)));
  });
});
