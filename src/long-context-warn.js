// W781 - Long-context degradation warnings.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 711-715):
//   [W781-1] Context length distribution analysis of captures
//            -> analyzeContextLengthDist({tenant, namespace, window_days})
//   [W781-2] Automatic inclusion of synthetic long-context examples during
//            distill (uses W749) -> enrichForDistill({tenant, namespace})
//   [W781-3] Runtime warning when input exceeds 90th percentile
//            -> checkContextLength({tenant, namespace, input_length})
//
// Design contract:
//   - PURE READ for analyze + check (no mutation of captures).
//   - W411 defense-in-depth: every event-store read uses tenant_id +
//     per-row tenant_id !== tenant short-circuit so a future schema bug
//     cannot leak across tenants.
//   - Honest envelope on no_captures: {ok:true, n:0, ...} with version
//     stamp so downstream consumers can regex-match /^w781-/.
//   - W604 anti-brittleness: every consumer of this module's version
//     stamp matches /^w781-/ rather than a literal 'w781-v1' equality.
//   - W749 hook is OPTIONAL. If W749's requestSyntheticBatch is missing
//     (sibling agent still building, or this is a fresh deploy), the
//     enrichForDistill envelope surfaces module_missing:true so the
//     dashboard can render a useful empty state.
//
// Public surface:
//   - LONG_CONTEXT_WARN_VERSION
//   - DEFAULT_WINDOW_DAYS, DEFAULT_HIST_BUCKETS
//   - percentile(sortedAsc, p)
//   - analyzeContextLengthDist({tenant, namespace, window_days})
//   - checkContextLength({tenant, namespace, input_length})
//   - enrichForDistill({tenant, namespace, target_count?})

import { listEvents } from './event-store.js';

export const LONG_CONTEXT_WARN_VERSION = 'w781-v1';

// 30-day rolling window mirrors the W709 routing/billing default window so
// the distribution percentile aligns with the operator's mental model of
// "recent traffic". Callers can override.
export const DEFAULT_WINDOW_DAYS = 30;

// 10-bucket histogram is enough resolution for a dashboard sparkline
// without dumping a length-by-length frequency table that no operator
// reads. Bucket edges are computed log-spaced so a corpus with one
// 100k-token outlier and a long tail of 200-token rows still renders.
export const DEFAULT_HIST_BUCKETS = 10;

// Minimum sample size before any percentile is treated as actionable.
// Below this, checkContextLength returns warn:false with reason
// 'insufficient_samples' rather than warn on a 2-row p90 that means
// nothing statistically.
const MIN_SAMPLES_FOR_WARN = 20;

// Maximum window — anyone asking for 10000 days is asking for a full table
// scan and the request was almost certainly a typo. Cap matches the
// W770 audit-export HARD_MAX_ROWS philosophy.
const MAX_WINDOW_DAYS = 365;

// Sliced read cap. The event-store can hold millions of rows for a busy
// tenant; we only need the most recent N samples to compute a stable
// percentile. 10000 gives sub-millisecond percentile computation while
// staying statistically stable.
const READ_LIMIT = 10000;

// Extract the input-length signal from an event row. Priority order:
//   1. ev.input_tokens / ev.prompt_tokens (token-canonical signal)
//   2. ev.input_chars (char proxy if tokens unavailable)
//   3. ev.input.length / ev.prompt.length (lazy fallback)
// All zero / negative values are dropped from the sample set since a
// percentile of mostly-zero rows is meaningless.
function _lengthFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const tokenSignal = Number(ev.input_tokens != null ? ev.input_tokens : ev.prompt_tokens);
  if (Number.isFinite(tokenSignal) && tokenSignal > 0) return tokenSignal;
  const charSignal = Number(ev.input_chars);
  if (Number.isFinite(charSignal) && charSignal > 0) return charSignal;
  const inputText = ev.input || ev.prompt || ev.prompt_redacted;
  if (typeof inputText === 'string' && inputText.length > 0) return inputText.length;
  return null;
}

// Linear interpolation percentile on a SORTED ASCENDING array. p in [0,1].
// Returns 0 for empty arrays so callers never deal with NaN. Matches the
// "type 7" definition used by numpy.percentile / pandas.quantile.
export function percentile(sortedAsc, p) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return 0;
  const pp = Math.max(0, Math.min(1, Number(p) || 0));
  if (sortedAsc.length === 1) return Number(sortedAsc[0]) || 0;
  const idx = pp * (sortedAsc.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Number(sortedAsc[lo]) || 0;
  const frac = idx - lo;
  const a = Number(sortedAsc[lo]) || 0;
  const b = Number(sortedAsc[hi]) || 0;
  return a + (b - a) * frac;
}

// Build a log-spaced histogram of input lengths. Returns {edges, counts}.
// Log spacing handles the typical heavy-tailed length distribution better
// than uniform spacing.
function _logHistogram(values, bucketCount) {
  if (!Array.isArray(values) || values.length === 0) {
    return { edges: [], counts: [] };
  }
  const n = Math.max(2, Math.trunc(bucketCount) || DEFAULT_HIST_BUCKETS);
  const min = Math.max(1, Math.min(...values));
  const max = Math.max(min + 1, Math.max(...values));
  const logMin = Math.log(min);
  const logMax = Math.log(max);
  const step = (logMax - logMin) / n;
  const edges = [];
  for (let i = 0; i <= n; i++) {
    edges.push(Math.exp(logMin + step * i));
  }
  const counts = new Array(n).fill(0);
  for (const v of values) {
    if (!(Number.isFinite(v) && v > 0)) continue;
    let bucket = Math.floor((Math.log(v) - logMin) / step);
    if (bucket < 0) bucket = 0;
    if (bucket >= n) bucket = n - 1;
    counts[bucket] += 1;
  }
  return { edges, counts };
}

// =============================================================================
// analyzeContextLengthDist
//
// Reads recent captures for {tenant, namespace} over the last
// `window_days` days, extracts the input-length signal, and computes
// the distribution: count + min + max + p50/p90/p95/p99 + log histogram.
//
// Returns:
//   {ok:true, n, min, max, p50, p90, p95, p99, hist:{edges,counts}, window_days, version}
//   {ok:true, n:0, message:'no_captures', ...}  on empty corpus
//   {ok:false, error:'tenant_required', ...}    on missing tenant
// =============================================================================
export async function analyzeContextLengthDist(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      hint: 'pass {tenant: req.tenant_record.id}',
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : null;
  const rawWindow = Number(o.window_days);
  const window_days = Number.isFinite(rawWindow) && rawWindow > 0
    ? Math.min(MAX_WINDOW_DAYS, Math.trunc(rawWindow))
    : DEFAULT_WINDOW_DAYS;

  const since = new Date(Date.now() - window_days * 86400 * 1000).toISOString();

  let rows = [];
  try {
    rows = await listEvents({
      tenant_id: tenant,
      namespace,
      since,
      limit: READ_LIMIT,
      order: 'desc',
    });
  } catch (e) {
    return {
      ok: false,
      error: 'event_store_read_error',
      detail: String((e && e.message) || e),
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  // W411 defense-in-depth: per-row tenant_id !== tenant short-circuit so a
  // future event-store schema change cannot leak across tenants.
  rows = (rows || []).filter((r) => r && r.tenant_id === tenant);

  const lengths = [];
  for (const ev of rows) {
    const len = _lengthFromEvent(ev);
    if (len != null) lengths.push(len);
  }
  if (lengths.length === 0) {
    return {
      ok: true,
      n: 0,
      message: 'no_captures',
      tenant_id: tenant,
      namespace,
      window_days,
      p50: 0, p90: 0, p95: 0, p99: 0,
      min: 0, max: 0,
      hist: { edges: [], counts: [] },
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  const sorted = lengths.slice().sort((a, b) => a - b);
  return {
    ok: true,
    n: sorted.length,
    tenant_id: tenant,
    namespace,
    window_days,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    hist: _logHistogram(sorted, DEFAULT_HIST_BUCKETS),
    version: LONG_CONTEXT_WARN_VERSION,
  };
}

// =============================================================================
// checkContextLength
//
// Compares a single input_length against the tenant's recent p90. Returns
// warn:true when the input exceeds p90 AND the sample size is large
// enough to make the comparison meaningful.
//
// Returns:
//   {ok:true, warn:bool, percentile, p90, n, version}
//   {ok:false, error, version}
//
// `percentile` field is the input_length's empirical percentile in the
// recent corpus (0..1), so the caller can render "your input is in the
// 95th percentile" without re-running analyze.
// =============================================================================
export async function checkContextLength(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  const inputLength = Number(o.input_length);
  if (!Number.isFinite(inputLength) || inputLength < 0) {
    return {
      ok: false,
      error: 'input_length_required',
      hint: 'pass {input_length: number >= 0}',
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  const dist = await analyzeContextLengthDist({
    tenant,
    namespace: o.namespace,
    window_days: o.window_days,
  });
  if (!dist.ok) return dist;
  if (dist.n === 0) {
    return {
      ok: true,
      warn: false,
      reason: 'no_captures',
      percentile: 0,
      p90: 0,
      n: 0,
      input_length: inputLength,
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  if (dist.n < MIN_SAMPLES_FOR_WARN) {
    return {
      ok: true,
      warn: false,
      reason: 'insufficient_samples',
      percentile: 0,
      p90: dist.p90,
      n: dist.n,
      min_samples_for_warn: MIN_SAMPLES_FOR_WARN,
      input_length: inputLength,
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  // Empirical percentile: re-read the distribution and find where the
  // input slots in. The dist envelope only carries p50/p90/p95/p99 so we
  // need to recompute the count_le for the exact input_length. Use the
  // raw lengths via a second analyze call only when needed.
  let countLe = 0;
  let n = dist.n;
  // Re-read the sorted lengths to compute the exact empirical percentile.
  // Avoids returning a misleading "near-100th" when the input matches one
  // of the histogram bucket edges.
  const since = new Date(Date.now() - (Number.isFinite(Number(o.window_days)) && Number(o.window_days) > 0
    ? Math.min(MAX_WINDOW_DAYS, Math.trunc(Number(o.window_days)))
    : DEFAULT_WINDOW_DAYS) * 86400 * 1000).toISOString();
  try {
    const rows = await listEvents({
      tenant_id: tenant,
      namespace: o.namespace,
      since,
      limit: READ_LIMIT,
      order: 'desc',
    });
    const fenced = (rows || []).filter((r) => r && r.tenant_id === tenant);
    for (const ev of fenced) {
      const len = _lengthFromEvent(ev);
      if (len != null && len <= inputLength) countLe += 1;
    }
    n = fenced.reduce((acc, ev) => acc + (_lengthFromEvent(ev) != null ? 1 : 0), 0);
  } catch (_) { /* fall through with dist.n */ }
  const empiricalPercentile = n > 0 ? (countLe / n) : 0;
  const warn = inputLength > dist.p90;
  return {
    ok: true,
    warn,
    reason: warn ? 'above_p90' : 'within_p90',
    percentile: empiricalPercentile,
    p90: dist.p90,
    p95: dist.p95,
    p99: dist.p99,
    n: dist.n,
    input_length: inputLength,
    tenant_id: tenant,
    namespace: o.namespace || null,
    version: LONG_CONTEXT_WARN_VERSION,
  };
}

// =============================================================================
// enrichForDistill
//
// W781-2: when a distill run is about to launch, surface long-context
// captures so the synthetic-augment loop can up-weight them. Wraps W749's
// requestSyntheticBatch with `force_long_context:true` semantics: we pass
// the longest captures as seed_captures so the teacher generation stays
// anchored on the rare-but-load-bearing long-context examples.
//
// Honest envelope when W749 is missing (sibling agent still building, or
// fresh deploy without synthetic-augment.js on disk). Never throws.
//
// Returns:
//   {ok:true, mode:'long_context_enriched', seeds_count, batch?, dist?, version}
//   {ok:true, mode:'no_long_context_captures', dist, version}  when corpus is short
//   {ok:false, error:'module_missing', module:'synthetic-augment.js', ...} when W749 unavailable
//   {ok:false, error:'teacher_caller_required', ...} when called without an injected teacher
// =============================================================================
export async function enrichForDistill(opts) {
  const o = opts || {};
  const tenant = (typeof o.tenant === 'string' && o.tenant) ? o.tenant : null;
  if (!tenant) {
    return {
      ok: false,
      error: 'tenant_required',
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  const namespace = (typeof o.namespace === 'string' && o.namespace) ? o.namespace : null;
  const target_count = Number.isFinite(Number(o.target_count)) && Number(o.target_count) > 0
    ? Math.min(100, Math.trunc(Number(o.target_count)))
    : 10;

  const dist = await analyzeContextLengthDist({ tenant, namespace, window_days: o.window_days });
  if (!dist.ok) return dist;

  // Without any captures we can't pick longest seeds. Surface honestly.
  if (dist.n === 0) {
    return {
      ok: true,
      mode: 'no_long_context_captures',
      dist,
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }

  // Pull the top-N longest captures as seeds. We re-read because the
  // analyzeContextLengthDist envelope only carries summary statistics.
  const since = new Date(Date.now() - dist.window_days * 86400 * 1000).toISOString();
  let rows = [];
  try {
    rows = await listEvents({
      tenant_id: tenant,
      namespace,
      since,
      limit: READ_LIMIT,
      order: 'desc',
    });
  } catch (_) { rows = []; }
  rows = (rows || []).filter((r) => r && r.tenant_id === tenant);

  const lengths = rows
    .map((ev) => ({ ev, len: _lengthFromEvent(ev) }))
    .filter((x) => x.len != null)
    .sort((a, b) => b.len - a.len)
    .slice(0, target_count);

  const seed_captures = lengths.map((x) => ({
    cid: x.ev.event_id || x.ev.cid,
    input: x.ev.prompt_redacted || x.ev.prompt || x.ev.input || '',
    output: x.ev.response_redacted || x.ev.response || x.ev.output || '',
    input_length: x.len,
  }));

  // Try to import W749. If it's missing on disk we return an honest envelope
  // so the dashboard can render "synthetic augmentation not yet wired".
  let synth = null;
  try {
    synth = await import('./synthetic-augment.js');
  } catch (_) {
    return {
      ok: false,
      error: 'module_missing',
      module: 'synthetic-augment.js',
      hint: 'W781-2 wraps W749 synthetic-augment; install / deploy W749 first.',
      seeds_count: seed_captures.length,
      dist,
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }

  // The teacher_caller is DI per the W749 contract. Without one we cannot
  // generate, so surface the honest envelope describing what was prepared
  // (the seeds) without spending teacher credits.
  if (typeof o.teacher_caller !== 'function') {
    return {
      ok: true,
      mode: 'long_context_enriched_dry_run',
      seeds_count: seed_captures.length,
      seed_lengths: seed_captures.map((s) => s.input_length),
      dist,
      hint: 'pass {teacher_caller: async (prompt) => string} to actually call the teacher',
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }

  // Live generation path. Tag the category so W749 records this as a
  // long-context augmentation batch in its envelope.
  let batch;
  try {
    batch = await synth.requestSyntheticBatch({
      category: 'long_context',
      target_count,
      seed_captures,
      teacher_caller: o.teacher_caller,
      cost_per_row_usd: o.cost_per_row_usd,
    });
  } catch (e) {
    return {
      ok: false,
      error: 'synthetic_call_failed',
      detail: String((e && e.message) || e),
      seeds_count: seed_captures.length,
      version: LONG_CONTEXT_WARN_VERSION,
    };
  }
  return {
    ok: true,
    mode: 'long_context_enriched',
    seeds_count: seed_captures.length,
    seed_lengths: seed_captures.map((s) => s.input_length),
    batch,
    dist,
    version: LONG_CONTEXT_WARN_VERSION,
  };
}

export const DEFAULTS = Object.freeze({
  DEFAULT_WINDOW_DAYS,
  DEFAULT_HIST_BUCKETS,
  MIN_SAMPLES_FOR_WARN,
  MAX_WINDOW_DAYS,
  READ_LIMIT,
});
