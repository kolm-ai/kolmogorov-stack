// W725 - Predictive preloading scheduler.
//
// Closes W707-plan W725 (lines 324-328): "Coding queries at 9am, writing at
// 2pm → preload" + "Multi-namespace setups → predict next namespace" +
// "Eliminate cold-start latency entirely".
//
// HONEST SCOPE - this module ships the PREDICTION + SCHEDULER PRIMITIVE.
// Actual cache pre-warming (loading model weights / KV cache into GPU memory
// ahead of the predicted query) is the runtime responsibility - the W724
// memory-tier and W726 spec-compile/kernel-selector hooks consume our
// `schedulePreload()` output to decide what to materialize. This module's
// outputs are pure data; no side-effects on hot caches.
//
// Two prediction signals, composed:
//
//   1. TIME-BUCKET model (W725-1):
//      Bucket history by hour-of-day (0-23). For the target hour, return the
//      top-3 namespaces by observed query frequency in that bucket. Naive
//      Bayes - no smoothing, no priors - because cold-start is the failure
//      mode we are trying to ELIMINATE, not the failure mode we are trying
//      to model. Empty bucket -> empty array (NOT a guess).
//
//   2. MARKOV chain (W725-2, 1st-order):
//      Build transition table from sequential history pairs (chronological
//      order). For the current_namespace, return the top-3 next namespaces
//      sorted by transition probability. Unseen current_namespace -> empty
//      array.
//
//   3. Composition (W725-3):
//      schedulePreload() runs both, merges by namespace, sums scores, and
//      tags each candidate with `reason: 'time_bucket' | 'markov' | 'both'`.
//      Returns the top-3 merged ranked candidates with reasoning so the
//      runtime can log WHY it pre-warmed a namespace (auditability over
//      black-box speedup).
//
// Honesty contract:
//   - Insufficient history -> empty array. Never an empty guess that says
//     "preload namespace `default`" when we have no signal.
//   - All persistence is tenant-fenced via a REQUIRED `tenant` parameter.
//     Defense-in-depth: never default to a shared file path; the function
//     throws synchronously if tenant is missing. This is the W454+ pattern.
//   - `recordQuery` appends to `${KOLM_DATA_DIR}/tenants/<tenant>/preload-
//     history.jsonl`. Each line is `{namespace, timestamp}`. Append-only;
//     the file is the source of truth for cross-process replay.
//
// Anti-brittleness: no explicit-array family sibling checks. Tests assert
// load-bearing fields (constants, top-K shape, reason tags, persistence
// paths).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Version stamp. Bumped only on incompatible schema changes; predictions and
// CLI consumers can detect a schema-incompatible scheduler at read time.
export const PRELOAD_SCHEDULER_VERSION = 'w725-v1';

// Top-K for both prediction surfaces and the composed scheduler output.
const TOP_K = 3;

// Composition weights. Tuned for the spec test (#5): when time-bucket and
// Markov agree on a namespace, the composed score must be STRICTLY GREATER
// than either alone. The simplest invariant is "score = time_score + markov_
// score" with each in [0, 1], so a both-signal candidate scores up to 2.0
// while a single-signal candidate maxes out at 1.0. We surface the raw sum
// in `score`, so callers can sort directionally.
const WEIGHT_TIME = 1.0;
const WEIGHT_MARKOV = 1.0;

// =============================================================================
// Path helpers (tenant-fenced)
// =============================================================================

function _home() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function _base() {
  const b = process.env.KOLM_DATA_DIR
    ? path.resolve(process.env.KOLM_DATA_DIR)
    : path.join(_home(), '.kolm');
  fs.mkdirSync(b, { recursive: true });
  return b;
}

// Sanitize a tenant string for filesystem use. The on-disk path is the
// composed `tenants/<tenant>/preload-history.jsonl`. We allow only [A-Za-z0-9_-.]
// and reject everything else to prevent path traversal. A tenant that
// includes a slash (e.g. `../etc/passwd`) MUST throw, not silently land
// in a sibling directory.
function _safeTenantSegment(tenant) {
  if (typeof tenant !== 'string' || tenant.length === 0) {
    const err = new Error('preload-scheduler: tenant is required (defense-in-depth)');
    err.code = 'tenant_required';
    throw err;
  }
  if (!/^[A-Za-z0-9_\-.]+$/.test(tenant)) {
    const err = new Error('preload-scheduler: tenant must match [A-Za-z0-9_\\-.]+');
    err.code = 'tenant_invalid';
    throw err;
  }
  // Defense-in-depth: explicitly reject path-traversal sentinels even if
  // they pass the charset filter (`..` does).
  if (tenant === '.' || tenant === '..' || tenant.includes('/') || tenant.includes('\\')) {
    const err = new Error('preload-scheduler: tenant must not contain path separators');
    err.code = 'tenant_invalid';
    throw err;
  }
  return tenant;
}

// Resolve the per-tenant history file. Always creates parent dirs. Never
// returns a shared path - if the tenant parameter is missing or invalid,
// this throws BEFORE touching the filesystem (W454+ pattern: never default
// to a shared file).
export function _historyFile(tenant) {
  const safe = _safeTenantSegment(tenant);
  const dir = path.join(_base(), 'tenants', safe);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'preload-history.jsonl');
}

// =============================================================================
// History I/O
// =============================================================================

// Read the on-disk history file for a tenant. Returns an empty array if the
// file does not exist OR cannot be parsed. Each line is parsed independently;
// a corrupted middle line does not poison surrounding rows. Mainly used by
// the in-memory cache below; callers normally pass `recent_history` in
// directly and bypass disk for hot-path prediction.
export function _readHistoryFile(tenant) {
  const file = _historyFile(tenant);
  if (!fs.existsSync(file)) return [];
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && typeof row.namespace === 'string') {
        out.push(row);
      }
    } catch { // deliberate: cleanup
      // Skip corrupted rows; honesty contract is "best-effort replay", not
      // "fail-on-partial-corruption" because the history file is advisory.
    }
  }
  return out;
}

// recordQuery - append one query observation to the tenant's history file.
//
// Required: tenant, namespace, timestamp (ms epoch).
// Side effects: appends one JSONL row; no other state mutated. Returns the
// row written.
//
// Tenant fence: `tenant` parameter is REQUIRED. `_safeTenantSegment` throws
// if missing or malformed BEFORE we touch the filesystem (defense-in-depth).
export function recordQuery({ tenant, namespace, timestamp } = {}) {
  // The fence comes first; we do not even normalize the other fields until
  // we know the tenant is safe to write under.
  _safeTenantSegment(tenant);

  if (typeof namespace !== 'string' || namespace.length === 0) {
    const err = new Error('preload-scheduler.recordQuery: namespace required');
    err.code = 'namespace_required';
    throw err;
  }
  const ts = Number.isFinite(timestamp) ? Number(timestamp) : Date.now();

  const row = { namespace, timestamp: ts };
  const file = _historyFile(tenant);
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

// =============================================================================
// Prediction 1 - time-bucket model
// =============================================================================

// Hour bucket of a millis-epoch timestamp. UTC; intentional - bucket math
// should be reproducible across regions. If a caller needs local-time
// buckets they can pre-shift the timestamps before calling.
function _hourBucket(ts) {
  if (!Number.isFinite(ts)) return null;
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCHours();
}

// predictByTimeBucket - for the target hour bucket, return the top-3 most-
// frequent namespaces observed in history. Algorithm:
//
//   1. Filter history rows whose hour-bucket == `hour`.
//   2. Count occurrences per namespace.
//   3. Sort desc by count, secondary asc by namespace (deterministic ties).
//   4. Take top-3.
//   5. Score = count / total_in_bucket (in [0, 1]); equal to relative
//      frequency, which is the maximum-likelihood estimate of P(namespace |
//      hour) under the time-bucket model. The composed scheduler uses this
//      directly as the time-side score component.
//
// Returns [] when the bucket has no observations (NOT a guess).
//
// Insufficient history is encoded by an empty array, not an honest envelope,
// because this is a HOT-PATH predictor - the runtime calls it on every query
// and an envelope on the empty-history case would balloon GC.
export function predictByTimeBucket({ hour, recent_history } = {}) {
  if (!Number.isFinite(hour)) return [];
  const h = Math.floor(Number(hour));
  if (h < 0 || h > 23) return [];
  if (!Array.isArray(recent_history) || recent_history.length === 0) return [];

  const counts = new Map();
  let bucketTotal = 0;
  for (const row of recent_history) {
    if (!row || typeof row !== 'object') continue;
    const ns = row.namespace;
    if (typeof ns !== 'string' || !ns) continue;
    const bucket = _hourBucket(row.timestamp);
    if (bucket !== h) continue;
    counts.set(ns, (counts.get(ns) || 0) + 1);
    bucketTotal += 1;
  }
  if (bucketTotal === 0) return [];

  const ranked = [...counts.entries()]
    .map(([ns, c]) => ({
      namespace: ns,
      count: c,
      score: c / bucketTotal,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0;
    });
  return ranked.slice(0, TOP_K);
}

// =============================================================================
// Prediction 2 - Markov chain (1st order)
// =============================================================================

// Build a 1st-order transition table from a chronological history array.
// We sort by timestamp first; callers don't need to pre-sort. Each adjacent
// pair (history[i], history[i+1]) contributes one transition.
//
// Returned shape:
//   Map<from, Map<to, count>>
//
// Note: same-namespace transitions (A -> A) are NOT filtered. They represent
// repeated queries against the same namespace, which the predictor should
// model (high-affinity loops are real). The scoring step never recommends
// the `current_namespace` itself in the top-3 - see predictNextNamespace.
function _buildTransitionTable(history) {
  if (!Array.isArray(history) || history.length < 2) return new Map();
  // Stable sort by timestamp; rows with missing timestamps go last (treated
  // as most-recent so we don't accidentally insert them into the middle of
  // the sequence).
  const sorted = history
    .filter((r) => r && typeof r === 'object' && typeof r.namespace === 'string')
    .slice()
    .sort((a, b) => {
      const ta = Number.isFinite(a.timestamp) ? Number(a.timestamp) : Number.MAX_SAFE_INTEGER;
      const tb = Number.isFinite(b.timestamp) ? Number(b.timestamp) : Number.MAX_SAFE_INTEGER;
      return ta - tb;
    });
  const table = new Map();
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const from = sorted[i].namespace;
    const to = sorted[i + 1].namespace;
    let inner = table.get(from);
    if (!inner) {
      inner = new Map();
      table.set(from, inner);
    }
    inner.set(to, (inner.get(to) || 0) + 1);
  }
  return table;
}

// predictNextNamespace - return top-3 next namespaces for current_namespace,
// sorted by transition probability (count / sum(counts for from)).
//
// Returns [] when:
//   - current_namespace was never seen in the FROM position
//   - no transitions can be derived (history.length < 2)
//
// We DO include self-transitions in the score because they are real signal,
// but we exclude `current_namespace` from the OUTPUT - a recommendation to
// "preload the namespace you are already in" is useless to the runtime
// (it's already warm).
export function predictNextNamespace({ recent_history, current_namespace } = {}) {
  if (typeof current_namespace !== 'string' || !current_namespace) return [];
  const table = _buildTransitionTable(recent_history);
  const row = table.get(current_namespace);
  if (!row || row.size === 0) return [];

  let total = 0;
  for (const c of row.values()) total += c;
  if (total === 0) return [];

  const ranked = [...row.entries()]
    .filter(([to]) => to !== current_namespace)
    .map(([to, c]) => ({
      namespace: to,
      count: c,
      score: c / total,
    }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0;
    });
  return ranked.slice(0, TOP_K);
}

// =============================================================================
// Composition - schedulePreload
// =============================================================================

// schedulePreload - compose time-bucket + Markov predictions into a single
// ranked list. Output shape:
//
//   [
//     {namespace, score, reason: 'time_bucket' | 'markov' | 'both',
//      time_score, markov_score},
//     ...
//   ]
//
// Score policy (invariant pinned by test #5):
//
//   when both signals fire for a namespace:
//     score = WEIGHT_TIME * time_score + WEIGHT_MARKOV * markov_score
//     reason = 'both'
//   when only time-bucket fires:
//     score = WEIGHT_TIME * time_score
//     reason = 'time_bucket'
//   when only Markov fires:
//     score = WEIGHT_MARKOV * markov_score
//     reason = 'markov'
//
// With WEIGHT_TIME = WEIGHT_MARKOV = 1.0 and each component in [0, 1], a
// `both` candidate always scores strictly greater than a single-signal
// candidate at the same per-component score (because both components are
// strictly positive when the reason is `both`). This is the invariant the
// test asserts.
//
// Returns top-3 merged candidates sorted by score desc, secondary asc by
// namespace for deterministic ties.
//
// When BOTH inputs are empty, returns []. This is the "cold-start, no
// history yet" case - the honest answer is "no recommendation", not a
// guess.
export function schedulePreload({ now_ts, recent_history, current_namespace } = {}) {
  const hour = Number.isFinite(now_ts) ? _hourBucket(now_ts) : new Date().getUTCHours();
  const timePreds = predictByTimeBucket({ hour, recent_history });
  const markovPreds = predictNextNamespace({ recent_history, current_namespace });

  const byNs = new Map();
  for (const p of timePreds) {
    byNs.set(p.namespace, {
      namespace: p.namespace,
      time_score: p.score,
      markov_score: 0,
    });
  }
  for (const p of markovPreds) {
    const existing = byNs.get(p.namespace);
    if (existing) {
      existing.markov_score = p.score;
    } else {
      byNs.set(p.namespace, {
        namespace: p.namespace,
        time_score: 0,
        markov_score: p.score,
      });
    }
  }

  const composed = [...byNs.values()].map((row) => {
    const t = row.time_score || 0;
    const m = row.markov_score || 0;
    let reason;
    if (t > 0 && m > 0) reason = 'both';
    else if (t > 0) reason = 'time_bucket';
    else reason = 'markov';
    const score = WEIGHT_TIME * t + WEIGHT_MARKOV * m;
    return {
      namespace: row.namespace,
      score,
      reason,
      time_score: t,
      markov_score: m,
    };
  });

  composed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0;
  });
  return composed.slice(0, TOP_K);
}

// =============================================================================
// Test / orchestrator hooks
// =============================================================================

// Internal helper exposed for tests + the bench harness. Returns the safe
// tenant segment for a given tenant string, or throws. Surfaces the same
// error class the public API throws so callers can catch consistently.
export function _safeTenantForTest(tenant) {
  return _safeTenantSegment(tenant);
}

// Internal helper exposed for tests - derive the hour bucket of a ts. Pure
// function so tests can assert UTC determinism.
export function _hourBucketForTest(ts) {
  return _hourBucket(ts);
}

// Internal helper exposed for tests + bench - buildTransitionTable surface
// for inspection.
export function _buildTransitionTableForTest(history) {
  const table = _buildTransitionTable(history);
  // Return a plain object so test assertions are easy.
  const out = {};
  for (const [from, inner] of table.entries()) {
    out[from] = {};
    for (const [to, c] of inner.entries()) out[from][to] = c;
  }
  return out;
}

// Generate a short opaque id for synthetic queries; useful for the bench
// harness and for tests that need deterministic-looking but unique row ids.
export function _newQueryId() {
  return 'q_' + crypto.randomBytes(6).toString('hex');
}
