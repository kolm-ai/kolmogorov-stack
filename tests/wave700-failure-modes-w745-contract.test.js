// W700 - direct contract for src/failure-modes-w745.js.
//
// Focus: bounded heuristic clustering, non-enumerable internal CID joins,
// strict K-Score range handling, digest-backed report envelopes, and W741 link.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  FAILURE_MODES_CONTRACT_VERSION,
  FAILURE_MODES_VERSION,
  MAX_FAILURE_MODE_CAPTURES,
  clusterByKeywords,
  clusterKScore,
  generateFailureModeReport,
  topRegressions,
} from '../src/failure-modes-w745.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HEX64_RE = /^[a-f0-9]{64}$/;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function makeCapture(cid, text) {
  return { cid, input: text };
}

function makeRows(cids, kScore) {
  return cids.map((cid) => ({ cid, k_score: kScore }));
}

test('W700 source pins W745 bounds, digest contract, and package wiring', () => {
  const source = read('src/failure-modes-w745.js');
  const router = read('src/router.js');
  const pkg = readJson('package.json');

  assert.equal(FAILURE_MODES_VERSION, 'w745-v1');
  assert.equal(FAILURE_MODES_CONTRACT_VERSION, 'w700-v1');
  assert.match(source, /MAX_FAILURE_MODE_CAPTURES/);
  assert.match(source, /MAX_FAILURE_MODE_BAKEOFF_ROWS/);
  assert.match(source, /report_sha256/);
  assert.match(source, /Object\.defineProperty\(row, '_all_cids'/);
  assert.match(source, /heuristic_keyword_v1/);
  assert.doesNotMatch(source, /[^\x00-\x7F]/);
  assert.match(router, /generateFailureModeReport\(artifact_cid, \[\], \[\]\)/);

  assert.equal(
    pkg.scripts['verify:failure-modes-w745'],
    'node --test --test-concurrency=1 tests/wave700-failure-modes-w745-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:drift-alert-w813 && npm run verify:failure-modes-w745 && npm run verify:openai-finetune-importer && node --test/);
});

test('W700 clusterByKeywords bounds input and keeps join CIDs non-enumerable', () => {
  const captures = [];
  for (let i = 0; i < 12; i += 1) {
    captures.push(makeCapture(`refund-${i}`, 'refund billing refund status'));
    captures.push(makeCapture(`chargeback-${i}`, 'chargeback dispute chargeback evidence'));
  }
  captures.push(makeCapture('bad\ncid', 'refund billing refund status'));

  const clusters = clusterByKeywords(captures, { min_cluster_size: 5 });
  assert.equal(clusters.length, 2);
  assert.ok(clusters.every((c) => c.count === 12));
  assert.ok(clusters.every((c) => c.sample_cids.length <= 3));
  assert.ok(clusters.every((c) => Array.isArray(c._all_cids)));
  assert.ok(clusters.every((c) => !Object.keys(c).includes('_all_cids')));
  assert.equal(JSON.stringify(clusters).includes('_all_cids'), false);
  assert.equal(JSON.stringify(clusters).includes('bad\ncid'), false);

  const tooMany = Array.from({ length: MAX_FAILURE_MODE_CAPTURES + 10 }, (_, i) =>
    makeCapture(`cap-${i}`, 'bounded support bounded refund'),
  );
  const capped = clusterByKeywords(tooMany, { min_cluster_size: 1 });
  assert.equal(capped.reduce((sum, c) => sum + c.count, 0), MAX_FAILURE_MODE_CAPTURES);
});

test('W700 clusterKScore ignores out-of-range rows and emits Wilson CI only above floor', () => {
  const captures = Array.from({ length: 35 }, (_, i) => makeCapture(`refund-${i}`, 'refund billing refund status'));
  const [cluster] = clusterByKeywords(captures, { min_cluster_size: 10 });
  const rows = [
    ...makeRows(captures.map((c) => c.cid), 0.7),
    { cid: 'refund-0', k_score: 2 },
    { cid: 'refund-1', k_score: -1 },
    { cid: 'refund-2', k_score: Infinity },
  ];

  const score = clusterKScore(cluster, rows);
  assert.equal(score.n, 35);
  assert.equal(score.k_score, 0.7);
  assert.equal(typeof score.k_score_ci_lo, 'number');
  assert.equal(typeof score.k_score_ci_hi, 'number');
  assert.ok(score.k_score_ci_lo >= 0 && score.k_score_ci_hi <= 1);

  const small = clusterKScore(cluster, rows.slice(0, 12));
  assert.equal(small.n, 12);
  assert.equal(small.k_score_ci_lo, null);
  assert.equal(small.k_score_ci_hi, null);
});

test('W700 generateFailureModeReport returns digest-backed regressions and no internal CIDs', () => {
  const lowCaptures = Array.from({ length: 35 }, (_, i) =>
    makeCapture(`refund-${i}`, 'refund dispute refund issue'),
  );
  const highCaptures = Array.from({ length: 35 }, (_, i) =>
    makeCapture(`billing-${i}`, 'billing invoice billing question'),
  );
  const captures = [...lowCaptures, ...highCaptures];
  const rows = [
    ...makeRows(lowCaptures.map((c) => c.cid), 0.62),
    ...makeRows(highCaptures.map((c) => c.cid), 0.97),
  ];

  const report = generateFailureModeReport(' cid:artifact/one ', captures, rows, {
    min_cluster_size: 10,
    top_n: 10,
    now_iso: '2026-06-18T00:00:00Z',
  });

  assert.equal(report.ok, true);
  assert.equal(report.failure_modes_version, 'w745-v1');
  assert.equal(report.contract_version, 'w700-v1');
  assert.equal(report.artifact_cid, 'cid:artifact/one');
  assert.equal(report.overall_k_score, 0.795);
  assert.equal(report.clustering, 'heuristic_keyword_v1');
  assert.equal(report.cluster_count, 2);
  assert.equal(report.top_regressions.length, 1);
  assert.equal(report.top_regressions[0].k_score, 0.62);
  assert.equal(report.top_regressions[0].delta_vs_overall, 0.175);
  assert.equal(report.diagnostic_link, '/account/diagnose?cid=cid%3Aartifact%2Fone');
  assert.match(report.report_sha256, HEX64_RE);
  assert.equal(report.generated_at, '2026-06-18T00:00:00.000Z');
  assert.equal(JSON.stringify(report).includes('_all_cids'), false);
});

test('W700 invalid/no-bakeoff envelopes are honest and topRegressions only returns true regressions', () => {
  const bad = generateFailureModeReport('bad\ncid', [], [], { now_iso: '2026-06-18T00:00:00Z' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'artifact_cid_invalid');
  assert.equal(bad.contract_version, 'w700-v1');

  const empty = generateFailureModeReport('artifact-1', [], [], { now_iso: '2026-06-18T00:00:00Z' });
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'no_bakeoff_results_yet');
  assert.equal(empty.diagnostic_link, '/account/diagnose?cid=artifact-1');

  const regressions = topRegressions([
    { cluster_id: 'better', k_score: 0.95 },
    { cluster_id: 'worse', k_score: 0.6 },
  ], 0.8, { top_n: 1000 });
  assert.deepEqual(regressions.map((r) => r.cluster_id), ['worse']);
  assert.equal(regressions[0].delta_vs_overall, 0.2);
});
