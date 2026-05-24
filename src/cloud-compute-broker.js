import { objectStorageReadiness } from './object-storage.js';

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

function commandFor(lane, profile) {
  const seeds = cleanPath(profile.dataset, 'seeds.jsonl');
  const base = cleanModel(profile.base_model);
  const name = cleanName(profile.name);
  const artifact = cleanName(profile.artifact);
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
  const quoteCommand = feasible ? commandFor(lane, profile) : null;
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

export default {
  cloudComputeBrokerCatalog,
  planCloudCompute,
};
