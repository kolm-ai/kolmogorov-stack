import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'auth-boundary-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'auth-boundary-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W938 package wiring makes the auth boundary matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:auth-boundary-matrix'], 'node scripts/build-auth-boundary-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:auth-boundary-matrix'],
    'node scripts/build-auth-boundary-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave938-auth-boundary-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:api-contract-matrix && npm run build:auth-boundary-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:api-contract-matrix && npm run verify:auth-boundary-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:router-contract && npm run verify:api-contract-matrix && npm run verify:auth-boundary-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-auth-boundary-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/auth-boundary-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/auth-boundary-matrix\.json/);
  assert.match(releaseVerify, /kolm\.auth_boundary_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /AUTH_BOUNDARY_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_auth_boundary_matrix_and_policy_as_data_contract/);
  assert.match(backendAtomic, /npm run verify:auth-boundary-matrix/);
});

test('W938 generated matrix is current and all hard auth boundary gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-auth-boundary-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.auth_boundary_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.equal(m.summary.public_api_total_rules, 95);
  assert.equal(m.summary.public_api_exact_rules, 67);
  assert.equal(m.summary.public_api_prefix_rules, 5);
  assert.equal(m.summary.public_api_regex_rules, 23);
  assert.equal(m.summary.api_matrix_public_routes, 122);
  assert.equal(m.summary.api_matrix_authenticated_routes, 807);
  assert.equal(m.summary.scope_gate_rules, 18);
  assert.equal(m.summary.scope_families, 8);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_middleware_guards, 0);
  assert.equal(m.summary.missing_scope_families, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
});

test('W938 matrix captures public API policy, middleware guards, and route scopes', () => {
  const m = matrix();
  const exact = new Set(m.public_api_policy.exact.map((r) => r.path));
  const prefixes = new Set(m.public_api_policy.prefixes.map((r) => r.prefix));
  const regexes = m.public_api_policy.regexes.map((r) => r.regex);

  assert.ok(exact.has('/v1/signup'));
  assert.ok(exact.has('/v1/account/saml/acs'));
  assert.ok(prefixes.has('/v1/public/'));
  assert.ok(regexes.some((r) => r.includes('/scim\\/v2\\/Users')));
  assert.ok(regexes.some((r) => r.includes('/trust\\/')));

  assert.deepEqual(Object.values(m.middleware_guards), Object.values(m.middleware_guards).map(() => true));

  const families = new Set(m.scope_policy.families);
  for (const family of ['*', 'account', 'billing', 'identity', 'lake', 'provider_keys', 'team', 'webhook']) {
    assert.ok(families.has(family), `missing scope family ${family}`);
  }
  const scopes = new Set(m.scope_policy.rules.map((r) => r.scope));
  for (const scope of ['*', 'account:keys:read', 'billing:write', 'identity:write', 'lake:export', 'provider_keys:write', 'team:admin', 'webhook:write']) {
    assert.ok(scopes.has(scope), `missing scope ${scope}`);
  }
});

test('W938 matrix captures credential lifecycle, OFAC freshness, and test evidence', () => {
  const m = matrix();
  assert.deepEqual(m.missing_required_exports, []);
  for (const group of ['credential_lifecycle', 'scoped_keys', 'middleware_and_policy']) {
    assert.ok(Array.isArray(m.required_exports[group]), `${group} export list missing`);
    assert.ok(m.required_exports[group].length > 0, `${group} export list must be populated`);
  }
  for (const name of ['hashApiKey', 'findTenantByApiKey', 'rotateTenantKey', 'recoverKeyByEmail']) {
    assert.ok(m.required_exports.credential_lifecycle.includes(name), `missing credential export ${name}`);
  }
  for (const name of ['mintScopedKey', 'revokeScopedKey', 'renewScopedKey', 'keyHasScope']) {
    assert.ok(m.required_exports.scoped_keys.includes(name), `missing scoped key export ${name}`);
  }

  assert.equal(m.ofac_denylist.version_date, '2026-06-16');
  assert.equal(m.ofac_denylist.review_cadence_days, 90);
  assert.equal(m.ofac_denylist.age_days, 2);
  assert.match(m.ofac_denylist.source_url, /^https:\/\//);
  assert.ok(m.ofac_denylist.countries.length >= 6);

  const evidence = new Map(m.test_evidence.map((row) => [row.path, row.present]));
  for (const rel of [
    'tests/auth-hash.test.js',
    'tests/finalized-c9-capability-scopes.test.js',
    'tests/sota-auth.test.js',
    'tests/billing-completeness.test.js',
    'tests/saml-scim.test.js',
    'tests/wave934-provider-compliance-contracts.test.js',
  ]) {
    assert.equal(evidence.get(rel), true, `${rel} must be direct auth-boundary evidence`);
  }
});
