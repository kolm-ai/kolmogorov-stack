// W958 - MoE-to-dense structural collapse orchestration.
//
// Node owns validation, trainer resolution, and durable envelopes. Python owns
// the tensor operation: DO-ACP-style expert scoring plus dense FFN concat.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

export const MOE_TO_DENSE_VERSION = 'w958-moe-to-dense-v1';

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

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
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

export default {
  MOE_TO_DENSE_VERSION,
  resolveMoeToDenseTrainer,
  doctorMoeToDense,
  runMoeToDense,
};
