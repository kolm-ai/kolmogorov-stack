// W749 — Synthetic capture augmentation.
//
// Atomic items pinned (matches the W749 implementation):
//
//   1) SYNTHETIC_VERSION present + stamped 'w749-v1'; DEFAULTS frozen
//   2) detectGaps: returns gaps for low-count categories
//   3) detectGaps: target_categories adds MISSING ones with current_count=0
//   4) generateCoverageReport: empty input → honest envelope (total=0, gini=0)
//   5) generateCoverageReport: Gini correct (uniform = 0, single-bucket = 1.0)
//   6) generateCoverageReport: rare_buckets sorted by rarity desc
//   7) importanceWeight: rare bucket weight > common bucket weight; capped at 5.0
//   8) requestSyntheticBatch with DI teacher_caller: kolm_synthetic:true on every row
//   9) requestSyntheticBatch: honest envelope when teacher_caller missing
//  10) mergeSyntheticIntoCaptureRows: preserves parent_seed_cids + kolm_synthetic
//  11) GET /v1/synthetic/gaps/:namespace 401 without auth; 200 envelope on auth
//  12) GET /v1/synthetic/coverage/:namespace returns full envelope w/ version
//  13) POST /v1/synthetic/generate WITHOUT confirm:true returns
//      {ok:false, error:'synthetic_costs_money'} envelope (200, not 4xx)
//  14) POST /v1/synthetic/generate WITH confirm:true + DI teacher returns batch
//      + every row carries kolm_synthetic:true
//  15) POST /v1/synthetic/commit persists rows w/ kolm_synthetic:true via event-store
//  16) public/account/synthetic.html exists with brand-lock + gap render
//  17) public/docs/synthetic.html exists with brand-lock + honesty contract
//  18) vercel.json has both /docs/synthetic + /account/synthetic rewrites
//  19) cli/kolm.js defines cmdW749Synthetic exactly once + routed from case 'synthetic'
//  20) wave749 sibling test count uses wave(\d{3,4}) regex + threshold
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  SYNTHETIC_VERSION,
  DEFAULTS as SYNTHETIC_DEFAULTS,
  detectGaps,
  generateCoverageReport,
  importanceWeight,
  requestSyntheticBatch,
  mergeSyntheticIntoCaptureRows,
} from '../src/synthetic-augment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'synthetic.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'synthetic.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w749-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Helper to produce captures with a stable shape for the categorizer.
function mkCapture(input, output, extra) {
  return Object.assign({
    cid: 'cap_' + crypto.randomBytes(4).toString('hex'),
    namespace: 'billing',
    input: input,
    output: output,
  }, extra || {});
}

// =============================================================================
// 1) SYNTHETIC_VERSION present + stamped 'w749-v1'; DEFAULTS frozen
// =============================================================================

test('W749 #1 — SYNTHETIC_VERSION present + stamped w749-v1; DEFAULTS frozen', () => {
  freshDir();
  assert.equal(SYNTHETIC_VERSION, 'w749-v1',
    `expected SYNTHETIC_VERSION='w749-v1'; got ${JSON.stringify(SYNTHETIC_VERSION)}`);
  assert.ok(SYNTHETIC_DEFAULTS && typeof SYNTHETIC_DEFAULTS === 'object',
    'DEFAULTS must be an object');
  assert.ok(Object.isFrozen(SYNTHETIC_DEFAULTS),
    'DEFAULTS must be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(SYNTHETIC_DEFAULTS.MIN_PER_CATEGORY, 50,
    `spec mandates default min-per-category 50; got ${SYNTHETIC_DEFAULTS.MIN_PER_CATEGORY}`);
  assert.equal(SYNTHETIC_DEFAULTS.SUGGEST_BACKFILL, 50,
    `spec mandates default backfill 50 (UX prompt "generate 50?"); got ${SYNTHETIC_DEFAULTS.SUGGEST_BACKFILL}`);
  assert.ok(SYNTHETIC_DEFAULTS.MAX_TARGET_COUNT > 0,
    'MAX_TARGET_COUNT must be a positive integer cap');
  assert.ok(typeof SYNTHETIC_DEFAULTS.COST_PER_ROW_USD === 'number'
    && SYNTHETIC_DEFAULTS.COST_PER_ROW_USD > 0,
    `COST_PER_ROW_USD must be a positive number; got ${SYNTHETIC_DEFAULTS.COST_PER_ROW_USD}`);
});

// =============================================================================
// 2) detectGaps: returns gaps for low-count categories
// =============================================================================

test('W749 #2 — detectGaps returns gaps for low-count categories sorted by gap desc', () => {
  freshDir();
  // Construct a corpus where one bucket is fat + one is thin so the
  // categorizer surfaces both, and the thin bucket lands in the gap list at
  // a low min_per_category threshold.
  const captures = [];
  for (let i = 0; i < 20; i++) {
    captures.push(mkCapture(
      'i need a refund for order ' + i + ' please',
      'sure, refund processed for order ' + i,
      { category: 'refund' },
    ));
  }
  for (let i = 0; i < 2; i++) {
    captures.push(mkCapture(
      'i want to escalate this to your manager now',
      'i understand, escalating to senior support agent',
      { category: 'escalation' },
    ));
  }
  // min_per_category=10 → 'escalation' (count=2) is a gap; 'refund' (count=20) is not.
  const gaps = detectGaps(captures, { min_per_category: 10 });
  assert.ok(Array.isArray(gaps), 'detectGaps must return an array');
  const escGap = gaps.find((g) => g.category === 'escalation');
  assert.ok(escGap, `expected an 'escalation' gap row; got ${JSON.stringify(gaps)}`);
  assert.equal(escGap.current_count, 2);
  assert.ok(escGap.suggested_count >= 1, 'suggested_count must be positive');
  assert.ok(escGap.gap > 0, 'gap must be > 0 for an under-served category');
  assert.equal(escGap.present, true,
    'a category PRESENT in the corpus must have present:true');
  // 'refund' should NOT appear as a gap.
  assert.ok(!gaps.some((g) => g.category === 'refund'),
    `'refund' (count=20) must NOT appear when min=10; got ${JSON.stringify(gaps)}`);
  // Sort: gap desc.
  for (let i = 1; i < gaps.length; i++) {
    assert.ok(gaps[i].gap <= gaps[i - 1].gap,
      `gaps must be sorted by gap desc; got ${JSON.stringify(gaps)}`);
  }
});

// =============================================================================
// 3) detectGaps: target_categories adds MISSING ones with current_count=0
// =============================================================================

test('W749 #3 — detectGaps target_categories surfaces missing categories with present:false', () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 20; i++) {
    captures.push(mkCapture('refund me ' + i, 'ok ' + i, { category: 'refund' }));
  }
  // Caller asks specifically about 'escalation' + 'fraud' which are NOT in
  // the corpus at all.
  const gaps = detectGaps(captures, {
    target_categories: ['escalation', 'fraud'],
    min_per_category: 10,
  });
  assert.equal(gaps.length, 2,
    `expected both target_categories returned; got ${JSON.stringify(gaps)}`);
  for (const g of gaps) {
    assert.equal(g.current_count, 0,
      `missing target_categories must have current_count=0; got ${JSON.stringify(g)}`);
    assert.equal(g.present, false,
      `categories absent from corpus must have present:false; got ${JSON.stringify(g)}`);
    assert.ok(g.gap > 0, 'gap must be > 0 for fully missing categories');
  }
});

// =============================================================================
// 4) generateCoverageReport: empty input → honest envelope
// =============================================================================

test('W749 #4 — generateCoverageReport returns honest empty envelope when no captures', () => {
  freshDir();
  const r1 = generateCoverageReport([]);
  assert.equal(r1.ok, true);
  assert.equal(r1.total, 0);
  assert.deepEqual(r1.buckets, []);
  assert.deepEqual(r1.rare_buckets, []);
  assert.equal(r1.gini_coefficient, 0,
    'empty corpus must report Gini=0 (no concentration to measure)');
  assert.equal(r1.version, SYNTHETIC_VERSION);
  // Garbage input (non-array) must NOT throw.
  const r2 = generateCoverageReport(null);
  assert.equal(r2.ok, true);
  assert.equal(r2.total, 0);
});

// =============================================================================
// 5) generateCoverageReport: Gini correct (uniform = ~0, single-bucket = ~1)
// =============================================================================

test('W749 #5 — generateCoverageReport Gini: uniform ≈ 0; single-bucket-dominant ≈ 1', () => {
  freshDir();
  // Uniform-ish: 5 categories x 5 captures each.
  const uniform = [];
  const cats = ['refund', 'escalation', 'fraud', 'cancellation', 'shipping'];
  for (const c of cats) {
    for (let i = 0; i < 5; i++) {
      uniform.push(mkCapture(c + ' question ' + i, c + ' answer ' + i, { category: c }));
    }
  }
  const u = generateCoverageReport(uniform);
  assert.equal(u.total, 25);
  // Uniform Gini should be small (≤ 0.15) — the exact value depends on the
  // categorizer's bucket inference, but it must be far from 1.0.
  assert.ok(u.gini_coefficient < 0.30,
    `uniform corpus must have small Gini; got ${u.gini_coefficient} on ${JSON.stringify(u.buckets.map((b) => [b.name, b.count]))}`);

  // Single-bucket dominant: 30 refund, 0 of anything else.
  const dominant = [];
  for (let i = 0; i < 30; i++) {
    dominant.push(mkCapture('refund please ' + i, 'sure ' + i, { category: 'refund' }));
  }
  const d = generateCoverageReport(dominant);
  assert.equal(d.total, 30);
  // Single bucket = Gini close to 1 (our impl returns exactly 1.0 for n=1).
  assert.ok(d.gini_coefficient >= 0.95,
    `single-bucket-dominant corpus must have Gini ≈ 1; got ${d.gini_coefficient}`);
});

// =============================================================================
// 6) generateCoverageReport: rare_buckets sorted by rarity desc
// =============================================================================

test('W749 #6 — generateCoverageReport rare_buckets sorted by rarity desc', () => {
  freshDir();
  // Skewed: 50 refund, 5 escalation, 1 fraud → fraud is rarest.
  const captures = [];
  for (let i = 0; i < 50; i++) {
    captures.push(mkCapture('refund ' + i, 'ok ' + i, { category: 'refund' }));
  }
  for (let i = 0; i < 5; i++) {
    captures.push(mkCapture('escalate ' + i, 'sure ' + i, { category: 'escalation' }));
  }
  captures.push(mkCapture('this is fraud', 'investigating', { category: 'fraud' }));
  const r = generateCoverageReport(captures);
  assert.equal(r.total, 56);
  assert.ok(Array.isArray(r.rare_buckets) && r.rare_buckets.length >= 2,
    `rare_buckets must contain >=2 buckets; got ${JSON.stringify(r.rare_buckets)}`);
  // Sort invariant.
  for (let i = 1; i < r.rare_buckets.length; i++) {
    assert.ok(r.rare_buckets[i].rarity_score <= r.rare_buckets[i - 1].rarity_score + 1e-12,
      `rare_buckets must be sorted by rarity_score desc; got ${JSON.stringify(r.rare_buckets.map((b) => [b.name, b.rarity_score]))}`);
  }
  // The single 'fraud' capture is the rarest non-zero bucket — should be #1
  // in rare_buckets.
  assert.equal(r.rare_buckets[0].name, 'fraud',
    `rarest bucket must be 'fraud' (single capture); got ${r.rare_buckets[0].name}`);
});

// =============================================================================
// 7) importanceWeight: rare > common; capped at 5.0
// =============================================================================

test('W749 #7 — importanceWeight: rare > common; capped at 5.0; bad input → 1.0', () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 100; i++) {
    captures.push(mkCapture('refund ' + i, 'ok ' + i, { category: 'refund' }));
  }
  captures.push(mkCapture('this is fraud', 'investigating', { category: 'fraud' }));
  const report = generateCoverageReport(captures);
  const commonCapture = mkCapture('refund 200', 'ok 200', { category: 'refund' });
  const rareCapture = mkCapture('this is fraud', 'investigating', { category: 'fraud' });
  const wCommon = importanceWeight(commonCapture, report);
  const wRare = importanceWeight(rareCapture, report);
  assert.ok(wRare > wCommon,
    `rare bucket must get higher weight; got rare=${wRare} common=${wCommon}`);
  assert.ok(wRare <= 5.0,
    `weight must be capped at 5.0 to prevent gradient explosion; got ${wRare}`);
  assert.ok(wCommon >= 1.0,
    `weights must be >= 1.0 (no down-weight); got ${wCommon}`);
  // Garbage inputs → 1.0 (no throw).
  assert.equal(importanceWeight(null, report), 1.0);
  assert.equal(importanceWeight(commonCapture, null), 1.0);
  assert.equal(importanceWeight({}, {}), 1.0);
});

// =============================================================================
// 8) requestSyntheticBatch with DI teacher_caller: kolm_synthetic on every row
// =============================================================================

test('W749 #8 — requestSyntheticBatch tags every row kolm_synthetic:true + propagates seed_cids', async () => {
  freshDir();
  let callCount = 0;
  const teacher = async (prompt) => {
    callCount++;
    return JSON.stringify({
      input: 'i would like to escalate this issue ' + callCount,
      output: 'understood, escalating to senior support team',
    });
  };
  const seeds = [
    { cid: 'seed_a', input: 'help', output: 'sure' },
    { cid: 'seed_b', input: 'urgent', output: 'on it' },
  ];
  const batch = await requestSyntheticBatch({
    category: 'escalation',
    target_count: 5,
    seed_captures: seeds,
    teacher_caller: teacher,
  });
  assert.equal(batch.ok, true, `batch must be ok; got ${JSON.stringify(batch)}`);
  assert.equal(batch.actual_count, 5);
  assert.equal(batch.generated.length, 5);
  assert.equal(callCount, 5, 'teacher_caller must be invoked target_count times');
  for (const row of batch.generated) {
    assert.equal(row.kolm_synthetic, true,
      `every generated row MUST carry kolm_synthetic:true; got ${JSON.stringify(row)}`);
    assert.equal(row.source_category, 'escalation');
    assert.ok(typeof row.generation_id === 'string' && row.generation_id.length > 0,
      'generation_id must be a non-empty string');
    assert.deepEqual(row.seed_cids.sort(), ['seed_a', 'seed_b']);
    assert.ok(typeof row.input === 'string' && row.input.length > 0);
    assert.ok(typeof row.output === 'string' && row.output.length > 0);
  }
  // cost_usd_est must be a finite non-negative number.
  assert.ok(Number.isFinite(batch.cost_usd_est) && batch.cost_usd_est >= 0,
    `cost_usd_est must be finite + nonneg; got ${batch.cost_usd_est}`);
});

// =============================================================================
// 9) requestSyntheticBatch: honest envelope on teacher_caller missing
// =============================================================================

test('W749 #9 — requestSyntheticBatch returns honest envelope when teacher_caller missing or category empty', async () => {
  freshDir();
  // Missing teacher_caller.
  const r1 = await requestSyntheticBatch({ category: 'escalation', target_count: 5 });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'teacher_caller_required',
    `missing teacher_caller must produce 'teacher_caller_required'; got ${JSON.stringify(r1)}`);
  assert.ok(typeof r1.hint === 'string' && r1.hint.length > 0,
    'honest envelope must carry an actionable hint');

  // Missing category.
  const r2 = await requestSyntheticBatch({ target_count: 5, teacher_caller: async () => '{}' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'category_required');

  // All teacher calls throw → ok:false (not silent success).
  const teacherFail = async () => { throw new Error('upstream 429'); };
  const r3 = await requestSyntheticBatch({
    category: 'escalation',
    target_count: 3,
    teacher_caller: teacherFail,
  });
  assert.equal(r3.ok, false);
  assert.equal(r3.error, 'teacher_call_failed');
  assert.ok(Array.isArray(r3.errors) && r3.errors.length === 3,
    `errors[] must capture all failed rows; got ${JSON.stringify(r3.errors)}`);
});

// =============================================================================
// 10) mergeSyntheticIntoCaptureRows: preserves parent_seed_cids + kolm_synthetic
// =============================================================================

test('W749 #10 — mergeSyntheticIntoCaptureRows preserves parent_seed_cids + kolm_synthetic', () => {
  freshDir();
  const fakeBatch = {
    ok: true,
    generated: [
      {
        input: 'gen input 1',
        output: 'gen output 1',
        kolm_synthetic: true,
        source_category: 'escalation',
        generation_id: 'abc123',
        seed_cids: ['seed_a', 'seed_b'],
      },
      {
        input: 'gen input 2',
        output: 'gen output 2',
        kolm_synthetic: true,
        source_category: 'escalation',
        generation_id: 'abc124',
        seed_cids: ['seed_a', 'seed_b'],
      },
    ],
  };
  const rows = mergeSyntheticIntoCaptureRows(fakeBatch, 'billing');
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.namespace, 'billing',
      'namespace must be threaded into every row');
    assert.equal(row.kolm_synthetic, true,
      `kolm_synthetic:true MUST survive the merge — load-bearing for honesty contract`);
    assert.deepEqual(row.parent_seed_cids, ['seed_a', 'seed_b'],
      'parent_seed_cids must round-trip from generated.seed_cids');
    assert.ok(row.generated_at && /T.*Z$/.test(row.generated_at),
      `generated_at must be an ISO timestamp; got ${JSON.stringify(row.generated_at)}`);
    assert.equal(row.source_category, 'escalation');
    assert.equal(row.version, SYNTHETIC_VERSION);
  }
  // No namespace → empty array (no silent invention).
  assert.deepEqual(mergeSyntheticIntoCaptureRows(fakeBatch, ''), []);
  // ok:false batch → empty array (never persist a failed batch).
  assert.deepEqual(mergeSyntheticIntoCaptureRows({ ok: false }, 'billing'), []);
});

// =============================================================================
// 11) GET /v1/synthetic/gaps/:namespace 401 without auth; 200 envelope on auth
// =============================================================================

test('W749 #11 — GET /v1/synthetic/gaps/:namespace 401 without auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/synthetic/gaps/billing`);
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);

    // Inject some refund captures under tenant + namespace.
    for (let i = 0; i < 5; i++) {
      await eventStore.appendEvent({
        tenant_id: t.id,
        namespace: 'billing',
        provider: 'test',
        model_id: 'test-model',
        prompt_redacted: 'i need a refund please ' + i,
        response_redacted: 'sure, refund processed ' + i,
        latency_ms: 100,
        tokens_in: 5,
        tokens_out: 5,
        cost_micro_usd: 1,
      });
    }

    // Auth + ask for an escalation gap explicitly.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/synthetic/gaps/billing?target_categories=escalation,fraud&min_per_category=10`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.namespace, 'billing');
    assert.equal(env.version, 'w749-v1');
    assert.ok(Array.isArray(env.gaps), `gaps must be an array; got ${typeof env.gaps}`);
    // 'escalation' + 'fraud' MUST both appear as gaps (corpus has neither).
    const cats = env.gaps.map((g) => g.category).sort();
    assert.deepEqual(cats, ['escalation', 'fraud'],
      `expected escalation + fraud in gaps; got ${JSON.stringify(cats)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) GET /v1/synthetic/coverage/:namespace returns full envelope w/ version
// =============================================================================

test('W749 #12 — GET /v1/synthetic/coverage/:namespace returns full envelope w/ version + gini', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  for (let i = 0; i < 5; i++) {
    await eventStore.appendEvent({
      tenant_id: t.id,
      namespace: 'cov-ns',
      provider: 'test',
      model_id: 'test-model',
      prompt_redacted: 'i need a refund ' + i,
      response_redacted: 'ok refunded ' + i,
      latency_ms: 100,
      tokens_in: 5,
      tokens_out: 5,
      cost_micro_usd: 1,
    });
  }

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/synthetic/coverage/cov-ns`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200);
    const env = await res.json();
    assert.equal(env.ok, true);
    assert.equal(env.namespace, 'cov-ns');
    assert.equal(env.version, 'w749-v1');
    assert.ok(typeof env.total === 'number');
    assert.equal(env.total, 5, `expected total=5; got ${env.total}`);
    assert.ok(Array.isArray(env.buckets));
    assert.ok(Array.isArray(env.rare_buckets));
    assert.ok(typeof env.gini_coefficient === 'number'
      && env.gini_coefficient >= 0 && env.gini_coefficient <= 1,
      `gini must be in [0,1]; got ${env.gini_coefficient}`);
    assert.ok(env.bucket_strategy === 'category' || env.bucket_strategy === 'keyword');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 13) POST /v1/synthetic/generate WITHOUT confirm:true → synthetic_costs_money
// =============================================================================

test('W749 #13 — POST /v1/synthetic/generate WITHOUT confirm:true returns synthetic_costs_money envelope (200)', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // No confirm → 200 + ok:false + estimated_cost.
    const res = await fetch(`http://127.0.0.1:${port}/v1/synthetic/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'billing', category: 'escalation', target_count: 50 }),
    });
    assert.equal(res.status, 200,
      `spend-protection envelope MUST be HTTP 200 (callers branch on env.ok); got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'synthetic_costs_money');
    assert.equal(env.namespace, 'billing');
    assert.equal(env.category, 'escalation');
    assert.equal(env.target_count, 50);
    assert.ok(typeof env.estimated_cost_usd === 'number' && env.estimated_cost_usd > 0,
      `estimated_cost_usd must be a positive number; got ${env.estimated_cost_usd}`);
    assert.ok(typeof env.hint === 'string' && env.hint.includes('confirm:true'),
      `hint must explain how to proceed with confirm:true; got ${JSON.stringify(env.hint)}`);
    assert.equal(env.version, 'w749-v1');

    // Missing category → 400.
    const bad = await fetch(`http://127.0.0.1:${port}/v1/synthetic/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'billing' }),
    });
    assert.equal(bad.status, 400);
    const badEnv = await bad.json();
    assert.equal(badEnv.error, 'category_required');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 14) POST /v1/synthetic/generate WITH confirm:true + DI teacher → batch
// =============================================================================

test('W749 #14 — POST /v1/synthetic/generate WITH confirm:true + DI teacher generates batch w/ kolm_synthetic:true', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  // DI teacher_caller — must be injected BEFORE the router mounts (router
  // resolves it at request time from req.app.locals).
  app.locals._w749_teacher_caller = async (prompt) => {
    return JSON.stringify({
      input: 'simulated escalation: I want to speak to a manager',
      output: 'I understand. I am escalating this to a senior agent now.',
    });
  };
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    const res = await fetch(`http://127.0.0.1:${port}/v1/synthetic/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'billing',
        category: 'escalation',
        target_count: 3,
        confirm: true,
      }),
    });
    assert.equal(res.status, 200, `expected 200; got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.namespace, 'billing');
    assert.equal(env.category, 'escalation');
    assert.equal(env.actual_count, 3);
    assert.ok(typeof env.generation_id === 'string' && env.generation_id.length > 0);
    assert.equal(env.generated.length, 3);
    for (const row of env.generated) {
      assert.equal(row.kolm_synthetic, true,
        `every generated row MUST carry kolm_synthetic:true; got ${JSON.stringify(row)}`);
      assert.equal(row.source_category, 'escalation');
    }
    assert.equal(env.version, 'w749-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 15) POST /v1/synthetic/commit persists rows w/ kolm_synthetic:true
// =============================================================================

test('W749 #15 — POST /v1/synthetic/commit persists rows w/ kolm_synthetic:true via event-store', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.locals._w749_teacher_caller = async () => JSON.stringify({
    input: 'escalation request',
    output: 'escalating immediately to senior support',
  });
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();
    // 1) generate w/ confirm to stage.
    const gen = await fetch(`http://127.0.0.1:${port}/v1/synthetic/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'commit-ns',
        category: 'escalation',
        target_count: 2,
        confirm: true,
      }),
    });
    assert.equal(gen.status, 200);
    const genEnv = await gen.json();
    assert.equal(genEnv.ok, true);
    const generation_id = genEnv.generation_id;
    assert.ok(generation_id, 'generation_id must be returned by generate');

    // 2) commit.
    const com = await fetch(`http://127.0.0.1:${port}/v1/synthetic/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'commit-ns', generation_id }),
    });
    assert.equal(com.status, 200);
    const comEnv = await com.json();
    assert.equal(comEnv.ok, true);
    assert.equal(comEnv.namespace, 'commit-ns');
    assert.equal(comEnv.generation_id, generation_id);
    assert.equal(comEnv.persisted_count, 2,
      `persisted_count should match the staged batch size; got ${comEnv.persisted_count}`);
    assert.equal(comEnv.version, 'w749-v1');

    // 3) verify persisted rows carry the canonical synthetic markers.
    // The canonical lake column is `source_type='synthetic'` (closed enum, see
    // event-schema.js SOURCE_TYPES). The W749-specific kolm_synthetic flag +
    // parent_seed_cids + generation_id are packed into the `feedback` field
    // as a JSON blob prefixed with 'w749_synthetic:' so they survive the
    // canonicalize() pass (which strips any extra keys).
    const persisted = await eventStore.listEvents({
      tenant_id: t.id,
      namespace: 'commit-ns',
      limit: 100,
      order: 'desc',
    });
    const synthRows = (persisted || []).filter((r) => r.source_type === 'synthetic');
    assert.ok(synthRows.length >= 2,
      `expected >=2 persisted rows with source_type:'synthetic' (canonical); ` +
      `got ${synthRows.length} of ${persisted.length}`);
    for (const row of synthRows.slice(0, 2)) {
      assert.equal(row.model, 'kolm-synthetic-w749',
        `persisted model MUST be 'kolm-synthetic-w749' for honesty trail; got ${row.model}`);
      assert.ok(row.feedback && row.feedback.startsWith('w749_synthetic:'),
        `feedback field must carry W749 metadata blob; got ${JSON.stringify(row.feedback)}`);
      const meta = JSON.parse(row.feedback.replace(/^w749_synthetic:/, ''));
      assert.equal(meta.kolm_synthetic, true,
        `packed metadata MUST have kolm_synthetic:true; got ${JSON.stringify(meta)}`);
      assert.ok(meta.generation_id,
        `packed metadata must carry generation_id; got ${JSON.stringify(meta)}`);
    }

    // 4) second commit → 404 (one-shot stage clear).
    const com2 = await fetch(`http://127.0.0.1:${port}/v1/synthetic/commit`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'commit-ns', generation_id }),
    });
    assert.equal(com2.status, 404);
    const com2Env = await com2.json();
    assert.equal(com2Env.error, 'generation_not_found',
      `second commit must return generation_not_found (one-shot); got ${JSON.stringify(com2Env)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 16) public/account/synthetic.html exists with brand-lock + gap render
// =============================================================================

test('W749 #16 — public/account/synthetic.html exists with brand-lock + gap render', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-footer',
    'Open-source AI workbench',                  // W749 eyebrow brand lock
    'Frontier AI on your own infrastructure',    // W749 H1 brand lock
    '/v1/synthetic/coverage',                    // coverage fetch
    '/v1/synthetic/gaps',                        // gaps fetch
    '/v1/synthetic/generate',                    // generate POST
    '/v1/synthetic/commit',                      // commit POST
    'gini',                                      // Gini pill / bar
    'rarity',                                    // rarity column
    'generate',                                  // CTA verb on gap cards
    'confirm',                                   // spend-confirmation modal
    'kolm_synthetic',                            // honesty flag surfaced in UI
  ]) {
    assert.ok(html.includes(needle),
      `account/synthetic.html must mention "${needle}"`);
  }
});

// =============================================================================
// 17) public/docs/synthetic.html exists with brand-lock + honesty contract
// =============================================================================

test('W749 #17 — public/docs/synthetic.html exists with brand-lock + honesty contract section', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    'ks-footer',
    'Open-source AI workbench',                  // W749 eyebrow brand lock
    'Frontier AI on your own infrastructure',    // W749 H1 brand lock
    'w749-v1',                                   // version stamp
    'kolm_synthetic',                            // honesty contract flag
    'parent_seed_cids',                          // parent-seed audit trail
    'gini',                                      // coverage math
    'rarity_score',                              // formula explainer
    'confirm',                                   // spend-protection note
    '/v1/synthetic',                             // API surface mentions
    '/account/synthetic',                        // cross-link to dashboard
  ]) {
    assert.ok(html.toLowerCase().includes(needle.toLowerCase()),
      `docs/synthetic.html must mention "${needle}"`);
  }
});

// =============================================================================
// 18) vercel.json has both /docs/synthetic + /account/synthetic rewrites
// =============================================================================

test('W749 #18 — vercel.json contains /docs/synthetic + /account/synthetic rewrites', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = (v.rewrites || []);
  const docRewrite = rewrites.find((r) => r.source === '/docs/synthetic');
  assert.ok(docRewrite, '/docs/synthetic rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/synthetic.html');
  const acctRewrite = rewrites.find((r) => r.source === '/account/synthetic');
  assert.ok(acctRewrite, '/account/synthetic rewrite must exist in vercel.json');
  assert.equal(acctRewrite.destination, '/account/synthetic.html');
});

// =============================================================================
// 19) cli/kolm.js defines cmdW749Synthetic exactly once + routed from case 'synthetic'
// =============================================================================

test('W749 #19 — cli/kolm.js defines cmdW749Synthetic dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW749Synthetic\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW749Synthetic dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]synthetic['"]/.test(cli),
    `cli must have a case 'synthetic' arm`);
  assert.ok(cli.includes('cmdW749Synthetic(rest)'),
    `cmdW749Synthetic must be invoked with the rest args`);
});

// =============================================================================
// 20) wave749 sibling test count uses wave(\d{3,4}) regex + threshold
// =============================================================================

test('W749 #20 — wave749 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
