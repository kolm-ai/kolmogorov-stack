// W760 - Per-language K-Score breakdown.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 549-553):
//   [W760-1] Per-language K-Score reporting → language detect + axis split
//   [W760-3] Per-language confidence thresholds for fallback
//
// Why: a compiled student that scores 0.91 K-Score on a pooled English+
// Spanish mix can hide a 0.42 on Spanish. The pooled composite isn't
// honest about per-language quality. perLanguageKScore() partitions rows
// by detected lang and reports a K-Score per partition.
//
// Design contract:
//   - SIBLING of src/kscore.js - DO NOT mutate kscore.js. We import
//     computeKScore() read-only and fan it out across language buckets.
//   - Wilson 95% CI gated at n>=30 PER LANGUAGE. Below 30 the bucket
//     reports k_score=null AND ci=null (honesty floor, mirrors W741).
//   - INSUFFICIENT envelope when no language has >=30 rows - we don't
//     silently substitute a tiny-n estimate.
//   - perLanguageConfidenceThreshold() returns the W709 fallback
//     threshold scaled per language. Lower-quality languages get a LOWER
//     threshold so more requests route to the teacher.
//
// Public surface:
//   - KSCORE_PER_LANG_VERSION
//   - perLanguageKScore({rows, lang_filter})
//   - perLanguageConfidenceThreshold({lang, by_lang_kscore, default_threshold})

import * as kscore from './kscore.js';
import { detectLang, SUPPORTED_LANGS } from './lang-detect.js';

export const KSCORE_PER_LANG_VERSION = 'w760-v1';

// Wilson CI floor - same threshold as src/diagnostic.js. Below 30 rows
// per language we report point estimate as null because a confidence
// band drawn from <30 samples is a number-shaped lie.
const MIN_N_FOR_PER_LANG_CI = 30;

// Minimum rows-per-language for ANY estimate (pooled vs per-lang). Below
// this we surface insufficient_per_lang_samples and hint to W760-2
// (synthetic augmentation).
const MIN_N_FOR_PER_LANG_ANY = 30;

// W709 fallback default threshold - confidence below this routes to
// teacher. Per-lang ratio is clamped [0.5, 1.5] so a single very-weak
// language can't push the threshold to zero (and a very-strong language
// can't push it to 1.0 = always-fallback).
const DEFAULT_THRESHOLD_RATIO_LO = 0.5;
const DEFAULT_THRESHOLD_RATIO_HI = 1.5;

// =============================================================================
// perLanguageKScore
//
// Partition rows by detected language, compute K-Score per partition.
//
// Input:
//   rows: array of {input, output, accuracy?, coverage?, ...kscore inputs,
//                   k_score? (precomputed)}
//   opts.lang_filter: optional ISO list to restrict the partition
//
// Output:
//   { ok:true, version, by_lang:{<iso>:{n, k_score, k_axes:{F,R,E,...},
//                                       wilson_ci_lo, wilson_ci_hi}},
//     pooled:{n, k_score, k_axes, wilson_ci_lo, wilson_ci_hi},
//     n_total, n_unknown }
//
// On failure: honest envelope. The two shapes are:
//   - kscore_module_signature_mismatch: imported kscore.js doesn't expose
//     computeKScore. Should never fire in practice but keeps us honest if
//     the parent module is rewritten.
//   - insufficient_per_lang_samples: no language has enough rows. Returns
//     by_lang_counts so the caller can see WHICH languages need more
//     captures, and a hint pointing at W760-2 synthetic augmentation.
// =============================================================================

export function perLanguageKScore(opts) {
  const o = opts || {};
  const rows = Array.isArray(o.rows) ? o.rows : [];
  const langFilter = Array.isArray(o.lang_filter)
    ? o.lang_filter.filter((l) => SUPPORTED_LANGS.includes(l))
    : null;

  // Defensive signature check against the parent module. If src/kscore.js
  // ever drops computeKScore (or renames it) we want to fail loud, not
  // silently return zeros.
  if (typeof kscore.computeKScore !== 'function') {
    return {
      ok: false,
      error: 'kscore_module_signature_mismatch',
      hint: 'src/kscore.js no longer exports computeKScore - update kscore-per-language.js',
      version: KSCORE_PER_LANG_VERSION,
    };
  }

  // Partition rows by detected language. For each row, the input field
  // is the load-bearing signal; output falls back when input is empty.
  const buckets = new Map(); // lang -> [rows]
  let nUnknown = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') { nUnknown += 1; continue; }
    const text = r.input || r.prompt || r.output || r.response || '';
    if (!text || typeof text !== 'string') { nUnknown += 1; continue; }
    const d = detectLang(text);
    if (d.fallback || !d.lang) { nUnknown += 1; continue; }
    if (langFilter && !langFilter.includes(d.lang)) { nUnknown += 1; continue; }
    if (!buckets.has(d.lang)) buckets.set(d.lang, []);
    buckets.get(d.lang).push(r);
  }

  // Counts for the insufficient envelope.
  const byLangCounts = {};
  for (const [lang, arr] of buckets.entries()) byLangCounts[lang] = arr.length;

  // If NO language has >=MIN_N_FOR_PER_LANG_ANY rows, return honest envelope.
  const anyBigEnough = Object.values(byLangCounts).some((c) => c >= MIN_N_FOR_PER_LANG_ANY);
  if (!anyBigEnough) {
    return {
      ok: false,
      error: 'insufficient_per_lang_samples',
      need_min: MIN_N_FOR_PER_LANG_ANY,
      by_lang_counts: byLangCounts,
      n_total: rows.length,
      n_unknown: nUnknown,
      hint: 'Add more captures for the underrepresented languages or enable W760-2 synthetic augmentation',
      version: KSCORE_PER_LANG_VERSION,
    };
  }

  // ── Compute per-lang K-Score ──────────────────────────────────────────────
  const byLang = {};
  for (const [lang, arr] of buckets.entries()) {
    const n = arr.length;
    if (n < MIN_N_FOR_PER_LANG_ANY) {
      // Honest floor - we have rows for this language but not enough to
      // report a K-Score. Caller sees the count + null score.
      byLang[lang] = {
        n,
        k_score: null,
        k_axes: null,
        wilson_ci_lo: null,
        wilson_ci_hi: null,
        floor_hit: true,
        floor_hint: 'need >=' + MIN_N_FOR_PER_LANG_ANY + ' rows per language for honest K-Score',
      };
      continue;
    }
    const env = _computeBucketKScore(arr);
    const ciReady = n >= MIN_N_FOR_PER_LANG_CI;
    byLang[lang] = {
      n,
      k_score: env.composite == null ? null : _round4(env.composite),
      k_axes: env.axes,
      wilson_ci_lo: ciReady ? _round4(env.wilson.lo) : null,
      wilson_ci_hi: ciReady ? _round4(env.wilson.hi) : null,
      floor_hit: false,
    };
  }

  // ── Compute pooled K-Score over ALL rows (including any with fallback
  // langs / unknown - the pooled estimate is what kscore.js would give if
  // you ignored language). This is the comparison point that lets callers
  // see how much per-language variance the pooled number is hiding.
  let pooled = null;
  if (rows.length >= MIN_N_FOR_PER_LANG_ANY) {
    const env = _computeBucketKScore(rows);
    const ciReady = rows.length >= MIN_N_FOR_PER_LANG_CI;
    pooled = {
      n: rows.length,
      k_score: env.composite == null ? null : _round4(env.composite),
      k_axes: env.axes,
      wilson_ci_lo: ciReady ? _round4(env.wilson.lo) : null,
      wilson_ci_hi: ciReady ? _round4(env.wilson.hi) : null,
    };
  }

  return {
    ok: true,
    version: KSCORE_PER_LANG_VERSION,
    by_lang: byLang,
    pooled,
    n_total: rows.length,
    n_unknown: nUnknown,
  };
}

// =============================================================================
// perLanguageConfidenceThreshold
//
// Returns the W709 fallback threshold to use for a given language. Lower-
// quality languages get a LOWER threshold so the runtime router falls
// back to the teacher more often for them.
//
//   threshold = default_threshold * clamp(k_lang / k_pooled, 0.5, 1.5)
//
// Examples (default_threshold=0.7):
//   k_lang=0.91, k_pooled=0.85 → ratio 1.07 → threshold 0.75
//   k_lang=0.42, k_pooled=0.85 → ratio 0.49 → clamped 0.5 → threshold 0.35
//
// Honest envelope when by_lang_kscore is missing the requested lang OR
// the pooled value is null - never silently return the default.
// =============================================================================

export function perLanguageConfidenceThreshold(opts) {
  const o = opts || {};
  const lang = typeof o.lang === 'string' ? o.lang : null;
  const byLang = (o.by_lang_kscore && typeof o.by_lang_kscore === 'object') ? o.by_lang_kscore : null;
  const defaultThreshold = Number.isFinite(o.default_threshold) ? o.default_threshold : 0.7;

  if (!lang) {
    return {
      ok: false,
      error: 'lang_required',
      hint: 'pass {lang: "<iso>"} naming the language to compute a threshold for',
      version: KSCORE_PER_LANG_VERSION,
    };
  }
  if (!byLang) {
    return {
      ok: false,
      error: 'no_per_lang_kscore',
      hint: 'pass {by_lang_kscore} - the by_lang block from perLanguageKScore()',
      version: KSCORE_PER_LANG_VERSION,
    };
  }
  const langRow = byLang.by_lang ? byLang.by_lang[lang] : byLang[lang];
  const pooled = byLang.pooled || null;
  if (!langRow || langRow.k_score == null) {
    return {
      ok: false,
      error: 'no_data_for_lang',
      lang,
      hint: 'per-lang K-Score missing or null for ' + lang + ' - add captures or enable synthetic augmentation',
      version: KSCORE_PER_LANG_VERSION,
    };
  }
  if (!pooled || pooled.k_score == null) {
    return {
      ok: false,
      error: 'no_pooled_kscore',
      hint: 'pooled K-Score is null - compute pooled estimate before requesting per-lang threshold',
      version: KSCORE_PER_LANG_VERSION,
    };
  }
  const kLang = langRow.k_score;
  const kPooled = pooled.k_score;
  if (!Number.isFinite(kLang) || !Number.isFinite(kPooled) || kPooled <= 0) {
    return {
      ok: false,
      error: 'invalid_kscore',
      hint: 'k_score values must be finite positive numbers',
      version: KSCORE_PER_LANG_VERSION,
    };
  }
  const rawRatio = kLang / kPooled;
  const ratio = Math.max(DEFAULT_THRESHOLD_RATIO_LO, Math.min(DEFAULT_THRESHOLD_RATIO_HI, rawRatio));
  const threshold = Math.max(0, Math.min(1, defaultThreshold * ratio));
  return {
    ok: true,
    lang,
    default_threshold: defaultThreshold,
    k_lang: kLang,
    k_pooled: kPooled,
    raw_ratio: _round4(rawRatio),
    clamped_ratio: _round4(ratio),
    threshold: _round4(threshold),
    version: KSCORE_PER_LANG_VERSION,
  };
}

// =============================================================================
// _computeBucketKScore (private)
//
// Average per-row k_score across the bucket. When rows lack precomputed
// k_score, fall back to averaging accuracy/coverage and asking
// kscore.computeKScore for a composite. Returns:
//   { composite, axes, wilson:{lo,hi} }
// =============================================================================

function _computeBucketKScore(rows) {
  // If rows carry precomputed k_score, average those.
  const withKscore = rows.filter((r) => r && Number.isFinite(Number(r.k_score)));
  if (withKscore.length === rows.length && withKscore.length > 0) {
    const ks = withKscore.map((r) => Number(r.k_score));
    const mean = ks.reduce((s, k) => s + k, 0) / ks.length;
    const wilson = _wilson95(mean, ks.length);
    return {
      composite: mean,
      axes: null,
      wilson,
    };
  }
  // Otherwise, aggregate inputs + ask kscore.computeKScore.
  // Average accuracy + coverage; sum size + cost; min latency.
  const inputs = {
    accuracy: _meanField(rows, 'accuracy', 0),
    coverage: _meanField(rows, 'coverage', 0),
    size_bytes: _meanField(rows, 'size_bytes', 0),
    p50_latency_us: _meanField(rows, 'p50_latency_us', null),
    cost_usd_per_call: _meanField(rows, 'cost_usd_per_call', 0),
  };
  const env = kscore.computeKScore(inputs);
  const wilson = _wilson95(env.composite, rows.length);
  const axes = {};
  for (const k of ['accuracy', 'coverage', 'size_score', 'latency_score', 'cost_score',
                    'robustness_score', 'fairness_score', 'energy_score', 'drift_score',
                    'teacher_fidelity_score']) {
    if (env[k] != null) axes[k] = env[k];
  }
  return { composite: env.composite, axes, wilson };
}

function _meanField(rows, field, fallback) {
  const xs = rows
    .map((r) => (r && r[field] != null) ? Number(r[field]) : null)
    .filter((v) => Number.isFinite(v));
  if (xs.length === 0) return fallback;
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

// Wilson 95% CI on a 0..1 proportion. Caller must enforce n>=30.
function _wilson95(p, n) {
  if (n < 1 || !Number.isFinite(p)) return { lo: 0, hi: 0 };
  const z = 1.96;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const halfwidth = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    lo: Math.max(0, center - halfwidth),
    hi: Math.min(1, center + halfwidth),
  };
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  KSCORE_PER_LANG_VERSION,
  perLanguageKScore,
  perLanguageConfidenceThreshold,
};
