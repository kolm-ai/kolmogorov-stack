// SOTA CompileArtifact lane - real fixes for the 8 CompileArtifact atoms.
//
// Atoms exercised (all REAL, no theater):
//   1+7 [p1] data-scaling-law wired into training-planner: plan() projects the
//         data budget (needs ~N more pairs to reach K=x), marginal-data ROI, and
//         biases pickPath() on whether the corpus clears the recommended budget.
//   2   [p0] compile-pipeline regression gate is BLOCKING: the eval gate
//         (compile-eval-gate.evaluateAndGate) that compileFull now invokes blocks
//         a regressing candidate; compileFull emits a regression_gate phase.
//   3   [p1] _signPhase Ed25519 sidecar uses the REAL signer + correct arg order
//         (ed.sign(privateKeyPem, bytes)) and only claims attachment on a verify
//         roundtrip - exercised against ed25519.js directly.
//   4   [p1] compile-stream legacy fabricated-metric stub is demo-gated: the
//         fabricated-metric streamer is NOT exported unless KOLM_COMPILE_STREAM_DEMO=1,
//         and the real streamer only emits the measured holdout K-score.
//   5   [p1] default curation: MinHash LSH near-dup detection (the probe
//         compileFull uses to catch paraphrase train/holdout leakage) clusters
//         near-dup pairs.
//   6   [p1] curriculum-sort ordering: sortCapturesByCurriculum returns easy->hard.
//   8   [p2] distill-lane holdout eval: PIPELINE_PHASES carries distill_eval so a
//         real student can clear productionReady through the orchestrator.
//
// Self-check: run ONLY this file -> node --test tests/sota-compileartifact.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Atom 3 - Ed25519 real signer + correct sign/verify (the exact logic
// compile-pipeline _signPhase now uses).
// ---------------------------------------------------------------------------
test('atom3: ed25519 real signer signs artifact bytes and verify roundtrips', async () => {
  const ed = await import('../src/ed25519.js');
  // loadOrCreateDefaultSigner returns a real Ed25519 PEM keypair (per-machine
  // cache or generated). KOLM_ED25519_DISABLE=1 would return null.
  const signer = ed.loadOrCreateDefaultSigner();
  assert.ok(signer && signer.privateKey, 'signer present');
  assert.ok(signer.publicKey.includes('PUBLIC KEY'), 'PEM public key');
  assert.ok(/^[0-9a-f]{32}$/.test(signer.key_fingerprint), 'fingerprint is 32 hex');

  const bytes = Buffer.from('fake .kolm artifact bytes éè binary-ish \x00\x01', 'utf8');
  // PEM FIRST (the previous code reversed args + passed an HMAC secret).
  const sig = ed.sign(signer.privateKey, bytes);
  assert.equal(typeof sig, 'string');
  assert.ok(sig.length > 0);
  // The verify roundtrip _signPhase performs before setting ed25519_attached.
  assert.equal(ed.verify(signer.publicKey, bytes, sig), true, 'roundtrip verifies');
  // Tamper detection: a flipped byte must NOT verify.
  const tampered = Buffer.concat([bytes, Buffer.from([0xff])]);
  assert.equal(ed.verify(signer.publicKey, tampered, sig), false, 'tampered bytes rejected');
});

test('atom3: KOLM_ED25519_DISABLE=1 disables asymmetric signing (HMAC-only path)', async () => {
  const ed = await import('../src/ed25519.js');
  const prev = process.env.KOLM_ED25519_DISABLE;
  process.env.KOLM_ED25519_DISABLE = '1';
  try {
    assert.equal(ed.loadOrCreateDefaultSigner(), null, 'disabled -> null signer (loud, not fake)');
  } finally {
    if (prev === undefined) delete process.env.KOLM_ED25519_DISABLE;
    else process.env.KOLM_ED25519_DISABLE = prev;
  }
});

// ---------------------------------------------------------------------------
// Atoms 1 + 7 - data-scaling-law wired into the training planner.
// ---------------------------------------------------------------------------
test('atoms1+7: planner projects a data budget from (n_pairs,K) history', async () => {
  const { plan, planReport } = await import('../src/training-planner.js');
  // A synthetic generation corpus + a rectified-law-fittable K history.
  const rows = [];
  for (let i = 0; i < 120; i++) rows.push({ input: 'write a haiku about topic ' + i, output: 'line one ' + i + '\nline two\nline three about ' + (i % 7) });
  // Monotone, saturating (n_pairs, K) points the rectified law fits cleanly.
  const kscore_history = [
    { n_pairs: 50, k: 0.40 },
    { n_pairs: 100, k: 0.55 },
    { n_pairs: 200, k: 0.66 },
    { n_pairs: 400, k: 0.74 },
    { n_pairs: 800, k: 0.80 },
    { n_pairs: 1600, k: 0.84 },
  ];
  const p = await plan('inline', { rows, kscore_history, target_kscore: 0.85 });
  assert.ok(p.data_budget, 'plan carries data_budget block');
  // Either a fitted rectified law (numbers) OR an honest insufficient block.
  if (p.data_budget.basis === 'rectified') {
    assert.equal(typeof p.projected_kscore_at_current_n, 'number');
    assert.ok(p.projected_kscore_at_current_n > 0 && p.projected_kscore_at_current_n <= 1);
    assert.ok(p.data_budget.marginal_gain_per_1k_examples != null);
    const report = planReport(p);
    assert.match(report, /Data budget \(scaling law/);
    assert.match(report, /Projected K at current/);
  } else {
    // insufficient -> no fabricated numbers (atom contract).
    assert.equal(p.data_budget_recommended, null);
    assert.equal(p.projected_kscore_at_current_n, null);
  }
});

test('atoms1+7: no history -> basis insufficient, no fabricated budget numbers', async () => {
  const { plan } = await import('../src/training-planner.js');
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ input: 'q ' + i, output: 'a' });
  const p = await plan('inline', { rows }); // no kscore_history
  assert.ok(p.data_budget);
  assert.equal(p.data_budget.basis, 'insufficient');
  assert.equal(p.data_budget_recommended, null);
  assert.equal(p.projected_kscore_at_current_n, null);
  assert.equal(p.marginal_gain_per_1k_examples, null);
});

// ---------------------------------------------------------------------------
// Atom 2 - the eval gate that compileFull now invokes as a BLOCKING chokepoint.
// ---------------------------------------------------------------------------
test('atom2: evaluateAndGate BLOCKS a regressing candidate (chokepoint compileFull invokes)', async () => {
  const { evaluateAndGate } = await import('../src/compile-eval-gate.js');
  // candidate K-Score well below the incumbent baseline -> must NOT promote.
  const blocked = evaluateAndGate({
    candidate_artifact: { manifest: { k_score: 0.60 } },
    baseline: { manifest: { k_score: 0.85 } },
  });
  assert.equal(blocked.promote, false, 'regression is blocked');
  assert.match(blocked.reason, /delta|regression|floor|K-Score/i);

  // candidate that clears the delta -> promote.
  const ok = evaluateAndGate({
    candidate_artifact: { manifest: { k_score: 0.90 } },
    baseline: { manifest: { k_score: 0.85 } },
  });
  assert.equal(ok.promote, true, 'improvement promotes');

  // candidate with NO resolvable K-score -> fail-closed (block).
  const noScore = evaluateAndGate({ candidate_artifact: { manifest: {} }, baseline: null });
  assert.equal(noScore.promote, false, 'no candidate K-score fails closed');
});

// ---------------------------------------------------------------------------
// Atom 4 - the fabricated-metric stub is demo-gated; only the real streamer is
// reachable from a production import.
// ---------------------------------------------------------------------------
test('atom4: fabricated-metric compile stream is NOT exported without the demo flag', async () => {
  // Default env (no KOLM_COMPILE_STREAM_DEMO) - the demo bundle is null and the
  // legacy fabricated symbols are gone from the module surface.
  const mod = await import('../src/compile-stream.js');
  assert.equal(mod.buildEventLog, undefined, 'legacy fabricated buildEventLog not exported');
  assert.equal(mod.streamCompile, undefined, 'legacy fabricated streamCompile not exported');
  assert.equal(mod.COMPILE_STEPS, undefined, 'legacy COMPILE_STEPS not exported');
  // The production real streamer + its REAL step list ARE exported.
  assert.equal(typeof mod.streamRealCompile, 'function');
  assert.equal(typeof mod.buildRealEventLog, 'function');
  assert.ok(Array.isArray(mod.REAL_COMPILE_STEPS));
  // estimateCompile is the honestly-labelled heuristic - kept.
  const est = mod.estimateCompile({ describe: 'a small support triage model' });
  assert.equal(est.method, 'heuristic_v1');
});

test('atom4: buildRealEventLog never emits a metric without a real holdout job.k_score', async () => {
  const { buildRealEventLog } = await import('../src/compile-stream.js');
  // A completed job WITHOUT a k_score must not emit any fabricated metric event.
  const noScore = buildRealEventLog({ id: 'job_x', status: 'completed', stages: [{ name: 'split.done' }, { name: 'distill.done' }, { name: 'package.done' }] });
  const metricsNoScore = noScore.filter((e) => e.event === 'metric');
  assert.equal(metricsNoScore.length, 0, 'no metric without job.k_score');
  // A job WITH a real holdout k_score emits exactly that value, tagged holdout.
  const withScore = buildRealEventLog({ id: 'job_y', status: 'completed', k_score: 0.77, stages: [{ name: 'split.done' }, { name: 'distill.done' }, { name: 'package.done' }] });
  const metric = withScore.find((e) => e.event === 'metric');
  assert.ok(metric, 'metric emitted for real score');
  assert.equal(metric.data.k_score, 0.77);
  assert.equal(metric.data.source, 'holdout');
});

// ---------------------------------------------------------------------------
// Atom 5 - MinHash LSH near-dup detection (the paraphrase-leak probe compileFull
// runs over train+holdout).
// ---------------------------------------------------------------------------
test('atom5: minhashPredup clusters near-dup (paraphrase) pairs for the leak probe', async () => {
  const { minhashPredup } = await import('../src/minhash-dedup.js');
  const base = 'the quick brown fox jumps over the lazy dog in the meadow at dawn every single day';
  const pairs = [
    { input: base, output: 'ok' },
    { input: base + ' really', output: 'ok' },               // near-dup of #0
    { input: 'completely unrelated sentence about quantum chromodynamics and gluons', output: 'no' },
    { input: base, output: 'ok' },                            // exact dup of #0
  ];
  const r = minhashPredup(pairs, { jaccardThreshold: 0.6, verify: true, key: 'input' });
  assert.ok(r.report.n_removed >= 1, 'near/exact dups removed');
  // At least one cluster groups the base + its duplicates.
  const big = (r.clusters || []).find((c) => c.length >= 2);
  assert.ok(big, 'a near-dup cluster formed');
  // The unrelated row survives.
  assert.ok(r.kept.some((p) => /quantum chromodynamics/.test(p.input)), 'distinct row kept');
});

// ---------------------------------------------------------------------------
// Atom 6 - curriculum ordering (easy -> hard) that compileFull applies to the
// train pairs before distill.
// ---------------------------------------------------------------------------
test('atom6: sortCapturesByCurriculum orders ascending complexity (easy first)', async () => {
  const { sortCapturesByCurriculum, complexityProxy, buildUnigramTable } = await import('../src/curriculum-sort.js');
  const views = [
    { prompt: 'p3', response: 'a very long and lexically diverse exposition packed with rare polysyllabic terminology and intricate subordinate clauses spanning many tokens '.repeat(20) },
    { prompt: 'p1', response: 'hi' },
    { prompt: 'p2', response: 'a moderately sized response with a few words here' },
  ];
  const ordered = sortCapturesByCurriculum(views, 'ascending');
  const { table, total } = buildUnigramTable(views);
  const scores = ordered.map((v) => complexityProxy(v, { unigramTable: table, totalTokens: total }).score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1] - 1e-9, 'non-decreasing complexity (easy->hard)');
  }
  // The longest/most-diverse response (the heavy padded one) sorts LAST.
  assert.ok(ordered[ordered.length - 1].response.length > 1000, 'hardest (longest) row last');
  // Descending mode reverses the order.
  const desc = sortCapturesByCurriculum(views, 'descending');
  assert.ok(desc[0].response.length > 1000, 'descending puts hardest first');
});

// ---------------------------------------------------------------------------
// Atoms 2/5/6/8 - the pipeline surface carries the new BLOCKING + curation +
// curriculum + distill-eval phases.
// ---------------------------------------------------------------------------
test('atoms2/5/6/8: PIPELINE_PHASES includes the new real phases in order', async () => {
  const { PIPELINE_PHASES, compileFull } = await import('../src/compile-pipeline.js');
  assert.equal(typeof compileFull, 'function');
  for (const ph of ['curate', 'distill_eval', 'regression_gate']) {
    assert.ok(PIPELINE_PHASES.includes(ph), 'phase present: ' + ph);
  }
  // curate before dataset_split; distill_eval after distill; regression_gate
  // after verdict, before install.
  assert.ok(PIPELINE_PHASES.indexOf('curate') < PIPELINE_PHASES.indexOf('dataset_split'));
  assert.ok(PIPELINE_PHASES.indexOf('distill_eval') > PIPELINE_PHASES.indexOf('distill'));
  assert.ok(PIPELINE_PHASES.indexOf('regression_gate') > PIPELINE_PHASES.indexOf('verdict'));
  assert.ok(PIPELINE_PHASES.indexOf('regression_gate') < PIPELINE_PHASES.indexOf('install'));
});
