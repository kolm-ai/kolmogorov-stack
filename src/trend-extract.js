// W757 - Trend extraction over the cross-namespace pattern lake.
//
// Pairs with src/pattern-lake.js and src/dp-aggregation.js to expose:
//   - emergingPatterns({window_days, min_growth_ratio}) - bigrams whose
//     recent-window count grows by >= min_growth_ratio over the prior window
//   - summarizeTrends() - global rollup used by GET /v1/lake/trends
//
// HONESTY CONTRACT:
//   - Pure read paths - no contribution side effects. The lake's write API
//     is exclusively contributePattern in pattern-lake.js.
//   - When there is insufficient history, the response is an honest
//     `insufficient_history` envelope with the actual window size + the
//     minimum required, NEVER a fabricated rollup.
//   - Tenant identity NEVER appears in the output. Every emerging bigram is
//     a sha256 hash; the rollup carries aggregate counts only.
//
// W411 - defense-in-depth filters per row inside the loops, even though the
// lake's contribute path already enforces consent + opt-in.

import { listEvents } from './event-store.js';
import { isOptedIn } from './pattern-lake.js';

export const TREND_VERSION = 'w757-v1';
export const TREND_EXTRACT_CONTRACT_VERSION = 'w731-trend-v1';
export const TREND_EXTRACT_LIMITS = Object.freeze({
  max_scan_rows: 50000,
  max_feedback_chars: 1000000,
  max_namespace_chars: 256,
  max_hashes_per_row: 20000,
  max_emerging_items: 50,
  max_window_days: 365,
  min_history_rows: 10,
  min_growth_ratio: 1.01,
  max_growth_ratio: 1000,
});

const PROVIDER_CONTRIBUTION = 'kolm_pattern_lake_contribution';
const PROVIDER_OPTIN = 'kolm_pattern_lake_optin';
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

// Minimum number of rows required across BOTH windows before we trust the
// emergent-pattern signal. Below this the envelope reports insufficient
// history rather than emitting a noisy small-sample top-K.
const MIN_HISTORY_ROWS = TREND_EXTRACT_LIMITS.min_history_rows;

function _parseRow(r) {
  return _parseFeedback(r);
}

function _boundedInt(value, fallback, min, max) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function _boundedNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function _scanLimit(value) {
  return _boundedInt(value, TREND_EXTRACT_LIMITS.max_scan_rows, 1, TREND_EXTRACT_LIMITS.max_scan_rows);
}

function _cleanNamespace(value) {
  if (value == null) return null;
  const s = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s || s.length > TREND_EXTRACT_LIMITS.max_namespace_chars) return null;
  return s;
}

function _parseFeedback(row) {
  if (!row || typeof row.feedback !== 'string' || !row.feedback) return null;
  if (row.feedback.length > TREND_EXTRACT_LIMITS.max_feedback_chars) return null;
  try { return JSON.parse(row.feedback); } catch { return null; }
}

function _normalizeBigramHashes(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const h = String(value || '').toLowerCase();
    if (!SHA256_HEX_RE.test(h)) continue;
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(h);
    if (out.length >= TREND_EXTRACT_LIMITS.max_hashes_per_row) break;
  }
  return out;
}

function _parseContributionRow(row) {
  if (!row || !row.tenant_id || !row.created_at) return null;
  const payload = _parseFeedback(row);
  const namespace = _cleanNamespace(payload && payload.namespace);
  if (!payload || !namespace) return null;
  const createdMs = Date.parse(row.created_at);
  if (!Number.isFinite(createdMs)) return null;
  const bigram_hashes = _normalizeBigramHashes(payload.bigram_hashes);
  if (!bigram_hashes.length) return null;
  return {
    tenant_id: String(row.tenant_id),
    namespace,
    created_at: row.created_at,
    created_ms: createdMs,
    bigram_hashes,
  };
}

async function _isStillOptedIn(row, cache) {
  const key = `${row.tenant_id}\u0000${row.namespace}`;
  if (!cache.has(key)) {
    cache.set(key, await isOptedIn(row.tenant_id, row.namespace));
  }
  return cache.get(key);
}

// Build a hash→count Map from a contribution row list, applying the same
// per-contributor dedupe rule as pattern-lake.aggregatePatterns so a single
// chatty namespace cannot inflate the histogram.
function _histogram(rows) {
  const seenPerContributor = new Map();
  const histogram = new Map();
  for (const row of rows) {
    if (!row || !row.tenant_id || !row.namespace) continue;
    const k = row.tenant_id + '|' + row.namespace;
    let seen = seenPerContributor.get(k);
    if (!seen) { seen = new Set(); seenPerContributor.set(k, seen); }
    for (const h of row.bigram_hashes || []) {
      if (!SHA256_HEX_RE.test(h)) continue;
      if (seen.has(h)) continue;
      seen.add(h);
      histogram.set(h, (histogram.get(h) || 0) + 1);
    }
  }
  return histogram;
}

// emergingPatterns({window_days, min_growth_ratio}) - bigrams whose count
// inside the last window_days grew by >= min_growth_ratio compared to the
// equally-sized prior window. Returns an honest `insufficient_history`
// envelope when not enough rows are available.
export async function emergingPatterns({
  window_days = 30,
  min_growth_ratio = 2.0,
  max_scan_rows = TREND_EXTRACT_LIMITS.max_scan_rows,
  now_ms = Date.now(),
} = {}) {
  const wDays = _boundedInt(window_days, 30, 1, TREND_EXTRACT_LIMITS.max_window_days);
  const ratio = _boundedNumber(
    min_growth_ratio,
    2.0,
    TREND_EXTRACT_LIMITS.min_growth_ratio,
    TREND_EXTRACT_LIMITS.max_growth_ratio,
  );
  const scanLimit = _scanLimit(max_scan_rows);
  const now = Number.isFinite(Number(now_ms)) ? Number(now_ms) : Date.now();
  const ms = wDays * 24 * 3600 * 1000;
  const recentSinceMs = now - ms;
  const priorSinceMs = now - 2 * ms;

  const all = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    limit: scanLimit,
    order: 'desc',
  });

  // W411 - apply opt-in re-fence per row INSIDE the loop so a row whose
  // opt-in was revoked never participates in the trend computation.
  const recent = [];
  const prior = [];
  const optInCache = new Map();
  for (const r of all) {
    const row = _parseContributionRow(r);
    if (!row) continue;
    const opted = await _isStillOptedIn(row, optInCache);
    if (!opted) continue;
    if (row.created_ms >= recentSinceMs) recent.push(row);
    else if (row.created_ms >= priorSinceMs && row.created_ms < recentSinceMs) prior.push(row);
  }

  if (recent.length + prior.length < MIN_HISTORY_ROWS) {
    return {
      ok: false,
      error: 'insufficient_history',
      need_min_rows: MIN_HISTORY_ROWS,
      have_recent: recent.length,
      have_prior: prior.length,
      window_days: wDays,
      max_scan_rows: scanLimit,
      scan_rows: all.length,
      scan_capped: all.length >= scanLimit,
      contract_version: TREND_EXTRACT_CONTRACT_VERSION,
      version: TREND_VERSION,
    };
  }

  const recentHist = _histogram(recent);
  const priorHist = _histogram(prior);
  const emerging = [];
  for (const [hash, rcount] of recentHist) {
    const pcount = priorHist.get(hash) || 0;
    // Add a 1.0 smoothing constant to the prior count so a bigram that was
    // entirely new in the recent window still surfaces (without inflating
    // to infinity, which the ratio cap would clamp anyway).
    const r = rcount / (pcount + 1.0);
    if (r >= ratio && rcount >= 2) {
      emerging.push({ hash, recent_count: rcount, prior_count: pcount, growth_ratio: r });
    }
  }
  emerging.sort((a, b) => (
    b.growth_ratio - a.growth_ratio
    || b.recent_count - a.recent_count
    || a.hash.localeCompare(b.hash)
  ));
  const topEmerging = emerging.slice(0, TREND_EXTRACT_LIMITS.max_emerging_items);

  return {
    ok: true,
    version: TREND_VERSION,
    contract_version: TREND_EXTRACT_CONTRACT_VERSION,
    window_days: wDays,
    min_growth_ratio: ratio,
    max_scan_rows: scanLimit,
    scan_rows: all.length,
    scan_capped: all.length >= scanLimit,
    n_recent_rows: recent.length,
    n_prior_rows: prior.length,
    emerging_count: emerging.length,
    emerging: topEmerging,
    generated_at: new Date(now).toISOString(),
  };
}

// summarizeTrends() - the GET /v1/lake/trends payload. Aggregate-only,
// hash-free at the top level. Surfaces:
//   - total_contributors: distinct tenant_ids with at least one contribution
//   - total_namespaces:   distinct (tenant_id, namespace) pairs opted-in
//   - top_verticals_by_density: best-effort top verticals ranked by share of
//                               contribution rows whose namespace contains
//                               the vertical id as a substring (matches the
//                               aggregatePatterns vertical filter)
//   - emerging_count:     count of emerging bigrams (without payload)
export async function summarizeTrends({
  max_scan_rows = TREND_EXTRACT_LIMITS.max_scan_rows,
  window_days = 30,
  min_growth_ratio = 2.0,
  now_ms = Date.now(),
} = {}) {
  const scanLimit = _scanLimit(max_scan_rows);
  const now = Number.isFinite(Number(now_ms)) ? Number(now_ms) : Date.now();
  const contributionRows = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    limit: scanLimit,
    order: 'desc',
  });
  const contributors = new Set();
  const namespaces = new Set();
  const verticalCounts = new Map();
  const optInCache = new Map();
  // Best-effort vertical id list - kept in-sync with src/verticals.js
  // canonical order. Importing the catalog would be cleaner but would couple
  // this module to the verticals module's loading cost on every summary call.
  const KNOWN_VERTICAL_IDS = ['legal', 'medical', 'code', 'finance', 'support'];

  for (const r of contributionRows) {
    const row = _parseContributionRow(r);
    if (!row) continue;
    const opted = await _isStillOptedIn(row, optInCache);
    if (!opted) continue;
    contributors.add(row.tenant_id);
    namespaces.add(row.tenant_id + '|' + row.namespace);
    const ns = row.namespace.toLowerCase();
    for (const vid of KNOWN_VERTICAL_IDS) {
      if (ns.includes(vid)) {
        verticalCounts.set(vid, (verticalCounts.get(vid) || 0) + 1);
      }
    }
  }

  // Count opt-in registry rows too so the summary distinguishes "tenants
  // opted in but not yet contributed" from "tenants currently contributing".
  const optInRows = await listEvents({ provider: PROVIDER_OPTIN, limit: scanLimit, order: 'desc' });
  const optInTenants = new Set();
  for (const r of optInRows) {
    if (!r || !r.tenant_id) continue;
    const payload = _parseRow(r);
    const namespace = _cleanNamespace(payload && payload.namespace);
    if (!payload || payload.action !== 'opt_in' || !namespace) continue;
    const still = await _isStillOptedIn({ tenant_id: String(r.tenant_id), namespace }, optInCache);
    if (still) optInTenants.add(r.tenant_id);
  }

  const emerging = await emergingPatterns({
    max_scan_rows: scanLimit,
    window_days,
    min_growth_ratio,
    now_ms: now,
  });
  const emerging_count = emerging.ok ? emerging.emerging_count : 0;

  const top_verticals_by_density = Array.from(verticalCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([vertical_id, contribution_rows]) => ({ vertical_id, contribution_rows }));

  return {
    ok: true,
    version: TREND_VERSION,
    contract_version: TREND_EXTRACT_CONTRACT_VERSION,
    max_scan_rows: scanLimit,
    contribution_scan_rows: contributionRows.length,
    optin_scan_rows: optInRows.length,
    scan_capped: contributionRows.length >= scanLimit || optInRows.length >= scanLimit,
    total_contributors: contributors.size,
    total_namespaces: namespaces.size,
    total_optin_tenants: optInTenants.size,
    top_verticals_by_density,
    emerging_count,
    generated_at: new Date(now).toISOString(),
  };
}
