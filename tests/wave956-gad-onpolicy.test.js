// W956 - GAD (Generative Adversarial Distillation) black-box on-policy KD.
//
// GPU-free contract tests for the JS dispatcher plus the Python pure core.
// Real training quality still requires torch/transformers/peft + a GPU run;
// these tests lock in the architecture: Python owns minimax math, Node owns
// prompt build, trainer resolution, durable envelopes, and recipe validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GAD_OBJECTIVE,
  resolveGadTrainer,
  doctorGad,
  buildGadPromptsJsonl,
  trainGad,
} from '../src/distill-onpolicy.js';
import { loadRecipe, listRecipes } from '../src/distill-recipe-loader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const GAD_PY = path.join(REPO, 'apps', 'trainer', 'gad.py');

function _tmp(name) {
  return path.join(os.tmpdir(), `kolm-w956-gad-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

test('1. GAD objective constant + in-repo trainer resolves to apps/trainer/gad.py', () => {
  assert.equal(GAD_OBJECTIVE, 'gad');
  assert.ok(fs.existsSync(GAD_PY), `missing trainer at ${GAD_PY}`);
  delete process.env.KOLM_GAD_TRAINER;
  delete process.env.KOLM_GAD_NO_TRAINER;
  const t = resolveGadTrainer();
  assert.ok(t, 'in-repo trainer must resolve');
  assert.equal(t.source, 'in_repo');
  assert.equal(path.resolve(t.script), path.resolve(GAD_PY));
});

test('2. KOLM_GAD_NO_TRAINER=1 forces the no-tool path', () => {
  process.env.KOLM_GAD_NO_TRAINER = '1';
  assert.equal(resolveGadTrainer(), null);
  delete process.env.KOLM_GAD_NO_TRAINER;
});

test('3. explicit $KOLM_GAD_TRAINER pointing nowhere is no-trainer', () => {
  process.env.KOLM_GAD_TRAINER = path.join(os.tmpdir(), 'definitely-not-here-' + Date.now() + '.py');
  assert.equal(resolveGadTrainer(), null);
  delete process.env.KOLM_GAD_TRAINER;
});

test('4. doctorGad envelope advertises black-box minimax GAD', () => {
  delete process.env.KOLM_GAD_TRAINER;
  delete process.env.KOLM_GAD_NO_TRAINER;
  const d = doctorGad();
  assert.equal(d.kind, 'distill_gad');
  assert.equal(d.objective, 'gad');
  assert.equal(d.teacher_regime, 'black_box_text');
  assert.equal(d.algorithm, 'minimax_discriminator_reward');
  assert.equal(d.ok, true);
  assert.ok(d.papers.includes('arXiv:2511.10643'), 'must cite the GAD paper');
  assert.match(d.install_hint, /\$KOLM_GAD_TRAINER/);
  assert.match(d.install_hint, /apps\/trainer\/gad\.py/);
  assert.equal(typeof d.ready, 'boolean');
  assert.equal(typeof d.torch_available, 'boolean');
});

test('5. buildGadPromptsJsonl carries teacher refs and optional student rollouts', () => {
  const out = _tmp('prompts') + '.jsonl';
  const r = buildGadPromptsJsonl([
    {
      prompt: 'reset password?',
      teacher_refs: ['Settings > Security > Reset.', 'Open Settings, reset.'],
      student_rollouts: ['I cannot help.', 'Ask support.'],
    },
    { input: 'refund window?', teacher: 'Our refund window is 30 days.' },
    { prompt: 'shipping?', response: 'Ships in 2 days.', candidates: [{ text: 'Later.' }, 'Soon.'] },
    { prompt: 'chosen-form', chosen: 'the chosen answer' },
    { prompt: 'no-refs-prompt' },
    { teacher: 'orphan ref, no prompt' },
  ], out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 5);
  assert.equal(r.with_refs, 4);
  assert.equal(r.with_rollouts, 2);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].teacher_refs, ['Settings > Security > Reset.', 'Open Settings, reset.']);
  assert.deepEqual(lines[0].student_rollouts, ['I cannot help.', 'Ask support.']);
  assert.deepEqual(lines[2].student_rollouts, ['Later.', 'Soon.']);
  assert.equal('teacher_refs' in lines[4], false);
  fs.rmSync(out, { force: true });
});

test('6. buildGadPromptsJsonl input guards', () => {
  assert.equal(buildGadPromptsJsonl('nope', '/x').error, 'seeds_not_array');
  assert.equal(buildGadPromptsJsonl([], null).error, 'path_required');
  const out = _tmp('empty') + '.jsonl';
  const r = buildGadPromptsJsonl([], out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), '', 'empty seeds => empty file');
  fs.rmSync(out, { force: true });
});

test('7. trainGad validates inputs', () => {
  assert.equal(trainGad({}).error, 'prompts_missing');
  const out = _tmp('p7') + '.jsonl';
  buildGadPromptsJsonl([{ prompt: 'x', teacher: 'y' }], out);
  assert.equal(trainGad({ promptsPath: out }).error, 'student_missing');
  assert.equal(trainGad({ promptsPath: out, studentPath: '/s', numRollouts: 1 }).error, 'bad_num_rollouts');
  assert.equal(trainGad({ promptsPath: out, studentPath: '/s', discriminatorSteps: 0 }).error, 'bad_discriminator_steps');
  fs.rmSync(out, { force: true });
});

test('8. trainGad clear deferral envelope when no trainer', () => {
  process.env.KOLM_GAD_NO_TRAINER = '1';
  const out = _tmp('p8') + '.jsonl';
  buildGadPromptsJsonl([{ prompt: 'x', teacher: 'y' }], out);
  const runDir = _tmp('run8');
  const r = trainGad({
    promptsPath: out,
    studentPath: '/student',
    outDir: runDir,
    namespace: 'w956-test',
    numRollouts: 6,
    numTeacherRefs: 2,
    discriminatorSteps: 5,
  });
  assert.equal(r.ok, true);
  assert.equal(r.deferred, true);
  assert.equal(r.error, 'no_trainer_installed');
  assert.equal(r.objective, 'gad');
  assert.equal(r.num_rollouts, 6);
  assert.equal(r.num_teacher_refs, 2);
  assert.equal(r.discriminator_steps, 5);
  assert.equal(r.trainer_kicked, false);
  assert.ok(fs.existsSync(runDir), 'run dir is created even when deferred');
  delete process.env.KOLM_GAD_NO_TRAINER;
  fs.rmSync(out, { force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('9. trainGad dispatches the python trainer end-to-end (dry-run wrapper)', () => {
  const py = _pythonBin();
  const probe = spawnSync(py, ['-c', 'import sys;print(sys.version)'], { stdio: 'pipe', timeout: 30000 });
  if (probe.status !== 0) return;

  const wrapper = _tmp('wrapper') + '.py';
  const wrapperSrc = [
    'import sys, json, subprocess, os',
    'argv = sys.argv[1:]',
    'def getv(flag):',
    '    return argv[argv.index(flag)+1] if flag in argv else None',
    `gad = ${JSON.stringify(GAD_PY)}`,
    'prompts = getv("--prompts"); out = getv("--out")',
    'res = subprocess.run([sys.executable, gad, "--prompts", prompts, "--dry-run",',
    '       "--num-rollouts", getv("--num-rollouts") or "8",',
    '       "--num-teacher-refs", getv("--num-teacher-refs") or "4",',
    '       "--discriminator-steps", getv("--discriminator-steps") or "16"],',
    '       capture_output=True, text=True)',
    'if res.returncode != 0:',
    '    print(res.stderr)',
    '    sys.exit(res.returncode)',
    'env = json.loads(res.stdout.strip().splitlines()[-1])',
    'os.makedirs(out, exist_ok=True)',
    'json.dump(env, open(os.path.join(out, "run-meta.json"), "w"))',
    'print(json.dumps({"wrapper_ok": True}))',
    'sys.exit(0)',
  ].join('\n');
  fs.writeFileSync(wrapper, wrapperSrc);
  process.env.KOLM_GAD_TRAINER = wrapper;

  const out = _tmp('p9') + '.jsonl';
  buildGadPromptsJsonl([
    {
      prompt: 'How do I reset my password?',
      teacher_refs: ['Open Settings, Security, Reset password, confirm via email.'],
      student_rollouts: ['I cannot help.', 'Try later.', 'Ask support.', 'No idea.'],
    },
  ], out);
  const runDir = _tmp('run9');
  const r = trainGad({
    promptsPath: out,
    studentPath: '/student',
    outDir: runDir,
    numRollouts: 4,
    numTeacherRefs: 1,
    discriminatorSteps: 6,
    namespace: 'w956-test',
  });
  assert.equal(r.ok, true, `dispatch failed: ${JSON.stringify(r)}`);
  assert.equal(r.kind, 'distill_gad');
  assert.ok(r.manifest, 'must parse run-meta.json into manifest');
  assert.equal(r.manifest.objective, 'gad');
  assert.equal(r.manifest.mode, 'dry_run');
  assert.equal(r.manifest.version, 'w956-gad-v1');
  assert.ok(Array.isArray(r.manifest.core_samples));
  assert.equal(typeof r.manifest.core_samples[0].best_rollout_index, 'number');
  assert.ok(Array.isArray(r.manifest.core_samples[0].advantages));

  delete process.env.KOLM_GAD_TRAINER;
  fs.rmSync(wrapper, { force: true });
  fs.rmSync(out, { force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
});

test('10. python self-test of the pure GAD core passes', () => {
  const py = _pythonBin();
  const probe = spawnSync(py, ['-c', 'print(1)'], { stdio: 'pipe', timeout: 30000 });
  if (probe.status !== 0) return;
  const r = spawnSync(py, [GAD_PY, '--self-test'], { stdio: 'pipe', timeout: 60000 });
  assert.equal(r.status, 0, `self-test exit ${r.status}: ${(r.stderr || '').toString()}`);
  const env = JSON.parse((r.stdout || '').toString().trim().split('\n').pop());
  assert.equal(env.ok, true);
  assert.equal(env.version, 'w956-gad-v1');
  assert.equal(env.passed, env.total, `self-test had failures: ${JSON.stringify(env.checks)}`);
  assert.ok(env.total >= 9, 'self-test must cover discriminator + reward + GRPO invariants');
});

test('11. support-gad recipe validates and remains black-box/no-logits', () => {
  const loaded = loadRecipe('support-gad');
  assert.equal(loaded.ok, true, `recipe invalid: ${JSON.stringify(loaded.issues || loaded.message)}`);
  const r = loaded.recipe;
  assert.equal(r.gad.objective, 'gad');
  assert.equal(r.gad.teacher_regime, 'black_box_text');
  assert.equal(r.gad.teacher_local, false);
  assert.equal(r.gad.trainer, 'apps/trainer/gad.py');
  assert.ok(r.gad.papers.includes('arXiv:2511.10643'));
  assert.match(r.gad.reward_formula, /sigmoid\(D/);
  const me = listRecipes().find((x) => x.name === 'support-gad');
  assert.ok(me && me.valid, 'listRecipes must report support-gad valid');
});
