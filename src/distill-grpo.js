// src/distill-grpo.js
//
// W921 - GRPO / RLVR (verifiable-reward reinforcement fine-tuning) orchestration
// shell. Mirrors src/distill-onpolicy.js + src/distill-preference.js: a thin
// Node shell that spawns the in-repo trainer (workers/distill/scripts/
// train_grpo.py, which wraps apps.trainer.grpo.grpo_trainer + the verifiable
// reward families), or an external $KOLM_GRPO_TRAINER override, and returns a
// durable envelope (honest no-tool envelope when trl/torch are absent).
//
// GRPO (Shao et al. arXiv:2402.03300, DeepSeek-MATH; popularized by DeepSeek R1
// arXiv:2501.12948) samples G completions per prompt, scores each with a
// VERIFIABLE reward (code-exec unit tests / math equivalence / JSON-schema /
// regex / the K-score verifier itself), and the advantage is the per-completion
// score minus the group mean over the group std. No value head, no critic.
//
// The value for kolm: the reward function is the SAME code path as the K-score
// evaluator - train-eval mismatch becomes a hard error, not a culture.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

export const REWARD_FAMILIES = ['code_exec', 'math_checker', 'schema_validator', 'format', 'kolm_verifier'];
export const LOSS_TYPES = ['grpo', 'bnpo', 'dr_grpo'];

const INSTALL_HINT = [
  'GRPO / RLVR requires trl (>=0.12.0) + torch + transformers + peft.',
  '',
  'install: pip install "trl>=0.12.0" torch transformers peft jsonschema',
  '',
  'the trainer lives at workers/distill/scripts/train_grpo.py and is invoked as:',
  '  python train_grpo.py --prompts <jsonl> --student <path> --out <dir>',
  '    --reward code_exec --num-generations 8 --loss-type grpo',
  '',
  'override with $KOLM_GRPO_TRAINER (absolute path to a compatible script).',
].join('\n');

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

export function resolveTrainer() {
  // Opt-out seam: KOLM_GRPO_NO_TRAINER=1 forces the durable no-tool path.
  if (process.env.KOLM_GRPO_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_GRPO_TRAINER;
  if (envCmd) {
    // An explicit override that points nowhere is no-trainer, not a silent
    // fallback to in-repo.
    return fs.existsSync(envCmd) ? { script: envCmd, source: 'env' } : null;
  }
  const inRepo = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_grpo.py');
  if (fs.existsSync(inRepo)) return { script: inRepo, source: 'in_repo' };
  return null;
}

export function doctor() {
  const t = resolveTrainer();
  let trl_version = null;
  let ready = false;
  try {
    const r = spawnSync(_pythonBin(), ['-c', 'import trl; print(getattr(trl,"__version__","unknown"))'], { stdio: 'pipe', timeout: 30000 });
    if (r.status === 0) {
      trl_version = (r.stdout || '').toString('utf8').trim();
      ready = !!t;
    }
  } catch (_) { /* trl absent */ }
  return {
    ok: !!t,
    ready,
    kind: 'distill_grpo',
    reward_families: REWARD_FAMILIES,
    loss_types: LOSS_TYPES,
    trl_version,
    trainer: t ? t.script : null,
    trainer_source: t ? t.source : null,
    install_hint: INSTALL_HINT,
  };
}

// buildPromptsJsonl(seeds, rewardSpec) - write the prompts JSONL trl forwards to
// the reward funcs. Each seed becomes {prompt, references|schemas|regexes|tests}
// columns depending on the reward family. Returns { ok, path, count }.
export function buildPromptsJsonl(seeds, rewardSpec, outPath) {
  if (!Array.isArray(seeds)) return { ok: false, error: 'seeds_not_array' };
  if (!outPath) return { ok: false, error: 'path_required' };
  const family = (rewardSpec && rewardSpec.family) || 'code_exec';
  const rows = [];
  for (const s of seeds) {
    if (!s || typeof s !== 'object') continue;
    const prompt = s.prompt != null ? String(s.prompt) : (s.input != null ? String(s.input) : null);
    if (!prompt) continue;
    const row = { prompt };
    // Carry the per-prompt verifiable column the reward function needs.
    if (family === 'code_exec' && s.tests != null) row.tests = s.tests;
    else if (family === 'math_checker' && s.reference != null) row.references = s.reference;
    else if (family === 'schema_validator') {
      if (s.schema != null) row.schemas = s.schema;
      else if (s.regex != null) row.regexes = s.regex;
    }
    rows.push(row);
  }
  try {
    const dir = path.dirname(outPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  } catch (e) {
    return { ok: false, error: 'write_failed', detail: e.message };
  }
  return { ok: true, path: outPath, count: rows.length, family };
}

// trainGrpo(opts) - durable envelope. Spawns the trainer when present; returns
// an honest no_trainer_installed envelope otherwise (still writes the run dir).
export function trainGrpo({
  promptsPath,
  studentPath,
  rewardFunctions = ['code_exec'],
  numGenerations = 8,
  lossType = 'grpo',
  sftWarmupAdapter = null,
  maxCompletionLength = 512,
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
  const rewards = Array.isArray(rewardFunctions) ? rewardFunctions : [rewardFunctions];
  for (const r of rewards) {
    if (!REWARD_FAMILIES.includes(r)) {
      return { ok: false, error: 'unknown_reward', detail: `reward must be one of ${REWARD_FAMILIES.join('|')}; got ${r}` };
    }
  }
  if (!LOSS_TYPES.includes(lossType)) {
    return { ok: false, error: 'unknown_loss_type', detail: `loss_type must be one of ${LOSS_TYPES.join('|')}` };
  }

  const runDir = outDir || path.join(os.homedir(), '.kolm', 'grpo-runs', `grpo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });

  const t = resolveTrainer();
  if (!t) {
    return {
      ok: true,
      deferred: true,
      kind: 'distill_grpo',
      reward_functions: rewards,
      loss_type: lossType,
      num_generations: numGenerations,
      run_dir: runDir,
      trainer_kicked: false,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }

  const args = [
    t.script,
    '--prompts', promptsPath,
    '--student', studentPath,
    '--out', runDir,
    '--reward', rewards.join(','),
    '--num-generations', String(numGenerations),
    '--loss-type', lossType,
    '--max-completion-length', String(maxCompletionLength),
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
  if (sftWarmupAdapter) args.push('--sft-warmup-adapter', sftWarmupAdapter);

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
      reward_functions: rewards,
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
    kind: 'distill_grpo',
    reward_functions: rewards,
    loss_type: lossType,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export default {
  REWARD_FAMILIES,
  LOSS_TYPES,
  doctor,
  resolveTrainer,
  buildPromptsJsonl,
  trainGrpo,
};
