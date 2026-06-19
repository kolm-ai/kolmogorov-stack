import { classifyTeacher } from './distill-pipeline.js';
import { MOE_FAMILIES, familyForArchitecture, getFamily } from './moe-registry.js';

const TASKS = Object.freeze(['classification', 'extraction', 'generation', 'redaction', 'code', 'chat', 'reasoning', 'unknown']);
const PRIVACY_MODES = Object.freeze(['standard', 'regulated', 'zero_retention', 'airgap']);

const STRATEGIES = Object.freeze([
  {
    id: 'collect_more_real_pairs',
    label: 'Collect more reviewed real pairs',
    family: 'data',
    command_kind: null,
    min_real_pairs: 0,
    min_holdout_pairs: 0,
    teacher_required: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['cold-start', 'synthetic-only', 'low-holdout'],
  },
  {
    id: 'rule_or_cache_first',
    label: 'Rule/cache/RAG first',
    family: 'no-train',
    command_kind: 'runtime-policy',
    min_real_pairs: 0,
    min_holdout_pairs: 0,
    teacher_required: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['redaction', 'low-entropy-classification', 'repeated-workflows'],
  },
  {
    id: 'small_classifier',
    label: 'Small classifier or extractor',
    family: 'supervised',
    command_kind: 'train-plan',
    min_real_pairs: 50,
    min_holdout_pairs: 10,
    teacher_required: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['classification', 'redaction', 'short-extraction'],
  },
  {
    id: 'lora_sft',
    label: 'LoRA supervised fine-tune',
    family: 'supervised',
    command_kind: 'cloud-train',
    min_real_pairs: 200,
    min_holdout_pairs: 40,
    teacher_required: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['extraction', 'generation', 'code'],
  },
  {
    id: 'kd_top_k',
    label: 'Top-k teacher distillation',
    family: 'distill',
    command_kind: 'distill',
    min_real_pairs: 500,
    min_holdout_pairs: 100,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'zero_retention'],
    best_for: ['budget-sensitive-teacher', 'stable-output-format'],
  },
  {
    id: 'kd_softmax',
    label: 'Softmax teacher distillation',
    family: 'distill',
    command_kind: 'distill',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'zero_retention'],
    best_for: ['generation', 'chat', 'teacher-behavior-copy'],
  },
  {
    id: 'rejection_sampling',
    label: 'Teacher rejection sampling',
    family: 'distill',
    command_kind: 'distill',
    min_real_pairs: 300,
    min_holdout_pairs: 60,
    teacher_required: true,
    privacy: ['standard', 'zero_retention'],
    best_for: ['noisy-labels', 'creative-generation', 'low-teacher-agreement'],
  },
  {
    id: 'bond_jeffreys',
    label: 'BOND Jeffreys distribution matching',
    family: 'distill',
    command_kind: 'local-worker-objective',
    objective: 'bond_jeffreys',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'chat', 'best-of-n-targets', 'local-teacher', 'open-weights-teacher'],
    references: [
      { name: 'BOND: Aligning LLMs with Best-of-N Distillation', method: 'jeffreys-distribution-matching', status: 'frontier_reference', paper: 'arXiv:2407.14622' },
    ],
  },
  {
    id: 'ropd',
    label: 'ROPD black-box on-policy distillation',
    family: 'online',
    command_kind: 'ropd-blackbox',
    min_real_pairs: 500,
    min_holdout_pairs: 100,
    teacher_required: true,
    requires_teacher_logits: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'chat', 'reasoning', 'api-teacher', 'teacher-text-only'],
  },
  {
    id: 'gad',
    label: 'GAD black-box adversarial distillation',
    family: 'online',
    command_kind: 'gad-blackbox',
    min_real_pairs: 500,
    min_holdout_pairs: 100,
    teacher_required: true,
    requires_teacher_logits: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'chat', 'reasoning', 'api-teacher', 'teacher-text-only', 'adversarial-distill'],
    references: [
      { name: 'Generative Adversarial Distillation', method: 'teacher-text-vs-student-rollout-discriminator', status: 'frontier_reference', paper: 'arXiv:2511.10643' },
    ],
  },
  {
    id: 'gkd_onpolicy',
    label: 'GKD on-policy local-teacher distillation',
    family: 'online',
    command_kind: 'onpolicy-gkd',
    min_real_pairs: 500,
    min_holdout_pairs: 100,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'chat', 'local-teacher', 'open-weights-teacher'],
  },
  {
    id: 'distillm2',
    label: 'DistiLLM-2 logit distillation',
    family: 'distill',
    command_kind: 'local-worker-objective',
    objective: 'distillm2',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'chat', 'open-weights-teacher'],
  },
  {
    id: 'moe_to_dense_distill',
    label: 'MoE-to-dense structural collapse + distillation',
    family: 'distill',
    command_kind: 'moe-distill',
    execution_status: 'worker_ready_structural_collapse_recovery_plan',
    objective: 'forward_kl',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    requires_teacher_logits: true,
    requires_moe: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['generation', 'reasoning', 'moe-teacher', 'large-moe-reasoner', 'moe-to-dense', 'expert-prune-then-distill'],
    references: [
      { name: 'MoE-to-dense: Pruning and Distilling Mixture-of-Experts into Dense Language Models', method: 'score-select-group-concat-forward-kl', status: 'frontier_reference', paper: 'arXiv:2605.28207' },
      { name: 'SlimMoE', method: 'multi-stage-expert-slimming-and-distill', status: 'frontier_reference' },
    ],
  },
  {
    id: 'reverse_kl_minillm',
    label: 'Reverse-KL MiniLLM distillation',
    family: 'distill',
    command_kind: 'local-worker-objective',
    objective: 'reverse_kl',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    requires_teacher_logits: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['chat', 'mode-seeking', 'open-weights-teacher'],
  },
  {
    id: 'cot_distill',
    label: 'Reasoning trace distillation',
    family: 'reasoning',
    command_kind: 'cot-distill',
    min_real_pairs: 300,
    min_holdout_pairs: 60,
    teacher_required: false,
    requires_teacher_logits: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['reasoning', 'code', 'multi-step-captures'],
  },
  {
    id: 'preference_optimization',
    label: 'Preference optimization',
    family: 'preference',
    command_kind: 'preference',
    min_real_pairs: 200,
    min_holdout_pairs: 40,
    min_preference_pairs: 50,
    teacher_required: false,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['ranked-outputs', 'style-control', 'human-preference'],
  },
  {
    id: 'onpolicy_distill',
    label: 'On-policy self-improvement',
    family: 'online',
    command_kind: 'onpolicy',
    min_real_pairs: 500,
    min_holdout_pairs: 100,
    teacher_required: false,
    requires_teacher_logits: true,
    privacy: ['standard', 'regulated', 'zero_retention', 'airgap'],
    best_for: ['live-feedback', 'existing-artifact', 'incremental-improvement'],
  },
  {
    id: 'speculative_decoding_train',
    label: 'Speculative decoding assistant train',
    family: 'serving',
    command_kind: 'spec-decode',
    min_real_pairs: 1000,
    min_holdout_pairs: 200,
    teacher_required: true,
    privacy: ['standard', 'zero_retention'],
    best_for: ['latency-critical-chat', 'draft-model-serving'],
  },
]);

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value, fallback = 'default') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_.:/@+-]/g, '-').slice(0, 180) || fallback;
}

function _boolish(value) {
  return value === true || truthy(value);
}

function _familyFromString(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const exact = getFamily(raw);
  if (exact) return exact;
  const arch = familyForArchitecture(raw);
  if (arch) return arch;
  const lower = raw.toLowerCase();
  for (const family of Object.values(MOE_FAMILIES)) {
    if (lower === family.id || lower.includes(family.id)) return family;
    if (lower.includes(String(family.display_name || '').toLowerCase())) return family;
    for (const a of (family.architectures || [])) {
      if (lower.includes(String(a).toLowerCase())) return family;
    }
  }
  if (/qwen3.*moe|qwen.*30b.*a3b.*moe/.test(lower)) return getFamily('qwen3-moe-a3b');
  if (/qwen2.*moe|qwen.*a14b.*moe/.test(lower)) return getFamily('qwen2-moe-a14b');
  if (/deepseek.*v3/.test(lower)) return getFamily('deepseek-v3');
  if (/deepseek.*v2.*lite/.test(lower)) return getFamily('deepseek-v2-lite');
  if (/mixtral.*8x22/.test(lower)) return getFamily('mixtral-8x22b');
  if (/mixtral|8x7b/.test(lower)) return getFamily('mixtral-8x7b');
  if (/llama[-_ ]?4|maverick/.test(lower)) return getFamily('llama4-maverick');
  return /\bmoe\b|mixture[-_ ]?of[-_ ]?experts/.test(lower) ? { id: 'unknown-moe', display_name: 'Unknown MoE' } : null;
}

function _firstFamily(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const fam = _familyFromString(value.family || value.moe_family || value.id || value.architecture);
      if (fam) return fam;
      if (_boolish(value.is_moe)) return { id: 'unknown-moe', display_name: 'Unknown MoE' };
    } else {
      const fam = _familyFromString(value);
      if (fam) return fam;
    }
  }
  return null;
}

function moeProfileFrom(input, teacherModels) {
  const teacherFamily = _firstFamily(
    input.teacher_moe_family,
    input.moe_teacher_family,
    input.teacher_moe_info,
    input.teacher_model,
    input.teacher_base_model,
    input.teacher_architecture,
    ...(Array.isArray(teacherModels) ? teacherModels : []),
  );
  const baseFamily = _firstFamily(
    input.base_moe_family,
    input.moe_family,
    input.base_moe_info,
    input.model_moe_info,
    input.base_model,
    input.model,
    input.model_architecture,
    input.architecture,
  );
  const teacherExplicit = _boolish(input.teacher_is_moe)
    || _boolish(input.teacher_moe)
    || _boolish(input.moe_teacher)
    || _boolish(input.teacher_moe_info && input.teacher_moe_info.is_moe);
  const baseExplicit = _boolish(input.base_is_moe)
    || _boolish(input.model_is_moe)
    || _boolish(input.student_is_moe)
    || _boolish(input.is_moe)
    || _boolish(input.base_moe_info && input.base_moe_info.is_moe)
    || _boolish(input.model_moe_info && input.model_moe_info.is_moe);
  const teacherModel = clean(input.teacher_model || input.teacher_base_model || teacherModels[0] || 'local-moe-teacher', 'local-moe-teacher');
  const signals = [];
  if (teacherExplicit) signals.push('teacher_flag');
  if (baseExplicit) signals.push('base_flag');
  if (teacherFamily) signals.push('teacher_family:' + teacherFamily.id);
  if (baseFamily) signals.push('base_family:' + baseFamily.id);
  return {
    teacher_is_moe: teacherExplicit || !!teacherFamily,
    base_is_moe: baseExplicit || !!baseFamily,
    has_moe_signal: teacherExplicit || baseExplicit || !!teacherFamily || !!baseFamily,
    teacher_family: teacherFamily ? teacherFamily.id : null,
    base_family: baseFamily ? baseFamily.id : null,
    family: (teacherFamily || baseFamily || null)?.id || null,
    teacher_model: teacherModel,
    signals,
  };
}

function normalizeTask(value) {
  const v = String(value || 'unknown').toLowerCase().trim();
  return TASKS.includes(v) ? v : 'unknown';
}

function normalizePrivacy(value) {
  const v = String(value || 'standard').toLowerCase().trim().replace(/-/g, '_');
  return PRIVACY_MODES.includes(v) ? v : 'standard';
}

function teachersFromEnv(env) {
  const out = [];
  if (env.ANTHROPIC_API_KEY) out.push('anthropic:claude');
  if (env.OPENAI_API_KEY) out.push('openai:gpt');
  if (env.OPENROUTER_API_KEY) out.push('openrouter:api');
  if (env.KOLM_LOCAL_TEACHER_URL || env.OLLAMA_HOST || env.KOLM_VLLM_URL) out.push('local:teacher');
  return out;
}

function teacherClass(teacher) {
  const raw = String(teacher || '').trim().toLowerCase();
  if (!raw) return 'unknown';
  if (['anthropic', 'claude', 'openai', 'gpt', 'openrouter', 'gemini', 'google'].includes(raw)) return 'proprietary';
  if (raw.startsWith('openrouter:')) return 'proprietary';
  if (raw === 'local' || raw === 'ollama' || raw === 'vllm') return 'open-weights';
  return classifyTeacher(raw);
}

function teacherAccess(input, teacherModels) {
  const classes = teacherModels.map(teacherClass);
  const hasProprietaryTeacher = classes.includes('proprietary');
  const hasOpenWeightsTeacher = classes.includes('open-weights')
    || input.teacher_local === true
    || input.local_teacher === true
    || input.teacher_logits === true;
  return {
    classes,
    has_proprietary_teacher: hasProprietaryTeacher,
    has_open_weights_teacher: hasOpenWeightsTeacher,
    has_teacher_logits: hasOpenWeightsTeacher,
    text_only: hasProprietaryTeacher && !hasOpenWeightsTeacher,
  };
}

function profileFrom(input = {}, env = process.env) {
  const real = Math.max(0, Math.floor(num(input.real_pairs ?? input.examples_real ?? input.rows, 0)));
  const synthetic = Math.max(0, Math.floor(num(input.synthetic_pairs ?? input.examples_synthetic, 0)));
  const holdout = Math.max(0, Math.floor(num(input.holdout_pairs ?? input.holdout, Math.floor((real + synthetic) * 0.2))));
  const preference = Math.max(0, Math.floor(num(input.preference_pairs ?? input.ranked_pairs, 0)));
  const teacherModels = Array.isArray(input.teachers) ? input.teachers.map(String).filter(Boolean) : teachersFromEnv(env);
  const access = teacherAccess(input, teacherModels);
  return {
    task: normalizeTask(input.task || input.task_type),
    namespace: clean(input.namespace || input.name, 'default'),
    base_model: clean(input.base_model || input.model, 'Qwen/Qwen2.5-7B-Instruct'),
    privacy: normalizePrivacy(input.privacy || input.privacy_mode),
    real_pairs: real,
    synthetic_pairs: synthetic,
    holdout_pairs: holdout,
    preference_pairs: preference,
    label_noise: Math.max(0, Math.min(1, num(input.label_noise, 0.05))),
    teacher_agreement: Math.max(0, Math.min(1, num(input.teacher_agreement, 0.8))),
    repeat_rate: Math.max(0, Math.min(1, num(input.repeat_rate, 0.2))),
    target_latency_ms: Math.max(1, num(input.target_latency_ms ?? input.latency_ms, 120)),
    budget_usd: Math.max(0, num(input.budget_usd ?? input.budget, 0)),
    existing_artifact: truthy(input.existing_artifact) || input.existing_artifact === true,
    teacher_local: input.teacher_local === true || input.local_teacher === true || input.teacher_logits === true,
    teachers: teacherModels,
    teacher_classes: access.classes,
    teacher_access: access,
    moe: moeProfileFrom(input, teacherModels),
  };
}

function commandFor(strategy, profile) {
  const ns = clean(profile.namespace, 'default');
  const base = clean(profile.base_model, 'Qwen/Qwen2.5-7B-Instruct');
  if (strategy.command_kind === 'runtime-policy') return `kolm optimize list --namespace ${ns} --json`;
  if (strategy.command_kind === 'train-plan') return `kolm train plan ${ns} --json`;
  if (strategy.command_kind === 'cloud-train') return `kolm cloud train ${ns} --base ${base}`;
  if (strategy.command_kind === 'distill') return `kolm distill --namespace ${ns} --base-model ${base} --mode ${strategy.id}`;
  if (strategy.command_kind === 'ropd-blackbox') return `kolm distill onpolicy --ropd --namespace ${ns}`;
  if (strategy.command_kind === 'gad-blackbox') return `kolm distill onpolicy --gad --namespace ${ns}`;
  if (strategy.command_kind === 'onpolicy-gkd') return `kolm distill onpolicy train --namespace ${ns} --pairs <pairs.jsonl> --student <student-path> --teacher <local-teacher>`;
  if (strategy.command_kind === 'local-worker-objective') return `kolm distill --local-worker --mode full --teacher-local --objective=${strategy.objective} --spec <spec.json> --seeds <pairs.jsonl> --out <out-dir>`;
  if (strategy.command_kind === 'moe-distill') return `kolm distill moe-to-dense --pipeline --namespace ${ns} --teacher ${clean(profile.moe.teacher_model, 'local-moe-teacher')} --student-base ${base} --checkpoint <moe-checkpoint> --router-stats <router-stats.json> --pairs <pairs.jsonl> --holdout <holdout.jsonl> --out <moe-recovery-run-dir>`;
  if (strategy.command_kind === 'cot-distill') return `kolm distill --namespace ${ns} --reasoning-trace-loss-weight 0.2`;
  if (strategy.command_kind === 'preference') return `kolm distill preference --namespace ${ns} --objective dpo`;
  if (strategy.command_kind === 'onpolicy') return `kolm distill onpolicy --namespace ${ns}`;
  if (strategy.command_kind === 'spec-decode') return `kolm spec-decode train --namespace ${ns} --base-model ${base}`;
  return null;
}

function scoreStrategy(strategy, profile) {
  const blockers = [];
  if (!strategy.privacy.includes(profile.privacy)) blockers.push(`privacy_mode_${profile.privacy}_not_allowed`);
  if (profile.real_pairs < strategy.min_real_pairs) blockers.push(`real_pairs_below_min:${profile.real_pairs}<${strategy.min_real_pairs}`);
  if (profile.holdout_pairs < strategy.min_holdout_pairs) blockers.push(`holdout_pairs_below_min:${profile.holdout_pairs}<${strategy.min_holdout_pairs}`);
  if ((strategy.min_preference_pairs || 0) > profile.preference_pairs) blockers.push(`preference_pairs_below_min:${profile.preference_pairs}<${strategy.min_preference_pairs}`);
  if (strategy.teacher_required && !profile.teachers.length) blockers.push('teacher_not_configured');
  if (strategy.requires_teacher_logits && !profile.teacher_access.has_teacher_logits) blockers.push('teacher_logits_required');
  if (strategy.requires_moe && !profile.moe.has_moe_signal) blockers.push('moe_teacher_or_base_required');
  if (profile.synthetic_pairs > 0 && profile.real_pairs === 0 && strategy.family !== 'data' && strategy.id !== 'rule_or_cache_first') blockers.push('synthetic_only_not_trainable');
  const feasible = blockers.length === 0;
  let score = 0;
  if (feasible) score += 50;
  if (strategy.best_for.includes(profile.task)) score += 16;
  if (profile.task === 'redaction' && strategy.id === 'rule_or_cache_first') score += 18;
  if (profile.task === 'generation' && strategy.id === 'kd_softmax') score += profile.teacher_access.text_only ? -20 : 14;
  if (profile.task === 'extraction' && strategy.id === 'lora_sft') score += 12;
  if (profile.label_noise >= 0.18 && strategy.id === 'rejection_sampling') score += 18;
  if (profile.teacher_agreement < 0.65 && strategy.id === 'rejection_sampling') score += 12;
  if (profile.teacher_access.text_only && strategy.id === 'gad') score += 45;
  if (profile.teacher_access.text_only && strategy.id === 'ropd') score += 32;
  if (profile.teacher_access.text_only && strategy.id === 'rejection_sampling') score += 8;
  if (profile.teacher_access.has_open_weights_teacher && strategy.id === 'gkd_onpolicy') score += 24;
  if (profile.teacher_access.has_open_weights_teacher && strategy.id === 'distillm2') score += 14;
  if (profile.teacher_access.has_open_weights_teacher && strategy.id === 'bond_jeffreys') score += 13;
  if (profile.teacher_access.has_open_weights_teacher && strategy.id === 'reverse_kl_minillm') score += 12;
  if (profile.teacher_agreement < 0.7 && strategy.id === 'bond_jeffreys') score += 8;
  if (strategy.id === 'moe_to_dense_distill') {
    if (profile.moe.teacher_is_moe) score += 48;
    if (profile.moe.base_is_moe) score += 22;
    if (profile.teacher_access.has_open_weights_teacher) score += 10;
    if (profile.task === 'reasoning') score += 10;
  }
  if (profile.task === 'reasoning' && strategy.id === 'cot_distill') score += 30;
  if (profile.task === 'reasoning' && strategy.id === 'gad') score += 12;
  if (profile.task === 'reasoning' && strategy.id === 'ropd') score += 10;
  if (profile.preference_pairs >= 50 && strategy.id === 'preference_optimization') score += 22;
  if (profile.existing_artifact && strategy.id === 'onpolicy_distill') score += 16;
  if (profile.existing_artifact && strategy.id === 'gad') score += 12;
  if (profile.existing_artifact && strategy.id === 'ropd') score += 10;
  if (profile.repeat_rate >= 0.45 && strategy.id === 'rule_or_cache_first') score += 16;
  if (profile.target_latency_ms <= 60 && strategy.id === 'speculative_decoding_train') score += 14;
  if (profile.budget_usd > 0 && ['kd_softmax', 'speculative_decoding_train', 'gad', 'ropd'].includes(strategy.id)) score -= 5;
  if (!feasible) score -= blockers.length * 10;
  if (strategy.family === 'data' && (profile.real_pairs < 50 || profile.holdout_pairs < 10)) score += 30;
  const command = feasible ? commandFor(strategy, profile) : null;
  return {
    id: strategy.id,
    label: strategy.label,
    family: strategy.family,
    score,
    feasible,
    blockers,
    command,
    teacher_required: strategy.teacher_required,
    requires_teacher_logits: strategy.requires_teacher_logits === true,
    execution_status: strategy.execution_status || 'available',
    privacy_modes: strategy.privacy,
    best_for: strategy.best_for,
    references: strategy.references || [],
  };
}

export function distillStrategyCatalog() {
  return {
    spec: 'kolm-distill-strategy/1',
    tasks: TASKS.slice(),
    privacy_modes: PRIVACY_MODES.slice(),
    strategies: STRATEGIES.map((s) => ({
      id: s.id,
      label: s.label,
      family: s.family,
      min_real_pairs: s.min_real_pairs,
      min_holdout_pairs: s.min_holdout_pairs,
      min_preference_pairs: s.min_preference_pairs || 0,
      teacher_required: s.teacher_required,
      requires_teacher_logits: s.requires_teacher_logits === true,
      requires_moe: s.requires_moe === true,
      execution_status: s.execution_status || 'available',
      privacy_modes: s.privacy,
      best_for: s.best_for,
      references: s.references || [],
    })),
  };
}

export function planDistillStrategy(input = {}, env = process.env) {
  const profile = profileFrom(input, env);
  const ranked = STRATEGIES
    .map((s) => scoreStrategy(s, profile))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  const recommendation = ranked.find((r) => r.feasible) || ranked[0] || null;
  const nextActions = [];
  if (recommendation?.command) {
    nextActions.push({ kind: 'command', label: 'Run recommended strategy', value: recommendation.command });
  }
  if (ranked.some((r) => r.blockers.includes('teacher_not_configured'))) {
    nextActions.push({ kind: 'configure', label: 'Configure a teacher or local model', value: 'env:ANTHROPIC_API_KEY|OPENAI_API_KEY|KOLM_LOCAL_TEACHER_URL' });
  }
  if (profile.real_pairs < 50 || profile.holdout_pairs < 10) {
    nextActions.push({ kind: 'collect', label: 'Capture and approve more real examples', value: `kolm label next --namespace ${profile.namespace}` });
  }
  return {
    ok: !!recommendation?.feasible,
    spec: 'kolm-distill-strategy/1',
    profile,
    recommendation,
    ranked,
    next_actions: nextActions,
    secret_values_included: false,
  };
}

export default {
  distillStrategyCatalog,
  planDistillStrategy,
};
