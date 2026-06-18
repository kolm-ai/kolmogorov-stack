// W282 — /v1/compile now routes through src/spec-compile.js.
//
// Asserts BEHAVIOR not page copy:
//   1) compile with no positive examples → job status='failed' +
//      error_code='KOLM_E_NO_SEEDS'. No artifact produced.
//   2) compile with positive examples → goes through compileSpec, produces
//      a real artifact with seed_provenance populated.
//   3) synthesizeStarterEvals + pickInputsForTask are GONE from src/compile.js
//      (they were the stub-eval path that the audit C1 finding called out).
//   4) src/compile.js imports compileSpec from spec-compile.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT       = path.resolve(__dirname, '..');

test('W282 compile.js no longer contains synthesizeStarterEvals or pickInputsForTask', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.equal(src.includes('synthesizeStarterEvals'), false, 'synthesizeStarterEvals must be gone (stub-eval path)');
  assert.equal(src.includes('pickInputsForTask'), false, 'pickInputsForTask must be gone (keyword heuristic fake inputs)');
  assert.equal(src.includes('auto_synthesized'), false, 'auto_synthesized eval-case marker must be gone');
});

test('W282 compile.js imports compileSpec from spec-compile.js', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*compileSpec[^}]*\}\s*from\s*['"]\.\/spec-compile\.js['"]/);
});

test('W282 compile.js no longer calls buildAndZip directly', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  // The only build path is now compileSpec, which delegates to buildAndZip
  // internally. compile.js itself must not import or call it.
  assert.equal(src.includes('buildAndZip'), false, 'buildAndZip must be reached only via compileSpec now');
});

test('W282 compile.js sets KOLM_E_NO_SEEDS error code in source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/compile.js'), 'utf8');
  assert.ok(src.includes('KOLM_E_NO_SEEDS'), 'no-seeds refusal error code must be present');
  assert.ok(src.includes('no_seeds_provided'), 'human-readable error string must be present');
});

test('W282 runJob behavior: no positive examples → failed + KOLM_E_NO_SEEDS', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const job = createJob({
    task: 'redact PII from email',
    examples: [],
    tenant: 't_w282_a',
  });
  const ctx = {
    examples: [],
    synthesize: async () => ({ accepted: false }),
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_a');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_NO_SEEDS');
  assert.match(fresh.error, /no_seeds_provided/);
  assert.equal(fresh.artifact_path, null);
});

test('W282 runJob behavior: synthesis fail → KOLM_E_RECIPE_SYNTHESIS_FAILED (not stub artifact)', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const job = createJob({
    task: 'redact PII from email',
    examples: [{ input: 'foo bar', output: 'foo bar' }],
    tenant: 't_w282_b',
  });
  const ctx = {
    examples: [{ input: 'foo bar', output: 'foo bar' }],
    synthesize: async () => ({ accepted: false }),
    recall: null,
    registry: null,
    outDir: process.env.KOLM_DATA_DIR,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_b');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_RECIPE_SYNTHESIS_FAILED');
  assert.equal(fresh.artifact_path, null);
});

test('W282 runJob behavior: real examples + accepted synthesis → artifact w/ seed_provenance', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    input: 'echo input ' + i,
    output: 'echo input ' + i,
  }));
  const job = createJob({
    task: 'echo task',
    examples,
    tenant: 't_w282_c',
    k_threshold: 0.50,
  });
  // Deterministic identity recipe — passes the verifier quality gate.
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'abc123',
      pass_rate_positive: 1.0,
      reject_rate_negative: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'identity',
    }),
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_c');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  assert.ok(fresh.artifact_path, 'artifact_path must be set');
  assert.ok(fresh.k_score >= 0.50, `k_score ${fresh.k_score} below 0.50`);
  assert.ok(fresh.seed_provenance, 'seed_provenance must be populated');
  assert.ok(fresh.seed_provenance.seeds_hash, 'seeds_hash must be present');
  assert.ok(fresh.seed_provenance.train_hash, 'train_hash must be present');
  assert.ok(fresh.seed_provenance.holdout_hash, 'holdout_hash must be present');
  assert.ok(fresh.seed_provenance.leakage_report_hash, 'leakage_report_hash must be present');
  // Honest taxonomy: pattern-mode synthesis = no teacher = class='rule'.
  // Only strategy='claude' (LLM teacher) flips to 'synthesized_rule'.
  assert.equal(fresh.manifest?.artifact_class, 'rule');
});

test('W282 runJob behavior: strategy=claude → artifact_class=synthesized_rule + teacher attribution', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w282-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    input: 'echo ' + i,
    output: 'echo ' + i,
  }));
  const job = createJob({ task: 'echo claude task', examples, tenant: 't_w282_d', k_threshold: 0.50 });
  const recipeSource = 'function generate(input, lib){ return input; }';
  const ctx = {
    examples,
    synthesize: async () => ({
      accepted: true,
      source: recipeSource,
      source_hash: 'def456',
      pass_rate_positive: 1.0,
      quality_score: 0.99,
      latency_p50_us: 5,
      size_bytes: recipeSource.length,
      strategy: 'claude',
    }),
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w282_d');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} (err=${fresh.error})`);
  assert.equal(fresh.manifest?.artifact_class, 'synthesized_rule');
  // Teacher attribution must be in manifest.training (recipe-class.js #185).
  const t = fresh.manifest?.training || {};
  assert.ok(t.teacher_vendor || t.teacher_model || t.synthesized_by,
    'synthesized_rule artifact must record teacher attribution');
});

test('W960 createJob preserves explicit distilled_model compile intent', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w960-'));
  const { createJob } = await import('../src/compile.js');
  const job = createJob({
    task: 'draft answers',
    examples: [{ input: 'a', output: 'b' }],
    tenant: 't_w960_a',
    recipe_class: 'distilled_model',
    hw_tier: 'h100-80',
    output_target: 'gguf',
    multi_device: ['server-cuda', 'browser-wasm'],
  });
  assert.equal(job.recipe_class, 'distilled_model');
  assert.equal(job.hw_tier, 'h100-80');
  assert.equal(job.output_target, 'gguf');
  assert.deepEqual(job.multi_device, ['server-cuda', 'browser-wasm']);
});

test('W960 distilled_model compile fails closed when neural worker only collects pairs', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w960-'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w960-out-'));
  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    id: 'ex_' + i,
    input: 'prompt ' + i,
    output: 'answer ' + i,
  }));
  let receivedPairCount = null;
  let receivedHoldoutCount = null;
  let receivedTrainFromPairs = null;
  let receivedPortableExport = null;
  let receivedTrainPrompts = [];
  let receivedHoldoutPrompts = [];
  const job = createJob({
    task: 'answer prompts',
    examples,
    tenant: 't_w960_b',
    recipe_class: 'distilled_model',
    k_threshold: 0.50,
  });
  const ctx = {
    examples,
    synthesize: async () => { throw new Error('synthesize must not run for distilled_model compile'); },
    distill: async function* (opts) {
      receivedPairCount = opts.pairs_override.length;
      receivedHoldoutCount = Array.isArray(opts.holdout_override) ? opts.holdout_override.length : null;
      receivedTrainFromPairs = opts.train_from_pairs;
      receivedPortableExport = opts.portable_export;
      receivedTrainPrompts = opts.pairs_override.map((p) => p.prompt);
      receivedHoldoutPrompts = (opts.holdout_override || []).map((p) => p.prompt);
      yield {
        done: true,
        artifact_path: outDir,
        worker_mode: 'collect',
        student_path: null,
        manifest: {
          worker: 'kolm-distill-worker',
          worker_version: 'w960-test',
          mode: 'collect',
          ml_pipeline_run: false,
        },
      };
    },
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w960_b');
  assert.equal(fresh.status, 'failed');
  assert.equal(fresh.error_code, 'KOLM_E_NEURAL_TRAINING_NOT_RUN');
  assert.equal(fresh.artifact_path, null);
  assert.ok(receivedPairCount > 0 && receivedPairCount < examples.length,
    'neural compile must feed only the pre-split train rows');
  assert.ok(receivedHoldoutCount > 0 && receivedHoldoutCount < examples.length,
    'neural compile must pass the pre-split holdout rows as eval-only rows');
  assert.equal(receivedTrainFromPairs, true, 'neural compile must ask the Python worker to train from labeled pairs');
  assert.equal(receivedPortableExport, 'gguf', 'neural compile must request a portable GGUF export attempt');
  assert.equal(receivedTrainPrompts.some((p) => receivedHoldoutPrompts.includes(p)), false,
    'neural compile train override and holdout override must be disjoint');
});

test('W960 distilled_model compile packages portable worker weights with distill provenance', async () => {
  process.env.KOLM_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w960-'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kolm-w960-success-'));
  const outDir = path.join(tmp, 'artifacts');
  const distillOut = path.join(tmp, 'distill-out');
  fs.mkdirSync(distillOut, { recursive: true });
  const weightPath = path.join(tmp, 'student.gguf');
  const weightBytes = Buffer.from('GGUF_W960_PORTABLE_WEIGHT_BYTES');
  fs.writeFileSync(weightPath, weightBytes);
  const pairsPath = path.join(distillOut, 'training-pairs.jsonl');
  fs.writeFileSync(pairsPath, [
    JSON.stringify({ id: 'p1', input: 'prompt 1', teacher_output: 'answer 1' }),
    JSON.stringify({ id: 'p2', input: 'prompt 2', teacher_output: 'answer 2' }),
  ].join('\n') + '\n');
  const pairsHash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(pairsPath)).digest('hex');
  const manifest = {
    worker: 'kolm-distill-worker',
    worker_version: 'w960-test',
    mode: 'full',
    teacher_vendor: 'local',
    teacher_model: 'fixture-teacher',
    teacher_version: 'fixture-v1',
    student_base: 'Qwen/Qwen3-4B-Instruct-2507',
    distillation_method: 'lora',
    ml_pipeline_run: true,
    student_holdout_accuracy: 1.0,
    holdout_accuracy: 1.0,
    teacher_holdout_accuracy: 1.0,
    training_pairs_collected: 2,
    training_pairs_path: 'training-pairs.jsonl',
    training_pairs_hash: pairsHash,
    redaction_map_hash: null,
    redact_class: 'none',
    teacher_call_log_hash: null,
    reinjection_log_hash: null,
  };
  fs.writeFileSync(path.join(distillOut, 'manifest.json'), JSON.stringify(manifest, null, 2));

  const { createJob, runJob, getJob } = await import('../src/compile.js');
  const examples = Array.from({ length: 8 }, (_, i) => ({
    id: 'ex_' + i,
    input: 'prompt ' + i,
    output: 'answer ' + i,
  }));
  const job = createJob({
    task: 'answer prompts with a neural student',
    examples,
    tenant: 't_w960_c',
    recipe_class: 'distilled_model',
    base_model: 'Qwen/Qwen3-4B-Instruct-2507',
    k_threshold: 0.50,
    allow_below_gate: true,
  });
  let receivedTrainPrompts = [];
  let receivedHoldoutPrompts = [];
  let receivedTrainFromPairs = null;
  let receivedPortableExport = null;
  const ctx = {
    examples,
    synthesize: async () => { throw new Error('synthesize must not run for distilled_model compile'); },
    distill: async function* (opts) {
      receivedTrainPrompts = (opts.pairs_override || []).map((p) => p.prompt);
      receivedHoldoutPrompts = (opts.holdout_override || []).map((p) => p.prompt);
      receivedTrainFromPairs = opts.train_from_pairs;
      receivedPortableExport = opts.portable_export;
      yield {
        done: true,
        artifact_path: distillOut,
        worker_mode: 'full',
        student_path: weightPath,
        manifest,
      };
    },
    recall: null,
    registry: null,
    outDir,
  };
  await runJob(job, ctx);
  const fresh = getJob(job.id, 't_w960_c');
  assert.equal(fresh.status, 'completed', `expected completed, got ${fresh.status} err=${fresh.error}`);
  assert.equal(fresh.manifest?.artifact_class, 'distilled_model');
  assert.equal(fresh.manifest?.runtime_target, 'gguf');
  assert.equal(fresh.manifest?.runtime_target_config?.gguf_path, 'model.gguf');
  assert.equal(
    fresh.manifest?.hashes?.model_weights,
    crypto.createHash('sha256').update(weightBytes).digest('hex'),
  );
  assert.equal(fresh.manifest?.training?.ml_pipeline_run, true);
  assert.equal(fresh.manifest?.training?.student_holdout_accuracy, 1.0);
  assert.ok(receivedHoldoutPrompts.length > 0, 'success path must pass holdout rows to the distill worker');
  assert.equal(receivedTrainFromPairs, true);
  assert.equal(receivedPortableExport, 'gguf');
  assert.equal(receivedTrainPrompts.some((p) => receivedHoldoutPrompts.includes(p)), false,
    'success path train rows and holdout rows must be disjoint');
  assert.equal(fresh.neural_compile?.ml_pipeline_run, true);
  assert.equal(fresh.neural_compile?.holdout_eval_count, receivedHoldoutPrompts.length);
});
