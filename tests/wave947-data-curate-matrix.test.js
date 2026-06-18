import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CURATE_VERSION,
  EMBEDDING_NEAR_DUP_VERSION,
  curateDefault,
  flagCot,
  flagPii,
  redactPii,
  scoreCandidateLocal,
} from '../src/data-curate.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'data-curate-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'data-curate-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

async function withTempEnv(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w947-curate-'));
  const saved = {
    KOLM_DATA_DIR: process.env.KOLM_DATA_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.KOLM_DATA_DIR = tmp;
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

test('W947 package wiring makes the data curate matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:data-curate-matrix'], 'node scripts/build-data-curate-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:data-curate-matrix'],
    'node scripts/build-data-curate-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave947-data-curate-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-data-curate-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/data-curate-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/data-curate-matrix\.json/);
  assert.match(releaseVerify, /kolm\.data_curate_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /DATA_CURATE_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_data_curate_matrix_and_frontier_curation_contract/);
  assert.match(backendAtomic, /npm run verify:data-curate-matrix/);
});

test('W947 generated matrix is current and all hard data curate gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-data-curate-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.data_curate_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 8);
  assert.ok(m.summary.function_count >= 23);
  assert.ok(m.summary.option_count >= 51);
  assert.equal(m.summary.env_ref_count, 3);
  assert.equal(m.summary.stage_count, 20);
  assert.equal(m.summary.present_stage_count, 20);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 30);
});

test('W947 matrix captures curation stages, options, env knobs, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/data-curate.js'));
  assert.ok(m.sources.includes('src/minhash-dedup.js'));
  assert.ok(m.sources.includes('src/data-dsir.js'));

  const stages = new Set(m.curation_stages.map((row) => row.stage));
  for (const stage of [
    'quality_learned_classifier',
    'minhash_predup',
    'semdedup_semantic',
    'python_semantic_dedup',
    'embedding_near_dup_fallback',
    'semantic_cluster_labels',
    'label_error_detection',
    'cot_filter',
    'pii_redaction',
    'valuation_influence',
    'valuation_shapley',
    'diversity_select',
    'dsir_real_select',
    'jsonl_materialization',
    'provenance_persist',
    'curate_default_light_path',
  ]) {
    assert.ok(stages.has(stage), `missing stage ${stage}`);
  }

  const options = new Set(m.options);
  for (const option of ['qualityClassifier', 'minhash', 'semdedup', 'embeddingNearDup', 'semanticCluster', 'detectErrors', 'valueStrategy', 'shapleyVal', 'diversitySelect', 'select_strategy', 'target_items', 'target_size']) {
    assert.ok(options.has(option), `missing option ${option}`);
  }
  assert.deepEqual(m.env_refs, ['KOLM_DATA_DIR', 'KOLM_DSIR_DISABLE', 'KOLM_PYTHON']);

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W947 runtime curation primitives stay bounded, versioned, and privacy-safe', async () => {
  assert.equal(CURATE_VERSION, 'curate-v1');
  assert.equal(EMBEDDING_NEAR_DUP_VERSION, 'embedding-near-dup-v1');

  assert.equal(flagCot('<think>private chain</think> final answer'), true);
  assert.equal(flagCot('Final concise answer only.'), false);
  assert.equal(flagPii('mail alice@example.com or call 555-123-4567'), true);
  assert.equal(redactPii('mail alice@example.com or call 555-123-4567').includes('alice@example.com'), false);

  const leaked = scoreCandidateLocal('<think>secret</think> The answer is 42.');
  const useful = scoreCandidateLocal('Use the billing settings page to rotate the key safely.', 'billing settings key');
  assert.ok(useful.score > leaked.score, 'quality scorer should penalize reasoning leaks');

  await withTempEnv(async () => {
    const r = await curateDefault(null);
    assert.equal(r.ok, true);
    assert.equal(r.version, CURATE_VERSION);
    assert.equal(r.n_in, 0);
    assert.equal(r.n_kept, 0);
  });
});
