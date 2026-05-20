// Wave 501 - quickstarts and capture/bench docs must use shipped route surfaces.

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

test('W501 #1 - API quickstart provisions anonymous workspaces with the live anon bootstrap route', () => {
  const html = read('public/quickstart/api.html');

  assert.ok(hasRoute('POST', '/v1/anon/bootstrap'));
  assert.ok(hasRoute('POST', '/v1/anon/claim'));
  assert.equal(hasRoute('POST', '/v1/auth/anon'), false);
  assert.ok(OPENAPI.paths['/v1/anon/bootstrap']?.post);
  assert.equal(OPENAPI.paths['/v1/auth/anon'], undefined);

  assert.match(html, /POST \/v1\/anon\/bootstrap/);
  assert.match(html, /anon_token/);
  assert.match(html, /kao_/);
  assert.match(html, /jq -r \.anon_token/);
  assert.doesNotMatch(html, /\/v1\/auth\/anon/);
  assert.doesNotMatch(html, /ks_anon_/);
  assert.doesNotMatch(html, /jq -r \.api_key \/tmp\/k\.json/);
});

test('W501 #2 - CLI quickstart capture setup does not use removed bridge URL or key fingerprint as raw auth', () => {
  const html = read('public/quickstart/cli.html');

  assert.ok(hasRoute('POST', '/v1/capture/openai'));
  assert.equal(hasRoute('POST', '/v1/bridges/openai'), false);

  assert.match(html, /https:\/\/kolm\.ai\/v1\/capture\/openai/);
  assert.match(html, /x-upstream-api-key/);
  assert.match(html, /jq -r \.api_key ~\/\.kolm\/config\.json/);
  assert.doesNotMatch(html, /\/v1\/bridges\/openai/);
  assert.doesNotMatch(html, /kolm key fingerprint --raw/);
});

test('W501 #3 - capture guidance names concrete shipped capture endpoints', () => {
  const builder = read('public/builder.html');
  const cookbook = read('public/cookbook/recipe-from-observations.html');
  const captures = read('public/captures.html');
  const audit = read('public/audit-log.html');
  const connectors = read('public/docs/connectors.html');
  const captureCli = read('public/docs/cli/capture.html');

  assert.ok(hasRoute('POST', '/v1/capture/openai'));
  assert.ok(hasRoute('POST', '/v1/capture/anthropic'));
  assert.ok(hasRoute('POST', '/v1/capture/openrouter'));
  assert.ok(hasRoute('POST', '/v1/capture/log'));
  assert.equal(hasRoute('POST', '/v1/capture'), false);

  for (const [label, html] of Object.entries({ builder, cookbook, captures, audit })) {
    assert.doesNotMatch(html, /\/v1\/capture\/\{/, `${label} should not use brace-set capture paths`);
    assert.doesNotMatch(html, /kolm\.ai\/v1\/capture<\/code>/, `${label} should not use bare hosted capture base`);
    assert.doesNotMatch(html, /proxy via <code>\/v1\/capture<\/code>/, `${label} should not use bare capture route`);
  }
  assert.match(captures, /\/v1\/capture\/openrouter/);
  assert.match(captures, /x-upstream-api-key/);
  assert.match(cookbook, /\/v1\/capture\/log/);
  assert.match(connectors, /OpenRouter/);
  assert.match(connectors, /x-upstream-api-key/);
  assert.match(connectors, /Bearer ks_\*/);
  assert.doesNotMatch(connectors, /Bearer kolm_/);
  assert.match(captureCli, /openrouter/);
  assert.match(captureCli, /OPENROUTER_BASE_URL/);
  assert.match(captureCli, /Bearer ks_\*/);
  assert.doesNotMatch(captureCli, /Bearer kolm_/);
});

test('W501 #4 - benchmark and troubleshooting docs do not advertise unshipped batch or submit endpoints', () => {
  const troubleshooting = read('public/docs/troubleshooting.html');
  const bench = read('public/kscore-bench.html');
  const kscore = read('public/k-score.html');

  assert.ok(hasRoute('POST', '/v1/capture/log'));
  assert.equal(hasRoute('POST', '/v1/capture/batch'), false);
  assert.equal(hasRoute('POST', '/v1/bench/submit'), false);
  assert.equal(OPENAPI.paths['/v1/capture/batch'], undefined);
  assert.equal(OPENAPI.paths['/v1/bench/submit'], undefined);

  assert.match(troubleshooting, /multiple <code>items<\/code> to <code>POST \/v1\/capture\/log<\/code>/);
  assert.doesNotMatch(troubleshooting, /\/v1\/capture\/batch/);

  assert.match(bench, /Public leaderboard submission uses signed receipts reviewed through the account console or support intake/);
  assert.match(bench, /bench-receipt\.json/);
  assert.doesNotMatch(bench, /\/v1\/bench\/submit/);
  assert.doesNotMatch(bench, /kolm bench[^<\n]*--submit/);

  assert.match(kscore, /bench-receipt\.json/);
  assert.doesNotMatch(kscore, /kolm bench[^<\n]*--submit/);
});
