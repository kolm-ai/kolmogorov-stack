// Agent Security-Review audit - audit-trail analyzer.
//
// Consumes normalized AuditEvents (src/audit-event.js) and assesses the trail
// itself against the three properties an enterprise reviewer (and EU AI Act
// Art.12 "record-keeping") demands of agent logs:
//
//   1. COMPLETENESS - every action carries who, what, and when, so the
//                       trail is traceable end to end.
//   2. TAMPER-EVIDENCE - the trail is hash-chained / append-only, so an
//                       altered or deleted entry is detectable.
//   3. RETENTION - the trail spans (and is kept for) a window long
//                       enough to satisfy record-keeping obligations.
//
// Field data: ~1 in 3 production agents have NO tamper-evident audit trail.
// That single gap blocks a clean attestation, so it is treated as high.
//
// Output is a list of Findings the control-mapper translates into SOC 2 /
// ISO 42001 / NIST AI RMF / EU AI Act / OWASP controls. Never throws.

const ANALYZER = 'audit-trail';

// EU AI Act record-keeping practice: logs retained for an appropriate period,
// commonly read as at least six months. Configurable via opts.retentionDays.
const DEFAULT_RETENTION_DAYS = 182;
const DAY_MS = 86400000;

// --- volume-consistency thresholds (GAP-3 detection half) ----------------
// A vendor-curated "quiet week" export passes every per-event check while the
// busy weeks never reach the evidence. These thresholds flag the statistical
// signature of curation while staying DELIBERATELY generous, so ordinary bursty
// agent traffic does not trip them:
//   - need at least this many active (non-zero) UTC days before any volume
//     judgement is made at all (one or two days is just a small sample);
const VOLUME_MIN_ACTIVE_DAYS = 3;
//   - the busiest day exceeding 25x the MEDIAN active day is far beyond normal
//     burstiness (weekday/weekend swings are single-digit multiples);
const VOLUME_BUSIEST_TO_MEDIAN_MAX = 25;
//   - >=40% of the days inside the observed span carrying ZERO events suggests
//     the export was sliced around the activity, not exported continuously.
//     This arm needs a real sample: tiny demo exports (a handful of events
//     across months) are sparse by nature, not curated, so it only applies
//     from this many parseable-timestamp events upward.
const VOLUME_ZERO_DAY_FRACTION = 0.4;
const VOLUME_ZERO_DAY_MIN_EVENTS = 50;

function parseTs(ts) {
  if (ts == null) return null;
  // Numeric epoch - either a raw number, or the bare numeric string that
  // normalizeEvent produces when the source logged an integer timestamp
  // (very common: LiteLLM/Helicone often log unix seconds/ms). Date.parse
  // rejects numeric strings, so detect and convert them before falling back
  // to ISO/RFC parsing - otherwise a fully-timestamped trail is misreported
  // as "missing timestamps", a false finding in a paid audit.
  let n = null;
  if (typeof ts === 'number' && Number.isFinite(ts)) n = ts;
  else if (typeof ts === 'string' && /^\d{9,16}(\.\d+)?$/.test(ts.trim())) n = Number(ts.trim());
  if (n != null && Number.isFinite(n)) {
    const ms = n < 1e12 ? n * 1000 : n; // < 1e12 → seconds, else milliseconds
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof ts !== 'string' || ts.trim() === '') return null;
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : null;
}

function finding(f) {
  return {
    id: f.id,
    analyzer: ANALYZER,
    severity: f.severity,
    pillar: f.pillar || 'audit-trail',
    title: f.title,
    detail: f.detail,
    metric: f.metric || {},
    evidence: f.evidence || [],
    controls: f.controls || [],
  };
}

function pct(n, d) {
  return d > 0 ? Number(((n / d) * 100).toFixed(1)) : 0;
}

/**
 * analyzeAuditTrail - completeness / tamper-evidence / retention analysis.
 *
 * @param {object[]} events
 * @param {{ retentionDays?: number }} [opts]
 * @returns {{ findings: object[], coverage: object, summary: object }}
 */
export function analyzeAuditTrail(events, opts = {}) {
  const list = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const total = list.length;
  const requiredDays = Number.isFinite(opts.retentionDays) && opts.retentionDays > 0
    ? opts.retentionDays
    : DEFAULT_RETENTION_DAYS;

  // --- field-level completeness counters ---
  let missingTs = 0;
  let unparseableTs = 0;
  let missingActor = 0;
  let missingAction = 0;
  let withHash = 0;
  let withPrev = 0;
  const ids = new Map(); // id -> count, for duplicate detection
  const tsValues = [];
  const sample = { ts: [], actor: [], action: [] };

  for (const e of list) {
    const tsRaw = e.ts;
    if (tsRaw == null) { missingTs++; if (sample.ts.length < 5) sample.ts.push(e.id); }
    else {
      const parsed = parseTs(tsRaw);
      if (parsed == null) { unparseableTs++; if (sample.ts.length < 5) sample.ts.push(e.id); }
      else tsValues.push(parsed);
    }

    const actor = e.actor || {};
    if (!actor.key_id && !actor.agent) { missingActor++; if (sample.actor.length < 5) sample.actor.push(e.id); }

    const action = e.action || {};
    const hasAction = action.tool || action.host || action.server || (action.type && action.type !== 'unknown');
    if (!hasAction) { missingAction++; if (sample.action.length < 5) sample.action.push(e.id); }

    if (e.hash) withHash++;
    if (e.prev_hash) withPrev++;

    if (e.id) ids.set(e.id, (ids.get(e.id) || 0) + 1);
  }

  // --- hash-chain integrity (only meaningful where hashes exist) ---
  // A hash chain is verifiable ORDER-INDEPENDENTLY: a link is intact when an
  // entry's prev_hash references a hash that exists somewhere in the trail.
  // Array order is NOT chain order - real exports are routinely newest-first
  // (DB dump ORDER BY ts DESC) or merged from several files, and a single source
  // record fans out into several AuditEvents that all carry that record's
  // hash/prev_hash. A position-based walk flags an intact, untampered chain as
  // broken (a credibility-destroying critical false positive), so instead build
  // the set of all hashes present and check each DISTINCT prev-link against it.
  const hashSet = new Set();
  for (const e of list) if (e.hash != null) hashSet.add(e.hash);
  let chainChecked = 0;
  let chainBroken = 0;
  const seenLinks = new Set(); // collapse the same fanned-out link, checked once
  for (const e of list) {
    if (e.prev_hash == null) continue; // genesis / not a link
    const linkKey = (e.hash != null ? e.hash : '∅') + '<-' + e.prev_hash;
    if (seenLinks.has(linkKey)) continue;
    seenLinks.add(linkKey);
    chainChecked++;
    if (!hashSet.has(e.prev_hash)) chainBroken++; // prev references a hash not in the trail
  }

  const duplicateIds = [];
  for (const [id, n] of ids) if (n > 1) duplicateIds.push({ id, count: n });

  // --- retention / time span ---
  let spanDays = 0;
  let earliest = null;
  let latest = null;
  if (tsValues.length > 0) {
    earliest = Math.min(...tsValues);
    latest = Math.max(...tsValues);
    spanDays = Number(((latest - earliest) / DAY_MS).toFixed(2));
  }

  // --- per-UTC-day event histogram (volume consistency, GAP-3) ---
  const perDay = new Map(); // 'YYYY-MM-DD' -> count
  for (const t of tsValues) {
    const day = new Date(t).toISOString().slice(0, 10);
    perDay.set(day, (perDay.get(day) || 0) + 1);
  }
  const eventsPerDay = {};
  for (const day of [...perDay.keys()].sort()) eventsPerDay[day] = perDay.get(day);

  const coverage = {
    events: total,
    with_timestamp: total - missingTs - unparseableTs,
    missing_timestamp: missingTs,
    unparseable_timestamp: unparseableTs,
    attributed: total - missingActor,
    unattributed: missingActor,
    with_action: total - missingAction,
    missing_action: missingAction,
    hash_chained: withHash,
    with_prev_link: withPrev,
    chain_links_checked: chainChecked,
    chain_links_broken: chainBroken,
    duplicate_ids: duplicateIds.length,
    span_days: spanDays,
    earliest_ms: earliest,
    latest_ms: latest,
    events_per_day: eventsPerDay,
    required_retention_days: requiredDays,
    completeness_pct: total > 0
      ? Number((((total - missingTs - unparseableTs) + (total - missingActor) + (total - missingAction)) / (3 * total) * 100).toFixed(1))
      : 0,
  };

  const findings = [];
  if (total === 0) {
    return { findings, coverage, summary: summarize(findings, coverage) };
  }

  // --- tamper-evidence ---
  if (withHash === 0) {
    findings.push(finding({
      id: 'no-tamper-evidence',
      severity: 'high',
      title: 'No tamper-evident audit trail',
      detail: 'None of the recorded actions carry a chain hash, so any entry can be altered or deleted after the fact without detection. An append-only, hash-chained log (each entry linking the previous) is the baseline an enterprise reviewer requires to trust the trail.',
      metric: { hash_chained: 0, events: total },
      evidence: list.slice(0, 5).map((e) => e.id),
    }));
  } else if (chainBroken > 0) {
    findings.push(finding({
      id: 'broken-hash-chain',
      severity: 'critical',
      title: `Broken hash chain in ${chainBroken} link(s)`,
      detail: `${chainBroken} of ${chainChecked} checked chain links do not connect (an entry's prev_hash does not match the prior entry's hash). This indicates tampering, reordering, or deletion in the trail.`,
      metric: { chain_links_broken: chainBroken, chain_links_checked: chainChecked },
      evidence: [],
    }));
  } else if (withHash < total) {
    findings.push(finding({
      id: 'partial-tamper-evidence',
      severity: 'medium',
      title: `Tamper-evidence covers only ${pct(withHash, total)}% of the trail`,
      detail: `${total - withHash} of ${total} events are not hash-chained, leaving gaps an attacker could edit undetectably. Chain every recorded action, not a subset.`,
      metric: { hash_chained: withHash, events: total, coverage_pct: pct(withHash, total) },
      evidence: [],
    }));
  }

  // --- completeness: timestamps ---
  if (missingTs + unparseableTs > 0) {
    const bad = missingTs + unparseableTs;
    findings.push(finding({
      id: 'incomplete-timestamps',
      severity: bad === total ? 'high' : 'medium',
      title: `${pct(bad, total)}% of events lack a usable timestamp`,
      detail: `${bad} of ${total} events have a missing or unparseable timestamp, so ordering and retention cannot be established. Record an ISO 8601 timestamp on every action.`,
      metric: { missing: missingTs, unparseable: unparseableTs, events: total },
      evidence: sample.ts,
    }));
  }

  // --- completeness: attribution / traceability ---
  if (missingActor > 0) {
    findings.push(finding({
      id: 'unattributed-events',
      severity: pct(missingActor, total) >= 25 ? 'high' : 'medium',
      title: `${pct(missingActor, total)}% of events have no actor attribution`,
      detail: `${missingActor} of ${total} events record neither a credential nor an agent identity, breaking traceability - a reviewer cannot tell who or what performed the action. Attribution to a specific credential is required for accountable record-keeping.`,
      metric: { unattributed: missingActor, events: total },
      evidence: sample.actor,
    }));
  }

  // --- completeness: action detail ---
  if (missingAction > 0) {
    findings.push(finding({
      id: 'missing-action-detail',
      severity: 'low',
      title: `${pct(missingAction, total)}% of events lack an identifiable action`,
      detail: `${missingAction} of ${total} events record no tool, host, or typed action, so what the agent actually did is not captured. Record the concrete action (tool name / target host / verb) on every entry.`,
      metric: { missing_action: missingAction, events: total },
      evidence: sample.action,
    }));
  }

  // --- duplicate ids (replay / ingestion error) ---
  if (duplicateIds.length > 0) {
    findings.push(finding({
      id: 'duplicate-event-ids',
      severity: 'low',
      title: `${duplicateIds.length} duplicated event id(s)`,
      detail: 'Repeated event identifiers indicate either replayed entries or a non-unique id scheme, both of which undermine confidence that the trail is a faithful, append-only record.',
      metric: { duplicate_ids: duplicateIds.slice(0, 20) },
      evidence: duplicateIds.slice(0, 5).map((d) => d.id),
    }));
  }

  // --- retention ---
  if (tsValues.length === 0) {
    findings.push(finding({
      id: 'retention-unverifiable',
      severity: 'medium',
      title: 'Retention window cannot be verified',
      detail: `No usable timestamps means the trail's retention period cannot be evidenced against the ~${requiredDays}-day record-keeping expectation.`,
      metric: { required_retention_days: requiredDays },
      evidence: [],
    }));
  } else if (spanDays < requiredDays) {
    findings.push(finding({
      id: 'short-retention-window',
      severity: 'low',
      title: `Observed trail spans ${spanDays} days (< ~${requiredDays})`,
      detail: `The observed events cover ${spanDays} days, below the ~${requiredDays}-day record-keeping expectation. Confirm retention policy keeps the full trail for the required window; this may simply reflect the sample provided rather than the retained history.`,
      metric: { span_days: spanDays, required_retention_days: requiredDays },
      evidence: [],
    }));
  }

  // --- volume consistency (GAP-3 detection half) ---
  // The statistical signature of a curated export: activity wildly concentrated
  // in a few days, or most of the observed span silent. Thresholds + rationale
  // at the VOLUME_* constants above. Generous on purpose - a finding here says
  // "this looks sliced; ask for a coverage declaration", never "fraud".
  const activeDayCounts = [...perDay.values()].sort((a, b) => a - b);
  if (activeDayCounts.length >= VOLUME_MIN_ACTIVE_DAYS) {
    const busiest = activeDayCounts[activeDayCounts.length - 1];
    const median = activeDayCounts[Math.floor(activeDayCounts.length / 2)];
    const daysInSpan = Math.floor((latest - earliest) / DAY_MS) + 1;
    const zeroDays = Math.max(0, daysInSpan - activeDayCounts.length);
    const zeroFraction = daysInSpan > 0 ? zeroDays / daysInSpan : 0;
    const ratioTripped = median > 0 && busiest > VOLUME_BUSIEST_TO_MEDIAN_MAX * median;
    const zeroTripped = tsValues.length >= VOLUME_ZERO_DAY_MIN_EVENTS && zeroFraction >= VOLUME_ZERO_DAY_FRACTION;
    if (ratioTripped || zeroTripped) {
      findings.push(finding({
        id: 'trail-volume-inconsistent',
        severity: 'medium',
        title: 'Event volume is inconsistent across the observed window',
        detail: `Daily event volume across the observed ${daysInSpan}-day window is uneven: the busiest day carries ${busiest} event(s) against a median active day of ${median}, and ${zeroDays} day(s) in the span have no events at all. A deliberately quiet or sliced export (a "quiet week") looks exactly like this while the busy periods never reach the evidence. Ask the exporting vendor for a coverage declaration stating the export window, the systems included, and the expected daily call volume, and bind it to the report.`,
        metric: {
          days_in_span: daysInSpan,
          active_days: activeDayCounts.length,
          zero_days: zeroDays,
          busiest_day_events: busiest,
          median_active_day_events: median,
        },
        evidence: [],
      }));
    }
  }

  // --- positive finding ---
  if (findings.length === 0) {
    findings.push(finding({
      id: 'audit-trail-complete',
      severity: 'info',
      title: 'Audit trail complete and tamper-evident',
      detail: 'Every action is timestamped, attributed to a credential or agent, hash-chained with an intact link sequence, and within the expected retention window.',
      metric: { events: total },
      evidence: [],
    }));
  }

  return { findings, coverage, summary: summarize(findings, coverage) };
}

function summarize(findings, coverage) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
  const tamperEvident = coverage.hash_chained > 0 && coverage.chain_links_broken === 0;
  return {
    analyzer: ANALYZER,
    events: coverage.events,
    findings: findings.length,
    by_severity: bySeverity,
    tamper_evident: tamperEvident,
    completeness_pct: coverage.completeness_pct,
    span_days: coverage.span_days,
  };
}
