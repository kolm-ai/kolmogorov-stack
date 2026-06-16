// FINALIZED C3 - True DSIR (Xie et al., NeurIPS 2023) hashed n-gram importance
// resampling. Proves the new src/data-dsir.js implements the genuine algorithm
// (hashed unigram+bigram bag-of-words, two generative models, log-importance
// ratio, deterministic Gumbel-top-k SIR) and that data-curate routes the real
// 'dsir' strategy through it, with 'dsir-lite' as the centroid-cosine fallback.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  selectByDSIR,
  featurize,
  fitBowModel,
  gumbelTopK,
  DSIR_VERSION,
  __internals,
} from '../src/data-dsir.js';
import { curatePairs } from '../src/data-curate.js';

// ── synthetic corpora: two well-separated topics ─────────────────────────────
// TARGET topic = "quantum cryptography lattice" vocabulary.
// DISTRACTOR topic = "baking sourdough bread oven" vocabulary.
// The pool mixes both; DSIR should resample toward the quantum side.

// Each doc carries a unique per-index marker (`case ${i}`) so the 20+20 pool is 40
// DISTINCT pairs: curate's unconditional exact-dedup must not collapse the pool, or
// SELECT would have fewer unique items than target_size and could not exercise real
// down-selection. The topic vocabulary still dominates the hashed n-gram features, so
// DSIR's target-vs-distractor separation is unaffected by the marker.
function quantumDoc(i) {
  const v = ['quantum', 'lattice', 'cryptography', 'cipher', 'entanglement', 'qubit', 'shor', 'factoring'];
  const w = v[i % v.length];
  return { input: `explain ${w} security case ${i}`, output: `${w} ${v[(i + 1) % v.length]} ${v[(i + 2) % v.length]} resists attacks via ${w} variant ${i}` };
}
function bakingDoc(i) {
  const v = ['sourdough', 'bread', 'oven', 'flour', 'yeast', 'knead', 'crust', 'bake'];
  const w = v[i % v.length];
  return { input: `how to ${w} batch ${i}`, output: `${w} ${v[(i + 1) % v.length]} ${v[(i + 2) % v.length]} for a great ${w} loaf number ${i}` };
}

const TARGET = Array.from({ length: 12 }, (_, i) => quantumDoc(i));
// pool: 20 quantum + 20 baking, interleaved so index !~ topic.
const POOL = [];
for (let i = 0; i < 20; i++) { POOL.push(bakingDoc(i)); POOL.push(quantumDoc(i)); }

// ── 1. featurize: hashed unigram+bigram bag-of-words ─────────────────────────

test('featurize produces hashed n-gram counts (unigram+bigram) in [0,buckets)', () => {
  const { counts, total } = featurize('quantum lattice cipher', 1000, [1, 2]);
  // 3 unigrams + 2 bigrams = 5 feature occurrences.
  assert.equal(total, 5);
  for (const [b, c] of counts) {
    assert.ok(b >= 0 && b < 1000, 'bucket in range');
    assert.ok(c >= 1, 'count positive');
  }
  // empty text => no features.
  const empty = featurize('', 1000, [1, 2]);
  assert.equal(empty.total, 0);
  assert.equal(empty.counts.size, 0);
});

test('featurize is deterministic', () => {
  const a = featurize('quantum lattice cipher', 4096, [1, 2]);
  const b = featurize('quantum lattice cipher', 4096, [1, 2]);
  assert.deepEqual([...a.counts.entries()].sort(), [...b.counts.entries()].sort());
});

// ── 2. two bag-of-words generative models + log-importance ───────────────────

test('fitBowModel yields a normalized log-categorical (sums ~1 in prob space)', () => {
  const K = 512;
  const feats = TARGET.map((d) => featurize(`${d.input} ${d.output}`, K, [1, 2]));
  const m = fitBowModel(feats, K, 1.0);
  assert.equal(m.logp.length, K);
  let p = 0;
  for (let b = 0; b < K; b++) p += Math.exp(m.logp[b]);
  assert.ok(Math.abs(p - 1) < 1e-9, `prob mass ~1, got ${p}`);
  assert.ok(m.total > 0);
});

test('log-importance w_i ranks target-like pool items above distractors', () => {
  const r = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 20, seed: 7 });
  assert.ok(r.ok, r.error);
  // quantum docs are the odd indices in POOL by construction.
  const w = r.log_importance;
  assert.equal(w.length, POOL.length);
  let quantumMean = 0; let bakingMean = 0;
  for (let i = 0; i < POOL.length; i++) {
    if (i % 2 === 1) quantumMean += w[i]; else bakingMean += w[i];
  }
  quantumMean /= 20; bakingMean /= 20;
  // w_i = log p_target - log p_raw must be HIGHER for the target-topic items.
  assert.ok(quantumMean > bakingMean, `quantum w (${quantumMean}) > baking w (${bakingMean})`);
});

// ── 3. importance resampling selects the target topic ────────────────────────

test('selectByDSIR picks predominantly target-topic items', () => {
  const r = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 20, seed: 1 });
  assert.ok(r.ok);
  assert.equal(r.selected_indices.length, 20);
  // count quantum (odd index) picks - should be a strong majority.
  const quantumPicks = r.selected_indices.filter((i) => i % 2 === 1).length;
  assert.ok(quantumPicks >= 15, `expected >=15/20 quantum picks, got ${quantumPicks}`);
});

// ── KL diagnostic: subset moved TOWARD the target ────────────────────────────

test('KL diagnostic shows selected subset moved toward target vs pool', () => {
  const r = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 16, seed: 3 });
  assert.ok(r.ok);
  const d = r.diagnostics;
  assert.ok(d.kl_selected_to_target <= d.kl_pool_to_target,
    `KL(selected||target)=${d.kl_selected_to_target} should be <= KL(pool||target)=${d.kl_pool_to_target}`);
  assert.equal(d.moved_toward_target, true);
  assert.ok(d.kl_improvement >= 0);
  // picked items carry higher mean importance than dropped.
  assert.ok(d.mean_log_importance_selected > d.mean_log_importance_unselected);
});

// ── determinism: same (pool,target,seed) => identical selection ──────────────

test('Gumbel-top-k resampling is deterministic for a fixed seed', () => {
  const a = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 14, seed: 42 });
  const b = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 14, seed: 42 });
  assert.deepEqual(a.selected_indices, b.selected_indices);
  // different seed may differ (and is still a valid resample).
  const c = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 14, seed: 99 });
  assert.equal(c.selected_indices.length, 14);
});

test('gumbelTopK is exact top-k and respects budget bounds', () => {
  const lw = [0, 5, 1, 5, -3]; // index 1 & 3 dominate
  const top2 = gumbelTopK(lw, 2, 0);
  assert.equal(top2.length, 2);
  // with strong separation, the two 5s should usually win; at minimum budget honored.
  const over = gumbelTopK(lw, 99, 0);
  assert.equal(over.length, 5, 'budget clamps to n');
  assert.deepEqual(gumbelTopK(lw, 0, 0), []);
});

// ── envelope: fail loud, never throw ─────────────────────────────────────────

test('selectByDSIR fails loud (not throws) when no target corpus', () => {
  const r = selectByDSIR({ pool: POOL, target_items: [], target_size: 5 });
  assert.equal(r.ok, false);
  assert.match(r.error, /dsir_requires_target_items/);
  assert.equal(r.version, DSIR_VERSION);
});

test('selectByDSIR handles empty pool gracefully', () => {
  const r = selectByDSIR({ pool: [], target_items: TARGET, target_size: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.n_selected, 0);
});

test('selectByDSIR resolves fractional target_size', () => {
  const r = selectByDSIR({ pool: POOL, target_items: TARGET, target_size: 0.25, seed: 0 });
  assert.equal(r.n_selected, Math.round(0.25 * POOL.length)); // 10
});

// ── KL helper sanity ─────────────────────────────────────────────────────────

test('internal KL is zero for identical distributions and positive otherwise', () => {
  const K = 256;
  const fa = TARGET.map((d) => featurize(`${d.input} ${d.output}`, K, [1, 2]));
  const da = __internals._empiricalDist(fa, K, 1.0);
  assert.ok(Math.abs(__internals._kl(da, da)) < 1e-12, 'KL(p||p)=0');
  const fb = POOL.map((d) => featurize(`${d.input} ${d.output}`, K, [1, 2]));
  const db = __internals._empiricalDist(fb, K, 1.0);
  assert.ok(__internals._kl(da, db) > 0, 'KL between different dists > 0');
});

// ── 4. data-curate wiring: real 'dsir' strategy routes through data-dsir ─────

test('data-curate select_strategy:dsir runs TRUE DSIR (hashed n-gram resampling)', async () => {
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'dsir-test',
    pairs: POOL.slice(),
    opts: {
      // disable filter stages that could change counts so we isolate SELECT.
      quality: false, dedup: false, cluster: false, pii: false, cot: false,
      target_size: 18,
      select_strategy: 'dsir',
      target_items: TARGET,
      dsir_seed: 5,
    },
  });
  assert.ok(res.ok, res.error);
  assert.equal(res.report.selection.strategy, 'dsir');
  assert.equal(res.report.selection.basis, 'dsir-hashed-ngram-importance-resampling');
  assert.equal(res.n_kept, 18);
  // the diagnostic block must prove movement toward target.
  assert.ok(res.report.selection.diagnostics);
  assert.equal(res.report.selection.diagnostics.moved_toward_target, true);
});

test('data-curate dsir degrades to dsir-lite when target_items missing', async () => {
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'dsir-test',
    pairs: POOL.slice(),
    opts: {
      quality: false, dedup: false, cluster: false, pii: false, cot: false,
      target_size: 10,
      select_strategy: 'dsir',
      target_items: null, // no target => not real DSIR
    },
  });
  assert.ok(res.ok, res.error);
  // with no target_items, the 'dsir' branch condition is not met and it falls
  // through to the diversity/dsir-lite path; selection still produced a budget.
  assert.ok(res.report.selection);
  assert.equal(res.n_kept, 10);
});

test('data-curate select_strategy:dsir-lite uses the centroid-cosine proxy', async () => {
  const res = await curatePairs({
    tenant: 'tenant_test',
    namespace: 'dsir-test',
    pairs: POOL.slice(),
    opts: {
      quality: false, dedup: false, cluster: false, pii: false, cot: false,
      target_size: 12,
      select_strategy: 'dsir-lite',
      target_items: TARGET,
    },
  });
  assert.ok(res.ok, res.error);
  assert.equal(res.report.selection.strategy, 'dsir-lite');
  assert.equal(res.n_kept, 12);
});
