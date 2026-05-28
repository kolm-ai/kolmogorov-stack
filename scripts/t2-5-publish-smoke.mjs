#!/usr/bin/env node
// scripts/t2-5-publish-smoke.mjs
//
// T2.5 smoke test — workers/distill/scripts/publish.py. Pure orchestration:
// NO network, NO GPU, NO gguf tooling required. Verifies the dry-run contract
// + the opt-in safety preflights.
//
//   1. dry-run produces a README + Modelfile locally, summary envelope is well
//      formed (ok, dry_run, hf.pushed===false, manifest/eval present)
//   2. the README written by writeModelCard exists on disk + has HF frontmatter
//   3. the Modelfile exists on disk
//   4. --hf user/x --publish WITHOUT HF_TOKEN -> exit 2 (preflight)
//   5. a missing --adapter dir -> exit 3
//   6. gguf is empty in a dry run with no weights dir + gguf_status is reported
//      (never hard-fails the run)
//
// Runner: `node scripts/t2-5-publish-smoke.mjs`. Honors KOLM_PYTHON, falling
// back to python3 then python. SKIPs (exit 0) if no python3 is on PATH.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'workers', 'distill', 'scripts', 'publish.py');

let pass = 0, fail = 0;
function ok(label) { pass++; console.log(`  ok   ${label}`); }
function bad(label, detail) { fail++; console.log(`  FAIL ${label}: ${detail}`); }
function assert(cond, label, detail = '') { if (cond) ok(label); else bad(label, detail || 'condition false'); }

function findPython() {
  const cands = [];
  if (process.env.KOLM_PYTHON) cands.push(process.env.KOLM_PYTHON);
  cands.push('python3', 'python');
  for (const cand of cands) {
    try {
      const r = spawnSync(cand, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf-8' });
      if (r.status === 0 && (r.stdout || '').trim() === '3') return cand;
    } catch { /* try next */ }
  }
  return null;
}
const PY = findPython();
if (!PY) { console.log('T2.5 SKIP (no python3 in PATH)'); process.exit(0); }

console.log('T2.5 — adapter -> publish smoke (dry-run, no network/GPU)');

// runPublish: spawn publish.py, return {status, summary, stdout, stderr}. The
// summary is the LAST non-empty stdout line (machine-readable JSON contract).
// `env` overrides are applied on top of a copy of process.env.
function runPublish(extraArgs, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
  }
  const r = spawnSync(PY, [SCRIPT, ...extraArgs], { encoding: 'utf8', env });
  const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
  let summary = null;
  try { summary = JSON.parse(lines[lines.length - 1]); } catch { /* leave null */ }
  return { status: r.status, summary, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-t2-5-'));

// --- Build a fake trained-adapter dir ---------------------------------------
const adapter = path.join(tmp, 'adapter');
fs.mkdirSync(adapter, { recursive: true });

// training-summary.json — nested shape per train_lora.py manifest contract.
const manifest = {
  student_base: 'Qwen/Qwen2.5-7B-Instruct',
  lora_rank: 16,
  lora_alpha: 32,
  epochs: 3,
  batch_size: 1,
  lr: 2e-4,
  pairs: 410,
  system_prompt: 'You are a careful customer-support agent.',
  reproducibility: {
    git_sha: 'abc1234',
    recipe_hash: 'rh_deadbeef',
    recipe_name: 'trinity-500',
    scrubber_version: 'sv1',
    pairs_hash: 'ph_cafe',
    kolm_version: '1.0.0',
    trained_at: '2026-05-29T00:00:00Z',
  },
  efficiency: { precision: 'bf16' },
  backend: { selected: 'unsloth' },
};
fs.writeFileSync(path.join(adapter, 'training-summary.json'), JSON.stringify(manifest, null, 2));

// eval-mixeval-hard.json — eval numbers contract.
const evalSummary = {
  mean_score: 0.72,
  arena_correlation_estimate: 0.96,
  cot_contaminated: 0,
  questions_scored: 57,
};
fs.writeFileSync(path.join(adapter, 'eval-mixeval-hard.json'), JSON.stringify(evalSummary, null, 2));

// minimal passport.json — kolm.passport/1 fields hf-modelcard.js reads.
const passport = {
  schema: 'kolm.passport/1',
  id: 'trinity-500',
  student_base: 'Qwen/Qwen2.5-7B-Instruct',
  license: 'apache-2.0',
  language: 'en',
  tags: ['kolm', 'distilled'],
  datasets: ['kolm/trinity-500-seeds'],
  recipe: { lora_rank: 16, lora_alpha: 32, epochs: 3, batch_size: 1, lr: 2e-4, precision: 'bf16' },
  dataset: { seeds_total: 500, pairs_collected: 410, yield_pct: 82 },
};
fs.writeFileSync(path.join(adapter, 'passport.json'), JSON.stringify(passport, null, 2));

// --- 1 + 2 + 3 + 6. dry-run (HF_TOKEN explicitly unset) ---------------------
const r1 = runPublish(['--adapter', adapter, '--dry-run'], { HF_TOKEN: undefined, HUGGING_FACE_HUB_TOKEN: undefined });
const s = r1.summary;
assert(r1.status === 0, '1: dry-run exits 0', `status=${r1.status} stderr=${r1.stderr.slice(-300)}`);
assert(s && s.ok === true, '1: summary ok===true', JSON.stringify(s));
assert(s && s.dry_run === true, '1: dry_run===true', JSON.stringify(s && s.dry_run));
assert(s && s.version === 't2.5-v1', '1: version stamp t2.5-v1', JSON.stringify(s && s.version));
assert(s && s.hf && s.hf.pushed === false, '1: hf.pushed===false in dry run', JSON.stringify(s && s.hf));
assert(s && s.manifest_present === true, '1: manifest_present===true', JSON.stringify(s && s.manifest_present));
assert(s && s.eval_present === true, '1: eval_present===true', JSON.stringify(s && s.eval_present));

const readmePath = s && s.readme_path;
assert(readmePath && fs.existsSync(readmePath), '2: README written + exists on disk', `readme_path=${readmePath}`);
if (readmePath && fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, 'utf8');
  assert(/^---[\s\S]*license:[\s\S]*tags:[\s\S]*---/m.test(readme),
    '2: README has HF frontmatter (license + tags)', readme.slice(0, 120));
}

const modelfilePath = s && s.modelfile_path;
assert(modelfilePath && fs.existsSync(modelfilePath), '3: Modelfile written + exists on disk', `modelfile_path=${modelfilePath}`);

assert(s && Array.isArray(s.gguf) && s.gguf.length === 0,
  '6: gguf empty when no tooling/weights (no hard fail)', JSON.stringify(s && s.gguf));
assert(s && typeof s.gguf_status === 'string' && s.gguf_status.length > 0,
  '6: gguf_status reported', JSON.stringify(s && s.gguf_status));

// --- 4. --hf user/x --publish WITHOUT HF_TOKEN -> exit 2 (preflight) --------
const r4 = runPublish(['--adapter', adapter, '--hf', 'user/x', '--publish'],
  { HF_TOKEN: undefined, HUGGING_FACE_HUB_TOKEN: undefined });
assert(r4.status === 2, '4: --publish without HF_TOKEN -> exit 2', `status=${r4.status} stderr=${r4.stderr.slice(-300)}`);
assert(r4.summary && r4.summary.ok === false, '4: preflight summary ok===false', JSON.stringify(r4.summary));
assert(/HF_TOKEN/.test(r4.summary && r4.summary.reason || ''),
  '4: preflight reason names HF_TOKEN', JSON.stringify(r4.summary && r4.summary.reason));

// --- 5. missing --adapter dir -> exit 3 -------------------------------------
const r5 = runPublish(['--adapter', path.join(tmp, 'does-not-exist'), '--dry-run']);
assert(r5.status === 3, '5: missing --adapter dir -> exit 3', `status=${r5.status} stderr=${r5.stderr.slice(-300)}`);
assert(r5.summary && r5.summary.ok === false, '5: missing-input summary ok===false', JSON.stringify(r5.summary));

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
