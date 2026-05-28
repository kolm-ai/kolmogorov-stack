// W741 — Diagnostic envelope: per-category K-Score + recommendations.
//
// Atomic items pinned (matches the W741 implementation):
//
//   1) DIAGNOSTIC_VERSION present + stamped 'w741-v1'
//   2) categorizeCaptures: heuristic returns correct buckets for mixed mock captures
//   3) perCategoryKScore: Wilson CI present when n>=30
//   4) perCategoryKScore: Wilson CI null when n<30 (honesty contract)
//   5) generateDiagnostic: capture_more recommendation when k_score < 0.85 AND n < 200
//   6) generateDiagnostic: inspect_captures when overall low but per-category all high
//   7) generateDiagnostic: adjust_temperature when stddev high
//   8) generateDiagnostic: promote_to_production when ALL categories >= 0.95
//   9) generateDiagnostic: recommendations sorted by priority (high > medium > info)
//  10) POST /v1/diagnose 401 without auth; 200 with valid envelope
//  11) GET /v1/diagnose/:cid returns honest no_bakeoff_results_yet when none exist
//  12) public/docs/diagnose.html exists with brand-lock strings
//  13) public/account/diagnose.html exists with fetch to /v1/diagnose
//  14) cli/kolm.js defines cmdW741Diagnose exactly once + wired
//  15) vercel.json has both /docs/diagnose and /account/diagnose rewrites
//  16) wave741 sibling test count uses wave(\d{3,4}) regex + threshold
//
// W604 anti-brittleness: no explicit-array family checks. Regex + threshold
// keeps the test forward-compatible as wave-N tests get added.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  DIAGNOSTIC_VERSION,
  categorizeCaptures,
  perCategoryKScore,
  generateDiagnostic,
} from '../src/diagnostic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'diagnose.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'diagnose.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w741-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Helper: build mock captures across multiple categories.
function _makeMockCaptures() {
  const caps = [];
  // 50 multi-turn (turn_count > 1)
  for (let i = 0; i < 50; i++) {
    caps.push({ cid: 'mt-' + i, turn_count: 3, namespace: 'support' });
  }
  // 35 tool-use
  for (let i = 0; i < 35; i++) {
    caps.push({ cid: 'tu-' + i, tool_calls: [{ name: 'search' }], namespace: 'agents' });
  }
  // 10 image (under-sampled to test the n<30 path)
  for (let i = 0; i < 10; i++) {
    caps.push({ cid: 'img-' + i, media_kind: 'image', namespace: 'media' });
  }
  // 100 general (fall-through default)
  for (let i = 0; i < 100; i++) {
    caps.push({ cid: 'gen-' + i, namespace: 'default' });
  }
  return caps;
}

// Helper: build mock bakeoff rows. quality_fn maps cid → k_score so different
// tests can simulate different distributions.
function _makeMockBakeoff(caps, quality_fn) {
  return caps.map((c) => ({ cid: c.cid, k_score: quality_fn(c) }));
}

// =============================================================================
// 1) DIAGNOSTIC_VERSION present + stamped
// =============================================================================

test('W741 #1 — DIAGNOSTIC_VERSION present + stamped w741-v1', () => {
  freshDir();
  assert.equal(DIAGNOSTIC_VERSION, 'w741-v1',
    `expected DIAGNOSTIC_VERSION='w741-v1'; got ${JSON.stringify(DIAGNOSTIC_VERSION)}`);
});

// =============================================================================
// 2) categorizeCaptures: heuristic returns correct buckets for mixed captures
// =============================================================================

test('W741 #2 — categorizeCaptures buckets mixed captures correctly', () => {
  freshDir();
  const caps = _makeMockCaptures();
  const out = categorizeCaptures(caps);
  assert.ok(Array.isArray(out.categories), 'categories must be an array');
  // Map bucket-name → count for easy assertion.
  const byName = new Map(out.categories.map((c) => [c.name, c]));
  assert.equal(byName.get('multi-turn').count, 50,
    `multi-turn count expected 50; got ${byName.get('multi-turn').count}`);
  assert.equal(byName.get('tool-use').count, 35,
    `tool-use count expected 35; got ${byName.get('tool-use').count}`);
  assert.equal(byName.get('image').count, 10,
    `image count expected 10; got ${byName.get('image').count}`);
  // The 100 general captures fall through to namespace="default" (their only
  // remaining attribute), so they land in the "default" bucket — NOT
  // "general". This is the documented heuristic order.
  assert.equal(byName.get('default').count, 100,
    `default-namespace count expected 100; got ${byName.get('default')?.count}`);
  // sample_cids ≤ 3.
  for (const c of out.categories) {
    assert.ok(c.sample_cids.length <= 3,
      `sample_cids must be ≤3; got ${c.sample_cids.length} for ${c.name}`);
  }
  // Sorted by count desc.
  for (let i = 1; i < out.categories.length; i++) {
    assert.ok(out.categories[i - 1].count >= out.categories[i].count,
      `categories must be sorted by count desc; got ${JSON.stringify(out.categories.map(c => c.count))}`);
  }
  // Empty/invalid input — never throws.
  assert.deepEqual(categorizeCaptures(null), { categories: [] });
  assert.deepEqual(categorizeCaptures([]), { categories: [] });
});

// =============================================================================
// 3) perCategoryKScore: Wilson CI present when n>=30
// =============================================================================

test('W741 #3 — perCategoryKScore returns Wilson CI when n>=30', () => {
  freshDir();
  const caps = _makeMockCaptures();
  // High-quality bake: every multi-turn at k_score=0.92 so the bucket is
  // stably above gate. n=50 (>= 30) so the CI must be populated.
  const rows = _makeMockBakeoff(caps, (c) => {
    if (c.turn_count > 1) return 0.92;
    if (Array.isArray(c.tool_calls)) return 0.88;
    if (c.media_kind === 'image') return 0.7;
    return 0.96;
  });
  const out = perCategoryKScore(caps, rows);
  const byName = new Map(out.categories.map((c) => [c.name, c]));
  const mt = byName.get('multi-turn');
  assert.ok(mt, 'multi-turn category must be in output');
  assert.equal(mt.n, 50);
  assert.equal(typeof mt.k_score_ci_lo, 'number',
    `Wilson CI lo must be a number when n>=30; got ${typeof mt.k_score_ci_lo}`);
  assert.equal(typeof mt.k_score_ci_hi, 'number',
    `Wilson CI hi must be a number when n>=30; got ${typeof mt.k_score_ci_hi}`);
  assert.ok(mt.k_score_ci_lo <= mt.k_score && mt.k_score <= mt.k_score_ci_hi,
    `mean ${mt.k_score} must lie within CI [${mt.k_score_ci_lo}, ${mt.k_score_ci_hi}]`);
  // tool-use (n=35) also gets a CI.
  const tu = byName.get('tool-use');
  assert.equal(typeof tu.k_score_ci_lo, 'number',
    'tool-use n=35 >= 30 must have a CI');
});

// =============================================================================
// 4) perCategoryKScore: Wilson CI null when n<30 (honesty contract)
// =============================================================================

test('W741 #4 — perCategoryKScore returns null CI when n<30 (honesty contract)', () => {
  freshDir();
  const caps = _makeMockCaptures();
  const rows = _makeMockBakeoff(caps, () => 0.8);
  const out = perCategoryKScore(caps, rows);
  const byName = new Map(out.categories.map((c) => [c.name, c]));
  const img = byName.get('image');
  assert.ok(img, 'image bucket must exist');
  assert.equal(img.n, 10);
  assert.equal(img.k_score_ci_lo, null,
    `CI lo MUST be null when n<30; got ${JSON.stringify(img.k_score_ci_lo)}`);
  assert.equal(img.k_score_ci_hi, null,
    `CI hi MUST be null when n<30; got ${JSON.stringify(img.k_score_ci_hi)}`);
  // worst_sample_cids still present (cheap heuristic, no n gate).
  assert.ok(Array.isArray(img.worst_sample_cids));
});

// =============================================================================
// 5) generateDiagnostic: capture_more recommendation when k_score < 0.85 AND n < 200
// =============================================================================

test('W741 #5 — generateDiagnostic emits capture_more when k_score < 0.85 AND n < 200', () => {
  freshDir();
  const caps = _makeMockCaptures();
  // multi-turn deliberately fails (0.62) with n=50 → capture_more high priority
  // target_count = max(100, 200-50) = 150.
  const rows = _makeMockBakeoff(caps, (c) => {
    if (c.turn_count > 1) return 0.62;
    return 0.92;
  });
  const env = generateDiagnostic('bafkreitestcid1', rows, caps);
  assert.equal(env.ok, true);
  assert.equal(env.diagnostic_version, 'w741-v1');
  assert.equal(env.artifact_cid, 'bafkreitestcid1');
  const mtRec = env.recommendations.find((r) =>
    r.action === 'capture_more' && r.category === 'multi-turn');
  assert.ok(mtRec, `expected capture_more for multi-turn; got ${JSON.stringify(env.recommendations)}`);
  assert.equal(mtRec.priority, 'high');
  assert.equal(mtRec.target_count, 150,
    `target_count must be max(100, 200-50)=150; got ${mtRec.target_count}`);
  assert.ok(typeof mtRec.reason === 'string' && mtRec.reason.includes('0.85'),
    'reason must mention the threshold');
});

// =============================================================================
// 6) generateDiagnostic: inspect_captures when overall low but per-cat all high
// =============================================================================

test('W741 #6 — generateDiagnostic emits inspect_captures when overall < 0.85 but per-category all >= 0.85', () => {
  freshDir();
  // Construct a synthetic distribution where every per-cat mean is >= 0.85
  // BUT the unweighted overall (mean over all rows) is < 0.85. We do this by
  // making the cat-counts proportionally lopsided AND injecting some low
  // outliers below the per-cat mean cap. The simplest way: two categories,
  // 50 rows each with k=0.9 — but then add 200 raw "uncategorised" rows
  // (no matching capture) with k=0.7 so overall is pulled down.
  //
  // Wait — perCategoryKScore only includes rows whose cid matches a capture.
  // So we need a third path. Easier: construct categories that ALL pass
  // and overall is the unweighted mean over bakeoff rows; the rows include
  // entries that have NO matching capture (so they don't show up per-cat
  // but DO show up in the overall_k_score mean).
  const caps = [];
  for (let i = 0; i < 30; i++) caps.push({ cid: 'a-' + i, namespace: 'aaa' });
  for (let i = 0; i < 30; i++) caps.push({ cid: 'b-' + i, namespace: 'bbb' });
  const matchedRows = caps.map((c) => ({ cid: c.cid, k_score: 0.9 }));
  const unmatchedLowRows = [];
  for (let i = 0; i < 100; i++) unmatchedLowRows.push({ cid: 'orphan-' + i, k_score: 0.5 });
  const rows = [...matchedRows, ...unmatchedLowRows];
  const env = generateDiagnostic('bafkreitestcid2', rows, caps);
  assert.equal(env.ok, true);
  assert.ok(env.overall_k_score < 0.85,
    `overall must be < 0.85 for this test; got ${env.overall_k_score}`);
  // Every per-cat must be >= 0.85.
  for (const c of env.per_category) {
    assert.ok(c.k_score >= 0.85,
      `per-cat ${c.name} must be >= 0.85; got ${c.k_score}`);
  }
  const insp = env.recommendations.find((r) => r.action === 'inspect_captures');
  assert.ok(insp, `expected inspect_captures rec; got ${JSON.stringify(env.recommendations)}`);
  assert.equal(insp.priority, 'medium');
});

// =============================================================================
// 7) generateDiagnostic: adjust_temperature when stddev high
// =============================================================================

test('W741 #7 — generateDiagnostic emits adjust_temperature when stddev > 0.15 AND n >= 30', () => {
  freshDir();
  const caps = [];
  for (let i = 0; i < 40; i++) caps.push({ cid: 'hv-' + i, namespace: 'high-variance' });
  // Half high (0.95), half low (0.55) → mean = 0.75, stddev = 0.2 (> 0.15).
  const rows = caps.map((c, i) => ({ cid: c.cid, k_score: i % 2 === 0 ? 0.95 : 0.55 }));
  const env = generateDiagnostic('bafkreitestcid3', rows, caps);
  assert.equal(env.ok, true);
  const at = env.recommendations.find((r) => r.action === 'adjust_temperature');
  assert.ok(at, `expected adjust_temperature; got ${JSON.stringify(env.recommendations)}`);
  assert.equal(at.from, 0.7);
  assert.equal(at.to, 0.4);
  assert.equal(at.priority, 'medium');
  assert.equal(at.category, 'high-variance');
});

// =============================================================================
// 8) generateDiagnostic: promote_to_production when ALL categories >= 0.95
// =============================================================================

test('W741 #8 — generateDiagnostic emits promote_to_production when ALL categories >= 0.95', () => {
  freshDir();
  const caps = [];
  for (let i = 0; i < 35; i++) caps.push({ cid: 'g-' + i, namespace: 'good1' });
  for (let i = 0; i < 35; i++) caps.push({ cid: 'h-' + i, namespace: 'good2' });
  const rows = caps.map((c) => ({ cid: c.cid, k_score: 0.96 }));
  const env = generateDiagnostic('bafkreitestcid4', rows, caps);
  assert.equal(env.ok, true);
  assert.equal(env.recommendations.length, 1,
    `promote_to_production must be the SOLE recommendation; got ${JSON.stringify(env.recommendations)}`);
  assert.equal(env.recommendations[0].action, 'promote_to_production');
  assert.equal(env.recommendations[0].priority, 'info');
});

// =============================================================================
// 9) generateDiagnostic: recommendations sorted by priority (high > medium > info)
// =============================================================================

test('W741 #9 — recommendations sorted by priority (high > medium > info)', () => {
  freshDir();
  // Build a scenario that fires (capture_more=high) + (adjust_temperature=medium)
  // simultaneously: a 40-row category with mean 0.75 and high variance.
  const caps = [];
  for (let i = 0; i < 40; i++) caps.push({ cid: 'mix-' + i, namespace: 'mixed' });
  // half 0.95, half 0.55 → mean 0.75, stddev ~0.2.
  const rows = caps.map((c, i) => ({ cid: c.cid, k_score: i % 2 === 0 ? 0.95 : 0.55 }));
  const env = generateDiagnostic('bafkreitestcid5', rows, caps);
  assert.equal(env.ok, true);
  const recs = env.recommendations;
  assert.ok(recs.length >= 2, `expected >=2 recs; got ${recs.length}`);
  const PR = { high: 0, medium: 1, info: 2 };
  for (let i = 1; i < recs.length; i++) {
    assert.ok((PR[recs[i - 1].priority] ?? 99) <= (PR[recs[i].priority] ?? 99),
      `recs MUST be sorted high→medium→info; got ${recs.map(r => r.priority).join(',')}`);
  }
  // Must contain at least one high (capture_more).
  assert.ok(recs.some(r => r.priority === 'high'),
    `expected at least one high-priority rec; got ${JSON.stringify(recs)}`);
});

// =============================================================================
// 10) POST /v1/diagnose 401 without auth; 200 with valid envelope
// =============================================================================

test('W741 #10 — POST /v1/diagnose 401 without auth; 200 with envelope on auth', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

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
    // 10a — no auth → 401.
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/diagnose`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ artifact_cid: 'bafkreiwhatever' }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      noAuthBody.error === 'missing api key' || noAuthBody.error === 'auth_required',
      `expected auth-failure error; got ${JSON.stringify(noAuthBody)}`,
    );
    // 10b — auth + injected synthetic bakeoff → 200 with valid envelope.
    const caps = [
      { cid: 'inj-1', namespace: 'a' },
      { cid: 'inj-2', namespace: 'a' },
      { cid: 'inj-3', namespace: 'b' },
    ];
    const bakeRows = caps.map((c) => ({ cid: c.cid, k_score: 0.9 }));
    const auth = await fetch(`http://127.0.0.1:${port}/v1/diagnose`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        artifact_cid: 'bafkreiwhatever',
        _diagnose_bakeoff_rows: bakeRows,
        _diagnose_captures: caps,
      }),
    });
    assert.equal(auth.status, 200, `expected 200; got ${auth.status}`);
    const env = await auth.json();
    assert.equal(env.ok, true,
      `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.diagnostic_version, 'w741-v1');
    assert.equal(env.artifact_cid, 'bafkreiwhatever');
    assert.ok(typeof env.overall_k_score === 'number');
    assert.ok(Array.isArray(env.per_category));
    assert.ok(Array.isArray(env.recommendations));
    // 10c — auth + missing artifact_cid → 400 missing_field.
    const missField = await fetch(`http://127.0.0.1:${port}/v1/diagnose`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missField.status, 400);
    const missBody = await missField.json();
    assert.equal(missBody.error, 'missing_field');
    assert.equal(missBody.field, 'artifact_cid');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 11) GET /v1/diagnose/:cid returns honest no_bakeoff_results_yet when none exist
// =============================================================================

test('W741 #11 — GET /v1/diagnose/:cid returns honest no_bakeoff_results_yet envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(process.env.KOLM_DATA_DIR, 'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite');

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
    const res = await fetch(`http://127.0.0.1:${port}/v1/diagnose/bafkreinobakeoff`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(res.status, 200,
      `must be 200 (HTTP succeeded; envelope says no_bakeoff_results_yet); got ${res.status}`);
    const env = await res.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'no_bakeoff_results_yet',
      `expected no_bakeoff_results_yet; got ${JSON.stringify(env)}`);
    assert.equal(env.artifact_cid, 'bafkreinobakeoff');
    assert.ok(typeof env.hint === 'string' && env.hint.includes('bakeoff'),
      `hint must mention bakeoff; got ${JSON.stringify(env.hint)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) public/docs/diagnose.html exists with brand-lock strings
// =============================================================================

test('W741 #12 — public/docs/diagnose.html exists with brand-lock + schema content', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',                  // brand
    'class="ks-nav"',           // nav shell
    'ks-foot',                  // footer shell (W902 unified ks-footer→ks-foot BEM across 642 pages, commit fe519704)
    'AI workbench',             // W741 brand lock
    'Frontier AI on your own infrastructure', // W741 H1 brand lock (footer tagline)
    'w741-v1',                  // version stamp
    'multi-turn',               // canonical category
    'capture_more',             // recommendation enum
    'adjust_temperature',       // recommendation enum
    'inspect_captures',         // recommendation enum
    'promote_to_production',    // recommendation enum
    'Wilson',                   // CI methodology
    '/v1/diagnose',             // API surface
    'no_bakeoff_results_yet',   // honest absence
  ]) {
    assert.ok(html.includes(needle),
      `diagnose.html must mention "${needle}"`);
  }
});

// =============================================================================
// 13) public/account/diagnose.html exists with fetch to /v1/diagnose
// =============================================================================

test('W741 #13 — public/account/diagnose.html exists with fetch to /v1/diagnose', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',
    'class="ks-nav"',
    '/v1/diagnose',             // fetch target
    'kfetch',                   // shared fetch helper
    'cid',                      // URL query param
    'recommendation',           // rec rendering
    'per_category',             // category rendering
    'AI workbench',             // brand lock
  ]) {
    assert.ok(html.includes(needle),
      `account/diagnose.html must mention "${needle}"`);
  }
});

// =============================================================================
// 14) cli/kolm.js defines cmdW741Diagnose exactly once + wired
// =============================================================================

test('W741 #14 — cli/kolm.js defines cmdW741Diagnose dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const defs = cli.match(/async function cmdW741Diagnose\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW741Diagnose dispatcher definition; got ${defs.length}`);
  assert.ok(/case\s+['"]diagnose['"]/.test(cli),
    `cli must have a case 'diagnose' arm`);
  assert.ok(cli.includes('cmdW741Diagnose(rest)'),
    `cmdW741Diagnose must be invoked with the rest args`);
});

// =============================================================================
// 15) vercel.json has both /docs/diagnose and /account/diagnose rewrites
// =============================================================================

test('W741 #15 — vercel.json contains /docs/diagnose + /account/diagnose rewrites', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = (v.rewrites || []);
  const docRewrite = rewrites.find((r) => r.source === '/docs/diagnose');
  assert.ok(docRewrite, '/docs/diagnose rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/diagnose.html');
  const acctRewrite = rewrites.find((r) => r.source === '/account/diagnose');
  assert.ok(acctRewrite, '/account/diagnose rewrite must exist in vercel.json');
  assert.equal(acctRewrite.destination, '/account/diagnose.html');
});

// =============================================================================
// 16) wave741 sibling test count uses wave(\d{3,4}) regex + threshold
// =============================================================================

test('W741 #16 — wave741 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  // Forward-compatible threshold: at least 3 wave-test files MUST exist.
  // Adding more wave tests does NOT break this assertion.
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});
