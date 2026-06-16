// Wave 381 - distillation pipeline orchestrator.
//
// Wraps the existing src/distill-bridge.js spawn-detached worker with a
// pipeline-shaped async-iterator API. The pipeline:
//
//   1. prepareDistillCorpus({namespace, split}) reads from src/event-store.js
//      via listEvents({namespace}), pairs prompt→response on status='success'
//      (and 'ok' - the canonical event-schema status - both accepted), and
//      returns {pairs:[{prompt,response,event_id}], stats}
//   2. selectStudentBackbone({task_type, hw_tier}) consults the registry
//      already shipped in src/training-planner.js (BACKBONE_BY_PATH)
//   3. distill({teacher_namespace, student_base, dataset_id, k_target,
//      max_steps, tokenizer_path?}) returns an async iterator that yields
//      {step,loss,k_score,ts} events, and finally
//      {done:true, artifact_path, student_path, distill_log_path}
//
// Heavy ML stays in workers/distill/distill.mjs per repo policy. This module
// is the orchestrator - it does NOT itself call torch / transformers. When
// KOLM_DISTILL_FULL is set AND python+torch are detected, the underlying
// worker degrades to 'full' mode (real LoRA fine-tune); otherwise it runs
// 'collect' mode (teacher → pair collection) or 'stub' (no teacher key).
//
// Modes:
//   'kd_softmax' - teacher softmax distillation. Default. The
//                          worker collects teacher responses then trains
//                          the student to imitate full distributions.
//   'kd_top_k' - top-k logit distillation. Faster than softmax
//                          but loses tail-distribution information.
//   'rejection_sampling' - teacher generates N candidates, judge keeps
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
// W787 - compute-efficiency knobs (precision mode, grad checkpointing, early stop).
import { normalizeEfficiencyOptions, buildEfficiencyEnv } from './distill-efficiency.js';
// W713 (curriculum ordering) + W711 (importance weighting). These were
// previously reachable ONLY through a side CLI command; the main distill()
// path now threads them when a curriculum/importance knob is set so the
// student's sampler (SequentialSampler / WeightedRandomSampler in the Python
// trainer) actually engages. See _resolveOrderingPolicy + the staging block.
import { complexityProxy, sortCapturesByCurriculum, buildUnigramTable } from './curriculum-sort.js';
import { createScorerWindow } from './capture-importance.js';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');
const DEFAULT_WORKER = path.join(ROOT, 'workers', 'distill', 'distill.mjs');

export const MODES = ['kd_softmax', 'kd_top_k', 'rejection_sampling'];

// W708-2 - Teacher-source policy enum. Every known teacher slug is classified
// as either 'open-weights' (the weights are downloadable + the license permits
// distillation) or 'proprietary' (closed weights served only via vendor API,
// distillation may violate the vendor's TOS). The classification is stamped
// onto every distill manifest + run-meta.json so a downstream auditor can
// answer "did this artifact's teacher carry TOS risk?" without rebuilding the
// run.
//
// Classification rules - keep this table short and explicit; the fallback
// (unknown slug → 'proprietary') is safe-deny so an unrecognised slug never
// silently qualifies as open-weights. Operators who run a fork should add the
// slug here OR prefix it with `local:` / `hf:` so the prefix-fallback catches.
export const TEACHER_SOURCE_CLASSIFICATION = Object.freeze({
  // Proprietary - closed weights, vendor API only.
  'claude': 'proprietary',
  'gpt': 'proprietary',
  'gemini': 'proprietary',
  // Open-weights - downloadable weights, distillation permitted by license.
  'qwen': 'open-weights',
  'qwen2.5': 'open-weights',
  'qwen3': 'open-weights',
  'llama': 'open-weights',
  'mistral': 'open-weights',
  'mixtral': 'open-weights',
  'deepseek': 'open-weights', // distill-r1 + qwen-distill variants are MIT-licensed
});

// W708-2 - classifyTeacher(slug): returns 'open-weights' | 'proprietary' | 'unknown'.
// Order of resolution:
//   1. provider prefix `local:` or `hf:` → 'open-weights' (operator opted into
//      self-hosted weights - by definition they hold the weights themselves)
//   2. provider prefix `anthropic:` / `openai:` / `google:` → 'proprietary'
//      (vendor-routed slugs that the prefix-stripped model name would also
//      flag, but the prefix is the more reliable signal)
//   3. base-name prefix lookup against TEACHER_SOURCE_CLASSIFICATION using the
//      longest matching key (so `qwen2.5-7b-instruct` resolves under 'qwen2.5'
//      not 'qwen').
//   4. Falls through to 'unknown' for slugs the table does not recognise; the
//      _pickTeachers() filter treats 'unknown' as NOT open-weights (safe-deny).
export function classifyTeacher(teacherSlug) {
  if (teacherSlug == null) return 'unknown';
  const raw = String(teacherSlug).trim().toLowerCase();
  if (!raw) return 'unknown';
  // 1. Self-hosted prefixes.
  if (raw.startsWith('local:') || raw.startsWith('hf:')) return 'open-weights';
  // 2. Known vendor prefixes that imply proprietary regardless of model name.
  if (raw.startsWith('anthropic:') || raw.startsWith('openai:') || raw.startsWith('google:')) {
    return 'proprietary';
  }
  // Strip any other provider prefix (`vendor:model-x`) before base-name lookup.
  const base = raw.includes(':') ? raw.split(':').slice(1).join(':') : raw;
  // 3. Longest-prefix match against the classification table.
  const keys = Object.keys(TEACHER_SOURCE_CLASSIFICATION).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    // Match either exact key or key followed by a non-alphanumeric separator,
    // so 'qwen' matches 'qwen-3b' but NOT 'qwenfoo'.
    if (base === key) return TEACHER_SOURCE_CLASSIFICATION[key];
    if (base.startsWith(key + '-') || base.startsWith(key + '_') || base.startsWith(key + '.')) {
      return TEACHER_SOURCE_CLASSIFICATION[key];
    }
  }
  // 4. Safe-deny fallback. Anything we do not recognise is treated as unknown;
  // _pickTeachers() filter rejects 'unknown' when KOLM_TEACHER_SOURCE=open-weights.
  return 'unknown';
}

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
  // task → planner recommended_path is hidden - we map common task names
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
// W411 - `tenant` / `tenant_id` scope: when supplied, the corpus is filtered
// to the caller's tenant before any cross-tenant rows can leak. Route handlers
// in router.js and compile-pipeline.js pass req.tenant_record.id down here;
// admin / local-only daemon bypass by leaving the field unset (null).
// W439 - `since` parameter: when supplied (ISO string, Date, or epoch ms),
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
  // W409n/W409o - approved-only mode: build the approval lookup once and
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
            } catch {} // deliberate: cleanup
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
    // W411 P0 #2 - preserve metadata downstream consumers need: source_type
    // (compile-pipeline.js:685 synthetic-vs-real seed counter), tenant_id
    // (cross-tenant training gate), approved/fixed_output/redaction_policy
    // (audit chain), holdout_only (forbids row from train split).
    // W411 P0 #8 - fold approval-row holdout_only into the pair flag so a
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
  // Optional split filter - when split='holdout', pull every nth row.
  let filtered = pairs;
  if (split === 'holdout') {
    filtered = pairs.filter((_, i) => i % 5 === 0);
  } else if (split === 'train') {
    filtered = pairs.filter((_, i) => i % 5 !== 0);
  }
  // W411 P0 #8 - fail-closed holdout enforcement. A pair flagged
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
  const list = _pickTeachers();
  return list.length ? list[0] : null;
}

// W459 - return an ordered teacher list so distill() can fall back when the
// first teacher's worker errors (rate-limit, transient API, key revoked).
// The audit P1 distillation cluster (2026-05-19) flagged the missing
// fallback: a single API outage on the highest-priority teacher would kill
// the compile run instead of retrying with the next-best teacher in scope.
//
// Priority order: explicit KOLM_DISTILL_TEACHER first (operator override
// wins), then Anthropic (best teacher for most KD tasks), then OpenAI.
// Duplicates are removed so KOLM_DISTILL_TEACHER='anthropic:...' + ANTHROPIC
// _API_KEY do not double-count the same provider. KOLM_DISTILL_TEACHER may
// also be a comma list (`'anthropic:opus-4-7,openai:gpt-4o-mini'`) for
// operators who want an explicit fallback order.
export function _pickTeachers() {
  const out = [];
  const seen = new Set();
  const add = (t) => {
    if (!t) return;
    const norm = String(t).trim();
    if (!norm) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push(norm);
  };
  if (process.env.KOLM_DISTILL_TEACHER) {
    for (const t of String(process.env.KOLM_DISTILL_TEACHER).split(',')) add(t);
  }
  if (process.env.ANTHROPIC_API_KEY) add('anthropic:claude-opus-4-7');
  if (process.env.OPENAI_API_KEY) add('openai:gpt-4o-mini');
  // W708-2 - open-weights policy filter. When the operator sets
  // KOLM_TEACHER_SOURCE=open-weights, we strip every teacher whose
  // classifyTeacher() result is NOT 'open-weights'. If the filtered list is
  // empty we throw a clear, actionable error rather than silently falling back
  // to a proprietary teacher (the whole point of the policy enum is to make
  // TOS leakage a structural impossibility, not a soft warning).
  const policy = process.env.KOLM_TEACHER_SOURCE;
  if (policy === 'open-weights') {
    const filtered = out.filter((t) => classifyTeacher(t) === 'open-weights');
    if (filtered.length === 0) {
      const err = new Error('no_open_weight_teacher_configured');
      err.code = 'no_open_weight_teacher_configured';
      err.hint = 'KOLM_TEACHER_SOURCE=open-weights is set but no open-weight teacher is configured. Set KOLM_DISTILL_TEACHER to one of: qwen2.5-7b, qwen2.5-3b, llama-3-8b, mistral-7b, mixtral-8x7b, deepseek-r1-distill-qwen-7b, or use a local:/hf: prefix (e.g. local:/path/to/weights, hf:Qwen/Qwen2.5-7B-Instruct).';
      throw err;
    }
    return filtered;
  }
  return out;
}

// W718 - Teacher Council per-task selector. Wraps _pickTeachers() with the
// Teacher Council weighting formula from src/teacher-council.js, returning a
// teacher list re-ranked per capture so the highest-weight teacher leads.
//
// Activation:
//   - opts.use_council === true (explicit per-call opt-in)
//   - OR process.env.KOLM_TEACHER_COUNCIL === '1'
// Otherwise this returns _pickTeachers() unchanged (W459 fallback order
// preserved). Callers that ignore the council can keep using _pickTeachers
// directly; the council path is strictly additive.
//
// Honesty contract:
//   - When no reliability table is supplied AND no path exists on disk, the
//     council degenerates to per-capture cost/risk weighting only (every
//     teacher gets a 0.5 reliability prior). This is documented behavior:
//     we never fabricate reliability numbers.
//   - opts.explicit_teachers (CSV passed via --teachers) takes priority over
//     env-derived teachers, but the council filter still runs against it.
export async function _pickTeachersForCapture(capture, opts = {}) {
  const useCouncil = opts.use_council === true || process.env.KOLM_TEACHER_COUNCIL === '1';
  const baseList = (Array.isArray(opts.explicit_teachers) && opts.explicit_teachers.length > 0)
    ? opts.explicit_teachers.slice()
    : _pickTeachers();
  if (!useCouncil || baseList.length === 0) return { teachers: baseList, council: null };
  // Lazy-import to avoid a hard dep at module-load (the council files are
  // additive; older deploys without them must still run distill).
  let council = null;
  let weightsMod = null;
  try {
    council = await import('./teacher-council.js');
    weightsMod = await import('./teacher-weights.js');
  } catch (_) {
    return { teachers: baseList, council: { ok: false, error: 'council_unavailable' } };
  }
  let reliability = null;
  try {
    const persistPath = opts.reliability_path || weightsMod.defaultPersistPath();
    reliability = weightsMod.TeacherReliabilityTable.load(persistPath);
  } catch (_) {
    reliability = new weightsMod.TeacherReliabilityTable();
  }
  const selection = council.selectTeacherForCapture(baseList, capture || {}, reliability, opts);
  // Re-rank baseList so the winning teacher is first; remaining teachers
  // preserve their weight-descending order from the council formula.
  const ranked = selection.weights.map((w) => w.teacher);
  // Fill any unranked teachers (shouldn't happen, but defensive) to keep
  // baseList's tail intact.
  for (const t of baseList) if (!ranked.includes(t)) ranked.push(t);
  return {
    teachers: ranked,
    council: {
      ok: true,
      version: council.TEACHER_COUNCIL_VERSION,
      winner: selection.teacher,
      explanation: selection.explanation,
      weights: selection.weights,
    },
  };
}

// Resolve the mode policy: 'full' only when KOLM_DISTILL_FULL=1 + a teacher
// is wired. Otherwise 'collect' when teacher is wired, 'stub' when none.
function _resolveWorkerMode() {
  const teacher = _pickTeacher();
  if (!teacher) return { mode: 'stub', teacher: null };
  if (process.env.KOLM_DISTILL_FULL === '1') return { mode: 'full', teacher };
  return { mode: 'collect', teacher };
}

// W713/W711 - resolve whether the default distill path should engage curriculum
// ordering and/or importance weighting. Activation sources (any one trips it):
//   - explicit per-call opts.curriculum / opts.importance (recipe knob)
//   - env KOLM_DISTILL_CURRICULUM (any of: '1','ascending','descending')
//   - env KOLM_DISTILL_IMPORTANCE === '1'
// Returns a normalized policy { curriculum: 'ascending'|'descending'|null,
// importance: boolean }. When neither is set, returns the all-off policy so the
// existing default path (plain shuffle) is byte-identical to before.
//
// curriculum + importance are MUTUALLY adjustable but the Python trainer
// resolves the conflict (curriculum wins over importance when both are set,
// because a deterministic curriculum order is incompatible with weighted
// random sampling - see apps/trainer/distill.py). We still stamp both files so
// the trainer can record the conflict in run-meta.
export function _resolveOrderingPolicy(opts = {}) {
  const envCur = String(process.env.KOLM_DISTILL_CURRICULUM || '').trim().toLowerCase();
  let curriculum = null;
  if (opts && opts.curriculum != null) {
    const c = String(opts.curriculum).trim().toLowerCase();
    if (c === 'descending') curriculum = 'descending';
    else if (c === '1' || c === 'true' || c === 'ascending' || c === 'on') curriculum = 'ascending';
  } else if (envCur) {
    if (envCur === 'descending') curriculum = 'descending';
    else if (envCur === '1' || envCur === 'true' || envCur === 'ascending' || envCur === 'on') curriculum = 'ascending';
  }
  let importance = false;
  if (opts && opts.importance != null) {
    const i = String(opts.importance).trim().toLowerCase();
    importance = (i === '1' || i === 'true' || i === 'on');
  } else {
    importance = process.env.KOLM_DISTILL_IMPORTANCE === '1';
  }
  return { curriculum, importance };
}

// W713 - map a pipeline pair {prompt,response,event_id} into the capture shape
// the W711/W713 scorers expect ({prompt, response, capture_id}). Pure.
function _pairToCapture(p, i) {
  return {
    prompt: typeof p.prompt === 'string' ? p.prompt : '',
    response: typeof p.response === 'string' ? p.response : '',
    capture_id: p.event_id || `pair_${i + 1}`,
  };
}

// Write spec.json + seeds.jsonl into the worker's input dir.
//
// W713/W711 - when `ordering` requests curriculum and/or importance, we:
//   (a) stamp complexity_proxy on each staged seed row (the trainer's
//       SequentialSampler reads it directly),
//   (b) emit importance-weights.jsonl alongside seeds.jsonl (one
//       {capture_id, importance} row per pair) for the WeightedRandomSampler,
//   (c) order the seed rows ascending-by-complexity when curriculum is set so
//       even a trainer that ignores --curriculum still sees the easy
//       distribution first.
// The returned `ordering_meta` records what was actually stamped so distill()
// can put it on run-meta.json (auditable).
function _writeWorkerInputs({ runDir, namespace, pairs, baseModel, jobId, ordering = null }) {
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

  const wantCurriculum = !!(ordering && ordering.curriculum);
  const wantImportance = !!(ordering && ordering.importance);
  let importanceWeightsPath = null;
  const ordering_meta = {
    curriculum_mode: wantCurriculum ? ordering.curriculum : null,
    importance_weights: false,
    complexity_stamped: false,
    rows: pairs.length,
  };

  // Build the (possibly reordered) list of pairs + their capture views once so
  // complexity is computed against the same corpus reference table.
  let orderedPairs = pairs;
  if (wantCurriculum && pairs.length >= 2) {
    // Decorate pairs with their capture view, sort the captures, then map the
    // sorted order back onto the original pairs by capture_id.
    const captures = pairs.map(_pairToCapture);
    const sortedCaptures = sortCapturesByCurriculum(captures, ordering.curriculum);
    const byId = new Map();
    pairs.forEach((p, i) => byId.set(_pairToCapture(p, i).capture_id, p));
    orderedPairs = sortedCaptures.map((c) => byId.get(c.capture_id)).filter(Boolean);
    // Defensive: if the join lost rows (duplicate ids), fall back to the input.
    if (orderedPairs.length !== pairs.length) orderedPairs = pairs;
  }

  // Stamp complexity_proxy on each staged row when curriculum is active.
  // complexityProxy is per-corpus, so reuse one unigram table built from all
  // captures (sortCapturesByCurriculum already built one internally; here we
  // recompute against the full set for the stamp - cheap, O(N*tokens)).
  let complexityById = null;
  if (wantCurriculum) {
    complexityById = new Map();
    const allCaptures = orderedPairs.map(_pairToCapture);
    // Build the shared table so every stamp scores against the same corpus.
    const { table, total } = buildUnigramTable(allCaptures);
    for (let i = 0; i < orderedPairs.length; i++) {
      const cap = _pairToCapture(orderedPairs[i], i);
      const score = complexityProxy(cap, { unigramTable: table, totalTokens: total }).score;
      complexityById.set(cap.capture_id, score);
    }
    ordering_meta.complexity_stamped = true;
  }

  fs.writeFileSync(seedsPath, orderedPairs.map((p, i) => {
    const id = p.event_id || `pair_${i + 1}`;
    const row = { id, input: p.prompt, output: p.response };
    if (complexityById && complexityById.has(id)) {
      row.complexity_proxy = complexityById.get(id);
    }
    return JSON.stringify(row);
  }).join('\n') + '\n');

  // Emit the importance-weights JSONL (one row per pair) when importance is
  // active. Uses the rolling-window novelty scorer so the contract matches
  // src/capture-importance.js::buildImportanceJsonlRows exactly.
  if (wantImportance) {
    importanceWeightsPath = path.join(runDir, 'importance-weights.jsonl');
    const win = createScorerWindow(Math.max(1000, orderedPairs.length));
    const lines = [];
    for (let i = 0; i < orderedPairs.length; i++) {
      const cap = _pairToCapture(orderedPairs[i], i);
      const r = win.score(cap);
      const importance = Math.max(0, Math.min(1, r.score));
      lines.push(JSON.stringify({ capture_id: cap.capture_id, importance }));
    }
    fs.writeFileSync(importanceWeightsPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    ordering_meta.importance_weights = true;
  }

  return { specPath, seedsPath, outDir, importanceWeightsPath, ordering_meta };
}

// Main distill iterator. Yields progress events as the worker runs and a
// final {done:true, ...} envelope. For stub/collect modes the iterator
// synthesizes a handful of progress events from the worker manifest;
// for full mode it tails the worker's stdout log.
// W422 P0-4 - pure-helper that resolves the tenant scope for distill().
// Accepts `tenant_id` (canonical) or `tenant` (shorthand alias used by route
// handlers that pass req.tenant_record.id directly). When neither is supplied
// we default to `'local'` so the existing local CLI / dev-loop callers keep
// working without invasive call-site changes - this matches the rest of the
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
  tenant_id = null,                // W422 P0-4 - canonical tenant scope
  tenant = null,                   // W422 P0-4 - shorthand alias for tenant_id
  teacher_fallback = true,         // W459 - auto-retry with next teacher
  resume_from = null,              // W459 - resume a prior run_<id>
  // W787 - compute-efficiency knobs (default off; see normalizeEfficiencyOptions).
  precision_mode = null,
  gradient_checkpointing = null,
  early_stop_config = null,
  // W713/W711 - curriculum ordering + importance weighting knobs (default off);
  // resolved by _resolveOrderingPolicy (see the body for the full contract).
  curriculum = null,
  importance = null,
} = {}) {
  if (!MODES.includes(pipeline_mode)) {
    throw new Error(`pipeline_mode must be one of [${MODES.join(', ')}]`);
  }
  if (!student_base) throw new Error('distill requires {student_base}');
  // W787 - normalise the compute-efficiency block ONCE up front. Throws on a
  // bogus precision_mode (caller bug) BEFORE any worker spawn. Safe to call
  // with all-nulls - defaults to bf16 + no grad-checkpoint + no early-stop.
  const _efficiencyRequested = (precision_mode != null) || (gradient_checkpointing != null) || (early_stop_config != null);
  const _efficiency = _efficiencyRequested
    ? normalizeEfficiencyOptions({
        precision_mode: precision_mode == null ? undefined : precision_mode,
        gradient_checkpointing: gradient_checkpointing == null ? undefined : gradient_checkpointing,
        early_stop_config: early_stop_config == null ? undefined : early_stop_config,
      })
    : null;
  const _efficiencyEnv = _efficiency ? buildEfficiencyEnv(_efficiency) : {};
  // W713/W711 - resolve the data-ordering policy ONCE up front (env or recipe
  // knob). Off by default; see _resolveOrderingPolicy.
  const _ordering = _resolveOrderingPolicy({ curriculum, importance });
  const jobId = 'distill_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  // W422 P0-4 - resolve the tenant scope BEFORE any corpus read. The audit
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
  // W411 P0 #8 - fail-closed holdout enforcement at the distill() boundary.
  // Even if the caller hand-built pairs_override and slipped a holdout_only
  // row in (test fixture mistake, recipe-gen include, re-augmentation), we
  // refuse to feed it to the worker. This is the LAST chokepoint before the
  // seeds.jsonl write; nothing downstream re-checks.
  const _holdoutBefore = pairs.length;
  pairs = pairs.filter((p) => !(p && p.holdout_only));
  const holdout_excluded_count = _holdoutBefore - pairs.length;
  // 2. Resolve mode + teacher list (W459 - fallback-aware).
  const { mode: workerMode } = _resolveWorkerMode();
  const teacherList = teacher_fallback ? _pickTeachers() : (() => {
    const one = _pickTeacher();
    return one ? [one] : [];
  })();
  // Stub mode has no teacher; preserve the historical [null] shape so the
  // attempt loop runs exactly once. teacher_fallback=false also collapses
  // to single-shot (operator opted out of retry).
  const attemptList = teacherList.length ? teacherList : [null];
  // 3. Stage worker inputs.
  // W459 - when resume_from is set, reuse the prior run_<id> directory
  // verbatim (same seeds.jsonl, same spec.json), append new progress to the
  // existing progress.jsonl, and skip forward in the synthetic step counter
  // to where the prior run left off. Resume is by-design tenant-local - 
  // the caller is responsible for matching tenant_id; mismatches yield an
  // error rather than silently rebinding.
  let runDir;
  let resumeMeta = null;
  let resumePriorSteps = 0;
  if (resume_from) {
    if (typeof resume_from !== 'string' || !/^run_[a-z0-9_]+$/i.test(resume_from)) {
      throw new Error(`distill resume_from must match /^run_[a-z0-9_]+$/i (got ${JSON.stringify(resume_from)})`);
    }
    runDir = path.join(_kolmDir(), 'distill-runs', resume_from);
    if (!fs.existsSync(runDir)) {
      throw new Error(`distill resume_from: run dir ${runDir} does not exist`);
    }
    const metaPath = path.join(runDir, 'run-meta.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error(`distill resume_from: run-meta.json missing under ${runDir}`);
    }
    try { resumeMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) {
      throw new Error(`distill resume_from: run-meta.json unreadable: ${e.message}`);
    }
    if (String(resumeMeta.tenant_id || 'local') !== String(resolvedTenant)) {
      throw new Error(`distill resume_from: tenant mismatch (run is ${resumeMeta.tenant_id}, caller is ${resolvedTenant})`);
    }
    // Count prior synthetic steps in the existing progress.jsonl so the
    // resumed iteration picks up where the previous run left off.
    try {
      const prog = fs.readFileSync(path.join(runDir, 'progress.jsonl'), 'utf8')
        .split('\n').filter(Boolean);
      resumePriorSteps = prog.length;
    } catch (_) {} // deliberate: cleanup
  } else {
    runDir = _distillRunDir();
  }
  // W459 - make sure runDir exists before any in-runDir writes (run-meta,
  // progress.jsonl, log). _distillRunDir() only creates the parent base dir;
  // without this mkdir the first writes below silently fail under try/catch.
  fs.mkdirSync(runDir, { recursive: true });
  // W455 - persist a run-meta file so /v1/distill/runs can list the run
  // without re-deriving everything from the worker manifest. Tenant + ns
  // + base + ts so the list view tells the user what they were training.
  // W459 - record the planned teacher attempt list so the run is auditable
  // even before any worker has reported back which teacher won.
  // W708-2 - teacher-source policy stamps. teacher_source is the chosen
  // teacher's classification (open-weights | proprietary | unknown); when no
  // teacher is wired (stub mode) it is null so downstream readers can
  // distinguish "no teacher" from "teacher classification unknown".
  // policy_enforced records whether KOLM_TEACHER_SOURCE=open-weights was set
  // at the time of the run - useful for after-the-fact auditing.
  const _firstTeacher = attemptList[0] || null;
  const teacher_source = _firstTeacher ? classifyTeacher(_firstTeacher) : null;
  const policy_enforced = process.env.KOLM_TEACHER_SOURCE === 'open-weights';
  // W718 - stamp Teacher Council choice when the council was invoked. We
  // detect activation either by env (KOLM_TEACHER_COUNCIL=1) or by a non-null
  // selection result passed via opts. Stamping is best-effort: a stamp failure
  // never blocks the distill run.
  let teacher_council_choice = null;
  let teacher_council_weights = null;
  if (process.env.KOLM_TEACHER_COUNCIL === '1' && attemptList.length > 0) {
    try {
      const { selectTeacherForCapture } = await import('./teacher-council.js');
      const { TeacherReliabilityTable, defaultPersistPath } = await import('./teacher-weights.js');
      const reliability = TeacherReliabilityTable.load(defaultPersistPath());
      // Use the first pair (representative capture) for the council choice; the
      // per-capture stamping happens in the Python trainer when full logit
      // blending kicks in.
      const sampleCapture = pairs[0] || { namespace: teacher_namespace };
      const selection = selectTeacherForCapture(attemptList, sampleCapture, reliability);
      teacher_council_choice = selection.teacher;
      teacher_council_weights = selection.weights;
    } catch (_) {} // deliberate: cleanup
  }
  try {
    fs.writeFileSync(path.join(runDir, 'run-meta.json'), JSON.stringify({
      job_id: jobId,
      tenant_id: resolvedTenant,
      namespace: teacher_namespace || null,
      student_base,
      pipeline_mode,
      pair_count: pairs.length,
      worker_mode: workerMode,
      teacher: attemptList[0] || null,
      teacher_planned: attemptList,
      teacher_source,
      policy_enforced,
      teacher_council_choice,
      teacher_council_weights,
      resume_from: resume_from || null,
      // W787 - record the normalised efficiency block so a downstream auditor
      // (or `kolm distill runs <id>`) can answer "was bf16 + grad_checkpoint
      // used on this run?" without reading the worker log. Null when no
      // efficiency knobs were passed (existing-caller compat).
      efficiency: _efficiency,
      // W713/W711 - the resolved data-ordering policy for this run.
      // curriculum is null|'ascending'|'descending'; importance is boolean.
      ordering: { curriculum: _ordering.curriculum, importance: _ordering.importance },
      created_at: new Date().toISOString(),
    }, null, 2));
  } catch (_) {} // deliberate: cleanup
  // W455 - open progress.jsonl for per-step loss telemetry. Each yielded
  // event is also appended here so /v1/distill/runs/:id can reconstruct
  // the loss curve. Best-effort: a failed write does not block the run.
  let progressFd = null;
  const progressPath = path.join(runDir, 'progress.jsonl');
  try { progressFd = fs.openSync(progressPath, 'a'); } catch (_) {} // deliberate: cleanup
  // W459 - when resume_from is set, reuse the existing seeds.jsonl + spec.json
  // verbatim (the prior run already paid the IO cost). Otherwise stage fresh
  // worker inputs from this run's pairs.
  let specPath, seedsPath, outDir;
  let importanceWeightsPath = null;
  let orderingMeta = null;
  if (resume_from) {
    specPath = path.join(runDir, 'spec.json');
    seedsPath = path.join(runDir, 'seeds.jsonl');
    outDir = path.join(runDir, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    // W711 - a resumed run reuses the prior seeds + importance-weights.jsonl
    // verbatim (the prior run already staged them). Re-resolve the path so the
    // worker argv below still points the trainer at it.
    if (_ordering.importance) {
      const iw = path.join(runDir, 'importance-weights.jsonl');
      if (fs.existsSync(iw)) importanceWeightsPath = iw;
    }
    // Yield resume marker so iterator consumers can show "resumed from X".
    yield { resume: true, prev_steps: resumePriorSteps, run_id: resume_from };
  } else {
    const staged = _writeWorkerInputs({
      runDir, namespace: teacher_namespace, pairs, baseModel: student_base, jobId,
      ordering: _ordering,
    });
    specPath = staged.specPath;
    seedsPath = staged.seedsPath;
    outDir = staged.outDir;
    importanceWeightsPath = staged.importanceWeightsPath;
    orderingMeta = staged.ordering_meta;
  }
  const worker = worker_cmd || process.env.KOLM_DISTILL_WORKER_CMD || DEFAULT_WORKER;
  const logPath = path.join(runDir, 'distill.log');
  const start = Date.now();
  let step = resumePriorSteps;
  let kAccum = 0.5;
  // W459 - try each teacher in attemptList until one succeeds. A "success"
  // means: worker exit code === 0 AND a manifest.json was written without a
  // `teacher_error` field. On failure (rate-limit, transient API error,
  // revoked key, worker crash) we record the attempt and roll to the next
  // teacher. If the loop exhausts every teacher we surface the final attempt's
  // exit + manifest so the caller can inspect the failure chain.
  const teacher_attempts = [];
  let teacher_used = null;
  let workerManifest = null;
  let exitInfo = null;
  for (let attemptIdx = 0; attemptIdx < attemptList.length; attemptIdx++) {
    const teacher = attemptList[attemptIdx];
    // Per-attempt: clean the manifest from a prior failed attempt so the
    // load check below reflects only this attempt's worker output.
    const manifestPath = path.join(outDir, 'manifest.json');
    if (attemptIdx > 0) {
      try { fs.unlinkSync(manifestPath); } catch (_) {} // deliberate: cleanup
    }
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
    // W713 - tell the worker (and the Python trainer it spawns) to walk the
    // staged rows in curriculum order via a SequentialSampler. The staged
    // seeds.jsonl already carries complexity_proxy + is pre-ordered.
    if (_ordering.curriculum) args.push(`--curriculum=${_ordering.curriculum}`);
    // W711 - point the trainer's WeightedRandomSampler at the sibling
    // importance-weights.jsonl we staged next to seeds.jsonl.
    if (_ordering.importance && importanceWeightsPath) {
      args.push(`--importance-weights=${importanceWeightsPath}`);
    }
    // Spawn detached so the parent can move on while the worker runs.
    const logFd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      // W787 - efficiencyEnv adds KOLM_PRECISION + KOLM_GRAD_CHECKPOINT +
      // KOLM_EARLY_STOP_* so the worker (and the Python trainer it spawns)
      // pick up the caller's compute-efficiency choice. Empty object when
      // no efficiency knobs were passed, so the spread is a no-op.
      env: { ...process.env, ..._efficiencyEnv, KOLM_JOB_ID: jobId, KOLM_DISTILL_ATTEMPT: String(attemptIdx + 1) },
      windowsHide: true,
    });
    if (typeof child.unref === 'function') child.unref();
    // Synthetic progress: yield a few k/loss events so the iterator surface
    // is uniform across stub/collect/full modes (stub mode finishes in ~50ms).
    // On a retry we keep the synthetic step counter monotonic - the previous
    // attempt's events already shipped to consumers + progress.jsonl.
    const stepCap = Math.min(max_steps, 10);
    for (let i = 0; i < stepCap; i++) {
      if (emit_progress_every <= 0) break;
      step += 1;
      kAccum = Math.min(k_target + 0.05, kAccum + (k_target - kAccum) / 3);
      const evt = {
        step,
        loss: Math.round((1 - kAccum) * 1000) / 1000,
        k_score: Math.round(kAccum * 1000) / 1000,
        ts: new Date().toISOString(),
        attempt: attemptIdx + 1,
        // W-6 - these per-step values are PROJECTED (interpolated toward the
        // target), NOT measured by the trainer. Mark them structurally so no
        // consumer renders them as a real training-loss curve. The only real
        // loss is the trainer-emitted loss in the run manifest (see
        // resolveDistillFinalLoss).
        loss_source: 'synthetic',
        k_source: 'projected',
      };
      if (progressFd !== null) {
        try { fs.writeSync(progressFd, JSON.stringify(evt) + '\n'); } catch (_) {} // deliberate: cleanup
      }
      yield evt;
    }
    // Drain.
    const attemptExit = await new Promise((resolve) => {
      let resolved = false;
      const finish = (code, signal) => {
        if (resolved) return;
        resolved = true;
        try { fs.closeSync(logFd); } catch {} // deliberate: cleanup
        resolve({ code, signal: signal || null });
      };
      if (typeof child.on === 'function') {
        child.on('exit', (code, signal) => finish(code, signal));
        child.on('error', () => finish(2, null));
      } else {
        finish(0, null);
      }
      const deadlineMs = workerMode === 'full' ? 600_000 : 90_000;
      setTimeout(() => finish(null, 'timeout'), deadlineMs).unref?.();
    });
    // Load + classify this attempt's manifest.
    let attemptManifest = null;
    if (fs.existsSync(manifestPath)) {
      try { attemptManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {} // deliberate: cleanup
    }
    const hadTeacherError = !!(attemptManifest && attemptManifest.teacher_error);
    const cleanExit = attemptExit.code === 0;
    const ok = cleanExit && !hadTeacherError;
    teacher_attempts.push({
      attempt: attemptIdx + 1,
      teacher,
      exit: attemptExit,
      teacher_error: attemptManifest && attemptManifest.teacher_error ? attemptManifest.teacher_error : null,
      ok,
    });
    if (ok) {
      teacher_used = teacher;
      workerManifest = attemptManifest;
      exitInfo = attemptExit;
      break;
    }
    // Failed - try the next teacher (if any remain).
    workerManifest = attemptManifest;
    exitInfo = attemptExit;
  }
  // W455 - close progress.jsonl after the attempt loop finishes (success or
  // exhaustion). All synthetic events from every attempt have been appended.
  if (progressFd !== null) { try { fs.closeSync(progressFd); } catch (_) {} } // deliberate: cleanup
  // W708-2 - stamp the WINNING teacher's source classification onto the worker
  // manifest so the .kolm artifact carries the policy enum end-to-end. The
  // manifest may already exist on disk (worker wrote it); we re-write it with
  // the added fields so a verifier reading the .kolm receipt chain sees
  // teacher_source + policy_enforced inline. Best-effort - a stamp failure
  // must not invalidate an otherwise successful distill run.
  const _winningTeacher = teacher_used || (attemptList[0] || null);
  const teacher_source_final = _winningTeacher ? classifyTeacher(_winningTeacher) : null;
  if (workerManifest && typeof workerManifest === 'object') {
    workerManifest.teacher_source = teacher_source_final;
    workerManifest.policy_enforced = policy_enforced;
    try {
      const manifestPath = path.join(outDir, 'manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify(workerManifest, null, 2));
    } catch (_) {} // deliberate: cleanup
  }
  // The artifact_path is the worker's out dir (the .kolm itself is built by
  // src/compile-pipeline.js in the bundle phase - distill yields the path to
  // the training pairs / student weights, not a sealed .kolm).
  const studentPath = path.join(outDir, 'student');
  // W808-5 - Post-distillation regression gate. Final pipeline step. Compares
  // the just-finished run against the prior artifact (if one exists for the
  // same namespace) and produces a verdict block on the done envelope. The
  // gate is non-fatal: it ANNOUNCES a regression but the caller decides
  // whether to roll back (the compile-pipeline + ship-pipeline read the
  // regression_gate.verdict to make the rollback decision).
  //
  // Wired here at the END of distill() - does NOT touch the W459 teacher-
  // attempt logic, the W711 importance weighting, the W713 curriculum hook,
  // or the W714 holdout-exclusion chokepoint. Safe to remove the W808 block
  // by deleting these four lines + the function definition below.
  let _w808_gate = null;
  try {
    _w808_gate = _w808RegressionGate({
      run_dir: outDir,
      namespace: teacher_namespace || namespace || null,
      tenant_id,
      manifest: workerManifest,
    });
  } catch (e) {
    _w808_gate = { ok: false, error: 'w808_gate_threw', detail: String(e && e.message || e), version: 'w808-v1' };
  }
  // W832 - append one meta-training row per successful distill. Best-effort:
  // any failure here MUST NOT break the distill run (the meta-model is a
  // hint, not a critical path). Features are derived from what we already
  // have on the worker manifest + the resolved tenant; observed.kscore is
  // pulled from the W808 gate so we don't re-read the manifest.
  try {
    const _winningTeacher_w832 = teacher_used || (attemptList[0] || null);
    const _teacher_source_w832 = _winningTeacher_w832 ? classifyTeacher(_winningTeacher_w832) : 'unknown';
    const _features_w832 = {
      capture_count: pairs.length,
      capture_diversity: 0,
      avg_input_tokens: 0,
      avg_output_tokens: 0,
      teacher_class: _teacher_source_w832,
      task_type: pipeline_mode || 'kd_softmax',
      hw_tier: String(process.env.KOLM_HW_TIER || 'unknown'),
      has_reasoning: 0,
      has_tool_use: 0,
      has_multimodal: 0,
    };
    const _kscore_w832 = _w808_gate && Number.isFinite(Number(_w808_gate.candidate_kscore))
      ? Number(_w808_gate.candidate_kscore)
      : null;
    const _compile_time_w832 = (Date.now() - start) / 1000;
    const _failure_modes_w832 = [];
    if (_w808_gate && _w808_gate.error === 'no_candidate_kscore') _failure_modes_w832.push('no_kscore');
    if (workerManifest && workerManifest.teacher_error) _failure_modes_w832.push('teacher_error');
    if (exitInfo && exitInfo.code !== 0) _failure_modes_w832.push('worker_nonzero_exit');
    const _metaMod = await import('./kolm-meta-trainer.js').catch(() => null);
    if (_metaMod && _metaMod.appendTrainingRow) {
      _metaMod.appendTrainingRow({
        tenant_id: resolvedTenant,
        run_id: path.basename(outDir),
        features: _features_w832,
        observed: {
          kscore: _kscore_w832,
          compile_time_s: _compile_time_w832,
          failure_modes: _failure_modes_w832,
        },
      });
    }
  } catch (_) { /* W832 row emission is best-effort */ }
  yield {
    done: true,
    artifact_path: outDir,
    student_path: fs.existsSync(studentPath) ? studentPath : null,
    distill_log_path: logPath,
    worker_mode: workerMode,
    pipeline_mode,
    // W459 - `teacher` is the winning teacher (first one whose worker exited
    // clean). `teacher_used` is the same value, exposed under both names so
    // callers reading `done.teacher` (pre-W459) and `done.teacher_used`
    // (W459+) both see the right value.
    teacher: teacher_used,
    teacher_used,
    // W708-2 - stamp open-weights vs proprietary classification on the done
    // envelope so callers reading the iterator output (without re-reading the
    // worker manifest from disk) see the policy verdict inline.
    teacher_source: teacher_source_final,
    policy_enforced,
    teacher_attempts,
    teacher_attempted_count: teacher_attempts.length,
    pair_count: pairs.length,
    resumed_from: resume_from || null,
    resume_prior_steps: resumePriorSteps,
    // W411 P0 #8 - how many pairs the distill() boundary refused as
    // holdout_only. Compile-pipeline forwards this into the seed_provenance
    // block of the .kolm receipt so a verifier can confirm the chokepoint
    // fired.
    holdout_excluded_count,
    // W713/W711 - what the staging step actually stamped. ordering_meta is
    // null on a resumed run (seeds were staged by the prior run); the resolved
    // policy still lives on run-meta.json's `ordering` block.
    ordering: { curriculum: _ordering.curriculum, importance: _ordering.importance },
    ordering_meta: orderingMeta,
    exit: exitInfo,
    manifest: workerManifest,
    duration_ms: Date.now() - start,
    // W808-5 - regression-gate verdict block (see _w808RegressionGate below).
    w808_regression_gate: _w808_gate,
  };
}

// W455 - distill-runs read surface for /v1/distill/runs + the
// /account/distill-runs page. Each run is a directory under
// ~/.kolm/distill-runs/run_<...>/ written by distill() above; the
// run-meta.json + progress.jsonl + manifest.json files give the list view
// everything it needs (tenant scope, namespace, base, ts, exit, loss curve).
//
// Tenant scoping: listDistillRuns({tenant_id}) ALWAYS filters by tenant_id
// - never returns a cross-tenant view. The audit-2026-05-19 tenant-leak
// rule applies (canonical key is `tenant_id`).

// W-6 - the display contract for a distill run's final loss. The per-step
// progress curve is PROJECTED (interpolated, see the distill generator), so it
// must never be shown as a measured result. Prefer the trainer's real measured
// loss from the run manifest; if absent, return null with an explicit source
// rather than promoting a synthetic step's loss to "final". This is what kills
// the "synthetic loss curve presented as training telemetry" theater.
export function resolveDistillFinalLoss(manifest, lastStep) {
  // Only an actual finite number counts as measured. (Number(null)===0, so
  // coercing would fabricate a 0.0 loss for a run that has no manifest.)
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const measured =
    num(manifest && manifest.loss_final) ??
    num(manifest && manifest.final_loss) ??
    num(manifest && manifest.metrics && manifest.metrics.loss) ??
    num(manifest && manifest.eval && manifest.eval.loss);
  if (Number.isFinite(measured)) return { loss: measured, source: 'measured' };
  if (lastStep && Number.isFinite(Number(lastStep.loss))) return { loss: null, source: 'synthetic_suppressed' };
  return { loss: null, source: 'unavailable' };
}

export function listDistillRuns({ tenant_id = 'local', limit = 100, namespace = null } = {}) {
  const base = path.join(_kolmDir(), 'distill-runs');
  let entries = [];
  try { entries = fs.readdirSync(base); } catch (_) { return []; }
  const runs = [];
  for (const name of entries) {
    if (!name.startsWith('run_')) continue;
    const runDir = path.join(base, name);
    const metaPath = path.join(runDir, 'run-meta.json');
    if (!fs.existsSync(metaPath)) continue;
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { continue; }
    if (!meta) continue;
    // Tenant scope - fail closed if the run-meta has no tenant_id field
    // (older runs pre-W455 carry no tenant tag, so we treat them as local).
    const runTenant = meta.tenant_id || 'local';
    if (String(runTenant) !== String(tenant_id)) continue;
    if (namespace && meta.namespace && String(meta.namespace) !== String(namespace)) continue;
    // Derive last-loss + k_final from progress.jsonl tail (best-effort).
    let last = null;
    let stepCount = 0;
    try {
      const prog = fs.readFileSync(path.join(runDir, 'progress.jsonl'), 'utf8')
        .split('\n').filter(Boolean);
      stepCount = prog.length;
      if (stepCount > 0) last = JSON.parse(prog[prog.length - 1]);
    } catch (_) {} // deliberate: cleanup
    // Manifest tells us exit + duration if available.
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); } catch (_) {} // deliberate: cleanup
    runs.push({
      id: name,
      run_dir: runDir,
      tenant_id: runTenant,
      job_id: meta.job_id || null,
      namespace: meta.namespace,
      student_base: meta.student_base,
      pipeline_mode: meta.pipeline_mode,
      pair_count: meta.pair_count,
      worker_mode: meta.worker_mode,
      teacher: meta.teacher,
      created_at: meta.created_at,
      step_count: stepCount,
      // W-6 - measured final loss from the trainer manifest, or null. NEVER the
      // synthetic last-step loss. `k_final` stays available but is explicitly
      // marked projected so the UI does not render it as a measured score.
      ...(() => {
        const { loss, source } = resolveDistillFinalLoss(manifest, last);
        return { loss_final: loss, loss_source: source };
      })(),
      k_final: last ? last.k_score : null,
      k_source: last ? 'projected' : null,
      manifest_present: !!manifest,
    });
  }
  // Newest first.
  runs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return runs.slice(0, Math.max(1, limit));
}

export function readDistillRun(id, { tenant_id = 'local' } = {}) {
  if (!id || typeof id !== 'string' || !/^run_[a-z0-9_]+$/i.test(id)) return null;
  const runDir = path.join(_kolmDir(), 'distill-runs', id);
  const metaPath = path.join(runDir, 'run-meta.json');
  if (!fs.existsSync(metaPath)) return null;
  let meta = null;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { return null; }
  const runTenant = meta.tenant_id || 'local';
  if (String(runTenant) !== String(tenant_id)) return null;
  // Loss curve.
  const progress = [];
  try {
    const lines = fs.readFileSync(path.join(runDir, 'progress.jsonl'), 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try { progress.push(JSON.parse(line)); } catch (_) {} // deliberate: cleanup
    }
  } catch (_) {} // deliberate: cleanup
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'manifest.json'), 'utf8')); } catch (_) {} // deliberate: cleanup
  return {
    id,
    run_dir: runDir,
    meta,
    progress,
    manifest,
    log_tail: _safeTail(path.join(runDir, 'distill.log'), 4096),
  };
}

function _safeTail(p, bytes) {
  try {
    const stat = fs.statSync(p);
    const sz = stat.size;
    if (sz === 0) return '';
    const fd = fs.openSync(p, 'r');
    const start = Math.max(0, sz - bytes);
    const buf = Buffer.alloc(sz - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (_) { return ''; }
}

// =============================================================================
// W808-5 - Post-distillation regression gate.
//
// After the worker exits + the run-meta is finalized, compare the just-shipped
// run's K-Score + critical_fail_rate against the prior run in the SAME
// (tenant_id, namespace). If the candidate degrades by more than the
// thresholds below, the verdict is 'rollback'; the caller (compile-pipeline /
// ship-pipeline) reads w808_regression_gate.verdict and decides whether to
// halt the ship.
//
// Thresholds (per master plan W808-5):
//   - K-Score drop > 0.02  → rollback
//   - critical_fail_rate increase > 0.01 (1pp) → rollback
//   - Otherwise → 'promote'
//
// Honest envelope: if no prior run exists for this namespace, returns
// { ok:true, verdict:'first_run', ... } - the first ship of a namespace is
// always allowed (no baseline to regress against). If the candidate's
// K-Score is missing, returns { ok:false, error:'no_candidate_kscore' } and
// the caller treats that as 'needs_human'.
//
// Intentionally DOES NOT touch the W459/W711/W713/W714 hooks above - this
// is a pure read-only verdict computation off the run-meta + prior run.
// Wired into distill() above by the four-line _w808_gate block before the
// final yield.
// =============================================================================

export const W808_REGRESSION_GATE_VERSION = 'w808-v1';
export const W808_KSCORE_DROP_THRESHOLD = 0.02;
export const W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD = 0.01;

export function _w808RegressionGate({ run_dir, namespace, tenant_id = 'local', manifest = null } = {}) {
  const candidate_kscore = _w808ExtractKscoreFromRunDir(run_dir, manifest);
  const candidate_cfr = _w808ExtractCriticalFailRate(run_dir, manifest);
  // Find the prior run in the same namespace + tenant - newest BEFORE the
  // run we just finished.
  const allRuns = listDistillRuns({ tenant_id, limit: 200, namespace });
  // Drop the current run from the list (it appears as the newest entry).
  const candidateId = path.basename(run_dir || '');
  const prior = allRuns.filter(r => r.id !== candidateId)[0] || null;
  if (candidate_kscore == null) {
    return {
      ok: false,
      verdict: 'needs_human',
      error: 'no_candidate_kscore',
      candidate_kscore: null,
      prior_kscore: prior ? prior.k_final : null,
      hint: 'distill worker did not emit a k_score in progress.jsonl or manifest.json',
      version: W808_REGRESSION_GATE_VERSION,
    };
  }
  if (!prior) {
    return {
      ok: true,
      verdict: 'first_run',
      candidate_kscore,
      candidate_critical_fail_rate: candidate_cfr,
      prior_kscore: null,
      prior_run_id: null,
      hint: 'no prior artifact in this namespace - first run always allowed',
      kscore_drop_threshold: W808_KSCORE_DROP_THRESHOLD,
      critical_fail_rate_increase_threshold: W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD,
      version: W808_REGRESSION_GATE_VERSION,
    };
  }
  const prior_kscore = Number.isFinite(prior.k_final) ? Number(prior.k_final) : null;
  if (prior_kscore == null) {
    return {
      ok: true,
      verdict: 'first_run', // no comparable prior - treat as first comparable run
      candidate_kscore,
      candidate_critical_fail_rate: candidate_cfr,
      prior_kscore: null,
      prior_run_id: prior.id,
      hint: 'prior run has no k_final; treating as no comparable baseline',
      kscore_drop_threshold: W808_KSCORE_DROP_THRESHOLD,
      critical_fail_rate_increase_threshold: W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD,
      version: W808_REGRESSION_GATE_VERSION,
    };
  }
  // Read prior critical_fail_rate (best-effort; defaults to 0 when absent).
  const prior_full = readDistillRun(prior.id, { tenant_id });
  const prior_cfr = prior_full && prior_full.manifest && Number.isFinite(prior_full.manifest.critical_fail_rate)
    ? Number(prior_full.manifest.critical_fail_rate) : 0;
  const kscore_drop = prior_kscore - candidate_kscore;
  const cfr_increase = (Number.isFinite(candidate_cfr) ? candidate_cfr : 0) - prior_cfr;
  let verdict = 'promote';
  const reasons = [];
  if (kscore_drop > W808_KSCORE_DROP_THRESHOLD) {
    verdict = 'rollback';
    reasons.push(`k_score dropped ${kscore_drop.toFixed(4)} (prior ${prior_kscore.toFixed(4)} → candidate ${candidate_kscore.toFixed(4)}); threshold ${W808_KSCORE_DROP_THRESHOLD}`);
  }
  if (cfr_increase > W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD) {
    verdict = 'rollback';
    reasons.push(`critical_fail_rate increased ${cfr_increase.toFixed(4)} (prior ${prior_cfr.toFixed(4)} → candidate ${(candidate_cfr || 0).toFixed(4)}); threshold ${W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD}`);
  }
  return {
    ok: true,
    verdict,
    reasons,
    candidate_kscore,
    candidate_critical_fail_rate: candidate_cfr,
    prior_kscore,
    prior_critical_fail_rate: prior_cfr,
    prior_run_id: prior.id,
    kscore_drop,
    critical_fail_rate_increase: cfr_increase,
    kscore_drop_threshold: W808_KSCORE_DROP_THRESHOLD,
    critical_fail_rate_increase_threshold: W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD,
    version: W808_REGRESSION_GATE_VERSION,
  };
}

// Internal - best-effort K-Score extractor. Tries manifest.k_score_final
// first, then the last row of progress.jsonl. Returns null when absent.
function _w808ExtractKscoreFromRunDir(run_dir, manifest) {
  if (manifest && Number.isFinite(Number(manifest.k_score_final))) return Number(manifest.k_score_final);
  if (manifest && Number.isFinite(Number(manifest.k_score))) return Number(manifest.k_score);
  if (!run_dir) return null;
  try {
    const progPath = path.join(run_dir, 'progress.jsonl');
    if (!fs.existsSync(progPath)) return null;
    const lines = fs.readFileSync(progPath, 'utf8').split('\n').filter(Boolean);
    if (!lines.length) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    if (Number.isFinite(Number(last.k_score))) return Number(last.k_score);
  } catch (_) { /* fall through */ }
  return null;
}

// Internal - best-effort critical_fail_rate extractor. Returns 0 when absent
// (a missing CFR is treated as "no critical failures observed").
function _w808ExtractCriticalFailRate(run_dir, manifest) {
  if (manifest && Number.isFinite(Number(manifest.critical_fail_rate))) return Number(manifest.critical_fail_rate);
  if (!run_dir) return 0;
  try {
    const cfrPath = path.join(run_dir, 'critical-fail-rate.json');
    if (fs.existsSync(cfrPath)) {
      const j = JSON.parse(fs.readFileSync(cfrPath, 'utf8'));
      if (Number.isFinite(Number(j.critical_fail_rate))) return Number(j.critical_fail_rate);
    }
  } catch (_) {} // deliberate: cleanup
  return 0;
}

export default { distill, prepareDistillCorpus, selectStudentBackbone, MODES, _resolveDistillTenant, _resolveOrderingPolicy, listDistillRuns, readDistillRun, classifyTeacher, TEACHER_SOURCE_CLASSIFICATION, _w808RegressionGate, W808_KSCORE_DROP_THRESHOLD, W808_CRITICAL_FAIL_RATE_INCREASE_THRESHOLD, W808_REGRESSION_GATE_VERSION };
