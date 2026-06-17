// Intel TDX quote parser.
//
// Format: variable-length quote (typical ~5-6KB) with:
//
//   header (48 bytes)
//   TD10 report body (584 bytes), containing:
//     - tee_tcb_svn (16)
//     - mr_seam (48)
//     - mr_signer_seam (48)
//     - seam_attributes (8)
//     - td_attributes (8)
//     - xfam (8)
//     - mr_td (48)             workload measurement (TD initial state)
//     - mr_config_id (48)
//     - mr_owner (48)
//     - mr_owner_config (48)
//     - rt_mr0..3 (48 each)    runtime measurements
//     - report_data (64)
//   quote signature data (variable), containing QE/PCK evidence.
//
// Full quote-signature verification requires Intel PCS collateral and is kept
// out of this parser. This module is a bounded, deterministic shape parser that
// extracts the measurement Kolm pins before a verifier plugin upgrades the
// evidence tier to cryptographically verified.

import { Buffer } from 'node:buffer';

export const TDX_HEADER_LEN = 48;
export const TDX_BODY_LEN = 584;
export const TDX_MIN_QUOTE_LEN = TDX_HEADER_LEN + TDX_BODY_LEN;

const DEFAULT_MAX_QUOTE_BYTES = 1024 * 1024;

const BODY = Object.freeze({
  tee_tcb_svn: [0, 16],
  mr_seam: [16, 48],
  mr_signer_seam: [64, 48],
  seam_attributes: [112, 8],
  td_attributes: [120, 8],
  xfam: [128, 8],
  mr_td: [136, 48],
  mr_config_id: [184, 48],
  mr_owner: [232, 48],
  mr_owner_config: [280, 48],
  rt_mr0: [328, 48],
  rt_mr1: [376, 48],
  rt_mr2: [424, 48],
  rt_mr3: [472, 48],
  report_data: [520, 64],
});

export function parseTdxAttestation(payload) {
  const buf = toBuffer(payload);
  if (buf.length < TDX_MIN_QUOTE_LEN) {
    throw new Error(`tdx quote too short: ${buf.length} < ${TDX_MIN_QUOTE_LEN}`);
  }

  const version = buf.readUInt16LE(0);
  if (version < 4 || version > 5) {
    throw new Error(`unsupported tdx quote version: ${version}`);
  }

  const attestation_key_type = buf.readUInt16LE(2);
  const tee_type = buf.readUInt32LE(4);
  const qe_svn = buf.readUInt16LE(8);
  const pce_svn = buf.readUInt16LE(10);
  const qe_vendor_id = buf.subarray(12, 28).toString('hex');
  const user_data = buf.subarray(28, TDX_HEADER_LEN).toString('hex');

  const mr_td = bodyHex(buf, 'mr_td');
  if (/^0+$/.test(mr_td)) {
    throw new Error('tdx quote missing non-zero MR_TD measurement');
  }

  const rt_mrs = [0, 1, 2, 3].map((i) => bodyHex(buf, `rt_mr${i}`));

  return {
    vendor: 'intel',
    measurement: `mrtd:sha384:${mr_td}`,
    claims: {
      version,
      attestation_key_type,
      tee_type,
      qe_svn,
      pce_svn,
      qe_vendor_id,
      user_data,
      tee_tcb_svn: bodyHex(buf, 'tee_tcb_svn'),
      mr_seam: bodyHex(buf, 'mr_seam'),
      mr_signer_seam: bodyHex(buf, 'mr_signer_seam'),
      seam_attributes: bodyHex(buf, 'seam_attributes'),
      td_attributes: bodyHex(buf, 'td_attributes'),
      xfam: bodyHex(buf, 'xfam'),
      mr_config_id: bodyHex(buf, 'mr_config_id'),
      mr_owner: bodyHex(buf, 'mr_owner'),
      mr_owner_config: bodyHex(buf, 'mr_owner_config'),
      rt_mrs,
      report_data: bodyHex(buf, 'report_data'),
      quote_size: buf.length,
      quote_signature_data_len: Math.max(0, buf.length - TDX_MIN_QUOTE_LEN),
      signed_at: null,
      evidence_tier: 'shape_only',
      verification_note: 'Intel PCS quote-signature verification is not performed by the parser',
    },
    signing_cert_chain: null,
  };
}

function bodyHex(buf, field) {
  const [offset, len] = BODY[field];
  const abs = TDX_HEADER_LEN + offset;
  return buf.subarray(abs, abs + len).toString('hex');
}

function maxQuoteBytes() {
  const n = Number(process.env.KOLM_ATTESTATION_MAX_TDX_QUOTE_BYTES || DEFAULT_MAX_QUOTE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_QUOTE_BYTES;
}

function assertSize(buf) {
  const max = maxQuoteBytes();
  if (buf.length > max) {
    throw new Error(`tdx quote too large: ${buf.length} > ${max}`);
  }
  return buf;
}

function toBuffer(payload) {
  if (Buffer.isBuffer(payload)) return assertSize(payload);
  if (payload instanceof Uint8Array) return assertSize(Buffer.from(payload));
  if (typeof payload === 'string') return decodeString(payload);
  if (payload && typeof payload === 'object' && payload.quote) {
    return toBuffer(payload.quote);
  }
  throw new Error('unsupported tdx payload type');
}

function decodeString(value) {
  const raw = String(value || '').trim();
  const max = maxQuoteBytes();
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    if (raw.length / 2 > max) throw new Error(`tdx quote too large: ${raw.length / 2} > ${max}`);
    return assertSize(Buffer.from(raw, 'hex'));
  }
  if (!/^[A-Za-z0-9+/=_-]+$/.test(raw)) {
    throw new Error('tdx quote string must be hex, base64, or base64url');
  }
  const normalized = raw.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  const estimate = Math.floor((padded.length * 3) / 4);
  if (estimate > max + 2) throw new Error(`tdx quote too large: ${estimate} > ${max}`);
  return assertSize(Buffer.from(padded, 'base64'));
}
