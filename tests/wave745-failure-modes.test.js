// W745 — Failure-mode dashboard (CID-keyed) tests.
//
// W745 is the CID-keyed sibling of W812 (src/failure-modes.js, which clusters
// tenant-wide event streams). Both modules coexist on purpose; this file
// imports from src/failure-modes-w745.js so W812 tests are unaffected.
//
// Atomic items pinned (matches the W745 implementation):
//
//   1) FAILURE_MODES_VERSION present + stamped 'w745-v1' (distinct from W812)
//   2) clusterByKeywords: deterministic — same input → same cluster_ids
//   3) clusterByKeywords: min_cluster_size drops sub-threshold clusters
//   4) clusterByKeywords: empty/invalid input → []
//   5) clusterKScore: Wilson 95% CI present when n>=30
//   6) clusterKScore: Wilson CI null when n<30 (honesty contract)
//   7) topRegressions: sorts by delta_vs_overall desc + caps at top_n
//   8) generateFailureModeReport: honesty fields + diagnostic_link bridge
//   9) generateFailureModeReport: no_bakeoff_results_yet empty envelope
//  10) GET /v1/failure-modes/:cid 401 without auth; 200 with envelope on auth
//  11) POST /v1/failure-modes returns honest envelope on injected rows
//  12) public/docs/failure-modes.html brand-lock + heuristic explanation
//  13) public/account/failure-modes.html brand-lock + W745 panel + diagnostic bridge
//  14) cli/kolm.js defines cmdW745FailureModes exactly once + wired from case 'failure-modes'
//  15) vercel.json has both /docs/failure-modes and /account/failure-modes rewrites
//  16) wave745 sibling test count uses wave(\d{3,4}) regex + threshold (W604 anti-brittleness)
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
  FAILURE_MODES_VERSION,
  clusterByKeywords,
  clusterKScore,
  topRegressions,
  generateFailureModeReport,
} from '../src/failure-modes-w745.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'failure-modes.html');
const ACCT_PATH = path.join(REPO_ROOT, 'public', 'account', 'failure-modes.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w745-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// Helper: build N captures that share a strong topical cluster on one keyword.
// All N captures share "refund" + "refund order" 2-gram so they cluster
// together deterministically.
function _refundCaps(n, prefix) {
  const caps = [];
  for (let i = 0; i < n; i++) {
    caps.push({
      cid: prefix + '-' + i,
      input: 'customer wants refund for refund order number ' + i + ' please refund quickly',
    });
  }
  return caps;
}

function _billingCaps(n, prefix) {
  const caps = [];
  for (let i = 0; i < n; i++) {
    caps.push({
      cid: prefix + '-' + i,
      input: 'billing dispute escalation for charge ' + i + ' billing dispute resolution needed',
    });
  }
  return caps;
}

// =============================================================================
// 1) FAILURE_MODES_VERSION present + stamped
// =============================================================================

test('W745 #1 — FAILURE_MODES_VERSION present + stamped w745-v1 (distinct from W812)', () => {
  freshDir();
  assert.equal(FAILURE_MODES_VERSION, 'w745-v1',
    `expected FAILURE_MODES_VERSION='w745-v1'; got ${JSON.stringify(FAILURE_MODES_VERSION)}`);
});

// =============================================================================
// 2) clusterByKeywords deterministic — same input → same cluster_ids
// =============================================================================

test('W745 #2 — clusterByKeywords deterministic on identical input', () => {
  freshDir();
  const caps = _refundCaps(12, 'r');
  const out1 = clusterByKeywords(caps);
  const out2 = clusterByKeywords(caps);
  assert.ok(Array.isArray(out1), 'output must be an array');
  assert.ok(out1.length > 0, 'at least one cluster must form on 12 identical refund captures');
  assert.deepEqual(
    out1.map((c) => c.cluster_id),
    out2.map((c) => c.cluster_id),
    'cluster_ids MUST be deterministic on identical input',
  );
  // top_keywords slice ≤ 5; sample_cids ≤ 3.
  for (const c of out1) {
    assert.ok(c.top_keywords.length <= 5, `top_keywords ≤5; got ${c.top_keywords.length}`);
    assert.ok(c.sample_cids.length <= 3, `sample_cids ≤3; got ${c.sample_cids.length}`);
    assert.ok(c.cluster_id.startsWith('cluster_'),
      `cluster_id must start with "cluster_"; got ${c.cluster_id}`);
  }
});

// =============================================================================
// 3) clusterByKeywords min_cluster_size drops sub-threshold clusters
// =============================================================================

test('W745 #3 — clusterByKeywords drops clusters below min_cluster_size', () => {
  freshDir();
  // 5 refund captures — below default 10 → dropped entirely.
  const small = _refundCaps(5, 'small');
  const outDefault = clusterByKeywords(small);
  assert.equal(outDefault.length, 0,
    `5 captures < default min_cluster_size=10 must drop everything; got ${outDefault.length}`);
  // Same 5 but with override min_cluster_size=3 → cluster survives.
  const outOverride = clusterByKeywords(small, { min_cluster_size: 3 });
  assert.ok(outOverride.length >= 1,
    `with min_cluster_size=3 the 5-row cluster must survive; got ${outOverride.length}`);
});

// =============================================================================
// 4) clusterByKeywords empty/invalid input → []
// =============================================================================

test('W745 #4 — clusterByKeywords returns [] for empty/invalid input', () => {
  freshDir();
  assert.deepEqual(clusterByKeywords(null), []);
  assert.deepEqual(clusterByKeywords(undefined), []);
  assert.deepEqual(clusterByKeywords([]), []);
  assert.deepEqual(clusterByKeywords('not-an-array'), []);
  // Captures lacking any usable text are dropped silently — output stays [].
  const textless = [{ cid: 'a' }, { cid: 'b' }, { cid: 'c' }];
  assert.deepEqual(clusterByKeywords(textless, { min_cluster_size: 1 }), []);
});

// =============================================================================
// 5) clusterKScore: Wilson 95% CI present when n>=30
// =============================================================================

test('W745 #5 — clusterKScore returns Wilson CI when n>=30', () => {
  freshDir();
  const caps = _refundCaps(35, 'r');
  const clusters = clusterByKeywords(caps);
  assert.ok(clusters.length >= 1, 'at least one cluster must form');
  const cluster = clusters[0];
  const rows = cluster._all_cids.map((cid) => ({ cid, k_score: 0.9 }));
  const score = clusterKScore(cluster, rows);
  assert.equal(score.cluster_id, cluster.cluster_id);
  assert.ok(score.n >= 30, `n must be >=30; got ${score.n}`);
  assert.equal(typeof score.k_score_ci_lo, 'number',
    `CI lo must be a number when n>=30; got ${typeof score.k_score_ci_lo}`);
  assert.equal(typeof score.k_score_ci_hi, 'number',
    `CI hi must be a number when n>=30; got ${typeof score.k_score_ci_hi}`);
  assert.ok(score.k_score_ci_lo <= score.k_score && score.k_score <= score.k_score_ci_hi,
    `mean ${score.k_score} must lie within CI [${score.k_score_ci_lo}, ${score.k_score_ci_hi}]`);
});

// =============================================================================
// 6) clusterKScore: Wilson CI null when n<30 (honesty contract)
// =============================================================================

test('W745 #6 — clusterKScore returns null CI when n<30 (honesty contract)', () => {
  freshDir();
  // Force a small cluster by lowering min_cluster_size.
  const caps = _refundCaps(15, 'r');
  const clusters = clusterByKeywords(caps, { min_cluster_size: 5 });
  assert.ok(clusters.length >= 1, 'cluster must form with min_cluster_size=5');
  const cluster = clusters[0];
  const rows = cluster._all_cids.map((cid) => ({ cid, k_score: 0.7 }));
  const score = clusterKScore(cluster, rows);
  assert.ok(score.n < 30, `n must be <30 for this test; got ${score.n}`);
  assert.equal(score.k_score_ci_lo, null,
    `CI lo MUST be null when n<30; got ${JSON.stringify(score.k_score_ci_lo)}`);
  assert.equal(score.k_score_ci_hi, null,
    `CI hi MUST be null when n<30; got ${JSON.stringify(score.k_score_ci_hi)}`);
  assert.equal(typeof score.k_score, 'number',
    `k_score must still be a number (mean is computable on any n>0); got ${typeof score.k_score}`);
});

// =============================================================================
// 7) topRegressions: sorts by delta_vs_overall desc + caps at top_n
// =============================================================================

test('W745 #7 — topRegressions sorts by delta desc and caps at top_n', () => {
  freshDir();
  const clusters = [
    { cluster_id: 'cluster_aaa', k_score: 0.97 }, // delta = 0.80-0.97 = -0.17 (above overall, ignored)
    { cluster_id: 'cluster_bbb', k_score: 0.62 }, // delta = +0.18 (biggest regression)
    { cluster_id: 'cluster_ccc', k_score: 0.78 }, // delta = +0.02
    { cluster_id: 'cluster_ddd', k_score: 0.71 }, // delta = +0.09
    { cluster_id: 'cluster_eee', k_score: null },  // dropped
    { cluster_id: 'cluster_fff', k_score: 0.85 }, // delta = -0.05
  ];
  const overall = 0.80;
  const out = topRegressions(clusters, overall, { top_n: 3 });
  assert.equal(out.length, 3, `top_n=3 must cap output to 3; got ${out.length}`);
  // The biggest regression (bbb, +0.18) must come first.
  assert.equal(out[0].cluster_id, 'cluster_bbb');
  // Output must be sorted by delta_vs_overall desc.
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i - 1].delta_vs_overall >= out[i].delta_vs_overall,
      `out must be sorted desc; got ${out.map((c) => c.delta_vs_overall).join(',')}`);
  }
  // null k_score must be dropped entirely.
  assert.equal(out.find((c) => c.cluster_id === 'cluster_eee'), undefined,
    'cluster with null k_score must be dropped');
  // Empty / non-finite overall short-circuits.
  assert.deepEqual(topRegressions([], 0.5), []);
  assert.deepEqual(topRegressions(clusters, NaN), []);
});

// =============================================================================
// 8) generateFailureModeReport: honesty fields + diagnostic_link bridge
// =============================================================================

test('W745 #8 — generateFailureModeReport carries honesty fields + W741 bridge', () => {
  freshDir();
  const caps = [..._refundCaps(15, 'r'), ..._billingCaps(15, 'b')];
  const rows = caps.map((c) => {
    // refunds high, billing low — the spec's canonical example.
    const isRefund = c.cid.startsWith('r-');
    return { cid: c.cid, k_score: isRefund ? 0.97 : 0.62 };
  });
  const env = generateFailureModeReport('bafkreiw745test1', caps, rows);
  assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
  assert.equal(env.failure_modes_version, 'w745-v1');
  assert.equal(env.artifact_cid, 'bafkreiw745test1');
  // honest about the W757 placeholder
  assert.equal(env.clustering, 'heuristic_keyword_v1',
    `clustering MUST be 'heuristic_keyword_v1' (NOT 'w757_fingerprint' yet); got ${env.clustering}`);
  // W741 bridge
  assert.equal(env.diagnostic_link, '/account/diagnose?cid=bafkreiw745test1',
    `diagnostic_link must bridge to W741; got ${env.diagnostic_link}`);
  assert.ok(typeof env.overall_k_score === 'number');
  assert.ok(typeof env.cluster_count === 'number');
  assert.ok(Array.isArray(env.clusters));
  assert.ok(Array.isArray(env.top_regressions));
  // generated_at ISO-8601 timestamp.
  assert.match(env.generated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

// =============================================================================
// 9) generateFailureModeReport: no_bakeoff_results_yet empty envelope
// =============================================================================

test('W745 #9 — generateFailureModeReport emits no_bakeoff_results_yet on empty rows', () => {
  freshDir();
  const env = generateFailureModeReport('bafkreiw745test2', [], []);
  assert.equal(env.ok, false);
  assert.equal(env.error, 'no_bakeoff_results_yet');
  assert.equal(env.failure_modes_version, 'w745-v1');
  assert.equal(env.artifact_cid, 'bafkreiw745test2');
  assert.equal(env.clustering, 'heuristic_keyword_v1');
  assert.ok(typeof env.hint === 'string' && env.hint.includes('bakeoff'),
    `hint must mention kolm bakeoff; got ${JSON.stringify(env.hint)}`);
  // Even on empty bakeoff, the diagnostic_link bridge is present so the UI
  // can offer the W741 pivot immediately.
  assert.equal(env.diagnostic_link, '/account/diagnose?cid=bafkreiw745test2');
  // Missing artifact_cid → distinct error.
  const env2 = generateFailureModeReport(null, [], [{ cid: 'x', k_score: 0.9 }]);
  assert.equal(env2.ok, false);
  assert.equal(env2.error, 'artifact_cid_required');
});

// =============================================================================
// 10) GET /v1/failure-modes/:cid 401 without auth; 200 with envelope on auth
// =============================================================================

test('W745 #10 — GET /v1/failure-modes/:cid 401 without auth, 200 with auth', async () => {
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
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/failure-modes/bafkreiw745`, {
      method: 'GET',
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      noAuthBody.error === 'missing api key' || noAuthBody.error === 'auth_required',
      `expected auth-failure error; got ${JSON.stringify(noAuthBody)}`,
    );
    // 10b — auth + bakeoff registry empty → 200 + no_bakeoff_results_yet honest envelope.
    const auth = await fetch(`http://127.0.0.1:${port}/v1/failure-modes/bafkreiw745`, {
      method: 'GET',
      headers: { 'authorization': 'Bearer ' + t.api_key },
    });
    assert.equal(auth.status, 200,
      `must be 200 (envelope answers; not 404); got ${auth.status}`);
    const env = await auth.json();
    assert.equal(env.ok, false);
    assert.equal(env.error, 'no_bakeoff_results_yet');
    assert.equal(env.artifact_cid, 'bafkreiw745');
    assert.equal(env.failure_modes_version, 'w745-v1');
    assert.equal(env.clustering, 'heuristic_keyword_v1');
    assert.equal(env.diagnostic_link, '/account/diagnose?cid=bafkreiw745');
  } finally {
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 11) POST /v1/failure-modes returns honest envelope on injected rows
// =============================================================================

test('W745 #11 — POST /v1/failure-modes returns 200 envelope on injected synthetic bakeoff', async () => {
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
    const caps = [..._refundCaps(12, 'rr'), ..._billingCaps(12, 'bb')];
    const rows = caps.map((c) => ({
      cid: c.cid,
      k_score: c.cid.startsWith('rr-') ? 0.97 : 0.62,
    }));
    // 11a — auth + injected rows → 200 ok envelope.
    const auth = await fetch(`http://127.0.0.1:${port}/v1/failure-modes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({
        artifact_cid: 'bafkreiw745post',
        _failure_modes_bakeoff_rows: rows,
        _failure_modes_captures: caps,
      }),
    });
    assert.equal(auth.status, 200, `expected 200; got ${auth.status}`);
    const env = await auth.json();
    assert.equal(env.ok, true, `expected ok envelope; got ${JSON.stringify(env)}`);
    assert.equal(env.failure_modes_version, 'w745-v1');
    assert.equal(env.artifact_cid, 'bafkreiw745post');
    assert.equal(env.clustering, 'heuristic_keyword_v1');
    assert.equal(env.diagnostic_link, '/account/diagnose?cid=bafkreiw745post');
    assert.ok(typeof env.overall_k_score === 'number');
    assert.ok(Array.isArray(env.clusters));
    assert.ok(Array.isArray(env.top_regressions));
    // 11b — auth + missing artifact_cid → 400 missing_field.
    const missField = await fetch(`http://127.0.0.1:${port}/v1/failure-modes`, {
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
    await new Promise((r) => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) public/docs/failure-modes.html brand-lock + heuristic explanation
// =============================================================================

test('W745 #12 — public/docs/failure-modes.html exists with brand-lock + schema', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH), `expected doc file at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',                                      // brand
    'AI workbench',                                 // W745 brand lock (eyebrow)
    'Frontier AI on your own infrastructure',       // W745 H1 brand lock (footer tagline)
    'w745-v1',                                      // version stamp
    'heuristic_keyword_v1',                         // clustering honesty placeholder
    'cluster_id',                                   // canonical envelope field
    'cluster_count',                                // canonical envelope field
    'diagnostic_link',                              // W741 bridge field
    'Wilson',                                       // CI methodology
    '/v1/failure-modes',                            // API surface
    'no_bakeoff_results_yet',                       // honest absence
    'refund',                                       // spec-canonical example
    'billing',                                      // spec-canonical example
  ]) {
    assert.ok(html.includes(needle),
      `docs/failure-modes.html must mention "${needle}"`);
  }
});

// =============================================================================
// 13) public/account/failure-modes.html brand-lock + W745 panel + W741 bridge
// =============================================================================

test('W745 #13 — public/account/failure-modes.html exists with W745 panel + W741 diagnostic bridge', () => {
  freshDir();
  assert.ok(fs.existsSync(ACCT_PATH), `expected account page at ${ACCT_PATH}`);
  const html = fs.readFileSync(ACCT_PATH, 'utf8');
  for (const needle of [
    'kolm.ai',                                      // brand
    'AI workbench',                                 // brand-lock eyebrow
    'Frontier AI on your own infrastructure',       // brand-lock H1
    '/v1/failure-modes',                            // fetch target
    'kfetch',                                       // shared fetch helper
    'cid',                                          // URL query param
    'w745-panel',                                   // W745 dashboard panel id
    'heuristic_keyword_v1',                         // honesty placeholder
    '/account/diagnose',                            // W745-4 bridge to W741
  ]) {
    assert.ok(html.includes(needle),
      `account/failure-modes.html must mention "${needle}"`);
  }
});

// =============================================================================
// 14) cli/kolm.js defines cmdW745FailureModes exactly once + wired from case 'failure-modes'
// =============================================================================

test('W745 #14 — cli/kolm.js defines cmdW745FailureModes dispatcher exactly once + routed', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  // Match `async function cmdW745FailureModes(` exactly once.
  const defs = cli.match(/async function cmdW745FailureModes\s*\(/g) || [];
  assert.equal(defs.length, 1,
    `expected exactly 1 cmdW745FailureModes dispatcher definition; got ${defs.length}`);
  // Must be wired from `case 'failure-modes':`.
  assert.ok(/case\s+['"]failure-modes['"]/.test(cli),
    `cli must have a case 'failure-modes' arm`);
  assert.ok(cli.includes('cmdW745FailureModes(rest)'),
    `cmdW745FailureModes must be invoked with the rest args (CID-keyed dispatch)`);
});

// =============================================================================
// 15) vercel.json has both /docs/failure-modes and /account/failure-modes rewrites
// =============================================================================

test('W745 #15 — vercel.json contains /docs/failure-modes + /account/failure-modes rewrites', () => {
  freshDir();
  const v = JSON.parse(fs.readFileSync(VERCEL_PATH, 'utf8'));
  const rewrites = (v.rewrites || []);
  const docRewrite = rewrites.find((r) => r.source === '/docs/failure-modes');
  assert.ok(docRewrite, '/docs/failure-modes rewrite must exist in vercel.json');
  assert.equal(docRewrite.destination, '/docs/failure-modes.html');
  const acctRewrite = rewrites.find((r) => r.source === '/account/failure-modes');
  assert.ok(acctRewrite, '/account/failure-modes rewrite must exist in vercel.json');
  assert.equal(acctRewrite.destination, '/account/failure-modes.html');
});

// =============================================================================
// 16) wave745 sibling test count uses wave(\d{3,4}) regex + threshold
// =============================================================================

test('W745 #16 — wave745 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
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
