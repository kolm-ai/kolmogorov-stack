// W746 - Capture staleness: recency weighting, freshness distribution, TTL eviction.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 473-478):
//   [W746-1] Capture expiry / decay weighting (recent > older)
//            → recency weight in training sampler
//   [W746-2] Configurable retention policy (auto-expire >N days)
//            → per-namespace TTL
//   [W746-3] Visual timeline showing capture freshness distribution
//   [W746-4] Teacher version tagging on every capture
//            → extend event-store row (handled by src/teacher-version.js)
//
// Design contract:
//   - PURE FUNCTIONS. No I/O. No clocks (now is injectable). Same input →
//     same output. Lock-in tests pin exact decay constants so a future
//     "tune the curve" PR cannot silently drift sampler weights.
//   - Honest envelopes. evictExpired() returns {kept,evicted} so callers can
//     audit what disappeared; never silently drops rows.
//   - TTL = null means NO TTL. We never invent a default retention period - 
//     a user who never opted in must never have rows auto-evicted. The W746
//     dashboard surfaces the per-namespace policy explicitly.
//
// Public surface:
//   - STALENESS_VERSION
//   - recencyWeight(captured_at, {now, half_life_days})
//   - weightCapturesByRecency(captures, {half_life_days, now})
//   - freshnessDistribution(captures, {now, buckets})
//   - evictExpired(captures, {ttl_days, now})
//   - applyNamespaceTtl(captures, namespaceSettings)

export const STALENESS_VERSION = 'w746-v1';

const MS_PER_DAY = 86400000;

// Parse the captured_at field robustly. Captures may carry ISO strings
// (canonical event-store rows) or epoch-millis numbers (legacy obs rows).
// Returns NaN on garbage so callers can detect + skip.
function _toMs(captured_at) {
  if (captured_at == null) return NaN;
  if (typeof captured_at === 'number' && Number.isFinite(captured_at)) {
    return captured_at;
  }
  const t = new Date(captured_at).getTime();
  return Number.isFinite(t) ? t : NaN;
}

// =============================================================================
// recencyWeight - exponential decay weight in (0, 1].
//
// Same-day capture returns 1.0 (no decay yet).
// After `half_life_days` of age, weight = 0.5.
// After 2 * half_life_days, weight = 0.25. Etc.
//
// Formula: weight = 0.5 ** (ageDays / half_life_days)
//
// Future-dated captures (negative age, e.g. clock skew) are clamped to weight=1.0
// so a slightly-skewed client never inflates a row above the present-day mass.
// =============================================================================
export function recencyWeight(captured_at, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const half_life_days = opts.half_life_days != null ? opts.half_life_days : 30;
  if (!Number.isFinite(half_life_days) || half_life_days <= 0) {
    throw new Error('recencyWeight: half_life_days must be a positive finite number');
  }
  const ms = _toMs(captured_at);
  if (!Number.isFinite(ms)) return 0; // unparseable → 0 (don't reward garbage)
  const ageDays = (now - ms) / MS_PER_DAY;
  if (ageDays <= 0) return 1.0; // same-day OR future-dated → full weight
  return Math.pow(0.5, ageDays / half_life_days);
}

// =============================================================================
// weightCapturesByRecency - annotate each capture with a recency_weight field.
//
// Pure transform: returns a NEW array of NEW row objects (no mutation of input).
// Each output row carries every original field PLUS `recency_weight` in (0, 1].
// =============================================================================
export function weightCapturesByRecency(captures, opts = {}) {
  if (!Array.isArray(captures)) return [];
  const now = opts.now != null ? opts.now : Date.now();
  const half_life_days = opts.half_life_days != null ? opts.half_life_days : 30;
  return captures.map((cap) => {
    const captured_at = cap && (cap.captured_at || cap.created_at);
    const w = recencyWeight(captured_at, { now, half_life_days });
    return { ...cap, recency_weight: w };
  });
}

// =============================================================================
// freshnessDistribution - bucket captures by age band for the W746-3 timeline viz.
//
// Default buckets = [1, 7, 30, 90, 365] days. Plus an overflow bucket
// `>max(buckets)d` (e.g. ">365d") that catches everything older.
//
// Bucket semantics: bucket_max_days is INCLUSIVE upper bound. The first
// bucket is "<=1d", the last bucket is ">365d" (or whatever the max is).
//
// Returns:
//   [
//     {bucket_label, bucket_max_days, count, pct},
//     ...
//   ]
//
// pct is a percentage 0..100 with one decimal. Bucket counts always sum to
// the input length (unparseable rows fall into the overflow bucket so we
// never silently drop rows from the chart).
// =============================================================================
export function freshnessDistribution(captures, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const buckets = Array.isArray(opts.buckets) && opts.buckets.length > 0
    ? opts.buckets.slice()
    : [1, 7, 30, 90, 365];
  // Ensure ascending order so bucket iteration is well-defined.
  buckets.sort((a, b) => a - b);
  const counts = new Array(buckets.length + 1).fill(0); // last slot = overflow
  const list = Array.isArray(captures) ? captures : [];
  for (const cap of list) {
    const captured_at = cap && (cap.captured_at || cap.created_at);
    const ms = _toMs(captured_at);
    if (!Number.isFinite(ms)) {
      counts[counts.length - 1] += 1; // garbage → overflow (honest, not dropped)
      continue;
    }
    const ageDays = (now - ms) / MS_PER_DAY;
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (ageDays <= buckets[i]) {
        counts[i] += 1;
        placed = true;
        break;
      }
    }
    if (!placed) counts[counts.length - 1] += 1;
  }
  const total = list.length || 1;
  const out = [];
  for (let i = 0; i < buckets.length; i++) {
    out.push({
      bucket_label: '<=' + buckets[i] + 'd',
      bucket_max_days: buckets[i],
      count: counts[i],
      pct: Math.round((counts[i] / total) * 1000) / 10,
    });
  }
  const maxBucket = buckets[buckets.length - 1];
  out.push({
    bucket_label: '>' + maxBucket + 'd',
    bucket_max_days: null,
    count: counts[counts.length - 1],
    pct: Math.round((counts[counts.length - 1] / total) * 1000) / 10,
  });
  return out;
}

// =============================================================================
// evictExpired - partition captures into kept/evicted using a TTL in days.
//
// ttl_days = null  → no TTL configured → returns ALL kept, evicted is empty.
//                     (This is the W746-2 honesty contract: no policy = no
//                     eviction. We do NOT impose a default retention.)
// ttl_days = N (>0) → captures older than N days move to evicted[].
//
// Returns: {kept: [...], evicted: [...]} - both are NEW arrays of references
// to the original rows (we never mutate input).
//
// Garbage captured_at → row falls into `evicted` (we cannot honestly keep a
// row with no provable age). The CLI/dashboard surfaces this count so the
// user can see how many rows were dropped due to bad timestamps.
// =============================================================================
export function evictExpired(captures, opts = {}) {
  const list = Array.isArray(captures) ? captures : [];
  const ttl_days = opts.ttl_days;
  const now = opts.now != null ? opts.now : Date.now();
  // Null/undefined TTL - no eviction. Empty string + 0 also count as "no TTL"
  // so an accidental `?ttl=` query param doesn't wipe a user's corpus.
  if (ttl_days == null || ttl_days === '' || ttl_days === 0) {
    return { kept: list.slice(), evicted: [] };
  }
  if (typeof ttl_days !== 'number' || !Number.isFinite(ttl_days) || ttl_days < 0) {
    throw new Error('evictExpired: ttl_days must be null or a non-negative finite number; got ' + JSON.stringify(ttl_days));
  }
  const cutoffMs = now - (ttl_days * MS_PER_DAY);
  const kept = [];
  const evicted = [];
  for (const cap of list) {
    const captured_at = cap && (cap.captured_at || cap.created_at);
    const ms = _toMs(captured_at);
    if (!Number.isFinite(ms)) {
      evicted.push(cap);
      continue;
    }
    if (ms < cutoffMs) {
      evicted.push(cap);
    } else {
      kept.push(cap);
    }
  }
  return { kept, evicted };
}

// =============================================================================
// applyNamespaceTtl - group captures by namespace and evict per-namespace.
//
// namespaceSettings shape: { [namespace_name]: { capture_ttl_days: N|null } }
//
// Namespaces with no entry (or capture_ttl_days = null) are NOT evicted.
//
// Returns:
//   {
//     kept_total: N,
//     evicted_total: M,
//     by_namespace: {
//       [ns]: { kept: N, evicted: M, ttl_days: number|null }
//     }
//   }
//
// Stable iteration order: namespaces are sorted alphabetically in by_namespace.
// =============================================================================
export function applyNamespaceTtl(captures, namespaceSettings, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const list = Array.isArray(captures) ? captures : [];
  const settings = (namespaceSettings && typeof namespaceSettings === 'object') ? namespaceSettings : {};
  // Group captures by namespace. Default namespace name for missing rows is
  // 'default' (matches src/router.js sanitizeNamespace fallback).
  const groups = new Map();
  for (const cap of list) {
    const ns = (cap && (cap.namespace || cap.corpus_namespace)) || 'default';
    if (!groups.has(ns)) groups.set(ns, []);
    groups.get(ns).push(cap);
  }
  const by_namespace = {};
  let kept_total = 0;
  let evicted_total = 0;
  const names = Array.from(groups.keys()).sort();
  for (const ns of names) {
    const cfg = settings[ns] || {};
    const ttl_days = cfg.capture_ttl_days != null ? cfg.capture_ttl_days : null;
    const result = evictExpired(groups.get(ns), { ttl_days, now });
    by_namespace[ns] = {
      kept: result.kept.length,
      evicted: result.evicted.length,
      ttl_days,
    };
    kept_total += result.kept.length;
    evicted_total += result.evicted.length;
  }
  return { kept_total, evicted_total, by_namespace };
}
