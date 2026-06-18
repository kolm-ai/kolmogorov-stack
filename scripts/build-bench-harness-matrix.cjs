#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'internal', 'bench-harness-matrix.json');
const SCHEMA = 'kolm.bench_harness_matrix.v1';
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

function extractExports(src) {
  const rows = [];
  for (const m of src.matchAll(/^export\s+(async\s+)?(function\*?|function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    rows.push({ name: m[3], kind: m[2], async: !!m[1], line: lineNumber(src, m.index) });
  }
  for (const m of src.matchAll(/^export\s*{\s*([^}]+)\s*};/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/i).pop();
      if (name) rows.push({ name, kind: 're-export', async: false, line: lineNumber(src, m.index) });
    }
  }
  return rows.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name));
}

function extractFunctions(src) {
  return [...src.matchAll(/^(export\s+)?(async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\(/gm)]
    .map((m) => ({
      name: m[3],
      exported: !!m[1],
      async: !!m[2],
      line: lineNumber(src, m.index),
    }))
    .sort((a, b) => a.line - b.line);
}

function extractEnvRefs(src) {
  return [...new Set([...src.matchAll(/\bprocess\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
}

function requiredExports() {
  return [
    'listSuites',
    'validateSuite',
    'METRIC_REGISTRY',
    'runBench',
    'buildMarkdownReport',
    'resolveModelTarget',
    'runViaGateway',
    'estimateCostAsync',
    'cliCompareEntry',
  ];
}

function requiredTestEvidence() {
  return [
    'tests/wrapper-s4.test.js',
    'tests/wave589-benchmark-evidence-contract.test.js',
    'tests/wave950-bench-harness-matrix.test.js',
  ];
}

function rowFromDef(src, [id, owner, evidence]) {
  return {
    id,
    owner,
    present: evidence.every((needle) => src.includes(needle)),
    line: lineNumber(src, src.indexOf(owner)),
    evidence,
  };
}

function phaseRows(src) {
  const defs = [
    ['suite_resolution', 'getSuite', ['const suite = getSuite(suiteId)', 'unknown suite', 'validateSuite']],
    ['prompt_override_validation', 'prompt_override', ['prompt_override, when present, must be a non-empty array', 'expected_traits']],
    ['prompt_count_cap', 'suite.prompts.slice', ['Number.isFinite(n)', 'suite.prompts.slice(0, n)']],
    ['target_resolution', 'resolveModelTarget', ['models.map((m) => resolveModelTarget', 'transport_factory']],
    ['sequential_suite_run', 'runSuiteAgainstTarget', ['for (const p of suite.prompts)', 'target.send(p.text)']],
    ['markdown_report', 'buildMarkdownReport', ['buildMarkdownReport({ rows, suite', '## Caveats']],
    ['json_artifact_write', 'jsonPayload', ['spec: \'kolm-bench-compare-1\'', 'fs.writeFileSync(comparison_json_path']],
    ['hash_only_sample_serialization', 'serializeBenchSample', ['sample_privacy', 'prompt_sha256', 'response_sha256']],
    ['raw_sample_opt_in', 'include_raw_samples', ['include_raw_samples = false', 'if (includeRaw)']],
    ['bounded_provider_fetch', 'fetchWithTimeout', ['fetchWithTimeout', 'AbortController', 'bench_request_timeout']],
    ['bounded_local_gguf_spawn', 'makeLocalGgufTarget', ['spawnSync(bin, args', 'timeout: 120_000', 'maxBuffer: 16 * 1024 * 1024']],
    ['gateway_dispatch', 'runViaGateway', ['/v1/gateway/dispatch', 'missing_kolm_api_key', 'receipt_id']],
    ['metric_summary', 'summarizeRow', ['computeMetric', 'cost_per_1k_usd', 'estimateCostPer1k']],
    ['error_redaction', 'redactBenchError', ['BENCH_SECRET_VALUE_RE', 'redactBenchError', 'slice(0, 512)']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function transportRows(src) {
  const defs = [
    ['fake', 'makeFakeTarget', ["raw.startsWith('fake:')", 'makeFakeTarget', "provider: 'fake'"]],
    ['gateway', 'makeGatewayTarget', ["raw.startsWith('gateway:')", 'makeGatewayTarget', 'runViaGateway']],
    ['local_gguf', 'makeLocalGgufTarget', ["raw.startsWith('gguf:')", 'locateLlamaCli', 'spawnSync']],
    ['local_ollama', 'makeOllamaTarget', ["raw.startsWith('ollama:')", 'KOLM_BENCH_LOCAL_LLM_URL', '/api/chat']],
    ['local_vllm', 'makeVllmTarget', ["raw.startsWith('vllm:')", 'KOLM_BENCH_VLLM_URL', '/v1/chat/completions']],
    ['local_kolm', 'makeLocalKolmTarget', ["raw.startsWith('local-kolm:')", 'KOLM_LOCAL_BASE', '/v1/chat/completions']],
    ['trinity_alias', 'trinity-500', ["raw === 'trinity-500'", 'model: \'trinity-500\'']],
    ['anthropic_direct', 'makeAnthropicTarget', ['ANTHROPIC_API_KEY', 'KOLM_UPSTREAM_ANTHROPIC_BASE', '/v1/messages']],
    ['openai_direct', 'makeOpenAITarget', ['OPENAI_API_KEY', 'KOLM_UPSTREAM_OPENAI_BASE', '/v1/chat/completions']],
    ['deepseek_direct', 'makeDeepSeekTarget', ['DEEPSEEK_API_KEY', 'KOLM_UPSTREAM_DEEPSEEK_BASE']],
    ['gemini_direct', 'makeGoogleTarget', ['GEMINI_API_KEY', 'KOLM_UPSTREAM_GEMINI_BASE', ':generateContent']],
    ['unknown_fallback', 'makeUnknownTarget', ['makeUnknownTarget', 'unresolvable_model']],
  ];
  return defs.map((def) => rowFromDef(src, def));
}

function reportFieldRows(src) {
  const fields = ['spec', 'suite', 'ran_at', 'dry_run', 'sample_privacy', 'models', 'per_model_samples'];
  return fields.map((field) => ({
    field,
    present: src.includes(`${field},`) || src.includes(`${field}:`),
  }));
}

function sampleFieldRows(src) {
  const fields = ['prompt_id', 'prompt_sha256', 'response_sha256', 'prompt_chars', 'response_chars', 'ms', 'in_tok', 'out_tok', 'error', 'receipt_id'];
  return fields.map((field) => ({
    field,
    present: src.includes(`${field}:`) || src.includes(field),
  }));
}

function directTestEvidence() {
  const dir = path.join(ROOT, 'tests');
  const symbols = requiredExports();
  const rows = [];
  for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.js')).sort()) {
    const rel = `tests/${name}`;
    const body = read(rel);
    const sourceLock = body.includes('src/bench-harness.js') || body.includes('../src/bench-harness.js') || body.includes('bench-harness');
    const counts = {};
    for (const sym of symbols) counts[`${sym}_refs`] = (body.match(new RegExp(`\\b${sym}\\b`, 'g')) || []).length;
    const totalSymbolRefs = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const benchWorkflowRefs = (body.match(/\brunBench\b|\bbenchmark\b|\bbench\b|\bsuite\b|\bper_model_samples\b|\bsample_privacy\b|\bprovider-matrix\b|\braw_output_hash\b/gi) || []).length;
    if (!sourceLock && !totalSymbolRefs && !benchWorkflowRefs) continue;
    rows.push({
      path: rel,
      source_lock: sourceLock,
      total_symbol_refs: totalSymbolRefs,
      bench_workflow_refs: benchWorkflowRefs,
      ...counts,
    });
  }
  return rows;
}

function safetyGuards(src, mod, suiteMod, exports, envRefs, suites, metrics, phases, transports, reportFields, sampleFields, tests, requiredTests) {
  const exportSet = new Set(exports.map((row) => row.name));
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const metricKinds = new Set(metrics.map((row) => row.kind));
  const envSet = new Set(envRefs);
  const jsonPayloadMatch = src.match(/const jsonPayload = \{[\s\S]*?\n    \};/);
  const jsonPayloadSrc = jsonPayloadMatch ? jsonPayloadMatch[0] : '';
  return {
    required_public_exports_present: requiredExports().every((name) => exportSet.has(name) && mod[name] != null),
    built_in_suites_are_complete_and_valid: suites.length === 4 && suites.every((row) => row.validation_ok) && suites.reduce((sum, row) => sum + row.n_prompts, 0) === 237,
    metric_registry_covers_latency_cost_behavior_correctness_safety_shape: ['latency', 'cost', 'behavior', 'correctness', 'safety', 'shape'].every((kind) => metricKinds.has(kind)),
    provider_env_surface_is_named: ['KOLM_API_KEY', 'KOLM_BASE_URL', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'LLAMA_CPP_BIN'].every((name) => envSet.has(name)),
    report_json_is_hash_only_by_default: src.includes('include_raw_samples = false') && src.includes("sample_privacy = include_raw_samples ? 'raw-opt-in' : 'hash-only'") && src.includes('serializeBenchSample(sample'),
    raw_prompt_and_response_are_explicit_opt_in_only: src.includes('if (includeRaw)') && src.includes('out.prompt_text = promptText') && src.includes('out.response_text = responseText'),
    serialized_samples_keep_hashes_and_measurement_columns: sampleFields.every((row) => row.present),
    report_payload_omits_tokens_and_bases: !!jsonPayloadSrc && !/\bbearer\b|\bbase\b|KOLM_API_KEY|Authorization/.test(jsonPayloadSrc) && reportFields.every((row) => row.present),
    provider_fetches_are_bounded: (src.match(/fetchWithTimeout\(/g) || []).length >= 8 && src.includes('AbortController') && src.includes('10 * 60 * 1000'),
    provider_errors_are_redacted_and_capped: src.includes('BENCH_SECRET_VALUE_RE') && src.includes('BENCH_SECRET_PAIR_RE') && src.includes('redactBenchError(err)') && src.includes('slice(0, 512)'),
    local_gguf_paths_are_public_ids_only: src.includes('publicGgufId(ggufPath)') && src.includes('makeLocalGgufTarget({ id: publicGgufId(ggufPath), ggufPath })') && src.includes('gguf_not_found:${publicGgufId(ggufPath)}'),
    local_subprocess_is_bounded_and_hidden: src.includes('spawnSync(bin, args') && src.includes('timeout: 120_000') && src.includes('windowsHide: true') && src.includes('maxBuffer: 16 * 1024 * 1024'),
    gateway_requires_bearer_and_carries_receipt_id: src.includes('if (!token) return errorEnvelope(\'missing_kolm_api_key\')') && src.includes('Authorization: `Bearer ${token}`') && src.includes('receipt_id: json?.kolm_receipt?.receipt_id'),
    suite_registry_is_defensive_copy: typeof suiteMod.getSuite === 'function' && src.includes('suite.prompts = suite.prompts.slice(0, n)'),
    all_expected_phases_present: phases.every((row) => row.present),
    all_expected_transports_present: transports.every((row) => row.present),
    direct_evidence_covers_required_tests: missingTests.length === 0,
  };
}

async function buildMatrix() {
  const src = read('src/bench-harness.js');
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'bench-harness.js')).href + `?matrix=${Date.now()}`);
  const suiteMod = await import(pathToFileURL(path.join(ROOT, 'src', 'bench-eval-suites.js')).href + `?matrix=${Date.now()}`);
  const exports = extractExports(src);
  const functions = extractFunctions(src);
  const exportNames = new Set(exports.map((row) => row.name));
  const missingRequiredExports = requiredExports().filter((name) => !exportNames.has(name));
  const envRefs = extractEnvRefs(src);
  const suites = mod.listSuites().map((suite) => {
    const full = suiteMod.getSuite(suite.id);
    const validation = suiteMod.validateSuite(full);
    return {
      id: suite.id,
      description: suite.description,
      n_prompts: suite.n_prompts,
      metric_count: suite.metrics.length,
      metrics: suite.metrics,
      required_models: suite.required_models,
      validation_ok: validation.ok,
      validation_errors: validation.errors,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const metrics = Object.entries(suiteMod.METRIC_REGISTRY).map(([id, meta]) => ({ id, ...meta })).sort((a, b) => a.id.localeCompare(b.id));
  const phases = phaseRows(src);
  const transports = transportRows(src);
  const reportFields = reportFieldRows(src);
  const sampleFields = sampleFieldRows(src);
  const tests = directTestEvidence();
  const requiredTests = requiredTestEvidence();
  const evidenceSet = new Set(tests.map((row) => row.path));
  const missingTests = requiredTests.filter((rel) => !evidenceSet.has(rel));
  const guards = safetyGuards(src, mod, suiteMod, exports, envRefs, suites, metrics, phases, transports, reportFields, sampleFields, tests, requiredTests);
  const failedGuards = Object.entries(guards).filter(([, ok]) => !ok).map(([name]) => name);

  const summary = {
    bench_harness_bytes: Buffer.byteLength(src),
    bench_harness_lines: src.split(/\r?\n/).length,
    export_count: exports.length,
    function_count: functions.length,
    env_ref_count: envRefs.length,
    suite_count: suites.length,
    total_prompt_count: suites.reduce((sum, row) => sum + row.n_prompts, 0),
    metric_count: metrics.length,
    phase_count: phases.length,
    present_phase_count: phases.filter((row) => row.present).length,
    transport_count: transports.length,
    present_transport_count: transports.filter((row) => row.present).length,
    report_field_count: reportFields.length,
    present_report_field_count: reportFields.filter((row) => row.present).length,
    sample_field_count: sampleFields.length,
    present_sample_field_count: sampleFields.filter((row) => row.present).length,
    required_test_evidence_count: requiredTests.length,
    direct_test_evidence_count: tests.length,
    missing_required_exports: missingRequiredExports.length,
    failed_safety_guards: failedGuards.length,
    missing_test_evidence: missingTests.length,
  };

  const failures = [];
  if (missingRequiredExports.length) failures.push({ gate: 'required_exports', missing: missingRequiredExports });
  if (summary.suite_count !== 4 || summary.total_prompt_count !== 237) failures.push({ gate: 'benchmark_suites', suites: summary.suite_count, prompts: summary.total_prompt_count });
  if (summary.metric_count < 12) failures.push({ gate: 'metric_registry', count: summary.metric_count });
  if (summary.present_phase_count !== summary.phase_count) failures.push({ gate: 'benchmark_phases', missing: phases.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_transport_count !== summary.transport_count) failures.push({ gate: 'transport_targets', missing: transports.filter((row) => !row.present).map((row) => row.id) });
  if (summary.present_report_field_count !== summary.report_field_count) failures.push({ gate: 'report_fields', missing: reportFields.filter((row) => !row.present).map((row) => row.field) });
  if (summary.present_sample_field_count !== summary.sample_field_count) failures.push({ gate: 'sample_fields', missing: sampleFields.filter((row) => !row.present).map((row) => row.field) });
  if (failedGuards.length) failures.push({ gate: 'bench_harness_safety_guards', guards: failedGuards });
  if (missingTests.length) failures.push({ gate: 'test_evidence', missing: missingTests });

  return {
    schema: SCHEMA,
    updated_at: UPDATED_AT,
    purpose: 'Generated contract matrix for src/bench-harness.js: benchmark suites, metric registry, provider/local transports, gateway dispatch, hash-only report samples, bounded network/subprocess execution, cost estimation, markdown/JSON outputs, and benchmark-evidence gating.',
    sources: [
      'src/bench-harness.js',
      'src/bench-eval-suites.js',
      'src/benchmark-evidence.js',
      'scripts/benchmark-evidence.mjs',
      ...requiredTests,
    ],
    summary,
    exports,
    required_exports: requiredExports(),
    missing_required_exports: missingRequiredExports,
    functions,
    env_refs: envRefs,
    benchmark_suites: suites,
    metric_registry: metrics,
    benchmark_phases: phases,
    transport_targets: transports,
    report_fields: reportFields,
    sample_fields: sampleFields,
    public_return_shapes: {
      runBench: ['suite', 'models', 'comparison_md', 'comparison_json_path', 'comparison_md_path', 'ran_at', 'dry_run', 'sample_privacy'],
      runViaGateway: ['ms', 'text', 'in_tok', 'out_tok', 'receipt_id', 'raw', 'error'],
      comparisonJson: ['spec', 'suite', 'ran_at', 'dry_run', 'sample_privacy', 'models', 'per_model_samples'],
      serializedSample: ['prompt_id', 'prompt_sha256', 'response_sha256', 'prompt_chars', 'response_chars', 'ms', 'in_tok', 'out_tok', 'error', 'receipt_id'],
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
      console.error('bench-harness-matrix: docs/internal/bench-harness-matrix.json is out of date');
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
    console.log(`bench-harness-matrix: ${action} docs/internal/bench-harness-matrix.json suites=${matrix.summary.suite_count} transports=${matrix.summary.present_transport_count}/${matrix.summary.transport_count} guards=${matrix.summary.failed_safety_guards}`);
  }

  if (!matrix.gates.ok) process.exit(1);
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
