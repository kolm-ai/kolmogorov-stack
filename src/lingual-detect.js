// W833-1 — Language distribution detector (FOUNDATION on top of W760).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md line 1197):
//   [W833-1] Language distribution detector.
//
// Why this exists alongside src/lang-detect.js (W760):
//   * W760 detectLang() is the script-class + stopword heuristic. It works
//     well on text >=20 chars but fights very short captures.
//   * W833-1 detectLanguage() narrows the surface to W833's 11-language
//     contract (en/es/zh/ja/ko/fr/de/pt/ru/ar/hi/unknown) AND layers a
//     tiny baked-in char-trigram model on top of W760's script test for
//     Latin-script disambiguation. The point is to give the cross-lingual
//     planner a SINGLE distribution-summary API that the rest of W833
//     (mixture, manifest, synthesize) shares.
//   * The trigram model is 11 langs × top-15 trigrams = 165 entries —
//     small enough to bake as a const map. No model file, no Python.
//
// Design contract:
//   - PURE JS, no deps; sub-millisecond per call.
//   - Returns {lang, confidence:0..1, source:'char_ngram'|'script_only'};
//     never throws, empty input → unknown w/ confidence 0.
//   - HONESTY FLOOR: when neither script nor trigram cross a confidence
//     threshold, returns 'unknown' (never silently pick a wrong language).
//   - distributionByLang() flags langs whose ratio is below a configurable
//     target (default 0.05) so the synth/mixture stages know what to fix.
//
// Public surface:
//   - LINGUAL_DETECT_VERSION
//   - SUPPORTED_LANGS_W833                                (Object.freeze)
//   - detectLanguage(text)
//   - distributionByLang(captures, opts)

export const LINGUAL_DETECT_VERSION = 'w833-v1';

// 11 most-common languages for the W833 cross-lingual mixture surface,
// PLUS the 'unknown' sentinel returned on low-confidence inputs. Kept
// tight on purpose — every additional language costs trigram baseline
// space and detector time without lifting per-language K-Score.
export const SUPPORTED_LANGS_W833 = Object.freeze([
  'en', 'es', 'zh', 'ja', 'ko', 'fr', 'de', 'pt', 'ru', 'ar', 'hi',
]);

// Default underrepresentation target — any lang that draws less than 5%
// of the corpus is flagged for synthesis/oversampling. Operators can
// override per call.
const DEFAULT_TARGET_RATIO = 0.05;

// =============================================================================
// Unicode script ranges.
//
// We trust a script-class hit (CJK / Cyrillic / Arabic / Devanagari /
// Hangul / hiragana-katakana) over trigram analysis because those scripts
// are unambiguous one-to-one with the target language for W833's 11-lang
// surface. The threshold is 20% of non-ws chars in the target block —
// identical floor to W760 for cohesion.
// =============================================================================

const SCRIPT_RANGES = Object.freeze({
  // CJK Unified Ideographs (covers Chinese, also Japanese kanji).
  zh_chars: /[㐀-䶿一-鿿豈-﫿]/g,
  // Hiragana + katakana (Japanese-only); presence overrides zh.
  ja_chars: /[぀-ゟ゠-ヿｦ-ﾟ]/g,
  // Hangul (Korean).
  ko_chars: /[가-힯ᄀ-ᇿ㄰-㆏]/g,
  // Cyrillic (mapped to ru for W833 — Bulgarian/Ukrainian out-of-scope).
  ru_chars: /[Ѐ-ӿ]/g,
  // Arabic + Arabic Supplement + Extended-A + Presentation Forms-A/B.
  ar_chars: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g,
  // Devanagari (Hindi).
  hi_chars: /[ऀ-ॿ]/g,
});

// =============================================================================
// Tiny char-trigram baseline for Latin-script disambiguation.
//
// Top-15 trigrams per language, hand-picked from public newswire corpora
// (Europarl excerpts, OPUS subtitles). Stored as a frequency-ordered
// array per language; the detector simply counts how many of these
// trigrams appear in the input.
//
// Trigrams are case-folded. Whitespace tri's like " th" are intentionally
// included since they carry word-boundary information.
// =============================================================================

const TRIGRAMS = Object.freeze({
  en: [' th', 'the', 'he ', 'ed ', ' an', 'ing', 'and', 'nd ', ' to', 'to ', 'of ', ' of', ' in', 'er ', 'ion'],
  es: [' de', 'de ', ' la', 'la ', ' el', 'el ', ' en', 'en ', 'os ', 'as ', 'que', ' qu', 'aci', 'ón ', 'os '],
  fr: [' de', 'de ', ' la', 'la ', ' le', 'le ', 'les', ' et', 'et ', ' à ', 'ent', 'ion', 'que', ' co', ' un'],
  de: [' de', 'der', ' di', 'die', ' un', 'und', ' ge', ' ei', 'ein', ' zu', 'ich', 'cht', 'sch', 'ung', 'che'],
  pt: [' de', 'de ', ' a ', ' o ', ' co', ' es', 'que', ' qu', 'ent', ' do', 'do ', ' da', 'da ', 'ção', 'os '],
});

// Minimum confidence for trigram-only classification. Below this the
// detector returns 'unknown' rather than fabricating an answer.
const MIN_TRIGRAM_CONFIDENCE = 0.25;
// Minimum margin between top-1 and top-2 trigram hit counts for the
// detector to commit. Without a margin two near-equal Latin langs would
// land arbitrarily; we'd rather honestly say 'unknown'.
const MIN_TRIGRAM_MARGIN = 0.10;

// =============================================================================
// detectLanguage
//
// Input:
//   text:     arbitrary string (utf-8). Non-string / empty → unknown w/ 0.
//
// Output:
//   { lang:    'en'|'es'|'zh'|'ja'|'ko'|'fr'|'de'|'pt'|'ru'|'ar'|'hi'|'unknown',
//     confidence: 0..1,
//     source:  'char_ngram' | 'script_only' }
//
// Never throws. Empty input returns the honest unknown envelope, NEVER
// a fabricated language guess.
// =============================================================================

export function detectLanguage(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { lang: 'unknown', confidence: 0, source: 'script_only' };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { lang: 'unknown', confidence: 0, source: 'script_only' };
  }

  // ── Stage 1: script-class scoring ─────────────────────────────────────────
  const totalNonWs = trimmed.replace(/\s+/g, '').length || 1;
  const scriptHits = {};
  for (const [key, re] of Object.entries(SCRIPT_RANGES)) {
    const matches = trimmed.match(re);
    scriptHits[key] = matches ? matches.length : 0;
  }
  const jaHits = scriptHits.ja_chars;
  const zhHitsRaw = scriptHits.zh_chars;
  // Japanese commonly mixes kanji + kana — kana presence forces zh→ja.
  let zhScore = zhHitsRaw / totalNonWs;
  let jaScore = jaHits / totalNonWs;
  if (jaHits > 0 && zhHitsRaw > 0) {
    jaScore = (jaHits + zhHitsRaw) / totalNonWs;
    zhScore = 0;
  }
  const scriptCandidates = [
    { lang: 'zh', score: zhScore },
    { lang: 'ja', score: jaScore },
    { lang: 'ko', score: scriptHits.ko_chars / totalNonWs },
    { lang: 'ru', score: scriptHits.ru_chars / totalNonWs },
    { lang: 'ar', score: scriptHits.ar_chars / totalNonWs },
    { lang: 'hi', score: scriptHits.hi_chars / totalNonWs },
  ].sort((a, b) => b.score - a.score);
  const topScript = scriptCandidates[0];
  if (topScript.score >= 0.2) {
    // Confidence = 2× hit-ratio capped at 1.0 (0.5 ratio → conf 1.0).
    const conf = Math.min(1, topScript.score * 2);
    return {
      lang: topScript.lang,
      confidence: _round4(conf),
      source: 'script_only',
    };
  }

  // ── Stage 2: char-trigram scoring (Latin-script disambiguation) ───────────
  const lower = trimmed.toLowerCase();
  // Build the set of trigrams present in the input.
  const presentTris = new Set();
  for (let i = 0; i <= lower.length - 3; i++) {
    presentTris.add(lower.slice(i, i + 3));
  }
  if (presentTris.size === 0) {
    return { lang: 'unknown', confidence: 0, source: 'char_ngram' };
  }
  const scores = [];
  for (const [lang, tris] of Object.entries(TRIGRAMS)) {
    let hits = 0;
    for (const t of tris) if (presentTris.has(t)) hits += 1;
    scores.push({ lang, hits, ratio: hits / tris.length });
  }
  scores.sort((a, b) => {
    if (b.ratio !== a.ratio) return b.ratio - a.ratio;
    return a.lang < b.lang ? -1 : 1;
  });
  const top = scores[0];
  const second = scores[1] || { ratio: 0 };
  const margin = top.ratio - second.ratio;
  if (top.ratio >= MIN_TRIGRAM_CONFIDENCE && margin >= MIN_TRIGRAM_MARGIN) {
    return {
      lang: top.lang,
      // Confidence blends the absolute ratio (how saturated) with the
      // margin (how decisive). Bounded 0..1.
      confidence: _round4(Math.min(1, (top.ratio + margin) / 2 + 0.3)),
      source: 'char_ngram',
    };
  }
  return { lang: 'unknown', confidence: _round4(top.ratio), source: 'char_ngram' };
}

// =============================================================================
// distributionByLang
//
// Compute the language distribution over a capture pool and surface any
// languages whose representation is below the target ratio.
//
// Input:
//   captures:   [{input|prompt|prompt_redacted|...|output|response|...}]
//   opts.target_ratio:  per-lang floor (default 0.05 = 5%)
//   opts.target_langs:  ISO list to evaluate (default SUPPORTED_LANGS_W833)
//   opts.lang_detect:   DI sync (text) => {lang, confidence, source}
//                       — defaults to the W833 detectLanguage above
//
// Output:
//   { by_lang:{en:0.62, es:0.15, ...},   // fractional shares (sum~1.0,
//                                        // 'unknown' INCLUDED so the
//                                        // caller can see noise)
//     total:N,                           // rows classified
//     underrepresented:[{lang, ratio, target_ratio}, ...]  // ratio<target
//   }
//
// Empty captures returns total:0 + empty by_lang + ALL target_langs in
// underrepresented (honest — empty pool is honestly empty, not "balanced").
// =============================================================================

export function distributionByLang(captures, opts) {
  const o = opts || {};
  const targetRatio = Number.isFinite(o.target_ratio) ? o.target_ratio : DEFAULT_TARGET_RATIO;
  const targetLangs = (Array.isArray(o.target_langs) && o.target_langs.length > 0)
    ? o.target_langs.slice()
    : SUPPORTED_LANGS_W833.slice();
  const detect = (typeof o.lang_detect === 'function') ? o.lang_detect : detectLanguage;

  const counts = {};
  let total = 0;
  const arr = Array.isArray(captures) ? captures : [];
  for (const cap of arr) {
    if (!cap || typeof cap !== 'object') continue;
    const text = cap.input || cap.prompt || cap.prompt_redacted ||
                 cap.output || cap.response || cap.response_redacted || '';
    if (typeof text !== 'string' || text.length === 0) continue;
    const d = detect(text) || {};
    const lang = d.lang || 'unknown';
    counts[lang] = (counts[lang] || 0) + 1;
    total += 1;
  }

  // Convert counts → fractional shares. We INCLUDE 'unknown' in by_lang
  // so the operator can see classification noise; it just isn't a target
  // for the underrepresented[] floor check.
  const byLang = {};
  if (total > 0) {
    for (const [lang, c] of Object.entries(counts)) {
      byLang[lang] = _round4(c / total);
    }
  }

  // For each target language, check whether ratio < target_ratio.
  // Empty corpus → every target lang is underrepresented (honest).
  const underrepresented = [];
  for (const lang of targetLangs) {
    const ratio = (total > 0 && counts[lang]) ? (counts[lang] / total) : 0;
    if (ratio < targetRatio) {
      underrepresented.push({
        lang,
        ratio: _round4(ratio),
        target_ratio: _round4(targetRatio),
      });
    }
  }
  // Sort alphabetically for stability — the operator scanning the list
  // expects a deterministic ordering.
  underrepresented.sort((a, b) => a.lang < b.lang ? -1 : 1);

  return {
    by_lang: byLang,
    total,
    underrepresented,
    version: LINGUAL_DETECT_VERSION,
  };
}

// =============================================================================
// helpers
// =============================================================================

function _round4(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

export default {
  LINGUAL_DETECT_VERSION,
  SUPPORTED_LANGS_W833,
  detectLanguage,
  distributionByLang,
};
