// W833-3 - Multilingual mixture training.

import { detectLanguage as _w833_1_detectLanguage } from './lingual-detect.js';
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 1199):
//   [W833-3] Multilingual mixture training.
//
// Why this exists alongside src/lang-balanced-sampler.js (W774):
//   * W774 sampleBalanced() returns a FINITE selection of capture IDs
//     based on a strategy (uniform / sqrt_inverse / log_inverse / traffic
//     weighted). It selects ONCE up to max_n and stops.
//   * W833-3 buildMixture() returns a stateful ITERATOR - caller can pull
//     rows indefinitely and the iterator keeps drawing per lang_weights.
//     This is the API distill loops want: "give me the next training row
//     according to the multilingual mixture I configured" rather than
//     "select 100 rows now and that's it."
//   * autoBalanceWeights() turns a distributionByLang() output into a
//     suggested weights map that floors underrepresented langs at 0.05
//     each - closes the loop from W833-1 detection → W833-3 mixture
//     without an operator hand-typing weights.
//
// Honesty contract:
//   * NEVER fabricate samples from zero rows. If a language has zero
//     captures in the pool but is in lang_weights, the iterator skips
//     that language (it cannot draw from nothing) AND surfaces the gap
//     via assessMixture() / the by_lang counts that buildMixture exposes.
//   * Weights are NORMALIZED to sum 1.0 internally so callers can pass
//     unnormalized weights (e.g. {en:5, es:2, zh:3}).
//
// Public surface:
//   - LINGUAL_MIXTURE_VERSION
//   - buildMixture({captures, lang_weights, lang_detect?})
//       → { ok:true, iterator: ()=>{row, lang}|null, by_lang_pool_counts,
//           normalized_weights, version }
//   - autoBalanceWeights(distributionByLang_output, opts?)
//       → { weights:{en:N, es:N, ...}, floor, source_total, version }

export const LINGUAL_MIXTURE_VERSION = 'w833-v1';

// Floor for underrepresented languages when autoBalanceWeights() is
// called. Tuned to 0.05 (5%) per the W833 spec line - any lang already
// above this stays at its observed ratio (or higher), any lang below
// gets lifted to 0.05.
const DEFAULT_UNDERREP_FLOOR = 0.05;

// =============================================================================
// buildMixture
//
// Build a stateful mixture iterator. Each call to the returned iterator
// returns one row drawn according to the configured per-language
// probabilities, OR null when ALL configured languages have been
// exhausted (with no replacement to draw from).
//
// Input:
//   opts.captures:     [{input|prompt|prompt_redacted|...}, ...]
//   opts.lang_weights: {en:0.5, es:0.2, zh:0.3} - unnormalized OK.
//                      Languages NOT in this map are excluded entirely.
//   opts.lang_detect:  DI sync (text) => {lang} - defaults to W833-1
//                      detectLanguage; tests pass deterministic stubs.
//   opts.with_replacement: boolean (default false). When true the
//                          iterator never returns null - it cycles the
//                          per-lang buckets and re-draws. When false
//                          (default) an exhausted lang is dropped from
//                          contention; iterator returns null when ALL
//                          configured langs are exhausted.
//   opts.rng:          DI Math.random replacement (deterministic in tests).
//
// Output (ok:true):
//   { ok:true, version,
//     iterator: () => { row, lang } | null,
//     by_lang_pool_counts: {en:N, es:N, ...},   // raw bucket sizes
//     normalized_weights:  {en:0.5, es:0.2, ...}, // sum 1.0
//     missing_langs:[<iso>...], // langs in lang_weights with pool count 0
//   }
//
// Output (ok:false):
//   { ok:false, error, hint, version }
// =============================================================================

export function buildMixture(opts) {
  const o = opts || {};
  const captures = Array.isArray(o.captures) ? o.captures : [];
  const weightsIn = (o.lang_weights && typeof o.lang_weights === 'object')
    ? o.lang_weights : {};
  const detectFn = (typeof o.lang_detect === 'function')
    ? o.lang_detect
    : _defaultDetect;
  const withReplacement = (o.with_replacement === true);
  const rng = (typeof o.rng === 'function') ? o.rng : Math.random;

  if (captures.length === 0) {
    return {
      ok: false,
      error: 'empty_captures',
      hint: 'pass {captures:[...]} with at least one row - buildMixture never fabricates from zero rows',
      version: LINGUAL_MIXTURE_VERSION,
    };
  }

  const targetLangs = Object.keys(weightsIn);
  if (targetLangs.length === 0) {
    return {
      ok: false,
      error: 'empty_lang_weights',
      hint: 'pass {lang_weights:{en:0.5, es:0.3, ...}} - buildMixture needs at least one weighted language',
      version: LINGUAL_MIXTURE_VERSION,
    };
  }

  // Normalize weights to sum 1.0 (callers can pass raw counts).
  let totalW = 0;
  for (const lang of targetLangs) {
    const w = Math.max(0, Number(weightsIn[lang]) || 0);
    totalW += w;
  }
  const normalized = {};
  if (totalW <= 0) {
    return {
      ok: false,
      error: 'invalid_lang_weights',
      hint: 'lang_weights must sum to >0 - got all-zero / non-finite map',
      version: LINGUAL_MIXTURE_VERSION,
    };
  }
  for (const lang of targetLangs) {
    const w = Math.max(0, Number(weightsIn[lang]) || 0);
    normalized[lang] = _round4(w / totalW);
  }

  // Partition captures by detected language. Captures whose detected lang
  // is NOT in lang_weights are excluded from the mixture (the operator
  // explicitly chose a subset).
  const bucketsByLang = new Map();
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const text = cap.input || cap.prompt || cap.prompt_redacted ||
                 cap.output || cap.response || cap.response_redacted || '';
    if (typeof text !== 'string' || text.length === 0) continue;
    const d = detectFn(text) || {};
    const lang = d.lang;
    if (!lang || !targetLangs.includes(lang)) continue;
    if (!bucketsByLang.has(lang)) bucketsByLang.set(lang, []);
    bucketsByLang.get(lang).push(cap);
  }

  const byLangPoolCounts = {};
  for (const lang of targetLangs) {
    byLangPoolCounts[lang] = (bucketsByLang.get(lang) || []).length;
  }
  const missingLangs = targetLangs.filter((l) => byLangPoolCounts[l] === 0);

  // Per-lang cursors track the next index to return from each bucket.
  // For without_replacement mode we drop a lang from contention once
  // exhausted; for with_replacement mode we wrap around.
  const cursors = new Map();
  for (const lang of targetLangs) cursors.set(lang, 0);
  // Live weights - when a lang is exhausted in without_replacement mode
  // we zero its weight and renormalize the rest on the fly. This keeps
  // the per-row draw fair across the surviving langs.
  const liveWeights = { ...normalized };

  function _liveTotal() {
    let s = 0;
    for (const lang of targetLangs) s += liveWeights[lang] || 0;
    return s;
  }

  function iterator() {
    // Pick a language by weighted random draw against the LIVE weights.
    let total = _liveTotal();
    if (total <= 0) return null;
    // Standard inverse-CDF weighted pick.
    let pick = rng() * total;
    let chosen = null;
    for (const lang of targetLangs) {
      const w = liveWeights[lang] || 0;
      if (w <= 0) continue;
      if (pick < w) { chosen = lang; break; }
      pick -= w;
    }
    if (!chosen) {
      // Floating-point underflow guard - pick the first surviving lang.
      for (const lang of targetLangs) {
        if ((liveWeights[lang] || 0) > 0) { chosen = lang; break; }
      }
    }
    if (!chosen) return null;

    const pool = bucketsByLang.get(chosen) || [];
    if (pool.length === 0) {
      // Pool is empty for this lang - drop it and recurse once.
      liveWeights[chosen] = 0;
      return iterator();
    }

    const cur = cursors.get(chosen) || 0;
    if (cur >= pool.length) {
      if (withReplacement) {
        cursors.set(chosen, 0);
      } else {
        // Exhausted without replacement - drop this lang from the mix.
        liveWeights[chosen] = 0;
        return iterator();
      }
    }
    const idx = (cursors.get(chosen) || 0) % pool.length;
    cursors.set(chosen, (cursors.get(chosen) || 0) + 1);
    return { row: pool[idx], lang: chosen };
  }

  return {
    ok: true,
    version: LINGUAL_MIXTURE_VERSION,
    iterator,
    by_lang_pool_counts: byLangPoolCounts,
    normalized_weights: normalized,
    missing_langs: missingLangs,
    with_replacement: withReplacement,
  };
}

// =============================================================================
// autoBalanceWeights
//
// Suggest a weights map from a distributionByLang() output: every
// underrepresented language is floored at 0.05; over-represented langs
// keep their observed ratio MINUS the lift redistributed to floored
// langs (so the resulting weights still sum to 1.0).
//
// Input:
//   dist:            output of distributionByLang() - { by_lang:{...},
//                    total, underrepresented:[{lang, ratio, target_ratio}],
//                    version }
//   opts.floor:      per-lang floor (default 0.05)
//   opts.target_langs:  ISO list to consider - defaults to the union of
//                       dist.by_lang and dist.underrepresented langs.
//
// Output:
//   { weights:{en:N, es:N, ...}, floor, source_total, version,
//     lifted_langs:[<iso>...], deflated_langs:[<iso>...] }
//
// Empty dist returns equal weights across opts.target_langs (or an empty
// weights map if no target_langs known).
// =============================================================================

export function autoBalanceWeights(dist, opts) {
  const o = opts || {};
  const floor = Number.isFinite(o.floor) ? o.floor : DEFAULT_UNDERREP_FLOOR;
  const d = (dist && typeof dist === 'object') ? dist : {};
  const byLang = (d.by_lang && typeof d.by_lang === 'object') ? d.by_lang : {};
  const underrep = Array.isArray(d.underrepresented) ? d.underrepresented : [];

  // Union of observed langs (sans 'unknown') and underrep langs.
  const langSet = new Set();
  for (const l of Object.keys(byLang)) if (l !== 'unknown') langSet.add(l);
  for (const u of underrep) if (u && u.lang) langSet.add(u.lang);
  if (Array.isArray(o.target_langs)) for (const l of o.target_langs) langSet.add(l);
  const langs = Array.from(langSet).sort();

  if (langs.length === 0) {
    return {
      weights: {},
      floor: _round4(floor),
      source_total: d.total || 0,
      lifted_langs: [],
      deflated_langs: [],
      version: LINGUAL_MIXTURE_VERSION,
    };
  }

  // Stage 1: start from observed ratios (or 0 if not observed).
  const raw = {};
  for (const lang of langs) {
    raw[lang] = (Number.isFinite(byLang[lang]) ? byLang[lang] : 0);
  }
  // Stage 2: floor every lang at `floor`. Track which were lifted.
  const lifted = [];
  for (const lang of langs) {
    if (raw[lang] < floor) {
      lifted.push(lang);
      raw[lang] = floor;
    }
  }
  // Stage 3: normalize back to sum 1.0. If the floor pushed the sum >1
  // we proportionally shrink the OVER-floor langs to make room (never
  // dropping a floored lang back below the floor).
  let sum = 0;
  for (const lang of langs) sum += raw[lang];
  const deflated = [];
  if (sum > 1.0) {
    const overFloor = langs.filter((l) => raw[l] > floor);
    if (overFloor.length > 0) {
      const overSum = overFloor.reduce((s, l) => s + raw[l], 0);
      const slack = sum - 1.0;
      // Shrink each over-floor lang in proportion to its size, but
      // never below `floor`.
      const newOverSum = Math.max(overFloor.length * floor, overSum - slack);
      const scale = (overSum > 0) ? (newOverSum / overSum) : 1;
      for (const lang of overFloor) {
        const before = raw[lang];
        const after = Math.max(floor, before * scale);
        if (after < before) deflated.push(lang);
        raw[lang] = after;
      }
      // Re-tally + final normalize so the weights map is exact 1.0.
      sum = 0;
      for (const lang of langs) sum += raw[lang];
    }
  } else if (sum < 1.0 && sum > 0) {
    // Sum below 1.0 - scale up proportionally so the weights still sum
    // to 1.0 (caller treats the map as a probability distribution).
    const scale = 1.0 / sum;
    for (const lang of langs) raw[lang] *= scale;
    sum = 1.0;
  }

  const weights = {};
  if (sum > 0) {
    for (const lang of langs) weights[lang] = _round4(raw[lang] / sum);
  } else {
    // Degenerate - fall back to equal split.
    const eq = _round4(1 / langs.length);
    for (const lang of langs) weights[lang] = eq;
  }

  return {
    weights,
    floor: _round4(floor),
    source_total: d.total || 0,
    lifted_langs: lifted.sort(),
    deflated_langs: deflated.sort(),
    version: LINGUAL_MIXTURE_VERSION,
  };
}

// =============================================================================
// helpers
// =============================================================================

function _defaultDetect(text) {
  // Use the W833-1 detector (sync). Tests inject deterministic stubs via
  // the opts.lang_detect DI seam.
  return _w833_1_detectLanguage(text);
}

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  LINGUAL_MIXTURE_VERSION,
  buildMixture,
  autoBalanceWeights,
};
