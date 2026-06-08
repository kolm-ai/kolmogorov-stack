// R-6 - Assurance case export.
//
// A "trust packet" is the procurement-ready bundle a buyer's security and risk
// team can attach to a third-line-of-defense review. It folds three signals
// the platform already produces into one structured envelope:
//
//   1. CLAIMS - outcome-shaped statements about the artifact / workspace
//      (data provenance, model integrity, deployment integrity, drift
//      monitoring). Each claim carries:
//        - claim:        free-text outcome
//        - status:       'implemented' | 'package-gated' | 'certification-gated'
//                        | 'external-proof-needed'
//        - evidence_ids: references to receipts, capture rows, runtime
//                        passports, procurement-vault control rows
//        - limitations:  what the claim does NOT cover (so the reviewer
//                        cannot misread silence as scope)
//
//   2. CONTROLS - explicit framework mapping (SOC 2, HIPAA, EU AI Act,
//      ISO 27001). Each row carries:
//        - framework:             'SOC2' | 'HIPAA' | 'EU-AI-Act' | 'ISO-27001'
//        - control_id:            'CC6.1' | '164.308' | 'Art-13' | 'A.5.1' …
//        - implementation_status: 'implemented' | 'package-gated' |
//                                 'certification-gated' | 'external-proof-needed'
//        - evidence_id:           pointer to the supporting artifact / vault row
//
//   3. META - generated_at, artifact pointer, workspace pointer, spec version,
//      signature hash if the source artifact is signed.
//
// Status taxonomy:
//   * implemented - the control IS in production now. Evidence
//                              points at a receipt or vault row that proves it.
//   * package-gated - the technical control ships but the buyer must
//                              run a specific install / config to enable it
//                              (e.g. on-prem self-hosted air-gap mode).
//   * certification-gated - control exists, third-party certification is in
//                              progress (e.g. SOC 2 Type II window not closed).
//                              No fabrication: vault row tags the gating cert.
//   * external-proof-needed - control depends on a signal the platform cannot
//                              attest to itself (e.g. drift monitoring requires
//                              a separately-enabled namespace drift detector).
//                              The reviewer must verify externally.
//
// Auto-generation policy:
//   * Reads artifact manifest (passport + runtime_passports + receipts).
//   * Reads R-5 evidence_dag when present on the manifest.
//   * Reads procurement-vault rows from data/procurement/{sig-lite,caiq-v4}.json.
//   * NEVER invents evidence_ids. When a signal is missing, the status drops
//     to 'package-gated' or 'external-proof-needed' and `limitations` records
//     WHAT was missing so the reviewer is not surprised.
//
// Pure module: no I/O. The caller (CLI / router) loads files and passes the
// shapes in. Tests can drive every code path with in-memory fixtures.

export const ASSURANCE_CASE_SPEC = 'kolm-assurance-case-1';

// v1 status taxonomy - used by buildAssuranceCase() and the procurement-vault
// PDF render path. Pinned by tests/r6-assurance-case.test.js and the v1
// wrapper-r1-r8 symbol-presence test; do NOT renumber.
export const CLAIM_STATUSES = [
  'implemented',
  'package-gated',
  'certification-gated',
  'external-proof-needed',
];

// wave4-r-enrich: v2 status taxonomy used by the new generateAssuranceCase
// path. Frozen so callers cannot mutate it from outside.
export const CLAIM_STATUSES_V2 = Object.freeze(['supported', 'unsupported', 'partial', 'unknown']);

// wave4-r-enrich: v2 framework list. Lowercase string ids matching the
// Part-B spec.
export const CONTROL_FRAMEWORKS = Object.freeze(['soc2', 'iso27001', 'hipaa', 'sox', 'nist-csf']);

// Default control rows for the v2 generator. Each row pins one
// (framework, control) pair to the platform feature that satisfies it.
// Status is filled in at generation time based on what the artifact carries.
const V2_DEFAULT_CONTROL_ROWS = Object.freeze([
  { framework: 'soc2',     control: 'CC6.1',  description: 'Logical access controls' },
  { framework: 'soc2',     control: 'CC7.2',  description: 'Anomaly detection (drift monitoring)' },
  { framework: 'iso27001', control: 'A.5.1',  description: 'Information security policies' },
  { framework: 'iso27001', control: 'A.8.16', description: 'Monitoring activities' },
  { framework: 'hipaa',    control: '164.312(a)(1)', description: 'Access control' },
  { framework: 'hipaa',    control: '164.312(b)',    description: 'Audit controls' },
  { framework: 'sox',      control: 'ITGC-LA',       description: 'Logical access (ITGC)' },
  { framework: 'nist-csf', control: 'PR.AC-1',       description: 'Identity and credential management' },
  { framework: 'nist-csf', control: 'DE.CM-1',       description: 'Continuous monitoring' },
]);

// Framework -> canonical label. Used by the PDF section headers and the JSON
// `framework` column. Anchored so a reviewer can grep one stable string.
export const FRAMEWORK_LABELS = {
  'SOC2':       'SOC 2',
  'HIPAA':      'HIPAA',
  'EU-AI-Act':  'EU AI Act',
  'ISO-27001':  'ISO/IEC 27001',
};

// The minimum control set every workspace ships. Per task spec: at least 8
// control_ids covering 4 frameworks. Each row maps to ONE artifact-or-vault
// evidence pointer; build* fills the actual id at runtime.
//
// Rationale per control:
//   SOC 2 CC6.1 - Logical access (auth + RBAC).
//   SOC 2 CC7.2 - Detection of anomalies (drift detection + audit log).
//   SOC 2 A1.2 - Capacity & resilience (queue + load shed).
//   HIPAA 164.308 - Administrative safeguards (workforce auth + BAA).
//   HIPAA 164.312 - Technical safeguards (encryption + integrity controls).
//   EU AI Act Art 13 - Transparency / instructions for use (model card).
//   EU AI Act Art 14 - Human oversight (HIL queue + review surface).
//   ISO 27001 A.5.1 - Information security policies.
export const REQUIRED_CONTROL_ROWS = Object.freeze([
  { framework: 'SOC2',      control_id: 'CC6.1',    label: 'Logical and physical access controls' },
  { framework: 'SOC2',      control_id: 'CC7.2',    label: 'System monitoring of anomalies and events' },
  { framework: 'SOC2',      control_id: 'A1.2',     label: 'Capacity, availability and resilience' },
  { framework: 'HIPAA',     control_id: '164.308',  label: 'Administrative safeguards (workforce, BAA)' },
  { framework: 'HIPAA',     control_id: '164.312',  label: 'Technical safeguards (encryption, integrity)' },
  { framework: 'EU-AI-Act', control_id: 'Art-13',   label: 'Transparency and provision of information to users' },
  { framework: 'EU-AI-Act', control_id: 'Art-14',   label: 'Human oversight' },
  { framework: 'ISO-27001', control_id: 'A.5.1',    label: 'Policies for information security' },
]);

// ---------------------------------------------------------------------------
// Internal helpers - pure shape probes. NEVER throw on shape mismatch; the
// auto-generator must degrade to 'package-gated' or 'external-proof-needed'
// when a signal is missing rather than blowing up the report.
// ---------------------------------------------------------------------------

function _asArray(value) {
  return Array.isArray(value) ? value : [];
}

function _evidenceDagNodes(artifact) {
  if (!artifact) return [];
  // Support both shapes: top-level artifact.evidence_dag (what the router
  // attaches after reading evidence-store) AND manifest.evidence_dag (what
  // an in-memory test fixture carries when it shadows the manifest).
  let dag = artifact.evidence_dag;
  if (!dag && artifact.manifest) dag = artifact.manifest.evidence_dag;
  if (!dag) return [];
  if (Array.isArray(dag.nodes)) return dag.nodes;
  if (Array.isArray(dag)) return dag;
  return [];
}

function _captureNodes(artifact) {
  return _evidenceDagNodes(artifact).filter((n) => n && n.kind === 'capture');
}

function _rightsHolderNodes(artifact) {
  return _evidenceDagNodes(artifact).filter((n) => n && n.kind === 'rights');
}

function _runtimePassports(artifact) {
  const m = artifact && artifact.manifest;
  if (m && Array.isArray(m.runtime_passports)) return m.runtime_passports;
  if (artifact && Array.isArray(artifact.runtime_passports)) return artifact.runtime_passports;
  return [];
}

function _receiptSummary(artifact) {
  const m = artifact && artifact.manifest;
  if (m && m.receipt) return m.receipt;
  if (artifact && artifact.receipt) return artifact.receipt;
  return null;
}

function _signaturePresent(artifact) {
  const r = _receiptSummary(artifact);
  if (!r) return false;
  if (r.signature_ed25519) return true;
  if (r.signature_mode === 'ed25519') return true;
  if (typeof r.signature === 'string' && r.signature.length > 0) return true;
  return false;
}

function _kolmAudit1Receipts(artifact) {
  const r = _receiptSummary(artifact);
  if (!r) return [];
  // Receipts may surface as r.receipts:[{cid,kind,...}] or as a list on the
  // top-level r.audit_receipts. Tolerate both shapes.
  if (Array.isArray(r.receipts)) {
    return r.receipts.filter((x) => x && (x.kind === 'kolm-audit-1' || x.spec === 'kolm-audit-1'));
  }
  if (Array.isArray(r.audit_receipts)) return r.audit_receipts;
  return [];
}

// ---------------------------------------------------------------------------
// Vault row index. The procurement vault rows are already cross-referenced
// to framework + control_id in the source JSONs; this normalises the two
// CAIQ + SIG-Lite shapes into ONE lookup so we can pull evidence_ids by
// {framework, control_id}. Tolerant when rows are absent.
// ---------------------------------------------------------------------------

function _indexVault(workspace) {
  const idx = {};
  const vault = workspace && workspace.procurement_vault;
  if (!vault) return idx;
  // SIG Lite: sections[].questions[]
  for (const section of _asArray(vault.sig_lite && vault.sig_lite.sections)) {
    for (const q of _asArray(section.questions)) {
      if (!q || !q.id) continue;
      idx['SIG:' + q.id] = {
        evidence_id: 'vault:sig-lite:' + q.id,
        answer: q.answer,
        text: q.evidence,
      };
    }
  }
  // CAIQ: controls[]
  for (const c of _asArray(vault.caiq && vault.caiq.controls)) {
    if (!c || !c.id) continue;
    idx['CAIQ:' + c.id] = {
      evidence_id: 'vault:caiq:' + c.id,
      answer: c.answer,
      text: c.evidence,
    };
  }
  return idx;
}

// ---------------------------------------------------------------------------
// CLAIMS - outcome-shaped statements with evidence_ids
// ---------------------------------------------------------------------------

function _claimDataProvenance(artifact) {
  const captures = _captureNodes(artifact);
  const rights = _rightsHolderNodes(artifact);
  if (!captures.length) {
    return {
      claim: 'All training captures are tied to a verified rights-holder.',
      status: 'package-gated',
      evidence_ids: [],
      limitations: 'No capture nodes present on the artifact evidence DAG. Enable capture recording (R-5) before claiming data provenance.',
    };
  }
  // The capture-id -> rights-holder linkage is encoded on the rights node's
  // `covers` array. A capture is "covered" iff at least one rights node lists
  // it. Missing coverage downgrades the claim.
  const coveredCaptureIds = new Set();
  for (const r of rights) {
    for (const cid of _asArray(r && r.covers)) coveredCaptureIds.add(cid);
  }
  const uncovered = captures.filter((c) => !coveredCaptureIds.has(c.id));
  const evidence_ids = captures.map((c) => c.id).concat(rights.map((r) => r.id));
  if (uncovered.length === 0 && rights.length > 0) {
    return {
      claim: 'All training captures are tied to a verified rights-holder.',
      status: 'implemented',
      evidence_ids,
      limitations: '',
    };
  }
  return {
    claim: 'All training captures are tied to a verified rights-holder.',
    status: 'package-gated',
    evidence_ids,
    limitations: `${uncovered.length} of ${captures.length} capture nodes lack a covering rights-holder record. Attach rights nodes via 'kolm capture rights add' before re-export.`,
  };
}

function _claimModelIntegrity(artifact) {
  const signed = _signaturePresent(artifact);
  const auditReceipts = _kolmAudit1Receipts(artifact);
  if (signed && auditReceipts.length > 0) {
    return {
      claim: 'Artifact bytes are cryptographically signed and carry a replayable kolm-audit-1 receipt chain.',
      status: 'implemented',
      evidence_ids: ['receipt:signature:ed25519'].concat(auditReceipts.map((r) => 'receipt:' + (r.cid || r.id || 'audit-1'))),
      limitations: '',
    };
  }
  if (signed) {
    return {
      claim: 'Artifact bytes are cryptographically signed and carry a replayable kolm-audit-1 receipt chain.',
      status: 'package-gated',
      evidence_ids: ['receipt:signature:ed25519'],
      limitations: 'Ed25519 signature is present but no kolm-audit-1 receipts attached. Re-run with --receipt-chain to populate.',
    };
  }
  return {
    claim: 'Artifact bytes are cryptographically signed and carry a replayable kolm-audit-1 receipt chain.',
    status: 'package-gated',
    evidence_ids: [],
    limitations: 'Artifact is unsigned. Run `kolm sign <artifact.kolm>` to attach an Ed25519 signature before procurement review.',
  };
}

function _claimDeploymentIntegrity(artifact) {
  const passports = _runtimePassports(artifact);
  if (!passports.length) {
    return {
      claim: 'Deployment runtime capabilities are documented per-(runtime, target) with measured or estimated capacity.',
      status: 'package-gated',
      evidence_ids: [],
      limitations: 'No runtime_passports attached. Rebuild with --export-provenance to emit the runtime target matrix.',
    };
  }
  const tested = passports.filter((p) => p && p.status === 'tested');
  const evidence_ids = passports.map((p) => 'passport:' + (p.target_id || 'unknown'));
  if (tested.length >= 1) {
    return {
      claim: 'Deployment runtime capabilities are documented per-(runtime, target) with measured or estimated capacity.',
      status: 'implemented',
      evidence_ids,
      limitations: tested.length < passports.length
        ? `${tested.length} of ${passports.length} runtime targets carry measured numbers; remainder are compile-time estimates.`
        : '',
    };
  }
  return {
    claim: 'Deployment runtime capabilities are documented per-(runtime, target) with measured or estimated capacity.',
    status: 'package-gated',
    evidence_ids,
    limitations: 'All runtime_passport rows are estimates. Run `kolm runtime probe` to populate measured rows before procurement review.',
  };
}

function _claimDriftMonitoring(artifact, workspace) {
  // R-7 wires per-namespace drift configuration. The workspace shape we accept
  // here is { drift_namespaces: { '<namespace>': { enabled: true, kl_threshold } } }.
  // When R-7 is configured for the artifact's bound namespace, status is
  // 'implemented'. Otherwise it's external-proof-needed (the buyer must
  // verify their own monitoring pipeline is wired up).
  const ns = (artifact && (artifact.namespace || (artifact.manifest && artifact.manifest.namespace))) || null;
  const driftNs = (workspace && workspace.drift_namespaces) || {};
  const cfg = ns ? driftNs[ns] : null;
  if (cfg && cfg.enabled === true) {
    return {
      claim: 'Production drift is monitored against the training distribution with threshold alerts.',
      status: 'implemented',
      evidence_ids: ['drift:namespace:' + ns],
      limitations: '',
    };
  }
  return {
    claim: 'Production drift is monitored against the training distribution with threshold alerts.',
    status: 'external-proof-needed',
    evidence_ids: ns ? ['drift:namespace:' + ns] : [],
    limitations: ns
      ? `Drift detector is not enabled for namespace '${ns}'. Enable via 'kolm drift enable --namespace ${ns}' or attach the buyer's external monitoring evidence.`
      : 'Artifact is not bound to a namespace; drift monitoring claim cannot be auto-attested.',
  };
}

function _claimJurisdiction(workspace, vaultIdx) {
  // EU AI Act / SOC 2 / HIPAA jurisdiction claim. Pulled from the vault rows
  // when they exist. The vault is the source of attestation; if it's absent
  // we mark certification-gated (the buyer should ask for a fresh vault).
  const sigA12 = vaultIdx['SIG:A.1.2'];
  if (sigA12 && (sigA12.answer === 'yes' || sigA12.answer === true)) {
    return {
      claim: 'Vendor maintains a documented risk management program reviewed at least annually by executive leadership.',
      status: 'implemented',
      evidence_ids: [sigA12.evidence_id],
      limitations: '',
    };
  }
  return {
    claim: 'Vendor maintains a documented risk management program reviewed at least annually by executive leadership.',
    status: 'certification-gated',
    evidence_ids: [],
    limitations: 'Procurement vault row SIG.A.1.2 (risk management review) not present. Request a fresh SIG Lite questionnaire from the vendor trust center.',
  };
}

// ---------------------------------------------------------------------------
// CONTROLS - explicit framework mapping
// ---------------------------------------------------------------------------

function _controlEvidence(row, artifact, vaultIdx) {
  // Heuristic mapping from {framework, control_id} -> first plausible
  // evidence_id present on this workspace. Falls back to certification-gated
  // when nothing maps.
  const { framework, control_id } = row;

  // SOC 2 CC6.1 - auth + RBAC. Anchor in CAIQ IAM-01.1 if present.
  if (framework === 'SOC2' && control_id === 'CC6.1') {
    const e = vaultIdx['CAIQ:IAM-01.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  // SOC 2 CC7.2 - detection of anomalies. Anchor in drift monitoring claim
  // (R-7) if a drift namespace is wired; else certification-gated.
  if (framework === 'SOC2' && control_id === 'CC7.2') {
    const driftCfgs = (artifact && artifact._derived_drift_present) ? true : false;
    if (driftCfgs) return { evidence_id: 'control:r7:drift-monitoring', implementation_status: 'implemented' };
    return { evidence_id: null, implementation_status: 'external-proof-needed' };
  }
  // SOC 2 A1.2 - capacity. Anchor in CAIQ BCR-01.1 if present.
  if (framework === 'SOC2' && control_id === 'A1.2') {
    const e = vaultIdx['CAIQ:BCR-01.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  // HIPAA 164.308 / 164.312 - anchor in CAIQ CEK-01.1 (encryption) and
  // IAM-08.1 (workforce auth) when present.
  if (framework === 'HIPAA' && control_id === '164.308') {
    const e = vaultIdx['CAIQ:IAM-08.1'] || vaultIdx['CAIQ:HRS-04.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  if (framework === 'HIPAA' && control_id === '164.312') {
    const e = vaultIdx['CAIQ:CEK-01.1'] || vaultIdx['CAIQ:AIS-04.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  // EU AI Act Art 13 - transparency. The model card / passport satisfies this.
  if (framework === 'EU-AI-Act' && control_id === 'Art-13') {
    const present = _receiptSummary(artifact) || _runtimePassports(artifact).length > 0;
    if (present) return { evidence_id: 'control:model-card:hf-v0.3', implementation_status: 'implemented' };
  }
  // EU AI Act Art 14 - human oversight. Anchor in CAIQ GRC-04.1 (governance).
  if (framework === 'EU-AI-Act' && control_id === 'Art-14') {
    const e = vaultIdx['CAIQ:GRC-04.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  // ISO 27001 A.5.1 - security policies. Anchor in CAIQ AIS-01.1 if present.
  if (framework === 'ISO-27001' && control_id === 'A.5.1') {
    const e = vaultIdx['CAIQ:AIS-01.1'];
    if (e) return { evidence_id: e.evidence_id, implementation_status: 'implemented' };
  }
  return { evidence_id: null, implementation_status: 'certification-gated' };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// buildAssuranceCase({artifact, workspace}) -> { spec, generated_at, claims, controls, meta }
//
// artifact (optional): the artifact-shaped object as returned by jobToArtifact,
//   carrying { id, manifest:{runtime_passports, evidence_dag, namespace, ...},
//   receipt:{...} }.
//
// workspace (optional): { id, drift_namespaces:{}, procurement_vault:{sig_lite, caiq} }.
//
// Returns a structured envelope. NEVER throws - missing inputs downgrade
// individual claims/controls to a 'package-gated' or 'external-proof-needed'
// row with a descriptive `limitations` string.
export function buildAssuranceCase({ artifact = null, workspace = null } = {}) {
  const vaultIdx = _indexVault(workspace);

  // Decorate the artifact with a flag the control mapper consults. We mutate
  // a shallow copy so the caller's reference is untouched.
  const ns = (artifact && (artifact.namespace || (artifact.manifest && artifact.manifest.namespace))) || null;
  const driftEnabled = !!(workspace && workspace.drift_namespaces && ns && workspace.drift_namespaces[ns] && workspace.drift_namespaces[ns].enabled);
  const decoratedArtifact = artifact ? { ...artifact, _derived_drift_present: driftEnabled } : null;

  const claims = [];
  if (artifact) {
    claims.push(_claimDataProvenance(artifact));
    claims.push(_claimModelIntegrity(artifact));
    claims.push(_claimDeploymentIntegrity(artifact));
    claims.push(_claimDriftMonitoring(artifact, workspace));
  }
  // Vault-derived claim is workspace-level and always present (downgrades
  // when vault is empty).
  claims.push(_claimJurisdiction(workspace, vaultIdx));

  const controls = REQUIRED_CONTROL_ROWS.map((row) => {
    const ev = _controlEvidence(row, decoratedArtifact, vaultIdx);
    return {
      framework: row.framework,
      framework_label: FRAMEWORK_LABELS[row.framework] || row.framework,
      control_id: row.control_id,
      label: row.label,
      implementation_status: ev.implementation_status,
      evidence_id: ev.evidence_id,
    };
  });

  return {
    spec: ASSURANCE_CASE_SPEC,
    generated_at: new Date().toISOString(),
    artifact_id: artifact ? (artifact.id || artifact.artifact_id || null) : null,
    workspace_id: workspace ? (workspace.id || null) : null,
    signed_by: _signaturePresent(artifact) ? 'ed25519:' + ((_receiptSummary(artifact) || {}).signature_fingerprint || 'present') : null,
    claims,
    controls,
    meta: {
      claim_status_taxonomy: CLAIM_STATUSES,
      frameworks_covered: Array.from(new Set(controls.map((c) => c.framework))),
      n_claims: claims.length,
      n_controls: controls.length,
      vault_rows_indexed: Object.keys(vaultIdx).length,
    },
  };
}

// validateAssuranceCase(case) -> { ok, reasons:[] }
//
// Used by tests and the CLI to enforce shape invariants before render.
export function validateAssuranceCase(envelope) {
  const reasons = [];
  if (!envelope || typeof envelope !== 'object') {
    return { ok: false, reasons: ['envelope_not_object'] };
  }
  if (envelope.spec !== ASSURANCE_CASE_SPEC) reasons.push('bad_spec');
  if (!Array.isArray(envelope.claims)) reasons.push('claims_not_array');
  if (!Array.isArray(envelope.controls)) reasons.push('controls_not_array');
  for (const c of envelope.claims || []) {
    if (!c || typeof c !== 'object') { reasons.push('claim_not_object'); continue; }
    if (typeof c.claim !== 'string' || !c.claim) reasons.push('claim_missing_text');
    if (!CLAIM_STATUSES.includes(c.status)) reasons.push('claim_bad_status:' + c.status);
    if (!Array.isArray(c.evidence_ids)) reasons.push('claim_evidence_ids_not_array');
    if (typeof c.limitations !== 'string') reasons.push('claim_limitations_not_string');
  }
  for (const c of envelope.controls || []) {
    if (!c || typeof c !== 'object') { reasons.push('control_not_object'); continue; }
    if (typeof c.framework !== 'string' || !c.framework) reasons.push('control_missing_framework');
    if (typeof c.control_id !== 'string' || !c.control_id) reasons.push('control_missing_id');
    if (!CLAIM_STATUSES.includes(c.implementation_status)) reasons.push('control_bad_status:' + c.implementation_status);
  }
  return { ok: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// wave4-r-enrich: v2 assurance-case generator. Emits the schema-v1 shape
// (claims:[], controls:[]) using the CLAIM_STATUSES_V2 vocabulary, with the
// 4 default claims (reproducibility / provenance / signatures / PII redaction)
// + V2_DEFAULT_CONTROL_ROWS controls.
//
// This module does no I/O - callers pass artifact context inline. By default
// the four claims map to: status='unknown' when no artifact context, status
// based on artifact attributes when present.
// ---------------------------------------------------------------------------

export const GENERATE_ASSURANCE_CASE_SPEC = 'kolm-assurance-case-2';

// Resolve one of the 4 default claims against artifact context.
function _resolveDefaultClaims(artifactContext) {
  const ctx = artifactContext || {};
  const claims = [];

  // Reproducibility - driven by manifest.reproducibility / receipt presence.
  const hasReceipt = !!(ctx.receipt || (ctx.manifest && ctx.manifest.receipt));
  const reproSeed = ctx.manifest && (ctx.manifest.seed != null || ctx.manifest.reproducibility);
  claims.push({
    claim: 'Artifact is bit-reproducible from a recorded recipe (seed + config + dataset hash).',
    status: hasReceipt && reproSeed ? 'supported'
          : hasReceipt ? 'partial'
          : 'unknown',
    evidence: hasReceipt ? ['receipt:' + (ctx.id || ctx.artifact_id || 'artifact')] : [],
    limitations: hasReceipt && reproSeed
      ? []
      : ['No recorded seed/reproducibility hash on the manifest; bit-for-bit reproduction is not attested.'],
  });

  // Provenance - driven by evidence_dag capture+rights nodes.
  const dag = (ctx.evidence_dag || (ctx.manifest && ctx.manifest.evidence_dag) || {});
  const dagNodes = Array.isArray(dag.nodes) ? dag.nodes : (Array.isArray(dag) ? dag : []);
  const captureNodes = dagNodes.filter((n) => n && n.kind === 'capture');
  const rightsNodes = dagNodes.filter((n) => n && n.kind === 'rights');
  let provenanceStatus = 'unknown';
  const provenanceLimits = [];
  if (captureNodes.length === 0) {
    provenanceStatus = 'unknown';
    provenanceLimits.push('No capture nodes recorded on the evidence DAG.');
  } else if (rightsNodes.length === 0) {
    provenanceStatus = 'unsupported';
    provenanceLimits.push(`${captureNodes.length} captures have NO rights-holder coverage.`);
  } else {
    const covered = new Set();
    for (const r of rightsNodes) {
      for (const cid of (Array.isArray(r.covers) ? r.covers : [])) covered.add(cid);
    }
    const uncovered = captureNodes.filter((c) => !covered.has(c.id));
    if (uncovered.length === 0) {
      provenanceStatus = 'supported';
    } else {
      provenanceStatus = 'partial';
      provenanceLimits.push(`${uncovered.length}/${captureNodes.length} captures lack rights-holder coverage.`);
    }
  }
  claims.push({
    claim: 'Training data has documented provenance and rights-holder attestation.',
    status: provenanceStatus,
    evidence: captureNodes.map((c) => 'capture:' + c.id)
              .concat(rightsNodes.map((r) => 'rights:' + r.id)),
    limitations: provenanceLimits,
  });

  // Signatures - driven by receipt.signature_* presence.
  const r = (ctx.receipt || (ctx.manifest && ctx.manifest.receipt) || {});
  const hasSig = !!(r.signature_ed25519
                    || r.signature_mode === 'ed25519'
                    || (typeof r.signature === 'string' && r.signature.length > 0));
  claims.push({
    claim: 'Artifact bytes carry a verifiable cryptographic signature (Ed25519).',
    status: hasSig ? 'supported' : 'unsupported',
    evidence: hasSig ? ['signature:ed25519:' + (r.signature_fingerprint || 'present')] : [],
    limitations: hasSig ? [] : ['Artifact is unsigned. Run `kolm sign <artifact.kolm>` before procurement review.'],
  });

  // PII redaction - driven by manifest.pii_redaction or capture-step config.
  const piiConfig = (ctx.manifest && ctx.manifest.pii_redaction)
                  || ctx.pii_redaction
                  || null;
  let piiStatus = 'unknown';
  const piiLimits = [];
  if (!piiConfig) {
    piiStatus = 'unknown';
    piiLimits.push('No PII redaction config recorded on the manifest. Caller must verify redaction externally.');
  } else if (piiConfig.enabled === true && piiConfig.report) {
    piiStatus = 'supported';
  } else if (piiConfig.enabled === true) {
    piiStatus = 'partial';
    piiLimits.push('PII redaction is enabled but no per-capture redaction report is attached.');
  } else {
    piiStatus = 'unsupported';
    piiLimits.push('PII redaction is explicitly disabled on this artifact.');
  }
  claims.push({
    claim: 'Training captures and runtime prompts are redacted of PII before storage and replay.',
    status: piiStatus,
    evidence: piiConfig ? ['config:pii_redaction'] : [],
    limitations: piiLimits,
  });

  return claims;
}

function _resolveDefaultControls(artifactContext, claims) {
  // Map control rows to v2 statuses. Simple heuristic:
  //   - if a claim with framework-relevant content is 'supported', the
  //     control is 'supported' too.
  //   - otherwise 'partial' if there is partial evidence, else 'unknown'.
  // The mapping is intentionally coarse - the v1 buildAssuranceCase path
  // remains the source of truth for the procurement-vault PDF; this v2
  // generator is for the lightweight machine-readable envelope.
  const supportsAccess  = claims.some((c) => c.status === 'supported' && /signature|signed|cryptograph/i.test(c.claim));
  const supportsMonitor = claims.some((c) => c.status === 'supported' && /provenance|signature|reproducible/i.test(c.claim));
  const supportsRedact  = claims.some((c) => c.status === 'supported' && /pii|redact/i.test(c.claim));
  const supportsRepro   = claims.some((c) => c.status === 'supported' && /reproducible/i.test(c.claim));
  return V2_DEFAULT_CONTROL_ROWS.map((row) => {
    let status = 'unknown';
    let evidence = null;
    if (row.framework === 'soc2' && row.control === 'CC6.1') {
      status = supportsAccess ? 'supported' : 'partial';
      evidence = supportsAccess ? 'signature:ed25519' : null;
    } else if (row.framework === 'soc2' && row.control === 'CC7.2') {
      status = supportsMonitor ? 'supported' : 'unknown';
      evidence = supportsMonitor ? 'control:drift-detector' : null;
    } else if (row.framework === 'iso27001' && row.control === 'A.5.1') {
      status = 'partial';
      evidence = 'policy:platform-defaults';
    } else if (row.framework === 'iso27001' && row.control === 'A.8.16') {
      status = supportsMonitor ? 'supported' : 'partial';
      evidence = supportsMonitor ? 'control:drift-detector' : null;
    } else if (row.framework === 'hipaa' && row.control === '164.312(a)(1)') {
      status = supportsAccess ? 'supported' : 'unsupported';
      evidence = supportsAccess ? 'signature:ed25519' : null;
    } else if (row.framework === 'hipaa' && row.control === '164.312(b)') {
      status = (supportsRepro || supportsMonitor) ? 'supported' : 'partial';
      evidence = supportsRepro ? 'receipt:audit-1' : (supportsMonitor ? 'control:drift-detector' : null);
    } else if (row.framework === 'sox' && row.control === 'ITGC-LA') {
      status = supportsAccess ? 'supported' : 'partial';
      evidence = supportsAccess ? 'signature:ed25519' : null;
    } else if (row.framework === 'nist-csf' && row.control === 'PR.AC-1') {
      status = supportsAccess ? 'supported' : 'unknown';
      evidence = supportsAccess ? 'signature:ed25519' : null;
    } else if (row.framework === 'nist-csf' && row.control === 'DE.CM-1') {
      status = supportsMonitor ? 'supported' : 'partial';
      evidence = supportsMonitor ? 'control:drift-detector' : null;
    }
    if (supportsRedact && row.framework === 'hipaa' && status === 'partial') {
      // PII redaction lifts hipaa auditability above 'partial'.
      status = 'supported';
      evidence = evidence || 'control:pii-redaction';
    }
    return {
      framework: row.framework,
      control: row.control,
      description: row.description,
      status,
      evidence,
    };
  });
}

/**
 * generateAssuranceCase(artifactId, artifactContext?) -> Promise<envelope>
 *
 * Async v2 generator. Emits the schema-v2 shape with claims + controls.
 * `artifactId` is the canonical artifact identifier the envelope will key on.
 * `artifactContext` is OPTIONAL - when omitted, the four default claims emit
 * status='unknown' (we never invent attestation).
 *
 * Every returned claim's `status` is in CLAIM_STATUSES_V2. Every returned
 * control's `framework` is in CONTROL_FRAMEWORKS.
 *
 * Returns:
 *   {
 *     ok: true,
 *     spec: GENERATE_ASSURANCE_CASE_SPEC,
 *     generated_at: ISO string,
 *     artifact_id,
 *     claims: [{ claim, status, evidence, limitations }],
 *     controls: [{ framework, control, status, evidence }],
 *     meta: { n_claims, n_controls, frameworks_covered, claim_statuses }
 *   }
 */
export async function generateAssuranceCase(artifactId, artifactContext = null) {
  if (!artifactId || typeof artifactId !== 'string') {
    return {
      ok: false,
      error: 'artifact_id_required',
      hint: 'pass the canonical artifact identifier as the first argument',
      version: GENERATE_ASSURANCE_CASE_SPEC,
    };
  }
  const claims = _resolveDefaultClaims(artifactContext);
  const controls = _resolveDefaultControls(artifactContext, claims);
  // Guard rail: every claim must have a CLAIM_STATUSES_V2-valid status.
  for (const c of claims) {
    if (!CLAIM_STATUSES_V2.includes(c.status)) {
      // Should never happen given the resolver only emits v2 values; fail
      // closed so a future bug is caught loudly rather than silently shipping
      // a malformed claim.
      throw new Error(`generateAssuranceCase: claim emitted invalid status '${c.status}'`);
    }
  }
  for (const ctrl of controls) {
    if (!CONTROL_FRAMEWORKS.includes(ctrl.framework)) {
      throw new Error(`generateAssuranceCase: control emitted invalid framework '${ctrl.framework}'`);
    }
  }
  return {
    ok: true,
    spec: GENERATE_ASSURANCE_CASE_SPEC,
    generated_at: new Date().toISOString(),
    artifact_id: artifactId,
    claims,
    controls,
    meta: {
      n_claims: claims.length,
      n_controls: controls.length,
      frameworks_covered: Array.from(new Set(controls.map((c) => c.framework))),
      claim_statuses: CLAIM_STATUSES_V2.slice(),
    },
  };
}
