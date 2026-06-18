// W760 / W704 - Per-language K-Score breakdown.
//
// A pooled K-Score can hide weak language partitions. This module partitions
// capture/eval rows by detected language and reports an honest per-language
// score only when a bucket has enough valid scoring basis rows.
//
// Public surface:
//   - KSCORE_PER_LANG_VERSION
//   - KSCORE_PER_LANG_CONTRACT_VERSION
//   - KSCORE_PER_LANG_LIMITS
//   - perLanguageKScore({ rows, lang_filter })
//   - perLanguageConfidenceThreshold({ lang, by_lang_kscore, default_threshold })

import crypto from 'node:crypto';

import * as kscore from './kscore.js';
import { detectLang, SUPPORTED_LANGS } from './lang-detect.js';

export const KSCORE_PER_LANG_VERSION = 'w760-v2';
export const KSCORE_PER_LANG_CONTRACT_VERSION = 'w704-v1';

export const KSCORE_PER_LANG_LIMITS = Object.freeze({
  MAX_ROWS: 5000,
  MAX_TEXT_CHARS: 8192,
  MAX_LANG_FILTERS: 32,
  MIN_N_FOR_PER_LANG_CI: 30,
  MIN_N_FOR_PER_LANG_ANY: 30,
  DEFAULT_THRESHOLD_RATIO_LO: 0.5,
  DEFAULT_THRESHOLD_RATIO_HI: 1.5,
});

const LANG_SET = new Set(SUPPORTED_LANGS);
const HEX64_RE = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function finiteNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function sanitizeLang(lang) {
  if (typeof lang !== 'string') return null;
  const clean = lang.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(clean)) return null;
  return LANG_SET.has(clean) ? clean : null;
}

function normalizeLangFilter(raw) {
  const source = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  const accepted = [];
  const rejected = [];
  for (const item of source.slice(0, KSCORE_PER_LANG_LIMITS.MAX_LANG_FILTERS)) {
    const lang = sanitizeLang(item);
    if (!lang) {
      if (item != null) rejected.push(String(item).slice(0, 32));
      continue;
    }
    if (!accepted.includes(lang)) accepted.push(lang);
  }
  return {
    langs: accepted.length > 0 ? accepted : null,
    rejected,
    truncated: source.length > KSCORE_PER_LANG_LIMITS.MAX_LANG_FILTERS,
  };
}

function boundedTextFromRow(row) {
  const candidates = [row.input, row.prompt, row.output, row.response];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    if (candidate.trim() === '') continue;
    if (candidate.length > KSCORE_PER_LANG_LIMITS.MAX_TEXT_CHARS) {
      return { text: candidate.slice(0, KSCORE_PER_LANG_LIMITS.MAX_TEXT_CHARS), truncated: true };
    }
    return { text: candidate, truncated: false };
  }
  return { text: '', truncated: false };
}

function detectRowLang(row) {
  const text = boundedTextFromRow(row);
  if (!text.text) return { lang: null, fallback: true, text_truncated: false };
  try {
    const detected = detectLang(text.text);
    return {
      lang: sanitizeLang(detected && detected.lang),
      fallback: !detected || detected.fallback === true || !detected.lang,
      text_truncated: text.truncated,
    };
  } catch {
    return { lang: null, fallback: true, text_truncated: text.truncated };
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function hasPrecomputedKScore(row) {
  return row && typeof row === 'object' && hasOwn(row, 'k_score');
}

function validKScoreValue(row) {
  if (!hasPrecomputedKScore(row)) return null;
  const n = finiteNumber(row.k_score);
  if (n == null || n < 0 || n > 1) return null;
  return n;
}

function scoreBasisCount(rows) {
  const withPrecomputed = rows.filter(hasPrecomputedKScore);
  if (withPrecomputed.length > 0) return withPrecomputed.filter((row) => validKScoreValue(row) != null).length;
  return rows.length;
}

function envelopeDigest(payload) {
  return sha256(stableJson(payload));
}

function finalizeEnvelope(out) {
  out.report_sha256 = envelopeDigest({
    ok: out.ok,
    error: out.error || null,
    version: out.version,
    contract_version: out.contract_version,
    by_lang: out.by_lang || null,
    pooled: out.pooled || null,
    by_lang_counts: out.by_lang_counts || null,
    by_lang_score_counts: out.by_lang_score_counts || null,
    n_total: out.n_total,
    n_unknown: out.n_unknown,
    stats: out.stats || null,
  });
  return out;
}

function signatureMismatchEnvelope() {
  return finalizeEnvelope({
    ok: false,
    error: 'kscore_module_signature_mismatch',
    hint: 'src/kscore.js no longer exports computeKScore; update kscore-per-language.js',
    version: KSCORE_PER_LANG_VERSION,
    contract_version: KSCORE_PER_LANG_CONTRACT_VERSION,
    n_total: 0,
    n_unknown: 0,
  });
}

export function perLanguageKScore(opts = {}) {
  if (typeof kscore.computeKScore !== 'function') return signatureMismatchEnvelope();

  const inputRows = Array.isArray(opts.rows) ? opts.rows : [];
  const rows = inputRows.slice(0, KSCORE_PER_LANG_LIMITS.MAX_ROWS);
  const filter = normalizeLangFilter(opts.lang_filter);
  const filterSet = filter.langs ? new Set(filter.langs) : null;
  const stats = {
    input_rows: inputRows.length,
    processed_rows: rows.length,
    rows_truncated: Math.max(0, inputRows.length - rows.length),
    text_truncated_rows: 0,
    invalid_rows: 0,
    filtered_rows: 0,
    lang_filter_rejected: filter.rejected,
    lang_filter_truncated: filter.truncated,
  };

  const buckets = new Map();
  let nUnknown = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      stats.invalid_rows += 1;
      nUnknown += 1;
      continue;
    }
    const detected = detectRowLang(row);
    if (detected.text_truncated) stats.text_truncated_rows += 1;
    if (detected.fallback || !detected.lang) {
      nUnknown += 1;
      continue;
    }
    if (filterSet && !filterSet.has(detected.lang)) {
      stats.filtered_rows += 1;
      continue;
    }
    if (!buckets.has(detected.lang)) buckets.set(detected.lang, []);
    buckets.get(detected.lang).push(row);
  }

  const byLangCounts = {};
  const byLangScoreCounts = {};
  for (const lang of [...buckets.keys()].sort()) {
    const arr = buckets.get(lang);
    byLangCounts[lang] = arr.length;
    byLangScoreCounts[lang] = scoreBasisCount(arr);
  }

  const anyBigEnough = Object.values(byLangScoreCounts)
    .some((count) => count >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY);
  if (!anyBigEnough) {
    return finalizeEnvelope({
      ok: false,
      error: 'insufficient_per_lang_samples',
      need_min: KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY,
      by_lang_counts: byLangCounts,
      by_lang_score_counts: byLangScoreCounts,
      n_total: rows.length,
      n_unknown: nUnknown,
      stats,
      hint: 'Add captures with valid scoring basis for underrepresented languages or enable synthetic augmentation',
      version: KSCORE_PER_LANG_VERSION,
      contract_version: KSCORE_PER_LANG_CONTRACT_VERSION,
    });
  }

  const byLang = {};
  for (const lang of [...buckets.keys()].sort()) {
    const arr = buckets.get(lang);
    const basisN = scoreBasisCount(arr);
    if (basisN < KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY) {
      byLang[lang] = {
        n: arr.length,
        score_n: basisN,
        invalid_score_rows: Math.max(0, arr.length - basisN),
        k_score: null,
        k_axes: null,
        wilson_ci_lo: null,
        wilson_ci_hi: null,
        floor_hit: true,
        floor_hint: `need >=${KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY} valid scored rows per language for honest K-Score`,
      };
      continue;
    }
    const env = _computeBucketKScore(arr);
    const ciReady = env.score_n >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_CI;
    byLang[lang] = {
      n: arr.length,
      score_n: env.score_n,
      invalid_score_rows: env.invalid_score_rows,
      k_score: env.composite == null ? null : _round4(env.composite),
      k_axes: env.axes,
      wilson_ci_lo: ciReady ? _round4(env.wilson.lo) : null,
      wilson_ci_hi: ciReady ? _round4(env.wilson.hi) : null,
      floor_hit: false,
    };
  }

  const pooledEnv = rows.length >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY
    ? _computeBucketKScore(rows)
    : null;
  const pooled = pooledEnv && pooledEnv.score_n >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY
    ? {
        n: rows.length,
        score_n: pooledEnv.score_n,
        invalid_score_rows: pooledEnv.invalid_score_rows,
        k_score: pooledEnv.composite == null ? null : _round4(pooledEnv.composite),
        k_axes: pooledEnv.axes,
        wilson_ci_lo: pooledEnv.score_n >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_CI ? _round4(pooledEnv.wilson.lo) : null,
        wilson_ci_hi: pooledEnv.score_n >= KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_CI ? _round4(pooledEnv.wilson.hi) : null,
      }
    : null;

  return finalizeEnvelope({
    ok: true,
    version: KSCORE_PER_LANG_VERSION,
    contract_version: KSCORE_PER_LANG_CONTRACT_VERSION,
    by_lang: byLang,
    by_lang_counts: byLangCounts,
    by_lang_score_counts: byLangScoreCounts,
    pooled,
    n_total: rows.length,
    n_unknown: nUnknown,
    stats,
  });
}

export function perLanguageConfidenceThreshold(opts = {}) {
  const lang = sanitizeLang(opts.lang);
  const byLang = (opts.by_lang_kscore && typeof opts.by_lang_kscore === 'object') ? opts.by_lang_kscore : null;
  const defaultThreshold = opts.default_threshold == null ? 0.7 : finiteNumber(opts.default_threshold);

  if (!lang) {
    return _thresholdError('lang_required', { hint: 'pass {lang:"<supported iso>"} naming the language to compute a threshold for' });
  }
  if (defaultThreshold == null || defaultThreshold < 0 || defaultThreshold > 1) {
    return _thresholdError('default_threshold_invalid', { lang });
  }
  if (!byLang) {
    return _thresholdError('no_per_lang_kscore', { lang, hint: 'pass {by_lang_kscore} from perLanguageKScore()' });
  }

  const table = byLang.by_lang && typeof byLang.by_lang === 'object' ? byLang.by_lang : byLang;
  const langRow = hasOwn(table, lang) ? table[lang] : null;
  const pooled = byLang.pooled || null;
  if (!langRow || langRow.k_score == null) {
    return _thresholdError('no_data_for_lang', {
      lang,
      hint: `per-language K-Score missing or null for ${lang}; add captures or enable synthetic augmentation`,
    });
  }
  if (!pooled || pooled.k_score == null) {
    return _thresholdError('no_pooled_kscore', {
      lang,
      hint: 'pooled K-Score is null; compute pooled estimate before requesting per-language threshold',
    });
  }

  const kLang = finiteNumber(langRow.k_score);
  const kPooled = finiteNumber(pooled.k_score);
  if (kLang == null || kPooled == null || kLang < 0 || kLang > 1 || kPooled <= 0 || kPooled > 1) {
    return _thresholdError('invalid_kscore', { lang, hint: 'k_score values must be finite numbers in [0,1]' });
  }

  const rawRatio = kLang / kPooled;
  const ratio = Math.max(
    KSCORE_PER_LANG_LIMITS.DEFAULT_THRESHOLD_RATIO_LO,
    Math.min(KSCORE_PER_LANG_LIMITS.DEFAULT_THRESHOLD_RATIO_HI, rawRatio),
  );
  const threshold = clamp01(defaultThreshold * ratio);
  const out = {
    ok: true,
    lang,
    default_threshold: defaultThreshold,
    k_lang: _round4(kLang),
    k_pooled: _round4(kPooled),
    raw_ratio: _round4(rawRatio),
    clamped_ratio: _round4(ratio),
    threshold: _round4(threshold),
    version: KSCORE_PER_LANG_VERSION,
    contract_version: KSCORE_PER_LANG_CONTRACT_VERSION,
  };
  out.threshold_sha256 = envelopeDigest(out);
  return out;
}

function _thresholdError(error, patch = {}) {
  const out = {
    ok: false,
    error,
    version: KSCORE_PER_LANG_VERSION,
    contract_version: KSCORE_PER_LANG_CONTRACT_VERSION,
    ...patch,
  };
  out.threshold_sha256 = envelopeDigest(out);
  return out;
}

function _computeBucketKScore(rows) {
  const precomputedRows = rows.filter(hasPrecomputedKScore);
  if (precomputedRows.length > 0) {
    const scores = precomputedRows
      .map(validKScoreValue)
      .filter((value) => value != null);
    const mean = scores.length > 0
      ? scores.reduce((sum, value) => sum + value, 0) / scores.length
      : null;
    return {
      composite: mean,
      axes: null,
      score_n: scores.length,
      invalid_score_rows: precomputedRows.length - scores.length,
      wilson: _wilson95(mean, scores.length),
    };
  }

  const inputs = {
    accuracy: _meanField(rows, 'accuracy', 0, { clamp: true }),
    coverage: _meanField(rows, 'coverage', 0, { clamp: true }),
    size_bytes: _meanField(rows, 'size_bytes', 0, { min: 0 }),
    p50_latency_us: _meanField(rows, 'p50_latency_us', null, { min: 0 }),
    cost_usd_per_call: _meanField(rows, 'cost_usd_per_call', 0, { min: 0 }),
  };
  const env = kscore.computeKScore(inputs);
  const composite = finiteNumber(env && env.composite);
  const axes = {};
  for (const key of [
    'accuracy',
    'coverage',
    'size_score',
    'latency_score',
    'cost_score',
    'robustness_score',
    'fairness_score',
    'energy_score',
    'drift_score',
    'teacher_fidelity_score',
  ]) {
    const value = finiteNumber(env && env[key]);
    if (value != null) axes[key] = _round4(clamp01(value));
  }
  return {
    composite: composite == null ? null : clamp01(composite),
    axes,
    score_n: rows.length,
    invalid_score_rows: 0,
    wilson: _wilson95(composite, rows.length),
  };
}

function _meanField(rows, field, fallback, options = {}) {
  const values = [];
  for (const row of rows) {
    if (!row || row[field] == null) continue;
    let value = finiteNumber(row[field]);
    if (value == null) continue;
    if (options.clamp) value = clamp01(value);
    if (Number.isFinite(options.min)) value = Math.max(options.min, value);
    values.push(value);
  }
  if (values.length === 0) return fallback;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function _wilson95(p, n) {
  if (n < 1 || !Number.isFinite(p) || p < 0 || p > 1) return { lo: null, hi: null };
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

function _round4(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10000) / 10000;
}

export const _internal = Object.freeze({
  HEX64_RE,
  boundedTextFromRow,
  normalizeLangFilter,
  sanitizeLang,
  scoreBasisCount,
  stableJson,
});

export default {
  KSCORE_PER_LANG_VERSION,
  KSCORE_PER_LANG_CONTRACT_VERSION,
  KSCORE_PER_LANG_LIMITS,
  perLanguageKScore,
  perLanguageConfidenceThreshold,
};
