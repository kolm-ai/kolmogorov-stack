// W709 - direct contract for src/usage-analytics.js.
//
// Usage analytics feeds dashboard and billing-adjacent reporting. The contract
// pins bounded aggregation, safe bucket keys, strict timestamp handling, and
// status-aware error accounting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  USAGE_ANALYTICS_CONTRACT_VERSION,
  USAGE_ANALYTICS_LIMITS,
  USAGE_ANALYTICS_VERSION,
  dashboardSummary,
  summarizeCaptures,
  summarizeDriftSignals,
  summarizeInvocations,
} from '../src/usage-analytics.js';

const ROOT = path.resolve(import.meta.dirname, '..');

test('W709 source pins usage analytics contract and package depth wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'usage-analytics.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.match(src, /USAGE_ANALYTICS_VERSION\s*=\s*'w709-usage-analytics-v1'/);
  assert.match(src, /USAGE_ANALYTICS_CONTRACT_VERSION\s*=\s*'w709-v1'/);
  assert.match(src, /MAX_ROWS:\s*50_000/);
  assert.match(src, /Object\.create\(null\)/);
  assert.match(src, /reserved_key/);
  assert.match(src, /Number\.isFinite\(d\.getTime\(\)\)/);
  assert.equal(
    pkg.scripts['verify:usage-analytics'],
    'node --test --test-concurrency=1 tests/wave709-usage-analytics-contract.test.js',
  );
  assert.match(
    pkg.scripts['verify:depth'],
    /verify:marketplace-store && npm run verify:usage-analytics && npm run verify:sdk-ts/,
  );
});

test('W709 summarizeCaptures is bounded, strict on dates, and bucket-key safe', () => {
  const rows = [
    {
      namespace: 'claims',
      runtime_target: 'cpu',
      ts: '2026-06-17T12:00:00.000Z',
      latency_us: 10,
      status: 200,
      durable: true,
    },
    {
      namespace: '__proto__',
      runtime_target: 'gpu',
      timestamp: 'not-a-date',
      latency_us: 30,
      status: '500',
    },
    {
      namespace: 'constructor',
      runtime_target: 'cpu',
      recorded_at: '2026-06-18T01:00:00+02:00',
      latency_us: 20,
      error: 'failed',
    },
  ];

  const out = summarizeCaptures(rows, { since: '2026-06-01' });
  assert.equal(out.version, USAGE_ANALYTICS_VERSION);
  assert.equal(out.contract_version, USAGE_ANALYTICS_CONTRACT_VERSION);
  assert.equal(out.total, 3);
  assert.equal(out.input_count, 3);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.by_namespace, { claims: 1, reserved_key: 2 });
  assert.deepEqual(out.by_runtime_target, { cpu: 2, gpu: 1 });
  assert.deepEqual(out.by_day, { '2026-06-17': 2 });
  assert.equal(out.p50_latency_us, 20);
  assert.equal(out.p95_latency_us, 30);
  assert.equal(out.p99_latency_us, 30);
  assert.equal(out.error_count, 2);
  assert.equal(out.error_rate, 2 / 3);
  assert.equal(out.durable_count, 1);
  assert.equal(Object.hasOwn(out.by_namespace, '__proto__'), false);
  assert.equal({}.polluted, undefined);
});

test('W709 summarizeInvocations counts HTTP status failures and safe recipe/version buckets', () => {
  const out = summarizeInvocations([
    { concept_id: 'recipe-a', version_id: 'v1', latency_us: 100, cache_hit: true, status: 200 },
    { concept_id: '__proto__', version_id: 'prototype', latency_us: 300, status: 503 },
    { recipe_id: 'recipe-a', version_id: 'v2', latency_us: -1, error: true },
  ]);

  assert.equal(out.total, 3);
  assert.deepEqual(out.by_recipe, { 'recipe-a': 2, reserved_key: 1 });
  assert.deepEqual(out.by_version, { reserved_key: 1, v1: 1, v2: 1 });
  assert.equal(out.cache_hit_count, 1);
  assert.equal(out.cache_hit_rate, 1 / 3);
  assert.equal(out.p50_latency_us, 300);
  assert.equal(out.p95_latency_us, 300);
  assert.equal(out.error_count, 2);
  assert.equal(out.error_rate, 2 / 3);
});

test('W709 summarizeDriftSignals sanitizes axes and derives last valid observation time', () => {
  const out = summarizeDriftSignals([
    { kind: 'drift_observation', payload: { signal: { axis: 'quality' } }, timestamp: '2026-06-17T00:00:00Z' },
    { kind: 'drift_observation', payload: { axis: '__proto__' }, timestamp: 'invalid' },
    { kind: 'regression_flag', payload: {}, timestamp: '2026-06-19T03:00:00+03:00' },
    { kind: 'ignored', payload: { axis: 'ignored' }, timestamp: '2026-06-20T00:00:00Z' },
  ]);

  assert.equal(out.drift_count, 2);
  assert.equal(out.regression_count, 1);
  assert.equal(out.total, 3);
  assert.deepEqual(out.by_axis, { quality: 1, reserved_key: 1 });
  assert.equal(out.last_observed, '2026-06-19T00:00:00.000Z');
});

test('W709 aggregators cap hostile input size deterministically', () => {
  const rows = Array.from({ length: USAGE_ANALYTICS_LIMITS.MAX_ROWS + 5 }, (_, i) => ({
    namespace: `ns-${i}`,
    ts: '2026-06-17T00:00:00Z',
    latency_us: i,
  }));
  const out = summarizeCaptures(rows);

  assert.equal(out.input_count, USAGE_ANALYTICS_LIMITS.MAX_ROWS + 5);
  assert.equal(out.total, USAGE_ANALYTICS_LIMITS.MAX_ROWS);
  assert.equal(out.truncated, true);
  assert.equal(out.by_namespace['ns-0'], 1);
  assert.equal(out.by_namespace[`ns-${USAGE_ANALYTICS_LIMITS.MAX_ROWS - 1}`], 1);
  assert.equal(out.by_namespace[`ns-${USAGE_ANALYTICS_LIMITS.MAX_ROWS}`], undefined);
});

test('W709 dashboardSummary carries versioned sub-summaries', () => {
  const out = dashboardSummary({
    captures: [{ namespace: 'n', ts: '2026-06-17T00:00:00Z' }],
    invocations: [{ concept_id: 'c', version_id: 'v', status: 200 }],
    driftEvents: [{ kind: 'regression_flag', timestamp: '2026-06-18T00:00:00Z' }],
    since: '2026-06-01',
  });

  assert.equal(out.version, USAGE_ANALYTICS_VERSION);
  assert.equal(out.contract_version, USAGE_ANALYTICS_CONTRACT_VERSION);
  assert.equal(out.captures.contract_version, USAGE_ANALYTICS_CONTRACT_VERSION);
  assert.equal(out.invocations.contract_version, USAGE_ANALYTICS_CONTRACT_VERSION);
  assert.equal(out.drift.contract_version, USAGE_ANALYTICS_CONTRACT_VERSION);
  assert.equal(out.window.since, '2026-06-01');
  assert.match(out.generated_at, /^\d{4}-\d{2}-\d{2}T/);
});
