import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FORMAT_GOVERNANCE_SPEC = 'kolm-format-governance-packet-1';
export const FORMAT_GOVERNANCE_SUBMISSION_SPEC = 'kolm-format-governance-submission-1';

const SECRET_VALUE_RE = /\b(?:ks_[a-z0-9_]{12,}|sk-[a-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/i;
const SHA256_RE = /^(?:sha256:)?[a-f0-9]{64}$/i;
const FORMAT_GOVERNANCE_ARTIFACT_PATH_RE = /^reports\/format-governance\/[a-z0-9][a-z0-9._/-]*\.(?:md|json|jsonl|pdf|txt|sig)$/i;

export const FORMAT_GOVERNANCE_BASELINE = [
  {
    id: 'cncf-sandbox',
    title: 'CNCF Sandbox application process',
    url: 'https://contribute.cncf.io/projects/submit-project/',
    signal: 'Neutral governance needs a public application, review process, onboarding template, and change-control path.',
  },
  {
    id: 'format-spec',
    title: '.kolm v1 format specification',
    url: 'https://kolm.ai/spec',
    signal: 'A portable artifact standard needs a versioned wire format, compatibility rules, conformance fixtures, and verifier behavior.',
  },
];

export const FORMAT_GOVERNANCE_REQUIRED_FILES = [
  'docs/kolm-format-v1.md',
  'docs/rs-1.md',
  'docs/manifest-v0.1.json',
  'docs/receipt-v0.1.json',
  'public/spec.html',
  'docs/format-governance-packet.md',
];

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileEvidence(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    return { path: rel.replace(/\\/g, '/'), exists: false, sha256: null, bytes: 0 };
  }
  const text = fs.readFileSync(full, 'utf8');
  return {
    path: rel.replace(/\\/g, '/'),
    exists: true,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text),
  };
}

function nonEmpty(value, min = 1) {
  return typeof value === 'string' && value.trim().length >= min;
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

function validSha(value) {
  return typeof value === 'string' && SHA256_RE.test(value) && !/^(?:sha256:)?0{64}$/i.test(value);
}

function normalizeSha(value) {
  return String(value || '').replace(/^sha256:/i, '').toLowerCase();
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function validArtifactPath(value) {
  return typeof value === 'string'
    && FORMAT_GOVERNANCE_ARTIFACT_PATH_RE.test(value)
    && !value.includes('..')
    && !value.includes('\\');
}

function parseJsonFile(root, rel) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

export function formatGovernanceCatalog() {
  return {
    spec: FORMAT_GOVERNANCE_SPEC,
    secret_values_included: false,
    requirement_ids: ['foundation-standardization'],
    required_files: FORMAT_GOVERNANCE_REQUIRED_FILES.slice(),
    research_baseline: FORMAT_GOVERNANCE_BASELINE.map((row) => ({ ...row })),
    packet_sections: [
      'scope and charter',
      'artifact wire format',
      'compatibility policy',
      'conformance suite',
      'security and trademark policy',
      'maintainer and change-control process',
      'external submission log',
    ],
  };
}

export function formatGovernanceSubmissionTemplate() {
  return {
    spec: FORMAT_GOVERNANCE_SUBMISSION_SPEC,
    secret_values_included: false,
    generated_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    venue: 'REPLACE_WITH_FOUNDATION_OR_STANDARDS_BODY',
    venue_status: 'REPLACE_WITH_accepted',
    submitted_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    accepted_at: 'REPLACE_WITH_ISO_TIMESTAMP',
    submission_url: 'https://example.org/submissions/kolm',
    public_change_control_url: 'https://example.org/projects/kolm/governance',
    governance_record_url: 'https://example.org/projects/kolm',
    spec_artifact_path: 'reports/format-governance/spec.md',
    spec_sha256: null,
    conformance_suite_artifact_path: 'reports/format-governance/conformance-suite.json',
    conformance_suite_sha256: null,
    maintainer_policy_artifact_path: 'reports/format-governance/maintainer-policy.md',
    maintainer_policy_sha256: null,
    trademark_policy_artifact_path: 'reports/format-governance/trademark-policy.md',
    trademark_policy_sha256: null,
    compatibility_policy: 'semantic versioned .kolm format with verifier behavior pinned by fixtures',
    accepted_scope: 'REPLACE_WITH_ACCEPTED_SCOPE_BOUNDARIES',
  };
}

export function validateFormatGovernanceSubmission(manifest = {}) {
  const failures = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) failures.push('manifest:must_be_object');
  if (manifest.spec !== FORMAT_GOVERNANCE_SUBMISSION_SPEC) failures.push(`spec:expected_${FORMAT_GOVERNANCE_SUBMISSION_SPEC}`);
  if (manifest.secret_values_included !== false) failures.push('secret_values_included:must_be_false');
  if (SECRET_VALUE_RE.test(JSON.stringify(manifest))) failures.push('secret_value_detected');
  if (!validIsoDate(manifest.generated_at)) failures.push('generated_at:invalid');
  if (!nonEmpty(manifest.venue, 3)) failures.push('venue:missing');
  if (manifest.venue_status !== 'accepted') failures.push('venue_status:must_be_accepted');
  if (!validIsoDate(manifest.submitted_at)) failures.push('submitted_at:invalid');
  if (!validIsoDate(manifest.accepted_at)) failures.push('accepted_at:invalid');
  for (const field of ['submission_url', 'public_change_control_url', 'governance_record_url']) {
    if (!isHttpsUrl(manifest[field])) failures.push(`${field}:https_required`);
  }
  for (const field of ['spec_sha256', 'conformance_suite_sha256', 'maintainer_policy_sha256', 'trademark_policy_sha256']) {
    if (!validSha(manifest[field])) failures.push(`${field}:invalid`);
  }
  for (const field of ['spec_artifact_path', 'conformance_suite_artifact_path', 'maintainer_policy_artifact_path', 'trademark_policy_artifact_path']) {
    if (!validArtifactPath(manifest[field])) failures.push(`${field}:invalid`);
  }
  if (!nonEmpty(manifest.compatibility_policy, 24)) failures.push('compatibility_policy:too_short');
  if (!nonEmpty(manifest.accepted_scope, 24)) failures.push('accepted_scope:too_short');
  return {
    spec: FORMAT_GOVERNANCE_SUBMISSION_SPEC,
    ok: failures.length === 0,
    external_acceptance_manifest_valid: failures.length === 0,
    external_acceptance_verified: false,
    secret_values_included: false,
    failures,
  };
}

export function validateFormatGovernanceArtifacts(root, manifest = {}) {
  const failures = [];
  for (const [pathField, hashField] of [
    ['spec_artifact_path', 'spec_sha256'],
    ['conformance_suite_artifact_path', 'conformance_suite_sha256'],
    ['maintainer_policy_artifact_path', 'maintainer_policy_sha256'],
    ['trademark_policy_artifact_path', 'trademark_policy_sha256'],
  ]) {
    const rel = manifest[pathField];
    if (!validArtifactPath(rel)) {
      failures.push(`${pathField}:invalid`);
      continue;
    }
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) {
      failures.push(`${rel}:missing`);
      continue;
    }
    const actual = sha256Buffer(fs.readFileSync(full));
    if (validSha(manifest[hashField]) && actual !== normalizeSha(manifest[hashField])) {
      failures.push(`${hashField}:mismatch`);
    }
  }
  return {
    ok: failures.length === 0,
    artifact_count: 4,
    failures,
  };
}

export function auditFormatGovernancePacket(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const files = FORMAT_GOVERNANCE_REQUIRED_FILES.map((rel) => fileEvidence(root, rel));
  const missing = files.filter((file) => !file.exists).map((file) => `${file.path}:missing`);
  const local_contract_ok = missing.length === 0;
  let submission_manifest = null;
  let submission_validation = null;
  let artifact_validation = null;
  try {
    submission_manifest = parseJsonFile(root, 'reports/format-governance-submission.json')
      || parseJsonFile(root, 'docs/format-governance-external-submission.json');
    submission_validation = submission_manifest ? validateFormatGovernanceSubmission(submission_manifest) : null;
    artifact_validation = submission_manifest && submission_validation && submission_validation.ok
      ? validateFormatGovernanceArtifacts(root, submission_manifest)
      : null;
  } catch (e) {
    submission_validation = {
      spec: FORMAT_GOVERNANCE_SUBMISSION_SPEC,
      ok: false,
      external_acceptance_manifest_valid: false,
      external_acceptance_verified: false,
      secret_values_included: false,
      failures: [`format_governance_submission:invalid_json:${String(e.message || e)}`],
    };
    artifact_validation = null;
  }
  const external_acceptance_verified = Boolean(submission_validation && submission_validation.ok && artifact_validation && artifact_validation.ok);
  const blockers = [
    ...missing,
    ...(external_acceptance_verified ? [] : [
      ...(submission_validation ? submission_validation.failures : ['reports/format-governance-submission.json:missing']),
      ...(artifact_validation ? artifact_validation.failures : []),
      'neutral_venue_acceptance_missing',
      'public_change_control_record_missing',
      'retained_governance_artifacts_missing',
    ]),
  ];

  return {
    spec: FORMAT_GOVERNANCE_SPEC,
    ok: local_contract_ok,
    local_contract_ok,
    external_acceptance_verified,
    secret_values_included: false,
    external_submission_present: Boolean(submission_manifest),
    external_submission_validation: submission_validation,
    external_submission_artifacts: artifact_validation,
    generated_at: new Date().toISOString(),
    counts: {
      required_files: files.length,
      present_files: files.filter((file) => file.exists).length,
      blockers: blockers.length,
    },
    files,
    packet: {
      proposed_home: 'neutral foundation or standards working group',
      compatibility: 'semantic versioned .kolm format, verifier behavior pinned by fixtures',
      conformance: 'runtime/verifier fixture suite before external implementation claims',
      ip_policy: 'runtime/spec permissive, compiler and hosted governance commercial',
      submission_record_path: external_acceptance_verified ? 'reports/format-governance-submission.json' : null,
    },
    blockers,
    research_baseline: FORMAT_GOVERNANCE_BASELINE.map((row) => ({ ...row })),
    note: 'This packet makes .kolm governance submission-ready locally. It does not claim neutral stewardship until an outside venue accepts the process.',
  };
}

export default auditFormatGovernancePacket;
