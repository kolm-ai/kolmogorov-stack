// W760 — Per-Language K-Score Breakdown.
//
// Atomic items pinned (matches the W760 implementation):
//
//   1)  LANG_DETECT_VERSION + KSCORE_PER_LANG_VERSION + MULTI_AUGMENT_VERSION
//       all stamped 'w760-v1'
//   2)  SUPPORTED_LANGS is Object.freeze()-d + carries exactly 22 ISO codes
//   3)  detectLang: English happy path → kind 'stopword', fallback:false
//   4)  detectLang: Spanish happy path → lang 'es'
//   5)  detectLang: Chinese script-class → lang 'zh', kind 'script'
//   6)  detectLang: Arabic script-class → lang 'ar', kind 'script'
//   7)  detectLang: empty / non-string → honest envelope (lang:null, fallback:true)
//   8)  detectLang: ambiguous tiny input → fallback:true (never silently picks)
//   9)  detectLangSegments: code-mixed string splits across script boundaries
//   10) langStats: batch aggregation reports by_lang counts + dominant_lang
//   11) perLanguageKScore: empty rows → insufficient_per_lang_samples envelope
//   12) perLanguageKScore: <30 per lang → null point estimate + null Wilson band
//   13) perLanguageKScore: ≥30 per lang → returns k_score, k_axes, wilson_ci_lo,
//       wilson_ci_hi
//   14) perLanguageConfidenceThreshold: weak language gets a LOWER threshold
//       (and a strong language gets a HIGHER one, clamped [0.5,1.5])
//   15) perLanguageConfidenceThreshold: missing lang → honest envelope
//   16) identifyUnderrepresentedLangs: surfaces langs below min_per_lang
//   17) requestMultilingualAugmentation: dry_run=true returns plan w/ cost est
//   18) requestMultilingualAugmentation: dry_run=false WITHOUT teacher_caller →
//       no_translator_configured honest envelope
//   19) requestMultilingualAugmentation: dry_run=false WITH DI teacher_caller →
//       augmented rows carry source_type:'synthetic' + synthetic_kind:'translation'
//   20) mergeAugmentedRows: returns NEW array (never mutates), each new row
//       carries source_type:'synthetic' + feedback JSON blob
//   21) POST /v1/lang/detect: 401 without auth; 200 ok envelope w/ auth
//   22) GET /v1/lang/kscore-by-lang/:namespace: 401 without auth;
//       returns insufficient envelope when no rows seeded
//   23) POST /v1/lang/augment-multilingual: WITHOUT confirm → dry_run plan;
//       WITH confirm + no DI translator → no_translator_configured envelope
//   24) public/docs/multilingual.html exists w/ brand-lock + data-w760 anchors
//   25) cli/kolm.js defines cmdW760Lang exactly once + wired from case 'lang'
//   26) vercel.json has /docs/multilingual rewrite
//   27) wave760 sibling test count uses wave(\d{3,4}) regex + threshold (W604)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  LANG_DETECT_VERSION,
  SUPPORTED_LANGS,
  detectLang,
  detectLangSegments,
  langStats,
} from '../src/lang-detect.js';

import {
  KSCORE_PER_LANG_VERSION,
  perLanguageKScore,
  perLanguageConfidenceThreshold,
} from '../src/kscore-per-language.js';

import {
  MULTI_AUGMENT_VERSION,
  identifyUnderrepresentedLangs,
  requestMultilingualAugmentation,
  mergeAugmentedRows,
} from '../src/multilingual-augment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multilingual.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w760-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W760 #1 — LANG_DETECT + KSCORE_PER_LANG + MULTI_AUGMENT all stamped w760-v1', () => {
  freshDir();
  assert.equal(LANG_DETECT_VERSION, 'w760-v1',
    `expected LANG_DETECT_VERSION='w760-v1'; got ${JSON.stringify(LANG_DETECT_VERSION)}`);
  assert.equal(KSCORE_PER_LANG_VERSION, 'w760-v1',
    `expected KSCORE_PER_LANG_VERSION='w760-v1'; got ${JSON.stringify(KSCORE_PER_LANG_VERSION)}`);
  assert.equal(MULTI_AUGMENT_VERSION, 'w760-v1',
    `expected MULTI_AUGMENT_VERSION='w760-v1'; got ${JSON.stringify(MULTI_AUGMENT_VERSION)}`);
});

// =============================================================================
// 2) SUPPORTED_LANGS frozen + 22 entries
// =============================================================================

test('W760 #2 — SUPPORTED_LANGS is Object.freeze()-d + holds exactly 22 ISO codes', () => {
  freshDir();
  assert.ok(Array.isArray(SUPPORTED_LANGS), 'SUPPORTED_LANGS must be an array');
  assert.ok(Object.isFrozen(SUPPORTED_LANGS),
    'SUPPORTED_LANGS MUST be Object.freeze()-d so callers cannot mutate the contract');
  assert.equal(SUPPORTED_LANGS.length, 22,
    `expected 22 languages; got ${SUPPORTED_LANGS.length}: ${JSON.stringify(SUPPORTED_LANGS)}`);
  // Spot-check a few load-bearing codes the rest of the suite uses.
  for (const code of ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ar']) {
    assert.ok(SUPPORTED_LANGS.includes(code),
      `SUPPORTED_LANGS must include '${code}'; got ${JSON.stringify(SUPPORTED_LANGS)}`);
  }
});

// =============================================================================
// 3) detectLang English happy path
// =============================================================================

test('W760 #3 — detectLang English happy path returns lang=en, kind=stopword', () => {
  freshDir();
  const d = detectLang('The customer is in the queue with a refund request and the agent is helping');
  assert.equal(d.lang, 'en', `expected lang='en'; got ${JSON.stringify(d)}`);
  assert.equal(d.fallback, false, `English text must NOT fall back; got ${JSON.stringify(d)}`);
  assert.equal(d.kind, 'stopword',
    `Latin-script detection should fire on the stopword stage; got ${JSON.stringify(d)}`);
  assert.ok(d.confidence >= 0.4, `expected confidence >=0.4; got ${d.confidence}`);
});

// =============================================================================
// 4) detectLang Spanish happy path
// =============================================================================

test('W760 #4 — detectLang Spanish happy path returns lang=es', () => {
  freshDir();
  const d = detectLang('El cliente quiere una devolución de los productos que pidió pero la tienda no responde');
  assert.equal(d.lang, 'es', `expected lang='es'; got ${JSON.stringify(d)}`);
  assert.equal(d.fallback, false, `Spanish text must NOT fall back; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 5) detectLang Chinese (script-class)
// =============================================================================

test('W760 #5 — detectLang Chinese script-class returns lang=zh, kind=script', () => {
  freshDir();
  const d = detectLang('你好世界这是一个简单的中文测试句子');
  assert.equal(d.lang, 'zh', `expected lang='zh'; got ${JSON.stringify(d)}`);
  assert.equal(d.kind, 'script',
    `CJK ideographs must trigger the script-class stage; got ${JSON.stringify(d)}`);
  assert.equal(d.fallback, false);
});

// =============================================================================
// 6) detectLang Arabic (script-class)
// =============================================================================

test('W760 #6 — detectLang Arabic script-class returns lang=ar, kind=script', () => {
  freshDir();
  const d = detectLang('مرحبا بالعالم هذا اختبار بسيط للغة العربية');
  assert.equal(d.lang, 'ar', `expected lang='ar'; got ${JSON.stringify(d)}`);
  assert.equal(d.kind, 'script',
    `Arabic block must trigger the script-class stage; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 7) detectLang empty / non-string → honest envelope
// =============================================================================

test('W760 #7 — detectLang empty + non-string return honest fallback envelopes', () => {
  freshDir();
  const empty = detectLang('');
  assert.equal(empty.lang, null, 'empty string must return lang=null (no silent guess)');
  assert.equal(empty.fallback, true);

  const whitespace = detectLang('   \n\t   ');
  assert.equal(whitespace.lang, null,
    `whitespace-only string must fallback; got ${JSON.stringify(whitespace)}`);
  assert.equal(whitespace.fallback, true);

  const nullish = detectLang(null);
  assert.equal(nullish.lang, null);
  assert.equal(nullish.fallback, true);

  const numeric = detectLang(42);
  assert.equal(numeric.lang, null);
  assert.equal(numeric.fallback, true);
});

// =============================================================================
// 8) detectLang ambiguous tiny input → fallback:true
// =============================================================================

test('W760 #8 — detectLang ambiguous tiny text falls back rather than guessing', () => {
  freshDir();
  // Single Latin token with no stopwords — too ambiguous to attribute.
  const d = detectLang('xyzzy');
  assert.equal(d.fallback, true,
    `ambiguous single token must fallback; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 9) detectLangSegments: code-mixed splits across script boundaries
// =============================================================================

test('W760 #9 — detectLangSegments splits code-mixed text by script boundary', () => {
  freshDir();
  const segs = detectLangSegments('Hello world. 你好世界. مرحبا.');
  assert.ok(Array.isArray(segs) && segs.length >= 2,
    `expected multiple segments; got ${JSON.stringify(segs)}`);
  const langs = segs.map((s) => s.lang).filter(Boolean);
  // We expect both zh AND ar to show up (the English fragment is short
  // enough to fall back, but the CJK and Arabic must classify).
  assert.ok(langs.includes('zh'),
    `expected Chinese segment in result; got langs=${JSON.stringify(langs)}`);
  assert.ok(langs.includes('ar'),
    `expected Arabic segment in result; got langs=${JSON.stringify(langs)}`);
});

// =============================================================================
// 10) langStats: batch aggregation
// =============================================================================

test('W760 #10 — langStats over a batch returns by_lang counts + dominant_lang', () => {
  freshDir();
  const rows = [
    { input: 'The customer is asking about the refund request and the queue' },
    { input: 'The agent replied with the policy and the documentation' },
    { input: 'El cliente quiere una devolución de los productos que compró' },
    { input: '你好世界这是一个简单的中文测试句子' },
    { input: '' }, // unknown
  ];
  const stats = langStats(rows);
  assert.equal(stats.total, 5);
  assert.equal(stats.version, LANG_DETECT_VERSION);
  assert.ok(stats.by_lang.en >= 1, `expected at least 1 English row; got ${JSON.stringify(stats)}`);
  assert.equal(stats.by_lang.es, 1, `expected 1 Spanish row; got ${JSON.stringify(stats)}`);
  assert.equal(stats.by_lang.zh, 1, `expected 1 Chinese row; got ${JSON.stringify(stats)}`);
  assert.equal(stats.unknown_count + stats.mixed_count, 1,
    `empty row should land in unknown OR mixed bucket; got stats=${JSON.stringify(stats)}`);
  assert.equal(stats.dominant_lang, 'en');
});

// =============================================================================
// 11) perLanguageKScore: insufficient envelope
// =============================================================================

test('W760 #11 — perLanguageKScore returns insufficient_per_lang_samples on empty', () => {
  freshDir();
  const r = perLanguageKScore({ rows: [] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'insufficient_per_lang_samples',
    `empty corpus must return insufficient envelope; got ${JSON.stringify(r)}`);
  assert.equal(r.version, KSCORE_PER_LANG_VERSION);
  assert.ok(r.hint && /synthetic|W760-2|W760/.test(r.hint),
    `hint must point at W760-2 augmentation; got hint=${JSON.stringify(r.hint)}`);
});

// =============================================================================
// 12) perLanguageKScore: <30 rows per lang → null point estimate, null CI
// =============================================================================

test('W760 #12 — perLanguageKScore null k_score + null Wilson CI when n<30 per lang', () => {
  freshDir();
  // 29 English rows is just under the Wilson floor for that language even
  // though the pooled total is ≥30 when we add another language.
  const rows = [];
  for (let i = 0; i < 29; i++) {
    rows.push({ input: 'The customer is in the queue with a refund and the agent is helping ' + i, k_score: 0.8 });
  }
  // Add 1 Spanish row to push pool >=30 but keep en bucket <30.
  for (let i = 0; i < 31; i++) {
    rows.push({ input: 'El cliente quiere una devolución de los productos comprados ' + i, k_score: 0.5 });
  }
  const r = perLanguageKScore({ rows });
  assert.equal(r.ok, true, `expected ok envelope; got ${JSON.stringify(r)}`);
  assert.ok(r.by_lang, 'by_lang block must be present');
  // English has 29 rows — under the floor.
  if (r.by_lang.en) {
    assert.equal(r.by_lang.en.k_score, null,
      `n<30 English must report k_score=null; got ${JSON.stringify(r.by_lang.en)}`);
    assert.equal(r.by_lang.en.wilson_ci_lo, null,
      `n<30 must report wilson_ci_lo=null; got ${JSON.stringify(r.by_lang.en)}`);
    assert.equal(r.by_lang.en.floor_hit, true,
      `floor_hit must be true for n<30 buckets`);
  }
  // Spanish has 31 rows — should pass.
  assert.ok(r.by_lang.es,
    `expected es bucket present; got by_lang=${JSON.stringify(r.by_lang)}`);
  assert.equal(r.by_lang.es.n, 31);
  assert.ok(Number.isFinite(r.by_lang.es.k_score),
    `es bucket should have a finite k_score; got ${JSON.stringify(r.by_lang.es)}`);
});

// =============================================================================
// 13) perLanguageKScore: ≥30 per lang → full block
// =============================================================================

test('W760 #13 — perLanguageKScore returns full block (k_score, k_axes, wilson) when seeded', () => {
  freshDir();
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({ input: 'The customer is in the queue with a refund request ' + i, k_score: 0.82 });
  }
  for (let i = 0; i < 40; i++) {
    rows.push({ input: 'El cliente quiere una devolución de los productos ' + i, k_score: 0.55 });
  }
  const r = perLanguageKScore({ rows });
  assert.equal(r.ok, true);
  assert.ok(r.by_lang.en, 'en bucket present');
  assert.ok(r.by_lang.es, 'es bucket present');
  assert.equal(r.by_lang.en.n, 40);
  assert.equal(r.by_lang.es.n, 40);
  assert.ok(Number.isFinite(r.by_lang.en.k_score));
  assert.ok(Number.isFinite(r.by_lang.es.k_score));
  // Wilson CI must be populated when n>=30.
  assert.ok(Number.isFinite(r.by_lang.en.wilson_ci_lo),
    `expected finite wilson_ci_lo; got ${JSON.stringify(r.by_lang.en)}`);
  assert.ok(Number.isFinite(r.by_lang.en.wilson_ci_hi));
  assert.ok(r.by_lang.en.wilson_ci_lo <= r.by_lang.en.k_score,
    `wilson_ci_lo must be <= point estimate; got ${JSON.stringify(r.by_lang.en)}`);
  assert.ok(r.by_lang.en.wilson_ci_hi >= r.by_lang.en.k_score,
    `wilson_ci_hi must be >= point estimate; got ${JSON.stringify(r.by_lang.en)}`);
  // Pooled block also populated.
  assert.ok(r.pooled);
  assert.ok(Number.isFinite(r.pooled.k_score));
});

// =============================================================================
// 14) perLanguageConfidenceThreshold: weak lang → lower threshold
// =============================================================================

test('W760 #14 — perLanguageConfidenceThreshold scales threshold by k_lang/k_pooled', () => {
  freshDir();
  const byLangKscore = {
    by_lang: {
      en: { k_score: 0.91 },
      es: { k_score: 0.42 },
    },
    pooled: { k_score: 0.85 },
  };
  const strong = perLanguageConfidenceThreshold({
    lang: 'en',
    by_lang_kscore: byLangKscore,
    default_threshold: 0.7,
  });
  const weak = perLanguageConfidenceThreshold({
    lang: 'es',
    by_lang_kscore: byLangKscore,
    default_threshold: 0.7,
  });
  assert.equal(strong.ok, true);
  assert.equal(weak.ok, true);
  // Strong language gets a HIGHER threshold (above default).
  assert.ok(strong.threshold > 0.7,
    `strong language must have threshold > 0.7; got ${JSON.stringify(strong)}`);
  // Weak language gets a LOWER threshold (below default) — clamped to 0.5 ratio.
  assert.ok(weak.threshold < 0.7,
    `weak language must have threshold < 0.7; got ${JSON.stringify(weak)}`);
  // Clamped at 0.5 ratio → 0.42/0.85 = 0.494 clamps to 0.5 → 0.7*0.5 = 0.35.
  assert.equal(weak.clamped_ratio, 0.5,
    `0.42/0.85 should clamp at 0.5 lower bound; got ${JSON.stringify(weak)}`);
});

// =============================================================================
// 15) perLanguageConfidenceThreshold: missing lang → honest envelope
// =============================================================================

test('W760 #15 — perLanguageConfidenceThreshold honest envelopes', () => {
  freshDir();
  // Missing lang.
  const noLang = perLanguageConfidenceThreshold({
    by_lang_kscore: { by_lang: {}, pooled: { k_score: 0.8 } },
    default_threshold: 0.7,
  });
  assert.equal(noLang.ok, false);
  assert.equal(noLang.error, 'lang_required');

  // Missing byLangKscore.
  const noData = perLanguageConfidenceThreshold({ lang: 'es', default_threshold: 0.7 });
  assert.equal(noData.ok, false);
  assert.equal(noData.error, 'no_per_lang_kscore');

  // Lang not present in by_lang.
  const noLangData = perLanguageConfidenceThreshold({
    lang: 'es',
    by_lang_kscore: { by_lang: { en: { k_score: 0.9 } }, pooled: { k_score: 0.9 } },
    default_threshold: 0.7,
  });
  assert.equal(noLangData.ok, false);
  assert.equal(noLangData.error, 'no_data_for_lang');
});

// =============================================================================
// 16) identifyUnderrepresentedLangs: surfaces langs below min_per_lang
// =============================================================================

test('W760 #16 — identifyUnderrepresentedLangs surfaces langs below min_per_lang', () => {
  freshDir();
  // 100 English + 3 Spanish → es is way under any reasonable floor.
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ input: 'The customer is in the queue with a refund request ' + i });
  }
  for (let i = 0; i < 3; i++) {
    rows.push({ input: 'El cliente quiere una devolución de los productos ' + i });
  }
  const r = identifyUnderrepresentedLangs({ rows, min_per_lang: 50 });
  assert.equal(r.ok, true);
  assert.equal(r.version, MULTI_AUGMENT_VERSION);
  assert.equal(r.min_per_lang, 50);
  assert.ok(Array.isArray(r.underrepresented));
  const langs = r.underrepresented.map((u) => u.lang);
  assert.ok(langs.includes('es'),
    `expected Spanish in underrepresented list; got ${JSON.stringify(langs)}`);
  // English has 100 rows — should NOT be underrepresented.
  assert.ok(!langs.includes('en'),
    `English at 100 must NOT be underrepresented; got ${JSON.stringify(langs)}`);
  // The es entry should report current_count=3, needed=47.
  const esEntry = r.underrepresented.find((u) => u.lang === 'es');
  assert.equal(esEntry.current_count, 3);
  assert.equal(esEntry.needed, 47);
});

// =============================================================================
// 17) requestMultilingualAugmentation: dry_run=true returns plan
// =============================================================================

test('W760 #17 — requestMultilingualAugmentation dry_run=true returns plan + cost est', async () => {
  freshDir();
  const sourceRows = [
    { input: 'Customer wants a refund', output: 'OK, processed' },
    { input: 'How do I cancel my order', output: 'Click the cancel button' },
  ];
  const r = await requestMultilingualAugmentation({
    source_rows: sourceRows,
    target_langs: ['es', 'fr', 'de'],
    dry_run: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.dry_run, true);
  assert.equal(r.version, MULTI_AUGMENT_VERSION);
  assert.ok(r.plan && typeof r.plan === 'object', `plan must be present; got ${JSON.stringify(r)}`);
  assert.equal(r.plan.n_rows, 2);
  assert.equal(r.plan.n_targets, 3);
  assert.equal(r.plan.n_estimated_calls, 6,
    `2 rows × 3 targets = 6 estimated calls; got ${r.plan.n_estimated_calls}`);
  assert.ok(r.plan.estimated_cost_usd > 0,
    `expected positive cost estimate; got ${r.plan.estimated_cost_usd}`);
});

// =============================================================================
// 18) requestMultilingualAugmentation: dry_run=false WITHOUT teacher_caller →
//     no_translator_configured envelope
// =============================================================================

test('W760 #18 — requestMultilingualAugmentation dry_run=false w/o caller → no_translator_configured', async () => {
  freshDir();
  const r = await requestMultilingualAugmentation({
    source_rows: [{ input: 'hi', output: 'hello' }],
    target_langs: ['es'],
    dry_run: false,
    // teacher_caller intentionally omitted.
  });
  assert.equal(r.ok, false,
    `expected ok:false without translator; got ${JSON.stringify(r)}`);
  assert.equal(r.error, 'no_translator_configured',
    `expected error 'no_translator_configured'; got ${JSON.stringify(r)}`);
  assert.ok(r.hint && /translator|KOLM_TRANSLATOR_CMD/.test(r.hint),
    `hint must mention translator config; got ${JSON.stringify(r.hint)}`);
  // Plan must still be returned so the caller can see what would have run.
  assert.ok(r.plan, 'plan must accompany the honest envelope');
});

// =============================================================================
// 19) requestMultilingualAugmentation: DI teacher → source_type:'synthetic' +
//     synthetic_kind:'translation'
// =============================================================================

test('W760 #19 — requestMultilingualAugmentation w/ DI caller stamps synthetic + translation', async () => {
  freshDir();
  // Stub translator returns translated JSON shape.
  const teacher_caller = async ({ input, target_lang }) => JSON.stringify({
    input: '[' + target_lang + '] ' + input,
    output: '[' + target_lang + '] translated output',
  });
  const r = await requestMultilingualAugmentation({
    source_rows: [
      { cid: 'src1', input: 'Customer wants a refund', output: 'OK, processed' },
    ],
    target_langs: ['es', 'fr'],
    teacher_caller,
    dry_run: false,
  });
  assert.equal(r.ok, true, `expected ok envelope; got ${JSON.stringify(r)}`);
  assert.equal(r.dry_run, false);
  assert.ok(Array.isArray(r.augmented));
  assert.ok(r.augmented.length >= 1,
    `expected at least 1 augmented row; got ${JSON.stringify(r.augmented)}`);
  for (const aug of r.augmented) {
    assert.equal(aug.source_type, 'synthetic',
      `every augmented row MUST carry source_type:'synthetic' (W749 canonical enum); ` +
      `got ${JSON.stringify(aug)}`);
    assert.equal(aug.synthetic_kind, 'translation',
      `synthetic_kind MUST be 'translation' for W760-2; got ${JSON.stringify(aug)}`);
    assert.ok(aug.target_lang, 'target_lang must be present');
    assert.ok(aug.generation_id, 'generation_id must be present');
    assert.equal(aug.source_cid, 'src1', 'source_cid must round-trip from source row');
  }
});

// =============================================================================
// 20) mergeAugmentedRows: returns NEW array; carries source_type + feedback
// =============================================================================

test('W760 #20 — mergeAugmentedRows returns NEW array w/ source_type=synthetic + feedback blob', () => {
  freshDir();
  const original = [{ input: 'orig 1', output: 'out 1', cid: 'orig1' }];
  const augmented = [
    {
      input: 'es input',
      output: 'es output',
      target_lang: 'es',
      source_lang: 'en',
      source_cid: 'orig1',
      source_type: 'synthetic',
      synthetic_kind: 'translation',
      generation_id: 'gen1',
      version: MULTI_AUGMENT_VERSION,
    },
  ];
  const merged = mergeAugmentedRows(original, augmented);
  // Must return a NEW array (never mutate input).
  assert.notEqual(merged, original, 'mergeAugmentedRows must return a NEW array');
  assert.equal(original.length, 1,
    `original array MUST NOT be mutated; got length ${original.length}`);
  assert.equal(merged.length, 2);
  // First row is the original, second is the merged synthetic row.
  const synthRow = merged[1];
  assert.equal(synthRow.source_type, 'synthetic',
    `merged synthetic row MUST carry source_type:'synthetic'; got ${JSON.stringify(synthRow)}`);
  assert.equal(synthRow.lang, 'es');
  assert.ok(synthRow.feedback, 'feedback JSON blob must be present');
  const feedback = JSON.parse(synthRow.feedback);
  assert.equal(feedback.synthetic_kind, 'translation');
  assert.equal(feedback.target_lang, 'es');
  assert.equal(feedback.source_lang, 'en');
  assert.equal(feedback.source_cid, 'orig1');
  assert.ok(synthRow.cid && synthRow.cid.startsWith('mau_'),
    `cid must be auto-stamped with mau_ prefix; got ${synthRow.cid}`);
});

// =============================================================================
// 21) POST /v1/lang/detect: auth gate + 200 envelope
// =============================================================================

test('W760 #21 — POST /v1/lang/detect 401 without auth; 200 envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/lang/detect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth → 200 envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/lang/detect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        text: 'The customer is in the queue with a refund and the agent is helping',
      }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.lang, 'en');
    assert.equal(env.version, LANG_DETECT_VERSION);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 22) GET /v1/lang/kscore-by-lang/:namespace auth gate + insufficient envelope
// =============================================================================

test('W760 #22 — GET /v1/lang/kscore-by-lang 401 w/o auth; insufficient envelope w/o rows', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/lang/kscore-by-lang/billing`);
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + empty namespace → insufficient envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/lang/kscore-by-lang/empty-ns`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    // Empty namespace → insufficient_per_lang_samples envelope (NOT silent zero).
    assert.equal(env.ok, false);
    assert.equal(env.error, 'insufficient_per_lang_samples',
      `expected insufficient_per_lang_samples envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.version, KSCORE_PER_LANG_VERSION);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 23) POST /v1/lang/augment-multilingual confirm gate
// =============================================================================

test('W760 #23 — POST /v1/lang/augment-multilingual confirm gate + no_translator envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

  const eventStore = await import('../src/event-store.js');
  if (eventStore._resetForTests) eventStore._resetForTests();

  const { buildRouter } = await import('../src/router.js');
  const { provisionAnonTenant } = await import('../src/auth.js');
  const express = (await import('express')).default;
  const http = await import('node:http');

  const app = express();
  app.use(express.json({ limit: '4mb' }));
  app.use(buildRouter());
  const t = provisionAnonTenant({ ttl_days: 1, quota: 5000 });

  // Seed at least one capture so source_rows is non-empty.
  await eventStore.appendEvent({
    tenant_id: t.id,
    namespace: 'aug-ns',
    provider: 'test',
    model_id: 'test-model',
    prompt_redacted: 'The customer wants a refund please',
    response_redacted: 'OK, refund processed',
    latency_ms: 100,
    tokens_in: 5,
    tokens_out: 5,
    cost_micro_usd: 1,
  });

  const srv = await new Promise((resolve) => {
    const s = http.createServer(app).listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const { port } = srv.address();

    // No auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/lang/augment-multilingual`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'aug-ns', target_langs: ['es'] }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth, no confirm → dry_run plan envelope.
    const dryRes = await fetch(`http://127.0.0.1:${port}/v1/lang/augment-multilingual`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'aug-ns', target_langs: ['es', 'fr'] }),
    });
    assert.equal(dryRes.status, 200);
    const dryEnv = await dryRes.json();
    assert.equal(dryEnv.ok, true, `dry-run env must be ok; got ${JSON.stringify(dryEnv)}`);
    assert.equal(dryEnv.dry_run, true,
      `WITHOUT confirm:true the route MUST stay dry-run; got ${JSON.stringify(dryEnv)}`);
    assert.ok(dryEnv.plan && dryEnv.plan.n_estimated_calls >= 1,
      `dry-run plan must include estimated calls; got ${JSON.stringify(dryEnv)}`);

    // Auth + confirm:true + no DI translator → no_translator_configured.
    const confirmRes = await fetch(`http://127.0.0.1:${port}/v1/lang/augment-multilingual`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'aug-ns',
        target_langs: ['es'],
        confirm: true,
      }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmEnv = await confirmRes.json();
    assert.equal(confirmEnv.ok, false,
      `confirm:true without translator must return ok:false; got ${JSON.stringify(confirmEnv)}`);
    assert.equal(confirmEnv.error, 'no_translator_configured',
      `expected no_translator_configured envelope; got ${JSON.stringify(confirmEnv)}`);

    // target_langs:[] → 400 target_langs_required.
    const badRes = await fetch(`http://127.0.0.1:${port}/v1/lang/augment-multilingual`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'aug-ns', target_langs: [] }),
    });
    assert.equal(badRes.status, 400, `empty target_langs must 400; got ${badRes.status}`);
    const badEnv = await badRes.json();
    assert.equal(badEnv.error, 'target_langs_required');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 24) public/docs/multilingual.html: brand-lock + data-w760 anchors
// =============================================================================

test('W760 #24 — public/docs/multilingual.html exists w/ brand-lock + data-w760 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc page at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock (matches sibling W749/W751 doc pages).
  assert.ok(html.includes('Open-source AI workbench'),
    'docs/multilingual.html MUST carry the brand-locked eyebrow');
  assert.ok(/Multilingual K-Score/.test(html),
    'page must title-match "Multilingual K-Score"');
  // Both anchor hooks must be present so the W760 panel + threshold doc are
  // mountable from the page.
  assert.ok(html.includes("data-w760=\"lang-table\""),
    'expected data-w760="lang-table" anchor on the 22-pill grid');
  assert.ok(html.includes("data-w760=\"per-lang-threshold-doc\""),
    'expected data-w760="per-lang-threshold-doc" anchor on the threshold paragraph');
  // Canonical enum + Wilson floor + W760 version stamp must all be mentioned.
  assert.ok(html.includes('w760-v1'), 'page must stamp the w760-v1 version');
  // No emojis (per spec).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/multilingual.html MUST NOT contain emojis (spec invariant)');
});

// =============================================================================
// 25) cli/kolm.js defines cmdW760Lang exactly once + routed from case 'lang'
// =============================================================================

test('W760 #25 — cli/kolm.js defines cmdW760Lang exactly once + wired from case lang', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW760Lang\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW760Lang must be defined exactly once; found ${defOccurrences}`);
  // The case-arm must invoke cmdW760Lang.
  assert.ok(/case 'lang':[\s\S]{0,200}cmdW760Lang/.test(cli),
    `expected "case 'lang': ... cmdW760Lang(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('lang')"),
    'COMPLETION_VERBS must include "lang" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.lang"),
    'COMPLETION_SUBS.lang must list the three sub-commands');
});

// =============================================================================
// 26) vercel.json has /docs/multilingual rewrite
// =============================================================================

test('W760 #26 — vercel.json carries /docs/multilingual rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multilingual' && r.destination === '/docs/multilingual.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multilingual', destination: '/docs/multilingual.html' }; ` +
    `not found in ${cfg.rewrites.length} entries`);
});

// =============================================================================
// 27) wave760 sibling test count uses wave(\d{3,4}) regex + threshold (W604)
// =============================================================================

test('W760 #27 — wave760 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  // We need at least the 5 W756-W760 sibling waves of THIS sprint plus
  // historical wave tests.
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
