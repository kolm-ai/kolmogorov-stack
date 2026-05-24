// W774 — Cross-Lingual Distill (English teacher → multilingual student).
//
// Atomic items pinned (matches the W774 implementation):
//
//   1)  LANG_BALANCED_VERSION + XLANG_EVAL_VERSION + XLANG_BAKEOFF_VERSION
//       all stamped 'w774-v1'
//   2)  BALANCE_STRATEGIES is Object.freeze()-d + carries exactly 4 entries
//   3)  DEFAULT_TARGET_LANGS has >=10 entries (W774 spec floor)
//   4)  DEFAULT_TARGET_LANGS is a subset of W760 SUPPORTED_LANGS (verified
//       by importing from src/lang-detect.js — wave-boundary check)
//   5)  sampleBalanced uniform strategy distributes evenly across languages
//   6)  sampleBalanced sqrt_inverse strategy gives more weight to rare langs
//   7)  sampleBalanced honest envelope on no captures
//   8)  assessLanguageCoverage reports missing_langs correctly
//   9)  assessLanguageCoverage coverage_score is 0 on no captures (honest, NOT 1)
//   10) evaluatePerLanguage gates at n>=30 per language (Wilson floor)
//   11) evaluatePerLanguage moves <30 langs into languages_skipped_below_n30
//   12) evaluatePerLanguage W411 tenant-fenced (re-filters listEvents rows)
//   13) evaluatePerLanguage honest envelope on missing tenant_id
//   14) compareLanguageDelta delta:null when language absent from one side
//   15) runXlangBakeoff W411 tenant-fenced
//   16) runXlangBakeoff honest envelope on no multilingual captures (<2 langs)
//   17) POST /v1/xlang/balanced-sample: 401 w/o auth; 200 w/ auth
//   18) POST /v1/xlang/per-language-eval: 401 w/o auth; 400 confirm_required;
//       200 envelope w/ confirm
//   19) POST /v1/xlang/bakeoff: 401 w/o auth; 400 confirm_required; 200 envelope
//   20) GET /v1/xlang/language-coverage: 401 w/o auth; 200 w/ auth
//   21) apps/trainer/xlang_distill.py parses + --dry-run exits 0
//       (skip if python missing on the test box)
//   22) public/docs/multilingual.html exists w/ brand-lock + data-w774 anchors
//   23) cli/kolm.js defines cmdW774Xlang exactly once + case 'xlang' wires
//   24) vercel.json carries /docs/multilingual rewrite (already added by W760)
//   25) W604 anti-brittleness — sibling sw.js test count uses wave(\d{3,4})
//       regex + threshold (never an explicit hard-coded sibling list)
//
// W604 anti-brittleness: family lock uses regex + threshold (never an
// explicit hard-coded sibling list).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LANG_BALANCED_VERSION,
  BALANCE_STRATEGIES,
  DEFAULT_TARGET_LANGS,
  sampleBalanced,
  assessLanguageCoverage,
} from '../src/lang-balanced-sampler.js';

import {
  XLANG_EVAL_VERSION,
  evaluatePerLanguage,
  compareLanguageDelta,
} from '../src/cross-lingual-eval.js';

import {
  XLANG_BAKEOFF_VERSION,
  runXlangBakeoff,
} from '../src/xlang-bakeoff.js';

import { SUPPORTED_LANGS } from '../src/lang-detect.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'multilingual.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const PY_TRAINER = path.join(REPO_ROOT, 'apps', 'trainer', 'xlang_distill.py');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w774-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// ──────────────────────────── Pure-JS detect stubs ────────────────────────────
// Several tests build synthetic capture pools where the input string is
// already lang-tagged; we DI a stub detector so we don't need the
// W760 regex-heavy detector. Production code uses the real detector via
// the default DI fallback.

const stubDetect = (text) => {
  if (typeof text !== 'string') return { lang: null, fallback: true };
  const tag = text.slice(0, 4); // expects "[xx]" prefix
  const m = tag.match(/^\[([a-z]{2})\]/);
  if (!m) return { lang: null, fallback: true };
  return { lang: m[1], fallback: false };
};

// =============================================================================
// 1) Version stamps
// =============================================================================

test('W774 #1 — all three modules stamp w774-v1', () => {
  freshDir();
  assert.equal(LANG_BALANCED_VERSION, 'w774-v1',
    `expected LANG_BALANCED_VERSION='w774-v1'; got ${JSON.stringify(LANG_BALANCED_VERSION)}`);
  assert.equal(XLANG_EVAL_VERSION, 'w774-v1',
    `expected XLANG_EVAL_VERSION='w774-v1'; got ${JSON.stringify(XLANG_EVAL_VERSION)}`);
  assert.equal(XLANG_BAKEOFF_VERSION, 'w774-v1',
    `expected XLANG_BAKEOFF_VERSION='w774-v1'; got ${JSON.stringify(XLANG_BAKEOFF_VERSION)}`);
});

// =============================================================================
// 2) BALANCE_STRATEGIES frozen + exactly 4 entries
// =============================================================================

test('W774 #2 — BALANCE_STRATEGIES is Object.freeze()-d w/ exactly 4 strategies', () => {
  freshDir();
  assert.ok(Array.isArray(BALANCE_STRATEGIES), 'BALANCE_STRATEGIES must be an array');
  assert.ok(Object.isFrozen(BALANCE_STRATEGIES),
    'BALANCE_STRATEGIES MUST be Object.freeze()-d (immutable contract)');
  assert.equal(BALANCE_STRATEGIES.length, 4,
    `expected exactly 4 strategies; got ${BALANCE_STRATEGIES.length}: ` +
    JSON.stringify(BALANCE_STRATEGIES));
  for (const s of ['uniform', 'sqrt_inverse', 'log_inverse', 'traffic_weighted']) {
    assert.ok(BALANCE_STRATEGIES.includes(s), `expected strategy '${s}'; got ${JSON.stringify(BALANCE_STRATEGIES)}`);
  }
});

// =============================================================================
// 3) DEFAULT_TARGET_LANGS >=10
// =============================================================================

test('W774 #3 — DEFAULT_TARGET_LANGS has >=10 entries (W774 spec floor)', () => {
  freshDir();
  assert.ok(Array.isArray(DEFAULT_TARGET_LANGS),
    'DEFAULT_TARGET_LANGS must be an array');
  assert.ok(DEFAULT_TARGET_LANGS.length >= 10,
    `W774 spec mandates >=10 target langs; got ${DEFAULT_TARGET_LANGS.length}: ` +
    JSON.stringify(DEFAULT_TARGET_LANGS));
});

// =============================================================================
// 4) DEFAULT_TARGET_LANGS subset of W760 SUPPORTED_LANGS
// =============================================================================

test('W774 #4 — DEFAULT_TARGET_LANGS is subset of W760 SUPPORTED_LANGS', () => {
  freshDir();
  // Every default target language must be detectable by W760's detector.
  // Otherwise the balanced sampler would silently drop captures in those
  // langs (detector returns lang:null) and the operator would see an
  // impossible-to-debug coverage gap.
  for (const lang of DEFAULT_TARGET_LANGS) {
    assert.ok(SUPPORTED_LANGS.includes(lang),
      `W774 default target lang '${lang}' is NOT in W760 SUPPORTED_LANGS; ` +
      `the detector would never classify it (sampler would silently drop it)`);
  }
});

// =============================================================================
// 5) sampleBalanced uniform → even distribution across langs
// =============================================================================

test('W774 #5 — sampleBalanced uniform strategy distributes evenly across langs', async () => {
  freshDir();
  // Build a wildly skewed pool: 100 en, 5 es, 5 fr — uniform should give
  // each lang roughly equal share of the output (up to per-lang supply).
  const captures = [];
  for (let i = 0; i < 100; i++) captures.push({ cid: 'en' + i, input: '[en] sample ' + i });
  for (let i = 0; i < 5; i++)   captures.push({ cid: 'es' + i, input: '[es] sample ' + i });
  for (let i = 0; i < 5; i++)   captures.push({ cid: 'fr' + i, input: '[fr] sample ' + i });

  const env = await sampleBalanced({
    captures,
    strategy: 'uniform',
    target_langs: ['en', 'es', 'fr'],
    max_n: 15,
    lang_detect: stubDetect,
  });
  assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.strategy, 'uniform');
  // Uniform with max_n=15 and 3 target langs should give 5/5/5 (or close
  // to it after rounding + supply clamping). en cannot dominate.
  const en = env.by_lang.en || 0;
  const es = env.by_lang.es || 0;
  const fr = env.by_lang.fr || 0;
  assert.ok(en <= 6, `uniform must NOT let en dominate; got en=${en}`);
  assert.ok(es >= 4 && fr >= 4,
    `uniform must reach the supply floor for rare langs; got es=${es}, fr=${fr}`);
});

// =============================================================================
// 6) sampleBalanced sqrt_inverse → more weight to rare langs
// =============================================================================

test('W774 #6 — sampleBalanced sqrt_inverse weights rare langs higher than traffic_weighted', async () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 200; i++) captures.push({ cid: 'en' + i, input: '[en] s ' + i });
  for (let i = 0; i < 20; i++)  captures.push({ cid: 'es' + i, input: '[es] s ' + i });

  const sqrt = await sampleBalanced({
    captures,
    strategy: 'sqrt_inverse',
    target_langs: ['en', 'es'],
    max_n: 30,
    lang_detect: stubDetect,
  });
  const traffic = await sampleBalanced({
    captures,
    strategy: 'traffic_weighted',
    target_langs: ['en', 'es'],
    max_n: 30,
    lang_detect: stubDetect,
  });
  assert.equal(sqrt.ok, true);
  assert.equal(traffic.ok, true);
  // sqrt_inverse should give Spanish a HIGHER share than traffic_weighted
  // (which mirrors the 200/20 raw mix).
  const sqrtEsShare = (sqrt.by_lang.es || 0) / Math.max(1, sqrt.total_n);
  const trafficEsShare = (traffic.by_lang.es || 0) / Math.max(1, traffic.total_n);
  assert.ok(sqrtEsShare > trafficEsShare,
    `sqrt_inverse must give rare langs MORE weight than traffic; ` +
    `sqrt es share=${sqrtEsShare}, traffic es share=${trafficEsShare}`);
});

// =============================================================================
// 7) sampleBalanced honest envelope on no captures
// =============================================================================

test('W774 #7 — sampleBalanced honest envelope on empty captures', async () => {
  freshDir();
  const env = await sampleBalanced({
    captures: [],
    strategy: 'uniform',
    target_langs: ['en'],
    max_n: 10,
    lang_detect: stubDetect,
  });
  assert.equal(env.ok, false, `expected ok:false on empty captures; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'empty_captures');
  assert.equal(env.version, LANG_BALANCED_VERSION);
  assert.ok(env.hint && env.hint.length > 0);
});

// =============================================================================
// 8) assessLanguageCoverage reports missing_langs correctly
// =============================================================================

test('W774 #8 — assessLanguageCoverage surfaces missing_langs', async () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 20; i++) captures.push({ cid: 'en' + i, input: '[en] sample ' + i });
  // Only en captures; es and fr should land in missing_langs.

  const env = await assessLanguageCoverage({
    captures,
    target_langs: ['en', 'es', 'fr'],
    lang_detect: stubDetect,
  });
  assert.equal(env.ok, true);
  assert.equal(env.version, LANG_BALANCED_VERSION);
  assert.ok(env.missing_langs.includes('es'),
    `expected es in missing; got ${JSON.stringify(env.missing_langs)}`);
  assert.ok(env.missing_langs.includes('fr'),
    `expected fr in missing; got ${JSON.stringify(env.missing_langs)}`);
  assert.ok(env.present_langs.includes('en'),
    `expected en in present; got ${JSON.stringify(env.present_langs)}`);
});

// =============================================================================
// 9) assessLanguageCoverage coverage_score:0 on empty captures (NOT 1)
// =============================================================================

test('W774 #9 — assessLanguageCoverage coverage_score:0 on empty captures (honest, NOT silent 1.0)', async () => {
  freshDir();
  const env = await assessLanguageCoverage({
    captures: [],
    target_langs: ['en', 'es'],
    lang_detect: stubDetect,
  });
  assert.equal(env.ok, true);
  assert.equal(env.coverage_score, 0,
    `empty captures MUST report coverage_score:0 (honesty invariant); got ${env.coverage_score}`);
  assert.equal(env.captures_total, 0);
  // Both target langs should be missing.
  assert.equal(env.missing_langs.length, 2,
    `expected both target langs missing on empty; got ${JSON.stringify(env.missing_langs)}`);
});

// =============================================================================
// 10) evaluatePerLanguage gates at n>=30 per language (Wilson floor)
// =============================================================================

test('W774 #10 — evaluatePerLanguage Wilson floor n>=30 per language', async () => {
  freshDir();
  // Build a synthetic store stub returning 40 en + 40 es captures all
  // tagged tenant_id 't1'.
  const captures = [];
  for (let i = 0; i < 40; i++) captures.push({
    tenant_id: 't1', event_id: 'en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  for (let i = 0; i < 40; i++) captures.push({
    tenant_id: 't1', event_id: 'es' + i,
    prompt_redacted: '[es] q ' + i, response_redacted: '[es] a ' + i,
  });
  const storeMod = { listEvents: async () => captures.slice() };
  const runOnArtifact = async (_artifact, _cap) => ({ output: 'whatever' });
  const judge = async ({ lang }) => ({ score: lang === 'en' ? 0.92 : 0.55 });

  const env = await evaluatePerLanguage({
    tenant_id: 't1',
    namespace: 'ns',
    artifact_path: 'fake.kolm',
    opts: { storeMod, runOnArtifact, judge, lang_detect: stubDetect },
  });
  assert.equal(env.ok, true);
  assert.equal(env.gated_at_n, 30, 'gated_at_n must be the Wilson floor 30');
  assert.ok(env.by_lang.en && env.by_lang.es, 'both lang buckets must be populated');
  assert.equal(env.by_lang.en.n, 40);
  assert.equal(env.by_lang.es.n, 40);
  assert.ok(Number.isFinite(env.by_lang.en.score));
  assert.ok(Number.isFinite(env.by_lang.en.ci95_low));
  assert.ok(Number.isFinite(env.by_lang.en.ci95_high));
  assert.ok(env.by_lang.en.ci95_low <= env.by_lang.en.score,
    `Wilson CI low must be <= point estimate; got ${JSON.stringify(env.by_lang.en)}`);
});

// =============================================================================
// 11) evaluatePerLanguage skips <30 langs into languages_skipped_below_n30
// =============================================================================

test('W774 #11 — evaluatePerLanguage moves n<30 langs into languages_skipped_below_n30', async () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 40; i++) captures.push({
    tenant_id: 't1', event_id: 'en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  // Only 5 fr captures → way under Wilson floor.
  for (let i = 0; i < 5; i++) captures.push({
    tenant_id: 't1', event_id: 'fr' + i,
    prompt_redacted: '[fr] q ' + i, response_redacted: '[fr] a ' + i,
  });
  const storeMod = { listEvents: async () => captures.slice() };
  const runOnArtifact = async () => ({ output: 'ok' });
  const judge = async () => ({ score: 0.7 });

  const env = await evaluatePerLanguage({
    tenant_id: 't1',
    namespace: 'ns',
    artifact_path: 'fake.kolm',
    opts: { storeMod, runOnArtifact, judge, lang_detect: stubDetect },
  });
  assert.equal(env.ok, true);
  // fr must be in skipped list with n=5.
  const skipped = env.languages_skipped_below_n30 || [];
  const frSkip = skipped.find((s) => s.lang === 'fr');
  assert.ok(frSkip, `expected fr in languages_skipped_below_n30; got ${JSON.stringify(skipped)}`);
  assert.equal(frSkip.n, 5);
  // fr's bucket should still exist but with null score / null CI.
  if (env.by_lang.fr) {
    assert.equal(env.by_lang.fr.score, null,
      `n<30 fr must report score:null; got ${JSON.stringify(env.by_lang.fr)}`);
    assert.equal(env.by_lang.fr.ci95_low, null);
    assert.equal(env.by_lang.fr.floor_hit, true);
  }
  // en (n=40) must be in languages_evaluated.
  assert.ok(env.languages_evaluated.includes('en'));
  assert.ok(!env.languages_evaluated.includes('fr'));
});

// =============================================================================
// 12) evaluatePerLanguage W411 defense-in-depth tenant fence
// =============================================================================

test('W774 #12 — evaluatePerLanguage W411 defense-in-depth filters cross-tenant rows', async () => {
  freshDir();
  // Mix t1 and t2 rows; store stub returns ALL rows regardless of filter.
  // The module must re-filter to t1.
  const captures = [];
  for (let i = 0; i < 40; i++) captures.push({
    tenant_id: 't1', event_id: 't1en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  for (let i = 0; i < 40; i++) captures.push({
    tenant_id: 't2', event_id: 't2en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  const storeMod = { listEvents: async () => captures.slice() };
  let runCalls = 0;
  const runOnArtifact = async () => { runCalls += 1; return { output: 'ok' }; };
  const judge = async () => ({ score: 0.7 });

  const env = await evaluatePerLanguage({
    tenant_id: 't1',
    namespace: 'ns',
    artifact_path: 'fake.kolm',
    opts: { storeMod, runOnArtifact, judge, lang_detect: stubDetect },
  });
  assert.equal(env.ok, true);
  // captures_total should reflect only t1 rows (40), not the 80 the stub returned.
  assert.equal(env.captures_total, 40,
    `W411 fence must drop cross-tenant rows; got captures_total=${env.captures_total}`);
  // runOnArtifact must have been called ONLY for t1 rows.
  assert.equal(runCalls, 40,
    `runOnArtifact should have been called only on t1 rows; got ${runCalls}`);
});

// =============================================================================
// 13) evaluatePerLanguage honest envelope on missing tenant_id
// =============================================================================

test('W774 #13 — evaluatePerLanguage honest envelope on missing tenant_id', async () => {
  freshDir();
  const env = await evaluatePerLanguage({
    namespace: 'ns',
    artifact_path: 'fake.kolm',
    opts: {},
  });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'tenant_id_required',
    `expected tenant_id_required envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.version, XLANG_EVAL_VERSION);
});

// =============================================================================
// 14) compareLanguageDelta delta:null when lang absent from one side
// =============================================================================

test('W774 #14 — compareLanguageDelta returns null delta when lang absent from one side', () => {
  freshDir();
  const evalA = {
    by_lang: {
      en: { score: 0.9, ci95_low: 0.85, ci95_high: 0.95 },
      es: { score: 0.6, ci95_low: 0.50, ci95_high: 0.70 },
    },
    pooled_score: 0.75,
  };
  const evalB = {
    by_lang: {
      en: { score: 0.85, ci95_low: 0.80, ci95_high: 0.90 },
      // es absent
      fr: { score: 0.7, ci95_low: 0.65, ci95_high: 0.75 },
    },
    pooled_score: 0.78,
  };
  const diff = compareLanguageDelta(evalA, evalB);
  assert.equal(diff.ok, true);
  // es is only in A.
  assert.ok(diff.a_only.includes('es'),
    `expected es in a_only; got ${JSON.stringify(diff.a_only)}`);
  // fr is only in B.
  assert.ok(diff.b_only.includes('fr'),
    `expected fr in b_only; got ${JSON.stringify(diff.b_only)}`);
  // en is shared.
  assert.ok(diff.shared.includes('en'));
  // es delta must be null (only in A).
  assert.equal(diff.by_lang.es.delta, null,
    `delta must be null when lang absent from one side; got ${JSON.stringify(diff.by_lang.es)}`);
  // en delta must be finite.
  assert.ok(Number.isFinite(diff.by_lang.en.delta),
    `expected finite en delta; got ${JSON.stringify(diff.by_lang.en)}`);
});

// =============================================================================
// 15) runXlangBakeoff W411 tenant-fenced
// =============================================================================

test('W774 #15 — runXlangBakeoff W411 defense-in-depth filters cross-tenant rows', async () => {
  freshDir();
  const captures = [];
  for (let i = 0; i < 10; i++) captures.push({
    tenant_id: 't1', event_id: 't1en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  for (let i = 0; i < 10; i++) captures.push({
    tenant_id: 't1', event_id: 't1es' + i,
    prompt_redacted: '[es] q ' + i, response_redacted: '[es] a ' + i,
  });
  for (let i = 0; i < 10; i++) captures.push({
    tenant_id: 't2', event_id: 't2zh' + i,
    prompt_redacted: '[zh] q ' + i, response_redacted: '[zh] a ' + i,
  });
  const storeMod = { listEvents: async () => captures.slice() };
  let runCalls = 0;
  const runOnArtifact = async () => { runCalls += 1; return { output: 'ok' }; };
  const judge = async ({ actual }) => ({
    score: actual === 'good' ? 0.95 : 0.5,
  });

  const env = await runXlangBakeoff({
    tenant_id: 't1',
    namespace: 'ns',
    artifact_a: 'a.kolm',
    artifact_b: 'b.kolm',
    opts: { storeMod, runOnArtifact, judge, lang_detect: stubDetect },
  });
  assert.equal(env.ok, true);
  // Cross-tenant zh rows must NOT appear in compared langs.
  assert.ok(!env.languages_compared.includes('zh'),
    `cross-tenant 'zh' rows must NOT leak; got ${JSON.stringify(env.languages_compared)}`);
  // Only en + es should be compared (those are the t1 langs).
  assert.ok(env.languages_compared.includes('en'));
  assert.ok(env.languages_compared.includes('es'));
  // runOnArtifact should be called twice per t1 row (once per artifact) → 20*2=40.
  assert.equal(runCalls, 40,
    `expected runOnArtifact to fire 40 times (20 t1 rows * 2 artifacts); got ${runCalls}`);
});

// =============================================================================
// 16) runXlangBakeoff honest envelope on no multilingual captures
// =============================================================================

test('W774 #16 — runXlangBakeoff honest envelope when <2 distinct detected languages', async () => {
  freshDir();
  // Only English captures — should refuse to bakeoff as multilingual.
  const captures = [];
  for (let i = 0; i < 10; i++) captures.push({
    tenant_id: 't1', event_id: 'en' + i,
    prompt_redacted: '[en] q ' + i, response_redacted: '[en] a ' + i,
  });
  const storeMod = { listEvents: async () => captures.slice() };
  const runOnArtifact = async () => ({ output: 'ok' });
  const judge = async () => ({ score: 0.7 });

  const env = await runXlangBakeoff({
    tenant_id: 't1',
    namespace: 'ns',
    artifact_a: 'a.kolm',
    artifact_b: 'b.kolm',
    opts: { storeMod, runOnArtifact, judge, lang_detect: stubDetect },
  });
  assert.equal(env.ok, false);
  assert.equal(env.error, 'no_multilingual_captures',
    `expected no_multilingual_captures envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.version, XLANG_BAKEOFF_VERSION);
});

// =============================================================================
// 17) POST /v1/xlang/balanced-sample auth gate + 200 envelope
// =============================================================================

test('W774 #17 — POST /v1/xlang/balanced-sample 401 w/o auth; 200 with auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/xlang/balanced-sample`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ns', strategy: 'uniform' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 without auth; got ${noAuth.status}`);

    // Auth + empty namespace → empty_captures honest envelope.
    const ok = await fetch(`http://127.0.0.1:${port}/v1/xlang/balanced-sample`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'empty-ns', strategy: 'uniform', max_n: 10 }),
    });
    assert.equal(ok.status, 200, `expected 200 with auth; got ${ok.status}`);
    const env = await ok.json();
    // Empty corpus must return ok:false empty_captures (NOT silent ok:true).
    assert.equal(env.ok, false);
    assert.equal(env.error, 'empty_captures',
      `expected empty_captures envelope on no captures; got ${JSON.stringify(env)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 18) POST /v1/xlang/per-language-eval auth + confirm gate
// =============================================================================

test('W774 #18 — POST /v1/xlang/per-language-eval 401 w/o auth; 400 confirm_required; 200 envelope', async () => {
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

    // 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/xlang/per-language-eval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ns', artifact_path: 'fake.kolm' }),
    });
    assert.equal(noAuth.status, 401);

    // Auth + no confirm → 400 confirm_required.
    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/xlang/per-language-eval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns', artifact_path: 'fake.kolm' }),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required',
      `expected confirm_required envelope; got ${JSON.stringify(noConfirmEnv)}`);

    // Auth + confirm + valid artifact_path → 200 envelope (no_run_on_artifact_configured
    // is the honest hosted-route envelope; the test just verifies the route
    // accepts the call shape).
    const confirmRes = await fetch(`http://127.0.0.1:${port}/v1/xlang/per-language-eval`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'ns',
        artifact_path: 'fake.kolm',
        confirm: true,
      }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmEnv = await confirmRes.json();
    // Empty namespace → captures_total:0 + ok:true (honest empty envelope).
    // The route would never silently fabricate a score.
    assert.equal(confirmEnv.version, XLANG_EVAL_VERSION);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 19) POST /v1/xlang/bakeoff auth + confirm gate
// =============================================================================

test('W774 #19 — POST /v1/xlang/bakeoff 401 w/o auth; 400 confirm_required; 200 envelope', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/xlang/bakeoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_a: 'a', artifact_b: 'b' }),
    });
    assert.equal(noAuth.status, 401);

    const noConfirm = await fetch(`http://127.0.0.1:${port}/v1/xlang/bakeoff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ artifact_a: 'a', artifact_b: 'b' }),
    });
    assert.equal(noConfirm.status, 400);
    const noConfirmEnv = await noConfirm.json();
    assert.equal(noConfirmEnv.error, 'confirm_required');

    const confirmRes = await fetch(`http://127.0.0.1:${port}/v1/xlang/bakeoff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        namespace: 'ns',
        artifact_a: 'a.kolm',
        artifact_b: 'b.kolm',
        confirm: true,
      }),
    });
    assert.equal(confirmRes.status, 200);
    const confirmEnv = await confirmRes.json();
    assert.equal(confirmEnv.version, XLANG_BAKEOFF_VERSION);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 20) GET /v1/xlang/language-coverage auth gate
// =============================================================================

test('W774 #20 — GET /v1/xlang/language-coverage 401 w/o auth; 200 with auth', async () => {
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

    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/xlang/language-coverage?namespace=ns`);
    assert.equal(noAuth.status, 401);

    const ok = await fetch(`http://127.0.0.1:${port}/v1/xlang/language-coverage?namespace=ns`, {
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(ok.status, 200);
    const env = await ok.json();
    assert.equal(env.ok, true);
    assert.equal(env.version, LANG_BALANCED_VERSION);
    // Empty namespace → coverage_score:0 honest envelope.
    assert.equal(env.coverage_score, 0,
      `empty namespace must report coverage_score:0; got ${JSON.stringify(env)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 21) apps/trainer/xlang_distill.py --dry-run exits 0
// =============================================================================

test('W774 #21 — apps/trainer/xlang_distill.py --dry-run exits 0 (skip if python missing)', () => {
  freshDir();
  // Skip when no python interpreter on PATH.
  const pyCandidates = ['python3', 'python', 'py'];
  let pyExe = null;
  for (const c of pyCandidates) {
    try {
      const probe = spawnSync(c, ['--version'], { encoding: 'utf8' });
      if (probe && probe.status === 0) { pyExe = c; break; }
    } catch (_) { /* try next */ }
  }
  if (!pyExe) {
    // Honestly skip — the trainer is stdlib-only but we still need ANY python.
    return;
  }

  // Build a tiny captures JSONL in a tempdir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w774-py-'));
  const captures = path.join(tmp, 'captures.jsonl');
  const out = path.join(tmp, 'out');
  fs.writeFileSync(captures,
    '{"input":"hello","output":"hi","lang":"en"}\n' +
    '{"input":"hola","output":"hola","lang":"es"}\n' +
    '{"input":"bonjour","output":"salut","lang":"fr"}\n',
    'utf8');

  const r = spawnSync(pyExe, [
    PY_TRAINER,
    '--captures', captures,
    '--out', out,
    '--dry-run',
    '--target-langs', 'en,es,fr,de',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 0,
    `--dry-run must exit 0; got status=${r.status}, stderr=${r.stderr}`);
  // Parse the stdout envelope.
  const lastLine = (r.stdout || '').trim().split('\n').pop();
  let env;
  try { env = JSON.parse(lastLine); } catch (e) {
    assert.fail('xlang_distill.py --dry-run must emit a JSON envelope on stdout; got: ' + (r.stdout || ''));
  }
  assert.equal(env.ok, true);
  assert.equal(env.mode, 'dry_run');
  assert.equal(env.trainer_not_invoked, true,
    'dry-run MUST stamp trainer_not_invoked:true (honesty invariant)');
  assert.equal(env.version, 'w774-v1');
  assert.equal(env.captures_total, 3);
  assert.ok(env.by_lang.en >= 1 && env.by_lang.es >= 1 && env.by_lang.fr >= 1);
  // 'de' is in target_langs but not in captures → must surface in missing.
  assert.ok(env.languages_missing.includes('de'),
    `expected 'de' in languages_missing; got ${JSON.stringify(env.languages_missing)}`);
});

// =============================================================================
// 22) public/docs/multilingual.html brand-lock + data-w774 anchors
// =============================================================================

test('W774 #22 — public/docs/multilingual.html has brand-lock + data-w774 anchors', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc page at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand lock — must keep the existing W760 brand eyebrow AND add a W774 one.
  assert.ok(html.includes('Open-source AI workbench'),
    'docs/multilingual.html MUST carry the brand-locked eyebrow');
  // W774 H1.
  assert.ok(/Cross-lingual distillation/.test(html),
    'page must title-match "Cross-lingual distillation" for W774');
  // W774 anchors.
  assert.ok(html.includes('data-w774="section-root"'),
    'expected data-w774="section-root" anchor');
  assert.ok(html.includes('data-w774="default-target-langs-grid"'),
    'expected data-w774="default-target-langs-grid" anchor on the 12-pill grid');
  assert.ok(html.includes('data-w774="balance-strategies-table"'),
    'expected data-w774="balance-strategies-table" anchor');
  assert.ok(html.includes('data-w774="per-lang-eval-body"'),
    'expected data-w774="per-lang-eval-body" anchor');
  assert.ok(html.includes('data-w774="bakeoff-body"'),
    'expected data-w774="bakeoff-body" anchor');
  // Version stamp.
  assert.ok(html.includes('w774-v1'), 'page must stamp the w774-v1 version');
  // 12 target langs must all appear in pills.
  for (const lang of DEFAULT_TARGET_LANGS) {
    assert.ok(html.includes('<b>' + lang + '</b>'),
      `expected default target lang '${lang}' in the pill grid`);
  }
  // No emojis (spec invariant — mirrors W760).
  const emojiRe = /[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}\u{1F600}-\u{1F64F}]/u;
  assert.equal(emojiRe.test(html), false,
    'docs/multilingual.html MUST NOT contain emojis (W774 spec invariant)');
});

// =============================================================================
// 23) cli/kolm.js defines cmdW774Xlang exactly once + routed from case 'xlang'
// =============================================================================

test('W774 #23 — cli/kolm.js defines cmdW774Xlang exactly once + wires case xlang', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defOccurrences = (cli.match(/async function cmdW774Xlang\b/g) || []).length;
  assert.equal(defOccurrences, 1,
    `cmdW774Xlang must be defined exactly once; found ${defOccurrences}`);
  // The case-arm must invoke cmdW774Xlang.
  assert.ok(/case 'xlang':[\s\S]{0,200}cmdW774Xlang/.test(cli),
    `expected "case 'xlang': ... cmdW774Xlang(...)" wiring; not found`);
  // The multilingual long alias must also dispatch to cmdW774Xlang.
  assert.ok(/case 'multilingual':[\s\S]{0,200}cmdW774Xlang/.test(cli),
    `expected "case 'multilingual': ... cmdW774Xlang(...)" wiring; not found`);
  // Completion table entries must be present.
  assert.ok(cli.includes("COMPLETION_VERBS.push('xlang'"),
    'COMPLETION_VERBS must include "xlang" for shell completion');
  assert.ok(cli.includes("COMPLETION_SUBS.xlang"),
    'COMPLETION_SUBS.xlang must list the four sub-commands');
});

// =============================================================================
// 24) vercel.json has /docs/multilingual rewrite
// =============================================================================

test('W774 #24 — vercel.json carries /docs/multilingual rewrite', () => {
  freshDir();
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  const cfg = JSON.parse(raw);
  assert.ok(Array.isArray(cfg.rewrites), 'vercel.json must have a rewrites array');
  const rw = cfg.rewrites.find((r) =>
    r && r.source === '/docs/multilingual' && r.destination === '/docs/multilingual.html');
  assert.ok(rw,
    `expected rewrite { source: '/docs/multilingual', destination: '/docs/multilingual.html' }`);
});

// =============================================================================
// 25) W604 anti-brittleness — sibling test count uses regex + threshold
// =============================================================================

test('W774 #25 — wave774 sibling sw.js test count uses regex wave(\\d{3,4}) + threshold', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  // We need at least 5 wave test files (W770-W774 sprint).
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});
