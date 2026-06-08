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

const PROVIDER_CONTRIBUTION = 'kolm_pattern_lake_contribution';
const PROVIDER_OPTIN = 'kolm_pattern_lake_optin';

// Minimum number of rows required across BOTH windows before we trust the
// emergent-pattern signal. Below this the envelope reports insufficient
// history rather than emitting a noisy small-sample top-K.
const MIN_HISTORY_ROWS = 10;

function _parseRow(r) {
  if (!r || !r.feedback) return null;
  try { return JSON.parse(r.feedback); } catch { return null; }
}

// Build a hash→count Map from a contribution row list, applying the same
// per-contributor dedupe rule as pattern-lake.aggregatePatterns so a single
// chatty namespace cannot inflate the histogram.
function _histogram(rows) {
  const seenPerContributor = new Map();
  const histogram = new Map();
  for (const row of rows) {
    if (!row || !row.tenant_id) continue;
    const payload = _parseRow(row);
    if (!payload || !Array.isArray(payload.bigram_hashes)) continue;
    const k = row.tenant_id + '|' + payload.namespace;
    let seen = seenPerContributor.get(k);
    if (!seen) { seen = new Set(); seenPerContributor.set(k, seen); }
    for (const h of payload.bigram_hashes) {
      if (typeof h !== 'string' || !h) continue;
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
} = {}) {
  const wDays = Math.max(1, Math.min(365, Math.trunc(Number(window_days)) || 30));
  const ratio = Math.max(1.01, Math.min(1000, Number(min_growth_ratio) || 2.0));
  const now = Date.now();
  const ms = wDays * 24 * 3600 * 1000;
  const recentSince = new Date(now - ms).toISOString();
  const priorSince = new Date(now - 2 * ms).toISOString();
  const priorUntil = new Date(now - ms).toISOString();

  const all = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    limit: 0,
  });

  // W411 - apply opt-in re-fence per row INSIDE the loop so a row whose
  // opt-in was revoked never participates in the trend computation.
  const recent = [];
  const prior = [];
  for (const r of all) {
    if (!r || !r.tenant_id || !r.created_at) continue;
    const payload = _parseRow(r);
    if (!payload || !payload.namespace) continue;
     
    const opted = await isOptedIn(r.tenant_id, payload.namespace);
     
    if (!opted) continue;
    if (r.created_at >= recentSince) recent.push(r);
    else if (r.created_at >= priorSince && r.created_at < priorUntil) prior.push(r);
  }

  if (recent.length + prior.length < MIN_HISTORY_ROWS) {
    return {
      ok: false,
      error: 'insufficient_history',
      need_min_rows: MIN_HISTORY_ROWS,
      have_recent: recent.length,
      have_prior: prior.length,
      window_days: wDays,
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
  emerging.sort((a, b) => b.growth_ratio - a.growth_ratio);

  return {
    ok: true,
    version: TREND_VERSION,
    window_days: wDays,
    min_growth_ratio: ratio,
    n_recent_rows: recent.length,
    n_prior_rows: prior.length,
    emerging_count: emerging.length,
    emerging: emerging.slice(0, 50),
    generated_at: new Date().toISOString(),
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
export async function summarizeTrends() {
  const contributionRows = await listEvents({
    provider: PROVIDER_CONTRIBUTION,
    limit: 0,
  });
  const contributors = new Set();
  const namespaces = new Set();
  const verticalCounts = new Map();
  // Best-effort vertical id list - kept in-sync with src/verticals.js
  // canonical order. Importing the catalog would be cleaner but would couple
  // this module to the verticals module's loading cost on every summary call.
  const KNOWN_VERTICAL_IDS = ['legal', 'medical', 'code', 'finance', 'support'];

  for (const r of contributionRows) {
    if (!r || !r.tenant_id) continue;
    const payload = _parseRow(r);
    if (!payload || !payload.namespace) continue;
     
    const opted = await isOptedIn(r.tenant_id, payload.namespace);
     
    if (!opted) continue;
    contributors.add(r.tenant_id);
    namespaces.add(r.tenant_id + '|' + payload.namespace);
    const ns = String(payload.namespace).toLowerCase();
    for (const vid of KNOWN_VERTICAL_IDS) {
      if (ns.includes(vid)) {
        verticalCounts.set(vid, (verticalCounts.get(vid) || 0) + 1);
      }
    }
  }

  // Count opt-in registry rows too so the summary distinguishes "tenants
  // opted in but not yet contributed" from "tenants currently contributing".
  const optInRows = await listEvents({ provider: PROVIDER_OPTIN, limit: 0 });
  const optInTenants = new Set();
  for (const r of optInRows) {
    if (!r || !r.tenant_id) continue;
    const payload = _parseRow(r);
    if (!payload || payload.action !== 'opt_in' || !payload.namespace) continue;
     
    const still = await isOptedIn(r.tenant_id, payload.namespace);
     
    if (still) optInTenants.add(r.tenant_id);
  }

  const emerging = await emergingPatterns({});
  const emerging_count = emerging.ok ? emerging.emerging_count : 0;

  const top_verticals_by_density = Array.from(verticalCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([vertical_id, contribution_rows]) => ({ vertical_id, contribution_rows }));

  return {
    ok: true,
    version: TREND_VERSION,
    total_contributors: contributors.size,
    total_namespaces: namespaces.size,
    total_optin_tenants: optInTenants.size,
    top_verticals_by_density,
    emerging_count,
    generated_at: new Date().toISOString(),
  };
}
