import crypto from 'node:crypto';

import { planCloudCompute } from './cloud-compute-broker.js';
import { planDistillStrategy } from './distill-strategy.js';
import { PROVIDERS } from './provider-registry.js';
import { rankQuantizationStrategies } from './quantization-oracle.js';

const TASKS = Object.freeze(['classification', 'extraction', 'generation', 'redaction', 'code', 'chat', 'vision', 'medical', 'legal', 'unknown']);
const PRIVACY_MODES = Object.freeze(['standard', 'regulated', 'zero_retention', 'airgap']);

function bool(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '')) || value === true;
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value, fallback = 'default') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.:/@+-]/g, '-').slice(0, 180) || fallback;
}

function normalizeTask(value) {
  const v = String(value || 'unknown').toLowerCase().trim();
  return TASKS.includes(v) ? v : 'unknown';
}

function normalizePrivacy(value) {
  const v = String(value || 'standard').toLowerCase().trim().replace(/-/g, '_');
  return PRIVACY_MODES.includes(v) ? v : 'standard';
}

function providerSummary(env = process.env) {
  return Object.entries(PROVIDERS).map(([id, cfg]) => ({
    id,
    env_key_name: cfg.env_key,
    configured: !!env[cfg.env_key],
    auth: cfg.auth,
    paths: cfg.paths,
    model_count: Object.keys(cfg.cost_per_1k || {}).length,
  }));
}

function profileFrom(input = {}) {
  const real = Math.max(0, Math.floor(num(input.real_pairs ?? input.examples_real ?? input.rows, 0)));
  const synthetic = Math.max(0, Math.floor(num(input.synthetic_pairs ?? input.examples_synthetic, 0)));
  const holdout = Math.max(0, Math.floor(num(input.holdout_pairs ?? input.holdout, Math.floor((real + synthetic) * 0.2))));
  const task = normalizeTask(input.task || input.task_type);
  const paramsB = Math.max(0.1, num(input.params_b ?? input.paramsB ?? input.model_params_b, task === 'vision' ? 3 : 7));
  const contextTokens = Math.max(512, Math.floor(num(input.context_tokens ?? input.contextTokens ?? input.context, 8192)));
  return {
    task,
    namespace: clean(input.namespace || input.name, 'default'),
    base_model: clean(input.base_model || input.model, 'Qwen/Qwen2.5-7B-Instruct'),
    privacy: normalizePrivacy(input.privacy || input.privacy_mode),
    real_pairs: real,
    synthetic_pairs: synthetic,
    holdout_pairs: holdout,
    preference_pairs: Math.max(0, Math.floor(num(input.preference_pairs ?? input.ranked_pairs, 0))),
    label_noise: Math.max(0, Math.min(1, num(input.label_noise, 0.05))),
    teacher_agreement: Math.max(0, Math.min(1, num(input.teacher_agreement, 0.8))),
    repeat_rate: Math.max(0, Math.min(1, num(input.repeat_rate, 0.2))),
    target_latency_ms: Math.max(1, num(input.target_latency_ms ?? input.latency_ms, 120)),
    budget_usd: Math.max(0, num(input.budget_usd ?? input.budget, 0)),
    params_b: paramsB,
    context_tokens: contextTokens,
    calibration_rows: Math.max(0, Math.floor(num(input.calibration_rows ?? input.calibrationRows, real))),
    device: clean(input.device || input.device_id, input.no_local_gpu ? 'h100-80gb' : 'rtx-4090-24gb'),
    runtime: clean(input.runtime || input.target_runtime, input.no_local_gpu ? 'tensorrt' : 'cuda'),
    no_local_gpu: bool(input.no_local_gpu) || input.local_gpu === false,
    existing_artifact: bool(input.existing_artifact),
    requires_training: input.requires_training == null ? real >= 50 : bool(input.requires_training),
  };
}

function dataSufficiency(profile) {
  const hasTrain = profile.real_pairs >= 50 && profile.holdout_pairs >= 10;
  const hasDistill = profile.real_pairs >= 500 && profile.holdout_pairs >= 100;
  const syntheticOnly = profile.synthetic_pairs > 0 && profile.real_pairs === 0;
  const lowHoldout = profile.holdout_pairs < Math.max(10, Math.floor(profile.real_pairs * 0.1));
  const missing = [];
  if (profile.real_pairs < 50) missing.push(`real_pairs:${profile.real_pairs}<50`);
  if (profile.holdout_pairs < 10) missing.push(`holdout_pairs:${profile.holdout_pairs}<10`);
  if (syntheticOnly) missing.push('synthetic_only');
  if (lowHoldout) missing.push('holdout_ratio_low');
  return {
    train_ready: hasTrain && !syntheticOnly,
    distill_ready: hasDistill && !syntheticOnly,
    synthetic_only: syntheticOnly,
    low_holdout: lowHoldout,
    missing,
  };
}

function traceHash(profile) {
  return crypto.createHash('sha256').update(JSON.stringify({
    task: profile.task,
    namespace: profile.namespace,
    real_pairs: profile.real_pairs,
    synthetic_pairs: profile.synthetic_pairs,
    holdout_pairs: profile.holdout_pairs,
    privacy: profile.privacy,
    params_b: profile.params_b,
    context_tokens: profile.context_tokens,
  })).digest('hex');
}

function action(id, label, family, score, feasible, blockers, command, reason, refs = {}) {
  return {
    id,
    label,
    family,
    score: Number(score.toFixed(3)),
    feasible: !!feasible,
    blockers: blockers.filter(Boolean),
    command: feasible ? command : null,
    reason,
    refs,
  };
}

function rankedActions(profile, env, plans) {
  const { sufficiency, providers, distill, cloud, quantization } = plans;
  const configuredProviders = providers.filter((p) => p.configured).map((p) => p.id);
  const teacherConfigured = configuredProviders.some((id) => ['openai', 'anthropic', 'openrouter', 'gemini'].includes(id));
  const recDistill = distill.recommendation || {};
  const recCloud = cloud.recommendation || {};
  const recQuant = quantization.recommendation?.primary || null;
  const actions = [];

  const collectScore = sufficiency.train_ready ? 28 : 95;
  actions.push(action(
    'collect_more_real_pairs',
    'Capture and review more real examples',
    'data',
    collectScore,
    true,
    [],
    `kolm label next --namespace ${profile.namespace} --json`,
    sufficiency.train_ready ? 'Enough data exists, but continued capture improves calibration and drift coverage.' : `Data is not train-ready: ${sufficiency.missing.join(', ') || 'insufficient evidence'}.`,
    { sufficiency }
  ));

  const ruleCacheScore = (profile.repeat_rate >= 0.45 || ['redaction', 'classification', 'extraction'].includes(profile.task)) ? 82 : 52;
  actions.push(action(
    'prompt_rag_rule_cache_first',
    'Use prompt, RAG, rule, or cache before training',
    'no-train',
    sufficiency.train_ready ? ruleCacheScore : ruleCacheScore + 8,
    true,
    [],
    `kolm optimize list --namespace ${profile.namespace} --json`,
    'Low-entropy, repeated, redaction, extraction, or under-proven workloads should prove a cheap non-training path before spending compute.',
    { repeat_rate: profile.repeat_rate, task: profile.task }
  ));

  actions.push(action(
    'provider_route_fallback',
    'Route through approved model providers with fallback',
    'routing',
    teacherConfigured ? 74 : 36,
    teacherConfigured && profile.privacy !== 'airgap',
    [
      teacherConfigured ? '' : 'no_teacher_provider_configured',
      profile.privacy === 'airgap' ? 'airgap_blocks_external_provider_route' : '',
    ],
    `kolm capture --provider ${configuredProviders[0] || 'openai'} --as local --json`,
    'Use provider routing when policy allows external models and the workload still needs frontier behavior or teacher labeling.',
    { configured_providers: configuredProviders }
  ));

  actions.push(action(
    'distill_or_train',
    'Train, fine-tune, preference-optimize, or distill',
    'training',
    (recDistill.score || 0) + (distill.ok ? 35 : 10),
    !!distill.ok && sufficiency.train_ready,
    [
      ...(recDistill.blockers || []),
      sufficiency.train_ready ? '' : 'data_not_train_ready',
    ],
    recDistill.command || `kolm train plan ${profile.namespace} --strategy --json`,
    `Distill strategy engine recommends ${recDistill.id || 'no strategy'} for the current data, privacy, teacher, and task profile.`,
    { distill_strategy: recDistill.id || null, distill_family: recDistill.family || null }
  ));

  actions.push(action(
    'cloud_compute_plan',
    'Use cloud/BYOC/remote compute instead of assuming local GPU',
    'compute',
    (recCloud.score || 0) + (profile.no_local_gpu ? 30 : 5) - (sufficiency.train_ready || profile.existing_artifact ? 0 : 35),
    recCloud.state === 'ready' && (sufficiency.train_ready || profile.existing_artifact),
    [
      recCloud.state === 'ready' ? '' : 'compute_needs_configuration',
      sufficiency.train_ready || profile.existing_artifact ? '' : 'data_not_train_ready_for_compute',
      ...(recCloud.missing_env || []),
    ],
    recCloud.run_command || recCloud.quote_command || `kolm cloud broker --workload train --privacy ${profile.privacy} --json`,
    `Compute planner recommends ${recCloud.id || 'no lane'} with state ${recCloud.state || 'unknown'}.`,
    { compute_lane: recCloud.id || null, compute_state: recCloud.state || null, storage: cloud.storage || null }
  ));

  actions.push(action(
    'compile_signed_artifact',
    'Compile a signed .kolm artifact',
    'compile',
    sufficiency.train_ready || profile.existing_artifact ? 76 : 42,
    sufficiency.train_ready || profile.existing_artifact,
    sufficiency.train_ready || profile.existing_artifact ? [] : ['compile_needs_reviewed_examples_or_existing_artifact'],
    `kolm compile --namespace ${profile.namespace} --out ${profile.namespace}.kolm --json`,
    'Compile only after there is enough reviewed data, a passing recipe, or an existing artifact to re-target.',
    { proof_required: ['holdout_hash', 'manifest_hash', 'signature', 'k_score_interval'] }
  ));

  actions.push(action(
    'quantize_runtime_target',
    'Quantize or retarget for runtime/device fit',
    'quantization',
    recQuant ? 68 + recQuant.score * 20 - (profile.existing_artifact || sufficiency.train_ready ? 0 : 35) : 25,
    !!recQuant?.feasible && (profile.existing_artifact || sufficiency.train_ready),
    [
      ...(recQuant?.warnings || ['no_quantization_candidate']),
      profile.existing_artifact || sufficiency.train_ready ? '' : 'no_artifact_or_train_ready_model_to_quantize',
    ],
    quantization.recommendation?.command || null,
    recQuant ? `Quantization oracle recommends ${recQuant.method} for ${profile.device}/${profile.runtime}.` : 'No quantization recommendation exists.',
    { quantization_method: recQuant?.method || null, runtime: profile.runtime, device: profile.device }
  ));

  actions.push(action(
    'run_existing_artifact_locally',
    'Run the existing artifact locally or at edge',
    'runtime',
    profile.existing_artifact ? 88 : 20,
    profile.existing_artifact,
    profile.existing_artifact ? [] : ['no_existing_artifact'],
    `kolm run ${profile.namespace}.kolm '<input>' --json`,
    'If an artifact already exists, compare local runtime against provider fallback before retraining.',
    { existing_artifact: profile.existing_artifact }
  ));

  actions.push(action(
    'do_not_train_yet',
    'Do not train yet',
    'guardrail',
    sufficiency.synthetic_only || !sufficiency.train_ready ? 86 : 18,
    sufficiency.synthetic_only || !sufficiency.train_ready,
    sufficiency.train_ready && !sufficiency.synthetic_only ? ['training_ready'] : [],
    null,
    'The safest product outcome is sometimes an explicit stop: collect, label, evaluate, or route before creating a model.',
    { sufficiency }
  ));

  return actions.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function nextActions(ranked, plans) {
  const out = [];
  const top = ranked.find((row) => row.feasible && row.command);
  if (top) out.push({ kind: 'command', label: top.label, value: top.command, action_id: top.id });
  for (const item of plans.distill.next_actions || []) out.push({ ...item, source: 'distill-strategy' });
  for (const item of plans.cloud.next_actions || []) out.push({ ...item, source: 'cloud-compute-broker' });
  if (!out.some((row) => row.kind === 'command')) {
    out.push({ kind: 'command', label: 'Collect reviewed examples', value: `kolm label next --namespace ${plans.profile.namespace} --json`, action_id: 'collect_more_real_pairs' });
  }
  return out.slice(0, 8);
}

export function buildStrategyCatalog() {
  return {
    spec: 'kolm-build-strategy-brain/1',
    tasks: TASKS.slice(),
    privacy_modes: PRIVACY_MODES.slice(),
    action_families: ['data', 'no-train', 'routing', 'training', 'compute', 'compile', 'quantization', 'runtime', 'guardrail'],
    surfaces: {
      cli: 'kolm build plan --task extraction --rows 500 --json',
      api: 'POST /v1/build/strategy',
      account: '/account/train',
      tui: 'builds',
    },
    invariant: 'Every recommendation must expose data sufficiency, privacy mode, provider availability, compute plan, quantization plan, proof requirements, and exact next command without exposing secret values.',
  };
}

export function planBuildStrategy(input = {}, env = process.env) {
  const profile = profileFrom(input);
  const sufficiency = dataSufficiency(profile);
  const providers = providerSummary(env);
  const distill = planDistillStrategy({
    ...profile,
    rows: profile.real_pairs,
    teachers: providers.filter((p) => p.configured).map((p) => p.id),
  }, env);
  const cloud = planCloudCompute({
    workload: profile.requires_training ? 'train' : 'compile',
    privacy: profile.privacy,
    name: profile.namespace,
    base_model: profile.base_model,
    params_b: profile.params_b,
    rows: profile.real_pairs + profile.synthetic_pairs,
    context_tokens: profile.context_tokens,
    no_local_gpu: profile.no_local_gpu,
  }, env);
  const quantization = rankQuantizationStrategies({
    task: profile.task,
    params_b: profile.params_b,
    context_tokens: profile.context_tokens,
    calibration_rows: profile.calibration_rows,
    privacy_mode: profile.privacy,
    device: profile.device,
    runtime: profile.runtime,
    target_latency_ms: profile.target_latency_ms,
  });
  const plans = { profile, sufficiency, providers, distill, cloud, quantization };
  const ranked = rankedActions(profile, env, plans);
  const recommendation = ranked.find((row) => row.feasible) || ranked[0] || null;
  const evidenceChain = {
    trace_hash: traceHash(profile),
    data_sufficiency: sufficiency,
    privacy_mode: profile.privacy,
    provider_ids_configured: providers.filter((p) => p.configured).map((p) => p.id),
    distill_strategy_id: distill.recommendation?.id || null,
    compute_lane_id: cloud.recommendation?.id || null,
    compute_state: cloud.recommendation?.state || null,
    quantization_method: quantization.recommendation?.primary?.method || null,
    proof_requirements: ['input_trace_hash', 'train_hash', 'holdout_hash', 'privacy_mode', 'compute_plan', 'k_score_interval', 'artifact_signature'],
  };
  return {
    ok: !!recommendation?.feasible,
    spec: 'kolm-build-strategy-brain/1',
    profile,
    recommendation,
    ranked,
    evidence_chain: evidenceChain,
    component_plans: {
      distill: {
        ok: distill.ok,
        recommendation: distill.recommendation,
        next_actions: distill.next_actions,
      },
      cloud: {
        ok: cloud.ok,
        recommendation: cloud.recommendation,
        storage: cloud.storage,
        next_actions: cloud.next_actions,
      },
      quantization: {
        ok: quantization.ok,
        recommendation: quantization.recommendation,
      },
      providers,
    },
    next_actions: nextActions(ranked, plans),
    secret_values_included: false,
  };
}

export default {
  buildStrategyCatalog,
  planBuildStrategy,
};
