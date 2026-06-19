// W480 - speculative decoding draft-pair orchestration shell.
//
// Trains an EAGLE-style draft head (or Medusa head pack) alongside a
// student artifact so inference can use parallel verification for a
// 2-6x throughput win at no accuracy loss. The objective is KL between
// the target LM's next-token distribution and the draft's prediction
// on the SAME teacher outputs used by the main distillation pass.
//
// This module is a thin Node orchestration shell. The actual draft-head
// training runs in an external trainer exposed via $KOLM_SPECDECODE_TRAINER.
// When the trainer is absent we return an honest no_trainer_installed
// envelope. The artifact written next to the student carries a
// spec_decode_pair_hash so verifyArtifact can bind the pair into the
// receipt chain.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pythonBin } from './python-runtime.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

function _pythonBin() {
  return pythonBin();
}

export const DRAFT_KINDS = ['eagle', 'eagle2', 'eagle3', 'medusa'];

const INSTALL_HINT = [
  'speculative-decoding pair training requires an external trainer.',
  '',
  'set $KOLM_SPECDECODE_TRAINER to the absolute path of a script that accepts:',
  '  --pairs <jsonl>    teacher outputs used for the main distill pass',
  '  --base <path>      target LM the draft will accelerate',
  '  --draft-kind <k>   eagle | eagle2 | eagle3 | medusa',
  '  --out <dir>        where to write draft head + manifest',
  '',
  'reference implementations:',
  '  - SafeAILab/EAGLE (github.com, paper arXiv:2401.15077)',
  '  - FasterDecoding/Medusa',
  '  - vllm-project/vllm spec-decode docs',
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

// W713/W957 - resolve the speculative-decoding draft-head trainer. The canonical
// in-repo trainer is apps/trainer/eagle3_train.py: EAGLE-3 multi-layer feature
// head training in Python, delegating non-eagle3 kinds to the older worker for
// compatibility. Resolution order:
//   1. KOLM_SPECDECODE_NO_TRAINER=1 forces the durable no-tool path (test seam,
//      mirrors src/distill-grpo.js's KOLM_GRPO_NO_TRAINER).
//   2. $KOLM_SPECDECODE_TRAINER override (JSON array or PATH name) - an
//      override that points nowhere is "no trainer", not a silent fallback.
//   3. A `kolm-spec-decode-train` / `spec-decode-train` on PATH.
//   4. The in-repo EAGLE-3 trainer.
//   5. The legacy train_specdecode.py worker fallback.
function resolveTrainer() {
  if (process.env.KOLM_SPECDECODE_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_SPECDECODE_TRAINER;
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
  for (const name of ['kolm-spec-decode-train', 'spec-decode-train']) {
    const r = whichSync(name);
    if (r) return { argv: [r], source: 'path' };
  }
  // In-repo trainer (mirrors distill-grpo.js in_repo fallback).
  const eagle3 = path.join(_repoRoot, 'apps', 'trainer', 'eagle3_train.py');
  if (fs.existsSync(eagle3)) return { argv: [_pythonBin(), eagle3], source: 'in_repo' };
  const legacy = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'train_specdecode.py');
  if (fs.existsSync(legacy)) return { argv: [_pythonBin(), legacy], source: 'in_repo' };
  return null;
}

export function doctor() {
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      ready: false,
      kind: 'spec_decode',
      draft_kinds: DRAFT_KINDS,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  return {
    ok: true,
    ready: true,
    kind: 'spec_decode',
    draft_kinds: DRAFT_KINDS,
    // For the in_repo path argv is [python, script]; surface the script.
    trainer: t.source === 'in_repo' && t.argv.length > 1 ? t.argv[1] : t.argv[0],
    trainer_source: t.source,
  };
}

export function trainSpecDecode({
  pairsPath,
  basePath,
  draftKind = 'eagle3',
  draftModel = null,        // W713 - explicit EAGLE draft model; auto-picked when null
  medusaHeads = 4,
  outDir = null,
  tenant_id = 'local',
  namespace = 'default',
  timeoutMs = 60 * 60 * 1000,
} = {}) {
  if (!DRAFT_KINDS.includes(draftKind)) {
    return { ok: false, error: 'unknown_draft_kind', detail: `draftKind must be one of ${DRAFT_KINDS.join('|')}` };
  }
  if (!pairsPath || !fs.existsSync(pairsPath)) {
    return { ok: false, error: 'pairs_missing', detail: `pairs file not found: ${pairsPath}` };
  }
  if (!basePath) {
    return { ok: false, error: 'base_missing', detail: 'basePath required' };
  }
  const t = resolveTrainer();
  if (!t) {
    return {
      ok: false,
      deferred: true,
      kind: 'spec_decode',
      draft_kind: draftKind,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
    };
  }
  const runDir = outDir || path.join(os.homedir(), '.kolm', 'spec-decode-runs', `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });
  const args = [...t.argv.slice(1),
    '--pairs', pairsPath,
    '--base', basePath,
    '--draft-kind', draftKind,
    '--out', runDir,
    '--namespace', namespace,
    '--tenant', tenant_id,
  ];
  // W713 - thread the in-repo trainer's extra knobs (the external plugin keeps
  // the generic shape above). draft-model auto-picks from DRAFT_PAIRINGS when
  // omitted; medusa-heads sizes the Medusa head pack.
  if (t.source === 'in_repo') {
    if (draftModel) args.push('--draft-model', String(draftModel));
    if (Number.isFinite(medusaHeads)) args.push('--medusa-heads', String(medusaHeads));
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
      draft_kind: draftKind,
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      run_dir: runDir,
    };
  }
  // W713 - the in-repo trainer writes run-meta.json (parity with the other
  // trainers); external plugins write manifest.json. Read whichever exists.
  let manifest = null;
  for (const name of ['run-meta.json', 'manifest.json']) {
    const mp = path.join(runDir, name);
    if (fs.existsSync(mp)) {
      try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); break; } catch (_) {} // deliberate: cleanup
    }
  }
  return {
    ok: true,
    kind: 'spec_decode',
    draft_kind: draftKind,
    trainer_source: t.source,
    run_dir: runDir,
    manifest,
    stdout: stdout.slice(-2000),
  };
}

export { resolveTrainer };
export default { doctor, trainSpecDecode, resolveTrainer, DRAFT_KINDS, INSTALL_HINT };
