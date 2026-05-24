// W748 — Seasonal capture tagging + variants + auto-selection.
//
// Spec (KOLM_W707_SYSTEM_UPGRADE_PLAN.md lines 486-490):
//   [W748-1] Seasonal capture tagging + time-series viz
//   [W748-2] Option to distill seasonal variants -> namespace seasonal-variant
//   [W748-3] Automatic seasonal variant selection based on calendar
//
// Design contract (mirrors W746 capture-staleness.js):
//   - PURE FUNCTIONS in this module. No I/O. No clocks unless the date is
//     passed in. Same input -> same output. Lock-in tests pin the season
//     boundaries + event ranges so a future "tune the calendar" PR cannot
//     silently drift recommendations.
//   - HONEST about Northern-hemisphere defaults. SEASONS is biased towards
//     the N-hemisphere meteorological convention. Tenants in the southern
//     hemisphere flip via per-tenant settings (W748 follow-up). We never
//     pretend the four-season carve-up is universal — the docs page calls
//     this out and the API envelope echoes `hemisphere:'north'` so callers
//     can detect the bias.
//   - SEASONAL_EVENTS are US-retail-anchored (black-friday, cyber-monday,
//     tax-season-us, back-to-school). They are not meant to be exhaustive;
//     the registry exists so the recommendation engine has SOMETHING to
//     match against on day 1. Adding holidays for non-US tenants is a
//     follow-up that should land per-region overrides, not bake more
//     hardcoded ranges in here.
//   - tagCaptureWithSeason is IDEMPOTENT. A row that already carries a
//     non-empty `season` field is left alone — we trust the closer-to-source
//     value over the inferred one (matches W746 teacher-version contract).
//
// Public surface:
//   - SEASONAL_VERSION
//   - SEASONS (frozen)
//   - SEASONAL_EVENTS (frozen)
//   - seasonFromDate(date)
//   - eventsActiveOn(date)
//   - tagCaptureWithSeason(captureRow)
//   - seasonalDistribution(captures)
//   - recommendVariant(currentDate, namespace, capturesByVariant)

export const SEASONAL_VERSION = 'w748-v1';

// Northern-hemisphere meteorological seasons (Dec-Feb winter, etc.). The
// arrayindex is NOT month-aligned; use seasonFromDate(date) for lookup.
//
// Object.freeze pins length=4 and the value set so callers cannot mutate the
// season vocabulary at runtime (W604 anti-brittleness).
export const SEASONS = Object.freeze(['winter', 'spring', 'summer', 'fall']);

// SEASONAL_EVENTS — name -> [start_month, start_day, end_month, end_day] (1-indexed,
// inclusive on both ends). Cross-year ranges (e.g. 'holiday' starts Dec 15
// and ends Jan 5) are honoured by eventsActiveOn() via wrap-around logic.
//
// Object.freeze (and freezing the inner arrays) makes the registry
// effectively immutable from outside callers.
export const SEASONAL_EVENTS = Object.freeze({
  'black-friday': Object.freeze([11, 21, 11, 30]),
  'cyber-monday': Object.freeze([12, 1, 12, 2]),
  'holiday':      Object.freeze([12, 15, 1, 5]),
  'tax-season-us': Object.freeze([1, 15, 4, 15]),
  'back-to-school': Object.freeze([8, 1, 9, 15]),
});

// =============================================================================
// _coerceDate — accept Date | ISO string | epoch-millis number. Returns a
// Date instance or null on garbage (callers branch on null).
// =============================================================================
function _coerceDate(d) {
  if (d == null) return null;
  if (d instanceof Date) return Number.isFinite(d.getTime()) ? d : null;
  if (typeof d === 'number' && Number.isFinite(d)) return new Date(d);
  if (typeof d === 'string') {
    const t = new Date(d);
    return Number.isFinite(t.getTime()) ? t : null;
  }
  return null;
}

// =============================================================================
// seasonFromDate(date) — N-hemisphere meteorological season for a date.
//
// Convention:
//   winter — Dec, Jan, Feb     (getMonth() returns 11, 0, 1)
//   spring — Mar, Apr, May     (2, 3, 4)
//   summer — Jun, Jul, Aug     (5, 6, 7)
//   fall   — Sep, Oct, Nov     (8, 9, 10)
//
// Returns null on unparseable input (matches the W746 freshnessDistribution
// "garbage falls into overflow" honesty contract — we never invent a season).
// =============================================================================
export function seasonFromDate(date) {
  const d = _coerceDate(date);
  if (!d) return null;
  const m = d.getUTCMonth(); // 0..11
  if (m === 11 || m === 0 || m === 1) return 'winter';
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  return 'fall'; // 8..10
}

// =============================================================================
// _inRange(month, day, sm, sd, em, ed) — true iff (month, day) falls in the
// [(sm, sd), (em, ed)] inclusive range, with cross-year wrap-around when
// the end is BEFORE the start (e.g. holiday 12/15 -> 1/5).
//
// All months 1..12 (HUMAN one-indexed), days 1..31.
// =============================================================================
function _inRange(month, day, sm, sd, em, ed) {
  // Compare via packed "MMDD" integer (no leap-year edge cases — Feb 29
  // simply lands in any range that spans Feb).
  const cur = month * 100 + day;
  const start = sm * 100 + sd;
  const end = em * 100 + ed;
  if (start <= end) {
    // Single-year range: 1/15..4/15.
    return cur >= start && cur <= end;
  }
  // Cross-year range: holiday 12/15..1/5 -> active on Dec 20 AND Jan 3.
  return cur >= start || cur <= end;
}

// =============================================================================
// eventsActiveOn(date) — return an array of event names active on the given
// date. Output is sorted alphabetically so the UI render is deterministic.
//
// Returns [] on unparseable input (honest — we don't guess at the calendar).
// =============================================================================
export function eventsActiveOn(date) {
  const d = _coerceDate(date);
  if (!d) return [];
  const m = d.getUTCMonth() + 1; // 1..12
  const day = d.getUTCDate();   // 1..31
  const out = [];
  for (const name of Object.keys(SEASONAL_EVENTS)) {
    const [sm, sd, em, ed] = SEASONAL_EVENTS[name];
    if (_inRange(m, day, sm, sd, em, ed)) {
      out.push(name);
    }
  }
  return out.sort();
}

// =============================================================================
// tagCaptureWithSeason(captureRow) — stamp the row with season + events.
//
// MUTATES + RETURNS the row (callers can chain). Idempotent: if the row
// already carries a non-empty `season` string, we leave the existing
// `season` + `seasonal_events` fields alone (closer-to-source wins —
// matches W746 teacher-version contract).
//
// Adds:
//   season           — string ('winter'|'spring'|'summer'|'fall'|null)
//   seasonal_events  — array of event names (sorted, possibly empty)
//
// The date considered for tagging is row.captured_at OR row.created_at OR
// Date.now() — first non-null wins. Unparseable dates -> season:null and
// seasonal_events:[] (honest — we never guess).
// =============================================================================
export function tagCaptureWithSeason(captureRow) {
  if (!captureRow || typeof captureRow !== 'object') return captureRow;
  // Idempotent: existing season tag wins. Empty string is treated as
  // "not yet tagged" so a row written as `season:''` gets re-tagged.
  if (typeof captureRow.season === 'string' && captureRow.season.trim()) {
    if (!Array.isArray(captureRow.seasonal_events)) {
      // Backfill seasonal_events if missing but season exists (cosmetic).
      captureRow.seasonal_events = eventsActiveOn(
        captureRow.captured_at || captureRow.created_at || Date.now()
      );
    }
    return captureRow;
  }
  const when = captureRow.captured_at || captureRow.created_at || Date.now();
  captureRow.season = seasonFromDate(when);
  captureRow.seasonal_events = eventsActiveOn(when);
  return captureRow;
}

// =============================================================================
// seasonalDistribution(captures) — count rows per season + per event.
//
// Returns:
//   {
//     by_season: { winter:N, spring:N, summer:N, fall:N, _unknown:N },
//     by_event:  { 'black-friday':N, 'holiday':N, ... },
//     total:     N
//   }
//
// _unknown bucket catches rows with no season tag (garbage timestamps,
// pre-W748 rows). by_event only includes events that actually appeared
// (no zero-count keys) so the UI render is compact. Totals always sum to
// input length so we never silently drop a row from the chart.
// =============================================================================
export function seasonalDistribution(captures) {
  const list = Array.isArray(captures) ? captures : [];
  const by_season = { winter: 0, spring: 0, summer: 0, fall: 0, _unknown: 0 };
  const by_event = {};
  for (const cap of list) {
    if (!cap || typeof cap !== 'object') continue;
    let s = (typeof cap.season === 'string' && cap.season.trim()) ? cap.season.trim() : null;
    if (!s) {
      // Try to derive on the fly from captured_at/created_at so the
      // dashboard isn't blank for untagged corpora.
      s = seasonFromDate(cap.captured_at || cap.created_at);
    }
    if (s && SEASONS.indexOf(s) >= 0) {
      by_season[s] += 1;
    } else {
      by_season._unknown += 1;
    }
    let evts = Array.isArray(cap.seasonal_events) ? cap.seasonal_events : null;
    if (!evts) {
      evts = eventsActiveOn(cap.captured_at || cap.created_at);
    }
    for (const e of evts) {
      by_event[e] = (by_event[e] || 0) + 1;
    }
  }
  return { by_season, by_event, total: list.length };
}

// =============================================================================
// recommendVariant(currentDate, namespace, capturesByVariant)
//
// Picks the seasonal variant whose key matches an event active today, then
// falls back to a variant matching today's season. capturesByVariant is an
// object { [variant_name]: count_of_captures } describing which variants
// actually exist for this namespace.
//
// Recommendation priority:
//   1. ACTIVE EVENT match — if today is a black-friday day and a 'black-friday'
//      variant exists, that wins (event-specific recommendations beat seasonal
//      ones because events are tighter time windows).
//   2. SEASON match — if no event matches, fall back to today's season.
//   3. NULL — no recommendation. The honest fallback. `reason` always
//      explains WHY so the dashboard can show a useful empty state.
//
// Returns:
//   { recommended: 'black-friday' | 'winter' | null, reason: 'string' }
// =============================================================================
export function recommendVariant(currentDate, namespace, capturesByVariant) {
  const d = _coerceDate(currentDate);
  const variants = (capturesByVariant && typeof capturesByVariant === 'object') ? capturesByVariant : {};
  const variantKeys = Object.keys(variants);
  if (!d) {
    return {
      recommended: null,
      reason: 'no_date_provided_or_unparseable',
    };
  }
  if (variantKeys.length === 0) {
    return {
      recommended: null,
      reason: 'no_variants_registered_for_namespace',
    };
  }
  const activeEvents = eventsActiveOn(d);
  const season = seasonFromDate(d);
  // 1. Event match first (tighter window beats seasonal).
  for (const e of activeEvents) {
    if (Object.prototype.hasOwnProperty.call(variants, e) && variants[e] > 0) {
      return {
        recommended: e,
        reason: `active_event_match: ${e} (window ${SEASONAL_EVENTS[e][0]}/${SEASONAL_EVENTS[e][1]}..${SEASONAL_EVENTS[e][2]}/${SEASONAL_EVENTS[e][3]})`,
      };
    }
  }
  // 2. Season fallback.
  if (season && Object.prototype.hasOwnProperty.call(variants, season) && variants[season] > 0) {
    return {
      recommended: season,
      reason: `season_match: ${season} (n-hemisphere default)`,
    };
  }
  // 3. Honest null. Explain what we looked at.
  const summary = activeEvents.length > 0
    ? `no_variant_for_active_events:[${activeEvents.join(',')}]_or_season:${season}`
    : `no_variant_for_season:${season}`;
  return {
    recommended: null,
    reason: summary + ` (registered_variants:[${variantKeys.join(',')}])`,
  };
}
