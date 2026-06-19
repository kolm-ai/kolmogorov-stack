// kolm-attestation — TEE attestation parsing and verification.
//
// Public surface: parseAttestation(target, payload), verifyAttestation(target,
// payload, expected). Per-target modules under ./<target>.js implement the
// vendor-specific format. This top-level dispatcher normalizes the result so
// callers handle one shape regardless of which TEE produced the report.
//
// Today (v0.1):
//   - Each parser extracts the *measurement* (the hash being attested) and
//     vendor claims from a raw report payload.
//   - The dispatcher records the result so downstream code (kolm.ai BYOC
//     deployment store) can compare a re-attestation against the first one.
//   - Cryptographic verification of the vendor signing chain is stubbed.
//     The parsers expose `signing_cert_chain` so the next sprint can plug in
//     the AWS Nitro root, AMD ARK/ASK, Intel PCS, etc.
//
// Why TOFU (trust on first use) is acceptable today:
//   - The kolm runtime never executes the attested binary itself — kolm.ai
//     only records that *this* measurement is what the operator deployed.
//   - The operator is the trust root; we surface the measurement so they
//     can compare it against the artifact's CID + signature chain.
//
// Future:
//   - Full vendor cert chain verification.
//   - Cross-reference measurement against a published reproducible build.
//   - Transparency log anchors (Sigstore / Rekor) for the measurement.

import { parseNitroAttestation } from './nitro.js';
import { parseSevSnpAttestation } from './sev-snp.js';
import { parseTdxAttestation } from './tdx.js';
import { parseGcpCvmAttestation } from './gcp-cvm.js';
import { parseAzureCvmAttestation } from './azure-cvm.js';
export {
  BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
  buildBuiltinAttestationVerifier,
  fingerprintChainMaterial,
  listBuiltinAttestationVerifierSpecs,
  registerBuiltinAttestationVerifiers,
} from './vendor-chain-verifiers.js';

export const SUPPORTED_TARGETS = ['aws-nitro', 'sev-snp', 'tdx', 'gcp-cvm', 'azure-cvm', 'docker'];
export const HARDWARE_ATTESTATION_TARGETS = Object.freeze(['aws-nitro', 'sev-snp', 'tdx', 'gcp-cvm', 'azure-cvm']);
export const VERIFICATION_TIERS = Object.freeze({
  SOFTWARE_MEASUREMENT: 'software_measurement',
  PARSED_UNVERIFIED: 'parsed_unverified',
  TOFU_MEASUREMENT: 'tofu_measurement',
  CRYPTOGRAPHIC_VENDOR_CHAIN: 'cryptographic_vendor_chain',
});

const PARSERS = {
  'aws-nitro': parseNitroAttestation,
  'sev-snp':   parseSevSnpAttestation,
  'tdx':       parseTdxAttestation,
  'gcp-cvm':   parseGcpCvmAttestation,
  'azure-cvm': parseAzureCvmAttestation,
  'docker':    parseDockerAttestation,
};

const VERIFIERS = new Map();

export function registerAttestationVerifier(target, fn) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    throw new Error(`unsupported target: ${target}`);
  }
  if (typeof fn !== 'function') {
    throw new Error('attestation verifier must be a function');
  }
  VERIFIERS.set(target, fn);
}

export function clearAttestationVerifier(target) {
  VERIFIERS.delete(target);
}

export function listRegisteredAttestationVerifiers() {
  return Array.from(VERIFIERS.keys()).sort();
}

// Parse a raw attestation payload. Returns a normalized object:
//
//   {
//     ok: boolean,
//     target: string,
//     vendor: 'aws' | 'amd' | 'intel' | 'gcp' | 'azure' | 'docker',
//     measurement: string | null,      // hex-encoded hash of the workload
//     claims: object,                  // vendor-specific extra fields
//     signing_cert_chain: string[] | null,  // PEM-encoded; null when N/A
//     parsed_at: ISO string,
//     errors: string[],
//   }
//
// `payload` may be a Buffer, base64 string, CBOR/JSON string, or a JS object
// — each parser handles its own input shapes.
export function parseAttestation(target, payload) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    return errorResult(target, `unsupported target: ${target}`);
  }
  const parser = PARSERS[target];
  try {
    const result = parser(payload);
    return {
      ok: true,
      target,
      ...result,
      parsed_at: new Date().toISOString(),
      errors: [],
    };
  } catch (err) {
    return errorResult(target, String(err.message || err));
  }
}

function isHardwareTarget(target) {
  return HARDWARE_ATTESTATION_TARGETS.includes(target);
}

function normalizeExpected(expected) {
  return expected && typeof expected === 'object' ? expected : {};
}

function wantsTofu(expected) {
  return expected.allow_tofu === true || expected.trust_policy === 'tofu';
}

function wantsCryptographic(target, expected) {
  if (expected.require_cryptographic === true || expected.require_crypto === true) return true;
  if (expected.require_cryptographic === false || expected.require_crypto === false) return false;
  return isHardwareTarget(target) && !wantsTofu(expected);
}

function runRegisteredVerifier(target, parsed, expected) {
  const verifier = VERIFIERS.get(target);
  if (!verifier) return null;
  try {
    const out = verifier(parsed, { target, expected });
    if (out && typeof out.then === 'function') {
      return { ok: false, reason: 'async_verifier_not_supported_by_sync_api' };
    }
    return out && typeof out === 'object' ? out : { ok: false, reason: 'verifier_returned_falsy' };
  } catch (err) {
    return { ok: false, reason: `verifier_threw:${err && err.message ? err.message : 'unknown'}` };
  }
}

export function evaluateParsedAttestation(target, parsed, expected = {}) {
  const policy = normalizeExpected(expected);
  const reasons = [];
  if (!parsed || parsed.ok !== true) {
    return {
      valid: false,
      reasons: parsed?.errors || ['attestation parse failed'],
      parsed,
      tier: VERIFICATION_TIERS.PARSED_UNVERIFIED,
      cryptographic: false,
      trust_policy: isHardwareTarget(target) ? 'require_cryptographic' : 'parse_only',
      verifier: null,
      trust_root: null,
    };
  }

  if (policy.measurement && parsed.measurement !== policy.measurement) {
    reasons.push(`measurement mismatch: stored=${policy.measurement} attested=${parsed.measurement}`);
  }
  if (policy.vendor && parsed.vendor !== policy.vendor) {
    reasons.push(`vendor mismatch: stored=${policy.vendor} attested=${parsed.vendor}`);
  }
  if (policy.min_signed_at && parsed.claims?.signed_at) {
    if (parsed.claims.signed_at < policy.min_signed_at) {
      reasons.push(`attestation too old: ${parsed.claims.signed_at} < ${policy.min_signed_at}`);
    }
  }

  let verifierResult = null;
  let cryptographic = false;
  let tier = target === 'docker'
    ? VERIFICATION_TIERS.SOFTWARE_MEASUREMENT
    : VERIFICATION_TIERS.PARSED_UNVERIFIED;

  if (isHardwareTarget(target)) {
    verifierResult = runRegisteredVerifier(target, parsed, policy);
    if (verifierResult) {
      if (verifierResult.ok === true) {
        cryptographic = true;
        tier = VERIFICATION_TIERS.CRYPTOGRAPHIC_VENDOR_CHAIN;
      } else {
        reasons.push(`attestation verifier rejected: ${verifierResult.reason || 'unknown'}`);
      }
    }

    if (!cryptographic) {
      if (wantsCryptographic(target, policy)) {
        reasons.push(`cryptographic attestation verifier required for ${target}`);
      } else if (wantsTofu(policy)) {
        tier = VERIFICATION_TIERS.TOFU_MEASUREMENT;
      }
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    parsed,
    tier,
    cryptographic,
    trust_policy: isHardwareTarget(target)
      ? (cryptographic ? 'cryptographic_vendor_chain' : (wantsTofu(policy) ? 'explicit_tofu' : 'require_cryptographic'))
      : 'software_measurement',
    verifier: verifierResult?.verifier || null,
    trust_root: verifierResult?.trust_root || null,
    verifier_result: verifierResult || null,
  };
}

// Verify a parsed attestation against an `expected` envelope:
//
//   expected = {
//     measurement?: string,           // exact match required if provided
//     min_signed_at?: ISO string,     // attestation must be newer than this
//     vendor?: string,                // must match (aws|amd|intel|gcp|azure)
//   }
//
// Returns { valid: boolean, reasons: string[], parsed }.
export function verifyAttestation(target, payload, expected = {}) {
  const parsed = parseAttestation(target, payload);
  return evaluateParsedAttestation(target, parsed, expected);
}

// Dispatch helper for kolm BYOC `recordAttestation`. Given the target and
// payload, returns the normalized measurement string the BYOC store should
// pin on the deployment.
export function extractMeasurement(target, payload) {
  const parsed = parseAttestation(target, payload);
  return parsed.ok ? parsed.measurement : null;
}

function errorResult(target, message) {
  return {
    ok: false,
    target,
    vendor: null,
    measurement: null,
    claims: {},
    signing_cert_chain: null,
    parsed_at: new Date().toISOString(),
    errors: [message],
  };
}

// Docker target: not a TEE. Returns a software-only measurement (the sha256
// of the deployed image bytes the operator reports). Surfaced as `vendor:
// 'docker'` so callers can tell the difference between a hardware-attested
// deployment and a plain Docker container.
function parseDockerAttestation(payload) {
  const measurement = typeof payload === 'string'
    ? payload.match(/^sha256:[0-9a-f]{64}$/i)?.[0] || null
    : payload?.measurement || null;
  if (!measurement) throw new Error('docker attestation requires sha256:<hex> measurement');
  return {
    vendor: 'docker',
    measurement: measurement.toLowerCase(),
    claims: { note: 'software-only measurement; not hardware-attested' },
    signing_cert_chain: null,
  };
}
