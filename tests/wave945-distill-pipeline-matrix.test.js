import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MODES,
  TEACHER_SOURCE_CLASSIFICATION,
  W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD,
  W808_KSCORE_DROP_THRESHOLD,
  W808_REGRESSION_GATE_VERSION,
  _resolveDistillTenant,
  _resolveOrderingPolicy,
  _w808RegressionGate,
  classifyTeacher,
  resolveDistillFinalK,
  resolveDistillFinalLoss,
  summarizeDistillTelemetry,
} from '../src/distill-pipeline.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'distill-pipeline-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'distill-pipeline-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

async function withEnv(patch, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(patch)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(patch)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('W945 package wiring makes the distill pipeline matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:distill-pipeline-matrix'], 'node scripts/build-distill-pipeline-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:distill-pipeline-matrix'],
    'node scripts/build-distill-pipeline-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave945-distill-pipeline-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:wrapper-cli-matrix && npm run build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-distill-pipeline-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/distill-pipeline-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/distill-pipeline-matrix\.json/);
  assert.match(releaseVerify, /kolm\.distill_pipeline_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /DISTILL_PIPELINE_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_distill_pipeline_matrix_and_training_orchestrator_contract/);
  assert.match(backendAtomic, /npm run verify:distill-pipeline-matrix/);
});

test('W945 generated matrix is current and all hard distill gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-distill-pipeline-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.distill_pipeline_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 19);
  assert.ok(m.summary.function_count >= 26);
  assert.equal(m.summary.mode_count, 3);
  assert.equal(m.summary.teacher_classification_count, 10);
  assert.equal(m.summary.open_weight_teacher_count, 7);
  assert.equal(m.summary.proprietary_teacher_count, 3);
  assert.equal(m.summary.distill_option_count, 27);
  assert.ok(m.summary.worker_flag_count >= 20);
  assert.equal(m.summary.corpus_stats_key_count, 13);
  assert.equal(m.summary.stage_count, 13);
  assert.equal(m.summary.present_stage_count, 13);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 150);
});

test('W945 matrix captures stages, worker flags, safety guards, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/distill-pipeline.js'));
  assert.ok(m.sources.includes('workers/distill/distill.mjs'));

  const stages = new Set(m.pipeline_stages.map((row) => row.stage));
  for (const stage of [
    'corpus_preparation',
    'teacher_policy',
    'teacher_council',
    'worker_input_staging',
    'distill_iterator',
    'worker_spawn',
    'rejection_sampling_forwarding',
    'privacy_budget',
    'efficiency_env',
    'telemetry_summary',
    'run_listing',
    'run_detail',
    'regression_gate',
  ]) {
    assert.ok(stages.has(stage), `missing stage ${stage}`);
  }

  const flags = new Set(m.worker_flags.map((row) => row.flag));
  for (const flag of ['--distillation-method', '--rs-n', '--rs-temperature', '--rs-threshold', '--rs-threshold-mode', '--rs-reward', '--curriculum', '--importance-weights']) {
    assert.ok(flags.has(flag), `missing worker flag ${flag}`);
  }

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W945 runtime teacher policy, tenant, ordering, and telemetry contracts stay stable', async () => {
  assert.deepEqual([...MODES].sort(), ['kd_softmax', 'kd_top_k', 'rejection_sampling'].sort());
  assert.ok(Object.isFrozen(TEACHER_SOURCE_CLASSIFICATION));
  assert.equal(classifyTeacher('local:/models/qwen'), 'open-weights');
  assert.equal(classifyTeacher('hf:Qwen/Qwen2.5-7B-Instruct'), 'open-weights');
  assert.equal(classifyTeacher('openai:gpt-4o-mini'), 'proprietary');
  assert.equal(classifyTeacher('unknown-frontier-model'), 'unknown');

  assert.equal(_resolveDistillTenant({ tenant_id: 'tenant_a', tenant: 'tenant_b' }), 'tenant_a');
  assert.equal(_resolveDistillTenant({ tenant: 'tenant_b' }), 'tenant_b');
  assert.equal(_resolveDistillTenant({}), 'local');

  await withEnv({ KOLM_DISTILL_CURRICULUM: undefined, KOLM_DISTILL_IMPORTANCE: undefined }, () => {
    assert.deepEqual(_resolveOrderingPolicy({ curriculum: 'descending', importance: '1' }), {
      curriculum: 'descending',
      importance: true,
    });
    assert.deepEqual(_resolveOrderingPolicy({ curriculum: 'off', importance: false }), {
      curriculum: null,
      importance: false,
    });
  });

  assert.deepEqual(resolveDistillFinalLoss(null, { loss: 0.8 }), {
    loss: null,
    source: 'synthetic_suppressed',
  });
  assert.deepEqual(resolveDistillFinalK({ k_score_final: 0.91 }, { k_score: 0.5, k_source: 'projected' }), {
    k_score: 0.91,
    source: 'measured',
  });
  assert.deepEqual(summarizeDistillTelemetry({
    workerMode: 'full',
    manifest: { loss_final: 0.12, k_score_final: 0.91 },
    lastStep: { loss: 0.8, k_score: 0.5, telemetry_source: 'synthetic' },
  }), {
    telemetry_source: 'measured',
    progress_telemetry_source: 'synthetic',
    loss_final: 0.12,
    loss_source: 'measured',
    k_final: 0.91,
    k_source: 'measured',
    worker_mode: 'full',
  });
});

test('W945 W808 regression gate remains versioned, tenant-local, and fail-closed', async () => {
  assert.equal(W808_REGRESSION_GATE_VERSION, 'w808-v1');
  assert.equal(W808_KSCORE_DROP_THRESHOLD, 0.02);
  assert.equal(W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD, 0.01);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w945-w808-'));
  await withEnv({
    KOLM_DATA_DIR: tmp,
    HOME: tmp,
    USERPROFILE: tmp,
  }, () => {
    const needsHuman = _w808RegressionGate({
      run_dir: null,
      namespace: 'w945',
      tenant_id: 'tenant-w945',
      manifest: null,
    });
    assert.equal(needsHuman.ok, false);
    assert.equal(needsHuman.verdict, 'needs_human');
    assert.equal(needsHuman.error, 'no_candidate_kscore');

    const first = _w808RegressionGate({
      run_dir: path.join(tmp, 'distill-runs', 'run_current_w945', 'out'),
      namespace: 'w945',
      tenant_id: 'tenant-w945',
      manifest: { k_score_final: 0.88, critical_fail_rate: 0.01 },
    });
    assert.equal(first.ok, true);
    assert.equal(first.verdict, 'first_run');
    assert.equal(first.candidate_kscore, 0.88);
    assert.equal(first.version, 'w808-v1');
  });
});
