// W956 - CLI wiring for GAD (Generative Adversarial Distillation,
// arXiv:2511.10643), the black-box minimax distillation path.
//
// These tests lock in the CLI surface only. The Python core and dispatcher are
// covered in wave956-gad-onpolicy.test.js. Functional tests run with
// KOLM_GAD_NO_TRAINER=1 so no GPU/Python trainer is launched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const CLI_JS = path.join(REPO, 'cli', 'kolm.js');
const CLI_SRC = fs.readFileSync(CLI_JS, 'utf8');

function _tmp(name) {
  return path.join(os.tmpdir(), `kolm-w956-gad-cli-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

function runCli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, KOLM_GAD_NO_TRAINER: '1', ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('1. cmdDistillOnPolicy routes --gad and the `gad` sub-alias before ROPD', () => {
  assert.match(CLI_SRC, /async function cmdDistillOnPolicy\(args\)/,
    'cmdDistillOnPolicy must exist');
  const gadIdx = CLI_SRC.indexOf("args.includes('--gad') || args[0] === 'gad'");
  const ropdIdx = CLI_SRC.indexOf("args.includes('--ropd') || args[0] === 'ropd'");
  assert.ok(gadIdx > 0, 'cmdDistillOnPolicy must detect --gad or the `gad` sub-alias');
  assert.ok(ropdIdx > 0, 'ROPD branch must still exist');
  assert.ok(gadIdx < ropdIdx, 'GAD branch should be checked before the ROPD branch');
  assert.match(CLI_SRC, /return cmdDistillGad\(/,
    'cmdDistillOnPolicy must dispatch to cmdDistillGad');
});

test('2. cmdDistillGad imports the GAD exports from src/distill-onpolicy.js', () => {
  assert.match(CLI_SRC, /async function cmdDistillGad\(args\)/,
    'cmdDistillGad must be defined');
  assert.match(CLI_SRC, /const \{ doctorGad \} = await import\(['"]\.\.\/src\/distill-onpolicy\.js['"]\)/,
    'doctor path must import doctorGad');
  assert.match(CLI_SRC, /const \{ GAD_OBJECTIVE, buildGadPromptsJsonl, trainGad \} = await import\(['"]\.\.\/src\/distill-onpolicy\.js['"]\)/,
    'train path must import GAD_OBJECTIVE + buildGadPromptsJsonl + trainGad');
});

test('3. cmdDistillGad parses the headline adversarial knobs', () => {
  for (const flag of [
    '--num-rollouts',
    '--num-teacher-refs',
    '--discriminator-steps',
    '--discriminator-lr',
    '--reward-temperature',
    '--collapse-penalty',
    '--max-steps',
  ]) {
    assert.ok(CLI_SRC.includes(`pickFlag(train_args, '${flag}')`),
      `cmdDistillGad must pickFlag('${flag}')`);
  }
});

test('4. cmdDistillGad plumbs the headline flags into trainGad()', () => {
  const fnStart = CLI_SRC.indexOf('async function cmdDistillGad');
  const fnEnd = CLI_SRC.indexOf('async function cmdSpecDecode', fnStart);
  const fnBody = CLI_SRC.slice(fnStart, fnEnd);
  const callIdx = fnBody.indexOf('trainGad({');
  assert.ok(callIdx > 0, 'cmdDistillGad must call trainGad({ ... })');
  const call = fnBody.slice(callIdx, fnBody.indexOf('});', callIdx) + 3);
  for (const key of [
    'promptsPath',
    'studentPath',
    'numRollouts',
    'numTeacherRefs',
    'discriminatorSteps',
    'discriminatorLr',
    'rewardTemperature',
    'collapsePenalty',
    'maxSteps',
  ]) {
    assert.ok(call.includes(key), `trainGad() call must pass ${key}`);
  }
  assert.ok(fnBody.includes('buildGadPromptsJsonl(seeds, promptsPath)'),
    'cmdDistillGad must build prompts via buildGadPromptsJsonl');
});

test('5. cmdDistillGad usage cites the GAD paper', () => {
  const fnStart = CLI_SRC.indexOf('async function cmdDistillGad');
  const fnEnd = CLI_SRC.indexOf('async function cmdSpecDecode', fnStart);
  const fnBody = CLI_SRC.slice(fnStart, fnEnd);
  assert.match(fnBody, /arXiv:2511\.10643/, 'usage text must cite the GAD paper');
  assert.match(CLI_SRC, /kolm distill onpolicy --gad/,
    'cmdDistillOnPolicy usage footer must advertise the --gad path');
});

test('6. `kolm distill onpolicy --gad doctor` prints the GAD envelope', () => {
  const r = runCli(['distill', 'onpolicy', '--gad', 'doctor']);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.kind, 'distill_gad');
  assert.equal(j.objective, 'gad');
  assert.equal(j.teacher_regime, 'black_box_text');
  assert.equal(j.algorithm, 'minimax_discriminator_reward');
  assert.ok(Array.isArray(j.papers) && j.papers.includes('arXiv:2511.10643'));
  assert.equal(j.ok, false);
  assert.equal(r.status, 3, 'doctor exits 3 when not ready');
});

test('7. `kolm distill onpolicy --gad --seeds ... --student ... --json` plumbs flags', () => {
  const seeds = _tmp('seeds') + '.jsonl';
  fs.writeFileSync(seeds, [
    JSON.stringify({
      prompt: 'reset password?',
      teacher_refs: ['Settings > Security > Reset.'],
      student_rollouts: ['I cannot help.', 'Ask support.'],
    }),
    JSON.stringify({ input: 'refund window?', teacher: '30 day window.' }),
    JSON.stringify({ prompt: 'candidate row?', response: 'Use tracked shipping.', candidates: ['Maybe.', 'Unsure.'] }),
    JSON.stringify({ prompt: 'no refs here' }),
  ].join('\n') + '\n');
  const outDir = _tmp('run');
  const r = runCli([
    'distill', 'onpolicy', '--gad',
    '--seeds', seeds, '--student', '/student',
    '--num-rollouts', '6', '--num-teacher-refs', '2',
    '--discriminator-steps', '5', '--discriminator-lr', '0.25',
    '--reward-temperature', '0.8', '--collapse-penalty', '0.2',
    '--max-steps', '3',
    '--out', outDir, '--namespace', 'w956-gad-cli', '--json',
  ]);
  assert.equal(r.status, 0, `expected exit 0 (deferred ok); got ${r.status}\n${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true);
  assert.equal(j.deferred, true);
  assert.equal(j.error, 'no_trainer_installed');
  assert.equal(j.kind, 'distill_gad');
  assert.equal(j.objective, 'gad');
  assert.equal(j.num_rollouts, 6);
  assert.equal(j.num_teacher_refs, 2);
  assert.equal(j.discriminator_steps, 5);
  assert.equal(j.prompts.count, 4);
  assert.equal(j.prompts.with_refs, 3);
  assert.equal(j.prompts.with_rollouts, 2);
  assert.ok(fs.existsSync(outDir), 'run dir must be created on the deferral path');
  fs.rmSync(seeds, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('8. the `gad` sub-alias is equivalent to --gad', () => {
  const r = runCli(['distill', 'onpolicy', 'gad', 'doctor']);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.kind, 'distill_gad');
  assert.equal(j.objective, 'gad');
});

test('9. CLI-side validation fails before any trainer spawn', () => {
  const seeds = _tmp('seeds9') + '.jsonl';
  fs.writeFileSync(seeds, JSON.stringify({ prompt: 'x', teacher: 'y' }) + '\n');

  const badRollouts = runCli([
    'distill', 'onpolicy', '--gad', '--seeds', seeds, '--student', '/s',
    '--num-rollouts', '1',
  ]);
  assert.equal(badRollouts.status, 1);
  assert.match(badRollouts.stderr, /--num-rollouts must be >= 2/);

  const badDisc = runCli([
    'distill', 'onpolicy', '--gad', '--seeds', seeds, '--student', '/s',
    '--discriminator-steps', 'abc',
  ]);
  assert.equal(badDisc.status, 1);
  assert.match(badDisc.stderr, /--discriminator-steps must be a positive integer/);

  const badTemp = runCli([
    'distill', 'onpolicy', '--gad', '--seeds', seeds, '--student', '/s',
    '--reward-temperature', '0',
  ]);
  assert.equal(badTemp.status, 1);
  assert.match(badTemp.stderr, /--reward-temperature must be a finite number > 0/);

  const noStudent = runCli(['distill', 'onpolicy', '--gad', '--seeds', seeds]);
  assert.equal(noStudent.status, 1);
  assert.match(noStudent.stderr, /usage: kolm distill onpolicy --gad/);

  fs.rmSync(seeds, { force: true });
});
