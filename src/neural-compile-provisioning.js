// W1001 - deterministic provisioning contract for neural compile.
//
// This module keeps `recipe_class=distilled_model` honest before the Python
// worker starts: the selected student backbone, portable export target, train /
// holdout split, remote execution lane, and post-train signing gates are all
// normalized into one checkable envelope. It does not claim a GPU ran; the
// existing compile signing gate still requires real worker metrics and real
// portable model bytes after training.

import { DEFAULT_MODEL, benchmarkScoreFor, info as modelInfo } from './models.js';
import { showBackbone } from './model-registry.js';
import { getVariant } from './model-weights-manifest.js';
import { getCloudBackendStatus } from './cloud-distill.js';

export const NEURAL_COMPILE_PROVISIONING_VERSION = 'w1001-neural-compile-provisioning-v1';

export const NEURAL_COMPILE_PORTABLE_TARGETS = Object.freeze({
  gguf: Object.freeze({
    id: 'gguf',
    runtime_target: 'gguf',
    recipe_field: 'gguf_file',
    worker_export: 'gguf',
    preferred_variant: 'q4_k_m',
  }),
  onnx: Object.freeze({
    id: 'onnx',
    runtime_target: 'onnx',
    recipe_field: 'onnx_file',
    worker_export: 'onnx',
    preferred_variant: null,
  }),
  wasm: Object.freeze({
    id: 'wasm',
    runtime_target: 'wasm',
    recipe_field: 'weights_file',
    worker_export: 'wasm',
    preferred_variant: null,
  }),
});

function boolEnv(name) {
  return /^(1|true|yes|on)$/i.test(String(process.env[name] || ''));
}

function finiteCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeNeuralCompilePortableTarget(target) {
  const raw = cleanString(target) || 'gguf';
  const key = raw.toLowerCase();
  return NEURAL_COMPILE_PORTABLE_TARGETS[key] || null;
}

function check(name, ok, code, detail = {}) {
  return {
    name,
    ok: !!ok,
    code,
    severity: 'blocker',
    ...detail,
  };
}

function compactCloudStatus(status) {
  if (!status || typeof status !== 'object') {
    return {
      status: 'unknown',
      endpoint: null,
      managed_provider: null,
      bridge_source: null,
      missing_env: [],
      hint: null,
    };
  }
  return {
    status: status.status || 'unknown',
    endpoint: status.endpoint || null,
    managed_provider: status.managed_provider || null,
    bridge_source: status.bridge_source || null,
    missing_env: Array.isArray(status.missing_env) ? status.missing_env.slice() : [],
    hint: status.hint || null,
  };
}

function summarizeBenchmarks(model) {
  if (!model || !model.benchmarks) return null;
  const summary = {};
  for (const metric of ['mmlu_pro', 'ifeval', 'gsm8k', 'bfcl']) {
    const score = benchmarkScoreFor(model, metric);
    summary[metric] = score.score == null
      ? null
      : {
        score: score.score,
        source_url: score.source_url || null,
        verified_at: score.verified_at || null,
      };
  }
  return summary;
}

export function buildNeuralCompileProvisioningPlan(input = {}, opts = {}) {
  const job = input.job || input || {};
  const studentBase = cleanString(input.student_base)
    || (cleanString(job.base_model) && cleanString(job.base_model) !== 'none' ? cleanString(job.base_model) : null)
    || DEFAULT_MODEL;
  const requestedTarget = cleanString(input.output_target)
    || cleanString(job.output_target)
    || 'gguf';
  const portable = normalizeNeuralCompilePortableTarget(requestedTarget);
  const variant = cleanString(opts.variant)
    || cleanString(input.variant)
    || cleanString(process.env.KOLM_COMPILE_NEURAL_WEIGHT_VARIANT)
    || portable?.preferred_variant
    || 'q4_k_m';
  const trainCount = finiteCount(input.train_count ?? input.trainCount ?? job.train_count);
  const holdoutCount = finiteCount(input.holdout_eval_count ?? input.holdoutCount ?? job.holdout_eval_count);
  const allowUnregisteredBase = opts.allowUnregisteredBase === true
    || boolEnv('KOLM_COMPILE_ALLOW_UNREGISTERED_NEURAL_BASE');

  const model = modelInfo(studentBase);
  const backbone = showBackbone(studentBase);
  const runtimeVariant = portable?.id === 'gguf' ? getVariant(studentBase, variant) : null;
  const cloudStatus = compactCloudStatus(
    opts.cloudBackendStatus
      || (typeof opts.getCloudBackendStatus === 'function'
        ? opts.getCloudBackendStatus(opts.cloud || opts)
        : getCloudBackendStatus(opts.cloud || opts)),
  );

  const required = [
    check(
      'train_rows_available',
      trainCount > 0,
      'KOLM_E_NEURAL_TRAIN_ROWS_MISSING',
      { count: trainCount },
    ),
    check(
      'holdout_rows_available',
      holdoutCount > 0,
      'KOLM_E_NEURAL_HOLDOUT_ROWS_MISSING',
      { count: holdoutCount },
    ),
    check(
      'portable_target_supported',
      !!portable,
      'KOLM_E_NEURAL_PORTABLE_TARGET_UNSUPPORTED',
      { requested: requestedTarget, allowed: Object.keys(NEURAL_COMPILE_PORTABLE_TARGETS) },
    ),
  ];

  if (!allowUnregisteredBase) {
    required.push(
      check(
        'model_registry_row_present',
        !!model,
        'KOLM_E_NEURAL_MODEL_UNKNOWN',
        { student_base: studentBase },
      ),
      check(
        'backbone_registry_row_present',
        !!backbone,
        'KOLM_E_NEURAL_BACKBONE_UNREGISTERED',
        { student_base: studentBase },
      ),
    );
  }

  const failures = required.filter((row) => !row.ok);
  const firstFailure = failures[0] || null;

  return {
    version: NEURAL_COMPILE_PROVISIONING_VERSION,
    recipe_class: 'distilled_model',
    ok: failures.length === 0,
    code: firstFailure?.code || null,
    error: firstFailure
      ? `neural_compile_provisioning_failed: ${firstFailure.name} (${firstFailure.code})`
      : null,
    student_base: studentBase,
    selected_default: studentBase === DEFAULT_MODEL,
    train_count: trainCount,
    holdout_eval_count: holdoutCount,
    model_registry: model ? {
      present: true,
      id: model.id,
      family: model.family || null,
      params_b: model.params_b ?? null,
      license: model.license || null,
      context_tokens: model.context_tokens ?? null,
      frontier_student: model.frontier_student === true,
      source_url: model.official_source_url || null,
      benchmarks: summarizeBenchmarks(model),
    } : {
      present: false,
      id: studentBase,
      frontier_student: false,
    },
    backbone_registry: backbone ? {
      present: true,
      id: backbone.id,
      family: backbone.family || null,
      pull_status: backbone.pull_status || 'registered',
      local_path: backbone.local_path || null,
      runtime_compatibility: Array.isArray(backbone.runtime_compatibility)
        ? backbone.runtime_compatibility.slice()
        : [],
      weights_verified: backbone.pull_status === 'pulled_and_verified',
    } : {
      present: false,
      id: studentBase,
      pull_status: 'missing',
      local_path: null,
      runtime_compatibility: [],
      weights_verified: false,
    },
    portable_target: portable ? {
      requested: requestedTarget,
      supported: true,
      id: portable.id,
      worker_export: portable.worker_export,
      runtime_target: portable.runtime_target,
      recipe_field: portable.recipe_field,
    } : {
      requested: requestedTarget,
      supported: false,
      id: null,
      worker_export: null,
      runtime_target: null,
      recipe_field: null,
    },
    runtime_weight_manifest: portable?.id === 'gguf' ? {
      format: 'gguf',
      variant,
      present: !!runtimeVariant,
      status: runtimeVariant
        ? 'prebuilt_variant_registered'
        : 'post_train_export_required_no_prebuilt_variant',
      total_bytes: runtimeVariant?.total_bytes || null,
      file_count: Array.isArray(runtimeVariant?.files) ? runtimeVariant.files.length : 0,
    } : {
      format: portable?.id || null,
      variant: null,
      present: false,
      status: portable ? 'post_train_export_required' : 'unsupported_target',
      total_bytes: null,
      file_count: 0,
    },
    execution_lane: {
      local_worker_available: true,
      cloud_backend_status: cloudStatus.status,
      cloud_backend_endpoint: cloudStatus.endpoint,
      managed_provider: cloudStatus.managed_provider,
      bridge_source: cloudStatus.bridge_source,
      missing_env: cloudStatus.missing_env,
      hint: cloudStatus.hint,
    },
    required_pretrain_checks: required,
    post_train_signing_gates: [
      'manifest.ml_pipeline_run=true',
      'student_path_present',
      'student_holdout_accuracy_or_k_score_final_present',
      'portable_weight_file_present_and_nonempty',
      'model_weight_bytes_hash_bound_into_artifact',
    ],
    external_execution_gate: {
      claim: 'No product claim is made until a configured local/BYOC/hosted GPU lane runs the worker and returns real exported model bytes.',
      requires_real_gpu_or_managed_provider: true,
      fixture_injection_claimable: false,
    },
  };
}

export default {
  NEURAL_COMPILE_PROVISIONING_VERSION,
  NEURAL_COMPILE_PORTABLE_TARGETS,
  normalizeNeuralCompilePortableTarget,
  buildNeuralCompileProvisioningPlan,
};
