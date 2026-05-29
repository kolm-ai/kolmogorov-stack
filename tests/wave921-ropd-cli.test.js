// W921 NEXT-1 — CLI wiring for ROPD (Rubric-based On-policy Distillation,
// arXiv:2605.07396), the black-box on-policy distillation path.
//
// The src-level dispatcher (doctorRopd / buildRopdPromptsJsonl / trainRopd) is
// owned + tested by tests/wave921-ropd-onpolicy.test.js. THIS suite locks in the
// CLI surface only: that `kolm distill onpolicy --ropd` (and the `ropd`
// sub-alias) is wired in cli/kolm.js, imports the right exports, and plumbs the
// four headline flags (--num-rollouts / --num-teacher-refs / --rubric-min-items
// / --rubric-max-items) through to trainRopd.
//
// Tests 1-6 are pure source-level lock-in (read cli/kolm.js — no spawn, no
// network, no GPU). Tests 7-10 spawn the real CLI with KOLM_ROPD_NO_TRAINER=1
// so the deterministic deferral envelope is exercised end-to-end (still GPU-free
// — the trainer is never launched).
//
// Caveat: these tests assert wiring + flag plumbing + exit codes, not training
// quality (which needs torch/trl + a GPU run).

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
  return path.join(os.tmpdir(), `kolm-w921-ropd-cli-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
}

// Run the CLI in-process via spawnSync(node, [cli, ...args]). KOLM_ROPD_NO_TRAINER
// forces the deterministic no-tool path so we never spawn python or touch a GPU.
function runCli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [CLI_JS, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, KOLM_ROPD_NO_TRAINER: '1', ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------------------
// Source-level lock-in (no spawn).
// ---------------------------------------------------------------------------

test('1. cmdDistillOnPolicy routes --ropd (and the `ropd` sub-alias) to cmdDistillRopd', () => {
  // The branch must fire BEFORE the white-box sub-switch so the two on-policy
  // paths never collide.
  assert.match(CLI_SRC, /async function cmdDistillOnPolicy\(args\)/,
    'cmdDistillOnPolicy must exist');
  assert.match(CLI_SRC, /args\.includes\(['"]--ropd['"]\)\s*\|\|\s*args\[0\]\s*===\s*['"]ropd['"]/,
    'cmdDistillOnPolicy must detect --ropd or the `ropd` sub-alias');
  assert.match(CLI_SRC, /return cmdDistillRopd\(/,
    'cmdDistillOnPolicy must dispatch to cmdDistillRopd');
});

test('2. cmdDistillRopd is defined and imports the ROPD exports from src/distill-onpolicy.js', () => {
  assert.match(CLI_SRC, /async function cmdDistillRopd\(args\)/,
    'cmdDistillRopd must be defined');
  // doctor path imports doctorRopd; train path imports build + train.
  assert.match(CLI_SRC, /const \{ doctorRopd \} = await import\(['"]\.\.\/src\/distill-onpolicy\.js['"]\)/,
    'cmdDistillRopd doctor path must import doctorRopd');
  assert.match(CLI_SRC, /const \{ ROPD_OBJECTIVE, buildRopdPromptsJsonl, trainRopd \} = await import\(['"]\.\.\/src\/distill-onpolicy\.js['"]\)/,
    'cmdDistillRopd train path must import ROPD_OBJECTIVE + buildRopdPromptsJsonl + trainRopd');
});

test('3. cmdDistillRopd parses the four headline flags', () => {
  for (const flag of ['--num-rollouts', '--num-teacher-refs', '--rubric-min-items', '--rubric-max-items']) {
    assert.ok(CLI_SRC.includes(`pickFlag(train_args, '${flag}')`),
      `cmdDistillRopd must pickFlag('${flag}')`);
  }
});

test('4. cmdDistillRopd plumbs the four flags into the trainRopd() call', () => {
  // Isolate the trainRopd({ ... }) options object inside cmdDistillRopd and
  // assert each knob is forwarded (not just parsed then dropped).
  const fnStart = CLI_SRC.indexOf('async function cmdDistillRopd');
  assert.ok(fnStart > 0, 'cmdDistillRopd not found');
  const fnEnd = CLI_SRC.indexOf('async function cmdSpecDecode', fnStart);
  const fnBody = CLI_SRC.slice(fnStart, fnEnd > 0 ? fnEnd : undefined);
  const callIdx = fnBody.indexOf('trainRopd({');
  assert.ok(callIdx > 0, 'cmdDistillRopd must call trainRopd({ ... })');
  const call = fnBody.slice(callIdx, fnBody.indexOf('});', callIdx) + 3);
  for (const key of ['promptsPath', 'studentPath', 'numRollouts', 'numTeacherRefs', 'rubricMinItems', 'rubricMaxItems']) {
    assert.ok(call.includes(key), `trainRopd() call must pass ${key}`);
  }
  // The prompts JSONL must be produced by the black-box builder (teacher TEXT),
  // not the GRPO verifiable-column builder.
  assert.ok(fnBody.includes('buildRopdPromptsJsonl(seeds, promptsPath)'),
    'cmdDistillRopd must build prompts via buildRopdPromptsJsonl(seeds, promptsPath)');
});

test('5. cmdDistillRopd routes its doctor subverb to /v1/distill/onpolicy/doctor on --remote', () => {
  const fnStart = CLI_SRC.indexOf('async function cmdDistillRopd');
  const fnEnd = CLI_SRC.indexOf('async function cmdSpecDecode', fnStart);
  const fnBody = CLI_SRC.slice(fnStart, fnEnd);
  assert.match(fnBody, /\/v1\/distill\/onpolicy\/doctor/,
    'cmdDistillRopd --remote doctor must hit /v1/distill/onpolicy/doctor');
});

test('6. cmdDistillRopd cites the ROPD paper in its usage text (discoverability)', () => {
  const fnStart = CLI_SRC.indexOf('async function cmdDistillRopd');
  const fnEnd = CLI_SRC.indexOf('async function cmdSpecDecode', fnStart);
  const fnBody = CLI_SRC.slice(fnStart, fnEnd);
  assert.match(fnBody, /arXiv:2605\.07396/, 'usage text must cite the ROPD paper');
  // The onpolicy usage footer must also advertise the --ropd path.
  assert.match(CLI_SRC, /kolm distill onpolicy --ropd/,
    'cmdDistillOnPolicy usage footer must advertise the --ropd path');
});

// ---------------------------------------------------------------------------
// Functional end-to-end (spawn the real CLI; GPU-free via KOLM_ROPD_NO_TRAINER).
// ---------------------------------------------------------------------------

test('7. `kolm distill onpolicy --ropd doctor` prints the black-box ROPD envelope', () => {
  const r = runCli(['distill', 'onpolicy', '--ropd', 'doctor']);
  // doctor exits 3 when not ready (torch/trl absent on the test box) but the
  // envelope must still be the ROPD one.
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.kind, 'distill_ropd');
  assert.equal(j.objective, 'ropd');
  assert.equal(j.teacher_regime, 'black_box_text');
  assert.ok(Array.isArray(j.papers) && j.papers.includes('arXiv:2605.07396'),
    'doctor envelope must cite the ROPD paper');
  // ok:false because KOLM_ROPD_NO_TRAINER=1 forces the no-trainer path.
  assert.equal(j.ok, false);
  assert.equal(r.status, 3, 'doctor exits 3 when not ready');
});

test('8. `kolm distill onpolicy --ropd --seeds ... --student ... --json` plumbs all four flags', () => {
  const seeds = _tmp('seeds') + '.jsonl';
  fs.writeFileSync(seeds, [
    JSON.stringify({ prompt: 'reset password?', teacher_refs: ['Settings > Security > Reset.'] }),
    JSON.stringify({ input: 'refund window?', teacher: '30 day window.' }),
    JSON.stringify({ prompt: 'no-refs-here' }),
  ].join('\n') + '\n');
  const outDir = _tmp('run');
  const r = runCli([
    'distill', 'onpolicy', '--ropd',
    '--seeds', seeds, '--student', '/student',
    '--num-rollouts', '6', '--num-teacher-refs', '2',
    '--rubric-min-items', '3', '--rubric-max-items', '9',
    '--out', outDir, '--namespace', 'w921-ropd-cli', '--json',
  ]);
  assert.equal(r.status, 0, `expected exit 0 (deferred ok); got ${r.status}\n${r.stderr}`);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.ok, true);
  assert.equal(j.deferred, true);
  assert.equal(j.error, 'no_trainer_installed');
  assert.equal(j.kind, 'distill_ropd');
  assert.equal(j.objective, 'ropd');
  // The headline flags must reach the envelope (proves end-to-end plumbing).
  assert.equal(j.num_rollouts, 6, '--num-rollouts must plumb through');
  assert.equal(j.num_teacher_refs, 2, '--num-teacher-refs must plumb through');
  // The black-box prompts builder ran: 3 prompts, 2 carry teacher refs.
  assert.equal(j.prompts.count, 3);
  assert.equal(j.prompts.with_refs, 2);
  // The run dir was created even though the trainer is absent.
  assert.ok(fs.existsSync(outDir), 'run dir must be created on the deferral path');
  fs.rmSync(seeds, { force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

test('9. the `ropd` sub-alias is equivalent to --ropd', () => {
  const r = runCli(['distill', 'onpolicy', 'ropd', 'doctor']);
  const j = JSON.parse(r.stdout.trim());
  assert.equal(j.kind, 'distill_ropd');
  assert.equal(j.objective, 'ropd');
});

test('10. CLI-side validation: bad rubric ordering + missing student fail before any spawn', () => {
  const seeds = _tmp('seeds10') + '.jsonl';
  fs.writeFileSync(seeds, JSON.stringify({ prompt: 'x', teacher: 'y' }) + '\n');
  // min > max → BAD_ARGS (exit 1), structured error on stderr.
  const bad = runCli([
    'distill', 'onpolicy', '--ropd', '--seeds', seeds, '--student', '/s',
    '--rubric-min-items', '9', '--rubric-max-items', '3',
  ]);
  assert.equal(bad.status, 1, 'min>max must exit BAD_ARGS (1)');
  assert.match(bad.stderr, /rubric-min-items.*rubric-max-items/);

  // missing --student → usage (exit 1).
  const noStudent = runCli(['distill', 'onpolicy', '--ropd', '--seeds', seeds]);
  assert.equal(noStudent.status, 1, 'missing --student must exit BAD_ARGS (1)');
  assert.match(noStudent.stderr, /usage: kolm distill onpolicy --ropd/);

  // non-integer --num-rollouts → BAD_ARGS (1).
  const badN = runCli([
    'distill', 'onpolicy', '--ropd', '--seeds', seeds, '--student', '/s',
    '--num-rollouts', 'abc',
  ]);
  assert.equal(badN.status, 1, 'non-integer --num-rollouts must exit BAD_ARGS (1)');
  assert.match(badN.stderr, /--num-rollouts must be a positive integer/);

  fs.rmSync(seeds, { force: true });
});
