// W918 - Temporal coverage analyzer.
//
// Compares the time-of-occurrence distribution of PRODUCTION captures against
// an expected (uniform) baseline and surfaces under-represented temporal
// buckets - e.g. "weekends are 2% of training data but 28% of the week".
//
// The training corpus is rarely uniform across time. Production traffic that
// spikes on weekends, after hours, or in winter shows up under-sampled in a
// distill set that was harvested during a single weekday business sprint. A
// student trained on that skewed corpus inherits the gap: it has never seen
// the prompts that arrive at 2am Saturday in January. This analyzer makes the
// skew visible so the next capture window can be widened to cover it.
//
// What it does:
//
//   1. analyzeTemporalCoverage({tenant, namespace, window_days, captures})
// - bucket every capture's time-of-occurrence three ways:
//        * by_weekday  : 7 counts, Sunday(0)..Saturday(6)
//        * by_hour     : 24 counts, 0..23 local-to-UTC hour
//        * by_season   : {winter, spring, summer, fall} keyed off month
//      derive weekday vs weekend rollups, compute share = count/total per
//      bucket, and flag buckets whose share falls below half the expected
//      uniform share as under-represented gaps.
//
//   2. summarizeGaps(result) - pure one-liner naming the worst gap, e.g.
//      "weekend under-represented (3% vs 29% expected)".
//
// Persistence: best-effort via src/event-store.js. A failed write NEVER
// fails the analysis call - the returned envelope still carries the buckets.
//
// Caveats / constraints:
//
//   - Time-of-occurrence is read from each capture's created_at (canonical
//     event-store column) or ts (capture-row shorthand). A row with neither a
//     parseable created_at nor ts is skipped from the histogram but still
//     counted toward n_captures via the parse-failure path? No - only rows
//     that yield a valid Date contribute to buckets AND to the denominator,
//     so shares always sum to ~1 over the parseable set. n_captures reports
//     the parseable count so a caller can see how many rows were usable.
//   - Weekday/hour/season are computed in UTC. We do NOT attempt per-tenant
//     timezone localization here - that is a downstream concern. The gap
//     signal (weekends/after-hours under-represented) is robust to a few
//     hours of UTC offset because the buckets are coarse.
//   - The expected baseline is uniform. A tenant whose REAL traffic is itself
//     weekday-skewed will see a "weekend gap" that merely reflects genuinely
//     lower weekend volume. This analyzer measures coverage vs a flat
//     calendar, not vs the tenant's own demand curve. Pair it with the
//     active-learning demand histogram when demand-weighting matters.
//
// Pure-JS, no top-level deps added.

import * as eventStore from './event-store.js';

export const TEMPORAL_VERSION = 'tmp-v1';

const PROVIDER = 'kolm_temporal';

// Expected uniform shares. A 7-day week has 5 weekdays and 2 weekend days, so
// the weekend's share of the calendar is 2/7. Each hour-of-day is 1/24 of a
// day. Each of the four seasons is 1/4 of the year.
const WEEKEND_EXPECTED = 2 / 7;          // ≈ 0.2857
const WEEKDAY_EXPECTED = 5 / 7;          // ≈ 0.7143
const HOUR_EXPECTED = 1 / 24;            // ≈ 0.0417
const SEASON_EXPECTED = 1 / 4;           // 0.25

// A bucket is an under-represented gap when its observed share drops below
// half its expected uniform share. Half is the same gap_threshold the
// active-learning coverage detector uses (0.5 × baseline) so the two surfaces
// agree on what "under-represented" means.
const GAP_THRESHOLD = 0.5;

// Northern-hemisphere meteorological seasons keyed by month index (0=Jan).
// Dec/Jan/Feb = winter, Mar/Apr/May = spring, Jun/Jul/Aug = summer,
// Sep/Oct/Nov = fall. We use meteorological (whole-month) boundaries rather
// than astronomical solstice dates so the bucket math stays integer-clean.
const SEASON_BY_MONTH = [
  'winter', 'winter',                    // Jan, Feb
  'spring', 'spring', 'spring',          // Mar, Apr, May
  'summer', 'summer', 'summer',          // Jun, Jul, Aug
  'fall', 'fall', 'fall',                // Sep, Oct, Nov
  'winter',                              // Dec
];

const SEASONS = ['winter', 'spring', 'summer', 'fall'];

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function _isoNow() {
  return new Date().toISOString();
}

// Extract a valid Date (ms since epoch) from a capture row. Accepts the
// canonical event-store created_at (ISO string) and the capture-row ts
// shorthand (epoch ms number or ISO string). Returns null on anything
// unparseable - the caller skips null rows from the histogram.
function _extractDateMs(row) {
  if (!row || typeof row !== 'object') return null;
  // created_at: canonical event-store column, usually an ISO string.
  if (row.created_at != null) {
    const ms = _toMs(row.created_at);
    if (ms != null) return ms;
  }
  // ts: capture-row shorthand. May be epoch ms (number) or ISO (string).
  if (row.ts != null) {
    const ms = _toMs(row.ts);
    if (ms != null) return ms;
  }
  return null;
}

function _toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  // A numeric-looking string could be epoch ms; otherwise parse as a date.
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return null;
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return Number.isFinite(n) ? n : null;
    }
    const ms = new Date(trimmed).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  // Date instance or anything coercible.
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _round(n, places = 4) {
  const f = Math.pow(10, places);
  return Math.round((Number(n) || 0) * f) / f;
}

// Best-effort persistence following the binding kolm event-store pattern.
async function _persist({ tenant, namespace, workflow, payload }) {
  try {
    const ev = await eventStore.appendEvent({
      tenant_id: tenant,
      namespace: namespace || 'default',
      provider: PROVIDER,
      vendor: 'kolm',
      model: 'temporal-analyzer/v1',
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
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the temporal coverage of a set of captures against a uniform
 * calendar baseline.
 *
 * @param {object} args
 * @param {string} [args.tenant='tenant_local']  tenant id for the read + persist seam.
 * @param {string} [args.namespace='default']
 * @param {number} [args.window_days]  when reading from the event-store, only
 *   consider captures created within the last N days. Ignored when `captures`
 *   is supplied directly.
 * @param {Array<{created_at?:string|number, ts?:string|number}>} [args.captures]
 *   when provided, used DIRECTLY (the testable path). Otherwise rows are read
 *   from the event-store via listEvents.
 * @returns {Promise<{ok:boolean, version:string, buckets?:object,
 *                    gaps?:Array, n_captures?:number, persisted?:object,
 *                    error?:string}>}
 */
export async function analyzeTemporalCoverage(args = {}) {
  const tenant = (args && args.tenant) || 'tenant_local';
  const namespace = (args && args.namespace) || 'default';
  const windowDays = Number.isFinite(Number(args && args.window_days))
    ? Math.max(0, Number(args.window_days))
    : null;

  // 1. Source the rows. Direct captures param wins (the testable path);
  //    otherwise read the canonical event-store lake.
  let rows;
  if (Array.isArray(args && args.captures)) {
    rows = args.captures.filter(Boolean);
  } else {
    try {
      const since = windowDays
        ? new Date(Date.now() - windowDays * DAY_MS).toISOString()
        : undefined;
      rows = await eventStore.listEvents({
        tenant_id: tenant,
        namespace,
        limit: 5000,
        order: 'desc',
        since,
      });
      rows = Array.isArray(rows) ? rows.filter(Boolean) : [];
    } catch (e) {
      return {
        ok: false,
        error: 'event_store_read_failed: ' + String((e && e.message) || e),
        version: TEMPORAL_VERSION,
      };
    }
  }

  // 2. Bucket every parseable row.
  const byWeekday = [0, 0, 0, 0, 0, 0, 0];      // Sun(0)..Sat(6)
  const byHour = new Array(24).fill(0);
  const bySeason = { winter: 0, spring: 0, summer: 0, fall: 0 };
  let total = 0;

  for (const row of rows) {
    const ms = _extractDateMs(row);
    if (ms == null) continue;
    const d = new Date(ms);
    const wd = d.getUTCDay();          // 0=Sun .. 6=Sat
    const hr = d.getUTCHours();        // 0..23
    const season = SEASON_BY_MONTH[d.getUTCMonth()] || 'winter';
    if (wd >= 0 && wd <= 6) byWeekday[wd] += 1;
    if (hr >= 0 && hr <= 23) byHour[hr] += 1;
    bySeason[season] += 1;
    total += 1;
  }

  // 3. Roll up weekday vs weekend and compute shares. Sun(0)+Sat(6) = weekend.
  const weekendCount = byWeekday[0] + byWeekday[6];
  const weekdayCount = total - weekendCount;
  const denom = total > 0 ? total : 0;
  const shareOf = (c) => (denom > 0 ? c / denom : 0);

  const buckets = {
    by_weekday: byWeekday.slice(),
    weekday: {
      count: weekdayCount,
      share: _round(shareOf(weekdayCount)),
    },
    weekend: {
      count: weekendCount,
      share: _round(shareOf(weekendCount)),
    },
    by_hour: byHour.slice(),
    by_season: { ...bySeason },
  };

  // 4. Detect under-represented gaps. A bucket is a gap when its observed
  //    share < expected × GAP_THRESHOLD. With zero captures every bucket is
  //    trivially at share 0; we still surface the gaps so a caller polling an
  //    empty namespace sees "everything under-represented" rather than a
  //    silent all-clear.
  const gaps = [];

  // weekend rollup gap (the headline signal).
  {
    const share = shareOf(weekendCount);
    if (share < WEEKEND_EXPECTED * GAP_THRESHOLD) {
      gaps.push(_gap('weekend', share, WEEKEND_EXPECTED));
    }
  }
  // weekday rollup gap (rare, but a corpus harvested only on weekends trips it).
  {
    const share = shareOf(weekdayCount);
    if (share < WEEKDAY_EXPECTED * GAP_THRESHOLD) {
      gaps.push(_gap('weekday', share, WEEKDAY_EXPECTED));
    }
  }
  // per-season gaps.
  for (const s of SEASONS) {
    const share = shareOf(bySeason[s]);
    if (share < SEASON_EXPECTED * GAP_THRESHOLD) {
      gaps.push(_gap('season:' + s, share, SEASON_EXPECTED));
    }
  }
  // per-hour gaps - group of 24, expected 1/24 each.
  for (let h = 0; h < 24; h++) {
    const share = shareOf(byHour[h]);
    if (share < HOUR_EXPECTED * GAP_THRESHOLD) {
      gaps.push(_gap('hour:' + h, share, HOUR_EXPECTED));
    }
  }

  // Surface the most severe deficits first.
  gaps.sort((a, b) => b.deficit - a.deficit);

  const result = {
    ok: true,
    version: TEMPORAL_VERSION,
    buckets,
    gaps,
    n_captures: total,
  };

  // 5. Persist best-effort. NEVER fail the call on a persistence error.
  const persisted = await _persist({
    tenant,
    namespace,
    workflow: 'temporal:analysis',
    payload: {
      n_captures: total,
      weekday_share: buckets.weekday.share,
      weekend_share: buckets.weekend.share,
      by_season: buckets.by_season,
      gap_buckets: gaps.map((g) => g.bucket),
      gap_count: gaps.length,
    },
  });
  result.persisted = persisted;

  return result;
}

// Build a single gap record. deficit = how far below the expected uniform
// share this bucket sits (always positive for a real gap).
function _gap(bucket, share, expected) {
  return {
    bucket,
    share: _round(share),
    expected: _round(expected),
    deficit: _round(expected - share),
    underrepresented: true,
  };
}

/**
 * Pure one-liner naming the worst gap, e.g.
 *   "weekend under-represented (3% vs 29% expected)".
 *
 * When the result carries no gaps, returns a clear all-clear string. Never
 * throws - a malformed result yields a safe fallback string.
 *
 * @param {object} result  the value returned by analyzeTemporalCoverage.
 * @returns {string}
 */
export function summarizeGaps(result) {
  if (!result || typeof result !== 'object') {
    return 'temporal coverage unavailable';
  }
  if (result.ok === false) {
    return 'temporal coverage error: ' + String(result.error || 'unknown');
  }
  const gaps = Array.isArray(result.gaps) ? result.gaps : [];
  if (gaps.length === 0) {
    return 'temporal coverage balanced (no under-represented buckets)';
  }
  // Worst = largest deficit. The list is already sorted by deficit desc, but
  // re-derive defensively so the function is correct on any gaps array.
  let worst = gaps[0];
  for (const g of gaps) {
    if (g && Number(g.deficit) > Number(worst.deficit)) worst = g;
  }
  const pct = (x) => Math.round((Number(x) || 0) * 100) + '%';
  const label = _humanBucket(worst.bucket);
  return `${label} under-represented (${pct(worst.share)} vs ${pct(worst.expected)} expected)`;
}

// Turn a bucket key into a human label for the summary line.
function _humanBucket(bucket) {
  const b = String(bucket || '');
  if (b.startsWith('season:')) return b.slice('season:'.length) + ' season';
  if (b.startsWith('hour:')) return b.slice('hour:'.length) + ':00 hour';
  return b; // 'weekend' / 'weekday'
}

export const __internals = {
  _extractDateMs,
  _toMs,
  _humanBucket,
  WEEKEND_EXPECTED,
  WEEKDAY_EXPECTED,
  HOUR_EXPECTED,
  SEASON_EXPECTED,
  GAP_THRESHOLD,
  SEASON_BY_MONTH,
};

export default {
  TEMPORAL_VERSION,
  analyzeTemporalCoverage,
  summarizeGaps,
  __internals,
};
