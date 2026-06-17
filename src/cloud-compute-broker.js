import { objectStorageReadiness } from './object-storage.js';
import { rankQuantizationStrategies } from './quantization-oracle.js';
import { estimate as estimateComputeCost } from './compute/estimator.js';
import { submitSchedulerJob } from './compute-scheduler.js';

const WORKLOADS = Object.freeze(['train', 'distill', 'compile', 'quantize', 'inference', 'serve']);
const PRIVACY_MODES = Object.freeze(['standard', 'regulated', 'zero_retention', 'airgap']);

const LANES = Object.freeze([
  {
    id: 'local-cuda',
    label: 'Local NVIDIA CUDA workstation',
    category: 'local-gpu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['KOLM_FORCE_LOCAL_CUDA', 'CUDA_VISIBLE_DEVICES'],
    configured: (env) => truthy(env.KOLM_FORCE_LOCAL_CUDA) || visibleCuda(env.CUDA_VISIBLE_DEVICES),
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    max_params_b: 70,
    cost_rank: 1,
    latency_rank: 2,
    execution: 'local',
    command_kind: 'local-train',
    strengths: ['no data egress', 'no rental spend', 'artifact bytes stay local'],
  },
  {
    id: 'local-mlx',
    label: 'Local Apple Silicon MLX',
    category: 'local-npu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['KOLM_FORCE_LOCAL_MLX', 'KOLM_MLX_URL'],
    configured: (env) => truthy(env.KOLM_FORCE_LOCAL_MLX) || !!env.KOLM_MLX_URL,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    max_params_b: 13,
    cost_rank: 1,
    latency_rank: 3,
    execution: 'local',
    command_kind: 'local-train',
    strengths: ['private local path', 'good laptop ergonomics', 'MLX export path'],
  },
  {
    id: 'local-cpu',
    label: 'Local CPU fallback',
    category: 'local-cpu',
    workloads: ['compile', 'inference', 'serve'],
    env: [],
    configured: () => true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    max_params_b: 0.5,
    cost_rank: 1,
    latency_rank: 8,
    execution: 'local',
    command_kind: 'local-compile',
    strengths: ['always available', 'airgap compatible'],
    caveats: ['not recommended for real LoRA training or large distillation'],
  },
  {
    id: 'remote-ssh',
    label: 'User-owned remote SSH GPU',
    category: 'self-hosted-gpu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['KOLM_REMOTE_SSH_HOST', 'KOLM_REMOTE_HOST'],
    configured: (env) => !!(env.KOLM_REMOTE_SSH_HOST || env.KOLM_REMOTE_HOST),
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    max_params_b: 70,
    cost_rank: 2,
    latency_rank: 3,
    execution: 'self_hosted',
    command_kind: 'ssh-train',
    strengths: ['bring your own GPU', 'works for regulated/on-prem buyers', 'no provider training lock-in'],
  },
  {
    id: 'runpod-gpu',
    label: 'RunPod rented GPU',
    category: 'rented-gpu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['KOLM_RUNPOD_TOKEN', 'RUNPOD_API_KEY'],
    configured: (env) => !!(env.KOLM_RUNPOD_TOKEN || env.RUNPOD_API_KEY),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 70,
    cost_rank: 2,
    latency_rank: 4,
    execution: 'hosted_gpu',
    command_kind: 'cloud-train',
    backend: 'runpod',
    strengths: ['cheap burst GPU', 'good for first serious distill', 'no local hardware required'],
  },
  {
    id: 'modal-gpu',
    label: 'Modal GPU job',
    category: 'serverless-gpu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference'],
    env: ['KOLM_MODAL_TOKEN', 'MODAL_TOKEN_ID'],
    configured: (env) => !!(env.KOLM_MODAL_TOKEN || env.MODAL_TOKEN_ID),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 70,
    cost_rank: 3,
    latency_rank: 2,
    execution: 'hosted_gpu',
    command_kind: 'cloud-train',
    backend: 'modal',
    strengths: ['fast cold start', 'container-native training jobs', 'good CI integration'],
  },
  {
    id: 'lambda-gpu',
    label: 'Lambda Labs GPU VM',
    category: 'rented-gpu',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['KOLM_LAMBDA_TOKEN', 'KOLM_LAMBDA_API_KEY', 'LAMBDA_API_KEY'],
    configured: (env) => !!(env.KOLM_LAMBDA_TOKEN || env.KOLM_LAMBDA_API_KEY || env.LAMBDA_API_KEY),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 70,
    cost_rank: 4,
    latency_rank: 5,
    execution: 'hosted_gpu',
    command_kind: 'cloud-train',
    backend: 'lambda',
    strengths: ['dedicated GPU VM', 'research workload friendly', 'predictable SSH control'],
  },
  {
    id: 'together-finetune',
    label: 'Together managed fine-tune',
    category: 'managed-training',
    workloads: ['train', 'distill', 'compile'],
    env: ['KOLM_TOGETHER_TOKEN', 'TOGETHER_API_KEY'],
    configured: (env) => !!(env.KOLM_TOGETHER_TOKEN || env.TOGETHER_API_KEY),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 72,
    cost_rank: 3,
    latency_rank: 2,
    execution: 'managed_training',
    command_kind: 'cloud-train',
    backend: 'together',
    strengths: ['managed LoRA path', 'lowest setup burden', 'no rented VM lifecycle'],
  },
  {
    id: 'aws-sagemaker',
    label: 'AWS SageMaker / private VPC training',
    category: 'enterprise-cloud',
    workloads: ['train', 'distill', 'compile', 'quantize', 'inference', 'serve'],
    env: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'KOLM_SAGEMAKER_ROLE_ARN'],
    configured: (env) => !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.KOLM_SAGEMAKER_ROLE_ARN),
    privacy: ['standard', 'regulated', 'zero_retention'],
    max_params_b: 70,
    cost_rank: 5,
    latency_rank: 5,
    execution: 'customer_cloud',
    command_kind: 'deploy-plan',
    strengths: ['enterprise IAM/VPC', 'procurement-friendly', 'customer cloud boundary'],
    caveats: ['planner contract only until a SageMaker adapter lands'],
  },
  {
    id: 'cerebras-inference',
    label: 'Cerebras Cloud Inference (CS-3 wafer-scale)',
    category: 'managed-inference',
    workloads: ['inference', 'serve'],
    env: ['CEREBRAS_API_KEY', 'KOLM_CEREBRAS_TOKEN'],
    configured: (env) => !!(env.CEREBRAS_API_KEY || env.KOLM_CEREBRAS_TOKEN),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 480,
    cost_rank: 3,
    latency_rank: 1,
    execution: 'managed_inference',
    command_kind: 'deploy-plan',
    backend: 'cerebras',
    strengths: ['~2,200 tok/s on 8B and ~450 tok/s on 70B (10-20x typical GPU)', 'wafer-scale CS-3', 'OpenAI-compatible endpoint'],
    caveats: ['inference-only - no training or LoRA upload', 'pre-loaded model catalog (no custom weights)', 'streaming via OpenAI SSE on /v1/chat/completions'],
  },
  {
    id: 'cloudflare-workers-r2',
    label: 'Cloudflare Workers + R2 artifact serving',
    category: 'edge-runtime',
    workloads: ['inference', 'serve'],
    env: ['CLOUDFLARE_ACCOUNT_ID', 'R2_BUCKET'],
    configured: (env) => !!(env.CLOUDFLARE_ACCOUNT_ID && (env.R2_BUCKET || env.KOLM_R2_BUCKET || env.CLOUDFLARE_R2_BUCKET)),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 3,
    cost_rank: 2,
    latency_rank: 1,
    execution: 'edge_runtime',
    command_kind: 'deploy-plan',
    backend: 'cloudflare-workers',
    strengths: ['global artifact serving', 'R2-backed downloads', 'best for small/compiled runtimes'],
  },
  {
    id: 'vercel-edge',
    label: 'Vercel Edge runtime',
    category: 'edge-runtime',
    workloads: ['inference', 'serve'],
    env: ['VERCEL_TOKEN', 'KOLM_ARTIFACT_URL'],
    configured: (env) => !!(env.VERCEL_TOKEN && env.KOLM_ARTIFACT_URL),
    privacy: ['standard', 'zero_retention'],
    max_params_b: 3,
    cost_rank: 3,
    latency_rank: 1,
    execution: 'edge_runtime',
    command_kind: 'deploy-plan',
    backend: 'vercel-edge',
    strengths: ['frontend-native previews', 'fast hosted runtime path'],
  },
]);

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function visibleCuda(value) {
  if (value == null || value === '') return false;
  const v = String(value).trim().toLowerCase();
  return v !== '-1' && v !== 'none' && v !== 'cpu';
}

function cleanName(value, fallback = 'kolm-job') {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9_.-]/g, '-').replace(/-+/g, '-').slice(0, 80) || fallback;
}

function cleanModel(value) {
  return String(value || 'Qwen/Qwen2.5-7B-Instruct').replace(/[^a-zA-Z0-9_./:@+-]/g, '-').slice(0, 180);
}

function cleanPath(value, fallback) {
  return String(value || fallback).replace(/["'`|;&<>]/g, '').slice(0, 240);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeWorkload(input = {}) {
  const raw = String(input.workload || input.mode || 'train').toLowerCase().trim();
  return WORKLOADS.includes(raw) ? raw : 'train';
}

function normalizePrivacy(input = {}) {
  const raw = String(input.privacy || input.privacy_mode || 'standard').toLowerCase().trim().replace(/-/g, '_');
  return PRIVACY_MODES.includes(raw) ? raw : 'standard';
}

function buildProfile(input = {}) {
  const workload = normalizeWorkload(input);
  const paramsB = Math.max(0.1, toNumber(input.params_b ?? input.paramsB ?? input.params, workload === 'serve' ? 3 : 7));
  const rows = Math.max(0, Math.floor(toNumber(input.rows ?? input.training_rows ?? input.examples, workload === 'inference' ? 0 : 1000)));
  const budgetUsd = toNumber(input.budget_usd ?? input.budgetUsd ?? input.budget, 0);
  const contextTokens = Math.max(512, Math.floor(toNumber(input.context ?? input.context_tokens, 8192)));
  return {
    workload,
    privacy: normalizePrivacy(input),
    name: cleanName(input.name || input.job || input.artifact || `${workload}-job`),
    base_model: cleanModel(input.base_model || input.baseModel || input.model),
    dataset: cleanPath(input.dataset || input.seeds || input.examples_path, 'seeds.jsonl'),
    artifact: cleanName(input.artifact || input.artifact_id || input.name || 'artifact'),
    params_b: paramsB,
    rows,
    budget_usd: budgetUsd,
    context_tokens: contextTokens,
    requires_training: ['train', 'distill'].includes(workload) || (workload === 'compile' && rows >= 10),
    no_local_gpu: truthy(input.no_local_gpu) || input.no_local_gpu === true || input.local_gpu === false,
  };
}

function missingEnv(lane, env) {
  if (!lane.env.length || lane.configured(env)) return [];
  if (lane.id === 'local-cuda' || lane.id === 'local-mlx') return lane.env;
  if (lane.id === 'aws-sagemaker') {
    return lane.env.filter((key) => !env[key]);
  }
  if (lane.env.some((key) => env[key])) return [];
  return lane.env;
}

function memoryFit(lane, profile) {
  if (!lane.max_params_b) return { ok: true, reason: null };
  if (profile.params_b <= lane.max_params_b) return { ok: true, reason: null };
  return {
    ok: false,
    reason: `model_size_exceeds_lane_capacity:${profile.params_b}b>${lane.max_params_b}b`,
  };
}

function privacyFit(lane, profile) {
  if (lane.privacy.includes(profile.privacy)) return { ok: true, reason: null };
  if (profile.privacy === 'regulated' && lane.execution === 'customer_cloud') return { ok: true, reason: null };
  return { ok: false, reason: `privacy_mode_${profile.privacy}_not_allowed` };
}

function storageFit(lane, storage, profile) {
  if (lane.execution === 'local') return { ok: true, reason: null, storage_required: false };
  if (profile.workload === 'serve' || profile.requires_training || lane.execution !== 'managed_training') {
    if (storage.cloud_ok || lane.execution === 'self_hosted') return { ok: true, reason: null, storage_required: true };
    return { ok: false, reason: 'cloud_artifact_storage_not_configured', storage_required: true };
  }
  return { ok: true, reason: null, storage_required: false };
}

// Resolve the quantization worker method the oracle recommends for this
// profile, so the broker's quantize command and the quantization oracle agree
// on worker_method. Best-effort: if the oracle has no executable worker_method
// (e.g. only baselines fit) we fall back to int4 (the always-on default the
// worker accepts). The full ranked report is also returned for observability.
function resolveQuantizeMethod(profile, env = process.env) {
  try {
    const ranked = rankQuantizationStrategies({
      params_b: profile.params_b,
      context_tokens: profile.context_tokens,
      // Privacy maps through so airgap profiles don't recommend an external repo.
      privacy_mode: profile.privacy,
    });
    const m = ranked
      && ranked.recommendation
      && ranked.recommendation.primary
      && ranked.recommendation.primary.worker_method;
    return { method: m || 'int4', oracle: ranked || null };
  } catch (_) {
    return { method: 'int4', oracle: null };
  }
}

function commandFor(lane, profile, env = process.env) {
  const seeds = cleanPath(profile.dataset, 'seeds.jsonl');
  const base = cleanModel(profile.base_model);
  const name = cleanName(profile.name);
  const artifact = cleanName(profile.artifact);
  // Atom: quantize workload must emit a `kolm quantize` invocation, not a
  // train/compile command. Branch BEFORE command_kind so every lane (local,
  // remote-ssh, cloud) routes quantize correctly. The method is sourced from
  // the quantization oracle so the broker + oracle agree on worker_method.
  if (profile.workload === 'quantize') {
    const { method } = resolveQuantizeMethod(profile, env);
    const inDir = cleanPath(profile.base_model || '<model-dir>', '<model-dir>');
    const outDir = `${artifact}-${cleanName(method, 'q')}`;
    if (lane.execution === 'local') {
      return `kolm quantize --local-worker --method ${method} --in ${inDir} --out ${outDir}`;
    }
    if (lane.command_kind === 'ssh-train' || lane.execution === 'self_hosted') {
      return `kolm remote quantize --provider=remote-ssh --method=${method} --in=${inDir} --out=${outDir}`;
    }
    // Hosted/rented/managed cloud lanes: the cloud quantize equivalent.
    const backendTag = lane.backend || lane.id;
    return `kolm cloud quantize ${name} --backend ${backendTag} --method ${method} --in ${inDir} --out ${outDir}`;
  }
  if (lane.command_kind === 'local-train') {
    if (profile.requires_training) return `kolm train --namespace ${name} --base-model ${base}`;
    return `kolm compile --spec ${seeds} --out ${artifact}.kolm`;
  }
  if (lane.command_kind === 'local-compile') return `kolm compile --spec ${seeds} --out ${artifact}.kolm`;
  if (lane.command_kind === 'ssh-train') {
    return `kolm remote plan training --provider=remote-ssh --recipe=${seeds} --base-model=${base}`;
  }
  if (lane.command_kind === 'cloud-train') {
    return `kolm cloud train ${name} --backend ${lane.backend} --seeds ${seeds} --base ${base}`;
  }
  if (lane.command_kind === 'deploy-plan') {
    const target = lane.backend || (lane.id === 'aws-sagemaker' ? 'aws-nitro' : lane.id);
    return `kolm cloud deploy-plan --target ${target} --artifact ${artifact} --json`;
  }
  return null;
}

function scoreLane(lane, profile, storage, env) {
  const workloadOk = lane.workloads.includes(profile.workload);
  const configured = lane.configured(env);
  const mem = memoryFit(lane, profile);
  const privacy = privacyFit(lane, profile);
  const store = storageFit(lane, storage, profile);
  const noLocalGpuPenalty = profile.no_local_gpu && lane.category === 'local-gpu' ? 35 : 0;
  const reasons = [];
  if (!workloadOk) reasons.push('workload_not_supported');
  if (!mem.ok) reasons.push(mem.reason);
  if (!privacy.ok) reasons.push(privacy.reason);
  if (!store.ok) reasons.push(store.reason);
  if (profile.requires_training && lane.id === 'local-cpu') reasons.push('cpu_training_refused');
  const feasible = workloadOk && mem.ok && privacy.ok && store.ok && !(profile.requires_training && lane.id === 'local-cpu');
  const missing = missingEnv(lane, env);
  let score = 0;
  if (workloadOk) score += 35;
  if (feasible) score += 25;
  if (configured) score += 20;
  if (lane.execution === 'local' && profile.privacy === 'airgap') score += 20;
  if (lane.execution === 'self_hosted' && ['regulated', 'airgap'].includes(profile.privacy)) score += 16;
  if (lane.execution === 'managed_training' && profile.workload === 'train') score += 8;
  score += Math.max(0, 10 - lane.cost_rank);
  score += Math.max(0, 10 - lane.latency_rank);
  score -= noLocalGpuPenalty;
  score -= (lane.caveats || []).length * 2;
  if (profile.budget_usd > 0 && lane.cost_rank >= 5) score -= 5;
  if (!configured && missing.length) score -= 8;
  const state = feasible && configured ? 'ready' : feasible ? 'needs_configuration' : 'infeasible';
  const quoteCommand = feasible ? commandFor(lane, profile, env) : null;
  const workerMethod = profile.workload === 'quantize'
    ? resolveQuantizeMethod(profile, env).method
    : null;
  return {
    id: lane.id,
    label: lane.label,
    category: lane.category,
    state,
    score,
    feasible,
    configured,
    execution: lane.execution,
    workloads: lane.workloads,
    required_env: lane.env.slice(),
    missing_env: missing,
    privacy_modes: lane.privacy,
    strengths: lane.strengths || [],
    caveats: lane.caveats || [],
    blockers: reasons,
    storage_required: store.storage_required === true,
    quote_command: quoteCommand,
    run_command: state === 'ready' ? quoteCommand : null,
    worker_method: workerMethod,
    command_kind: lane.command_kind,
    backend: lane.backend || null,
    secret_values_included: false,
  };
}

export function cloudComputeBrokerCatalog() {
  return {
    spec: 'kolm-cloud-compute-broker/1',
    workloads: WORKLOADS.slice(),
    privacy_modes: PRIVACY_MODES.slice(),
    lanes: LANES.map((lane) => ({
      id: lane.id,
      label: lane.label,
      category: lane.category,
      workloads: lane.workloads.slice(),
      env: lane.env.slice(),
      execution: lane.execution,
      privacy_modes: lane.privacy.slice(),
      max_params_b: lane.max_params_b,
      secret_values_included: false,
    })),
    secret_values_included: false,
  };
}

export function planCloudCompute(input = {}, env = process.env) {
  const profile = buildProfile(input);
  const storage = objectStorageReadiness(env);
  const ranked = LANES
    .map((lane) => scoreLane(lane, profile, storage, env))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const recommendation = ranked.find((r) => r.state === 'ready')
    || ranked.find((r) => r.state === 'needs_configuration')
    || ranked[0]
    || null;
  const nextActions = [];
  if (recommendation?.run_command) {
    nextActions.push({
      kind: 'command',
      label: 'Run recommended plan',
      value: recommendation.run_command,
    });
  } else if (recommendation?.quote_command) {
    nextActions.push({
      kind: 'command',
      label: 'Quote recommended plan after configuration',
      value: recommendation.quote_command,
    });
  }
  if (!storage.cloud_ok && recommendation?.storage_required) {
    nextActions.push({
      kind: 'configure',
      label: 'Configure artifact storage',
      value: 'kolm cloud storage --json',
    });
  }
  for (const envName of recommendation?.missing_env || []) {
    nextActions.push({
      kind: 'configure',
      label: `Set ${envName}`,
      value: `env:${envName}`,
    });
  }
  return {
    ok: recommendation?.state === 'ready',
    spec: 'kolm-cloud-compute-broker/1',
    profile,
    recommendation,
    ranked,
    storage: {
      ok: storage.ok,
      cloud_ok: storage.cloud_ok,
      selected_provider: storage.selected_provider,
      configured_provider_ids: storage.configured_provider_ids,
      configured_cloud_provider_ids: storage.configured_cloud_provider_ids,
      secret_values_included: false,
    },
    next_actions: nextActions,
    secret_values_included: false,
  };
}

// Map a broker lane to the src/compute backend name used by rent()/run().
// Hosted/rented lanes carry an explicit lane.backend; local + self-hosted
// lanes map by lane id. Returns null for lanes with no compute adapter
// (deploy-plan-only enterprise/edge lanes), which the bridge surfaces honestly.
function laneComputeBackend(lane) {
  if (!lane) return null;
  const byBackend = {
    runpod: 'runpod', modal: 'modal', lambda: 'lambda', together: 'together',
  };
  if (lane.backend && byBackend[lane.backend]) return byBackend[lane.backend];
  const byId = {
    'local-cuda': 'local-cuda',
    'local-mlx': 'local-mlx',
    'local-cpu': 'local-cpu',
    'remote-ssh': 'remote-ssh',
  };
  return byId[lane.id] || null;
}

// Build the spec the chosen compute adapter expects. For local lanes (run())
// we hand the adapter the resolved command argv; for rented/hosted lanes
// (rent()) we pass the training/quantize profile so the estimator + adapter
// can quote + provision.
function buildExecutionSpec(lane, profile, command) {
  const spec = {
    base_model: profile.base_model,
    examples: profile.rows,
    workload: profile.workload,
    name: profile.name,
    artifact: profile.artifact,
    dataset: profile.dataset,
    params_b: profile.params_b,
    context_tokens: profile.context_tokens,
  };
  if (lane.execution === 'local' && command) {
    // Local adapters (local-cpu/local-cuda/local-mlx) run an argv. We pass the
    // recommended command split into argv so run() can spawn it directly.
    spec.command = String(command).split(/\s+/).filter(Boolean);
  }
  return spec;
}

function schedulerCostEstimate(lane, backend, spec, opts = {}) {
  const explicit = Number(opts.estimated_cost_usd);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  if (!lane || lane.execution === 'local') return 0;
  if (!backend) return null;
  try {
    const est = estimateComputeCost(spec, backend);
    return est && est.supported && Number.isFinite(est.cost_usd) ? est.cost_usd : null;
  } catch (_) {
    return null;
  }
}

export function scheduleCloudCompute(input = {}, opts = {}) {
  const env = opts.env || process.env;
  const tenant = opts.tenant || input.tenant || 'local';
  const plan = planCloudCompute(input, env);
  const rec = plan.recommendation;
  if (!rec) {
    return { ok: false, reason: 'no_recommendation', plan };
  }
  if (rec.state === 'infeasible') {
    return { ok: false, reason: 'recommended_lane_infeasible', blockers: rec.blockers || [], plan };
  }
  const lane = LANES.find((l) => l.id === rec.id) || null;
  const backend = laneComputeBackend(lane);
  const command = rec.run_command || rec.quote_command || null;
  if (!backend) {
    return {
      ok: false,
      reason: 'lane_has_no_compute_adapter',
      lane: rec.id,
      execution: rec.execution,
      next_command: command,
      plan,
    };
  }
  const spec = buildExecutionSpec(lane, plan.profile, command);
  const estimatedCostUsd = schedulerCostEstimate(lane, backend, spec, opts);
  const budgetUsd = opts.budget_usd ?? (plan.profile.budget_usd || null);
  const scheduled = submitSchedulerJob({
    tenant,
    family: 'compute',
    operation: plan.profile.workload,
    idempotency_key: opts.idempotency_key || input.idempotency_key,
    priority: opts.priority || input.priority || input.plan_tier,
    lane: rec.id,
    estimated_cost_usd: estimatedCostUsd,
    budget_usd: budgetUsd,
    max_attempts: opts.max_attempts,
    lease_ms: opts.lease_ms,
    retry_base_ms: opts.retry_base_ms,
    payload: {
      profile: plan.profile,
      command,
      backend,
      execution: rec.execution,
      spec,
    },
    labels: {
      source: 'cloud-compute-broker',
      workload: plan.profile.workload,
      backend,
      execution: rec.execution,
    },
    lineage: {
      broker_spec: plan.spec,
      recommendation_id: rec.id,
      storage_provider: plan.storage?.selected_provider || null,
    },
  });
  if (!scheduled.ok) {
    return {
      ok: false,
      reason: scheduled.error || 'scheduler_rejected',
      scheduler: scheduled,
      lane: rec.id,
      backend,
      command,
      plan,
    };
  }
  return {
    ok: true,
    scheduled: true,
    dry_run: true,
    mode: 'scheduled',
    backend,
    lane: rec.id,
    command,
    spec,
    estimated_cost_usd: estimatedCostUsd,
    scheduler_job_id: scheduled.job_id,
    scheduler: scheduled,
    plan,
  };
}

/**
 * Execution bridge from a broker recommendation to a live compute job.
 *
 * planCloudCompute() stays the dry-run quote path. runCloudCompute() takes the
 * SAME input, plans it, then EXECUTES the winning lane against the real compute
 * layer:
 *
 *   - hosted/rented/managed lanes  -> src/compute/rent.js rent(spec, {confirm})
 *   - local lanes                  -> src/compute/index.js run(backend, spec)
 *
 * Real spend is gated behind opts.confirm===true (mirroring rent(): without it
 * rent() returns a dry-run quote and run() is not invoked). Returns a live job
 * handle/result object, never a bare command string.
 *
 * Returns:
 *   { ok:false, reason, plan }                      no actionable recommendation
 *   { ok:true, dry_run:true, mode, backend, ... }   confirm not set
 *   { ok:true, mode:'local'|'rented', backend, job } executed
 */
export async function runCloudCompute(input = {}, opts = {}) {
  if (opts.schedule === true || opts.enqueue === true) {
    return scheduleCloudCompute(input, opts);
  }
  const env = opts.env || process.env;
  const confirm = opts.confirm === true;
  const plan = planCloudCompute(input, env);
  const rec = plan.recommendation;
  if (!rec) {
    return { ok: false, reason: 'no_recommendation', plan };
  }
  if (rec.state === 'infeasible') {
    return { ok: false, reason: 'recommended_lane_infeasible', blockers: rec.blockers || [], plan };
  }
  const lane = LANES.find((l) => l.id === rec.id) || null;
  const backend = laneComputeBackend(lane);
  const command = rec.run_command || rec.quote_command || null;

  if (!backend) {
    // Enterprise/edge deploy-plan lanes have no compute adapter to execute
    // against. Surface the actionable plan command instead of a fake job.
    return {
      ok: false,
      reason: 'lane_has_no_compute_adapter',
      lane: rec.id,
      execution: rec.execution,
      next_command: command,
      plan,
    };
  }

  const spec = buildExecutionSpec(lane, plan.profile, command);

  // Local lanes execute through run(); they own no rental lifecycle.
  if (lane.execution === 'local') {
    if (!confirm) {
      return {
        ok: true, dry_run: true, mode: 'local', backend, lane: rec.id,
        command, spec, plan,
      };
    }
    const { run } = await import('./compute/index.js');
    const job = await run(backend, spec, { on_progress: opts.on_progress });
    return { ok: true, mode: 'local', backend, lane: rec.id, command, job, plan };
  }

  // Hosted/rented/managed/self-hosted lanes execute through rent(), which
  // itself enforces confirm:true before spending. We thread confirm + budget.
  const { rent } = await import('./compute/rent.js');
  const job = await rent(spec, {
    backend,
    confirm,
    budget_usd: opts.budget_usd ?? (plan.profile.budget_usd || null),
    on_progress: opts.on_progress,
    byoc: opts.byoc,
    airgap: opts.airgap,
    training_samples: opts.training_samples,
    data_classification: opts.data_classification,
    allow_sensitive_on_pod: opts.allow_sensitive_on_pod,
  });
  return {
    ok: job && job.ok !== false,
    mode: 'rented',
    backend,
    lane: rec.id,
    command,
    dry_run: job && job.dry_run === true,
    job,
    plan,
  };
}

export default {
  cloudComputeBrokerCatalog,
  planCloudCompute,
  scheduleCloudCompute,
  runCloudCompute,
};
