// W958 - MoE-to-dense structural collapse boundary.
//
// Locks the frontier path opened by apps/trainer/moe_to_dense.py:
// JS orchestrates, Python does expert scoring + FFN tensor concat, and the
// manifest stays honest that recovery KD is the next stage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  MOE_TO_DENSE_VERSION,
  MOE_TO_DENSE_RECOVERY_VERSION,
  MOE_RESIDUAL_PRUNE_VERSION,
  resolveMoeToDenseTrainer,
  doctorMoeToDense,
  evaluateMoeRecoveryEvidence,
  runMoeToDense,
  runMoeResidualPrune,
  runMoeToDenseRecoveryPipeline,
} from '../src/moe-to-dense.js';
import { distillStrategyCatalog, planDistillStrategy } from '../src/distill-strategy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PY_WORKER = path.join(REPO, 'apps', 'trainer', 'moe_to_dense.py');
const CLI = path.join(REPO, 'cli', 'kolm.js');

function pythonBin() {
  const candidates = [
    process.env.KOLM_PYTHON,
    process.env.PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python',
      process.platform === 'win32' ? 'python.exe' : 'bin/python'),
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
  ].filter(Boolean);
  for (const candidate of candidates) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 10000 });
    if (!r.error && r.status === 0) return candidate;
  }
  return null;
}

function requirePython(t) {
  const py = pythonBin();
  if (!py) {
    t.skip('python not available');
    return null;
  }
  return py;
}

function tmpFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w958-moe-'));
  const checkpoint = path.join(dir, 'moe.json');
  const stats = path.join(dir, 'router-stats.json');
  const pairs = path.join(dir, 'pairs.jsonl');
  const holdout = path.join(dir, 'holdout.jsonl');
  const state = {};
  for (let e = 0; e < 4; e += 1) {
    state[`model.layers.0.block_sparse_moe.experts.${e}.gate_proj.weight`] = [[e + 0.1, e + 0.2], [e + 0.3, e + 0.4]];
    state[`model.layers.0.block_sparse_moe.experts.${e}.up_proj.weight`] = [[e + 1.1, e + 1.2], [e + 1.3, e + 1.4]];
    state[`model.layers.0.block_sparse_moe.experts.${e}.down_proj.weight`] = [[e + 2.1, e + 2.2], [e + 2.3, e + 2.4]];
  }
  fs.writeFileSync(checkpoint, JSON.stringify({ state_dict: state }, null, 2));
  fs.writeFileSync(stats, JSON.stringify({
    activation_counts: [10, 7, 1, 8],
    activation_gram: [
      [1, 0.95, 0.1, 0.05],
      [0.95, 1, 0.1, 0.05],
      [0.1, 0.1, 1, 0.2],
      [0.05, 0.05, 0.2, 1],
    ],
  }, null, 2));
  fs.writeFileSync(pairs, '{"prompt":"add 1+1","response":"2"}\n');
  fs.writeFileSync(holdout, '{"prompt":"add 2+2","response":"4"}\n');
  return { dir, checkpoint, stats, pairs, holdout, out: path.join(dir, 'out') };
}

test('1. moe_to_dense.py self-test covers DO-ACP selection and FFN concat', (t) => {
  const py = requirePython(t);
  if (!py) return;
  assert.ok(fs.existsSync(PY_WORKER), `missing worker at ${PY_WORKER}`);
  const r = spawnSync(py, [PY_WORKER, '--self-test'], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, `self-test failed\nstdout=${r.stdout}\nstderr=${r.stderr}`);
  const env = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  assert.equal(env.ok, true);
  assert.equal(env.version, MOE_TO_DENSE_VERSION);
  assert.ok(env.checks.includes('do_acp_diverse_selection'));
  assert.ok(env.checks.includes('ffn_concat_shapes'));
  assert.ok(env.checks.includes('residual_prune_checkpoint_roundtrip'));
  assert.ok(env.checks.includes('manifest_recovery_kd'));
});

test('2. JS resolver/doctor defaults to the in-repo Python worker', () => {
  const prev = process.env.KOLM_MOE_TO_DENSE_TRAINER;
  const prevNo = process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
  delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  try {
    const t = resolveMoeToDenseTrainer();
    assert.ok(t);
    assert.equal(t.source, 'in_repo');
    assert.equal(path.resolve(t.argv[1]), path.resolve(PY_WORKER));
    const d = doctorMoeToDense();
    assert.equal(d.kind, 'moe_to_dense');
    assert.equal(d.algorithm, 'moe_to_dense_do_acp_ffn_concat');
    assert.equal(path.resolve(d.trainer), path.resolve(PY_WORKER));
  } finally {
    if (prev === undefined) delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_TRAINER = prev;
    if (prevNo === undefined) delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_NO_TRAINER = prevNo;
  }
});

test('3. no-trainer path is explicit, durable, and install-hinted', () => {
  const fixture = tmpFixture();
  const prev = process.env.KOLM_MOE_TO_DENSE_TRAINER;
  const prevNo = process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
  process.env.KOLM_MOE_TO_DENSE_NO_TRAINER = '1';
  try {
    assert.equal(resolveMoeToDenseTrainer(), null);
    const doctor = doctorMoeToDense();
    assert.equal(doctor.ok, false);
    assert.equal(doctor.error, 'no_trainer_installed');
    assert.match(doctor.install_hint, /KOLM_MOE_TO_DENSE_TRAINER/);

    const run = runMoeToDense({
      outDir: fixture.out,
      dryRun: true,
      selectedExperts: 2,
    });
    assert.equal(run.ok, true);
    assert.equal(run.deferred, true);
    assert.equal(run.trainer_kicked, false);
    assert.equal(run.error, 'no_trainer_installed');
    assert.match(run.install_hint, /apps\/trainer\/moe_to_dense\.py/);
    assert.ok(fs.existsSync(run.run_dir), 'deferred run dir is still created');
  } finally {
    if (prev === undefined) delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_TRAINER = prev;
    if (prevNo === undefined) delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_NO_TRAINER = prevNo;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('4. CLI distill moe-to-dense JSON surfaces no-trainer deferral', () => {
  const fixture = tmpFixture();
  const env = {
    ...process.env,
    KOLM_MOE_TO_DENSE_NO_TRAINER: '1',
  };
  delete env.KOLM_MOE_TO_DENSE_TRAINER;
  const r = spawnSync(process.execPath, [
    CLI,
    'distill',
    'moe-to-dense',
    '--dry-run',
    '--out', fixture.out,
    '--json',
  ], { cwd: REPO, env, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.deferred, true);
    assert.equal(body.error, 'no_trainer_installed');
    assert.match(body.install_hint, /KOLM_MOE_TO_DENSE_TRAINER/);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('5. runMoeToDense dispatches Python and writes a dense-init checkpoint', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const fixture = tmpFixture();
  const prev = process.env.KOLM_MOE_TO_DENSE_TRAINER;
  const prevNo = process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  process.env.KOLM_MOE_TO_DENSE_TRAINER = JSON.stringify([py, PY_WORKER]);
  delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  try {
    const r = runMoeToDense({
      checkpointPath: fixture.checkpoint,
      routerStatsPath: fixture.stats,
      outDir: fixture.out,
      selectedExperts: 2,
      teacher: 'Qwen/Qwen3-30B-A3B-MoE',
      studentBase: 'Qwen/Qwen3-8B',
      namespace: 'w958',
      timeoutMs: 60000,
    });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.trainer_source, 'env-array');
    assert.equal(r.manifest.version, MOE_TO_DENSE_VERSION);
    assert.equal(r.manifest.mode, 'structural_collapse');
    assert.equal(r.manifest.recovery_distillation.required, true);
    const layer = r.manifest.structural_collapse.layers[0];
    assert.deepEqual(layer.dense_shapes.gate_proj, [4, 2]);
    assert.deepEqual(layer.dense_shapes.up_proj, [4, 2]);
    assert.deepEqual(layer.dense_shapes.down_proj, [2, 4]);
    assert.ok(fs.existsSync(r.manifest.out_checkpoint));
    const dense = JSON.parse(fs.readFileSync(r.manifest.out_checkpoint, 'utf8')).state_dict;
    assert.ok(Object.keys(dense).some((key) => key.endsWith('.gate_proj.weight')));
    assert.equal(Object.keys(dense).some((key) => key.includes('.experts.')), false);
  } finally {
    if (prev === undefined) delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_TRAINER = prev;
    if (prevNo === undefined) delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_NO_TRAINER = prevNo;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('6. CLI distill moe-to-dense dispatches and returns manifest JSON', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const fixture = tmpFixture();
  const env = {
    ...process.env,
    KOLM_MOE_TO_DENSE_TRAINER: JSON.stringify([py, PY_WORKER]),
  };
  const r = spawnSync(process.execPath, [
    CLI,
    'distill',
    'moe-to-dense',
    '--checkpoint', fixture.checkpoint,
    '--router-stats', fixture.stats,
    '--out', fixture.out,
    '--selected-experts', '2',
    '--json',
  ], { cwd: REPO, env, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'moe_to_dense');
    assert.equal(body.manifest.objective, 'moe_to_dense');
    assert.equal(body.manifest.structural_collapse.layers.length, 1);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('7. distill strategy marks MoE-to-dense as worker-ready structural collapse plus recovery plan', () => {
  const catalog = distillStrategyCatalog();
  const moe = catalog.strategies.find((s) => s.id === 'moe_to_dense_distill');
  assert.equal(moe.execution_status, 'worker_ready_structural_collapse_recovery_plan');
  assert.ok(moe.references.some((r) => r.paper === 'arXiv:2605.28207'));

  const plan = planDistillStrategy({
    task: 'reasoning',
    namespace: 'moe-laptop',
    real_pairs: 2000,
    holdout_pairs: 400,
    teachers: ['local:Qwen/Qwen3-30B-A3B-MoE'],
    teacher_local: true,
    teacher_model: 'Qwen/Qwen3-30B-A3B-MoE',
    base_model: 'Qwen/Qwen3-8B',
  }, {});
  assert.equal(plan.recommendation.id, 'moe_to_dense_distill');
  assert.equal(plan.recommendation.execution_status, 'worker_ready_structural_collapse_recovery_plan');
  assert.match(plan.recommendation.command, /--pipeline/);
  assert.match(plan.recommendation.command, /--checkpoint <moe-checkpoint>/);
  assert.match(plan.recommendation.command, /--pairs <pairs\.jsonl>/);
  assert.match(plan.recommendation.command, /--holdout <holdout\.jsonl>/);
  assert.doesNotMatch(plan.recommendation.command, /--plan-only/);
});

test('8. recovery pipeline chains structural collapse into staged KD plan', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const fixture = tmpFixture();
  const prev = process.env.KOLM_MOE_TO_DENSE_TRAINER;
  const prevRecovery = process.env.KOLM_MOE_RECOVERY_TRAINER;
  const prevNo = process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  process.env.KOLM_MOE_TO_DENSE_TRAINER = JSON.stringify([py, PY_WORKER]);
  process.env.KOLM_MOE_RECOVERY_TRAINER = JSON.stringify([py, path.join(REPO, 'apps', 'trainer', 'distill.py')]);
  delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
  try {
    const r = runMoeToDenseRecoveryPipeline({
      checkpointPath: fixture.checkpoint,
      routerStatsPath: fixture.stats,
      pairsPath: fixture.pairs,
      holdoutPath: fixture.holdout,
      outDir: fixture.out,
      selectedExperts: 2,
      teacher: 'Qwen/Qwen3-30B-A3B-MoE',
      studentBase: 'Qwen/Qwen3-8B',
      namespace: 'w980',
    });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.version, MOE_TO_DENSE_RECOVERY_VERSION);
    assert.equal(r.structural_collapse.manifest.recovery_distillation.required, true);
    assert.equal(r.recovery_plan.status, 'ready_to_run');
    assert.deepEqual(r.recovery_plan.stages.map((s) => s.id), ['lm_warmup', 'forward_kl_recovery']);
    assert.match(r.recovery_plan.stages[0].command.join(' '), /--alpha 0/);
    assert.match(r.recovery_plan.stages[1].command.join(' '), /--objective forward_kl/);
    assert.equal(r.recovery_plan.measured_quality.status, 'pending_recovery_run');
    assert.equal(r.recovery.status, 'planned_only');
    assert.ok(fs.existsSync(path.join(fixture.out, 'pipeline-manifest.json')));
  } finally {
    if (prev === undefined) delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_TRAINER = prev;
    if (prevRecovery === undefined) delete process.env.KOLM_MOE_RECOVERY_TRAINER;
    else process.env.KOLM_MOE_RECOVERY_TRAINER = prevRecovery;
    if (prevNo === undefined) delete process.env.KOLM_MOE_TO_DENSE_NO_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_NO_TRAINER = prevNo;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('9. CLI distill moe-to-dense --pipeline returns recovery manifest JSON', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const fixture = tmpFixture();
  const env = {
    ...process.env,
    KOLM_MOE_TO_DENSE_TRAINER: JSON.stringify([py, PY_WORKER]),
    KOLM_MOE_RECOVERY_TRAINER: JSON.stringify([py, path.join(REPO, 'apps', 'trainer', 'distill.py')]),
  };
  const r = spawnSync(process.execPath, [
    CLI,
    'distill',
    'moe-to-dense',
    '--pipeline',
    '--checkpoint', fixture.checkpoint,
    '--router-stats', fixture.stats,
    '--pairs', fixture.pairs,
    '--holdout', fixture.holdout,
    '--out', fixture.out,
    '--selected-experts', '2',
    '--json',
  ], { cwd: REPO, env, encoding: 'utf8', timeout: 60000 });
  try {
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.kind, 'moe_to_dense_recovery_pipeline');
    assert.equal(body.recovery_plan.status, 'ready_to_run');
    assert.equal(body.recovery_plan.artifact_signing.status, 'pending_recovery_output');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('10. residual MoE prune writes a reduced sparse-MoE checkpoint', (t) => {
  const py = requirePython(t);
  if (!py) return;
  const fixture = tmpFixture();
  const prev = process.env.KOLM_MOE_TO_DENSE_TRAINER;
  process.env.KOLM_MOE_TO_DENSE_TRAINER = JSON.stringify([py, PY_WORKER]);
  try {
    const r = runMoeResidualPrune({
      checkpointPath: fixture.checkpoint,
      routerStatsPath: fixture.stats,
      outDir: fixture.out,
      pruneThreshold: 0.2,
      minKeepExperts: 2,
      namespace: 'w1012',
    });
    assert.equal(r.ok, true, JSON.stringify(r, null, 2));
    assert.equal(r.version, MOE_RESIDUAL_PRUNE_VERSION);
    assert.equal(r.manifest.objective, 'moe_residual_prune');
    assert.equal(r.manifest.residual_moe_prune.layers[0].num_experts_before, 4);
    assert.equal(r.manifest.residual_moe_prune.layers[0].num_experts_after, 3);
    const reduced = JSON.parse(fs.readFileSync(r.manifest.out_checkpoint, 'utf8')).state_dict;
    assert.equal(Object.keys(reduced).some((key) => key.includes('.experts.3.')), false);
    assert.equal(Object.keys(reduced).some((key) => key.includes('.experts.2.')), true);
  } finally {
    if (prev === undefined) delete process.env.KOLM_MOE_TO_DENSE_TRAINER;
    else process.env.KOLM_MOE_TO_DENSE_TRAINER = prev;
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('11. recovery evidence gate blocks signing until measured retention passes', () => {
  const blocked = evaluateMoeRecoveryEvidence({
    metrics: { teacher_kscore: 0.9, student_kscore: 0.6 },
    retentionFloor: 0.8,
    maxKscoreDrop: 0.03,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.artifact_signing.status, 'blocked_by_quality_gate');
  assert.ok(blocked.blocked_reasons.includes('retention_below_floor'));

  const pass = evaluateMoeRecoveryEvidence({
    metrics: { teacher_kscore: 0.9, student_kscore: 0.885 },
    retentionFloor: 0.8,
    maxKscoreDrop: 0.03,
  });
  assert.equal(pass.ok, true);
  assert.equal(pass.artifact_signing.status, 'ready_to_sign');
});
