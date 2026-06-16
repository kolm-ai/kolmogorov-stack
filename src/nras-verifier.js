// src/nras-verifier.js
//
// C1 NRAS CAPSTONE (gate #4) - the SINGLE real proof-of-compute verifier wired
// behind the EXISTING seam registerAttestationVerifier('nras', fn) in
// src/confidential-compute.js. The seam already REFUSES verified=true without a
// registered verifier returning ok; this module does NOT weaken that.
//
// WHAT THE VERIFIER PROVES:
//   (a) the NRAS EAT/JWT attestation_report's signature chains up to the pinned
//       NVIDIA root cert (cert-chain validation), and is within not_after /
//       not revoked;
//   (b) the report's eat_nonce (32-byte caller nonce) BINDS to
//       sha256(input_digest || output_digest) of the inference it covers, so a
//       replayed token cannot be rebound to a different call (24h replay TTL);
//   (c) it returns { ok, verifier:'nras', trust_root, not_after,
//       cert_chain_length, revocation_checked_at }.
//
// PRIVACY: only digests + the NRAS token cross the worker boundary - NEVER
// customer prompt/output bytes. The binding is sha256(input_digest||output_digest),
// both already-computed hashes, so no plaintext leaves the host.
//
// ENV-GATE: behind KOLM_NRAS_VERIFIER=1 (+ KOLM_NRAS_ROOT_CERT path). When
// unset, registration is a NO-OP and the state stays shape-only (verified:false).
// FAIL LOUD with an install hint if KOLM_NRAS_VERIFIER=1 but the root cert is
// missing - never silently pass.
//
// The heavy cert-chain / EAT parsing lives in workers/nras_verifier.py (NVIDIA's
// nv-attestation-sdk path is cleanest in Python). This JS shim calls it over the
// existing worker-RPC seam (spawnSync, JSON over stdin/stdout) and registers a
// verifier fn that awaits the worker result. NO new npm dep.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAttestationVerifier, KINDS } from './confidential-compute.js';

export const NRAS_VERIFIER_VERSION = 'c1-nras-verifier-v1';
export const NRAS_REPLAY_TTL_MS = 24 * 60 * 60 * 1000; // 24h replay window

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(__dirname, '..', 'workers', 'nras_verifier.py');

// ---------------------------------------------------------------------------
// nonceBinding(input_digest, output_digest) -> sha256 hex of the concatenated
// digest BYTES. This is the value the caller MUST have requested the GPU
// attestation with as eat_nonce. Inputs are hex digests; we concat the raw
// bytes (input || output) then sha256. PRIVACY: only digests are touched.
// ---------------------------------------------------------------------------
export function nonceBinding(input_digest, output_digest) {
  const a = Buffer.from(String(input_digest || ''), 'hex');
  const b = Buffer.from(String(output_digest || ''), 'hex');
  return crypto.createHash('sha256').update(Buffer.concat([a, b])).digest('hex');
}

function _pythonBin() {
  return process.env.KOLM_PYTHON || process.env.PYTHON || 'python3';
}

// ---------------------------------------------------------------------------
// callWorker(payload, opts) -> parsed JSON result (sync). Spawns the Python
// worker, writes the JSON payload to stdin, reads JSON from stdout. NEVER throws
// to the caller path the way that would crash a served call - returns a
// structured { ok:false, reason } on any failure.
// ---------------------------------------------------------------------------
function callWorker(payload, opts = {}) {
  const rootCert = opts.rootCert || process.env.KOLM_NRAS_ROOT_CERT || null;
  const args = [WORKER_PATH, '--root-cert', String(rootCert || '')];
  let res;
  try {
    res = spawnSync(_pythonBin(), args, {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: opts.timeoutMs || 20000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return { ok: false, reason: `worker_spawn_failed:${e.message}` };
  }
  if (res.error) return { ok: false, reason: `worker_error:${res.error.message}` };
  if (res.status !== 0) {
    return { ok: false, reason: `worker_exit_${res.status}`, stderr: (res.stderr || '').slice(0, 512) };
  }
  let out;
  try { out = JSON.parse(res.stdout); }
  catch (e) { return { ok: false, reason: `worker_bad_json:${e.message}`, stdout: (res.stdout || '').slice(0, 512) }; }
  return out;
}

// ---------------------------------------------------------------------------
// makeNrasVerifier(opts) -> async fn(report, verifyOpts) matching the
// registerAttestationVerifier('nras', fn) contract.
//
// The verifier:
//   1. Computes the EXPECTED nonce = sha256(input_digest||output_digest) from
//      verifyOpts (the call the report is supposed to cover).
//   2. Hands the report + expected nonce + replay TTL + root cert path to the
//      Python worker, which does JWT-sig + cert-chain + not_after + revocation
//      + nonce-binding + replay-TTL checks.
//   3. Returns { ok, verifier:'nras', trust_root, not_after, cert_chain_length,
//      revocation_checked_at } on success; { ok:false, reason } otherwise.
//
// NONCE-BINDING is enforced in BOTH places (defense in depth): the worker checks
// eat_nonce === expected, and the JS shim re-checks the worker's reported nonce.
// ---------------------------------------------------------------------------
export function makeNrasVerifier(opts = {}) {
  const rootCert = opts.rootCert || process.env.KOLM_NRAS_ROOT_CERT || null;
  return async function nrasVerify(report, verifyOpts = {}) {
    const input_digest = verifyOpts.input_digest || verifyOpts.inputDigest || null;
    const output_digest = verifyOpts.output_digest || verifyOpts.outputDigest || null;
    if (!input_digest || !output_digest) {
      return { ok: false, verifier: 'nras', reason: 'missing_input_or_output_digest_for_nonce_binding' };
    }
    const expected_nonce = nonceBinding(input_digest, output_digest);

    const worker = callWorker({
      attestation_report: report && report.attestation_report,
      cert_chain: report && report.cert_chain,
      eat_nonce: report && (report.eat_nonce || report.nonce),
      expected_nonce,
      replay_ttl_ms: opts.replayTtlMs || NRAS_REPLAY_TTL_MS,
      now_ms: typeof verifyOpts.now_ms === 'number' ? verifyOpts.now_ms : Date.now(),
    }, { rootCert, timeoutMs: opts.timeoutMs });

    if (!worker || worker.ok !== true) {
      return { ok: false, verifier: 'nras', reason: (worker && worker.reason) || 'worker_returned_falsy' };
    }
    // Defense in depth: the nonce the worker echoed back MUST equal expected.
    if (String(worker.eat_nonce || '').toLowerCase() !== expected_nonce.toLowerCase()) {
      return { ok: false, verifier: 'nras', reason: 'nonce_binding_mismatch' };
    }
    return {
      ok: true,
      verifier: 'nras',
      trust_root: worker.trust_root || null,
      not_after: worker.not_after || null,
      cert_chain_length: worker.cert_chain_length || null,
      revocation_checked_at: worker.revocation_checked_at || null,
      report_hash: worker.report_hash || null,
    };
  };
}

// ---------------------------------------------------------------------------
// registerNrasVerifier() - boot-time registration behind the env gate.
//
//   - KOLM_NRAS_VERIFIER unset/!=1  -> NO-OP. listRegisteredVerifiers() will not
//     include 'nras'; verifyAttestation('nras', report) stays shape-only.
//   - KOLM_NRAS_VERIFIER=1 + KOLM_NRAS_ROOT_CERT present -> register the real fn.
//   - KOLM_NRAS_VERIFIER=1 + root cert MISSING -> THROW a LOUD install hint
//     (never silently pass).
//
// Returns { registered:boolean, reason? }.
// ---------------------------------------------------------------------------
export function registerNrasVerifier(opts = {}) {
  const gate = opts.gate != null ? opts.gate : process.env.KOLM_NRAS_VERIFIER;
  if (String(gate) !== '1') {
    return { registered: false, reason: 'env_gate_off' };
  }
  const rootCert = opts.rootCert || process.env.KOLM_NRAS_ROOT_CERT || null;
  if (!rootCert || !fs.existsSync(rootCert)) {
    throw new Error(
      'KOLM_NRAS_VERIFIER=1 but the NVIDIA NRAS root cert is missing. ' +
      'Set KOLM_NRAS_ROOT_CERT to the PEM path of the pinned NVIDIA root ' +
      '(see https://docs.nvidia.com/attestation/ and the nv-attestation-sdk). ' +
      'Install the Python worker deps: pip install nv-attestation-sdk cryptography PyJWT. ' +
      `Looked for cert at: ${rootCert || '(unset)'}`
    );
  }
  if (!fs.existsSync(WORKER_PATH)) {
    throw new Error(
      `KOLM_NRAS_VERIFIER=1 but the worker is missing at ${WORKER_PATH}. ` +
      'Reinstall the kolm workers bundle.'
    );
  }
  const fn = makeNrasVerifier({ rootCert, ...opts });
  registerAttestationVerifier(KINDS.NRAS, fn);
  return { registered: true, root_cert: rootCert, version: NRAS_VERIFIER_VERSION };
}

export const NRAS_VERIFIER_SPEC = {
  version: NRAS_VERIFIER_VERSION,
  kind: KINDS.NRAS,
  replay_ttl_ms: NRAS_REPLAY_TTL_MS,
  binding: 'sha256(input_digest||output_digest)',
  env_gate: 'KOLM_NRAS_VERIFIER=1 + KOLM_NRAS_ROOT_CERT',
  privacy: 'only digests + NRAS token cross the worker boundary; no plaintext',
};

export default {
  NRAS_VERIFIER_VERSION,
  NRAS_REPLAY_TTL_MS,
  nonceBinding,
  makeNrasVerifier,
  registerNrasVerifier,
  NRAS_VERIFIER_SPEC,
};
