import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'daemon-connector-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'daemon-connector-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

test('W940 package wiring makes the daemon connector matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:daemon-connector-matrix'], 'node scripts/build-daemon-connector-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:daemon-connector-matrix'],
    'node scripts/build-daemon-connector-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave940-daemon-connector-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:cli-command-matrix && npm run build:daemon-connector-matrix && npm run build:quantize-worker-matrix && npm run build:binder-contract-matrix && npm run build:intent-contract-matrix && npm run build:wrapper-cli-matrix && npm run build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:cli-command-matrix && npm run verify:daemon-connector-matrix && npm run verify:quantize-worker-matrix && npm run verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:cli-command-matrix && npm run verify:daemon-connector-matrix && npm run verify:binder-contract-matrix && npm run verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-daemon-connector-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/daemon-connector-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/daemon-connector-matrix\.json/);
  assert.match(releaseVerify, /kolm\.daemon_connector_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /DAEMON_CONNECTOR_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_daemon_connector_matrix_and_privacy_proxy_contract/);
  assert.match(backendAtomic, /npm run verify:daemon-connector-matrix/);
});

test('W940 generated matrix is current and all hard daemon connector gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-daemon-connector-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.daemon_connector_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 6);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.route_count, 17);
  assert.equal(m.summary.passthrough_route_count, 14);
  assert.equal(m.summary.status_route_count, 3);
  assert.equal(m.summary.direct_provider_count, 4);
  assert.equal(m.summary.provider_registry_count, 12);
  assert.equal(m.summary.supported_provider_id_count, 11);
  assert.equal(m.summary.fixture_shape_count, 8);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
});

test('W940 matrix captures lifecycle exports, direct provider routes, and fixture shapes', () => {
  const m = matrix();
  const exports = new Set(m.exports.map((row) => row.name));
  for (const name of ['resolveUpstreamKey', 'buildDaemonApp', 'startDaemon', 'stopDaemon', 'daemonStatus', '_internals']) {
    assert.ok(exports.has(name), `missing export ${name}`);
  }

  assert.deepEqual(m.direct_provider_ids, ['anthropic', 'gemini', 'openai', 'openrouter']);
  const routes = new Map(m.routes.map((row) => [`${row.method} ${row.path}`, row]));
  for (const key of [
    'POST /v1/chat/completions',
    'POST /v1/responses',
    'POST /v1/embeddings',
    'POST /v1/audio/transcriptions',
    'POST /v1/audio/speech',
    'POST /v1/capture/openrouter/chat/completions',
    'POST /v1/messages',
    'GET /v1/health',
    'GET /health',
    'GET /v1/models',
  ]) {
    assert.ok(routes.has(key), `missing daemon route ${key}`);
  }

  const fixturePaths = new Set(m.fixture_shapes.map((row) => row.upstream_path));
  for (const p of ['/v1/messages', '/v1/chat/completions', '/v1/responses', '/v1/embeddings', '/v1/audio/transcriptions', '/v1/audio/translations', '/v1/audio/speech', '/v1/moderations']) {
    assert.ok(fixturePaths.has(p), `missing fixture shape for ${p}`);
  }
});

test('W940 matrix captures daemon safety guards, provider registry, and direct test evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true);

  for (const provider of ['openai', 'anthropic', 'openrouter', 'gemini', 'google', 'deepseek', 'groq', 'together', 'fireworks', 'local-vllm', 'local-ollama', 'local-kolm']) {
    assert.ok(m.provider_registry_ids.includes(provider), `provider registry missing ${provider}`);
  }
  for (const provider of ['openai', 'anthropic', 'openrouter', 'google', 'deepseek', 'groq', 'together', 'fireworks', 'local-vllm', 'local-ollama', 'local-kolm']) {
    assert.ok(m.supported_provider_ids.includes(provider), `supported provider list missing ${provider}`);
  }

  const evidence = new Map(m.test_evidence.map((row) => [row.path, row.present]));
  for (const rel of [
    'tests/wave368-connector.test.js',
    'tests/wave407b-connector-fixes.test.js',
    'tests/wave409a-canonical-event-store.test.js',
    'tests/wave409b-privacy-failclosed.test.js',
    'tests/wave409k-openai-compat-surface.test.js',
    'tests/wave411-redaction-leak.test.js',
    'tests/wave470-suite-order-determinism.test.js',
    'tests/wave549-hosted-connector-upstream-key.test.js',
    'tests/wave550-cors-contract.test.js',
  ]) {
    assert.equal(evidence.get(rel), true, `${rel} must be direct daemon connector evidence`);
  }
});
