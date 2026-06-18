#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'otel-matrix.json');
const SCHEMA = 'kolm.otel_matrix.v1';
const UPDATED_AT = '2026-06-18';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');
const SUMMARY = args.has('--summary');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
  return out;
}

function stableStringify(value) {
  return JSON.stringify(stable(value), null, 2) + '\n';
}

function lineNumber(text, idx) {
  return text.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function extractExports(src) {
  const rows = [];
  for (const m of src.matchAll(/^export\s+(async\s+)?(function\*?|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    rows.push({ name: m[3], kind: m[2], async: !!m[1], line: lineNumber(src, m.index) });
  }
  for (const m of src.matchAll(/export\s*{\s*([\s\S]*?)\s*};/gm)) {
    const body = stripComments(m[1]);
    for (const part of body.split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop();
      if (name) rows.push({ name, kind: 'export-list', async: false, line: lineNumber(src, m.index) });
    }
  }
  return rows.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractFunctions(src) {
  return [...src.matchAll(/^(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\(/gm)]
    .map((m) => ({ name: m[2], async: !!m[1], line: lineNumber(src, m.index) }))
    .sort((a, b) => a.line - b.line);
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function requiredExports() {
  return [
    'init',
    'startSpan',
    'endSpan',
    'metric',
    'counter',
    'flush',
    'shutdown',
    'isEnabled',
    'expressMiddleware',
    'OTEL_LIMITS',
    'OTEL_W733_VERSION',
    'KOLM_OTEL_ATTRS',
    'KOLM_OTEL_SPAN_NAMES',
    'createInferenceSpans',
    'setRoutingAttributes',
    'getW733Status',
    'listW733Attrs',
    'listW733SpanNames',
    '_probeOtelApi',
    'OTEL_GENAI_VERSION',
    'GEN_AI_ATTRS',
    'GEN_AI_METRICS',
    'GENAI_TOKEN_BUCKETS',
    'GENAI_DURATION_BUCKETS',
    'GENAI_TTFT_BUCKETS',
    'mapProviderToGenAi',
    'mapFinishReason',
    'extractFinishReasons',
    'startGenAiSpan',
    'finishGenAiSpan',
    'histogram',
    'genAiTokenUsage',
    'genAiOperationDuration',
    'genAiTimeToFirstToken',
    'listGenAiAttrs',
    'listGenAiMetrics',
    'getGenAiStatus',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/wave553-codegraph-cloud-platform.test.js',
    'tests/wave823-otel-upgrade.test.js',
    'tests/wave921-otel-genai.test.js',
    'tests/wave921-otel-wiring.test.js',
    'tests/wave951-otel-matrix.test.js',
  ];
}

function rowFromDef(src, [id, owner, evidence]) {
  return {
    id,
    owner,
    present: evidence.every((needle) => src.includes(needle)),
    line: lineNumber(src, Math.max(0, src.indexOf(owner))),
    evidence,
  };
}

function phaseRows(src) {
  const defs = [
    ['disabled_noop_init', 'init', ['KOLM_OTEL', 'if (!enabled) return false']],
    ['endpoint_headers_resource_init', 'init', ['OTEL_EXPORTER_OTLP_ENDPOINT', 'parseHeaders', 'buildResource']],
    ['resource_attribute_sanitization', 'buildResource', ['OTEL_RESOURCE_ATTRIBUTES', 'max_resource_attrs', 'kv(k, v)']],
    ['span_start', 'startSpan', ['traceId', 'spanId', 'cleanSpanName(name)', 'attrsToKv(attrs)']],
    ['span_end', 'endSpan', ['cleanAttrValue(opts.message', 'max_events_per_span', 'STATE.spanQueue.push(span)']],
    ['metric_gauge', 'metric', ['gauge:', 'cleanMetricName(name)', 'attrsToKv(attrs || {})']],
    ['counter_sum', 'counter', ['sum:', 'isMonotonic: true', 'aggregationTemporality: 2']],
    ['queue_trim', 'trimQueue', ['STATE.maxQueueBytes', 'STATE.spanQueue.shift()', 'STATE.metricQueue.shift()']],
    ['otlp_flush', 'flush', ['postJson(\'/v1/traces\'', 'postJson(\'/v1/metrics\'', 'Promise.all(tasks)']],
    ['otlp_requeue_on_failure', 'flush', ['STATE.spanQueue.unshift', 'STATE.metricQueue.unshift', 'slice(-50)']],
    ['express_middleware', 'expressMiddleware', ['http.target', 'redactHttpTarget', 'res.on(\'finish\'']],
    ['routing_attrs', 'setRoutingAttributes', ['TENANT_ID_HASH', '_hashTenant(block.tenant_id)', 'Array.isArray(span.attributes)']],
    ['inference_subspans', 'createInferenceSpans', ['QUEUE', 'PREFILL', 'DECODE', 'STATE.spanQueue.push(child)']],
    ['genai_provider_mapping', 'mapProviderToGenAi', ['openrouter', '_PROVIDER_ENUM', 'return raw.replace']],
    ['genai_finish_mapping', 'mapFinishReason', ['ANTHROPIC_MAP', 'tool_calls', 'content_filter']],
    ['genai_span_start', 'startGenAiSpan', ['GEN_AI_ATTRS.OPERATION_NAME', 'span.kind = 3', 'KOLM_OTEL_SEMCONV_COMPAT']],
    ['genai_span_finish', 'finishGenAiSpan', ['GEN_AI_ATTRS.FINISH_REASONS', 'KOLM_OTEL_CAPTURE_CONTENT', 'genAiTokenUsage']],
    ['genai_histograms', 'histogram', ['explicitBounds', 'bucketCounts', 'GENAI_TOKEN_BUCKETS']],
    ['genai_metric_emitters', 'genAiTokenUsage', ['gen_ai.client.token.usage', 'genAiOperationDuration', 'genAiTimeToFirstToken']],
    ['status_surfaces', 'getGenAiStatus', ['getW733Status', 'listW733Attrs', 'listGenAiMetrics']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function privacyRows(src) {
  const defs = [
    ['attribute_key_cap', 'OTEL_LIMITS.max_attr_key_chars', ['max_attr_key_chars', 'cleanAttrKey']],
    ['attribute_value_cap', 'OTEL_LIMITS.max_attr_value_chars', ['max_attr_value_chars', 'cleanAttrValue']],
    ['attribute_count_cap', 'OTEL_LIMITS.max_attrs_per_record', ['max_attrs_per_record', 'Object.keys(attrs).slice']],
    ['event_count_cap', 'OTEL_LIMITS.max_events_per_span', ['max_events_per_span', 'opts.events.slice']],
    ['resource_attr_cap', 'OTEL_LIMITS.max_resource_attrs', ['max_resource_attrs', 'OTEL_RESOURCE_ATTRIBUTES']],
    ['header_count_cap', 'OTEL_LIMITS.max_header_count', ['max_header_count', 'parseHeaders']],
    ['header_crlf_strip', 'cleanHeaderPart', ['replace(/[\\r\\n]/g', 'cleanHeaderPart']],
    ['http_target_redaction', 'redactHttpTarget', ['redactHttpTarget(req.originalUrl || req.url)', 'OTEL_SECRET_PAIR_RE']],
    ['secret_value_redaction', 'OTEL_SECRET_VALUE_RE', ['OTEL_SECRET_VALUE_RE', 'redactOtelText']],
    ['secret_pair_redaction', 'OTEL_SECRET_PAIR_RE', ['OTEL_SECRET_PAIR_RE', '[redacted-secret]']],
    ['tenant_hash_only', '_hashTenant', ['TENANT_ID_HASH', '_hashTenant', 'raw id never crosses']],
    ['content_capture_opt_in', 'KOLM_OTEL_CAPTURE_CONTENT', ['KOLM_OTEL_CAPTURE_CONTENT', 'INPUT_MESSAGES', 'OUTPUT_MESSAGES']],
    ['export_error_body_cap', 'postJson', ['cleanAttrValue(Buffer.concat(chunks).toString', ', 200)']],
    ['export_timeout', 'export_timeout_ms', ['export_timeout_ms', 'req.setTimeout']],
    ['queue_byte_cap', 'STATE.maxQueueBytes', ['maxQueueBytes', 'trimQueue']],
    ['optional_otel_api_no_dep', '_probeOtelApi', ['@opentelemetry/api', 'catch (_e)', 'package.json']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const symbols = requiredExports();
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/otel.js') || body.includes('../src/otel.js') || body.includes('otel.js') || body.includes('OpenTelemetry');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${escapeRegExp(sym)}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const telemetryRefs = (body.match(/\botel\b|OpenTelemetry|gen_ai|OTLP|trace|span|metric|KOLM_OTEL/gi) || []).length;
    if (!sourceLock && !totalSymbolRefs && !telemetryRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      telemetry_refs: telemetryRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, mod, exports, envRefs, phases, privacy, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const envSet = new Set(envRefs);
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && mod[name] !== undefined),
    env_surface_is_explicit: ['KOLM_OTEL', 'KOLM_OTEL_CAPTURE_CONTENT', 'KOLM_OTEL_SEMCONV_COMPAT', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS', 'OTEL_RESOURCE_ATTRIBUTES', 'OTEL_SERVICE_NAME'].every((name) => envSet.has(name)),
    w733_attr_and_span_tables_are_frozen: Object.isFrozen(mod.KOLM_OTEL_ATTRS) && Object.isFrozen(mod.KOLM_OTEL_SPAN_NAMES) && Object.keys(mod.KOLM_OTEL_ATTRS).length >= 12 && Object.keys(mod.KOLM_OTEL_SPAN_NAMES).length === 4,
    genai_attr_metric_and_bucket_tables_are_frozen: Object.isFrozen(mod.GEN_AI_ATTRS) && Object.isFrozen(mod.GEN_AI_METRICS) && Object.isFrozen(mod.GENAI_TOKEN_BUCKETS) && Object.isFrozen(mod.GENAI_DURATION_BUCKETS) && Object.isFrozen(mod.GENAI_TTFT_BUCKETS),
    genai_semconv_metric_surface_complete: Object.values(mod.GEN_AI_METRICS).includes('gen_ai.client.token.usage') && Object.values(mod.GEN_AI_METRICS).includes('gen_ai.client.operation.duration') && Object.values(mod.GEN_AI_METRICS).includes('gen_ai.server.time_to_first_token'),
    genai_bucket_shapes_match_semconv: mod.GENAI_TOKEN_BUCKETS.length === 14 && mod.GENAI_DURATION_BUCKETS.length === 14 && mod.GENAI_TTFT_BUCKETS.length === 16,
    tenant_ids_are_hash_only: src.includes('_hashTenant') && src.includes('TENANT_ID_HASH') && src.includes('raw id never crosses') && !src.includes('tenant_id: tenant_id'),
    content_capture_is_explicit_opt_in: src.includes('KOLM_OTEL_CAPTURE_CONTENT') && src.includes('INPUT_MESSAGES') && src.includes('OUTPUT_MESSAGES'),
    request_targets_and_errors_are_redacted: src.includes('redactHttpTarget') && src.includes('redactOtelText') && src.includes('OTEL_SECRET_PAIR_RE') && src.includes('OTEL_SECRET_VALUE_RE'),
    attributes_events_headers_and_resources_are_bounded: privacy.every((row) => row.present) && src.includes('max_attrs_per_record') && src.includes('max_events_per_span') && src.includes('max_header_count') && src.includes('max_resource_attrs'),
    exporter_is_timeout_bounded_and_requeues_recent_items: src.includes('export_timeout_ms') && src.includes('req.setTimeout') && src.includes('slice(-50)') && src.includes('trimQueue()'),
    optional_otel_api_is_lazy_and_package_free: src.includes("await import('@opentelemetry/api')") && !read('package.json').includes('"@opentelemetry/'),
    all_expected_phases_present: phases.every((row) => row.present),
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('src/otel.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'otel.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const functions = extractFunctions(src);
  const envRefs = extractEnvRefs(src);
  const phases = phaseRows(src);
  const privacy = privacyRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, exports, envRefs, phases, privacy, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const summary = {
    otel_bytes: Buffer.byteLength(src),
    otel_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    env_ref_count: envRefs.length,
    w733_attr_count: Object.keys(mod.KOLM_OTEL_ATTRS).length,
    w733_span_name_count: Object.keys(mod.KOLM_OTEL_SPAN_NAMES).length,
    genai_attr_count: Object.keys(mod.GEN_AI_ATTRS).length,
    genai_metric_count: Object.keys(mod.GEN_AI_METRICS).length,
    token_bucket_count: mod.GENAI_TOKEN_BUCKETS.length,
    duration_bucket_count: mod.GENAI_DURATION_BUCKETS.length,
    ttft_bucket_count: mod.GENAI_TTFT_BUCKETS.length,
    phase_count: phases.length,
    present_phase_count: phases.filter((row) => row.present).length,
    privacy_control_count: privacy.length,
    present_privacy_control_count: privacy.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.w733_attr_count < 12 || summary.w733_span_name_count !== 4) failures.push({ gate: 'w733_semconv_surface', attrs: summary.w733_attr_count, spans: summary.w733_span_name_count });
  if (summary.genai_attr_count < 21 || summary.genai_metric_count !== 3) failures.push({ gate: 'genai_semconv_surface', attrs: summary.genai_attr_count, metrics: summary.genai_metric_count });
  if (summary.token_bucket_count !== 14 || summary.duration_bucket_count !== 14 || summary.ttft_bucket_count !== 16) failures.push({ gate: 'genai_buckets', token: summary.token_bucket_count, duration: summary.duration_bucket_count, ttft: summary.ttft_bucket_count });
  if (summary.present_phase_count !== summary.phase_count) failures.push({ gate: 'otel_phases', missing: phases.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_privacy_control_count !== summary.privacy_control_count) failures.push({ gate: 'otel_privacy_controls', missing: privacy.filter((row) => !row.present).map((row) => row.id) });
  if (failedGuards.length) failures.push({ gate: 'otel_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/otel.js: native OTLP/HTTP exporter, W733 kolm attributes and inference spans, W921 GenAI semantic conventions, bounded/redacted telemetry payloads, optional OpenTelemetry API bridge, and direct test evidence.',
    sources: [
      'src/otel.js',
      'src/otel-attrs.js',
      'src/router.js',
      'src/platform-capabilities.js',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    env_refs: envRefs,
    limits: mod.OTEL_LIMITS,
    w733_attrs: mod.KOLM_OTEL_ATTRS,
    w733_span_names: mod.KOLM_OTEL_SPAN_NAMES,
    genai_attrs: mod.GEN_AI_ATTRS,
    genai_metrics: mod.GEN_AI_METRICS,
    genai_buckets: {
      token: mod.GENAI_TOKEN_BUCKETS,
      duration: mod.GENAI_DURATION_BUCKETS,
      time_to_first_token: mod.GENAI_TTFT_BUCKETS,
    },
    otel_phases: phases,
    privacy_controls: privacy,
    public_return_shapes: {
      startSpan: ['traceId', 'spanId', 'parentSpanId', 'name', 'startTimeUnixNano', 'endTimeUnixNano', 'attributes', 'status', 'events'],
      getW733Status: ['ok', 'version', 'otel_api_detected', 'tracer_registered', 'native_enabled'],
      getGenAiStatus: ['ok', 'version', 'active', 'native_enabled', 'tracer_registered', 'attrs', 'metrics'],
    },
    safety_guards: guards,
    failed_safety_guards: failedGuards,
    required_test_evidence: requiredTests,
    test_evidence: tests,
    gates: {
      ok: failures.length === 0,
      failures,
      warnings: [],
    },
  };
}

async function main() {
  const matrix = await buildMatrix();
  const body = stableStringify(matrix);

  if (CHECK) {
    const existing = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (existing !== body) {
      console.error('otel-matrix: docs/internal/otel-matrix.json is out of date');
      process.exit(1);
    }
  } else {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, body, 'utf8');
  }

  if (SUMMARY) {
    console.log(JSON.stringify({
      ok: matrix.gates.ok,
      schema: matrix.schema,
      summary: matrix.summary,
      failures: matrix.gates.failures,
      warnings: matrix.gates.warnings,
    }, null, 2));
  } else {
    const action = CHECK ? 'ok' : 'wrote';
    console.log(`otel-matrix: ${action} docs/internal/otel-matrix.json phases=${matrix.summary.present_phase_count}/${matrix.summary.phase_count} privacy=${matrix.summary.present_privacy_control_count}/${matrix.summary.privacy_control_count} guards=${matrix.summary.failed_safety_guards}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
