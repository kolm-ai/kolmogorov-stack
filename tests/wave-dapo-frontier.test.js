// tests/wave-dapo-frontier.test.js
//
// Frontier RLVR JS surface tests (src/distill-grpo-frontier.js): closed-enum
// validation, vLLM env-gate, buildTrainerArgs flag assembly, recipe loading, and
// a privacy grep that proves no hyperscaler/network call in the new module files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOSS_TYPES, IS_LEVELS, SCALE_REWARDS, DAPO_KNOBS,
  normalizeFrontierConfig, buildTrainerArgs, probeVllm, validateFrontierGrpo,
  loadFrontierRecipe,
} from '../src/distill-grpo-frontier.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

test('LOSS_TYPES catalog includes dapo (frontier extension)', () => {
  for (const t of ['grpo', 'bnpo', 'dr_grpo', 'dapo']) assert.ok(LOSS_TYPES.includes(t), `missing ${t}`);
  assert.ok(IS_LEVELS.includes('sequence'));
  assert.ok(DAPO_KNOBS.importance_sampling_level.math.includes('GSPO'));
});

test('normalizeFrontierConfig rejects unknown loss_type / is_level / scale_rewards (fail-loud)', () => {
  assert.throws(() => normalizeFrontierConfig({ lossType: 'nope' }), /unknown loss_type.*grpo\|bnpo\|dr_grpo\|dapo/);
  assert.throws(() => normalizeFrontierConfig({ importanceSamplingLevel: 'group' }), /unknown importance_sampling_level.*token\|sequence/);
  assert.throws(() => normalizeFrontierConfig({ scaleRewards: 'maximize' }), /unknown scale_rewards/);
  assert.throws(() => normalizeFrontierConfig({ epsilonHigh: -1 }), /epsilon_high must be a number >= 0/);
});

test('normalizeFrontierConfig accepts the closed enums + bool scale_rewards', () => {
  const c = normalizeFrontierConfig({ lossType: 'dapo', importanceSamplingLevel: 'sequence', scaleRewards: false, epsilonHigh: 0.28 });
  assert.equal(c.lossType, 'dapo');
  assert.equal(c.importanceSamplingLevel, 'sequence');
  assert.equal(c.scaleRewards, false);
  assert.equal(c.epsilonHigh, 0.28);
  // SCALE_REWARDS allows both strings and bools.
  for (const v of ['group', 'batch', 'none', true, false]) assert.ok(SCALE_REWARDS.includes(v));
});

test('vLLM ENV-GATE: KOLM_VLLM unset -> useVllm=false with loud pip install vllm note', () => {
  const prev = process.env.KOLM_VLLM;
  delete process.env.KOLM_VLLM;
  try {
    const c = normalizeFrontierConfig({ useVllm: true });
    assert.equal(c.useVllm, false);
    assert.equal(c.vllmReason, 'env_gate_off');
    assert.match(c.vllmNote, /pip install vllm/);
  } finally {
    if (prev === undefined) delete process.env.KOLM_VLLM; else process.env.KOLM_VLLM = prev;
  }
});

test('vLLM ENV-GATE: KOLM_VLLM=1 but import vllm fails -> loud downgrade, never throws', () => {
  const prev = process.env.KOLM_VLLM;
  process.env.KOLM_VLLM = '1';
  // Inject a spawn stub that simulates `import vllm` FAILING (status 1).
  const failSpawn = () => ({ status: 1, stdout: '', stderr: 'ModuleNotFoundError: vllm' });
  try {
    const c = normalizeFrontierConfig({ useVllm: true }, { spawn: failSpawn });
    assert.equal(c.useVllm, false);
    assert.equal(c.vllmReason, 'vllm_import_failed');
    assert.match(c.vllmNote, /pip install vllm/);
    // And when import succeeds, it engages.
    const okSpawn = () => ({ status: 0, stdout: '', stderr: '' });
    const c2 = normalizeFrontierConfig({ useVllm: true }, { spawn: okSpawn });
    assert.equal(c2.useVllm, true);
    assert.equal(c2.vllmReason, 'vllm_ready');
  } finally {
    if (prev === undefined) delete process.env.KOLM_VLLM; else process.env.KOLM_VLLM = prev;
  }
});

test('buildTrainerArgs emits exactly the expected flags + OMITS defaults', () => {
  const okSpawn = () => ({ status: 0, stdout: '', stderr: '' });
  const args = buildTrainerArgs({
    lossType: 'dapo', importanceSamplingLevel: 'sequence', epsilonHigh: 0.28,
    dynamicSampling: true, targetGroups: 64, maxResampleFactor: 3,
    maskTruncatedCompletions: true, scaleRewards: 'none',
  }, { spawn: okSpawn });
  // Order is stable (loss, isl, scale, eps, mask, dynamic, target, resample).
  assert.deepEqual(args, [
    '--loss-type', 'dapo',
    '--importance-sampling-level', 'sequence',
    '--scale-rewards', 'none',
    '--epsilon-high', '0.28',
    '--mask-truncated-completions',
    '--dynamic-sampling',
    '--target-groups', '64',
    '--max-resample-factor', '3',
  ]);

  // A default/legacy config (plain grpo, token, group, no eps) emits NOTHING new.
  const none = buildTrainerArgs({ lossType: 'grpo' }, { spawn: okSpawn });
  assert.deepEqual(none, []);

  // useVllm only emits when the gate engaged.
  const prev = process.env.KOLM_VLLM;
  process.env.KOLM_VLLM = '1';
  try {
    const v = buildTrainerArgs({ lossType: 'grpo', useVllm: true, vllmMode: 'colocate' }, { spawn: okSpawn });
    assert.deepEqual(v, ['--use-vllm', '--vllm-mode', 'colocate']);
  } finally {
    if (prev === undefined) delete process.env.KOLM_VLLM; else process.env.KOLM_VLLM = prev;
  }
});

test('validateFrontierGrpo: closed-enum fail-before-spend on the new knobs', () => {
  assert.deepEqual(validateFrontierGrpo({ loss_type: 'dapo', dynamic_sampling: true, target_groups: 8 }), []);
  const bad = validateFrontierGrpo({ loss_type: 'xxx', target_groups: 0, epsilon_high: -2 });
  assert.ok(bad.some((i) => /loss_type/.test(i)));
  assert.ok(bad.some((i) => /target_groups/.test(i)));
  assert.ok(bad.some((i) => /epsilon_high/.test(i)));
});

test('RECIPE: recipes/dapo-rlvr-frontier.json loads with loss_type=dapo + frontier knobs', () => {
  const res = loadFrontierRecipe('dapo-rlvr-frontier');
  assert.equal(res.ok, true, `recipe should validate: ${JSON.stringify(res.issues || res.error)}`);
  assert.equal(res.recipe.grpo.loss_type, 'dapo');
  assert.equal(res.recipe.grpo.importance_sampling_level, 'sequence');
  assert.equal(res.recipe.grpo.dynamic_sampling, true);
  assert.equal(res.recipe.grpo.epsilon_high, 0.28);
});

test('PRIVACY: new module files contain NO hyperscaler/network call', () => {
  const files = [
    path.join(_repoRoot, 'apps', 'trainer', 'dapo_sampling.py'),
    path.join(_repoRoot, 'src', 'distill-grpo-frontier.js'),
  ];
  // Network/hyperscaler surfaces that must NEVER appear (scoring is local-only).
  // We match as code tokens, tolerating the word "network" in PROSE comments only
  // by scanning for call-shaped / import-shaped tokens.
  const banned = [
    /\bfetch\s*\(/,
    /\brequests\.(get|post|put|patch|delete)\b/,
    /\bimport\s+requests\b/,
    /\bhttpx\b/,
    /\burllib\b/,
    /\bopenai\b/i,
    /\banthropic\b/i,
    /\bhttps?:\/\/api\./i,
    /\baxios\b/,
    /node:https?\b/,
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of banned) {
      assert.ok(!re.test(src), `${path.basename(f)} must not contain network/hyperscaler token ${re}`);
    }
  }
});
