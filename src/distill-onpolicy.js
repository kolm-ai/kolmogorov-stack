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
  const envCmd = process.env.KOLM_ONPOLICY_TRAINER;
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
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (_) {}
  }
  return {
    ok: true,
    kind: 'distill_onpolicy',
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export default { doctor, trainOnPolicy, INSTALL_HINT };
