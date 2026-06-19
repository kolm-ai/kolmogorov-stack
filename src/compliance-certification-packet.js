import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const COMPLIANCE_CERTIFICATION_SPEC = 'kolm-compliance-certification-packet-1';
export const COMPLIANCE_CERTIFICATION_MANIFEST_SPEC = 'kolm-compliance-certification-manifest-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const PLACEHOLDER_VALUE_RE = /\bREPLACE_WITH_[A-Z0-9_]+/;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const CERT_ARTIFACT_PATH_RE = /^reports\/compliance\/[a-z0-9][a-z0-9._/-]*\.(?:pdf|json|jsonl|md|txt|sig)$/i;
const REVIEWER_INDEPENDENCE_VALUES = new Set([
  'external_auditor',
  'external_counsel',
  'internal_independent_reviewer',
]);

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

export const COMPLIANCE_AUTHORITY_REFERENCES = [
  {
    id: 'aicpa-trust-services-criteria',
    label: 'AICPA Trust Services Criteria',
    url: 'https://www.aicpa-cima.com/resources/download/2022-trust-services-criteria-with-revised-points-of-focus',
  },
  {
    id: 'iso-iec-27001',
    label: 'ISO/IEC 27001',
    url: 'https://www.iso.org/standard/27001',
  },
  {
    id: 'hhs-hipaa-security-rule',
    label: 'HHS HIPAA Security Rule',
    url: 'https://www.hhs.gov/hipaa/for-professionals/security/laws-regulations/index.html',
  },
  {
    id: 'eu-gdpr',
    label: 'EU GDPR',
    url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj',
  },
  {
    id: 'fedramp-rev5-baselines',
    label: 'FedRAMP Rev. 5 baselines',
    url: 'https://www.fedramp.gov/baselines/',
  },
  {
    id: 'nist-sp-800-53-rev5',
    label: 'NIST SP 800-53 Rev. 5',
    url: 'https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final',
  },
  {
    id: 'slsa-provenance-v1',
    label: 'SLSA Provenance v1.0',
    url: 'https://slsa.dev/spec/v1.0/provenance',
  },
  {
    id: 'in-toto-statement-v1',
    label: 'in-toto Statement v1',
    url: 'https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md',
  },
  {
    id: 'spdx-specifications',
    label: 'SPDX specifications',
    url: 'https://spdx.dev/specifications/',
  },
];

export const COMPLIANCE_CERTIFICATION_CONTROLS = [
  {
    id: 'soc2',
    label: 'SOC 2',
    live_certification_required: true,
    required_evidence_types: ['auditor_report'],
    implemented_evidence: ['docs/compliance/SOC2-EVIDENCE.md', 'docs/compliance/CONTROLS.md', 'public/security.html'],
    external_blocker: 'soc2_auditor_report_missing',
    authority_refs: ['aicpa-trust-services-criteria'],
    framework_control_refs: ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8', 'CC9'],
  },
  {
    id: 'iso27001',
    label: 'ISO 27001',
    live_certification_required: true,
    required_evidence_types: ['certificate', 'auditor_report'],
    implemented_evidence: ['docs/compliance/CONTROLS.md', 'public/security.html'],
    external_blocker: 'iso27001_certificate_missing',
    authority_refs: ['iso-iec-27001'],
    framework_control_refs: ['Clauses 4-10', 'Annex A'],
  },
  {
    id: 'hipaa-baa',
    label: 'HIPAA BAA',
    live_certification_required: true,
    required_evidence_types: ['legal_packet', 'signed_agreement'],
    implemented_evidence: ['public/baa.html', 'docs/angle/hipaa-onepager.html', 'public/security.html'],
    external_blocker: 'signed_baa_counterparty_or_counsel_packet_missing',
    authority_refs: ['hhs-hipaa-security-rule'],
    framework_control_refs: [
      '45 CFR Part 164 Subpart C',
      '45 CFR 164.308',
      '45 CFR 164.310',
      '45 CFR 164.312',
      '45 CFR 164.316',
    ],
  },
  {
    id: 'gdpr-dpa',
    label: 'GDPR DPA',
    live_certification_required: true,
    required_evidence_types: ['legal_packet', 'signed_agreement'],
    implemented_evidence: ['public/privacy.html', 'public/subprocessors.html'],
    external_blocker: 'gdpr_dpa_legal_review_missing',
    authority_refs: ['eu-gdpr'],
    framework_control_refs: ['Article 28', 'Article 30', 'Article 32', 'Article 33', 'Article 35'],
  },
  {
    id: 'fedramp-boundary',
    label: 'FedRAMP boundary',
    live_certification_required: true,
    required_evidence_types: ['authorization_packet', 'boundary_assessment'],
    implemented_evidence: ['public/security.html', 'docs/compliance/CONTROLS.md', 'docs/kolm-format-v1.md'],
    external_blocker: 'fedramp_boundary_authorization_missing',
    authority_refs: ['fedramp-rev5-baselines', 'nist-sp-800-53-rev5'],
    framework_control_refs: ['FedRAMP Rev. 5 Moderate baseline', 'NIST SP 800-53 Rev. 5 control families'],
  },
  {
    id: 'slsa-sbom',
    label: 'SLSA/SBOM evidence',
    live_certification_required: true,
    required_evidence_types: ['signed_provenance', 'sbom_attestation'],
    implemented_evidence: ['docs/kolm-format-v1.md', 'src/sbom-emit.js', 'src/slsa-provenance.js', 'src/intoto-slsa.js', '.github/workflows/sdk-c-rust.yml'],
    external_blocker: 'signed_release_provenance_missing',
    authority_refs: ['slsa-provenance-v1', 'in-toto-statement-v1', 'spdx-specifications'],
    framework_control_refs: ['SLSA Provenance v1.0 predicate', 'in-toto Statement v1 subject/materials', 'SPDX SBOM document'],
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

function normalizeSha(value) {
  return String(value || '').replace(/^sha256:/i, '').toLowerCase();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
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

function validArtifactPath(value) {
  return typeof value === 'string'
    && CERT_ARTIFACT_PATH_RE.test(value)
    && !value.includes('..')
    && !value.includes('\\');
}

function parseJsonFile(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export function complianceCertificationCatalog() {
  return {
    spec: COMPLIANCE_CERTIFICATION_SPEC,
    authority_references: COMPLIANCE_AUTHORITY_REFERENCES,
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
      evidence_artifact_path: `reports/compliance/${control.id}-evidence.pdf`,
      evidence_sha256: null,
      evidence_register_path: `reports/compliance/${control.id}-evidence-register.json`,
      evidence_register_sha256: null,
      signature_artifact_path: `reports/compliance/${control.id}-evidence.sig`,
      signature_sha256: null,
      scope_summary: 'REPLACE_WITH_SCOPE_BOUNDARIES_AND_EXCLUSIONS',
      control_period_start: 'REPLACE_WITH_ISO_DATE',
      control_period_end: 'REPLACE_WITH_ISO_DATE',
      system_boundary: {
        services: ['REPLACE_WITH_SERVICE_OR_SYSTEM'],
        data_classes: ['REPLACE_WITH_DATA_CLASS'],
        exclusions: ['REPLACE_WITH_EXCLUSION_OR_NONE'],
      },
      chain_of_custody: {
        collected_by: 'REPLACE_WITH_COLLECTOR',
        reviewed_by: 'REPLACE_WITH_REVIEWER',
        reviewer_independence: 'REPLACE_WITH_external_auditor_or_counsel_or_internal_independent',
        retained_until: 'REPLACE_WITH_ISO_DATE',
        evidence_register_path: `reports/compliance/${control.id}-evidence-register.json`,
        evidence_register_sha256: null,
      },
      authority_refs: control.authority_refs.map((id) => {
        const authority = COMPLIANCE_AUTHORITY_REFERENCES.find((item) => item.id === id);
        return { id, label: authority ? authority.label : null, url: authority ? authority.url : null };
      }),
      framework_control_refs: control.framework_control_refs.slice(),
      implemented_evidence: control.implemented_evidence.slice(),
    })),
  };
}

function arrayOfNonEmptyStrings(value, min = 1) {
  return Array.isArray(value) && value.length >= min && value.every((item) => nonEmpty(item, 1));
}

export function validateComplianceCertificationManifest(manifest = {}) {
  const failures = [];
  const serializedManifest = JSON.stringify(manifest);
  const secretValuesIncluded = SECRET_VALUE_RE.test(serializedManifest);
  const placeholderValuesIncluded = PLACEHOLDER_VALUE_RE.test(serializedManifest);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest:must_be_object');
  if (manifest.spec !== COMPLIANCE_CERTIFICATION_MANIFEST_SPEC) failures.push(`spec:expected_${COMPLIANCE_CERTIFICATION_MANIFEST_SPEC}`);
  if (manifest.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (secretValuesIncluded) failures.push('secret_value_detected');
  if (placeholderValuesIncluded) failures.push('placeholder_value_detected');
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
    if (validIsoDate(row.issued_at) && validIsoDate(row.expires_at) && Date.parse(row.expires_at) <= Date.parse(row.issued_at)) {
      failures.push(`${control.id}:expires_at_must_be_after_issued_at`);
    }
    if (!isHttpsUrl(row.evidence_url)) failures.push(`${control.id}:evidence_url_https_required`);
    if (!validArtifactPath(row.evidence_artifact_path)) failures.push(`${control.id}:evidence_artifact_path_invalid`);
    if (!validSha(row.evidence_sha256)) failures.push(`${control.id}:evidence_sha256_invalid`);
    if (!validArtifactPath(row.evidence_register_path)) failures.push(`${control.id}:evidence_register_path_invalid`);
    if (!validSha(row.evidence_register_sha256)) failures.push(`${control.id}:evidence_register_sha256_invalid`);
    if (!validArtifactPath(row.signature_artifact_path)) failures.push(`${control.id}:signature_artifact_path_invalid`);
    if (!validSha(row.signature_sha256)) failures.push(`${control.id}:signature_sha256_invalid`);
    if (!nonEmpty(row.scope_summary, 24)) failures.push(`${control.id}:scope_summary_too_short`);
    if (!validIsoDate(row.control_period_start)) failures.push(`${control.id}:control_period_start_invalid`);
    if (!validIsoDate(row.control_period_end)) failures.push(`${control.id}:control_period_end_invalid`);
    if (validIsoDate(row.control_period_start) && validIsoDate(row.control_period_end)
      && Date.parse(row.control_period_end) <= Date.parse(row.control_period_start)) {
      failures.push(`${control.id}:control_period_end_must_be_after_start`);
    }
    if (!row.system_boundary || typeof row.system_boundary !== 'object' || Array.isArray(row.system_boundary)) {
      failures.push(`${control.id}:system_boundary_missing`);
    } else {
      if (!arrayOfNonEmptyStrings(row.system_boundary.services)) failures.push(`${control.id}:system_boundary_services_missing`);
      if (!arrayOfNonEmptyStrings(row.system_boundary.data_classes)) failures.push(`${control.id}:system_boundary_data_classes_missing`);
      if (!Array.isArray(row.system_boundary.exclusions)) failures.push(`${control.id}:system_boundary_exclusions_missing`);
    }
    if (!row.chain_of_custody || typeof row.chain_of_custody !== 'object' || Array.isArray(row.chain_of_custody)) {
      failures.push(`${control.id}:chain_of_custody_missing`);
    } else {
      for (const field of ['collected_by', 'reviewed_by', 'reviewer_independence']) {
        if (!nonEmpty(row.chain_of_custody[field], 2)) failures.push(`${control.id}:chain_of_custody_${field}_missing`);
      }
      if (nonEmpty(row.chain_of_custody.reviewer_independence)
        && !REVIEWER_INDEPENDENCE_VALUES.has(row.chain_of_custody.reviewer_independence)) {
        failures.push(`${control.id}:chain_of_custody_reviewer_independence_invalid`);
      }
      if (!validIsoDate(row.chain_of_custody.retained_until)) failures.push(`${control.id}:chain_of_custody_retained_until_invalid`);
      if (validIsoDate(row.chain_of_custody.retained_until) && validIsoDate(row.control_period_end)
        && Date.parse(row.chain_of_custody.retained_until) <= Date.parse(row.control_period_end)) {
        failures.push(`${control.id}:chain_of_custody_retention_must_exceed_control_period`);
      }
      if (row.chain_of_custody.evidence_register_path !== row.evidence_register_path) {
        failures.push(`${control.id}:chain_of_custody_evidence_register_path_mismatch`);
      }
      if (row.chain_of_custody.evidence_register_sha256 !== row.evidence_register_sha256) {
        failures.push(`${control.id}:chain_of_custody_evidence_register_sha256_mismatch`);
      }
    }
    if (!Array.isArray(row.authority_refs) || row.authority_refs.length === 0) {
      failures.push(`${control.id}:authority_refs_missing`);
    } else {
      const authorityById = new Map(COMPLIANCE_AUTHORITY_REFERENCES.map((item) => [item.id, item]));
      const rowAuthorityIds = new Set(row.authority_refs.map((item) => item && item.id));
      for (const id of control.authority_refs) {
        if (!rowAuthorityIds.has(id)) failures.push(`${control.id}:authority_ref_missing:${id}`);
      }
      for (const item of row.authority_refs) {
        const authority = item && authorityById.get(item.id);
        if (!authority) {
          failures.push(`${control.id}:authority_ref_unknown:${item && item.id ? item.id : 'missing'}`);
          continue;
        }
        if (item.label !== authority.label) failures.push(`${control.id}:authority_ref_label_mismatch:${authority.id}`);
        if (item.url !== authority.url || !isHttpsUrl(item.url)) failures.push(`${control.id}:authority_ref_url_mismatch:${authority.id}`);
      }
    }
    if (!arrayOfNonEmptyStrings(row.framework_control_refs)) {
      failures.push(`${control.id}:framework_control_refs_missing`);
    } else {
      for (const ref of control.framework_control_refs) {
        if (!row.framework_control_refs.includes(ref)) failures.push(`${control.id}:framework_control_ref_missing:${ref}`);
      }
    }
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
    manifest_ready_for_artifact_validation: failures.length === 0,
    live_certification_verified: false,
    secret_values_included: secretValuesIncluded,
    placeholder_values_included: placeholderValuesIncluded,
    counts: {
      controls: rows.length,
      required_controls: COMPLIANCE_CERTIFICATION_CONTROLS.length,
      complete_controls: failures.length === 0 ? COMPLIANCE_CERTIFICATION_CONTROLS.length : 0,
      failures: failures.length,
    },
    failures,
  };
}

export function validateComplianceCertificationArtifacts(root, manifest = {}) {
  const failures = [];
  const controls = Array.isArray(manifest.controls) ? manifest.controls : [];
  for (const row of controls) {
    const id = row && row.id ? row.id : 'unknown';
    for (const [pathField, hashField] of [
      ['evidence_artifact_path', 'evidence_sha256'],
      ['evidence_register_path', 'evidence_register_sha256'],
      ['signature_artifact_path', 'signature_sha256'],
    ]) {
      const rel = row && row[pathField];
      if (!validArtifactPath(rel)) {
        failures.push(`${id}:${pathField}_invalid`);
        continue;
      }
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) {
        failures.push(`${id}:${rel}:missing`);
        continue;
      }
      if (!validSha(row[hashField])) {
        failures.push(`${id}:${hashField}_invalid`);
        continue;
      }
      const actual = sha256Buffer(fs.readFileSync(full));
      if (actual !== normalizeSha(row[hashField])) {
        failures.push(`${id}:${hashField}_mismatch`);
      }
    }
  }
  return {
    ok: failures.length === 0,
    artifact_count: controls.length * 3,
    failures,
  };
}

export function auditComplianceCertificationPacket(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  let manifest = null;
  let manifest_validation = null;
  let artifact_validation = null;
  try {
    manifest = parseJsonFile(root, 'reports/compliance-certification-manifest.json');
    manifest_validation = manifest ? validateComplianceCertificationManifest(manifest) : null;
    artifact_validation = manifest && manifest_validation && manifest_validation.ok
      ? validateComplianceCertificationArtifacts(root, manifest)
      : null;
  } catch (e) {
    manifest_validation = {
      spec: COMPLIANCE_CERTIFICATION_MANIFEST_SPEC,
      ok: false,
      manifest_ready_for_artifact_validation: false,
      live_certification_verified: false,
      secret_values_included: false,
      placeholder_values_included: false,
      counts: { controls: 0, required_controls: COMPLIANCE_CERTIFICATION_CONTROLS.length, complete_controls: 0, failures: 1 },
      failures: [`reports/compliance-certification-manifest.json:invalid_json:${String(e.message || e)}`],
    };
    artifact_validation = null;
  }
  const liveCertificationVerified = Boolean(manifest_validation && manifest_validation.ok && artifact_validation && artifact_validation.ok);
  const files = COMPLIANCE_REQUIRED_FILES.map((rel) => ({
    path: rel,
    exists: exists(root, rel),
  }));
  const missing = files.filter((file) => !file.exists).map((file) => file.path);
  const scanned = files.map((file) => readIfExists(root, file.path)).join('\n');
  const secretValuesIncluded = SECRET_VALUE_RE.test(scanned);
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
    ...(secretValuesIncluded ? ['secret_value_detected'] : []),
    ...controlRows
      .filter((row) => !row.local_evidence_ok)
      .map((row) => `${row.id}:local_evidence_missing`),
  ];
  const externalBlockers = liveCertificationVerified ? [] : [
    ...(manifest_validation ? manifest_validation.failures : ['reports/compliance-certification-manifest.json:missing']),
    ...(artifact_validation ? artifact_validation.failures : []),
    ...controlRows.map((row) => `${row.id}:${row.external_blocker}`),
  ];
  return {
    spec: COMPLIANCE_CERTIFICATION_SPEC,
    ok: localFailures.length === 0,
    local_contract_ok: localFailures.length === 0,
    live_certification_verified: liveCertificationVerified,
    secret_values_included: secretValuesIncluded,
    authority_reference_count: COMPLIANCE_AUTHORITY_REFERENCES.length,
    framework_crosswalk_ready: controlRows.every((row) => row.authority_refs.length > 0 && row.framework_control_refs.length > 0),
    certification_manifest_present: Boolean(manifest),
    certification_manifest_validation: manifest_validation,
    certification_artifact_validation: artifact_validation,
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
