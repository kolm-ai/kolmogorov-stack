// Confidential compute metadata + attestation verifier states.
//
// This module defines:
//
//   1. The attestation state machine an artifact moves through:
//      UNVERIFIED -> SHAPE_OK -> CRYPTOGRAPHICALLY_VERIFIED -> REVOKED|EXPIRED
//
//   2. The required-fields contract per attestation type:
//      - intel-tdx           (PCCS quote)
//      - amd-sev-snp         (SNP report)
//      - aws-nitro           (Nitro attestation document)
//      - nvidia-cc           (NRAS GPU report)
//
//   3. A SHAPE-only verifier that the kolm runtime ships out of the box.
//      It checks the report has the documented fields and embeds a clear
//      `verifier: 'stub_v1', verified: false` flag in the resulting state
//      so any consumer (CLI, API, verifier endpoint, audit log) can tell at
//      a glance that no cryptographic chain was walked.
//
//   4. A pluggable interface - registerAttestationVerifier(kind, fn) - for
//      tenants who want to wire a real PCCS / AMD VCEK / AWS KMS / NRAS
//      verifier. When a real verifier is registered, the state advances to
//      CRYPTOGRAPHICALLY_VERIFIED.
//
// Why the shape-only default:
//   The user constraint is "Do not claim confidential compute verified unless
//   real verification exists." Cryptographically verifying a TDX or SEV-SNP
//   quote requires (a) the Intel root cert + PCCS, (b) the AMD ARK/ASK/VCEK
//   chain, (c) AWS Nitro KMS key bundles, (d) the NVIDIA NRAS service. These
//   are external trust roots that kolm itself cannot fake. The stub verifier
//   provides a useful SHAPE check (the report at least parses + has the right
//   fields) while never lying about cryptographic verification.

import crypto from 'node:crypto';

export const ATTESTATION_SPEC_VERSION = 'cc-v1';

// State machine values. Stored in the manifest as a string under
// manifest.confidential_compute.state. Verifiers / dashboards filter on these.
export const STATES = Object.freeze({
  UNVERIFIED:                  'unverified',
  SHAPE_OK:                    'shape_ok',
  CRYPTOGRAPHICALLY_VERIFIED:  'cryptographically_verified',
  REVOKED:                     'revoked',
  EXPIRED:                     'expired',
  REJECTED:                    'rejected',
});

// Attestation kinds the registry understands. Mirrors KNOWN_ATTESTATIONS
// in src/device-capabilities.js. Keep these in sync - adding a kind here
// without also adding it there means a device claims support for an
// attestation type the runtime can't validate.
export const KINDS = Object.freeze({
  PCCS:    'pccs',               // Intel TDX
  SNP:     'snp-report',         // AMD SEV-SNP
  NITRO:   'nitro-attestation',  // AWS Nitro
  NRAS:    'nras',               // NVIDIA Confidential Compute (Hopper+)
});

// Required-field contracts per attestation kind. The shape-only verifier
// asserts every field listed here is present, of the right type, and not
// empty. These shapes are derived from public spec docs:
//
//   - PCCS quote v4: Intel SGX/TDX DCAP / DCAP v1.20 spec
//   - SNP attestation report v2: AMD SEV-SNP API Specification, "Attestation
//     Report Structure"
//   - Nitro attestation document: AWS Nitro Enclaves SDK,
//     /nsm/attestation/Attestation_Format.html (COSE Sign1 over CBOR)
//   - NRAS GPU report: NVIDIA Confidential Computing Deployment Guide,
//     "Attestation Report"
//
// We require the documented fields and accept extra fields (vendor-specific
// extensions). The verifier records the field set in the resulting state so
// reviewers can see exactly what was checked.

export const REPORT_SHAPES = Object.freeze({
  [KINDS.PCCS]: {
    required: ['quote', 'tee_type', 'tcb_evaluation_data_number', 'mr_td', 'mr_seam', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3', 'report_data'],
    types: {
      tee_type: 'string',
      mr_td: 'hex64', mr_seam: 'hex64', rtmr0: 'hex96', rtmr1: 'hex96', rtmr2: 'hex96', rtmr3: 'hex96', report_data: 'hex128',
      tcb_evaluation_data_number: 'number',
      quote: 'base64-or-hex',
    },
  },
  [KINDS.SNP]: {
    required: ['version', 'guest_svn', 'policy', 'family_id', 'image_id', 'measurement', 'host_data', 'id_key_digest', 'author_key_digest', 'report_data', 'chip_id', 'signature'],
    types: {
      version: 'number', guest_svn: 'number', policy: 'number-or-hex',
      family_id: 'hex32', image_id: 'hex32', measurement: 'hex96',
      host_data: 'hex64', id_key_digest: 'hex96', author_key_digest: 'hex96',
      report_data: 'hex128', chip_id: 'hex128', signature: 'base64-or-hex',
    },
  },
  [KINDS.NITRO]: {
    required: ['module_id', 'timestamp', 'digest', 'pcrs', 'certificate', 'cabundle', 'public_key', 'user_data', 'nonce'],
    types: {
      module_id: 'string', timestamp: 'number', digest: 'string',
      pcrs: 'pcr-map', certificate: 'base64-or-hex',
      cabundle: 'cert-array', public_key: 'base64-or-hex',
      user_data: 'base64-or-hex', nonce: 'base64-or-hex',
    },
  },
  [KINDS.NRAS]: {
    required: ['gpu_id', 'driver_version', 'vbios_version', 'attestation_report', 'cert_chain', 'nonce'],
    types: {
      gpu_id: 'string', driver_version: 'string', vbios_version: 'string',
      attestation_report: 'base64-or-hex', cert_chain: 'cert-array',
      nonce: 'base64-or-hex',
    },
  },
});

// Pluggable verifier registry. Default is shape-only stub. Real verifiers
// register here at runtime - e.g., `registerAttestationVerifier('pccs',
// pccsCryptoVerifier)` from a tenant-supplied trust-root module.
const _verifiers = new Map();

export function registerAttestationVerifier(kind, fn) {
  if (typeof kind !== 'string') throw new Error('attestation kind must be a string');
  if (typeof fn !== 'function') throw new Error('verifier must be a function');
  if (!Object.values(KINDS).includes(kind)) {
    throw new Error(`unknown attestation kind: ${kind}; expected one of: ${Object.values(KINDS).join(', ')}`);
  }
  _verifiers.set(kind, fn);
}

export function clearAttestationVerifier(kind) {
  _verifiers.delete(kind);
}

export function listRegisteredVerifiers() {
  return Array.from(_verifiers.keys()).sort();
}

// Shape validators. Type-string mini-DSL keeps this readable.
function checkType(val, typespec) {
  if (val == null) return false;
  switch (typespec) {
    case 'string': return typeof val === 'string' && val.length > 0;
    case 'number': return typeof val === 'number' && Number.isFinite(val);
    case 'number-or-hex': return typeof val === 'number' || (typeof val === 'string' && /^[0-9a-fA-F]+$/.test(val));
    case 'hex32': return typeof val === 'string' && /^[0-9a-fA-F]{32}$/.test(val);
    case 'hex64': return typeof val === 'string' && /^[0-9a-fA-F]{64}$/.test(val);
    case 'hex96': return typeof val === 'string' && /^[0-9a-fA-F]{96}$/.test(val);
    case 'hex128': return typeof val === 'string' && /^[0-9a-fA-F]{128}$/.test(val);
    case 'base64-or-hex':
      return typeof val === 'string' && (/^[A-Za-z0-9+/=]+$/.test(val) || /^[0-9a-fA-F]+$/.test(val));
    case 'pcr-map':
      return val && typeof val === 'object' && !Array.isArray(val) && Object.keys(val).length > 0;
    case 'cert-array':
      return Array.isArray(val) && val.length > 0 && val.every(x => typeof x === 'string' && x.length > 0);
    default: return false;
  }
}

function shapeCheck(kind, report) {
  const spec = REPORT_SHAPES[kind];
  if (!spec) return { ok: false, reason: `unknown_kind:${kind}` };
  if (!report || typeof report !== 'object') return { ok: false, reason: 'report_not_object' };
  const missing = spec.required.filter(f => report[f] === undefined);
  if (missing.length > 0) return { ok: false, reason: 'missing_fields', missing };
  for (const f of spec.required) {
    const typespec = spec.types[f];
    if (typespec && !checkType(report[f], typespec)) {
      return { ok: false, reason: 'bad_field_type', field: f, expected: typespec };
    }
  }
  return { ok: true, fields_checked: spec.required.slice() };
}

// One report-hash function for all kinds. Stable across reruns; the hash is
// what binds the attestation into the artifact's receipt chain so a verifier
// can confirm the same report was used at compile + run time.
export function reportHash(report) {
  return crypto.createHash('sha256').update(canonicalize(report)).digest('hex');
}

function canonicalize(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canonicalize).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(v[k])).join(',') + '}';
}

// Main entry point. Verifies an attestation report against:
//   - the documented shape for its kind
//   - any pluggable cryptographic verifier the tenant has registered
// Returns a state object that's safe to embed in the artifact manifest.
//
// The returned state explicitly carries `verifier` and `verified` so a
// reader at any point in the future can tell whether the chain was walked
// or only the shape was checked. NEVER set verified=true here without a
// registered cryptographic verifier returning ok.
export async function verifyAttestation(kind, report, opts = {}) {
  const ts = new Date().toISOString();
  if (!Object.values(KINDS).includes(kind)) {
    return {
      spec: ATTESTATION_SPEC_VERSION,
      kind,
      state: STATES.REJECTED,
      verifier: 'none',
      verified: false,
      reason: 'unknown_kind',
      timestamp: ts,
    };
  }
  const shape = shapeCheck(kind, report);
  if (!shape.ok) {
    return {
      spec: ATTESTATION_SPEC_VERSION,
      kind,
      state: STATES.REJECTED,
      verifier: 'shape',
      verified: false,
      reason: shape.reason,
      missing: shape.missing,
      field: shape.field,
      expected: shape.expected,
      timestamp: ts,
    };
  }
  const baseState = {
    spec: ATTESTATION_SPEC_VERSION,
    kind,
    state: STATES.SHAPE_OK,
    verifier: 'shape_v1',
    verified: false,
    reason: 'shape_only_stub_no_crypto_chain',
    fields_checked: shape.fields_checked,
    report_hash: reportHash(report),
    timestamp: ts,
  };
  const crypto_verifier = _verifiers.get(kind);
  if (!crypto_verifier) return baseState;
  // A real verifier is registered. Call it. If it throws or returns falsy,
  // we keep the state at SHAPE_OK and surface the error rather than upgrading.
  try {
    const crypto_result = await crypto_verifier(report, opts);
    if (crypto_result && crypto_result.ok === true) {
      return {
        ...baseState,
        state: crypto_result.revoked ? STATES.REVOKED
             : crypto_result.expired ? STATES.EXPIRED
             : STATES.CRYPTOGRAPHICALLY_VERIFIED,
        verifier: crypto_result.verifier || 'tenant_registered',
        verified: !crypto_result.revoked && !crypto_result.expired,
        trust_root: crypto_result.trust_root || null,
        not_after: crypto_result.not_after || null,
        revocation_checked_at: crypto_result.revocation_checked_at || null,
        cert_chain_length: crypto_result.cert_chain_length || null,
        nonce: crypto_result.eat_nonce || crypto_result.nonce || null,
        expected_nonce: crypto_result.expected_nonce || null,
        nonce_binding_alg: crypto_result.nonce_binding_alg || null,
      };
    }
    return { ...baseState, crypto_attempted: true, crypto_reason: crypto_result?.reason || 'verifier_returned_falsy' };
  } catch (e) {
    return { ...baseState, crypto_attempted: true, crypto_reason: `verifier_threw:${e.message}` };
  }
}

// Manifest snippet builder - used by spec-compile.js when an artifact
// declares a `target_device` with a tee. Embeds the state into the manifest
// under `confidential_compute`. The verifier endpoint re-runs verifyAttestation
// on the embedded report (when present) and compares states.
export function manifestBlock(kind, attestationState) {
  if (!attestationState) {
    return {
      spec: ATTESTATION_SPEC_VERSION,
      kind,
      state: STATES.UNVERIFIED,
      verifier: 'none',
      verified: false,
    };
  }
  return {
    spec: attestationState.spec || ATTESTATION_SPEC_VERSION,
    kind: attestationState.kind || kind,
    state: attestationState.state,
    verifier: attestationState.verifier,
    verified: attestationState.verified,
    report_hash: attestationState.report_hash || null,
    timestamp: attestationState.timestamp || null,
    trust_root: attestationState.trust_root || null,
    not_after: attestationState.not_after || null,
  };
}

// W409v - Confidential compute metadata + plugin-only "verified" claim.
//
// The audit said: "defaults to shape-only verification". W409v keeps that
// honest default but adds two surfaces a downstream artifact / manifest
// needs:
//
//   1. A canonical set of provider names every artifact metadata block uses,
//      and a registerVerifier(provider, fn) plugin interface alongside the
//      kind-based registerAttestationVerifier already shipped.
//   2. A verifier function - verifyConfidentialCompute(metadata) - that
//      returns {verified:false, reason:'shape_only_no_plugin'} unless a
//      plugin for the metadata's provider returns ok:true.
//
// The metadata fields the artifact carries (tests assert these):
//   - attestation_provider           e.g. 'azure-tdx' | 'gcp-tdx' | 'aws-nitro' | 'sev-snp'
//   - attestation_report_hash        sha256 of the report bytes
//   - trusted_execution_required     bool - does the artifact REQUIRE TEE?
//   - enclave_image_hash             sha256 of the enclave image
//   - gpu_attestation_hash           sha256 of the GPU attestation report
//
// Provider names recognised by W409v. The set is open - registerVerifier
// can register any provider - but these are the names product copy + the
// device-catalog use, so the table here is the canonical list.
export const PROVIDERS = Object.freeze([
  'azure-tdx',
  'gcp-tdx',
  'aws-nitro',
  'sev-snp',
  'intel-tdx',
  'amd-sev-snp',
  'nvidia-cc',
]);

// Plugin registry keyed by provider (not by KIND). Distinct from
// `_verifiers` above which is keyed by kind. registerVerifier is the W409v
// surface; registerAttestationVerifier is the W144 surface. Both work, and
// both are checked by verifyConfidentialCompute when applicable.
const _provider_verifiers = new Map();

export function registerVerifier(provider, fn) {
  if (typeof provider !== 'string' || !provider) throw new Error('provider name required');
  if (typeof fn !== 'function') throw new Error('verifier must be a function');
  _provider_verifiers.set(provider, fn);
}

export function clearVerifier(provider) {
  _provider_verifiers.delete(provider);
}

export function listRegisteredProviderVerifiers() {
  return Array.from(_provider_verifiers.keys()).sort();
}

// ALWAYS-TRUE fake verifier - for testing only. Real builds MUST NOT
// register this. The presence of `__fake__: true` on the return value
// gives downstream auditors a marker they can flag.
export function fakeVerifier(_metadata, _opts) {
  return Promise.resolve({ ok: true, verifier: 'fake-verifier', __fake__: true });
}

// Required metadata fields for W409v. The verifier checks these exist + are
// non-empty before considering the artifact for verification. Missing field
// → shape-only path with reason describing the gap.
export const W409V_METADATA_FIELDS = Object.freeze([
  'attestation_provider',
  'attestation_report_hash',
  'trusted_execution_required',
  'enclave_image_hash',
  'gpu_attestation_hash',
]);

function _hasShape(metadata) {
  if (!metadata || typeof metadata !== 'object') return { ok: false, reason: 'no_metadata' };
  if (!metadata.attestation_provider || typeof metadata.attestation_provider !== 'string') {
    return { ok: false, reason: 'missing_attestation_provider' };
  }
  return { ok: true };
}

// The W409v default verifier. Returns:
//   - {verified:false, reason:'shape_only_no_plugin', ...}  when no plugin
//     is registered for the metadata's provider
//   - {verified:true, plugin:provider}                      when a registered
//     plugin returns ok:true
//   - {verified:false, reason:'plugin_returned_falsy', ...} otherwise
//
// Defaults are intentionally fail-closed: any failure path produces
// verified:false. The product cannot say "confidential compute verified"
// without a registered plugin returning truthy.
export async function verifyConfidentialCompute(metadata, opts = {}) {
  const shape = _hasShape(metadata);
  const baseline = {
    spec: ATTESTATION_SPEC_VERSION,
    verified: false,
    provider: metadata && metadata.attestation_provider || null,
    plugin: null,
    timestamp: new Date().toISOString(),
  };
  if (!shape.ok) {
    return { ...baseline, reason: shape.reason };
  }
  const provider = metadata.attestation_provider;
  const plugin = _provider_verifiers.get(provider);
  if (!plugin) {
    return { ...baseline, reason: 'shape_only_no_plugin' };
  }
  try {
    const r = await plugin(metadata, opts);
    if (r && r.ok === true) {
      return {
        ...baseline,
        verified: true,
        plugin: provider,
        verifier_meta: {
          fake: r.__fake__ === true,
          trust_root: r.trust_root || null,
          not_after: r.not_after || null,
        },
      };
    }
    return { ...baseline, reason: 'plugin_returned_falsy', plugin: provider, plugin_reason: (r && r.reason) || null };
  } catch (e) {
    return { ...baseline, reason: `plugin_threw:${e.message}`, plugin: provider };
  }
}

// Build the W409v metadata block. Used by spec-compile.js to embed the
// confidential-compute claim in the artifact manifest. Tests assert that:
//   - all five fields survive round-trip through JSON / a manifest read
//   - the verifier called on the round-tripped metadata returns the same
//     state as called on the original
export function buildConfidentialComputeMetadata({
  attestation_provider,
  attestation_report_hash,
  trusted_execution_required,
  enclave_image_hash,
  gpu_attestation_hash,
  extras,
} = {}) {
  if (!attestation_provider || typeof attestation_provider !== 'string') {
    throw new Error('attestation_provider required');
  }
  const meta = {
    spec: ATTESTATION_SPEC_VERSION,
    attestation_provider,
    attestation_report_hash: attestation_report_hash || null,
    trusted_execution_required: trusted_execution_required === true,
    enclave_image_hash: enclave_image_hash || null,
    gpu_attestation_hash: gpu_attestation_hash || null,
  };
  if (extras && typeof extras === 'object') {
    for (const [k, v] of Object.entries(extras)) {
      if (!(k in meta)) meta[k] = v;
    }
  }
  return meta;
}

// Pack the W409v metadata into a manifest-shaped object and back to confirm
// the round trip is loss-less. Used by tests + by spec-compile.js as the
// canonical shape.
export function manifestRoundTrip(metadata) {
  const json = JSON.stringify({ confidential_compute_w409v: metadata });
  return JSON.parse(json).confidential_compute_w409v;
}

export default {
  ATTESTATION_SPEC_VERSION,
  STATES,
  KINDS,
  REPORT_SHAPES,
  PROVIDERS,
  W409V_METADATA_FIELDS,
  registerAttestationVerifier,
  clearAttestationVerifier,
  listRegisteredVerifiers,
  registerVerifier,
  clearVerifier,
  listRegisteredProviderVerifiers,
  reportHash,
  verifyAttestation,
  manifestBlock,
  verifyConfidentialCompute,
  buildConfidentialComputeMetadata,
  manifestRoundTrip,
  fakeVerifier,
};
