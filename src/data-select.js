// KOLM Data Engine — diversity-aware / distribution-matched SELECT stage (W921).
//
// CURATE today only FILTERS (drop low-quality, near-dup, CoT). It never SELECTS
// a budget-bounded subset. Pure-pointwise (top-N by score) selection produces
// REDUNDANT batches: the richest items cluster in one region of input space, so
// each new teacher token buys little new information. This module scores SETS,
// not points — picking the most diverse / representative subset under a budget.
//
// kolm's economics: distillation spends teacher tokens per pair, so "train on
// the 5K most diverse, equal K-Score at 1/10 the cost" is the whole point.
//
// Methods (all over an embedding of each pair):
//   - repr-filter (DEFAULT, pure-JS, zero-dep) — DEITA-style score-descending
//     greedy: ADD a pair only if its max cosine SIMILARITY to the already-
//     selected set is < (1 - diversity_tau); stop at the budget. "Score-first,
//     diversity-gated" — the safe default (Liu et al., ICLR'24).
//   - k-center / facility-location / badge — shell to the optional python
//     worker workers/data/scripts/select_subset.py; on ANY python failure we
//     DEGRADE to repr-filter and stamp backend_used truthfully. (The python
//     worker is authored separately; this module never requires it.)
//
// DSIR-style distribution matching: selectInformativeSubset(items, target_n,
// opts) selects a subset whose embedding distribution MATCHES a target
// distribution (a reference corpus, or — absent one — maximal coverage of the
// pool's own feature space), the importance-resampling complement of the
// diversity greedy. Used by INGEST/CURATE to match a domain target.
//
// Envelope contract: selectDiverseSubset returns {ok, version:'select-v1', ...}
// and NEVER throws / hangs; on any failure it degrades and reports the path it
// actually ran. ZERO new npm deps — reuses src/embedding.js (deterministic
// hash-bag embedder) + node:crypto via that module. Fully backward-compatible:
// no select opt => CURATE behaves exactly as before (the caller gates on it).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const DATA_SELECT_VERSION = 'select-v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_METHODS = ['repr-filter', 'facility-location', 'k-center', 'badge'];

// ── pair text extraction (mirrors data-curate / minhash-dedup) ───────────────

function _pairInput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.input === 'string') return p.input;
  if (typeof p.prompt === 'string') return p.prompt;
  return '';
}

function _pairOutput(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.output === 'string') return p.output;
  if (typeof p.teacher_output === 'string') return p.teacher_output;
  if (typeof p.response === 'string') return p.response;
  return '';
}

function _pairText(p) {
  if (typeof p === 'string') return p;
  return (_pairInput(p) + '\n\n' + _pairOutput(p)).trim();
}

// ── vector helpers (pure) ────────────────────────────────────────────────────

function _cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  return _cosineVec(a, b);
}

function _l2(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

// Resolve a budget: >1 => integer count, 0<x<=1 => fraction of n, else n.
function _resolveTarget(target, n) {
  const t = Number(target);
  if (!Number.isFinite(t) || t <= 0) return n;
  if (t > 1) return Math.min(n, Math.max(1, Math.trunc(t)));
  // fraction
  return Math.min(n, Math.max(1, Math.round(t * n)));
}

// Embed every pair into the deterministic 256-d hash-bag space. Reused for all
// JS diversity computations (no second embed, no network).
function _embedPairs(pairs) {
  return pairs.map((p) => _embedText(_pairText(p)));
}

// Local quality score in [0,1] for score-descending order when no scores given.
function _localScore(p) {
  const out = _pairOutput(p);
  const n = String(out || '').trim().length;
  if (n === 0) return 0.1;
  // longer-but-not-huge outputs get a mild lift; this only orders the greedy
  // walk, the diversity gate does the real work.
  if (n < 20) return 0.3;
  if (n <= 1200) return 0.6;
  if (n <= 2000) return 0.55;
  return 0.45;
}

// ── repr-filter (pure-JS DEITA-style greedy) ─────────────────────────────────

/**
 * reprFilterSelect(pairs, scores, B, tau) — score-descending greedy: walk pairs
 * best-score-first, ADD a pair only if its max cosine similarity to the already-
 * selected set is < tau (i.e. cosine distance to nearest selected > 1-tau);
 * stop at budget B. Pure JS, O(B^2) on the selected set.
 * @param {object[]} pairs
 * @param {number[]|null} scores  per-pair score (descending order); null => local heuristic
 * @param {number} B  budget (count)
 * @param {number} [tau=0.9]  similarity ceiling — higher tau = looser dedup
 * @returns {{selected_indices:number[], kept:object[], coverage_radius:number}}
 */
export function reprFilterSelect(pairs, scores, B, tau = 0.9) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const n = rows.length;
  const budget = Math.min(n, Math.max(0, Math.trunc(Number(B) || 0)));
  const simCeil = Number.isFinite(Number(tau)) ? Number(tau) : 0.9;
  if (n === 0 || budget === 0) {
    return { selected_indices: [], kept: [], coverage_radius: 0 };
  }

  const embs = _embedPairs(rows);
  const sc = (Array.isArray(scores) && scores.length === n)
    ? scores.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0))
    : rows.map((p) => _localScore(p));

  // descending by score, stable on original index
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (sc[b] - sc[a]) || (a - b));

  const selected = [];
  for (const i of order) {
    if (selected.length >= budget) break;
    let maxSim = -Infinity;
    for (const j of selected) {
      const s = _cosineSim(embs[i], embs[j]);
      if (s > maxSim) maxSim = s;
    }
    if (selected.length === 0 || maxSim < simCeil) {
      selected.push(i);
    }
  }

  // If the diversity gate starved the budget (everything too similar), top up
  // with the next-best remaining rows so SELECT always returns a full budget.
  if (selected.length < budget) {
    const chosen = new Set(selected);
    for (const i of order) {
      if (selected.length >= budget) break;
      if (!chosen.has(i)) { selected.push(i); chosen.add(i); }
    }
  }

  selected.sort((a, b) => a - b);
  const coverage_radius = _coverageRadius(embs, selected);
  return {
    selected_indices: selected,
    kept: selected.map((i) => rows[i]),
    coverage_radius,
  };
}

// Coverage radius = max over all points of the min distance to the selected set
// (the k-center objective value). Lower = better coverage.
function _coverageRadius(embs, selected) {
  if (!selected.length || !embs.length) return 0;
  let worst = 0;
  for (let i = 0; i < embs.length; i++) {
    let best = Infinity;
    for (const j of selected) {
      const d = _l2(embs[i], embs[j]);
      if (d < best) best = d;
    }
    if (best > worst) worst = best;
  }
  return Number(worst.toFixed(6));
}

// k-center-greedy in pure JS (used as a strong JS fallback + by the smoke).
function _kCenterGreedyJS(embs, B, seedIdx) {
  const n = embs.length;
  const budget = Math.min(n, Math.max(1, Math.trunc(Number(B) || 1)));
  const selected = [];
  const minDist = new Float64Array(n).fill(Infinity);
  const seeds = Array.isArray(seedIdx) ? seedIdx.filter((i) => i >= 0 && i < n) : [];
  for (const s of seeds) {
    selected.push(s);
    for (let i = 0; i < n; i++) {
      const d = _l2(embs[i], embs[s]);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  if (selected.length === 0) {
    selected.push(0);
    for (let i = 0; i < n; i++) {
      const d = _l2(embs[i], embs[0]);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  while (selected.length < budget) {
    let far = -1; let farDist = -1;
    for (let i = 0; i < n; i++) {
      if (minDist[i] > farDist) { farDist = minDist[i]; far = i; }
    }
    if (far < 0) break;
    selected.push(far);
    for (let i = 0; i < n; i++) {
      const d = _l2(embs[i], embs[far]);
      if (d < minDist[i]) minDist[i] = d;
    }
  }
  return selected;
}

// ── python worker shell-out (degrades to repr-filter) ────────────────────────

function _selectViaPython(pairs, method, B, embeddings) {
  const py = process.env.KOLM_PYTHON || 'python';
  const script = path.resolve(__dirname, '..', 'workers', 'data', 'scripts', 'select_subset.py');
  if (!fs.existsSync(script)) {
    return { ok: false, reason: 'script_missing' };
  }
  let tmpDir;
  try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-select-')); }
  catch (e) { return { ok: false, reason: 'tmp_failed:' + String((e && e.message) || e) }; }
  const inPath = path.join(tmpDir, 'in.jsonl');
  const outPath = path.join(tmpDir, 'selected.json');
  try {
    fs.writeFileSync(
      inPath,
      pairs.map((p) => JSON.stringify({ input: _pairInput(p), output: _pairOutput(p) })).join('\n') + '\n',
      'utf8',
    );
    const args = [
      script,
      '--method', method,
      '--pairs', inPath,
      '--out', outPath,
      '--target-size', String(B),
    ];
    const res = spawnSync(py, args, {
      stdio: 'pipe',
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(py),
    });
    if (res.error || res.status !== 0) {
      const why = res.error ? String(res.error.message) : ('exit_' + res.status);
      return { ok: false, reason: why };
    }
    const stdout = (res.stdout || '').toString();
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    let summary = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { summary = JSON.parse(lines[i]); break; }
      catch (_) { /* keep scanning */ }
    }
    if (!summary || summary.ok !== true || !Array.isArray(summary.selected_indices)) {
      return { ok: false, reason: (summary && summary.error) || 'no_summary' };
    }
    return {
      ok: true,
      selected_indices: summary.selected_indices,
      coverage_radius: typeof summary.coverage_radius === 'number' ? summary.coverage_radius : null,
      backend_used: summary.backend_used || ('py-' + method),
    };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
    catch (_) { /* best-effort */ }
  }
}

// ── selectDiverseSubset (headline orchestrator) ──────────────────────────────

/**
 * selectDiverseSubset — budget-bounded diversity-aware selection. Returns an
 * honest envelope; NEVER throws. repr-filter runs in pure JS; the other methods
 * shell to python and DEGRADE to repr-filter on any failure, stamping
 * backend_used truthfully.
 * @param {object} args
 * @param {object[]} args.pairs
 * @param {number} args.target_size  >1 = count, 0<x<=1 = fraction
 * @param {string} [args.method='repr-filter']  repr-filter|facility-location|k-center|badge
 * @param {number} [args.diversity_tau=0.9]
 * @param {number[][]|null} [args.embeddings]  precomputed embeddings (optional)
 * @param {number[]|null} [args.scores]  per-pair score for the greedy order
 * @param {number[]} [args.seed_selected]  pre-selected indices to extend from
 * @param {string} [args.namespace='default']
 * @returns {Promise<object>} {ok, version, method, n_in, n_selected, selected_indices, kept, coverage_radius, backend_used, report, error?}
 */
export async function selectDiverseSubset({
  pairs,
  target_size,
  method = 'repr-filter',
  diversity_tau = 0.9,
  embeddings = null,
  scores = null,
  seed_selected = [],
  namespace = 'default',
} = {}) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const n = rows.length;
  const requested = VALID_METHODS.includes(method) ? method : 'repr-filter';
  const B = _resolveTarget(target_size, n);

  const base = {
    ok: true,
    version: DATA_SELECT_VERSION,
    method: requested,
    n_in: n,
    namespace: String(namespace || 'default'),
  };

  if (n === 0) {
    return {
      ...base,
      n_selected: 0,
      selected_indices: [],
      kept: [],
      coverage_radius: 0,
      backend_used: 'js-empty',
      report: { method: requested, n_in: 0, n_selected: 0, coverage_radius: 0, backend_used: 'js-empty' },
    };
  }

  try {
    // Pure-JS default path (and the universal fallback).
    if (requested === 'repr-filter') {
      const r = reprFilterSelect(rows, scores, B, diversity_tau);
      return _finish(base, rows, r.selected_indices, r.coverage_radius, 'js-repr-filter');
    }

    // python methods: try the worker, degrade to repr-filter.
    const viaPy = _selectViaPython(rows, requested, B, embeddings);
    if (viaPy.ok) {
      const idx = viaPy.selected_indices.filter((i) => Number.isInteger(i) && i >= 0 && i < n);
      const cov = viaPy.coverage_radius != null
        ? viaPy.coverage_radius
        : _coverageRadius(_embedPairs(rows), idx);
      return _finish(base, rows, idx, cov, viaPy.backend_used);
    }

    // degrade: repr-filter in JS, truthful backend label.
    const r = reprFilterSelect(rows, scores, B, diversity_tau);
    const out = _finish(base, rows, r.selected_indices, r.coverage_radius, 'js-repr-filter-fallback');
    out.report.degrade_reason = viaPy.reason;
    return out;
  } catch (e) {
    // last-resort: never throw — return the whole pool truthfully.
    const all = Array.from({ length: n }, (_, i) => i);
    return {
      ...base,
      ok: false,
      error: String((e && e.message) || e),
      n_selected: n,
      selected_indices: all,
      kept: rows.slice(),
      coverage_radius: 0,
      backend_used: 'js-error-passthrough',
      report: { method: requested, n_in: n, n_selected: n, coverage_radius: 0, backend_used: 'js-error-passthrough' },
    };
  }
}

function _finish(base, rows, selectedIdx, coverage, backend) {
  const idx = selectedIdx.slice().sort((a, b) => a - b);
  const kept = idx.map((i, rank) => {
    const row = rows[i];
    // stamp per-pair provenance.selection without mutating the original object.
    const sel = { method: base.method, rank, diversity_radius: coverage };
    if (row && typeof row === 'object') {
      const prov = (row.provenance && typeof row.provenance === 'object')
        ? { ...row.provenance, selection: sel }
        : { selection: sel };
      return { ...row, provenance: prov };
    }
    return row;
  });
  return {
    ...base,
    n_selected: idx.length,
    selected_indices: idx,
    kept,
    coverage_radius: coverage,
    backend_used: backend,
    report: {
      method: base.method,
      n_in: base.n_in,
      n_selected: idx.length,
      coverage_radius: coverage,
      backend_used: backend,
      redundancy_dropped: base.n_in - idx.length,
    },
  };
}

// ── selectInformativeSubset (DSIR/DEITA distribution-matched) ────────────────

/**
 * selectInformativeSubset(items, target_n, opts) — distribution-matched subset
 * selection (DSIR importance-resampling flavor). Selects target_n items whose
 * embedding distribution MATCHES a target:
 *   - opts.target_embeddings / opts.target_items given => match that reference
 *     distribution (DSIR: weight each pool item by importance = similarity to
 *     the target centroid, then diversity-resample without replacement).
 *   - no target => maximize coverage of the pool's OWN feature space (k-center
 *     greedy seeded from the highest-score item), so the picked subset spans
 *     the input distribution rather than clustering in the densest region.
 *
 * Distribution-matched (importance) is the complement of pure diversity: it
 * over-samples the regions the target cares about while still avoiding intra-
 * subset redundancy via the diversity gate.
 *
 * @param {object[]} items  pairs or strings
 * @param {number} target_n  >1 = count, 0<x<=1 = fraction
 * @param {object} [opts]
 * @param {number[][]} [opts.target_embeddings]  reference distribution embeddings
 * @param {object[]} [opts.target_items]  reference distribution items (embedded here)
 * @param {number[]} [opts.scores]  per-item score
 * @param {number} [opts.diversity_tau=0.9]
 * @param {number} [opts.lambda=0.5]  importance vs diversity trade-off [0,1]
 * @returns {{ok:boolean, version:string, n_in:number, n_selected:number, selected_indices:number[], kept:object[], coverage_radius:number, basis:string}}
 */
export function selectInformativeSubset(items, target_n, opts = {}) {
  const rows = Array.isArray(items) ? items : [];
  const n = rows.length;
  const B = _resolveTarget(target_n, n);
  const tau = Number.isFinite(Number(opts.diversity_tau)) ? Number(opts.diversity_tau) : 0.9;

  const out = (selected, coverage, basis) => {
    const idx = selected.slice().sort((a, b) => a - b);
    return {
      ok: true,
      version: DATA_SELECT_VERSION,
      n_in: n,
      n_selected: idx.length,
      selected_indices: idx,
      kept: idx.map((i) => rows[i]),
      coverage_radius: coverage,
      basis,
    };
  };

  if (n === 0 || B === 0) return out([], 0, 'empty');

  const embs = _embedPairs(rows);

  // Build the target centroid for importance weighting.
  let targetCentroid = null;
  let basis = 'self-coverage';
  let targetEmbs = null;
  if (Array.isArray(opts.target_embeddings) && opts.target_embeddings.length) {
    targetEmbs = opts.target_embeddings;
  } else if (Array.isArray(opts.target_items) && opts.target_items.length) {
    targetEmbs = _embedPairs(opts.target_items);
  }
  if (targetEmbs && targetEmbs.length && targetEmbs[0] && targetEmbs[0].length === embs[0].length) {
    const dim = embs[0].length;
    const c = new Array(dim).fill(0);
    for (const v of targetEmbs) for (let d = 0; d < dim; d++) c[d] += v[d];
    let norm = 0;
    for (let d = 0; d < dim; d++) { c[d] /= targetEmbs.length; norm += c[d] * c[d]; }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) c[d] /= norm;
    targetCentroid = c;
    basis = 'dsir-importance';
  }

  // No reference distribution: maximal-coverage k-center greedy over the pool.
  if (!targetCentroid) {
    // seed from the highest-score item so the spread anchors on a strong point
    const sc = (Array.isArray(opts.scores) && opts.scores.length === n)
      ? opts.scores : rows.map((p) => _localScore(p));
    let seed = 0;
    for (let i = 1; i < n; i++) if (sc[i] > sc[seed]) seed = i;
    const selected = _kCenterGreedyJS(embs, B, [seed]);
    return out(selected, _coverageRadius(embs, selected), basis);
  }

  // DSIR-flavored: importance = similarity to target centroid; combine with a
  // diversity gate so the matched subset still avoids intra-subset redundancy.
  const lambda = Number.isFinite(Number(opts.lambda)) ? Math.min(1, Math.max(0, Number(opts.lambda))) : 0.5;
  const importance = embs.map((v) => _cosineSim(v, targetCentroid));
  // greedy by importance, diversity-gated like repr-filter (tau ceiling).
  const order = Array.from({ length: n }, (_, i) => i)
    .sort((a, b) => (importance[b] - importance[a]) || (a - b));
  const selected = [];
  for (const i of order) {
    if (selected.length >= B) break;
    let maxSim = -Infinity;
    for (const j of selected) {
      const s = _cosineSim(embs[i], embs[j]);
      if (s > maxSim) maxSim = s;
    }
    // looser gate as lambda -> 1 (favor importance over diversity)
    const ceil = tau + (1 - tau) * lambda;
    if (selected.length === 0 || maxSim < ceil) selected.push(i);
  }
  if (selected.length < B) {
    const chosen = new Set(selected);
    for (const i of order) {
      if (selected.length >= B) break;
      if (!chosen.has(i)) { selected.push(i); chosen.add(i); }
    }
  }
  return out(selected, _coverageRadius(embs, selected), basis);
}

// ── selectDiverseBatch (active-learning helper) ──────────────────────────────

/**
 * selectDiverseBatch(items, B, opts) — pick B DIVERSE items spanning the gap
 * surface (not B from the hottest cluster). Reused by active-learning
 * recommendNextCaptures + the W775 daemon. Synchronous, pure-JS.
 * @param {object[]} items
 * @param {number} B
 * @param {object} [opts]
 * @param {(t:string)=>number[]} [opts.embedFn]  custom embedder (default: src/embedding.embed)
 * @param {string} [opts.method='repr-filter']
 * @param {number} [opts.tau=0.9]
 * @returns {{batch:object[], indices:number[], method:string}}
 */
export function selectDiverseBatch(items, B, opts = {}) {
  const rows = Array.isArray(items) ? items : [];
  const n = rows.length;
  const budget = Math.min(n, Math.max(0, Math.trunc(Number(B) || 0)));
  const method = VALID_METHODS.includes(opts.method) ? opts.method : 'repr-filter';
  if (n === 0 || budget === 0) return { batch: [], indices: [], method };

  const embedFn = typeof opts.embedFn === 'function' ? opts.embedFn : (t) => _embedText(t);
  const tau = Number.isFinite(Number(opts.tau)) ? Number(opts.tau) : 0.9;
  const textOf = (it) => {
    if (typeof it === 'string') return it;
    if (it && typeof it === 'object') {
      if (typeof it.text === 'string') return it.text;
      if (typeof it.prompt === 'string') return it.prompt + '\n\n' + (it.output || it.response || '');
      return _pairText(it);
    }
    return '';
  };
  const embs = rows.map((it) => embedFn(textOf(it)));

  // k-center greedy gives the most-spread batch; repr-filter (default) is the
  // score-ordered diversity-gated walk. For a batch recommender, k-center's
  // pure spread is the right default when no scores are supplied.
  let indices;
  if (method === 'k-center') {
    indices = _kCenterGreedyJS(embs, budget, [0]);
  } else {
    // repr-filter walk over the natural input order (assume pre-ranked by caller)
    const selected = [];
    for (let i = 0; i < n; i++) {
      if (selected.length >= budget) break;
      let maxSim = -Infinity;
      for (const j of selected) {
        const s = _cosineSim(embs[i], embs[j]);
        if (s > maxSim) maxSim = s;
      }
      if (selected.length === 0 || maxSim < tau) selected.push(i);
    }
    if (selected.length < budget) {
      const chosen = new Set(selected);
      for (let i = 0; i < n; i++) {
        if (selected.length >= budget) break;
        if (!chosen.has(i)) { selected.push(i); chosen.add(i); }
      }
    }
    indices = selected;
  }
  indices.sort((a, b) => a - b);
  return { batch: indices.map((i) => rows[i]), indices, method };
}

export const __internals = {
  _cosineSim,
  _l2,
  _resolveTarget,
  _coverageRadius,
  _kCenterGreedyJS,
  _embedPairs,
  _pairText,
};

export default {
  DATA_SELECT_VERSION,
  selectDiverseSubset,
  selectInformativeSubset,
  reprFilterSelect,
  selectDiverseBatch,
  __internals,
};
