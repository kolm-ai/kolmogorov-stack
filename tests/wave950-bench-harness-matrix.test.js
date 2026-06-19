import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveModelTarget, runBench, runViaGateway } from '../src/bench-harness.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'bench-harness-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'bench-harness-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w950-bench-'));
}

test('W950 package wiring makes the bench harness matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:bench-harness-matrix'], 'node scripts/build-bench-harness-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:bench-harness-matrix'],
    'node scripts/build-bench-harness-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave950-bench-harness-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:artifact-matrix && npm run build:tui-workbench-matrix && npm run build:bench-harness-matrix && npm run build:otel-matrix && npm run build:readiness-proof-matrix && npm run build:frontier-delta-freshness && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:frontier-delta-freshness && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:artifact-matrix && npm run verify:tui-workbench-matrix && npm run verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:readiness-proof-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-bench-harness-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/bench-harness-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/bench-harness-matrix\.json/);
  assert.match(releaseVerify, /kolm\.bench_harness_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /BENCH_HARNESS_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_bench_harness_matrix_and_privacy_safe_measurement_contract/);
  assert.match(backendAtomic, /npm run verify:bench-harness-matrix/);
});

test('W950 generated matrix is current and all hard bench harness gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-bench-harness-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.bench_harness_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 9);
  assert.ok(m.summary.function_count >= 40);
  assert.equal(m.summary.env_ref_count, 14);
  assert.equal(m.summary.suite_count, 4);
  assert.equal(m.summary.total_prompt_count, 237);
  assert.equal(m.summary.metric_count, 12);
  assert.equal(m.summary.phase_count, 14);
  assert.equal(m.summary.present_phase_count, 14);
  assert.equal(m.summary.transport_count, 12);
  assert.equal(m.summary.present_transport_count, 12);
  assert.equal(m.summary.report_field_count, 7);
  assert.equal(m.summary.present_report_field_count, 7);
  assert.equal(m.summary.sample_field_count, 10);
  assert.equal(m.summary.present_sample_field_count, 10);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
  assert.ok(m.summary.direct_test_evidence_count >= 3);
});

test('W950 matrix captures suites, metrics, transports, phases, samples, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/bench-harness.js'));
  assert.ok(m.sources.includes('src/bench-eval-suites.js'));
  assert.ok(m.sources.includes('src/benchmark-evidence.js'));

  const suites = new Set(m.benchmark_suites.map((row) => row.id));
  for (const id of ['support-clarity-57', 'reasoning-deepseek-50', 'gateway-overhead-100', 'pii-redaction-30']) {
    assert.ok(suites.has(id), `missing suite ${id}`);
  }

  const metrics = new Set(m.metric_registry.map((row) => row.id));
  for (const id of ['mean_ms', 'p95_ms', 'cost_per_1k_usd', 'judge_on_policy_rate', 'correctness@1', 'pii_blocked_in_input', 'pii_redacted_in_output']) {
    assert.ok(metrics.has(id), `missing metric ${id}`);
  }

  const transports = new Set(m.transport_targets.map((row) => row.id));
  for (const id of ['fake', 'gateway', 'local_gguf', 'local_ollama', 'local_vllm', 'local_kolm', 'trinity_alias', 'anthropic_direct', 'openai_direct', 'deepseek_direct', 'gemini_direct', 'unknown_fallback']) {
    assert.ok(transports.has(id), `missing transport ${id}`);
  }

  const phases = new Set(m.benchmark_phases.map((row) => row.id));
  for (const id of ['suite_resolution', 'target_resolution', 'sequential_suite_run', 'json_artifact_write', 'hash_only_sample_serialization', 'raw_sample_opt_in', 'bounded_provider_fetch', 'bounded_local_gguf_spawn', 'gateway_dispatch', 'error_redaction']) {
    assert.ok(phases.has(id), `missing phase ${id}`);
  }

  const sampleFields = new Set(m.sample_fields.map((row) => row.field));
  for (const field of ['prompt_id', 'prompt_sha256', 'response_sha256', 'prompt_chars', 'response_chars', 'ms', 'in_tok', 'out_tok', 'error', 'receipt_id']) {
    assert.ok(sampleFields.has(field), `missing sample field ${field}`);
  }

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W950 bench reports are hash-only by default and raw text is explicit opt-in', async () => {
  const tmp = tmpDir();
  try {
    const out = await runBench({
      suiteId: 'support-clarity-57',
      models: ['fake:privacy'],
      n: 2,
      dry_run: true,
      outDir: tmp,
      timestamp: '2026-06-18T00:00:00.000Z',
    });
    assert.equal(out.sample_privacy, 'hash-only');
    const payload = readJson(out.comparison_json_path);
    assert.equal(payload.sample_privacy, 'hash-only');
    const sample = payload.per_model_samples['fake:privacy'][0];
    assert.match(sample.prompt_sha256, /^[a-f0-9]{64}$/);
    assert.match(sample.response_sha256, /^[a-f0-9]{64}$/);
    assert.equal(typeof sample.prompt_chars, 'number');
    assert.equal(typeof sample.response_chars, 'number');
    assert.equal(sample.prompt_text, undefined);
    assert.equal(sample.response_text, undefined);

    const rawOut = await runBench({
      suiteId: 'support-clarity-57',
      models: ['fake:raw'],
      n: 1,
      dry_run: true,
      include_raw_samples: true,
      outDir: tmp,
      timestamp: '2026-06-18T00:00:01.000Z',
    });
    assert.equal(rawOut.sample_privacy, 'raw-opt-in');
    const rawPayload = readJson(rawOut.comparison_json_path);
    assert.equal(rawPayload.sample_privacy, 'raw-opt-in');
    const rawSample = rawPayload.per_model_samples['fake:raw'][0];
    assert.equal(typeof rawSample.prompt_text, 'string');
    assert.equal(typeof rawSample.response_text, 'string');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('W950 thrown provider errors are redacted and capped in serialized samples', async () => {
  const tmp = tmpDir();
  try {
    const out = await runBench({
      suiteId: 'support-clarity-57',
      models: ['failing-provider'],
      n: 1,
      dry_run: false,
      outDir: tmp,
      timestamp: '2026-06-18T00:00:02.000Z',
      transport_factory(spec) {
        return {
          id: String(spec),
          transport: 'direct',
          provider: 'unit-provider',
          model: 'unit-model',
          async send() {
            throw new Error(`sk-abc123XYZ987DEF456ghi789jkl012 key=unit-secret-query-value-123456 ${'x'.repeat(1000)}`);
          },
        };
      },
    });
    const payload = readJson(out.comparison_json_path);
    const sample = payload.per_model_samples['failing-provider'][0];
    assert.equal(sample.error.includes('sk-'), false);
    assert.equal(sample.error.includes('unit-secret-query-value'), false);
    assert.equal(sample.error.includes('[redacted-secret]'), true);
    assert.ok(sample.error.length <= 512, `error should be capped, got ${sample.error.length}`);
    assert.equal(sample.prompt_text, undefined);
    assert.equal(sample.response_text, undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('W950 local GGUF target identifiers never expose absolute paths', async () => {
  const sensitivePath = path.join(os.tmpdir(), 'kolm-private-models', 'tenant-a', 'secret-model.gguf');
  const target = resolveModelTarget(`gguf:${sensitivePath}`);
  assert.match(target.id, /^gguf:secret-model\.gguf:[a-f0-9]{12}$/);
  assert.equal(target.id.includes('kolm-private-models'), false);
  assert.equal(target.id.includes('tenant-a'), false);

  const out = await target.send('hello');
  assert.equal(out.text, '');
  assert.equal(out.error.includes('kolm-private-models'), false);
  assert.equal(out.error.includes('tenant-a'), false);
  assert.match(out.error, /^gguf_not_found:gguf:secret-model\.gguf:[a-f0-9]{12}$/);
});

test('W950 gateway dispatch obeys the per-call timeout', async () => {
  const sockets = new Set();
  const server = http.createServer((_req, _res) => {
    // Intentionally do not respond; runViaGateway must abort through timeout_ms.
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const t0 = Date.now();
    const out = await runViaGateway('unit-model', 'hello', 'ks_unit_timeout_token_123456', `http://127.0.0.1:${port}`, 30);
    assert.ok(Date.now() - t0 < 1500, `gateway timeout took too long: ${Date.now() - t0}ms`);
    assert.equal(out.text, '');
    assert.equal(out.in_tok, 0);
    assert.equal(out.out_tok, 0);
    assert.ok(/bench_request_timeout|aborted|AbortError|The operation was aborted/i.test(out.error), out.error);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
