// Intel TDX quote parser.
//
// Format: variable-length quote (typical ~5-6KB) with:
//
//   header (48 bytes)
//   body (584 bytes) — TDX-specific report body containing:
//     - tcb_svn (16)
//     - mr_seam (48)  — SEAM module measurement
//     - mr_signer_seam (48)
//     - seam_attributes (8)
//     - td_attributes (8)
//     - xfam (8)
//     - mr_td (48)        ← workload measurement (TD initial state)
//     - mr_config_id (48)
//     - mr_owner (48)
//     - mr_owner_config (48)
//     - rt_mr0..3 (48 each) — runtime measurements
//     - report_data (64)
//   signature (variable) with quote_signature_data containing the QE cert
//   chain and the PCK cert chain.
//
// Like the SEV-SNP parser, full signature verification requires fetching
// the Intel PCS chain (https://api.trustedservices.intel.com/sgx/certification/v3/)
// which is a deferred concern.

import { Buffer } from 'node:buffer';

const HEADER_LEN = 48;
const BODY_LEN = 584;
const OFFSET_MR_SEAM = HEADER_LEN + 16;          // 64
const OFFSET_MR_TD = HEADER_LEN + 184;            // 232
const OFFSET_RT_MR0 = HEADER_LEN + 376;           // 424

export function parseTdxAttestation(payload) {
  const buf = toBuffer(payload);
  if (buf.length < HEADER_LEN + BODY_LEN) {
    throw new Error(`tdx quote too short: ${buf.length} < ${HEADER_LEN + BODY_LEN}`);
  }
  const version = buf.readUInt16LE(0);
  const attestation_key_type = buf.readUInt16LE(2);
  const mr_seam = buf.subarray(OFFSET_MR_SEAM, OFFSET_MR_SEAM + 48).toString('hex');
  const mr_td = buf.subarray(OFFSET_MR_TD, OFFSET_MR_TD + 48).toString('hex');
  const rt_mrs = [];
  for (let i = 0; i < 4; i++) {
    const off = OFFSET_RT_MR0 + i * 48;
    rt_mrs.push(buf.subarray(off, off + 48).toString('hex'));
  }
  return {
    vendor: 'intel',
    measurement: `mrtd:sha384:${mr_td}`,
    claims: {
      version,
      attestation_key_type,
      mr_seam,
      rt_mrs,
      signed_at: null,
    },
    signing_cert_chain: null,
  };
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') {
    if (/^[0-9a-fA-F]+$/.test(payload) && payload.length % 2 === 0) {
      return Buffer.from(payload, 'hex');
    }
    return Buffer.from(payload, 'base64');
  }
  if (payload && typeof payload === 'object' && payload.quote) {
    return toBuffer(payload.quote);
  }
  throw new Error('unsupported tdx payload type');
}
