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

export const SUPPORTED_TARGETS = ['aws-nitro', 'sev-snp', 'tdx', 'gcp-cvm', 'azure-cvm', 'docker'];

const PARSERS = {
  'aws-nitro': parseNitroAttestation,
  'sev-snp':   parseSevSnpAttestation,
  'tdx':       parseTdxAttestation,
  'gcp-cvm':   parseGcpCvmAttestation,
  'azure-cvm': parseAzureCvmAttestation,
  'docker':    parseDockerAttestation,
};

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
  if (!parsed.ok) return { valid: false, reasons: parsed.errors, parsed };

  const reasons = [];
  if (expected.measurement && parsed.measurement !== expected.measurement) {
    reasons.push(`measurement mismatch: stored=${expected.measurement} attested=${parsed.measurement}`);
  }
  if (expected.vendor && parsed.vendor !== expected.vendor) {
    reasons.push(`vendor mismatch: stored=${expected.vendor} attested=${parsed.vendor}`);
  }
  if (expected.min_signed_at && parsed.claims?.signed_at) {
    if (parsed.claims.signed_at < expected.min_signed_at) {
      reasons.push(`attestation too old: ${parsed.claims.signed_at} < ${expected.min_signed_at}`);
    }
  }

  return {
    valid: reasons.length === 0,
    reasons,
    parsed,
  };
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
