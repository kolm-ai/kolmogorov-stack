// W774 - Language-balanced sampler for cross-lingual distillation.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 643-648):
//   [W774-1] Distill from English teacher → multilingual student handling
//            10+ languages → language-balanced sampler
//
// Why: a naive distillation sampler that draws uniformly across rows ends
// up reflecting the language MIX of the captures, not the target language
// mix. A 95%-English corpus produces a 95%-English student, which scores
// great on the pooled K-Score and terribly on Spanish (W760 #2). This
// module re-weights the sample so each target language is represented
// proportionally to the chosen balance strategy, not the raw row count.
//
// Design contract:
//   - PURE JS; lang detection is dependency-injected (DI seam) so tests
//     can pass a stub and production wires src/lang-detect.js (W760).
//   - HONESTY FLOOR: empty captures → ok:false honest envelope. We never
//     fabricate a "balanced sample" from zero rows.
//   - BUDGETED: opts.max_n caps the output sample size; oversampling is
//     done with-replacement only if a target language has fewer source
//     rows than its target share.
//   - W760 alignment: DEFAULT_TARGET_LANGS is a 12-language subset of
//     W760 SUPPORTED_LANGS (22). 12 ≥ 10 spec floor and gives full
//     script-class coverage (Latin, CJK, Cyrillic, Arabic, Devanagari,
//     Hangul) so the balanced sample exercises every detection branch.
//
// Public surface:
//   - LANG_BALANCED_VERSION
//   - BALANCE_STRATEGIES                                  (Object.freeze)
//   - DEFAULT_TARGET_LANGS
//   - sampleBalanced({captures, strategy, target_langs, max_n, lang_detect})
//   - assessLanguageCoverage({captures, target_langs, lang_detect})

export const LANG_BALANCED_VERSION = 'w774-v1';
export const LANG_BALANCED_LIMITS = Object.freeze({
  max_capture_rows: 50000,
  max_target_langs: 64,
  max_sample_id_chars: 160,
});

// Four balance strategies. Each one re-weights the per-language target
// share differently. Frozen so callers cannot mutate the contract.
//
//   uniform - every target language gets 1/N of the budget.
//                       Best when downstream eval weights all languages
//                       equally (per-language K-Score reporting, W760).
//   sqrt_inverse - weight ∝ 1/sqrt(traffic_count_for_lang). Gives
//                       rare languages MORE samples than uniform but less
//                       than full inverse - the canonical NMT balance
//                       (Arivazhagan et al, 2019, "Massively Multilingual
//                       Neural Machine Translation in the Wild").
//   log_inverse - weight ∝ 1/log(1+traffic_count_for_lang). Even
//                       softer than sqrt; helps when extreme tail
//                       languages would otherwise dominate.
//   traffic_weighted - weight ∝ traffic_count_for_lang. Mirrors W760's
//                       per-language K-Score "honest about what the
//                       student will see in production" framing.
export const BALANCE_STRATEGIES = Object.freeze([
  'uniform',
  'sqrt_inverse',
  'log_inverse',
  'traffic_weighted',
]);

// 12 default target languages. Chosen as a subset of W760 SUPPORTED_LANGS
// (22) so anything detect-able by lang-detect.js can be balanced against.
// Covers the six script classes the detector handles (Latin, CJK kanji,
// CJK kana, Cyrillic, Arabic, Devanagari, Hangul). Spec requires 10+;
// we ship 12.
export const DEFAULT_TARGET_LANGS = Object.freeze([
  'en', 'es', 'fr', 'de', 'ja', 'zh',
  'pt', 'ru', 'ar', 'hi', 'ko', 'it',
]);

function _safeLang(raw) {
  const lang = String(raw == null ? '' : raw).trim().toLowerCase();
  return /^[a-z]{2}$/.test(lang) ? lang : null;
}

function _safeTargetLangs(raw) {
  const src = (Array.isArray(raw) && raw.length > 0) ? raw : DEFAULT_TARGET_LANGS;
  const out = [];
  const seen = new Set();
  for (const item of src) {
    if (out.length >= LANG_BALANCED_LIMITS.max_target_langs) break;
    const lang = _safeLang(item);
    if (!lang || seen.has(lang)) continue;
    seen.add(lang);
    out.push(lang);
  }
  return out.length > 0 ? out : DEFAULT_TARGET_LANGS.slice();
}

function _safeSampleId(value, fallback) {
  const s = String(value == null ? fallback : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .trim()
    .slice(0, LANG_BALANCED_LIMITS.max_sample_id_chars);
  if (!s || s === '__proto__' || s === 'constructor' || s === 'prototype') return String(fallback);
  return s;
}

// =============================================================================
// sampleBalanced
//
// Re-balance a capture pool so each target language is represented by its
// strategy-determined share of the output sample.
//
// Input:
//   opts.captures:     [{cid|event_id, input|prompt, output|response, ...}]
//   opts.strategy:     one of BALANCE_STRATEGIES (default 'uniform')
//   opts.target_langs: ISO list (default DEFAULT_TARGET_LANGS)
//   opts.max_n:        cap on the output sample size (default 100)
//   opts.lang_detect:  DI callback (text) => {lang|null, fallback}.
//                      When omitted we lazy-import src/lang-detect.js.
//
// Output:
//   { ok:true, version, strategy, target_langs,
//     by_lang:{en:N, es:N, ...},     // selected count per language
//     samples:[capture_id, ...],     // ordered selection of cids
//     total_n,                       // samples.length
//     coverage_pct,                  // (langs_present_in_output / target_langs.length) * 100
//     traffic_by_lang:{en:N, ...},   // raw input counts before balancing
//   }
//
// On failure:
//   { ok:false, error, hint, version } - honest, never fabricated.
// =============================================================================

export async function sampleBalanced(opts) {
  const o = opts || {};
  const captures = Array.isArray(o.captures) ? o.captures.slice(0, LANG_BALANCED_LIMITS.max_capture_rows) : [];
  const strategy = BALANCE_STRATEGIES.includes(o.strategy) ? o.strategy : 'uniform';
  const targetLangs = _safeTargetLangs(o.target_langs);
  const maxN = Number.isFinite(o.max_n) && o.max_n > 0
    ? Math.max(1, Math.min(100000, Math.trunc(o.max_n)))
    : 100;

  if (captures.length === 0) {
    return {
      ok: false,
      error: 'empty_captures',
      hint: 'pass {captures:[...]} with at least one row - sampleBalanced never fabricates from zero rows',
      version: LANG_BALANCED_VERSION,
    };
  }

  // Resolve lang detector - DI or fall back to W760's pure-JS detect.
  const detectFn = await _resolveDetect(o.lang_detect);

  // Partition captures by detected language. Captures whose language is
  // NOT in target_langs are dropped from contention (they cannot
  // contribute to any target bucket).
  const bucketsByLang = new Map();
  const trafficByLang = {};
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const text = cap.input || cap.prompt || cap.output || cap.response || '';
    if (typeof text !== 'string' || text.length === 0) continue;
    const d = detectFn(text) || {};
    const lang = _safeLang(d.lang);
    if (!lang || d.fallback) continue;
    trafficByLang[lang] = (trafficByLang[lang] || 0) + 1;
    if (!targetLangs.includes(lang)) continue;
    if (!bucketsByLang.has(lang)) bucketsByLang.set(lang, []);
    bucketsByLang.get(lang).push(cap);
  }

  // Compute per-language weight under the chosen strategy.
  const weights = {};
  let totalWeight = 0;
  for (const lang of targetLangs) {
    const traffic = trafficByLang[lang] || 0;
    let w;
    if (strategy === 'uniform') {
      // Every target gets equal share regardless of traffic.
      w = 1.0;
    } else if (strategy === 'sqrt_inverse') {
      // Rare langs get MORE weight, but softer than 1/n.
      w = 1.0 / Math.sqrt(Math.max(1, traffic));
    } else if (strategy === 'log_inverse') {
      // Even softer; mostly equalizes very-rare vs medium-rare.
      w = 1.0 / Math.log(1 + Math.max(1, traffic));
    } else if (strategy === 'traffic_weighted') {
      // Mirrors production language mix. Honest about what the student
      // will see; not optimal for per-language K-Score parity.
      w = Math.max(1, traffic);
    } else {
      w = 1.0;
    }
    weights[lang] = w;
    totalWeight += w;
  }

  // Convert weights to per-language sample budgets. Round + clip so the
  // sum doesn't drift above maxN due to fractional rounding.
  const budgets = {};
  let runningBudget = 0;
  for (const lang of targetLangs) {
    const share = totalWeight > 0 ? (weights[lang] / totalWeight) : 0;
    const want = Math.max(0, Math.round(share * maxN));
    budgets[lang] = want;
    runningBudget += want;
  }
  // Trim if rounding pushed us above maxN.
  if (runningBudget > maxN) {
    // Trim from the largest budgets first, deterministically.
    const ordered = Object.entries(budgets)
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1));
    let over = runningBudget - maxN;
    for (const [lang] of ordered) {
      if (over <= 0) break;
      if (budgets[lang] > 0) { budgets[lang] -= 1; over -= 1; }
    }
  }

  // Pull samples per language up to the budget. When a language has FEWER
  // available captures than its budget, we take what's there (no fabrication
  // and no with-replacement bootstrapping - honest finite supply).
  const selectedCids = [];
  const byLangOut = {};
  for (const lang of targetLangs) {
    const want = budgets[lang] || 0;
    if (want <= 0) continue;
    const pool = bucketsByLang.get(lang) || [];
    const take = Math.min(want, pool.length);
    if (take <= 0) continue;
    for (let i = 0; i < take; i++) {
      const cap = pool[i];
      const cid = _safeSampleId(cap.cid || cap.event_id, 'cap_' + selectedCids.length);
      selectedCids.push(cid);
    }
    byLangOut[lang] = take;
  }

  const langsPresent = Object.keys(byLangOut).length;
  const coveragePct = targetLangs.length > 0
    ? Math.round((langsPresent / targetLangs.length) * 10000) / 100
    : 0;

  return {
    ok: true,
    version: LANG_BALANCED_VERSION,
    strategy,
    target_langs: targetLangs,
    by_lang: byLangOut,
    samples: selectedCids,
    total_n: selectedCids.length,
    coverage_pct: coveragePct,
    traffic_by_lang: trafficByLang,
    requested_max_n: maxN,
  };
}

// =============================================================================
// assessLanguageCoverage
//
// Pure shape utility - reports which target languages are present AND
// missing in the capture pool. Used by /v1/xlang/language-coverage and
// the W774 frontend to surface gaps BEFORE the operator runs a balanced
// sample.
//
// Input:
//   opts.captures:     [{...}]
//   opts.target_langs: ISO list (default DEFAULT_TARGET_LANGS)
//   opts.lang_detect:  DI callback (text) => {lang, fallback}
//
// Output:
//   { ok:true, version, by_lang:{en:N, es:N, ...},
//     missing_langs:[<iso>...],   // target_langs with count==0
//     present_langs:[<iso>...],   // target_langs with count>=1
//     coverage_score:0..1,        // present_langs.length / target_langs.length
//   }
//
// Empty captures returns ok:true with coverage_score:0 and ALL target
// langs in missing_langs - NOT a silent ok:true with coverage_score:1.
// (The honesty invariant: empty pool is honestly empty, not "complete".)
// =============================================================================

export async function assessLanguageCoverage(opts) {
  const o = opts || {};
  const captures = Array.isArray(o.captures) ? o.captures.slice(0, LANG_BALANCED_LIMITS.max_capture_rows) : [];
  const targetLangs = _safeTargetLangs(o.target_langs);

  const detectFn = await _resolveDetect(o.lang_detect);

  const byLang = {};
  for (const cap of captures) {
    if (!cap || typeof cap !== 'object') continue;
    const text = cap.input || cap.prompt || cap.output || cap.response || '';
    if (typeof text !== 'string' || text.length === 0) continue;
    const d = detectFn(text) || {};
    const lang = _safeLang(d.lang);
    if (!lang || d.fallback) continue;
    byLang[lang] = (byLang[lang] || 0) + 1;
  }

  const presentLangs = [];
  const missingLangs = [];
  for (const lang of targetLangs) {
    if ((byLang[lang] || 0) >= 1) presentLangs.push(lang);
    else missingLangs.push(lang);
  }

  // Honest envelope on empty captures: coverage_score is 0, not 1.
  const coverageScore = (captures.length === 0 || targetLangs.length === 0)
    ? 0
    : (presentLangs.length / targetLangs.length);

  return {
    ok: true,
    version: LANG_BALANCED_VERSION,
    by_lang: byLang,
    missing_langs: missingLangs,
    present_langs: presentLangs,
    coverage_score: Math.round(coverageScore * 10000) / 10000,
    target_langs: targetLangs,
    captures_total: captures.length,
  };
}

// =============================================================================
// _resolveDetect (private)
//
// Returns a sync (text) => {lang, fallback} callback. Honors the DI seam
// when present; otherwise lazy-imports W760's pure-JS detector.
// =============================================================================

async function _resolveDetect(injected) {
  if (typeof injected === 'function') return injected;
  // Lazy import so unit tests that DI a stub never pay the cost of loading
  // the W760 detector module.
  const { detectLang } = await import('./lang-detect.js');
  return (text) => detectLang(text);
}

export default {
  LANG_BALANCED_VERSION,
  LANG_BALANCED_LIMITS,
  BALANCE_STRATEGIES,
  DEFAULT_TARGET_LANGS,
  sampleBalanced,
  assessLanguageCoverage,
};
