// W921 — regression lock-in for two load-breakers found while wiring the
// autopilot/data lanes: src/cost-optimizer.js + src/data-augment.js imported a
// non-existent estimateBatchCost from cost-estimator.js, and
// src/autopilot-bootstrap.js imported a non-existent ingestDescribeEngine from
// data-ingest.js. Both modules failed to even load. These assertions fail fast
// if either export is removed again.

import { test } from 'node:test';
import assert from 'node:assert/strict';

test('#1 cost-optimizer, data-augment, autopilot-bootstrap all import cleanly', async () => {
  await assert.doesNotReject(() => import('../src/cost-optimizer.js'), 'cost-optimizer must load');
  await assert.doesNotReject(() => import('../src/data-augment.js'), 'data-augment must load');
  await assert.doesNotReject(() => import('../src/autopilot-bootstrap.js'), 'autopilot-bootstrap must load');
});

test('#2 cost-estimator exports estimateBatchCost (the missing symbol)', async () => {
  const m = await import('../src/cost-estimator.js');
  assert.equal(typeof m.estimateBatchCost, 'function');
  const r = m.estimateBatchCost({ teachers: [{ slug: 'claude-sonnet-4-6', rows: 10 }], avg_input_tokens: 256, avg_output_tokens: 384 });
  assert.equal(typeof r.total_usd, 'number');
  assert.ok(Array.isArray(r.unknown_models));
  assert.ok(r.assumptions && typeof r.assumptions === 'object');
});

test('#3 data-ingest exports ingestDescribeEngine returning an {ok:true} envelope', async () => {
  const m = await import('../src/data-ingest.js');
  assert.equal(typeof m.ingestDescribeEngine, 'function');
  // Bootstrap path (no teacher base url configured) returns deterministically.
  const out = await m.ingestDescribeEngine({ tenant: 'tenant_test', namespace: 'ns_test', description: 'a tiny support bot for refunds', n: 3 });
  assert.equal(out.ok, true, 'autopilot-bootstrap gates on seed.ok === true');
  assert.ok(Array.isArray(out.rows), 'must carry rows');
});
