// KOLM Data Engine - embedding k-means clustering + topic auto-labeling (W921).
//
// Turns the CURATE "cluster" stage from a lexical 3-gram-prefix hash bucket into
// real, semantic, human-named topics. Canonical embed -> cluster -> label
// pipeline (NeMo Curator / BERTopic / TnT-LLM lineage), specialized to
// small/medium task-distillation corpora and implemented in pure JS so the
// default path needs no python, no sklearn, and no model download.
//
// PIPELINE (per namespace, deterministic):
//   1. EMBED - cluster text t = input (+ a slice of output), encoded with the
//               deterministic 256-d hash-bag embedder (src/embedding.js), unit-
//               normalized (Euclidean k-means == cosine k-means for unit vectors).
//   2. CLUSTER - k-means++ seeding (seeded LCG, deterministic) + Lloyd
//               iterations. AUTO-k: grid around round(sqrt(n/2)) clamped to
//               [2, min(maxK, n//2)], pick argmax silhouette over a sample.
//               opts.n_clusters overrides.
//   3. LABEL - c-TF-IDF (BERTopic representation): cluster pseudo-doc = concat
//               of member inputs; tf = L1-normalized cluster term freq; idf =
//               log(1 + A/f_t); top-n terms -> slug 'refund_return_policy'.
//   4. EMIT - per-pair cluster_id (stable slug) + cluster_idx (int); topics
//               report with size/top_terms/representative_inputs/silhouette.
//
// The optional teacher-naming tier (TnT-LLM/BERTopic-LLM style) is INJECTABLE
// (pass a labeler fn) so it never hard-requires a network call; absent it, the
// deterministic c-TF-IDF slug is used. Falls back to c-TF-IDF on any labeler
// failure.
//
// Envelope contract: clusterAndLabel returns {ok, version:'cluster-label-v1',...}
// and NEVER throws. Determinism: identical pairs + seed => identical assignment,
// labels, and topic order (k-means++ uses the seeded RNG). Pure JS, zero deps.

import { embed as _embedText } from './embedding.js';

export const CLUSTER_LABEL_VERSION = 'cluster-label-v1';

// English stopwords for c-TF-IDF labeling (kept small + frozen for determinism).
const _STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'when', 'of', 'to',
  'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as', 'is', 'are', 'was', 'were',
  'be', 'been', 'being', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you',
  'he', 'she', 'it', 'we', 'they', 'me', 'my', 'your', 'his', 'her', 'its', 'our',
  'their', 'this', 'that', 'these', 'those', 'can', 'could', 'will', 'would',
  'should', 'may', 'might', 'must', 'how', 'what', 'why', 'where', 'who', 'which',
  'not', 'no', 'yes', 'so', 'up', 'out', 'get', 'got', 'from', 'into', 'please',
  'help', 'need', 'want', 'there', 'here', 'just', 'any', 'all', 'some', 'more',
]);

// ── pair text extraction (mirrors data-curate / data-select) ─────────────────

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

function _clusterText(p, outputChars = 256) {
  const inp = _pairInput(p);
  const out = _pairOutput(p);
  return (inp + ' ' + String(out || '').slice(0, outputChars)).trim();
}

function _tokens(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

// seeded LCG for deterministic k-means++ seeding.
function _lcg(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (Math.imul(1664525, s) + 1013904223) >>> 0; return s / 4294967296; };
}

function _sqDist(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return s;
}

function _unitMean(vectors, dim) {
  const c = new Array(dim).fill(0);
  if (!vectors.length) return c;
  for (const v of vectors) for (let d = 0; d < dim; d++) c[d] += v[d];
  let norm = 0;
  for (let d = 0; d < dim; d++) { c[d] /= vectors.length; norm += c[d] * c[d]; }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < dim; d++) c[d] /= norm;
  return c;
}

// ── k-means++ + Lloyd ─────────────────────────────────────────────────────────

/**
 * kmeans(embeddings, k, opts) - deterministic k-means++ seeding + Lloyd.
 * @param {number[][]} embeddings  N x d (unit-normalized)
 * @param {number} k
 * @param {object} [opts] {maxIter, seed}
 * @returns {{labels:number[], centroids:number[][], inertia:number}}
 */
export function kmeans(embeddings, k, opts = {}) {
  const embs = embeddings;
  const n = embs.length;
  const dim = n ? embs[0].length : 0;
  const K = Math.max(1, Math.min(k | 0, n));
  const maxIter = Number.isFinite(opts.maxIter) ? opts.maxIter : 50;
  const rng = _lcg(Number.isFinite(opts.seed) ? opts.seed : 0x6b6f6c6d);

  // k-means++ seeding
  const centIdx = [0];
  // deterministic first center: index 0 (inputs arrive in stable order)
  const minSq = new Float64Array(n).fill(Infinity);
  for (let i = 0; i < n; i++) minSq[i] = _sqDist(embs[i], embs[0]);
  while (centIdx.length < K) {
    let total = 0;
    const cum = new Float64Array(n);
    for (let i = 0; i < n; i++) { total += minSq[i]; cum[i] = total; }
    let pick = -1;
    if (total <= 0) { for (let i = 0; i < n; i++) if (!centIdx.includes(i)) { pick = i; break; } }
    else {
      const r = rng() * total;
      for (let i = 0; i < n; i++) if (r <= cum[i] && !centIdx.includes(i)) { pick = i; break; }
      if (pick < 0) for (let i = n - 1; i >= 0; i--) if (!centIdx.includes(i)) { pick = i; break; }
    }
    if (pick < 0) break;
    centIdx.push(pick);
    for (let i = 0; i < n; i++) { const d = _sqDist(embs[i], embs[pick]); if (d < minSq[i]) minSq[i] = d; }
  }
  let centroids = centIdx.map((i) => embs[i].slice());
  const labels = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const d = _sqDist(embs[i], centroids[c]);
        if (d < bestD) { bestD = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; moved += 1; }
    }
    // recompute centroids (unit-mean); keep empty clusters at their old centroid
    const next = [];
    for (let c = 0; c < centroids.length; c++) {
      const members = [];
      for (let i = 0; i < n; i++) if (labels[i] === c) members.push(embs[i]);
      next.push(members.length ? _unitMean(members, dim) : centroids[c]);
    }
    centroids = next;
    if (moved === 0) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) inertia += _sqDist(embs[i], centroids[labels[i]]);
  return { labels, centroids, inertia: Number(inertia.toFixed(6)) };
}

// ── silhouette (sampled) ──────────────────────────────────────────────────────

/**
 * silhouetteScore(embeddings, labels, sampleCap) - mean silhouette over a
 * deterministic sample. Returns NaN if <2 clusters.
 */
export function silhouetteScore(embeddings, labels, sampleCap = 400) {
  const n = embeddings.length;
  const ks = new Set(labels);
  if (ks.size < 2 || n < 3) return NaN;
  // deterministic stride sample
  const stride = Math.max(1, Math.floor(n / Math.min(sampleCap, n)));
  const idxs = [];
  for (let i = 0; i < n; i += stride) idxs.push(i);
  const byCluster = new Map();
  for (let i = 0; i < n; i++) {
    if (!byCluster.has(labels[i])) byCluster.set(labels[i], []);
    byCluster.get(labels[i]).push(i);
  }
  let total = 0; let cnt = 0;
  for (const i of idxs) {
    const own = byCluster.get(labels[i]) || [];
    if (own.length <= 1) continue;
    let a = 0;
    for (const j of own) if (j !== i) a += Math.sqrt(_sqDist(embeddings[i], embeddings[j]));
    a /= (own.length - 1);
    let b = Infinity;
    for (const [c, members] of byCluster) {
      if (c === labels[i] || !members.length) continue;
      let d = 0;
      for (const j of members) d += Math.sqrt(_sqDist(embeddings[i], embeddings[j]));
      d /= members.length;
      if (d < b) b = d;
    }
    if (!Number.isFinite(b)) continue;
    const s = (b - a) / Math.max(a, b, 1e-12);
    total += s; cnt += 1;
  }
  return cnt ? total / cnt : NaN;
}

/**
 * chooseK(embeddings, kOverride, kMin, kMax) - auto-k via silhouette over a grid
 * around round(sqrt(n/2)).
 * @returns {{k:number, method:'override'|'silhouette'|'sqrt', silhouette:number|null}}
 */
export function chooseK(embeddings, kOverride = null, kMin = 2, kMax = 50) {
  const n = embeddings.length;
  if (Number.isFinite(kOverride) && kOverride >= 1) {
    return { k: Math.min(Math.max(1, kOverride | 0), n), method: 'override', silhouette: null };
  }
  const hi = Math.min(kMax | 0, Math.max(2, Math.floor(n / 2)));
  const lo = Math.max(2, kMin | 0);
  if (n < 4 || hi < lo) return { k: Math.min(Math.max(1, lo), n), method: 'sqrt', silhouette: null };
  const guess = Math.max(lo, Math.min(hi, Math.round(Math.sqrt(n / 2))));
  // grid: a small window around the sqrt guess
  const grid = new Set();
  for (const dk of [-2, -1, 0, 1, 2]) { const k = guess + dk; if (k >= lo && k <= hi) grid.add(k); }
  grid.add(lo); grid.add(hi);
  let best = null;
  for (const k of [...grid].sort((a, b) => a - b)) {
    const { labels } = kmeans(embeddings, k, {});
    const sil = silhouetteScore(embeddings, labels);
    if (!Number.isFinite(sil)) continue;
    if (best == null || sil > best.silhouette) best = { k, silhouette: sil };
  }
  if (!best) return { k: guess, method: 'sqrt', silhouette: null };
  return { k: best.k, method: 'silhouette', silhouette: Number(best.silhouette.toFixed(6)) };
}

// ── c-TF-IDF labeling ─────────────────────────────────────────────────────────

/**
 * labelClustersCtfidf(texts, labels, k, topN) - BERTopic c-TF-IDF top terms per
 * cluster. tf = L1-normalized cluster term freq; idf = log(1 + A/f_t) where A is
 * total token mass and f_t is term mass across the corpus.
 * @returns {Array<{idx:number, slug:string, top_terms:string[]}>}
 */
export function labelClustersCtfidf(texts, labels, k, topN = 3) {
  const K = k;
  const clusterTf = Array.from({ length: K }, () => new Map());
  const globalF = new Map();
  let totalMass = 0;
  for (let i = 0; i < texts.length; i++) {
    const c = labels[i];
    if (c < 0 || c >= K) continue;
    for (const tok of _tokens(texts[i])) {
      if (_STOP.has(tok) || tok.length < 3) continue;
      clusterTf[c].set(tok, (clusterTf[c].get(tok) || 0) + 1);
      globalF.set(tok, (globalF.get(tok) || 0) + 1);
      totalMass += 1;
    }
  }
  const A = totalMass || 1;
  const out = [];
  for (let c = 0; c < K; c++) {
    const tf = clusterTf[c];
    let l1 = 0;
    for (const v of tf.values()) l1 += v;
    l1 = l1 || 1;
    const scored = [];
    for (const [term, freq] of tf) {
      const tfn = freq / l1;
      const idf = Math.log(1 + A / (globalF.get(term) || 1));
      scored.push([term, tfn * idf]);
    }
    scored.sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    const top = scored.slice(0, topN).map((x) => x[0]);
    out.push({ idx: c, slug: _slugifyLabel(top.join(' ')) || ('cluster_' + c), top_terms: top });
  }
  return out;
}

/** _slugifyLabel('Refund & Return Policy') -> 'refund_return_policy' (<=40 chars). */
export function _slugifyLabel(label) {
  const s = String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '');
  return s;
}

// representative inputs: the member texts nearest to the cluster centroid.
function _representativeInputs(embs, centroids, labels, texts, c, perCluster = 3) {
  const members = [];
  for (let i = 0; i < labels.length; i++) if (labels[i] === c) members.push(i);
  members.sort((a, b) => _sqDist(embs[a], centroids[c]) - _sqDist(embs[b], centroids[c]));
  return members.slice(0, perCluster).map((i) => texts[i]);
}

// ── headline orchestrator ─────────────────────────────────────────────────────

/**
 * clusterAndLabel - embed -> k-means -> c-TF-IDF (or injected teacher labeler).
 * @param {object} args
 * @param {object[]} args.pairs
 * @param {number|null} [args.n_clusters]  override auto-k
 * @param {number} [args.top_n=3]  c-TF-IDF terms per label
 * @param {number} [args.seed=0x6b6f6c6d]
 * @param {(ctx:{idx,top_terms,representative_inputs})=>Promise<{label?:string,description?:string}>} [args.labeler]
 *        optional teacher labeler; absent => deterministic c-TF-IDF slug.
 * @returns {Promise<object>} {ok, version, k, k_method, method, assigned, topics, coverage}
 */
export async function clusterAndLabel({ pairs, n_clusters = null, top_n = 3, seed = 0x6b6f6c6d, labeler = null } = {}) {
  try {
    const rows = Array.isArray(pairs) ? pairs : [];
    const n = rows.length;
    const base = { ok: true, version: CLUSTER_LABEL_VERSION };
    if (n === 0) {
      return { ...base, k: 0, k_method: 'empty', method: 'kmeans:hashbag:ctfidf', assigned: [], topics: [], coverage: {} };
    }

    const texts = rows.map((p) => _clusterText(p));
    const embs = texts.map((t) => _embedText(t));

    const { k, method: kMethod, silhouette } = chooseK(embs, n_clusters, 2, 50);
    const { labels, centroids } = kmeans(embs, k, { seed });

    // c-TF-IDF base labels (always computed, used as fallback for teacher tier)
    const baseLabels = labelClustersCtfidf(texts.map((_, i) => _pairInput(rows[i])), labels, k, top_n);

    // de-dup slugs deterministically (append _2, _3, ...)
    const seen = new Map();
    for (const lab of baseLabels) {
      let slug = lab.slug || ('cluster_' + lab.idx);
      if (seen.has(slug)) { const c = seen.get(slug) + 1; seen.set(slug, c); slug = slug + '_' + c; }
      else seen.set(slug, 1);
      lab.slug = slug;
    }

    let labelMode = 'ctfidf';
    const descriptions = new Array(k).fill(null);
    if (typeof labeler === 'function') {
      let allOk = true;
      for (let c = 0; c < k; c++) {
        try {
          const res = await labeler({
            idx: c,
            top_terms: baseLabels[c].top_terms,
            representative_inputs: _representativeInputs(embs, centroids, labels, texts, c, 3),
          });
          if (res && typeof res.label === 'string' && res.label.trim()) {
            baseLabels[c].slug = _slugifyLabel(res.label) || baseLabels[c].slug;
          }
          if (res && typeof res.description === 'string') descriptions[c] = res.description;
        } catch (_) { allOk = false; }
      }
      labelMode = allOk ? 'teacher' : 'teacher_partial';
    }

    const assigned = rows.map((_, i) => ({ cluster_id: baseLabels[labels[i]].slug, cluster_idx: labels[i] }));
    const coverage = {};
    for (const a of assigned) coverage[a.cluster_id] = (coverage[a.cluster_id] || 0) + 1;

    const topics = [];
    for (let c = 0; c < k; c++) {
      const cid = baseLabels[c].slug;
      topics.push({
        cluster_id: cid,
        cluster_idx: c,
        label: cid,
        description: descriptions[c],
        size: coverage[cid] || 0,
        top_terms: baseLabels[c].top_terms,
        representative_inputs: _representativeInputs(embs, centroids, labels, texts.map((_, i) => _pairInput(rows[i])), c, 3),
        silhouette: silhouette != null ? silhouette : null,
      });
    }

    return {
      ...base,
      k,
      k_method: kMethod,
      method: 'kmeans:hashbag:' + labelMode,
      silhouette: silhouette != null ? silhouette : null,
      assigned,
      topics,
      coverage,
    };
  } catch (e) {
    return { ok: false, version: CLUSTER_LABEL_VERSION, error: String((e && e.message) || e), assigned: [], topics: [], coverage: {} };
  }
}

export const __internals = {
  _clusterText,
  _tokens,
  _lcg,
  _sqDist,
  _unitMean,
  _representativeInputs,
  _STOP,
};

export default {
  CLUSTER_LABEL_VERSION,
  clusterAndLabel,
  kmeans,
  chooseK,
  silhouetteScore,
  labelClustersCtfidf,
  _slugifyLabel,
  __internals,
};
