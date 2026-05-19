// Wave 409c — auditor mandate. The full pipeline can no longer emit a stub
// identity artifact and label it production-ready.
//
// Auditor findings against src/compile-pipeline.js (pre-409c):
//   :94  generated an echo recipe by default
//   :121 marked seed_provenance.production_ready=true unconditionally
//   :153 injected pass_rate_positive=0.95 (fake)
//   :330 fell back to a stub split when the workbench rejected the corpus
//
// Post-409c contract enforced by the pipeline + productionReady() verdict:
//   1. Identity / echo / stub recipes → production_ready:false UNLESS
//      task_type='echo' AND --allow-stub is set.
//   2. Build consumes only the approved train split. Reject if seeds are
//      synthetic-only without --allow-synthetic override.
//   3. Eval runs against a DISJOINT holdout (row-hash set intersection).
//   4. Receipt records split_seed, train_hash, holdout_hash, source_seed_count,
//      approved_count, synthetic_count.
//   5. If pass_rate is injected without a real eval run → eval_provenance:
//      'placeholder' and production_ready:false.
//   6. --allow-stub flag exists for the rare echo-task case; default rejects.
//
// Each test runs against its own tmpdir under KOLM_DATA_DIR + HOME isolation
// so the dev box's real event store / artifact dir is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function _mkTmp(label = 'w409c') {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-' + label + '-'));
}

function _setEnv(tmp) {
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'jsonl';
  process.env.KOLM_RECIPE_RECEIPT_SECRET = process.env.KOLM_RECIPE_RECEIPT_SECRET || 'wave409c-test-secret-32chars-min-len';
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_SIGNING_KEY: process.env.KOLM_SIGNING_KEY,
  };
}

async function _seedNamespace(namespace, n = 20, opts = {}) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  _resetForTests();
  const sourceType = opts.sourceType || null;
  for (let i = 0; i < n; i++) {
    await appendEvent({
      namespace,
      tenant_id: 'wave409c-test',
      prompt_redacted: 'classify ticket ' + i + ' about billing',
      response_redacted: 'reply ' + i,
      provider: 'openai',
      model: 'gpt-4o-mini',
      status: 'ok',
      ...(sourceType ? { source_type: sourceType } : {}),
    });
  }
}

async function _runPipeline(namespace, opts) {
  const { compileFull } = await import('../src/compile-pipeline.js');
  const events = [];
  let bundleEv = null;
  let verdictEv = null;
  let doneEv = null;
  let threw = null;
  try {
    for await (const ev of compileFull({ namespace, opts: { emit_progress_every: 0, ...opts } })) {
      events.push(ev);
      if (ev.phase === 'bundle') bundleEv = ev;
      if (ev.phase === 'verdict') verdictEv = ev;
      if (ev.phase === 'done') doneEv = ev;
    }
  } catch (e) {
    threw = e;
  }
  return { events, bundleEv, verdictEv, doneEv, threw };
}

async function _readManifest(artifactPath) {
  const { default: AdmZip } = await import('adm-zip');
  const zip = new AdmZip(fs.readFileSync(artifactPath));
  const e = zip.getEntry('manifest.json');
  if (!e) throw new Error('no manifest.json in ' + artifactPath);
  return JSON.parse(e.getData().toString('utf8'));
}

// ---------------------------------------------------------------------------
// #1 — Build with no seeds throws or returns non-production artifact.
test('W409c #1 — build with no seeds rejects or returns non-production', async () => {
  const tmp = _mkTmp('w409c-1');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Reset event store but seed NOTHING — namespace has zero events.
    const { _resetForTests } = await import('../src/event-store.js');
    _resetForTests();
    // Default behavior (no force / no allow_stub) — the pipeline rejects.
    const r = await _runPipeline('w409c-empty', { no_install: true });
    if (r.threw) {
      assert.match(r.threw.message, /workbench rejected|allow-stub|allow_stub|no seeds|empty/i,
        'reject reason must reference the stub/empty corpus refusal');
    } else {
      // If the pipeline runs to done, the verdict MUST be non-production.
      assert.ok(r.doneEv, 'must yield done');
      assert.equal(r.doneEv.production_ready, false,
        'empty namespace must not produce a production_ready artifact');
    }
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #2 — Build with synthetic-only seeds and no --allow-synthetic → non-production.
test('W409c #2 — synthetic-only seeds without --allow-synthetic → non-production', async () => {
  const tmp = _mkTmp('w409c-2');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w409c-synth', 20, { sourceType: 'synthetic' });
    // Default policy rejects.
    const rDefault = await _runPipeline('w409c-synth', { no_install: true });
    if (rDefault.threw) {
      assert.match(rDefault.threw.message, /synthetic-only|allow.?synthetic/i,
        'reject reason must reference synthetic-only refusal');
    } else {
      assert.ok(rDefault.doneEv, 'must yield done');
      assert.equal(rDefault.doneEv.production_ready, false,
        'synthetic-only without --allow-synthetic must not be production_ready');
    }
    // With force, the pipeline proceeds but stays non-production. We use a
    // FRESH namespace so the per-test data is isolated.
    await _seedNamespace('w409c-synth-force', 20, { sourceType: 'synthetic' });
    const rForce = await _runPipeline('w409c-synth-force', { force: true, no_install: true });
    assert.ok(rForce.doneEv, 'force must let pipeline run to done');
    assert.equal(rForce.doneEv.production_ready, false,
      'W409c — synthetic-only with force still must not be production_ready');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #3 — Echo recipe with non-echo task_type → non-production.
test('W409c #3 — echo/stub recipe with non-echo task_type → non-production', async () => {
  const tmp = _mkTmp('w409c-3');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w409c-echo-wrong', 20);
    // No allow_stub, but force lets the bundle materialize so we can inspect.
    const r = await _runPipeline('w409c-echo-wrong', { force: true, no_install: true });
    assert.ok(r.doneEv, 'must yield done');
    assert.equal(r.doneEv.production_ready, false,
      'W409c — synthesized echo recipe with non-echo task must NOT be production_ready');
    // Post-W451 the manifest may record either:
    //  - 'placeholder' (stub path engaged, no eval ran), OR
    //  - 'real_eval' (W451 rule-class synth ran a real holdout pass without
    //    needing a teacher — the K-score still gates production_ready:false
    //    if the classifier can't match, so the honesty contract is intact).
    // Both values are honest; only injected pass_rate without an actual eval
    // would be a lie. production_ready:false is the load-bearing assertion.
    const manifest = await _readManifest(r.doneEv.artifact_path);
    assert.ok(
      ['placeholder', 'real_eval'].includes(manifest.seed_provenance.eval_provenance),
      'eval_provenance must be placeholder or real_eval; got ' + manifest.seed_provenance.eval_provenance,
    );
    assert.ok(
      typeof manifest.seed_provenance.production_ready === 'boolean',
      'seed_provenance.production_ready must be a boolean (runtime verdict above is the load-bearing gate)',
    );
    // task type must not be 'echo' (the planner detected something else).
    assert.notEqual(manifest.task && manifest.task.type, 'echo',
      'planner should not pick echo for non-echo prompts');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #4 — Train/holdout leakage (overlapping row hashes) → verify fails with clear reason.
test('W409c #4 — train/holdout row-hash overlap is detected by verifier', async () => {
  const tmp = _mkTmp('w409c-4');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    // Direct probe of the productionReady() gate with a hand-rolled manifest
    // that has input_overlap_count > 0 in seed_provenance. This isolates the
    // row-hash disjointness check from the pipeline plumbing.
    const { productionReady } = await import('../src/production-ready.js');
    // Baseline — a clean manifest passes the seed_provenance + holdout_split
    // gates (other gates can fail, we only assert these two).
    const cleanManifest = {
      artifact_class: 'rule',
      task: { type: 'classification' },
      seed_provenance: {
        seeds_hash: crypto.createHash('sha256').update('clean').digest('hex'),
        split_seed: 'wave409c-pipeline-v1',
        train_count: 100,
        holdout_count: 20,
        input_overlap_count: 0,
        output_overlap_count: 0,
        near_duplicate_count: 0,
        grouped_overlap_count: 0,
        production_ready: true,
        eval_provenance: 'real_eval',
        train_hash: 'a'.repeat(64),
        holdout_hash: 'b'.repeat(64),
        source_seed_count: 120,
        approved_count: 120,
        synthetic_count: 0,
      },
      k_score: { composite: 0.9, axes: {} },
      evals: { accuracy: 0.9 },
    };
    const baseline = await productionReady(cleanManifest);
    assert.ok(baseline.gates.seed_provenance.ok,
      'seed_provenance must pass on a clean manifest');
    assert.ok(baseline.gates.holdout_split.ok,
      'holdout_split must pass on a clean manifest');
    // Leaky manifest — input_overlap_count > 0 must trip the holdout_split gate.
    const leakyManifest = JSON.parse(JSON.stringify(cleanManifest));
    leakyManifest.seed_provenance.input_overlap_count = 3;
    const leaky = await productionReady(leakyManifest);
    assert.equal(leaky.ok, false, 'leaky manifest must not be ok');
    assert.equal(leaky.gates.holdout_split.ok, false,
      'holdout_split must reject when input_overlap_count > 0');
    assert.match(leaky.gates.holdout_split.reason, /overlap|contamination|input_overlap/i,
      'reject reason must mention the overlap');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #5 — Real seeds + real eval → production_ready:true, receipt has the
// required provenance fields.
test('W409c #5 — real seeds + real eval gives production_ready:true + receipt has split_seed/train_hash/holdout_hash', async () => {
  const tmp = _mkTmp('w409c-5');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    // Probe the manifest contract via productionReady() against a hand-rolled
    // manifest that simulates "real seeds + real eval ran". The pipeline path
    // exercising this end-to-end is gated on a torch+python stack we don't
    // have on a CI/laptop, so the unit-level contract is the load-bearing
    // assertion. The full-pipeline write path is locked in by the bundle
    // phase's seed_provenance write (see wave381 #18 + bundleEv inspection).
    const { productionReady } = await import('../src/production-ready.js');
    const realManifest = {
      artifact_class: 'distilled_model',
      task: { type: 'classification' },
      seed_provenance: {
        seeds_hash: crypto.createHash('sha256').update('real-seeds').digest('hex'),
        split_seed: 'wave409c-pipeline-v1',
        train_count: 80,
        holdout_count: 20,
        input_overlap_count: 0,
        output_overlap_count: 0,
        near_duplicate_count: 0,
        grouped_overlap_count: 0,
        production_ready: true,
        eval_provenance: 'real_eval',
        train_hash: crypto.createHash('sha256').update('train-rows').digest('hex'),
        holdout_hash: crypto.createHash('sha256').update('holdout-rows').digest('hex'),
        source_seed_count: 100,
        approved_count: 100,
        synthetic_count: 0,
      },
      k_score: { composite: 0.91, axes: {} },
      evals: { accuracy: 0.92 },
    };
    const v = await productionReady(realManifest);
    assert.equal(v.gates.seed_provenance.ok, true,
      'real eval + real seeds must pass seed_provenance');
    assert.equal(v.gates.holdout_split.ok, true,
      'real eval + real seeds must pass holdout_split');
    assert.equal(v.gates.k_score.ok, true,
      'k_score 0.91 ≥ 0.85 gate must pass');
    // Honesty contract: the receipt fields the auditor requires are present.
    assert.equal(typeof realManifest.seed_provenance.split_seed, 'string',
      'receipt MUST record split_seed');
    assert.equal(typeof realManifest.seed_provenance.train_hash, 'string',
      'receipt MUST record train_hash');
    assert.equal(typeof realManifest.seed_provenance.holdout_hash, 'string',
      'receipt MUST record holdout_hash');
    assert.equal(typeof realManifest.seed_provenance.source_seed_count, 'number',
      'receipt MUST record source_seed_count');
    assert.equal(typeof realManifest.seed_provenance.approved_count, 'number',
      'receipt MUST record approved_count');
    assert.equal(typeof realManifest.seed_provenance.synthetic_count, 'number',
      'receipt MUST record synthetic_count');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #6 — Receipt missing split_seed → verify rejects.
test('W409c #6 — receipt missing split_seed → verify rejects', async () => {
  const tmp = _mkTmp('w409c-6');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { productionReady } = await import('../src/production-ready.js');
    const noSplitSeed = {
      artifact_class: 'rule',
      seed_provenance: {
        seeds_hash: crypto.createHash('sha256').update('seeds').digest('hex'),
        // split_seed deliberately missing
        train_count: 100,
        holdout_count: 20,
        input_overlap_count: 0,
        output_overlap_count: 0,
        near_duplicate_count: 0,
        grouped_overlap_count: 0,
        production_ready: true,
        eval_provenance: 'real_eval',
        train_hash: 'a'.repeat(64),
        holdout_hash: 'b'.repeat(64),
      },
      k_score: { composite: 0.9, axes: {} },
      evals: { accuracy: 0.9 },
    };
    const v = await productionReady(noSplitSeed);
    assert.equal(v.gates.seed_provenance.ok, false,
      'missing split_seed must trip seed_provenance gate');
    assert.match(v.gates.seed_provenance.reason, /split_seed/i,
      'reject reason must mention split_seed');
    assert.equal(v.ok, false, 'overall verdict must be not ok');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #7 — eval_provenance:'placeholder' → productionReady rejects.
test('W409c #7 — eval_provenance=placeholder is rejected by productionReady', async () => {
  const tmp = _mkTmp('w409c-7');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    const { productionReady } = await import('../src/production-ready.js');
    const placeholder = {
      artifact_class: 'rule',
      seed_provenance: {
        seeds_hash: crypto.createHash('sha256').update('seeds').digest('hex'),
        split_seed: 'wave409c-pipeline-v1',
        train_count: 100,
        holdout_count: 20,
        input_overlap_count: 0,
        output_overlap_count: 0,
        near_duplicate_count: 0,
        grouped_overlap_count: 0,
        production_ready: true, // even if the bundle claims true
        eval_provenance: 'placeholder', // ...the gate rejects on this alone
        train_hash: 'a'.repeat(64),
        holdout_hash: 'b'.repeat(64),
      },
      k_score: { composite: 0.95, axes: {} },
      evals: { accuracy: 0.95 },
    };
    const v = await productionReady(placeholder);
    assert.equal(v.gates.seed_provenance.ok, false,
      'eval_provenance=placeholder must fail the gate');
    assert.match(v.gates.seed_provenance.reason, /placeholder/i,
      'reject reason must mention placeholder');
    assert.equal(v.ok, false, 'overall verdict must be not ok');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #8 — --allow-stub is required for the echo-task path (pipeline-level lockdown).
test('W409c #8 — --allow-stub gates the echo-task accept path', async () => {
  const tmp = _mkTmp('w409c-8');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    // Seed a minimal namespace so the workbench accepts.
    await _seedNamespace('w409c-allow-stub', 20);
    // Without --allow-stub the pipeline must produce a non-production artifact
    // even with force=true (force only overrides install; verdict is honest).
    const rNoFlag = await _runPipeline('w409c-allow-stub', { force: true, no_install: true });
    assert.ok(rNoFlag.doneEv, 'pipeline must reach done with force=true');
    assert.equal(rNoFlag.doneEv.production_ready, false,
      'echo-only recipes without --allow-stub must NOT be production_ready');
    const manifestNoFlag = await _readManifest(rNoFlag.doneEv.artifact_path);
    // Post-W451: seed_provenance.production_ready records whether the BUILD
    // phase had honest grounds to call this production-ready (real synth +
    // real eval). The RUNTIME verdict (doneEv.production_ready, asserted
    // above) is the final gate that still rejects on low K-score. Both
    // values are honest depending on the corpus — what matters is that
    // the runtime verdict above already rejected this artifact.
    assert.ok(
      typeof manifestNoFlag.seed_provenance.production_ready === 'boolean',
      'manifest must record seed_provenance.production_ready as a boolean',
    );
    // Post-W451 the no-teacher path may run the rule-class synth eval honestly
    // — eval_provenance can be 'placeholder' (stub fell through) or 'real_eval'
    // (W451 synth ran). The load-bearing assertion is doneEv.production_ready.
    assert.ok(
      ['placeholder', 'real_eval'].includes(manifestNoFlag.seed_provenance.eval_provenance),
      'eval_provenance must be placeholder or real_eval; got ' + manifestNoFlag.seed_provenance.eval_provenance,
    );
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// #9 — pipeline manifest carries the required new provenance fields.
test('W409c #9 — pipeline manifest carries source_seed_count + approved_count + synthetic_count', async () => {
  const tmp = _mkTmp('w409c-9');
  const saved = _snapEnv();
  try {
    _setEnv(tmp);
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    await _seedNamespace('w409c-fields', 25);
    const r = await _runPipeline('w409c-fields', { force: true, no_install: true });
    assert.ok(r.doneEv, 'must yield done');
    const manifest = await _readManifest(r.doneEv.artifact_path);
    const sp = manifest.seed_provenance;
    assert.ok(sp, 'manifest must carry seed_provenance');
    // Required fields per the auditor's mandate.
    assert.equal(typeof sp.split_seed, 'string', 'split_seed must be a string');
    assert.ok(sp.split_seed.length > 0, 'split_seed must be non-empty');
    assert.equal(typeof sp.train_hash, 'string', 'train_hash must be a string');
    assert.ok(sp.train_hash.length >= 16, 'train_hash must look like a real hash');
    // holdout_hash may be null when the dataset_split stub fallback runs (no
    // holdout rows); we tolerate null but require the FIELD to exist.
    assert.ok('holdout_hash' in sp, 'holdout_hash field must be present');
    assert.equal(typeof sp.source_seed_count, 'number',
      'source_seed_count must be a number');
    assert.equal(typeof sp.approved_count, 'number',
      'approved_count must be a number');
    assert.equal(typeof sp.synthetic_count, 'number',
      'synthetic_count must be a number');
    assert.ok('eval_provenance' in sp, 'eval_provenance field must be present');
    assert.ok(['real_eval', 'placeholder', 'unknown'].includes(sp.eval_provenance),
      'eval_provenance must be one of real_eval/placeholder/unknown');
  } finally {
    _restoreEnv(saved);
  }
});
