// W1026 - built-in fail-closed vendor-chain verifier plugins.
//
// These plugins validate verifier-facing collateral the parsers expose:
// vendor/measurement shape, non-empty report-signature evidence where the
// parser can expose it, and a caller-pinned root fingerprint over the supplied
// certificate/collateral chain. They do not fetch vendor roots over the network.

import crypto from 'node:crypto';

export const BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION = 'w1026-vendor-chain-verifiers-v1';

const TARGET_SPECS = Object.freeze({
  'aws-nitro': Object.freeze({
    target: 'aws-nitro',
    vendor: 'aws',
    root_family: 'aws-nitro-root',
    measurement_prefix: 'pcr0:sha384:',
    chain_name: 'AWS Nitro cabundle',
    min_chain_len: 1,
  }),
  'sev-snp': Object.freeze({
    target: 'sev-snp',
    vendor: 'amd',
    root_family: 'amd-ark-ask',
    measurement_prefix: 'mrtd:sha384:',
    chain_name: 'AMD VCEK/ASK/ARK chain',
    min_chain_len: 2,
    require_raw_signature: true,
  }),
  tdx: Object.freeze({
    target: 'tdx',
    vendor: 'intel',
    root_family: 'intel-pcs-pck',
    measurement_prefix: 'mrtd:sha384:',
    chain_name: 'Intel PCS/PCK chain',
    min_chain_len: 1,
    require_quote_signature_data: true,
  }),
  'gcp-cvm': Object.freeze({
    target: 'gcp-cvm',
    vendor: 'gcp',
    root_family: 'gcp-cvm-root',
    measurement_prefix: 'mrtd:sha384:',
    chain_name: 'GCP CVM collateral chain',
    min_chain_len: 1,
  }),
  'azure-cvm': Object.freeze({
    target: 'azure-cvm',
    vendor: 'azure',
    root_family: 'azure-maa-root',
    measurement_prefix: 'mrtd:sha384:',
    chain_name: 'Azure MAA/cVM collateral chain',
    min_chain_len: 1,
  }),
});

export function listBuiltinAttestationVerifierSpecs() {
  return Object.values(TARGET_SPECS).map((spec) => ({ ...spec }));
}

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function materialBytes(material) {
  if (Buffer.isBuffer(material)) return material;
  if (material instanceof Uint8Array) return Buffer.from(material);
  if (typeof material === 'string') return Buffer.from(material.replace(/\r\n/g, '\n'), 'utf8');
  if (material && typeof material === 'object') return Buffer.from(JSON.stringify(material, Object.keys(material).sort()), 'utf8');
  return Buffer.from(String(material || ''), 'utf8');
}

export function fingerprintChainMaterial(material) {
  return `sha256:${sha256Hex(materialBytes(material))}`;
}

function normalizeFingerprint(value) {
  const raw = String(value || '').trim().toLowerCase();
  const m = /^(?:sha256:)?([0-9a-f]{64})$/.exec(raw);
  return m ? `sha256:${m[1]}` : null;
}

function normalizeRoots(expected, target, rootFamily) {
  const roots = [];
  const add = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) add(item);
      return;
    }
    if (value && typeof value === 'object') {
      add(value[target]);
      add(value[rootFamily]);
      add(value.fingerprints);
      add(value.sha256);
      add(value.fingerprint);
      return;
    }
    const fp = normalizeFingerprint(value);
    if (fp) roots.push(fp);
  };
  add(expected?.trust_roots);
  add(expected?.trust_root_fingerprints);
  add(expected?.root_fingerprints);
  add(expected?.vendor_roots);
  add(expected?.[`${target}_root_fingerprint`]);
  add(expected?.[`${target.replace(/-/g, '_')}_root_fingerprint`]);
  return Array.from(new Set(roots));
}

function chainFrom(parsed, expected) {
  const candidates = [
    parsed?.signing_cert_chain,
    parsed?.claims?.signing_cert_chain,
    parsed?.claims?.cert_chain,
    parsed?.claims?.cabundle,
    expected?.signing_cert_chain,
    expected?.cert_chain,
    expected?.vendor_chain,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length) return candidate.filter((v) => v != null);
  }
  return [];
}

function chainFingerprints(chain) {
  return chain.map((material) => fingerprintChainMaterial(material));
}

function hasNonZeroHex(value) {
  const hex = String(value || '').toLowerCase();
  return /^[0-9a-f]+$/.test(hex) && /[1-9a-f]/.test(hex);
}

function quoteSignaturePresent(parsed) {
  const n = Number(parsed?.claims?.quote_signature_data_len || 0);
  return Number.isFinite(n) && n > 0;
}

export function buildBuiltinAttestationVerifier(target, opts = {}) {
  const spec = TARGET_SPECS[target];
  if (!spec) throw new Error(`unsupported built-in attestation verifier target: ${target}`);
  const defaultExpected = opts.expected && typeof opts.expected === 'object' ? opts.expected : {};
  return function builtinVendorChainVerifier(parsed, ctx = {}) {
    const expected = { ...defaultExpected, ...(ctx.expected || {}) };
    const reasons = [];
    if (!parsed || parsed.ok !== true) reasons.push('parsed_attestation_not_ok');
    if (parsed?.target && parsed.target !== target) reasons.push(`target_mismatch:${parsed.target}`);
    if (parsed?.vendor !== spec.vendor) reasons.push(`vendor_mismatch:${parsed?.vendor || 'missing'}:${spec.vendor}`);
    if (!String(parsed?.measurement || '').startsWith(spec.measurement_prefix)) {
      reasons.push(`measurement_prefix_mismatch:${spec.measurement_prefix}`);
    }
    const chain = chainFrom(parsed, expected);
    if (chain.length < spec.min_chain_len) {
      reasons.push(`missing_${spec.chain_name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}`);
    }
    if (spec.require_raw_signature && !hasNonZeroHex(parsed?.raw_signature || parsed?.claims?.raw_signature)) {
      reasons.push('missing_nonzero_report_signature');
    }
    if (spec.require_quote_signature_data && !quoteSignaturePresent(parsed)) {
      reasons.push('missing_quote_signature_data');
    }
    const allowedRoots = normalizeRoots(expected, target, spec.root_family);
    if (allowedRoots.length === 0) reasons.push(`no_pinned_trust_root:${spec.root_family}`);
    const fingerprints = chainFingerprints(chain);
    const rootFingerprint = fingerprints.length ? fingerprints[fingerprints.length - 1] : null;
    if (rootFingerprint && allowedRoots.length && !allowedRoots.includes(rootFingerprint)) {
      reasons.push(`trust_root_not_pinned:${rootFingerprint}`);
    }

    if (reasons.length) {
      return {
        ok: false,
        reason: reasons.join(';'),
        verifier: `kolm-builtin-${target}-chain`,
        trust_root: rootFingerprint,
        trust_root_family: spec.root_family,
        plugin_version: BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
      };
    }
    return {
      ok: true,
      verifier: `kolm-builtin-${target}-chain`,
      trust_root: rootFingerprint,
      trust_root_family: spec.root_family,
      trust_root_pinned: true,
      plugin_version: BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
      chain_fingerprints: fingerprints,
      chain_length: chain.length,
    };
  };
}

export function registerBuiltinAttestationVerifiers(register, opts = {}) {
  if (typeof register !== 'function') {
    throw new Error('registerBuiltinAttestationVerifiers requires registerAttestationVerifier');
  }
  const targets = Array.isArray(opts.targets) && opts.targets.length ? opts.targets : Object.keys(TARGET_SPECS);
  const registered = [];
  for (const target of targets) {
    register(target, buildBuiltinAttestationVerifier(target, opts));
    registered.push(target);
  }
  return Object.freeze({
    version: BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
    registered: Object.freeze(registered.slice()),
  });
}

export default {
  BUILTIN_VENDOR_CHAIN_VERIFIER_VERSION,
  listBuiltinAttestationVerifierSpecs,
  fingerprintChainMaterial,
  buildBuiltinAttestationVerifier,
  registerBuiltinAttestationVerifiers,
};
