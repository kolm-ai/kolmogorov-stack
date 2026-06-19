// W1002: NRAS live proven-compute readiness contract.
//
// This module does not pretend local code can prove operated confidential-GPU
// capacity exists. It separates two claims:
//   1. local_contract_ready: verifier/root/runtime/collector defaults are wired
//      so a production deploy fails closed instead of silently becoming
//      shape-only.
//   2. default_live_claimable: local contract plus external live hardware
//      evidence. Without that evidence, product copy must stay external-gated.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const NRAS_LIVE_READINESS_VERSION = 'w1002-nras-live-readiness-v1';
export const NRAS_ROOT_CERT_SHA256_ENV = 'KOLM_NRAS_ROOT_CERT_SHA256';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NRAS_WORKER_PATH = path.resolve(__dirname, '..', 'workers', 'nras_verifier.py');

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'required']);
const SHA256_RE = /^[0-9a-f]{64}$/i;
const LOCALHOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function envOf(input) {
  return input && input.env && typeof input.env === 'object' ? input.env : process.env;
}

function boolValue(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  return TRUE_VALUES.has(String(value).trim().toLowerCase());
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function hasFile(file, fsLike = fs) {
  if (!file || typeof file !== 'string') return false;
  try {
    return fsLike.existsSync(file) && fsLike.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sha256File(file, fsLike = fs) {
  return crypto.createHash('sha256').update(fsLike.readFileSync(file)).digest('hex');
}

function normalizeSha256(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return SHA256_RE.test(trimmed) ? trimmed : null;
}

function normalizeHttpsRuntimeUrl(value) {
  const raw = firstString(value);
  if (!raw) return { ok: false, reason: 'missing_runtime_url' };
  try {
    const url = new URL(raw);
    const local = LOCALHOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
      return { ok: false, reason: 'runtime_url_must_be_https_or_loopback_http', value: raw };
    }
    return { ok: true, value: raw, loopback: local };
  } catch {
    return { ok: false, reason: 'runtime_url_invalid', value: raw };
  }
}

export function validateNrasRootCertPin({ rootCert, expectedSha256, fsLike = fs } = {}) {
  const expected = normalizeSha256(expectedSha256);
  if (!rootCert) {
    return { ok: false, reason: 'root_cert_missing' };
  }
  if (!hasFile(rootCert, fsLike)) {
    return { ok: false, reason: 'root_cert_file_missing', root_cert: rootCert };
  }
  const actual = sha256File(rootCert, fsLike);
  if (!expected) {
    return {
      ok: true,
      pinned: false,
      reason: 'root_cert_sha256_pin_missing',
      root_cert: rootCert,
      actual_sha256: actual,
    };
  }
  if (actual !== expected) {
    return {
      ok: false,
      pinned: true,
      reason: 'root_cert_sha256_mismatch',
      root_cert: rootCert,
      expected_sha256: expected,
      actual_sha256: actual,
    };
  }
  return {
    ok: true,
    pinned: true,
    root_cert: rootCert,
    expected_sha256: expected,
    actual_sha256: actual,
  };
}

function runtimeUrl(input, env) {
  return firstString(
    input.runtime_url,
    input.runtimeUrl,
    env.KOLM_PROVEN_COMPUTE_RUNTIME_URL,
    env.KOLM_W992_URL,
    env.KOLM_VLLM_URL,
  );
}

function runtimeKey(input, env) {
  return firstString(
    input.runtime_key,
    input.runtimeKey,
    env.KOLM_PROVEN_COMPUTE_RUNTIME_KEY,
    env.KOLM_W992_KEY,
    env.KOLM_VLLM_KEY,
  );
}

function artifactIdentity(input, env) {
  return {
    artifact_hash: normalizeSha256(firstString(
      input.artifact_hash,
      input.artifactHash,
      env.KOLM_PROVEN_COMPUTE_ARTIFACT_HASH,
      env.KOLM_ARTIFACT_SHA,
    )),
    cid: firstString(input.cid, input.artifact_cid, env.KOLM_PROVEN_COMPUTE_ARTIFACT_CID, env.KOLM_ARTIFACT_CID),
    model_weight_artifact_manifest_hash: normalizeSha256(firstString(
      input.model_weight_artifact_manifest_hash,
      input.modelWeightArtifactManifestHash,
      env.KOLM_MODEL_WEIGHT_ARTIFACT_MANIFEST_HASH,
    )),
  };
}

function liveEvidence(input, env, fsLike) {
  const evidence = input.live_evidence && typeof input.live_evidence === 'object'
    ? input.live_evidence
    : {};
  const tokenFixture = firstString(
    evidence.hardware_token_fixture,
    input.hardware_token_fixture,
    env.KOLM_NRAS_HARDWARE_TOKEN_FIXTURE,
  );
  const receiptFixture = firstString(
    evidence.proven_compute_receipt_fixture,
    input.proven_compute_receipt_fixture,
    env.KOLM_PROVEN_COMPUTE_RECEIPT_FIXTURE,
  );
  const operated = boolValue(
    evidence.operated_capacity
      ?? input.operated_capacity
      ?? env.KOLM_PROVEN_COMPUTE_OPERATED_CAPACITY,
  );
  const tokenOk = evidence.hardware_token_verified === true || hasFile(tokenFixture, fsLike);
  const receiptOk = evidence.runtime_receipt_verified === true || hasFile(receiptFixture, fsLike);
  return {
    operated_capacity: operated,
    hardware_token_verified: tokenOk,
    runtime_receipt_verified: receiptOk,
    hardware_token_fixture: tokenFixture || null,
    proven_compute_receipt_fixture: receiptFixture || null,
    ok: operated && tokenOk && receiptOk,
  };
}

export function buildNrasLiveReadinessPlan(input = {}, opts = {}) {
  const env = envOf(input);
  const fsLike = opts.fsLike || fs;
  const rootCert = firstString(input.root_cert, input.rootCert, env.KOLM_NRAS_ROOT_CERT);
  const rootPin = firstString(
    input.root_cert_sha256,
    input.rootCertSha256,
    env[NRAS_ROOT_CERT_SHA256_ENV],
  );
  const root = validateNrasRootCertPin({ rootCert, expectedSha256: rootPin, fsLike });
  const url = normalizeHttpsRuntimeUrl(runtimeUrl(input, env));
  const identity = artifactIdentity(input, env);
  const collector = firstString(
    input.collector,
    input.nras_collector,
    env.KOLM_NRAS_COLLECTOR,
    env.KOLM_NRAS_COLLECTOR_BIN,
    'auto',
  );
  const requireProof = boolValue(
    input.require_proven_compute
      ?? input.requireProvenCompute
      ?? env.KOLM_PROVEN_COMPUTE_REQUIRE
      ?? env.KOLM_RUNTIME_REQUIRE_PROVEN_COMPUTE,
  );
  const workerPath = firstString(input.worker_path, input.workerPath, env.KOLM_NRAS_WORKER_PATH, NRAS_WORKER_PATH);
  const evidence = liveEvidence(input, env, fsLike);

  const requirements = [
    {
      id: 'nras_verifier_env_enabled',
      ok: boolValue(input.verifier_enabled ?? env.KOLM_NRAS_VERIFIER),
      local_gate: true,
      detail: 'KOLM_NRAS_VERIFIER must be enabled for the NRAS verifier to register at boot.',
    },
    {
      id: 'pinned_root_cert_present',
      ok: hasFile(rootCert, fsLike),
      local_gate: true,
      detail: 'KOLM_NRAS_ROOT_CERT must point at the pinned NVIDIA root PEM.',
      evidence: { root_cert: rootCert || null, reason: root.reason || null },
    },
    {
      id: 'pinned_root_cert_sha256_matches',
      ok: root.ok && root.pinned === true,
      local_gate: true,
      detail: `${NRAS_ROOT_CERT_SHA256_ENV} must pin the root PEM bytes so a mounted cert cannot drift silently.`,
      evidence: {
        expected_sha256: root.expected_sha256 || rootPin || null,
        actual_sha256: root.actual_sha256 || null,
        reason: root.reason || null,
      },
    },
    {
      id: 'nras_worker_present',
      ok: hasFile(workerPath, fsLike),
      local_gate: true,
      detail: 'workers/nras_verifier.py must be present in the deployment bundle.',
      evidence: { worker_path: workerPath },
    },
    {
      id: 'runtime_endpoint_configured',
      ok: url.ok,
      local_gate: true,
      detail: 'A default OpenAI-compatible confidential-GPU runtime URL must be configured.',
      evidence: url,
    },
    {
      id: 'runtime_auth_configured',
      ok: !!runtimeKey(input, env),
      local_gate: true,
      detail: 'The operated runtime must have an auth token/key configured.',
    },
    {
      id: 'default_require_proven_compute',
      ok: requireProof,
      local_gate: true,
      detail: 'The default runtime lane must request require_proven_compute so missing evidence fails closed.',
    },
    {
      id: 'artifact_identity_configured',
      ok: !!(identity.artifact_hash || identity.cid || identity.model_weight_artifact_manifest_hash),
      local_gate: true,
      detail: 'The default lane must bind receipts to artifact hash, CID, or signed weight-manifest hash.',
      evidence: identity,
    },
    {
      id: 'nras_collector_declared',
      ok: !!collector,
      local_gate: true,
      detail: 'The deployment must declare the NRAS/nvtrust collector path or auto mode.',
      evidence: { collector },
    },
    {
      id: 'operated_confidential_gpu_capacity_evidenced',
      ok: evidence.ok,
      local_gate: false,
      external_gate: true,
      detail: 'Claimable default proven compute requires operated capacity plus recorded hardware token and runtime receipt evidence.',
      evidence,
    },
  ];

  const localBlockers = requirements.filter((r) => r.local_gate && !r.ok);
  const externalBlockers = requirements.filter((r) => r.external_gate && !r.ok);
  const localReady = localBlockers.length === 0;
  const claimable = localReady && externalBlockers.length === 0;

  return {
    version: NRAS_LIVE_READINESS_VERSION,
    ok: localReady,
    local_contract_ready: localReady,
    default_live_claimable: claimable,
    status: claimable
      ? 'claimable_default_live_proven_compute'
      : (localReady ? 'local_contract_ready_external_live_evidence_required' : 'local_contract_incomplete'),
    root_cert: root,
    runtime: {
      url: url.value || null,
      url_ok: url.ok,
      auth_configured: !!runtimeKey(input, env),
      require_proven_compute: requireProof,
      artifact_identity: identity,
      collector,
    },
    live_evidence: evidence,
    requirements,
    blockers: localBlockers.map((r) => ({ id: r.id, detail: r.detail, evidence: r.evidence || null })),
    external_evidence_required: externalBlockers.map((r) => ({ id: r.id, detail: r.detail, evidence: r.evidence || null })),
    claim_scope:
      'Local readiness can be claimed when ok=true. Default live proven compute can be claimed only when default_live_claimable=true.',
  };
}

export function assertNrasLiveReadiness(input = {}, opts = {}) {
  const plan = buildNrasLiveReadinessPlan(input, opts);
  if (opts.requireClaimable === true && !plan.default_live_claimable) {
    const ids = [
      ...plan.blockers.map((b) => b.id),
      ...plan.external_evidence_required.map((b) => b.id),
    ];
    throw new Error(`NRAS default live proven-compute is not claimable: ${ids.join(', ')}`);
  }
  if (opts.requireLocalContract !== false && !plan.local_contract_ready) {
    throw new Error(`NRAS live readiness local contract incomplete: ${plan.blockers.map((b) => b.id).join(', ')}`);
  }
  return plan;
}

export default {
  NRAS_LIVE_READINESS_VERSION,
  NRAS_ROOT_CERT_SHA256_ENV,
  NRAS_WORKER_PATH,
  validateNrasRootCertPin,
  buildNrasLiveReadinessPlan,
  assertNrasLiveReadiness,
};
