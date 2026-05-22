// Canonical product kernel.
//
// This file is intentionally pure. It gives every backend route, CLI command,
// TUI view, account panel, docs page, job, artifact, and proof object the same
// product vocabulary.

export const PRODUCT_KERNEL_VERSION = '2026-05-22';
export const PRODUCT_GRAPH_SCHEMA = 'kolm-product-graph-1';

export const READINESS_STATUSES = Object.freeze([
  'shipped',
  'implemented',
  'partial',
  'needs_public_benchmark_data',
  'needs_package_release',
  'needs_external_partner',
  'needs_live_certification',
  'certified',
  'needs-prod-smoke',
  'needs-upgrade',
  'blocked-prod-auth',
  'blocked-local-and-prod',
  'blocked',
]);

export const CLAIM_SCOPES = Object.freeze({
  shipped: 'local-code-and-tests',
  implemented: 'local-implementation',
  partial: 'scoped-implementation',
  needs_public_benchmark_data: 'benchmark-gated',
  needs_package_release: 'package-release-gated',
  needs_external_partner: 'partner-or-standards-gated',
  needs_live_certification: 'certification-gated',
  certified: 'surface-certified',
  'needs-prod-smoke': 'production-smoke-gated',
  'needs-upgrade': 'upgrade-gated',
  'blocked-prod-auth': 'production-auth-blocked',
  'blocked-local-and-prod': 'blocked',
  blocked: 'blocked',
});

export const ROUTE_CLASSES = Object.freeze([
  {
    id: 'public-metadata',
    side_effect: 'none',
    auth: 'none',
    idempotency: 'safe',
    required_proof: ['source_version'],
  },
  {
    id: 'account-read',
    side_effect: 'none',
    auth: 'required',
    idempotency: 'safe',
    required_proof: ['tenant', 'workspace'],
  },
  {
    id: 'account-mutation',
    side_effect: 'writes-state',
    auth: 'required',
    idempotency: 'required',
    required_proof: ['audit_event'],
  },
  {
    id: 'capture-proxy',
    side_effect: 'maybe-writes-capture',
    auth: 'optional-or-required-by-mode',
    idempotency: 'request-hash',
    required_proof: ['capture_receipt_or_no_store_receipt'],
  },
  {
    id: 'dataset-mutation',
    side_effect: 'writes-dataset',
    auth: 'required',
    idempotency: 'required',
    required_proof: ['dataset_version', 'audit_event'],
  },
  {
    id: 'build-launch',
    side_effect: 'creates-job',
    auth: 'required',
    idempotency: 'required',
    required_proof: ['job_id', 'build_plan_hash', 'audit_event'],
  },
  {
    id: 'artifact-read',
    side_effect: 'none',
    auth: 'required-or-public-artifact',
    idempotency: 'safe',
    required_proof: ['artifact_hash'],
  },
  {
    id: 'runtime-inference',
    side_effect: 'runs-model-or-artifact',
    auth: 'required-unless-local-offline',
    idempotency: 'request-hash',
    required_proof: ['inference_receipt'],
  },
  {
    id: 'governance-export',
    side_effect: 'creates-export',
    auth: 'admin',
    idempotency: 'required',
    required_proof: ['export_manifest', 'audit_event'],
  },
  {
    id: 'webhook-receive',
    side_effect: 'writes-state',
    auth: 'signed',
    idempotency: 'event-id',
    required_proof: ['signature_verification', 'audit_event'],
  },
]);

export const DEPLOYMENT_MODES = Object.freeze([
  { id: 'local', label: 'Local', proof_required: ['local_receipt'] },
  { id: 'hosted', label: 'Hosted Kolm', proof_required: ['tenant_auth', 'hosted_job'] },
  { id: 'byoc', label: 'Bring your own cloud', proof_required: ['storage_readiness', 'deployment_manifest'] },
  { id: 'edge', label: 'Edge/serverless', proof_required: ['runtime_target', 'bundle_hash'] },
  { id: 'browser', label: 'Browser', proof_required: ['wasm_bundle_hash', 'runtime_policy'] },
  { id: 'mobile', label: 'Mobile', proof_required: ['device_profile', 'runtime_target'] },
  { id: 'kubernetes', label: 'Kubernetes GPU', proof_required: ['cluster_profile', 'deployment_manifest'] },
  { id: 'ssh', label: 'Remote SSH', proof_required: ['host_fingerprint', 'job_log'] },
  { id: 'airgap', label: 'Air-gapped', proof_required: ['offline_verify', 'export_manifest'] },
]);

export const FAILURE_CODES = Object.freeze([
  { code: 'auth_missing', severity: 'blocker', retryable: true, next: 'Sign in or set KOLM_API_KEY.' },
  { code: 'permission_denied', severity: 'blocker', retryable: false, next: 'Use a scoped key with the required permission or ask an admin.' },
  { code: 'entitlement_missing', severity: 'blocker', retryable: false, next: 'Upgrade or choose a local mode.' },
  { code: 'provider_missing', severity: 'blocker', retryable: true, next: 'Connect a provider key or choose a local runtime.' },
  { code: 'provider_unhealthy', severity: 'warn', retryable: true, next: 'Retry, switch provider, or use fallback policy.' },
  { code: 'privacy_blocked', severity: 'blocker', retryable: false, next: 'Use local mode, redaction, or policy approval.' },
  { code: 'data_insufficient', severity: 'blocker', retryable: false, next: 'Capture, label, import, or synthesize more examples.' },
  { code: 'data_leakage', severity: 'blocker', retryable: false, next: 'Regenerate train/eval splits.' },
  { code: 'eval_missing', severity: 'blocker', retryable: false, next: 'Create or import an eval suite.' },
  { code: 'quality_gate_failed', severity: 'blocker', retryable: false, next: 'Inspect failing cases, add labels, or change model.' },
  { code: 'compute_missing', severity: 'blocker', retryable: true, next: 'Configure local GPU, hosted GPU, BYOC, or remote SSH.' },
  { code: 'storage_missing', severity: 'blocker', retryable: true, next: 'Configure R2, S3, Supabase, or local durable storage.' },
  { code: 'artifact_invalid', severity: 'blocker', retryable: false, next: 'Reject the artifact and rebuild or re-download.' },
  { code: 'runtime_incompatible', severity: 'blocker', retryable: false, next: 'Export a compatible target or choose another runtime.' },
  { code: 'policy_denied', severity: 'blocker', retryable: false, next: 'Choose an allowed provider/runtime or update policy.' },
  { code: 'certification_scope', severity: 'warn', retryable: false, next: 'Check live certification status before marketing the claim.' },
]);

export const PROOF_KINDS = Object.freeze([
  'audit_event',
  'artifact_hash',
  'build_plan_hash',
  'capture_receipt',
  'dataset_version',
  'deployment_manifest',
  'eval_suite',
  'export_manifest',
  'inference_receipt',
  'job_id',
  'manifest_hash',
  'policy_hash',
  'runtime_target',
  'signature',
  'split_hash',
  'storage_object',
  'trace_id',
]);

export const PRODUCT_STAGES = Object.freeze([
  'capture',
  'observe',
  'prepare',
  'choose',
  'train',
  'compile',
  'run',
  'deploy',
  'govern',
  'integrate',
]);

export function readinessClaimScope(status) {
  return CLAIM_SCOPES[status] || 'unknown';
}

export function isKnownReadinessStatus(status) {
  return READINESS_STATUSES.includes(status);
}

export function makeProofRef(kind, id, extra = {}) {
  if (!PROOF_KINDS.includes(kind)) {
    throw new Error(`unknown proof kind: ${kind}`);
  }
  return { kind, id: id == null ? null : String(id), ...extra };
}

export function makeNextAction({ kind = 'command', label, value, href = null, surface = null, journey = null, priority = 'P1' } = {}) {
  if (!label || !value) throw new Error('next action requires label and value');
  return {
    kind,
    label: String(label),
    value: String(value),
    href,
    surface,
    journey,
    priority,
  };
}

export function normalizeReadiness(readiness = {}) {
  const status = readiness.status || 'implemented';
  return {
    status,
    claim_scope: readiness.claim_scope || readinessClaimScope(status),
    external_requirements: Array.isArray(readiness.external_requirements) ? readiness.external_requirements.slice() : [],
    requirement_ids: Array.isArray(readiness.requirement_ids) ? readiness.requirement_ids.slice() : [],
  };
}

export function validateKernelNode(node = {}) {
  const failures = [];
  if (!node.id || !/^[a-z0-9-]+$/.test(String(node.id))) failures.push('bad_id');
  if (node.stage && !PRODUCT_STAGES.includes(node.stage)) failures.push('bad_stage');
  if (node.readiness && !isKnownReadinessStatus(node.readiness.status)) failures.push('bad_readiness');
  if (node.next_actions && !Array.isArray(node.next_actions)) failures.push('bad_next_actions');
  if (node.proof_refs && !Array.isArray(node.proof_refs)) failures.push('bad_proof_refs');
  return { ok: failures.length === 0, failures };
}

export function kernelCatalog() {
  return {
    version: PRODUCT_KERNEL_VERSION,
    graph_schema: PRODUCT_GRAPH_SCHEMA,
    readiness_statuses: READINESS_STATUSES.slice(),
    claim_scopes: { ...CLAIM_SCOPES },
    route_classes: ROUTE_CLASSES.map((row) => ({ ...row, required_proof: row.required_proof.slice() })),
    deployment_modes: DEPLOYMENT_MODES.map((row) => ({ ...row, proof_required: row.proof_required.slice() })),
    failure_codes: FAILURE_CODES.map((row) => ({ ...row })),
    proof_kinds: PROOF_KINDS.slice(),
    product_stages: PRODUCT_STAGES.slice(),
  };
}
