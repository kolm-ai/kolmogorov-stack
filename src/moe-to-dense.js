// W958 - MoE-to-dense structural collapse orchestration.
//
// Node owns validation, trainer resolution, and durable envelopes. Python owns
// the tensor operation: DO-ACP-style expert scoring plus dense FFN concat.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonBin } from './python-runtime.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

export const MOE_TO_DENSE_VERSION = 'w958-moe-to-dense-v1';
export const MOE_TO_DENSE_RECOVERY_VERSION = 'w980-moe-to-dense-recovery-v1';
export const MOE_RESIDUAL_PRUNE_VERSION = 'w1012-moe-residual-prune-v1';

const INSTALL_HINT = [
  'MoE-to-dense structural collapse requires the in-repo Python worker or a compatible external trainer.',
  '',
  'set $KOLM_MOE_TO_DENSE_TRAINER to an absolute path or JSON argv array accepting:',
  '  --checkpoint <path>       MoE checkpoint (.json/.pt/.safetensors)',
  '  --router-stats <path>     activation counts / Gram matrix',
  '  --out <dir>               output directory for dense-init checkpoint + manifest',
  '  --selected-experts <n>    experts to concatenate into each dense FFN',
  '',
  'in-repo implementation:',
  '  apps/trainer/moe_to_dense.py',
].join('\n');

const RECOVERY_INSTALL_HINT = [
  'MoE-to-dense recovery KD uses apps/trainer/distill.py by default.',
  'Set $KOLM_MOE_RECOVERY_TRAINER to an absolute path or JSON argv array accepting:',
  '  --teacher-model <model> --student-model <dense-init> --train-jsonl <pairs>',
  '  --eval-jsonl <holdout> --out-dir <dir> --objective forward_kl',
  '',
  'in-repo implementation:',
  '  apps/trainer/distill.py',
].join('\n');

function _pythonBin() {
  return pythonBin();
}

function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try { if (fs.existsSync(name) && fs.statSync(name).isFile()) return name; } catch (_) {} // deliberate
    return null;
  }
  const P = process.env.PATH || '';
  const SEP = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
    : [''];
  for (const dir of P.split(SEP)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {} // deliberate
    }
  }
  return null;
}

export function resolveMoeToDenseTrainer(env = process.env) {
  if (env.KOLM_MOE_TO_DENSE_NO_TRAINER === '1') return null;
  const override = env.KOLM_MOE_TO_DENSE_TRAINER;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = whichSync(parsed[0]);
        if (head) return { argv: [head, ...parsed.slice(1)], source: 'env-array' };
      }
    } catch (_) {} // deliberate
    const resolved = whichSync(override);
    if (resolved) return { argv: [resolved], source: 'env' };
    return null;
  }
  for (const name of ['kolm-moe-to-dense', 'moe-to-dense']) {
    const r = whichSync(name);
    if (r) return { argv: [r], source: 'path' };
  }
  const inRepo = path.join(_repoRoot, 'apps', 'trainer', 'moe_to_dense.py');
  if (fs.existsSync(inRepo)) return { argv: [_pythonBin(), inRepo], source: 'in_repo', script: inRepo };
  return null;
}

export function resolveMoeRecoveryTrainer(env = process.env) {
  if (env.KOLM_MOE_RECOVERY_NO_TRAINER === '1') return null;
  const override = env.KOLM_MOE_RECOVERY_TRAINER;
  if (override) {
    try {
      const parsed = JSON.parse(override);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = whichSync(parsed[0]);
        if (head) return { argv: [head, ...parsed.slice(1)], source: 'env-array' };
      }
    } catch (_) {} // deliberate
    const resolved = whichSync(override);
    if (resolved) return { argv: [resolved], source: 'env' };
    return null;
  }
  const inRepo = path.join(_repoRoot, 'apps', 'trainer', 'distill.py');
  if (fs.existsSync(inRepo)) return { argv: [_pythonBin(), inRepo], source: 'in_repo', script: inRepo };
  return null;
}

export function doctorMoeToDense(env = process.env) {
  const t = resolveMoeToDenseTrainer(env);
  if (!t) {
    return {
      ok: false,
      ready: false,
      kind: 'moe_to_dense',
      version: MOE_TO_DENSE_VERSION,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  let preflight = null;
  try {
    const r = spawnSync(t.argv[0], [...t.argv.slice(1), '--preflight-only'], {
      encoding: 'utf8',
      timeout: 30000,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(t.argv[0]),
    });
    if (r.status === 0 && r.stdout) preflight = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
  } catch (_) {} // preflight is advisory
  return {
    ok: true,
    ready: true,
    kind: 'moe_to_dense',
    version: MOE_TO_DENSE_VERSION,
    trainer: t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0],
    trainer_source: t.source,
    algorithm: 'moe_to_dense_do_acp_ffn_concat',
    recovery_distillation_required: true,
    preflight,
    install_hint: INSTALL_HINT,
  };
}

function _mkRunDir(outDir) {
  return outDir || path.join(os.homedir(), '.kolm', 'moe-to-dense-runs',
    `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
}

function _mkRecoveryRunDir(outDir) {
  return outDir || path.join(os.homedir(), '.kolm', 'moe-to-dense-recovery-runs',
    `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
}

function _absMaybe(p) {
  if (!p) return null;
  return path.resolve(String(p));
}

function _trainerLabel(t) {
  if (!t) return null;
  return t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0];
}

function _recoveryStageCommand(t, {
  teacherModel,
  studentModel,
  trainJsonl,
  evalJsonl = null,
  outDir,
  objective = 'forward_kl',
  alpha = 0.8,
  epochs = 1,
  temperature = 2.0,
}) {
  if (!t) return null;
  const cmd = [
    t.argv[0],
    ...t.argv.slice(1),
    '--teacher-model', String(teacherModel),
    '--student-model', String(studentModel),
    '--train-jsonl', String(trainJsonl),
    '--out-dir', String(outDir),
    '--objective', String(objective),
    '--alpha', String(alpha),
    '--num-epochs', String(epochs),
    '--temperature', String(temperature),
  ];
  if (evalJsonl) cmd.push('--eval-jsonl', String(evalJsonl));
  return cmd;
}

function _readManifest(runDir) {
  for (const name of ['run-meta.json', 'manifest.json']) {
    const p = path.join(runDir, name);
    if (!fs.existsSync(p)) continue;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) {} // deliberate
  }
  return null;
}

export function runMoeToDense({
  checkpointPath = null,
  routerStatsPath = null,
  pairsPath = null,
  outDir = null,
  teacher = 'local-moe-teacher',
  studentBase = 'dense-student',
  namespace = 'default',
  tenant_id = 'local',
  selectedExperts = 2,
  dryRun = false,
  keepExperts = false,
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!checkpointPath && !dryRun) {
    return { ok: false, error: 'checkpoint_missing', detail: 'checkpointPath required unless dryRun=true' };
  }
  if (checkpointPath && !fs.existsSync(checkpointPath)) {
    return { ok: false, error: 'checkpoint_missing', detail: `checkpoint not found: ${checkpointPath}` };
  }
  if (routerStatsPath && !fs.existsSync(routerStatsPath)) {
    return { ok: false, error: 'router_stats_missing', detail: `router stats not found: ${routerStatsPath}` };
  }
  const n = Number(selectedExperts);
  if (!Number.isInteger(n) || n < 1 || n > 4096) {
    return { ok: false, error: 'bad_selected_experts', detail: 'selectedExperts must be an integer in [1,4096]' };
  }
  const t = resolveMoeToDenseTrainer();
  const runDir = _mkRunDir(outDir);
  fs.mkdirSync(runDir, { recursive: true });
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'moe_to_dense',
      version: MOE_TO_DENSE_VERSION,
      error: 'no_trainer_installed',
      trainer_kicked: false,
      run_dir: runDir,
      install_hint: INSTALL_HINT,
    };
  }
  const args = [...t.argv.slice(1),
    '--out', runDir,
    '--selected-experts', String(n),
    '--teacher', String(teacher || 'local-moe-teacher'),
    '--student-base', String(studentBase || 'dense-student'),
    '--namespace', String(namespace || 'default'),
    '--tenant', String(tenant_id || 'local'),
  ];
  if (checkpointPath) args.push('--checkpoint', checkpointPath);
  if (routerStatsPath) args.push('--router-stats', routerStatsPath);
  if (pairsPath) args.push('--pairs', pairsPath);
  if (dryRun) args.push('--dry-run');
  if (keepExperts) args.push('--keep-experts');
  const result = spawnSync(t.argv[0], args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(t.argv[0]),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      kind: 'moe_to_dense',
      version: MOE_TO_DENSE_VERSION,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      trainer_source: t.source,
      run_dir: runDir,
      stdout: String(result.stdout || '').slice(-2000),
      stderr: String(result.stderr || '').slice(-2000),
    };
  }
  return {
    ok: true,
    kind: 'moe_to_dense',
    version: MOE_TO_DENSE_VERSION,
    trainer_source: t.source,
    trainer: t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0],
    run_dir: runDir,
    manifest: _readManifest(runDir),
    stdout: String(result.stdout || '').slice(-2000),
  };
}

export function runMoeResidualPrune({
  checkpointPath = null,
  routerStatsPath = null,
  outDir = null,
  teacher = 'local-moe-teacher',
  studentBase = 'sparse-moe-student',
  namespace = 'default',
  tenant_id = 'local',
  keepExpertIds = null,
  pruneThreshold = null,
  minKeepExperts = 1,
  dryRun = false,
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!checkpointPath && !dryRun) {
    return { ok: false, error: 'checkpoint_missing', detail: 'checkpointPath required unless dryRun=true' };
  }
  if (checkpointPath && !fs.existsSync(checkpointPath)) {
    return { ok: false, error: 'checkpoint_missing', detail: `checkpoint not found: ${checkpointPath}` };
  }
  if (routerStatsPath && !fs.existsSync(routerStatsPath)) {
    return { ok: false, error: 'router_stats_missing', detail: `router stats not found: ${routerStatsPath}` };
  }
  const minKeep = Number(minKeepExperts);
  if (!Number.isInteger(minKeep) || minKeep < 1 || minKeep > 4096) {
    return { ok: false, error: 'bad_min_keep_experts', detail: 'minKeepExperts must be an integer in [1,4096]' };
  }
  const threshold = pruneThreshold == null ? null : Number(pruneThreshold);
  if (threshold != null && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    return { ok: false, error: 'bad_prune_threshold', detail: 'pruneThreshold must be in [0,1]' };
  }
  const ids = keepExpertIds == null
    ? null
    : (Array.isArray(keepExpertIds) ? keepExpertIds : String(keepExpertIds).split(','))
      .map((v) => Number(v))
      .filter((v) => Number.isInteger(v) && v >= 0);
  const t = resolveMoeToDenseTrainer();
  const runDir = _mkRunDir(outDir);
  fs.mkdirSync(runDir, { recursive: true });
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'moe_residual_prune',
      version: MOE_RESIDUAL_PRUNE_VERSION,
      error: 'no_trainer_installed',
      trainer_kicked: false,
      run_dir: runDir,
      install_hint: INSTALL_HINT,
    };
  }
  const args = [...t.argv.slice(1),
    '--residual-prune',
    '--out', runDir,
    '--teacher', String(teacher || 'local-moe-teacher'),
    '--student-base', String(studentBase || 'sparse-moe-student'),
    '--namespace', String(namespace || 'default'),
    '--tenant', String(tenant_id || 'local'),
    '--min-keep-experts', String(minKeep),
  ];
  if (checkpointPath) args.push('--checkpoint', checkpointPath);
  if (routerStatsPath) args.push('--router-stats', routerStatsPath);
  if (ids && ids.length) args.push('--keep-expert-ids', ids.join(','));
  if (threshold != null) args.push('--prune-threshold', String(threshold));
  if (dryRun) args.push('--dry-run');
  const result = spawnSync(t.argv[0], args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(t.argv[0]),
  });
  if (result.status !== 0) {
    return {
      ok: false,
      kind: 'moe_residual_prune',
      version: MOE_RESIDUAL_PRUNE_VERSION,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      trainer_source: t.source,
      run_dir: runDir,
      stdout: String(result.stdout || '').slice(-2000),
      stderr: String(result.stderr || '').slice(-2000),
    };
  }
  return {
    ok: true,
    kind: 'moe_residual_prune',
    version: MOE_RESIDUAL_PRUNE_VERSION,
    trainer_source: t.source,
    trainer: _trainerLabel(t),
    run_dir: runDir,
    manifest: _readManifest(runDir),
    stdout: String(result.stdout || '').slice(-2000),
  };
}

export function evaluateMoeRecoveryEvidence({
  metrics = null,
  metricPath = null,
  retentionFloor = 0.7,
  maxKscoreDrop = 0.03,
  recoveredCheckpoint = null,
  artifactReceipt = null,
} = {}) {
  let body = metrics;
  if (!body && metricPath) {
    body = JSON.parse(fs.readFileSync(metricPath, 'utf8'));
  }
  const m = body || {};
  const teacher = Number(m.teacher_kscore ?? m.teacher_score ?? m.teacher_holdout_accuracy);
  const student = Number(m.student_kscore ?? m.student_score ?? m.student_holdout_accuracy);
  const retention = Number.isFinite(Number(m.retention))
    ? Number(m.retention)
    : (Number.isFinite(teacher) && teacher > 0 && Number.isFinite(student) ? student / teacher : NaN);
  const kscoreDrop = Number.isFinite(Number(m.kscore_drop))
    ? Number(m.kscore_drop)
    : (Number.isFinite(teacher) && Number.isFinite(student) ? Math.max(0, teacher - student) : NaN);
  const blocked = [];
  if (!Number.isFinite(retention)) blocked.push('retention_metric_missing');
  else if (retention < retentionFloor) blocked.push('retention_below_floor');
  if (!Number.isFinite(kscoreDrop)) blocked.push('kscore_drop_missing');
  else if (kscoreDrop > maxKscoreDrop) blocked.push('kscore_drop_exceeds_floor');
  if (recoveredCheckpoint && !fs.existsSync(recoveredCheckpoint)) blocked.push('recovered_checkpoint_missing');
  const pass = blocked.length === 0;
  return {
    ok: pass,
    kind: 'moe_recovery_quality_gate',
    version: MOE_TO_DENSE_RECOVERY_VERSION,
    retention: Number.isFinite(retention) ? Number(retention.toFixed(6)) : null,
    kscore_drop: Number.isFinite(kscoreDrop) ? Number(kscoreDrop.toFixed(6)) : null,
    retention_floor: retentionFloor,
    max_kscore_drop: maxKscoreDrop,
    blocked_reasons: blocked,
    artifact_signing: {
      status: pass ? 'ready_to_sign' : 'blocked_by_quality_gate',
      recovered_checkpoint: recoveredCheckpoint ? path.resolve(recoveredCheckpoint) : null,
      artifact_receipt: artifactReceipt || null,
      note: pass
        ? 'Metrics pass the local gate; artifact signing may proceed through the normal compile/sign path.'
        : 'No signed recovered artifact should be promoted until the measured recovery gate passes.',
    },
  };
}

export function buildMoeToDenseRecoveryPlan({
  collapseManifest = null,
  denseInitPath = null,
  pairsPath = null,
  holdoutPath = null,
  outDir = null,
  teacher = null,
  studentBase = null,
  warmupEpochs = 1,
  kdEpochs = 1,
  temperature = 2.0,
  kdAlpha = 0.8,
  env = process.env,
} = {}) {
  const manifest = collapseManifest || {};
  const denseInit = _absMaybe(denseInitPath || manifest.out_checkpoint);
  const pairs = _absMaybe(pairsPath || manifest.recovery_distillation?.pairs);
  const holdout = _absMaybe(holdoutPath);
  const teacherModel = teacher || manifest.teacher_model || 'local-moe-teacher';
  const baseStudent = studentBase || manifest.student_base || 'dense-student';
  const recoveryRoot = _absMaybe(outDir) || path.join(os.homedir(), '.kolm', 'moe-to-dense-recovery-plan');
  const warmupOut = path.join(recoveryRoot, 'lm-warmup');
  const kdOut = path.join(recoveryRoot, 'forward-kl-recovery');
  const trainer = resolveMoeRecoveryTrainer(env);
  const blocked_reasons = [];
  if (!denseInit) blocked_reasons.push('dense_init_checkpoint_missing');
  if (!pairs) blocked_reasons.push('pairs_missing');
  if (!trainer) blocked_reasons.push('recovery_trainer_missing');
  if (pairs && !fs.existsSync(pairs)) blocked_reasons.push('pairs_not_found');
  if (holdout && !fs.existsSync(holdout)) blocked_reasons.push('holdout_not_found');
  const ready = blocked_reasons.length === 0;
  const warmupCommand = ready ? _recoveryStageCommand(trainer, {
    teacherModel,
    studentModel: denseInit,
    trainJsonl: pairs,
    evalJsonl: holdout,
    outDir: warmupOut,
    objective: 'forward_kl',
    alpha: 0.0,
    epochs: warmupEpochs,
    temperature,
  }) : null;
  const kdCommand = ready ? _recoveryStageCommand(trainer, {
    teacherModel,
    studentModel: warmupOut,
    trainJsonl: pairs,
    evalJsonl: holdout,
    outDir: kdOut,
    objective: 'forward_kl',
    alpha: kdAlpha,
    epochs: kdEpochs,
    temperature,
  }) : null;
  return {
    ok: true,
    kind: 'moe_to_dense_recovery_plan',
    version: MOE_TO_DENSE_RECOVERY_VERSION,
    structural_collapse_version: manifest.version || MOE_TO_DENSE_VERSION,
    algorithm: 'moe_to_dense_do_acp_ffn_concat_then_staged_forward_kl',
    status: ready ? 'ready_to_run' : 'needs_inputs_or_trainer',
    blocked_reasons,
    dense_init_checkpoint: denseInit,
    teacher_model: teacherModel,
    base_student_model: baseStudent,
    pairs,
    holdout,
    trainer: _trainerLabel(trainer),
    trainer_source: trainer?.source || null,
    install_hint: trainer ? null : RECOVERY_INSTALL_HINT,
    stages: [
      {
        id: 'lm_warmup',
        objective: 'ce_warmup_via_forward_kl_alpha_zero',
        alpha: 0.0,
        epochs: warmupEpochs,
        student_model: denseInit,
        out_dir: warmupOut,
        command: warmupCommand,
        status: ready ? 'ready' : 'blocked',
      },
      {
        id: 'forward_kl_recovery',
        objective: 'forward_kl',
        alpha: kdAlpha,
        epochs: kdEpochs,
        student_model: warmupOut,
        out_dir: kdOut,
        command: kdCommand,
        status: ready ? 'ready' : 'blocked',
      },
    ],
    measured_quality: {
      status: 'pending_recovery_run',
      required_metrics: ['student_holdout_accuracy', 'holdout_accuracy', 'eval_loss', 'kscore_delta_vs_moe_teacher'],
      note: 'No benchmark-quality retention claim is made until recovery commands run on real hardware and emit measured holdout/K-score evidence.',
    },
    artifact_signing: {
      status: 'pending_recovery_output',
      expected_next_step: 'compile/sign recovered dense checkpoint into a .kolm artifact after measured eval passes',
    },
  };
}

export function runMoeToDenseRecoveryPipeline({
  checkpointPath = null,
  routerStatsPath = null,
  pairsPath = null,
  holdoutPath = null,
  outDir = null,
  teacher = 'local-moe-teacher',
  studentBase = 'dense-student',
  namespace = 'default',
  tenant_id = 'local',
  selectedExperts = 2,
  keepExperts = false,
  dryRun = false,
  runRecovery = false,
  timeoutMs = 60 * 60 * 1000,
  warmupEpochs = 1,
  kdEpochs = 1,
  temperature = 2.0,
  kdAlpha = 0.8,
} = {}) {
  const runDir = _mkRecoveryRunDir(outDir);
  const collapseDir = path.join(runDir, '01-structural-collapse');
  const recoveryDir = path.join(runDir, '02-recovery-kd');
  fs.mkdirSync(runDir, { recursive: true });
  const collapse = runMoeToDense({
    checkpointPath,
    routerStatsPath,
    pairsPath,
    outDir: collapseDir,
    teacher,
    studentBase,
    namespace,
    tenant_id,
    selectedExperts,
    dryRun,
    keepExperts,
    timeoutMs,
  });
  const recoveryPlan = buildMoeToDenseRecoveryPlan({
    collapseManifest: collapse.manifest,
    pairsPath,
    holdoutPath,
    outDir: recoveryDir,
    teacher,
    studentBase,
    warmupEpochs,
    kdEpochs,
    temperature,
    kdAlpha,
  });
  const recovery = {
    attempted: !!runRecovery,
    status: runRecovery ? 'not_started' : 'planned_only',
    stages: [],
  };
  if (runRecovery) {
    const runnable = recoveryPlan.stages.filter((stage) => Array.isArray(stage.command) && stage.command.length > 0);
    if (!collapse.ok || recoveryPlan.status !== 'ready_to_run' || runnable.length !== recoveryPlan.stages.length) {
      recovery.status = 'not_ready';
      recovery.blocked_reasons = [...new Set([
        ...(collapse.ok ? [] : [collapse.error || 'structural_collapse_failed']),
        ...recoveryPlan.blocked_reasons,
      ])];
    } else {
      recovery.status = 'running';
      for (const stage of runnable) {
        const result = spawnSync(stage.command[0], stage.command.slice(1), {
          encoding: 'utf8',
          timeout: timeoutMs,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(stage.command[0]),
        });
        recovery.stages.push({
          id: stage.id,
          exit_code: result.status,
          ok: result.status === 0,
          stdout_tail: String(result.stdout || '').slice(-2000),
          stderr_tail: String(result.stderr || '').slice(-2000),
        });
        if (result.status !== 0) {
          recovery.status = result.status === null ? 'timeout' : 'failed';
          break;
        }
      }
      if (recovery.status === 'running') recovery.status = 'completed';
    }
  }
  const envelope = {
    ok: !!collapse.ok && (!runRecovery || recovery.status === 'completed'),
    kind: 'moe_to_dense_recovery_pipeline',
    version: MOE_TO_DENSE_RECOVERY_VERSION,
    run_dir: runDir,
    structural_collapse: collapse,
    recovery_plan: recoveryPlan,
    recovery,
  };
  try {
    fs.writeFileSync(path.join(runDir, 'pipeline-manifest.json'), JSON.stringify(envelope, null, 2) + '\n');
  } catch (_) {} // best-effort receipt write; caller still receives the envelope
  return envelope;
}

export default {
  MOE_TO_DENSE_VERSION,
  MOE_TO_DENSE_RECOVERY_VERSION,
  MOE_RESIDUAL_PRUNE_VERSION,
  resolveMoeToDenseTrainer,
  resolveMoeRecoveryTrainer,
  doctorMoeToDense,
  runMoeToDense,
  runMoeResidualPrune,
  evaluateMoeRecoveryEvidence,
  buildMoeToDenseRecoveryPlan,
  runMoeToDenseRecoveryPipeline,
};
