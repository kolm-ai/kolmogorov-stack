// src/distill-recipe-loader.js
//
// T1.6 — one-shot recipe loader. Resolves a recipe by name OR path, validates
// the 6 required top-level sections, and returns a normalized object plus a
// content hash. The CLI's `kolm distill --recipe <name>` uses this to dispatch
// the matching orchestrator script (today: trinity-2000-v2-run.mjs); future
// W910 Track A entries (--data / --describe) mount on the same loader.
//
// Validation philosophy: a recipe is a contract between the user and the
// pipeline. If a key is missing or malformed we fail BEFORE any teacher spend
// — the upstream of the cost-preview gate (T1.2) and the preflight gate
// (T1.1). Wrong types are errors, not silent coercions.
//
// Schema (v1, flat JSON, no DSL yet — T3.1 evolves this into composable YAML):
//   name             string  (required)
//   version          string  (required)
//   description      string  (optional)
//   seeds            object  (required)
//     .target        number  (required)
//     .generator     string  (required — path relative to repo)
//     .buckets       object<string,number>  (optional)
//   teachers         array   (required, length >= 1)
//     [].slug        string  (required, "vendor:model" shape)
//     [].rows        number  (required, >0)
//     [].weight      number  (optional, derived from rows if absent)
//     [].source      string  (optional)
//   scrub            object  (optional but recommended)
//     .cot           object
//       .markers_path  string  (path to cot_markers.json — T1.5)
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

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

// Orchestrator dispatch — each recipe name (or family prefix) maps to a runner
// script. New recipes plug in here OR use the recipe's optional `orchestrator`
// field. Kept tiny on purpose: T1.6 is about the loader contract; T3.1 will
// generalize via the DSL.
const ORCHESTRATOR_MAP = {
  'trinity-2000': 'scripts/trinity-2000-v2-run.mjs',
};

const VALID_TRAIN_METHODS = new Set(['qlora', 'lora', 'full']);

function _isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
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
  if (!VALID_TRAIN_METHODS.has(train.method)) {
    issues.push(`train.method must be one of: ${Array.from(VALID_TRAIN_METHODS).join(', ')} (got ${JSON.stringify(train.method)})`);
  }
  if (typeof train.student_base !== 'string' || train.student_base.length === 0) {
    issues.push('train.student_base must be a non-empty string (HF repo id)');
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
  if (train.method === 'qlora' || train.method === 'lora') {
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

// Public — load + validate a recipe. Returns the envelope above. Throws ONLY
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

// Public — list known recipes under <repoRoot>/recipes/ as {name, path, valid}.
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
