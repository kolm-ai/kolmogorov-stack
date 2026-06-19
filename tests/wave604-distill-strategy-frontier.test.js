import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { planDistillStrategy } from '../src/distill-strategy.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const STACK_SPEC = path.join(ROOT, 'docs', 'STACK-TECH-SPEC-2026-06-15.md');

function distillationSection() {
  const body = fs.readFileSync(STACK_SPEC, 'utf8');
  const start = body.indexOf('### distillation');
  const end = body.indexOf('\n### moe-distill-quant', start);
  return body.slice(start, end);
}

test('W604 #1 - proprietary API teachers route generation to black-box GAD', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['anthropic'],
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gad');
  assert.equal(plan.profile.teacher_access.text_only, true);
  assert.match(plan.recommendation.command, /kolm distill onpolicy --gad/);
});

test('W604 #2 - logit distillation is blocked when teacher logits are unavailable', () => {
  const plan = planDistillStrategy({
    task: 'chat',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['openai'],
  }, {});
  for (const id of ['kd_top_k', 'kd_softmax', 'gkd_onpolicy', 'distillm2', 'reverse_kl_minillm']) {
    const row = plan.ranked.find((candidate) => candidate.id === id);
    assert.equal(row.feasible, false, id);
    assert.ok(row.blockers.includes('teacher_logits_required'), id);
  }
});

test('W604 #3 - local teacher access keeps GKD first and logit objectives feasible', () => {
  const plan = planDistillStrategy({
    task: 'generation',
    real_pairs: 1500,
    holdout_pairs: 300,
    teachers: ['local:qwen'],
    teacher_local: true,
  }, {});
  assert.equal(plan.ok, true);
  assert.equal(plan.recommendation.id, 'gkd_onpolicy');
  for (const id of ['kd_softmax', 'distillm2', 'reverse_kl_minillm']) {
    assert.equal(plan.ranked.find((candidate) => candidate.id === id).feasible, true, id);
  }
});

test('W604 #4 - backend spec records recommender closure and GAD implementation closure', () => {
  const section = distillationSection();
  assert.match(section, /RECOMMENDER ORACLE \(src\/distill-strategy\.js, W604(?:\+W956)?(?:\+W973)?\)/);
  assert.match(section, /\(completed-local, W604\)/);
  assert.match(section, /\[closed W956\] GAD/);
  assert.doesNotMatch(section, /\[critical\] GAD/);
  assert.doesNotMatch(section, /\[major\] The recommender oracle src\/distill-strategy\.js is stale/);
});
