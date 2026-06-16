// src/distill-grpo-runmeta.js
//
// Frontier RLVR RUN-META surface (JS twin of apps/trainer/dapo_runmeta.py). This
// is the kolm-owned JS layer that:
//
//   1. validates the soft-overlong + run-meta knobs (closed-enum, fail-loud,
//      fail-before-spend) on a recipe's grpo section,
//   2. assembles the EXTRA train_grpo.py CLI flags for the soft-overlong shaper
//      (--overlong-buffer / --overlong-max-penalty) and run-meta recording
//      (--record-run-meta), OMITTING flags for default/unset knobs so a legacy
//      run stays byte-identical,
//   3. asserts the python-emitted run_meta block PROVES which frontier mechanisms
//      engaged before it is folded into the signed .kolm receipt -- a run that
//      claims clip-higher / dynamic-sampling / vLLM-speedup but whose run_meta
//      does not back the claim is REJECTED (no fake-pass into the receipt).
//
// This module composes with src/distill-grpo-frontier.js (DAPO/GSPO/vLLM knobs +
// engaged reflector); it owns the mechanisms that build did NOT cover: Soft
// Overlong Punishment (DAPO sec 3.4), per-step group-diversity, per-reward-family
// pass-rate curves, realized clip-higher/dynamic-sampling stats, and the recorded
// vLLM generation speedup.
//
// Privacy / moat: run_meta is counts/rates/config ONLY -- never raw prompt or
// completion text. There is intentionally NO fetch / http / sdk import in this
// file (a test greps to prove it). Scoring is the LOCAL kolm verifier path.
//
// Citations:
//   DAPO: Yu et al, 2025, arXiv:2503.14476 (Soft Overlong Punishment sec 3.4,
//         Dynamic Sampling sec 3.2, Clip-Higher sec 3.1)
//   GSPO: Zheng et al, 2025, arXiv:2507.18071 (sequence importance sampling)

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

export const RUN_META_SCHEMA = 'kolm.rlvr.run_meta.v1';
export const PAPERS = ['arXiv:2503.14476', 'arXiv:2507.18071', 'arXiv:2503.20783', 'arXiv:2402.03300'];

// Receipt-grade catalog of the run-meta knobs this module owns.
export const RUN_META_KNOBS = {
  overlong_reward_shaping: {
    type: 'boolean',
    default: false,
    math: 'DAPO Soft Overlong Punishment: linear penalty ramp across a buffer band before the hard length cap (soft companion to mask_truncated_completions which zeroes the gradient)',
    paper: 'arXiv:2503.14476',
  },
  overlong_buffer: {
    type: 'integer>=0',
    default: 128,
    math: 'width (tokens) of the soft-penalty ramp band; penalty ramps 0 -> -max_penalty across [max_len-buffer, max_len)',
    paper: 'arXiv:2503.14476',
  },
  overlong_max_penalty: {
    type: 'number>=0',
    default: 1.0,
    math: 'magnitude of the additive penalty at/after the hard cap',
    paper: 'arXiv:2503.14476',
  },
  record_run_meta: {
    type: 'boolean',
    default: false,
    math: 'stamp per-step group-diversity, per-reward-family pass-rate curves, realized clip-higher + dynamic-sampling stats, and vLLM speedup into run-meta',
    paper: 'arXiv:2503.14476',
  },
};

function _fail(message) {
  throw new Error(message);
}

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

// normalizeRunMetaConfig(cfg) - validate + close-enum the run-meta config with
// fail-loud errors (mirrors normalizeFrontierConfig style). Returns a stable
// validated object. The overlong buffer/penalty are only meaningful when
// overlongRewardShaping is on; we still validate them whenever supplied.
export function normalizeRunMetaConfig(cfg = {}) {
  const {
    overlongRewardShaping = false,
    overlongBuffer = 128,
    overlongMaxPenalty = 1.0,
    maxCompletionLength,
    recordRunMeta = false,
  } = cfg;

  if (typeof overlongRewardShaping !== 'boolean') {
    _fail(`overlong_reward_shaping must be a boolean; got ${JSON.stringify(overlongRewardShaping)}`);
  }
  if (typeof recordRunMeta !== 'boolean') {
    _fail(`record_run_meta must be a boolean; got ${JSON.stringify(recordRunMeta)}`);
  }
  if (!Number.isInteger(overlongBuffer) || overlongBuffer < 0) {
    _fail(`overlong_buffer must be an integer >= 0; got ${JSON.stringify(overlongBuffer)}`);
  }
  if (typeof overlongMaxPenalty !== 'number' || Number.isNaN(overlongMaxPenalty) || overlongMaxPenalty < 0) {
    _fail(`overlong_max_penalty must be a number >= 0; got ${JSON.stringify(overlongMaxPenalty)}`);
  }
  if (maxCompletionLength !== undefined) {
    if (!Number.isInteger(maxCompletionLength) || maxCompletionLength < 1) {
      _fail(`max_completion_length must be a positive integer; got ${JSON.stringify(maxCompletionLength)}`);
    }
    // The buffer band must fit inside the budget (mirrors OverlongRewardShaping.__post_init__).
    if (overlongRewardShaping && overlongBuffer >= maxCompletionLength) {
      _fail(
        `overlong_buffer (${overlongBuffer}) must be < max_completion_length (${maxCompletionLength}); ` +
          'the soft-penalty band cannot exceed the length budget',
      );
    }
  }

  return {
    overlongRewardShaping,
    overlongBuffer,
    overlongMaxPenalty,
    maxCompletionLength: maxCompletionLength !== undefined ? maxCompletionLength : null,
    recordRunMeta,
    schema: RUN_META_SCHEMA,
    papers: PAPERS,
  };
}

// buildRunMetaArgs(cfg) - EXTRA CLI flags appended to the train_grpo.py spawn for
// the soft-overlong shaper + run-meta recording. Pure string assembly; OMITS
// flags for default/unset knobs so a legacy run emits nothing new. Accepts a raw
// or already-normalized config (idempotent).
export function buildRunMetaArgs(cfg = {}) {
  const c = cfg.schema === RUN_META_SCHEMA ? cfg : normalizeRunMetaConfig(cfg);
  const args = [];
  if (c.overlongRewardShaping === true) {
    args.push('--overlong-reward-shaping');
    // Only emit non-default band knobs (default buffer=128, penalty=1.0).
    if (c.overlongBuffer !== 128) args.push('--overlong-buffer', String(c.overlongBuffer));
    if (c.overlongMaxPenalty !== 1.0) args.push('--overlong-max-penalty', String(c.overlongMaxPenalty));
  }
  if (c.recordRunMeta === true) {
    args.push('--record-run-meta');
  }
  return args;
}

// validateRunMetaGrpo(grpo) - closed-enum fail-before-spend on the run-meta knobs
// of a recipe's `grpo` section. Returns a list of issue strings (empty = valid).
export function validateRunMetaGrpo(grpo) {
  const issues = [];
  if (grpo === undefined || grpo === null) return issues;
  if (typeof grpo !== 'object' || Array.isArray(grpo)) {
    issues.push('grpo must be an object if present');
    return issues;
  }
  if (grpo.overlong_reward_shaping !== undefined && typeof grpo.overlong_reward_shaping !== 'boolean') {
    issues.push('grpo.overlong_reward_shaping must be a boolean');
  }
  if (grpo.record_run_meta !== undefined && typeof grpo.record_run_meta !== 'boolean') {
    issues.push('grpo.record_run_meta must be a boolean');
  }
  if (grpo.overlong_buffer !== undefined && (!Number.isInteger(grpo.overlong_buffer) || grpo.overlong_buffer < 0)) {
    issues.push('grpo.overlong_buffer must be an integer >= 0');
  }
  if (grpo.overlong_max_penalty !== undefined && (typeof grpo.overlong_max_penalty !== 'number' || grpo.overlong_max_penalty < 0)) {
    issues.push('grpo.overlong_max_penalty must be a number >= 0');
  }
  if (
    grpo.overlong_reward_shaping === true &&
    grpo.overlong_buffer !== undefined &&
    grpo.max_completion_length !== undefined &&
    Number.isInteger(grpo.overlong_buffer) &&
    Number.isInteger(grpo.max_completion_length) &&
    grpo.overlong_buffer >= grpo.max_completion_length
  ) {
    issues.push('grpo.overlong_buffer must be < grpo.max_completion_length');
  }
  return issues;
}

// assertRunMetaProvesEngagement(runMeta, claims) - the gate that keeps the receipt
// truthful. Given the python-emitted run_meta block and the run's CLAIMS (which
// frontier mechanisms the run says it used), verify the run_meta actually BACKS
// each claim. Returns {ok, proven, issues}. A claim with no backing evidence is an
// issue (the receipt must never silently claim an un-engaged mechanism).
//
// claims keys (all optional booleans / values):
//   clipHigher          -> run_meta.clip_higher.engaged must be true
//   dynamicSampling     -> run_meta.dynamic_sampling must carry groups_kept >= 1
//   overlongShaping     -> run_meta.overlong_reward_shaping present + buffer>0
//   vllmSpeedup         -> run_meta.generation_speedup.speedup_ratio is a number > 0
//                          (OR measured:false with a reason -> recorded-not-proven,
//                           which is allowed only when claim is the string 'recorded')
//   groupDiversity      -> run_meta.group_diversity.curve non-empty
//   rewardFamilies (arr)-> each named family has a non-empty curve
export function assertRunMetaProvesEngagement(runMeta, claims = {}) {
  const issues = [];
  const proven = {};
  if (!runMeta || typeof runMeta !== 'object') {
    return { ok: false, proven, issues: ['run_meta missing or not an object'] };
  }
  if (runMeta.schema !== RUN_META_SCHEMA) {
    issues.push(`run_meta.schema must be ${RUN_META_SCHEMA}; got ${JSON.stringify(runMeta.schema)}`);
  }

  if (claims.clipHigher) {
    const ch = runMeta.clip_higher;
    const ok = !!(ch && ch.engaged === true);
    proven.clipHigher = ok;
    if (!ok) {
      issues.push(
        'claim clipHigher: run_meta.clip_higher.engaged is not true ' +
          '(asymmetric epsilon configured AND >=1 step clipped at the upper bound is required to prove Clip-Higher engaged)',
      );
    }
  }

  if (claims.dynamicSampling) {
    const ds = runMeta.dynamic_sampling;
    const ok = !!(ds && typeof ds.groups_kept === 'number' && ds.groups_kept >= 1);
    proven.dynamicSampling = ok;
    if (!ok) {
      issues.push('claim dynamicSampling: run_meta.dynamic_sampling.groups_kept must be >= 1 to prove dynamic sampling ran');
    }
  }

  if (claims.overlongShaping) {
    const ov = runMeta.overlong_reward_shaping;
    const ok = !!(ov && typeof ov.buffer === 'number' && ov.buffer > 0 && ov.mechanism === 'dapo_soft_overlong_punishment');
    proven.overlongShaping = ok;
    if (!ok) {
      issues.push('claim overlongShaping: run_meta.overlong_reward_shaping must carry the soft-punishment mechanism with buffer > 0');
    }
  }

  if (claims.vllmSpeedup !== undefined && claims.vllmSpeedup !== false) {
    const sp = runMeta.generation_speedup;
    if (claims.vllmSpeedup === 'recorded') {
      // Allow a recorded-not-measured stamp (env-gated off) -- but it must say so.
      const ok = !!(sp && (sp.measured === false || typeof sp.speedup_ratio === 'number'));
      proven.vllmSpeedup = ok;
      if (!ok) issues.push('claim vllmSpeedup=recorded: run_meta.generation_speedup must be present (measured:false with a reason, or a ratio)');
    } else {
      const ok = !!(sp && typeof sp.speedup_ratio === 'number' && sp.speedup_ratio > 0);
      proven.vllmSpeedup = ok;
      if (!ok) issues.push('claim vllmSpeedup: run_meta.generation_speedup.speedup_ratio must be a measured number > 0');
    }
  }

  if (claims.groupDiversity) {
    const gd = runMeta.group_diversity;
    const ok = !!(gd && Array.isArray(gd.curve) && gd.curve.length > 0);
    proven.groupDiversity = ok;
    if (!ok) issues.push('claim groupDiversity: run_meta.group_diversity.curve must be a non-empty series');
  }

  if (Array.isArray(claims.rewardFamilies) && claims.rewardFamilies.length > 0) {
    const curves = runMeta.reward_family_curves || {};
    const missing = [];
    for (const fam of claims.rewardFamilies) {
      const series = curves[fam];
      if (!Array.isArray(series) || series.length === 0) missing.push(fam);
    }
    proven.rewardFamilies = missing.length === 0;
    if (missing.length > 0) {
      issues.push(`claim rewardFamilies: missing/empty pass-rate curves for ${missing.join(', ')}`);
    }
  }

  return { ok: issues.length === 0, proven, issues };
}

// foldRunMetaIntoReceipt(receipt, runMeta, claims) - additive, fail-closed fold of
// the run_meta block into a receipt. REFUSES to fold (throws) if the run_meta does
// not prove the run's claims -- the moat: the signed artifact never carries an
// un-backed frontier claim.
export function foldRunMetaIntoReceipt(receipt = {}, runMeta, claims = {}) {
  const verdict = assertRunMetaProvesEngagement(runMeta, claims);
  if (!verdict.ok) {
    _fail(
      'foldRunMetaIntoReceipt: run_meta does not prove the run claims (fail-closed; ' +
        'will not write an un-backed frontier claim into the signed receipt): ' +
        verdict.issues.join('; '),
    );
  }
  const train = { ...(receipt.train || {}) };
  train.run_meta = runMeta;
  train.run_meta_verdict = { proven: verdict.proven, schema: RUN_META_SCHEMA };
  return { ...receipt, train };
}

// preflightRunMeta({spawn}) - run the GPU-free python preflight
// (`python -m apps.trainer.dapo_runmeta --preflight`) and return the parsed
// run_meta sample. Proves the JS<->python contract end to end without a GPU. When
// python is absent, returns {ok:false, reason:'python_unavailable', hint:...}
// LOUD (never a fake-pass). NO network -- local spawn only.
export function preflightRunMeta({ spawn = spawnSync } = {}) {
  let r;
  try {
    r = spawn(_pythonBin(), ['-m', 'apps.trainer.dapo_runmeta', '--preflight'], {
      cwd: _repoRoot,
      stdio: 'pipe',
      timeout: 60000,
      encoding: 'utf8',
    });
  } catch (e) {
    return { ok: false, reason: 'python_spawn_error', hint: 'install python 3.10+', error: String(e && e.message || e) };
  }
  if (!r || r.status !== 0) {
    return {
      ok: false,
      reason: 'python_unavailable',
      hint: 'install python 3.10+ to record run-meta (apps/trainer/dapo_runmeta.py)',
      stderr: r ? String(r.stderr || '') : '',
    };
  }
  const out = String(r.stdout || '').trim();
  const lines = out.split('\n').filter(Boolean);
  const last = lines[lines.length - 1] || '{}';
  try {
    const parsed = JSON.parse(last);
    return { ok: true, runMeta: parsed.run_meta };
  } catch (e) {
    return { ok: false, reason: 'parse_error', stdout: out, error: String(e && e.message || e) };
  }
}

export default {
  RUN_META_SCHEMA,
  PAPERS,
  RUN_META_KNOBS,
  normalizeRunMetaConfig,
  buildRunMetaArgs,
  validateRunMetaGrpo,
  assertRunMetaProvesEngagement,
  foldRunMetaIntoReceipt,
  preflightRunMeta,
};
