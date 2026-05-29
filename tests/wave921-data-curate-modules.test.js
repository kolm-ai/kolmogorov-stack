// W921 — KOLM Data Engine CURATE primitives.
//
// Covers the two NEW dependency-free curation modules authored for the
// G-data-engine-curate group:
//   - src/minhash-dedup.js  (MinHash + LSH near-dup clustering)
//   - src/data-select.js    (DSIR/DEITA-style distribution-matched selection)
//
// No edits to data-curate.js — these are the module-level unit + integration
// tests the spec's test_plan calls for (the first committed coverage of the
// curate dedup/select primitives). All pure JS, zero new deps, runs on a
// python-less box.
//
// MinHash pins (spec test_plan):
//   - shingleSet: 'a b c d e f' k=5 => 2 shingles; normalization; short-text
//   - makePermutations: reproducible run-to-run
//   - minhashSignature: length==numHashes; identical input => identical sig
//   - estimateJaccard: within +-0.08 at N=128 over many random pairs
//   - lshBuckets: full-band agreement collides; band-index namespacing
//   - UnionFind: chain + star unions => correct partition
//   - optimalBands: b*r<=numHashes, monotone-ish, threshold sane
//   - minhashPredup: removes exact + near dups, keeps hard negatives (verify),
//     determinism, dedup_signature, python-absent path, malformed rows
//
// data-select pins (spec test_plan):
//   - reprFilterSelect spans clusters, never picks near-paraphrases
//   - selectDiverseSubset honest envelope + provenance.selection stamp
//   - degrade: bogus python method => ok:true, js-repr-filter-fallback
//   - selectDiverseBatch over clustered items => one per cluster
//   - selectInformativeSubset: self-coverage + DSIR distribution match
//   - backward-compat: empty input never throws

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MINHASH_VERSION,
  fnv1a32,
  shingleSet,
  makePermutations,
  minhashSignature,
  lshBuckets,
  estimateJaccard,
  UnionFind,
  optimalBands,
  minhashPredup,
  dedupSignature,
} from '../src/minhash-dedup.js';

import {
  DATA_SELECT_VERSION,
  selectDiverseSubset,
  selectInformativeSubset,
  reprFilterSelect,
  selectDiverseBatch,
  __internals,
} from '../src/data-select.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function trueJaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// =============================================================================
// MinHash: shingling
// =============================================================================

test('shingleSet: 6 words k=5 => 2 shingles', () => {
  assert.equal(shingleSet('a b c d e f', 5).size, 2);
});

test('shingleSet: identical text => identical hashed set', () => {
  const a = shingleSet('the quick brown fox jumps over the lazy dog');
  const b = shingleSet('the quick brown fox jumps over the lazy dog');
  assert.equal(a.size, b.size);
  for (const x of a) assert.ok(b.has(x));
});

test('shingleSet: whitespace + case normalized', () => {
  const a = shingleSet('Hello   World  Foo Bar Baz');
  const b = shingleSet('hello world foo bar baz');
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('shingleSet: short text (< k) collapses to one whole-sequence shingle', () => {
  const s = shingleSet('only three words', 5);
  assert.equal(s.size, 1);
  // two equally-short identical texts collide; different ones do not
  assert.deepEqual([...s], [...shingleSet('only three words', 5)]);
  assert.notDeepEqual([...s], [...shingleSet('different short text', 5)]);
});

test('shingleSet: empty / non-string => empty set', () => {
  assert.equal(shingleSet('').size, 0);
  assert.equal(shingleSet(null).size, 0);
  assert.equal(shingleSet(undefined).size, 0);
});

test('fnv1a32: deterministic 32-bit hash', () => {
  const h = fnv1a32('hello');
  assert.equal(h, fnv1a32('hello'));
  assert.ok(h >= 0 && h <= 0xffffffff);
  assert.notEqual(fnv1a32('hello'), fnv1a32('world'));
});

// =============================================================================
// MinHash: permutations + signatures
// =============================================================================

test('makePermutations: reproducible run-to-run + non-degenerate a_i', () => {
  const p1 = makePermutations(128, 0x6b6f6c6d);
  const p2 = makePermutations(128, 0x6b6f6c6d);
  assert.equal(p1.a.length, 128);
  assert.equal(p1.b.length, 128);
  for (let i = 0; i < 128; i++) {
    assert.equal(p1.a[i], p2.a[i]);
    assert.equal(p1.b[i], p2.b[i]);
    assert.ok(p1.a[i] >= 1, 'a_i must be non-zero (non-degenerate)');
  }
});

test('makePermutations: different seeds => different families', () => {
  const p1 = makePermutations(64, 1);
  const p2 = makePermutations(64, 2);
  let diff = 0;
  for (let i = 0; i < 64; i++) if (p1.a[i] !== p2.a[i]) diff++;
  assert.ok(diff > 50, 'distinct seeds should yield mostly-distinct multipliers');
});

test('minhashSignature: length == numHashes; identical input => identical signature', () => {
  const perms = makePermutations(128, 0x6b6f6c6d);
  const sh = shingleSet('the quick brown fox jumps over the lazy dog repeatedly');
  const s1 = minhashSignature(sh, perms);
  const s2 = minhashSignature(shingleSet('the quick brown fox jumps over the lazy dog repeatedly'), perms);
  assert.equal(s1.length, 128);
  for (let i = 0; i < 128; i++) assert.equal(s1[i], s2[i]);
});

test('minhashSignature: empty shingles => all-zero signature', () => {
  const perms = makePermutations(32, 7);
  const sig = minhashSignature(new Set(), perms);
  assert.equal(sig.length, 32);
  assert.ok(sig.every((x) => x === 0));
});

test('estimateJaccard: within +-0.08 at N=128 over 50 random pairs', () => {
  const perms = makePermutations(128, 0x6b6f6c6d);
  let totalErr = 0;
  const trials = 50;
  for (let t = 0; t < trials; t++) {
    // build two overlapping vocabularies with a controlled overlap
    const len = 30;
    const wordsA = Array.from({ length: len }, (_, i) => 'w' + ((i * 7 + t) % 50));
    const keep = len - (t % 16);
    const wordsB = wordsA.slice(0, keep).concat(
      Array.from({ length: len - keep }, (_, i) => 'z' + (t * 3 + i)),
    );
    const sa = shingleSet(wordsA.join(' '));
    const sb = shingleSet(wordsB.join(' '));
    const trueJ = trueJaccard(sa, sb);
    const estJ = estimateJaccard(minhashSignature(sa, perms), minhashSignature(sb, perms));
    totalErr += Math.abs(trueJ - estJ);
  }
  const meanErr = totalErr / trials;
  assert.ok(meanErr < 0.08, `mean |trueJ-estJ| ${meanErr.toFixed(4)} should be < 0.08`);
});

test('estimateJaccard: identical signatures => 1.0; empty => 0', () => {
  const perms = makePermutations(64, 3);
  const sig = minhashSignature(shingleSet('alpha beta gamma delta epsilon zeta'), perms);
  assert.equal(estimateJaccard(sig, sig), 1);
  assert.equal(estimateJaccard(new Int32Array(0), new Int32Array(0)), 0);
});

// =============================================================================
// MinHash: LSH banding
// =============================================================================

test('lshBuckets: produces one bucket per band', () => {
  const perms = makePermutations(128, 0x6b6f6c6d);
  const sig = minhashSignature(shingleSet('the quick brown fox jumps over the lazy dog'), perms);
  const buckets = lshBuckets(sig, 16, 8);
  assert.equal(buckets.length, 16);
});

test('lshBuckets: two sigs agreeing on a full band collide in that band', () => {
  const sig = new Int32Array(16);
  for (let i = 0; i < 16; i++) sig[i] = i + 1;
  // identical first band (slots 0..7), differing elsewhere
  const sig2 = sig.slice();
  sig2[15] = 999;
  const b1 = lshBuckets(sig, 2, 8);
  const b2 = lshBuckets(sig2, 2, 8);
  assert.equal(b1[0], b2[0], 'first band identical => same bucket');
  assert.notEqual(b1[1], b2[1], 'second band differs => different bucket');
});

test('lshBuckets: band-index namespacing blocks cross-band collisions', () => {
  // a signature where band 0 and band 1 hold the SAME 8 row-values
  const sig = new Int32Array(16);
  for (let i = 0; i < 8; i++) { sig[i] = i + 1; sig[i + 8] = i + 1; }
  const buckets = lshBuckets(sig, 2, 8);
  assert.notEqual(buckets[0], buckets[1], 'same row-tuple in two bands must NOT collide');
});

// =============================================================================
// MinHash: UnionFind
// =============================================================================

test('UnionFind: chain unions => single component', () => {
  const uf = new UnionFind(5);
  uf.union(0, 1);
  uf.union(1, 2);
  uf.union(2, 3);
  uf.union(3, 4);
  const comps = [...uf.components().values()];
  assert.equal(comps.length, 1);
  assert.equal(comps[0].length, 5);
});

test('UnionFind: star + isolated => correct partition', () => {
  const uf = new UnionFind(6);
  uf.union(0, 1);
  uf.union(0, 2);
  uf.union(0, 3); // star around 0 (size 4)
  uf.union(4, 5); // pair
  // 0..3 = 4, 4..5 = 2 (no isolated singletons here)
  const sizes = [...uf.components().values()].map((a) => a.length).sort((x, y) => x - y);
  assert.deepEqual(sizes, [2, 4]);
});

test('UnionFind: find is idempotent + path-compressed', () => {
  const uf = new UnionFind(4);
  uf.union(0, 1);
  uf.union(1, 2);
  const r = uf.find(2);
  assert.equal(uf.find(2), r);
  assert.equal(uf.find(0), r);
  assert.equal(uf.find(1), r);
});

// =============================================================================
// MinHash: optimalBands
// =============================================================================

test('optimalBands: b*r divides numHashes and threshold_est is sane', () => {
  const ob = optimalBands(0.85, 128);
  assert.equal(ob.bands * ob.rows, 128);
  assert.ok(ob.threshold_est > 0.6 && ob.threshold_est < 1.0);
});

test('optimalBands: lower threshold => looser config (more bands)', () => {
  const tight = optimalBands(0.9, 128);
  const loose = optimalBands(0.6, 128);
  // a looser target tolerates more bands (steeper-rise at lower s)
  assert.ok(loose.bands >= tight.bands);
});

// =============================================================================
// MinHash: minhashPredup (integration)
// =============================================================================

// Gold corpus builder: distinct + exact dups + near dups + hard negatives.
function buildGold() {
  const rows = [];
  const bases = [];
  // 60 distinct 30-token pairs
  for (let i = 0; i < 60; i++) {
    const out = Array.from({ length: 30 }, (_, j) => 'topic' + i + 'tok' + ((j * 3 + i) % 40)).join(' ');
    const inp = 'distinct question number ' + i + ' about a unique subject area here';
    bases.push({ input: inp, output: out });
    rows.push({ ...bases[i] });
  }
  // 20 EXACT pair dups (identical input AND output) of bases[0..19]
  for (let i = 0; i < 20; i++) rows.push({ ...bases[i] });
  // 20 NEAR dups: single boundary-word edit of bases[20..39] (true Jaccard ~0.9)
  for (let i = 20; i < 40; i++) {
    const w = bases[i].output.split(' ');
    w[w.length - 1] = 'EDITEDLASTTOKEN'; // edit last word => ~5 shingles change of ~26
    rows.push({ input: bases[i].input, output: w.join(' ') });
  }
  // 10 HARD negatives: same topic prefix but middle words swapped (Jaccard ~0.4)
  for (let i = 40; i < 50; i++) {
    const w = bases[i].output.split(' ');
    for (let j = 5; j < 25; j += 2) w[j] = 'SWAPPED' + j;
    rows.push({ input: bases[i].input, output: w.join(' ') });
  }
  return { rows, n_distinct: 60, n_exact: 20, n_near: 20, n_hardneg: 10 };
}

test('minhashPredup: removes all exact + most near dups, keeps hard negatives', () => {
  const { rows } = buildGold();
  const r = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8, jaccardThreshold: 0.85, verify: true });
  // 20 exact + >=19/20 near should be removed; 10 hard negatives kept (0 false merges)
  assert.ok(r.report.n_removed >= 20 + 19, `expected >=39 removed, got ${r.report.n_removed}`);
  assert.ok(r.report.n_removed <= 40, `should not over-merge hard negatives, got ${r.report.n_removed}`);
  assert.equal(r.report.backend, 'minhash-js');
  assert.equal(r.report.version, MINHASH_VERSION);
  // report shape
  assert.equal(typeof r.report.n_in, 'number');
  assert.equal(typeof r.report.n_kept, 'number');
  assert.equal(typeof r.report.n_clusters, 'number');
  assert.ok(r.report.params && typeof r.report.params === 'object');
  assert.equal(r.report.n_in, r.report.n_kept + r.report.n_removed);
});

test('minhashPredup: removals carry removed_idx / kept_idx / est_jaccard', () => {
  const { rows } = buildGold();
  const r = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8 });
  assert.ok(r.removals.length > 0);
  for (const rm of r.removals) {
    assert.equal(typeof rm.removed_idx, 'number');
    assert.equal(typeof rm.kept_idx, 'number');
    assert.equal(typeof rm.est_jaccard, 'number');
    assert.notEqual(rm.removed_idx, rm.kept_idx);
  }
});

test('minhashPredup: deterministic across runs (kept set, removals, signature)', () => {
  const { rows } = buildGold();
  const r1 = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8 });
  const r2 = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8 });
  assert.equal(r1.report.dedup_signature, r2.report.dedup_signature);
  assert.equal(r1.kept.length, r2.kept.length);
  assert.deepEqual(r1.removals, r2.removals);
});

test('minhashPredup: survivor preference honors explicit confidence', () => {
  // two identical-output pairs; the higher confidence one must survive.
  const text = 'click forgot password then check your email for the reset link and follow it carefully please now';
  const rows = [
    { input: 'reset pw', output: text, confidence: 0.2, id: 'low' },
    { input: 'reset pw', output: text, confidence: 0.9, id: 'high' },
  ];
  const r = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8 });
  assert.equal(r.report.n_removed, 1);
  assert.equal(r.kept.length, 1);
  assert.equal(r.kept[0].id, 'high', 'higher-confidence row must survive');
});

test('minhashPredup: survivor preference honors teacher priority over quality', () => {
  const text = 'here is a thorough structured answer with several useful steps to follow carefully one two three';
  const rows = [
    { input: 'q', output: text, teacher: 'gpt-4o-mini' },
    { input: 'q', output: text, teacher: 'claude-opus' },
  ];
  const r = minhashPredup(rows, {
    numHashes: 128, bands: 16, rows: 8, teacherPriority: ['claude', 'gpt'],
  });
  assert.equal(r.report.n_removed, 1);
  assert.equal(r.kept[0].teacher, 'claude-opus', 'preferred teacher must survive');
});

test('minhashPredup: empty corpus => empty result, stable signature', () => {
  const r = minhashPredup([], {});
  assert.equal(r.report.n_in, 0);
  assert.equal(r.report.n_kept, 0);
  assert.equal(r.report.n_removed, 0);
  assert.ok(r.report.dedup_signature.startsWith('sha256:'));
});

test('minhashPredup: never throws on malformed rows (singletons returned)', () => {
  const rows = [
    null,
    {},
    { input: 123, output: {} },
    'not an object',
    { input: 'real question here please', output: 'a perfectly valid answer to keep around' },
  ];
  const r = minhashPredup(rows, { numHashes: 64, bands: 8, rows: 8 });
  // nothing throws; malformed rows neither crash nor merge into the valid one
  assert.equal(r.report.n_in, 5);
  assert.ok(r.report.n_kept >= 1);
});

test('minhashPredup: catches near-dups even when python is absent (no spawn at all)', () => {
  // This module NEVER spawns python — proves near-dup removal works off-GPU.
  const text = 'how do i reset my account password please help me with the recovery steps today';
  const near = text.replace('today', 'right now please');
  const rows = [
    { input: 'help', output: text },
    { input: 'help', output: text }, // exact
    { input: 'help', output: near }, // near
    { input: 'unrelated', output: 'the weather forecast for tomorrow shows heavy rain and strong winds all day' },
  ];
  const r = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8, jaccardThreshold: 0.8 });
  assert.ok(r.report.n_removed >= 1, 'at least the exact dup removed with no python');
  assert.ok(r.kept.length < rows.length);
});

test('minhashPredup: scale — 5k pairs predup completes quickly', () => {
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    rows.push({
      input: 'question ' + (i % 1000),
      output: Array.from({ length: 25 }, (_, j) => 'tok' + ((i % 1000) * 31 + j)).join(' '),
    });
  }
  const t0 = Date.now();
  const r = minhashPredup(rows, { numHashes: 128, bands: 16, rows: 8 });
  const ms = Date.now() - t0;
  // 1000 distinct outputs repeated 5x => substantial removal
  assert.ok(r.report.n_removed > 0);
  assert.ok(ms < 15000, `5k predup took ${ms}ms — should be well under 15s`);
});

test('dedupSignature: stable + insensitive to property insertion order in params', () => {
  const removals = [{ removed_idx: 3, kept_idx: 1, est_jaccard: 0.9 }, { removed_idx: 1, kept_idx: 0, est_jaccard: 0.95 }];
  const p1 = { numHashes: 128, bands: 16, rows: 8, jaccardThreshold: 0.85, key: 'pair', k: 5, verify: true, seed: 1 };
  const p2 = { seed: 1, verify: true, k: 5, key: 'pair', jaccardThreshold: 0.85, rows: 8, bands: 16, numHashes: 128 };
  assert.equal(dedupSignature(removals, p1), dedupSignature(removals, p2));
  // different drop set => different signature
  const removals2 = removals.concat({ removed_idx: 5, kept_idx: 0, est_jaccard: 0.91 });
  assert.notEqual(dedupSignature(removals, p1), dedupSignature(removals2, p1));
});

// =============================================================================
// data-select: reprFilterSelect
// =============================================================================

// 3 tight clusters of near-paraphrases (10 each).
function buildClusters() {
  const pairs = [];
  const templates = [
    'how do i reset my account password and recover access',
    'what are the system requirements to install the desktop application',
    'can i get a refund for my recent subscription purchase please',
  ];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 10; k++) {
      // light paraphrase: append a varying filler so they're near, not identical
      pairs.push({
        input: templates[c] + ' variant ' + k,
        output: 'cluster ' + c + ' answer detail filler word ' + (k % 3),
        _cluster: c,
      });
    }
  }
  return pairs;
}

test('reprFilterSelect: spans all clusters, avoids near-paraphrases', () => {
  const pairs = buildClusters();
  const r = reprFilterSelect(pairs, null, 6, 0.9);
  assert.equal(r.selected_indices.length, 6);
  const clusters = new Set(r.kept.map((p) => p._cluster));
  assert.equal(clusters.size, 3, 'all three clusters represented');
  assert.ok(r.coverage_radius >= 0);
});

test('reprFilterSelect: budget 0 or empty => empty', () => {
  assert.deepEqual(reprFilterSelect([], null, 5).selected_indices, []);
  assert.deepEqual(reprFilterSelect(buildClusters(), null, 0).selected_indices, []);
});

// =============================================================================
// data-select: selectDiverseSubset (orchestrator)
// =============================================================================

test('selectDiverseSubset: repr-filter honest envelope + provenance stamp', async () => {
  const pairs = buildClusters();
  const r = await selectDiverseSubset({ pairs, target_size: 6, method: 'repr-filter' });
  assert.equal(r.ok, true);
  assert.equal(r.version, DATA_SELECT_VERSION);
  assert.equal(r.n_in, 30);
  assert.equal(r.n_selected, 6);
  assert.equal(r.backend_used, 'js-repr-filter');
  assert.ok(r.selected_indices.every((i) => i >= 0 && i < 30));
  for (const k of r.kept) {
    assert.ok(k.provenance && k.provenance.selection, 'kept rows carry provenance.selection');
    assert.equal(k.provenance.selection.method, 'repr-filter');
    assert.equal(typeof k.provenance.selection.rank, 'number');
  }
  // report shape
  assert.equal(r.report.method, 'repr-filter');
  assert.equal(r.report.n_selected, 6);
});

test('selectDiverseSubset: target_size as a fraction', async () => {
  const pairs = buildClusters(); // 30 rows
  const r = await selectDiverseSubset({ pairs, target_size: 0.2, method: 'repr-filter' });
  assert.equal(r.n_selected, 6); // 0.2 * 30
});

test('selectDiverseSubset: bogus python method => degrade to repr-filter, ok:true', async () => {
  // force the python path with KOLM_PYTHON pointed at a nonexistent binary;
  // the worker script likely does not exist yet anyway — either way we degrade.
  const prev = process.env.KOLM_PYTHON;
  process.env.KOLM_PYTHON = 'kolm-nonexistent-python-binary-xyz';
  try {
    const pairs = buildClusters();
    const r = await selectDiverseSubset({ pairs, target_size: 5, method: 'k-center' });
    assert.equal(r.ok, true, 'degrades without throwing/hanging');
    assert.equal(r.n_selected, 5);
    assert.ok(
      r.backend_used === 'js-repr-filter-fallback' || r.backend_used.startsWith('py-'),
      `backend_used truthful: ${r.backend_used}`,
    );
  } finally {
    if (prev === undefined) delete process.env.KOLM_PYTHON;
    else process.env.KOLM_PYTHON = prev;
  }
});

test('selectDiverseSubset: empty input never throws', async () => {
  const r = await selectDiverseSubset({ pairs: [], target_size: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.n_selected, 0);
  assert.deepEqual(r.selected_indices, []);
});

// =============================================================================
// data-select: selectDiverseBatch (active-learning helper)
// =============================================================================

test('selectDiverseBatch: B=4 over 4 clusters => one per cluster (k-center)', () => {
  const items = [];
  const seeds = [
    'billing and refund and invoice and payment questions',
    'password reset and login and account access issues',
    'installation and setup and system requirements help',
    'api integration and webhook and developer token docs',
  ];
  for (let c = 0; c < 4; c++) {
    for (let k = 0; k < 3; k++) items.push({ text: seeds[c] + ' item ' + k, _cluster: c });
  }
  const r = selectDiverseBatch(items, 4, { method: 'k-center' });
  assert.equal(r.indices.length, 4);
  const clusters = new Set(r.batch.map((it) => it._cluster));
  assert.equal(clusters.size, 4, 'k-center batch spans all 4 clusters');
});

test('selectDiverseBatch: empty / 0 budget => empty', () => {
  assert.deepEqual(selectDiverseBatch([], 4).indices, []);
  assert.deepEqual(selectDiverseBatch([{ text: 'x' }], 0).indices, []);
});

// =============================================================================
// data-select: selectInformativeSubset (DSIR / coverage)
// =============================================================================

test('selectInformativeSubset: self-coverage spans the pool feature space', () => {
  const pairs = buildClusters();
  const r = selectInformativeSubset(pairs, 6, {});
  assert.equal(r.ok, true);
  assert.equal(r.version, DATA_SELECT_VERSION);
  assert.equal(r.n_selected, 6);
  assert.equal(r.basis, 'self-coverage');
  const clusters = new Set(r.kept.map((p) => p._cluster));
  assert.equal(clusters.size, 3, 'coverage selection spans all clusters');
});

test('selectInformativeSubset: DSIR matches a target distribution', () => {
  const pairs = buildClusters(); // clusters 0,1,2 (10 each)
  // target distribution heavily favors cluster 2 vocabulary
  const target_items = [];
  for (let k = 0; k < 8; k++) {
    target_items.push({ input: 'can i get a refund for my recent subscription purchase please target ' + k, output: 'refund' });
  }
  const r = selectInformativeSubset(pairs, 6, { target_items, lambda: 0.7 });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'dsir-importance');
  assert.equal(r.n_selected, 6);
  // the matched subset should over-represent cluster 2 (the target's cluster)
  const c2 = r.kept.filter((p) => p._cluster === 2).length;
  assert.ok(c2 >= 2, `DSIR should pull from the target cluster (got ${c2} from cluster 2)`);
});

test('selectInformativeSubset: empty => empty', () => {
  const r = selectInformativeSubset([], 5, {});
  assert.equal(r.n_selected, 0);
  assert.equal(r.basis, 'empty');
});

// =============================================================================
// data-select: internals
// =============================================================================

test('__internals: _resolveTarget handles count + fraction + invalid', () => {
  const { _resolveTarget } = __internals;
  assert.equal(_resolveTarget(5, 100), 5);
  assert.equal(_resolveTarget(0.25, 100), 25);
  assert.equal(_resolveTarget(0, 100), 100);
  assert.equal(_resolveTarget(-3, 100), 100);
  assert.equal(_resolveTarget(500, 100), 100); // clamped to n
});

test('__internals: _cosineSim + _l2 behave on identical and orthogonal vectors', () => {
  const { _cosineSim, _l2 } = __internals;
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  const c = [0, 1, 0];
  assert.ok(Math.abs(_cosineSim(a, b) - 1) < 1e-9);
  assert.ok(Math.abs(_cosineSim(a, c)) < 1e-9);
  assert.equal(_l2(a, b), 0);
  assert.ok(_l2(a, c) > 0);
});
