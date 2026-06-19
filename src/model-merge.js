// src/model-merge.js
//
// W921 - Model merging as a SHIPPING feature.
//
// Combine N per-skill distilled LoRA adapters into one artifact via
// TIES / DARE-TIES / DELLA / SLERP / linear, computed correctly in delta-W
// space with SVD re-factorization, and bound into the .kolm lineage chain as a
// first-class multi-parent merge node.
//
// This module is a Node orchestration shell - the heavy weight math runs in
// workers/distill/scripts/merge_adapters.py (PEFT add_weighted_adapter for the
// supported combos + a from-scratch DELLA path). When torch/peft are absent we
// return a durable, no-tool envelope (mirrors src/distill-preference.js +
// cmdDistillContrastive): we still write the plan + lineage record so the
// operator gets a verifiable receipt of WHAT WOULD merge, even on a box with no
// trainer installed.
//
// Correctness note (the documented PEFT footgun): merging the LoRA A and B
// FACTORS separately is mathematically NOT equal to merging the products B@A,
// and is only valid at identical rank. The real path reconstructs
// delta_W_i = (alpha_i/r_i) * B_i @ A_i, merges in delta-W space, then SVD-
// refactorizes back to (A,B). merge_adapters.py records merge_space='delta_w'
// when it takes the correct path; this module surfaces that flag so a verifier
// can confirm the weights were not a byte-copy.
//
// References: PEFT model_merging docs; TIES (arXiv:2306.01708); DARE
// (arXiv:2311.03099); DELLA (arXiv:2406.11617); KnOTS (arXiv:2410.19735);
// task arithmetic (arXiv:2212.04089).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLineage, VALID_MERGE_METHODS } from './artifact-lineage.js';
import { pythonBin } from './python-runtime.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const _repoRoot = path.resolve(_here, '..');

// Frozen catalog - kept identical to artifact-lineage.VALID_MERGE_METHODS and
// merge_adapters.py's method choices. SLERP is two-model-only (rejected for
// N!=2). magnitude_prune is a single-adapter sparsifier but we still require
// >=2 for a "merge".
export const MERGE_METHODS = Object.freeze([
  'linear', 'svd', 'ties', 'ties_svd', 'dare_linear', 'dare_ties',
  'dare_linear_svd', 'dare_ties_svd', 'magnitude_prune', 'della', 'slerp',
]);

// Methods restricted to exactly two adapters.
const TWO_MODEL_ONLY = new Set(['slerp']);

const INSTALL_HINT = [
  'model merging requires torch + peft (>=0.11) + transformers + safetensors.',
  '',
  'install: pip install "peft>=0.11" torch transformers safetensors',
  '',
  'the merge worker lives at workers/distill/scripts/merge_adapters.py and is',
  'invoked as:  python merge_adapters.py --adapters d1,d2,d3 --weights 0.5,0.3,0.2',
  '             --method ties --density 0.5 --out <dir> [--base <repo>] [--json]',
].join('\n');

function _sha256File(absPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch (_) { return null; }
}

// Hash an adapter DIRECTORY deterministically: sort the relevant peft files by
// name, concatenate (name + bytes) hashes. Falls back to hashing the dir path
// string when the dir is unreadable (so the receipt still records SOMETHING).
function _hashAdapterDir(dir) {
  try {
    if (!fs.existsSync(dir)) return crypto.createHash('sha256').update(String(dir)).digest('hex');
    const st = fs.statSync(dir);
    if (st.isFile()) return _sha256File(dir);
    const names = fs.readdirSync(dir)
      .filter((n) => /adapter_(config\.json|model\.(safetensors|bin))$/.test(n))
      .sort();
    const h = crypto.createHash('sha256');
    if (names.length === 0) {
      // No peft layout files - hash the whole dir listing instead.
      for (const n of fs.readdirSync(dir).sort()) h.update(n);
      return h.digest('hex');
    }
    for (const n of names) {
      h.update(n);
      const b = fs.readFileSync(path.join(dir, n));
      h.update(b);
    }
    return h.digest('hex');
  } catch (_) {
    return crypto.createHash('sha256').update(String(dir)).digest('hex');
  }
}

// Normalize the adapters argument into [{name, dir, weight}].
// Accepts: ['/path/a','/path/b']  OR  [{name,dir,weight}]  OR a mix.
function _normalizeAdapters(adapters) {
  if (!Array.isArray(adapters)) return { ok: false, error: 'adapters_not_array' };
  const out = [];
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i];
    if (typeof a === 'string') {
      out.push({ name: path.basename(a) || `adapter_${i}`, dir: a, weight: null });
    } else if (a && typeof a === 'object' && typeof a.dir === 'string') {
      out.push({
        name: a.name ? String(a.name) : (path.basename(a.dir) || `adapter_${i}`),
        dir: a.dir,
        weight: (typeof a.weight === 'number' && Number.isFinite(a.weight)) ? a.weight : null,
      });
    } else {
      return { ok: false, error: 'bad_adapter_entry', detail: `adapters[${i}] must be a string path or {name,dir,weight}` };
    }
  }
  return { ok: true, adapters: out };
}

// Resolve per-adapter weights. Three cases:
//   - explicit `weights` array (length must match adapters)
//   - per-adapter .weight on the objects (all must be present)
//   - none -> uniform 1/N
// Negative or zero-sum weights are an error (matches merge.py _normalized_weights).
function _resolveWeights(adapters, weights) {
  const n = adapters.length;
  let raw;
  if (Array.isArray(weights)) {
    if (weights.length !== n) {
      return { ok: false, error: 'weights_length_mismatch', detail: `weights has ${weights.length} entries but there are ${n} adapters` };
    }
    raw = weights.map(Number);
  } else if (typeof weights === 'string') {
    const parts = weights.split(',').map((s) => Number(s.trim()));
    if (parts.length !== n) {
      return { ok: false, error: 'weights_length_mismatch', detail: `weights string has ${parts.length} entries but there are ${n} adapters` };
    }
    raw = parts;
  } else if (adapters.every((a) => typeof a.weight === 'number')) {
    raw = adapters.map((a) => a.weight);
  } else {
    raw = adapters.map(() => 1 / n);
  }
  for (const w of raw) {
    if (!Number.isFinite(w)) return { ok: false, error: 'weight_not_finite' };
    if (w < 0) return { ok: false, error: 'weight_negative', detail: 'merge weights must be >= 0' };
  }
  const sum = raw.reduce((s, w) => s + w, 0);
  if (sum <= 0) return { ok: false, error: 'weight_sum_nonpositive', detail: `weights must sum to a positive value, got ${sum}` };
  return { ok: true, weights: raw };
}

// Read base_model_name_or_path from an adapter's adapter_config.json.
function _readAdapterBase(dir) {
  try {
    const p = path.join(dir, 'adapter_config.json');
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return cfg.base_model_name_or_path || null;
  } catch (_) { return null; }
}

// Find the trainer entry. KOLM_MERGE_TRAINER overrides; default is the in-repo
// worker resolved against repo root.
function resolveTrainer() {
  // Explicit opt-out seam: KOLM_MERGE_NO_TRAINER=1 forces the durable no-tool
  // path (used by tests + air-gapped plan-only runs).
  if (process.env.KOLM_MERGE_NO_TRAINER === '1') return null;
  const envCmd = process.env.KOLM_MERGE_TRAINER;
  if (envCmd) {
    // An explicit override that points nowhere is an error, NOT a silent
    // fallback to the in-repo script - return null so the caller surfaces it.
    return fs.existsSync(envCmd) ? { script: envCmd, source: 'env' } : null;
  }
  const inRepo = path.join(_repoRoot, 'workers', 'distill', 'scripts', 'merge_adapters.py');
  if (fs.existsSync(inRepo)) return { script: inRepo, source: 'in_repo' };
  return null;
}

function _pythonBin() {
  return pythonBin();
}

// W921 - dry-run plan envelope. Pure (no spawn, no GPU). Validates inputs,
// resolves weights, checks same-base, and estimates output size. Reused by the
// CLI --dry-run path so it agrees byte-for-byte with the real run's plan.
export function planMerge({ adapters, method = 'ties', weights = null, density = 0.5, svdRank = null } = {}) {
  if (!MERGE_METHODS.includes(method)) {
    return { ok: false, error: 'unknown_method', detail: `method must be one of ${MERGE_METHODS.join('|')}` };
  }
  const norm = _normalizeAdapters(adapters);
  if (!norm.ok) return norm;
  const list = norm.adapters;
  if (list.length < 2) {
    return { ok: false, error: 'too_few_adapters', detail: 'need >= 2 adapters to merge' };
  }
  if (TWO_MODEL_ONLY.has(method) && list.length !== 2) {
    return { ok: false, error: 'method_requires_two', detail: `${method} requires exactly 2 adapters, got ${list.length}; use linear/ties for 3+` };
  }
  const wres = _resolveWeights(list, weights);
  if (!wres.ok) return wres;

  // Same-base check. Adapters trained on different base models silently
  // produce garbage - surface it (the real run hard-gates on it).
  const bases = list.map((a) => _readAdapterBase(a.dir));
  const knownBases = bases.filter(Boolean);
  const uniqueBases = [...new Set(knownBases)];
  const same_base = uniqueBases.length <= 1;
  let warning = null;
  if (uniqueBases.length > 1) {
    warning = `adapters disagree on base_model: ${uniqueBases.join(' vs ')} - merge will be refused`;
  }

  // Rough output-size estimate: sum of adapter_model sizes / N (a merged
  // adapter is ~one adapter's size; SVD path may bump rank). Best-effort.
  let totalMb = 0;
  let counted = 0;
  for (const a of list) {
    for (const fn of ['adapter_model.safetensors', 'adapter_model.bin']) {
      const fp = path.join(a.dir, fn);
      if (fs.existsSync(fp)) { totalMb += fs.statSync(fp).size / (1024 * 1024); counted++; break; }
    }
  }
  const est_output_size_mb = counted > 0 ? Number((totalMb / counted).toFixed(2)) : null;

  const parents = list.map((a, i) => ({
    name: a.name,
    dir: a.dir,
    weight: Number(wres.weights[i].toFixed(6)),
    base_model: bases[i],
    sha256: _hashAdapterDir(a.dir),
  }));

  return {
    ok: true,
    method,
    density: (method.includes('ties') || method.includes('dare') || method === 'della' || method === 'magnitude_prune') ? density : null,
    svd_rank: svdRank,
    same_base,
    base_model: uniqueBases[0] || null,
    parents,
    n_parents: parents.length,
    est_output_size_mb,
    heuristic: `${method} of ${parents.length} adapters in delta-W space` + (method.endsWith('_svd') || method === 'svd' ? ' with SVD refactorization' : ''),
    warning,
  };
}

// W921 - bind a multi-parent merge lineage block onto a merged manifest.
// parentCids are the FULL hex64 artifact cids; sourceAdapterHashes are the
// hex16 adapter-dir shorthashes. Returns the manifest with a validated
// lineage{source:'model_merge', ...} block.
export function bindMergeLineage(mergedManifest, { parentCids, sourceAdapterHashes, method, weights, density } = {}) {
  const base = (mergedManifest && typeof mergedManifest === 'object') ? mergedManifest : {};
  const lineageInput = {
    source: 'model_merge',
    parent_artifact_hashes: Array.isArray(parentCids) ? parentCids : [],
    merge_method: method,
  };
  if (Array.isArray(sourceAdapterHashes) && sourceAdapterHashes.length > 0) {
    lineageInput.source_adapter_hashes = sourceAdapterHashes;
  }
  if (weights && typeof weights === 'object') lineageInput.merge_weights = weights;
  if (typeof density === 'number') lineageInput.merge_density = density;
  const lineage = buildLineage(lineageInput);
  return { ...base, lineage };
}

export function doctor() {
  const t = resolveTrainer();
  let pyOk = false;
  try {
    const r = spawnSync(_pythonBin(), ['-c', 'import torch, peft, transformers'], { stdio: 'pipe', timeout: 30000 });
    pyOk = r.status === 0;
  } catch (_) { pyOk = false; }
  return {
    ok: !!t,
    ready: !!t && pyOk,
    kind: 'model_merge',
    methods: MERGE_METHODS,
    trainer: t ? t.script : null,
    trainer_source: t ? t.source : null,
    torch_peft_importable: pyOk,
    install_hint: INSTALL_HINT,
  };
}

// W921 - orchestrate a real N-adapter merge. Durable: always writes the plan +
// merge-summary stub + a lineage record into outDir, even when the trainer is
// absent (trainer_kicked:false). When torch/peft + the worker are present we
// spawn merge_adapters.py and parse its merge-summary.json.
export function mergeAdapters({
  adapters,
  method = 'ties',
  weights = null,
  density = 0.5,
  svdRank = null,
  majoritySign = 'frequency',
  outDir = null,
  baseModel = null,
  evalHoldout = null,
  json = false,
  timeoutMs = 30 * 60 * 1000,
  parentCids = null,           // hex64 source artifact cids (for lineage)
} = {}) {
  const plan = planMerge({ adapters, method, weights, density, svdRank });
  if (!plan.ok) return plan;

  if (!plan.same_base) {
    return {
      ok: false,
      error: 'base_model_mismatch',
      detail: plan.warning || 'adapters were trained on different base models; refusing to merge',
      parents: plan.parents,
    };
  }

  const runDir = outDir || path.join(os.homedir(), '.kolm', 'merge-runs', `merge_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(runDir, { recursive: true });

  // Source-adapter hashes for the lineage receipt (hex16 shorthash of each dir).
  const sourceAdapterHashes = plan.parents.map((p) => (p.sha256 || '').slice(0, 16)).filter((h) => /^[0-9a-f]{16}$/.test(h));
  const mergeWeights = {};
  plan.parents.forEach((p) => { mergeWeights[p.name] = p.weight; });

  // Write the plan up front so the run is durable.
  const planPath = path.join(runDir, 'merge-plan.json');
  try { fs.writeFileSync(planPath, JSON.stringify(plan, null, 2)); } catch (_) { /* non-fatal */ }

  // Build a lineage record now (works with or without the trainer). When
  // parentCids are supplied (real .kolm cids) we use them; otherwise we record
  // a record_only lineage anchored on source_adapter_hashes so the merge is
  // still provenance-bound to the input dirs.
  let lineage = null;
  let lineageNote = null;
  try {
    if (Array.isArray(parentCids) && parentCids.length >= 2) {
      lineage = buildLineage({
        source: 'model_merge',
        parent_artifact_hashes: parentCids,
        merge_method: method,
        merge_weights: mergeWeights,
        ...(plan.density != null ? { merge_density: plan.density } : {}),
        ...(sourceAdapterHashes.length ? { source_adapter_hashes: sourceAdapterHashes } : {}),
      });
    } else {
      // No artifact cids available (raw adapter dirs) - record the merge in a
      // 'rebuild' lineage that still names the method + adapter hashes, so the
      // receipt is not silent even when the inputs aren't .kolm artifacts.
      lineageNote = 'no_artifact_cids: parents were raw adapter dirs, not .kolm artifacts; merge bound to source_adapter_hashes only';
      lineage = buildLineage({
        source: 'rebuild',
        notes: `model_merge method=${method} adapters=${sourceAdapterHashes.join(',')}`,
      });
    }
    fs.writeFileSync(path.join(runDir, 'merge-lineage.json'), JSON.stringify(lineage, null, 2));
  } catch (e) {
    lineageNote = `lineage_build_failed: ${e.message}`;
  }

  const t = resolveTrainer();
  const baseEnvelope = {
    method,
    merge_space: null,
    out_rank: null,
    parents: plan.parents,
    source_adapter_hashes: sourceAdapterHashes,
    merge_weights: mergeWeights,
    density: plan.density,
    output_dir: runDir,
    merge_plan_path: planPath,
    lineage,
    lineage_note: lineageNote,
  };

  if (!t) {
    return {
      ...baseEnvelope,
      ok: true,
      trainer_kicked: false,
      trainer_exit: null,
      error: 'no_trainer_installed',
      install_hint: INSTALL_HINT,
      hint: 'plan + lineage written; install torch+peft to compute merged weights',
    };
  }

  // Spawn the real worker.
  const args = [
    t.script,
    '--adapters', plan.parents.map((p) => p.dir).join(','),
    '--weights', plan.parents.map((p) => p.weight).join(','),
    '--method', method,
    '--density', String(density),
    '--majority-sign', majoritySign,
    '--out', runDir,
  ];
  if (svdRank != null) args.push('--svd-rank', String(svdRank));
  if (baseModel || plan.base_model) args.push('--base', baseModel || plan.base_model);
  if (json) args.push('--json');

  let result;
  try {
    result = spawnSync(_pythonBin(), args, { stdio: 'pipe', timeout: timeoutMs });
  } catch (e) {
    return { ...baseEnvelope, ok: false, trainer_kicked: true, error: 'trainer_spawn_failed', detail: e.message };
  }
  const stdout = (result.stdout || '').toString('utf8');
  const stderr = (result.stderr || '').toString('utf8');

  // Read the worker's summary regardless of exit code (it may write a partial).
  let summary = null;
  const summaryPath = path.join(runDir, 'merge-summary.json');
  if (fs.existsSync(summaryPath)) {
    try { summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8')); } catch (_) { /* tolerate */ }
  }

  if (result.status !== 0) {
    return {
      ...baseEnvelope,
      ok: false,
      trainer_kicked: true,
      trainer_exit: result.status,
      error: result.status === null ? 'trainer_timeout' : 'trainer_failed',
      stdout: stdout.slice(-2000),
      stderr: stderr.slice(-2000),
      merge_summary: summary,
    };
  }

  return {
    ...baseEnvelope,
    ok: true,
    trainer_kicked: true,
    trainer_exit: 0,
    merge_space: summary ? summary.merge_space : null,
    out_rank: summary ? (summary.out_rank ?? null) : null,
    merge_summary: summary,
    merge_summary_path: fs.existsSync(summaryPath) ? summaryPath : null,
    stdout: stdout.slice(-2000),
  };
}

export default {
  MERGE_METHODS,
  planMerge,
  mergeAdapters,
  bindMergeLineage,
  doctor,
  resolveTrainer,
};
