// R-7 tests for src/drift-detector.js.
//
// Pins:
//   1. pseudoEmbed is deterministic + L2-normalized.
//   2. Similar capture sets => status === 'ok' (or at worst 'warn' on
//      tiny tails of variance).
//   3. Very different capture sets => status transitions to 'alert'.
//   4. Rising fallback rate is picked up as drift even when captures are
//      identical (signal #1).
//   5. Volume ratio drift fires when traffic jumps by a wide margin.
//   6. Receipts without route_decision are excluded from the fallback rate
//      (older rows must never be treated as 'frontier_fallback' OR as
//      'local' — they're 'unknown' and don't count).
//   7. Recommendation string includes the literal CLI command.
//   8. tenant_id required; bad input returns ok:false with hint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const TEST_DATA_DIR = path.join(os.tmpdir(), 'kolm-r7-' + crypto.randomBytes(4).toString('hex'));
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.KOLM_DATA_DIR = TEST_DATA_DIR;
process.env.KOLM_HOME = TEST_DATA_DIR;
process.env.HOME = TEST_DATA_DIR;
process.env.USERPROFILE = TEST_DATA_DIR;

const dd = await import('../src/drift-detector.js');

// Helper to build a receipt row with our expected fields.
function receipt({ ts, route_decision, namespace = 'ns_test' }) {
  return {
    tenant: 'tenant_r7',
    namespace,
    route_decision,
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    cost_usd: 0.001,
    input_tokens: 100,
    output_tokens: 50,
    ts,
  };
}

function capture({ ts, text, namespace = 'ns_test' }) {
  return {
    tenant: 'tenant_r7',
    namespace,
    prompt_redacted: text,
    ts,
  };
}

// 30 days baseline + 7 days lookback => total 37 days of rows.
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 4, 26, 12, 0, 0); // 2026-05-26 12:00 UTC
const LOOKBACK_DAYS = 7;
const BASELINE_DAYS = 30;
const LOOKBACK_START = NOW - LOOKBACK_DAYS * DAY;
const BASELINE_END = LOOKBACK_START;
const BASELINE_START = BASELINE_END - BASELINE_DAYS * DAY;

// =============================================================================
// 1) pseudoEmbed is deterministic + L2-normalized
// =============================================================================

test('R7 #1 — pseudoEmbed is deterministic + L2-normalized', () => {
  const a = dd.pseudoEmbed('hello world from kolm');
  const b = dd.pseudoEmbed('hello world from kolm');
  assert.equal(a.length, dd.PSEUDO_EMBEDDING_DIM);
  for (let i = 0; i < a.length; i++) assert.equal(a[i], b[i]);
  let norm = 0;
  for (let i = 0; i < a.length; i++) norm += a[i] * a[i];
  assert.ok(Math.abs(Math.sqrt(norm) - 1) < 1e-9, 'pseudoEmbed must be L2-normalized');
  // Empty input -> zero vector (no NaN).
  const z = dd.pseudoEmbed('');
  for (let i = 0; i < z.length; i++) assert.equal(z[i], 0);
});

// =============================================================================
// 2) Similar capture sets => status 'ok'
// =============================================================================

test('R7 #2 — similar baseline + lookback => status ok', () => {
  // Build matched per-day rates (~10/day) so volume_ratio ≈ 1.0; matched
  // vocabulary so distribution_distance ≈ 0; matched fallback rate (~10%)
  // so fallback_rate_delta ≈ 0. All three signals stay within sigma.
  const phrases = [
    'support ticket order status',
    'refund request shipping delay',
    'cancel subscription billing question',
    'tracking number not updating',
    'discount code did not apply',
    'change shipping address please',
  ];
  function pickPhrase(i) { return phrases[i % phrases.length]; }
  const baselineCaps = [];
  const baselineReceipts = [];
  const PER_DAY = 10;
  for (let d = 0; d < BASELINE_DAYS; d++) {
    for (let j = 0; j < PER_DAY; j++) {
      const t = BASELINE_START + d * DAY + Math.floor((j / PER_DAY) * DAY);
      const idx = d * PER_DAY + j;
      baselineCaps.push(capture({ ts: t, text: pickPhrase(idx) }));
      baselineReceipts.push(receipt({
        ts: t,
        route_decision: idx % 10 === 0 ? 'frontier_fallback' : 'local',
      }));
    }
  }
  const lookbackCaps = [];
  const lookbackReceipts = [];
  for (let d = 0; d < LOOKBACK_DAYS; d++) {
    for (let j = 0; j < PER_DAY; j++) {
      const t = LOOKBACK_START + d * DAY + Math.floor((j / PER_DAY) * DAY);
      const idx = d * PER_DAY + j;
      lookbackCaps.push(capture({ ts: t, text: pickPhrase(idx) }));
      lookbackReceipts.push(receipt({
        ts: t,
        route_decision: idx % 10 === 0 ? 'frontier_fallback' : 'local',
      }));
    }
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => [...baselineCaps, ...lookbackCaps],
  });
  assert.equal(out.ok, true);
  // Distance must be small for vocabulary-matched windows.
  assert.ok(out.distribution_distance != null && out.distribution_distance < 0.05,
    `expected small distribution_distance, got ${out.distribution_distance}`);
  // Fallback rates are within ~0; status should NOT be 'alert'.
  assert.notEqual(out.status, 'alert');
  // Recommendation null on 'ok'.
  if (out.status === 'ok') assert.equal(out.recommendation, null);
});

// =============================================================================
// 3) Very different capture sets => status transitions to 'alert'
// =============================================================================

test('R7 #3 — very different lookback vocabulary => status alert', () => {
  // Baseline: support-vertical phrases.
  const baselineVocab = [
    'support ticket order status',
    'refund request shipping delay',
    'cancel subscription billing question',
    'tracking number not updating',
    'discount code did not apply',
    'change shipping address please',
  ];
  // Lookback: completely orthogonal vertical (medical chatbot).
  const lookbackVocab = [
    'patient blood pressure reading elevated',
    'medication dosage twice daily morning',
    'symptoms fever cough headache fatigue',
    'appointment reschedule next available slot',
    'prescription refill pharmacy local',
    'allergic reaction antihistamine recommended',
  ];
  const baselineCaps = [];
  for (let i = 0; i < 60; i++) {
    const t = BASELINE_START + Math.floor((i / 60) * BASELINE_DAYS * DAY);
    baselineCaps.push(capture({ ts: t, text: baselineVocab[i % baselineVocab.length] }));
  }
  const lookbackCaps = [];
  for (let i = 0; i < 30; i++) {
    const t = LOOKBACK_START + Math.floor((i / 30) * LOOKBACK_DAYS * DAY);
    lookbackCaps.push(capture({ ts: t, text: lookbackVocab[i % lookbackVocab.length] }));
  }
  const baselineReceipts = [];
  for (let i = 0; i < 60; i++) {
    const t = BASELINE_START + Math.floor((i / 60) * BASELINE_DAYS * DAY);
    baselineReceipts.push(receipt({ ts: t, route_decision: 'local' }));
  }
  // Lookback: fallback rate jumps from ~0% to ~70%, mirroring the vocabulary
  // drift (the artifact stops recognizing the medical prompts).
  const lookbackReceipts = [];
  for (let i = 0; i < 30; i++) {
    const t = LOOKBACK_START + Math.floor((i / 30) * LOOKBACK_DAYS * DAY);
    lookbackReceipts.push(receipt({ ts: t, route_decision: i % 10 < 7 ? 'frontier_fallback' : 'local' }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => [...baselineCaps, ...lookbackCaps],
  });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'alert',
    `expected status alert; got ${out.status} (delta=${out.fallback_rate_delta}, dist=${out.distribution_distance})`);
  // Both fallback + distribution signals should be flagged.
  assert.notEqual(out.details.per_signal_status.fallback, 'ok');
  assert.notEqual(out.details.per_signal_status.distribution, 'ok');
  // Recommendation present.
  assert.ok(out.recommendation && out.recommendation.includes('kolm distill'));
  assert.ok(out.recommendation.includes('--namespace ns_test'));
  assert.ok(out.recommendation.includes('fallback_eligible'));
});

// =============================================================================
// 4) Rising fallback rate alone fires drift (captures identical)
// =============================================================================

test('R7 #4 — fallback-rate spike alone trips drift', () => {
  // Identical text everywhere — distribution_distance should be ~0.
  const text = 'support ticket order status';
  const baselineCaps = [];
  for (let i = 0; i < 60; i++) {
    const t = BASELINE_START + Math.floor((i / 60) * BASELINE_DAYS * DAY);
    baselineCaps.push(capture({ ts: t, text }));
  }
  const lookbackCaps = [];
  for (let i = 0; i < 30; i++) {
    const t = LOOKBACK_START + Math.floor((i / 30) * LOOKBACK_DAYS * DAY);
    lookbackCaps.push(capture({ ts: t, text }));
  }
  // Baseline: 0% fallback. Lookback: 80% fallback.
  const baselineReceipts = [];
  for (let i = 0; i < 60; i++) {
    const t = BASELINE_START + Math.floor((i / 60) * BASELINE_DAYS * DAY);
    baselineReceipts.push(receipt({ ts: t, route_decision: 'local' }));
  }
  const lookbackReceipts = [];
  for (let i = 0; i < 30; i++) {
    const t = LOOKBACK_START + Math.floor((i / 30) * LOOKBACK_DAYS * DAY);
    lookbackReceipts.push(receipt({ ts: t, route_decision: i % 5 < 4 ? 'frontier_fallback' : 'local' }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => [...baselineCaps, ...lookbackCaps],
  });
  assert.equal(out.ok, true);
  assert.ok(out.fallback_rate_delta != null && out.fallback_rate_delta > 0.5,
    `expected large fallback_rate_delta, got ${out.fallback_rate_delta}`);
  assert.ok(out.status === 'alert' || out.status === 'warn',
    `expected warn or alert, got ${out.status}`);
});

// =============================================================================
// 5) Volume ratio drift fires when traffic jumps wide
// =============================================================================

test('R7 #5 — volume ratio drift fires when traffic jumps 10x', () => {
  const text = 'order status please';
  const baselineCaps = [];
  // Baseline: ~1 cap/day average across 30 days (30 rows).
  for (let i = 0; i < 30; i++) {
    const t = BASELINE_START + i * DAY;
    baselineCaps.push(capture({ ts: t, text }));
  }
  // Lookback: 100 captures across 7 days => ~14/day vs baseline 1/day.
  const lookbackCaps = [];
  for (let i = 0; i < 100; i++) {
    const t = LOOKBACK_START + Math.floor((i / 100) * LOOKBACK_DAYS * DAY);
    lookbackCaps.push(capture({ ts: t, text }));
  }
  const baselineReceipts = [];
  for (let i = 0; i < 30; i++) {
    const t = BASELINE_START + i * DAY;
    baselineReceipts.push(receipt({ ts: t, route_decision: 'local' }));
  }
  const lookbackReceipts = [];
  for (let i = 0; i < 100; i++) {
    const t = LOOKBACK_START + Math.floor((i / 100) * LOOKBACK_DAYS * DAY);
    lookbackReceipts.push(receipt({ ts: t, route_decision: 'local' }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => [...baselineCaps, ...lookbackCaps],
  });
  assert.equal(out.ok, true);
  assert.ok(out.volume_ratio != null && out.volume_ratio > 5,
    `expected volume_ratio >>1, got ${out.volume_ratio}`);
  assert.notEqual(out.details.per_signal_status.volume, 'ok');
});

// =============================================================================
// 6) Missing route_decision rows are excluded from the fallback rate.
// =============================================================================

test('R7 #6 — receipts without route_decision are excluded from fallback rate', () => {
  // 30 baseline rows, NONE with route_decision. 30 lookback rows, also
  // NONE. fallback_rate_delta should be null (not 0).
  const baselineReceipts = [];
  for (let i = 0; i < 30; i++) {
    const t = BASELINE_START + Math.floor((i / 30) * BASELINE_DAYS * DAY);
    const r = receipt({ ts: t, route_decision: 'local' });
    delete r.route_decision;
    baselineReceipts.push(r);
  }
  const lookbackReceipts = [];
  for (let i = 0; i < 30; i++) {
    const t = LOOKBACK_START + Math.floor((i / 30) * LOOKBACK_DAYS * DAY);
    const r = receipt({ ts: t, route_decision: 'local' });
    delete r.route_decision;
    lookbackReceipts.push(r);
  }
  // Captures must be present so the function doesn't bail on insufficient
  // baseline; we want to assert specifically that fallback_rate_delta is null.
  const caps = [];
  for (let i = 0; i < 30; i++) {
    caps.push(capture({ ts: BASELINE_START + i * DAY, text: 'order status' }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => caps,
  });
  assert.equal(out.ok, true);
  assert.equal(out.fallback_rate_delta, null,
    'rows without route_decision must NOT contribute to fallback rate');
  assert.equal(out.details.lookback.fallback_rate, null);
  assert.equal(out.details.baseline.fallback_rate, null);
});

// =============================================================================
// 7) Recommendation includes literal CLI command.
// =============================================================================

test('R7 #7 — recommendation contains literal CLI command on warn/alert', () => {
  // Force an alert path by re-running test #3's scenario at a smaller scale.
  const baselineCaps = [];
  for (let i = 0; i < 30; i++) {
    baselineCaps.push(capture({ ts: BASELINE_START + i * DAY, text: 'order status please' }));
  }
  const lookbackCaps = [];
  for (let i = 0; i < 20; i++) {
    lookbackCaps.push(capture({ ts: LOOKBACK_START + i * 8 * 3600 * 1000, text: 'patient blood pressure dosage' }));
  }
  const baselineReceipts = [];
  for (let i = 0; i < 30; i++) {
    baselineReceipts.push(receipt({ ts: BASELINE_START + i * DAY, route_decision: 'local', namespace: 'mynamespace' }));
  }
  const lookbackReceipts = [];
  for (let i = 0; i < 20; i++) {
    lookbackReceipts.push(receipt({
      ts: LOOKBACK_START + i * 8 * 3600 * 1000,
      route_decision: i < 18 ? 'frontier_fallback' : 'local',
      namespace: 'mynamespace',
    }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'mynamespace',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [
      ...baselineReceipts.map(r => ({ ...r, namespace: 'mynamespace' })),
      ...lookbackReceipts.map(r => ({ ...r, namespace: 'mynamespace' })),
    ],
    readCaptures: () => [
      ...baselineCaps.map(c => ({ ...c, namespace: 'mynamespace' })),
      ...lookbackCaps.map(c => ({ ...c, namespace: 'mynamespace' })),
    ],
  });
  assert.equal(out.ok, true);
  if (out.status === 'warn' || out.status === 'alert') {
    assert.ok(typeof out.recommendation === 'string');
    assert.match(out.recommendation, /kolm distill --namespace mynamespace --priority-captures fallback_eligible --limit 200/);
  }
});

// =============================================================================
// 8) Bad input — tenant_id required.
// =============================================================================

test('R7 #8 — tenant_id required + invalid windows rejected', () => {
  const noTenant = dd.computeDriftSignals({ namespace: 'ns' });
  assert.equal(noTenant.ok, false);
  assert.equal(noTenant.error, 'tenant_id_required');

  const badLb = dd.computeDriftSignals({ tenant_id: 't', lookback_days: -1 });
  assert.equal(badLb.ok, false);
  assert.equal(badLb.error, 'invalid_lookback_days');

  const badBs = dd.computeDriftSignals({ tenant_id: 't', baseline_days: 0 });
  assert.equal(badBs.ok, false);
  assert.equal(badBs.error, 'invalid_baseline_days');
});

// =============================================================================
// 9) Cross-tenant + cross-namespace filtering.
// =============================================================================

test('R7 #9 — namespace filter excludes other-namespace rows', () => {
  // Mix in rows for ns_other with very different vocabulary. The function
  // must filter them out before computing distance.
  const text = 'order status please';
  const baselineCaps = [];
  for (let i = 0; i < 30; i++) {
    baselineCaps.push(capture({ ts: BASELINE_START + i * DAY, text }));
  }
  // Other-namespace noise (would skew distance if leaked in).
  for (let i = 0; i < 60; i++) {
    baselineCaps.push(capture({
      ts: BASELINE_START + i * DAY * 0.5,
      text: 'medical patient prescription dosage refill',
      namespace: 'ns_other',
    }));
  }
  const lookbackCaps = [];
  for (let i = 0; i < 20; i++) {
    lookbackCaps.push(capture({ ts: LOOKBACK_START + i * 8 * 3600 * 1000, text }));
  }
  const baselineReceipts = [];
  for (let i = 0; i < 30; i++) {
    baselineReceipts.push(receipt({ ts: BASELINE_START + i * DAY, route_decision: 'local' }));
  }
  const lookbackReceipts = [];
  for (let i = 0; i < 20; i++) {
    lookbackReceipts.push(receipt({ ts: LOOKBACK_START + i * 8 * 3600 * 1000, route_decision: 'local' }));
  }
  const out = dd.computeDriftSignals({
    tenant_id: 'tenant_r7',
    namespace: 'ns_test',
    lookback_days: LOOKBACK_DAYS,
    baseline_days: BASELINE_DAYS,
    now: NOW,
    readReceipts: () => [...baselineReceipts, ...lookbackReceipts],
    readCaptures: () => [...baselineCaps, ...lookbackCaps],
  });
  assert.equal(out.ok, true);
  // Distance should be ~0 because we only see same-text rows after the filter.
  assert.ok(out.distribution_distance != null && out.distribution_distance < 0.05,
    `distance leaked from ns_other; got ${out.distribution_distance}`);
});
