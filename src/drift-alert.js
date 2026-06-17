// W747 - Distribution-shift live alerter (production vs training).
//
// What this module ships (per KOLM_W707_SYSTEM_UPGRADE_PLAN.md W747-1..3):
//
//   W747-1: Compare incoming query distribution to capture distribution via
//           KL / Jensen-Shannon divergence over a fixed top-K n-gram sketch.
//           Live alert when JSD crosses a threshold.
//   W747-2: Webhook delivery + W709 routing-decision tie-in. The next routing
//           decision after an alert fires carries `drift_warning:true` so the
//           caller can adapt (e.g. fall back to teacher on novel queries).
//   W747-3: Plain-English shift suggestions: "Your student sees 23% more
//           billing queries than trained. Capture 150 more billing examples."
//
// Why a NEW module instead of extending src/drift-detector.js (W813):
//
//   - drift-detector.js compares baseline-vs-current EVENT WINDOWS within a
//     single capture stream and emits one alert envelope. Its baseline floats
//     with the stream - there's no separate "training distribution".
//   - W747 compares two NAMED distributions held side by side: a TRAINING
//     sketch snapshotted at distill time, and a LIVE PRODUCTION sketch
//     snapshotted on demand. The buyer story is "did the workload my student
//     was trained on still look like the workload it's serving today?" - 
//     which requires a long-lived training sketch the W813 detector does not
//     maintain.
//   - The two modules use the same divergence math (KL + JSD) but operate
//     on different inputs and emit different surfaces (live webhook +
//     routing tie-in vs durable alert rows). They are complementary, not
//     overlapping.
//
// Honest-by-default contract:
//   - klDivergence(p, q) uses ADDITIVE smoothing so zero-count terms can
//     never produce -Infinity or NaN. JSD is always in [0, 1].
//   - shouldAlert() returns boolean only - callers decide what to do.
//   - generateShiftSuggestion() interpolates real ratios from the
//     production sketch - no fabricated numbers.
//   - Tenant-fencing happens in src/drift-alert-store.js, not here. This
//     module is pure-JS math on plain Maps/objects.

import crypto from 'node:crypto';

export const DRIFT_ALERT_VERSION = 'w747-v1';

// Tunables exposed at module scope so call sites can override per request.
export const DEFAULTS = Object.freeze({
  TOP_K: 200,
  SMOOTHING: 1e-6,
  JSD_THRESHOLD: 0.15,
  SUGGESTION_TOP_N: 3,
  // How many tokens the "diverging tokens" list returns to the dashboard.
  TOP_DIVERGING: 20,
  // Frontier hardening: all public math functions are safe against hostile
  // sketches and unexpectedly huge text samples.
  MAX_TOP_K: 2000,
  MAX_SAMPLES: 10000,
  MAX_SAMPLE_CHARS: 8192,
  MAX_WORDS_PER_SAMPLE: 512,
  MAX_TOKEN_CHARS: 64,
  MAX_SUPPORT_KEYS: 4096,
  MAX_SUGGESTIONS: 10,
  MAX_SUGGESTION_CHARS: 240,
});

// ---------------------------------------------------------------------------
// W747-1 - Tokenize input into a deterministic n-gram bag (mono + tri).
//
// We mix mono-grams (single tokens) and tri-grams to keep both lexical signal
// ("billing") and phrase signal ("how do i") in the same sketch. The plan
// calls for "lowercase + word-split + take top-3 n-grams" - we read that as
// "include monograms through tri-grams, then top-K the sketch" so a billing
// query like "how do i upgrade my plan" contributes both "billing"-adjacent
// monograms and the diagnostic tri-gram "how do i".
// ---------------------------------------------------------------------------

/**
 * Tokenize a string into a sequence of lowercase mono-, bi-, and tri-grams.
 * Deterministic - same input always yields the same array.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeForDistribution(text, opts = {}) {
  if (text == null) return [];
  const maxChars = _boundedInt(opts.max_chars, DEFAULTS.MAX_SAMPLE_CHARS, 1, DEFAULTS.MAX_SAMPLE_CHARS);
  const maxWords = _boundedInt(opts.max_words, DEFAULTS.MAX_WORDS_PER_SAMPLE, 1, DEFAULTS.MAX_WORDS_PER_SAMPLE);
  const maxTokenChars = _boundedInt(opts.max_token_chars, DEFAULTS.MAX_TOKEN_CHARS, 1, DEFAULTS.MAX_TOKEN_CHARS);
  const s = String(text).toLowerCase().slice(0, maxChars);
  // Word-split: [a-z0-9_]+ runs. Punctuation and whitespace are separators.
  const words = [];
  const re = /[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0]) words.push(m[0].slice(0, maxTokenChars));
    if (words.length >= maxWords) break;
  }
  const out = [];
  // monograms
  for (const w of words) out.push(w);
  // bigrams
  for (let i = 0; i + 2 <= words.length; i++) {
    out.push(words[i] + ' ' + words[i + 1]);
  }
  // trigrams ("top-3 n-grams" per the spec)
  for (let i = 0; i + 3 <= words.length; i++) {
    out.push(words[i] + ' ' + words[i + 1] + ' ' + words[i + 2]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// W747-1 - Build a top-K count-min-style sketch from a corpus of samples.
//
// We tokenize each sample, sum counts across the corpus, then keep the top-K
// tokens by count and dump everything else into an "_other" bucket. The
// sketch shape is a plain object so it round-trips through JSON cleanly
// (and the store driver does not need a custom encoder).
//
// Sketch shape:
//   { [token]: count, ..., _other: count, _total: N, _top_k: K }
//
// _total is the sum of ALL counts (including _other) - i.e. the total token
// observations, not the number of samples. Callers that need per-sample
// counts pass samples.length separately.
// ---------------------------------------------------------------------------

/**
 * Build a count-min-style top-K sketch from an array of text samples.
 *
 * @param {string[]} samples
 * @param {object} [opts]
 * @param {number} [opts.top_k=DEFAULTS.TOP_K]
 * @returns {{[token:string]: number, _total: number, _top_k: number}}
 */
export function buildDistributionSketch(samples, opts = {}) {
  const topK = _boundedInt(opts.top_k, DEFAULTS.TOP_K, 1, DEFAULTS.MAX_TOP_K);
  const maxSamples = _boundedInt(opts.max_samples, DEFAULTS.MAX_SAMPLES, 1, DEFAULTS.MAX_SAMPLES);
  const counts = new Map();
  const arr = Array.isArray(samples) ? samples.slice(0, maxSamples) : [];
  for (const s of arr) {
    for (const t of tokenizeForDistribution(s, opts)) {
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  // Sort by count desc, then by token asc for determinism on ties.
  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });
  const out = Object.create(null);
  let total = 0;
  let otherCount = 0;
  for (let i = 0; i < entries.length; i++) {
    const [tok, c] = entries[i];
    total += c;
    if (i < topK) {
      out[tok] = c;
    } else {
      otherCount += c;
    }
  }
  out._other = otherCount;
  out._total = total;
  out._top_k = topK;
  return out;
}

// ---------------------------------------------------------------------------
// Sketch normalization.
//
// Route payloads and stored snapshots can be user-controlled. Before any KL/JSD
// math, normalize the object into a null-prototype, bounded-support sketch with
// finite non-negative counts. This prevents prototype-pollution keys, negative
// probabilities, Infinity, and memory blowups from poisoning the alert result.
// ---------------------------------------------------------------------------

const META_KEYS = new Set(['_total', '_top_k']);
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function normalizeSketch(sketch, opts = {}) {
  const maxSupport = _boundedInt(opts.max_support_keys, DEFAULTS.MAX_SUPPORT_KEYS, 1, DEFAULTS.MAX_SUPPORT_KEYS);
  const out = Object.create(null);
  if (!sketch || typeof sketch !== 'object') {
    out._other = 0;
    out._total = 0;
    out._top_k = maxSupport;
    return out;
  }

  const counts = new Map();
  for (const rawKey of Object.keys(sketch)) {
    if (META_KEYS.has(rawKey)) continue;
    const key = _normalizeTokenKey(rawKey);
    if (!key) continue;
    const count = _safeCount(sketch[rawKey]);
    if (!(count > 0)) continue;
    counts.set(key, (counts.get(key) || 0) + count);
  }

  const entries = [...counts.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : 0);
  });

  let total = 0;
  let overflow = 0;
  for (let i = 0; i < entries.length; i++) {
    const [token, count] = entries[i];
    total += count;
    if (i < maxSupport) {
      out[token] = count;
    } else {
      overflow += count;
    }
  }
  if (overflow > 0) out._other = (out._other || 0) + overflow;
  if (out._other == null) out._other = 0;
  out._total = total;
  out._top_k = Math.min(
    maxSupport,
    _boundedInt(sketch._top_k, maxSupport, 1, maxSupport),
  );
  return out;
}

// ---------------------------------------------------------------------------
// W747-1 - KL divergence on two sketches.
//
// We project both sketches onto the UNION of their keys (excluding meta keys
// _total/_top_k), apply additive (Laplace) smoothing so zero-count terms
// never produce -Infinity or NaN, then compute the natural-log KL sum.
//
// Returned values are NATs (KL(P||Q) = sum p_i * ln(p_i / q_i)).
// Always >= 0, never NaN, never Infinity for valid inputs.
// ---------------------------------------------------------------------------

function _supportKeys(p, q, opts = {}) {
  const maxSupport = _boundedInt(opts.max_support_keys, DEFAULTS.MAX_SUPPORT_KEYS, 1, DEFAULTS.MAX_SUPPORT_KEYS);
  const set = new Set();
  for (const k of Object.keys(p)) if (!META_KEYS.has(k)) set.add(k);
  for (const k of Object.keys(q)) if (!META_KEYS.has(k)) set.add(k);
  return [...set].sort().slice(0, maxSupport);
}

function _probAt(sketch, key, smoothing) {
  const count = _safeCount(sketch[key]);
  // Use _total + smoothing*supportSize as the denominator at the call site
  // (we compute it once per pair to keep this hot path branch-free).
  return count + smoothing;
}

/**
 * KL(P || Q) with additive smoothing. Both inputs are sketches; we project
 * onto the union of their non-meta keys, smooth zero-count terms with
 * `smoothing`, and compute the natural-log KL. Returns a non-negative float.
 *
 * @param {object} p
 * @param {object} q
 * @param {{smoothing?: number}} [opts]
 * @returns {number}
 */
export function klDivergence(p, q, opts = {}) {
  if (!p || typeof p !== 'object' || !q || typeof q !== 'object') {
    return 0;
  }
  const smoothing = Math.max(1e-12, Number(opts.smoothing == null ? DEFAULTS.SMOOTHING : opts.smoothing));
  const pp = normalizeSketch(p, opts);
  const qq = normalizeSketch(q, opts);
  const keys = _supportKeys(pp, qq, opts);
  if (keys.length === 0) return 0;
  // Smoothed denominators: total + smoothing * |support|.
  const pTotal = Number(pp._total || 0) + smoothing * keys.length;
  const qTotal = Number(qq._total || 0) + smoothing * keys.length;
  if (!(pTotal > 0) || !(qTotal > 0)) return 0;
  let kl = 0;
  for (const k of keys) {
    const piCount = _probAt(pp, k, smoothing);
    const qiCount = _probAt(qq, k, smoothing);
    const pi = piCount / pTotal;
    const qi = qiCount / qTotal;
    if (!(pi > 0)) continue;
    // qi can never be 0 because of smoothing, but guard anyway.
    if (!(qi > 0)) continue;
    const term = pi * Math.log(pi / qi);
    if (Number.isFinite(term)) kl += term;
  }
  // Numerical noise can produce slightly negative results; clamp.
  return Math.max(0, kl);
}

// ---------------------------------------------------------------------------
// W747-1 - Symmetric KL (Jensen-Shannon) + top diverging tokens.
//
// JSD(P, Q) = 0.5 * KL(P || M) + 0.5 * KL(Q || M) where M = 0.5*(P + Q).
// Bounded in [0, ln(2)] in nats; we clip to [0, 1] for dashboard scaling
// (the threshold of 0.15 is in nats and well below ln(2) ~= 0.693).
// ---------------------------------------------------------------------------

/**
 * Compare two sketches and return divergence + top diverging tokens.
 * The returned tokens are sorted by absolute probability difference desc
 * (so the dashboard surfaces the most actionable shifts first).
 *
 * @param {object} trainingSketch
 * @param {object} productionSketch
 * @param {{smoothing?: number, top_n?: number}} [opts]
 * @returns {{kl: number, jsd: number, top_diverging_tokens: Array<{token:string, p_train:number, p_prod:number, ratio:number}>}}
 */
export function compareSketches(trainingSketch, productionSketch, opts = {}) {
  const smoothing = Math.max(1e-12, Number(opts.smoothing == null ? DEFAULTS.SMOOTHING : opts.smoothing));
  const topN = _boundedInt(opts.top_n, DEFAULTS.TOP_DIVERGING, 1, DEFAULTS.MAX_SUPPORT_KEYS);
  const p = normalizeSketch(trainingSketch, opts);
  const q = normalizeSketch(productionSketch, opts);

  // Build the merged sketch M = 0.5 * (P + Q) for JSD.
  const keys = _supportKeys(p, q, opts);
  const pTotalForP = Number(p._total || 0) + smoothing * keys.length;
  const qTotalForQ = Number(q._total || 0) + smoothing * keys.length;
  const m = Object.create(null);
  let mTotal = 0;
  for (const k of keys) {
    const pi = (_safeCount(p[k]) + smoothing) / (pTotalForP || 1);
    const qi = (_safeCount(q[k]) + smoothing) / (qTotalForQ || 1);
    const mi = 0.5 * (pi + qi);
    // Stash the *probability* directly so we don't have to rebuild totals.
    m[k] = mi;
    mTotal += mi;
  }
  m._total = mTotal;
  // klDivergence expects a count-style sketch, so we synthesize counts that
  // re-normalize back to the same probabilities: counts = pi * SCALE,
  // _total = SCALE. SCALE = 1 keeps math identical and avoids overflow.
  // (We compute KL(P||M) and KL(Q||M) directly here for clarity.)
  const klPM = _klFromProbs(p, m, keys, smoothing, pTotalForP);
  const klQM = _klFromProbs(q, m, keys, smoothing, qTotalForQ);
  const jsdNats = 0.5 * klPM + 0.5 * klQM;
  // JSD in nats is bounded in [0, ln(2)]. We expose it directly and clamp to
  // [0, 1] for the alert threshold (which is also nats-scale).
  const jsd = Math.min(1, Math.max(0, jsdNats));
  const kl = klPM; // KL(train || prod) is the asymmetric "did training cover prod" view.

  // Top diverging tokens by absolute probability delta.
  const diff = [];
  for (const k of keys) {
    const pTrain = (_safeCount(p[k]) + smoothing) / (pTotalForP || 1);
    const pProd = (_safeCount(q[k]) + smoothing) / (qTotalForQ || 1);
    const delta = Math.abs(pTrain - pProd);
    if (delta <= 0) continue;
    diff.push({
      token: k,
      p_train: pTrain,
      p_prod: pProd,
      // ratio = pProd / pTrain. Infinity-safe by virtue of smoothing.
      ratio: pTrain > 0 ? pProd / pTrain : 0,
      _delta: delta,
    });
  }
  diff.sort((a, b) => b._delta - a._delta);
  const top = diff.slice(0, topN).map((d) => {
    // Strip the internal _delta sort key from the public envelope.
    return { token: d.token, p_train: d.p_train, p_prod: d.p_prod, ratio: d.ratio };
  });

  return {
    kl,
    jsd,
    top_diverging_tokens: top,
  };
}

function _klFromProbs(countSketch, probSketch, keys, smoothing, totalDenom) {
  let kl = 0;
  for (const k of keys) {
    const pi = (_safeCount(countSketch[k]) + smoothing) / (totalDenom || 1);
    const qi = Number(probSketch[k] || 0);
    if (!(pi > 0)) continue;
    if (!(qi > 0)) continue;
    const term = pi * Math.log(pi / qi);
    if (Number.isFinite(term)) kl += term;
  }
  return Math.max(0, kl);
}

// ---------------------------------------------------------------------------
// W747-3 - Plain-English shift suggestion list.
//
// Reads the top diverging tokens from compareSketches() and turns each one
// into an actionable string. We only emit suggestions for tokens where the
// production share is GREATER than the training share (a shift we can fix
// by capturing more examples). Shifts in the opposite direction (training
// has more of a token than production sees today) are still surfaced in the
// dashboard table but not in the suggestion list - there's no "capture
// fewer" action a user can take.
// ---------------------------------------------------------------------------

/**
 * Build human-readable suggestions from a compare result.
 *
 * @param {object} compareResult - from compareSketches()
 * @param {{top_n?: number}} [opts]
 * @returns {string[]} suggestions in priority order; empty when no shifts detected
 */
export function generateShiftSuggestion(compareResult, opts = {}) {
  const topN = _boundedInt(opts.top_n, DEFAULTS.SUGGESTION_TOP_N, 1, DEFAULTS.MAX_SUGGESTIONS);
  if (!compareResult || !Array.isArray(compareResult.top_diverging_tokens)) return [];
  const items = compareResult.top_diverging_tokens.filter((d) => Number(d.p_prod) > Number(d.p_train));
  if (items.length === 0) return [];
  // Sort by relative growth: how much MORE the token appears in production.
  items.sort((a, b) => {
    const ga = Number(a.p_prod) - Number(a.p_train);
    const gb = Number(b.p_prod) - Number(b.p_train);
    return gb - ga;
  });
  const out = [];
  for (const it of items.slice(0, topN)) {
    const token = _safeSuggestionToken(it.token);
    if (!token) continue;
    const pTrain = Number(it.p_train);
    const pProd = Number(it.p_prod);
    const delta = pProd - pTrain;
    // Percentage-point shift, e.g. "15%" means 15 percentage points higher.
    const pct = Math.round(delta * 100);
    if (pct <= 0) continue;
    // Capture suggestion target: scale by the percentage-point shift so a
    // 15% shift suggests ~150 more captures (10x rule of thumb that keeps
    // small drifts producing small homework).
    const capCount = Math.max(50, Math.round(delta * 1000));
    // Round to nearest 50 for readability.
    const rounded = Math.max(50, Math.round(capCount / 50) * 50);
    const msg = `Your student sees ${pct}% more "${token}" queries than trained. `
      + `Capture ${rounded} more "${token}" examples.`;
    out.push(msg.slice(0, DEFAULTS.MAX_SUGGESTION_CHARS));
  }
  return out;
}

// ---------------------------------------------------------------------------
// W747-2 - should-we-alert decision.
// ---------------------------------------------------------------------------

/**
 * @param {object} compareResult - from compareSketches()
 * @param {{jsd_threshold?: number}} [opts]
 * @returns {boolean}
 */
export function shouldAlert(compareResult, opts = {}) {
  if (!compareResult || !Number.isFinite(Number(compareResult.jsd))) return false;
  const thr = Number.isFinite(Number(opts.jsd_threshold))
    ? Number(opts.jsd_threshold)
    : DEFAULTS.JSD_THRESHOLD;
  const boundedThreshold = Math.max(0, Math.min(1, thr));
  return Number(compareResult.jsd) >= boundedThreshold;
}

// ---------------------------------------------------------------------------
// Alert delivery envelope helpers.
// ---------------------------------------------------------------------------

export function buildAlertEnvelope({
  namespace = 'default',
  tenant_id = null,
  compare = null,
  threshold = DEFAULTS.JSD_THRESHOLD,
  alert = null,
  suggestions = [],
  generated_at = null,
  alert_id = null,
} = {}) {
  const safeCompare = compare && typeof compare === 'object' ? compare : {};
  const top = Array.isArray(safeCompare.top_diverging_tokens)
    ? safeCompare.top_diverging_tokens.slice(0, DEFAULTS.TOP_DIVERGING).map((d) => ({
      token: _safeSuggestionToken(d && d.token),
      p_train: _safeProbability(d && d.p_train),
      p_prod: _safeProbability(d && d.p_prod),
      ratio: _safeRatio(d && d.ratio),
    })).filter((d) => d.token)
    : [];
  const at = _safeIso(generated_at) || new Date().toISOString();
  const core = {
    kind: 'distribution_shift',
    namespace: _normalizeNamespace(namespace),
    tenant_hash: tenant_id ? _sha256Hex(`tenant:${String(tenant_id)}`) : null,
    kl: _safeNonNegative(safeCompare.kl),
    jsd: _safeProbability(safeCompare.jsd),
    threshold: _safeProbability(threshold),
    alert: alert == null ? shouldAlert(safeCompare, { jsd_threshold: threshold }) : alert === true,
    top_diverging: top,
    suggestions: Array.isArray(suggestions)
      ? suggestions.slice(0, DEFAULTS.MAX_SUGGESTIONS).map((s) => _safeSuggestion(s)).filter(Boolean)
      : [],
    generated_at: at,
    version: DRIFT_ALERT_VERSION,
  };
  const baseHash = _sha256Hex(_stableJson(core));
  const id = alert_id ? _normalizeAlertId(alert_id) : `driftalert_${baseHash.slice(0, 16)}`;
  const withId = { ...core, alert_id: id };
  return {
    ...withId,
    payload_sha256: _sha256Hex(_stableJson(withId)),
  };
}

// Convenience: opaque alert id for downstream sinks that key by id.
export function newAlertId(seed = null) {
  if (seed != null) {
    return `driftalert_${_sha256Hex(_stableJson(seed)).slice(0, 16)}`;
  }
  return 'driftalert_' + crypto.randomBytes(8).toString('hex');
}

function _boundedInt(value, fallback, min, max) {
  const n = Number(value == null ? fallback : value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function _safeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, n);
}

function _safeNonNegative(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function _safeProbability(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function _safeRatio(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000, n);
}

function _normalizeNamespace(value) {
  const s = String(value == null ? 'default' : value)
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .trim()
    .slice(0, 128);
  return s || 'default';
}

function _normalizeTokenKey(value) {
  const s = String(value || '')
    .toLowerCase()
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEFAULTS.MAX_TOKEN_CHARS);
  if (!s || META_KEYS.has(s) || RESERVED_KEYS.has(s)) return null;
  return s;
}

function _safeSuggestionToken(value) {
  return _normalizeTokenKey(value);
}

function _safeSuggestion(value) {
  const s = String(value == null ? '' : value)
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DEFAULTS.MAX_SUGGESTION_CHARS);
  return s || null;
}

function _safeIso(value) {
  const s = value == null ? null : String(value);
  if (!s || Number.isNaN(Date.parse(s))) return null;
  return new Date(s).toISOString();
}

function _normalizeAlertId(value) {
  const s = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
  return s || newAlertId();
}

function _stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => _stableJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableJson(value[k])}`).join(',')}}`;
}

function _sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export default {
  DRIFT_ALERT_VERSION,
  DEFAULTS,
  tokenizeForDistribution,
  buildDistributionSketch,
  normalizeSketch,
  klDivergence,
  compareSketches,
  generateShiftSuggestion,
  shouldAlert,
  buildAlertEnvelope,
  newAlertId,
};
