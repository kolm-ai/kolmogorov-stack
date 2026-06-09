// src/audit-delta.js
//
// S9 - signed delta / drift between two signed Agent Security-Review report
// envelopes (src/attestation-report-builder.js). The "what changed since last
// time" view a Continuous customer (and a buyer reading a Trust Link) gets each
// re-attestation cycle: readiness movement, control status transitions, and the
// findings that appeared or were resolved.
//
// computeAuditDelta(prevReport, currReport) is a PURE projection over the two
// signed envelopes - it never re-signs, never reads the store, never throws, and
// emits ASCII-only strings (a delta may itself be embedded in a signed report
// row, so its strings must stay locale-proof, exactly like the report builder's
// canonical payload). It reads ONLY signature-covered fields (summary.controls,
// summary.readiness_pct, findings, report_id, generated_at), so a delta computed
// from a tampered report would already have failed verifyReport upstream.
//
// No certification claim is made: a delta describes movement between two
// attestations, nothing more.

// How much "worse" a control status is. A transition to a higher rank is a
// regression (pass -> attention -> blocking). 'untested' sits between pass and
// attention: losing coverage is mildly worse than a clean pass, but not a hard
// blocker.
const STATUS_RANK = { pass: 0, untested: 1, attention: 2, blocking: 3 };

function _finiteNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// A compact { report_id, readiness_pct, generated_at } reference for one side of
// the delta. Tolerant of a missing / malformed envelope (every field falls back
// to null) so the delta is always well-formed.
function _reportRef(report) {
  const r = report && typeof report === 'object' ? report : {};
  const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
  return {
    report_id: typeof r.report_id === 'string' ? r.report_id : null,
    readiness_pct: _finiteNum(s.readiness_pct),
    generated_at: typeof r.generated_at === 'string' ? r.generated_at : null,
  };
}

// id -> status map over summary.controls. A control with no status is treated as
// 'untested' (the orchestrator's neutral state).
function _controlMap(report) {
  const s = report && report.summary && typeof report.summary === 'object' ? report.summary : {};
  const list = Array.isArray(s.controls) ? s.controls : [];
  const map = new Map();
  for (const c of list) {
    if (c && c.id != null) map.set(String(c.id), String(c.status == null ? 'untested' : c.status));
  }
  return map;
}

// A stable identity for a finding across two runs. id alone is not unique (the
// same control id can surface twice with different detail), so key on
// id + ASR control + title, which is stable run-to-run for the same issue while
// staying independent of volatile per-event evidence.
function _findingKey(f) {
  const id = f && f.id != null ? String(f.id) : '';
  const asr = f && f.asr && f.asr.id != null ? String(f.asr.id) : '';
  const title = f && f.title != null ? String(f.title) : '';
  return id + '|' + asr + '|' + title;
}

// key -> compact finding projection (the shape carried in findings_added /
// findings_resolved). Deliberately drops raw evidence / detail (which can hold
// log fragments) so a delta never widens the report's PII surface.
function _findingMap(report) {
  const list = report && Array.isArray(report.findings) ? report.findings : [];
  const map = new Map();
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const key = _findingKey(f);
    if (!map.has(key)) {
      map.set(key, {
        id: f.id != null ? String(f.id) : null,
        severity: f.severity != null ? String(f.severity) : null,
        title: f.title != null ? String(f.title) : (f.id != null ? String(f.id) : null),
        asr: f.asr && f.asr.id != null ? String(f.asr.id) : null,
      });
    }
  }
  return map;
}

// One-line ASCII summary of the delta. No em / en dashes (ASCII '->' only).
function _summarize(d) {
  const fromR = d.from.readiness_pct == null ? 'n/a' : d.from.readiness_pct + '%';
  const toR = d.to.readiness_pct == null ? 'n/a' : d.to.readiness_pct + '%';
  let head;
  if (d.readiness_change == null) {
    head = 'Readiness ' + fromR + ' -> ' + toR + '.';
  } else {
    const sign = d.readiness_change > 0 ? '+' : '';
    head = 'Readiness ' + fromR + ' -> ' + toR + ' (' + sign + d.readiness_change + ').';
  }
  const counts = d.controls_changed.length + ' control(s) changed, '
    + d.findings_added.length + ' finding(s) added, '
    + d.findings_resolved.length + ' resolved.';
  const verdict = d.regressed
    ? 'Posture regressed since the prior attestation.'
    : 'No regression versus the prior attestation.';
  return head + ' ' + counts + ' ' + verdict;
}

function _emptyDelta(note) {
  return {
    from: { report_id: null, readiness_pct: null, generated_at: null },
    to: { report_id: null, readiness_pct: null, generated_at: null },
    readiness_change: null,
    controls_changed: [],
    findings_added: [],
    findings_resolved: [],
    regressed: false,
    summary: note || 'delta unavailable',
  };
}

// ---------------------------------------------------------------------------
// computeAuditDelta(prevReport, currReport) -> delta. Pure, never throws.
// ---------------------------------------------------------------------------
export function computeAuditDelta(prevReport, currReport) {
  try {
    const from = _reportRef(prevReport);
    const to = _reportRef(currReport);

    const readiness_change = (from.readiness_pct != null && to.readiness_pct != null)
      ? Math.round((to.readiness_pct - from.readiness_pct) * 100) / 100
      : null;

    // Control status transitions, keyed by id, sorted for a stable order.
    const prevC = _controlMap(prevReport);
    const currC = _controlMap(currReport);
    const ids = new Set([...prevC.keys(), ...currC.keys()]);
    const controls_changed = [];
    for (const id of ids) {
      const from_status = prevC.has(id) ? prevC.get(id) : 'untested';
      const to_status = currC.has(id) ? currC.get(id) : 'untested';
      if (from_status !== to_status) controls_changed.push({ id, from_status, to_status });
    }
    controls_changed.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Findings that appeared (curr only) vs were resolved (prev only).
    const prevF = _findingMap(prevReport);
    const currF = _findingMap(currReport);
    const findings_added = [];
    for (const [k, v] of currF) if (!prevF.has(k)) findings_added.push(v);
    const findings_resolved = [];
    for (const [k, v] of prevF) if (!currF.has(k)) findings_resolved.push(v);

    const controlWorsened = controls_changed.some(
      (c) => (STATUS_RANK[c.to_status] ?? 1) > (STATUS_RANK[c.from_status] ?? 1),
    );
    const severeAdded = findings_added.some((f) => f.severity === 'critical' || f.severity === 'high');
    const regressed = (readiness_change != null && readiness_change < 0) || controlWorsened || severeAdded;

    const delta = { from, to, readiness_change, controls_changed, findings_added, findings_resolved, regressed };
    delta.summary = _summarize(delta);
    return delta;
  } catch (_e) {
    // Contract: never throw. A pathological input yields a well-formed null-ish
    // delta the caller can serve / store unconditionally.
    return _emptyDelta('delta unavailable');
  }
}

export default { computeAuditDelta };
