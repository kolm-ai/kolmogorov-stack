// KOLM Data Engine - per-pair quality CLASSIFIER (W921).
//
// Replaces a single hand-tuned output-only heuristic with a LEARNED per-pair
// quality scorer whose threshold can be tuned (percentile, DCLM-style, or
// absolute), in the lineage of:
//   - AlpaGasus (arXiv:2307.08701): score each (instruction, response) on a
//     0-5 accuracy scale, keep >= tau; 9k scored rows beat 52k raw.
//   - FineWeb-Edu (arXiv:2406.17557): one LLM-judge pass labels samples, then
//     DISTILL into a tiny reusable classifier = frozen embedding + a single
//     linear head. Inference: embed -> regress -> keep.
//   - DCLM fastText (arXiv:2406.11794): a binary good/bad classifier, keep the
//     top fraction by P(high-quality). +6.6 MMLU at 40% less compute.
//
// kolm adaptation, pure-JS + dependency-free so the default path runs
// everywhere (no fasttext-wheel, no sentence-transformers, no GPU):
//   - FEATURES: a deterministic feature vector per pair (length buckets, CoT-leak
//     penalty, refusal penalty, structure bonus, input/output token overlap =
//     relevance, type-token-ratio, digit/uppercase ratios). These are the
//     "relevance + completeness + grammar" signals the plan's C2.1 asks for,
//     extending the output-only heuristic to use the INPUT too (a fluent off-
//     topic answer no longer scores well).
//   - MODEL: a logistic head sigmoid(w·x + b). fitQualityModel learns (w,b) from
//     a pos/neg split via deterministic batch gradient descent (L2-regularized).
//     Absent a fit, a SHIPPED default weight vector (cold-start) scores any
//     corpus; the heuristic floor is the universal fallback.
//   - THRESHOLD: 'percentile' (keep top keep_fraction by score, DCLM-style,
//     dataset-relative - the proven default) or 'absolute' (score >= minQuality).
//
// Envelope contract: scoreQuality / fitQualityModel return {ok, version:
// 'quality-v1', ...} and NEVER throw across the public API. Determinism:
// identical rows + model => identical scores; identical training data + seed =>
// identical weights. NO npm deps.

import { embed as _embedText, cosine as _cosineVec } from './embedding.js';

export const QUALITY_CLASSIFIER_VERSION = 'quality-v1';

// ── pair text extraction (mirrors data-curate) ───────────────────────────────

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

// ── feature extraction (deterministic) ────────────────────────────────────────

const _HARD_COT = [/<\/?think>/i, /<\/?reasoning>/i, /<\|?\s*thinking\s*\|?>/i, /<\|?\s*reasoning\s*\|?>/i];
const _SOFT_COT = [
  /^okay,?\s+so\b/i, /^alright,?\s+so\b/i, /^hmm,?\s/i, /^wait,?\s/i,
  /^so\s+(the\s+user|first|basically)/i, /^first,?\s+i\s+(should|need|will|have)/i,
  /^let\s+me\s+(think|consider|analyze|break)/i, /\bstep[- ]by[- ]step\b/i, /\blet's\s+see\b[.,]/i,
];
const _REFUSAL_RE = /\b(i'?m sorry|i cannot|i can'?t help|i am unable|i'?m unable|as an ai)\b/i;
const _STRUCTURE_RE = /(^|\n)\s*(\d+[.)]|[-*•])\s+/m;

function _wordsLower(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function _flagCot(s) {
  if (_HARD_COT.some((re) => re.test(s))) return true;
  return _SOFT_COT.filter((re) => re.test(s)).length >= 2;
}

// relevance: fraction of input content words covered by the output.
function _relevance(input, output) {
  const ref = new Set(_wordsLower(input).filter((w) => w.length > 2));
  if (ref.size === 0) return 0.5; // no input signal -> neutral
  const cand = new Set(_wordsLower(output).filter((w) => w.length > 2));
  let inter = 0;
  for (const w of cand) if (ref.has(w)) inter += 1;
  return inter / ref.size;
}

/**
 * extractFeatures(pair) - the deterministic feature vector the logistic head
 * scores. Each component is bounded so the head trains stably.
 * @returns {number[]} feature vector (FEATURE_NAMES order)
 */
export const FEATURE_NAMES = [
  'bias', 'len_norm', 'cot_leak', 'refusal', 'structure', 'relevance', 'ttr', 'digit_ratio', 'upper_ratio', 'empty',
];

export function extractFeatures(pair) {
  const input = _pairInput(pair);
  const output = _pairOutput(pair);
  const s = String(output || '');
  const n = s.trim().length;
  const words = _wordsLower(s);

  const len_norm = Math.max(0, Math.min(1, Math.log2(1 + n) / Math.log2(1 + 1200)));
  const cot_leak = _flagCot(s) ? 1 : 0;
  const refusal = _REFUSAL_RE.test(s) ? 1 : 0;
  const structure = _STRUCTURE_RE.test(s) ? 1 : 0;
  const relevance = _relevance(input, output);
  const ttr = words.length ? new Set(words).size / words.length : 0; // type-token ratio (grammar/diversity proxy)
  const digits = (s.match(/\d/g) || []).length;
  const uppers = (s.match(/[A-Z]/g) || []).length;
  const digit_ratio = n ? Math.min(1, digits / n) : 0;
  const upper_ratio = n ? Math.min(1, uppers / n) : 0;
  const empty = n === 0 ? 1 : 0;

  return [1, len_norm, cot_leak, refusal, structure, relevance, ttr, digit_ratio, upper_ratio, empty];
}

// ── cold-start default weights ────────────────────────────────────────────────
//
// A shipped weight vector (one per FEATURE_NAMES slot) so the classifier scores
// any corpus with zero user labels. Hand-set to encode the known-good direction
// (long+relevant+structured = good; CoT-leak/refusal/empty = bad); fitting
// refines these on the user's own data.
const DEFAULT_WEIGHTS = {
  version: QUALITY_CLASSIFIER_VERSION,
  feature_names: FEATURE_NAMES,
  // bias, len_norm, cot_leak, refusal, structure, relevance, ttr, digit_ratio, upper_ratio, empty
  w: [-0.4, 2.2, -4.0, -2.5, 0.6, 2.0, 0.8, -0.5, -0.5, -6.0],
  trained: false,
};

function _sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

function _scoreWithWeights(features, weights) {
  const w = weights.w;
  let z = 0;
  for (let i = 0; i < features.length && i < w.length; i++) z += features[i] * w[i];
  return _sigmoid(z);
}

// ── heuristic floor (universal fallback) ──────────────────────────────────────

/**
 * heuristicQualityScore(pair) - self-contained [0,1] floor. Mirrors the curate
 * scoreCandidateLocal ordering (clean > CoT-leaked > refusal > empty) but also
 * uses the INPUT for relevance.
 */
export function heuristicQualityScore(pair) {
  const f = extractFeatures(pair);
  // map features to a bounded heuristic score (no learned weights)
  let score = 0.5;
  score += 0.25 * f[1];          // len_norm
  score -= 0.5 * f[2];           // cot_leak
  score -= 0.2 * f[3];           // refusal
  score += 0.05 * f[4];          // structure
  score += 0.25 * (f[5] - 0.5);  // relevance centered
  if (f[9] === 1) score = 0.05;  // empty output floor
  return Math.max(0, Math.min(1, score));
}

// ── scoreQuality ──────────────────────────────────────────────────────────────

/**
 * scoreQuality({rows, backend, model, key}) - score each row in [0,1].
 * backend 'learned' uses the model weights (fitted or default); 'heuristic' uses
 * the floor; 'auto' uses learned when a model is given, else default-learned.
 * @returns {{ok, version, backend, scores:number[], error?}}
 */
export function scoreQuality({ rows, backend = 'auto', model = null } = {}) {
  try {
    const data = Array.isArray(rows) ? rows : [];
    if (backend === 'heuristic') {
      return { ok: true, version: QUALITY_CLASSIFIER_VERSION, backend: 'heuristic', scores: data.map((p) => Number(heuristicQualityScore(p).toFixed(6))) };
    }
    const weights = (model && Array.isArray(model.w) && model.w.length) ? model : DEFAULT_WEIGHTS;
    const usedBackend = weights.trained ? 'learned' : 'learned-default';
    const scores = data.map((p) => Number(_scoreWithWeights(extractFeatures(p), weights).toFixed(6)));
    return { ok: true, version: QUALITY_CLASSIFIER_VERSION, backend: usedBackend, scores };
  } catch (e) {
    const data = Array.isArray(rows) ? rows : [];
    return { ok: false, version: QUALITY_CLASSIFIER_VERSION, backend: 'error', scores: data.map(() => 0.5), error: String((e && e.message) || e) };
  }
}

// ── fitQualityModel (deterministic logistic regression) ───────────────────────

/**
 * fitQualityModel({posRows, negRows, epochs, lr, l2, seed}) - train the logistic
 * head on a labeled good/bad split via deterministic full-batch gradient descent.
 * @returns {{ok, version, backend:'learned', model, n_pos, n_neg, epochs, train_loss}}
 */
export function fitQualityModel({ posRows, negRows, epochs = 200, lr = 0.5, l2 = 1e-3 } = {}) {
  try {
    const pos = Array.isArray(posRows) ? posRows : [];
    const neg = Array.isArray(negRows) ? negRows : [];
    if (pos.length === 0 || neg.length === 0) {
      return { ok: false, version: QUALITY_CLASSIFIER_VERSION, error: 'need_both_pos_and_neg', model: DEFAULT_WEIGHTS };
    }
    const X = [];
    const y = [];
    for (const p of pos) { X.push(extractFeatures(p)); y.push(1); }
    for (const p of neg) { X.push(extractFeatures(p)); y.push(0); }
    const N = X.length;
    const D = X[0].length;
    const w = new Array(D).fill(0);
    const ep = Math.max(1, epochs | 0);
    const eta = Number.isFinite(lr) ? lr : 0.5;
    const lambda = Number.isFinite(l2) ? l2 : 1e-3;

    let loss = 0;
    for (let e = 0; e < ep; e++) {
      const grad = new Array(D).fill(0);
      loss = 0;
      for (let i = 0; i < N; i++) {
        let z = 0; for (let d = 0; d < D; d++) z += X[i][d] * w[d];
        const p = _sigmoid(z);
        const err = p - y[i];
        for (let d = 0; d < D; d++) grad[d] += err * X[i][d];
        // cross-entropy (numerically guarded)
        const pc = Math.max(1e-9, Math.min(1 - 1e-9, p));
        loss += -(y[i] * Math.log(pc) + (1 - y[i]) * Math.log(1 - pc));
      }
      for (let d = 0; d < D; d++) {
        // L2 on non-bias weights only
        const reg = d === 0 ? 0 : lambda * w[d];
        w[d] -= eta * (grad[d] / N + reg);
      }
    }
    const model = {
      version: QUALITY_CLASSIFIER_VERSION,
      feature_names: FEATURE_NAMES,
      w: w.map((x) => Number(x.toFixed(8))),
      trained: true,
    };
    return {
      ok: true,
      version: QUALITY_CLASSIFIER_VERSION,
      backend: 'learned',
      model,
      n_pos: pos.length,
      n_neg: neg.length,
      epochs: ep,
      train_loss: Number((loss / N).toFixed(6)),
    };
  } catch (e) {
    return { ok: false, version: QUALITY_CLASSIFIER_VERSION, error: String((e && e.message) || e), model: DEFAULT_WEIGHTS };
  }
}

// ── thresholding ──────────────────────────────────────────────────────────────

/**
 * applyThreshold(scores, {mode, keep_fraction, minQuality}) - return the kept
 * index set + the threshold actually used.
 *   'percentile' (default): keep top keep_fraction by score (DCLM-style).
 *   'absolute'            : keep score >= minQuality (back-compat).
 * @returns {{kept_indices:number[], dropped_indices:number[], threshold_used:number, mode:string}}
 */
export function applyThreshold(scores, { mode = 'percentile', keep_fraction = 0.9, minQuality = 0.35 } = {}) {
  const s = Array.isArray(scores) ? scores.map((x) => Number(x) || 0) : [];
  const n = s.length;
  if (n === 0) return { kept_indices: [], dropped_indices: [], threshold_used: 0, mode };

  if (mode === 'absolute') {
    const t = Number(minQuality);
    const kept = []; const dropped = [];
    for (let i = 0; i < n; i++) (s[i] >= t ? kept : dropped).push(i);
    return { kept_indices: kept, dropped_indices: dropped, threshold_used: t, mode: 'absolute' };
  }

  // percentile: keep the top ceil(keep_fraction * n) by score.
  const frac = Math.max(0, Math.min(1, Number(keep_fraction)));
  const keepN = Math.max(0, Math.min(n, Math.ceil(frac * n)));
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (s[b] - s[a]) || (a - b));
  const keptSet = new Set(order.slice(0, keepN));
  // threshold_used = the lowest kept score (the cut point)
  const t = keepN > 0 ? s[order[keepN - 1]] : (n ? s[order[0]] + 1 : 0);
  const kept = []; const dropped = [];
  for (let i = 0; i < n; i++) (keptSet.has(i) ? kept : dropped).push(i);
  return { kept_indices: kept, dropped_indices: dropped, threshold_used: Number(t.toFixed(6)), mode: 'percentile' };
}

// ── doctor ────────────────────────────────────────────────────────────────────

export function doctor() {
  return {
    ok: true,
    ready: true,
    backend: 'learned-default',
    model_path: null,
    install_hint: 'pure-JS quality classifier (no external deps); pass a fitted model to scoreQuality for a per-domain head',
  };
}

export const __internals = {
  _sigmoid,
  _relevance,
  _flagCot,
  _scoreWithWeights,
  DEFAULT_WEIGHTS,
};

export default {
  QUALITY_CLASSIFIER_VERSION,
  FEATURE_NAMES,
  extractFeatures,
  scoreQuality,
  fitQualityModel,
  heuristicQualityScore,
  applyThreshold,
  doctor,
  __internals,
};
