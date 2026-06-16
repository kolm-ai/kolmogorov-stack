// KOLM Data Engine - GRADIENT-INFLUENCE per-pair VALUATION (TracIn / LESS / EK-FAC).
//
// CURATE/SELECT today orders the diversity greedy by a POINTWISE quality score
// (output-length heuristic OR a learned quality classifier). That is blind to the
// eval target: it ranks a pair by how "good" the answer looks, not by how much
// training on it actually reduces holdout loss. This module computes the SOTA
// TARGETED-data-selection signal instead:
//
//   LESS  (Xia et al., ICML'24)  - cosine of the Adam-preconditioned, projected
//                                   gradient of a train pair against the mean
//                                   projected validation gradient. Magnitude-free.
//   TracIn(Pruthi et al., NeurIPS'20) - lr-weighted DOT of the projected train and
//                                   validation gradients, averaged over checkpoints.
//   EK-FAC(Grosse et al., 2023)  - inverse-Hessian-vector-product flavor: in the
//                                   Kronecker eigenbasis Q_A (x) Q_S, divide by
//                                   (lambda_A*lambda_S + damping). OPT-IN; degrades
//                                   to LESS when the worker emitted no factor files.
//
// The value score plugs DIRECTLY into the EXISTING selection seam: feed the
// numeric array as opts.scores into selectInformativeSubset / reprFilterSelect and
// the targeted ordering happens with ZERO change to the selection algorithm; the
// diversity (tau) gate still dedups redundant batches. This is the LESS recipe
// exactly: targeted ordering + diversity dedup.
//
// This atom OWNS the on-disk gradient-store contract + the pure-JS reader/valuer.
// The GPU worker (workers/data/scripts/compute_grads.py) that WRITES the store is
// env-gated (KOLM_GRAD_VALUATION=1) and fails loud with an install hint; it never
// runs in the default compile path. See docs/data-engine/GRAD-STORE-CONTRACT.md.
//
// Privacy + moat (load-bearing):
//   - Raw customer text NEVER leaves the box. The store carries only PROJECTED
//     gradient vectors (irreversible JL sketches) + a {idx, pair_id} join table;
//     no input/output substrings. Validation gradients are MEAN-aggregated on the
//     GPU before storage (no per-holdout-example reconstruction).
//   - Holdout disjointness is preserved + STRENGTHENED: the valuer REFUSES (fail-
//     closed) any store not attested holdout-disjoint. Influence is computed
//     AGAINST the holdout but TRAIN pairs are what gets scored; the holdout stays
//     an eval-only set.
//
// Envelope contract: every public call returns {ok, version:'value-influence-v1',
// ...} or {ok:false, error, version}. NEVER throws. Pure node:fs/crypto only - zero
// new npm deps. The GPU worker is the single env-gated optional heavy path.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const VALUE_INFLUENCE_VERSION = 'value-influence-v1';

const MANIFEST_VERSION = 'gradstore-v1';

// ── store root (mirrors the _dataRoot precedent in data-curate.js) ───────────

function _gradStoreRoot(override) {
  if (override && typeof override === 'string') return override;
  if (process.env.KOLM_GRAD_STORE_DIR) return process.env.KOLM_GRAD_STORE_DIR;
  const dataDir = process.env.KOLM_DATA_DIR || os.homedir();
  return path.join(dataDir, 'grad-store');
}

// ── pair-id join contract (parity with the worker / prepareDistillCorpus) ────
//
// The stable id resolved exactly as the gradient-store worker resolves it:
//   id | capture_id | event_id | trace_id  (first present, non-empty), ELSE a
//   sha256 of the canonicalized {input,output}. This is the JOIN KEY between a
//   curate pair and its gradient row in train_ids.jsonl.

function _pairInput(p) {
  if (!p || typeof p !== 'object') return typeof p === 'string' ? p : '';
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

function _rowId(p) {
  if (p && typeof p === 'object') {
    for (const f of ['id', 'pair_id', 'capture_id', 'event_id', 'trace_id']) {
      const v = p[f];
      if (v != null && String(v).length > 0) return String(v);
    }
  }
  // content hash fallback - canonicalized {input,output} (stable JSON key order).
  const canon = JSON.stringify({ input: _pairInput(p), output: _pairOutput(p) });
  return 'sha256:' + crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

// ── deterministic sparse-sign random projection (the JL sketch) ──────────────
//
// _sparseSignProject(vec, dim, seed) projects a high-dim vector to `dim` via a
// FIXED seeded sparse-sign matrix: each source coordinate i is hashed (with the
// shared seed) to exactly ONE output bucket and a +-1 sign, then accumulated.
// This is the Achlioptas/Li sparse-sign JL construction (cosine preserved to eps
// with dim ~ O(log n / eps^2)). Both the GPU worker and this reader derive the
// SAME matrix from (seed, vec.length, dim) so projected dots are meaningful.
//
// Determinism: byte-identical output for the same (vec, dim, seed); different
// seeds give different projections. No matrix is materialized - the bucket+sign
// for coordinate i come from sha256(seed || ':' || i), so memory is O(dim).

function _hashUint32(seed, i) {
  // sha256(seed-string ':' i) -> first 8 bytes as two uint32 (bucket, sign-bit).
  const h = crypto.createHash('sha256').update(String(seed) + ':' + i, 'utf8').digest();
  const bucket = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const signBits = ((h[4] << 24) | (h[5] << 16) | (h[6] << 8) | h[7]) >>> 0;
  return { bucket, signBits };
}

function _sparseSignProject(vec, dim, seed) {
  const d = Math.max(1, Math.trunc(Number(dim) || 0));
  const out = new Float64Array(d);
  if (!vec || typeof vec.length !== 'number') return out;
  const n = vec.length;
  // sparse-sign normalization keeps the projected L2 norm in expectation equal
  // to the source norm (each coord lands in one bucket with a +-1 sign).
  for (let i = 0; i < n; i++) {
    const x = Number(vec[i]) || 0;
    if (x === 0) continue;
    const { bucket, signBits } = _hashUint32(seed, i);
    const s = (signBits & 1) ? 1 : -1;
    out[bucket % d] += s * x;
  }
  return out;
}

// ── pure vector math (no deps) ───────────────────────────────────────────────

function _dot(a, b, off = 0, len = null) {
  const L = len == null ? a.length : len;
  let s = 0;
  for (let i = 0; i < L; i++) s += a[off + i] * b[i];
  return s;
}

function _norm(a, off = 0, len = null) {
  const L = len == null ? a.length : len;
  let s = 0;
  for (let i = 0; i < L; i++) { const v = a[off + i]; s += v * v; }
  return Math.sqrt(s);
}

function _cosine(a, b, aOff, len, bNorm) {
  const na = _norm(a, aOff, len);
  const nb = bNorm == null ? _norm(b, 0, len) : bNorm;
  const denom = na * nb;
  if (denom === 0) return 0;
  return _dot(a, b, aOff, len) / denom;
}

function _percentile(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx];
}

// ── scoring kernels (one train row vs the val grads, over checkpoints) ───────
//
// Each operates on a flat Float64Array trainRow of [nck*d] (checkpoint-major)
// and an array `val` of nck Float64Array(d) plus lr[]. Returns a scalar.

function _tracinScore(trainRow, valByCkpt, lr, d) {
  // Inf(z) = (1/|C|) sum_c lr_c * < g_c(z), G_c(V) >  (raw lr-weighted dot).
  const nck = valByCkpt.length;
  if (nck === 0) return 0;
  let acc = 0;
  for (let c = 0; c < nck; c++) {
    const eta = Number.isFinite(Number(lr[c])) ? Number(lr[c]) : 1;
    acc += eta * _dot(trainRow, valByCkpt[c], c * d, d);
  }
  return acc / nck;
}

function _lessScore(trainRow, valByCkpt, valNorms, d) {
  // s_LESS(z) = (1/|C|) sum_c cos( ghat_c(z), Ghat_c(V) )  (magnitude-free).
  // ghat is assumed Adam-preconditioned + L2-normalized at write time; we cosine
  // again here so a raw store still yields a valid magnitude-free score.
  const nck = valByCkpt.length;
  if (nck === 0) return 0;
  let acc = 0;
  for (let c = 0; c < nck; c++) {
    acc += _cosine(trainRow, valByCkpt[c], c * d, d, valNorms[c]);
  }
  return acc / nck;
}

function _ekfacScore(trainRow, valByCkpt, factors, d) {
  // Inf_EKFAC(z,V) = ghat(z)^T Hhat^{-1} G(V), with Hhat^{-1} applied blockwise
  // in the Kronecker eigenbasis: divide by (lambda_A*lambda_S + damping). The
  // worker emits per-checkpoint eigenvalue vectors `inv` of length d (already the
  // 1/(lambda+damping) diagonal in the projected eigenbasis). We apply it as a
  // preconditioned dot: sum_c (g_c .* inv_c) . G_c.
  const nck = valByCkpt.length;
  if (nck === 0) return 0;
  let acc = 0;
  for (let c = 0; c < nck; c++) {
    const inv = factors.inv[c];
    const v = valByCkpt[c];
    let s = 0;
    const base = c * d;
    for (let i = 0; i < d; i++) s += (trainRow[base + i] * inv[i]) * v[i];
    acc += s;
  }
  return acc / nck;
}

// ── store reader (lazy, seek-based; never loads train_grads.f32 fully) ───────

function _readJson(file) {
  const txt = fs.readFileSync(file, 'utf8');
  return JSON.parse(txt);
}

function _readJsonl(file) {
  const out = [];
  const txt = fs.readFileSync(file, 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip malformed */ }
  }
  return out;
}

function _readF32File(file) {
  // Read an entire small .f32 file (val_grads / lr) into a Float32Array.
  const buf = fs.readFileSync(file);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}

/**
 * readGradStore(dir, namespace) -> parsed manifest + lazy binary accessors.
 * Pure node:fs; the big train_grads.f32 is NEVER fully loaded - `readTrainRow`
 * seeks to a row's byte offset and reads only nck*d floats.
 * @returns {{ok:boolean, version:string, error?:string, manifest?:object, root?:string,
 *   readTrainRow?:(idx:number)=>Float64Array, valByCkpt?:Float64Array[], lr?:number[],
 *   trainIds?:object[], close?:()=>void}}
 */
export function readGradStore(dir, namespace) {
  try {
    const root = path.join(_gradStoreRoot(dir), String(namespace || 'default'));
    const manifestPath = path.join(root, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'no_grad_store', root };
    }
    let manifest;
    try { manifest = _readJson(manifestPath); }
    catch (e) { return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'manifest_unreadable:' + String((e && e.message) || e), root }; }

    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'manifest_malformed', root };
    }
    if (manifest.version !== MANIFEST_VERSION) {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'manifest_version_mismatch', root, manifest };
    }
    const d = Math.trunc(Number(manifest.proj_dim));
    const seed = manifest.proj_seed;
    if (!Number.isFinite(d) || d <= 0 || seed == null || seed === '') {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'proj_params_missing', root, manifest };
    }
    const nck = Math.max(0, Math.trunc(Number(manifest.n_checkpoints) || 0));
    const nTrain = Math.max(0, Math.trunc(Number(manifest.n_train) || 0));

    // val_grads.f32: nck * d floats -> nck Float64Array(d) (promoted for math).
    const valPath = path.join(root, 'val_grads.f32');
    if (!fs.existsSync(valPath)) {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'val_grads_missing', root, manifest };
    }
    const valFlat = _readF32File(valPath);
    if (valFlat.length !== nck * d) {
      return { ok: false, version: VALUE_INFLUENCE_VERSION, error: 'val_grads_shape_mismatch', root, manifest };
    }
    const valByCkpt = [];
    const valNorms = [];
    for (let c = 0; c < nck; c++) {
      const v = new Float64Array(d);
      for (let i = 0; i < d; i++) v[i] = valFlat[c * d + i];
      valByCkpt.push(v);
      valNorms.push(_norm(v, 0, d));
    }

    // lr.f32 (binary copy of the manifest learning rates; manifest is the source
    // of truth, the binary is the hot-loop copy). Fall back to manifest.
    let lr = [];
    const lrPath = path.join(root, 'lr.f32');
    if (fs.existsSync(lrPath)) {
      const lrFlat = _readF32File(lrPath);
      if (lrFlat.length >= nck) for (let c = 0; c < nck; c++) lr.push(lrFlat[c]);
    }
    if (lr.length !== nck) {
      lr = [];
      const cks = Array.isArray(manifest.checkpoints) ? manifest.checkpoints : [];
      for (let c = 0; c < nck; c++) {
        const ck = cks[c];
        lr.push(ck && Number.isFinite(Number(ck.lr)) ? Number(ck.lr) : 1);
      }
    }

    // train_ids.jsonl - the join table.
    let trainIds = [];
    const idsPath = path.join(root, 'train_ids.jsonl');
    if (fs.existsSync(idsPath)) trainIds = _readJsonl(idsPath);

    // train_grads.f32 - opened lazily; readTrainRow seeks per row (no full load).
    const gradsPath = path.join(root, 'train_grads.f32');
    let fd = null;
    const rowFloats = nck * d;
    const rowBytes = rowFloats * 4;
    const readTrainRow = (idx) => {
      if (idx < 0 || idx >= nTrain) return null;
      if (fd == null) {
        if (!fs.existsSync(gradsPath)) return null;
        fd = fs.openSync(gradsPath, 'r');
      }
      const buf = Buffer.allocUnsafe(rowBytes);
      const got = fs.readSync(fd, buf, 0, rowBytes, idx * rowBytes);
      if (got !== rowBytes) return null;
      const f32 = new Float32Array(buf.buffer, buf.byteOffset, rowFloats);
      const row = new Float64Array(rowFloats);
      for (let i = 0; i < rowFloats; i++) row[i] = f32[i];
      return row;
    };

    // EK-FAC factors (opt-in). ekfac_index.json carries per-checkpoint inverse
    // eigenvalue diagonals already projected to d; ekfac_factors.bin holds them.
    let ekfac = null;
    const ekIndexPath = path.join(root, 'ekfac_index.json');
    const ekBinPath = path.join(root, 'ekfac_factors.bin');
    if (fs.existsSync(ekIndexPath) && fs.existsSync(ekBinPath)) {
      try {
        const idx = _readJson(ekIndexPath);
        const bin = _readF32File(ekBinPath);
        if (idx && Array.isArray(idx.checkpoints) && bin.length >= nck * d) {
          const inv = [];
          for (let c = 0; c < nck; c++) {
            const v = new Float64Array(d);
            for (let i = 0; i < d; i++) v[i] = bin[c * d + i];
            inv.push(v);
          }
          ekfac = { inv };
        }
      } catch (_) { ekfac = null; } // absent/corrupt factors -> degrade to less.
    }

    const close = () => { if (fd != null) { try { fs.closeSync(fd); } catch (_) {} fd = null; } };

    return {
      ok: true,
      version: VALUE_INFLUENCE_VERSION,
      manifest,
      root,
      proj_dim: d,
      proj_seed: seed,
      n_checkpoints: nck,
      n_train: nTrain,
      valByCkpt,
      valNorms,
      lr,
      trainIds,
      readTrainRow,
      ekfac,
      close,
    };
  } catch (e) {
    return { ok: false, version: VALUE_INFLUENCE_VERSION, error: String((e && e.message) || e) };
  }
}

// ── headline API ─────────────────────────────────────────────────────────────

/**
 * valuePairsByInfluence - per-pair targeted-influence valuation.
 * @param {object} args
 * @param {object[]} args.pairs        curate pairs to score (joined by _rowId).
 * @param {string} [args.namespace='default']
 * @param {string} [args.gradStoreDir] override store root.
 * @param {string} [args.method='less'] 'less' | 'tracin' | 'ekfac'.
 * @param {number} [args.damping]       EK-FAC damping (forwarded into report).
 * @param {object} [args.ekfacFactors]  injected factors (tests); else read from store.
 * @returns {{ok:boolean, version:string, method?:string, n_scored?:number,
 *   n_unmatched?:number, scores?:(number|null)[], value_by_id?:object, report?:object, error?:string}}
 */
export function valuePairsByInfluence({
  pairs,
  namespace = 'default',
  gradStoreDir = null,
  method = 'less',
  damping = 0.1,
  ekfacFactors = null,
} = {}) {
  try {
    const rows = Array.isArray(pairs) ? pairs : [];
    const requested = ['less', 'tracin', 'ekfac'].includes(method) ? method : 'less';

    const store = readGradStore(gradStoreDir, namespace);

    // Degrade ladder #1: store missing -> ok:true, all-null scores (caller floors
    // to quality scores). NOT an error: "no measurement", not "low value".
    if (!store.ok && store.error === 'no_grad_store') {
      return {
        ok: true,
        version: VALUE_INFLUENCE_VERSION,
        method: requested,
        n_scored: 0,
        n_unmatched: rows.length,
        scores: rows.map(() => null),
        value_by_id: {},
        report: {
          backend_used: 'none',
          degraded: true,
          degrade_reason: 'no_grad_store',
          proj_dim: null,
          proj_seed: null,
          n_checkpoints: 0,
          score_p50: null,
          score_p90: null,
        },
      };
    }

    // Any other read failure (malformed manifest, bad binary shapes) is also a
    // fail-closed REFUSE except the disjointness gate which we report distinctly.
    if (!store.ok) {
      return {
        ok: false,
        version: VALUE_INFLUENCE_VERSION,
        error: store.error || 'grad_store_unreadable',
      };
    }

    // Degrade ladder #2 / moat: REFUSE any store not attested holdout-disjoint.
    if (store.manifest.holdout_disjoint_attested !== true) {
      return {
        ok: false,
        version: VALUE_INFLUENCE_VERSION,
        error: 'holdout_disjointness_unattested',
      };
    }

    const d = store.proj_dim;
    const nck = store.n_checkpoints;

    // EK-FAC opt-in: degrade to LESS (stamped) when no factors present.
    let backend = requested;
    let degraded = false;
    let degradeReason = null;
    const factors = ekfacFactors || store.ekfac || null;
    if (requested === 'ekfac' && !factors) {
      backend = 'less';
      degraded = true;
      degradeReason = 'ekfac_factors_absent';
    }

    // Build the idx lookup from train_ids.jsonl (pair_id -> row idx).
    const idToIdx = new Map();
    for (const t of store.trainIds) {
      if (t && t.pair_id != null && Number.isInteger(t.idx)) {
        if (!idToIdx.has(String(t.pair_id))) idToIdx.set(String(t.pair_id), t.idx);
      }
    }

    const scores = new Array(rows.length).fill(null);
    const valueById = {};
    const observed = [];
    let nScored = 0;
    let nUnmatched = 0;

    for (let r = 0; r < rows.length; r++) {
      const pid = _rowId(rows[r]);
      const idx = idToIdx.has(pid) ? idToIdx.get(pid) : -1;
      if (idx < 0) { nUnmatched += 1; continue; }
      const trainRow = store.readTrainRow(idx);
      if (!trainRow) { nUnmatched += 1; continue; }
      let s;
      if (backend === 'tracin') {
        s = _tracinScore(trainRow, store.valByCkpt, store.lr, d);
      } else if (backend === 'ekfac' && factors) {
        s = _ekfacScore(trainRow, store.valByCkpt, factors, d);
      } else {
        s = _lessScore(trainRow, store.valByCkpt, store.valNorms, d);
      }
      if (!Number.isFinite(s)) s = 0;
      scores[r] = s;
      valueById[pid] = s;
      observed.push(s);
      nScored += 1;
    }
    if (store.close) store.close();

    const sorted = observed.slice().sort((a, b) => a - b);
    const p50 = _percentile(sorted, 0.5);
    const p90 = _percentile(sorted, 0.9);

    return {
      ok: true,
      version: VALUE_INFLUENCE_VERSION,
      method: requested,
      n_scored: nScored,
      n_unmatched: nUnmatched,
      scores,
      value_by_id: valueById,
      report: {
        backend_used: backend,
        degraded,
        degrade_reason: degradeReason,
        proj_dim: d,
        proj_seed: store.proj_seed,
        n_checkpoints: nck,
        damping: backend === 'ekfac' ? Number(damping) : null,
        model_fingerprint: store.manifest.model_fingerprint || null,
        holdout_disjoint_attested: true,
        score_p50: p50 == null ? null : Number(p50.toFixed(6)),
        score_p90: p90 == null ? null : Number(p90.toFixed(6)),
      },
    };
  } catch (e) {
    // NEVER throw - return a well-formed failure envelope.
    return { ok: false, version: VALUE_INFLUENCE_VERSION, error: String((e && e.message) || e) };
  }
}

export const __internals = {
  _tracinScore,
  _lessScore,
  _ekfacScore,
  _sparseSignProject,
  _rowId,
  _pairInput,
  _pairOutput,
  _dot,
  _norm,
  _cosine,
  _gradStoreRoot,
};

export default {
  VALUE_INFLUENCE_VERSION,
  valuePairsByInfluence,
  readGradStore,
  __internals,
};
