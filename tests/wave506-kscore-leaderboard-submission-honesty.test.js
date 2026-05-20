// Wave 506 - K-score leaderboard must not advertise an unshipped submit API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ROUTES = JSON.parse(read('public/docs/api-routes.json'));
const OPENAPI = JSON.parse(read('public/openapi.json'));

function hasRoute(method, routePath) {
  return (ROUTES.groups || []).some((group) =>
    (group.routes || []).some((route) => route.method === method && route.path === routePath)
  );
}

test('W506 #1 - benchmark submit API remains absent from generated contracts', () => {
  assert.equal(hasRoute('POST', '/v1/bench/submit'), false);
  assert.equal(OPENAPI.paths['/v1/bench/submit'], undefined);
});

test('W506 #2 - leaderboard metadata describes manual review instead of a submit endpoint', () => {
  const data = JSON.parse(read('public/kscore-leaderboard.json'));

  assert.equal(data.submission_mode, 'manual_review');
  assert.equal(data.submission_endpoint, null);
  assert.equal(data.submission_contact, 'leaderboard@kolm.ai');
  assert.equal(data.submission_receipt, 'bench-receipt.json');
  assert.ok(Array.isArray(data.rows));
});

test('W506 #3 - public leaderboard page does not instruct users to run an unshipped submit command', () => {
  const html = read('public/kscore-leaderboard.html');

  assert.match(html, /bench-receipt\.json/);
  assert.match(html, /leaderboard@kolm\.ai/);
  assert.match(html, /manual review/i);
  assert.doesNotMatch(html, /kolm bench[^<\n]*--submit/);
  assert.doesNotMatch(html, /\/v1\/bench\/submit/);
});

test('W506 #4 - benchmark source comments do not claim a server-side submit route exists', () => {
  const src = read('src/kscore-bench.js');

  assert.match(src, /manual leaderboard review/);
  assert.match(src, /Public automated submission is not[\s\S]{0,80}shipped/);
  assert.doesNotMatch(src, /\/v1\/bench\/submit/);
  assert.doesNotMatch(src, /cmdBench --submit/);
});
