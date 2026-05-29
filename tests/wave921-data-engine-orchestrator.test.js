// W921 — KOLM Data Engine ORCHESTRATOR (src/data-engine.js).
//
// Locks the single public seam `kolm compile --auto` calls:
//   orchestratePipeline({ tenant, namespace, opts }) ->
//     { ok:true, version:'data-engine-v1', namespace, stages:{ ingest, curate,
//       augment, evaluate, feedback } }
//
// Contract verified against the EXACT envelopes the stage modules return (read
// from src/data-engine.js + src/data-ingest.js + src/data-augment.js +
// src/data-evaluate.js + src/data-feedback.js before writing these asserts):
//   - version === 'data-engine-v1' and the five stage keys are always present.
//   - EVALUATE is a clean SKIP (skipped:true + reason) without opts.run_dir,
//     and the top-level envelope still returns ok:true so every slot can be
//     inspected uniformly.
//   - AUGMENT is PREVIEW-ONLY by default: applied:false / approved:false / wrote
//     not true, but the cost preview is still surfaced — unless
//     opts.approve_cost_usd >= the previewed est_cost_usd, which APPLIES it.
//   - A describe-seeded run populates INGEST with templated seeds (no teacher
//     spend) so the corpus exists for the corpus-dependent stages.
//
// Deterministic: no network, no GPU, no python, no wall-clock branching. Every
// seed/clock/cost input is passed as an explicit fixture. KOLM_DATA_DIR is
// redirected to a unique temp dir in before() and torn down in after() so the
// test never touches real user data. Every call is fenced with a unique tenant.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DATA_ENGINE_VERSION,
  orchestratePipeline,
} from '../src/data-engine.js';

// Each call is fenced with a unique tenant so nothing leaks across tenants.
let _tn = 0;
function tenant() {
  return `tenant_w921_orch_${process.pid}_${++_tn}`;
}

let TMP_DIR;
let PRIOR_DATA_DIR;

before(() => {
  // Redirect ALL data-engine roots (ingest raw-pairs, augment-pairs, curated
  // pairs, the best-effort event store) into a unique temp dir. Every root in
  // these modules reads process.env.KOLM_DATA_DIR lazily at call time, so
  // setting it here (before any orchestratePipeline call) fully isolates us.
  PRIOR_DATA_DIR = process.env.KOLM_DATA_DIR;
  TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-orch-'));
  process.env.KOLM_DATA_DIR = TMP_DIR;
});

after(() => {
  if (PRIOR_DATA_DIR === undefined) delete process.env.KOLM_DATA_DIR;
  else process.env.KOLM_DATA_DIR = PRIOR_DATA_DIR;
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// A describe-seeded run is the cheapest way to give the corpus-dependent stages
// (curate, augment) real pairs without any teacher spend: ingestDescribe writes
// templated empty-output seed prompts straight to raw-pairs.jsonl.
function describeOpts(extra = {}) {
  return {
    describe: 'Answer customer billing questions for a SaaS product.',
    describe_n: 12,
    ...extra,
  };
}

test('exports the v1 version constant', () => {
  assert.equal(DATA_ENGINE_VERSION, 'data-engine-v1');
});

test('envelope: ok + version + all five stage keys present', async () => {
  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: 'ns-shape',
    opts: describeOpts(),
  });

  assert.equal(out.ok, true);
  assert.equal(out.version, 'data-engine-v1');
  assert.equal(out.namespace, 'ns-shape');
  assert.equal(typeof out.stages, 'object');
  assert.ok(out.stages !== null);
  // The five canonical 6-stage-loop slots are always present.
  for (const key of ['ingest', 'curate', 'augment', 'evaluate', 'feedback']) {
    assert.ok(key in out.stages, `stages.${key} must be present`);
  }
});

test('bad input: missing tenant/namespace/opts still returns a uniform ok envelope', async () => {
  // orchestratePipeline never throws; with no corpus the ingest slot carries
  // { ok:false, error } and the corpus-dependent stages are SKIPPED — but the
  // top-level envelope is still ok:true so a caller can inspect every slot.
  const out = await orchestratePipeline({ tenant: tenant(), namespace: 'ns-empty' });

  assert.equal(out.ok, true);
  assert.equal(out.version, 'data-engine-v1');
  assert.equal(out.stages.ingest.ok, false);
  assert.equal(typeof out.stages.ingest.error, 'string');
  assert.match(out.stages.ingest.error, /no training pairs/i);
  // No corpus -> curate + augment are clean skips, not errors.
  assert.equal(out.stages.curate.skipped, true);
  assert.equal(out.stages.augment.skipped, true);
});

test('EVALUATE is skipped (with a reason) when no opts.run_dir is provided', async () => {
  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: 'ns-eval-skip',
    opts: describeOpts(),
  });

  // Pipeline still succeeds end-to-end...
  assert.equal(out.ok, true);
  // ...but the evaluate slot is a clean skip carrying a human-readable reason,
  // never an error.
  assert.equal(out.stages.evaluate.skipped, true);
  assert.equal(out.stages.evaluate.ok, undefined);
  assert.equal(typeof out.stages.evaluate.reason, 'string');
  assert.match(out.stages.evaluate.reason, /run_dir/i);
});

test('AUGMENT is PREVIEW-ONLY by default: not applied, no approval, cost surfaced', async () => {
  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: 'ns-aug-preview',
    opts: describeOpts({ augment_strategy: 'evol' }),
  });

  const aug = out.stages.augment;
  assert.equal(aug.ok, true);
  assert.equal(aug.version, 'augment-v1');
  // Default = preview only: nothing applied, no approval recorded, no write.
  assert.equal(aug.applied, false);
  assert.equal(aug.approved, false);
  assert.notEqual(aug.wrote, true);
  // The cost preview is ALWAYS surfaced (applied or not) so the operator sees
  // the teacher bill before approving.
  assert.equal(typeof aug.cost_preview, 'object');
  assert.equal(typeof aug.cost_preview.est_cost_usd, 'number');
  assert.equal(typeof aug.n_candidates, 'number');
});

test('AUGMENT APPLIES only when approve_cost_usd >= previewed est_cost_usd', async () => {
  // First do a preview run to learn the exact previewed cost for this corpus...
  const preview = await orchestratePipeline({
    tenant: tenant(),
    namespace: 'ns-aug-apply',
    opts: describeOpts({ augment_strategy: 'evol' }),
  });
  const est = preview.stages.augment.cost_preview.est_cost_usd;
  assert.equal(typeof est, 'number');

  // ...then approve at-or-above that cost on a SEPARATE namespace so the apply
  // path is exercised against a fresh corpus.
  const approved = await orchestratePipeline({
    tenant: tenant(),
    namespace: 'ns-aug-apply2',
    opts: describeOpts({ augment_strategy: 'evol', approve_cost_usd: est + 1 }),
  });
  const aug = approved.stages.augment;
  assert.equal(aug.ok, true);
  assert.equal(aug.approved, true);
  assert.equal(aug.approve_cost_usd, est + 1);
  // Applied is true only when candidates were actually written (wrote===true).
  assert.equal(aug.applied, true);
});

test('describe-seeded INGEST populates the corpus templated (no teacher spend)', async () => {
  const ns = 'ns-describe';
  const out = await orchestratePipeline({
    tenant: tenant(),
    namespace: ns,
    opts: describeOpts({ describe_n: 9 }),
  });

  const ing = out.stages.ingest;
  assert.equal(ing.ok, true);
  assert.equal(ing.source, 'describe');
  // Seeds were templated to disk with no network call; corpus is non-empty.
  assert.ok(ing.n_pairs >= 1, `expected templated seeds, got n_pairs=${ing.n_pairs}`);
  assert.equal(typeof ing.path, 'string');
  // The seeds really landed under our temp KOLM_DATA_DIR, not real user data.
  assert.ok(ing.path.startsWith(TMP_DIR), `ingest path ${ing.path} must be under ${TMP_DIR}`);
  assert.ok(fs.existsSync(ing.path), 'raw-pairs.jsonl must exist on disk');

  // With a real corpus, the corpus-dependent stages run instead of skipping.
  assert.notEqual(out.stages.curate.skipped, true);
  assert.notEqual(out.stages.augment.skipped, true);
});
