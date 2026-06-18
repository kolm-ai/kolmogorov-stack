import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';

import * as otel from '../src/otel.js';

const ROOT = path.resolve('.');
const MATRIX_PATH = path.join(ROOT, 'docs', 'internal', 'otel-matrix.json');

function readJson(relOrAbs) {
  return JSON.parse(fs.readFileSync(path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs), 'utf8'));
}

function matrix() {
  assert.ok(fs.existsSync(MATRIX_PATH), 'otel-matrix.json must exist');
  return readJson(MATRIX_PATH);
}

function attrMap(otlpAttrs) {
  const out = {};
  for (const a of otlpAttrs || []) {
    const v = a.value || {};
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
    else if (v.arrayValue !== undefined) out[a.key] = (v.arrayValue.values || []).map((x) => x.stringValue ?? x.intValue ?? x.doubleValue ?? x.boolValue);
  }
  return out;
}

function allSpans(received) {
  const out = [];
  for (const rs of received.traces) {
    for (const ss of rs.resourceSpans[0].scopeSpans) {
      for (const s of ss.spans) out.push(s);
    }
  }
  return out;
}

async function withOtlpSink(fn, env = {}) {
  const saved = {};
  for (const key of ['KOLM_OTEL', 'KOLM_OTEL_DEBUG', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_SERVICE_NAME']) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  await otel.shutdown();

  const received = { traces: [], metrics: [], headers: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    received.headers.push(req.headers);
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        if (req.url === '/v1/traces') received.traces.push(parsed);
        if (req.url === '/v1/metrics') received.metrics.push(parsed);
      } catch (_) { /* ignore malformed body */ }
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  Object.assign(process.env, {
    KOLM_OTEL: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    ...env,
  });
  try {
    otel.init({ serviceName: 'kolm-w951' });
    await fn(received);
    await otel.flush();
    await new Promise((resolve) => setTimeout(resolve, 80));
  } finally {
    await otel.shutdown();
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return received;
}

test('W951 package wiring makes the OTEL matrix a depth and control-file gate', () => {
  const pkg = readJson('package.json');
  assert.equal(pkg.scripts['build:otel-matrix'], 'node scripts/build-otel-matrix.cjs');
  assert.equal(
    pkg.scripts['verify:otel-matrix'],
    'node scripts/build-otel-matrix.cjs --check --summary && node --test --test-concurrency=1 tests/wave951-otel-matrix.test.js',
  );
  assert.match(pkg.scripts['build:control-files'], /build:bench-harness-matrix && npm run build:otel-matrix && npm run build:file-ledger/);
  assert.match(pkg.scripts['verify:control-files'], /verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:file-ledger/);
  assert.match(pkg.scripts['verify:depth'], /verify:bench-harness-matrix && npm run verify:otel-matrix && npm run verify:meta-routes/);

  const ledgerBuilder = fs.readFileSync(path.join(ROOT, 'scripts', 'build-codebase-file-ledger.cjs'), 'utf8');
  assert.match(ledgerBuilder, /build-otel-matrix\.cjs/);
  assert.match(ledgerBuilder, /docs\/internal\/otel-matrix\.json/);

  const releaseVerify = fs.readFileSync(path.join(ROOT, 'scripts', 'release-verify.cjs'), 'utf8');
  assert.match(releaseVerify, /docs\/internal\/otel-matrix\.json/);
  assert.match(releaseVerify, /kolm\.otel_matrix\.v1/);

  const backendAtomic = fs.readFileSync(path.join(ROOT, 'scripts', 'build-backend-atomic-deep-dive.mjs'), 'utf8');
  assert.match(backendAtomic, /OTEL_MATRIX/);
  assert.match(backendAtomic, /maintain_generated_otel_matrix_and_privacy_safe_semconv_contract/);
  assert.match(backendAtomic, /npm run verify:otel-matrix/);
});

test('W951 generated matrix is current and all hard OTEL gates are green', () => {
  execFileSync(process.execPath, ['scripts/build-otel-matrix.cjs', '--check', '--summary'], {
    cwd: ROOT,
    stdio: 'pipe',
    timeout: 60_000,
  });
  const m = matrix();

  assert.equal(m.schema, 'kolm.otel_matrix.v1');
  assert.equal(m.updated_at, '2026-06-18');
  assert.equal(m.gates.ok, true, JSON.stringify(m.gates.failures, null, 2));
  assert.deepEqual(m.gates.failures, []);
  assert.deepEqual(m.gates.warnings, []);
  assert.equal(m.summary.export_count, 37);
  assert.ok(m.summary.function_count >= 50);
  assert.equal(m.summary.env_ref_count, 8);
  assert.equal(m.summary.w733_attr_count, 12);
  assert.equal(m.summary.w733_span_name_count, 4);
  assert.equal(m.summary.genai_attr_count, 21);
  assert.equal(m.summary.genai_metric_count, 3);
  assert.equal(m.summary.token_bucket_count, 14);
  assert.equal(m.summary.duration_bucket_count, 14);
  assert.equal(m.summary.ttft_bucket_count, 16);
  assert.equal(m.summary.phase_count, 20);
  assert.equal(m.summary.present_phase_count, 20);
  assert.equal(m.summary.privacy_control_count, 16);
  assert.equal(m.summary.present_privacy_control_count, 16);
  assert.equal(m.summary.missing_required_exports, 0);
  assert.equal(m.summary.failed_safety_guards, 0);
  assert.equal(m.summary.missing_test_evidence, 0);
});

test('W951 matrix captures OTEL phases, privacy controls, semconv keys, and evidence', () => {
  const m = matrix();
  assert.equal(Object.values(m.safety_guards).every(Boolean), true, JSON.stringify(m.failed_safety_guards, null, 2));
  assert.deepEqual(m.failed_safety_guards, []);
  assert.ok(m.sources.includes('src/otel.js'));
  assert.ok(m.sources.includes('src/otel-attrs.js'));
  assert.ok(m.sources.includes('src/router.js'));

  const phases = new Set(m.otel_phases.map((row) => row.id));
  for (const id of ['disabled_noop_init', 'span_start', 'span_end', 'otlp_flush', 'express_middleware', 'routing_attrs', 'inference_subspans', 'genai_span_start', 'genai_span_finish', 'genai_histograms']) {
    assert.ok(phases.has(id), `missing phase ${id}`);
  }

  const privacy = new Set(m.privacy_controls.map((row) => row.id));
  for (const id of ['attribute_key_cap', 'attribute_value_cap', 'event_count_cap', 'resource_attr_cap', 'http_target_redaction', 'secret_pair_redaction', 'tenant_hash_only', 'content_capture_opt_in', 'export_timeout']) {
    assert.ok(privacy.has(id), `missing privacy control ${id}`);
  }

  assert.equal(m.genai_metrics.TOKEN_USAGE, 'gen_ai.client.token.usage');
  assert.equal(m.genai_metrics.OPERATION_DURATION, 'gen_ai.client.operation.duration');
  assert.equal(m.genai_metrics.TIME_TO_FIRST_TOKEN, 'gen_ai.server.time_to_first_token');
  assert.equal(m.w733_attrs.TENANT_ID_HASH, 'kolm.tenant.id_hash');
  assert.equal(m.limits.max_attr_value_chars, 512);

  const evidence = new Set(m.test_evidence.map((row) => row.path));
  for (const rel of m.required_test_evidence) assert.ok(evidence.has(rel), `missing evidence ${rel}`);
});

test('W951 OTEL exporter caps/redacts resource attrs, span attrs, events, and status messages', async () => {
  const received = await withOtlpSink(async () => {
    const attrs = {
      secret_url: 'https://example.test/run?token=ks_otelsecret_12345678901234567890',
      long_value: 'x'.repeat(otel.OTEL_LIMITS.max_attr_value_chars + 80),
    };
    for (let i = 0; i < otel.OTEL_LIMITS.max_attrs_per_record + 20; i++) attrs[`attr_${i}`] = `value_${i}`;
    const span = otel.startSpan(`kolm.${'x'.repeat(260)}`, attrs);
    const events = Array.from({ length: otel.OTEL_LIMITS.max_events_per_span + 10 }, (_, i) => ({
      name: `event_${i}`,
      attrs: { detail: `key=event-secret-${i}` },
    }));
    otel.endSpan(span, {
      status: 'error',
      message: `token=status-secret-123456 ${'y'.repeat(400)}`,
      events,
      attrs: { extra_secret: 'sk-otelRuntimeSecret1234567890' },
    });
  }, {
    OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment=prod,secret=sk-resourceSecret1234567890',
  });

  const span = allSpans(received)[0];
  assert.ok(span.name.length <= otel.OTEL_LIMITS.max_span_name_chars);
  assert.ok(span.attributes.length <= otel.OTEL_LIMITS.max_attrs_per_record + 1);
  assert.ok(span.events.length <= otel.OTEL_LIMITS.max_events_per_span);
  assert.ok(span.status.message.length <= 256);
  const serialized = JSON.stringify(received);
  assert.equal(serialized.includes('ks_otelsecret'), false);
  assert.equal(serialized.includes('status-secret'), false);
  assert.equal(serialized.includes('event-secret'), false);
  assert.equal(serialized.includes('resourceSecret'), false);
  assert.equal(serialized.includes('sk-otelRuntimeSecret'), false);
  assert.ok(serialized.includes('[redacted-secret]'));

  const resourceAttrs = attrMap(received.traces[0].resourceSpans[0].resource.attributes);
  assert.equal(resourceAttrs.secret, '[redacted-secret]');
});

test('W951 express middleware redacts query secrets from http.target while preserving route', async () => {
  const received = await withOtlpSink(async () => {
    const middleware = otel.expressMiddleware();
    const res = new EventEmitter();
    res.statusCode = 200;
    const req = {
      method: 'GET',
      originalUrl: '/v1/run?token=ks_httpTargetSecret1234567890&ok=1',
      route: { path: '/v1/run' },
      get(name) {
        return String(name).toLowerCase() === 'user-agent' ? 'w951-test-agent' : '';
      },
    };
    middleware(req, res, () => {});
    assert.ok(req.kolmSpan, 'middleware should attach a span');
    res.emit('finish');
  });

  const span = allSpans(received)[0];
  const attrs = attrMap(span.attributes);
  assert.equal(attrs['http.route'], '/v1/run');
  assert.equal(attrs['http.target'].includes('ks_httpTargetSecret'), false);
  assert.equal(attrs['http.target'].includes('token=[redacted-secret]'), true);
  assert.equal(attrs['http.user_agent'], 'w951-test-agent');
});
