import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'quantize-worker-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'quantize-worker-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W941 package wiring makes the quantize worker matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:quantize-worker-matrix'], 'node scripts/build-quantize-worker-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:quantize-worker-matrix'],
    'node scripts/build-quantize-worker-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave941-quantize-worker-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:daemon-connector-matrix && npm run build:quantize-worker-matrix && npm run build:binder-contract-matrix && npm run build:intent-contract-matrix && npm run build:wrapper-cli-matrix && npm run build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:otel-matrix && npm run build:readiness-proof-matrix && npm run build:frontier-delta-freshness && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:daemon-connector-matrix && npm run verify:quantize-worker-matrix && npm run verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:frontier-delta-freshness && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:agent-security-eval && npm run verify:quant-oracle && npm run verify:quantize-worker-matrix && npm run verify:kv-cache/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-quantize-worker-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/quantize-worker-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/quantize-worker-matrix\.json/);
  assert.match(releaseVerify, /kolm\.quantize_worker_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /QUANTIZE_WORKER_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_quantize_worker_matrix_and_frontier_method_contract/);
  assert.match(backendAtomic, /npm run verify:quantize-worker-matrix/);
});

test('W941 generated matrix is current and all hard quantize worker gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-quantize-worker-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.quantize_worker_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.method_count, 15);
  assert.equal(m.summary.stable_method_count, 4);
  assert.equal(m.summary.experimental_method_count, 11);
  assert.equal(m.summary.dispatch_covered_methods, 15);
  assert.equal(m.summary.run_function_count, 12);
  assert.equal(m.summary.cli_flag_count, 14);
  assert.equal(m.summary.receipt_field_count, 19);
  assert.equal(m.summary.required_receipt_field_gaps, 0);
  assert.equal(m.summary.subprocess_boundary_count, 5);
  assert.equal(m.summary.exit_code_count, 4);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.equal(m.summary.worker_package_isolated, true);
});

test('W941 matrix captures methods, flags, dispatch coverage, and receipt fields', () => {
  const m = matrix();
  assert.deepEqual(m.stable_methods, ['awq', 'gptq', 'int4', 'int8']);
  assert.deepEqual(m.experimental_methods, ['aqlm', 'exl2', 'exl3', 'gemq', 'hqq', 'infoquant', 'mc_moe', 'qat', 'quip', 'respinquant', 'spinquant']);
  for (const method of ['int4', 'int8', 'gptq', 'awq', 'aqlm', 'quip', 'exl2', 'exl3', 'hqq', 'qat', 'spinquant', 'respinquant', 'infoquant', 'mc_moe', 'gemq']) {
    assert.ok(m.methods.includes(method), `missing method ${method}`);
    const row = m.method_dispatch.find((x) => x.method === method);
    assert.equal(row.dispatch_present, true, `${method} must have dispatch coverage`);
  }

  const flags = new Set(m.cli_flags.map((row) => row.flag));
  for (const flag of ['--method', '--in', '--out', '--calib', '--group-size', '--bits', '--device', '--mixed-precision', '--trust-remote-code', '--calib-fp4', '--calib-fp4-scale-format', '--calib-fp4-block', '--calib-fp4-max-layers', '--self-test-moe']) {
    assert.ok(flags.has(flag), `missing CLI flag ${flag}`);
  }

  for (const field of ['input_tree_sha256', 'output_files_sha256', 'trust_remote_code', 'fp4_calibration', 'mixed_precision_profile', 'mixed_precision_warnings', 'moe', 'moe_detection']) {
    assert.ok(m.receipt_fields.includes(field), `missing receipt field ${field}`);
  }
});

test('W941 matrix captures optimizer subprocesses, safety guards, worker isolation, and tests', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true);
  assert.equal(m.worker_package.package_name, '@kolm/quantize-worker');
  assert.equal(m.worker_package.private, true);
  assert.equal(m.worker_package.requirements_include_heavy_deps, true);
  assert.equal(m.worker_package.root_excludes_heavy_deps, true);

  const subprocesses = new Map(m.subprocess_boundaries.map((row) => [row.function, row]));
  for (const fn of ['run_aqlm', 'run_quip', '_run_exllamav2', 'run_qat', 'run_rotation_external']) {
    assert.ok(subprocesses.has(fn), `missing subprocess boundary ${fn}`);
    assert.equal(subprocesses.get(fn).check_false, true, `${fn} must use check=False`);
    assert.equal(subprocesses.get(fn).returncode_checked, true, `${fn} must check returncode`);
  }
  assert.deepEqual(subprocesses.get('run_aqlm').repo_envs, ['AQLM_REPO_PATH']);
  assert.deepEqual(subprocesses.get('run_quip').repo_envs, ['QUIP_SHARP_REPO_PATH']);
  assert.deepEqual(subprocesses.get('run_qat').repo_envs, ['EFFICIENT_QAT_REPO_PATH']);

  const evidence = new Map(m.test_evidence.map((row) => [row.path, row.present]));
  for (const rel of [
    'tests/wave195-quantize-worker.test.js',
    'tests/finalized-c5-turnkey-experimental-quant-runners.test.js',
    'tests/finalized-c5-real-layer-importance-mixed-precision.test.js',
    'tests/wave921-fp4-calib-trust-remote.test.js',
    'tests/wave921-moe-quantize.test.js',
    'tests/wave582-quantization-oracle.test.js',
    'tests/wave605-quantization-oracle-frontier.test.js',
    'tests/wave606-quant-accuracy-floor.test.js',
    'tests/wave613-fp4-calib-oracle.test.js',
    'tests/finalized-c5-accuracy-recovery-kscore-gate.test.js',
  ]) {
    assert.equal(evidence.get(rel), true, `${rel} must be direct quantize worker evidence`);
  }
});
