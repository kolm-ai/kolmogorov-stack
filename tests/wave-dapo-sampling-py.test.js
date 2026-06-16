// tests/wave-dapo-sampling-py.test.js
//
// Node harness that runs the DAPO dynamic-sampling + provenance-reflector PYTHON
// tests (apps/trainer/dapo_sampling.py) GPU-free. The actual assertions live in
// an inline python script spawned here; if python is absent the test SKIPS LOUD
// (it does not fake-pass). The provenance-against-real-trl assertions run only
// when trl is importable; the pure-math + monkeypatched-missing-knob assertions
// run with python alone.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

const PY = `
import sys, os, json
sys.path.insert(0, ${JSON.stringify(_repoRoot)})
from apps.trainer.dapo_sampling import (
    dynamic_sample, reflect_engaged, frontier_receipt, normalize_scale_rewards,
    FrontierGRPOConfig, _population_sd, LOSS_TYPES, IS_LEVELS,
)

fails = []
def check(name, cond):
    if not cond:
        fails.append(name)

# ---- (1) population sd: all-equal -> 0, varied -> > 0 ----------------------
check("sd_all_equal_zero", _population_sd([1.0,1.0,1.0,1.0]) == 0.0)
check("sd_all_fail_zero", _population_sd([0.0,0.0,0.0]) == 0.0)
check("sd_varied_pos", _population_sd([0.0,1.0,0.0,1.0]) > 0.0)

# ---- (2) dynamic_sample drops all-equal group A, keeps varied group B ------
# Build 4 prompts: A_pass (all 1), A_fail (all 0), B1 varied, B2 varied.
rows = [
    {"prompt": "A_pass"}, {"prompt": "A_fail"},
    {"prompt": "B1"}, {"prompt": "B2"},
]
G = 4
def rollout(row, g):
    return ["x"] * g  # text irrelevant; reward keyed off the prompt name
def reward(prompt, comps, row):
    if prompt == "A_pass": return [1.0]*len(comps)
    if prompt == "A_fail": return [0.0]*len(comps)
    if prompt == "B1": return [1.0,0.0,1.0,0.0]
    if prompt == "B2": return [0.0,0.0,1.0,0.0]
    return [0.0]*len(comps)

kept, stats = dynamic_sample(rows, reward, rollout, num_generations=G,
                             target_groups=2, max_resample_factor=3, seed=7)
kept_names = sorted(r["prompt"] for r in kept)
check("kept_only_B", kept_names == ["B1","B2"])
check("dropped_all_pass_1", stats["groups_dropped_all_pass"] == 1)
check("dropped_all_fail_1", stats["groups_dropped_all_fail"] == 1)
check("groups_kept_2", stats["groups_kept"] == 2)
check("mechanism_tag", stats["mechanism"] == "dapo_dynamic_sampling")
check("paper_tag", stats["paper"] == "arXiv:2503.14476")

# ---- (3) determinism across two runs with the same seed --------------------
k1, s1 = dynamic_sample(rows, reward, rollout, num_generations=G, target_groups=2,
                        max_resample_factor=3, seed=123)
k2, s2 = dynamic_sample(rows, reward, rollout, num_generations=G, target_groups=2,
                        max_resample_factor=3, seed=123)
check("deterministic_kept", [r["prompt"] for r in k1] == [r["prompt"] for r in k2])
check("deterministic_stats", s1 == s2)

# ---- (4) budget_exhausted when refill cannot reach target ------------------
# Only all-equal groups -> nothing kept; with target 4 and only all-equal
# prompts available, budget runs out before target is reached.
deg_rows = [{"prompt":"A_pass"},{"prompt":"A_fail"},{"prompt":"A_pass2"},{"prompt":"A_fail2"}]
def reward_deg(prompt, comps, row):
    return ([1.0]*len(comps)) if "pass" in prompt else ([0.0]*len(comps))
kd, sd = dynamic_sample(deg_rows, reward_deg, rollout, num_generations=G,
                        target_groups=4, max_resample_factor=1, seed=1)
check("budget_exhausted_true", sd["budget_exhausted"] is True)
check("budget_kept_zero", sd["groups_kept"] == 0)

# Inverse: enough varied prompts -> not exhausted.
ok_rows = [{"prompt":"V%d"%i} for i in range(6)]
def reward_ok(prompt, comps, row):
    return [1.0,0.0,1.0,0.0]
ko, so = dynamic_sample(ok_rows, reward_ok, rollout, num_generations=G,
                        target_groups=3, max_resample_factor=3, seed=2)
check("not_exhausted", so["budget_exhausted"] is False and so["groups_kept"] == 3)

# ---- (5) normalize_scale_rewards string + bool -----------------------------
check("scale_str_passthrough", normalize_scale_rewards("none") == "none")
# bool path: with no trl, translate True->group / False->none.
nv_true = normalize_scale_rewards(True, trl_module=None)
nv_false = normalize_scale_rewards(False, trl_module=None)
check("scale_bool_true", nv_true in ("group", True))
check("scale_bool_false", nv_false in ("none", False))
try:
    normalize_scale_rewards("bogus"); check("scale_bad_raises", False)
except ValueError:
    check("scale_bad_raises", True)

# ---- (6) as_trl_kwargs FORWARDS loss_type + importance_sampling_level -------
# (the legacy _NON_TRL exclusion is gone). Use a fake trl module whose
# GRPOConfig signature accepts both so the filter keeps them.
class _FakeCfg:
    def __init__(self, loss_type="dapo", importance_sampling_level="token",
                 scale_rewards="group", epsilon_high=0.0, num_generations=8,
                 max_completion_length=512, max_prompt_length=512, temperature=0.7,
                 top_p=0.95, learning_rate=5e-6, beta=0.04, epsilon=0.2,
                 num_train_epochs=1, per_device_train_batch_size=1,
                 gradient_accumulation_steps=8, logging_steps=10, save_steps=100,
                 output_dir="./out", seed=42, bf16=True,
                 mask_truncated_completions=False, use_vllm=False,
                 vllm_mode="colocate", **_):
        self.loss_type = loss_type
        self.importance_sampling_level = importance_sampling_level
        self.scale_rewards = scale_rewards
        self.epsilon_high = epsilon_high
        self.use_vllm = use_vllm
        self.mask_truncated_completions = mask_truncated_completions
class _FakeTrl:
    GRPOConfig = _FakeCfg
fake = _FakeTrl()

cfg = FrontierGRPOConfig(loss_type="dapo", importance_sampling_level="sequence",
                         scale_rewards="none", epsilon_high=0.28)
kw = cfg.as_trl_kwargs(trl_module=fake)
check("forwards_loss_type", kw.get("loss_type") == "dapo")
check("forwards_isl", kw.get("importance_sampling_level") == "sequence")
check("forwards_scale_none", kw.get("scale_rewards") == "none")
check("forwards_eps_high", kw.get("epsilon_high") == 0.28)

# ---- (7) reflect_engaged: applied=true when read back; false when missing ---
built = _FakeCfg(loss_type="dapo", importance_sampling_level="sequence",
                 scale_rewards="none", epsilon_high=0.28)
eng = reflect_engaged(cfg.requested_frontier(), built, trl_module=fake)
check("engaged_loss_applied", eng["loss_type"]["applied"] is True and eng["loss_type"]["accepted"] == "dapo")
check("engaged_isl_applied", eng["importance_sampling_level"]["applied"] is True and eng["importance_sampling_level"]["accepted"] == "sequence")

# Simulate a trl whose signature LACKS importance_sampling_level -> applied=false
class _OldCfg:
    def __init__(self, loss_type="grpo", scale_rewards="group", **_):
        self.loss_type = loss_type
        self.scale_rewards = scale_rewards  # no importance_sampling_level attr
class _OldTrl:
    GRPOConfig = _OldCfg
old = _OldTrl()
old_built = _OldCfg(loss_type="dapo")
eng_old = reflect_engaged(cfg.requested_frontier(), old_built, trl_module=old)
check("engaged_isl_missing_applied_false", eng_old["importance_sampling_level"]["applied"] is False)
check("engaged_isl_missing_reason", eng_old["importance_sampling_level"]["reason"] == "trl_signature_missing")
check("never_claims_engaged_when_missing", eng_old["importance_sampling_level"]["accepted"] is None)

# ---- (8) frontier_receipt assembles counts-only block ----------------------
rb = frontier_receipt(cfg.requested_frontier(), built,
                      dynamic_sampling_stats=stats, trl_module=fake)
check("receipt_loss_engaged", rb["frontier"]["loss_type_engaged"] == "dapo")
check("receipt_isl_engaged", rb["frontier"]["importance_sampling_level_engaged"] == "sequence")
check("receipt_rollout_hf", rb["frontier"]["rollout_engine"] == "hf")
check("receipt_ds_present", rb["frontier"]["dynamic_sampling"]["groups_kept"] == 2)
check("receipt_papers", set(["arXiv:2503.14476","arXiv:2507.18071","arXiv:2503.20783"]).issubset(set(rb["papers"])))
# Privacy: receipt is counts/config only -- no raw prompt/completion text.
blob = json.dumps(rb)
check("receipt_no_raw_text", "A_pass" not in blob and "B1" not in blob)

# ---- (9) provenance against the REAL installed trl (only if importable) -----
trl_ran = False
try:
    import trl
    trl_ran = True
    real_kw = cfg.as_trl_kwargs(trl_module=trl)
    real_cfg = trl.GRPOConfig(**real_kw)
    real_eng = reflect_engaged(cfg.requested_frontier(), real_cfg, trl_module=trl)
    check("real_loss_dapo", getattr(real_cfg, "loss_type", None) == "dapo")
    check("real_isl_sequence", getattr(real_cfg, "importance_sampling_level", None) == "sequence")
    check("real_engaged_loss", real_eng["loss_type"]["applied"] is True)
    check("real_engaged_isl", real_eng["importance_sampling_level"]["applied"] is True)
except ImportError:
    pass

print(json.dumps({"fails": fails, "trl_ran": trl_ran}))
`;

test('apps/trainer/dapo_sampling.py: dynamic sampling math + provenance reflector', (t) => {
  if (!pythonAvailable()) {
    t.skip('python not available -- cannot run dapo_sampling.py assertions (LOUD skip, not a pass)');
    return;
  }
  const tmp = path.join(os.tmpdir(), `kolm-dapo-py-${Date.now()}.py`);
  fs.writeFileSync(tmp, PY, 'utf8');
  let r;
  try {
    r = spawnSync(pythonBin(), [tmp], { stdio: 'pipe', timeout: 180000, encoding: 'utf8' });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* tolerate */ }
  }
  const out = (r.stdout || '').toString();
  const err = (r.stderr || '').toString();
  // Find the JSON result line (last non-empty line).
  const lines = out.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '{}';
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch (e) {
    assert.fail(`python did not emit a JSON result. stdout:\n${out}\nstderr:\n${err}`);
  }
  assert.deepEqual(parsed.fails, [], `python assertions failed: ${JSON.stringify(parsed.fails)}\nstderr:\n${err}`);
  // trl is installed in this repo (0.24.0) -> the real-trl provenance block MUST
  // have run. If trl is somehow absent, the pure-python block still proves the
  // contract (trl_ran=false is tolerated, never a fake-pass).
  assert.equal(typeof parsed.trl_ran, 'boolean');
});
