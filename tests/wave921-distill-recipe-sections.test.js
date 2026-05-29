// W921 — additive recipe-loader sections: distill (objective), grpo,
// preference, synth. All optional; backward-compat preserved.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRecipe } from '../src/distill-recipe-loader.js';

function writeRecipe(obj) {
  const p = path.join(os.tmpdir(), 'kolm-recipe-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

const baseRecipe = (overrides = {}) => ({
  name: 'sect-test', version: '1',
  seeds: { target: 10, generator: 'x' },
  teachers: [{ slug: 'anthropic:claude', rows: 10 }],
  train: { method: 'lora', student_base: 'Q', epochs: 1, batch_size: 1, lr: 0.0001, max_seq_len: 512, lora: { r: 16, alpha: 32 } },
  ...overrides,
});

test('backward-compat: recipe without new sections still validates', () => {
  assert.equal(loadRecipe(writeRecipe(baseRecipe())).ok, true);
  assert.equal(loadRecipe('trinity-2000').ok, true);
});

test('distill objective: seqkd ok on API teacher; distillm2 requires local', () => {
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ distill: { objective: 'seqkd' } }))).ok, true);
  // distillm2 on API teacher -> rejected
  const r = loadRecipe(writeRecipe(baseRecipe({ distill: { objective: 'distillm2' } })));
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /LOCAL/.test(i)));
  // distillm2 with teacher_local flag -> ok
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ distill: { objective: 'distillm2', teacher_local: true } }))).ok, true);
  // distillm2 with a local: teacher slug -> ok
  assert.equal(loadRecipe(writeRecipe(baseRecipe({
    teachers: [{ slug: 'local:deepseek-r1', rows: 10 }],
    distill: { objective: 'distillm2' },
  }))).ok, true);
  // bad objective enum rejected
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ distill: { objective: 'bogus' } }))).ok, false);
});

test('grpo section validation', () => {
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { reward: 'code_exec', num_generations: 8 } }))).ok, true);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { rewards: ['schema_validator', 'format'], loss_type: 'dr_grpo' } }))).ok, true);
  // missing reward
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { num_generations: 8 } }))).ok, false);
  // bad reward
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { reward: 'bogus' } }))).ok, false);
  // num_generations < 2
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { reward: 'code_exec', num_generations: 1 } }))).ok, false);
  // bad loss_type
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ grpo: { reward: 'code_exec', loss_type: 'bogus' } }))).ok, false);
});

test('preference + synth section validation', () => {
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ preference: { objective: 'simpo', beta: 2.0 } }))).ok, true);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ preference: { objective: 'bogus' } }))).ok, false);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ synth: { generator: 'magpie', target: 100 } }))).ok, true);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ synth: { generators: ['evol', 'persona-hub'] } }))).ok, true);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ synth: { generator: 'bogus' } }))).ok, false);
  assert.equal(loadRecipe(writeRecipe(baseRecipe({ synth: { generator: 'magpie', max_share: 1.5 } }))).ok, false);
});

test('shipped GRPO + onpolicy reference recipes validate', () => {
  assert.equal(loadRecipe('support-router-grpo').ok, true);
  assert.equal(loadRecipe('triton-kernels-grpo').ok, true);
  assert.equal(loadRecipe('trinity-onpolicy').ok, true);
});
