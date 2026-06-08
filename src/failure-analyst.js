// src/failure-analyst.js
//
// KOLM autopilot data engine - FAILURE ANALYST.
//
// Pipeline position: after EVALUATE produces a ship/no-ship verdict, the
// autopilot needs to know WHERE the student fails and emit exactly the
// training data that would fix those failures. This module is that bridge:
//
//   eval-*.json (data-evaluate.js shape)
//       → cluster the FAILING items by _bucketKey (src/active-learning.js)
//       → rank clusters by fail_rate, pick the worst category
//       → synthesize corrective {input, output, rationale} fix pairs for the
//         worst cluster(s)
//       → append them through appendFixPairs (src/data-augment.js) so they
//         land in the augment queue with strategy:'failure-fix' provenance,
//         feeding the next TRAIN round.
//
// We do NOT re-run the evaluator (we read the artifacts it left behind) and we
// do NOT re-implement clustering (we reuse active-learning's _bucketKey). We do
// NOT write augment-pairs.jsonl directly - every fix pair flows through
// data-augment's appendFixPairs so provenance + id minting stay centralized.
//
// A failing item = verdict score below the pass threshold. We mirror
// data-evaluate.js's FAIL_THRESHOLD (0.5) and its score-reading rule
// (item.verdict.score, falling back to a flat item.score).
//
// Fix-pair output: this module performs NO live teacher calls. When the eval
// item carries a reference/expected answer we template a corrective pair around
// that known-good answer. When it does not, we emit a clearly-templated
// corrective scaffold that names the failure so a later COLLECT step (or a
// reviewer) can fill the canonical answer. A teacher_base, when supplied, is
// recorded in the rationale as the intended synthesis source - we never call it
// here.
//
// Envelope: every exported function returns {ok:true, version:'fa-v1', ...} or
// {ok:false, error:'<snake_case>', version:'fa-v1'}. Nothing throws across the
// public API. Persistence is best-effort via src/event-store.js.

import fs from 'node:fs';
import path from 'node:path';

import * as eventStore from './event-store.js';
import { __internals as activeLearningInternals } from './active-learning.js';
import { loadEvalJsons } from './data-evaluate.js';
import { appendFixPairs } from './data-augment.js';

export const FAILURE_ANALYST_VERSION = 'fa-v1';

const PROVIDER = 'kolm_failure_analysis';
const DEFAULT_TENANT = 'tenant_local';
const DEFAULT_NAMESPACE = 'default';

// Mirror data-evaluate.js: an item "failed" when its verdict score is below
// this floor. Kept in sync deliberately so the analyst's notion of failure
// matches the evaluator's ship/no-ship math.
const FAIL_THRESHOLD = 0.5;

// Cap on how many fix pairs we mint per analyze() call so a single noisy
// cluster cannot flood the augment queue in one round. The autopilot re-runs
// each round, so the long tail still gets covered over successive cycles.
const MAX_FIX_PAIRS = 50;

// Pull the cluster-id helper from active-learning's published internals. We
// fail loudly at import time only if the contract moved - but defend at call
// time too so a missing helper degrades to a per-item bucket rather than a
// throw across the public API.
const _bucketKey =
  activeLearningInternals && typeof activeLearningInternals._bucketKey === 'function'
    ? activeLearningInternals._bucketKey
    : null;

// ---------------------------------------------------------------------------
// Persistence - EXACT mandated pattern (copied from data-feedback.js).
// Best-effort; never throws across the public API.
// ---------------------------------------------------------------------------

async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'failure-analyst/v1',
      workflow_id: workflow,
      status: 'ok',
      prompt_tokens: 0,
      completion_tokens: 0,
      feedback: JSON.stringify(payload || {}),
    });
    return { persisted: true, event_id: ev && ev.event_id };
  } catch (e) {
    return { persisted: false, error: String((e && e.message) || e) };
  }
}

// ---------------------------------------------------------------------------
// Small internals
// ---------------------------------------------------------------------------

function _tenant(t) {
  return (typeof t === 'string' && t.trim()) ? t.trim() : DEFAULT_TENANT;
}

function _namespace(ns) {
  return (typeof ns === 'string' && ns.trim()) ? ns.trim() : DEFAULT_NAMESPACE;
}

// Per-item score: prefer the evaluator's verdict.score, fall back to a flat
// item.score (mirrors data-evaluate.js:_itemScore). Returns null when neither
// is a finite number so "unscored" items are neither pass nor fail.
function _itemScore(item) {
  if (!item || typeof item !== 'object') return null;
  const v = item.verdict;
  if (v && typeof v === 'object' && Number.isFinite(Number(v.score))) return Number(v.score);
  if (Number.isFinite(Number(item.score))) return Number(item.score);
  return null;
}

function _itemQuestion(item) {
  if (!item || typeof item !== 'object') return '';
  return String(item.question || item.input || item.prompt || '');
}

// Known-good reference answer, when the artifact carries one. Mirrors the
// eval_adapter.py per-item shape (reference_answer) plus common synonyms.
function _itemReference(item) {
  if (!item || typeof item !== 'object') return '';
  const v = item.reference_answer != null ? item.reference_answer
    : item.reference != null ? item.reference
    : item.expected != null ? item.expected
    : item.gold != null ? item.gold
    : item.target != null ? item.target
    : '';
  return v == null ? '' : String(v);
}

// Build a synthetic capture-shaped object so active-learning's _bucketKey reads
// the failing item's prompt the same way it reads a live capture. _bucketKey
// prefers an explicit cluster_id, so we forward item.cluster_id when present
// (which makes the cluster id stable and human-meaningful), else it falls back
// to the prompt-hash bucket over the question text.
function _clusterOf(item) {
  const synthetic = {
    cluster_id: (item && typeof item.cluster_id === 'string' && item.cluster_id.trim())
      ? item.cluster_id.trim()
      : undefined,
    input: _itemQuestion(item),
  };
  if (_bucketKey) {
    try {
      const key = _bucketKey(synthetic);
      if (key) return String(key);
    } catch (_) {
      // _bucketKey never throws on its own; defend anyway and fall through.
    }
  }
  // Degraded fallback: a per-question key. Keeps analyze() working even if the
  // active-learning internal contract moves out from under us.
  const q = _itemQuestion(item).toLowerCase().trim();
  return q ? `cluster_q:${q.slice(0, 32)}` : 'cluster_empty';
}

// Flatten every eval artifact's results[] into one item list, tagging each with
// the bench it came from (so the rationale can name it). Items missing a
// finite score are dropped - they are neither a pass nor a fail.
function _collectItems(evalMap) {
  const items = [];
  for (const [bench, obj] of Object.entries(evalMap || {})) {
    const results = Array.isArray(obj && obj.results) ? obj.results : [];
    for (const it of results) {
      const score = _itemScore(it);
      if (score == null) continue;
      items.push({ raw: it, bench, score, failed: score < FAIL_THRESHOLD });
    }
  }
  return items;
}

// Cluster the collected items, returning a ranked summary array plus a lookup
// from cluster_id → the failing raw items in that cluster (for fix synthesis).
function _clusterItems(items) {
  const byCluster = new Map(); // cluster_id -> {n_total, failed:[], samples:[]}
  for (const entry of items) {
    const cid = _clusterOf(entry.raw);
    let bucket = byCluster.get(cid);
    if (!bucket) {
      bucket = { cluster_id: cid, n_total: 0, failed: [], samples: [] };
      byCluster.set(cid, bucket);
    }
    bucket.n_total++;
    if (entry.failed) {
      bucket.failed.push(entry);
      if (bucket.samples.length < 5) {
        const q = _itemQuestion(entry.raw).slice(0, 160);
        if (q) bucket.samples.push(q);
      }
    }
  }

  const clusters = [...byCluster.values()].map((b) => ({
    cluster_id: b.cluster_id,
    n_total: b.n_total,
    n_failed: b.failed.length,
    fail_rate: b.n_total > 0 ? Number((b.failed.length / b.n_total).toFixed(6)) : 0,
    sample_inputs: b.samples,
  }));

  // Worst category = highest fail_rate; tie-break by n_failed (a 100%-fail
  // cluster with 8 failures outranks a 100%-fail cluster with 1). Only
  // clusters that actually have a failure are eligible to be "worst".
  clusters.sort((a, b) => (b.fail_rate - a.fail_rate) || (b.n_failed - a.n_failed) || a.cluster_id.localeCompare(b.cluster_id));

  return { clusters, byCluster };
}

// Synthesize a corrective fix pair for one failing item. The corrected output
// is the item's known-good reference when present; otherwise a clearly-labeled
// corrective scaffold that names the failure so a later COLLECT step can fill
// the canonical answer. Never invents a factual answer out of thin air.
function _fixPairForItem(entry, { cluster_id, teacher_base }) {
  const item = entry.raw;
  const input = _itemQuestion(item);
  if (!input.trim()) return null;

  const reference = _itemReference(item);
  const scorePct = Number.isFinite(entry.score) ? Math.round(entry.score * 100) : null;

  let output;
  let basis;
  if (reference.trim()) {
    output = reference;
    basis = 'canonical reference answer from the eval artifact';
  } else if (teacher_base && String(teacher_base).trim()) {
    // No reference on file. We do NOT call the teacher here; we emit a scaffold
    // the COLLECT step will replace with a teacher_base-synthesized answer.
    output = `[NEEDS_TEACHER_SYNTHESIS via ${String(teacher_base).trim()}] Provide the corrected answer to: ${input}`;
    basis = `templated scaffold awaiting ${String(teacher_base).trim()} synthesis`;
  } else {
    output = `[NEEDS_CANONICAL_ANSWER] Provide the corrected answer to: ${input}`;
    basis = 'templated corrective scaffold (no reference answer on file)';
  }

  const rationale =
    `Targets worst-category cluster '${cluster_id}' (bench '${entry.bench}'); ` +
    `the evaluated model scored ${scorePct == null ? 'below the pass threshold' : scorePct + '%'} ` +
    `(< ${Math.round(FAIL_THRESHOLD * 100)}% pass floor) on this input. ` +
    `Corrective pair derived from the ${basis}.`;

  return { input, output, rationale };
}

// ---------------------------------------------------------------------------
// analyzeFailures - the public entry point.
// ---------------------------------------------------------------------------

/**
 * Read an eval result, cluster the failing items, identify the worst category,
 * and emit + append corrective fix pairs. NEVER throws.
 *
 * @param {object} args
 * @param {string} [args.tenant]        default 'tenant_local'
 * @param {string} [args.namespace]     default 'default'
 * @param {string} [args.eval_path]     a single eval-*.json file path
 * @param {string} [args.run_dir]       a run dir containing eval-*.json files
 * @param {string} [args.teacher_base]  optional teacher slug recorded as the
 *   intended synthesis source for scaffolded outputs (NOT called here)
 * @param {number} [args.max_fix_pairs] cap on emitted pairs (default 50)
 * @returns {Promise<{ok:boolean, version:string, clusters?:Array,
 *   worst_category?:object|null, fix_pairs?:Array, n_fix_pairs_written?:number,
 *   error?:string}>}
 */
export async function analyzeFailures({ tenant, namespace, eval_path, run_dir, teacher_base, max_fix_pairs } = {}) {
  const tn = _tenant(tenant);
  const ns = _namespace(namespace);
  try {
    // 1. Resolve the eval artifact(s) into the data-evaluate.js {bench: obj} map.
    let evalMap = {};
    if (typeof eval_path === 'string' && eval_path.trim()) {
      let obj;
      try {
        obj = JSON.parse(fs.readFileSync(eval_path, 'utf8'));
      } catch (e) {
        return { ok: false, error: 'eval_path_unreadable', version: FAILURE_ANALYST_VERSION };
      }
      if (!obj || typeof obj !== 'object') {
        return { ok: false, error: 'eval_path_malformed', version: FAILURE_ANALYST_VERSION };
      }
      // Derive a bench name from the file the same way data-evaluate.js does.
      const base = path.basename(eval_path);
      const m = base.match(/^eval-(.+)\.json$/i);
      const bench = (obj.bench && obj.bench !== 'none') ? String(obj.bench)
        : (m ? m[1] : base.replace(/\.json$/i, ''));
      evalMap = { [bench]: obj };
    } else if (typeof run_dir === 'string' && run_dir.trim()) {
      evalMap = loadEvalJsons(run_dir);
    } else {
      return { ok: false, error: 'eval_input_required', version: FAILURE_ANALYST_VERSION };
    }

    const benchNames = Object.keys(evalMap);
    if (benchNames.length === 0) {
      return { ok: false, error: 'no_eval_artifacts', version: FAILURE_ANALYST_VERSION };
    }

    // 2. Collect + cluster items.
    const items = _collectItems(evalMap);
    if (items.length === 0) {
      return { ok: false, error: 'no_scored_items', version: FAILURE_ANALYST_VERSION };
    }
    const { clusters, byCluster } = _clusterItems(items);

    // 3. Worst category = first ranked cluster that actually has a failure.
    const worstEntry = clusters.find((c) => c.n_failed > 0) || null;
    const worst_category = worstEntry
      ? { cluster_id: worstEntry.cluster_id, fail_rate: worstEntry.fail_rate, n_failed: worstEntry.n_failed }
      : null;

    // 4. Synthesize fix pairs for the worst cluster's failing items.
    const cap = Number.isFinite(Number(max_fix_pairs))
      ? Math.max(0, Math.trunc(Number(max_fix_pairs)))
      : MAX_FIX_PAIRS;
    const fix_pairs = [];
    if (worst_category && cap > 0) {
      const bucket = byCluster.get(worst_category.cluster_id);
      const failing = bucket ? bucket.failed : [];
      for (const entry of failing) {
        if (fix_pairs.length >= cap) break;
        const fp = _fixPairForItem(entry, {
          cluster_id: worst_category.cluster_id,
          teacher_base,
        });
        if (fp) fix_pairs.push(fp);
      }
    }

    // 5. Append fix pairs through data-augment (strategy:'failure-fix'). The
    //    write is the authoritative landing in the augment queue; if it fails
    //    we still return the analysis (best-effort), with n written = 0.
    let n_fix_pairs_written = 0;
    let append_result = null;
    if (fix_pairs.length > 0) {
      append_result = await appendFixPairs({ tenant: tn, namespace: ns, fix_pairs });
      if (append_result && append_result.ok === true && Number.isFinite(Number(append_result.n_written))) {
        n_fix_pairs_written = Number(append_result.n_written);
      }
    }

    // 6. Best-effort persist a summary row for the autopilot timeline.
    const persist = await _persist({
      tenant: tn,
      namespace: ns,
      workflow: 'autopilot:failure-analysis',
      payload: {
        benches: benchNames,
        n_items: items.length,
        n_clusters: clusters.length,
        worst_category,
        n_fix_pairs: fix_pairs.length,
        n_fix_pairs_written,
      },
    });

    return {
      ok: true,
      version: FAILURE_ANALYST_VERSION,
      clusters,
      worst_category,
      fix_pairs,
      n_fix_pairs_written,
      append: append_result,
      persist,
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).replace(/\s+/g, '_').toLowerCase(), version: FAILURE_ANALYST_VERSION };
  }
}

export default {
  FAILURE_ANALYST_VERSION,
  analyzeFailures,
};
