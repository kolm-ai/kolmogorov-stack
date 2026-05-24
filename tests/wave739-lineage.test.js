// W739 — Model lineage tracking + diff tests.
//
// Atomic items pinned (matches the W739 implementation):
//
//   1) LINEAGE_VERSION constant present + equals 'w739-v1'
//   2) setParentCid validates 64-hex; rejects bad input
//   3) walkLineage walks a 3-deep chain with a mock loader; depth + chain shape
//   4) walkLineage cycle-safety: A->B->A terminates with truncated:true
//   5) walkLineage max_depth is respected (chain longer than max_depth flags truncated)
//   6) compareArtifactPerformance: ANY axis drop >0.02 => recommendation='roll_back'
//   7) compareArtifactPerformance: ALL axes improve/unchanged => recommendation='promote'
//   8) compareArtifactPerformance: mixed-but-no-big-drop => 'inconclusive'
//   9) W460 BYTE-STABILITY LOCK-IN: artifact_hash with parent_cid=null AND
//      without parent_cid kwarg => IDENTICAL hashes (manifest_hash + cid)
//  10) diffArtifacts on real built .kolm files: correct lineage_relation + performance
//  11) POST /v1/artifact/diff returns 401 without bearer; 200 with valid envelope
//  12) POST /v1/artifact/lineage returns walked chain
//  13) public/docs/lineage.html exists with brand-lock strings + sections
//  14) vercel.json has /docs/lineage -> /docs/lineage.html rewrite
//  15) cli/kolm.js defines cmdW739Lineage + cmdW739Diff dispatchers exactly once each
//  16) wave739 sibling test count uses wave(\d{3,4}) regex + threshold (no explicit array)
//
// W604 anti-brittleness: no explicit-array family checks, no exact-string
// matches on free-form messages. Assertions key on load-bearing tokens
// (version stamp, snake_case codes, file existence, JSON.parse success,
// envelope shape, dispatcher symbol presence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  LINEAGE_VERSION,
  setParentCid,
  getParentCid,
  walkLineage,
  compareArtifactPerformance,
} from '../src/artifact-lineage.js';

import {
  KOLM_DIFF_VERSION,
  diffArtifacts,
  diffManifests,
} from '../src/kolm-diff.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(REPO_ROOT, 'public', 'docs', 'lineage.html');
const CLI_PATH = path.join(REPO_ROOT, 'cli', 'kolm.js');
const VERCEL_PATH = path.join(REPO_ROOT, 'vercel.json');
const TESTS_DIR = __dirname;

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w739-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_HOME = path.join(tmp, '.kolm');
  process.env.KOLM_ENV = 'test';
  process.env.RECIPE_RECEIPT_SECRET = 'kolm-public-fixture-v0-1-0';
  return tmp;
}

// 64-hex helpers for the lineage chain.
function hex64(seed) {
  return crypto.createHash('sha256').update(String(seed)).digest('hex');
}

// =============================================================================
// 1) LINEAGE_VERSION constant
// =============================================================================

test('W739 #1 — LINEAGE_VERSION is "w739-v1"', () => {
  freshDir();
  assert.equal(LINEAGE_VERSION, 'w739-v1',
    `expected version 'w739-v1'; got ${JSON.stringify(LINEAGE_VERSION)}`);
  assert.equal(KOLM_DIFF_VERSION, 'w739-v1',
    `expected KOLM_DIFF_VERSION 'w739-v1'; got ${JSON.stringify(KOLM_DIFF_VERSION)}`);
});

// =============================================================================
// 2) setParentCid validates 64-hex; rejects bad input
// =============================================================================

test('W739 #2 — setParentCid validates 64-hex string; rejects malformed input', () => {
  freshDir();
  const cid = hex64('parent-1');
  const m = { spec: 'kolm-1', cid: 'self-cid' };
  const out = setParentCid(m, cid);
  assert.equal(out.parent_cid, cid, 'must set parent_cid on returned manifest');
  assert.equal(getParentCid(out), cid, 'getParentCid round-trips a valid cid');
  // Null path: strips the key entirely so byte-stability holds.
  const m2 = { spec: 'kolm-1', parent_cid: cid };
  const out2 = setParentCid(m2, null);
  assert.equal('parent_cid' in out2, false,
    `null parent_cid must remove the key (got: ${JSON.stringify(out2)})`);
  assert.equal(getParentCid(out2), null);
  // Bad inputs throw.
  assert.throws(() => setParentCid(m, 'too-short'), /sha256-hex/);
  assert.throws(() => setParentCid(m, 'ZZZZ' + 'a'.repeat(60)),
    /sha256-hex/, 'uppercase / non-hex must throw');
  assert.throws(() => setParentCid(m, 'a'.repeat(65)),
    /sha256-hex/, '65 chars must throw');
  assert.throws(() => setParentCid(m, 123), /sha256-hex/);
  assert.throws(() => setParentCid(null, cid), /manifest must be an object/);
  // Undefined parent_cid removes the key (same as null).
  const m3 = { spec: 'kolm-1', parent_cid: cid };
  const out3 = setParentCid(m3, undefined);
  assert.equal('parent_cid' in out3, false);
});

// =============================================================================
// 3) walkLineage walks a 3-deep chain with a mock loader
// =============================================================================

test('W739 #3 — walkLineage walks a 3-deep chain with a mock loader (correct depth + shape)', async () => {
  freshDir();
  const c0 = hex64('leaf');
  const c1 = hex64('mid');
  const c2 = hex64('root');
  const rows = {
    [c0]: { parent_cid: c1, k_score: 0.91, created_at: '2026-05-24T00:00:00Z' },
    [c1]: { parent_cid: c2, k_score: 0.90, created_at: '2026-05-22T00:00:00Z' },
    [c2]: { parent_cid: null, k_score: 0.88, created_at: '2026-05-19T00:00:00Z' },
  };
  let calls = 0;
  const loader = async (cid) => {
    calls += 1;
    return rows[cid] || null;
  };
  const out = await walkLineage(loader, c0, { max_depth: 10 });
  assert.equal(out.ok, true, `walkLineage must succeed; got ${JSON.stringify(out)}`);
  assert.equal(out.depth, 3, `expected depth 3; got ${out.depth}`);
  assert.equal(out.truncated, false, 'chain shorter than max_depth must NOT be truncated');
  assert.equal(out.chain.length, 3, 'chain must list all 3 ancestors');
  // First row is the leaf, last row is the root.
  assert.equal(out.chain[0].cid, c0);
  assert.equal(out.chain[0].parent_cid, c1);
  assert.equal(out.chain[0].k_score, 0.91);
  assert.equal(out.chain[2].cid, c2);
  assert.equal(out.chain[2].parent_cid, null, 'root row must carry parent_cid:null');
  assert.equal(calls, 3, 'loader called exactly once per chain step');
});

// =============================================================================
// 4) walkLineage cycle-safety: A->B->A terminates with truncated:true
// =============================================================================

test('W739 #4 — walkLineage cycle-safe: A->B->A terminates with truncated:true', async () => {
  freshDir();
  const a = hex64('a');
  const b = hex64('b');
  // Crafted loop: A's parent is B; B's parent is A.
  const rows = {
    [a]: { parent_cid: b, k_score: 0.9, created_at: 't0' },
    [b]: { parent_cid: a, k_score: 0.8, created_at: 't-1' },
  };
  const loader = async (cid) => rows[cid] || null;
  const out = await walkLineage(loader, a, { max_depth: 50 });
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true, 'cycle must surface truncated:true');
  // Walk visits A then B; on the third hop (cursor=A again) the visited set
  // detects the loop and stops, so depth is 2 (not 3, not infinity).
  assert.equal(out.depth, 2, `expected depth 2; got ${out.depth}`);
});

// =============================================================================
// 5) walkLineage max_depth respected
// =============================================================================

test('W739 #5 — walkLineage max_depth caps the chain + flags truncated:true', async () => {
  freshDir();
  const chain = Array.from({ length: 6 }, (_, i) => hex64(`step-${i}`));
  const rows = {};
  for (let i = 0; i < chain.length - 1; i++) {
    rows[chain[i]] = { parent_cid: chain[i + 1], k_score: 0.9 - i * 0.01, created_at: `t-${i}` };
  }
  rows[chain[chain.length - 1]] = { parent_cid: null, k_score: 0.85, created_at: 't-end' };
  const loader = async (cid) => rows[cid] || null;
  // max_depth=3 over a 6-deep chain — should stop at depth=3 with truncated:true.
  const out = await walkLineage(loader, chain[0], { max_depth: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.depth, 3, `expected depth 3; got ${out.depth}`);
  assert.equal(out.truncated, true,
    `chain longer than max_depth must surface truncated:true; got ${JSON.stringify(out)}`);
  // The full chain (max_depth=10) reaches the root cleanly.
  const full = await walkLineage(loader, chain[0], { max_depth: 10 });
  assert.equal(full.depth, 6);
  assert.equal(full.truncated, false);
});

// =============================================================================
// 6) compareArtifactPerformance: regression case => recommendation='roll_back'
// =============================================================================

test('W739 #6 — compareArtifactPerformance: ANY axis drop >0.02 yields roll_back', () => {
  freshDir();
  // A had higher faithfulness; B regressed by 0.04 → roll_back.
  const a = { k_score: { composite: 0.92, faithfulness: 0.90, coverage: 0.85, calibration: 0.80 } };
  const b = { k_score: { composite: 0.92, faithfulness: 0.86, coverage: 0.85, calibration: 0.80 } };
  const out = compareArtifactPerformance(a, b);
  assert.equal(out.ok, true);
  assert.equal(out.recommendation, 'roll_back',
    `regression must yield roll_back; got ${JSON.stringify(out)}`);
  assert.ok(typeof out.regression_summary === 'string' && out.regression_summary.length > 0);
  assert.ok(out.deltas.faithfulness < 0,
    `faithfulness delta must be negative; got ${out.deltas.faithfulness}`);
  // The summary mentions the offending axis by name.
  assert.match(out.regression_summary, /faithfulness/,
    `summary should name the regressed axis; got ${JSON.stringify(out.regression_summary)}`);
});

// =============================================================================
// 7) compareArtifactPerformance: improvement case => 'promote'
// =============================================================================

test('W739 #7 — compareArtifactPerformance: every axis improves/unchanged yields promote', () => {
  freshDir();
  // Every axis improved or unchanged → promote.
  const a = { k_score: { composite: 0.90, faithfulness: 0.85, coverage: 0.80, calibration: 0.75 } };
  const b = { k_score: { composite: 0.92, faithfulness: 0.87, coverage: 0.80, calibration: 0.78 } };
  const out = compareArtifactPerformance(a, b);
  assert.equal(out.ok, true);
  assert.equal(out.recommendation, 'promote',
    `pure improvement must yield promote; got ${JSON.stringify(out)}`);
  assert.ok(out.deltas.composite > 0, 'composite must show positive delta');
  assert.ok(out.deltas.coverage === 0, 'unchanged axis must show delta=0');
});

// =============================================================================
// 8) compareArtifactPerformance: mixed-not-bad-enough => 'inconclusive'
// =============================================================================

test('W739 #8 — compareArtifactPerformance: mixed-but-no-big-drop yields inconclusive', () => {
  freshDir();
  // Mixed: composite up, faithfulness DOWN by only 0.01 (under the 0.02 threshold).
  // No axis crossed the regression threshold but at least one was worse → inconclusive.
  const a = { k_score: { composite: 0.90, faithfulness: 0.85, coverage: 0.80, calibration: 0.75 } };
  const b = { k_score: { composite: 0.91, faithfulness: 0.84, coverage: 0.80, calibration: 0.75 } };
  const out = compareArtifactPerformance(a, b);
  assert.equal(out.ok, true);
  assert.equal(out.recommendation, 'inconclusive',
    `mixed-small-regression must yield inconclusive; got ${JSON.stringify(out)}`);
  // Sanity: no axis was below the regression threshold.
  for (const [_axis, d] of Object.entries(out.deltas)) {
    assert.ok(d >= -0.02,
      `inconclusive requires every axis above -0.02 threshold; got ${_axis}=${d}`);
  }
});

// =============================================================================
// 9) W460 BYTE-STABILITY LOCK-IN — absent vs null parent_cid kwarg => identical
//    artifact_hash + cid + manifest_hash
// =============================================================================

test('W739 #9 — W460 byte-stability: parent_cid=null and absent kwarg produce IDENTICAL artifact_hash', async () => {
  freshDir();
  const { buildAndZip } = await import('../src/artifact.js');
  const baseRecipe = {
    id: 'r1',
    source: 'function generate(input, lib) { return String(input).length; }',
    source_hash: crypto.createHash('sha256').update(
      'function generate(input, lib) { return String(input).length; }'
    ).digest('hex'),
  };
  const common = {
    job_id: 'w739-byte-stable',
    task: 'count chars',
    base_model: 'qwen-base',
    recipes: [baseRecipe],
    training_stats: { distilled_pairs: 1, pass_rate_positive: 1.0 },
    evals: { cases: [{ input: 'hi', expected: 2 }], coverage: 1.0 },
  };
  // Build A — no parent_cid kwarg at all.
  const tA = freshDir();
  const A = await buildAndZip({ ...common, outDir: tA });
  // Build B — parent_cid explicitly null.
  const tB = freshDir();
  const B = await buildAndZip({ ...common, outDir: tB, parent_cid: null });
  // Build C — parent_cid explicitly empty string (treated as absent).
  const tC = freshDir();
  const C = await buildAndZip({ ...common, outDir: tC, parent_cid: '' });
  // Every byte-stability path must produce the same cid.
  assert.equal(A.manifest.cid, B.manifest.cid,
    `absent parent_cid must equal null parent_cid by CID: ${A.manifest.cid} vs ${B.manifest.cid}`);
  assert.equal(A.manifest.cid, C.manifest.cid,
    `absent parent_cid must equal empty-string parent_cid by CID: ${A.manifest.cid} vs ${C.manifest.cid}`);
  // The manifest MUST not carry a parent_cid key when the input is null/absent.
  assert.equal('parent_cid' in A.manifest, false,
    `absent parent_cid must NOT add the key to the manifest; got ${JSON.stringify(A.manifest.parent_cid)}`);
  assert.equal('parent_cid' in B.manifest, false,
    `null parent_cid must NOT add the key to the manifest; got ${JSON.stringify(B.manifest.parent_cid)}`);
  // Sanity: when parent_cid IS supplied, the manifest carries it AND the cid changes.
  const tD = freshDir();
  const parentHex = hex64('some-parent');
  const D = await buildAndZip({ ...common, outDir: tD, parent_cid: parentHex });
  assert.equal(D.manifest.parent_cid, parentHex,
    `non-null parent_cid must appear in manifest; got ${JSON.stringify(D.manifest.parent_cid)}`);
  assert.notEqual(A.manifest.cid, D.manifest.cid,
    'adding a real parent_cid MUST change the cid (chain-bound into receipt)');
});

// =============================================================================
// 10) diffArtifacts on real built .kolm files: correct lineage_relation + performance
// =============================================================================

test('W739 #10 — diffArtifacts on real built .kolm files surfaces lineage_relation + performance', async () => {
  freshDir();
  const { buildAndZip } = await import('../src/artifact.js');
  const baseRecipe = {
    id: 'r1',
    source: 'function generate(input, lib) { return input; }',
    source_hash: crypto.createHash('sha256').update(
      'function generate(input, lib) { return input; }'
    ).digest('hex'),
  };
  const common = {
    base_model: 'qwen-base',
    recipes: [baseRecipe],
    training_stats: { distilled_pairs: 1, pass_rate_positive: 1.0 },
    evals: { cases: [{ input: 'hi', expected: 'hi' }], coverage: 1.0 },
  };
  // Build a root artifact A.
  const tA = freshDir();
  const A = await buildAndZip({ ...common, job_id: 'w739-a', task: 'echo a', outDir: tA });
  const aPath = path.join(tA, 'w739-a.kolm');
  assert.ok(fs.existsSync(aPath), `A artifact should exist at ${aPath}`);
  // Build a descendant B that points to A as its parent.
  const tB = freshDir();
  const B = await buildAndZip({
    ...common,
    job_id: 'w739-b',
    task: 'echo b',
    outDir: tB,
    parent_cid: A.manifest.cid,
  });
  const bPath = path.join(tB, 'w739-b.kolm');
  assert.ok(fs.existsSync(bPath), `B artifact should exist at ${bPath}`);
  // Now diff B against A. B descended from A so the relation is 'ancestor'
  // (A is the ancestor of B from A's perspective in the (A, B) ordering).
  const out = await diffArtifacts(aPath, bPath);
  assert.equal(out.ok, true, `diff must succeed; got ${JSON.stringify(out)}`);
  assert.equal(out.a.cid, A.manifest.cid);
  assert.equal(out.b.cid, B.manifest.cid);
  assert.equal(out.b.parent_cid, A.manifest.cid,
    `B's parent_cid must equal A.cid; got ${out.b.parent_cid}`);
  assert.equal(out.lineage_relation, 'descendant',
    `A is the parent of B → diff(A,B) lineage_relation must be 'descendant'; got ${out.lineage_relation}`);
  assert.ok(out.performance && typeof out.performance === 'object',
    'performance block must be present');
  assert.ok(['roll_back', 'promote', 'inconclusive'].includes(out.recommendation),
    `recommendation must be one of {roll_back, promote, inconclusive}; got ${out.recommendation}`);
  assert.ok(typeof out.roll_back_hint === 'string' && out.roll_back_hint.length > 0,
    'roll_back_hint must be a non-empty string');
  assert.equal(out.version, 'w739-v1');
  // Honest envelope: bad path → file_not_found.
  const missing = await diffArtifacts(path.join(tA, 'does-not-exist.kolm'), bPath);
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'file_not_found',
    `missing file must yield file_not_found; got ${JSON.stringify(missing)}`);
});

// =============================================================================
// 11) POST /v1/artifact/diff requires auth + returns envelope
// =============================================================================

test('W739 #11 — POST /v1/artifact/diff requires auth + returns 200 envelope on auth+missing cid', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );

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
    // 11a — no auth → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/artifact/diff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a_cid: hex64('a'), b_cid: hex64('b') }),
    });
    assert.equal(noAuth.status, 401, `expected 401 with no auth; got ${noAuth.status}`);
    const noAuthBody = await noAuth.json();
    assert.ok(
      noAuthBody.error === 'missing api key' || noAuthBody.error === 'auth_required',
      `expected auth-failure error; got ${JSON.stringify(noAuthBody)}`,
    );
    // 11b — auth + missing a_cid → 400 missing_field
    const missField = await fetch(`http://127.0.0.1:${port}/v1/artifact/diff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ b_cid: hex64('b') }),
    });
    assert.equal(missField.status, 400);
    const missBody = await missField.json();
    assert.equal(missBody.error, 'missing_field');
    assert.equal(missBody.field, 'a_cid');
    // 11c — auth + nonexistent cids → 200 + ok:false envelope (HTTP succeeded;
    // the envelope carries the actionable error).
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/artifact/diff`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ a_cid: hex64('unknown-a'), b_cid: hex64('unknown-b') }),
    });
    assert.equal(unknown.status, 200,
      `unknown cid must yield 200 envelope; got ${unknown.status}`);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.ok, false);
    assert.equal(unknownBody.error, 'cid_not_found',
      `expected cid_not_found envelope; got ${JSON.stringify(unknownBody)}`);
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 12) POST /v1/artifact/lineage returns walked chain
// =============================================================================

test('W739 #12 — POST /v1/artifact/lineage requires auth + returns walked chain envelope', async () => {
  freshDir();
  process.env.KOLM_STORE_DRIVER = 'json';
  process.env.KOLM_EVENT_STORE_PATH = path.join(
    process.env.KOLM_DATA_DIR,
    'events_' + crypto.randomBytes(4).toString('hex') + '.sqlite',
  );

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
    // No auth → 401
    const noAuth = await fetch(`http://127.0.0.1:${port}/v1/artifact/lineage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cid: hex64('leaf') }),
    });
    assert.equal(noAuth.status, 401);
    // Auth + missing cid → 400 missing_field
    const missing = await fetch(`http://127.0.0.1:${port}/v1/artifact/lineage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.error, 'missing_field');
    assert.equal(missingBody.field, 'cid');
    // Auth + unknown cid → 200 + ok:false envelope (leaf_not_found)
    const unknown = await fetch(`http://127.0.0.1:${port}/v1/artifact/lineage`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + t.api_key,
      },
      body: JSON.stringify({ cid: hex64('unknown-leaf') }),
    });
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.ok, false);
    assert.equal(unknownBody.error, 'leaf_not_found',
      `expected leaf_not_found envelope on unknown cid; got ${JSON.stringify(unknownBody)}`);
    assert.equal(unknownBody.version, 'w739-v1');
  } finally {
    await new Promise(r => srv.close(r));
    if (eventStore._resetForTests) eventStore._resetForTests();
  }
});

// =============================================================================
// 13) public/docs/lineage.html exists with brand-lock strings + sections
// =============================================================================

test('W739 #13 — public/docs/lineage.html exists with brand-lock strings + required sections', () => {
  freshDir();
  assert.ok(fs.existsSync(DOC_PATH),
    `expected doc page at ${DOC_PATH}`);
  const html = fs.readFileSync(DOC_PATH, 'utf8');
  // Brand-lock — REQUIRED literal strings from the W739 spec.
  assert.ok(html.includes('Open-source AI workbench'),
    'lineage.html must carry the eyebrow "Open-source AI workbench"');
  assert.ok(html.includes('Frontier AI on your own infrastructure.'),
    'lineage.html must carry the H1 "Frontier AI on your own infrastructure."');
  // Shared docs-shell anchors that other docs pages depend on.
  for (const anchor of [
    '/ks.css',
    '/docs-shell.css',
    '<link rel="canonical" href="https://kolm.ai/docs/lineage">',
    'class="ks-footer"',
  ]) {
    assert.ok(html.includes(anchor),
      `lineage.html must contain brand-lock anchor "${anchor}"`);
  }
  // Required content sections — load-bearing tokens (NOT free-form copy).
  for (const needle of [
    'parent_cid',
    'kolm lineage',
    'kolm diff',
    'kolm pin',
    'roll_back',
    'promote',
    'inconclusive',
    '/v1/artifact/lineage',
    '/v1/artifact/diff',
  ]) {
    assert.ok(html.includes(needle),
      `lineage.html must contain section/token "${needle}"`);
  }
});

// =============================================================================
// 14) vercel.json has /docs/lineage rewrite
// =============================================================================

test('W739 #14 — vercel.json has /docs/lineage -> /docs/lineage.html rewrite', () => {
  freshDir();
  assert.ok(fs.existsSync(VERCEL_PATH), `expected vercel.json at ${VERCEL_PATH}`);
  const raw = fs.readFileSync(VERCEL_PATH, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { assert.fail(`vercel.json did not parse as JSON: ${e.message}`); }
  assert.ok(Array.isArray(parsed.rewrites), 'vercel.json must have a rewrites array');
  const match = parsed.rewrites.find(r =>
    r && r.source === '/docs/lineage' && r.destination === '/docs/lineage.html');
  assert.ok(match,
    `vercel.json rewrites must include {source:/docs/lineage,destination:/docs/lineage.html}`);
});

// =============================================================================
// 15) cli/kolm.js defines cmdW739Lineage + cmdW739Diff exactly once each
// =============================================================================

test('W739 #15 — cli/kolm.js defines cmdW739Lineage + cmdW739Diff dispatchers exactly once each', () => {
  freshDir();
  const cli = fs.readFileSync(CLI_PATH, 'utf8');
  const lineageDefs = cli.match(/async function cmdW739Lineage\s*\(/g) || [];
  assert.equal(lineageDefs.length, 1,
    `expected exactly 1 cmdW739Lineage definition; got ${lineageDefs.length}`);
  const diffDefs = cli.match(/async function cmdW739Diff\s*\(/g) || [];
  assert.equal(diffDefs.length, 1,
    `expected exactly 1 cmdW739Diff definition; got ${diffDefs.length}`);
  // Must be wired from the main switch.
  assert.ok(cli.includes('cmdW739Lineage(rest)'),
    'cmdW739Lineage must be routed from the CLI main() dispatcher');
  assert.ok(cli.includes('cmdW739Diff(rest)'),
    'cmdW739Diff must be routed from the CLI main() dispatcher');
  // The case labels MUST be 'lineage' and 'diff' literals in the switch.
  assert.match(cli, /case\s+['"]lineage['"]\s*:/,
    'must wire a `case \'lineage\':` arm in main()');
  assert.match(cli, /case\s+['"]diff['"]\s*:/,
    'must wire a `case \'diff\':` arm in main()');
});

// =============================================================================
// 16) Family lock-in via regex (no explicit array per W604)
// =============================================================================

test('W739 #16 — wave739 sibling test count uses regex wave(\\d{3,4}) + threshold pattern', () => {
  freshDir();
  const entries = fs.readdirSync(TESTS_DIR, { withFileTypes: true });
  const re = /^wave(\d{3,4})-.+\.test\.js$/;
  const siblings = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => re.test(name));
  assert.ok(siblings.length >= 3,
    `expected >=3 wave(\\d{3,4}) test files; found ${siblings.length}: ${siblings.slice(0, 12).join(',')}`);
});

// =============================================================================
// 17) diffManifests — in-memory diff path used by /v1/artifact/diff
// =============================================================================

test('W739 #17 — diffManifests in-memory path returns the same envelope shape as diffArtifacts', () => {
  freshDir();
  const a_cid = hex64('a-cid');
  const b_cid = hex64('b-cid');
  const a_manifest = {
    cid: a_cid,
    k_score: { composite: 0.90, faithfulness: 0.85 },
  };
  const b_manifest = {
    cid: b_cid,
    parent_cid: a_cid,
    k_score: { composite: 0.92, faithfulness: 0.87 },
  };
  const out = diffManifests(a_manifest, b_manifest);
  assert.equal(out.ok, true);
  assert.equal(out.a.cid, a_cid);
  assert.equal(out.b.cid, b_cid);
  assert.equal(out.b.parent_cid, a_cid);
  assert.equal(out.lineage_relation, 'descendant',
    'B.parent_cid === A.cid → diff(A,B) lineage_relation is descendant');
  assert.equal(out.recommendation, 'promote',
    `pure improvement must yield promote; got ${JSON.stringify(out)}`);
  assert.equal(out.version, 'w739-v1');
  // Sibling case: both A and B point to the SAME parent.
  const parent = hex64('shared-parent');
  const aSib = { cid: hex64('a-sib'), parent_cid: parent, k_score: { composite: 0.9 } };
  const bSib = { cid: hex64('b-sib'), parent_cid: parent, k_score: { composite: 0.9 } };
  const sibOut = diffManifests(aSib, bSib);
  assert.equal(sibOut.lineage_relation, 'sibling',
    'A.parent_cid === B.parent_cid (both non-null) → sibling');
  // Unrelated case: neither points to the other or to a shared parent.
  const aUnrel = { cid: hex64('a-unrel'), k_score: { composite: 0.9 } };
  const bUnrel = { cid: hex64('b-unrel'), k_score: { composite: 0.9 } };
  const unrelOut = diffManifests(aUnrel, bUnrel);
  assert.equal(unrelOut.lineage_relation, 'unrelated');
});
