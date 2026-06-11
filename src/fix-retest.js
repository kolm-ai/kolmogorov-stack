// src/fix-retest.js
//
// OFFER #9 - Fix Verification Re-Test. After a buyer's review group flags a
// finding in a prior signed Agent Security-Review report, the operator remediates
// the agent, captures a FRESH log window, and re-runs the audit to prove the
// specific finding is resolved. This module produces that focused proof: it
// re-runs runAudit over the new window, builds a comparable report envelope, and
// emits a delta that links BOTH report ids and classifies each prior finding as
// resolved / still_open / regressed.
//
// It does NOT reinvent diff logic: the prior-vs-new comparison is delegated to
// computeAuditDelta (src/audit-delta.js), which already keys findings stably
// (id|asr|title) and never throws. This module is the thin focusing layer on top:
// it scopes the verdict to the finding ids the buyer cares about and surfaces any
// NEW high/critical finding the re-test introduced (a regression the operator
// must see before claiming the fix shipped).
//
// Non-inflation: a prior finding that is simply ABSENT from the new window is
// reported resolved, but only because the new window was actually analyzed. A
// caller must hand a real fresh log window; an empty window yields no resolution
// claim it cannot back (every prior finding stays "still_open" against an empty
// new report, never silently "resolved" - see _classify below, which requires the
// new report to have been built before any finding is called resolved).
//
// runFixRetest({ priorAudit, newLogs, focusFindingIds }) ->
//   { prior_id, new_id, resolved:[], still_open:[], regressed:[], delta }
//
// where resolved / still_open / regressed are compact finding projections
// ({ id, severity, title, asr }) and delta is the full computeAuditDelta output
// (so a caller can embed it in a follow-on $750 report or a Continuous tick).

import { runAudit } from './audit-orchestrator.js';
import { buildReportEnvelope } from './attestation-report-builder.js';
import { computeAuditDelta } from './audit-delta.js';

// A signed report ENVELOPE already carries summary + findings + report_id in the
// exact shape computeAuditDelta reads. A raw runAudit() result does NOT (its
// findings live under controls.findings and it has no report_id), so we lift it
// into an envelope. Anything else degrades to null (the delta tolerates a null
// side). Tolerant + never throws: this is the boundary normalizer.
function _toReportEnvelope(priorAudit) {
  if (!priorAudit || typeof priorAudit !== 'object') return null;
  // Already a report envelope: it has a report_id AND a summary object. Use as-is
  // so we compare against the EXACT signed report the buyer flagged (its frozen
  // report_id is what we link), never a re-derivation that could drift.
  if (typeof priorAudit.report_id === 'string' && priorAudit.summary && typeof priorAudit.summary === 'object'
      && Array.isArray(priorAudit.findings)) {
    return priorAudit;
  }
  // A raw runAudit() result (has summary + controls): build an envelope so the
  // delta sees the same canonical findings/controls shape on both sides.
  if (priorAudit.summary && typeof priorAudit.summary === 'object') {
    try { return buildReportEnvelope(priorAudit, { subject: 'Prior audit' }); }
    catch { return null; }
  }
  return null;
}

// Stable identity for a finding across two runs - MUST match audit-delta's
// _findingKey (id|asr|title) so the focus filter lines up with the delta's own
// added/resolved keying. Kept local (audit-delta does not export it) but pinned
// to the same fields; the tests assert the alignment.
function _findingKey(f) {
  const id = f && f.id != null ? String(f.id) : '';
  const asr = f && f.asr ? (typeof f.asr === 'object' ? (f.asr.id != null ? String(f.asr.id) : '') : String(f.asr)) : '';
  const title = f && f.title != null ? String(f.title) : '';
  return id + '|' + asr + '|' + title;
}

// Compact, evidence-free projection of a finding (same shape audit-delta emits in
// findings_added / findings_resolved). Never leaks raw detail / evidence bodies.
function _project(f) {
  return {
    id: f && f.id != null ? String(f.id) : null,
    severity: f && f.severity != null ? String(f.severity) : null,
    title: f && f.title != null ? String(f.title) : (f && f.id != null ? String(f.id) : null),
    asr: f && f.asr ? (typeof f.asr === 'object' ? (f.asr.id != null ? String(f.asr.id) : null) : String(f.asr)) : null,
  };
}

// id -> [findings] over an envelope, so the focus filter can resolve a buyer's
// finding id to its key(s). A bare id can surface twice (different asr/title), so
// the value is an array.
function _findingsList(env) {
  return env && Array.isArray(env.findings) ? env.findings.filter((f) => f && typeof f === 'object') : [];
}

// Normalize focusFindingIds into a Set<string> of ids, or null for "all prior
// findings are in focus". Tolerant of a single string, an array, or absent.
function _focusSet(focusFindingIds) {
  if (focusFindingIds == null) return null;
  const arr = Array.isArray(focusFindingIds) ? focusFindingIds : [focusFindingIds];
  const set = new Set();
  for (const x of arr) {
    if (x == null) continue;
    const s = String(x).trim();
    if (s) set.add(s);
  }
  return set.size ? set : null;
}

// ---------------------------------------------------------------------------
// runFixRetest({ priorAudit, newLogs, focusFindingIds })
//   -> { prior_id, new_id, resolved, still_open, regressed, delta }
//
// Pure orchestration over runAudit + computeAuditDelta. Never throws across the
// boundary: a bad prior / unanalyzable new window degrades to a well-formed
// result with an empty classification and a null-ish delta, exactly like the
// route patterns this feeds.
// ---------------------------------------------------------------------------
export function runFixRetest({ priorAudit, newLogs, focusFindingIds } = {}) {
  const priorEnv = _toReportEnvelope(priorAudit);

  // Re-run the audit over the FRESH window and lift it into a comparable envelope.
  // runAudit is designed not to throw, but we still guard: a pathological window
  // must not surface as a raw throw to the route.
  let newEnv = null;
  try {
    const newAudit = runAudit(typeof newLogs === 'string' ? newLogs : (newLogs == null ? '' : String(newLogs)), { source: 'retest' });
    newEnv = buildReportEnvelope(newAudit, { subject: 'Fix re-test' });
  } catch {
    newEnv = null;
  }

  const delta = computeAuditDelta(priorEnv, newEnv);

  const prior_id = priorEnv && typeof priorEnv.report_id === 'string' ? priorEnv.report_id : null;
  const new_id = newEnv && typeof newEnv.report_id === 'string' ? newEnv.report_id : null;

  // Build the new-side key set so we can ask, per prior finding, "is it still
  // present in the fresh window?" (still_open) or "did it disappear?" (resolved).
  const newKeys = new Set(_findingsList(newEnv).map(_findingKey));
  const focus = _focusSet(focusFindingIds);

  // A prior finding is in scope when no focus set is given (all prior findings),
  // or when its id is named in the focus set.
  const inFocus = (f) => focus == null || (f.id != null && focus.has(String(f.id)));

  const resolved = [];
  const still_open = [];
  // Non-inflation gate: a prior finding is only called resolved if the new window
  // actually EXERCISED some agent behavior (it analyzed at least one event). A
  // null envelope (unanalyzable) OR an empty window (zero events) carries no
  // evidence of a fix, so every prior finding stays still_open rather than being
  // silently "resolved" off the absence of any data. An absent finding over a
  // real window is a resolution we can back; absence over no data is not.
  const newEvents = newEnv && newEnv.subject ? Number(newEnv.subject.events) : 0;
  const newWindowAnalyzed = newEnv != null && Number.isFinite(newEvents) && newEvents > 0;
  for (const f of _findingsList(priorEnv)) {
    if (!inFocus(f)) continue;
    const present = newKeys.has(_findingKey(f));
    if (!present && newWindowAnalyzed) resolved.push(_project(f));
    else still_open.push(_project(f));
  }

  // Regressions = HIGH/CRITICAL findings that are NEW in the fresh window (present
  // now, absent before). These are exactly the severe entries computeAuditDelta
  // already isolated in findings_added; we filter to the deal-blocking severities
  // so the operator sees only the regressions that should halt a "fix shipped"
  // claim. (Lower-severity new findings still live in delta.findings_added.)
  const regressed = (Array.isArray(delta.findings_added) ? delta.findings_added : [])
    .filter((f) => f && (f.severity === 'critical' || f.severity === 'high'))
    .map((f) => ({
      id: f.id != null ? String(f.id) : null,
      severity: f.severity != null ? String(f.severity) : null,
      title: f.title != null ? String(f.title) : (f.id != null ? String(f.id) : null),
      asr: f.asr != null ? String(f.asr) : null,
    }));

  return { prior_id, new_id, resolved, still_open, regressed, delta };
}

export default { runFixRetest };
