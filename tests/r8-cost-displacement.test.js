// R-8 tests for src/cost-displacement.js.
//
// Pins:
//   1. Empty window returns ok with all-zero envelope + ok_status='no_receipts'.
//   2. Manual sum: local + frontier + frontier_fallback mix gives baseline =
//      sum of (frontier-counterfactual for local) + sum of (actual for the
//      others); actual = sum of cost_usd; savings = baseline - actual.
//   3. Missing route_decision => row contributes equally to baseline + actual
//      (no savings claim, counted in unknown_route_count).
//   4. compile_cost_usd = 0 => payback_period_months === 'instant'.
//   5. compile_cost_usd > 0 => payback_period_months ~= compile_cost / monthly_rate.
//   6. negative savings => payback_period_months === null (operator must see
//      it; do not invent a payback time on a regression).
//   7. Cumulative savings uses deployed_at_ms when provided.
//   8. namespace filter excludes other-namespace rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r8-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const cd = await import('../src/cost-displacement.js');

const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 4, 26, 12, 0, 0);
const SINCE_30 = NOW - 30 * DAY;

function rec({ ts, route_decision, cost_usd, input_tokens = 100, output_tokens = 50,
              provider = 'anthropic', model = 'claude-haiku-4-5', namespace = 'ns_test' }) {
  return {
    tenant: 'tenant_r8',
    namespace,
    route_decision,
    provider,
    model,
    cost_usd,
    input_tokens,
    output_tokens,
    ts,
  };
}

// =============================================================================
// 1) Empty window
// =============================================================================

test('R8 #1 — empty window returns ok with all-zero envelope', () => {
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => [],
  });
  assert.equal(out.ok, true);
  assert.equal(out.ok_status, 'no_receipts');
  assert.equal(out.baseline_cost_usd, 0);
  assert.equal(out.actual_cost_usd, 0);
  assert.equal(out.savings_usd, 0);
  assert.equal(out.payback_period_months, 'instant');
});

// =============================================================================
// 2) Manual sum check — mixed routes
// =============================================================================

test('R8 #2 — savings = baseline - actual matches manual sum', () => {
  // Build a small mix:
  //   - 3 local rows: cost_usd = 0, would-be frontier price computed off
  //     claude-haiku-4-5 rate ($0.80/M in, $4.00/M out).
  //     With 100/50 tokens each: per-row baseline =
  //       (100 * 0.80 + 50 * 4.00) / 1_000_000 = 280 / 1_000_000 = $0.00028
  //   - 2 frontier rows: actual = baseline = $0.001 each.
  //   - 1 frontier_fallback row: actual = baseline = $0.005.
  const rows = [
    rec({ ts: NOW - 5 * DAY, route_decision: 'local',
          cost_usd: 0, input_tokens: 100, output_tokens: 50,
          provider: 'anthropic', model: 'claude-haiku-4-5' }),
    rec({ ts: NOW - 5 * DAY, route_decision: 'local',
          cost_usd: 0, input_tokens: 100, output_tokens: 50,
          provider: 'anthropic', model: 'claude-haiku-4-5' }),
    rec({ ts: NOW - 4 * DAY, route_decision: 'local',
          cost_usd: 0, input_tokens: 100, output_tokens: 50,
          provider: 'anthropic', model: 'claude-haiku-4-5' }),
    rec({ ts: NOW - 3 * DAY, route_decision: 'frontier',
          cost_usd: 0.001, provider: 'anthropic', model: 'claude-haiku-4-5' }),
    rec({ ts: NOW - 2 * DAY, route_decision: 'frontier',
          cost_usd: 0.001, provider: 'anthropic', model: 'claude-haiku-4-5' }),
    rec({ ts: NOW - 1 * DAY, route_decision: 'frontier_fallback',
          cost_usd: 0.005, provider: 'anthropic', model: 'claude-haiku-4-5' }),
  ];

  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    frontier_provider: 'anthropic',
    frontier_model: 'claude-haiku-4-5',
  });
  assert.equal(out.ok, true);
  // Manual sums.
  const perLocalCounterfactual = (100 * 0.80 + 50 * 4.00) / 1_000_000; // 0.00028
  const expectedBaseline = 3 * perLocalCounterfactual + 2 * 0.001 + 1 * 0.005;
  const expectedActual = 0 + 0 + 0 + 0.001 + 0.001 + 0.005;
  assert.ok(Math.abs(out.baseline_cost_usd - expectedBaseline) < 1e-9,
    `baseline mismatch: got ${out.baseline_cost_usd}, expected ${expectedBaseline}`);
  assert.ok(Math.abs(out.actual_cost_usd - expectedActual) < 1e-9,
    `actual mismatch: got ${out.actual_cost_usd}, expected ${expectedActual}`);
  assert.ok(Math.abs(out.savings_usd - (expectedBaseline - expectedActual)) < 1e-9);
  assert.equal(out.period.receipt_count, 6);
  assert.equal(out.period.local_count, 3);
  assert.equal(out.period.frontier_count, 2);
  assert.equal(out.period.frontier_fallback_count, 1);
  assert.equal(out.ok_status, 'computed');
});

// =============================================================================
// 3) Missing route_decision => counted as unknown_route_count, no savings.
// =============================================================================

test('R8 #3 — rows without route_decision contribute equally to baseline + actual', () => {
  const rows = [
    { tenant: 'tenant_r8', namespace: 'ns_test', cost_usd: 0.002,
      input_tokens: 100, output_tokens: 50, ts: NOW - 2 * DAY,
      provider: 'anthropic', model: 'claude-haiku-4-5' },
    { tenant: 'tenant_r8', namespace: 'ns_test', cost_usd: 0.003,
      input_tokens: 100, output_tokens: 50, ts: NOW - 1 * DAY,
      provider: 'anthropic', model: 'claude-haiku-4-5' },
  ];
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
  });
  assert.equal(out.ok, true);
  assert.equal(out.savings_usd, 0, 'no savings claim on unknown-route rows');
  assert.equal(out.actual_cost_usd, 0.005);
  assert.equal(out.baseline_cost_usd, 0.005);
  assert.equal(out.period.unknown_route_count, 2);
  assert.equal(out.ok_status, 'no_route_decisions');
});

// =============================================================================
// 4) compile_cost = 0 => payback_period_months = 'instant'
// =============================================================================

test('R8 #4 — compile_cost = 0 => payback_period_months instant', () => {
  const rows = [
    rec({ ts: NOW - 5 * DAY, route_decision: 'local', cost_usd: 0 }),
  ];
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    compile_cost_usd: 0,
    deployed_at_ms: NOW - 10 * DAY,
  });
  assert.equal(out.ok, true);
  assert.equal(out.payback_period_months, 'instant');
});

// =============================================================================
// 5) compile_cost > 0 => payback period computed
// =============================================================================

test('R8 #5 — compile_cost > 0 + positive savings => payback period number', () => {
  // 30 local rows, each $0.001 counterfactual baseline => $0.03 savings/30d
  // monthly rate = (0.03 / 30) * 30 = $0.03/mo
  // compile_cost = $0.30 => payback = 0.30 / 0.03 = 10 months
  //
  // Use bigger token counts so the counterfactual price is meaningful.
  const rows = [];
  for (let i = 0; i < 30; i++) {
    rows.push(rec({
      ts: NOW - (29 - i) * DAY,
      route_decision: 'local',
      cost_usd: 0,
      input_tokens: 1000, output_tokens: 500,
      provider: 'anthropic', model: 'claude-haiku-4-5',
    }));
  }
  // Per-row counterfactual = (1000*0.80 + 500*4.00) / 1_000_000 = $0.0028
  // savings (30d) = 30 * 0.0028 = $0.084
  // monthly rate  = (0.084 / 30) * 30 = $0.084/mo
  // payback @ compile $0.84 = 10 months exactly.
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    compile_cost_usd: 0.84,
    deployed_at_ms: NOW - 30 * DAY,
    frontier_provider: 'anthropic',
    frontier_model: 'claude-haiku-4-5',
  });
  assert.equal(out.ok, true);
  assert.ok(typeof out.payback_period_months === 'number',
    `expected number, got ${typeof out.payback_period_months}: ${out.payback_period_months}`);
  assert.ok(Math.abs(out.payback_period_months - 10) < 0.01,
    `expected payback ~10 months, got ${out.payback_period_months}`);
});

// =============================================================================
// 6) negative savings => payback_period_months = null
// =============================================================================

test('R8 #6 — negative savings => payback_period_months null', () => {
  // All-frontier traffic => savings = 0; with compile_cost > 0, payback
  // is undefined (cannot pay back $X from $0/month). The principled answer
  // is null, not 'never' or 'infinity'.
  const rows = [
    rec({ ts: NOW - 2 * DAY, route_decision: 'frontier', cost_usd: 0.01 }),
    rec({ ts: NOW - 1 * DAY, route_decision: 'frontier', cost_usd: 0.01 }),
  ];
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    compile_cost_usd: 5.00,
    deployed_at_ms: NOW - 10 * DAY,
  });
  assert.equal(out.ok, true);
  assert.equal(out.savings_usd, 0);
  assert.equal(out.payback_period_months, null);
});

// =============================================================================
// 7) Cumulative savings uses deployed_at_ms
// =============================================================================

test('R8 #7 — cumulative savings sums all rows since deployed_at_ms', () => {
  // 5 local rows in the lookback window (last 30 days).
  // 5 more local rows BEFORE the lookback window but AFTER deployed_at_ms.
  // cumulative should include all 10.
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push(rec({
      ts: NOW - (i + 1) * DAY, route_decision: 'local', cost_usd: 0,
      input_tokens: 1000, output_tokens: 500,
    }));
  }
  for (let i = 0; i < 5; i++) {
    rows.push(rec({
      ts: NOW - (40 + i) * DAY, route_decision: 'local', cost_usd: 0,
      input_tokens: 1000, output_tokens: 500,
    }));
  }
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    deployed_at_ms: NOW - 90 * DAY,
    frontier_provider: 'anthropic',
    frontier_model: 'claude-haiku-4-5',
  });
  assert.equal(out.ok, true);
  // Per-row baseline = (1000*0.80 + 500*4.00) / 1_000_000 = 0.0028.
  // Lookback window savings = 5 * 0.0028 = 0.014
  // Cumulative savings (all 10) = 10 * 0.0028 = 0.028
  assert.ok(Math.abs(out.savings_usd - 0.014) < 1e-9, `lookback savings: ${out.savings_usd}`);
  assert.ok(Math.abs(out.cumulative_savings_usd - 0.028) < 1e-9, `cumulative: ${out.cumulative_savings_usd}`);
});

// =============================================================================
// 8) namespace filter excludes other-namespace rows
// =============================================================================

test('R8 #8 — namespace filter excludes other-namespace rows', () => {
  const rows = [
    rec({ ts: NOW - 2 * DAY, route_decision: 'local', cost_usd: 0,
          input_tokens: 1000, output_tokens: 500, namespace: 'ns_test' }),
    rec({ ts: NOW - 2 * DAY, route_decision: 'local', cost_usd: 0,
          input_tokens: 1000, output_tokens: 500, namespace: 'ns_other' }),
    rec({ ts: NOW - 1 * DAY, route_decision: 'frontier', cost_usd: 999,
          namespace: 'ns_other' }),
  ];
  const out = cd.computeDisplacement({
    tenant_id: 'tenant_r8',
    namespace: 'ns_test',
    period_days: 30,
    now: NOW,
    readReceipts: () => rows,
    frontier_provider: 'anthropic',
    frontier_model: 'claude-haiku-4-5',
  });
  assert.equal(out.ok, true);
  assert.equal(out.period.receipt_count, 1);
  assert.equal(out.period.local_count, 1);
  assert.equal(out.period.frontier_count, 0);
  // ns_other's $999 frontier row must not leak in.
  assert.ok(out.actual_cost_usd < 1, `actual leaked from ns_other: ${out.actual_cost_usd}`);
});

// =============================================================================
// 9) Bad input
// =============================================================================

test('R8 #9 — bad input rejected', () => {
  const noTenant = cd.computeDisplacement({ namespace: 'ns' });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'tenant_id_required');

  const badDays = cd.computeDisplacement({ tenant_id: 't', period_days: 0 });
  assert.equal(badDays.ok, false);
  assert.equal(badDays.error, 'invalid_period_days');

  const tooMany = cd.computeDisplacement({ tenant_id: 't', period_days: 99999 });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error, 'invalid_period_days');
});
