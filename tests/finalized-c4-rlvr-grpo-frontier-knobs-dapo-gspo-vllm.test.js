// tests/finalized-c4-rlvr-grpo-frontier-knobs-dapo-gspo-vllm.test.js
//
// Frontier-completion RLVR/GRPO run-meta atom: DAPO Soft Overlong Punishment,
// per-step group-diversity, per-reward-family pass-rate curves, realized
// clip-higher + dynamic-sampling stats, and recorded vLLM generation speedup,
// PROVEN into the receipt (no fake-pass).
//
// Covers the NEW kolm-owned files:
//   src/distill-grpo-runmeta.js      (JS surface: validate + flags + fold gate)
//   apps/trainer/dapo_runmeta.py     (GPU-free math + run-meta assembler)
//
// The python math runs GPU-free via an inline script; if python is absent the
// python-backed tests SKIP LOUD (never fake-pass). The JS-only tests always run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  RUN_META_SCHEMA, PAPERS, RUN_META_KNOBS,
  normalizeRunMetaConfig, buildRunMetaArgs, validateRunMetaGrpo,
  assertRunMetaProvesEngagement, foldRunMetaIntoReceipt, preflightRunMeta,
} from '../src/distill-grpo-runmeta.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

function pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}
function pythonAvailable() {
  try {
    const r = spawnSync(pythonBin(), ['-c', 'import sys; print(sys.version)'], { stdio: 'pipe', timeout: 30000 });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// --------------------------------------------------------------------------- //
// JS surface: validation (fail-loud, closed-enum, fail-before-spend).
// --------------------------------------------------------------------------- //

test('RUN_META catalog names the four frontier mechanisms + papers', () => {
  assert.equal(RUN_META_SCHEMA, 'kolm.rlvr.run_meta.v1');
  for (const k of ['overlong_reward_shaping', 'overlong_buffer', 'overlong_max_penalty', 'record_run_meta']) {
    assert.ok(RUN_META_KNOBS[k], `missing knob ${k}`);
  }
  assert.ok(RUN_META_KNOBS.overlong_reward_shaping.math.includes('Soft Overlong'));
  assert.ok(PAPERS.includes('arXiv:2503.14476')); // DAPO
  assert.ok(PAPERS.includes('arXiv:2507.18071')); // GSPO
});

test('normalizeRunMetaConfig rejects bad knobs (fail-loud)', () => {
  assert.throws(() => normalizeRunMetaConfig({ overlongRewardShaping: 'yes' }), /overlong_reward_shaping must be a boolean/);
  assert.throws(() => normalizeRunMetaConfig({ recordRunMeta: 1 }), /record_run_meta must be a boolean/);
  assert.throws(() => normalizeRunMetaConfig({ overlongBuffer: -1 }), /overlong_buffer must be an integer >= 0/);
  assert.throws(() => normalizeRunMetaConfig({ overlongMaxPenalty: -0.5 }), /overlong_max_penalty must be a number >= 0/);
  // buffer must fit inside the length budget when shaping is on.
  assert.throws(
    () => normalizeRunMetaConfig({ overlongRewardShaping: true, overlongBuffer: 600, maxCompletionLength: 512 }),
    /overlong_buffer.*must be < max_completion_length/,
  );
});

test('normalizeRunMetaConfig accepts a valid frontier run-meta config', () => {
  const c = normalizeRunMetaConfig({
    overlongRewardShaping: true, overlongBuffer: 128, overlongMaxPenalty: 1.0,
    maxCompletionLength: 512, recordRunMeta: true,
  });
  assert.equal(c.overlongRewardShaping, true);
  assert.equal(c.recordRunMeta, true);
  assert.equal(c.schema, RUN_META_SCHEMA);
});

test('buildRunMetaArgs emits exactly the expected flags + OMITS defaults', () => {
  // Non-default band + recording.
  const args = buildRunMetaArgs({
    overlongRewardShaping: true, overlongBuffer: 256, overlongMaxPenalty: 0.5, recordRunMeta: true,
  });
  assert.deepEqual(args, [
    '--overlong-reward-shaping',
    '--overlong-buffer', '256',
    '--overlong-max-penalty', '0.5',
    '--record-run-meta',
  ]);
  // Shaping on with DEFAULT band emits no band flags.
  assert.deepEqual(buildRunMetaArgs({ overlongRewardShaping: true }), ['--overlong-reward-shaping']);
  // A legacy/default config emits NOTHING new.
  assert.deepEqual(buildRunMetaArgs({}), []);
  // record-only.
  assert.deepEqual(buildRunMetaArgs({ recordRunMeta: true }), ['--record-run-meta']);
});

test('validateRunMetaGrpo: closed-enum fail-before-spend on recipe grpo knobs', () => {
  assert.deepEqual(validateRunMetaGrpo({ overlong_reward_shaping: true, overlong_buffer: 128, record_run_meta: true }), []);
  const bad = validateRunMetaGrpo({ overlong_reward_shaping: 'x', overlong_buffer: -2, overlong_max_penalty: -1 });
  assert.ok(bad.some((i) => /overlong_reward_shaping/.test(i)));
  assert.ok(bad.some((i) => /overlong_buffer/.test(i)));
  assert.ok(bad.some((i) => /overlong_max_penalty/.test(i)));
  // buffer >= max_completion_length is a fail-before-spend error.
  const bad2 = validateRunMetaGrpo({ overlong_reward_shaping: true, overlong_buffer: 600, max_completion_length: 512 });
  assert.ok(bad2.some((i) => /overlong_buffer must be < grpo.max_completion_length/.test(i)));
});

// --------------------------------------------------------------------------- //
// JS gate: run_meta must PROVE the claims before folding into the receipt.
// --------------------------------------------------------------------------- //

function sampleRunMeta() {
  // A run_meta shape matching apps/trainer/dapo_runmeta.py assemble_run_meta().
  return {
    schema: RUN_META_SCHEMA,
    papers: PAPERS,
    steps_recorded: 2,
    loss_type: 'dapo',
    importance_sampling_level: 'sequence',
    epsilon_low: 0.2,
    epsilon_high: 0.28,
    group_diversity: { mechanism: 'per_step_group_diversity', curve: [0.6667, 0.5], mean_fraction_non_degenerate: 0.5834 },
    clip_higher: { mechanism: 'realized_clip_higher', asymmetric_configured: true, engaged: true, fraction_clipped_high_curve: [0.25, 0.25] },
    reward_family_curves: {
      code_exec: [{ step: 0, pass_rate: 0.5, n: 4 }, { step: 1, pass_rate: 0.75, n: 4 }],
      math_checker: [{ step: 0, pass_rate: 0.5, n: 2 }, { step: 1, pass_rate: 1.0, n: 2 }],
    },
    overlong_reward_shaping: { mechanism: 'dapo_soft_overlong_punishment', max_length: 512, buffer: 128, max_penalty: 1.0, soft_start: 384 },
    dynamic_sampling: { mechanism: 'dapo_dynamic_sampling', groups_kept: 64, groups_dropped_all_pass: 8, groups_dropped_all_fail: 3 },
    generation_speedup: { mechanism: 'vllm_generation_speedup', vllm_tokens_per_sec: 20000, hf_tokens_per_sec: 2352.9412, speedup_ratio: 8.5 },
  };
}

test('assertRunMetaProvesEngagement: full claims PROVEN by a complete run_meta', () => {
  const v = assertRunMetaProvesEngagement(sampleRunMeta(), {
    clipHigher: true, dynamicSampling: true, overlongShaping: true,
    vllmSpeedup: true, groupDiversity: true, rewardFamilies: ['code_exec', 'math_checker'],
  });
  assert.equal(v.ok, true, `issues: ${JSON.stringify(v.issues)}`);
  assert.equal(v.proven.clipHigher, true);
  assert.equal(v.proven.dynamicSampling, true);
  assert.equal(v.proven.overlongShaping, true);
  assert.equal(v.proven.vllmSpeedup, true);
  assert.equal(v.proven.rewardFamilies, true);
});

test('assertRunMetaProvesEngagement: UNBACKED claim is rejected (no fake-pass)', () => {
  // clip_higher.engaged=false but the run claims it -> must be flagged.
  const rm = sampleRunMeta();
  rm.clip_higher.engaged = false;
  const v = assertRunMetaProvesEngagement(rm, { clipHigher: true });
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => /clipHigher/.test(i)));

  // Claiming a reward family with no curve is rejected.
  const v2 = assertRunMetaProvesEngagement(sampleRunMeta(), { rewardFamilies: ['schema_validator'] });
  assert.equal(v2.ok, false);
  assert.ok(v2.issues.some((i) => /schema_validator/.test(i)));

  // Claiming a measured vLLM speedup when only a recorded-not-measured stamp exists.
  const rm3 = sampleRunMeta();
  rm3.generation_speedup = { mechanism: 'vllm_generation_speedup', measured: false, reason: 'env_gate_off', speedup_ratio: null };
  const v3 = assertRunMetaProvesEngagement(rm3, { vllmSpeedup: true });
  assert.equal(v3.ok, false);
  // But the SAME stamp satisfies a vllmSpeedup='recorded' claim (env-gated off is allowed when declared).
  const v4 = assertRunMetaProvesEngagement(rm3, { vllmSpeedup: 'recorded' });
  assert.equal(v4.ok, true, `issues: ${JSON.stringify(v4.issues)}`);
});

test('foldRunMetaIntoReceipt is fail-CLOSED: refuses to write an un-backed claim', () => {
  const rm = sampleRunMeta();
  // Good fold: claims are all backed.
  const receipt = foldRunMetaIntoReceipt({ train: { method: 'grpo' } }, rm, {
    clipHigher: true, dynamicSampling: true, overlongShaping: true, vllmSpeedup: true,
  });
  assert.equal(receipt.train.run_meta.schema, RUN_META_SCHEMA);
  assert.equal(receipt.train.run_meta_verdict.proven.clipHigher, true);
  // Original method is preserved (additive).
  assert.equal(receipt.train.method, 'grpo');

  // Bad fold: claim a mechanism the run_meta does not back -> THROWS (never writes).
  const rmBad = sampleRunMeta();
  delete rmBad.dynamic_sampling;
  assert.throws(
    () => foldRunMetaIntoReceipt({ train: {} }, rmBad, { dynamicSampling: true }),
    /fail-closed.*un-backed frontier claim/,
  );
});

test('PRIVACY: new module files contain NO hyperscaler/network call', () => {
  const files = [
    path.join(_repoRoot, 'apps', 'trainer', 'dapo_runmeta.py'),
    path.join(_repoRoot, 'src', 'distill-grpo-runmeta.js'),
  ];
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

test('PRIVACY: run_meta carries NO raw prompt/completion text (counts/rates only)', () => {
  const blob = JSON.stringify(sampleRunMeta());
  // No obvious prompt/answer text leaks; only mechanism tags, families, numbers.
  for (const token of ['<answer>', '```python', 'def ', 'prompt:']) {
    assert.ok(!blob.includes(token), `run_meta should not carry raw text token ${token}`);
  }
});

// --------------------------------------------------------------------------- //
// Python math (GPU-free): overlong shaping, group diversity, clip-higher,
// per-reward-family curves, generation speedup, run-meta assembly.
// --------------------------------------------------------------------------- //

const PY = `
import sys, json
sys.path.insert(0, ${JSON.stringify(_repoRoot)})
from apps.trainer.dapo_runmeta import (
    OverlongRewardShaping, make_overlong_shaped_reward,
    group_diversity, clip_higher_stats, RunMetaAccumulator,
    generation_speedup, speedup_not_measured, assemble_run_meta,
)

fails = []
def check(name, cond):
    if not cond:
        fails.append(name)

# (1) Soft Overlong Punishment: 0 below soft_start, ramps, -max at/after cap.
ov = OverlongRewardShaping(max_length=512, buffer=128, max_penalty=1.0)  # soft_start=384
check("ov_zero_below", ov.penalty_for_length(300) == 0.0)
check("ov_zero_at_start", ov.penalty_for_length(384) == 0.0)
check("ov_half_ramp", abs(ov.penalty_for_length(448) - (-0.5)) < 1e-9)  # halfway across 128
check("ov_full_at_cap", ov.penalty_for_length(512) == -1.0)
check("ov_full_over_cap", ov.penalty_for_length(999) == -1.0)
# shaped reward = base + penalty (NOT clamped; negative is a real "too long" signal).
shaped = ov.shape([1.0, 1.0, 0.0], [300, 448, 512])
check("ov_shape", abs(shaped[0]-1.0)<1e-9 and abs(shaped[1]-0.5)<1e-9 and abs(shaped[2]-(-1.0))<1e-9)
# bad config fails LOUD.
try:
    OverlongRewardShaping(max_length=100, buffer=100); check("ov_bad_raises", False)
except ValueError:
    check("ov_bad_raises", True)

# make_overlong_shaped_reward wraps a base reward fn (default len = word count).
def base_reward(prompts, completions, **kw):
    return [1.0 for _ in completions]
wrapped = make_overlong_shaped_reward(base_reward, OverlongRewardShaping(max_length=10, buffer=4, max_penalty=1.0))
# completion of 10 words -> length 10 >= cap -> -1.0 -> shaped 0.0
long_c = " ".join(["w"]*10)
short_c = "w w"
sr = wrapped(["p","p"], [short_c, long_c])
check("wrap_short_full", abs(sr[0]-1.0) < 1e-9)
check("wrap_long_penalized", abs(sr[1]-0.0) < 1e-9)

# (2) group diversity: fraction non-degenerate + attributed degenerate breakdown.
gd = group_diversity([[1.0,0.0,1.0,0.0], [1.0,1.0,1.0,1.0], [0.0,0.0,0.0,0.0], [1.0,0.0,1.0,0.0]])
check("gd_total", gd["groups"] == 4)
check("gd_nondeg", gd["non_degenerate"] == 2)
check("gd_frac", abs(gd["fraction_non_degenerate"] - 0.5) < 1e-9)
check("gd_allpass", gd["degenerate_all_pass"] == 1)
check("gd_allfail", gd["degenerate_all_fail"] == 1)
check("gd_empty", group_diversity([])["fraction_non_degenerate"] == 0.0)

# (3) clip-higher realized stats: fraction at upper/lower asymmetric bounds.
ch = clip_higher_stats([1.0, 1.05, 1.40, 0.5], epsilon_low=0.2, epsilon_high=0.28)
# upper bound 1.28 -> only 1.40 exceeds (1/4). lower bound 0.8 -> only 0.5 below (1/4).
check("ch_hi", ch["clipped_high"] == 1 and abs(ch["fraction_clipped_high"]-0.25)<1e-9)
check("ch_lo", ch["clipped_low"] == 1 and abs(ch["fraction_clipped_low"]-0.25)<1e-9)
check("ch_asym", ch["asymmetric"] is True)
ch0 = clip_higher_stats([], epsilon_low=0.2, epsilon_high=0.28)
check("ch_empty", ch0["fraction_clipped_high"] == 0.0)

# (4) RunMetaAccumulator: per-step curves + reward-family curves + summary.
acc = RunMetaAccumulator(epsilon_low=0.2, epsilon_high=0.28, loss_type="dapo",
                         importance_sampling_level="sequence")
acc.record_step(0, groups=[[1.0,0.0,1.0,0.0],[1.0,1.0,1.0,1.0]],
                family_pass={"code_exec":[1.0,0.0,1.0,0.0]}, ratios=[1.40,1.0,0.5,1.0], reward_mean=0.5)
acc.record_step(1, groups=[[1.0,0.0,1.0,0.0]],
                family_pass={"code_exec":[1.0,1.0,1.0,0.0]}, ratios=[1.31,1.0], reward_mean=0.75)
summ = acc.summary()
check("summ_schema", summ["schema"] == "kolm.rlvr.run_meta.v1")
check("summ_steps", summ["steps_recorded"] == 2)
# step0 diversity: 1 of 2 non-degenerate = 0.5 ; step1: 1 of 1 = 1.0
check("summ_div_curve", summ["group_diversity"]["curve"] == [0.5, 1.0])
# clip-higher engaged: asymmetric AND both steps clipped one ratio above 1.28.
check("summ_clip_engaged", summ["clip_higher"]["engaged"] is True)
check("summ_clip_curve", summ["clip_higher"]["fraction_clipped_high_curve"][0] > 0.0)
# reward-family curve: code_exec pass-rate 0.5 then 0.75.
fam = summ["reward_family_curves"]["code_exec"]
check("summ_fam_curve", fam[0]["pass_rate"] == 0.5 and fam[1]["pass_rate"] == 0.75)
check("summ_isl", summ["importance_sampling_level"] == "sequence")

# clip-higher engaged is FALSE when symmetric (epsilon_high <= epsilon_low) even if clipped.
acc_sym = RunMetaAccumulator(epsilon_low=0.2, epsilon_high=0.0)  # symmetric
acc_sym.record_step(0, groups=[[1.0,0.0]], ratios=[1.40], reward_mean=0.5)
check("sym_not_engaged", acc_sym.summary()["clip_higher"]["engaged"] is False)

# (5) generation speedup: real timings -> ratio; bad timings raise.
sp = generation_speedup(vllm_tokens=200000, vllm_seconds=10.0, hf_tokens=200000, hf_seconds=85.0)
check("sp_ratio", abs(sp["speedup_ratio"] - 8.5) < 1e-6)
check("sp_tps", sp["vllm_tokens_per_sec"] == 20000.0)
try:
    generation_speedup(vllm_tokens=1, vllm_seconds=0.0, hf_tokens=1, hf_seconds=1.0); check("sp_bad_raises", False)
except ValueError:
    check("sp_bad_raises", True)
nm = speedup_not_measured("env_gate_off", hint="set KOLM_VLLM=1")
check("sp_not_measured", nm["measured"] is False and nm["speedup_ratio"] is None and "hint" in nm)

# assemble_run_meta folds everything; privacy: counts/rates only, no raw text.
block = assemble_run_meta(accumulator=acc, overlong=ov, speedup=sp,
                          dynamic_sampling_stats={"groups_kept": 64, "mechanism": "dapo_dynamic_sampling"},
                          engaged={"loss_type": {"applied": True, "accepted": "dapo"}})
check("block_schema", block["schema"] == "kolm.rlvr.run_meta.v1")
check("block_overlong", block["overlong_reward_shaping"]["mechanism"] == "dapo_soft_overlong_punishment")
check("block_ds", block["dynamic_sampling"]["groups_kept"] == 64)
check("block_speedup", block["generation_speedup"]["speedup_ratio"] == 8.5)
check("block_engaged", block["engaged"]["loss_type"]["applied"] is True)
blob = json.dumps(block)
check("block_no_raw", "<answer>" not in blob and "def " not in blob)

# Module is GPU-free at import: no torch/trl/vllm imported by importing it.
check("no_torch_imported", "torch" not in sys.modules)
check("no_vllm_imported", "vllm" not in sys.modules)
check("no_trl_imported", "trl" not in sys.modules)

print(json.dumps({"fails": fails}))
`;

test('apps/trainer/dapo_runmeta.py: overlong shaping + diversity + clip + curves + speedup', (t) => {
  if (!pythonAvailable()) {
    t.skip('python not available -- cannot run dapo_runmeta.py assertions (LOUD skip, not a pass)');
    return;
  }
  const tmp = path.join(os.tmpdir(), `kolm-runmeta-py-${Date.now()}.py`);
  fs.writeFileSync(tmp, PY, 'utf8');
  let r;
  try {
    r = spawnSync(pythonBin(), [tmp], { stdio: 'pipe', timeout: 180000, encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* tolerate */ }
  }
  const out = String(r.stdout || '');
  const err = String(r.stderr || '');
  const lines = out.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '{}';
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch (e) {
    assert.fail(`python did not emit a JSON result. stdout:\n${out}\nstderr:\n${err}`);
  }
  assert.deepEqual(parsed.fails, [], `python assertions failed: ${JSON.stringify(parsed.fails)}\nstderr:\n${err}`);
});

// --------------------------------------------------------------------------- //
// End-to-end JS<->python contract: preflightRunMeta() spawns the GPU-free python
// preflight, and the JS gate PROVES the emitted run_meta backs the claims.
// --------------------------------------------------------------------------- //

test('preflightRunMeta round-trip: python emits run_meta the JS gate proves', (t) => {
  if (!pythonAvailable()) {
    t.skip('python not available -- preflight round-trip skipped LOUD (not a pass)');
    return;
  }
  const res = preflightRunMeta();
  assert.equal(res.ok, true, `preflight failed: ${JSON.stringify(res)}`);
  const rm = res.runMeta;
  assert.equal(rm.schema, RUN_META_SCHEMA);
  // The preflight sample engages clip-higher (asymmetric 0.28 vs 0.2 + clipped),
  // records both reward families, a non-empty diversity curve, overlong shaping,
  // and a measured speedup. The JS gate must PROVE all of them.
  const v = assertRunMetaProvesEngagement(rm, {
    clipHigher: true, overlongShaping: true, vllmSpeedup: true,
    groupDiversity: true, rewardFamilies: ['code_exec', 'math_checker'],
  });
  assert.equal(v.ok, true, `gate rejected real python run_meta: ${JSON.stringify(v.issues)}`);
  // And the fail-closed fold succeeds end-to-end on the real python output.
  const receipt = foldRunMetaIntoReceipt({ train: { method: 'grpo' } }, rm, { clipHigher: true, overlongShaping: true });
  assert.equal(receipt.train.run_meta.schema, RUN_META_SCHEMA);
});

test('preflightRunMeta is LOUD when python is unavailable (never fake-pass)', () => {
  // Inject a spawn stub that simulates python missing (status 127).
  const missingSpawn = () => ({ status: 127, stdout: '', stderr: 'python: not found' });
  const res = preflightRunMeta({ spawn: missingSpawn });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'python_unavailable');
  assert.match(res.hint, /install python/);
});
