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
export function tokenizeForDistribution(text) {
  if (text == null) return [];
  const s = String(text).toLowerCase();
  // Word-split: [a-z0-9_]+ runs. Punctuation and whitespace are separators.
  const words = [];
  const re = /[a-z0-9_]+/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m[0]) words.push(m[0]);
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
  const topK = Math.max(1, Math.trunc(opts.top_k == null ? DEFAULTS.TOP_K : opts.top_k));
  const counts = new Map();
  const arr = Array.isArray(samples) ? samples : [];
  for (const s of arr) {
    for (const t of tokenizeForDistribution(s)) {
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
// W747-1 - KL divergence on two sketches.
//
// We project both sketches onto the UNION of their keys (excluding meta keys
// _total/_top_k), apply additive (Laplace) smoothing so zero-count terms
// never produce -Infinity or NaN, then compute the natural-log KL sum.
//
// Returned values are NATs (KL(P||Q) = sum p_i * ln(p_i / q_i)).
// Always >= 0, never NaN, never Infinity for valid inputs.
// ---------------------------------------------------------------------------

const META_KEYS = new Set(['_total', '_top_k']);

function _supportKeys(p, q) {
  const set = new Set();
  for (const k of Object.keys(p)) if (!META_KEYS.has(k)) set.add(k);
  for (const k of Object.keys(q)) if (!META_KEYS.has(k)) set.add(k);
  return [...set];
}

function _probAt(sketch, key, smoothing) {
  const count = Number(sketch[key] || 0);
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
  const keys = _supportKeys(p, q);
  if (keys.length === 0) return 0;
  // Smoothed denominators: total + smoothing * |support|.
  const pTotal = Number(p._total || 0) + smoothing * keys.length;
  const qTotal = Number(q._total || 0) + smoothing * keys.length;
  if (!(pTotal > 0) || !(qTotal > 0)) return 0;
  let kl = 0;
  for (const k of keys) {
    const piCount = _probAt(p, k, smoothing);
    const qiCount = _probAt(q, k, smoothing);
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
// (the threshold of 0.15 is in nats and well below ln(2)≈0.693).
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
  const topN = Math.max(1, Math.trunc(opts.top_n == null ? DEFAULTS.TOP_DIVERGING : opts.top_n));
  const p = trainingSketch && typeof trainingSketch === 'object' ? trainingSketch : Object.create(null);
  const q = productionSketch && typeof productionSketch === 'object' ? productionSketch : Object.create(null);

  // Build the merged sketch M = 0.5 * (P + Q) for JSD.
  const keys = _supportKeys(p, q);
  const pTotalForP = Number(p._total || 0) + smoothing * keys.length;
  const qTotalForQ = Number(q._total || 0) + smoothing * keys.length;
  const m = Object.create(null);
  let mTotal = 0;
  for (const k of keys) {
    const pi = ((Number(p[k] || 0)) + smoothing) / (pTotalForP || 1);
    const qi = ((Number(q[k] || 0)) + smoothing) / (qTotalForQ || 1);
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
    const pTrain = ((Number(p[k] || 0)) + smoothing) / (pTotalForP || 1);
    const pProd = ((Number(q[k] || 0)) + smoothing) / (qTotalForQ || 1);
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
    const pi = ((Number(countSketch[k] || 0)) + smoothing) / (totalDenom || 1);
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
  const topN = Math.max(1, Math.trunc(opts.top_n == null ? DEFAULTS.SUGGESTION_TOP_N : opts.top_n));
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
    out.push(
      `Your student sees ${pct}% more "${it.token}" queries than trained. ` +
      `Capture ${rounded} more "${it.token}" examples.`
    );
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
  return Number(compareResult.jsd) >= thr;
}

// ---------------------------------------------------------------------------
// Convenience: opaque alert id for downstream sinks that key by id.
// ---------------------------------------------------------------------------

export function newAlertId() {
  return 'driftalert_' + crypto.randomBytes(8).toString('hex');
}

export default {
  DRIFT_ALERT_VERSION,
  DEFAULTS,
  tokenizeForDistribution,
  buildDistributionSketch,
  klDivergence,
  compareSketches,
  generateShiftSuggestion,
  shouldAlert,
  newAlertId,
};
