import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { compilePipeline as runnerCompilePipeline } from '../src/pipeline-runner.js';
import { compilePipeline, validateSpec } from '../src/spec-compile.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'spec-compile-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'spec-compile-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W946 package wiring makes the spec compile matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:spec-compile-matrix'], 'node scripts/build-spec-compile-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:spec-compile-matrix'],
    'node scripts/build-spec-compile-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave946-spec-compile-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-spec-compile-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/spec-compile-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/spec-compile-matrix\.json/);
  assert.match(releaseVerify, /kolm\.spec_compile_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /SPEC_COMPILE_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_spec_compile_matrix_and_signed_artifact_compiler_contract/);
  assert.match(backendAtomic, /npm run verify:spec-compile-matrix/);
});

test('W946 generated matrix is current and all hard spec compile gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-spec-compile-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.spec_compile_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 3);
  assert.ok(m.summary.function_count >= 6);
  assert.ok(m.summary.compile_option_count >= 39);
  assert.ok(m.summary.env_ref_count >= 12);
  assert.ok(m.summary.build_and_zip_field_count >= 33);
  assert.equal(m.summary.validation_rule_count, 10);
  assert.equal(m.summary.present_validation_rule_count, 10);
  assert.equal(m.summary.phase_count, 30);
  assert.equal(m.summary.present_phase_count, 30);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_validation_rules, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 55);
});

test('W946 matrix captures compile phases, build fields, options, env knobs, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/spec-compile.js'));
  assert.ok(m.sources.includes('src/artifact.js'));
  assert.ok(m.sources.includes('src/native-compile.js'));
  assert.ok(m.sources.includes('src/pipeline-runner.js'));

  const phases = new Set(m.compile_phases.map((row) => row.phase));
  for (const phase of [
    'spec_validation',
    'seed_gate',
    'measured_eval',
    'seed_provenance',
    'dsl_native_sources',
    'native_wasm_compile',
    'distill_lineage',
    'export_runtime_passports',
    'external_holdouts',
    'tenant_shadow_corpus',
    'auditor_attestation',
    'compiled_binary_honesty',
    'confidential_compute_attestation',
    'speculative_decoding_resolution',
    'speculative_decoding_eval',
    'build_and_zip',
    'post_build_cleanup',
    'workload_profile_zip_patch',
    'pipeline_reexport',
  ]) {
    assert.ok(phases.has(phase), `missing phase ${phase}`);
  }

  const fields = new Set(m.build_and_zip_fields);
  for (const field of ['compiled_targets', 'binaries', 'compiled_binary', 'extra_files', 'lineage', 'export', 'moe', 'pretokenize', 'external_holdout', 'tenant_shadow_corpus', 'auditor_attestation', 'runtime_passports', 'speculative_decoding', 'prompt_cache', 'continuous_batching']) {
    assert.ok(fields.has(field), `missing buildAndZip field ${field}`);
  }

  const options = new Set(m.compile_options);
  for (const option of ['seedsPath', 'allowEmptyEvals', 'target', 'compileNative', 'compileWasm', 'tokenizerPath', 'distillProvenancePath', 'exportProvenancePath', 'moeProvenancePath', 'pretokenizeProvenancePath', 'externalHoldouts', 'tenantShadowCorpora', 'auditorAttestations', 'attestation_report', 'workload_profile']) {
    assert.ok(options.has(option), `missing compile option ${option}`);
  }

  const env = new Set(m.env_refs);
  for (const key of ['RECIPE_RECEIPT_SECRET', 'KOLM_ARTIFACT_SECRET', 'KOLM_WORKLOAD_PROFILE', 'KOLM_COMPILE_NATIVE', 'KOLM_COMPILE_WASM', 'KOLM_COMPILE_SPECULATIVE_DRAFT', 'KOLM_SPECEVAL_RUNTIME', 'KOLM_COMPILE_PROMPT_CACHE', 'KOLM_COMPILE_MAX_BATCH']) {
    assert.ok(env.has(key), `missing env ref ${key}`);
  }

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W946 runtime spec validation and pipeline re-export contracts stay stable', () => {
  const validSpec = {
    job_id: 'job_w946_echo',
    task: 'echo input',
    recipes: [{
      id: 'rcp_echo',
      name: 'Echo',
      source: 'function generate(input, lib) { return input; }',
    }],
    evals: {
      spec: 'rs-1-evals',
      n: 1,
      cases: [{ id: 'case_1', input: 'x', expected: 'x' }],
    },
  };
  assert.equal(validateSpec(validSpec), true);

  assert.throws(
    () => validateSpec({ ...validSpec, job_id: 'bad', recipes: validSpec.recipes }),
    (err) => err && err.code === 'KOLM_E_SPEC_INVALID' && /job_id/.test(err.message),
  );
  assert.throws(
    () => validateSpec({ ...validSpec, artifact_class: 'compiled_rule' }),
    (err) => err && err.code === 'KOLM_E_SPEC_INVALID' && /requires a dsl block/.test(err.message),
  );
  assert.equal(compilePipeline, runnerCompilePipeline);
});
