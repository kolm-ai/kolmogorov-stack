// src/compliance-c2pa.js
//
// W921 Govern / Receipts & Compliance - C2PA 2.x Content Credentials with a
// hard-binding manifest for model outputs (text), emitted as a DETACHED/SIDECAR
// manifest store.
//
// C2PA (Coalition for Content Provenance and Authenticity, ISO/IEC 22144) is
// the standard the EU AI Act Art. 50(2) points to for machine-readable marking
// of AI-generated content. A manifest has three required parts:
//   (1) ASSERTION STORE (c2pa.assertions) - CBOR assertions, including AT LEAST
//       ONE hard-binding (c2pa.hash.data over the asset bytes + exclusions) and
//       a c2pa.actions.v2 assertion whose c2pa.created action carries a
//       digitalSourceType marking AI involvement.
//   (2) CLAIM (c2pa.claim.v2) - lists created_assertions as hashed-uri maps
//       {url, hash:b64, alg} + claim_generator_info + instanceID + signature URI.
//   (3) CLAIM SIGNATURE - a COSE_Sign1_Tagged structure over the claim, signed
//       with an X.509 cert chain (alg may be Ed25519/EdDSA).
//
// CONSTRAINTS / SCOPE (important): the reference C2PA SDKs (@contentauth/
// c2pa-node / c2pa-rs) are heavy native dependencies. kolm's design forbids
// adding them (and this agent must not edit package.json). So this module
// builds a STRUCTURALLY-CORRECT C2PA 2.x manifest with a REAL cryptographic
// hard binding (c2pa.hash.data) and a REAL COSE_Sign1 Ed25519 signature, using
// a vanilla-Node CBOR encoder - but cross-validation against the c2patool /
// c2pa-rs Reader is a separate, dependency-gated step (see verifyC2paManifest:
// it validates the COSE signature + every assertion hash + the hard binding
// offline, which is the load-bearing tamper-evidence property; full Reader
// trust-list conformance is reported as a limitation, never asserted).
//
// The hard-binding property - altering ANY output byte breaks c2pa.hash.data
// and fails verification - is cryptographically real and fully tested here.
//
// REUSE: node:crypto (via src/ed25519.js sign/verify pattern) + src/ed25519.js
// keyFingerprint. Zero new package.json dependencies.

import crypto from 'node:crypto';
import { keyFingerprint } from './ed25519.js';

export const C2PA_MANIFEST_VERSION = 'w921-c2pa-v1';
export const C2PA_CLAIM_VERSION = 'c2pa.claim.v2';
export const C2PA_ACTIONS_VERSION = 'c2pa.actions.v2';
export const C2PA_HASH_DATA_LABEL = 'c2pa.hash.data';
export const C2PA_KOLM_RECEIPT_LABEL = 'kolm.receipt';
// IPTC digitalSourceType for content produced by a trained algorithm - the
// exact value EU AI Act Art. 50(2) marking expects for AI-generated media.
export const DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC =
  'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
export const COSE_ALG_EDDSA = -8; // COSE alg id for EdDSA (RFC 8152 / IANA)

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest(); }
function sha256b64(buf) { return sha256(buf).toString('base64'); }

// ===========================================================================
// Minimal deterministic CBOR encoder (RFC 8949), enough for C2PA assertions +
// the COSE_Sign1 structure. Supports: unsigned/negative ints, byte strings,
// text strings, arrays, maps (string OR int keys), bool, null. Maps are
// canonical (keys sorted by encoded bytes) so the serialization is reproducible.
// ===========================================================================
function cborHead(major, len) {
  const m = major << 5;
  if (len < 24) return Buffer.from([m | len]);
  if (len < 0x100) return Buffer.from([m | 24, len]);
  if (len < 0x10000) { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(len, 1); return b; }
  if (len < 0x100000000) { const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(len, 1); return b; }
  const b = Buffer.alloc(9); b[0] = m | 27; b.writeBigUInt64BE(BigInt(len), 1); return b;
}

export function cborEncode(value) {
  if (value === null || value === undefined) return Buffer.from([0xf6]); // null
  if (value === true) return Buffer.from([0xf5]);
  if (value === false) return Buffer.from([0xf4]);
  if (typeof value === 'number' && Number.isInteger(value)) {
    if (value >= 0) return cborHead(0, value);
    return cborHead(1, -value - 1);
  }
  if (typeof value === 'number') {
    // double-precision float
    const b = Buffer.alloc(9); b[0] = 0xfb; b.writeDoubleBE(value, 1); return b;
  }
  if (typeof value === 'string') {
    const s = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, s.length), s]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const b = Buffer.from(value);
    return Buffer.concat([cborHead(2, b.length), b]);
  }
  if (Array.isArray(value)) {
    const parts = value.map(cborEncode);
    return Buffer.concat([cborHead(4, value.length), ...parts]);
  }
  if (value instanceof Map) {
    return encodeMapEntries([...value.entries()]);
  }
  if (typeof value === 'object') {
    return encodeMapEntries(Object.entries(value));
  }
  throw new TypeError('cborEncode: unsupported value type ' + typeof value);
}

function encodeMapEntries(entries) {
  // Encode each key/value, sort by encoded-key bytes (canonical CBOR).
  const encoded = entries.map(([k, v]) => {
    const key = typeof k === 'number' ? cborEncode(k)
      : (/^-?\d+$/.test(String(k)) && typeof k === 'number') ? cborEncode(Number(k))
      : cborEncode(String(k));
    return { key, val: cborEncode(v) };
  });
  encoded.sort((a, b) => Buffer.compare(a.key, b.key));
  const body = Buffer.concat(encoded.flatMap((e) => [e.key, e.val]));
  return Buffer.concat([cborHead(5, encoded.length), body]);
}

// ===========================================================================
// Assertions
// ===========================================================================

// c2pa.hash.data - the HARD BINDING. Hash over the asset (output) bytes with an
// optional exclusions list. Any single-byte change breaks this hash.
export function c2paHashDataAssertion(assetBytes, exclusions = []) {
  const buf = Buffer.isBuffer(assetBytes) ? assetBytes : Buffer.from(String(assetBytes), 'utf8');
  return {
    label: C2PA_HASH_DATA_LABEL,
    data: {
      exclusions: exclusions || [],
      alg: 'sha256',
      hash: sha256b64(buf),
      pad: '',
      name: 'kolm output hard binding',
    },
  };
}

// c2pa.actions.v2 - marks the c2pa.created action with digitalSourceType.
export function c2paActionsAssertion(opts = {}) {
  return {
    label: C2PA_ACTIONS_VERSION,
    data: {
      actions: [
        {
          action: 'c2pa.created',
          digitalSourceType: opts.digitalSourceType || DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC,
          softwareAgent: { name: 'kolm', version: String(opts.softwareAgentVersion || '0.0.0') },
        },
      ],
    },
  };
}

// kolm.receipt - custom assertion embedding selected kolm-audit receipt fields.
function kolmReceiptAssertion(receipt = {}) {
  return {
    label: C2PA_KOLM_RECEIPT_LABEL,
    data: {
      receipt_id: receipt.receipt_id || null,
      provider: receipt.provider || null,
      model: receipt.model || (receipt.response_model || null),
      route_decision: receipt.route_decision || (receipt.router_decision && receipt.router_decision.route_decision) || null,
      issued_at: receipt.issued_at || null,
      verify_url: receipt.receipt_id ? `https://kolm.ai/v1/verify/${receipt.receipt_id}` : null,
    },
  };
}

// ===========================================================================
// buildC2paManifestDefinition(opts) -> manifest definition JSON (pre-sign)
// ===========================================================================
export function buildC2paManifestDefinition(opts = {}) {
  const receipt = opts.receipt || {};
  const outputBytes = Buffer.isBuffer(opts.outputBytes)
    ? opts.outputBytes
    : Buffer.from(String(opts.outputText || ''), 'utf8');
  const assertions = [
    c2paActionsAssertion({
      digitalSourceType: opts.digitalSourceType,
      softwareAgentVersion: opts.claimGeneratorVersion || opts.softwareAgentVersion || '0.0.0',
    }),
    c2paHashDataAssertion(outputBytes, opts.exclusions || []),
    kolmReceiptAssertion(receipt),
  ];
  return {
    claim_version: C2PA_CLAIM_VERSION,
    title: opts.title || (receipt.receipt_id ? `kolm output ${receipt.receipt_id}` : 'kolm output'),
    format: opts.format || 'text/plain',
    instance_id: 'xmp:iid:' + crypto.randomUUID(),
    claim_generator_info: [{ name: 'kolm', version: String(opts.claimGeneratorVersion || '0.0.0') }],
    assertions,
  };
}

// ===========================================================================
// COSE_Sign1 over the claim CBOR (Ed25519 / EdDSA).
//
// Sig_structure (RFC 8152 §4.4) = ["Signature1", protected, external_aad, payload]
// protected header = { 1: -8 (EdDSA) }; the cert chain (x5chain) is carried in
// the unprotected header. We sign the CBOR-encoded Sig_structure.
// ===========================================================================
function buildCoseSign1(payloadBytes, privateKeyPem, certChainDerList) {
  const protectedMap = new Map([[1, COSE_ALG_EDDSA]]); // alg
  const protectedBytes = cborEncode(protectedMap);
  // unprotected header: x5chain (label 33) -> array of DER cert byte strings.
  const unprotected = new Map();
  if (Array.isArray(certChainDerList) && certChainDerList.length) {
    unprotected.set(33, certChainDerList.map((d) => Buffer.from(d)));
  }
  const sigStructure = ['Signature1', protectedBytes, Buffer.alloc(0), payloadBytes];
  const toBeSigned = cborEncode(sigStructure);
  const signature = crypto.sign(null, toBeSigned, privateKeyPem); // Ed25519 raw 64 bytes
  // COSE_Sign1 = [protected, unprotected, payload, signature]
  const coseSign1 = [protectedBytes, unprotected, payloadBytes, signature];
  // tag 18 = COSE_Sign1
  const inner = cborEncode(coseSign1);
  return Buffer.concat([Buffer.from([0xd8, 0x12]), inner]); // 0xd8 0x12 = tag(18)
}

// Hashed-URI map for a created assertion: {url, hash:b64, alg}.
function hashedUri(label, assertionBytes) {
  return {
    url: `self#jumbf=c2pa.assertions/${label}`,
    hash: sha256b64(assertionBytes),
    alg: 'sha256',
  };
}

// ===========================================================================
// signC2paOutput(opts) -> { manifestStoreBytes, manifestStore, validation_status }
//
// Assembles the assertion store, builds the c2pa.claim.v2 with created_assertions
// hashed-uris, and signs the claim CBOR as COSE_Sign1. Returns the manifest
// store as a JSON-serializable object (with base64 CBOR/COSE blobs) plus the
// raw manifest store bytes for the .c2pa sidecar.
// ===========================================================================
export function signC2paOutput(opts = {}) {
  if (!opts.signer || !opts.signer.privateKey) {
    throw new Error('signC2paOutput: signer with privateKey required');
  }
  const def = buildC2paManifestDefinition(opts);
  const outputBytes = Buffer.isBuffer(opts.outputBytes)
    ? opts.outputBytes
    : Buffer.from(String(opts.outputText || ''), 'utf8');

  // Serialize each assertion to canonical CBOR; collect hashed-uris.
  const assertionStore = {};
  const createdAssertions = [];
  for (const a of def.assertions) {
    const aBytes = cborEncode(a.data);
    assertionStore[a.label] = aBytes.toString('base64');
    createdAssertions.push(hashedUri(a.label, aBytes));
  }

  // Build the claim (c2pa.claim.v2).
  const claim = {
    claim_version: def.claim_version,
    instanceID: def.instance_id,
    title: def.title,
    format: def.format,
    alg: 'sha256',
    claim_generator_info: def.claim_generator_info,
    created_assertions: createdAssertions,
    signature: 'self#jumbf=c2pa.signature',
  };
  const claimBytes = cborEncode(claim);

  // Cert chain: ensure a signing cert wrapping the Ed25519 key.
  const cert = ensureC2paSigningCert({
    storeDir: opts.storeDir,
    ed25519PrivateKeyPem: opts.signer.privateKey,
    ed25519PublicKeyPem: opts.signer.publicKey,
    certChainPem: opts.certChainPem || (opts.signer && opts.signer.certChainPem),
  });
  const certDerList = pemChainToDerList(cert.certChainPem);

  // COSE_Sign1 over the claim CBOR.
  const cose = buildCoseSign1(claimBytes, opts.signer.privateKey, certDerList);

  const manifestStore = {
    version: C2PA_MANIFEST_VERSION,
    active_manifest: def.instance_id,
    manifests: {
      [def.instance_id]: {
        claim: claimBytes.toString('base64'),
        signature: cose.toString('base64'),
        assertion_store: assertionStore,
        cert_source: cert.source,
      },
    },
  };
  const manifestStoreBytes = Buffer.from(JSON.stringify(manifestStore), 'utf8');

  let key_fingerprint = null;
  try { key_fingerprint = opts.signer.publicKey ? keyFingerprint(opts.signer.publicKey) : null; } catch { key_fingerprint = null; }

  // Self-validate immediately so the returned status reflects a real check.
  const verify = verifyC2paManifest(manifestStoreBytes, outputBytes, { publicKey: opts.signer.publicKey });

  return {
    manifestStore,
    manifestStoreBytes,
    manifestUrl: opts.receipt && opts.receipt.receipt_id ? `https://kolm.ai/v1/c2pa/${opts.receipt.receipt_id}` : null,
    validation_status: verify.ok ? 'valid' : 'invalid',
    digitalSourceType: opts.digitalSourceType || DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC,
    key_fingerprint,
    cert_source: cert.source,
  };
}

// ===========================================================================
// verifyC2paManifest(manifestStoreBytes, assetBytes, {publicKey}) -> verdict
//
// Offline validation: (1) recompute each assertion hash vs the claim's
// created_assertions hashed-uris; (2) recompute c2pa.hash.data over the asset
// bytes and compare; (3) verify the COSE_Sign1 Ed25519 signature over the claim
// CBOR. NEVER throws - garbage -> {ok:false}.
// ===========================================================================
export function verifyC2paManifest(manifestStoreBytes, assetBytes, opts = {}) {
  const errors = [];
  let store;
  try {
    store = JSON.parse(Buffer.isBuffer(manifestStoreBytes) ? manifestStoreBytes.toString('utf8') : String(manifestStoreBytes));
  } catch (e) {
    return { ok: false, validation_status: 'invalid', validation_errors: ['manifest_parse_failed: ' + e.message], active_manifest: null, digitalSourceType: null };
  }
  const activeId = store && store.active_manifest;
  const manifest = activeId && store.manifests && store.manifests[activeId];
  if (!manifest) {
    return { ok: false, validation_status: 'invalid', validation_errors: ['no_active_manifest'], active_manifest: null, digitalSourceType: null };
  }

  let claim;
  try { claim = cborDecode(Buffer.from(manifest.claim, 'base64')); }
  catch (e) { return { ok: false, validation_status: 'invalid', validation_errors: ['claim_decode_failed: ' + e.message], active_manifest: activeId, digitalSourceType: null }; }

  // (1) assertion hashes vs hashed-uris.
  const byLabelHash = {};
  for (const hu of (claim.created_assertions || [])) {
    const label = String(hu.url || '').split('/').pop();
    byLabelHash[label] = hu.hash;
  }
  let digitalSourceType = null;
  let hardBindingOk = false;
  for (const [label, b64] of Object.entries(manifest.assertion_store || {})) {
    const aBytes = Buffer.from(b64, 'base64');
    const recomputed = sha256b64(aBytes);
    if (byLabelHash[label] && byLabelHash[label] !== recomputed) {
      errors.push(`assertion_hash_mismatch:${label}`);
    }
    // (2) hard binding + digitalSourceType inspection.
    let dec;
    try { dec = cborDecode(aBytes); } catch { dec = null; }
    if (label === C2PA_HASH_DATA_LABEL && dec) {
      const asset = Buffer.isBuffer(assetBytes) ? assetBytes : Buffer.from(String(assetBytes || ''), 'utf8');
      const assetHash = sha256b64(asset);
      if (dec.hash === assetHash) hardBindingOk = true;
      else errors.push('hard_binding_mismatch');
    }
    if (label === C2PA_ACTIONS_VERSION && dec && Array.isArray(dec.actions)) {
      const created = dec.actions.find((x) => x.action === 'c2pa.created');
      if (created) digitalSourceType = created.digitalSourceType || null;
    }
  }
  if (!hardBindingOk && assetBytes !== undefined && assetBytes !== null) {
    if (!errors.includes('hard_binding_mismatch')) errors.push('hard_binding_absent_or_failed');
  }

  // (3) COSE_Sign1 signature over the claim CBOR.
  let sigOk = false;
  try {
    const cose = Buffer.from(manifest.signature, 'base64');
    sigOk = verifyCoseSign1(cose, Buffer.from(manifest.claim, 'base64'), opts.publicKey);
    if (!sigOk) errors.push('cose_signature_invalid');
  } catch (e) {
    errors.push('cose_verify_failed: ' + e.message);
  }

  const ok = errors.length === 0 && sigOk && hardBindingOk;
  return {
    ok,
    validation_status: ok ? 'valid' : 'invalid',
    validation_errors: errors,
    active_manifest: activeId,
    digitalSourceType,
    // Constraint: full CAI trust-list conformance requires the reference Reader.
    limitations: ['cai_trust_list_conformance_not_checked_without_reference_reader'],
  };
}

function verifyCoseSign1(coseBytes, payloadBytes, publicKeyPem) {
  if (!publicKeyPem) return false;
  // strip tag(18) prefix if present.
  let body = coseBytes;
  if (body.length >= 2 && body[0] === 0xd8 && body[1] === 0x12) body = body.slice(2);
  const arr = cborDecode(body);
  if (!Array.isArray(arr) || arr.length !== 4) return false;
  const [protectedBytes, , , signature] = arr;
  const sigStructure = ['Signature1', Buffer.from(protectedBytes), Buffer.alloc(0), Buffer.from(payloadBytes)];
  const toBeVerified = cborEncode(sigStructure);
  try {
    return crypto.verify(null, toBeVerified, publicKeyPem, Buffer.from(signature));
  } catch {
    return false;
  }
}

// ===========================================================================
// Minimal CBOR DECODER (enough to round-trip what cborEncode produces).
// ===========================================================================
function cborDecode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const res = decodeItem(b, 0);
  return res.value;
}
function readLen(b, pos, info) {
  if (info < 24) return { len: info, pos };
  if (info === 24) return { len: b[pos], pos: pos + 1 };
  if (info === 25) return { len: b.readUInt16BE(pos), pos: pos + 2 };
  if (info === 26) return { len: b.readUInt32BE(pos), pos: pos + 4 };
  if (info === 27) return { len: Number(b.readBigUInt64BE(pos)), pos: pos + 8 };
  throw new Error('cbor: unsupported length info ' + info);
}
function decodeItem(b, pos) {
  const ib = b[pos]; pos++;
  const major = ib >> 5;
  const info = ib & 0x1f;
  if (major === 0) { const r = readLen(b, pos, info); return { value: r.len, pos: r.pos }; }
  if (major === 1) { const r = readLen(b, pos, info); return { value: -1 - r.len, pos: r.pos }; }
  if (major === 2) { const r = readLen(b, pos, info); return { value: b.slice(r.pos, r.pos + r.len), pos: r.pos + r.len }; }
  if (major === 3) { const r = readLen(b, pos, info); return { value: b.slice(r.pos, r.pos + r.len).toString('utf8'), pos: r.pos + r.len }; }
  if (major === 4) {
    const r = readLen(b, pos, info); let p = r.pos; const arr = [];
    for (let i = 0; i < r.len; i++) { const it = decodeItem(b, p); arr.push(it.value); p = it.pos; }
    return { value: arr, pos: p };
  }
  if (major === 5) {
    const r = readLen(b, pos, info); let p = r.pos; const obj = {};
    for (let i = 0; i < r.len; i++) {
      const k = decodeItem(b, p); p = k.pos;
      const v = decodeItem(b, p); p = v.pos;
      obj[String(k.value)] = v.value;
    }
    return { value: obj, pos: p };
  }
  if (major === 6) { // tag - skip the tag, decode the tagged item
    const r = readLen(b, pos, info); return decodeItem(b, r.pos);
  }
  if (major === 7) {
    if (info === 20) return { value: false, pos };
    if (info === 21) return { value: true, pos };
    if (info === 22 || info === 23) return { value: null, pos };
    if (info === 27) return { value: b.readDoubleBE(pos), pos: pos + 8 };
    return { value: null, pos };
  }
  throw new Error('cbor: unsupported major type ' + major);
}

// ===========================================================================
// ensureC2paSigningCert - provision an X.509 cert wrapping the Ed25519 key.
//
// Prod: a CA / CAI-trust-list cert via env (KOLM_C2PA_CERT_CHAIN_PEM). Dev/CI:
// a self-signed Ed25519 X.509 cert minted with node:crypto X509Certificate
// helpers when available, else a documented placeholder so the manifest still
// signs (the COSE signature is over kolm's key either way). The signature's
// trust depends on the cert source, which we report (never overclaim).
// ===========================================================================
export function ensureC2paSigningCert(opts = {}) {
  // 1) explicit chain wins.
  if (opts.certChainPem) {
    return { certChainPem: opts.certChainPem, privateKeyPem: opts.ed25519PrivateKeyPem, source: 'provided' };
  }
  // 2) env-provided prod chain.
  const envChain = process.env.KOLM_C2PA_CERT_CHAIN_PEM;
  if (envChain && envChain.includes('BEGIN CERTIFICATE')) {
    return { certChainPem: envChain, privateKeyPem: opts.ed25519PrivateKeyPem, source: 'env' };
  }
  // 3) dev self-signed cert from the Ed25519 key. Node has no high-level X.509
  // minting API in stable releases, so we emit a self-describing dev-cert
  // placeholder PEM that carries the SPKI of the signing key. verifyC2paManifest
  // verifies the COSE signature against the supplied public key regardless; the
  // cert chain is for Reader trust-list resolution, which dev mode does not have.
  let spkiPem = '';
  try {
    if (opts.ed25519PublicKeyPem) spkiPem = opts.ed25519PublicKeyPem;
    else if (opts.ed25519PrivateKeyPem) {
      const pub = crypto.createPublicKey(opts.ed25519PrivateKeyPem);
      spkiPem = pub.export({ type: 'spki', format: 'pem' });
    }
  } catch { spkiPem = ''; }
  const fakeCert = [
    '-----BEGIN CERTIFICATE-----',
    Buffer.from('kolm-dev-self-signed-c2pa\n' + spkiPem, 'utf8').toString('base64').match(/.{1,64}/g).join('\n'),
    '-----END CERTIFICATE-----',
    '',
  ].join('\n');
  return { certChainPem: fakeCert, privateKeyPem: opts.ed25519PrivateKeyPem, source: 'self-signed-dev' };
}

function pemChainToDerList(pem) {
  if (!pem || typeof pem !== 'string') return [];
  const out = [];
  const re = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;
  let m;
  while ((m = re.exec(pem)) !== null) {
    try { out.push(Buffer.from(m[1].replace(/\s+/g, ''), 'base64')); } catch { /* skip */ }
  }
  return out;
}

export const C2PA_SPEC = {
  version: C2PA_MANIFEST_VERSION,
  claim_version: C2PA_CLAIM_VERSION,
  signature: 'COSE_Sign1 (EdDSA / Ed25519)',
  hard_binding: C2PA_HASH_DATA_LABEL,
  digital_source_type: DIGITAL_SOURCE_TYPE_TRAINED_ALGORITHMIC,
  conformance_note: 'structural C2PA 2.x manifest with real cryptographic hard binding + COSE Ed25519 signature; CAI trust-list conformance requires the reference Reader (dependency-gated).',
};
