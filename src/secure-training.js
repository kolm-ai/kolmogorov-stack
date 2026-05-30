// src/secure-training.js
//
// Secure-training guarantee — the enforcement point.
//
// A rented GPU pod is a THIRD-PARTY machine. Public/open data may be uploaded to
// one; sensitive or customer data must NOT leave the customer's boundary. The
// guarantee is: public data -> rented pod is fine; sensitive data -> local
// hardware, an air-gapped host, or BYOC (training inside the customer's own
// cloud). This module classifies the training corpus with the privacy-membrane
// detector and refuses ineligible (data, backend) pairs before any upload.
//
// It also declares the teardown policy a third-party pod must honour:
// encrypt-at-rest while the corpus + adapter sit on the rented disk, and
// wipe-on-teardown (shred the workspace) before the instance is released.
//
// Pure: depends only on src/privacy-membrane.js (node stdlib underneath).

import { scan } from './privacy-membrane.js';

// The operator's / customer's own metal — data never leaves the boundary.
export const LOCAL_BACKENDS = new Set([
  'local-cpu', 'local-cuda', 'local-mps', 'local-mlx', 'local-rocm', 'local-directml',
]);

// Rented, third-party machines. Uploading sensitive data here crosses the
// boundary, which the guarantee forbids without BYOC / air-gap.
export const THIRD_PARTY_BACKENDS = new Set([
  'vast', 'lambda', 'runpod', 'modal', 'together', 'replicate', 'fal', 'remote-ssh',
]);

export class SecureTrainingError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'SecureTrainingError';
    this.code = 'secure_training_policy';
    this.detail = detail || {};
  }
}

export function isLocalBackend(backend) { return LOCAL_BACKENDS.has(backend); }
export function isThirdPartyBackend(backend) {
  return THIRD_PARTY_BACKENDS.has(backend) && !LOCAL_BACKENDS.has(backend);
}

// classifyTrainingData(samples, opts) — scan up to `sampleLimit` rows of the
// corpus and report whether it carries sensitive classes (PII/PHI/secrets/...).
// Accepts a string, an array of strings, or an array of {prompt,completion}-ish
// objects. Conservative: any detected class marks the corpus sensitive.
export function classifyTrainingData(samples, { sampleLimit = 200 } = {}) {
  const rows = Array.isArray(samples) ? samples : [samples];
  const text = rows
    .slice(0, sampleLimit)
    .map((r) => (typeof r === 'string' ? r : safeStringify(r)))
    .join('\n');
  let res = {};
  try { res = scan(text) || {}; } catch { res = {}; }
  const classes = Array.isArray(res.classes) ? res.classes : [];
  const findings = Array.isArray(res.findings) ? res.findings.length : 0;
  const sensitive = res.sensitive === true || classes.length > 0;
  return { sensitive, classes, findings, sampled: Math.min(rows.length, sampleLimit), of: rows.length };
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// assertPodEligible(opts) — the gate. Returns { ok:true, mode, sensitive } when
// the (data, backend) pair is allowed; throws SecureTrainingError otherwise.
//
//   sensitivity : the classifyTrainingData() result, OR a boolean
//   backend     : target backend id (e.g. 'runpod', 'local-cuda')
//   byoc        : true if training runs in the customer's own VPC (src/byoc.js)
//   airgap      : true if the host is air-gapped (no egress)
//   override    : explicit operator acknowledgement that a third-party pod is
//                 acceptable for this corpus (data will leave the boundary)
export function assertPodEligible({ sensitivity, backend, byoc = false, airgap = false, override = false } = {}) {
  if (!backend) throw new SecureTrainingError('assertPodEligible: backend is required', {});
  const sensitive = typeof sensitivity === 'boolean' ? sensitivity : !!(sensitivity && sensitivity.sensitive);
  const classes = (sensitivity && sensitivity.classes) || [];

  // Local hardware, air-gap, and BYOC all keep data inside the boundary.
  if (isLocalBackend(backend)) return { ok: true, mode: 'local', sensitive };
  if (airgap) return { ok: true, mode: 'airgap', sensitive };
  if (byoc) return { ok: true, mode: 'byoc', sensitive };

  // Rented pod with non-sensitive (public/open) data is fine.
  if (!sensitive) return { ok: true, mode: 'rented-pod-public-data', sensitive: false };

  // Rented pod + sensitive data: only with explicit override.
  if (override) {
    return {
      ok: true,
      mode: 'rented-pod-override',
      sensitive: true,
      warning: `sensitive data (${classes.join(', ') || 'detected'}) uploaded to third-party backend "${backend}" by explicit override`,
    };
  }

  throw new SecureTrainingError(
    `Sensitive training data (${classes.join(', ') || 'detected'}) cannot be uploaded to the rented third-party backend "${backend}". ` +
    `Train locally, on an air-gapped host, or via BYOC (in your own cloud). ` +
    `To upload anyway and accept that the data leaves your boundary, pass override:true.`,
    { backend, classes },
  );
}

// teardownPolicy(backend) — what a third-party pod MUST do with the corpus.
// The orchestrator encrypts the corpus + adapter at rest on the rented disk and
// shreds the workspace before releasing the instance. Local backends are no-ops
// (the data is already on the owner's machine).
export function teardownPolicy(backend) {
  const thirdParty = isThirdPartyBackend(backend);
  return {
    backend,
    encrypt_at_rest: thirdParty,
    wipe_on_teardown: thirdParty,
    wipe_command: thirdParty
      ? "find /workspace -type f -exec shred -u -z {} + 2>/dev/null; rm -rf /workspace/* /root/.cache /tmp/kolm-* 2>/dev/null || true"
      : null,
  };
}

export default {
  LOCAL_BACKENDS,
  THIRD_PARTY_BACKENDS,
  SecureTrainingError,
  isLocalBackend,
  isThirdPartyBackend,
  classifyTrainingData,
  assertPodEligible,
  teardownPolicy,
};
