import fs from 'node:fs';
import path from 'node:path';

export const COMPLIANCE_CERTIFICATION_SPEC = 'kolm-compliance-certification-packet-1';
export const COMPLIANCE_CERTIFICATION_MANIFEST_SPEC = 'kolm-compliance-certification-manifest-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;

export const COMPLIANCE_REQUIRED_FILES = [
  'public/security.html',
  'public/trust.html',
  'public/baa.html',
  'public/privacy.html',
  'public/subprocessors.html',
  'docs/kolm-format-v1.md',
  'docs/compliance/SOC2-EVIDENCE.md',
  'docs/compliance/CONTROLS.md',
  '.github/workflows/sdk-c-rust.yml',
  'src/sbom-emit.js',
  'src/slsa-provenance.js',
  'src/intoto-slsa.js',
  'docs/compliance-certification-packet.md',
];

export const COMPLIANCE_CERTIFICATION_CONTROLS = [
  {
    id: 'soc2',
    label: 'SOC 2',
    live_certification_required: true,
    required_evidence_types: ['auditor_report'],
    implemented_evidence: ['docs/compliance/SOC2-EVIDENCE.md', 'docs/compliance/CONTROLS.md', 'public/security.html'],
    external_blocker: 'soc2_auditor_report_missing',
  },
  {
    id: 'iso27001',
    label: 'ISO 27001',
    live_certification_required: true,
    required_evidence_types: ['certificate', 'auditor_report'],
    implemented_evidence: ['docs/compliance/CONTROLS.md', 'public/security.html'],
    external_blocker: 'iso27001_certificate_missing',
  },
  {
    id: 'hipaa-baa',
    label: 'HIPAA BAA',
    live_certification_required: true,
    required_evidence_types: ['legal_packet', 'signed_agreement'],
    implemented_evidence: ['public/baa.html', 'docs/angle/hipaa-onepager.html', 'public/security.html'],
    external_blocker: 'signed_baa_counterparty_or_counsel_packet_missing',
  },
  {
    id: 'gdpr-dpa',
    label: 'GDPR DPA',
    live_certification_required: true,
    required_evidence_types: ['legal_packet', 'signed_agreement'],
    implemented_evidence: ['public/privacy.html', 'public/subprocessors.html'],
    external_blocker: 'gdpr_dpa_legal_review_missing',
  },
  {
    id: 'fedramp-boundary',
    label: 'FedRAMP boundary',
    live_certification_required: true,
    required_evidence_types: ['authorization_packet', 'boundary_assessment'],
    implemented_evidence: ['public/security.html', 'docs/compliance/CONTROLS.md', 'docs/kolm-format-v1.md'],
    external_blocker: 'fedramp_boundary_authorization_missing',
  },
  {
    id: 'slsa-sbom',
    label: 'SLSA/SBOM evidence',
    live_certification_required: true,
    required_evidence_types: ['signed_provenance', 'sbom_attestation'],
    implemented_evidence: ['docs/kolm-format-v1.md', 'src/sbom-emit.js', 'src/slsa-provenance.js', 'src/intoto-slsa.js', '.github/workflows/sdk-c-rust.yml'],
    external_blocker: 'signed_release_provenance_missing',
  },
];

function exists(root, rel) {
  return fs.existsSync(path.join(root, rel));
}

function readIfExists(root, rel) {
  const full = path.join(root, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function nonEmpty(value, min = 1) {
  return typeof value === 'string' && value.trim().length >= min;
}

function validSha(value) {
  return typeof value === 'string' && SHA256_RE.test(value) && !/^(?:sha256:)?0{64}$/i.test(value);
}

function isHttpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:';
  } catch {
    return false;
  }
}

function validIsoDate(value) {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function parseJsonFile(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export function complianceCertificationCatalog() {
  return {
    spec: COMPLIANCE_CERTIFICATION_SPEC,
    controls: COMPLIANCE_CERTIFICATION_CONTROLS,
    required_files: COMPLIANCE_REQUIRED_FILES,
  };
}

export function complianceCertificationManifestTemplate() {
  return {
    spec: COMPLIANCE_CERTIFICATION_MANIFEST_SPEC,
    secret_values_included: false,
    generated_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    organization: 'REPLACE_WITH_LEGAL_ENTITY',
    production_proof: {
      base_url: 'https://kolm.ai',
      environment: 'production',
      verified_at: 'REPLACE_WITH_ISO_TIMESTAMP',
      health_probe_sha256: null,
      ready_probe_sha256: null,
      authenticated_probe_sha256: null,
      tenant_boundary: 'REPLACE_WITH_TENANT_BOUNDARY_SUMMARY',
      data_region: 'REPLACE_WITH_REGION',
    },
    controls: COMPLIANCE_CERTIFICATION_CONTROLS.map((control) => ({
      id: control.id,
      label: control.label,
      status: 'REPLACE_WITH_certified_or_attested',
      evidence_type: control.required_evidence_types[0],
      issuer: 'REPLACE_WITH_AUDITOR_OR_COUNSEL',
      issued_at: 'REPLACE_WITH_ISO_DATE',
      expires_at: 'REPLACE_WITH_ISO_DATE_OR_NULL',
      evidence_url: 'https://kolm.ai/security',
      evidence_sha256: null,
      signature_sha256: null,
      scope_summary: 'REPLACE_WITH_SCOPE_BOUNDARIES_AND_EXCLUSIONS',
      implemented_evidence: control.implemented_evidence.slice(),
    })),
  };
}

export function validateComplianceCertificationManifest(manifest = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest:must_be_object');
  if (manifest.spec !== COMPLIANCE_CERTIFICATION_MANIFEST_SPEC) failures.push(`spec:expected_${COMPLIANCE_CERTIFICATION_MANIFEST_SPEC}`);
  if (manifest.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (SECRET_VALUE_RE.test(JSON.stringify(manifest))) failures.push('secret_value_detected');
  if (!validIsoDate(manifest.generated_at)) failures.push('generated_at:invalid');
  if (!nonEmpty(manifest.organization, 2)) failures.push('organization:missing');

  const proof = manifest.production_proof || {};
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) failures.push('production_proof:must_be_object');
  if (!isHttpsUrl(proof.base_url)) failures.push('production_proof:base_url_https_required');
  if (!validIsoDate(proof.verified_at)) failures.push('production_proof:verified_at_invalid');
  if (!nonEmpty(proof.environment, 3)) failures.push('production_proof:environment_missing');
  if (!nonEmpty(proof.tenant_boundary, 12)) failures.push('production_proof:tenant_boundary_missing');
  if (!nonEmpty(proof.data_region, 2)) failures.push('production_proof:data_region_missing');
  for (const field of ['health_probe_sha256', 'ready_probe_sha256', 'authenticated_probe_sha256']) {
    if (!validSha(proof[field])) failures.push(`production_proof:${field}_invalid`);
  }

  if (!Array.isArray(manifest.controls)) failures.push('controls:missing_array');
  const rows = Array.isArray(manifest.controls) ? manifest.controls : [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      failures.push('control:must_be_object');
      continue;
    }
    const control = COMPLIANCE_CERTIFICATION_CONTROLS.find((item) => item.id === row.id);
    if (!control) {
      failures.push(`${row.id || 'unknown'}:unknown_control`);
      continue;
    }
    if (seen.has(control.id)) failures.push(`${control.id}:duplicate_control`);
    seen.add(control.id);
    if (!['certified', 'attested', 'legally_approved', 'authorized'].includes(row.status)) {
      failures.push(`${control.id}:status_not_certification_grade`);
    }
    if (!control.required_evidence_types.includes(row.evidence_type)) {
      failures.push(`${control.id}:evidence_type_invalid`);
    }
    if (!nonEmpty(row.issuer, 2)) failures.push(`${control.id}:issuer_missing`);
    if (!validIsoDate(row.issued_at)) failures.push(`${control.id}:issued_at_invalid`);
    if (row.expires_at != null && row.expires_at !== '' && !validIsoDate(row.expires_at)) failures.push(`${control.id}:expires_at_invalid`);
    if (!isHttpsUrl(row.evidence_url)) failures.push(`${control.id}:evidence_url_https_required`);
    if (!validSha(row.evidence_sha256)) failures.push(`${control.id}:evidence_sha256_invalid`);
    if (!validSha(row.signature_sha256)) failures.push(`${control.id}:signature_sha256_invalid`);
    if (!nonEmpty(row.scope_summary, 24)) failures.push(`${control.id}:scope_summary_too_short`);
    if (!Array.isArray(row.implemented_evidence)) {
      failures.push(`${control.id}:implemented_evidence_missing`);
    } else {
      for (const rel of control.implemented_evidence) {
        if (!row.implemented_evidence.includes(rel)) failures.push(`${control.id}:implemented_evidence_missing:${rel}`);
      }
    }
  }
  for (const control of COMPLIANCE_CERTIFICATION_CONTROLS) {
    if (!seen.has(control.id)) failures.push(`${control.id}:control_missing`);
  }
  return {
    spec: COMPLIANCE_CERTIFICATION_MANIFEST_SPEC,
    ok: failures.length === 0,
    live_certification_verified: failures.length === 0,
    secret_values_included: false,
    counts: {
      controls: rows.length,
      required_controls: COMPLIANCE_CERTIFICATION_CONTROLS.length,
      complete_controls: failures.length === 0 ? COMPLIANCE_CERTIFICATION_CONTROLS.length : 0,
      failures: failures.length,
    },
    failures,
  };
}

export function auditComplianceCertificationPacket(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  let manifest = null;
  let manifest_validation = null;
  try {
    manifest = parseJsonFile(root, 'reports/compliance-certification-manifest.json');
    manifest_validation = manifest ? validateComplianceCertificationManifest(manifest) : null;
  } catch (e) {
    manifest_validation = {
      spec: COMPLIANCE_CERTIFICATION_MANIFEST_SPEC,
      ok: false,
      live_certification_verified: false,
      secret_values_included: false,
      counts: { controls: 0, required_controls: COMPLIANCE_CERTIFICATION_CONTROLS.length, complete_controls: 0, failures: 1 },
      failures: [`reports/compliance-certification-manifest.json:invalid_json:${String(e.message || e)}`],
    };
  }
  const liveCertificationVerified = Boolean(manifest_validation && manifest_validation.ok);
  const files = COMPLIANCE_REQUIRED_FILES.map((rel) => ({
    path: rel,
    exists: exists(root, rel),
  }));
  const missing = files.filter((file) => !file.exists).map((file) => file.path);
  const controlRows = COMPLIANCE_CERTIFICATION_CONTROLS.map((control) => {
    const evidence = control.implemented_evidence.map((rel) => ({
      path: rel,
      exists: exists(root, rel),
    }));
    return {
      ...control,
      local_evidence_ok: evidence.every((item) => item.exists),
      evidence,
      status: evidence.every((item) => item.exists) ? 'implemented_controls_external_cert_pending' : 'blocked',
    };
  });
  const localFailures = [
    ...missing.map((rel) => `missing_file:${rel}`),
    ...controlRows
      .filter((row) => !row.local_evidence_ok)
      .map((row) => `${row.id}:local_evidence_missing`),
  ];
  const externalBlockers = liveCertificationVerified ? [] : [
    ...(manifest_validation ? manifest_validation.failures : ['reports/compliance-certification-manifest.json:missing']),
    ...controlRows.map((row) => `${row.id}:${row.external_blocker}`),
  ];
  const scanned = files.map((file) => readIfExists(root, file.path)).join('\n');
  return {
    spec: COMPLIANCE_CERTIFICATION_SPEC,
    ok: localFailures.length === 0,
    local_contract_ok: localFailures.length === 0,
    live_certification_verified: liveCertificationVerified,
    secret_values_included: SECRET_VALUE_RE.test(scanned),
    certification_manifest_present: Boolean(manifest),
    certification_manifest_validation: manifest_validation,
    files,
    controls: controlRows,
    blockers: localFailures.length > 0 ? localFailures : externalBlockers,
    next_actions: [
      'Attach dated SOC 2/ISO/FedRAMP auditor artifacts when available.',
      'Attach signed BAA/DPA legal packets per customer or template.',
      'Attach signed release provenance, SBOM digests, and package release manifest after public release.',
      'Keep public trust copy scoped to implemented controls until certificates exist.',
    ],
  };
}
