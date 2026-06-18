// W704 - direct contract for src/kscore-per-language.js.
//
// Focus: bounded per-language K-Score buckets, valid scoring basis floors,
// digest-backed envelopes, safe language filters, and threshold scaling.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  KSCORE_PER_LANG_CONTRACT_VERSION,
  KSCORE_PER_LANG_LIMITS,
  KSCORE_PER_LANG_VERSION,
  _internal,
  perLanguageConfidenceThreshold,
  perLanguageKScore,
} from '../src/kscore-per-language.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function englishRows(n, kScore = 0.9) {
  return Array.from({ length: n }, (_, i) => ({
    input: `the and is in to of that with english sample ${i}`,
    k_score: kScore,
  }));
}

function spanishRows(n, kScore = 0.42) {
  return Array.from({ length: n }, (_, i) => ({
    input: `el la que de los las pero una muestra ${i}`,
    k_score: kScore,
  }));
}

function assertNoUnsafeControlBytes(rel) {
  const bytes = fs.readFileSync(path.join(ROOT, rel));
  const bad = [...bytes].filter((b) => b < 32 && b !== 9 && b !== 10 && b !== 13);
  assert.deepEqual(bad, [], `${rel} must not contain raw control bytes`);
}

test('W704 source pins per-language K-Score bounds, digest contract, and package wiring', () => {
  const source = read('src/kscore-per-language.js');
  const pkg = readJson('package.json');

  assert.equal(KSCORE_PER_LANG_VERSION, 'w760-v2');
  assert.equal(KSCORE_PER_LANG_CONTRACT_VERSION, 'w704-v1');
  assert.equal(KSCORE_PER_LANG_LIMITS.MIN_N_FOR_PER_LANG_ANY, 30);
  assert.equal(KSCORE_PER_LANG_LIMITS.MAX_ROWS, 5000);
  assert.match(source, /scoreBasisCount/);
  assert.match(source, /report_sha256/);
  assert.match(source, /threshold_sha256/);
  assert.match(source, /lang_filter_rejected/);
  assert.match(source, /invalid_score_rows/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assertNoUnsafeControlBytes('src/kscore-per-language.js');

  assert.equal(
    pkg.scripts['verify:kscore-per-language'],
    'node --test --test-concurrency=1 tests/wave704-kscore-per-language-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:kscore-calibration && npm run verify:kscore-per-language && npm run verify:quality-calibration/);
});

test('W704 perLanguageKScore emits finite digest-backed buckets and pooled comparison', () => {
  const rows = [...englishRows(35, 0.9), ...spanishRows(35, 0.42)];
  const first = perLanguageKScore({ rows });
  const second = perLanguageKScore({ rows });

  assert.deepEqual(first, second, 'pure per-language score must be deterministic');
  assert.equal(first.ok, true);
  assert.equal(first.version, KSCORE_PER_LANG_VERSION);
  assert.equal(first.contract_version, KSCORE_PER_LANG_CONTRACT_VERSION);
  assert.match(first.report_sha256, HEX64_RE);
  assert.equal(first.n_total, 70);
  assert.equal(first.n_unknown, 0);
  assert.equal(first.by_lang.en.n, 35);
  assert.equal(first.by_lang.en.score_n, 35);
  assert.equal(first.by_lang.en.k_score, 0.9);
  assert.equal(first.by_lang.en.floor_hit, false);
  assert.ok(first.by_lang.en.wilson_ci_lo >= 0 && first.by_lang.en.wilson_ci_hi <= 1);
  assert.equal(first.by_lang.es.k_score, 0.42);
  assert.equal(first.pooled.n, 70);
  assert.equal(first.pooled.score_n, 70);
  assert.equal(first.pooled.k_score, 0.66);
  assert.ok(first.pooled.wilson_ci_lo >= 0 && first.pooled.wilson_ci_hi <= 1);
});

test('W704 insufficient and hostile score rows cannot fake the per-language floor', () => {
  const tooSmall = perLanguageKScore({ rows: englishRows(10, 0.9) });
  assert.equal(tooSmall.ok, false);
  assert.equal(tooSmall.error, 'insufficient_per_lang_samples');
  assert.equal(tooSmall.by_lang_counts.en, 10);
  assert.equal(tooSmall.by_lang_score_counts.en, 10);
  assert.match(tooSmall.report_sha256, HEX64_RE);

  const badScores = englishRows(35, Number.POSITIVE_INFINITY);
  const hostile = perLanguageKScore({ rows: badScores });
  assert.equal(hostile.ok, false);
  assert.equal(hostile.error, 'insufficient_per_lang_samples');
  assert.equal(hostile.by_lang_counts.en, 35);
  assert.equal(hostile.by_lang_score_counts.en, 0);

  const mixed = perLanguageKScore({
    rows: [
      ...englishRows(30, 0.8),
      ...Array.from({ length: 5 }, (_, i) => ({
        input: `the and is in to of that with invalid ${i}`,
        k_score: i % 2 === 0 ? 2 : -1,
      })),
    ],
  });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.by_lang.en.n, 35);
  assert.equal(mixed.by_lang.en.score_n, 30);
  assert.equal(mixed.by_lang.en.invalid_score_rows, 5);
  assert.equal(mixed.by_lang.en.k_score, 0.8);
});

test('W704 language filters and row/text caps are bounded and explicit', () => {
  const rows = [
    ...englishRows(35, 0.9),
    ...spanishRows(35, 0.42),
    { input: `${'the and is in to of that with '.repeat(400)}tail`, k_score: 0.7 },
  ];
  const out = perLanguageKScore({
    rows,
    lang_filter: ['es', 'es', 'bad\nlang', '__proto__', 'zz'],
  });
  assert.equal(out.ok, true);
  assert.deepEqual(Object.keys(out.by_lang), ['es']);
  assert.equal(out.by_lang.es.n, 35);
  assert.equal(out.stats.filtered_rows, 36);
  assert.deepEqual(out.stats.lang_filter_rejected, ['bad\nlang', '__proto__', 'zz']);
  assert.equal(out.stats.text_truncated_rows, 1);

  const capped = perLanguageKScore({
    rows: englishRows(KSCORE_PER_LANG_LIMITS.MAX_ROWS + 3, 0.75),
  });
  assert.equal(capped.ok, true);
  assert.equal(capped.n_total, KSCORE_PER_LANG_LIMITS.MAX_ROWS);
  assert.equal(capped.stats.rows_truncated, 3);
});

test('W704 per-language confidence threshold scales and fails closed', () => {
  const byLang = perLanguageKScore({ rows: [...englishRows(35, 0.9), ...spanishRows(35, 0.42)] });
  const es = perLanguageConfidenceThreshold({
    lang: 'es',
    by_lang_kscore: byLang,
    default_threshold: 0.7,
  });
  assert.equal(es.ok, true);
  assert.equal(es.lang, 'es');
  assert.equal(es.k_lang, 0.42);
  assert.equal(es.k_pooled, 0.66);
  assert.equal(es.threshold, 0.4455);
  assert.match(es.threshold_sha256, HEX64_RE);

  const weak = perLanguageConfidenceThreshold({
    lang: 'es',
    by_lang_kscore: {
      by_lang: { es: { k_score: 0.1 } },
      pooled: { k_score: 0.9 },
    },
    default_threshold: 0.7,
  });
  assert.equal(weak.ok, true);
  assert.equal(weak.clamped_ratio, 0.5);
  assert.equal(weak.threshold, 0.35);

  assert.equal(perLanguageConfidenceThreshold({ lang: 'bad\nlang', by_lang_kscore: byLang }).error, 'lang_required');
  assert.equal(perLanguageConfidenceThreshold({ lang: 'es', by_lang_kscore: byLang, default_threshold: 2 }).error, 'default_threshold_invalid');
  assert.equal(perLanguageConfidenceThreshold({ lang: 'es', by_lang_kscore: { by_lang: {}, pooled: { k_score: 0.7 } } }).error, 'no_data_for_lang');
  assert.equal(perLanguageConfidenceThreshold({ lang: 'es', by_lang_kscore: { by_lang: { es: { k_score: 0.7 } }, pooled: null } }).error, 'no_pooled_kscore');
});

test('W704 internal language sanitizer is prototype-safe and supported-only', () => {
  assert.equal(_internal.sanitizeLang('EN'), 'en');
  assert.equal(_internal.sanitizeLang('__proto__'), null);
  assert.equal(_internal.sanitizeLang('zz'), null);
  assert.equal(_internal.scoreBasisCount([{ k_score: 0.5 }, { k_score: Infinity }, { k_score: -1 }]), 1);
});
