// W775+ — Autopilot bootstrap. Turns a plain-English description into a
// ready-to-run namespace in one call:
//
//   bootstrapFromDescription({description, namespace, budget_usd})
//     1. seeds raw-pairs.jsonl via ingestDescribeEngine (no teacher spend —
//        templated question stems span the described domain; outputs are left
//        empty for the AUGMENT/collect stage to fill).
//     2. synthesizes a VALID distill recipe (passes distill-recipe-loader's
//        v1 schema) and writes it to a tenant-fenced location under the kolm
//        data dir, then re-loads it to confirm it validates.
//     3. returns {ok, recipe_path, recipe_hash, namespace, n_seeded, budget_usd}.
//
// This is the entry point behind `kolm autopilot "<describe>" --namespace ...`
// (non-verb first arg) and `kolm compile --auto --describe "<...>"`. It writes
// NO model and spends NO tokens — it only prepares the corpus + recipe so the
// first autopilot tick has something to plan against.
//
// Persistence: the seed write is logged by data-ingest itself (provider
// kolm_data_ingest); the recipe write is a plain file (tenant-fenced path), so
// this module adds no event-store provider of its own.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { ingestDescribeEngine } from './data-ingest.js';
import { loadRecipe } from './distill-recipe-loader.js';

export const BOOTSTRAP_VERSION = 'apb-v1';

// Defaults for the synthesized recipe. Conservative, single-teacher, QLoRA on
// a 7B student — the same shape the Trinity recipe uses, sized down so a
// described namespace is runnable without further edits.
const DEFAULT_SEED_TARGET = 200;
const DEFAULT_STUDENT_BASE = 'Qwen/Qwen2.5-7B-Instruct';
const DEFAULT_TEACHER_SLUG = 'openai:gpt-4o-mini';

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _kolmDir() {
  if (process.env.KOLM_DATA_DIR) return path.resolve(process.env.KOLM_DATA_DIR);
  if (process.env.KOLM_HOME) return path.resolve(process.env.KOLM_HOME);
  return path.join(_home(), '.kolm');
}

// Tenant-fenced recipe location. We deliberately do NOT write into the repo's
// recipes/ dir (that is shared, version-controlled space) — each tenant's
// generated recipe lives under its own data dir and is referenced by absolute
// path, which loadRecipe accepts.
function _recipePath(tenant, namespace) {
  const safeT = String(tenant || 'tenant_local').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
  const safeN = String(namespace || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 96);
  return path.join(_kolmDir(), 'recipes', safeT, safeN + '.json');
}

function _atomicWriteJson(target, obj) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, target);
}

function _budgetUsd(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const m = String(v).match(/([\d.]+)/);
  return m ? Number(m[1]) : null;
}

// Build a recipe object that satisfies distill-recipe-loader's v1 schema:
//   name, version, seeds{target,generator}, teachers[{slug,rows}], train{...}.
function _synthesizeRecipe({ description, namespace, seedTarget }) {
  return {
    name: 'autopilot-' + String(namespace || 'default'),
    version: '1',
    description: String(description || '').slice(0, 500),
    // The orchestrator is the Trinity runner; loadRecipe resolves it only if
    // the file exists in this tree, otherwise returns orchestrator:null (the
    // recipe is still valid — the autopilot tick drives orchestrateImprovement,
    // not the recipe runner).
    orchestrator: 'scripts/trinity-2000-v2-run.mjs',
    seeds: {
      target: seedTarget,
      // generator is validated as a non-empty string only (not existence) —
      // it documents where seeds come from for this autopilot recipe.
      generator: 'src/data-ingest.js#ingestDescribeEngine',
    },
    teachers: [
      { slug: DEFAULT_TEACHER_SLUG, rows: seedTarget, source: 'autopilot-describe' },
    ],
    scrub: {
      cot: { markers_path: 'workers/distill/scripts/cot_markers.json', strategy: 'drop', drop_if_no_close_tag: true },
    },
    train: {
      method: 'qlora',
      student_base: DEFAULT_STUDENT_BASE,
      epochs: 2,
      batch_size: 1,
      lr: 0.0002,
      max_seq_len: 2048,
      lora: { r: 16, alpha: 32 },
    },
    eval: { bench: 'mixeval-hard', strict_cot: true },
  };
}

// ---------------------------------------------------------------------------
// bootstrapFromDescription — the one-call namespace primer.
// ---------------------------------------------------------------------------
export async function bootstrapFromDescription({ tenant, namespace, description, budget_usd, n } = {}) {
  const desc = String(description || '').trim();
  if (!desc) {
    return { ok: false, error: 'description_required', version: BOOTSTRAP_VERSION };
  }
  const ns = String(namespace || 'default').slice(0, 128);
  const t = (tenant && String(tenant)) || 'tenant_local';
  const seedTarget = Math.max(1, Math.min(2000, Number(n) || DEFAULT_SEED_TARGET));
  const budget = _budgetUsd(budget_usd);

  // 1. Seed raw-pairs from the description (templated, no teacher spend).
  let seed;
  try {
    seed = await ingestDescribeEngine({ tenant: t, namespace: ns, description: desc, n: seedTarget });
  } catch (e) {
    return { ok: false, error: 'seed_failed', detail: String((e && e.message) || e), version: BOOTSTRAP_VERSION };
  }
  if (!seed || seed.ok !== true) {
    return { ok: false, error: (seed && seed.error) || 'seed_failed', version: BOOTSTRAP_VERSION };
  }

  // 2. Synthesize + write the recipe, then re-load it to confirm validity.
  const recipe = _synthesizeRecipe({ description: desc, namespace: ns, seedTarget });
  const recipePath = _recipePath(t, ns);
  try {
    _atomicWriteJson(recipePath, recipe);
  } catch (e) {
    return { ok: false, error: 'recipe_write_failed', detail: String((e && e.message) || e), path: recipePath, version: BOOTSTRAP_VERSION };
  }

  const loaded = loadRecipe(recipePath);
  if (!loaded.ok) {
    return {
      ok: false,
      error: 'recipe_invalid_after_write',
      issues: loaded.issues || [loaded.message],
      path: recipePath,
      version: BOOTSTRAP_VERSION,
    };
  }

  return {
    ok: true,
    version: BOOTSTRAP_VERSION,
    namespace: ns,
    tenant: t,
    description_sha256: crypto.createHash('sha256').update(desc).digest('hex'),
    recipe_path: recipePath,
    recipe_hash: loaded.hash,
    recipe_name: recipe.name,
    orchestrator: loaded.orchestrator,
    n_seeded: seed.n_written,
    raw_pairs_path: seed.path,
    seeds_dupes_skipped: seed.dupes_skipped,
    budget_usd: budget,
  };
}

export const __internals = Object.freeze({
  _synthesizeRecipe,
  _recipePath,
  _budgetUsd,
  DEFAULT_SEED_TARGET,
  DEFAULT_STUDENT_BASE,
  DEFAULT_TEACHER_SLUG,
});

export default { BOOTSTRAP_VERSION, bootstrapFromDescription, __internals };
