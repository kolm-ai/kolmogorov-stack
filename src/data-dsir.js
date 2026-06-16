// KOLM Data Engine - TRUE DSIR target-matched data selection (Xie et al.,
// "Data Selection for Language Models via Importance Resampling", NeurIPS 2023).
//
// This is the GENUINE DSIR algorithm, not the centroid-cosine proxy that
// `data-select.selectInformativeSubset` uses (that path is now demoted to the
// 'dsir-lite' fallback in data-curate). It implements the paper's three moving
// parts, all pure-JS / zero-dep / deterministic:
//
//   1. HASHED N-GRAM FEATURES. Each document is reduced to a bag of hashed
//      n-gram counts over a fixed feature space of K buckets (the paper uses
//      unigrams + bigrams hashed into 10k buckets; we expose `buckets` and
//      default to 10000). A hash collision is acceptable noise - the whole point
//      of "hashed n-gram" features is a compact, fixed-width, model-free
//      representation that two bag-of-words generative models can be fit over.
//
//   2. TWO BAG-OF-WORDS GENERATIVE MODELS. We fit a unigram-bag generative model
//      over the feature space from each corpus:
//        p_target(feature) - from the reference / target corpus, and
//        p_raw(feature)     - from the candidate pool itself.
//      Each is a smoothed categorical distribution over the K buckets
//      (per-bucket count + Laplace alpha, normalized). Under a bag-of-words
//      (per-feature independence) model, the log-likelihood of a document x is
//      log p(x) = sum_f count_x(f) * log p(f). The per-document IMPORTANCE WEIGHT
//      is then the log-likelihood RATIO:
//        w_i = log p_target(x_i) - log p_raw(x_i)
//            = sum_f count_xi(f) * ( log p_target(f) - log p_raw(f) ).
//      A high w_i means x_i looks much more like the target corpus than like the
//      generic raw pool - exactly the documents DSIR wants to over-sample.
//
//   3. IMPORTANCE RESAMPLING via GUMBEL-TOP-k (SIR, without replacement). The
//      paper resamples target_size documents with probability proportional to
//      exp(w_i) (Sampling-Importance-Resampling). Multinomial SIR is random;
//      for a DETERMINISTIC, reproducible artifact we use the Gumbel-top-k trick
//      (Vieira 2014 / Kool et al. 2019): drawing the top-k of
//        key_i = w_i + g_i,   g_i = -log(-log u_i)   (a Gumbel(0,1) sample)
//      is EXACTLY equivalent to sampling k items without replacement with
//      probability proportional to exp(w_i) (the Gumbel-max / Plackett-Luce
//      identity). We seed each u_i from a deterministic per-index hash, so the
//      same (pool, target, seed) always yields the same selection - the moat
//      needs reproducible selection for a signed .kolm artifact.
//
// A KL diagnostic proves the method moved the selected subset's n-gram
// distribution TOWARD the target: KL(selected || target) < KL(pool || target).
//
// Caveats:
//   - Hashed features collide; with the default 10k buckets and short corpora
//     this is negligible for the ratio but real. Raise `buckets` for big pools.
//   - The bag-of-words model is per-feature-independent by construction (it is
//     the model DSIR fits); it is not a sequence model. That is the paper's
//     design, chosen precisely so importance weights are cheap and stable.
//   - Determinism comes from the seeded Gumbel keys; pass a different `seed` to
//     draw a different (still reproducible) resample.
//
// Envelope: selectByDSIR returns a plain result object and NEVER throws across
// its API (it validates and returns a typed error object instead).

import crypto from 'node:crypto';

export const DSIR_VERSION = 'dsir-v1';

const DEFAULT_BUCKETS = 10000;
const DEFAULT_ALPHA = 1.0; // Laplace smoothing pseudo-count per bucket
const DEFAULT_NGRAMS = [1, 2]; // unigram + bigram, per the paper

// ── text extraction (mirrors data-select / data-curate / minhash-dedup) ───────

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

function _itemText(it) {
  if (typeof it === 'string') return it;
  if (it && typeof it === 'object') {
    if (typeof it.text === 'string') return it.text;
    return (_pairInput(it) + '\n\n' + _pairOutput(it)).trim();
  }
  return '';
}

// ── tokenization + hashed n-gram featurization ────────────────────────────────

function _tokens(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Deterministic 32-bit unsigned hash of a string into [0, buckets).
function _hashBucket(s, buckets) {
  const h = crypto.createHash('sha1').update(s).digest();
  const u32 = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  return u32 % buckets;
}

/**
 * featurize(text, buckets, ngrams) - hashed n-gram bag-of-words counts.
 * Returns a sparse Map<bucketIndex, count> plus the total token-feature mass.
 * @param {string} text
 * @param {number} buckets  feature-space size K
 * @param {number[]} ngrams  e.g. [1,2] for unigram+bigram
 * @returns {{counts:Map<number,number>, total:number}}
 */
export function featurize(text, buckets = DEFAULT_BUCKETS, ngrams = DEFAULT_NGRAMS) {
  const toks = _tokens(text);
  const counts = new Map();
  let total = 0;
  for (const n of ngrams) {
    if (n <= 0) continue;
    for (let i = 0; i + n <= toks.length; i++) {
      // namespace the gram by its arity so unigram "a" and a bigram starting
      // "a ..." never collide deterministically in the hash key.
      const gram = String(n) + ':' + toks.slice(i, i + n).join(' ');
      const b = _hashBucket(gram, buckets);
      counts.set(b, (counts.get(b) || 0) + 1);
      total += 1;
    }
  }
  return { counts, total };
}

// ── bag-of-words generative model fit ─────────────────────────────────────────

/**
 * fitBowModel(featuresList, buckets, alpha) - fit a smoothed categorical
 * distribution over the K feature buckets from a list of per-doc featurizations.
 * Returns log-probabilities per bucket (Float64Array of length buckets) and the
 * log-prob mass for an UNSEEN bucket (the Laplace floor), so scoring a doc whose
 * feature was never observed in this corpus is still finite.
 * @param {{counts:Map<number,number>}[]} featuresList
 * @param {number} buckets
 * @param {number} alpha  Laplace pseudo-count per bucket
 * @returns {{logp:Float64Array, logpUnseen:number, total:number}}
 */
export function fitBowModel(featuresList, buckets = DEFAULT_BUCKETS, alpha = DEFAULT_ALPHA) {
  const counts = new Float64Array(buckets);
  let total = 0;
  for (const f of featuresList) {
    if (!f || !f.counts) continue;
    for (const [b, c] of f.counts) {
      counts[b] += c;
      total += c;
    }
  }
  // Smoothed categorical: p(f) = (count[f] + alpha) / (total + alpha*K).
  const denom = total + alpha * buckets;
  const logp = new Float64Array(buckets);
  const logDenom = Math.log(denom);
  for (let b = 0; b < buckets; b++) {
    logp[b] = Math.log(counts[b] + alpha) - logDenom;
  }
  // Unseen bucket (count 0) shares the same floor (alpha/denom) - but every
  // bucket index is in-range here, so this is the alpha-only floor used when a
  // model is queried against another model's feature space of the same K.
  const logpUnseen = Math.log(alpha) - logDenom;
  return { logp, logpUnseen, total };
}

// log p(doc) under a fitted bag-of-words model = sum_f count(f) * log p(f).
function _logLik(features, model) {
  let s = 0;
  for (const [b, c] of features.counts) {
    const lp = (b >= 0 && b < model.logp.length) ? model.logp[b] : model.logpUnseen;
    s += c * lp;
  }
  return s;
}

// ── Gumbel-top-k importance resampling (deterministic SIR w/o replacement) ─────

// Deterministic uniform(0,1) seeded by (seed, index). Two sha256 words give 52
// bits of mantissa precision - plenty for a stable Gumbel key.
function _seededUniform(seed, index) {
  const h = crypto.createHash('sha256').update(String(seed) + ':' + String(index)).digest();
  // assemble 52 bits from the first 7 bytes for a double in [0,1).
  let hi = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0; // 32 bits
  let lo = ((h[4] << 12) | (h[5] << 4) | (h[6] >> 4)) >>> 0;          // 20 bits
  // u in [0,1): hi occupies the top 32 bits, lo the bottom 20 -> 52-bit mantissa.
  // hi * 2^20 + lo  over  2^52. Two bugs were here: the old multiplier 4194304 (2^22,
  // not 2^20) made u range up to ~2.0 and clamp half the draws to 1; the old divisor
  // 9007199254740992 (2^53, not 2^52) then halved the range so u averaged 0.25 / capped
  // at 0.5. Correct: shift hi by 20 bits (1048576) and normalize by 2^52.
  const u = (hi * 1048576 + lo) / 4503599627370496; // 2^20=1048576, 2^52=4503599627370496
  // guard the open interval so -log(-log u) is finite.
  if (u <= 0) return Number.EPSILON;
  if (u >= 1) return 1 - Number.EPSILON;
  return u;
}

/**
 * gumbelTopK(logWeights, k, seed) - select k indices via the Gumbel-top-k trick,
 * EXACTLY equivalent to sampling k items WITHOUT replacement with probability
 * proportional to exp(logWeights[i]). Deterministic for a fixed seed.
 * @param {number[]|Float64Array} logWeights  unnormalized log-importance per item
 * @param {number} k
 * @param {number|string} [seed=0]
 * @returns {number[]}  selected indices, sorted ascending
 */
export function gumbelTopK(logWeights, k, seed = 0) {
  const n = logWeights.length;
  const budget = Math.min(n, Math.max(0, Math.trunc(Number(k) || 0)));
  if (budget === 0) return [];
  const keys = new Array(n);
  for (let i = 0; i < n; i++) {
    const u = _seededUniform(seed, i);
    const g = -Math.log(-Math.log(u)); // Gumbel(0,1)
    const lw = Number.isFinite(logWeights[i]) ? logWeights[i] : -Infinity;
    keys[i] = { i, key: lw + g };
  }
  // top-k by key; tie-break on index for full determinism.
  keys.sort((a, b) => (b.key - a.key) || (a.i - b.i));
  const sel = keys.slice(0, budget).map((e) => e.i);
  sel.sort((a, b) => a - b);
  return sel;
}

// ── KL diagnostic ─────────────────────────────────────────────────────────────

// Build a smoothed categorical distribution (Float64Array, sums ~1) over the K
// buckets from a list of featurizations - used only for the diagnostic.
function _empiricalDist(featuresList, buckets, alpha) {
  const counts = new Float64Array(buckets);
  let total = 0;
  for (const f of featuresList) {
    if (!f || !f.counts) continue;
    for (const [b, c] of f.counts) { counts[b] += c; total += c; }
  }
  const denom = total + alpha * buckets;
  const p = new Float64Array(buckets);
  for (let b = 0; b < buckets; b++) p[b] = (counts[b] + alpha) / denom;
  return p;
}

// KL(p || q) = sum p * log(p/q). Both smoothed => finite.
function _kl(p, q) {
  let s = 0;
  for (let b = 0; b < p.length; b++) {
    if (p[b] > 0) s += p[b] * Math.log(p[b] / q[b]);
  }
  return s;
}

// ── headline API ──────────────────────────────────────────────────────────────

/**
 * selectByDSIR({pool, target_items, target_size, ...opts}) - TRUE DSIR.
 *
 * Fits p_target from target_items and p_raw from pool over a shared hashed
 * n-gram feature space, computes the per-pair log-importance
 * w_i = log p_target(x_i) - log p_raw(x_i), then importance-resamples
 * target_size pairs via deterministic Gumbel-top-k (SIR without replacement).
 *
 * @param {object} args
 * @param {object[]|string[]} args.pool          candidate pool
 * @param {object[]|string[]} args.target_items  reference / target corpus
 * @param {number} args.target_size  >1 = count, 0<x<=1 = fraction of pool
 * @param {number} [args.buckets=10000]   hashed feature-space size K
 * @param {number[]} [args.ngrams=[1,2]]  n-gram arities
 * @param {number} [args.alpha=1.0]       Laplace smoothing
 * @param {number|string} [args.seed=0]   Gumbel resample seed (determinism)
 * @returns {{ok:boolean, version:string, n_in:number, n_selected:number,
 *   selected_indices:number[], kept:object[], log_importance:number[],
 *   diagnostics:object, error?:string}}
 */
export function selectByDSIR({
  pool,
  pairs,
  target_items,
  target_size,
  buckets = DEFAULT_BUCKETS,
  ngrams = DEFAULT_NGRAMS,
  alpha = DEFAULT_ALPHA,
  seed = 0,
} = {}) {
  // accept `pool` (direct callers) or `pairs` (data-curate's pipeline variable).
  const rows = Array.isArray(pool) ? pool : (Array.isArray(pairs) ? pairs : []);
  const targets = Array.isArray(target_items) ? target_items : [];
  const n = rows.length;
  const K = Number.isFinite(Number(buckets)) && Number(buckets) > 0 ? Math.trunc(Number(buckets)) : DEFAULT_BUCKETS;
  const grams = (Array.isArray(ngrams) && ngrams.length) ? ngrams.map(Number).filter((x) => x > 0) : DEFAULT_NGRAMS;
  const a = Number.isFinite(Number(alpha)) && Number(alpha) > 0 ? Number(alpha) : DEFAULT_ALPHA;

  const base = { ok: true, version: DSIR_VERSION, n_in: n };

  if (n === 0) {
    return { ...base, n_selected: 0, selected_indices: [], kept: [], log_importance: [], diagnostics: { reason: 'empty_pool' } };
  }
  if (targets.length === 0) {
    // No target corpus: DSIR is undefined (no p_target to match). Fail loud in
    // the envelope - the caller (data-curate) degrades to 'dsir-lite'.
    return {
      ...base,
      ok: false,
      error: 'dsir_requires_target_items: no reference/target corpus supplied (pass opts.target_items). Falling back is the caller\'s job.',
      n_selected: 0,
      selected_indices: [],
      kept: [],
      log_importance: [],
      diagnostics: { reason: 'no_target' },
    };
  }

  // Resolve budget.
  const t = Number(target_size);
  let B;
  if (!Number.isFinite(t) || t <= 0) B = n;
  else if (t > 1) B = Math.min(n, Math.max(1, Math.trunc(t)));
  else B = Math.min(n, Math.max(1, Math.round(t * n)));

  // 1. featurize pool + target into the shared hashed n-gram space.
  const poolFeats = rows.map((p) => featurize(_itemText(p), K, grams));
  const targetFeats = targets.map((p) => featurize(_itemText(p), K, grams));

  // 2. fit the two bag-of-words generative models.
  const pTarget = fitBowModel(targetFeats, K, a);
  const pRaw = fitBowModel(poolFeats, K, a);

  // 2b. per-pair log-importance w_i = log p_target(x_i) - log p_raw(x_i).
  const logImportance = poolFeats.map((f) => _logLik(f, pTarget) - _logLik(f, pRaw));

  // 3. importance-resample via deterministic Gumbel-top-k (SIR w/o replacement).
  const selected = gumbelTopK(logImportance, B, seed);

  // diagnostics: prove the selected subset moved TOWARD the target.
  const targetDist = _empiricalDist(targetFeats, K, a);
  const poolDist = _empiricalDist(poolFeats, K, a);
  const selectedFeats = selected.map((i) => poolFeats[i]);
  const selectedDist = _empiricalDist(selectedFeats, K, a);

  const klPoolTarget = _kl(poolDist, targetDist);
  const klSelectedTarget = _kl(selectedDist, targetDist);

  const selSet = new Set(selected);
  const selW = selected.map((i) => logImportance[i]);
  const unselW = [];
  for (let i = 0; i < n; i++) if (!selSet.has(i)) unselW.push(logImportance[i]);
  const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : 0);

  return {
    ...base,
    n_selected: selected.length,
    selected_indices: selected,
    kept: selected.map((i) => rows[i]),
    log_importance: logImportance,
    diagnostics: {
      buckets: K,
      ngrams: grams,
      alpha: a,
      seed,
      target_size: B,
      // KL toward the target: selected should be < pool (moved toward target).
      kl_pool_to_target: Number(klPoolTarget.toFixed(8)),
      kl_selected_to_target: Number(klSelectedTarget.toFixed(8)),
      kl_improvement: Number((klPoolTarget - klSelectedTarget).toFixed(8)),
      moved_toward_target: klSelectedTarget <= klPoolTarget,
      // mean importance of picked vs dropped - picked should be higher.
      mean_log_importance_selected: Number(mean(selW).toFixed(8)),
      mean_log_importance_unselected: Number(mean(unselW).toFixed(8)),
      target_token_mass: pTarget.total,
      pool_token_mass: pRaw.total,
    },
  };
}

export const __internals = {
  _itemText,
  _tokens,
  _hashBucket,
  _logLik,
  _empiricalDist,
  _kl,
  _seededUniform,
};

export default {
  DSIR_VERSION,
  selectByDSIR,
  featurize,
  fitBowModel,
  gumbelTopK,
  __internals,
};
