// Shared probe-harness measurement contracts.
//
// The Python/runtime side still owns booting real artifacts. This module owns
// the cross-domain receipt math: paired baseline/candidate deltas, hash-only
// evidence digests, and fail-closed subobjects for runtime passports and ASR.

import crypto from 'node:crypto';

export const PROBE_HARNESS_VERSION = 'probe-harness-v1';
export const PROBE_MEASUREMENT_RECEIPT_SCHEMA = 'kolm.probe_measurement_receipt.v1';

export const PROBE_HARNESS_DOMAINS = Object.freeze([
  'quantization',
  'kv-cache',
  'speculative-decoding',
  'distillation',
  'agent-security-eval',
]);

const RAW_TEXT_KEYS = new Set([
  'prompt',
  'prompt_text',
  'attack_prompt',
  'benign_prompt',
  'response',
  'response_text',
  'assistant_response',
  'completion',
  'content',
  'output',
  'model_output',
  'candidate_output',
  'messages',
]);

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function round(v, places = 6) {
  if (!isFiniteNumber(v)) return null;
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (RAW_TEXT_KEYS.has(key)) {
      out[`${key}_sha256`] = sha256hex(JSON.stringify(value[key]));
    } else {
      out[key] = stable(value[key]);
    }
  }
  return out;
}

export function sha256hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function digestObject(value) {
  return sha256hex(JSON.stringify(stable(value ?? null)));
}

function numeric(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    const v = obj[key];
    if (isFiniteNumber(v)) return v;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function publicId(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value.slice(0, 160);
  if (typeof value === 'object') {
    const id = value.id ?? value.artifact_id ?? value.target_id ?? value.model ?? value.runtime;
    if (id != null) return String(id).slice(0, 160);
  }
  return null;
}

function sameValue(a, b) {
  if (a == null || b == null) return false;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

export function derivePairedRuntimeDeltas({ baseline, candidate, require_same = ['runtime', 'model', 'workload_id'] } = {}) {
  if (!baseline || typeof baseline !== 'object') {
    return { ok: false, measured: false, reason: 'baseline_required', version: PROBE_HARNESS_VERSION };
  }
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, measured: false, reason: 'candidate_required', version: PROBE_HARNESS_VERSION };
  }
  for (const field of require_same || []) {
    if (baseline[field] == null || candidate[field] == null) {
      return {
        ok: false,
        measured: false,
        reason: `${field}_required`,
        field,
        baseline: baseline[field] ?? null,
        candidate: candidate[field] ?? null,
        version: PROBE_HARNESS_VERSION,
      };
    }
    if (!sameValue(baseline[field], candidate[field])) {
      return {
        ok: false,
        measured: false,
        reason: `${field}_mismatch`,
        field,
        baseline: baseline[field] ?? null,
        candidate: candidate[field] ?? null,
        version: PROBE_HARNESS_VERSION,
      };
    }
  }

  const baselineTokS = numeric(baseline, ['tok_s', 'tokens_per_second', 'throughput_tok_s']);
  const candidateTokS = numeric(candidate, ['tok_s', 'tokens_per_second', 'throughput_tok_s']);
  const baselineMemory = numeric(baseline, ['memory_mb', 'peak_memory_mb', 'peak_kv_mb']);
  const candidateMemory = numeric(candidate, ['memory_mb', 'peak_memory_mb', 'peak_kv_mb']);
  const baselineQuality = numeric(baseline, ['quality_score', 'kscore', 'eval_score', 'accuracy']);
  const candidateQuality = numeric(candidate, ['quality_score', 'kscore', 'eval_score', 'accuracy']);

  return {
    ok: true,
    measured: true,
    version: PROBE_HARNESS_VERSION,
    baseline_id: publicId(baseline),
    candidate_id: publicId(candidate),
    baseline_digest: digestObject(baseline),
    candidate_digest: digestObject(candidate),
    throughput_speedup: baselineTokS && candidateTokS ? round(candidateTokS / baselineTokS) : null,
    baseline_tok_s: baselineTokS,
    candidate_tok_s: candidateTokS,
    memory_delta_mb: isFiniteNumber(baselineMemory) && isFiniteNumber(candidateMemory)
      ? round(candidateMemory - baselineMemory, 3)
      : null,
    memory_ratio: baselineMemory && candidateMemory ? round(candidateMemory / baselineMemory) : null,
    quality_delta: isFiniteNumber(baselineQuality) && isFiniteNumber(candidateQuality)
      ? round(candidateQuality - baselineQuality)
      : null,
  };
}

export function measuredSpeculativeFromPair({ resolved = {}, baseline, candidate } = {}) {
  const pair = derivePairedRuntimeDeltas({
    baseline,
    candidate,
    require_same: ['runtime', 'target_model', 'workload_id'],
  });
  if (!pair.ok || !isFiniteNumber(pair.throughput_speedup)) {
    return Object.freeze({
      method: 'speculative_decoding',
      status: 'unmeasured',
      reason: pair.reason || 'paired_throughput_required',
      version: PROBE_HARNESS_VERSION,
    });
  }
  return Object.freeze({
    method: 'speculative_decoding',
    status: 'tested',
    head_kind: resolved.head_kind || candidate.head_kind || 'draft_model',
    head_id: resolved.head_id || candidate.head_id || candidate.draft_model || null,
    target_model: candidate.target_model,
    runtime: candidate.runtime,
    num_speculative_tokens: numeric(candidate, ['num_speculative_tokens']) || numeric(resolved, ['num_speculative_tokens']),
    acceptance_rate: numeric(candidate, ['acceptance_rate']),
    accepted_length: numeric(candidate, ['accepted_length', 'mean_accept_length']),
    throughput_speedup: pair.throughput_speedup,
    baseline_tok_s: pair.baseline_tok_s,
    candidate_tok_s: pair.candidate_tok_s,
    workload_digest: digestObject(candidate.workload || candidate.workload_id || null),
    version: PROBE_HARNESS_VERSION,
  });
}

export function measuredKvPolicyFromPair({ policy, params = {}, baseline, candidate } = {}) {
  const pair = derivePairedRuntimeDeltas({
    baseline,
    candidate,
    require_same: ['runtime', 'target_model', 'workload_id'],
  });
  const compressionRatio = numeric(candidate, ['compression_ratio']);
  const peakKvMb = numeric(candidate, ['peak_kv_mb']);
  const retainedTokens = numeric(candidate, ['retained_tokens']);
  const evictedTokens = numeric(candidate, ['evicted_tokens']);
  const qualityDelta = numeric(candidate, ['quality_delta']);
  const computedQualityDelta = qualityDelta ?? pair.quality_delta;

  if (!pair.ok || !isFiniteNumber(compressionRatio) || !isFiniteNumber(peakKvMb)) {
    return Object.freeze({
      policy: policy || (candidate && candidate.policy) || null,
      params: Object.freeze({ ...params }),
      status: 'unmeasured',
      reason: pair.reason || 'compression_ratio_and_peak_kv_mb_required',
      version: PROBE_HARNESS_VERSION,
    });
  }

  return Object.freeze({
    policy: policy || candidate.policy,
    params: Object.freeze({ ...params }),
    status: 'tested',
    compression_ratio: compressionRatio,
    retained_tokens: retainedTokens,
    evicted_tokens: evictedTokens,
    peak_kv_mb: peakKvMb,
    quality_delta: isFiniteNumber(computedQualityDelta) ? computedQualityDelta : null,
    max_context_at_vram: numeric(candidate, ['max_context_at_vram']),
    baseline_peak_kv_mb: numeric(baseline, ['peak_kv_mb']),
    memory_ratio: pair.memory_ratio,
    workload_digest: digestObject(candidate.workload || candidate.workload_id || null),
    version: PROBE_HARNESS_VERSION,
  });
}

export function summarizeAgentUtilityUnderAttack(tasks = []) {
  const rows = Array.isArray(tasks) ? tasks : [];
  let attempted = 0;
  let success = 0;
  let paired = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (row.utility_attempted && row.utility_under_attack_attempted) paired++;
    if (!row.utility_under_attack_attempted) continue;
    attempted++;
    if (row.utility_under_attack_success) success++;
  }
  return Object.freeze({
    utility_under_attack_tasks: attempted,
    utility_under_attack_success: success,
    utility_under_attack_rate: attempted ? round(success / attempted) : null,
    paired_utility_tasks: paired,
    paired_utility_coverage: rows.length ? round(paired / rows.length) : null,
    version: PROBE_HARNESS_VERSION,
  });
}

export function buildProbeMeasurementReceipt({
  domain,
  artifact,
  config,
  workload,
  baseline,
  candidate,
  metrics,
  samples = [],
  evidence = {},
  started_at = null,
  completed_at = null,
} = {}) {
  if (!PROBE_HARNESS_DOMAINS.includes(domain)) {
    throw new Error(`buildProbeMeasurementReceipt: domain must be one of ${PROBE_HARNESS_DOMAINS.join('|')}`);
  }
  const sampleDigests = Array.isArray(samples)
    ? samples.slice(0, 512).map((sample) => digestObject(sample))
    : [];
  return Object.freeze({
    schema: PROBE_MEASUREMENT_RECEIPT_SCHEMA,
    version: PROBE_HARNESS_VERSION,
    domain,
    artifact_id: publicId(artifact),
    artifact_digest: digestObject(artifact),
    config_digest: digestObject(config || null),
    workload_digest: digestObject(workload || null),
    baseline_digest: baseline ? digestObject(baseline) : null,
    candidate_digest: candidate ? digestObject(candidate) : null,
    metrics_digest: digestObject(metrics || null),
    sample_count: Array.isArray(samples) ? samples.length : 0,
    sample_digests: sampleDigests,
    evidence_digest: digestObject(evidence || null),
    started_at,
    completed_at,
    claim_scope: baseline && candidate
      ? 'paired_measurement_receipt_digest_only'
      : 'unpaired_measurement_receipt_digest_only',
  });
}

export default {
  PROBE_HARNESS_VERSION,
  PROBE_MEASUREMENT_RECEIPT_SCHEMA,
  PROBE_HARNESS_DOMAINS,
  sha256hex,
  digestObject,
  derivePairedRuntimeDeltas,
  measuredSpeculativeFromPair,
  measuredKvPolicyFromPair,
  summarizeAgentUtilityUnderAttack,
  buildProbeMeasurementReceipt,
};
