import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  CAPTURES_VERBS,
  GATEWAY_VERBS,
  NAMESPACE_WRAPPER_VERBS,
  RECEIPTS_VERBS,
  WRAPPER_CLI_VERSION,
  capturesHelp,
  gatewayHelp,
  gatewayProviders,
  namespaceWrapperHelp,
  nsConfig,
  nsCreate,
  nsDeploy,
  nsStatus,
  receiptsHelp,
} from '../src/wrapper-cli.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'wrapper-cli-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'wrapper-cli-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

async function captureJson(fn) {
  const originalLog = console.log;
  const previousExitCode = process.exitCode;
  const lines = [];
  console.log = (msg) => { lines.push(String(msg)); };
  process.exitCode = undefined;
  try {
    await fn();
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
  }
  assert.ok(lines.length > 0, 'expected wrapper function to emit JSON');
  return JSON.parse(lines[lines.length - 1]);
}

function withEnv(patch, fn) {
  const old = {};
  for (const key of Object.keys(patch)) old[key] = process.env[key];
  for (const [key, value] of Object.entries(patch)) {
    if (value == null) delete process.env[key];
    else process.env[key] = String(value);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (old[key] == null) delete process.env[key];
        else process.env[key] = old[key];
      }
    });
}

function startTextServer(status, body) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { 'content-type': 'text/plain' });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('W944 package wiring makes the wrapper CLI matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:wrapper-cli-matrix'], 'node scripts/build-wrapper-cli-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:wrapper-cli-matrix'],
    'node scripts/build-wrapper-cli-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave944-wrapper-cli-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:intent-contract-matrix && npm run build:wrapper-cli-matrix && npm run build:distill-pipeline-matrix && npm run build:spec-compile-matrix && npm run build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:otel-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:intent-contract-matrix && npm run verify:wrapper-cli-matrix && npm run verify:distill-pipeline-matrix && npm run verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-wrapper-cli-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/wrapper-cli-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/wrapper-cli-matrix\.json/);
  assert.match(releaseVerify, /kolm\.wrapper_cli_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /WRAPPER_CLI_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_wrapper_cli_matrix_and_gateway_capture_receipt_namespace_contract/);
  assert.match(backendAtomic, /npm run verify:wrapper-cli-matrix/);
});

test('W944 generated matrix is current and all hard wrapper gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-wrapper-cli-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.wrapper_cli_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 36);
  assert.ok(m.summary.function_count >= 65);
  assert.equal(m.summary.command_family_count, 4);
  assert.equal(m.summary.command_count, 27);
  assert.equal(m.summary.gateway_command_count, 7);
  assert.equal(m.summary.captures_command_count, 9);
  assert.equal(m.summary.receipts_command_count, 5);
  assert.equal(m.summary.namespace_command_count, 6);
  assert.equal(m.summary.duplicate_command_count, 0);
  assert.equal(m.summary.endpoint_count, 13);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 29);
});

test('W944 matrix captures command families, CLI delegation, safety guards, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true);

  const families = new Map(m.command_families.map((row) => [row.family, row.count]));
  assert.equal(families.get('gateway'), 7);
  assert.equal(families.get('captures'), 9);
  assert.equal(families.get('receipts'), 5);
  assert.equal(families.get('namespace'), 6);

  const commands = new Set(m.commands.map((row) => `${row.family}:${row.verb}:${row.fn_name}`));
  for (const key of [
    'gateway:call:gatewayCall',
    'gateway:simulate-overflow:gatewaySimulateOverflow',
    'captures:seed:capturesSeed',
    'captures:purge:capturesPurge',
    'receipts:rotate-key:receiptsRotateKey',
    'namespace:status:nsStatus',
  ]) {
    assert.ok(commands.has(key), `missing command binding ${key}`);
  }

  for (const rel of m.required_test_evidence) {
    assert.ok(m.test_evidence.some((row) => row.path === rel), `${rel} must be wrapper evidence`);
  }
});

test('W944 runtime wrapper tables stay complete and help is table-derived', () => {
  assert.equal(WRAPPER_CLI_VERSION, 'wrapper-f-v1');
  assert.equal(Object.keys(GATEWAY_VERBS).length, 7);
  assert.equal(Object.keys(CAPTURES_VERBS).length, 9);
  assert.equal(Object.keys(RECEIPTS_VERBS).length, 5);
  assert.equal(Object.keys(NAMESPACE_WRAPPER_VERBS).length, 6);

  for (const [family, table] of Object.entries({
    gateway: GATEWAY_VERBS,
    captures: CAPTURES_VERBS,
    receipts: RECEIPTS_VERBS,
    namespace: NAMESPACE_WRAPPER_VERBS,
  })) {
    for (const [verb, spec] of Object.entries(table)) {
      assert.equal(typeof spec.fn, 'function', `${family}:${verb} must bind a function`);
      assert.ok(spec.help.length >= 8, `${family}:${verb} must have help text`);
    }
  }

  assert.match(gatewayHelp(), /simulate-overflow/);
  assert.match(capturesHelp(), /seed/);
  assert.match(receiptsHelp(), /rotate-key/);
  assert.match(namespaceWrapperHelp(), /status/);
});

test('W944 namespace wrapper actions round-trip through local-first state', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w944-wrapper-'));
  try {
    await withEnv({ KOLM_DATA_DIR: tmp, KOLM_API_KEY: null, KOLM_KEY: null }, async () => {
      const created = await captureJson(() => nsCreate(['support', '--display-name', 'Support', '--capture-mode', 'all']));
      assert.equal(created.ok, true);
      assert.equal(created.mode, 'local');
      assert.equal(created.local.slug, 'support');

      const configured = await captureJson(() => nsConfig(['support', '--set', 'primary=local', '--set', 'confidence_threshold=0.82']));
      assert.equal(configured.ok, true);
      assert.equal(configured.config.primary, 'local');
      assert.equal(configured.config.confidence_threshold, 0.82);

      const deployed = await captureJson(() => nsDeploy(['support', '--artifact', 'art_123']));
      assert.equal(deployed.ok, true);
      assert.equal(deployed.config.deployed, true);
      assert.equal(deployed.config.artifact_id, 'art_123');

      const status = await captureJson(() => nsStatus(['support']));
      assert.equal(status.ok, true);
      assert.equal(status.mode, 'local');
      assert.equal(status.deployed, true);
      assert.equal(status.artifact_id, 'art_123');
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('W944 wrapper server-error fallback caps non-JSON raw response bodies', async () => {
  const huge = 'secret-token-should-not-repeat '.repeat(600);
  const { server, base } = await startTextServer(503, huge);
  try {
    await withEnv({ KOLM_API_KEY: 'ks_test', KOLM_KEY: null }, async () => {
      const out = await captureJson(() => gatewayProviders(['--base', base]));
      assert.equal(out.ok, true);
      assert.equal(out.source, 'local-registry');
      assert.equal(out.server_error.status, 503);
      assert.equal(out.server_error.json._raw.length, 4096);
      assert.equal(out.server_error.json._raw_truncated, true);
    });
  } finally {
    server.close();
  }
});
