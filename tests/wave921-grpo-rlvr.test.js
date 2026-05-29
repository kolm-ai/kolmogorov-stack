// W921 — GRPO / RLVR orchestration + reward-bridge + recipe-validation tests
// (src/distill-grpo.js). GPU-free; the real trl run is under needs_gpu_run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  REWARD_FAMILIES, LOSS_TYPES, buildPromptsJsonl, trainGrpo, resolveTrainer,
} from '../src/distill-grpo.js';
import { loadRecipe } from '../src/distill-recipe-loader.js';

test('reward families + loss types catalogs', () => {
  assert.ok(REWARD_FAMILIES.includes('code_exec'));
  assert.ok(REWARD_FAMILIES.includes('kolm_verifier'));
  assert.ok(LOSS_TYPES.includes('dr_grpo'));
});

test('buildPromptsJsonl writes the right verifiable column per family', () => {
  const out = path.join(os.tmpdir(), 'kolm-grpo-prompts-' + Date.now() + '.jsonl');
  const r = buildPromptsJsonl([
    { prompt: 'add(a,b)', tests: ['assert add(1,2)==3'] },
    { prompt: 'noop' },
  ], { family: 'code_exec' }, out);
  assert.equal(r.ok, true);
  assert.equal(r.count, 2);
  const lines = fs.readFileSync(out, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0].tests, ['assert add(1,2)==3']);
  // math family carries references
  const out2 = path.join(os.tmpdir(), 'kolm-grpo-math-' + Date.now() + '.jsonl');
  buildPromptsJsonl([{ prompt: '2+2?', reference: '4' }], { family: 'math_checker' }, out2);
  const m = JSON.parse(fs.readFileSync(out2, 'utf8').trim());
  assert.equal(m.references, '4');
  // schema family carries schemas/regexes
  const out3 = path.join(os.tmpdir(), 'kolm-grpo-schema-' + Date.now() + '.jsonl');
  buildPromptsJsonl([{ prompt: 'route', schema: { type: 'object' } }], { family: 'schema_validator' }, out3);
  assert.ok(JSON.parse(fs.readFileSync(out3, 'utf8').trim()).schemas);
});

test('trainGrpo validates rewards + loss_type + missing inputs', () => {
  const out = path.join(os.tmpdir(), 'kolm-grpo-p2-' + Date.now() + '.jsonl');
  buildPromptsJsonl([{ prompt: 'x' }], { family: 'code_exec' }, out);
  assert.equal(trainGrpo({ promptsPath: out, studentPath: '/s', rewardFunctions: ['bogus'] }).error, 'unknown_reward');
  assert.equal(trainGrpo({ promptsPath: out, studentPath: '/s', lossType: 'bogus' }).error, 'unknown_loss_type');
  assert.equal(trainGrpo({ promptsPath: '/nope', studentPath: '/s' }).error, 'prompts_missing');
  assert.equal(trainGrpo({ promptsPath: out }).error, 'student_missing');
});

test('trainGrpo durable no-trainer envelope', () => {
  const out = path.join(os.tmpdir(), 'kolm-grpo-p3-' + Date.now() + '.jsonl');
  buildPromptsJsonl([{ prompt: 'x' }], { family: 'code_exec' }, out);
  const prev = process.env.KOLM_GRPO_TRAINER;
  // point the override at a nonexistent path -> no-trainer durable path
  process.env.KOLM_GRPO_TRAINER = path.join(os.tmpdir(), 'no-such-grpo.py');
  try {
    const r = trainGrpo({ promptsPath: out, studentPath: '/s', rewardFunctions: ['code_exec'] });
    assert.equal(r.ok, true);
    assert.equal(r.trainer_kicked, false);
    assert.equal(r.error, 'no_trainer_installed');
    assert.ok(fs.existsSync(r.run_dir));
  } finally {
    if (prev === undefined) delete process.env.KOLM_GRPO_TRAINER; else process.env.KOLM_GRPO_TRAINER = prev;
  }
});

test('in-repo trainer resolves (train_grpo.py shipped)', () => {
  const prev = process.env.KOLM_GRPO_TRAINER;
  delete process.env.KOLM_GRPO_TRAINER;
  try {
    const t = resolveTrainer();
    assert.ok(t, 'in-repo train_grpo.py should resolve');
    assert.equal(t.source, 'in_repo');
    assert.match(t.script, /train_grpo\.py$/);
  } finally {
    if (prev !== undefined) process.env.KOLM_GRPO_TRAINER = prev;
  }
});

test('shipped GRPO recipes carry a grpo section the loader accepts', () => {
  for (const r of ['support-router-grpo', 'triton-kernels-grpo']) {
    const res = loadRecipe(r);
    assert.equal(res.ok, true, `${r} should validate`);
    assert.ok(res.recipe.grpo, `${r} should have a grpo section`);
  }
});
