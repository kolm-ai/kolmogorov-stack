import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const BENCHMARK_EVIDENCE_SPEC = 'kolm-benchmark-evidence-readiness-1';
export const BENCHMARK_PROVIDER_MATRIX_SPEC = 'kolm-provider-benchmark-matrix-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const RAW_FIELD_RE = /^(prompt|input|output|raw_prompt|raw_input|raw_output|completion|response)$/i;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const REPORT_PATH_RE = /^reports\/benchmarks\/[a-z0-9][a-z0-9._/-]*\.(?:json|jsonl)$/i;

export const BENCHMARK_RESEARCH_BASELINE = [
  {
    id: 'helm',
    title: 'HELM multi-metric evaluation',
    url: 'https://arxiv.org/abs/2211.09110',
    signal: 'Benchmark evidence needs shared scenarios, multiple metrics, raw prompts, raw outputs, and transparent missing coverage.',
  },
  {
    id: 'mt-bench-arena',
    title: 'MT-Bench and Chatbot Arena judge agreement',
    url: 'https://arxiv.org/abs/2306.05685',
    signal: 'LLM judges need bias controls, human preference agreement checks, and public prompt/output artifacts.',
  },
  {
    id: 'g-eval',
    title: 'G-Eval rubric scoring',
    url: 'https://arxiv.org/abs/2303.16634',
    signal: 'Generation scoring needs explicit rubrics, form-filled judgments, and correlation checks against reference labels.',
  },
  {
    id: 'otel-gen-ai',
    title: 'OpenTelemetry GenAI semantic conventions',
    url: 'https://opentelemetry.io/docs/specs/semconv/gen-ai/',
    signal: 'Production benchmark rows should preserve model, provider, span, metric, and event fields in an interoperable schema.',
  },
];

export const REQUIRED_BENCHMARK_LANES = [
  {
    id: 'kolm-artifact',
    label: '.kolm artifact local runner',
    required_fields: ['artifact_hash', 'k_score', 'latency_p50_ms', 'latency_p95_ms', 'cost_usd_per_1k', 'size_bytes', 'receipt_hash', 'hardware_profile'],
  },
  {
    id: 'openai',
    label: 'OpenAI-compatible API baseline',
    required_fields: ['provider_model', 'pricing_snapshot', 'latency_p50_ms', 'latency_p95_ms', 'quality_score', 'raw_output_hash'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic-native API baseline',
    required_fields: ['provider_model', 'pricing_snapshot', 'latency_p50_ms', 'latency_p95_ms', 'quality_score', 'raw_output_hash'],
  },
  {
    id: 'gemini',
    label: 'Gemini API baseline',
    required_fields: ['provider_model', 'pricing_snapshot', 'latency_p50_ms', 'latency_p95_ms', 'quality_score', 'raw_output_hash'],
  },
  {
    id: 'hosted-open-model',
    label: 'Hosted open-model baseline',
    required_fields: ['provider_model', 'accelerator', 'pricing_snapshot', 'latency_p50_ms', 'quality_score', 'raw_output_hash'],
  },
  {
    id: 'local-gguf',
    label: 'Local GGUF baseline',
    required_fields: ['model_file_hash', 'runtime_version', 'hardware_profile', 'latency_p50_ms', 'quality_score', 'joules_per_call'],
  },
  {
    id: 'browser-worker',
    label: 'Browser worker baseline',
    required_fields: ['bundle_hash', 'browser_engine', 'device_profile', 'latency_p50_ms', 'quality_score'],
  },
];

const REQUIRED_PUBLIC_ARTIFACTS = [
  {
    id: 'trinity-500-benchmark',
    path: 'public/benchmarks/trinity-500-benchmark.json',
    requirement_ids: ['benchmarking-infra'],
  },
  {
    id: 'benchmark-evidence-doc',
    path: 'docs/benchmark-evidence.md',
    requirement_ids: ['benchmarking-infra'],
  },
  {
    id: 'benchmark-evidence-test',
    path: 'tests/wave589-benchmark-evidence-contract.test.js',
    requirement_ids: ['benchmarking-infra'],
  },
  {
    id: 'bench-compare-harness',
    path: 'scripts/bench-compare.mjs',
    requirement_ids: ['benchmarking-infra'],
  },
  {
    id: 'artifact-compare-module',
    path: 'src/benchmark-compare.js',
    requirement_ids: ['benchmarking-infra'],
  },
];

const OPTIONAL_PUBLIC_REPORTS = [
  'reports/benchmarks/provider-matrix.json',
  'reports/benchmarks/latency-cost-quality.json',
  'reports/benchmarks/raw-outputs.jsonl',
  'reports/benchmarks/hardware-profiles.json',
];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeRel(rel) {
  return String(rel).replace(/\\/g, '/');
}

function readText(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return { exists: false, full };
  const text = fs.readFileSync(full, 'utf8');
  return { exists: true, full, text, sha256: sha256(text), bytes: Buffer.byteLength(text) };
}

function readJson(root, rel, failures) {
  const file = readText(root, rel);
  if (!file.exists) return { ...file, json: null };
  try {
    return { ...file, json: JSON.parse(file.text) };
  } catch (e) {
    failures.push(`${normalizeRel(rel)}:invalid_json:${String(e.message || e)}`);
    return { ...file, json: null };
  }
}

function artifactEvidence(root, spec, failures) {
  const file = spec.path.endsWith('.json') ? readJson(root, spec.path, failures) : readText(root, spec.path);
  const out = {
    id: spec.id,
    path: normalizeRel(spec.path),
    requirement_ids: spec.requirement_ids.slice(),
    exists: file.exists,
    sha256: file.sha256 || null,
    bytes: file.bytes || 0,
    status: file.exists ? 'present' : 'missing',
  };
  if (!file.exists) failures.push(`${normalizeRel(spec.path)}:missing`);
  if (file.json && spec.id === 'trinity-500-benchmark') {
    out.summary = {
      spec: file.json.spec || null,
      rows: Array.isArray(file.json.rows) ? file.json.rows.length : null,
      generated_at: file.json.generated_at || null,
    };
    if (file.json.spec !== 'kolm-trinity-500-benchmark-1') failures.push('trinity-500-benchmark:spec_mismatch');
    if (!Array.isArray(file.json.rows) || file.json.rows.length < 1) failures.push('trinity-500-benchmark:rows_missing');
  }
  return out;
}

function loadPublicLaneRows(root, failures) {
  const matrix = readJson(root, 'reports/benchmarks/provider-matrix.json', failures);
  if (!matrix.exists || !matrix.json) return [];
  if (!Array.isArray(matrix.json.lanes)) {
    failures.push('reports/benchmarks/provider-matrix.json:missing_lanes_array');
    return [];
  }
  return matrix.json.lanes;
}

function laneStatus(lane, rows) {
  const row = rows.find((item) => item && item.id === lane.id);
  if (!row) {
    return {
      id: lane.id,
      label: lane.label,
      status: 'missing_public_data',
      required_fields: lane.required_fields.slice(),
      missing_fields: lane.required_fields.slice(),
      public_report_path: null,
    };
  }
  const missing = lane.required_fields.filter((field) => row[field] == null || row[field] === '');
  return {
    id: lane.id,
    label: lane.label,
    status: missing.length ? 'incomplete_public_data' : 'complete_public_data',
    required_fields: lane.required_fields.slice(),
    missing_fields: missing,
    public_report_path: row.public_report_path || 'reports/benchmarks/provider-matrix.json',
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function looksLikeHash(value) {
  return typeof value === 'string' && SHA256_RE.test(value) && !/^(?:sha256:)?0{64}$/i.test(value);
}

function nonEmpty(value, min = 1) {
  return typeof value === 'string' && value.trim().length >= min;
}

function validIsoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function validReportPath(value) {
  return typeof value === 'string'
    && REPORT_PATH_RE.test(value)
    && !value.includes('..')
    && !value.includes('\\');
}

function findRawFieldKeys(value, pathParts = []) {
  if (!value || typeof value !== 'object') return [];
  const out = [];
  for (const [key, child] of Object.entries(value)) {
    const next = [...pathParts, key];
    if (RAW_FIELD_RE.test(key)) out.push(next.join('.'));
    if (child && typeof child === 'object') out.push(...findRawFieldKeys(child, next));
  }
  return out;
}

function validateField(field, value, row) {
  if (value == null || value === '') return `${field}:missing`;
  if (/hash$/.test(field) || field === 'artifact_hash' || field === 'model_file_hash' || field === 'bundle_hash') {
    if (!looksLikeHash(value)) return `${field}:must_be_hash_reference`;
  }
  if (/latency_.*_ms$/.test(field) || field === 'cost_usd_per_1k' || field === 'quality_score' || field === 'k_score' || field === 'joules_per_call') {
    if (!isFiniteNumber(value)) return `${field}:must_be_number`;
  }
  if ((field === 'quality_score' || field === 'k_score') && (value < 0 || value > 1)) return `${field}:must_be_0_to_1`;
  if ((field.startsWith('latency_') || field === 'cost_usd_per_1k' || field === 'joules_per_call') && value < 0) return `${field}:must_be_non_negative`;
  if (field === 'size_bytes' && (!Number.isInteger(value) || value <= 0)) return `${field}:must_be_positive_integer`;
  if (field === 'latency_p95_ms' && isFiniteNumber(value) && isFiniteNumber(row.latency_p50_ms) && value < row.latency_p50_ms) {
    return `${field}:must_be_gte_latency_p50_ms`;
  }
  if (typeof value === 'string' && !nonEmpty(value, 2)) return `${field}:must_be_non_empty_string`;
  return null;
}

export function benchmarkEvidenceTemplate() {
  return {
    spec: BENCHMARK_PROVIDER_MATRIX_SPEC,
    secret_values_included: false,
    generated_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    methodology: {
      dataset_version: 'REPLACE_WITH_DATASET_VERSION',
      scoring: 'Report quality, latency, cost, size, energy, privacy, and receipt metrics separately before composite claims.',
      raw_data_policy: 'Do not include raw prompts, raw outputs, credentials, PHI, PII, or provider secrets. Include hashes and report paths only.',
    },
    lanes: REQUIRED_BENCHMARK_LANES.map((lane) => ({
      id: lane.id,
      label: lane.label,
      required_fields: lane.required_fields.slice(),
      public_report_path: 'reports/benchmarks/raw-outputs.jsonl',
      ...Object.fromEntries(lane.required_fields.map((field) => [field, null])),
    })),
  };
}

export function validateBenchmarkProviderMatrix(matrix = {}) {
  const failures = [];
  const rows = Array.isArray(matrix.lanes) ? matrix.lanes : [];
  if (matrix.spec !== BENCHMARK_PROVIDER_MATRIX_SPEC) failures.push(`spec:expected_${BENCHMARK_PROVIDER_MATRIX_SPEC}`);
  if (matrix.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (!validIsoDate(matrix.generated_at)) failures.push('generated_at:invalid');
  if (!matrix.methodology || typeof matrix.methodology !== 'object' || Array.isArray(matrix.methodology)) {
    failures.push('methodology:missing_object');
  } else {
    if (!nonEmpty(matrix.methodology.dataset_version, 3)) failures.push('methodology.dataset_version:missing');
    if (!nonEmpty(matrix.methodology.scoring, 24)) failures.push('methodology.scoring:too_short');
    if (!nonEmpty(matrix.methodology.raw_data_policy, 24)) failures.push('methodology.raw_data_policy:too_short');
    if (!/raw prompts/i.test(matrix.methodology.raw_data_policy) || !/raw outputs/i.test(matrix.methodology.raw_data_policy)) {
      failures.push('methodology.raw_data_policy:must_forbid_raw_prompts_and_outputs');
    }
  }
  if (!Array.isArray(matrix.lanes)) failures.push('lanes:missing_array');
  const serialized = JSON.stringify(matrix);
  if (SECRET_VALUE_RE.test(serialized)) failures.push('secret_value_detected');
  for (const rawKey of findRawFieldKeys(matrix)) failures.push(`${rawKey}:raw_value_field_forbidden`);
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      failures.push('lane:must_be_object');
      continue;
    }
    const lane = REQUIRED_BENCHMARK_LANES.find((item) => item.id === row.id);
    if (!lane) {
      failures.push(`${row.id || 'unknown'}:unknown_lane`);
      continue;
    }
    if (seen.has(lane.id)) failures.push(`${lane.id}:duplicate_lane`);
    seen.add(lane.id);
    if (!validReportPath(row.public_report_path)) failures.push(`${lane.id}:public_report_path_invalid`);
    if (!Array.isArray(row.required_fields)) {
      failures.push(`${lane.id}:required_fields_missing`);
    } else {
      for (const field of lane.required_fields) {
        if (!row.required_fields.includes(field)) failures.push(`${lane.id}:required_field_missing:${field}`);
      }
    }
    for (const field of lane.required_fields) {
      const err = validateField(field, row[field], row);
      if (err) failures.push(`${lane.id}:${err}`);
    }
  }
  for (const lane of REQUIRED_BENCHMARK_LANES) {
    if (!rows.some((row) => row && row.id === lane.id)) failures.push(`${lane.id}:lane_missing`);
  }
  return {
    spec: BENCHMARK_PROVIDER_MATRIX_SPEC,
    ok: failures.length === 0,
    secret_values_included: false,
    counts: {
      lanes: rows.length,
      required_lanes: REQUIRED_BENCHMARK_LANES.length,
      complete_lanes: failures.length ? 0 : REQUIRED_BENCHMARK_LANES.length,
      failures: failures.length,
    },
    failures,
  };
}

export function benchmarkEvidenceCatalog() {
  return {
    spec: BENCHMARK_EVIDENCE_SPEC,
    secret_values_included: false,
    required_lanes: REQUIRED_BENCHMARK_LANES.map((lane) => ({ ...lane, required_fields: lane.required_fields.slice() })),
    required_public_artifacts: REQUIRED_PUBLIC_ARTIFACTS.map((artifact) => ({ ...artifact, requirement_ids: artifact.requirement_ids.slice() })),
    optional_public_reports: OPTIONAL_PUBLIC_REPORTS.slice(),
    research_baseline: BENCHMARK_RESEARCH_BASELINE.map((row) => ({ ...row })),
  };
}

export function auditBenchmarkEvidence(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const failures = [];
  const required_artifacts = REQUIRED_PUBLIC_ARTIFACTS.map((spec) => artifactEvidence(root, spec, failures));
  const optional_reports = OPTIONAL_PUBLIC_REPORTS.map((rel) => {
    const file = readText(root, rel);
    return {
      path: normalizeRel(rel),
      exists: file.exists,
      sha256: file.sha256 || null,
      bytes: file.bytes || 0,
    };
  });
  const rows = loadPublicLaneRows(root, failures);
  const matrixFile = readJson(root, 'reports/benchmarks/provider-matrix.json', failures);
  const provider_matrix_validation = matrixFile.exists && matrixFile.json
    ? validateBenchmarkProviderMatrix(matrixFile.json)
    : {
        spec: BENCHMARK_PROVIDER_MATRIX_SPEC,
        ok: false,
        secret_values_included: false,
        counts: { lanes: 0, required_lanes: REQUIRED_BENCHMARK_LANES.length, complete_lanes: 0, failures: REQUIRED_BENCHMARK_LANES.length },
        failures: REQUIRED_BENCHMARK_LANES.map((lane) => `${lane.id}:lane_missing`),
      };
  if (matrixFile.exists && matrixFile.json && !provider_matrix_validation.ok) {
    failures.push(...provider_matrix_validation.failures.map((failure) => `provider-matrix:${failure}`));
  }
  const lanes = REQUIRED_BENCHMARK_LANES.map((lane) => laneStatus(lane, rows));
  const lane_blockers = lanes
    .filter((lane) => lane.status !== 'complete_public_data')
    .flatMap((lane) => lane.missing_fields.map((field) => `${lane.id}:${field}:missing`));
  const optional_blockers = optional_reports
    .filter((report) => !report.exists)
    .map((report) => `${report.path}:missing`);
  const local_contract_ok = failures.length === 0;
  const public_claim_ready = local_contract_ok && lane_blockers.length === 0 && optional_blockers.length === 0;

  return {
    spec: BENCHMARK_EVIDENCE_SPEC,
    ok: local_contract_ok,
    local_contract_ok,
    public_claim_ready,
    secret_values_included: false,
    generated_at: new Date().toISOString(),
    counts: {
      required_artifacts: required_artifacts.length,
      required_artifacts_present: required_artifacts.filter((item) => item.exists).length,
      required_lanes: lanes.length,
      complete_public_lanes: lanes.filter((lane) => lane.status === 'complete_public_data').length,
      optional_reports_present: optional_reports.filter((item) => item.exists).length,
      blockers: lane_blockers.length + optional_blockers.length + failures.length,
    },
    required_artifacts,
    optional_reports,
    provider_matrix_validation,
    lanes,
    blockers: [
      ...failures,
      ...lane_blockers,
      ...optional_blockers,
    ],
    methodology_controls: [
      'fixed task set with versioned case ids',
      'raw prompt and output hashes retained for every provider lane',
      'provider model id and pricing snapshot pinned with each run',
      'hardware profile, runtime version, and energy fields recorded for local lanes',
      'quality, latency, cost, size, privacy, and receipt metrics reported separately before any composite score',
      'OpenTelemetry-compatible trace fields retained for production replays',
    ],
    research_baseline: BENCHMARK_RESEARCH_BASELINE.map((row) => ({ ...row })),
    note: 'This is the local readiness contract for public benchmark evidence. It does not claim comparative public results until every provider lane has raw reports, hashes, pricing snapshots, and hardware metadata.',
  };
}

export default auditBenchmarkEvidence;
