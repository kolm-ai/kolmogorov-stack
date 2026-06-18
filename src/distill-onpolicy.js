// W480 - on-policy distillation orchestration shell.
//
// Thinking Machines on-policy distillation: student samples its own
// trajectories, teacher returns per-token log-probs on those rollouts, and
// reverse-KL is computed against the student's actual distribution.
//
// This module is a thin Node orchestration shell. The heavy lifting (running
// the student, calling the teacher with logprobs:true, computing the
// reverse-KL gradient, applying it) happens in an external trainer that
// must expose itself via $KOLM_ONPOLICY_TRAINER (absolute path or PATH name).
// When the trainer is absent we return an honest no_trainer_installed
// envelope, mirroring the pattern from workers/media-redact and the W454
// install-hint contract.
//
// The shell IS shipped. The external trainer is a tenant-installed plug-in.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

const INSTALL_HINT = [
  'on-policy distillation requires an external trainer.',
  '',
  'set $KOLM_ONPOLICY_TRAINER to the absolute path of a script that accepts:',
  '  --pairs <jsonl>    on-policy rollouts with teacher logprobs',
  '  --student <path>   path to the student adapter root',
  '  --out <dir>        where to write updated adapter + manifest',
  '',
  'reference implementations:',
  '  - thinking-machines/on-policy-distill (github.com)',
  '  - unsloth on-policy distill recipe (docs.unsloth.ai)',
].join('\n');

function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try { if (fs.existsSync(name) && fs.statSync(name).isFile()) return name; } catch (_) {} // deliberate: cleanup
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
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {} // deliberate: cleanup
    }
  }
  return null;
}

// W713 - resolve the WHITE-BOX on-policy (GKD) trainer. The white-box path's
// real in-repo trainer IS workers/distill/scripts/train_gkd.py (the GKD
// hand-rolled / trl JSD loop). It was never wired as the default, so the path
// was dark. Resolution order:
//   1. KOLM_ONPOLICY_NO_TRAINER=1 forces the durable no-tool path (test seam,
//      mirrors src/distill-grpo.js's KOLM_GRPO_NO_TRAINER).
//   2. $KOLM_ONPOLICY_TRAINER override (JSON array or PATH name) - an override
//      that points nowhere is "no trainer", not a silent in-repo fallback.
//   3. A `kolm-onpolicy-distill` / `onpolicy-distill` on PATH.
//   4. The in-repo train_gkd.py (the genuine white-box trainer). This is the
//      default that lights up the path.
function resolveTrainer() {
  if (process.env.KOLM_ONPOLICY_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_ONPOLICY_TRAINER;
  if (envCmd) {
    try {
      const parsed = JSON.parse(envCmd);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = whichSync(parsed[0]);
        if (head) return { argv: [head, ...parsed.slice(1)], source: 'env-array' };
      }
    } catch (_) {} // deliberate: cleanup
    const resolved = whichSync(envCmd);
    if (resolved) return { argv: [resolved], source: 'env' };
    return null;
  }
  for (const name of ['kolm-onpolicy-distill', 'onpolicy-distill']) {
    const r = whichSync(name);
    if (r) return { argv: [r], source: 'path' };
  }
  // In-repo white-box GKD trainer (mirrors distill-grpo.js in_repo fallback).
  const inRepo = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_gkd.py');
  if (fs.existsSync(inRepo)) return { argv: [_pythonBin(), inRepo], source: 'in_repo' };
  return null;
}

export function doctor() {
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      ready: false,
      kind: 'distill_onpolicy',
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  return {
    ok: true,
    ready: true,
    kind: 'distill_onpolicy',
    // For the in_repo GKD path argv is [python, script]; surface the script so
    // doctor names the actual trainer, not the interpreter.
    trainer: t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0],
    trainer_source: t.source,
    // White-box GKD needs a local teacher; advertise the requirement.
    requires_local_teacher: t.source === 'in_repo',
  };
}

export function trainOnPolicy({
  pairsPath,
  studentPath,
  teacherPath = null,        // W713 - GKD requires a LOCAL teacher (logits)
  outDir = null,
  tenant_id = 'local',
  namespace = 'default',
  maxSteps = 100,
  beta = 0.5,                // GKD JSD interpolation
  lmbda = 0.5,               // on-policy data fraction (final)
  temperature = 1.0,
  // C4 - the rebuilt in-repo GKD trainer (train_gkd.py) accepts a determinism
  // seed + an on-policy warmup fraction + a generation length for the student
  // rollouts inside the JSD loop. They default to the trainer's own defaults
  // (42 / 0.1 / 256), so forwarding them does NOT change behavior for callers
  // that omit them; it only lets the receipt chain pin what was actually run.
  seed = 42,
  warmupFrac = 0.1,
  maxNewTokens = 256,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!pairsPath || !fs.existsSync(pairsPath)) {
    return { ok: false, error: 'pairs_missing', detail: `pairs file not found: ${pairsPath}` };
  }
  if (!studentPath) {
    return { ok: false, error: 'student_missing', detail: 'studentPath required' };
  }
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      deferred: true,
      kind: 'distill_onpolicy',
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  // W713 - the in-repo white-box trainer is train_gkd.py, which REQUIRES a
  // local teacher (it computes JSD over teacher logits). Fail loud + actionable
  // rather than spawning a trainer that will exit 7 with no context. External
  // / PATH trainers define their own contract, so the teacher gate applies
  // only to the in_repo GKD path.
  const teacher = teacherPath || process.env.KOLM_ONPOLICY_TEACHER || null;
  if (t.source === 'in_repo' && !teacher) {
    return {
      ok: false,
      error: 'teacher_required',
      kind: 'distill_onpolicy',
      detail: 'white-box on-policy distillation (GKD) needs a LOCAL teacher for logits. '
        + 'Pass teacherPath or set $KOLM_ONPOLICY_TEACHER to a local model path/id. '
        + '(For black-box API teachers, use the ROPD path: trainRopd().)',
    };
  }
  const runDir = outDir || path.join(os.homedir(), '.kolm', 'onpolicy-runs', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  // W713 - the in-repo GKD trainer's CLI uses --prompts/--teacher/--beta/--lmbda
  // (not the generic --pairs/--max-steps shape the external plugin expects).
  // Build the argv per source so the in-repo default is invoked correctly.
  let args;
  if (t.source === 'in_repo') {
    args = [...t.argv.slice(1),
      '--prompts', pairsPath,
      '--student', studentPath,
      '--teacher', teacher,
      '--out', runDir,
      '--beta', String(beta),
      '--lmbda', String(lmbda),
      '--temperature', String(temperature),
      '--seed', String(seed),
      '--warmup-frac', String(warmupFrac),
      '--max-new-tokens', String(maxNewTokens),
      '--namespace', namespace,
    ];
  } else {
    args = [...t.argv.slice(1),
      '--pairs', pairsPath,
      '--student', studentPath,
      '--out', runDir,
      '--max-steps', String(maxSteps),
      '--namespace', namespace,
      '--tenant', tenant_id,
    ];
    if (teacher) args.push('--teacher', teacher);
  }
  const result = spawnSync(t.argv[0], args, {
    stdio: 'pipe',
    timeout: timeoutMs,
    shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(t.argv[0]),
  });
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      run_dir: runDir,
    };
  }
  // W713 - the in-repo GKD trainer writes run-meta.json (parity with
  // GRPO/preference); external plugins write manifest.json. Read whichever
  // exists so the receipt is captured for both.
  let manifest = null;
  for (const name of ['run-meta.json', 'manifest.json']) {
    const mp = path.join(runDir, name);
    if (fs.existsSync(mp)) {
      try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); break; } catch (_) {} // deliberate: cleanup
    }
  }
  // C4 - surface the REALIZED on-policy fraction the trainer measured from the
  // actual student rollouts inside the JSD loop (manifest.realized_on_policy_
  // fraction.overall), so a caller / receipt chain can assert what truly ran
  // instead of trusting the SCHEDULED lmbda. Null when the (older/external)
  // trainer did not emit it.
  const realizedOnPolicyFraction = (manifest
    && manifest.realized_on_policy_fraction
    && typeof manifest.realized_on_policy_fraction.overall === 'number')
    ? manifest.realized_on_policy_fraction.overall
    : null;
  return {
    ok: true,
    kind: 'distill_onpolicy',
    trainer_source: t.source,
    teacher: t.source === 'in_repo' ? teacher : (teacher || null),
    run_dir: runDir,
    manifest,
    realized_on_policy_fraction: realizedOnPolicyFraction,
    stdout: stdout.slice(-2000),
  };
}

// ===========================================================================
// W921 NEXT-1 - ROPD (Rubric-based On-policy Distillation), BLACK-BOX path.
//
// The shell above (doctor/trainOnPolicy) is the WHITE-BOX on-policy path: it
// needs an external trainer that consumes teacher LOGITS, so it is useless for
// kolm's dominant regime (API teachers, text-only via teacher-bridge.mjs).
//
// ROPD (arXiv:2605.07396) fixes exactly that. It induces prompt-specific
// rubrics from teacher-vs-student TEXT contrasts, scores student rollouts with
// teacher TEXT only (no logits / no tokenizer alignment), and GRPO-optimizes
// the student toward its own best rollouts. The reward is the SAME weighted-
// rubric pass-rate kolm's K-Score uses, so train-eval scoring stays one path.
//
// This surface dispatches the in-repo trainer apps/trainer/ropd.py (additive;
// the white-box shell above is unchanged). Because "teacher text" is ALWAYS
// available for API teachers, ROPD is gated only on the trainer + (real run)
// torch being present - never on logits.
// ===========================================================================

export const ROPD_OBJECTIVE = 'ropd';

const ROPD_INSTALL_HINT = [
  'ROPD (black-box on-policy distillation) needs torch + transformers + peft + trl.',
  '',
  'install: pip install torch transformers peft "trl>=0.12.0"',
  '',
  'the trainer lives at apps/trainer/ropd.py and is invoked as:',
  '  python ropd.py --prompts <jsonl> --student <path> --out <dir>',
  '    --num-rollouts 8 --num-teacher-refs 4',
  '',
  'override with $KOLM_ROPD_TRAINER (absolute path to a compatible script).',
  'no GPU needed for --dry-run / --self-test (the pure rubric/GRPO core is CPU).',
].join('\n');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
}

// resolveRopdTrainer() - the in-repo apps/trainer/ropd.py is the default. An
// explicit $KOLM_ROPD_TRAINER override that points nowhere is "no trainer",
// not a silent fallback. KOLM_ROPD_NO_TRAINER=1 forces the no-tool path (test
// seam, mirrors src/distill-grpo.js).
export function resolveRopdTrainer() {
  if (process.env.KOLM_ROPD_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_ROPD_TRAINER;
  if (envCmd) {
    return fs.existsSync(envCmd) ? { script: envCmd, source: 'env' } : null;
  }
  const inRepo = path.join(_repoRoot, 'apps', 'trainer', 'ropd.py');
  if (fs.existsSync(inRepo)) return { script: inRepo, source: 'in_repo' };
  return null;
}

export function doctorRopd() {
  const t = resolveRopdTrainer();
  let torch_available = false;
  let trl_version = null;
  try {
    const r = spawnSync(_pythonBin(),
      ['-c', 'import torch,trl;print(getattr(trl,"__version__","unknown"))'],
      { stdio: 'pipe', timeout: 30000 });
    if (r.status === 0) {
      trl_version = (r.stdout || '').toString('utf8').trim();
      torch_available = true;
    }
  } catch (_) { /* torch/trl absent - dry-run still works */ }
  return {
    ok: !!t,
    // ready means a REAL GPU run can proceed; --dry-run only needs the trainer.
    ready: !!t && torch_available,
    kind: 'distill_ropd',
    objective: ROPD_OBJECTIVE,
    teacher_regime: 'black_box_text',
    trainer: t ? t.script : null,
    trainer_source: t ? t.source : null,
    torch_available,
    trl_version,
    papers: ['arXiv:2605.07396', 'arXiv:2402.03300', 'arXiv:2306.13649'],
    install_hint: ROPD_INSTALL_HINT,
  };
}

// buildRopdPromptsJsonl(seeds, outPath) - write the ROPD prompts JSONL the
// trainer consumes. Each seed becomes {prompt, teacher_refs:[...]} using
// teacher TEXT (black-box). Accepts seeds shaped as {prompt|input, teacher_refs
// |teacher|response|chosen}. Returns { ok, path, count, with_refs }.
export function buildRopdPromptsJsonl(seeds, outPath) {
  if (!Array.isArray(seeds)) return { ok: false, error: 'seeds_not_array' };
  if (!outPath) return { ok: false, error: 'path_required' };
  const rows = [];
  let withRefs = 0;
  for (const s of seeds) {
    if (!s || typeof s !== 'object') continue;
    const prompt = s.prompt != null ? String(s.prompt)
      : (s.input != null ? String(s.input) : null);
    if (!prompt) continue;
    let refs = null;
    if (Array.isArray(s.teacher_refs)) {
      refs = s.teacher_refs.filter((r) => r != null && String(r).trim()).map(String);
    } else {
      for (const key of ['teacher', 'response', 'chosen', 'output']) {
        if (s[key] != null && String(s[key]).trim()) { refs = [String(s[key])]; break; }
      }
    }
    const row = { prompt };
    if (refs && refs.length) { row.teacher_refs = refs; withRefs += 1; }
    rows.push(row);
  }
  try {
    const dir = path.dirname(outPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath,
      rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: e.message };
  }
  return { ok: true, path: outPath, count: rows.length, with_refs: withRefs };
}

// trainRopd(opts) - durable envelope. Spawns apps/trainer/ropd.py when present;
// returns a clear no_trainer_installed envelope otherwise (still creates the
// run dir). Mirrors src/distill-grpo.js trainGrpo() exactly.
export function trainRopd({
  promptsPath,
  studentPath,
  studentBase = null,
  numRollouts = 8,
  numTeacherRefs = 4,
  rubricMinItems = 4,
  rubricMaxItems = 12,
  learningRate = 1e-6,
  temperature = 1.0,
  maxCompletionLength = 1024,
  difficultyAnchor = true,
  outDir = null,
  namespace = 'default',
  tenant_id = 'local',
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!promptsPath || !fs.existsSync(promptsPath)) {
    return { ok: false, error: 'prompts_missing', detail: `prompts file not found: ${promptsPath}` };
  }
  if (!studentPath) {
    return { ok: false, error: 'student_missing', detail: 'studentPath required' };
  }
  if (!Number.isFinite(numRollouts) || numRollouts < 2) {
    return { ok: false, error: 'bad_num_rollouts', detail: 'numRollouts must be >= 2 (GRPO needs a group)' };
  }

  const runDir = outDir || path.join(os.homedir(), '.kolm', 'ropd-runs',
    `ropd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });

  const t = resolveRopdTrainer();
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'distill_ropd',
      objective: ROPD_OBJECTIVE,
      num_rollouts: numRollouts,
      num_teacher_refs: numTeacherRefs,
      run_dir: runDir,
      trainer_kicked: false,
      error: 'no_trainer_installed',
      install_hint: ROPD_INSTALL_HINT,
    };
  }

  const args = [
    t.script,
    '--prompts', promptsPath,
    '--student', studentPath,
    '--out', runDir,
    '--num-rollouts', String(numRollouts),
    '--num-teacher-refs', String(numTeacherRefs),
    '--rubric-min-items', String(rubricMinItems),
    '--rubric-max-items', String(rubricMaxItems),
    '--learning-rate', String(learningRate),
    '--temperature', String(temperature),
    '--max-completion-length', String(maxCompletionLength),
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
  if (studentBase) args.push('--student-base', studentBase);
  if (!difficultyAnchor) args.push('--no-difficulty-anchor');

  let result;
  try {
    result = spawnSync(_pythonBin(), args, { stdio: 'pipe', timeout: timeoutMs });
  } catch (e) {
    return { ok: false, error: 'trainer_spawn_failed', detail: e.message, run_dir: runDir };
  }
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      objective: ROPD_OBJECTIVE,
      run_dir: runDir,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
    };
  }
  let manifest = null;
  const manifestPath = path.join(runDir, 'run-meta.json');
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { /* tolerate */ }
  }
  return {
    ok: true,
    kind: 'distill_ropd',
    objective: ROPD_OBJECTIVE,
    num_rollouts: numRollouts,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

// ===========================================================================
// W956 - GAD (Generative Adversarial Distillation), BLACK-BOX minimax path.
//
// GAD trains a discriminator over teacher TEXT vs current student rollouts, then
// uses the discriminator's "looks like teacher" score as the on-policy reward.
// The Python trainer owns the minimax/discriminator math and optional Torch
// loop; this JS layer only resolves, builds JSONL, and dispatches.
// ===========================================================================

export const GAD_OBJECTIVE = 'gad';

const GAD_INSTALL_HINT = [
  'GAD (black-box adversarial distillation) needs torch + transformers + peft for real training.',
  '',
  'install: pip install torch transformers peft',
  '',
  'the trainer lives at apps/trainer/gad.py and is invoked as:',
  '  python gad.py --prompts <jsonl> --student <path> --out <dir>',
  '    --num-rollouts 8 --discriminator-steps 16',
  '',
  'override with $KOLM_GAD_TRAINER (absolute path to a compatible script).',
  'no GPU needed for --dry-run / --self-test (the pure discriminator/minimax core is CPU).',
].join('\n');

export function resolveGadTrainer() {
  if (process.env.KOLM_GAD_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_GAD_TRAINER;
  if (envCmd) return fs.existsSync(envCmd) ? { script: envCmd, source: 'env' } : null;
  const inRepo = path.join(_repoRoot, 'apps', 'trainer', 'gad.py');
  if (fs.existsSync(inRepo)) return { script: inRepo, source: 'in_repo' };
  return null;
}

export function doctorGad() {
  const t = resolveGadTrainer();
  let torch_available = false;
  let transformers_version = null;
  try {
    const r = spawnSync(_pythonBin(),
      ['-c', 'import torch,transformers,peft;print(getattr(transformers,"__version__","unknown"))'],
      { stdio: 'pipe', timeout: 30000 });
    if (r.status === 0) {
      transformers_version = (r.stdout || '').toString('utf8').trim();
      torch_available = true;
    }
  } catch (_) { /* torch stack absent - dry-run still works */ }
  return {
    ok: !!t,
    ready: !!t && torch_available,
    kind: 'distill_gad',
    objective: GAD_OBJECTIVE,
    teacher_regime: 'black_box_text',
    algorithm: 'minimax_discriminator_reward',
    trainer: t ? t.script : null,
    trainer_source: t ? t.source : null,
    torch_available,
    transformers_version,
    papers: ['arXiv:2511.10643', 'arXiv:2402.03300'],
    install_hint: GAD_INSTALL_HINT,
  };
}

export function buildGadPromptsJsonl(seeds, outPath) {
  if (!Array.isArray(seeds)) return { ok: false, error: 'seeds_not_array' };
  if (!outPath) return { ok: false, error: 'path_required' };
  const rows = [];
  let withRefs = 0;
  let withRollouts = 0;
  for (const s of seeds) {
    if (!s || typeof s !== 'object') continue;
    const prompt = s.prompt != null ? String(s.prompt)
      : (s.input != null ? String(s.input) : null);
    if (!prompt) continue;
    let refs = null;
    if (Array.isArray(s.teacher_refs)) {
      refs = s.teacher_refs.filter((r) => r != null && String(r).trim()).map(String);
    } else {
      for (const key of ['teacher', 'response', 'chosen', 'output']) {
        if (s[key] != null && String(s[key]).trim()) { refs = [String(s[key])]; break; }
      }
    }
    let rollouts = null;
    if (Array.isArray(s.student_rollouts)) {
      rollouts = s.student_rollouts.filter((r) => r != null && String(r).trim()).map(String);
    } else if (Array.isArray(s.candidates)) {
      rollouts = s.candidates.map((c) => (typeof c === 'string' ? c : (c && (c.text || c.response || c.completion))))
        .filter((r) => r != null && String(r).trim()).map(String);
    }
    const row = { prompt };
    if (refs && refs.length) { row.teacher_refs = refs; withRefs += 1; }
    if (rollouts && rollouts.length) { row.student_rollouts = rollouts; withRollouts += 1; }
    rows.push(row);
  }
  try {
    const dir = path.dirname(outPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath,
      rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: e.message };
  }
  return { ok: true, path: outPath, count: rows.length, with_refs: withRefs, with_rollouts: withRollouts };
}

export function trainGad({
  promptsPath,
  studentPath,
  studentBase = null,
  numRollouts = 8,
  numTeacherRefs = 4,
  discriminatorSteps = 16,
  discriminatorLr = 0.35,
  learningRate = 1e-6,
  rewardTemperature = 1.0,
  collapsePenalty = 0.15,
  temperature = 1.0,
  maxCompletionLength = 1024,
  maxSteps = 32,
  outDir = null,
  namespace = 'default',
  tenant_id = 'local',
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!promptsPath || !fs.existsSync(promptsPath)) {
    return { ok: false, error: 'prompts_missing', detail: `prompts file not found: ${promptsPath}` };
  }
  if (!studentPath) {
    return { ok: false, error: 'student_missing', detail: 'studentPath required' };
  }
  if (!Number.isFinite(numRollouts) || numRollouts < 2) {
    return { ok: false, error: 'bad_num_rollouts', detail: 'numRollouts must be >= 2 (GRPO needs a group)' };
  }
  if (!Number.isFinite(discriminatorSteps) || discriminatorSteps < 1) {
    return { ok: false, error: 'bad_discriminator_steps', detail: 'discriminatorSteps must be >= 1' };
  }

  const runDir = outDir || path.join(os.homedir(), '.kolm', 'gad-runs',
    `gad_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });

  const t = resolveGadTrainer();
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'distill_gad',
      objective: GAD_OBJECTIVE,
      num_rollouts: numRollouts,
      num_teacher_refs: numTeacherRefs,
      discriminator_steps: discriminatorSteps,
      run_dir: runDir,
      trainer_kicked: false,
      error: 'no_trainer_installed',
      install_hint: GAD_INSTALL_HINT,
    };
  }

  const args = [
    t.script,
    '--prompts', promptsPath,
    '--student', studentPath,
    '--out', runDir,
    '--num-rollouts', String(numRollouts),
    '--num-teacher-refs', String(numTeacherRefs),
    '--discriminator-steps', String(discriminatorSteps),
    '--discriminator-lr', String(discriminatorLr),
    '--learning-rate', String(learningRate),
    '--reward-temperature', String(rewardTemperature),
    '--collapse-penalty', String(collapsePenalty),
    '--temperature', String(temperature),
    '--max-completion-length', String(maxCompletionLength),
    '--max-steps', String(maxSteps),
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
  if (studentBase) args.push('--student-base', studentBase);

  let result;
  try {
    result = spawnSync(_pythonBin(), args, { stdio: 'pipe', timeout: timeoutMs });
  } catch (e) {
    return { ok: false, error: 'trainer_spawn_failed', detail: e.message, run_dir: runDir };
  }
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');
  if (result.status !== 0) {
    return {
      ok: false,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      exit_code: result.status,
      objective: GAD_OBJECTIVE,
      run_dir: runDir,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
    };
  }
  let manifest = null;
  const manifestPath = path.join(runDir, 'run-meta.json');
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) { /* tolerate */ }
  }
  return {
    ok: true,
    kind: 'distill_gad',
    objective: GAD_OBJECTIVE,
    num_rollouts: numRollouts,
    num_teacher_refs: numTeacherRefs,
    discriminator_steps: discriminatorSteps,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export default {
  doctor,
  trainOnPolicy,
  INSTALL_HINT,
  // W921 ROPD black-box on-policy surface (additive).
  ROPD_OBJECTIVE,
  resolveRopdTrainer,
  doctorRopd,
  buildRopdPromptsJsonl,
  trainRopd,
  // W956 GAD black-box minimax surface (additive).
  GAD_OBJECTIVE,
  resolveGadTrainer,
  doctorGad,
  buildGadPromptsJsonl,
  trainGad,
};
