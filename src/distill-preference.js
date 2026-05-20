// W480 - preference distillation orchestration shell.
//
// Distills RLHF-style preferences without an explicit reward model.
// Supports DPO (Rafailov et al., 2023), SimPO (Meng et al., 2024),
// ORPO (Hong et al., 2024), and KTO (Ethayarajh et al., 2024) as
// different objectives over the same {chosen, rejected} pair format.
//
// This module is a thin Node orchestration shell. The actual gradient
// computation runs in an external trainer (huggingface trl, unsloth,
// or a custom recipe) exposed via $KOLM_PREFERENCE_TRAINER. When the
// trainer is absent we return an honest no_trainer_installed envelope.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

export const OBJECTIVES = ['dpo', 'simpo', 'orpo', 'kto'];

const INSTALL_HINT = [
  'preference distillation requires an external trainer.',
  '',
  'set $KOLM_PREFERENCE_TRAINER to the absolute path of a script that accepts:',
  '  --pairs <jsonl>    {prompt, chosen, rejected} rows (or {prompt, response, label} for KTO)',
  '  --student <path>   path to the student adapter root',
  '  --objective <name> dpo | simpo | orpo | kto',
  '  --out <dir>        where to write updated adapter + manifest',
  '',
  'reference implementations:',
  '  - huggingface/trl (DPOTrainer, KTOTrainer)',
  '  - unsloth DPO recipe (docs.unsloth.ai)',
  '  - princeton-nlp/simpo',
].join('\n');

function whichSync(name) {
  if (!name) return null;
  if (name.includes('/') || name.includes('\\')) {
    try { if (fs.existsSync(name) && fs.statSync(name).isFile()) return name; } catch (_) {}
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
      try { if (fs.existsSync(full) && fs.statSync(full).isFile()) return full; } catch (_) {}
    }
  }
  return null;
}

function resolveTrainer() {
  const envCmd = process.env.KOLM_PREFERENCE_TRAINER;
  if (envCmd) {
    try {
      const parsed = JSON.parse(envCmd);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const head = whichSync(parsed[0]);
        if (head) return { argv: [head, ...parsed.slice(1)], source: 'env-array' };
      }
    } catch (_) {}
    const resolved = whichSync(envCmd);
    if (resolved) return { argv: [resolved], source: 'env' };
    return null;
  }
  for (const name of ['kolm-preference-distill', 'preference-distill']) {
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
      kind: 'distill_preference',
      objectives: OBJECTIVES,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  return {
    ok: true,
    ready: true,
    kind: 'distill_preference',
    objectives: OBJECTIVES,
    trainer: t.argv[0],
    trainer_source: t.source,
  };
}

export function trainPreference({
  pairsPath,
  studentPath,
  objective = 'dpo',
  outDir = null,
  tenant_id = 'local',
  namespace = 'default',
  beta = 0.1,
  timeoutMs = 30 * 60 * 1000,
} = {}) {
  if (!OBJECTIVES.includes(objective)) {
    return { ok: false, error: 'unknown_objective', detail: `objective must be one of ${OBJECTIVES.join('|')}` };
  }
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
      kind: 'distill_preference',
      objective,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  const runDir = outDir || path.join(os.homedir(), '.kolm', 'preference-runs', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [...t.argv.slice(1),
    '--pairs', pairsPath,
    '--student', studentPath,
    '--objective', objective,
    '--beta', String(beta),
    '--out', runDir,
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
      objective,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      run_dir: runDir,
    };
  }
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  }
  return {
    ok: true,
    kind: 'distill_preference',
    objective,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export default { doctor, trainPreference, OBJECTIVES, INSTALL_HINT };
