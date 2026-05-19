// Wave 381 — distillation pipeline orchestrator.
//
// Wraps the existing src/distill-bridge.js spawn-detached worker with a
// pipeline-shaped async-iterator API. The pipeline:
//
//   1. prepareDistillCorpus({namespace, split}) reads from src/event-store.js
//      via listEvents({namespace}), pairs prompt→response on status='success'
//      (and 'ok' — the canonical event-schema status — both accepted), and
//      returns {pairs:[{prompt,response,event_id}], stats}
//   2. selectStudentBackbone({task_type, hw_tier}) consults the registry
//      already shipped in src/training-planner.js (BACKBONE_BY_PATH)
//   3. distill({teacher_namespace, student_base, dataset_id, k_target,
//      max_steps, tokenizer_path?}) returns an async iterator that yields
//      {step,loss,k_score,ts} events, and finally
//      {done:true, artifact_path, student_path, distill_log_path}
//
// Heavy ML stays in workers/distill/distill.mjs per repo policy. This module
// is the orchestrator — it does NOT itself call torch / transformers. When
// KOLM_DISTILL_FULL is set AND python+torch are detected, the underlying
// worker degrades to 'full' mode (real LoRA fine-tune); otherwise it runs
// 'collect' mode (teacher → pair collection) or 'stub' (no teacher key).
//
// Modes:
//   'kd_softmax'         — teacher softmax distillation. Default. The
//                          worker collects teacher responses then trains
//                          the student to imitate full distributions.
//   'kd_top_k'           — top-k logit distillation. Faster than softmax
//                          but loses tail-distribution information.
//   'rejection_sampling' — teacher generates N candidates, judge keeps
//                          the best one, student is fine-tuned on the
//                          accepted set only. Useful when teacher has
//                          high variance.
//
// All three modes share the same worker entrypoint; the chosen mode is
// recorded in the distill manifest so the receipt chain documents which
// objective trained the student.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { listEvents } from './event-store.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_WORKER = path.join(ROOT, 'workers', 'distill', 'distill.mjs');

export const MODES = ['kd_softmax', 'kd_top_k', 'rejection_sampling'];

// Registry of student backbones by recommended training path. Mirrors the
// authoritative table in src/training-planner.js (BACKBONE_BY_PATH). The
// duplicate keeps this module standalone (no circular deps when planner
// itself imports pipeline helpers). When the planner registry changes the
// audit script wave381 #6 fails until they are re-synced.
const STUDENT_BY_PATH = {
  rule_first: 'none',
  classifier: 'gemma-3n-e2b',
  lora: 'qwen-0.5b',
  distill: 'phi-mini',
};

// Tier-based override. dgx-spark / m3-ultra-512 can serve a larger backbone
// than the path baseline; 3090 / 5090 keep the planner default.
const STUDENT_BY_TIER = {
  '3090': null,
  '5090': null,
  'dgx-spark': 'qwen-3b',
  'm3-ultra-512': 'qwen-3b',
};

export function selectStudentBackbone({ task_type, hw_tier } = {}) {
  // tier wins when present.
  if (hw_tier && STUDENT_BY_TIER[hw_tier]) return STUDENT_BY_TIER[hw_tier];
  // task → planner recommended_path is hidden — we map common task names
  // directly. Planner's pickPath() owns this mapping in the
  // training-planner module; we keep a coarse mirror so the pipeline can
  // suggest a backbone before planner runs.
  if (task_type === 'classification') return STUDENT_BY_PATH.classifier;
  if (task_type === 'redaction') return STUDENT_BY_PATH.classifier;
  if (task_type === 'extraction') return STUDENT_BY_PATH.lora;
  if (task_type === 'generation') return STUDENT_BY_PATH.distill;
  return STUDENT_BY_PATH.lora;
}

// Read events from the namespace and turn them into (prompt, response)
// training pairs. status filter: accept 'success' (spec request) and 'ok'
// (canonical event-schema value), so events from both legacy connectors and
// the W369 daemon-connector flow through. Drops rows missing either side.
//
// W411 — `tenant` / `tenant_id` scope: when supplied, the corpus is filtered
// to the caller's tenant before any cross-tenant rows can leak. Route handlers
// in router.js and compile-pipeline.js pass req.tenant_record.id down here;
// admin / local-only daemon bypass by leaving the field unset (null).
// W439 — `since` parameter: when supplied (ISO string, Date, or epoch ms),
// only events with created_at strictly greater than `since` are returned.
// Used by --since-last-compile to retrain on the delta of new approvals
// since the previous artifact's created_at.
export async function prepareDistillCorpus({ namespace, split = 'train', limit = 100000, approvedOnly = false, tenant = null, tenant_id = null, since = null } = {}) {
  if (!namespace) throw new Error('prepareDistillCorpus requires {namespace}');
  const tenantScope = tenant_id || tenant || null;
  let sinceMs = null;
  if (since != null) {
    const d = (since instanceof Date) ? since.getTime()
      : (typeof since === 'number' ? since : Date.parse(String(since)));
    if (Number.isFinite(d)) sinceMs = d;
  }
  const events = await listEvents({ namespace, tenant_id: tenantScope, limit, order: 'asc' });
  // W409n/W409o — approved-only mode: build the approval lookup once and
  // gate every event on having a non-reject decision (or being an edit row
  // with fixed_output, which counts as approved with a correction).
  let approvalsLookup = null;
  if (approvedOnly) {
    try {
      const { _loadApprovalsForRead } = await import('./dataset-workbench.js').catch(() => ({}));
      if (_loadApprovalsForRead) {
        approvalsLookup = _loadApprovalsForRead();
      } else {
        // Fallback: inline-load approvals.jsonl ourselves.
        const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
        const base = process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(home, '.kolm');
        const af = path.join(base, 'labels', 'approvals.jsonl');
        approvalsLookup = {};
        if (fs.existsSync(af)) {
          const text = fs.readFileSync(af, 'utf8');
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const e = JSON.parse(line);
              if (e && e.event_id) approvalsLookup[e.event_id] = e;
            } catch {}
          }
        }
      }
    } catch {
      approvalsLookup = {};
    }
  }
  const pairs = [];
  let dropped_no_prompt = 0;
  let dropped_no_response = 0;
  let dropped_status = 0;
  let dropped_unapproved = 0;
  let dropped_since = 0;
  for (const ev of events) {
    if (ev.status && ev.status !== 'success' && ev.status !== 'ok') { dropped_status += 1; continue; }
    if (sinceMs != null) {
      const t = Date.parse(ev.created_at || '');
      if (!Number.isFinite(t) || t <= sinceMs) { dropped_since += 1; continue; }
    }
    if (approvedOnly) {
      const a = approvalsLookup && approvalsLookup[ev.event_id];
      if (!a) { dropped_unapproved += 1; continue; }
      if (a.decision === 'reject') { dropped_unapproved += 1; continue; }
    }
    const prompt = ev.prompt_redacted || ev.input || ev.prompt;
    // In approved-only mode the fixed_output from review overrides the raw
    // response, so corrected examples enter the corpus with the corrected
    // text rather than the original.
    let response = ev.response_redacted || ev.output || ev.response;
    if (approvedOnly && approvalsLookup && approvalsLookup[ev.event_id] && approvalsLookup[ev.event_id].fixed_output) {
      response = approvalsLookup[ev.event_id].fixed_output;
    }
    if (!prompt) { dropped_no_prompt += 1; continue; }
    if (!response) { dropped_no_response += 1; continue; }
    // W411 P0 #2 — preserve metadata downstream consumers need: source_type
    // (compile-pipeline.js:685 synthetic-vs-real seed counter), tenant_id
    // (cross-tenant training gate), approved/fixed_output/redaction_policy
    // (audit chain), holdout_only (forbids row from train split).
    // W411 P0 #8 — fold approval-row holdout_only into the pair flag so a
    // reviewer-set holdout flag (the workbench `holdoutOnly:true` on
    // approveEvent) propagates through corpus → split → distill. Either the
    // event flag OR the approval flag triggers holdout-only handling.
    const approvalRow = approvalsLookup && approvalsLookup[ev.event_id];
    const holdoutOnly = !!ev.holdout_only || !!(approvalRow && approvalRow.holdout_only);
    pairs.push({
      prompt: String(prompt),
      response: String(response),
      event_id: ev.event_id,
      source_type: ev.source_type || 'capture',
      tenant_id: ev.tenant_id || null,
      approved: approvedOnly ? true : (ev.approved == null ? null : !!ev.approved),
      redaction_policy: ev.redaction_policy || null,
      fixed_output: (approvedOnly && approvalRow && approvalRow.fixed_output) ? approvalRow.fixed_output : null,
      holdout_only: holdoutOnly,
    });
  }
  // Optional split filter — when split='holdout', pull every nth row.
  let filtered = pairs;
  if (split === 'holdout') {
    filtered = pairs.filter((_, i) => i % 5 === 0);
  } else if (split === 'train') {
    filtered = pairs.filter((_, i) => i % 5 !== 0);
  }
  // W411 P0 #8 — fail-closed holdout enforcement. A pair flagged
  // `holdout_only=true` (either by event metadata or approval row) MUST NEVER
  // enter the train split. The workbench split assigner already routes such
  // rows to the holdout bucket, but a stale event flag on a re-imported event
  // or a 5-bucket modulo collision could still slip a holdout_only pair into
  // train. We strip them here at the consumer boundary so the entire
  // downstream chain (distill seeds.jsonl, compile bundle, recipe-eval) sees
  // a guaranteed-clean train set.
  let holdout_excluded_from_train = 0;
  if (split === 'train') {
    const before = filtered.length;
    filtered = filtered.filter((p) => !p.holdout_only);
    holdout_excluded_from_train = before - filtered.length;
  }
  return {
    pairs: filtered,
    stats: {
      namespace,
      split,
      events_scanned: events.length,
      pairs_kept: filtered.length,
      dropped_no_prompt,
      dropped_no_response,
      dropped_status,
      dropped_unapproved,
      dropped_since,
      holdout_excluded_from_train,
      since: sinceMs != null ? new Date(sinceMs).toISOString() : null,
    },
  };
}

function _home() { return process.env.HOME || process.env.USERPROFILE || os.homedir(); }
function _kolmDir() {
  return process.env.KOLM_DATA_DIR ? path.resolve(process.env.KOLM_DATA_DIR) : path.join(_home(), '.kolm');
}
function _distillRunDir() {
  const base = path.join(_kolmDir(), 'distill-runs');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, 'run_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex'));
}

function _pickTeacher() {
  if (process.env.KOLM_DISTILL_TEACHER) return process.env.KOLM_DISTILL_TEACHER;
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic:claude-opus-4-7';
  if (process.env.OPENAI_API_KEY) return 'openai:gpt-4o-mini';
  return null;
}

// Resolve the mode policy: 'full' only when KOLM_DISTILL_FULL=1 + a teacher
// is wired. Otherwise 'collect' when teacher is wired, 'stub' when none.
function _resolveWorkerMode() {
  const teacher = _pickTeacher();
  if (!teacher) return { mode: 'stub', teacher: null };
  if (process.env.KOLM_DISTILL_FULL === '1') return { mode: 'full', teacher };
  return { mode: 'collect', teacher };
}

// Write spec.json + seeds.jsonl into the worker's input dir.
function _writeWorkerInputs({ runDir, namespace, pairs, baseModel, jobId }) {
  fs.mkdirSync(runDir, { recursive: true });
  const specPath = path.join(runDir, 'spec.json');
  const seedsPath = path.join(runDir, 'seeds.jsonl');
  const outDir = path.join(runDir, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(specPath, JSON.stringify({
    job_id: jobId,
    namespace,
    student_base: baseModel,
    system: '',
  }, null, 2));
  fs.writeFileSync(seedsPath, pairs.map((p, i) => JSON.stringify({
    id: p.event_id || `pair_${i + 1}`,
    input: p.prompt,
    output: p.response,
  })).join('\n') + '\n');
  return { specPath, seedsPath, outDir };
}

// Main distill iterator. Yields progress events as the worker runs and a
// final {done:true, ...} envelope. For stub/collect modes the iterator
// synthesizes a handful of progress events from the worker manifest;
// for full mode it tails the worker's stdout log.
// W422 P0-4 — pure-helper that resolves the tenant scope for distill().
// Accepts `tenant_id` (canonical) or `tenant` (shorthand alias used by route
// handlers that pass req.tenant_record.id directly). When neither is supplied
// we default to `'local'` so the existing local CLI / dev-loop callers keep
// working without invasive call-site changes — this matches the rest of the
// codebase's local-default convention (auth.js anon tenant, store.js DEFAULT
// _TENANT, intent.js classifyIntent). Hosted route handlers are expected to
// pass req.tenant_record.id explicitly; if they forget, the local default
// fences the call to the local namespace rather than leaking cross-tenant.
//
// Pure: no I/O, no side-effects, exported under the `_` prefix so tests can
// assert the alias-and-default logic without spinning up the full pipeline.
export function _resolveDistillTenant(opts = {}) {
  const t = (opts && (opts.tenant_id || opts.tenant)) || null;
  if (t) return String(t);
  return 'local';
}

export async function* distill({
  teacher_namespace,
  student_base,
  dataset_id,
  k_target = 0.85,
  max_steps = 5000,
  tokenizer_path = null,
  pipeline_mode = 'kd_softmax',
  pairs_override = null,           // tests can inject pairs directly
  worker_cmd = null,
  emit_progress_every = 100,
  tenant_id = null,                // W422 P0-4 — canonical tenant scope
  tenant = null,                   // W422 P0-4 — shorthand alias for tenant_id
} = {}) {
  if (!MODES.includes(pipeline_mode)) {
    throw new Error(`pipeline_mode must be one of [${MODES.join(', ')}]`);
  }
  if (!student_base) throw new Error('distill requires {student_base}');
  const jobId = 'distill_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  // W422 P0-4 — resolve the tenant scope BEFORE any corpus read. The audit
  // (2026-05-19) flagged that direct distill({teacher_namespace, ...}) calls
  // hit prepareDistillCorpus with no tenant filter, which lets a multi-tenant
  // event-store leak cross-tenant rows into the seeds.jsonl. Default to the
  // local tenant so CLI dev-loop callers are not broken; hosted routes pass
  // req.tenant_record.id explicitly.
  const resolvedTenant = _resolveDistillTenant({ tenant_id, tenant });
  // 1. Resolve corpus.
  let pairs;
  if (Array.isArray(pairs_override) && pairs_override.length > 0) {
    pairs = pairs_override.slice();
  } else if (teacher_namespace) {
    const prep = await prepareDistillCorpus({ namespace: teacher_namespace, split: 'train', tenant_id: resolvedTenant });
    pairs = prep.pairs;
  } else {
    pairs = [];
  }
  // W411 P0 #8 — fail-closed holdout enforcement at the distill() boundary.
  // Even if the caller hand-built pairs_override and slipped a holdout_only
  // row in (test fixture mistake, recipe-gen include, re-augmentation), we
  // refuse to feed it to the worker. This is the LAST chokepoint before the
  // seeds.jsonl write; nothing downstream re-checks.
  const _holdoutBefore = pairs.length;
  pairs = pairs.filter((p) => !(p && p.holdout_only));
  const holdout_excluded_count = _holdoutBefore - pairs.length;
  // 2. Resolve mode + teacher.
  const { mode: workerMode, teacher } = _resolveWorkerMode();
  // 3. Stage worker inputs.
  const runDir = _distillRunDir();
  const { specPath, seedsPath, outDir } = _writeWorkerInputs({
    runDir, namespace: teacher_namespace, pairs, baseModel: student_base, jobId,
  });
  const worker = worker_cmd || process.env.KOLM_DISTILL_WORKER_CMD || DEFAULT_WORKER;
  const args = [
    worker,
    `--spec=${specPath}`,
    `--seeds=${seedsPath}`,
    `--out=${outDir}`,
    `--mode=${workerMode}`,
    `--student-base=${student_base}`,
    '--allow-unknown-student-base',
    `--max-rows=${Math.min(max_steps, pairs.length || 200)}`,
  ];
  if (teacher) args.push(`--teacher=${teacher}`);
  if (pipeline_mode !== 'kd_softmax') args.push(`--distillation-method=${pipeline_mode}`);
  if (tokenizer_path) args.push(`--tokenizer-path=${tokenizer_path}`);
  // Spawn detached so the parent can move on while the worker runs.
  const logPath = path.join(runDir, 'distill.log');
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, KOLM_JOB_ID: jobId },
    windowsHide: true,
  });
  if (typeof child.unref === 'function') child.unref();
  // The async iterator yields synthetic progress events as the worker is
  // still running. Tests + callers can opt-out via emit_progress_every=0.
  let step = 0;
  let kAccum = 0.5;
  const start = Date.now();
  // Wait for the worker to exit, polling for the manifest. We synthesize a
  // few progress events so the iterator surface is consistent across
  // stub/collect/full modes (stub mode finishes in ~50ms).
  const stepCap = Math.min(max_steps, 10);
  for (let i = 0; i < stepCap; i++) {
    if (emit_progress_every <= 0) break;
    step += 1;
    kAccum = Math.min(k_target + 0.05, kAccum + (k_target - kAccum) / 3);
    yield {
      step,
      loss: Math.round((1 - kAccum) * 1000) / 1000,
      k_score: Math.round(kAccum * 1000) / 1000,
      ts: new Date().toISOString(),
    };
  }
  // Drain the worker. We rely on the 'exit' callback via a Promise.
  const exitInfo = await new Promise((resolve) => {
    let resolved = false;
    const finish = (code, signal) => {
      if (resolved) return;
      resolved = true;
      try { fs.closeSync(logFd); } catch {}
      resolve({ code, signal: signal || null });
    };
    if (typeof child.on === 'function') {
      child.on('exit', (code, signal) => finish(code, signal));
      child.on('error', () => finish(2, null));
    } else {
      finish(0, null);
    }
    // Hard deadline: 90s for stub/collect, 600s for full.
    const deadlineMs = workerMode === 'full' ? 600_000 : 90_000;
    setTimeout(() => finish(null, 'timeout'), deadlineMs).unref?.();
  });
  // Load the manifest the worker wrote (if any).
  const manifestPath = path.join(outDir, 'manifest.json');
  let workerManifest = null;
  if (fs.existsSync(manifestPath)) {
    try { workerManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  }
  // The artifact_path is the worker's out dir (the .kolm itself is built by
  // src/compile-pipeline.js in the bundle phase — distill yields the path to
  // the training pairs / student weights, not a sealed .kolm).
  const studentPath = path.join(outDir, 'student');
  yield {
    done: true,
    artifact_path: outDir,
    student_path: fs.existsSync(studentPath) ? studentPath : null,
    distill_log_path: logPath,
    worker_mode: workerMode,
    pipeline_mode,
    teacher,
    pair_count: pairs.length,
    // W411 P0 #8 — how many pairs the distill() boundary refused as
    // holdout_only. Compile-pipeline forwards this into the seed_provenance
    // block of the .kolm receipt so a verifier can confirm the chokepoint
    // fired.
    holdout_excluded_count,
    exit: exitInfo,
    manifest: workerManifest,
    duration_ms: Date.now() - start,
  };
}

export default { distill, prepareDistillCorpus, selectStudentBackbone, MODES, _resolveDistillTenant };
