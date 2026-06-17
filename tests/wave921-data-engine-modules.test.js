// W921 — KOLM Data Engine frontier curation modules (the REMAINING specs).
//
// Covers the five dependency-free data modules + their additive wiring into
// src/data-curate.js. Quality is default-on after W628; the remaining advanced
// stages still prove explicit opt-in / opt-out behavior:
//   - src/data-label-errors.js       (Confident Learning + CLEAR/BSDetector)
//   - src/data-scaling-law.js        (Rectified Scaling Law data-budget model)
//   - src/data-diversity-select.js   (k-center / facility-location / BADGE)
//   - src/data-cluster-label.js      (embedding k-means + c-TF-IDF topic labels)
//   - src/data-quality-classifier.js (FineWeb-Edu/DCLM/AlpaGasus learned scorer)
//
// All pure JS, zero new deps, deterministic, runs on a python-less box. Every
// assertion is a property/threshold check (no exact byte counts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  LABEL_ERROR_VERSION,
  detectLabelErrors,
  confidentJointAgreement,
  scoreOutputClusterProbs,
  bsDetectorConfidence,
  routeErrorsToReview,
} from '../src/data-label-errors.js';

import {
  SCALING_LAW_VERSION,
  fitDataScalingLaw,
  kHatAtSize,
  marginalDkPerRow,
  pairsToTarget,
  recommendDataBudget,
  _kToPseudoLoss,
  _pseudoLossToK,
} from '../src/data-scaling-law.js';

import {
  DIVERSITY_SELECT_VERSION,
  selectDiverse,
  kCenterGreedy,
  facilityLocationSelect,
  badgeSelect,
} from '../src/data-diversity-select.js';

import {
  CLUSTER_LABEL_VERSION,
  clusterAndLabel,
  kmeans,
  chooseK,
  labelClustersCtfidf,
  _slugifyLabel,
} from '../src/data-cluster-label.js';

import {
  QUALITY_CLASSIFIER_VERSION,
  extractFeatures,
  scoreQuality,
  fitQualityModel,
  heuristicQualityScore,
  applyThreshold,
  doctor as qcDoctor,
} from '../src/data-quality-classifier.js';

// =============================================================================
// data-label-errors: Confident Learning
// =============================================================================

// 3 clusters x 10 pairs; outputs are topic-dominated so the topic signal is
// stronger than shared boilerplate (the embedder is a coarse hash-bag).
function buildCLCorpus(swaps) {
  const topics = [
    'refund billing invoice payment money charge bank account statement',
    'password login signin access reset security token credential verify',
    'install setup download requirements desktop application binary package',
  ];
  const rows = [];
  for (let c = 0; c < 3; c++) {
    for (let k = 0; k < 10; k++) {
      rows.push({ input: topics[c] + ' question ' + k, output: topics[c] + ' detailed answer covering it ' + k, cluster_id: 'c' + c });
    }
  }
  for (const { idx, toCluster } of (swaps || [])) {
    rows[idx].output = topics[toCluster] + ' detailed answer covering it foreign';
  }
  return rows;
}

test('label-errors: version export', () => {
  assert.equal(LABEL_ERROR_VERSION, 'label-error-v1');
});

test('detectLabelErrors: offline CL flags exactly the injected off-diagonal swaps', async () => {
  const swaps = [{ idx: 2, toCluster: 1 }, { idx: 13, toCluster: 2 }, { idx: 24, toCluster: 0 }];
  const rows = buildCLCorpus(swaps);
  const r = await detectLabelErrors({ pairs: rows, clusterField: 'cluster_id', method: 'cl', action: 'review' });
  assert.equal(r.flagged, 3);
  const flaggedIdx = r.sample.map((s) => s.index).sort((a, b) => a - b);
  assert.deepEqual(flaggedIdx, [2, 13, 24]);
  assert.ok(Math.abs(r.off_diagonal_rate - 0.1) < 0.04, `off_rate ${r.off_diagonal_rate} ~ 0.1`);
});

test('scoreOutputClusterProbs: rows are stochastic + length K', () => {
  const centroids = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const embs = [[1, 0, 0], [0, 1, 0]];
  const probs = scoreOutputClusterProbs(embs, centroids);
  assert.equal(probs.length, 2);
  for (const row of probs) {
    assert.equal(row.length, 3);
    const sum = row.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `row sums to 1 (${sum})`);
    assert.ok(row.every((x) => x >= 0 && x <= 1));
  }
});

test('confidentJointAgreement: pure primitive flags the off-diagonal', () => {
  // 4 pairs in cluster 0, but one's output prob points strongly at cluster 1.
  const pairs = [{}, {}, {}, {}];
  const probs = [
    [0.9, 0.1],
    [0.85, 0.15],
    [0.1, 0.9], // off-diagonal: given cluster 0, confident cluster 1
    [0.8, 0.2],
  ];
  const r = confidentJointAgreement(pairs, probs, () => 0, 2);
  assert.equal(r.thresholds.length, 2);
  assert.ok(r.flags.some((f) => f.index === 2 && f.confident_cluster === 1));
  assert.ok(r.off_diagonal_rate > 0);
});

test('detectLabelErrors: review action flags + never drops; provenance stamped', async () => {
  const swaps = [{ idx: 5, toCluster: 2 }, { idx: 17, toCluster: 0 }];
  const rows = buildCLCorpus(swaps);
  const r = await detectLabelErrors({ pairs: rows, clusterField: 'cluster_id', method: 'cl', action: 'review' });
  assert.equal(r.ok, true);
  assert.equal(r.version, 'label-error-v1');
  assert.equal(r.backend, 'cl-dense');
  assert.ok(r.flagged >= 2);
  assert.equal(rows.length, 30, 'no pair dropped (review only flags)');
  for (const e of r.flagged_entries) {
    assert.ok(e.pair.provenance && e.pair.provenance.error_flag);
    assert.equal(e.pair.provenance.error_flag.method, 'cl');
    assert.ok(['answer_topic_mismatch'].includes(e.pair.provenance.error_flag.reason));
  }
});

test('detectLabelErrors: single cluster => no off-diagonal possible, ok:true', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ input: 'q' + i, output: 'a' + i, cluster_id: 'only' }));
  const r = await detectLabelErrors({ pairs: rows, clusterField: 'cluster_id', method: 'cl' });
  assert.equal(r.ok, true);
  assert.equal(r.flagged, 0);
  assert.equal(r.off_diagonal_rate, 0);
  assert.match(r.note, /single_cluster/);
});

test('detectLabelErrors: empty corpus never throws', async () => {
  const r = await detectLabelErrors({ pairs: [] });
  assert.equal(r.ok, true);
  assert.equal(r.flagged, 0);
});

test('bsDetectorConfidence: C = 0.7*O + 0.3*S for known O,S', async () => {
  // sample returns 3 exact-match + 2 unrelated; reflect => Correct (S=1)
  const out = 'the deterministic answer to the question is forty two clearly';
  const c = await bsDetectorConfidence({
    input: 'q',
    output: out,
    sample: async () => [out, out, out, 'completely unrelated weather forecast text', 'another unrelated thing'],
    reflect: async () => 'Correct',
    alpha: 0.8, beta: 0.7, k: 5,
  });
  // O = (3*1.0 + 2*~0) / 5 ~= 0.6 ; S = 1 ; C = 0.7*0.6 + 0.3*1 = 0.72
  assert.ok(Math.abs(c.self_reflection - 1) < 1e-9);
  assert.ok(Math.abs(c.observed_consistency - 0.6) < 0.06, `O ~ 0.6 (${c.observed_consistency})`);
  assert.ok(Math.abs(c.confidence - (0.7 * c.observed_consistency + 0.3 * c.self_reflection)) < 1e-6);
});

test('bsDetectorConfidence: reflection ladder maps to {0,0.5,1}', async () => {
  const mk = (grade) => bsDetectorConfidence({ input: 'q', output: 'o', sample: async () => ['o'], reflect: async () => grade, beta: 0 });
  assert.equal((await mk('Incorrect')).self_reflection, 0);
  assert.equal((await mk('Uncertain')).self_reflection, 0.5);
  assert.equal((await mk('Correct')).self_reflection, 1);
});

test('detectLabelErrors: CLEAR path uses median(C) gamma + flags low-confidence', async () => {
  // 6 pairs; 2 deliberately low-consistency (sample never matches the stored output)
  const rows = [
    { input: 'a', output: 'alpha answer one' },
    { input: 'b', output: 'beta answer two' },
    { input: 'c', output: 'gamma answer three' },
    { input: 'd', output: 'delta answer four' },
    { input: 'e', output: 'epsilon answer five' },
    { input: 'f', output: 'zeta answer six' },
  ];
  // sampler echoes the stored output for the first 4, returns garbage for last 2
  const sample = async (input) => {
    const idx = rows.findIndex((r) => r.input === input);
    if (idx < 4) return [rows[idx].output, rows[idx].output, rows[idx].output];
    return ['totally different text', 'totally different text', 'totally different text'];
  };
  const r = await detectLabelErrors({ pairs: rows, method: 'clear', sample, action: 'review' });
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'clear-teacher');
  assert.equal(typeof r.median_confidence, 'number');
  assert.ok(r.flagged >= 1, 'at least the low-consistency pairs flagged below median');
});

test('routeErrorsToReview: enqueues via injected appender (no real event-store)', async () => {
  const seen = [];
  const appendEvent = async (ev) => { seen.push(ev); return { event_id: 'ev_' + seen.length }; };
  const r = await routeErrorsToReview({
    flaggedPairs: [
      { pair: { input: 'q1', output: 'o1' }, method: 'cl', score: 0.9, reason: 'answer_topic_mismatch' },
      { pair: { input: 'q2', output: 'o2' }, method: 'cl', score: 0.8, reason: 'answer_topic_mismatch' },
    ],
    tenant: 't', namespace: 'ns', appendEvent,
  });
  assert.equal(r.enqueued, 2);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].status, 'needs_review');
  assert.match(seen[0].feedback, /curate-label-error/);
});

// =============================================================================
// data-scaling-law: Rectified Scaling Law
// =============================================================================

// generate (n_pairs, K) from a known rectified law
function rectifiedPoints({ B, D_l, beta, E }, Ds) {
  return Ds.map((D) => ({ n_pairs: D, k: Math.exp(-(B / (D_l + Math.pow(D, beta)) + E)) }));
}

test('scaling-law: version + pseudo-loss bridge round-trips + monotone', () => {
  assert.equal(SCALING_LAW_VERSION, 'sl-v1');
  for (const k of [0.1, 0.5, 0.85, 0.99]) {
    assert.ok(Math.abs(_pseudoLossToK(_kToPseudoLoss(k)) - k) < 1e-6);
  }
  // L = -ln K is strictly decreasing in K
  assert.ok(_kToPseudoLoss(0.2) > _kToPseudoLoss(0.8));
});

test('scaling-law: recovers a known curve (held-out RMSD <= 0.05) + deterministic', async () => {
  const truth = { B: 8, D_l: 200, beta: 0.35, E: 0.12 };
  const pts = rectifiedPoints(truth, [50, 100, 200, 400, 800, 1600]);
  const fit1 = await fitDataScalingLaw({ points: pts });
  const fit2 = await fitDataScalingLaw({ points: pts });
  assert.equal(fit1.basis, 'rectified');
  assert.ok(fit1.rmsd <= 0.05, `rmsd ${fit1.rmsd}`);
  // determinism: identical points => identical params
  assert.deepEqual(fit1.params, fit2.params);
  // held-out: predict a point not in the fit grid within +-0.05
  const trueK1000 = Math.exp(-(truth.B / (truth.D_l + Math.pow(1000, truth.beta)) + truth.E));
  assert.ok(Math.abs(kHatAtSize(fit1, 1000) - trueK1000) < 0.05);
});

test('scaling-law: kHatAtSize monotone-increasing + saturating in (0,1]', async () => {
  const pts = rectifiedPoints({ B: 8, D_l: 200, beta: 0.35, E: 0.12 }, [50, 100, 200, 400, 800, 1600]);
  const fit = await fitDataScalingLaw({ points: pts });
  const ks = [100, 200, 400, 800, 1600, 5000].map((D) => kHatAtSize(fit, D));
  for (let i = 1; i < ks.length; i++) assert.ok(ks[i] >= ks[i - 1] - 1e-9, 'monotone non-decreasing');
  for (const k of ks) assert.ok(k > 0 && k <= 1);
  // approaches exp(-E) as D -> inf
  assert.ok(Math.abs(kHatAtSize(fit, 1e9) - fit.achievable_k_max) < 0.02);
});

test('scaling-law: marginalDkPerRow matches finite difference + decreasing', async () => {
  const pts = rectifiedPoints({ B: 8, D_l: 200, beta: 0.35, E: 0.12 }, [50, 100, 200, 400, 800, 1600]);
  const fit = await fitDataScalingLaw({ points: pts });
  const D = 400;
  const analytic = marginalDkPerRow(fit, D);
  const fd = kHatAtSize(fit, D + 1) - kHatAtSize(fit, D);
  assert.ok(Math.abs(analytic - fd) < 1e-4, `analytic ${analytic} ~ fd ${fd}`);
  assert.ok(marginalDkPerRow(fit, 100) > marginalDkPerRow(fit, 1000), 'diminishing returns');
});

test('scaling-law: pairsToTarget reachable vs unreachable', async () => {
  const truth = { B: 8, D_l: 200, beta: 0.35, E: 0.12 };
  const pts = rectifiedPoints(truth, [50, 100, 200, 400, 800, 1600]);
  const fit = await fitDataScalingLaw({ points: pts });
  const trueK1000 = Math.exp(-(truth.B / (truth.D_l + Math.pow(1000, truth.beta)) + truth.E));
  const r = pairsToTarget(fit, trueK1000);
  assert.equal(r.reachable, true);
  assert.ok(r.pairs_to_target > 0);
  // crossing within 1.5x of the true 1000
  assert.ok(r.pairs_to_target >= 1000 / 1.5 && r.pairs_to_target <= 1000 * 1.5, `ptt ${r.pairs_to_target}`);
  // target above the asymptote is unreachable
  const hi = pairsToTarget(fit, 0.999);
  assert.equal(hi.reachable, false);
  assert.equal(hi.pairs_to_target, null);
});

test('scaling-law: cold start (<min_points) => insufficient, ok:true', async () => {
  const r = await fitDataScalingLaw({ points: [{ n_pairs: 100, k: 0.5 }, { n_pairs: 200, k: 0.6 }] });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'insufficient');
  assert.equal(r.params, undefined);
});

test('scaling-law: junk points (non-monotone noise) => insufficient (refuses junk fit)', async () => {
  const pts = [
    { n_pairs: 50, k: 0.9 }, { n_pairs: 100, k: 0.2 }, { n_pairs: 200, k: 0.8 },
    { n_pairs: 400, k: 0.1 }, { n_pairs: 800, k: 0.95 }, { n_pairs: 1600, k: 0.05 },
  ];
  const r = await fitDataScalingLaw({ points: pts, rmsd_gate: 0.05 });
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'insufficient');
});

test('scaling-law: recommendDataBudget stop/acquire/switch', async () => {
  const truth = { B: 8, D_l: 200, beta: 0.35, E: 0.12 };
  const pts = rectifiedPoints(truth, [50, 100, 200, 400, 800, 1600]);
  const fit = await fitDataScalingLaw({ points: pts });
  // target above achievable => switch_strategy
  const sw = recommendDataBudget({ fit, current_pairs: 400, target_kscore: 0.999, min_delta_k: 0.01, expected_batch_rows: 100, cost_per_row_usd: 0.01 });
  assert.equal(sw.recommend, 'switch_strategy');
  // tiny marginal => stop
  const trueK1000 = Math.exp(-(truth.B / (truth.D_l + Math.pow(1000, truth.beta)) + truth.E));
  const st = recommendDataBudget({ fit, current_pairs: 5000, target_kscore: trueK1000, min_delta_k: 0.1, expected_batch_rows: 1 });
  assert.equal(st.recommend, 'stop');
  // no fit => acquire (fall through)
  const nf = recommendDataBudget({ fit: { basis: 'insufficient' }, current_pairs: 100, target_kscore: 0.85 });
  assert.equal(nf.recommend, 'acquire');
});

// =============================================================================
// data-diversity-select: BADGE / k-center / facility-location
// =============================================================================

function buildDivClusters() {
  const seeds = [
    'billing refund invoice payment money charge bank',
    'password login account access reset security token',
    'install setup download requirements desktop application',
    'api integration webhook developer token endpoint docs',
  ];
  const items = [];
  for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) items.push({ input: seeds[c] + ' variant ' + k, output: 'answer ' + c, _c: c });
  return items;
}

test('diversity-select: version export', () => {
  assert.equal(DIVERSITY_SELECT_VERSION, 'divsel-v1');
});

test('diversity-select: every method spans all 4 clusters at B=4', () => {
  const items = buildDivClusters();
  for (const method of ['k-center', 'facility-location', 'badge']) {
    const r = selectDiverse({ items, target_size: 4, method });
    assert.equal(r.ok, true);
    assert.equal(r.n_selected, 4);
    const cl = new Set(r.kept.map((p) => p._c));
    assert.equal(cl.size, 4, `${method} spans all 4 clusters`);
    // provenance stamp
    for (const k of r.kept) assert.equal(k.provenance.selection.method, method);
  }
});

test('diversity-select: BADGE deterministic across runs', () => {
  const items = buildDivClusters();
  const r1 = selectDiverse({ items, target_size: 5, method: 'badge' });
  const r2 = selectDiverse({ items, target_size: 5, method: 'badge' });
  assert.deepEqual(r1.selected_indices, r2.selected_indices);
});

test('diversity-select: kCenterGreedy coverage_radius shrinks as B grows', () => {
  const items = buildDivClusters();
  const embs = null; // let it embed
  void embs;
  const r2 = selectDiverse({ items, target_size: 2, method: 'k-center' });
  const r8 = selectDiverse({ items, target_size: 8, method: 'k-center' });
  assert.ok(r8.coverage_radius <= r2.coverage_radius + 1e-9, 'more centers => smaller covering radius');
});

test('diversity-select: facilityLocation objective is non-decreasing in selection', () => {
  const items = buildDivClusters();
  const embs = items.map(() => null);
  void embs;
  const small = selectDiverse({ items, target_size: 2, method: 'facility-location' });
  const big = selectDiverse({ items, target_size: 6, method: 'facility-location' });
  assert.ok(big.objective >= small.objective - 1e-9, 'submodular objective grows with budget');
});

test('diversity-select: primitives on a raw embedding matrix', () => {
  const embs = [[1, 0], [0.99, 0.01], [0, 1], [0.01, 0.99], [-1, 0]];
  const kc = kCenterGreedy(embs, 3, [0]);
  assert.equal(kc.selected_indices.length, 3);
  const fl = facilityLocationSelect(embs, 2);
  assert.equal(fl.selected_indices.length, 2);
  assert.ok(fl.objective > 0);
  const bd = badgeSelect(embs, [1, 1, 5, 1, 1], 2, 7);
  assert.equal(bd.selected_indices.length, 2);
  // BADGE first pick is the max-weight point (index 2)
  assert.ok(bd.selected_indices.includes(2));
});

test('diversity-select: empty / zero budget => empty, never throws', () => {
  assert.equal(selectDiverse({ items: [], target_size: 5 }).n_selected, 0);
  assert.equal(selectDiverse({ items: buildDivClusters(), target_size: 0 }).n_selected, 16); // 0 => full pool
  assert.deepEqual(kCenterGreedy([], 5).selected_indices, []);
  assert.deepEqual(facilityLocationSelect([], 5).selected_indices, []);
  assert.deepEqual(badgeSelect([], null, 5).selected_indices, []);
});

// =============================================================================
// data-cluster-label: k-means + c-TF-IDF
// =============================================================================

function buildLabelCorpus() {
  const grp = [
    ['how do i reset my password', 'i forgot my password help', 'cannot login password reset', 'reset account password please'],
    ['where are my invoices', 'download invoice pdf', 'billing invoice receipts', 'find my receipts'],
    ['install the desktop app', 'setup system requirements', 'download installer guide', 'minimum requirements install'],
  ];
  const pairs = []; const truth = [];
  for (let g = 0; g < 3; g++) for (const q of grp[g]) { pairs.push({ input: q, output: 'ok' }); truth.push(g); }
  return { pairs, truth };
}

test('cluster-label: version export', () => {
  assert.equal(CLUSTER_LABEL_VERSION, 'cluster-label-v1');
});

test('cluster-label: named human-readable slugs, never cluster_fb_*', async () => {
  const { pairs } = buildLabelCorpus();
  const r = await clusterAndLabel({ pairs, n_clusters: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.k, 3);
  assert.match(r.method, /^kmeans:/);
  for (const t of r.topics) {
    assert.match(t.cluster_id, /^[a-z0-9_]+$/, 'lowercase_underscore slug');
    assert.ok(!/^cluster_fb_/.test(t.cluster_id), 'not a fallback bucket id');
    assert.ok(t.top_terms.length >= 1);
    assert.ok(Array.isArray(t.representative_inputs));
  }
  // coverage sums to corpus size
  const sum = Object.values(r.coverage).reduce((a, b) => a + b, 0);
  assert.equal(sum, pairs.length);
});

test('cluster-label: paraphrases with different 3-word prefixes share a cluster', async () => {
  const { pairs } = buildLabelCorpus();
  const r = await clusterAndLabel({ pairs, n_clusters: 3 });
  // "how do i reset my password" (idx 0) and "reset account password please" (idx 3)
  // have DIFFERENT first-3-words — the property the 3-gram bucket fails.
  assert.equal(r.assigned[0].cluster_id, r.assigned[3].cluster_id);
});

test('cluster-label: deterministic assignment + auto-k bounded', async () => {
  const { pairs } = buildLabelCorpus();
  const r1 = await clusterAndLabel({ pairs });
  const r2 = await clusterAndLabel({ pairs });
  assert.deepEqual(r1.assigned, r2.assigned);
  assert.ok(r1.k >= 2 && r1.k <= Math.floor(pairs.length / 2));
});

test('cluster-label: n_clusters override sets k_method=override', async () => {
  const { pairs } = buildLabelCorpus();
  const r = await clusterAndLabel({ pairs, n_clusters: 4 });
  assert.equal(r.k_method, 'override');
  assert.equal(r.k, 4);
});

test('cluster-label: teacher labeler tier + graceful fallback', async () => {
  const { pairs } = buildLabelCorpus();
  // labeler renames each cluster; assert it is consulted exactly k times
  let calls = 0;
  const r = await clusterAndLabel({
    pairs, n_clusters: 3,
    labeler: async ({ idx }) => { calls += 1; return { label: 'Topic ' + idx, description: 'desc ' + idx }; },
  });
  assert.equal(calls, 3);
  assert.match(r.method, /teacher/);
  assert.ok(r.topics.every((t) => t.description != null));
  // labeler that throws => falls back to ctfidf, never throws
  const r2 = await clusterAndLabel({ pairs, n_clusters: 3, labeler: async () => { throw new Error('boom'); } });
  assert.equal(r2.ok, true);
  assert.match(r2.method, /teacher_partial|ctfidf/);
});

test('cluster-label: empty corpus => empty, ok:true', async () => {
  const r = await clusterAndLabel({ pairs: [] });
  assert.equal(r.ok, true);
  assert.equal(r.topics.length, 0);
});

test('cluster-label: primitives — kmeans labels, chooseK, c-TF-IDF, slugify', () => {
  // 2 well-separated blobs in 2D-ish embedding via distinct vocab
  const embs = [[1, 0, 0], [0.95, 0.05, 0], [0, 0, 1], [0.02, 0, 0.98]];
  const km = kmeans(embs, 2, { seed: 1 });
  assert.equal(km.labels.length, 4);
  assert.equal(km.centroids.length, 2);
  assert.equal(_slugifyLabel('Refund & Return Policy!'), 'refund_return_policy');
  const ck = chooseK(embs, null, 2, 3);
  assert.ok(ck.k >= 2);
  const labels = [0, 0, 1, 1];
  const ctf = labelClustersCtfidf(['refund money charge', 'refund billing payment', 'install download setup', 'install requirements binary'], labels, 2, 2);
  assert.equal(ctf.length, 2);
  assert.ok(ctf[0].top_terms.includes('refund'));
});

// =============================================================================
// data-quality-classifier: FineWeb-Edu/DCLM/AlpaGasus
// =============================================================================

const CLEAN = { input: 'how do i cancel my subscription', output: 'Open Billing, select your plan, and click Cancel Subscription. Access continues until the period ends.' };
const STRUCTURED = { input: 'how do i set up', output: 'A complete structured setup answer: 1. open settings 2. click save 3. you are done now and synced.' };
const COT = { input: 'plan a trip', output: '<think>let me reason about the budget and dates first</think> Here is a plan.' };
const REFUSAL = { input: 'do x', output: 'I am sorry, I cannot help with that request as an AI.' };
const EMPTY = { input: 'x', output: '' };

test('quality-classifier: version + feature vector shape', () => {
  assert.equal(QUALITY_CLASSIFIER_VERSION, 'quality-v1');
  const f = extractFeatures(CLEAN);
  assert.equal(f.length, 10);
  assert.equal(f[0], 1, 'bias term');
  assert.equal(extractFeatures(EMPTY)[9], 1, 'empty flag set');
  assert.equal(extractFeatures(COT)[2], 1, 'cot_leak flag set');
});

test('quality-classifier: learned-default ranks clean > cot > refusal, clean > empty', () => {
  const r = scoreQuality({ rows: [CLEAN, COT, REFUSAL, EMPTY] });
  assert.equal(r.ok, true);
  assert.match(r.backend, /learned/);
  assert.ok(r.scores.every((x) => x >= 0 && x <= 1));
  assert.ok(r.scores[0] > r.scores[1], 'clean > cot');
  assert.ok(r.scores[1] > r.scores[3] || r.scores[0] > r.scores[3], 'clean/cot > empty');
  assert.ok(r.scores[0] > r.scores[3], 'clean > empty');
});

test('quality-classifier: heuristic floor preserves the same ordering', () => {
  assert.ok(heuristicQualityScore(CLEAN) > heuristicQualityScore(COT));
  assert.ok(heuristicQualityScore(CLEAN) > heuristicQualityScore(EMPTY));
  assert.ok(heuristicQualityScore(STRUCTURED) > heuristicQualityScore(REFUSAL));
});

test('quality-classifier: fit learns weights + is deterministic + separates', () => {
  const fit1 = fitQualityModel({ posRows: [CLEAN, STRUCTURED], negRows: [COT, REFUSAL, EMPTY] });
  const fit2 = fitQualityModel({ posRows: [CLEAN, STRUCTURED], negRows: [COT, REFUSAL, EMPTY] });
  assert.equal(fit1.ok, true);
  assert.equal(fit1.model.trained, true);
  assert.deepEqual(fit1.model.w, fit2.model.w, 'deterministic training');
  const sc = scoreQuality({ rows: [CLEAN, EMPTY], model: fit1.model });
  assert.equal(sc.backend, 'learned');
  assert.ok(sc.scores[0] > sc.scores[1], 'fitted model scores clean above empty');
  // missing one side => refuses, returns default
  const bad = fitQualityModel({ posRows: [CLEAN], negRows: [] });
  assert.equal(bad.ok, false);
});

test('quality-classifier: applyThreshold percentile + absolute', () => {
  const pct = applyThreshold([0.9, 0.8, 0.7, 0.1, 0.05], { mode: 'percentile', keep_fraction: 0.6 });
  assert.equal(pct.mode, 'percentile');
  assert.deepEqual(pct.kept_indices, [0, 1, 2]);
  const abs = applyThreshold([0.9, 0.3, 0.1], { mode: 'absolute', minQuality: 0.35 });
  assert.equal(abs.mode, 'absolute');
  assert.deepEqual(abs.kept_indices, [0]);
  // empty
  assert.deepEqual(applyThreshold([], {}).kept_indices, []);
});

test('quality-classifier: percentile recalls injected bad rows', () => {
  // 10 good + 5 bad; keep top 67% (10) should drop most of the 5 bad
  const good = Array.from({ length: 10 }, (_, i) => ({ input: 'q' + i, output: 'A clear and complete helpful answer number ' + i + ' with useful steps and detail to follow.' }));
  const bad = [COT, REFUSAL, EMPTY, { input: 'x', output: 'no' }, { input: 'y', output: '<think>reasoning</think>' }];
  const rows = good.concat(bad);
  const sc = scoreQuality({ rows });
  const thr = applyThreshold(sc.scores, { mode: 'percentile', keep_fraction: 0.67 });
  const droppedBad = thr.dropped_indices.filter((i) => i >= 10).length;
  assert.ok(droppedBad >= 4, `percentile drops most injected-bad rows (dropped ${droppedBad}/5)`);
});

test('quality-classifier: doctor envelope', () => {
  const d = qcDoctor();
  assert.equal(d.ok, true);
  assert.equal(d.ready, true);
  assert.ok(typeof d.install_hint === 'string');
});

// =============================================================================
// data-curate integration: opt-in stages are ADDITIVE + back-compat
// =============================================================================

let curatePairs;
test('curate-integration: import data-curate (links cleanly)', async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-curate-'));
  process.env.KOLM_DATA_DIR = TMP;
  ({ curatePairs } = await import('../src/data-curate.js'));
  assert.equal(typeof curatePairs, 'function');
});

function buildCurateCorpus() {
  const topics = ['refund billing invoice payment money', 'password login account access reset', 'install setup download requirements desktop'];
  const rows = [];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 8; k++) {
    rows.push({ input: topics[c] + ' question ' + k, output: 'A clear complete answer about ' + topics[c] + ' with helpful detail for variant ' + k + '.' });
  }
  return rows;
}

test('curate-integration: default opts use learned percentile quality and stamp rows', async () => {
  const r = await curatePairs({
    namespace: 'bc',
    pairs: buildCurateCorpus(),
    opts: { dedup: false, minhash: false, semdedup: false, cluster: false, cot: false, pii: false },
  });
  assert.equal(r.ok, true);
  assert.ok(r.report.quality && typeof r.report.quality === 'object');
  assert.match(r.report.quality.backend, /learned/);
  assert.equal(r.report.quality.mode, 'percentile');
  assert.equal(r.report.quality.kept, r.n_kept);
  assert.ok(r.report.quality.dropped > 0, 'default percentile quality should drop the bottom tail');
  const keptRows = fs.readFileSync(r.out_path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(keptRows.every((row) => typeof row.quality_score === 'number'), 'default classifier stamps quality_score');
  assert.equal(r.report.topics, null);
  assert.equal(r.report.label_errors, null);
});

test('curate-integration: qualityClassifier false preserves legacy heuristic quality', async () => {
  const r = await curatePairs({
    namespace: 'bc_legacy',
    pairs: buildCurateCorpus(),
    opts: { dedup: false, minhash: false, semdedup: false, cluster: false, cot: false, pii: false, qualityClassifier: false },
  });
  assert.equal(r.ok, true);
  assert.equal(r.report.quality, null);
  const keptRows = fs.readFileSync(r.out_path, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(keptRows.every((row) => !Object.hasOwn(row, 'quality_score')), 'legacy heuristic path does not stamp quality_score');
});

test('curate-integration: explicit qualityClassifier true surfaces report.quality + quality_score', async () => {
  const r = await curatePairs({ namespace: 'qc', pairs: buildCurateCorpus(), opts: { dedup: false, qualityClassifier: true, quality_mode: 'percentile', keep_fraction: 0.9 } });
  assert.equal(r.ok, true);
  assert.ok(r.report.quality && typeof r.report.quality === 'object');
  assert.match(r.report.quality.backend, /learned/);
  assert.equal(r.report.quality.mode, 'percentile');
  assert.ok(typeof r.report.quality.threshold_used === 'number');
});

test('curate-integration: semanticCluster opt-in surfaces named report.topics', async () => {
  const r = await curatePairs({ namespace: 'sc', pairs: buildCurateCorpus(), opts: { dedup: false, semanticCluster: true, n_clusters: 3 } });
  assert.equal(r.ok, true);
  assert.match(r.report.cluster_method, /^kmeans:/);
  assert.equal(r.report.k_selected, 3);
  assert.ok(Array.isArray(r.report.topics) && r.report.topics.length === 3);
  for (const t of r.report.topics) assert.match(t.cluster_id, /^[a-z0-9_]+$/);
});

test('curate-integration: detectErrors review flags + routes, drops zero', async () => {
  const topics = ['refund billing invoice payment money charge bank', 'password login account access reset security token', 'install setup download requirements desktop application binary'];
  const rows = [];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 10; k++) rows.push({ input: topics[c] + ' q ' + k, output: topics[c] + ' detailed answer ' + k, cluster_id: 'c' + c });
  rows[4].output = topics[1] + ' detailed answer foreign';
  rows[22].output = topics[0] + ' detailed answer foreign';
  const before = rows.length;
  // semdedup:false isolates the detectErrors stage - these synthetic rows are
  // near-identical templates the now-default-on SemDeDup stage would collapse,
  // confounding the exact n_kept assertion for the stage under test.
  const r = await curatePairs({ namespace: 'de', pairs: rows, opts: { quality: false, dedup: false, semdedup: false, cluster: false, cot: false, pii: false, detectErrors: true, errorAction: 'review' } });
  assert.equal(r.ok, true);
  assert.ok(r.report.label_errors.flagged >= 2);
  assert.equal(r.n_kept, before, 'review action drops zero pairs');
  assert.ok(r.report.label_errors.routed_to_review >= 1, 'flagged pairs routed to the review queue (F6.7)');
});

test('curate-integration: detectErrors filter drops the flagged set', async () => {
  const topics = ['refund billing invoice payment money charge bank', 'password login account access reset security token', 'install setup download requirements desktop application binary'];
  const rows = [];
  for (let c = 0; c < 3; c++) for (let k = 0; k < 10; k++) rows.push({ input: topics[c] + ' q ' + k, output: topics[c] + ' detailed answer ' + k, cluster_id: 'c' + c });
  rows[4].output = topics[1] + ' detailed answer foreign';
  rows[22].output = topics[0] + ' detailed answer foreign';
  // semdedup:false isolates detectErrors (see the review test above).
  const r = await curatePairs({ namespace: 'df', pairs: rows, opts: { quality: false, dedup: false, semdedup: false, cluster: false, cot: false, pii: false, detectErrors: true, errorAction: 'filter' } });
  assert.equal(r.ok, true);
  const flagged = r.report.label_errors.flagged;
  assert.ok(flagged >= 2);
  assert.equal(r.report.label_errors.filtered, flagged);
  assert.equal(r.n_kept, 30 - flagged);
});

test('curate-integration: diversitySelect routes the SELECT stage through the new algos', async () => {
  const r = await curatePairs({ namespace: 'ds', pairs: buildCurateCorpus(), opts: { dedup: false, target_size: 6, diversitySelect: true, select_method: 'facility-location' } });
  assert.equal(r.ok, true);
  assert.ok(r.report.selection);
  assert.match(r.report.selection.strategy, /^diversity-/);
  assert.equal(r.report.selection.version, 'divsel-v1');
  assert.equal(r.n_kept, 6);
});
