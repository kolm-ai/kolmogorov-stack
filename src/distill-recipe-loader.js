// src/distill-recipe-loader.js
//
// T1.6 - one-shot recipe loader. Resolves a recipe by name OR path, validates
// the 6 required top-level sections, and returns a normalized object plus a
// content hash. The CLI's `kolm distill --recipe <name>` uses this to dispatch
// the matching orchestrator script (today: trinity-2000-v2-run.mjs); future
// W910 Track A entries (--data / --describe) mount on the same loader.
//
// Validation philosophy: a recipe is a contract between the user and the
// pipeline. If a key is missing or malformed we fail BEFORE any teacher spend
// - the upstream of the cost-preview gate (T1.2) and the preflight gate
// (T1.1). Wrong types are errors, not silent coercions.
//
// Schema (v1, flat JSON, no DSL yet - T3.1 evolves this into composable YAML):
//   name             string  (required)
//   version          string  (required)
//   description      string  (optional)
//   seeds            object  (required)
//     .target        number  (required)
//     .generator     string  (required - path relative to repo)
//     .buckets       object<string,number>  (optional)
//   teachers         array   (required, length >= 1)
//     [].slug        string  (required, "vendor:model" shape)
//     [].rows        number  (required, >0)
//     [].weight      number  (optional, derived from rows if absent)
//     [].source      string  (optional)
//   scrub            object  (optional but recommended)
//     .cot           object
//       .markers_path  string  (path to cot_markers.json - T1.5)
//       .strategy      string
//       .drop_if_no_close_tag  boolean
//   train            object  (required)
//     .method                  string  (required: 'qlora' | 'lora' | 'full')
//     .student_base            string  (required)
//     .epochs                  number  (required)
//     .batch_size              number  (required)
//     ... see Trinity recipe for the full hyperparam list
//   eval             object  (optional)
//   system_prompt    string  (optional)
//
// Returned shape:
//   {
//     ok: true,
//     recipe: <normalized object>,
//     hash: 'sha256:<hex>',         // sha256 of the on-disk file bytes
//     path: '<abs path to recipe file>',
//     orchestrator: '<abs path to runner mjs>',  // dispatched by name
//   }
// On failure:
//   { ok: false, error: '<machine code>', message: '<human msg>', missing?: [...] }

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// C4 - pure, dependency-free closed-enum validators for the frontier (DAPO/GSPO/
// vLLM) + run-meta grpo knobs. Both return [] for a recipe that carries none of
// the new keys, so importing them cannot change validation of existing recipes.
import { validateFrontierGrpo } from './distill-grpo-frontier.js';
import { validateRunMetaGrpo } from './distill-grpo-runmeta.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

// Orchestrator dispatch - each recipe name (or family prefix) maps to a runner
// script. New recipes plug in here OR use the recipe's optional `orchestrator`
// field. Kept tiny on purpose: T1.6 is about the loader contract; T3.1 will
// generalize via the DSL.
const ORCHESTRATOR_MAP = {
  'trinity-2000': 'scripts/trinity-2000-v2-run.mjs',
};

const VALID_TRAIN_METHODS = new Set(['qlora', 'lora', 'full']);
const VALID_TRAIN_BACKENDS = new Set(['auto', 'hf', 'unsloth']);
const VALID_TRAIN_PRESETS = new Set(['qdora']);

// W921 - additive recipe vocabulary.
// Distillation OBJECTIVE (loss). seqkd is the SFT-on-strings default; the
// logit-level objectives (forward_kl/reverse_kl/jsd/distillm2/gkd) require a
// LOCAL teacher (logits), enforced by _validateDistill.
// W921/W956 - 'ropd' and 'gad' are black-box on-policy objectives: they score
// student rollouts with teacher TEXT only (no logits), so they are valid with
// API teachers and intentionally NOT in LOGIT_OBJECTIVES.
const VALID_OBJECTIVES = new Set(['seqkd', 'forward_kl', 'reverse_kl', 'jsd', 'distillm2', 'gkd', 'ropd', 'gad']);
// Objectives that need teacher LOGITS (API teachers are text-only).
const LOGIT_OBJECTIVES = new Set(['forward_kl', 'reverse_kl', 'jsd', 'distillm2', 'gkd']);
// LoRA-variant vocabulary (kept in sync with src/distill-efficiency.js).
const VALID_LORA_VARIANTS = new Set(['lora', 'rslora', 'dora', 'qdora', 'loraplus', 'lora-fa']);
const VALID_LORA_INITS = new Set(['default', 'gaussian', 'pissa', 'pissa_niter_16', 'olora']);
const VALID_OPTIMS = new Set([
  'adamw_torch', 'adamw_8bit', 'paged_adamw_8bit',
  'galore_adamw', 'galore_adamw_8bit', 'galore_adamw_layerwise', 'galore_adafactor',
]);
// GRPO loss variants (trl). C4 adds 'dapo' (the DAPO objective: clip-higher +
// dynamic sampling + soft overlong punishment) so the frontier recipe validates
// through the shared loader. 'bogus'/unknown still reject.
const VALID_GRPO_LOSS_TYPES = new Set(['grpo', 'bnpo', 'dr_grpo', 'dapo']);
const VALID_GRPO_IS_LEVELS = new Set(['token', 'sequence']);
// C4 - scale_rewards may be a boolean (legacy) OR one of the trl string modes.
const VALID_GRPO_SCALE_REWARDS = new Set(['group', 'batch', 'none']);
const VALID_GRPO_REWARDS = new Set(['code_exec', 'math_checker', 'schema_validator', 'format', 'kolm_verifier']);
// Preference objectives (kept in sync with src/distill-preference.js).
const VALID_PREFERENCE_OBJECTIVES = new Set(['dpo', 'simpo', 'orpo', 'kto', 'sppo']);
// Synthetic-data cold-start generators.
const VALID_SYNTH_GENERATORS = new Set(['magpie', 'evol', 'persona-hub', 'glan', 'self-instruct']);

function _isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function _teacherIsLocal(recipe) {
  // A recipe's teacher is "local" (has logits) when ANY teacher slug names a
  // local vendor OR the recipe explicitly flags a local teacher endpoint.
  if (recipe && recipe.distill && recipe.distill.teacher_local === true) return true;
  if (recipe && typeof recipe.teacher_local === 'string' && recipe.teacher_local.length > 0) return true;
  const teachers = (recipe && Array.isArray(recipe.teachers)) ? recipe.teachers : [];
  return teachers.some((t) => {
    const slug = (t && typeof t.slug === 'string') ? t.slug.toLowerCase() : '';
    const vendor = slug.split(':')[0];
    return vendor === 'local' || vendor === 'hf' || vendor === 'vllm' || vendor === 'ollama';
  });
}

function _sha256OfFile(absPath) {
  const buf = fs.readFileSync(absPath);
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

// Resolve a recipe identifier to an absolute path.
//   - absolute path -> used as-is
//   - path containing a slash/backslash AND ending in .json -> resolve from cwd
//   - bare name -> resolved to <repoRoot>/recipes/<name>.json
function _resolveRecipePath(nameOrPath, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  if (!nameOrPath || typeof nameOrPath !== 'string') {
    return { ok: false, error: 'bad_recipe_name', message: 'recipe name must be a non-empty string' };
  }
  if (path.isAbsolute(nameOrPath)) {
    return { ok: true, abs: nameOrPath };
  }
  const looksLikePath = /[\\/]/.test(nameOrPath) || /\.json$/i.test(nameOrPath);
  if (looksLikePath) {
    return { ok: true, abs: path.resolve(cwd, nameOrPath) };
  }
  const abs = path.join(_repoRoot, 'recipes', nameOrPath + '.json');
  return { ok: true, abs };
}

function _validateSeeds(seeds) {
  const issues = [];
  if (!_isPlainObject(seeds)) {
    issues.push('seeds must be an object');
    return issues;
  }
  if (typeof seeds.target !== 'number' || seeds.target <= 0) {
    issues.push('seeds.target must be a positive number');
  }
  if (typeof seeds.generator !== 'string' || seeds.generator.length === 0) {
    issues.push('seeds.generator must be a non-empty string (path relative to repo)');
  }
  if (seeds.buckets !== undefined) {
    if (!_isPlainObject(seeds.buckets)) {
      issues.push('seeds.buckets must be an object<string,number> if present');
    } else {
      let total = 0;
      for (const [k, v] of Object.entries(seeds.buckets)) {
        if (typeof v !== 'number' || v < 0) {
          issues.push(`seeds.buckets.${k} must be a non-negative number (got ${v})`);
        } else {
          total += v;
        }
      }
      if (total !== seeds.target) {
        issues.push(`seeds.buckets total ${total} != seeds.target ${seeds.target}`);
      }
    }
  }
  return issues;
}

function _validateTeachers(teachers) {
  const issues = [];
  if (!Array.isArray(teachers) || teachers.length === 0) {
    issues.push('teachers must be a non-empty array');
    return issues;
  }
  let totalRows = 0;
  let weightSum = 0;
  for (let i = 0; i < teachers.length; i++) {
    const t = teachers[i];
    const tag = `teachers[${i}]`;
    if (!_isPlainObject(t)) {
      issues.push(`${tag} must be an object`);
      continue;
    }
    if (typeof t.slug !== 'string' || !t.slug.includes(':')) {
      issues.push(`${tag}.slug must be 'vendor:model' (got ${JSON.stringify(t.slug)})`);
    }
    if (typeof t.rows !== 'number' || t.rows <= 0) {
      issues.push(`${tag}.rows must be a positive number`);
    } else {
      totalRows += t.rows;
    }
    if (t.weight !== undefined) {
      if (typeof t.weight !== 'number' || t.weight < 0 || t.weight > 1) {
        issues.push(`${tag}.weight must be in [0,1] if present`);
      } else {
        weightSum += t.weight;
      }
    }
  }
  // If weights are present on every teacher, they should sum to ~1 (±0.01).
  const allHaveWeights = teachers.every((t) => typeof t.weight === 'number');
  if (allHaveWeights && Math.abs(weightSum - 1) > 0.01) {
    issues.push(`teacher weights sum to ${weightSum.toFixed(3)}, expected 1.0 (±0.01)`);
  }
  return issues;
}

function _validateTrain(train) {
  const issues = [];
  if (!_isPlainObject(train)) {
    issues.push('train must be an object');
    return issues;
  }
  const effectiveMethod = train.method ?? (train.preset === 'qdora' ? 'qlora' : undefined);
  if (!VALID_TRAIN_METHODS.has(effectiveMethod)) {
    issues.push(`train.method must be one of: ${Array.from(VALID_TRAIN_METHODS).join(', ')} (got ${JSON.stringify(train.method)})`);
  }
  if (typeof train.student_base !== 'string' || train.student_base.length === 0) {
    issues.push('train.student_base must be a non-empty string (HF repo id)');
  }
  if (train.backend !== undefined && !VALID_TRAIN_BACKENDS.has(train.backend)) {
    issues.push(`train.backend must be one of: ${Array.from(VALID_TRAIN_BACKENDS).join(', ')} (got ${JSON.stringify(train.backend)})`);
  }
  if (train.preset !== undefined && !VALID_TRAIN_PRESETS.has(train.preset)) {
    issues.push(`train.preset must be one of: ${Array.from(VALID_TRAIN_PRESETS).join(', ')} (got ${JSON.stringify(train.preset)})`);
  }
  if (train.preset === 'qdora' && train.method !== undefined && train.method !== 'qlora') {
    issues.push('train.preset=qdora requires train.method=qlora so the receipt cannot claim QDoRA while running plain LoRA');
  }
  const numericKeys = ['epochs', 'batch_size', 'lr', 'max_seq_len'];
  for (const k of numericKeys) {
    if (train[k] === undefined) {
      issues.push(`train.${k} is required`);
    } else if (typeof train[k] !== 'number' || train[k] <= 0) {
      issues.push(`train.${k} must be a positive number (got ${JSON.stringify(train[k])})`);
    }
  }
  // LoRA-specific knobs only matter for qlora/lora.
  if (effectiveMethod === 'qlora' || effectiveMethod === 'lora') {
    if (!_isPlainObject(train.lora)) {
      issues.push('train.lora must be an object for method=qlora|lora');
    } else {
      if (typeof train.lora.r !== 'number' || train.lora.r <= 0) {
        issues.push('train.lora.r must be a positive number');
      }
      if (typeof train.lora.alpha !== 'number' || train.lora.alpha <= 0) {
        issues.push('train.lora.alpha must be a positive number');
      }
    }
  }

  // W921 - optional LoRA-variant / optimizer / packing knobs. Closed-enum,
  // fail-before-spend. All optional; absence keeps the legacy default path.
  if (train.lora_variant !== undefined && !VALID_LORA_VARIANTS.has(train.lora_variant)) {
    issues.push(`train.lora_variant must be one of: ${Array.from(VALID_LORA_VARIANTS).join(', ')} (got ${JSON.stringify(train.lora_variant)})`);
  }
  if (train.lora_init !== undefined && !VALID_LORA_INITS.has(train.lora_init)) {
    issues.push(`train.lora_init must be one of: ${Array.from(VALID_LORA_INITS).join(', ')} (got ${JSON.stringify(train.lora_init)})`);
  }
  if (train.optim !== undefined && !VALID_OPTIMS.has(train.optim)) {
    issues.push(`train.optim must be one of: ${Array.from(VALID_OPTIMS).join(', ')} (got ${JSON.stringify(train.optim)})`);
  }
  // GaLore is incompatible with 4-bit (qlora) - refuse before spend.
  if (typeof train.optim === 'string' && train.optim.startsWith('galore') && effectiveMethod === 'qlora') {
    issues.push('train.optim galore_* is incompatible with method=qlora (4-bit params); use method=full');
  }
  if (train.neftune_alpha !== undefined) {
    if (typeof train.neftune_alpha !== 'number' || train.neftune_alpha < 0) {
      issues.push('train.neftune_alpha must be a non-negative number');
    }
  }
  if (train.packing !== undefined && typeof train.packing !== 'boolean') {
    issues.push('train.packing must be a boolean');
  }
  if (train.galore !== undefined) {
    if (!_isPlainObject(train.galore)) {
      issues.push('train.galore must be an object');
    } else {
      for (const k of ['rank', 'update_proj_gap']) {
        if (train.galore[k] !== undefined && (typeof train.galore[k] !== 'number' || train.galore[k] <= 0)) {
          issues.push(`train.galore.${k} must be a positive number`);
        }
      }
    }
  }
  return issues;
}

// W921 - optional `distill` section: selects the distillation OBJECTIVE (loss).
// distillm2 / gkd / *_kl require a LOCAL teacher (logits); we refuse them on an
// API-only recipe (fail-before-spend) so the receipt never claims a logit-level
// objective it could not have computed.
function _validateDistill(distill, recipe) {
  const issues = [];
  if (distill === undefined) return issues; // optional
  if (!_isPlainObject(distill)) {
    issues.push('distill must be an object if present');
    return issues;
  }
  const objective = distill.objective;
  if (objective !== undefined && !VALID_OBJECTIVES.has(objective)) {
    issues.push(`distill.objective must be one of: ${Array.from(VALID_OBJECTIVES).join(', ')} (got ${JSON.stringify(objective)})`);
  }
  if (typeof objective === 'string' && LOGIT_OBJECTIVES.has(objective) && !_teacherIsLocal(recipe)) {
    issues.push(`distill.objective='${objective}' requires a LOCAL teacher (logits); the recipe's teacher is API-only (no logits). Set distill.teacher_local=true or use a local: teacher slug, or pick objective=seqkd.`);
  }
  if (distill.base_alpha !== undefined && (typeof distill.base_alpha !== 'number' || distill.base_alpha <= 0 || distill.base_alpha > 1)) {
    issues.push('distill.base_alpha must be a number in (0,1]');
  }
  if (distill.gradual_beta !== undefined && typeof distill.gradual_beta !== 'boolean') {
    issues.push('distill.gradual_beta must be a boolean');
  }
  if (distill.on_policy !== undefined && typeof distill.on_policy !== 'boolean') {
    issues.push('distill.on_policy must be a boolean');
  }
  if (distill.beta !== undefined && (typeof distill.beta !== 'number' || distill.beta < 0)) {
    issues.push('distill.beta must be a non-negative number (GKD JSD interpolation)');
  }
  if (distill.temperature !== undefined && (typeof distill.temperature !== 'number' || distill.temperature <= 0)) {
    issues.push('distill.temperature must be a positive number');
  }
  return issues;
}

// W956 - optional `gad` section: Generative Adversarial Distillation black-box
// minimax stage. This validates the recipe contract before any teacher/GPU
// spend; the executable surface is `kolm distill onpolicy --gad`.
function _validateGad(gad) {
  const issues = [];
  if (gad === undefined) return issues;
  if (!_isPlainObject(gad)) {
    issues.push('gad must be an object if present');
    return issues;
  }
  if (gad.objective !== undefined && gad.objective !== 'gad') {
    issues.push(`gad.objective must be "gad" (got ${JSON.stringify(gad.objective)})`);
  }
  if (gad.trainer !== undefined && typeof gad.trainer !== 'string') {
    issues.push('gad.trainer must be a string if present');
  }
  if (gad.teacher_regime !== undefined && gad.teacher_regime !== 'black_box_text') {
    issues.push('gad.teacher_regime must be "black_box_text"');
  }
  if (gad.teacher_local !== undefined && typeof gad.teacher_local !== 'boolean') {
    issues.push('gad.teacher_local must be a boolean');
  }
  if (gad.teacher_local === true) {
    issues.push('gad.teacher_local must be false for black-box GAD (teacher TEXT only, no logits)');
  }
  const ints = [
    ['num_rollouts', 2],
    ['num_teacher_refs', 1],
    ['discriminator_steps', 1],
    ['max_completion_length', 1],
    ['max_steps', 1],
  ];
  for (const [k, min] of ints) {
    if (gad[k] !== undefined && (!Number.isInteger(gad[k]) || gad[k] < min)) {
      issues.push(`gad.${k} must be an integer >= ${min}`);
    }
  }
  const positive = ['discriminator_lr', 'learning_rate', 'reward_temperature', 'temperature'];
  for (const k of positive) {
    if (gad[k] !== undefined && (typeof gad[k] !== 'number' || gad[k] <= 0)) {
      issues.push(`gad.${k} must be a positive number`);
    }
  }
  if (gad.collapse_penalty !== undefined
    && (typeof gad.collapse_penalty !== 'number' || gad.collapse_penalty < 0)) {
    issues.push('gad.collapse_penalty must be a non-negative number');
  }
  if (gad.papers !== undefined && !Array.isArray(gad.papers)) {
    issues.push('gad.papers must be an array if present');
  }
  return issues;
}

// W921 - optional `grpo` section: verifiable-reward RL fine-tuning stage.
function _validateGrpo(grpo) {
  const issues = [];
  if (grpo === undefined) return issues; // optional
  if (!_isPlainObject(grpo)) {
    issues.push('grpo must be an object if present');
    return issues;
  }
  // reward (string) or rewards (array). At least one required for a grpo stage.
  let rewards = [];
  if (typeof grpo.reward === 'string') rewards = [grpo.reward];
  else if (Array.isArray(grpo.rewards)) rewards = grpo.rewards;
  else issues.push('grpo requires reward (string) or rewards (array)');
  for (const r of rewards) {
    if (!VALID_GRPO_REWARDS.has(r)) {
      issues.push(`grpo reward must be one of: ${Array.from(VALID_GRPO_REWARDS).join(', ')} (got ${JSON.stringify(r)})`);
    }
  }
  if (grpo.loss_type !== undefined && !VALID_GRPO_LOSS_TYPES.has(grpo.loss_type)) {
    issues.push(`grpo.loss_type must be one of: ${Array.from(VALID_GRPO_LOSS_TYPES).join(', ')}`);
  }
  if (grpo.importance_sampling_level !== undefined && !VALID_GRPO_IS_LEVELS.has(grpo.importance_sampling_level)) {
    issues.push(`grpo.importance_sampling_level must be one of: ${Array.from(VALID_GRPO_IS_LEVELS).join(', ')}`);
  }
  if (grpo.num_generations !== undefined && (typeof grpo.num_generations !== 'number' || grpo.num_generations < 2)) {
    issues.push('grpo.num_generations must be a number >= 2 (group size)');
  }
  if (grpo.max_completion_length !== undefined && (typeof grpo.max_completion_length !== 'number' || grpo.max_completion_length <= 0)) {
    issues.push('grpo.max_completion_length must be a positive number');
  }
  if (grpo.scale_rewards !== undefined
    && typeof grpo.scale_rewards !== 'boolean'
    && !VALID_GRPO_SCALE_REWARDS.has(grpo.scale_rewards)) {
    issues.push(`grpo.scale_rewards must be a boolean or one of: ${Array.from(VALID_GRPO_SCALE_REWARDS).join(', ')}`);
  }
  // C4 - validate the frontier (DAPO/GSPO/vLLM) + run-meta knobs via the same
  // closed-enum, fail-before-spend validators the trainer-arg builders use, so
  // a malformed frontier recipe is rejected by the SHARED loader before any GPU
  // spend. Both validators are additive: a recipe with none of these keys
  // returns no issues, so existing recipes validate exactly as before.
  for (const i of validateFrontierGrpo(grpo)) issues.push(i);
  for (const i of validateRunMetaGrpo(grpo)) issues.push(i);
  return issues;
}

// W921 - optional `preference` section: SimPO/ORPO/KTO/DPO/SPPO stage.
function _validatePreference(pref) {
  const issues = [];
  if (pref === undefined) return issues;
  if (!_isPlainObject(pref)) {
    issues.push('preference must be an object if present');
    return issues;
  }
  if (pref.objective !== undefined && !VALID_PREFERENCE_OBJECTIVES.has(pref.objective)) {
    issues.push(`preference.objective must be one of: ${Array.from(VALID_PREFERENCE_OBJECTIVES).join(', ')}`);
  }
  if (pref.beta !== undefined && (typeof pref.beta !== 'number' || pref.beta < 0)) {
    issues.push('preference.beta must be a non-negative number');
  }
  if (pref.min_pairs !== undefined && (typeof pref.min_pairs !== 'number' || pref.min_pairs < 0)) {
    issues.push('preference.min_pairs must be a non-negative number');
  }
  return issues;
}

// W921 - optional `synth` section: synthetic-data cold-start AUGMENT stage.
function _validateSynth(synth) {
  const issues = [];
  if (synth === undefined) return issues;
  if (!_isPlainObject(synth)) {
    issues.push('synth must be an object if present');
    return issues;
  }
  let gens = [];
  if (typeof synth.generator === 'string') gens = [synth.generator];
  else if (Array.isArray(synth.generators)) gens = synth.generators;
  else if (synth.generator !== undefined || synth.generators !== undefined) {
    issues.push('synth.generator must be a string or synth.generators an array');
  }
  for (const g of gens) {
    if (!VALID_SYNTH_GENERATORS.has(g)) {
      issues.push(`synth generator must be one of: ${Array.from(VALID_SYNTH_GENERATORS).join(', ')} (got ${JSON.stringify(g)})`);
    }
  }
  if (synth.target !== undefined && (typeof synth.target !== 'number' || synth.target <= 0)) {
    issues.push('synth.target must be a positive number');
  }
  if (synth.max_share !== undefined && (typeof synth.max_share !== 'number' || synth.max_share < 0 || synth.max_share > 1)) {
    issues.push('synth.max_share must be a number in [0,1]');
  }
  return issues;
}

function _validateScrub(scrub) {
  const issues = [];
  if (scrub === undefined) return issues; // optional
  if (!_isPlainObject(scrub)) {
    issues.push('scrub must be an object if present');
    return issues;
  }
  if (scrub.cot !== undefined) {
    if (!_isPlainObject(scrub.cot)) {
      issues.push('scrub.cot must be an object');
    } else {
      if (scrub.cot.markers_path !== undefined && typeof scrub.cot.markers_path !== 'string') {
        issues.push('scrub.cot.markers_path must be a string if present');
      }
    }
  }
  return issues;
}

// Public - load + validate a recipe. Returns the envelope above. Throws ONLY
// on programmer errors (bad argument types); recipe-validation failures are
// returned as ok:false envelopes for clean CLI/server error paths.
export function loadRecipe(nameOrPath, opts = {}) {
  const resolved = _resolveRecipePath(nameOrPath, opts);
  if (!resolved.ok) return resolved;
  const abs = resolved.abs;
  if (!fs.existsSync(abs)) {
    // Provide a helpful list of available recipes when the user passed a bare name.
    let available = [];
    try {
      const recipesDir = path.join(_repoRoot, 'recipes');
      if (fs.existsSync(recipesDir)) {
        available = fs.readdirSync(recipesDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
      }
    } catch { /* dir read failure is non-fatal */ }
    return {
      ok: false,
      error: 'recipe_not_found',
      message: `recipe not found: ${abs}`,
      path: abs,
      available_recipes: available,
    };
  }

  let raw, recipe;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: 'recipe_read_failed', message: e.message, path: abs };
  }
  try {
    recipe = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'recipe_parse_failed', message: `invalid JSON: ${e.message}`, path: abs };
  }

  // Top-level required keys.
  const issues = [];
  if (typeof recipe.name !== 'string' || recipe.name.length === 0) {
    issues.push('top-level "name" must be a non-empty string');
  }
  if (typeof recipe.version !== 'string' || recipe.version.length === 0) {
    issues.push('top-level "version" must be a non-empty string');
  }
  issues.push(..._validateSeeds(recipe.seeds));
  issues.push(..._validateTeachers(recipe.teachers));
  issues.push(..._validateScrub(recipe.scrub));
  issues.push(..._validateTrain(recipe.train));
  // W921 - additive opt-in sections. All optional; a recipe without them is
  // validated exactly as before (backward-compat).
  issues.push(..._validateDistill(recipe.distill, recipe));
  issues.push(..._validateGad(recipe.gad));
  issues.push(..._validateGrpo(recipe.grpo));
  issues.push(..._validatePreference(recipe.preference));
  issues.push(..._validateSynth(recipe.synth));

  if (issues.length > 0) {
    return {
      ok: false,
      error: 'recipe_invalid',
      message: `recipe failed validation (${issues.length} issue${issues.length === 1 ? '' : 's'})`,
      issues,
      path: abs,
    };
  }

  // Resolve the orchestrator. Recipe may override via top-level `orchestrator`
  // (path relative to repo); otherwise we use the dispatch map keyed on name.
  let orchestratorRel = null;
  if (typeof recipe.orchestrator === 'string' && recipe.orchestrator.length > 0) {
    orchestratorRel = recipe.orchestrator;
  } else {
    // Try exact name first, then family prefix (e.g. "trinity-2000-v2" -> "trinity-2000").
    if (ORCHESTRATOR_MAP[recipe.name]) {
      orchestratorRel = ORCHESTRATOR_MAP[recipe.name];
    } else {
      for (const key of Object.keys(ORCHESTRATOR_MAP)) {
        if (recipe.name.startsWith(key)) {
          orchestratorRel = ORCHESTRATOR_MAP[key];
          break;
        }
      }
    }
  }

  // Orchestrator is REQUIRED to actually run the recipe. If absent we still
  // return ok:true (the recipe itself is valid) but flag orchestrator: null
  // so the CLI can print a clean error.
  let orchestratorAbs = null;
  if (orchestratorRel) {
    const candidate = path.isAbsolute(orchestratorRel)
      ? orchestratorRel
      : path.resolve(_repoRoot, orchestratorRel);
    if (fs.existsSync(candidate)) {
      orchestratorAbs = candidate;
    }
  }

  return {
    ok: true,
    recipe,
    hash: _sha256OfFile(abs),
    path: abs,
    orchestrator: orchestratorAbs,
    orchestrator_rel: orchestratorRel,
  };
}

// Public - list known recipes under <repoRoot>/recipes/ as {name, path, valid}.
// Used by `kolm distill --list-recipes` and the W910 Track B UI catalog.
export function listRecipes() {
  const dir = path.join(_repoRoot, 'recipes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const name = f.replace(/\.json$/, '');
      const loaded = loadRecipe(name);
      return {
        name,
        path: path.join(dir, f),
        valid: loaded.ok,
        issues: loaded.ok ? null : (loaded.issues || [loaded.message]),
        hash: loaded.ok ? loaded.hash : null,
        target_pairs: loaded.ok ? loaded.recipe?.seeds?.target : null,
        teacher_count: loaded.ok ? loaded.recipe?.teachers?.length : null,
        student_base: loaded.ok ? loaded.recipe?.train?.student_base : null,
      };
    });
}
