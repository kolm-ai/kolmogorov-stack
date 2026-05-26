// Wave 438 — real production compile (rule-class lane).
//
// The post-W436 audit's P0 #5 finding: "DoD compile/verify is still a stub-path
// proof — wave417-definition-of-done.test.js runs compileFull() with
// `allow_stub:true`, which produces an identity-echo stub recipe + placeholder
// eval_provenance. Shipping production_ready:true from that combination would
// be a fake claim." W438 closes the gap by wiring src/synthesis.js (pattern
// strategy → real JS classifier) + src/verifier.js (vm-sandboxed holdout eval)
// into compile-pipeline.js as phase 6.5 ("recipe_synthesis"), opt-in via
// opts.synthesize_recipe:true.
//
// Contracts this test pins:
//
//   1. opts.synthesize_recipe:true triggers a 'recipe_synthesis' phase event
//      with {accepted, source_bytes, holdout_pass_rate, holdout_n}.
//
//   2. The bundle phase reports eval_provenance:'real_eval' (not 'placeholder')
//      and seed_production_ready:true when train>=20 + holdout>=5 + content is
//      discriminative enough to compile a non-empty rule.
//
//   3. The artifact materializes even when K-score is below the 0.85 ship gate
//      (small-holdout burstiness is expected on synth's pattern strategy; the
//      downstream productionReady() verdict is the load-bearing reject path,
//      NOT a buildPayload throw).
//
//   4. The artifact's recipe.bundle.mjs carries real classifier source bytes,
//      not the identity-echo stub.
//
//   5. No prod-code changes are needed in src/router.js — this is a pipeline
//      opts flag, not a new HTTP surface.
//
// What this test does NOT cover:
//   - Distill-class real compile (KD-softmax with a real teacher). That lane
//     requires KOLM_DISTILL_TEACHER / ANTHROPIC_API_KEY and is exercised by
//     tests/wave438-rented-distill.test.js (env-gated, skips when unwired).
//   - Native compiled_rule lane (C/Rust binaries). Already shipped via
//     src/spec-compile.js + src/native-compile.js + src/dsl.js (W144).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function _snapEnv() {
  return {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    KOLM_STORE_DRIVER: process.env.KOLM_STORE_DRIVER,
    KOLM_EVENT_STORE_DRIVER: process.env.KOLM_EVENT_STORE_DRIVER,
    KOLM_DISTILL_FULL: process.env.KOLM_DISTILL_FULL,
    KOLM_DISTILL_TEACHER: process.env.KOLM_DISTILL_TEACHER,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    KOLM_RECIPE_RECEIPT_SECRET: process.env.KOLM_RECIPE_RECEIPT_SECRET,
  };
}

function _restoreEnv(saved) {
  for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function _mkIsolatedHome(label) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w438-' + label + '-'));
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_DRIVER = 'jsonl';
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.KOLM_DISTILL_FULL;
  delete process.env.KOLM_DISTILL_TEACHER;
  process.env.KOLM_RECIPE_RECEIPT_SECRET = 'wave438-real-compile-secret-32chars-min';
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

async function _seedClassNamespace({ ns, tenant, classes, perClass }) {
  const { appendEvent, _resetForTests } = await import('../src/event-store.js');
  if (_resetForTests) _resetForTests();
  const { approveEvent } = await import('../src/dataset-workbench.js');
  let i = 0;
  for (const cls of classes) {
    for (let n = 0; n < perClass; n++, i++) {
      const e = await appendEvent({
        event_id: `evt_w438_${ns}_${i}`,
        tenant_id: tenant,
        namespace: ns,
        provider: 'openai',
        model: 'gpt-4',
        prompt_redacted: `wave438 sample ${i} regarding our ${cls} workflow needs attention`,
        response_redacted: cls,
        status: 'ok',
        source_type: 'real',
        created_at: new Date(Date.now() + i).toISOString(),
      });
      await approveEvent(e.event_id, { tenant_id: tenant, reviewer: 'wave438' });
    }
  }
}

async function _runCompile({ ns, tenant }) {
  const { compileFull } = await import('../src/compile-pipeline.js');
  const events = [];
  for await (const ev of compileFull({
    namespace: ns,
    opts: {
      emit_progress_every: 0,
      no_install: true,
      tenant_id: tenant,
      approved_only: true,
      max_steps: 5,
      synthesize_recipe: true,
      output_spec: { type: 'enum' },
    },
  })) {
    events.push(ev);
  }
  return events;
}

// ---------------------------------------------------------------------------
// W438 #1 — synthesize_recipe:true emits a 'recipe_synthesis' phase event.
// ---------------------------------------------------------------------------
test('W438 #1 — opts.synthesize_recipe triggers recipe_synthesis phase event', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('synth-event');
  try {
    const ns = 'w438_1';
    const tenant = 'wave438-1';
    await _seedClassNamespace({ ns, tenant, classes: ['alpha', 'beta', 'gamma', 'delta'], perClass: 10 });
    const events = await _runCompile({ ns, tenant });
    const synth = events.find(e => e.phase === 'recipe_synthesis');
    assert.ok(synth, 'compileFull must emit a recipe_synthesis event when opts.synthesize_recipe:true');
    assert.equal(typeof synth.accepted, 'boolean', 'recipe_synthesis event must carry boolean accepted');
    assert.ok(Number.isFinite(synth.source_bytes) && synth.source_bytes > 0,
      'recipe_synthesis must report source_bytes > 0 (real generator compiled)');
    assert.ok(Number.isFinite(synth.holdout_pass_rate),
      'recipe_synthesis must report a numeric holdout_pass_rate');
    assert.ok(synth.holdout_n >= 1, 'recipe_synthesis must run against a non-empty holdout');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W438 #2 — bundle phase reports eval_provenance='real_eval' on the synth path.
// ---------------------------------------------------------------------------
test('W438 #2 — bundle.eval_provenance=real_eval + seed_production_ready=true', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('eval-prov');
  try {
    const ns = 'w438_2';
    const tenant = 'wave438-2';
    await _seedClassNamespace({ ns, tenant, classes: ['foo', 'bar', 'baz', 'qux'], perClass: 10 });
    const events = await _runCompile({ ns, tenant });
    const bundle = events.find(e => e.phase === 'bundle');
    assert.ok(bundle, 'pipeline must emit a bundle event');
    assert.equal(bundle.eval_provenance, 'real_eval',
      'bundle.eval_provenance must be real_eval on synth path (not placeholder)');
    assert.equal(bundle.seed_production_ready, true,
      `bundle.seed_production_ready must be true; reasons=${JSON.stringify(bundle.seed_reasons || [])}`);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W438 #3 — artifact materializes even when K-score is below the 0.85 gate.
// The synth pattern-strategy classifier is bursty on small holdouts; the
// artifact must still land on disk so the user / verifier can inspect the
// honest production_ready:false verdict instead of getting a thrown error.
// ---------------------------------------------------------------------------
test('W438 #3 — artifact materializes on disk + verdict records honest production_ready', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('materialize');
  try {
    const ns = 'w438_3';
    const tenant = 'wave438-3';
    await _seedClassNamespace({ ns, tenant, classes: ['xx', 'yy', 'zz', 'ww'], perClass: 10 });
    const events = await _runCompile({ ns, tenant });
    const done = events.find(e => e.phase === 'done');
    const verdict = events.find(e => e.phase === 'verdict');
    assert.ok(done, 'pipeline must emit a done event');
    assert.ok(done.artifact_path, 'done event must carry artifact_path');
    assert.ok(fs.existsSync(done.artifact_path),
      'artifact .kolm must exist on disk even when K-score is below the ship gate');
    assert.ok(verdict, 'pipeline must emit a verdict event');
    assert.equal(typeof verdict.production_ready, 'boolean',
      'verdict.production_ready must be a boolean (the honest gate result)');
    assert.ok(verdict.gates, 'verdict must carry a structured gates object');
    assert.ok('k_score' in verdict.gates, 'verdict.gates must include k_score');
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W438 #4 — recipe.bundle.mjs carries real classifier source bytes, not the
// identity-echo stub. Loads the .kolm and asserts the bundled generator file
// contains a discriminator (not just `return input;`).
// ---------------------------------------------------------------------------
test('W438 #4 — bundled recipe carries real generator source (not identity-echo)', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('real-source');
  try {
    const ns = 'w438_4';
    const tenant = 'wave438-4';
    await _seedClassNamespace({ ns, tenant, classes: ['classA', 'classB', 'classC', 'classD'], perClass: 10 });
    const events = await _runCompile({ ns, tenant });
    const done = events.find(e => e.phase === 'done');
    assert.ok(done && done.artifact_path && fs.existsSync(done.artifact_path),
      'must have an artifact to inspect');
    const { loadArtifact } = await import('../src/artifact-runner.js');
    const bundle = loadArtifact(done.artifact_path);
    assert.ok(bundle && bundle.manifest, 'artifact must load with a manifest');
    // recipes is a top-level field (separate recipes.json entry in the zip);
    // its shape is {spec, n, recipes:[{id, name, source, ...}]} per
    // src/artifact.js:476. Must list the wave438 synthesized rule (id-prefix
    // pinned by compile-pipeline.js phase 6.5).
    const recipesObj = bundle.recipes && typeof bundle.recipes === 'object' ? bundle.recipes : {};
    const recipes = Array.isArray(recipesObj.recipes) ? recipesObj.recipes : (Array.isArray(bundle.recipes) ? bundle.recipes : []);
    const realRecipe = recipes.find(r => r && r.id && /wave438_synth/.test(r.id));
    assert.ok(realRecipe, `recipes.json must include the wave438 synthesized rule; got ids=${JSON.stringify(recipes.map(r => r && r.id))}`);
    // The recipe carries a `source` field with the JS generator source.
    // Identity-echo stub looks like `function generate(input,lib){return input;}`.
    // A real classifier from synthClassifier carries token-counts logic.
    const src = String(realRecipe.source || '');
    assert.ok(src.length > 0, 'synthesized recipe must carry generator source');
    const isJustEcho = /return\s+input\s*;\s*\}/.test(src)
      && !/classA|classB|classC|classD|\.toLowerCase|matchAll|wordSet|scores/.test(src);
    assert.ok(!isJustEcho,
      `recipe source must not be the identity-echo stub; got first 200 chars: ${src.slice(0, 200)}`);
    assert.ok(src.length > 50,
      `recipe source must be substantively longer than echo stub; got ${src.length} bytes`);
  } finally {
    _restoreEnv(saved);
  }
});

// ---------------------------------------------------------------------------
// W438 #5 — synth path skipped when corpus is too small (fewer than 2 train
// pairs OR 0 holdout). Defends against synth misfiring on empty namespaces.
// ---------------------------------------------------------------------------
test('W438 #5 — synth phase skipped when corpus is too small', async () => {
  const saved = _snapEnv();
  _mkIsolatedHome('too-small');
  try {
    const { appendEvent, _resetForTests } = await import('../src/event-store.js');
    if (_resetForTests) _resetForTests();
    const ns = 'w438_5';
    const tenant = 'wave438-5';
    const { approveEvent } = await import('../src/dataset-workbench.js');
    // Only 1 row — synth gate requires trainPairs.length >= 2.
    const e = await appendEvent({
      event_id: 'evt_w438_5_0',
      tenant_id: tenant,
      namespace: ns,
      provider: 'openai',
      model: 'gpt-4',
      prompt_redacted: 'only one row',
      response_redacted: 'lonely',
      status: 'ok',
      source_type: 'real',
      created_at: new Date().toISOString(),
    });
    await approveEvent(e.event_id, { tenant_id: tenant, reviewer: 'wave438' });

    const { compileFull } = await import('../src/compile-pipeline.js');
    const events = [];
    try {
      for await (const ev of compileFull({
        namespace: ns,
        opts: {
          emit_progress_every: 0,
          no_install: true,
          tenant_id: tenant,
          approved_only: true,
          max_steps: 2,
          allow_stub: true,
          synthesize_recipe: true,
          output_spec: { type: 'enum' },
        },
      })) {
        events.push(ev);
      }
    } catch (e) { // deliberate: cleanup
      // Pipeline may throw earlier (synthetic-only gate, etc.) — that is
      // fine, the assertion below only requires "no recipe_synthesis event".
    }
    const synth = events.find(ev => ev.phase === 'recipe_synthesis');
    assert.equal(synth, undefined,
      'recipe_synthesis phase must NOT run when trainPairs.length < 2');
  } finally {
    _restoreEnv(saved);
  }
});
