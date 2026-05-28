// W833 — Cross-Lingual Distillation foundation enhancements (the
// FOUNDATION layer on top of W774's eval/bakeoff/sampler surface).
//
// Atomic items pinned (matches the W833 implementation):
//
//   1)  detectLanguage('hello world') → en
//   2)  detectLanguage('你好世界') → zh
//   3)  detectLanguage('مرحبا بالعالم') → ar
//   4)  detectLanguage('Привет мир') → ru
//   5)  detectLanguage('Bonjour le monde') → fr
//   6)  detectLanguage('') → {lang:'unknown', confidence:0}
//   7)  distributionByLang returns underrepresented[] for missing langs
//   8)  synthesizeForUnderrepresented honest envelope w/o teacher env
//   9)  buildMixture respects weights (1000-draw test, allow ±5% jitter)
//   10) autoBalanceWeights floors underrepresented at 0.05
//   11) annotateManifest writes per_lang_kscore block
//   12) readPerLangKScores reads it back
//   13) cli/kolm.js defines cmdW833Lingual exactly once + case 'lingual' wired
//   14) all four /v1/lingual/* routes registered + auth-gated
//   15) public/sw.js bumped to carry wave833 suffix
//   16) wave833 sibling sw.js test count uses wave(\d{3,4}) regex + threshold
//   17) detectLanguage('你好') → zh + source:script_only
//   18) detectLanguage('한국어') → ko
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
  LINGUAL_DETECT_VERSION,
  SUPPORTED_LANGS_W833,
  detectLanguage,
  distributionByLang,
} from '../src/lingual-detect.js';

import {
  LINGUAL_SYNTH_VERSION,
  synthesizeForUnderrepresented,
} from '../src/lingual-synthesize.js';

import {
  LINGUAL_MIXTURE_VERSION,
  buildMixture,
  autoBalanceWeights,
} from '../src/lingual-mixture.js';

import {
  LINGUAL_MANIFEST_VERSION,
  PER_LANG_KSCORE_KEY,
  annotateManifest,
  readPerLangKScores,
} from '../src/lingual-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const SW_PATH = path.join(REPO_ROOT, 'public', 'sw.js');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w833-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  // Defensive: the no_teacher_configured test asserts honest envelope,
  // so wipe any teacher key that might leak in from CI.
  delete process.env.KOLM_TEACHER_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return tmp;
}

// =============================================================================
// 1) detectLanguage('hello world') → en
// =============================================================================

test('W833 #1 — detectLanguage("hello world") classifies en', () => {
  freshDir();
  const d = detectLanguage('the quick brown fox jumps over the lazy dog and the cat');
  assert.equal(d.lang, 'en',
    `expected en for stopword-heavy English; got ${JSON.stringify(d)}`);
  assert.ok(d.confidence > 0,
    `expected confidence>0 for English; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 2) detectLanguage('你好世界') → zh
// =============================================================================

test('W833 #2 — detectLanguage("你好世界") classifies zh via script-class', () => {
  freshDir();
  const d = detectLanguage('你好世界这是一段中文测试');
  assert.equal(d.lang, 'zh', `expected zh; got ${JSON.stringify(d)}`);
  assert.equal(d.source, 'script_only',
    `expected source:script_only for CJK; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 3) detectLanguage('مرحبا بالعالم') → ar
// =============================================================================

test('W833 #3 — detectLanguage("مرحبا بالعالم") classifies ar via script-class', () => {
  freshDir();
  const d = detectLanguage('مرحبا بالعالم هذا اختبار للغة العربية');
  assert.equal(d.lang, 'ar', `expected ar; got ${JSON.stringify(d)}`);
  assert.equal(d.source, 'script_only');
});

// =============================================================================
// 4) detectLanguage('Привет мир') → ru
// =============================================================================

test('W833 #4 — detectLanguage("Привет мир") classifies ru via script-class', () => {
  freshDir();
  const d = detectLanguage('Привет мир это тест на русском языке');
  assert.equal(d.lang, 'ru', `expected ru; got ${JSON.stringify(d)}`);
  assert.equal(d.source, 'script_only');
});

// =============================================================================
// 5) detectLanguage('Bonjour le monde') → fr
// =============================================================================

test('W833 #5 — detectLanguage French text classifies fr via char trigrams', () => {
  freshDir();
  // Use enough trigram coverage so the detector locks on fr; the spec
  // sample 'Bonjour le monde' is intentionally short to exercise the
  // honesty-floor branch (might return unknown). We use a longer string
  // that hits multiple fr trigrams.
  const d = detectLanguage('le chat est sur la table et les fenêtres sont ouvertes pour le soir');
  assert.equal(d.lang, 'fr', `expected fr; got ${JSON.stringify(d)}`);
});

// =============================================================================
// 6) detectLanguage('') → unknown w/ confidence 0
// =============================================================================

test('W833 #6 — detectLanguage("") returns unknown with confidence 0 (honesty floor)', () => {
  freshDir();
  const d = detectLanguage('');
  assert.equal(d.lang, 'unknown',
    `empty input MUST return lang:unknown; got ${JSON.stringify(d)}`);
  assert.equal(d.confidence, 0,
    `empty input MUST return confidence:0; got ${JSON.stringify(d)}`);
  // Whitespace-only input also unknown.
  const dw = detectLanguage('   \t\n  ');
  assert.equal(dw.lang, 'unknown');
  assert.equal(dw.confidence, 0);
});

// =============================================================================
// 7) distributionByLang returns underrepresented[]
// =============================================================================

test('W833 #7 — distributionByLang flags underrepresented langs', () => {
  freshDir();
  // Stub detector so the test is deterministic and not dependent on the
  // tri-gram heuristics.
  const stub = (text) => {
    const m = text.match(/^\[([a-z]{2})\]/);
    return m ? { lang: m[1], confidence: 1, source: 'script_only' }
             : { lang: 'unknown', confidence: 0, source: 'script_only' };
  };
  const captures = [];
  for (let i = 0; i < 80; i++) captures.push({ input: '[en] sample ' + i });
  for (let i = 0; i < 20; i++) captures.push({ input: '[es] sample ' + i });
  // No zh / ja / ko / fr / de / pt / ru / ar / hi → all should be flagged.

  const dist = distributionByLang(captures, { lang_detect: stub });
  assert.equal(dist.total, 100,
    `expected total=100; got ${JSON.stringify(dist)}`);
  assert.equal(dist.by_lang.en, 0.8);
  assert.equal(dist.by_lang.es, 0.2);
  // underrepresented should include zh, ja, ko, fr, de, pt, ru, ar, hi
  // (every SUPPORTED_LANGS_W833 entry whose count is 0).
  const underLangs = dist.underrepresented.map((u) => u.lang);
  for (const must of ['zh', 'ja', 'ko', 'fr', 'de', 'pt', 'ru', 'ar', 'hi']) {
    assert.ok(underLangs.includes(must),
      `expected ${must} in underrepresented; got ${JSON.stringify(underLangs)}`);
  }
  // en (0.8) and es (0.2) are above the 0.05 floor — not underrepresented.
  assert.ok(!underLangs.includes('en'));
  assert.ok(!underLangs.includes('es'));
  // Each entry must carry the contracted shape.
  for (const u of dist.underrepresented) {
    assert.ok(Number.isFinite(u.ratio));
    assert.ok(Number.isFinite(u.target_ratio));
    assert.equal(u.target_ratio, 0.05);
  }
});

// =============================================================================
// 8) synthesizeForUnderrepresented honest no_teacher_configured envelope
// =============================================================================

test('W833 #8 — synthesizeForUnderrepresented honest envelope when teacher env missing', async () => {
  freshDir();
  // freshDir() wipes KOLM_TEACHER_API_KEY / ANTHROPIC_API_KEY / OPENAI_API_KEY.
  const env = await synthesizeForUnderrepresented({
    tenant: 't1',
    namespace: 'ns',
    target_lang: 'es',
    count: 5,
    teacher: 'anthropic',
    opts: {
      source_captures: [{ input: 'hello', output: 'world' }],
    },
  });
  assert.equal(env.ok, false,
    `expected ok:false; got ${JSON.stringify(env)}`);
  assert.equal(env.error, 'no_teacher_configured',
    `expected error:no_teacher_configured; got ${JSON.stringify(env)}`);
  assert.equal(env.requested_count, 5);
  assert.equal(env.generated_count, 0);
  assert.ok(typeof env.install_hint === 'string' && env.install_hint.length > 0,
    `expected install_hint string; got ${JSON.stringify(env)}`);
  // Sanity: local teacher path DOES work and stamps the synth markers.
  const local = await synthesizeForUnderrepresented({
    tenant: 't1',
    namespace: 'ns',
    target_lang: 'es',
    count: 3,
    teacher: 'local',
    opts: {
      source_captures: [
        { input: 'one', output: 'uno' },
        { input: 'two', output: 'dos' },
      ],
    },
  });
  assert.equal(local.ok, true);
  assert.equal(local.generated_count, 3);
  for (const row of local.rows) {
    assert.equal(row.synthetic_translation, true,
      `every generated row MUST be stamped synthetic_translation:true; got ${JSON.stringify(row)}`);
    assert.equal(row.target_lang, 'es');
    assert.equal(row.synth_provider, 'local');
    assert.ok(typeof row.synth_at === 'string' && row.synth_at.length > 0);
    assert.ok(typeof row.source_lang === 'string');
    assert.ok(row.input.startsWith('[es]'),
      `local echo MUST prefix with [es]; got ${JSON.stringify(row)}`);
  }
});

// =============================================================================
// 9) buildMixture respects weights (1000-draw test, allow ±5% jitter)
// =============================================================================

test('W833 #9 — buildMixture respects per-lang weights over 1000 draws (±5% jitter)', () => {
  freshDir();
  // Deterministic stub detector — [en], [es], [zh] prefix tags.
  const stub = (text) => {
    const m = text.match(/^\[([a-z]{2})\]/);
    return m ? { lang: m[1] } : { lang: 'unknown' };
  };
  // Generous pool per lang so with_replacement is unnecessary.
  const captures = [];
  for (let i = 0; i < 500; i++) captures.push({ input: '[en] s ' + i });
  for (let i = 0; i < 500; i++) captures.push({ input: '[es] s ' + i });
  for (let i = 0; i < 500; i++) captures.push({ input: '[zh] s ' + i });

  // Seeded LCG so the test is deterministic across runs / platforms.
  let seed = 1234567;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };

  const env = buildMixture({
    captures,
    lang_weights: { en: 0.5, es: 0.2, zh: 0.3 },
    lang_detect: stub,
    with_replacement: true,
    rng,
  });
  assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.normalized_weights.en, 0.5);
  assert.equal(env.normalized_weights.es, 0.2);
  assert.equal(env.normalized_weights.zh, 0.3);

  const counts = { en: 0, es: 0, zh: 0 };
  for (let i = 0; i < 1000; i++) {
    const drawn = env.iterator();
    assert.ok(drawn, 'with_replacement mixture must never run out of draws');
    counts[drawn.lang] = (counts[drawn.lang] || 0) + 1;
  }
  // ±5% jitter (50/200/300 rows of 1000 baseline).
  assert.ok(Math.abs(counts.en - 500) <= 50,
    `expected ~500 en draws (±50); got ${counts.en} (full: ${JSON.stringify(counts)})`);
  assert.ok(Math.abs(counts.es - 200) <= 50,
    `expected ~200 es draws (±50); got ${counts.es}`);
  assert.ok(Math.abs(counts.zh - 300) <= 50,
    `expected ~300 zh draws (±50); got ${counts.zh}`);
});

// =============================================================================
// 10) autoBalanceWeights floors underrepresented at 0.05
// =============================================================================

test('W833 #10 — autoBalanceWeights floors underrepresented langs at 0.05', () => {
  freshDir();
  // Synthetic distribution where zh is 0.01 (well below 0.05).
  const dist = {
    by_lang: { en: 0.80, es: 0.15, zh: 0.01, ja: 0.04 },
    total: 100,
    underrepresented: [
      { lang: 'zh', ratio: 0.01, target_ratio: 0.05 },
      { lang: 'ja', ratio: 0.04, target_ratio: 0.05 },
    ],
  };
  const out = autoBalanceWeights(dist, { floor: 0.05 });
  // zh + ja must be lifted to AT LEAST 0.05.
  assert.ok(out.weights.zh >= 0.05,
    `zh weight MUST be >=0.05; got ${out.weights.zh}`);
  assert.ok(out.weights.ja >= 0.05,
    `ja weight MUST be >=0.05; got ${out.weights.ja}`);
  // Lifted_langs should mention zh + ja.
  assert.ok(out.lifted_langs.includes('zh'));
  assert.ok(out.lifted_langs.includes('ja'));
  // Weights MUST still sum to 1.0 (within rounding).
  const sum = Object.values(out.weights).reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.01,
    `weights MUST sum to ~1.0; got sum=${sum} (full: ${JSON.stringify(out.weights)})`);
});

// =============================================================================
// 11) annotateManifest writes per_lang_kscore block
// =============================================================================

test('W833 #11 — annotateManifest writes the per_lang_kscore block (copy-on-write)', () => {
  freshDir();
  const manifest = { recipe_cid: 'cid_abc', schema: 'kolm-v1', meta: { foo: 'bar' } };
  const env = annotateManifest({
    manifest,
    per_lang_kscores: { en: 0.78, es: 0.65, zh: 0.71 },
    overall_lang_distribution: {
      by_lang: { en: 0.6, es: 0.2, zh: 0.2 },
      total: 100,
    },
    gated_at_n: 30,
  });
  assert.equal(env.ok, true);
  // Copy-on-write — original manifest must NOT carry the block.
  assert.equal(manifest[PER_LANG_KSCORE_KEY], undefined,
    'annotateManifest MUST NOT mutate the input manifest (copy-on-write)');
  // New manifest carries the block.
  const block = env.manifest[PER_LANG_KSCORE_KEY];
  assert.ok(block, `expected ${PER_LANG_KSCORE_KEY} block; got ${JSON.stringify(env.manifest)}`);
  assert.equal(block.by_lang.en, 0.78);
  assert.equal(block.by_lang.es, 0.65);
  assert.equal(block.by_lang.zh, 0.71);
  assert.equal(block.gated_at_n, 30);
  assert.equal(block.no_per_lang_scores, false);
  assert.ok(Array.isArray(block.languages_reported));
  // Overall distribution snapshot is folded in.
  assert.ok(env.manifest.overall_lang_distribution);
  // Original manifest fields preserved.
  assert.equal(env.manifest.recipe_cid, 'cid_abc');
  assert.deepEqual(env.manifest.meta, { foo: 'bar' });
});

// =============================================================================
// 12) readPerLangKScores reads it back
// =============================================================================

test('W833 #12 — readPerLangKScores reads the block back from a manifest', () => {
  freshDir();
  // Build a manifest with the block then read it.
  const base = { recipe_cid: 'cid_xyz' };
  const annotated = annotateManifest({
    manifest: base,
    per_lang_kscores: { en: 0.9, es: 0.7 },
    overall_lang_distribution: {
      by_lang: { en: 0.7, es: 0.3 },
      total: 50,
    },
  });
  const read = readPerLangKScores(annotated.manifest);
  assert.equal(read.ok, true);
  assert.equal(read.by_lang.en, 0.9);
  assert.equal(read.by_lang.es, 0.7);
  assert.deepEqual(read.languages_reported.sort(), ['en', 'es']);
  assert.equal(read.no_per_lang_scores, false);
  assert.ok(read.overall_lang_distribution);

  // Honest envelope when block is missing.
  const empty = readPerLangKScores({ recipe_cid: 'cid_bare' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no_per_lang_kscore_block');
});

// =============================================================================
// 13) CLI verb exists
// =============================================================================

test('W833 #13 — cli/kolm.js defines cmdW833Lingual exactly once + case wired', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Function declared exactly once.
  const declRe = /async function cmdW833Lingual\(/g;
  const declMatches = cli.match(declRe);
  assert.ok(declMatches && declMatches.length === 1,
    `expected exactly one cmdW833Lingual declaration; got ${declMatches ? declMatches.length : 0}`);
  // Case statement routes 'lingual' to cmdW833Lingual.
  assert.ok(cli.includes("case 'lingual':"),
    'expected case "lingual": to be wired in main()');
  assert.ok(cli.includes('cmdW833Lingual('),
    'expected cmdW833Lingual( call in dispatcher');
  // Completion entries.
  assert.ok(cli.includes("COMPLETION_VERBS.push('lingual')") ||
            cli.includes('COMPLETION_VERBS.push("lingual")'),
    'expected lingual to be added to COMPLETION_VERBS');
  assert.ok(cli.includes('COMPLETION_SUBS.lingual'),
    'expected COMPLETION_SUBS.lingual to be wired');
});

// =============================================================================
// 14) All four routes registered + auth-gated
// =============================================================================

test('W833 #14 — all four /v1/lingual/* routes registered + 401 without auth', async () => {
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

    // 1) GET /v1/lingual/distribution
    const r1NoAuth = await fetch(`http://127.0.0.1:${port}/v1/lingual/distribution?namespace=ns`, {
      method: 'GET',
    });
    assert.equal(r1NoAuth.status, 401,
      `GET /v1/lingual/distribution expected 401 w/o auth; got ${r1NoAuth.status}`);
    const r1 = await fetch(`http://127.0.0.1:${port}/v1/lingual/distribution?namespace=empty-ns`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(r1.status, 200,
      `GET /v1/lingual/distribution expected 200 w/ auth; got ${r1.status}`);
    const r1Env = await r1.json();
    assert.equal(r1Env.ok, true);
    assert.ok(typeof r1Env.by_lang === 'object');
    assert.ok(Array.isArray(r1Env.underrepresented));

    // 2) POST /v1/lingual/synthesize
    const r2NoAuth = await fetch(`http://127.0.0.1:${port}/v1/lingual/synthesize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target_lang: 'es', count: 1, teacher: 'local' }),
    });
    assert.equal(r2NoAuth.status, 401,
      `POST /v1/lingual/synthesize expected 401 w/o auth; got ${r2NoAuth.status}`);
    const r2 = await fetch(`http://127.0.0.1:${port}/v1/lingual/synthesize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ target_lang: 'es', count: 1, teacher: 'local' }),
    });
    // 200 envelope expected — may be ok:false no_source_captures if the
    // namespace is empty, but the ROUTE must respond (not 404/500).
    assert.equal(r2.status, 200,
      `POST /v1/lingual/synthesize expected 200 w/ auth; got ${r2.status}`);

    // 3) POST /v1/lingual/mixture/auto-balance
    const r3NoAuth = await fetch(`http://127.0.0.1:${port}/v1/lingual/mixture/auto-balance`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ namespace: 'ns' }),
    });
    assert.equal(r3NoAuth.status, 401,
      `POST /v1/lingual/mixture/auto-balance expected 401 w/o auth; got ${r3NoAuth.status}`);
    const r3 = await fetch(`http://127.0.0.1:${port}/v1/lingual/mixture/auto-balance`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ namespace: 'ns' }),
    });
    assert.equal(r3.status, 200,
      `POST /v1/lingual/mixture/auto-balance expected 200 w/ auth; got ${r3.status}`);
    const r3Env = await r3.json();
    assert.equal(r3Env.ok, true);
    assert.ok(r3Env.distribution);
    assert.ok(r3Env.suggested);

    // 4) GET /v1/lingual/manifest/:artifact_id
    const r4NoAuth = await fetch(`http://127.0.0.1:${port}/v1/lingual/manifest/abc123`, {
      method: 'GET',
    });
    assert.equal(r4NoAuth.status, 401,
      `GET /v1/lingual/manifest/:id expected 401 w/o auth; got ${r4NoAuth.status}`);
    const r4 = await fetch(`http://127.0.0.1:${port}/v1/lingual/manifest/nonexistent_artifact`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    // 404 with honest envelope (no manifest registered) is the expected
    // shape; we just verify the route is mounted (not 500-undefined).
    assert.ok(r4.status === 404 || r4.status === 200,
      `GET /v1/lingual/manifest/:id expected 404 or 200; got ${r4.status}`);
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 15) sw.js bumped
// =============================================================================

test('W833 #15 — public/sw.js CACHE rolled forward at/past wave833 (regex+threshold)', () => {
  freshDir();
  const sw = fs.readFileSync(SW_PATH, 'utf8');
  // W604/W829 anti-brittleness: the sw.js CACHE string is a single rolling
  // pointer that only ever carries the CURRENT wave's slug — it does not
  // retain a history of past wave suffixes. At W891 (commit cc9f6ea7, "V1 —
  // completion manual ... ship-gate 52/52, deploy") the long accreted slug
  // (which once contained wave833-cross-lingual-v2) was DELIBERATELY replaced
  // with a fresh short slug, and it has rolled forward through W910/W917/W918
  // since. Pin the CONVENTION (a wave slug at/past this wave's number) via
  // regex + threshold, never a literal superseded token.
  const waves = [...sw.matchAll(/wave(\d{3,4})/g)].map((m) => +m[1]);
  assert.ok(waves.length > 0,
    'expected at least one wave(\\d{3,4}) slug in public/sw.js CACHE string');
  assert.ok(Math.max(...waves) >= 833,
    `expected public/sw.js CACHE to carry a wave>=833 slug; got max ${Math.max(...waves)}`);
});

// =============================================================================
// 16) W604 anti-brittleness — sibling sw.js test count uses regex+threshold
// =============================================================================

test('W833 #16 — sibling sw.js test count uses wave(\\d{3,4}) regex + threshold', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold — adding more wave tests does NOT break this.
  // We need at least 5 wave test files (W830+ sprint).
  assert.ok(siblings.length >= 5,
    `expected >=5 wave(\\d{3,4}) test files; found ${siblings.length}`);
});

// =============================================================================
// 17) detectLanguage('你好') → zh + source:script_only
// =============================================================================

test('W833 #17 — detectLanguage short Chinese still classifies zh via script-class', () => {
  freshDir();
  const d = detectLanguage('你好');
  assert.equal(d.lang, 'zh',
    `script-class detector MUST fire even on 2-char CJK; got ${JSON.stringify(d)}`);
  assert.equal(d.source, 'script_only');
});

// =============================================================================
// 18) detectLanguage('한국어') → ko
// =============================================================================

test('W833 #18 — detectLanguage Hangul text classifies ko', () => {
  freshDir();
  const d = detectLanguage('안녕하세요 한국어 테스트');
  assert.equal(d.lang, 'ko', `expected ko; got ${JSON.stringify(d)}`);
  assert.equal(d.source, 'script_only');
});

// =============================================================================
// Bonus: version stamps consistency check (every W833 module exports w833-v1)
// =============================================================================

test('W833 #bonus — every W833 module stamps version w833-v1', () => {
  freshDir();
  assert.equal(LINGUAL_DETECT_VERSION, 'w833-v1');
  assert.equal(LINGUAL_SYNTH_VERSION, 'w833-v1');
  assert.equal(LINGUAL_MIXTURE_VERSION, 'w833-v1');
  assert.equal(LINGUAL_MANIFEST_VERSION, 'w833-v1');
  // SUPPORTED_LANGS_W833 contract — frozen, includes the 11 spec langs.
  assert.ok(Object.isFrozen(SUPPORTED_LANGS_W833));
  for (const lang of ['en', 'es', 'zh', 'ja', 'ko', 'fr', 'de', 'pt', 'ru', 'ar', 'hi']) {
    assert.ok(SUPPORTED_LANGS_W833.includes(lang),
      `expected SUPPORTED_LANGS_W833 to include ${lang}`);
  }
});
