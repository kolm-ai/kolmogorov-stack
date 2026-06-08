// W808-1 - Capture poisoning detection: statistical anomaly detector.
//
// Per-tenant per-namespace running mean / stddev on four axes of capture
// telemetry. Flags a capture row as anomalous if ANY axis exceeds 3σ.
//
// The four axes (per master plan W808-1):
//   1. output_length - number of characters in the response
//   2. vocab_entropy - Shannon entropy of the response token
//                                 frequency distribution (proxy for "is this
//                                 a low-entropy spam / poisoning payload?")
//   3. response_time - latency_ms of the upstream call
//   4. token_overlap_to_teacher - Jaccard overlap of response tokens against
//                                 the running mode of the teacher response
//                                 set for the same namespace (proxy for
//                                 "is this a unique payload that doesn't
//                                 cluster with the baseline?")
//
// Baseline is computed from the LAST N (default 200) non-anomalous captures
// for the same (tenant_id, namespace) tuple. If fewer than MIN_BASELINE (8)
// captures are available we emit an honest envelope - 
// { ok:false, error:'no_baseline_captures', ... } - and refuse to flag
// anything (cold-start protection so the first eight captures of a new
// namespace aren't reflexively quarantined).
//
// Tenant fence (W411 pattern): readBaseline uses findByTenant + an
// inner-loop defense-in-depth tenant_id check so a stale row that slipped
// into the wrong table never poisons the cross-tenant baseline.
//
// Anti-brittleness (W604):
//   - CAPTURE_ANOMALY_VERSION is `w808-vN.M` and consumers must match with a
//     regex (/^w808-/) NOT literal equality.
//   - The 3σ threshold is exported as SIGMA_THRESHOLD so callers can tune
//     without forking the module.

import * as store from './store.js';

export const CAPTURE_ANOMALY_VERSION = 'w808-v1';
export const SIGMA_THRESHOLD = 3.0;
export const MIN_BASELINE = 8;
export const DEFAULT_BASELINE_WINDOW = 200;

// W808-1 - the four axes. Exported so the manual-review UI + tests can
// reference the canonical axis names without re-string-ing them.
export const ANOMALY_AXES = Object.freeze([
  'output_length',
  'vocab_entropy',
  'response_time',
  'token_overlap_to_teacher_typical',
]);

// =============================================================================
// Pure-math helpers - no I/O, no tenant scope, deterministic.
// =============================================================================

// Shannon entropy of the byte-pair frequency in `text`. We deliberately do not
// require a tokenizer here - the goal is to spot abrupt drops in lexical
// variance (e.g. response collapses to "aaaaaa...") which a character-level
// entropy already catches. Returns bits per character; 0 for empty input.
export function vocabEntropy(text) {
  if (text == null) return 0;
  const s = String(text);
  if (s.length === 0) return 0;
  const counts = new Map();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  const total = s.length;
  let entropy = 0;
  for (const c of counts.values()) {
    const p = c / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

// Jaccard overlap of word-token sets between `a` and `b`. Returns a number in
// [0,1]. We tokenize on whitespace + punctuation to keep the dependency
// surface zero. Empty strings → 0 (no overlap). Identical strings → 1.
export function tokenJaccard(a, b) {
  if (a == null || b == null) return 0;
  const A = _tokenize(String(a));
  const B = _tokenize(String(b));
  if (A.size === 0 && B.size === 0) return 0;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}

function _tokenize(s) {
  const out = new Set();
  for (const t of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length > 0) out.add(t);
  }
  return out;
}

// Running mean + stddev (Welford-style closed form) for a numeric array.
// Returns { mean, stddev, n }. stddev is the SAMPLE stddev (n-1 in the
// denominator) so a single sample yields stddev=0 (not NaN). Empty array →
// { mean:0, stddev:0, n:0 }.
export function runningStats(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { mean: 0, stddev: 0, n: 0 };
  }
  const finite = values.filter(v => Number.isFinite(v));
  const n = finite.length;
  if (n === 0) return { mean: 0, stddev: 0, n: 0 };
  let mean = 0;
  for (const v of finite) mean += v;
  mean /= n;
  if (n === 1) return { mean, stddev: 0, n };
  let sumSq = 0;
  for (const v of finite) sumSq += (v - mean) * (v - mean);
  const stddev = Math.sqrt(sumSq / (n - 1));
  return { mean, stddev, n };
}

// =============================================================================
// Feature extraction from a capture row.
// =============================================================================

// Extract the four W808-1 axes from a single capture row. The row schema is
// the canonical capture-store observation shape (see src/capture-store.js
// observationToCanonicalEvent). Missing fields default to 0 so a sparse row
// from a legacy ingester still produces a feature vector.
//
// teacher_typical_response is an optional string - the mode of recent
// teacher responses for the same namespace; if omitted, token_overlap is
// computed against an empty string (yielding 0). The detect() driver
// computes teacher_typical itself from the baseline window.
export function extractFeatures(row, opts = {}) {
  if (!row || typeof row !== 'object') {
    return {
      output_length: 0,
      vocab_entropy: 0,
      response_time: 0,
      token_overlap_to_teacher_typical: 0,
    };
  }
  const responseText = row.response != null
    ? (typeof row.response === 'string' ? row.response : JSON.stringify(row.response))
    : '';
  const output_length = responseText.length;
  const vocab_entropy = vocabEntropy(responseText);
  // latency_ms is canonical; fall back to latency_us / 1000 then to 0.
  let response_time = 0;
  if (Number.isFinite(Number(row.latency_ms))) response_time = Number(row.latency_ms);
  else if (Number.isFinite(Number(row.latency_us))) response_time = Math.round(Number(row.latency_us) / 1000);
  const teacher_typical = opts.teacher_typical_response != null
    ? String(opts.teacher_typical_response)
    : '';
  const token_overlap_to_teacher_typical = tokenJaccard(responseText, teacher_typical);
  return {
    output_length,
    vocab_entropy,
    response_time,
    token_overlap_to_teacher_typical,
  };
}

// =============================================================================
// Baseline reader - tenant-fenced lookup of recent NON-anomalous captures.
// =============================================================================

// W411 pattern: findByTenant + inner-loop defense-in-depth tenant_id check.
// We read from the `observations` table (the canonical post-promotion
// capture store; the anomaly detector intentionally trains on rows that
// HAVE cleared quarantine - they are the trusted baseline). Returns an
// array of capture rows in newest-first order, capped at `windowSize`.
export function readBaseline({ tenant_id, namespace, windowSize = DEFAULT_BASELINE_WINDOW } = {}) {
  if (!tenant_id) return [];
  // findByTenant queries on the `tenant` column (see store.js:415). The
  // capture rows use either `tenant` or `tenant_id` depending on the
  // ingester. We try both columns and merge - defense in depth.
  let rowsT = [];
  let rowsTId = [];
  try { rowsT = store.findByField('observations', 'tenant', tenant_id); } catch (_) { rowsT = []; }
  try { rowsTId = store.findByField('observations', 'tenant_id', tenant_id); } catch (_) { rowsTId = []; }
  const seen = new Set();
  const merged = [];
  for (const r of [...rowsT, ...rowsTId]) {
    if (!r) continue;
    // Inner-loop tenant fence - never trust the index alone (W411).
    const rt = r.tenant_id || r.tenant;
    if (String(rt) !== String(tenant_id)) continue;
    if (namespace) {
      const rn = r.corpus_namespace || r.namespace || 'default';
      if (String(rn) !== String(namespace)) continue;
    }
    const key = r.event_id || r.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    // Skip rows that were themselves flagged as anomalous - we are training
    // the baseline, not contaminating it.
    if (r.anomaly_flagged === true) continue;
    if (r.quarantine === true) continue;
    merged.push(r);
  }
  // Newest first by created_at (string ISO sorts correctly).
  merged.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return merged.slice(0, Math.max(1, windowSize));
}

// Compute the per-axis baseline stats from a set of capture rows. Returns
// { axis_name: {mean, stddev, n}, teacher_typical_response: <string> }.
// teacher_typical_response is the LONGEST response in the baseline (a
// cheap proxy for "the typical teacher answer" - good enough to seed a
// Jaccard comparison; not a true mode-of-tokens computation).
export function computeBaseline(rows) {
  const out = {};
  for (const axis of ANOMALY_AXES) out[axis] = { mean: 0, stddev: 0, n: 0 };
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ...out, teacher_typical_response: '', baseline_size: 0 };
  }
  // teacher_typical = the row with the longest response (proxy for the
  // canonical teacher reply against which token-overlap is computed).
  let teacherTypical = '';
  for (const r of rows) {
    const t = r.response != null
      ? (typeof r.response === 'string' ? r.response : JSON.stringify(r.response))
      : '';
    if (t.length > teacherTypical.length) teacherTypical = t;
  }
  const features = rows.map(r => extractFeatures(r, { teacher_typical_response: teacherTypical }));
  for (const axis of ANOMALY_AXES) {
    out[axis] = runningStats(features.map(f => f[axis]));
  }
  return { ...out, teacher_typical_response: teacherTypical, baseline_size: rows.length };
}

// =============================================================================
// Per-row anomaly verdict - pure function given a row + a baseline.
// =============================================================================

// Returns { anomaly_flagged, flagged_axes:[{axis, value, mean, stddev,
// sigma}], reasons:[], version }.
//
// An axis is flagged when |value - mean| / stddev > SIGMA_THRESHOLD AND
// stddev > 0 (a zero-variance baseline cannot flag - we treat that as
// "no signal, do not block"). The version stamp lets the manual-review UI
// distinguish v1 verdicts from future v2 verdicts in the same row.
export function scoreCapture(row, baseline) {
  const feat = extractFeatures(row, {
    teacher_typical_response: baseline && baseline.teacher_typical_response,
  });
  const flagged = [];
  for (const axis of ANOMALY_AXES) {
    const stats = baseline && baseline[axis] ? baseline[axis] : null;
    if (!stats || !Number.isFinite(stats.stddev) || stats.stddev <= 0) continue;
    const value = feat[axis];
    if (!Number.isFinite(value)) continue;
    const sigma = Math.abs(value - stats.mean) / stats.stddev;
    if (sigma > SIGMA_THRESHOLD) {
      flagged.push({
        axis,
        value,
        mean: stats.mean,
        stddev: stats.stddev,
        sigma,
      });
    }
  }
  return {
    anomaly_flagged: flagged.length > 0,
    flagged_axes: flagged,
    reasons: flagged.map(f => `${f.axis}=${f.value.toFixed(3)} is ${f.sigma.toFixed(2)}σ from baseline mean ${f.mean.toFixed(3)}`),
    features: feat,
    version: CAPTURE_ANOMALY_VERSION,
  };
}

// =============================================================================
// Driver - full detect() flow: load baseline, score row, return envelope.
// =============================================================================

// Returns either:
//   { ok:false, error:'no_baseline_captures', baseline_size:n, hint, version }
//   when n < MIN_BASELINE
// or
//   { ok:true, anomaly_flagged:bool, flagged_axes:[...], reasons:[...],
//     baseline_size:n, version }
export function detectAnomaly({ row, tenant_id, namespace, windowSize = DEFAULT_BASELINE_WINDOW } = {}) {
  if (!row || typeof row !== 'object') {
    return {
      ok: false,
      error: 'missing_capture_row',
      hint: 'pass a capture row object as { row }',
      version: CAPTURE_ANOMALY_VERSION,
    };
  }
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'detectAnomaly requires tenant_id for the W411 tenant fence',
      version: CAPTURE_ANOMALY_VERSION,
    };
  }
  const baselineRows = readBaseline({ tenant_id, namespace, windowSize });
  if (baselineRows.length < MIN_BASELINE) {
    return {
      ok: false,
      error: 'no_baseline_captures',
      baseline_size: baselineRows.length,
      min_baseline: MIN_BASELINE,
      hint: `need ${MIN_BASELINE} promoted captures in (tenant=${tenant_id}, namespace=${namespace || 'default'}) before anomaly detection is meaningful; have ${baselineRows.length}`,
      version: CAPTURE_ANOMALY_VERSION,
    };
  }
  const baseline = computeBaseline(baselineRows);
  const verdict = scoreCapture(row, baseline);
  return {
    ok: true,
    anomaly_flagged: verdict.anomaly_flagged,
    flagged_axes: verdict.flagged_axes,
    reasons: verdict.reasons,
    features: verdict.features,
    baseline_size: baseline.baseline_size,
    baseline_means: Object.fromEntries(ANOMALY_AXES.map(a => [a, baseline[a].mean])),
    baseline_stddevs: Object.fromEntries(ANOMALY_AXES.map(a => [a, baseline[a].stddev])),
    version: CAPTURE_ANOMALY_VERSION,
  };
}

export default {
  CAPTURE_ANOMALY_VERSION,
  SIGMA_THRESHOLD,
  MIN_BASELINE,
  ANOMALY_AXES,
  vocabEntropy,
  tokenJaccard,
  runningStats,
  extractFeatures,
  readBaseline,
  computeBaseline,
  scoreCapture,
  detectAnomaly,
};
