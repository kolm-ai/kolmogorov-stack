// AWS Nitro Enclaves attestation parser.
//
// Format: COSE_Sign1 CBOR document with payload:
//   {
//     module_id, timestamp, digest, pcrs (map<uint, bytes>),
//     certificate (DER), cabundle (DER chain), public_key, user_data, nonce
//   }
//
// PCR0 = sha384 of the enclave image (EIF). This is the measurement we
// store as the deployment's "what is running."
//
// Today: we parse the outer CBOR/JSON envelope to extract PCR0 + cert
// chain. We do NOT yet verify the COSE_Sign1 signature against the AWS root
// certificate at https://aws-nitro-enclaves.amazonaws.com/AWS_NitroEnclaves_Root-G1.pem.
// That requires shipping the root cert and CBOR/COSE deps; tracked for v0.2.
//
// Input shapes accepted:
//   - { module_id, pcrs: { '0': '<hex>' } }           — pre-parsed
//   - { document: '<base64 CBOR COSE_Sign1>' }        — raw from nitro-cli
//   - '<base64>'                                      — raw blob

import { Buffer } from 'node:buffer';

export function parseNitroAttestation(payload) {
  const obj = normalize(payload);
  const pcr0 = extractPcr(obj, 0);
  if (!pcr0) {
    throw new Error('nitro attestation missing PCR0 (sha384 of enclave image)');
  }
  const claims = {
    module_id: obj.module_id || null,
    signed_at: obj.timestamp ? new Date(Number(obj.timestamp)).toISOString() : null,
    digest: obj.digest || 'SHA384',
    pcrs: extractAllPcrs(obj),
    user_data: obj.user_data || null,
    nonce: obj.nonce || null,
  };
  return {
    vendor: 'aws',
    measurement: `pcr0:sha384:${pcr0.toLowerCase()}`,
    claims,
    signing_cert_chain: extractCertChain(obj),
  };
}

function normalize(payload) {
  if (payload && typeof payload === 'object' && !Buffer.isBuffer(payload)) {
    // Already-parsed envelope.
    return payload;
  }
  if (typeof payload === 'string') {
    // Try JSON first (some tooling wraps the CBOR in {document: base64}).
    try {
      return JSON.parse(payload);
    } catch {
      // Treat as raw base64 CBOR — return a stub envelope; real CBOR parse
      // is deferred to v0.2 (needs a CBOR dep).
      return { document: payload, _raw: true };
    }
  }
  if (Buffer.isBuffer(payload)) {
    return { document: payload.toString('base64'), _raw: true };
  }
  throw new Error('unsupported nitro payload type');
}

function extractPcr(obj, idx) {
  // Pre-parsed shape: { pcrs: { 0: <hex|Buffer> } }.
  const pcrs = obj.pcrs || obj.PCRs || null;
  if (pcrs) {
    const v = pcrs[idx] ?? pcrs[String(idx)];
    if (typeof v === 'string') return v.replace(/^0x/, '');
    if (Buffer.isBuffer(v)) return v.toString('hex');
  }
  return null;
}

function extractAllPcrs(obj) {
  const pcrs = obj.pcrs || obj.PCRs || null;
  if (!pcrs) return null;
  const out = {};
  for (const k of Object.keys(pcrs)) {
    const v = pcrs[k];
    if (typeof v === 'string') out[k] = v.replace(/^0x/, '').toLowerCase();
    else if (Buffer.isBuffer(v)) out[k] = v.toString('hex');
  }
  return out;
}

function extractCertChain(obj) {
  if (Array.isArray(obj.cabundle)) {
    return obj.cabundle.map(c => (typeof c === 'string' ? c : Buffer.from(c).toString('base64')));
  }
  if (obj.certificate) {
    return [typeof obj.certificate === 'string' ? obj.certificate : Buffer.from(obj.certificate).toString('base64')];
  }
  return null;
}
