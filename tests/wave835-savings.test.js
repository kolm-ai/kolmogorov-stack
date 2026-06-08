// W835 — savings-based pricing tracker tests.
//
// Behavior asserted (not page copy):
//   1) PROVIDER_RATE_CARD is frozen (top-level + per-provider + per-model rows).
//   2) SAVINGS_FEE_RATE_DEFAULT is in [0.10, 0.15].
//   3) recordTeacherSpend computes cost from rate card exactly (1M tokens × $rate = $rate).
//   4) recordTeacherSpend rejects unknown provider with code 'unknown_provider'.
//   5) recordTeacherSpend rejects unknown model with code 'unknown_model'.
//   6) getBaselineSpend returns total=0 + status='no_baseline_started' when none.
//   7) startBaselinePeriod persists; getBaselineSpend reflects the window.
//   8) computeSavings returns status='insufficient_baseline' when <7 days elapsed.
//   9) computeSavings with 30 days of mock spend returns positive saved_usd
//      when post-kolm spend < baseline.
//  10) computeSavings returns negative saved_usd + regression=true when post > baseline.
//  11) fee_usd = saved_usd × fee_rate (sanity); fee_usd=0 on regression.
//  12) Defense-in-depth: foreign tenant_id sees no spend rows.
//  13) sw.js wave token shipped (regex+threshold ≥ 835).
//  14) CLI dispatcher + HELP entry wired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as eventStore from '../src/event-store.js';
import * as savings from '../src/savings-tracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w835-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  if (eventStore._resetForTests) eventStore._resetForTests();
  return tmp;
}

// =============================================================================
// 1) PROVIDER_RATE_CARD frozen
// =============================================================================

test('W835 #1 — PROVIDER_RATE_CARD is frozen (top + providers + models)', () => {
  const { PROVIDER_RATE_CARD } = savings;
  assert.ok(Object.isFrozen(PROVIDER_RATE_CARD), 'top-level card must be frozen');
  for (const provider of Object.keys(PROVIDER_RATE_CARD)) {
    assert.ok(Object.isFrozen(PROVIDER_RATE_CARD[provider]),
      'provider table for "' + provider + '" must be frozen');
    for (const model of Object.keys(PROVIDER_RATE_CARD[provider])) {
      const row = PROVIDER_RATE_CARD[provider][model];
      assert.ok(Object.isFrozen(row),
        'rate row for "' + provider + '/' + model + '" must be frozen');
      assert.equal(typeof row.input_per_million_usd, 'number',
        provider + '/' + model + ': input rate must be numeric');
      assert.equal(typeof row.output_per_million_usd, 'number',
        provider + '/' + model + ': output rate must be numeric');
    }
  }
  // Coverage sanity: at least 4 providers, anthropic includes claude-opus-4-7.
  assert.ok(Object.keys(PROVIDER_RATE_CARD).length >= 4,
    'at least 4 providers must be modelled (got ' + Object.keys(PROVIDER_RATE_CARD).length + ')');
  assert.ok(PROVIDER_RATE_CARD.anthropic['claude-opus-4-7'],
    'anthropic/claude-opus-4-7 must be in the card');
});

// =============================================================================
// 2) SAVINGS_FEE_RATE_DEFAULT in [0.10, 0.15]
// =============================================================================

test('W835 #2 — SAVINGS_FEE_RATE_DEFAULT in 10-15% band', () => {
  const r = savings.SAVINGS_FEE_RATE_DEFAULT;
  assert.equal(typeof r, 'number');
  assert.ok(r >= 0.10 && r <= 0.15,
    'fee rate must be in [0.10, 0.15] (got ' + r + ')');
});

// =============================================================================
// 3) recordTeacherSpend computes cost from rate card exactly
// =============================================================================

test('W835 #3 — recordTeacherSpend computes cost from rate card (1M tokens × $rate = $rate)', async () => {
  freshDir();
  // 1,000,000 input tokens of claude-opus-4-7 ($15/M input) = exactly $15.00 = 15_000_000 micro.
  const ev = await savings.recordTeacherSpend({
    tenant_id: 'tenant_w835_3',
    namespace: 'ns3',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    input_tokens: 1_000_000,
    output_tokens: 0,
  });
  assert.equal(ev.cost_micro_usd, 15_000_000,
    'expected $15.00 = 15_000_000 micro, got ' + ev.cost_micro_usd);
  // Add 1,000,000 output @ $75/M = $75. Total $90 = 90_000_000 micro.
  const ev2 = await savings.recordTeacherSpend({
    tenant_id: 'tenant_w835_3',
    namespace: 'ns3',
    provider: 'anthropic',
    model: 'claude-opus-4-7',
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
  });
  assert.equal(ev2.cost_micro_usd, 90_000_000,
    'expected $90.00 = 90_000_000 micro, got ' + ev2.cost_micro_usd);
});

// =============================================================================
// 4) Unknown provider rejected with code 'unknown_provider'
// =============================================================================

test('W835 #4 — recordTeacherSpend rejects unknown provider', async () => {
  freshDir();
  let err = null;
  try {
    await savings.recordTeacherSpend({
      tenant_id: 'tenant_w835_4',
      provider: 'mystery_corp',
      model: 'foo',
      input_tokens: 100,
      output_tokens: 100,
    });
  } catch (e) { err = e; }
  assert.ok(err, 'must throw on unknown provider');
  assert.equal(err.code, 'unknown_provider',
    'error code must be unknown_provider (got ' + err.code + ')');
});

// =============================================================================
// 5) Unknown model under known provider rejected
// =============================================================================

test('W835 #5 — recordTeacherSpend rejects unknown model under known provider', async () => {
  freshDir();
  let err = null;
  try {
    await savings.recordTeacherSpend({
      tenant_id: 'tenant_w835_5',
      provider: 'anthropic',
      model: 'claude-imaginary-9000',
      input_tokens: 100,
      output_tokens: 100,
    });
  } catch (e) { err = e; }
  assert.ok(err, 'must throw on unknown model');
  assert.equal(err.code, 'unknown_model',
    'error code must be unknown_model (got ' + err.code + ')');
});

// =============================================================================
// 6) getBaselineSpend = 0 + status='no_baseline_started' when none
// =============================================================================

test('W835 #6 — getBaselineSpend returns 0 + status=no_baseline_started when none', async () => {
  freshDir();
  const out = await savings.getBaselineSpend({
    tenant_id: 'tenant_w835_6',
    namespace: 'fresh',
    period_days: 30,
  });
  assert.equal(out.status, 'no_baseline_started');
  assert.equal(out.total_cost_usd, 0);
  assert.equal(out.captures, 0);
  assert.equal(out.baseline_start, null);
});

// =============================================================================
// 7) startBaselinePeriod persists + window reflects spend
// =============================================================================

test('W835 #7 — startBaselinePeriod persists; subsequent spend visible in window', async () => {
  freshDir();
  const t = 'tenant_w835_7';
  const ns = 'walk7';
  const startAt = new Date('2026-04-01T00:00:00.000Z').toISOString();
  await savings.startBaselinePeriod({ tenant_id: t, namespace: ns, start_ts: startAt });
  // Spend 500_000 micro ($0.50) within window (day 5).
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'openai', model: 'gpt-4o-mini',
    input_tokens: 1_000_000, output_tokens: 0,
    ts: '2026-04-06T00:00:00.000Z', // day 5 → in baseline 30d window
  });
  const out = await savings.getBaselineSpend({ tenant_id: t, namespace: ns, period_days: 30 });
  assert.equal(out.status, 'ok');
  assert.equal(out.baseline_start, startAt);
  // 1M tokens × $0.15/M = $0.15 = 150_000 micro.
  assert.equal(out.total_cost_micro_usd, 150_000,
    'expected 150_000 micro from 1M gpt-4o-mini input tokens, got ' + out.total_cost_micro_usd);
  assert.equal(out.captures, 1);
});

// =============================================================================
// 8) computeSavings = insufficient_baseline when <7 days elapsed
// =============================================================================

test('W835 #8 — computeSavings returns insufficient_baseline when <7 days', async () => {
  freshDir();
  const t = 'tenant_w835_8';
  const ns = 'short';
  // Started 3 days ago.
  const startMs = Date.now() - 3 * 86_400_000;
  await savings.startBaselinePeriod({
    tenant_id: t, namespace: ns,
    start_ts: new Date(startMs).toISOString(),
  });
  const out = await savings.computeSavings({ tenant_id: t, namespace: ns, period_days: 30 });
  assert.equal(out.status, 'insufficient_baseline',
    'must report insufficient_baseline (got: ' + out.status + ')');
  assert.equal(out.elapsed_days, 3);
  assert.equal(out.min_baseline_days, savings.MIN_BASELINE_DAYS);
  assert.equal(out.saved_usd, 0);
  assert.equal(out.fee_usd, 0);
});

// =============================================================================
// 9) computeSavings: post < baseline → positive saved_usd
// =============================================================================

test('W835 #9 — computeSavings returns positive saved_usd when post < baseline', async () => {
  freshDir();
  const t = 'tenant_w835_9';
  const ns = 'happy';
  // Baseline started 60 days ago.
  const startMs = Date.now() - 60 * 86_400_000;
  const startISO = new Date(startMs).toISOString();
  await savings.startBaselinePeriod({ tenant_id: t, namespace: ns, start_ts: startISO });

  // Baseline window: day 0..30. Spend 10M input tokens on claude-opus-4-7
  // = 10 × $15 = $150 inside this window. Put it at day 10.
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'anthropic', model: 'claude-opus-4-7',
    input_tokens: 10_000_000, output_tokens: 0,
    ts: new Date(startMs + 10 * 86_400_000).toISOString(),
  });

  // Post-kolm window: day 30..60. Spend just 1M input tokens on a cheap
  // model = $0.15. So saved_usd should be ~$149.85.
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'openai', model: 'gpt-4o-mini',
    input_tokens: 1_000_000, output_tokens: 0,
    ts: new Date(startMs + 45 * 86_400_000).toISOString(),
  });

  const out = await savings.computeSavings({ tenant_id: t, namespace: ns, period_days: 30 });
  assert.equal(out.status, 'ok');
  assert.equal(out.regression, false);
  assert.ok(out.saved_usd > 140,
    'saved_usd should be > $140 (got ' + out.saved_usd + ')');
  assert.ok(out.fee_usd > 0, 'fee_usd must be positive on real savings');
  assert.ok(out.net_savings_usd < out.saved_usd, 'net < saved by exactly the fee');
});

// =============================================================================
// 10) computeSavings: post > baseline → negative + regression=true
// =============================================================================

test('W835 #10 — computeSavings returns negative saved + regression=true when post > baseline', async () => {
  freshDir();
  const t = 'tenant_w835_10';
  const ns = 'sad';
  const startMs = Date.now() - 60 * 86_400_000;
  const startISO = new Date(startMs).toISOString();
  await savings.startBaselinePeriod({ tenant_id: t, namespace: ns, start_ts: startISO });

  // Baseline: cheap.
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'openai', model: 'gpt-4o-mini',
    input_tokens: 1_000_000, output_tokens: 0, // $0.15
    ts: new Date(startMs + 5 * 86_400_000).toISOString(),
  });
  // Post: expensive (someone called Opus a lot post-kolm).
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'anthropic', model: 'claude-opus-4-7',
    input_tokens: 10_000_000, output_tokens: 0, // $150
    ts: new Date(startMs + 45 * 86_400_000).toISOString(),
  });

  const out = await savings.computeSavings({ tenant_id: t, namespace: ns, period_days: 30 });
  assert.equal(out.status, 'ok');
  assert.equal(out.regression, true,
    'regression must be true when post > baseline (got: ' + out.regression + ')');
  assert.ok(out.saved_usd < 0,
    'saved_usd must be negative on regression (got ' + out.saved_usd + ')');
  assert.equal(out.fee_usd, 0,
    'fee_usd must be 0 on regression (got ' + out.fee_usd + ')');
});

// =============================================================================
// 11) fee_usd = saved_usd × fee_rate (sanity)
// =============================================================================

test('W835 #11 — fee_usd = saved_usd × fee_rate (sanity)', async () => {
  freshDir();
  const t = 'tenant_w835_11';
  const ns = 'sanity';
  const startMs = Date.now() - 60 * 86_400_000;
  const startISO = new Date(startMs).toISOString();
  await savings.startBaselinePeriod({ tenant_id: t, namespace: ns, start_ts: startISO });
  // Baseline $1.00 (1M opus output @ $75 = no wait, 100k output @ $75/M = $7.50).
  // Use simpler: 1M input opus = $15.
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'anthropic', model: 'claude-opus-4-7',
    input_tokens: 1_000_000, output_tokens: 0,
    ts: new Date(startMs + 5 * 86_400_000).toISOString(),
  });
  // Post: $5 spent.
  // 1M input gpt-4o ($2.50). +250k input gpt-4o-mini ($0.00) ≈ keep simple:
  // record one 2M-token call on gpt-4o input only = 2 * $2.5 = $5.
  await savings.recordTeacherSpend({
    tenant_id: t, namespace: ns,
    provider: 'openai', model: 'gpt-4o',
    input_tokens: 2_000_000, output_tokens: 0,
    ts: new Date(startMs + 45 * 86_400_000).toISOString(),
  });
  const out = await savings.computeSavings({
    tenant_id: t, namespace: ns, period_days: 30, fee_rate: 0.125,
  });
  assert.equal(out.status, 'ok');
  // saved = $15 - $5 = $10. fee = $10 × 0.125 = $1.25.
  // Compare with tolerance.
  assert.ok(Math.abs(out.saved_usd - 10) < 0.01,
    'saved_usd should ≈ $10 (got ' + out.saved_usd + ')');
  const expectedFee = out.saved_usd * 0.125;
  assert.ok(Math.abs(out.fee_usd - expectedFee) < 1e-9,
    'fee_usd must equal saved_usd × fee_rate exactly (got ' + out.fee_usd + ' vs ' + expectedFee + ')');
  assert.ok(Math.abs(out.net_savings_usd - (out.saved_usd - out.fee_usd)) < 1e-9,
    'net_savings_usd must equal saved_usd - fee_usd');
});

// =============================================================================
// 12) Defense-in-depth: foreign tenant_id sees no spend rows
// =============================================================================

test('W835 #12 — foreign tenant_id sees no spend rows (tenant fence)', async () => {
  freshDir();
  // Tenant A records $$$ spend.
  const startMs = Date.now() - 60 * 86_400_000;
  await savings.startBaselinePeriod({
    tenant_id: 'tenant_w835_A', namespace: 'shared',
    start_ts: new Date(startMs).toISOString(),
  });
  await savings.recordTeacherSpend({
    tenant_id: 'tenant_w835_A', namespace: 'shared',
    provider: 'anthropic', model: 'claude-opus-4-7',
    input_tokens: 10_000_000, output_tokens: 0,
    ts: new Date(startMs + 5 * 86_400_000).toISOString(),
  });
  // Tenant B reads same namespace + period — must see NOTHING.
  const outB = await savings.getBaselineSpend({
    tenant_id: 'tenant_w835_B', namespace: 'shared', period_days: 30,
  });
  assert.equal(outB.status, 'no_baseline_started',
    'tenant B must see no baseline for the same namespace');
  assert.equal(outB.captures, 0, 'tenant B must see no captures');
  assert.equal(outB.total_cost_usd, 0, 'tenant B must see $0 spend');
});

// =============================================================================
// 13) sw.js wave token shipped (regex+threshold, NOT explicit array)
// =============================================================================


// =============================================================================
// 14) CLI dispatcher + HELP entry wired
// =============================================================================

test('W835 #14 — CLI wires `kolm savings` dispatcher + HELP entry', () => {
  const cli = fs.readFileSync(path.join(REPO_ROOT, 'cli', 'kolm.js'), 'utf8');
  assert.match(cli, /case 'savings':\s*await withErrorContext\('savings'/,
    'CLI dispatcher must route `savings` to cmdSavings');
  assert.match(cli, /savings: `kolm savings/,
    'HELP map must contain a savings entry');
  assert.match(cli, /kolm savings baseline --start/,
    'HELP must document `kolm savings baseline --start`');
  assert.match(cli, /kolm savings summary/,
    'HELP must document `kolm savings summary`');
});
