// kolm compile orchestrator.
//
// `kolm compile <task>` is the one user-facing primitive. Beneath it, four
// engines participate: Recall (multimodal substrate), Distill (verified
// inference labels), Decompose (recipe pack), Run (artifact bundling).
//
// Wave 282 - every build path now routes through `src/spec-compile.js`. The
// pre-W282 pipeline synthesized fake eval cases from the task description
// when the caller provided no examples and shipped the resulting artifact
// with an essentially-meaningless K-score. Per audit finding C1 that path
// is closed: compile without positive examples is a structured failure.
// The single canonical build path is compileSpec (which delegates to the
// signed zip writer internally).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, findOne, insert, update } from './store.js';
import { compileSpec } from './spec-compile.js';
import { prepareSeedSplit, hashSeeds } from './seeds.js';
import { TEMPLATES as CHAT_TEMPLATES, pickTemplate, manifestBlock } from './chat-templates.js';
import { DEFAULT_MODEL } from './models.js';

// W234 - resolve the chat_template block that gets stamped into the artifact
// manifest. Callers can either name a template explicitly (chat_template) or
// rely on inference from the base_model name. thinking_mode is a per-job
// override that opts in to (or out of) the qwen-3-thinking scratchpad even
// when the template would otherwise default the other way.
function resolveChatTemplateBlock({ chat_template, base_model, thinking_mode }) {
  let name = null;
  if (chat_template && typeof chat_template === 'string' && CHAT_TEMPLATES[chat_template]) {
    name = chat_template;
  } else if (base_model) {
    const picked = pickTemplate(base_model);
    name = picked && picked.name;
  }
  if (!name) name = 'plain';
  const overrides = (typeof thinking_mode === 'boolean') ? { thinking: thinking_mode } : {};
  return manifestBlock(name, overrides);
}

const JOBS = new Map(); // in-memory; persists in `compile_jobs` table

function ensureJobsTable() {
  if (!Array.isArray(all('compile_jobs'))) {
    insert('compile_jobs', { id: '__bootstrap__', _bootstrap: true });
    update('compile_jobs', x => x.id === '__bootstrap__', { _deleted: true });
  }
}

const VALID_PRESETS = new Set([
  'sft',            // plain SFT
  'lora-fast',      // Unsloth-style fast LoRA (default)
  'long-context',   // YaRN/NTK/Linear PI
  'vlm',            // Qwen2.5-VL frozen vision tower
  'merge-adapters', // SLERP/TIES/DARE
  'embed',          // InfoNCE + Matryoshka
  'fc-tools',       // function-calling SFT (Hermes-FC)
  'grpo-reasoning', // verifiable-reward online RL
  'instant',        // TAID-inspired zero-shot
]);

const VALID_RECIPE_CLASSES = new Set(['rule', 'synthesized_rule', 'compiled_rule', 'distilled_model']);
const VALID_OUTPUT_TARGETS = new Set(['gguf', 'onnx', 'safetensors', 'coreml', 'mlx', 'executorch', 'tensorrt', 'native-c', 'native-rust', 'wasm']);
const VALID_MULTI_DEVICE = new Set(['phone-ios', 'phone-android', 'laptop-cpu', 'browser-wasm', 'edge-jetson', 'server-cuda']);

// W716-3 - Mixture-of-Experts recipe scaffold.
//
// Emits a kolm.yaml-style block from an arch spec produced by
// src/student-arch-recommender.js#recommendArch. Gated behind
// KOLM_ENABLE_MOE because the recipe ships before the full mixture
// trainer does - production_ready:false is stamped on the output so
// downstream code can refuse to ship until the trainer lands.
//
// Honest contract:
//   - arch_spec without moe block       -> { ok:false, error:'arch_not_moe' }
//   - KOLM_ENABLE_MOE not set            -> { ok:true, gated:true, ... }
//   - otherwise                          -> full recipe block, gated:false
export const MOE_RECIPE_VERSION = 'w716-v1';

export function buildMoeRecipe(arch_spec) {
  if (!arch_spec || typeof arch_spec !== 'object') {
    return {
      ok: false,
      error: 'arch_spec_required',
      version: MOE_RECIPE_VERSION,
    };
  }
  const moe = arch_spec.moe;
  if (!moe || typeof moe !== 'object') {
    return {
      ok: false,
      error: 'arch_not_moe',
      hint: 'recommender returned a dense arch (no .moe block); MoE recipe inapplicable.',
      version: MOE_RECIPE_VERSION,
    };
  }
  const numExperts = Number(moe.num_experts) || 8;
  const topK = Number(moe.top_k) || 3;
  const specialization = Array.isArray(moe.expert_specialization)
    ? moe.expert_specialization.slice()
    : ['tool_call', 'reasoning', 'general'];
  const capacityFactor = Number(moe.capacity_factor) || 1.25;
  const routing = String(moe.routing || 'switch-transformer-top-k');
  const gated = process.env.KOLM_ENABLE_MOE
    ? !/^(1|true|yes|on)$/i.test(String(process.env.KOLM_ENABLE_MOE))
    : true;

  // yaml-style block (string + structured both - caller picks the form
  // they want to thread into the spec).
  const yamlBlock =
    'recipe:\n' +
    '  kind: moe\n' +
    '  version: ' + MOE_RECIPE_VERSION + '\n' +
    '  routing: ' + routing + '\n' +
    '  num_experts: ' + numExperts + '\n' +
    '  top_k: ' + topK + '\n' +
    '  capacity_factor: ' + capacityFactor + '\n' +
    '  expert_specialization:\n' +
    specialization.map((s) => '    - ' + s).join('\n') + '\n' +
    '  base_dense_geometry:\n' +
    '    family: ' + (arch_spec.family || 'unknown') + '\n' +
    '    depth: ' + (Number(arch_spec.depth) || 0) + '\n' +
    '    hidden_dim: ' + (Number(arch_spec.hidden_dim) || 0) + '\n' +
    '    num_attention_heads: ' + (Number(arch_spec.num_attention_heads) || 0) + '\n' +
    '  production_ready: false   # W716-3 - recipe scaffold; trainer pending\n';

  return {
    ok: true,
    gated,
    version: MOE_RECIPE_VERSION,
    production_ready: false,
    recipe: {
      kind: 'moe',
      version: MOE_RECIPE_VERSION,
      routing,
      num_experts: numExperts,
      top_k: topK,
      capacity_factor: capacityFactor,
      expert_specialization: specialization,
      base_dense_geometry: {
        family: arch_spec.family || 'unknown',
        depth: Number(arch_spec.depth) || 0,
        hidden_dim: Number(arch_spec.hidden_dim) || 0,
        num_attention_heads: Number(arch_spec.num_attention_heads) || 0,
      },
    },
    yaml: yamlBlock,
    hint: gated
      ? 'MoE recipe scaffold emitted; set KOLM_ENABLE_MOE=1 + install the mixture trainer to actually train.'
      : 'MoE recipe scaffold emitted; trainer integration is still W716-future.',
  };
}

function clampRank(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 16;
  if (v < 4) return 4;
  if (v > 64) return 64;
  return Math.round(v);
}

function clampThreshold(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0.85;
  if (v < 0.50) return 0.50;
  if (v > 0.99) return 0.99;
  return Math.round(v * 100) / 100;
}

export function createJob({
  task, examples, corpus_namespace, base_model,
  tenant, tenant_id, deploy_hook,
  preset, lora_rank, k_threshold,
  chat_template, thinking_mode,
  recipe_class, hw_tier, output_target, multi_device,
  distill_mode,
  allow_below_gate,
}) {
  ensureJobsTable();
  const id = 'job_' + crypto.randomBytes(6).toString('hex');
  const envHook = process.env.KOLM_DEPLOY_HOOK_URL || '';
  const rawHook = typeof deploy_hook === 'string' && deploy_hook ? deploy_hook : envHook;
  const hook = /^https:\/\//i.test(rawHook) ? rawHook : null;
  const chatBlock = resolveChatTemplateBlock({ chat_template, base_model, thinking_mode });
  const job = {
    id,
    tenant,
    tenant_id: tenant_id || null,
    task: typeof task === 'string' ? task : JSON.stringify(task),
    examples_n: Array.isArray(examples) ? examples.length : 0,
    corpus_namespace: corpus_namespace || null,
    base_model: base_model || 'none',
    recipe_class: VALID_RECIPE_CLASSES.has(recipe_class) ? recipe_class : null,
    preset: preset && VALID_PRESETS.has(preset) ? preset : 'lora-fast',
    lora_rank: clampRank(lora_rank),
    k_threshold: clampThreshold(k_threshold),
    hw_tier: typeof hw_tier === 'string' && hw_tier ? hw_tier : null,
    output_target: VALID_OUTPUT_TARGETS.has(output_target) ? output_target : null,
    multi_device: Array.isArray(multi_device)
      ? multi_device.filter((d) => VALID_MULTI_DEVICE.has(d)).slice(0, 6)
      : [],
    distill_mode: typeof distill_mode === 'string' ? distill_mode : null,
    chat_template: chatBlock,
    thinking_mode: typeof thinking_mode === 'boolean' ? thinking_mode : chatBlock.thinking,
    allow_below_gate: allow_below_gate === true,
    deploy_hook: hook,
    deploy_status: hook ? 'pending' : 'skipped',
    deploy_attempted_at: null,
    deploy_response_code: null,
    status: 'queued',
    progress: 0,
    stages: [],
    artifact_path: null,
    artifact_bytes: null,
    manifest: null,
    error: null,
    created_at: new Date().toISOString(),
  };
  insert('compile_jobs', job);
  JOBS.set(id, job);
  return job;
}

export function getJob(id, tenant) {
  ensureJobsTable();
  const j = findOne('compile_jobs', x => x.id === id && !x._deleted);
  if (!j) return null;
  if (tenant && j.tenant !== tenant) return null;
  return j;
}

export function listJobs(tenant, limit = 25) {
  ensureJobsTable();
  return all('compile_jobs')
    .filter(j => !j._deleted && (!tenant || j.tenant === tenant))
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    .slice(0, limit);
}

function setStage(job, name, payload = {}) {
  const stage = { name, at: new Date().toISOString(), ...payload };
  job.stages = [...(job.stages || []), stage];
  update('compile_jobs', x => x.id === job.id, { stages: job.stages });
  JOBS.set(job.id, job);
}

function setStatus(job, status, patch = {}) {
  Object.assign(job, { status }, patch);
  update('compile_jobs', x => x.id === job.id, { status, ...patch });
  JOBS.set(job.id, job);
}

function normalizeKScore(kScore) {
  if (typeof kScore === 'number') return kScore;
  if (kScore && typeof kScore.composite === 'number') return kScore.composite;
  return null;
}

function completionPatch(job, built, composite, extra = {}) {
  return {
    progress: 100,
    artifact_path: built.outPath,
    artifact_bytes: built.bytes,
    manifest: built.manifest,
    receipt: built.manifest?.receipt || null,
    artifact_hash: built.manifest?.hashes?.artifact_hash || built.manifest?.artifact_hash || null,
    cid: built.manifest?.cid || null,
    eval_set_hash: built.manifest?.hashes?.evals || null,
    k_score: composite,
    k_score_envelope: built.k_score,
    evals_summary: built.manifest?.evals
      ? { total: built.manifest.evals.n || 0, source: 'seeds.jsonl holdout' }
      : { total: 0, source: 'none' },
    seed_provenance: built.manifest?.seed_provenance || null,
    completed_at: new Date().toISOString(),
    ...extra,
  };
}

async function sendDeployHook(job, built, composite) {
  if (!job.deploy_hook) return;
  const payload = JSON.stringify({
    job_id: job.id,
    artifact_url: `/v1/compile/${job.id}/.kolm`,
    artifact_hash: built.manifest?.hashes?.artifact_hash || built.manifest?.artifact_hash || null,
    cid: built.manifest?.cid || null,
    k_score: composite || null,
    base_model: job.base_model,
    completed_at: job.completed_at,
  });
  try {
    const r = await fetch(job.deploy_hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'kolm-compile/1' },
      body: payload,
    });
    update('compile_jobs', x => x.id === job.id, {
      deploy_status: r.ok ? 'sent' : 'failed',
      deploy_response_code: r.status,
      deploy_attempted_at: new Date().toISOString(),
    });
  } catch (e) {
    update('compile_jobs', x => x.id === job.id, {
      deploy_status: 'failed',
      deploy_response_code: null,
      deploy_attempted_at: new Date().toISOString(),
    });
  }
}

function trainRowsToDistillPairs(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, i) => ({
    event_id: (row.metadata && row.metadata.id) ? String(row.metadata.id) : `compile_train_${i + 1}`,
    prompt: row.input,
    response: row.expected,
  }));
}

function holdoutRowsToDistillPairs(rows) {
  return (Array.isArray(rows) ? rows : []).map((row, i) => ({
    event_id: (row.metadata && row.metadata.id) ? String(row.metadata.id) : `compile_holdout_${i + 1}`,
    prompt: row.input,
    response: row.expected ?? row.output,
  })).filter((p) => p.prompt != null && p.response != null);
}

function finiteMetric(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readJsonIfExists(p) {
  try {
    if (p && fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {} // deliberate: cleanup
  return null;
}

function resolvePortableWeight(studentPath) {
  if (!studentPath || !fs.existsSync(studentPath)) return null;
  const pick = (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.gguf', '.onnx', '.wasm'].includes(ext)) return null;
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size <= 0) return null;
    if (ext === '.gguf') {
      return { path: filePath, runtime_target: 'gguf', runtime_target_config: { gguf_path: 'model.gguf' }, recipe_field: 'gguf_file' };
    }
    if (ext === '.onnx') {
      return { path: filePath, runtime_target: 'onnx', runtime_target_config: { onnx_path: 'model.onnx' }, recipe_field: 'onnx_file' };
    }
    return { path: filePath, runtime_target: 'wasm', runtime_target_config: {}, recipe_field: 'weights_file' };
  };
  const st = fs.statSync(studentPath);
  if (st.isFile()) return pick(studentPath);
  if (!st.isDirectory()) return null;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const abs = path.join(studentPath, rel);
    for (const name of fs.readdirSync(abs)) {
      const childRel = path.join(rel, name);
      const childAbs = path.join(studentPath, childRel);
      const childSt = fs.statSync(childAbs);
      if (childSt.isDirectory()) {
        if (childRel.split(/[\\/]/).length < 4) stack.push(childRel);
        continue;
      }
      const picked = pick(childAbs);
      if (picked) return picked;
    }
  }
  return null;
}

async function runNeuralDistillForCompile(job, ctx, trainRows, holdoutRows = []) {
  const pairs = trainRowsToDistillPairs(trainRows);
  const holdoutPairs = holdoutRowsToDistillPairs(holdoutRows);
  const studentBase = job.base_model && job.base_model !== 'none' ? job.base_model : DEFAULT_MODEL;
  const distillFn = typeof ctx.distill === 'function'
    ? ctx.distill
    : (await import('./distill-pipeline.js')).distill;
  let done = null;
  for await (const ev of distillFn({
    student_base: studentBase,
    pairs_override: pairs,
    holdout_override: holdoutPairs,
    train_from_pairs: true,
    portable_export: job.output_target || 'gguf',
    export_quant: process.env.KOLM_COMPILE_NEURAL_EXPORT_QUANT || 'Q4_K_M',
    export_skip_coherence: /^(1|true|yes|on)$/i.test(String(process.env.KOLM_COMPILE_NEURAL_EXPORT_SKIP_COHERENCE || '')),
    teacher_fallback: false,
    pipeline_mode: job.distill_mode || 'kd_softmax',
    max_steps: Math.max(1, Math.min(Number(process.env.KOLM_COMPILE_NEURAL_MAX_STEPS) || pairs.length || 200, pairs.length || 200)),
    emit_progress_every: 0,
    tenant_id: job.tenant_id || job.tenant || 'local',
  })) {
    if (ev && ev.done) done = ev;
  }
  if (!done) {
    return {
      ok: false,
      code: 'KOLM_E_NEURAL_DISTILL_NO_RESULT',
      error: 'neural_compile_failed: distill worker produced no done event',
      holdoutEvalCount: holdoutPairs.length,
    };
  }
  const manifest = done.manifest || readJsonIfExists(done.artifact_path ? path.join(done.artifact_path, 'manifest.json') : null);
  if (!manifest || manifest.ml_pipeline_run !== true || !done.student_path) {
    return {
      ok: false,
      code: 'KOLM_E_NEURAL_TRAINING_NOT_RUN',
      error: 'neural_compile_failed: recipe_class=distilled_model requires the Python ML worker to run (manifest.ml_pipeline_run=true) and produce a student_path; collect/stub runs are not signed as distilled_model artifacts.',
      done,
      manifest,
      holdoutEvalCount: holdoutPairs.length,
    };
  }
  const studentHoldout = finiteMetric(
    manifest.student_holdout_accuracy,
    manifest.holdout_accuracy,
    manifest.k_score_final,
    manifest.k_score,
  );
  if (studentHoldout == null) {
    return {
      ok: false,
      code: 'KOLM_E_NEURAL_HOLDOUT_EVAL_MISSING',
      error: 'neural_compile_failed: trained student has no measured holdout metric (student_holdout_accuracy/holdout_accuracy/k_score_final). Run the student holdout eval before signing a distilled_model artifact.',
      done,
      manifest,
      holdoutEvalCount: holdoutPairs.length,
    };
  }
  const portableWeight = resolvePortableWeight(done.student_path);
  if (!portableWeight) {
    return {
      ok: false,
      code: 'KOLM_E_NEURAL_PORTABLE_WEIGHTS_MISSING',
      error: 'neural_compile_failed: trained student exists but no portable .gguf/.onnx/.wasm weight file was found; export/quantize the student before signing a distilled_model artifact.',
      done,
      manifest,
      holdoutEvalCount: holdoutPairs.length,
    };
  }
  return { ok: true, done, manifest, portableWeight, studentBase, studentHoldout, holdoutEvalCount: holdoutPairs.length };
}

// Slug a free-text task description into a valid recipe id.
function slugify(s) {
  return (s || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'synthesized';
}

// Run the orchestrator. Fire-and-forget on long-running nodes; awaited on
// serverless. Wave 282 - every successful path produces an artifact via
// `compileSpec` (the same code that `kolm compile --spec -` runs). There is
// no longer a "synthesize-and-zip without a real eval set" branch - the spec-compile
// seed gate is the only build path.
export async function runJob(job, ctx) {
  try {
    setStatus(job, 'running', { progress: 5 });

    // Stage 1 - Recall.
    setStage(job, 'recall.start');
    let recall_chunks = [];
    if (ctx.recall && job.corpus_namespace) {
      try {
        recall_chunks = await ctx.recall.query({
          namespace: job.corpus_namespace, query: job.task, k: 12,
        });
      } catch (e) { setStage(job, 'recall.error', { error: String(e.message || e) }); }
    }
    setStage(job, 'recall.done', { chunks_n: recall_chunks.length });
    setStatus(job, 'running', { progress: 25 });

    // Wave 282 no-seeds refusal. Pre-W282 a compile with empty examples
    // synthesized fake test cases from the task description and shipped a
    // 0.98+ K-score artifact whose accuracy was measured against the
    // recipe's own outputs. Per audit C1 that is a stub artifact; refuse.
    const examples = Array.isArray(ctx.examples) ? ctx.examples : [];
    const positives = examples.filter(e => e && e.kind !== 'negative');
    const negatives = examples.filter(e => e && e.kind === 'negative');
    if (positives.length === 0) {
      setStatus(job, 'failed', {
        error: 'no_seeds_provided: compile refused - at least one positive example (an {input, output} pair) is required so the artifact has a real evaluation set. Pre-Wave-282 builds synthesized fake eval cases from the task description; that path is closed.',
        error_code: 'KOLM_E_NO_SEEDS',
        progress: 25,
        failed_at: new Date().toISOString(),
      });
      return;
    }

    // Wave 283 - split the seeds BEFORE synthesis so the teacher only ever
    // sees train rows. Pre-W283 we passed every positive to ctx.synthesize,
    // which meant the holdout the K-score later measured against had been
    // seen at recipe-construction time - a textbook leakage and a real
    // audit finding. Now we write seeds.jsonl first, run prepareSeedSplit
    // deterministically (same split_seed compileSpec will use later), and
    // feed only `train` to synthesis. The manifest carries
    // `synthesis_input_hash` so an external auditor can prove the policy.
    const outDir = ctx.outDir || path.join(os.tmpdir(), 'kolm-artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const seedsDir = path.join(outDir, 'seeds-' + job.id);
    fs.mkdirSync(seedsDir, { recursive: true });
    const seedsPath = path.join(seedsDir, 'seeds.jsonl');
    const seedRows = positives.map((e) => {
      const row = { input: e.input, expected: e.output ?? e.expected };
      if (e.id) row.metadata = { id: String(e.id) };
      if (Array.isArray(e.tags) && e.tags.length) {
        row.tags = e.tags.slice();
      }
      return row;
    });
    fs.writeFileSync(seedsPath, seedRows.map(r => JSON.stringify(r)).join('\n') + '\n');

    let preSplit = null;
    try {
      preSplit = prepareSeedSplit({ seedsPath });
    } catch (e) {
      setStage(job, 'split.error', { error: String(e.message || e) });
    }
    const trainForSynthesis = preSplit && Array.isArray(preSplit.train) && preSplit.train.length > 0
      ? preSplit.train
      : seedRows; // single-row corner case: split has empty train, fall back
    const holdoutForEval = preSplit && Array.isArray(preSplit.holdout) ? preSplit.holdout : [];
    const synthesisInputHash = hashSeeds(trainForSynthesis);
    setStage(job, 'split.done', {
      train_count: preSplit?.train_count ?? trainForSynthesis.length,
      holdout_count: preSplit?.holdout_count ?? 0,
      synthesis_input_hash: synthesisInputHash,
    });

    // W960 - explicit neural compile lane. A caller who asks for
    // recipe_class='distilled_model' should never silently receive a JS rule
    // artifact. The lane delegates to the same Python-backed distill worker
    // used by `kolm distill`, feeds only the pre-split TRAIN rows, and signs
    // a distilled_model artifact only after all three proofs exist:
    //   1. manifest.ml_pipeline_run=true (real Python ML worker ran)
    //   2. measured student holdout metric
    //   3. portable weight file (.gguf/.onnx/.wasm) bundled into .kolm
    if (job.recipe_class === 'distilled_model') {
      setStage(job, 'distill.neural.start', {
        student_base: job.base_model && job.base_model !== 'none' ? job.base_model : DEFAULT_MODEL,
        train_count: trainForSynthesis.length,
        holdout_eval_count: holdoutForEval.length,
      });
      const neural = await runNeuralDistillForCompile(job, ctx, trainForSynthesis, holdoutForEval);
      setStage(job, 'distill.neural.done', {
        ok: !!neural.ok,
        worker_mode: neural.done?.worker_mode || neural.manifest?.mode || null,
        ml_pipeline_run: neural.manifest?.ml_pipeline_run === true,
        student_path: neural.done?.student_path || null,
        portable_weight: neural.portableWeight?.path || null,
        portable_export_ok: neural.manifest?.portable_export?.ok ?? null,
        student_holdout_accuracy: neural.studentHoldout ?? null,
        holdout_eval_count: neural.holdoutEvalCount ?? holdoutForEval.length,
        error_code: neural.code || null,
      });
      if (!neural.ok) {
        try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
        setStatus(job, 'failed', {
          error: neural.error,
          error_code: neural.code,
          progress: 50,
          failed_at: new Date().toISOString(),
          neural_compile: {
            requested: true,
            worker_mode: neural.done?.worker_mode || neural.manifest?.mode || null,
            ml_pipeline_run: neural.manifest?.ml_pipeline_run === true,
            student_path: neural.done?.student_path || null,
            portable_export: neural.manifest?.portable_export || null,
            holdout_eval_count: holdoutForEval.length,
          },
        });
        return;
      }

      setStatus(job, 'running', { progress: 70 });
      setStage(job, 'package.start', {
        artifact_class: 'distilled_model',
        runtime_target: neural.portableWeight.runtime_target,
      });
      const synthName = slugify(job.task || 'task');
      const recipeId = 'rcp_distilled_' + job.id;
      const distillTrainingStats = {
        distill_compile: true,
        pass_rate_positive: neural.studentHoldout,
        holdout_accuracy: neural.studentHoldout,
        student_holdout_accuracy: neural.studentHoldout,
        teacher_holdout_accuracy: finiteMetric(neural.manifest.teacher_holdout_accuracy),
        teacher_vendor: neural.manifest.teacher_vendor || null,
        teacher_model: neural.manifest.teacher_model || null,
        teacher_version: neural.manifest.teacher_version || null,
        student_base: neural.manifest.student_base || neural.studentBase,
        distillation_method: neural.manifest.distillation_method || 'lora',
        ml_pipeline_run: true,
        training_pairs_collected: neural.manifest.training_pairs_collected || null,
        holdout_eval_count: neural.holdoutEvalCount ?? holdoutForEval.length,
        training_pairs_hash: neural.manifest.training_pairs_hash || null,
        synthesis_input_hash: synthesisInputHash,
      };
      const weightField = neural.portableWeight.recipe_field;
      const spec = {
        job_id: job.id,
        task: job.task,
        base_model: neural.manifest.student_base || neural.studentBase,
        recipes: [{
          id: recipeId,
          name: synthName,
          source: 'function generate(input, lib){ return input.__kolm_distilled_model_runtime_required(); }',
          version_id: `ver_distilled_${job.id}`,
          class: 'distilled_model',
          source_type: 'distilled',
          tags: ['compiled', 'distilled'],
          [weightField]: neural.portableWeight.path,
        }],
        artifact_class: 'distilled_model',
        training_stats: distillTrainingStats,
      };

      let built;
      try {
        built = await compileSpec(spec, {
          seedsPath,
          outDir,
          useSeedsGate: true,
          allow_below_gate: job.allow_below_gate === true,
          distillProvenancePath: neural.done.artifact_path,
          modelWeightsPath: neural.portableWeight.path,
          runtime_target: neural.portableWeight.runtime_target,
          runtime_target_config: neural.portableWeight.runtime_target_config,
        });
      } catch (e) {
        setStatus(job, 'failed', {
          error: 'compile_failed: ' + String(e.message || e),
          error_code: 'KOLM_E_COMPILE',
          progress: 80,
          failed_at: new Date().toISOString(),
        });
        try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
        return;
      }
      const composite = normalizeKScore(built.k_score);
      setStage(job, 'package.done', { bytes: built.bytes, k_score: composite, artifact_class: 'distilled_model' });
      const threshold = typeof job.k_threshold === 'number' ? job.k_threshold : 0.85;
      if (typeof composite === 'number' && composite < threshold) {
        setStatus(job, 'failed', {
          error: `k_score ${composite.toFixed(3)} below threshold ${threshold.toFixed(2)} - no artifact shipped`,
          error_code: 'KOLM_E_K_SCORE_BELOW_THRESHOLD',
          k_score: composite,
          artifact_path: null,
          artifact_bytes: null,
          failed_at: new Date().toISOString(),
        });
        try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
        return;
      }
      setStatus(job, 'completed', completionPatch(job, built, composite, {
        concept_id: null,
        version_id: null,
        neural_compile: {
          requested: true,
          worker_mode: neural.done.worker_mode,
          ml_pipeline_run: true,
          student_path: neural.done.student_path,
          portable_weight_path: neural.portableWeight.path,
          runtime_target: neural.portableWeight.runtime_target,
          portable_export: neural.manifest?.portable_export || null,
          student_holdout_accuracy: neural.studentHoldout,
          holdout_eval_count: neural.holdoutEvalCount ?? holdoutForEval.length,
        },
      }));
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
      await sendDeployHook(job, built, composite);
      return;
    }

    // Stage 2 - Distill: synthesize a JS recipe from the train slice only.
    setStage(job, 'distill.start');
    let synthesis_result = null;
    try {
      const norm = (e) => ({
        input: e.input,
        expected: e.expected ?? e.output,
        metadata: e.metadata || null,
      });
      synthesis_result = await ctx.synthesize({
        positives: trainForSynthesis.map(norm),
        negatives: negatives.map((e) => ({ ...e, expected: e.expected ?? e.output })),
        priors: {},
      });
    } catch (e) { setStage(job, 'distill.error', { error: String(e.message || e) }); }
    setStage(job, 'distill.done', {
      accepted: !!synthesis_result?.accepted,
      pass_rate: synthesis_result?.pass_rate_positive ?? null,
    });

    if (!synthesis_result || !synthesis_result.accepted || !synthesis_result.source) {
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
      setStatus(job, 'failed', {
        error: 'recipe_synthesis_failed: could not synthesize a recipe from the provided examples that passes the quality gate. Add more examples or sharpen the input/output pairs.',
        error_code: 'KOLM_E_RECIPE_SYNTHESIS_FAILED',
        progress: 50,
        failed_at: new Date().toISOString(),
      });
      return;
    }
    setStatus(job, 'running', { progress: 60 });

    // Stage 3 - Decompose: register the synthesized recipe as a real
    // concept so the caller can POST /v1/recipes/{id}/run against their
    // freshly compiled artifact.
    setStage(job, 'decompose.start');
    const synthName = slugify(job.task || 'task');
    let registered_concept_id = null;
    let registered_version_id = null;
    if (ctx.registry && typeof ctx.registry.createConcept === 'function') {
      try {
        const concept = ctx.registry.createConcept({
          name: synthName,
          description: (job.task || '').slice(0, 400),
          tenant: job.tenant,
          schema: null,
          tags: ['compiled'],
          visibility: 'private',
        });
        const version = ctx.registry.publishVersion({
          concept_id: concept.id,
          source: synthesis_result.source,
          evaluation: {
            quality_score: synthesis_result.quality_score ?? null,
            pass_rate_positive: synthesis_result.pass_rate_positive ?? null,
            reject_rate_negative: synthesis_result.reject_rate_negative ?? null,
            latency_p50_us: synthesis_result.latency_p50_us ?? null,
            size_bytes: synthesis_result.size_bytes ?? null,
            source_hash: synthesis_result.source_hash ?? null,
            strategy: synthesis_result.strategy ?? null,
          },
          lineage: { compiled_from_job: job.id },
        });
        registered_concept_id = concept.id;
        registered_version_id = version.id;
      } catch (e) {
        setStage(job, 'register.error', { error: String(e.message || e) });
      }
    }
    setStage(job, 'decompose.done', {
      recipes_n: 1,
      synthesized: true,
      concept_id: registered_concept_id,
    });
    setStatus(job, 'running', { progress: 80 });

    // Stage 4 - Package via compileSpec. The seeds.jsonl was already written
    // in the pre-split phase above; compileSpec will re-run the deterministic
    // split (same split_seed) so the holdout the K-score is measured against
    // is identical to the holdout we held back from the teacher.
    setStage(job, 'package.start');

    // Honest artifact_class - strategy 'claude' means an LLM teacher emitted
    // the source (synthesized_rule). Strategy 'pattern' is deterministic
    // template matching with no teacher (rule). The audit (C2) requires
    // build-time class enforcement so we never default to a claim the bytes
    // can't back up.
    const strategy = synthesis_result.strategy || 'pattern';
    const isTeacherSynthesized = strategy === 'claude';
    const artifactClass = isTeacherSynthesized ? 'synthesized_rule' : 'rule';
    const synthesisTrainingStats = isTeacherSynthesized
      ? {
          synthesized_by: 'anthropic',
          teacher_vendor: 'anthropic',
          teacher_model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-7',
          synthesis_strategy: strategy,
          synthesis_input_hash: synthesisInputHash,
        }
      : {
          synthesis_strategy: strategy,
          synthesis_input_hash: synthesisInputHash,
        };

    const recipeId = registered_concept_id || ('rcp_synth_' + job.id);
    const spec = {
      job_id: job.id,
      task: job.task,
      base_model: job.base_model || 'none',
      recipes: [{
        id: recipeId,
        name: synthName,
        source: synthesis_result.source,
        version_id: registered_version_id || `ver_synth_${job.id}`,
        tags: ['compiled'],
      }],
      artifact_class: artifactClass,
      training_stats: synthesisTrainingStats,
    };

    let built;
    try {
      built = await compileSpec(spec, {
        seedsPath,
        outDir,
        useSeedsGate: true,
        allow_below_gate: job.allow_below_gate === true,
      });
    } catch (e) {
      setStatus(job, 'failed', {
        error: 'compile_failed: ' + String(e.message || e),
        error_code: 'KOLM_E_COMPILE',
        progress: 80,
        failed_at: new Date().toISOString(),
      });
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
      return;
    }
    // The build payload returns either a number (legacy v1 K-score) or the v2
    // envelope { composite, ships, axes, ... }. Normalize to one number.
    const composite = normalizeKScore(built.k_score);
    setStage(job, 'package.done', { bytes: built.bytes, k_score: composite });

    const threshold = typeof job.k_threshold === 'number' ? job.k_threshold : 0.85;
    if (typeof composite === 'number' && composite < threshold) {
      setStatus(job, 'failed', {
        error: `k_score ${composite.toFixed(3)} below threshold ${threshold.toFixed(2)} - no artifact shipped`,
        error_code: 'KOLM_E_K_SCORE_BELOW_THRESHOLD',
        k_score: composite,
        artifact_path: null,
        artifact_bytes: null,
        failed_at: new Date().toISOString(),
      });
      try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup
      return;
    }

    setStatus(job, 'completed', completionPatch(job, built, composite, {
      concept_id: registered_concept_id,
      version_id: registered_version_id,
    }));

    try { fs.rmSync(seedsDir, { recursive: true, force: true }); } catch {} // deliberate: cleanup

    // Machine self-serve deploy hook.
    await sendDeployHook(job, built, composite);
  } catch (e) {
    setStatus(job, 'failed', {
      error: String(e.message || e),
      error_code: 'KOLM_E_UNHANDLED',
      failed_at: new Date().toISOString(),
    });
  }
}
