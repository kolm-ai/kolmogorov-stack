// KOLM Data Engine - data-valuation-eval (measured K-score-delta attribution +
// scaling-law-informed budget allocation across valuation signals).
//
// MOTIVATION. kolm has several competing data-VALUATION signals (SemDeDup-kept,
// DSIR distribution-matching, influence / LESS, Shapley, raw diversity). Each
// CLAIMS to pick the pairs that move the holdout K-Score most. Today nothing
// MEASURES which one actually paid off on THIS tenant's corpus, so the autopilot
// allocates the next acquisition budget on faith. This module replaces faith
// with a counterfactual measurement:
//
//   For a chosen valuation method, build two MATCHED corpora that differ ONLY in
//   the pairs that method would add (the "include" arm carries the signal's
//   picks; the "exclude" arm is the baseline without them, held to the same
//   size so token count - not corpus size - is the only confound), drive the
//   EXISTING distill+eval path on each, read the held-out K-Score via
//   data-evaluate.js, and record:
//
//     delta_K            = K(include) - K(exclude)                 (the payoff)
//     ci                 = paired-bootstrap 95% CI on delta_K      (is it real?)
//     teacher_tokens     = tokens the signal's added pairs cost    (the price)
//     dk_per_ktoken      = 1000 * delta_K / teacher_tokens         (efficiency)
//
//   ...and SIGNS the realized measurement (Ed25519, reusing src/ed25519.js) so a
//   compile report can prove which signal paid off without trusting the body.
//
// ALLOCATOR. allocateDataBudget() feeds the realized dk_per_ktoken of each signal
// into a scaling-law-informed split of the NEXT pair budget: proportional to the
// measured marginal dK/token, scaled by the rectified law's diminishing-returns
// envelope (so a signal that already saturated its region gets throttled even if
// its historical efficiency was high), with an EXPLORE FLOOR so an unmeasured or
// temporarily-weak signal never starves to zero (avoids premature convergence -
// the bandit lesson). This EXTENDS the scaling-law primitives in
// data-scaling-law.js (marginalDkPerRow / kHatAtSize); see crossFileNeeds for the
// planDataBudget hook the spec references.
//
// LEADERBOARD. buildValuationLeaderboardBlock() emits a report block (same
// envelope family as distill-report-blocks.js) ranking the signals by realized
// dk_per_ktoken so EVERY compile records which signal actually paid off.
//
// CONSTRAINTS / CAVEATS:
//   - This module NEVER invokes a GPU or the python evaluator. It DRIVES an
//     injectable runDistillEval(corpus, opts) the caller supplies (the real one
//     shells to workers/distill; tests inject a deterministic stand-in) and READS
//     the K-Score back through data-evaluate.evaluateRun / loadEvalJsons. No
//     network, no new npm deps, pure JS + node:crypto via ed25519.js.
//   - Holdout disjointness is the caller's contract (train-only distill). This
//     module reads the holdout K the evaluator already computed; it does not
//     mix holdout pairs into either arm. It refuses to fabricate a delta when an
//     arm fails to produce a readable K (fail-loud, basis:'unmeasured').
//   - Privacy: pairs are passed to the injected runner ONLY. This module does no
//     external call and writes no secrets. The signed block carries the realized
//     scalars + a corpus content-hash, never raw pair text.
//
// Envelope: every public fn returns {ok, version:'dval-v1', ...} or {ok:false,
// error, version:'dval-v1'}. Nothing throws across the public API.

import crypto from 'node:crypto';

import { canonicalJson } from './cid.js';
import { evaluateRun, loadEvalJsons } from './data-evaluate.js';
import { loadOrCreateDefaultSigner, buildSignatureBlock } from './ed25519.js';
import { kHatAtSize, marginalDkPerRow } from './data-scaling-law.js';

export const VALUATION_EVAL_VERSION = 'dval-v1';

// The valuation signals the allocator splits budget across. Order is the
// canonical leaderboard / allocation key order (stable across reports).
export const VALUATION_SIGNALS = Object.freeze([
  'semdedup-kept',
  'dsir',
  'influence-less',
  'shapley',
  'diversity',
]);

// Allocator defaults. EXPLORE_FLOOR is the minimum FRACTION of the budget any
// known signal is guaranteed (reserved equally, then the remainder is split by
// measured efficiency). Keeps an unmeasured / temporarily-weak signal alive.
const DEFAULT_EXPLORE_FLOOR = 0.05;
const DEFAULT_BOOTSTRAP_ITERS = 2000;
const DEFAULT_CI_ALPHA = 0.05; // 95% CI

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32) - the bootstrap MUST be reproducible so an
// identical measurement + seed yields an identical CI (bit-stable, like the
// scaling-law fitter). No Math.random anywhere.
// ---------------------------------------------------------------------------

function _mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function _seedFromString(s) {
  // FNV-1a 32-bit over the string -> a stable uint32 seed.
  let h = 0x811c9dc5;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------
// pair token accounting + content hash (privacy-preserving)
// ---------------------------------------------------------------------------

function _pairTokens(p) {
  // teacher tokens a pair COSTS to generate ~ the teacher OUTPUT length. Prefer
  // an explicit count the runner/curate stamped; else a coarse whitespace+char
  // proxy over the teacher output. Deterministic, no tokenizer dep.
  if (p && typeof p === 'object') {
    for (const k of ['teacher_tokens', 'completion_tokens', 'output_tokens', 'tokens']) {
      const v = Number(p[k]);
      if (Number.isFinite(v) && v > 0) return v;
    }
    const out = String(
      p.teacher_output != null ? p.teacher_output
        : p.output != null ? p.output
          : p.response != null ? p.response : '',
    );
    if (out.length === 0) return 1;
    // ~4 chars/token (GPT-family heuristic), floored at the word count.
    const words = out.split(/\s+/).filter(Boolean).length;
    return Math.max(1, words, Math.round(out.length / 4));
  }
  if (typeof p === 'string') return Math.max(1, Math.round(p.length / 4));
  return 1;
}

function _corpusTokens(corpus) {
  let t = 0;
  for (const p of (Array.isArray(corpus) ? corpus : [])) t += _pairTokens(p);
  return t;
}

function _corpusHash(corpus) {
  // content hash over a stable projection of each pair (NO raw text in the
  // signed block - this hash is the only corpus fingerprint that travels).
  const h = crypto.createHash('sha256');
  for (const p of (Array.isArray(corpus) ? corpus : [])) {
    const proj = (p && typeof p === 'object')
      ? { i: String(p.input || p.prompt || ''), o: String(p.teacher_output || p.output || p.response || '') }
      : { s: String(p) };
    h.update(canonicalJson(proj));
    h.update('\n');
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// matched include/exclude corpora
// ---------------------------------------------------------------------------

/**
 * buildMatchedCorpora - construct the two arms that differ ONLY in the signal's
 * added pairs, held to the SAME pair count so corpus size is not a confound.
 *
 *   include = baseline + added                (the signal's picks are present)
 *   exclude = baseline + filler[:|added|]     (same size, neutral filler)
 *
 * When no filler pool is available the arms differ in size; we record that in
 * `matched` so the caller (and the CI) knows tokens, not size, must carry the
 * attribution. The token delta is always computed from the ADDED pairs so the
 * efficiency denominator is the signal's true price regardless of matching mode.
 *
 * @param {object} args
 * @param {object[]} args.baseline   pairs present in BOTH arms
 * @param {object[]} args.added      pairs the valuation signal would ADD
 * @param {object[]} [args.filler]   neutral pairs to size-match the exclude arm
 * @returns {{include:object[], exclude:object[], added_tokens:number, matched:boolean, n_added:number}}
 */
export function buildMatchedCorpora({ baseline = [], added = [], filler = [] } = {}) {
  const base = Array.isArray(baseline) ? baseline.slice() : [];
  const add = Array.isArray(added) ? added.slice() : [];
  const fill = Array.isArray(filler) ? filler.slice() : [];
  const include = base.concat(add);
  let exclude;
  let matched;
  if (fill.length >= add.length) {
    exclude = base.concat(fill.slice(0, add.length));
    matched = true;
  } else {
    // not enough filler to size-match: exclude is the bare baseline. The CI +
    // efficiency still hold (token-denominated), but flag the size confound.
    exclude = base.concat(fill);
    matched = fill.length === add.length; // true only if both happen to be 0-add
  }
  return {
    include,
    exclude,
    added_tokens: _corpusTokens(add),
    matched,
    n_added: add.length,
  };
}

// ---------------------------------------------------------------------------
// paired bootstrap CI on delta_K
// ---------------------------------------------------------------------------

/**
 * pairedBootstrapCI - 95% CI on a delta given PER-ITEM holdout scores from the
 * two arms over a COMMON holdout. Resamples holdout indices with replacement
 * (paired: the same resampled index reads both arms), recomputing
 * delta = mean(include) - mean(exclude) each iter; the CI is the percentile
 * interval. Deterministic given `seed`.
 *
 * Falls back to a normal-approx CI from the paired-difference SD when only a
 * single aggregate per arm is available (no per-item vector) - flagged via
 * `basis`.
 *
 * @param {number[]} includeScores  per-holdout-item K for the include arm
 * @param {number[]} excludeScores  per-holdout-item K for the exclude arm (paired)
 * @param {object} [opts]
 * @returns {{delta:number, lo:number, hi:number, iters:number, basis:string, significant:boolean}}
 */
export function pairedBootstrapCI(includeScores, excludeScores, opts = {}) {
  const a = Array.isArray(includeScores) ? includeScores.map(Number).filter(Number.isFinite) : [];
  const b = Array.isArray(excludeScores) ? excludeScores.map(Number).filter(Number.isFinite) : [];
  const alpha = Number.isFinite(Number(opts.alpha)) ? Number(opts.alpha) : DEFAULT_CI_ALPHA;
  const iters = Number.isFinite(Number(opts.iters)) ? Math.max(50, Math.trunc(Number(opts.iters))) : DEFAULT_BOOTSTRAP_ITERS;
  const seed = opts.seed != null ? _seedFromString(opts.seed) : 0x9e3779b9;

  const mean = (arr) => (arr.length ? arr.reduce((x, y) => x + y, 0) / arr.length : NaN);

  // Paired per-item path: needs equal-length, non-empty paired vectors.
  if (a.length >= 2 && a.length === b.length) {
    const n = a.length;
    const diffs = a.map((x, i) => x - b[i]);
    const delta = mean(diffs);
    const rnd = _mulberry32(seed);
    const samples = new Array(iters);
    for (let t = 0; t < iters; t++) {
      let acc = 0;
      for (let i = 0; i < n; i++) {
        const idx = Math.min(n - 1, Math.floor(rnd() * n));
        acc += diffs[idx];
      }
      samples[t] = acc / n;
    }
    samples.sort((x, y) => x - y);
    const loIdx = Math.max(0, Math.floor((alpha / 2) * iters));
    const hiIdx = Math.min(iters - 1, Math.ceil((1 - alpha / 2) * iters) - 1);
    const lo = samples[loIdx];
    const hi = samples[hiIdx];
    return {
      delta: Number(delta.toFixed(8)),
      lo: Number(lo.toFixed(8)),
      hi: Number(hi.toFixed(8)),
      iters,
      basis: 'paired-bootstrap',
      significant: lo > 0 || hi < 0,
    };
  }

  // Aggregate-only fallback: delta from the two means, CI from a pooled SD
  // proxy. Wider + flagged - the caller should prefer to pass per-item vectors.
  const ma = mean(a);
  const mb = mean(b);
  if (!Number.isFinite(ma) || !Number.isFinite(mb)) {
    return { delta: NaN, lo: NaN, hi: NaN, iters: 0, basis: 'unmeasured', significant: false };
  }
  const sd = (arr, m) => (arr.length > 1
    ? Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / (arr.length - 1))
    : 0);
  const se = Math.sqrt((sd(a, ma) ** 2) / Math.max(1, a.length) + (sd(b, mb) ** 2) / Math.max(1, b.length));
  const z = 1.959963984540054; // 95%
  const delta = ma - mb;
  return {
    delta: Number(delta.toFixed(8)),
    lo: Number((delta - z * se).toFixed(8)),
    hi: Number((delta + z * se).toFixed(8)),
    iters: 0,
    basis: 'normal-approx',
    significant: (delta - z * se) > 0 || (delta + z * se) < 0,
  };
}

// ---------------------------------------------------------------------------
// drive distill+eval for one arm + read holdout K
// ---------------------------------------------------------------------------

// Read a holdout K (and optional per-item vector) from whatever the runner
// produced. The runner may return any of:
//   { run_dir }                       -> we evaluateRun() it
//   { k, per_item? }                  -> a direct K (+ optional per-holdout vec)
//   { eval_map }                      -> a preloaded loadEvalJsons() map
// We read the WORST-bench mean as the holdout K (matching evaluateRun's
// ship-gate metric), and collect per-item verdict scores when present.
async function _readArmK(runnerResult, { tenant, namespace } = {}) {
  if (!runnerResult || typeof runnerResult !== 'object') {
    return { ok: false, reason: 'runner returned no result' };
  }
  // Direct K path (deterministic test stand-ins / fast callers).
  if (Number.isFinite(Number(runnerResult.k))) {
    const per = Array.isArray(runnerResult.per_item)
      ? runnerResult.per_item.map(Number).filter(Number.isFinite) : null;
    return { ok: true, k: Number(runnerResult.k), per_item: per, source: 'direct' };
  }

  let evalMap = runnerResult.eval_map && typeof runnerResult.eval_map === 'object'
    ? runnerResult.eval_map
    : null;
  let evalReport = null;

  if (!evalMap && typeof runnerResult.run_dir === 'string' && runnerResult.run_dir) {
    evalReport = await evaluateRun({ tenant, namespace, run_dir: runnerResult.run_dir });
    if (!evalReport || evalReport.ok !== true) {
      return { ok: false, reason: 'evaluateRun failed: ' + ((evalReport && evalReport.error) || 'unknown') };
    }
    evalMap = loadEvalJsons(runnerResult.run_dir);
  }
  if (!evalMap || Object.keys(evalMap).length === 0) {
    return { ok: false, reason: 'no eval artifacts to read holdout K from' };
  }

  // worst-bench mean = the holdout K (mirrors evaluateRun ship gate).
  let worstK = Infinity;
  let perItem = [];
  for (const obj of Object.values(evalMap)) {
    if (!obj || typeof obj !== 'object') continue;
    const m = Number(obj.mean_score);
    const results = Array.isArray(obj.results) ? obj.results : [];
    let mean = Number.isFinite(m) ? m : null;
    const scored = [];
    for (const it of results) {
      const v = it && it.verdict && Number.isFinite(Number(it.verdict.score)) ? Number(it.verdict.score)
        : Number.isFinite(Number(it && it.score)) ? Number(it.score) : null;
      if (v != null) scored.push(v);
    }
    if (mean == null && scored.length) mean = scored.reduce((x, y) => x + y, 0) / scored.length;
    if (mean == null) continue;
    if (mean < worstK) { worstK = mean; perItem = scored; }
  }
  if (!Number.isFinite(worstK)) return { ok: false, reason: 'no readable bench mean in eval artifacts' };
  return { ok: true, k: worstK, per_item: perItem.length ? perItem : null, source: evalReport ? 'run_dir' : 'eval_map' };
}

/**
 * measureSignalDelta - the counterfactual harness for ONE valuation signal.
 *
 * Builds matched include/exclude corpora, drives the injected distill+eval
 * runner on each, reads the holdout K via data-evaluate, and records a SIGNED
 * delta_K with a paired-bootstrap CI and a per-teacher-token efficiency.
 *
 * @param {object} args
 * @param {string} args.signal               one of VALUATION_SIGNALS (or any label)
 * @param {object[]} args.baseline           pairs in BOTH arms
 * @param {object[]} args.added              pairs the signal would ADD
 * @param {object[]} [args.filler]           neutral pairs to size-match exclude
 * @param {(corpus:object[], ctx:object)=>Promise<object>} args.runDistillEval
 *        injected runner: trains+evals a corpus, returns {run_dir} | {k, per_item} | {eval_map}.
 *        NEVER invoked by this module's tests against a GPU - inject a stand-in.
 * @param {string} [args.tenant='tenant_local']
 * @param {string} [args.namespace='default']
 * @param {number} [args.bootstrap_iters=2000]
 * @param {number} [args.ci_alpha=0.05]
 * @param {object|null} [args.signer]        ed25519 signer; default loadOrCreateDefaultSigner
 * @returns {Promise<object>} {ok, version, signal, basis, delta_K, ci, teacher_tokens, dk_per_ktoken, signature_ed25519?, ...}
 */
export async function measureSignalDelta({
  signal,
  baseline = [],
  added = [],
  filler = [],
  runDistillEval,
  tenant = 'tenant_local',
  namespace = 'default',
  bootstrap_iters = DEFAULT_BOOTSTRAP_ITERS,
  ci_alpha = DEFAULT_CI_ALPHA,
  signer = undefined,
} = {}) {
  try {
    if (typeof runDistillEval !== 'function') {
      return { ok: false, version: VALUATION_EVAL_VERSION, error: 'runDistillEval(corpus, ctx) function is required (inject the real distill+eval runner; this module never invokes GPU)' };
    }
    const sig = String(signal || 'unknown');
    const corpora = buildMatchedCorpora({ baseline, added, filler });

    if (corpora.n_added === 0) {
      return {
        ok: true, version: VALUATION_EVAL_VERSION, signal: sig, basis: 'no-op',
        delta_K: 0, ci: { delta: 0, lo: 0, hi: 0, basis: 'no-op', significant: false },
        teacher_tokens: 0, dk_per_ktoken: 0, matched: corpora.matched,
        reason: 'signal added no pairs',
      };
    }

    const ctx = { tenant, namespace, signal: sig };
    const includeRun = await Promise.resolve(runDistillEval(corpora.include, { ...ctx, arm: 'include' }));
    const excludeRun = await Promise.resolve(runDistillEval(corpora.exclude, { ...ctx, arm: 'exclude' }));

    const incK = await _readArmK(includeRun, { tenant, namespace });
    const excK = await _readArmK(excludeRun, { tenant, namespace });

    if (!incK.ok || !excK.ok) {
      // FAIL LOUD: refuse to fabricate a delta when an arm did not produce a
      // readable holdout K. The signal stays 'unmeasured' (allocator floors it).
      return {
        ok: true, version: VALUATION_EVAL_VERSION, signal: sig, basis: 'unmeasured',
        delta_K: null, ci: { delta: null, lo: null, hi: null, basis: 'unmeasured', significant: false },
        teacher_tokens: corpora.added_tokens, dk_per_ktoken: null, matched: corpora.matched,
        reason: 'arm_unreadable:' + (incK.ok ? '' : 'include[' + incK.reason + ']') + (excK.ok ? '' : 'exclude[' + excK.reason + ']'),
      };
    }

    const ci = pairedBootstrapCI(incK.per_item, excK.per_item, {
      alpha: ci_alpha,
      iters: bootstrap_iters,
      seed: corpora_hash(corpora) + ':' + sig,
    });
    // When per-item vectors are unavailable, the CI falls back; use the arm-K
    // difference as the point delta either way (authoritative scalar).
    const delta_K = Number((incK.k - excK.k).toFixed(8));
    const teacher_tokens = corpora.added_tokens;
    const dk_per_ktoken = teacher_tokens > 0
      ? Number(((1000 * delta_K) / teacher_tokens).toFixed(10))
      : 0;

    const measured = {
      version: VALUATION_EVAL_VERSION,
      signal: sig,
      tenant,
      namespace,
      basis: 'measured',
      delta_K,
      ci: { delta: ci.delta, lo: ci.lo, hi: ci.hi, basis: ci.basis, significant: ci.significant },
      teacher_tokens,
      dk_per_ktoken,
      k_include: Number(incK.k.toFixed(8)),
      k_exclude: Number(excK.k.toFixed(8)),
      n_added: corpora.n_added,
      matched: corpora.matched,
      include_hash: _corpusHash(corpora.include),
      exclude_hash: _corpusHash(corpora.exclude),
      measured_at: new Date().toISOString(),
    };

    // Sign the realized measurement (reuse the moat's Ed25519 signer). On any
    // signer failure we still return the measurement, flagged unsigned.
    let signature_ed25519 = null;
    try {
      const s = signer === undefined ? loadOrCreateDefaultSigner() : signer;
      if (s && s.privateKey && s.publicKey) {
        // sign over the canonical payload EXCLUDING the volatile timestamp so a
        // re-measure of identical content/arms verifies deterministically.
        const { measured_at, ...stable } = measured;
        signature_ed25519 = buildSignatureBlock({
          privateKey: s.privateKey,
          publicKey: s.publicKey,
          key_fingerprint: s.key_fingerprint,
          payloadCanonical: canonicalJson(stable),
        });
      }
    } catch (_) { signature_ed25519 = null; }

    return { ok: true, ...measured, signature_ed25519 };
  } catch (e) {
    return { ok: false, version: VALUATION_EVAL_VERSION, error: String((e && e.message) || e) };
  }
}

// canonical seed string for the bootstrap from corpus hashes (stable per arm).
function corpora_hash(corpora) {
  return _corpusHash(corpora.include).slice(0, 16) + _corpusHash(corpora.exclude).slice(0, 16);
}

// ---------------------------------------------------------------------------
// ALLOCATOR - scaling-law-informed split of the next pair budget across signals
// ---------------------------------------------------------------------------

/**
 * allocateDataBudget - distribute the next pair budget across valuation signals
 * proportional to their MEASURED marginal dK/token, modulated by the rectified
 * scaling law's diminishing-returns envelope, with an EXPLORE FLOOR so no known
 * signal starves.
 *
 * Extends planDataBudget (data-scaling-law.js, see crossFileNeeds): where
 * recommendDataBudget answers "how many MORE pairs total", this answers "split
 * the next batch ACROSS signals by realized payoff".
 *
 * Weight per signal:
 *   w_i = max(0, dk_per_ktoken_i) * saturation_i
 *   saturation_i = clamp( marginalDkPerRow(fit, current_pairs) / marginalDkPerRow(fit, 1), 0, 1 )
 *                  when a fit is supplied (throttle a saturated region); else 1.
 * Allocation:
 *   floor each KNOWN signal explore_floor * budget (rounded), then split the
 *   remainder proportional to w_i. Unmeasured signals (null dk_per_ktoken) get
 *   ONLY the floor (pure exploration). Largest-remainder rounding => sum==budget.
 *
 * @param {object} args
 * @param {Array<{signal:string, dk_per_ktoken:(number|null), significant?:boolean}>} args.measurements
 * @param {number} args.budget               total pairs to split (integer)
 * @param {object} [args.fit]                rectified-law fit (data-scaling-law) for saturation throttle
 * @param {number} [args.current_pairs=0]    current corpus size (for the law)
 * @param {number} [args.explore_floor=0.05] min fraction reserved per known signal
 * @param {string[]} [args.signals]          signal universe (default VALUATION_SIGNALS)
 * @param {boolean} [args.require_significant=false] zero the proportional weight of non-significant signals
 * @returns {{ok, version, budget, allocation:object, weights:object, explore_floor, basis}}
 */
export function allocateDataBudget({
  measurements = [],
  budget,
  fit = null,
  current_pairs = 0,
  explore_floor = DEFAULT_EXPLORE_FLOOR,
  signals = VALUATION_SIGNALS,
  require_significant = false,
} = {}) {
  const B = Math.max(0, Math.trunc(Number(budget) || 0));
  const universe = Array.isArray(signals) && signals.length ? signals.slice() : VALUATION_SIGNALS.slice();
  const floorFrac = Math.min(0.5, Math.max(0, Number(explore_floor)));

  const bySignal = new Map();
  for (const m of (Array.isArray(measurements) ? measurements : [])) {
    if (m && typeof m === 'object' && m.signal != null) bySignal.set(String(m.signal), m);
  }

  if (B === 0) {
    const zero = {};
    for (const s of universe) zero[s] = 0;
    return { ok: true, version: VALUATION_EVAL_VERSION, budget: 0, allocation: zero, weights: {}, explore_floor: floorFrac, basis: 'empty-budget' };
  }

  // saturation throttle from the scaling law (1.0 when no fit / no current size).
  let saturation = 1;
  if (fit && Number.isFinite(Number(current_pairs)) && current_pairs > 0) {
    const mNow = marginalDkPerRow(fit, current_pairs);
    const mRef = marginalDkPerRow(fit, 1);
    if (Number.isFinite(mNow) && Number.isFinite(mRef) && mRef > 0) {
      saturation = Math.min(1, Math.max(0, mNow / mRef));
    }
  }

  // weights from measured efficiency.
  const weights = {};
  let wSum = 0;
  for (const s of universe) {
    const m = bySignal.get(s);
    let eff = m && Number.isFinite(Number(m.dk_per_ktoken)) ? Number(m.dk_per_ktoken) : null;
    if (eff == null) { weights[s] = null; continue; } // unmeasured -> floor only
    if (require_significant && m && m.significant === false) eff = 0;
    const w = Math.max(0, eff) * saturation;
    weights[s] = w;
    wSum += w;
  }

  // floor reservation (only KNOWN signals - measured OR unmeasured-but-in-universe
  // both deserve exploration; an unmeasured signal gets ONLY the floor).
  const floorEach = Math.floor(floorFrac * B);
  const reserved = {};
  let reservedTotal = 0;
  for (const s of universe) {
    reserved[s] = floorEach;
    reservedTotal += floorEach;
  }
  let remainder = Math.max(0, B - reservedTotal);

  // proportional split of the remainder by weight (largest-remainder rounding).
  const alloc = {};
  for (const s of universe) alloc[s] = reserved[s];

  if (remainder > 0) {
    const measuredSignals = universe.filter((s) => Number.isFinite(weights[s]) && weights[s] > 0);
    if (wSum > 0 && measuredSignals.length) {
      const raw = {};
      for (const s of measuredSignals) raw[s] = (weights[s] / wSum) * remainder;
      // floor + distribute leftover by largest fractional remainder.
      let assigned = 0;
      const fracs = [];
      for (const s of measuredSignals) {
        const f = Math.floor(raw[s]);
        alloc[s] += f;
        assigned += f;
        fracs.push([s, raw[s] - f]);
      }
      let leftover = remainder - assigned;
      fracs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      for (let i = 0; i < fracs.length && leftover > 0; i++) { alloc[fracs[i][0]] += 1; leftover--; }
      // any residual leftover (e.g. all fracs zero) goes to the top measured signal.
      if (leftover > 0 && fracs.length) alloc[fracs[0][0]] += leftover;
    } else {
      // no measured efficiency anywhere: spread the remainder EVENLY (pure
      // exploration) across the universe via largest-remainder.
      const per = remainder / universe.length;
      let assigned = 0;
      const fracs = [];
      for (const s of universe) { const f = Math.floor(per); alloc[s] += f; assigned += f; fracs.push([s, per - f]); }
      let leftover = remainder - assigned;
      fracs.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      for (let i = 0; i < fracs.length && leftover > 0; i++) { alloc[fracs[i][0]] += 1; leftover--; }
    }
  }

  // Final exact-sum guarantee: if floor rounding overshot B (tiny B), trim from
  // the smallest allocations; if it undershot, add to the largest.
  let total = universe.reduce((a, s) => a + alloc[s], 0);
  const order = universe.slice().sort((a, b) => alloc[b] - alloc[a] || a.localeCompare(b));
  let gi = 0;
  while (total > B) { const s = order[order.length - 1 - (gi % order.length)]; if (alloc[s] > 0) { alloc[s]--; total--; } gi++; if (gi > 10000) break; }
  gi = 0;
  while (total < B) { const s = order[gi % order.length]; alloc[s]++; total++; gi++; if (gi > 10000) break; }

  return {
    ok: true,
    version: VALUATION_EVAL_VERSION,
    budget: B,
    allocation: alloc,
    weights,
    saturation: Number(saturation.toFixed(6)),
    explore_floor: floorFrac,
    basis: wSum > 0 ? 'measured-proportional' : 'explore-uniform',
  };
}

// ---------------------------------------------------------------------------
// LEADERBOARD report block (curate/compile report)
// ---------------------------------------------------------------------------

export const VALUATION_BLOCK_KIND = 'valuation_leaderboard';
export const VALUATION_BLOCK_VERSION = 'dval-v1';

/**
 * buildValuationLeaderboardBlock - rank the signals by realized dk_per_ktoken so
 * EVERY compile records which signal actually paid off. Pure function (the
 * distill-report-blocks.js envelope family). Embeds the optional next-batch
 * allocation so the report shows BOTH the realized payoff and the plan it drove.
 *
 * @param {object} args
 * @param {Array<object>} args.measurements  measureSignalDelta results
 * @param {object} [args.allocation]         allocateDataBudget result (optional)
 * @returns {object} report block
 */
export function buildValuationLeaderboardBlock({ measurements = [], allocation = null } = {}) {
  const rows = (Array.isArray(measurements) ? measurements : [])
    .filter((m) => m && typeof m === 'object' && m.signal != null)
    .map((m) => ({
      signal: String(m.signal),
      basis: m.basis || (Number.isFinite(Number(m.dk_per_ktoken)) ? 'measured' : 'unmeasured'),
      delta_K: Number.isFinite(Number(m.delta_K)) ? Number(m.delta_K) : null,
      dk_per_ktoken: Number.isFinite(Number(m.dk_per_ktoken)) ? Number(m.dk_per_ktoken) : null,
      teacher_tokens: Number.isFinite(Number(m.teacher_tokens)) ? Number(m.teacher_tokens) : null,
      ci: m.ci && typeof m.ci === 'object'
        ? { lo: m.ci.lo, hi: m.ci.hi, significant: !!m.ci.significant }
        : null,
      signed: !!(m.signature_ed25519 && m.signature_ed25519.signature),
    }));

  // rank: measured + significant first, by dk_per_ktoken desc; unmeasured last.
  const ranked = rows.slice().sort((a, b) => {
    const am = a.dk_per_ktoken == null ? -Infinity : a.dk_per_ktoken;
    const bm = b.dk_per_ktoken == null ? -Infinity : b.dk_per_ktoken;
    const asig = a.ci && a.ci.significant ? 1 : 0;
    const bsig = b.ci && b.ci.significant ? 1 : 0;
    return (bsig - asig) || (bm - am) || a.signal.localeCompare(b.signal);
  }).map((r, i) => ({ rank: i + 1, ...r }));

  const measured = ranked.filter((r) => r.dk_per_ktoken != null);
  const winner = measured.length
    ? (measured.find((r) => r.ci && r.ci.significant) || measured[0])
    : null;

  return {
    block_kind: VALUATION_BLOCK_KIND,
    block_version: VALUATION_BLOCK_VERSION,
    scorer_version: VALUATION_EVAL_VERSION,
    interpretation_hint: winner
      ? `Signal "${winner.signal}" paid off most: ${winner.dk_per_ktoken} dK per 1k teacher tokens` + (winner.ci && winner.ci.significant ? ' (significant)' : ' (CI spans 0 - treat as tentative)')
      : 'No signal produced a measured K-delta yet (all unmeasured / no-op).',
    leaderboard: ranked,
    winner: winner ? { signal: winner.signal, dk_per_ktoken: winner.dk_per_ktoken, significant: !!(winner.ci && winner.ci.significant) } : null,
    next_batch_allocation: allocation && allocation.allocation ? allocation.allocation : null,
    allocation_basis: allocation && allocation.basis ? allocation.basis : null,
  };
}

export const __internals = {
  _mulberry32,
  _seedFromString,
  _pairTokens,
  _corpusTokens,
  _corpusHash,
};

export default {
  VALUATION_EVAL_VERSION,
  VALUATION_SIGNALS,
  VALUATION_BLOCK_KIND,
  VALUATION_BLOCK_VERSION,
  buildMatchedCorpora,
  pairedBootstrapCI,
  measureSignalDelta,
  allocateDataBudget,
  buildValuationLeaderboardBlock,
  __internals,
};
