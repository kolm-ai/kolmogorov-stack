// W710 - direct contract tests for src/meta-routes.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  META_ROUTES_CONTRACT_VERSION,
  META_ROUTES_LIMITS,
  mountMetaRoutes,
  parseMetaRouteFeatures,
  redactMetaRouteDetail,
} from '../src/meta-routes.js';
import {
  META_VERSION,
  appendTrainingRow,
  resetForTests,
} from '../src/kolm-meta-trainer.js';

const ROOT = path.resolve('.');

function freshDir() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w710-meta-routes-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  fs.mkdirSync(process.env.KOLM_DATA_DIR, { recursive: true });
  resetForTests();
  return tmp;
}

function makeRoutes() {
  const handlers = new Map();
  const router = {
    get(route, fn) { handlers.set(`GET ${route}`, fn); },
    post(route, fn) { handlers.set(`POST ${route}`, fn); },
  };
  mountMetaRoutes(router);
  return handlers;
}

async function invoke(handlers, method, route, { tenant = 'tenant_meta_a', query = {} } = {}) {
  const handler = handlers.get(`${method} ${route}`);
  assert.equal(typeof handler, 'function', `${method} ${route} must be mounted`);
  const res = {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  const req = {
    tenant_record: tenant == null ? null : { id: tenant },
    query,
  };
  await handler(req, res);
  return { status: res.statusCode, body: res.body };
}

function assertContractEnvelope(body) {
  assert.equal(body.version, META_VERSION);
  assert.equal(body.contract_version, META_ROUTES_CONTRACT_VERSION);
}

test('W710 meta routes expose a bounded, versioned contract and depth verifier', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'meta-routes.js'), 'utf8');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  assert.equal(META_ROUTES_CONTRACT_VERSION, 'w710-v1');
  assert.ok(Object.isFrozen(META_ROUTES_LIMITS));
  assert.ok(META_ROUTES_LIMITS.max_features_query_chars <= 8192);
  assert.ok(META_ROUTES_LIMITS.max_feature_keys <= 64);
  assert.match(src, /model_path_ref: publicModelPathRef\(env\.model_path\)/);
  assert.doesNotMatch(src, /model_path:\s*env\.model_path/);
  assert.equal(
    pkg.scripts['verify:meta-routes'],
    'node --test --test-concurrency=1 tests/wave710-meta-routes-contract.test.js',
  );
  assert.match(pkg.scripts['verify:depth'], /verify:router-contract && npm run verify:api-contract-matrix && npm run verify:auth-boundary-matrix && npm run verify:cli-command-matrix && npm run verify:daemon-connector-matrix && npm run verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:meta-routes && npm run verify:governance-packets/);

  const redacted = redactMetaRouteDetail(`failed at ${process.cwd()}\\secret\\meta-model.json\nwith stack`);
  assert.doesNotMatch(redacted, /secret\\meta-model\.json/);
  assert.doesNotMatch(redacted, /\n/);
});

test('W710 meta routes return consistent auth envelopes on every route', async () => {
  freshDir();
  const handlers = makeRoutes();
  for (const [method, route] of [
    ['GET', '/v1/meta/status'],
    ['POST', '/v1/meta/retrain'],
    ['GET', '/v1/meta/predict'],
  ]) {
    const res = await invoke(handlers, method, route, { tenant: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, 'auth_required');
    assertContractEnvelope(res.body);
  }
});

test('W710 meta predict rejects malformed or oversized feature query payloads before inference', async () => {
  freshDir();
  const handlers = makeRoutes();
  const cases = [
    [{}, 400, 'features_required'],
    [{ features: '{not-json' }, 400, 'features_invalid_json'],
    [{ features: '[]' }, 400, 'features_invalid_shape'],
    [{ features: JSON.stringify({ other: 1 }) }, 400, 'features_required'],
    [{ features: '{"__proto__":1,"capture_count":1}' }, 400, 'features_invalid_key'],
    [{ features: JSON.stringify({ capture_count: { nested: true } }) }, 400, 'features_invalid_value'],
    [{ features: '{"capture_count":NaN}' }, 400, 'features_invalid_json'],
    [{ features: 'x'.repeat(META_ROUTES_LIMITS.max_features_query_chars + 1) }, 413, 'features_too_large'],
  ];

  for (const [query, status, error] of cases) {
    const res = await invoke(handlers, 'GET', '/v1/meta/predict', { query });
    assert.equal(res.status, status);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, error);
    assertContractEnvelope(res.body);
  }

  const parsed = parseMetaRouteFeatures(JSON.stringify({ capture_count: 7, teacher_class: 'open-weights' }));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.features, { capture_count: 7, teacher_class: 'open-weights' });
});

test('W710 meta status and no-model prediction stay honest and path-free', async () => {
  const tmp = freshDir();
  const handlers = makeRoutes();

  const status = await invoke(handlers, 'GET', '/v1/meta/status', { tenant: 'tenant_empty' });
  assert.equal(status.status, 200);
  assert.equal(status.body.ok, true);
  assert.equal(status.body.rows_total, 0);
  assert.equal(status.body.rows_tenant, 0);
  assert.equal(status.body.model_present, false);
  assert.equal(status.body.meta_insufficient_data, true);
  assertContractEnvelope(status.body);

  const predict = await invoke(handlers, 'GET', '/v1/meta/predict', {
    query: { features: JSON.stringify({ capture_count: 3 }) },
  });
  assert.equal(predict.status, 200);
  assert.equal(predict.body.ok, false);
  assert.equal(predict.body.status, 'no_model');
  assert.equal(predict.body.model_path, undefined);
  assert.equal(predict.body.model, undefined);
  assert.doesNotMatch(JSON.stringify(predict.body), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertContractEnvelope(predict.body);
});

test('W710 meta retrain returns public model references without leaking local paths', async () => {
  const tmp = freshDir();
  const handlers = makeRoutes();
  for (let i = 0; i < 2; i++) {
    appendTrainingRow({
      tenant_id: 'tenant_meta_a',
      features: { capture_count: 10 + i, teacher_class: 'open-weights' },
      observed: { kscore: 0.72 + i / 100, compile_time_s: 20 + i, failure_modes: [] },
    });
  }

  const res = await invoke(handlers, 'POST', '/v1/meta/retrain', { tenant: 'tenant_meta_a' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.n_train_rows, 2);
  assert.equal(res.body.model_path, undefined);
  assert.equal(res.body.model, undefined);
  assert.equal(res.body.model_path_ref.model_path_present, true);
  assert.equal(res.body.model_path_ref.model_path_basename, 'meta-model.json');
  assert.match(res.body.model_path_ref.model_path_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(tmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assertContractEnvelope(res.body);
});
