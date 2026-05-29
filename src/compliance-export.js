// src/compliance-export.js
//
// W921 Govern / Receipts & Compliance — compliance evidence export.
//
// complianceExport({framework}) assembles a tenant-fenced evidence BUNDLE that
// maps kolm's existing, on-disk control substrate (Ed25519-signed receipts, the
// HMAC audit chain, drift signals, lifecycle transitions, provenance
// attestations) onto the controls of a named framework — SOC 2 (Trust Services
// Criteria), GDPR (data-protection articles) and the EU AI Act (Art. 12
// record-keeping + Art. 50 transparency + Art. 72 post-market monitoring).
//
// Plus three LIVE EU-AI-Act report builders (Art. 12 logging conformance, Art.
// 72 post-market report, Art. 12 signed log-stream export) that fold real
// receipt/audit/drift/lifecycle evidence into Article-shaped views — every
// finding citing verifiable evidence ids, gaps RECORDED not hidden.
//
// CONSTRAINTS CONTRACT (preserved): coverage gaps are recorded, not hidden; a
// broken audit chain sets conforms:false loudly; missing retention is flagged
// 'retention_policy_not_configured'; findings NEVER fabricate evidence ids.
// Zero new dependencies. All builders are pure + tenant-fenced + injectable
// (deps passed in so they unit-test without a live store).

import { sign as ed25519Sign, keyFingerprint } from './ed25519.js';

export const COMPLIANCE_EXPORT_VERSION = 'w921-compliance-v1';
export const AI_ACT_MONITORING_VERSION = 'w921-v1';
// Art. 26(6): six-month minimum retention for high-risk-system logs.
export const ART12_RETENTION_FLOOR_DAYS = 184;
const MS_PER_DAY = 86400000;

// ===========================================================================
// FRAMEWORK -> CONTROL MAP. Each control names the kolm evidence type that
// satisfies it. This is the spine of the evidence bundle.
// ===========================================================================
export const FRAMEWORKS = Object.freeze({
  soc2: {
    label: 'SOC 2 (Trust Services Criteria)',
    controls: [
      { id: 'CC7.2', name: 'System monitoring / anomaly detection', evidence: ['drift_signals', 'audit_chain'] },
      { id: 'CC7.3', name: 'Security incident evaluation', evidence: ['risk_events', 'lifecycle'] },
      { id: 'CC6.1', name: 'Logical access — cryptographic integrity of records', evidence: ['receipt_signatures', 'audit_chain'] },
      { id: 'CC4.1', name: 'Monitoring of controls (ongoing evaluation)', evidence: ['drift_signals'] },
      { id: 'A1.2', name: 'Processing integrity — verifiable outputs', evidence: ['receipt_signatures', 'provenance'] },
      { id: 'CC3.2', name: 'Risk identification & change management', evidence: ['lifecycle', 'substantial_modifications'] },
    ],
  },
  gdpr: {
    label: 'GDPR (EU 2016/679)',
    controls: [
      { id: 'Art.5(2)', name: 'Accountability — demonstrate compliance', evidence: ['audit_chain', 'receipt_signatures'] },
      { id: 'Art.25', name: 'Data protection by design (PII redaction at the gateway)', evidence: ['redaction'] },
      { id: 'Art.30', name: 'Records of processing activities', evidence: ['audit_chain', 'receipt_coverage'] },
      { id: 'Art.32', name: 'Security of processing — integrity & confidentiality', evidence: ['receipt_signatures', 'audit_chain'] },
      { id: 'Art.33', name: 'Breach notification readiness (tamper-evident trail)', evidence: ['audit_chain', 'risk_events'] },
    ],
  },
  eu_ai_act: {
    label: 'EU AI Act (Regulation 2024/1689)',
    controls: [
      { id: 'Art.12', name: 'Automatic record-keeping (logging over the lifetime)', evidence: ['receipt_coverage', 'audit_chain', 'retention'] },
      { id: 'Art.50(2)', name: 'Transparency — machine-readable AI-output marking', evidence: ['provenance', 'content_credentials'] },
      { id: 'Art.72', name: 'Post-market monitoring', evidence: ['drift_signals', 'lifecycle', 'risk_events'] },
      { id: 'Art.15', name: 'Accuracy, robustness & cybersecurity', evidence: ['drift_signals', 'receipt_signatures'] },
      { id: 'Art.26(6)', name: 'Deployer log retention (>= 6 months)', evidence: ['retention'] },
    ],
  },
});

export function listFrameworks() {
  return Object.keys(FRAMEWORKS).map((k) => ({ framework: k, label: FRAMEWORKS[k].label, controls: FRAMEWORKS[k].controls.length }));
}

function normFramework(framework) {
  const f = String(framework || '').toLowerCase().replace(/[\s.-]+/g, '_');
  if (f === 'eu_ai_act' || f === 'ai_act' || f === 'euaiact' || f === 'eaa') return 'eu_ai_act';
  if (f === 'soc2' || f === 'soc_2') return 'soc2';
  if (f === 'gdpr') return 'gdpr';
  return f;
}

// ---------------------------------------------------------------------------
// Default deps: a thin injectable surface so this module unit-tests without a
// live store. Callers (govern-routes / CLI) pass real implementations.
// ---------------------------------------------------------------------------
function _resolveDeps(deps = {}) {
  return {
    readObservations: deps.readObservations || (() => []),
    verifyChain: deps.verifyChain || (() => ({ ok: true, total: 0, breaks: [] })),
    getLifecycle: deps.getLifecycle || (() => []),
    computeDrift: deps.computeDrift || (() => null),
    retentionDays: deps.retentionDays != null ? deps.retentionDays : null,
    signer: deps.signer || null,
  };
}

function within(row, from, to) {
  const t = row && row.at ? Date.parse(row.at) : NaN;
  if (Number.isNaN(t)) return true;
  if (from && t < Date.parse(from)) return false;
  if (to && t > Date.parse(to)) return false;
  return true;
}

function receiptIdOf(row) {
  return (row && (row.receipt_id || (row.receipt && row.receipt.receipt_id) || row.id)) || null;
}

// ===========================================================================
// extractRiskRelevantEvents — Art. 12(2)(a) events that may present an Art.
// 79(1) risk or substantial modification.
// ===========================================================================
export function extractRiskRelevantEvents(rows = [], lifecycleEvents = []) {
  const events = [];
  for (const r of rows) {
    const rec = r.receipt || r;
    const fr = rec && (rec.fallback_reason != null ? rec.fallback_reason
      : (rec.router_decision && rec.router_decision.fallback_reason));
    if (fr) {
      events.push({ receipt_id: receiptIdOf(r), kind: 'fallback', at: r.at || (rec && rec.issued_at) || null, detail: String(fr) });
    }
  }
  for (const ev of lifecycleEvents) {
    const k = String(ev.to_state || ev.kind || ev.op || '').toLowerCase();
    if (/revoke|supersede|re_evaluate|re-evaluate|deprecat/.test(k)) {
      events.push({ audit_id: ev.id || ev.audit_id || null, kind: k.includes('revoke') ? 'revoke' : (k.includes('supersede') ? 'supersede' : 're_evaluate'), at: ev.at || null, detail: ev.reason || null });
    }
  }
  return { count: events.length, events };
}

// ===========================================================================
// detectSubstantialModification — model/artifact changes across the window.
// ===========================================================================
export function detectSubstantialModification(rows = []) {
  const sorted = rows.slice().sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  const mods = [];
  let lastArtifact = null;
  for (const r of sorted) {
    const rec = r.receipt || r;
    const art = rec && (rec.artifact_id || rec.model || rec.artifact_hash);
    if (art && lastArtifact && art !== lastArtifact) {
      mods.push({ before_artifact: lastArtifact, after_artifact: art, at: r.at || null, evidence: [receiptIdOf(r)].filter(Boolean) });
    }
    if (art) lastArtifact = art;
  }
  return mods;
}

// ===========================================================================
// summarizePostMarketFindings
// ===========================================================================
export function summarizePostMarketFindings({ driftSignals, lifecycleHistory, riskEvents }) {
  const findings = [];
  if (driftSignals && typeof driftSignals === 'object') {
    const signals = driftSignals.standard_signals || driftSignals;
    for (const [name, sig] of Object.entries(signals)) {
      if (!sig || typeof sig !== 'object') continue;
      const value = sig.psi != null ? sig.psi : (sig.mmd2 != null ? sig.mmd2 : (sig.p_value != null ? sig.p_value : null));
      const status = sig.status || (sig.drift_detected ? 'alert' : null);
      if (status === 'warn' || status === 'alert') {
        findings.push({
          finding: `drift_${name}`,
          signal_value: value,
          threshold: name.startsWith('psi') ? 0.25 : (name.startsWith('mmd') ? 0.05 : null),
          severity: status === 'alert' ? 'high' : 'medium',
          evidence: [`drift_signal:${name}`],
        });
      }
    }
  }
  if (riskEvents && riskEvents.count > 0) {
    findings.push({
      finding: 'risk_relevant_events_observed',
      signal_value: riskEvents.count,
      threshold: 0,
      severity: riskEvents.count > 5 ? 'high' : 'medium',
      evidence: riskEvents.events.slice(0, 5).map((e) => e.receipt_id || e.audit_id).filter(Boolean),
    });
  }
  return findings;
}

// ===========================================================================
// buildArt12LoggingConformance — Art. 12 automatic-logging conformance view.
// ===========================================================================
export function buildArt12LoggingConformance(opts = {}) {
  if (!opts.tenant_id) return { ok: false, error: 'tenant_id_required', version: AI_ACT_MONITORING_VERSION };
  const deps = _resolveDeps(opts);
  const { from, to } = opts;
  const allRows = deps.readObservations({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];
  const rows = allRows.filter((r) => r.tenant_id === opts.tenant_id && within(r, from, to));
  const chain = deps.verifyChain(opts.tenant_id) || { ok: false, total: 0, breaks: [] };
  const lifecycle = deps.getLifecycle({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];

  const times = rows.map((r) => Date.parse(r.at || 0)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const first = times.length ? new Date(times[0]).toISOString() : null;
  const last = times.length ? new Date(times[times.length - 1]).toISOString() : null;

  // logging continuity over the window.
  let expectedDays = 1, daysWithLogs = 0;
  const gaps = [];
  if (times.length) {
    const startMs = from ? Date.parse(from) : times[0];
    const endMs = to ? Date.parse(to) : times[times.length - 1];
    expectedDays = Math.max(1, Math.ceil((endMs - startMs) / MS_PER_DAY) + 1);
    const daySet = new Set(times.map((t) => Math.floor((t - startMs) / MS_PER_DAY)));
    daysWithLogs = daySet.size;
    for (let d = 0; d < expectedDays; d++) {
      if (!daySet.has(d)) gaps.push({ day: new Date(startMs + d * MS_PER_DAY).toISOString().slice(0, 10), note: 'no_logged_records' });
    }
  }
  const continuity_ratio = expectedDays > 0 ? daysWithLogs / expectedDays : 0;

  // retention attestation.
  const retentionConfigured = deps.retentionDays;
  let retention;
  if (retentionConfigured == null) {
    retention = { floor_days: ART12_RETENTION_FLOOR_DAYS, configured_days: null, retention_met: 'unknown', note: 'retention_policy_not_configured' };
  } else {
    retention = { floor_days: ART12_RETENTION_FLOOR_DAYS, configured_days: retentionConfigured, retention_met: retentionConfigured >= ART12_RETENTION_FLOOR_DAYS };
  }

  const risk = extractRiskRelevantEvents(rows, lifecycle);
  const tamper_evident = { audit_chain_verified: !!chain.ok, total_events: chain.total || 0, breaks: chain.breaks || [] };

  const limitations = [];
  if (!chain.ok) limitations.push('audit_chain_broken');
  if (gaps.length) limitations.push('logging_continuity_gaps');
  if (retention.retention_met === 'unknown') limitations.push('retention_policy_not_configured');

  const conforms = !!chain.ok && rows.length > 0 && retention.retention_met !== false;

  return {
    ok: true,
    version: AI_ACT_MONITORING_VERSION,
    generated_at: new Date().toISOString(),
    tenant_id: opts.tenant_id,
    namespace: opts.namespace || null,
    window: { from: from || first, to: to || last },
    automatic: true,
    lifetime_covered: rows.length > 0,
    record_count: rows.length,
    first_record_at: first,
    last_record_at: last,
    logging_continuity: { expected_days: expectedDays, days_with_logs: daysWithLogs, continuity_ratio, gaps },
    tamper_evident,
    retention,
    risk_relevant_events: { count: risk.count, samples: risk.events.slice(0, 10) },
    conforms,
    limitations,
  };
}

// ===========================================================================
// buildArt72PostMarketReport — Art. 72 element-shaped report.
// ===========================================================================
export function buildArt72PostMarketReport(opts = {}) {
  if (!opts.tenant_id) return { ok: false, error: 'tenant_id_required', version: AI_ACT_MONITORING_VERSION };
  const deps = _resolveDeps(opts);
  const { from, to } = opts;
  const allRows = deps.readObservations({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];
  const rows = allRows.filter((r) => r.tenant_id === opts.tenant_id && within(r, from, to));
  const lifecycle = (deps.getLifecycle({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [])
    .filter((e) => within(e, from, to));
  const driftSignals = deps.computeDrift({ tenant_id: opts.tenant_id, namespace: opts.namespace, from, to });
  const risk = extractRiskRelevantEvents(rows, lifecycle);
  const substantial = detectSubstantialModification(rows);
  const findings = summarizePostMarketFindings({ driftSignals, lifecycleHistory: lifecycle, riskEvents: risk });

  // incidents -> Art. 73 serious-incident reporting deadlines.
  const incidents = risk.events
    .filter((e) => e.kind === 'fallback' || e.kind === 'revoke')
    .map((e) => {
      const severity = e.kind === 'revoke' ? 'high' : 'medium';
      const requires = severity === 'high';
      return {
        kind: e.kind, at: e.at, evidence: [e.receipt_id || e.audit_id].filter(Boolean),
        severity, requires_art73_report: requires,
        // Art. 73: 15 days generally; 10 days if death; 2 days for widespread/critical-infra.
        art73_deadline_days: requires ? 15 : null,
      };
    });

  const data_sources = [
    { source: 'gateway_receipts', n: rows.length },
    { source: 'lifecycle_events', n: lifecycle.length },
    { source: 'drift_signals', n: driftSignals ? 1 : 0 },
  ];

  const limitations = [];
  if (!driftSignals) limitations.push('drift_not_computed (insufficient baseline or detector unavailable)');
  if (rows.length === 0) limitations.push('no_receipts_in_window');

  const alertCount = findings.filter((f) => f.severity === 'high').length;
  const conclusion = rows.length === 0
    ? { continuous_compliance: 'inconclusive', summary: 'no monitoring data in window' }
    : { continuous_compliance: alertCount === 0, summary: alertCount === 0 ? 'no high-severity findings in window' : `${alertCount} high-severity finding(s) require corrective action` };

  return {
    ok: true,
    version: AI_ACT_MONITORING_VERSION,
    generated_at: new Date().toISOString(),
    tenant_id: opts.tenant_id,
    namespace: opts.namespace || null,
    monitoring_period: { from: from || null, to: to || null },
    risk_category: opts.risk_category || 'undeclared',
    data_sources,
    performance_and_drift_findings: findings,
    lifecycle_events: lifecycle.map((e) => ({ from_state: e.from_state || null, to_state: e.to_state || e.op || null, at: e.at || null, artifact_id: e.artifact_id || null, reason: e.reason || null })),
    incidents,
    substantial_modifications: substantial,
    corrective_actions: incidents.filter((i) => i.requires_art73_report).map((i) => ({ action: `investigate ${i.kind}`, status: 'open', evidence: i.evidence })),
    conclusion,
    limitations,
  };
}

// ===========================================================================
// exportArt12LogStream — immutable tamper-evident export + signed coverage
// manifest. Hashes-only by default (no raw content leaves the boundary).
// ===========================================================================
export function exportArt12LogStream(opts = {}) {
  if (!opts.tenant_id) return { ok: false, error: 'tenant_id_required', version: AI_ACT_MONITORING_VERSION };
  const deps = _resolveDeps(opts);
  const format = opts.format === 'csv' ? 'csv' : 'jsonl';
  const { from, to } = opts;
  const allRows = deps.readObservations({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];
  const rows = allRows.filter((r) => r.tenant_id === opts.tenant_id && within(r, from, to))
    .sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0));
  const chain = deps.verifyChain(opts.tenant_id) || { ok: false, last_hash: null, total: 0 };

  // hashes-only rows.
  const records = rows.map((r) => {
    const rec = r.receipt || r;
    return {
      at: r.at || (rec && rec.issued_at) || null,
      receipt_id: receiptIdOf(r),
      receipt_hash: rec && rec.signature_ed25519 ? (rec.signature_ed25519.signature || '').slice(0, 24) : null,
      route_decision: rec && (rec.route_decision || (rec.router_decision && rec.router_decision.route_decision)) || null,
      fallback_reason: rec && (rec.fallback_reason != null ? rec.fallback_reason : null),
    };
  });

  let body;
  if (format === 'csv') {
    const cols = ['at', 'receipt_id', 'receipt_hash', 'route_decision', 'fallback_reason'];
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    body = [cols.join(',')].concat(records.map((rec) => cols.map((c) => esc(rec[c])).join(','))).join('\n');
  } else {
    body = records.map((rec) => JSON.stringify(rec)).join('\n');
  }

  const coverage_manifest = {
    version: AI_ACT_MONITORING_VERSION,
    window: { from: from || (records[0] && records[0].at) || null, to: to || (records.length ? records[records.length - 1].at : null) },
    record_count: records.length,
    first_record_id: records.length ? records[0].receipt_id : null,
    last_record_id: records.length ? records[records.length - 1].receipt_id : null,
    audit_chain_hash: chain.last_hash || null,
    audit_chain_verified: !!chain.ok,
    retention_floor_days: ART12_RETENTION_FLOOR_DAYS,
    signed_by: null,
    signature_ed25519: null,
  };

  // sign the coverage manifest (Ed25519 over the canonical manifest minus the
  // signature fields) when a signer is configured.
  if (deps.signer && deps.signer.privateKey) {
    const toSign = { ...coverage_manifest, signed_by: undefined, signature_ed25519: undefined };
    const canonical = JSON.stringify(toSign, Object.keys(toSign).filter((k) => toSign[k] !== undefined).sort());
    const sig = ed25519Sign(deps.signer.privateKey, Buffer.from(canonical, 'utf8'));
    let kf;
    try { kf = deps.signer.key_fingerprint || (deps.signer.publicKey ? keyFingerprint(deps.signer.publicKey) : null); } catch { kf = null; }
    coverage_manifest.signed_by = kf;
    coverage_manifest.signature_ed25519 = sig;
  }

  return { ok: true, version: AI_ACT_MONITORING_VERSION, format, coverage_manifest, log: body };
}

// ===========================================================================
// complianceExport({framework}) — the headline evidence-bundle assembler.
// ===========================================================================
export function complianceExport(opts = {}) {
  const framework = normFramework(opts.framework);
  const fwDef = FRAMEWORKS[framework];
  if (!fwDef) {
    return { ok: false, error: 'unknown_framework', framework: opts.framework, available: Object.keys(FRAMEWORKS), version: COMPLIANCE_EXPORT_VERSION };
  }
  if (!opts.tenant_id) {
    return { ok: false, error: 'tenant_id_required', framework, version: COMPLIANCE_EXPORT_VERSION };
  }
  const deps = _resolveDeps(opts);

  // Gather the shared evidence once.
  const allRows = deps.readObservations({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];
  const rows = allRows.filter((r) => r.tenant_id === opts.tenant_id && within(r, opts.from, opts.to));
  const chain = deps.verifyChain(opts.tenant_id) || { ok: true, total: 0, breaks: [] };
  const lifecycle = deps.getLifecycle({ tenant_id: opts.tenant_id, namespace: opts.namespace }) || [];
  const drift = deps.computeDrift({ tenant_id: opts.tenant_id, namespace: opts.namespace, from: opts.from, to: opts.to });
  const risk = extractRiskRelevantEvents(rows, lifecycle);
  const substantial = detectSubstantialModification(rows);
  const signedReceipts = rows.filter((r) => (r.receipt || r).signature_ed25519).length;

  // Evidence catalog keyed by the names the control map references.
  const evidenceCatalog = {
    receipt_signatures: { present: signedReceipts > 0, count: signedReceipts, total: rows.length, note: `${signedReceipts}/${rows.length} receipts Ed25519-signed` },
    receipt_coverage: { present: rows.length > 0, count: rows.length },
    audit_chain: { present: true, verified: !!chain.ok, total: chain.total || 0, breaks: chain.breaks || [] },
    drift_signals: { present: !!drift, status: drift ? (drift.standard_signals ? drift.standard_signals.status : drift.status) : 'not_computed' },
    risk_events: { present: risk.count > 0, count: risk.count },
    lifecycle: { present: lifecycle.length > 0, count: lifecycle.length },
    substantial_modifications: { present: substantial.length > 0, count: substantial.length },
    provenance: { present: !!opts.provenance_present, note: opts.provenance_present ? 'in-toto/SLSA attestation emitted' : 'no_attestation_observed' },
    content_credentials: { present: !!opts.content_credentials_present, note: opts.content_credentials_present ? 'C2PA manifest emitted' : 'no_content_credential_observed' },
    redaction: { present: !!opts.redaction_present, note: opts.redaction_present ? 'gateway PII redaction active' : 'redaction_status_unknown' },
    retention: deps.retentionDays == null
      ? { present: false, configured_days: null, floor_days: ART12_RETENTION_FLOOR_DAYS, note: 'retention_policy_not_configured' }
      : { present: true, configured_days: deps.retentionDays, floor_days: ART12_RETENTION_FLOOR_DAYS, met: deps.retentionDays >= ART12_RETENTION_FLOOR_DAYS },
  };

  // Map each control to a status from its required evidence.
  const controls = fwDef.controls.map((c) => {
    const ev = c.evidence.map((name) => ({ name, ...(evidenceCatalog[name] || { present: false, note: 'no_evidence' }) }));
    const allPresent = ev.every((e) => e.present);
    const anyBroken = ev.some((e) => e.verified === false || e.met === false);
    let status;
    if (anyBroken) status = 'fail';
    else if (allPresent) status = 'satisfied';
    else status = 'partial';
    const gaps = ev.filter((e) => !e.present).map((e) => e.name);
    return { id: c.id, name: c.name, status, evidence: ev, gaps };
  });

  const satisfied = controls.filter((c) => c.status === 'satisfied').length;
  const failed = controls.filter((c) => c.status === 'fail').length;
  const limitations = [];
  if (!chain.ok) limitations.push('audit_chain_broken');
  if (deps.retentionDays == null) limitations.push('retention_policy_not_configured');
  if (!drift) limitations.push('drift_not_computed');

  return {
    ok: true,
    version: COMPLIANCE_EXPORT_VERSION,
    generated_at: new Date().toISOString(),
    framework,
    framework_label: fwDef.label,
    tenant_id: opts.tenant_id,
    namespace: opts.namespace || null,
    window: { from: opts.from || null, to: opts.to || null },
    summary: {
      controls_total: controls.length,
      controls_satisfied: satisfied,
      controls_failed: failed,
      controls_partial: controls.length - satisfied - failed,
      conforms: failed === 0 && satisfied > 0 && !!chain.ok,
    },
    controls,
    evidence_catalog: evidenceCatalog,
    limitations,
  };
}

export const COMPLIANCE_EXPORT_SPEC = {
  version: COMPLIANCE_EXPORT_VERSION,
  ai_act_monitoring_version: AI_ACT_MONITORING_VERSION,
  frameworks: Object.keys(FRAMEWORKS),
  retention_floor_days: ART12_RETENTION_FLOOR_DAYS,
};
