// AMD SEV-SNP attestation report parser.
//
// Format: 1184-byte binary AttestationReport struct (per AMD SEV-SNP ABI
// spec, table 21 of the firmware ABI):
//
//   offset  size  field
//   ------  ----  -----
//   0       4     version
//   4       4     guest_svn
//   8       8     policy
//   16      16    family_id
//   32      16    image_id
//   48      4     vmpl
//   52      4     signature_algo
//   56      8     current_tcb
//   64      32    platform_info
//   96      4     author_key_en (bit 0)
//   100     4     reserved
//   104     64    report_data
//   168     48    measurement       ← workload hash
//   216     32    host_data
//   248     48    id_key_digest
//   296     48    author_key_digest
//   344     32    report_id
//   376     32    report_id_ma
//   408     8     reported_tcb
//   416     24    reserved
//   440     64    chip_id
//   504     8     committed_tcb
//   512     1     current_minor
//   513     1     current_build
//   514     1     current_major
//   515     1     reserved
//   ...
//
// We parse the binary blob directly. Signature verification against the
// VCEK (AMD-issued versioned chip endorsement key) is deferred — that
// requires fetching the VCEK from https://kdsintf.amd.com/ which is a
// network round-trip we don't make at parse time.

import { Buffer } from 'node:buffer';

const REPORT_LEN = 1184;
const OFFSET_VERSION = 0;
const OFFSET_GUEST_SVN = 4;
const OFFSET_POLICY = 8;
const OFFSET_REPORT_DATA = 104;
const OFFSET_MEASUREMENT = 168;
const OFFSET_HOST_DATA = 216;
const OFFSET_CHIP_ID = 440;
const OFFSET_SIGNATURE = 672;
const LEN_SIGNATURE = 512;

export function parseSevSnpAttestation(payload) {
  const buf = toBuffer(payload);
  if (buf.length < REPORT_LEN) {
    throw new Error(`sev-snp report too short: ${buf.length} < ${REPORT_LEN}`);
  }
  const version = buf.readUInt32LE(OFFSET_VERSION);
  const guest_svn = buf.readUInt32LE(OFFSET_GUEST_SVN);
  const policy = buf.readBigUInt64LE(OFFSET_POLICY);
  const measurement = buf.subarray(OFFSET_MEASUREMENT, OFFSET_MEASUREMENT + 48).toString('hex');
  const report_data = buf.subarray(OFFSET_REPORT_DATA, OFFSET_REPORT_DATA + 64).toString('hex');
  const host_data = buf.subarray(OFFSET_HOST_DATA, OFFSET_HOST_DATA + 32).toString('hex');
  const chip_id = buf.subarray(OFFSET_CHIP_ID, OFFSET_CHIP_ID + 64).toString('hex');
  const signature = buf.subarray(OFFSET_SIGNATURE, OFFSET_SIGNATURE + LEN_SIGNATURE).toString('hex');

  return {
    vendor: 'amd',
    measurement: `mrtd:sha384:${measurement}`,
    claims: {
      version,
      guest_svn,
      policy: policy.toString(),
      report_data,
      host_data,
      chip_id,
      signed_at: null,  // SEV-SNP doesn't embed a timestamp; caller's RX time is the upper bound
    },
    signing_cert_chain: null,  // VCEK fetched out-of-band from AMD KDS
    raw_signature: signature,
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
  if (payload && typeof payload === 'object' && payload.report) {
    return toBuffer(payload.report);
  }
  throw new Error('unsupported sev-snp payload type');
}
