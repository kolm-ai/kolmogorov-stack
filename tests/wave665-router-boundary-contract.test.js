// W665 - direct boundary contract for src/router.js.
//
// Focus: the aggregate Express router, not a single downstream route module.
// This test keeps the pre-auth /v1 surface intentional as router.js grows.

import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { isPublicApiPath } from '../src/auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROUTER_PATH = path.join(ROOT, 'src', 'router.js');
const ROUTER_SRC = fs.readFileSync(ROUTER_PATH, 'utf8');

const INTENTIONAL_PRE_AUTH_ROUTES = new Map(Object.entries({
  'POST /v1/status/subscribe': 'public_status_subscription_ip_limited',
  'POST /v1/loop/try': 'public_demo_receipt_no_persistence',
  'GET /v1/pricing': 'public_catalog',
  'GET /v1/product/experience': 'public_catalog',
  'GET /v1/product/graph': 'public_catalog',
  'GET /v1/evidence/readiness': 'public_readiness_packet',
  'GET /v1/packages/release-readiness': 'public_readiness_packet',
  'GET /v1/packages/release-readiness/template': 'public_readiness_packet',
  'POST /v1/packages/release-readiness/validate': 'public_manifest_validator',
  'GET /v1/compliance/certification-packet': 'public_readiness_packet',
  'GET /v1/compliance/certification-packet/template': 'public_readiness_packet',
  'POST /v1/compliance/certification-packet/validate': 'public_manifest_validator',
  'GET /v1/privacy/redaction-benchmark': 'public_eval_report',
  'GET /v1/eval/k-score-calibration': 'public_eval_report',
  'GET /v1/eval/benchmark-evidence': 'public_eval_report',
  'GET /v1/eval/benchmark-evidence/template': 'public_eval_report',
  'POST /v1/eval/benchmark-evidence/validate': 'public_manifest_validator',
  'GET /v1/eval/quality-calibration': 'public_eval_report',
  'GET /v1/cloud/readiness': 'public_readiness_packet',
  'GET /v1/cloud/broker/catalog': 'public_cloud_catalog',
  'POST /v1/cloud/broker': 'public_cloud_quote_simulator',
  'GET /v1/storage/object-readiness': 'public_readiness_packet',
  'GET /v1/cloud/deploy-targets': 'public_cloud_catalog',
  'POST /v1/cloud/deploy-plan': 'public_deploy_plan_simulator',
  'GET /v1/capture/rbac/policy': 'public_policy_document',
  'POST /v1/capture/rbac/evaluate': 'public_policy_evaluator',
  'GET /v1/registry/verified-publishers/policy': 'public_policy_document',
  'POST /v1/registry/verified-publishers/evaluate': 'public_policy_evaluator',
  'POST /v1/artifacts/dependency-graph': 'public_static_artifact_analyzer',
  'GET /v1/streaming/capabilities': 'public_capability_catalog',
  'POST /v1/streaming/normalize': 'public_static_stream_normalizer',
  'GET /v1/pricing/estimate': 'public_pricing_estimator',
  'POST /v1/pricing/estimate': 'public_pricing_estimator',
  'GET /v1/plans': 'public_catalog',
  'GET /v1/billing/tiers': 'public_catalog',
  'POST /v1/auth/login': 'public_login_credential_route',
  'POST /v1/auth/signup': 'public_signup_credential_route',
  'POST /v1/session/login': 'public_login_credential_route',
  'POST /v1/session/logout': 'public_session_cleanup',
  'POST /v1/receipts/verify': 'public_receipt_verifier',
  'GET /v1/keys/public': 'public_key_directory',
  'GET /v1/keys/public/:fingerprint': 'public_key_directory',
  'POST /v1/keys/challenge': 'public_key_challenge',
  'POST /v1/keys/register': 'public_key_challenge_response',
  'DELETE /v1/keys/public/:fingerprint': 'public_key_challenge_response',
  'GET /v1/sigstore/health': 'public_transparency_status',
  'GET /v1/sigstore/entry/:logIndex': 'public_transparency_lookup',
  'POST /v1/sigstore/attest': 'public_transparency_submitter',
  'GET /v1/product/capabilities': 'public_catalog',
  'GET /v1/spec': 'public_spec',
  'GET /v1/spec/governance-packet': 'public_readiness_packet',
  'GET /v1/spec/governance-packet/template': 'public_readiness_packet',
  'POST /v1/spec/governance-packet/validate': 'public_manifest_validator',
  'GET /v1/runtime/adoption-packets': 'public_readiness_packet',
  'GET /v1/runtime/adoption-packets/template': 'public_readiness_packet',
  'POST /v1/runtime/adoption-packets/validate': 'public_manifest_validator',
  'GET /v1/registry/export': 'public_registry_export_rate_limited',
  'GET /v1/builder/templates': 'public_builder_catalog',
  'POST /v1/builder/preview': 'public_builder_preview_rate_limited',
  'POST /v1/build/preview': 'public_builder_preview_rate_limited',
  'GET /v1/seeds/from-nl/health': 'public_builder_health',
  'POST /v1/seeds/from-nl': 'public_builder_seed_rate_limited',
}));

function routerLines() {
  return ROUTER_SRC.split(/\r?\n/);
}

function parseRoutes() {
  const routes = [];
  const lines = routerLines();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*r\.(get|post|put|patch|delete|all)\(\s*['"]([^'"]+)['"]\s*,?(.*)$/);
    if (!m) continue;
    routes.push({
      line: i + 1,
      method: m[1].toUpperCase(),
      path: m[2],
      tail: m[3],
    });
  }
  return routes;
}

function globalAuthLine() {
  const idx = routerLines().findIndex((line) => /r\.use\(authMiddleware\)/.test(line));
  return idx >= 0 ? idx + 1 : 0;
}

function sampleRoutePath(routePath) {
  return routePath
    .replace(/:([A-Za-z0-9_]+)\(\*\)/g, 'sample-id')
    .replace(/:([A-Za-z0-9_]+)\([^)]*\)/g, 'sample-id')
    .replace(/:([A-Za-z0-9_]+)/g, 'sample-id');
}

function routeKey(route) {
  return `${route.method} ${route.path}`;
}

function classifyPreAuthRoute(route) {
  if (!route.path.startsWith('/v1/')) return 'non_v1';
  if (route.tail.includes('__w411HostedAuthGate')) return 'hosted_inference_gate';
  if (route.tail.includes('authMiddleware')) return 'explicit_route_auth';
  if (isPublicApiPath(sampleRoutePath(route.path))) return 'auth_public_api_allowlist';
  return INTENTIONAL_PRE_AUTH_ROUTES.get(routeKey(route)) || null;
}

function routeBlock(pathLiteral) {
  const needle = `r.get('${pathLiteral}'`;
  const start = ROUTER_SRC.indexOf(needle);
  assert.ok(start >= 0, `${needle} not found`);
  const rest = ROUTER_SRC.slice(start + 1);
  const next = rest.search(/\n\s*r\.(get|post|put|patch|delete|all)\(['"]/);
  return next > 0 ? ROUTER_SRC.slice(start, start + 1 + next) : ROUTER_SRC.slice(start);
}

async function withServer(app, fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('W665 router contract parses the aggregate route surface and global auth gate', () => {
  const routes = parseRoutes();
  const authLine = globalAuthLine();
  assert.ok(routes.length >= 800, `expected >=800 route registrations, got ${routes.length}`);
  assert.ok(authLine > 6000, `expected global auth after public/connector preface, got line ${authLine}`);
  assert.ok(routes.some((r) => r.path === '/v1/chat/completions' && r.line < authLine));
  assert.ok(routes.some((r) => r.path === '/v1/capture/log' && r.line > authLine));
});

test('W665 router contract classifies every pre-auth /v1 route', () => {
  const routes = parseRoutes();
  const authLine = globalAuthLine();
  const preAuthV1 = routes.filter((r) => r.line < authLine && r.path.startsWith('/v1/'));
  assert.ok(preAuthV1.length >= 100, `expected broad pre-auth public/connector surface, got ${preAuthV1.length}`);

  const unclassified = preAuthV1
    .filter((r) => !classifyPreAuthRoute(r))
    .map((r) => ({ line: r.line, route: routeKey(r), sample: sampleRoutePath(r.path) }));
  assert.deepEqual(unclassified, []);

  const present = new Set(preAuthV1.map(routeKey));
  const stale = [...INTENTIONAL_PRE_AUTH_ROUTES.keys()].filter((key) => !present.has(key));
  assert.deepEqual(stale, []);
});

test('W665 router contract keeps sensitive tenant routes behind auth', () => {
  const routes = parseRoutes();
  const authLine = globalAuthLine();
  const sensitivePrefixes = [
    '/v1/account/billing',
    '/v1/account/provider-keys',
    '/v1/admin',
    '/v1/capture/log',
    '/v1/captures',
    '/v1/chargeback',
    '/v1/cloud/distill',
    '/v1/compute/scheduler',
    '/v1/exports',
    '/v1/plugins',
  ];
  const violations = routes
    .filter((r) => sensitivePrefixes.some((prefix) => r.path === prefix || r.path.startsWith(`${prefix}/`)))
    .filter((r) => r.line < authLine && !r.tail.includes('authMiddleware'))
    .map((r) => ({ line: r.line, route: routeKey(r) }));
  assert.deepEqual(violations, []);
});

test('W665 router contract redacts public model-cache filesystem paths', () => {
  const block = routeBlock('/v1/models/cache');
  assert.match(block, /cache_dir:\s*null/);
  assert.match(block, /cache_dir_redacted:\s*true/);
  assert.match(block, /path_redacted:\s*true/);
  assert.match(block, /\{\s*path:\s*_path,\s*\.\.\.entry\s*\}/);
  assert.doesNotMatch(block, /res\.json\(\{\s*cache_dir:\s*dir/);
});

test('W665 /v1/models/cache response redacts seeded host paths at runtime', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w665-model-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.KOLM_MODELS_DIR;
  t.after(() => {
    if (previous == null) delete process.env.KOLM_MODELS_DIR;
    else process.env.KOLM_MODELS_DIR = previous;
  });
  process.env.KOLM_MODELS_DIR = dir;

  const secretPath = path.join(dir, 'private-host-user', 'model.gguf');
  fs.mkdirSync(path.dirname(secretPath), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
    version: 1,
    entries: {
      'model::q4::model.gguf': {
        model_id: 'model',
        variant: 'q4',
        file: 'model.gguf',
        bytes: 123,
        path: secretPath,
        sha256: null,
        downloaded_at: '2026-06-17T00:00:00.000Z',
      },
    },
  }), 'utf8');

  const { buildRouter } = await import('../src/router.js');
  const app = express();
  app.use(express.json());
  app.use(buildRouter());

  await withServer(app, async (base) => {
    const res = await fetch(`${base}/v1/models/cache`);
    assert.equal(res.status, 200);
    const bodyText = await res.text();
    assert.ok(!bodyText.includes(dir), 'public response must not include cache dir');
    assert.ok(!bodyText.includes(secretPath), 'public response must not include entry path');
    const body = JSON.parse(bodyText);
    assert.equal(body.cache_dir, null);
    assert.equal(body.cache_dir_redacted, true);
    assert.equal(body.total_bytes, 123);
    assert.equal(body.entries.length, 1);
    assert.equal(body.entries[0].path, undefined);
    assert.equal(body.entries[0].path_redacted, true);
  });
});
