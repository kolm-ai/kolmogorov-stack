// Agent Security-Review audit - orchestrator (the deterministic spine).
//
// Chains the findings trinity end to end:
//
//   raw agent logs ──ingestForAudit──▶ AuditEvents
//                                        │
//                  ┌─────────────────────┴─────────────────────┐
//          analyzePermissions                            analyzeAuditTrail
//                  └─────────────────────┬─────────────────────┘
//                                   mapControls ──▶ ASR controls + buyer frameworks
//
// This is the layer the CLI dogfood (`scripts/audit-run.mjs`) and the future
// API/report layer both call. It produces one stable, versioned result object:
// the measured facts of an audit, plus a transparent readiness rollup that is
// explicit about what was assessed and what was NOT (no theater - the trinity
// covers ASR-1/2/3 only; injection/provenance/evidence need their own modules).

import { ingestForAudit } from './audit-ingest.js';
import { analyzePermissions } from './permission-analyzer.js';
import { analyzeAuditTrail } from './audit-trail-analyzer.js';
import { mapControls } from './control-mapper.js';
import { runRedTeam } from './red-team.js';

// Versioned so a re-attestation is a cheap, comparable delta and so a signed
// report records exactly which engine shape produced it.
export const AUDIT_SPEC_VERSION = 'asr-audit/0.1';

// The ASR controls the deterministic trinity actually assesses. ASR-4
// (injection), ASR-5 (provenance) and ASR-6 (evidence) require modules that do
// not exist in this leg; the rollup reports them as not-assessed with a reason
// rather than silently scoring them as clean.
const ASSESSED_CONTROLS = ['ASR-1', 'ASR-2', 'ASR-3'];
const NOT_ASSESSED = {
  // ASR-4 is covered by the deterministic red-team battery (src/red-team.js),
  // reported as its own resistance score in the red_team block rather than
  // folded into the readiness rollup: the battery marks probes the logs never
  // exercised as untested, so scoring it as a pass/fail control would overstate
  // coverage. The readiness rollup stays a clean graduated number over the three
  // controls the trinity fully assesses.
  'ASR-4': 'Injection: assessed by the deterministic red-team battery and reported separately in the red_team block (graduated resistance score); not folded into the readiness rollup because untested probes are marked, not scored.',
  'ASR-5': 'Provenance: requires model/dependency + MCP supply-chain enumeration (not run in this audit).',
  'ASR-6': 'Evidence: established by signing + logging the report itself, not by log analysis.',
};

// A control's status from its severity rollup. Critical/high block a deal;
// medium/low warrant attention; anything else (only positive/info findings, or
// nothing to flag) passes.
function controlStatus(bySeverity) {
  const s = bySeverity || {};
  if ((s.critical || 0) + (s.high || 0) > 0) return 'blocking';
  if ((s.medium || 0) + (s.low || 0) > 0) return 'attention';
  return 'pass';
}

// Transparent, graduated readiness over the ASSESSED controls only: pass=1,
// attention=0.5, blocking=0. Reported alongside the per-control breakdown so the
// number is never a black box.
const STATUS_WEIGHT = { pass: 1, attention: 0.5, blocking: 0 };

function emptySeverity() {
  return { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
}

function tallySeverity(findings) {
  const out = emptySeverity();
  for (const f of findings) {
    const sev = f && f.severity;
    if (sev && sev in out) out[sev]++;
  }
  return out;
}

/**
 * Run a full deterministic audit over a log export.
 *
 * @param {string|Array} logs  Raw export: a newline-delimited JSON string, or
 *                             an array of records/strings (LiteLLM / Helicone /
 *                             Portkey / OpenRouter shapes are all absorbed).
 * @param {object} [opts]
 * @param {string} [opts.source]        Source tag stamped on every event.
 * @param {number} [opts.retentionDays] Required retention window for the trail
 *                                       check (defaults to the analyzer's).
 * @returns {object} A stable, versioned audit result (never throws).
 */
export function runAudit(logs, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const source = (options.source && String(options.source).trim()) || 'import';

  // 1. Logs → AuditEvents.
  const ing = ingestForAudit(logs, { source });
  const events = Array.isArray(ing.events) ? ing.events : [];

  // 2. Two independent analyzers over the same events.
  const trailOpts = Number.isFinite(options.retentionDays)
    ? { retentionDays: options.retentionDays }
    : undefined;
  const permission = analyzePermissions(events);
  const trail = analyzeAuditTrail(events, trailOpts);

  // 3. Map every finding onto the ASR controls + the buyer's frameworks.
  const allFindings = [...permission.findings, ...trail.findings];
  const controls = mapControls(allFindings);

  // 3.5 Deterministic red-team / injection battery (ASR-4) over the SAME events.
  // Offline, never-throwing, reproducible; reported as its own resistance block
  // rather than folded into the readiness rollup. runRedTeam already guards
  // itself, but keep the orchestrator's never-throw contract belt-and-braces.
  let redTeam;
  try {
    redTeam = runRedTeam(events, { domain: options.domain });
  } catch (_e) {
    redTeam = { spec_version: 'asr-redteam/0.1', domain: 'generic', red_team_score: null, probes: [], summary: { domain: 'generic', red_team_score: null, probes_total: 0, tested: 0, resisted: 0, exposed: 0, untested: 0 } };
  }

  // 4. Readiness rollup - explicit about coverage, never inflated.
  const asrById = new Map((controls.asr || []).map((a) => [a.id, a]));
  const controlRows = ASSESSED_CONTROLS.map((id) => {
    const a = asrById.get(id) || { id, name: id, findings: 0, by_severity: {} };
    const status = controlStatus(a.by_severity);
    return {
      id,
      name: a.name,
      status,
      findings: a.findings || 0,
      by_severity: a.by_severity || {},
    };
  });

  const noEvents = events.length === 0;
  const readinessPct = noEvents
    ? null
    : Math.round(
        (100 * controlRows.reduce((sum, r) => sum + STATUS_WEIGHT[r.status], 0)) /
          controlRows.length,
      );

  const bySeverity = tallySeverity(allFindings);
  const blocking = (controls.findings || [])
    .filter((f) => f.severity === 'critical' || f.severity === 'high')
    .map((f) => ({
      id: f.id,
      severity: f.severity,
      title: f.title || f.id,
      asr: f.asr ? f.asr.id : null,
      frameworks: Array.isArray(f.controls)
        ? f.controls.map((c) => `${c.framework} ${c.id}`)
        : [],
    }));

  const summary = {
    readiness_pct: readinessPct,
    total_findings: allFindings.length,
    by_severity: bySeverity,
    controls: controlRows,
    assessed_controls: [...ASSESSED_CONTROLS],
    not_assessed: Object.entries(NOT_ASSESSED).map(([id, reason]) => ({ id, reason })),
    blocking,
    blocking_count: blocking.length,
    tamper_evident: trail.summary ? trail.summary.tamper_evident === true : false,
    note: noEvents ? 'No events were ingested from the supplied logs.' : undefined,
  };

  return {
    spec_version: AUDIT_SPEC_VERSION,
    source,
    ingest: { ...ing.stats },
    errors: Array.isArray(ing.errors) ? ing.errors : [],
    events,
    permission,
    trail,
    controls,
    findings: allFindings,
    red_team: redTeam,
    summary,
  };
}

export default runAudit;
