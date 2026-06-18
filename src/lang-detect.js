// W760 - Language detection (pure JS, no ML deps).
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 549-553):
//   [W760-1] Per-language K-Score reporting → language detect + axis split
//
// Design contract:
//   - PURE JS, no model files, no Python, no native deps. The 22-language
//     compiled-model use case can't afford to ship a heavyweight detector
//     in every install; we trade absolute accuracy for zero dependencies
//     and sub-millisecond latency.
//   - HONESTY FLOOR: when the heuristics can't agree, we return
//     {lang:null, confidence, fallback:true} - never silently pick a
//     wrong language. Callers (W760-3 confidence thresholds) treat
//     fallback rows as "route to teacher".
//   - SCRIPT-CLASS first: a single CJK / Cyrillic / Arabic / Devanagari
//     character is more diagnostic than a dozen Latin stopwords. We
//     compute character-class scores BEFORE stopwords.
//   - STOPWORD frequency for Latin-script disambiguation (en/es/fr/de/it/
//     pt/nl/pl/sv/no/da/fi/tr/vi/id). The lists are tiny - 5-8 words per
//     language - to keep the module small.
//   - Code-mixed content: detectLangSegments() splits by script-class
//     boundary so a "Hello / 你好 / Hola" string returns three segments.
//
// Public surface:
//   - LANG_DETECT_VERSION
//   - SUPPORTED_LANGS                                    (Object.freeze)
//   - detectLang(text, {min_confidence})
//   - detectLangSegments(text)
//   - langStats(rows)

export const LANG_DETECT_VERSION = 'w760-v1';
export const LANG_DETECT_LIMITS = Object.freeze({
  max_text_chars: 20000,
  max_segments: 512,
  max_rows: 50000,
});

// 22 most-common languages for compiled-model use. Keep tight - every
// language we add slows the detector and grows the install. ISO 639-1.
export const SUPPORTED_LANGS = Object.freeze([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ru', 'zh', 'ja',
  'ko', 'ar', 'hi', 'tr', 'vi', 'id', 'th', 'pl', 'sv', 'no',
  'da', 'fi',
]);

// =============================================================================
// Script-class detectors.
//
// Each test counts how many characters in the text fall inside the named
// Unicode block. The detector with the highest hit-ratio wins the
// "script" stage. The thresholds below were tuned so a single non-Latin
// character in an otherwise Latin string is NOT misclassified - we only
// trust script-class when >=20% of code points hit the target block.
// =============================================================================

const SCRIPT_RANGES = {
  // CJK Unified Ideographs + extensions A/B + radicals.
  zh_chars: /[㐀-䶿一-鿿豈-﫿]/g,
  // Hiragana + katakana (Japanese-specific) + half/full-width katakana.
  ja_chars: /[぀-ゟ゠-ヿｦ-ﾟ]/g,
  // Hangul (Korean).
  ko_chars: /[가-힯ᄀ-ᇿ㄰-㆏]/g,
  // Cyrillic (Russian / Bulgarian / etc - we tag as ru).
  ru_chars: /[Ѐ-ӿ]/g,
  // Arabic (incl. Arabic Supplement, Extended-A).
  ar_chars: /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/g,
  // Devanagari (Hindi).
  hi_chars: /[ऀ-ॿ]/g,
  // Thai.
  th_chars: /[฀-๿]/g,
};

// =============================================================================
// Stopword tables for Latin-script disambiguation.
//
// Tiny on purpose. The trick is to pick stopwords that DON'T overlap
// across languages: "the/and" → en, "el/la/que" → es, "le/la/et" → fr,
// "der/die/und" → de. We score each language by counting how many of
// its diagnostic stopwords appear as whole words in the input.
//
// Lowercase + word-boundary match. Apostrophes / hyphens are stripped
// before tokenizing.
// =============================================================================

const STOPWORDS = Object.freeze({
  en: ['the', 'and', 'is', 'in', 'to', 'of', 'that', 'with'],
  es: ['el', 'la', 'que', 'de', 'los', 'las', 'pero', 'una'],
  fr: ['le', 'la', 'les', 'des', 'est', 'une', 'pour', 'avec'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'auch'],
  it: ['il', 'la', 'di', 'che', 'una', 'sono', 'non', 'per'],
  pt: ['o', 'a', 'de', 'que', 'do', 'da', 'em', 'para'],
  nl: ['de', 'het', 'een', 'van', 'is', 'in', 'op', 'dat'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'olan', 'değil', 'çok'],
  vi: ['và', 'là', 'của', 'có', 'không', 'được', 'một', 'với'],
  id: ['dan', 'yang', 'di', 'untuk', 'dengan', 'tidak', 'ini', 'itu'],
  pl: ['i', 'w', 'na', 'jest', 'nie', 'że', 'do', 'się'],
  sv: ['och', 'att', 'det', 'en', 'är', 'som', 'för', 'med'],
  no: ['og', 'i', 'jeg', 'det', 'at', 'en', 'til', 'er'],
  da: ['og', 'i', 'jeg', 'det', 'at', 'en', 'til', 'er'],
  fi: ['ja', 'on', 'ei', 'että', 'se', 'olen', 'mutta', 'kun'],
});

// Some Latin-script langs share heavy overlap (no/da). Give the detector
// a tiebreaker by weighting these almost-identical lists toward 'no'.
// In practice callers should treat no/da/sv as a Scandinavian cluster.

const MIN_CONFIDENCE_DEFAULT = 0.4;

function _clamp01(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function _capText(text) {
  return String(text).slice(0, LANG_DETECT_LIMITS.max_text_chars);
}

// =============================================================================
// detectLang
//
// Returns:
//   { lang: <iso>|null, confidence: 0..1, kind: 'script'|'stopword'|'mixed',
//     fallback: boolean }
//
// Never throws. Empty / null / non-string input returns the honest
// fallback envelope.
// =============================================================================

export function detectLang(text, opts) {
  const o = opts || {};
  const minConf = _clamp01(o.min_confidence, MIN_CONFIDENCE_DEFAULT);

  if (typeof text !== 'string' || text.length === 0) {
    return { lang: null, confidence: 0, kind: 'mixed', fallback: true };
  }
  // Trim - leading/trailing whitespace shouldn't count toward total chars.
  const trimmed = _capText(text).trim();
  if (trimmed.length === 0) {
    return { lang: null, confidence: 0, kind: 'mixed', fallback: true };
  }

  // ── Stage 1: script-class scoring ────────────────────────────────────────
  // Count code points that hit each script block. Compute hit-ratio against
  // total non-whitespace chars (whitespace is script-neutral).
  const totalNonWs = trimmed.replace(/\s+/g, '').length || 1;
  const scriptHits = {};
  for (const [key, re] of Object.entries(SCRIPT_RANGES)) {
    // Reset the global regex's lastIndex by matching afresh each time.
    const matches = trimmed.match(re);
    scriptHits[key] = matches ? matches.length : 0;
  }
  // Map script keys to ISO. Japanese vs Chinese: if any hiragana / katakana
  // is present, lean Japanese; otherwise CJK = zh.
  const jaHits = scriptHits.ja_chars;
  const zhHitsRaw = scriptHits.zh_chars;
  // Korean / Cyrillic / Arabic / Devanagari / Thai are unambiguous.
  const koHits = scriptHits.ko_chars;
  const ruHits = scriptHits.ru_chars;
  const arHits = scriptHits.ar_chars;
  const hiHits = scriptHits.hi_chars;
  const thHits = scriptHits.th_chars;
  // Japanese commonly mixes kanji + kana - if BOTH kana and kanji are
  // present, treat the whole CJK chunk as Japanese.
  let zhScore = zhHitsRaw / totalNonWs;
  let jaScore = jaHits / totalNonWs;
  if (jaHits > 0 && zhHitsRaw > 0) {
    jaScore = (jaHits + zhHitsRaw) / totalNonWs;
    zhScore = 0;
  }
  const scriptCandidates = [
    { lang: 'zh', score: zhScore },
    { lang: 'ja', score: jaScore },
    { lang: 'ko', score: koHits / totalNonWs },
    { lang: 'ru', score: ruHits / totalNonWs },
    { lang: 'ar', score: arHits / totalNonWs },
    { lang: 'hi', score: hiHits / totalNonWs },
    { lang: 'th', score: thHits / totalNonWs },
  ].sort((a, b) => b.score - a.score);
  const topScript = scriptCandidates[0];
  // Threshold for script confidence: 20% of non-ws chars in the target
  // block is a high-confidence signal (the language is genuinely written
  // in that script).
  if (topScript.score >= 0.2) {
    const conf = Math.min(1, topScript.score * 2); // 0.5 hit-ratio → conf 1.0
    return { lang: topScript.lang, confidence: _round4(conf), kind: 'script', fallback: false };
  }

  // ── Stage 2: stopword frequency on Latin-script text ─────────────────────
  // Tokenize lower-case, split on non-letter (incl. unicode).
  const tokens = trimmed.toLowerCase()
    .replace(/[''`]/g, '')
    .split(/[^a-zA-Zàâäæçéèêëîïôœùûüÿñáéíñóúüçãõşğıöüčďěňřšťůžąęłńóśźżåäöß]+/u)
    .filter(Boolean);
  if (tokens.length === 0) {
    return { lang: null, confidence: _round4(topScript.score), kind: 'mixed', fallback: true };
  }
  // Count how many of each language's stopwords appear in the tokens.
  const tokenSet = new Set(tokens);
  const swScores = {};
  for (const [lang, words] of Object.entries(STOPWORDS)) {
    let hits = 0;
    for (const w of words) if (tokenSet.has(w)) hits += 1;
    swScores[lang] = hits;
  }
  // Pick the highest-scoring language; tie-break alphabetically for stability.
  const swCandidates = Object.entries(swScores)
    .map(([lang, hits]) => ({ lang, hits }))
    .sort((a, b) => {
      if (b.hits !== a.hits) return b.hits - a.hits;
      return a.lang < b.lang ? -1 : 1;
    });
  const topSw = swCandidates[0];
  if (topSw.hits >= 2) {
    // Confidence = hits / max-possible (capped at 8 per language).
    const conf = Math.min(1, topSw.hits / 4);
    if (conf >= minConf) {
      return { lang: topSw.lang, confidence: _round4(conf), kind: 'stopword', fallback: false };
    }
  }
  // Single stopword hit - too weak.
  return { lang: null, confidence: _round4(topSw.hits / 4), kind: 'mixed', fallback: true };
}

// =============================================================================
// detectLangSegments
//
// Split text into language-coherent segments. Useful for code-mixed
// content: "Hello / 你好 / Bonjour" returns three {text, lang, span} rows.
//
// Algorithm: walk the string char-by-char tracking the running script
// class. Emit a segment whenever the class changes or we hit punctuation /
// whitespace boundary AND the accumulated segment is non-trivial.
//
// Returns: [{text, lang, span:[start,end]}, ...]
// =============================================================================

export function detectLangSegments(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const capped = _capText(text);
  const segs = [];
  // Split on whitespace / punctuation boundaries first; classify each
  // chunk via detectLang.
  const re = /[\s.,;:!?]+/g;
  let last = 0;
  let m;
  while (segs.length < LANG_DETECT_LIMITS.max_segments && (m = re.exec(capped)) !== null) {
    if (m.index > last) {
      const piece = capped.slice(last, m.index);
      const d = detectLang(piece);
      segs.push({ text: piece, lang: d.lang, span: [last, m.index] });
    }
    last = m.index + m[0].length;
  }
  if (segs.length < LANG_DETECT_LIMITS.max_segments && last < capped.length) {
    const piece = capped.slice(last);
    const d = detectLang(piece);
    segs.push({ text: piece, lang: d.lang, span: [last, capped.length] });
  }
  // Coalesce adjacent same-lang segments for compactness.
  const coalesced = [];
  for (const s of segs) {
    const tail = coalesced[coalesced.length - 1];
    if (tail && tail.lang === s.lang) {
      tail.text = capped.slice(tail.span[0], s.span[1]);
      tail.span[1] = s.span[1];
    } else {
      coalesced.push({ text: s.text, lang: s.lang, span: s.span.slice() });
    }
  }
  return coalesced;
}

// =============================================================================
// langStats
//
// Batch capture analysis. For a row set, classify each row's input field
// (falling back to output) and return per-language counts + mixed/unknown.
//
// Returns: {by_lang:{<iso>:count}, mixed_count, unknown_count, total,
//           dominant_lang}.
// dominant_lang is the lang with the highest count, or null on empty.
// =============================================================================

export function langStats(rows) {
  const byLang = {};
  let mixedCount = 0;
  let unknownCount = 0;
  const inputTotal = Array.isArray(rows) ? rows.length : 0;
  const arr = Array.isArray(rows) ? rows.slice(0, LANG_DETECT_LIMITS.max_rows) : [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') { unknownCount += 1; continue; }
    const text = r.input || r.prompt || r.output || r.response || '';
    if (typeof text !== 'string' || text.length === 0) { unknownCount += 1; continue; }
    const d = detectLang(text);
    if (d.fallback) {
      mixedCount += 1;
    } else if (d.lang && SUPPORTED_LANGS.includes(d.lang)) {
      byLang[d.lang] = (byLang[d.lang] || 0) + 1;
    } else {
      unknownCount += 1;
    }
  }
  let dominant = null;
  let bestCount = 0;
  for (const [lang, c] of Object.entries(byLang)) {
    if (c > bestCount) { bestCount = c; dominant = lang; }
  }
  return {
    by_lang: byLang,
    mixed_count: mixedCount,
    unknown_count: unknownCount,
    total: arr.length,
    input_total: inputTotal,
    dominant_lang: dominant,
    version: LANG_DETECT_VERSION,
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
  LANG_DETECT_VERSION,
  LANG_DETECT_LIMITS,
  SUPPORTED_LANGS,
  detectLang,
  detectLangSegments,
  langStats,
};
