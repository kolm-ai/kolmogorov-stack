import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'api-contract-matrix.json');
const OPENAPI_PATH = path.join(ROOT, 'public', 'openapi.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function route(matrix, key) {
  const row = matrix.routes.find((r) => r.route_key === key);
  assert.ok(row, `matrix route missing: ${key}`);
  return row;
}

function operation(openapi, method, p) {
  const op = openapi.paths[p] && openapi.paths[p][method.toLowerCase()];
  assert.ok(op, `OpenAPI operation missing: ${method} ${p}`);
  return op;
}

test('W937 package wiring makes the API contract matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:api-contract-matrix'], 'node scripts/build-api-contract-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:api-contract-matrix'],
    'node scripts/build-api-contract-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave937-api-contract-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:api-contract-matrix/);
  assert.match(pkg.scripts['verify:control-files'], /verify:api-contract-matrix/);
  assert.match(pkg.scripts['verify:depth'], /verify:router-contract && npm run verify:api-contract-matrix && npm run verify:auth-boundary-matrix && npm run verify:cli-command-matrix && npm run verify:daemon-connector-matrix && npm run verify:binder-contract-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-api-contract-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/api-contract-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/api-contract-matrix\.json/);
  assert.match(releaseVerify, /kolm\.api_contract_matrix\.v1/);
});

test('W937 generated matrix is current and all hard API contract gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-api-contract-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  assert.ok(fs.existsSync(MATRIX_PATH), 'api-contract-matrix.json must exist');
  const matrix = readJson(MATRIX_PATH);

  assert.equal(matrix.schema, 'kolm.api_contract_matrix.v1');
  assert.equal(matrix.updated_at, '2026-06-18');
  assert.equal(matrix.gates.ok, true, JSON.stringify(matrix.gates.failures, null, 2));
  assert.equal(matrix.summary.manifest_route_rows, 929);
  assert.equal(matrix.summary.operation_route_count, 926);
  assert.equal(matrix.summary.openapi_operation_count, 926);
  assert.equal(matrix.summary.route_groups, 214);
  assert.equal(matrix.summary.skipped_openapi_routes, 2);
  assert.ok(matrix.summary.public_routes > 50);
  assert.ok(matrix.summary.authenticated_routes > 700);
  assert.equal(matrix.summary.missing_openapi_ops, 0);
  assert.equal(matrix.summary.orphan_openapi_ops, 0);
  assert.equal(matrix.summary.unknown_security_routes, 0);
  assert.equal(matrix.summary.openapi_security_missing, 0);
  assert.equal(matrix.summary.openapi_security_mismatches, 0);
  assert.equal(matrix.summary.mutating_without_request_body, 0);
  assert.equal(matrix.summary.response_contract_gaps, 0);
  assert.equal(matrix.summary.unowned_routes, 0);
  assert.equal(matrix.summary.product_journey_route_misses, 0);
  assert.ok(matrix.gates.warnings.some((w) => w.gate === 'non_openapi_router_all_rows'));
  assert.deepEqual(
    matrix.sources,
    [
      'public/docs/api-routes.json',
      'public/openapi.json',
      'public/product-graph.json',
      'docs/product-surfaces.json',
      'docs/product-journeys.json',
      'src/router.js',
    ],
  );
});

test('W937 matrix captures route auth, product ownership, request contracts, and journeys', () => {
  const matrix = readJson(MATRIX_PATH);

  const billing = route(matrix, 'GET /v1/billing/tiers');
  assert.equal(billing.security.level, 'public');
  assert.deepEqual(billing.security.openapi_security, []);
  assert.ok(billing.product_surfaces.some((s) => s.id === 'identity-access-billing'));
  assert.equal(billing.request_contract.required, false);
  assert.equal(billing.state_model, 'read_only');

  const account = route(matrix, 'GET /v1/account');
  assert.equal(account.security.level, 'authenticated');
  assert.ok(account.security.openapi_security.some((s) => s.bearerAuth));
  assert.match(account.security.proof, /auth middleware|r\.use\(authMiddleware\)/);
  assert.ok(account.product_surfaces.some((s) => s.id === 'identity-access-billing'));

  const ab = route(matrix, 'POST /v1/ab/configure');
  assert.equal(ab.source, 'src/ab-routes.js');
  assert.equal(ab.security.level, 'authenticated');
  assert.ok(ab.security.proof.includes('registered from src/router.js'));
  assert.equal(ab.request_contract.required, true);
  assert.equal(ab.request_contract.schema_present, true);
  assert.equal(ab.request_contract.idempotency, 'supported_or_explicit');
  assert.ok(ab.product_surfaces.some((s) => s.id === 'capture-data-eval-training'));

  const capture = route(matrix, 'POST /v1/capture/openai');
  assert.ok(capture.product_journeys.some((j) => j.id === 'gateway-capture'));
  assert.ok(capture.product_surfaces.some((s) => s.id === 'capture-data-eval-training'));
});

test('W937 OpenAPI operations expose explicit security metadata and schemes', () => {
  const openapi = readJson(OPENAPI_PATH);
  assert.deepEqual(Object.keys(openapi.components.securitySchemes).sort(), ['apiKeyAuth', 'bearerAuth']);
  assert.equal(openapi.components.securitySchemes.bearerAuth.type, 'http');
  assert.equal(openapi.components.securitySchemes.apiKeyAuth.in, 'header');

  const publicOp = operation(openapi, 'GET', '/v1/billing/tiers');
  assert.deepEqual(publicOp.security, []);
  assert.equal(publicOp['x-kolm-auth'], 'public');
  assert.match(publicOp['x-kolm-auth-proof'], /before r\.use\(authMiddleware\)|public/);

  const accountOp = operation(openapi, 'GET', '/v1/account');
  assert.deepEqual(accountOp.security, [{ bearerAuth: [] }, { apiKeyAuth: [] }]);
  assert.equal(accountOp['x-kolm-auth'], 'authenticated');
  assert.match(accountOp['x-kolm-auth-proof'], /auth middleware|r\.use\(authMiddleware\)/);

  const abOp = operation(openapi, 'POST', '/v1/ab/configure');
  assert.deepEqual(abOp.security, [{ bearerAuth: [] }, { apiKeyAuth: [] }]);
  assert.equal(abOp['x-kolm-auth'], 'authenticated');
  assert.ok(abOp.requestBody.content['application/json'].schema);
});
