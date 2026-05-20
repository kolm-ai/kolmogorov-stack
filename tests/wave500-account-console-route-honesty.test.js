// Wave 500 - account console pages must not call or advertise unshipped account routes.

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

function assertNoDeadAccountRoutes(html, label) {
  for (const dead of [
    /\/v1\/account\/2fa(?:\/verify|\/recovery)?/,
    /\/v1\/account\/password-reset/,
    /\/v1\/account\/reveal-key/,
  ]) {
    assert.doesNotMatch(html, dead, `${label} should not reference ${dead}`);
  }
}

test('W500 #1 - account connector and key pages use shipped capture routes only', () => {
  const connectors = read('public/account/connectors.html');
  const keys = read('public/account/api-keys.html');

  assert.ok(hasRoute('POST', '/v1/capture/openai'));
  assert.ok(hasRoute('POST', '/v1/capture/anthropic'));
  assert.ok(hasRoute('POST', '/v1/capture/openrouter'));
  assert.ok(hasRoute('POST', '/v1/capture/log'));
  assert.ok(hasRoute('GET', '/v1/capture/stream'));
  assert.ok(hasRoute('GET', '/v1/bridges/observations'));
  assert.ok(OPENAPI.paths['/v1/capture/openai']?.post);
  assert.ok(OPENAPI.paths['/v1/capture/anthropic']?.post);
  assert.ok(OPENAPI.paths['/v1/capture/openrouter']?.post);
  assert.equal(OPENAPI.paths['/v1/capture/gemini'], undefined);

  assert.match(connectors, /var PROVIDERS=\["openai","anthropic","openrouter"\]/);
  assert.match(connectors, /Connectors · Account · kolm\.ai/);
  assert.match(connectors, /var LABELS=\{openai:"OpenAI",anthropic:"Claude",openrouter:"OpenRouter"\}/);
  assert.match(connectors, /var ENDPOINTS=\{openai:"\/v1\/capture\/openai",anthropic:"\/v1\/capture\/anthropic",openrouter:"\/v1\/capture\/openrouter\/v1"\}/);
  assert.match(connectors, /x-upstream-api-key/);
  assert.match(connectors, /\/docs\/connect\/openai/);
  assert.match(connectors, /\/docs\/connect\/anthropic/);
  assert.match(connectors, /\/docs\/connect\/openrouter/);
  assert.doesNotMatch(connectors, /\/v1\/capture\/gemini/);
  assert.doesNotMatch(connectors, /\/docs\/connectors\/\+p/);

  assert.match(keys, /\/v1\/capture\/log/);
  assert.match(keys, /\/v1\/capture\/stream/);
  assert.doesNotMatch(keys, /\/v1\/captures/);
});

test('W500 #2 - account recovery and MFA pages avoid dead browser API flows', () => {
  const twoFa = read('public/account/security/2fa.html');
  const reset = read('public/password-reset.html');
  const setup = read('public/setup.html');

  assert.equal(hasRoute('GET', '/v1/account/2fa'), false);
  assert.equal(hasRoute('POST', '/v1/account/password-reset'), false);
  assert.equal(hasRoute('GET', '/v1/account/reveal-key'), false);
  assert.equal(OPENAPI.paths['/v1/account/2fa'], undefined);
  assert.equal(OPENAPI.paths['/v1/account/password-reset'], undefined);
  assert.equal(OPENAPI.paths['/v1/account/reveal-key'], undefined);

  assertNoDeadAccountRoutes(twoFa, '2FA page');
  assertNoDeadAccountRoutes(reset, 'password-reset page');
  assertNoDeadAccountRoutes(setup, 'setup page');

  assert.match(twoFa, /MFA is enforced at the identity-provider layer/);
  assert.match(twoFa, /MFA enrollment remains an identity-provider action/);
  assert.doesNotMatch(twoFa, /fetch\(/);

  assert.match(reset, /Support-assisted recovery/);
  assert.doesNotMatch(reset, /fetch\(/);

  assert.match(setup, /Key setup is handled from the account console/);
  assert.doesNotMatch(setup, /fetch\(/);
});

test('W500 #3 - cloud sync docs point at shipped sync subroutes, not a bare sync endpoint', () => {
  const cloud = read('public/docs/cloud-sync.html');

  assert.ok(hasRoute('POST', '/v1/sync/inbox'));
  assert.ok(hasRoute('GET', '/v1/sync/status'));
  assert.ok(hasRoute('PUT', '/v1/sync/state'));
  assert.ok(hasRoute('POST', '/v1/sync/push'));
  assert.ok(hasRoute('POST', '/v1/sync/pull'));
  assert.ok(hasRoute('GET', '/v1/sync/audit'));
  assert.ok(OPENAPI.paths['/v1/sync/inbox']?.post);

  assert.match(cloud, /https:\/\/kolm\.ai\/v1\/sync\/inbox/);
  assert.match(cloud, /\/v1\/sync\/status/);
  assert.doesNotMatch(cloud, /# target:\s+https:\/\/kolm\.ai\/v1\/sync(?:\s|<|$)/);
});

test('W500 #4 - capture research copy does not mention the removed captures feedback route', () => {
  const research = read('public/research/capture-loop-fidelity.html');

  assert.ok(hasRoute('POST', '/v1/capture/log'));
  assert.match(research, /\/v1\/capture\/log/);
  assert.doesNotMatch(research, /\/v1\/captures\/:id\/feedback/);
});
