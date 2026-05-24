import { auditBenchmarkEvidence } from './benchmark-evidence.js';
import { auditComplianceCertificationPacket } from './compliance-certification-packet.js';
import { auditFormatGovernancePacket } from './format-governance-packet.js';
import { auditPackageReleaseReadiness } from './package-release-readiness.js';
import { runQualityCalibration } from './quality-calibration.js';
import { auditRuntimeAdoptionPackets } from './runtime-adoption-packets.js';

export const EVIDENCE_READINESS_SPEC = 'kolm-evidence-readiness-1';

export const EVIDENCE_READINESS_SOURCE_PATHS = [
  'src/evidence-readiness.js',
  'src/format-governance-packet.js',
  'src/runtime-adoption-packets.js',
  'src/compliance-certification-packet.js',
  'src/package-release-readiness.js',
  'src/benchmark-evidence.js',
  'src/quality-calibration.js',
];

export const EVIDENCE_READINESS_REQUIREMENT_IDS = [
  'foundation-standardization',
  'ecosystem-runtime-adoption',
  'compliance-certifications',
  'runtime-wasm',
  'ios-android-sdk',
  'sdk-depth',
  'one-line-install',
  'benchmarking-infra',
  'quality-scoring',
];

function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item != null).map(String) : [];
}

function blockerList(...groups) {
  return groups.flatMap(asArray);
}

function gate(row) {
  return {
    id: row.id,
    label: row.label,
    surface: row.surface,
    journey: row.journey,
    status: row.status,
    requirement_ids: asArray(row.requirement_ids),
    local_contract_ok: Boolean(row.local_contract_ok),
    external_ready: Boolean(row.external_ready),
    blockers: asArray(row.blockers),
    proof_command: row.proof_command,
    api_path: row.api_path,
  };
}

function countByStatus(gates) {
  const counts = {};
  for (const item of gates) counts[item.status] = (counts[item.status] || 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function buildEvidenceReadiness(options = {}) {
  const root = options.root || process.cwd();
  const format = auditFormatGovernancePacket({ root });
  const runtime = auditRuntimeAdoptionPackets({ root });
  const compliance = auditComplianceCertificationPacket({ root });
  const packages = auditPackageReleaseReadiness({ root });
  const benchmark = auditBenchmarkEvidence({ root });
  const quality = runQualityCalibration({
    generated_at: options.generated_at || options.generatedAt,
  });

  const gates = [
    gate({
      id: 'format-governance',
      label: '.kolm neutral governance',
      surface: 'public-docs-sdk',
      journey: 'compile-verify',
      status: format.external_acceptance_verified ? 'external_ready' : 'needs_external_partner',
      requirement_ids: ['foundation-standardization'],
      local_contract_ok: format.ok && format.local_contract_ok,
      external_ready: format.external_acceptance_verified,
      blockers: format.blockers,
      proof_command: 'kolm evidence format-governance --summary --require-local-contract',
      api_path: '/v1/spec/governance-packet',
    }),
    gate({
      id: 'runtime-adoption',
      label: 'Third-party runtime adoption',
      surface: 'runtime-inference-connectors',
      journey: 'runtime-inference-connectors',
      status: runtime.external_adoption_verified ? 'external_ready' : 'needs_external_partner',
      requirement_ids: ['ecosystem-runtime-adoption'],
      local_contract_ok: runtime.ok && runtime.local_contract_ok,
      external_ready: runtime.external_adoption_verified,
      blockers: runtime.blockers,
      proof_command: 'kolm evidence runtime-adoption --summary --require-local-contract',
      api_path: '/v1/runtime/adoption-packets',
    }),
    gate({
      id: 'compliance-certification',
      label: 'Auditor and legal certification evidence',
      surface: 'governance-compliance-security',
      journey: 'enterprise-governance',
      status: compliance.live_certification_verified ? 'external_ready' : 'needs_live_certification',
      requirement_ids: ['compliance-certifications'],
      local_contract_ok: compliance.ok && compliance.local_contract_ok,
      external_ready: compliance.live_certification_verified,
      blockers: compliance.blockers,
      proof_command: 'kolm evidence compliance-certification --summary --require-local-contract',
      api_path: '/v1/compliance/certification-packet',
    }),
    gate({
      id: 'package-release',
      label: 'SDK, runtime, and installer package release',
      surface: 'public-docs-sdk',
      journey: 'runtime-inference-connectors',
      status: packages.publish_ready ? 'external_ready' : 'needs_package_release',
      requirement_ids: ['runtime-wasm', 'ios-android-sdk', 'sdk-depth', 'one-line-install'],
      local_contract_ok: packages.ok,
      external_ready: packages.publish_ready,
      blockers: blockerList(packages.failures, packages.publish_blockers),
      proof_command: 'kolm evidence package-release --summary --require-local-contract',
      api_path: '/v1/packages/release-readiness',
    }),
    gate({
      id: 'benchmark',
      label: 'Public multi-provider benchmark evidence',
      surface: 'capture-data-eval-training',
      journey: 'train-distill',
      status: benchmark.public_claim_ready ? 'external_ready' : 'needs_public_benchmark_data',
      requirement_ids: ['benchmarking-infra'],
      local_contract_ok: benchmark.ok && benchmark.local_contract_ok,
      external_ready: benchmark.public_claim_ready,
      blockers: benchmark.blockers,
      proof_command: 'kolm evidence benchmark --summary --require-local-contract',
      api_path: '/v1/eval/benchmark-evidence',
    }),
    gate({
      id: 'quality',
      label: 'Quality judge calibration evidence',
      surface: 'capture-data-eval-training',
      journey: 'train-distill',
      status: quality.local_contract_ok ? 'implemented' : 'needs_public_benchmark_data',
      requirement_ids: ['quality-scoring'],
      local_contract_ok: quality.ok && quality.local_contract_ok,
      external_ready: quality.public_claim_ready,
      blockers: quality.public_claim_blockers,
      proof_command: 'kolm evidence quality --summary --require-local-contract',
      api_path: '/v1/eval/quality-calibration',
    }),
  ];

  const localContractOk = gates.every((item) => item.local_contract_ok);
  const externalReady = gates.every((item) => item.external_ready);
  const status = !localContractOk ? 'blocked' : externalReady ? 'implemented' : 'partial';
  const secretValuesIncluded = Boolean(
    format.secret_values_included ||
    runtime.secret_values_included ||
    compliance.secret_values_included ||
    packages.secret_values_included ||
    benchmark.secret_values_included ||
    quality.secret_values_included
  );

  return {
    spec: EVIDENCE_READINESS_SPEC,
    ok: localContractOk,
    local_contract_ok: localContractOk,
    external_ready: externalReady,
    readiness_status: status,
    secret_values_included: secretValuesIncluded,
    generated_at: options.generated_at || options.generatedAt || new Date().toISOString(),
    counts: {
      gates: gates.length,
      local_contract_ok: gates.filter((item) => item.local_contract_ok).length,
      external_ready: gates.filter((item) => item.external_ready).length,
      blockers: gates.reduce((n, item) => n + item.blockers.length, 0),
      by_status: countByStatus(gates),
    },
    gates,
    data: {
      format_governance: format,
      runtime_adoption: runtime,
      compliance_certification: compliance,
      package_release: packages,
      benchmark_evidence: benchmark,
      quality_calibration: quality,
    },
    next_actions: gates.map((item) => ({
      kind: 'command',
      label: `Verify ${item.label}`,
      value: item.proof_command,
      surface: item.surface,
      journey: item.journey,
      priority: item.external_ready ? 'P2' : 'P0',
    })),
    note: 'Combined local evidence readiness. External partner acceptance, package publication, public benchmark data, and live certification remain explicitly gated.',
  };
}

export default buildEvidenceReadiness;
