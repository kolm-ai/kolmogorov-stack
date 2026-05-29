// W921 NEXT-1 — ROPD (Rubric-based On-policy Distillation) black-box on-policy
// KD. Tests the JS dispatcher in src/distill-onpolicy.js (prompt-build + doctor
// envelope + trainRopd deferral/validation) and the recipe. GPU-free: the real
// trl/torch GRPO run is listed under needs_gpu_run, but the pure ROPD core is
// exercised via the python --self-test / --dry-run paths (no GPU, no network).
//
// Caveat: these tests assert SHAPE + dispatch wiring, not training quality.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ROPD_OBJECTIVE,
  resolveRopdTrainer,
  doctorRopd,
  buildRopdPromptsJsonl,
  trainRopd,
} from '../src/distill-onpolicy.js';
import { loadRecipe, listRecipes } from '../src/distill-recipe-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const ROPD_PY = path.join(REPO, 'apps', 'trainer', 'ropd.py');

function _tmp(name) {
  return path.join(os.tmpdir(), `kolm-w921-ropd-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}
function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

test('1. ROPD objective constant + in-repo trainer resolves to apps/trainer/ropd.py', () => {
  assert.equal(ROPD_OBJECTIVE, 'ropd');
  assert.ok(fs.existsSync(ROPD_PY), `missing trainer at ${ROPD_PY}`);
  delete process.env.KOLM_ROPD_TRAINER;
  delete process.env.KOLM_ROPD_NO_TRAINER;
  const t = resolveRopdTrainer();
  assert.ok(t, 'in-repo trainer must resolve');
  assert.equal(t.source, 'in_repo');
  assert.equal(path.resolve(t.script), path.resolve(ROPD_PY));
});

test('2. KOLM_ROPD_NO_TRAINER=1 forces the no-tool path', () => {
  process.env.KOLM_ROPD_NO_TRAINER = '1';
  assert.equal(resolveRopdTrainer(), null);
  delete process.env.KOLM_ROPD_NO_TRAINER;
});

test('3. explicit $KOLM_ROPD_TRAINER pointing nowhere is no-trainer (not a silent fallback)', () => {
  process.env.KOLM_ROPD_TRAINER = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.py');
  assert.equal(resolveRopdTrainer(), null);
  delete process.env.KOLM_ROPD_TRAINER;
});

test('4. doctorRopd envelope: black-box regime, names the trainer + paper, install hint', () => {
  delete process.env.KOLM_ROPD_TRAINER;
  delete process.env.KOLM_ROPD_NO_TRAINER;
  const d = doctorRopd();
  assert.equal(d.kind, 'distill_ropd');
  assert.equal(d.objective, 'ropd');
  assert.equal(d.teacher_regime, 'black_box_text');
  assert.equal(d.ok, true); // in-repo trainer present
  assert.ok(d.papers.includes('arXiv:2605.07396'), 'must cite the ROPD paper');
  assert.match(d.install_hint, /\$KOLM_ROPD_TRAINER/);
  assert.match(d.install_hint, /apps\/trainer\/ropd\.py/);
  // `ready` is gated on torch+trl; we only assert the field exists + is boolean.
  assert.equal(typeof d.ready, 'boolean');
  assert.equal(typeof d.torch_available, 'boolean');
});

test('5. doctorRopd ok:false when no trainer available', () => {
  process.env.KOLM_ROPD_NO_TRAINER = '1';
  const d = doctorRopd();
  assert.equal(d.ok, false);
  assert.equal(d.ready, false);
  assert.equal(d.trainer, null);
  delete process.env.KOLM_ROPD_NO_TRAINER;
});

test('6. buildRopdPromptsJsonl coerces teacher TEXT into teacher_refs (black-box)', () => {
  const out = _tmp('prompts') + '.jsonl';
  const r = buildRopdPromptsJsonl([
    { prompt: 'reset password?', teacher_refs: ['Settings > Security > Reset.', 'Open Settings, reset.'] },
    { input: 'refund window?', teacher: 'Our refund window is 30 days.' },   // input + teacher
    { prompt: 'shipping?', response: 'Ships in 2 days.' },                    // response fallback
    { prompt: 'chosen-form', chosen: 'the chosen answer' },                   // chosen fallback
    { prompt: 'no-refs-prompt' },                                            // prompt, no refs
    { teacher: 'orphan ref, no prompt' },                                    // skipped (no prompt)
    'not-an-object',                                                         // skipped
  ], out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 5, 'five rows have a prompt');
  assert.equal(r.with_refs, 4, 'four of them carry teacher refs');
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].teacher_refs, ['Settings > Security > Reset.', 'Open Settings, reset.']);
  assert.equal(lines[1].prompt, 'refund window?');
  assert.deepEqual(lines[1].teacher_refs, ['Our refund window is 30 days.']);
  assert.deepEqual(lines[2].teacher_refs, ['Ships in 2 days.']);
  assert.deepEqual(lines[3].teacher_refs, ['the chosen answer']);
  assert.equal('teacher_refs' in lines[4], false, 'no-refs row carries no teacher_refs key');
  fs.rmSync(out, { force: true });
});

test('7. buildRopdPromptsJsonl input guards', () => {
  assert.equal(buildRopdPromptsJsonl('nope', '/x').error, 'seeds_not_array');
  assert.equal(buildRopdPromptsJsonl([], null).error, 'path_required');
  const out = _tmp('empty') + '.jsonl';
  const r = buildRopdPromptsJsonl([], out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), '', 'empty seeds => empty file (no trailing newline)');
  fs.rmSync(out, { force: true });
});

test('8. trainRopd validates inputs (missing prompts / student / bad rollouts)', () => {
  assert.equal(trainRopd({}).error, 'prompts_missing');
  const out = _tmp('p8') + '.jsonl';
  buildRopdPromptsJsonl([{ prompt: 'x', teacher: 'y' }], out);
  assert.equal(trainRopd({ promptsPath: out }).error, 'student_missing');
  assert.equal(trainRopd({ promptsPath: out, studentPath: '/s', numRollouts: 1 }).error, 'bad_num_rollouts');
  fs.rmSync(out, { force: true });
});

test('9. trainRopd clear deferral envelope when no trainer (still creates run dir)', () => {
  process.env.KOLM_ROPD_NO_TRAINER = '1';
  const out = _tmp('p9') + '.jsonl';
  buildRopdPromptsJsonl([{ prompt: 'x', teacher: 'y' }], out);
  const runDir = _tmp('run9');
  const r = trainRopd({ promptsPath: out, studentPath: '/student', outDir: runDir, namespace: 'w921-test' });
  assert.equal(r.ok, true);
  assert.equal(r.deferred, true);
  assert.equal(r.error, 'no_trainer_installed');
  assert.equal(r.objective, 'ropd');
  assert.equal(r.trainer_kicked, false);
  assert.equal(r.run_dir, runDir);
  assert.ok(fs.existsSync(runDir), 'run dir is created even when deferred');
  assert.match(r.install_hint, /trl/);
  delete process.env.KOLM_ROPD_NO_TRAINER;
  fs.rmSync(out, { force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('10. trainRopd dispatches the python trainer end-to-end (no GPU): parses run-meta', () => {
  // Override the trainer with a wrapper that forces --dry-run, so the REAL
  // dispatcher (build args, spawn python, write+parse run-meta) is exercised
  // without torch. The wrapper writes run-meta.json into --out itself.
  const py = _pythonBin();
  const probe = spawnSync(py, ['-c', 'import sys;print(sys.version)'], { stdio: 'pipe', timeout: 30000 });
  if (probe.status !== 0) {
    // No python on this box: skip gracefully (the orchestrator box has it).
    return;
  }
  const wrapper = _tmp('wrapper') + '.py';
  // The wrapper re-invokes ropd.py in --dry-run mode, captures its envelope,
  // and writes it to <out>/run-meta.json — matching what trainRopd reads.
  const wrapperSrc = [
    'import sys, json, subprocess, os',
    'argv = sys.argv[1:]',
    'def getv(flag):',
    '    return argv[argv.index(flag)+1] if flag in argv else None',
    `ropd = ${JSON.stringify(ROPD_PY)}`,
    'prompts = getv("--prompts"); out = getv("--out")',
    'res = subprocess.run([sys.executable, ropd, "--prompts", prompts, "--dry-run",',
    '       "--num-rollouts", getv("--num-rollouts") or "8"], capture_output=True, text=True)',
    'env = json.loads(res.stdout.strip().splitlines()[-1])',
    'os.makedirs(out, exist_ok=True)',
    'json.dump(env, open(os.path.join(out, "run-meta.json"), "w"))',
    'print(json.dumps({"wrapper_ok": True}))',
    'sys.exit(0)',
  ].join('\n');
  fs.writeFileSync(wrapper, wrapperSrc);
  process.env.KOLM_ROPD_TRAINER = wrapper;

  const out = _tmp('p10') + '.jsonl';
  buildRopdPromptsJsonl([
    { prompt: 'How do I reset my password?', teacher_refs: ['Open Settings, Security, Reset password, confirm via email.'] },
  ], out);
  const runDir = _tmp('run10');
  const r = trainRopd({
    promptsPath: out, studentPath: '/student', outDir: runDir,
    numRollouts: 4, numTeacherRefs: 1, namespace: 'w921-test',
  });
  assert.equal(r.ok, true, `dispatch failed: ${JSON.stringify(r)}`);
  assert.equal(r.kind, 'distill_ropd');
  assert.ok(r.manifest, 'must parse run-meta.json into manifest');
  assert.equal(r.manifest.objective, 'ropd');
  assert.equal(r.manifest.mode, 'dry_run');
  assert.ok(r.manifest.core_sample, 'manifest carries the pure-core sample');
  assert.equal(typeof r.manifest.core_sample.best_rollout_index, 'number');
  assert.ok(Array.isArray(r.manifest.core_sample.advantages));

  delete process.env.KOLM_ROPD_TRAINER;
  fs.rmSync(wrapper, { force: true });
  fs.rmSync(out, { force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('11. python self-test of the pure ROPD core passes (no GPU, no network)', () => {
  const py = _pythonBin();
  const probe = spawnSync(py, ['-c', 'print(1)'], { stdio: 'pipe', timeout: 30000 });
  if (probe.status !== 0) return; // no python: skip
  const r = spawnSync(py, [ROPD_PY, '--self-test'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, `self-test exit ${r.status}: ${(r.stderr || '').toString()}`);
  const env = JSON.parse((r.stdout || '').toString().trim().split('\n').pop());
  assert.equal(env.ok, true);
  assert.equal(env.version, 'w921-ropd-v1');
  assert.equal(env.passed, env.total, `self-test had failures: ${JSON.stringify(env.checks)}`);
  assert.ok(env.total >= 12, 'self-test must cover the formula + GRPO + step invariants');
});

test('12. recipes/support-ropd.json is valid + carries objective:ropd (black-box, no logits)', () => {
  const loaded = loadRecipe('support-ropd');
  assert.equal(loaded.ok, true, `recipe invalid: ${JSON.stringify(loaded.issues || loaded.message)}`);
  const r = loaded.recipe;
  assert.equal(r.ropd.objective, 'ropd');
  assert.equal(r.ropd.teacher_regime, 'black_box_text');
  assert.equal(r.ropd.teacher_local, false, 'ROPD must NOT require a local logit teacher');
  assert.equal(r.ropd.trainer, 'apps/trainer/ropd.py');
  assert.ok(r.ropd.papers.includes('arXiv:2605.07396'));
  assert.match(r.ropd.reward_formula, /sum_k w_k/);
  // The teacher is API-only (no logits) and the recipe must NOT smuggle a
  // logit objective into the distill section (that would fail the loader).
  assert.equal(r.distill, undefined, 'support-ropd uses the ropd section, not distill');
  // Listing must not be broken by the new recipe.
  const me = listRecipes().find((x) => x.name === 'support-ropd');
  assert.ok(me && me.valid, 'listRecipes must report support-ropd valid');
});
