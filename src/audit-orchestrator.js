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

import { ingestForAudit, KOLM_CAPTURE_SOURCE } from './audit-ingest.js';
import { analyzePermissions } from './permission-analyzer.js';
import { analyzeAuditTrail } from './audit-trail-analyzer.js';
import { mapControls } from './control-mapper.js';
import { runRedTeam } from './red-team.js';
import { analyzeModelProvenance } from './model-provenance-analyzer.js';
import { analyzeAgentIdentity } from './agent-identity-analyzer.js';
import { analyzeRagMemory } from './rag-memory-analyzer.js';
import { analyzeDelegation } from './delegation-analyzer.js';

// Versioned so a re-attestation is a cheap, comparable delta and so a signed
// report records exactly which engine shape produced it.
export const AUDIT_SPEC_VERSION = 'asr-audit/0.1';

// The ASR controls the deterministic engine assesses. The posture trinity
// (ASR-1 least privilege, ASR-2 audit trail, ASR-3 egress) is joined by the
// Wave-2 analyzers: ASR-5 (model & supply-chain provenance), ASR-7 (memory &
// retrieval integrity), ASR-8 (multi-agent delegation). ASR-4 (injection) is
// reported separately in the red_team block; ASR-6 (evidence) is established by
// the report's own input-evidence digest + signing, not by log analysis.
//
// CORE controls always carry their graduated weight in the readiness rollup.
// SUPPLEMENTAL controls (the Wave-2 additions) are assessed and reported in the
// controls table, but they fold into the readiness SCORE only when they surface
// a hard blocker (see the readiness rule below) - they can lower the headline
// when a real deal-blocker is found, but a partial / clean / untested
// supplemental result never inflates it. This is the documented non-inflation
// choice: an untested supplemental is excluded from the denominator, never
// scored as a clean pass.
const CORE_CONTROLS = ['ASR-1', 'ASR-2', 'ASR-3'];
const SUPPLEMENTAL_CONTROLS = ['ASR-5', 'ASR-7', 'ASR-8'];
const ASSESSED_CONTROLS = [...CORE_CONTROLS, ...SUPPLEMENTAL_CONTROLS];
const NOT_ASSESSED = {
  // ASR-4 is covered by the deterministic red-team battery (src/red-team.js),
  // reported as its own resistance score in the red_team block rather than
  // folded into the readiness rollup: the battery marks probes the logs never
  // exercised as untested, so scoring it as a pass/fail control would overstate
  // coverage. The readiness rollup stays a clean graduated number over the
  // controls the analyzers fully assess.
  'ASR-4': 'Injection: assessed by the deterministic red-team battery and reported separately in the red_team block (graduated resistance score); not folded into the readiness rollup because untested probes are marked, not scored.',
  'ASR-6': 'Evidence: established by the input-evidence digest binding the report to the exact logs analyzed, plus Ed25519 signing, RFC 3161 trusted timestamping, and transparency-log inclusion of the signed report (the report attests itself; not a property of the log analysis).',
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

/* --------------------------------------------------------------------- */
/* evidence tier - grading the QUALITY of the evidence inside the result  */
/* --------------------------------------------------------------------- */
//
// The independence question ("who says these logs are real?") is answered by
// grading the evidence INSIDE the signed object, so a verifier sees not just
// what was found but how trustworthy the inputs were:
//
//   A  events captured by kolm's own gateway at runtime (first-party capture;
//      the strongest grade - kolm observed the traffic itself)
//   B  vendor-supplied logs whose hash chain verified end to end (tamper
//      evident; continuity is cryptographic, provenance is still the vendor's)
//   C  vendor-supplied logs without cryptographic continuity (accepted as
//      provided; the weakest grade and the default for a raw export)
//
// The grade is computed here, where every input is visible (source tag, trail
// coverage, summary), and the builder binds it into the signed envelope.

export const EVIDENCE_TIER_METHODS = Object.freeze({
  A: 'kolm-gateway-capture',
  B: 'vendor-logs-hash-verified',
  C: 'vendor-logs-asserted',
});

/**
 * Grade the evidence quality of a finished audit result. Never throws.
 *
 * @param {object} auditResult  The (possibly partial) result of runAudit.
 * @returns {{grade:'A'|'B'|'C', method:string, basis:string[]}}
 */
export function computeEvidenceTier(auditResult) {
  const r = auditResult && typeof auditResult === 'object' ? auditResult : {};
  const source = typeof r.source === 'string' ? r.source.trim() : '';
  const summary = r.summary && typeof r.summary === 'object' ? r.summary : {};
  const cov = r.trail && r.trail.coverage && typeof r.trail.coverage === 'object' ? r.trail.coverage : {};
  const events = Array.isArray(r.events) ? r.events : [];
  const chained = Number.isFinite(cov.hash_chained) ? cov.hash_chained : 0;
  const broken = Number.isFinite(cov.chain_links_broken) ? cov.chain_links_broken : 0;
  const basis = [];

  if (source === KOLM_CAPTURE_SOURCE) {
    const records = r.ingest && Number.isFinite(r.ingest.records) ? r.ingest.records : null;
    let receipts = 0;
    for (const e of events) {
      if (e && e.meta && e.meta.receipt_signed === true && e.meta.kind === 'model_call') receipts++;
    }
    basis.push(`gateway captures: ${records == null ? events.length : records} recorded by the kolm gateway at runtime`);
    if (receipts > 0) basis.push(`gateway receipts: ${receipts} signed at capture`);
    if (chained > 0) basis.push(`hash chain: ${chained} chained, ${broken} broken`);
    return { grade: 'A', method: EVIDENCE_TIER_METHODS.A, basis };
  }

  if (summary.tamper_evident === true) {
    basis.push(`hash chain: ${chained} chained, ${broken} broken`);
    return { grade: 'B', method: EVIDENCE_TIER_METHODS.B, basis };
  }

  basis.push(chained > 0
    ? `hash chain incomplete: ${chained} of ${events.length} events chained, ${broken} broken`
    : 'no hash chain present in the supplied logs');
  basis.push('vendor-supplied logs accepted as provided');
  return { grade: 'C', method: EVIDENCE_TIER_METHODS.C, basis };
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

  // 2. The deterministic analyzers over the SAME events. The posture trinity
  // (permission + audit-trail) plus the Wave-2 analyzers: model-provenance
  // (ASR-5), agent-identity (ASR-1), rag-memory (ASR-7), delegation (ASR-8).
  // Each is wrapped never-throw (belt-and-braces; the analyzers already guard
  // themselves) and yields an empty-but-valid result on any failure, so one
  // analyzer can never sink the audit.
  const trailOpts = Number.isFinite(options.retentionDays)
    ? { retentionDays: options.retentionDays }
    : undefined;
  const analyzerOpts = options.analyzerOpts && typeof options.analyzerOpts === 'object' ? options.analyzerOpts : {};
  const permission = analyzePermissions(events);
  const trail = analyzeAuditTrail(events, trailOpts);
  const modelProvenance = _safeAnalyze(() => analyzeModelProvenance(events, analyzerOpts.modelProvenance), _emptyModelProvenance);
  const agentIdentity = _safeAnalyze(() => analyzeAgentIdentity(events, analyzerOpts.agentIdentity), _emptyAgentIdentity);
  const ragMemory = _safeAnalyze(() => analyzeRagMemory(events, analyzerOpts.ragMemory), _emptyRagMemory);
  const delegation = _safeAnalyze(() => analyzeDelegation(events, analyzerOpts.delegation), _emptyDelegation);

  // 3. Map every finding onto the ASR controls + the buyer's frameworks. The
  // Wave-2 findings are merged in BEFORE mapControls so they are framework-mapped
  // exactly like the trinity findings.
  const allFindings = [
    ...permission.findings,
    ...trail.findings,
    ...modelProvenance.findings,
    ...agentIdentity.findings,
    ...ragMemory.findings,
    ...delegation.findings,
  ];
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
  //
  // A supplemental control whose analyzer reported the dimension UNTESTED (no
  // model call / no retrieval-or-memory op / no delegation observed) is given an
  // explicit 'untested' status rather than mislabeled 'pass'. The structured
  // analyzer summaries are the authoritative untested signal (the *-untested info
  // finding alone would roll up to a misleading 'pass' under controlStatus).
  const untestedSupplemental = new Set();
  if (modelProvenance.summary && modelProvenance.summary.untested === true) untestedSupplemental.add('ASR-5');
  if (ragMemory.summary && (ragMemory.summary.retrieval_calls || 0) === 0 && (ragMemory.summary.memory_calls || 0) === 0) untestedSupplemental.add('ASR-7');
  if (delegation.summary && delegation.summary.detected === false) untestedSupplemental.add('ASR-8');

  const asrById = new Map((controls.asr || []).map((a) => [a.id, a]));
  const controlRows = ASSESSED_CONTROLS.map((id) => {
    const a = asrById.get(id) || { id, name: id, findings: 0, by_severity: {} };
    const status = untestedSupplemental.has(id) ? 'untested' : controlStatus(a.by_severity);
    return {
      id,
      name: a.name,
      status,
      findings: a.findings || 0,
      by_severity: a.by_severity || {},
    };
  });

  // The graduated readiness denominator. CORE controls always contribute their
  // weight (pass=1, attention=0.5, blocking=0). SUPPLEMENTAL controls contribute
  // ONLY when they surface a hard blocker (weight 0) - so a real supply-chain /
  // memory / delegation deal-blocker can pull the headline down, but a partial
  // (attention), clean (pass), or untested supplemental result is reported in the
  // table yet excluded from the score. This is the non-inflation rule: a control
  // the logs never exercised is never counted as a clean pass, and a hygiene-level
  // supplemental medium never dilutes the deal-readiness headline.
  const scored = [];
  for (const r of controlRows) {
    if (CORE_CONTROLS.includes(r.id)) scored.push(STATUS_WEIGHT[r.status]);
    else if (r.status === 'blocking') scored.push(0);
  }
  const noEvents = events.length === 0;
  const readinessPct = noEvents || scored.length === 0
    ? null
    : Math.round((100 * scored.reduce((sum, w) => sum + w, 0)) / scored.length);

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

  const result = {
    spec_version: AUDIT_SPEC_VERSION,
    source,
    ingest: { ...ing.stats },
    errors: Array.isArray(ing.errors) ? ing.errors : [],
    events,
    permission,
    trail,
    model_provenance: modelProvenance,
    agent_identity: agentIdentity,
    rag_memory: ragMemory,
    delegation,
    controls,
    findings: allFindings,
    red_team: redTeam,
    summary,
  };

  // Grade the evidence QUALITY of this audit (A/B/C) now that every input is
  // visible; the report builder binds it into the signed envelope.
  result.evidence_tier = computeEvidenceTier(result);

  return result;
}

// Run one analyzer with a never-throw guard. The analyzers already guarantee
// they never throw and return an empty-but-valid shape, so this is belt-and-
// braces: a defect in any one analyzer degrades to its documented empty result
// instead of sinking the whole audit.
function _safeAnalyze(fn, emptyFactory) {
  try {
    const out = fn();
    return out && typeof out === 'object' ? out : emptyFactory();
  } catch (_e) {
    return emptyFactory();
  }
}

function _emptyModelProvenance() {
  return { findings: [], models: [], mcp_servers: [], providers: [], summary: { analyzer: 'model-provenance', model_events: 0, untested: true, findings: 0, by_severity: emptySeverity() } };
}
function _emptyAgentIdentity() {
  return { findings: [], identities: [], summary: { analyzer: 'agent-identity', identities: 0, findings: 0, by_severity: emptySeverity() } };
}
function _emptyRagMemory() {
  return { findings: [], retrieval_sources: [], memory_ops: [], summary: { analyzer: 'rag-memory', retrieval_calls: 0, memory_calls: 0, findings: 0, by_severity: emptySeverity() } };
}
function _emptyDelegation() {
  return { findings: [], delegations: [], agent_graph: { nodes: [], edges: [] }, summary: { analyzer: 'delegation', detected: false, delegations: 0, findings: 0, by_severity: emptySeverity() } };
}

export default runAudit;
