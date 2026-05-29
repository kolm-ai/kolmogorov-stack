// W921 — OpenTelemetry GenAI semantic-convention emitter (gen_ai.*) tests.
//
// Mirrors tests/wave733-otel.test.js: a fresh KOLM_DATA_DIR + wiped tracer
// hook per test, no @opentelemetry/api installed so the kolm-native exporter
// path is exercised. Several tests stand up a local http listener as a fake
// OTLP sink, set OTEL_EXPORTER_OTLP_ENDPOINT to it, KOLM_OTEL=1, init(), emit,
// flush(), and assert the on-the-wire OTLP/HTTP/JSON payload.
//
// Atomic items pinned to the spec (gateway-route-capture OTel gen_ai spec):
//   1) GEN_AI_ATTRS exports the exact spec key strings.
//   2) mapProviderToGenAi enum mapping + lowercased fallback + openrouter.
//   3) mapFinishReason anthropic->openai vocab; openai passthrough; null.
//   4) startGenAiSpan sets required+recommended request attrs; name=`chat <m>`;
//      SpanKind CLIENT (kind:3 in OTLP).
//   5) finishGenAiSpan exports response attrs + finish_reasons[] + usage; on
//      error sets error.type + status code 2.
//   6) The 3 metrics: token.usage TWICE (input+output) as histograms with
//      explicitBounds===GENAI_TOKEN_BUCKETS; operation.duration unit 's' value
//      ===durationMs/1000 with GENAI_DURATION_BUCKETS; time_to_first_token only
//      when ttftMs provided.
//   7) Honest no-op: KOLM_OTEL=0 + no tracer -> emitters do not throw + emit
//      nothing.
//   8) Privacy: content OFF by default; KOLM_OTEL_CAPTURE_CONTENT=1 emits ONLY
//      post-redaction text (SSN masked).
//   9) Compat flag: gen_ai.system absent by default; present (===provider.name)
//      only under KOLM_OTEL_SEMCONV_COMPAT=1.
//  10) Histogram OTLP shape: bucketCounts.length === explicitBounds.length+1.
//  11) W733/W823 dual-dialect: kolm.* attrs attach to the SAME span.
//  12) No new @opentelemetry/* package.json dep.
//
// W604 anti-brittleness: assertions key on load-bearing tokens (exact key
// strings, metric names, units, bucket arrays, OTLP kind/status codes), not
// free-form ordering.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import * as otel from '../src/otel.js';
import { applyMode } from '../src/pii-redactor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(REPO_ROOT, 'package.json');

// Reset env between tests so the "honest no-op" default is exercised. Tests
// that need the native exporter opt in explicitly.
function resetEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w921-otel-'));
  process.env.KOLM_DATA_DIR = path.join(tmp, '.kolm');
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.KOLM_ENV = 'test';
  delete process.env.KOLM_OTEL;
  delete process.env.KOLM_OTEL_SEMCONV_COMPAT;
  delete process.env.KOLM_OTEL_CAPTURE_CONTENT;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete globalThis.__OTEL_TRACER__;
  return tmp;
}

// Stand up a fake OTLP/HTTP/JSON sink, run `fn(port)`, collect every POSTed
// payload, then tear everything down. Returns { traces, metrics }.
async function withOtlpSink(fn) {
  const received = { traces: [], metrics: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        if (req.url === '/v1/traces') received.traces.push(j);
        else if (req.url === '/v1/metrics') received.metrics.push(j);
      } catch (_e) { /* ignore malformed */ }
      res.statusCode = 200;
      res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  process.env.KOLM_OTEL = '1';
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
  try {
    otel.init();
    await fn(port, received);
    await otel.flush();
    await new Promise((r) => setTimeout(r, 120));
  } finally {
    await otel.shutdown();
    await new Promise((resolve) => server.close(resolve));
  }
  return received;
}

function allMetrics(received) {
  const out = [];
  for (const rm of received.metrics) {
    for (const sm of rm.resourceMetrics[0].scopeMetrics) {
      for (const m of sm.metrics) out.push(m);
    }
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

function attrMap(otlpAttrs) {
  const out = {};
  for (const a of otlpAttrs || []) {
    const v = a.value || {};
    if (v.stringValue !== undefined) out[a.key] = v.stringValue;
    else if (v.intValue !== undefined) out[a.key] = Number(v.intValue);
    else if (v.doubleValue !== undefined) out[a.key] = v.doubleValue;
    else if (v.boolValue !== undefined) out[a.key] = v.boolValue;
    else if (v.arrayValue !== undefined) out[a.key] = (v.arrayValue.values || []).map((x) => x.stringValue !== undefined ? x.stringValue : (x.intValue !== undefined ? Number(x.intValue) : x.doubleValue));
  }
  return out;
}

// =============================================================================
// 1) GEN_AI_ATTRS exports the exact spec key strings
// =============================================================================

test('W921 #1 — GEN_AI_ATTRS exports the exact gen_ai.* spec keys', () => {
  resetEnv();
  const A = otel.GEN_AI_ATTRS;
  assert.equal(A.OPERATION_NAME, 'gen_ai.operation.name');
  assert.equal(A.PROVIDER_NAME, 'gen_ai.provider.name');
  assert.equal(A.SYSTEM, 'gen_ai.system');
  assert.equal(A.REQUEST_MODEL, 'gen_ai.request.model');
  assert.equal(A.RESPONSE_MODEL, 'gen_ai.response.model');
  assert.equal(A.RESPONSE_ID, 'gen_ai.response.id');
  assert.equal(A.FINISH_REASONS, 'gen_ai.response.finish_reasons');
  assert.equal(A.USAGE_INPUT_TOKENS, 'gen_ai.usage.input_tokens');
  assert.equal(A.USAGE_OUTPUT_TOKENS, 'gen_ai.usage.output_tokens');
  assert.equal(A.REQUEST_MAX_TOKENS, 'gen_ai.request.max_tokens');
  assert.equal(A.REQUEST_TEMPERATURE, 'gen_ai.request.temperature');
  assert.equal(A.TIME_TO_FIRST_CHUNK, 'gen_ai.response.time_to_first_chunk');
  assert.equal(A.TOKEN_TYPE, 'gen_ai.token.type');
  assert.equal(A.SERVER_ADDRESS, 'server.address');
  assert.equal(A.SERVER_PORT, 'server.port');
  assert.equal(A.ERROR_TYPE, 'error.type');
  // Metric names byte-match.
  assert.equal(otel.GEN_AI_METRICS.TOKEN_USAGE, 'gen_ai.client.token.usage');
  assert.equal(otel.GEN_AI_METRICS.OPERATION_DURATION, 'gen_ai.client.operation.duration');
  assert.equal(otel.GEN_AI_METRICS.TIME_TO_FIRST_TOKEN, 'gen_ai.server.time_to_first_token');
  // Frozen — one source of truth so a key rename can't drift per-callsite.
  assert.ok(Object.isFrozen(A), 'GEN_AI_ATTRS must be frozen');
  assert.ok(Object.isFrozen(otel.GEN_AI_METRICS), 'GEN_AI_METRICS must be frozen');
});

// =============================================================================
// 2) mapProviderToGenAi
// =============================================================================

test('W921 #2 — mapProviderToGenAi enum + lowercased fallback + openrouter', () => {
  resetEnv();
  assert.equal(otel.mapProviderToGenAi('anthropic'), 'anthropic');
  assert.equal(otel.mapProviderToGenAi('openai'), 'openai');
  assert.equal(otel.mapProviderToGenAi('deepseek'), 'deepseek');
  assert.equal(otel.mapProviderToGenAi('groq'), 'groq');
  assert.equal(otel.mapProviderToGenAi('google'), 'gcp.gemini');
  assert.equal(otel.mapProviderToGenAi('gemini'), 'gcp.gemini');
  // Unknown -> lowercased fallback (OTel-attribute-safe).
  assert.equal(otel.mapProviderToGenAi('SomeNewVendor'), 'somenewvendor');
  // openrouter passthrough resolves the underlying vendor when derivable.
  assert.equal(otel.mapProviderToGenAi('openrouter/anthropic'), 'anthropic');
  assert.equal(otel.mapProviderToGenAi('openrouter:openai'), 'openai');
  assert.equal(otel.mapProviderToGenAi('openrouter'), 'openrouter');
  // Never null/empty.
  assert.equal(otel.mapProviderToGenAi(''), 'unknown');
  assert.equal(otel.mapProviderToGenAi(null), 'unknown');
});

// =============================================================================
// 3) mapFinishReason
// =============================================================================

test('W921 #3 — mapFinishReason normalizes to OpenAI vocab; passthrough; null', () => {
  resetEnv();
  assert.equal(otel.mapFinishReason('anthropic', 'end_turn'), 'stop');
  assert.equal(otel.mapFinishReason('anthropic', 'max_tokens'), 'length');
  assert.equal(otel.mapFinishReason('anthropic', 'tool_use'), 'tool_calls');
  assert.equal(otel.mapFinishReason('anthropic', 'stop_sequence'), 'stop');
  // OpenAI vocabulary passthrough.
  assert.equal(otel.mapFinishReason('openai', 'stop'), 'stop');
  assert.equal(otel.mapFinishReason('openai', 'length'), 'length');
  assert.equal(otel.mapFinishReason('openai', 'tool_calls'), 'tool_calls');
  assert.equal(otel.mapFinishReason('openai', 'content_filter'), 'content_filter');
  // null/undefined/'' -> undefined so the caller omits the attribute.
  assert.equal(otel.mapFinishReason('openai', null), undefined);
  assert.equal(otel.mapFinishReason('openai', undefined), undefined);
  assert.equal(otel.mapFinishReason('anthropic', ''), undefined);
  // extractFinishReasons over an OpenAI-shape body.
  const oa = otel.extractFinishReasons('openai', { choices: [{ finish_reason: 'stop' }] });
  assert.deepEqual(oa, ['stop']);
  // ... and an Anthropic-shape body (stop_reason).
  const an = otel.extractFinishReasons('anthropic', { stop_reason: 'max_tokens' });
  assert.deepEqual(an, ['length']);
  // Missing -> empty array (never null).
  assert.deepEqual(otel.extractFinishReasons('openai', {}), []);
});

// =============================================================================
// 4) startGenAiSpan sets request attrs + name + SpanKind CLIENT
// =============================================================================

test('W921 #4 — startGenAiSpan: required+recommended request attrs, name, kind=CLIENT(3)', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({
      operation: 'chat', provider: 'anthropic', requestModel: 'claude-opus-4-7',
      maxTokens: 1024, temperature: 0.7, namespace: 'support', tenant_id: 'tenant_abc',
    });
    assert.ok(span, 'span must be created when KOLM_OTEL=1');
    assert.equal(span.name, 'chat claude-opus-4-7', 'span name = `{operation} {model}`');
    assert.equal(span.kind, 3, 'native span kind must be CLIENT(3)');
    // End it so it flushes.
    otel.finishGenAiSpan(span, { durationMs: 100 });
  });
  const spans = allSpans(received);
  assert.equal(spans.length, 1, `exactly one span exported; got ${spans.length}`);
  const s = spans[0];
  assert.equal(s.kind, 3, 'OTLP span kind must be CLIENT(3)');
  assert.equal(s.name, 'chat claude-opus-4-7');
  const am = attrMap(s.attributes);
  assert.equal(am['gen_ai.operation.name'], 'chat');
  assert.equal(am['gen_ai.provider.name'], 'anthropic');
  assert.equal(am['gen_ai.request.model'], 'claude-opus-4-7');
  assert.equal(am['gen_ai.request.max_tokens'], 1024);
  assert.equal(am['gen_ai.request.temperature'], 0.7);
  // Privacy: namespace raw OK, tenant only as a sha256 hash prefix.
  assert.equal(am['kolm.namespace'], 'support');
  assert.ok(/^[0-9a-f]{12}$/.test(am['kolm.tenant.id_hash']), 'tenant must be hashed, never raw');
  assert.ok(!JSON.stringify(am).includes('tenant_abc'), 'raw tenant_id must not leak');
});

// =============================================================================
// 5) finishGenAiSpan exports response attrs + error.type/status
// =============================================================================

test('W921 #5 — finishGenAiSpan: response attrs, finish_reasons[], usage; error sets error.type+status 2', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    const ok = otel.startGenAiSpan({ provider: 'anthropic', requestModel: 'claude-opus-4-7' });
    otel.finishGenAiSpan(ok, {
      responseModel: 'claude-opus-4-7', responseId: 'msg_01XYZ',
      finishReasons: ['end_turn'], inputTokens: 120, outputTokens: 55,
      durationMs: 2480, status: 'ok',
    });
    const bad = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o-mini' });
    otel.finishGenAiSpan(bad, { durationMs: 50, status: 'error', errorType: '503' });
  });
  const spans = allSpans(received);
  assert.equal(spans.length, 2, `two spans exported; got ${spans.length}`);
  const okSpan = spans.find((s) => s.name.includes('claude'));
  const okm = attrMap(okSpan.attributes);
  assert.equal(okm['gen_ai.response.model'], 'claude-opus-4-7');
  assert.equal(okm['gen_ai.response.id'], 'msg_01XYZ');
  assert.deepEqual(okm['gen_ai.response.finish_reasons'], ['stop'], 'end_turn -> stop, as array');
  assert.equal(okm['gen_ai.usage.input_tokens'], 120);
  assert.equal(okm['gen_ai.usage.output_tokens'], 55);
  assert.equal(okSpan.status.code, 1, 'ok span status code 1');
  const badSpan = spans.find((s) => s.name.includes('gpt'));
  const badm = attrMap(badSpan.attributes);
  assert.equal(badm['error.type'], '503', 'error.type set on failure');
  assert.equal(badSpan.status.code, 2, 'error span status code 2');
});

// =============================================================================
// 6) The three metrics: names, units, exact buckets, token.usage twice
// =============================================================================

test('W921 #6 — token.usage(input+output) + operation.duration(s) + time_to_first_token(s) with exact buckets', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o' });
    otel.finishGenAiSpan(span, {
      responseModel: 'gpt-4o', inputTokens: 200, outputTokens: 80,
      durationMs: 2480, ttftMs: 430, status: 'ok',
      serverAddress: 'api.openai.com', serverPort: 443,
    });
  });
  const ms = allMetrics(received);
  const tokenUsage = ms.filter((m) => m.name === 'gen_ai.client.token.usage');
  assert.equal(tokenUsage.length, 2, `token.usage emitted twice; got ${tokenUsage.length}`);
  for (const m of tokenUsage) {
    assert.ok(m.histogram, 'token.usage must be a histogram');
    assert.equal(m.unit, '{token}', 'token.usage unit must be {token}');
    const dp = m.histogram.dataPoints[0];
    assert.deepEqual(dp.explicitBounds, [...otel.GENAI_TOKEN_BUCKETS], 'token buckets must byte-match the spec');
    assert.equal(dp.bucketCounts.length, otel.GENAI_TOKEN_BUCKETS.length + 1, 'bucketCounts = bounds+1');
  }
  const types = tokenUsage.map((m) => attrMap(m.histogram.dataPoints[0].attributes)['gen_ai.token.type']).sort();
  assert.deepEqual(types, ['input', 'output'], 'one input + one output token.type');

  const dur = ms.find((m) => m.name === 'gen_ai.client.operation.duration');
  assert.ok(dur && dur.histogram, 'operation.duration histogram present');
  assert.equal(dur.unit, 's', 'operation.duration unit must be SECONDS');
  assert.equal(dur.histogram.dataPoints[0].sum, 2.48, 'value must be durationMs/1000 (units lock)');
  assert.deepEqual(dur.histogram.dataPoints[0].explicitBounds, [...otel.GENAI_DURATION_BUCKETS]);

  const ttft = ms.find((m) => m.name === 'gen_ai.server.time_to_first_token');
  assert.ok(ttft && ttft.histogram, 'time_to_first_token histogram present when ttftMs given');
  assert.equal(ttft.unit, 's');
  assert.equal(ttft.histogram.dataPoints[0].sum, 0.43, 'ttft value = ttftMs/1000');
  assert.deepEqual(ttft.histogram.dataPoints[0].explicitBounds, [...otel.GENAI_TTFT_BUCKETS]);

  // Metric attr set carries required + recommended attrs.
  const dam = attrMap(dur.histogram.dataPoints[0].attributes);
  assert.equal(dam['gen_ai.operation.name'], 'chat');
  assert.equal(dam['gen_ai.provider.name'], 'openai');
  assert.equal(dam['gen_ai.request.model'], 'gpt-4o');
  assert.equal(dam['gen_ai.response.model'], 'gpt-4o');
  assert.equal(dam['server.address'], 'api.openai.com');
  assert.equal(dam['server.port'], 443);
});

test('W921 #6b — time_to_first_token NOT emitted when ttftMs absent', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o' });
    otel.finishGenAiSpan(span, { inputTokens: 10, outputTokens: 5, durationMs: 100, status: 'ok' });
  });
  const ttft = allMetrics(received).filter((m) => m.name === 'gen_ai.server.time_to_first_token');
  assert.equal(ttft.length, 0, 'no ttft metric when ttftMs not provided');
});

// =============================================================================
// 7) Honest no-op when KOLM_OTEL=0 + no tracer
// =============================================================================

test('W921 #7 — honest no-op: KOLM_OTEL=0 + no tracer emits nothing, never throws', () => {
  resetEnv();
  // No init(), KOLM_OTEL unset, no tracer hook.
  let span;
  assert.doesNotThrow(() => { span = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o', maxTokens: 100 }); });
  assert.equal(span, null, 'startGenAiSpan returns null when telemetry inactive');
  assert.doesNotThrow(() => otel.finishGenAiSpan(span, { durationMs: 100, inputTokens: 10, outputTokens: 5, ttftMs: 50 }));
  assert.doesNotThrow(() => otel.finishGenAiSpan(null, {}));
  assert.doesNotThrow(() => otel.histogram('x', 5, { bounds: [1, 4, 16] }));
  assert.doesNotThrow(() => otel.genAiTokenUsage({ provider: 'openai', inputTokens: 5, outputTokens: 2 }));
  assert.doesNotThrow(() => otel.genAiOperationDuration({ provider: 'openai', durationMs: 10 }));
  assert.doesNotThrow(() => otel.genAiTimeToFirstToken({ provider: 'openai', ttftMs: 5 }));
  const status = otel.getGenAiStatus();
  assert.equal(status.ok, true);
  assert.equal(status.version, 'w921-genai-v1');
  assert.equal(status.active, false, 'inactive when KOLM_OTEL=0 + no tracer');
});

// =============================================================================
// 8) Privacy: content OFF by default; opt-in emits ONLY post-redaction text
// =============================================================================

test('W921 #8 — content OFF by default; KOLM_OTEL_CAPTURE_CONTENT=1 emits ONLY redacted text', async () => {
  resetEnv();
  // Default: no content attrs at all.
  const off = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o' });
    otel.finishGenAiSpan(span, {
      durationMs: 100, inputContent: 'My SSN is 123-45-6789',
      outputContent: 'noted', status: 'ok',
    });
  });
  const offAttrs = attrMap(allSpans(off)[0].attributes);
  assert.equal(offAttrs['gen_ai.input.messages'], undefined, 'no input.messages by default');
  assert.equal(offAttrs['gen_ai.output.messages'], undefined, 'no output.messages by default');

  // Opt-in: caller passes POST-redaction text (the router redacts upstream).
  resetEnv();
  process.env.KOLM_OTEL_CAPTURE_CONTENT = '1';
  const redacted = applyMode({ text: 'My SSN is 123-45-6789', mode: 'redact_all' }).output_text;
  assert.ok(redacted.includes('[PHI_SSN'), 'fixture must actually redact the SSN');
  const on = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'openai', requestModel: 'gpt-4o' });
    otel.finishGenAiSpan(span, { durationMs: 100, inputContent: redacted, status: 'ok' });
  });
  const onAttrs = attrMap(allSpans(on)[0].attributes);
  assert.ok(typeof onAttrs['gen_ai.input.messages'] === 'string', 'input.messages present under opt-in');
  assert.ok(!onAttrs['gen_ai.input.messages'].includes('123-45-6789'), 'raw SSN must NOT appear in the trace');
  // Whole-span privacy sweep — the raw SSN must not leak anywhere.
  assert.ok(!JSON.stringify(allSpans(on)[0].attributes).includes('123-45-6789'), 'no raw SSN anywhere on the span');
});

// =============================================================================
// 9) Compat flag: gen_ai.system only under KOLM_OTEL_SEMCONV_COMPAT=1
// =============================================================================

test('W921 #9 — gen_ai.system absent by default; present(===provider.name) only under SEMCONV_COMPAT=1', async () => {
  resetEnv();
  const def = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'anthropic', requestModel: 'claude-opus-4-7' });
    otel.finishGenAiSpan(span, { durationMs: 100, status: 'ok' });
  });
  assert.equal(attrMap(allSpans(def)[0].attributes)['gen_ai.system'], undefined, 'no deprecated gen_ai.system by default');

  resetEnv();
  process.env.KOLM_OTEL_SEMCONV_COMPAT = '1';
  const compat = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'anthropic', requestModel: 'claude-opus-4-7' });
    otel.finishGenAiSpan(span, { durationMs: 100, status: 'ok' });
  });
  const am = attrMap(allSpans(compat)[0].attributes);
  assert.equal(am['gen_ai.system'], 'anthropic', 'gen_ai.system dual-emitted === provider.name under compat flag');
  assert.equal(am['gen_ai.provider.name'], 'anthropic');
});

// =============================================================================
// 10) Histogram OTLP shape (generic helper)
// =============================================================================

test('W921 #10 — histogram() OTLP shape: bucketCounts.length === explicitBounds.length+1, count/sum present', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    otel.histogram('kolm.test.hist', 5, { unit: '{thing}', bounds: [1, 4, 16, 64], attrs: { a: 'b' } });
  });
  const m = allMetrics(received).find((x) => x.name === 'kolm.test.hist');
  assert.ok(m && m.histogram, 'histogram metric present');
  assert.equal(m.unit, '{thing}');
  const dp = m.histogram.dataPoints[0];
  assert.deepEqual(dp.explicitBounds, [1, 4, 16, 64]);
  assert.equal(dp.bucketCounts.length, 5, 'N bounds => N+1 buckets (incl +Inf)');
  assert.equal(dp.count, '1');
  assert.equal(dp.sum, 5);
  // value 5 falls in bucket (4,16] => index 2.
  assert.deepEqual(dp.bucketCounts, ['0', '0', '1', '0', '0']);
});

// =============================================================================
// 11) Dual-dialect — kolm.* (W733) attaches to the SAME GenAI span
// =============================================================================

test('W921 #11 — kolm.* routing attrs attach to the SAME GenAI span (dual-dialect)', async () => {
  resetEnv();
  const received = await withOtlpSink(async () => {
    const span = otel.startGenAiSpan({ provider: 'anthropic', requestModel: 'claude-opus-4-7' });
    // The W733 attacher must coexist on the GenAI span.
    const ok = otel.setRoutingAttributes(span, { decision: 'teacher', kscore: 0.92, namespace: 'support' });
    assert.equal(ok, true, 'setRoutingAttributes must succeed on a GenAI native span');
    otel.finishGenAiSpan(span, { durationMs: 100, status: 'ok' });
  });
  const am = attrMap(allSpans(received)[0].attributes);
  // Both dialects on one span.
  assert.equal(am['gen_ai.provider.name'], 'anthropic', 'gen_ai.* present');
  assert.equal(am['kolm.routing.decision'], 'teacher', 'kolm.* present on the SAME span');
  assert.equal(am['kolm.kscore.value'], 0.92);
});

// =============================================================================
// 12) No new @opentelemetry/* package.json dependency
// =============================================================================

test('W921 #12 — package.json declares no @opentelemetry/* dependency (optional via try/import)', () => {
  resetEnv();
  const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
  const all = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.peerDependencies || {}, pkg.optionalDependencies || {});
  for (const name of Object.keys(all)) {
    assert.ok(!name.startsWith('@opentelemetry/'), `package.json must NOT depend on "${name}"`);
  }
});
