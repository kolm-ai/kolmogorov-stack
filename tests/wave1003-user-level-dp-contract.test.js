// W1003: user-level DP contract for regulated fine-tuning.
//
// Record-level DP-SGD was already wired in W971. These tests lock the missing
// user-level layer: group clipping, user-level sample-rate accounting, preset
// recommendations, signed-budget metadata, and a measured-utility claim gate.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  buildPrivacyBudgetBlock,
  buildUserLevelDpBenchmarkPlan,
  computeUserLevelDpSgdBudget,
  recommendUserLevelDpPreset,
  summarizeUserContributions,
  userLevelDpPresets,
} from '../src/dp-training.js';

function rows() {
  return [
    { user_id: 'u1', prompt: 'a' },
    { user_id: 'u1', prompt: 'b' },
    { user_id: 'u1', prompt: 'c' },
    { user_id: 'u2', prompt: 'd' },
    { user_id: 'u3', prompt: 'e' },
    { user_id: '', prompt: 'missing' },
  ];
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

test('W1003 user contribution summary clips per-user rows before accounting', () => {
  const summary = summarizeUserContributions(rows(), { max_examples_per_user: 2 });
  assert.equal(summary.privacy_unit, 'user');
  assert.equal(summary.user_count, 3);
  assert.equal(summary.total_examples, 6);
  assert.equal(summary.retained_examples, 4);
  assert.equal(summary.missing_user_id, 1);
  assert.equal(summary.clipped_user_count, 1);
  assert.equal(summary.clipped_examples, 1);
  assert.equal(summary.max_user_examples_observed, 3);
});

test('W1003 user-level DP budget uses user sample rate and remains monotone in noise', () => {
  const lowNoise = computeUserLevelDpSgdBudget({
    rows: rows(),
    max_examples_per_user: 2,
    batch_users: 1,
    steps: 10,
    noise_multiplier: 0.8,
  });
  const highNoise = computeUserLevelDpSgdBudget({
    rows: rows(),
    max_examples_per_user: 2,
    batch_users: 1,
    steps: 10,
    noise_multiplier: 1.6,
  });

  assert.equal(lowNoise.privacy_unit, 'user');
  assert.equal(lowNoise.user_count, 3);
  assert.equal(lowNoise.sample_rate, 1 / 3);
  assert.equal(lowNoise.mechanism, 'user_level_dp_sgd_sampled_gaussian');
  assert.ok(highNoise.epsilon < lowNoise.epsilon, `${highNoise.epsilon} < ${lowNoise.epsilon}`);
  assert.equal(lowNoise.accountant_comparison.primary, 'rdp_integer_upper_bound');
  assert.equal(lowNoise.accountant_comparison.status, 'safe_upper_bound_only');
});

test('W1003 presets expose regulated defaults without becoming a measured utility claim', () => {
  const presets = userLevelDpPresets();
  assert.equal(presets.regulated_strict.target_epsilon, 2);
  const tooSmall = recommendUserLevelDpPreset({ regime: 'regulated', user_count: 20 });
  assert.equal(tooSmall.id, 'regulated_strict');
  assert.equal(tooSmall.ready_for_default, false);
  assert.match(tooSmall.warning, /below preset min_users/);
  const ready = recommendUserLevelDpPreset({ regime: 'regulated', user_count: 5000 });
  assert.equal(ready.ready_for_default, true);
});

test('W1003 privacy_budget block carries user-level DP metadata', () => {
  const budget = computeUserLevelDpSgdBudget({
    rows: rows(),
    max_examples_per_user: 2,
    batch_users: 1,
    steps: 4,
    noise_multiplier: 1.2,
  });
  const block = buildPrivacyBudgetBlock({ path: 'dp_sgd', budget, teacher_source: 'local' });
  assert.equal(block.privacy_unit, 'user');
  assert.equal(block.user_count, 3);
  assert.equal(block.total_examples, 6);
  assert.equal(block.max_examples_per_user, 2);
  assert.equal(block.clipped_user_count, 1);
  assert.equal(block.accountant_comparison.status, 'safe_upper_bound_only');
});

test('W1003 benchmark plan refuses regulated default claim without measured utility receipt', () => {
  const unmeasured = buildUserLevelDpBenchmarkPlan({
    model_id: 'Qwen/Qwen3-4B-Instruct-2507',
    dataset_id: 'tenant-support-captures',
    preset: 'balanced',
    user_count: 1000,
  });
  assert.equal(unmeasured.measured, false);
  assert.equal(unmeasured.claimable_default, false);
  assert.ok(unmeasured.blockers.includes('measured_utility_receipt'));

  const measured = buildUserLevelDpBenchmarkPlan({
    model_id: 'Qwen/Qwen3-4B-Instruct-2507',
    dataset_id: 'tenant-support-captures',
    preset: 'balanced',
    user_count: 1000,
    baseline_metric: 0.82,
    dp_metric: 0.79,
    receipt_hash: hash('dp benchmark receipt'),
  });
  assert.equal(measured.measured, true);
  assert.equal(measured.claimable_default, true);
  assert.equal(measured.utility.utility_delta, -0.03);
});
