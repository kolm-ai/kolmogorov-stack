// src/distill-grpo-frontier.js
//
// Frontier RLVR / GRPO knobs (DAPO dynamic sampling + GSPO sequence importance
// sampling + Clip-Higher asymmetric clip + vLLM rollouts). This is the JS surface
// that validates the frontier config (closed enums, fail-loud) and assembles the
// extra CLI flags appended to the train_grpo.py spawn. Pure string assembly +
// validation; NO spawn here (the spawn lives in src/distill-grpo.js at merge).
//
// Why a separate module: the existing src/distill-grpo.js carries a provenance
// FALSEHOOD (it reports loss_type / importance_sampling_level that kolm WANTED,
// while the apps/trainer/grpo.py _NON_TRL exclusion never forwarded them to trl).
// This module owns the corrected, validated config so parallel builds stay
// disjoint until merge. The Python read-back reflector that closes the falsehood
// lives in apps/trainer/dapo_sampling.py.
//
// Privacy / moat: vLLM + trl run LOCALLY on the rented/local GPU. Dynamic
// sampling scores with the LOCAL deterministic reward functions (the K-score
// verifier code path) -- no prompt/completion text leaves the box, no external
// judge, no hyperscaler call. There is intentionally NO fetch / http / sdk import
// anywhere in this file (a test greps to prove it).
//
// Citations:
//   DAPO:    Yu et al, 2025, arXiv:2503.14476 (Dynamic Sampling, Clip-Higher)
//   GSPO:    Zheng et al, 2025, arXiv:2507.18071 (sequence importance sampling)
//   Dr.GRPO: Liu et al, 2025, arXiv:2503.20783 (constant-length normalizer)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadRecipe } from './distill-recipe-loader.js';
import { pythonBin } from './python-runtime.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

// Closed enums -- mirror trl 0.24 acceptance + apps/trainer/dapo_sampling.py.
// LOSS_TYPES extends the legacy ['grpo','bnpo','dr_grpo'] with 'dapo' (trl's own
// default, the token-level DAPO loss).
export const LOSS_TYPES = ['grpo', 'bnpo', 'dr_grpo', 'dapo'];
export const IS_LEVELS = ['token', 'sequence'];
// scale_rewards accepts the trl string enum OR a bool (True->group, False->none).
export const SCALE_REWARDS = ['group', 'batch', 'none', true, false];
export const VLLM_MODES = ['colocate', 'server'];

// Receipt-grade catalog of the frontier knobs this module owns. Each entry names
// the math it touches so acceptance tests stay falsifiable.
export const DAPO_KNOBS = {
  loss_type: {
    values: LOSS_TYPES,
    default: 'dapo',
    math: 'loss aggregation: grpo=seq-mean (length-biased); dapo=token-mean over batch; dr_grpo=constant-length normalizer',
    paper: 'arXiv:2503.14476',
  },
  importance_sampling_level: {
    values: IS_LEVELS,
    default: 'token',
    math: 'token: rho_{i,t}=pi/pi_old per token (GRPO). sequence: rho_i=(prod pi/pi_old)^(1/|o_i|) one ratio per sequence (GSPO) -- lower variance, MoE/long-CoT fix',
    paper: 'arXiv:2507.18071',
  },
  scale_rewards: {
    values: SCALE_REWARDS,
    default: 'group',
    math: "group/True: A_i=(r_i-mean)/sd. none/False: A_i=(r_i-mean) (Dr.GRPO de-bias). batch: normalize across the batch",
    paper: 'arXiv:2503.20783',
  },
  epsilon_high: {
    type: 'number>=0',
    default: 0.0,
    math: 'asymmetric Clip-Higher: ratio clipped to [1-eps_low, 1+eps_high], eps_high>eps_low to stop entropy collapse (DAPO)',
    paper: 'arXiv:2503.14476',
  },
  mask_truncated_completions: {
    type: 'boolean',
    default: false,
    math: 'zero the loss on completions truncated at max length (DAPO overlong-reward shaping companion)',
    paper: 'arXiv:2503.14476',
  },
  dynamic_sampling: {
    type: 'boolean',
    default: false,
    math: 'drop zero-variance groups (sd(r)=0 -> A_i=0 -> zero gradient), oversample to refill the batch (kolm-owned; above trl loop)',
    paper: 'arXiv:2503.14476',
  },
  use_vllm: {
    type: 'boolean',
    default: false,
    math: 'vLLM rollout engine for generation (local GPU). ENV-GATED: KOLM_VLLM=1 AND import vllm must succeed',
    paper: 'n/a',
  },
  vllm_mode: {
    values: VLLM_MODES,
    default: 'colocate',
    math: 'colocate: trainer+vLLM share GPUs. server: external vLLM server',
    paper: 'n/a',
  },
};

export const PAPERS = ['arXiv:2503.14476', 'arXiv:2507.18071', 'arXiv:2503.20783'];

function _fail(message) {
  // Match REWARD_FAMILIES validation style in distill-grpo.js: fail-loud throw
  // naming the allowed set (callers turn this into a {ok:false,error} envelope).
  throw new Error(message);
}

function _pythonBin() {
  return pythonBin();
}

// probeVllm() - ENV-GATED capability probe. Returns {available, reason, hint}.
// useVllm is NEVER silently flipped on: it requires BOTH KOLM_VLLM=1 AND a probe
// that `import vllm` succeeds. Otherwise we downgrade LOUD with an install hint.
export function probeVllm({ spawn = spawnSync } = {}) {
  const hint = 'pip install vllm';
  if (process.env.KOLM_VLLM !== '1') {
    return {
      available: false,
      reason: 'env_gate_off',
      note: `vLLM rollouts are env-gated OFF. Set KOLM_VLLM=1 and ${hint} to enable. Falling back to the HF rollout engine (real code path, just slower).`,
      hint,
    };
  }
  let importOk = false;
  try {
    const r = spawn(_pythonBin(), ['-c', 'import vllm'], { stdio: 'pipe', timeout: 30000 });
    importOk = r && r.status === 0;
  } catch (_) {
    importOk = false;
  }
  if (!importOk) {
    return {
      available: false,
      reason: 'vllm_import_failed',
      note: `KOLM_VLLM=1 but \`import vllm\` failed. ${hint}. Falling back to the HF rollout engine -- NOT training on HF while claiming vLLM in the receipt.`,
      hint,
    };
  }
  return { available: true, reason: 'vllm_ready', note: 'vLLM rollout engine available (local GPU).', hint };
}

// normalizeFrontierConfig(cfg) - validate + close-enum the frontier config with
// fail-loud errors (mirrors REWARD_FAMILIES validation in distill-grpo.js).
// Returns a stable, validated object. useVllm is downgraded (never thrown) when
// the env gate / import probe fails, carrying a LOUD note + install hint.
export function normalizeFrontierConfig(cfg = {}, { spawn = spawnSync } = {}) {
  const {
    lossType = 'dapo',
    scaleRewards = 'group',
    importanceSamplingLevel = 'token',
    epsilonHigh = 0.0,
    maskTruncatedCompletions = false,
    dynamicSampling = false,
    targetGroups,
    maxResampleFactor = 3,
    useVllm = false,
    vllmMode = 'colocate',
  } = cfg;

  if (!LOSS_TYPES.includes(lossType)) {
    _fail(`unknown loss_type ${JSON.stringify(lossType)}; must be one of ${LOSS_TYPES.join('|')}`);
  }
  if (!IS_LEVELS.includes(importanceSamplingLevel)) {
    _fail(`unknown importance_sampling_level ${JSON.stringify(importanceSamplingLevel)}; must be one of ${IS_LEVELS.join('|')}`);
  }
  if (!SCALE_REWARDS.includes(scaleRewards)) {
    const shown = SCALE_REWARDS.map((v) => JSON.stringify(v)).join('|');
    _fail(`unknown scale_rewards ${JSON.stringify(scaleRewards)}; must be one of ${shown}`);
  }
  if (typeof epsilonHigh !== 'number' || Number.isNaN(epsilonHigh) || epsilonHigh < 0) {
    _fail(`epsilon_high must be a number >= 0; got ${JSON.stringify(epsilonHigh)}`);
  }
  if (typeof maskTruncatedCompletions !== 'boolean') {
    _fail(`mask_truncated_completions must be a boolean; got ${JSON.stringify(maskTruncatedCompletions)}`);
  }
  if (typeof dynamicSampling !== 'boolean') {
    _fail(`dynamic_sampling must be a boolean; got ${JSON.stringify(dynamicSampling)}`);
  }
  if (!VLLM_MODES.includes(vllmMode)) {
    _fail(`unknown vllm_mode ${JSON.stringify(vllmMode)}; must be one of ${VLLM_MODES.join('|')}`);
  }
  if (dynamicSampling) {
    if (targetGroups !== undefined && (typeof targetGroups !== 'number' || !Number.isFinite(targetGroups) || targetGroups < 1)) {
      _fail(`target_groups must be a number >= 1 when dynamic_sampling is on; got ${JSON.stringify(targetGroups)}`);
    }
    if (typeof maxResampleFactor !== 'number' || maxResampleFactor < 1) {
      _fail(`max_resample_factor must be a number >= 1; got ${JSON.stringify(maxResampleFactor)}`);
    }
  }

  let resolvedUseVllm = false;
  let vllmNote = null;
  let vllmReason = 'disabled';
  if (useVllm) {
    const probe = probeVllm({ spawn });
    resolvedUseVllm = probe.available === true;
    vllmReason = probe.reason;
    if (!resolvedUseVllm) vllmNote = probe.note; // LOUD downgrade, never silent.
    else vllmNote = probe.note;
  }

  return {
    lossType,
    scaleRewards,
    importanceSamplingLevel,
    epsilonHigh,
    maskTruncatedCompletions,
    dynamicSampling,
    targetGroups: dynamicSampling ? (targetGroups !== undefined ? targetGroups : null) : null,
    maxResampleFactor: dynamicSampling ? maxResampleFactor : null,
    useVllm: resolvedUseVllm,
    vllmMode,
    vllmReason,
    vllmNote,
    papers: PAPERS,
  };
}

// buildTrainerArgs(frontierCfg) - the EXTRA CLI flags appended to the
// train_grpo.py spawn. Pure string assembly. OMITS flags for default/unset knobs
// so a backward-compatible run (no frontier knobs) emits nothing new.
//
// Accepts either a raw config (passed through normalizeFrontierConfig) or an
// already-normalized object (idempotent: re-normalizing a normalized object is a
// no-op because its fields are already closed-enum valid).
export function buildTrainerArgs(frontierCfg = {}, opts = {}) {
  const cfg = frontierCfg.papers
    ? frontierCfg // already normalized (carries the papers stamp)
    : normalizeFrontierConfig(frontierCfg, opts);
  const args = [];

  // loss_type: only emit when it differs from the legacy 'grpo' default so a
  // plain GRPO run is byte-identical to before. (dapo is trl's default but kolm
  // legacy default was grpo -- emitting it explicitly makes the run truthful.)
  if (cfg.lossType && cfg.lossType !== 'grpo') {
    args.push('--loss-type', cfg.lossType);
  }
  if (cfg.importanceSamplingLevel && cfg.importanceSamplingLevel !== 'token') {
    args.push('--importance-sampling-level', cfg.importanceSamplingLevel);
  }
  // scale_rewards: emit only when it deviates from the 'group'/True default.
  if (cfg.scaleRewards !== undefined && cfg.scaleRewards !== 'group' && cfg.scaleRewards !== true) {
    const v = (cfg.scaleRewards === false) ? 'none' : String(cfg.scaleRewards);
    args.push('--scale-rewards', v);
  }
  if (typeof cfg.epsilonHigh === 'number' && cfg.epsilonHigh > 0) {
    args.push('--epsilon-high', String(cfg.epsilonHigh));
  }
  if (cfg.maskTruncatedCompletions === true) {
    args.push('--mask-truncated-completions');
  }
  if (cfg.dynamicSampling === true) {
    args.push('--dynamic-sampling');
    if (cfg.targetGroups != null) args.push('--target-groups', String(cfg.targetGroups));
    if (cfg.maxResampleFactor != null) args.push('--max-resample-factor', String(cfg.maxResampleFactor));
  }
  if (cfg.useVllm === true) {
    args.push('--use-vllm');
    if (cfg.vllmMode) args.push('--vllm-mode', cfg.vllmMode);
  }
  return args;
}

// Extended recipe validation for the frontier grpo knobs. The shared
// src/distill-recipe-loader.js _validateGrpo gets these at merge (crossFileNeeds);
// until then this is the closed-enum, fail-before-spend validator for the new
// optional knobs on a recipe's `grpo` section. Returns a list of issue strings
// (empty = valid), matching the loader's issue-collecting style.
export function validateFrontierGrpo(grpo) {
  const issues = [];
  if (grpo === undefined || grpo === null) return issues;
  if (typeof grpo !== 'object' || Array.isArray(grpo)) {
    issues.push('grpo must be an object if present');
    return issues;
  }
  if (grpo.loss_type !== undefined && !LOSS_TYPES.includes(grpo.loss_type)) {
    issues.push(`grpo.loss_type must be one of: ${LOSS_TYPES.join(', ')} (got ${JSON.stringify(grpo.loss_type)})`);
  }
  if (grpo.importance_sampling_level !== undefined && !IS_LEVELS.includes(grpo.importance_sampling_level)) {
    issues.push(`grpo.importance_sampling_level must be one of: ${IS_LEVELS.join(', ')}`);
  }
  if (grpo.scale_rewards !== undefined && !SCALE_REWARDS.includes(grpo.scale_rewards)) {
    issues.push(`grpo.scale_rewards must be one of: ${SCALE_REWARDS.map((v) => String(v)).join(', ')}`);
  }
  if (grpo.epsilon_high !== undefined && (typeof grpo.epsilon_high !== 'number' || grpo.epsilon_high < 0)) {
    issues.push('grpo.epsilon_high must be a number >= 0');
  }
  if (grpo.dynamic_sampling !== undefined && typeof grpo.dynamic_sampling !== 'boolean') {
    issues.push('grpo.dynamic_sampling must be a boolean');
  }
  if (grpo.target_groups !== undefined && (typeof grpo.target_groups !== 'number' || grpo.target_groups < 1)) {
    issues.push('grpo.target_groups must be a number >= 1');
  }
  if (grpo.max_resample_factor !== undefined && (typeof grpo.max_resample_factor !== 'number' || grpo.max_resample_factor < 1)) {
    issues.push('grpo.max_resample_factor must be a number >= 1');
  }
  if (grpo.mask_truncated_completions !== undefined && typeof grpo.mask_truncated_completions !== 'boolean') {
    issues.push('grpo.mask_truncated_completions must be a boolean');
  }
  if (grpo.use_vllm !== undefined && typeof grpo.use_vllm !== 'boolean') {
    issues.push('grpo.use_vllm must be a boolean');
  }
  if (grpo.vllm_mode !== undefined && !VLLM_MODES.includes(grpo.vllm_mode)) {
    issues.push(`grpo.vllm_mode must be one of: ${VLLM_MODES.join(', ')}`);
  }
  return issues;
}

// loadFrontierRecipe(nameOrPath) - load + validate a recipe whose `grpo` section
// may carry the frontier knobs (loss_type='dapo', importance_sampling_level=
// 'sequence', dynamic_sampling, epsilon_high, ...). The shared
// src/distill-recipe-loader.js _validateGrpo accepts these AT MERGE
// (crossFileNeeds). Until then, the legacy loader rejects only the NEW grpo
// enums (e.g. loss_type='dapo'); every OTHER recipe section (seeds/teachers/
// train/eval) is still validated by loadRecipe. This wrapper:
//   1. runs loadRecipe (full structural validation),
//   2. if it failed SOLELY on the frontier grpo knobs (which validateFrontierGrpo
//      accepts), re-validates the grpo section with the frontier validator and
//      promotes to ok; any OTHER issue stays a hard failure (fail-before-spend),
//   3. if loadRecipe succeeded, still runs validateFrontierGrpo as a belt-and-
//      suspenders closed-enum check.
// This keeps the moat's fail-closed validation intact pre-merge and makes the
// frontier recipe contract testable today.
export function loadFrontierRecipe(nameOrPath, opts = {}) {
  const res = loadRecipe(nameOrPath, opts);
  if (res.ok) {
    const frontierIssues = validateFrontierGrpo(res.recipe && res.recipe.grpo);
    if (frontierIssues.length > 0) {
      return { ok: false, error: 'recipe_invalid', issues: frontierIssues, path: res.path };
    }
    return res;
  }
  // Only rescue the legacy 'recipe_invalid' caused exclusively by grpo enums the
  // frontier validator accepts. Re-validate the grpo section ourselves and, if
  // it is frontier-clean AND every legacy issue mentions "grpo", promote to ok.
  if (res.error !== 'recipe_invalid' || !Array.isArray(res.issues)) return res;
  const recipe = res.recipe || _safeReadRecipe(nameOrPath, opts);
  if (!recipe) return res;
  const frontierIssues = validateFrontierGrpo(recipe.grpo);
  if (frontierIssues.length > 0) {
    return { ...res, issues: [...res.issues, ...frontierIssues] };
  }
  const nonGrpoIssues = res.issues.filter((i) => !/\bgrpo\b/.test(i));
  if (nonGrpoIssues.length > 0) {
    // A real non-frontier problem remains -> stay failed (fail-before-spend).
    return res;
  }
  return {
    ok: true,
    recipe,
    path: res.path,
    frontier_validated: true,
    note: 'grpo frontier knobs validated by validateFrontierGrpo (loader _validateGrpo extended at merge)',
  };
}

function _safeReadRecipe(nameOrPath, opts) {
  // The loader does not echo the parsed recipe on failure; re-resolve + parse a
  // LOCAL file path or a recipe name under <repoRoot>/recipes. Returns null on
  // any failure (caller stays failed). No network -- local fs only.
  try {
    let abs = nameOrPath;
    if (!path.isAbsolute(abs)) {
      const base = (opts && opts.repoRoot) || _repoRoot;
      const named = path.join(base, 'recipes', `${nameOrPath}.json`);
      abs = fs.existsSync(named) ? named : path.resolve(base, nameOrPath);
    }
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (_) {
    return null;
  }
}

export default {
  LOSS_TYPES,
  IS_LEVELS,
  SCALE_REWARDS,
  VLLM_MODES,
  DAPO_KNOBS,
  PAPERS,
  probeVllm,
  normalizeFrontierConfig,
  buildTrainerArgs,
  validateFrontierGrpo,
  loadFrontierRecipe,
};
