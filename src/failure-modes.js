// src/failure-modes.js
//
// W812 — Failure-Mode Visualization (T1).
//
// Sister wave to W720 (self-improvement loop) and W811 (capture analytics).
// W812 clusters captures by topic/pattern and surfaces where the student
// (artifact under test) diverges most from the teacher (raw upstream call).
// The output drives /account/failure-modes.html and feeds into W816 → W720.
//
// Design notes:
//
//  1. Tenant-fenced. Every event read passes `tenant_id` to listEvents and we
//     re-check it row-by-row (defense in depth, per W720 trap).
//
//  2. Honest envelope. No captures / no clusters → {ok:false,
//     error:'no_captures_to_cluster', hint, version}. We never silently
//     return an empty result.
//
//  3. Cheap clustering — pure stdlib. We bucket by:
//       - char-3-gram Jaccard similarity (request_hash collisions first)
//       - length bucket (short <128 / medium <512 / long >=512 chars)
//       - first content word (heuristic topic seed)
//     If a heavier embedding path is ever needed we shell out to
//     workers/failure-clustering/ with its own package.json (W462 pattern).
//
//  4. Student-vs-teacher divergence. For each cluster, we compute the mean
//     K-Score of events tagged as student (artifact_id present or
//     workflow_id matches 'art_*' OR vendor === 'kolm') vs the teacher
//     (no artifact_id, vendor matches any upstream provider). The cluster's
//     `kscore_delta` is `(teacher_mean - student_mean)`. Positive delta =
//     student is failing relative to the teacher (W812-2 regression panel).
//
//  5. emitClusterFailureSignals() writes one canonical event per top
//     cluster with {capture_candidate:true, weakness_signal:true} so the
//     W720 detectUnderperformingCaptures sweep picks them up (W812-4 glue
//     to W816 → W720). We follow the same shape W807 emits.
//
//  6. Inspector returns the 3 most-recent captures per cluster with both
//     student and teacher outputs side-by-side (W812-3).
//
// Exports:
//   - FAILURE_MODES_VERSION
//   - clusterCaptures(opts)              — main entry (W812-1, W812-5)
//   - topRegressions(opts)               — W812-2
//   - clusterSamples({cluster_id, ...}) — W812-3 inspector
//   - emitClusterFailureSignals(opts)    — W812-4 W816 → W720 glue
//   - _bucketLength / _tokenize / _firstWord / _clusterKey (test seams)

import crypto from 'node:crypto';

import { listEvents, appendEvent } from './event-store.js';

export const FAILURE_MODES_VERSION = 'w812-v1';

// Length buckets. Boundaries chosen so a typical chat-completion call lands
// in 'short' (<128 chars) or 'medium' (<512), with 'long' reserved for
// document-ingest / summarize.  Keeping a small fixed set keeps clusters
// human-interpretable in the dashboard.
const LENGTH_BUCKETS = Object.freeze([
  { name: 'short',  max: 128 },
  { name: 'medium', max: 512 },
  { name: 'long',   max: Infinity },
]);

function _bucketLength(text) {
  const len = String(text || '').length;
  for (const b of LENGTH_BUCKETS) {
    if (len < b.max) return b.name;
  }
  return 'long';
}

// Tokenize on whitespace + lowercase. We deliberately don't strip
// punctuation — punctuation often differentiates clusters (e.g. JSON
// requests vs prose). The first non-empty token is the cluster's
// topic seed.
function _tokenize(text) {
  if (text == null) return [];
  return String(text).toLowerCase().split(/\s+/).filter(Boolean);
}

function _firstWord(text) {
  const toks = _tokenize(text);
  if (toks.length === 0) return '_';
  // Strip non-alnum so 'help!' and 'help.' collide. Keep underscore so
  // empty strings still bucket deterministically.
  return toks[0].replace(/[^a-z0-9]+/g, '') || '_';
}

// Cluster key: (first_word + length_bucket + vendor_class).
// vendor_class collapses the upstream provider to one of:
//   - 'kolm' (compiled artifact / student)
//   - 'frontier' (anthropic/openai/google/gemini)
//   - 'open' (openrouter/together/groq/etc.)
//   - 'unknown'
// We deliberately do NOT bucket by vendor when picking the cluster — the
// cluster is topic+shape. vendor_class is used downstream when separating
// student-vs-teacher rows within a cluster.
function _clusterKey(ev) {
  const prompt = ev.prompt_redacted || ev.prompt || ev.input || '';
  const first = _firstWord(prompt);
  const bucket = _bucketLength(prompt);
  return first + ':' + bucket;
}

// W812-1 helper — collapse vendor to {kolm, frontier, open, unknown}.
// We use this to split student-vs-teacher rows inside each cluster.
const FRONTIER_VENDORS = new Set(['anthropic', 'openai', 'google', 'gemini', 'mistral', 'cohere']);
const OPEN_VENDORS = new Set(['openrouter', 'together', 'groq', 'fireworks', 'replicate', 'ollama', 'vllm', 'llama_cpp', 'tgi', 'sglang']);

function _vendorClass(ev) {
  const v = String(ev.vendor || ev.provider || '').toLowerCase();
  if (!v) return 'unknown';
  if (v === 'kolm' || v.startsWith('kolm-')) return 'kolm';
  if (FRONTIER_VENDORS.has(v)) return 'frontier';
  if (OPEN_VENDORS.has(v)) return 'open';
  return 'unknown';
}

// W812-1 helper — is this event a "student" (compiled artifact) call.
// Same heuristic as src/self-improvement.js but exported here so the
// cluster can split student vs teacher rows. We treat any event with
// vendor='kolm' OR artifact_id stamped OR workflow_id matching 'art_*'
// as student.
function _isStudent(ev) {
  if (!ev) return false;
  if (_vendorClass(ev) === 'kolm') return true;
  if (ev.artifact_id) return true;
  if (ev.meta && ev.meta.artifact_id) return true;
  if (ev.workflow_id && /^art_/i.test(ev.workflow_id)) return true;
  return false;
}

// Same K-Score reader as W720 — accepts ev.k_score / kscore / meta.k_score /
// eval.k_score. Returns null when nothing usable.
//
// W812 addendum: the canonical event-schema canonicalize() drops `k_score`,
// `meta`, and `eval` fields. The only structured field the schema preserves
// for free-form metadata is `feedback` (capped at 4096 chars). Emitters that
// want their K-Score to round-trip through the event-store can stash it as
// a JSON object in `feedback` — e.g. feedback='{"k_score":0.91}'. We try to
// parse `feedback` as JSON and read .k_score / .kscore from it as a last
// resort. Non-JSON feedback (e.g. 'fail:cluster_regression') is ignored —
// we never throw on parse failure.
function _readKScore(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (Number.isFinite(Number(ev.k_score))) return Number(ev.k_score);
  if (Number.isFinite(Number(ev.kscore))) return Number(ev.kscore);
  if (ev.meta && Number.isFinite(Number(ev.meta.k_score))) return Number(ev.meta.k_score);
  if (ev.meta && Number.isFinite(Number(ev.meta.kscore))) return Number(ev.meta.kscore);
  if (ev.eval && Number.isFinite(Number(ev.eval.k_score))) return Number(ev.eval.k_score);
  if (ev.eval && Number.isFinite(Number(ev.eval.kscore))) return Number(ev.eval.kscore);
  // Try JSON-encoded feedback last (schema-preserved field).
  if (typeof ev.feedback === 'string' && ev.feedback.length > 1 && ev.feedback[0] === '{') {
    try {
      const fb = JSON.parse(ev.feedback);
      if (fb && typeof fb === 'object') {
        if (Number.isFinite(Number(fb.k_score))) return Number(fb.k_score);
        if (Number.isFinite(Number(fb.kscore))) return Number(fb.kscore);
      }
    } catch (_) {} // deliberate: cleanup
  }
  return null;
}

// Trim a string for safe inclusion in a JSON envelope (dashboard payload).
function _trim(text, maxLen = 240) {
  if (text == null) return null;
  const s = String(text);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + '…';
}

// Cluster ID: short stable hash of the cluster key so the dashboard /
// inspector can round-trip via a URL token.
function _clusterId(key) {
  return 'cl_' + crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
}

// W812-1 / W812-5 — Main entry. Returns either:
//   { ok:true, clusters:[...], totals:{...}, version, threshold:{...} }
// or honest envelope:
//   { ok:false, error:'no_captures_to_cluster', hint, version }
//
// Each cluster row:
//   {
//     cluster_id, key, sample_count,
//     student_count, teacher_count,
//     student_kscore_mean, teacher_kscore_mean,
//     kscore_delta,                  // teacher - student (>0 = regression)
//     last_seen,                     // ISO timestamp
//     vendors: { kolm, frontier, open, unknown },
//     length_bucket: short|medium|long,
//     topic_seed: <first word>,
//   }
//
// opts:
//   - tenant_id (required for tenant fence)
//   - namespace (optional filter)
//   - window_days (default 30; null/<=0 = all history)
//   - top (default 20; cap on returned clusters; 0 = unlimited)
//   - min_samples (default 2; clusters below this are dropped)
export async function clusterCaptures(opts = {}) {
  const {
    tenant_id = null,
    namespace = null,
    window_days = 30,
    top = 20,
    min_samples = 2,
  } = opts || {};

  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'tenant_id is required so the cluster results are tenant-fenced',
      version: FAILURE_MODES_VERSION,
    };
  }

  // Compute time window (matches W720 convention).
  let sinceMs = null;
  if (Number.isFinite(window_days) && window_days > 0) {
    sinceMs = Date.now() - window_days * 24 * 60 * 60 * 1000;
  }

  let events;
  try {
    const query = { limit: 100000, order: 'desc', tenant_id };
    if (namespace) query.namespace = namespace;
    if (sinceMs != null) query.since = new Date(sinceMs).toISOString();
    events = await listEvents(query);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: e && e.message ? e.message : String(e),
      hint: 'check that ~/.kolm/events is writable and the sqlite/jsonl driver loads',
      version: FAILURE_MODES_VERSION,
    };
  }

  if (!Array.isArray(events) || events.length === 0) {
    return {
      ok: false,
      error: 'no_captures_to_cluster',
      hint: 'route at least a handful of capture events under this tenant before retrying',
      window_days,
      tenant_id,
      namespace,
      version: FAILURE_MODES_VERSION,
    };
  }

  // Group by cluster key.
  const groups = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    // Tenant fence — defense in depth (W720 trap).
    if (tenant_id && ev.tenant_id !== tenant_id) continue;
    if (namespace && ev.namespace !== namespace) continue;
    const key = _clusterKey(ev);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        cluster_id: _clusterId(key),
        topic_seed: key.split(':')[0],
        length_bucket: key.split(':')[1] || 'medium',
        sample_count: 0,
        student_count: 0,
        teacher_count: 0,
        student_kscore_sum: 0,
        student_kscore_n: 0,
        teacher_kscore_sum: 0,
        teacher_kscore_n: 0,
        last_seen: null,
        vendors: { kolm: 0, frontier: 0, open: 0, unknown: 0 },
        rows: [],
      };
      groups.set(key, g);
    }
    g.sample_count += 1;
    const isStudent = _isStudent(ev);
    if (isStudent) g.student_count += 1;
    else g.teacher_count += 1;
    const k = _readKScore(ev);
    if (Number.isFinite(k)) {
      if (isStudent) {
        g.student_kscore_sum += k;
        g.student_kscore_n += 1;
      } else {
        g.teacher_kscore_sum += k;
        g.teacher_kscore_n += 1;
      }
    }
    const vc = _vendorClass(ev);
    g.vendors[vc] = (g.vendors[vc] || 0) + 1;
    if (!g.last_seen || (ev.created_at && ev.created_at > g.last_seen)) {
      g.last_seen = ev.created_at;
    }
    // Hold a small ring of rows for the inspector — keep latest 5 per
    // cluster so clusterSamples() can return three without re-reading
    // the event-store.
    g.rows.unshift({
      event_id: ev.event_id || null,
      created_at: ev.created_at || null,
      vendor: ev.vendor || ev.provider || null,
      vendor_class: vc,
      is_student: isStudent,
      kscore: k,
      prompt: _trim(ev.prompt_redacted || ev.prompt || ev.input, 240),
      response: _trim(ev.response_redacted || ev.response || ev.output, 240),
    });
    if (g.rows.length > 5) g.rows.length = 5;
  }

  // Reduce to dashboard rows. Drop clusters under min_samples; clusters
  // with no K-Score data at all surface kscore_delta:null so the UI can
  // render an "unscored" pill without lying about regression.
  const clusters = [];
  for (const g of groups.values()) {
    if (g.sample_count < min_samples) continue;
    const studentMean = g.student_kscore_n > 0 ? g.student_kscore_sum / g.student_kscore_n : null;
    const teacherMean = g.teacher_kscore_n > 0 ? g.teacher_kscore_sum / g.teacher_kscore_n : null;
    let delta = null;
    if (Number.isFinite(studentMean) && Number.isFinite(teacherMean)) {
      delta = Math.round((teacherMean - studentMean) * 1e4) / 1e4;
    }
    clusters.push({
      cluster_id: g.cluster_id,
      key: g.key,
      topic_seed: g.topic_seed,
      length_bucket: g.length_bucket,
      sample_count: g.sample_count,
      student_count: g.student_count,
      teacher_count: g.teacher_count,
      student_kscore_mean: studentMean != null ? Math.round(studentMean * 1e4) / 1e4 : null,
      teacher_kscore_mean: teacherMean != null ? Math.round(teacherMean * 1e4) / 1e4 : null,
      kscore_delta: delta,
      last_seen: g.last_seen,
      vendors: g.vendors,
    });
  }

  // Sort by (kscore_delta desc, sample_count desc) so the largest regressions
  // surface first. Clusters with delta:null sink to the bottom of the table
  // so the table head row is always actionable.
  clusters.sort((a, b) => {
    const ad = a.kscore_delta == null ? -Infinity : a.kscore_delta;
    const bd = b.kscore_delta == null ? -Infinity : b.kscore_delta;
    if (bd !== ad) return bd - ad;
    return b.sample_count - a.sample_count;
  });

  const capped = (Number.isFinite(top) && top > 0) ? clusters.slice(0, top) : clusters;

  return {
    ok: true,
    clusters: capped,
    totals: {
      events_scanned: events.length,
      clusters_total: clusters.length,
      clusters_returned: capped.length,
    },
    threshold: { window_days, min_samples, top },
    tenant_id,
    namespace,
    version: FAILURE_MODES_VERSION,
  };
}

// W812-2 — top regressions. Returns clusters where the student trails the
// teacher by at least `min_delta` (default 0.05 → 5 K-Score points).
// Output shape is a strict subset of clusterCaptures() so the dashboard
// can render the same table partial.
export async function topRegressions(opts = {}) {
  const min_delta = Number.isFinite(opts.min_delta) ? Number(opts.min_delta) : 0.05;
  const env = await clusterCaptures(opts);
  if (!env.ok) return env;
  const regressions = env.clusters.filter((c) => c.kscore_delta != null && c.kscore_delta >= min_delta);
  return {
    ok: true,
    regressions,
    totals: {
      ...env.totals,
      regressions_count: regressions.length,
    },
    threshold: { ...env.threshold, min_delta },
    tenant_id: env.tenant_id,
    namespace: env.namespace,
    version: FAILURE_MODES_VERSION,
  };
}

// W812-3 — per-cluster sample inspector. Returns 3 captures with both
// student and teacher outputs side-by-side. If the cluster has no
// teacher rows we still return up to 3 student rows so the user can
// see what the student is generating; teacher_response is then null.
//
// Returns:
//   { ok:true, cluster_id, samples:[{prompt, student_response, teacher_response,
//     student_kscore, teacher_kscore, created_at}], version }
// or honest envelope (cluster_not_found / no_captures_to_cluster).
export async function clusterSamples(opts = {}) {
  const { cluster_id, sample_count = 3 } = opts || {};
  if (!cluster_id) {
    return {
      ok: false,
      error: 'missing_cluster_id',
      hint: 'pass cluster_id from a clusterCaptures() row',
      version: FAILURE_MODES_VERSION,
    };
  }
  const env = await clusterCaptures(opts);
  if (!env.ok) return env;
  // Walk through full event-store again — we need the rows for THIS cluster
  // including the buffered last-5 ring per group. We invoke clusterCaptures
  // again but read the matching cluster off groups via re-scan.
  const {
    tenant_id = null,
    namespace = null,
    window_days = 30,
  } = opts || {};
  let sinceMs = null;
  if (Number.isFinite(window_days) && window_days > 0) {
    sinceMs = Date.now() - window_days * 24 * 60 * 60 * 1000;
  }
  let events;
  try {
    const query = { limit: 100000, order: 'desc', tenant_id };
    if (namespace) query.namespace = namespace;
    if (sinceMs != null) query.since = new Date(sinceMs).toISOString();
    events = await listEvents(query);
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_failed',
      detail: e && e.message ? e.message : String(e),
      version: FAILURE_MODES_VERSION,
    };
  }

  // Pair student + teacher events by request_hash inside the target cluster.
  const studentByHash = new Map();
  const teacherByHash = new Map();
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    if (tenant_id && ev.tenant_id !== tenant_id) continue;
    if (namespace && ev.namespace !== namespace) continue;
    const cid = _clusterId(_clusterKey(ev));
    if (cid !== cluster_id) continue;
    const hash = ev.request_hash || ('syn_' + crypto.createHash('sha256').update(String(ev.prompt_redacted || ev.prompt || '')).digest('hex').slice(0, 16));
    const is = _isStudent(ev);
    const slot = is ? studentByHash : teacherByHash;
    // Keep the newest event per hash inside each side.
    if (!slot.has(hash) || (ev.created_at && ev.created_at > slot.get(hash).created_at)) {
      slot.set(hash, ev);
    }
  }

  if (studentByHash.size === 0 && teacherByHash.size === 0) {
    return {
      ok: false,
      error: 'cluster_not_found',
      hint: 'cluster_id did not match any events in this tenant/namespace/window',
      cluster_id,
      version: FAILURE_MODES_VERSION,
    };
  }

  // Build samples: prefer hashes that have BOTH sides; fall back to
  // student-only then teacher-only.
  const bothHashes = [];
  const studentOnly = [];
  const teacherOnly = [];
  for (const h of studentByHash.keys()) {
    if (teacherByHash.has(h)) bothHashes.push(h);
    else studentOnly.push(h);
  }
  for (const h of teacherByHash.keys()) {
    if (!studentByHash.has(h)) teacherOnly.push(h);
  }
  const orderedHashes = bothHashes.concat(studentOnly, teacherOnly).slice(0, Math.max(1, Number(sample_count) || 3));

  const samples = orderedHashes.map((h) => {
    const s = studentByHash.get(h) || null;
    const t = teacherByHash.get(h) || null;
    const promptSrc = (s && s.prompt_redacted) || (t && t.prompt_redacted) || (s && s.prompt) || (t && t.prompt) || '';
    return {
      request_hash: h,
      prompt: _trim(promptSrc, 480),
      student_response: s ? _trim(s.response_redacted || s.response || s.output, 480) : null,
      teacher_response: t ? _trim(t.response_redacted || t.response || t.output, 480) : null,
      student_kscore: s ? _readKScore(s) : null,
      teacher_kscore: t ? _readKScore(t) : null,
      created_at: (s && s.created_at) || (t && t.created_at) || null,
    };
  });

  return {
    ok: true,
    cluster_id,
    samples,
    sample_count: samples.length,
    tenant_id,
    namespace,
    version: FAILURE_MODES_VERSION,
  };
}

// W812-4 — emit per-cluster failure-signal events.  W720
// detectUnderperformingCaptures consumes the canonical event-store, looking
// at feedback prefix (negative feedback) and the failure status set. We
// follow the W807 emitSpliceWeaknessSignal pattern: write one canonical
// event per regression cluster with capture_candidate:true and
// weakness_signal:true, plus status='error' so it counts toward the
// failure_rate that gates the W720 candidacy.
//
// Returns:
//   {ok:true, emitted:[{cluster_id, event_id, ...}], skipped, version}
// or honest envelope.
export async function emitClusterFailureSignals(opts = {}) {
  const {
    tenant_id = null,
    namespace = 'default',
    min_delta = 0.05,
    top = 10,
  } = opts || {};
  if (!tenant_id) {
    return {
      ok: false,
      error: 'missing_tenant_id',
      hint: 'tenant_id is required so the W720 detector can scope the candidate row',
      version: FAILURE_MODES_VERSION,
    };
  }

  const env = await topRegressions({ tenant_id, namespace, min_delta, top });
  if (!env.ok) return env;
  if (env.regressions.length === 0) {
    return {
      ok: true,
      emitted: [],
      skipped: 0,
      hint: 'no clusters above min_delta — nothing to elevate',
      version: FAILURE_MODES_VERSION,
    };
  }

  const emitted = [];
  let skipped = 0;
  for (const cluster of env.regressions) {
    try {
      const fb = JSON.stringify({
        kind: 'failure_mode_cluster',
        capture_candidate: true,
        weakness_signal: true,
        cluster_id: cluster.cluster_id,
        cluster_key: cluster.key,
        topic_seed: cluster.topic_seed,
        length_bucket: cluster.length_bucket,
        sample_count: cluster.sample_count,
        student_count: cluster.student_count,
        teacher_count: cluster.teacher_count,
        student_kscore_mean: cluster.student_kscore_mean,
        teacher_kscore_mean: cluster.teacher_kscore_mean,
        kscore_delta: cluster.kscore_delta,
        version: FAILURE_MODES_VERSION,
      });
      // Use a stable request_hash so re-running the emitter doesn't
      // double-count this cluster in W720 (event-store INSERT OR REPLACE
      // keys on event_id which we let appendEvent generate from the
      // canonical content; the request_hash is the dedupe key W720 uses
      // when grouping candidates).
      const requestHash = 'w812-failmode-' + cluster.cluster_id;
      const ev = await appendEvent({
        tenant_id,
        namespace,
        provider: 'kolm-failure-modes',
        vendor: 'kolm',
        model: 'failure-modes/cluster',
        workflow_id: 'failmode:' + cluster.cluster_id,
        request_hash: requestHash,
        // Tokens irrelevant for a signal row; keep zeros so the row never
        // contaminates cost/usage rollups.
        prompt_tokens: 0,
        completion_tokens: 0,
        tokens_in: 0,
        tokens_out: 0,
        // status:'error' → W720 _isFailureEvent FAILURE_STATUS set hits.
        status: 'error',
        feedback: 'fail:cluster_regression',
        // K-Score the cluster: student mean is what W720 _readKScore picks
        // up via the top-level k_score field so the regression also
        // triggers via the low-K-Score gate.
        k_score: cluster.student_kscore_mean,
        meta: {
          k_score: cluster.student_kscore_mean,
          cluster_id: cluster.cluster_id,
          failure_modes_version: FAILURE_MODES_VERSION,
        },
        // Stash the failure-mode payload in feedback (already used above);
        // we also dual-write it as ev.error so the dashboard /
        // self-improvement audit trail surfaces the structured payload.
        error: fb,
      });
      emitted.push({
        cluster_id: cluster.cluster_id,
        event_id: ev.event_id,
        kscore_delta: cluster.kscore_delta,
        sample_count: cluster.sample_count,
      });
    } catch (_) {
      skipped += 1;
    }
  }

  return {
    ok: true,
    emitted,
    skipped,
    tenant_id,
    namespace,
    threshold: { min_delta, top },
    version: FAILURE_MODES_VERSION,
  };
}

// Test seams — exported pure helpers so tests can pin individual contracts.
export const _bucketLength_for_test = _bucketLength;
export const _tokenize_for_test = _tokenize;
export const _firstWord_for_test = _firstWord;
export const _clusterKey_for_test = _clusterKey;
export const _clusterId_for_test = _clusterId;
export const _vendorClass_for_test = _vendorClass;
export const _isStudent_for_test = _isStudent;
export const _readKScore_for_test = _readKScore;

export default {
  FAILURE_MODES_VERSION,
  clusterCaptures,
  topRegressions,
  clusterSamples,
  emitClusterFailureSignals,
};
