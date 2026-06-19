import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import AdmZip from 'adm-zip';

import { __test__ as T } from '../cli/kolm-tui.mjs';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'tui-workbench-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'tui-workbench-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

function tmpFile(name) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w949-tui-'));
  return path.join(d, name);
}

function buildKolm(filePath, manifest) {
  const z = new AdmZip();
  z.addFile('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf8'));
  z.addFile('recipes.json', Buffer.from(JSON.stringify({ n: 1, recipes: [{ id: 'r1', name: 'rule one' }] }), 'utf8'));
  z.addFile('receipt.json', Buffer.from(JSON.stringify({ rings: 4 }), 'utf8'));
  z.addFile('evals.json', Buffer.from(JSON.stringify({ cases: [] }), 'utf8'));
  fs.writeFileSync(filePath, z.toBuffer());
  return filePath;
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/run',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

test('W949 package wiring makes the TUI workbench matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:tui-workbench-matrix'], 'node scripts/build-tui-workbench-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:tui-workbench-matrix'],
    'node scripts/build-tui-workbench-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave949-tui-workbench-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:data-curate-matrix && npm run build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:otel-matrix && npm run build:readiness-proof-matrix && npm run build:frontier-delta-freshness && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:frontier-delta-freshness && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:spec-compile-matrix && npm run verify:data-curate-matrix && npm run verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-tui-workbench-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/tui-workbench-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/tui-workbench-matrix\.json/);
  assert.match(releaseVerify, /kolm\.tui_workbench_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /TUI_WORKBENCH_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_tui_workbench_matrix_and_cli_distribution_contract/);
  assert.match(backendAtomic, /npm run verify:tui-workbench-matrix/);
});

test('W949 generated matrix is current and all hard TUI workbench gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-tui-workbench-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.tui_workbench_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 3);
  assert.ok(m.summary.function_count >= 30);
  assert.equal(m.summary.static_import_count, 8);
  assert.equal(m.summary.env_ref_count, 0);
  assert.equal(m.summary.test_surface_export_count, 11);
  assert.equal(m.summary.command_count, 15);
  assert.equal(m.summary.present_command_count, 15);
  assert.equal(m.summary.zip_reader_phase_count, 7);
  assert.equal(m.summary.present_zip_reader_phase_count, 7);
  assert.equal(m.summary.serve_guard_count, 7);
  assert.equal(m.summary.present_serve_guard_count, 7);
  assert.equal(m.summary.module_bridge_count, 5);
  assert.equal(m.summary.present_module_bridge_count, 5);
  assert.equal(m.summary.direct_entrypoint_guard_count, 5);
  assert.equal(m.summary.present_direct_entrypoint_guard_count, 5);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.missing_test_surface_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 4);
});

test('W949 matrix captures commands, ZIP phases, serve guards, bridges, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('cli/kolm-tui.mjs'));
  assert.ok(m.sources.includes('cli/kolm.js'));
  assert.ok(m.sources.includes('src/artifact-runner.js'));
  assert.ok(m.sources.includes('src/tune.js'));
  assert.ok(m.sources.includes('src/data-curate.js'));

  const commands = new Set(m.workbench_commands.map((row) => row.id));
  for (const id of ['help', 'exit', 'clear', 'drop', 'recipe', 'receipt', 'eval', 'serve', 'stop', 'run', 'tune', 'distill', 'curate', 'drag_drop_path', 'bare_prompt_run']) {
    assert.ok(commands.has(id), `missing command ${id}`);
  }

  const phases = new Set(m.zip_reader_phases.map((row) => row.id));
  for (const id of ['classic_eocd_scan', 'zip64_extra_resolution', 'zip64_eocd_locator', 'local_entry_decode', 'json_entry_decode', 'streamed_tail_parse', 'large_artifact_streaming_guard']) {
    assert.ok(phases.has(id), `missing ZIP phase ${id}`);
  }

  const guards = new Set(m.serve_guards.map((row) => row.id));
  for (const id of ['loopback_bind', 'bearer_required_by_default', 'constant_time_token_compare', 'entropy_backed_session_token', 'cors_allowlist_only', 'json_body_validation', 'honest_runtime_error_envelope']) {
    assert.ok(guards.has(id), `missing serve guard ${id}`);
  }

  const bridges = new Set(m.module_bridges.map((row) => row.id));
  for (const id of ['artifact_runner_real_infer', 'artifact_runner_eval', 'tune_lifecycle', 'data_curate_default', 'distill_from_captures']) {
    assert.ok(bridges.has(id), `missing module bridge ${id}`);
  }

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W949 TUI workbench primitives stay parseable, loopback-only, and bearer guarded', async () => {
  const tokenA = T.mintSessionToken();
  const tokenB = T.mintSessionToken();
  assert.notEqual(tokenA, tokenB);
  assert.ok(tokenA.length >= 24);
  assert.equal(T.timingSafeEq(tokenA, tokenA), true);
  assert.equal(T.timingSafeEq(tokenA, tokenA + 'x'), false);

  const f = buildKolm(tmpFile('sample.kolm'), {
    task: 'classify logs',
    base_model: 'local-js',
    cid: 'cid_w949',
    k_score: { composite: 0.91 },
  });
  const art = await T.parseKolm(f);
  assert.equal(art.fileName, 'sample.kolm');
  assert.equal(art.manifest.task, 'classify logs');
  assert.equal(art.recipes.recipes[0].id, 'r1');
  assert.ok(art.entryCount >= 4);

  const server = await T.startServe(art, 0, { token: tokenA });
  const port = server.address().port;
  assert.equal(server.address().address, '127.0.0.1');
  try {
    const noAuth = await post(port, { input: 'hello' }, { Origin: 'https://evil.example' });
    assert.equal(noAuth.status, 401);
    assert.equal(JSON.parse(noAuth.body).error_code, 'KOLM_E_UNAUTHORIZED');
    assert.notEqual(noAuth.headers['access-control-allow-origin'], '*');

    const wrongAuth = await post(port, { input: 'hello' }, { Authorization: 'Bearer nope' });
    assert.equal(wrongAuth.status, 401);
  } finally {
    server.close();
  }
});
