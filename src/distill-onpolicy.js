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

function resolveTrainer() {
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
    trainer: t.argv[0],
    trainer_source: t.source,
  };
}

export function trainOnPolicy({
  pairsPath,
  studentPath,
  outDir = null,
  tenant_id = 'local',
  namespace = 'default',
  maxSteps = 100,
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
  const runDir = outDir || path.join(os.homedir(), '.kolm', 'onpolicy-runs', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [...t.argv.slice(1),
    '--pairs', pairsPath,
    '--student', studentPath,
    '--out', runDir,
    '--max-steps', String(maxSteps),
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
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
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {} // deliberate: cleanup
  }
  return {
    ok: true,
    kind: 'distill_onpolicy',
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

// ===========================================================================
// W921 NEXT-1 — ROPD (Rubric-based On-policy Distillation), BLACK-BOX path.
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
// torch being present — never on logits.
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

// resolveRopdTrainer() — the in-repo apps/trainer/ropd.py is the default. An
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
  } catch (_) { /* torch/trl absent — dry-run still works */ }
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

// buildRopdPromptsJsonl(seeds, outPath) — write the ROPD prompts JSONL the
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

// trainRopd(opts) — durable envelope. Spawns apps/trainer/ropd.py when present;
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
};
