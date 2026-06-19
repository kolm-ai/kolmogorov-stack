// W1025 - ExecuTorch device-side validation contract.
//
// This module is intentionally pure. It builds the command/evidence contract
// that iOS/Android runners must satisfy, and validates the report they return.
// It does not claim that a local machine ran a phone or simulator.

import { RUNTIME_PASSPORT_SCHEMA_V2 } from './runtime-passport.js';

export const EXECUTORCH_RUNTIME = 'executorch';
export const EXECUTORCH_VALIDATION_SCHEMA = 'kolm.executorch_device_validation.v1';
export const EXECUTORCH_VALIDATION_VERSION = 'w1025-executorch-device-validation-v1';
export const EXECUTORCH_SUPPORTED_PLATFORMS = Object.freeze(['android', 'ios']);

const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_PROMPTS = Object.freeze([
  Object.freeze({ id: 'smoke-ok', prompt: 'Reply with OK only.', max_tokens: 8, expect_kind: 'nonempty' }),
  Object.freeze({ id: 'smoke-json', prompt: 'Reply with JSON {"ok": true} only.', max_tokens: 16, expect_kind: 'json' }),
]);

function isObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isFiniteNonNegative(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function normalizeSha256(v, field) {
  const s = String(v || '').toLowerCase();
  if (!SHA256_RE.test(s)) {
    throw new Error(`${field} must be lowercase 64-hex sha256`);
  }
  return s;
}

function optionalSha256(v, field) {
  if (v == null || v === '') return null;
  return normalizeSha256(v, field);
}

export function normalizeExecuTorchPlatform(platform) {
  const p = String(platform || '').trim().toLowerCase();
  if (p === 'android' || p === 'adb') return 'android';
  if (p === 'ios' || p === 'iphone' || p === 'simulator' || p === 'simctl') return 'ios';
  throw new Error(`unsupported ExecuTorch platform ${JSON.stringify(platform)}; expected android or ios`);
}

function normalizePrompts(prompts) {
  const rows = Array.isArray(prompts) && prompts.length ? prompts : DEFAULT_PROMPTS;
  return rows.map((row, i) => {
    const prompt = isObject(row) ? row.prompt : row;
    if (!isNonEmptyString(prompt)) {
      throw new Error(`prompts[${i}].prompt must be a non-empty string`);
    }
    const id = isObject(row) && isNonEmptyString(row.id) ? String(row.id) : `prompt-${i + 1}`;
    const maxTokens = isObject(row) && row.max_tokens != null ? Number(row.max_tokens) : 32;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || maxTokens > 4096) {
      throw new Error(`prompts[${i}].max_tokens must be an integer in [1,4096]`);
    }
    return Object.freeze({
      id,
      prompt: String(prompt),
      max_tokens: maxTokens,
      expect_kind: isObject(row) && row.expect_kind ? String(row.expect_kind) : 'nonempty',
      expected_output_sha256: isObject(row) ? optionalSha256(row.expected_output_sha256, `prompts[${i}].expected_output_sha256`) : null,
    });
  });
}

function targetIdFor(platform, deviceId) {
  const device = String(deviceId || 'default').replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
  return `${EXECUTORCH_RUNTIME}-${platform}-${device}`;
}

function androidCommands({ device_id, pte_path, package_name, timeout_ms }) {
  const deviceArg = device_id ? ['-s', device_id] : [];
  return [
    Object.freeze({
      step: 'push_pte',
      tool: 'adb',
      argv: [...deviceArg, 'push', pte_path, '/data/local/tmp/kolm/model.pte'],
    }),
    Object.freeze({
      step: 'run_instrumented_validation',
      tool: 'adb',
      argv: [
        ...deviceArg,
        'shell',
        'am',
        'instrument',
        '-w',
        '-e',
        'kolm_pte_path',
        '/data/local/tmp/kolm/model.pte',
        '-e',
        'kolm_timeout_ms',
        String(timeout_ms),
        `${package_name}/androidx.test.runner.AndroidJUnitRunner`,
      ],
    }),
  ];
}

function iosCommands({ device_id, pte_path, bundle_id, app_path, timeout_ms }) {
  const device = device_id || 'booted';
  const install = app_path
    ? [Object.freeze({ step: 'install_app', tool: 'xcrun', argv: ['simctl', 'install', device, app_path] })]
    : [];
  return [
    ...install,
    Object.freeze({
      step: 'run_device_validation',
      tool: 'xcrun',
      argv: [
        'simctl',
        'launch',
        '--console',
        device,
        bundle_id,
        '--kolm-pte-path',
        pte_path,
        '--kolm-timeout-ms',
        String(timeout_ms),
      ],
    }),
  ];
}

export function buildExecuTorchValidationPlan(opts = {}) {
  if (!isObject(opts)) throw new Error('buildExecuTorchValidationPlan: opts must be object');
  const platform = normalizeExecuTorchPlatform(opts.platform || opts.target?.platform);
  const pte_path = String(opts.pte_path || opts.ptePath || opts.model_pte_path || '').trim();
  if (!pte_path || !/\.pte$/i.test(pte_path)) {
    throw new Error('buildExecuTorchValidationPlan: pte_path must point at a .pte file');
  }
  const model_pte_sha256 = normalizeSha256(opts.model_pte_sha256 || opts.pte_sha256 || opts.modelPteSha256, 'model_pte_sha256');
  const artifact_sha256 = optionalSha256(opts.artifact_sha256 || opts.artifact_hash || opts.artifact?.sha256 || opts.artifact?.hash, 'artifact_sha256');
  const manifest_sha256 = optionalSha256(opts.manifest_sha256 || opts.model_weight_manifest_sha256 || opts.manifest?.sha256, 'manifest_sha256');
  if (!artifact_sha256 && !manifest_sha256) {
    throw new Error('buildExecuTorchValidationPlan: artifact_sha256 or manifest_sha256 is required');
  }
  const prompts = normalizePrompts(opts.prompts);
  const device_id = opts.device_id || opts.deviceId || opts.udid || opts.serial || (platform === 'ios' ? 'booted' : null);
  const target_id = opts.target_id || targetIdFor(platform, device_id || 'adb-default');
  const timeout_ms = Number(opts.timeout_ms || opts.timeoutMs || 120_000);
  if (!Number.isSafeInteger(timeout_ms) || timeout_ms <= 0) {
    throw new Error('buildExecuTorchValidationPlan: timeout_ms must be a positive integer');
  }
  const bundle_id = String(opts.bundle_id || opts.bundleId || 'ai.kolm.ExecuTorchProbe');
  const package_name = String(opts.package_name || opts.packageName || 'ai.kolm.executorchprobe.test');
  const commands = platform === 'android'
    ? androidCommands({ device_id, pte_path, package_name, timeout_ms })
    : iosCommands({ device_id, pte_path, bundle_id, app_path: opts.app_path || opts.appPath || null, timeout_ms });

  return Object.freeze({
    schema: EXECUTORCH_VALIDATION_SCHEMA,
    version: EXECUTORCH_VALIDATION_VERSION,
    runtime: EXECUTORCH_RUNTIME,
    status: 'planned',
    device_side: true,
    platform,
    target_id: String(target_id),
    device: Object.freeze({ id: device_id ? String(device_id) : null }),
    app: Object.freeze({
      bundle_id: platform === 'ios' ? bundle_id : null,
      package_name: platform === 'android' ? package_name : null,
    }),
    artifact: Object.freeze({
      artifact_id: opts.artifact_id || opts.artifact?.id || null,
      artifact_sha256,
      manifest_sha256,
    }),
    model: Object.freeze({
      pte_path,
      model_pte_sha256,
      format: 'pte',
      runtime_target: EXECUTORCH_RUNTIME,
    }),
    prompts: Object.freeze(prompts),
    requirements: Object.freeze({
      signed_weights: true,
      no_unsigned_auto_fetch: true,
      device_side_execution: true,
      require_signature_ok: true,
      require_load_ok: true,
      require_inference_ok: true,
    }),
    commands: Object.freeze(commands),
    report_contract: Object.freeze({
      required_true: Object.freeze(['device_side', 'sig_ok', 'load_ok', 'inference_ok']),
      required_sha256: Object.freeze(['model_pte_sha256']),
      required_numeric: Object.freeze(['latency_p50_ms', 'latency_p95_ms', 'memory_mb', 'tok_s']),
    }),
  });
}

function fail(reason) {
  return { ok: false, reason };
}

function reportSha(report, name) {
  const value = report[name] || report.artifact?.[name] || report.model?.[name];
  return value == null ? null : String(value).toLowerCase();
}

export function validateExecuTorchDeviceReport(report, plan = null) {
  if (!isObject(report)) return fail('report must be object');
  if (report.schema !== EXECUTORCH_VALIDATION_SCHEMA) return fail('schema mismatch');
  if (report.version !== EXECUTORCH_VALIDATION_VERSION) return fail('version mismatch');
  if (report.runtime !== EXECUTORCH_RUNTIME) return fail('runtime must be executorch');
  let platform;
  try {
    platform = normalizeExecuTorchPlatform(report.platform);
  } catch (err) {
    return fail(err.message);
  }
  if (!isNonEmptyString(report.target_id)) return fail('target_id required');
  if (report.device_side !== true) return fail('device_side must be true');
  for (const field of ['sig_ok', 'load_ok', 'inference_ok']) {
    if (report[field] !== true) return fail(`${field} must be true`);
  }
  const model_pte_sha256 = reportSha(report, 'model_pte_sha256');
  if (!SHA256_RE.test(model_pte_sha256 || '')) return fail('model_pte_sha256 must be lowercase 64-hex');
  const artifact_sha256 = reportSha(report, 'artifact_sha256');
  const manifest_sha256 = reportSha(report, 'manifest_sha256');
  if (!SHA256_RE.test(artifact_sha256 || '') && !SHA256_RE.test(manifest_sha256 || '')) {
    return fail('artifact_sha256 or manifest_sha256 must be lowercase 64-hex');
  }
  if (!isObject(report.device) || !isNonEmptyString(report.device.id)) return fail('device.id required');
  if (!isFiniteNonNegative(report.latency_p50_ms)) return fail('latency_p50_ms must be finite non-negative');
  if (!isFiniteNonNegative(report.latency_p95_ms)) return fail('latency_p95_ms must be finite non-negative');
  if (report.latency_p95_ms < report.latency_p50_ms) return fail('latency_p95_ms must be >= latency_p50_ms');
  if (!isFiniteNonNegative(report.memory_mb)) return fail('memory_mb must be finite non-negative');
  if (!isFiniteNonNegative(report.tok_s) || report.tok_s === 0) return fail('tok_s must be finite positive');
  if (report.ttft_ms != null && !isFiniteNonNegative(report.ttft_ms)) return fail('ttft_ms must be finite non-negative when present');
  if (report.output_digest_sha256 != null && !SHA256_RE.test(String(report.output_digest_sha256).toLowerCase())) {
    return fail('output_digest_sha256 must be lowercase 64-hex when present');
  }
  if (report.prompt_count != null && (!Number.isSafeInteger(report.prompt_count) || report.prompt_count <= 0)) {
    return fail('prompt_count must be a positive integer when present');
  }
  if (plan != null) {
    if (!isObject(plan)) return fail('plan must be object when supplied');
    if (plan.schema !== EXECUTORCH_VALIDATION_SCHEMA) return fail('plan schema mismatch');
    if (plan.version !== EXECUTORCH_VALIDATION_VERSION) return fail('plan version mismatch');
    if (plan.runtime !== EXECUTORCH_RUNTIME) return fail('plan runtime mismatch');
    if (plan.platform !== platform) return fail('platform does not match plan');
    if (String(plan.target_id) !== String(report.target_id)) return fail('target_id does not match plan');
    if (plan.model?.model_pte_sha256 !== model_pte_sha256) return fail('model_pte_sha256 does not match plan');
    if (plan.artifact?.artifact_sha256 && artifact_sha256 && plan.artifact.artifact_sha256 !== artifact_sha256) {
      return fail('artifact_sha256 does not match plan');
    }
    if (plan.artifact?.manifest_sha256 && manifest_sha256 && plan.artifact.manifest_sha256 !== manifest_sha256) {
      return fail('manifest_sha256 does not match plan');
    }
    if (Array.isArray(plan.prompts) && report.prompt_count != null && report.prompt_count < plan.prompts.length) {
      return fail('prompt_count is lower than the validation plan prompt count');
    }
    for (const prompt of plan.prompts || []) {
      if (prompt.expected_output_sha256 && !report.output_digest_sha256) {
        return fail(`output digest missing for expected prompt ${prompt.id}`);
      }
      if (prompt.expected_output_sha256 && prompt.expected_output_sha256 !== report.output_digest_sha256) {
        return fail(`output digest does not match expected prompt ${prompt.id}`);
      }
    }
  }
  return {
    ok: true,
    platform,
    target_id: String(report.target_id),
    model_pte_sha256,
    artifact_sha256: SHA256_RE.test(artifact_sha256 || '') ? artifact_sha256 : null,
    manifest_sha256: SHA256_RE.test(manifest_sha256 || '') ? manifest_sha256 : null,
  };
}

export function execuTorchRuntimePassportEntry(report, opts = {}) {
  const validation = validateExecuTorchDeviceReport(report, opts.plan || null);
  if (!validation.ok) {
    throw new Error(`execuTorchRuntimePassportEntry: ${validation.reason}`);
  }
  const runtimeVersion = isNonEmptyString(report.executorch_version)
    ? `executorch ${report.executorch_version}`
    : 'executorch device-validation';
  return {
    schema_version: RUNTIME_PASSPORT_SCHEMA_V2,
    target_id: validation.target_id,
    status: 'tested',
    runtime: EXECUTORCH_RUNTIME,
    runtime_version: runtimeVersion,
    precision: isNonEmptyString(report.precision) ? String(report.precision) : 'pte',
    memory_mb: report.memory_mb,
    latency_p50_ms: report.latency_p50_ms,
    latency_p95_ms: report.latency_p95_ms,
    tok_s: report.tok_s,
    quality_delta: typeof report.quality_delta === 'number' && Number.isFinite(report.quality_delta) ? report.quality_delta : 0,
    fallback: opts.fallback != null ? String(opts.fallback) : null,
    file_size_bytes: Number.isSafeInteger(report.model_pte_bytes) && report.model_pte_bytes > 0 ? report.model_pte_bytes : null,
    file_hash: `sha256:${validation.model_pte_sha256}`,
    time_to_first_token_ms: report.ttft_ms ?? report.latency_p50_ms,
    max_context_tested: Number.isSafeInteger(report.max_context_tested) ? report.max_context_tested : null,
    perplexity_delta: typeof report.perplexity_delta === 'number' && Number.isFinite(report.perplexity_delta) ? report.perplexity_delta : null,
    kv_cache: null,
    executorch_device_validation: {
      schema: EXECUTORCH_VALIDATION_SCHEMA,
      version: EXECUTORCH_VALIDATION_VERSION,
      platform: validation.platform,
      device_id: report.device.id,
      model_pte_sha256: validation.model_pte_sha256,
      artifact_sha256: validation.artifact_sha256,
      manifest_sha256: validation.manifest_sha256,
      sig_ok: true,
      load_ok: true,
      inference_ok: true,
      output_digest_sha256: report.output_digest_sha256 || null,
      prompt_count: report.prompt_count || null,
    },
    unsupported_features: [],
    notes: 'Device-side ExecuTorch validation report passed signature, byte-hash, load, and inference checks.',
  };
}

export default {
  EXECUTORCH_RUNTIME,
  EXECUTORCH_VALIDATION_SCHEMA,
  EXECUTORCH_VALIDATION_VERSION,
  EXECUTORCH_SUPPORTED_PLATFORMS,
  normalizeExecuTorchPlatform,
  buildExecuTorchValidationPlan,
  validateExecuTorchDeviceReport,
  execuTorchRuntimePassportEntry,
};
