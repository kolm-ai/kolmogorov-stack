// Agent Security-Review audit - attestation report builder.
//
// Turns a deterministic runAudit() result (src/audit-orchestrator.js) into the
// deliverable the buyer's review group actually receives:
//
//   1. A SIGNED, offline-verifiable JSON envelope (Ed25519 - src/ed25519.js).
//      The signature covers the whole report minus its own signature block, so a
//      single altered byte (a downgraded readiness number, a deleted finding)
//      breaks verification. The buyer verifies it with only the embedded public
//      key - no kolm server, no shared secret, no account (public/kolm-audit-
//      verify.js does exactly this in the browser).
//
//   2. Human-readable renderings of that same signed envelope: an HTML report
//      and a PDF (lazy pdfkit, mirroring src/assurance-case-pdf.js).
//
// The canonicalization here (canonicalizeReport) is deliberately simple and
// self-describing - recursive key-sorted JSON with no whitespace - so the
// browser verifier can reproduce the exact signed bytes without importing this
// module. Keep the two byte-identical.
//
// Scope discipline (no theater): the envelope carries the orchestrator's
// graduated readiness rollup verbatim, including which controls were assessed
// (ASR-1/2/3) and which were NOT (ASR-4/5/6, with reasons). The caveats section
// states the limits in plain terms. This report maps findings to the frameworks
// a reviewer cites; it is not a certification.

import crypto from 'node:crypto';
import {
  loadOrCreateDefaultSigner,
  buildSignatureBlock,
  verifySignatureBlock,
  keyFingerprint,
} from './ed25519.js';
import { ASR_CONTROLS } from './control-mapper.js';
import { BENCHMARK_CROSSWALK_NOTE, benchmarkRefsForProbe, runRedTeam } from './red-team.js';
import { buildAgentPassport } from './passport-builder.js';
import { buildSubprocessorInventory } from './subprocessor-inventory.js';
import { timestampDigest, selfIssueTimestamp } from './rfc3161-timestamp.js';
import { TransparencyLog, TRANSPARENCY_LOG_VERSION } from './transparency-log.js';
import { getPublicTransparencyLog } from './transparency-log-routes.js';
import { PROOF_SCOPE, proofScopeLabel } from './receipt-export-registry.js';
// GAP-3: the one-line caveat rendered next to a bound coverage declaration.
// (coverage-declaration.js imports this module's canonicalize; both sides only
// reference each other inside function bodies, so the cycle is benign.)
import { declarationCaveat } from './coverage-declaration.js';
// report-revocation-parity: consult the persisted issuer-key revocation store
// from the PURE verifier so a revoked-key report cannot verify true anywhere -
// the route, the CLI, and the browser bridge all flow through verifyReport().
// Static import is cycle-safe: key-revocation.js imports only store.js, never
// this module, so no import cycle is introduced (unlike coverage-declaration).
import { status as issuerKeyStatus } from './key-revocation.js';

// Versioned so a re-attestation is a comparable delta and a signed report
// records exactly which builder shape produced it.
export const AUDIT_REPORT_SCHEMA = 'kolm-audit-report-1';
export const AUDIT_REPORT_VERSION = 'asr-report/0.2';

// The single contact surface for the report. dev@kolm.ai is the only address.
const CONTACT_EMAIL = 'dev@kolm.ai';

// sha256 hex over a UTF-8 string. Used for the input-evidence digest (M2/ASR-6)
// and the report digest the detached evidence (timestamp + transparency log)
// binds to.
function sha256hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Input-evidence digest (M2 / ASR-6). A sha256 over the canonical form of the
// exact AuditEvents the analyzers ran on, so the SIGNED report binds to the
// precise evidence it was derived from. The events themselves are deliberately
// NOT carried in the envelope (they can hold sensitive log bodies); the digest
// proves which evidence was analyzed without disclosing it. event_count lets a
// reader cross-check against subject.events. Pure, never throws.
// ---------------------------------------------------------------------------
export function computeEvidenceDigest(auditResultOrEvents) {
  let events = [];
  if (Array.isArray(auditResultOrEvents)) events = auditResultOrEvents;
  else if (auditResultOrEvents && typeof auditResultOrEvents === 'object' && Array.isArray(auditResultOrEvents.events)) {
    events = auditResultOrEvents.events;
  }
  let value;
  try { value = sha256hex(canonicalize(events)); }
  catch { value = sha256hex('[]'); }
  return { alg: 'sha256', value, event_count: events.length };
}

// ---------------------------------------------------------------------------
// Transparency-log inclusion of the SIGNED report digest (best-effort, M4).
// Appends the report digest to THE SAME global, store-backed, Ed25519/Merkle-
// witnessed log the PUBLIC /v1/transparency-log/* endpoints serve (one origin,
// persisted on the data volume) - so a buyer can fetch an inclusion proof for
// their report's seq against the published signed tree head and verify it
// WITHOUT trusting kolm. recordTransparencyEntry returns a compact checkpoint
// { origin, tree_size, root_hash, leaf_hash, seq } the verifier sanity-checks.
// Best-effort: any failure yields null and the report simply omits log_checkpoint
// (signing is never blocked). Tests may pass opts.transparencyLog to isolate.
// ---------------------------------------------------------------------------
function _getReportTlog(opts) {
  if (opts && opts.transparencyLog instanceof TransparencyLog) return opts.transparencyLog;
  // The single global witness log, persisted via the kolm store - identical to
  // the instance the public read endpoints expose (same origin + store), so the
  // report's seq + root resolve against /v1/transparency-log/proof/:seq.
  return getPublicTransparencyLog();
}

export function recordTransparencyEntry(reportDigest, opts = {}) {
  try {
    const digest = String(reportDigest || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(digest)) return null;
    const log = _getReportTlog(opts);
    const row = log.append('audit-report', { alg: 'sha256', report_digest: digest, report_id: opts.report_id || null }, { namespace: 'reports' });
    const head = log.treeHead();
    const checkpoint = {
      version: TRANSPARENCY_LOG_VERSION,
      origin: head.origin,
      tree_size: head.tree_size,
      root_hash: head.root_hash,
      root_b64: head.root_b64,
      leaf_hash: row.leaf_hash,
      seq: row.seq,
      entry_hash: row.entry_hash,
      report_digest: digest,
    };
    // GAP-7: embed the RFC 9162 Merkle audit path for THIS report's leaf at
    // signing time, so the delivered artifact verifies inclusion fully OFFLINE
    // (verifyInclusionProof in src/transparency-log.js; verifyInclusionOffline
    // in public/kolm-audit-verify.js) - no live /proof/:seq fetch in the trust
    // path. log_checkpoint is detached evidence (canonicalizeReport excludes
    // it), so embedding the path never disturbs the Ed25519 signature.
    try {
      const proof = log.inclusionProof(row.seq);
      if (proof && proof.ok) {
        checkpoint.inclusion = {
          leaf_index: proof.leaf_index,
          tree_size: proof.tree_size,
          audit_path: proof.audit_path,
          root_hash: proof.root_hash,
        };
      }
    } catch { /* best-effort: a checkpoint without an embedded path is still valid */ }
    return checkpoint;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Canonicalization - the exact bytes the Ed25519 signature covers.
//
// Recursive, key-sorted, whitespace-free JSON. Sorting keys makes the output
// independent of property insertion order, so the Node signer and the browser
// verifier produce identical bytes without sharing a field list. `undefined`
// values are dropped (matching JSON.stringify). The signature_ed25519 block is
// excluded because a signature cannot cover itself.
// ---------------------------------------------------------------------------
export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalize(v === undefined ? null : v)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  // undefined / function / symbol - never part of a well-formed envelope.
  return 'null';
}

export function canonicalizeReport(envelope) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('canonicalizeReport: envelope must be an object');
  }
  // Excluded from the signed bytes:
  //   - signature_ed25519: a signature cannot cover itself.
  //   - timestamp_evidence + log_checkpoint: DETACHED evidence added AFTER
  //     signing. Each references the signed report digest (sha256 of this exact
  //     canonical payload), so it is bound to the report without being covered by
  //     the signature - which is correct, since a third-party TSA / append-only
  //     witness issues them after the report already exists. Excluding them keeps
  //     the signature stable when they are attached. (Reports built before these
  //     fields existed simply have nothing to exclude - a no-op.)
  //   - co_signatures: the S11 named co-signer (the Reviewed Attestation tier)
  //     attests the SAME signed payload AFTER the primary signature exists. Each
  //     co-signature is itself an Ed25519 block over THIS canonical payload, so it
  //     references the primary-signed bytes without being covered by them.
  //     Excluding co_signatures keeps the primary signature (and every prior
  //     co-signature) stable as more co-signers are appended - a co-signer can
  //     never invalidate the issuer's signature.
  //   - _full_payload: the SERVER-SIDE-ONLY carry-over that stashes the withheld
  //     paid-tier sections for a scan envelope (so the paid upgrade can restore
  //     them without re-running the audit). It is excluded from the signed bytes
  //     and stripped before the envelope reaches any HTTP client
  //     (stripWirePayload), so the wire-stripped scan envelope verifies against
  //     the SAME signature the in-memory envelope carries.
  const { signature_ed25519, timestamp_evidence, log_checkpoint, co_signatures, _full_payload, ...rest } = envelope;
  void signature_ed25519; void timestamp_evidence; void log_checkpoint; void co_signatures; void _full_payload;
  return canonicalize(rest);
}

// ---------------------------------------------------------------------------
// Report-id minting. Sortable-ish (time-prefixed) and grep-friendly.
// ---------------------------------------------------------------------------
function newReportId(seed) {
  // Deterministic when a seed is supplied (tests / reproducible builds);
  // otherwise time + the audit's own shape make it unique enough without
  // pulling in crypto.randomBytes (kept dependency-light + offline-safe).
  if (seed) return `asrr_${String(seed).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)}`;
  const ts = Date.now().toString(36);
  return `asrr_${ts}`;
}

// ---------------------------------------------------------------------------
// Remediation roadmap.
//
// One actionable item per blocking/attention control finding, ordered worst-
// first, each carrying the buyer's framework references so the roadmap reads
// against the same controls the report cites.
// ---------------------------------------------------------------------------
const REMEDIATION_HINTS = {
  'over-permission': 'Scope each agent credential to only the tools it calls; remove the unused grants.',
  'wildcard-grant': 'Replace the wildcard grant with an explicit allow-list of the tools the agent needs.',
  'shared-credential': 'Issue a distinct, scoped key per agent; stop sharing one key across isolation boundaries.',
  'high-privilege-action': 'Gate destructive / financial tool calls behind human approval or a separate narrowly-scoped credential.',
  'undeclared-tool-call': 'Declare every tool the agent can call and deny calls to undeclared tools at the gateway.',
  'no-declared-grants': 'Declare each agent permission scope explicitly so held-vs-used can be assessed.',
  'sensitive-egress': 'Redact sensitive fields before they leave the boundary and enumerate every egress destination.',
  'no-tamper-evidence': 'Emit an append-only, hash-chained activity log so the audit trail is tamper-evident.',
  'broken-hash-chain': 'Repair the audit-log hash chain and investigate the break before relying on the trail.',
  'partial-tamper-evidence': 'Extend hash-chaining to cover the full trail, not a subset of events.',
  'incomplete-timestamps': 'Stamp every event with a reliable timestamp.',
  'unattributed-events': 'Attribute every event to an actor (agent / user / key).',
  'missing-action-detail': 'Record the action or tool for every event.',
  'duplicate-event-ids': 'Make event ids unique so the trail is unambiguous.',
  'retention-unverifiable': 'Set and document a retention window that meets the buyer requirement (e.g. EU AI Act Art.12).',
  'short-retention-window': 'Extend and document the retention window to meet the buyer requirement (e.g. EU AI Act Art.12).',
  'trail-volume-inconsistent': 'Export the full continuous window, or attach a coverage declaration (window, systems, expected daily call volume) so the report binds the export scope.',
  // Egress analyzer (ASR-3).
  'secret-egress': 'Rotate the exposed credential class(es) immediately, then add shape-based redaction at the egress boundary so credential-shaped tokens never leave it.',
  'unapproved-egress-destination': 'Route the off-allowlist destinations through an approved proxy, add the vetted ones to the sub-processor allowlist, and remove the tools\' ability to reach the rest.',
  'undeclared-egress-surface': 'Declare an explicit egress allowlist of approved destination hosts so every observed host can be evaluated as approved or unapproved on the next run.',
  // Agent identity analyzer (ASR-5 identity / passport).
  'unattributed-agent-action': 'Stamp every agent action with a credential id and an agent name at the gateway, and reject events that arrive with neither.',
  'ambiguous-agent-identity': 'Issue one credential per agent identity; stop presenting a single key under multiple agent names so each action attests to a single subject.',
  'unverifiable-agent-scope': 'Declare an explicit scope grant per credential so the authority each agent exercised can be bounded and attested as least privilege.',
  'agent-identity-partial': 'Complete each partial identity: bind every credential id to an agent name and every agent name to a credential id, so the passport asserts both.',
  // Model provenance analyzer (ASR-5 provenance / supply chain).
  'unpinned-model-version': 'Pin each production agent to an explicit model version; floating aliases change behavior without a deploy.',
  'opaque-model-routing': 'Record the resolved upstream provider per gateway call, or call the upstream vendor directly, so the model supply chain is verifiable.',
  'unpinned-mcp-server': 'Pin each MCP / vendor server to a version or image digest and record it in a declared allow-list.',
  'model-egress-third-party': 'Confirm the third-party destination is a contractually approved sub-processor with a data-processing agreement in place, and apply redaction before sensitive content egresses to it.',
  // RAG / memory analyzer (ASR-7).
  'untrusted-retrieval-source': 'Route retrieval through an approved, integrity-checked first-party index, or sanitize and declare the external source; retrieved text is an indirect prompt-injection vector.',
  'unverified-memory-write': 'Attach a hash-chain integrity link and a credential/agent attribution to every durable memory write so a forged or poisoned entry is detectable before it steers later turns.',
  // Delegation analyzer (ASR-8).
  'delegation-privilege-escalation': 'Bound each sub-agent to a scoped, short-lived credential at or below the delegating agent\'s privilege tier; require a recorded step-up control for any elevation.',
  'opaque-delegation-hop': 'Record the sub-agent identity on every handoff and log the sub-agent\'s actions under its own attributable identity so each hop is reviewable.',
  'unattenuated-delegation': 'Issue each sub-agent a narrowed credential scoped to only the tools the handoff requires; every delegation hop must attenuate, never inherit the full grant.',
};

// The fallback action when a finding id has no standard remediation pattern.
// Exported so the renderer (and tests) can recognize that the fallback fired
// and surface the finding's own detail next to it instead of filler text.
export const REMEDIATION_FALLBACK_ACTION =
  'Address the evidence cited in this finding with your platform team; no standard remediation pattern applies.';

const SEV_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function priorityFor(severity) {
  if (severity === 'critical' || severity === 'high') return 'P0';
  if (severity === 'medium') return 'P1';
  return 'P2';
}

function frameworksOf(finding) {
  return Array.isArray(finding.controls)
    ? finding.controls.map((c) => `${c.framework} ${c.id}`)
    : [];
}

export function deriveRemediation(auditResult) {
  const mapped = (auditResult && auditResult.controls && Array.isArray(auditResult.controls.findings))
    ? auditResult.controls.findings
    : [];
  const items = mapped
    .filter((f) => f && f.severity && f.severity !== 'info')
    .map((f) => ({
      priority: priorityFor(f.severity),
      severity: f.severity,
      finding_id: f.id,
      title: f.title || f.id,
      action: REMEDIATION_HINTS[f.id] || REMEDIATION_FALLBACK_ACTION,
      asr: f.asr ? f.asr.id : null,
      frameworks: frameworksOf(f),
    }));
  items.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
  return items;
}

// ---------------------------------------------------------------------------
// The caveats - what the report does and does NOT claim. Stated plainly so a
// reviewer is never misled. (No theater; this is the anti-theater section.)
// ---------------------------------------------------------------------------
const REPORT_PROOF_CANDIDATE_PATHS = Object.freeze([
  ['proof_scope_state'],
  ['confidential_compute'],
  ['runtime_attestation'],
  ['attestation'],
  ['runtime_passport', 'confidential_compute'],
  ['runtime_passport', 'attestation'],
]);

function readPath(root, pathParts) {
  let cur = root;
  for (const part of pathParts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = cur[part];
  }
  return cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : null;
}

function proofStateCandidates(auditResult) {
  const out = [];
  const root = auditResult && typeof auditResult === 'object' ? auditResult : {};
  for (const p of REPORT_PROOF_CANDIDATE_PATHS) {
    const found = readPath(root, p);
    if (found) out.push({ state: found, source: p.join('.') });
  }
  const passports = Array.isArray(root.runtime_passports) ? root.runtime_passports : [];
  for (let i = 0; i < passports.length; i++) {
    const row = passports[i];
    if (!row || typeof row !== 'object') continue;
    if (row.confidential_compute && typeof row.confidential_compute === 'object') {
      out.push({ state: row.confidential_compute, source: `runtime_passports[${i}].confidential_compute` });
    }
    if (row.attestation && typeof row.attestation === 'object') {
      out.push({ state: row.attestation, source: `runtime_passports[${i}].attestation` });
    }
  }
  return out;
}

function compactProofState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const out = {
    verified: s.verified === true,
    verifier: typeof s.verifier === 'string' && s.verifier.trim() !== '' ? s.verifier.slice(0, 80) : 'none',
  };
  if (typeof s.kind === 'string' && s.kind.trim() !== '') out.kind = s.kind.slice(0, 80);
  if (typeof s.state === 'string' && s.state.trim() !== '') out.state = s.state.slice(0, 120);
  if (typeof s.reason === 'string' && s.reason.trim() !== '') out.reason = s.reason.slice(0, 240);
  return out;
}

export function buildReportProofScope(auditResult) {
  const candidates = proofStateCandidates(auditResult);
  const proven = candidates.find((c) => proofScopeLabel(c.state) === PROOF_SCOPE.PROVEN_COMPUTE);
  const selected = proven || candidates[0] || null;
  const scope = selected ? proofScopeLabel(selected.state) : PROOF_SCOPE.KEY_CUSTODY;
  return {
    scope,
    source: selected ? selected.source : null,
    state: selected ? compactProofState(selected.state) : { verified: false, verifier: 'none' },
    caveat: scope === PROOF_SCOPE.PROVEN_COMPUTE
      ? 'cryptographically_verified_compute_evidence_present'
      : 'report_integrity_only_no_proof_of_compute',
  };
}

function proofScopeCaveat(proofScope) {
  const ps = proofScope && typeof proofScope === 'object' ? proofScope : {};
  const state = ps.state && typeof ps.state === 'object' ? ps.state : {};
  const verifier = typeof state.verifier === 'string' && state.verifier ? state.verifier : 'registered verifier';
  if (ps.scope === PROOF_SCOPE.PROVEN_COMPUTE) {
    return `Proof scope: this signed report includes cryptographically verified compute evidence from ${verifier}; only that verified TEE/opML/zkML attestation, with input/output binding, can support a claim that a specific inference output was computed by the claimed model. The report signature, timestamp, transparency-log inclusion, and input-evidence digest by themselves prove report integrity and evidence binding, not proof-of-compute.`;
  }
  return 'Proof scope: this signed report proves report integrity, issuer key custody, input-evidence digest binding, timestamp evidence, and any transparency-log inclusion; it does not prove that any specific inference output was computed by the claimed model. Treat proof-of-compute as absent unless a cryptographically verified TEE, opML, or zkML attestation with input/output binding is present.';
}

function buildCaveats(summary, auditResult, proofScope = null) {
  const assessed = (summary.assessed_controls || []).join(', ');
  const caveats = [
    `This report assesses ${assessed || 'the deterministic controls'} from the supplied logs. The controls listed under "Not assessed" were not evaluated in this run. Each carries its reason.`,
    proofScopeCaveat(proofScope || buildReportProofScope(auditResult)),
    'Findings reflect only the activity present in the supplied export. The absence of a finding is not proof that the underlying risk is absent.',
    'The readiness percentage is a graduated rollup over the assessed posture controls (ASR-1/2/3: pass = 1, attention = 0.5, blocking = 0). The supplemental controls (ASR-5 provenance, ASR-7 memory and retrieval, ASR-8 delegation) are assessed and listed, but fold into the percentage only when they surface a hard blocker; a partial, clean, or untested supplemental result is reported without inflating the score. It is not a certification or an attestation of compliance.',
    'Framework references map each finding to the control an enterprise reviewer cites; they do not assert certification against that framework.',
  ];
  // GAP-2 (claim-bounding half): name the EXACT detector vocabulary the
  // sensitive-data scan covered, so "no sensitive egress was found" can never be
  // read wider than what the detectors actually see. Tolerant of audit results
  // built before the orchestrator carried detector_coverage.
  const dc = auditResult && typeof auditResult === 'object' ? auditResult.detector_coverage : null;
  if (dc && typeof dc === 'object' && Array.isArray(dc.pii_classes) && Array.isArray(dc.secret_shapes)) {
    const pii = dc.pii_classes.filter((c) => typeof c === 'string' && c).slice(0, 64).join(', ');
    const shapes = dc.secret_shapes.filter((c) => typeof c === 'string' && c).slice(0, 64).join(', ');
    caveats.push(
      `Sensitive-data detection covered PII classes [${pii}] and secret shapes [${shapes}]; content outside these detectors is not assessed.`,
    );
  }
  return caveats;
}

// ---------------------------------------------------------------------------
// Evidence tier - the A/B/C evidence-quality grade bound INSIDE the signed
// envelope. The orchestrator computes it where every input is visible
// (computeEvidenceTier in src/audit-orchestrator.js); this coercion accepts
// that value, validates its shape, and - for legacy/synthetic audit results
// that never carried one - derives a conservative grade from the same signals,
// so EVERY envelope built from now on carries the field.
// ---------------------------------------------------------------------------
export const EVIDENCE_TIER_METHOD_BY_GRADE = Object.freeze({
  A: 'kolm-gateway-capture',
  B: 'vendor-logs-hash-verified',
  C: 'vendor-logs-asserted',
});

export function coerceEvidenceTier(raw, auditResult) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const grade = r && typeof r.grade === 'string' ? r.grade.trim().toUpperCase() : null;
  if (r && (grade === 'A' || grade === 'B' || grade === 'C')) {
    const basis = Array.isArray(r.basis)
      ? r.basis
          .filter((b) => typeof b === 'string' && b.trim() !== '')
          .map((b) => String(b).slice(0, 300))
          .slice(0, 12)
      : [];
    const method = typeof r.method === 'string' && r.method.trim() !== ''
      ? String(r.method).slice(0, 80)
      : EVIDENCE_TIER_METHOD_BY_GRADE[grade];
    return { grade, method, basis };
  }
  // Fallback for audit results without a precomputed tier.
  const source = auditResult && typeof auditResult.source === 'string' ? auditResult.source : '';
  const s = (auditResult && auditResult.summary) || {};
  if (source === 'kolm-capture') {
    return { grade: 'A', method: EVIDENCE_TIER_METHOD_BY_GRADE.A, basis: ['events captured by the kolm gateway at runtime'] };
  }
  if (s.tamper_evident === true) {
    return { grade: 'B', method: EVIDENCE_TIER_METHOD_BY_GRADE.B, basis: ['vendor-supplied logs with a verified hash chain'] };
  }
  return { grade: 'C', method: EVIDENCE_TIER_METHOD_BY_GRADE.C, basis: ['vendor-supplied logs accepted as provided (no cryptographic continuity)'] };
}

// ---------------------------------------------------------------------------
// Red-team block - the ASR-4 injection-resistance evidence for the signed
// envelope. Reads the orchestrator's red_team result (src/red-team.js); if a
// caller built the audit without one, it is derived deterministically from the
// same events, so the deliverable is always self-consistent. The block carries
// only the score, the per-status counts, and the probe table (opaque event-id
// evidence, never raw log bodies), so adding it to the envelope cannot leak PII.
// ---------------------------------------------------------------------------
export function buildRedTeamBlock(auditResult) {
  const rt = auditResult && auditResult.red_team && typeof auditResult.red_team === 'object'
    ? auditResult.red_team
    : runRedTeam(Array.isArray(auditResult && auditResult.events) ? auditResult.events : []);
  const sum = rt.summary || {};
  const probes = Array.isArray(rt.probes) ? rt.probes : [];
  const summary = {
    probes_total: sum.probes_total ?? probes.length,
    tested: sum.tested ?? 0,
    resisted: sum.resisted ?? 0,
    exposed: sum.exposed ?? 0,
    untested: sum.untested ?? 0,
    benchmark_crosswalk_note: sum.benchmark_crosswalk_note || BENCHMARK_CROSSWALK_NOTE,
    note: sum.note,
  };
  if (sum.active && typeof sum.active === 'object') {
    summary.active = {
      probes_merged: Number.isFinite(sum.active.probes_merged) ? sum.active.probes_merged : 0,
      endpoint_digest: typeof sum.active.endpoint_digest === 'string' ? sum.active.endpoint_digest : null,
      consent_recorded: sum.active.consent_recorded === true,
    };
  }
  return {
    spec_version: rt.spec_version || null,
    domain: rt.domain || sum.domain || 'generic',
    score: rt.red_team_score == null ? null : rt.red_team_score,
    summary,
    probes: probes.map((p) => ({
      id: p.id,
      category: p.category,
      severity: p.severity,
      status: p.status,
      title: p.title || p.id,
      detail: p.detail || null,
      frameworks: Array.isArray(p.frameworks) ? p.frameworks.slice(0, 8) : [],
      benchmark_refs: Array.isArray(p.benchmark_refs) ? p.benchmark_refs.slice(0, 8) : benchmarkRefsForProbe(p.id).slice(0, 8),
      evidence: Array.isArray(p.evidence) ? p.evidence.slice(0, 6) : [],
      // P3 interface: how the probe's verdict was evidenced. 'passive' is the
      // historical default (observed-traffic analysis); active harness probes
      // stamp their own value, which passes through unchanged.
      evidence_source: p.evidence_source || 'passive',
      ...(typeof p.transcript_digest === 'string' && /^[0-9a-f]{64}$/i.test(p.transcript_digest)
        ? { transcript_digest: p.transcript_digest.toLowerCase() }
        : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Build the unsigned report envelope from a runAudit() result.
//
// Deliberately excludes the raw `events` array: the report carries findings,
// the readiness rollup, framework coverage, and a remediation roadmap - not the
// (potentially sensitive) raw log bodies. The signature still covers everything
// in the envelope, so the deliverable is tamper-evident end to end.
// ---------------------------------------------------------------------------
export function buildReportEnvelope(auditResult, opts = {}) {
  if (!auditResult || typeof auditResult !== 'object' || !auditResult.summary) {
    throw new Error('buildReportEnvelope: a runAudit() result with a summary is required');
  }
  const options = opts && typeof opts === 'object' ? opts : {};
  const s = auditResult.summary;

  const subjectName = String(options.subject || options.name || 'Agent fleet').slice(0, 200);
  const generatedAt = options.generated_at || new Date().toISOString();

  // Tier + watermark. The free Scan returns a watermarked PREVIEW envelope; the
  // paid Signed Readiness Report re-signs the SAME audit with tier:'report' and
  // no watermark. Both fields sit in the signed payload (canonicalizeReport
  // covers every key but signature_ed25519), so the watermark is tamper-evident:
  // a buyer cannot strip "UNPAID PREVIEW" without breaking the Ed25519 signature.
  const tier = options.tier === 'report' ? 'report' : 'scan';
  const watermark = options.watermark != null ? !!options.watermark : (tier !== 'report');

  // PAYWALL REDUCTION opt-in. The summary-only reduction (stub findings + withold
  // the paid-tier sections, with the carry-over stashed for the paid upgrade) is
  // applied ONLY when the caller EXPLICITLY requests the free Scan tier
  // (opts.tier === 'scan'). Building an envelope WITHOUT an explicit tier yields
  // the full report shape (the legacy default a direct caller / a paid upgrade
  // expects); only the revenue-gated self-serve scan path passes tier:'scan'.
  // opts.reduceScan can force the reduction on/off independently when needed.
  const reduceScan = options.reduceScan != null
    ? !!options.reduceScan
    : (options.tier === 'scan');

  // Evidence tier (A/B/C). Bound INSIDE the signed payload, so the evidence-
  // quality grade is as tamper-evident as the findings themselves: a report
  // built from vendor-asserted logs cannot be upgraded to "captured by the
  // kolm gateway" without breaking the Ed25519 signature.
  const evidenceTier = coerceEvidenceTier(
    options.evidence_tier != null ? options.evidence_tier : auditResult.evidence_tier,
    auditResult,
  );
  const proofScope = buildReportProofScope(auditResult);

  // Curated, framework-mapped findings (drop the all-clear "info" sentinels so
  // a clean report reads as clean, not as a list of non-findings).
  const mapped = (auditResult.controls && Array.isArray(auditResult.controls.findings))
    ? auditResult.controls.findings
    : [];
  const findings = mapped
    .filter((f) => f && f.severity && f.severity !== 'info')
    .map((f) => ({
      id: f.id,
      severity: f.severity,
      pillar: f.pillar || null,
      title: f.title || f.id,
      detail: f.detail || null,
      asr: f.asr ? { id: f.asr.id, name: f.asr.name } : null,
      frameworks: frameworksOf(f),
      evidence: Array.isArray(f.evidence) ? f.evidence.slice(0, 8) : [],
    }))
    .sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));

  // Per-framework coverage from the control map (sorted, framework-keyed).
  const frameworks = (auditResult.controls && Array.isArray(auditResult.controls.frameworks))
    ? auditResult.controls.frameworks.map((fw) => ({
        framework: fw.framework,
        controls_touched: fw.controls_touched,
        findings: fw.findings,
        worst_severity: fw.worst_severity,
        controls: (fw.controls || []).map((c) => ({ id: c.id, label: c.label, findings: c.findings, max_severity: c.max_severity })),
      }))
    : [];

  const verifyUrl = (options.verify_url
    || `${(process.env.KOLM_VERIFY_URL_BASE || 'https://kolm.ai').replace(/\/+$/, '')}/verify`);

  const envelope = {
    schema: AUDIT_REPORT_SCHEMA,
    report_version: AUDIT_REPORT_VERSION,
    spec_version: auditResult.spec_version || null,
    report_id: options.report_id || newReportId(options.report_seed),
    generated_at: generatedAt,
    tier,
    watermark,
    evidence_tier: evidenceTier,
    proof_scope: proofScope,
    subject: {
      name: subjectName,
      source: auditResult.source || null,
      records: auditResult.ingest ? (auditResult.ingest.records ?? null) : null,
      events: auditResult.ingest ? (auditResult.ingest.events ?? null) : null,
    },
    summary: {
      readiness_pct: s.readiness_pct ?? null,
      total_findings: s.total_findings ?? findings.length,
      by_severity: s.by_severity || {},
      tamper_evident: s.tamper_evident === true,
      assessed_controls: s.assessed_controls || [],
      controls: (s.controls || []).map((c) => ({
        id: c.id, name: c.name, status: c.status, findings: c.findings, by_severity: c.by_severity || {},
      })),
      not_assessed: (s.not_assessed || []).map((n) => ({ id: n.id, reason: n.reason })),
      blocking_count: s.blocking_count ?? (Array.isArray(s.blocking) ? s.blocking.length : 0),
    },
    findings,
    frameworks,
    remediation: deriveRemediation(auditResult),
    caveats: buildCaveats(s, auditResult, proofScope),
    asr_checklist: ASR_CONTROLS.map((a) => ({ id: a.id, name: a.name, requires: a.requires })),
    contact: CONTACT_EMAIL,
    verify_url: verifyUrl,
  };
  if (s.note) envelope.summary.note = s.note;

  // GAP-3: vendor coverage declaration, bound INSIDE the signed payload next to
  // evidence_tier (canonicalizeReport covers every key but the detached
  // evidence), so the vendor's "this export covers window W of systems S" is as
  // tamper-evident as the findings. The route layer normalizes + validates
  // (src/coverage-declaration.js); a defensive shape check here keeps a raw
  // caller from binding garbage.
  const coverageDecl = options.coverage_declaration && typeof options.coverage_declaration === 'object'
    && !Array.isArray(options.coverage_declaration)
    ? options.coverage_declaration
    : null;
  if (coverageDecl) {
    envelope.coverage_declaration = coverageDecl;
    envelope.caveats.push(declarationCaveat(coverageDecl));
    // Declared-window cross-check: when the trail's observed event span and the
    // declared window disagree, say so in the signed caveats (a caveat, not a
    // finding - the volume-sanity finding lives in the analyzer, which sees only
    // events). Tolerant of audits without a trail coverage block.
    const cov = auditResult.trail && auditResult.trail.coverage ? auditResult.trail.coverage : null;
    const declStart = Date.parse(coverageDecl.window_start || '');
    const declEnd = Date.parse(coverageDecl.window_end || '');
    if (cov && Number.isFinite(declStart) && Number.isFinite(declEnd)
        && Number.isFinite(cov.earliest_ms) && Number.isFinite(cov.latest_ms)) {
      const DAY = 86400000;
      const outside = cov.earliest_ms < declStart - DAY || cov.latest_ms > declEnd + DAY;
      const declaredDays = (declEnd - declStart) / DAY;
      const observedDays = (cov.latest_ms - cov.earliest_ms) / DAY;
      const underCovered = declaredDays >= 2 && observedDays < declaredDays * 0.5;
      if (outside || underCovered) {
        envelope.caveats.push(
          `The declared coverage window (${String(coverageDecl.window_start).slice(0, 10)} to ${String(coverageDecl.window_end).slice(0, 10)}) does not match the observed event span (${new Date(cov.earliest_ms).toISOString().slice(0, 10)} to ${new Date(cov.latest_ms).toISOString().slice(0, 10)}); treat the export's window selection as unverified.`,
        );
      }
    }
  } else if (evidenceTier.grade === 'B' || evidenceTier.grade === 'C') {
    // Vendor-supplied evidence with NO declaration: the analyzed window is the
    // vendor's selection, and the signed report says so.
    envelope.caveats.push(
      "No coverage declaration was supplied; the analyzed window is the vendor's selection.",
    );
  }

  // Input-evidence digest (M2 / ASR-6). Binds the SIGNED report to the exact
  // AuditEvents the analyzers ran on (sha256 over their canonical form), without
  // carrying the potentially-sensitive event bodies. Added before signing, so it
  // is signature-covered and tamper-evident.
  envelope.evidence_digest = computeEvidenceDigest(auditResult);

  // Agent identity passport (the wedge). A compact, signature-covered projection
  // of WHO acted, on WHICH models + MCP/vendor surface, through WHAT delegation
  // graph, over WHICH retrieval sources - assembled from the Wave-2 analyzer
  // outputs the orchestrator produced over the same events. Pure / never-throws.
  envelope.passport = buildAgentPassport({
    agent_identity: auditResult.agent_identity,
    model_provenance: auditResult.model_provenance,
    delegation: auditResult.delegation,
    rag_memory: auditResult.rag_memory,
    audit_summary: s,
  });

  // Sub-processor inventory (OFFER #8). The enumerated models / providers /
  // MCP-or-vendor servers / egress hosts observed in the supplied window, deduped
  // and sorted deterministically. A NEW top-level field added BEFORE signing, so
  // it is signature-covered. Pure / never-throws; re-ingests nothing.
  envelope.subprocessor_inventory =
    auditResult.subprocessor_inventory || buildSubprocessorInventory(auditResult);

  // ASR-4 red-team resistance. A NEW top-level field: the canonicalizer is a
  // generic key-sort, so adding it is signature-safe and does not change how any
  // existing field is canonicalized. Gated by opts.includeRedTeam (default on)
  // so a caller can build the pre-red_team baseline for a canonicalization diff.
  if (options.includeRedTeam !== false) {
    envelope.red_team = buildRedTeamBlock(auditResult);
  }

  // PAYWALL REDUCTION (revenue gate). The free Scan tier is a watermarked
  // SUMMARY-ONLY preview: the verdict band (summary rollup) stays, but the
  // paid-only sections - detailed findings, the frameworks crosswalk, the
  // remediation roadmap, the evidence_tier grade and the asr_checklist body -
  // are WITHHELD. Findings collapse to bare {severity,title} stubs so a buyer
  // cannot read the actual finding bodies from a free scan. The reduction
  // happens HERE, before signReport, so the Ed25519 signature covers exactly
  // the reduced payload a buyer receives (a buyer cannot forge entitlement by
  // flipping tier->report on a signed scan; that breaks the signature).
  //
  // The withheld sections are stashed under the detached _full_payload carry-
  // over so the paid upgrade (resignAsTier) can restore them WITHOUT re-running
  // the audit. _full_payload is SERVER-SIDE ONLY: it is excluded from the signed
  // canonical bytes (canonicalizeReport) AND must be stripped before the
  // envelope reaches any HTTP client (stripWirePayload).
  if (reduceScan && tier === 'scan') {
    reduceToScanTier(envelope);
  }
  return envelope;
}

// Top-level sections that the paid Signed Readiness Report carries but the free
// Scan tier withholds. Order is the restore order used by the paid upgrade.
const PAID_ONLY_SECTIONS = ['frameworks', 'remediation', 'evidence_tier', 'asr_checklist'];

// Collapse an in-place envelope to the watermarked Scan (summary-only) tier:
// stub the findings, withhold the paid-only sections, and stash everything
// withheld under the detached _full_payload carry-over. Idempotent-safe: only
// runs when _full_payload is not already present.
function reduceToScanTier(envelope) {
  if (!envelope || typeof envelope !== 'object' || envelope._full_payload) return envelope;
  const carry = {};
  // Full (detailed) findings are stashed; the wire findings become severity+
  // title stubs (sorted highest-severity first, same order as the full list).
  const fullFindings = Array.isArray(envelope.findings) ? envelope.findings : [];
  carry.findings = fullFindings;
  envelope.findings = fullFindings.map((f) => ({ severity: f.severity, title: f.title || f.id || '' }));
  // Withhold the paid-only top-level sections (stash, then delete).
  for (const key of PAID_ONLY_SECTIONS) {
    if (key in envelope) {
      carry[key] = envelope[key];
      delete envelope[key];
    }
  }
  envelope._full_payload = carry;
  return envelope;
}

// Restore the full report-tier sections from the detached _full_payload carry-
// over (the inverse of reduceToScanTier). Used by the paid upgrade so the
// deterministic audit is never re-run. Returns the same object.
function restoreFullPayload(envelope) {
  const carry = envelope && envelope._full_payload;
  if (!carry || typeof carry !== 'object') return envelope;
  if (Array.isArray(carry.findings)) envelope.findings = carry.findings;
  for (const key of PAID_ONLY_SECTIONS) {
    if (key in carry) envelope[key] = carry[key];
  }
  delete envelope._full_payload;
  return envelope;
}

// stripWirePayload(envelope) -> a SHALLOW copy with the server-side-only
// _full_payload carry-over removed. The wire form is what reaches an HTTP
// client: it must NEVER carry the withheld paid-tier sections. Because
// _full_payload is excluded from the signed canonical bytes, stripping it does
// not disturb the signature - the stripped wire form still verifies.
export function stripWirePayload(envelope) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const { _full_payload, ...wire } = envelope;
  void _full_payload;
  return wire;
}

// ---------------------------------------------------------------------------
// Sign an envelope in place (returns the same object with signature_ed25519).
// ---------------------------------------------------------------------------
export function signReport(envelope, signer, opts = {}) {
  const s = signer || loadOrCreateDefaultSigner();
  if (!s || !s.privateKey || !s.publicKey) {
    const err = new Error('signReport: no Ed25519 signer available (set KOLM_ED25519_PRIVATE_KEY or allow a cached key)');
    err.code = 'NO_SIGNER';
    throw err;
  }
  const canonical = canonicalizeReport(envelope);
  envelope.signature_ed25519 = buildSignatureBlock({
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    key_fingerprint: s.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: envelope.generated_at,
  });
  // Anchor the SIGNED report digest in the append-only transparency log, in line
  // (recordTransparencyEntry is local + fast, never a network call), so EVERY
  // delivered report - the free Scan AND the paid Signed Readiness Report - is
  // witnessed the moment it is signed. log_checkpoint is DETACHED evidence
  // (canonicalizeReport excludes it), so attaching it does NOT change the signed
  // bytes; it references the same sha256(canonical) the signature covers. Best-
  // effort: a log failure leaves the report unanchored rather than blocking the
  // signature. attachDetachedEvidence reuses this checkpoint instead of appending
  // a duplicate leaf for the same digest.
  try {
    const cp = recordTransparencyEntry(sha256hex(canonical), {
      report_id: envelope.report_id,
      // Test isolation: callers may anchor into their own TransparencyLog
      // instead of the global store-backed witness (see _getReportTlog).
      transparencyLog: opts && opts.transparencyLog,
    });
    if (cp) envelope.log_checkpoint = cp;
  } catch { /* best-effort: omit log_checkpoint */ }
  return envelope;
}

// ---------------------------------------------------------------------------
// Build + sign in one call. Convenience for the route + CLI layers.
// Returns { envelope, report_id, key_fingerprint, signed_at }.
// ---------------------------------------------------------------------------
export function buildAndSignReport(auditResult, opts = {}) {
  const envelope = buildReportEnvelope(auditResult, opts);
  signReport(envelope, opts.signer, { transparencyLog: opts.transparencyLog });
  return {
    envelope,
    report_id: envelope.report_id,
    key_fingerprint: envelope.signature_ed25519.key_fingerprint,
    signed_at: envelope.signature_ed25519.signed_at,
  };
}

// ---------------------------------------------------------------------------
// Detached evidence (added AFTER signing). The signature covers evidence_digest
// + passport (they are part of the report). The two fields here are DETACHED:
// they reference the signed report digest (sha256 of the canonical signed
// payload) rather than being covered by the signature - because they are issued
// by third parties / append-only witnesses AFTER the report exists:
//
//   - timestamp_evidence: an RFC 3161 trusted timestamp over the signed report
//     digest (src/rfc3161-timestamp.js). Proves the report existed no later than
//     the TSA's genTime, independent of kolm's clock. status:'offline' on any
//     failure - timestamping is additive evidence, never blocks the report.
//   - log_checkpoint: inclusion of the signed report digest in the append-only
//     Ed25519/Merkle transparency log (src/transparency-log.js). Best-effort.
//
// Both reference the signed digest, so they cannot be re-pointed at a different
// report without mismatching it. Never throws.
// ---------------------------------------------------------------------------
export async function attachDetachedEvidence(envelope, opts = {}) {
  if (!envelope || typeof envelope !== 'object') return envelope;
  const options = opts && typeof opts === 'object' ? opts : {};
  let reportDigest;
  try { reportDigest = sha256hex(canonicalizeReport(envelope)); }
  catch { reportDigest = null; }
  if (!reportDigest) return envelope;

  // RFC 3161 trusted timestamp over the signed report digest.
  if (options.timestamp !== false) {
    try {
      let te;
      if (options.selfIssueTimestamp === true) {
        // Fully-offline real RFC 3161 token (source:'self') - used by tests and
        // as an opt-in fallback; no network call.
        te = selfIssueTimestamp(reportDigest, { signer: options.timestampSigner });
      } else {
        te = await timestampDigest(reportDigest, {
          tsaUrl: options.tsaUrl,
          timeoutMs: options.tsaTimeoutMs,
          fallbackSelfIssue: options.fallbackSelfIssue === true,
        });
      }
      if (te && typeof te === 'object') envelope.timestamp_evidence = te;
    } catch {
      envelope.timestamp_evidence = {
        alg: 'sha256', message_imprint: reportDigest, timestamp: null,
        token_b64: null, tsa_url: null, status: 'offline', reason: 'timestamp_error',
      };
    }
  }

  // Transparency-log inclusion of the signed report digest (best-effort). When
  // signReport already anchored THIS exact digest, reuse that checkpoint rather
  // than appending a second leaf for the same report.
  if (options.transparency !== false) {
    try {
      const existing = envelope.log_checkpoint;
      const alreadyAnchored = existing && typeof existing === 'object' && existing.report_digest === reportDigest;
      if (!alreadyAnchored) {
        const cp = recordTransparencyEntry(reportDigest, { ...options, report_id: envelope.report_id });
        if (cp) envelope.log_checkpoint = cp;
      }
    } catch { /* best-effort: omit log_checkpoint */ }
  }
  return envelope;
}

// Build + sign + attach detached evidence in one async call. Returns the same
// shape as buildAndSignReport plus the envelope carrying timestamp_evidence +
// log_checkpoint. The sync buildAndSignReport stays available for callers (the
// HTTP route) that must not block on a network TSA call at request time.
export async function buildAndSignReportWithEvidence(auditResult, opts = {}) {
  const built = buildAndSignReport(auditResult, opts);
  await attachDetachedEvidence(built.envelope, opts);
  return built;
}

// ---------------------------------------------------------------------------
// Re-sign an existing signed envelope at a different tier (the paid upgrade).
//
// The free Scan stores a watermarked tier:'scan' envelope. When the buyer pays
// for the Signed Readiness Report, we do NOT re-run the (deterministic) audit -
// we flip tier->'report' + watermark->false on the stored envelope and re-sign.
// generated_at is preserved (it records when the audit ran), so signReport keeps
// signed_at == generated_at and verifyReport still passes. Returns a NEW object;
// the input is not mutated. Throws NO_SIGNER if no signer is available.
// ---------------------------------------------------------------------------
export function resignAsTier(envelope, tier, signer) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('resignAsTier: a signed envelope object is required');
  }
  // Drop the old primary signature AND any co_signatures: re-signing changes the
  // canonical payload (tier / watermark flip), which would invalidate a stale
  // co-signature. A co-signer attests the FINAL signed report, so co_signatures
  // are (re-)added by addCoSignature after this upgrade, never carried across it.
  const { signature_ed25519, co_signatures, ...rest } = envelope;
  void signature_ed25519; void co_signatures;
  const next = { ...rest };
  next.tier = tier === 'report' ? 'report' : 'scan';
  next.watermark = next.tier !== 'report';
  if (next.tier === 'report') {
    // Paid upgrade: restore the full report-tier sections from the detached
    // scan-tier carry-over (no audit re-run), then re-sign over the full payload.
    restoreFullPayload(next);
  } else if (next._full_payload) {
    // Re-signing as scan: the carry-over is server-side-only and must not be
    // signed; drop it (the wire/stripped form already excludes it).
    delete next._full_payload;
  }
  signReport(next, signer);
  return next;
}

// ---------------------------------------------------------------------------
// S11 - named co-signer (the Reviewed Attestation tier).
//
// A SECOND, independent Ed25519 attestation over the SAME signed payload. After
// the issuer signs a report (signature_ed25519), a named reviewer co-signs the
// IDENTICAL canonical bytes - canonicalizeReport(envelope), which excludes
// signature_ed25519 / timestamp_evidence / log_checkpoint / co_signatures - so:
//   * the co-signer attests exactly what the issuer signed (same bytes), and
//   * appending a co-signature never disturbs the primary signature or any prior
//     co-signature (co_signatures is excluded from the canonical payload).
//
// The block records WHO co-signed (name, role) alongside a full Ed25519
// signature block { spec, alg, public_key, key_fingerprint, signature,
// signed_at } so it verifies offline with no extra schema. The co-signer's key
// is passed in (env KOLM_COSIGNER_PRIVATE_KEY in production; tests pass a
// generated signer). Mutates + returns the envelope. Co-signing NEVER blocks the
// primary deliverable: a missing / invalid signer throws NO_SIGNER and the caller
// simply ships the issuer-signed report without a co-signature.
//
// signer: { privateKey, publicKey, key_fingerprint? } (same shape as signReport).
// name/role: short ASCII labels for the named reviewer (kept in the block).
// ---------------------------------------------------------------------------
export function addCoSignature(envelope, { signer, name, role } = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('addCoSignature: a signed envelope object is required');
  }
  // The named co-signer key is DELIBERATELY independent of the issuer signer:
  // pass it explicitly (tests), or set KOLM_COSIGNER_PRIVATE_KEY in production.
  // It never falls back to the issuer's own key - a co-signature must be a second,
  // distinct attestation, not the issuer signing twice.
  const s = signer || loadCoSignerFromEnv();
  if (!s || !s.privateKey || !s.publicKey) {
    const err = new Error('addCoSignature: no Ed25519 co-signer available (set KOLM_COSIGNER_PRIVATE_KEY or pass a signer)');
    err.code = 'NO_SIGNER';
    throw err;
  }
  // The co-signer signs the SAME bytes the issuer signed: co_signatures is
  // excluded from canonicalizeReport, so the canonical payload is identical
  // whether zero or N co-signatures are already attached.
  const canonical = canonicalizeReport(envelope);
  const block = buildSignatureBlock({
    privateKey: s.privateKey,
    publicKey: s.publicKey,
    key_fingerprint: s.key_fingerprint,
    payloadCanonical: canonical,
    signed_at: new Date().toISOString(),
  });
  const coSig = {
    name: name == null ? null : String(name).slice(0, 200),
    role: role == null ? null : String(role).slice(0, 200),
    signed_at: block.signed_at,
    spec: block.spec,
    alg: block.alg,
    public_key: block.public_key,
    key_fingerprint: block.key_fingerprint,
    signature: block.signature,
  };
  if (!Array.isArray(envelope.co_signatures)) envelope.co_signatures = [];
  envelope.co_signatures.push(coSig);
  return envelope;
}

// Load the dedicated co-signer key from the environment (production path). Kept
// separate from the issuer signer so the named reviewer's key is independent of
// the evidence-issuing key. Returns a signer or null; never throws.
export function loadCoSignerFromEnv() {
  try {
    let pem = process.env.KOLM_COSIGNER_PRIVATE_KEY || null;
    if (!pem) return null;
    if (pem.includes('\\n')) pem = pem.replace(/\\r\\n|\\n/g, '\n');
    const keyObj = crypto.createPrivateKey(pem);
    if (keyObj.asymmetricKeyType !== 'ed25519') return null;
    const publicKey = crypto.createPublicKey(keyObj).export({ type: 'spki', format: 'pem' });
    return { privateKey: pem, publicKey, key_fingerprint: keyFingerprint(publicKey) };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Verify a signed report envelope. Pure, offline, never throws.
// Returns { ok, reason?, key_fingerprint?, checks: [...] }.
// ---------------------------------------------------------------------------
export function verifyReport(envelope, opts = {}) {
  const checks = [];
  let report = envelope;
  if (typeof report === 'string') {
    try { report = JSON.parse(report); }
    catch (e) { return { ok: false, reason: 'input is not valid JSON: ' + e.message, checks }; }
  }
  if (!report || typeof report !== 'object') {
    return { ok: false, reason: 'report must be a JSON object', checks };
  }
  if (report.schema && report.schema !== AUDIT_REPORT_SCHEMA) {
    return { ok: false, reason: `unexpected schema: ${report.schema}`, checks };
  }
  checks.push({ name: 'schema', ok: true, detail: report.schema || '(none)' });

  const block = report.signature_ed25519;
  if (!block || typeof block !== 'object') {
    return { ok: false, reason: 'report has no signature_ed25519 block', checks };
  }
  checks.push({ name: 'signature block present', ok: true, detail: `alg=${block.alg || '?'} spec=${block.spec || '?'}` });

  let canonical;
  try { canonical = canonicalizeReport(report); }
  catch (e) { return { ok: false, reason: 'cannot canonicalize report: ' + e.message, checks }; }
  checks.push({ name: 'canonical payload rebuilt', ok: true, detail: `${canonical.length} bytes` });

  const v = verifySignatureBlock(block, canonical);
  checks.push({ name: 'Ed25519 signature valid', ok: v.ok, detail: v.ok ? 'signature matches payload' : (v.reason || 'does not verify') });
  if (!v.ok) return { ok: false, reason: v.reason || 'signature does not verify', key_fingerprint: v.key_fingerprint, checks };

  // signed_at lives inside the signature block, which the signature itself does
  // NOT cover (a signature cannot sign itself). generated_at, by contrast, is in
  // the signed payload. signReport sets the two equal, so a mismatch means the
  // displayed timestamp was altered after signing - surface it rather than show
  // a clean pass with a forged date. String() so a non-string never throws.
  if (block.signed_at != null && report.generated_at != null
      && String(block.signed_at) !== String(report.generated_at)) {
    checks.push({ name: 'signed_at matches signed generated_at', ok: false, detail: `block.signed_at=${String(block.signed_at)} ≠ generated_at=${String(report.generated_at)}` });
    return { ok: false, reason: 'signed_at does not match the signed generated_at (timestamp altered after signing)', key_fingerprint: v.key_fingerprint, checks };
  }
  checks.push({ name: 'signed_at matches signed generated_at', ok: true, detail: String(report.generated_at || '(none)') });

  // Additive: input-evidence digest (M2 / ASR-6). It is signature-covered, so any
  // tampering already failed the Ed25519 check above. Here we surface it, and when
  // the caller supplies the original events we recompute and confirm the binding
  // (proving the signed report is bound to the exact evidence analyzed).
  const ed = report.evidence_digest;
  if (ed && typeof ed === 'object') {
    const wellFormed = ed.alg === 'sha256' && typeof ed.value === 'string' && /^[0-9a-f]{64}$/i.test(ed.value);
    if (opts && Array.isArray(opts.events)) {
      const recomputed = computeEvidenceDigest(opts.events).value;
      const match = recomputed === String(ed.value);
      checks.push({ name: 'evidence_digest matches supplied events', ok: match, detail: match ? String(ed.value) : `report=${String(ed.value).slice(0, 12)} recomputed=${recomputed.slice(0, 12)}` });
      if (!match) return { ok: false, reason: 'evidence_digest does not match the supplied input events', key_fingerprint: v.key_fingerprint, checks };
    } else {
      checks.push({ name: 'evidence_digest present (signature-covered)', ok: wellFormed, detail: wellFormed ? `${ed.value} over ${ed.event_count} event(s)` : 'malformed evidence_digest (informational)' });
    }
  }

  // Additive, informational: surface the DETACHED evidence. Both fields are
  // excluded from the signed bytes (they are issued after signing and reference
  // the signed digest), so they never flip the verdict; this just mirrors the
  // browser verifier so a Node consumer sees the same "signed + timestamped +
  // witnessed" story. A delivered report is always anchored in the transparency
  // log; the paid report additionally carries an RFC 3161 trusted timestamp.
  const te = report.timestamp_evidence;
  if (te && typeof te === 'object') {
    const st = String(te.status || '');
    const imprintOk = typeof te.message_imprint === 'string' && /^[0-9a-f]{64}$/i.test(te.message_imprint);
    if (st === 'timestamped' && te.token_b64 && imprintOk) {
      checks.push({ name: 'trusted timestamp present', ok: true, detail: `${te.timestamp || '?'} via ${te.tsa_url || te.source || '?'}` });
    } else if (st === 'offline') {
      checks.push({ name: 'trusted timestamp', ok: true, detail: 'not timestamped (status offline); additive evidence absent' });
    } else {
      checks.push({ name: 'trusted timestamp', ok: false, detail: 'timestamp_evidence present but malformed (informational; verdict unaffected)' });
    }
  }
  const cp = report.log_checkpoint;
  if (cp && typeof cp === 'object') {
    const wf = typeof cp.root_hash === 'string' && /^[0-9a-f]{64}$/i.test(cp.root_hash) && Number.isFinite(Number(cp.tree_size));
    checks.push({ name: 'transparency-log checkpoint present', ok: wf, detail: wf ? `seq ${cp.seq} of ${cp.tree_size}, root ${String(cp.root_hash).slice(0, 16)}` : 'log_checkpoint present but malformed (informational; verdict unaffected)' });
  }

  // S11 named co-signers (informational). Each co-signature is an Ed25519 block
  // over the SAME canonical payload as the primary signature (co_signatures is
  // excluded from canonicalizeReport). We verify each and surface who co-signed,
  // but the PRIMARY signature remains the verdict: a missing / invalid co-sig
  // never flips ok, and a report with no co_signatures is unchanged.
  let co_signers;
  if (Array.isArray(report.co_signatures) && report.co_signatures.length) {
    co_signers = report.co_signatures.map((cs) => {
      const cv = verifySignatureBlock(cs, canonical);
      const ok = cv.ok === true;
      checks.push({
        name: 'co-signature' + (cs && cs.name ? ` (${String(cs.name)})` : ''),
        ok,
        detail: ok ? `co-signed by ${cs && cs.name ? String(cs.name) : '(unnamed)'}${cs && cs.role ? ', ' + String(cs.role) : ''}` : (cv.reason || 'co-signature does not verify') + ' (informational; verdict unaffected)',
      });
      return {
        name: cs && cs.name != null ? String(cs.name) : null,
        role: cs && cs.role != null ? String(cs.role) : null,
        ok,
        key_fingerprint: ok ? cv.key_fingerprint : (cs && cs.key_fingerprint != null ? String(cs.key_fingerprint) : null),
      };
    });
  }

  // report-revocation-parity: a signature can verify (tier 1) and STILL be
  // untrustworthy if the issuer key has since been revoked (compromised /
  // withdrawn). The PURE verifier must close this gap so a revoked-key report
  // fails everywhere verifyReport runs (route, CLI, SDK bridge) - not only on
  // the route that bolted revocation on separately. Consult the persisted store
  // synchronously (issuerKeyStatus is pure + never throws on a bad fp, but guard
  // anyway so a store outage degrades to informational, never throws/flips a
  // clean signature to a hard failure). Runs last: only a fully-verified,
  // canonicalization-sound report with a resolved fingerprint reaches here.
  if (issuerKeyStatus && v.key_fingerprint) {
    try {
      const st = issuerKeyStatus(v.key_fingerprint);
      if (st && st.status === 'revoked') {
        checks.push({ name: 'issuer key not revoked', ok: false, detail: 'key ' + st.fingerprint + ' revoked at ' + st.revoked_at + ': ' + (st.reason || '') });
        return { ok: false, reason: 'issuer_key_revoked', key_fingerprint: v.key_fingerprint, checks };
      }
      checks.push({ name: 'issuer key not revoked', ok: true, detail: 'key ' + v.key_fingerprint + ' is ' + (st && st.status ? st.status : 'live') });
    } catch {
      checks.push({ name: 'issuer key not revoked', ok: null, detail: 'revocation_check_unavailable' });
    }
  }

  const out = { ok: true, key_fingerprint: v.key_fingerprint, checks };
  if (co_signers) out.co_signers = co_signers;
  return out;
}

// ===========================================================================
// Human-readable renderings of the SAME signed envelope.
// ===========================================================================

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STATUS_LABEL = { pass: 'PASS', attention: 'ATTENTION', blocking: 'BLOCKING', untested: 'UNTESTED' };
const STATUS_COLOR = { pass: '#166534', attention: '#0e7490', blocking: '#991b1b', untested: '#5b6472' };

// renderReportHtml(envelope, opts) -> string. Self-contained HTML document.
//
// opts (optional, render-only - NEVER signature-affecting):
//   delta:     a computeAuditDelta result (src/audit-delta.js) or null. When
//              present, a "What changed since the last attestation" section is
//              rendered above Findings.
//   trustSlug: the Trust-link slug or null. When present (paid tier), the
//              headline strip carries a one-click /verify?trust=<slug> button.
// Calling with a single argument behaves exactly as before plus the new
// verdict-first sections derived from the SAME signed fields.
export function renderReportHtml(envelope, opts = {}) {
  const e = envelope || {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const s = e.summary || {};
  const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
  const sig = e.signature_ed25519 || {};
  const isWm = e.watermark === true;
  const wmBanner = isWm
    ? `<div class="wm-banner">UNPAID PREVIEW &middot; not for distribution. This free Scan snapshot is watermarked. Purchase the Signed Readiness Report to receive an unwatermarked, distributable copy plus a shareable verify link your reviewer can check. <span class="mono">${esc(e.contact || CONTACT_EMAIL)}</span></div>`
    : '';

  // Scan tier (or any watermarked preview) keeps the live verdict band, the
  // one-click verify button, and the Trust-link affordances LOCKED - rendered
  // as a neutral slate panel naming exactly what the paid report includes.
  const isScanLocked = e.tier === 'scan' || e.watermark === true;

  // ---- Verdict band (derived ONLY from signed fields; never invented). ----
  // Legacy envelopes without summary.blocking_count omit the band entirely.
  const rtForVerdict = e.red_team && typeof e.red_team === 'object' ? e.red_team : null;
  const exposedCount = rtForVerdict && rtForVerdict.summary && rtForVerdict.summary.exposed != null
    ? Number(rtForVerdict.summary.exposed)
    : null;
  const hasVerdictBasis = e.summary && typeof e.summary === 'object' && s.blocking_count != null;
  const blockingCount = hasVerdictBasis ? Number(s.blocking_count) : null;
  const attentionCount = Array.isArray(e.findings) ? e.findings.length : (s.total_findings ?? 0);
  const VERDICT_QUALIFIER = 'Assessed scope only; see Scope and limitations.';
  let verdictColor = '#5b6472';
  let verdictText = '';
  if (hasVerdictBasis) {
    if (blockingCount > 0 || (exposedCount != null && exposedCount > 0)) {
      verdictColor = '#991b1b';
      verdictText = `${blockingCount} deal-blocking finding(s) open`
        + (exposedCount > 0 ? ` and ${exposedCount} red-team probe(s) exposed` : '')
        + '. Not procurement-ready on the assessed controls.';
    } else if (attentionCount > 0) {
      verdictColor = '#0e7490';
      verdictText = `No deal-blocking findings in the assessed controls. ${attentionCount} finding(s) need attention before review.`;
    } else {
      verdictColor = '#166534';
      verdictText = 'No deal-blocking findings in the assessed controls.';
    }
  }
  const verdictBand = hasVerdictBasis && !isScanLocked
    ? `<div class="verdict" style="background:${verdictColor}">${esc(verdictText)} ${esc(VERDICT_QUALIFIER)}</div>`
    : '';
  // Same position on the scan tier: the locked-affordances panel ($750 upgrade).
  const lockedPanel = isScanLocked
    ? `<div class="locked-panel">Verdict band, one-click cryptographic verification, the reviewer toolbar and the shareable Trust link are included in the Signed Readiness Report ($750).</div>`
    : '';

  // Headline-tile coloring by the same thresholds: red when blocking, green
  // when fully clean, slate otherwise; legacy envelopes keep the plain ink.
  const tileColor = hasVerdictBasis
    ? (blockingCount > 0 ? '#991b1b'
      : ((exposedCount == null || exposedCount === 0) && attentionCount === 0 ? '#166534' : '#5b6472'))
    : null;
  const tileStyle = tileColor ? ` style="color:${tileColor}"` : '';

  // ---- One-click verify button (paid tier only). URL contract: the query
  // param named `trust` on /verify (public/verify.html via Vercel cleanUrls).
  let verifyButton = '';
  if (!isScanLocked) {
    const trustSlug = typeof o.trustSlug === 'string' && o.trustSlug.trim() !== '' ? o.trustSlug : null;
    if (trustSlug) {
      verifyButton = `<div class="verify-cta"><a class="btn-verify" href="/verify?trust=${encodeURIComponent(trustSlug)}">Verify this report cryptographically</a></div>`;
    } else if (e.verify_url && e.tier !== 'scan') {
      verifyButton = `<div class="verify-cta"><a class="btn-verify" href="${esc(e.verify_url)}">Verify this report cryptographically</a></div>`;
    }
  }

  // Evidence-tier banner. Signed envelopes built from now on always carry
  // evidence_tier; a legacy envelope (issued before tiered evidence) renders a
  // plain "not graded" line - it never crashes and never invents a grade.
  const ET_LABEL = {
    A: 'EVIDENCE TIER A - captured by kolm gateway at runtime',
    B: 'EVIDENCE TIER B - vendor logs, hash chain verified',
    C: 'EVIDENCE TIER C - vendor logs as provided',
  };
  const ET_COLOR = { A: '#166534', B: '#0e7490', C: '#5b6472' };
  const et = e.evidence_tier && typeof e.evidence_tier === 'object' ? e.evidence_tier : null;
  const etGrade = et && typeof et.grade === 'string' ? et.grade.toUpperCase() : null;
  const etBanner = et && ET_LABEL[etGrade]
    ? `<div class="et-banner" style="border-left-color:${ET_COLOR[etGrade]}">${esc(ET_LABEL[etGrade])}${(Array.isArray(et.basis) ? et.basis : []).map((b) => `<span class="et-basis">${esc(b)}</span>`).join('')}</div>`
    : `<div class="et-banner et-none">Evidence tier: not graded (issued before tiered evidence)</div>`;

  // Evidence-grade chip (fifth headline tile). Legacy envelopes render n/a -
  // never an invented grade. Grade C carries the one-line capture nudge.
  const gradeKnown = !!(et && ET_LABEL[etGrade]);
  const gradeLetter = gradeKnown ? etGrade : 'n/a';
  const gradeColor = gradeKnown ? ET_COLOR[etGrade] : '#5b6472';
  const gradeNudge = gradeKnown && etGrade === 'C'
    ? `<div class="small grade-nudge">Grade C: vendor logs as provided. Grade A is available via kolm-gateway capture.</div>`
    : '';
  const gradeTile = `<div><div class="big" style="color:${gradeColor}">${esc(gradeLetter)}</div><div class="small">evidence grade</div>${gradeNudge}</div>`;

  // ---- For reviewers (no invented numbers, no certification claims). ----
  const forReviewers = `
  <h2>For reviewers</h2>
  <p class="small">This report supports vendor security review: every finding is mapped to the framework controls a reviewer cites. The Trust link version of this page carries a Drata/Vanta export, a questionnaire CSV and a drift view. Scope is contractual. Permission posture, redaction and audit-trail integrity are assessed. Injection is tested and reported, not warranted.</p>`;

  // ---- Delta section (render half of the re-attestation drift view). ----
  // Rendered only when the caller supplies a computeAuditDelta result; the
  // section is a pure projection of that object - nothing is invented here.
  let deltaSection = '';
  if (o.delta && typeof o.delta === 'object') {
    const d = o.delta;
    const added = Array.isArray(d.findings_added) ? d.findings_added : [];
    const resolved = Array.isArray(d.findings_resolved) ? d.findings_resolved : [];
    const changed = Array.isArray(d.controls_changed) ? d.controls_changed : [];
    const deltaColor = d.regressed === true
      ? '#991b1b'
      : ((typeof d.readiness_change === 'number' && d.readiness_change > 0)
          || (resolved.length > 0 && added.length === 0))
        ? '#166534'
        : '#5b6472';
    const rc = typeof d.readiness_change === 'number'
      ? `${d.readiness_change > 0 ? '+' : ''}${d.readiness_change} percentage point(s)`
      : 'n/a';
    const fromRef = d.from && typeof d.from === 'object' ? d.from : {};
    const addedList = added.map((f) => `<li><span class="sev" style="color:${_sevColor(f && f.severity)}">${esc(((f && f.severity) || '').toUpperCase())}</span> ${esc((f && (f.title || f.id)) || '')}</li>`).join('');
    const resolvedList = resolved.map((f) => `<li>${esc((f && (f.title || f.id)) || '')}</li>`).join('');
    const changedList = changed.map((c) => `<li><span class="mono">${esc((c && c.id) || '?')}: ${esc((c && c.from_status) || '?')} -&gt; ${esc((c && c.to_status) || '?')}</span></li>`).join('');
    deltaSection = `
  <h2>What changed since the last attestation</h2>
  <div class="delta-head" style="background:${deltaColor}">${esc(d.summary || `Compared against ${fromRef.report_id || 'the prior attestation'}.`)}</div>
  <p class="small">Readiness movement: <strong>${esc(rc)}</strong>${fromRef.report_id ? ` &middot; prior report <span class="mono">${esc(fromRef.report_id)}</span>${fromRef.generated_at ? ` (${esc(fromRef.generated_at)})` : ''}` : ''}</p>
  <p class="small">${esc(changed.length)} control transition(s) &middot; ${esc(added.length)} finding(s) added &middot; ${esc(resolved.length)} resolved</p>
  ${changedList ? `<h3 class="small">Control transitions</h3><ul class="small">${changedList}</ul>` : ''}
  ${addedList ? `<h3 class="small">Findings added</h3><ul class="small">${addedList}</ul>` : ''}
  ${resolvedList ? `<h3 class="small">Findings resolved</h3><ul class="small">${resolvedList}</ul>` : ''}`;
  }

  const controlRows = (s.controls || []).map((c) => `
    <tr>
      <td class="mono">${esc(c.id)}</td>
      <td>${esc(c.name)}</td>
      <td><span class="pill" style="background:${STATUS_COLOR[c.status] || '#555'}">${esc(STATUS_LABEL[c.status] || c.status)}</span></td>
      <td>${esc(c.findings)}</td>
    </tr>`).join('');

  const notAssessed = (s.not_assessed || []).map((n) => `
    <li><span class="mono">${esc(n.id)}</span> - ${esc(n.reason)}</li>`).join('');

  const findingRows = (e.findings || []).map((f) => `
    <div class="finding sev-${esc(f.severity)}">
      <div class="finding-head">
        <span class="sev">${esc((f.severity || '').toUpperCase())}</span>
        <span class="finding-title">${esc(f.title)}</span>
      </div>
      ${f.detail ? `<p class="finding-detail">${esc(f.detail)}</p>` : ''}
      <p class="finding-fw">${esc(f.asr ? f.asr.id + ' · ' : '')}${esc((f.frameworks || []).join(' · ') || 'no framework mapping')}</p>
    </div>`).join('');

  const remediation = (e.remediation || []).map((r) => {
    // When the generic fallback fired (no standard remediation pattern for this
    // finding id), surface the finding's own detail excerpt in the row so the
    // engineer still gets the specific evidence to act on - never filler.
    let actionCell = esc(r.action);
    if (r.action === REMEDIATION_FALLBACK_ACTION) {
      const src = (e.findings || []).find((f) => f && f.id === r.finding_id && f.detail);
      if (src) actionCell += `<div class="small rem-detail">${esc(String(src.detail).slice(0, 320))}</div>`;
    }
    return `
    <tr>
      <td class="mono">${esc(r.priority)}</td>
      <td>${esc(r.title)}</td>
      <td>${actionCell}</td>
      <td class="mono small">${esc((r.frameworks || []).join(', '))}</td>
    </tr>`;
  }).join('');

  const caveats = (e.caveats || []).map((c) => `<li>${esc(c)}</li>`).join('');

  // Red-team resistance section (ASR-4). score==null renders n/a (no fake number).
  const rt = e.red_team && typeof e.red_team === 'object' ? e.red_team : null;
  const rtSum = rt && rt.summary ? rt.summary : {};
  const rtScore = rt ? (rt.score == null ? 'n/a' : `${rt.score}/100`) : 'n/a';
  const RT_STATUS_LABEL = { resisted: 'RESISTED', exposed: 'EXPOSED', untested: 'UNTESTED' };
  const RT_STATUS_COLOR = { resisted: '#166534', exposed: '#991b1b', untested: '#5b6472' };
  const rtRows = rt ? (rt.probes || []).map((p) => `
    <tr>
      <td>${esc(p.title || p.id)}<div class="small" style="color:var(--muted)">${esc(p.category || '')}</div></td>
      <td><span class="sev" style="color:${_sevColor(p.severity)}">${esc((p.severity || '').toUpperCase())}</span></td>
      <td><span class="pill" style="background:${RT_STATUS_COLOR[p.status] || '#555'}">${esc(RT_STATUS_LABEL[p.status] || p.status)}</span></td>
      <td class="mono small">${esc((p.frameworks || []).join(' · '))}</td>
      <td class="mono small">${esc((p.benchmark_refs || []).join(' | '))}</td>
    </tr>`).join('') : '';
  const rtSection = rt ? `
  <h2>Red-Team Resistance: ${esc(rtScore)}</h2>
  <p class="sub small">Deterministic injection / agent-abuse battery (${esc(rt.domain || 'generic')} suite) over the ingested events. ${esc(rtSum.resisted ?? 0)} resisted, ${esc(rtSum.exposed ?? 0)} exposed, ${esc(rtSum.untested ?? 0)} untested of ${esc(rtSum.probes_total ?? 0)} probes. The score is a graduated rollup over the exercised probes only; untested probes are marked, never scored as a pass. ${esc(rtSum.benchmark_crosswalk_note || BENCHMARK_CROSSWALK_NOTE)}</p>
  <table><thead><tr><th>Probe</th><th>Severity</th><th>Observed resistance</th><th>Mapped to</th><th>Benchmark refs</th></tr></thead>
  <tbody>${rtRows}</tbody></table>` : '';

  // Agent identity passport (signature-covered). Rendered as a compact set of
  // tables; absent on legacy reports built before this field existed.
  const pp = e.passport && typeof e.passport === 'object' ? e.passport : null;
  const ppAgents = pp ? (pp.agents || []).map((a) => `
    <tr><td>${esc(a.agent || '(unnamed)')}</td><td class="mono small">${esc(a.key_id || ' - ')}</td><td>${esc((a.scopes || []).length)}</td><td>${a.attested ? 'Yes' : 'No'}</td></tr>`).join('') : '';
  const ppModels = pp ? (pp.models || []).map((m) => `
    <tr><td class="mono">${esc(m.slug)}</td><td>${m.pinned ? 'pinned' : 'floating'}</td><td>${esc(m.provider || 'unknown')}</td></tr>`).join('') : '';
  const ppEdges = pp ? (pp.delegation_graph && Array.isArray(pp.delegation_graph.edges) ? pp.delegation_graph.edges : []).map((g) => `
    <li><span class="mono">${esc(g.from || '?')} -&gt; ${esc(g.to || '?')}</span> (${esc(g.classification || 'n/a')}${g.via ? ', via ' + esc(g.via) : ''})</li>`).join('') : '';
  const ppSources = pp ? (pp.retrieval_sources || []).map((srcRow) => `
    <li><span class="mono">${esc(srcRow.source)}</span> - ${esc(srcRow.classification)}</li>`).join('') : '';
  const ppMcp = pp ? (pp.mcp_surface || []).map((srv) => `<span class="mono">${esc(srv.name)}${srv.pinned ? ' (pinned)' : ''}</span>`).join(' · ') : '';
  const passportSection = pp ? `
  <h2>Agent identity passport</h2>
  <p class="sub small">A signature-covered map of who acted, on which models and vendor surface, through what delegation graph, over which retrieval sources. Identity: ${esc(pp.identity_status || 'n/a')} &middot; Provenance: ${esc(pp.provenance_status || 'n/a')}.</p>
  ${(pp.agents || []).length ? `<h3 class="small">Agents</h3><table><thead><tr><th>Agent</th><th>Credential</th><th>Scopes</th><th>Attested</th></tr></thead><tbody>${ppAgents}</tbody></table>` : ''}
  ${(pp.models || []).length ? `<h3 class="small">Models</h3><table><thead><tr><th>Model</th><th>Pin</th><th>Provider</th></tr></thead><tbody>${ppModels}</tbody></table>` : ''}
  ${ppMcp ? `<p class="small"><strong>MCP / vendor surface:</strong> ${ppMcp}</p>` : ''}
  ${ppEdges ? `<h3 class="small">Delegation graph</h3><ul class="small">${ppEdges}</ul>` : ''}
  ${ppSources ? `<h3 class="small">Retrieval sources</h3><ul class="small">${ppSources}</ul>` : ''}
  <p class="small" style="color:var(--muted)">Standards mapped (descriptive cross-reference, not a certification): ${esc((pp.standards || []).join(' · '))}</p>` : '';

  // Sub-processors observed (OFFER #8). The signature-covered enumeration of the
  // models / providers / MCP-or-vendor servers / egress hosts the audited agents
  // actually touched in the supplied window. Guard a legacy envelope (built before
  // this field existed) by deriving from the result; pure / never-throws. When
  // every count is 0 we render the untested-style line, never a clean empty list.
  const inv = e.subprocessor_inventory && typeof e.subprocessor_inventory === 'object'
    ? e.subprocessor_inventory
    : buildSubprocessorInventory(e);
  const invCounts = inv && inv.counts ? inv.counts : { models: 0, providers: 0, mcp_servers: 0, hosts: 0, sensitive_hosts: 0 };
  const invTotal = (invCounts.models || 0) + (invCounts.providers || 0) + (invCounts.mcp_servers || 0) + (invCounts.hosts || 0);
  const invCaveats = (inv && Array.isArray(inv.caveats) ? inv.caveats : []).map((c) => `<li>${esc(c)}</li>`).join('');
  const invModelRows = (inv && Array.isArray(inv.models) ? inv.models : []).map((m) => `
    <tr><td class="mono">${esc(m.slug)}</td><td>${esc(m.provider || 'unknown')}</td><td>${m.pinned ? 'pinned' : 'unpinned'}</td><td>${esc(m.calls)}</td></tr>`).join('');
  const invProviderRows = (inv && Array.isArray(inv.providers) ? inv.providers : []).map((p) => `
    <tr><td>${esc(p.name)}${p.gateway ? ' <span class="small" style="color:var(--muted)">(routed via gateway)</span>' : ''}</td><td>${esc(p.calls)}</td><td>${esc(p.models)}</td></tr>`).join('');
  const invMcpRows = (inv && Array.isArray(inv.mcp_servers) ? inv.mcp_servers : []).map((srv) => `
    <tr><td class="mono">${esc(srv.name)}</td><td>${srv.pinned ? 'pinned' : 'unpinned'}</td><td>${esc(srv.calls)}</td></tr>`).join('');
  const invHostRows = (inv && Array.isArray(inv.hosts) ? inv.hosts : []).map((h) => `
    <tr><td class="mono">${esc(h.host)}</td><td>${esc(h.call_count)}</td><td>${h.sensitivity_flag ? 'sensitive content observed' : ' - '}</td></tr>`).join('');
  const invSummaryLine = `${esc(invCounts.models || 0)} models, ${esc(invCounts.providers || 0)} providers, ${esc(invCounts.mcp_servers || 0)} MCP servers, ${esc(invCounts.hosts || 0)} hosts (${esc(invCounts.sensitive_hosts || 0)} carried sensitive content)`;
  const subprocessorSection = invTotal === 0
    ? `
  <h2>Sub-processors observed</h2>
  <p class="sub small">Sub-processor surface: not observed in the supplied window.</p>
  <ul class="small">${invCaveats}</ul>`
    : `
  <h2>Sub-processors observed</h2>
  <p class="sub small">${invSummaryLine}. Enumerated from the supplied window; kolm maps the surface the logs evidenced, it does not certify the list is complete.</p>
  ${invModelRows ? `<h3 class="small">Models</h3><table><thead><tr><th>Model</th><th>Provider</th><th>Pin</th><th>Calls</th></tr></thead><tbody>${invModelRows}</tbody></table>` : ''}
  ${invProviderRows ? `<h3 class="small">Providers</h3><table><thead><tr><th>Provider</th><th>Calls</th><th>Models</th></tr></thead><tbody>${invProviderRows}</tbody></table>` : ''}
  ${invMcpRows ? `<h3 class="small">MCP / vendor servers</h3><table><thead><tr><th>Server</th><th>Pin</th><th>Calls</th></tr></thead><tbody>${invMcpRows}</tbody></table>` : ''}
  ${invHostRows ? `<h3 class="small">Egress hosts</h3><table><thead><tr><th>Host</th><th>Calls</th><th>Sensitivity</th></tr></thead><tbody>${invHostRows}</tbody></table>` : ''}
  <ul class="small">${invCaveats}</ul>`;

  // Detached + bound evidence lines for the signature box.
  const ed = e.evidence_digest && typeof e.evidence_digest === 'object' ? e.evidence_digest : null;
  const te = e.timestamp_evidence && typeof e.timestamp_evidence === 'object' ? e.timestamp_evidence : null;
  const cp = e.log_checkpoint && typeof e.log_checkpoint === 'object' ? e.log_checkpoint : null;
  const edLine = ed ? `<div><span class="k">input-evidence digest:</span> <span class="mono">${esc(ed.alg)}:${esc(ed.value)}</span> <span class="small">(${esc(ed.event_count)} event(s), signature-covered)</span></div>` : '';
  const teLine = te ? `<div><span class="k">trusted timestamp:</span> <span class="mono">${te.status === 'timestamped' ? esc(te.timestamp || '') + ' via ' + esc(te.tsa_url || te.source || '') : 'offline (additive evidence absent)'}</span></div>` : '';
  const cpLine = cp ? `<div><span class="k">transparency log:</span> <span class="mono">seq ${esc(cp.seq)} of ${esc(cp.tree_size)}, root ${esc(String(cp.root_hash || '').slice(0, 16))}</span></div>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Agent Security-Review Readiness Report - ${esc(e.subject ? e.subject.name : '')}</title>
<style>
  :root{--ink:#0b0e14;--muted:#5b6472;--rule:#e3e7ee;--paper:#ffffff;--panel:#f7f9fc;}
  *{box-sizing:border-box}
  body{font:15px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:linear-gradient(180deg,#f4f7fb 0%,#ffffff 420px) no-repeat,var(--paper);margin:0;padding:40px;max-width:920px;margin-inline:auto}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.01em}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:var(--ink);margin:36px 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule)}
  h3.small{text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:14px 0 4px}
  .sub{color:var(--muted);margin:0 0 24px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .small{font-size:12px}
  .verdict{color:#fff;border-radius:2px;padding:14px 18px;margin:0 0 14px;font-weight:600;font-size:15px;line-height:1.45}
  .locked-panel{background:var(--panel);border:1px solid var(--rule);border-left:3px solid #5b6472;border-radius:2px;color:#2a2f3a;padding:13px 16px;margin:0 0 14px;font-size:13px;line-height:1.5}
  .headline{display:flex;gap:28px;align-items:baseline;flex-wrap:wrap;background:var(--panel);border:1px solid var(--rule);border-radius:2px;border-top:2px solid var(--ink);padding:20px 24px;margin:0 0 8px}
  .headline .big{font-size:40px;font-weight:700;letter-spacing:-.02em}
  .headline .small{text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
  .grade-nudge{text-transform:none;letter-spacing:0;max-width:230px;margin-top:4px;color:var(--muted)}
  .verify-cta{align-self:center;margin-left:auto}
  .btn-verify{display:inline-block;background:var(--ink);color:#fff;text-decoration:none;font-weight:600;font-size:13px;letter-spacing:.02em;padding:10px 18px;border-radius:2px;border:1px solid var(--ink)}
  table{width:100%;border-collapse:collapse;margin:6px 0}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule);vertical-align:top}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  .pill{color:#fff;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:600}
  .finding{border:1px solid var(--rule);border-left-width:3px;border-radius:2px;background:var(--paper);padding:12px 14px;margin:10px 0}
  .finding.sev-critical,.finding.sev-high{border-left-color:#991b1b}
  .finding.sev-medium{border-left-color:#0e7490}
  .finding.sev-low{border-left-color:#5b6472}
  .finding-head{display:flex;gap:10px;align-items:baseline}
  .finding .sev{font-size:11px;font-weight:700;letter-spacing:.06em;color:#991b1b}
  .finding.sev-medium .sev{color:#0e7490}
  .finding.sev-low .sev{color:#5b6472}
  .finding-title{font-weight:600}
  .finding-detail{margin:6px 0;color:#2a2f3a}
  .finding-fw{margin:4px 0 0;color:var(--muted);font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  .delta-head{color:#fff;border-radius:2px;padding:11px 16px;margin:0 0 10px;font-weight:600;font-size:13px;line-height:1.45}
  .rem-detail{color:var(--muted);margin-top:4px}
  .sigbox{background:var(--panel);border:1px solid var(--rule);border-radius:2px;padding:16px 18px;font-size:13px}
  .sigbox .k{color:var(--muted)}
  ul{margin:6px 0;padding-left:20px}
  footer{margin-top:40px;color:var(--muted);font-size:12px;border-top:1px solid var(--rule);padding-top:14px}
  .wm-banner{background:#991b1b;color:#fff;border-radius:2px;padding:11px 16px;margin:0 0 22px;font-weight:600;font-size:13px;line-height:1.45}
  .wm-banner .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;opacity:.9}
  body.wm::before{content:"PREVIEW";position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:165px;font-weight:800;color:rgba(153,27,27,.05);transform:rotate(-30deg);pointer-events:none;z-index:0;white-space:nowrap;letter-spacing:.06em}
  body.wm>*{position:relative;z-index:1}
  .et-banner{background:var(--panel);border:1px solid var(--rule);border-left-width:3px;border-radius:2px;padding:10px 14px;margin:0 0 18px;font-weight:600;font-size:13px}
  .et-banner .et-basis{display:block;margin-top:4px;color:var(--muted);font-weight:400;font-size:12px}
  .et-banner.et-none{font-weight:400;color:var(--muted)}
  @media print{
    body{padding:0;max-width:none;background:var(--paper)}
    h2,table,.finding,.headline,.sigbox,.et-banner,.wm-banner,.verdict,.locked-panel,.delta-head,footer{break-inside:avoid;page-break-inside:avoid}
    h1{position:static}
    body.wm::before{position:absolute}
    a[href]:after{content:" (" attr(href) ")"}
  }
</style></head>
<body class="${isWm ? 'wm' : ''}">
  <h1>Agent Security-Review Readiness Report</h1>
  <p class="sub">${esc(e.subject ? e.subject.name : '')} · generated ${esc(e.generated_at)} · <span class="mono">${esc(e.report_id)}</span></p>
  ${verdictBand}${lockedPanel}
  ${wmBanner}
  ${etBanner}

  <div class="headline">
    <div><div class="big"${tileStyle}>${esc(readiness)}</div><div class="small">readiness (assessed controls)</div></div>
    <div><div class="big"${tileStyle}>${esc(s.blocking_count ?? 0)}</div><div class="small">deal-blocking findings</div></div>
    <div><div class="big">${esc(rtScore)}</div><div class="small">red-team resistance</div></div>
    <div><div class="big">${s.tamper_evident ? 'Yes' : 'No'}</div><div class="small">tamper-evident trail</div></div>
    ${gradeTile}
    ${verifyButton}
  </div>
  ${forReviewers}

  <h2>Scope &amp; limitations</h2>
  <ul>${caveats}</ul>
  ${deltaSection}

  <h2>Control status</h2>
  <table><thead><tr><th>Control</th><th>Name</th><th>Status</th><th>Findings</th></tr></thead>
  <tbody>${controlRows}</tbody></table>
  <p class="small" style="color:var(--muted)">Not assessed in this run:</p>
  <ul class="small">${notAssessed}</ul>

  <h2>Findings</h2>
  ${findingRows || '<p class="sub">No deal-blocking or attention findings in the assessed controls.</p>'}
  ${rtSection}
  ${passportSection}
  ${subprocessorSection}

  <h2>Remediation roadmap</h2>
  ${remediation ? `<table><thead><tr><th>Priority</th><th>Finding</th><th>Action</th><th>Frameworks</th></tr></thead><tbody>${remediation}</tbody></table>` : '<p class="sub">No remediation items.</p>'}

  <h2>Signature</h2>
  <div class="sigbox">
    <div><span class="k">algorithm:</span> <span class="mono">${esc(sig.alg || ' - ')} (${esc(sig.spec || ' - ')})</span></div>
    <div><span class="k">key fingerprint:</span> <span class="mono">${esc(sig.key_fingerprint || ' - ')}</span></div>
    <div><span class="k">signed at:</span> <span class="mono">${esc(sig.signed_at || ' - ')}</span></div>
    ${edLine}
    ${teLine}
    ${cpLine}
    <div style="margin-top:8px"><span class="k">Verify offline:</span> paste this report's JSON at <span class="mono">${esc(e.verify_url || '')}</span> - it checks the Ed25519 signature in your browser with no upload.</div>
  </div>

  <footer>kolm.ai - Agent Security Evidence · ${esc(e.schema)} ${esc(e.report_version)} · questions: ${esc(e.contact || CONTACT_EMAIL)}</footer>
</body></html>`;
}

// ---------------------------------------------------------------------------
// PDF rendering - mirrors src/assurance-case-pdf.js: lazy pdfkit, frozen
// palette (no warm colors), manual text-block layout with overflow checks,
// footer applied after content via bufferedPageRange/switchToPage.
// ---------------------------------------------------------------------------
export const PDF_COLOR = Object.freeze({
  ink: '#111111',
  muted: '#555555',
  rule: '#cccccc',
  ok: '#166534',
  warn: '#0e7490',
  bad: '#991b1b',
  info: '#1d4ed8',
});

function _statusColor(status) {
  if (status === 'pass') return PDF_COLOR.ok;
  if (status === 'attention') return PDF_COLOR.warn;
  if (status === 'blocking') return PDF_COLOR.bad;
  return PDF_COLOR.muted;
}

function _sevColor(sev) {
  if (sev === 'critical' || sev === 'high') return PDF_COLOR.bad;
  if (sev === 'medium') return PDF_COLOR.warn;
  if (sev === 'low') return PDF_COLOR.muted;
  return PDF_COLOR.muted;
}

export async function renderReportPdf(envelope, outputStream) {
  let PDFDocumentCtor;
  try {
    const mod = await import('pdfkit');
    PDFDocumentCtor = mod.default || mod;
  } catch (e) {
    const err = new Error(`pdfkit not installed - install via 'npm install pdfkit'. underlying: ${e.message}`);
    err.code = 'PDFKIT_UNAVAILABLE';
    throw err;
  }
  const e = envelope || {};
  const s = e.summary || {};
  const rt = e.red_team && typeof e.red_team === 'object' ? e.red_team : null;
  const rtSum = rt && rt.summary ? rt.summary : {};
  const rtScore = rt ? (rt.score == null ? 'n/a' : `${rt.score}/100`) : 'n/a';
  const RT_PDF_STATUS = { resisted: 'RESISTED', exposed: 'EXPOSED', untested: 'UNTESTED' };
  const _rtStatusColor = (st) => (st === 'resisted' ? PDF_COLOR.ok : st === 'exposed' ? PDF_COLOR.bad : PDF_COLOR.muted);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocumentCtor({ size: 'LETTER', margin: 54, info: {
      Title: 'Agent Security-Review Readiness Report',
      Author: 'kolm.ai',
      Subject: e.subject ? `Readiness report for ${e.subject.name}` : 'Agent Security-Review Readiness Report',
      Producer: 'kolm attestation-report-builder',
    } });
    doc.pipe(outputStream);
    outputStream.on('finish', resolve);
    outputStream.on('error', reject);
    doc.on('error', reject);

    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const rule = () => {
      const y = doc.y + 2;
      doc.strokeColor(PDF_COLOR.rule).lineWidth(0.5)
        .moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke();
      doc.moveDown(0.6);
    };
    const heading = (t) => {
      if (doc.y > 660) doc.addPage();
      doc.fillColor(PDF_COLOR.ink).font('Helvetica-Bold').fontSize(15).text(t);
      doc.moveDown(0.3);
    };

    // --- Cover ---
    doc.fillColor(PDF_COLOR.ink).font('Helvetica-Bold').fontSize(24).text('Agent Security-Review');
    doc.text('Readiness Report');
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(11).fillColor(PDF_COLOR.muted)
      .text(e.subject ? e.subject.name : '')
      .text(`generated: ${e.generated_at || 'unknown'}`)
      .text(`report id: ${e.report_id || 'unknown'}`)
      .text(`spec: ${e.spec_version || '?'} · report: ${e.report_version || '?'}`);
    if (e.watermark === true) {
      doc.moveDown(0.6);
      doc.font('Helvetica-Bold').fontSize(12).fillColor(PDF_COLOR.bad)
        .text('UNPAID PREVIEW - NOT FOR DISTRIBUTION', { width: contentWidth });
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
        .text('This free Scan snapshot is watermarked. Purchase the Signed Readiness Report for an unwatermarked, distributable copy and a shareable verify link your reviewer can check.', { width: contentWidth });
    }

    // Evidence-tier banner (signature-covered grade of the evidence quality).
    // A legacy envelope without the field renders a plain "not graded" line.
    {
      const ET_PDF_LABEL = {
        A: 'EVIDENCE TIER A - captured by kolm gateway at runtime',
        B: 'EVIDENCE TIER B - vendor logs, hash chain verified',
        C: 'EVIDENCE TIER C - vendor logs as provided',
      };
      const ET_PDF_COLOR = { A: PDF_COLOR.ok, B: PDF_COLOR.warn, C: PDF_COLOR.muted };
      const et = e.evidence_tier && typeof e.evidence_tier === 'object' ? e.evidence_tier : null;
      const etGrade = et && typeof et.grade === 'string' ? et.grade.toUpperCase() : null;
      doc.moveDown(0.6);
      if (et && ET_PDF_LABEL[etGrade]) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(ET_PDF_COLOR[etGrade])
          .text(ET_PDF_LABEL[etGrade], { width: contentWidth });
        for (const b of (Array.isArray(et.basis) ? et.basis : [])) {
          if (typeof b !== 'string' || b === '') continue;
          doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
            .text('- ' + b, { width: contentWidth });
        }
      } else {
        doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
          .text('Evidence tier: not graded (issued before tiered evidence)', { width: contentWidth });
      }
    }
    doc.moveDown(1);

    // Headline numbers.
    doc.font('Helvetica-Bold').fontSize(12).fillColor(PDF_COLOR.ink).text('Summary');
    doc.moveDown(0.2);
    const readiness = s.readiness_pct == null ? 'n/a' : `${s.readiness_pct}%`;
    doc.font('Helvetica').fontSize(11).fillColor(PDF_COLOR.ink)
      .text(`Readiness (assessed controls): ${readiness}`)
      .text(`Deal-blocking findings: ${s.blocking_count ?? 0}`)
      .text(`Red-team resistance: ${rtScore}`)
      .text(`Tamper-evident trail: ${s.tamper_evident ? 'yes' : 'no'}`)
      .text(`Total findings: ${s.total_findings ?? 0}`);
    doc.moveDown(0.8);
    rule();

    // --- Scope & limitations (scope-first: stated BEFORE any findings) ---
    heading('Scope & limitations');
    for (const c of (e.caveats || [])) {
      if (doc.y > 710) doc.addPage();
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text('• ' + c, { width: contentWidth });
      doc.moveDown(0.3);
    }
    doc.moveDown(0.2);
    rule();

    // --- Control status ---
    heading('Control status');
    for (const c of (s.controls || [])) {
      if (doc.y > 700) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink)
        .text(`${c.id} - ${c.name}`, { continued: true });
      doc.font('Helvetica-Bold').fillColor(_statusColor(c.status))
        .text(`   ${(STATUS_LABEL[c.status] || c.status || '').toString()}`);
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
        .text(`${c.findings || 0} finding(s)`);
      doc.moveDown(0.4);
    }
    if ((s.not_assessed || []).length) {
      doc.moveDown(0.2);
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink).text('Not assessed');
      for (const n of s.not_assessed) {
        if (doc.y > 720) doc.addPage();
        doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text(`${n.id} - ${n.reason}`, { width: contentWidth });
        doc.moveDown(0.2);
      }
    }
    doc.moveDown(0.4);
    rule();

    // --- Findings ---
    heading('Findings');
    const findings = e.findings || [];
    if (!findings.length) {
      doc.font('Helvetica').fontSize(10).fillColor(PDF_COLOR.muted).text('No deal-blocking or attention findings in the assessed controls.');
    }
    for (const f of findings) {
      if (doc.y > 680) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(_sevColor(f.severity))
        .text(`[${(f.severity || '').toUpperCase()}] `, { continued: true });
      doc.fillColor(PDF_COLOR.ink).text(f.title || f.id, { width: contentWidth });
      if (f.detail) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(f.detail, { width: contentWidth });
      doc.font('Helvetica').fontSize(8).fillColor(PDF_COLOR.muted)
        .text(`${f.asr ? f.asr.id + ' · ' : ''}${(f.frameworks || []).join(' · ') || 'no framework mapping'}`, { width: contentWidth });
      doc.moveDown(0.5);
    }
    doc.moveDown(0.2);
    rule();

    // --- Red-team resistance (ASR-4) ---
    if (rt) {
      heading(`Red-team resistance: ${rtScore}`);
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text(
        `Deterministic injection / agent-abuse battery (${rt.domain || 'generic'} suite) over the ingested events. ${rtSum.resisted ?? 0} resisted, ${rtSum.exposed ?? 0} exposed, ${rtSum.untested ?? 0} untested of ${rtSum.probes_total ?? 0} probes. The score is a graduated rollup over the exercised probes only; untested probes are marked, never scored as a pass. ${rtSum.benchmark_crosswalk_note || BENCHMARK_CROSSWALK_NOTE}`,
        { width: contentWidth },
      );
      doc.moveDown(0.4);
      for (const p of (rt.probes || [])) {
        if (doc.y > 690) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(10).fillColor(_sevColor(p.severity))
          .text(`[${(p.severity || '').toUpperCase()}] `, { continued: true });
        doc.fillColor(PDF_COLOR.ink).text(`${p.title || p.id}  `, { continued: true });
        doc.fillColor(_rtStatusColor(p.status)).text(RT_PDF_STATUS[p.status] || (p.status || '').toUpperCase());
        if (p.detail) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(p.detail, { width: contentWidth });
        if ((p.benchmark_refs || []).length) {
          doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text('Benchmark refs: ' + (p.benchmark_refs || []).join(' | '), { width: contentWidth });
        }
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text((p.frameworks || []).join(' · '), { width: contentWidth });
        doc.moveDown(0.4);
      }
      doc.moveDown(0.2);
      rule();
    }

    // --- Agent identity passport ---
    const pp = e.passport && typeof e.passport === 'object' ? e.passport : null;
    if (pp) {
      heading('Agent identity passport');
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted).text(
        `Who acted, on which models and vendor surface, through what delegation graph, over which retrieval sources. Identity: ${pp.identity_status || 'n/a'}; provenance: ${pp.provenance_status || 'n/a'}.`,
        { width: contentWidth },
      );
      doc.moveDown(0.3);
      for (const a of (pp.agents || [])) {
        if (doc.y > 700) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(PDF_COLOR.ink).text(`${a.agent || '(unnamed)'}${a.key_id ? ' [' + a.key_id + ']' : ''}`, { continued: true });
        doc.font('Helvetica').fillColor(a.attested ? PDF_COLOR.ok : PDF_COLOR.warn).text(`  ${a.attested ? 'attested' : 'partial'} (${(a.scopes || []).length} scope(s))`);
      }
      for (const m of (pp.models || [])) {
        if (doc.y > 710) doc.addPage();
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text(`model ${m.slug} - ${m.pinned ? 'pinned' : 'floating'} (${m.provider || 'unknown'})`, { width: contentWidth });
      }
      for (const g of ((pp.delegation_graph && pp.delegation_graph.edges) || [])) {
        if (doc.y > 710) doc.addPage();
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text(`delegation ${g.from || '?'} -> ${g.to || '?'} (${g.classification || 'n/a'})`, { width: contentWidth });
      }
      for (const srcRow of (pp.retrieval_sources || [])) {
        if (doc.y > 710) doc.addPage();
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text(`retrieval ${srcRow.source} - ${srcRow.classification}`, { width: contentWidth });
      }
      doc.font('Helvetica').fontSize(8).fillColor(PDF_COLOR.muted).text(`Standards (descriptive cross-reference, not a certification): ${(pp.standards || []).join(', ')}`, { width: contentWidth });
      doc.moveDown(0.2);
      rule();
    }

    // --- Remediation ---
    heading('Remediation roadmap');
    const rem = e.remediation || [];
    if (!rem.length) doc.font('Helvetica').fontSize(10).fillColor(PDF_COLOR.muted).text('No remediation items.');
    for (const r of rem) {
      if (doc.y > 690) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF_COLOR.ink).text(`${r.priority} - ${r.title}`, { width: contentWidth });
      doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(r.action, { width: contentWidth });
      if ((r.frameworks || []).length) {
        doc.font('Courier').fontSize(8).fillColor(PDF_COLOR.muted).text((r.frameworks || []).join(', '), { width: contentWidth });
      }
      doc.moveDown(0.4);
    }
    doc.moveDown(0.2);
    rule();

    // --- Signature block ---
    heading('Signature');
    const sig = e.signature_ed25519 || {};
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink)
      .text(`algorithm: ${sig.alg || ' - '} (${sig.spec || ' - '})`)
      .text(`key fingerprint: ${sig.key_fingerprint || ' - '}`)
      .text(`signed at: ${sig.signed_at || ' - '}`);
    const ed = e.evidence_digest && typeof e.evidence_digest === 'object' ? e.evidence_digest : null;
    if (ed) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(`input-evidence digest: ${ed.alg}:${ed.value} (${ed.event_count} event(s), signature-covered)`, { width: contentWidth });
    const te = e.timestamp_evidence && typeof e.timestamp_evidence === 'object' ? e.timestamp_evidence : null;
    if (te) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(`trusted timestamp: ${te.status === 'timestamped' ? (te.timestamp || '') + ' via ' + (te.tsa_url || te.source || '') : 'offline (additive evidence absent)'}`, { width: contentWidth });
    const cp = e.log_checkpoint && typeof e.log_checkpoint === 'object' ? e.log_checkpoint : null;
    if (cp) doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.ink).text(`transparency log: seq ${cp.seq} of ${cp.tree_size}, root ${String(cp.root_hash || '').slice(0, 16)}`, { width: contentWidth });
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9).fillColor(PDF_COLOR.muted)
      .text(`Verify offline by pasting this report's JSON at ${e.verify_url || ''} - the Ed25519 signature is checked in the browser with no upload. Questions: ${e.contact || CONTACT_EMAIL}.`, { width: contentWidth });

    // --- Footer on every page ---
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      if (e.watermark === true) {
        doc.save();
        doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
        doc.font('Helvetica-Bold').fontSize(96).fillColor(PDF_COLOR.bad, 0.06)
          .text('PREVIEW', 0, doc.page.height / 2 - 60, { align: 'center', width: doc.page.width });
        doc.restore();
      }
      const bottom = doc.page.height - 36;
      doc.font('Helvetica').fontSize(8).fillColor(PDF_COLOR.muted).text(
        `kolm.ai - Agent Security Evidence - ${e.report_id || ''} - page ${i + 1 - range.start} of ${range.count}`,
        doc.page.margins.left, bottom,
        { align: 'center', width: contentWidth },
      );
    }

    doc.end();
  });
}

export default buildAndSignReport;
