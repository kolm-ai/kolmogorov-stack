// KOLM Data Engine - MinHash + LSH near-duplicate deduper (W921).
//
// A dependency-free Broder MinHash + LSH banding deduper that collapses exact
// and near-exact {input,output} training pairs in near-LINEAR time, so the
// expensive O(n^2) semantic (embedding-cosine) dedup only ever sees a small
// set of survivors - and so the JS curate path scales past a few thousand rows
// without invoking python.
//
// Pipeline placement: a NEW curate stage "b0. minhash-predup" runs in Node
// BEFORE the python embedding pass. It removes exact + near-exact dups; the
// python semantic pass stays as the tier-2 paraphrase catcher. On a python-less
// box near-dup removal STILL happens (today it silently no-ops).
//
// Four classic stages (Broder MinHash + LSH banding, Leskovec/Rajaraman/Ullman
// MMDS ch.3; Lee 2021 NEARDUP; HuggingFace DataTrove; NVIDIA NeMo Curator):
//   1. SHINGLE - word 5-grams (matches capture-importance._shingles), each
//                  shingle hashed to a 32-bit int via dependency-free FNV-1a.
//   2. SIGNATURE - N = bands*rows MinHash slots from a FIXED seeded universal
//                  hash family h_i(x)=(a_i*x+b_i) mod (2^31-1).
//   3. LSH - split signature into bands; band-tuple hashed to a
//                  band-index-namespaced bucket; >=1 collision => candidate.
//   4. CLUSTER - union-find over candidate edges => connected components;
//                  keep ONE survivor per component (confidence>teacher>quality);
//                  optional true-Jaccard VERIFY (default on) kills LSH FPs.
//
// Envelope contract: minhashPredup never throws on malformed rows (empty /
// non-string => returned as singletons). ZERO new npm deps - node:crypto for
// the dedup_signature sha256, hand-rolled FNV-1a + a seeded LCG for the
// permutation family. JS is the source of truth; the python mirror
// (workers/data/scripts/minhash_dedup.py) shares the same seed + FNV + 5-shingle
// rule for cross-language reproducible signatures.

import crypto from 'node:crypto';

export const MINHASH_VERSION = 'minhash-v1';

// Mersenne prime modulus for the universal hash family. 2^31 - 1.
const MERSENNE_P = 0x7fffffff; // 2147483647
const DEFAULT_SEED = 0x6b6f6c6d; // 'kolm'
const NGRAM_K = 5; // word 5-grams - LLM-dedup standard (Lee 2021), matches capture-importance.

// ── 1. SHINGLE ───────────────────────────────────────────────────────────────

/**
 * fnv1a32(s) - 32-bit FNV-1a hash of a string's UTF-16 code units (low byte).
 * Mirrors src/ab-router.js fnv1a so JS callers agree; the python mirror hashes
 * the same low-byte stream for cross-language parity.
 * @param {string} s
 * @returns {number} unsigned 32-bit int
 */
export function fnv1a32(s) {
  const str = String(s == null ? '' : s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function _normalizeText(text) {
  // Lowercase, collapse all whitespace runs to single spaces, trim.
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * shingleSet(text, k=5) - set of FNV-1a-hashed word k-grams (normalized).
 * Short text (< k tokens) collapses to a single whole-sequence shingle so two
 * equally short identical texts collide cleanly and short different texts don't
 * over-merge (matches capture-importance._shingles short-text fallback).
 * @param {string} text
 * @param {number} [k=5]
 * @returns {Set<number>} set of 32-bit shingle hashes
 */
export function shingleSet(text, k = NGRAM_K) {
  const out = new Set();
  const norm = _normalizeText(text);
  if (!norm) return out;
  const toks = norm.split(' ').filter(Boolean);
  if (toks.length === 0) return out;
  const kk = Math.max(1, Math.trunc(Number(k) || NGRAM_K));
  if (toks.length < kk) {
    out.add(fnv1a32(toks.join(' ')));
    return out;
  }
  for (let i = 0; i <= toks.length - kk; i++) {
    out.add(fnv1a32(toks.slice(i, i + kk).join(' ')));
  }
  return out;
}

// ── 2. SIGNATURE ─────────────────────────────────────────────────────────────

// Seeded LCG (Numerical Recipes constants) - reproducible across processes and
// mirrored in python. Returns a function yielding 32-bit unsigned ints.
function _lcg(seed) {
  let state = (seed >>> 0) || 1;
  return function next() {
    // state = (1664525 * state + 1013904223) mod 2^32
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state;
  };
}

/**
 * makePermutations(numHashes=128, seed) - FIXED seeded universal-hash family.
 * a_i drawn in [1, P-1] (non-degenerate), b_i in [0, P-1], P = 2^31-1.
 * Shared with the python mirror via the identical seed + LCG.
 * @param {number} [numHashes=128]
 * @param {number} [seed]
 * @returns {{a: Int32Array, b: Int32Array}}
 */
export function makePermutations(numHashes = 128, seed = DEFAULT_SEED) {
  const n = Math.max(1, Math.trunc(Number(numHashes) || 128));
  const a = new Int32Array(n);
  const b = new Int32Array(n);
  const rng = _lcg((Number(seed) >>> 0) || DEFAULT_SEED);
  for (let i = 0; i < n; i++) {
    // a_i in [1, P-1]: never 0 (would collapse the hash to a constant).
    a[i] = (rng() % (MERSENNE_P - 1)) + 1;
    b[i] = rng() % MERSENNE_P;
  }
  return { a, b };
}

// (a*x + b) mod P with 53-bit-safe multiplication. a,x < 2^31 so a*x < 2^62 - 
// too large for exact JS integer math, so split a into high/low 16-bit halves.
function _affineModP(a, x, b) {
  const ax = a >>> 0;
  const xx = x >>> 0;
  const hi = (ax >>> 16) & 0xffff;
  const lo = ax & 0xffff;
  // (hi*2^16 + lo) * xx mod P, each partial product kept under 2^48 (safe).
  const hiPart = ((hi * xx) % MERSENNE_P) * 65536 % MERSENNE_P;
  const loPart = (lo * xx) % MERSENNE_P;
  let r = (hiPart + loPart + (b >>> 0)) % MERSENNE_P;
  if (r < 0) r += MERSENNE_P;
  return r >>> 0;
}

/**
 * minhashSignature(shingles, perms) - MinHash signature (length numHashes).
 * signature[i] = min over shingles of (a_i*x + b_i) mod (2^31-1).
 * Empty shingle set => all-zero signature (a deterministic sentinel; such rows
 * collide with each other but real text never produces an all-zero signature
 * for non-degenerate permutations).
 * @param {Set<number>} shingles
 * @param {{a: Int32Array, b: Int32Array}} perms
 * @returns {Int32Array}
 */
export function minhashSignature(shingles, perms) {
  const a = perms && perms.a;
  const b = perms && perms.b;
  const n = a ? a.length : 0;
  const sig = new Int32Array(n);
  if (!shingles || shingles.size === 0) {
    return sig; // all zeros
  }
  for (let i = 0; i < n; i++) {
    let mn = MERSENNE_P; // max possible value of the hash
    const ai = a[i];
    const bi = b[i];
    for (const x of shingles) {
      const h = _affineModP(ai, x, bi);
      if (h < mn) mn = h;
    }
    sig[i] = mn;
  }
  return sig;
}

// ── 3. LSH BANDING ───────────────────────────────────────────────────────────

/**
 * lshBuckets(signature, bands=16, rows=8, idx) - band-hashed, band-index-
 * namespaced bucket keys. Two pairs are CANDIDATES iff they collide in >=1 band.
 * The band index is folded into the bucket key so an identical row-tuple in two
 * different bands cannot cross-collide.
 * @param {Int32Array} signature
 * @param {number} [bands=16]
 * @param {number} [rows=8]
 * @returns {string[]} bucket keys, one per band
 */
export function lshBuckets(signature, bands = 16, rows = 8) {
  const sig = signature || new Int32Array(0);
  const b = Math.max(1, Math.trunc(Number(bands) || 16));
  const r = Math.max(1, Math.trunc(Number(rows) || 8));
  const out = [];
  const usableBands = Math.min(b, Math.floor(sig.length / r) || (sig.length >= 1 ? 1 : 0));
  for (let band = 0; band < usableBands; band++) {
    // FNV-1a over the band index then each slot's 4 bytes - order-sensitive.
    let h = 0x811c9dc5;
    // mix the band index first
    let bi = band >>> 0;
    for (let k = 0; k < 4; k++) {
      h ^= bi & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      bi >>>= 8;
    }
    for (let slot = 0; slot < r; slot++) {
      let v = (sig[band * r + slot] | 0) >>> 0;
      for (let k = 0; k < 4; k++) {
        h ^= v & 0xff;
        h = Math.imul(h, 0x01000193) >>> 0;
        v >>>= 8;
      }
    }
    out.push('b' + band + ':' + ((h >>> 0).toString(36)));
  }
  return out;
}

// ── 4. JACCARD ESTIMATE ──────────────────────────────────────────────────────

/**
 * estimateJaccard(sigA, sigB) - fraction of agreeing signature slots. Unbiased
 * estimator of Jaccard(A,B); std err ~ sqrt(J(1-J)/N).
 * @param {Int32Array} sigA
 * @param {Int32Array} sigB
 * @returns {number} in [0,1]
 */
export function estimateJaccard(sigA, sigB) {
  const a = sigA || new Int32Array(0);
  const b = sigB || new Int32Array(0);
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let agree = 0;
  for (let i = 0; i < n; i++) if (a[i] === b[i]) agree++;
  return agree / n;
}

// True Jaccard over the actual shingle sets (used by the verify pass).
function _trueJaccard(setA, setB) {
  if (!setA || !setB) return 0;
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  let inter = 0;
  for (const s of small) if (large.has(s)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ── UNION-FIND ───────────────────────────────────────────────────────────────

/**
 * UnionFind - disjoint-set with path compression + union by rank.
 * components() returns Map<root, member-index[]> (mirrors NeMo
 * BucketsToEdges -> ConnectedComponents / text-dedup).
 */
export class UnionFind {
  constructor(n) {
    const size = Math.max(0, Math.trunc(Number(n) || 0));
    this.parent = new Int32Array(size);
    this.rank = new Uint8Array(size);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(i) {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    // path compression
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(i, j) {
    const ri = this.find(i);
    const rj = this.find(j);
    if (ri === rj) return;
    if (this.rank[ri] < this.rank[rj]) {
      this.parent[ri] = rj;
    } else if (this.rank[ri] > this.rank[rj]) {
      this.parent[rj] = ri;
    } else {
      this.parent[rj] = ri;
      this.rank[ri] += 1;
    }
  }

  components() {
    const map = new Map();
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      let arr = map.get(r);
      if (!arr) { arr = []; map.set(r, arr); }
      arr.push(i);
    }
    return map;
  }
}

// ── OPTIMAL BANDS (datasketch _optimal_param mirror) ─────────────────────────

// Probability that two pairs with Jaccard s collide in at least one band given
// b bands of r rows: P(s) = 1 - (1 - s^r)^b.
function _probCollide(s, b, r) {
  return 1 - Math.pow(1 - Math.pow(s, r), b);
}

// Numeric integral of f over [lo,hi] via the trapezoid rule (no scipy).
function _integrate(f, lo, hi, steps = 200) {
  if (hi <= lo) return 0;
  const h = (hi - lo) / steps;
  let sum = 0.5 * (f(lo) + f(hi));
  for (let i = 1; i < steps; i++) sum += f(lo + i * h);
  return sum * h;
}

/**
 * optimalBands(threshold, numHashes, fpWeight, fnWeight) - datasketch-style
 * (b,r) selection minimizing the weighted FP+FN integral of the S-curve for a
 * target Jaccard threshold. FP integrated over [0, threshold] (pairs below the
 * bar that still collide); FN over [threshold, 1] (pairs above the bar that
 * fail to collide). Steepest-rise threshold of the chosen (b,r) ~ (1/b)^(1/r).
 * @param {number} [threshold=0.85]
 * @param {number} [numHashes=128]
 * @param {number} [fpWeight=0.5]
 * @param {number} [fnWeight=0.5]
 * @returns {{bands:number, rows:number, threshold_est:number}}
 */
export function optimalBands(threshold = 0.85, numHashes = 128, fpWeight = 0.5, fnWeight = 0.5) {
  const N = Math.max(1, Math.trunc(Number(numHashes) || 128));
  const t = Math.min(0.999, Math.max(0.001, Number(threshold) || 0.85));
  const fw = Number(fpWeight);
  const nw = Number(fnWeight);
  const fpW = Number.isFinite(fw) ? fw : 0.5;
  const fnW = Number.isFinite(nw) ? nw : 0.5;
  let best = null;
  for (let b = 1; b <= N; b++) {
    if (N % b !== 0) continue; // require b*r == N exactly
    const r = N / b;
    // FP: collision probability mass below the threshold (false merges).
    const fp = _integrate((s) => _probCollide(s, b, r), 0, t);
    // FN: non-collision mass above the threshold (missed dups).
    const fn = _integrate((s) => 1 - _probCollide(s, b, r), t, 1);
    const err = fpW * fp + fnW * fn;
    if (best === null || err < best.err) {
      best = { bands: b, rows: r, err, threshold_est: Math.pow(1 / b, 1 / r) };
    }
  }
  if (!best) return { bands: 1, rows: N, threshold_est: Math.pow(1, 1 / N) };
  return { bands: best.bands, rows: best.rows, threshold_est: Number(best.threshold_est.toFixed(4)) };
}

// ── survivor selection (confidence > teacher-priority > quality) ─────────────

const _DEFAULT_TEACHER_PRIORITY = [];

const _HARD_COT = [/<\/?think>/i, /<\/?reasoning>/i, /<\|?\s*thinking\s*\|?>/i, /<\|?\s*reasoning\s*\|?>/i];
const _REFUSAL = /\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b/i;
const _STRUCTURE = /(^|\n)\s*(\d+[.)]|[-*•])\s+/m;

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

function _pairTeacher(p) {
  if (!p || typeof p !== 'object') return '';
  return String(p._teacher_phase || p.teacher || p.teacher_spec || p.vendor || '');
}

function _pairText(p, key) {
  if (key === 'input') return _pairInput(p);
  if (key === 'output') return _pairOutput(p);
  return (_pairInput(p) + '\n\n' + _pairOutput(p)).trim();
}

function _words(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function _tokenOverlap(candidate, reference) {
  const ref = new Set(_words(reference).filter((w) => w.length > 2));
  if (ref.size === 0) return 0;
  const cand = new Set(_words(candidate).filter((w) => w.length > 2));
  let inter = 0;
  for (const w of cand) if (ref.has(w)) inter++;
  return inter / ref.size;
}

// Self-contained local quality heuristic in [0,1]. Mirrors dedup_pairs.py
// score_quality / the (yet-to-be-restored) scoreCandidateLocal so this module
// has ZERO hard dependency on unbuilt code while honoring the same survivor
// contract: explicit confidence > teacher-priority > quality score.
function _scoreQuality(text, seed) {
  const s = String(text == null ? '' : text);
  let score = 0.5;
  if (_HARD_COT.some((re) => re.test(s))) score -= 0.5;
  if (_REFUSAL.test(s)) score -= 0.2;
  const n = s.trim().length;
  if (n < 20) score -= 0.2;
  else if (n < 60) score -= 0.1;
  else if (n <= 1200) score += 0.1;
  else if (n > 2000) score -= 0.1;
  if (_STRUCTURE.test(s)) score += 0.05;
  if (seed) score += 0.3 * _tokenOverlap(s, seed);
  return Math.max(0, Math.min(1, score));
}

function _matchTeacherRank(teacher, priority) {
  const t = String(teacher || '').toLowerCase();
  for (let i = 0; i < priority.length; i++) {
    const key = String(priority[i] || '').toLowerCase();
    if (key && t.includes(key)) return i;
  }
  return Number.MAX_SAFE_INTEGER;
}

// Returns a comparable sort tuple [teacherRank, -quality, originalIdx]; SMALLER
// sorts first = better survivor. Stable tie-break on original index keeps
// determinism.
function _confidenceKey(pair, idx, priority) {
  const explicit = pair && typeof pair.confidence === 'number' ? pair.confidence : null;
  const base = explicit !== null
    ? explicit
    : _scoreQuality(_pairOutput(pair), pair && pair.seed_output);
  const rank = _matchTeacherRank(_pairTeacher(pair), priority);
  return [rank, -base, idx];
}

function _cmpKey(ka, kb) {
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] - kb[2];
}

// ── minhashPredup (headline export) ──────────────────────────────────────────

/**
 * minhashPredup(pairs, opts) - corpus near-dup pre-pass.
 * @param {object[]} pairs  {input|prompt, output|teacher_output|response}[]
 * @param {object} [opts]
 * @param {number} [opts.numHashes=128]
 * @param {number} [opts.bands=16]
 * @param {number} [opts.rows=8]
 * @param {number} [opts.jaccardThreshold=0.85]  verify-pass true-Jaccard floor
 * @param {'pair'|'input'|'output'} [opts.key='pair']
 * @param {number} [opts.k=5]  shingle word-gram size
 * @param {boolean} [opts.verify=true]  recompute true Jaccard per edge to kill LSH FPs
 * @param {string[]} [opts.teacherPriority]  ordered teacher keys (earlier = preferred survivor)
 * @param {number} [opts.seed]  permutation seed (shared with python)
 * @returns {{kept:object[], clusters:number[][], removals:Array<{removed_idx:number,kept_idx:number,est_jaccard:number}>, report:object}}
 */
export function minhashPredup(pairs, opts = {}) {
  const rows = Array.isArray(pairs) ? pairs : [];
  const numHashes = Math.max(1, Math.trunc(Number(opts.numHashes) || 128));
  let bands = Math.max(1, Math.trunc(Number(opts.bands) || 16));
  let rowsPerBand = Math.max(1, Math.trunc(Number(opts.rows) || 8));
  // Keep banding consistent with the signature length: bands*rows must not
  // exceed numHashes. If misconfigured, re-derive an optimal split.
  if (bands * rowsPerBand > numHashes || (numHashes % rowsPerBand !== 0 && bands * rowsPerBand !== numHashes)) {
    const opt = optimalBands(Number(opts.jaccardThreshold) || 0.85, numHashes);
    bands = opt.bands;
    rowsPerBand = opt.rows;
  }
  const jaccardThreshold = Number.isFinite(Number(opts.jaccardThreshold))
    ? Number(opts.jaccardThreshold) : 0.85;
  const key = (opts.key === 'input' || opts.key === 'output') ? opts.key : 'pair';
  const k = Math.max(1, Math.trunc(Number(opts.k) || NGRAM_K));
  const verify = opts.verify !== false; // default ON
  const priority = Array.isArray(opts.teacherPriority) ? opts.teacherPriority : _DEFAULT_TEACHER_PRIORITY;
  const seed = (Number(opts.seed) >>> 0) || DEFAULT_SEED;

  const params = {
    numHashes, bands, rows: rowsPerBand, jaccardThreshold, key, k, verify, seed,
  };

  const n = rows.length;
  if (n === 0) {
    return {
      kept: [],
      clusters: [],
      removals: [],
      report: {
        n_in: 0, n_kept: 0, n_removed: 0, n_clusters: 0,
        params, backend: 'minhash-js', version: MINHASH_VERSION,
        dedup_signature: dedupSignature([], params),
      },
    };
  }

  const perms = makePermutations(numHashes, seed);

  // Build shingle sets + signatures + band buckets for every row.
  const shingleSets = new Array(n);
  const signatures = new Array(n);
  const bucketMap = new Map(); // bucketKey -> indices[]
  for (let i = 0; i < n; i++) {
    const sh = shingleSet(_pairText(rows[i], key), k);
    shingleSets[i] = sh;
    const sig = minhashSignature(sh, perms);
    signatures[i] = sig;
    const buckets = lshBuckets(sig, bands, rowsPerBand);
    for (const bk of buckets) {
      let arr = bucketMap.get(bk);
      if (!arr) { arr = []; bucketMap.set(bk, arr); }
      arr.push(i);
    }
  }

  // Candidate edges from bucket co-membership; optional true-Jaccard verify.
  const uf = new UnionFind(n);
  const edgeJaccard = new Map(); // "i,j" -> est_jaccard, for removal records
  for (const arr of bucketMap.values()) {
    if (arr.length < 2) continue;
    for (let x = 0; x < arr.length; x++) {
      for (let y = x + 1; y < arr.length; y++) {
        const i = arr[x];
        const j = arr[y];
        if (uf.find(i) === uf.find(j)) continue; // already merged
        const est = estimateJaccard(signatures[i], signatures[j]);
        if (verify) {
          const tj = _trueJaccard(shingleSets[i], shingleSets[j]);
          if (tj < jaccardThreshold) continue; // LSH false positive - skip
        }
        uf.union(i, j);
        const ek = i < j ? i + ',' + j : j + ',' + i;
        if (!edgeJaccard.has(ek)) edgeJaccard.set(ek, est);
      }
    }
  }

  // Connected components -> clusters; keep one survivor per component.
  const compMap = uf.components();
  const keptIdx = new Set();
  const removals = [];
  const clusters = [];
  const confKeys = new Array(n);
  for (let i = 0; i < n; i++) confKeys[i] = _confidenceKey(rows[i], i, priority);

  for (const members of compMap.values()) {
    if (members.length === 1) {
      keptIdx.add(members[0]);
      continue;
    }
    // sort cluster members by survivor preference (best first)
    const sorted = members.slice().sort((a, b) => _cmpKey(confKeys[a], confKeys[b]));
    const survivor = sorted[0];
    keptIdx.add(survivor);
    clusters.push(sorted.slice());
    for (let m = 1; m < sorted.length; m++) {
      const dropped = sorted[m];
      const ek = dropped < survivor ? dropped + ',' + survivor : survivor + ',' + dropped;
      let est = edgeJaccard.get(ek);
      if (est === undefined) {
        // dropped & survivor weren't a direct edge (transitive cluster) - use
        // the signature estimate against the survivor directly.
        est = estimateJaccard(signatures[dropped], signatures[survivor]);
      }
      removals.push({
        removed_idx: dropped,
        kept_idx: survivor,
        est_jaccard: Number(est.toFixed(4)),
      });
    }
  }

  // kept rows in original input order (determinism).
  const kept = [];
  for (let i = 0; i < n; i++) if (keptIdx.has(i)) kept.push(rows[i]);
  removals.sort((a, b) => a.removed_idx - b.removed_idx);

  const report = {
    n_in: n,
    n_kept: kept.length,
    n_removed: removals.length,
    n_clusters: clusters.length,
    params,
    backend: 'minhash-js',
    version: MINHASH_VERSION,
    dedup_signature: dedupSignature(removals, params),
  };

  return { kept, clusters, removals, report };
}

// ── dedup_signature (receipt) ────────────────────────────────────────────────

/**
 * dedupSignature(removals, params) - sha256 over the sorted drop set + params.
 * Deterministic + receipt-able: same seed + input => same signature, and the
 * python mirror produces the same value.
 * @param {object[]} removals
 * @param {object} params
 * @returns {string} 'sha256:<hex>'
 */
export function dedupSignature(removals, params) {
  const sorted = (Array.isArray(removals) ? removals : [])
    .map((r) => [r.removed_idx, r.kept_idx, r.est_jaccard])
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const payload = JSON.stringify({
    params: _canonParams(params),
    removals: sorted,
  });
  return 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex');
}

function _canonParams(params) {
  const p = params || {};
  // Stable key order so the signature is invariant to property insertion order.
  return {
    bands: p.bands,
    jaccardThreshold: p.jaccardThreshold,
    k: p.k,
    key: p.key,
    numHashes: p.numHashes,
    rows: p.rows,
    seed: p.seed,
    verify: p.verify,
  };
}

export default {
  MINHASH_VERSION,
  fnv1a32,
  shingleSet,
  makePermutations,
  minhashSignature,
  lshBuckets,
  estimateJaccard,
  UnionFind,
  optimalBands,
  minhashPredup,
  dedupSignature,
};
