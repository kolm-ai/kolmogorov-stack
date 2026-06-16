// SOTA CaptureData lane - default-on curation + paraphrase leakage + planner
// scaling-law wiring. Exercises the REAL fixes shipped in this build pass:
//
//   CD-01/06 src/data-curate.js     curateDefault(): default-on light curate
//                                   (MinHash near-dedup + learned quality +
//                                   semantic cluster + COT/PII + label-error
//                                   FLAG/route) with heavy stages OFF.
//   CD-03/06 src/seeds.js           leakageReport(): MinHash/LSH near-dup
//                                   detector + opt-in embedding-cosine tier that
//                                   catches reordered/reworded paraphrase leaks
//                                   the legacy bigram detector missed.
//   CD-02/08 src/data-scaling-law.js planDataBudget(): planner-facing fitted
//                                   data-budget block (required_examples,
//                                   marginal dK/row, K-vs-rows curve) with a
//                                   clean insufficient fall-through.
//   CD-07    src/curriculum-sort.js  ascending curriculum order over pair-shaped
//                                   corpus rows (the default distill ordering).
//
// Pure JS, zero new deps. Run: node --test tests/sota-capturedata.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { curateDefault } from '../src/data-curate.js';
import { leakageReport } from '../src/seeds.js';
import { planDataBudget } from '../src/data-scaling-law.js';
import { sortCapturesByCurriculum } from '../src/curriculum-sort.js';

// ── CD-01/06: default-on light curate ────────────────────────────────────────

test('curateDefault runs MinHash near-dedup by default and collapses near-dups', async () => {
  const longBody = 'To reset your account password, open the settings page, choose the security tab, '
    + 'click the reset password button, confirm via the email link, and then set a new strong password.';
  const longInput = 'how do i reset my account password on the platform settings page when i forgot it';
  const pairs = [
    { input: longInput, output: longBody },
    // a true near-duplicate: identical input + body except one extra trailing
    // word in the body (Jaccard well above 0.85) - the default MinHash pre-pass
    // must collapse it.
    { input: longInput, output: longBody + ' Thanks.' },
    { input: 'what is your refund policy for digital goods', output: 'Refunds for digital goods are available within 14 days of purchase, no questions asked.' },
  ];
  const r = await curateDefault(pairs, { namespace: 'cd_default_test' });
  assert.equal(r.ok, true);
  // the near-exact dup must be removed by the default minhash pre-pass
  assert.ok(r.n_kept < r.n_in, 'expected default minhash dedup to drop the near-dup');
  assert.equal(r.method, 'curate-default-light');
  // the receipt must record which dedup backend actually ran (so the manifest
  // can stamp the default curation method).
  assert.ok(r.report);
  assert.ok(String(r.report.backend_used).includes('minhash-js'),
    'backend_used should record the minhash-js pre-pass: ' + r.report.backend_used);
});

test('curateDefault keeps the heavy python/diversity stages OFF', async () => {
  const pairs = [
    { input: 'q1 about onboarding new users', output: 'A helpful structured answer about onboarding new team members properly.' },
    { input: 'q2 about billing cycle changes', output: 'A helpful structured answer about how the monthly billing cycle changes over time.' },
  ];
  const r = await curateDefault(pairs, { namespace: 'cd_heavy_off' });
  assert.equal(r.ok, true);
  // python semantic dedup is OFF by default -> dedup stage never reports 'ok'
  assert.notEqual(r.report && r.report.dedup, 'ok');
  // diversity SELECT is OFF by default -> no selection block
  assert.equal(r.report && r.report.selection, null);
});

test('curateDefault redacts PII and drops COT-leaked outputs on the default path', async () => {
  const pairs = [
    { input: 'contact for support', output: 'Reach us at help@example.com for any account issues you may have today.' },
    { input: 'explain the answer', output: '<think>let me reason step by step about this</think> The answer is 42.' },
  ];
  const r = await curateDefault(pairs, { namespace: 'cd_pii_cot' });
  assert.equal(r.ok, true);
  // COT-leaked row dropped
  assert.ok(r.n_kept < r.n_in, 'COT row should be dropped');
  // surviving output must have the email redacted
  const survivor = r.pairs.find((p) => /support/.test(p.input));
  if (survivor) {
    assert.ok(!/help@example\.com/.test(survivor.output), 'email must be redacted');
    assert.ok(/\[REDACTED\]/.test(survivor.output), 'redaction marker present');
  }
});

test('curateDefault never throws and degrades on garbage input', async () => {
  const r1 = await curateDefault(null);
  assert.equal(r1.ok, true);
  const r2 = await curateDefault([{}, { input: 5, output: null }, 'not an object']);
  assert.equal(r2.ok, true);
});

// ── CD-03/06: paraphrase leakage via MinHash + embedding tier ─────────────────

test('leakageReport uses MinHash by default and catches near-exact paraphrase leaks', () => {
  const train = [
    { input: 'how do i reset my account password quickly and safely today', expected: 'go to settings' },
    { input: 'an entirely different prompt about shipping and logistics costs', expected: 'flat rate' },
  ];
  const holdout = [
    // near-exact reworded leak of train[0]
    { input: 'how do i reset my account password quickly and safely today now', expected: 'go to settings' },
  ];
  const rep = leakageReport(train, holdout, {});
  assert.equal(rep.near_dup_method, 'minhash');
  assert.ok(rep.near_duplicate_count >= 1, 'minhash should flag the near-exact leak');
  // record shape must stay stable (no extra per-record keys)
  const s = rep.samples.near_duplicates[0];
  assert.deepEqual(Object.keys(s).sort(), ['holdout_index', 'similarity', 'train_index']);
});

test('embedding tier catches reordered/reworded paraphrase leakage MinHash misses', () => {
  const train = [
    { input: 'What is the capital city of the country France in Europe', expected: 'Paris' },
    { input: 'Explain how to bake a chocolate cake from scratch at home', expected: 'mix' },
  ];
  const holdout = [
    { input: 'The capital city of France the country in Europe is what', expected: 'Paris' },
    { input: 'totally unrelated query about quantum physics and relativity', expected: 'E=mc2' },
  ];
  // MinHash-only misses the heavily-reordered paraphrase...
  const repMin = leakageReport(train, holdout, {});
  assert.equal(repMin.near_duplicate_count, 0);
  // ...but the opt-in embedding tier recovers it (and does NOT flag the unrelated row).
  const repEmb = leakageReport(train, holdout, { use_embedding: true, embedding_threshold: 0.9 });
  assert.equal(repEmb.near_duplicate_count, 1, 'embedding tier should flag exactly the paraphrase leak');
  assert.equal(repEmb.near_dup_embedding_hits, 1);
  assert.equal(repEmb.samples.near_duplicates[0].holdout_index, 0);
});

test('leakageReport bigram back-compat path still available', () => {
  const train = [{ input: 'the quick brown fox jumps over the lazy dog', expected: 'a' }];
  const holdout = [{ input: 'the quick brown fox jumps over the lazy dog', expected: 'a' }];
  const rep = leakageReport(train, holdout, { near_dup_method: 'bigram' });
  assert.equal(rep.near_dup_method, 'bigram');
  assert.ok(rep.near_duplicate_count >= 1);
});

// ── CD-02/08: planner-facing scaling-law budget block ─────────────────────────

test('planDataBudget returns a fitted budget block from observed anchors', async () => {
  const points = [[40, 0.55], [80, 0.66], [160, 0.74], [320, 0.80], [640, 0.85]];
  const blk = await planDataBudget({ points, current_n: 160, target_k: 0.83 });
  assert.equal(blk.ok, true);
  assert.equal(blk.basis, 'rectified');
  assert.ok(['acquire', 'stop', 'switch'].includes(blk.verdict));
  assert.ok(Number.isFinite(blk.required_examples), 'required_examples is a number');
  assert.ok(blk.required_examples >= 160, 'need at least current_n to reach a higher target');
  assert.ok(Number.isFinite(blk.marginal_dk_per_row), 'marginal dK/row surfaced');
  assert.ok(blk.marginal_dk_per_row > 0, 'marginal dK/row positive on a learning curve');
  assert.ok(Array.isArray(blk.curve) && blk.curve.length >= 2, 'K-vs-rows curve present');
  for (const pt of blk.curve) {
    assert.ok(Number.isFinite(pt.n) && Number.isFinite(pt.k_hat));
  }
});

test('planDataBudget falls through to insufficient on cold start', async () => {
  const blk = await planDataBudget({ points: [[40, 0.5], [80, 0.6]], current_n: 80, target_k: 0.8 });
  assert.equal(blk.ok, true);
  assert.equal(blk.basis, 'insufficient');
  assert.equal(blk.required_examples, null);
  assert.equal(blk.marginal_dk_per_row, null);
  assert.ok(blk.hint, 'insufficient block carries an actionable hint');
});

test('planDataBudget is deterministic for identical anchors', async () => {
  const points = [[50, 0.5], [100, 0.62], [200, 0.71], [400, 0.78], [800, 0.83]];
  const a = await planDataBudget({ points, current_n: 200, target_k: 0.85 });
  const b = await planDataBudget({ points, current_n: 200, target_k: 0.85 });
  assert.equal(a.basis, b.basis);
  assert.equal(a.required_examples, b.required_examples);
  assert.equal(a.marginal_dk_per_row, b.marginal_dk_per_row);
});

test('planDataBudget never throws across the public API', async () => {
  const blk = await planDataBudget({ points: 'garbage', current_n: -5, target_k: 'x' });
  assert.equal(blk.ok, true);
  assert.ok(blk.basis === 'insufficient');
});

// ── CD-07: curriculum ordering over pair-shaped corpus rows ───────────────────

test('sortCapturesByCurriculum orders pair-shaped corpus rows ascending by difficulty', () => {
  // Use a shared vocabulary so perplexity is comparable and LENGTH is the
  // dominant difficulty signal (longer == harder in this corpus).
  const base = 'the model produces an answer about the task and the data and the result ';
  const rows = [
    { input: 'q-hard', output: base.repeat(60) },
    { input: 'q-easy', output: base },
    { input: 'q-mid', output: base.repeat(8) },
  ];
  const ordered = sortCapturesByCurriculum(rows, 'ascending');
  assert.equal(ordered.length, 3);
  // ascending difficulty: shortest first, longest last.
  assert.equal(ordered[0].input, 'q-easy');
  assert.equal(ordered[ordered.length - 1].input, 'q-hard');
  // does not mutate the input order
  assert.equal(rows[0].input, 'q-hard');
  // descending mode reverses it
  const desc = sortCapturesByCurriculum(rows, 'descending');
  assert.equal(desc[0].input, 'q-hard');
});
